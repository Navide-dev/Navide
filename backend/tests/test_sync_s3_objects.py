"""Sync protocol v3, phase 1: capability negotiation and records as objects.

The far end is ``V3Server`` — the test ``FakeServer`` taught the v3 verbs of
the contract (``sync.caps``, ``blobs.presignPut/commit/presignGet``, objectRef
rows, retired scopes) — in front of ``FakeS3``, a real HTTP server on
127.0.0.1 that speaks HTTP/1.1 keep-alive, so the presigned PUTs and GETs go
over real sockets through ``sync_objects.HttpPool``.

Each simulated device is one connection: the server remembers which devices
negotiated v3, which is what decides the shape of the rows it hands back.
"""

from __future__ import annotations

import hashlib
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from agent_team_backend import app, device_signing, sync_approvals, sync_engine, sync_keyring, sync_objects, sync_scopes
from agent_team_backend.db import Database
from agent_team_backend.mcp_settings import MCPSettingsStore
from tests.test_sync_engine import DictScope, FakeServer, _BadRequest
from tests.test_sync_scope_adapters import Dev, _mcp


@pytest.fixture
def account_key():
    sync_keyring.ensure_account_key()
    yield
    sync_keyring.forget_account_key()


HASHED = re.compile(r"^h1\.[0-9a-f]{64}$")


# ── fake object storage ─────────────────────────────────────────────────────
class FakeS3:
    """Objects over real HTTP. ``objects`` holds what was PUT; the server
    decides what counts as committed."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.puts: list[str] = []
        self.gets: list[str] = []
        self.fail_get: set[str] = set()
        self.fail_put: set[str] = set()
        self.content_types: list[str | None] = []
        self.precondition_failed: list[str] = []
        self.connections = 0
        s3 = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: Any) -> None:
                pass

            def setup(self) -> None:
                super().setup()
                s3.connections += 1

            def do_PUT(self) -> None:  # noqa: N802 - http.server naming
                # c7: a presigned URL names a fresh upload key (the query
                # here); the object is still the blob it names.
                blob_id = self.path.split("?", 1)[0].rsplit("/", 1)[1]
                data = self.rfile.read(int(self.headers["Content-Length"]))
                s3.content_types.append(self.headers.get("Content-Type"))
                # moto (and S3 behind some proxies) reads a form-encoded body
                # as a form and stores nothing: the type must be octet-stream.
                if self.headers.get("Content-Type") != "application/octet-stream":
                    self.send_response(400)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                # c6: If-None-Match is signed into the presigned URL, so real
                # S3 answers 403 without it, and 412 for a key already written.
                if self.headers.get("If-None-Match") != "*":
                    self.send_response(403)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if blob_id in s3.objects:
                    s3.precondition_failed.append(blob_id)
                    self.send_response(412)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if blob_id in s3.fail_put:
                    self.send_response(500)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                s3.objects[blob_id] = data
                s3.puts.append(blob_id)
                self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def do_GET(self) -> None:  # noqa: N802
                blob_id = self.path.split("?", 1)[0].rsplit("/", 1)[1]
                s3.gets.append(blob_id)
                data = s3.objects.get(blob_id)
                if data is None or blob_id in s3.fail_get:
                    self.send_response(500)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        class Server(ThreadingHTTPServer):
            daemon_threads = True
            request_queue_size = 64  # eight parallel connects at once

        self.http = Server(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.http.server_address[1]}"
        threading.Thread(target=self.http.serve_forever, daemon=True).start()

    def url(self, blob_id: str) -> str:
        return f"{self.base}/obj/{blob_id}"

    def close(self) -> None:
        self.http.shutdown()
        self.http.server_close()


@pytest.fixture
def s3():
    store = FakeS3()
    yield store
    store.close()
    sync_objects.shared_pool().close()


# ── fake Navide-Server, v3 ──────────────────────────────────────────────────
RETIRED = ("memory", "credentials")
#: Every scope the contract names. c7: the server retires none of them unless
#: deployed to (NAVIDE_SYNC_RETIRE_SCOPES), so the client must never lean on it.
ALL_SCOPES = ("prompts", "mcp", "skills", "memory", "credentials", "skill-files")


class V3Server(FakeServer):
    """``FakeServer`` plus contract rev c7. ``caps`` False answers sync.caps
    with ``caps_error`` (an old server: UNKNOWN_TYPE; MySQL: UNSUPPORTED).

    c7: an account that is neither s3 nor hmac gets UNSUPPORTED for
    sync.caps, sync.versions and sync.adoptHmacIds and OBJECTS_DISABLED for
    blobs.*; an hmac account keeps v3 after it leaves s3. ``retired`` is the
    deploy-time retiredScopes list, empty by default (pass ``RETIRED`` for
    the old behaviour, which also refuses their pushes with SCOPE_RETIRED)."""

    def __init__(
        self,
        s3: FakeS3,
        *,
        storage: str = "s3",
        caps: bool = True,
        caps_error: str = "UNKNOWN_TYPE",
        item_ids: str = "legacy",
        adopt_ready: bool = False,
        hmac_listed: bool = True,
        caps_has_adopt_flag: bool = True,
        retired: tuple[str, ...] = (),
    ) -> None:
        super().__init__()
        self.retired = tuple(retired)
        self.presigns = 0
        self.s3 = s3
        self.storage = storage
        self.caps = caps
        self.caps_error = caps_error
        self.item_ids = item_ids
        self.item_id_kid: str | None = None
        self.adopt_ready = adopt_ready
        # c8: the deployment's list of accounts allowed to move to hashed ids.
        self.hmac_listed = hmac_listed
        # A c7 server answers caps without ``adoptHmac``.
        self.caps_has_adopt_flag = caps_has_adopt_flag
        self.negotiated: set[str] = set()
        self.calls: list[tuple[str, str, dict]] = []
        self.committed: dict[str, int] = {}
        self.incomplete_once: set[str] = set()
        self.history: dict[tuple[str, str], list[dict]] = {}
        self.wire: list[dict] = []

    # what the tests read back
    def types(self, device: str | None = None) -> list[str]:
        return [t for d, t, _ in self.calls if device is None or d == device]

    def pushed(self, scope: str | None = None) -> list[dict]:
        return [i for d, t, p in self.calls if t == "sync.push" and (scope is None or p["scope"] == scope)
                for i in p["items"]]

    def disconnect(self, device: str) -> None:
        self.negotiated.discard(device)

    def caps_payload(self) -> dict:
        return {
            "version": 3, "storage": self.storage, "itemIds": self.item_ids, "itemIdKid": self.item_id_kid,
            "scopes": [s for s in ALL_SCOPES if s not in self.retired], "retiredScopes": list(self.retired),
            "maxItems": 64, "maxBodyBytes": 524288, "maxPushBytes": 786432, "maxObjectBytes": 5242880,
            "maxBatch": 100, "maxPullPage": 500, "quotaItems": 10000, "quotaBytes": 1 << 30,
            "usedItems": 0, "usedBytes": 0, "versions": {"keep": 10, "maxAgeS": 2592000}, "presignTtlS": 900,
            **({"adoptHmac": self.hmac_listed and self.storage == "s3" and self.item_ids == "legacy"}
               if self.caps_has_adopt_flag else {}),
        }

    async def handle(self, device: str, msg_type: str, payload: dict) -> dict:
        import copy

        self.calls.append((device, msg_type, copy.deepcopy(payload)))

        def ok(p: dict) -> dict:
            return {"ok": True, "payload": p}

        def err(code: str, details: Any = None) -> dict:
            return {"ok": False, "error": {"code": code, "message": code, "details": details}}

        v3 = device in self.negotiated
        # c7: neither an object account nor one already on hashed ids.
        plain = self.storage != "s3" and self.item_ids != "hmac"
        if msg_type == "sync.caps":
            if not self.caps:
                return err(self.caps_error)
            if plain:
                return err("UNSUPPORTED")
            if payload.get("protocol") == 3:
                self.negotiated.add(device)
            return ok(self.caps_payload())
        if msg_type == "sync.adoptHmacIds":
            if plain:
                return err("UNSUPPORTED")
            if not v3:
                return err("SYNC_PROTOCOL_REQUIRED")
            root = payload.get("rootKid")
            if not isinstance(root, str) or not re.fullmatch(r"[0-9a-f]{16}", root):
                return err("BAD_REQUEST")
            if self.item_ids == "hmac":
                return ok({"itemIds": "hmac", "itemIdKid": self.item_id_kid}) if root == self.item_id_kid \
                    else err("BAD_REQUEST")
            if not self.hmac_listed and self.item_ids != "hmac":
                return err("UNSUPPORTED")
            if not self.adopt_ready:
                return err("HMAC_NOT_READY", {"blockingDevices": [{"deviceId": "old", "deviceName": "Old", "lastSeenAt": "x"}]})
            self.item_ids, self.item_id_kid = "hmac", root
            return ok({"itemIds": "hmac", "itemIdKid": root})
        if msg_type.startswith("blobs."):
            if plain:
                return err("OBJECTS_DISABLED")
            if not v3:
                return err("BAD_REQUEST")
            return self._blobs(msg_type, payload, ok, err)
        if msg_type in ("sync.push", "sync.pull", "sync.versions") and self.item_ids == "hmac" and not v3:
            return err("SYNC_PROTOCOL_REQUIRED")
        if msg_type == "sync.versions":
            if self.storage != "s3":
                return err("UNSUPPORTED")
            key = (payload["scope"], payload["itemId"])
            return ok({"scope": key[0], "itemId": key[1],
                       "versions": [self._shape(dict(v), v3) for v in reversed(self.history.get(key, []))]})
        try:
            if msg_type == "sync.pull":
                reply = self._pull(payload)
                reply["items"] = [self._shape(r, v3) for r in reply["items"]]
                return ok(reply)
            if msg_type == "sync.push":
                if payload["scope"] in self.retired:
                    return err("SCOPE_RETIRED")
                for item in payload["items"]:
                    item["deviceId"] = device
                self.wire.extend(dict(i) for i in payload["items"])
                if any("objectRef" in i for i in payload["items"]) and (self.storage != "s3" or not v3):
                    return err("OBJECTS_DISABLED")
                if self.item_ids == "hmac":
                    for i in payload["items"]:
                        if not i.get("deleted") and not HASHED.match(i["itemId"]):
                            return err("BAD_REQUEST")
                self.pushes += 1
                reply = self._push(payload)
                reply["conflicts"] = [self._shape(r, v3) for r in reply["conflicts"]]
                return ok(reply)
        except _BadRequest as bad:
            return err("BAD_REQUEST", str(bad))
        return err("UNKNOWN_TYPE")

    def _blobs(self, msg_type: str, payload: dict, ok, err) -> dict:
        if msg_type == "blobs.presignPut":
            objects = payload["objects"]
            if len(objects) > 100:
                return err("BAD_REQUEST")
            out = []
            for o in objects:
                if not 1 <= o["sizeBytes"] <= 5242880:
                    return err("BAD_REQUEST")
                if self.committed.get(o["blobId"]) == o["sizeBytes"]:
                    out.append({"blobId": o["blobId"], "state": "complete", "sizeBytes": o["sizeBytes"]})
                else:
                    self.presigns += 1  # c7: a new upload key every time
                    out.append({"blobId": o["blobId"], "state": "upload", "sizeBytes": o["sizeBytes"],
                                "url": f"{self.s3.url(o['blobId'])}?key={self.presigns}"})
            return ok({"objects": out, "expiresAt": "later"})
        if msg_type == "blobs.commit":
            out = []
            for blob_id in payload["blobIds"]:
                data = self.s3.objects.get(blob_id)
                if blob_id in self.incomplete_once:
                    self.incomplete_once.discard(blob_id)
                    self.s3.objects.pop(blob_id, None)
                    out.append({"blobId": blob_id, "state": "incomplete", "restart": True})
                elif data is None:
                    out.append({"blobId": blob_id, "state": "absent"})
                else:
                    self.committed[blob_id] = len(data)
                    out.append({"blobId": blob_id, "state": "complete", "sizeBytes": len(data)})
            return ok({"blobs": out})
        if msg_type == "blobs.presignGet":
            out = []
            for blob_id in payload["blobIds"]:
                if blob_id in self.committed:
                    out.append({"blobId": blob_id, "sizeBytes": self.committed[blob_id], "url": self.s3.url(blob_id)})
                else:
                    out.append({"blobId": blob_id, "error": "NOT_FOUND"})
            return ok({"objects": out, "expiresAt": "later"})
        return err("UNKNOWN_TYPE")

    def _parse_push(self, raw: list) -> list[dict]:
        # objectRef stands in for the body in the checks FakeServer makes.
        shadow = []
        for item in raw:
            ref = item.get("objectRef")
            if ref is not None:
                if "body" in item:
                    raise _BadRequest("body and objectRef are exclusive")
                item = {**item, "body": "x"}
            shadow.append(item)
        super()._parse_push(shadow)
        return raw

    def _push(self, payload: dict) -> dict:
        scope = payload["scope"]
        rejected = []
        items = []
        for item in self._parse_push(payload["items"]):
            ref = item.get("objectRef")
            if ref is not None and self.committed.get(ref.get("blobId")) != ref.get("sizeBytes"):
                rejected.append({"itemId": item["itemId"], "code": "MISSING_OBJECT"})
                continue
            items.append(item)
        before = {k: dict(v) for k, v in self.rows.items() if k[0] == scope}
        reply = super()._push({"scope": scope, "items": items})
        by_id = {i["itemId"]: i for i in items}
        for entry in reply["accepted"]:
            key = (scope, entry["itemId"])
            row = self.rows[key]
            item = by_id[entry["itemId"]]
            if key in before and self.storage == "s3":
                old = before[key]
                old["supersededAt"] = "now"
                self.history.setdefault(key, []).append(old)
            if item.get("objectRef"):
                row["objectRef"] = dict(item["objectRef"])
                row["body"] = None
            elif row["body"] and self.storage == "s3":
                # An s3 account keeps no body: the server writes it as an
                # object itself, named by a plain sha256.
                data = row["body"].encode("utf-8")
                blob_id = hashlib.sha256(data).hexdigest()
                self.s3.objects[blob_id] = data
                self.committed[blob_id] = len(data)
                row["objectRef"] = {"blobId": blob_id, "sizeBytes": len(data)}
                row["body"] = None
        reply["rejected"] = rejected
        return reply

    def _shape(self, row: dict, v3: bool) -> dict:
        row = dict(row)
        ref = row.get("objectRef")
        if ref and v3:
            row["body"] = None
        elif ref:
            row.pop("objectRef")
            row["body"] = self.s3.objects[ref["blobId"]].decode("utf-8")
        return row


class V3Device:
    """One machine on one connection to a V3Server."""

    def __init__(self, tmp_path, server: V3Server, name: str, items=None, *, adapter=None) -> None:
        self.name = name
        self.server = server
        self.adapter = adapter if adapter is not None else DictScope(items=items)
        self.store = sync_engine.SyncStore(Database(tmp_path / f"{name}.db"))

        async def request(msg_type: str, payload: dict) -> dict:
            return await server.handle(name, msg_type, payload)

        self.engine = sync_engine.SyncEngine(
            self.store, request, device_id=lambda: name, enabled=lambda _scope: True,
            signing_key_for=lambda _device: device_signing.public_key(),
        )
        self.engine.register(self.adapter)

    def reconnect(self) -> None:
        self.server.disconnect(self.name)
        self.engine.reset_connection()

    async def sync(self) -> dict:
        try:
            return await self.engine.sync(self.adapter.scope)
        except sync_engine.SyncError:
            return self.engine.last_results()[self.adapter.scope]


# ── v1 fallback ─────────────────────────────────────────────────────────────
@pytest.mark.parametrize("code", ["UNKNOWN_TYPE", "UNSUPPORTED", "BAD_REQUEST"])
async def test_a_server_without_caps_gets_the_v1_wire(tmp_path, account_key, s3, code):
    server = V3Server(s3, caps=False, caps_error=code, storage="inline")
    a = V3Device(tmp_path, server, "A", {"p1": {"v": 1}})
    b = V3Device(tmp_path, server, "B")
    assert (await a.sync())["ok"] is True
    assert (await b.sync())["ok"] is True
    assert b.adapter.items == {"p1": {"v": 1}}
    assert server.types("A") == ["sync.caps", "sync.pull", "sync.push"]
    a.adapter.items["p2"] = {"v": 2}
    await a.sync()
    # Asked once per connection, not per round.
    assert server.types("A").count("sync.caps") == 1
    assert not [t for t in server.types() if t.startswith("blobs.")]
    for item in server.pushed():
        assert item["body"] and "objectRef" not in item
    assert s3.puts == [] and s3.gets == []


async def test_a_new_connection_asks_again(tmp_path, account_key, s3):
    server = V3Server(s3, caps=False)
    a = V3Device(tmp_path, server, "A", {"p1": {"v": 1}})
    await a.sync()
    a.reconnect()
    await a.sync()
    assert server.types("A").count("sync.caps") == 2


async def test_the_kill_switch_never_asks(tmp_path, account_key, s3, monkeypatch):
    monkeypatch.setenv("NAVIDE_SYNC_PROTOCOL", "1")
    server = V3Server(s3)
    a = V3Device(tmp_path, server, "A", {"p1": {"v": 1}})
    assert (await a.sync())["ok"] is True
    assert server.types("A") == ["sync.pull", "sync.push"]
    assert server.pushed()[0]["body"]


async def test_an_inline_account_speaks_v1_and_pushes_bodies(tmp_path, account_key, s3):
    # c7: sync.caps answers UNSUPPORTED for an account without objects.
    server = V3Server(s3, storage="inline")
    a = V3Device(tmp_path, server, "A", {"p1": {"v": 1}})
    b = V3Device(tmp_path, server, "B")
    await a.sync()
    await b.sync()
    assert a.engine._caps["version"] == 1
    assert b.adapter.items == {"p1": {"v": 1}}
    assert not [t for t in server.types() if t.startswith("blobs.")]
    assert server.pushed()[0]["body"]


# ── s3 records ──────────────────────────────────────────────────────────────
async def test_records_travel_as_objects_between_two_devices(tmp_path, account_key, s3):
    server = V3Server(s3)
    a = V3Device(tmp_path, server, "A", {"p1": {"v": 1}, "p2": {"v": "two"}})
    b = V3Device(tmp_path, server, "B")
    assert (await a.sync())["ok"] is True
    for item in server.pushed():
        assert "body" not in item and set(item["objectRef"]) == {"blobId", "sizeBytes"}
        assert re.fullmatch(r"[0-9a-f]{64}", item["objectRef"]["blobId"])
        assert item["sig"]
    assert sorted(s3.puts) == sorted(i["objectRef"]["blobId"] for i in server.pushed())
    # The object is the sealed body, byte for byte.
    one = server.pushed()[0]
    sealed = s3.objects[one["objectRef"]["blobId"]].decode("utf-8")
    assert sync_keyring.decrypt(sealed, scope="prompts", item_id=one["itemId"])
    assert (await b.sync())["ok"] is True
    assert b.adapter.items == a.adapter.items
    # Nothing goes up twice, and B's pull did not push anything back.
    puts = list(s3.puts)
    await a.sync()
    await b.sync()
    assert s3.puts == puts and len(server.pushed()) == 2


async def test_an_object_already_stored_is_not_put_again(tmp_path, account_key, s3):
    server = V3Server(s3)
    a = V3Device(tmp_path, server, "A")
    await a.sync()  # negotiates
    caps = a.engine._caps
    data = sync_keyring.encrypt('{"v":1}', scope="prompts", item_id="p1").encode("utf-8")
    first = await a.engine._upload_objects([data, data], caps)
    second = await a.engine._upload_objects([data], caps)
    assert first == [second[0], second[0]]
    assert len(s3.puts) == 1


async def test_puts_reuse_kept_alive_connections(tmp_path, account_key, s3):
    server = V3Server(s3)
    a = V3Device(tmp_path, server, "A", {f"p{i}": {"v": i} for i in range(30)})
    assert (await a.sync())["ok"] is True
    assert len(s3.puts) == 30
    assert set(s3.content_types) == {"application/octet-stream"}
    assert s3.connections <= sync_objects.POOL_PER_HOST


async def test_a_pull_takes_object_rows_and_body_rows_alike(tmp_path, account_key, s3):
    # p1 was written before the account moved to s3 and is not backfilled.
    server = V3Server(s3, storage="inline")
    a = V3Device(tmp_path, server, "A", {"p1": {"v": 1}})
    await a.sync()
    server.storage = "s3"
    a.reconnect()
    a.adapter.items["p2"] = {"v": 2}
    await a.sync()
    assert server.rows[("prompts", "p1")]["body"] and "objectRef" not in server.rows[("prompts", "p1")]
    assert server.rows[("prompts", "p2")]["objectRef"]
    b = V3Device(tmp_path, server, "B")
    assert (await b.sync())["ok"] is True
    assert b.adapter.items == {"p1": {"v": 1}, "p2": {"v": 2}}


async def test_an_object_the_server_wrote_for_an_old_client_opens(tmp_path, account_key, s3, monkeypatch):
    server = V3Server(s3)
    old = V3Device(tmp_path, server, "OLD", {"p1": {"v": "old"}})
    monkeypatch.setenv("NAVIDE_SYNC_PROTOCOL", "1")
    await old.sync()
    monkeypatch.delenv("NAVIDE_SYNC_PROTOCOL")
    assert server.rows[("prompts", "p1")]["objectRef"]  # named by sha256
    b = V3Device(tmp_path, server, "B")
    assert (await b.sync())["ok"] is True
    assert b.adapter.items == {"p1": {"v": "old"}}


async def test_a_stale_edit_on_the_object_path_is_a_conflict(tmp_path, account_key, s3):
    server = V3Server(s3)
    a = V3Device(tmp_path, server, "A", {"p1": {"v": 1}})
    b = V3Device(tmp_path, server, "B")
    await a.sync()
    await b.sync()
    a.adapter.items["p1"] = {"v": "a"}
    await a.sync()
    b.adapter.items["p1"] = {"v": "b"}
    # B pushes from the old rev: the reply's conflict row is an objectRef.
    pushed = await b.engine.push_items("prompts", ["p1"])
    assert pushed == [{"itemId": "p1", "result": "conflict"}]
    (row,) = b.store.conflicts("prompts")
    assert row["remote"] == {"v": "a"} and row["local"] == {"v": "b"}


async def test_a_pull_over_an_unpushed_edit_is_a_conflict_with_the_object(tmp_path, account_key, s3):
    server = V3Server(s3)
    a = V3Device(tmp_path, server, "A", {"p1": {"v": 1}})
    b = V3Device(tmp_path, server, "B")
    await a.sync()
    await b.sync()
    a.adapter.items["p1"] = {"v": "a"}
    await a.sync()
    b.adapter.items["p1"] = {"v": "b"}
    await b.sync()
    (row,) = b.store.conflicts("prompts")
    assert row["remote"] == {"v": "a"}


async def test_a_delete_propagates_on_the_object_path(tmp_path, account_key, s3):
    server = V3Server(s3)
    a = V3Device(tmp_path, server, "A", {"p1": {"v": 1}})
    b = V3Device(tmp_path, server, "B")
    await a.sync()
    await b.sync()
    a.adapter.items.pop("p1")
    await a.sync()
    tomb = server.pushed()[-1]
    assert tomb["deleted"] == 1 and "objectRef" not in tomb and tomb["body"] == ""
    await b.sync()
    assert b.adapter.items == {}


async def test_inventory_and_pull_items_read_objects(tmp_path, account_key, s3):
    server = V3Server(s3)
    a = V3Device(tmp_path, server, "A", {"p1": {"v": 1}})
    await a.sync()
    b = V3Device(tmp_path, server, "B", {"p1": {"v": 1}})
    listing = await b.engine.inventory("prompts")
    assert listing["status"] == "ok"
    assert [(i["itemId"], i["state"]) for i in listing["items"]] == [("p1", "in-sync")]
    b.adapter.items.clear()
    assert (await b.engine.pull_items("prompts", ["p1"]))[0]["result"] == "pulled"
    assert b.adapter.items == {"p1": {"v": 1}}


# ── uploads that do not complete ────────────────────────────────────────────
async def test_an_incomplete_upload_starts_over_once(tmp_path, account_key, s3):
    server = V3Server(s3)
    a = V3Device(tmp_path, server, "A", {"p1": {"v": 1}})
    original = server._blobs
    commits = []

    def first_incomplete(msg_type, payload, ok, err):
        if msg_type == "blobs.commit":
            commits.append(payload["blobIds"])
            if len(commits) == 1:
                server.incomplete_once.update(payload["blobIds"])
        return original(msg_type, payload, ok, err)

    server._blobs = first_incomplete
    assert (await a.sync())["ok"] is True
    assert server.types("A").count("blobs.presignPut") == 2
    assert server.rows[("prompts", "p1")]["objectRef"]


async def test_a_failed_put_pushes_nothing(tmp_path, account_key, s3):
    server = V3Server(s3)
    a = V3Device(tmp_path, server, "A", {"p1": {"v": 1}})
    original = server._blobs

    def fail_puts(msg_type, payload, ok, err):
        if msg_type == "blobs.presignPut":
            s3.fail_put.update(o["blobId"] for o in payload["objects"])
        return original(msg_type, payload, ok, err)

    server._blobs = fail_puts
    result = await a.sync()
    assert result["ok"] is False
    assert "sync.push" not in server.types()
    assert a.store.state("prompts", "p1") is None


async def test_a_missing_object_is_rejected_per_item_and_retried(tmp_path, account_key, s3):
    server = V3Server(s3)
    a = V3Device(tmp_path, server, "A", {"p1": {"v": 1}, "p2": {"v": 2}})
    real_push = server._push
    dropped = False

    def drop_one(payload):
        nonlocal dropped
        if not dropped:
            dropped = True
            server.committed.pop(payload["items"][0]["objectRef"]["blobId"])
        return real_push(payload)

    server._push = drop_one
    result = await a.sync()
    assert result["ok"] is True and result["pushed"] == 1
    assert len([s for s in a.store.states("prompts")]) == 1
    await a.sync()
    assert len(a.store.states("prompts")) == 2


async def test_objects_disabled_fails_the_round_and_asks_again(tmp_path, account_key, s3):
    server = V3Server(s3)
    a = V3Device(tmp_path, server, "A", {"p1": {"v": 1}})
    await a.sync()
    server.storage = "inline"  # the account was moved back
    a.adapter.items["p2"] = {"v": 2}
    result = await a.sync()
    assert result["ok"] is False and "OBJECTS_DISABLED" in result["error"]
    assert (await a.sync())["ok"] is True
    assert server.types("A").count("sync.caps") == 2
    assert server.pushed()[-1]["body"]


# ── downloads that fail ─────────────────────────────────────────────────────
async def _two_on_the_server(tmp_path, s3):
    server = V3Server(s3)
    a = V3Device(tmp_path, server, "A", {"p1": {"v": "aaaa"}, "p2": {"v": "bbbb"}})
    await a.sync()
    return server, V3Device(tmp_path, server, "B")


@pytest.mark.parametrize("how", ["http", "not-found", "tampered", "short"])
async def test_a_record_that_cannot_be_fetched_fails_the_round(tmp_path, account_key, s3, how):
    server, b = await _two_on_the_server(tmp_path, s3)
    ref1 = server.rows[("prompts", "p1")]["objectRef"]["blobId"]
    ref2 = server.rows[("prompts", "p2")]["objectRef"]["blobId"]
    if how == "http":
        s3.fail_get.add(ref1)
    elif how == "not-found":
        server.committed.pop(ref1)
    elif how == "tampered":
        # The right length, the wrong object: p2's sealed bytes under p1's id.
        assert len(s3.objects[ref1]) == len(s3.objects[ref2])
        s3.objects[ref1] = s3.objects[ref2]
    else:
        s3.objects[ref1] = s3.objects[ref1][:-4]
    result = await b.sync()
    assert result["ok"] is False
    assert b.adapter.items == {}
    assert b.store.cursor("prompts") == 0
    assert b.store.states("prompts") == {}


# ── retired scopes ──────────────────────────────────────────────────────────
@pytest.mark.parametrize("scope", RETIRED)
async def test_a_retired_scope_never_reaches_objects_or_push(tmp_path, account_key, s3, scope):
    # c7: the server retires nothing by default (retiredScopes []), so this
    # holds on the client's own rule, not on a refusal from the fake.
    server = V3Server(s3)
    assert server.caps_payload()["retiredScopes"] == []
    if scope in sync_engine.LOCAL_ONLY_SCOPES:
        # Stronger still: no engine takes an adapter for it at all.
        with pytest.raises(sync_engine.SyncError):
            V3Device(tmp_path, server, "A", adapter=DictScope(scope, {"x": {"secret": 1}}))
        assert [t for t in server.types() if t != "sync.caps"] == [] and s3.puts == []
        return
    d = V3Device(tmp_path, server, "A", adapter=DictScope(scope, {"x": {"secret": 1}}))
    result = await d.sync()
    assert result["skipped"] == "retired"
    assert [t for t in server.types() if t != "sync.caps"] == []
    assert s3.puts == []
    with pytest.raises(sync_engine.SyncError):
        await d.engine.push_items(scope, ["x"])
    assert "sync.push" not in server.types()


# ── the approval gate is the same on the object path ────────────────────────
async def test_an_incoming_mcp_server_is_held_for_approval(tmp_path, account_key, s3, monkeypatch):
    monkeypatch.setattr(app, "app_data_dir", lambda: tmp_path / "app-data")
    server = V3Server(s3)
    a_store, b_store = MCPSettingsStore(tmp_path / "a.json"), MCPSettingsStore(tmp_path / "b.json")
    a = Dev(tmp_path, server, "A", monkeypatch, sync_scopes.McpScope(), mcp_settings_store=a_store)
    b = Dev(tmp_path, server, "B", monkeypatch, sync_scopes.McpScope(), mcp_settings_store=b_store)
    for dev in (a, b):
        dev.engine._request = (lambda name: (lambda t, p: server.handle(name, t, p)))(dev.name)
    a.use()
    a_store.replace_servers([{**_mcp("runner"), "command": "/tmp/evil"}])
    assert (await a.sync())["ok"] is True
    assert server.pushed("mcp")[0]["objectRef"]
    assert (await b.sync())["ok"] is True
    assert "runner" not in {s["name"] for s in b_store.list_servers()}
    b.use()
    assert sync_approvals.entry("mcp", "i:runner")["status"] == "pending"
    (row,) = [h for h in sync_approvals.listing() if h["itemId"] in ("runner", "i:" + "runner")]
    assert sync_approvals.decide(b.adapter, row["itemId"], True, row["digest"])["status"] == "applied"
    assert "runner" in {s["name"] for s in b_store.list_servers()}
