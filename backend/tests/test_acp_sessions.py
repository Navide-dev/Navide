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


async def test_a_pane_closed_during_a_slow_start_stops_its_agent_at_once(service, registry, tmp_path) -> None:
    """Closing a pane must not wait for a cold start (acp.create can take minutes)."""
    task = asyncio.ensure_future(
        service.create(pane_id="p1", agent_key="fake", argv=_argv("slow_start"), cwd=str(tmp_path))
    )
    await _until(lambda: service.by_pane("p1") is not None)
    pid = service.by_pane("p1").proc.pid

    assert await service.abandon("p1") is True

    with pytest.raises(AcpStartError) as err:
        await asyncio.wait_for(task, 10)
    assert err.value.code == "acp-cancelled"
    assert not _alive(pid)
    assert registry["unregister"] == [pid]
    assert service.list() == []


async def test_a_pane_closed_before_its_agent_even_spawned_leaves_nothing_running(service, registry, tmp_path) -> None:
    task = asyncio.ensure_future(
        service.create(pane_id="p1", agent_key="fake", argv=_argv("reply"), cwd=str(tmp_path))
    )
    await asyncio.sleep(0)  # the start is under way; no process registered yet
    assert service.by_pane("p1") is None

    assert await service.abandon("p1") is True

    with pytest.raises(AcpStartError) as err:
        await asyncio.wait_for(task, 10)
    assert err.value.code == "acp-cancelled"
    assert len(registry["register"]) == 1
    assert not _alive(registry["register"][0])
    assert registry["unregister"] == registry["register"]
    assert service.list() == []


async def test_abandon_with_nothing_running_or_starting_is_a_no_op(service) -> None:
    assert await service.abandon("p1") is False
    # Nothing was remembered: a later start of the same pane is not cancelled.
    assert service._abandoned == set()


async def test_the_window_closes_a_starting_pane_by_pane_id(fresh_service, monkeypatch, tmp_path) -> None:
    launch = AcpLaunch(argv=tuple(_argv("slow_start")))
    monkeypatch.setattr(acp_ws, "acp_launch", lambda key: launch)
    monkeypatch.setattr(acp_ws, "cli_vendor", lambda key: SimpleNamespace(spawn_env_defaults=()))
    window = FakeWindow()
    try:
        creating = asyncio.ensure_future(
            acp_ws.acp_create(window, "m1", "acp.create", {"agent_key": "opencode", "pane_id": "p1", "cwd": str(tmp_path)})
        )
        await _until(lambda: acp_ws.get_service().by_pane("p1") is not None)

        await acp_ws.acp_kill(window, "m2", "acp.kill", {"pane_id": "p1"})
        assert window.result("m2")["payload"] == {"stopped": True}

        await asyncio.wait_for(creating, 10)
        assert window.result("m1")["error"]["code"] == "ACP_CANCELLED"
        assert acp_ws.get_service().list() == []
    finally:
        await acp_ws.shutdown()


async def test_two_starts_for_one_pane_both_end_when_it_is_closed(service, registry, tmp_path) -> None:
    """The closed mark must outlive the first start to end, or the second one runs on."""
    first = asyncio.ensure_future(
        service.create(pane_id="p1", agent_key="fake", argv=_argv("slow_start"), cwd=str(tmp_path))
    )
    second = asyncio.ensure_future(
        service.create(pane_id="p1", agent_key="fake", argv=_argv("slow_start"), cwd=str(tmp_path))
    )
    await _until(lambda: len(service.list()) == 2)

    assert await service.abandon("p1") is True  # stops one of them; both are marked
    for task in (first, second):
        with pytest.raises(AcpStartError) as err:
            await asyncio.wait_for(task, 10)
        assert err.value.code in ("acp-cancelled", "acp-handshake-failed")
    assert service.list() == []
    assert not any(_alive(pid) for pid in registry["register"])
    assert service._creating == {} and service._abandoned == set()


async def test_a_start_under_way_at_shutdown_never_leaves_its_agent_running(service, registry, tmp_path) -> None:
    task = asyncio.ensure_future(
        service.create(pane_id="p1", agent_key="fake", argv=_argv("reply"), cwd=str(tmp_path))
    )
    await asyncio.sleep(0)  # under way, nothing spawned yet

    await service.kill_all()

    with pytest.raises(AcpStartError) as err:
        await asyncio.wait_for(task, 10)
    assert err.value.code == "acp-cancelled"
    assert len(registry["register"]) == 1 and not _alive(registry["register"][0])
    assert service.list() == []


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


async def test_only_the_window_starting_a_pane_may_close_it_by_pane_id(fresh_service, monkeypatch, tmp_path) -> None:
    launch = AcpLaunch(argv=tuple(_argv("slow_start")))
    monkeypatch.setattr(acp_ws, "acp_launch", lambda key: launch)
    monkeypatch.setattr(acp_ws, "cli_vendor", lambda key: SimpleNamespace(spawn_env_defaults=()))
    window, stranger = FakeWindow(), FakeWindow()
    try:
        creating = asyncio.ensure_future(
            acp_ws.acp_create(window, "m1", "acp.create", {"agent_key": "opencode", "pane_id": "p1", "cwd": str(tmp_path)})
        )
        await _until(lambda: acp_ws.get_service().by_pane("p1") is not None)

        await acp_ws.acp_kill(stranger, "x", "acp.kill", {"pane_id": "p1"})
        assert stranger.result("x")["error"]["code"] == "ACP_NOT_OWNER"
        assert acp_ws.get_service().by_pane("p1") is not None

        await acp_ws.acp_kill(window, "m2", "acp.kill", {"pane_id": "p1"})
        assert window.result("m2")["payload"] == {"stopped": True}
        await asyncio.wait_for(creating, 10)
        assert acp_ws._STARTING == {}
    finally:
        await acp_ws.shutdown()


class Activity:
    def __init__(self) -> None:
        self.items: list[tuple[str, str, str, str]] = []

    async def __call__(self, session, kind: str, text: str, detail: str) -> None:
        self.items.append((session.pane_id, kind, text, detail))


async def test_a_turn_is_reported_as_activity_with_its_reply_text(registry, tmp_path) -> None:
    activity = Activity()
    svc = AcpSessionService(emit=Events(), on_activity=activity)
    try:
        session = await svc.create(pane_id="p1", agent_key="fake", argv=_argv("reply"), cwd=str(tmp_path))
        await svc.prompt(session.id, "hi")
        await _until(lambda: len(activity.items) == 2)

        assert activity.items == [
            ("p1", "agent_active", "", "acp:prompt"),
            ("p1", "turn_complete", "Hello, world", "end_turn"),
        ]
    finally:
        await svc.kill_all()


async def test_the_transcript_lands_in_the_panes_output_log(service, tmp_path) -> None:
    log_file = tmp_path / ".agent-team" / "manual" / "20261023" / "opencode-p1.log"
    session = await service.create(
        pane_id="p1", agent_key="fake", argv=_argv("reply"), cwd=str(tmp_path), output_log_file=str(log_file),
    )
    await service.prompt(session.id, "first line\nsecond line")
    await _until(lambda: service.events.of("acp.turn_end"))

    assert log_file.read_text(encoding="utf-8") == "> first line\n> second line\n\nHello, world\n\n"
    if sys.platform != "win32":
        assert log_file.stat().st_mode & 0o777 == 0o600


async def test_without_a_path_the_transcript_goes_to_the_log_dir(service, tmp_path) -> None:
    session = await service.create(pane_id="p1", agent_key="fake", argv=_argv("reply"), cwd=str(tmp_path))

    assert session.transcript_path is not None
    assert session.transcript_path.name == f"acp-transcript-{session.id}.log"


async def test_a_pane_finds_its_agent_and_the_sweep_sees_its_process(service, tmp_path) -> None:
    session = await service.create(pane_id="p1", agent_key="fake", argv=_argv("reply"), cwd=str(tmp_path))

    assert service.by_pane("p1") is session
    assert service.by_pane("p2") is None and service.by_pane("") is None
    groups = await asyncio.to_thread(service.pid_groups)
    assert groups[session.id][0] == "p1" and session.proc.pid in groups[session.id][1]

    await service.kill(session.id)
    assert service.by_pane("p1") is None
    assert await asyncio.to_thread(service.pid_groups) == {}


async def test_the_window_side_records_pane_activity_and_broadcasts_it(fresh_service, monkeypatch, tmp_path) -> None:
    from agent_team_backend import app

    launch = AcpLaunch(argv=tuple(_argv("reply")))
    monkeypatch.setattr(acp_ws, "acp_launch", lambda key: launch)
    monkeypatch.setattr(acp_ws, "cli_vendor", lambda key: SimpleNamespace(spawn_env_defaults=()))
    broadcasts: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kw: Any) -> None:
        broadcasts.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    window = FakeWindow()
    try:
        await acp_ws.acp_create(window, "m1", "acp.create", {"agent_key": "opencode", "pane_id": "pane-acp", "cwd": str(tmp_path)})
        sid = window.result("m1")["payload"]["session"]["session_id"]
        assert acp_ws.session_for_pane("pane-acp").id == sid

        await acp_ws.acp_prompt(window, "m2", "acp.prompt", {"session_id": sid, "text": "hi"})
        await _until(lambda: (app.pane_activity("pane-acp") or {}).get("event_type") == "turn_complete")

        assert app.pane_activity("pane-acp")["text"] == "Hello, world"
        activity = [e["payload"] for e in broadcasts if e["type"] == "agent.activity"]
        assert [(a["event_type"], a["text"], a["pane_id"]) for a in activity] == [
            ("agent_active", "", "pane-acp"), ("turn_complete", "Hello, world", "pane-acp"),
        ]
        assert activity[-1]["vendor"] == "opencode" and activity[-1]["detail"] == "end_turn"
    finally:
        await acp_ws.shutdown()
        app.forget_pane_activity("pane-acp")


async def test_a_relative_output_log_is_refused(fresh_service, monkeypatch, tmp_path) -> None:
    launch = AcpLaunch(argv=tuple(_argv("reply")))
    monkeypatch.setattr(acp_ws, "acp_launch", lambda key: launch)
    monkeypatch.setattr(acp_ws, "cli_vendor", lambda key: SimpleNamespace(spawn_env_defaults=()))
    window = FakeWindow()

    await acp_ws.acp_create(window, "m1", "acp.create", {
        "agent_key": "opencode", "pane_id": "p1", "cwd": str(tmp_path), "output_log_file": "x.log",
    })

    assert window.result("m1")["error"]["code"] == "BAD_REQUEST"
    assert acp_ws.session_for_pane("p1") is None


async def test_an_existing_transcript_is_tightened_and_odd_text_never_breaks_it(service, tmp_path) -> None:
    log_file = tmp_path / "pane.log"
    log_file.write_text("earlier\n", encoding="utf-8")
    if sys.platform != "win32":
        log_file.chmod(0o644)
    session = await service.create(
        pane_id="p1", agent_key="fake", argv=_argv("reply"), cwd=str(tmp_path), output_log_file=str(log_file),
    )

    acp_sessions._append_transcript(session, "lone \ud800 surrogate")

    assert log_file.read_text(encoding="utf-8").endswith("lone ? surrogate")
    if sys.platform != "win32":
        assert log_file.stat().st_mode & 0o777 == 0o600


async def test_the_resource_sweep_gains_a_row_per_acp_agent_and_nothing_else(fresh_service, monkeypatch, tmp_path) -> None:
    from agent_team_backend import process_cpu, process_memory

    sweep = {"panes": [{"terminal_session_id": "t1", "pane_id": "tui", "bytes": 10, "cpu_seconds": 1.0}], "total_bytes": 10, "available": True}
    assert await acp_ws.with_resource_rows(sweep) is sweep  # no ACP agent: untouched

    launch = AcpLaunch(argv=tuple(_argv("reply")))
    monkeypatch.setattr(acp_ws, "acp_launch", lambda key: launch)
    monkeypatch.setattr(acp_ws, "cli_vendor", lambda key: SimpleNamespace(spawn_env_defaults=()))
    monkeypatch.setattr(process_memory, "footprints", lambda pids: {pid: 100 for pid in pids})
    monkeypatch.setattr(process_cpu, "cpu_times", lambda pids: ({pid: 0.5 for pid in pids}, 1.0))
    window = FakeWindow()
    try:
        await acp_ws.acp_create(window, "m1", "acp.create", {"agent_key": "opencode", "pane_id": "pane-acp", "cwd": str(tmp_path)})
        result = await acp_ws.with_resource_rows(sweep)

        assert result["panes"][0] == sweep["panes"][0]
        [row] = result["panes"][1:]
        assert row["terminal_session_id"] == "" and row["pane_id"] == "pane-acp" and row["bytes"] >= 100
        assert result["total_bytes"] == 10 + row["bytes"]
        assert result["available"] is True
    finally:
        await acp_ws.shutdown()


async def test_a_failing_acp_sweep_leaves_the_terminal_panes_result_as_it_was(fresh_service, monkeypatch, tmp_path) -> None:
    sweep = {"panes": [{"terminal_session_id": "t1", "pane_id": "tui", "bytes": 10, "cpu_seconds": 1.0}], "total_bytes": 10}

    def broken() -> dict[str, tuple[str, list[int]]]:
        raise RuntimeError("process table unreadable")

    acp_ws.get_service()  # with none, the sweep returns before it measures anything
    monkeypatch.setattr(acp_ws, "pid_groups", broken)
    assert await acp_ws.with_resource_rows(sweep) is sweep


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


@pytest.fixture
def spawned_procs(monkeypatch: pytest.MonkeyPatch) -> list[asyncio.subprocess.Process]:
    """Every agent process acp_sessions spawns, to check its transport."""
    procs: list[asyncio.subprocess.Process] = []
    real = acp_sessions._spawn

    async def spawn(*args: Any, **kwargs: Any) -> asyncio.subprocess.Process:
        proc = await real(*args, **kwargs)
        procs.append(proc)
        return proc

    monkeypatch.setattr(acp_sessions, "_spawn", spawn)
    return procs


def _breakaway_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    # As psutil can on Windows: ending the leftovers raises another OSError.
    from agent_team_backend import terminals

    def fail(descendants: dict[int, str]) -> None:
        raise OSError("process table unreadable")

    monkeypatch.setattr(terminals, "_kill_breakaway", fail)


@pytest.mark.filterwarnings("error::ResourceWarning", "error::pytest.PytestUnraisableExceptionWarning")
async def test_a_failed_start_closes_the_pipes_even_when_ending_its_leftovers_fails(
    service, spawned_procs, fake_jobs, monkeypatch, tmp_path,
) -> None:
    # The agent outlives the tree's end (it ignores stdin EOF and SIGTERM), so
    # nothing but the explicit close shuts its transport (and the agent).
    from agent_team_backend import osplat

    fake_jobs["kill"] = False
    monkeypatch.setattr(acp_sessions, "_TERM_GRACE_S", 0.2)
    pidfile = tmp_path / "pids"
    monkeypatch.setenv("ACP_FAKE_PIDFILE", str(pidfile))

    def unwritable(pid: int, argv: list[str]) -> None:
        raise OSError("registry unwritable")

    monkeypatch.setattr(pty_registry, "register", unwritable)
    _breakaway_fails(monkeypatch)
    try:
        with pytest.raises(OSError):
            await service.create(pane_id="p1", agent_key="fake", argv=_argv("stubborn"), cwd=str(tmp_path))

        [proc] = spawned_procs
        assert proc._transport.is_closing()  # noqa: SLF001 — closed now, not by the collector
        await _until(lambda: not _alive(proc.pid))  # close() ended it
    finally:
        for pid in [*fake_jobs["pids"], *(int(p) for p in pidfile.read_text().split() if pidfile.exists())]:
            with contextlib.suppress(OSError):
                osplat.process_tree.kill_tree(pid, force=True)


@pytest.mark.filterwarnings("error::ResourceWarning", "error::pytest.PytestUnraisableExceptionWarning")
async def test_kill_closes_the_pipes_and_forgets_the_session_even_when_a_step_fails(
    service, spawned_procs, monkeypatch, tmp_path,
) -> None:
    session = await service.create(pane_id="p1", agent_key="fake", argv=_argv("reply"), cwd=str(tmp_path))
    _breakaway_fails(monkeypatch)

    with pytest.raises(OSError):
        await service.kill(session.id)

    [proc] = spawned_procs
    assert proc._transport.is_closing()  # noqa: SLF001
    assert service.get(session.id) is None
    assert service.events.states()[-1] == "exited"


async def test_a_start_whose_agent_already_exited_still_closes_its_job(service, fake_jobs, monkeypatch, tmp_path) -> None:
    # The agent exits between contain() and registration, and registration
    # fails: its job (and with it, on Windows, anything still in it) is ended.
    exited: list[int] = []

    def fail_once_gone(pid: int, argv: list[str]) -> None:
        deadline = time.monotonic() + 10
        while _alive(pid) and time.monotonic() < deadline:
            time.sleep(0.02)
        time.sleep(0.2)  # the loop has seen the exit by the time this fails
        exited.append(pid)
        raise OSError("registry unwritable")

    monkeypatch.setattr(pty_registry, "register", fail_once_gone)
    with pytest.raises(OSError):
        await service.create(pane_id="p1", agent_key="fake", argv=[sys.executable, "-c", "pass"], cwd=str(tmp_path))

    assert exited and fake_jobs["closed"] == [1000]


async def test_kill_closes_the_job_even_when_an_earlier_step_fails(service, fake_jobs, monkeypatch, tmp_path) -> None:
    from agent_team_backend import terminals

    session = await service.create(pane_id="p1", agent_key="fake", argv=_argv("reply"), cwd=str(tmp_path))

    def unreadable(pid: int) -> dict[int, str]:
        raise OSError("process table unreadable")

    monkeypatch.setattr(terminals, "_descendant_pids", unreadable)
    with pytest.raises(OSError):
        await service.kill(session.id)

    assert fake_jobs["closed"] == [1000]
    assert service.get(session.id) is None
    await _until(lambda: not _alive(session.proc.pid))


async def test_an_uncontained_agent_that_exited_is_never_ended_by_pid(service, monkeypatch, tmp_path) -> None:
    # On Windows contain() fails for an agent that has already exited (its job
    # cannot be assigned). Its pid may belong to another process by now, even
    # another pane's (whose job end_contained(pid, None) would close), so a
    # failed start ends nothing by pid for it. POSIX contain() never fails.
    from agent_team_backend import osplat

    calls: list[tuple] = []

    def no_job(pid: int) -> int:
        raise OSError("the process has exited")

    monkeypatch.setattr(osplat.process_tree, "contain", no_job)
    monkeypatch.setattr(osplat.process_tree, "end_contained", lambda pid, job=None: calls.append(("end_contained", pid, job)))
    monkeypatch.setattr(osplat.process_tree, "kill_tree", lambda pid, force=True: calls.append(("kill_tree", pid)))
    exited: list[int] = []

    def fail_once_gone(pid: int, argv: list[str]) -> None:
        deadline = time.monotonic() + 10
        while _alive(pid) and time.monotonic() < deadline:
            time.sleep(0.02)
        time.sleep(0.2)  # the loop has seen the exit by the time this fails
        exited.append(pid)
        raise OSError("registry unwritable")

    monkeypatch.setattr(pty_registry, "register", fail_once_gone)
    with pytest.raises(OSError):
        await service.create(pane_id="p1", agent_key="fake", argv=[sys.executable, "-c", "pass"], cwd=str(tmp_path))

    assert exited and calls == []
