"""MCP sync is install-only (0.2.32): server definitions travel, env and
header values never leave the machine, and a record that arrives keeps the
values this machine already has. Records older builds pushed — values and all
— still open and do not make every server read as edited after an upgrade."""

from __future__ import annotations

import json

from agent_team_backend import sync_keyring, sync_scopes
from agent_team_backend.mcp_settings import MCPSettingsStore
from tests.test_sync_scope_adapters import Dev, StrictServer, _approve_everything, account_key  # noqa: F401

# Built by concatenation so no scanner reads them as real tokens.
SECRET_A = "sk-" + "from-a-0001"
SECRET_B = "sk-" + "from-b-0002"


def _api(env=None, headers=None, **extra):
    record = {"name": "api", "transport": "stdio", "command": "npx", "args": ["api"], "enabled": True,
              "env": dict(env or {})}
    record.update(extra)
    if headers is not None:
        record = {"name": "api", "transport": "http", "url": "https://mcp.example.test", "enabled": True,
                  "headers": dict(headers)}
    return record


def _bodies(server):
    return [
        json.loads(sync_keyring.decrypt(row["body"], scope=scope, item_id=item_id))
        for (scope, item_id), row in server.rows.items()
        if scope == "mcp" and row.get("body")
    ]


def _named(store, name="api"):
    # A fresh store also holds its default server.
    return next(s for s in store.list_servers() if s["name"] == name)


def _pair(tmp_path, monkeypatch, server):
    a_store, b_store = MCPSettingsStore(tmp_path / "a.json"), MCPSettingsStore(tmp_path / "b.json")
    a = Dev(tmp_path, server, "A", monkeypatch, sync_scopes.McpScope(), mcp_settings_store=a_store)
    b = Dev(tmp_path, server, "B", monkeypatch, sync_scopes.McpScope(), mcp_settings_store=b_store)
    return a, a_store, b, b_store


def _old_build(monkeypatch):
    """Make McpScope send what builds before 0.2.32 sent: values included."""
    monkeypatch.setattr(sync_scopes.McpScope, "snapshot", sync_scopes.McpScope.former_snapshot)
    monkeypatch.setattr(sync_scopes.McpScope, "inbound", lambda _self, payload: payload)


async def test_env_and_header_values_never_go_up(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    a, a_store, _b, _ = _pair(tmp_path, monkeypatch, server)
    a_store.replace_servers([_api(env={"API_KEY": SECRET_A, "REGION": "eu"})])
    await a.sync()
    (body,) = _bodies(server)
    assert body["env"] == {"API_KEY": "", "REGION": ""}
    assert body["command"] == "npx" and body["args"] == ["api"]
    assert SECRET_A not in repr(server.rows)

    a.use()
    a_store.replace_servers([_api(headers={"Authorization": "Bearer " + SECRET_A})])
    await a.sync()
    (body,) = _bodies(server)
    assert body["headers"] == {"Authorization": ""}
    assert SECRET_A not in repr(_bodies(server))


async def test_a_value_change_alone_is_not_pushed(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    a, a_store, _b, _ = _pair(tmp_path, monkeypatch, server)
    a_store.replace_servers([_api(env={"API_KEY": SECRET_A})])
    await a.sync()
    rev = server.rows[("mcp", "api")]["rev"]
    a.use()
    a_store.replace_servers([_api(env={"API_KEY": SECRET_B})])
    await a.sync()
    assert server.rows[("mcp", "api")]["rev"] == rev


async def test_a_new_server_arrives_with_its_fields_empty(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    a, a_store, b, b_store = _pair(tmp_path, monkeypatch, server)
    a_store.replace_servers([_api(env={"API_KEY": SECRET_A})])
    await a.sync()
    await b.sync()
    landed = _named(b_store)
    assert landed["env"] == {"API_KEY": ""}
    assert landed["args"] == ["api"]


async def test_a_changed_definition_keeps_this_machines_values(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    a, a_store, b, b_store = _pair(tmp_path, monkeypatch, server)
    a_store.replace_servers([_api(env={"API_KEY": SECRET_A})])
    await a.sync()
    await b.sync()
    b.use()
    b_store.replace_servers([_api(env={"API_KEY": SECRET_B})])
    await b.sync()  # a value change: nothing goes up

    a.use()
    a_store.replace_servers([_api(env={"API_KEY": SECRET_A, "EXTRA": "1"}, args=["api", "--fast"])])
    await a.sync()
    await b.sync()
    landed = _named(b_store)
    assert landed["args"] == ["api", "--fast"]
    assert landed["env"] == {"API_KEY": SECRET_B, "EXTRA": ""}
    assert not b.store.conflicts("mcp")


async def test_values_an_older_build_pushed_are_ignored(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    a, a_store, b, b_store = _pair(tmp_path, monkeypatch, server)
    b_store.replace_servers([_api(env={"API_KEY": SECRET_B})])
    with monkeypatch.context() as old:
        _old_build(old)
        a_store.replace_servers([_api(env={"API_KEY": SECRET_A})])
        await a.sync()
    assert SECRET_A in repr(_bodies(server))  # what an older build did
    rev = server.rows[("mcp", "api")]["rev"]

    await b.sync()
    landed = _named(b_store)
    assert landed["env"] == {"API_KEY": SECRET_B}
    assert not b.store.conflicts("mcp")
    await b.sync()
    assert server.rows[("mcp", "api")]["rev"] == rev  # no push back over the old build's copy


async def test_an_upgrade_alone_pushes_nothing(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    a, a_store, _b, _ = _pair(tmp_path, monkeypatch, server)
    a_store.replace_servers([_api(env={"API_KEY": SECRET_A})])
    with monkeypatch.context() as old:
        _old_build(old)
        await a.sync()
    rev = server.rows[("mcp", "api")]["rev"]
    await a.sync()  # the same machine after the upgrade
    assert server.rows[("mcp", "api")]["rev"] == rev
    await a.sync()
    assert server.rows[("mcp", "api")]["rev"] == rev

    a.use()
    a_store.replace_servers([_api(env={"API_KEY": SECRET_A}, args=["api", "--v2"])])
    await a.sync()  # a real edit still goes up, without the value
    assert server.rows[("mcp", "api")]["rev"] > rev
    assert SECRET_A not in repr(_bodies(server))


def test_a_settings_bundle_import_writes_the_values_it_was_given(tmp_path, monkeypatch):
    from agent_team_backend import app

    store = MCPSettingsStore(tmp_path / "mcp.json")
    store.replace_servers([_api(env={"API_KEY": SECRET_B})])
    monkeypatch.setattr(app, "mcp_settings_store", store)
    scope = sync_scopes.McpScope(gate=False, keep_local_values=False)
    scope.apply("api", _api(env={"API_KEY": ""}))
    assert _named(store)["env"] == {"API_KEY": ""}
