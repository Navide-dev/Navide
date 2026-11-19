"""A broadcast that has started reaches every window, whatever happens to the
task that asked for it, and one window that stops reading holds up nobody.

ws_endpoint cancels a closed connection's handler tasks. About fifty handlers
answer their requester and then tell every other window
(leftover-bugs-0243 report-c); a requester hanging up in between left the
other windows on stale state. And app.broadcast sent to each window in turn,
so a window that stopped reading held up the rest and the caller with them.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from agent_team_backend import app


class _Window:
    """A session as broadcast sees it: send_json, dead, tokens_watch."""

    def __init__(self, delay: float = 0.0, stuck: bool = False) -> None:
        self.delay = delay
        self.stuck = stuck
        self.dead = False
        self.tokens_watch = None
        self.navide_window = True
        self.ui_bus_ready = True
        self.got: list[str] = []
        self.started = asyncio.Event()

    async def send_json(self, event: dict[str, Any]) -> None:
        self.started.set()
        if self.stuck:
            await asyncio.Event().wait()
        if self.delay:
            await asyncio.sleep(self.delay)
        self.got.append(event["type"])


@pytest.fixture()
def windows(monkeypatch: pytest.MonkeyPatch) -> Any:
    sessions: set[Any] = set()
    monkeypatch.setattr(app, "_SESSIONS", sessions)
    monkeypatch.setattr(app, "_BROADCASTS", set(), raising=False)
    return sessions


async def test_a_requester_hanging_up_mid_broadcast_still_reaches_every_window(windows: set) -> None:
    slow, other = _Window(delay=0.2), _Window(delay=0.2)
    windows.update({slow, other})

    async def handler() -> None:
        # What a "respond, then broadcast" handler does.
        await app.broadcast(app.make_event("roles.changed", {}))

    task = asyncio.create_task(handler())
    await slow.started.wait()
    task.cancel()  # ws_endpoint's finally: the requester hung up
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.sleep(0.4)

    assert slow.got == ["roles.changed"]
    assert other.got == ["roles.changed"]
    assert not app._BROADCASTS  # the task removed itself


async def test_a_stuck_window_holds_up_neither_the_others_nor_the_caller(
    windows: set, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setattr(app, "BROADCAST_SEND_TIMEOUT_S", 0.3)
    stuck, healthy = _Window(stuck=True), _Window()
    windows.update({stuck, healthy})

    loop = asyncio.get_running_loop()
    started = loop.time()
    await app.broadcast(app.make_event("stages.changed", {}))
    took = loop.time() - started

    assert healthy.got == ["stages.changed"]
    assert stuck.got == []
    assert took < 1.0
    assert "timed out" in caplog.text


async def test_two_broadcasts_in_a_row_arrive_in_order(windows: set) -> None:
    window = _Window(delay=0.05)
    windows.add(window)

    await app.broadcast(app.make_event("first", {}))
    await app.broadcast(app.make_event("second", {}))

    assert window.got == ["first", "second"]


async def test_exclude_and_the_main_window_and_token_variants_go_the_same_way(windows: set) -> None:
    requester, plugin, main = _Window(), _Window(), _Window()
    plugin.navide_window = False
    windows.update({requester, plugin, main})

    await app.broadcast(app.make_event("a", {}), exclude=requester)
    await app.broadcast_main_windows(app.make_event("b", {}))
    plugin.tokens_watch = frozenset({"/ws"})
    main.tokens_watch = frozenset()
    requester.tokens_watch = frozenset({"*"})
    await app.broadcast_tokens_changed("/ws", snapshot={})

    assert requester.got == ["b", "tokens.notice"]
    assert plugin.got == ["a", "tokens.notice"]
    assert main.got == ["a", "b"]


async def test_past_the_cap_a_broadcast_is_delivered_in_the_callers_task(
    windows: set, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(app, "MAX_DETACHED_BROADCASTS", 1)
    window = _Window(delay=0.2)
    windows.add(window)

    first = asyncio.create_task(app.broadcast(app.make_event("first", {})))
    await window.started.wait()
    assert len(app._BROADCASTS) == 1
    await app.broadcast(app.make_event("second", {}))  # inline, not detached
    await first

    assert sorted(window.got) == ["first", "second"]
    assert not app._BROADCASTS


async def test_shutdown_lets_broadcasts_finish_then_cancels_the_stuck(windows: set) -> None:
    quick, stuck = _Window(delay=0.05), _Window(stuck=True)
    windows.update({quick, stuck})

    caller = asyncio.create_task(app.broadcast(app.make_event("late", {})))
    await stuck.started.wait()
    caller.cancel()
    await app.drain_broadcasts(timeout=0.3)

    assert quick.got == ["late"]
    assert not app._BROADCASTS


async def test_shutdown_waits_for_a_handler_running_past_its_requester(windows: set) -> None:
    """A handler finishing after a hang-up (ws_handlers._outlive_requester)
    is given the same deadline, along with the broadcast it ends in."""
    from agent_team_backend import ws_handlers

    window = _Window()
    windows.add(window)

    async def tail() -> None:
        await asyncio.sleep(0.05)
        await app.broadcast(app.make_event("after-write", {}))

    caller = asyncio.create_task(ws_handlers._outlive_requester(tail()))
    await asyncio.sleep(0)
    caller.cancel()
    await app.drain_broadcasts(timeout=1.0)

    assert window.got == ["after-write"]
    assert not ws_handlers._OUTLIVING_REQUESTER


async def test_shutdown_cancels_a_stuck_handler_tail_and_says_so(
    windows: set, caplog: pytest.LogCaptureFixture,
) -> None:
    import time

    from agent_team_backend import ws_handlers

    async def stuck() -> None:
        await asyncio.sleep(60)

    caller = asyncio.create_task(ws_handlers._outlive_requester(stuck()))
    await asyncio.sleep(0)
    caller.cancel()
    started = time.monotonic()
    with caplog.at_level("WARNING"):
        await app.drain_broadcasts(timeout=0.2)

    assert time.monotonic() - started < 1.0
    assert not ws_handlers._OUTLIVING_REQUESTER
    assert "still running" in caplog.text
