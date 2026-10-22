"""The activity sink for a Codex sub-agent's turn end.

The per-account turn count (tokens_store.record_turn) is quota bookkeeping and
must not change: a sub-agent's turn end is still recorded exactly as it was
when it reached the sink as a turn_complete. Everything else the parent pane
would have done with it (state, reply text, broadcast, dev time) is dropped.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend.cli_vendors.codex import CodexLogReader
from agent_team_backend.log_readers.base import ActivityEvent


@pytest.fixture
def sink(monkeypatch: pytest.MonkeyPatch) -> dict[str, list]:
    seen: dict[str, list] = {"record_turn": [], "broadcast": [], "pane": [], "dev_time": []}
    monkeypatch.setattr(
        app.attribution, "attribute",
        lambda usage: SimpleNamespace(workspace_path="/proj", pane_id="pane-1", stage_id=""),
    )
    monkeypatch.setattr(
        app.pane_account_history, "profile_at", lambda pane_id, ts: f"acct-of-{pane_id}@{ts}"
    )
    monkeypatch.setattr(app.tokens_store, "record_turn", lambda *a, **k: seen["record_turn"].append((a, k)))

    async def broadcast(event: Any) -> None:
        seen["broadcast"].append(event)

    monkeypatch.setattr(app, "broadcast", broadcast)
    monkeypatch.setattr(app, "_record_pane_activity", lambda *a, **k: seen["pane"].append((a, k)))
    monkeypatch.setattr(app.dev_time_store, "agent_event", lambda *a, **k: seen["dev_time"].append(a) or False)
    return seen


def _event(event_type: str, detail: str = "task_complete") -> ActivityEvent:
    return ActivityEvent(
        vendor="codex", event_type=event_type, cwd="/proj", session_id="rollout-x-child",
        file_path="/home/.codex-panes/pane-1/sessions/rollout-x-child.jsonl",
        dedup_key="turn:7", timestamp="2026-09-05T01:11:21Z", detail=detail,
    )


@pytest.mark.asyncio
async def test_record_turn_is_called_exactly_as_for_a_turn_complete(sink: dict[str, list]) -> None:
    """main delivered a sub-agent's task_complete as turn_complete; the turn
    count it produced is reproduced call for call, argument for argument."""
    await app._on_log_activity(_event("turn_complete"))
    as_on_main = list(sink["record_turn"])
    sink["record_turn"].clear()

    await app._on_log_activity(_event("subagent_turn_end"))

    assert as_on_main and sink["record_turn"] == as_on_main


@pytest.mark.asyncio
async def test_nothing_else_reaches_the_parent_pane(sink: dict[str, list]) -> None:
    await app._on_log_activity(_event("subagent_turn_end"))
    await app._on_log_activity(_event("subagent_turn_end", detail="turn_aborted"))
    assert len(sink["record_turn"]) == 2
    assert sink["broadcast"] == [] and sink["pane"] == [] and sink["dev_time"] == []


@pytest.mark.asyncio
async def test_an_unattributed_sub_agent_records_nothing(
    sink: dict[str, list], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same early return as a turn_complete outside any workspace."""
    monkeypatch.setattr(
        app.attribution, "attribute",
        lambda usage: SimpleNamespace(workspace_path=None, pane_id="", stage_id=""),
    )
    await app._on_log_activity(_event("subagent_turn_end"))
    assert sink["record_turn"] == []


@pytest.mark.asyncio
async def test_a_parent_and_sub_agent_pair_counts_as_many_turns_as_on_main(
    sink: dict[str, list], tmp_path, set_home
) -> None:
    """End to end through the reader: every turn end in both files is one
    record_turn call, at the same timestamps as before; only the parent's
    reaches the pane."""
    home = tmp_path / "home"
    home.mkdir()
    set_home(home)
    import tests.vendors.test_codex_subagent as fixtures

    day = home / ".codex-panes" / "pane-1" / "sessions" / "2026" / "09" / "05"
    parent = day / f"rollout-p-{fixtures.PARENT_ID}.jsonl"
    child = day / f"rollout-c-{fixtures.CHILD_ID}.jsonl"
    fixtures._write(parent, [
        fixtures._parent_meta(),
        fixtures._ev("2026-09-05T01:10:40Z", "task_started", turn_id="p1"),
        fixtures._ev("2026-09-05T01:12:01Z", "task_complete", turn_id="p1", last_agent_message="P"),
    ])
    fixtures._write(child, [
        fixtures._child_meta(), fixtures._parent_meta(),
        fixtures._ev("2026-09-05T01:11:21Z", "task_complete", turn_id="c1", last_agent_message="C"),
        fixtures._ev("2026-09-05T01:13:05Z", "turn_aborted", turn_id="c2"),
    ])
    reader = CodexLogReader()
    for path in (parent, child):
        for event in reader.parse_activity(path, set()):
            await app._on_log_activity(event)

    stamps = sorted(call[0][2] for call in sink["record_turn"])
    assert stamps == ["2026-09-05T01:11:21Z", "2026-09-05T01:12:01Z", "2026-09-05T01:13:05Z"]
    turn_events = [e for e in sink["broadcast"] if e["payload"]["event_type"] == "turn_complete"]
    assert [e["payload"]["timestamp"] for e in turn_events] == ["2026-09-05T01:12:01Z"]
