"""`POST /api/cli/cloud-exchange` and `GET /api/developer/me/namespaces`:
the App trades a Navide-Server assertion + PKCE verifier for the same tokens
the browser sign-in issues. Every key here is generated at runtime."""

from __future__ import annotations

import base64
import json
import secrets
import time
from datetime import datetime, timezone

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sqlmodel import Session, select

from registry.config import load_settings
from registry.models import DeveloperQualification, Publisher, UsedCloudAssertion
from registry.ratelimit import SlidingWindowLimiter
from registry.self_service import pkce_challenge
from tests.phase2_helpers import ADMIN_HEADERS, claim, cloud_settings, make_client, new_token, sign_in

OWNER = "mem-cloud-owner"
OTHER = "mem-cloud-other"
NAMESPACE = "acme-tools"
KID = "20261114"
VERIFIER = "v" * 50


def _public_pem(private: Ed25519PrivateKey) -> str:
    return private.public_key().public_bytes(
        encoding=serialization.Encoding.PEM, format=serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode("ascii")


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def make_assertion(private: Ed25519PrivateKey, kid: str = KID, **overrides) -> str:
    now = int(time.time())
    payload = {
        "iss": "navide-server",
        "aud": "registry",
        "sub": OWNER,
        "name": "Neil",
        "email_verified": True,
        "scope": "account",
        "namespace": None,
        "challenge": pkce_challenge(VERIFIER),
        "iat": now,
        "exp": now + 60,
        "jti": secrets.token_urlsafe(16),
    }
    payload.update(overrides)
    for key in [k for k, v in overrides.items() if v is _DROP]:
        del payload[key]
    signed = f"nvsa1.{kid}.{_b64(json.dumps(payload).encode())}"
    return f"{signed}.{_b64(private.sign(signed.encode('ascii')))}"


_DROP = object()


@pytest.fixture()
def key() -> Ed25519PrivateKey:
    return Ed25519PrivateKey.generate()


@pytest.fixture()
def client(tmp_path, key):
    return make_client(cloud_settings(tmp_path, cloud_assertion_keys=((KID, _public_pem(key)),)))


def exchange(client, assertion: str, scope: str = "account", namespace: str | None = None, verifier: str = VERIFIER):
    return client.post(
        "/api/cli/cloud-exchange",
        json={"assertion": assertion, "code_verifier": verifier, "scope": scope, "namespace": namespace},
    )


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def rejected(resp, code: str, status: int = 401) -> None:
    assert resp.status_code == status, resp.text
    assert resp.json()["detail"]["code"] == code
    assert resp.headers["cache-control"] == "no-store"


def owner_with_namespace(client, namespace: str = NAMESPACE) -> None:
    sign_in(client, OWNER)
    assert claim(client, namespace).status_code == 303


# -- success -------------------------------------------------------------------
def test_account_exchange_issues_a_working_account_token(client, key):
    sign_in(client, OWNER, approved=False)
    assertion = make_assertion(key)
    resp = exchange(client, assertion)
    assert resp.status_code == 200, resp.text
    assert resp.headers["cache-control"] == "no-store"
    body = resp.json()
    assert body["token"].startswith("nva_") and body["scope"] == "account" and body["namespace"] is None
    assert datetime.fromisoformat(body["expires_at"]).replace(tzinfo=timezone.utc) > datetime.now(timezone.utc)
    assert client.get("/api/developer/me/application", headers=bearer(body["token"])).status_code == 200

    rows = client.get("/api/admin/audit", headers=ADMIN_HEADERS).json()["items"]
    row = next(r for r in rows if r["action"] == "cloud-assertion.exchange")
    assert row["actor"] == f"member:{OWNER}"
    assert row["detail"]["kid"] == KID and row["detail"]["scope"] == "account"
    assert row["detail"]["jti"]
    assert assertion not in json.dumps(rows) and body["token"] not in json.dumps(rows)


def test_publish_exchange_for_an_approved_owner_issues_a_publisher_token(client, key):
    owner_with_namespace(client)
    resp = exchange(client, make_assertion(key, scope="publish", namespace=NAMESPACE), "publish", NAMESPACE)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["token"].startswith("nvp_") and body["scope"] == "publisher" and body["namespace"] == NAMESPACE
    me = client.get("/api/publisher/me", headers=bearer(body["token"]))
    assert me.status_code == 200 and me.json()["namespace"] == NAMESPACE


def test_two_kids_are_accepted_during_rotation(tmp_path):
    old, new = Ed25519PrivateKey.generate(), Ed25519PrivateKey.generate()
    client = make_client(
        cloud_settings(tmp_path, cloud_assertion_keys=(("old-1", _public_pem(old)), ("new-2", _public_pem(new))))
    )
    assert exchange(client, make_assertion(old, kid="old-1")).status_code == 200
    assert exchange(client, make_assertion(new, kid="new-2")).status_code == 200
    # A key is bound to its kid.
    rejected(exchange(client, make_assertion(old, kid="new-2")), "ASSERTION_INVALID")


# -- rejections ------------------------------------------------------------------
def test_replay_is_refused(client, key):
    assertion = make_assertion(key)
    assert exchange(client, assertion).status_code == 200
    rejected(exchange(client, assertion), "ASSERTION_REPLAYED")


def test_used_jtis_are_pruned_once_long_expired(client, key):
    with Session(client.app.state.registry.engine) as session:
        session.add(UsedCloudAssertion(jti="old-" + "a" * 20, navide_member_id=OWNER, expires_at=datetime(2026, 1, 1, tzinfo=timezone.utc)))
        session.commit()
    assert exchange(client, make_assertion(key)).status_code == 200
    with Session(client.app.state.registry.engine) as session:
        jtis = session.exec(select(UsedCloudAssertion.jti)).all()
    assert len(jtis) == 1 and not jtis[0].startswith("old-")


def test_expired_assertion(client, key):
    now = int(time.time())
    rejected(exchange(client, make_assertion(key, iat=now - 200, exp=now - 140)), "ASSERTION_EXPIRED")


def test_clock_skew_within_30_seconds_is_tolerated(client, key):
    now = int(time.time())
    assert exchange(client, make_assertion(key, iat=now - 70, exp=now - 10)).status_code == 200
    assert exchange(client, make_assertion(key, iat=now + 20, exp=now + 80)).status_code == 200


def test_iat_in_the_future(client, key):
    now = int(time.time())
    rejected(exchange(client, make_assertion(key, iat=now + 100, exp=now + 160)), "ASSERTION_INVALID")


def test_lifetime_over_60_seconds(client, key):
    now = int(time.time())
    rejected(exchange(client, make_assertion(key, iat=now, exp=now + 61)), "ASSERTION_INVALID")


@pytest.mark.parametrize(
    "overrides",
    [
        {"aud": "navide-server"},
        {"iss": "someone-else"},
        {"email_verified": False},
        {"email_verified": "true"},
        {"iat": "now"},
        {"exp": True},
        {"jti": _DROP},
        {"namespace": _DROP},
        {"jti": "short"},
        {"challenge": "x" * 10},
        {"sub": ""},
        {"scope": "admin"},
        {"scope": "publish", "namespace": None},
        {"scope": "account", "namespace": NAMESPACE},
    ],
    ids=lambda o: ",".join(f"{k}={v if v is not _DROP else 'missing'}" for k, v in o.items()),
)
def test_bad_claims_are_invalid(client, key, overrides):
    scope = overrides.get("scope") if overrides.get("scope") in ("account", "publish") else "account"
    namespace = overrides.get("namespace") if isinstance(overrides.get("namespace"), str) else None
    rejected(exchange(client, make_assertion(key, **overrides), scope, namespace), "ASSERTION_INVALID")


def test_unknown_kid(client, key):
    rejected(exchange(client, make_assertion(key, kid="not-configured")), "ASSERTION_INVALID")


def test_bad_signature_and_tampered_payload(client, key):
    rejected(exchange(client, make_assertion(Ed25519PrivateKey.generate())), "ASSERTION_INVALID")
    prefix, kid, _payload, sig = make_assertion(key).split(".")
    _, _, other_payload, _ = make_assertion(key, sub=OTHER).split(".")
    rejected(exchange(client, f"{prefix}.{kid}.{other_payload}.{sig}"), "ASSERTION_INVALID")


@pytest.mark.parametrize("bad", ["", "nvsa1", "nvsa2.k.a.b", "nvsa1.k.a", "nvsa1.k.a.b.c", "nvsa1.k.a=.b"])
def test_malformed_assertion(client, bad):
    rejected(exchange(client, bad), "ASSERTION_INVALID")


def test_oversized_assertion(client, key):
    assertion = make_assertion(key, name="n" * 4096)
    assert len(assertion) > 4096
    rejected(exchange(client, assertion), "ASSERTION_INVALID")


def test_wrong_verifier_is_refused_and_does_not_spend_the_assertion(client, key):
    assertion = make_assertion(key)
    rejected(exchange(client, assertion, verifier="w" * 50), "ASSERTION_INVALID")
    # Steps 5-6 come before the jti is recorded.
    assert exchange(client, assertion).status_code == 200


def test_request_must_match_the_assertion_scope_and_namespace(client, key):
    owner_with_namespace(client)
    rejected(exchange(client, make_assertion(key), "publish", NAMESPACE), "ASSERTION_INVALID")
    publish_assertion = make_assertion(key, scope="publish", namespace=NAMESPACE)
    rejected(exchange(client, publish_assertion, "account", None), "ASSERTION_INVALID")
    rejected(exchange(client, publish_assertion, "publish", "other-tools"), "ASSERTION_INVALID")


def test_unapproved_owner_cannot_get_a_publish_token(client, key):
    owner_with_namespace(client)
    with Session(client.app.state.registry.engine) as session:
        session.delete(session.get(DeveloperQualification, OWNER))
        session.commit()
    resp = exchange(client, make_assertion(key, scope="publish", namespace=NAMESPACE), "publish", NAMESPACE)
    rejected(resp, "QUALIFICATION_REQUIRED", status=403)


def test_namespace_the_account_is_not_a_member_of(client, key):
    sign_in(client, OTHER)
    assert claim(client, "other-tools").status_code == 303
    sign_in(client, OWNER)
    resp = exchange(client, make_assertion(key, scope="publish", namespace="other-tools"), "publish", "other-tools")
    assert resp.status_code == 404
    resp = exchange(client, make_assertion(key, scope="publish", namespace="no-such-ns"), "publish", "no-such-ns")
    assert resp.status_code == 404


def test_off_without_keys(tmp_path, key):
    client = make_client(cloud_settings(tmp_path))
    assert exchange(client, make_assertion(key)).status_code == 404


def test_repeated_failures_are_rate_limited(client, key):
    client.app.state.registry.cloud_exchange_limiter = SlidingWindowLimiter(2, 600)
    for _ in range(2):
        rejected(exchange(client, make_assertion(Ed25519PrivateKey.generate())), "ASSERTION_INVALID")
    rejected(exchange(client, make_assertion(key)), "RATE_LIMITED", status=429)


# -- namespaces for the App's picker ---------------------------------------------
def test_namespaces_lists_only_publishable_vetted_namespaces(client, key):
    owner_with_namespace(client)
    assert claim(client, "acme-frozen").status_code == 303
    publish_token = new_token(client, NAMESPACE)
    with Session(client.app.state.registry.engine) as session:
        frozen = session.exec(select(Publisher).where(Publisher.name == "acme-frozen")).one()
        frozen.frozen_at = datetime.now(timezone.utc)
        session.add(frozen)
        session.commit()
    sign_in(client, OTHER)
    assert claim(client, "other-tools").status_code == 303

    token = exchange(client, make_assertion(key)).json()["token"]
    resp = client.get("/api/developer/me/namespaces", headers=bearer(token))
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"namespaces": [NAMESPACE]}
    assert resp.headers["cache-control"] == "no-store"

    resp = client.get("/api/developer/me/namespaces", headers=bearer(publish_token))
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "TOKEN_SCOPE"
    resp = client.get("/api/developer/me/namespaces")
    assert resp.status_code == 401 and resp.json()["detail"]["code"] == "TOKEN_MISSING"


# -- keys file ---------------------------------------------------------------------
def _write_keys(tmp_path, content) -> str:
    path = tmp_path / "cloud-keys.json"
    path.write_text(content if isinstance(content, str) else json.dumps(content), encoding="utf-8")
    return str(path)


def test_keys_file_loads(monkeypatch, tmp_path, key):
    monkeypatch.setenv("REGISTRY_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("REGISTRY_CLOUD_ASSERTION_KEYS_FILE", raising=False)
    assert load_settings().cloud_assertion_keys == ()
    monkeypatch.setenv("REGISTRY_CLOUD_ASSERTION_KEYS_FILE", str(tmp_path / "missing.json"))
    assert load_settings().cloud_assertion_keys == ()
    pem = _public_pem(key)
    monkeypatch.setenv("REGISTRY_CLOUD_ASSERTION_KEYS_FILE", _write_keys(tmp_path, {"keys": [{"kid": KID, "public_key": pem}]}))
    settings = load_settings()
    assert settings.cloud_assertion_keys == ((KID, pem),) and settings.cloud_exchange_enabled


def _pem_of_non_ed25519_key() -> str:
    return ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(
        encoding=serialization.Encoding.PEM, format=serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode("ascii")


def _private_pem(private: Ed25519PrivateKey) -> str:
    return private.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")


@pytest.mark.parametrize(
    "make_content",
    [
        lambda key: "{not json",
        lambda key: [],
        lambda key: {"keys": {}},
        lambda key: {"keys": [], "extra": 1},
        lambda key: {"keys": [{"kid": KID}]},
        lambda key: {"keys": [{"kid": "bad kid!", "public_key": _public_pem(key)}]},
        lambda key: {"keys": [{"kid": "k" * 65, "public_key": _public_pem(key)}]},
        lambda key: {"keys": [{"kid": KID, "public_key": "not a key"}]},
        lambda key: {"keys": [{"kid": KID, "public_key": _pem_of_non_ed25519_key()}]},
        lambda key: {"keys": [{"kid": KID, "public_key": _private_pem(key)}]},
        lambda key: {"keys": [{"kid": KID, "public_key": _public_pem(key)}, {"kid": KID, "public_key": _public_pem(key)}]},
    ],
)
def test_bad_keys_file_stops_startup(monkeypatch, tmp_path, key, make_content):
    monkeypatch.setenv("REGISTRY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("REGISTRY_CLOUD_ASSERTION_KEYS_FILE", _write_keys(tmp_path, make_content(key)))
    with pytest.raises(ValueError, match="cloud assertion key"):
        load_settings()
