"""Credentials and keys are only ever stored on the user's own machine.

Policy of 2026-10-21: Navide never sends a credential, key or credential
record into Cloud sync or a shared bundle. These guards hold that at the
engine (no adapter for one can be registered, no push can name one) and at
the share-code path, which seals a bundle its caller hands it.
"""

from __future__ import annotations

import base64

import pytest

from agent_team_backend import settings_bundle, share_codes, sync_engine, sync_scopes, ws_handlers
from agent_team_backend.db import Database

from .test_share_publish_claim import FakeServer as ShareServer
from .test_share_publish_claim import FakeSession
from .test_sync_engine import DictScope


class SensitiveScope(DictScope):
    sensitive = True


def _engine(tmp_path, calls: list) -> sync_engine.SyncEngine:
    async def request(msg_type: str, payload: dict) -> dict:
        calls.append((msg_type, payload))
        return {"ok": True, "payload": {}}

    return sync_engine.SyncEngine(
        sync_engine.SyncStore(Database(tmp_path / "local.db")),
        request,
        device_id=lambda: "dev",
        enabled=lambda _scope: True,
    )


def test_no_engine_registers_a_credentials_scope(tmp_path):
    engine = _engine(tmp_path, [])
    with pytest.raises(sync_engine.SyncError):
        engine.register(DictScope(scope="credentials"))
    assert "credentials" not in engine.scopes


def test_no_engine_registers_a_scope_that_holds_secrets(tmp_path):
    engine = _engine(tmp_path, [])
    with pytest.raises(sync_engine.SyncError):
        engine.register(SensitiveScope(scope="prompts"))


def test_every_local_only_scope_is_a_protocol_scope_no_engine_takes(tmp_path):
    engine = _engine(tmp_path, [])
    for scope in sync_engine.LOCAL_ONLY_SCOPES:
        assert scope in sync_engine.SCOPES  # still known, so an old switch can be cleared
        with pytest.raises(sync_engine.SyncError):
            engine.register(DictScope(scope=scope))


async def test_no_push_names_a_credentials_scope(tmp_path):
    calls: list = []
    engine = _engine(tmp_path, calls)
    wire = [{"itemId": "c-1", "baseRev": 0, "updatedAt": "2026-10-21T00:00:00Z", "body": "x", "sig": "s"}]
    with pytest.raises(sync_engine.SyncError):
        await engine._send_batch("credentials", wire, [("c-1", {"value": "x"}, "h")])
    assert calls == []


async def test_a_switch_left_on_by_an_older_build_reads_as_off(monkeypatch):
    class Settings:
        def get(self):
            return {sync_scopes.SCOPES_SETTING: {"credentials": True, "prompts": True}}

    monkeypatch.setattr(sync_scopes, "_settings", lambda: Settings())
    assert sync_scopes.enabled_scopes()["credentials"] is False
    assert sync_scopes.enabled_scopes()["prompts"] is True
    assert sync_scopes.scope_enabled("credentials") is False


async def test_a_saved_credential_schedules_no_sync(monkeypatch):
    from agent_team_backend import server_link

    async def sync_now(**_kw):  # pragma: no cover - must not run
        raise AssertionError("a credential save scheduled a sync")

    monkeypatch.setattr(server_link, "sync_now", sync_now)
    assert sync_scopes.credential_saved("claude", "default") is None


async def test_a_published_bundle_carries_no_mcp_secret_and_no_credentials_scope(monkeypatch):
    server = ShareServer()
    server.install(monkeypatch)
    session = FakeSession()
    token = "sk-" + "live-" + "0123456789"
    bundle = {
        "bundleVersion": 1,
        "name": "team",
        "scopes": {
            "mcp": {"items": {"gh": {"command": "gh-mcp", "env": {"GH_PAT": token}, "headers": {"X-Auth": token}}}},
            "credentials": {"items": {"claude/default": {"value": token}}},
        },
        "redactions": [],
    }

    await ws_handlers.share_publish(session, "1", "share.publish", {"bundle": bundle})

    assert session.reply["ok"], session.reply
    (_, sent), = server.calls
    _, key = share_codes.decode_share_code(session.reply["payload"]["code"])
    opened = share_codes.open_bundle(sent["blob"], key)
    assert token not in repr(opened)
    assert set(opened["scopes"]) <= set(settings_bundle.SCOPES)
    assert opened["scopes"]["mcp"]["items"]["gh"]["env"] == {"GH_PAT": ""}
    assert opened["scopes"]["mcp"]["items"]["gh"]["command"] == "gh-mcp"
    assert token.encode() not in base64.b64decode(sent["blob"])
