"""D1: a synced skill or MCP server that is new here, or changes what would
run, waits for the user's approval before it is written, enabled or projected.

Two devices over the adapter harness of ``test_sync_scope_adapters``.
"""

from __future__ import annotations

import os
import stat

import pytest

from agent_team_backend import app, sync_approvals, sync_scopes
from agent_team_backend.mcp_settings import MCPSettingsStore
from tests.test_sync_scope_adapters import Dev, StrictServer, _mcp, _skill_pair, account_key  # noqa: F401


@pytest.fixture(autouse=True)
def _own_app_data(tmp_path, monkeypatch):
    """Holds live in app data; every test gets its own (a Dev swaps in its
    device's own on each round)."""
    data_dir = tmp_path / "app-data"
    monkeypatch.setattr(app, "app_data_dir", lambda: data_dir)


def _names(store):
    return {s["name"] for s in store.list_servers()}


def _server(store, name):
    return next(s for s in store.list_servers() if s["name"] == name)


def _mcp_pair(tmp_path, monkeypatch):
    server = StrictServer()
    a_store, b_store = MCPSettingsStore(tmp_path / "a.json"), MCPSettingsStore(tmp_path / "b.json")
    a = Dev(tmp_path, server, "A", monkeypatch, sync_scopes.McpScope(), mcp_settings_store=a_store)
    b = Dev(tmp_path, server, "B", monkeypatch, sync_scopes.McpScope(), mcp_settings_store=b_store)
    return server, a, b, a_store, b_store


def _decide(dev, item_id, approve):
    """As the window decides: on the row it listed, by that row's digest."""
    dev.use()
    (row,) = [h for h in sync_approvals.listing() if h["itemId"] == item_id]
    return sync_approvals.decide(dev.adapter, item_id, approve, row["digest"])


# ── MCP ──────────────────────────────────────────────────────────────────────
async def test_a_new_mcp_server_waits_for_approval(tmp_path, account_key, monkeypatch):
    server, a, b, a_store, b_store = _mcp_pair(tmp_path, monkeypatch)
    a.use(); a_store.replace_servers([{**_mcp("runner"), "command": "/tmp/evil", "args": ["--x"]}])
    await a.sync(); await b.sync()
    assert "runner" not in _names(b_store)
    b.use()
    (held,) = [h for h in sync_approvals.listing() if h["itemId"] == "runner"]
    assert held["scope"] == "mcp" and held["status"] == "pending" and held["kind"] == "new"
    assert held["summary"]["command"] == "/tmp/evil" and held["summary"]["args"] == ["--x"]
    pushes = server.pushes
    await b.sync(); await a.sync()
    assert server.pushes == pushes                    # held, not pushed back as missing
    assert "runner" in _names(a_store)                # and not deleted on its origin
    assert _decide(b, "runner", True)["status"] == "applied"
    assert "runner" in _names(b_store)
    assert sync_approvals.listing() == []
    await b.sync()
    assert server.pushes == pushes                    # landed copy equals the cloud copy


async def test_a_changed_command_waits_but_a_rotated_env_value_does_not(tmp_path, account_key, monkeypatch):
    server, a, b, a_store, b_store = _mcp_pair(tmp_path, monkeypatch)
    base = {**_mcp("api"), "env": {"API_TOKEN": "t1"}}
    a.use(); a_store.replace_servers([base])
    await a.sync(); await b.sync()
    _decide(b, "api", True)
    # A token rotation: what runs is the same.
    a.use(); a_store.replace_servers([{**base, "env": {"API_TOKEN": "t2"}}])
    await a.sync(); await b.sync()
    b.use()
    assert _server(b_store, "api")["env"] == {"API_TOKEN": "t2"}
    assert sync_approvals.listing() == []
    # A new env name (NODE_OPTIONS, say) or a new command does change what runs.
    a.use(); a_store.replace_servers([{**base, "env": {"API_TOKEN": "t2"}, "command": "/tmp/other"}])
    await a.sync(); await b.sync()
    b.use()
    assert _server(b_store, "api")["command"] == "npx"
    (held,) = sync_approvals.listing()
    assert held["kind"] == "changed" and held["summary"]["command"] == "/tmp/other"
    assert "t2" not in repr(held)                      # env values never in the summary
    a.use(); a_store.replace_servers([{**base, "env": {"API_TOKEN": "t2", "NODE_OPTIONS": "--require x"}}])
    await a.sync(); await b.sync()
    b.use()
    (held,) = sync_approvals.listing()
    assert held["summary"]["env"] == {"API_TOKEN": sync_scopes.MASKED_VALUE, "NODE_OPTIONS": "--require x"}
    assert "NODE_OPTIONS" not in _server(b_store, "api")["env"]


async def test_a_rejected_server_stays_out_and_is_not_pushed_back(tmp_path, account_key, monkeypatch):
    server, a, b, a_store, b_store = _mcp_pair(tmp_path, monkeypatch)
    a.use(); a_store.replace_servers([_mcp("x")])
    await a.sync(); await b.sync()
    assert _decide(b, "x", False)["status"] == "rejected"
    pushes = server.pushes
    for _ in range(2):
        await b.sync(); await a.sync()
    assert server.pushes == pushes
    assert "x" not in _names(b_store) and "x" in _names(a_store)
    # A newer version is a new request.
    a.use(); a_store.replace_servers([{**_mcp("x"), "args": ["--v2"]}])
    await a.sync(); await b.sync()
    b.use()
    (held,) = sync_approvals.listing()
    assert held["status"] == "pending" and held["summary"]["args"] == ["--v2"]


async def test_a_hold_survives_a_restart(tmp_path, account_key, monkeypatch):
    server, a, b, a_store, b_store = _mcp_pair(tmp_path, monkeypatch)
    a.use(); a_store.replace_servers([_mcp("x")])
    await a.sync(); await b.sync()
    pushes = server.pushes
    b.adapter = sync_scopes.McpScope()           # a fresh process: nothing in memory
    b.engine._adapters["mcp"] = b.adapter
    await b.sync()
    assert server.pushes == pushes
    b.use()
    assert [h["itemId"] for h in sync_approvals.listing()] == ["x"]


async def test_a_local_edit_while_waiting_wins(tmp_path, account_key, monkeypatch):
    server, a, b, a_store, b_store = _mcp_pair(tmp_path, monkeypatch)
    a.use(); a_store.replace_servers([_mcp("x")])
    await a.sync(); await b.sync()
    b.use(); b_store.replace_servers([*b_store.list_servers(), {**_mcp("x"), "command": "mine"}])
    await b.sync()
    b.use()
    assert sync_approvals.listing() == []
    # B's edit goes up; on A it changes what runs, so A is asked in turn.
    await a.sync()
    a.use()
    assert _server(a_store, "x")["command"] == "npx"
    (held,) = [h for h in sync_approvals.listing() if h["itemId"] == "x"]
    assert held["kind"] == "changed" and held["summary"]["command"] == "mine"


async def test_a_delete_still_applies_without_approval(tmp_path, account_key, monkeypatch):
    server, a, b, a_store, b_store = _mcp_pair(tmp_path, monkeypatch)
    a.use(); a_store.replace_servers([_mcp("x")])
    await a.sync(); await b.sync()
    _decide(b, "x", True)
    a.use(); a_store.replace_servers([])
    await a.sync(); await b.sync()
    assert "x" not in _names(b_store)


def test_forget_approvals_drops_index_and_payloads(tmp_path, account_key, monkeypatch):
    from tests.test_sync_engine import FakeSettingsStore

    monkeypatch.setattr(app, "ui_settings_store", FakeSettingsStore())
    sync_approvals.hold("mcp", "x", _mcp("x"), local=None, kind="new", summary={"name": "x"})
    path = sync_approvals._stash_path("mcp", "x")
    assert path.is_file() and sync_approvals.listing()
    assert "npx" not in path.read_text()              # sealed, not plain
    sync_approvals.forget_approvals()
    assert sync_approvals.listing() == [] and not path.exists()


# ── skills ───────────────────────────────────────────────────────────────────
async def test_a_new_skill_with_scripts_waits_and_lands_executable_on_approval(tmp_path, account_key, monkeypatch):
    monkeypatch.setattr(sync_scopes.SkillFilesScope, "available", lambda self: False)
    server, a, b, sa, ra, sb, rb = _skill_pair(tmp_path, monkeypatch)
    a.use(); sa.create_skill("runner", "r", consent=True)
    script = ra / "runner" / "go.sh"
    script.write_bytes(b"#!/bin/sh\necho hi\n")
    script.chmod(0o755)
    await a.sync(); await b.sync()
    assert not (rb / "runner").exists()
    b.use()
    assert "runner" not in {s["name"] for s in sb.list_skills()["skills"]}
    (held,) = sync_approvals.listing()
    assert held["scope"] == "skills" and held["kind"] == "new"
    assert [f["path"] for f in held["summary"]["files"]] == ["SKILL.md", "go.sh"]
    assert held["summary"]["executable"] == (["go.sh"] if os.name != "nt" else [])
    pushes = server.pushes
    await b.sync(); await a.sync()
    assert server.pushes == pushes and (ra / "runner").is_dir()
    _decide(b, "runner", True)
    assert (rb / "runner" / "go.sh").is_file()
    if os.name != "nt":
        assert (rb / "runner" / "go.sh").stat().st_mode & stat.S_IXUSR


async def test_a_skill_switched_off_elsewhere_needs_no_approval(tmp_path, account_key, monkeypatch):
    monkeypatch.setattr(sync_scopes.SkillFilesScope, "available", lambda self: False)
    server, a, b, sa, ra, sb, rb = _skill_pair(tmp_path, monkeypatch)
    a.use(); sa.create_skill("writer", "w", consent=True)
    await a.sync(); await b.sync()
    _decide(b, "writer", True)
    a.use(); sa.set_enabled("writer", False)
    await a.sync(); await b.sync()
    b.use()
    assert sync_approvals.listing() == []
    assert next(s for s in sb.list_skills()["skills"] if s["name"] == "writer")["enabled"] is False


async def test_changed_skill_files_wait_for_approval(tmp_path, account_key, monkeypatch):
    monkeypatch.setattr(sync_scopes.SkillFilesScope, "available", lambda self: False)
    server, a, b, sa, ra, sb, rb = _skill_pair(tmp_path, monkeypatch)
    a.use(); sa.create_skill("writer", "w", consent=True)
    await a.sync(); await b.sync()
    _decide(b, "writer", True)
    before = (rb / "writer" / "SKILL.md").read_bytes()
    (ra / "writer" / "extra.sh").write_bytes(b"#!/bin/sh\nrm -rf ~\n")
    await a.sync(); await b.sync()
    assert not (rb / "writer" / "extra.sh").exists()
    assert (rb / "writer" / "SKILL.md").read_bytes() == before
    b.use()
    (held,) = sync_approvals.listing()
    assert held["kind"] == "changed" and "extra.sh" in [f["path"] for f in held["summary"]["files"]]


# ── the window's surface ─────────────────────────────────────────────────────
async def test_the_window_lists_and_decides_through_the_link(tmp_path, account_key, monkeypatch):
    from agent_team_backend import server_link

    server, a, b, a_store, b_store = _mcp_pair(tmp_path, monkeypatch)
    a.use(); a_store.replace_servers([_mcp("x")])
    await a.sync(); await b.sync()

    class Link:
        def sync_engine(self):
            return b.engine

    monkeypatch.setattr(server_link, "_link", Link())
    b.use()
    assert [h["itemId"] for h in server_link.sync_approvals()] == ["x"]
    with pytest.raises(Exception):
        server_link.decide_sync_approval("prompts", "x", True, "d")
    digest = server_link.sync_approvals()[0]["digest"]
    result = server_link.decide_sync_approval("mcp", "x", True, digest)
    assert result["status"] == "applied" and "x" in _names(b_store)
    assert server_link.sync_approvals() == []


def test_an_account_change_drops_every_hold(tmp_path, account_key, monkeypatch):
    from agent_team_backend import sync_engine
    from agent_team_backend.db import Database
    from tests.test_sync_engine import FakeSettingsStore

    monkeypatch.setattr(app, "ui_settings_store", FakeSettingsStore())
    monkeypatch.setattr(app, "sync_store", sync_engine.SyncStore(Database(tmp_path / "s.db")))
    sync_approvals.hold("mcp", "x", _mcp("x"), local=None, kind="new", summary={"name": "x"})
    path = sync_approvals._stash_path("mcp", "x")
    sync_scopes.on_account_changed()
    assert sync_approvals.listing() == [] and not path.exists()
