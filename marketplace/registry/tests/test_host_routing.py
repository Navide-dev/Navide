"""One registry behind three hosts: storefront, developer console and the
legacy API host (host_routing.py)."""

from __future__ import annotations

import urllib.parse

import pytest
from fastapi.testclient import TestClient

from registry.app import create_app
from registry.cloud_auth import SESSION_COOKIE, decode_payload
from registry.config import Settings, load_settings
from tests.fixtures import build_package, valid_manifest
from tests.phase2_helpers import approve_developer, cloud_settings, navide_auth_callback

STORE = "https://marketplace.example.test"
DEV = "https://developers.example.test"
LEGACY = "server.example.test"
PREFIX = "/registry"
LEGACY_RETURN_URL = f"https://{LEGACY}{PREFIX}/auth/callback"
HOME = "https://navide.example.test/"


@pytest.fixture()
def app(tmp_path):
    return create_app(
        cloud_settings(
            tmp_path,
            require_auth=False,
            root_path=PREFIX,
            auth_return_url=LEGACY_RETURN_URL,
            store_origin=STORE,
            developer_origin=DEV,
            legacy_hosts=(LEGACY,),
            legacy_redirect_to=HOME,
        )
    )


def _client(app, base_url: str) -> TestClient:
    return TestClient(app, base_url=base_url, follow_redirects=False)


@pytest.fixture()
def store(app) -> TestClient:
    return _client(app, STORE)


@pytest.fixture()
def dev(app) -> TestClient:
    return _client(app, DEV)


@pytest.fixture()
def legacy(app) -> TestClient:
    return _client(app, f"https://{LEGACY}")


def _publish(legacy: TestClient) -> None:
    resp = legacy.post(
        f"{PREFIX}/api/publish",
        files={"package": ("p.vsix", build_package(manifest=valid_manifest()), "application/zip")},
    )
    assert resp.status_code == 201, resp.text


def _sign_in(client: TestClient, next_path: str) -> str:
    """Sign in on `client`'s host; return the return URL navide-auth was given."""
    approve_developer(client, "mem-1")
    resp = client.get("/login", params={"next": next_path})
    assert resp.status_code == 303, resp.text
    sso = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(resp.headers["location"]).query))["sso"]
    payload = decode_payload(sso)
    callback = client.get("/auth/callback", params=navide_auth_callback(payload["nonce"]))
    assert callback.status_code == 303, callback.text
    return payload["return_sso_url"]


# -- storefront -----------------------------------------------------------
def test_store_serves_its_pages_at_the_root_and_is_indexable(store, legacy) -> None:
    _publish(legacy)
    for path in ("/", "/?q=hello", "/extensions/acme/hello", "/removed"):
        resp = store.get(path)
        assert resp.status_code == 200, path
        assert "x-robots-tag" not in resp.headers
    detail = store.get("/extensions/acme/hello").text
    assert f'<link rel="canonical" href="{STORE}/extensions/acme/hello">' in detail
    assert 'href="/static/style.css"' in detail
    assert f'href="{DEV}/publish"' in detail
    assert store.get("/static/style.css").status_code == 200
    removed = store.get("/removed").text
    assert f'href="https://{LEGACY}{PREFIX}/api/removed"' in removed


def test_store_serves_package_assets_for_its_pages(store, legacy) -> None:
    _publish(legacy)
    # Whatever the asset route answers (README.md is not a served image
    # type), it is the route answering, not a host refusal or redirect.
    resp = store.get("/extensions/acme/hello/1.0.0/assets/README.md")
    assert resp.status_code not in (301, 404), resp.text


def test_store_sends_developer_pages_to_the_console(store) -> None:
    for path in ("/publish", "/publisher", "/publisher/acme", "/developer/apply", "/admin/review"):
        resp = store.get(path)
        assert resp.status_code == 301, path
        assert resp.headers["location"] == DEV + path
    resp = store.get("/cli/authorize?port=1&state=s")
    assert resp.headers["location"] == f"{DEV}/cli/authorize?port=1&state=s"


def test_store_and_console_do_not_serve_the_api(store, dev) -> None:
    for client in (store, dev):
        assert client.get("/api/health").status_code == 404
        assert client.get("/api/extensions").status_code == 404
        assert client.post("/api/publish").status_code == 404
        assert client.get(f"{PREFIX}/api/health").status_code == 404


def test_store_signs_members_in_on_its_own_host(store, dev) -> None:
    assert _sign_in(store, "/extensions/acme/hello") == f"{STORE}/auth/callback"
    cookie = next(c for c in store.cookies.jar if c.name == SESSION_COOKIE)
    assert cookie.domain == "marketplace.example.test"
    assert cookie.path == "/"
    # Host-only: the console does not see the storefront's session.
    assert dev.get("/publisher").headers["location"].startswith("/login")


def test_store_robots_allows(store) -> None:
    resp = store.get("/robots.txt")
    assert resp.text == "User-agent: *\nAllow: /\n"
    assert "x-robots-tag" not in resp.headers


# -- developer console ----------------------------------------------------
def test_console_pages_are_noindex_and_sign_in_gated(dev) -> None:
    for path in ("/publish", "/publisher", "/developer/apply", "/admin/review"):
        resp = dev.get(path)
        assert resp.status_code == 303, path
        assert resp.headers["location"].startswith("/login?")
        assert resp.headers["x-robots-tag"] == "noindex, nofollow"
    assert dev.get("/robots.txt").text == "User-agent: *\nDisallow: /\n"


def test_console_root_is_the_dashboard(dev) -> None:
    resp = dev.get("/")
    assert resp.status_code == 301
    assert resp.headers["location"] == "/publisher"


def test_console_sends_store_pages_to_the_store(dev) -> None:
    for path in ("/extensions/acme/hello", "/removed", "/extensions/acme/hello/report"):
        resp = dev.get(path)
        assert resp.status_code == 301, path
        assert resp.headers["location"] == STORE + path


def test_console_signs_in_on_its_own_host(dev) -> None:
    assert _sign_in(dev, "/publisher") == f"{DEV}/auth/callback"
    cookie = next(c for c in dev.cookies.jar if c.name == SESSION_COOKIE)
    assert cookie.domain == "developers.example.test"
    resp = dev.get("/publisher")
    assert resp.status_code == 200
    assert f'href="{STORE}/"' in resp.text
    assert "x-robots-tag" in resp.headers


def test_console_publish_page_redirects_signed_in_developers(dev) -> None:
    _sign_in(dev, "/publisher")
    resp = dev.get("/publish")
    assert resp.status_code == 303
    assert resp.headers["location"] == "/publisher"


def test_console_sign_out_returns_to_the_store(dev) -> None:
    _sign_in(dev, "/publisher")
    html = dev.get("/publisher").text
    csrf = html.split('name="csrf" value="', 1)[1].split('"', 1)[0]
    resp = dev.post("/logout", data={"csrf": csrf})
    assert resp.status_code == 303
    assert resp.headers["location"] == f"{STORE}/"


def test_wrong_host_post_is_not_redirected(store, dev) -> None:
    assert store.post("/publisher/claim").status_code == 404
    assert dev.post("/extensions/acme/hello/rating").status_code == 404


# -- legacy API host ------------------------------------------------------
def test_legacy_keeps_serving_the_api_and_downloads(legacy) -> None:
    _publish(legacy)
    health = legacy.get(f"{PREFIX}/api/health")
    assert health.json() == {"status": "ok"}
    assert health.headers["x-robots-tag"] == "noindex, nofollow"
    assert legacy.get(f"{PREFIX}/api/extensions/acme/hello").status_code == 200
    download = legacy.get(f"{PREFIX}/api/extensions/acme/hello/1.0.0/download")
    assert download.status_code == 200
    assert download.headers["x-robots-tag"] == "noindex, nofollow"
    # The App fetches package assets from the API host.
    asset = legacy.get(f"{PREFIX}/extensions/acme/hello/1.0.0/assets/README.md")
    assert asset.status_code != 301


@pytest.mark.parametrize(
    "path",
    [
        "/",
        "/extensions/acme/hello",
        "/extensions/acme/hello/report",
        "/removed",
        "/publish",
        "/publisher",
        "/publisher/claim",
        "/developer/apply",
        "/login",
        "/admin/review",
        "/admin/testplace",
    ],
)
def test_legacy_pages_redirect_to_the_website(legacy, path: str) -> None:
    resp = legacy.get(PREFIX + path)
    assert resp.status_code == 301
    assert resp.headers["location"] == HOME
    assert resp.headers["x-robots-tag"] == "noindex, nofollow"
    assert legacy.head(PREFIX + path).status_code == 301


def test_legacy_cli_login_page_moves_to_the_console(legacy) -> None:
    resp = legacy.get(f"{PREFIX}/cli/authorize?port=5&state=x")
    assert resp.status_code == 301
    assert resp.headers["location"] == f"{DEV}/cli/authorize?port=5&state=x"


def test_legacy_never_redirects_a_post_or_the_sign_in_callback(legacy) -> None:
    _publish(legacy)
    for path in ("/api/publish", "/publisher/claim", "/extensions/acme/hello/rating", "/logout"):
        assert legacy.post(PREFIX + path).status_code != 301, path
    callback = legacy.get(f"{PREFIX}/auth/callback")
    assert callback.status_code == 400
    assert callback.headers["x-robots-tag"] == "noindex, nofollow"


def test_legacy_robots_allows_until_told_otherwise(tmp_path, legacy) -> None:
    resp = legacy.get(f"{PREFIX}/robots.txt")
    assert resp.text == "User-agent: *\nAllow: /\n"
    assert resp.headers["x-robots-tag"] == "noindex, nofollow"
    closed = create_app(
        Settings(
            data_dir=tmp_path / "closed",
            root_path=PREFIX,
            store_origin=STORE,
            developer_origin=DEV,
            legacy_hosts=(LEGACY,),
            legacy_robots_disallow=True,
        )
    )
    resp = _client(closed, f"https://{LEGACY}").get(f"{PREFIX}/robots.txt")
    assert resp.text == "User-agent: *\nDisallow: /\n"


# -- any other host (health checks by IP, the container healthcheck) --------
def test_other_hosts_keep_single_host_behavior(app) -> None:
    other = _client(app, "http://10.0.0.5")
    assert other.get(f"{PREFIX}/api/health").json() == {"status": "ok"}
    assert other.get("/api/health").json() == {"status": "ok"}
    page = other.get(f"{PREFIX}/")
    assert page.status_code == 200
    assert page.headers["x-robots-tag"] == "noindex, nofollow"
    assert "rel=\"canonical\"" not in page.text


# -- settings -----------------------------------------------------------
def test_routing_off_leaves_responses_untouched(tmp_path) -> None:
    client = TestClient(create_app(Settings(data_dir=tmp_path)))
    resp = client.get("/")
    assert resp.status_code == 200
    assert "x-robots-tag" not in resp.headers
    assert "rel=\"canonical\"" not in resp.text
    assert client.get("/robots.txt").text == "User-agent: *\nAllow: /\n"


@pytest.mark.parametrize(
    "overrides",
    [
        {"store_origin": STORE},
        {"developer_origin": DEV},
        {"legacy_hosts": (LEGACY,)},
        {"store_origin": "http://marketplace.example.test", "developer_origin": DEV},
        {"store_origin": STORE + "/registry", "developer_origin": DEV},
        {"store_origin": STORE, "developer_origin": STORE},
        {"store_origin": STORE, "developer_origin": DEV, "legacy_hosts": ("marketplace.example.test",)},
        {"store_origin": STORE, "developer_origin": DEV, "legacy_redirect_to": "http://navide.dev/"},
    ],
)
def test_invalid_host_routing_settings_are_refused(tmp_path, overrides) -> None:
    with pytest.raises(ValueError):
        Settings(data_dir=tmp_path, **overrides)


def test_host_routing_settings_load_from_the_environment(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("REGISTRY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("REGISTRY_TRUST_PROFILE", "self-hosted-dev")
    monkeypatch.setenv("REGISTRY_STORE_ORIGIN", STORE + "/")
    monkeypatch.setenv("REGISTRY_DEVELOPER_ORIGIN", DEV)
    monkeypatch.setenv("REGISTRY_LEGACY_HOSTS", f"{LEGACY.upper()}, other.example.test")
    monkeypatch.setenv("REGISTRY_LEGACY_ROBOTS_DISALLOW", "true")
    settings = load_settings()
    assert settings.store_origin == STORE
    assert settings.developer_origin == DEV
    assert settings.legacy_hosts == (LEGACY, "other.example.test")
    assert settings.legacy_redirect_to == "https://navide.dev/"
    assert settings.legacy_robots_disallow is True
