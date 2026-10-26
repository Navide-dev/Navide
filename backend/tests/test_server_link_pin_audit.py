"""C1 review round 4 (sync審-資安, PR #166 @6671be8a), kept as repo tests.

The audit's measurements of the trust record under token rotation, sign-in
and sign-out through the real ServerLink and the real Keychain chain. Its
"still reproduces" cases are asserted fixed here or in
test_server_link_pin_bounds.py; the numbers it printed stay printed.
"""

import asyncio
import copy

import pytest

from agent_team_backend import app, cloud_secrets, server_link, trust_store
from agent_team_backend.server_link import ServerLink
from tests.test_server_link import CONFIG, FakeServer, TokenServer, _until
from tests.test_server_link_pin_bounds import (  # noqa: F401 - kc is a fixture
    FILE_ONLY, KEYCHAIN_ONLY, URL, _call, confirm_refused, core_cmd_len, kc, next_connection, owners,
    pair_max, real_link, store_mode,
)
from tests.test_trust_store_capacity import KEY, _device


def pair(n):
    for i in range(n):
        trust_store.pin_paired_device(_device(i), sign_key=KEY, enc_key="b" * 64, member_id=f"m-{i:012x}")




def decide_all(n):
    """KC2R-1: every decision the reserve promises, for every paired device."""
    fails = []
    for i in range(n):
        try:
            trust_store.note_encrypted_peer(_device(i))
            for _ in range(3):
                trust_store.reserve_policy_seq(_device(i))
            trust_store.note_blocked(_device(i), f"m-{i:012x}")
        except trust_store.TrustStoreFull:
            fails.append(i)
    return fails


def another_pairing_fits() -> bool:
    with trust_store._lock:
        st = copy.deepcopy(trust_store._load_locked())
        st["pins"][_device(0xFFFFFFFFFF)] = {"signKey": KEY, "encKey": "b" * 64,
                                             "memberId": "m-ffffffffffff", "at": 1760000000, "approved": True}
        return trust_store._fits_with_reserve_locked(st)



# ------------------------------------------------------------------ 1. bounded

# Each rotation is a reconnect (about a second), and the bound shows from the
# first one on: the audit ran 200 per case, which no CI per-test limit takes.
ROTATIONS = 6
# A rotation's own writes (.next, its read back, the member pin, the promote)
# each end in an fsync, slow on a loaded Windows runner; confirm_refused
# allows the same.
WRITE_CHAIN_S = 10.0


def round_s() -> float:
    """One round's deadline: the reconnect (the link had authenticated, so its
    backoff starts over at RECONNECT_BASE_S) and the rotation's write chain,
    with the reconnect's length again as margin. Not a fixed few seconds: those
    lost to a slow Windows round (0.2.22 release gate, #628 CI)."""
    return 2 * server_link.RECONNECT_BASE_S + WRITE_CHAIN_S


@pytest.mark.serial
@pytest.mark.parametrize("paired", [0, 3, 8])
async def test_real_rotations_keep_own_members_bounded(kc, paired):
    """ROTATIONS rotations through the real ServerLink and the real Keychain chain
    (set_access_token -> cloud_secrets.write -> security -i)."""
    trust_store.load()
    server_link.set_access_token(CONFIG.token)
    pair(paired)
    ts = TokenServer(age_s=server_link.ROTATE_AFTER_S + 1)
    server = FakeServer(responder=ts.responder, count=ROTATIONS + 30)
    link = real_link(server)
    sizes, counts = [], []
    assert await link.start() is True
    try:
        prev = CONFIG.token
        for r in range(ROTATIONS):
            await _until(lambda: server_link.access_token() != prev and server_link.next_access_token() == "", timeout=round_s())
            prev = server_link.access_token()
            await asyncio.sleep(0)
            counts.append(len(owners()))
            sizes.append(core_cmd_len())
            if r < ROTATIONS - 1:
                n = len(server.opened)
                await server.opened[-1].close()
                await next_connection(server, n, timeout=round_s())
        assert link._trust_locked == ""
    finally:
        await link.stop()
    print(f"\nPAIRED={paired} rotations={ROTATIONS} ownMembers(min/max/final)={min(counts)}/{max(counts)}/{counts[-1]} "
          f"cmd bytes(min/max/final)={min(sizes)}/{max(sizes)}/{sizes[-1]} longest -i={kc.longest} "
          f"another pairing fits={another_pairing_fits()}")
    assert counts[-1] == 1 and max(counts) == 1
    assert list(owners().values()) == ["m1"]
    assert trust_store.member_for_credential(URL, server_link.access_token()) == "m1"
    assert decide_all(paired) == []
    assert kc.longest <= 4095


async def test_sign_out_sign_in_20x_bounded(kc, monkeypatch):
    """Through the real p2p.account.logout handler; sign-in = token stored + hello adopts."""
    trust_store.load()
    pair(5)
    monkeypatch.setattr(app, "ui_settings_store", type("S", (), {"set": lambda self, d: d, "get": lambda self: {}})())

    async def _noop(*_a, **_k):
        return None

    monkeypatch.setattr(app, "broadcast", _noop)
    monkeypatch.setattr(server_link, "reconfigure", _noop)

    async def _status():
        return {}

    monkeypatch.setattr(server_link, "status", _status)
    server = FakeServer(count=30)
    counts = []
    for m in range(20):
        server_link.set_access_token(f"tok-signin-{m:02d}")
        link = real_link(server)
        n = len(server.opened)
        assert await link.start() is True
        await next_connection(server, n)
        await link.stop()
        counts.append(len(owners()))
        resp = await _call("p2p.account.logout", {})
        assert resp["ok"] is True
        assert server_link.access_token() == ""
    print(f"\nsign-in/out 20x: ownMembers after each sign-in={counts} after last logout={len(owners())}")
    assert max(counts) == 1 and len(owners()) == 0
    assert decide_all(5) == []




# --------------------------------------------- 1b. forget_own_member correctness

def test_forget_only_removes_that_credential(kc):
    trust_store.load()
    trust_store.adopt_own_member(URL, "a1", "m1")
    trust_store.adopt_own_member(URL, "a2", "m2")            # second account, same server
    trust_store.adopt_own_member("wss://other/ws", "a1", "m1")  # same token string, other server
    assert trust_store.forget_own_member(URL, "a1") is True
    assert trust_store.member_for_credential(URL, "a1") == ""
    assert trust_store.member_for_credential(URL, "a2") == "m2"
    assert trust_store.member_for_credential("wss://other/ws", "a1") == "m1"
    assert trust_store.forget_own_member(URL, "a1") is False
    assert trust_store.forget_own_member("", "a2") is False
    assert trust_store.forget_own_member(URL, "") is False
    assert len(owners()) == 2


@KEYCHAIN_ONLY  # fails the trust write through security; the file case is below
def test_forget_save_failure_rolls_back_and_raises(kc):
    trust_store.load()
    trust_store.adopt_own_member(URL, "a1", "m1")
    kc.fail_add.add(trust_store.SECRET_NAME)
    with pytest.raises(cloud_secrets.CloudSecretError):
        trust_store.forget_own_member(URL, "a1")
    assert trust_store.member_for_credential(URL, "a1") == "m1"   # rolled back in memory
    kc.fail_add.clear()
    trust_store._reset_for_test()
    assert trust_store.member_for_credential(URL, "a1") == "m1"   # and on disk
    assert not trust_store.locked_reason()


async def test_forget_skipped_when_successor_unpinned(kc):
    trust_store.load()
    trust_store.adopt_own_member(URL, "old", "m1")
    await ServerLink._forget_retired_pin(URL, "old", "new-unpinned")
    assert trust_store.member_for_credential(URL, "old") == "m1"


async def test_forget_called_after_confirm_success(kc, monkeypatch):
    trust_store.load()
    server_link.set_access_token(CONFIG.token)
    calls = []
    real = trust_store.forget_own_member
    monkeypatch.setattr(trust_store, "forget_own_member", lambda u, t: (calls.append(t), real(u, t))[1])
    ts = TokenServer(legacy=True)
    server = FakeServer(responder=ts.responder)
    link = real_link(server)
    assert await link.start()
    try:
        await _until(lambda: server_link.access_token().startswith("nvd_rotated") and server_link.next_access_token() == "")
    finally:
        await link.stop()
    assert calls == [CONFIG.token]
    assert set(owners().values()) == {"m1"} and len(owners()) == 1


async def test_forget_called_after_settle_promotion(kc, monkeypatch):
    """confirm applied on the server, answer lost: the next hello refuses the
    current token, settle promotes .next and forgets the old pin."""
    trust_store.load()
    server_link.set_access_token(CONFIG.token)
    calls = []
    real = trust_store.forget_own_member
    monkeypatch.setattr(trust_store, "forget_own_member", lambda u, t: (calls.append(t), real(u, t))[1])
    ts = TokenServer(legacy=True, confirm="lost-after-apply")
    server = FakeServer(responder=ts.responder, count=16)
    link = real_link(server)
    assert await link.start()
    try:
        await _until(lambda: len(server.opened) >= 2 and bool(server.opened[-1].syncs), timeout=5)
        await _until(lambda: server_link.access_token().startswith("nvd_rotated") and server_link.next_access_token() == "")
        await asyncio.sleep(0.05)
    finally:
        await link.stop()
    # R4-1: the lost answer drops the connection, which forgets the rotated
    # token's pin; settling carries it over again before promoting.
    assert calls[0].startswith("nvd_rotated") and calls[1:] == [CONFIG.token]
    assert len(owners()) == 1 and trust_store.member_for_credential(URL, server_link.access_token()) == "m1"


@KEYCHAIN_ONLY  # fails the trust write through security; the file case is below
async def test_forget_failure_does_not_stop_promotion(kc):
    """The trust record write fails exactly when forget runs: the rotation still
    promotes; the stale pin stays (costs room, not safety)."""
    trust_store.load()
    server_link.set_access_token(CONFIG.token)
    ts = TokenServer(legacy=True)
    base = ts.responder

    def responder(conn, message):
        if message.get("type") == "auth.token.confirm":
            kc.fail_add.add(trust_store.SECRET_NAME)
        return base(conn, message)

    server = FakeServer(responder=responder)
    link = real_link(server)
    assert await link.start()
    try:
        await _until(lambda: server_link.access_token().startswith("nvd_rotated") and server_link.next_access_token() == "")
        assert link._trust_locked == ""
    finally:
        await link.stop()
        kc.fail_add.clear()
    print("\nforget-failure: ownMembers", len(owners()))
    assert len(owners()) == 2



@KEYCHAIN_ONLY  # fills the record: a sealed file has no 4095-byte line to fill
async def test_refused_confirms_never_fill_the_record(kc):
    """With as many devices paired as the record takes, review R4-1 measured
    the record full after 3 server-refused rotations. Ten leave the one pin of
    the token in use, every promised decision, and room for a fresh sign-in."""
    trust_store.load()
    server_link.set_access_token(CONFIG.token)
    trust_store.adopt_own_member(URL, CONFIG.token, "m1")
    paired = pair_max()
    ts = TokenServer(legacy=True, confirm="refuse")
    server = FakeServer(responder=ts.responder, count=30)
    link = real_link(server)
    assert await link.start()
    try:
        for _ in range(10):
            await confirm_refused(server)
            n = len(server.opened)
            await server.opened[-1].close()
            await next_connection(server, n)
        await confirm_refused(server)
        await _until(lambda: link._trust_locked == "")
    finally:
        await link.stop()
    print(f"\nrefused-confirm at max pairing: paired={paired} ownMembers={len(owners())} cmd bytes={core_cmd_len()}")
    assert len(owners()) == 1
    # A sign-out and a fresh sign-in still fit; then every decision the
    # reserve promises (those fill it, so they go last).
    trust_store.forget_own_member(URL, CONFIG.token)
    trust_store.adopt_own_member(URL, "tok-fresh", "m1")
    assert decide_all(paired) == []


@KEYCHAIN_ONLY  # fills the record: a sealed file has no 4095-byte line to fill
def test_max_pairing_then_rotation_pin(kc):
    """At the most devices the record takes, does a rotation's transient second
    own pin still fit (adopt with the KC2R-1 reserve)?"""
    trust_store.load()
    trust_store.adopt_own_member(URL, "tok-signin", "m1")
    n = pair_max()
    try:
        trust_store.adopt_own_member(URL, "nvd_rotated-0001-0123456789", "m1")
        rot = "ok"
    except trust_store.TrustStoreFull:
        rot = "TrustStoreFull"
    print(f"\nM max-pair: paired={n} cmd bytes={core_cmd_len()} rotation pin={rot} decisions failing={decide_all(n)}")
    assert decide_all(n) == []


# ------------------------------- the sealed file: where a forget can fail


@pytest.fixture
def broken_file(monkeypatch):
    """Fails the sealed record's write while switched on — the one place the
    file store can refuse a save, as `security` is for the Keychain item."""
    state = {"on": False}
    real = trust_store._write_record_locked

    def write(core):
        if state["on"]:
            raise OSError("record file write refused")
        return real(core)

    monkeypatch.setattr(trust_store, "_write_record_locked", write)
    return state


@FILE_ONLY
def test_file_forget_save_failure_rolls_back_and_raises(kc, broken_file):
    trust_store.load()
    assert trust_store._store_mode == "file"
    trust_store.adopt_own_member(URL, "a1", "m1")
    broken_file["on"] = True
    with pytest.raises(OSError):
        trust_store.forget_own_member(URL, "a1")
    assert trust_store.member_for_credential(URL, "a1") == "m1"   # rolled back in memory
    broken_file["on"] = False
    trust_store._reset_for_test()
    assert trust_store.member_for_credential(URL, "a1") == "m1"   # and in the file
    assert not trust_store.locked_reason()


@FILE_ONLY
def test_file_forget_persists_across_restart(kc):
    trust_store.load()
    assert trust_store._store_mode == "file"
    trust_store.adopt_own_member(URL, "a1", "m1")
    trust_store.adopt_own_member(URL, "a2", "m1")
    assert trust_store.forget_own_member(URL, "a1") is True
    trust_store._reset_for_test()
    assert trust_store.member_for_credential(URL, "a1") == ""
    assert trust_store.member_for_credential(URL, "a2") == "m1"


@FILE_ONLY
async def test_file_forget_failure_does_not_stop_promotion(kc, broken_file):
    """The record file refuses exactly when forget runs: the rotation still
    promotes; the stale pin stays (costs room, not safety)."""
    trust_store.load()
    server_link.set_access_token(CONFIG.token)
    ts = TokenServer(legacy=True)
    base = ts.responder

    def responder(conn, message):
        if message.get("type") == "auth.token.confirm":
            broken_file["on"] = True
        return base(conn, message)

    server = FakeServer(responder=responder)
    link = real_link(server)
    assert await link.start()
    try:
        await _until(lambda: server_link.access_token().startswith("nvd_rotated") and server_link.next_access_token() == "")
        assert link._trust_locked == ""
    finally:
        await link.stop()
        broken_file["on"] = False
    assert trust_store._store_mode == "file"
    assert len(owners()) == 2
