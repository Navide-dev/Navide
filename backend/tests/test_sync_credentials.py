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


# ── the scope exists and is off by default ───────────────────────────────────
def test_credentials_is_a_protocol_scope_and_off_by_default(monkeypatch):
    assert "credentials" in sync_engine.SCOPES

    class Settings:
        def get(self):
            return {}

    monkeypatch.setattr(sync_scopes, "_settings", lambda: Settings())
    assert sync_scopes.enabled_scopes()["credentials"] is False


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
