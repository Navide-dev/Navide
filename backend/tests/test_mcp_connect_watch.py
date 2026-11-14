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
