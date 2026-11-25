"""navide-auth's registry sign-in page on the storefront's and the console's
own host (auth_proxy.py), against a stand-in navide-auth on loopback."""

from __future__ import annotations

import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

from registry.app import create_app
from registry.cloud_auth import decode_payload
from registry.config import load_settings
from tests.phase2_helpers import AUTH_URL, cloud_settings

STORE = "https://marketplace.example.test"
DEV = "https://developers.example.test"
LEGACY = "server.example.test"
PREFIX = "/registry"
PAGE = "/navide-auth/registry/sso"
FORM = "/navide-auth/registry/sso/login"


class FakeAuth:
    """Records each request and answers with the configured response."""

    def __init__(self) -> None:
        self.requests: list[dict] = []
        self.status = 200
        self.headers: list[tuple[str, str]] = [
            ("Content-Type", "text/html; charset=utf-8"),
            ("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'"),
            ("Cache-Control", "no-store"),
            ("Set-Cookie", "navide_auth_registry=sealed; Path=/navide-auth; HttpOnly; SameSite=Lax; Secure"),
            ("Set-Cookie", "other_cookie=x; Path=/"),
            ("X-Powered-By", "fastify"),
        ]
        self.body = b"<title>Sign in to Navide Developers</title>"
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def _answer(self) -> None:
                length = int(self.headers.get("content-length") or 0)
                fake.requests.append(
                    {
                        "method": self.command,
                        "path": self.path,
                        "headers": {k.lower(): v for k, v in self.headers.items()},
                        "body": self.rfile.read(length) if length else b"",
                    }
                )
                self.send_response(fake.status)
                for name, value in fake.headers:
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(fake.body)))
                self.end_headers()
                self.wfile.write(fake.body)

            do_GET = _answer
            do_POST = _answer

            def log_message(self, *args) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.origin = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture()
def fake_auth():
    fake = FakeAuth()
    yield fake
    fake.close()


def _settings(tmp_path, **overrides):
    return cloud_settings(
        tmp_path,
        require_auth=False,
        root_path=PREFIX,
        auth_return_url=f"https://{LEGACY}{PREFIX}/auth/callback",
        store_origin=STORE,
        developer_origin=DEV,
        legacy_hosts=(LEGACY,),
        **overrides,
    )


def _clients(app):
    return {
        name: TestClient(app, base_url=base, follow_redirects=False)
        for name, base in (("store", STORE), ("dev", DEV), ("legacy", f"https://{LEGACY}"))
    }


@pytest.fixture()
def proxied(tmp_path, fake_auth):
    return _clients(create_app(_settings(tmp_path, auth_upstream=fake_auth.origin)))


@pytest.fixture()
def direct(tmp_path):
    return _clients(create_app(_settings(tmp_path)))


def _login(client: TestClient) -> tuple[urllib.parse.SplitResult, dict]:
    resp = client.get("/login", params={"next": "/publisher"})
    assert resp.status_code == 303, resp.text
    location = urllib.parse.urlsplit(resp.headers["location"])
    sso = dict(urllib.parse.parse_qsl(location.query))["sso"]
    return location, decode_payload(sso)


# -- where /login sends the browser ---------------------------------------
@pytest.mark.parametrize(("name", "origin", "audience"), [("dev", DEV, "developers"), ("store", STORE, "marketplace")])
def test_sign_in_stays_on_the_host_it_began_on(proxied, name, origin, audience) -> None:
    location, payload = _login(proxied[name])
    assert f"{location.scheme}://{location.netloc}{location.path}" == origin + PAGE
    assert payload["return_sso_url"] == origin + "/auth/callback"
    assert payload["audience"] == audience


@pytest.mark.parametrize(("name", "origin", "audience"), [("dev", DEV, "developers"), ("store", STORE, "marketplace")])
def test_without_upstream_sign_in_still_goes_to_auth_url(direct, name, origin, audience) -> None:
    location, payload = _login(direct[name])
    assert f"{location.scheme}://{location.netloc}{location.path}" == AUTH_URL + "/registry/sso"
    assert payload["return_sso_url"] == origin + "/auth/callback"
    assert payload["audience"] == audience


def test_without_upstream_the_relay_paths_are_not_served(direct) -> None:
    assert direct["dev"].get(PAGE).status_code == 404
    assert direct["store"].post(FORM, data={"nonce": "n"}).status_code == 404


# -- the relay -------------------------------------------------------------
def test_page_relay_forwards_only_the_sign_in_cookie_and_the_balancer_address(proxied, fake_auth) -> None:
    dev = proxied["dev"]
    dev.cookies.set("navide_registry_session", "registry-session-value", domain="developers.example.test")
    dev.cookies.set("navide_registry_login", "login-state-value", domain="developers.example.test")
    dev.cookies.set("navide_auth_registry", "sealed-before", domain="developers.example.test")
    resp = dev.get(
        PAGE + "?sso=abc&sig=def",
        headers={"x-forwarded-for": "198.51.100.9, 203.0.113.7", "authorization": "Bearer nope"},
    )
    assert resp.status_code == 200
    assert resp.text == fake_auth.body.decode()
    sent = fake_auth.requests[-1]
    assert sent["method"] == "GET"
    assert sent["path"] == PAGE + "?sso=abc&sig=def"
    assert sent["headers"]["cookie"] == "navide_auth_registry=sealed-before"
    assert sent["headers"]["x-forwarded-for"] == "203.0.113.7"
    assert "authorization" not in sent["headers"]
    # Only navide-auth's own sign-in cookie comes back, with its CSP intact.
    cookies = resp.headers.get_list("set-cookie")
    assert cookies == ["navide_auth_registry=sealed; Path=/navide-auth; HttpOnly; SameSite=Lax; Secure"]
    assert resp.headers["content-security-policy"] == "default-src 'none'; style-src 'unsafe-inline'"
    assert "x-powered-by" not in resp.headers
    assert resp.headers["x-robots-tag"] == "noindex, nofollow"


def test_form_relay_passes_the_redirect_to_this_hosts_callback(proxied, fake_auth) -> None:
    fake_auth.status = 302
    fake_auth.headers = [("Location", f"{DEV}/auth/callback?sso=s&sig=t")]
    fake_auth.body = b""
    resp = proxied["dev"].post(FORM, data={"email": "a@example.test", "password": "pw", "nonce": "n"})
    assert resp.status_code == 302
    assert resp.headers["location"] == f"{DEV}/auth/callback?sso=s&sig=t"
    sent = fake_auth.requests[-1]
    assert sent["method"] == "POST"
    assert sent["headers"]["content-type"] == "application/x-www-form-urlencoded"
    assert urllib.parse.parse_qs(sent["body"].decode())["email"] == ["a@example.test"]


@pytest.mark.parametrize(
    "location",
    [
        f"{STORE}/auth/callback?sso=s&sig=t",  # the other host
        "https://evil.example.test/auth/callback?sso=s",
        f"{DEV}/publisher",
        "/auth/callback?sso=s",
    ],
)
def test_form_relay_refuses_any_other_redirect(proxied, fake_auth, location) -> None:
    fake_auth.status = 302
    fake_auth.headers = [("Location", location)]
    fake_auth.body = b""
    resp = proxied["dev"].post(FORM, data={"nonce": "n"})
    assert resp.status_code == 502
    assert "location" not in resp.headers


def test_store_relays_too(proxied, fake_auth) -> None:
    fake_auth.status = 302
    fake_auth.headers = [("Location", f"{STORE}/auth/callback?sso=s&sig=t")]
    fake_auth.body = b""
    assert proxied["store"].get(PAGE).status_code == 302
    assert proxied["store"].post(FORM, data={"nonce": "n"}).status_code == 302


def test_form_relay_refuses_an_oversized_body(proxied, fake_auth) -> None:
    resp = proxied["dev"].post(FORM, content=b"a" * (16 * 1024 + 1), headers={"content-type": "application/x-www-form-urlencoded"})
    assert resp.status_code == 413
    assert fake_auth.requests == []


def test_only_the_two_registry_paths_are_relayed(proxied, fake_auth) -> None:
    dev = proxied["dev"]
    for path in ("/navide-auth/sso", "/navide-auth/healthz", "/navide-auth/registry/other"):
        assert dev.get(path).status_code == 404, path
    assert dev.post(PAGE).status_code in (404, 405)
    assert dev.get(FORM).status_code in (404, 405)
    # The legacy host keeps signing in through auth_url; it never relays.
    assert proxied["legacy"].get(f"{PREFIX}{PAGE}").status_code == 404
    assert fake_auth.requests == []


def test_unreachable_upstream_is_a_502(tmp_path) -> None:
    app = create_app(_settings(tmp_path, auth_upstream="http://127.0.0.1:9"))
    resp = TestClient(app, base_url=DEV, follow_redirects=False).get(PAGE)
    assert resp.status_code == 502


# -- site name in titles and the header ---------------------------------------
def _title_and_brand(resp) -> tuple[str, str]:
    import re

    title = re.search(r"<title>(.*?)</title>", resp.text).group(1)
    brand = re.search(r'<span class="brand-name">(.*?)</span>', resp.text).group(1)
    return title, brand


def test_console_pages_carry_the_console_name(direct) -> None:
    for path in ("/developer", "/publish"):
        title, brand = _title_and_brand(direct["dev"].get(path))
        assert brand == "Navide 開發者後台", path
        assert title.endswith("— Navide 開發者後台"), title
        assert "Navide Marketplace" not in title


def test_storefront_and_single_host_keep_the_marketplace_name(direct, tmp_path) -> None:
    title, brand = _title_and_brand(direct["store"].get("/removed"))
    assert (title, brand) == ("Removed extensions — Navide Marketplace", "Navide Marketplace")
    title, brand = _title_and_brand(direct["store"].get("/"))
    assert brand == "Navide Marketplace" and title.startswith("Navide Marketplace")
    single = TestClient(create_app(cloud_settings(tmp_path / "single")), follow_redirects=False)
    title, brand = _title_and_brand(single.get("/publish"))
    assert (title, brand) == ("Publish — Navide Marketplace", "Navide Marketplace")


# -- settings ----------------------------------------------------------------
@pytest.mark.parametrize(
    "overrides",
    [
        {"auth_upstream": "http://127.0.0.1:18790/navide-auth"},
        {"auth_upstream": "ftp://127.0.0.1"},
        {"auth_upstream": "http://127.0.0.1:18790", "auth_url": "https://auth.example.test/other"},
    ],
)
def test_invalid_upstream_settings_are_refused(tmp_path, overrides) -> None:
    with pytest.raises(ValueError):
        _settings(tmp_path, **overrides)


def test_upstream_needs_host_routing(tmp_path) -> None:
    with pytest.raises(ValueError):
        cloud_settings(tmp_path, auth_upstream="http://127.0.0.1:18790")


def test_upstream_loads_from_the_environment(tmp_path, monkeypatch) -> None:
    secret = "s" * 32  # assembled at run time, never a real value
    for name, value in {
        "REGISTRY_DATA_DIR": str(tmp_path),
        "REGISTRY_AUTH_URL": AUTH_URL,
        "REGISTRY_AUTH_SECRET": secret,
        "REGISTRY_SESSION_SECRET": secret + "x",
        "REGISTRY_AUTH_RETURN_URL": f"https://{LEGACY}{PREFIX}/auth/callback",
        "REGISTRY_STORE_ORIGIN": STORE,
        "REGISTRY_DEVELOPER_ORIGIN": DEV,
        "REGISTRY_AUTH_UPSTREAM": "http://172.17.0.1:18790/",
    }.items():
        monkeypatch.setenv(name, value)
    assert load_settings().auth_upstream == "http://172.17.0.1:18790"
