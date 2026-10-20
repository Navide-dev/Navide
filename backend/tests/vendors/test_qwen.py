"""QwenLogReader: usageMetadata mapping + chats/archive layout + attribution."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.log_readers.attribution import Attribution
from agent_team_backend.log_readers.claude import encode_claude_cwd
from agent_team_backend.log_readers.base import TokenUsage, activity_high_water
from agent_team_backend.log_readers.qwen import QwenLogReader

_SID = "1f0b9d5e-2f4a-4c0e-9b7d-3a5c8e9f0a1b"
_CWD = "/Users/me/proj"


def _rec(rtype: str, uuid: str, cwd: str = _CWD, **extra) -> dict:
    rec = {
        "uuid": uuid,
        "parentUuid": None,
        "sessionId": _SID,
        "timestamp": "2026-07-27T10:00:00.000Z",
        "type": rtype,
        "cwd": cwd,
        "version": "0.21.0",
        "gitBranch": "main",
    }
    rec.update(extra)
    return rec


def _assistant(uuid: str, prompt: int = 100, candidates: int = 20,
               cached: int = 0, thoughts: int = 0,
               model: str = "qwen3-coder-plus", cwd: str = _CWD) -> dict:
    return _rec("assistant", uuid, cwd=cwd, model=model, usageMetadata={
        "promptTokenCount": prompt,
        "candidatesTokenCount": candidates,
        "cachedContentTokenCount": cached,
        "thoughtsTokenCount": thoughts,
        "totalTokenCount": prompt + candidates + thoughts,
    })


def _user(uuid: str, text: str = "hi", subtype: str = "", cwd: str = _CWD) -> dict:
    rec = _rec("user", uuid, cwd=cwd,
               message={"role": "user", "parts": [{"text": text}]})
    if subtype:
        rec["subtype"] = subtype
    return rec


def _write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


@pytest.fixture
def fake_qwen_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / ".qwen"
    monkeypatch.setenv("QWEN_RUNTIME_DIR", str(root))
    return root


def _chat_file(root: Path, cwd: str = _CWD, session_id: str = _SID,
               archive: bool = False) -> Path:
    d = root / "projects" / encode_claude_cwd(cwd) / "chats"
    if archive:
        d = d / "archive"
    return d / f"{session_id}.jsonl"


# ─────────────────────────── token parsing ───────────────────────────────────

def test_token_mapping_prompt_input_candidates_plus_thoughts_output(
    fake_qwen_root: Path,
) -> None:
    """input = promptTokenCount (cache already included); output =
    candidatesTokenCount + thoughtsTokenCount."""
    reader = QwenLogReader()
    f = _chat_file(fake_qwen_root)
    _write_jsonl(f, [
        _user("u1"),
        _assistant("a1", prompt=1500, candidates=200, cached=900, thoughts=44),
    ])
    events = reader.parse_session_file(f, set())
    assert len(events) == 1
    ev = events[0]
    # cachedContentTokenCount is NOT added again — prompt already includes it.
    assert ev.input_tokens == 1500
    assert ev.output_tokens == 200 + 44
    assert ev.vendor == "qwen"
    assert ev.cwd == _CWD
    assert ev.session_id == _SID
    assert ev.model == "qwen3-coder-plus"
    assert ev.dedup_key == "a1"


def test_reparse_same_file_dedups_by_uuid(fake_qwen_root: Path) -> None:
    reader = QwenLogReader()
    seen: set[str] = set()
    f = _chat_file(fake_qwen_root)
    _write_jsonl(f, [_assistant("a1")])
    assert len(reader.parse_session_file(f, seen)) == 1
    assert reader.parse_session_file(f, seen) == []


def test_zero_usage_and_missing_uuid_skipped(fake_qwen_root: Path) -> None:
    reader = QwenLogReader()
    f = _chat_file(fake_qwen_root)
    no_uuid = _assistant("a1")
    del no_uuid["uuid"]
    _write_jsonl(f, [
        _assistant("a0", prompt=0, candidates=0, thoughts=0),
        no_uuid,
    ])
    assert reader.parse_session_file(f, set()) == []


def test_malformed_lines_do_not_abort(fake_qwen_root: Path) -> None:
    reader = QwenLogReader()
    f = _chat_file(fake_qwen_root)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(
        "{not valid json\n"
        + json.dumps(_assistant("a1", prompt=50, candidates=25)) + "\n"
        + "garbage\n",
        encoding="utf-8",
    )
    events = reader.parse_session_file(f, set())
    assert len(events) == 1
    assert events[0].input_tokens == 50


# ─────────────────────────── layout / discovery ──────────────────────────────

def test_session_files_includes_archive(fake_qwen_root: Path) -> None:
    reader = QwenLogReader()
    live = _chat_file(fake_qwen_root, session_id="live-1")
    archived = _chat_file(fake_qwen_root, session_id="old-1", archive=True)
    _write_jsonl(live, [_assistant("a1")])
    _write_jsonl(archived, [_assistant("a2")])
    found = reader.session_files()
    assert live in found
    assert archived in found


def test_session_files_for_workspace_scopes_to_encoded_dir(
    fake_qwen_root: Path,
) -> None:
    reader = QwenLogReader()
    f_a = _chat_file(fake_qwen_root, cwd="/proj/a", session_id="sa")
    f_b = _chat_file(fake_qwen_root, cwd="/proj/b", session_id="sb")
    _write_jsonl(f_a, [_assistant("a1", cwd="/proj/a")])
    _write_jsonl(f_b, [_assistant("a2", cwd="/proj/b")])
    only_a = reader.session_files_for_workspace("/proj/a")
    assert f_a in only_a
    assert f_b not in only_a


def test_cwd_from_file_reads_record_cwd(fake_qwen_root: Path) -> None:
    """The cwd comes from the record itself, not from decoding the dir name —
    so a path with '-' or '.' survives round-tripping."""
    reader = QwenLogReader()
    cwd = "/Users/me/my-app.v2"
    f = _chat_file(fake_qwen_root, cwd=cwd)
    _write_jsonl(f, [_user("u1", cwd=cwd), _assistant("a1", cwd=cwd)])
    assert reader.cwd_from_file(f) == cwd


def test_session_id_from_path_only_for_chats_jsonl(fake_qwen_root: Path) -> None:
    reader = QwenLogReader()
    live = _chat_file(fake_qwen_root, session_id="sid-live")
    archived = _chat_file(fake_qwen_root, session_id="sid-old", archive=True)
    assert reader.session_id_from_path(live) == "sid-live"
    assert reader.session_id_from_path(archived) == "sid-old"
    # Sibling non-session files never coin bogus resume ids.
    lock = live.parent / "sid-live.lock"
    assert reader.session_id_from_path(lock) == ""
    stray = fake_qwen_root / "projects" / "-proj" / "notes.jsonl"
    assert reader.session_id_from_path(stray) == ""


def test_has_session_accepts_live_and_archived_rejects_bogus(
    fake_qwen_root: Path,
) -> None:
    reader = QwenLogReader()
    _write_jsonl(_chat_file(fake_qwen_root, session_id="live-1"), [_assistant("a1")])
    _write_jsonl(
        _chat_file(fake_qwen_root, session_id="old-1", archive=True),
        [_assistant("a2")],
    )
    assert reader.has_session("live-1") is True
    assert reader.has_session("old-1") is True
    assert reader.has_session("") is False
    assert reader.has_session("missing") is False


# ─────────────────────────── incremental parsing ─────────────────────────────

def test_incremental_parse_offset_advances(fake_qwen_root: Path) -> None:
    reader = QwenLogReader()
    f = _chat_file(fake_qwen_root)
    _write_jsonl(f, [_assistant("a1", prompt=100, candidates=50)])
    parsed1 = reader.parse_incremental(f, {})
    assert [(e.input_tokens, e.output_tokens) for e in parsed1.events] == [(100, 50)]
    first_offset = parsed1.checkpoint["offset"]

    with f.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(_assistant("a2", prompt=40, candidates=15)) + "\n")
    parsed2 = reader.parse_incremental(f, parsed1.checkpoint)
    assert [(e.input_tokens, e.output_tokens) for e in parsed2.events] == [(40, 15)]
    assert parsed2.checkpoint["offset"] > first_offset


def test_incremental_parse_reads_only_the_tail(fake_qwen_root: Path) -> None:
    reader = QwenLogReader()
    f = _chat_file(fake_qwen_root)
    _write_jsonl(f, [_assistant("a1")])
    parsed1 = reader.parse_incremental(f, {})
    parsed2 = reader.parse_incremental(f, parsed1.checkpoint)
    assert parsed2.events == []


# ─────────────────────────── activity ────────────────────────────────────────

def test_parse_activity_filters_automated_user_subtypes(
    fake_qwen_root: Path,
) -> None:
    """Real user prompts and assistant records are activity; automated user
    records (mid_turn_user_message / cron / notification) are not. Qwen logs
    carry no end-of-turn signal, so no turn_complete is ever emitted."""
    reader = QwenLogReader()
    f = _chat_file(fake_qwen_root)
    _write_jsonl(f, [
        _user("u1", "do the thing"),
        _assistant("a1"),
        _user("u2", subtype="mid_turn_user_message"),
        _user("u3", subtype="cron"),
        _user("u4", subtype="notification"),
        _rec("system", "s1", subtype="ui_telemetry"),
    ])
    events = reader.parse_activity(f, set())
    assert [(e.event_type, e.detail) for e in events] == [
        ("agent_active", "user"),
        ("agent_active", "assistant"),
    ]


def test_parse_activity_user_prompt_carries_text(fake_qwen_root: Path) -> None:
    """User events carry the joined message.parts text (truncated to 500
    chars) for pane naming; the injected "<...>"-prefixed session-marker
    bootstrap, non-text parts and assistant records stay text-less."""
    reader = QwenLogReader()
    f = _chat_file(fake_qwen_root)
    _write_jsonl(f, [
        _user("u0", "<!-- agent-team-session: at-pane:p1 -->"),
        _user("u1", "fix the login bug"),
        _user("u2", "p" * 600),
        _rec("user", "u3",
             message={"role": "user", "parts": [{"functionResponse": {}}]}),
        _assistant("a1"),
    ])
    events = reader.parse_activity(f, set())
    assert [
        (e.detail, e.text) for e in events if e.event_type == "agent_active"
    ] == [
        ("user", ""),
        ("user", "fix the login bug"),
        ("user", "p" * 500),
        ("user", ""),
        ("assistant", ""),
    ]


def _assistant_saying(uuid: str, text: str, cwd: str = _CWD) -> dict:
    rec = _assistant(uuid, cwd=cwd)
    rec["message"] = {"role": "model", "parts": [{"text": text}]}
    return rec


def _go_quiet(path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Pretend the log stopped being written to well past the idle window."""
    import agent_team_backend.cli_vendors.qwen as qwen_mod

    monkeypatch.setattr(
        qwen_mod.time, "time", lambda: path.stat().st_mtime + qwen_mod._TURN_IDLE_SECONDS + 1
    )


def test_parse_activity_completes_a_turn_with_the_assistant_reply(
    fake_qwen_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Qwen writes no end-of-turn record, so the latest turn is closed by the
    file going quiet — and it must carry the reply for the messaging protocol."""
    reader = QwenLogReader()
    f = _chat_file(fake_qwen_root)
    _write_jsonl(f, [
        _user("u1", "ask reviewer to take over"),
        _assistant_saying("a1", "looking into it"),
        _assistant_saying("a2", "done, handing over"),
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
    assert completes[0].timestamp == "2026-07-27T10:00:00.000Z"


def test_parse_activity_open_turn_is_not_completed_while_the_log_is_live(
    fake_qwen_root: Path
) -> None:
    reader = QwenLogReader()
    f = _chat_file(fake_qwen_root)
    _write_jsonl(f, [_user("u1", "go"), _assistant_saying("a1", "working")])
    # The file was just written, so it is still inside the idle window.
    assert [
        e for e in reader.parse_activity(f, set()) if e.event_type == "turn_complete"
    ] == []


def test_parse_activity_next_prompt_closes_the_previous_turn(
    fake_qwen_root: Path
) -> None:
    reader = QwenLogReader()
    f = _chat_file(fake_qwen_root)
    _write_jsonl(f, [
        _user("u1", "first"),
        _assistant_saying("a1", "answer one"),
        _user("u2", "second"),
    ])
    completes = [
        e for e in reader.parse_activity(f, set()) if e.event_type == "turn_complete"
    ]
    assert [(e.dedup_key, e.detail, e.text) for e in completes] == [
        ("turn:0", "boundary", "answer one")
    ]


def test_parse_activity_automated_user_records_do_not_close_a_turn(
    fake_qwen_root: Path
) -> None:
    """A cron/notification record is not a human prompt, so it must not split
    the turn — otherwise the reply would be attributed to the wrong one."""
    reader = QwenLogReader()
    f = _chat_file(fake_qwen_root)
    _write_jsonl(f, [
        _user("u1", "go"),
        _user("u2", "injected", subtype="cron"),
        _assistant_saying("a1", "still turn zero"),
        _user("u3", "next"),
    ])
    completes = [
        e for e in reader.parse_activity(f, set()) if e.event_type == "turn_complete"
    ]
    assert [(e.dedup_key, e.text) for e in completes] == [("turn:0", "still turn zero")]


def test_parse_activity_reply_survives_a_poll_boundary(
    fake_qwen_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    reader = QwenLogReader()
    seen: set[str] = set()
    f = _chat_file(fake_qwen_root)
    _write_jsonl(f, [_user("u1", "go"), _assistant_saying("a1", "ready")])
    assert [e for e in reader.parse_activity(f, seen) if e.event_type == "turn_complete"] == []
    _go_quiet(f, monkeypatch)
    completes = [
        e for e in reader.parse_activity(f, seen) if e.event_type == "turn_complete"
    ]
    assert [(e.detail, e.text) for e in completes] == [("idle", "ready")]


def test_parse_activity_reparse_does_not_reemit(fake_qwen_root: Path) -> None:
    reader = QwenLogReader()
    seen: set[str] = set()
    f = _chat_file(fake_qwen_root)
    _write_jsonl(f, [_user("u1"), _assistant("a1")])
    assert len(reader.parse_activity(f, seen)) == 2
    assert reader.parse_activity(f, seen) == []


def test_parse_activity_leaves_a_half_written_last_line_for_next_poll(
    fake_qwen_root: Path,
) -> None:
    """A poll that catches Qwen mid-append must not advance past the
    unterminated last line: doing so drops it for good once it completes,
    which strands the pane mid-turn forever when the lost line was the
    assistant's closing record (GitHub #21)."""
    reader = QwenLogReader()
    f = _chat_file(fake_qwen_root)
    _write_jsonl(f, [_user("u1", "go")])
    seen: set[str] = set()
    reader.parse_activity(f, seen)
    assert activity_high_water(seen) == 1

    full_line = json.dumps(_assistant_saying("a1", "working"))
    with f.open("a", encoding="utf-8") as fh:
        fh.write(full_line[:20])  # Qwen is still writing this line
    assert reader.parse_activity(f, seen) == []
    assert activity_high_water(seen) == 1, "must not advance past the half-written line"

    with f.open("a", encoding="utf-8") as fh:
        fh.write(full_line[20:] + "\n")
    events = reader.parse_activity(f, seen)
    assert [(e.event_type, e.detail) for e in events] == [("agent_active", "assistant")]
    assert activity_high_water(seen) == 2


# ── activity: the seen_keys bag stays O(1) ───────────────────────────────────
# seen_keys lives as long as the chat file, so a walk of a long log must leave
# one high-water mark in it, not a key per line (GitHub #23).

def _long_chat(f: Path, turns: int) -> int:
    """Write `turns` user/assistant pairs; return the line count."""
    records: list[dict] = []
    for i in range(turns):
        records.append(_user(f"u{i}", f"ask {i}"))
        records.append(_assistant_saying(f"a{i}", f"reply {i}"))
    _write_jsonl(f, records)
    return len(records)


def test_parse_activity_seen_keys_stay_constant_size(fake_qwen_root: Path) -> None:
    reader = QwenLogReader()
    f = _chat_file(fake_qwen_root)
    lines = _long_chat(f, 250)
    seen: set[str] = set()

    reader.parse_activity(f, seen)

    assert [k for k in seen if k.startswith("act:")] == []
    assert len([k for k in seen if k.startswith("act_hw::")]) == 1
    assert activity_high_water(seen) == lines


def test_parse_activity_long_chat_reparse_does_not_reemit(
    fake_qwen_root: Path,
) -> None:
    reader = QwenLogReader()
    f = _chat_file(fake_qwen_root)
    _long_chat(f, 250)
    seen: set[str] = set()

    assert reader.parse_activity(f, seen) != []
    assert reader.parse_activity(f, seen) == []


def test_parse_activity_appended_line_keeps_its_dedup_key(
    fake_qwen_root: Path,
) -> None:
    reader = QwenLogReader()
    f = _chat_file(fake_qwen_root)
    lines = _long_chat(f, 3)
    seen: set[str] = set()
    reader.parse_activity(f, seen)

    with f.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(_assistant_saying("a99", "one more")) + "\n")
    fresh = reader.parse_activity(f, seen)

    assert [(e.event_type, e.detail) for e in fresh] == [
        ("agent_active", "assistant"),
    ]
    assert fresh[0].dedup_key == f"act:{lines + 1}"
    assert activity_high_water(seen) == lines + 1


def test_parse_activity_turn_and_text_sentinels_coexist_with_the_mark(
    fake_qwen_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Turn state and the pending reply share the bag with the mark; the
    cross-poll idle flush above depends on none of them evicting the others."""
    reader = QwenLogReader()
    seen: set[str] = set()
    f = _chat_file(fake_qwen_root)
    _write_jsonl(f, [_user("u1", "go"), _assistant_saying("a1", "ready")])
    reader.parse_activity(f, seen)

    assert len([k for k in seen if k.startswith("act_hw::")]) == 1
    assert [k for k in seen if k.startswith("qwen_text::")] == ["qwen_text::ready"]
    assert len([k for k in seen if k.startswith("qwen_turn::")]) == 1

    _go_quiet(f, monkeypatch)
    completes = [
        e for e in reader.parse_activity(f, seen) if e.event_type == "turn_complete"
    ]
    assert [(e.detail, e.text) for e in completes] == [("idle", "ready")]


# ─────────────────────────── attribution binding ─────────────────────────────

def _usage(session_id: str, file_path: Path, cwd: str = "/ws") -> TokenUsage:
    """Shape of the session-sink probe usage (_on_session_file)."""
    return TokenUsage(
        vendor="qwen", input_tokens=0, output_tokens=0, cwd=cwd,
        session_id=session_id, file_path=str(file_path), dedup_key="",
    )


@pytest.fixture
def qwen_attr(fake_qwen_root: Path, tmp_path: Path) -> tuple[Attribution, Path]:
    attr = Attribution([QwenLogReader()], workspaces_path=tmp_path / "ws.json")
    return attr, fake_qwen_root


def test_marker_in_user_text_binds_pane(qwen_attr: tuple[Attribution, Path]) -> None:
    """Qwen preserves user text verbatim, so the kickoff's at-pane marker lands
    in the session jsonl; marker matching resolves the pane even with multiple
    candidates, and the resume id is the file stem `qwen --resume` accepts."""
    attr, root = qwen_attr
    attr.register_pane("p1", vendor="qwen", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    attr.register_pane("p2", vendor="qwen", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p2")
    f = _chat_file(root, cwd="/ws", session_id="sess-two")
    _write_jsonl(f, [_user("u1", "hi <!-- agent-team-session: at-pane:p2 -->")])

    binding = attr.maybe_announce_session(_usage("sess-two", f))
    assert binding is not None
    assert binding.pane_id == "p2"
    assert binding.resume_id == "sess-two"
    assert binding.workspace_path == "/ws"


def test_single_candidate_fallback_binds_without_marker(
    qwen_attr: tuple[Attribution, Path],
) -> None:
    """A lone fresh pane still captures its new session file when the marker
    injection lost the startup timing race."""
    attr, root = qwen_attr
    attr.register_pane("p1", vendor="qwen", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    f = _chat_file(root, cwd="/ws", session_id="sess-new")
    _write_jsonl(f, [_user("u1", "no marker here")])

    binding = attr.maybe_announce_session(_usage("sess-new", f))
    assert binding is not None
    assert binding.pane_id == "p1"
    assert binding.resume_id == "sess-new"
    # Announce-once: a later watcher event for the same session is silent.
    assert attr.maybe_announce_session(_usage("sess-new", f)) is None


def test_bound_session_skips_file_io_on_later_events(
    qwen_attr: tuple[Attribution, Path], monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Session-sink hot path: once a session is bound, later watcher events for
    it must bail before any file IO (the capped-512KB read used to run on
    every session-file write, competing with PTY output pumping)."""
    attr, root = qwen_attr
    attr.register_pane("p1", vendor="qwen", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    f = _chat_file(root, cwd="/ws", session_id="sess-hot")
    _write_jsonl(f, [_user("u1", "hi <!-- agent-team-session: at-pane:p1 -->")])
    assert attr.maybe_announce_session(_usage("sess-hot", f)) is not None

    def _no_read(*args: object, **kwargs: object) -> str:
        raise AssertionError("bound session must not re-read the session file")

    monkeypatch.setattr(Path, "read_text", _no_read)
    assert attr.maybe_announce_session(_usage("sess-hot", f)) is None


def test_fallback_ignores_baseline_sessions(
    qwen_attr: tuple[Attribution, Path],
) -> None:
    """A session file that predates the pane's spawn is another conversation —
    never fallback-bind it."""
    attr, root = qwen_attr
    f = _chat_file(root, cwd="/ws", session_id="sess-old")
    _write_jsonl(f, [_user("u1")])
    attr.register_pane("p1", vendor="qwen", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    assert attr.maybe_announce_session(_usage("sess-old", f)) is None


def test_workspace_attribution_via_record_cwd(
    qwen_attr: tuple[Attribution, Path],
) -> None:
    """Token events attribute to the registered workspace by usage.cwd
    equality (the reader emits the record's exact cwd)."""
    attr, root = qwen_attr
    attr.register_workspace("/ws")
    f = _chat_file(root, cwd="/ws", session_id="sess-x")
    _write_jsonl(f, [_assistant("a1", cwd="/ws")])
    reader = QwenLogReader()
    usage = reader.parse_session_file(f, set())[0]
    assert attr.attribute(usage).workspace_path == "/ws"
    # An event from an unregistered cwd is dropped by the sink layer.
    f2 = _chat_file(root, cwd="/elsewhere", session_id="sess-y")
    _write_jsonl(f2, [_assistant("a2", cwd="/elsewhere")])
    usage2 = reader.parse_session_file(f2, set())[0]
    assert attr.attribute(usage2).workspace_path is None


# ---- background work outliving the turn (pipeline hand-off) ---------------
# Record shapes follow qwen-code 0.22.2's own writers (bundle, read-only):
# ChatRecordingService.recordToolResult writes a `tool_result` record whose
# message.parts carry functionResponse.response.output = the tool's llmContent;
# the agent tool returns "Background agent launched successfully.\ntask_id: <id>"
# and the shell tool "Background shell started.\nid: <id>". A finished task
# comes back as a `user` record, subtype "notification", whose part text is the
# <task-notification> XML (BackgroundTaskRegistry / BackgroundShellRegistry
# emitNotification). Top-level subagents run in the background BY DEFAULT.


def _tool_result(uuid: str, name: str, output: str) -> dict:
    return _rec("tool_result", uuid, message={"role": "user", "parts": [
        {"functionResponse": {"id": f"call_{uuid}", "name": name, "response": {"output": output}}},
    ]})


def _notification(uuid: str, xml: str) -> dict:
    rec = _rec("user", uuid, subtype="notification", provenance="system",
               message={"role": "user", "parts": [{"text": xml}]})
    rec["systemPayload"] = {"displayText": "Background agent finished."}
    return rec


def _qwen_bg_events(events: list) -> list[tuple[str, str]]:
    return [(e.detail, e.text) for e in events if e.detail.startswith("background:")]


def test_parse_activity_reports_background_agent_and_shell_starts(
    fake_qwen_root: Path,
) -> None:
    reader = QwenLogReader()
    f = _chat_file(fake_qwen_root)
    _write_jsonl(f, [
        _user("u1", "review the branch"),
        _tool_result("t1", "agent",
                     "Background agent launched successfully.\n"
                     "task_id: reviewer-7f3a (internal ID — do not mention to the user.)\n"
                     "The agent is working in the background."),
        _tool_result("t2", "run_shell_command",
                     "Background shell started.\nid: bg_4c21\npid: 4242\noutput file: /tmp/x.out"),
        # a foreground tool result is not background work
        _tool_result("t3", "read_file", "file contents"),
        _assistant_saying("a1", "launched the reviewer"),
    ])
    events = reader.parse_activity(f, set())
    assert _qwen_bg_events(events) == [
        ("background:start", "reviewer-7f3a"),
        ("background:start", "bg_4c21"),
    ]
    assert all(e.event_type == "agent_active" for e in events if e.detail.startswith("background:"))
    assert len({e.dedup_key for e in events}) == len(events)


def test_parse_activity_reports_background_task_ends_from_notifications(
    fake_qwen_root: Path,
) -> None:
    reader = QwenLogReader()
    f = _chat_file(fake_qwen_root)
    _write_jsonl(f, [
        _notification("n1", "<task-notification>\n<task-id>reviewer-7f3a</task-id>\n"
                            "<tool-use-id>call_t1</tool-use-id>\n<status>completed</status>\n"
                            "<summary>Agent \"review\" completed.</summary>\n</task-notification>"),
        _notification("n2", "<task-notification>\n<task-id>bg_4c21</task-id>\n<kind>shell</kind>\n"
                            "<status>cancelled</status>\n</task-notification>"),
        # a Monitor event is status=running: its task keeps going
        _notification("n3", "<task-notification>\n<task-id>mon_1</task-id>\n<kind>monitor</kind>\n"
                            "<status>running</status>\n<event-count>3</event-count>\n</task-notification>"),
        # a cron prompt is not a task end
        _user("c1", "<task-notification><task-id>x</task-id><status>completed</status></task-notification>",
              subtype="cron"),
    ])
    events = reader.parse_activity(f, set())
    assert _qwen_bg_events(events) == [
        ("background:end", "reviewer-7f3a"),
        ("background:end", "bg_4c21"),
    ]


def test_parse_activity_background_events_do_not_touch_the_turn_state(
    fake_qwen_root: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The silence-based turn end is unchanged: the foreground turn still ends
    (the frontend's pipeline verdict is what holds on the running task), and
    the notification opens no turn of its own."""
    reader = QwenLogReader()
    f = _chat_file(fake_qwen_root)
    _write_jsonl(f, [
        _user("u1", "go"),
        _tool_result("t1", "agent", "Background agent launched successfully.\ntask_id: a-1\n"),
        _assistant_saying("a1", "launched"),
        _notification("n1", "<task-notification>\n<task-id>a-1</task-id>\n<status>completed</status>\n</task-notification>"),
    ])
    _go_quiet(f, monkeypatch)
    events = reader.parse_activity(f, set())
    assert [(e.dedup_key, e.detail, e.text) for e in events if e.event_type == "turn_complete"] == [
        ("turn:0", "idle", "launched"),
    ]
    assert _qwen_bg_events(events) == [("background:start", "a-1"), ("background:end", "a-1")]


def test_parse_activity_without_background_work_emits_no_background_events(
    fake_qwen_root: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    reader = QwenLogReader()
    f = _chat_file(fake_qwen_root)
    _write_jsonl(f, [
        _user("u1", "go"),
        _tool_result("t1", "read_file", "Background shell started. is just file text here"),
        _assistant_saying("a1", "done"),
    ])
    _go_quiet(f, monkeypatch)
    events = reader.parse_activity(f, set())
    assert _qwen_bg_events(events) == []
    assert [e.detail for e in events] == ["user", "assistant", "idle"]
