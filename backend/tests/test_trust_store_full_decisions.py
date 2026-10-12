"""A full trust record still lets every decision about a paired device through,
and says so when something cannot be stored (review KC2R-1).

Pins filled the Keychain item to the last byte, so once it was full a block, a
policy write or an encrypted send to an already-paired device failed too, with
only the pairing path telling anyone why. And the block handler wrote the
server policy first, so a local failure left the two disagreeing.
"""

from __future__ import annotations

import pytest

from agent_team_backend import app, device_trust, server_link, trust_store
from agent_team_backend.credential_vault import CredentialVault
from tests.test_trust_store_capacity import KEY, _device, _Security


@pytest.fixture(autouse=True)
def _keychain_store(monkeypatch):
    """These pin down the record kept in its Keychain item — the store before
    the sealed file, and still the one used when the move cannot happen. The
    sealed file's own cases are in test_trust_store_file_mode."""
    monkeypatch.setattr(trust_store, "FILE_STORE", False)


@pytest.fixture
def keychain(tmp_path, monkeypatch):
    sec = _Security()
    monkeypatch.setattr(app, "credential_vault", CredentialVault(
        root=tmp_path / "r", real_home=tmp_path / "h", security_runner=sec, platform="darwin"))
    return sec


def _fill() -> int:
    trust_store.load()
    for index in range(trust_store.MAX_DEVICES):
        try:
            trust_store.pin_paired_device(_device(index), sign_key=KEY, enc_key="b" * 64,
                                          member_id=f"m-{index:032x}")
        except trust_store.TrustStoreFull:
            return index
    raise AssertionError("the Keychain record never filled up")


def test_every_paired_device_can_still_be_decided_on_when_full(keychain):
    paired = _fill()
    assert paired > 5
    for index in range(paired):
        trust_store.note_encrypted_peer(_device(index))
        for _ in range(3):
            trust_store.reserve_policy_seq(_device(index))
    for _ in range(3):
        trust_store.reserve_policy_seq("6f1c2d3e-0000-4000-8000-00000000own0")
    for index in range(paired):
        trust_store.note_blocked(_device(index), f"m-{index:032x}")
    assert keychain.longest <= 4095


def test_blocking_and_unblocking_a_paired_device_keeps_its_pin():
    """main's behaviour, kept on purpose (16:50: do not change what works): a
    block leaves the pin where it is, so lifting the block restores the device
    without pairing again. The room a block takes is reserved instead."""
    trust_store.load()
    trust_store.pin_paired_device("dev-x", sign_key=KEY, enc_key="b" * 64, member_id="m-x")
    assert trust_store.note_blocked("dev-x", "m-x") is True
    assert trust_store.pin_for("dev-x") is not None
    assert trust_store.is_blocked_locally(device_id="dev-x", member_id="")
    assert trust_store.note_unblocked("dev-x", "m-x") is True
    pin = trust_store.pin_for("dev-x")
    assert pin is not None and pin["approved"] is True
    assert not trust_store.is_blocked_locally(device_id="dev-x", member_id="")


async def test_a_policy_that_cannot_reserve_its_sequence_says_the_record_is_full(monkeypatch):
    from tests.test_server_link_trust import _trust_link

    trust_store.load()
    link = _trust_link()
    link._ws = object()
    link._authenticated = True

    def full(_device_id):
        raise trust_store.TrustStoreFull("the pairing record is full")

    monkeypatch.setattr(trust_store, "reserve_policy_seq", full)
    reply = await link.set_policy({"version": 1, "default": "deny", "rules": []})
    assert reply["ok"] is False
    assert reply["error"]["code"] == server_link.TRUST_STORE_FULL


class _Policy:
    def __init__(self) -> None:
        self.policy: dict | None = None
        self.writes: list[dict] = []

    async def policy_state(self) -> dict:
        return {"state": "connected", "editable": True, "policy": self.policy, "revision": 1,
                "deviceId": "dev-mine", "memberId": "m-mine"}

    async def set_policy(self, policy):
        self.writes.append(policy)
        self.policy = policy
        return {"ok": True, "payload": {"revision": len(self.writes) + 1}}


@pytest.fixture
def policy(monkeypatch):
    from agent_team_backend import confirm_token, ws_handlers
    from tests.test_ws_handlers_trust import _CONFIRM_KEY

    confirm_token._reset_for_test(_CONFIRM_KEY)
    fake = _Policy()
    monkeypatch.setattr(server_link, "policy_state", fake.policy_state)
    monkeypatch.setattr(server_link, "set_policy", fake.set_policy)
    monkeypatch.setattr(server_link, "forget_access_requests_for_device", lambda _d: False)
    monkeypatch.setattr(ws_handlers.remote_roster, "list_devices", lambda: [])
    yield fake
    confirm_token._reset_for_test()


def _full_record(monkeypatch):
    """The real note_blocked, with a record that has no room left."""
    from agent_team_backend import cloud_secrets

    monkeypatch.setattr(cloud_secrets, "fits", lambda *_a, **_k: False)


async def test_a_block_that_cannot_be_kept_locally_stays_in_force(policy, monkeypatch):
    """Fail closed: the server's block stands and this machine refuses the
    device too. Taking the server's block back when the local copy could not
    be saved left the device trusted — the opposite of what was asked for."""
    from tests.test_ws_handlers_trust import _call

    trust_store.load()
    _full_record(monkeypatch)
    reply = await _call("p2p.trust.block", {"deviceId": "dev-y"})

    assert reply["ok"] is False
    assert reply["error"]["code"] == "P2P_BLOCK_NOT_SAVED_LOCALLY_FULL"
    assert [e for e in policy.policy["blocked"] if e.get("deviceId") == "dev-y"]
    assert len(policy.writes) == 1
    assert device_trust.is_blocked(None, member_id="", device_id="dev-y")


async def test_a_block_whose_local_save_failed_otherwise_says_so(policy, monkeypatch):
    from agent_team_backend import cloud_secrets
    from agent_team_backend.credential_vault import CredentialVaultError
    from tests.test_ws_handlers_trust import _call

    trust_store.load()

    def refuse(*_a, **_k):
        raise CredentialVaultError("keychain write failed")

    monkeypatch.setattr(cloud_secrets, "write", refuse)
    reply = await _call("p2p.trust.block", {"deviceId": "dev-y"})

    assert reply["ok"] is False
    assert reply["error"]["code"] == "P2P_BLOCK_NOT_SAVED_LOCALLY"
    assert len(policy.writes) == 1
    assert device_trust.is_blocked(None, member_id="", device_id="dev-y")


def test_a_block_that_could_not_be_saved_holds_until_restart(monkeypatch):
    trust_store.load()
    _full_record(monkeypatch)
    with pytest.raises(trust_store.TrustStoreFull):
        trust_store.note_blocked("dev-z", "m-z")
    assert trust_store.is_blocked_locally(device_id="dev-z", member_id="")
    assert trust_store.is_blocked_locally(device_id="", member_id="m-z")
    # Lifting it is a decision too, and lifts the unsaved copy with it.
    trust_store.note_unblocked("dev-z", "m-z")
    assert not trust_store.is_blocked_locally(device_id="dev-z", member_id="m-z")


def _restart() -> None:
    with trust_store._lock:
        trust_store._state = None
        trust_store._unsaved_blocks.clear()   # a restart forgets the process copy
        trust_store._forget_written()


def test_an_unsaved_block_is_written_with_the_next_save_that_succeeds(monkeypatch):
    from agent_team_backend import cloud_secrets

    trust_store.load()
    real_fits = cloud_secrets.fits
    monkeypatch.setattr(cloud_secrets, "fits", lambda *_a, **_k: False)
    with pytest.raises(trust_store.TrustStoreFull):
        trust_store.note_blocked("dev-z", "m-z")
    monkeypatch.setattr(cloud_secrets, "fits", real_fits)

    trust_store.reserve_policy_seq("dev-self")
    assert trust_store._unsaved_blocks == []
    _restart()
    assert trust_store.is_blocked_locally(device_id="dev-z", member_id="")


def test_an_unsaved_block_that_still_does_not_fit_stays_in_memory(monkeypatch):
    from agent_team_backend import cloud_secrets

    trust_store.load()
    real_fits = cloud_secrets.fits
    # Room for anything but the block.
    monkeypatch.setattr(cloud_secrets, "fits",
                        lambda vault, name, secret: "dev-z" not in secret and real_fits(vault, name, secret))
    with pytest.raises(trust_store.TrustStoreFull):
        trust_store.note_blocked("dev-z", "m-z")

    assert trust_store.reserve_policy_seq("dev-self") == 1   # this save is not disturbed
    assert trust_store.is_blocked_locally(device_id="dev-z", member_id="")
    assert [e["deviceId"] for e in trust_store._unsaved_blocks] == ["dev-z"]
    with trust_store._lock:
        trust_store._state = None
        trust_store._forget_written()
    assert trust_store.policy_seq("dev-self") == 1


def test_a_block_whose_store_could_not_be_read_still_holds(monkeypatch):
    """Review F1: the load at the top of note_blocked sat outside the guard, so
    a Keychain read that failed for a moment raised before the block was held,
    and the reply's "this machine still refuses it" was not true."""
    trust_store.load()
    trust_store._state = None

    def unreadable():
        raise trust_store.TrustStoreLocked("the keychain is locked for a moment")

    monkeypatch.setattr(trust_store, "_load_locked", unreadable)
    with pytest.raises(trust_store.TrustStoreLocked):
        trust_store.note_blocked("dev-f1", "m-f1")
    assert [e["deviceId"] for e in trust_store._unsaved_blocks] == ["dev-f1"]


async def test_a_block_the_server_never_got_is_not_reported_as_in_force(policy, monkeypatch):
    """Review F2: a policy write refused as full (the sequence could not be
    reserved) answered with the same code as a block the server has, so the
    window said "blocked on the server" for a block nobody made."""
    from tests.test_ws_handlers_trust import _call

    trust_store.load()

    async def full(_policy):
        return {"ok": False, "error": {"code": server_link.TRUST_STORE_FULL, "message": "full"}}

    monkeypatch.setattr(server_link, "set_policy", full)
    reply = await _call("p2p.trust.block", {"deviceId": "dev-f2"})
    assert reply["error"]["code"] == server_link.TRUST_STORE_FULL
    assert not device_trust.is_blocked(None, member_id="", device_id="dev-f2")
