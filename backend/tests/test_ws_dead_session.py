"""Dead WebSocket sessions must be pruned, not crashed into.

Observed 2026-07-16 (backend.log): after a client disconnected with 1001,
leftover fire-and-forget handler tasks kept sending on the closed socket
(`RuntimeError: Cannot call "send" once a close message has been sent`) and
broadcast spammed warnings for the dead session forever. send_json now marks
the session dead on the first send failure and later sends are silent no-ops;
broadcast prunes dead sessions; ws() cancels in-flight handler tasks on
disconnect.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import WebSocketDisconnect

from agent_team_backend import app as app_module
from agent_team_backend import ws_auth

# NOTE: always reference app_module attributes at call time (not from-imports):
# test_analyzer_routing.py reloads the app module mid-suite, which rebinds
# _SESSIONS / Session / broadcast to fresh objects.


class ClosedSocket:
    """Fake websocket whose send always fails like a closed starlette socket."""

    def __init__(self) -> None:
        self.send_attempts = 0

    async def send_json(self, data: dict) -> None:
        self.send_attempts += 1
        raise RuntimeError('Cannot call "send" once a close message has been sent.')


@pytest.fixture(autouse=True)
def _token(tmp_path, monkeypatch):
    """The route refuses a handshake with no token, so these tests need one.

    Isolated data dir so the token file lands in tmp rather than beside the
    real backend's.
    """
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path))
    ws_auth.issue_token()
    yield
    ws_auth._reset_for_test()


class ScriptedSocket:
    """Fake websocket: accepts, yields queued messages, then disconnects.

    Carries ``query_params`` and ``headers`` because the route now authorises
    the handshake before accepting it (see ws_auth). The token is the real one
    for this run — this test is about what happens when a live session drops
    mid-flight, and it can only get there by being let in first.
    """

    def __init__(self, messages: list[dict]) -> None:
        self._messages = list(messages)
        self.query_params = {"t": ws_auth.current_token()}
        self.headers: dict[str, str] = {}

    async def accept(self) -> None:
        pass

    async def close(self, code: int = 1000) -> None:
        pass

    async def receive_json(self) -> dict:
        if self._messages:
            return self._messages.pop(0)
        # Yield once so tasks spawned for earlier messages get to start
        # before the disconnect unwinds the receive loop.
        await asyncio.sleep(0)
        raise WebSocketDisconnect(1001)

    async def send_json(self, data: dict) -> None:
        pass


async def test_send_json_on_closed_socket_marks_dead_without_raising() -> None:
    sock = ClosedSocket()
    session = app_module.Session(sock)  # type: ignore[arg-type]
    app_module._SESSIONS.add(session)
    try:
        await session.send_json({"type": "x"})  # must not raise
        assert session.dead is True
        assert session not in app_module._SESSIONS
        assert sock.send_attempts == 1
    finally:
        app_module._SESSIONS.discard(session)


async def test_dead_session_send_json_is_silent_noop() -> None:
    sock = ClosedSocket()
    session = app_module.Session(sock)  # type: ignore[arg-type]
    await session.send_json({"type": "x"})
    await session.send_json({"type": "y"})
    # The second call must not touch the socket at all.
    assert sock.send_attempts == 1


class SuspendingClosedSocket:
    """Closed socket whose send yields once before failing.

    A real websocket.send_json awaits transport I/O, so it suspends mid-send.
    That suspension is what lets a whole swarm of producers pass the pre-lock
    dead guard before the first failure lands — a synchronous fake cannot
    reproduce the race.
    """

    def __init__(self) -> None:
        self.send_attempts = 0

    async def send_json(self, data: dict) -> None:
        self.send_attempts += 1
        await asyncio.sleep(0)  # yield: let queued producers pass the guard
        raise RuntimeError('Cannot call "send" once a close message has been sent.')


async def test_concurrent_sends_on_closed_socket_hit_it_once() -> None:
    """A disconnect swarm must collapse to a single send attempt.

    Observed 2026-07-23 (installed-app backend.log): after a disconnect,
    hundreds of already-scheduled producers (broadcast + PTY output pump) each
    passed the pre-lock `if self.dead` guard while dead was still False, then
    serialized on _send_lock and every one sent onto the closed socket, failed,
    and logged `ws send failed; marking session dead`. The flood saturated the
    event loop and pushed terminal.create past the frontend's 10 s timeout
    ("setup failed"). The post-lock re-check must let only the first through.
    """
    sock = SuspendingClosedSocket()
    session = app_module.Session(sock)  # type: ignore[arg-type]
    app_module._SESSIONS.add(session)
    try:
        await asyncio.gather(
            *(session.send_json({"type": "x", "n": i}) for i in range(50))
        )
        assert session.dead is True
        # Only the first coroutine reaches the socket; the other 49 re-check
        # dead under the lock and no-op instead of failing + logging.
        assert sock.send_attempts == 1
    finally:
        app_module._SESSIONS.discard(session)


async def test_peer_gone_is_not_logged_as_a_warning(caplog) -> None:
    """A disconnect is this path's documented outcome, not a fault.

    It used to log WARNING once per disconnect — with an empty tail, since
    these exceptions carry no message — which made it both the log's most
    numerous line and one that read like a truncated error.
    """
    sock = ClosedSocket()
    session = app_module.Session(sock)  # type: ignore[arg-type]
    app_module._SESSIONS.add(session)
    try:
        with caplog.at_level("DEBUG", logger="agent_team_backend"):
            await session.send_json({"type": "x"})
        assert session.dead is True
        assert [r for r in caplog.records if r.levelname == "WARNING"] == []
        debug = [r for r in caplog.records if r.levelname == "DEBUG"]
        assert any("ws peer gone" in r.getMessage() for r in debug)
        # The rendered line must name the failure instead of trailing off.
        assert any("RuntimeError" in r.getMessage() for r in debug)
    finally:
        app_module._SESSIONS.discard(session)


async def test_broadcast_prunes_dead_session() -> None:
    sock = ClosedSocket()
    session = app_module.Session(sock)  # type: ignore[arg-type]
    app_module._SESSIONS.add(session)
    try:
        await app_module.broadcast({"type": "event"})  # must not raise
        assert session.dead is True
        assert session not in app_module._SESSIONS
    finally:
        app_module._SESSIONS.discard(session)


async def test_disconnect_cancels_inflight_handler_tasks(monkeypatch) -> None:
    sessions: list[app_module.Session] = []
    handler_tasks: list[asyncio.Task] = []

    orig_session = app_module.Session

    class RecordingSession(orig_session):  # type: ignore[misc,valid-type]
        def __init__(self, websocket) -> None:
            super().__init__(websocket)
            sessions.append(self)

    async def slow_handler(session, msg) -> None:
        handler_tasks.append(asyncio.current_task())
        await asyncio.sleep(30)

    monkeypatch.setattr(app_module, "Session", RecordingSession)
    monkeypatch.setattr(app_module, "handle_message", slow_handler)

    await app_module.ws(ScriptedSocket([{"type": "anything"}]))  # type: ignore[arg-type]

    assert len(sessions) == 1
    session = sessions[0]
    assert session.dead is True
    assert session not in app_module._SESSIONS

    assert len(handler_tasks) == 1
    task = handler_tasks[0]
    with pytest.raises(asyncio.CancelledError):
        await task
    assert task.cancelled()


# ── Long-running analyzer work must be tracked like every other handler ───────
#
# analyzer.benchmark and analyzer.pull hand their work to a background task and
# answer immediately. Those two used to call create_task without keeping the
# result, so they were neither cancelled on disconnect nor reachable from
# anywhere — a benchmark could hold Ollama for up to 25s per task per installed
# model after its window was gone, broadcasting progress into an empty set.


class _TaskRecordingSession:
    """Just enough Session for a handler: the task set and send_json."""

    def __init__(self) -> None:
        self._handler_tasks: set[asyncio.Task] = set()
        self.sent: list[dict] = []

    async def send_json(self, data: dict) -> None:
        self.sent.append(data)


@pytest.mark.asyncio
async def test_benchmark_task_is_tracked_for_cancellation(monkeypatch) -> None:
    from agent_team_backend import ws_handlers

    running = asyncio.Event()

    async def slow_benchmark(progress_cb=None):  # noqa: ANN001, ANN202
        running.set()
        await asyncio.sleep(30)
        return []

    monkeypatch.setattr(app_module, "analyzer_benchmark", slow_benchmark)

    session = _TaskRecordingSession()
    await ws_handlers.analyzer_benchmark_h(session, "m1", "analyzer.benchmark", {})

    # The handler answers immediately; the work continues in the background.
    assert session.sent and session.sent[0]["payload"]["started"] is True
    await asyncio.wait_for(running.wait(), timeout=2)

    assert len(session._handler_tasks) == 1, "the background task must be tracked"
    task = next(iter(session._handler_tasks))

    # This is what ws()'s finally does on disconnect.
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert session._handler_tasks == set(), "done_callback must discard the finished task"


@pytest.mark.asyncio
async def test_pull_task_is_tracked_for_cancellation(monkeypatch) -> None:
    from agent_team_backend import ws_handlers

    running = asyncio.Event()

    async def slow_pull(name, base_url):  # noqa: ANN001, ANN202
        running.set()
        await asyncio.sleep(30)
        yield {}  # pragma: no cover - never reached

    monkeypatch.setattr(app_module, "_az_is_ollama", lambda: True)
    monkeypatch.setattr(app_module, "_az_base_url", lambda: "http://localhost:11434")
    monkeypatch.setattr(app_module, "_ollama_pull_model", slow_pull)

    session = _TaskRecordingSession()
    await ws_handlers.analyzer_pull(session, "m2", "analyzer.pull", {"name": "qwen2.5-coder"})

    assert session.sent and session.sent[0]["payload"]["started"] is True
    await asyncio.wait_for(running.wait(), timeout=2)

    assert len(session._handler_tasks) == 1, "the background task must be tracked"
    task = next(iter(session._handler_tasks))

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert session._handler_tasks == set(), "done_callback must discard the finished task"


@pytest.mark.asyncio
async def test_a_cancelled_benchmark_tells_the_other_windows_it_ended(monkeypatch) -> None:
    """Cancelled with the window that started it, the benchmark must still
    end the progress bar the other windows show (0.2.45 broadcast report)."""
    from agent_team_backend import ws_handlers

    running = asyncio.Event()
    events: list[dict] = []

    async def slow_benchmark(progress_cb=None):  # noqa: ANN001, ANN202
        running.set()
        await asyncio.sleep(30)
        return []

    async def broadcast(event, **_kwargs):  # noqa: ANN001, ANN202
        events.append(event)

    monkeypatch.setattr(app_module, "analyzer_benchmark", slow_benchmark)
    monkeypatch.setattr(app_module, "broadcast", broadcast)
    session = _TaskRecordingSession()
    await ws_handlers.analyzer_benchmark_h(session, "m1", "analyzer.benchmark", {})
    await asyncio.wait_for(running.wait(), timeout=2)
    task = next(iter(session._handler_tasks))
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert [(e["type"], e["payload"].get("cancelled")) for e in events] == [
        ("analyzer.benchmark_done", True),
    ]


@pytest.mark.asyncio
async def test_a_cancelled_pull_tells_the_other_windows_it_ended(monkeypatch) -> None:
    from agent_team_backend import ws_handlers

    running = asyncio.Event()
    events: list[dict] = []

    async def slow_pull(name, base_url):  # noqa: ANN001, ANN202
        running.set()
        await asyncio.sleep(30)
        yield {}  # pragma: no cover - never reached

    async def broadcast(event, **_kwargs):  # noqa: ANN001, ANN202
        events.append(event)

    monkeypatch.setattr(app_module, "_az_is_ollama", lambda: True)
    monkeypatch.setattr(app_module, "_az_base_url", lambda: "http://localhost:11434")
    monkeypatch.setattr(app_module, "_ollama_pull_model", slow_pull)
    monkeypatch.setattr(app_module, "broadcast", broadcast)
    session = _TaskRecordingSession()
    await ws_handlers.analyzer_pull(session, "m2", "analyzer.pull", {"name": "qwen2.5-coder"})
    await asyncio.wait_for(running.wait(), timeout=2)
    task = next(iter(session._handler_tasks))
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert len(events) == 1
    assert events[0]["type"] == "analyzer.pull_done"
    assert events[0]["payload"]["ok"] is False
    assert events[0]["payload"]["cancelled"] is True
