"""MCP sync is install-only (0.2.32): server definitions travel, env and
header values never leave the machine, and a record that arrives keeps the
values this machine already has.

Install-only records travel as ``i:<name>``; the ``<name>`` rows builds before
0.2.32 keep (values and all) are read but never written or deleted, so an
older device never has its values emptied, and it cannot open an ``i:`` row."""

from __future__ import annotations

import json

from agent_team_backend import sync_approvals, sync_keyring, sync_scopes
from agent_team_backend.mcp_settings import MCPSettingsStore
from tests.test_sync_scope_adapters import Dev, StrictServer, _approve_everything, account_key  # noqa: F401

# Built by concatenation so no scanner reads them as real tokens.
SECRET_A = "sk-" + "from-a-0001"
SECRET_B = "sk-" + "from-b-0002"


class OldMcpScope(sync_scopes.McpScope):
    """What a build before 0.2.32 does: every server under its own name,
    values and all, written in as it comes."""

    def __init__(self):
        super().__init__(keep_local_values=False)

    def snapshot(self):
        return sync_approvals.overlay(self.scope, self.local_snapshot())

    def inbound(self, payload):
        return payload

    def pushes(self, item_id):
        return True

    def superseded_by(self, item_id):
        return ""

    def seal_scope(self, wire_id):
        return self.scope


def _api(env=None, headers=None, **extra):
    if headers is not None:
        return {"name": "api", "transport": "http", "url": "https://mcp.example.test", "enabled": True,
                "headers": dict(headers)}
    record = {"name": "api", "transport": "stdio", "command": "npx", "args": ["api"], "enabled": True,
              "env": dict(env or {})}
    record.update(extra)
    return record


def _named(store, name="api"):
    # A fresh store also holds its default server.
    return next((s for s in store.list_servers() if s["name"] == name), None)


def _row(server, item_id):
    return server.rows.get(("mcp", item_id))


def _body(server, item_id):
    row = _row(server, item_id)
    scope = sync_scopes.INSTALL_SEAL_SCOPE if item_id.startswith(sync_scopes.INSTALL_PREFIX) else "mcp"
    return json.loads(sync_keyring.decrypt(row["body"], scope=scope, item_id=item_id))


def _dev(tmp_path, monkeypatch, server, name, adapter=None):
    store = MCPSettingsStore(tmp_path / f"{name}.json")
    dev = Dev(tmp_path, server, name, monkeypatch, adapter or sync_scopes.McpScope(), mcp_settings_store=store)
    return dev, store


def _set(dev, store, *servers):
    dev.use()
    store.replace_servers(list(servers))


async def test_values_never_go_up_and_no_older_row_is_written(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    a, a_store = _dev(tmp_path, monkeypatch, server, "A")
    _set(a, a_store, _api(env={"API_KEY": SECRET_A, "REGION": "eu"}))
    await a.sync()
    assert _row(server, "api") is None
    body = _body(server, "i:api")
    assert body["env"] == {"API_KEY": "", "REGION": ""} and body["args"] == ["api"]
    assert SECRET_A not in repr(server.rows) and SECRET_A not in repr(body)

    _set(a, a_store, _api(headers={"Authorization": "Bearer " + SECRET_A}))
    await a.sync()
    assert _body(server, "i:api")["headers"] == {"Authorization": ""}


async def test_a_value_change_alone_is_not_pushed(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    a, a_store = _dev(tmp_path, monkeypatch, server, "A")
    _set(a, a_store, _api(env={"API_KEY": SECRET_A}))
    await a.sync()
    rev = _row(server, "i:api")["rev"]
    _set(a, a_store, _api(env={"API_KEY": SECRET_B}))
    await a.sync()
    assert _row(server, "i:api")["rev"] == rev


async def test_a_new_server_arrives_with_its_fields_empty(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    a, a_store = _dev(tmp_path, monkeypatch, server, "A")
    b, b_store = _dev(tmp_path, monkeypatch, server, "B")
    _set(a, a_store, _api(env={"API_KEY": SECRET_A}))
    await a.sync()
    await b.sync()
    landed = _named(b_store)
    assert landed["env"] == {"API_KEY": ""} and landed["args"] == ["api"]


async def test_a_changed_definition_keeps_this_machines_values(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    a, a_store = _dev(tmp_path, monkeypatch, server, "A")
    b, b_store = _dev(tmp_path, monkeypatch, server, "B")
    _set(a, a_store, _api(env={"API_KEY": SECRET_A}))
    await a.sync(); await b.sync()
    _set(b, b_store, _api(env={"API_KEY": SECRET_B}))
    await b.sync()
    _set(a, a_store, _api(env={"API_KEY": SECRET_A, "EXTRA": "1"}, args=["api", "--fast"]))
    await a.sync(); await b.sync()
    landed = _named(b_store)
    assert landed["args"] == ["api", "--fast"]
    assert landed["env"] == {"API_KEY": SECRET_B, "EXTRA": ""}
    assert not b.store.conflicts("mcp")


async def test_an_older_row_is_read_as_a_definition_until_the_install_row_exists(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    old, old_store = _dev(tmp_path, monkeypatch, server, "OLD", OldMcpScope())
    new, new_store = _dev(tmp_path, monkeypatch, server, "NEW", OldMcpScope())
    _set(old, old_store, _api(env={"API_KEY": SECRET_A}))
    await old.sync(); await new.sync()  # both on an older build, in sync
    _set(new, new_store, _api(env={"API_KEY": SECRET_B}))
    new.adapter = sync_scopes.McpScope()  # NEW upgrades
    new.engine.register(new.adapter)
    _set(old, old_store, _api(env={"API_KEY": SECRET_A}, args=["api", "--old"]))
    await old.sync()
    legacy_rev = _row(server, "api")["rev"]

    await new.sync()  # no i: row yet: the older row is read, its value is not
    new.use()
    landed = _named(new_store)
    assert landed["args"] == ["api", "--old"] and landed["env"] == {"API_KEY": SECRET_B}
    assert _body(server, "i:api")["args"] == ["api", "--old"]
    assert SECRET_B not in repr(server.rows)
    assert _row(server, "api")["rev"] == legacy_rev and SECRET_A in repr(_body(server, "api"))

    # The i: row exists now and wins: a later change on the older row is not read.
    _set(old, old_store, _api(env={"API_KEY": SECRET_A}, args=["api", "--older-again"]))
    await old.sync()
    await new.sync()
    new.use()
    assert _named(new_store)["args"] == ["api", "--old"]
    assert not new.store.conflicts("mcp")


async def test_an_older_device_keeps_its_values_and_its_row(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    old, old_store = _dev(tmp_path, monkeypatch, server, "OLD", OldMcpScope())
    new, new_store = _dev(tmp_path, monkeypatch, server, "NEW")
    _set(old, old_store, _api(env={"API_KEY": SECRET_A}))
    await old.sync(); await new.sync()
    legacy = dict(_row(server, "api"))

    # The newer device edits, then deletes: only its i: row moves.
    _set(new, new_store, _api(env={"API_KEY": SECRET_B}, args=["api", "--new"]))
    await new.sync(); await old.sync(); await old.sync()
    old.use()
    assert _named(old_store)["args"] == ["api"] and _named(old_store)["env"] == {"API_KEY": SECRET_A}
    assert _row(server, "api") == legacy

    new.use()
    new_store.replace_servers([s for s in new_store.list_servers() if s["name"] != "api"])
    await new.sync(); await old.sync()
    assert _row(server, "i:api")["deleted"]
    assert _row(server, "api") == legacy
    old.use()
    assert _named(old_store)["env"] == {"API_KEY": SECRET_A}
    new.use()
    assert _named(new_store) is None


async def test_an_older_device_cannot_open_an_install_row_so_never_deletes_it(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    new, new_store = _dev(tmp_path, monkeypatch, server, "NEW")
    old, old_store = _dev(tmp_path, monkeypatch, server, "OLD", OldMcpScope())
    _set(new, new_store, _api(env={"API_KEY": SECRET_B}))
    await new.sync()
    rev = _row(server, "i:api")["rev"]
    for _ in range(2):
        await old.sync()
    assert old.store.state("mcp", "i:api") is None
    assert _row(server, "i:api")["rev"] == rev and not _row(server, "i:api")["deleted"]
    old.use()
    assert _named(old_store) is None


async def test_an_upgrade_pushes_nothing_secret_and_leaves_the_older_row(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    a, a_store = _dev(tmp_path, monkeypatch, server, "A", OldMcpScope())
    _set(a, a_store, _api(env={"API_KEY": SECRET_A}))
    await a.sync()
    legacy = dict(_row(server, "api"))
    a.adapter = sync_scopes.McpScope()  # the same machine after the upgrade
    a.engine.register(a.adapter)
    await a.sync(); await a.sync()
    assert _row(server, "api") == legacy
    assert SECRET_A not in repr(_body(server, "i:api"))
    rev = _row(server, "i:api")["rev"]
    await a.sync()
    assert _row(server, "i:api")["rev"] == rev
    assert not a.store.conflicts("mcp")
    a.use()
    assert _named(a_store)["env"] == {"API_KEY": SECRET_A}


def test_a_settings_bundle_import_writes_the_values_it_was_given(tmp_path, monkeypatch):
    from agent_team_backend import app

    store = MCPSettingsStore(tmp_path / "mcp.json")
    store.replace_servers([_api(env={"API_KEY": SECRET_B})])
    monkeypatch.setattr(app, "mcp_settings_store", store)
    scope = sync_scopes.McpScope(gate=False, keep_local_values=False)
    scope.apply("api", _api(env={"API_KEY": ""}))
    assert _named(store)["env"] == {"API_KEY": ""}


# Credentials inside the url or the args (#659's value rules) stay local too.
GHP = "gh" + "p_" + "A" * 36
SK = "sk-" + "c" * 24


def _remote(url):
    return {"name": "remote", "transport": "http", "url": url, "enabled": True, "headers": {}}


def _cli(args):
    return {"name": "cli", "transport": "stdio", "command": "npx", "args": list(args), "enabled": True, "env": {}}


class PreStripMcpScope(sync_scopes.McpScope):
    """A 0.2.32 build before url and args were stripped: ``i:`` rows with env
    and header values empty but the url and args as written."""

    def snapshot(self):
        def env_only(server):
            out = dict(server)
            for field_name in ("env", "headers"):
                if isinstance(out.get(field_name), dict):
                    out[field_name] = {k: "" for k in out[field_name]}
            return out
        local = self.local_snapshot()
        by_id = {sync_scopes.INSTALL_PREFIX + name: server for name, server in local.items()}
        by_id.update(local)
        return {item_id: env_only(s) for item_id, s in sync_approvals.overlay(self.scope, by_id).items()}


def test_detected_credentials_are_emptied_in_place():
    url = "https://user:" + "pa55word@mcp.example.test/v1?api_key=" + "abc123&region=eu"
    assert sync_scopes._install_only(_remote(url))["url"] == "https://@mcp.example.test/v1?api_key=&region=eu"
    args = ["-y", "srv", GHP, SK, "--token", "tok" + "123", "--api-key=" + SK, "X-Api-Key: " + "abc"]
    assert sync_scopes._install_only(_cli(args))["args"] == ["-y", "srv", "", "", "--token", "", "--api-key=", "X-Api-Key:"]


def test_plain_args_and_urls_travel_exactly_as_written():
    args = ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/dir", "--port", "8080",
            "--verbose", "https://h.test/a?q=b%20c&page=2", "key-value-store", "--tokenizer=cl100k"]
    assert sync_scopes._install_only(_cli(args)) == _cli(args)
    for url in ("https://mcp.example.test/v1?region=eu&x=a+b", "HTTPS://Host.test:8443/mcp#frag", "https://h.test/?"):
        assert sync_scopes._install_only(_remote(url)) == _remote(url)


async def test_url_and_arg_credentials_never_go_up_and_the_local_copy_is_untouched(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    a, a_store = _dev(tmp_path, monkeypatch, server, "A")
    url = "https://me:" + "pa55@mcp.example.test/v1?api_key=" + SK
    args = ["-y", "srv", GHP, "--token", "tok" + "123"]
    _set(a, a_store, _remote(url), _cli(args))
    await a.sync()
    assert _body(server, "i:remote")["url"] == "https://@mcp.example.test/v1?api_key="
    assert _body(server, "i:cli")["args"] == ["-y", "srv", "", "--token", ""]
    for secret in (SK, GHP, "pa55", "tok" + "123"):
        assert secret not in repr(server.rows)
    a.use()
    assert _named(a_store, "remote")["url"] == url and _named(a_store, "cli")["args"] == args
    rev = _row(server, "i:cli")["rev"]
    _set(a, a_store, _remote(url), _cli(["-y", "srv", "gh" + "p_" + "B" * 36, "--token", "other"]))
    await a.sync()
    assert _row(server, "i:cli")["rev"] == rev  # a credential change alone is not pushed


async def test_a_round_trip_keeps_each_machines_own_credentials(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    a, a_store = _dev(tmp_path, monkeypatch, server, "A")
    b, b_store = _dev(tmp_path, monkeypatch, server, "B")
    url_a = "https://a:" + "one@mcp.example.test/v1?api_key=" + "aaa"
    url_b = "https://b:" + "two@mcp.example.test/v1?api_key=" + "bbb"
    _set(a, a_store, _remote(url_a), _cli(["srv", "--token", "tok-a"]))
    await a.sync()
    await b.sync()
    b.use()
    # New here: the credentials land empty, for the MCP page to ask about.
    assert _named(b_store, "remote")["url"] == "https://@mcp.example.test/v1?api_key="
    assert _named(b_store, "cli")["args"] == ["srv", "--token", ""]

    _set(b, b_store, _remote(url_b), _cli(["srv", "--token", "tok-b"]))
    await b.sync()
    _set(a, a_store, _remote(url_a + "&region=eu"), _cli(["srv", "--token", "tok-a", "--fast"]))
    await a.sync(); await b.sync()
    b.use()
    # The url changed around the credential, so B's is not handed to it.
    assert _named(b_store, "remote")["url"] == "https://@mcp.example.test/v1?api_key=&region=eu"
    assert _named(b_store, "cli")["args"] == ["srv", "--token", "tok-b", "--fast"]
    assert not b.store.conflicts("mcp")

    _set(a, a_store, _remote(url_a + "&region=eu"), _cli(["srv", "--token", "tok-a", "--fast", "--log"]))
    _set(b, b_store, _remote(url_b + "&region=eu"), _cli(["srv", "--token", "tok-b", "--fast"]))
    await b.sync(); await a.sync(); await b.sync()
    a.use()
    assert _named(a_store, "remote")["url"] == url_a + "&region=eu"
    assert _named(a_store, "cli")["args"] == ["srv", "--token", "tok-a", "--fast", "--log"]
    b.use()
    assert _named(b_store, "remote")["url"] == url_b + "&region=eu"
    assert _named(b_store, "cli")["args"] == ["srv", "--token", "tok-b", "--fast", "--log"]
    assert not a.store.conflicts("mcp") and not b.store.conflicts("mcp")


async def test_an_older_install_row_with_a_credential_keeps_this_machines_value(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    pre, pre_store = _dev(tmp_path, monkeypatch, server, "PRE", PreStripMcpScope())
    new, new_store = _dev(tmp_path, monkeypatch, server, "NEW")
    fresh, fresh_store = _dev(tmp_path, monkeypatch, server, "FRESH")
    _set(new, new_store, _cli(["srv", "--token", "mine", "--a"]))
    await new.sync(); await pre.sync()
    _set(pre, pre_store, _cli(["srv", "--token", "theirs", "--b"]))
    await pre.sync()
    assert "theirs" in repr(_body(server, "i:cli"))
    await new.sync(); await fresh.sync()
    new.use()
    assert _named(new_store, "cli")["args"] == ["srv", "--token", "mine", "--b"]
    fresh.use()
    assert _named(fresh_store, "cli")["args"] == ["srv", "--token", "", "--b"]
    for dev in (new, fresh):  # FRESH still holds the default server NEW dropped
        assert not [c for c in dev.store.conflicts("mcp") if c["itemId"] == "i:cli"]


async def test_an_upgrade_with_url_credentials_pushes_nothing_secret_and_no_conflict(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    url = "https://me:" + "pa55@mcp.example.test/v1?api_key=" + SK
    a, a_store = _dev(tmp_path, monkeypatch, server, "A", OldMcpScope())
    b, b_store = _dev(tmp_path, monkeypatch, server, "B", OldMcpScope())
    _set(a, a_store, _remote(url))
    await a.sync(); await b.sync()
    legacy = dict(_row(server, "remote"))
    a.adapter = sync_scopes.McpScope()
    a.engine.register(a.adapter)
    await a.sync(); await a.sync()
    assert _row(server, "remote") == legacy
    assert SK not in repr(_body(server, "i:remote")) and "pa55" not in repr(_body(server, "i:remote"))
    rev = _row(server, "i:remote")["rev"]
    await a.sync()
    assert _row(server, "i:remote")["rev"] == rev
    assert not a.store.conflicts("mcp")
    a.use()
    assert _named(a_store, "remote")["url"] == url


async def test_a_pre_strip_build_upgrading_resends_its_row_once_without_the_credential(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    a, a_store = _dev(tmp_path, monkeypatch, server, "A", PreStripMcpScope())
    b, b_store = _dev(tmp_path, monkeypatch, server, "B")
    _set(a, a_store, _cli(["srv", "--token", "tok-a"]))
    await a.sync(); await b.sync()
    b.use()
    assert _named(b_store, "cli")["args"] == ["srv", "--token", ""]
    b_rev = b.store.state("mcp", "i:cli").rev
    a.adapter = sync_scopes.McpScope()
    a.engine.register(a.adapter)
    await a.sync()
    assert "tok-a" not in repr(_body(server, "i:cli"))
    rev = _row(server, "i:cli")["rev"]
    await a.sync(); await b.sync()
    assert _row(server, "i:cli")["rev"] == rev
    assert b.store.state("mcp", "i:cli").rev != b_rev  # B took the re-send, unchanged for it
    for dev in (a, b):
        assert not [c for c in dev.store.conflicts("mcp") if c["itemId"] == "i:cli"]
    a.use()
    assert _named(a_store, "cli")["args"] == ["srv", "--token", "tok-a"]
    b.use()
    assert _named(b_store, "cli")["args"] == ["srv", "--token", ""]
