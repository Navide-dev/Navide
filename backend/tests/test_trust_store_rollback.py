"""A decision that cannot be saved is not kept in memory either (review KC-1).

Every decision write used to change the cached state and then save it. When the
save raised, the change stayed: a pairing reported to the user as failed was
still trusted until the next restart, a block vanished at the restart, a policy
sequence could go backwards, and the "never accept plaintext again" mark was
skipped on the next message because memory already had it.
"""

from __future__ import annotations

import pytest

from agent_team_backend import cloud_secrets, trust_store
from agent_team_backend.cloud_secrets import CloudSecretError


@pytest.fixture(autouse=True)
def _keychain_store(monkeypatch):
    """These pin down the record kept in its Keychain item — the store before
    the sealed file, and still the one used when the move cannot happen. The
    sealed file's own cases are in test_trust_store_file_mode."""
    monkeypatch.setattr(trust_store, "FILE_STORE", False)

DEVICE = "4a50baf4-5c26-4785-a792-6fa9fd7387b0"
KEY = "A" * 43 + "="


@pytest.fixture
def saves_fail(monkeypatch):
    """Saves fail while ``failing["on"]`` is true. Switched off by the flag, not
    by ``monkeypatch.undo()``: that would also undo conftest's isolation, which
    shares this monkeypatch, and put the real Keychain back in reach."""
    trust_store.load()
    trust_store.pin_device("dev-known", sign_key=KEY, member_id="m1")
    failing = {"on": True}
    real = cloud_secrets.write

    def refuse(vault, name, secret):
        if failing["on"]:
            raise CloudSecretError("refusing to write 'Navide secret navide-device-trust'")
        return real(vault, name, secret)

    monkeypatch.setattr(cloud_secrets, "write", refuse)
    return failing


def test_a_pin_that_cannot_be_saved_is_not_trusted(saves_fail):
    with pytest.raises(CloudSecretError):
        trust_store.pin_paired_device(DEVICE, sign_key=KEY, enc_key="b" * 64, member_id="m1")
    assert trust_store.pin_for(DEVICE) is None
    with pytest.raises(CloudSecretError):
        trust_store.pin_device(DEVICE, sign_key=KEY, member_id="m1")
    assert trust_store.pin_for(DEVICE) is None


def test_a_block_that_cannot_be_saved_still_holds_until_restart(saves_fail):
    """The one decision that is not taken back: a block that failed to save
    still refuses the device for the life of the process (fail closed). The
    save still fails loudly, so the caller can say the copy was not kept."""
    with pytest.raises(CloudSecretError):
        trust_store.note_blocked("dev-known", "m1")
    assert trust_store.is_blocked_locally(device_id="dev-known", member_id="m1")


def test_a_policy_sequence_that_cannot_be_saved_is_not_spent(saves_fail):
    before = trust_store.policy_seq("dev-self")
    with pytest.raises(CloudSecretError):
        trust_store.reserve_policy_seq("dev-self")
    assert trust_store.policy_seq("dev-self") == before


def test_an_encrypted_peer_mark_is_saved_on_the_next_try(saves_fail):
    with pytest.raises(CloudSecretError):
        trust_store.note_encrypted_peer("dev-known")
    assert not trust_store.is_encrypted_peer("dev-known")

    saves_fail["on"] = False
    trust_store.note_encrypted_peer("dev-known")
    trust_store._state = None
    trust_store._forget_written()
    assert trust_store.is_encrypted_peer("dev-known")


def test_a_failed_decision_keeps_the_in_memory_ledger(saves_fail):
    trust_store.note_seen_message("k-1")
    with pytest.raises(CloudSecretError):
        trust_store.note_blocked("dev-known", "m1")
    assert trust_store.has_seen_message("k-1")


def test_a_pairing_that_could_not_be_saved_leaves_no_paired_notice(monkeypatch):
    """Review R2-3: the first-sighting notice — "paired: True" — was recorded
    before the save and outlived its rollback, so the account view showed the
    device as paired and the pairing as failed at once."""
    from agent_team_backend import cloud_secrets
    from agent_team_backend.credential_vault import CredentialVaultError

    trust_store.load()

    def refuse(*_a, **_k):
        raise CredentialVaultError("keychain write failed")

    monkeypatch.setattr(cloud_secrets, "write", refuse)
    with pytest.raises(CredentialVaultError):
        trust_store.pin_paired_device("dev-r23", sign_key="A" * 43 + "=", enc_key="b" * 64,
                                      member_id="m-r23")
    assert not [n for n in trust_store.notices() if n.get("deviceId") == "dev-r23"]
