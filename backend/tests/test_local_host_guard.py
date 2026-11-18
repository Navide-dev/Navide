"""Tests for the loopback boundary: Host allowlist, schema routes, /health.

A DNS-rebinding page makes itself same-origin with 127.0.0.1 and can then read
our responses — which is what turns an unauthenticated `/fs/raw` into a way to
read the ws token off disk. It cannot forge Host, so refusing a request whose
Host is not this server is what closes that path. These tests pin the three
things that go wrong quietly: a foreign Host getting through, a real caller
being refused, and the guard not reaching routes plugins append at startup.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from starlette.responses import PlainTextResponse
from starlette.routing import Route

from agent_team_backend import app as app_module
from agent_team_backend import ws_auth
from agent_team_backend.app import app


@pytest.fixture(autouse=True)
def ws_token():
    # The HTTP file routes share the ws token as their credential. Every test
    # here runs with one issued; the refusal tests then drop or corrupt it.
    ws_auth._reset_for_test("test-ws-token")
    yield "test-ws-token"
    ws_auth._reset_for_test("")


@pytest.fixture()
def client() -> TestClient:
    # No context manager: startup events (watchers/MCP) must not run in tests.
    return TestClient(app, base_url="http://127.0.0.1")


@pytest.fixture()
def rebinding_client() -> TestClient:
    """A client whose Host is a web origin, as a rebound page's would be."""
    return TestClient(app, base_url="http://evil.com")


@pytest.fixture()
def workspace(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "note.txt").write_text("hello")
    return ws


def test_a_rebinding_host_is_refused(rebinding_client, workspace) -> None:
    resp = rebinding_client.get(
        "/fs/raw", params={"workspace": str(workspace), "rel": "note.txt", "t": "test-ws-token"}
    )
    assert resp.status_code == 403


def test_a_loopback_host_still_serves(client, workspace) -> None:
    resp = client.get("/fs/raw", params={"workspace": str(workspace), "rel": "note.txt", "t": "test-ws-token"})
    assert resp.status_code == 200
    assert resp.content == b"hello"


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1:54321"])
def test_a_the_other_loopback_spellings_are_allowed(host, workspace) -> None:
    # A caller may reach us by name, or on a port that is not the one this
    # process picked — hook commands resolve the port at run time. Refusing
    # either would look like "the backend will not start" rather than like a
    # security control.
    named = TestClient(app, base_url=f"http://{host}")
    resp = named.get("/fs/raw", params={"workspace": str(workspace), "rel": "note.txt", "t": "test-ws-token"})
    assert resp.status_code == 200


@pytest.mark.parametrize(
    ("host_header", "allowed"),
    [
        ("127.0.0.1", True),
        ("127.0.0.1:54321", True),
        ("localhost", True),
        ("localhost:54321", True),
        ("[::1]", True),
        ("[::1]:54321", True),
        # An IP literal cannot be a DNS-rebinding vector (rebinding needs a
        # hostname the attacker controls), and this socket only listens on
        # loopback. A devcontainer on a Docker bridge reaches us through the
        # ssh reverse tunnel as its gateway address, so these must pass.
        ("172.17.0.1", True),
        ("172.17.0.1:54321", True),
        ("10.0.0.5:80", True),
        ("[fd00::1]:54321", True),
        ("LOCALHOST", True),
        ("evil.com", False),
        ("evil.com:80", False),
        ("172.17.0.1.evil.com", False),
        ("localhost.evil.com", False),
        ("127.0.0.1.evil.com", False),
        ("testserver", False),
        ("", False),
    ],
)
def test_a_host_header_rule(host_header, allowed) -> None:
    """The rule itself, since TestClient cannot express an IPv6 Host.

    starlette's TestClient splits netloc on ':' to find the port and raises on
    ``[::1]`` before a request is ever built, so the bracketed forms can only
    be covered here. Splitting by hand is the same mistake the parser avoids.
    """
    assert app_module.is_local_host_header(host_header) is allowed


def test_a_bridge_gateway_host_still_serves(workspace) -> None:
    """A devcontainer on a Docker bridge network arrives as Host: <gateway>."""
    bridged = TestClient(app, base_url="http://172.17.0.1:54321")
    resp = bridged.get("/fs/raw", params={"workspace": str(workspace), "rel": "note.txt", "t": "test-ws-token"})
    assert resp.status_code == 200


def test_a_schema_routes_are_gone(client) -> None:
    for path in ("/openapi.json", "/docs", "/redoc"):
        assert client.get(path).status_code == 404, path


def test_a_health_no_longer_leaks_the_account_name(client) -> None:
    body = client.get("/health").json()
    assert "backend_log" not in body
    # Kept: DebugModal's Info tab renders both of these.
    assert body["version"]
    assert body["started_at"]


def test_a_guard_covers_routes_plugins_append_at_startup(rebinding_client) -> None:
    """Plugin routes bypass FastAPI's dependency system — prove middleware doesn't.

    plugins/wiring.apply_routes appends a bare Starlette Route to app.router
    after import, so this asserts the behaviour rather than trusting the claim
    that middleware wraps the whole app.
    """
    route = Route(
        "/__test_plugin_route",
        endpoint=lambda request: PlainTextResponse("reached"),
        methods=["GET"],
    )
    app.router.routes.append(route)
    try:
        assert rebinding_client.get("/__test_plugin_route").status_code == 403
        local = TestClient(app, base_url="http://127.0.0.1")
        assert local.get("/__test_plugin_route").status_code == 200
    finally:
        app.router.routes.remove(route)
