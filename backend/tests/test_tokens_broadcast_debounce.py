"""tokens.changed broadcasts must coalesce per workspace.

A startup rescan of historical CLI logs emits thousands of token events in a
burst; broadcasting a snapshot per event starved the event loop and timed out
concurrent requests (real case: terminal.create timeouts during session
restore, 2026-07-14). These tests lock the debounce behaviour of
_schedule_tokens_broadcast.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent_team_backend import app
from agent_team_backend.log_readers import TokenUsage


@pytest.fixture(autouse=True)
def _fast_debounce(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(app, "_TOKENS_BROADCAST_DEBOUNCE_SEC", 0.01)
    create_task = asyncio.create_task
    tasks: list[asyncio.Task] = []

    def track_task(coro):
        task = create_task(coro)
        tasks.append(task)
        return task

    monkeypatch.setattr(app.asyncio, "create_task", track_task)
    app._pending_tokens_broadcast.clear()
    yield tasks
    app._pending_tokens_broadcast.clear()


@pytest.mark.asyncio
async def test_burst_coalesces_to_one_broadcast(monkeypatch: pytest.MonkeyPatch, _fast_debounce) -> None:
    monkeypatch.setattr(app.tokens_store, "snapshot", lambda ws: {"ws": ws})
    with patch.object(app, "broadcast", new_callable=AsyncMock) as mock_broadcast:
        for _ in range(50):
            app._schedule_tokens_broadcast("/ws/a")
        await asyncio.wait_for(asyncio.gather(*_fast_debounce), timeout=5)
        mock_broadcast.assert_called_once()
        event = mock_broadcast.call_args.args[0]
        assert event["type"] == "tokens.changed"
        assert event["payload"] == {"ws": "/ws/a"}


@pytest.mark.asyncio
async def test_workspaces_debounce_independently(monkeypatch: pytest.MonkeyPatch, _fast_debounce) -> None:
    monkeypatch.setattr(app.tokens_store, "snapshot", lambda ws: {"ws": ws})
    with patch.object(app, "broadcast", new_callable=AsyncMock) as mock_broadcast:
        app._schedule_tokens_broadcast("/ws/a")
        app._schedule_tokens_broadcast("/ws/b")
        await asyncio.wait_for(asyncio.gather(*_fast_debounce), timeout=5)
        assert mock_broadcast.call_count == 2
        broadcast_workspaces = {
            call.args[0]["payload"]["ws"] for call in mock_broadcast.call_args_list
        }
        assert broadcast_workspaces == {"/ws/a", "/ws/b"}


@pytest.mark.asyncio
async def test_new_burst_after_window_broadcasts_again(monkeypatch: pytest.MonkeyPatch, _fast_debounce) -> None:
    monkeypatch.setattr(app.tokens_store, "snapshot", lambda ws: {"ws": ws})
    with patch.object(app, "broadcast", new_callable=AsyncMock) as mock_broadcast:
        app._schedule_tokens_broadcast("/ws/a")
        # A fixed sleep may expire before _fire even starts on a busy loop.
        # Wait for the first real broadcast before declaring a new burst;
        # task completion also drains its trailing quota reconciliation.
        await asyncio.wait_for(asyncio.gather(*_fast_debounce), timeout=5)
        app._schedule_tokens_broadcast("/ws/a")
        await asyncio.wait_for(asyncio.gather(*_fast_debounce), timeout=5)
        assert mock_broadcast.call_count == 2


@pytest.mark.asyncio
async def test_workspace_replay_safely_skips_rows_for_another_workspace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        app.attribution,
        "attribute",
        lambda _usage: SimpleNamespace(
            workspace_path="/ws/other", slot_key=None, pane_id=None, stage_id=None
        ),
    )
    record = AsyncMock()
    monkeypatch.setattr(app.tokens_store, "record", record)
    usage = TokenUsage(
        vendor="grok", input_tokens=10, output_tokens=2, cwd="/ws/other",
        session_id="s1", file_path="/logs/grok.db", dedup_key="usage:1",
        replay_workspace="/ws/target",
    )

    result = await app._on_log_token_usage(usage)
    assert result.handled is True
    assert result.workspace_path == ""
    record.assert_not_called()


@pytest.mark.asyncio
async def test_normal_external_event_remains_retryable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        app.attribution,
        "attribute",
        lambda _usage: SimpleNamespace(
            workspace_path=None, slot_key=None, pane_id=None, stage_id=None,
            global_only=False,
        ),
    )
    usage = TokenUsage(
        vendor="claude", input_tokens=10, output_tokens=2, cwd="/external",
        session_id="s1", file_path="/logs/session.jsonl", dedup_key="m::r",
    )
    result = await app._on_log_token_usage(usage)
    assert result.handled is False


@pytest.mark.asyncio
async def test_a_global_only_event_reaches_the_global_tally_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A neighbour's session in a registered workspace's Claude folder: no
    workspace, but the global and account totals still count it."""
    monkeypatch.setattr(
        app.attribution,
        "attribute",
        lambda _usage: SimpleNamespace(
            workspace_path=None, slot_key=None, pane_id=None, stage_id=None,
            group_id="", global_only=True,
        ),
    )
    record = MagicMock(return_value=True)
    monkeypatch.setattr(app.tokens_store, "record", record)
    monkeypatch.setattr(app, "_schedule_tokens_broadcast", lambda _ws: None)
    usage = TokenUsage(
        vendor="claude", input_tokens=10, output_tokens=2, cwd="/neighbour",
        session_id="s1", file_path="/logs/session.jsonl", dedup_key="m::r",
    )
    result = await app._on_log_token_usage(usage)
    assert result.handled is True
    assert result.workspace_path == ""
    assert record.call_args.args[0] is None
