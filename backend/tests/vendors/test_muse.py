"""Muse Code vendor spec + MuseLogReader.

The spec half pins identity, install detection and resume parsing, and keeps a
guard test over the capabilities that are still deliberately unset, so a
future round that fills one in has to update it consciously rather than
acquire half-working behaviour by accident.

The reader half is written against the envelope format of real
``session.jsonl`` files: date-layered session directories, microsecond
``recorded_at``, ``goal_usage_attribution`` token rows and the explicit
``terminal`` end-of-turn record.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.cli_vendors.muse import SPEC, MuseLogReader
from agent_team_backend.cli_vendors.registry import VENDORS, vendor
from agent_team_backend.log_readers.attribution import Attribution
from agent_team_backend.log_readers.base import TokenUsage, activity_high_water

# The session DIRECTORY's name — the only id `muse resume` accepts.
_SID = "b3ef50f0-e347-4887-a498-c7c16c3aa11e"
# The internal command id that appears inside payloads. Deliberately different
# from _SID: mistaking it for the session id makes every resume fail.
_CMD = "4c39ad2b-b850-428e-814c-45e6212c53f0"
_CWD = "/Users/me/proj"
_DAY = ("2026", "08", "12")
_T0 = 1786491820000000  # microseconds


# ─────────────────────────────── record builders ─────────────────────────────

def _envelope(seq: int, payload_type: str, payload: dict,
              session_id: str = _SID) -> dict:
    return {
        "schema_version": 1,
        "id": f"env-{seq}",
        "stream": {"kind": "session", "id": session_id},
        "sequence": seq,
        "recorded_at": _T0 + seq,
        "record_type": "event",
        "durability": "durable",
        "causation_id": None,
        "payload_type": payload_type,
        "payload_schema_version": 1,
        "payload": payload,
    }


def _metadata(cwd: str = _CWD, seq: int = 1) -> dict:
    return _envelope(seq, "runtime.session.metadata", {
        "kind": "metadata",
        "record": {"workspace_root": cwd, "provider_id": "echo",
                   "tool_surface_version": "2"},
    })


def _intake(prompt: str, seq: int = 4) -> dict:
    return _envelope(seq, "runtime.command_intake.received", {
        "kind": "command_intake",
        "record": {
            "kind": "received",
            "command_id": _CMD,
            "session_stream": {"kind": "session", "id": _CMD},
            "command": {"kind": "turn_submit", "prompt": prompt},
        },
    })


def _run(event: dict, seq: int) -> dict:
    return _envelope(seq, "runtime.session",
                     {"kind": "run", "run_id": _CMD, "event": event})


def _usage_row(usage_id: str, seq: int, *, input_tokens: int = 100,
               output_tokens: int = 20, cached: int = 0, reasoning: int = 0,
               requester_kind: str = "main") -> dict:
    return _run({
        "kind": "goal_usage_attribution",
        "record": {
            "schema_version": 1,
            "usage_id": usage_id,
            "usage_family": "provider",
            "quantity": {
                "unit": "tokens", "reported": True,
                "input_tokens": input_tokens, "output_tokens": output_tokens,
                "cached_tokens": cached, "reasoning_tokens": reasoning,
                "main_llm_steps": 1,
            },
            "owner": {"requester_kind": requester_kind, "session_id": _CMD,
                      "run_id": _CMD, "owner_id": "main-root"},
            "goal_attribution": {"mode": "none"},
        },
    }, seq)


def _assistant(text: str, seq: int) -> dict:
    return _run({"kind": "assistant_message_committed",
                 "message_id": f"msg-{seq}", "text": text}, seq)


def _terminal(seq: int, terminal: str = "completed") -> dict:
    return _run({"kind": "terminal", "terminal": terminal, "reason": None,
                 "turn_duration_ms": 185}, seq)


def _diagnostic(seq: int) -> dict:
    return _run({"kind": "context_block_diagnostic", "block": "system"}, seq)


def _write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


def _append_jsonl(path: Path, records: list[dict]) -> None:
    with path.open("a", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


@pytest.fixture
def fake_muse_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The sessions root under a fake $XDG_DATA_HOME."""
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "share"))
    return tmp_path / "share" / "muse" / "sessions"


def _session_file(root: Path, session_id: str = _SID,
                  day: tuple[str, str, str] = _DAY) -> Path:
    return root.joinpath(*day, session_id, "session.jsonl")


def _subagent_file(root: Path, child_id: str, session_id: str = _SID,
                   day: tuple[str, str, str] = _DAY) -> Path:
    return root.joinpath(*day, session_id, "subagent", child_id, "session.jsonl")


# ───────────────────────────────── vendor spec ───────────────────────────────

def test_spec_is_registered_under_its_key() -> None:
    assert VENDORS["muse"] is SPEC
    assert vendor("muse") is SPEC
    assert SPEC.key == "muse"
    assert SPEC.label == "Muse Code (Meta)"


def test_install_dep_detects_and_installs_the_cli() -> None:
    dep = SPEC.install_dep
    assert dep is not None
    assert dep.id == "muse"
    assert dep.group == "agent_cli"
    assert dep.check_cmd == ["muse", "--version"]
    # Shell-script install (like aider), so curl must be present first and the
    # command runs in an external terminal for the interactive login.
    assert dep.install_cmd == "curl -fsSL https://dev.meta.ai/install.sh | sh"
    assert dep.requires_binaries == ("curl",)
    assert dep.needs_terminal is True
    assert dep.optional is True


def test_install_dep_claims_no_maintenance_commands() -> None:
    # Meta documents no update/doctor command and ships no npm package; the
    # wizard must fall back to docs_url rather than invent one.
    dep = SPEC.install_dep
    assert dep is not None
    assert dep.update_cmd == ""
    assert dep.doctor_cmd == ""
    assert dep.npm_package == ""
    assert dep.docs_url


def test_resume_id_is_read_from_the_documented_subcommand() -> None:
    # Meta documents `muse resume <id>` — a subcommand, not a --flag.
    parse = SPEC.resume_id_from_command
    assert parse is not None
    assert parse("muse resume 4d4a11fe-b08a-46df-9f86-685589531e65") == (
        "4d4a11fe-b08a-46df-9f86-685589531e65")
    assert parse("muse resume abc --disable-approval") == "abc"
    # The real command is the last element of the frontend's shell wrapper.
    assert parse(["/bin/zsh", "-ilc", "muse resume abc"]) == "abc"


def test_non_resume_commands_yield_no_id() -> None:
    parse = SPEC.resume_id_from_command
    assert parse is not None
    assert parse("muse") == ""
    assert parse("muse resume") == ""
    assert parse("muse exec 'run the tests'") == ""
    # Never claim another vendor's command.
    assert parse("codex resume abc") == ""


def test_unverified_capabilities_stay_unset() -> None:
    """Guard over what muse still does NOT claim.

    Verified and now wired (so they are asserted PRESENT below): the session
    log format, hence ``make_log_reader``, and the ability to find a known
    id's file, hence ``session_exists``.

    Still unset, each for a reason:
    """
    # Credentials: the launcher script names the file and its shape (see
    # ``account_switch``), but MUSE_AUTH_PATH is a file path, not a home, so
    # no login-home isolation exists and no legacy profile home ever did.
    assert SPEC.live_file == (".config", "muse", "auth.json")
    assert SPEC.slot_file == "auth.json"
    assert SPEC.login_home_env is None
    assert SPEC.login_home_secret_file is None
    assert SPEC.profile_home_secret_file is None
    assert SPEC.login_home_env is None
    assert SPEC.home_env_vars == ()
    # Quota is a web dashboard; there is no CLI usage command to call.
    assert SPEC.fetch_usage is None
    # Sessions are filed by DATE, so an id maps to a directory NAME but not to
    # one path — only a scan can say which day it lives under. session_exists
    # does that scan; session_path has nothing single to return.
    assert SPEC.session_path is None
    # Not observed.
    assert SPEC.interrupt_key is None


def test_verified_capabilities_are_wired() -> None:
    assert SPEC.make_log_reader is MuseLogReader
    assert SPEC.session_exists is not None


# ─────────────────────────────── file discovery ──────────────────────────────

def test_session_files_exclude_subagent_logs(fake_muse_root: Path) -> None:
    """A subagent's usage is already attributed in the PARENT log, so reading
    the child's own session.jsonl too would double-count its tokens."""
    main = _session_file(fake_muse_root)
    _write_jsonl(main, [_metadata(), _usage_row("u-main", 10)])
    child = _subagent_file(fake_muse_root, "9204c1bf-b2c4-403c-bafc-6219be29a061")
    _write_jsonl(child, [_usage_row("u-child", 4)])

    assert MuseLogReader().session_files() == [main]


def test_subagent_logs_are_rejected_by_the_realtime_parsers(
    fake_muse_root: Path,
) -> None:
    """session_files() filters subagent logs, but the REALTIME path never
    consults it: a fs event under sessions/ is claimed by claims_path (any
    path under project_dirs) and handed straight to parse_incremental /
    parse_activity. Without their own filter, a child's tokens — already
    attributed in the parent log — would be counted a second time.
    """
    reader = MuseLogReader()
    child = _subagent_file(fake_muse_root, "9204c1bf-b2c4-403c-bafc-6219be29a061")
    _write_jsonl(child, [
        _metadata(), _intake("child task", seq=2), _usage_row("u-child", 4),
        _assistant("done", 5), _terminal(6),
    ])

    assert reader.claims_path(child) is True
    parsed = reader.parse_incremental(child, {})
    assert parsed.events == []
    assert parsed.checkpoint == {}
    assert reader.parse_activity(child, set()) == []


def test_session_files_finds_every_day_directory(fake_muse_root: Path) -> None:
    a = _session_file(fake_muse_root, "sess-a", day=("2026", "08", "11"))
    b = _session_file(fake_muse_root, "sess-b", day=("2026", "08", "12"))
    _write_jsonl(a, [_metadata()])
    _write_jsonl(b, [_metadata()])
    assert sorted(MuseLogReader().session_files()) == sorted([a, b])


def test_missing_root_yields_no_dirs_and_no_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "nothing"))
    reader = MuseLogReader()
    assert reader.project_dirs() == []
    assert reader.session_files() == []


def test_watch_dirs_falls_back_to_the_data_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Day directories appear after the backend booted, and on a machine that
    never ran muse the sessions tree does not exist yet — so the watcher
    subscribes the deepest stable ancestor that does."""
    share = tmp_path / "share"
    monkeypatch.setenv("XDG_DATA_HOME", str(share))
    (share / "muse").mkdir(parents=True)
    reader = MuseLogReader()
    assert reader.watch_dirs() == [share / "muse"]

    (share / "muse" / "sessions").mkdir()
    assert reader.watch_dirs() == [share / "muse" / "sessions"]


def test_session_id_is_the_parent_directory_name(fake_muse_root: Path) -> None:
    """Every log file is named session.jsonl, so the id is the DIRECTORY's
    name — never the stem, and never an id read out of the payload."""
    reader = MuseLogReader()
    main = _session_file(fake_muse_root)
    _write_jsonl(main, [_metadata(), _intake("hi")])
    assert reader.session_id_from_path(main) == _SID

    # A subagent log and the session dir's siblings are not resumable
    # sessions — '' keeps the resume-binding sink from coining a bogus id.
    child = _subagent_file(fake_muse_root, "child-1")
    _write_jsonl(child, [_metadata()])
    assert reader.session_id_from_path(child) == ""
    assert reader.session_id_from_path(main.parent / ".session.lock") == ""
    assert reader.session_id_from_path(main.parent / "cron.db") == ""


def test_has_session_scans_the_date_directories(fake_muse_root: Path) -> None:
    _write_jsonl(_session_file(fake_muse_root, "sess-a", day=("2026", "07", "04")),
                 [_metadata()])
    reader = MuseLogReader()
    assert reader.has_session("sess-a") is True
    assert reader.has_session("sess-b") is False
    assert reader.has_session("") is False
    # The id is interpolated into a glob; a wildcard must not match a session.
    assert reader.has_session("*") is False

    exists = SPEC.session_exists
    assert exists is not None
    assert exists(_CWD, "sess-a") is True
    assert exists(_CWD, "sess-b") is False


def test_cwd_comes_from_the_metadata_record(fake_muse_root: Path) -> None:
    f = _session_file(fake_muse_root)
    _write_jsonl(f, [_metadata(cwd="/Users/me/other"), _intake("hi")])
    assert MuseLogReader().cwd_from_file(f) == "/Users/me/other"


def test_cwd_is_empty_without_a_metadata_record(fake_muse_root: Path) -> None:
    f = _session_file(fake_muse_root)
    _write_jsonl(f, [_intake("hi")])
    assert MuseLogReader().cwd_from_file(f) == ""


# ───────────────────────────────── token parsing ─────────────────────────────

def test_token_mapping_takes_totals_verbatim(fake_muse_root: Path) -> None:
    """``cached_tokens``/``reasoning_tokens`` are breakdown detail already
    inside the two totals (Meta Model API semantics), so the totals are used
    as-is."""
    f = _session_file(fake_muse_root)
    _write_jsonl(f, [
        _metadata(),
        _usage_row("u-1", 10, input_tokens=100, output_tokens=20,
                   cached=400, reasoning=7),
    ])
    events = MuseLogReader().parse_session_file(f, set())
    assert len(events) == 1
    e = events[0]
    assert (e.input_tokens, e.output_tokens) == (100, 20)
    assert e.vendor == "muse"
    assert e.cwd == _CWD
    assert e.session_id == _SID
    assert e.dedup_key == "u-1"
    # recorded_at is MICROseconds; the ISO stamp must be that instant, not now.
    assert e.timestamp.startswith("2026-08-11T")


def test_cached_and_reasoning_are_subsets_not_extras(
        fake_muse_root: Path) -> None:
    """A realistic subset row: 80 of the 100 input tokens were a cache hit and
    15 of the 40 output tokens were reasoning. Adding either back would report
    180/55 for a request that Meta bills as 100/40."""
    f = _session_file(fake_muse_root)
    _write_jsonl(f, [
        _metadata(),
        _usage_row("u-1", 10, input_tokens=100, output_tokens=40,
                   cached=80, reasoning=15),
    ])
    events = MuseLogReader().parse_session_file(f, set())
    assert [(e.input_tokens, e.output_tokens) for e in events] == [(100, 40)]


def test_subagent_usage_rows_are_not_counted(fake_muse_root: Path) -> None:
    """A subagent's usage is attributed into the parent log with a non-"main"
    requester_kind; counting it as well double-counts the same tokens."""
    f = _session_file(fake_muse_root)
    _write_jsonl(f, [
        _metadata(),
        _usage_row("u-main", 10, input_tokens=100, output_tokens=20),
        _usage_row("u-sub", 11, input_tokens=900, output_tokens=900,
                   requester_kind="subagent"),
    ])
    events = MuseLogReader().parse_session_file(f, set())
    assert [(e.dedup_key, e.input_tokens) for e in events] == [("u-main", 100)]


def test_usage_ids_are_deduped(fake_muse_root: Path) -> None:
    f = _session_file(fake_muse_root)
    _write_jsonl(f, [_metadata(), _usage_row("u-1", 10), _usage_row("u-1", 11)])
    seen: set[str] = set()
    assert len(MuseLogReader().parse_session_file(f, seen)) == 1
    # A rescan of the same file adds nothing.
    assert MuseLogReader().parse_session_file(f, seen) == []


def test_all_zero_usage_rows_are_dropped(fake_muse_root: Path) -> None:
    """The `--provider echo` shape: a real row with nothing to add."""
    f = _session_file(fake_muse_root)
    _write_jsonl(f, [
        _metadata(),
        _usage_row("u-zero", 10, input_tokens=0, output_tokens=0),
        _usage_row("u-real", 11, input_tokens=5, output_tokens=0),
    ])
    events = MuseLogReader().parse_session_file(f, set())
    assert [e.dedup_key for e in events] == ["u-real"]


def test_model_completed_is_not_counted(fake_muse_root: Path) -> None:
    """model_completed repeats the same figures per model call; counting both
    sources would double every turn."""
    f = _session_file(fake_muse_root)
    _write_jsonl(f, [
        _metadata(),
        _run({"kind": "model_completed",
              "usage": {"input_tokens": 700, "output_tokens": 70,
                        "cached_tokens": 0, "reasoning_tokens": 0},
              "duration_ms": 3}, 10),
        _usage_row("u-1", 11, input_tokens=700, output_tokens=70),
    ])
    events = MuseLogReader().parse_session_file(f, set())
    assert [(e.input_tokens, e.output_tokens) for e in events] == [(700, 70)]


def test_malformed_and_alien_lines_do_not_stop_the_parse(
    fake_muse_root: Path,
) -> None:
    f = _session_file(fake_muse_root)
    _write_jsonl(f, [_metadata(), _usage_row("u-1", 10)])
    with f.open("a", encoding="utf-8") as fh:
        fh.write("{not json\n")
        fh.write("[1, 2, 3]\n")           # valid JSON, wrong shape
        fh.write("\n")
    _append_jsonl(f, [_usage_row("u-2", 14)])

    events = MuseLogReader().parse_session_file(f, set())
    assert [e.dedup_key for e in events] == ["u-1", "u-2"]


def test_parse_incremental_reads_only_the_tail(fake_muse_root: Path) -> None:
    f = _session_file(fake_muse_root)
    _write_jsonl(f, [_metadata(), _usage_row("u-1", 10)])
    reader = MuseLogReader()

    first = reader.parse_incremental(f, {})
    assert [e.dedup_key for e in first.events] == ["u-1"]
    assert first.checkpoint["offset"] == f.stat().st_size

    # No growth -> nothing re-read.
    assert reader.parse_incremental(f, first.checkpoint).events == []

    _append_jsonl(f, [_usage_row("u-2", 11, input_tokens=9, output_tokens=1)])
    second = reader.parse_incremental(f, first.checkpoint)
    assert [e.dedup_key for e in second.events] == ["u-2"]
    # The cwd lives in the file's FIRST record, which the tail read skipped —
    # it still has to be attached or attribution can't place the event.
    assert second.events[0].cwd == _CWD
    assert second.events[0].session_id == _SID
    assert second.events[0].checkpoint["offset"] == f.stat().st_size


def test_parse_incremental_leaves_a_partial_line_unread(
    fake_muse_root: Path,
) -> None:
    f = _session_file(fake_muse_root)
    _write_jsonl(f, [_metadata()])
    with f.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(_usage_row("u-1", 10))[:40])  # no trailing newline
    reader = MuseLogReader()
    first = reader.parse_incremental(f, {})
    assert first.events == []

    # Completing the record makes it readable exactly once.
    rest = json.dumps(_usage_row("u-1", 10))[40:]
    with f.open("a", encoding="utf-8") as fh:
        fh.write(rest + "\n")
    second = reader.parse_incremental(f, first.checkpoint)
    assert [e.dedup_key for e in second.events] == ["u-1"]


# ──────────────────────────────── activity ───────────────────────────────────

def test_terminal_record_closes_the_turn_with_the_assistant_text(
    fake_muse_root: Path,
) -> None:
    """Muse writes an EXPLICIT end-of-turn record, so turn_complete is emitted
    from it alone — never inferred from silence."""
    f = _session_file(fake_muse_root)
    _write_jsonl(f, [
        _metadata(),
        _intake("hello from probe"),
        _diagnostic(20),
        _assistant("echo: hello from probe", 32),
        _terminal(41),
    ])
    events = MuseLogReader().parse_activity(f, set())

    prompts = [e for e in events if e.detail == "user"]
    assert len(prompts) == 1
    assert prompts[0].event_type == "agent_active"
    assert prompts[0].text == "hello from probe"
    assert prompts[0].cwd == _CWD
    assert prompts[0].session_id == _SID

    # The diagnostic record says nothing about progress and is not activity.
    assert "context_block_diagnostic" not in {e.detail for e in events}

    turns = [e for e in events if e.event_type == "turn_complete"]
    assert len(turns) == 1
    assert turns[0].detail == "completed"
    assert turns[0].text == "echo: hello from probe"
    # The record's own time, not now() — the frontend dedups messaging turns
    # by timestamp and would replay history after a restart otherwise.
    assert turns[0].timestamp.startswith("2026-08-11T")


def test_turn_complete_survives_a_split_read(fake_muse_root: Path) -> None:
    """The assistant text and the terminal record are different LINES; line
    dedup means a later call never re-reads the text, so it has to be carried
    between calls."""
    reader = MuseLogReader()
    seen: set[str] = set()
    f = _session_file(fake_muse_root)
    _write_jsonl(f, [_metadata(), _intake("hi"), _assistant("the answer", 32)])
    first = reader.parse_activity(f, seen)
    assert [e.event_type for e in first] == ["agent_active", "agent_active"]

    _append_jsonl(f, [_terminal(41)])
    second = reader.parse_activity(f, seen)
    turns = [e for e in second if e.event_type == "turn_complete"]
    assert len(turns) == 1
    assert turns[0].text == "the answer"

    # A second turn that produced no text must not reuse the first one's.
    _append_jsonl(f, [_intake("again", seq=50), _terminal(60)])
    third = reader.parse_activity(f, seen)
    turns = [e for e in third if e.event_type == "turn_complete"]
    assert len(turns) == 1
    assert turns[0].text == ""


def test_activity_events_are_emitted_once(fake_muse_root: Path) -> None:
    reader = MuseLogReader()
    seen: set[str] = set()
    f = _session_file(fake_muse_root)
    _write_jsonl(f, [_metadata(), _intake("hi"), _assistant("hey", 32),
                     _terminal(41)])
    assert len(reader.parse_activity(f, seen)) == 3
    assert reader.parse_activity(f, seen) == []


def test_a_failed_terminal_still_ends_the_turn(fake_muse_root: Path) -> None:
    f = _session_file(fake_muse_root)
    _write_jsonl(f, [_metadata(), _intake("hi"), _terminal(41, "failed")])
    turns = [e for e in MuseLogReader().parse_activity(f, set())
             if e.event_type == "turn_complete"]
    assert [t.detail for t in turns] == ["failed"]


def test_non_turn_intake_records_are_not_user_prompts(
    fake_muse_root: Path,
) -> None:
    f = _session_file(fake_muse_root)
    cancel = _envelope(4, "runtime.command_intake.received", {
        "kind": "command_intake",
        "record": {"kind": "received", "command_id": _CMD,
                   "command": {"kind": "cancel"}},
    })
    _write_jsonl(f, [_metadata(), cancel])
    assert MuseLogReader().parse_activity(f, set()) == []


# ── activity: the seen_keys bag stays O(1) ───────────────────────────────────
# seen_keys lives as long as session.jsonl, so a walk must leave one
# high-water mark in it, not a key per line (GitHub #23).

def _long_session(f: Path, turns: int) -> int:
    """Write `turns` intake/assistant/terminal cycles; return the line count."""
    records: list[dict] = [_metadata()]
    for i in range(turns):
        base = 10 * (i + 1)
        records.append(_intake(f"ask {i}", seq=base))
        records.append(_assistant(f"reply {i}", base + 1))
        records.append(_terminal(base + 2))
    _write_jsonl(f, records)
    return len(records)


def test_activity_seen_keys_stay_constant_size(fake_muse_root: Path) -> None:
    reader = MuseLogReader()
    f = _session_file(fake_muse_root)
    lines = _long_session(f, 200)
    seen: set[str] = set()

    reader.parse_activity(f, seen)

    assert [k for k in seen if k.startswith("act:")] == []
    assert len([k for k in seen if k.startswith("act_hw::")]) == 1
    assert activity_high_water(seen) == lines


def test_activity_long_session_reparse_does_not_reemit(
    fake_muse_root: Path,
) -> None:
    reader = MuseLogReader()
    f = _session_file(fake_muse_root)
    _long_session(f, 200)
    seen: set[str] = set()

    assert reader.parse_activity(f, seen) != []
    assert reader.parse_activity(f, seen) == []


def test_activity_appended_line_keeps_its_dedup_keys(fake_muse_root: Path) -> None:
    reader = MuseLogReader()
    f = _session_file(fake_muse_root)
    lines = _long_session(f, 3)
    seen: set[str] = set()
    reader.parse_activity(f, seen)

    _append_jsonl(f, [_intake("one more", seq=900)])
    fresh = reader.parse_activity(f, seen)

    assert [(e.event_type, e.detail) for e in fresh] == [("agent_active", "user")]
    assert fresh[0].dedup_key == f"act:{lines + 1}"
    assert fresh[0].text == "one more"
    assert activity_high_water(seen) == lines + 1


def test_activity_text_sentinel_coexists_with_the_mark(
    fake_muse_root: Path,
) -> None:
    """The carried assistant text shares the bag with the mark; the split-read
    delivery above depends on neither evicting the other."""
    reader = MuseLogReader()
    seen: set[str] = set()
    f = _session_file(fake_muse_root)
    _write_jsonl(f, [_metadata(), _intake("hi"), _assistant("the answer", 32)])
    reader.parse_activity(f, seen)

    assert len([k for k in seen if k.startswith("act_hw::")]) == 1
    assert [k for k in seen if k.startswith("muse_text::")] == [
        "muse_text::the answer"
    ]

    _append_jsonl(f, [_terminal(41)])
    turns = [
        e for e in reader.parse_activity(f, seen) if e.event_type == "turn_complete"
    ]
    assert [e.text for e in turns] == ["the answer"]


# ───────────────────────────── attribution binding ───────────────────────────

def _probe(session_id: str, file_path: Path, cwd: str = "/ws") -> TokenUsage:
    """Shape of the session-sink probe usage (_on_session_file)."""
    return TokenUsage(
        vendor="muse", input_tokens=0, output_tokens=0, cwd=cwd,
        session_id=session_id, file_path=str(file_path), dedup_key="",
    )


@pytest.fixture
def muse_attr(fake_muse_root: Path, tmp_path: Path) -> tuple[Attribution, Path]:
    attr = Attribution([MuseLogReader()], workspaces_path=tmp_path / "ws.json")
    return attr, fake_muse_root


def test_marker_in_the_prompt_binds_the_pane(
    muse_attr: tuple[Attribution, Path],
) -> None:
    """Muse records the submitted prompt verbatim, so the kickoff's `at-pane:`
    marker lands in the intake record; the resume id it binds is the session
    DIRECTORY's name, which is what `muse resume` accepts."""
    attr, root = muse_attr
    attr.register_pane("p1", vendor="muse", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    attr.register_pane("p2", vendor="muse", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p2")
    f = _session_file(root, "sess-two")
    _write_jsonl(f, [_metadata(cwd="/ws"),
                     _intake("at-pane:p2 say ok")])

    binding = attr.maybe_announce_session(_probe("sess-two", f))
    assert binding is not None
    assert binding.pane_id == "p2"
    assert binding.resume_id == "sess-two"
    assert binding.workspace_path == "/ws"


def test_single_candidate_fallback_binds_a_markerless_session(
    muse_attr: tuple[Attribution, Path],
) -> None:
    """A resumed session opens a fresh directory and carries no kickoff
    marker; a lone pane in that cwd still captures it."""
    attr, root = muse_attr
    attr.register_pane("p1", vendor="muse", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    f = _session_file(root, "sess-new")
    _write_jsonl(f, [_metadata(cwd="/ws"), _intake("no marker here")])

    binding = attr.maybe_announce_session(_probe("sess-new", f))
    assert binding is not None
    assert binding.pane_id == "p1"
    assert binding.resume_id == "sess-new"
    # Announce-once: a later watcher event for the same session is silent.
    assert attr.maybe_announce_session(_probe("sess-new", f)) is None


def test_usage_is_attributed_by_the_sessions_own_cwd() -> None:
    reader = MuseLogReader()
    usage = TokenUsage(vendor="muse", input_tokens=1, output_tokens=1,
                       cwd="/ws", session_id=_SID, file_path="/x", dedup_key="k")
    assert reader.workspace_match(usage, "/ws") is True
    assert reader.workspace_match(usage, "/other") is False
    assert reader.pane_cwd_match(usage, "/ws", "p1") is True
    assert reader.pane_cwd_match(usage, "/other", "p1") is False


def test_cwd_matching_sees_through_symlinked_roots(tmp_path: Path) -> None:
    """workspace_root is the RESOLVED launch dir (measured: /private/tmp/… on
    macOS) while a pane can carry the symlink form, so a plain string compare
    would silently drop every event of a session under a symlinked root."""
    real = tmp_path / "real-ws"
    real.mkdir()
    link = tmp_path / "link-ws"
    link.symlink_to(real)

    reader = MuseLogReader()
    usage = TokenUsage(vendor="muse", input_tokens=1, output_tokens=1,
                       cwd=str(real), session_id=_SID, file_path="/x",
                       dedup_key="k")
    assert reader.workspace_match(usage, str(link)) is True
    assert reader.pane_cwd_match(usage, str(link), "p1") is True
    assert reader.workspace_match(usage, str(tmp_path / "elsewhere")) is False


def test_reader_declares_its_attribution_hooks() -> None:
    reader = MuseLogReader()
    assert reader.vendor == "muse"
    assert reader.binds_by_marker_file is True
    assert reader.emits_session_sink is True
    assert reader.binds_new_session_single_candidate is True
    # The directory name is already the resume id, so nothing has to wait for
    # a real id to appear inside the file.
    assert reader.requires_real_resume_id is False


def test_parse_activity_resumes_after_an_append(fake_muse_root: Path, monkeypatch) -> None:
    from tests.activity_resume_support import assert_resumes

    path = _session_file(fake_muse_root)
    _write_jsonl(path, [_metadata(), _intake("first", seq=4), _assistant("one", seq=5), _terminal(6)])
    assert_resumes(MuseLogReader, path, [
        _intake("second", seq=7), _assistant("two", seq=8), _terminal(9),
    ], monkeypatch)
