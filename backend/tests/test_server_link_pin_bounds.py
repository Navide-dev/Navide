"""Member pins of tokens this machine no longer holds are forgotten (C1 review R4).

Every token the link says hello with is pinned to its member in the trust
record, and the record is one Keychain item with no room to spare. A pin left
behind by a token that is gone costs that room for good, so every path that
drops a token must drop its pin too — and only once the token is really gone.

Runs the real ServerLink against the real Keychain chain (set_access_token ->
cloud_secrets.write -> security -i), with a fake `security` that honours the
4095-byte -i line and can be told to fail.
"""

import asyncio
import json
import shlex

import pytest

from agent_team_backend import app, cloud_secrets, server_link, trust_store
from agent_team_backend.credential_vault import CredentialVault
from agent_team_backend.server_link import ServerLink
from tests.keychain_fake import security_g_output
from tests.test_server_link import CONFIG, FakeServer, TokenServer, _until

URL = CONFIG.url
CUR_S = server_link.ACCESS_TOKEN_SECRET
NXT_S = server_link.ACCESS_TOKEN_NEXT_SECRET


class Sec:
    """`security` stand-in honouring the 4095-byte -i line, with switchable faults."""

    def __init__(self):
        self.items: dict[str, str] = {}
        self.longest = 0
        self.fail_add: set[str] = set()      # services whose add returns rc 1
        self.silent_delete: set[str] = set()  # services whose delete returns rc 1 and keeps the item
        self.calls: list[str] = []

    def __call__(self, args, input_text=None):
        if args == ["-i"]:
            line = (input_text or "").rstrip("\n").encode()
            self.longest = max(self.longest, len(line))
            if len(line) > 4095:
                raise AssertionError("a -i line over 4095 bytes reached security")
        tokens = shlex.split(input_text) if args == ["-i"] else list(args)
        service = tokens[tokens.index("-s") + 1]
        self.calls.append(f"{tokens[0]} {service}")
        if tokens[0] == "add-generic-password":
            if any(f" {s}@" in service for s in self.fail_add):
                return 1, ""
            self.items[service] = tokens[tokens.index("-w") + 1]
            return 0, ""
        if tokens[0] == "find-generic-password":
            return (0, security_g_output(self.items[service])) if service in self.items else (44, "")
        if tokens[0] == "delete-generic-password":
            if any(f" {s}@" in service for s in self.silent_delete):
                return 1, ""
            return (0, "") if self.items.pop(service, None) is not None else (44, "")
        return 1, ""


@pytest.fixture
def kc(tmp_path, monkeypatch):
    sec = Sec()
    monkeypatch.setattr(app, "credential_vault", CredentialVault(
        root=tmp_path / "r", real_home=tmp_path / "h", security_runner=sec, platform="darwin"))
    monkeypatch.setattr(server_link, "server_url", lambda: URL)
    return sec


def owners() -> dict:
    with trust_store._lock:
        return dict(trust_store._load_locked()["ownMembers"])


def core_cmd_len() -> int:
    with trust_store._lock:
        core = json.dumps(trust_store._core_of(trust_store._load_locked()), ensure_ascii=False, separators=(",", ":"))
    return len(cloud_secrets._command(trust_store._vault(), trust_store.SECRET_NAME, core).encode())


def real_link(server):
    return ServerLink(connect=server.connect, device_name="test-box")


async def next_connection(server, n_before):
    await _until(lambda: len(server.opened) > n_before and bool(server.opened[-1].syncs), timeout=5)


class FixedTokenServer(TokenServer):
    """Offers one given token on every rotation and refuses its confirm."""

    def __init__(self, token, **k):
        super().__init__(**k)
        self.forced = token

    def responder(self, conn, message):
        if message.get("type") == "auth.token.rotate":
            return {"id": message["id"], "type": "auth.token.rotate.result", "ok": True,
                    "payload": {"token": self.forced, "tokenId": "tid-fixed", "pendingUntil": "later"}}
        if message.get("type") == "auth.token.confirm":
            return {"id": message["id"], "type": "auth.token.confirm.result", "ok": False,
                    "error": {"code": "NOT_FOUND", "message": "x"}}
        return super().responder(conn, message)


# ---------------------------------------------------- R4-1: a dropped .next


async def test_refused_confirm_does_not_grow_own_members(kc):
    """A server (a malicious relay, or a bug) that offers a rotation and answers
    the confirm NOT_FOUND on every connection: each dropped .next takes its pin
    with it, so 100 connections leave the one pin of the token in use."""
    trust_store.load()
    server_link.set_access_token(CONFIG.token)
    ts = TokenServer(legacy=True, confirm="refuse")
    server = FakeServer(responder=ts.responder, count=120)
    link = real_link(server)
    counts = []
    assert await link.start()
    try:
        for _ in range(100):
            await asyncio.sleep(0.03)
            counts.append(len(owners()))
            n = len(server.opened)
            await server.opened[-1].close()
            await next_connection(server, n)
        await asyncio.sleep(0.05)
        counts.append(len(owners()))
    finally:
        await link.stop()
    assert server_link.access_token() == CONFIG.token
    assert server_link.next_access_token() == ""
    assert counts[-1] == 1 and max(counts) <= 2
    assert trust_store.member_for_credential(URL, CONFIG.token) == "m1"


async def test_unanswered_confirm_then_settle_drop_forgets_pin(kc):
    """The confirm is never answered and the App stops: the next hello finds
    the current token good and drops .next together with its pin."""
    trust_store.load()
    server_link.set_access_token(CONFIG.token)
    ts = TokenServer(legacy=True, confirm="never")
    server = FakeServer(responder=ts.responder, count=16)
    link = real_link(server)
    assert await link.start()
    try:
        await _until(lambda: bool(server.opened) and any(m.get("type") == "auth.token.confirm" for m in server.opened[0].sent))
        await link.stop()
        assert server_link.next_access_token().startswith("nvd_rotated")
        ts.rotate_code = "UNKNOWN_TYPE"
        ts.pending.clear()
        link = real_link(server)
        assert await link.start()
        await _until(lambda: server_link.next_access_token() == "" and len(server.opened) >= 2 and bool(server.opened[-1].syncs))
    finally:
        await link.stop()
    assert server_link.access_token() == CONFIG.token
    assert len(owners()) == 1


async def test_lost_confirm_answer_still_promotes_after_its_pin_was_forgotten(kc):
    """The confirm landed but its answer was lost with the connection: the pin
    forgotten on the way out is carried over again before the promotion."""
    trust_store.load()
    server_link.set_access_token(CONFIG.token)
    ts = TokenServer(legacy=True, confirm="lost-after-apply")
    server = FakeServer(responder=ts.responder, count=16)
    link = real_link(server)
    assert await link.start()
    try:
        await _until(lambda: len(server.opened) >= 2 and bool(server.opened[-1].syncs), timeout=5)
        await _until(lambda: server_link.access_token().startswith("nvd_rotated") and server_link.next_access_token() == "")
        await asyncio.sleep(0.05)
        assert link._trust_locked == ""
    finally:
        await link.stop()
    assert len(owners()) == 1
    assert trust_store.member_for_credential(URL, server_link.access_token()) == "m1"


async def test_dropping_next_never_forgets_the_current_tokens_pin(kc):
    """A server that hands back the current token as the rotated one and then
    refuses the confirm: .next goes, the current token keeps its pin."""
    trust_store.load()
    server_link.set_access_token(CONFIG.token)
    ts = FixedTokenServer(CONFIG.token, legacy=True)
    server = FakeServer(responder=ts.responder, count=8)
    link = real_link(server)
    assert await link.start()
    try:
        await _until(lambda: bool(server.opened) and any(m.get("type") == "auth.token.confirm" for m in server.opened[0].sent))
        await asyncio.sleep(0.1)
    finally:
        await link.stop()
    assert server_link.access_token() == CONFIG.token
    assert server_link.next_access_token() == ""
    assert trust_store.member_for_credential(URL, CONFIG.token) == "m1"
