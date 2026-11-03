"""PiLogReader: usage mapping + header-id/cwd authority + rewrite tolerance
+ lazy-flush tolerance + attribution binding."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from agent_team_backend.log_readers.attribution import Attribution
from agent_team_backend.log_readers.base import TokenUsage, activity_high_water
from agent_team_backend.cli_vendors.pi import (
    PiLogReader,
    encode_pi_cwd,
    pi_sessions_root,
)

_SID = "pi-sess.01_a"  # exercises the full id charset incl. "_" and "."
_CWD = "/Users/me/proj"
_TS_PREFIX = "2026-07-27T10-00-00-000Z"  # ISO with [:.] → "-"


def _header(sid: str = _SID, cwd: str = _CWD) -> dict:
    return {
        "type": "session",
        "version": 3,
        "id": sid,
        "timestamp": "2026-07-27T10:00:00.000Z",
        "cwd": cwd,
    }


def _user(eid: str, content="hi", parent: str | None = None) -> dict:  # noqa: ANN001
    return {
        "type": "message",
        "id": eid,
        "parentId": parent,
        "timestamp": "2026-07-27T10:00:01.000Z",
        "message": {"role": "user", "content": content},
    }


def _assistant(eid: str, parent: str | None = None, *, input: int = 100,
               output: int = 20, cache_read: int = 0, cache_write: int = 0,
               model: str = "claude-opus-4") -> dict:
    return {
        "type": "message",
        "id": eid,
        "parentId": parent,
        "timestamp": "2026-07-27T10:00:02.000Z",
        "message": {
            "role": "assistant",
            "model": model,
            "content": [{"type": "text", "text": "ok"}],
            "usage": {
                "input": input,
                "output": output,
                "cacheRead": cache_read,
                "cacheWrite": cache_write,
                "totalTokens": input + output + cache_read + cache_write,
                "cost": {"total": 0.01},
            },
        },
    }


def _compaction(eid: str, parent: str | None = None, *, input: int = 10,
                output: int = 5) -> dict:
    """Compaction / branch-summary entries carry usage top-level."""
    return {
        "type": "compaction",
        "id": eid,
        "parentId": parent,
        "timestamp": "2026-07-27T10:00:03.000Z",
        "usage": {"input": input, "output": output,
                  "cacheRead": 0, "cacheWrite": 0},
    }


def _write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


@pytest.fixture
def fake_pi_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "pi-sessions"
    monkeypatch.setenv("PI_CODING_AGENT_SESSION_DIR", str(root))
    monkeypatch.delenv("PI_CODING_AGENT_DIR", raising=False)
    return root


def _session_file(root: Path, cwd: str = _CWD, session_id: str = _SID) -> Path:
    return root / encode_pi_cwd(cwd) / f"{_TS_PREFIX}_{session_id}.jsonl"


# ─────────────────────────── roots / encoding ────────────────────────────────

def test_sessions_root_env_precedence(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PI_CODING_AGENT_SESSION_DIR", "/tmp/sess")
    monkeypatch.setenv("PI_CODING_AGENT_DIR", "/tmp/pihome")
    assert pi_sessions_root() == Path("/tmp/sess")
    monkeypatch.delenv("PI_CODING_AGENT_SESSION_DIR")
    assert pi_sessions_root() == Path("/tmp/pihome") / "sessions"
    monkeypatch.delenv("PI_CODING_AGENT_DIR")
    assert pi_sessions_root() == Path.home() / ".pi" / "agent" / "sessions"


def test_encode_pi_cwd_replaces_only_separators() -> None:
    """Only "/", "\\" and ":" become "-" — spaces and unicode survive
    (unlike the Claude/Qwen every-non-alphanumeric encoding)."""
    assert encode_pi_cwd("/Users/x/proj") == "--Users-x-proj--"
    assert encode_pi_cwd("/Users/x/my proj.v2") == "--Users-x-my proj.v2--"
    assert encode_pi_cwd("/a:b\\c") == "--a-b-c--"


# ─────────────────────────── token parsing ───────────────────────────────────

def test_token_mapping_folds_cache_into_input(fake_pi_root: Path) -> None:
    """input = input + cacheRead + cacheWrite; output = output (no
    reasoning field); id/cwd come from the header, not the filename."""
    reader = PiLogReader()
    f = _session_file(fake_pi_root)
    _write_jsonl(f, [
        _header(),
        _user("aa000001"),
        _assistant("aa000002", "aa000001", input=100, output=20,
                   cache_read=900, cache_write=30),
    ])
    events = reader.parse_session_file(f, set())
    assert len(events) == 1
    ev = events[0]
    assert ev.input_tokens == 100 + 900 + 30
    assert ev.output_tokens == 20
    assert ev.vendor == "pi"
    assert ev.cwd == _CWD
    assert ev.session_id == _SID
    assert ev.model == "claude-opus-4"
    assert ev.dedup_key == "aa000002"


def test_tree_branches_and_compaction_all_counted(fake_pi_root: Path) -> None:
    """Entries form a tree (/tree can branch inside one file); the total
    scans every usage-bearing entry, including abandoned branches and
    top-level-usage compaction records."""
    reader = PiLogReader()
    f = _session_file(fake_pi_root)
    _write_jsonl(f, [
        _header(),
        _user("aa000001"),
        _assistant("aa000002", "aa000001", input=50, output=5),
        # Branch: second assistant with the SAME parent (abandoned path).
        _assistant("aa000003", "aa000001", input=60, output=6),
        _compaction("aa000004", "aa000003", input=10, output=1),
    ])
    events = reader.parse_session_file(f, set())
    assert [(e.input_tokens, e.output_tokens) for e in events] == [
        (50, 5), (60, 6), (10, 1),
    ]


def test_reparse_same_file_dedups_by_entry_id(fake_pi_root: Path) -> None:
    reader = PiLogReader()
    seen: set[str] = set()
    f = _session_file(fake_pi_root)
    _write_jsonl(f, [_header(), _assistant("aa000001")])
    assert len(reader.parse_session_file(f, seen)) == 1
    assert reader.parse_session_file(f, seen) == []


def test_zero_usage_missing_id_and_malformed_skipped(fake_pi_root: Path) -> None:
    reader = PiLogReader()
    f = _session_file(fake_pi_root)
    no_id = _assistant("aa000009")
    del no_id["id"]
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(
        json.dumps(_header()) + "\n"
        + "{not valid json\n"
        + json.dumps(_assistant("aa000001", input=0, output=0)) + "\n"
        + json.dumps(no_id) + "\n"
        + json.dumps(_assistant("aa000002", input=7, output=3)) + "\n",
        encoding="utf-8",
    )
    events = reader.parse_session_file(f, set())
    assert [(e.input_tokens, e.output_tokens) for e in events] == [(7, 3)]


# ─────────────────────────── lazy flush ──────────────────────────────────────

def test_missing_file_and_dirs_are_tolerated(fake_pi_root: Path) -> None:
    """Pi writes the session file only after the first assistant reply
    completes — an absent file/dir is normal, never an error."""
    reader = PiLogReader()
    ghost = _session_file(fake_pi_root, session_id="not-yet")
    assert reader.parse_session_file(ghost, set()) == []
    assert reader.parse_activity(ghost, set()) == []
    assert reader.cwd_from_file(ghost) == ""
    assert reader.session_files() == []
    assert reader.session_files_for_workspace(_CWD) == []
    assert reader.has_session("not-yet") is False
    assert reader.project_dirs() == []


# ─────────────────────────── layout / discovery ──────────────────────────────

def test_session_files_and_workspace_scoping(fake_pi_root: Path) -> None:
    reader = PiLogReader()
    f_a = _session_file(fake_pi_root, cwd="/proj/a", session_id="sa")
    f_b = _session_file(fake_pi_root, cwd="/proj/b", session_id="sb")
    _write_jsonl(f_a, [_header("sa", "/proj/a")])
    _write_jsonl(f_b, [_header("sb", "/proj/b")])
    found = reader.session_files()
    assert f_a in found and f_b in found
    only_a = reader.session_files_for_workspace("/proj/a")
    assert f_a in only_a
    assert f_b not in only_a


def test_session_id_from_path_prefers_header_over_filename(
    fake_pi_root: Path,
) -> None:
    reader = PiLogReader()
    f = _session_file(fake_pi_root, session_id="renamed-id")
    _write_jsonl(f, [_header(sid="true-id")])
    assert reader.session_id_from_path(f) == "true-id"
    # Header unreadable → filename fallback: everything after the FIRST "_"
    # (the timestamp has none; the id itself may contain "_").
    garbled = _session_file(fake_pi_root, session_id="id_with_underscores")
    garbled.write_text("{not json\n", encoding="utf-8")
    assert reader.session_id_from_path(garbled) == "id_with_underscores"
    # Sibling non-session files never coin bogus resume ids.
    lock = f.parent / "writer.lock"
    assert reader.session_id_from_path(lock) == ""
    stray = fake_pi_root / "notes.jsonl"  # not inside a --…-- session dir
    assert reader.session_id_from_path(stray) == ""


def test_has_session_verifies_header_id(fake_pi_root: Path) -> None:
    reader = PiLogReader()
    f = _session_file(fake_pi_root, session_id="x_abc")
    _write_jsonl(f, [_header(sid="x_abc")])
    assert reader.has_session("x_abc") is True
    # Filename glob alone would match `*_abc.jsonl` — header check rejects.
    assert reader.has_session("abc") is False
    assert reader.has_session("") is False
    assert reader.has_session("missing") is False


def test_resume_preflight_requires_the_target_workspace(fake_pi_root: Path) -> None:
    from agent_team_backend.cli_vendors.pi import SPEC

    _write_jsonl(_session_file(fake_pi_root), [_header()])
    assert SPEC.session_exists(_CWD, _SID) is True
    assert SPEC.session_exists(_CWD + "-other", _SID) is False
    assert SPEC.session_exists(_CWD, "missing") is False


# ─────────────────────────── incremental parsing ─────────────────────────────

def test_incremental_parse_offset_advances(fake_pi_root: Path) -> None:
    reader = PiLogReader()
    f = _session_file(fake_pi_root)
    _write_jsonl(f, [_header(), _assistant("aa000001", input=100, output=50)])
    parsed1 = reader.parse_incremental(f, {})
    assert [(e.input_tokens, e.output_tokens) for e in parsed1.events] == [(100, 50)]
    assert parsed1.events[0].session_id == _SID
    assert parsed1.events[0].cwd == _CWD
    first_offset = parsed1.checkpoint["offset"]

    with f.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(_assistant("aa000002", input=40, output=15)) + "\n")
    parsed2 = reader.parse_incremental(f, parsed1.checkpoint)
    assert [(e.input_tokens, e.output_tokens) for e in parsed2.events] == [(40, 15)]
    assert parsed2.checkpoint["offset"] > first_offset
    # Tail-only: nothing new → nothing emitted.
    assert reader.parse_incremental(f, parsed2.checkpoint).events == []


def test_incremental_survives_in_place_rewrite(fake_pi_root: Path) -> None:
    """Pi files are NOT append-only (version migration, /tree branch ops
    rewrite the file). A rewrite that SHRINKS the file must reset the offset
    and re-read the whole file; stable entry ids keep already-counted
    entries out of the re-emit."""
    reader = PiLogReader()
    f = _session_file(fake_pi_root)
    filler = _user("aa000001", content="x" * 2000)  # padding so rewrite shrinks
    _write_jsonl(f, [_header(), filler, _assistant("aa000002", input=100, output=50)])
    parsed1 = reader.parse_incremental(f, {})
    assert len(parsed1.events) == 1

    # In-place rewrite: filler dropped (file shrinks below the old offset),
    # old assistant kept with the SAME id, one genuinely new entry appended.
    _write_jsonl(f, [
        _header(),
        _assistant("aa000002", input=100, output=50),
        _assistant("aa000003", input=30, output=8),
    ])
    parsed2 = reader.parse_incremental(f, parsed1.checkpoint)
    assert [(e.dedup_key, e.input_tokens) for e in parsed2.events] == [
        ("aa000003", 30),
    ]


def test_incremental_survives_replacement_rewrite(fake_pi_root: Path) -> None:
    """A rewrite via tempfile + os.replace changes the inode (identity) even
    when the size grows — same full re-read + id dedup expectation."""
    reader = PiLogReader()
    f = _session_file(fake_pi_root)
    _write_jsonl(f, [_header(), _assistant("aa000002", input=100, output=50)])
    parsed1 = reader.parse_incremental(f, {})
    assert len(parsed1.events) == 1

    tmp = f.with_suffix(".jsonl.tmp")
    _write_jsonl(tmp, [
        _header(),
        _assistant("aa000002", input=100, output=50),
        _assistant("aa000003", input=30, output=8),
    ])
    os.replace(tmp, f)
    parsed2 = reader.parse_incremental(f, parsed1.checkpoint)
    assert [(e.dedup_key, e.input_tokens) for e in parsed2.events] == [
        ("aa000003", 30),
    ]


def test_rewrite_beyond_recent_window_does_not_recredit(
    fake_pi_root: Path,
) -> None:
    """A wholesale rewrite re-reads from offset 0. With more already-credited
    entries than the recent-id window holds, the window alone cannot stop the
    re-emit — the durable credited count must."""
    reader = PiLogReader()
    f = _session_file(fake_pi_root)
    entries = [_assistant(f"e{n:07d}", input=10, output=1) for n in range(300)]
    _write_jsonl(f, [_header(), *entries])
    parsed1 = reader.parse_incremental(f, {})
    assert len(parsed1.events) == 300

    tmp = f.with_suffix(".jsonl.tmp")
    _write_jsonl(tmp, [
        _header(), *entries, _assistant("newentry", input=33, output=7),
    ])
    os.replace(tmp, f)
    parsed2 = reader.parse_incremental(f, parsed1.checkpoint)
    assert [(e.dedup_key, e.input_tokens, e.output_tokens)
            for e in parsed2.events] == [("newentry", 33, 7)]


def test_legacy_checkpoint_suppresses_first_rewrite_only(
    fake_pi_root: Path,
) -> None:
    """Checkpoints written before credited_count existed carry no count. The
    first full re-read on such a checkpoint must emit nothing (the credit
    history is unknowable) and record the true count — then behave normally."""
    reader = PiLogReader()
    f = _session_file(fake_pi_root)
    entries = [_assistant(f"e{n:07d}", input=10, output=1) for n in range(300)]
    _write_jsonl(f, [_header(), *entries])
    parsed1 = reader.parse_incremental(f, {})
    assert len(parsed1.events) == 300
    legacy = dict(parsed1.checkpoint)
    del legacy["credited_count"]
    assert legacy["offset"] > 0

    tmp = f.with_suffix(".jsonl.tmp")
    _write_jsonl(tmp, [
        _header(), *entries, _assistant("newentry", input=33, output=7),
    ])
    os.replace(tmp, f)
    parsed2 = reader.parse_incremental(f, legacy)
    assert parsed2.events == []
    assert parsed2.checkpoint["credited_count"] == 301

    # One-shot: the count is durable now, so the next append emits normally.
    with f.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(_assistant("laterentry", input=5, output=2)) + "\n")
    parsed3 = reader.parse_incremental(f, parsed2.checkpoint)
    assert [(e.dedup_key, e.input_tokens, e.output_tokens)
            for e in parsed3.events] == [("laterentry", 5, 2)]
    assert parsed3.checkpoint["credited_count"] == 302


# ─────────────────────────── activity ────────────────────────────────────────

def test_parse_activity_user_and_assistant_only(fake_pi_root: Path) -> None:
    """user/assistant messages are activity; the header, compaction records
    and non-user/assistant roles are not. Pi logs carry no end-of-turn
    signal, so no turn_complete is ever emitted."""
    reader = PiLogReader()
    f = _session_file(fake_pi_root)
    _write_jsonl(f, [
        _header(),
        _user("aa000001", content="do the thing"),
        _assistant("aa000002", "aa000001"),
        {"type": "message", "id": "aa000003", "parentId": "aa000002",
         "timestamp": "t", "message": {"role": "toolResult", "content": "out"}},
        _compaction("aa000004", "aa000003"),
    ])
    events = reader.parse_activity(f, set())
    assert [(e.event_type, e.detail) for e in events] == [
        ("agent_active", "user"),
        ("agent_active", "assistant"),
    ]
    assert all(e.session_id == _SID and e.cwd == _CWD for e in events)


def _assistant_saying(eid: str, text: str, parent: str | None = None) -> dict:
    rec = _assistant(eid, parent)
    rec["message"]["content"] = [{"type": "text", "text": text}]
    return rec


def _go_quiet(path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Pretend the log stopped being written to well past the idle window."""
    import agent_team_backend.cli_vendors.pi as pi_mod

    monkeypatch.setattr(
        pi_mod.time, "time", lambda: path.stat().st_mtime + pi_mod._TURN_IDLE_SECONDS + 1
    )


def test_parse_activity_completes_a_turn_with_the_assistant_reply(
    fake_pi_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pi has no MCP support, so the output protocol is its only route to
    sending a message — and that needs a turn_complete carrying text."""
    reader = PiLogReader()
    f = _session_file(fake_pi_root)
    _write_jsonl(f, [
        _header(),
        _user("aa000001", content="ask reviewer to take over"),
        _assistant_saying("aa000002", "looking into it", "aa000001"),
        _assistant_saying("aa000003", "done, handing over", "aa000002"),
    ])
    _go_quiet(f, monkeypatch)
    completes = [
        e for e in reader.parse_activity(f, set()) if e.event_type == "turn_complete"
    ]
    assert [(e.dedup_key, e.detail, e.text) for e in completes] == [
        ("turn:0", "idle", "done, handing over")
    ]
    # A real timestamp is what the frontend dedups messaging turns by; an
    # unparseable one reads as always-fresh and resends the turn.
    assert completes[0].timestamp == "2026-07-27T10:00:02.000Z"


def test_parse_activity_open_turn_is_not_completed_while_the_log_is_live(
    fake_pi_root: Path,
) -> None:
    reader = PiLogReader()
    f = _session_file(fake_pi_root)
    _write_jsonl(f, [
        _header(),
        _user("aa000001", content="go"),
        _assistant_saying("aa000002", "working", "aa000001"),
    ])
    assert [
        e for e in reader.parse_activity(f, set()) if e.event_type == "turn_complete"
    ] == []


def test_parse_activity_next_message_closes_the_previous_turn(
    fake_pi_root: Path,
) -> None:
    reader = PiLogReader()
    f = _session_file(fake_pi_root)
    _write_jsonl(f, [
        _header(),
        _user("aa000001", content="first"),
        _assistant_saying("aa000002", "answer one", "aa000001"),
        _user("aa000003", content="second", parent="aa000002"),
    ])
    completes = [
        e for e in reader.parse_activity(f, set()) if e.event_type == "turn_complete"
    ]
    assert [(e.dedup_key, e.detail, e.text) for e in completes] == [
        ("turn:0", "boundary", "answer one")
    ]


def test_parse_activity_reply_survives_a_poll_boundary(
    fake_pi_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    reader = PiLogReader()
    seen: set[str] = set()
    f = _session_file(fake_pi_root)
    _write_jsonl(f, [
        _header(),
        _user("aa000001", content="go"),
        _assistant_saying("aa000002", "ready", "aa000001"),
    ])
    assert [e for e in reader.parse_activity(f, seen) if e.event_type == "turn_complete"] == []
    _go_quiet(f, monkeypatch)
    completes = [
        e for e in reader.parse_activity(f, seen) if e.event_type == "turn_complete"
    ]
    assert [(e.detail, e.text) for e in completes] == [("idle", "ready")]


def test_parse_activity_user_prompt_carries_text(fake_pi_root: Path) -> None:
    """User message content (plain string or text blocks) rides on the event,
    truncated to 500 chars, for pane naming; the injected "<...>"-prefixed
    session-marker bootstrap and assistant events stay text-less."""
    reader = PiLogReader()
    f = _session_file(fake_pi_root)
    _write_jsonl(f, [
        _header(),
        _user("aa000001",
              content="<!-- agent-team-session: at-pane:p1 -->"),
        _user("aa000002", content="fix the login bug", parent="aa000001"),
        _user("aa000003", content=[{"type": "text", "text": "p" * 600}],
              parent="aa000002"),
        _assistant("aa000004", "aa000003"),
    ])
    events = reader.parse_activity(f, set())
    assert [
        (e.detail, e.text) for e in events if e.event_type == "agent_active"
    ] == [
        ("user", ""),
        ("user", "fix the login bug"),
        ("user", "p" * 500),
        ("assistant", ""),
    ]


def test_parse_activity_reparse_does_not_reemit(fake_pi_root: Path) -> None:
    reader = PiLogReader()
    seen: set[str] = set()
    f = _session_file(fake_pi_root)
    _write_jsonl(f, [_header(), _user("aa000001"), _assistant("aa000002")])
    assert len(reader.parse_activity(f, seen)) == 2
    assert reader.parse_activity(f, seen) == []


def test_parse_activity_leaves_a_half_written_last_line_for_next_poll(
    fake_pi_root: Path,
) -> None:
    """A poll that catches Pi mid-append must not advance past the
    unterminated last line: doing so drops it for good once it completes,
    which strands the pane mid-turn forever when the lost line was the
    assistant's closing entry (GitHub #21)."""
    reader = PiLogReader()
    f = _session_file(fake_pi_root)
    _write_jsonl(f, [_header(), _user("aa000001", content="go")])
    seen: set[str] = set()
    reader.parse_activity(f, seen)
    assert activity_high_water(seen) == 2

    full_line = json.dumps(_assistant_saying("aa000002", "working", "aa000001"))
    with f.open("a", encoding="utf-8") as fh:
        fh.write(full_line[:20])  # Pi is still writing this line
    assert reader.parse_activity(f, seen) == []
    assert activity_high_water(seen) == 2, "must not advance past the half-written line"

    with f.open("a", encoding="utf-8") as fh:
        fh.write(full_line[20:] + "\n")
    events = reader.parse_activity(f, seen)
    assert [(e.event_type, e.detail) for e in events] == [("agent_active", "assistant")]
    assert activity_high_water(seen) == 3


# ── activity: the seen_keys bag stays O(1) ───────────────────────────────────
# seen_keys lives as long as the session file, so a walk of a long log must
# leave one high-water mark in it, not a key per line (GitHub #23).

def _long_log(f: Path, turns: int) -> int:
    """Write `turns` user/assistant pairs after the header; return line count."""
    records: list[dict] = [_header()]
    for i in range(turns):
        records.append(_user(f"aa{2 * i:06d}", content=f"ask {i}"))
        records.append(_assistant_saying(f"aa{2 * i + 1:06d}", f"reply {i}"))
    _write_jsonl(f, records)
    return len(records)


def test_parse_activity_seen_keys_stay_constant_size(fake_pi_root: Path) -> None:
    reader = PiLogReader()
    f = _session_file(fake_pi_root)
    lines = _long_log(f, 250)
    seen: set[str] = set()

    reader.parse_activity(f, seen)

    assert [k for k in seen if k.startswith("act:")] == []
    assert len([k for k in seen if k.startswith("act_hw::")]) == 1
    assert activity_high_water(seen) == lines


def test_parse_activity_long_log_reparse_does_not_reemit(
    fake_pi_root: Path,
) -> None:
    reader = PiLogReader()
    f = _session_file(fake_pi_root)
    _long_log(f, 250)
    seen: set[str] = set()

    assert reader.parse_activity(f, seen) != []
    assert reader.parse_activity(f, seen) == []


def test_parse_activity_appended_line_keeps_its_dedup_key(
    fake_pi_root: Path,
) -> None:
    reader = PiLogReader()
    f = _session_file(fake_pi_root)
    lines = _long_log(f, 3)
    seen: set[str] = set()
    reader.parse_activity(f, seen)

    with f.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(_assistant_saying("bb000001", "one more")) + "\n")
    fresh = reader.parse_activity(f, seen)

    assert [(e.event_type, e.detail) for e in fresh] == [
        ("agent_active", "assistant"),
    ]
    assert fresh[0].dedup_key == f"act:{lines + 1}"
    assert activity_high_water(seen) == lines + 1


def test_parse_activity_turn_and_text_sentinels_coexist_with_the_mark(
    fake_pi_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Turn state and the pending reply share the bag with the mark; the
    cross-poll idle flush above depends on none of them evicting the others."""
    reader = PiLogReader()
    seen: set[str] = set()
    f = _session_file(fake_pi_root)
    _write_jsonl(f, [
        _header(),
        _user("aa000001", content="go"),
        _assistant_saying("aa000002", "ready", "aa000001"),
    ])
    reader.parse_activity(f, seen)

    assert len([k for k in seen if k.startswith("act_hw::")]) == 1
    assert [k for k in seen if k.startswith("pi_text::")] == ["pi_text::ready"]
    assert len([k for k in seen if k.startswith("pi_turn::")]) == 1

    _go_quiet(f, monkeypatch)
    completes = [
        e for e in reader.parse_activity(f, seen) if e.event_type == "turn_complete"
    ]
    assert [(e.detail, e.text) for e in completes] == [("idle", "ready")]


# ─────────────────────────── attribution binding ─────────────────────────────

def _usage(session_id: str, file_path: Path, cwd: str = "/ws") -> TokenUsage:
    """Shape of the session-sink probe usage (_on_session_file)."""
    return TokenUsage(
        vendor="pi", input_tokens=0, output_tokens=0, cwd=cwd,
        session_id=session_id, file_path=str(file_path), dedup_key="",
    )


@pytest.fixture
def pi_attr(fake_pi_root: Path, tmp_path: Path) -> tuple[Attribution, Path]:
    attr = Attribution([PiLogReader()], workspaces_path=tmp_path / "ws.json")
    return attr, fake_pi_root


def test_marker_in_string_user_content_binds_pane(
    pi_attr: tuple[Attribution, Path],
) -> None:
    """Pi preserves user text verbatim, so the kickoff's at-pane marker lands
    in the session jsonl; marker matching resolves the pane even with
    multiple candidates, and the resume id is the header id that
    `pi --session-id <id>` accepts."""
    attr, root = pi_attr
    attr.register_pane("p1", vendor="pi", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    attr.register_pane("p2", vendor="pi", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p2")
    f = _session_file(root, cwd="/ws", session_id="sess-two")
    _write_jsonl(f, [
        _header("sess-two", "/ws"),
        _user("aa000001", content="hi <!-- agent-team-session: at-pane:p2 -->"),
    ])

    binding = attr.maybe_announce_session(_usage("sess-two", f))
    assert binding is not None
    assert binding.pane_id == "p2"
    assert binding.resume_id == "sess-two"
    assert binding.workspace_path == "/ws"


def test_marker_in_block_user_content_binds_pane(
    pi_attr: tuple[Attribution, Path],
) -> None:
    """User content may be a block list instead of a plain string — the
    marker must still bind."""
    attr, root = pi_attr
    attr.register_pane("p1", vendor="pi", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    attr.register_pane("p2", vendor="pi", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p2")
    f = _session_file(root, cwd="/ws", session_id="sess-blocks")
    _write_jsonl(f, [
        _header("sess-blocks", "/ws"),
        _user("aa000001", content=[
            {"type": "text", "text": "hi <!-- agent-team-session: at-pane:p1 -->"},
        ]),
    ])

    binding = attr.maybe_announce_session(_usage("sess-blocks", f))
    assert binding is not None
    assert binding.pane_id == "p1"
    assert binding.resume_id == "sess-blocks"


def test_single_candidate_fallback_binds_without_marker(
    pi_attr: tuple[Attribution, Path],
) -> None:
    """A lone fresh pane still captures its new session file when the marker
    is absent — the Pi file only appears after the first assistant reply
    (lazy flush), well after pane registration."""
    attr, root = pi_attr
    attr.register_pane("p1", vendor="pi", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    f = _session_file(root, cwd="/ws", session_id="sess-new")
    _write_jsonl(f, [_header("sess-new", "/ws"), _user("aa000001", "no marker")])

    binding = attr.maybe_announce_session(_usage("sess-new", f))
    assert binding is not None
    assert binding.pane_id == "p1"
    assert binding.resume_id == "sess-new"
    # Announce-once: a later watcher event for the same session is silent.
    assert attr.maybe_announce_session(_usage("sess-new", f)) is None


def test_fallback_ignores_baseline_sessions(
    pi_attr: tuple[Attribution, Path],
) -> None:
    """A session file that predates the pane's spawn is another conversation —
    never fallback-bind it."""
    attr, root = pi_attr
    f = _session_file(root, cwd="/ws", session_id="sess-old")
    _write_jsonl(f, [_header("sess-old", "/ws"), _user("aa000001")])
    attr.register_pane("p1", vendor="pi", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    assert attr.maybe_announce_session(_usage("sess-old", f)) is None


def test_workspace_attribution_via_header_cwd(
    pi_attr: tuple[Attribution, Path],
) -> None:
    """Token events attribute to the registered workspace by usage.cwd
    equality (the reader emits the header's exact cwd)."""
    attr, root = pi_attr
    attr.register_workspace("/ws")
    f = _session_file(root, cwd="/ws", session_id="sess-x")
    _write_jsonl(f, [_header("sess-x", "/ws"), _assistant("aa000001")])
    reader = PiLogReader()
    usage = reader.parse_session_file(f, set())[0]
    assert attr.attribute(usage).workspace_path == "/ws"
    # An event from an unregistered cwd is dropped by the sink layer.
    f2 = _session_file(root, cwd="/elsewhere", session_id="sess-y")
    _write_jsonl(f2, [_header("sess-y", "/elsewhere"), _assistant("aa000002")])
    usage2 = reader.parse_session_file(f2, set())[0]
    assert attr.attribute(usage2).workspace_path is None


def test_parse_activity_resumes_after_an_append(fake_pi_root: Path, monkeypatch) -> None:
    from tests.activity_resume_support import assert_resumes

    f = _session_file(fake_pi_root)
    _write_jsonl(f, [_header(), _user("aa000001", content="first"),
                     _assistant_saying("aa000002", "one", "aa000001")])
    assert_resumes(PiLogReader, f, [
        _user("aa000003", content="second", parent="aa000002"),
        _assistant_saying("aa000004", "two", "aa000003"),
    ], monkeypatch)
