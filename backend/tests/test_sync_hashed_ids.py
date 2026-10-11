"""Sync protocol v3, phase 2 (D3): hashed item ids.

Once the account adopts them the server knows every live item by
``h1.`` + HMAC(scope, name) and never sees a name; the name rides inside the
ciphertext. Driven against ``V3Server`` / ``FakeS3`` of test_sync_s3_objects.
"""

from __future__ import annotations

import json

import pytest

from agent_team_backend import device_signing, sync_engine, sync_keyring
from tests.test_sync_s3_objects import HASHED, V3Device, V3Server, account_key, s3  # noqa: F401 - fixtures

NAMES = {"alpha-secret-name": {"v": "alpha"}, "beta-secret-name": {"v": "beta"}}


def _live(server: V3Server, scope: str = "prompts") -> dict[str, dict]:
    return {k[1]: r for k, r in server.rows.items() if k[0] == scope and not r["deleted"]}


async def test_after_adoption_the_server_never_sees_a_name(tmp_path, account_key, s3):
    server = V3Server(s3, adopt_ready=True)
    a = V3Device(tmp_path, server, "A", dict(NAMES))
    assert (await a.sync())["ok"] is True
    assert server.item_ids == "hmac" and server.item_id_kid == sync_keyring.active_key_id()
    live = _live(server)
    assert len(live) == 2 and all(HASHED.match(i) for i in live)
    stored = json.dumps([list(server.rows), list(server.rows.values()), server.wire, sorted(s3.objects)], default=str)
    for name in NAMES:
        assert name not in stored
    # The name is inside the ciphertext, under the wrapper, bound to the h1 id.
    item_id, row = next(iter(live.items()))
    sealed = s3.objects[row["objectRef"]["blobId"]].decode("utf-8")
    doc = json.loads(sync_keyring.decrypt(sealed, scope="prompts", item_id=item_id))
    assert doc["v"] == 1 and sync_keyring.hashed_item_id("prompts", doc["name"], server.item_id_kid) == item_id
    assert doc["payload"] == NAMES[doc["name"]]
    b = V3Device(tmp_path, server, "B")
    assert (await b.sync())["ok"] is True
    assert b.adapter.items == NAMES
    # Bookkeeping stays by name.
    assert set(b.store.states("prompts")) == set(NAMES)
    assert all(HASHED.match(s.wire_id) for s in b.store.states("prompts").values())


async def test_an_account_that_is_not_ready_keeps_legacy_ids(tmp_path, account_key, s3):
    server = V3Server(s3, adopt_ready=False)
    a = V3Device(tmp_path, server, "A", dict(NAMES))
    assert (await a.sync())["ok"] is True
    a.adapter.items["gamma"] = {"v": 3}
    assert (await a.sync())["ok"] is True
    assert set(_live(server)) == set(NAMES) | {"gamma"}
    assert server.types("A").count("sync.adoptHmacIds") == 1  # once per connection
    b = V3Device(tmp_path, server, "B")
    await b.sync()
    assert b.adapter.items == a.adapter.items


async def _legacy_then_adopted(tmp_path, s3):
    server = V3Server(s3, adopt_ready=False)
    a = V3Device(tmp_path, server, "A", dict(NAMES))
    b = V3Device(tmp_path, server, "B")
    await a.sync()
    await b.sync()
    assert b.adapter.items == NAMES
    legacy_revs = {n: server.rows[("prompts", n)]["rev"] for n in NAMES}
    server.adopt_ready = True
    a.reconnect()
    calls = len(server.calls)
    assert (await a.sync())["ok"] is True
    return server, a, b, legacy_revs, server.calls[calls:]


async def test_migration_sends_the_hashed_copy_and_the_legacy_tombstone_in_one_batch(tmp_path, account_key, s3):
    server, a, _b, legacy_revs, calls = await _legacy_then_adopted(tmp_path, s3)
    pushes = [p for _d, t, p in calls if t == "sync.push"]
    assert len(pushes) == 1
    items = pushes[0]["items"]
    for name in NAMES:
        h1 = sync_keyring.hashed_item_id("prompts", name, server.item_id_kid)
        head = next(i for i, item in enumerate(items) if item["itemId"] == h1)
        tomb = next(i for i, item in enumerate(items) if item["itemId"] == name)
        assert tomb == head + 1
        assert items[head]["baseRev"] == 0 and items[head]["deleted"] == 0 and "objectRef" in items[head]
        assert items[tomb]["baseRev"] == legacy_revs[name] and items[tomb]["deleted"] == 1
        state = a.store.state("prompts", name)
        assert state.wire_id == h1 and state.rev == server.rows[("prompts", h1)]["rev"]
    assert all(HASHED.match(i) for i in _live(server))
    pushes_before = server.pushes
    assert (await a.sync())["ok"] is True
    assert server.pushes == pushes_before  # migrated once, nothing left to send


async def test_another_device_reads_the_migration_as_a_rename(tmp_path, account_key, s3):
    server, _a, b, _revs, _calls = await _legacy_then_adopted(tmp_path, s3)
    b.reconnect()
    assert (await b.sync())["ok"] is True
    assert b.adapter.items == NAMES
    assert b.store.conflicts("prompts") == []
    assert all(HASHED.match(s.wire_id) for s in b.store.states("prompts").values())
    # And edits from there on go up under the hashed id, from the right rev.
    b.adapter.items["alpha-secret-name"] = {"v": "edited"}
    assert (await b.sync())["ok"] is True
    h1 = sync_keyring.hashed_item_id("prompts", "alpha-secret-name", server.item_id_kid)
    assert server.wire[-1]["itemId"] == h1 and b.store.conflicts("prompts") == []


async def test_a_device_on_the_old_connection_catches_up_on_the_next_round(tmp_path, account_key, s3):
    server, _a, b, _revs, _calls = await _legacy_then_adopted(tmp_path, s3)
    # B's connection negotiated "legacy" before A adopted: its first round
    # meets a hashed row it cannot name yet and fails; the next one asks again.
    first = await b.sync()
    assert first["ok"] is False
    assert (await b.sync())["ok"] is True
    assert b.adapter.items == NAMES


async def test_a_local_delete_of_a_legacy_item_is_a_legacy_tombstone(tmp_path, account_key, s3):
    server = V3Server(s3, adopt_ready=False)
    a = V3Device(tmp_path, server, "A", dict(NAMES))
    await a.sync()
    a.adapter.items.pop("alpha-secret-name")
    server.adopt_ready = True
    a.reconnect()
    assert (await a.sync())["ok"] is True
    assert server.rows[("prompts", "alpha-secret-name")]["deleted"] == 1
    live = _live(server)
    assert len(live) == 1 and all(HASHED.match(i) for i in live)


async def test_a_delete_of_a_hashed_item_reaches_the_other_device(tmp_path, account_key, s3):
    server = V3Server(s3, adopt_ready=True)
    a = V3Device(tmp_path, server, "A", dict(NAMES))
    b = V3Device(tmp_path, server, "B")
    await a.sync()
    await b.sync()
    a.adapter.items.pop("alpha-secret-name")
    await a.sync()
    assert all(HASHED.match(i["itemId"]) for i in server.wire)
    await b.sync()
    assert b.adapter.items == {"beta-secret-name": {"v": "beta"}}


async def test_a_conflict_on_a_hashed_item_is_kept_by_name_and_resolves(tmp_path, account_key, s3):
    server = V3Server(s3, adopt_ready=True)
    a = V3Device(tmp_path, server, "A", dict(NAMES))
    b = V3Device(tmp_path, server, "B")
    await a.sync()
    await b.sync()
    a.adapter.items["alpha-secret-name"] = {"v": "a"}
    await a.sync()
    b.adapter.items["alpha-secret-name"] = {"v": "b"}
    await b.sync()
    (row,) = b.store.conflicts("prompts")
    assert row["itemId"] == "alpha-secret-name" and row["remote"] == {"v": "a"}
    b.engine.resolve("prompts", "alpha-secret-name", sync_engine.KEEP_LOCAL)
    assert (await b.sync())["ok"] is True
    await a.sync()
    assert a.adapter.items["alpha-secret-name"] == {"v": "b"}
    assert a.store.conflicts("prompts") == [] and b.store.conflicts("prompts") == []


async def test_inventory_lists_hashed_items_by_name(tmp_path, account_key, s3):
    server = V3Server(s3, adopt_ready=True)
    a = V3Device(tmp_path, server, "A", dict(NAMES))
    await a.sync()
    b = V3Device(tmp_path, server, "B", {"alpha-secret-name": {"v": "alpha"}})
    listing = await b.engine.inventory("prompts")
    assert [(i["itemId"], i["state"]) for i in listing["items"]] == [
        ("alpha-secret-name", "in-sync"), ("beta-secret-name", "remote-only"),
    ]
    assert (await b.engine.pull_items("prompts", ["beta-secret-name"]))[0]["result"] == "pulled"
    assert b.adapter.items == NAMES


async def test_a_record_whose_name_does_not_match_its_id_is_refused(tmp_path, account_key, s3):
    server = V3Server(s3, adopt_ready=True)
    a = V3Device(tmp_path, server, "A", dict(NAMES))
    await a.sync()
    # The server moves alpha's sealed record under beta's id: it does not
    # open there (AEAD binds the id). Sealed for beta's id but naming alpha
    # inside is what a forged wrapper looks like.
    kid = server.item_id_kid
    beta = sync_keyring.hashed_item_id("prompts", "beta-secret-name", kid)
    forged = sync_keyring.encrypt(
        sync_engine.canonical({"v": 1, "name": "alpha-secret-name", "payload": {"v": "evil"}}),
        scope="prompts", item_id=beta,
    )
    row = server.rows[("prompts", beta)]
    row.pop("objectRef", None)
    row["body"] = forged
    # Signed as A would sign it: the wrapper, not the signature, must catch it.
    row["sig"] = device_signing.sign_sync(
        scope="prompts", item_id=beta, updated_at=row["updatedAt"], deleted=False, body=forged
    )
    b = V3Device(tmp_path, server, "B")
    assert (await b.sync())["ok"] is True
    assert b.adapter.items == {"alpha-secret-name": {"v": "alpha"}}


# ── c3: the item-id key must be held ────────────────────────────────────────
async def test_a_missing_item_id_key_stops_every_push(tmp_path, account_key, s3):
    server = V3Server(s3, item_ids="hmac")
    server.item_id_kid = "00" * 8  # a key this ring never held
    a = V3Device(tmp_path, server, "A", dict(NAMES))
    result = await a.sync()
    assert result["ok"] is False and "ITEM_ID_KEY_MISSING" in result["error"]
    assert "sync.push" not in server.types() and not [t for t in server.types() if t.startswith("blobs.")]
    with pytest.raises(sync_engine.SyncError) as err:
        await a.engine.push_items("prompts", list(NAMES))
    assert err.value.code == "ITEM_ID_KEY_MISSING"
    assert "sync.push" not in server.types()


async def test_a_missing_item_id_key_stops_the_migration_too(tmp_path, account_key, s3):
    server = V3Server(s3, adopt_ready=False)
    a = V3Device(tmp_path, server, "A", dict(NAMES))
    await a.sync()
    pushes = server.pushes
    server.item_ids, server.item_id_kid = "hmac", "00" * 8
    a.reconnect()
    result = await a.sync()
    assert "ITEM_ID_KEY_MISSING" in result["error"]
    assert server.pushes == pushes
    assert {k[1] for k in server.rows} == set(NAMES)


# ── D4 × D3: account switch keeps the wire ids ──────────────────────────────
async def test_switching_accounts_and_back_resends_nothing(tmp_path, account_key, s3):
    server = V3Server(s3, adopt_ready=True)
    a = V3Device(tmp_path, server, "A", dict(NAMES))
    a.store.adopt_account("acct-1")
    await a.sync()
    pushes = server.pushes
    a.store.switch_account("acct-1", "acct-2")
    assert a.store.states("prompts") == {}
    a.store.switch_account("acct-2", "acct-1")
    assert all(HASHED.match(s.wire_id) for s in a.store.states("prompts").values())
    a.reconnect()
    assert (await a.sync())["ok"] is True
    assert server.pushes == pushes and a.store.conflicts("prompts") == []


def test_the_wire_id_columns_are_added_once_and_kept(tmp_path):
    from agent_team_backend.db import Database

    path = tmp_path / "s.db"
    store = sync_engine.SyncStore(Database(path))
    # A numbered step, so a later build knows it ran.
    assert store._db.schema_version("sync") >= 5  # noqa: SLF001
    store.set_state("prompts", "p", rev=1, synced_hash="h", deleted=False, wire_id="h1." + "a" * 64)
    # A legacy-id write never erases the hashed id.
    store.set_state("prompts", "p", rev=2, synced_hash="h", deleted=False)
    again = sync_engine.SyncStore(Database(path))
    assert again.state("prompts", "p").wire_id == "h1." + "a" * 64
    assert again.state("prompts", "p").rev == 2
