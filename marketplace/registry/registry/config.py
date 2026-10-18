"""Runtime settings resolved from the environment."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .signing import read_private_key_file
from .manifest_v2 import PACKAGE_ID_BODY_PATTERN

ENV_DATA_DIR = "REGISTRY_DATA_DIR"
DEFAULT_DATA_DIR = ".registry-data"

ENV_VERIFIER = "REGISTRY_VERIFIER"
ENV_REQUIRE_SIGNATURE = "REGISTRY_REQUIRE_SIGNATURE"
ENV_REQUIRE_AUTH = "REGISTRY_REQUIRE_AUTH"
ENV_ADMIN_TOKEN = "REGISTRY_ADMIN_TOKEN"
ENV_ALLOW_OPEN_ADMIN = "REGISTRY_ALLOW_OPEN_ADMIN"
ENV_TRUST_PROFILE = "REGISTRY_TRUST_PROFILE"
ENV_TRUST_CONFIG_FILE = "REGISTRY_TRUST_CONFIG_FILE"
ENV_ROOT_PATH = "REGISTRY_ROOT_PATH"
ENV_AUTH_URL = "REGISTRY_AUTH_URL"
ENV_AUTH_SECRET = "REGISTRY_AUTH_SECRET"
ENV_AUTH_RETURN_URL = "REGISTRY_AUTH_RETURN_URL"
ENV_SESSION_SECRET = "REGISTRY_SESSION_SECRET"
ENV_ADMIN_MEMBER_IDS = "REGISTRY_ADMIN_MEMBER_IDS"
ENV_COOKIE_SECURE = "REGISTRY_COOKIE_SECURE"
MIN_AUTH_SECRET_LENGTH = 32

TRUST_PROFILE_OFFICIAL = "official"
TRUST_PROFILE_SELF_HOSTED_DEV = "self-hosted-dev"
SIGNER_STATUSES = {"active", "rotating", "expired", "revoked"}
PUBLISHER_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*$")
PACKAGE_PATTERN = re.compile(rf"^{PACKAGE_ID_BODY_PATTERN}(?:@[^@\s]+)?$")

# Verifier kinds.
VERIFIER_ED25519 = "ed25519"
VERIFIER_ACCEPTING = "accepting"


@dataclass(frozen=True)
class TrustedSignerConfig:
    key_id: str
    public_key: str
    status: str
    not_before: datetime
    not_after: datetime


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    # Security policy. Production defaults are strict; the test/dev harness
    # opts into a permissive configuration explicitly (see tests/conftest.py).
    verifier_kind: str = VERIFIER_ED25519
    """Which SignatureVerifier to install: 'ed25519' (real) or 'accepting' (dev)."""
    require_signature: bool = True
    """Reject unsigned publishes unless False (dev)."""
    require_auth: bool = True
    """Reject anonymous publishes/yanks unless False (dev)."""
    admin_token: str | None = None
    """Token gating the X-Admin-Token endpoints; unset or blank refuses them."""
    allow_open_admin: bool = False
    """Dev-only opt-in: with no admin token, leave the X-Admin-Token endpoints open."""
    registry_signer_private_key: str | None = None
    """Injected Ed25519 signer key; persisted under data_dir when omitted."""
    registry_signer_key_id: str = "registry-local-1"
    root_private_key: str | None = None
    """Injected root key for trust metadata; persisted under data_dir when omitted."""
    trust_profile: str = TRUST_PROFILE_SELF_HOSTED_DEV
    expected_root_fingerprint: str | None = None
    signer_status: str = "active"
    signer_not_before: datetime | None = None
    signer_not_after: datetime | None = None
    signer_validity_days: int = 365
    trust_metadata_ttl_hours: int = 24
    trusted_signers: tuple[TrustedSignerConfig, ...] = ()
    blocked_publishers: tuple[str, ...] = ()
    blocked_packages: tuple[str, ...] = ()
    root_path: str = ""
    """Public path prefix when served behind a reverse proxy (e.g. "/registry")."""
    auth_url: str | None = None
    """navide-auth base URL, e.g. https://forum.navide.dev/navide-auth; None
    disables Navide Cloud sign-in (and with it self-service publishing)."""
    auth_secret: str | None = None
    """This registry's own navide-auth client secret (never Discourse's)."""
    auth_return_url: str | None = None
    """Exact `/auth/callback` URL registered in navide-auth's allowlist."""
    session_secret: str | None = None
    """Signs the registry session and login-state cookies."""
    admin_member_ids: tuple[str, ...] = ()
    """Navide Cloud member ids allowed into the review queue and blocklist UI."""
    cookie_secure: bool = True
    """Only a plain-http local run turns this off."""

    @property
    def cloud_auth_enabled(self) -> bool:
        return self.auth_url is not None

    def __post_init__(self) -> None:
        auth_values = (
            self.auth_url,
            self.auth_secret,
            self.auth_return_url,
            self.session_secret,
        )
        if any(v is not None for v in auth_values):
            if any(v is None or not v.strip() for v in auth_values):
                raise ValueError(
                    "Navide Cloud sign-in needs auth_url, auth_secret, "
                    "auth_return_url and session_secret together"
                )
            if (
                len(self.auth_secret) < MIN_AUTH_SECRET_LENGTH
                or len(self.session_secret) < MIN_AUTH_SECRET_LENGTH
            ):
                raise ValueError(
                    "auth_secret and session_secret must be at least "
                    f"{MIN_AUTH_SECRET_LENGTH} characters"
                )
            if self.auth_secret == self.session_secret:
                raise ValueError("auth_secret and session_secret must differ")
            for url in (self.auth_url, self.auth_return_url):
                if not url.startswith("https://") and not (
                    not self.cookie_secure and url.startswith("http://")
                ):
                    raise ValueError("auth URLs must be https")
        if self.root_path and (
            not self.root_path.startswith("/")
            or self.root_path.endswith("/")
            or "//" in self.root_path
        ):
            raise ValueError(
                "root_path must be empty or start with '/' and have no trailing '/'"
            )
        if self.trust_profile != TRUST_PROFILE_OFFICIAL:
            return
        if self.verifier_kind != VERIFIER_ED25519:
            raise ValueError("official registry requires the ed25519 verifier")
        if not self.require_signature:
            raise ValueError("official registry requires package signatures")
        if not self.require_auth:
            raise ValueError("official registry requires publisher authentication")
        if self.admin_token is None or not self.admin_token.strip():
            raise ValueError("official registry requires an admin token")
        if self.allow_open_admin:
            raise ValueError("official registry cannot allow open admin endpoints")
        if not self.cookie_secure:
            raise ValueError("official registry requires Secure cookies")

    @property
    def db_path(self) -> Path:
        return self.data_dir / "registry.db"

    @property
    def storage_root(self) -> Path:
        return self.data_dir / "packages"


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _require_object(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"trust config {field} must be an object")
    return value


def _require_exact_fields(
    value: dict[str, Any], *, field: str, required: set[str]
) -> None:
    actual = set(value)
    if actual != required:
        missing = sorted(required - actual)
        unknown = sorted(actual - required)
        detail = []
        if missing:
            detail.append(f"missing {missing}")
        if unknown:
            detail.append(f"unknown {unknown}")
        raise ValueError(f"trust config {field} has {'; '.join(detail)}")


def _require_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"trust config {field} must be a non-empty string")
    return value


def _timestamp(value: Any, field: str) -> datetime:
    raw = _require_string(value, field)
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"trust config {field} is not an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"trust config {field} must include a timezone")
    return parsed.astimezone(timezone.utc)


def _status(value: Any, field: str) -> str:
    status = _require_string(value, field)
    if status not in SIGNER_STATUSES:
        raise ValueError(f"trust config {field} has unknown signer status")
    return status


def _read_key(
    config_path: Path, value: Any, field: str, *, private: bool = False
) -> str:
    raw_path = Path(_require_string(value, field))
    path = raw_path if raw_path.is_absolute() else config_path.parent / raw_path
    try:
        if private:
            return read_private_key_file(path)
        return path.read_text(encoding="ascii")
    except (OSError, UnicodeError, ValueError) as exc:
        raise ValueError(f"trust config {field} cannot be read") from exc


def _string_tuple(value: Any, field: str) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise ValueError(f"trust config {field} must be an array")
    result = tuple(_require_string(item, f"{field}[]") for item in value)
    if len(result) != len(set(result)):
        raise ValueError(f"trust config {field} contains duplicates")
    return result


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"trust config contains duplicate JSON key '{key}'")
        result[key] = value
    return result


def _load_official_trust_config(path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(
            path.read_text(encoding="utf-8"), object_pairs_hook=_unique_object
        )
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        raise ValueError("trust config file cannot be read as JSON") from exc
    config = _require_object(raw, "root")
    _require_exact_fields(
        config,
        field="root",
        required={
            "schemaVersion",
            "profile",
            "expectedRootFingerprint",
            "rootPrivateKeyFile",
            "signer",
            "trustedSigners",
            "blockedPublishers",
            "blockedPackages",
        },
    )
    if config["schemaVersion"] != 1 or config["profile"] != TRUST_PROFILE_OFFICIAL:
        raise ValueError("trust config must use schemaVersion 1 and profile 'official'")

    signer = _require_object(config["signer"], "signer")
    _require_exact_fields(
        signer,
        field="signer",
        required={"keyId", "privateKeyFile", "status", "notBefore", "notAfter"},
    )
    signer_not_before = _timestamp(signer["notBefore"], "signer.notBefore")
    signer_not_after = _timestamp(signer["notAfter"], "signer.notAfter")
    if signer_not_after <= signer_not_before:
        raise ValueError("trust config signer validity window is invalid")

    trusted_raw = config["trustedSigners"]
    if not isinstance(trusted_raw, list):
        raise ValueError("trust config trustedSigners must be an array")
    trusted: list[TrustedSignerConfig] = []
    for index, item in enumerate(trusted_raw):
        entry = _require_object(item, f"trustedSigners[{index}]")
        _require_exact_fields(
            entry,
            field=f"trustedSigners[{index}]",
            required={"keyId", "publicKeyFile", "status", "notBefore", "notAfter"},
        )
        not_before = _timestamp(
            entry["notBefore"], f"trustedSigners[{index}].notBefore"
        )
        not_after = _timestamp(entry["notAfter"], f"trustedSigners[{index}].notAfter")
        if not_after <= not_before:
            raise ValueError(
                f"trust config trustedSigners[{index}] validity window is invalid"
            )
        trusted.append(
            TrustedSignerConfig(
                key_id=_require_string(
                    entry["keyId"], f"trustedSigners[{index}].keyId"
                ),
                public_key=_read_key(
                    path,
                    entry["publicKeyFile"],
                    f"trustedSigners[{index}].publicKeyFile",
                ),
                status=_status(entry["status"], f"trustedSigners[{index}].status"),
                not_before=not_before,
                not_after=not_after,
            )
        )

    current_key_id = _require_string(signer["keyId"], "signer.keyId")
    all_key_ids = [current_key_id, *(entry.key_id for entry in trusted)]
    if len(all_key_ids) != len(set(all_key_ids)):
        raise ValueError("trust config signer keyId values must be unique")

    blocked_publishers = _string_tuple(config["blockedPublishers"], "blockedPublishers")
    if any(not PUBLISHER_PATTERN.fullmatch(item) for item in blocked_publishers):
        raise ValueError(
            "trust config blockedPublishers contains an invalid publisher ID"
        )
    blocked_packages = _string_tuple(config["blockedPackages"], "blockedPackages")
    if any(not PACKAGE_PATTERN.fullmatch(item) for item in blocked_packages):
        raise ValueError(
            "trust config blockedPackages contains an invalid package selector"
        )

    return {
        "trust_profile": TRUST_PROFILE_OFFICIAL,
        "expected_root_fingerprint": _require_string(
            config["expectedRootFingerprint"], "expectedRootFingerprint"
        ),
        "root_private_key": _read_key(
            path, config["rootPrivateKeyFile"], "rootPrivateKeyFile", private=True
        ),
        "registry_signer_private_key": _read_key(
            path, signer["privateKeyFile"], "signer.privateKeyFile", private=True
        ),
        "registry_signer_key_id": current_key_id,
        "signer_status": _status(signer["status"], "signer.status"),
        "signer_not_before": signer_not_before,
        "signer_not_after": signer_not_after,
        "trusted_signers": tuple(trusted),
        "blocked_publishers": blocked_publishers,
        "blocked_packages": blocked_packages,
    }


def load_settings() -> Settings:
    data_dir = Path(os.environ.get(ENV_DATA_DIR, DEFAULT_DATA_DIR))
    trust_profile = os.environ.get(ENV_TRUST_PROFILE, TRUST_PROFILE_SELF_HOSTED_DEV)
    trust_config: dict[str, Any] = {"trust_profile": trust_profile}
    config_file = os.environ.get(ENV_TRUST_CONFIG_FILE)
    if trust_profile == TRUST_PROFILE_OFFICIAL:
        if not config_file:
            raise ValueError(
                "REGISTRY_TRUST_CONFIG_FILE is required for the official trust profile"
            )
        trust_config = _load_official_trust_config(Path(config_file))
    elif trust_profile != TRUST_PROFILE_SELF_HOSTED_DEV:
        raise ValueError(f"unknown registry trust profile '{trust_profile}'")
    elif config_file:
        raise ValueError(
            "REGISTRY_TRUST_CONFIG_FILE is only valid for the official trust profile"
        )
    return Settings(
        data_dir=data_dir,
        verifier_kind=os.environ.get(ENV_VERIFIER, VERIFIER_ED25519),
        require_signature=_env_bool(ENV_REQUIRE_SIGNATURE, True),
        require_auth=_env_bool(ENV_REQUIRE_AUTH, True),
        admin_token=os.environ.get(ENV_ADMIN_TOKEN),
        allow_open_admin=_env_bool(ENV_ALLOW_OPEN_ADMIN, False),
        root_path=os.environ.get(ENV_ROOT_PATH, "").strip().rstrip("/"),
        auth_url=(os.environ.get(ENV_AUTH_URL) or "").strip().rstrip("/") or None,
        auth_secret=os.environ.get(ENV_AUTH_SECRET) or None,
        auth_return_url=(os.environ.get(ENV_AUTH_RETURN_URL) or "").strip() or None,
        session_secret=os.environ.get(ENV_SESSION_SECRET) or None,
        admin_member_ids=tuple(
            item.strip()
            for item in os.environ.get(ENV_ADMIN_MEMBER_IDS, "").split(",")
            if item.strip()
        ),
        cookie_secure=_env_bool(ENV_COOKIE_SECURE, True),
        **trust_config,
    )
