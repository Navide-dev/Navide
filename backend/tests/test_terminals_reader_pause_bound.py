"""The PTY reader pause under a stalled WS drain is bounded.

_flush_output detaches the PTY reader while its drain is on the wire — the
backpressure that keeps a renderer which cannot absorb output from OOMing the
backend. Unbounded, that pause starves the CLI's stdin: its stdout write blocks
on the full PTY queue, it stops reading input, and every message written to it
sits in _in_buffers as "pty input blocked". These tests pin the bound and the
OOM guard that replaces it: the reader resumes after _READER_PAUSE_MAX_MS, a
stalled session drops its OLDEST buffered output at _BUF_CAP instead of
stopping the reader, and a session never has two drains on the wire at once.
"""

from __future__ import annotations

import asyncio
import logging
from types import SimpleNamespace

import pytest

from agent_team_backend import pane_log_writer
from agent_team_backend.terminals import (
    _BUF_CAP,
    _READER_PAUSE_MAX_MS,
    TerminalService,
)


class _FakeHandle:
    """Records reader pause/resume and accepts every input write."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.written = bytearray()

    def read(self, _n: int) -> bytes:
        raise BlockingIOError

    def write(self, data: bytes) -> int:
        self.written.extend(data)
        return len(data)

    def pause_reading(self) -> None:
        self.calls.append("pause")

    def resume_reading(self) -> None:
        self.calls.append("resume")

    def stop_reading(self) -> None:
        self.calls.append("stop")

    def close(self) -> None:
        self.calls.append("close")

    def watch_writable(self, loop, callback) -> None:
        pass

    def unwatch_writable(self) -> None:
        pass


class _GatedEmit:
    """An EventSink that only completes while `gate` is set.  Frames are
    recorded on entry, so `frames` is the order they were handed to the WS."""

    def __init__(self) -> None:
        self.gate = asyncio.Event()
        self.frames: list = []
        self.on_frame = None  # optional side effect once a frame is on the wire

    async def __call__(self, frame) -> None:
        self.frames.append(frame)
        await self.gate.wait()
        if self.on_frame is not None:
            self.on_frame(frame)
        await asyncio.sleep(0)  # a real send yields to the loop


def _make(emit, *, log_fp=None) -> tuple[TerminalService, SimpleNamespace, _FakeHandle]:
    svc = TerminalService(emit)
    handle = _FakeHandle()
    session = SimpleNamespace(
        id="t-pause",
        handle=handle,
        closed=False,
        pane_id="pane-1",
        sequence=0,
        output_log_fp=log_fp,
        agent_key="claude",
    )
    svc._sessions[session.id] = session
    return svc, session, handle


# A budget here bounds being STUCK; it is never a guess at how long the work
# takes. These tests push a 5 MB buffer out in 64 KB pieces and every piece
# costs one event loop iteration: milliseconds on an idle laptop, seconds on a
# CI runner that hands this process a slice at a time. A fixed wall-clock
# budget turns that difference into a red test, so the clock below is reset by
# progress — a frame handed to the WS, a byte drained, a drain task coming or
# going — and only a session that has stopped moving fails.
_NO_PROGRESS_S = 2.0
# Nothing here should livelock, but a test that keeps moving forever still has
# to fail rather than hang the suite.
_CAP_S = 30.0


def _progress(svc: TerminalService, session_id: str) -> tuple:
    """Everything that changes while output is still moving for a session."""
    session = svc._sessions.get(session_id)
    return (
        session.sequence if session is not None else -1,  # frames on the wire
        svc._out_buf_bytes.get(session_id, 0),
        len(svc._out_buffers.get(session_id) or ()),
        session_id in svc._drain_tasks,
    )


async def _while_moving(svc: TerminalService, session_id: str, done, what: str) -> None:
    """Poll until `done()`, failing only once the session stops moving."""
    last = _progress(svc, session_id)
    started = still_since = svc._loop.time()
    while not done():
        await asyncio.sleep(0.005)
        now = svc._loop.time()
        current = _progress(svc, session_id)
        if current != last:
            last, still_since = current, now
        elif now - still_since >= _NO_PROGRESS_S:
            raise AssertionError(f"{what} (nothing moved for {_NO_PROGRESS_S}s)")
        if now - started >= _CAP_S:
            raise AssertionError(f"{what} (still moving after {_CAP_S}s)")


async def _settle(svc: TerminalService, session_id: str) -> None:
    """Wait until no drain is on the wire and nothing is buffered."""
    await _while_moving(
        svc,
        session_id,
        lambda: session_id not in svc._drain_tasks
        and not svc._out_buffers.get(session_id),
        "drain never settled",
    )


async def _finish(svc: TerminalService, session_id: str, fut, what: str = "barrier"):
    """Await a resize barrier, failing only once its session stops moving."""
    await _while_moving(svc, session_id, fut.done, f"{what} never finished")
    return await fut


@pytest.mark.asyncio
async def test_reader_resumes_within_the_bound_while_emit_never_resolves():
    emit = _GatedEmit()  # gate never set: the WS never drains
    svc, session, handle = _make(emit)
    svc._out_buffers[session.id] = [b"payload"]
    svc._out_buf_bytes[session.id] = 7

    svc._flush_output(session)
    await asyncio.sleep(0)
    assert handle.calls == ["pause"]
    assert session.id in svc._pause_timers

    await asyncio.sleep(_READER_PAUSE_MAX_MS / 1000 + 0.2)
    assert handle.calls == ["pause", "resume"]
    assert session.id not in svc._pause_timers
    # The drain itself is still stuck on the WS.
    assert session.id in svc._drain_tasks

    # The reader came back on the timer, not on the drain: the drain never
    # finished, so its finally cannot be what resumed it.
    assert not svc._drain_tasks[session.id].done()

    svc._drain_tasks[session.id].cancel()


@pytest.mark.asyncio
async def test_reader_stays_paused_until_the_bound():
    emit = _GatedEmit()
    svc, session, handle = _make(emit)
    svc._out_buffers[session.id] = [b"payload"]
    svc._out_buf_bytes[session.id] = 7

    svc._flush_output(session)
    await asyncio.sleep(_READER_PAUSE_MAX_MS / 1000 * 0.5)
    # Sub-bound stalls keep the deliberate backpressure.
    assert handle.calls == ["pause"]

    svc._drain_tasks[session.id].cancel()
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_stalled_drain_drops_oldest_output_at_cap_and_warns_once(caplog):
    emit = _GatedEmit()
    svc, session, handle = _make(emit)
    chunk = b"x" * (256 * 1024)

    # First flush goes on the wire and stalls there.
    svc._absorb_output(session, b"first", 5)
    svc._flush_output(session)
    await asyncio.sleep(0)
    assert session.id in svc._drain_tasks

    with caplog.at_level(logging.WARNING):
        for _ in range(400):  # 100 MB while the WS is not draining
            svc._absorb_output(session, chunk, len(chunk))
            assert svc._out_buf_bytes[session.id] < _BUF_CAP
            assert sum(len(c) for c in svc._out_buffers[session.id]) == svc._out_buf_bytes[session.id]
        assert caplog.text.count("pty output dropped") == 1
        assert svc._out_dropped[session.id] > 0
        # Still exactly one drain for this session, and the reader was never
        # stopped for good.
        assert len(svc._drain_tasks) == 1
        assert "stop" not in handle.calls

        # The WS comes back: the stalled drain finishes, then flushes what was
        # kept, and the episode closes.
        emit.gate.set()
        await _settle(svc, session.id)
        assert session.id not in svc._out_dropped
        assert len(emit.frames) >= 2

        # A fresh stall overflows again and reports again.
        emit.gate.clear()
        svc._absorb_output(session, b"again", 5)
        svc._flush_output(session)
        await asyncio.sleep(0)
        for _ in range(400):
            svc._absorb_output(session, chunk, len(chunk))
        assert caplog.text.count("pty output dropped") == 2

    emit.gate.set()
    await _settle(svc, session.id)


@pytest.mark.asyncio
async def test_a_flush_during_an_inflight_drain_does_not_start_a_second_one():
    emit = _GatedEmit()
    svc, session, handle = _make(emit)

    svc._absorb_output(session, b"one", 3)
    svc._flush_output(session)
    await asyncio.sleep(0)
    first = svc._drain_tasks[session.id]

    # Both the debounce timer path and the forced-flush path land here while
    # the first drain is still on the wire.
    svc._absorb_output(session, b"two", 3)
    svc._flush_output(session)
    await asyncio.sleep(0)
    assert svc._drain_tasks[session.id] is first
    assert handle.calls.count("pause") == 1
    # Nothing was lost: the second chunk waits for the in-flight drain.
    assert svc._out_buffers[session.id] == [b"two"]

    emit.gate.set()
    await _settle(svc, session.id)
    assert len(emit.frames) == 2
    assert first.done()


@pytest.mark.asyncio
async def test_fast_drain_cancels_the_pause_timer():
    async def emit(_frame) -> None:
        return None

    svc, session, handle = _make(emit)
    svc._out_buffers[session.id] = [b"payload"]
    svc._out_buf_bytes[session.id] = 7
    svc._flush_output(session)
    await _settle(svc, session.id)
    assert handle.calls == ["pause", "resume"]
    assert session.id not in svc._pause_timers


@pytest.mark.asyncio
async def test_close_mid_drain_never_touches_the_fd_again():
    """After _close the fd is gone and its number may be reused; the drain's
    finally must not pause/resume (remove_reader/add_reader) on it."""
    emit = _GatedEmit()
    svc, session, handle = _make(emit)
    svc._absorb_output(session, b"first", 5)
    svc._flush_output(session)
    await asyncio.sleep(0)
    # More output queues behind the stalled drain.
    svc._absorb_output(session, b"later", 5)

    # Stand in for _close: it stops the reader, closes the fd and flushes —
    # which defers to the in-flight drain.
    session.closed = True
    handle.stop_reading()
    handle.close()
    svc._flush_output(session)
    closed_at = len(handle.calls)

    emit.gate.set()
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert session.id not in svc._drain_tasks
    assert handle.calls[closed_at:] == []
    assert session.id not in svc._out_buffers
    assert session.id not in svc._out_buf_bytes
    assert session.id not in svc._pause_timers


@pytest.mark.asyncio
async def test_drain_output_waits_for_the_inflight_drain():
    """The resize barrier: old-width bytes already on the wire must land
    before drain_output emits (and so before the ack that follows it)."""
    emit = _GatedEmit()
    svc, session, handle = _make(emit)
    svc._absorb_output(session, b"old-width", 9)
    svc._flush_output(session)
    await asyncio.sleep(0)
    svc._absorb_output(session, b"queued", 6)

    barrier = asyncio.ensure_future(svc.drain_output(session.id))
    await asyncio.sleep(0.05)
    assert not barrier.done()
    # Only the in-flight drain's frame has been handed to the WS.
    assert emit.frames == [emit.frames[0]] and emit.frames[0].endswith(b"old-width")

    emit.gate.set()
    await _finish(svc, session.id, barrier)
    # Everything is out, in order, and nothing is left for a later flush.
    assert len(emit.frames) == 2
    assert emit.frames[0].endswith(b"old-width")
    assert emit.frames[1].endswith(b"queued")
    assert not svc._out_buffers.get(session.id)


@pytest.mark.asyncio
async def test_dropped_output_leaves_one_gap_marker_in_the_log_mirror(tmp_path):
    emit = _GatedEmit()
    log_path = tmp_path / "out.log"
    with log_path.open("w", encoding="utf-8") as log_fp:
        svc, session, handle = _make(emit, log_fp=log_fp)
        chunk = b"x" * (256 * 1024)
        svc._absorb_output(session, b"before\n", 7)
        svc._flush_output(session)
        await asyncio.sleep(0)
        for _ in range(40):  # 10 MB against a 5 MB cap
            svc._absorb_output(session, chunk, len(chunk))
        dropped = svc._out_dropped[session.id]
        assert dropped > 0

        emit.gate.set()
        await _settle(svc, session.id)
        # The log is written on pane_log_writer's thread: wait for it before
        # the file closes.
        assert pane_log_writer.WRITER.drain()
    text = log_path.read_text(encoding="utf-8")
    marker = f"[navide: {dropped} bytes of output dropped]"
    assert text.count("[navide:") == 1
    assert text.index("before") < text.index(marker) < text.index("xxxx")
    # The live stream never carried it.
    assert not any(b"navide:" in f for f in emit.frames)


@pytest.mark.asyncio
async def test_resize_barrier_is_one_await_under_a_streaming_cli():
    """A CLI that never stops printing must not keep the resize waiting: the
    barrier awaits the drain already on the wire, then emits the remainder
    itself instead of chasing drain after drain."""
    emit = _GatedEmit()
    svc, session, handle = _make(emit)
    svc._absorb_output(session, b"old-width", 9)
    svc._flush_output(session)
    await asyncio.sleep(0)

    stop = asyncio.Event()

    async def producer() -> None:
        n = 0
        while not stop.is_set():
            n += 1
            svc._absorb_output(session, b"stream%d " % n, 8)
            await asyncio.sleep(0.002)

    pauses_seen: list[int] = []
    emit.on_frame = lambda _f: pauses_seen.append(handle.calls.count("pause"))
    feed = asyncio.ensure_future(producer())
    barrier = asyncio.ensure_future(svc.drain_output(session.id))
    await asyncio.sleep(0.05)
    assert not barrier.done()
    assert handle.calls.count("pause") == 1

    emit.gate.set()
    await _finish(svc, session.id, barrier)
    # Exactly the one drain that was in flight ran while the barrier was up;
    # the barrier emitted the rest itself.  Old-width bytes come first, and
    # nothing sneaked in ahead of what the barrier flushed.  (The barrier's
    # own finally may start the next drain for what streamed in meanwhile.)
    # Frames sent under the single in-flight drain: the drain's own plus the
    # barrier's; no second drain was started before all of them were out.
    barrier_frames = pauses_seen.count(1)
    assert barrier_frames >= 2
    assert pauses_seen[:barrier_frames] == [1] * barrier_frames
    assert emit.frames[0].endswith(b"old-width")
    assert not svc._resize_barriers[session.id].locked()

    # The stream keeps flowing afterwards: new-width output resumes batching.
    await asyncio.sleep(0.05)
    stop.set()
    await feed
    await _settle(svc, session.id)
    assert handle.calls.count("pause") >= 2
    assert len(emit.frames) > barrier_frames


@pytest.mark.asyncio
async def test_resize_barrier_survives_a_failing_drain():
    calls = 0

    async def emit(frame) -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("ws gone")

    svc, session, handle = _make(emit)
    svc._absorb_output(session, b"doomed", 6)
    svc._flush_output(session)
    await asyncio.sleep(0)
    svc._absorb_output(session, b"after", 5)

    await _finish(svc, session.id, asyncio.ensure_future(svc.drain_output(session.id)))
    assert calls == 2
    assert not svc._out_buffers.get(session.id)
    assert session.id not in svc._drain_tasks
    assert not svc._resize_barriers[session.id].locked()


@pytest.mark.asyncio
async def test_overlapping_resize_barriers_keep_drains_out_until_both_finish():
    """A drag sends several resizes in flight; the second barrier must not
    let a drain start while the first is still emitting, and vice versa."""
    emit = _GatedEmit()
    svc, session, handle = _make(emit)
    svc._absorb_output(session, b"old-width", 9)
    svc._flush_output(session)
    await asyncio.sleep(0)
    svc._absorb_output(session, b"queued", 6)

    first = asyncio.ensure_future(svc.drain_output(session.id))
    second = asyncio.ensure_future(svc.drain_output(session.id))
    await asyncio.sleep(0.02)
    assert not first.done() and not second.done()
    # Output keeps arriving and its debounce timers fire into the barrier.
    svc._absorb_output(session, b"more", 4)
    await asyncio.sleep(0.02)
    assert handle.calls.count("pause") == 1

    # Let the wire move one frame at a time: only barriers emit, no _drain.
    emit.gate.set()
    await _finish(svc, session.id, asyncio.gather(first, second), "barriers")
    assert handle.calls.count("pause") == 1
    # The first barrier flushed everything queued behind the drain in one
    # payload; the second found nothing left and emitted nothing.
    assert [f[-9:] for f in emit.frames] == [b"old-width", b"queuedmore"[-9:]]
    assert emit.frames[1].endswith(b"queuedmore")
    assert not svc._resize_barriers[session.id].locked()
    assert not svc._out_buffers.get(session.id)


@pytest.mark.asyncio
async def test_resize_barrier_writes_the_gap_marker_too(tmp_path):
    emit = _GatedEmit()
    log_path = tmp_path / "out.log"
    with log_path.open("w", encoding="utf-8") as log_fp:
        svc, session, handle = _make(emit, log_fp=log_fp)
        chunk = b"x" * (256 * 1024)
        svc._absorb_output(session, b"before\n", 7)
        svc._flush_output(session)
        await asyncio.sleep(0)
        for _ in range(40):
            svc._absorb_output(session, chunk, len(chunk))
        dropped = svc._out_dropped[session.id]
        assert dropped > 0

        barrier = asyncio.ensure_future(svc.drain_output(session.id))
        emit.gate.set()
        await _finish(svc, session.id, barrier)
        # The survivors went out through the barrier, not a _drain.
        assert handle.calls.count("pause") == 1
        # The barrier consumed the drop count, so no later flush marks the
        # same gap twice.  Consumed is 0 here and absent once a flush finds
        # nothing buffered — that pop rides a debounce timer, so which of the
        # two is on show is a race the drop count itself does not care about.
        assert not svc._out_dropped.get(session.id)
        assert pane_log_writer.WRITER.drain()  # see the test above
    text = log_path.read_text(encoding="utf-8")
    marker = f"[navide: {dropped} bytes of output dropped]"
    assert text.count("[navide:") == 1
    assert text.index("before") < text.index(marker) < text.index("xxxx")


@pytest.mark.asyncio
async def test_overlapping_resize_barriers_do_not_interleave_frames():
    """Two barriers past the same awaited drain must emit one after the
    other: output that lands while the first is mid-payload has to follow
    that payload, not slip in through the second."""
    emit = _GatedEmit()
    svc, session, handle = _make(emit)
    svc._absorb_output(session, b"old-width", 9)
    svc._flush_output(session)
    await asyncio.sleep(0)
    queued = b"q" * (100 * 1024)  # two WS pieces, so the barrier yields mid-payload
    svc._absorb_output(session, queued, len(queued))

    def reader_runs_during_send(frame) -> None:
        if len(frame) > 60_000:  # the first piece of the barrier's payload
            svc._absorb_output(session, b"late", 4)

    emit.on_frame = reader_runs_during_send
    first = asyncio.ensure_future(svc.drain_output(session.id))
    second = asyncio.ensure_future(svc.drain_output(session.id))
    await asyncio.sleep(0.02)
    emit.gate.set()
    await _finish(svc, session.id, asyncio.gather(first, second), "barriers")
    await _settle(svc, session.id)

    tails = [f[-4:] for f in emit.frames]
    assert tails == [b"idth", b"qqqq", b"qqqq", b"late"]


@pytest.mark.asyncio
async def test_held_barrier_on_a_stalled_emit_still_caps_the_buffer(caplog):
    """No _drain task exists while a barrier emits inline, yet the reader is
    running and every flush defers to the barrier — the cap must hold there
    too, or a stalled resize grows the buffer without bound."""
    emit = _GatedEmit()
    svc, session, handle = _make(emit)
    svc._absorb_output(session, b"old-width", 9)
    barrier = asyncio.ensure_future(svc.drain_output(session.id))
    await asyncio.sleep(0.02)
    assert not barrier.done()
    assert session.id not in svc._drain_tasks
    assert svc._resize_barriers[session.id].locked()

    chunk = b"x" * (256 * 1024)
    with caplog.at_level(logging.WARNING):
        for _ in range(40):  # 10 MB streamed while the barrier's emit is stuck
            svc._absorb_output(session, chunk, len(chunk))
            assert svc._out_buf_bytes[session.id] < _BUF_CAP
        assert caplog.text.count("pty output dropped") == 1
    assert session.id not in svc._drain_tasks

    emit.gate.set()
    await _finish(svc, session.id, barrier)
    await _settle(svc, session.id)
