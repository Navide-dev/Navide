"""openclaw (OpenClaw) vendor spec and its transcript reader.

OpenClaw is a general agent: it owns its runtime (the optional Gateway) and its
model keys, which Navide never reads. What Navide does read is
openclaw-agent.sqlite's transcript_events, read-only, through four columns
(session_id, seq, event_json, message_role). The table's full DDL was not
captured in the 2026-11-10 measurement (plan openclaw-hermes-0-2-40_a50148),
so the stores below are built at test time with only those columns; no real
data or keys.
"""

from __future__ import annotations

import json
import logging
import sqlite3

import pytest

from agent_team_backend.cli_vendors import openclaw, registry

SPEC = registry.VENDORS["openclaw"]
KEY = "agent:main:navide-11111111-2222-4333-8444-555555555555"
_SCHEMA = ("CREATE TABLE transcript_events(session_id TEXT NOT NULL, seq INTEGER NOT NULL, "
           "event_json TEXT, event_zstd BLOB, message_role TEXT, PRIMARY KEY(session_id, seq)) WITHOUT ROWID;")


@pytest.fixture
def store(tmp_path, monkeypatch):
    state = tmp_path / "state"
    monkeypatch.setenv("OPENCLAW_STATE_DIR", str(state))
    db = state / "agents" / "main" / "agent" / "openclaw-agent.sqlite"
    db.parent.mkdir(parents=True)
    con = sqlite3.connect(db)
    con.executescript(_SCHEMA)
    con.commit()
    yield db, con
    con.close()


def _row(con, sid, seq, event=None, role=None, compressed=False):
    con.execute(
        "INSERT INTO transcript_events(session_id, seq, event_json, event_zstd, message_role) VALUES (?, ?, ?, ?, ?)",
        (sid, seq, None if compressed else json.dumps(event), b"\x28\xb5" if compressed else None, role),
    )
    con.commit()


def _msg(role, content, **extra):
    return {"type": "message", "timestamp": "2026-11-10T05:00:00.000Z",
            "message": {"role": role, "content": content, **extra}}


def test_identity() -> None:
    assert SPEC.key == "openclaw"
    assert SPEC.label == "OpenClaw"


def test_install_entry_runs_no_installer() -> None:
    """The official installer is `curl | bash`; Navide only links the docs."""
    dep = SPEC.install_dep
    assert dep is not None
    assert dep.group == "agent_cli"
    assert dep.check_cmd == ["openclaw", "--version"]
    assert dep.install_cmd == ""
    assert dep.install_cmds == {}
    assert dep.docs_url == "https://docs.openclaw.ai/install"


def test_navide_holds_no_key_and_starts_no_service() -> None:
    assert SPEC.live_file is None
    assert SPEC.account_switch is None
    assert SPEC.fetch_usage is None
    assert SPEC.login_command_args is None
    assert SPEC.install_hooks is None


def test_resume_and_reader_but_no_model_flag() -> None:
    assert SPEC.supports_session_resume is True
    assert SPEC.make_log_reader is openclaw.OpenclawLogReader
    assert SPEC.supports_model is False
    assert SPEC.supports_effort is False


@pytest.mark.parametrize(("command", "expected"), [
    (f"openclaw tui --local --session {KEY}", KEY),
    (f"openclaw tui --local --session={KEY}", KEY),
    ("openclaw tui --local --session main", ""),  # not a full key
    ("openclaw tui --local", ""),
    (f"hermes chat --session {KEY}", ""),
])
def test_resume_id_from_command(command, expected) -> None:
    assert SPEC.resume_id_from_command(command) == expected


def test_turn_events_after_first_sight(store) -> None:
    db, con = store
    _row(con, KEY, 0, {"type": "session"})
    _row(con, KEY, 1, _msg("user", "old"), "user")
    reader = openclaw.OpenclawLogReader()
    seen: set[str] = set()
    assert reader.parse_activity(db, seen) == []  # history, not activity

    _row(con, KEY, 2, _msg("user", [{"type": "text", "text": "do it"}]), "user")
    _row(con, KEY, 3, {"type": "custom_message", "customType": "openclaw.runtime-context"})
    _row(con, KEY, 4, None, compressed=True)
    _row(con, KEY, 5, _msg("assistant", [{"type": "toolCall"}], stopReason="toolUse"), "assistant")
    _row(con, KEY, 6, _msg("toolResult", []), "toolResult")
    _row(con, KEY, 7, _msg("assistant", [{"type": "thinking", "thinking": "x"},
                                         {"type": "text", "text": "done"}], stopReason="stop"), "assistant")
    events = reader.parse_activity(db, seen)
    assert [(e.event_type, e.detail) for e in events] == [
        ("agent_active", "user"), ("agent_active", "assistant"),
        ("agent_active", "tool"), ("turn_complete", "stop"),
    ]
    assert {e.session_id for e in events} == {KEY}
    assert events[-1].text == "done"
    assert events[-1].timestamp == "2026-11-10T05:00:00.000Z"
    assert reader.parse_activity(db, seen) == []


def test_new_session_after_anchor_is_read_from_its_start(store) -> None:
    db, con = store
    reader = openclaw.OpenclawLogReader()
    seen: set[str] = set()
    reader.parse_activity(db, seen)
    _row(con, KEY, 0, {"type": "session"})
    _row(con, KEY, 1, _msg("assistant", "hi", stopReason="stop"), "assistant")
    assert [e.event_type for e in reader.parse_activity(db, seen)] == ["turn_complete"]


def test_assistant_row_without_stop_reason_is_read_again(store) -> None:
    db, con = store
    _row(con, KEY, 0, {"type": "session"})
    reader = openclaw.OpenclawLogReader()
    seen: set[str] = set()
    reader.parse_activity(db, seen)
    _row(con, KEY, 1, _msg("assistant", "part"), "assistant")
    assert reader.parse_activity(db, seen) == []
    con.execute("UPDATE transcript_events SET event_json = ? WHERE seq = 1",
                (json.dumps(_msg("assistant", "whole", stopReason="stop")),))
    con.commit()
    assert [e.text for e in reader.parse_activity(db, seen)] == ["whole"]


def test_uuid_session_takes_its_key_from_the_header(store) -> None:
    db, con = store
    reader = openclaw.OpenclawLogReader()
    seen: set[str] = set()
    reader.parse_activity(db, seen)
    _row(con, "cac0f2fd-1e10-4a60-927d-736d7a931e21", 0, {"type": "session", "sessionKey": KEY})
    _row(con, "cac0f2fd-1e10-4a60-927d-736d7a931e21", 1, _msg("assistant", "a", stopReason="stop"), "assistant")
    assert [e.session_id for e in reader.parse_activity(db, seen)] == [KEY]


# Session tables as OpenClaw 2026.11.2 created them on the VM (2026-11-10,
# b9-oc-probe.txt), cut to the columns the reader reads plus a few neighbours.
_SESSION_TABLES = (
    "CREATE TABLE session_windows(session_id TEXT, session_key TEXT, previous_session_id TEXT, "
    "reason TEXT, session_scope TEXT, created_at INTEGER, updated_at INTEGER);"
    "CREATE TABLE session_nodes(session_key TEXT, current_session_id TEXT, entry_json TEXT, "
    "session_started_at INTEGER, updated_at INTEGER);"
)
# The header the VM run wrote at seq 0: no key in it.
_VM_HEADER = {"type": "session", "version": 4, "id": "88d19e04-3436-49a2-a26c-a5f7ff6198c7",
              "timestamp": "2026-11-10T13:38:22.928Z", "cwd": "/home/navide/.openclaw/workspace"}


def _uuid_session(con, sid):
    _row(con, sid, 0, dict(_VM_HEADER, id=sid))
    _row(con, sid, 1, _msg("user", "hello"), "user")
    _row(con, sid, 2, _msg("assistant", "STUB-REPLY-OK", stopReason="stop"), "assistant")


def test_uuid_session_takes_its_key_from_session_windows(store) -> None:
    db, con = store
    con.executescript(_SESSION_TABLES)
    sid = "88d19e04-3436-49a2-a26c-a5f7ff6198c7"
    con.execute("INSERT INTO session_windows(session_id, session_key, session_scope) VALUES (?, ?, 'conversation')",
                (sid, KEY))
    con.commit()
    reader = openclaw.OpenclawLogReader()
    seen: set[str] = set()
    reader.parse_activity(db, seen)
    _uuid_session(con, sid)
    events = reader.parse_activity(db, seen)
    assert [(e.event_type, e.session_id) for e in events] == [("agent_active", KEY), ("turn_complete", KEY)]
    assert openclaw._session_exists("/work", KEY) is True
    assert openclaw._session_exists("/work", "agent:main:missing") is False


def test_uuid_session_falls_back_to_session_nodes(store) -> None:
    db, con = store
    con.executescript(_SESSION_TABLES)
    sid = "41d6cfa7-517d-44d9-834d-df977d99e3b9"
    con.execute("INSERT INTO session_nodes(session_key, current_session_id) VALUES (?, ?)", (KEY, sid))
    con.commit()
    _uuid_session(con, sid)
    [done] = [e for e in openclaw.OpenclawLogReader().parse_activity(db, {openclaw._ANCHOR})
                    if e.event_type == "turn_complete"]
    assert done.session_id == KEY


def test_mapping_written_after_the_first_rows_is_picked_up(store) -> None:
    db, con = store
    con.executescript(_SESSION_TABLES)
    sid = "5c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5"
    reader = openclaw.OpenclawLogReader()
    seen: set[str] = set()
    reader.parse_activity(db, seen)
    _row(con, sid, 0, dict(_VM_HEADER, id=sid))
    _row(con, sid, 1, _msg("user", "first"), "user")
    assert [e.session_id for e in reader.parse_activity(db, seen)] == [sid]
    con.execute("INSERT INTO session_windows(session_id, session_key) VALUES (?, ?)", (sid, KEY))
    con.commit()
    _row(con, sid, 2, _msg("assistant", "a", stopReason="stop"), "assistant")
    assert [e.session_id for e in reader.parse_activity(db, seen)] == [KEY]


def test_session_with_no_readable_key_is_logged_and_unrouted(store, caplog) -> None:
    db, con = store
    reader = openclaw.OpenclawLogReader()
    seen: set[str] = set()
    reader.parse_activity(db, seen)
    sid = "1f8814f1-0b8f-448c-85c3-b3f9cfa832ba"
    _row(con, sid, 0, {"type": "session"})
    _row(con, sid, 1, _msg("assistant", "a", stopReason="stop"), "assistant")
    with caplog.at_level(logging.WARNING, logger="agent_team_backend.log_readers.openclaw"):
        assert [e.session_id for e in reader.parse_activity(db, seen)] == [sid]
    assert any("names no session key" in r.getMessage() for r in caplog.records)
    # Keys not recorded at all: unknown, so a resume is not refused.
    assert openclaw._session_exists("/work", KEY) is True


def test_unknown_schema_is_no_signal_and_logged_once(tmp_path, monkeypatch, caplog) -> None:
    state = tmp_path / "state"
    monkeypatch.setenv("OPENCLAW_STATE_DIR", str(state))
    db = state / "agents" / "main" / "agent" / "openclaw-agent.sqlite"
    db.parent.mkdir(parents=True)
    con = sqlite3.connect(db)
    con.executescript("CREATE TABLE transcript_events(session_id TEXT, seq INTEGER);")
    con.close()
    reader = openclaw.OpenclawLogReader()
    with caplog.at_level(logging.WARNING, logger="agent_team_backend.log_readers.openclaw"):
        assert reader.parse_activity(db, set()) == []
        assert reader.parse_incremental(db, {}).events == []
    assert len([r for r in caplog.records if "lacks" in r.getMessage()]) == 1


def test_tokens_only_from_rows_that_carry_usage(store) -> None:
    db, con = store
    _row(con, KEY, 0, {"type": "session"})
    _row(con, KEY, 1, _msg("assistant", "a", stopReason="stop"), "assistant")
    _row(con, KEY, 2, _msg("assistant", "b", stopReason="stop", model="m1",
                           usage={"input": 10, "output": 3, "cacheRead": 4, "cacheWrite": 1}), "assistant")
    reader = openclaw.OpenclawLogReader()
    first = reader.parse_incremental(db, {})
    [usage] = first.events
    assert (usage.input_tokens, usage.output_tokens) == (15, 3)
    assert (usage.cache_read_tokens, usage.cache_creation_tokens, usage.model) == (4, 1, "m1")
    assert usage.session_id == KEY
    assert reader.parse_incremental(db, first.checkpoint).events == []


def test_session_exists_and_marker(store) -> None:
    db, con = store
    _row(con, KEY, 0, {"type": "session"})
    _row(con, KEY, 1, _msg("user", "at-pane:abc go"), "user")
    assert openclaw._session_exists("/work", KEY) is True
    assert openclaw._session_exists("/work", "agent:main:missing") is False
    assert openclaw.OpenclawLogReader().find_sessions_by_marker(["at-pane:abc"]) == {"at-pane:abc": (KEY, "")}


def test_only_the_agent_store_is_watched(store) -> None:
    db, _con = store
    reader = openclaw.OpenclawLogReader()
    assert reader.session_files() == [db]
    assert reader.accepts_watch_path(str(db)) is True
    assert reader.accepts_watch_path(str(db.parent / "openclaw.json")) is False
    assert reader.session_id_from_path(db) == "openclaw-agent"


def test_watcher_maps_the_store_journal_to_the_store(store) -> None:
    from types import SimpleNamespace

    from agent_team_backend.log_readers.watcher import _Handler

    db, _con = store
    reader = openclaw.OpenclawLogReader()
    queued: list = []
    handler = _Handler(queued.append, reader.accepts_watch_path)
    for name in (db.name + "-wal", db.name, "openclaw.json-wal"):
        handler.on_modified(SimpleNamespace(is_directory=False, src_path=str(db.with_name(name))))
    # A journal of a file no reader claims is not mapped (nor queued).
    assert queued == [db, db]
