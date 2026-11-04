"""KimiLogReader: per-turn usage summing + state.json cwd + session-dir id."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.cli_vendors.kimi import KimiLogReader
from agent_team_backend.log_readers.base import activity_high_water

_SID = "session_4d4a11fe-b08a-46df-9f86-685589531e65"


def _write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


def _usage(input_other: int, cache_read: int, output: int,
           cache_creation: int = 0, time: int = 1784440875298) -> dict:
    return {
        "type": "usage.record",
        "model": "kimi-code/kimi-for-coding",
        "usage": {
            "inputOther": input_other,
            "output": output,
            "inputCacheRead": cache_read,
            "inputCacheCreation": cache_creation,
        },
        "usageScope": "turn",
        "time": time,
    }


@pytest.fixture
def fake_kimi_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / ".kimi-code"
    monkeypatch.setenv("KIMI_CODE_HOME", str(home))
    return home


def _session(home: Path, workdir: str, session_id: str = _SID,
             workspace_dir: str = "wd_test_abc") -> Path:
    """Create a session dir with state.json, return its wire.jsonl path."""
    sdir = home / "sessions" / workspace_dir / session_id
    state = sdir / "state.json"
    state.parent.mkdir(parents=True, exist_ok=True)
    state.write_text(
        json.dumps({"workDir": workdir, "title": "New Session"}),
        encoding="utf-8",
    )
    return sdir / "agents" / "main" / "wire.jsonl"


def test_input_folds_cache_output_is_plain(fake_kimi_home: Path) -> None:
    reader = KimiLogReader()
    wire = _session(fake_kimi_home, "/Users/me/proj")
    _write_jsonl(wire, [
        {"type": "metadata", "protocol_version": "1.4", "created_at": 1},
        {"type": "turn.prompt", "input": [{"type": "text", "text": "hi"}], "time": 2},
        _usage(2193, 17920, 218, cache_creation=5),
    ])
    events = reader.parse_session_file(wire, set())
    assert len(events) == 1
    ev = events[0]
    # input = inputOther + inputCacheRead + inputCacheCreation
    assert ev.input_tokens == 2193 + 17920 + 5
    assert ev.output_tokens == 218
    assert ev.vendor == "kimi"
    assert ev.cwd == "/Users/me/proj"
    assert ev.session_id == _SID
    assert ev.model == "kimi-code/kimi-for-coding"


def test_each_usage_record_is_its_own_turn_not_a_delta(fake_kimi_home: Path) -> None:
    """Kimi usage.record is a PER-TURN delta (usageScope=turn), not a cumulative
    total like Codex. Two records are emitted verbatim; the second's output can
    be SMALLER than the first — proof they are not cumulative."""
    reader = KimiLogReader()
    wire = _session(fake_kimi_home, "/x")
    _write_jsonl(wire, [
        _usage(3139, 19200, 152, time=10),
        _usage(264, 22272, 79, time=20),   # output 152 → 79: only valid if per-turn
    ])
    events = reader.parse_session_file(wire, set())
    assert len(events) == 2
    assert (events[0].input_tokens, events[0].output_tokens) == (3139 + 19200, 152)
    assert (events[1].input_tokens, events[1].output_tokens) == (264 + 22272, 79)


def test_reparse_same_file_dedups(fake_kimi_home: Path) -> None:
    reader = KimiLogReader()
    seen: set[str] = set()
    wire = _session(fake_kimi_home, "/x")
    _write_jsonl(wire, [_usage(100, 0, 50, time=1)])
    first = reader.parse_session_file(wire, seen)
    assert len(first) == 1
    # Same content, same seen set → no re-emission.
    assert reader.parse_session_file(wire, seen) == []


def test_zero_usage_skipped(fake_kimi_home: Path) -> None:
    reader = KimiLogReader()
    wire = _session(fake_kimi_home, "/x")
    _write_jsonl(wire, [_usage(0, 0, 0)])
    assert reader.parse_session_file(wire, set()) == []


def test_malformed_lines_do_not_abort(fake_kimi_home: Path) -> None:
    reader = KimiLogReader()
    wire = _session(fake_kimi_home, "/x")
    wire.parent.mkdir(parents=True, exist_ok=True)
    wire.write_text(
        "{not valid json\n"
        + json.dumps(_usage(50, 0, 25)) + "\n"
        + "garbage\n",
        encoding="utf-8",
    )
    events = reader.parse_session_file(wire, set())
    assert len(events) == 1
    assert events[0].input_tokens == 50


def test_missing_workdir_state_yields_empty_cwd(fake_kimi_home: Path) -> None:
    reader = KimiLogReader()
    # Build the wire file without a state.json alongside it.
    sdir = fake_kimi_home / "sessions" / "wd_x" / _SID
    wire = sdir / "agents" / "main" / "wire.jsonl"
    _write_jsonl(wire, [_usage(10, 0, 5)])
    events = reader.parse_session_file(wire, set())
    assert events[0].cwd == ""


def test_session_files_globs_the_layout(fake_kimi_home: Path) -> None:
    reader = KimiLogReader()
    wire = _session(fake_kimi_home, "/x")
    _write_jsonl(wire, [_usage(10, 0, 5)])
    found = reader.session_files()
    assert wire in found


def test_session_files_for_workspace_filters_by_workdir(fake_kimi_home: Path) -> None:
    reader = KimiLogReader()
    wire_a = _session(fake_kimi_home, "/proj/a", session_id="session_aaa", workspace_dir="wd_a")
    wire_b = _session(fake_kimi_home, "/proj/b", session_id="session_bbb", workspace_dir="wd_b")
    _write_jsonl(wire_a, [_usage(10, 0, 5)])
    _write_jsonl(wire_b, [_usage(10, 0, 5)])
    only_a = reader.session_files_for_workspace("/proj/a")
    assert wire_a in only_a
    assert wire_b not in only_a


def test_incremental_parse_offset_advances(fake_kimi_home: Path) -> None:
    reader = KimiLogReader()
    wire = _session(fake_kimi_home, "/x")
    _write_jsonl(wire, [_usage(100, 0, 50, time=1)])
    parsed1 = reader.parse_incremental(wire, {})
    assert [(e.input_tokens, e.output_tokens) for e in parsed1.events] == [(100, 50)]
    first_offset = parsed1.checkpoint["offset"]

    with wire.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(_usage(40, 0, 15, time=2)) + "\n")
    parsed2 = reader.parse_incremental(wire, parsed1.checkpoint)
    # Per-turn: emit the appended record verbatim, not a delta.
    assert [(e.input_tokens, e.output_tokens) for e in parsed2.events] == [(40, 15)]
    assert parsed2.checkpoint["offset"] > first_offset


def test_incremental_parse_reads_only_the_tail(fake_kimi_home: Path) -> None:
    reader = KimiLogReader()
    wire = _session(fake_kimi_home, "/x")
    _write_jsonl(wire, [_usage(100, 0, 50, time=1)])
    parsed1 = reader.parse_incremental(wire, {})
    # No new bytes → nothing re-emitted.
    parsed2 = reader.parse_incremental(wire, parsed1.checkpoint)
    assert parsed2.events == []


def test_session_id_from_path_uses_dir_name_not_stem(fake_kimi_home: Path) -> None:
    """The resume id must be the session_<uuid> dir name, never the filename
    stem ("wire") — and sibling files (state.json, logs) are not session files
    so they return '' and the resume sink skips them (regression for the
    `kimi --session wire` / `--session state` resume failures)."""
    reader = KimiLogReader()
    wire = _session(fake_kimi_home, "/x")
    _write_jsonl(wire, [_usage(10, 0, 5)])
    assert reader.session_id_from_path(wire) == _SID
    # sibling files in the same session dir are NOT session files
    state = wire.parent.parent.parent / "state.json"
    assert reader.session_id_from_path(state) == ""
    log_file = wire.parent / "kimi-code.log"
    assert reader.session_id_from_path(log_file) == ""


def test_has_session_accepts_real_id_rejects_bogus(fake_kimi_home: Path) -> None:
    """Resume preflight guard: a real session_<uuid> dir resolves True; bogus
    ids (the "wire"/"state" that a pre-fix record could carry) resolve False so
    they never launch a doomed `kimi --session <id>`."""
    reader = KimiLogReader()
    wire = _session(fake_kimi_home, "/x")  # creates the session dir for _SID
    _write_jsonl(wire, [_usage(10, 0, 5)])
    assert reader.has_session(_SID) is True
    assert reader.has_session("wire") is False
    assert reader.has_session("state") is False
    assert reader.has_session("") is False
    assert reader.has_session("session_does-not-exist") is False


def _prompt(text: str = "hi", time: int = 1) -> dict:
    return {"type": "turn.prompt", "input": [{"type": "text", "text": text}], "time": time}


def test_parse_activity_flushes_latest_turn_on_idle(fake_kimi_home: Path) -> None:
    """With no following prompt, the latest turn is completed once the file has
    been quiet for _TURN_IDLE_MS. Record times here are tiny, so wall-clock now
    is far past the idle threshold → exactly one idle-flushed turn_complete."""
    reader = KimiLogReader()
    wire = _session(fake_kimi_home, "/x")
    _write_jsonl(wire, [_prompt(time=1), _usage(10, 0, 5, time=2)])
    events = reader.parse_activity(wire, set())
    kinds = [(e.event_type, e.detail) for e in events]
    assert ("agent_active", "prompt") in kinds
    assert ("agent_active", "usage") in kinds
    assert ("turn_complete", "idle") in kinds


def test_parse_activity_one_turn_many_usage_records_one_complete(
    fake_kimi_home: Path,
) -> None:
    """A single user turn spans many usage.record lines (one per agentic step);
    it must yield exactly ONE turn_complete, not one per usage.record."""
    reader = KimiLogReader()
    wire = _session(fake_kimi_home, "/x")
    _write_jsonl(wire, [
        _prompt(time=1),
        _usage(10, 0, 5, time=2),
        _usage(20, 0, 8, time=3),
        _usage(30, 0, 9, time=4),
    ])
    events = reader.parse_activity(wire, set())
    completes = [e for e in events if e.event_type == "turn_complete"]
    assert len(completes) == 1
    assert completes[0].dedup_key == "turn:0"


def test_parse_activity_two_turns_two_completes(fake_kimi_home: Path) -> None:
    """Two user prompts → two turns. The first is closed by the second prompt
    (detail 'boundary'); the latest is idle-flushed. Distinct dedup keys."""
    reader = KimiLogReader()
    wire = _session(fake_kimi_home, "/x")
    _write_jsonl(wire, [
        _prompt(time=1),
        _usage(10, 0, 5, time=2),
        _usage(11, 0, 6, time=3),
        _prompt(time=10),
        _usage(20, 0, 8, time=11),
    ])
    events = reader.parse_activity(wire, set())
    completes = [e for e in events if e.event_type == "turn_complete"]
    assert [(e.dedup_key, e.detail) for e in completes] == [
        ("turn:0", "boundary"),
        ("turn:1", "idle"),
    ]


def test_parse_activity_turn_cancel_completes_the_turn(fake_kimi_home: Path) -> None:
    reader = KimiLogReader()
    wire = _session(fake_kimi_home, "/x")
    _write_jsonl(wire, [
        _prompt(time=1),
        _usage(10, 0, 5, time=2),
        {"type": "turn.cancel", "time": 3},
    ])
    events = reader.parse_activity(wire, set())
    completes = [e for e in events if e.event_type == "turn_complete"]
    assert len(completes) == 1
    assert completes[0].detail == "cancel"
    assert completes[0].dedup_key == "turn:0"


def test_parse_activity_open_turn_not_flushed_while_recent(
    fake_kimi_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An open turn whose last record is more recent than _TURN_IDLE_MS is NOT
    completed yet — the CLI may still be mid-turn."""
    import agent_team_backend.cli_vendors.kimi as kimi_mod

    reader = KimiLogReader()
    wire = _session(fake_kimi_home, "/x")
    _write_jsonl(wire, [_prompt(time=1_000_000), _usage(10, 0, 5, time=1_000_000)])
    # now is only 1s past the last record → below the 8s idle threshold.
    monkeypatch.setattr(kimi_mod.time, "time", lambda: 1_001.0)
    events = reader.parse_activity(wire, set())
    assert [e for e in events if e.event_type == "turn_complete"] == []


def test_parse_activity_prompt_carries_user_text(fake_kimi_home: Path) -> None:
    """turn.prompt events carry the prompt's joined text blocks (truncated to
    500 chars) for pane naming; the injected "<...>"-prefixed session-marker
    bootstrap and usage.record events stay text-less."""
    reader = KimiLogReader()
    wire = _session(fake_kimi_home, "/x")
    _write_jsonl(wire, [
        _prompt("<!-- agent-team-session: at-pane:p1 -->", time=1),
        _prompt("fix the login bug", time=2),
        _usage(10, 0, 5, time=3),
        _prompt("p" * 600, time=4),
    ])
    events = reader.parse_activity(wire, set())
    prompts = [e for e in events if e.detail == "prompt"]
    assert [e.text for e in prompts] == ["", "fix the login bug", "p" * 500]
    assert all(e.text == "" for e in events if e.detail == "usage")


def _text_part(text: str, *, time: int) -> dict:
    """A content.part loop event carrying the assistant's visible reply."""
    return {
        "type": "context.append_loop_event",
        "event": {"type": "content.part", "part": {"type": "text", "text": text}},
        "time": time,
    }


def test_parse_activity_turn_complete_carries_the_assistant_reply(
    fake_kimi_home: Path,
) -> None:
    """The inter-CLI messaging protocol is only parsed out of a turn_complete
    that has text, so the closing reply has to ride on it."""
    reader = KimiLogReader()
    wire = _session(fake_kimi_home, "/x")
    _write_jsonl(wire, [
        _prompt(time=1),
        {
            "type": "context.append_loop_event",
            "event": {"type": "content.part", "part": {"type": "think", "text": "hmm"}},
            "time": 2,
        },
        _text_part("first pass", time=3),
        _usage(10, 0, 5, time=4),
        _text_part("done, handing over", time=5),
    ])
    completes = [
        e for e in reader.parse_activity(wire, set()) if e.event_type == "turn_complete"
    ]
    assert len(completes) == 1
    # The closing text part wins, and `think` parts never leak into it.
    assert completes[0].text == "done, handing over"


def test_parse_activity_reply_survives_a_poll_boundary(
    fake_kimi_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """content.part and the turn's close often land in different polls, so the
    text is persisted in seen_keys between them."""
    reader = KimiLogReader()
    seen: set[str] = set()
    wire = _session(fake_kimi_home, "/x")
    _write_jsonl(wire, [_prompt(time=1_000_000), _text_part("ready", time=1_000_001)])
    import agent_team_backend.cli_vendors.kimi as kimi_mod

    # First poll: still mid-turn, nothing completed, text not delivered yet.
    monkeypatch.setattr(kimi_mod.time, "time", lambda: 1_000.5)
    assert [e for e in reader.parse_activity(wire, seen) if e.event_type == "turn_complete"] == []

    # Second poll after the idle window: the turn flushes with the earlier text.
    monkeypatch.setattr(kimi_mod.time, "time", lambda: 1_100.0)
    completes = [
        e for e in reader.parse_activity(wire, seen) if e.event_type == "turn_complete"
    ]
    assert [(e.detail, e.text) for e in completes] == [("idle", "ready")]


def test_parse_activity_reply_does_not_leak_into_the_next_turn(
    fake_kimi_home: Path,
) -> None:
    reader = KimiLogReader()
    wire = _session(fake_kimi_home, "/x")
    _write_jsonl(wire, [
        _prompt(time=1),
        _text_part("answer one", time=2),
        _prompt(time=10),
        _usage(20, 0, 8, time=11),
    ])
    completes = [
        e for e in reader.parse_activity(wire, set()) if e.event_type == "turn_complete"
    ]
    assert [(e.dedup_key, e.text) for e in completes] == [
        ("turn:0", "answer one"),
        ("turn:1", ""),
    ]


def test_parse_activity_reparse_does_not_reemit(fake_kimi_home: Path) -> None:
    """Re-scanning the same file with the same seen set emits nothing new
    (turns already flushed stay flushed; seen lines are skipped)."""
    reader = KimiLogReader()
    seen: set[str] = set()
    wire = _session(fake_kimi_home, "/x")
    _write_jsonl(wire, [_prompt(time=1), _usage(10, 0, 5, time=2)])
    first = reader.parse_activity(wire, seen)
    assert any(e.event_type == "turn_complete" for e in first)
    assert reader.parse_activity(wire, seen) == []


@pytest.mark.parametrize("part_type", ["text", "think"])
def test_recent_loop_content_keeps_an_old_prompt_active(
    fake_kimi_home: Path, monkeypatch: pytest.MonkeyPatch, part_type: str,
) -> None:
    from agent_team_backend.cli_vendors import kimi

    wire = _session(fake_kimi_home, "/x")
    part = _text_part("still streaming", time=1_010_000)
    part["event"]["part"]["type"] = part_type
    _write_jsonl(wire, [_prompt(time=1_000_000), part])
    monkeypatch.setattr(kimi.time, "time", lambda: 1_010.0)
    assert not any(e.event_type == "turn_complete"
                   for e in KimiLogReader().parse_activity(wire, set()))


@pytest.mark.parametrize("resumed_usage", [False, True])
def test_activity_after_idle_flush_delivers_the_final_reply(
    fake_kimi_home: Path, monkeypatch: pytest.MonkeyPatch, resumed_usage: bool,
) -> None:
    from agent_team_backend.cli_vendors import kimi

    reader, seen = KimiLogReader(), set()
    wire = _session(fake_kimi_home, "/x")
    records = [_prompt(time=1_000_000), _text_part("first reply", time=1_000_001)]
    _write_jsonl(wire, records)
    monkeypatch.setattr(kimi.time, "time", lambda: 1_010.0)
    first = [e for e in reader.parse_activity(wire, seen) if e.event_type == "turn_complete"]
    assert [e.text for e in first] == ["first reply"]

    if resumed_usage:
        records.append(_usage(10, 0, 5, time=1_020_000))
    records.append(_text_part("final reply", time=1_020_001))
    _write_jsonl(wire, records)
    monkeypatch.setattr(kimi.time, "time", lambda: 1_021.0)
    assert not any(e.event_type == "turn_complete" for e in reader.parse_activity(wire, seen))
    monkeypatch.setattr(kimi.time, "time", lambda: 1_030.0)
    final = [e for e in reader.parse_activity(wire, seen) if e.event_type == "turn_complete"]
    assert [e.text for e in final] == ["final reply"]
    assert final[0].dedup_key != first[0].dedup_key
    assert reader.parse_activity(wire, seen) == []


def test_cancelled_turn_is_not_reopened_by_late_stream_records(
    fake_kimi_home: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agent_team_backend.cli_vendors import kimi

    reader, seen = KimiLogReader(), set()
    wire = _session(fake_kimi_home, "/x")
    records = [_prompt(time=1_000_000), {"type": "turn.cancel", "time": 1_000_001}]
    _write_jsonl(wire, records)
    monkeypatch.setattr(kimi.time, "time", lambda: 1_001.0)
    assert [e.detail for e in reader.parse_activity(wire, seen)
            if e.event_type == "turn_complete"] == ["cancel"]
    records.extend([_usage(10, 0, 5, time=1_010_000), _text_part("late", time=1_010_001)])
    _write_jsonl(wire, records)
    monkeypatch.setattr(kimi.time, "time", lambda: 1_030.0)
    assert not any(e.event_type == "turn_complete" for e in reader.parse_activity(wire, seen))


def test_cancel_after_idle_flush_still_blocks_late_content(
    fake_kimi_home: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agent_team_backend.cli_vendors import kimi

    reader, seen = KimiLogReader(), set()
    wire = _session(fake_kimi_home, "/x")
    records = [_prompt(time=1_000_000), _text_part("first reply", time=1_000_001)]
    _write_jsonl(wire, records)
    monkeypatch.setattr(kimi.time, "time", lambda: 1_010.0)
    assert any(e.event_type == "turn_complete" for e in reader.parse_activity(wire, seen))
    records.extend([
        {"type": "turn.cancel", "time": 1_020_000},
        _text_part("late", time=1_020_001),
    ])
    _write_jsonl(wire, records)
    monkeypatch.setattr(kimi.time, "time", lambda: 1_030.0)
    assert not any(e.event_type == "turn_complete" for e in reader.parse_activity(wire, seen))


# ── parse_activity: the seen_keys bag stays O(1) ─────────────────────────────
# seen_keys lives as long as wire.jsonl, which grows one usage.record per
# agentic step, so the walk must leave one high-water mark in it rather than a
# key per line (GitHub #23).

def _long_wire(wire: Path, turns: int) -> int:
    """Write `turns` prompt + two-step turns; return the line count."""
    records: list[dict] = []
    for i in range(turns):
        t = (i + 1) * 10
        records.append(_prompt(f"ask {i}", time=t))
        records.append(_text_part(f"reply {i}", time=t + 1))
        records.append(_usage(10, 0, 5, time=t + 2))
    _write_jsonl(wire, records)
    return len(records)


def test_parse_activity_seen_keys_stay_constant_size(fake_kimi_home: Path) -> None:
    reader = KimiLogReader()
    wire = _session(fake_kimi_home, "/x")
    lines = _long_wire(wire, 200)
    seen: set[str] = set()

    reader.parse_activity(wire, seen)

    assert [k for k in seen if k.startswith("act:")] == []
    assert len([k for k in seen if k.startswith("act_hw::")]) == 1
    assert activity_high_water(seen) == lines


def test_parse_activity_long_wire_reparse_does_not_reemit(
    fake_kimi_home: Path,
) -> None:
    reader = KimiLogReader()
    wire = _session(fake_kimi_home, "/x")
    _long_wire(wire, 200)
    seen: set[str] = set()

    assert reader.parse_activity(wire, seen) != []
    assert reader.parse_activity(wire, seen) == []


def test_parse_activity_appended_line_keeps_its_dedup_key(
    fake_kimi_home: Path,
) -> None:
    reader = KimiLogReader()
    wire = _session(fake_kimi_home, "/x")
    lines = _long_wire(wire, 3)
    seen: set[str] = set()
    reader.parse_activity(wire, seen)

    with wire.open("a", encoding="utf-8") as f:
        f.write(json.dumps(_usage(20, 0, 8, time=1000)) + "\n")
    fresh = reader.parse_activity(wire, seen)

    assert [(e.event_type, e.detail) for e in fresh] == [("agent_active", "usage")]
    assert fresh[0].dedup_key == f"act:{lines + 1}"
    assert activity_high_water(seen) == lines + 1


def test_parse_activity_turn_and_text_sentinels_coexist_with_the_mark(
    fake_kimi_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Turn state and the pending reply live in the same bag as the mark; the
    cross-poll delivery above depends on none of them evicting the others."""
    reader = KimiLogReader()
    seen: set[str] = set()
    wire = _session(fake_kimi_home, "/x")
    _write_jsonl(wire, [_prompt(time=1_000_000), _text_part("ready", time=1_000_001)])
    import agent_team_backend.cli_vendors.kimi as kimi_mod

    monkeypatch.setattr(kimi_mod.time, "time", lambda: 1_000.5)
    reader.parse_activity(wire, seen)

    assert len([k for k in seen if k.startswith("act_hw::")]) == 1
    assert [k for k in seen if k.startswith("kimi_text::")] == ["kimi_text::ready"]
    assert len([k for k in seen if k.startswith("kimi_turn::")]) == 1

    monkeypatch.setattr(kimi_mod.time, "time", lambda: 1_100.0)
    completes = [
        e for e in reader.parse_activity(wire, seen) if e.event_type == "turn_complete"
    ]
    assert [(e.detail, e.text) for e in completes] == [("idle", "ready")]


# ── turns_for_session: the generic cut on turn_complete timestamps ──────────

def test_turns_are_cut_on_turn_complete_timestamps(fake_kimi_home: Path) -> None:
    """Kimi has no override, so the base cut applies: each usage.record is
    assigned to the first turn_complete not earlier than it (kimi stamps the
    boundary with the previous turn's last usage time), the prompt event in
    the same window names the turn, and TokenUsage's folded input rides as
    `input` with the cache fields left 0."""
    reader = KimiLogReader()
    wire = _session(fake_kimi_home, "/x")
    _write_jsonl(wire, [
        _prompt("first question", time=1_000),
        _usage(10, 100, 5, time=2_000),
        _usage(20, 200, 8, time=3_000),
        _usage(30, 300, 9, time=4_000),
        _prompt("second question", time=10_000),
        _usage(40, 0, 1, time=11_000),
    ])
    assert reader.turns_method == "inferred"
    turns = reader.turns_for_session(wire, _SID)
    assert [(t.turn_index, t.prompt_excerpt, t.call_count) for t in turns] == [
        (1, "first question", 3), (2, "second question", 1),
    ]
    first, second = turns
    assert (first.input, first.cache_read, first.cache_creation, first.output) == (660, 0, 0, 22)
    assert first.started_at == "1970-01-01T00:00:01.000Z"   # epoch-ms → ISO
    assert first.ended_at == "1970-01-01T00:00:04.000Z"
    assert first.calls[0].model == "kimi-code/kimi-for-coding"
    assert (second.input, second.output) == (40, 1)
    assert second.started_at == "1970-01-01T00:00:10.000Z"
    assert first.session_id == _SID


def test_turns_without_any_boundary_are_one_turn(fake_kimi_home: Path) -> None:
    reader = KimiLogReader()
    wire = _session(fake_kimi_home, "/x")
    # No turn.prompt → parse_activity never opens a turn → no turn_complete.
    _write_jsonl(wire, [_usage(1, 0, 1, time=1), _usage(2, 0, 2, time=2)])
    turns = reader.turns_for_session(wire)
    assert [(t.turn_index, t.call_count, t.total, t.prompt_excerpt) for t in turns] == [(1, 2, 6, "")]


def test_parse_activity_resumes_after_an_append(fake_kimi_home: Path, monkeypatch) -> None:
    from tests.activity_resume_support import assert_resumes

    wire = _session(fake_kimi_home, "/x")
    _write_jsonl(wire, [_prompt("first", time=1), _text_part("one", time=2), _usage(10, 0, 5, time=3)])
    assert_resumes(KimiLogReader, wire, [
        _prompt("second", time=4), _text_part("two", time=5), _usage(10, 0, 5, time=6),
    ], monkeypatch)
