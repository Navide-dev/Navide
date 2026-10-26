"""cli_inbox_summary's empty answer had no meaning.

The send-status table is process memory: an hour, a few hundred sends, gone on
restart. cli_inbox_summary reports only what is stale or failed, so `messages:
[]` was returned by two situations a caller has to tell apart — "nothing of
yours is stuck" and "this backend restarted under you and every msg_key you are
holding is now unknown". An orchestrator two hours into a run, having survived
a restart it never saw, reads the empty list as everything-fine and never learns
that it can no longer say whether its work was delivered.

cli_check_message already answers an unknown key with "not tracked any more".
These give the summary the same honesty, without making the table durable —
the comment above `_MESSAGE_STATUS_MAX` explains why the outcomes live and die
with the process, and that decision stands.
"""

from __future__ import annotations

import time
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend.mcp_server import (
    server as plan_mcp,
    auth as plan_mcp_auth,
    wiring as plan_mcp_wiring,
)


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch: pytest.MonkeyPatch) -> Any:
    agent_messaging._reset_for_test()
    plan_mcp._mcp_message_status.clear()
    # A fresh table, exactly as a just-restarted backend has one.
    monkeypatch.setattr(plan_mcp, "_status_tracking_since", time.monotonic())
    yield
    agent_messaging._reset_for_test()
    plan_mcp._mcp_message_status.clear()


def _ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _external_ctx() -> Any:
    plan_mcp_auth.set_external_enabled(True)
    params = {"client": "external", "t": plan_mcp_auth.external_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _track(key: str, origin: str, status: str, age_s: float) -> None:
    plan_mcp._mcp_message_status[key] = {
        "status": status,
        "target": "beta/worker",
        "reason": None,
        "delivered_at": None,
        "created_at": time.monotonic() - age_s,
        "hold": None,
        "hold_since": None,
        "origin": origin,
        "excerpt": "run the tests",
    }


# ── The two situations that used to look identical ─────────────────────────
@pytest.mark.asyncio
async def test_a_restart_is_distinguishable_from_a_quiet_inbox() -> None:
    """Both answers have an empty `messages`. Only the tracking numbers say
    which of the two an agent is looking at."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")

    _track("k1", "pa", "delivered", 1800.0)
    _track("k2", "pa", "delivered", 900.0)
    _track("k3", "pa", "queued", 5.0)
    quiet = await plan_mcp.cli_inbox_summary(_ctx())

    # The backend restarts: the table goes, and so does the clock behind it.
    plan_mcp._mcp_message_status.clear()
    restarted = await plan_mcp.cli_inbox_summary(_ctx())

    assert quiet["messages"] == restarted["messages"] == []
    assert quiet["count"] == restarted["count"] == 0
    assert quiet["tracked"] == 3
    assert restarted["tracked"] == 0
    assert quiet != restarted


@pytest.mark.asyncio
async def test_the_answer_says_how_far_back_it_can_see(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A backend forty seconds old cannot speak for a message sent an hour ago,
    and now says so instead of answering as though it could."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    monkeypatch.setattr(plan_mcp, "_status_tracking_since", time.monotonic() - 40.0)

    result = await plan_mcp.cli_inbox_summary(_ctx())
    assert result["tracked"] == 0
    assert 40.0 <= result["tracking_since_s"] < 45.0


@pytest.mark.asyncio
async def test_the_window_never_claims_more_than_the_ttl(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A backend up for a week still only keeps an hour of sends. Reporting its
    uptime would promise coverage the TTL already threw away."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    monkeypatch.setattr(plan_mcp, "_status_tracking_since", time.monotonic() - 604800.0)

    result = await plan_mcp.cli_inbox_summary(_ctx())
    assert result["tracking_since_s"] == plan_mcp._MESSAGE_STATUS_TTL_S


@pytest.mark.asyncio
async def test_the_window_shrinks_to_the_oldest_survivor_once_the_table_is_full(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The count bound evicts long before the TTL does on a busy backend. With
    the table full, records reach back only as far as the oldest one left."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    monkeypatch.setattr(plan_mcp, "_status_tracking_since", time.monotonic() - 3000.0)
    for i in range(plan_mcp._MESSAGE_STATUS_MAX):
        _track(f"k{i}", "pa", "delivered", 30.0)

    result = await plan_mcp.cli_inbox_summary(_ctx())
    assert result["tracked"] == plan_mcp._MESSAGE_STATUS_MAX
    assert 30.0 <= result["tracking_since_s"] < 35.0


# ── `tracked` is about the caller, and about more than the stuck ones ──────
@pytest.mark.asyncio
async def test_tracked_counts_the_sends_the_list_deliberately_leaves_out() -> None:
    """`count` is what is stuck; `tracked` is what is remembered. Making them
    the same number would leave the empty list exactly as mute as it was."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    _track("k1", "pa", "delivered", 600.0)
    _track("k2", "pa", "delivered", 300.0)
    _track("k3", "pa", "queued", 300.0)  # past _STALE_HOLD_S

    result = await plan_mcp.cli_inbox_summary(_ctx())
    assert result["count"] == 1
    assert [row["msg_key"] for row in result["messages"]] == ["k3"]
    assert result["tracked"] == 3


@pytest.mark.asyncio
async def test_tracked_never_counts_anybody_else_s_sends() -> None:
    """The tool asks about no one but its caller, and a number that quietly
    included other panes' traffic would be read as the caller's own."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pb", "peer", "/ws/alpha", agent_key="codex")
    _track("k1", "pa", "delivered", 10.0)
    _track("k2", "pb", "delivered", 10.0)
    _track("k3", "pb", "delivered", 10.0)

    assert (await plan_mcp.cli_inbox_summary(_ctx("pa")))["tracked"] == 1
    assert (await plan_mcp.cli_inbox_summary(_ctx("pb")))["tracked"] == 2


@pytest.mark.asyncio
async def test_a_caller_with_no_pane_gets_its_own_count() -> None:
    """The external client is the caller this tool exists for — it has no pane
    to be told anything in — so its sends must be counted as its own."""
    _track("k1", "external", "delivered", 10.0)
    _track("k2", "pa", "delivered", 10.0)

    result = await plan_mcp.cli_inbox_summary(_external_ctx())
    assert result["tracked"] == 1


# ── The existing answer is untouched ───────────────────────────────────────
@pytest.mark.asyncio
async def test_the_stuck_list_itself_answers_exactly_as_it_did() -> None:
    """The new keys are additive: every row, and `count`, must be byte-for-byte
    what a caller already parses."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    _track("k1", "pa", "queued", 300.0)
    plan_mcp._mcp_message_status["k1"]["hold"] = {"key": "typing"}
    plan_mcp._mcp_message_status["k1"]["hold_since"] = time.monotonic() - 60.0

    result = await plan_mcp.cli_inbox_summary(_ctx())
    assert set(result) == {"ok", "count", "messages", "tracked", "tracking_since_s"}
    assert result["count"] == 1
    row = result["messages"][0]
    assert set(row) == {
        "msg_key", "target", "status", "age_seconds", "excerpt", "stale",
        "hold", "held_for_s",
    }
    assert row["stale"] is True
    assert row["hold"] == {"key": "typing"}


@pytest.mark.asyncio
async def test_an_unidentifiable_caller_is_still_refused_the_same_way() -> None:
    """The refusal path must not have grown tracking keys — there is no caller
    whose sends they would describe."""
    result = await plan_mcp.cli_inbox_summary(
        SimpleNamespace(request_context=SimpleNamespace(request=None))
    )
    assert set(result) == {"ok", "error"}
    assert result["ok"] is False
