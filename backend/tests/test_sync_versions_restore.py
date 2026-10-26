"""Sync protocol v3, phase 3: an item's earlier versions, and restoring one.

A restored version is handed to the scope's adapter exactly as a pulled
record is, so the approval gate holds an MCP server the same way, and a
prompt that lands goes up again as an ordinary edit on the next round.
"""

from __future__ import annotations

import pytest

from agent_team_backend import app, sync_approvals, sync_engine, sync_scopes
from agent_team_backend.mcp_settings import MCPSettingsStore
from tests.test_sync_s3_objects import V3Device, V3Server, account_key, s3  # noqa: F401 - fixtures
from tests.test_sync_scope_adapters import Dev, _mcp


async def _three_edits(tmp_path, s3, adopt):
    server = V3Server(s3, adopt_ready=adopt)
    a = V3Device(tmp_path, server, "A", {"p1": {"v": 0}})
    await a.sync()
    for n in (1, 2, 3):
        a.adapter.items["p1"] = {"v": n}
        assert (await a.sync())["ok"] is True
    return server, a


@pytest.mark.parametrize("adopt", [False, True], ids=["legacy-ids", "hashed-ids"])
async def test_versions_lists_the_earlier_copies_newest_first(tmp_path, account_key, s3, adopt):
    _server, a = await _three_edits(tmp_path, s3, adopt)
    versions = await a.engine.versions("prompts", "p1")
    assert len(versions) == 3
    assert [v["rev"] for v in versions] == sorted((v["rev"] for v in versions), reverse=True)
    assert set(versions[0]) == {"rev", "updatedAt", "deviceId", "supersededAt"}
    assert versions[0]["deviceId"] == "A"


@pytest.mark.parametrize("adopt", [False, True], ids=["legacy-ids", "hashed-ids"])
async def test_restoring_a_prompt_lands_it_and_pushes_it_next_round(tmp_path, account_key, s3, adopt):
    server, a = await _three_edits(tmp_path, s3, adopt)
    oldest = (await a.engine.versions("prompts", "p1"))[-1]
    pushes = server.pushes
    result = await a.engine.restore("prompts", "p1", oldest["rev"])
    assert result == {"scope": "prompts", "itemId": "p1", "rev": oldest["rev"], "held": False,
                      "outcome": "applied"}
    assert a.adapter.items["p1"] == {"v": 0}
    assert server.pushes == pushes  # nothing is sent by the restore itself
    assert (await a.sync())["ok"] is True
    assert server.pushes == pushes + 1 and a.store.conflicts("prompts") == []
    b = V3Device(tmp_path, server, "B")
    await b.sync()
    assert b.adapter.items == {"p1": {"v": 0}}


async def test_an_unknown_rev_is_refused(tmp_path, account_key, s3):
    _server, a = await _three_edits(tmp_path, s3, False)
    with pytest.raises(sync_engine.SyncError):
        await a.engine.restore("prompts", "p1", 999)
    assert a.adapter.items["p1"] == {"v": 3}


async def test_a_tampered_version_is_not_restored(tmp_path, account_key, s3):
    server, a = await _three_edits(tmp_path, s3, True)
    (key,) = server.history
    oldest = server.history[key][0]
    other = server.history[key][1]
    s3.objects[oldest["objectRef"]["blobId"]] = s3.objects[other["objectRef"]["blobId"]]
    with pytest.raises(sync_engine.SyncError):
        await a.engine.restore("prompts", "p1", oldest["rev"])
    assert a.adapter.items["p1"] == {"v": 3}


async def test_versions_need_an_object_account(tmp_path, account_key, s3):
    server = V3Server(s3, storage="inline")
    a = V3Device(tmp_path, server, "A", {"p1": {"v": 0}})
    await a.sync()
    with pytest.raises(sync_engine.SyncError) as err:
        await a.engine.versions("prompts", "p1")
    assert err.value.code == "VERSIONS_UNAVAILABLE"
    old = V3Server(s3, caps=False)
    o = V3Device(tmp_path, old, "O", {"p1": {"v": 0}})
    await o.sync()
    with pytest.raises(sync_engine.SyncError) as err:
        await o.engine.restore("prompts", "p1", 1)
    assert err.value.code == "VERSIONS_UNAVAILABLE"
    assert "sync.versions" not in old.types()


async def test_restoring_an_mcp_version_waits_for_approval(tmp_path, account_key, s3, monkeypatch):
    monkeypatch.setattr(app, "app_data_dir", lambda: tmp_path / "app-data")
    server = V3Server(s3, adopt_ready=True)
    store = MCPSettingsStore(tmp_path / "a.json")
    a = Dev(tmp_path, server, "A", monkeypatch, sync_scopes.McpScope(), mcp_settings_store=store)
    a.engine._request = lambda t, p: server.handle("A", t, p)
    a.use()
    store.replace_servers([{**_mcp("runner"), "command": "/usr/bin/first"}])
    await a.sync()
    store.replace_servers([{**_mcp("runner"), "command": "/usr/bin/second"}])
    await a.sync()
    (old,) = await a.engine.versions("mcp", "i:runner")
    pushes = server.pushes
    result = await a.engine.restore("mcp", "i:runner", old["rev"])
    assert result["held"] is True
    assert {s["name"]: s["command"] for s in store.list_servers()} == {"runner": "/usr/bin/second"}
    assert sync_approvals.entry("mcp", "i:runner")["status"] == "pending"
    # Nothing goes up while the restored version waits: the cloud keeps
    # what this machine still runs until the user says yes here.
    assert (await a.sync())["ok"] is True
    assert server.pushes == pushes
    assert {s["name"]: s["command"] for s in store.list_servers()} == {"runner": "/usr/bin/second"}
    (row,) = [h for h in sync_approvals.listing() if h["itemId"] in ("runner", "i:" + "runner")]
    assert sync_approvals.decide(a.adapter, "i:runner", True, row["digest"])["status"] == "applied"
    assert {s["name"]: s["command"] for s in store.list_servers()} == {"runner": "/usr/bin/first"}
    # Approved and landed: an ordinary local edit, pushed once.
    await a.sync()
    assert server.pushes == pushes + 1
    await a.sync()
    assert server.pushes == pushes + 1


async def test_a_rejected_restore_changes_nothing_anywhere(tmp_path, account_key, s3, monkeypatch):
    monkeypatch.setattr(app, "app_data_dir", lambda: tmp_path / "app-data")
    server = V3Server(s3, adopt_ready=True)
    store = MCPSettingsStore(tmp_path / "a.json")
    a = Dev(tmp_path, server, "A", monkeypatch, sync_scopes.McpScope(), mcp_settings_store=store)
    a.engine._request = lambda t, p: server.handle("A", t, p)
    a.use()
    store.replace_servers([{**_mcp("runner"), "command": "/usr/bin/first"}])
    await a.sync()
    store.replace_servers([{**_mcp("runner"), "command": "/usr/bin/second"}])
    await a.sync()
    (old,) = await a.engine.versions("mcp", "i:runner")
    pushes = server.pushes
    assert (await a.engine.restore("mcp", "i:runner", old["rev"]))["held"] is True
    (row,) = [h for h in sync_approvals.listing() if h["itemId"] in ("runner", "i:" + "runner")]
    assert sync_approvals.decide(a.adapter, "i:runner", False, row["digest"])["status"] == "rejected"
    # A "no" to a restore leaves nothing behind: no hold, nothing withheld,
    # nothing pushed, and the current version keeps running.
    assert sync_approvals.entry("mcp", "i:runner") is None
    assert (await a.sync())["ok"] is True
    assert server.pushes == pushes
    assert {s["name"]: s["command"] for s in store.list_servers()} == {"runner": "/usr/bin/second"}
    # A later local edit goes up as usual.
    store.replace_servers([{**_mcp("runner"), "command": "/usr/bin/third"}])
    await a.sync()
    assert server.pushes == pushes + 1
