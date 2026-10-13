"""A message typed into a resumed CLI that never showed it received it.

The receiving window can tell "it went in" from "it did not" only by evidence,
and for a CLI that has just been resumed the evidence can be too weak either
way: the bytes and the Enter went out, the CLI's own repaint is all that was
seen, and the transcript has not shown the message yet. That is reported as
reason "delivery-unconfirmed" — and it must not read as a failure, because a
sender that resends on it may dispatch the work twice.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend.mcp_server import server as plan_mcp, wiring as plan_mcp_wiring

UNCONFIRMED = '{"key":"delivery-unconfirmed"}'


@pytest.fixture(autouse=True)
def _clean() -> Any:
    agent_messaging._reset_for_test()
    plan_mcp._mcp_message_status.clear()
    yield
    agent_messaging._reset_for_test()
    plan_mcp._mcp_message_status.clear()


def _ctx() -> Any:
    params = {"pane": "pa", "t": plan_mcp_wiring.caller_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _sent(key: str = "k1") -> None:
    agent_messaging.register("pa", "sender", "/ws/alpha")
    plan_mcp._record_message_sent(key, "target", "pa", "hello")


def test_an_unconfirmed_delivery_is_its_own_status_not_failed() -> None:
    _sent()
    plan_mcp.record_delivery_result("k1", False, UNCONFIRMED)

    entry = plan_mcp._mcp_message_status["k1"]
    assert entry["status"] == "unconfirmed"
    assert entry["reason"] == "delivery-unconfirmed"


def test_a_late_confirmation_turns_it_into_delivered() -> None:
    """The transcript showed the message after the window had already said
    unconfirmed; the window reports again and the status catches up."""
    _sent()
    plan_mcp.record_delivery_result("k1", False, UNCONFIRMED)
    plan_mcp.record_delivery_result("k1", True, "")

    entry = plan_mcp._mcp_message_status["k1"]
    assert entry["status"] == "delivered"
    assert entry["reason"] is None


@pytest.mark.asyncio
async def test_cli_check_message_reports_it() -> None:
    _sent()
    plan_mcp.record_delivery_result("k1", False, UNCONFIRMED)

    result = await plan_mcp.cli_check_message("k1", _ctx())

    assert result["ok"] is True
    assert result["status"] == "unconfirmed"
    assert result["reason"] == "delivery-unconfirmed"


@pytest.mark.asyncio
async def test_wait_for_delivery_stops_on_it_and_says_so() -> None:
    _sent()

    async def answer() -> None:
        await asyncio.sleep(0.02)
        plan_mcp.record_delivery_result("k1", False, UNCONFIRMED)

    task = asyncio.create_task(answer())
    result = await plan_mcp._with_delivery_wait({"ok": True, "msg_key": "k1"}, 5.0)
    await task

    assert result["ok"] is True
    assert result["status"] == "unconfirmed"
    assert result["reason"] == "delivery-unconfirmed"


@pytest.mark.asyncio
async def test_cli_inbox_summary_lists_it_for_the_sender_to_check() -> None:
    _sent()
    plan_mcp.record_delivery_result("k1", False, UNCONFIRMED)

    result = await plan_mcp.cli_inbox_summary(_ctx())

    assert [m["status"] for m in result["messages"]] == ["unconfirmed"]


def test_the_tool_docs_say_to_check_the_pane_before_resending() -> None:
    for tool in (plan_mcp.cli_check_message, plan_mcp.cli_send):
        doc = tool.__doc__ or ""
        assert "unconfirmed" in doc
        assert "cli_get_status" in doc
        assert "cli_read_log" in doc
