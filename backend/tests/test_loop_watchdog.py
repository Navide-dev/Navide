"""Loop-stall watchdog: does it name a stall the loop itself cannot report.

The point of the split design (issue #24) is that the reporter must not live on
the loop it watches, so every test here blocks the loop for real with
``time.sleep`` inside a coroutine and asserts the daemon thread still spoke.
"""

from __future__ import annotations

import asyncio
import logging
import re
import threading
import time

import pytest

from agent_team_backend import loop_watchdog


@pytest.fixture()
def fast_watchdog(monkeypatch: pytest.MonkeyPatch):
    """Same behaviour, test-scale timings."""
    monkeypatch.setattr(loop_watchdog, "TICK_INTERVAL_S", 0.02)
    monkeypatch.setattr(loop_watchdog, "STALL_THRESHOLD_S", 0.1)
    return loop_watchdog


class _Reports(logging.Handler):
    """Signals the watcher's reports about stalls inside _stall_loop."""

    def __init__(self) -> None:
        super().__init__()
        self.stalled = threading.Event()
        self.recovered = threading.Event()

    def emit(self, record: logging.LogRecord) -> None:
        message = record.getMessage()
        if "stalled for" in message and "_stall_loop" in message:
            self.stalled.set()
        elif "recovered" in message and self.stalled.is_set():
            # Only the recovery from this stall: an earlier stall's can be
            # reported after _stall_loop has begun blocking the loop.
            self.recovered.set()


@pytest.fixture()
def reports():
    handler = _Reports()
    logger = logging.getLogger("agent_team_backend.loop_watchdog")
    logger.addHandler(handler)
    yield handler
    logger.removeHandler(handler)


def _messages(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]


def _episodes(caplog: pytest.LogCaptureFixture) -> list[bool]:
    """One entry per stall reported inside _stall_loop: whether the watcher's
    next report was its recovery. Stalls reported anywhere else are left out:
    on a loaded machine the loop can really go 0.1 s without turning outside
    any test stall (one CI-like run did, before the tick task first ran), and
    such a stall comes with its own recovery. A stall reported twice in one
    episode still shows: its first report is not followed by a recovery."""
    messages = _messages(caplog)
    return [
        i + 1 < len(messages) and "recovered" in messages[i + 1]
        for i, message in enumerate(messages)
        if "stalled for" in message and "_stall_loop" in message
    ]


async def _stall_loop(
    reports: _Reports, seconds: float = 0.0, await_recovery: bool = True
) -> None:
    """Block the event-loop thread until the watcher has reported the stall,
    then ``seconds`` more, then let the loop turn again until the recovery is
    reported. A stall of fixed length could pass unseen by a watcher thread
    the machine schedules late."""
    reports.stalled.clear()
    reports.recovered.clear()
    assert reports.stalled.wait(30), "the watcher never reported the stall"
    time.sleep(seconds)
    deadline = time.monotonic() + 30
    while await_recovery and not reports.recovered.is_set():
        assert time.monotonic() < deadline, "the watcher never reported the recovery"
        await asyncio.sleep(0.01)


@pytest.mark.asyncio
async def test_stall_is_reported_with_the_loop_thread_stack(
    fast_watchdog, reports: _Reports, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.WARNING, logger="agent_team_backend.loop_watchdog")
    fast_watchdog.start(asyncio.get_running_loop())
    try:
        await asyncio.sleep(0.05)  # let the ticker stamp at least once
        await _stall_loop(reports)
    finally:
        await fast_watchdog.stop()

    # Only a stack of the *loop* thread, blocked in _stall_loop, counts: one
    # of any other thread would leave no stall here.
    stalls = [m for m in _messages(caplog) if "stalled for" in m and "_stall_loop" in m]
    assert len(stalls) == 1
    assert "test_loop_watchdog.py" in stalls[0]


@pytest.mark.asyncio
async def test_one_stall_logs_once_and_reports_recovery(
    fast_watchdog, reports: _Reports, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.WARNING, logger="agent_team_backend.loop_watchdog")
    fast_watchdog.start(asyncio.get_running_loop())
    try:
        await asyncio.sleep(0.05)
        # Long enough after the report for the watcher to poll many times.
        await _stall_loop(reports, 0.4)
    finally:
        await fast_watchdog.stop()

    assert _episodes(caplog) == [True]


class _LateEvent(threading.Event):
    """A stop event whose waits return late, as a watcher thread on a loaded
    machine does: every poll lands ``LATE_S`` after it should."""

    LATE_S = 0.6

    def wait(self, timeout: float | None = None) -> bool:
        result = super().wait(timeout)
        time.sleep(self.LATE_S)
        return result


@pytest.mark.asyncio
async def test_recovery_is_reported_when_the_watcher_wakes_late(
    fast_watchdog, reports: _Reports, caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The loop turned again (it ran stop()), so the stall is over whenever the
    # watcher gets to look. Judging that by the stamp's age when the thread
    # wakes dropped the report on CI's loaded Windows runner.
    caplog.set_level(logging.WARNING, logger="agent_team_backend.loop_watchdog")
    monkeypatch.setattr(fast_watchdog._watchdog, "_stop_requested", _LateEvent())
    fast_watchdog.start(asyncio.get_running_loop())
    try:
        await asyncio.sleep(0.05)
        await _stall_loop(reports, await_recovery=False)  # stop() follows at once
    finally:
        await fast_watchdog.stop()

    assert _episodes(caplog) == [True]


class _StopRaceEvent(threading.Event):
    """A watcher poll that times out just before stop() and runs again only
    well after it, as a thread descheduled at that moment does."""

    def wait(self, timeout: float | None = None) -> bool:
        result = super().wait(timeout)
        if not result:
            super().wait()  # until stop() has been requested
            time.sleep(loop_watchdog.STALL_THRESHOLD_S * 2)
        return result


@pytest.mark.asyncio
async def test_a_poll_that_lands_after_stop_reports_no_stall(
    fast_watchdog, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    # stop() cancels the tick task, so from then on the stamp ages without the
    # loop stalling; a poll that looks after that must not call it a stall.
    caplog.set_level(logging.WARNING, logger="agent_team_backend.loop_watchdog")
    monkeypatch.setattr(fast_watchdog._watchdog, "_stop_requested", _StopRaceEvent())
    fast_watchdog.start(asyncio.get_running_loop())
    await asyncio.sleep(0.1)
    await fast_watchdog.stop()

    assert _messages(caplog) == []


@pytest.mark.asyncio
async def test_rearms_after_recovery(
    fast_watchdog, reports: _Reports, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.WARNING, logger="agent_team_backend.loop_watchdog")
    fast_watchdog.start(asyncio.get_running_loop())
    try:
        await asyncio.sleep(0.05)
        await _stall_loop(reports, 0.2)
        await _stall_loop(reports, 0.2)  # reported only if the watcher re-armed
    finally:
        await fast_watchdog.stop()

    assert _episodes(caplog) == [True, True]


class _StallTimes(logging.Handler):
    """When each stall was reported, on the monotonic clock the probe uses."""

    def __init__(self) -> None:
        super().__init__()
        self.reports: list[tuple[float, float]] = []  # (reported at, stalled for)

    def emit(self, record: logging.LogRecord) -> None:
        found = re.search(r"stalled for ([\d.]+)s", record.getMessage())
        if found:
            self.reports.append((time.monotonic(), float(found.group(1))))


async def _probe_turns(turns: list[float]) -> None:
    """Record when the loop runs, every few ms, independently of the
    watchdog's own stamp: a gap between two turns is how long the loop
    really did not turn."""
    while True:
        turns.append(time.monotonic())
        await asyncio.sleep(0.005)


@pytest.mark.asyncio
async def test_healthy_loop_stays_silent(fast_watchdog) -> None:
    # A loaded machine can really keep the loop from turning for 0.1 s, and
    # the watchdog is right to say so. What must never happen is a stall
    # reported while the loop was turning: every report must fall on a gap
    # the probe measured of at least the threshold, less the watchdog's tick
    # interval (the stamp is up to one tick old when the loop stops).
    stall_times = _StallTimes()
    logger = logging.getLogger("agent_team_backend.loop_watchdog")
    logger.addHandler(stall_times)
    turns: list[float] = []
    probe = asyncio.create_task(_probe_turns(turns))
    await asyncio.sleep(0)
    fast_watchdog.start(asyncio.get_running_loop())
    try:
        await asyncio.sleep(0.3)
    finally:
        await fast_watchdog.stop()
        turns.append(time.monotonic())
        probe.cancel()
        logger.removeHandler(stall_times)

    least = fast_watchdog.STALL_THRESHOLD_S - fast_watchdog.TICK_INTERVAL_S
    gaps = [(a, b) for a, b in zip(turns, turns[1:]) if b - a >= least]
    for reported_at, stalled_for in stall_times.reports:
        # One decimal in the message: widen the window by its rounding.
        since = reported_at - stalled_for - 0.05
        assert any(a < reported_at and b > since for a, b in gaps), (
            f"stall reported at {reported_at:.3f} (for {stalled_for}s) while the "
            f"loop was turning; gaps >= {least:.2f}s: {gaps}"
        )


@pytest.mark.asyncio
async def test_stop_joins_the_watcher_thread(fast_watchdog) -> None:
    fast_watchdog.start(asyncio.get_running_loop())
    thread = fast_watchdog._watchdog._thread
    assert thread is not None and thread.daemon
    await fast_watchdog.stop()
    assert not thread.is_alive()
    assert fast_watchdog._watchdog._thread is None
