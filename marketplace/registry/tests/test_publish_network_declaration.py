"""C1 (2026-11-07): a public listing that declares network hosts must declare
the ones its code reaches; the Registry refuses the publish, naming them."""
from __future__ import annotations

import copy

import pytest
from fastapi.testclient import TestClient

from registry.app import create_app
from registry.config import VERIFIER_ACCEPTING, Settings
from tests.fixtures import build_v2_package, contract_manifest

ADMIN = "network-admin"  # noqa: S105 - test fixture token
PUBLISHER_TOKEN = "tok-" + "acme-network"


@pytest.fixture()
def client(tmp_path) -> TestClient:
    settings = Settings(
        data_dir=tmp_path,
        verifier_kind=VERIFIER_ACCEPTING,
        require_signature=False,
        require_auth=False,
        admin_token=ADMIN,
    )
    client = TestClient(create_app(settings))
    resp = client.post(
        "/api/publishers",
        json={"name": "acme", "token": PUBLISHER_TOKEN},
        headers={"X-Admin-Token": ADMIN},
    )
    assert resp.status_code == 201, resp.text
    return client


def _publish(client: TestClient, hosts: list[str] | None, code: bytes, version: str = "1.0.0"):
    manifest = copy.deepcopy(contract_manifest("network-hosts.json"))
    manifest.update(id="acme.status", publisher="acme", version=version)
    if hosts is None:
        manifest["permissions"].pop("network", None)
    else:
        manifest["permissions"]["network"] = {"hosts": hosts}
    entry = manifest["contributes"]["views"][0]["entry"]
    script = entry.rsplit("/", 1)[0] + "/main.js"
    return client.post(
        "/api/publish",
        headers={"Authorization": f"Bearer {PUBLISHER_TOKEN}"},
        files={"package": ("pkg.vsix", build_v2_package(manifest, extra_files={script: code}), "application/zip")},
    )


def test_a_declaring_package_whose_code_reaches_other_hosts_is_refused(client: TestClient) -> None:
    resp = _publish(client, ["api.github.com"], b"fetch('https://api.github.com/x'); fetch('https://tracker.evil.net/c')")
    assert resp.status_code == 422, resp.text
    assert "tracker.evil.net" in resp.json()["detail"]
    assert "permissions.network.hosts" in resp.json()["detail"]
    assert "api.github.com" not in resp.json()["detail"].split(":", 1)[1].split(";")[0]


def test_declared_hosts_and_wildcards_pass_and_an_undeclaring_package_is_not_judged(client: TestClient) -> None:
    ok = _publish(client, ["api.github.com", "*.example.com"], b"fetch('https://api.github.com/x'); fetch('wss://live.example.com/s')")
    assert ok.status_code == 201, ok.text
    none = _publish(client, None, b"fetch('https://tracker.evil.net/c')", version="1.0.1")
    assert none.status_code == 201, none.text
