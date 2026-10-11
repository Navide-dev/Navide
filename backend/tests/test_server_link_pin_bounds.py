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

from agent_team_backend import app, cloud_secrets, server_link, trust_store, ws_handlers  # noqa: F401 - registers the handlers
from agent_team_backend.credential_vault import CredentialVault
from agent_team_backend.server_link import ServerLink
from tests.keychain_fake import security_g_output
from tests.test_server_link import CONFIG, FakeServer, TokenServer, _until
from tests.test_trust_store_capacity import KEY, _device

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


def pair_max() -> int:
    """Pair devices until the record takes no more; how many it took."""
    n = 0
    while True:
        try:
            trust_store.pin_paired_device(_device(n), sign_key=KEY, enc_key="b" * 64, member_id=f"m-{n:012x}")
            n += 1
        except trust_store.TrustStoreFull:
            return n


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
    with it, so a dozen connections leave the one pin of the token in use
    (review R4-1 measured one more pin per connection)."""
    trust_store.load()
    server_link.set_access_token(CONFIG.token)
    ts = TokenServer(legacy=True, confirm="refuse")
    server = FakeServer(responder=ts.responder, count=30)
    link = real_link(server)
    counts = []
    assert await link.start()
    try:
        for _ in range(12):
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


# ------------------------------------- R4-2: a revoked or replaced token


async def _connect_once(server):
    link = real_link(server)
    n = len(server.opened)
    assert await link.start()
    await _until(lambda: len(server.opened) > n and bool(server.opened[-1].hellos), timeout=5)
    await asyncio.sleep(0.05)
    return link


async def test_revocations_at_max_pairing_keep_sign_in_working(kc):
    """auth.revoked (password changed elsewhere, token revoked, device removed)
    clears the token and its pin: with the record holding as many devices as it
    takes, 20 revocations in a row and the next sign-in still works."""
    trust_store.load()
    trust_store.adopt_own_member(URL, "tok-0", "m1")
    paired = pair_max()
    trust_store.forget_own_member(URL, "tok-0")
    server = FakeServer(count=30)
    for i in range(20):
        server_link.set_access_token(f"tok-signin-{i:03d}")
        link = await _connect_once(server)
        try:
            assert link._trust_locked == "", f"sign-in {i} refused with {paired} devices paired"
            await link._on_revoked({"reason": "password-changed", "memberId": "m1"})
        finally:
            await link.stop()
        assert server_link.access_token() == ""
        assert owners() == {}
    server_link.set_access_token("tok-after")
    link = await _connect_once(server)
    try:
        assert link._trust_locked == ""
        assert link._own_member == "m1"
    finally:
        await link.stop()
    assert len(owners()) == 1


class _Settings:
    def get(self):
        return {}

    def set(self, delta):
        return {}


async def _call(msg_type, payload):
    sent = []

    class _Ws:
        async def send_json(self, message):
            sent.append(message)

    await app.handle_message(app.Session(_Ws()), {"id": "x", "type": msg_type, "payload": payload})
    return sent[-1]


@pytest.mark.parametrize("verb", ["p2p.link.configure", "p2p.account.login"])
async def test_sign_in_over_a_stored_token_forgets_its_pin(kc, monkeypatch, verb):
    """Signing in while signed in replaces the stored token; the replaced one's
    pin goes with it, so the record keeps one pin however often that happens."""
    trust_store.load()

    async def _noop(*_a, **_k):
        return None

    async def _status():
        return {}

    monkeypatch.setattr(app, "ui_settings_store", _Settings())
    monkeypatch.setattr(app, "broadcast", _noop)
    monkeypatch.setattr(server_link, "reconfigure", _noop)
    monkeypatch.setattr(server_link, "status", _status)
    server = FakeServer(count=8)
    for tok in ("tok-1", "tok-2", "tok-3"):
        if verb == "p2p.link.configure":
            resp = await _call(verb, {"token": tok})
        else:
            async def _account(url, msg_type, payload, tok=tok):
                return {"memberId": "m1", "email": "a@example.invalid", "token": tok}

            monkeypatch.setattr(server_link, "account_request", _account)
            resp = await _call(verb, {"email": "a@example.invalid", "password": "pw-" + "x"})
        assert resp["ok"] is True, resp
        assert server_link.access_token() == tok
        link = await _connect_once(server)
        await link.stop()
        assert link._own_member == "m1"
    assert len(owners()) == 1
    assert trust_store.member_for_credential(URL, "tok-3") == "m1"


# ------------------------------------------- R4-3: a full record says so


async def test_a_full_record_is_its_own_lock_code(kc):
    """A sign-in whose pin does not fit is not "the trust store could not be
    opened": the snapshot names it `full`, which the account view words as
    "unpair a device" and offers no start-over for."""
    trust_store.load()
    trust_store.adopt_own_member(URL, "tok-0", "m1")
    pair_max()
    n = 1
    with pytest.raises(trust_store.TrustStoreFull):
        while True:
            trust_store.adopt_own_member(URL, f"tok-filler-{n:03d}", "m1")
            n += 1
    server_link.set_access_token("tok-new")
    link = await _connect_once(FakeServer(count=4))
    try:
        snapshot = link.network_snapshot()
    finally:
        await link.stop()
    assert snapshot["trustLockedCode"] == "full"
    assert snapshot["trustLocked"]
    assert "could not be opened" not in snapshot["trustLocked"]
    # Unpairing one device makes the room; the next hello takes the pin.
    trust_store.forget_device(_device(0))
    link = await _connect_once(FakeServer(count=4))
    try:
        snapshot = link.network_snapshot()
    finally:
        await link.stop()
    assert snapshot["trustLocked"] == "" and snapshot["trustLockedCode"] == ""
    assert trust_store.member_for_credential(URL, "tok-new") == "m1"


async def test_an_unreadable_record_keeps_no_full_code(kc, monkeypatch):
    trust_store.load()
    server_link.set_access_token("tok-new")

    def _broken(*_a, **_k):
        raise trust_store.TrustStoreLocked("the record cannot be read")

    monkeypatch.setattr(trust_store, "adopt_own_member", _broken)
    link = await _connect_once(FakeServer(count=4))
    try:
        snapshot = link.network_snapshot()
    finally:
        await link.stop()
    assert snapshot["trustLocked"]
    assert snapshot["trustLockedCode"] == ""


# ------------------------------------ R4-4: sign-out unpins only once gone


async def _sign_out(monkeypatch):
    async def _noop(*_a, **_k):
        return None

    async def _status():
        return {}

    monkeypatch.setattr(app, "ui_settings_store", _Settings())
    monkeypatch.setattr(app, "broadcast", _noop)
    monkeypatch.setattr(server_link, "reconfigure", _noop)
    monkeypatch.setattr(server_link, "status", _status)
    return await _call("p2p.account.logout", {})


async def test_sign_out_whose_delete_failed_quietly_keeps_the_pin(kc, monkeypatch):
    """The vault's delete does not check security's exit code. When it fails,
    the token is still stored, so it keeps its pin: the next hello is held to
    the member it was pinned to, not to whatever member a server names."""
    from tests.test_server_link import default_responder

    trust_store.load()
    server_link.set_access_token("tok-a")
    trust_store.adopt_own_member(URL, "tok-a", "m1")
    kc.silent_delete.add(CUR_S)
    resp = await _sign_out(monkeypatch)
    kc.silent_delete.clear()
    assert resp["ok"] is True
    assert server_link.access_token() == "tok-a"
    assert trust_store.member_for_credential(URL, "tok-a") == "m1"

    def evil(conn, message):
        reply = default_responder(conn, message)
        if message.get("type") == "auth.hello" and reply and reply.get("ok"):
            reply["payload"]["memberId"] = "m-evil"
        return reply

    link = await _connect_once(FakeServer(responder=evil))
    try:
        assert link._own_member != "m-evil"
    finally:
        await link.stop()


async def test_sign_out_forgets_the_pins_once_the_token_is_gone(kc, monkeypatch):
    trust_store.load()
    server_link.set_access_token("tok-a")
    trust_store.adopt_own_member(URL, "tok-a", "m1")
    resp = await _sign_out(monkeypatch)
    assert resp["ok"] is True
    assert server_link.access_token() == ""
    assert owners() == {}
