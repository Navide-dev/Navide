"""ClaudeLogReader: parse real-shape JSONL with dedup + cache folding."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.cli_vendors.claude import ClaudeLogReader


def _write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


@pytest.fixture
def fake_claude(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[ClaudeLogReader, Path]:
    """Pin CLAUDE_CONFIG_DIR to tmp_path so the reader uses our fixture."""
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path))
    return ClaudeLogReader(), tmp_path / "projects"


def test_project_dirs_picks_up_env_override(fake_claude: tuple[ClaudeLogReader, Path]) -> None:
    reader, root = fake_claude
    root.mkdir(parents=True)
    dirs = reader.project_dirs()
    assert root in dirs


def test_parses_assistant_usage(fake_claude: tuple[ClaudeLogReader, Path]) -> None:
    reader, root = fake_claude
    session = root / "-tmp-demo" / "abc-123.jsonl"
    _write_jsonl(session, [
        {"type": "mode", "mode": "normal"},   # ignored
        {
            "type": "assistant",
            "sessionId": "abc-123",
            "requestId": "req_42",
            "timestamp": "2026-05-28T00:00:00Z",
            "message": {
                "id": "msg_1",
                "model": "claude-opus-4-7",
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 50,
                    "cache_read_input_tokens": 30,
                    "cache_creation_input_tokens": 5,
                },
            },
        },
    ])
    seen: set[str] = set()
    events = reader.parse_session_file(session, seen)
    assert len(events) == 1
    ev = events[0]
    assert ev.vendor == "claude"
    # input = 100 + 30 + 5 (cache folded in)
    assert ev.input_tokens == 135
    assert ev.output_tokens == 50
    assert ev.cwd == "/tmp/demo"
    assert ev.model == "claude-opus-4-7"


def test_dedup_by_message_id_plus_request_id(fake_claude: tuple[ClaudeLogReader, Path]) -> None:
    reader, root = fake_claude
    session = root / "-x" / "s1.jsonl"
    # Same message.id+requestId appears twice (streaming chunk repeat).
    base = {
        "type": "assistant",
        "requestId": "req_1",
        "message": {"id": "msg_1", "usage": {"input_tokens": 10, "output_tokens": 5}},
    }
    _write_jsonl(session, [base, base])
    seen: set[str] = set()
    events = reader.parse_session_file(session, seen)
    assert len(events) == 1


def test_seen_keys_persist_across_calls(fake_claude: tuple[ClaudeLogReader, Path]) -> None:
    reader, root = fake_claude
    session = root / "-x" / "s1.jsonl"
    _write_jsonl(session, [
        {"type": "assistant", "requestId": "r1",
         "message": {"id": "m1", "usage": {"input_tokens": 10, "output_tokens": 5}}},
    ])
    seen: set[str] = set()
    events1 = reader.parse_session_file(session, seen)
    events2 = reader.parse_session_file(session, seen)
    assert len(events1) == 1
    assert len(events2) == 0   # already in seen_keys


def test_distinct_message_ids_both_recorded(fake_claude: tuple[ClaudeLogReader, Path]) -> None:
    reader, root = fake_claude
    session = root / "-x" / "s1.jsonl"
    _write_jsonl(session, [
        {"type": "assistant", "requestId": "r1",
         "message": {"id": "m1", "usage": {"input_tokens": 10, "output_tokens": 5}}},
        {"type": "assistant", "requestId": "r2",
         "message": {"id": "m2", "usage": {"input_tokens": 20, "output_tokens": 8}}},
    ])
    events = reader.parse_session_file(session, set())
    assert len(events) == 2
    assert events[0].input_tokens == 10
    assert events[1].input_tokens == 20


def test_malformed_line_does_not_abort(fake_claude: tuple[ClaudeLogReader, Path]) -> None:
    reader, root = fake_claude
    session = root / "-x" / "s1.jsonl"
    session.parent.mkdir(parents=True, exist_ok=True)
    session.write_text(
        '{"type":"assistant","message":{"id":"m1","usage":{"input_tokens":7,"output_tokens":3}},"requestId":"r1"}\n'
        '{not valid json\n'
        '{"type":"assistant","message":{"id":"m2","usage":{"input_tokens":11,"output_tokens":2}},"requestId":"r2"}\n',
        encoding="utf-8",
    )
    events = reader.parse_session_file(session, set())
    assert len(events) == 2


def test_skips_lines_without_usage(fake_claude: tuple[ClaudeLogReader, Path]) -> None:
    reader, root = fake_claude
    session = root / "-x" / "s1.jsonl"
    _write_jsonl(session, [
        {"type": "assistant", "message": {"id": "m1"}, "requestId": "r1"},  # no usage
        {"type": "user", "message": {"id": "u1", "usage": {"input_tokens": 5}}, "requestId": "r2"},  # wrong type
    ])
    events = reader.parse_session_file(session, set())
    assert events == []


def test_zero_zero_event_skipped(fake_claude: tuple[ClaudeLogReader, Path]) -> None:
    reader, root = fake_claude
    session = root / "-x" / "s1.jsonl"
    _write_jsonl(session, [
        {"type": "assistant", "requestId": "r1",
         "message": {"id": "m1", "usage": {"input_tokens": 0, "output_tokens": 0}}},
    ])
    events = reader.parse_session_file(session, set())
    assert events == []


def test_cwd_reverses_from_dir_name_unambiguous(fake_claude: tuple[ClaudeLogReader, Path]) -> None:
    """When the path has no literal dashes in segments, decode is exact."""
    reader, root = fake_claude
    session = root / "-Users-example-Desktop-AgentTeam" / "s.jsonl"
    _write_jsonl(session, [
        {"type": "assistant", "requestId": "r1",
         "message": {"id": "m1", "usage": {"input_tokens": 1, "output_tokens": 1}}},
    ])
    events = reader.parse_session_file(session, set())
    assert events[0].cwd == "/Users/example/Desktop/AgentTeam"


def test_cwd_decoder_known_ambiguity_in_dashed_segments(fake_claude: tuple[ClaudeLogReader, Path]) -> None:
    """If the original cwd had a literal '-', the decoded form loses it
    (becomes '/'). Documented limitation; attribution layer should match via
    forward encoding instead of trusting this decoded string."""
    reader, root = fake_claude
    # Original cwd would be /Users/example/Desktop/Agent-Team — encoded the same
    # as /Users/example/Desktop/Agent/Team. The decoder picks the slash form.
    session = root / "-Users-example-Desktop-Agent-Team" / "s.jsonl"
    _write_jsonl(session, [
        {"type": "assistant", "requestId": "r1",
         "message": {"id": "m1", "usage": {"input_tokens": 1, "output_tokens": 1}}},
    ])
    events = reader.parse_session_file(session, set())
    # All '-' get decoded to '/' — this is the known ambiguity.
    assert events[0].cwd == "/Users/example/Desktop/Agent/Team"


def test_session_files_enumerates_all(fake_claude: tuple[ClaudeLogReader, Path]) -> None:
    reader, root = fake_claude
    (root / "-a").mkdir(parents=True)
    (root / "-a" / "s1.jsonl").write_text("", encoding="utf-8")
    (root / "-a" / "s2.jsonl").write_text("", encoding="utf-8")
    (root / "-b").mkdir(parents=True)
    (root / "-b" / "s3.jsonl").write_text("", encoding="utf-8")
    # Non-jsonl should be ignored.
    (root / "-a" / "readme.txt").write_text("", encoding="utf-8")
    files = reader.session_files()
    assert len(files) == 3
    assert {f.name for f in files} == {"s1.jsonl", "s2.jsonl", "s3.jsonl"}


def test_incremental_parse_reads_only_appended_complete_lines(
    fake_claude: tuple[ClaudeLogReader, Path]
) -> None:
    reader, root = fake_claude
    session = root / "-x" / "s1.jsonl"
    first = {
        "type": "assistant", "requestId": "r1",
        "message": {"id": "m1", "usage": {"input_tokens": 10, "output_tokens": 5}},
    }
    second = {
        "type": "assistant", "requestId": "r2",
        "message": {"id": "m2", "usage": {"input_tokens": 20, "output_tokens": 7}},
    }
    _write_jsonl(session, [first])
    parsed1 = reader.parse_incremental(session, {})
    assert len(parsed1.events) == 1
    first_offset = parsed1.checkpoint["offset"]

    with session.open("ab") as fh:
        fh.write(json.dumps(second).encode())  # partial: no newline yet
    partial = reader.parse_incremental(session, parsed1.checkpoint)
    assert partial.events == []
    assert partial.checkpoint["offset"] == first_offset

    with session.open("ab") as fh:
        fh.write(b"\n")
    parsed2 = reader.parse_incremental(session, partial.checkpoint)
    assert [(e.input_tokens, e.output_tokens) for e in parsed2.events] == [(20, 7)]
    assert len(parsed2.checkpoint["recent_keys"]) <= 64


# ── parse_activity: assistant turn text ──────────────────────────────────────
# The pipeline judges sentinel/QUESTION on turn_complete text only. Role
# separation is the core property: kickoff (user record) must never surface
# as turn_complete text, even when it quotes the sentinel — that echo is what
# falsely completed stages when detection read the rendered terminal output
# instead. User prompts ride on their own agent_active "user" events (the
# frontend names the pane from the first one) and never mix into turn text.

def test_parse_activity_turn_complete_carries_assistant_text(
    fake_claude: tuple[ClaudeLogReader, Path],
) -> None:
    reader, root = fake_claude
    session = root / "-tmp-demo" / "abc-123.jsonl"
    _write_jsonl(session, [
        {
            "type": "user",
            "timestamp": "2026-07-22T13:23:27Z",
            "message": {"content": "完成後，最後一行只輸出 ---SPEC-DONE---\n---SPEC-DONE---"},
        },
        {
            "type": "assistant",
            "timestamp": "2026-07-22T13:24:00Z",
            "message": {
                "stop_reason": "end_turn",
                "content": [{"type": "text", "text": "規格完成。\n---SPEC-DONE---"}],
            },
        },
    ])
    seen: set[str] = set()
    events = reader.parse_activity(session, seen)

    turns = [e for e in events if e.event_type == "turn_complete"]
    assert len(turns) == 1
    assert turns[0].text == "規格完成。\n---SPEC-DONE---"

    user_events = [e for e in events if e.detail == "user"]
    # The kickoff rides on its own agent_active event (pane naming) and never
    # leaks into the turn_complete text judged above.
    assert user_events and all(e.event_type == "agent_active" for e in user_events)
    assert user_events[0].text == (
        "完成後，最後一行只輸出 ---SPEC-DONE---\n---SPEC-DONE---"
    )


def test_parse_activity_compaction_summary_is_not_a_prompt(
    fake_claude: tuple[ClaudeLogReader, Path],
) -> None:
    """An idle auto-compaction writes its summary as a plain-string `user`
    record, and no assistant turn follows it. Carried as prompt text, it reached
    the channel mirror as a local prompt and opened a chat run that no
    turn_complete would ever close (MSG_STILL_RUNNING, then silence)."""
    reader, root = fake_claude
    session = root / "-tmp-demo" / "cmp-001.jsonl"
    _write_jsonl(session, [
        {
            "type": "system",
            "subtype": "compact_boundary",
            "timestamp": "2026-10-13T19:48:18.020Z",
            "compactMetadata": {"trigger": "auto"},
        },
        {
            "type": "user",
            "timestamp": "2026-10-13T19:48:18.019Z",
            "isCompactSummary": True,
            "isVisibleInTranscriptOnly": True,
            "message": {
                "role": "user",
                "content": "This session is being continued from a previous conversation "
                "that ran out of context. The summary below covers the earlier portion.",
            },
        },
    ])
    seen: set[str] = set()
    events = reader.parse_activity(session, seen)

    user_events = [e for e in events if e.detail == "user"]
    assert len(user_events) == 1
    assert user_events[0].event_type == "agent_active"
    assert user_events[0].text == ""


def test_parse_activity_text_joins_only_text_blocks(
    fake_claude: tuple[ClaudeLogReader, Path],
) -> None:
    reader, root = fake_claude
    session = root / "-tmp-demo" / "def-456.jsonl"
    _write_jsonl(session, [
        {
            "type": "assistant",
            "timestamp": "2026-07-22T13:24:00Z",
            "message": {
                "stop_reason": "end_turn",
                "content": [
                    {"type": "text", "text": "第一段"},
                    {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}},
                    {"type": "text", "text": "---PLAN-DONE---"},
                ],
            },
        },
    ])
    seen: set[str] = set()
    events = reader.parse_activity(session, seen)
    turns = [e for e in events if e.event_type == "turn_complete"]
    assert turns[0].text == "第一段\n---PLAN-DONE---"


# ── parse_activity: AskUserQuestion ──────────────────────────────────────────
# The tool that puts a multiple-choice question to the user pauses the turn
# with stop_reason=tool_use, so it produces NO turn_complete and no text. Left
# unnamed, the pane simply falls silent and the frontend reads it as idle —
# the one case where nothing at all happens until the user acts.

def test_parse_activity_names_ask_user_question(
    fake_claude: tuple[ClaudeLogReader, Path],
) -> None:
    reader, root = fake_claude
    session = root / "-tmp-demo" / "q-001.jsonl"
    _write_jsonl(session, [
        {
            "type": "assistant",
            "timestamp": "2026-08-14T02:10:00Z",
            "message": {
                "stop_reason": "tool_use",
                "content": [
                    {
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "AskUserQuestion",
                        "input": {"questions": [{"question": "要選哪一個？"}]},
                    },
                ],
            },
        },
    ])
    seen: set[str] = set()
    events = reader.parse_activity(session, seen)

    # No turn ended, so no turn_complete — this is exactly why the extra
    # event is needed.
    assert [e for e in events if e.event_type == "turn_complete"] == []
    questions = [e for e in events if e.detail == "assistant:question"]
    assert len(questions) == 1
    assert questions[0].event_type == "agent_active"
    # Rides ALONGSIDE the plain assistant event rather than replacing it, so
    # liveness tracking is untouched.
    assert any(e.detail == "assistant" for e in events)
    # Distinct dedup key or the two would collapse into one.
    assert questions[0].dedup_key != next(
        e.dedup_key for e in events if e.detail == "assistant"
    )


def test_parse_activity_ignores_other_tools(
    fake_claude: tuple[ClaudeLogReader, Path],
) -> None:
    reader, root = fake_claude
    session = root / "-tmp-demo" / "q-002.jsonl"
    _write_jsonl(session, [
        {
            "type": "assistant",
            "timestamp": "2026-08-14T02:11:00Z",
            "message": {
                "stop_reason": "tool_use",
                "content": [
                    {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}},
                ],
            },
        },
    ])
    seen: set[str] = set()
    events = reader.parse_activity(session, seen)
    assert [e for e in events if e.detail == "assistant:question"] == []


def test_parse_activity_question_survives_text_alongside_it(
    fake_claude: tuple[ClaudeLogReader, Path],
) -> None:
    # Claude routinely writes a paragraph and THEN opens the question box, so
    # the tool_use block is not necessarily the only content.
    reader, root = fake_claude
    session = root / "-tmp-demo" / "q-003.jsonl"
    _write_jsonl(session, [
        {
            "type": "assistant",
            "timestamp": "2026-08-14T02:12:00Z",
            "message": {
                "stop_reason": "tool_use",
                "content": [
                    {"type": "text", "text": "兩個做法："},
                    {"type": "tool_use", "name": "AskUserQuestion", "input": {}},
                ],
            },
        },
    ])
    seen: set[str] = set()
    events = reader.parse_activity(session, seen)
    assert len([e for e in events if e.detail == "assistant:question"]) == 1


def test_parse_activity_text_rides_user_events_and_turn_complete(
    fake_claude: tuple[ClaudeLogReader, Path],
) -> None:
    reader, root = fake_claude
    session = root / "-tmp-demo" / "ghi-789.jsonl"
    _write_jsonl(session, [
        {
            "type": "user",
            "timestamp": "2026-07-22T13:23:00Z",
            "message": {"content": "Fix the login bug"},
        },
        {
            "type": "assistant",
            "timestamp": "2026-07-22T13:24:00Z",
            "message": {
                "stop_reason": "end_turn",
                "content": [{"type": "text", "text": "完成\n---SPEC-DONE---"}],
            },
        },
    ])
    seen: set[str] = set()
    events = reader.parse_activity(session, seen)
    # User agent_active events carry the typed prompt (pane naming);
    # assistant/tool agent_active events stay text-less; turn_complete
    # carries the assistant turn text (sentinel/question judgment).
    user_events = [
        e for e in events
        if e.event_type == "agent_active" and e.detail == "user"
    ]
    assert [e.text for e in user_events] == ["Fix the login bug"]
    assert all(
        e.text == "" for e in events
        if e.event_type == "agent_active" and e.detail != "user"
    )
    turns = [e for e in events if e.event_type == "turn_complete"]
    assert turns[0].text == "完成\n---SPEC-DONE---"


def test_parse_activity_user_text_only_for_real_prompts(
    fake_claude: tuple[ClaudeLogReader, Path],
) -> None:
    """A real human prompt (plain-string content, non-empty, not a "<...>"
    wrapper — same test as first_user_prompts) rides on its agent_active
    event, truncated to 500 chars; tool_result lists, command wrappers and
    tool_use records stay text-less."""
    reader, root = fake_claude
    session = root / "-tmp-demo" / "jkl-012.jsonl"
    _write_jsonl(session, [
        {"type": "user", "timestamp": "t1",
         "message": {"content": "Fix the login bug"}},
        {"type": "user", "timestamp": "t2",
         "message": {"content": [{"type": "tool_result", "content": "ok"}]}},
        {"type": "user", "timestamp": "t3",
         "message": {"content": "<command-name>/loop</command-name>"}},
        {"type": "tool_use", "timestamp": "t4"},
        {"type": "user", "timestamp": "t5", "message": {"content": "p" * 600}},
    ])
    events = reader.parse_activity(session, set())
    assert [(e.detail, e.text) for e in events] == [
        ("user", "Fix the login bug"),
        ("user", ""),
        ("user", ""),
        ("tool_use", ""),
        ("user", "p" * 500),
    ]


# Real shapes from Claude Code 2.1.x transcripts.
_IMAGE_BLOCK = {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo="}}
_IMAGE_NOTE = ("[Image: original 780x3746, displayed at 416x2000. "
               "Multiply coordinates by 1.88 to map to original image.]")


def test_parse_activity_image_read_notes_are_not_prompts(
    fake_claude: tuple[ClaudeLogReader, Path],
) -> None:
    """The agent's Read of an image is followed by a hidden isMeta user record whose
    plain-string content is the size note; nobody typed it, so it carries no text
    (it posted as "你：[Image: original ...]" in chat channels, once per image)."""
    reader, root = fake_claude
    session = root / "-tmp-demo" / "img-001.jsonl"
    _write_jsonl(session, [
        {"type": "assistant", "timestamp": "t1", "message": {"content": [
            {"type": "tool_use", "id": "toolu_1", "name": "Read", "input": {"file_path": "/tmp/shot.png"}}]}},
        {"type": "user", "timestamp": "t2", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "toolu_1", "content": [_IMAGE_BLOCK]}]}},
        {"type": "user", "timestamp": "t3", "isMeta": True, "turnCompanion": True,
         "message": {"role": "user", "content": _IMAGE_NOTE}},
    ])
    events = reader.parse_activity(session, set())
    assert [e.text for e in events if e.detail == "user"] == ["", ""]


def test_parse_activity_pasted_images_keep_the_typed_text(
    fake_claude: tuple[ClaudeLogReader, Path],
) -> None:
    """A prompt with pasted images is a content list (text plus image blocks); its
    typed text, markers included, is the prompt. It used to be dropped whole, and
    the isMeta list after it stays text-less."""
    reader, root = fake_claude
    session = root / "-tmp-demo" / "img-002.jsonl"
    _write_jsonl(session, [
        {"type": "user", "timestamp": "t1", "imagePasteIds": [5, 6], "origin": {"kind": "human"},
         "message": {"role": "user", "content": [
             {"type": "text", "text": "[Image #5] [Image #6] 為什麼看不到圖片"}, _IMAGE_BLOCK, _IMAGE_BLOCK]}},
        {"type": "user", "timestamp": "t2", "isMeta": True,
         "message": {"role": "user", "content": [{"type": "text", "text": _IMAGE_NOTE}]}},
        {"type": "user", "timestamp": "t3",
         "message": {"role": "user", "content": [{"type": "text", "text": "Continue from where you left off."}]}},
    ])
    events = reader.parse_activity(session, set())
    texts = [e.text for e in events if e.detail == "user"]
    assert texts == ["[Image #5] [Image #6] 為什麼看不到圖片", "", ""]
    assert texts[0].full == "[Image #5] [Image #6] 為什麼看不到圖片"


def test_join_text_blocks_shared_helper() -> None:
    from agent_team_backend.log_readers.base import join_text_blocks
    assert join_text_blocks("plain", "text") == "plain"
    assert join_text_blocks(
        [{"type": "text", "text": "a"}, {"type": "tool_use"}, {"type": "text", "text": "b"}],
        "text",
    ) == "a\nb"
    assert join_text_blocks([{"type": "output_text", "text": "x"}], "output_text") == "x"
    assert join_text_blocks([{"type": "text", "text": "x"}], "output_text") == ""
    assert join_text_blocks(None, "text") == ""


# ── turns_for_session (tokens.turns) ────────────────────────────────────────

def _prompt_line(prompt_id: str, text, ts: str, **extra) -> dict:  # noqa: ANN001
    return {
        "type": "user", "promptId": prompt_id, "timestamp": ts,
        "message": {"role": "user", "content": text}, **extra,
    }


def _tool_result_line(prompt_id: str, ts: str) -> dict:
    return {
        "type": "user", "promptId": prompt_id, "timestamp": ts, "toolUseResult": {"ok": True},
        "message": {"role": "user", "content": [{"type": "tool_result", "content": "done"}]},
    }


def _assistant_line(msg_id: str, req_id: str, ts: str, *, inp: int, cr: int, cc: int, out: int,
                    stop: str = "tool_use") -> dict:
    return {
        "type": "assistant", "requestId": req_id, "timestamp": ts,
        "message": {
            "id": msg_id, "model": "claude-opus-4-7", "stop_reason": stop,
            "content": [{"type": "text", "text": "…"}],
            "usage": {
                "input_tokens": inp, "cache_read_input_tokens": cr,
                "cache_creation_input_tokens": cc, "output_tokens": out,
            },
        },
    }


def test_turns_group_on_prompt_id_and_keep_the_four_counters_apart(
    fake_claude: tuple[ClaudeLogReader, Path],
) -> None:
    """One turn = one promptId, however many API calls (and tool results) it
    spans. A streamed message split over two lines (same id + requestId)
    counts once, and cache is NOT folded into input."""
    reader, root = fake_claude
    session = root / "-tmp-demo" / "turns-1.jsonl"
    _write_jsonl(session, [
        _prompt_line("p1", "幫我修 login bug", "2026-09-16T00:00:00Z"),
        _assistant_line("m1", "r1", "2026-09-16T00:00:01Z", inp=2, cr=100, cc=40, out=10),
        _assistant_line("m1", "r1", "2026-09-16T00:00:02Z", inp=2, cr=100, cc=40, out=10),  # streamed dup
        _tool_result_line("p1", "2026-09-16T00:00:03Z"),
        _assistant_line("m2", "r2", "2026-09-16T00:00:05Z", inp=3, cr=200, cc=0, out=20, stop="end_turn"),
        _prompt_line("p2", [{"type": "text", "text": "再來一次"}, {"type": "image"}], "2026-09-16T00:01:00Z"),
        _assistant_line("m3", "r3", "2026-09-16T00:01:04Z", inp=1, cr=300, cc=5, out=7, stop="end_turn"),
    ])
    assert reader.turns_method == "exact"
    turns = reader.turns_for_session(session)
    assert [t.turn_index for t in turns] == [1, 2]
    first, second = turns
    assert (first.input, first.cache_read, first.cache_creation, first.output) == (5, 300, 40, 30)
    assert first.total == 375
    assert first.call_count == 2
    assert first.prompt_excerpt == "幫我修 login bug"
    assert first.started_at == "2026-09-16T00:00:00Z"
    assert first.ended_at == "2026-09-16T00:00:05Z"
    assert [c.model for c in first.calls] == ["claude-opus-4-7", "claude-opus-4-7"]
    # List content: the text blocks make the excerpt, the image is skipped.
    assert second.prompt_excerpt == "再來一次"
    assert (second.input, second.cache_read, second.cache_creation, second.output) == (1, 300, 5, 7)
    assert second.session_id == "turns-1"


def test_turns_keep_a_prompts_attachments_and_prefer_the_typed_text(
    fake_claude: tuple[ClaudeLogReader, Path],
) -> None:
    """Extra user records under the same promptId (isMeta attachments, a
    session marker written before the typed prompt) stay in the turn, and a
    "<"-prefixed wrapper only stands in for the excerpt until typed text
    arrives."""
    reader, root = fake_claude
    session = root / "-tmp-demo" / "turns-2.jsonl"
    _write_jsonl(session, [
        _prompt_line("p1", "<!-- agent-team-session: at-pane:x -->", "2026-09-16T00:00:00Z", isMeta=True),
        _prompt_line("p1", "真正的提示", "2026-09-16T00:00:00.5Z"),
        _prompt_line("p1", [{"type": "text", "text": "Base directory for this skill: …"}],
                     "2026-09-16T00:00:01Z", isMeta=True),
        _assistant_line("m1", "r1", "2026-09-16T00:00:02Z", inp=1, cr=0, cc=0, out=1, stop="end_turn"),
    ])
    turns = reader.turns_for_session(session)
    assert len(turns) == 1
    assert turns[0].prompt_excerpt == "真正的提示"
    assert turns[0].started_at == "2026-09-16T00:00:00Z"


def test_turns_follow_a_resumed_session_appended_to_the_same_file(
    fake_claude: tuple[ClaudeLogReader, Path],
) -> None:
    """`claude --resume` keeps writing the same transcript: new promptIds
    simply become new turns after the old ones, and a prompt that never got
    an answer (interrupted) is not a turn."""
    reader, root = fake_claude
    session = root / "-tmp-demo" / "turns-3.jsonl"
    _write_jsonl(session, [
        _prompt_line("p1", "first", "2026-09-16T00:00:00Z"),
        _assistant_line("m1", "r1", "2026-09-16T00:00:01Z", inp=1, cr=10, cc=0, out=1, stop="end_turn"),
        _prompt_line("p2", "interrupted", "2026-09-16T00:00:02Z"),
    ])
    assert [t.prompt_excerpt for t in reader.turns_for_session(session)] == ["first"]
    with session.open("a", encoding="utf-8") as f:
        for rec in [
            {"type": "summary", "summary": "resumed"},
            _prompt_line("p3", "after resume", "2026-09-16T01:00:00Z"),
            _assistant_line("m2", "r2", "2026-09-16T01:00:01Z", inp=4, cr=20, cc=0, out=2),
            _assistant_line("m3", "r3", "2026-09-16T01:00:02Z", inp=4, cr=24, cc=0, out=3, stop="end_turn"),
        ]:
            f.write(json.dumps(rec) + "\n")
    turns = reader.turns_for_session(session)
    assert [(t.turn_index, t.prompt_excerpt, t.call_count) for t in turns] == [
        (1, "first", 1), (2, "after resume", 2),
    ]
    assert turns[1].total == 4 + 20 + 2 + 4 + 24 + 3
    assert turns[1].ended_at == "2026-09-16T01:00:02Z"


def test_turns_excerpt_is_capped_at_eighty_chars(fake_claude: tuple[ClaudeLogReader, Path]) -> None:
    reader, root = fake_claude
    session = root / "-tmp-demo" / "turns-4.jsonl"
    _write_jsonl(session, [
        _prompt_line("p1", "x" * 200, "2026-09-16T00:00:00Z"),
        _assistant_line("m1", "r1", "2026-09-16T00:00:01Z", inp=1, cr=0, cc=0, out=1, stop="end_turn"),
    ])
    assert reader.turns_for_session(session)[0].prompt_excerpt == "x" * 80


# ── parse_activity: background tasks ─────────────────────────────────────────
# A background shell or async subagent outlives the turn that launched it: the
# main turn still ends with end_turn, so the pane would read as idle while the
# work runs. Shapes below are copied from real Claude Code transcripts.

def _bg_events(events: list) -> list[tuple[str, str]]:
    return [(e.detail, e.text) for e in events if e.detail.startswith("background:")]


def test_parse_activity_reports_background_task_starts(
    fake_claude: tuple[ClaudeLogReader, Path],
) -> None:
    reader, root = fake_claude
    session = root / "-tmp-demo" / "bg-001.jsonl"
    _write_jsonl(session, [
        {   # run_in_background, or a foreground call moved there by its timeout
            "type": "user",
            "message": {"role": "user", "content": [{"type": "tool_result", "content": "Command running in background with ID: bry177hz1."}]},
            "toolUseResult": {"stdout": "", "stderr": "", "backgroundTaskId": "bry177hz1"},
        },
        {   # async subagent
            "type": "user",
            "message": {"role": "user", "content": [{"type": "tool_result", "content": "launched"}]},
            "toolUseResult": {"isAsync": True, "status": "async_launched", "agentId": "ae01b1c4f25790113"},
        },
        {   # a skill forked into the background
            "type": "user",
            "message": {"role": "user", "content": [{"type": "tool_result", "content": "forked"}]},
            "toolUseResult": {"status": "forked", "background": True, "agentId": "a7cee2f1e1012cd3d"},
        },
        {   # a foreground subagent that finished inside the turn
            "type": "user",
            "message": {"role": "user", "content": [{"type": "tool_result", "content": "done"}]},
            "toolUseResult": {"status": "completed", "agentId": "a111"},
        },
    ])
    events = reader.parse_activity(session, set())
    assert _bg_events(events) == [
        ("background:start", "bry177hz1"),
        ("background:start", "ae01b1c4f25790113"),
        ("background:start", "a7cee2f1e1012cd3d"),
    ]
    # Rides alongside the plain user event, under its own dedup key.
    starts = [e for e in events if e.detail == "background:start"]
    assert all(e.event_type == "agent_active" for e in starts)
    assert len({e.dedup_key for e in events}) == len(events)


def test_parse_activity_reports_background_task_ends(
    fake_claude: tuple[ClaudeLogReader, Path],
) -> None:
    reader, root = fake_claude
    session = root / "-tmp-demo" / "bg-002.jsonl"
    _write_jsonl(session, [
        {
            "type": "queue-operation", "operation": "enqueue",
            "content": "<task-notification>\n<task-id>blntq0tve</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n<summary>Background command completed (exit code 0)</summary>\n</task-notification>",
        },
        {   # the matching dequeue must not end it twice
            "type": "queue-operation", "operation": "remove",
            "content": "<task-notification>\n<task-id>blntq0tve</task-id>\n<status>completed</status>\n</task-notification>",
        },
        {   # a Monitor event has no status: its task keeps running
            "type": "queue-operation", "operation": "enqueue",
            "content": "<task-notification>\n<task-id>b6j9g94mm</task-id>\n<summary>Monitor event</summary>\n<event>FAIL x</event>\n</task-notification>",
        },
        {   # tasks orphaned by the previous process, ended in one record
            "type": "queue-operation", "operation": "enqueue",
            "content": "<task-notification>\n<task-id>bowyhridg</task-id>\n<task-id>bmon1anlz</task-id>\n<status>stopped</status>\n</task-notification>",
        },
        {   # the agent stopping a task itself leaves no notification
            "type": "assistant",
            "message": {"stop_reason": "tool_use", "content": [
                {"type": "tool_use", "id": "toolu_2", "name": "TaskStop", "input": {"task_id": "bcne01h0f"}},
            ]},
        },
    ])
    events = reader.parse_activity(session, set())
    assert _bg_events(events) == [
        ("background:end", "blntq0tve"),
        ("background:end", "bowyhridg\nbmon1anlz"),
        ("background:end", "bcne01h0f"),
    ]
    assert all(e.event_type == "agent_active" for e in events if e.detail == "background:end")
    # No turn ended anywhere in here.
    assert [e for e in events if e.event_type == "turn_complete"] == []
