"""SEC-4: a server replaying an older record must not roll an item back.

The server assigns revs, so it can hand any stored row back under a fresh
one. Each device now remembers the ``updatedAt`` of the copy it last agreed
on (``sync_state.synced_updated_at``, schema v3); a record older than that is
not applied and never deletes — it becomes a conflict, or, for a row naming
this device, is ignored.

The first five tests are the security review's repros (sec-review A F1, F1b,
F2, F3 and B-4), turned around to assert the safe outcome.
"""

from __future__ import annotations


from agent_team_backend import sync_engine
from agent_team_backend.db import Database

from .test_sync_engine import Device, FakeServer, account_key  # noqa: F401 - a fixture


def _replay(server: FakeServer, row: dict, *, device: str | None = None) -> int:
    """The server re-serves a stored row under a fresh rev."""
    rev = server.cursors.get("prompts", 0) + 1
    server.cursors["prompts"] = rev
    new = dict(row)
    new["rev"] = rev
    if device is not None:
        new["deviceId"] = device
    server.rows[("prompts", row["itemId"])] = new
    return rev


def _later(server: FakeServer) -> None:
    """Make the next write's updatedAt strictly later than the last one's.

    ``now_iso`` has one-second resolution, and two writes inside one second
    would carry the same stamp — which is not "older", so nothing is caught.
    """
    import time

    time.sleep(1.05)


async def test_an_old_body_replayed_as_an_unknown_device_is_not_applied(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"x": {"v": 1}})
    await a.sync()
    old = dict(server.rows[("prompts", "x")])
    _later(server)
    a.adapter.items["x"] = {"v": 2}
    await a.sync()
    b = Device(tmp_path, server, "dev-b")
    b.engine._signing_key_for = lambda d: "" if d == "dev-stranger" else b.own_key
    await b.sync()
    assert b.adapter.items == {"x": {"v": 2}}
    _replay(server, old, device="dev-stranger")
    await b.sync()
    assert b.adapter.items == {"x": {"v": 2}}
    assert b.store.conflict_ids("prompts") == {"x"}


async def test_the_author_is_not_rolled_back_either(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"x": {"v": 1}})
    a.engine._signing_key_for = lambda d: "" if d == "dev-stranger" else a.own_key
    await a.sync()
    old = dict(server.rows[("prompts", "x")])
    _later(server)
    a.adapter.items["x"] = {"v": 2}
    await a.sync()
    _replay(server, old, device="dev-stranger")
    await a.sync()
    assert a.adapter.items == {"x": {"v": 2}}


async def test_a_genuinely_signed_old_record_is_not_applied(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"x": {"v": 1}})
    await a.sync()
    old = dict(server.rows[("prompts", "x")])
    _later(server)
    a.adapter.items["x"] = {"v": 2}
    await a.sync()
    b = Device(tmp_path, server, "dev-b")
    await b.sync()
    assert b.adapter.items == {"x": {"v": 2}}
    _replay(server, old)  # dev-a's own, validly signed v1
    await b.sync()
    assert b.adapter.items == {"x": {"v": 2}}
    assert b.store.conflict_ids("prompts") == {"x"}


async def test_an_old_tombstone_replayed_over_a_recreated_item_asks(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"x": {"v": 1}})
    await a.sync()
    _later(server)
    a.adapter.items.pop("x")
    await a.sync()
    tomb = dict(server.rows[("prompts", "x")])
    assert tomb["deleted"] == 1 and tomb["sig"]
    _later(server)
    a.adapter.items["x"] = {"v": 3}
    await a.sync()
    b = Device(tmp_path, server, "dev-b")
    await b.sync()
    assert b.adapter.items == {"x": {"v": 3}}
    _replay(server, tomb)
    await b.sync()
    assert b.adapter.items == {"x": {"v": 3}}
    assert b.store.conflict_ids("prompts") == {"x"}


async def test_an_old_tombstone_replayed_to_a_device_that_saw_it_does_not_delete(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"x": {"v": 1}})
    b = Device(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()
    _later(server)
    a.adapter.items.pop("x")
    await a.sync()
    old_tomb = dict(server.rows[("prompts", "x")])
    await b.sync()
    _later(server)
    a.adapter.items["x"] = {"v": 2}
    await a.sync()
    await b.sync()
    assert b.adapter.items == {"x": {"v": 2}}
    _replay(server, old_tomb)
    await b.sync()
    assert b.adapter.items == {"x": {"v": 2}}
    assert not b.store.state("prompts", "x").deleted


async def test_an_old_record_of_this_device_replayed_to_it_changes_nothing(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"x": {"v": 1}})
    await a.sync()
    _later(server)
    a.adapter.items.pop("x")
    await a.sync()
    tomb = dict(server.rows[("prompts", "x")])
    _later(server)
    a.adapter.items["x"] = {"v": 2}
    await a.sync()
    before = a.store.state("prompts", "x")
    _replay(server, tomb)  # our own old tombstone, our own valid signature
    await a.sync()
    assert a.adapter.items == {"x": {"v": 2}}
    assert not a.store.state("prompts", "x").deleted
    assert a.store.state("prompts", "x").synced_updated_at == before.synced_updated_at


async def test_a_newer_record_still_lands(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"x": {"v": 1}})
    b = Device(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()
    _later(server)
    a.adapter.items["x"] = {"v": 2}
    await a.sync()
    await b.sync()
    assert b.adapter.items == {"x": {"v": 2}}
    assert b.store.conflict_ids("prompts") == set()
    assert b.store.state("prompts", "x").synced_updated_at == server.rows[("prompts", "x")]["updatedAt"]


# ── schema v3 ────────────────────────────────────────────────────────────────
def _v2_database(path) -> None:
    """A sync database exactly as schema v2 left it, with rows in it."""
    db = Database(path)
    db.migrate("sync", 1, sync_engine._create_schema)
    db.migrate("sync", 2, sync_engine._schema_v2)
    with db.transaction() as cur:
        cur.execute(
            "INSERT INTO sync_state (scope, item_id, rev, synced_hash, deleted, sealed_kid)"
            " VALUES ('prompts', 'x', 7, 'h', 0, 'k1')"
        )
        cur.execute("INSERT INTO sync_cursor (scope, cursor) VALUES ('prompts', 7)")


def test_a_v2_database_upgrades_in_place_and_keeps_its_rows(tmp_path):
    path = tmp_path / "v2.db"
    _v2_database(path)
    store = sync_engine.SyncStore(Database(path))
    assert store.state("prompts", "x") == sync_engine.ItemState(
        rev=7, synced_hash="h", deleted=False, sealed_kid="k1", synced_updated_at=""
    )
    assert store.cursor("prompts") == 7
    # Opening it again is a no-op, not a second ALTER.
    again = sync_engine.SyncStore(Database(path))
    assert again.state("prompts", "x").rev == 7


def test_the_v3_step_tolerates_a_column_that_is_already_there(tmp_path):
    path = tmp_path / "v2plus.db"
    _v2_database(path)
    # Through Database, not a raw sqlite3 connection: a raw one runs in DELETE
    # journal mode, and on Windows deleting -journal fails with "disk I/O error"
    # while a scanner holds it (the reason Database uses TRUNCATE).
    db = Database(path)
    with db.transaction() as cur:
        cur.execute("ALTER TABLE sync_state ADD COLUMN synced_updated_at TEXT NOT NULL DEFAULT ''")
    db.close()
    store = sync_engine.SyncStore(Database(path))
    assert store.state("prompts", "x").synced_updated_at == ""


def test_the_agreed_updated_at_only_moves_forward(tmp_path):
    store = sync_engine.SyncStore(Database(tmp_path / "m.db"))
    later, earlier = "2030-01-02T00:00:00+00:00", "2030-01-01T00:00:00+00:00"
    store.set_state("prompts", "x", rev=1, synced_hash="h", deleted=False, synced_updated_at=later)
    store.set_state("prompts", "x", rev=2, synced_hash="h2", deleted=False, synced_updated_at=earlier)
    store.set_state("prompts", "x", rev=3, synced_hash="h3", deleted=False)
    assert store.state("prompts", "x").synced_updated_at == later
    assert store.state("prompts", "x").rev == 3
