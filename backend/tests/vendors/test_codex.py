"""CodexLogReader: cumulative-delta parsing + session_meta cwd."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest

from agent_team_backend.cli_vendors.codex import CodexLogReader
from agent_team_backend.log_readers.base import activity_high_water


def _write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


@pytest.fixture
def fake_codex_session(tmp_path: Path, set_home) -> Path:
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    set_home(fake_home)
    return fake_home / ".codex" / "sessions" / "2026" / "05" / "27" / "rollout-test.jsonl"


def _task_complete_event(last_agent_message: str = "", ts: str = "2026-05-27T13:18:04Z") -> dict:
    return {"timestamp": ts, "type": "event_msg",
            "payload": {"type": "task_complete", "turn_id": "u",
                        "last_agent_message": last_agent_message}}


def _token_count_event(input_t: int, cached_in: int, output_t: int, reasoning_out: int) -> dict:
    return {
        "timestamp": "2026-05-27T13:18:03.369Z",
        "type": "event_msg",
        "payload": {
            "type": "token_count",
            "info": {
                "total_token_usage": {
                    "input_tokens": input_t,
                    "cached_input_tokens": cached_in,
                    "output_tokens": output_t,
                    "reasoning_output_tokens": reasoning_out,
                    "total_tokens": input_t + cached_in + output_t + reasoning_out,
                },
                "model_context_window": 258400,
            },
        },
    }


def test_first_event_emits_full_total(fake_codex_session: Path) -> None:
    reader = CodexLogReader()
    _write_jsonl(fake_codex_session, [
        {"type": "session_meta", "payload": {"cwd": "/Users/me/proj"}},
        _token_count_event(100, 20, 50, 10),
    ])
    events = reader.parse_session_file(fake_codex_session, set())
    assert len(events) == 1
    ev = events[0]
    # input = 100 (input_tokens) + 20 (cached_input_tokens) = 120
    assert ev.input_tokens == 120
    # output = 50 (output_tokens) + 10 (reasoning_output_tokens) = 60
    assert ev.output_tokens == 60
    assert ev.cwd == "/Users/me/proj"
    assert ev.vendor == "codex"


def test_subsequent_event_emits_delta(fake_codex_session: Path) -> None:
    reader = CodexLogReader()
    seen: set[str] = set()

    _write_jsonl(fake_codex_session, [
        {"type": "session_meta", "payload": {"cwd": "/x"}},
        _token_count_event(100, 0, 50, 0),
    ])
    events1 = reader.parse_session_file(fake_codex_session, seen)
    assert events1[0].input_tokens == 100
    assert events1[0].output_tokens == 50

    # Append more
    _write_jsonl(fake_codex_session, [
        {"type": "session_meta", "payload": {"cwd": "/x"}},
        _token_count_event(100, 0, 50, 0),
        _token_count_event(150, 0, 75, 0),
    ])
    events2 = reader.parse_session_file(fake_codex_session, seen)
    assert len(events2) == 1
    assert events2[0].input_tokens == 50   # delta 150-100
    assert events2[0].output_tokens == 25  # delta 75-50


def test_no_increase_emits_nothing(fake_codex_session: Path) -> None:
    reader = CodexLogReader()
    seen: set[str] = set()
    _write_jsonl(fake_codex_session, [
        _token_count_event(100, 0, 50, 0),
    ])
    reader.parse_session_file(fake_codex_session, seen)
    # Same file, same content → no new events
    events2 = reader.parse_session_file(fake_codex_session, seen)
    assert events2 == []


def test_decreasing_totals_treated_as_session_rotation(fake_codex_session: Path) -> None:
    """If totals shrink (Codex CLI restarted), reset baseline silently."""
    reader = CodexLogReader()
    seen: set[str] = set()
    _write_jsonl(fake_codex_session, [_token_count_event(500, 0, 200, 0)])
    reader.parse_session_file(fake_codex_session, seen)
    # File rewritten with smaller totals (treat as fresh session)
    _write_jsonl(fake_codex_session, [_token_count_event(50, 0, 30, 0)])
    events = reader.parse_session_file(fake_codex_session, seen)
    # Reset only, no negative delta emitted
    assert events == []
    # Next event grows from new baseline
    _write_jsonl(fake_codex_session, [
        _token_count_event(50, 0, 30, 0),
        _token_count_event(80, 0, 40, 0),
    ])
    events = reader.parse_session_file(fake_codex_session, seen)
    assert len(events) == 1
    assert events[0].input_tokens == 30
    assert events[0].output_tokens == 10


def test_session_meta_cwd_picked_up(fake_codex_session: Path) -> None:
    reader = CodexLogReader()
    _write_jsonl(fake_codex_session, [
        {"type": "other"},
        {"type": "session_meta", "payload": {"cwd": "/home/x/work"}},
        _token_count_event(10, 0, 5, 0),
    ])
    events = reader.parse_session_file(fake_codex_session, set())
    assert events[0].cwd == "/home/x/work"


def test_project_dirs_scan_pane_sessions_but_watch_stable_parent(
    tmp_path: Path,
    set_home,
) -> None:
    fake_home = tmp_path / "home"
    set_home(fake_home)
    default_sessions = fake_home / ".codex" / "sessions"
    pane_sessions = fake_home / ".codex-panes" / "pane-1" / "sessions"
    default_sessions.mkdir(parents=True)
    pane_sessions.mkdir(parents=True)

    reader = CodexLogReader()

    assert default_sessions in reader.project_dirs()
    assert pane_sessions in reader.project_dirs()
    assert default_sessions in reader.watch_dirs()
    assert fake_home / ".codex-panes" in reader.watch_dirs()
    assert pane_sessions not in reader.watch_dirs()


def test_project_dirs_scan_the_default_tree_once_across_symlinked_pane_homes(
    tmp_path: Path,
    set_home,
) -> None:
    """Issue #121: a legacy pane home mirrors `sessions` as a symlink back to
    ~/.codex/sessions. Every such home used to add the whole default tree to
    the scan again (39k rollouts x 27 homes on the reporter's machine)."""
    fake_home = tmp_path / "home"
    set_home(fake_home)
    default_sessions = fake_home / ".codex" / "sessions"
    _write_jsonl(default_sessions / "2026" / "05" / "27" / "rollout-a.jsonl", [
        {"type": "session_meta", "payload": {"cwd": "/w"}},
    ])
    panes = fake_home / ".codex-panes"
    for pane in ("pane-link-1", "pane-link-2"):
        (panes / pane).mkdir(parents=True)
        (panes / pane / "sessions").symlink_to(default_sessions, target_is_directory=True)
    own_sessions = panes / "pane-own" / "sessions"
    _write_jsonl(own_sessions / "2026" / "05" / "27" / "rollout-b.jsonl", [
        {"type": "session_meta", "payload": {"cwd": "/w"}},
    ])

    reader = CodexLogReader()
    roots = reader.project_dirs()
    files = reader.session_files()

    assert [r for r in roots if r.resolve() == default_sessions.resolve()] == [default_sessions]
    assert own_sessions in roots
    resolved = [f.resolve() for f in files]
    assert len(resolved) == len(set(resolved)) == 2
    watched = [w.resolve() for w in reader.watch_dirs()]
    assert len(watched) == len(set(watched))


def test_malformed_lines_do_not_abort(fake_codex_session: Path) -> None:
    reader = CodexLogReader()
    fake_codex_session.parent.mkdir(parents=True, exist_ok=True)
    fake_codex_session.write_text(
        '{not valid json\n'
        + json.dumps(_token_count_event(50, 0, 25, 0)) + "\n"
        + "another garbage line\n",
        encoding="utf-8",
    )
    events = reader.parse_session_file(fake_codex_session, set())
    assert len(events) == 1


def test_missing_payload_info_skipped(fake_codex_session: Path) -> None:
    reader = CodexLogReader()
    _write_jsonl(fake_codex_session, [
        {"type": "event_msg", "payload": {"type": "token_count", "info": None}},
        {"type": "event_msg", "payload": {"type": "token_count"}},  # no info at all
    ])
    events = reader.parse_session_file(fake_codex_session, set())
    assert events == []


def test_incremental_parse_persists_offset_and_cumulative_baseline(
    fake_codex_session: Path,
) -> None:
    reader = CodexLogReader()
    _write_jsonl(fake_codex_session, [
        {"type": "session_meta", "payload": {"cwd": "/x", "id": "session-1"}},
        _token_count_event(100, 0, 50, 0),
    ])
    parsed1 = reader.parse_incremental(fake_codex_session, {})
    assert [(e.input_tokens, e.output_tokens) for e in parsed1.events] == [(100, 50)]
    first_offset = parsed1.checkpoint["offset"]

    with fake_codex_session.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(_token_count_event(140, 0, 65, 0)) + "\n")
    parsed2 = reader.parse_incremental(fake_codex_session, parsed1.checkpoint)
    assert [(e.input_tokens, e.output_tokens) for e in parsed2.events] == [(40, 15)]
    assert parsed2.checkpoint["offset"] > first_offset
    assert parsed2.checkpoint["input_total"] == 140
    assert parsed2.checkpoint["output_total"] == 65


def test_incremental_parse_handles_truncation_without_negative_delta(
    fake_codex_session: Path,
) -> None:
    reader = CodexLogReader()
    _write_jsonl(fake_codex_session, [_token_count_event(500, 0, 200, 0)])
    first = reader.parse_incremental(fake_codex_session, {})
    _write_jsonl(fake_codex_session, [_token_count_event(50, 0, 30, 0)])
    rotated = reader.parse_incremental(fake_codex_session, first.checkpoint)
    assert rotated.events == []
    assert rotated.checkpoint["input_total"] == 50
    assert rotated.checkpoint["output_total"] == 30


def test_incremental_parse_counts_replaced_file_as_new_generation(
    fake_codex_session: Path,
) -> None:
    reader = CodexLogReader()
    _write_jsonl(fake_codex_session, [_token_count_event(500, 0, 200, 0)])
    first = reader.parse_incremental(fake_codex_session, {})

    replacement = fake_codex_session.with_suffix(".replacement")
    _write_jsonl(replacement, [_token_count_event(700, 0, 300, 0)])
    replacement.replace(fake_codex_session)
    replaced = reader.parse_incremental(fake_codex_session, first.checkpoint)
    assert [(e.input_tokens, e.output_tokens) for e in replaced.events] == [(700, 300)]
    assert replaced.checkpoint["identity"] != first.checkpoint["identity"]


# ── parse_activity: assistant turn text ──────────────────────────────────────
# token_count is Codex's turn boundary; the turn's text comes from the last
# assistant response_item / agent_message seen before it. User input_text
# (kickoff, which quotes the sentinel) must never surface as event text.

def test_parse_activity_token_count_carries_last_assistant_text(
    fake_codex_session: Path,
) -> None:
    _write_jsonl(fake_codex_session, [
        {
            "timestamp": "2026-07-22T13:25:24Z",
            "type": "session_meta",
            "payload": {"cwd": "/tmp/demo"},
        },
        {
            "timestamp": "2026-07-22T13:25:25Z",
            "type": "response_item",
            "payload": {
                "type": "message", "role": "user",
                "content": [{"type": "input_text", "text": "完成後輸出 ---TEST-DONE---\n---TEST-DONE---"}],
            },
        },
        {
            "timestamp": "2026-07-22T13:26:00Z",
            "type": "response_item",
            "payload": {
                "type": "message", "role": "assistant",
                "content": [{"type": "output_text", "text": "測試完成\n---TEST-DONE---"}],
            },
        },
        _token_count_event(100, 0, 50, 0),
        _task_complete_event(),
    ])
    reader = CodexLogReader()
    seen: set[str] = set()
    events = reader.parse_activity(fake_codex_session, seen)

    turns = [e for e in events if e.event_type == "turn_complete"]
    assert len(turns) == 1
    assert turns[0].text == "測試完成\n---TEST-DONE---"


def test_parse_activity_text_rides_user_events_and_turn_complete(
    fake_codex_session: Path,
) -> None:
    # User agent_active events carry the typed prompt (pane naming);
    # assistant/other agent_active events stay text-less (so a tool-heavy
    # turn doesn't broadcast text on every line); turn_complete carries the
    # turn's assistant text.
    _write_jsonl(fake_codex_session, [
        {
            "timestamp": "2026-07-22T13:25:00Z",
            "type": "event_msg",
            "payload": {"type": "user_message", "message": "Fix the login bug"},
        },
        {
            "timestamp": "2026-07-22T13:26:00Z",
            "type": "event_msg",
            "payload": {"type": "agent_message", "message": "Reply body"},
        },
        _token_count_event(100, 0, 50, 0),
        _task_complete_event(),
    ])
    reader = CodexLogReader()
    seen: set[str] = set()
    events = reader.parse_activity(fake_codex_session, seen)
    user_events = [
        e for e in events
        if e.event_type == "agent_active" and e.detail == "user_message"
    ]
    assert [e.text for e in user_events] == ["Fix the login bug"]
    assert all(
        e.text == "" for e in events
        if e.event_type == "agent_active" and e.detail != "user_message"
    )
    turns = [e for e in events if e.event_type == "turn_complete"]
    assert [e.text for e in turns] == ["Reply body"]


def test_parse_activity_last_text_persists_across_poll_batches(
    fake_codex_session: Path,
) -> None:
    # The assistant message and its task_complete boundary can land in different
    # poll batches; the persisted last_text must still reach turn_complete.
    _write_jsonl(fake_codex_session, [
        {
            "timestamp": "2026-07-22T13:26:00Z",
            "type": "response_item",
            "payload": {
                "type": "message", "role": "assistant",
                "content": [{"type": "output_text", "text": "測試完成\n---TEST-DONE---"}],
            },
        },
    ])
    reader = CodexLogReader()
    seen: set[str] = set()
    # Batch 1: only the assistant message is present yet.
    first = reader.parse_activity(fake_codex_session, seen)
    assert not [e for e in first if e.event_type == "turn_complete"]
    # Batch 2: the task_complete boundary appends later.
    with fake_codex_session.open("a", encoding="utf-8") as f:
        f.write(json.dumps(_task_complete_event()) + "\n")
    second = reader.parse_activity(fake_codex_session, seen)
    turns = [e for e in second if e.event_type == "turn_complete"]
    assert len(turns) == 1
    assert turns[0].text == "測試完成\n---TEST-DONE---"


def test_parse_activity_user_message_carries_prompt_text(
    fake_codex_session: Path,
) -> None:
    """A typed prompt (event_msg user_message) rides on its own agent_active
    event, truncated to 500 chars, so the frontend can name the pane from the
    first user text. "<...>"-wrapped injected stubs and other event_msg types
    stay text-less."""
    _write_jsonl(fake_codex_session, [
        {"timestamp": "2026-07-22T13:25:00Z", "type": "event_msg",
         "payload": {"type": "user_message", "message": "Fix the login bug"}},
        {"timestamp": "2026-07-22T13:25:01Z", "type": "event_msg",
         "payload": {"type": "user_message",
                     "message": "<user_instructions>injected</user_instructions>"}},
        {"timestamp": "2026-07-22T13:25:02Z", "type": "event_msg",
         "payload": {"type": "user_message", "message": "p" * 600}},
        {"timestamp": "2026-07-22T13:25:03Z", "type": "event_msg",
         "payload": {"type": "agent_message", "message": "Reply body"}},
    ])
    reader = CodexLogReader()
    events = reader.parse_activity(fake_codex_session, set())
    assert [(e.detail, e.text) for e in events] == [
        ("user_message", "Fix the login bug"),
        ("user_message", ""),
        ("user_message", "p" * 500),
        ("agent_message", ""),
    ]


def _item_completed_user(text: str | None, ts: str, *, image: bool = False) -> dict:
    """The prompt record shape codex-cli 0.155 writes: no `user_message`
    event; the prompt completes as an `item_completed` with a `UserMessage`
    item whose text sits in `content` blocks (images as `local_image`)."""
    content: list[dict] = []
    if image:
        content.append({"type": "local_image", "path": "/tmp/shot.png"})
    if text is not None:
        content.append({"type": "text", "text": text, "text_elements": []})
    return {"timestamp": ts, "type": "event_msg",
            "payload": {"type": "item_completed", "thread_id": "t", "turn_id": "u",
                        "item": {"type": "UserMessage", "id": "m", "content": content}}}


def test_parse_activity_item_completed_user_message_carries_prompt_text(
    fake_codex_session: Path,
) -> None:
    """Rollouts written by codex-cli 0.155 have no `user_message` event at
    all — the typed prompt only appears as an `item_completed` UserMessage —
    so the pane went unnamed for every Codex session. That shape must reach
    the frontend under the same detail ("user_message") it keys on, with the
    same "<"-stub filter; an image-only prompt and a completed AgentMessage
    stay text-less."""
    _write_jsonl(fake_codex_session, [
        _item_completed_user("Fix the login bug", "2026-09-18T15:00:00Z"),
        _item_completed_user("<!-- agent-team-session: at-pane:x -->", "2026-09-18T15:00:01Z"),
        _item_completed_user("[Image #1] 為什麼沒有反應", "2026-09-18T15:00:02Z", image=True),
        _item_completed_user(None, "2026-09-18T15:00:03Z", image=True),
        {"timestamp": "2026-09-18T15:00:04Z", "type": "event_msg",
         "payload": {"type": "item_completed", "item": {
             "type": "AgentMessage", "id": "a",
             "content": [{"type": "Text", "text": "Reply body"}]}}},
    ])
    reader = CodexLogReader()
    events = reader.parse_activity(fake_codex_session, set())
    assert [(e.detail, e.text) for e in events] == [
        ("user_message", "Fix the login bug"),
        ("user_message", ""),
        ("user_message", "[Image #1] 為什麼沒有反應"),
        ("user_message", ""),
        ("item_completed", ""),
    ]


def test_parse_activity_later_batch_keeps_session_meta_cwd(
    fake_codex_session: Path,
) -> None:
    """session_meta is the first record, so every poll after the first starts
    below it; the turn_complete must still carry the header's cwd or
    attribution drops it."""
    _write_jsonl(fake_codex_session, [
        {"type": "session_meta", "payload": {"cwd": "/home/x/work"}},
        {"timestamp": "2026-09-18T15:00:00Z", "type": "event_msg",
         "payload": {"type": "task_started", "turn_id": "u1"}},
    ])
    reader = CodexLogReader()
    seen: set[str] = set()
    reader.parse_activity(fake_codex_session, seen)
    with fake_codex_session.open("a", encoding="utf-8") as f:
        f.write(json.dumps(_task_complete_event("done")) + "\n")
    turns = [e for e in reader.parse_activity(fake_codex_session, seen)
             if e.event_type == "turn_complete"]
    assert [e.cwd for e in turns] == ["/home/x/work"]


def test_parse_activity_turn_ends_at_task_complete_not_token_count(
    fake_codex_session: Path,
) -> None:
    """token_count fires once per model call — after every tool call inside
    a turn — so ending the turn there raised "done" mid-turn. The turn ends
    at task_complete (text: the stashed assistant reply, else the event's
    own last_agent_message) or at turn_aborted (Esc; nothing to judge)."""
    _write_jsonl(fake_codex_session, [
        {"timestamp": "2026-09-18T15:00:00Z", "type": "event_msg",
         "payload": {"type": "task_started", "turn_id": "u1"}},
        _token_count_event(100, 0, 50, 0),
        {"timestamp": "2026-09-18T15:00:02Z", "type": "response_item",
         "payload": {"type": "custom_tool_call", "name": "shell"}},
        _token_count_event(200, 0, 80, 0),
        _token_count_event(300, 0, 90, 0),
        _task_complete_event("Only in the event", ts="2026-09-18T15:00:05Z"),
        {"timestamp": "2026-09-18T15:00:06Z", "type": "event_msg",
         "payload": {"type": "agent_message", "message": "Partial"}},
        {"timestamp": "2026-09-18T15:00:07Z", "type": "event_msg",
         "payload": {"type": "turn_aborted", "turn_id": "u2", "reason": "interrupted"}},
    ])
    reader = CodexLogReader()
    events = reader.parse_activity(fake_codex_session, set())
    turns = [e for e in events if e.event_type == "turn_complete"]
    assert [(e.detail, e.text, e.timestamp) for e in turns] == [
        ("task_complete", "Only in the event", "2026-09-18T15:00:05Z"),
        ("turn_aborted", "", "2026-09-18T15:00:07Z"),
    ]


# ── parse_activity: the seen_keys bag stays O(1) ─────────────────────────────
# It lives as long as the rollout does, so a walk must leave one high-water
# mark in it, never a key per line (GitHub #23).

def _long_rollout(path: Path, turns: int) -> int:
    """Write `turns` user/assistant/token_count cycles; return the line count."""
    records: list[dict] = [
        {"timestamp": "2026-07-22T13:25:24Z", "type": "session_meta",
         "payload": {"cwd": "/tmp/demo"}},
    ]
    for i in range(turns):
        records.append({
            "timestamp": f"2026-07-22T13:25:{i % 60:02d}Z", "type": "event_msg",
            "payload": {"type": "user_message", "message": f"ask {i}"},
        })
        records.append({
            "timestamp": f"2026-07-22T13:26:{i % 60:02d}Z", "type": "event_msg",
            "payload": {"type": "agent_message", "message": f"reply {i}"},
        })
        records.append(_token_count_event(100, 0, 50, 0))
        records.append(_task_complete_event(f"reply {i}"))
    _write_jsonl(path, records)
    return len(records)


def test_parse_activity_seen_keys_stay_constant_size(
    fake_codex_session: Path,
) -> None:
    reader = CodexLogReader()
    lines = _long_rollout(fake_codex_session, 200)
    seen: set[str] = set()

    reader.parse_activity(fake_codex_session, seen)

    assert [k for k in seen if k.startswith("act:")] == []
    assert len([k for k in seen if k.startswith("act_hw::")]) == 1
    assert activity_high_water(seen) == lines


def test_parse_activity_reparse_does_not_reemit(fake_codex_session: Path) -> None:
    reader = CodexLogReader()
    _long_rollout(fake_codex_session, 200)
    seen: set[str] = set()

    assert reader.parse_activity(fake_codex_session, seen) != []
    assert reader.parse_activity(fake_codex_session, seen) == []


def test_parse_activity_appended_line_keeps_its_dedup_key(
    fake_codex_session: Path,
) -> None:
    reader = CodexLogReader()
    lines = _long_rollout(fake_codex_session, 3)
    seen: set[str] = set()
    reader.parse_activity(fake_codex_session, seen)

    with fake_codex_session.open("a", encoding="utf-8") as f:
        f.write(json.dumps({
            "timestamp": "2026-07-22T13:30:00Z", "type": "event_msg",
            "payload": {"type": "user_message", "message": "one more"},
        }) + "\n")
    fresh = reader.parse_activity(fake_codex_session, seen)

    assert [(e.event_type, e.detail) for e in fresh] == [
        ("agent_active", "user_message"),
    ]
    assert fresh[0].dedup_key == f"act:{lines + 1}"
    assert activity_high_water(seen) == lines + 1


def test_parse_activity_last_text_sentinel_coexists_with_the_mark(
    fake_codex_session: Path,
) -> None:
    """The persisted assistant text shares the bag with the mark; neither may
    evict the other (the split-batch delivery above depends on it)."""
    reader = CodexLogReader()
    _write_jsonl(fake_codex_session, [
        {"timestamp": "2026-07-22T13:26:00Z", "type": "event_msg",
         "payload": {"type": "agent_message", "message": "Reply body"}},
    ])
    seen: set[str] = set()
    reader.parse_activity(fake_codex_session, seen)

    assert seen == {"act_hw::1", "__lasttext__:Reply body"}

    with fake_codex_session.open("a", encoding="utf-8") as f:
        f.write(json.dumps(_task_complete_event()) + "\n")
    turns = [
        e for e in reader.parse_activity(fake_codex_session, seen)
        if e.event_type == "turn_complete"
    ]
    assert [e.text for e in turns] == ["Reply body"]


def _meta(cwd: str) -> dict:
    return {"type": "session_meta", "payload": {"cwd": cwd}}


def _expire_files_cache(reader: CodexLogReader) -> None:
    # The scan cache spans one rescan cycle; tests fast-forward past the TTL.
    reader._files_cached_at = float("-inf")


def test_session_files_reuses_scan_within_ttl(fake_codex_session: Path) -> None:
    reader = CodexLogReader()
    _write_jsonl(fake_codex_session, [_meta("/ws")])
    assert len(reader.session_files()) == 1

    sibling = fake_codex_session.with_name("rollout-second.jsonl")
    _write_jsonl(sibling, [_meta("/ws")])
    # Still inside the TTL: the cached sweep is served, the new file unseen.
    assert len(reader.session_files()) == 1
    _expire_files_cache(reader)
    assert len(reader.session_files()) == 2


def test_cwd_header_is_read_once_and_cached(fake_codex_session: Path) -> None:
    reader = CodexLogReader()
    _write_jsonl(fake_codex_session, [_meta("/ws")])
    assert reader.session_files_for_workspace("/ws") == [fake_codex_session]

    # Rewriting the header must not matter: session_meta is immutable in real
    # rollouts, so the cached cwd keeps serving without reopening the file.
    _write_jsonl(fake_codex_session, [_meta("/other")])
    _expire_files_cache(reader)
    assert reader.session_files_for_workspace("/ws") == [fake_codex_session]
    assert reader.session_files_for_workspace("/other") == []


def test_missing_header_is_retried_not_cached(fake_codex_session: Path) -> None:
    reader = CodexLogReader()
    # Header not landed yet (rollout mid-write): no meta record at all.
    _write_jsonl(fake_codex_session, [_token_count_event(1, 0, 1, 0)])
    assert reader.session_files_for_workspace("/ws") == []

    _write_jsonl(fake_codex_session, [_meta("/ws"), _token_count_event(1, 0, 1, 0)])
    _expire_files_cache(reader)
    assert reader.session_files_for_workspace("/ws") == [fake_codex_session]


def test_stale_missing_header_is_negatively_cached(fake_codex_session: Path) -> None:
    reader = CodexLogReader()
    _write_jsonl(fake_codex_session, [_token_count_event(1, 0, 1, 0)])
    stale = time.time() - CodexLogReader._HEADER_GRACE_S - 1
    os.utime(fake_codex_session, (stale, stale))
    assert reader.session_files_for_workspace("/ws") == []

    # The miss is cached: a real rollout only appends, so an old headerless
    # file never gains a header — even this rewrite must not be re-read.
    _write_jsonl(fake_codex_session, [_meta("/ws")])
    _expire_files_cache(reader)
    assert reader.session_files_for_workspace("/ws") == []


def test_deleted_rollout_drops_its_negative_header_cache(
    fake_codex_session: Path,
) -> None:
    reader = CodexLogReader()
    _write_jsonl(fake_codex_session, [_token_count_event(1, 0, 1, 0)])
    stale = time.time() - CodexLogReader._HEADER_GRACE_S - 1
    os.utime(fake_codex_session, (stale, stale))
    assert reader.session_files_for_workspace("/ws") == []

    fake_codex_session.unlink()
    _expire_files_cache(reader)
    assert reader.session_files() == []  # prunes the stale miss entry

    # Same path reborn as a fresh rollout must be read for real.
    _write_jsonl(fake_codex_session, [_meta("/ws")])
    _expire_files_cache(reader)
    assert reader.session_files_for_workspace("/ws") == [fake_codex_session]


def test_deleted_rollout_drops_its_header_cache(fake_codex_session: Path) -> None:
    reader = CodexLogReader()
    _write_jsonl(fake_codex_session, [_meta("/ws1")])
    assert reader.session_files_for_workspace("/ws1") == [fake_codex_session]

    fake_codex_session.unlink()
    _expire_files_cache(reader)
    assert reader.session_files() == []  # prunes the stale header entry

    # Same path reborn with a different cwd must be read fresh.
    _write_jsonl(fake_codex_session, [_meta("/ws2")])
    _expire_files_cache(reader)
    assert reader.session_files_for_workspace("/ws2") == [fake_codex_session]
    assert reader.session_files_for_workspace("/ws1") == []


# ── turns_for_session (tokens.turns) ────────────────────────────────────────

def _user_message(text: str, ts: str) -> dict:
    return {"timestamp": ts, "type": "event_msg",
            "payload": {"type": "user_message", "message": text, "images": []}}


def _count(ts: str, input_t: int, cached_in: int, output_t: int, reasoning_out: int) -> dict:
    ev = _token_count_event(input_t, cached_in, output_t, reasoning_out)
    ev["timestamp"] = ts
    return ev


def test_turns_open_at_item_completed_user_message(
    fake_codex_session: Path,
) -> None:
    """The 0.155 prompt shape cuts turns exactly like the old user_message
    event did — without it every call would collapse into one prompt-less
    turn."""
    reader = CodexLogReader()
    _write_jsonl(fake_codex_session, [
        {"type": "session_meta", "payload": {"cwd": "/x", "id": "thread-1", "model": "gpt-5"}},
        _item_completed_user("幫我分析", "2026-09-18T13:00:01Z"),
        _count("2026-09-18T13:00:05Z", 1000, 400, 50, 10),
        _item_completed_user("再來", "2026-09-18T13:10:00Z", image=True),
        _count("2026-09-18T13:10:04Z", 1100, 450, 60, 10),
    ])
    turns = reader.turns_for_session(fake_codex_session)
    assert [(t.turn_index, t.prompt_excerpt, t.call_count) for t in turns] == [
        (1, "幫我分析", 1), (2, "再來", 1),
    ]


def test_turns_open_at_user_message_and_difference_every_token_count(
    fake_codex_session: Path,
) -> None:
    """A real rollout fires token_count once per model call, many per turn
    (21 for 2 prompts in the sample transcript), so the user_message record
    is the turn boundary and each token_count delta is one call. Codex's
    input_tokens already contains cached_input_tokens and output_tokens
    already contains reasoning, so the counters are split, not added."""
    reader = CodexLogReader()
    _write_jsonl(fake_codex_session, [
        {"type": "session_meta", "payload": {"cwd": "/x", "id": "thread-1", "model": "gpt-5"}},
        {"timestamp": "2026-05-27T13:00:00Z", "type": "event_msg",
         "payload": {"type": "token_count", "info": None}},  # rate-limit only
        _user_message("幫我分析", "2026-05-27T13:00:01Z"),
        _count("2026-05-27T13:00:05Z", 1000, 400, 50, 10),
        _count("2026-05-27T13:00:09Z", 2500, 1600, 120, 30),
        _user_message("再來", "2026-05-27T13:10:00Z"),
        _count("2026-05-27T13:10:04Z", 2600, 1650, 130, 30),
    ])
    assert reader.turns_method == "exact"
    turns = reader.turns_for_session(fake_codex_session)
    assert [(t.turn_index, t.prompt_excerpt, t.call_count) for t in turns] == [
        (1, "幫我分析", 2), (2, "再來", 1),
    ]
    first, second = turns
    assert first.started_at == "2026-05-27T13:00:01Z"
    assert first.ended_at == "2026-05-27T13:00:09Z"
    assert [(c.input, c.cache_read, c.cache_creation, c.output) for c in first.calls] == [
        (600, 400, 0, 50), (300, 1200, 0, 70),
    ]
    assert first.total == 2500 + 120
    assert (second.input, second.cache_read, second.output) == (50, 50, 10)
    assert first.calls[0].model == "gpt-5"
    assert first.session_id == "thread-1"
    # The whole file adds up to the CLI's own last cumulative total.
    assert sum(t.total for t in turns) == 2600 + 130


def test_turns_fall_back_to_one_per_token_count_without_user_messages(
    fake_codex_session: Path,
) -> None:
    reader = CodexLogReader()
    _write_jsonl(fake_codex_session, [
        {"type": "session_meta", "payload": {"cwd": "/x"}},
        _count("2026-05-27T13:00:05Z", 100, 0, 10, 0),
        _count("2026-05-27T13:00:09Z", 250, 0, 30, 0),
    ])
    turns = reader.turns_for_session(fake_codex_session)
    assert [(t.turn_index, t.prompt_excerpt, t.total) for t in turns] == [(1, "", 110), (2, "", 170)]


def test_turns_skip_a_shrunk_total_instead_of_going_negative(
    fake_codex_session: Path,
) -> None:
    reader = CodexLogReader()
    _write_jsonl(fake_codex_session, [
        {"type": "session_meta", "payload": {"cwd": "/x"}},
        _user_message("a", "2026-05-27T13:00:01Z"),
        _count("2026-05-27T13:00:05Z", 100, 0, 10, 0),
        _count("2026-05-27T13:00:09Z", 40, 0, 4, 0),   # rotated: new baseline
        _count("2026-05-27T13:00:12Z", 70, 0, 9, 0),
    ])
    turns = reader.turns_for_session(fake_codex_session)
    assert [(c.input, c.output) for c in turns[0].calls] == [(100, 10), (30, 5)]


def test_turns_answer_to_the_file_stem_as_well_as_the_session_meta_id(
    fake_codex_session: Path,
) -> None:
    """A rollout has two names: session_meta's id (what the live registry
    carries) and the file stem (what session_id_from_path answers, so what a
    bare tokens.turns lookup finds the file by). Filtering on either must
    return the rollout; a third id is not this session."""
    reader = CodexLogReader()
    _write_jsonl(fake_codex_session, [
        {"type": "session_meta", "payload": {"cwd": "/x", "id": "thread-1"}},
        _user_message("a", "2026-05-27T13:00:01Z"),
        _count("2026-05-27T13:00:05Z", 100, 0, 10, 0),
    ])
    assert len(reader.turns_for_session(fake_codex_session, "thread-1")) == 1
    assert len(reader.turns_for_session(fake_codex_session, "rollout-test")) == 1
    assert reader.turns_for_session(fake_codex_session, "thread-9") == []


def test_parse_activity_resumes_after_an_append(fake_codex_session: Path, monkeypatch) -> None:
    from tests.activity_resume_support import assert_resumes

    def turn(prompt: str, reply: str) -> list[dict]:
        return [
            {"timestamp": "2026-07-22T13:25:00Z", "type": "event_msg",
             "payload": {"type": "user_message", "message": prompt}},
            {"timestamp": "2026-07-22T13:26:00Z", "type": "event_msg",
             "payload": {"type": "agent_message", "message": reply}},
            _token_count_event(100, 0, 50, 0),
            _task_complete_event(),
        ]

    _write_jsonl(fake_codex_session, turn("first", "one"))
    assert_resumes(CodexLogReader, fake_codex_session, turn("second", "two"), monkeypatch)
