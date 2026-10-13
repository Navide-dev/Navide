"""The credentials sync scope: portable CLI credentials travelling between a
user's own devices, and the engine rules a scope holding secrets needs.

Every test here hands the adapter synthetic seams (``entries``,
``read_secret``, ``forget_local``) so no vault is touched; the keyring runs
for real against the per-test vault the conftest installs, because the
guarantees being checked — nothing in the clear on disk, sealed conflict
rows, the ring after a rotation — are about what the real code writes.

The leak checks read the SQLite files as bytes, journal and WAL included,
rather than asking the store what it holds: the store answering "no secret
here" is the thing under test.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend import sync_engine, sync_keyring, sync_scopes
from agent_team_backend.db import Database

from .test_sync_engine import DictScope, FakeServer, account_key  # noqa: F401 - a fixture

SECRET_A = "sk-ant-oat01-SYNTHETIC-alpha-0123456789"
SECRET_B = "sk-ant-oat01-SYNTHETIC-bravo-9876543210"
SECRET_C = "sk-ant-oat01-SYNTHETIC-charlie-5555555555"



def _counts(result: dict) -> dict:
    """The part of a round's result these tests pin down: its counts."""
    return {k: result[k] for k in ("scope", "pulled", "pushed", "conflicts")}

class LocalVault:
    """What this device's user pasted: the seam the adapter reads through."""

    def __init__(self, values: dict[tuple[str, str], str] | None = None) -> None:
        self.values = dict(values or {})
        self.forgotten: list[tuple[str, str]] = []

    def entries(self) -> list[tuple[str, str]]:
        return sorted(self.values)

    def read_secret(self, agent_key: str, slot_id: str) -> str | None:
        return self.values.get((agent_key, slot_id))

    def forget(self, agent_key: str, slot_id: str) -> None:
        self.values.pop((agent_key, slot_id), None)
        self.forgotten.append((agent_key, slot_id))


class CredDevice:
    """One machine holding a credentials adapter over its own database."""

    def __init__(self, tmp_path: Path, server: FakeServer, name: str, values=None) -> None:
        self.name = name
        self.vault = LocalVault(values)
        self.db_path = tmp_path / f"{name}.db"
        self.db = Database(self.db_path)
        self.store = sync_engine.SyncStore(self.db)
        self.adapter = sync_scopes.CredentialsScope(
            self.db,
            entries=self.vault.entries,
            read_secret=self.vault.read_secret,
            forget_local=self.vault.forget,
            accepts=lambda _agent, _value: True,
        )

        async def request(msg_type: str, payload: dict) -> dict:
            if msg_type == "sync.push":
                for item in payload["items"]:
                    item["deviceId"] = name
            return await server.request(msg_type, payload)

        self.engine = sync_engine.SyncEngine(
            self.store,
            request,
            device_id=lambda: name,
            enabled=lambda _scope: True,
            signing_key_for=lambda _device: "",
        )
        self.engine.register(self.adapter)

    async def sync(self) -> dict:
        return await self.engine.sync("credentials")

    def disk_bytes(self) -> bytes:
        """Every byte SQLite has on disk for this device: main file, journal, WAL."""
        out = b""
        for suffix in ("", "-journal", "-wal", "-shm"):
            path = Path(str(self.db_path) + suffix)
            if path.exists():
                out += path.read_bytes()
        return out

    def rows(self) -> list[dict]:
        return self.adapter.listing()


def _row_for(device: CredDevice, agent_key: str, slot_id: str, origin: str) -> dict:
    rows = [
        r
        for r in device.rows()
        if r["agentKey"] == agent_key and r["slotId"] == slot_id and r["origin"] == origin
    ]
    assert rows, f"no {origin} row for {agent_key}/{slot_id} on {device.name}"
    return rows[0]


# ── the scope exists and is off by default ───────────────────────────────────
def test_credentials_is_a_protocol_scope_and_off_by_default(monkeypatch):
    assert "credentials" in sync_engine.SCOPES

    class Settings:
        def get(self):
            return {}

    monkeypatch.setattr(sync_scopes, "_settings", lambda: Settings())
    assert sync_scopes.enabled_scopes()["credentials"] is False


# ── the happy path, and that it is idempotent ────────────────────────────────
@pytest.mark.asyncio
async def test_pasted_credential_reaches_the_other_device_and_settles(tmp_path, account_key):
    server = FakeServer()
    a = CredDevice(tmp_path, server, "dev-a", {("claude", "default"): SECRET_A})
    b = CredDevice(tmp_path, server, "dev-b")

    first = await a.sync()
    assert first["pushed"] == 1 and first["conflicts"] == 0
    assert _counts(await b.sync()) == {"scope": "credentials", "pulled": 1, "pushed": 0, "conflicts": 0}

    assert b.adapter.imported_value("claude", "default") == SECRET_A
    assert b.vault.values == {}  # nothing was written into B's own store
    row = _row_for(b, "claude", "default", "imported")
    assert row["itemId"] == _row_for(a, "claude", "default", "local")["itemId"]
    assert sync_scopes._ITEM_ID_RE.match(row["itemId"])  # noqa: SLF001 - the id shape is the contract

    # Same bytes on both sides: the snapshot equality the engine relies on.
    assert sync_engine.digest(a.adapter.snapshot()[row["itemId"]]) == sync_engine.digest(
        b.adapter.snapshot()[row["itemId"]]
    )

    # A second round on each side moves nothing.
    pushes = server.pushes
    assert _counts(await a.sync()) == {"scope": "credentials", "pulled": 0, "pushed": 0, "conflicts": 0}
    assert _counts(await b.sync()) == {"scope": "credentials", "pulled": 0, "pushed": 0, "conflicts": 0}
    assert server.pushes == pushes


@pytest.mark.asyncio
async def test_imported_value_survives_a_restart_from_ciphertext(tmp_path, account_key):
    server = FakeServer()
    a = CredDevice(tmp_path, server, "dev-a", {("claude", "default"): SECRET_A})
    b = CredDevice(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()
    item_id = _row_for(b, "claude", "default", "imported")["itemId"]

    # A fresh adapter over the same database: memory is gone, the sealed
    # column is not, and the snapshot it rebuilds is byte-identical.
    reborn = sync_scopes.CredentialsScope(
        Database(b.db_path),
        entries=lambda: [],
        read_secret=lambda _a, _s: None,
        forget_local=lambda _a, _s: None,
        accepts=lambda _a, _v: True,
    )
    assert reborn.imported_value("claude", "default") == SECRET_A
    assert sync_engine.digest(reborn.snapshot()[item_id]) == sync_engine.digest(
        a.adapter.snapshot()[item_id]
    )


# ── nothing in the clear, anywhere ───────────────────────────────────────────
@pytest.mark.asyncio
async def test_plaintext_never_touches_disk_the_server_or_the_listings(tmp_path, account_key):
    server = FakeServer()
    a = CredDevice(tmp_path, server, "dev-a", {("claude", "default"): SECRET_A})
    b = CredDevice(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()
    assert b.adapter.imported_value("claude", "default") == SECRET_A

    secret = SECRET_A.encode()
    assert secret not in a.disk_bytes()
    assert secret not in b.disk_bytes()
    for row in server.rows.values():
        assert SECRET_A not in json.dumps(row)

    for device in (a, b):
        assert SECRET_A not in json.dumps(device.rows())
        for payload in device.adapter.snapshot().values():
            described = device.adapter.describe(payload)
            assert described == {"agentKey": "claude", "slotId": "default"}
            assert SECRET_A not in json.dumps(described)

    inventory = await b.engine.inventory("credentials")
    assert SECRET_A not in json.dumps(inventory)
    (item,) = inventory["items"]
    assert item["state"] == sync_engine.STATE_IN_SYNC
    assert item["local"]["meta"] == {"agentKey": "claude", "slotId": "default"}
    assert item["remote"]["meta"] == {"agentKey": "claude", "slotId": "default"}
    assert item["remote"]["deviceId"] == "dev-a"


# ── removal is local ─────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_removing_a_credential_locally_never_tombstones_the_cloud(tmp_path, account_key):
    server = FakeServer()
    a = CredDevice(tmp_path, server, "dev-a", {("claude", "default"): SECRET_A})
    b = CredDevice(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()
    item_id = _row_for(a, "claude", "default", "local")["itemId"]

    a.vault.values.clear()  # the user removed it on A
    result = await a.sync()
    assert result["pushed"] == 0
    assert server.rows[("credentials", item_id)]["deleted"] == 0
    assert _row_for(a, "claude", "default", "local")["disabled"] is True

    # B still has it and still says nothing needs sending.
    assert _counts(await b.sync()) == {"scope": "credentials", "pulled": 0, "pushed": 0, "conflicts": 0}
    assert b.adapter.imported_value("claude", "default") == SECRET_A


@pytest.mark.asyncio
async def test_a_disabled_credential_does_not_come_back_on_pull(tmp_path, account_key):
    server = FakeServer()
    a = CredDevice(tmp_path, server, "dev-a", {("claude", "default"): SECRET_A})
    b = CredDevice(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()
    item_id = _row_for(b, "claude", "default", "imported")["itemId"]

    assert b.adapter.disable("claude", "default") == 1
    assert b.adapter.imported_value("claude", "default") is None
    assert SECRET_A.encode() not in b.disk_bytes()
    row = _row_for(b, "claude", "default", "imported")
    assert row["disabled"] is True

    # The scope is switched off and on again: the engine forgets its cursor
    # and re-reads everything from the server. The marker holds.
    b.store.forget("credentials")
    await b.sync()
    assert b.adapter.imported_value("claude", "default") is None
    assert server.rows[("credentials", item_id)]["deleted"] == 0  # and A is unaffected

    # Asking for it by name is the one thing that brings it back.
    results = await b.engine.pull_items("credentials", [item_id])
    assert results == [{"itemId": item_id, "result": "pulled", "rev": 1}]
    assert b.adapter.imported_value("claude", "default") == SECRET_A


@pytest.mark.asyncio
async def test_an_update_to_a_disabled_credential_is_neither_taken_nor_a_conflict(
    tmp_path, account_key
):
    server = FakeServer()
    a = CredDevice(tmp_path, server, "dev-a", {("claude", "default"): SECRET_A})
    b = CredDevice(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()
    b.adapter.disable("claude", "default")

    a.vault.values[("claude", "default")] = SECRET_B  # A replaces the token
    await a.sync()
    result = await b.sync()
    assert _counts(result) == {"scope": "credentials", "pulled": 0, "pushed": 0, "conflicts": 0}
    assert b.adapter.imported_value("claude", "default") is None
    assert SECRET_B.encode() not in b.disk_bytes()
    # The row is not re-read every round: its rev was recorded even though
    # nothing was taken.
    assert b.store.state("credentials", _row_for(b, "claude", "default", "imported")["itemId"]).rev == 2


@pytest.mark.asyncio
async def test_a_cloud_tombstone_never_erases_a_local_paste(tmp_path, account_key):
    server = FakeServer()
    a = CredDevice(tmp_path, server, "dev-a", {("claude", "default"): SECRET_A})
    b = CredDevice(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()
    item_id = _row_for(a, "claude", "default", "local")["itemId"]

    # Something (not this engine) tombstones the row on the server.
    server.rows[("credentials", item_id)] = {
        **server.rows[("credentials", item_id)],
        "rev": 2,
        "deleted": 1,
        "body": "",
        "deviceId": "dev-c",
    }
    server.cursors["credentials"] = 2

    await b.sync()
    assert b.adapter.imported_value("claude", "default") is None  # the import is let go of
    await a.sync()
    assert a.vault.values == {("claude", "default"): SECRET_A}  # the paste is not
    assert a.vault.forgotten == []


# ── replacing a value ────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_pasting_over_an_import_updates_the_same_item_everywhere(tmp_path, account_key):
    server = FakeServer()
    a = CredDevice(tmp_path, server, "dev-a", {("claude", "default"): SECRET_A})
    b = CredDevice(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()
    item_id = _row_for(b, "claude", "default", "imported")["itemId"]

    b.vault.values[("claude", "default")] = SECRET_B  # the user pastes a new token on B
    assert (await b.sync())["pushed"] == 1
    assert _row_for(b, "claude", "default", "local")["itemId"] == item_id
    assert len(b.rows()) == 1

    await a.sync()
    # The same item, updated: A's own paste gives way and A now runs on B's value.
    assert a.vault.forgotten == [("claude", "default")]
    assert a.adapter.imported_value("claude", "default") == SECRET_B
    assert _row_for(a, "claude", "default", "imported")["itemId"] == item_id
    assert SECRET_B.encode() not in a.disk_bytes()


# ── conflicts stay sealed ────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_conflict_rows_are_sealed_and_listed_as_metadata(tmp_path, account_key):
    server = FakeServer()
    a = CredDevice(tmp_path, server, "dev-a", {("claude", "default"): SECRET_A})
    b = CredDevice(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()
    item_id = _row_for(a, "claude", "default", "local")["itemId"]

    # Both replace the same item before either syncs.
    a.vault.values[("claude", "default")] = SECRET_B
    b.vault.values[("claude", "default")] = SECRET_C
    await a.sync()
    result = await b.sync()
    assert result["conflicts"] == 1

    for secret in (SECRET_A, SECRET_B, SECRET_C):
        assert secret.encode() not in b.disk_bytes()

    (conflict,) = b.store.conflicts("credentials")
    assert conflict["sealed"] is True
    assert conflict["local"] == {"agentKey": "claude", "slotId": "default"}
    assert conflict["remote"] == {"agentKey": "claude", "slotId": "default"}
    assert conflict["remoteDevice"] == "dev-a"
    assert SECRET_B not in json.dumps(conflict) and SECRET_C not in json.dumps(conflict)

    # Resolving still works on the real payloads, without ever listing them.
    b.engine.resolve("credentials", item_id, sync_engine.KEEP_REMOTE)
    assert b.adapter.imported_value("claude", "default") == SECRET_B
    assert b.vault.forgotten == [("claude", "default")]
    assert b.store.conflicts("credentials") == []
    assert _counts(await b.sync()) == {"scope": "credentials", "pulled": 0, "pushed": 0, "conflicts": 0}


@pytest.mark.asyncio
async def test_sealed_conflict_without_the_key_lists_a_placeholder(tmp_path, account_key):
    server = FakeServer()
    a = CredDevice(tmp_path, server, "dev-a", {("claude", "default"): SECRET_A})
    b = CredDevice(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()
    a.vault.values[("claude", "default")] = SECRET_B
    b.vault.values[("claude", "default")] = SECRET_C
    await a.sync()
    await b.sync()

    sync_keyring.forget_account_key()
    try:
        (conflict,) = b.store.conflicts("credentials")
        assert conflict["local"] == sync_engine.SEALED_PLACEHOLDER
        assert conflict["remote"] == sync_engine.SEALED_PLACEHOLDER
        with pytest.raises(sync_engine.SyncError):
            b.engine.resolve("credentials", conflict["itemId"], sync_engine.KEEP_LOCAL)
    finally:
        sync_keyring.ensure_account_key()


# ── identical content is agreement, not a clash ──────────────────────────────
@pytest.mark.asyncio
async def test_two_devices_pushing_the_same_bytes_do_not_conflict(tmp_path, account_key):
    """Generic engine rule, shown on the prompts scope: a push refused because
    another device wrote first with the *same* content adopts that rev."""
    from .test_sync_engine import Device

    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1", "prompt": "same"}})
    b = Device(tmp_path, server, "dev-b", {"p1": {"id": "p1", "prompt": "same"}})
    await a.sync()
    result = await b.sync()
    assert result["conflicts"] == 0
    assert b.store.state("prompts", "p1").rev == server.rows[("prompts", "p1")]["rev"]
    pushes = server.pushes
    await b.sync()
    assert server.pushes == pushes


@pytest.mark.asyncio
async def test_pulling_what_this_device_already_holds_converges(tmp_path, account_key):
    from .test_sync_engine import Device

    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1", "prompt": "same"}})
    b = Device(tmp_path, server, "dev-b")
    await a.sync()
    b.adapter.items["p1"] = {"id": "p1", "prompt": "same"}  # edited locally, not yet pushed
    result = await b.sync()
    assert result["conflicts"] == 0 and result["pulled"] == 1
    assert b.store.conflicts("prompts") == []


# ── keys: unknown, unreadable, rotated ───────────────────────────────────────
@pytest.mark.asyncio
async def test_a_record_under_an_unknown_key_holds_the_cursor(tmp_path, account_key, monkeypatch):
    server = FakeServer()
    a = CredDevice(
        tmp_path,
        server,
        "dev-a",
        {("claude", "one"): SECRET_A, ("claude", "two"): SECRET_B, ("claude", "three"): SECRET_C},
    )
    b = CredDevice(tmp_path, server, "dev-b")
    await a.sync()
    assert server.cursors["credentials"] == 3
    by_rev = {row["rev"]: row for row in server.rows.values()}
    held_body = by_rev[2]["body"]
    slot_of = {row["rev"]: a.adapter.describe(a.adapter.snapshot()[row["itemId"]])["slotId"]
               for row in server.rows.values()}

    real_decrypt = sync_keyring.decrypt

    def decrypt(wire, *, scope, item_id):
        if wire == held_body:
            raise sync_keyring.UnknownKeyId("not yet")
        return real_decrypt(wire, scope=scope, item_id=item_id)

    monkeypatch.setattr(sync_keyring, "decrypt", decrypt)
    result = await b.sync()
    assert result["pulled"] == 1  # rev 1 only; rev 2 held, rev 3 not stepped past
    assert b.store.cursor("credentials") == 1
    assert b.adapter.imported_value("claude", slot_of[1]) is not None
    assert b.adapter.imported_value("claude", slot_of[2]) is None
    assert b.adapter.imported_value("claude", slot_of[3]) is None

    monkeypatch.setattr(sync_keyring, "decrypt", real_decrypt)  # the ring arrived
    result = await b.sync()
    assert result["pulled"] == 2
    assert b.store.cursor("credentials") == 3
    assert b.adapter.imported_value("claude", slot_of[2]) is not None
    assert b.adapter.imported_value("claude", slot_of[3]) is not None


@pytest.mark.asyncio
async def test_an_unreadable_credential_fails_the_round_instead_of_skipping(
    tmp_path, account_key, monkeypatch
):
    server = FakeServer()
    a = CredDevice(tmp_path, server, "dev-a", {("claude", "default"): SECRET_A})
    b = CredDevice(tmp_path, server, "dev-b")
    await a.sync()
    server.rows[("credentials", _row_for(a, "claude", "default", "local")["itemId"])]["body"] = "AAAA"

    with pytest.raises(sync_engine.SyncError):
        await b.sync()
    assert b.store.cursor("credentials") == 0  # nothing was stepped past
    assert b.rows() == []

    # The same damage on a non-sensitive scope is skipped, as before.
    from .test_sync_engine import Device

    p = Device(tmp_path, server, "dev-p", {"p1": {"id": "p1"}})
    await p.sync()
    server.rows[("prompts", "p1")]["body"] = "AAAA"
    q = Device(tmp_path, server, "dev-q")
    assert (await q.sync())["pulled"] == 0
    assert q.store.cursor("prompts") == 1


@pytest.mark.asyncio
async def test_a_rotated_key_pushes_unchanged_items_again_without_conflict(tmp_path, account_key):
    server = FakeServer()
    a = CredDevice(tmp_path, server, "dev-a", {("claude", "default"): SECRET_A})
    b = CredDevice(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()
    item_id = _row_for(a, "claude", "default", "local")["itemId"]
    old_kid = a.store.state("credentials", item_id).sealed_kid
    assert old_kid == sync_keyring.active_key_id()
    assert not sync_keyring.needs_reseal(server.rows[("credentials", item_id)]["body"])

    new_kid = sync_keyring.rotate_account_key()  # both devices share the ring in-process
    assert (await a.sync())["pushed"] == 1
    assert a.store.state("credentials", item_id).sealed_kid == new_kid
    assert not sync_keyring.needs_reseal(server.rows[("credentials", item_id)]["body"])

    # B holds the same bytes under the old key: its own re-push is refused by
    # the server (stale rev), and that is agreement, not a conflict.
    result = await b.sync()
    assert result["conflicts"] == 0
    assert b.store.state("credentials", item_id).sealed_kid == new_kid
    assert b.adapter.imported_value("claude", "default") == SECRET_A
    pushes = server.pushes
    await a.sync()
    await b.sync()
    assert server.pushes == pushes


# ── ineligible values stay home ──────────────────────────────────────────────
@pytest.mark.asyncio
async def test_a_value_the_vendor_does_not_vouch_for_is_not_uploaded(tmp_path, account_key):
    server = FakeServer()
    a = CredDevice(tmp_path, server, "dev-a", {("claude", "default"): SECRET_A})
    a.adapter._accepts = lambda _agent, _value: False  # noqa: SLF001 - the seam under test
    assert (await a.sync())["pushed"] == 0
    assert server.rows == {}
    assert a.rows() == []


def test_a_malformed_payload_is_refused_and_described_as_nothing(tmp_path, account_key):
    adapter = sync_scopes.CredentialsScope(
        Database(tmp_path / "x.db"),
        entries=lambda: [],
        read_secret=lambda _a, _s: None,
        forget_local=lambda _a, _s: None,
        accepts=lambda _a, _v: True,
    )
    for bad in (
        None,
        "str",
        {"v": 2, "agentKey": "claude", "slotId": "default", "value": "x"},
        {"v": 1, "agentKey": "../etc", "slotId": "default", "value": "x"},
        {"v": 1, "agentKey": "claude", "slotId": "", "value": "x"},
        {"v": 1, "agentKey": "claude", "slotId": "default", "value": ""},
        {"v": 1, "agentKey": "claude", "slotId": "default", "value": "a\nb"},
        {"v": 1, "agentKey": "claude", "slotId": "default", "value": "x" * 9000},
    ):
        assert adapter.describe(bad) is None
        adapter.apply("c-" + "0" * 32, bad)
    assert adapter.listing() == []
    # Extra fields are dropped, not carried.
    assert adapter.describe(
        {"v": 1, "agentKey": "claude", "slotId": "default", "value": "x", "email": "who@x"}
    ) == {"agentKey": "claude", "slotId": "default"}


# ── signing out ──────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_switching_accounts_forgets_imports_and_switches_the_scope_off(
    tmp_path, account_key, monkeypatch
):
    from agent_team_backend import app

    server = FakeServer()
    a = CredDevice(tmp_path, server, "dev-a", {("claude", "default"): SECRET_A})
    b = CredDevice(tmp_path, server, "dev-b", {("codex", "work"): SECRET_B})
    await a.sync()
    await b.sync()
    assert b.adapter.imported_value("claude", "default") == SECRET_A

    settings: dict = {sync_scopes.SCOPES_SETTING: {"credentials": True}}

    class Settings:
        def get(self):
            return settings

        def set(self, updates):
            settings.update(updates)
            return updates

    monkeypatch.setattr(sync_scopes, "_settings", lambda: Settings())
    monkeypatch.setattr(sync_scopes, "_credentials_scope", b.adapter)
    monkeypatch.setattr(app, "sync_store", b.store)

    sync_scopes.on_account_changed()

    assert b.adapter.imported_value("claude", "default") is None
    assert [r["origin"] for r in b.rows()] == ["local"]  # B's own paste keeps its id
    assert b.store.states("credentials") == {} and b.store.cursor("credentials") == 0
    assert sync_scopes.enabled_scopes()["credentials"] is False


# ── review regressions ───────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_an_unreadable_push_conflict_fails_the_round_rather_than_reading_as_a_delete(
    tmp_path, account_key, monkeypatch
):
    server = FakeServer()
    a = CredDevice(tmp_path, server, "dev-a", {("claude", "default"): SECRET_A})
    b = CredDevice(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()
    item_id = _row_for(a, "claude", "default", "local")["itemId"]
    a.vault.values[("claude", "default")] = SECRET_B
    b.vault.values[("claude", "default")] = SECRET_C
    await a.sync()
    winning_body = server.rows[("credentials", item_id)]["body"]
    b.store.set_cursor("credentials", 2)  # skip the pull; make the push carry the clash

    real_decrypt = sync_keyring.decrypt

    def decrypt(wire, *, scope, item_id):
        if wire == winning_body:
            raise sync_keyring.KeyringError("damaged")
        return real_decrypt(wire, scope=scope, item_id=item_id)

    monkeypatch.setattr(sync_keyring, "decrypt", decrypt)
    with pytest.raises(sync_engine.SyncError):
        await b.sync()
    assert b.store.conflicts("credentials") == []
    assert b.store.state("credentials", item_id).rev == 1  # untouched
    assert b.vault.values[("claude", "default")] == SECRET_C

    monkeypatch.setattr(sync_keyring, "decrypt", real_decrypt)
    assert (await b.sync())["conflicts"] == 1  # now it is a real clash, listed


@pytest.mark.asyncio
async def test_keeping_a_remote_copy_under_a_retired_key_still_reseals_it(tmp_path, account_key):
    from .test_sync_engine import Device

    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1", "prompt": "from A"}})
    b = Device(tmp_path, server, "dev-b", {"p1": {"id": "p1", "prompt": "from B"}})
    await a.sync()
    assert (await b.sync())["conflicts"] == 1
    old_kid = sync_keyring.active_key_id()
    new_kid = sync_keyring.rotate_account_key()

    b.engine.resolve("prompts", "p1", sync_engine.KEEP_REMOTE)
    assert b.store.state("prompts", "p1").sealed_kid == old_kid
    assert sync_keyring.needs_reseal(server.rows[("prompts", "p1")]["body"])
    assert (await b.sync())["pushed"] == 1
    assert b.store.state("prompts", "p1").sealed_kid == new_kid
    assert not sync_keyring.needs_reseal(server.rows[("prompts", "p1")]["body"])


@pytest.mark.asyncio
async def test_a_push_in_the_same_round_cannot_step_past_a_held_row(
    tmp_path, account_key, monkeypatch
):
    server = FakeServer()
    a = CredDevice(tmp_path, server, "dev-a", {("claude", "one"): SECRET_A, ("claude", "two"): SECRET_B})
    b = CredDevice(tmp_path, server, "dev-b", {("codex", "work"): SECRET_C})
    await a.sync()
    by_rev = {row["rev"]: row for row in server.rows.values()}
    held_body = by_rev[2]["body"]

    real_decrypt = sync_keyring.decrypt

    def decrypt(wire, *, scope, item_id):
        if wire == held_body:
            raise sync_keyring.UnknownKeyId("not yet")
        return real_decrypt(wire, scope=scope, item_id=item_id)

    monkeypatch.setattr(sync_keyring, "decrypt", decrypt)
    result = await b.sync()
    assert result["pulled"] == 1 and result["pushed"] == 1  # B's own item went up as rev 3
    assert server.cursors["credentials"] == 3
    assert b.store.cursor("credentials") == 1  # not 3: rev 2 is still owed

    monkeypatch.setattr(sync_keyring, "decrypt", real_decrypt)
    result = await b.sync()
    assert result["pulled"] == 1  # rev 2 arrives; rev 3 is B's own echo
    assert b.store.cursor("credentials") == 3
    assert len([r for r in b.rows() if r["origin"] == "imported"]) == 2
    pushes = server.pushes
    await b.sync()
    assert server.pushes == pushes


@pytest.mark.asyncio
async def test_a_removed_local_paste_can_be_brought_back_by_an_explicit_pull(tmp_path, account_key):
    server = FakeServer()
    a = CredDevice(tmp_path, server, "dev-a", {("claude", "default"): SECRET_A})
    b = CredDevice(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()
    item_id = _row_for(a, "claude", "default", "local")["itemId"]

    a.vault.values.clear()
    await a.sync()
    assert _row_for(a, "claude", "default", "local")["disabled"] is True
    assert a.adapter.imported_value("claude", "default") is None

    results = await a.engine.pull_items("credentials", [item_id])
    assert results == [{"itemId": item_id, "result": "pulled", "rev": 1}]
    assert a.adapter.imported_value("claude", "default") == SECRET_A
    row = _row_for(a, "claude", "default", "imported")
    assert row["itemId"] == item_id and row["disabled"] is False
    assert _counts(await a.sync()) == {"scope": "credentials", "pulled": 0, "pushed": 0, "conflicts": 0}


@pytest.mark.asyncio
async def test_an_own_write_echoed_back_does_not_trigger_a_re_push(tmp_path, account_key):
    server = FakeServer()
    a = CredDevice(tmp_path, server, "dev-a", {("claude", "default"): SECRET_A})
    await a.sync()
    item_id = _row_for(a, "claude", "default", "local")["itemId"]
    kid = a.store.state("credentials", item_id).sealed_kid
    assert kid == sync_keyring.active_key_id()

    a.store.set_cursor("credentials", 0)  # the next pull re-reads our own row
    result = await a.sync()
    assert _counts(result) == {"scope": "credentials", "pulled": 0, "pushed": 0, "conflicts": 0}
    assert a.store.state("credentials", item_id).sealed_kid == kid


# ── switching the section on ─────────────────────────────────────────────────
def test_credentials_cannot_be_switched_on_while_a_legacy_pin_remains(monkeypatch):
    from agent_team_backend import trust_store

    settings: dict = {}

    class Settings:
        def get(self):
            return settings

        def set(self, updates):
            settings.update(updates)
            return updates

    monkeypatch.setattr(sync_scopes, "_settings", lambda: Settings())
    monkeypatch.setattr(trust_store, "legacy_pinned_devices", lambda: ["old-laptop"])
    with pytest.raises(sync_engine.SyncError, match="old-laptop"):
        sync_scopes.set_scope_enabled("credentials", True)
    assert sync_scopes.enabled_scopes()["credentials"] is False
    # Other scopes are not held to it, and switching credentials off always works.
    sync_scopes.set_scope_enabled("prompts", True)
    sync_scopes.set_scope_enabled("credentials", False)

    def locked():
        raise trust_store.TrustStoreLocked("locked")

    monkeypatch.setattr(trust_store, "legacy_pinned_devices", locked)
    with pytest.raises(sync_engine.SyncError, match="could not be read"):
        sync_scopes.set_scope_enabled("credentials", True)

    monkeypatch.setattr(trust_store, "legacy_pinned_devices", lambda: [])
    with pytest.raises(sync_engine.SyncError, match="not synced any more"):
        sync_scopes.set_scope_enabled("credentials", True)


# ── the accounts listing ─────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_imported_credentials_are_listed_as_metadata_with_availability(
    tmp_path, account_key
):
    server = FakeServer()
    a = CredDevice(tmp_path, server, "dev-a", {("claude", "p-on-a"): SECRET_A, ("claude", "__default__"): SECRET_B})
    b = CredDevice(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()

    listed = sorted(b.adapter.imported_listing(), key=lambda r: r["slotId"])
    assert [(r["agentKey"], r["slotId"], r["available"]) for r in listed] == [
        ("claude", "__default__", True),
        ("claude", "p-on-a", True),
    ]
    assert all(set(r) == {"agentKey", "slotId", "available", "updatedAt"} for r in listed)
    assert SECRET_A not in json.dumps(listed) and SECRET_B not in json.dumps(listed)
    assert a.adapter.imported_listing() == []  # A's are local pastes, not imports

    b.adapter.disable("claude", "p-on-a")
    assert [r["slotId"] for r in b.adapter.imported_listing()] == ["__default__"]

    sync_keyring.forget_account_key()
    try:
        reborn = sync_scopes.CredentialsScope(
            Database(b.db_path),
            entries=lambda: [],
            read_secret=lambda _a, _s: None,
            forget_local=lambda _a, _s: None,
            accepts=lambda _a, _v: True,
        )
        assert [(r["slotId"], r["available"]) for r in reborn.imported_listing()] == [("__default__", False)]
    finally:
        sync_keyring.ensure_account_key()


@pytest.mark.asyncio
async def test_set_scope_broadcasts_the_setting_only_when_it_changed(monkeypatch):
    """The renderer's cloud views listen for ``sync-scopes`` on
    ``ui.settings_changed``; a refused change must not announce anything."""
    from agent_team_backend import app, trust_store

    settings: dict = {}

    class Settings:
        def get(self):
            return settings

        def set(self, updates):
            settings.update(updates)
            return updates

    monkeypatch.setattr(sync_scopes, "_settings", lambda: Settings())
    events: list[dict] = []

    async def record(event, *, exclude=None):
        events.append(event)

    monkeypatch.setattr(app, "broadcast", record)

    class Socket:
        def __init__(self):
            self.sent = []

        async def send_json(self, payload):
            self.sent.append(payload)

    session = app.Session(Socket())  # type: ignore[arg-type]
    await app.handle_message(
        session, {"id": "1", "type": "sync.set_scope", "payload": {"scope": "prompts", "enabled": True}}
    )
    assert session.websocket.sent[0]["ok"] is True  # type: ignore[attr-defined]
    changed = [e for e in events if e["type"] == "ui.settings_changed"]
    assert len(changed) == 1
    assert changed[0]["payload"]["settings"][sync_scopes.SCOPES_SETTING]["prompts"] is True
    assert changed[0]["payload"]["settings"][sync_scopes.SCOPES_SETTING]["credentials"] is False

    monkeypatch.setattr(trust_store, "legacy_pinned_devices", lambda: ["old-laptop"])
    events.clear()
    await app.handle_message(
        session, {"id": "2", "type": "sync.set_scope", "payload": {"scope": "credentials", "enabled": True}}
    )
    reply = session.websocket.sent[1]  # type: ignore[attr-defined]
    assert reply["ok"] is False and reply["error"]["code"] == "SYNC_SCOPE_REFUSED"
    assert [e for e in events if e["type"] == "ui.settings_changed"] == []
