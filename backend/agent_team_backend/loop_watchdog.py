"""Event-loop stall detector.

Background (issue #24): a blocking syscall on a stalled cloud-sync mount froze
the whole backend for minutes, and the only way to see it was ``sample(1)`` on
a live process. A watchdog that logs the loop thread's stack the moment it
stops turning makes the same class of bug diagnosable in seconds.

The shape is forced by the failure it watches for: a watchdog implemented as an
asyncio task alone can never report a stall, because it is blocked by the very
thing it should describe. So the work is split — a task on the loop only stamps
a monotonic timestamp, and a separate daemon thread (still running while the
loop is wedged) decides that the stamp has gone stale and captures the loop
thread's stack via ``sys._current_frames()``.

Stdlib only — no new dependency to carry through PyInstaller.
"""

from __future__ import annotations

import asyncio
import logging
import sys
import threading
import time
import traceback

log = logging.getLogger("agent_team_backend.loop_watchdog")

#: How often the loop-side task refreshes its liveness stamp, and how often the
#: watcher thread checks it. Cheap: one monotonic() plus a sleep.
TICK_INTERVAL_S = 0.5

#: A stamp older than this means the loop is wedged, not merely busy. Well above
#: the tick interval so ordinary scheduling jitter never trips it.
STALL_THRESHOLD_S = 2.0

#: How long stop() waits for the watcher thread to notice the stop request.
_JOIN_TIMEOUT_S = 5.0


class _LoopWatchdog:
    def __init__(self) -> None:
        self._last_tick = 0.0
        self._loop_thread_id: int | None = None
        self._stop_requested = threading.Event()
        self._thread: threading.Thread | None = None
        self._task: asyncio.Task[None] | None = None

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        if self._thread is not None:
            return
        self._last_tick = time.monotonic()
        self._loop_thread_id = None
        self._stop_requested.clear()
        self._task = loop.create_task(self._tick_loop())
        self._thread = threading.Thread(
            target=self._watch, name="loop-watchdog", daemon=True
        )
        self._thread.start()

    async def stop(self) -> None:
        # stop() runs on the loop, so the loop is turning: stamp that before
        # the tick task is cancelled, for the watcher's last look.
        self._last_tick = time.monotonic()
        self._stop_requested.set()
        task, thread = self._task, self._thread
        self._task, self._thread = None, None
        if task is not None:
            task.cancel()
        if thread is not None:
            await asyncio.to_thread(thread.join, _JOIN_TIMEOUT_S)

    # ───────────────────────────── loop side ──────────────────────────────

    async def _tick_loop(self) -> None:
        """Stamp liveness from the loop thread. Never logs — it cannot: while
        the loop is stalled this coroutine is exactly what is not running."""
        self._loop_thread_id = threading.get_ident()
        try:
            while not self._stop_requested.is_set():
                self._last_tick = time.monotonic()
                await asyncio.sleep(TICK_INTERVAL_S)
        except asyncio.CancelledError:
            pass

    # ──────────────────────────── watcher side ────────────────────────────

    def _watch(self) -> None:
        """Watch the stamp from a plain thread, which keeps running while the
        loop is blocked. One WARNING per stall episode, re-armed on recovery."""
        stall_started_at: float | None = None
        # Tell a wedged loop from a process that is not running at all (a
        # starved VM: the 0.2.37 Windows check saw a 30.9 s "stall" with the
        # loop in a non-blocking recv). A late previous check means this
        # thread did not run either; process CPU near zero over the stall
        # means no thread did.
        previous_check = time.monotonic()
        healthy_cpu = stall_cpu = time.process_time()
        while not self._stop_requested.wait(TICK_INTERVAL_S):
            now = time.monotonic()
            last_tick = self._last_tick
            stalled_for = now - last_tick
            if self._stop_requested.is_set():
                # stop() landed after the poll timed out: the tick task is
                # cancelled and the stamp ages without the loop stalling.
                break
            if stalled_for >= STALL_THRESHOLD_S:
                if stall_started_at is None:
                    stall_started_at = last_tick
                    stall_cpu = healthy_cpu  # as of the last check the loop was turning
                    log.warning(
                        "event loop stalled for %.1fs (watchdog's previous check %.1fs earlier)"
                        " — loop thread stack:\n%s",
                        stalled_for, now - previous_check, self._loop_stack(),
                    )
            elif stall_started_at is not None:
                log.warning(
                    "event loop recovered after %.1fs stalled (process CPU %.1fs)",
                    last_tick - stall_started_at, time.process_time() - stall_cpu,
                )
                stall_started_at = None
            if stall_started_at is None:
                healthy_cpu = time.process_time()
            previous_check = now
        # A stop can land between the loop turning again and the next poll, so
        # settle a pending stall here rather than dropping the recovery report.
        # Any stamp newer than the stall means the loop turned again; the
        # stamp's age says only how late this thread woke up.
        if stall_started_at is not None:
            last_tick = self._last_tick
            if last_tick > stall_started_at:
                log.warning(
                    "event loop recovered after %.1fs stalled (process CPU %.1fs)",
                    last_tick - stall_started_at, time.process_time() - stall_cpu,
                )

    def _loop_stack(self) -> str:
        thread_id = self._loop_thread_id
        if thread_id is None:
            return "<loop thread not identified yet>"
        frame = sys._current_frames().get(thread_id)
        if frame is None:
            return "<loop thread frame unavailable>"
        return "".join(traceback.format_stack(frame))


_watchdog = _LoopWatchdog()


def start(loop: asyncio.AbstractEventLoop) -> None:
    """Begin watching *loop*. Idempotent while already running."""
    _watchdog.start(loop)


async def stop() -> None:
    """Stop the tick task and join the watcher thread."""
    await _watchdog.stop()
