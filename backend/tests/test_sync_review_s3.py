"""Security-review findings on the S3 sync branch, each reproduced first.

D-H1  a restore over a pending pulled hold, then rejected, pushed the old
      local copy over a newer edit from another device.
"""

from __future__ import annotations

import pytest

from agent_team_backend import sync_approvals, sync_engine, sync_scopes
from agent_team_backend.mcp_settings import MCPSettingsStore
from tests.test_sync_s3_objects import V3Server, account_key, s3  # noqa: F401 - fixtures
from tests.test_sync_scope_adapters import Dev, _mcp


def _runs(store: MCPSettingsStore) -> dict[str, str]:
    return {s["name"]: s["command"] for s in store.list_servers()}


async def _b_holds_third(tmp_path, s3, monkeypatch):
    """A pushes first, second, third; B runs second and holds third."""
    server = V3Server(s3, adopt_ready=True)
    sa, sb = MCPSettingsStore(tmp_path / "a.json"), MCPSettingsStore(tmp_path / "b.json")
    a = Dev(tmp_path, server, "A", monkeypatch, sync_scopes.McpScope(), mcp_settings_store=sa)
    b = Dev(tmp_path, server, "B", monkeypatch, sync_scopes.McpScope(), mcp_settings_store=sb)
    a.engine._request = lambda t, p: server.handle("A", t, p)
    b.engine._request = lambda t, p: server.handle("B", t, p)
    a.use(); sa.replace_servers([{**_mcp("runner"), "command": "/usr/bin/first"}]); await a.sync()
    a.use(); sa.replace_servers([{**_mcp("runner"), "command": "/usr/bin/second"}]); await a.sync()
    await b.sync(); b.use()
    (row,) = [h for h in sync_approvals.listing() if h["itemId"] == "runner"]
    sync_approvals.decide(b.adapter, "runner", True, row["digest"])
    await b.sync()
    assert _runs(sb)["runner"] == "/usr/bin/second"
    a.use(); sa.replace_servers([{**_mcp("runner"), "command": "/usr/bin/third"}]); await a.sync()
    await b.sync(); b.use()
    assert sync_approvals.entry("mcp", "runner")["status"] == "pending"
    return server, a, b, sa, sb


# ── D-H1 ─────────────────────────────────────────────────────────────────────
async def test_restore_is_refused_while_an_incoming_change_waits_for_approval(
    tmp_path, account_key, s3, monkeypatch
):
    server, a, b, sa, sb = await _b_holds_third(tmp_path, s3, monkeypatch)
    pending = sync_approvals.entry("mcp", "runner")
    pushes = server.pushes
    b.use()
    oldest = (await b.engine.versions("mcp", "runner"))[-1]
    with pytest.raises(sync_engine.SyncError) as err:
        await b.engine.restore("mcp", "runner", oldest["rev"])
    assert err.value.code == "RESTORE_BLOCKED"
    # The pulled hold is untouched and nothing goes up over "third".
    assert sync_approvals.entry("mcp", "runner") == pending
    await b.sync()
    assert server.pushes == pushes
    a.use(); await a.sync()
    assert _runs(sa)["runner"] == "/usr/bin/third"
    assert _runs(sb)["runner"] == "/usr/bin/second"
