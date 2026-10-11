"""A trust record that is there but cut off says so, and says what to do.

On 2026-10-11 the record in the Keychain was 3637 bytes ending mid-string: a
write past `security -i`'s line limit had stored its first 4095 bytes. The lock
it caused read "contents are missing or unreadable", which sounds like an attack
or a lost Keychain and sent nobody towards the one fix there is — pair again.
"""

from __future__ import annotations

import json

import pytest

from agent_team_backend import app, trust_store


def _cut_record() -> None:
    trust_store.load()
    trust_store.pin_device("dev-a", sign_key="k" * 64, member_id="m1")
    whole = app.credential_vault.read_app_secret(trust_store.SECRET_NAME)
    app.credential_vault.write_app_secret(trust_store.SECRET_NAME, whole[: len(whole) // 2])
    trust_store._state = None


def test_a_cut_off_record_is_reported_as_damaged_with_the_way_out():
    _cut_record()
    with pytest.raises(trust_store.TrustStoreLocked) as locked:
        trust_store.load()
    reason = str(locked.value)
    assert "damaged" in reason
    assert "pair" in reason
    assert trust_store.damaged() is True


def test_a_missing_record_is_not_called_damaged():
    trust_store.load()
    app.credential_vault.write_app_secret(trust_store.SECRET_NAME, None)
    trust_store._state = None
    with pytest.raises(trust_store.TrustStoreLocked) as locked:
        trust_store.load()
    assert "damaged" not in str(locked.value)
    assert trust_store.damaged() is False


def test_a_damaged_record_can_be_rebuilt_rather_than_staying_locked():
    _cut_record()
    with pytest.raises(trust_store.TrustStoreLocked):
        trust_store.load()
    trust_store.rebuild_locked_store()

    assert trust_store.damaged() is False
    assert trust_store.load()["pins"] == {}
    assert json.loads(app.credential_vault.read_app_secret(trust_store.SECRET_NAME))["pins"] == {}


def test_the_account_view_is_told_the_record_is_damaged():
    from tests.test_server_link_trust import _trust_link

    _cut_record()
    link = _trust_link()
    link._trust_locked = trust_store.locked_reason()

    assert link.network_snapshot()["trustDamaged"] is True
