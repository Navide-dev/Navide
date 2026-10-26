"""Tests for the persisted inter-CLI message log."""

from __future__ import annotations

import sqlite3

import pytest

from agent_team_backend.agent_message_log import (
    MAX_APPEND_ROWS,
    MAX_CONTENT_CHARS,
    MAX_ROWS,
    AgentMessageLog,
    _add_agent_keys,
    _add_kind,
    _add_seq,
    _add_threading,
    _create_schema,
)
from agent_team_backend.db import Database


@pytest.fixture
def log(tmp_path):
    return AgentMessageLog(db=Database(tmp_path / "navide.db"))


def _row(uid: str, created_at: int, **over):
    row = {
        "uid": uid,
        "created_at": created_at,
        "status": "delivered",
        "sender": "alpha/claude-1",
        "recipient": "beta/reviewer",
        "content": f"hello {uid}",
    }
    row.update(over)
    return row


def test_append_and_tail_round_trip_oldest_first(tmp_path):
    db = Database(tmp_path / "navide.db")
    store = AgentMessageLog(db=db)
    assert store.append([_row("a:1", 100), _row("a:2", 200)]) == 2

    # A fresh store over the same database reads it back cold, oldest first.
    cold = AgentMessageLog(db=db)
    rows = cold.tail()
    assert [r["uid"] for r in rows] == ["a:1", "a:2"]
    assert rows[0]["sender"] == "alpha/claude-1"
    assert rows[0]["recipient"] == "beta/reviewer"
    assert rows[0]["content"] == "hello a:1"
    assert rows[0]["reason"] is None
    assert rows[0]["delivered_at"] is None


def test_tail_orders_by_created_at_not_insertion(tmp_path):
    db = Database(tmp_path / "navide.db")
    AgentMessageLog(db=db).append([_row("a:2", 200), _row("a:1", 100)])
    assert [r["uid"] for r in AgentMessageLog(db=db).tail()] == ["a:1", "a:2"]


def test_tail_limit_returns_the_newest(log):
    log.append([_row(f"a:{i}", i) for i in range(1, 6)])
    assert [r["uid"] for r in log.tail(2)] == ["a:4", "a:5"]


def test_append_before_the_first_read_does_not_hide_persisted_rows(tmp_path):
    """A backend restart under a live renderer: the new store writes before it
    ever reads, and must still report the rows written by its predecessor."""
    db = Database(tmp_path / "navide.db")
    AgentMessageLog(db=db).append([_row("a:1", 100), _row("a:2", 200)])

    restarted = AgentMessageLog(db=db)
    restarted.append([_row("a:3", 300)])
    assert [r["uid"] for r in restarted.tail()] == ["a:1", "a:2", "a:3"]


def test_repeated_uid_replaces_instead_of_duplicating(tmp_path):
    db = Database(tmp_path / "navide.db")
    store = AgentMessageLog(db=db)
    store.append([_row("a:1", 100, status="queued")])
    store.append([_row("a:1", 100, status="delivered", content="final")])

    for rows in (store.tail(), AgentMessageLog(db=db).tail()):
        assert len(rows) == 1
        assert rows[0]["status"] == "delivered"
        assert rows[0]["content"] == "final"


def test_prune_keeps_only_the_newest_max_rows(tmp_path):
    db = Database(tmp_path / "navide.db")
    store = AgentMessageLog(db=db)
    store.append([_row(f"a:{i:04d}", i) for i in range(MAX_ROWS + 20)])

    with db.transaction() as cur:
        total = cur.execute("SELECT COUNT(*) AS n FROM agent_message_log").fetchone()["n"]
    assert total == MAX_ROWS
    rows = AgentMessageLog(db=db).tail()
    assert len(rows) == MAX_ROWS
    assert rows[0]["uid"] == "a:0020"
    assert rows[-1]["uid"] == f"a:{MAX_ROWS + 19:04d}"


def test_prune_breaks_created_at_ties_by_insertion_order(tmp_path):
    """Realistic input: unpadded uids (they sort lexically, so `a3f9:100` <
    `a3f9:2`) and one `created_at` for the whole fan-out, which Date.now()
    ties at millisecond resolution."""
    db = Database(tmp_path / "navide.db")
    total = MAX_ROWS + 5
    AgentMessageLog(db=db).append(
        [_row(f"a3f9:{i}", 1000) for i in range(1, total + 1)]
    )

    rows = AgentMessageLog(db=db).tail()
    assert [r["uid"] for r in rows] == [f"a3f9:{i}" for i in range(6, total + 1)]


def test_reappending_a_row_keeps_its_place_in_the_log(tmp_path):
    """The frontend folds a pending status patch into a pending append row;
    the re-append must not jump the row to the end of a tied batch."""
    db = Database(tmp_path / "navide.db")
    store = AgentMessageLog(db=db)
    store.append([
        _row("a:1", 1000, status="queued"),
        _row("a:2", 1000),
        _row("a:3", 1000),
    ])
    store.append([_row("a:1", 1000, status="delivered")])

    for rows in (store.tail(), AgentMessageLog(db=db).tail()):
        assert [r["uid"] for r in rows] == ["a:1", "a:2", "a:3"]
        assert rows[0]["status"] == "delivered"


def test_duplicate_uid_inside_one_batch_stores_a_single_row(tmp_path):
    db = Database(tmp_path / "navide.db")
    store = AgentMessageLog(db=db)
    assert store.append([
        _row("a:1", 100, status="queued"),
        _row("a:1", 100, status="delivered", content="final"),
    ]) == 1

    rows = AgentMessageLog(db=db).tail()
    assert [r["uid"] for r in rows] == ["a:1"]
    assert rows[0]["status"] == "delivered"
    assert rows[0]["content"] == "final"
    # One row means a later patch cannot land on a stale copy.
    assert store.update([{"uid": "a:1", "status": "failed"}]) == 1
    assert store.tail()[0]["status"] == "failed"


def test_an_oversized_batch_is_truncated_to_the_newest_rows(tmp_path):
    db = Database(tmp_path / "navide.db")
    store = AgentMessageLog(db=db)
    oversized = [_row(f"a:{i}", i) for i in range(1, MAX_APPEND_ROWS + 51)]
    assert store.append(oversized) == MAX_APPEND_ROWS
    assert store.tail()[-1]["uid"] == f"a:{MAX_APPEND_ROWS + 50}"


def test_update_writes_only_the_provided_fields(tmp_path):
    db = Database(tmp_path / "navide.db")
    store = AgentMessageLog(db=db)
    store.append([_row("a:1", 100, status="queued", content="body")])

    assert store.update([{"uid": "a:1", "status": "delivered", "delivered_at": 900}]) == 1
    for rows in (store.tail(), AgentMessageLog(db=db).tail()):
        assert rows[0]["status"] == "delivered"
        assert rows[0]["delivered_at"] == 900
        assert rows[0]["content"] == "body"  # untouched


def test_update_of_unknown_uid_is_a_silent_no_op(log):
    log.append([_row("a:1", 100)])
    assert log.update([{"uid": "gone:9", "status": "failed", "reason": "pruned"}]) == 0
    assert [r["uid"] for r in log.tail()] == ["a:1"]


def test_update_coerces_an_unknown_status_to_failed(log):
    log.append([_row("a:1", 100, status="queued")])
    log.update([{"uid": "a:1", "status": "exploded"}])
    assert log.tail()[0]["status"] == "failed"


def test_update_keeps_a_withdrawn_message_withdrawn(log):
    """`cancelled` is a status of its own: coercing it to `failed` would make a
    message the sender took back read as one that went wrong."""
    log.append([_row("a:1", 100, status="queued")])
    log.update([{"uid": "a:1", "status": "cancelled"}])
    assert log.tail()[0]["status"] == "cancelled"


def test_clear_keeps_queued_and_delivering_by_default(tmp_path):
    db = Database(tmp_path / "navide.db")
    store = AgentMessageLog(db=db)
    store.append([
        _row("a:1", 100, status="queued"),
        _row("a:2", 200, status="delivering"),
        _row("a:3", 300, status="delivered"),
        _row("a:4", 400, status="failed"),
    ])
    assert store.clear() == 2
    for rows in (store.tail(), AgentMessageLog(db=db).tail()):
        assert [r["uid"] for r in rows] == ["a:1", "a:2"]


def test_clear_with_explicit_empty_keep_deletes_everything(tmp_path):
    db = Database(tmp_path / "navide.db")
    store = AgentMessageLog(db=db)
    store.append([_row("a:1", 100, status="queued"), _row("a:2", 200)])
    assert store.clear([]) == 2
    assert store.tail() == []
    assert AgentMessageLog(db=db).tail() == []


def test_content_is_clamped_with_a_marker(tmp_path):
    db = Database(tmp_path / "navide.db")
    store = AgentMessageLog(db=db)
    store.append([_row("a:1", 100, content="x" * (MAX_CONTENT_CHARS * 2))])
    stored = AgentMessageLog(db=db).tail()[0]["content"]
    assert len(stored) == MAX_CONTENT_CHARS
    assert stored.endswith("[truncated]")


def test_invalid_rows_are_skipped(log):
    written = log.append([
        {"created_at": 100, "status": "queued", "content": "no uid"},
        {"uid": "a:2", "status": "queued", "content": "no created_at"},
        {"uid": "a:3", "created_at": "not a number", "status": "queued", "content": "x"},
        # json.loads accepts the non-standard `Infinity` literal and int()
        # raises OverflowError on it — that must skip one row, not the batch.
        {"uid": "a:4", "created_at": float("inf"), "status": "queued", "content": "x"},
        {"uid": "a:5", "created_at": 100, "content": "no status"},
        {"uid": "a:6", "created_at": 100, "status": "queued"},
        "not a dict",
        _row("a:7", 700),
    ])
    assert written == 1
    assert [r["uid"] for r in log.tail()] == ["a:7"]


def test_unknown_status_on_append_becomes_failed(log):
    log.append([_row("a:1", 100, status="weird")])
    assert log.tail()[0]["status"] == "failed"


def test_optional_columns_round_trip(tmp_path):
    db = Database(tmp_path / "navide.db")
    AgentMessageLog(db=db).append([
        _row(
            "a:1",
            100,
            status="failed",
            reason="rate limit",
            delivered_at=150,
            remote="outbound",
            remote_workspace="/ws/beta",
        )
    ])
    row = AgentMessageLog(db=db).tail()[0]
    assert row["reason"] == "rate limit"
    assert row["delivered_at"] == 150
    assert row["remote"] == "outbound"
    assert row["remote_workspace"] == "/ws/beta"


def _boom():
    raise sqlite3.OperationalError("disk I/O error")


def test_append_failure_is_swallowed_and_nothing_is_persisted(log, monkeypatch, caplog):
    """A failed write is logged and reported as 0 rows — and tail() says the
    same thing, cold or warm, because there is nowhere else for it to live."""
    log.append([_row("a:1", 100)])

    monkeypatch.setattr(log._db, "transaction", _boom)
    with caplog.at_level("WARNING"):
        assert log.append([_row("a:2", 200)]) == 0
    monkeypatch.undo()

    assert [r["uid"] for r in log.tail()] == ["a:1"]
    assert [r["uid"] for r in AgentMessageLog(db=log._db).tail()] == ["a:1"]
    assert any("agent message log append failed" in r.message for r in caplog.records)


def test_update_failure_is_swallowed_and_leaves_the_row_untouched(log, monkeypatch, caplog):
    log.append([_row("a:1", 100, status="queued"), _row("a:2", 200, status="queued")])

    monkeypatch.setattr(log._db, "transaction", _boom)
    with caplog.at_level("WARNING"):
        assert log.update([
            {"uid": "a:1", "status": "delivered"},
            {"uid": "a:2", "status": "failed"},
        ]) == 0
    monkeypatch.undo()

    assert [r["status"] for r in AgentMessageLog(db=log._db).tail()] == ["queued", "queued"]
    assert any("agent message log update failed" in r.message for r in caplog.records)


def test_clear_failure_is_swallowed_and_leaves_the_rows_in_place(log, monkeypatch, caplog):
    log.append([_row("a:1", 100, status="queued"), _row("a:2", 200, status="delivered")])

    monkeypatch.setattr(log._db, "transaction", _boom)
    with caplog.at_level("WARNING"):
        assert log.clear() == 0
    monkeypatch.undo()

    assert [r["uid"] for r in AgentMessageLog(db=log._db).tail()] == ["a:1", "a:2"]
    assert any("agent message log clear failed" in r.message for r in caplog.records)


def test_a_fresh_database_migrates_straight_to_the_current_schema(tmp_path):
    db = Database(tmp_path / "navide.db")
    AgentMessageLog(db=db)
    assert db.schema_version("agent_message_log") == 6
    with db.transaction() as cur:
        columns = {
            r["name"] for r in cur.execute("PRAGMA table_info(agent_message_log)").fetchall()
        }
    assert {
        "seq",
        "sender_agent",
        "recipient_agent",
        "kind",
        "reply_to",
        "correlation_id",
    } <= columns


def test_an_existing_v1_database_upgrades_and_backfills_seq(tmp_path):
    db = Database(tmp_path / "navide.db")
    db.migrate("agent_message_log", 1, _create_schema)
    with db.transaction() as cur:
        for uid, created_at in (("a3f9:2", 100), ("a3f9:1", 100), ("a3f9:10", 50)):
            cur.execute(
                "INSERT INTO agent_message_log"
                " (uid, created_at, status, sender, recipient, content)"
                " VALUES (?, ?, 'delivered', 's', 'r', 'x')",
                (uid, created_at),
            )

    store = AgentMessageLog(db=db)
    assert db.schema_version("agent_message_log") == 6
    with db.transaction() as cur:
        seqs = {
            r["uid"]: r["seq"]
            for r in cur.execute("SELECT uid, seq FROM agent_message_log").fetchall()
        }
    assert seqs == {"a3f9:10": 1, "a3f9:1": 2, "a3f9:2": 3}

    # New rows continue the counter instead of colliding with the backfill.
    store.append([_row("a3f9:11", 100)])
    assert [r["uid"] for r in AgentMessageLog(db=db).tail()] == [
        "a3f9:10", "a3f9:1", "a3f9:2", "a3f9:11",
    ]


def test_rows_written_before_v3_keep_no_vendor(tmp_path):
    """The vendor columns are additive: a pre-v3 row still reads back, with both
    sides unknown rather than guessed from whatever runs under that name now."""
    db = Database(tmp_path / "navide.db")
    db.migrate("agent_message_log", 1, _create_schema)
    with db.transaction() as cur:
        cur.execute(
            "INSERT INTO agent_message_log"
            " (uid, created_at, status, sender, recipient, content)"
            " VALUES ('old:1', 100, 'delivered', 'alpha', 'beta', 'x')"
        )

    store = AgentMessageLog(db=db)
    rows = store.tail()

    assert len(rows) == 1
    assert rows[0]["sender_agent"] is None
    assert rows[0]["recipient_agent"] is None


def test_vendors_round_trip(tmp_path):
    store = AgentMessageLog(db=Database(tmp_path / "navide.db"))
    store.append([_row("a:1", 100) | {"sender_agent": "claude", "recipient_agent": "codex"}])

    row = store.tail()[0]

    assert row["sender_agent"] == "claude"
    assert row["recipient_agent"] == "codex"


def test_kind_round_trips_and_defaults_to_null(tmp_path):
    """A row survives a restart knowing whether Navide or an agent wrote it."""
    db = Database(tmp_path / "navide.db")
    AgentMessageLog(db=db).append([
        _row("a:1", 100) | {"kind": "notice"},
        _row("a:2", 200),
    ])

    rows = {r["uid"]: r for r in AgentMessageLog(db=db).tail()}

    assert rows["a:1"]["kind"] == "notice"
    assert rows["a:2"]["kind"] is None


def test_an_ack_kind_survives_rather_than_degrading(log):
    """An "ack" row is logged and never injected, so the panel has to be able to
    tell it apart from an ordinary message after a reload."""
    log.append([_row("a:1", 100) | {"kind": "ack"}, _row("a:2", 200)])

    assert [r["kind"] for r in log.tail()] == ["ack", None]


def test_an_unrecognized_kind_is_stored_as_an_ordinary_message(log):
    """The panel reads `kind` to decide what a row is, so an unknown value
    degrades to NULL rather than reaching the UI."""
    log.append([_row("a:1", 100) | {"kind": "spawn-feedback"}, _row("a:2", 200) | {"kind": 7}])

    assert [r["kind"] for r in log.tail()] == [None, None]


def test_rows_written_before_v4_have_no_kind(tmp_path):
    """Additive, like the vendor columns: a pre-v4 row reads back as an ordinary
    message, which is what every one of them is — the notice did not exist."""
    db = Database(tmp_path / "navide.db")
    db.migrate("agent_message_log", 1, _create_schema)
    with db.transaction() as cur:
        cur.execute(
            "INSERT INTO agent_message_log"
            " (uid, created_at, status, sender, recipient, content)"
            " VALUES ('old:1', 100, 'delivered', 'alpha', 'beta', 'x')"
        )

    rows = AgentMessageLog(db=db).tail()

    assert len(rows) == 1
    assert rows[0]["kind"] is None
    assert rows[0]["content"] == "x"


def test_a_live_v3_database_upgrades_in_place_without_losing_anything(tmp_path):
    """The upgrade every existing install actually performs.

    The shipped schema is v3, so this is the step a user's own navide.db takes:
    rows already there must survive untouched, keep their seq order, and read
    back with the new column empty.
    """
    db = Database(tmp_path / "navide.db")
    db.migrate("agent_message_log", 1, _create_schema)
    db.migrate("agent_message_log", 2, _add_seq)
    db.migrate("agent_message_log", 3, _add_agent_keys)
    with db.transaction() as cur:
        for seq, (uid, created_at) in enumerate(((("v3:1"), 100), (("v3:2"), 200)), start=1):
            cur.execute(
                "INSERT INTO agent_message_log"
                " (uid, created_at, status, sender, recipient, content, seq, sender_agent)"
                " VALUES (?, ?, 'delivered', 'alpha', 'beta', ?, ?, 'claude')",
                (uid, created_at, f"kept {uid}", seq),
            )

    store = AgentMessageLog(db=db)
    rows = store.tail()

    assert db.schema_version("agent_message_log") == 6
    assert [r["uid"] for r in rows] == ["v3:1", "v3:2"]
    assert [r["content"] for r in rows] == ["kept v3:1", "kept v3:2"]
    assert [r["sender_agent"] for r in rows] == ["claude", "claude"]
    assert [r["kind"] for r in rows] == [None, None]

    # And the counter continues from the pre-upgrade rows rather than colliding.
    store.append([_row("v4:1", 300) | {"kind": "notice"}])
    assert [r["uid"] for r in AgentMessageLog(db=db).tail()] == ["v3:1", "v3:2", "v4:1"]


def test_reopening_an_upgraded_database_does_not_rerun_the_column_step(tmp_path):
    """ALTER TABLE ADD COLUMN would raise "duplicate column name" on a second
    run; the version gate is what makes construction idempotent."""
    db = Database(tmp_path / "navide.db")
    AgentMessageLog(db=db).append([_row("a:1", 100) | {"kind": "notice"}])

    reopened = AgentMessageLog(db=db)  # must not raise

    assert db.schema_version("agent_message_log") == 6
    assert [r["kind"] for r in reopened.tail()] == ["notice"]


# ── v5: threading (reply_to / correlation_id) ──────────────────────────────


def test_threading_columns_round_trip_and_default_to_null(tmp_path):
    """A restart must not cost a message its thread.

    Before v5 both values lived only in renderer memory, which is why an agent
    reading its own mail over MCP could see neither what a message answered nor
    the id its sender knows it by.
    """
    db = Database(tmp_path / "navide.db")
    AgentMessageLog(db=db).append([
        _row("a:1", 100) | {"correlation_id": "pa:mcp:beef"},
        _row("a:2", 200) | {"reply_to": "a:1", "correlation_id": "pb:7"},
        _row("a:3", 300),
    ])

    rows = {r["uid"]: r for r in AgentMessageLog(db=db).tail()}

    assert rows["a:1"]["correlation_id"] == "pa:mcp:beef"
    assert rows["a:1"]["reply_to"] is None
    assert rows["a:2"]["reply_to"] == "a:1"
    assert rows["a:2"]["correlation_id"] == "pb:7"
    # A message between two panes of one window is never routed, so it is named
    # by nothing but its own uid. Both columns must stay empty rather than be
    # invented.
    assert rows["a:3"]["reply_to"] is None
    assert rows["a:3"]["correlation_id"] is None


def test_pending_incoming_carries_the_threading_through(log):
    """The recipient's own view is the one that had neither field."""
    log.append([
        _row("a:1", 100, status="queued", recipient="me") | {
            "correlation_id": "pa:mcp:beef",
            "reply_to": "earlier:1",
        },
    ])

    rows = log.pending_incoming("me")

    assert rows[0]["correlation_id"] == "pa:mcp:beef"
    assert rows[0]["reply_to"] == "earlier:1"


def test_incoming_carries_the_threading_through(log):
    """``incoming`` selects an explicit column list, so a new column reaches it
    only by being named there — the degraded read in cli_read_incoming is what
    falls back to this, and it must not lose the thread."""
    log.append([
        _row("a:1", 100, status="queued", recipient="me") | {
            "correlation_id": "pa:mcp:beef",
            "reply_to": "earlier:1",
        },
    ])

    rows = log.incoming("me")

    assert rows[0]["correlation_id"] == "pa:mcp:beef"
    assert rows[0]["reply_to"] == "earlier:1"


def test_rows_written_before_v5_have_no_threading(tmp_path):
    """Additive, like every column step before it. Nothing can be backfilled:
    neither value was ever persisted, so a pre-v5 reply's link is simply gone,
    and NULL says that instead of guessing."""
    db = Database(tmp_path / "navide.db")
    db.migrate("agent_message_log", 1, _create_schema)
    db.migrate("agent_message_log", 2, _add_seq)
    db.migrate("agent_message_log", 3, _add_agent_keys)
    db.migrate("agent_message_log", 4, _add_kind)
    with db.transaction() as cur:
        cur.execute(
            "INSERT INTO agent_message_log"
            " (uid, created_at, status, sender, recipient, content, seq, kind)"
            " VALUES ('v4:1', 100, 'queued', 'alpha', 'beta', 'kept', 1, 'notice')"
        )

    store = AgentMessageLog(db=db)
    rows = store.tail()

    assert db.schema_version("agent_message_log") == 6
    assert [r["uid"] for r in rows] == ["v4:1"]
    assert rows[0]["content"] == "kept"
    assert rows[0]["kind"] == "notice"
    assert rows[0]["reply_to"] is None
    assert rows[0]["correlation_id"] is None

    # The counter continues from the pre-upgrade row rather than colliding.
    store.append([_row("v5:1", 200) | {"correlation_id": "pa:mcp:beef"}])
    assert [r["uid"] for r in AgentMessageLog(db=db).tail()] == ["v4:1", "v5:1"]


def test_a_non_text_threading_value_stores_as_null(log):
    """Same rule the other optional columns follow: anything unusable degrades
    to "not set" rather than reaching a caller as a made-up id."""
    log.append([_row("a:1", 100) | {"reply_to": "", "correlation_id": None}])

    row = log.tail()[0]

    assert row["reply_to"] is None
    assert row["correlation_id"] is None


# ── pending_incoming: the recipient's view of the queue ─────────────────────


def test_pending_incoming_returns_only_undelivered_messages_for_that_recipient(log):
    log.append(
        [
            _row("a", 1000, recipient="me", status="queued"),
            _row("b", 2000, recipient="me", status="delivering"),
            _row("c", 3000, recipient="me", status="delivered"),
            _row("d", 4000, recipient="me", status="failed"),
            _row("e", 5000, recipient="someone-else", status="queued"),
        ]
    )
    assert [r["uid"] for r in log.pending_incoming("me")] == ["a", "b"]


def test_pending_incoming_is_oldest_first(log):
    log.append(
        [
            _row("old", 1000, recipient="me", status="queued"),
            _row("new", 9000, recipient="me", status="queued"),
        ]
    )
    assert [r["uid"] for r in log.pending_incoming("me")] == ["old", "new"]


def test_pending_incoming_limit_keeps_the_newest(log):
    log.append([_row(str(i), 1000 + i, recipient="me", status="queued") for i in range(5)])
    assert [r["uid"] for r in log.pending_incoming("me", limit=2)] == ["3", "4"]


def test_pending_incoming_matches_the_name_exactly(log):
    # A pane renamed since a message was queued reports nothing rather than
    # someone else's mail.
    log.append([_row("a", 1000, recipient="reviewer", status="queued")])
    assert log.pending_incoming("review") == []
    assert log.pending_incoming("reviewer-2") == []
    assert [r["uid"] for r in log.pending_incoming("reviewer")] == ["a"]


def test_pending_incoming_carries_the_kind_through(log):
    log.append(
        [
            _row("n", 1000, recipient="me", status="queued", kind="notice"),
            _row("f", 2000, recipient="me", status="queued", kind="fallback"),
            _row("p", 3000, recipient="me", status="queued"),
        ]
    )
    rows = {r["uid"]: r["kind"] for r in log.pending_incoming("me")}
    assert rows == {"n": "notice", "f": "fallback", "p": None}


def test_pending_incoming_ignores_an_empty_recipient(log):
    log.append([_row("a", 1000, recipient="", status="queued")])
    assert log.pending_incoming("") == []


def test_pending_incoming_survives_a_broken_database(tmp_path):
    broken = AgentMessageLog(db=Database(tmp_path / "navide.db"))
    broken.append([_row("a", 1000, recipient="me", status="queued")])
    with broken._db.transaction() as cur:
        cur.execute("DROP TABLE agent_message_log")
    assert broken.pending_incoming("me") == []


# ── incoming: the recipient reading its own mail in full ────────────────────


# What the MCP layer does to a body to build cli_pending_incoming's `excerpt`:
# collapse every run of whitespace, then keep the first 200 characters.
_EXCERPT_CHARS = 200


def _as_excerpt(content: str) -> str:
    return "".join(list(" ".join(content.split()))[:_EXCERPT_CHARS])


def test_incoming_returns_the_whole_body_where_an_excerpt_would_cut_it(log):
    body = "".join(f"line {i} of a long report. " for i in range(60))
    assert len(body) > _EXCERPT_CHARS  # otherwise this proves nothing
    log.append([_row("a", 1000, recipient="me", status="queued", content=body)])

    full = log.incoming("me")[0]["content"]

    assert full == body
    # The same row seen through the excerpt rule loses everything past 200
    # characters — that loss is what this method exists to undo.
    assert len(_as_excerpt(log.pending_incoming("me")[0]["content"])) == _EXCERPT_CHARS
    assert len(full) > _EXCERPT_CHARS


def test_incoming_preserves_whitespace_and_newlines(log):
    body = "step one\n\n    indented\tblock\n\nstep two\n"
    log.append([_row("a", 1000, recipient="me", status="queued", content=body)])

    full = log.incoming("me")[0]["content"]

    assert full == body
    # The excerpt rule flattens all of that into one line; this must not.
    assert "\n" in full
    assert "    indented\tblock" in full
    assert _as_excerpt(body) != body


def test_incoming_round_trips_cjk_content(log):
    body = "審查結果：第三段落需要重寫。\n理由：語意與程式碼不符。"
    log.append([_row("a", 1000, recipient="me", status="queued", content=body)])

    row = log.incoming("me")[0]

    assert row["content"] == body
    assert len(row["content"]) == len(body)  # characters, not bytes


def test_incoming_hides_delivered_history_until_asked(log):
    log.append(
        [
            _row("q", 1000, recipient="me", status="queued"),
            _row("d", 2000, recipient="me", status="delivered"),
        ]
    )

    assert [r["uid"] for r in log.incoming("me")] == ["q"]
    assert [r["uid"] for r in log.incoming("me", include_delivered=True)] == ["q", "d"]


def test_incoming_never_returns_a_message_that_was_not_put_in_front_of_you(log):
    """`failed` and `cancelled` stay out even with history on: one never
    arrived, the other the sender took back."""
    log.append(
        [
            _row("f", 1000, recipient="me", status="failed"),
            _row("c", 2000, recipient="me", status="cancelled"),
            _row("g", 3000, recipient="me", status="delivered"),
        ]
    )

    assert [r["uid"] for r in log.incoming("me", include_delivered=True)] == ["g"]


def test_incoming_returns_only_this_recipients_mail(log):
    log.append(
        [
            _row("mine", 1000, recipient="me", status="queued", content="for me"),
            _row("theirs", 2000, recipient="you", status="queued", content="secret"),
        ]
    )

    rows = log.incoming("me", include_delivered=True)

    assert [r["uid"] for r in rows] == ["mine"]
    assert all("secret" not in r["content"] for r in rows)
    assert [r["uid"] for r in log.incoming("you")] == ["theirs"]


def test_incoming_limit_keeps_the_newest(log):
    log.append([_row(str(i), 1000 + i, recipient="me", status="queued") for i in range(5)])

    assert [r["uid"] for r in log.incoming("me", limit=2)] == ["3", "4"]


def test_incoming_is_oldest_first_and_breaks_created_at_ties_by_insertion(log):
    """A fan-out queued in one tick shares `created_at`, so `seq` is what keeps
    the reader's order the order they were sent in."""
    log.append(
        [
            _row("late", 9000, recipient="me", status="queued"),
            _row("early", 1000, recipient="me", status="queued"),
        ]
    )
    log.append([_row(f"tie-{i}", 5000, recipient="me", status="queued") for i in range(3)])

    assert [r["uid"] for r in log.incoming("me")] == [
        "early", "tie-0", "tie-1", "tie-2", "late",
    ]


def test_incoming_for_an_unknown_recipient_is_empty_not_an_error(log):
    log.append([_row("a", 1000, recipient="me", status="queued")])

    assert log.incoming("nobody") == []
    assert log.incoming("nobody", include_delivered=True) == []
    assert log.incoming("") == []


def test_incoming_carries_the_fields_a_caller_needs_to_tell_navide_from_a_peer(log):
    log.append(
        [
            _row("n", 1000, recipient="me", status="queued", kind="notice"),
            _row("p", 2000, recipient="me", status="queued", sender="alpha/claude-1"),
        ]
    )

    rows = {r["uid"]: r for r in log.incoming("me")}

    assert rows["n"]["kind"] == "notice"
    assert rows["p"]["kind"] is None
    assert rows["p"]["sender"] == "alpha/claude-1"
    assert rows["p"]["status"] == "queued"
    assert rows["p"]["created_at"] == 2000


def test_incoming_survives_a_broken_database(tmp_path):
    broken = AgentMessageLog(db=Database(tmp_path / "navide.db"))
    broken.append([_row("a", 1000, recipient="me", status="queued")])
    with broken._db.transaction() as cur:
        cur.execute("DROP TABLE agent_message_log")

    assert broken.incoming("me") == []


def test_rows_written_before_v6_belong_to_no_workspace(tmp_path):
    """Additive: a v5 row survives untouched and reads back unstamped (NULL),
    which the workspace-scoped plugin API treats as nobody's."""
    db = Database(tmp_path / "navide.db")
    for version, step in enumerate((_create_schema, _add_seq, _add_agent_keys, _add_kind, _add_threading), start=1):
        db.migrate("agent_message_log", version, step)
    with db.transaction() as cur:
        cur.execute(
            "INSERT INTO agent_message_log"
            " (uid, created_at, status, sender, recipient, content, seq)"
            " VALUES ('v5:1', 100, 'delivered', 'alpha', 'beta', 'kept', 1)"
        )

    rows = AgentMessageLog(db=db).tail()

    assert db.schema_version("agent_message_log") == 6
    assert rows[0]["content"] == "kept"
    assert rows[0]["sender_workspace"] is None and rows[0]["recipient_workspace"] is None
