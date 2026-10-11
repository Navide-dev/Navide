"""Sync state partitioned by account (D4, schema v4).

Switching A → B used to forget every scope's agreed state, cursor and
conflicts, so coming back to A meant reading its whole history again — and
every local item that differed from the server became a conflict. These tests
hold the switch to parking A's bookkeeping and handing it back unchanged.
"""

from __future__ import annotations

import sqlite3

from agent_team_backend import app, sync_approvals, sync_engine, sync_scopes
from agent_team_backend.db import Database

from .test_sync_engine import Device, FakeServer, account_key  # noqa: F401 - a fixture


class _Settings:
    def __init__(self, values: dict | None = None) -> None:
        self.values = dict(values or {})

    def get(self) -> dict:
        return dict(self.values)

    def set(self, updates: dict) -> dict:
        self.values.update(updates)
        return updates


def _columns(db_path, table: str) -> set[str]:
    con = sqlite3.connect(db_path)
    try:
        return {str(r[1]) for r in con.execute(f"PRAGMA table_info({table})")}
    finally:
        con.close()


def test_schema_v4_only_adds(tmp_path) -> None:
    db = Database(tmp_path / "s.db")
    sync_engine.SyncStore(db)
    assert db.schema_version("sync") >= 4
    for table in ("sync_state", "sync_cursor", "sync_conflicts"):
        assert "account" in _columns(tmp_path / "s.db", table)
    db.close()


def test_a_build_that_predates_v4_still_writes_its_rows(tmp_path) -> None:
    """A downgraded build names no account column: its rows default to ""."""
    db = Database(tmp_path / "s.db")
    store = sync_engine.SyncStore(db)
    with db.transaction() as cur:
        cur.execute(
            "INSERT INTO sync_state (scope, item_id, rev, synced_hash, deleted) VALUES ('prompts','p',1,'h',0)"
        )
        cur.execute("INSERT INTO sync_cursor (scope, cursor) VALUES ('prompts', 1)")
    assert store.state("prompts", "p").rev == 1
    # Settling on an account adopts what no account claimed yet.
    store.adopt_account("ns-a")
    with db.transaction() as cur:
        assert cur.execute("SELECT account FROM sync_state").fetchone()[0] == "ns-a"
    db.close()


def test_switching_parks_one_account_and_restores_the_other(tmp_path) -> None:
    store = sync_engine.SyncStore(Database(tmp_path / "s.db"))
    store.adopt_account("ns-a")
    store.set_state("prompts", "p", rev=3, synced_hash="ha", deleted=False, synced_updated_at="2026-10-01T00:00:00+00:00")
    store.set_cursor("prompts", 3)
    store.record_conflict("mcp", "m", local={"a": 1}, remote={"a": 2}, remote_rev=5, remote_device="d")

    store.switch_account("ns-a", "ns-b")
    assert store.states("prompts") == {} and store.cursor("prompts") == 0
    assert store.conflicts(None) == []
    store.set_state("prompts", "p", rev=9, synced_hash="hb", deleted=False)
    store.set_cursor("prompts", 9)

    store.switch_account("ns-b", "ns-a")
    state = store.state("prompts", "p")
    assert (state.rev, state.synced_hash, state.synced_updated_at) == (3, "ha", "2026-10-01T00:00:00+00:00")
    assert store.cursor("prompts") == 3
    assert [c["itemId"] for c in store.conflicts(None)] == ["m"]

    store.switch_account("ns-a", "ns-b")
    assert store.state("prompts", "p").rev == 9 and store.cursor("prompts") == 9


def test_signing_out_parks_and_signing_back_in_restores(tmp_path) -> None:
    store = sync_engine.SyncStore(Database(tmp_path / "s.db"))
    store.adopt_account("ns-a")
    store.set_cursor("prompts", 4)
    store.switch_account("ns-a", None)
    assert store.cursor("prompts") == 0
    store.switch_account(None, "ns-a")
    assert store.cursor("prompts") == 4


def test_an_unknown_previous_account_forgets_as_before(tmp_path) -> None:
    store = sync_engine.SyncStore(Database(tmp_path / "s.db"))
    store.set_cursor("prompts", 4)
    store.switch_account(None, "ns-b")
    store.switch_account("ns-b", "ns-a")
    store.switch_account("ns-a", None)
    store.switch_account(None, "ns-b")
    assert store.cursor("prompts") == 0


async def test_a_to_b_to_a_neither_resyncs_nor_conflicts(tmp_path, account_key) -> None:
    server_a, server_b = FakeServer(), FakeServer()
    dev = Device(tmp_path, server_a, "d1", items={"p1": {"t": "one"}, "p2": {"t": "two"}})
    dev.store.adopt_account("ns-a")
    await dev.sync()
    # Another device of account A edits p2 meanwhile.
    other = Device(tmp_path, server_a, "d2")
    await other.sync()
    other.adapter.items["p2"] = {"t": "two, edited"}
    await other.sync()

    # Switch to B: a different server, different data.
    dev.store.switch_account("ns-a", "ns-b")
    pushes_a = server_a.pushes

    async def via_b(msg_type: str, payload: dict) -> dict:
        if msg_type == "sync.push":
            for item in payload["items"]:
                item["deviceId"] = "d1"
        return await server_b.request(msg_type, payload)

    dev.engine._request = via_b  # noqa: SLF001 - the link swaps servers the same way
    dev.adapter.items = {"b1": {"t": "b"}}
    await dev.sync()

    # Back to A, with A's items back in place locally.
    dev.store.switch_account("ns-b", "ns-a")

    pulls: list[int] = []

    async def via_a(msg_type: str, payload: dict) -> dict:
        if msg_type == "sync.pull":
            pulls.append(int(payload.get("since") or 0))
        if msg_type == "sync.push":
            for item in payload["items"]:
                item["deviceId"] = "d1"
        return await server_a.request(msg_type, payload)

    dev.engine._request = via_a  # noqa: SLF001
    dev.adapter.items = {"p1": {"t": "one"}, "p2": {"t": "two"}}
    await dev.sync()

    assert pulls and pulls[0] > 0, "A was read again from the start"
    assert server_a.pushes == pushes_a, "unchanged items were pushed again"
    assert dev.store.conflicts(None) == []
    assert dev.adapter.items["p2"] == {"t": "two, edited"}


def test_the_account_switch_parks_approvals_and_detached_marks(tmp_path, monkeypatch, account_key) -> None:
    # Real namespaces are hex (sync_keyring.namespace_for).
    A, B = "a" * 32, "b" * 32
    store = sync_engine.SyncStore(Database(tmp_path / "s.db"))
    store.adopt_account(A)
    store.set_state("skills", "s", rev=2, synced_hash="h", deleted=False)
    settings = _Settings({
        sync_scopes.SCOPES_SETTING: {s: True for s in sync_engine.SCOPES},
        sync_scopes.DETACHED_KEY: {"prompts": {"p": "d"}},
    })
    monkeypatch.setattr(sync_scopes, "_settings", lambda: settings)
    monkeypatch.setattr(app, "sync_store", store)
    monkeypatch.setattr(app, "app_data_dir", lambda: tmp_path)
    sync_approvals.hold("skills", "s", {"name": "s", "files": {}}, local=None, kind="new", summary={})
    assert sync_approvals.entry("skills", "s") is not None

    sync_scopes.switch_account(A, B)
    assert sync_approvals.entry("skills", "s") is None
    assert not settings.values.get(sync_scopes.DETACHED_KEY)
    assert store.states("skills") == {}
    # ACC-5 is unchanged: every scope is off after a switch.
    assert not any(sync_scopes.enabled_scopes().values())

    sync_scopes.switch_account(B, A)
    assert sync_approvals.entry("skills", "s") is not None
    assert settings.values.get(sync_scopes.DETACHED_KEY) == {"prompts": {"p": "d"}}
    assert store.state("skills", "s").rev == 2


def test_memory_and_credentials_never_become_syncable_through_a_switch(tmp_path, monkeypatch) -> None:
    store = sync_engine.SyncStore(Database(tmp_path / "s.db"))
    settings = _Settings({})
    monkeypatch.setattr(sync_scopes, "_settings", lambda: settings)
    monkeypatch.setattr(app, "sync_store", store)
    monkeypatch.setattr(app, "app_data_dir", lambda: tmp_path)
    sync_scopes.switch_account("ns-a", "ns-b")
    sync_scopes.switch_account("ns-b", "ns-a")
    assert not sync_scopes.scope_enabled("memory")
    assert not sync_scopes.scope_enabled("credentials")


async def test_the_link_hands_both_accounts_to_the_switch(monkeypatch) -> None:
    from agent_team_backend import server_link

    calls: list[tuple] = []
    monkeypatch.setattr(sync_scopes, "switch_account", lambda prev, new: calls.append((prev, new)))
    monkeypatch.setattr(sync_scopes, "adopt_account", lambda ns: calls.append(("adopt", ns)))
    settings = _Settings({server_link.SYNC_ACCOUNT_SETTING: "ns-a"})
    monkeypatch.setattr(server_link, "_settings_store", lambda: settings)
    monkeypatch.setattr(server_link, "_settled_account", server_link._UNREAD)
    await server_link._note_account("ns-a")
    await server_link._note_account("ns-b")
    await server_link._note_account("ns-a")
    assert calls == [("adopt", "ns-a"), ("ns-a", "ns-b"), ("ns-b", "ns-a")]


def _switch_fixture(tmp_path, monkeypatch):
    A, B = "a" * 32, "b" * 32
    store = sync_engine.SyncStore(Database(tmp_path / "s.db"))
    store.adopt_account(A)
    store.set_state("skills", "s", rev=2, synced_hash="h", deleted=False)
    settings = _Settings({
        sync_scopes.SCOPES_SETTING: {s: True for s in sync_engine.SCOPES},
        sync_scopes.DETACHED_KEY: {"prompts": {"p": "d"}},
    })
    monkeypatch.setattr(sync_scopes, "_settings", lambda: settings)
    monkeypatch.setattr(app, "sync_store", store)
    monkeypatch.setattr(app, "app_data_dir", lambda: tmp_path)
    sync_approvals.hold("skills", "s", {"name": "s", "files": {}}, local=None, kind="new", summary={})
    return A, B, store, settings


def test_a_retried_switch_keeps_what_the_first_attempt_parked(tmp_path, monkeypatch, account_key) -> None:
    """Review D-M1 (R2): the link retries a switch that failed halfway. The
    retry found the live approvals and detached marks already gone and parked
    that emptiness over what the first attempt had parked."""
    A, B, store, settings = _switch_fixture(tmp_path, monkeypatch)
    calls = {"n": 0}

    class Flaky:
        def reset(self) -> None:
            calls["n"] += 1
            if calls["n"] == 1:
                raise OSError("transient")

    monkeypatch.setattr(sync_scopes, "_skill_files", Flaky())
    try:
        sync_scopes.switch_account(A, B)
    except sync_engine.SyncError:
        pass
    sync_scopes.switch_account(A, B)
    sync_scopes.switch_account(B, A)
    assert store.state("skills", "s").rev == 2
    assert sync_approvals.entry("skills", "s") is not None
    assert settings.values.get(sync_scopes.DETACHED_KEY) == {"prompts": {"p": "d"}}


def test_a_park_that_fails_leaves_nothing_parked(tmp_path, monkeypatch, account_key) -> None:
    """Any part that cannot be parked means none of it is: the account is read
    afresh, never restored as state without its holds."""
    A, B, store, settings = _switch_fixture(tmp_path, monkeypatch)

    def broken(*_a, **_k):
        raise OSError("disk full")

    # A scoped patch, never monkeypatch.undo(): undo would also revert the
    # conftest fixtures sharing this monkeypatch, the fake credential vault
    # among them, and let the test reach the real Keychain.
    with monkeypatch.context() as scoped:
        scoped.setattr(store, "park_value", broken)
        sync_scopes.switch_account(A, B)
    sync_scopes.switch_account(B, A)
    assert store.states("skills") == {}
    assert sync_approvals.entry("skills", "s") is None


async def test_signing_out_and_back_in_to_the_same_account_restores_it(tmp_path, monkeypatch, account_key) -> None:
    """Review D-L1 (R7): after a sign-out the settled account is "", so the
    next sign-in looked like a first one and only adopted the (empty) live rows."""
    from agent_team_backend import server_link

    A, _B, store, settings = _switch_fixture(tmp_path, monkeypatch)
    settings.values[server_link.SYNC_ACCOUNT_SETTING] = A
    monkeypatch.setattr(server_link, "_settings_store", lambda: settings)
    monkeypatch.setattr(server_link, "_settled_account", server_link._UNREAD)
    await server_link._note_account(A)
    await server_link._note_account(None)
    assert store.states("skills") == {}
    await server_link._note_account(A)
    assert store.state("skills", "s").rev == 2
    assert sync_approvals.entry("skills", "s") is not None
