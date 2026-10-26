"""Tests for the per-workspace preview record."""

from __future__ import annotations

import threading
import time

import pytest

from agent_team_backend import preview_log as preview_log_module
from agent_team_backend.preview_log import (
    MAX_INLINE_CHARS,
    MAX_NOTE_CHARS,
    MAX_ROWS,
    CLAIM_TTL_MS,
    MERGE_WINDOW_MS,
    PreviewLog,
)
from agent_team_backend.db import DB_FILENAME, Database, WorkspaceDatabases
from agent_team_backend.projects import PROJECT_DIR_NAME


@pytest.fixture
def clock(monkeypatch):
    """A hand-cranked millisecond clock so merge windows are deterministic."""

    state = {"now": 1_000_000}

    def now_ms() -> int:
        return state["now"]

    monkeypatch.setattr(preview_log_module, "_now_ms", now_ms)

    class Clock:
        def advance(self, ms: int) -> None:
            state["now"] += ms

        @property
        def now(self) -> int:
            return state["now"]

    return Clock()


def _db_path(ws):
    return ws / PROJECT_DIR_NAME / DB_FILENAME


def _count(ws) -> int:
    db = Database(_db_path(ws))
    try:
        with db.transaction() as cur:
            return cur.execute("SELECT COUNT(*) AS n FROM preview_log").fetchone()["n"]
    finally:
        db.close()


def test_schema_created_and_versioned(tmp_path, clock):
    store = PreviewLog()
    row = store.append(
        str(tmp_path), change="modified", rel_path="src/a.ts", source="user"
    )
    assert row is not None
    assert row["uid"].startswith(f"{clock.now}:")
    assert row["created_at"] == clock.now
    assert row["kind"] == "file"

    db = Database(_db_path(tmp_path))
    try:
        assert db.schema_version("preview_log") == 1
        with db.transaction() as cur:
            names = {
                r["name"]
                for r in cur.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'index'"
                ).fetchall()
            }
        assert {"preview_log_created", "preview_log_path"} <= names
    finally:
        db.close()


def test_persisted_row_reads_back_cold(tmp_path, clock):
    ws = str(tmp_path)
    PreviewLog().append(
        ws,
        change="created",
        rel_path="src/new.ts",
        source="agent",
        pane_id="pane-1",
        agent="claude",
        tool="Write",
        note="added the exporter",
        title="new.ts",
    )
    rows = PreviewLog().tail(ws)
    assert len(rows) == 1
    assert rows[0]["change"] == "created"
    assert rows[0]["agent"] == "claude"
    assert rows[0]["tool"] == "Write"
    assert rows[0]["note"] == "added the exporter"
    assert rows[0]["title"] == "new.ts"


def test_same_path_and_change_merges_inside_the_window(tmp_path, clock):
    ws = str(tmp_path)
    store = PreviewLog()
    first = store.append(ws, change="modified", rel_path="a.ts", source="user")
    clock.advance(MERGE_WINDOW_MS - 1)
    assert store.append(ws, change="modified", rel_path="a.ts", source="user") is None
    rows = store.tail(ws)
    assert len(rows) == 1
    # The surviving row is the original, restamped.
    assert rows[0]["uid"] == first["uid"]
    assert rows[0]["created_at"] == clock.now


def test_same_path_outside_the_window_keeps_both(tmp_path, clock):
    ws = str(tmp_path)
    store = PreviewLog()
    store.append(ws, change="modified", rel_path="a.ts", source="user")
    clock.advance(MERGE_WINDOW_MS + 1)
    assert store.append(ws, change="modified", rel_path="a.ts", source="user") is not None
    assert len(store.tail(ws)) == 2


def test_a_different_change_does_not_merge(tmp_path, clock):
    ws = str(tmp_path)
    store = PreviewLog()
    store.append(ws, change="modified", rel_path="a.ts", source="user")
    assert store.append(ws, change="shown", rel_path="a.ts", source="user") is not None
    assert len(store.tail(ws)) == 2


def test_inline_records_never_merge(tmp_path, clock):
    ws = str(tmp_path)
    store = PreviewLog()
    assert store.append(ws, change="shown", kind="snippet", source="agent", payload="a")
    assert store.append(ws, change="shown", kind="snippet", source="agent", payload="b")
    assert len(store.tail(ws)) == 2


def test_agent_row_upgrades_a_watcher_row(tmp_path, clock):
    ws = str(tmp_path)
    store = PreviewLog()
    watcher = store.append(ws, change="modified", rel_path="a.ts", source="watcher")
    assert watcher["source"] == "watcher"
    clock.advance(100)
    upgraded = store.append(
        ws,
        change="modified",
        rel_path="a.ts",
        source="agent",
        pane_id="pane-7",
        agent="claude",
        tool="Edit",
        note="tidied the imports",
    )
    # An upgrade is returned so the panel can be told who did it.
    assert upgraded is not None
    assert upgraded["uid"] == watcher["uid"]
    assert upgraded["source"] == "agent"
    assert upgraded["pane_id"] == "pane-7"
    assert upgraded["agent"] == "claude"
    assert upgraded["tool"] == "Edit"
    assert upgraded["note"] == "tidied the imports"

    rows = store.tail(ws)
    assert len(rows) == 1
    assert rows[0]["source"] == "agent"
    assert rows[0]["agent"] == "claude"


def test_watcher_row_is_discarded_when_an_agent_row_exists(tmp_path, clock):
    ws = str(tmp_path)
    store = PreviewLog()
    agent_row = store.append(
        ws, change="modified", rel_path="a.ts", source="agent", agent="claude"
    )
    clock.advance(100)
    assert store.append(ws, change="modified", rel_path="a.ts", source="watcher") is None
    rows = store.tail(ws)
    assert len(rows) == 1
    assert rows[0]["uid"] == agent_row["uid"]
    assert rows[0]["source"] == "agent"
    assert rows[0]["agent"] == "claude"


def test_watcher_echo_folds_into_the_agent_row_however_late_it_lands(tmp_path, clock):
    # The hook fires before the write; a permission prompt or a busy host puts
    # the watcher's echo well past the merge window. Still one write, one row.
    ws = str(tmp_path)
    store = PreviewLog()
    agent_row = store.append(ws, change="modified", rel_path="a.ts", source="agent")
    clock.advance(MERGE_WINDOW_MS * 30)
    assert store.append(ws, change="modified", rel_path="a.ts", source="watcher") is None
    rows = store.tail(ws)
    assert [r["uid"] for r in rows] == [agent_row["uid"]]
    # The claim covers one echo: the next change nobody reported is a new row.
    clock.advance(MERGE_WINDOW_MS + 1)
    assert store.append(ws, change="modified", rel_path="a.ts", source="watcher") is not None
    assert len(store.tail(ws)) == 2


def test_an_unanswered_claim_expires(tmp_path, clock):
    # A denied tool never writes; its claim must not swallow a later save.
    ws = str(tmp_path)
    store = PreviewLog()
    store.append(ws, change="modified", rel_path="a.ts", source="agent")
    clock.advance(CLAIM_TTL_MS + 1)
    assert store.append(ws, change="modified", rel_path="a.ts", source="watcher") is not None
    assert len(store.tail(ws)) == 2


def test_prune_keeps_max_rows_and_drops_the_oldest(tmp_path, clock):
    ws = str(tmp_path)
    store = PreviewLog()
    first = store.append(ws, change="shown", rel_path="f0.ts", source="user")
    for i in range(1, MAX_ROWS + 20):
        clock.advance(MERGE_WINDOW_MS + 1)
        store.append(ws, change="shown", rel_path=f"f{i}.ts", source="user")
    assert _count(tmp_path) == MAX_ROWS
    rows = store.tail(ws, limit=MAX_ROWS)
    assert len(rows) == MAX_ROWS
    uids = {r["uid"] for r in rows}
    assert first["uid"] not in uids
    assert rows[0]["rel_path"] == f"f{MAX_ROWS + 19}.ts"


@pytest.mark.parametrize(
    "fields",
    [
        {"change": "renamed", "source": "user"},
        {"change": "modified", "source": "robot"},
        {"change": "modified", "source": "user", "kind": "pdf"},
    ],
)
def test_illegal_values_are_rejected(tmp_path, clock, fields):
    ws = str(tmp_path)
    store = PreviewLog()
    assert store.append(ws, rel_path="a.ts", **fields) is None
    # Nothing dirty landed — and no database was even created for it.
    assert not _db_path(tmp_path).exists()


def test_long_note_is_truncated(tmp_path, clock):
    ws = str(tmp_path)
    row = PreviewLog().append(
        ws,
        change="modified",
        rel_path="a.ts",
        source="agent",
        note="x" * (MAX_NOTE_CHARS + 500),
    )
    assert len(row["note"]) == MAX_NOTE_CHARS
    assert row["note"].endswith("[truncated]")


def test_oversized_payload_is_rejected(tmp_path, clock):
    ws = str(tmp_path)
    store = PreviewLog()
    assert (
        store.append(
            ws,
            change="shown",
            kind="markdown",
            source="agent",
            payload="y" * (MAX_INLINE_CHARS + 1),
        )
        is None
    )
    assert not _db_path(tmp_path).exists()
    # One character under the cap still lands.
    assert store.append(
        ws, change="shown", kind="markdown", source="agent",
        payload="y" * MAX_INLINE_CHARS,
    ) is not None


def test_tail_filters(tmp_path, clock):
    ws = str(tmp_path)
    store = PreviewLog()
    store.append(
        ws, change="created", rel_path="a.ts", source="agent", agent="claude"
    )
    cut = clock.now
    clock.advance(MERGE_WINDOW_MS + 1)
    store.append(
        ws, change="modified", rel_path="b.ts", source="agent", agent="codex"
    )
    clock.advance(MERGE_WINDOW_MS + 1)
    store.append(ws, change="modified", rel_path="c.ts", source="watcher")

    assert [r["rel_path"] for r in store.tail(ws)] == ["c.ts", "b.ts", "a.ts"]
    assert [r["rel_path"] for r in store.tail(ws, since=cut)] == ["c.ts", "b.ts"]
    assert [r["rel_path"] for r in store.tail(ws, change="created")] == ["a.ts"]
    assert [r["rel_path"] for r in store.tail(ws, agent="codex")] == ["b.ts"]
    assert [r["rel_path"] for r in store.tail(ws, source="watcher")] == ["c.ts"]
    assert [r["rel_path"] for r in store.tail(ws, limit=1)] == ["c.ts"]


def test_clear_all_and_clear_before(tmp_path, clock):
    ws = str(tmp_path)
    store = PreviewLog()
    store.append(ws, change="shown", rel_path="a.ts", source="user")
    clock.advance(MERGE_WINDOW_MS + 1)
    cut = clock.now
    store.append(ws, change="shown", rel_path="b.ts", source="user")

    assert store.clear(ws, before=cut) == 1
    assert [r["rel_path"] for r in store.tail(ws)] == ["b.ts"]
    assert store.clear(ws) == 1
    assert store.tail(ws) == []


def test_workspaces_are_isolated(tmp_path, clock):
    ws_a = tmp_path / "a"
    ws_b = tmp_path / "b"
    ws_a.mkdir()
    ws_b.mkdir()
    store = PreviewLog()
    store.append(str(ws_a), change="modified", rel_path="only-a.ts", source="user")
    store.append(str(ws_b), change="modified", rel_path="only-b.ts", source="user")

    assert [r["rel_path"] for r in store.tail(str(ws_a))] == ["only-a.ts"]
    assert [r["rel_path"] for r in store.tail(str(ws_b))] == ["only-b.ts"]


def test_reads_never_create_a_database(tmp_path, clock):
    store = PreviewLog()
    assert store.tail(str(tmp_path)) == []
    assert store.clear(str(tmp_path)) == 0
    assert not _db_path(tmp_path).exists()


def test_append_to_a_missing_workspace_is_a_no_op(tmp_path, clock, caplog):
    store = PreviewLog()
    with caplog.at_level("WARNING"):
        assert store.append(
            str(tmp_path / "nope"), change="modified", rel_path="a.ts", source="user"
        ) is None
    assert any("preview log append failed" in r.message for r in caplog.records)


def test_shutdown_close_does_not_deadlock_with_a_watcher_burst(tmp_path):
    """A watcher burst holds the workspace db's transaction (batch) and then
    appends; shutdown's close_all runs meanwhile. close_all once held the
    registry while waiting for that db (a deadlock), and after that the
    append opened a second connection that waited out SQLite's busy timeout,
    which a throttled macOS runner stretched past 10 s. The burst now keeps
    its own db: it finishes, its rows are kept, and close_all closes after."""
    ws = str(tmp_path)
    databases = WorkspaceDatabases()
    store = PreviewLog(databases)
    store.append(ws, change="modified", rel_path="a.ts", source="watcher")
    inside = threading.Event()
    errors: list[BaseException] = []

    def burst():
        try:
            with store.batch(ws):
                inside.set()
                time.sleep(0.2)  # still running when shutdown starts
                store.append(ws, change="modified", rel_path="b.ts", source="watcher")
        except BaseException as err:  # noqa: BLE001 - reported below
            errors.append(err)

    worker = threading.Thread(target=burst, daemon=True)
    worker.start()
    assert inside.wait(5)
    closer = threading.Thread(target=databases.close_all, daemon=True)
    closer.start()
    # Bounded, so a deadlock fails here instead of hanging the run. The burst
    # needs no lock wait at all now, so the bound is far from tight.
    closer.join(10)
    worker.join(10)
    assert not worker.is_alive(), "the burst never finished"
    assert not closer.is_alive(), "close_all deadlocked with the burst"
    assert errors == []
    assert [r["rel_path"] for r in PreviewLog().tail(ws)] == ["b.ts", "a.ts"]
