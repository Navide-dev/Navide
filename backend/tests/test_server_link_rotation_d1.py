"""C1 review round 4, D1 through the real Keychain chain after the merge: every rotation-side write
goes set_access_token -> cloud_secrets.write -> security -i. A CloudSecretError
(rc != 0, over the line limit, a line break) must count as a failed write: the
current token kept, no lock-out, the next start settles."""
import asyncio

import pytest

from agent_team_backend import server_link, trust_store
from tests.test_server_link import CONFIG, FakeServer, TokenServer, _until
from tests.test_server_link_pin_bounds import (  # noqa: F401 - kc and store_mode are fixtures
    CUR_S, KEYCHAIN_ONLY, NXT_S, kc, owners, real_link, store_mode,
)


class LongTokenServer(TokenServer):
    def __init__(self, token, **k):
        super().__init__(**k)
        self.forced = token

    def responder(self, conn, message):
        if message.get("type") == "auth.token.rotate":
            new = self.forced
            old = (conn.hellos[-1] or {}).get("credential") if conn.hellos else CONFIG.token
            self.pending[new] = old
            return {"id": message["id"], "type": "auth.token.rotate.result", "ok": True,
                    "payload": {"token": new, "tokenId": "tid-long", "pendingUntil": "later"}}
        if message.get("type") == "auth.token.confirm":
            self.pending.pop(self.forced, None)
            return {"id": message["id"], "type": "auth.token.confirm.result", "ok": False,
                    "error": {"code": "NOT_FOUND", "message": "x"}}
        return super().responder(conn, message)


async def _restart_ok(server, ts):
    link = real_link(server)
    n = len(server.opened)
    assert await link.start() is True
    try:
        await _until(lambda: len(server.opened) > n and bool(server.opened[-1].syncs), timeout=5)
        await asyncio.sleep(0.1)
        cred = [h for c in server.opened[n:] for h in c.hellos][-1]["credential"]
        assert cred in ts.live
        assert server_link.access_token() in ts.live
        assert server_link.next_access_token() == ""
        assert link._trust_locked == ""
    finally:
        await link.stop()


@pytest.mark.parametrize("scenario", ["next_add_rc1", "next_too_long", "next_newline",
                                      "promotion_add_rc1", "next_clear_silent_fail"])
async def test_D1_real_chain(kc, scenario):
    trust_store.load()
    server_link.set_access_token(CONFIG.token)
    if scenario == "next_too_long":
        ts = LongTokenServer("nvd_" + "x" * 4100, legacy=True)
    elif scenario == "next_newline":
        ts = LongTokenServer("nvd_abc\nadd-generic-password -s evil -w x", legacy=True)
    else:
        ts = TokenServer(legacy=True)
    if scenario == "next_add_rc1":
        kc.fail_add.add(NXT_S)
    if scenario == "promotion_add_rc1":
        kc.fail_add.add(CUR_S)
    if scenario == "next_clear_silent_fail":
        kc.silent_delete.add(NXT_S)
    server = FakeServer(responder=ts.responder, count=16)
    link = real_link(server)
    assert await link.start() is True
    await _until(lambda: bool(server.opened) and any(m.get("type") == "auth.token.rotate" for m in server.opened[0].sent))
    await asyncio.sleep(0.2)
    await link.stop()
    after_quit = (server_link.access_token()[:20], server_link.next_access_token()[:20])
    confirms = sum(1 for m in server.opened[0].sent if m.get("type") == "auth.token.confirm")
    kc.fail_add.clear(); kc.silent_delete.clear()
    ts.rotate_code = "UNKNOWN_TYPE"
    print(f"\nD1 {scenario}: after quit cur/next={after_quit} confirms sent={confirms} owners={len(owners())} longest={kc.longest}")
    if scenario in ("next_add_rc1", "next_too_long", "next_newline"):
        assert confirms == 0 and server_link.access_token() == CONFIG.token
    await _restart_ok(server, ts)
    ts.pending.clear()
    await _restart_ok(server, ts)
    assert kc.longest <= 4095
    print(f"D1 {scenario}: settled cur={server_link.access_token()[:20]} owners={len(owners())}")


async def test_old_server_no_rotation_no_writes(kc):
    """A server whose hello carries no tokenId: no auth.token.rotate is sent and
    nothing is written to either token slot over several connections."""
    trust_store.load()
    server_link.set_access_token(CONFIG.token)
    kc.calls.clear()
    server = FakeServer(count=8)
    link = real_link(server)
    assert await link.start()
    try:
        await _until(lambda: bool(server.opened) and bool(server.opened[-1].syncs))
        for _ in range(3):
            n = len(server.opened)
            await server.opened[-1].close()
            await _until(lambda: len(server.opened) > n and bool(server.opened[-1].syncs))
        await asyncio.sleep(0.1)
    finally:
        await link.stop()
    sent = [m.get("type") for c in server.opened for m in c.sent]
    token_writes = [c for c in kc.calls if c.startswith(("add", "delete")) and "navide-server-token" in c]
    print("\nold server: rotate/confirm sent:", [t for t in sent if t.startswith("auth.token")], "token slot writes:", token_writes,
          "owners:", len(owners()))
    assert not [t for t in sent if t.startswith("auth.token")]
    assert token_writes == []
    assert server_link.access_token() == CONFIG.token


# Pairing as many devices as the record takes fills it, so "max" is the
# Keychain item's alone: a sealed file has no 4095-byte line to fill.
@pytest.mark.parametrize("store_mode,paired", [("file", 5), ("keychain", 5), ("keychain", "max")],
                         indirect=["store_mode"])
async def test_revocations_never_refuse_sign_in(kc, paired):
    """auth.revoked (password changed elsewhere, token revoked, device removed)
    clears the token and its pin (review R4-2 measured sign-in refused after 5
    revocations with the record full, 35 with five paired): 60 in a row."""
    from tests.test_server_link_pin_audit import decide_all, pair, pair_max
    trust_store.load()
    trust_store.adopt_own_member(CONFIG.url, "tok-0", "m1")
    n = pair_max() if paired == "max" else (pair(paired) or paired)
    trust_store.forget_own_member(CONFIG.url, "tok-0")
    server = FakeServer(count=80)
    for i in range(60):
        server_link.set_access_token(f"tok-signin-{i:03d}")
        link = real_link(server)
        k = len(server.opened)
        assert await link.start()
        await _until(lambda: len(server.opened) > k and bool(server.opened[-1].hellos), timeout=5)
        await asyncio.sleep(0.05)
        try:
            assert link._trust_locked == "", f"sign-in {i} refused with {n} devices paired"
            await link._on_revoked({"reason": "password-changed", "memberId": "m1"})
        finally:
            await link.stop()
        assert server_link.access_token() == ""
    assert owners() == {}
    assert decide_all(n) == []


@KEYCHAIN_ONLY  # fills the record: a sealed file has no 4095-byte line to fill
async def test_a_full_record_recovers_by_unpairing_and_not_by_starting_over(kc):
    """A record filled some other way: starting over refuses an intact record,
    and unpairing one device lets the next sign-in take its pin."""
    from tests.test_server_link_pin_bounds import fill_with_own_pins, pair_max
    from tests.test_trust_store_capacity import _device
    trust_store.load()
    trust_store.adopt_own_member(CONFIG.url, "tok-0", "m1")
    pair_max()
    fill_with_own_pins()
    server = FakeServer(count=8)

    async def sign_in(tok):
        server_link.set_access_token(tok)
        link = real_link(server)
        k = len(server.opened)
        assert await link.start()
        await _until(lambda: len(server.opened) > k and bool(server.opened[-1].hellos), timeout=5)
        await asyncio.sleep(0.05)
        return link

    link = await sign_in("tok-new")
    # The lock is set after the hello, once adoption returns from its thread:
    # wait for it rather than for a fixed time a loaded runner can outlast.
    await _until(lambda: bool(link._trust_locked), timeout=5)
    assert link._trust_locked_code == "full"
    await link.stop()
    with pytest.raises(trust_store.TrustStoreNotLocked):
        trust_store.rebuild_locked_store()
    trust_store.forget_device(_device(0))
    link = await sign_in("tok-new")
    try:
        assert link._trust_locked == "" and link._trust_locked_code == ""
    finally:
        await link.stop()
