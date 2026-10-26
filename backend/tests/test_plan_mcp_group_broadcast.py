"""cli_send(to="group"): broadcasting to the sender's own tab group.

Groups are UI state the backend never learns — ``agent_msg.register`` carries no
group id — so the recipient set is asked of the window that owns the sender
(``ui.groupPeers`` over the ui.invoke pair) and each recipient is then
delivered to through the ordinary single-message path. These tests pin that
split: one question out, N independent deliveries back.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.mcp_server import (
    server as plan_mcp,
    auth as plan_mcp_auth,
    wiring as plan_mcp_wiring,
)


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    plan_mcp._ui_invoke_pending.pending.clear()
    plan_mcp._mcp_message_status.clear()
    yield
    agent_messaging._reset_for_test()
    plan_mcp._ui_invoke_pending.pending.clear()
    plan_mcp._mcp_message_status.clear()


class _Window:
    """Stands in for the renderer window's WS session that owner() hands back."""

    def __init__(self) -> None:
        self.dead = False


def _pane_ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _host_ctx() -> Any:
    params = {"client": "host", "t": plan_mcp_auth.internal_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _seed() -> _Window:
    """A sender plus two group-mates, all mirrored by one window."""
    window = _Window()
    agent_messaging.register("pa", "sender", "/ws/alpha", agent_key="claude", owner=window)
    agent_messaging.register("pb", "mate-1", "/ws/alpha", agent_key="codex", owner=window)
    agent_messaging.register("pc", "mate-2", "/ws/alpha", agent_key="claude", owner=window)
    return window


@pytest.fixture
def delivered(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Only the agent_msg.deliver events — ui.invoke.request rides the same bus."""
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        if event.get("type") == "agent_msg.deliver":
            events.append(event)

    async def fake_unicast_to(session: Any, event: dict[str, Any]) -> bool:
        if session is None or getattr(session, "dead", False):
            return False
        asked.append(event)
        return True

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    monkeypatch.setattr(app, "unicast_to", fake_unicast_to)
    return events


#: The ui.invoke.request events the broadcast addressed at the sender's window.
asked: list[dict[str, Any]] = []


@pytest.fixture(autouse=True)
def _clear_asked() -> Any:
    asked.clear()
    yield
    asked.clear()


async def _answer_peers(peers: list[dict[str, str]], group_id: str = "rg-1") -> None:
    """Stand in for the window replying to ui.groupPeers."""
    for _ in range(400):
        keys = list(plan_mcp._ui_invoke_pending.pending)
        if keys:
            plan_mcp.resolve_ui_invoke(
                keys[0],
                {"ok": True, "result": {"group_id": group_id, "peers": peers}, "error": None},
            )
            return
        await asyncio.sleep(0.005)
    raise AssertionError("no pending ui.groupPeers request appeared")


@pytest.mark.asyncio
async def test_group_broadcast_delivers_to_each_peer_with_its_own_key(
    delivered: list[dict[str, Any]],
) -> None:
    """One call in, N independent messages out — each with its own msg_key,
    because each recipient has its own rate-limit budget, hold and report."""
    _seed()
    task = asyncio.create_task(
        _answer_peers([{"pane_id": "pb", "name": "mate-1"}, {"pane_id": "pc", "name": "mate-2"}])
    )
    result = await plan_mcp.cli_send("group", "stand up please", _pane_ctx())
    await task

    assert result["ok"] is True
    assert result["broadcast"] == "group"
    assert result["group_id"] == "rg-1"
    assert result["delivered_to"] == 2
    assert [r["pane_id"] for r in result["recipients"]] == ["pb", "pc"]
    keys = [r["msg_key"] for r in result["recipients"]]
    assert len(set(keys)) == 2, "each recipient needs its own key to be tracked apart"

    # The recipient set is asked of the sender's own window, addressed rather
    # than broadcast, through the UI action the renderer registers.
    assert len(asked) == 1
    ask = asked[0]["payload"]
    assert asked[0]["type"] == "ui.invoke.request"
    assert ask["action"] == "ui.groupPeers"
    assert ask["args"] == {"paneId": "pa"}

    assert [e["payload"]["target_pane_id"] for e in delivered] == ["pb", "pc"]
    for event in delivered:
        payload = event["payload"]
        assert payload["content"] == "stand up please"
        assert payload["from_pane_id"] == "pa"
        # Same loop guard a direct send gets: the frontend charges the per-pair
        # budget for anything that did not pass through its own send path.
        assert payload["rate_limit"] is True


@pytest.mark.asyncio
async def test_each_broadcast_key_is_tracked_like_an_ordinary_send(
    delivered: list[dict[str, Any]],
) -> None:
    """cli_check_message has to answer for a broadcast recipient, so every key
    must land in the same status table a direct send uses."""
    _seed()
    task = asyncio.create_task(_answer_peers([{"pane_id": "pb", "name": "mate-1"}]))
    result = await plan_mcp.cli_send("group", "hi", _pane_ctx())
    await task

    key = result["recipients"][0]["msg_key"]
    assert key in plan_mcp._mcp_message_status


@pytest.mark.asyncio
async def test_a_group_of_one_is_not_a_failure(delivered: list[dict[str, Any]]) -> None:
    """Nobody else in the group is an outcome, not an error — answering ok:false
    would push an agent into retrying something that can never succeed."""
    _seed()
    task = asyncio.create_task(_answer_peers([]))
    result = await plan_mcp.cli_send("group", "anyone?", _pane_ctx())
    await task

    assert result["ok"] is True
    assert result["delivered_to"] == 0
    assert result["recipients"] == []
    assert delivered == []


@pytest.mark.asyncio
async def test_a_peer_that_vanished_is_reported_per_recipient(
    delivered: list[dict[str, Any]],
) -> None:
    """The window listed it a moment ago; it went away in between. That must not
    fail the whole broadcast — the others still got the message."""
    _seed()
    task = asyncio.create_task(
        _answer_peers([{"pane_id": "pb", "name": "mate-1"}, {"pane_id": "gone", "name": "ghost"}])
    )
    result = await plan_mcp.cli_send("group", "hi", _pane_ctx())
    await task

    assert result["ok"] is True
    assert result["delivered_to"] == 1
    by_pane = {r["pane_id"]: r for r in result["recipients"]}
    assert by_pane["pb"]["accepted"] is True
    assert by_pane["gone"]["accepted"] is False
    assert by_pane["gone"]["reason"] == "target-offline"
    assert [e["payload"]["target_pane_id"] for e in delivered] == ["pb"]


@pytest.mark.asyncio
async def test_a_caller_with_no_pane_has_no_group(delivered: list[dict[str, Any]]) -> None:
    """A host/external credential has no pane, so it has no group to broadcast
    to — and no window to ask. Refuse rather than guess a scope."""
    _seed()
    result = await plan_mcp.cli_send("group", "hi", _host_ctx())

    assert result["ok"] is False
    assert result["error_code"] == "no-group"
    assert delivered == []


@pytest.mark.asyncio
async def test_the_window_not_answering_is_reported_not_swallowed(
    monkeypatch: pytest.MonkeyPatch, delivered: list[dict[str, Any]]
) -> None:
    _seed()

    async def fake_ui_request(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {"ok": False, "error": "did not answer within 15s", "error_code": "ui_action_timeout"}

    monkeypatch.setattr(plan_mcp, "_ui_request", fake_ui_request)
    result = await plan_mcp.cli_send("group", "hi", _pane_ctx())

    assert result["ok"] is False
    assert result["error_code"] == "ui_action_timeout"
    assert delivered == []


@pytest.mark.asyncio
async def test_pane_id_wins_over_the_group_keyword(delivered: list[dict[str, Any]]) -> None:
    """`group` is a value of `to`, and `to` is ignored whenever an id is given."""
    _seed()
    result = await plan_mcp.cli_send("group", "hi", _pane_ctx(), pane_id="pb")

    assert result["ok"] is True
    assert "broadcast" not in result
    assert [e["payload"]["target_pane_id"] for e in delivered] == ["pb"]


@pytest.mark.asyncio
async def test_the_keyword_is_case_insensitive_and_trimmed(
    delivered: list[dict[str, Any]],
) -> None:
    _seed()
    task = asyncio.create_task(_answer_peers([{"pane_id": "pb", "name": "mate-1"}]))
    result = await plan_mcp.cli_send("  GROUP  ", "hi", _pane_ctx())
    await task

    assert result["ok"] is True
    assert result["broadcast"] == "group"


@pytest.mark.asyncio
async def test_send_and_wait_refuses_a_broadcast_with_a_useful_error(
    delivered: list[dict[str, Any]],
) -> None:
    """Waiting is per-turn and a broadcast has no single turn. Without an
    explicit refusal the keyword would be resolved as a pane name and come back
    "unknown target", which reads like a typo instead of the real answer."""
    _seed()
    result = await plan_mcp.cli_send_and_wait("group", "hi", _pane_ctx())

    assert result["ok"] is False
    assert result["error_code"] == "broadcast-unsupported"
    assert "cli_send" in result["error"], "the refusal has to say what to use instead"
    assert delivered == []


@pytest.mark.asyncio
async def test_a_broadcast_reply_threads_on_every_recipient(
    delivered: list[dict[str, Any]],
) -> None:
    """The broadcast shares _dispatch_delivery with the single send, so it must
    carry the same field — and every recipient gets it, because a correlation id
    is only ever recognised by the window that handed it out."""
    _seed()
    task = asyncio.create_task(
        _answer_peers([{"pane_id": "pb", "name": "mate-1"}, {"pane_id": "pc", "name": "mate-2"}])
    )
    result = await plan_mcp.cli_send("group", "answering", _pane_ctx(), reply_to="pa:mcp:abc")
    await task

    assert result["ok"] is True
    assert [e["payload"]["reply_to"] for e in delivered] == ["pa:mcp:abc", "pa:mcp:abc"]


@pytest.mark.asyncio
async def test_a_broadcast_that_is_not_a_reply_carries_no_such_key(
    delivered: list[dict[str, Any]],
) -> None:
    _seed()
    task = asyncio.create_task(_answer_peers([{"pane_id": "pb", "name": "mate-1"}]))
    await plan_mcp.cli_send("group", "stand up", _pane_ctx())
    await task

    assert delivered and all("reply_to" not in e["payload"] for e in delivered)


@pytest.mark.asyncio
async def test_an_ack_broadcast_reaches_every_peer_as_an_ack(
    delivered: list[dict[str, Any]],
) -> None:
    """The group path dropped `kind` while `reply_to` travelled, so an ack
    addressed to the group was silently downgraded and typed into every peer —
    the opposite of what the caller asked for, and to more panes at once."""
    _seed()
    task = asyncio.create_task(
        _answer_peers([{"pane_id": "pb", "name": "mate-1"}, {"pane_id": "pc", "name": "mate-2"}])
    )
    result = await plan_mcp.cli_send("group", "got it", _pane_ctx(), kind="ack")
    await task

    assert result["ok"] is True
    assert [e["payload"]["kind"] for e in delivered] == ["ack", "ack"]


@pytest.mark.asyncio
async def test_an_ordinary_broadcast_still_carries_no_kind(
    delivered: list[dict[str, Any]],
) -> None:
    """Same guard as the direct send: the payload every existing caller already
    produces must not gain a key."""
    _seed()
    task = asyncio.create_task(_answer_peers([{"pane_id": "pb", "name": "mate-1"}]))
    await plan_mcp.cli_send("group", "stand up", _pane_ctx())
    await task

    assert delivered and all("kind" not in e["payload"] for e in delivered)
