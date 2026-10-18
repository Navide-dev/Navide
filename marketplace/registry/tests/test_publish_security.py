from __future__ import annotations

import hashlib
import logging

import pytest
from fastapi.testclient import TestClient

from tests.conftest import SignedEnv
from tests.fixtures import build_package, valid_manifest


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _publish(env: SignedEnv, data: bytes, *, signature=None, token=None):
    params = {"signature": signature} if signature else None
    headers = {"Authorization": f"Bearer {token or env.token}"}
    return env.client.post(
        "/api/publish",
        files={"package": ("pkg.vsix", data, "application/zip")},
        params=params,
        headers=headers,
    )


# -- signature gate -----------------------------------------------------
def test_signed_publish_accepted_and_trusted(signed_env: SignedEnv) -> None:
    data = build_package()
    sig = signed_env.sign(_digest(data))
    resp = _publish(signed_env, data, signature=sig)
    assert resp.status_code == 201, resp.text

    detail = signed_env.client.get("/api/extensions/acme/hello").json()
    version = detail["versions"][0]
    assert version["signed"] is True
    assert version["trust_tier"] == "signed-verified"
    assert version["capabilities"] == ["fs", "ui"]
    assert version["sensitive_capabilities"] == ["fs"]
    # Client trust is rooted in registry metadata, never the publisher key.
    assert version["registry_signature"]
    assert version["registry_envelope"]["publisherId"] == "acme"
    assert "public_key" not in detail


def test_unsigned_publish_rejected_when_required(signed_env: SignedEnv) -> None:
    resp = _publish(signed_env, build_package())
    assert resp.status_code == 403
    assert "signature is required" in resp.json()["detail"]


def test_tampered_signature_rejected(signed_env: SignedEnv) -> None:
    data = build_package()
    sig = signed_env.sign(_digest(b"different bytes"))
    resp = _publish(signed_env, data, signature=sig)
    assert resp.status_code == 403
    assert "invalid package signature" in resp.json()["detail"]


# -- publisher auth -----------------------------------------------------
def test_missing_token_rejected(signed_env: SignedEnv) -> None:
    data = build_package()
    sig = signed_env.sign(_digest(data))
    resp = signed_env.client.post(
        "/api/publish",
        files={"package": ("pkg.vsix", data, "application/zip")},
        params={"signature": sig},
    )
    assert resp.status_code == 401


def test_bad_token_rejected(signed_env: SignedEnv) -> None:
    data = build_package()
    sig = signed_env.sign(_digest(data))
    resp = _publish(signed_env, data, signature=sig, token="wrong-token")
    assert resp.status_code == 401


def test_cross_namespace_publish_rejected(signed_env: SignedEnv) -> None:
    # acme's token publishing under the 'beta' namespace.
    data = build_package(manifest=valid_manifest(id="beta.notes", publisher="beta"))
    sig = signed_env.sign(_digest(data))
    resp = _publish(signed_env, data, signature=sig)
    assert resp.status_code == 403
    assert "not entitled" in resp.json()["detail"]


# -- yank auth ----------------------------------------------------------
def test_owner_can_yank_nonowner_cannot(signed_env: SignedEnv) -> None:
    data = build_package()
    sig = signed_env.sign(_digest(data))
    assert _publish(signed_env, data, signature=sig).status_code == 201

    # Register a second publisher and try to yank acme's version.
    signed_env.client.post(
        "/api/publishers",
        json={"name": "beta", "token": "tok-beta"},
        headers={"X-Admin-Token": "official-admin-token"},
    )
    intruder = signed_env.client.post(
        "/api/extensions/acme/hello/1.0.0/yank",
        headers={"Authorization": "Bearer tok-beta"},
    )
    assert intruder.status_code == 403

    owner = signed_env.client.post(
        "/api/extensions/acme/hello/1.0.0/yank",
        headers={"Authorization": f"Bearer {signed_env.token}"},
    )
    assert owner.status_code == 200
    assert owner.json()["yanked"] is True


# -- registration admin gate --------------------------------------------
def test_registration_admin_gate(tmp_path) -> None:
    from registry.app import create_app
    from registry.config import VERIFIER_ED25519, Settings

    settings = Settings(
        data_dir=tmp_path,
        verifier_kind=VERIFIER_ED25519,
        admin_token="admin-secret",
    )
    client = TestClient(create_app(settings))

    denied = client.post("/api/publishers", json={"name": "acme"})
    assert denied.status_code == 401

    allowed = client.post(
        "/api/publishers",
        json={"name": "acme", "token": "t"},
        headers={"X-Admin-Token": "admin-secret"},
    )
    assert allowed.status_code == 201
    assert allowed.json()["has_token"] is True


def test_official_profile_keeps_publisher_registration_admin_gated(
    signed_env: SignedEnv,
) -> None:
    denied = signed_env.client.post(
        "/api/publishers",
        json={"name": "beta", "token": "tok-beta"},
    )
    assert denied.status_code == 401

    wrong = signed_env.client.post(
        "/api/publishers",
        json={"name": "beta", "token": "tok-beta"},
        headers={"X-Admin-Token": "wrong-admin-token"},
    )
    assert wrong.status_code == 401


# -- admin gate fails closed when no token is configured -----------------
def _dev_client(tmp_path, **overrides) -> TestClient:
    from registry.app import create_app
    from registry.config import VERIFIER_ACCEPTING, Settings

    settings = Settings(
        data_dir=tmp_path,
        verifier_kind=VERIFIER_ACCEPTING,
        require_signature=False,
        require_auth=False,
        **overrides,
    )
    return TestClient(create_app(settings))


def _seed_extension(client: TestClient) -> None:
    resp = client.post(
        "/api/publish",
        files={"package": ("pkg.vsix", build_package(), "application/zip")},
    )
    assert resp.status_code == 201, resp.text


def _admin_calls(client: TestClient, headers: dict[str, str]):
    return (
        client.post(
            "/api/publishers", json={"name": "acme", "token": "t"}, headers=headers
        ),
        client.post(
            "/api/extensions/acme/hello/featured",
            json={"featured": True},
            headers=headers,
        ),
    )


@pytest.mark.parametrize("configured", [None, "", "   "])
@pytest.mark.parametrize("presented", [None, "", "   ", "anything"])
def test_admin_endpoints_refuse_when_no_admin_token_is_configured(
    tmp_path, caplog, configured, presented
) -> None:
    client = _dev_client(tmp_path, admin_token=configured)
    _seed_extension(client)
    headers = {} if presented is None else {"X-Admin-Token": presented}

    with caplog.at_level(logging.WARNING, logger="registry.app"):
        responses = _admin_calls(client, headers)

    for resp in responses:
        assert resp.status_code == 401, resp.text
        assert "REGISTRY_ADMIN_TOKEN is not set" in resp.json()["detail"]
    assert client.get("/api/extensions/acme/hello").json()["featured"] is False
    assert "REGISTRY_ADMIN_TOKEN is not set" in caplog.text


def test_admin_endpoints_require_the_configured_token(tmp_path) -> None:
    client = _dev_client(tmp_path, admin_token="admin-secret")
    _seed_extension(client)

    for headers in ({}, {"X-Admin-Token": ""}, {"X-Admin-Token": "wrong"}):
        for resp in _admin_calls(client, headers):
            assert resp.status_code == 401, resp.text
            assert resp.json()["detail"] == "invalid admin token"

    registered, featured = _admin_calls(client, {"X-Admin-Token": "admin-secret"})
    assert registered.status_code == 201
    assert featured.status_code == 200
    assert featured.json()["featured"] is True


def test_open_admin_opt_in_allows_tokenless_admin_calls(tmp_path, caplog) -> None:
    with caplog.at_level(logging.WARNING, logger="registry.app"):
        client = _dev_client(tmp_path, allow_open_admin=True)
    assert "REGISTRY_ALLOW_OPEN_ADMIN" in caplog.text
    _seed_extension(client)

    registered, featured = _admin_calls(client, {})
    assert registered.status_code == 201
    assert featured.status_code == 200


def test_open_admin_opt_in_does_not_bypass_a_configured_token(tmp_path) -> None:
    client = _dev_client(tmp_path, admin_token="admin-secret", allow_open_admin=True)
    _seed_extension(client)

    for resp in _admin_calls(client, {}):
        assert resp.status_code == 401


@pytest.mark.parametrize("configured", [None, "", " ", "\t"])
@pytest.mark.parametrize("open_admin", [False, True])
def test_admin_json_api_refuses_when_no_admin_token_is_configured(
    tmp_path, caplog, configured, open_admin
) -> None:
    # The review/blocklist API never had a tokenless mode, so the dev opt-in
    # does not open it either; a blank token is "not set", not a password.
    client = _dev_client(tmp_path, admin_token=configured, allow_open_admin=open_admin)
    headers = {} if configured is None else {"X-Admin-Token": configured}

    with caplog.at_level(logging.WARNING, logger="registry.app"):
        review = client.get("/api/admin/review", headers=headers)
        block = client.post(
            "/api/admin/blocklist",
            json={"kind": "publisher", "value": "acme", "reason": "test"},
            headers=headers,
        )

    for resp in (review, block):
        assert resp.status_code == 401, resp.text
        assert "REGISTRY_ADMIN_TOKEN is not set" in resp.json()["detail"]
    assert "REGISTRY_ADMIN_TOKEN is not set" in caplog.text
