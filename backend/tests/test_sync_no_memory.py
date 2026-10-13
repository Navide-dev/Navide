"""User decision 2026-10-09: memory is no longer synced. A memory switch left
on (by an older build, or written through ui.settings.set) runs nothing:
nothing is pulled or pushed, nothing is deleted here or on the server."""

from __future__ import annotations

import pytest

from agent_team_backend import app, native_memory, sync_approvals, sync_engine, sync_scopes
from agent_team_backend.db import Database
from tests.test_sync_engine import FakeServer, FakeSettingsStore
from tests.test_sync_scope_adapters import _home, account_key  # noqa: F401

MID = ".claude:CLAUDE.md"
TOKEN = "sk-" + "A1b2C3d4" * 6


@pytest.fixture(autouse=True)
def _own_app_data(tmp_path, monkeypatch):
    monkeypatch.setattr(app, "app_data_dir", lambda: tmp_path / "app-data")


@pytest.fixture
def memory_on(tmp_path, monkeypatch):
    settings = FakeSettingsStore({sync_scopes.SCOPES_SETTING: {"memory": True, "prompts": True}})
    monkeypatch.setattr(app, "ui_settings_store", settings)
    home = _home(tmp_path, "h")
    monkeypatch.setattr(native_memory, "_home", lambda: home)
    return settings, home


def test_the_memory_scope_is_never_enabled_for_sync(memory_on):
    assert sync_scopes.scope_enabled("memory") is False
    assert sync_scopes.scope_enabled("prompts") is True


def test_memory_cannot_be_switched_on_but_can_be_switched_off(memory_on):
    with pytest.raises(sync_engine.SyncError, match="not synced"):
        sync_scopes.set_scope_enabled("memory", True)
    assert sync_scopes.set_scope_enabled("memory", False)["memory"] is False


async def test_a_round_with_memory_left_on_touches_nothing(tmp_path, account_key, memory_on):
    settings, home = memory_on
    (home / ".claude" / "CLAUDE.md").write_text("mine\n")
    server = FakeServer()
    server.rows[("memory", MID)] = {"itemId": MID, "rev": 1, "updatedAt": "", "deviceId": "other",
                                    "deleted": 0, "body": "sealed", "sig": ""}
    server.cursors["memory"] = 1
    calls = []

    async def request(msg_type, payload):
        calls.append((msg_type, payload.get("scope")))
        return await server.request(msg_type, payload)

    engine = sync_engine.SyncEngine(
        sync_engine.SyncStore(Database(tmp_path / "s.db")), request, device_id=lambda: "me",
        enabled=sync_scopes.scope_enabled, signing_key_for=lambda _d: "",
    )
    engine.register(sync_scopes.MemoryScope())
    result = await engine.sync("memory")
    assert result.get("skipped")
    assert [c for c in calls if c[1] == "memory"] == []
    assert server.rows[("memory", MID)]["deleted"] == 0 and server.rows[("memory", MID)]["body"] == "sealed"
    assert (home / ".claude" / "CLAUDE.md").read_text() == "mine\n"


def test_held_memory_records_are_not_listed_and_never_land(account_key, memory_on):
    settings, home = memory_on
    assert sync_approvals.hold("memory", MID, {"text": "remote\n"}, local=None, kind="new",
                               summary={"path": "~/.claude/CLAUDE.md", "bytes": 7})
    assert [r for r in sync_approvals.listing() if r["scope"] == "memory"] == []
    assert [r for r in sync_approvals.listing(brief=True) if r["scope"] == "memory"] == []
    with pytest.raises(sync_engine.SyncError):
        sync_approvals.detail("memory", MID)
    record = sync_approvals.entry("memory", MID)
    with pytest.raises(sync_engine.SyncError, match="not synced"):
        sync_approvals.decide(sync_scopes.MemoryScope(), MID, True, record["digest"])
    assert not (home / ".claude" / "CLAUDE.md").exists()


def test_secret_warnings_no_longer_list_memory(memory_on):
    settings, home = memory_on
    (home / ".claude" / "CLAUDE.md").write_text(f"bearer {TOKEN}\n")
    assert [w for w in sync_scopes.secret_warnings() if w["scope"] == "memory"] == []


# ── the cloud inventory and its selective moves ─────────────────────────────
async def test_the_cloud_inventory_leaves_a_retired_scope_out(monkeypatch, memory_on):
    from agent_team_backend import server_link

    monkeypatch.setattr(server_link, "_link", None)
    listing = await server_link.sync_inventory("")
    assert "memory" not in listing["scopes"] and "prompts" in listing["scopes"]
    only = await server_link.sync_inventory("memory")
    assert only["scopes"]["memory"]["status"] == "retired" and only["scopes"]["memory"]["items"] == []


@pytest.mark.parametrize("call", ["sync_push_items", "sync_pull_items"])
async def test_a_retired_scope_is_never_pushed_or_pulled(monkeypatch, memory_on, call):
    from agent_team_backend import server_link

    monkeypatch.setattr(server_link, "_link", None)
    with pytest.raises(sync_approvals.RetiredScopeError, match="not synced any more"):
        await getattr(server_link, call)("memory", [MID])


@pytest.mark.parametrize("msg_type", ["sync.push_items", "sync.pull_items"])
async def test_the_window_is_told_plainly_that_memory_is_not_synced(memory_on, msg_type):
    from agent_team_backend import ws_handlers

    sent = []

    class Session:
        async def send_json(self, message):
            sent.append(message)

    await ws_handlers.lookup(msg_type)(Session(), "m1", msg_type, {"scope": "memory", "itemIds": [MID]})
    (reply,) = sent
    assert reply["error"]["code"] == "SYNC_SCOPE_RETIRED"
    assert "not synced any more" in reply["error"]["message"]
