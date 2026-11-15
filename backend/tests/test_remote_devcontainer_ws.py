"""Remote pane terminal.create with a fake ``ssh`` on PATH: a real PTY, no
network, no Docker, nothing under ~/.ssh."""

from __future__ import annotations

import asyncio
import json
import os
import random
import stat
import sys
import textwrap
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

pytest.importorskip("fcntl")

from agent_team_backend import app, remote_devcontainer, remote_devcontainer_ws
from agent_team_backend import terminals as terminals_module
from agent_team_backend import ws_handlers
from agent_team_backend.mcp_server import wiring

# Plays the remote side: asks for the token with echo off, as remote_script
# does, then records what it got and what its argv/env looked like.
FAKE_SSH = textwrap.dedent(
    """\
    #!{python}
    import json, os, sys, termios
    out = os.environ.get("FAKE_SSH_OUT") or {out!r}
    fd = sys.stdin.fileno()
    attrs = termios.tcgetattr(fd)
    attrs[3] &= ~termios.ECHO
    termios.tcsetattr(fd, termios.TCSANOW, attrs)
    sys.stdout.buffer.write(b"\\x1b]7737;navide-token\\x07")
    sys.stdout.flush()
    token = sys.stdin.readline().rstrip("\\r\\n")
    with open(out, "w") as fp:
        json.dump({{"argv": sys.argv[1:], "token": token, "env": sorted(os.environ)}}, fp)
    print("REMOTE-READY", flush=True)
    sys.stdin.readline()
    """
)


class Socket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.dead = False

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


@pytest.fixture
def fake_ssh(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    bindir = tmp_path / "bin"
    bindir.mkdir()
    out = tmp_path / "ssh-out.json"
    script = bindir / "ssh"
    script.write_text(FAKE_SSH.format(python=sys.executable, out=str(out)), encoding="utf-8")
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setattr(wiring, "backend_port", lambda: 49161)
    return out


def _session(svc: Any) -> SimpleNamespace:
    sock = Socket()
    session = SimpleNamespace(
        terminals=svc, sent=sock.sent, send_json=sock.send_json, dead=False,
        _terminal_create_gates={}, _terminal_create_transactions={}, _terminal_create_tombstones=set(),
    )
    return session


def _payload(**over: Any) -> dict[str, Any]:
    payload = {
        "pane_id": "remote-pane-1",
        "agent_key": "claude",
        "command": "claude",
        "cwd": str(Path.home()),
        "cols": 80,
        "rows": 24,
        "metadata": {"auth_scope": "forged", "profile_id": "forged", "workspace_path": "/w"},
        "remote": {"host": "mac-mini-ubuntu", "container": "devc-navide-app", "network": {"mode": "host"}},
    }
    payload.update(over)
    return payload


async def _wait_for(path: Path, timeout: float = 10.0) -> dict[str, Any]:
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        if path.exists() and path.stat().st_size:
            return json.loads(path.read_text(encoding="utf-8"))
        await asyncio.sleep(0.05)
    raise AssertionError("fake ssh never received its token")


TRUSTED = [{"host": "mac-mini-ubuntu", "container": "devc-navide-app"}]


def _use_settings(monkeypatch: pytest.MonkeyPatch, settings: dict[str, Any]) -> None:
    async def read() -> dict[str, Any]:
        return settings

    monkeypatch.setattr(remote_devcontainer_ws, "_settings", read)


def test_refused_while_the_switch_is_off(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_settings(monkeypatch, {remote_devcontainer.TRUSTED_KEY: TRUSTED})

    async def run() -> list[dict[str, Any]]:
        created: list[Any] = []
        session = _session(SimpleNamespace(create=lambda **kw: created.append(kw)))
        await ws_handlers.terminal_create(session, "m1", "terminal.create", _payload())
        assert created == []
        return session.sent

    sent = asyncio.run(run())
    assert sent[-1]["error"]["code"] == "REMOTE_DISABLED"


def test_bad_host_is_refused_before_anything_spawns(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_settings(monkeypatch, {remote_devcontainer.SETTING_KEY: True, remote_devcontainer.TRUSTED_KEY: TRUSTED})
    monkeypatch.setattr(wiring, "backend_port", lambda: 49161)

    async def run() -> list[dict[str, Any]]:
        created: list[Any] = []
        session = _session(SimpleNamespace(create=lambda **kw: created.append(kw)))
        payload = _payload(remote={"host": "-oProxyCommand=x", "container": "c"})
        await ws_handlers.terminal_create(session, "m1", "terminal.create", payload)
        assert created == []
        return session.sent

    assert asyncio.run(run())[-1]["error"]["code"] == "BAD_REQUEST"


def test_remote_pane_gets_its_token_on_stdin_and_nothing_local(
    fake_ssh: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _use_settings(monkeypatch, {remote_devcontainer.SETTING_KEY: True, remote_devcontainer.TRUSTED_KEY: TRUSTED})
    secret_name = "ANTHROPIC" + "_API_KEY"
    monkeypatch.setenv(secret_name, "fake-" + str(random.randint(1, 9999)))
    monkeypatch.setenv("CODEX_HOME", "/tmp/should-not-pass")

    async def run() -> None:
        async def emit(_frame: Any) -> None:
            return None

        svc = terminals_module.TerminalService(emit)
        session = _session(svc)
        try:
            await ws_handlers.terminal_create(session, "m1", "terminal.create", _payload())
            response = session.sent[-1]
            assert response.get("error") is None, response
            body = response["payload"]
            assert body["remote"]["host"] == "mac-mini-ubuntu"
            term = svc.get(body["terminal_session_id"])
            assert term is not None
            assert term.metadata["remote"]["container"] == "devc-navide-app"
            # Forged provenance from the window is dropped.
            assert "auth_scope" not in term.metadata and "profile_id" not in term.metadata
            assert remote_devcontainer_ws.is_remote_pane("remote-pane-1")

            seen = await _wait_for(fake_ssh)
            token = wiring.caller_token("remote-pane-1")
            assert seen["token"] == token
            assert token not in " ".join(seen["argv"])
            assert "ObscureKeystrokeTiming=no" in seen["argv"]
            assert secret_name not in seen["env"] and "CODEX_HOME" not in seen["env"]
            assert "PATH" in seen["env"]
        finally:
            for tid in list(svc.list_session_ids()):
                app._PTY_OWNERS.pop(tid, None)
                await svc.kill(tid, force=True)
            wiring.release_pane_token("remote-pane-1")

    asyncio.run(run())


def test_failover_report_for_a_remote_pane_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(remote_devcontainer_ws, "is_remote_pane", lambda pane: pane == "rp")
    called: list[Any] = []
    monkeypatch.setattr(app, "quota_failover", SimpleNamespace(report=lambda p: called.append(p)), raising=False)

    async def run() -> list[dict[str, Any]]:
        session = _session(None)
        await ws_handlers.quota_failover_report(session, "m1", "quota_failover.report", {"pane_id": "rp"})
        return session.sent

    sent = asyncio.run(run())
    assert sent[-1]["error"]["code"] == "REMOTE_PANE"
    assert called == []


def test_mcp_account_switch_refuses_a_remote_pane(monkeypatch: pytest.MonkeyPatch) -> None:
    from agent_team_backend.mcp_server import server

    monkeypatch.setattr(remote_devcontainer_ws, "is_remote_pane", lambda pane: pane == "rp")
    rows: list[Any] = []
    log = SimpleNamespace(
        record_request=lambda **kw: rows.append(kw) or 7,
        finish=lambda *a, **kw: None,
    )
    monkeypatch.setattr(app, "account_switch_log", log, raising=False)
    monkeypatch.setattr(server, "_account_store_name", lambda pid: "acct")

    async def run() -> dict[str, Any]:
        return await server.request_account_switch("claude", "p1", source="mcp", who="x", pane_id="rp")

    result = asyncio.run(run())
    assert result["status"] == "refused"
    assert result["ok"] is False



def test_pane_record_keeps_the_remote_target_across_restore(tmp_path: Path) -> None:
    from agent_team_backend.projects import ProjectStore

    ws = str(tmp_path)
    store = ProjectStore()
    spec = remote_devcontainer.parse_remote(
        {"host": "mac-mini-ubuntu", "container": "devc-navide-app", "network": {"mode": "host"}})
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude", remote=spec)
    store.record_manual_pane_spawn(ws, pane_id="local", agent="claude")
    # A restore re-keys the record under a new id without resending the target.
    store.record_manual_pane_spawn(ws, pane_id="p2", previous_pane_id="p1", agent="claude")
    reloaded = {p.pane_id: p for p in ProjectStore().load_or_create(ws).panes}
    assert reloaded["p2"].remote == spec
    assert reloaded["local"].remote == {}


def test_manual_pane_spawn_refuses_a_malformed_remote_target(monkeypatch: pytest.MonkeyPatch) -> None:
    recorded: list[Any] = []
    monkeypatch.setattr(app, "project_store", SimpleNamespace(
        record_manual_pane_spawn=lambda *a, **kw: recorded.append(kw)), raising=False)

    async def run() -> list[dict[str, Any]]:
        session = _session(None)
        await ws_handlers.manual_pane_spawn(session, "m1", "manual_pane.spawn", {
            "workspace_path": "/w", "pane_id": "p", "agent": "claude",
            "remote": {"host": "-oProxyCommand=x", "container": "c"},
        })
        return session.sent

    assert asyncio.run(run())[-1]["error"]["code"] == "BAD_REQUEST"
    assert recorded == []


def test_a_target_the_user_never_opened_does_not_connect(monkeypatch: pytest.MonkeyPatch) -> None:
    # A pane record in the workspace database (which a cloned repository can
    # carry) names a host the user never chose in the dialog: no ssh at all.
    _use_settings(monkeypatch, {remote_devcontainer.SETTING_KEY: True, remote_devcontainer.TRUSTED_KEY: TRUSTED})
    monkeypatch.setattr(wiring, "backend_port", lambda: 49161)

    async def run() -> list[dict[str, Any]]:
        created: list[Any] = []
        session = _session(SimpleNamespace(create=lambda **kw: created.append(kw)))
        payload = _payload(remote={"host": "attacker.example", "container": "devc-navide-app"})
        await ws_handlers.terminal_create(session, "m1", "terminal.create", payload)
        assert created == []
        return session.sent

    error = asyncio.run(run())[-1]["error"]
    assert error["code"] == "REMOTE_UNTRUSTED"


def test_trust_records_names_only_newest_first(monkeypatch: pytest.MonkeyPatch) -> None:
    store: dict[str, Any] = {remote_devcontainer.SETTING_KEY: True,
                             remote_devcontainer.TRUSTED_KEY: [{"host": "old", "container": "c"}]}
    monkeypatch.setattr(app, "ui_settings_store", SimpleNamespace(
        get=lambda: dict(store), set=lambda updates: store.update(updates) or updates), raising=False)

    async def run() -> list[dict[str, Any]]:
        session = _session(None)
        await remote_devcontainer_ws.remote_trust(session, "m1", "remote_devcontainer.trust", {"remote": {
            "host": "mac-mini-ubuntu", "container": "devc-navide-app",
            "network": {"mode": "bridge", "gateway": "172.17.0.1"}}})
        return session.sent

    assert asyncio.run(run())[-1]["payload"] == {"trusted": True}
    assert store[remote_devcontainer.TRUSTED_KEY] == [
        {"host": "mac-mini-ubuntu", "container": "devc-navide-app"}, {"host": "old", "container": "c"}]


def test_trust_is_refused_while_off(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_settings(monkeypatch, {})

    async def run() -> list[dict[str, Any]]:
        session = _session(None)
        await remote_devcontainer_ws.remote_trust(session, "m1", "remote_devcontainer.trust", {"remote": {}})
        return session.sent

    assert asyncio.run(run())[-1]["error"]["code"] == "REMOTE_DISABLED"
