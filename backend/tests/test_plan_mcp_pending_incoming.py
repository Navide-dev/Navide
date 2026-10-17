"""cli_pending_incoming: the recipient's half of delivery visibility.

cli_inbox_summary answers "did what I sent get through?". Nothing answered "is
anything waiting for me?" — and that is the question a busy agent needs, because
a message is typed into a pane only between turns, so the agent that stays busy
is exactly the one that cannot be told it has mail.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.agent_message_log import AgentMessageLog
from agent_team_backend.db import Database
from agent_team_backend.mcp_server import server as plan_mcp, auth as plan_mcp_auth, wiring as plan_mcp_wiring


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


@pytest.fixture
def msg_log(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> AgentMessageLog:
    log = AgentMessageLog(db=Database(tmp_path / "navide.db"))
    monkeypatch.setattr(app, "agent_message_log", log)
    return log


def _ctx(pane_id: str | None = "pa", token: str | None = None) -> Any:
    if pane_id is None:
        return SimpleNamespace(request_context=SimpleNamespace(request=None))
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id) if token is None else token}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _external_ctx() -> Any:
    plan_mcp_auth.set_external_enabled(True)
    params = {"client": "external", "t": plan_mcp_auth.external_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _seed() -> None:
    agent_messaging.register("pa", "reviewer", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pb", "sender", "/ws/alpha", agent_key="codex")


def _row(uid: str, created_at: int, **over: Any) -> dict[str, Any]:
    row = {
        "uid": uid,
        "created_at": created_at,
        "status": "queued",
        "sender": "sender",
        "recipient": "reviewer",
        "content": f"hello {uid}",
    }
    row.update(over)
    return row


# ── Caller identity ────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_refuses_when_the_request_cannot_identify_a_pane(msg_log: AgentMessageLog) -> None:
    _seed()
    result = await plan_mcp.cli_pending_incoming(_ctx(pane_id=None))
    assert result["ok"] is False
    assert "identify your pane" in result["error"]


@pytest.mark.asyncio
async def test_refuses_a_caller_with_no_pane_identity(msg_log: AgentMessageLog) -> None:
    # An external client has no messaging name, so nothing can be addressed to
    # it — an empty inbox would be a misleading answer, not a true one.
    _seed()
    result = await plan_mcp.cli_pending_incoming(_external_ctx())
    assert result["ok"] is False
    assert "no messaging name" in result["error"]


@pytest.mark.asyncio
async def test_refuses_a_pane_id_that_is_no_longer_live(msg_log: AgentMessageLog) -> None:
    # Rejected by _resolve_caller before the inbox is ever read, so a stale id
    # gets the same recovery advice here as it does from every other tool
    # rather than an empty inbox that reads like good news.
    result = await plan_mcp.cli_pending_incoming(_ctx("pa"))
    assert result["ok"] is False
    assert "stale" in result["error"]


# ── What it lists ──────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_lists_only_what_is_still_waiting_for_this_caller(
    msg_log: AgentMessageLog,
) -> None:
    _seed()
    msg_log.append(
        [
            _row("waiting", 1000),
            _row("in-flight", 2000, status="delivering"),
            _row("landed", 3000, status="delivered"),
            _row("bounced", 4000, status="failed"),
            _row("someone-else", 5000, recipient="helper"),
        ]
    )
    result = await plan_mcp.cli_pending_incoming(_ctx("pa"))
    assert result["ok"] is True
    assert result["count"] == 2
    assert [m["uid"] for m in result["messages"]] == ["waiting", "in-flight"]
    assert [m["status"] for m in result["messages"]] == ["queued", "delivering"]


@pytest.mark.asyncio
async def test_reports_an_empty_inbox_as_an_answer_not_an_error(
    msg_log: AgentMessageLog,
) -> None:
    _seed()
    result = await plan_mcp.cli_pending_incoming(_ctx("pa"))
    assert result == {"ok": True, "count": 0, "messages": []}


@pytest.mark.asyncio
async def test_names_the_sender_and_quotes_enough_to_judge_urgency(
    msg_log: AgentMessageLog,
) -> None:
    _seed()
    msg_log.append([_row("a", 1000, sender="alpha/builder", content="  部署  失敗了  ")])
    [message] = (await plan_mcp.cli_pending_incoming(_ctx("pa")))["messages"]
    assert message["sender"] == "alpha/builder"
    # Whitespace-collapsed, the way cli_inbox_summary quotes an outgoing message.
    assert message["excerpt"] == "部署 失敗了"


@pytest.mark.asyncio
async def test_excerpt_is_bounded(msg_log: AgentMessageLog) -> None:
    _seed()
    msg_log.append([_row("a", 1000, content="x" * 5000)])
    [message] = (await plan_mcp.cli_pending_incoming(_ctx("pa")))["messages"]
    assert len(message["excerpt"]) == plan_mcp._INCOMING_EXCERPT_CHARS


@pytest.mark.asyncio
async def test_excerpt_never_splits_a_surrogate_pair(msg_log: AgentMessageLog) -> None:
    _seed()
    msg_log.append([_row("a", 1000, content="🙂" * 500)])
    [message] = (await plan_mcp.cli_pending_incoming(_ctx("pa")))["messages"]
    assert message["excerpt"] == "🙂" * plan_mcp._INCOMING_EXCERPT_CHARS


@pytest.mark.asyncio
async def test_marks_what_navide_wrote_rather_than_an_agent(
    msg_log: AgentMessageLog,
) -> None:
    _seed()
    msg_log.append(
        [
            _row("notice", 1000, kind="notice"),
            _row("fallback", 2000, kind="fallback"),
            _row("plain", 3000),
        ]
    )
    messages = (await plan_mcp.cli_pending_incoming(_ctx("pa")))["messages"]
    assert [m.get("kind") for m in messages] == ["notice", "fallback", None]


@pytest.mark.asyncio
async def test_reports_how_long_each_message_has_waited(msg_log: AgentMessageLog) -> None:
    import time as _time

    _seed()
    two_minutes_ago = int((_time.time() - 120) * 1000)
    msg_log.append([_row("a", two_minutes_ago)])
    [message] = (await plan_mcp.cli_pending_incoming(_ctx("pa")))["messages"]
    assert 115 <= message["age_seconds"] <= 130


@pytest.mark.asyncio
async def test_a_clock_skewed_row_never_reports_a_negative_age(
    msg_log: AgentMessageLog,
) -> None:
    import time as _time

    _seed()
    msg_log.append([_row("a", int((_time.time() + 600) * 1000))])
    [message] = (await plan_mcp.cli_pending_incoming(_ctx("pa")))["messages"]
    assert message["age_seconds"] == 0.0


@pytest.mark.asyncio
async def test_oldest_first_so_the_backlog_reads_in_order(
    msg_log: AgentMessageLog,
) -> None:
    _seed()
    msg_log.append([_row("new", 9000), _row("old", 1000)])
    result = await plan_mcp.cli_pending_incoming(_ctx("pa"))
    assert [m["uid"] for m in result["messages"]] == ["old", "new"]


@pytest.mark.asyncio
async def test_limit_is_clamped_to_a_sane_window(msg_log: AgentMessageLog) -> None:
    _seed()
    msg_log.append([_row(str(i), 1000 + i) for i in range(30)])
    assert (await plan_mcp.cli_pending_incoming(_ctx("pa"), limit=3))["count"] == 3
    assert (await plan_mcp.cli_pending_incoming(_ctx("pa"), limit=0))["count"] == 1
    assert (await plan_mcp.cli_pending_incoming(_ctx("pa"), limit=10_000))["count"] == 30


@pytest.mark.asyncio
async def test_a_renamed_pane_sees_none_of_its_old_mail(msg_log: AgentMessageLog) -> None:
    # Matched on the name the renderer wrote. Reporting nothing is the safe
    # wrong answer here; reporting someone else's mail is not.
    _seed()
    msg_log.append([_row("a", 1000, recipient="reviewer")])
    agent_messaging.register("pa", "reviewer-renamed", "/ws/alpha", agent_key="claude")
    result = await plan_mcp.cli_pending_incoming(_ctx("pa"))
    assert result == {"ok": True, "count": 0, "messages": []}


# ── Threading and hold: the recipient's half of what the sender can see ─────
# The sender had hold/held_for_s/stale from cli_check_message and a msg_key to
# name the message by. The recipient had {uid, sender, status, age, excerpt} —
# no shared id, and no way to see why its own queue was not moving.


@pytest.fixture
def tracked() -> Any:
    """The sender-side bookkeeping cli_check_message reads, cleaned per test."""
    plan_mcp._mcp_message_status.clear()
    yield plan_mcp._mcp_message_status
    plan_mcp._mcp_message_status.clear()


@pytest.mark.asyncio
async def test_reports_the_id_the_sender_knows_the_message_by(
    msg_log: AgentMessageLog, tracked: Any
) -> None:
    """The point of the whole exercise: one string both ends hold, so a reply
    can name the message it answers (cli_send's reply_to)."""
    _seed()
    msg_log.append([_row("a:1", 100) | {"correlation_id": "pb:mcp:abc"}])

    result = await plan_mcp.cli_pending_incoming(_ctx())

    assert result["messages"][0]["correlation_id"] == "pb:mcp:abc"


@pytest.mark.asyncio
async def test_reports_what_a_message_answers(
    msg_log: AgentMessageLog, tracked: Any
) -> None:
    _seed()
    msg_log.append([_row("a:1", 100) | {"reply_to": "earlier:9"}])

    result = await plan_mcp.cli_pending_incoming(_ctx())

    assert result["messages"][0]["in_reply_to"] == "earlier:9"


@pytest.mark.asyncio
async def test_a_message_between_two_panes_of_one_window_claims_no_shared_id(
    msg_log: AgentMessageLog, tracked: Any
) -> None:
    """It is never routed, so no correlation id is ever minted for it. The
    field must be ABSENT rather than filled with something invented — a reply
    quoting a made-up id would silently fail to thread."""
    _seed()
    msg_log.append([_row("a:1", 100)])

    message = (await plan_mcp.cli_pending_incoming(_ctx()))["messages"][0]

    assert "correlation_id" not in message
    assert "in_reply_to" not in message
    assert "hold" not in message


@pytest.mark.asyncio
async def test_shows_why_the_queue_is_not_moving(
    msg_log: AgentMessageLog, tracked: Any
) -> None:
    """The recipient reads the SAME hold the sender reads, by looking its own
    row's correlation id up in the sender-side record. Without this an agent
    could see that mail was waiting but not that it was waiting on itself."""
    _seed()
    msg_log.append([_row("a:1", 100) | {"correlation_id": "pb:mcp:abc"}])
    plan_mcp._record_message_sent("pb:mcp:abc", "reviewer", "pb", "hello")
    assert plan_mcp.record_message_hold("pb:mcp:abc", {"key": "mid-turn"}) is True

    message = (await plan_mcp.cli_pending_incoming(_ctx()))["messages"][0]

    assert message["hold"] == {"key": "mid-turn"}
    assert isinstance(message["held_for_s"], float)


@pytest.mark.asyncio
async def test_marks_a_message_that_has_waited_too_long_as_stale(
    msg_log: AgentMessageLog, tracked: Any
) -> None:
    """`stale` is read from the send's own age, not from the hold clock — a
    message no window ever reported a hold for is exactly the case it exists
    for, so it must appear with no `hold` beside it."""
    _seed()
    msg_log.append([_row("a:1", 100) | {"correlation_id": "pb:mcp:abc"}])
    plan_mcp._record_message_sent("pb:mcp:abc", "reviewer", "pb", "hello")
    tracked["pb:mcp:abc"]["created_at"] -= plan_mcp._STALE_HOLD_S + 1

    message = (await plan_mcp.cli_pending_incoming(_ctx()))["messages"][0]

    assert message["stale"] is True
    assert "hold" not in message
