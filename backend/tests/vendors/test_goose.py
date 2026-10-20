"""Goose reader, resume and install detection.

The tables come from the schema recorded off goose 1.55.0 in a scratch home
(tests/fixtures/cli-regression/goose.json); rows below copy the recorded
shapes with fixture text and counts.
"""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

import pytest

from agent_team_backend.cli_vendors import goose
from agent_team_backend.cli_vendors.goose import GooseLogReader, _data_dir

REPO = Path(__file__).resolve().parents[3]
SCHEMA = json.loads(
    (REPO / "tests" / "fixtures" / "cli-regression" / "goose.json").read_text(encoding="utf-8")
)["phases"]["initial"][0]["schema"]
CWD = "/work/project"


@pytest.fixture
def db(tmp_path, monkeypatch):
    root = tmp_path / "root"
    monkeypatch.setenv("GOOSE_PATH_ROOT", str(root))
    path = root / "data" / "sessions" / "sessions.db"
    path.parent.mkdir(parents=True)
    con = sqlite3.connect(path)
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(SCHEMA)
    yield path, con
    con.close()


def _session(con, sid, *, parent=None, kind="user", cwd=CWD):
    con.execute(
        "INSERT INTO sessions (id, name, session_type, working_dir, parent_session_id) VALUES (?, '', ?, ?, ?)",
        (sid, kind, cwd, parent),
    )
    con.commit()


def _message(con, sid, role, content, meta=None, ts=1792513596):
    con.execute(
        "INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp, metadata_json)"
        " VALUES ('m', ?, ?, ?, ?, ?)",
        (sid, role, json.dumps(content), ts, json.dumps(meta or {"userVisible": True, "agentVisible": True})),
    )
    con.commit()


def _usage(con, sid, inp, out, cache_read=None, cache_write=None):
    con.execute(
        "INSERT INTO usage_ledger (session_id, created_timestamp, model, input_tokens, output_tokens,"
        " cache_read_tokens, cache_write_tokens) VALUES (?, 1792513603, 'm1', ?, ?, ?, ?)",
        (sid, inp, out, cache_read, cache_write),
    )
    con.commit()


def _text(text):
    return [{"type": "text", "text": text}]


def _tool(name):
    return [{"type": "toolRequest", "id": "c", "toolCall": {"status": "success", "value": {"name": name, "arguments": {}}}}]


# ── data dir ──────────────────────────────────────────────────────────────


def test_data_dir_follows_the_cli_rule(tmp_path, monkeypatch):
    home = tmp_path / "h"
    monkeypatch.setattr(goose.sys, "platform", "darwin")
    assert _data_dir({}, home) == home / ".local" / "share" / "goose"
    assert _data_dir({"XDG_DATA_HOME": str(tmp_path / "x")}, home) == tmp_path / "x" / "goose"
    assert _data_dir({"GOOSE_PATH_ROOT": str(tmp_path / "r"), "XDG_DATA_HOME": str(tmp_path / "x")}, home) == tmp_path / "r" / "data"
    # The CLI ignores a relative root (paths.rs validated_path_root).
    assert _data_dir({"GOOSE_PATH_ROOT": "relative/root"}, home) == home / ".local" / "share" / "goose"
    monkeypatch.setattr(goose.sys, "platform", "win32")
    assert _data_dir({"APPDATA": str(tmp_path / "ad")}, home) == tmp_path / "ad" / "Block" / "goose" / "data"


# ── resume ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(("command", "expected"), [
    ("goose session -r --session-id 20261020_1", "20261020_1"),
    ("goose session --resume --session-id 20261020_12", "20261020_12"),
    ("goose s -r --session-id=20261020_3", "20261020_3"),
    ("goose", ""),
    ("goose session -r -n at-pane-x", ""),
    ("goose run --session-id 20261020_1", ""),
])
def test_resume_id_from_command(command, expected):
    assert goose.SPEC.resume_id_from_command(command) == expected


def test_session_exists_asks_the_db(db):
    path, con = db
    _session(con, "20261020_1")
    assert goose.SPEC.session_exists(CWD, "20261020_1")
    assert not goose.SPEC.session_exists(CWD, "20991231_9")
    assert not goose.SPEC.session_exists(CWD, " ")


# ── marker binding ────────────────────────────────────────────────────────


def test_marker_binds_only_a_top_level_interactive_session(db):
    path, con = db
    _session(con, "20261020_1")
    _session(con, "20261020_2", parent="20261020_1")
    _message(con, "20261020_2", "user", _text("at-pane:p1 forwarded to a sub-agent"))
    _message(con, "20261020_1", "user", _text("<turn-context>at-pane:p2</turn-context>"),
             {"userVisible": False, "agentVisible": True, "turnContext": True})
    _message(con, "20261020_1", "user", _text("at-pane:p1 hello"))
    found = GooseLogReader().find_sessions_by_marker(["at-pane:p1", "at-pane:p2"])
    assert found == {"at-pane:p1": ("20261020_1", CWD)}


# ── activity ──────────────────────────────────────────────────────────────


def _activity(reader, path, seen):
    return [(e.event_type, e.detail, e.text) for e in reader.parse_activity(path, seen)]


def test_first_sight_is_history_then_one_turn(db):
    path, con = db
    reader = GooseLogReader()
    seen: set[str] = set()
    _session(con, "20261020_1")
    _message(con, "20261020_1", "assistant", _text("old reply"))
    assert _activity(reader, path, seen) == []

    _message(con, "20261020_1", "user", _text("say hello"))
    _message(con, "20261020_1", "user", _text("<turn-context/>"),
             {"userVisible": False, "agentVisible": True, "turnContext": True})
    # Text and the tool call of one response are one row (verified live).
    _message(con, "20261020_1", "assistant", _text("Checking.") + _tool("shell"))
    _message(con, "20261020_1", "assistant",
             [{"type": "actionRequired", "data": {"actionType": "toolConfirmation"}}],
             {"userVisible": True, "agentVisible": False})
    _message(con, "20261020_1", "user",
             [{"type": "actionRequired", "data": {"actionType": "toolConfirmationResponse"}}],
             {"userVisible": False, "agentVisible": False})
    _message(con, "20261020_1", "user", [{"type": "toolResponse", "id": "c", "toolResult": {}}])
    _message(con, "20261020_1", "assistant", _text("Done."))
    assert _activity(reader, path, seen) == [
        ("agent_active", "user", "say hello"),
        ("agent_active", "user:context", ""),
        ("agent_active", "tool:shell", ""),
        ("agent_active", "assistant:action-required", ""),
        ("agent_active", "user:action-response", ""),
        ("agent_active", "tool:result", ""),
        ("turn_complete", "assistant", "Done."),
    ]
    assert _activity(reader, path, seen) == []


def test_sub_agent_reply_is_not_the_panes_turn_end(db):
    path, con = db
    reader = GooseLogReader()
    seen: set[str] = set()
    _session(con, "20261020_1")
    _session(con, "20261020_2", parent="20261020_1", kind="sub_agent")
    assert _activity(reader, path, seen) == []
    _message(con, "20261020_2", "assistant", _text("child done"))
    assert _activity(reader, path, seen) == [("agent_active", "subagent:done", "")]


def test_interrupted_turn_writes_no_turn_end(db):
    """Ctrl+C mid-response leaves only the prompt rows (verified live)."""
    path, con = db
    reader = GooseLogReader()
    seen: set[str] = set()
    _session(con, "20261020_1")
    assert _activity(reader, path, seen) == []
    _message(con, "20261020_1", "user", _text("slow one"))
    events = _activity(reader, path, seen)
    assert [e[0] for e in events] == ["agent_active"]


# ── tokens ────────────────────────────────────────────────────────────────


def test_usage_ledger_rows_are_counted_once(db):
    path, con = db
    reader = GooseLogReader()
    _session(con, "20261020_1")
    _usage(con, "20261020_1", 120, 12, cache_read=100, cache_write=5)
    _usage(con, "20261020_1", 0, 0)
    first = reader.parse_incremental(path, {})
    assert [(u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens, u.model, u.cwd)
            for u in first.events] == [(120, 12, 100, 5, "m1", CWD)]
    assert reader.parse_incremental(path, first.checkpoint).events == []
    _usage(con, "20261020_1", 7, 2)
    assert [(u.input_tokens, u.output_tokens) for u in reader.parse_incremental(path, first.checkpoint).events] == [(7, 2)]
    assert reader.total_usage_for_session(path, "20261020_1") == {"input": 127, "output": 14, "calls": 2}


def test_only_the_db_is_a_session_source(db):
    path, _ = db
    reader = GooseLogReader()
    assert reader.session_files() == [path]
    assert reader.session_id_from_path(path) == "sessions"
    assert reader.session_id_from_path(path.with_name("sessions.db-wal")) == ""
    assert reader.parse_session_file(path.with_name("other.db"), set()) == []


# ── install detection ─────────────────────────────────────────────────────


def test_identity_tells_goose_from_the_migration_tool():
    dep = goose.SPEC.install_dep
    assert re.search(dep.identity_regex, " 1.55.0\n")
    assert not re.search(dep.identity_regex, "goose version: v3.24.1\n")
    assert re.search(dep.version_regex, " 1.55.0\n").group(1) == "1.55.0"
