"""Writes that only *record* something never raise.

`note_remote_command` said "Never raises" and raised: its Keychain write failed
once the trust record outgrew `security -i`, and every relayed message was then
acked failed/receiver-error instead of being delivered (2026-10-10).
"""

from __future__ import annotations

import logging

import pytest

from agent_team_backend import trust_store
from agent_team_backend.credential_vault import CredentialVaultError

DEVICE = "dev-peer"


@pytest.fixture
def failing_writes(monkeypatch):
    trust_store.load()

    def refuse(_state):
        raise CredentialVaultError("keychain write failed for 'Navide secret navide-device-trust'")

    monkeypatch.setattr(trust_store, "_write", refuse)


RECORDERS = {
    "note_pairing": lambda: trust_store.note_pairing(DEVICE, kind="paired", device_name="TKM5"),
    "note_remote_command": lambda: trust_store.note_remote_command(
        DEVICE, device_name="TKM5", workspace="IDA", pane_name="IDA指揮"),
    "note_key_change": lambda: trust_store.note_key_change(
        DEVICE, pinned_key="a" * 64, offered_key="b" * 64, member_id="m1"),
    "note_policy_unverified": lambda: trust_store.note_policy_unverified("bad signature"),
    "note_plaintext_refused": lambda: trust_store.note_plaintext_refused(DEVICE, msg_key="k1"),
}


@pytest.mark.parametrize("name", sorted(RECORDERS))
def test_a_record_that_cannot_be_saved_is_logged_not_raised(name, failing_writes, caplog):
    caplog.set_level(logging.WARNING, logger="agent_team_backend.trust_store")
    RECORDERS[name]()
    assert "could not be saved" in caplog.text


def test_a_seen_ledger_that_cannot_be_saved_still_dedupes(failing_writes, caplog):
    caplog.set_level(logging.WARNING, logger="agent_team_backend.trust_store")
    trust_store.note_seen_message("k-1")
    trust_store.flush_seen_messages()
    assert trust_store.has_seen_message("k-1")
    assert "could not be saved" in caplog.text


def test_a_remote_command_on_a_locked_store_does_not_raise():
    trust_store.load()
    trust_store._state = None
    trust_store._locked_reason = "this machine has a cross-device trust record but its contents are missing or unreadable"
    trust_store.note_remote_command(DEVICE, device_name="TKM5", workspace="IDA", pane_name="p")


def test_names_another_device_supplies_are_bounded_in_a_notice():
    """Review KC-11: the device, workspace and pane names in a notice come from
    the other machine, and the journal keeps fifty notices."""
    trust_store.load()
    trust_store.note_remote_command(DEVICE * 300, device_name="N" * 10_000,
                                    workspace="W" * 10_000, pane_name="P" * 10_000)
    notice = trust_store.notices()[-1]
    for field in ("deviceId", "deviceName", "workspace", "paneName", "key"):
        assert len(notice[field]) <= trust_store.MAX_NOTICE_TEXT + 64, field
