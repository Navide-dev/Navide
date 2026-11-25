"""Navide Cloud sign-in: /login -> navide-auth -> /auth/callback -> session."""

from __future__ import annotations

import time
import urllib.parse

import pytest

from registry.cloud_auth import LOGIN_STATE_COOKIE, SESSION_COOKIE, decode_payload, sign
from registry.config import Settings
from tests.phase2_helpers import (
    AUTH_SECRET,
    AUTH_URL,
    RETURN_URL,
    SESSION_SECRET,
    cloud_settings,
    make_client,
    navide_auth_callback,
    sign_in,
    start_login,
)


@pytest.fixture()
def client(tmp_path):
    return make_client(cloud_settings(tmp_path))


def _set_cookie_lines(resp) -> list[str]:
    return resp.headers.get_list("set-cookie")


def test_login_redirects_to_navide_auth_with_a_registry_signed_request(client):
    resp = client.get("/login", params={"next": "/publisher"})
    assert resp.status_code == 303
    location = urllib.parse.urlsplit(resp.headers["location"])
    assert f"{location.scheme}://{location.netloc}{location.path}" == f"{AUTH_URL}/registry/sso"
    query = dict(urllib.parse.parse_qsl(location.query))
    assert sign(AUTH_SECRET, query["sso"]) == query["sig"]
    payload = decode_payload(query["sso"])
    assert payload["return_sso_url"] == RETURN_URL
    assert len(payload["nonce"]) >= 16
    (state_cookie,) = [c for c in _set_cookie_lines(resp) if c.startswith(LOGIN_STATE_COOKIE)]
    lowered = state_cookie.lower()
    assert "httponly" in lowered and "secure" in lowered and "samesite=lax" in lowered
    assert "path=/" in lowered


def test_callback_creates_a_secure_session(client):
    nonce = start_login(client)
    resp = client.get("/auth/callback", params=navide_auth_callback(nonce, name="Neil Lu"))
    assert resp.status_code == 303
    assert resp.headers["location"] == "/publisher"
    (session_cookie,) = [c for c in _set_cookie_lines(resp) if c.startswith(SESSION_COOKIE)]
    lowered = session_cookie.lower()
    assert "httponly" in lowered and "secure" in lowered and "samesite=lax" in lowered
    home = client.get("/")
    assert "Neil Lu" in home.text
    assert "Sign out" in home.text


@pytest.mark.parametrize(
    "tamper",
    [
        pytest.param(lambda n: navide_auth_callback(n, secret="d" * 44), id="wrong-secret"),
        pytest.param(lambda n: navide_auth_callback("another-nonce-0123456789"), id="nonce-mismatch"),
        pytest.param(lambda n: navide_auth_callback(n, email_verified="false"), id="unverified"),
        pytest.param(lambda n: navide_auth_callback(n, client="teams"), id="other-client"),
        pytest.param(
            lambda n: navide_auth_callback(n, issued_at_ms=int((time.time() - 3600) * 1000)), id="stale"
        ),
        pytest.param(lambda n: {**navide_auth_callback(n), "sig": "0" * 64}, id="bad-sig"),
    ],
)
def test_callback_refusals_create_no_session(client, tamper):
    nonce = start_login(client)
    resp = client.get("/auth/callback", params=tamper(nonce))
    assert resp.status_code == 400
    assert not any(c.startswith(SESSION_COOKIE + "=") and "Max-Age=0" not in c for c in _set_cookie_lines(resp))
    assert client.get("/publisher").status_code == 303  # still signed out


def test_callback_without_the_login_state_cookie_is_refused(tmp_path):
    first = make_client(cloud_settings(tmp_path))
    nonce = start_login(first)
    other = make_client(cloud_settings(tmp_path))  # a different browser
    assert other.get("/auth/callback", params=navide_auth_callback(nonce)).status_code == 400


def test_tampered_session_cookie_is_not_trusted(client):
    sign_in(client)
    value = client.cookies.get(SESSION_COOKIE)
    body, _, mac = value.rpartition(".")
    client.cookies.clear()
    tampered = body + "." + ("0" if mac[0] != "0" else "1") + mac[1:]
    assert client.get("/publisher", cookies={SESSION_COOKIE: tampered}).status_code == 303
    assert client.get("/publisher", cookies={SESSION_COOKIE: value}).status_code == 200


def test_next_cannot_redirect_off_site(client):
    nonce = start_login(client, next_path="//evil.example/x")
    resp = client.get("/auth/callback", params=navide_auth_callback(nonce))
    assert resp.headers["location"] == "/publisher"


def test_protected_page_sends_you_through_login_and_back(client):
    resp = client.get("/publisher/claim")
    assert resp.status_code == 303
    assert resp.headers["location"] == "/login?next=%2Fpublisher%2Fclaim"


def test_root_path_is_respected(tmp_path):
    client = make_client(cloud_settings(tmp_path, root_path="/registry"))
    resp = client.get("/registry/login", params={"next": "/publisher"})
    (state_cookie,) = [c for c in _set_cookie_lines(resp) if c.startswith(LOGIN_STATE_COOKIE)]
    assert "Path=/registry" in state_cookie
    nonce = decode_payload(dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(resp.headers["location"]).query))["sso"])["nonce"]
    done = client.get("/registry/auth/callback", params=navide_auth_callback(nonce))
    assert done.headers["location"] == "/registry/publisher"
    assert 'href="/registry/publisher"' in client.get("/registry/").text


def test_sign_in_is_off_without_configuration(tmp_path):
    client = make_client(cloud_settings(tmp_path, auth_url=None, auth_secret=None, auth_return_url=None, session_secret=None))
    assert client.get("/login").status_code == 503
    assert client.get("/publisher").status_code == 503
    assert "Sign in" not in client.get("/").text.split("<main")[0].replace("Sign in with", "")


def test_logout_needs_the_csrf_token(client):
    sign_in(client)
    assert client.post("/logout", data={"csrf": "nope"}).status_code == 403
    html = client.get("/").text
    token = html.split('name="csrf" value="')[1].split('"')[0]
    assert client.post("/logout", data={"csrf": token}).status_code == 303
    assert client.get("/publisher").status_code == 303


@pytest.mark.parametrize(
    "overrides, message",
    [
        ({"session_secret": None}, "together"),
        ({"auth_secret": "short"}, "at least"),
        ({"session_secret": AUTH_SECRET}, "must differ"),
        ({"auth_url": "http://auth.example.test/navide-auth"}, "https"),
    ],
)
def test_settings_refuse_incomplete_or_weak_auth(tmp_path, overrides, message):
    values = dict(
        data_dir=tmp_path,
        auth_url=AUTH_URL,
        auth_secret=AUTH_SECRET,
        auth_return_url=RETURN_URL,
        session_secret=SESSION_SECRET,
    )
    values.update(overrides)
    with pytest.raises(ValueError, match=message):
        Settings(**values)
