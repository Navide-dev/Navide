"""Native backend publishing: allowlist + DNS gate, review checks, admin page."""

from __future__ import annotations

import hashlib
import io
import sqlite3
import stat
import zipfile
import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from registry.app import create_app
from registry.config import VERIFIER_ACCEPTING, Settings

from registry.db import create_db_engine
from registry.dns_verify import record_host, record_value
from registry.models import Publisher
from registry.native_backend import (
    MIN_NAVIDE_FOR_BACKEND_SHELL,
    LOCAL_NATIVE_BACKEND_NOTICE,
    MIN_NAVIDE_FOR_THIRD_PARTY_BACKEND,

)
from registry.secret_scan import MAX_SCANNED_BYTES_PER_FILE, scan_package
from registry.similarity import check_extension_name
from tests.fixtures import build_v2_package, contract_manifest
from tests.test_migrations import PRE_DISCOVERY_SCHEMA, _create
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

MACHO_ARM64 = (0xFEEDFACF).to_bytes(4, "little") + (0x0100000C).to_bytes(4, "little")
AWS_KEY = b"AKIA" + b"A" * 16


def _backend_manifest(**overrides: object) -> dict:
    manifest = contract_manifest("backend-declared-methods.json")
    manifest.update(id="acme-tools.indexer", publisher="acme-tools")
    manifest["engines"] = {"navide": f">={MIN_NAVIDE_FOR_THIRD_PARTY_BACKEND}"}
    manifest.update(overrides)
    return manifest


def _backend_package(manifest: dict | None = None, backend_data: bytes = MACHO_ARM64) -> bytes:
    return build_v2_package(manifest or _backend_manifest(), backend_data=backend_data)


def _set_allowed(client, allowed: bool = True) -> None:
    with Session(client.app.state.registry.engine) as session:
        publisher = session.exec(select(Publisher).where(Publisher.name == "acme-tools")).one()
        publisher.native_backend_allowed = allowed
        session.add(publisher)
        session.commit()


def _verify_domain(client, dns: FakeDns) -> None:
    csrf = csrf_of(client, "/publisher/acme-tools")
    client.post("/publisher/acme-tools/domain", data={"domain": "acme.example", "csrf": csrf})
    html = client.get("/publisher/acme-tools").text
    token = html.split("navide-verify=")[1].split("\n")[0].split("<")[0].strip()
    dns.records[record_host("acme.example")] = [f'"{record_value(token)}"']
    check = client.post(
        "/publisher/acme-tools/domain/check",
        data={"csrf": csrf_of(client, "/publisher/acme-tools")},
    )
    assert check.status_code == 303


@pytest.fixture()
def dns():
    return FakeDns()


@pytest.fixture()
def client(tmp_path, dns):
    client = make_client(cloud_settings(tmp_path), dns)
    sign_in(client)
    assert claim(client, "acme-tools").status_code == 303
    return client


@pytest.fixture()
def token(client):
    return new_token(client, "acme-tools")


def test_self_service_publisher_needs_allowlist_and_verified_domain(client, dns, token):
    refused = publish(client, token, _backend_package(), target="darwin-arm64")
    assert refused.status_code == 403
    assert "native backend allowlist" in refused.json()["detail"]

    _set_allowed(client)
    refused = publish(client, token, _backend_package(), target="darwin-arm64")
    assert refused.status_code == 403
    assert "verified publisher domain" in refused.json()["detail"]

    _verify_domain(client, dns)
    accepted = publish(client, token, _backend_package(), target="darwin-arm64")
    assert accepted.status_code == 201, accepted.text
    assert queued_artifacts(client, "acme-tools", "indexer")


def test_backend_package_may_declare_allowlist_shell_on_a_navide_with_the_shell_port(client, dns, token):
    # DB5 (disclose, don't restrict): a backend package may declare
    # shell: "allowlist"; its backend reaches git/gh/glab only through the
    # Host shell broker, which first exists in MIN_NAVIDE_FOR_BACKEND_SHELL.
    _set_allowed(client)
    _verify_domain(client, dns)
    allowlist = _backend_manifest(
        permissions={"system": ["fs"], "shell": "allowlist"},
        engines={"navide": f">={MIN_NAVIDE_FOR_BACKEND_SHELL}"},
    )
    accepted = publish(client, token, _backend_package(allowlist), target="darwin-arm64")
    assert accepted.status_code == 201, accepted.text
    assert queued_artifacts(client, "acme-tools", "indexer")


def test_backend_package_cannot_request_shell_or_old_navide(client, dns, token):
    # "shell" here is full shell, or allowlist shell on a Navide without the
    # backend shell broker port.
    _set_allowed(client)
    _verify_domain(client, dns)
    old_host = _backend_manifest(permissions={"system": ["fs"], "shell": "allowlist"})
    resp = publish(client, token, _backend_package(old_host), target="darwin-arm64")
    assert resp.status_code == 403
    assert MIN_NAVIDE_FOR_BACKEND_SHELL in resp.json()["detail"]

    full = _backend_manifest(
        permissions={"system": ["fs"], "shell": "full"},
        engines={"navide": f">={MIN_NAVIDE_FOR_BACKEND_SHELL}"},
    )
    resp = publish(client, token, _backend_package(full), target="darwin-arm64")
    assert resp.status_code == 403
    assert "full shell" in resp.json()["detail"]

    no_methods = _backend_manifest()
    no_methods["backend"] = {k: v for k, v in no_methods["backend"].items() if k != "methods"}
    resp = publish(client, token, _backend_package(no_methods), target="darwin-arm64")
    assert resp.status_code == 403
    assert "backend.methods" in resp.json()["detail"]

    for engines in (None, {"navide": ">=0.2.0"}, {"navide": "*"}):
        manifest = _backend_manifest()
        if engines is None:
            manifest.pop("engines")
        else:
            manifest["engines"] = engines
        resp = publish(client, token, _backend_package(manifest), target="darwin-arm64")
        assert resp.status_code == 403, engines
        assert MIN_NAVIDE_FOR_THIRD_PARTY_BACKEND in resp.json()["detail"]


def test_revoking_the_allowlist_blocks_the_next_upload(client, dns, token):
    _set_allowed(client)
    _verify_domain(client, dns)
    assert publish(client, token, _backend_package(), target="darwin-arm64").status_code == 201
    _set_allowed(client, False)
    second = _backend_package(_backend_manifest(version="1.0.1"))
    assert publish(client, token, second, target="darwin-arm64").status_code == 403


def test_frontend_only_packages_are_unaffected(client, token):
    manifest = contract_manifest()
    manifest.update(id="acme-tools.viewer", publisher="acme-tools")
    assert publish(client, token, build_v2_package(manifest)).status_code == 201


def test_approval_requires_confirming_the_backend_was_inspected(client, dns, token):
    _set_allowed(client)
    _verify_domain(client, dns)
    assert publish(client, token, _backend_package(), target="darwin-arm64").status_code == 201
    artifacts = queued_artifacts(client, "acme-tools", "indexer")
    review = client.get("/api/admin/review", headers=ADMIN_HEADERS).json()["items"]
    assert any(item["name"] == "indexer" for item in review)

    refused = client.post(
        "/api/admin/review/acme-tools/indexer/1.0.0/approve",
        json={"artifacts": artifacts},
        headers=ADMIN_HEADERS,
    )
    assert refused.status_code == 409
    assert "native backend" in refused.json()["detail"]

    sign_in(client, member_id=ADMIN_MEMBER, name="Admin")
    page = client.get("/admin/review").text
    assert 'name="inspected_backend"' in page
    approved = client.post(
        "/admin/review/acme-tools/indexer/1.0.0/approve",
        data={"csrf": csrf_of(client, "/admin/review"), "artifact": artifacts, "inspected_backend": "yes"},
    )
    assert approved.status_code == 303, approved.text
    assert client.get("/api/extensions/acme-tools/indexer").status_code == 200


def test_admin_page_toggles_the_allowlist(client):
    sign_in(client, member_id=ADMIN_MEMBER, name="Admin")
    page = client.get("/admin/native-backends")
    assert page.status_code == 200
    assert "acme-tools" in page.text and "not allowed" in page.text
    csrf = csrf_of(client, "/admin/native-backends")
    resp = client.post("/admin/native-backends/acme-tools", data={"allowed": "yes", "csrf": csrf})
    assert resp.status_code == 303
    with Session(client.app.state.registry.engine) as session:
        assert session.exec(select(Publisher).where(Publisher.name == "acme-tools")).one().native_backend_allowed
    missing = client.post("/admin/native-backends/nobody", data={"allowed": "yes", "csrf": csrf})
    assert missing.status_code == 404


def test_admin_page_requires_an_admin(client):
    resp = client.get("/admin/native-backends")
    assert resp.status_code in (303, 403, 404)


def test_secret_scan_reads_the_whole_backend_binary():
    padding = b"\x00" * (MAX_SCANNED_BYTES_PER_FILE + 1024)
    binary = MACHO_ARM64 + padding + AWS_KEY
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", "{}")
        info = zipfile.ZipInfo("backend/acme-indexer")
        info.external_attr = (stat.S_IFREG | 0o755) << 16
        archive.writestr(info, binary)
        archive.writestr("assets/blob.bin", padding + AWS_KEY)
    data = buffer.getvalue()

    plain = scan_package(data)
    assert plain.findings == ()
    assert plain.truncated

    deep = scan_package(data, backend_prefix="backend/")
    assert [(f.path, f.rule) for f in deep.findings] == [("backend/acme-indexer", "AWS access key id")]


def test_native_backend_names_get_the_stricter_similarity_check():
    assert check_extension_name("acme", "lint", [("other", "list")]) == []
    strict = check_extension_name("acme", "lint", [("other", "list")], strict=True)
    assert any("within two edits" in finding.message for finding in strict)
    assert check_extension_name("acme", "lint", [("acme", "list")], strict=True) == []


def test_migration_8_adds_the_allowlist_column_off_for_everyone(tmp_path):
    path = tmp_path / "registry.db"
    _create(path, PRE_DISCOVERY_SCHEMA)
    create_db_engine(path)
    with sqlite3.connect(path) as db:
        columns = {row[1]: row for row in db.execute("PRAGMA table_info(publisher)")}
        applied = {row[0] for row in db.execute("SELECT version FROM schema_migrations")}
        allowed = db.execute("SELECT native_backend_allowed FROM publisher").fetchall()
    assert "native_backend_allowed" in columns
    assert 8 in applied
    assert allowed == [(0,)]


# -- local (self-hosted-dev) Registry: same package rules as the Marketplace --


@pytest.fixture()
def local_client(tmp_path):
    # The local setup marketplace-publishing.md section 3 documents: the
    # default self-hosted-dev profile and a publisher created with the admin
    # token, which on the Marketplace would be a self-claimed one.
    client = TestClient(
        create_app(
            Settings(
                data_dir=tmp_path,
                verifier_kind=VERIFIER_ACCEPTING,
                require_signature=False,
                require_auth=False,
                allow_open_admin=True,
            )
        )
    )
    assert client.post("/api/publishers", json={"name": "acme-tools"}).status_code == 201
    return client


def _local_publish(client, manifest: dict):
    return publish(client, "", _backend_package(manifest), target="darwin-arm64")


@pytest.mark.parametrize(
    ("change", "detail"),
    [
        (lambda m: m["backend"].pop("methods"), "backend.methods"),
        (
            lambda m: m.update(
                permissions={"system": ["fs"], "shell": "full"},
                engines={"navide": f">={MIN_NAVIDE_FOR_BACKEND_SHELL}"},
            ),
            "full shell",
        ),
        (lambda m: m.update(engines={"navide": ">=0.1.0"}), MIN_NAVIDE_FOR_THIRD_PARTY_BACKEND),
        (lambda m: m.update(permissions={"system": ["fs"], "shell": "allowlist"}), MIN_NAVIDE_FOR_BACKEND_SHELL),
    ],
)
def test_local_registry_refuses_the_backend_packages_the_marketplace_refuses(local_client, change, detail):
    manifest = _backend_manifest()
    change(manifest)
    refused = _local_publish(local_client, manifest)
    assert refused.status_code == 403, refused.text
    assert detail in refused.json()["detail"]


def test_local_registry_discloses_the_publisher_gates_it_cannot_run(local_client):
    accepted = _local_publish(local_client, _backend_manifest())
    assert accepted.status_code == 201, accepted.text
    assert accepted.json()["notices"] == [LOCAL_NATIVE_BACKEND_NOTICE]


def test_local_registry_adds_no_notice_without_a_backend(local_client):
    manifest = contract_manifest()
    manifest.update(id="acme-tools.plain", publisher="acme-tools")
    accepted = publish(local_client, "", build_v2_package(manifest))
    assert accepted.status_code == 201, accepted.text
    assert accepted.json()["notices"] == []


def test_official_registry_keeps_the_admin_publisher_path(signed_env):
    # Production (official profile): an admin-created publisher's first-party
    # backend keeps its existing path, unchanged by the local rule above.
    manifest = _backend_manifest(id="acme.indexer", publisher="acme", engines={"navide": ">=0.1.0"})
    data = _backend_package(manifest)
    accepted = signed_env.client.post(
        "/api/publish",
        params={"target": "darwin-arm64", "signature": signed_env.sign(hashlib.sha256(data).hexdigest())},
        files={"package": ("p.vsix", data, "application/zip")},
        headers={"Authorization": f"Bearer {signed_env.token}"},
    )
    assert accepted.status_code == 201, accepted.text
    assert accepted.json()["notices"] == []
