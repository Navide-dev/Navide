"""cli_cancel_message: taking back a message that has not gone in yet.

The channel already existed for the Messages panel; this is the MCP face of
it. What needs testing is the accounting: a withdrawal must not be recorded as
a failure, being too late must be reported as what actually happened, and a
window that never answers must not let the caller believe the message is gone.
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
def _clean() -> Any:
    agent_messaging._reset_for_test()
    plan_mcp._mcp_message_status.clear()
    yield
    agent_messaging._reset_for_test()
    plan_mcp._mcp_message_status.clear()


def _ctx() -> Any:
    return _ctx_for("pa")


def _ctx_for(pane_id: str) -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


@pytest.fixture
def broadcasts(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kw: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    return events


def _sent(key: str = "k1") -> None:
    agent_messaging.register("pa", "sender", "/ws/alpha")
    plan_mcp._record_message_sent(key, "target", "pa", "hello")


@pytest.mark.asyncio
async def test_a_withdrawn_message_is_cancelled_not_failed(
    broadcasts: list[dict[str, Any]],
) -> None:
    """The point of the whole feature. A withdrawal arrives over the delivered
    path with ok=False; recording it as "failed" would tell the sender
    something went wrong and invite the resend it just decided against."""
    _sent()

    async def answer() -> None:
        for _ in range(200):
            if broadcasts:
                plan_mcp.record_delivery_result("k1", False, '{"key":"cancelled"}')
                return
            await asyncio.sleep(0.005)

    task = asyncio.create_task(answer())
    result = await plan_mcp.cli_cancel_message("k1", _ctx())
    await task

    assert result["ok"] is True
    assert result["status"] == "cancelled"
    assert plan_mcp._mcp_message_status["k1"]["status"] == "cancelled"


@pytest.mark.asyncio
async def test_a_real_failure_is_still_failed(broadcasts: list[dict[str, Any]]) -> None:
    """The other side of the branch: only "cancelled" gets the new state."""
    _sent()

    async def answer() -> None:
        for _ in range(200):
            if broadcasts:
                plan_mcp.record_delivery_result("k1", False, '{"key":"inject-failed"}')
                return
            await asyncio.sleep(0.005)

    task = asyncio.create_task(answer())
    result = await plan_mcp.cli_cancel_message("k1", _ctx())
    await task

    assert result["ok"] is False
    assert result["status"] == "failed"
    assert result["reason"] == "inject-failed"


@pytest.mark.asyncio
async def test_too_late_says_delivered_rather_than_refusing(
    broadcasts: list[dict[str, Any]],
) -> None:
    """"Can I still take it back?" is answered with what happened, not an
    error about the request being malformed."""
    _sent()
    plan_mcp.record_delivery_result("k1", True, "")

    result = await plan_mcp.cli_cancel_message("k1", _ctx())

    assert result["ok"] is False
    assert result["status"] == "delivered"
    assert "too late" in result["error"]
    assert broadcasts == [], "a settled message must not be broadcast for withdrawal"


@pytest.mark.asyncio
async def test_a_silent_window_does_not_look_like_a_withdrawal(
    broadcasts: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Nobody answered. The message is still on its way, and saying otherwise
    would have the sender assume it was taken back when it was not."""
    _sent()
    monkeypatch.setattr(plan_mcp, "_CANCEL_VERDICT_TIMEOUT_S", 0.02)

    result = await plan_mcp.cli_cancel_message("k1", _ctx())

    assert result["ok"] is False
    assert result["status"] == "queued"
    assert "still queued" in result["error"]
    assert len(broadcasts) == 1


@pytest.mark.asyncio
async def test_a_different_pane_cannot_withdraw_someone_elses_message(
    broadcasts: list[dict[str, Any]],
) -> None:
    """A msg_key is not a capability: only the pane that sent it may withdraw
    it. Anyone else holding the key must be refused, with the message left
    exactly as it was and no cancel broadcast to the recipient."""
    _sent()  # sent by "pa"
    agent_messaging.register("pb", "other", "/ws/beta")

    result = await plan_mcp.cli_cancel_message("k1", _ctx_for("pb"))

    assert result["ok"] is False
    assert "not sent from here" in result["error"] or "your own" in result["error"]
    assert plan_mcp._mcp_message_status["k1"]["status"] == "queued"
    assert broadcasts == []


@pytest.mark.asyncio
async def test_an_unknown_key_explains_what_it_does_not_mean() -> None:
    """Keys are tracked for about an hour. "Not tracked" says nothing about
    whether the message arrived, and the error has to prevent that inference."""
    agent_messaging.register("pa", "sender", "/ws/alpha")

    result = await plan_mcp.cli_cancel_message("nope", _ctx())

    assert result["ok"] is False
    assert "never sent" in result["error"] or "older" in result["error"]


@pytest.mark.asyncio
async def test_an_empty_key_is_refused_without_broadcasting(
    broadcasts: list[dict[str, Any]],
) -> None:
    agent_messaging.register("pa", "sender", "/ws/alpha")

    result = await plan_mcp.cli_cancel_message("   ", _ctx())

    assert result["ok"] is False
    assert broadcasts == []


@pytest.mark.asyncio
async def test_the_broadcast_carries_the_key_the_window_matches_on(
    broadcasts: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    _sent("k-abc")
    monkeypatch.setattr(plan_mcp, "_CANCEL_VERDICT_TIMEOUT_S", 0.02)

    await plan_mcp.cli_cancel_message("k-abc", _ctx())

    assert broadcasts[0]["type"] == "agent_msg.cancel"
    assert broadcasts[0]["payload"] == {"msg_key": "k-abc"}
