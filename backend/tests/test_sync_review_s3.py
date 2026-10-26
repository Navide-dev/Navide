"""Security-review findings on the S3 sync branch, each reproduced first.

D-H1  a restore over a pending pulled hold, then rejected, pushed the old
      local copy over a newer edit from another device.
D-H2  the D3 migration met an unpushed edit or delete on another device and
      read it as a delete (two conflicts, the item lost) instead of a rename.
D-M3  object downloads were uncapped and any URL scheme was followed.
D-L2  a restore that applied nothing still read as restored.
D-L3  HMAC_NOT_READY's {blockingDevices: [...]} was read as a list.
c5    the two halves of a D3 migration are judged separately.
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
    (row,) = [h for h in sync_approvals.listing() if h["itemId"] in ("runner", "i:" + "runner")]
    sync_approvals.decide(b.adapter, row["itemId"], True, row["digest"])
    await b.sync()
    assert _runs(sb)["runner"] == "/usr/bin/second"
    a.use(); sa.replace_servers([{**_mcp("runner"), "command": "/usr/bin/third"}]); await a.sync()
    await b.sync(); b.use()
    assert sync_approvals.entry("mcp", "i:runner")["status"] == "pending"
    return server, a, b, sa, sb


# ── D-H1 ─────────────────────────────────────────────────────────────────────
async def test_restore_is_refused_while_an_incoming_change_waits_for_approval(
    tmp_path, account_key, s3, monkeypatch
):
    server, a, b, sa, sb = await _b_holds_third(tmp_path, s3, monkeypatch)
    pending = sync_approvals.entry("mcp", "i:runner")
    pushes = server.pushes
    b.use()
    oldest = (await b.engine.versions("mcp", "i:runner"))[-1]
    with pytest.raises(sync_engine.SyncError) as err:
        await b.engine.restore("mcp", "i:runner", oldest["rev"])
    assert err.value.code == "RESTORE_BLOCKED"
    # The pulled hold is untouched and nothing goes up over "third".
    assert sync_approvals.entry("mcp", "i:runner") == pending
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
    (old,) = await a.engine.versions("mcp", "i:runner")
    result = await a.engine.restore("mcp", "i:runner", old["rev"])
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


# ── contract c5: the two halves of a migration are judged separately ─────────
class _PickyServer(V3Server):
    """Turns away the pushed items ``refuse`` names, once each, as rejected;
    ``before_push`` runs ahead of a device's next push."""

    def __init__(self, s3, **kw) -> None:
        super().__init__(s3, **kw)
        self.refuse: set[str] = set()
        self.before_push = None

    async def handle(self, device, msg_type, payload):
        if msg_type == "sync.push" and self.before_push is not None:
            hook, self.before_push = self.before_push, None
            await hook()
        turned = [i for i in payload.get("items", []) if msg_type == "sync.push" and i["itemId"] in self.refuse]
        if not turned:
            return await super().handle(device, msg_type, payload)
        self.refuse -= {i["itemId"] for i in turned}
        reply = await super().handle(device, msg_type, {**payload, "items": [
            i for i in payload["items"] if i not in turned
        ]})
        if reply.get("ok"):
            reply["payload"]["rejected"] = [{"itemId": i["itemId"], "code": "QUOTA_EXCEEDED"} for i in turned]
        return reply


async def _legacy_pair(tmp_path, s3):
    from tests.test_sync_hashed_ids import NAMES

    server = _PickyServer(s3, adopt_ready=False)
    a = V3Device(tmp_path, server, "A", dict(NAMES))
    b = V3Device(tmp_path, server, "B")
    await a.sync(); await b.sync()
    server.adopt_ready = True
    a.reconnect()
    return server, a, b


def _legacy_live(server) -> list[str]:
    return [i for i in _live_ids(server) if not HASHED.match(i)]


async def test_hashed_copy_accepted_tombstone_refused_owes_only_the_tombstone(tmp_path, account_key, s3):
    from tests.test_sync_hashed_ids import NAMES

    server, a, b = await _legacy_pair(tmp_path, s3)
    server.refuse = {ALPHA}
    assert (await a.sync())["ok"] is True
    h1 = sync_keyring.hashed_item_id("prompts", ALPHA, server.item_id_kid)
    state = a.store.state("prompts", ALPHA)
    assert state.wire_id == h1 and state.rev == server.rows[("prompts", h1)]["rev"]
    assert _legacy_live(server) == [ALPHA]
    sent = len(server.wire)
    assert (await a.sync())["ok"] is True
    again = server.wire[sent:]
    assert [(i["itemId"], i["deleted"]) for i in again] == [(ALPHA, 1)]  # the tombstone, not the h1 copy
    assert _legacy_live(server) == [] and a.store.conflicts("prompts") == []
    sent = len(server.wire)
    await a.sync()
    assert server.wire[sent:] == []  # owed once, paid once
    b.reconnect()
    await b.sync()
    assert b.adapter.items == NAMES and b.store.conflicts("prompts") == []


CLOCKS = {"same-second": 0, "ticking": 1, "backwards": -1}


def set_clock(monkeypatch, clock: str) -> None:
    """Every stamp the engine writes comes from this clock: all in one second,
    one second later per write (devices acting seconds apart), or one second
    earlier per write (a later writer whose clock is behind)."""
    import itertools
    from datetime import datetime, timedelta, timezone

    base = datetime(2026, 10, 11, 12, 0, 0, tzinfo=timezone.utc)
    step, ticks = CLOCKS[clock], itertools.count()
    monkeypatch.setattr(
        sync_engine, "now_iso", lambda: (base + timedelta(seconds=step * next(ticks))).isoformat(timespec="seconds")
    )


async def _legacy_row_changed_then_answered(tmp_path, s3, keep):
    """B edits alpha on its legacy connection between A's pull and A's
    migration push; A's tombstone meets that row and A answers *keep*."""
    server, a, b = await _legacy_pair(tmp_path, s3)

    async def b_edits_on_its_legacy_connection():
        saved, server.item_ids = server.item_ids, "legacy"
        b.adapter.items[ALPHA] = {"v": "b-edit"}
        assert (await b.sync())["ok"] is True
        server.item_ids = saved

    server.before_push = b_edits_on_its_legacy_connection
    await a.sync()
    h1 = sync_keyring.hashed_item_id("prompts", ALPHA, server.item_id_kid)
    assert a.store.state("prompts", ALPHA).wire_id == h1
    (conflict,) = a.store.conflicts("prompts")
    assert conflict["itemId"] == ALPHA and conflict["remote"] == {"v": "b-edit"}
    assert _legacy_live(server) == [ALPHA]
    a.engine.resolve("prompts", ALPHA, keep)
    b.reconnect()
    for _ in range(3):
        await a.sync(); await b.sync()
    return server, a, b


@pytest.mark.parametrize("clock", ["same-second", "ticking"])
@pytest.mark.parametrize("keep", [sync_engine.KEEP_REMOTE, sync_engine.KEEP_LOCAL])
async def test_a_tombstone_that_meets_a_changed_legacy_row_is_a_conflict_then_sent_again(
    tmp_path, account_key, s3, keep, clock, monkeypatch
):
    # The clock is fixed so the outcome never rests on wall time: with it
    # ticking, keep-local used to leave B a conflict (A's hashed copy kept
    # the stamp of the migration, older than B's legacy edit, and read on B
    # as a replay).
    set_clock(monkeypatch, clock)
    server, a, b = await _legacy_row_changed_then_answered(tmp_path, s3, keep)
    winner = {"v": "b-edit"} if keep == sync_engine.KEEP_REMOTE else {"v": "alpha"}
    assert a.store.conflicts("prompts") == [] and b.store.conflicts("prompts") == []
    assert a.adapter.items[ALPHA] == winner and b.adapter.items[ALPHA] == winner
    assert _legacy_live(server) == [] and len(_live_ids(server)) == 2


@pytest.mark.parametrize("keep", [sync_engine.KEEP_REMOTE, sync_engine.KEEP_LOCAL])
async def test_a_legacy_row_answer_under_a_clock_running_backwards_loses_nothing(
    tmp_path, account_key, s3, keep, monkeypatch
):
    """A later write stamped before what B agreed on is what D0 reads as a
    server replay, and main does the same on plain v1 edits (see the control
    below): B is asked rather than overwritten. Nothing is lost, and B's
    answer converges both devices."""
    set_clock(monkeypatch, "backwards")
    server, a, b = await _legacy_row_changed_then_answered(tmp_path, s3, keep)
    winner = {"v": "b-edit"} if keep == sync_engine.KEEP_REMOTE else {"v": "alpha"}
    assert a.store.conflicts("prompts") == [] and a.adapter.items[ALPHA] == winner
    if keep == sync_engine.KEEP_LOCAL:
        (clash,) = b.store.conflicts("prompts")
        assert clash["local"] == {"v": "b-edit"} and clash["remote"] == winner
        assert b.adapter.items[ALPHA] == {"v": "b-edit"}
        b.engine.resolve("prompts", ALPHA, sync_engine.KEEP_REMOTE)
        for _ in range(2):
            await b.sync(); await a.sync()
    assert a.store.conflicts("prompts") == [] and b.store.conflicts("prompts") == []
    assert a.adapter.items[ALPHA] == winner and b.adapter.items[ALPHA] == winner
    assert _legacy_live(server) == [] and len(_live_ids(server)) == 2


async def test_control_main_reads_a_backwards_stamped_v1_edit_as_a_replay(tmp_path, account_key, monkeypatch):
    """Control for the test above, on the v1 wire main has always used."""
    from tests.test_sync_engine import Device, FakeServer

    set_clock(monkeypatch, "backwards")
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1", "prompt": "one"}})
    b = Device(tmp_path, server, "dev-b")
    await a.sync(); await b.sync()
    a.adapter.items["p1"] = {"id": "p1", "prompt": "two"}
    await a.sync(); await b.sync()
    (clash,) = b.store.conflicts("prompts")
    assert clash["remote"] == {"id": "p1", "prompt": "two"} and b.adapter.items["p1"]["prompt"] == "one"


async def test_tombstone_accepted_hashed_copy_refused_resends_the_copy(tmp_path, account_key, s3):
    from tests.test_sync_hashed_ids import NAMES

    server, a, b = await _legacy_pair(tmp_path, s3)
    h1_alpha = None

    async def refuse_alpha_h1():
        nonlocal h1_alpha
        h1_alpha = sync_keyring.hashed_item_id("prompts", ALPHA, server.item_id_kid)
        server.refuse = {h1_alpha}

    server.before_push = refuse_alpha_h1
    assert (await a.sync())["ok"] is True
    assert ("prompts", h1_alpha) not in server.rows and _legacy_live(server) == []
    assert a.adapter.items == NAMES  # not lost, not read as deleted here
    assert (await a.sync())["ok"] is True
    assert server.rows[("prompts", h1_alpha)]["deleted"] == 0
    assert a.store.state("prompts", ALPHA).wire_id == h1_alpha and a.store.conflicts("prompts") == []
    sent = len(server.wire)
    await a.sync()
    assert server.wire[sent:] == []
    b.reconnect()
    await b.sync(); await b.sync()
    assert b.adapter.items == NAMES and b.store.conflicts("prompts") == []
    assert a.adapter.items == NAMES


def test_the_owed_tombstone_column_is_step_6_and_set_state_keeps_it(tmp_path):
    from agent_team_backend.db import Database

    path = tmp_path / "s.db"
    store = sync_engine.SyncStore(Database(path))
    assert store._db.schema_version("sync") == 6  # noqa: SLF001
    store.set_state("prompts", "p", rev=1, synced_hash="h", deleted=False, wire_id="h1." + "a" * 64)
    store.set_legacy_rev("prompts", "p", 7)
    store.set_state("prompts", "p", rev=2, synced_hash="h2", deleted=False)
    again = sync_engine.SyncStore(Database(path))
    assert again.state("prompts", "p").legacy_rev == 7


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


# ── server re-review 1: D3 only on a v3 object account ───────────────────────
def _adopt_calls(server, device="A") -> int:
    return server.types(device).count("sync.adoptHmacIds")


async def test_an_inline_account_never_asks_to_adopt_hashed_ids(tmp_path, account_key, s3):
    """c7: sync.caps answers UNSUPPORTED for an inline account, so it speaks
    v1 and never asks to adopt."""
    from tests.test_sync_hashed_ids import NAMES

    server = V3Server(s3, storage="inline", adopt_ready=True)
    a = V3Device(tmp_path, server, "A", dict(NAMES))
    assert (await a.sync())["ok"] is True
    assert a.engine._caps["version"] == 1
    a.reconnect()
    assert (await a.sync())["ok"] is True
    assert _adopt_calls(server) == 0 and server.item_ids == "legacy"
    assert _live_ids(server) == sorted(NAMES)
    assert all(not s.wire_id for s in a.store.states("prompts").values())


@pytest.mark.parametrize("fallback", ["no-caps", "caps-timeout"])
async def test_a_v1_connection_never_asks_to_adopt_hashed_ids(tmp_path, account_key, s3, fallback):
    from tests.test_sync_hashed_ids import NAMES

    server = V3Server(s3, caps=(fallback != "no-caps"), adopt_ready=True)
    a = V3Device(tmp_path, server, "A", dict(NAMES))
    if fallback == "caps-timeout":
        real = a.engine._request

        async def lossy(msg_type, payload):
            if msg_type == "sync.caps":
                raise TimeoutError("lost")
            return await real(msg_type, payload)

        a.engine._request = lossy
    await a.sync()
    assert _adopt_calls(server) == 0 and server.item_ids == "legacy"
    assert all(not HASHED.match(k[1]) for k in server.rows)
    assert all(not s.wire_id for s in a.store.states("prompts").values())


async def test_an_unsupported_adoption_leaves_every_id_legacy(tmp_path, account_key, s3):
    from tests.test_sync_hashed_ids import NAMES

    server = V3Server(s3, adopt_ready=True)
    a = V3Device(tmp_path, server, "A", dict(NAMES))
    real = a.engine._request

    async def unsupported(msg_type, payload):
        if msg_type == "sync.adoptHmacIds":
            return {"ok": False, "error": {"code": "UNSUPPORTED", "message": "", "details": None}}
        return await real(msg_type, payload)

    a.engine._request = unsupported
    assert (await a.sync())["ok"] is True
    a.adapter.items["gamma"] = {"v": "g"}
    assert (await a.sync())["ok"] is True
    assert server.item_ids == "legacy"
    assert all(not HASHED.match(k[1]) for k in server.rows)
    assert all(not s.wire_id for s in a.store.states("prompts").values())


# ── server re-review 2: converging after ITEM_IDS_CHANGED (s3 account) ───────
async def _a2_on_a_stale_connection(tmp_path, s3):
    """A and A2 agree on legacy ids; A2's connection negotiated "legacy" and
    keeps it while A adopts hashed ids and migrates."""
    from tests.test_sync_hashed_ids import NAMES

    server = _PickyServer(s3, adopt_ready=False)
    a = V3Device(tmp_path, server, "A", dict(NAMES))
    a2 = V3Device(tmp_path, server, "A2")
    await a.sync(); await a2.sync()
    assert a2.adapter.items == NAMES
    server.adopt_ready = True
    a.reconnect()
    return server, a, a2


def _converged(server, a, a2, expected) -> None:
    assert a.adapter.items == expected and a2.adapter.items == expected
    assert a.store.conflicts("prompts") == [] and a2.store.conflicts("prompts") == []
    live = _live_ids(server)
    assert all(HASHED.match(i) for i in live) and len(live) == len(expected)
    for name in expected:
        assert a.store.state("prompts", name).wire_id == a2.store.state("prompts", name).wire_id
        assert HASHED.match(a.store.state("prompts", name).wire_id)


@pytest.mark.parametrize("change", ["none", "edit", "delete"])
async def test_a_device_that_meets_item_ids_changed_converges_within_two_rounds(
    tmp_path, account_key, s3, change
):
    from tests.test_sync_hashed_ids import NAMES

    server, a, a2 = await _a2_on_a_stale_connection(tmp_path, s3)
    assert (await a.sync())["ok"] is True  # A adopts and migrates
    expected = dict(NAMES)
    if change == "edit":
        a2.adapter.items[ALPHA] = {"v": "a2-edit"}
        expected[ALPHA] = {"v": "a2-edit"}
    elif change == "delete":
        del a2.adapter.items[ALPHA]
        del expected[ALPHA]
    first = await a2.sync()
    assert first["ok"] is False and "ITEM_IDS_CHANGED" in first["error"]
    for _ in range(2):
        await a2.sync(); await a.sync()
    _converged(server, a, a2, expected)


@pytest.mark.parametrize("change", ["edit", "delete"])
async def test_a_legacy_push_that_lands_after_the_migration_converges(tmp_path, account_key, s3, change):
    """A2 read nothing new, then A migrated before A2's push arrived: an edit
    is turned away (BAD_REQUEST), a delete meets the migration's tombstone."""
    from tests.test_sync_hashed_ids import NAMES

    server, a, a2 = await _a2_on_a_stale_connection(tmp_path, s3)
    expected = dict(NAMES)
    if change == "edit":
        a2.adapter.items[ALPHA] = {"v": "a2-edit"}
        expected[ALPHA] = {"v": "a2-edit"}
    else:
        del a2.adapter.items[ALPHA]
        del expected[ALPHA]

    async def a_migrates_first():
        assert (await a.sync())["ok"] is True

    server.before_push = a_migrates_first
    await a2.sync()
    if change == "delete":
        # On the stale connection the clash is recorded exactly as on main;
        # the hashed copy, once read, shows it was a rename and clears it.
        (clash,) = a2.store.conflicts("prompts")
        assert clash["local"] is None and clash["remote"] is None
    else:
        assert a2.store.conflicts("prompts") == []
    for _ in range(3):
        await a2.sync(); await a.sync()
    _converged(server, a, a2, expected)


# ── a legacy account behaves exactly as main ─────────────────────────────────
async def test_on_a_legacy_account_a_delete_that_meets_a_delete_is_still_a_conflict(tmp_path, account_key):
    """Modelled on test_sync_engine.py::test_a_delete_propagates (v1
    FakeServer, Device): B's delete reaches the server after A's, and the
    clash is recorded as main records it — both halves deleted."""
    from tests.test_sync_engine import Device, FakeServer

    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1", "prompt": "hello"}})
    b = Device(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()
    a.adapter.items.pop("p1")
    b.adapter.items.pop("p1")
    real = server.request
    state = {"raced": False}

    async def a_deletes_first(msg_type, payload):
        if msg_type == "sync.push" and not state["raced"] and payload["items"][0].get("deviceId") == "dev-b":
            state["raced"] = True
            await a.sync()
        return await real(msg_type, payload)

    server.request = a_deletes_first
    await b.sync()
    assert state["raced"]
    (clash,) = b.store.conflicts("prompts")
    assert clash["itemId"] in ("p1", "i:" + "p1") and clash["local"] is None and clash["remote"] is None


# ── contract c7 ─────────────────────────────────────────────────────────────
@pytest.mark.parametrize("scope", ["memory", "credentials"])
@pytest.mark.parametrize("server_kind", ["v1", "v3-retires-nothing"])
async def test_memory_and_credentials_never_go_up_through_the_real_gate(
    tmp_path, account_key, s3, scope, server_kind
):
    """c7: retiredScopes defaults to [], so nothing on the server keeps these
    two out. The sync layer's own switch (sync_scopes.scope_enabled) does,
    whatever the protocol."""
    from tests.test_sync_engine import DictScope

    server = V3Server(s3, caps=(server_kind != "v1"))
    assert server.retired == ()
    if scope in sync_engine.LOCAL_ONLY_SCOPES:
        # Stronger still: no engine takes an adapter for it at all.
        with pytest.raises(sync_engine.SyncError):
            V3Device(tmp_path, server, "A", adapter=DictScope(scope, {"x": {"secret": 1}}))
        assert not [t for t in server.types() if t in ("sync.push", "sync.pull") or t.startswith("blobs.")]
        assert s3.puts == [] and not server.rows
        return
    d = V3Device(tmp_path, server, "A", adapter=DictScope(scope, {"x": {"secret": 1}}))
    d.engine._enabled = sync_scopes.scope_enabled
    result = await d.sync()
    assert result.get("skipped")
    assert not [t for t in server.types() if t in ("sync.push", "sync.pull") or t.startswith("blobs.")]
    assert s3.puts == [] and not server.rows


async def test_an_hmac_account_taken_off_s3_keeps_v3_and_its_hashed_ids(tmp_path, account_key, s3):
    from tests.test_sync_hashed_ids import NAMES

    server = V3Server(s3, adopt_ready=True)
    a = V3Device(tmp_path, server, "A", dict(NAMES))
    b = V3Device(tmp_path, server, "B")
    assert (await a.sync())["ok"] is True
    assert server.item_ids == "hmac"
    server.storage = "inline"
    a.reconnect()
    a.adapter.items["gamma"] = {"v": "g"}
    for _ in range(2):
        await a.sync()
    assert a.engine._caps["version"] == 3 and a.engine._caps["itemIds"] == "hmac"
    assert (await b.sync())["ok"] is True
    assert b.adapter.items == {**NAMES, "gamma": {"v": "g"}}
    assert all(HASHED.match(i) for i in _live_ids(server))


async def test_an_account_the_server_keeps_on_legacy_ids_is_asked_once_per_connection(tmp_path, account_key, s3):
    """D3 is off by default on the server (NAVIDE_SYNC_HMAC_ACCOUNTS empty):
    an s3 account outside that list answers adoptHmacIds with UNSUPPORTED.
    The device keeps its legacy ids and asks again only on a new connection,
    never round after round."""
    from tests.test_sync_hashed_ids import NAMES

    server = V3Server(s3, adopt_ready=True)
    a = V3Device(tmp_path, server, "A", dict(NAMES))
    real = a.engine._request
    asked: list[str] = []

    async def legacy_only(msg_type, payload):
        if msg_type == "sync.adoptHmacIds":
            asked.append(msg_type)
            return {"ok": False, "error": {"code": "UNSUPPORTED", "message": "", "details": None}}
        return await real(msg_type, payload)

    a.engine._request = legacy_only
    for n in range(4):
        a.adapter.items[f"extra-{n}"] = {"v": n}
        assert (await a.sync())["ok"] is True
    assert len(asked) == 1
    a.reconnect()
    for _ in range(3):
        assert (await a.sync())["ok"] is True
    assert len(asked) == 2
    assert server.item_ids == "legacy"
    assert all(not HASHED.match(k[1]) for k in server.rows)
    assert all(not s.wire_id for s in a.store.states("prompts").values())
    assert server.rows[("prompts", "extra-3")]["objectRef"]



# ── contract c8: adoption only when caps says the account may ───────────────
async def test_no_adoption_is_asked_when_caps_says_the_account_may_not(tmp_path, account_key, s3):
    from tests.test_sync_hashed_ids import NAMES

    server = V3Server(s3, adopt_ready=True, hmac_listed=False)
    assert server.caps_payload()["adoptHmac"] is False
    a = V3Device(tmp_path, server, "A", dict(NAMES))
    for _ in range(3):
        assert (await a.sync())["ok"] is True
    a.reconnect()
    assert (await a.sync())["ok"] is True
    assert "sync.adoptHmacIds" not in server.types("A")
    assert server.item_ids == "legacy"
    assert all(not HASHED.match(k[1]) for k in server.rows)


async def test_a_c7_server_without_the_flag_is_asked_once_per_connection(tmp_path, account_key, s3):
    """No ``adoptHmac`` in caps (a c7 server): the device asks once per
    connection and stays on legacy ids when the server says UNSUPPORTED."""
    from tests.test_sync_hashed_ids import NAMES

    server = V3Server(s3, adopt_ready=True, hmac_listed=False, caps_has_adopt_flag=False)
    assert "adoptHmac" not in server.caps_payload()
    a = V3Device(tmp_path, server, "A", dict(NAMES))
    for _ in range(3):
        assert (await a.sync())["ok"] is True
    assert server.types("A").count("sync.adoptHmacIds") == 1
    a.reconnect()
    assert (await a.sync())["ok"] is True
    assert server.types("A").count("sync.adoptHmacIds") == 2
    assert server.item_ids == "legacy"
    assert all(not HASHED.match(k[1]) for k in server.rows)


async def test_an_account_on_the_list_is_moved_once_and_then_offered_no_more(tmp_path, account_key, s3):
    from tests.test_sync_hashed_ids import NAMES

    server = V3Server(s3, adopt_ready=True, hmac_listed=True)
    a = V3Device(tmp_path, server, "A", dict(NAMES))
    assert (await a.sync())["ok"] is True
    assert server.item_ids == "hmac"
    assert server.caps_payload()["adoptHmac"] is False
    a.reconnect()
    assert (await a.sync())["ok"] is True
    assert server.types("A").count("sync.adoptHmacIds") == 1


# ── the convergence tests again, with devices acting seconds apart ───────────
_TICKING = [
    ("test_migration_keeps_an_unpushed_edit_on_the_other_device", {}),
    ("test_migration_keeps_an_unpushed_delete_on_the_other_device", {}),
    ("test_a_genuine_migration_conflict_converges_either_way",
     {"keep": sync_engine.KEEP_REMOTE, "winner": {"v": "a-edit"}}),
    ("test_a_genuine_migration_conflict_converges_either_way",
     {"keep": sync_engine.KEEP_LOCAL, "winner": {"v": "b-edit"}}),
    ("test_hashed_copy_accepted_tombstone_refused_owes_only_the_tombstone", {}),
    ("test_tombstone_accepted_hashed_copy_refused_resends_the_copy", {}),
    ("test_a_device_that_meets_item_ids_changed_converges_within_two_rounds", {"change": "none"}),
    ("test_a_device_that_meets_item_ids_changed_converges_within_two_rounds", {"change": "edit"}),
    ("test_a_device_that_meets_item_ids_changed_converges_within_two_rounds", {"change": "delete"}),
    ("test_a_legacy_push_that_lands_after_the_migration_converges", {"change": "edit"}),
    ("test_a_legacy_push_that_lands_after_the_migration_converges", {"change": "delete"}),
    ("test_an_hmac_account_taken_off_s3_keeps_v3_and_its_hashed_ids", {}),
]


@pytest.mark.parametrize(
    "name,kwargs", _TICKING, ids=[f"{n}-{'-'.join(str(v) for v in k.values() if isinstance(v, str))}" for n, k in _TICKING]
)
async def test_convergence_holds_with_a_ticking_clock(tmp_path, account_key, s3, monkeypatch, name, kwargs):
    set_clock(monkeypatch, "ticking")
    await globals()[name](tmp_path=tmp_path, account_key=account_key, s3=s3, **kwargs)
