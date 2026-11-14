"""hermes (Hermes Agent) vendor spec and its state.db reader.

Hermes is a general agent: its providers and keys live in its own home
(~/.hermes, $HERMES_HOME), which Navide never reads. What Navide does read is
the conversation store, state.db, opened read-only. The stores below are built
at test time in the columns measured on Hermes Agent v0.23.0 (plan
openclaw-hermes-0-2-40_a50148); no real data or keys.
"""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

import pytest

from agent_team_backend.cli_vendors import hermes, registry
from agent_team_backend.cli_vendors.base import VendorRuntimeContext

SPEC = registry.VENDORS["hermes"]
NAME = "navide-11111111-2222-4333-8444-555555555555"

_SCHEMA = (
    "CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT, "
    "parent_session_id TEXT, cwd TEXT, started_at REAL NOT NULL, input_tokens INTEGER DEFAULT 0, "
    "output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0, "
    "cache_write_tokens INTEGER DEFAULT 0, last_activity_at REAL);"
    "CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, "
    "role TEXT NOT NULL, content TEXT, tool_calls TEXT, timestamp REAL NOT NULL, finish_reason TEXT);"
)


@pytest.fixture
def store(tmp_path, monkeypatch):
    home = tmp_path / "hermes-home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    db = home / "state.db"
    con = sqlite3.connect(db)
    con.executescript(_SCHEMA)
    con.commit()
    yield db, con
    con.close()


def _session(con, sid, title, cwd="/work", parent=None):
    con.execute(
        "INSERT INTO sessions(id, source, title, parent_session_id, cwd, started_at, last_activity_at) "
        "VALUES (?, 'cli', ?, ?, ?, 1000, 1000)", (sid, title, parent, cwd),
    )
    con.commit()


def _message(con, sid, role, content="", finish=None, tool_calls=None, ts=1000.0):
    con.execute(
        "INSERT INTO messages(session_id, role, content, tool_calls, timestamp, finish_reason) "
        "VALUES (?, ?, ?, ?, ?, ?)", (sid, role, content, tool_calls, ts, finish),
    )
    con.commit()


def test_identity() -> None:
    assert SPEC.key == "hermes"
    assert SPEC.label == "Hermes Agent"


def test_install_entry_runs_no_installer_on_any_platform() -> None:
    dep = SPEC.install_dep
    assert dep is not None
    assert dep.check_cmd == ["hermes", "--version"]
    assert dep.install_cmd == ""
    assert dep.install_cmds == {}
    assert dep.platforms == ()  # Windows included
    assert dep.update_cmd == "hermes update"
    assert dep.doctor_cmd == "hermes doctor"


def test_navide_holds_no_key() -> None:
    assert SPEC.live_file is None
    assert SPEC.account_switch is None
    assert SPEC.fetch_usage is None
    assert SPEC.login_command_args is None


def test_resume_model_effort_and_reader_are_declared() -> None:
    assert SPEC.supports_session_resume is True
    assert SPEC.make_log_reader is hermes.HermesLogReader
    # v0.23.1 refuses -m / --reasoning on the --continue launch every pane uses.
    assert SPEC.supports_model is False
    assert SPEC.supports_effort is False
    assert SPEC.known_efforts == ()


def test_windows_home_is_local_appdata(tmp_path: Path) -> None:
    home = tmp_path / "home"
    local = tmp_path / "local"
    ctx = VendorRuntimeContext(home=home, env={"LOCALAPPDATA": str(local)}, cwd=tmp_path)
    assert hermes._home(ctx, platform="win32") == local / "hermes"
    bare = VendorRuntimeContext(home=home, env={}, cwd=tmp_path)
    assert hermes._home(bare, platform="win32") == home / "AppData" / "Local" / "hermes"
    assert hermes._home(bare, platform="darwin") == home / ".hermes"


@pytest.mark.parametrize(("command", "expected"), [
    (f"hermes chat --continue {NAME}", NAME),
    (f"hermes chat --yolo -c {NAME}", NAME),
    (f"hermes chat --create-if-missing --continue={NAME}", NAME),
    ("hermes chat --continue 'my project'", ""),  # not a Navide name
    ("hermes chat", ""),
    (f"aider --continue {NAME}", ""),
])
def test_resume_id_from_command(command, expected) -> None:
    assert SPEC.resume_id_from_command(command) == expected


def test_session_name_strips_lineage_suffix() -> None:
    assert hermes.session_name(f"{NAME} #3") == NAME
    assert hermes.session_name(NAME) == NAME
    assert hermes.session_name("STUB-REPLY-OK") == ""
    assert hermes.session_name(None) == ""


def test_turn_events_and_first_sight_anchor(store) -> None:
    db, con = store
    _session(con, "local-1", NAME)
    _message(con, "local-1", "user", "old prompt")
    reader = hermes.HermesLogReader()
    seen: set[str] = set()
    assert reader.parse_activity(db, seen) == []  # history, not activity

    _message(con, "local-1", "user", "do the thing", ts=1001)
    _message(con, "local-1", "assistant", "", finish="tool_calls", tool_calls='[{"id": "1"}]', ts=1002)
    _message(con, "local-1", "tool", "result", ts=1003)
    _message(con, "local-1", "assistant", "done", finish="stop", ts=1004)
    events = reader.parse_activity(db, seen)
    assert [(e.event_type, e.detail) for e in events] == [
        ("agent_active", "user"), ("agent_active", "assistant"),
        ("agent_active", "tool"), ("turn_complete", "stop"),
    ]
    assert {e.session_id for e in events} == {NAME}
    assert events[0].text == "do the thing"
    assert events[-1].text == "done"
    assert events[-1].cwd == "/work"
    assert events[-1].timestamp.startswith("1970-01-01T00:16:44")
    assert reader.parse_activity(db, seen) == []


def test_unfinished_newest_assistant_row_is_read_again(store) -> None:
    db, con = store
    _session(con, "local-1", NAME)
    reader = hermes.HermesLogReader()
    seen: set[str] = set()
    reader.parse_activity(db, seen)
    _message(con, "local-1", "assistant", "partial")
    assert reader.parse_activity(db, seen) == []
    con.execute("UPDATE messages SET content = 'whole', finish_reason = 'stop'")
    con.commit()
    events = reader.parse_activity(db, seen)
    assert [(e.event_type, e.text) for e in events] == [("turn_complete", "whole")]


def test_continued_session_reports_its_lineage_name(store) -> None:
    db, con = store
    _session(con, "local-1", NAME)
    _session(con, "local-2", "compressed child", parent="local-1")
    _session(con, "local-3", f"{NAME} #2")
    reader = hermes.HermesLogReader()
    seen: set[str] = set()
    reader.parse_activity(db, seen)
    _message(con, "local-2", "assistant", "a", finish="stop")
    _message(con, "local-3", "assistant", "b", finish="stop")
    assert [e.session_id for e in reader.parse_activity(db, seen)] == [NAME, NAME]


def test_session_not_started_by_navide_keeps_its_own_id(store) -> None:
    db, con = store
    _session(con, "local-9", "something else")
    reader = hermes.HermesLogReader()
    seen: set[str] = set()
    reader.parse_activity(db, seen)
    _message(con, "local-9", "assistant", "x", finish="stop")
    assert [e.session_id for e in reader.parse_activity(db, seen)] == ["local-9"]


def test_unknown_schema_is_no_signal_and_logged_once(tmp_path, monkeypatch, caplog) -> None:
    home = tmp_path / "hermes-home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    db = home / "state.db"
    con = sqlite3.connect(db)
    con.executescript("CREATE TABLE sessions(id TEXT); CREATE TABLE messages(id INTEGER);")
    con.close()
    reader = hermes.HermesLogReader()
    with caplog.at_level(logging.WARNING, logger="agent_team_backend.log_readers.hermes"):
        assert reader.parse_activity(db, set()) == []
        assert reader.parse_incremental(db, {}).events == []
    assert len([r for r in caplog.records if "lacks" in r.getMessage()]) == 1
    # Unknown store, not an absent session: resume is not refused.
    assert hermes._session_exists("/work", NAME) is True


def test_tokens_are_counter_growth_only(store) -> None:
    db, con = store
    _session(con, "local-1", NAME)
    reader = hermes.HermesLogReader()
    first = reader.parse_incremental(db, {})
    assert first.events == []  # all counters zero: nothing to count
    con.execute(
        "UPDATE sessions SET input_tokens = 100, output_tokens = 20, cache_read_tokens = 30, "
        "cache_write_tokens = 5, last_activity_at = 1010"
    )
    con.commit()
    second = reader.parse_incremental(db, first.checkpoint)
    [usage] = second.events
    assert (usage.input_tokens, usage.output_tokens) == (135, 20)
    assert (usage.cache_read_tokens, usage.cache_creation_tokens) == (30, 5)
    assert usage.session_id == NAME
    assert reader.parse_incremental(db, second.checkpoint).events == []
    con.execute("UPDATE sessions SET output_tokens = 25")
    con.commit()
    [more] = reader.parse_incremental(db, second.checkpoint).events
    assert (more.input_tokens, more.output_tokens) == (0, 5)
    assert reader.total_usage_for_session(db, NAME) == {"input": 135, "output": 25, "calls": 1}


def test_session_exists_by_name_and_lineage(store) -> None:
    _db, con = store
    _session(con, "local-1", f"{NAME} #2")
    assert hermes._session_exists("/work", NAME) is True
    assert hermes._session_exists("/work", "navide-missing") is False


def test_marker_binds_to_the_session_name(store) -> None:
    db, con = store
    _session(con, "local-1", NAME, cwd="/ws")
    _message(con, "local-1", "user", "at-pane:abc go")
    found = hermes.HermesLogReader().find_sessions_by_marker(["at-pane:abc", "at-pane:zzz"])
    assert found == {"at-pane:abc": (NAME, "/ws")}


def test_only_state_db_is_a_session_source(store) -> None:
    db, _con = store
    reader = hermes.HermesLogReader()
    assert reader.session_files() == [db]
    assert reader.session_id_from_path(db) == "state"
    assert reader.session_id_from_path(db.parent / "config.yaml") == ""
    assert reader.parse_activity(db.parent / "other.db", set()) == []
