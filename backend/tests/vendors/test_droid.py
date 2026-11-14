"""Droid vendor: cwd encoding, session lookup, resume parsing, log reading.

The fixtures mirror droid 0.204.0's real on-disk shapes — a `session_start`
first line, Anthropic-shaped content blocks, and the separate
`agent_turn_outcome` record that marks a turn's end.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.cli_vendors import droid
from agent_team_backend.cli_vendors.droid import (
    DroidLogReader,
    encode_droid_cwd,
)


# ---- cwd encoding ---------------------------------------------------------
#
# Droid's own encoder is platform-specific: the macOS/Linux build spells the
# session directory one way and the Windows build another. Every case passes
# the platform explicitly so both spellings are pinned on any runner, Windows
# CI included, and none of them is skipped away outside Windows.

def test_encode_replaces_only_separators() -> None:
    """The whole point of not reusing encode_claude_cwd: droid keeps hyphens
    and dots, Claude's encoder would flatten them."""
    assert encode_droid_cwd("/Users/me/Desktop/Agent-Team", platform="linux") == (
        "-Users-me-Desktop-Agent-Team"
    )
    assert encode_droid_cwd("/Users/me/my.proj", platform="linux") == (
        "-Users-me-my.proj"
    )
    assert encode_droid_cwd("/Users/me/a_b", platform="linux") == "-Users-me-a_b"


def test_encode_strips_trailing_and_collapses_runs() -> None:
    assert encode_droid_cwd("/Users/me/proj/", platform="linux") == "-Users-me-proj"
    assert encode_droid_cwd("/Users//me///proj", platform="linux") == "-Users-me-proj"


def test_encode_matches_the_real_directory_on_disk() -> None:
    """Regression anchor: this exact pair was read off a real droid install."""
    assert encode_droid_cwd("/Users/neillu/Desktop/Agent-Team", platform="darwin") == (
        "-Users-neillu-Desktop-Agent-Team"
    )


def test_encode_darwin_and_linux_share_the_posix_spelling() -> None:
    cwd = "/Users/me/Agent-Team"
    assert (
        encode_droid_cwd(cwd, platform="darwin")
        == encode_droid_cwd(cwd, platform="linux")
        == "-Users-me-Agent-Team"
    )


def test_encode_windows_drops_the_drive_colon() -> None:
    """The Windows build keeps the drive letter but drops the ``:`` and
    rewrites backslashes as separators — the spelling the old encoder could
    never produce, because it only knew ``/``."""
    assert encode_droid_cwd(r"C:\Users\me\proj", platform="win32") == (
        "-C-Users-me-proj"
    )
    assert encode_droid_cwd(r"C:\Users\me\Agent-Team", platform="win32") == (
        "-C-Users-me-Agent-Team"
    )
    # A lower-case drive and a path typed with forward slashes are normalised
    # the way droid's own ``path.resolve`` would spell them.
    assert encode_droid_cwd(r"c:\Users\Me\proj", platform="win32") == (
        "-c-Users-Me-proj"
    )
    assert encode_droid_cwd("C:/Users/me/proj", platform="win32") == (
        "-C-Users-me-proj"
    )


def test_encode_windows_collapses_separator_runs_and_trailing() -> None:
    assert encode_droid_cwd(r"C:\\Users\\\me\proj", platform="win32") == (
        "-C-Users-me-proj"
    )
    assert encode_droid_cwd("C:\\Users\\me\\proj\\", platform="win32") == (
        "-C-Users-me-proj"
    )


def test_encode_windows_keeps_the_unc_leading_run() -> None:
    """A UNC cwd has no drive letter to absorb the leading separators, so the
    run survives as a ``-`` and the prepended ``-`` makes two."""
    assert encode_droid_cwd(r"\\server\share\proj", platform="win32") == (
        "--server-share-proj"
    )


def test_default_encoder_follows_the_platform_seam(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The default is ``osplat.platform_id``, so a native Windows runner
    encodes a Windows cwd with no test-side override."""
    from agent_team_backend import osplat

    assert droid._platform_id == osplat.platform_id
    monkeypatch.setattr(droid, "_platform_id", "win32")
    assert encode_droid_cwd(r"C:\Users\me\proj") == "-C-Users-me-proj"
    monkeypatch.setattr(droid, "_platform_id", "linux")
    assert encode_droid_cwd("/Users/me/proj") == "-Users-me-proj"


# ---- fixtures -------------------------------------------------------------

def _write_session(
    root: Path, cwd: str, session_id: str, lines: list[dict]
) -> Path:
    d = root / encode_droid_cwd(cwd)
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{session_id}.jsonl"
    path.write_text(
        "".join(json.dumps(rec) + "\n" for rec in lines), encoding="utf-8"
    )
    return path


def _session_start(session_id: str, cwd: str, **extra) -> dict:
    return {
        "type": "session_start",
        "id": session_id,
        "title": "t",
        "owner": "me",
        "version": 2,
        "cwd": cwd,
        **extra,
    }


def _msg(role: str, content, **extra) -> dict:
    return {
        "type": "message",
        "id": f"m-{role}-{len(str(content))}",
        "timestamp": "2026-08-26T17:58:46.446Z",
        "message": {"role": role, "content": content, **extra},
    }


@pytest.fixture()
def sessions_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / ".factory" / "sessions"
    root.mkdir(parents=True)
    monkeypatch.setenv("FACTORY_HOME_OVERRIDE", str(tmp_path / ".factory"))
    return root


# ---- root resolution ------------------------------------------------------

def test_root_honours_home_override(sessions_root: Path) -> None:
    assert droid.droid_sessions_root() == sessions_root


def test_root_is_none_when_absent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FACTORY_HOME_OVERRIDE", str(tmp_path / "nope"))
    assert droid.droid_sessions_root() is None


# ---- file discovery -------------------------------------------------------

def test_session_files_covers_all_three_layouts(sessions_root: Path) -> None:
    _write_session(sessions_root, "/w", "a", [_session_start("a", "/w")])
    (sessions_root / "flat.jsonl").write_text("", encoding="utf-8")
    btw = sessions_root / "btw"
    btw.mkdir()
    (btw / "forked.jsonl").write_text("", encoding="utf-8")

    names = {p.name for p in DroidLogReader().session_files()}
    assert names == {"a.jsonl", "flat.jsonl", "forked.jsonl"}


def test_session_files_ignores_the_settings_sidecar(
    sessions_root: Path,
) -> None:
    path = _write_session(sessions_root, "/w", "a", [_session_start("a", "/w")])
    (path.parent / "a.settings.json").write_text("{}", encoding="utf-8")
    assert [p.name for p in DroidLogReader().session_files()] == ["a.jsonl"]


def test_session_files_for_workspace_scopes_to_one_directory(
    sessions_root: Path,
) -> None:
    _write_session(sessions_root, "/w/one", "a", [_session_start("a", "/w/one")])
    _write_session(sessions_root, "/w/two", "b", [_session_start("b", "/w/two")])

    got = DroidLogReader().session_files_for_workspace("/w/one")
    assert [p.name for p in got] == ["a.jsonl"]


# ---- cwd from file --------------------------------------------------------

def test_cwd_comes_from_session_start(sessions_root: Path) -> None:
    path = _write_session(
        sessions_root, "/w/proj", "a", [_session_start("a", "/w/proj")]
    )
    assert DroidLogReader().cwd_from_file(path) == "/w/proj"


def test_last_cwd_wins_over_cwd(sessions_root: Path) -> None:
    """droid itself prefers lastCwd — cwd is only where the session is filed."""
    path = _write_session(
        sessions_root, "/w/proj", "a",
        [_session_start("a", "/w/proj", lastCwd="/w/moved")],
    )
    assert DroidLogReader().cwd_from_file(path) == "/w/moved"


def test_cwd_survives_a_hyphenated_directory(sessions_root: Path) -> None:
    """The reason cwd is READ rather than reversed from the directory name:
    '-w-Agent-Team' cannot be reversed unambiguously."""
    path = _write_session(
        sessions_root, "/w/Agent-Team", "a", [_session_start("a", "/w/Agent-Team")]
    )
    assert DroidLogReader().cwd_from_file(path) == "/w/Agent-Team"


def test_cwd_is_empty_for_a_malformed_first_line(sessions_root: Path) -> None:
    d = sessions_root / encode_droid_cwd("/w")
    d.mkdir(parents=True)
    path = d / "a.jsonl"
    path.write_text("not json\n", encoding="utf-8")
    assert DroidLogReader().cwd_from_file(path) == ""


# ---- Windows path format (reader) -----------------------------------------

def test_windows_workspace_session_is_discovered(
    sessions_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The reader must look where droid actually writes on Windows: the drive
    letter, no colon, and backslashes flattened to ``-``."""
    monkeypatch.setattr(droid, "_platform_id", "win32")
    cwd = r"C:\Users\me\Agent-Team"
    path = _write_session(sessions_root, cwd, "abc", [_session_start("abc", cwd)])
    assert path.parent.name == "-C-Users-me-Agent-Team"
    got = DroidLogReader().session_files_for_workspace(cwd)
    assert [p.name for p in got] == ["abc.jsonl"]


def test_windows_cwd_is_read_back_verbatim(
    sessions_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(droid, "_platform_id", "win32")
    cwd = r"C:\Users\me\proj"
    path = _write_session(sessions_root, cwd, "abc", [_session_start("abc", cwd)])
    assert DroidLogReader().cwd_from_file(path) == cwd


# ---- activity -------------------------------------------------------------

def test_turn_outcome_emits_turn_complete_with_the_assistant_text(
    sessions_root: Path,
) -> None:
    path = _write_session(sessions_root, "/w", "a", [
        _session_start("a", "/w"),
        _msg("user", [{"type": "text", "text": "hello"}]),
        _msg("assistant", [{"type": "text", "text": "hi there"}]),
        {"type": "agent_turn_outcome", "turnId": "t1", "reason": "completed",
         "resultKind": "text"},
    ])
    events = DroidLogReader().parse_activity(path, set())

    done = [e for e in events if e.event_type == "turn_complete"]
    assert len(done) == 1
    assert done[0].detail == "completed"
    assert done[0].text == "hi there"
    assert done[0].cwd == "/w"
    assert done[0].session_id == "a"


def test_turn_text_survives_poll_boundary_and_is_consumed(sessions_root: Path) -> None:
    path = _write_session(sessions_root, "/w", "a", [
        _session_start("a", "/w"),
        _msg("assistant", [{"type": "text", "text": "reply across polls"}]),
    ])
    reader, seen = DroidLogReader(), set()
    reader.parse_activity(path, seen)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"type": "agent_turn_outcome", "reason": "completed"}) + "\n")
    assert [e.text for e in reader.parse_activity(path, seen)
            if e.event_type == "turn_complete"] == ["reply across polls"]
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"type": "agent_turn_outcome", "reason": "cancelled"}) + "\n")
    assert [e.text for e in reader.parse_activity(path, seen)
            if e.event_type == "turn_complete"] == [""]


def test_new_prompt_discards_unfinished_previous_turn_text(sessions_root: Path) -> None:
    path = _write_session(sessions_root, "/w", "a", [
        _session_start("a", "/w"),
        _msg("assistant", [{"type": "text", "text": "previous reply"}]),
    ])
    reader, seen = DroidLogReader(), set()
    reader.parse_activity(path, seen)
    with path.open("a", encoding="utf-8") as fh:
        for record in [
            _msg("user", [{"type": "text", "text": "next prompt"}]),
            {"type": "agent_turn_outcome", "reason": "cancelled"},
        ]:
            fh.write(json.dumps(record) + "\n")
    assert [e.text for e in reader.parse_activity(path, seen)
            if e.event_type == "turn_complete"] == [""]


@pytest.mark.parametrize(
    "reason", ["cancelled", "error", "permission_rejected", "process_exit"]
)
def test_an_aborted_turn_still_completes(
    sessions_root: Path, reason: str
) -> None:
    """A cancelled turn has still STOPPED. Withholding turn_complete here is
    what strands a pane in mid-turn forever."""
    path = _write_session(sessions_root, "/w", "a", [
        _session_start("a", "/w"),
        {"type": "agent_turn_outcome", "turnId": "t1", "reason": reason},
    ])
    events = DroidLogReader().parse_activity(path, set())
    done = [e for e in events if e.event_type == "turn_complete"]
    assert [e.detail for e in done] == [reason]


def test_user_prompt_text_is_carried_for_pane_naming(
    sessions_root: Path,
) -> None:
    path = _write_session(sessions_root, "/w", "a", [
        _session_start("a", "/w"),
        _msg("user", [{"type": "text", "text": "rename this pane"}]),
    ])
    events = DroidLogReader().parse_activity(path, set())
    user = [e for e in events if e.detail == "user"]
    assert [e.text for e in user] == ["rename this pane"]


def test_tool_results_carry_no_prompt_text(sessions_root: Path) -> None:
    """droid files tool results under role=user; naming a pane after one would
    show a command's output as the pane title."""
    path = _write_session(sessions_root, "/w", "a", [
        _session_start("a", "/w"),
        _msg("user", [
            {"type": "tool_result", "tool_use_id": "tu1", "content": "README.md"}
        ]),
    ])
    events = DroidLogReader().parse_activity(path, set())
    assert [e.text for e in events if e.detail == "user"] == [""]


def test_hook_records_carry_no_prompt_text(sessions_root: Path) -> None:
    """Every hook invocation is persisted as a role=user message; a pane must
    not be named after a shell snippet."""
    path = _write_session(sessions_root, "/w", "a", [
        _session_start("a", "/w"),
        _msg("user", [], hookEventName="SessionStart", hookMatcher="startup"),
    ])
    events = DroidLogReader().parse_activity(path, set())
    assert [e.text for e in events if e.detail == "user"] == [""]


def test_assistant_lines_report_activity(sessions_root: Path) -> None:
    path = _write_session(sessions_root, "/w", "a", [
        _session_start("a", "/w"),
        _msg("assistant", [
            {"type": "tool_use", "id": "tu1", "name": "Execute",
             "input": {"command": "ls"}}
        ]),
    ])
    events = DroidLogReader().parse_activity(path, set())
    assert [e.detail for e in events if e.event_type == "agent_active"] == [
        "assistant"
    ]


def test_activity_does_not_re_emit_on_a_second_poll(
    sessions_root: Path,
) -> None:
    path = _write_session(sessions_root, "/w", "a", [
        _session_start("a", "/w"),
        _msg("assistant", [{"type": "text", "text": "hi"}]),
        {"type": "agent_turn_outcome", "turnId": "t1", "reason": "completed"},
    ])
    reader = DroidLogReader()
    seen: set[str] = set()
    assert reader.parse_activity(path, seen)
    assert reader.parse_activity(path, seen) == []


def test_a_half_written_final_line_is_re_read_next_poll(
    sessions_root: Path,
) -> None:
    """Stepping over an unterminated line loses it for good — and when the lost
    line is the turn outcome, the pane never leaves mid-turn (GitHub #21)."""
    path = _write_session(sessions_root, "/w", "a", [
        _session_start("a", "/w"),
        _msg("assistant", [{"type": "text", "text": "hi"}]),
    ])
    with path.open("a", encoding="utf-8") as fh:
        fh.write('{"type":"agent_turn_outcome","turnId":"t1","reason":"comp')

    reader = DroidLogReader()
    seen: set[str] = set()
    first = reader.parse_activity(path, seen)
    assert [e.event_type for e in first] == ["agent_active"]

    with path.open("a", encoding="utf-8") as fh:
        fh.write('leted"}\n')
    second = reader.parse_activity(path, seen)
    assert [e.event_type for e in second] == ["turn_complete"]


def test_unknown_record_types_are_ignored(sessions_root: Path) -> None:
    path = _write_session(sessions_root, "/w", "a", [
        _session_start("a", "/w"),
        {"type": "compaction_state", "id": "c1", "summaryText": "x"},
        {"type": "something_new", "id": "z"},
    ])
    assert DroidLogReader().parse_activity(path, set()) == []


# ---- token usage ----------------------------------------------------------

def _write_sidecar(path: Path, **usage) -> None:
    (path.parent / f"{path.stem}.settings.json").write_text(
        json.dumps({"model": "claude-opus-5", "tokenUsage": {
            "inputTokens": 0, "outputTokens": 0, "cacheCreationTokens": 0,
            "cacheReadTokens": 0, "thinkingTokens": 0, **usage,
        }}),
        encoding="utf-8",
    )


def test_usage_folds_cache_into_input(sessions_root: Path) -> None:
    path = _write_session(sessions_root, "/w", "a", [_session_start("a", "/w")])
    _write_sidecar(
        path, inputTokens=10, cacheCreationTokens=5, cacheReadTokens=7,
        outputTokens=3,
    )
    events = DroidLogReader().parse_session_file(path, set())
    assert len(events) == 1
    assert events[0].input_tokens == 22
    assert events[0].output_tokens == 3
    assert events[0].model == "claude-opus-5"
    assert events[0].cwd == "/w"


def test_usage_reports_deltas_not_running_totals(sessions_root: Path) -> None:
    path = _write_session(sessions_root, "/w", "a", [_session_start("a", "/w")])
    _write_sidecar(path, inputTokens=10, outputTokens=3)
    reader = DroidLogReader()
    seen: set[str] = set()
    first = reader.parse_session_file(path, seen)
    assert (first[0].input_tokens, first[0].output_tokens) == (10, 3)

    _write_sidecar(path, inputTokens=25, outputTokens=8)
    second = reader.parse_session_file(path, seen)
    assert (second[0].input_tokens, second[0].output_tokens) == (15, 5)


def test_usage_is_silent_when_nothing_moved(sessions_root: Path) -> None:
    path = _write_session(sessions_root, "/w", "a", [_session_start("a", "/w")])
    _write_sidecar(path, inputTokens=10, outputTokens=3)
    reader = DroidLogReader()
    seen: set[str] = set()
    reader.parse_session_file(path, seen)
    assert reader.parse_session_file(path, seen) == []


def test_a_shrinking_sidecar_rebaselines_instead_of_going_negative(
    sessions_root: Path,
) -> None:
    """A replaced sidecar (fork, reset) is not a token refund."""
    path = _write_session(sessions_root, "/w", "a", [_session_start("a", "/w")])
    _write_sidecar(path, inputTokens=100, outputTokens=50)
    reader = DroidLogReader()
    seen: set[str] = set()
    reader.parse_session_file(path, seen)

    _write_sidecar(path, inputTokens=10, outputTokens=5)
    assert reader.parse_session_file(path, seen) == []

    _write_sidecar(path, inputTokens=30, outputTokens=11)
    again = reader.parse_session_file(path, seen)
    assert (again[0].input_tokens, again[0].output_tokens) == (20, 6)


def test_usage_without_a_sidecar_is_empty(sessions_root: Path) -> None:
    path = _write_session(sessions_root, "/w", "a", [_session_start("a", "/w")])
    assert DroidLogReader().parse_session_file(path, set()) == []


def test_usage_survives_a_malformed_sidecar(sessions_root: Path) -> None:
    path = _write_session(sessions_root, "/w", "a", [_session_start("a", "/w")])
    (path.parent / "a.settings.json").write_text("{oops", encoding="utf-8")
    assert DroidLogReader().parse_session_file(path, set()) == []


def test_token_marker_does_not_accumulate(sessions_root: Path) -> None:
    """seen_keys must not grow with the session — see log_readers.base."""
    path = _write_session(sessions_root, "/w", "a", [_session_start("a", "/w")])
    reader = DroidLogReader()
    seen: set[str] = set()
    for n in range(1, 6):
        _write_sidecar(path, inputTokens=n * 10, outputTokens=n)
        reader.parse_session_file(path, seen)
    marks = [k for k in seen if k.startswith("droid_tok::")]
    assert len(marks) == 1


# ---- resume ---------------------------------------------------------------

@pytest.mark.parametrize("command,expected", [
    ("droid --resume abc-123", "abc-123"),
    ("droid -r abc-123", "abc-123"),
    ("droid --auto high --resume abc-123", "abc-123"),
    ("droid", ""),
    ("claude --resume abc-123", ""),
])
def test_resume_id_from_command(command: str, expected: str) -> None:
    assert droid.SPEC.resume_id_from_command(command) == expected


def test_resume_id_from_a_wrapped_command() -> None:
    """The frontend wraps agent commands as [shell, '-ilc', '<cmd>']."""
    wrapped = ["/bin/zsh", "-ilc", "droid --resume abc-123"]
    assert droid.SPEC.resume_id_from_command(wrapped) == "abc-123"


def test_resume_id_from_a_windows_wrapped_command() -> None:
    """On Windows a non-agent pane arrives as [cmd.exe, '/d', '/s', '/c',
    '<cmd>']; ``command_text`` unwraps to the last element, so the id is still
    found there."""
    wrapped = ["cmd.exe", "/d", "/s", "/c", "droid --resume abc-123"]
    assert droid.SPEC.resume_id_from_command(wrapped) == "abc-123"


def test_session_path_points_at_the_workspace_directory(
    sessions_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Pin the POSIX spelling so this assertion is the same on a Windows runner.
    monkeypatch.setattr(droid, "_platform_id", "darwin")
    got = droid.SPEC.session_path("/w/proj", "abc")
    assert got == sessions_root / "-w-proj" / "abc.jsonl"


def test_windows_session_path_points_at_the_windows_directory(
    sessions_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(droid, "_platform_id", "win32")
    got = droid.SPEC.session_path(r"C:\Users\me\proj", "abc")
    assert got == sessions_root / "-C-Users-me-proj" / "abc.jsonl"


def test_windows_session_exists_finds_the_workspace_file(
    sessions_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(droid, "_platform_id", "win32")
    cwd = r"C:\Users\me\proj"
    assert droid.SPEC.session_exists(cwd, "abc") is False
    _write_session(sessions_root, cwd, "abc", [_session_start("abc", cwd)])
    assert droid.SPEC.session_exists(cwd, "abc") is True
    assert droid.SPEC.session_exists(cwd, "nope") is False


def test_session_exists_finds_the_workspace_file(sessions_root: Path) -> None:
    _write_session(sessions_root, "/w/proj", "abc", [_session_start("abc", "/w/proj")])
    assert droid.SPEC.session_exists("/w/proj", "abc") is True
    assert droid.SPEC.session_exists("/w/proj", "nope") is False


def test_session_exists_accepts_a_forked_session(sessions_root: Path) -> None:
    """A fork lands in sessions/btw/ — reporting it missing would discard the
    pane's saved conversation and start a fresh one."""
    btw = sessions_root / "btw"
    btw.mkdir()
    (btw / "forked.jsonl").write_text("", encoding="utf-8")
    assert droid.SPEC.session_exists("/w/proj", "forked") is True


# ---- spec identity --------------------------------------------------------

def test_spec_strips_the_child_session_marker() -> None:
    """Inherited, DROID_PARENT_SESSION_ID makes a fresh pane a child of the
    session that spawned Navide — the droid twin of the CLAUDE_CODE_CHILD_
    SESSION bug."""
    assert "DROID_PARENT_SESSION_ID" in droid.SPEC.home_env_vars
    assert "FACTORY_HOME_OVERRIDE" in droid.SPEC.home_env_vars


def test_reader_binding_flags() -> None:
    assert DroidLogReader.emits_session_sink is True
    assert DroidLogReader.binds_by_marker_file is True
    assert DroidLogReader.binds_new_session_single_candidate is True


# ---- attribution hooks ----------------------------------------------------

def test_events_attribute_to_the_pane_workspace_by_cwd(sessions_root: Path, tmp_path: Path) -> None:
    """Without workspace_match/pane_cwd_match every Droid activity and usage
    event resolved to no workspace and was silently dropped."""
    from agent_team_backend.log_readers.attribution import Attribution
    from agent_team_backend.log_readers.base import TokenUsage

    path = _write_session(sessions_root, "/w/proj", "a", [_session_start("a", "/w/proj")])
    attr = Attribution([DroidLogReader()], workspaces_path=tmp_path / "ws.json")
    attr.register_pane("p1", vendor="droid", cwd="/w/proj", workspace_path="/w/proj")

    def usage(cwd: str) -> TokenUsage:
        return TokenUsage(vendor="droid", input_tokens=1, output_tokens=1, cwd=cwd,
                          session_id="a", file_path=str(path), dedup_key="")

    assert attr.attribute(usage("/w/proj")).workspace_path == "/w/proj"
    assert attr.attribute(usage("/w/other")).workspace_path is None


def test_parse_activity_resumes_after_an_append(sessions_root: Path, monkeypatch) -> None:
    from tests.activity_resume_support import assert_resumes

    def turn(prompt: str, reply: str) -> list[dict]:
        return [
            _msg("user", [{"type": "text", "text": prompt}]),
            _msg("assistant", [{"type": "text", "text": reply}]),
            {"type": "agent_turn_outcome", "turnId": prompt, "reason": "completed",
             "resultKind": "text"},
        ]

    path = _write_session(sessions_root, "/w", "a", [_session_start("a", "/w"), *turn("first", "one")])
    assert_resumes(DroidLogReader, path, turn("second", "two"), monkeypatch)
