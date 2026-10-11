"""A full trust record still lets every decision about a paired device through,
and says so when something cannot be stored (review KC2R-1).

Pins filled the Keychain item to the last byte, so once it was full a block, a
policy write or an encrypted send to an already-paired device failed too, with
only the pairing path telling anyone why. And the block handler wrote the
server policy first, so a local failure left the two disagreeing.
"""

from __future__ import annotations

import pytest

from agent_team_backend import app, server_link, trust_store
from agent_team_backend.credential_vault import CredentialVault
from tests.test_trust_store_capacity import KEY, _device, _Security


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


async def test_a_block_that_cannot_be_kept_locally_is_taken_back_and_reported(policy, monkeypatch):
    from tests.test_ws_handlers_trust import _call

    trust_store.load()

    def full(*_a, **_k):
        raise trust_store.TrustStoreFull("the pairing record is full")

    monkeypatch.setattr(trust_store, "note_blocked", full)
    reply = await _call("p2p.trust.block", {"deviceId": "dev-y"})

    assert reply["ok"] is False
    assert reply["error"]["code"] == server_link.TRUST_STORE_FULL
    assert not [e for e in policy.policy.get("blocked", []) if e.get("deviceId") == "dev-y"]


async def test_a_block_whose_rollback_also_fails_says_the_two_disagree(policy, monkeypatch):
    from tests.test_ws_handlers_trust import _call

    trust_store.load()

    def full(*_a, **_k):
        raise trust_store.TrustStoreFull("the pairing record is full")

    monkeypatch.setattr(trust_store, "note_blocked", full)
    real = policy.set_policy

    async def once_then_offline(p):
        if policy.writes:
            return {"ok": False, "error": {"code": "LINK_OFFLINE", "message": "gone"}}
        return await real(p)

    monkeypatch.setattr(server_link, "set_policy", once_then_offline)
    reply = await _call("p2p.trust.block", {"deviceId": "dev-y"})

    assert reply["ok"] is False
    assert reply["error"]["code"] == "P2P_BLOCK_NOT_SAVED_LOCALLY"
