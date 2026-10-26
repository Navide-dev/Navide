"""The one-time cleanup of the removed portable-credential feature.

It must erase exactly three things on a machine that used the feature — the
wrapping key, the kv ciphertext document and the imported credential rows —
and nothing else: no other kv key, row, table or Keychain item. On a machine
that never used it, it must not touch the vault at all.
"""

from __future__ import annotations

import sqlite3

import pytest

from agent_team_backend import portable_credentials_cleanup as cleanup
from agent_team_backend.credential_vault import CredentialVault
from agent_team_backend.db import Database

from .test_credential_vault import FakeSecurity

NOW = 1_800_000_000
KEY = cleanup.WRAPPING_KEY_SECRET


def _credential_table(db: Database) -> None:
    # The schema an older build created (migration component sync-credentials).
    with db.transaction() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS sync_credential_items (
                item_id    TEXT    PRIMARY KEY,
                agent_key  TEXT    NOT NULL,
                slot_id    TEXT    NOT NULL,
                origin     TEXT    NOT NULL,
                sealed     TEXT,
                disabled   INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            )
            """
        )


def _add_row(db: Database, item_id: str, origin: str) -> None:
    with db.transaction() as cur:
        cur.execute(
            "INSERT INTO sync_credential_items VALUES (?, 'claude', '__default__', ?, ?, 0, 1)",
            (item_id, origin, "sealed-body" if origin == "imported" else None),
        )


def _dump(db: Database) -> list[str]:
    """Every row of every table, as SQL — the whole database's content."""
    conn = sqlite3.connect(str(db._path))  # noqa: SLF001 - a read-only snapshot
    try:
        return list(conn.iterdump())
    finally:
        conn.close()


def _rows(db: Database, sql: str, args: tuple = ()) -> list[tuple]:
    with db.transaction() as cur:
        return [tuple(r) for r in cur.execute(sql, args).fetchall()]


@pytest.fixture
def db(tmp_path):
    database = Database(tmp_path / "navide.db")
    database.kv_set("unrelated", {"keep": True}, now=1)
    return database


@pytest.fixture
def mac(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "data"))
    security = FakeSecurity()
    vault = CredentialVault(
        root=tmp_path / "vault", real_home=tmp_path / "home",
        security_runner=security, platform="darwin",
    )
    return vault, security


def _seed_keychain(vault: CredentialVault, security: FakeSecurity) -> dict[str, str]:
    others = {
        vault.app_secret_service("navide-sync-account-key"): "ring",
        vault.app_secret_service("navide-device-trust"): "trust",
        "Claude Code-credentials": "claude-login",
    }
    security.items.update(others)
    security.items[vault.app_secret_service(KEY)] = "wrapping-key"
    security.calls.clear()
    return others


# ---- never used --------------------------------------------------------------

def test_a_machine_that_never_used_it_is_not_touched(db, mac):
    vault, security = mac
    _seed_keychain(vault, security)
    before = _dump(db)
    assert cleanup.run(db, vault, now=NOW) is False
    assert security.calls == []
    assert _dump(db) == before
    assert cleanup.take_notice(db, now=NOW) is False


def test_an_empty_credential_table_or_local_rows_alone_do_not_count(db, mac):
    vault, security = mac
    _credential_table(db)
    _add_row(db, "c-local", "local")
    before = _dump(db)
    assert cleanup.run(db, vault, now=NOW) is False
    assert security.calls == []
    assert _dump(db) == before


# ---- used --------------------------------------------------------------------

@pytest.mark.parametrize("trigger", ["kv", "imported", "both"])
def test_erases_the_three_items_and_nothing_else(db, mac, trigger):
    vault, security = mac
    others = _seed_keychain(vault, security)
    _credential_table(db)
    _add_row(db, "c-local", "local")
    if trigger in ("kv", "both"):
        db.kv_set(cleanup.KV_KEY, {"schemaVersion": 1, "items": {}}, now=1)
    if trigger in ("imported", "both"):
        _add_row(db, "c-imported", "imported")
    with db.transaction() as cur:
        cur.execute("CREATE TABLE other_store (id TEXT PRIMARY KEY, body TEXT)")
        cur.execute("INSERT INTO other_store VALUES ('x', 'y')")

    assert cleanup.run(db, vault, now=NOW) is True

    assert db.kv_get(cleanup.KV_KEY) is None
    assert _rows(db, "SELECT item_id FROM sync_credential_items") == [("c-local",)]
    assert db.kv_get("unrelated") == {"keep": True}
    assert _rows(db, "SELECT * FROM other_store") == [("x", "y")]
    # Only the wrapping key went; every other Keychain item is as it was.
    assert vault.app_secret_service(KEY) not in security.items
    assert security.items == others
    deletes = [c for c in security.calls if c[:1] == ["delete-generic-password"]]
    assert deletes == [["delete-generic-password", "-s", vault.app_secret_service(KEY)]]
    assert all(c[:1] == ["delete-generic-password"] for c in security.calls)


def test_only_the_named_items_change_in_the_database(db, mac):
    vault, _security = mac
    _credential_table(db)
    _add_row(db, "c-local", "local")
    expected = _dump(db)
    db.kv_set(cleanup.KV_KEY, {"schemaVersion": 1}, now=1)
    _add_row(db, "c-imported", "imported")
    cleanup.run(db, vault, now=NOW)
    db.kv_set(cleanup.STATE_KV_KEY, None, now=NOW)  # mask the cleanup's own record
    after = [line for line in _dump(db) if cleanup.STATE_KV_KEY not in line]
    assert after == expected


def test_runs_once(db, mac):
    vault, security = mac
    db.kv_set(cleanup.KV_KEY, {"schemaVersion": 1}, now=1)
    assert cleanup.run(db, vault, now=NOW) is True
    security.calls.clear()
    assert cleanup.run(db, vault, now=NOW) is False
    assert security.calls == []


def test_a_refused_key_deletion_is_retried_on_the_next_start(db, mac, monkeypatch):
    vault, security = mac
    db.kv_set(cleanup.KV_KEY, {"schemaVersion": 1}, now=1)
    original = vault.write_app_secret

    def locked(name, secret):
        raise RuntimeError("keychain locked")

    monkeypatch.setattr(vault, "write_app_secret", locked)
    with pytest.raises(RuntimeError):
        cleanup.run(db, vault, now=NOW)
    assert db.kv_get(cleanup.KV_KEY) is None
    assert db.kv_get(cleanup.STATE_KV_KEY)["keyDeleted"] is False

    monkeypatch.setattr(vault, "write_app_secret", original)
    security.items[vault.app_secret_service(KEY)] = "wrapping-key"
    assert cleanup.run(db, vault, now=NOW) is True
    assert vault.app_secret_service(KEY) not in security.items
    assert db.kv_get(cleanup.STATE_KV_KEY)["keyDeleted"] is True


def test_file_backed_platforms_remove_only_that_file(db, tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "data"))
    vault = CredentialVault(root=tmp_path / "vault", real_home=tmp_path / "home", platform="linux")
    vault.write_app_secret(KEY, "wrapping-key")
    vault.write_app_secret("navide-sync-account-key", "ring")
    db.kv_set(cleanup.KV_KEY, {"schemaVersion": 1}, now=1)

    assert cleanup.run(db, vault, now=NOW) is True
    assert not vault.app_secret_path(KEY).exists()
    assert vault.read_app_secret("navide-sync-account-key") == "ring"


# ---- notice ------------------------------------------------------------------

def test_the_notice_is_offered_exactly_once(db, mac):
    vault, _security = mac
    db.kv_set(cleanup.KV_KEY, {"schemaVersion": 1}, now=1)
    cleanup.run(db, vault, now=NOW)
    assert cleanup.take_notice(db, now=NOW) is True
    assert cleanup.take_notice(db, now=NOW) is False
    assert cleanup.run(db, vault, now=NOW) is False
    assert cleanup.take_notice(db, now=NOW) is False


@pytest.mark.asyncio
async def test_the_main_window_asks_for_the_notice_over_ws(db, mac, monkeypatch):
    from agent_team_backend import app

    class Socket:
        def __init__(self) -> None:
            self.sent: list[dict] = []

        async def send_json(self, payload: dict) -> None:
            self.sent.append(payload)

    vault, _security = mac
    monkeypatch.setattr(app, "database", db)
    session = app.Session(Socket())  # type: ignore[arg-type]

    async def ask() -> bool:
        await app.handle_message(session, {
            "id": "n1", "type": "cli_profiles.portable_removal_notice", "payload": {}})
        return session.websocket.sent[-1]["payload"]["show"]  # type: ignore[attr-defined]

    assert await ask() is False
    db.kv_set(cleanup.KV_KEY, {"schemaVersion": 1}, now=1)
    cleanup.run(db, vault, now=NOW)
    assert await ask() is True
    assert await ask() is False
