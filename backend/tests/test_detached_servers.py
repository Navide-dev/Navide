"""Settings → Resource limits: servers left behind by panes.

An agent that starts a dev server with `nohup … &` from a short-lived shell
hands it to launchd within milliseconds — before any descendant snapshot can
see it — so no pane-close sweep can reach it. Every pane now carries a random
marker in its environment, which such a server inherits. Settings lists the
orphaned processes whose marker no live pane owns, on demand only, and stops
one only when the user asks, after checking it is still the same process.
Nothing is ever killed automatically.
"""

from __future__ import annotations

import os
import sys
from types import SimpleNamespace
from typing import Any

import psutil
import pytest

from agent_team_backend import detached_servers, resource_limits
from agent_team_backend.terminals import TerminalService

UID = 501


class FakeProc:
    def __init__(self, pid: int, *, ppid: int = 1, uid: int = UID, env: dict[str, str] | None = None,
                 created: float = 1000.0, cmd: list[str] | None = None, cwd: str = "/ws",
                 rss: int = 50 * 1024 * 1024, denied: bool = False) -> None:
        self.pid = pid
        self.info = {"pid": pid, "ppid": ppid, "uids": SimpleNamespace(real=uid),
                     "create_time": created, "cmdline": cmd or ["next-server"]}
        self._env = env or {}
        self._cwd = cwd
        self._rss = rss
        self._denied = denied
        self.terminated = False

    def environ(self) -> dict[str, str]:
        if self._denied:
            raise psutil.AccessDenied(self.pid)
        return dict(self._env)

    def cwd(self) -> str:
        return self._cwd

    def memory_info(self) -> Any:
        return SimpleNamespace(rss=self._rss)

    def ppid(self) -> int:
        return self.info["ppid"]

    def create_time(self) -> float:
        return self.info["create_time"]

    def terminate(self) -> None:
        self.terminated = True


def _mark(value: str) -> dict[str, str]:
    return {detached_servers.MARK_ENV: value}


def _find(procs: list[FakeProc], live: set[str]) -> list[dict[str, Any]]:
    return detached_servers.find(live, procs=lambda: procs, uid=UID)


def test_lists_orphans_whose_pane_is_gone() -> None:
    orphan = FakeProc(10, env=_mark("dead"), cmd=["next-server", "PORT=3000"], cwd="/repo")
    items = _find([orphan], live=set())
    assert items == [{
        "pid": 10, "started_at": 1000.0, "command": "next-server PORT=3000",
        "cwd": "/repo", "rss": 50 * 1024 * 1024,
    }]


def test_leaves_out_what_is_not_a_leftover() -> None:
    procs = [
        FakeProc(1, env=_mark("live-pane")),          # its pane is still open
        FakeProc(2, ppid=os.getpid(), env=_mark("dead")),  # still has a live parent
        FakeProc(3, uid=0, env=_mark("dead")),         # another user's
        FakeProc(4, env={}),                           # never in a Navide pane
        FakeProc(5, env=_mark("dead"), denied=True),   # environ unreadable
    ]
    assert _find(procs, live={"live-pane"}) == []


def test_stop_checks_identity_before_signalling() -> None:
    proc = FakeProc(10, env=_mark("dead"), created=1000.0)
    getter = lambda pid: proc  # noqa: E731

    refused = detached_servers.stop(10, 999.0, live=set(), get=getter)
    assert refused["ok"] is False and proc.terminated is False

    owned = detached_servers.stop(10, 1000.0, live={"dead"}, get=getter)
    assert owned["ok"] is False and proc.terminated is False

    done = detached_servers.stop(10, 1000.0, live=set(), get=getter)
    assert done == {"ok": True} and proc.terminated is True


def test_stop_of_a_gone_process_is_a_plain_refusal() -> None:
    def gone(pid: int) -> Any:
        raise psutil.NoSuchProcess(pid)

    assert detached_servers.stop(10, 1000.0, live=set(), get=gone)["ok"] is False


def _spawn(svc: TerminalService) -> Any:
    return svc.create(pane_id="p1", agent_key=None,
                      command=[sys.executable, "-c", "import time; time.sleep(5)"], cwd=".")


@pytest.mark.skipif(os.name == "nt", reason="POSIX PTY")
async def test_a_new_pane_carries_a_marker_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(resource_limits, "_settings_reader", dict)

    async def emit(_event: Any) -> None:
        pass

    svc = TerminalService(emit)
    session = _spawn(svc)
    try:
        assert session.metadata.get("pane_mark")
        assert session.metadata["pane_mark"] in svc.live_pane_marks()
    finally:
        await svc.kill(session.id)


@pytest.mark.skipif(os.name == "nt", reason="POSIX PTY")
async def test_turning_tracking_off_spawns_without_a_marker(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(resource_limits, "_settings_reader",
                        lambda: {resource_limits.TRACK_DETACHED_KEY: False})

    async def emit(_event: Any) -> None:
        pass

    svc = TerminalService(emit)
    session = _spawn(svc)
    try:
        assert not session.metadata.get("pane_mark")
    finally:
        await svc.kill(session.id)


# ── the WS surface Settings uses ───────────────────────────────────────────


class _WS:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class _Terminals:
    def live_pane_marks(self) -> set[str]:
        return {"live"}


def _host_session(authenticated: bool = True) -> Any:
    from agent_team_backend import app

    session = app.Session(_WS())  # type: ignore[arg-type]
    session.terminals = _Terminals()  # type: ignore[assignment]
    session.host_authenticated = authenticated
    return session


async def _call(session: Any, msg_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    from agent_team_backend import app

    await app.handle_message(session, {"id": "m1", "type": msg_type, "payload": payload})
    return session.websocket.sent[-1]


async def test_list_reports_leftovers_and_whether_tracking_is_on(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[set[str]] = []

    def fake_find(live: set[str], **_kw: Any) -> list[dict[str, Any]]:
        seen.append(live)
        return [{"pid": 10, "started_at": 1.0, "command": "vite", "cwd": "/r", "rss": 1}]

    monkeypatch.setattr(detached_servers, "find", fake_find)
    monkeypatch.setattr(resource_limits, "_settings_reader", dict)
    reply = await _call(_host_session(), "limits.detached.list", {})
    assert reply["payload"] == {"ok": True, "enabled": True, "items": [
        {"pid": 10, "started_at": 1.0, "command": "vite", "cwd": "/r", "rss": 1}]}
    assert seen == [{"live"}]


async def test_list_says_off_and_scans_nothing_when_tracking_is_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(detached_servers, "find", lambda *_a, **_k: pytest.fail("scanned while off"))
    monkeypatch.setattr(resource_limits, "_settings_reader",
                        lambda: {resource_limits.TRACK_DETACHED_KEY: False})
    reply = await _call(_host_session(), "limits.detached.list", {})
    assert reply["payload"] == {"ok": True, "enabled": False, "items": []}


async def test_a_failing_scan_answers_an_empty_list(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_a: Any, **_k: Any) -> list[dict[str, Any]]:
        raise RuntimeError("ps broke")

    monkeypatch.setattr(detached_servers, "find", boom)
    monkeypatch.setattr(resource_limits, "_settings_reader", dict)
    reply = await _call(_host_session(), "limits.detached.list", {})
    assert reply["payload"]["ok"] is True and reply["payload"]["items"] == []


async def test_stop_passes_identity_and_live_marks_through(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[int, float, set[str]]] = []

    def fake_stop(pid: int, started_at: float, *, live: set[str], **_kw: Any) -> dict[str, Any]:
        calls.append((pid, started_at, live))
        return {"ok": True}

    monkeypatch.setattr(detached_servers, "stop", fake_stop)
    reply = await _call(_host_session(), "limits.detached.stop", {"pid": 10, "started_at": 1.5})
    assert reply["payload"] == {"ok": True}
    assert calls == [(10, 1.5, {"live"})]


@pytest.mark.parametrize("msg_type", ["limits.detached.list", "limits.detached.stop"])
async def test_only_the_host_window_may_ask(msg_type: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(detached_servers, "stop", lambda *_a, **_k: pytest.fail("stopped for a stranger"))
    monkeypatch.setattr(detached_servers, "find", lambda *_a, **_k: pytest.fail("listed for a stranger"))
    reply = await _call(_host_session(authenticated=False), msg_type, {"pid": 10, "started_at": 1.0})
    assert reply["ok"] is False
