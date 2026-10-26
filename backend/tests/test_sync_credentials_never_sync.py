"""Credentials never sync (10-09), on any protocol and through every entry.

Review D-M2: credentials were only retired on the v3 wire, so a v1 fallback
(sync.caps timing out once) pushed them. The block now sits in the sync layer
— the switch, the link's engine wiring, the item-level and listing entries —
and a switch left on by an older build counts as off. The credential vault
is untouched.
"""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import app, server_link, sync_engine, sync_keyring, sync_scopes, ws_handlers


class _Settings:
    def __init__(self, values: dict) -> None:
        self.values = values

    def get(self) -> dict:
        return dict(self.values)

    def set(self, updates: dict) -> dict:
        self.values.update(updates)
        return updates


class _Recorder:
    """The far end: answers like an empty server, remembers every request."""

    def __init__(self, caps_fails: bool = False) -> None:
        self.seen: list[tuple[str, dict]] = []
        self.caps_fails = caps_fails

    async def request(self, msg_type: str, payload: dict) -> Any:
        self.seen.append((msg_type, payload))
        if msg_type == "sync.caps" and self.caps_fails:
            raise TimeoutError("sync.caps timed out")
        if msg_type == "sync.pull":
            return {"ok": True, "payload": {"cursor": 0, "items": [], "more": False}}
        if msg_type == "sync.push":
            return {"ok": True, "payload": {"accepted": [], "rejected": [], "conflicts": [], "cursor": 0}}
        return {"ok": False, "error": {"code": "UNKNOWN_TYPE", "message": msg_type}}

    def credential_traffic(self) -> list[str]:
        return [t for t, p in self.seen if isinstance(p, dict) and p.get("scope") == "credentials"]


@pytest.fixture
def wired(monkeypatch):
    """The real link wiring, with credentials switched on the way an older
    build could have left it on disk."""
    sync_keyring.ensure_account_key()
    settings = _Settings({sync_scopes.SCOPES_SETTING: {s: True for s in ("prompts", "credentials")}})
    monkeypatch.setattr(sync_scopes, "_settings", lambda: settings)
    link = server_link.ServerLink()
    link._authenticated = True  # noqa: SLF001 - the link is up

    async def has_key() -> bool:
        return True

    monkeypatch.setattr(link, "ensure_sync_key", has_key)
    monkeypatch.setattr(server_link, "_link", link)
    monkeypatch.setattr(server_link, "_switch_pending", False)
    recorder = _Recorder()
    engine = link.sync_engine()
    engine._request = recorder.request  # noqa: SLF001 - the far end
    yield link, engine, recorder, settings
    sync_keyring.forget_account_key()


def test_a_switch_left_on_on_disk_reads_as_off(wired) -> None:
    _link, _engine, _recorder, settings = wired
    assert settings.values[sync_scopes.SCOPES_SETTING]["credentials"] is True
    assert sync_scopes.scope_enabled("credentials") is False
    assert sync_scopes.scope_enabled("prompts") is True


def test_the_switch_cannot_be_turned_on(wired, monkeypatch) -> None:
    from agent_team_backend import trust_store

    monkeypatch.setattr(trust_store, "legacy_pinned_devices", lambda: [])
    with pytest.raises(sync_engine.SyncError, match="not synced"):
        sync_scopes.set_scope_enabled("credentials", True)
    sync_scopes.set_scope_enabled("credentials", False)


async def test_no_round_entry_moves_a_credential(wired) -> None:
    link, engine, recorder, _settings = wired
    # No engine holds a credentials adapter at all (sync_engine.LOCAL_ONLY_SCOPES).
    assert "credentials" not in engine.scopes
    assert (await engine.sync("credentials")).get("skipped") == "local-only"
    await engine.sync_all()
    await server_link.sync_now()
    await server_link.sync_now("credentials")
    await link._on_sync_changed({"scope": "credentials"})  # noqa: SLF001 - a server change notice
    await link._sync_all()  # noqa: SLF001 - the catch-up round on connect
    assert recorder.credential_traffic() == []


async def test_after_a_v1_fallback_credentials_still_push_nothing(wired) -> None:
    """R6: sync.caps times out once, the round falls back to v1, and still
    not one credentials push goes out."""
    _link, engine, _recorder, _settings = wired
    flaky = _Recorder(caps_fails=True)
    engine._request = flaky.request  # noqa: SLF001
    engine.reset_connection()
    await engine.sync_all()
    await engine.sync("credentials")
    assert [t for t in flaky.credential_traffic() if t == "sync.push"] == []
    assert flaky.credential_traffic() == []


class _Session:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, message: dict) -> None:
        self.sent.append(message)


@pytest.mark.parametrize(
    "msg_type, payload",
    [
        ("sync.push_items", {"scope": "credentials", "itemIds": ["c-1"]}),
        ("sync.pull_items", {"scope": "credentials", "itemIds": ["c-1"]}),
        ("sync.versions", {"scope": "credentials", "itemId": "c-1"}),
        ("sync.restore_version", {"scope": "credentials", "itemId": "c-1", "rev": 1}),
    ],
)
async def test_every_item_level_window_entry_refuses_credentials(wired, msg_type, payload) -> None:
    _link, _engine, recorder, _settings = wired
    session = _Session()
    await ws_handlers.lookup(msg_type)(session, "m1", msg_type, payload)
    (reply,) = session.sent
    assert "error" in reply
    assert recorder.credential_traffic() == []


@pytest.mark.parametrize("msg_type", ["sync.now", "sync.inventory"])
async def test_the_round_and_listing_window_entries_skip_credentials(wired, msg_type) -> None:
    _link, _engine, recorder, _settings = wired
    for payload in ({}, {"scope": "credentials"}):
        session = _Session()
        await ws_handlers.lookup(msg_type)(session, "m1", msg_type, payload)
    assert recorder.credential_traffic() == []




def test_the_app_store_is_what_the_engine_writes(wired) -> None:
    # Sanity: the wiring under test is the app's own store, not a stand-in.
    _link, engine, _recorder, _settings = wired
    assert engine._store is app.sync_store  # noqa: SLF001


# ── review N1: what the windows are told matches main ─────────────────────────
# A switch an older build left on must not surface as anything main would not
# show. Main's answers, offline: status carried the raw switch, and the
# inventory listed credentials as not-connected; connected, a switched-off
# sensitive scope answered "disabled". The CLI accounts page (useCliProfiles,
# unchanged) shows a blank cloud error for anything else.
async def _status(scopes_on_disk: dict) -> dict:
    session = _Session()
    await ws_handlers.lookup("sync.status")(session, "m1", "sync.status", {})
    (reply,) = session.sent
    return reply["payload"]


async def test_status_reports_a_credentials_switch_left_on_as_off(wired, monkeypatch) -> None:
    """Credentials and keys never leave this machine (2026-10-21): a switch an
    older build left on reads as off everywhere, the status included."""
    monkeypatch.setattr(server_link, "_link", None)
    payload = await _status({})
    assert payload["scopes"]["credentials"] is False
    assert payload["scopes"]["prompts"] is True
    assert set(payload["neverSynced"]) == {"memory", "credentials"}
    # The engine still never runs it.
    assert sync_scopes.scope_enabled("credentials") is False


def test_switching_another_scope_writes_the_credentials_switch_off(wired) -> None:
    _link, _engine, _recorder, settings = wired
    sync_scopes.set_scope_enabled("mcp", True)
    sync_scopes.set_scope_enabled("mcp", False)
    assert settings.values[sync_scopes.SCOPES_SETTING]["credentials"] is False


async def test_offline_inventory_answers_credentials_as_main_did(wired, monkeypatch) -> None:
    monkeypatch.setattr(server_link, "_link", None)
    only = await server_link.sync_inventory("credentials")
    assert only["scopes"]["credentials"] == {"scope": "credentials", "status": "not-connected", "items": []}
    listing = await server_link.sync_inventory()
    assert listing["scopes"]["credentials"] == {"scope": "credentials", "status": "not-connected", "items": []}
    assert "memory" not in listing["scopes"]


async def test_connected_inventory_answers_credentials_as_not_connected(wired) -> None:
    """Decision B: connected, credentials answer exactly as offline. Main
    listed the cloud's credentials here, which takes credential traffic; the
    CLI accounts page shows "not connected" and offers nothing to act on."""
    _link, _engine, recorder, _settings = wired
    only = await server_link.sync_inventory("credentials")
    assert only["scopes"]["credentials"] == {"scope": "credentials", "status": "not-connected", "items": []}
    listing = await server_link.sync_inventory()
    assert listing["scopes"]["credentials"] == {"scope": "credentials", "status": "not-connected", "items": []}
    assert recorder.credential_traffic() == []
