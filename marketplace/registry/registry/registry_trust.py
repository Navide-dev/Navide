"""Registry-owned artifact signing and root-signed trust metadata."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

from .config import SIGNER_STATUSES, Settings, TrustedSignerConfig
from .signing import (
    load_or_create_private_key,
    public_key_fingerprint,
    public_key_from_private,
    sign_json,
)
from .versions import PRERELEASE_CHANNEL, STABLE_CHANNEL, TESTPLACE_CHANNEL


def _timestamp(value: datetime) -> str:
    return (
        value.astimezone(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _blocked_package(value: str) -> dict[str, str]:
    package_id, separator, version = value.partition("@")
    result = {"packageId": package_id}
    if separator:
        result["version"] = version
    return result


def _parse_timestamp(value: object, field: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError(f"registry trust state {field} must be a timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"registry trust state {field} is invalid") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"registry trust state {field} must include a timezone")
    return parsed.astimezone(timezone.utc)


def _load_state(path: Path) -> dict:
    def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(
                    f"registry trust state contains duplicate JSON key '{key}'"
                )
            result[key] = value
        return result

    try:
        value = json.loads(
            path.read_text(encoding="utf-8"), object_pairs_hook=unique_object
        )
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        raise ValueError("registry trust state cannot be read") from exc
    if not isinstance(value, dict) or set(value) != {
        "schemaVersion",
        "profile",
        "rootFingerprint",
        "signers",
    }:
        raise ValueError("registry trust state has an invalid shape")
    if value["schemaVersion"] != 1 or not isinstance(value["signers"], dict):
        raise ValueError("registry trust state has an unsupported schema")
    return value


def _write_state(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.chmod(0o600)
    temporary.replace(path)


def _resolve_lifecycle(
    *,
    settings: Settings,
    public_key: str,
    root_fingerprint: str,
    now: datetime,
) -> tuple[datetime, datetime]:
    state_path = settings.data_dir / "trust" / "registry-state.json"
    if state_path.exists():
        state = _load_state(state_path)
        if state["profile"] != settings.trust_profile:
            raise ValueError("registry trust profile does not match persisted state")
        if state["rootFingerprint"] != root_fingerprint:
            raise ValueError("registry root does not match persisted trust state")
    else:
        state = {
            "schemaVersion": 1,
            "profile": settings.trust_profile,
            "rootFingerprint": root_fingerprint,
            "signers": {},
        }

    signer_states = state["signers"]
    key_id = settings.registry_signer_key_id
    fingerprint = public_key_fingerprint(public_key)
    persisted = signer_states.get(key_id)
    if persisted is not None:
        lifecycle_fields = {
            "publicKeyFingerprint",
            "notBefore",
            "notAfter",
        }
        if not isinstance(persisted, dict) or frozenset(persisted) not in {
            frozenset(lifecycle_fields),
            frozenset({*lifecycle_fields, "status"}),
        }:
            raise ValueError("registry signer lifecycle state has an invalid shape")
        if persisted["publicKeyFingerprint"] != fingerprint:
            raise ValueError("registry signer keyId maps to different key material")
        not_before = _parse_timestamp(persisted["notBefore"], "signer.notBefore")
        not_after = _parse_timestamp(persisted["notAfter"], "signer.notAfter")
        if (
            settings.signer_not_before is not None
            and settings.signer_not_before != not_before
        ):
            raise ValueError("registry signer notBefore conflicts with persisted state")
        if (
            settings.signer_not_after is not None
            and settings.signer_not_after != not_after
        ):
            raise ValueError("registry signer notAfter conflicts with persisted state")
        if persisted.get("status") != settings.signer_status:
            persisted["status"] = settings.signer_status
            _write_state(state_path, state)
        return not_before, not_after

    not_before = settings.signer_not_before or (now - timedelta(minutes=1))
    not_after = settings.signer_not_after or (
        now + timedelta(days=settings.signer_validity_days)
    )
    not_before = not_before.astimezone(timezone.utc).replace(microsecond=0)
    not_after = not_after.astimezone(timezone.utc).replace(microsecond=0)
    if not_after <= not_before:
        raise ValueError("registry signer validity window is invalid")
    signer_states[key_id] = {
        "publicKeyFingerprint": fingerprint,
        "status": settings.signer_status,
        "notBefore": _timestamp(not_before),
        "notAfter": _timestamp(not_after),
    }
    _write_state(state_path, state)
    return not_before, not_after


@dataclass(frozen=True)
class RegistryTrustSigner:
    signer_private_key: str
    signer_public_key: str
    root_private_key: str
    root_fingerprint: str
    registry_profile: str
    key_id: str
    status: str
    not_before: datetime
    not_after: datetime
    metadata_ttl: timedelta
    trusted_signers: tuple[TrustedSignerConfig, ...]
    blocked_publishers: tuple[str, ...]
    blocked_packages: tuple[str, ...]
    extra_blocklist: Callable[[], tuple[tuple[str, ...], tuple[str, ...]]] | None = None
    """Admin-managed (publishers, packages) read at call time and merged with
    the config lists (blocklist.py); None = config lists only."""

    def _blocklists(self) -> tuple[tuple[str, ...], tuple[str, ...]]:
        if self.extra_blocklist is None:
            return self.blocked_publishers, self.blocked_packages
        publishers, packages = self.extra_blocklist()
        return (
            tuple(dict.fromkeys((*self.blocked_publishers, *publishers))),
            tuple(dict.fromkeys((*self.blocked_packages, *packages))),
        )

    @classmethod
    def from_settings(cls, settings: Settings) -> RegistryTrustSigner:
        now = datetime.now(timezone.utc)
        if settings.signer_status not in SIGNER_STATUSES:
            raise ValueError(
                f"unknown registry signer status '{settings.signer_status}'"
            )
        seen_key_ids = {settings.registry_signer_key_id}
        for signer in settings.trusted_signers:
            if signer.key_id in seen_key_ids:
                raise ValueError(f"duplicate registry signer keyId '{signer.key_id}'")
            seen_key_ids.add(signer.key_id)
            if signer.status not in SIGNER_STATUSES:
                raise ValueError(f"unknown registry signer status '{signer.status}'")
            if signer.not_after <= signer.not_before:
                raise ValueError(
                    f"registry signer '{signer.key_id}' validity window is invalid"
                )
            public_key_fingerprint(signer.public_key)
        signer_private_key = settings.registry_signer_private_key or (
            load_or_create_private_key(
                settings.data_dir / "trust" / "registry-signer.pem"
            )
        )
        root_private_key = settings.root_private_key or load_or_create_private_key(
            settings.data_dir / "trust" / "root.pem"
        )
        signer_public_key = public_key_from_private(signer_private_key)
        root_fingerprint = public_key_fingerprint(
            public_key_from_private(root_private_key)
        )
        if (
            settings.expected_root_fingerprint is not None
            and settings.expected_root_fingerprint != root_fingerprint
        ):
            raise ValueError(
                "configured registry root does not match expected App-pinned fingerprint"
            )
        not_before, not_after = _resolve_lifecycle(
            settings=settings,
            public_key=signer_public_key,
            root_fingerprint=root_fingerprint,
            now=now,
        )
        return cls(
            signer_private_key=signer_private_key,
            signer_public_key=signer_public_key,
            root_private_key=root_private_key,
            root_fingerprint=root_fingerprint,
            registry_profile=settings.trust_profile,
            key_id=settings.registry_signer_key_id,
            status=settings.signer_status,
            not_before=not_before,
            not_after=not_after,
            metadata_ttl=timedelta(hours=settings.trust_metadata_ttl_hours),
            trusted_signers=settings.trusted_signers,
            blocked_publishers=settings.blocked_publishers,
            blocked_packages=settings.blocked_packages,
        )

    def sign_envelope(
        self,
        *,
        artifact_digest: str,
        package_id: str,
        version: str,
        target: str,
        publisher_id: str,
        now: datetime | None = None,
        channel: str = STABLE_CHANNEL,
        expires_at: datetime | None = None,
    ) -> tuple[dict, str]:
        """Only a testplace envelope carries `channel` and `expiresAt`. Stable
        and pre-release envelopes keep the exact 8 fields every released App
        accepts, and released Apps reject the 10-field testplace one."""
        signed_at = now or datetime.now(timezone.utc)
        if self.status not in {"active", "rotating"}:
            raise ValueError(f"registry signer is {self.status}")
        if not self.not_before <= signed_at <= self.not_after:
            raise ValueError("registry signer is outside its validity period")
        if channel == TESTPLACE_CHANNEL:
            if expires_at is None:
                raise ValueError("a testplace version needs an expiry")
        elif channel in {STABLE_CHANNEL, PRERELEASE_CHANNEL}:
            if expires_at is not None:
                raise ValueError(f"a {channel} version cannot expire")
        else:
            raise ValueError(f"unknown release channel '{channel}'")
        envelope = {
            "schemaVersion": 1,
            "artifactDigest": artifact_digest,
            "packageId": package_id,
            "version": version,
            "target": target,
            "publisherId": publisher_id,
            "keyId": self.key_id,
            "signedAt": _timestamp(signed_at),
        }
        if channel == TESTPLACE_CHANNEL:
            envelope["channel"] = channel
            envelope["expiresAt"] = _timestamp(expires_at)
        return envelope, sign_json(self.signer_private_key, envelope)

    def sign_disclosure_envelope(
        self,
        *,
        package_envelope: dict,
        disclosure_digest: str,
        scan_digest: str | None = None,
        now: datetime | None = None,
    ) -> tuple[dict, str]:
        """Sign the disclosure envelope of one artifact (contract 3.5).

        Its identity fields are copied from the package envelope this signer
        just produced, so the two always name the same artifact, signer and
        moment. The package envelope itself is not changed. The signer's
        status and validity window are checked here too, so a later caller
        (an admin rescan) cannot sign with a signer sign_envelope would refuse.
        """
        signing_time = now or datetime.now(timezone.utc)
        if self.status not in {"active", "rotating"}:
            raise ValueError(f"registry signer is {self.status}")
        if not self.not_before <= signing_time <= self.not_after:
            raise ValueError("registry signer is outside its validity period")
        if package_envelope.get("keyId") != self.key_id:
            raise ValueError("package envelope was not signed by this registry signer")
        envelope = {
            "schemaVersion": 1,
            "artifactDigest": package_envelope["artifactDigest"],
            "packageId": package_envelope["packageId"],
            "version": package_envelope["version"],
            "target": package_envelope["target"],
            "keyId": self.key_id,
            "signedAt": package_envelope["signedAt"],
            "disclosureDigest": disclosure_digest,
            "scanDigest": scan_digest,
        }
        return envelope, sign_json(self.signer_private_key, envelope)

    def block_reason(
        self, *, publisher_id: str, package_id: str, version: str
    ) -> str | None:
        blocked_publishers, blocked_packages = self._blocklists()
        if publisher_id in blocked_publishers:
            return "publisher is blocked"
        for blocked in blocked_packages:
            blocked_id, separator, blocked_version = blocked.partition("@")
            if blocked_id == package_id and (
                not separator or blocked_version == version
            ):
                return (
                    "package version is blocked" if separator else "package is blocked"
                )
        return None

    def signed_metadata(self, now: datetime | None = None) -> tuple[dict, str]:
        generated_at = now or datetime.now(timezone.utc)
        blocked_publishers, blocked_packages = self._blocklists()
        metadata = {
            "schemaVersion": 1,
            "registryProfile": self.registry_profile,
            "rootFingerprint": self.root_fingerprint,
            "generatedAt": _timestamp(generated_at),
            "expiresAt": _timestamp(generated_at + self.metadata_ttl),
            "signers": [
                {
                    "keyId": self.key_id,
                    "publicKey": self.signer_public_key,
                    "status": self.status,
                    "notBefore": _timestamp(self.not_before),
                    "notAfter": _timestamp(self.not_after),
                },
                *[
                    {
                        "keyId": signer.key_id,
                        "publicKey": signer.public_key,
                        "status": signer.status,
                        "notBefore": _timestamp(signer.not_before),
                        "notAfter": _timestamp(signer.not_after),
                    }
                    for signer in self.trusted_signers
                ],
            ],
            "blockedPublishers": list(blocked_publishers),
            "blockedPackages": [
                _blocked_package(value) for value in blocked_packages
            ],
        }
        return metadata, sign_json(self.root_private_key, metadata)

    def signed_local_install(
        self,
        *,
        publisher_keys: list[dict],
        blocked_digests: list[dict],
        now: datetime | None = None,
    ) -> tuple[dict, str]:
        """Root-signed document for locally installed packages (A3): approved
        publisher keys, revoked ones included, and blocked package digests,
        each with its reason (`{digest, reason}`; decision d5).
        A separate document because released Apps reject any new field in
        `signed_metadata`, which stays byte-for-byte unchanged; `kind` keeps
        the two apart under the same root key."""
        generated_at = now or datetime.now(timezone.utc)
        document = {
            "schemaVersion": 1,
            "kind": "local-install-trust",
            "registryProfile": self.registry_profile,
            "generatedAt": _timestamp(generated_at),
            "expiresAt": _timestamp(generated_at + self.metadata_ttl),
            "blockedDigests": [{"digest": d["digest"], "reason": d["reason"]} for d in blocked_digests],
            "publisherKeys": [
                {
                    "publisherId": key["publisherId"],
                    "keyId": key["keyId"],
                    "publicKey": key["publicKey"],
                    "status": key["status"],
                    "revokedAt": _timestamp(_aware(key["revokedAt"])) if key["revokedAt"] else None,
                }
                for key in publisher_keys
            ],
        }
        return document, sign_json(self.root_private_key, document)
