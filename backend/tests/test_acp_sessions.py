"""AcpSessionService and the acp.* requests, against tests/fake_acp_agent.py."""

from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import acp_sessions, acp_ws, pty_registry
from agent_team_backend.acp_sessions import AcpSessionService, AcpStartError
from agent_team_backend.cli_vendors.base import AcpLaunch

FAKE_AGENT = Path(__file__).with_name("fake_acp_agent.py")


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
    monkeypatch.setattr(acp_ws, "cli_vendor", lambda key: SimpleNamespace(acp=None, spawn_env_defaults=()))
    window = FakeWindow()

    await acp_ws.acp_create(window, "m1", "acp.create", {"agent_key": "aider", "pane_id": "p1", "cwd": str(tmp_path)})

    reply = window.result("m1")
    assert reply["ok"] is False and reply["error"]["code"] == "ACP_UNAVAILABLE"


async def test_requests_drive_a_session_and_its_events_reach_the_creating_window(
    fresh_service, monkeypatch, tmp_path,
) -> None:
    launch = AcpLaunch(argv=tuple(_argv("reply")))
    monkeypatch.setattr(acp_ws, "cli_vendor", lambda key: SimpleNamespace(acp=launch, spawn_env_defaults=()))
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

        other = FakeWindow()
        await acp_ws.acp_list(other, "m4", "acp.list", {"claim": True})
        assert [s["session_id"] for s in other.result("m4")["payload"]["sessions"]] == [created["session_id"]]

        await acp_ws.acp_kill(other, "m5", "acp.kill", {"session_id": created["session_id"]})
        assert other.result("m5")["ok"] is not False
        assert other.events("acp.state")[-1]["state"] == "exited"  # the claiming window now gets events
    finally:
        await acp_ws.shutdown()


# -- P4: what the rest of the backend reads of an ACP pane ------------------


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
    monkeypatch.setattr(acp_ws, "cli_vendor", lambda key: SimpleNamespace(acp=launch, spawn_env_defaults=()))
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
    monkeypatch.setattr(acp_ws, "cli_vendor", lambda key: SimpleNamespace(acp=launch, spawn_env_defaults=()))
    window = FakeWindow()

    await acp_ws.acp_create(window, "m1", "acp.create", {
        "agent_key": "opencode", "pane_id": "p1", "cwd": str(tmp_path), "output_log_file": "x.log",
    })

    assert window.result("m1")["error"]["code"] == "BAD_REQUEST"
    assert acp_ws.session_for_pane("p1") is None


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
    monkeypatch.setattr(acp_ws, "cli_vendor", lambda key: SimpleNamespace(acp=launch, spawn_env_defaults=()))
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
