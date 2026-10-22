"""A Codex sub-agent's rollout in its parent pane's CODEX_HOME.

Shapes follow real rollouts (codex-cli 0.153–0.163): the sub-agent's file opens
with its own session_meta (source.subagent.thread_spawn, thread_source
"subagent", parent_thread_id) and then replays its parent's; it has its own
task_started / task_complete / token_count / agent_message records, written
while the parent's turn is still running.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.cli_vendors.codex import CodexLogReader

PARENT_ID = "01a06f1d-9b8d-7912-8ef1-ffc830909d4c"
CHILD_ID = "01a06f1e-61a5-7751-916e-3b30d4db0812"


def _write(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")


def _parent_meta() -> dict:
    return {"timestamp": "2026-09-05T01:10:06Z", "type": "session_meta",
            "payload": {"id": PARENT_ID, "cwd": "/proj", "source": "cli", "cli_version": "0.163.0",
                        "model_provider": "openai"}}


def _child_meta() -> dict:
    return {"timestamp": "2026-09-05T01:10:57Z", "type": "session_meta",
            "payload": {"id": CHILD_ID, "session_id": PARENT_ID, "forked_from_id": PARENT_ID,
                        "parent_thread_id": PARENT_ID, "cwd": "/proj", "cli_version": "0.163.0",
                        "model_provider": "openai", "thread_source": "subagent",
                        "agent_nickname": "Dirac", "agent_path": "/root/explore",
                        "subagent_history_start_ordinal": 19,
                        "source": {"subagent": {"thread_spawn": {
                            "parent_thread_id": PARENT_ID, "depth": 1, "agent_path": "/root/explore",
                            "agent_nickname": "Dirac", "agent_role": None}}}}}


def _ev(ts: str, ptype: str, **extra: object) -> dict:
    return {"timestamp": ts, "type": "event_msg", "payload": {"type": ptype, **extra}}


def _prompt(ts: str, text: str) -> dict:
    return _ev(ts, "item_completed", item={"type": "UserMessage", "id": "u",
                                           "content": [{"type": "text", "text": text}]})


def _tokens(ts: str, total_in: int, total_out: int) -> dict:
    return _ev(ts, "token_count", info={"total_token_usage": {
        "input_tokens": total_in, "cached_input_tokens": 0, "output_tokens": total_out,
        "reasoning_output_tokens": 0, "total_tokens": total_in + total_out}})


@pytest.fixture
def pair(tmp_path: Path, set_home) -> tuple[Path, Path]:
    home = tmp_path / "home"
    home.mkdir()
    set_home(home)
    day = home / ".codex-panes" / "pane-1" / "sessions" / "2026" / "09" / "05"
    parent = day / f"rollout-2026-09-05T09-10-06-{PARENT_ID}.jsonl"
    child = day / f"rollout-2026-09-05T09-10-57-{CHILD_ID}.jsonl"
    _write(parent, [
        _parent_meta(),
        _ev("2026-09-05T01:10:40Z", "task_started", turn_id="p1"),
        _prompt("2026-09-05T01:10:40Z", "Refactor the parser"),
        _tokens("2026-09-05T01:10:50Z", 1000, 100),
        _ev("2026-09-05T01:12:00Z", "agent_message", message="Parent's answer"),
        _tokens("2026-09-05T01:12:00Z", 3000, 300),
        _ev("2026-09-05T01:12:01Z", "task_complete", turn_id="p1", last_agent_message="Parent's answer"),
    ])
    _write(child, [
        _child_meta(),
        _parent_meta(),  # replayed ancestor
        _ev("2026-09-05T01:10:58Z", "task_started", turn_id="c1"),
        _prompt("2026-09-05T01:10:58Z", "Explore the cloud folder"),
        _tokens("2026-09-05T01:11:10Z", 24796, 50),
        _ev("2026-09-05T01:11:20Z", "agent_message", message="Child's findings"),
        _ev("2026-09-05T01:11:21Z", "task_complete", turn_id="c1", last_agent_message="Child's findings"),
        # After the parent's turn ended: a background sub-agent finishing late.
        _ev("2026-09-05T01:13:00Z", "task_started", turn_id="c2"),
        _ev("2026-09-05T01:13:05Z", "turn_aborted", turn_id="c2", reason="interrupted"),
    ])
    return parent, child


def test_a_sub_agent_turn_end_is_not_its_parent_panes(pair: tuple[Path, Path]) -> None:
    parent, child = pair
    reader = CodexLogReader()
    child_events = reader.parse_activity(child, set())
    # Nothing that moves the pane: no turn_complete, no agent_active, no prompt.
    assert {e.event_type for e in child_events} == {"subagent_turn_end"}
    assert not any(e.text for e in child_events)
    # One per turn end, on the same records and clock a turn_complete used to carry.
    assert [(e.detail, e.timestamp, e.dedup_key) for e in child_events] == [
        ("task_complete", "2026-09-05T01:11:21Z", "turn:7"),
        ("turn_aborted", "2026-09-05T01:13:05Z", "turn:9"),
    ]


def test_the_parent_turn_ends_once_with_its_own_reply(pair: tuple[Path, Path]) -> None:
    parent, _child = pair
    events = CodexLogReader().parse_activity(parent, set())
    turns = [e for e in events if e.event_type == "turn_complete"]
    assert [(e.text, e.timestamp) for e in turns] == [("Parent's answer", "2026-09-05T01:12:01Z")]
    prompts = [e.text for e in events if e.detail == "user_message"]
    assert prompts == ["Refactor the parser"]


def test_a_sub_agent_is_known_from_its_first_session_meta_only(pair: tuple[Path, Path]) -> None:
    parent, child = pair
    reader = CodexLogReader()
    assert reader._is_subagent_rollout(child) is True
    assert reader._is_subagent_rollout(parent) is False


def test_sub_agent_tokens_are_filed_under_its_own_session(pair: tuple[Path, Path]) -> None:
    """Its replayed parent session_meta came last, so its tokens carried the
    parent's session id. The spend itself is unchanged."""
    _parent, child = pair
    result = CodexLogReader().parse_incremental(child, {})
    assert [(u.session_id, u.input_tokens, u.output_tokens) for u in result.events] == [
        (CHILD_ID, 24796, 50),
    ]
    # Checkpointed: a later batch (session_meta already behind the offset) keeps it.
    with child.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(_tokens("2026-09-05T01:13:10Z", 30000, 80)) + "\n")
    again = CodexLogReader().parse_incremental(child, result.checkpoint)
    assert [(u.session_id, u.input_tokens, u.output_tokens) for u in again.events] == [
        (CHILD_ID, 30000 - 24796, 30),
    ]


def test_turn_stats_of_a_sub_agent_carry_its_own_id(pair: tuple[Path, Path]) -> None:
    _parent, child = pair
    turns = CodexLogReader().turns_for_session(child, child.stem)
    assert turns and {t.session_id for t in turns} == {CHILD_ID}


def test_a_parent_rollout_still_takes_its_own_id(pair: tuple[Path, Path]) -> None:
    parent, _child = pair
    result = CodexLogReader().parse_incremental(parent, {})
    assert {u.session_id for u in result.events} == {PARENT_ID}
