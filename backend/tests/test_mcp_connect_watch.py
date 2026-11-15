"""A pane whose CLI never reached /plan-mcp is noticed (mcp_connect_watch).

2026-11-12: thirteen claude panes gave up their navide MCP connection during
a mass restore and nothing in Navide knew — the backend kept no record of
whether a pane's CLI had ever connected.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, mcp_connect_watch as watch
from agent_team_backend.mcp_server import server as plan_mcp, wiring as plan_mcp_wiring


@pytest.fixture(autouse=True)
def _clean() -> Any:
    agent_messaging._reset_for_test()
    watch._reset_for_test()
    yield
    agent_messaging._reset_for_test()
    watch._reset_for_test()


def _pane(pane_id: str = "p1", agent: str = "claude", *, realized: bool = True, wired: bool = True,
          status: str = "idle") -> None:
    agent_messaging.register(pane_id, f"name-{pane_id}", "/ws", agent, realized=realized)
    if wired:
        plan_mcp_wiring.caller_token(pane_id)
    agent_messaging.set_busy(pane_id, False, status)


def _connect(pane_id: str) -> None:
    """A /plan-mcp request carrying the pane's credential."""
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    ctx = SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))
    plan_mcp._resolve_caller(ctx)


def test_an_accepted_credential_records_the_connection() -> None:
    _pane()
    assert watch.last_connect("p1") is None

    _connect("p1")

    assert watch.last_connect("p1") is not None


def test_a_pane_up_three_minutes_without_a_connection_is_reported_once() -> None:
    _pane()
    assert watch.sweep(now=1000.0) == []
    assert watch.sweep(now=1000.0 + 179) == []
    assert watch.state("p1", now=1000.0 + 179) == ""

    newly = watch.sweep(now=1000.0 + 181)

    assert [e.pane_id for e in newly] == ["p1"]
    assert watch.state("p1", now=1000.0 + 181) == watch.STATE_NEVER_CONNECTED
    assert watch.sweep(now=1000.0 + 300) == []


def test_a_late_connection_clears_the_state() -> None:
    _pane()
    watch.sweep(now=0.0)
    watch.sweep(now=200.0)
    assert watch.state("p1", now=200.0) == watch.STATE_NEVER_CONNECTED

    _connect("p1")

    assert watch.state("p1", now=200.0) == ""


def test_the_clock_starts_when_the_cli_is_up_not_at_spawn() -> None:
    _pane(status="starting")
    watch.sweep(now=0.0)
    agent_messaging.set_busy("p1", False, "idle")
    watch.sweep(now=500.0)

    assert watch.state("p1", now=600.0) == ""
    assert watch.state("p1", now=681.0) == watch.STATE_NEVER_CONNECTED


def test_a_connection_under_a_former_id_counts() -> None:
    _pane("old")
    _connect("old")
    agent_messaging.unregister("old")
    _pane("new")
    agent_messaging.add_aliases("new", ["old"], "/ws")
    watch.sweep(now=0.0)

    assert watch.sweep(now=500.0) == []


@pytest.mark.parametrize("pane_id, kwargs", [
    ("q-aider", {"agent": "aider"}),        # not a vendor that dials at startup
    ("q-placeholder", {"realized": False}),  # a restore placeholder runs nothing
    ("q-unwired", {"wired": False}),         # no navide wiring to connect with
])
def test_panes_that_are_not_judged(pane_id: str, kwargs: dict[str, Any]) -> None:
    # Own ids: wiring tokens are process-wide, and one minted for "p1" by
    # another test would make an "unwired" p1 look wired.
    _pane(pane_id, **kwargs)
    watch.sweep(now=0.0)

    assert watch.sweep(now=500.0) == []
    assert watch.state(pane_id, now=500.0) == ""


@pytest.mark.asyncio
async def test_status_and_targets_report_it(monkeypatch: pytest.MonkeyPatch) -> None:
    _pane()
    monkeypatch.setattr(watch, "state", lambda pane_id, now=None: watch.STATE_NEVER_CONNECTED)
    entry = agent_messaging.current("p1")

    view = plan_mcp._target_view(entry, True)

    assert view["mcp"] == watch.STATE_NEVER_CONNECTED


def test_a_connected_target_carries_no_mcp_key() -> None:
    _pane()
    _connect("p1")

    assert "mcp" not in plan_mcp._target_view(agent_messaging.current("p1"), True)


@pytest.mark.asyncio
async def test_run_hands_each_new_pane_to_the_notifier(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    told: list[str] = []
    entry = agent_messaging.RegisteredPane(pane_id="p9", name="n9", workspace_path="/ws", agent_key="claude")
    sweeps = iter([[entry], []])
    monkeypatch.setattr(watch, "SWEEP_INTERVAL_S", 0)
    monkeypatch.setattr(watch, "sweep", lambda: next(sweeps, []))

    async def notify(e: agent_messaging.RegisteredPane) -> None:
        told.append(e.name)

    task = asyncio.create_task(watch.run(notify))
    for _ in range(5):
        await asyncio.sleep(0)
    task.cancel()

    assert told == ["n9"]


@pytest.mark.parametrize("lang", ["zh-TW", "en-US", "ja-JP", "zh-CN", "ko-KR", "es-ES",
                                  "fr-FR", "de-DE", "pt-BR", "ru-RU", "vi-VN"])
def test_the_chat_notice_exists_in_every_language(lang: str) -> None:
    from agent_team_backend.channels import quick_menu

    text = quick_menu.text(lang, "mcp_never_connected", pane="開發-甲")
    assert "開發-甲" in text and "/mcp" in text


@pytest.mark.asyncio
async def test_the_notifier_tells_the_windows_and_the_chats(monkeypatch: pytest.MonkeyPatch) -> None:
    from agent_team_backend import app
    from agent_team_backend import channels

    events: list[dict[str, Any]] = []
    chats: list[str] = []

    async def broadcast(event: dict[str, Any]) -> None:
        events.append(event)

    class Manager:
        async def notify_mcp_never_connected(self, pane: str) -> None:
            chats.append(pane)

    monkeypatch.setattr(app, "broadcast", broadcast)
    monkeypatch.setattr(channels, "get_manager", lambda: Manager())
    entry = agent_messaging.RegisteredPane(pane_id="p9", name="n9", workspace_path="/ws", agent_key="claude")

    await app._notify_mcp_never_connected(entry)

    assert events[0]["type"] == "mcp.never_connected"
    assert events[0]["payload"] == {"pane_id": "p9", "name": "n9", "workspace_path": "/ws", "agent_key": "claude"}
    assert chats == ["n9"]


def test_a_reported_pane_that_connects_is_cleared_once() -> None:
    _pane()
    watch.sweep(now=0.0)
    assert [e.pane_id for e in watch.sweep(now=200.0)] == ["p1"]
    _connect("p1")

    watch.sweep(now=230.0)

    assert watch.take_cleared() == ["p1"]
    assert watch.take_cleared() == []


# ── connected, then dropped (2026-11-15) ─────────────────────────────────────
# The loop stalled 360 s and 188 s; Claude Code's GET stream to /plan-mcp
# broke, its five reconnect attempts failed and it gave up. 65 of 66 panes sat
# without Navide tools and the watch, which knew only that they had connected
# once, said nothing.


def _connected_with_stream(pane_id: str = "p1") -> None:
    _pane(pane_id)
    _connect(pane_id)
    watch.stream_opened(pane_id)


def test_a_pane_whose_stream_closed_and_never_came_back_is_disconnected_once() -> None:
    _connected_with_stream()
    watch.stream_closed("p1", now=1000.0)
    assert watch.sweep_dropped(now=1000.0 + 89) == []
    assert watch.state("p1", now=1000.0 + 89) == ""

    newly = watch.sweep_dropped(now=1000.0 + 91)

    assert [e.pane_id for e in newly] == ["p1"]
    assert watch.state("p1", now=1000.0 + 91) == watch.STATE_DISCONNECTED
    assert watch.sweep_dropped(now=1000.0 + 300) == []
    # Not mistaken for never-connected: that sweep stays silent.
    assert watch.sweep(now=1000.0 + 300) == []


def test_an_open_stream_is_connected_however_long_it_lasts() -> None:
    _connected_with_stream()

    assert watch.sweep_dropped(now=10_000.0) == []
    assert watch.state("p1", now=10_000.0) == ""


def test_a_reconnected_stream_or_any_request_clears_it() -> None:
    _connected_with_stream()
    watch.stream_closed("p1", now=0.0)
    assert watch.sweep_dropped(now=100.0) != []

    watch.stream_opened("p1")
    watch.sweep_dropped(now=130.0)

    assert watch.state("p1", now=130.0) == ""
    assert watch.take_cleared() == ["p1"]

    watch.stream_closed("p1", now=200.0)
    _connect("p1")  # a tool call: the CLI is still talking to us
    assert watch.state("p1", now=400.0) == ""


def test_one_of_two_streams_closing_is_not_a_drop() -> None:
    _connected_with_stream()
    watch.stream_opened("p1")
    watch.stream_closed("p1", now=0.0)

    assert watch.state("p1", now=500.0) == ""


def test_a_stream_closed_in_a_long_stall_is_judged_after_the_short_grace() -> None:
    _connected_with_stream("p1")
    _connected_with_stream("p2")
    # A 360 s stall ending at t=1360; p1's stream is torn down when it ends.
    watch.note_stall(360.0, now=1360.0)
    watch.stream_closed("p1", now=1361.0)
    watch.stream_closed("p2", now=5000.0)  # long after: the ordinary grace

    assert watch.state("p1", now=1361.0 + watch.DROPPED_AFTER_STALL_S + 1) == watch.STATE_DISCONNECTED
    assert watch.state("p2", now=5000.0 + watch.DROPPED_AFTER_STALL_S + 1) == ""


def test_a_short_stall_changes_nothing() -> None:
    _connected_with_stream()
    watch.note_stall(watch.STALL_RECHECK_S - 1, now=100.0)
    watch.stream_closed("p1", now=100.0)

    assert watch.state("p1", now=100.0 + watch.DROPPED_AFTER_STALL_S + 1) == ""


def test_a_drop_under_a_former_id_counts() -> None:
    _connected_with_stream("old")
    watch.stream_closed("old", now=0.0)
    agent_messaging.unregister("old")
    _pane("new")
    agent_messaging.add_aliases("new", ["old"], "/ws")

    assert [e.pane_id for e in watch.sweep_dropped(now=500.0)] == ["new"]


@pytest.mark.asyncio
async def test_the_endpoint_counts_a_pane_get_as_its_stream(monkeypatch: pytest.MonkeyPatch) -> None:
    _pane()
    seen: list[int] = []

    class Manager:
        async def handle_request(self, scope: Any, receive: Any, send: Any) -> None:
            seen.append(watch._open_streams.get("p1", 0))

    import asyncio

    runner = plan_mcp._Runner(Manager(), asyncio.get_running_loop().create_future(), asyncio.Event(), asyncio.Event())
    runner.ready.set()
    monkeypatch.setattr(plan_mcp, "_runner", runner)
    monkeypatch.setattr(plan_mcp, "_runner_stopped", lambda r: False)
    query = f"pane=p1&t={plan_mcp_wiring.caller_token('p1')}".encode()
    closed_after: list[bool] = []
    for method in ("GET", "POST"):
        scope = {"type": "http", "method": method, "path": "/plan-mcp", "query_string": query, "headers": []}
        await plan_mcp.asgi_app(scope, None, None)
        closed_after.append("p1" in watch._closed_at)

    assert seen == [1, 0]
    # The GET ending is its stream closing; the POST after it is the CLI
    # still talking, which clears that.
    assert closed_after == [True, False]
    runner.task.cancel()


@pytest.mark.asyncio
async def test_the_disconnect_notifier_tells_the_windows_and_the_chats(monkeypatch: pytest.MonkeyPatch) -> None:
    from agent_team_backend import app
    from agent_team_backend import channels

    events: list[dict[str, Any]] = []
    chats: list[str] = []

    async def broadcast(event: dict[str, Any]) -> None:
        events.append(event)

    class Manager:
        async def notify_mcp_disconnected(self, pane: str) -> None:
            chats.append(pane)

    monkeypatch.setattr(app, "broadcast", broadcast)
    monkeypatch.setattr(channels, "get_manager", lambda: Manager())
    entry = agent_messaging.RegisteredPane(pane_id="p9", name="n9", workspace_path="/ws", agent_key="claude")

    await app._notify_mcp_disconnected(entry)

    assert events[0]["type"] == "mcp.disconnected"
    assert events[0]["payload"]["pane_id"] == "p9"
    assert chats == ["n9"]


@pytest.mark.asyncio
async def test_run_hands_a_dropped_pane_to_its_notifier(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    told: list[str] = []
    entry = agent_messaging.RegisteredPane(pane_id="p9", name="n9", workspace_path="/ws", agent_key="claude")
    drops = iter([[entry], []])
    monkeypatch.setattr(watch, "SWEEP_INTERVAL_S", 0)
    monkeypatch.setattr(watch, "sweep", lambda: [])
    monkeypatch.setattr(watch, "sweep_dropped", lambda: next(drops, []))

    async def ignore(e: Any) -> None:
        pass

    async def dropped(e: agent_messaging.RegisteredPane) -> None:
        told.append(e.name)

    task = asyncio.create_task(watch.run(ignore, None, dropped))
    for _ in range(10):
        await asyncio.sleep(0)
    task.cancel()

    assert told == ["n9"]


@pytest.mark.parametrize("lang", ["zh-TW", "en-US", "ja-JP", "zh-CN", "ko-KR", "es-ES",
                                  "fr-FR", "de-DE", "pt-BR", "ru-RU", "vi-VN"])
def test_the_disconnect_chat_notice_exists_in_every_language(lang: str) -> None:
    from agent_team_backend.channels import quick_menu

    text = quick_menu.text(lang, "mcp_disconnected", pane="開發-甲")
    assert "開發-甲" in text and "/mcp reconnect navide" in text
