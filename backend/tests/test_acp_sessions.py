"""AcpSessionService and the acp.* requests, against tests/fake_acp_agent.py."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import acp_sessions, acp_ws, pty_registry
from agent_team_backend.acp_sessions import AcpSessionService, AcpStartError
from agent_team_backend.acp_vendors import AcpLaunch

FAKE_AGENT = Path(__file__).with_name("fake_acp_agent.py")


@pytest.fixture(autouse=True)
def _windows_ci_fd_trace(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch):
    """Windows CI only: trace C runtime fds in test-results/ci/acp-fd-trace.log
    (uploaded with the backend diagnostics), to settle the Bad file descriptor
    INTERNALERROR pytest hit once on Windows CI after an ACP start test.

    Recorded: every os.close (fd, test, call stack — the full stack for one
    that came from neither the backend nor asyncio, and whether the garbage
    collector was running), every os.open / os.dup / os.dup2 /
    msvcrt.open_osfhandle (the fd it made and who asked), pytest's own
    stdout/stderr fds per test, and exceptions raised in __del__
    (sys.unraisablehook). It sees C runtime fds only: asyncio's Windows pipe
    handles are closed with CloseHandle (_overlapped / _winapi), which never
    passes through os.close."""
    if sys.platform != "win32" or not os.environ.get("CI"):
        yield
        return
    import gc
    import traceback

    trace = Path(__file__).resolve().parents[2] / "test-results" / "ci" / "acp-fd-trace.log"
    trace.parent.mkdir(parents=True, exist_ok=True)
    collecting = {"now": False}

    def write(line: str) -> None:
        with open(trace, "a", encoding="utf-8") as f:
            f.write(line + "\n")

    def stack(full: bool = False) -> str:
        frames = traceback.extract_stack(limit=30)[:-2]
        ours = [fr for fr in frames if "agent_team_backend" in fr.filename or "asyncio" in fr.filename
                or "subprocess" in fr.filename]
        shown = frames if full or not ours else ours
        return " | ".join(f"{Path(fr.filename).name}:{fr.lineno} {fr.name}" for fr in shown)

    def wrap(name: str, real, made_fd: bool):
        def traced(*args, **kwargs):
            if not made_fd:  # os.close: record, then always close
                try:
                    ours = any("agent_team_backend" in fr.filename or "asyncio" in fr.filename
                               for fr in traceback.extract_stack(limit=30)[:-1])
                    write(f"  {name} fd={args[0]} gc={collecting['now']} <- {stack(full=not ours)}")
                finally:
                    return real(*args, **kwargs)
            result = real(*args, **kwargs)
            try:
                write(f"  {name}{args[:2]!r} -> fd={result} gc={collecting['now']} <- {stack()}")
            except Exception:  # noqa: BLE001 — tracing never changes the call
                pass
            return result
        return traced

    def on_gc(phase: str, _info: dict) -> None:
        collecting["now"] = phase == "start"

    previous_hook = sys.unraisablehook

    def unraisable(hook_args) -> None:
        try:
            write(f"  __del__ raised {hook_args.exc_type.__name__}: {hook_args.exc_value} in {hook_args.object!r}")
        finally:
            previous_hook(hook_args)

    std = []
    for stream in ("stdout", "stderr"):
        try:
            std.append(f"{stream}={getattr(sys, stream).fileno()}")
        except Exception as err:  # noqa: BLE001
            std.append(f"{stream}=? ({err})")
    write(f"== {request.node.nodeid} [{', '.join(std)}]")
    monkeypatch.setattr(os, "close", wrap("close", os.close, made_fd=False))
    for name in ("open", "dup", "dup2"):
        monkeypatch.setattr(os, name, wrap(name, getattr(os, name), made_fd=True))
    import msvcrt

    monkeypatch.setattr(msvcrt, "open_osfhandle", wrap("open_osfhandle", msvcrt.open_osfhandle, made_fd=True))
    monkeypatch.setattr(sys, "unraisablehook", unraisable)
    gc.callbacks.append(on_gc)
    try:
        yield
    finally:
        gc.callbacks.remove(on_gc)
        write(f"-- end {request.node.nodeid}")


def _argv(scenario: str) -> list[str]:
    return [sys.executable, str(FAKE_AGENT), scenario]


class Events:
    def __init__(self) -> None:
        self.items: list[dict[str, Any]] = []

    async def __call__(self, event: dict[str, Any]) -> None:
        self.items.append(event)

    def of(self, kind: str) -> list[dict[str, Any]]:
        return [e["payload"] for e in self.items if e["type"] == kind]

    def states(self) -> list[str]:
        return [p["state"] for p in self.of("acp.state")]

    def texts(self) -> list[str]:
        return [
            p["update"]["content"]["text"] for p in self.of("acp.update")
            if p["update"]["sessionUpdate"] == "agent_message_chunk"
        ]


async def _until(pred, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not pred():
        if time.monotonic() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


def _alive(pid: int) -> bool:
    if sys.platform == "win32":
        from agent_team_backend import osplat

        return osplat.process_tree.is_alive(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:
        # A zombie (exited, not yet reaped by its parent) is not running.
        with open(f"/proc/{pid}/stat") as f:
            return f.read().split()[2] != "Z"
    except OSError:
        return True


@pytest.fixture
def registry(monkeypatch: pytest.MonkeyPatch) -> dict[str, list[int]]:
    calls: dict[str, list[int]] = {"register": [], "unregister": []}
    monkeypatch.setattr(pty_registry, "register", lambda pid, argv: calls["register"].append(pid))
    monkeypatch.setattr(pty_registry, "unregister", lambda pid: calls["unregister"].append(pid))
    return calls


@pytest.fixture
async def service(registry) -> Any:
    events = Events()
    svc = AcpSessionService(emit=events)
    svc.events = events  # type: ignore[attr-defined]
    yield svc
    await svc.kill_all()


async def test_a_session_starts_registers_and_opens(service, registry, tmp_path) -> None:
    session = await service.create(pane_id="p1", agent_key="fake", argv=_argv("reply"), cwd=str(tmp_path))

    assert session.acp_session_id == "s-1"
    assert session.state == "idle"
    assert service.events.states() == ["starting", "idle"]
    assert registry["register"] == [session.proc.pid]
    assert session.snapshot()["load_session"] is True


async def test_a_turn_streams_and_ends(service, tmp_path) -> None:
    session = await service.create(pane_id="p1", agent_key="fake", argv=_argv("reply"), cwd=str(tmp_path))

    assert await service.prompt(session.id, "hi") == "sent"
    await _until(lambda: service.events.of("acp.turn_end"))

    assert service.events.texts() == ["Hello", ", world"]
    assert service.events.of("acp.turn_end")[0]["stopReason"] == "end_turn"
    await _until(lambda: session.state == "idle")


async def test_a_prompt_during_a_turn_waits_for_it(service, tmp_path) -> None:
    session = await service.create(pane_id="p1", agent_key="fake", argv=_argv("cancel"), cwd=str(tmp_path))
    await service.prompt(session.id, "first")
    await _until(lambda: len(service.events.texts()) == 2)

    assert await service.prompt(session.id, "second") == "queued"
    assert await service.cancel(session.id) is True
    await _until(lambda: len(service.events.texts()) == 4)  # the second turn has started

    assert service.events.of("acp.turn_end")[0]["stopReason"] == "cancelled"
    assert session.state == "running" and session.queue == []


async def test_a_permission_request_waits_for_its_answer(service, tmp_path) -> None:
    session = await service.create(pane_id="p1", agent_key="fake", argv=_argv("permission"), cwd=str(tmp_path))
    await service.prompt(session.id, "write it")
    await _until(lambda: service.events.of("acp.permission"))
    asked = service.events.of("acp.permission")[0]

    assert [o["optionId"] for o in asked["options"]] == ["yes", "no"]
    assert session.snapshot()["permissions"][0]["request_id"] == asked["request_id"]
    with pytest.raises(ValueError):
        service.answer_permission(session.id, asked["request_id"], "maybe")
    assert service.answer_permission(session.id, asked["request_id"], "yes") is True
    await _until(lambda: service.events.of("acp.turn_end"))

    assert service.events.texts() == ['outcome={"outcome": "selected", "optionId": "yes"}']
    assert service.events.of("acp.permission_closed")[0]["request_id"] == asked["request_id"]


async def test_stopping_ends_the_agent_and_everything_it_started(service, registry, tmp_path, monkeypatch) -> None:
    pidfile = tmp_path / "pids"
    monkeypatch.setenv("ACP_FAKE_PIDFILE", str(pidfile))
    session = await service.create(pane_id="p1", agent_key="fake", argv=_argv("child"), cwd=str(tmp_path))
    await _until(pidfile.exists)
    agent, child = (int(p) for p in pidfile.read_text().split())

    await service.kill(session.id)

    await _until(lambda: not _alive(agent) and not _alive(child))
    assert registry["unregister"] == [session.proc.pid]
    assert service.get(session.id) is None
    assert service.events.states()[-1] == "exited"
    assert not service.events.of("acp.exit")  # stopped, not "exited on its own"


@pytest.mark.skipif(sys.platform == "win32", reason="SIGTERM is POSIX")
async def test_an_agent_that_ignores_eof_and_sigterm_is_still_ended(
    service, tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr(acp_sessions, "_DEFAULT_STOP_GRACE_S", 0.3)
    monkeypatch.setattr(acp_sessions, "_TERM_GRACE_S", 0.3)
    pidfile = tmp_path / "pids"
    monkeypatch.setenv("ACP_FAKE_PIDFILE", str(pidfile))
    session = await service.create(pane_id="p1", agent_key="fake", argv=_argv("stubborn"), cwd=str(tmp_path))
    await _until(pidfile.exists)
    agent, child = (int(p) for p in pidfile.read_text().split())

    await asyncio.wait_for(service.kill(session.id), 10)

    await _until(lambda: not _alive(agent) and not _alive(child))


async def test_an_agent_that_exits_on_its_own_says_so_with_its_stderr(service, tmp_path) -> None:
    session = await service.create(pane_id="p1", agent_key="fake", argv=_argv("exit"), cwd=str(tmp_path))
    await service.prompt(session.id, "x")
    await _until(lambda: service.events.of("acp.exit"))

    exited = service.events.of("acp.exit")[0]
    assert exited["code"] == 3
    assert "fatal: boom" in exited["stderr_tail"]
    assert service.get(session.id) is None


async def test_a_failed_handshake_stops_the_agent(service, registry, tmp_path) -> None:
    with pytest.raises(AcpStartError) as caught:
        await service.create(pane_id="p1", agent_key="fake", argv=_argv("version2"), cwd=str(tmp_path))

    assert caught.value.code == "acp-handshake-failed"
    assert service.list() == []
    assert registry["unregister"] == registry["register"]


async def test_a_program_that_cannot_start_is_refused(service, tmp_path) -> None:
    with pytest.raises(AcpStartError) as caught:
        await service.create(
            pane_id="p1", agent_key="fake", argv=[str(tmp_path / "no-such-agent")], cwd=str(tmp_path),
        )
    assert caught.value.code == "acp-start-failed"


async def test_loading_a_session_replays_it(service, tmp_path) -> None:
    session = await service.create(
        pane_id="p1", agent_key="fake", argv=_argv("reply"), cwd=str(tmp_path), load_session_id="s-1",
    )

    assert session.acp_session_id == "s-1"
    assert service.events.texts() == ["earlier answer"]


def test_the_agents_stderr_log_is_owner_only(tmp_path) -> None:
    if sys.platform == "win32":
        pytest.skip("POSIX file modes")

    async def run() -> int:
        svc = AcpSessionService(emit=Events())
        session = await svc.create(pane_id="p1", agent_key="fake", argv=_argv("reply"), cwd=str(tmp_path))
        mode = session.stderr_path.stat().st_mode & 0o777
        await svc.kill_all()
        return mode

    assert asyncio.run(run()) == 0o600


# ── acp.* requests ───────────────────────────────────────────────────────


class FakeWindow:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, message: dict[str, Any]) -> None:
        self.sent.append(message)

    def result(self, msg_id: str) -> dict[str, Any]:
        return next(m for m in self.sent if m.get("id") == msg_id)

    def events(self, kind: str) -> list[dict[str, Any]]:
        return [m["payload"] for m in self.sent if m.get("type") == kind]


@pytest.fixture
def fresh_service(registry, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(acp_ws, "_SERVICE", None)
    monkeypatch.setattr(acp_ws, "_OWNERS", {})
    # Each test stops what it started (acp_ws.shutdown in its finally).


async def test_a_vendor_without_acp_is_refused(fresh_service, monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(acp_ws, "acp_launch", lambda key: None)
    window = FakeWindow()

    await acp_ws.acp_create(window, "m1", "acp.create", {"agent_key": "aider", "pane_id": "p1", "cwd": str(tmp_path)})

    reply = window.result("m1")
    assert reply["ok"] is False and reply["error"]["code"] == "ACP_UNAVAILABLE"


async def test_requests_drive_a_session_and_its_events_reach_the_creating_window(
    fresh_service, monkeypatch, tmp_path,
) -> None:
    launch = AcpLaunch(argv=tuple(_argv("reply")))
    monkeypatch.setattr(acp_ws, "acp_launch", lambda key: launch)
    monkeypatch.setattr(acp_ws, "cli_vendor", lambda key: SimpleNamespace(spawn_env_defaults=()))
    window = FakeWindow()
    try:
        await acp_ws.acp_create(window, "m1", "acp.create", {"agent_key": "opencode", "pane_id": "p1", "cwd": str(tmp_path)})
        created = window.result("m1")["payload"]["session"]
        assert created["state"] == "idle" and created["acp_session_id"] == "s-1"

        await acp_ws.acp_prompt(window, "m2", "acp.prompt", {"session_id": created["session_id"], "text": "hi"})
        assert window.result("m2")["payload"] == {"status": "sent"}
        await _until(lambda: window.events("acp.turn_end"))
        assert [e["update"]["sessionUpdate"] for e in window.events("acp.update")] == ["agent_message_chunk"] * 2

        await acp_ws.acp_prompt(window, "m3", "acp.prompt", {"session_id": "nope", "text": "hi"})
        assert window.result("m3")["error"]["code"] == "ACP_NO_SESSION"

        # Another window sees none of it and may not take it (#586 review).
        other = FakeWindow()
        await acp_ws.acp_list(other, "m4", "acp.list", {"claim": True})
        assert other.result("m4")["payload"]["sessions"] == []
        await acp_ws.acp_kill(other, "m5", "acp.kill", {"session_id": created["session_id"]})
        assert other.result("m5")["error"]["code"] == "ACP_NOT_OWNER"

        await acp_ws.acp_list(window, "m6", "acp.list", {})
        assert [s["session_id"] for s in window.result("m6")["payload"]["sessions"]] == [created["session_id"]]
        await acp_ws.acp_kill(window, "m7", "acp.kill", {"session_id": created["session_id"]})
        assert window.result("m7")["ok"] is not False
        assert window.events("acp.state")[-1]["state"] == "exited"
    finally:
        await acp_ws.shutdown()


# -- #586 review: no process outlives a start; ownership like a PTY's -------------


async def test_a_start_cancelled_during_the_handshake_leaves_nothing_running(service, registry, tmp_path) -> None:
    task = asyncio.ensure_future(
        service.create(pane_id="p1", agent_key="fake", argv=_argv("slow_start"), cwd=str(tmp_path))
    )
    await _until(lambda: bool(registry["register"]))
    pid = registry["register"][0]

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    await _until(lambda: not _alive(pid))
    assert registry["unregister"] == [pid]
    assert service.list() == []


async def test_a_registration_failure_does_not_leave_a_true_orphan(service, monkeypatch, tmp_path) -> None:
    spawned: list[int] = []

    def fail(pid: int, argv: list[str]) -> None:
        spawned.append(pid)
        raise OSError("registry unwritable")

    monkeypatch.setattr(pty_registry, "register", fail)
    with pytest.raises(OSError):
        await service.create(pane_id="p1", agent_key="fake", argv=_argv("reply"), cwd=str(tmp_path))

    await _until(lambda: not _alive(spawned[0]))
    assert service.list() == []


@pytest.mark.skipif(sys.platform == "win32", reason="setsid breakaway is POSIX; the Windows Job holds the tree")
async def test_an_agent_that_exits_on_its_own_takes_its_breakaway_grandchild_with_it(service, tmp_path, monkeypatch) -> None:
    from agent_team_backend import terminals

    if not terminals._ps_snapshot():
        pytest.skip("no process table readable here (sandboxed run); CI reads one")
    pidfile = tmp_path / "pids"
    monkeypatch.setenv("ACP_FAKE_PIDFILE", str(pidfile))
    session = await service.create(pane_id="p1", agent_key="fake", argv=_argv("breakaway"), cwd=str(tmp_path))
    await _until(pidfile.exists)
    agent, child = (int(p) for p in pidfile.read_text().split())
    assert _alive(child)

    await service.prompt(session.id, "go")  # the agent exits on it, on its own
    await _until(lambda: service.events.of("acp.exit"))

    await _until(lambda: not _alive(agent) and not _alive(child))


async def test_a_prompt_sent_while_starting_waits_and_then_runs(service, tmp_path) -> None:
    session = await service.create(pane_id="p1", agent_key="fake", argv=_argv("reply"), cwd=str(tmp_path))
    session.state = "starting"
    assert await service.prompt(session.id, "early") == "queued"
    assert service.events.of("acp.turn_end") == []


class Window(FakeWindow):
    def __init__(self, window_id: str = "") -> None:
        super().__init__()
        self.window_id = window_id
        self.dead = False


@pytest.fixture
def launchable(fresh_service, monkeypatch) -> None:
    launch = AcpLaunch(argv=tuple(_argv("reply")))
    monkeypatch.setattr(acp_ws, "acp_launch", lambda key: launch)
    monkeypatch.setattr(acp_ws, "cli_vendor", lambda key: SimpleNamespace(spawn_env_defaults=()))
    monkeypatch.setattr(acp_ws, "_CREATORS", {})
    monkeypatch.setattr(acp_ws, "_OWNERLESS_SINCE", {})


async def _create(window: FakeWindow, tmp_path: Path, pane_id: str = "p1") -> str:
    await acp_ws.acp_create(window, "c", "acp.create", {"agent_key": "opencode", "pane_id": pane_id, "cwd": str(tmp_path)})
    return window.result("c")["payload"]["session"]["session_id"]


async def test_another_window_can_neither_see_nor_drive_nor_claim_a_session(launchable, tmp_path) -> None:
    a, b = Window("win-a"), Window("win-b")
    try:
        sid = await _create(a, tmp_path)

        await acp_ws.acp_list(b, "l", "acp.list", {"claim": True})
        assert b.result("l")["payload"]["sessions"] == []
        for kind, handler, extra in (
            ("acp.prompt", acp_ws.acp_prompt, {"text": "hi"}),
            ("acp.cancel", acp_ws.acp_cancel, {}),
            ("acp.permission_answer", acp_ws.acp_permission_answer, {"request_id": "r", "option_id": "x"}),
            ("acp.kill", acp_ws.acp_kill, {}),
        ):
            await handler(b, kind, kind, {"session_id": sid, **extra})
            assert b.result(kind)["error"]["code"] == "ACP_NOT_OWNER"
        assert acp_ws.get_service().get(sid) is not None  # still running, still a's

        # a goes away: still nobody else's to take.
        a.dead = True
        acp_ws.drop_owner(a)
        await acp_ws.acp_list(b, "l2", "acp.list", {"claim": True})
        assert b.result("l2")["payload"]["sessions"] == []
    finally:
        await acp_ws.shutdown()


async def test_the_creating_window_reconnecting_or_the_window_holding_the_pane_claims_it(launchable, monkeypatch, tmp_path) -> None:
    from agent_team_backend import agent_messaging

    a = Window("win-a")
    try:
        sid = await _create(a, tmp_path)
        a.dead = True
        acp_ws.drop_owner(a)

        again = Window("win-a")  # same page-load id: a reconnect
        await acp_ws.acp_list(again, "l", "acp.list", {"claim": True})
        assert [s["session_id"] for s in again.result("l")["payload"]["sessions"]] == [sid]
        await acp_ws.acp_prompt(again, "p", "acp.prompt", {"session_id": sid, "text": "hi"})
        assert again.result("p")["ok"] is True

        # A live owner is never displaced, even by the window that holds the pane.
        holder = Window("win-c")
        monkeypatch.setattr(agent_messaging, "owner_of", lambda pane_id: holder)
        await acp_ws.acp_list(holder, "l", "acp.list", {"claim": True})
        assert holder.result("l")["payload"]["sessions"] == []
        again.dead = True
        acp_ws.drop_owner(again)
        await acp_ws.acp_list(holder, "l2", "acp.list", {"claim": True})
        assert [s["session_id"] for s in holder.result("l2")["payload"]["sessions"]] == [sid]
    finally:
        await acp_ws.shutdown()


async def test_a_session_left_without_a_window_ends_after_the_ownerless_grace(launchable, tmp_path, caplog) -> None:
    from agent_team_backend import app

    a = Window("win-a")
    try:
        sid = await _create(a, tmp_path)
        a.dead = True
        acp_ws.drop_owner(a)
        start = acp_ws._OWNERLESS_SINCE[sid]

        caplog.set_level(logging.DEBUG, logger="agent_team_backend.acp_ws")
        assert await acp_ws.sweep_ownerless(now=start + app._OWNERLESS_GRACE_SEC - 1) == []
        ended = await acp_ws.sweep_ownerless(now=start + app._OWNERLESS_GRACE_SEC)
        # Seen as [] once on Linux CI with no cause in sight: show what the sweep logged.
        assert ended == [sid], (
            f"sweep ended {ended}; sessions {[(s.id, s.state, s.proc.returncode) for s in acp_ws.get_service().list()]};"
            f" owners {dict(acp_ws._OWNERS)}; ownerless {dict(acp_ws._OWNERLESS_SINCE)}; acp_ws log:\n{caplog.text}"
        )
        assert acp_ws.get_service().get(sid) is None
    finally:
        await acp_ws.shutdown()


async def test_on_its_own_exit_the_recorded_descendants_are_ended(service, tmp_path, monkeypatch) -> None:
    """The same, with the process table stubbed: what was recorded while the
    agent ran is what gets ended, even when the last record finds nothing."""
    from agent_team_backend import terminals

    records = iter([{4242: "id-4242"}])
    monkeypatch.setattr(terminals, "_descendant_pids", lambda pid: next(records, {}))
    ended: list[dict[int, str]] = []
    monkeypatch.setattr(terminals, "_kill_breakaway", lambda pids: ended.append(dict(pids)))

    session = await service.create(pane_id="p1", agent_key="fake", argv=_argv("exit"), cwd=str(tmp_path))
    await service.prompt(session.id, "x")
    # acp.exit goes first; the descendants are ended right after it.
    await _until(lambda: bool(ended))

    assert {4242: "id-4242"} in ended



async def test_the_ownerless_sweep_never_raises_into_the_janitor(launchable, monkeypatch) -> None:
    service = acp_ws.get_service()

    def broken() -> list[Any]:
        raise RuntimeError("boom")

    monkeypatch.setattr(service, "list", broken)
    assert await acp_ws.sweep_ownerless() == []


async def test_kill_ends_the_descendants_recorded_earlier_too(service, tmp_path, monkeypatch) -> None:
    from agent_team_backend import terminals

    ended: list[dict[int, str]] = []
    monkeypatch.setattr(terminals, "_descendant_pids", lambda pid: {})
    monkeypatch.setattr(terminals, "_kill_breakaway", lambda pids: ended.append(dict(pids)))
    session = await service.create(pane_id="p1", agent_key="fake", argv=_argv("reply"), cwd=str(tmp_path))
    session.descendants[4242] = "id-4242"  # seen while it ran, gone from the last snapshot

    await service.kill(session.id)

    assert {4242: "id-4242"} in ended


async def test_a_failing_registry_cleanup_still_reports_the_exit(launchable, monkeypatch, tmp_path) -> None:
    def broken(pid: int) -> None:
        raise OSError("registry unwritable")

    monkeypatch.setattr(pty_registry, "unregister", broken)
    window = Window("win-a")
    try:
        sid = await _create(window, tmp_path)
        await acp_ws.acp_kill(window, "k", "acp.kill", {"session_id": sid})

        assert window.events("acp.state")[-1]["state"] == "exited"
        assert acp_ws.get_service().get(sid) is None
        assert sid not in acp_ws._OWNERS and sid not in acp_ws._CREATORS
    finally:
        await acp_ws.shutdown()


async def test_an_agent_whose_child_holds_its_output_open_is_still_seen_to_exit(service, tmp_path, monkeypatch) -> None:
    """A child that inherited the agent's stdout keeps the pipe open after the
    agent exits; proc.wait() never returns then. The exit is still seen (the
    return code), the pane says so, and the child is ended with the group."""
    pidfile = tmp_path / "pids"
    monkeypatch.setenv("ACP_FAKE_PIDFILE", str(pidfile))
    session = await service.create(pane_id="p1", agent_key="fake", argv=_argv("orphan_pipe"), cwd=str(tmp_path))
    await _until(pidfile.exists)
    agent, child = (int(p) for p in pidfile.read_text().split())

    await service.prompt(session.id, "go")  # the agent exits; its child holds the pipe
    await _until(lambda: service.events.of("acp.exit"), timeout=10)

    # acp.exit, then the exited state as the session is forgotten.
    await _until(lambda: service.events.states()[-1:] == ["exited"], timeout=10)
    assert "idle" not in service.events.states()[service.events.states().index("running"):]
    await _until(lambda: not _alive(agent) and not _alive(child))
    assert service.list() == []


async def test_the_ownerless_deadline_is_not_lost_to_float_rounding(launchable, tmp_path, monkeypatch) -> None:
    """(since + 3600) - since is 3599.9999999999995 for this since: the sweep
    compares against the deadline instead, so the session is ended on time."""
    from agent_team_backend import app

    a = Window("win-a")
    try:
        sid = await _create(a, tmp_path)
        a.dead = True
        acp_ws.drop_owner(a)
        since = 700.685087237
        acp_ws._OWNERLESS_SINCE[sid] = since
        assert (since + app._OWNERLESS_GRACE_SEC) - since < app._OWNERLESS_GRACE_SEC  # the trap itself

        assert await acp_ws.sweep_ownerless(now=since + app._OWNERLESS_GRACE_SEC) == [sid]
    finally:
        await acp_ws.shutdown()


async def test_an_ended_agents_pipes_are_closed_now_not_by_the_garbage_collector(service, tmp_path, monkeypatch) -> None:
    """Killed, or exited on its own: its transport is closed explicitly (on
    POSIX asyncio may close it too once every pipe is gone; on Windows that is
    left to __del__, which is what this rules out)."""
    inside = {"now": False}
    by_us: dict[int, int] = {}  # id(transport) -> closes made inside _close_transport
    real = acp_sessions._close_transport

    def spy(proc: Any) -> None:
        inside["now"] = True
        try:
            real(proc)
        finally:
            inside["now"] = False

    def watch(proc: Any) -> None:
        transport = proc._transport  # noqa: SLF001
        original = transport.close

        def close() -> None:
            if inside["now"]:
                by_us[id(transport)] = by_us.get(id(transport), 0) + 1
            original()

        transport.close = close

    monkeypatch.setattr(acp_sessions, "_close_transport", spy)
    killed = await service.create(pane_id="p1", agent_key="fake", argv=_argv("reply"), cwd=str(tmp_path))
    watch(killed.proc)
    await service.kill(killed.id)
    exited = await service.create(pane_id="p2", agent_key="fake", argv=_argv("exit"), cwd=str(tmp_path))
    watch(exited.proc)
    await service.prompt(exited.id, "x")
    await _until(lambda: service.get(exited.id) is None)

    # Each transport was closed by _close_transport itself — not only by asyncio
    # closing it on its own once the pipes were done (POSIX), or by __del__.
    assert by_us.get(id(killed.proc._transport), 0) >= 1  # noqa: SLF001
    assert by_us.get(id(exited.proc._transport), 0) >= 1  # noqa: SLF001
    assert killed.proc._transport.is_closing() and exited.proc._transport.is_closing()  # noqa: SLF001


async def test_a_failed_start_closes_its_pipes_too(service, tmp_path, monkeypatch) -> None:
    closed: list[Any] = []
    real = acp_sessions._close_transport

    def spy(proc: Any) -> None:
        real(proc)
        closed.append(proc._transport)  # noqa: SLF001

    monkeypatch.setattr(acp_sessions, "_close_transport", spy)
    with pytest.raises(AcpStartError):
        await service.create(pane_id="p1", agent_key="fake", argv=_argv("version2"), cwd=str(tmp_path))

    assert closed and all(t.is_closing() for t in closed)


async def test_an_aborted_start_closes_its_pipes_even_with_the_process_still_running(service, monkeypatch, tmp_path) -> None:
    """The process outlived the abort's attempts to end it (stuck, a failed
    kill, a late watcher): its transport is still closed — which kills it."""
    from agent_team_backend import osplat

    spawned: list[int] = []
    closed: list[Any] = []
    real = acp_sessions._close_transport

    def spy(proc: Any) -> None:
        closed.append((proc, proc.returncode))
        real(proc)

    def fail_register(pid: int, argv: list[str]) -> None:
        spawned.append(pid)
        raise OSError("registry unwritable")

    async def no_wait(_proc: Any, _grace: float) -> None:
        return None

    monkeypatch.setattr(acp_sessions, "_close_transport", spy)
    monkeypatch.setattr(pty_registry, "register", fail_register)
    monkeypatch.setattr(osplat.process_tree, "end_contained", lambda pid, job: None)
    monkeypatch.setattr(osplat.process_tree, "kill_tree", lambda pid, force=True: None)
    monkeypatch.setattr(AcpSessionService, "_wait_exit", staticmethod(no_wait))

    with pytest.raises(OSError):
        await service.create(pane_id="p1", agent_key="fake", argv=_argv("reply"), cwd=str(tmp_path))

    assert len(closed) == 1
    proc, code_at_close = closed[0]
    assert code_at_close is None  # still running when its pipes were closed
    assert proc._transport.is_closing()  # noqa: SLF001
    await _until(lambda: not _alive(spawned[0]))  # and close() ended it



@pytest.fixture
def fake_jobs(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """contain() hands out fake job numbers and end_contained() records each
    job it is asked to close. On Windows closing a job is CloseHandle: a second
    close of the same value can close whatever handle reused it (pytest's own
    stdout went bad that way on Windows CI), so each job must be closed once.
    The tree is ended by pid underneath (no real handle is touched); with
    "kill" off the agent is left running, as a slow exit leaves it."""
    from agent_team_backend import osplat

    tree = osplat.process_tree
    real_end = tree.end_contained
    jobs = iter(range(1000, 2000))
    state: dict[str, Any] = {"closed": [], "kill": True, "pids": set()}
    monkeypatch.setattr(tree, "contain", lambda pid: next(jobs))

    def end(pid: int, job: int | None = None) -> None:
        state["closed"].append(job)
        state["pids"].add(pid)
        if state["kill"]:
            real_end(pid, None)

    monkeypatch.setattr(tree, "end_contained", end)
    return state


async def test_a_failed_start_closes_its_agents_job_once(service, registry, fake_jobs, monkeypatch, tmp_path) -> None:
    # The agent is still running after kill() has given up waiting (it ignores
    # stdin EOF and SIGTERM), so the start's own cleanup sees it running too.
    from agent_team_backend import osplat

    fake_jobs["kill"] = False
    monkeypatch.setattr(acp_sessions, "_stop_grace", lambda key: 0.2)
    monkeypatch.setattr(acp_sessions, "_TERM_GRACE_S", 0.2)
    pidfile = tmp_path / "pids"
    monkeypatch.setenv("ACP_FAKE_PIDFILE", str(pidfile))

    async def refused(self, client_info):
        await _until(pidfile.exists)
        raise acp_sessions.AcpProtocolError("protocol version 2")

    monkeypatch.setattr(acp_sessions.AcpClient, "initialize", refused)
    try:
        with pytest.raises(AcpStartError):
            await service.create(pane_id="p1", agent_key="fake", argv=_argv("stubborn"), cwd=str(tmp_path))
        assert fake_jobs["closed"] == [1000]
    finally:
        for pid in [*fake_jobs["pids"], *(int(p) for p in pidfile.read_text().split())]:
            with contextlib.suppress(OSError):
                osplat.process_tree.kill_tree(pid, force=True)


async def test_an_agent_killed_while_its_exit_is_reported_closes_its_job_once(registry, fake_jobs, tmp_path) -> None:
    events = Events()
    holder: dict[str, AcpSessionService] = {}

    async def emit(event: dict[str, Any]) -> None:
        await events(event)
        if event["type"] == "acp.exit":  # a window closing the pane right then
            await holder["svc"].kill(event["payload"]["session_id"])

    svc = holder["svc"] = AcpSessionService(emit=emit)
    try:
        session = await svc.create(pane_id="p1", agent_key="fake", argv=_argv("exit"), cwd=str(tmp_path))
        await svc.prompt(session.id, "x")
        await _until(lambda: events.of("acp.exit") and not svc._watchers)  # noqa: SLF001
        assert fake_jobs["closed"] == [1000]
    finally:
        await svc.kill_all()
