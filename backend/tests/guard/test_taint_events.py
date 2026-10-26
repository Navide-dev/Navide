"""Taint events: one per marking delivery, linked to the delivered message
through the message log's routing key, with a readable sender label."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.agent_message_log import AgentMessageLog
from agent_team_backend.guard import mark_tainted, runtime, taint
from agent_team_backend.mcp_server import server as mcp
from agent_team_backend.mcp_server import wiring as mcp_wiring

from .test_ws_and_delivery import captured, ws  # noqa: F401  (fixture)


@pytest.fixture(autouse=True)
def message_log(guard_store, monkeypatch) -> AgentMessageLog:
    log = AgentMessageLog(guard_store._db)
    monkeypatch.setattr(app, "agent_message_log", log)
    return log


def _log_row(log: AgentMessageLog, uid: str, key: str, content: str, sender: str = "alpha/sender") -> None:
    log.append([{"uid": uid, "created_at": 1_000, "status": "delivered", "sender": sender,
                 "recipient": "beta/reviewer", "content": content, "correlation_id": key}])


def _seed() -> None:
    agent_messaging.register("pa", "sender", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pb", "reviewer", "/ws/beta", agent_key="codex")


def _pane_ctx(pane_id: str) -> Any:
    params = {"pane": pane_id, "t": mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))


def test_every_delivery_is_an_event_even_after_the_first_mark():
    mark_tainted("p1", "agent", "message from a", "k1")
    mark_tainted("p1", "agent", "message from b", "k2")
    events = taint.taint_events("p1")
    assert [e["msg_key"] for e in events] == ["k2", "k1"]  # newest first
    # The mark itself still records only the first detail.
    assert runtime.store().taint_get("p1")["detail"] == "message from a"


def test_event_links_to_the_logged_message_text(message_log):
    mark_tainted("p1", "agent", "message from alpha/sender", "k1")
    _log_row(message_log, "u1", "k1", "請檢查 git status\nand report")
    (event,) = taint.taint_events("p1")
    assert event["message"] == {"sender": "alpha/sender", "content": "請檢查 git status\nand report",
                                "created_at": 1_000}


def test_pruned_or_unkeyed_message_is_none_not_empty():
    mark_tainted("p1", "remote", "message from device x", "gone")
    mark_tainted("p1", "agent", "no key")
    assert [e["message"] for e in taint.taint_events("p1")] == [None, None]


def test_events_are_kept_bounded_per_pane():
    from agent_team_backend.guard.store import TAINT_EVENTS_KEEP

    for i in range(TAINT_EVENTS_KEEP + 5):
        mark_tainted("p1", "agent", f"m{i}", f"k{i}")
    mark_tainted("p2", "agent", "other", "x")
    events = taint.taint_events("p1")
    assert len(events) == TAINT_EVENTS_KEEP and events[0]["msg_key"] == f"k{TAINT_EVENTS_KEEP + 4}"
    assert len(taint.taint_events("p2")) == 1


def test_clear_drops_events_and_alias_adoption_moves_them():
    mark_tainted("old", "agent", "before rebuild", "k1")
    agent_messaging.register("new", "reviewer", "/ws/beta")
    agent_messaging.add_aliases("new", ["old"], "/ws/beta")
    assert [e["msg_key"] for e in taint.taint_events("new")] == ["k1"]
    taint.clear_taint("new")
    assert taint.taint_events("new") == [] and taint.taint_events("old") == []


@pytest.mark.asyncio
async def test_ws_events_request(message_log):
    mark_tainted("p1", "agent", "message from alpha/sender", "k1")
    _log_row(message_log, "u1", "k1", "full text")
    res = await ws("guard.taint.events", {"pane_id": "p1"})
    assert res["ok"] is True and res["events"][0]["message"]["content"] == "full text"
    assert (await ws("guard.taint.events", {}))["ok"] is False


# ── every delivery path passes its msg_key ─────────────────────────────────
@pytest.mark.asyncio
async def test_cli_send_event_carries_its_msg_key(captured):  # noqa: F811
    _seed()
    await mcp.cli_send("beta/reviewer", "run it", _pane_ctx("pa"))
    (event,) = taint.taint_events("pb")
    (deliver,) = [e for e in captured if e["type"] == "agent_msg.deliver"]
    assert event["msg_key"] == deliver["payload"]["msg_key"]
    assert event["detail"] == "message from alpha/sender"


@pytest.mark.asyncio
async def test_bare_line_route_event_carries_its_msg_key(captured):  # noqa: F811
    _seed()
    await ws("agent_msg.route", {"from_pane_id": "pa", "to": "beta/reviewer", "content": "do it", "msg_key": "k9"})
    (event,) = taint.taint_events("pb")
    assert event["msg_key"] == "k9" and event["detail"] == "message from alpha/sender"


@pytest.mark.asyncio
async def test_chat_channel_marks_once_as_remote_with_msg_key(captured):  # noqa: F811
    from agent_team_backend.channels import default_seams

    _seed()
    res = await default_seams().deliver("pb", "hello from phone", "telegram:alice")
    (event,) = taint.taint_events("pb")
    assert event["source"] == "remote" and event["msg_key"] == res["msg_key"]
    assert "telegram:alice" in event["detail"]
    assert runtime.store().taint_get("pb")["sources"] == ["remote"]


@pytest.mark.asyncio
async def test_remote_device_event_carries_its_msg_key(captured):  # noqa: F811
    from agent_team_backend import server_link

    _seed()
    link = object.__new__(server_link.ServerLink)
    await server_link.ServerLink._deliver(link, "m1", agent_messaging.get("pb"),
                                          {"deviceId": "dev2", "workspace": "w", "paneName": "x"}, "hi")
    (event,) = taint.taint_events("pb")
    assert event["msg_key"] == "m1" and event["source"] == "remote"


# ── sender label ───────────────────────────────────────────────────────────
def test_readable_sender_prefers_names_over_the_raw_id():
    agent_messaging.register("new-id", "sender", "/ws/alpha")
    agent_messaging.add_aliases("new-id", ["0f6c1d3e-uuid"], "/ws/alpha")
    # A former id resolves to the pane's current name.
    assert agent_messaging.readable_sender("0f6c1d3e-uuid") == "alpha/sender"
    assert agent_messaging.readable_sender("gone-uuid", "Agent-Team/分析") == "Agent-Team/分析"
    # Nothing better known: the id, rather than an empty label.
    assert agent_messaging.readable_sender("gone-uuid") == "gone-uuid"


@pytest.mark.asyncio
async def test_route_from_unregistered_pane_uses_the_senders_name(captured):  # noqa: F811
    agent_messaging.register("pb", "reviewer", "/ws/beta", agent_key="codex")
    await ws("agent_msg.route", {"from_pane_id": "0f6c1d3e-uuid", "from_name": "Agent-Team/分析開發進度",
                                 "to": "beta/reviewer", "content": "x", "msg_key": "k1"})
    (event,) = taint.taint_events("pb")
    assert event["detail"] == "message from Agent-Team/分析開發進度"


def test_events_are_capped_across_panes(guard_store, monkeypatch):
    from agent_team_backend.guard import store as store_mod

    monkeypatch.setattr(store_mod, "TAINT_EVENTS_TOTAL", 3)
    for i in range(5):
        guard_store.taint_event_add(f"closed-{i}", float(i), "agent", "d", "")
    with guard_store._db.transaction() as cur:
        panes = [r[0] for r in cur.execute("SELECT pane_id FROM guard_taint_events ORDER BY id")]
    assert panes == ["closed-2", "closed-3", "closed-4"]
