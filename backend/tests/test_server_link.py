"""ServerLink: authentication, roster publishing, reconnect and revocation.

Everything runs against an in-process fake WebSocket — no Navide-Server has to
be running for these to pass, and none of them touches the real Keychain.
"""

from __future__ import annotations

import asyncio
import logging
import base64
import os
import json
import sys
import threading
import traceback

import pytest

import agent_team_backend
from agent_team_backend import (
    agent_messaging,
    app,
    confirm_token,
    device_identity,
    device_pairing,
    device_signing,
    osplat,
    remote_roster,
    server_link,
    trust_store,
)
from agent_team_backend.credential_vault import CredentialVault, CredentialVaultError
from agent_team_backend.server_link import ServerLink, ServerLinkConfig

CONFIG = ServerLinkConfig(url="ws://localhost:8787/ws", token="tok-abc")


#: The key these tests pretend the main process handed over on stdin, so the
#: six trust-changing handlers behave the way they do under a real window.
_CONFIRM_KEY = "test-confirmation-key"


@pytest.fixture(autouse=True)
def _confirmable():
    confirm_token._reset_for_test(_CONFIRM_KEY)
    yield
    confirm_token._reset_for_test()


def _confirmation(action: str, device_id: str = "", subject: str = "") -> dict[str, str]:
    import hashlib
    import hmac
    import time
    import uuid

    nonce = uuid.uuid4().hex
    expires = str(time.time() + 30.0)
    payload = "\x00".join(("navide/trust-confirm/v2", nonce, expires, action, device_id, subject))
    return {
        "nonce": nonce,
        "expires": expires,
        "mac": hmac.new(_CONFIRM_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest(),
    }


@pytest.fixture(autouse=True)
def _paired_peer():
    """PEER as a machine this one has already paired with.

    Pins are written only by the pairing exchange now, so a test about what
    happens to a *message* has to start from a relationship: without one every
    push below is refused as `not-paired` before it reaches the thing the test
    is actually about. Tests that introduce their own peer pin it themselves.
    """
    trust_store.load()
    trust_store.pin_device(PEER.device_id, sign_key=PEER.sign_key, member_id="m1")
    yield


@pytest.fixture(autouse=True)
def _clean_registry():
    agent_messaging._reset_for_test()
    # The directory now seeds a peer (a device with no signing key in the
    # roster is a device this machine refuses), and the roster is module state,
    # so without this a later test would see a peer no test in it created.
    remote_roster._reset_for_test()
    yield
    agent_messaging._reset_for_test()
    remote_roster._reset_for_test()


@pytest.fixture(autouse=True)
def _fast_timers(monkeypatch):
    """Shrink every wait so the suite exercises the real loops, not the clock."""
    monkeypatch.setattr(server_link, "RECONNECT_BASE_S", 0.01)
    monkeypatch.setattr(server_link, "RECONNECT_MAX_S", 0.02)
    monkeypatch.setattr(server_link, "ROSTER_DEBOUNCE_S", 0.01)
    monkeypatch.setattr(server_link, "ROSTER_SWEEP_S", 0.05)


# ---- fake server ------------------------------------------------------------


def _ok(message: dict, payload: dict) -> dict:
    return {
        "id": message["id"],
        "type": f"{message.get('type')}.result",
        "ok": True,
        "payload": payload,
    }


def _bad_request(message: dict, text: str) -> dict:
    return {
        "id": message["id"],
        "type": f"{message.get('type')}.result",
        "ok": False,
        "error": {"code": "BAD_REQUEST", "message": text},
    }


class Peer:
    """Another device, with a signing key of its own.

    Cross-device messages carry a signature the receiver checks against a key it
    pinned, so a fake server that only relays text can no longer stand in for a
    peer: it has to *be* one. Which is the point — a test whose "sender" holds
    no private key is a test that would still pass if the receiver checked
    nothing.
    """

    def __init__(self, device_id: str = "dev-a", *, name: str = "peer-box") -> None:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

        from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

        self.device_id = device_id
        self.name = name
        self._private = Ed25519PrivateKey.generate()
        self.sign_key = base64.b64encode(
            self._private.public_key().public_bytes(
                encoding=serialization.Encoding.Raw,
                format=serialization.PublicFormat.Raw,
            )
        ).decode("ascii")
        # Its encryption key too: the pairing exchange carries and pins both,
        # and a sync-key offer is sealed to this one.
        self._enc_private = X25519PrivateKey.generate()
        self.enc_key = base64.b64encode(
            self._enc_private.public_key().public_bytes(
                encoding=serialization.Encoding.Raw,
                format=serialization.PublicFormat.Raw,
            )
        ).decode("ascii")

    def sign(self, *, msg_key: str, to_device: str, kind: str, body: str) -> str:
        payload = device_signing.message_payload(
            msg_key=msg_key,
            from_device=self.device_id,
            to_device=to_device,
            kind=kind,
            body=body,
        )
        return base64.b64encode(
            self._private.sign(
                device_signing._MESSAGE_CONTEXT + b"\x00" + device_signing._canonical(payload)
            )
        ).decode("ascii")

    def session_row(self, **overrides) -> dict:
        """How the directory describes this device, keys included — the channel
        a first pin's candidate key travels on."""
        row = {
            "sessionId": f"s-{self.device_id}",
            "deviceId": self.device_id,
            "deviceName": self.name,
            "workspace": "alpha",
            "workspacePath": f"/tmp/{self.device_id}",
            "title": "sender",
            "paneId": "rp1",
            "agentKey": "claude",
            "status": "running",
            "hostOnline": True,
            "deviceSignPublicKey": self.sign_key,
        }
        row.update(overrides)
        return row


#: The peer every inbound-message test receives from.
PEER = Peer()


#: The real server's enum. Enforced here because a fake that accepts anything
#: only ever proves the code agrees with itself: backend/scripts/verify_server_link.py
#: caught this module reporting the registry's own busy/idle/offline vocabulary,
#: which every sessions.sync and sessions.upsert was rejected for.
SESSION_STATUSES = ("running", "waiting", "exited", "disconnected")


def _reject_bad_status(message: dict, session: dict) -> dict | None:
    status = session.get("status")
    if status in (None, "") or status in SESSION_STATUSES:
        return None
    return _bad_request(message, f"status 必須是 {'|'.join(SESSION_STATUSES)}")


def default_responder(conn: "FakeConnection", message: dict) -> dict | None:
    kind = message.get("type")
    payload = message.get("payload") or {}
    if kind == "auth.hello":
        conn.hellos.append(payload)
        return _ok(
            message,
            {
                "memberId": "m1",
                "role": "member",
                "displayName": "Tester",
                "deviceId": payload.get("deviceId"),
                "deviceName": payload.get("deviceName"),
                "client": payload.get("client"),
            },
        )
    if kind == "sessions.sync":
        conn.syncs.append(payload)
        rows = []
        for index, session in enumerate(payload.get("sessions") or []):
            rejected = _reject_bad_status(message, session)
            if rejected is not None:
                return rejected
            row = dict(session)
            row.setdefault("sessionId", f"s{index + 1}")
            rows.append(row)
        return _ok(message, {"sessions": rows, "removed": []})
    if kind == "sessions.upsert":
        rejected = _reject_bad_status(message, payload)
        if rejected is not None:
            return rejected
        conn.upserts.append(payload)
        session_id = payload.get("sessionId") or f"u{len(conn.upserts)}"
        result = dict(payload)
        result.update({"sessionId": session_id, "hostMemberId": "m1", "hostOnline": True})
        return _ok(message, result)
    if kind == "sessions.remove":
        conn.removes.append(payload)
        return _ok(message, {"removed": True})
    if kind == "sessions.directory":
        conn.directories.append(payload)
        return _ok(message, {"sessions": conn.server.directory})
    if kind == "policy.get":
        conn.policy_gets.append(payload)
        return _ok(
            message,
            {
                "deviceId": payload.get("deviceId"),
                "policy": conn.server.policy,
                "revision": conn.server.policy_revision,
                "updatedAt": 0,
            },
        )
    if kind == "policy.set":
        conn.policy_sets.append(payload)
        conn.server.policy = payload.get("policy")
        conn.server.policy_revision += 1
        return _ok(
            message,
            {
                "deviceId": payload.get("deviceId"),
                "revision": conn.server.policy_revision,
                "updatedAt": 0,
            },
        )
    if kind == "messages.send":
        conn.sends.append(payload)
        return _ok(message, {"msgKey": payload.get("msgKey"), "state": "pending"})
    if kind == "messages.ack":
        conn.acks.append(payload)
        return _ok(message, {"msgKey": payload.get("msgKey")})
    return {
        "id": message["id"],
        "type": f"{kind}.result",
        "ok": False,
        "error": {"code": "BAD_REQUEST", "message": f"unknown type {kind}"},
    }


def rejecting_responder(code: str, message_text: str = "nope"):
    def responder(conn: "FakeConnection", message: dict) -> dict:
        if message.get("type") == "auth.hello":
            conn.hellos.append(message.get("payload") or {})
            return {
                "id": message["id"],
                "type": "auth.hello.result",
                "ok": False,
                "error": {"code": code, "message": message_text},
            }
        return default_responder(conn, message)

    return responder


class FakeConnection:
    def __init__(self, responder, server: "FakeServer") -> None:
        self.responder = responder
        self.server = server
        self.sent: list[dict] = []
        self.hellos: list[dict] = []
        self.upserts: list[dict] = []
        self.syncs: list[dict] = []
        self.removes: list[dict] = []
        self.directories: list[dict] = []
        self.policy_gets: list[dict] = []
        self.policy_sets: list[dict] = []
        self.sends: list[dict] = []
        self.acks: list[dict] = []
        self.closed = False
        self._inbox: asyncio.Queue = asyncio.Queue()

    async def send(self, raw: str) -> None:
        if self.closed:
            raise ConnectionError("fake connection is closed")
        message = json.loads(raw)
        self.sent.append(message)
        reply = self.responder(self, message)
        if reply is not None:
            await self._inbox.put(json.dumps(reply))

    async def push(self, frame: dict) -> None:
        """Server-initiated event (no id)."""
        await self._inbox.put(json.dumps(frame))

    async def close(self) -> None:
        if not self.closed:
            self.closed = True
            await self._inbox.put(None)

    def __aiter__(self) -> "FakeConnection":
        return self

    async def __anext__(self) -> str:
        item = await self._inbox.get()
        if item is None:
            raise StopAsyncIteration
        return item


def _self_signed(policy, *, seq: int = 0):
    """Wrap a policy in this device's own signature, as ``set_policy`` does.

    ``seq`` 0 is the resting state of a machine that has never written one, so a
    seeded policy is accepted without pretending a write happened.
    """
    if not isinstance(policy, dict):
        return policy
    document = {k: v for k, v in policy.items() if k != server_link.POLICY_SIGNATURE_FIELD}
    signature = device_signing.sign_policy(
        device_id=device_identity.device_id(), seq=seq, document=document
    )
    return {**document, server_link.POLICY_SIGNATURE_FIELD: {"seq": seq, "sig": signature}}


#: Allows every sender, so a test that is not about the policy is not about the
#: policy. `is_allowed` denies anything it cannot read, including None.
ALLOW_ALL_POLICY = {
    "version": 1,
    "default": "deny",
    "rules": [
        {"from": {"memberId": "*", "deviceId": "*"},
         "to": {"workspace": "*", "paneName": "*"},
         "action": "allow"}
    ],
}


class FakeServer:
    def __init__(self, responder=default_responder, count: int = 8, policy=None) -> None:
        self.connections = [FakeConnection(responder, self) for _ in range(count)]
        self.opened: list[FakeConnection] = []
        self.urls: list[str] = []
        # Signed as the device would sign it: the receiver refuses a policy it
        # cannot verify, so a fake that served a bare document would be testing
        # the deny path in every test that is not about the policy at all.
        self.policy = _self_signed(ALLOW_ALL_POLICY if policy is None else policy)
        self.policy_revision = 1
        #: What sessions.directory answers with — the whole team space, this
        #: device's own rows included, exactly as the real server sends it.
        #: The peer is in it by default because that is the channel a signing
        #: key travels on: a device the directory never mentions is one this
        #: machine has no key for and therefore refuses.
        self.directory: list[dict] = [PEER.session_row()]
    def connect(self, url: str):
        self.urls.append(url)
        server = self

        class _Dial:
            async def __aenter__(self) -> FakeConnection:
                conn = server.connections[len(server.opened)]
                server.opened.append(conn)
                return conn

            async def __aexit__(self, *_exc) -> bool:
                await server.opened[-1].close()
                return False

        return _Dial()


async def _until(predicate, timeout: float = 3.0) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition never became true")


# A poll must not hold a token file open while the link writes it. Windows will
# not replace or delete a file another thread has open (Python opens files
# without FILE_SHARE_DELETE), so the write fails with WinError 5 and the
# rotation the test is waiting for never lands. The writers hold _token_lock.
def _stored_token() -> str:
    with server_link._token_lock:
        return server_link.access_token()


def make_link(server: FakeServer, *, config: ServerLinkConfig = CONFIG, cleared=None) -> ServerLink:
    return ServerLink(
        connect=server.connect,
        config_loader=lambda: config,
        token_clearer=(lambda: cleared.append(True)) if cleared is not None else (lambda: None),
        device_name="test-box",
    )


# ---- not configured ---------------------------------------------------------


async def test_unconfigured_link_never_connects():
    server = FakeServer()
    link = make_link(server, config=ServerLinkConfig())
    assert await link.start() is False
    await asyncio.sleep(0.1)
    assert server.opened == []
    assert link._task is None
    await link.stop()


async def test_url_without_token_is_not_configured():
    assert not ServerLinkConfig(url="ws://x/ws").configured
    assert not ServerLinkConfig(token="t").configured
    assert ServerLinkConfig(url="ws://x/ws", token="t").configured


# ---- authentication ---------------------------------------------------------


async def test_authenticates_and_publishes_the_roster():
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    agent_messaging.register("p2", "builder", "/tmp/nest/proj-b", agent_key="codex")
    server = FakeServer()
    link = make_link(server)
    assert await link.start() is True
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs), timeout=CONNECT_TIMEOUT_S)
        conn = server.opened[0]
        assert server.urls == [CONFIG.url]

        hello = conn.hellos[0]
        assert hello["credential"] == CONFIG.token
        assert hello["client"] == server_link.CLIENT_NAME
        # The server records the last version each device reported, which is
        # how a protocol migration knows whether old builds are still online.
        assert hello["clientVersion"] == agent_team_backend.__version__
        assert hello["deviceName"] == "test-box"
        assert hello["deviceId"]
        assert link.member_id == "m1"

        # The first report on a connection is one flat sync, never per-pane
        # upserts — the server drops whatever is not in the list.
        assert len(conn.syncs) == 1
        assert conn.upserts == []
        by_pane = {u["paneId"]: u for u in conn.syncs[0]["sessions"]}
        assert by_pane["p1"] == {
            "title": "reviewer",
            "agentKey": "claude",
            "status": "waiting",
            "taskId": "",
            # Not "/tmp/proj-a". The absolute path is no longer published --
            # see server_link.workspace_digest for why it went and why it went
            # as a digest rather than as nothing at all.
            "workspacePath": server_link.workspace_digest("/tmp/proj-a"),
            "workspace": "proj-a",
            "paneId": "p1",
        }
        # The workspace label is the folder basename even for a nested path,
        # and deviceId is never sent (the server takes it from the connection).
        assert by_pane["p2"]["workspace"] == "proj-b"
        assert by_pane["p2"]["workspacePath"] == server_link.workspace_digest(
            "/tmp/nest/proj-b"
        )
        # The point of the change, stated as an assertion rather than left to
        # the reader: nothing on the wire contains the path.
        assert "/tmp/nest" not in str(by_pane["p2"])
        assert "deviceId" not in by_pane["p2"]
    finally:
        await link.stop()


@pytest.mark.parametrize("code", ["AUTH_REJECTED", "BAD_REQUEST", "DEVICE_CONFLICT"])
async def test_auth_hello_rejection_stops_the_link(code):
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a")
    server = FakeServer(responder=rejecting_responder(code))
    link = make_link(server)
    await link.start()
    try:
        await _until(lambda: bool(link.terminated_reason), timeout=CONNECT_TIMEOUT_S)
        assert code in link.terminated_reason
        # Terminal: no second dial, however long the backoff had to run.
        await asyncio.sleep(0.15)
        assert len(server.opened) == 1
        assert server.opened[0].syncs == []
        assert link._task is not None and link._task.done()
    finally:
        await link.stop()


async def test_transport_failure_reconnects():
    """A dial that raises is transient, unlike a rejected credential."""
    server = FakeServer()
    attempts = {"n": 0}
    real_connect = server.connect

    def flaky(url: str):
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise OSError("connection refused")
        return real_connect(url)

    link = ServerLink(
        connect=flaky, config_loader=lambda: CONFIG, device_name="test-box"
    )
    await link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].hellos), timeout=CONNECT_TIMEOUT_S)
        assert attempts["n"] >= 2
        assert not link.terminated_reason
    finally:
        await link.stop()


# ---- revocation -------------------------------------------------------------


async def test_auth_revoked_clears_the_token_and_stops_reconnecting():
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a")
    server = FakeServer()
    cleared: list[bool] = []
    link = make_link(server, cleared=cleared)
    await link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs), timeout=CONNECT_TIMEOUT_S)
        await server.opened[0].push(
            {"type": "auth.revoked", "payload": {"memberId": "m1", "reason": "disabled"}}
        )
        await _until(lambda: bool(link.terminated_reason))
        assert "disabled" in link.terminated_reason
        # The reason is set before the token clear is awaited off-thread.
        await _until(lambda: bool(cleared))
        assert cleared == [True]
        # The whole point: a revoked account must not keep knocking.
        await asyncio.sleep(0.15)
        assert len(server.opened) == 1
        assert link._task is not None and link._task.done()
    finally:
        await link.stop()


# ---- reconnect --------------------------------------------------------------


async def test_reconnect_reauthenticates_and_republishes_the_roster():
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer()
    link = make_link(server)
    await link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs), timeout=CONNECT_TIMEOUT_S)
        first = server.opened[0]
        assert first.syncs[0]["sessions"][0].get("sessionId") is None  # server issues it

        await first.close()

        await _until(lambda: len(server.opened) >= 2 and bool(server.opened[1].syncs), timeout=CONNECT_TIMEOUT_S)
        second = server.opened[1]
        assert second.hellos[0]["credential"] == CONFIG.token
        # Reconnecting flattens the roster again rather than diffing against
        # what the previous connection was told, and carries the sessionId the
        # first connection was given so the server updates that row.
        sessions = second.syncs[0]["sessions"]
        assert [s["paneId"] for s in sessions] == ["p1"]
        assert sessions[0]["sessionId"] == "s1"
        assert second.upserts == []
    finally:
        await link.stop()


# ---- roster changes ---------------------------------------------------------


async def test_roster_additions_renames_and_removals_are_published():
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer()
    link = make_link(server)
    await link.start()
    try:
        conn = None
        await _until(lambda: bool(server.opened and server.opened[0].syncs), timeout=CONNECT_TIMEOUT_S)
        conn = server.opened[0]

        agent_messaging.register("p2", "builder", "/tmp/proj-a", agent_key="codex")
        link.notify_roster_changed()
        await _until(lambda: any(u["paneId"] == "p2" for u in conn.upserts))

        # A rename is a re-register under the same pane id.
        agent_messaging.register("p1", "auditor", "/tmp/proj-a", agent_key="claude")
        link.notify_roster_changed()
        await _until(
            lambda: any(u["paneId"] == "p1" and u["title"] == "auditor" for u in conn.upserts)
        )

        agent_messaging.set_busy("p2", True)
        link.notify_roster_changed()
        await _until(
            lambda: any(u["paneId"] == "p2" and u["status"] == "running" for u in conn.upserts)
        )

        # A closed pane is deleted, not reported with a made-up status: the
        # contract's status enum is running|waiting|exited, and inventing a
        # "closed" value earned a BAD_REQUEST.
        agent_messaging.unregister("p2")
        link.notify_roster_changed()
        await _until(lambda: bool(conn.removes))
        assert conn.removes[0] == {"sessionId": "u1"}
        assert all(u["status"] != "closed" for u in conn.upserts)

        # An unchanged roster is not re-sent on every sweep.
        settled = (len(conn.upserts), len(conn.syncs), len(conn.removes))
        await asyncio.sleep(0.2)
        assert (len(conn.upserts), len(conn.syncs), len(conn.removes)) == settled
    finally:
        await link.stop()


async def test_a_session_the_server_no_longer_has_counts_as_removed(caplog):
    # The server forgot the session (its own cleanup, a restart): SESSION_GONE is
    # the outcome remove wanted, not a failure to retry on every sweep (7304
    # warnings in three days on an installed build).
    def session_gone(conn: "FakeConnection", message: dict) -> dict | None:
        if message.get("type") == "sessions.remove":
            conn.removes.append(message.get("payload") or {})
            return {
                "id": message["id"],
                "type": "sessions.remove.result",
                "ok": False,
                "error": {"code": "SESSION_GONE", "message": "no such session"},
            }
        return default_responder(conn, message)

    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer(responder=session_gone)
    link = make_link(server)
    await link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs), timeout=CONNECT_TIMEOUT_S)
        conn = server.opened[0]
        caplog.set_level(logging.WARNING, logger="agent_team_backend.server_link")
        agent_messaging.unregister("p1")
        link.notify_roster_changed()
        await _until(lambda: bool(conn.removes))
        link.notify_roster_changed()
        await asyncio.sleep(0.3)
        assert len(conn.removes) == 1
        assert not [r for r in caplog.records if "sessions.remove" in r.getMessage()]
    finally:
        await link.stop()


async def test_updates_reuse_the_session_id_the_server_issued():
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a")
    server = FakeServer()
    link = make_link(server)
    await link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs), timeout=CONNECT_TIMEOUT_S)
        conn = server.opened[0]
        assert "sessionId" not in conn.syncs[0]["sessions"][0]
        agent_messaging.set_busy("p1", True)
        link.notify_roster_changed()
        await _until(lambda: bool(conn.upserts))
        assert conn.upserts[0]["sessionId"] == "s1"
    finally:
        await link.stop()


async def test_a_rejected_upsert_does_not_break_the_link():
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a")

    def refuse_upserts(conn: FakeConnection, message: dict) -> dict:
        if message.get("type") == "sessions.upsert":
            conn.upserts.append(message.get("payload") or {})
            return {
                "id": message["id"],
                "type": "sessions.upsert.result",
                "ok": False,
                "error": {"code": "NOT_HOST", "message": "someone else owns it"},
            }
        return default_responder(conn, message)

    server = FakeServer(responder=refuse_upserts)
    link = make_link(server)
    await link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs), timeout=CONNECT_TIMEOUT_S)
        agent_messaging.set_busy("p1", True)
        link.notify_roster_changed()
        # Retried on the next sweep rather than treated as a lost connection.
        await _until(lambda: len(server.opened[0].upserts) >= 2)
        assert not link.terminated_reason
        assert len(server.opened) == 1
    finally:
        await link.stop()


async def test_a_restore_placeholder_is_published_as_disconnected_not_running():
    """A pane the window has restored but not opened has no CLI behind it.

    The window mirrors it anyway so it stays addressable, and reports it busy —
    that flag answers "would a message sent now wait", and for a placeholder it
    would. Publishing that as "running" told the network view eight unopened
    panes were working agents, which is what this test exists to stop.
    """
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude", realized=False)
    agent_messaging.set_busy("p1", True)
    server = FakeServer()
    link = make_link(server)
    await link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs), timeout=CONNECT_TIMEOUT_S)
        conn = server.opened[0]
        published = {s["paneId"]: s for s in conn.syncs[0]["sessions"]}
        assert published["p1"]["status"] == "disconnected"

        # Opening it is a re-register: the same busy flag now means a working
        # agent, and the status follows.
        agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
        agent_messaging.set_busy("p1", True)
        link.notify_roster_changed()
        await _until(
            lambda: any(u["paneId"] == "p1" and u["status"] == "running" for u in conn.upserts)
        )
    finally:
        await link.stop()


async def test_the_published_status_is_the_word_the_sidebar_is_showing():
    """The network view must call a pane what its own window calls it.

    Before this, the only signal reaching here was `busy`, so seven sidebar
    states collapsed into two words. The sharp case is the last assertion: a
    pane whose CLI died is not busy, so it published as "waiting" — the one
    word that promises a message sent now would be picked up.
    """
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    agent_messaging.set_busy("p1", False, "idle")
    server = FakeServer()
    link = make_link(server)
    await link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs), timeout=CONNECT_TIMEOUT_S)
        conn = server.opened[0]

        def published(badge: str) -> bool:
            """A pane reaches the server through whichever channel is due — the
            opening sync or a later upsert — so both are searched."""
            rows = list(conn.upserts) + [
                row for sync in conn.syncs for row in sync["sessions"]
            ]
            return any(r["paneId"] == "p1" and r["status"] == badge for r in rows)

        assert published("idle")
        for badge, busy in (("awaiting", False), ("starting", True), ("error", False)):
            agent_messaging.set_busy("p1", busy, badge)
            link.notify_roster_changed()
            await _until(lambda badge=badge: published(badge))
    finally:
        await link.stop()


async def test_a_window_that_reports_no_badge_word_falls_back_to_the_busy_flag():
    """What an un-upgraded window looks like. It never sends a status word, so
    the old derivation has to keep working — otherwise upgrading the backend
    alone would blank the status of every pane on the machine."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    agent_messaging.set_busy("p1", True)  # no badge word, as an old build sends
    server = FakeServer()
    link = make_link(server)
    await link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs), timeout=CONNECT_TIMEOUT_S)
        published = {s["paneId"]: s for s in server.opened[0].syncs[0]["sessions"]}
        assert published["p1"]["status"] == "running"
    finally:
        await link.stop()


async def test_a_placeholder_stays_disconnected_whatever_word_arrives():
    """The two local overrides win over the reported word, and must: a window
    can still be reporting the badge of the pane it had before a cold restore,
    and `offline` is something only this side knows."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude", realized=False)
    agent_messaging.set_busy("p1", True, "running")
    server = FakeServer()
    link = make_link(server)
    await link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs), timeout=CONNECT_TIMEOUT_S)
        published = {s["paneId"]: s for s in server.opened[0].syncs[0]["sessions"]}
        assert published["p1"]["status"] == "disconnected"
    finally:
        await link.stop()


# ---- cross-device messages --------------------------------------------------


def _pending(
    msg_key: str = "pa:mcp:deadbeef",
    *,
    pane_id: str = "p1",
    member_id: str = "m1",
    text: str = "please review",
    cipher: str = "",
    peer: Peer = PEER,
    sign: bool = True,
) -> dict:
    """A push from the server, signed by *peer* the way a real device signs.

    ``member_id`` defaults to "m1", which is also the receiver's own member (see
    FakeServer's auth.hello) — i.e. another machine of the same person. Pass
    someone else's id to exercise the pane policy, which is only consulted for
    senders outside your own account. Note that the member id is deliberately
    *not* covered by the signature: it is the server's word, and what decides
    whether a sender counts as one of your own machines is the member recorded
    against the pinned key, never this field.

    ``sign=False`` is the unauthenticated case — what a relay writing its own
    messages can produce, and what an un-upgraded peer sends.
    """
    body_kind = "cipher" if cipher else "text"
    body = cipher or text
    payload = {
        "msgKey": msg_key,
        body_kind: body,
        "from": {
            "deviceId": peer.device_id,
            "memberId": member_id,
            "workspace": "alpha",
            "paneName": "sender",
        },
        "to": {"workspace": "proj-a", "paneName": "reviewer", "paneId": pane_id},
    }
    if sign:
        payload["sig"] = peer.sign(
            msg_key=msg_key,
            to_device=device_identity.device_id(),
            kind=body_kind,
            body=body,
        )
    return payload


@pytest.fixture
def broadcasts(monkeypatch):
    """Every *delivery* the link hands to the on-machine path.

    Filtered rather than raw: the link also broadcasts trust notices (a device
    seen for the first time, a pinned key that changed), and a raw capture would
    make every count here depend on how many of those a test happened to
    provoke. Those are asserted where they belong, in test_server_link_trust.
    """
    events: list[dict] = []

    async def fake_broadcast(event: dict, **_kwargs) -> None:
        if event.get("type") == "agent_msg.deliver":
            events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    return events


#: How long a test waits for its link to come up, before the link is anything
#: the test asserts about. Not `_until`'s 3s: the hello waits on the trust
#: record, which on Windows is read and written through DPAPI
#: (CryptProtectData, crypt32), and that service's latency spikes on the
#: runner. Run 38180394147 measured this wait at 3.1s and 7.1s, against a
#: median of 0.1s for the file, in a window where loading the system root
#: store took 2.6s (0.4s otherwise) while tests touching no crypto kept their
#: usual times and the CPU sat at 5%. What a test asserts keeps the 3s.
CONNECT_TIMEOUT_S = 20.0


def _thread_stacks() -> str:
    """Every thread's stack, so a link that never came up says where it waited."""
    names = {thread.ident: thread.name for thread in threading.enumerate()}
    return "\n".join(
        f"--- {names.get(ident, ident)}\n" + "".join(traceback.format_stack(frame))
        for ident, frame in sys._current_frames().items()
    )


async def _connected(server: FakeServer, **kwargs) -> ServerLink:
    link = make_link(server, **kwargs)
    await link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs), timeout=CONNECT_TIMEOUT_S)
    except AssertionError:
        raise AssertionError(
            f"the link did not come up within {CONNECT_TIMEOUT_S}s:\n{_thread_stacks()}"
        ) from None
    return link


async def test_outbound_send_goes_over_the_link():
    server = FakeServer()
    link = await _connected(server)
    try:
        reply = await link.send_message(
            to={"deviceId": "dev-b", "workspace": "beta", "paneName": "builder"},
            sender={"workspace": "alpha", "paneName": "sender", "paneId": "pa"},
            text="ship it",
            msg_key="pa:mcp:1",
        )
        assert reply["ok"] is True
        assert reply["payload"]["state"] == "pending"
        sent = server.opened[0].sends
        assert len(sent) == 1
        signature = sent[0].pop("sig")
        # And a v2 signature beside it, covering the send time (plan 797ad7 B4;
        # test_message_sig2 has the rest).
        assert device_signing.verify_message_v2(
            sent[0].pop("sig2"), public_key_b64=device_signing.public_key(), msg_key="pa:mcp:1",
            from_device=link._device_id, to_device="dev-b", kind="text", body="ship it",
        ) is not None
        assert sent == [
            {
                "to": {"deviceId": "dev-b", "workspace": "beta", "paneName": "builder"},
                "text": "ship it",
                "msgKey": "pa:mcp:1",
                "from": {"workspace": "alpha", "paneName": "sender", "paneId": "pa"},
            }
        ]
        # The signature is the whole point of the frame carrying one: it has to
        # verify against *this* device's published key, over the body actually
        # sent and the pair of device ids it was addressed between.
        assert device_signing.verify_message(
            signature,
            public_key_b64=device_signing.public_key(),
            msg_key="pa:mcp:1",
            from_device=link._device_id,
            to_device="dev-b",
            kind="text",
            body="ship it",
        )
    finally:
        await link.stop()


# ---- end-to-end encryption ---------------------------------------------------


def _seed_peer_key(device_id: str, public_key: str) -> None:
    """Put one keyed device in the roster, which is how keys are distributed."""
    remote_roster.replace(
        [
            {
                "sessionId": f"s-{device_id}",
                "deviceId": device_id,
                "deviceName": "far box",
                "workspace": "beta",
                "title": "builder",
                "paneId": "pb",
                "agentKey": "codex",
                "status": "running",
                "hostOnline": True,
                "devicePublicKey": public_key,
            }
        ],
        local_device_id="dev-local",
    )


@pytest.fixture
def peer_key(tmp_path, monkeypatch):
    """A second machine's keypair: its own data dir, so its own key file."""
    from agent_team_backend import device_crypto

    here = os.environ.get("AGENT_TEAM_DATA_DIR")
    peer_home = tmp_path / "peer"
    peer_home.mkdir(exist_ok=True)
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(peer_home))
    key = device_crypto.public_key()
    if here:
        monkeypatch.setenv("AGENT_TEAM_DATA_DIR", here)
    remote_roster._reset_for_test()
    yield key
    remote_roster._reset_for_test()


async def test_hello_publishes_this_devices_public_key():
    """Sent on every hello, not only the first: the server keeps the last key it
    was told, and a build that stopped sending one would leave peers encrypting
    to a key this machine no longer holds."""
    from agent_team_backend import device_crypto

    server = FakeServer()
    link = await _connected(server)
    try:
        hello = server.opened[0].hellos[0]
        assert hello["publicKey"] == device_crypto.public_key()
    finally:
        await link.stop()


async def test_a_message_to_a_keyed_device_leaves_as_ciphertext(peer_key):
    """The whole point of the change: the relay stores what it cannot read."""
    server = FakeServer()
    link = await _connected(server)
    try:
        _seed_peer_key("dev-b", peer_key)
        reply = await link.send_message(
            to={"deviceId": "dev-b", "workspace": "beta", "paneName": "builder"},
            sender=None,
            text="deploy the payment fix",
            msg_key="pa:mcp:enc",
        )
        assert reply["ok"] is True
        sent = server.opened[0].sends[0]
        assert "text" not in sent, "a plaintext copy alongside the cipher is a downgrade"
        assert sent["cipher"]
        assert "deploy" not in sent["cipher"]
    finally:
        await link.stop()


async def test_a_device_with_no_published_key_still_gets_plaintext():
    """An un-upgraded peer can only read plaintext, and refusing to talk to it
    would break every existing pair the day this ships."""
    server = FakeServer()
    link = await _connected(server)
    try:
        remote_roster._reset_for_test()
        reply = await link.send_message(
            to={"deviceId": "dev-old", "workspace": "beta", "paneName": "builder"},
            sender=None,
            text="ship it",
            msg_key="pa:mcp:plain",
        )
        assert reply["ok"] is True
        assert server.opened[0].sends[0]["text"] == "ship it"
        assert "cipher" not in server.opened[0].sends[0]
    finally:
        await link.stop()


async def test_a_peer_that_had_a_key_never_falls_back_to_plaintext(peer_key):
    """Without this the encryption would be advisory: anything that made a key
    disappear — a stale roster, a server that dropped the field, a peer on an
    older build — would quietly turn ciphertext back into cleartext."""
    server = FakeServer()
    link = await _connected(server)
    try:
        _seed_peer_key("dev-b", peer_key)
        await link.send_message(
            to={"deviceId": "dev-b", "workspace": "beta", "paneName": "builder"},
            sender=None,
            text="first, encrypted",
            msg_key="pa:mcp:one",
        )
        # The key vanishes from the roster.
        remote_roster._reset_for_test()
        reply = await link.send_message(
            to={"deviceId": "dev-b", "workspace": "beta", "paneName": "builder"},
            sender=None,
            text="second, must not go out in the clear",
            msg_key="pa:mcp:two",
        )
        assert reply["ok"] is False
        assert reply["error"]["code"] == server_link.LINK_ENCRYPTION_FAILED
        assert len(server.opened[0].sends) == 1, "nothing more may reach the wire"
    finally:
        await link.stop()


async def test_an_incoming_sealed_message_is_opened_and_delivered(broadcasts):
    """The receiving half: what the sender sealed for this device's key reaches
    the pane as ordinary text."""
    from agent_team_backend import device_crypto

    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer()
    link = await _connected(server)
    try:
        payload = _pending(
            cipher=device_crypto.seal(
                "please review",
                recipient_public_key=device_crypto.public_key(),
                from_device=PEER.device_id,
                to_device=link._device_id,
            )
        )
        await server.opened[0].push({"type": "messages.pending", "payload": payload})
        await _until(lambda: any(e["type"] == "agent_msg.deliver" for e in broadcasts), timeout=CONNECT_TIMEOUT_S)
        delivered = next(e for e in broadcasts if e["type"] == "agent_msg.deliver")
        assert delivered["payload"]["content"] == "please review"
    finally:
        await link.stop()


async def test_a_message_that_will_not_open_is_refused_not_typed_in(broadcasts):
    """Delivering the ciphertext as if it were text would type a wall of base64
    into somebody's CLI. Rejected, not failed: a retry fails identically."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        payload = _pending(cipher="bm90LWEtcmVhbC1zZWFsZWQtYm94")
        await conn.push({"type": "messages.pending", "payload": payload})
        await _until(lambda: bool(conn.acks))
        assert conn.acks[0]["state"] == "rejected"
        assert conn.acks[0]["reason"] == "undecryptable"
        assert [e for e in broadcasts if e["type"] == "agent_msg.deliver"] == []
    finally:
        await link.stop()


# ---- degraded link ----------------------------------------------------------
# A configured server that is unreachable must not be reported as an unknown
# device: the address may be perfectly correct and only the link is down.


async def test_a_disconnected_link_fails_fast_and_recovers_on_its_own():
    server = FakeServer()
    link = await _connected(server)
    try:
        await server.opened[0].close()
        await _until(lambda: link._ws is None)

        # Fast, not a REQUEST_TIMEOUT_S stall: nothing can answer a socket that
        # is not there, so waiting on it only makes the error slower.
        reply = await asyncio.wait_for(
            link.send_message(
                to={"deviceId": "dev-b", "workspace": "beta", "paneName": "builder"},
                sender=None,
                text="ship it",
                msg_key="pa:mcp:while-down",
            ),
            timeout=1.0,
        )
        assert reply["ok"] is False
        assert reply["error"]["code"] == server_link.LINK_OFFLINE
        # Names which kind of "not connected" this is: "retry shortly" is the
        # right advice for exactly one of the three states this covers, and a
        # rejected token or a wrong address is not it.
        assert reply["error"]["state"] in (
            server_link.STATE_CONNECTING,
            server_link.STATE_UNREACHABLE,
        )
        assert reply["error"]["state"] in reply["error"]["message"]

        # The reconnect loop is what changes the answer, and it does so without
        # anything reaching in to restart it.
        await _until(lambda: len(server.opened) >= 2 and bool(server.opened[1].syncs), timeout=CONNECT_TIMEOUT_S)
        resumed = await link.send_message(
            to={"deviceId": "dev-b", "workspace": "beta", "paneName": "builder"},
            sender=None,
            text="ship it",
            msg_key="pa:mcp:after-recovery",
        )
        assert resumed["ok"] is True
        assert server.opened[1].sends[0]["msgKey"] == "pa:mcp:after-recovery"
    finally:
        await link.stop()


async def test_a_socket_that_has_not_authenticated_yet_is_offline_not_a_refusal():
    """auth.hello lands between "the socket is up" and "requests work". A send
    written into that gap comes back AUTH_REQUIRED, which reads as the server
    refusing the message rather than the link not being ready."""
    server = FakeServer()
    link = make_link(server)
    link._ws = object()  # dialled, auth.hello not yet accepted
    reply = await link.send_message(
        to={"deviceId": "dev-b", "workspace": "beta", "paneName": "builder"},
        sender=None,
        text="ship it",
        msg_key="pa:mcp:mid-auth",
    )
    assert reply["error"]["code"] == server_link.LINK_OFFLINE


async def test_a_revoked_credential_says_so_instead_of_promising_a_retry():
    """LINK_OFFLINE invites a retry; this one never resolves by retrying."""
    server = FakeServer(responder=rejecting_responder("AUTH_REJECTED"))
    link = make_link(server)
    await link.start()
    try:
        await _until(lambda: bool(link.terminated_reason), timeout=CONNECT_TIMEOUT_S)
        reply = await link.send_message(
            to={"deviceId": "dev-b", "workspace": "beta", "paneName": "builder"},
            sender=None,
            text="ship it",
            msg_key="pa:mcp:revoked",
        )
        assert reply["ok"] is False
        assert reply["error"]["code"] == server_link.LINK_UNAUTHORIZED
        assert "AUTH_REJECTED" in reply["error"]["message"]
    finally:
        await link.stop()


async def test_the_policy_cache_outlives_the_connection_that_fetched_it():
    """The receiver-side gate must not depend on the control plane being
    reachable at the moment a message lands (t6/t12)."""
    server = FakeServer()
    link = await _connected(server)
    try:
        await _until(lambda: link._policy_revision == 1)
        cached = link._policy

        await server.opened[0].close()
        await _until(lambda: link._ws is None)
        assert link._policy == cached
        assert link._policy_revision == 1

        # And a reconnect re-reads it, because policy.changed pushed while this
        # device was away was missed.
        await _until(lambda: len(server.opened) >= 2 and bool(server.opened[1].policy_gets))
    finally:
        await link.stop()


async def test_inbound_message_is_delivered_on_the_existing_path_and_then_acked(broadcasts):
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push({"type": "messages.pending", "payload": _pending()})
        await _until(lambda: bool(broadcasts))

        assert len(broadcasts) == 1
        assert broadcasts[0]["type"] == "agent_msg.deliver"
        payload = broadcasts[0]["payload"]
        assert payload["msg_key"] == "pa:mcp:deadbeef"
        assert payload["target_pane_id"] == "p1"
        assert payload["target_workspace_path"] == "/tmp/proj-a"
        assert payload["content"] == "please review"
        # Addressable straight back, and rate-limited by the receiving window
        # because nothing applied the per-pair limit on the way in.
        assert payload["from_display"] == "dev-a/alpha/sender"
        assert payload["from_pane_id"] == ""
        assert payload["cross_workspace"] is True
        assert payload["rate_limit"] is True
        # Nothing is acked until the window that owns the pane reports back.
        assert conn.acks == []

        # An on-machine message's key is not this link's business.
        assert link.note_delivery_result("someone-elses-key", True, "") is False

        assert link.note_delivery_result("pa:mcp:deadbeef", True, "") is True
        await _until(lambda: bool(conn.acks))
        assert conn.acks[0] == {
            "msgKey": "pa:mcp:deadbeef",
            "state": "delivered",
            "paneId": "p1",
        }
        # A second report cannot ack twice.
        assert link.note_delivery_result("pa:mcp:deadbeef", True, "") is False
    finally:
        await link.stop()


async def test_a_refused_delivery_is_acked_as_failed(broadcasts):
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push({"type": "messages.pending", "payload": _pending()})
        await _until(lambda: bool(broadcasts))
        # The renderer's reason is JSON; the ack carries the key alone.
        link.note_delivery_result("pa:mcp:deadbeef", False, '{"key": "rate-limit"}')
        await _until(lambda: bool(conn.acks))
        assert conn.acks[0] == {
            "msgKey": "pa:mcp:deadbeef",
            "state": "failed",
            "reason": "rate-limit",
            "paneId": "p1",
        }
    finally:
        await link.stop()


async def test_an_unconfirmed_delivery_is_acked_as_delivered_with_its_reason(broadcasts):
    """The text went in but the CLI has not shown it yet. "failed" would make
    the far sender resend work that may already be running, so the ack says
    delivered and carries the caveat as its reason."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push({"type": "messages.pending", "payload": _pending()})
        await _until(lambda: bool(broadcasts))
        link.note_delivery_result("pa:mcp:deadbeef", False, '{"key": "delivery-unconfirmed"}')
        await _until(lambda: bool(conn.acks))
        assert conn.acks[0] == {
            "msgKey": "pa:mcp:deadbeef",
            "state": "delivered",
            "reason": "delivery-unconfirmed",
            "paneId": "p1",
        }
    finally:
        await link.stop()


async def test_an_unresolvable_target_is_acked_as_failed_without_delivering(broadcasts):
    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push({"type": "messages.pending", "payload": _pending()})
        await _until(lambda: bool(conn.acks))
        assert conn.acks[0]["state"] == "failed"
        assert "paneId" not in conn.acks[0]
        assert broadcasts == []
    finally:
        await link.stop()


async def test_the_same_msg_key_pushed_twice_is_injected_once(broadcasts):
    """A backend restart can leave the old socket open while the new one is up,
    and the server pushes to every connection it holds for this device."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push({"type": "messages.pending", "payload": _pending()})
        await conn.push({"type": "messages.pending", "payload": _pending()})
        await _until(lambda: bool(broadcasts))
        await asyncio.sleep(0.1)
        assert len(broadcasts) == 1
        assert conn.acks == []
    finally:
        await link.stop()


async def test_policy_denial_acks_rejected_and_never_reaches_the_renderer(broadcasts):
    """A member you invited is subject to the policy; the empty one denies."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer(policy={"version": 1, "default": "deny", "rules": []})
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push(
            {"type": "messages.pending", "payload": _pending(member_id="m2")}
        )
        await _until(lambda: bool(conn.acks))
        assert conn.acks[0] == {
            "msgKey": "pa:mcp:deadbeef",
            "state": "rejected",
            "reason": "policy-denied",
        }
        # rejected, not failed: the sender must not retry a permission refusal.
        # The refusal is announced to this machine's own windows (the knock
        # list), which is the point of that surface — but the message itself
        # must never reach the delivery path.
        assert [e for e in broadcasts if e["type"] == "agent_msg.deliver"] == []
        # The refusal is announced to this machine's own windows — the knock
        # list is the point of that surface — but the message itself never
        # reaches the delivery path.
        assert [r["memberId"] for r in link.access_requests()] == ["m2"]
    finally:
        await link.stop()


async def test_a_blocked_device_is_refused_even_when_it_is_your_own(broadcasts):
    """The ordering that makes a block worth having.

    Every other mechanism here grants: rules grant, and sharing your member id
    grants unconditionally. A laptop of yours that walked off can only be shut
    out by something that runs ahead of that grant, which is why the block list
    is consulted before the own-device shortcut and not after it.
    """
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer(
        policy={
            "version": 1,
            "default": "allow",
            "rules": [],
            "blocked": [{"deviceId": "dev-a", "reason": "stolen"}],
        }
    )
    link = await _connected(server)
    try:
        conn = server.opened[0]
        # member_id defaults to m1 — the receiver's own member. Even that, and
        # even under default:allow, does not get past a block.
        await conn.push({"type": "messages.pending", "payload": _pending()})
        await _until(lambda: bool(conn.acks))
        assert conn.acks[0]["state"] == "rejected"
        assert broadcasts == []
        # A blocked sender leaves no knock: the point of a block is that this
        # machine stops being asked about that device.
        assert link.access_requests() == []
    finally:
        await link.stop()


async def test_a_blocked_sender_is_told_the_same_thing_an_unauthorized_one_is(broadcasts):
    """Naming the block on the wire would hand the sender an oracle — the same
    reason authorization runs before pane resolution in this path."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer(
        policy={"version": 1, "default": "deny", "rules": [], "blocked": [{"memberId": "m2"}]}
    )
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push({"type": "messages.pending", "payload": _pending(member_id="m2")})
        await _until(lambda: bool(conn.acks))
        assert conn.acks[0]["reason"] == "policy-denied"
    finally:
        await link.stop()


async def test_a_refused_member_leaves_a_knock_the_receiver_can_see(broadcasts):
    """Before this, a denied message told the sender and told the person whose
    machine refused it nothing at all."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer(policy={"version": 1, "default": "deny", "rules": []})
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push({"type": "messages.pending", "payload": _pending(member_id="m2")})
        await _until(lambda: bool(link.access_requests()))
        knock = link.access_requests()[0]
        assert knock["memberId"] == "m2"
        assert knock["deviceId"] == "dev-a"
        assert (knock["workspace"], knock["paneName"]) == ("proj-a", "reviewer")
        assert knock["attempts"] == 1

        # A second attempt refreshes the row rather than adding one.
        await conn.push(
            {"type": "messages.pending", "payload": _pending("pa:mcp:second", member_id="m2")}
        )
        await _until(lambda: link.access_requests()[0]["attempts"] == 2)
        assert len(link.access_requests()) == 1
    finally:
        await link.stop()


async def test_your_own_machine_leaves_no_knock(broadcasts):
    """It was never refused, so there is nothing to decide about it."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    # An own-device pin only skips the pane policy once somebody has vouched for
    # it; see test_server_link_trust for why the pin alone is not enough.
    trust_store.pin_device(
        PEER.device_id, sign_key=PEER.sign_key, member_id="m1", own_member_id="m1"
    )
    trust_store.approve_device(PEER.device_id)
    server = FakeServer(policy={"version": 1, "default": "deny", "rules": []})
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push({"type": "messages.pending", "payload": _pending()})
        await _until(lambda: bool(broadcasts))
        assert link.access_requests() == []
    finally:
        await link.stop()


async def test_your_own_other_machine_is_not_subject_to_the_pane_policy(broadcasts):
    """Signing the same account in on a second device is itself the grant.

    The deny-everything policy below would refuse anyone else, and does (see the
    test above); it must not stand between two machines of the same person, or
    adding a laptop would mean editing a policy before it could reach anything.
    """
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    # An own-device pin only skips the pane policy once somebody has vouched for
    # it; see test_server_link_trust for why the pin alone is not enough.
    trust_store.pin_device(
        PEER.device_id, sign_key=PEER.sign_key, member_id="m1", own_member_id="m1"
    )
    trust_store.approve_device(PEER.device_id)
    server = FakeServer(policy={"version": 1, "default": "deny", "rules": []})
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push(
            {"type": "messages.pending", "payload": _pending(member_id="m1")}
        )
        await _until(lambda: bool(broadcasts))
        assert conn.acks == []  # delivered, not rejected
    finally:
        await link.stop()


async def test_a_message_with_no_sender_member_is_still_policed(broadcasts):
    """The exemption keys on an equal, non-empty member id.

    A payload that arrives without one must fall through to the policy rather
    than compare empty-to-empty and let itself in.
    """
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer(policy={"version": 1, "default": "deny", "rules": []})
    link = await _connected(server)
    try:
        conn = server.opened[0]
        payload = _pending(member_id="m1")
        payload["from"]["memberId"] = ""
        await conn.push({"type": "messages.pending", "payload": payload})
        await _until(lambda: bool(conn.acks))
        assert conn.acks[0]["state"] == "rejected"
        assert conn.acks[0]["reason"] == "policy-denied"
        assert [e for e in broadcasts if e["type"] == "agent_msg.deliver"] == []
    finally:
        await link.stop()


async def test_the_policy_still_admits_an_invited_member_it_allows(broadcasts):
    """The exemption does not replace the policy: an explicit allow still works."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer(
        policy={
            "version": 1,
            "default": "deny",
            "rules": [
                {
                    "from": {"memberId": "m2", "deviceId": "*"},
                    "to": {"workspace": "*", "paneName": "*"},
                    "action": "allow",
                }
            ],
        }
    )
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push(
            {"type": "messages.pending", "payload": _pending(member_id="m2")}
        )
        await _until(lambda: bool(broadcasts))
        assert conn.acks == []
    finally:
        await link.stop()


async def test_the_policy_is_fetched_once_and_refetched_only_on_a_new_revision(broadcasts):
    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await _until(lambda: bool(conn.policy_gets))
        assert len(conn.policy_gets) == 1

        for index in range(3):
            await conn.push({"type": "messages.pending", "payload": _pending(f"k{index}")})
        await _until(lambda: len(conn.acks) >= 3)
        # The control plane is not in the path of a message.
        assert len(conn.policy_gets) == 1

        # A nudge at the revision already cached is not worth a round trip.
        await conn.push({"type": "policy.changed", "payload": {"revision": 1}})
        await asyncio.sleep(0.05)
        assert len(conn.policy_gets) == 1

        server.policy_revision = 2
        await conn.push({"type": "policy.changed", "payload": {"revision": 2}})
        await _until(lambda: len(conn.policy_gets) == 2)
    finally:
        await link.stop()


# ---- writing the policy (the Settings editor) --------------------------------


def _allow_own_devices(member_id: str = "m1") -> dict:
    return {
        "version": 1,
        "default": "deny",
        "rules": [
            {
                "from": {"memberId": member_id, "deviceId": "*"},
                "to": {"workspace": "*", "paneName": "*"},
                "action": "allow",
            }
        ],
    }


async def test_writing_the_policy_publishes_it_and_adopts_the_new_revision():
    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await _until(lambda: bool(conn.policy_gets))
        document = _allow_own_devices()

        reply = await link.set_policy(document)

        assert reply["ok"] is True
        assert conn.policy_sets[0]["deviceId"] == link._device_id
        # What leaves is the document plus this device's own signature over it.
        # The server stores that verbatim, which is exactly what it did before —
        # the difference is that it can no longer hand back something else.
        written = conn.policy_sets[0]["policy"]
        envelope = written.pop(server_link.POLICY_SIGNATURE_FIELD)
        assert written == document
        assert device_signing.verify_policy(
            envelope["sig"],
            public_key_b64=device_signing.public_key(),
            device_id=link._device_id,
            seq=envelope["seq"],
            document=document,
        )
        # Adopted locally, so the editor re-reading right after the save is not
        # shown the policy it just replaced.
        assert link.policy_snapshot() == {"policy": document, "revision": 2}
        # And the push that follows the write is a no-op, since the cache is
        # already at that revision.
        await conn.push({"type": "policy.changed", "payload": {"revision": 2}})
        await asyncio.sleep(0.05)
        assert len(conn.policy_gets) == 1
    finally:
        await link.stop()


async def test_a_write_the_server_does_not_number_is_re_read_rather_than_guessed():
    def unnumbered(conn: FakeConnection, message: dict) -> dict | None:
        if message.get("type") == "policy.set":
            conn.policy_sets.append(message.get("payload") or {})
            conn.server.policy = (message.get("payload") or {}).get("policy")
            conn.server.policy_revision += 1
            return _ok(message, {"deviceId": "d1"})
        return default_responder(conn, message)

    server = FakeServer(responder=unnumbered)
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await _until(lambda: bool(conn.policy_gets))

        assert (await link.set_policy(_allow_own_devices()))["ok"] is True

        assert len(conn.policy_gets) == 2
        assert link.policy_snapshot()["revision"] == 2
    finally:
        await link.stop()


async def test_a_disconnected_link_refuses_the_write_instead_of_dropping_it():
    """The policy lives on the server, so an offline editor must be told the
    rule was not saved rather than shown it in a list that will vanish."""
    server = FakeServer()
    link = await _connected(server)
    try:
        await server.opened[0].close()
        await _until(lambda: link._ws is None)

        reply = await link.set_policy(_allow_own_devices())

        assert reply["ok"] is False
        assert reply["error"]["code"] == server_link.LINK_OFFLINE
    finally:
        await link.stop()


async def test_the_editor_reads_the_cached_policy_while_the_link_is_down(monkeypatch):
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    link = await _connected(server)
    monkeypatch.setattr(server_link, "_link", link)
    try:
        await _until(lambda: link._policy_revision == 1)
        assert (await server_link.policy_state())["editable"] is True

        await server.opened[0].close()
        await _until(lambda: link._ws is None)

        state = await server_link.policy_state()
        # Readable, and honest about not being writable.
        assert state["policy"] == ALLOW_ALL_POLICY
        assert state["revision"] == 1
        assert state["editable"] is False
        assert state["memberId"] == "m1"
    finally:
        await link.stop()


async def test_with_no_server_there_is_no_policy_to_read_or_write(monkeypatch):
    monkeypatch.setattr(server_link, "_link", None)
    state = await server_link.policy_state()
    assert state == {
        "state": server_link.STATE_UNCONFIGURED,
        "editable": False,
        "policy": None,
        "revision": None,
        "deviceId": "",
        "memberId": "",
    }
    assert await server_link.set_policy(_allow_own_devices()) is None


async def test_a_stale_pane_id_hint_is_re_resolved_and_the_new_id_acked(broadcasts):
    """A detach or reattach mints a new pane id, so the sender's cached hint
    goes stale; (workspace, paneName) is the stable identity."""
    agent_messaging.register("p9", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push({"type": "messages.pending", "payload": _pending(pane_id="p1")})
        await _until(lambda: bool(broadcasts))
        assert broadcasts[0]["payload"]["target_pane_id"] == "p9"

        link.note_delivery_result("pa:mcp:deadbeef", True, "")
        await _until(lambda: bool(conn.acks))
        assert conn.acks[0]["paneId"] == "p9"
    finally:
        await link.stop()


# ---- remote roster ----------------------------------------------------------
# The other direction of the roster: what the *server* says about other
# machines' panes. server_link is the only writer of remote_roster, so these
# cover the wiring — one full read per connection, then the push — while
# test_remote_roster.py covers the cache's own rules.


def _row(session_id: str, device_id: str, **overrides) -> dict:
    row = {
        "sessionId": session_id,
        "deviceId": device_id,
        "workspace": "proj-b",
        "workspacePath": "/home/other/proj-b",
        "title": "builder",
        "paneId": f"pane-{session_id}",
        "agentKey": "codex",
        "status": "waiting",
        "hostOnline": True,
    }
    row.update(overrides)
    return row


async def test_the_directory_is_read_once_per_connection_without_our_own_rows():
    from agent_team_backend import remote_roster

    from agent_team_backend import device_identity

    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer()
    # The directory the server sends back always includes this device's own
    # rows; keeping them would give one pane two answers, the server's copy
    # being the stale one.
    server.directory = [
        _row("s-far", "dev-far"),
        _row("s-mine", device_identity.device_id(), workspace="proj-a", title="reviewer"),
    ]
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await _until(lambda: bool(conn.directories))
        assert len(conn.directories) == 1
        assert [p.device_id for p in remote_roster.list_panes()] == ["dev-far"]
        assert remote_roster.list_panes()[0].address == "dev-far/proj-b/builder"
    finally:
        await link.stop()
        remote_roster._reset_for_test()


async def test_a_sessions_changed_push_replaces_the_roster():
    from agent_team_backend import remote_roster

    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push(
            {"type": "sessions.changed", "payload": {"sessions": [_row("s1", "dev-far")]}}
        )
        await _until(lambda: len(remote_roster.list_panes()) == 1)

        await conn.push(
            {
                "type": "sessions.changed",
                "payload": {"sessions": [_row("s2", "dev-far", title="other")]},
            }
        )
        await _until(lambda: remote_roster.list_panes()[0].pane_name == "other")
        assert len(remote_roster.list_panes()) == 1
    finally:
        await link.stop()
        remote_roster._reset_for_test()


async def test_presence_changed_marks_a_departed_device_offline():
    """A device leaving changes no session row, so sessions.changed never fires
    for it; without presence.changed the roster would keep calling it online."""
    from agent_team_backend import remote_roster

    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push(
            {"type": "sessions.changed", "payload": {"sessions": [_row("s1", "dev-far")]}}
        )
        await _until(lambda: len(remote_roster.list_panes()) == 1)
        assert remote_roster.list_panes()[0].offline is False

        await conn.push({"type": "presence.changed", "payload": {"devices": []}})
        await _until(lambda: remote_roster.list_panes()[0].offline is True)
        assert remote_roster.list_panes()[0].host_online is False

        await conn.push(
            {"type": "presence.changed", "payload": {"devices": [{"deviceId": "dev-far"}]}}
        )
        await _until(lambda: remote_roster.list_panes()[0].host_online is True)
    finally:
        await link.stop()
        remote_roster._reset_for_test()


async def test_the_remote_roster_outlives_the_connection_that_fetched_it():
    """Same call as the policy cache: a link that dropped a second ago does not
    make the panes it knew about stop existing."""
    from agent_team_backend import remote_roster

    server = FakeServer()
    server.directory = [_row("s1", "dev-far")]
    link = await _connected(server)
    try:
        await _until(lambda: len(remote_roster.list_panes()) == 1)
        await server.opened[0].close()
        await _until(lambda: link._ws is None)
        assert len(remote_roster.list_panes()) == 1

        # And the reconnect re-reads it, because pushes sent while this device
        # was away were missed.
        await _until(lambda: len(server.opened) >= 2 and bool(server.opened[1].directories), timeout=CONNECT_TIMEOUT_S)
    finally:
        await link.stop()
        remote_roster._reset_for_test()


async def test_a_rejected_directory_read_leaves_the_previous_cache_in_force():
    from agent_team_backend import remote_roster

    def no_directory(conn: FakeConnection, message: dict):
        if message.get("type") == "sessions.directory":
            conn.directories.append(message.get("payload") or {})
            return _bad_request(message, "nope")
        return default_responder(conn, message)

    remote_roster.replace([_row("s1", "dev-far")], local_device_id="whoever")
    server = FakeServer(responder=no_directory)
    link = await _connected(server)
    try:
        await _until(lambda: bool(server.opened[0].directories))
        await asyncio.sleep(0.05)
        assert len(remote_roster.list_panes()) == 1
    finally:
        await link.stop()
        remote_roster._reset_for_test()


async def test_an_unconfigured_link_never_touches_the_remote_roster():
    """The no-server guarantee, at this module's edge: nothing is dialled, so
    nothing can ever land in the cache."""
    from agent_team_backend import remote_roster

    server = FakeServer()
    link = make_link(server, config=ServerLinkConfig())
    assert await link.start() is False
    await asyncio.sleep(0.05)
    assert remote_roster.list_panes() == []
    await link.stop()


# ---- configuration ----------------------------------------------------------


def test_config_round_trips_through_settings_and_the_vault(tmp_path, monkeypatch):
    vault = CredentialVault(
        root=tmp_path / "vault", real_home=tmp_path / "home", platform="linux"
    )
    monkeypatch.setattr(app, "credential_vault", vault)
    try:
        monkeypatch.setenv(server_link.SERVER_URL_ENV, "  ws://localhost:8787/ws  ")
        server_link.set_access_token("  tok-abc  ")
        assert server_link.load_config() == CONFIG
        assert server_link.load_config().configured

        # Only the token half can be missing now: the address always resolves.
        server_link.set_access_token(None)
        assert server_link.load_config() == ServerLinkConfig(url=CONFIG.url)
        assert not server_link.load_config().configured
    finally:
        pass


@pytest.mark.skipif(not osplat.paths.enforces_posix_modes(), reason="POSIX mode bits")
def test_app_secret_file_backend_is_private(tmp_path):
    vault = CredentialVault(
        root=tmp_path / "vault", real_home=tmp_path / "home", platform="linux"
    )
    assert vault.read_app_secret(server_link.ACCESS_TOKEN_SECRET) is None
    vault.write_app_secret(server_link.ACCESS_TOKEN_SECRET, "tok-abc")
    path = vault.app_secret_path(server_link.ACCESS_TOKEN_SECRET)
    assert vault.read_app_secret(server_link.ACCESS_TOKEN_SECRET) == "tok-abc"
    assert path.stat().st_mode & 0o777 == 0o600
    vault.write_app_secret(server_link.ACCESS_TOKEN_SECRET, None)
    assert vault.read_app_secret(server_link.ACCESS_TOKEN_SECRET) is None


def test_app_secret_keychain_refuses_a_multiline_payload(tmp_path):
    """`security -i` parses one command per line, so a newline truncates the
    item. The guard has to fire before the Keychain is touched."""
    calls: list[list[str]] = []

    def runner(args: list[str], input_text: str | None = None) -> tuple[int, str]:
        calls.append(list(args))
        return 44, ""

    vault = CredentialVault(
        root=tmp_path / "vault",
        real_home=tmp_path / "home",
        security_runner=runner,
        platform="darwin",
    )
    with pytest.raises(CredentialVaultError):
        vault.write_app_secret(server_link.ACCESS_TOKEN_SECRET, '{\n"token": "x"\n}')
    assert calls == []


# ---- module-level link ------------------------------------------------------


async def test_module_helpers_do_nothing_without_a_link():
    """The regression line that matters most: a machine with no server
    configured must behave exactly as it did before any of this existed."""
    assert server_link._link is None
    server_link.roster_changed()  # must not raise
    assert (
        await server_link.send_message(to={}, sender=None, text="hi", msg_key="k") is None
    )
    assert server_link.note_delivery_result("k", True, "") is False
    await server_link.stop()


async def test_link_state_is_unconfigured_without_a_link():
    """Same regression line as the helpers above, for the cheap state read: a
    machine with no server configured answers the word that means "no link",
    not an empty string a caller would have to guess at."""
    assert server_link._link is None
    assert server_link.link_state() == server_link.STATE_UNCONFIGURED


def test_link_state_reports_the_installed_links_own_state(monkeypatch):
    """It delegates rather than deciding: whatever the link says right now is
    the answer, including the states that are not "connected"."""

    class StubLink:
        def state(self) -> str:
            return server_link.STATE_UNREACHABLE

    monkeypatch.setattr(server_link, "_link", StubLink())
    assert server_link.link_state() == server_link.STATE_UNREACHABLE


def test_link_state_answers_without_the_keychain_reads_status_pays_for(monkeypatch):
    """Why it exists at all: status() reaches the Keychain for the account
    email and the fingerprint, and an MCP tool that answers on every invocation
    cannot pay that. Both are booby-trapped here, so a link_state() that grew a
    status() call would fail rather than merely get slower."""

    def explode() -> str:  # pragma: no cover - must not be reached
        raise AssertionError("link_state must not read the Keychain")

    monkeypatch.setattr(server_link, "account_email", explode)
    monkeypatch.setattr(server_link, "self_fingerprint", explode)
    monkeypatch.setattr(server_link, "load_config", explode)

    assert server_link.link_state() == server_link.STATE_UNCONFIGURED

    class StubLink:
        def state(self) -> str:
            return server_link.STATE_CONNECTED

    monkeypatch.setattr(server_link, "_link", StubLink())
    assert server_link.link_state() == server_link.STATE_CONNECTED


# ---- reconfiguring without a backend restart --------------------------------


@pytest.fixture
def module_link(monkeypatch):
    """Drive the process-wide link (start/stop/reconfigure/status) against the
    fake server, with the configuration under the test's control.

    Both ``ServerLink`` and ``load_config`` are swapped: ``start()`` constructs
    the class by name and ``status()`` reads the module function, so patching
    one without the other would leave half the path talking to the real
    Keychain. The factory deliberately passes no ``config_loader`` so the
    instance picks up whatever ``load_config`` is patched to at the moment it
    is built — which is how a test can hand the link the real config path.
    """
    state = {"config": ServerLinkConfig()}
    server = FakeServer(count=16)

    def factory() -> ServerLink:
        return ServerLink(
            connect=server.connect,
            token_clearer=lambda: None,
            device_name="test-box",
        )

    monkeypatch.setattr(server_link, "ServerLink", factory)
    monkeypatch.setattr(server_link, "load_config", lambda: state["config"])
    yield state, server


async def test_reconfigure_dials_once_the_settings_are_filled_in(module_link, monkeypatch):
    """The gap signing in walks straight into: start() runs at boot, so a
    credential stored afterwards has to be picked up without a restart."""
    state, server = module_link
    await server_link.start()
    try:
        assert server_link._link is None
        assert server.opened == []
        assert (await server_link.status())["state"] == server_link.STATE_UNCONFIGURED

        # The URL a connected link reports comes from the build (or the dev
        # override), never from a user-entered setting.
        monkeypatch.setenv(server_link.SERVER_URL_ENV, CONFIG.url)
        state["config"] = CONFIG
        await server_link.reconfigure()
        await _until(lambda: bool(server.opened and server.opened[0].syncs), timeout=CONNECT_TIMEOUT_S)
        assert server.urls == [CONFIG.url]
        status = await server_link.status()
        assert status["state"] == server_link.STATE_CONNECTED
        assert status["serverUrl"] == CONFIG.url
        assert status["hasToken"] is True
    finally:
        await server_link.stop()


async def test_reconfigure_replaces_the_link_rather_than_adding_one(module_link):
    """Two links for one device would both publish the roster and both take
    delivery of the same relayed message."""
    state, server = module_link
    state["config"] = CONFIG
    await server_link.start()
    try:
        first = server_link._link
        await _until(lambda: bool(server.opened and server.opened[0].syncs), timeout=CONNECT_TIMEOUT_S)

        state["config"] = ServerLinkConfig(url="ws://elsewhere/ws", token="tok-2")
        await server_link.reconfigure()
        await _until(lambda: len(server.opened) == 2 and bool(server.opened[1].syncs), timeout=CONNECT_TIMEOUT_S)

        assert server_link._link is not first
        assert first is not None and first._task is None
        assert server.urls == [CONFIG.url, "ws://elsewhere/ws"]
    finally:
        await server_link.stop()


async def test_clearing_the_settings_takes_the_link_back_to_inert(module_link):
    """The regression line: erasing the configuration must restore exactly the
    behaviour of a machine that never had a server."""
    state, server = module_link
    state["config"] = CONFIG
    await server_link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs), timeout=CONNECT_TIMEOUT_S)

        state["config"] = ServerLinkConfig()
        await server_link.reconfigure()

        assert server_link._link is None
        assert len(server.opened) == 1
        assert (await server_link.status())["state"] == server_link.STATE_UNCONFIGURED
        assert (
            await server_link.send_message(to={}, sender=None, text="hi", msg_key="k")
            is None
        )
        server_link.roster_changed()  # must not raise
    finally:
        await server_link.stop()


async def test_status_reports_a_rejected_token_as_unauthorized(module_link):
    state, server = module_link
    state["config"] = CONFIG
    server.connections = [
        FakeConnection(rejecting_responder("AUTH_REJECTED"), server) for _ in range(4)
    ]
    await server_link.start()
    try:
        await _until(
            lambda: server_link._link is not None
            and server_link._link.state() == server_link.STATE_UNAUTHORIZED,
            timeout=CONNECT_TIMEOUT_S,
        )
        status = await server_link.status()
        assert status["state"] == server_link.STATE_UNAUTHORIZED
        assert "AUTH_REJECTED" in status["detail"]
        assert status["hasToken"] is True
    finally:
        await server_link.stop()


async def test_status_never_carries_the_access_token(module_link):
    state, server = module_link
    state["config"] = CONFIG
    await server_link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs), timeout=CONNECT_TIMEOUT_S)
        status = await server_link.status()
        assert CONFIG.token not in json.dumps(status)
        assert "token" not in status
    finally:
        await server_link.stop()


async def test_link_state_agrees_with_status_on_a_live_link(module_link):
    """The stub above pins that the link's word is passed through; this pins
    that it is the same word status() reports, against a real connected link."""
    state, server = module_link
    state["config"] = CONFIG
    await server_link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs), timeout=CONNECT_TIMEOUT_S)
        assert server_link.link_state() == server_link.STATE_CONNECTED
        assert (await server_link.status())["state"] == server_link.STATE_CONNECTED
    finally:
        await server_link.stop()
    assert server_link.link_state() == server_link.STATE_UNCONFIGURED


async def test_state_is_unreachable_after_a_failed_dial():
    """A server that is merely down must not read the same as a rejected
    credential: one of the two is worth retyping the token for."""

    def refuse(url: str):
        raise ConnectionError("connection refused")

    link = ServerLink(
        connect=refuse, config_loader=lambda: CONFIG, device_name="test-box"
    )
    assert await link.start() is True
    try:
        assert link.state() == server_link.STATE_CONNECTING
        await _until(lambda: link.state() == server_link.STATE_UNREACHABLE)
        assert "connection refused" in link.last_error
    finally:
        await link.stop()


async def test_a_reconnect_clears_the_stale_error():
    """last_error is what tells "cannot reach" from "not tried yet", so a link
    that comes back must stop reporting the failure that preceded it."""
    server = FakeServer()
    dials = {"n": 0}

    def flaky(url: str):
        dials["n"] += 1
        if dials["n"] == 1:
            raise ConnectionError("connection refused")
        return server.connect(url)

    link = ServerLink(
        connect=flaky, config_loader=lambda: CONFIG, device_name="test-box"
    )
    await link.start()
    try:
        await _until(lambda: link.state() == server_link.STATE_UNREACHABLE)
        await _until(lambda: link.state() == server_link.STATE_CONNECTED, timeout=CONNECT_TIMEOUT_S)
        assert link.last_error == ""
    finally:
        await link.stop()


# ---- ws handlers ------------------------------------------------------------


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


def _ws_session() -> "app.Session":
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


async def test_configure_handler_stores_the_token_and_reconnects(
    module_link, tmp_path, monkeypatch
):
    """One call lands the token in the vault and leaves a dialling link. The URL
    half is gone: it is built in, so there is nothing for the caller to set."""
    state, server = module_link
    vault = CredentialVault(
        root=tmp_path / "vault", real_home=tmp_path / "home", platform="linux"
    )
    monkeypatch.setattr(app, "credential_vault", vault)
    # The handler writes through the real config path; the link reads the
    # fixture's, so `state` is followed along by hand.
    monkeypatch.setenv(server_link.SERVER_URL_ENV, CONFIG.url)
    monkeypatch.setattr(
        server_link,
        "load_config",
        lambda: ServerLinkConfig(url=server_link.server_url(), token=server_link.access_token()),
    )
    session = _ws_session()
    try:
        await app.handle_message(
            session,
            {
                "id": "c1",
                "type": "p2p.link.configure",
                # serverUrl from an older renderer is accepted and ignored.
                "payload": {"serverUrl": "  ws://typo/ws  ", "token": "tok-abc"},
            },
        )
        reply = session.websocket.sent[0]
        assert reply["type"] == "p2p.link.configure.result"
        assert reply["ok"] is True
        assert vault.read_app_secret(server_link.ACCESS_TOKEN_SECRET) == "tok-abc"
        # The typo'd address was ignored; the build's own value is in effect.
        assert server_link.server_url() == CONFIG.url
        await _until(lambda: bool(server.opened and server.opened[0].syncs), timeout=CONNECT_TIMEOUT_S)

        session2 = _ws_session()
        await app.handle_message(session2, {"id": "s1", "type": "p2p.link.status", "payload": {}})
        status = session2.websocket.sent[0]["payload"]["status"]
        assert status["state"] == server_link.STATE_CONNECTED
        assert status["hasToken"] is True
        assert "token" not in status
    finally:
        await server_link.stop()
        app.ui_settings_store.set({server_link.SERVER_URL_SETTING: None})


async def test_configure_handler_leaves_the_token_alone_when_absent(
    module_link, tmp_path, monkeypatch
):
    """The UI never shows the stored token, so saving a new URL must not wipe
    the credential the user could not have retyped."""
    module_link  # the link is patched so nothing dials the real network
    vault = CredentialVault(
        root=tmp_path / "vault", real_home=tmp_path / "home", platform="linux"
    )
    monkeypatch.setattr(app, "credential_vault", vault)
    vault.write_app_secret(server_link.ACCESS_TOKEN_SECRET, "tok-abc")
    session = _ws_session()
    try:
        await app.handle_message(
            session,
            {"id": "c1", "type": "p2p.link.configure", "payload": {}},
        )
        assert session.websocket.sent[0]["ok"] is True
        assert vault.read_app_secret(server_link.ACCESS_TOKEN_SECRET) == "tok-abc"

        # An explicit empty string is how the user erases it.
        await app.handle_message(
            session,
            {"id": "c2", "type": "p2p.link.configure", "payload": {"token": ""}},
        )
        assert session.websocket.sent[1]["ok"] is True
        assert vault.read_app_secret(server_link.ACCESS_TOKEN_SECRET) is None
    finally:
        await server_link.stop()
        app.ui_settings_store.set({server_link.SERVER_URL_SETTING: None})


async def test_configure_handler_ignores_a_serverurl_from_an_older_renderer():
    """A stale window still sends the field. Rejecting would make every save
    from that window fail over a value that no longer has any effect."""
    session = _ws_session()
    await app.handle_message(
        session,
        {"id": "c1", "type": "p2p.link.configure", "payload": {"serverUrl": 42}},
    )
    assert session.websocket.sent[0]["ok"] is True


async def test_configure_handler_rejects_a_non_string_token():
    session = _ws_session()
    await app.handle_message(
        session,
        {"id": "c1", "type": "p2p.link.configure", "payload": {"token": 42}},
    )
    reply = session.websocket.sent[0]
    assert reply["ok"] is False
    assert reply["error"]["code"] == "BAD_REQUEST"


# ---- the address is the build's ---------------------------------------------


def test_server_url_is_built_in(monkeypatch):
    monkeypatch.delenv(server_link.SERVER_URL_ENV, raising=False)
    assert server_link.server_url() == server_link.DEFAULT_SERVER_URL
    assert server_link.DEFAULT_SERVER_URL.startswith("wss://")


def test_env_overrides_the_built_in_address(monkeypatch):
    """The escape hatch development and the verify scripts run through."""
    monkeypatch.setenv(server_link.SERVER_URL_ENV, "  ws://localhost:8787/ws  ")
    assert server_link.server_url() == "ws://localhost:8787/ws"


def test_a_stored_user_entered_address_is_ignored(monkeypatch):
    """An install upgrading from the configurable era carries whatever its user
    typed. It must move to the real service, not keep dialling that value."""
    monkeypatch.delenv(server_link.SERVER_URL_ENV, raising=False)
    app.ui_settings_store.set({server_link.SERVER_URL_SETTING: "ws://stale-typo/ws"})
    try:
        assert server_link.server_url() == server_link.DEFAULT_SERVER_URL
    finally:
        app.ui_settings_store.set({server_link.SERVER_URL_SETTING: None})


# ---- the policy editor's handlers -------------------------------------------


async def test_policy_get_answers_with_no_server_configured():
    """The whole section is hidden for a machine with no server, so this answer
    is what tells the UI to hide it — it must never fail or block."""
    session = _ws_session()
    await app.handle_message(session, {"id": "g1", "type": "p2p.policy.get", "payload": {}})
    payload = session.websocket.sent[0]["payload"]
    assert payload["state"] == server_link.STATE_UNCONFIGURED
    assert payload["editable"] is False
    assert payload["policy"] is None
    assert payload["devices"] == []


async def test_policy_get_and_set_round_trip_through_the_handlers(module_link):
    state, server = module_link
    state["config"] = CONFIG
    await server_link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs), timeout=CONNECT_TIMEOUT_S)
        remote_roster.replace(
            [
                {
                    "sessionId": "s1",
                    "deviceId": "far-1",
                    "deviceName": "Laptop",
                    "workspace": "proj",
                    "title": "reviewer",
                    "status": "waiting",
                    "hostOnline": True,
                }
            ],
            local_device_id="local",
        )

        session = _ws_session()
        await app.handle_message(session, {"id": "g1", "type": "p2p.policy.get", "payload": {}})
        before = session.websocket.sent[0]["payload"]
        assert before["editable"] is True
        assert before["memberId"] == "m1"
        # The picker's device list rides along with the policy.
        assert before["devices"] == [
            {"deviceId": "far-1", "deviceName": "Laptop", "paneCount": 1}
        ]

        document = _allow_own_devices()
        await app.handle_message(
            session,
            {"id": "s1", "type": "p2p.policy.set",
             "payload": {"policy": document,
                         "confirm": _confirmation("p2p.policy.set", subject=confirm_token.canonical_json(document))}},
        )
        reply = session.websocket.sent[1]
        assert reply["ok"] is True
        # The write answers with the state the editor should now show, so no
        # second round trip can show it the policy it just replaced.
        assert reply["payload"]["policy"] == document
        assert reply["payload"]["revision"] == 2
        written = dict(server.opened[0].policy_sets[0]["policy"])
        written.pop(server_link.POLICY_SIGNATURE_FIELD)
        assert written == document
    finally:
        await server_link.stop()
        remote_roster._reset_for_test()


async def test_a_policy_this_build_would_not_honour_never_reaches_the_server(module_link):
    state, server = module_link
    state["config"] = CONFIG
    await server_link.start()
    try:
        await _until(lambda: bool(server.opened and server.opened[0].syncs), timeout=CONNECT_TIMEOUT_S)
        session = _ws_session()

        rejected = {
            "version": 1,
            "default": "deny",
            "rules": [
                {
                    "from": {"memberId": "m1", "deviceId": ""},
                    "to": {"workspace": "*", "paneName": "*"},
                    "action": "allow",
                }
            ],
        }
        await app.handle_message(
            session,
            {
                "id": "s1",
                "type": "p2p.policy.set",
                # An empty deviceId is exactly what a rule the delivery path
                # would silently skip looks like.
                "payload": {
                    "policy": rejected,
                    # Present and valid, so what this test refuses is the rule
                    # rather than the missing confirmation.
                    "confirm": _confirmation("p2p.policy.set", subject=confirm_token.canonical_json(rejected)),
                },
            },
        )
        reply = session.websocket.sent[0]
        assert reply["ok"] is False
        assert reply["error"]["code"] == "BAD_REQUEST"
        assert server.opened[0].policy_sets == []
    finally:
        await server_link.stop()


async def test_writing_a_policy_with_no_server_says_so_instead_of_failing_silently():
    session = _ws_session()
    await app.handle_message(
        session,
        {"id": "s1", "type": "p2p.policy.set",
         "payload": {"policy": (doc := _allow_own_devices()),
                     "confirm": _confirmation("p2p.policy.set", subject=confirm_token.canonical_json(doc))}},
    )
    reply = session.websocket.sent[0]
    assert reply["ok"] is False
    assert reply["error"]["code"] == "P2P_NOT_CONFIGURED"


# ---- delivery that is always answered ---------------------------------------
#
# A relayed message used to be able to end in silence: the receiver swallowed an
# exception or a lost ack, the sender had no way to ask afterwards, and a
# message relayed from a printed MSG block never settled in the sending window
# even when it was delivered. Each test below reproduces one of those.


def _events(monkeypatch) -> list[dict]:
    """Every broadcast, unfiltered — these tests are about the ones that settle rows."""
    events: list[dict] = []

    async def fake_broadcast(event: dict, **_kwargs) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    return events


def _with_messages_get(states: dict[str, str], gets: list[str]):
    """default_responder plus `messages.get`, answering from *states*."""

    def responder(conn: "FakeConnection", message: dict) -> dict | None:
        if message.get("type") == "messages.get":
            key = (message.get("payload") or {}).get("msgKey")
            gets.append(key)
            if key not in states:
                return {
                    "id": message["id"],
                    "type": "messages.get.result",
                    "ok": False,
                    "error": {"code": "NOT_FOUND", "message": "no such message"},
                }
            return _ok(
                message,
                {"message": {"msgKey": key, "state": states[key], "reason": None}},
            )
        return default_responder(conn, message)

    return responder


async def test_a_message_whose_handling_raises_is_acked_as_failed(monkeypatch, broadcasts):
    """Before: the spawned handler died, nothing was logged, nothing was acked."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")

    def keychain_trouble(*_args, **_kwargs):
        raise RuntimeError("keychain write failed")

    monkeypatch.setattr(trust_store, "note_remote_command", keychain_trouble)
    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push({"type": "messages.pending", "payload": _pending()})
        await _until(lambda: bool(conn.acks))
        assert conn.acks == [
            {
                "msgKey": "pa:mcp:deadbeef",
                "state": "failed",
                "reason": server_link.REASON_RECEIVER_ERROR,
            }
        ]
        assert broadcasts == []
    finally:
        await link.stop()


async def test_a_trust_record_that_will_not_save_does_not_fail_the_message(monkeypatch, broadcasts):
    """2026-10-10: the record outgrew the Keychain, every save raised, and every
    relayed message was acked failed/receiver-error instead of delivered."""
    from agent_team_backend.credential_vault import CredentialVaultError

    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer()
    link = await _connected(server)

    def refuse(_state):
        raise CredentialVaultError("keychain write failed for 'Navide secret navide-device-trust'")

    monkeypatch.setattr(trust_store, "_write", refuse)
    try:
        conn = server.opened[0]
        await conn.push({"type": "messages.pending", "payload": _pending()})
        await _until(lambda: any(e["type"] == "agent_msg.deliver" for e in broadcasts))
        assert not any(a.get("state") == "failed" for a in conn.acks)
    finally:
        await link.stop()


async def test_a_resent_message_that_was_already_answered_is_answered_again(broadcasts):
    """The server re-pushes a key only when its sender sent it again, which a
    sender does when it never heard back: the first answer was lost."""
    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push({"type": "messages.pending", "payload": _pending()})
        await _until(lambda: len(conn.acks) == 1)
        await conn.push({"type": "messages.pending", "payload": _pending()})
        await _until(lambda: len(conn.acks) == 2)
        assert conn.acks[0] == conn.acks[1]
        assert conn.acks[0]["state"] == "failed"
        assert broadcasts == []
    finally:
        await link.stop()


async def test_a_refused_unsigned_push_takes_no_room_in_the_replay_ledger(broadcasts):
    """D2. The persisted ledger is bounded, oldest out first, so every key that
    lands in it pushes a real one closer to the edge. A push that does not
    verify was never delivered and has nothing to protect from a replay."""
    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push({"type": "messages.pending", "payload": _pending("k-forged", sign=False)})
        await _until(lambda: len(conn.acks) == 1)
        assert conn.acks[0]["state"] == "rejected"
        assert not await asyncio.to_thread(trust_store.has_seen_message, "k-forged")
    finally:
        await link.stop()


async def test_a_flood_of_unsigned_pushes_cannot_flush_a_delivered_message(broadcasts):
    """D2, end to end: a relay delivers a real message, pushes a ledger's worth
    of messages that fail their signature, then replays the real one. The
    replay must not reach the pane a second time."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push({"type": "messages.pending", "payload": _pending("k-real")})
        await _until(lambda: len(broadcasts) == 1)
        # A full ledger plus one batch, so the batch that overflows it is written.
        flood = trust_store.MAX_SEEN_MESSAGES + trust_store.SEEN_FLUSH_AFTER
        for index in range(flood):
            await conn.push(
                {"type": "messages.pending", "payload": _pending(f"k-junk-{index}", sign=False)}
            )
        await _until(lambda: len(conn.acks) == flood, timeout=30.0)
        await conn.push({"type": "messages.pending", "payload": _pending("k-real")})
        await asyncio.sleep(0.2)
        assert len(broadcasts) == 1
    finally:
        await link.stop()


async def test_a_resent_message_still_waiting_for_its_pane_is_not_answered_twice(broadcasts):
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push({"type": "messages.pending", "payload": _pending()})
        await _until(lambda: bool(broadcasts))
        await conn.push({"type": "messages.pending", "payload": _pending()})
        await asyncio.sleep(0.1)
        # Still in the window's queue: no answer yet, and no second delivery.
        assert conn.acks == []
        assert len(broadcasts) == 1
    finally:
        await link.stop()


async def test_an_ack_lost_to_a_dropped_connection_is_sent_on_the_next_one(broadcasts):
    """Before: logged as a warning and dropped; the sender waited for ever."""

    def responder(conn: "FakeConnection", message: dict) -> dict | None:
        if message.get("type") == "messages.ack" and conn is conn.server.connections[0]:
            asyncio.get_running_loop().create_task(conn.close())
            return None
        return default_responder(conn, message)

    server = FakeServer(responder=responder)
    link = await _connected(server)
    try:
        await server.opened[0].push({"type": "messages.pending", "payload": _pending()})
        await _until(lambda: len(server.opened) == 2 and bool(server.opened[1].acks), timeout=8.0)
        assert server.opened[1].acks[0]["msgKey"] == "pa:mcp:deadbeef"
        assert server.opened[1].acks[0]["state"] == "failed"
    finally:
        await link.stop()


async def test_a_remote_ack_settles_the_sending_windows_row(monkeypatch):
    """Before: only cli_check_message's table heard about it, so a message sent
    from a printed MSG block failed with "never reported back" after 30 minutes
    even when it had been delivered."""
    events = _events(monkeypatch)
    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push(
            {"type": "messages.acked", "payload": {"msgKey": "pb:7", "state": "delivered"}}
        )
        await conn.push(
            {
                "type": "messages.acked",
                "payload": {"msgKey": "pb:8", "state": "rejected", "reason": "not-paired"},
            }
        )
        await _until(
            lambda: len([e for e in events if e["type"] == "agent_msg.delivery_result"]) == 2
        )
        results = [e["payload"] for e in events if e["type"] == "agent_msg.delivery_result"]
        assert results == [
            {"msg_key": "pb:7", "ok": True, "reason": ""},
            {"msg_key": "pb:8", "ok": False, "reason": "rejected: not-paired"},
        ]
    finally:
        await link.stop()


async def test_an_ack_pushed_while_away_is_recovered_on_reconnect(monkeypatch):
    """The server pushes messages.acked once; its contract says a sender that was
    away asks with messages.get. Nothing asked."""
    from agent_team_backend.mcp_server import server as plan_mcp

    events = _events(monkeypatch)
    gets: list[str] = []
    states = {"pa:mcp:away": "delivered"}
    server = FakeServer(responder=_with_messages_get(states, gets))
    plan_mcp._record_message_sent("pa:mcp:away", "dev-b/beta/builder", "pa", "ship it")
    link = await _connected(server)
    try:
        reply = await link.send_message(
            to={"deviceId": "dev-b", "workspace": "beta", "paneName": "builder"},
            sender=None,
            text="ship it",
            msg_key="pa:mcp:away",
        )
        assert reply["ok"] is True
        # The connection drops before the far side answers; the answer is
        # pushed to nobody.
        await server.opened[0].close()
        await _until(lambda: "pa:mcp:away" in gets, timeout=8.0)
        await _until(lambda: plan_mcp._mcp_message_status["pa:mcp:away"]["status"] == "delivered")
        # The window's delivery_result is broadcast from a spawned task, so it
        # can land after the status row: wait for it rather than race it.
        await _until(lambda: any(
            e["type"] == "agent_msg.delivery_result" and e["payload"]["msg_key"] == "pa:mcp:away"
            for e in events
        ))
        assert "pa:mcp:away" not in link._outbound
    finally:
        plan_mcp._mcp_message_status.pop("pa:mcp:away", None)
        await link.stop()


@pytest.mark.parametrize(
    ("roster_status", "expected_hold"),
    [
        ("running", server_link.HOLD_REMOTE_BUSY),
        ("waiting", server_link.HOLD_REMOTE_UNREPORTED),
    ],
)
async def test_an_unanswered_message_says_which_silence_it_is(roster_status, expected_hold):
    """"queued" meant both "its pane is mid-turn" and "nothing over there is
    answering" — the two cases that call for opposite responses."""
    from agent_team_backend.mcp_server import server as plan_mcp

    gets: list[str] = []
    server = FakeServer(responder=_with_messages_get({"pa:mcp:quiet": "pending"}, gets))
    plan_mcp._record_message_sent("pa:mcp:quiet", "dev-b/beta/builder", "pa", "hello")
    link = await _connected(server)
    try:
        await link.send_message(
            to={"deviceId": "dev-b", "workspace": "beta", "paneName": "builder"},
            sender=None,
            text="hello",
            msg_key="pa:mcp:quiet",
        )
        remote_roster.replace(
            [
                {
                    "sessionId": "s-b",
                    "deviceId": "dev-b",
                    "deviceName": "far box",
                    "workspace": "beta",
                    "title": "builder",
                    "paneId": "pb",
                    "agentKey": "claude",
                    "status": roster_status,
                    "hostOnline": True,
                }
            ],
            local_device_id="dev-local",
        )
        await link._reconcile(min_age_s=0.0)
        entry = plan_mcp._mcp_message_status["pa:mcp:quiet"]
        assert entry["status"] == "queued"
        assert entry["hold"] == {"key": expected_hold}
        # Still unanswered, so it is asked about again next round.
        assert "pa:mcp:quiet" in link._outbound
    finally:
        plan_mcp._mcp_message_status.pop("pa:mcp:quiet", None)
        remote_roster._reset_for_test()
        await link.stop()


async def test_reconciling_asks_only_about_messages_old_enough(monkeypatch):
    gets: list[str] = []
    server = FakeServer(responder=_with_messages_get({"pa:mcp:new": "pending"}, gets))
    link = await _connected(server)
    try:
        await link.send_message(
            to={"deviceId": "dev-b", "workspace": "beta", "paneName": "builder"},
            sender=None,
            text="hi",
            msg_key="pa:mcp:new",
        )
        await link._reconcile(min_age_s=server_link.RECONCILE_AFTER_S)
        assert gets == []
        link._outbound["pa:mcp:new"]["sent_at"] -= server_link.RECONCILE_AFTER_S
        await link._reconcile(min_age_s=server_link.RECONCILE_AFTER_S)
        assert gets == ["pa:mcp:new"]
    finally:
        await link.stop()


async def test_a_message_the_server_no_longer_has_stops_being_asked_about():
    gets: list[str] = []
    server = FakeServer(responder=_with_messages_get({}, gets))
    link = await _connected(server)
    try:
        await link.send_message(
            to={"deviceId": "dev-b", "workspace": "beta", "paneName": "builder"},
            sender=None,
            text="hi",
            msg_key="pa:mcp:gone",
        )
        await link._reconcile(min_age_s=0.0)
        assert gets == ["pa:mcp:gone"]
        assert "pa:mcp:gone" not in link._outbound
    finally:
        await link.stop()


# ---- token lifecycle (C1) ----------------------------------------------------
#
# The server issues per-device tokens; this device rotates its own on connect
# when it still holds the legacy shared token or the server says its token is
# older than ROTATE_AFTER_S. The new token goes to the .next slot, is read back,
# confirmed, and only then becomes the current token, so no failure part-way
# can leave this device without a token the server accepts.

CUR = server_link.ACCESS_TOKEN_SECRET
NXT = server_link.ACCESS_TOKEN_NEXT_SECRET


class TokenStore:
    """The two Keychain slots plus the sign-in generation, with switchable failures."""

    def __init__(self, token: str = CONFIG.token) -> None:
        self.slots = {CUR: token, NXT: ""}
        self.gen = 0
        self.writes: list[tuple[str, str | None]] = []
        self.fail_write = False
        self.truncate = False
        self.read_other = False

    # the ServerLink token_store interface
    def generation(self) -> int:
        return self.gen

    def write(self, value: str | None, slot: str, expect_generation: int) -> None:
        if expect_generation != self.gen:
            raise server_link.StaleTokenWrite("generation moved")
        if self.fail_write and value:
            raise RuntimeError("keychain write failed")
        self.writes.append((slot, value))
        self.slots[slot] = (value[:10] if (self.truncate and value) else value) or ""

    def read(self, slot: str) -> str:
        return "something-else" if (self.read_other and slot == NXT) else self.slots[slot]

    # what a user-level sign-out does
    def sign_out(self) -> None:
        self.gen += 1
        self.slots = {CUR: "", NXT: ""}


class TokenServer:
    """Server-side token state: which tokens are live, which are pending."""

    def __init__(self, live=(CONFIG.token,), *, legacy=False, age_s=10 * 86400, rotate_code=None, confirm="ok"):
        self.live = set(live)
        self.pending: dict[str, str] = {}
        self.legacy = legacy
        self.age_s = age_s
        self.rotate_code = rotate_code
        self.confirm = confirm  # ok | refuse | lost-after-apply | never
        self.on_rotate = None
        self.seq = 0

    def _apply(self, new: str) -> None:
        old = self.pending.pop(new)
        self.live.discard(old)
        self.live.add(new)
        self.legacy = False

    def responder(self, conn: "FakeConnection", message: dict) -> dict | None:
        kind = message.get("type")
        if kind == "auth.hello":
            cred = (message.get("payload") or {}).get("credential")
            if cred in self.pending:
                self._apply(cred)
            if cred not in self.live:
                conn.hellos.append(message.get("payload") or {})
                return {"id": message["id"], "type": "auth.hello.result", "ok": False,
                        "error": {"code": "AUTH_REJECTED", "message": "nope"}}
            reply = default_responder(conn, message)
            reply["payload"].update(tokenId="legacy" if self.legacy else f"id-{cred}",
                                    tokenAgeS=None if self.legacy else self.age_s, legacyToken=self.legacy)
            return reply
        if kind == "auth.token.rotate":
            if self.on_rotate:
                self.on_rotate()
            if self.rotate_code:
                return {"id": message["id"], "type": "auth.token.rotate.result", "ok": False,
                        "error": {"code": self.rotate_code, "message": "nope"}}
            self.seq += 1
            new = f"nvd_rotated-{self.seq}-0123456789"
            old = (conn.hellos[-1] or {}).get("credential") if conn.hellos else CONFIG.token
            self.pending[new] = old
            return _ok(message, {"token": new, "tokenId": new, "pendingUntil": "later"})
        if kind == "auth.token.confirm":
            new = (message.get("payload") or {}).get("tokenId")
            if self.confirm == "refuse" or new not in self.pending:
                self.pending.pop(new, None)
                return {"id": message["id"], "type": "auth.token.confirm.result", "ok": False,
                        "error": {"code": "NOT_FOUND", "message": "nope"}}
            if self.confirm == "ok":
                self._apply(new)
                return _ok(message, {"tokenId": new})
            if self.confirm == "never":
                return None  # no answer; the connection stays up until the App stops
            self._apply(new)  # lost-after-apply: applied, then the connection drops
            asyncio.get_running_loop().create_task(conn.close())
            return None
        if kind == "auth.logout":
            return _ok(message, {})
        return default_responder(conn, message)


def token_link(server: FakeServer, store: TokenStore, cleared=None) -> ServerLink:
    return ServerLink(
        connect=server.connect,
        config_loader=lambda: ServerLinkConfig(url=CONFIG.url, token=store.slots[CUR], next_token=store.slots[NXT]),
        token_clearer=(lambda: cleared.append(True)) if cleared is not None else (lambda: None),
        token_store=store,
        device_name="test-box",
    )


def _sent(conn: "FakeConnection", kind: str) -> list[dict]:
    return [m for m in conn.sent if m.get("type") == kind]


def _authed(server: FakeServer) -> bool:
    return any(c.syncs for c in server.opened)


async def _reconnect(server: FakeServer, link: ServerLink) -> None:
    n = len(server.opened)
    await server.opened[-1].close()
    await _until(lambda: len(server.opened) > n and bool(server.opened[-1].syncs), timeout=CONNECT_TIMEOUT_S)


@pytest.mark.parametrize(
    ("to", "text"),
    [
        ({"workspace": "proj", "paneName": "reviewer"},
         device_pairing.envelope(device_pairing.PAIR_REVOKED)),
        ({"workspace": server_link.PAIRING_WORKSPACE, "paneName": server_link.PAIRING_PANE},
         "hello"),
    ],
)
async def test_the_message_channel_cannot_send_a_pairing_frame(to, text):
    """M5. Signed with this machine's key, a pairing frame from the message
    channel is one the far side acts on — `pair-revoked` unpairs it — and that
    channel is open to cli_send and plugins, past the p2p.pair.* confirmation."""
    server = FakeServer()
    link = await _connected(server)
    try:
        reply = await link.send_message(
            to={"deviceId": PEER.device_id, **to}, sender=None, text=text, msg_key="k-pair"
        )
        assert reply["ok"] is False
        assert reply["error"]["code"] == server_link.LINK_PAIRING_REFUSED
        assert _sent(server.opened[0], "messages.send") == []
    finally:
        await link.stop()


async def test_rotation_writes_next_reads_back_confirms_then_promotes():
    store, ts = TokenStore(), TokenServer(legacy=True)
    server = FakeServer(responder=ts.responder)
    link = token_link(server, store)
    assert await link.start() is True
    try:
        # The promotion and the .next clear are two writes; wait for both before
        # reading the order (a slow runner showed the first without the second).
        await _until(lambda: store.slots[CUR].startswith("nvd_rotated") and store.slots[NXT] == "" and len(store.writes) >= 3, timeout=CONNECT_TIMEOUT_S)
        conn = server.opened[0]
        assert [w[0] for w in store.writes] == [NXT, CUR, NXT]  # next, promote, clear next
        assert store.slots[NXT] == ""
        assert len(_sent(conn, "auth.token.rotate")) == 1
        assert _sent(conn, "auth.token.confirm")[0]["payload"] == {"tokenId": store.slots[CUR]}
        await _reconnect(server, link)
        assert server.opened[-1].hellos[-1]["credential"] == store.slots[CUR]
    finally:
        await link.stop()


async def test_a_token_older_than_thirty_days_by_the_server_clock_is_rotated():
    store, ts = TokenStore(), TokenServer(age_s=server_link.ROTATE_AFTER_S + 1)
    server = FakeServer(responder=ts.responder)
    link = token_link(server, store)
    assert await link.start() is True
    try:
        await _until(lambda: store.slots[CUR].startswith("nvd_rotated"), timeout=CONNECT_TIMEOUT_S)
    finally:
        await link.stop()


async def test_a_young_token_and_a_server_without_an_age_are_left_alone():
    for age in (10 * 86400, None):
        store, ts = TokenStore(), TokenServer(age_s=age)
        server = FakeServer(responder=ts.responder)
        link = token_link(server, store)
        assert await link.start() is True
        try:
            await _until(lambda: _authed(server), timeout=CONNECT_TIMEOUT_S)
            await asyncio.sleep(0.05)
            assert _sent(server.opened[0], "auth.token.rotate") == []
            assert store.writes == []
        finally:
            await link.stop()


@pytest.mark.parametrize("failure", ["truncate", "read_other", "fail_write"])
async def test_a_bad_next_write_never_costs_the_current_token(failure):
    store, ts = TokenStore(), TokenServer(legacy=True)
    setattr(store, failure, True)
    server = FakeServer(responder=ts.responder)
    link = token_link(server, store)
    assert await link.start() is True
    try:
        await _until(lambda: bool(server.opened and _sent(server.opened[0], "auth.token.rotate")), timeout=CONNECT_TIMEOUT_S)
        await asyncio.sleep(0.05)
        assert _sent(server.opened[0], "auth.token.confirm") == []
        assert store.slots[CUR] == CONFIG.token  # untouched
        store.truncate = store.read_other = store.fail_write = False
        await _reconnect(server, link)  # and it still connects
    finally:
        await link.stop()


async def test_a_refused_confirm_drops_next_and_keeps_the_current_token():
    store, ts = TokenStore(), TokenServer(legacy=True, confirm="refuse")
    server = FakeServer(responder=ts.responder)
    link = token_link(server, store)
    assert await link.start() is True
    try:
        await _until(lambda: bool(server.opened and _sent(server.opened[0], "auth.token.confirm")), timeout=CONNECT_TIMEOUT_S)
        await _until(lambda: store.slots[NXT] == "" and len(store.writes) == 2, timeout=CONNECT_TIMEOUT_S)
        assert store.slots[CUR] == CONFIG.token
        ts.rotate_code = "UNKNOWN_TYPE"
        await _reconnect(server, link)
        assert server.opened[-1].hellos[-1]["credential"] == CONFIG.token
    finally:
        await link.stop()


async def test_a_confirm_applied_but_never_answered_is_settled_by_the_next_hello():
    store, ts = TokenStore(), TokenServer(legacy=True, confirm="lost-after-apply")
    server = FakeServer(responder=ts.responder)
    link = token_link(server, store)
    assert await link.start() is True
    try:
        # The server applied it, the answer was lost with the connection: the old
        # token is now refused and only .next works.
        await _until(lambda: len(server.opened) >= 2 and bool(server.opened[-1].syncs), timeout=CONNECT_TIMEOUT_S)
        assert store.slots[CUR].startswith("nvd_rotated")  # promoted
        assert store.slots[NXT] == ""
        assert [h["credential"] for h in server.opened[-1].hellos][-2:] == [CONFIG.token, store.slots[CUR]]
    finally:
        await link.stop()


async def test_an_app_stopped_between_write_and_confirm_still_connects():
    store, ts = TokenStore(), TokenServer(legacy=True, confirm="never")
    server = FakeServer(responder=ts.responder)
    link = token_link(server, store)
    assert await link.start() is True
    await _until(lambda: store.slots[NXT].startswith("nvd_rotated"), timeout=CONNECT_TIMEOUT_S)
    await link.stop()  # the App quits before any confirm answer
    ts.confirm, ts.rotate_code = "ok", "UNKNOWN_TYPE"
    link2 = token_link(server, store)
    assert await link2.start() is True
    try:
        await _until(lambda: bool(server.opened[-1].syncs), timeout=CONNECT_TIMEOUT_S)
        assert server.opened[-1].hellos[-1]["credential"] == CONFIG.token  # the current one still works
        await _until(lambda: store.slots[NXT] == "", timeout=CONNECT_TIMEOUT_S)  # the unconfirmed one is dropped
    finally:
        await link2.stop()


async def test_a_sign_out_during_rotation_writes_nothing_back():
    store, ts = TokenStore(), TokenServer(legacy=True)
    ts.on_rotate = store.sign_out  # the user signs out while the rotate reply is in flight
    server = FakeServer(responder=ts.responder)
    link = token_link(server, store)
    assert await link.start() is True
    try:
        await _until(lambda: bool(server.opened and _sent(server.opened[0], "auth.token.rotate")), timeout=CONNECT_TIMEOUT_S)
        await asyncio.sleep(0.05)
        assert store.slots == {CUR: "", NXT: ""}
        assert store.writes == []
        assert _sent(server.opened[0], "auth.token.confirm") == []
    finally:
        await link.stop()


async def test_an_old_server_without_rotate_is_not_asked_again_by_this_link():
    store, ts = TokenStore(), TokenServer(legacy=True, rotate_code="UNKNOWN_TYPE")
    server = FakeServer(responder=ts.responder)
    link = token_link(server, store)
    assert await link.start() is True
    try:
        await _until(lambda: bool(server.opened and _sent(server.opened[0], "auth.token.rotate")), timeout=CONNECT_TIMEOUT_S)
        await _reconnect(server, link)
        await asyncio.sleep(0.05)
        assert _sent(server.opened[-1], "auth.token.rotate") == []
    finally:
        await link.stop()


async def test_logout_on_server_sends_auth_logout_when_connected():
    store, ts = TokenStore(), TokenServer()
    server = FakeServer(responder=ts.responder)
    link = token_link(server, store)
    assert await link.start() is True
    try:
        await _until(lambda: _authed(server), timeout=CONNECT_TIMEOUT_S)
        assert await link.logout_on_server() is True
        assert len(_sent(server.opened[0], "auth.logout")) == 1
    finally:
        await link.stop()


async def test_logout_on_server_offline_is_a_quiet_false():
    link = token_link(FakeServer(count=0), TokenStore())
    assert await link.logout_on_server() is False


def test_sign_out_waits_at_most_five_seconds_for_the_server():
    assert server_link.LOGOUT_TIMEOUT_S == 5.0


@pytest.mark.parametrize(
    "reason, words",
    [("password-changed", "password was changed"), ("logged-out", "signed out"),
     ("token-revoked", "revoked from another device"), ("device-removed", "removed")],
)
async def test_revocation_reasons_are_explained(reason, words):
    # Ordered by events, not by a deadline. The first sessions.sync used to
    # stand in for "authenticated", but it only goes out after the policy and
    # directory reads and their thread hops, which a loaded Windows runner can
    # stretch past any fixed wait. The hello reply is the real precondition:
    # the fake queues frames in order, so a push made after it is read after it.
    store, ts = TokenStore(), TokenServer()
    loop = asyncio.get_running_loop()
    hello_answered, cleared = asyncio.Event(), asyncio.Event()

    def responder(conn, message):
        reply = ts.responder(conn, message)
        if message.get("type") == "auth.hello":
            hello_answered.set()
        return reply

    server = FakeServer(responder=responder)
    link = ServerLink(
        connect=server.connect,
        config_loader=lambda: ServerLinkConfig(url=CONFIG.url, token=store.slots[CUR], next_token=store.slots[NXT]),
        # Runs on a worker thread (asyncio.to_thread), so it hands the event back to the loop.
        token_clearer=lambda: loop.call_soon_threadsafe(cleared.set),
        token_store=store,
        device_name="test-box",
    )
    assert await link.start() is True
    try:
        await hello_answered.wait()
        await server.opened[0].push({"type": "auth.revoked", "payload": {"deviceId": "x", "reason": reason}})
        await cleared.wait()
        assert words in link.terminated_reason
    finally:
        await link.stop()


# ---- C1 desktop re-review: N1 (member pin), N2 (generation at config time), N3 (confirm errors)


def _real_token_link(server: FakeServer, monkeypatch) -> ServerLink:
    """A link on the real KeychainTokenStore and trust store (the conftest vault is a fake)."""
    monkeypatch.setattr(server_link, "server_url", lambda: CONFIG.url)
    return ServerLink(connect=server.connect, device_name="test-box")


def _member_responder(ts: TokenServer, member_for):
    def responder(conn, message):
        reply = ts.responder(conn, message)
        if message.get("type") == "auth.hello" and reply and reply.get("ok"):
            reply["payload"]["memberId"] = member_for((message.get("payload") or {}).get("credential"))
        return reply
    return responder


def _on_first_hello(ts: TokenServer, action):
    fired: list = []

    def responder(conn, message):
        if message.get("type") == "auth.hello" and not fired:
            fired.append(True)
            action()  # a sign-out / sign-in completes while the hello is in flight
        return ts.responder(conn, message)
    return responder


async def test_rotation_carries_the_member_pin_to_the_new_token(monkeypatch):
    """N1: the rotated token is pinned to the member the old one was, before the
    confirm, so a server naming another member for it is refused like any other."""
    server_link.set_access_token(CONFIG.token)
    ts = TokenServer(legacy=True)
    server = FakeServer(responder=_member_responder(ts, lambda c: "m1" if c == CONFIG.token else "m-evil"))
    link = _real_token_link(server, monkeypatch)
    assert await link.start() is True
    try:
        await _until(lambda: _stored_token().startswith("nvd_rotated"), timeout=CONNECT_TIMEOUT_S)
        new = server_link.access_token()
        assert trust_store.member_for_credential(CONFIG.url, new) == "m1"  # pinned before confirm (N1b: node hint kept)
        ts.rotate_code = "UNKNOWN_TYPE"
        await server.opened[0].close()
        await _until(lambda: len(server.opened) >= 2 and bool(server.opened[1].hellos), timeout=CONNECT_TIMEOUT_S)
        await _until(lambda: bool(link._trust_locked), timeout=CONNECT_TIMEOUT_S)
        assert link._own_member == ""  # the renamed member is not trusted
    finally:
        await link.stop()


async def test_no_rotation_without_a_pinned_member(monkeypatch):
    """N1: with no settled member pin there is nothing to carry over, so no rotation."""
    def locked(*_a, **_k):
        raise trust_store.TrustStoreLocked("store locked for the test")

    monkeypatch.setattr(trust_store, "adopt_own_member", locked)
    server_link.set_access_token(CONFIG.token)
    ts = TokenServer(legacy=True)
    server = FakeServer(responder=ts.responder)
    link = _real_token_link(server, monkeypatch)
    assert await link.start() is True
    try:
        await _until(lambda: _authed(server), timeout=CONNECT_TIMEOUT_S)
        await asyncio.sleep(0.05)
        assert _sent(server.opened[0], "auth.token.rotate") == []
        assert server_link.access_token() == CONFIG.token
    finally:
        await link.stop()


async def test_a_confirm_error_after_the_server_applied_keeps_next(monkeypatch):
    """N3: only NOT_FOUND means the server did not swap; any other error keeps
    .next, and the next hello settles it (the current token was revoked)."""
    store, ts = TokenStore(), TokenServer(legacy=True)
    base = ts.responder

    def apply_then_error(conn, message):
        if message.get("type") == "auth.token.confirm":
            new = (message.get("payload") or {}).get("tokenId")
            if new in ts.pending:
                ts._apply(new)
            return {"id": message["id"], "type": "auth.token.confirm.result", "ok": False,
                    "error": {"code": "INTERNAL", "message": "db hiccup"}}
        return base(conn, message)

    server = FakeServer(responder=apply_then_error)
    link = token_link(server, store)
    assert await link.start() is True
    await _until(lambda: bool(server.opened and _sent(server.opened[0], "auth.token.confirm")), timeout=CONNECT_TIMEOUT_S)
    await asyncio.sleep(0.1)
    await link.stop()
    assert store.slots[NXT].startswith("nvd_rotated")  # kept
    ts.rotate_code = "UNKNOWN_TYPE"
    link2 = token_link(server, store)
    assert await link2.start() is True
    try:
        await _until(lambda: any(c.syncs for c in server.opened[1:]), timeout=CONNECT_TIMEOUT_S)
        assert store.slots[CUR].startswith("nvd_rotated") and store.slots[NXT] == ""
    finally:
        await link2.stop()


@pytest.mark.parametrize("kind", ["logout", "switch"])
async def test_a_sign_change_during_hello_fences_the_rotation(kind, monkeypatch):
    """N2: the generation is taken when the config is read, before the hello, so
    a sign-out / sign-in finishing while the hello is in flight fences the rotation."""
    server_link.set_access_token(CONFIG.token)
    ts = TokenServer(legacy=True)
    act = (lambda: server_link.set_access_token(None)) if kind == "logout" else (lambda: server_link.set_access_token("tok-B"))
    server = FakeServer(responder=_on_first_hello(ts, act))
    link = _real_token_link(server, monkeypatch)
    assert await link.start() is True
    try:
        await _until(lambda: bool(server.opened and _sent(server.opened[0], "auth.token.rotate")), timeout=CONNECT_TIMEOUT_S)
        await asyncio.sleep(0.1)
        assert server_link.access_token() == ("" if kind == "logout" else "tok-B")
        assert server_link.next_access_token() == ""
    finally:
        await link.stop()


async def test_a_sign_out_during_hello_fences_the_settle(monkeypatch):
    """N2: same for promoting .next when the current token is refused."""
    server_link.set_access_token("tok-old-revoked")
    app.credential_vault.write_app_secret(server_link.ACCESS_TOKEN_NEXT_SECRET, "nvd_next-live")
    ts = TokenServer(live=("nvd_next-live",))
    server = FakeServer(responder=_on_first_hello(ts, lambda: server_link.set_access_token(None)))
    link = _real_token_link(server, monkeypatch)
    assert await link.start() is True
    try:
        await _until(lambda: len(server.opened[0].hellos) >= 2 if server.opened else False, timeout=CONNECT_TIMEOUT_S)
        await asyncio.sleep(0.1)
        assert server_link.access_token() == ""
    finally:
        await link.stop()


# ---- N1b: the member pin of a retired token is forgotten (the trust record stays bounded)


def _own_members() -> dict:
    with trust_store._lock:
        return dict(trust_store._load_locked()["ownMembers"])


async def test_rotations_do_not_grow_the_member_pins(monkeypatch):
    """Each confirmed rotation pins the new token and then forgets the old one,
    so ownMembers keeps one entry however often the token rotates."""
    server_link.set_access_token(CONFIG.token)
    ts = TokenServer(age_s=server_link.ROTATE_AFTER_S + 1)   # every connection rotates
    server = FakeServer(responder=ts.responder, count=8)
    link = _real_token_link(server, monkeypatch)
    assert await link.start() is True
    try:
        seen = []
        for _ in range(3):
            await _until(lambda: _stored_token() not in seen and _stored_token().startswith("nvd_rotated"), timeout=CONNECT_TIMEOUT_S)
            seen.append(server_link.access_token())
            await _until(lambda: len(_own_members()) == 1, timeout=CONNECT_TIMEOUT_S)
            await server.opened[-1].close()
            await _until(lambda: bool(server.opened[-1].syncs) and _stored_token() not in seen, timeout=CONNECT_TIMEOUT_S)
        owners = _own_members()
        assert len(owners) == 1 and list(owners.values()) == ["m1"]
        assert trust_store.member_for_credential(CONFIG.url, server_link.access_token()) == "m1"
        assert trust_store.only_credential_ever(CONFIG.url, server_link.access_token()) is True
    finally:
        await link.stop()


async def test_a_settled_promotion_forgets_the_old_pin(monkeypatch):
    """Promoting .next in the hello settle forgets the refused current token's pin."""
    server_link.set_access_token("tok-old-revoked")
    trust_store.adopt_own_member(CONFIG.url, "tok-old-revoked", "m1")
    app.credential_vault.write_app_secret(server_link.ACCESS_TOKEN_NEXT_SECRET, "nvd_next-live")
    ts = TokenServer(live=("nvd_next-live",), age_s=10)
    server = FakeServer(responder=ts.responder)
    link = _real_token_link(server, monkeypatch)
    assert await link.start() is True
    try:
        await _until(lambda: _stored_token() == "nvd_next-live", timeout=CONNECT_TIMEOUT_S)
        await _until(lambda: trust_store.member_for_credential(CONFIG.url, "tok-old-revoked") == "")
        assert trust_store.member_for_credential(CONFIG.url, "nvd_next-live") == "m1"
        assert len(_own_members()) == 1
    finally:
        await link.stop()


async def test_a_rotation_whose_pin_does_not_fit_stops_before_the_confirm(monkeypatch):
    """KC2R-1: if the trust record has no room to pin the rotated token, the rotation
    stops before its confirm and the current token keeps working."""
    original = trust_store.adopt_own_member

    def full_for_rotated(url, token, member):
        if token.startswith("nvd_rotated"):
            raise trust_store.TrustStoreFull("no room left in the trust record")
        return original(url, token, member)

    monkeypatch.setattr(trust_store, "adopt_own_member", full_for_rotated)
    server_link.set_access_token(CONFIG.token)
    ts = TokenServer(legacy=True)
    server = FakeServer(responder=ts.responder)
    link = _real_token_link(server, monkeypatch)
    assert await link.start() is True
    try:
        await _until(lambda: bool(server.opened and _sent(server.opened[0], "auth.token.rotate")), timeout=CONNECT_TIMEOUT_S)
        await asyncio.sleep(0.1)
        assert _sent(server.opened[0], "auth.token.confirm") == []
        assert server_link.access_token() == CONFIG.token
        assert CONFIG.token in ts.live
    finally:
        await link.stop()


# ---- compatibility: behaviour against a server from before C1, and signed out


async def test_against_an_old_server_nothing_rotates_and_nothing_is_written():
    """A pre-C1 server's hello reply has no tokenId / tokenAgeS / legacyToken:
    this build then behaves exactly as before — no rotate, no Keychain write."""
    store = TokenStore()
    server = FakeServer()  # default_responder: the old hello reply shape
    link = token_link(server, store)
    assert await link.start() is True
    try:
        await _until(lambda: _authed(server), timeout=CONNECT_TIMEOUT_S)
        await asyncio.sleep(0.05)
        kinds = {m.get("type") for m in server.opened[0].sent}
        assert not any(k.startswith("auth.token") for k in kinds)
        assert store.writes == []
        assert server.opened[0].hellos[0]["credential"] == CONFIG.token
    finally:
        await link.stop()


async def test_against_an_old_server_logout_is_a_quiet_false():
    """auth.logout is unknown to an old server: sign-out still erases locally."""

    def old_server(conn, message):
        if message.get("type") == "auth.logout":
            return {"id": message["id"], "type": "auth.logout.result", "ok": False,
                    "error": {"code": "UNKNOWN_TYPE", "message": "未註冊的 type：auth.logout"}}
        return default_responder(conn, message)

    store = TokenStore()
    server = FakeServer(responder=old_server)
    link = token_link(server, store)
    assert await link.start() is True
    try:
        await _until(lambda: _authed(server), timeout=CONNECT_TIMEOUT_S)
        assert await link.logout_on_server() is False
    finally:
        await link.stop()


def test_signed_out_config_never_reads_the_next_slot(monkeypatch):
    """With no token stored, load_config makes the same Keychain reads as before."""
    monkeypatch.setattr(server_link, "access_token", lambda: "")

    def must_not_read():
        raise AssertionError("read the .next slot while signed out")

    monkeypatch.setattr(server_link, "next_access_token", must_not_read)
    assert server_link.load_config().next_token == ""


# ---- Cloud token writes never touch the CLI account writer (user ruling 10-11)


def _guard_vault(tmp_path):
    from agent_team_backend.credential_vault import CredentialVault

    return CredentialVault(root=tmp_path, platform="darwin", security_runner=lambda args, stdin=None: (0, ""))




@pytest.mark.parametrize(
    "path",
    ["login", "rotate", "logout"],
)
async def test_cloud_token_writes_never_call_the_cli_keychain_writer(path, tmp_path, monkeypatch):
    from agent_team_backend import app as app_module
    from agent_team_backend.credential_vault import CredentialVault

    def forbidden(self, *args, **kwargs):
        raise AssertionError("a Navide Cloud token write reached CredentialVault._keychain_write")

    monkeypatch.setattr(CredentialVault, "_keychain_write", forbidden)
    monkeypatch.setattr(app_module, "credential_vault", _guard_vault(tmp_path))
    if path == "login":
        # ws_handlers' sign-in stores the issued token through this function.
        server_link.set_access_token("nvd_from-login")
    elif path == "rotate":
        # A link built without a token_store stores rotated tokens the same way,
        # in both slots.
        store = server_link.KeychainTokenStore()
        store.write("nvd_from-rotate", NXT, store.generation())
        store.write("nvd_from-rotate", CUR, store.generation())
    else:
        server_link.set_access_token(None)
