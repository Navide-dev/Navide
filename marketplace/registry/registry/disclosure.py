"""Disclosure data the Registry publishes (contract sections 3.4 and 3.5).

`manifest_disclosure` computes the manifest-derived disclosure with the
vendored contract module; the Registry signs its digest in a separate
disclosure envelope (registry_trust.RegistryTrustSigner.sign_disclosure_envelope)
and never changes the 8-field package envelope. `registry_facts` builds the
unsigned `registry` object: facts only the Registry knows, as counts and
status, never a secret value or file content.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone

from .models import ExtensionVersion, Publisher
from .plugin_contract.disclosure_contract import (
    ManifestDisclosure,
    canonical_contract_json,
    compute_disclosure,
)
from .plugin_contract.disclosure_scan_contract import declared_vs_scanned
from .registry_trust import RegistryTrustSigner


def undeclared_network_hosts(manifest: dict, scan: dict | None) -> list[str]:
    """The hosts a package's code names that its `permissions.network` does
    not cover (contract 3.9, the red list of the card), for the publish gate
    (C1, 2026-11-07): a public listing that declares hosts must declare the
    ones its code reaches. A package that declares none is not judged here
    (the strings its libraries carry are a scan sentence, not a use), and an
    incomplete scan judges nothing."""
    if scan is None:
        return []
    disclosure = manifest_disclosure(manifest)
    if disclosure is None or disclosure.get("networkHosts") is None:
        return []
    try:
        undeclared = declared_vs_scanned(disclosure, scan)["undeclared"]
    except (KeyError, TypeError):
        return []
    return sorted({entry["key"] for entry in undeclared if entry.get("kind") == "networkHost"})


def manifest_disclosure(manifest: dict) -> ManifestDisclosure | None:
    """The disclosure of a stored Manifest v2, or None for a legacy v1 manifest."""
    if manifest.get("schemaVersion") != 2:
        return None
    return compute_disclosure(manifest)


def disclosure_digest(disclosure: ManifestDisclosure) -> str:
    """Lowercase hex SHA-256 of the canonical contract spelling."""
    return hashlib.sha256(canonical_contract_json(disclosure).encode("ascii")).hexdigest()


def scan_digest(scan: dict) -> str:
    """Lowercase hex SHA-256 of the scan report's canonical spelling (contract 3.5)."""
    return hashlib.sha256(canonical_contract_json(scan).encode("ascii")).hexdigest()


def sign_disclosure(
    signer: RegistryTrustSigner,
    manifest: dict,
    package_envelope: dict,
    scan: dict | None = None,
) -> tuple[ManifestDisclosure | None, dict | None, str | None]:
    """(disclosure, disclosure envelope, signature) for one just-signed
    artifact, or three Nones for a legacy v1 manifest. ``scan`` is the
    artifact's scan report (contract 3.8), or None while there is no scanner:
    the envelope then carries ``scanDigest: null`` (DS8)."""
    disclosure = manifest_disclosure(manifest)
    if disclosure is None:
        return None, None, None
    if scan is not None and (
        scan.get("artifactDigest") != package_envelope["artifactDigest"]
        or scan.get("target") != package_envelope["target"]
    ):
        raise ValueError("scan report does not describe this artifact")
    envelope, signature = signer.sign_disclosure_envelope(
        package_envelope=package_envelope,
        disclosure_digest=disclosure_digest(disclosure),
        scan_digest=scan_digest(scan) if scan is not None else None,
    )
    return disclosure, envelope, signature


def _timestamp(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _review_status(row: ExtensionVersion) -> str:
    if row.review_status == "approved":
        return "approved" if row.reviewed_by else "not-required"
    return row.review_status


def registry_facts(row: ExtensionVersion, publisher: Publisher | None) -> dict:
    """The `registry` object of one version (contract 3.4); not signed."""
    has_backend = (row.manifest or {}).get("backend") is not None
    status = _review_status(row)
    if not has_backend:
        inspected = None
    else:
        # Approval of a backend version requires the admin to confirm every
        # target's executable was inspected (review.approve).
        inspected = status == "approved"
    report = row.review_report or {}
    secret_scan = report.get("secret_scan")
    if isinstance(secret_scan, dict):
        findings = len(secret_scan.get("findings") or [])
        scan = {
            "secretScan": "findings" if findings else "clean",
            "secretFindings": findings,
            "similarityWarning": bool(report.get("similarity")),
            "similarTo": None,
            "scannedAt": _timestamp(row.published_at),
        }
    else:
        scan = {
            "secretScan": "not-run",
            "secretFindings": 0,
            "similarityWarning": False,
            "similarTo": None,
            "scannedAt": None,
        }
    verified = publisher is not None and publisher.domain_verified_at is not None
    envelope = row.registry_envelope or {}
    return {
        "publisher": {
            "name": (publisher.display_name or publisher.name) if publisher else None,
            "verifiedDomain": publisher.verified_domain if verified else None,
            "domainVerifiedAt": _timestamp(publisher.domain_verified_at) if verified else None,
        },
        "signature": {
            "signed": row.registry_signature is not None,
            "keyId": envelope.get("keyId") if row.registry_signature is not None else None,
        },
        "review": {
            "status": status,
            "reviewedAt": _timestamp(row.reviewed_at) if row.reviewed_by else None,
            "nativeCodeInspected": inspected,
        },
        "scan": scan,
    }
