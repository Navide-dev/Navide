"""Security-review findings on the S3 sync branch, each reproduced first.

D-H1  a restore over a pending pulled hold, then rejected, pushed the old
      local copy over a newer edit from another device.
D-H2  the D3 migration met an unpushed edit or delete on another device and
      read it as a delete (two conflicts, the item lost) instead of a rename.
"""

from __future__ import annotations

import pytest

from agent_team_backend import sync_approvals, sync_engine, sync_keyring, sync_scopes
from agent_team_backend.mcp_settings import MCPSettingsStore
from tests.test_sync_s3_objects import HASHED, V3Device, V3Server, account_key, s3  # noqa: F401 - fixtures
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


# ── D-H2: the D3 migration meets an unpushed change on another device ────────
ALPHA = "alpha-secret-name"


def _live_ids(server) -> list[str]:
    return sorted(k[1] for k, r in server.rows.items() if k[0] == "prompts" and not r["deleted"])


async def test_migration_keeps_an_unpushed_edit_on_the_other_device(tmp_path, account_key, s3):
    from tests.test_sync_hashed_ids import NAMES, _legacy_then_adopted

    server, a, b, _revs, _calls = await _legacy_then_adopted(tmp_path, s3)
    b.reconnect()
    b.adapter.items[ALPHA] = {"v": "b-local-edit"}
    assert (await b.sync())["ok"] is True
    assert b.store.conflicts("prompts") == []
    h1 = sync_keyring.hashed_item_id("prompts", ALPHA, server.item_id_kid)
    assert b.store.state("prompts", ALPHA).wire_id == h1
    assert server.rows[("prompts", h1)]["deviceId"] == "B"  # pushed under h1
    assert b.adapter.items[ALPHA] == {"v": "b-local-edit"}
    await a.sync()
    assert a.adapter.items == {**NAMES, ALPHA: {"v": "b-local-edit"}}
    assert all(HASHED.match(i) for i in _live_ids(server)) and len(_live_ids(server)) == 2
    pushes = server.pushes
    await b.sync(); await a.sync()
    assert server.pushes == pushes and a.store.conflicts("prompts") == []


async def test_migration_keeps_an_unpushed_delete_on_the_other_device(tmp_path, account_key, s3):
    from tests.test_sync_hashed_ids import _legacy_then_adopted

    server, a, b, _revs, _calls = await _legacy_then_adopted(tmp_path, s3)
    b.reconnect()
    del b.adapter.items[ALPHA]
    assert (await b.sync())["ok"] is True
    assert b.store.conflicts("prompts") == []
    h1 = sync_keyring.hashed_item_id("prompts", ALPHA, server.item_id_kid)
    assert server.rows[("prompts", h1)]["deleted"] == 1
    await a.sync(); await b.sync(); await a.sync()
    assert ALPHA not in a.adapter.items and ALPHA not in b.adapter.items
    assert len(_live_ids(server)) == 1


async def _genuine_migration_conflict(tmp_path, s3):
    """A edits alpha and migrates it; B edited it too and has not pushed."""
    from tests.test_sync_hashed_ids import NAMES

    server = V3Server(s3, adopt_ready=False)
    a = V3Device(tmp_path, server, "A", dict(NAMES))
    b = V3Device(tmp_path, server, "B")
    await a.sync(); await b.sync()
    a.adapter.items[ALPHA] = {"v": "a-edit"}
    server.adopt_ready = True
    a.reconnect()
    assert (await a.sync())["ok"] is True
    b.reconnect()
    b.adapter.items[ALPHA] = {"v": "b-edit"}
    await b.sync()
    (conflict,) = b.store.conflicts("prompts")
    assert conflict["itemId"] == ALPHA and conflict["remote"] == {"v": "a-edit"}
    return server, a, b


@pytest.mark.parametrize("keep,winner", [
    (sync_engine.KEEP_REMOTE, {"v": "a-edit"}),
    (sync_engine.KEEP_LOCAL, {"v": "b-edit"}),
])
async def test_a_genuine_migration_conflict_converges_either_way(tmp_path, account_key, s3, keep, winner):
    server, a, b = await _genuine_migration_conflict(tmp_path, s3)
    b.engine.resolve("prompts", ALPHA, keep)
    for _ in range(3):
        await b.sync(); await a.sync()
    assert a.adapter.items[ALPHA] == winner and b.adapter.items[ALPHA] == winner
    assert a.store.conflicts("prompts") == [] and b.store.conflicts("prompts") == []
    assert all(HASHED.match(i) for i in _live_ids(server)) and len(_live_ids(server)) == 2


# ── D-M3: object downloads are capped and presigned URLs must be https ───────
class _BigObjects:
    """Serves ``size`` bytes at any path, Content-Length and all."""

    def __init__(self, size: int) -> None:
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        outer = self
        self.sent = 0

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self):  # noqa: N802
                self.send_response(200)
                self.send_header("Content-Length", str(size))
                self.end_headers()
                chunk = b"x" * 65536
                left = size
                try:
                    while left:
                        n = min(left, len(chunk))
                        self.wfile.write(chunk[:n])
                        outer.sent += n
                        left -= n
                except OSError:
                    pass

            def log_message(self, *_args):
                pass

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.http.server_address[1]}"
        threading.Thread(target=self.http.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.http.shutdown()
        self.http.server_close()


def test_a_download_reads_no_more_than_the_size_it_was_promised():
    from agent_team_backend import sync_objects

    big = _BigObjects(4 * 1024 * 1024)
    try:
        got = sync_objects.get_all([("b1", f"{big.base}/o")], {"b1": 100})
        assert len(got["b1"]) == 101
        with pytest.raises(sync_engine.SyncError, match="OBJECT_INTEGRITY"):
            sync_engine._fetch_verified([("b1", f"{big.base}/o")], {"b1": 100})
    finally:
        big.close()


def test_a_download_never_reads_past_the_record_limit():
    from agent_team_backend import sync_objects

    cap = sync_engine.MAX_BODY_BYTES
    big = _BigObjects(cap + 4096)
    try:
        got = sync_objects.get_all([("b1", f"{big.base}/o")], {"b1": cap + 4096})
        assert len(got["b1"]) == cap + 1
    finally:
        big.close()


@pytest.mark.parametrize("url", [
    "http://bucket.example.com/o?sig=1", "ftp://bucket.example.com/o", "file:///etc/passwd", "//x/o",
])
def test_a_presigned_url_that_is_not_https_is_refused(url, monkeypatch):
    from agent_team_backend import sync_objects

    def no_network(*_a, **_k):
        raise AssertionError("no request may be made")

    monkeypatch.setattr(sync_objects._POOL, "request", no_network)
    with pytest.raises(sync_objects.ObjectError, match="https"):
        sync_objects.get_all([("b1", url)], {"b1": 10})
    with pytest.raises(sync_objects.ObjectError, match="https"):
        sync_objects.put_all([(url, b"sealed")])


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "[::1]"])
def test_plain_http_is_allowed_on_loopback_only(host, monkeypatch):
    from agent_team_backend import sync_objects

    monkeypatch.setattr(sync_objects._POOL, "request", lambda *a, **k: (200, b"ok"))
    assert sync_objects.get_all([("b1", f"http://{host}:9/o")], {"b1": 10}) == {"b1": b"ok"}
    sync_objects.put_all([(f"http://{host}:9/o", b"sealed")])
    assert sync_objects.get_all([("b1", "https://bucket.example.com/o")], {"b1": 10}) == {"b1": b"ok"}


# ── D-L2: restore says what actually happened ────────────────────────────────
async def _prompt_versions(tmp_path, s3, values):
    server = V3Server(s3, adopt_ready=True)
    a = V3Device(tmp_path, server, "A", {"p1": values[0]})
    await a.sync()
    for v in values[1:]:
        a.adapter.items["p1"] = v
        assert (await a.sync())["ok"] is True
    return server, a


async def test_a_restore_that_lands_reads_applied(tmp_path, account_key, s3):
    _server, a = await _prompt_versions(tmp_path, s3, [{"v": 0}, {"v": 1}])
    (old,) = await a.engine.versions("prompts", "p1")
    result = await a.engine.restore("prompts", "p1", old["rev"])
    assert result["outcome"] == "applied" and result["held"] is False
    assert a.adapter.items["p1"] == {"v": 0}


async def test_a_restore_of_the_copy_already_here_reads_not_applied(tmp_path, account_key, s3):
    _server, a = await _prompt_versions(tmp_path, s3, [{"v": 0}, {"v": 1}, {"v": 0}])
    oldest = (await a.engine.versions("prompts", "p1"))[-1]
    result = await a.engine.restore("prompts", "p1", oldest["rev"])
    assert result["outcome"] == "not-applied" and result["held"] is False


async def test_a_restore_the_adapter_declines_reads_not_applied(tmp_path, account_key, s3, monkeypatch):
    _server, a = await _prompt_versions(tmp_path, s3, [{"v": 0}, {"v": 1}])
    (old,) = await a.engine.versions("prompts", "p1")
    monkeypatch.setattr(a.adapter, "apply", lambda _i, _p: False)
    result = await a.engine.restore("prompts", "p1", old["rev"])
    assert result["outcome"] == "not-applied" and result["held"] is False
    assert a.adapter.items["p1"] == {"v": 1}


async def test_a_held_restore_reads_held(tmp_path, account_key, s3, monkeypatch):
    from agent_team_backend import app

    monkeypatch.setattr(app, "app_data_dir", lambda: tmp_path / "app-data")
    server = V3Server(s3, adopt_ready=True)
    store = MCPSettingsStore(tmp_path / "a.json")
    a = Dev(tmp_path, server, "A", monkeypatch, sync_scopes.McpScope(), mcp_settings_store=store)
    a.engine._request = lambda t, p: server.handle("A", t, p)
    a.use()
    store.replace_servers([{**_mcp("runner"), "command": "/usr/bin/first"}]); await a.sync()
    store.replace_servers([{**_mcp("runner"), "command": "/usr/bin/second"}]); await a.sync()
    (old,) = await a.engine.versions("mcp", "runner")
    result = await a.engine.restore("mcp", "runner", old["rev"])
    assert result["outcome"] == "held" and result["held"] is True


# ── D-L3: HMAC_NOT_READY names the devices it waits for ──────────────────────
@pytest.mark.parametrize("shape", ["object", "list"])
async def test_a_refused_adoption_logs_the_devices_it_waits_for(tmp_path, account_key, s3, caplog, shape):
    import logging

    server = V3Server(s3, adopt_ready=False)
    a = V3Device(tmp_path, server, "A", {"p1": {"v": 0}})
    devices = [{"deviceId": "dev-old", "deviceName": "Old laptop", "lastSeenAt": "2026-10-01T00:00:00Z"}]
    details = {"blockingDevices": devices} if shape == "object" else devices
    real = a.engine._request

    async def request(msg_type, payload):
        if msg_type == "sync.adoptHmacIds":
            return {"ok": False, "error": {"code": "HMAC_NOT_READY", "message": "", "details": details}}
        return await real(msg_type, payload)

    a.engine._request = request
    with caplog.at_level(logging.INFO, logger="agent_team_backend"):
        assert (await a.sync())["ok"] is True
    assert "waiting for dev-old" in caplog.text


# ── contract c6: conditional PUT, GC race ────────────────────────────────────
def test_a_put_of_a_key_already_written_counts_as_uploaded(s3):
    """412 means the object is there (a retried PUT whose first answer was
    lost): carry on to blobs.commit, which checks its size."""
    from agent_team_backend import sync_objects

    url = s3.url("b" * 64)
    sync_objects.put_all([(url, b"sealed")])
    sync_objects.put_all([(url, b"sealed")])
    assert s3.precondition_failed == ["b" * 64]
    assert s3.objects["b" * 64] == b"sealed"


async def test_storage_unavailable_on_push_fails_the_round_and_the_next_one_lands(tmp_path, account_key, s3):
    server = V3Server(s3)
    a = V3Device(tmp_path, server, "A", {"p1": {"v": 1}})
    original = server.handle
    state = {"left": 1}

    async def gc_race(device, msg_type, payload):
        if msg_type == "sync.push" and state["left"]:
            state["left"] -= 1
            return {"ok": False, "error": {"code": "STORAGE_UNAVAILABLE", "message": "gc"}}
        return await original(device, msg_type, payload)

    server.handle = gc_race
    result = await a.sync()
    assert result["ok"] is False and "STORAGE_UNAVAILABLE" in result["error"]
    assert a.store.state("prompts", "p1") is None
    assert (await a.sync())["ok"] is True
    assert server.rows[("prompts", "p1")]["objectRef"]
