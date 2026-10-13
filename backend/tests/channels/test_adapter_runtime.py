from __future__ import annotations

import asyncio
import time

from agent_team_backend.channels import adapter_runtime
from agent_team_backend.channels.adapter_runtime import ReceiveLoop, ReconnectNow
from agent_team_backend.channels.base import AdapterStatus, backoff_delay


async def test_stop_ends_the_loop_even_if_a_cancel_is_swallowed() -> None:
    # A long-poll connect_once that loses one cancel the way anyio's connect_tcp
    # can, then keeps polling: stop must still end the receive task.
    swallowed: list[bool] = []

    async def connect_once() -> None:
        loop.mark_ready()
        while True:
            try:
                await asyncio.sleep(0.2)
            except asyncio.CancelledError:
                if swallowed:
                    raise
                asyncio.current_task().uncancel()
                swallowed.append(True)
            loop.touch()

    loop = ReceiveLoop("test", AdapterStatus(), connect_once, delay=lambda attempt: 0.01)
    loop.start()
    await asyncio.sleep(0.05)
    started = time.monotonic()
    # Not wait_for: a stop that swallows wait_for's own cancel returns normally.
    done, _ = await asyncio.wait({asyncio.ensure_future(loop.stop())}, timeout=3)
    assert done, "stop() did not return"
    assert time.monotonic() - started < 2
    assert swallowed and loop.status.lifecycle == "stopped"


async def test_a_connection_that_drops_right_after_ready_keeps_backing_off() -> None:
    # Matrix, Feishu, DingTalk and iMessage mark ready as soon as they connect.
    # A server that accepts and then drops at once must not pin the loop to the
    # first-step delay forever.
    attempts: list[int] = []

    async def connect_once() -> None:
        loop.mark_ready()
        raise ConnectionError("dropped")

    def delay(attempt: int) -> float:
        attempts.append(attempt)
        if len(attempts) >= 4:
            loop._stopping = True
        return 0.0

    loop = ReceiveLoop("test", AdapterStatus(), connect_once, delay=delay, stable_s=10.0)
    loop.start()
    await asyncio.wait_for(loop._task, timeout=3)
    assert attempts == [1, 2, 3, 4]


async def test_a_connection_that_stayed_up_starts_a_fresh_backoff_series() -> None:
    attempts: list[int] = []
    runs: list[int] = []

    async def connect_once() -> None:
        runs.append(1)
        loop.mark_ready()
        if len(runs) == 3:
            await asyncio.sleep(0.05)  # longer than stable_s: a healthy session
        raise ConnectionError("dropped")

    def delay(attempt: int) -> float:
        attempts.append(attempt)
        if len(attempts) >= 4:
            loop._stopping = True
        return 0.0

    loop = ReceiveLoop("test", AdapterStatus(), connect_once, delay=delay, stable_s=0.02)
    loop.start()
    await asyncio.wait_for(loop._task, timeout=3)
    assert attempts == [1, 2, 1, 2]


def test_backoff_starts_short_and_doubles_to_the_cap() -> None:
    # rand 0.5 is the jitter midpoint: no jitter.
    steps = [backoff_delay(n, 0.5) for n in range(1, 10)]
    assert steps == [5.0, 10.0, 20.0, 40.0, 80.0, 160.0, 320.0, 600.0, 600.0]
    assert 4.0 <= backoff_delay(1, 0.0) and backoff_delay(1, 0.999) <= 6.0


async def test_a_reconnect_request_after_a_stable_session_starts_a_fresh_backoff_series() -> None:
    attempts: list[int] = []
    runs: list[int] = []

    async def connect_once() -> None:
        runs.append(1)
        if len(runs) == 3:
            loop.mark_ready()
            await asyncio.sleep(0.05)  # longer than stable_s: a healthy session
            raise ReconnectNow("server asked to reconnect")
        raise ConnectionError("dropped")

    def delay(attempt: int) -> float:
        attempts.append(attempt)
        if len(attempts) >= 3:
            loop._stopping = True
        return 0.0

    loop = ReceiveLoop("test", AdapterStatus(), connect_once, delay=delay, stable_s=0.02)
    loop.start()
    await asyncio.wait_for(loop._task, timeout=3)
    assert attempts == [1, 2, 1]


async def test_reconnect_requests_in_a_row_are_spaced(monkeypatch) -> None:
    monkeypatch.setattr(adapter_runtime, "RECONNECT_NOW_MIN_S", 0.2, raising=False)
    starts: list[float] = []

    async def connect_once() -> None:
        starts.append(time.monotonic())
        if len(starts) >= 3:
            loop._stopping = True
        raise ReconnectNow("server asked to reconnect")

    loop = ReceiveLoop("test", AdapterStatus(), connect_once, delay=lambda attempt: 0.0)
    loop.start()
    await asyncio.wait_for(loop._task, timeout=3)
    assert len(starts) == 3
    assert starts[1] - starts[0] < 0.15  # the first request is honoured at once
    assert starts[2] - starts[1] >= 0.18  # one right after it waits
