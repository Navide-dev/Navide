"""Webhook trigger records: hashed keys, limits, audit, soft delete."""

import hashlib
import json
import sqlite3

import pytest

from agent_team_backend import webhook_triggers as wt
from agent_team_backend.db import Database


@pytest.fixture
def db(tmp_path):
    database = Database(tmp_path / "navide.db")
    yield database
    database.close()


@pytest.fixture
def store(db):
    return wt.WebhookStore(db)


def make(store, **over):
    args = {"name": "ci", "workspace": "/w", "pipeline_id": "p1", "kind": "webhook"}
    return store.create(**{**args, **over})


def test_defaults_are_off_and_the_agreed_limits(store):
    trigger, _ = make(store)
    assert trigger["enabled"] is False
    assert trigger["per_minute"] == 6 and trigger["per_day"] == 20
    assert trigger["no_gate_ack"] is False


def test_the_key_is_stored_only_as_a_hash(store, db):
    trigger, token = make(store)
    assert token.startswith("nvwh_") and len(token) >= 43
    with db.transaction() as cur:
        row = dict(cur.execute("SELECT * FROM webhook_triggers WHERE id = ?", (trigger["id"],)).fetchone())
    assert token not in json.dumps(row)
    assert row["token_hash"] == hashlib.sha256(token.encode()).hexdigest()


def test_no_public_answer_carries_the_hash(store):
    trigger, _ = make(store)
    assert "token_hash" not in trigger
    assert all("token_hash" not in t for t in store.list())


def test_the_id_is_128_bits_and_not_the_key(store):
    trigger, token = make(store)
    assert len(trigger["id"]) == 32 and int(trigger["id"], 16) >= 0
    assert trigger["id"] not in token


def test_verify_accepts_only_the_current_key(store):
    trigger, token = make(store)
    store.set_enabled(trigger["id"], True)
    record = store.snapshot()[trigger["id"]]
    assert wt.key_matches(record, token)
    assert not wt.key_matches(record, token + "x")
    assert not wt.key_matches(record, "")
    new = store.rotate(trigger["id"])
    record = store.snapshot()[trigger["id"]]
    assert new != token
    assert wt.key_matches(record, new) and not wt.key_matches(record, token)


@pytest.mark.parametrize(
    "over",
    [
        {"per_minute": 0}, {"per_minute": 61}, {"per_day": 0}, {"per_day": 501},
        {"kind": "stripe"}, {"name": ""}, {"workspace": ""}, {"pipeline_id": ""},
    ],
)
def test_bad_settings_are_refused(store, over):
    with pytest.raises(wt.WebhookInvalid):
        make(store, **over)


def test_the_agreed_ceilings_are_accepted(store):
    trigger, _ = make(store, per_minute=60, per_day=500)
    assert (trigger["per_minute"], trigger["per_day"]) == (60, 500)


def test_a_workspace_must_be_absolute(store):
    with pytest.raises(wt.WebhookInvalid):
        make(store, workspace="relative/path")


def test_snapshot_holds_only_enabled_live_triggers(store):
    off, _ = make(store)
    on, _ = make(store, name="on")
    gone, _ = make(store, name="gone")
    store.set_enabled(on["id"], True)
    store.set_enabled(gone["id"], True)
    store.delete(gone["id"])
    assert set(store.snapshot()) == {on["id"]}
    assert off["id"] not in store.snapshot()


def test_a_deleted_trigger_cannot_be_enabled_or_rotated(store):
    trigger, _ = make(store)
    store.delete(trigger["id"])
    assert store.list() == []
    with pytest.raises(wt.WebhookNotFound):
        store.set_enabled(trigger["id"], True)
    with pytest.raises(wt.WebhookNotFound):
        store.rotate(trigger["id"])


def test_a_pipeline_stays_bound_after_its_trigger_is_deleted(store):
    # A run started by this trigger can be resumed after the delete and must
    # stay tainted.
    trigger, _ = make(store, pipeline_id="bound")
    assert store.is_bound("bound") and not store.is_bound("other")
    store.delete(trigger["id"])
    assert store.is_bound("bound")


def test_a_deleted_trigger_keeps_no_usable_key(store, db):
    trigger, _ = make(store)
    store.delete(trigger["id"])
    with db.transaction() as cur:
        row = cur.execute("SELECT token_hash FROM webhook_triggers WHERE id = ?", (trigger["id"],)).fetchone()
    assert row["token_hash"] == ""


def test_the_day_count_survives_delete_and_recreate_of_usage(store):
    trigger, _ = make(store)
    assert store.count_run(trigger["id"], "2026-11-01") == 1
    assert store.count_run(trigger["id"], "2026-11-01") == 2
    assert store.count_run(trigger["id"], "2026-11-02") == 1
    store.delete(trigger["id"])
    assert store.runs_on(trigger["id"], "2026-11-01") == 2


def test_audit_rows_read_back_newest_first_and_survive_delete(store):
    trigger, _ = make(store)
    store.record_events([
        {"trigger_id": trigger["id"], "ts": 1, "outcome": "started", "status": 202, "size": 10, "body_sha256": "ab"},
        {"trigger_id": trigger["id"], "ts": 2, "outcome": "rate-limited", "status": 429, "count": 7},
    ])
    store.delete(trigger["id"])
    rows = store.events(trigger["id"])
    assert [r["outcome"] for r in rows] == ["rate-limited", "started"]
    assert rows[0]["count"] == 7 and rows[1]["body_sha256"] == "ab"


def test_audit_refuses_any_column_it_does_not_define(store):
    trigger, _ = make(store)
    with pytest.raises(wt.WebhookInvalid):
        store.record_events([{"trigger_id": trigger["id"], "ts": 1, "outcome": "x", "status": 1, "body": "text"}])


def test_audit_keeps_the_newest_rows_of_a_trigger(store):
    trigger, _ = make(store)
    rows = [{"trigger_id": trigger["id"], "ts": i, "outcome": "started", "status": 202} for i in range(wt.EVENTS_PER_TRIGGER + 5)]
    store.record_events(rows)
    kept = store.events(trigger["id"], limit=wt.EVENTS_PER_TRIGGER + 50)
    assert len(kept) == wt.EVENTS_PER_TRIGGER and kept[0]["ts"] == wt.EVENTS_PER_TRIGGER + 4


def test_listener_settings_default_off_and_port_unset(db):
    assert wt.listener_settings(db) == {"enabled": False, "port": 0, "public_host": ""}


def test_listener_settings_round_trip(db):
    wt.save_listener_settings(db, enabled=True, port=50123, public_host="hooks.example.com", now=1)
    assert wt.listener_settings(db) == {"enabled": True, "port": 50123, "public_host": "hooks.example.com"}


@pytest.mark.parametrize("host", ["http://x.com", "x.com/path", "x.com:443", "a b", "127.0.0.1", "localhost", "*.x.com"])
def test_a_public_host_is_a_bare_external_hostname(db, host):
    with pytest.raises(wt.WebhookInvalid):
        wt.save_listener_settings(db, enabled=True, port=1, public_host=host, now=1)


def test_the_schema_only_adds_tables(tmp_path):
    path = tmp_path / "navide.db"
    database = Database(path)
    database.kv_set("keep", {"a": 1}, now=1)
    with database.transaction() as cur:
        before = {r["name"]: r["sql"] for r in cur.execute("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL")}
    wt.WebhookStore(database)
    with database.transaction() as cur:
        after = {r["name"]: r["sql"] for r in cur.execute("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL")}
    assert {k: after[k] for k in before} == before
    assert {"webhook_triggers", "webhook_events", "webhook_usage"} <= set(after)
    assert database.kv_get("keep") == {"a": 1}
    database.close()
    assert sqlite3.connect(path).execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_a_database_from_before_run_sessions_gets_the_table(tmp_path) -> None:
    db = Database(tmp_path / "navide.db")
    db.migrate("webhook", 1, wt._create_schema)
    db.migrate("webhook", 2, wt._add_runs)
    db.migrate("webhook", 3, wt._add_github)
    db.migrate("webhook", 4, wt._add_forms)
    store = wt.WebhookStore(db)
    store.add_run_sessions(["s"], "claude", "r", False, "p")
    store.add_run_sessions(["s"], "claude", "other", True, "q")
    assert store.run_session("s") == ("r", False)
    assert store.run_session("unknown") is None
