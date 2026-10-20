"""OpencodeLogReader against the OpenCode 2 database schema.

OpenCode 2 (Homebrew Core ships 2.x; the 1.x install script refuses it) keeps
the same shared db, <XDG_DATA_HOME|~/.local/share>/opencode/opencode.db, but
stores conversations in new tables. The fixture below mirrors
anomalyco/opencode at 6e9c85390bc2 (`dev`):

  packages/core/src/session/sql.ts
    session_v2       id, project_id, parent_id, slug, directory, version, ...
    session_message  id, session_id, type, seq, time_created, time_updated,
                     data (the message JSON minus its `id` and `type`)
  packages/schema/src/session-message.ts
    type "user"      data.text is the prompt as typed
    type "assistant" data.model {id, providerID}, data.tokens (same shape as
                     1.x), data.time.completed once the step has finished,
                     data.content [{type: "text"|"reasoning"|"tool", ...}]
    type "idle"      "every step since the previous marker belongs to one
                     turn" — the turn end, with data.outcome
  packages/core/src/database/migration/20260804233008_loose_psylocke.ts
    renames 1.x's `session` to `session_v2`; v1-migration.bun.ts copies the
    1.x `message`/`part` rows forward and leaves those tables behind, so an
    upgraded db holds both sets.

Assistant rows are UPDATEd in place while a step streams (projector.ts), so
rowid stays a valid watermark, exactly as for 1.x's `message` table.

Not checked against a real OpenCode 2 binary: these tests pin the schema as
the source declares it.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import sys
from pathlib import Path

import pytest

from agent_team_backend.cli_vendors import opencode as opencode_mod
from agent_team_backend.log_readers import KiloLogReader, OpencodeLogReader, TokenUsage
from agent_team_backend.log_readers.attribution import Attribution


_V2_SCHEMA = """
CREATE TABLE project (
  id TEXT PRIMARY KEY,
  worktree TEXT NOT NULL
);

CREATE TABLE session_v2 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workspace_id TEXT,
  parent_id TEXT,
  slug TEXT NOT NULL,
  directory TEXT NOT NULL,
  title TEXT,
  version TEXT NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  tokens_input INTEGER NOT NULL DEFAULT 0,
  tokens_output INTEGER NOT NULL DEFAULT 0,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE TABLE session_message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  seq INTEGER NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
"""

# The 1.x tables an upgraded db still carries next to the new ones.
_V1_LEFTOVER_SCHEMA = """
CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT,
  slug TEXT, directory TEXT, title TEXT, version TEXT,
  time_created INTEGER, time_updated INTEGER);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT,
  time_created INTEGER, time_updated INTEGER, data TEXT);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
  time_created INTEGER, time_updated INTEGER, data TEXT);
"""

_NOW_MS = 1792460000000
_SID = "ses_2a01f0c0ffee7Qx9v2"


@pytest.fixture(autouse=True)
def _clear_read_problems():
    opencode_mod._READ_PROBLEMS.clear()
    yield
    opencode_mod._READ_PROBLEMS.clear()


@pytest.fixture
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    d = tmp_path / "xdg" / "opencode"
    d.mkdir(parents=True)
    return d


class _Db:
    """A 2.x db and the writes OpenCode 2's projector makes to it."""

    def __init__(self, path: Path, *, upgraded_from_v1: bool = False) -> None:
        self.path = path
        self.con = sqlite3.connect(path)
        self.con.execute("PRAGMA journal_mode=WAL")
        self.con.executescript(_V2_SCHEMA)
        if upgraded_from_v1:
            self.con.executescript(_V1_LEFTOVER_SCHEMA)
        self.con.commit()
        self._seq: dict[str, int] = {}
        self._n = 0

    def session(self, sid: str, directory: str, *, parent_id: str | None = None) -> None:
        self.con.execute(
            "INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title,"
            " version, time_created, time_updated)"
            " VALUES (?, 'proj1', ?, 'slug', ?, 'title', '2.0.32', ?, ?)",
            (sid, parent_id, directory, _NOW_MS, _NOW_MS),
        )
        self.con.commit()

    def message(self, sid: str, type_: str, data: dict, *, mid: str | None = None) -> str:
        self._n += 1
        mid = mid or f"msg_{self._n:04d}"
        seq = self._seq.get(sid, -1) + 1
        self._seq[sid] = seq
        data = {"time": {"created": _NOW_MS + self._n}, **data}
        self.con.execute(
            "INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)",
            (mid, sid, type_, seq, _NOW_MS + self._n, _NOW_MS + self._n, json.dumps(data)),
        )
        self.con.commit()
        return mid

    def update(self, mid: str, data: dict) -> None:
        row = self.con.execute("SELECT data FROM session_message WHERE id = ?", (mid,)).fetchone()
        merged = {**json.loads(row[0]), **data}
        self.con.execute(
            "UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?",
            (json.dumps(merged), _NOW_MS + 99_000, mid),
        )
        self.con.commit()

    def user(self, sid: str, text: str) -> str:
        return self.message(sid, "user", {"text": text, "files": [], "agents": [], "skills": []})

    def assistant(
        self,
        sid: str,
        *,
        text: str = "",
        tokens: dict | None = None,
        completed: bool = True,
    ) -> str:
        data: dict = {
            "agent": "build",
            "model": {"id": "claude-sonnet-5-5", "providerID": "anthropic"},
            "content": [{"type": "text", "text": text}] if text else [],
        }
        if tokens is not None:
            data["tokens"] = tokens
        mid = self.message(sid, "assistant", data)
        if completed:
            self.update(mid, {"time": {"created": _NOW_MS, "completed": _NOW_MS + 15_000},
                              "finish": "stop"})
        return mid

    def idle(self, sid: str, outcome: str = "succeeded") -> str:
        return self.message(sid, "idle", {"outcome": outcome})


def _tokens(input_: int = 100, output: int = 20, reasoning: int = 5, read: int = 1000, write: int = 50) -> dict:
    return {"input": input_, "output": output, "reasoning": reasoning,
            "cache": {"read": read, "write": write}}


def _session_sink_usage(db: Path) -> TokenUsage:
    """The placeholder usage app._on_session_file builds for a db change."""
    return TokenUsage(
        vendor="opencode", input_tokens=0, output_tokens=0, cwd="",
        session_id=db.stem, file_path=str(db), dedup_key="",
    )


# ── turn end ─────────────────────────────────────────────────────────────────

def test_an_idle_message_ends_the_turn_with_the_reply(data_dir: Path) -> None:
    reader = OpencodeLogReader()
    db = _Db(data_dir / "opencode.db")
    db.session(_SID, "/ws")
    seen: set[str] = set()
    assert reader.parse_activity(db.path, seen) == []  # first sight: history

    db.user(_SID, "run the tests")
    db.assistant(_SID, text="Running them.", completed=True)
    db.assistant(_SID, text="All 12 tests pass.", tokens=_tokens())
    db.idle(_SID)
    events = reader.parse_activity(db.path, seen)

    assert [e.event_type for e in events][-1] == "turn_complete"
    assert all(e.event_type == "agent_active" for e in events[:-1])
    assert events[0].detail == "user" and events[0].text == "run the tests"
    assert events[-1].text == "All 12 tests pass."
    assert events[-1].session_id == _SID and events[-1].cwd == "/ws"
    # Nothing new, nothing reported.
    assert reader.parse_activity(db.path, seen) == []


def test_a_subagent_going_idle_does_not_end_the_pane_turn(data_dir: Path) -> None:
    reader = OpencodeLogReader()
    db = _Db(data_dir / "opencode.db")
    db.session(_SID, "/ws")
    db.session("ses_child", "/ws", parent_id=_SID)
    seen: set[str] = set()
    reader.parse_activity(db.path, seen)

    db.assistant("ses_child", text="child done")
    db.idle("ses_child")
    events = reader.parse_activity(db.path, seen)

    assert "turn_complete" not in [e.event_type for e in events]
    assert events[-1].detail == "subagent:done"


def test_activity_first_sight_of_a_v2_db_skips_history_even_with_a_1x_watermark(
    data_dir: Path,
) -> None:
    """A watermark taken on the 1.x `part` table means nothing in
    `session_message`: an upgraded db is history, not activity."""
    reader = OpencodeLogReader()
    db = _Db(data_dir / "opencode.db", upgraded_from_v1=True)
    db.session(_SID, "/ws")
    for _ in range(3):
        db.user(_SID, "old prompt")
        db.idle(_SID)

    assert reader.parse_activity(db.path, {"opencode_part::1"}) == []


# ── tokens ───────────────────────────────────────────────────────────────────

def test_completed_assistant_steps_are_credited(data_dir: Path) -> None:
    reader = OpencodeLogReader()
    db = _Db(data_dir / "opencode.db")
    db.session(_SID, "/ws")
    mid = db.assistant(_SID, text="done", tokens=_tokens())
    db.user(_SID, "next")  # not an assistant row: never credited

    (usage,) = reader.parse_session_file(db.path, set())

    assert usage.vendor == "opencode"
    assert usage.input_tokens == 100 + 1000 + 50
    assert usage.output_tokens == 20 + 5
    assert usage.session_id == _SID and usage.cwd == "/ws"
    assert usage.dedup_key == f"msg:{mid}"
    assert usage.model == "claude-sonnet-5-5"
    assert usage.cli_version == "2.0.32"


def test_incremental_parse_rechecks_a_streaming_step(data_dir: Path) -> None:
    reader = OpencodeLogReader()
    db = _Db(data_dir / "opencode.db")
    db.session(_SID, "/ws")
    mid = db.assistant(_SID, tokens=_tokens(), completed=False)

    first = reader.parse_incremental(db.path, {})
    assert first.events == []
    db.update(mid, {"time": {"created": _NOW_MS, "completed": _NOW_MS + 1}})
    second = reader.parse_incremental(db.path, first.checkpoint)

    assert [e.dedup_key for e in second.events] == [f"msg:{mid}"]
    assert reader.parse_incremental(db.path, second.checkpoint).events == []


def test_a_1x_watermark_on_an_upgraded_db_does_not_recredit_history(data_dir: Path) -> None:
    """OpenCode 2 copies the 1.x conversations into `session_message`. A
    checkpoint taken on 1.x's `message` table re-anchors at the newest row
    instead of crediting every copied message a second time."""
    reader = OpencodeLogReader()
    db = _Db(data_dir / "opencode.db", upgraded_from_v1=True)
    db.session(_SID, "/ws")
    for _ in range(3):
        db.assistant(_SID, tokens=_tokens())
    st = db.path.stat()
    old = {"kind": "sqlite", "row_id": 1, "pending": [], "anchor": "",
           "identity": f"{st.st_dev}:{st.st_ino}"}

    first = reader.parse_incremental(db.path, old)
    assert first.events == []
    mid = db.assistant(_SID, tokens=_tokens())
    second = reader.parse_incremental(db.path, first.checkpoint)
    assert [e.dedup_key for e in second.events] == [f"msg:{mid}"]


# ── session binding / resume ─────────────────────────────────────────────────

def test_marker_binding_announces_the_v2_session(data_dir: Path) -> None:
    reader = OpencodeLogReader()
    ws = data_dir.parent / "ws"
    ws.mkdir()
    marker = "at-pane:pane-oc2-1"
    db = _Db(data_dir / "opencode.db")
    db.session(_SID, str(ws))
    db.user(_SID, f"kickoff…\nsession marker: {marker}\n")

    attr = Attribution([reader], workspaces_path=data_dir.parent / "ws.json")
    attr.register_pane(
        "pane-oc2-1", vendor="opencode", cwd=str(ws),
        workspace_path=str(ws), session_marker=marker,
    )
    binding = attr.maybe_announce_session(_session_sink_usage(db.path))

    assert binding is not None
    assert binding.pane_id == "pane-oc2-1"
    assert binding.resume_id == _SID  # what `opencode --session <id>` takes in 2.x too


def test_a_marker_in_a_subagent_or_assistant_message_does_not_bind(data_dir: Path) -> None:
    reader = OpencodeLogReader()
    db = _Db(data_dir / "opencode.db")
    db.session(_SID, "/ws")
    db.session("ses_child", "/ws", parent_id=_SID)
    db.user("ses_child", "forwarded at-pane:p1")
    db.assistant(_SID, text="I saw at-pane:p2")

    assert reader.find_sessions_by_marker(["at-pane:p1", "at-pane:p2"]) == {}


def test_has_session_reads_the_v2_table(data_dir: Path) -> None:
    reader = OpencodeLogReader()
    db = _Db(data_dir / "opencode.db")
    db.session(_SID, "/ws")

    assert reader.has_session(_SID) is True
    assert reader.has_session("ses_missing") is False


def test_an_upgraded_db_is_read_through_its_v2_tables(data_dir: Path) -> None:
    """The 1.x tables are left behind and stop changing; reading them would be
    'no new data' for ever."""
    reader = OpencodeLogReader()
    db = _Db(data_dir / "opencode.db", upgraded_from_v1=True)
    db.session(_SID, "/ws")
    db.user(_SID, "hello at-pane:p9")

    assert reader.has_session(_SID) is True
    assert reader.find_sessions_by_marker(["at-pane:p9"]) == {"at-pane:p9": (_SID, "/ws")}
    # Both schemas, the 2.x side written last: the normal upgraded state.
    assert opencode_mod.read_problem("opencode") is None


def _write_1x_turn(db: _Db, sid: str, when_ms: int) -> None:
    """What a 1.x binary writes into the leftover tables of a shared db."""
    db.con.execute(
        "INSERT INTO session VALUES (?, 'proj1', NULL, 'slug', '/ws', 't', '1.19.3', ?, ?)",
        (sid, when_ms, when_ms),
    )
    data = {"role": "assistant", "modelID": "m", "time": {"created": when_ms, "completed": when_ms},
            "tokens": _tokens()}
    db.con.execute(
        "INSERT INTO message VALUES ('msg_v1', ?, ?, ?, ?)", (sid, when_ms, when_ms, json.dumps(data)),
    )
    db.con.commit()


def test_a_db_a_1x_binary_still_writes_is_read_as_1x_and_disclosed(data_dir: Path) -> None:
    """A downgrade, or a 1.x and a 2.x binary sharing the db: the 1.x tables
    took the newest write, so reading only the 2.x side would drop that
    session and refuse its resume without a word."""
    reader = OpencodeLogReader()
    db = _Db(data_dir / "opencode.db", upgraded_from_v1=True)
    db.session(_SID, "/ws")
    db.user(_SID, "a 2.x turn")
    _write_1x_turn(db, "ses_v1", _NOW_MS + 500_000)

    (usage,) = reader.parse_session_file(db.path, set())
    assert usage.session_id == "ses_v1"
    # Resume preflight accepts a session on either side.
    assert reader.has_session("ses_v1") is True
    assert reader.has_session(_SID) is True
    problem = opencode_mod.read_problem("opencode")
    assert problem is not None
    assert (problem["status"], problem["reason"]) == ("partial", "mixed-schema")

    # Once OpenCode 2 writes again, its side is newer: read as 2.x, all clear.
    db.assistant(_SID, tokens=_tokens())
    db.con.execute("UPDATE session_message SET time_updated = ?", (_NOW_MS + 900_000,))
    db.con.commit()
    reader.parse_session_file(db.path, set())
    assert opencode_mod.read_problem("opencode") is None


def test_a_persistent_problem_is_disclosed_once_and_holds_still(data_dir: Path, caplog) -> None:
    """Reads that work must not clear a problem another read keeps hitting:
    the disclosure would flicker and `since` would move every cycle."""
    reader = OpencodeLogReader()
    con = sqlite3.connect(data_dir / "opencode.db")
    con.executescript(
        "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT, version TEXT);"
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);"
    )  # no `part`: usage reads, activity cannot
    con.commit()
    con.close()
    db = data_dir / "opencode.db"
    seen: set[str] = set()

    with caplog.at_level(logging.INFO, logger="agent_team_backend.log_readers.opencode"):
        reader.parse_session_file(db, set())
        reader.parse_activity(db, seen)
        first = opencode_mod.read_problem("opencode")
        lines = len(caplog.records)
        for _ in range(5):
            reader.parse_session_file(db, set())
            reader.parse_activity(db, seen)
            assert opencode_mod.read_problem("opencode") == first

    assert first is not None and first["reason"] == "query-failed"
    assert "no such table: part" in first["detail"]
    assert len(caplog.records) == lines  # nothing logged after the first cycle


@pytest.mark.skipif(
    sys.platform == "win32" or os.geteuid() == 0, reason="needs POSIX permissions and a non-root user",
)
def test_a_db_this_process_may_not_open_is_reported(data_dir: Path) -> None:
    reader = OpencodeLogReader()
    db = _Db(data_dir / "opencode.db")
    db.session(_SID, "/ws")
    db.con.close()
    db.path.chmod(0)
    try:
        assert reader.parse_session_file(db.path, set()) == []
        problem = opencode_mod.read_problem("opencode")
    finally:
        db.path.chmod(0o600)
    assert problem is not None and problem["reason"] == "query-failed"


# ── disclosure ───────────────────────────────────────────────────────────────

def test_an_unrecognised_schema_is_reported_not_swallowed(data_dir: Path, caplog) -> None:
    reader = OpencodeLogReader()
    con = sqlite3.connect(data_dir / "opencode.db")
    con.execute("CREATE TABLE conversation_v3 (id TEXT)")
    con.commit()
    con.close()
    db = data_dir / "opencode.db"

    with caplog.at_level(logging.WARNING, logger="agent_team_backend.log_readers.opencode"):
        assert reader.parse_session_file(db, set()) == []
        assert reader.parse_activity(db, set()) == []

    problem = opencode_mod.read_problem("opencode")
    assert problem is not None
    assert problem["reason"] == "unrecognized-schema"
    assert problem["path"] == str(db)
    assert "conversation_v3" in problem["detail"]
    # One warning per distinct problem, however many cycles hit it.
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1


def test_a_failing_query_is_reported_and_cleared_once_reads_work(data_dir: Path) -> None:
    reader = OpencodeLogReader()
    con = sqlite3.connect(data_dir / "opencode.db")
    # Right table names, wrong columns: every real query fails.
    con.executescript(
        "CREATE TABLE session_v2 (id TEXT);"
        "CREATE TABLE session_message (id TEXT);"
    )
    con.commit()
    con.close()
    db = data_dir / "opencode.db"

    assert reader.parse_session_file(db, set()) == []
    problem = opencode_mod.read_problem("opencode")
    assert problem is not None and problem["reason"] == "query-failed"
    assert "no such column" in problem["detail"]

    db.unlink()
    good = _Db(db)
    good.session(_SID, "/ws")
    good.assistant(_SID, tokens=_tokens())
    assert len(reader.parse_session_file(db, set())) == 1
    assert opencode_mod.read_problem("opencode") is None


def test_a_locked_db_is_transient_and_not_reported(data_dir: Path, monkeypatch) -> None:
    reader = OpencodeLogReader()
    db = _Db(data_dir / "opencode.db")
    db.session(_SID, "/ws")

    def locked(*_a, **_k):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(opencode_mod.sqlite3, "connect", locked)
    assert reader.parse_session_file(db.path, set()) == []
    assert opencode_mod.read_problem("opencode") is None


def test_kilo_problems_are_its_own(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    (tmp_path / "kilo").mkdir()
    db = tmp_path / "kilo" / "kilo.db"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE something_else (id TEXT)")
    con.commit()
    con.close()

    assert KiloLogReader().parse_session_file(db, set()) == []
    assert opencode_mod.read_problem("kilo")["reason"] == "unrecognized-schema"
    assert opencode_mod.read_problem("opencode") is None


@pytest.mark.asyncio
async def test_cli_get_status_says_the_opencode_db_cannot_be_read(monkeypatch) -> None:
    from types import SimpleNamespace

    from agent_team_backend import agent_messaging
    from agent_team_backend.mcp_server import server as plan_mcp, wiring as plan_mcp_wiring

    async def nothing(*_a, **_k):
        return None

    async def no_window(*_a, **_k):
        return {"ok": False}

    monkeypatch.setattr(plan_mcp, "pane_git", nothing)
    monkeypatch.setattr(plan_mcp, "_cached_usage_snapshot", nothing)
    monkeypatch.setattr(plan_mcp, "_ui_request", no_window)
    agent_messaging._reset_for_test()
    try:
        agent_messaging.register("pa", "boss", "/ws", agent_key="claude", owner=object())
        agent_messaging.register("po", "oc", "/ws", agent_key="opencode", owner=object())
        params = {"pane": "pa", "t": plan_mcp_wiring.caller_token("pa")}
        ctx = SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))

        assert "log_reader" not in await plan_mcp.cli_get_status("oc", ctx)
        opencode_mod._READ_PROBLEMS["opencode"] = {"schema": {
            "status": "unreadable", "reason": "unrecognized-schema",
            "path": "/x/opencode.db", "detail": "tables: kv", "since": "2026-10-20T01:00:00Z",
        }}
        status = await plan_mcp.cli_get_status("oc", ctx)
        assert status["log_reader"]["status"] == "unreadable"
        assert status["log_reader"]["reason"] == "unrecognized-schema"
        # Another vendor's pane is not told about OpenCode's db.
        assert "log_reader" not in await plan_mcp.cli_get_status("boss", ctx)
    finally:
        agent_messaging._reset_for_test()
