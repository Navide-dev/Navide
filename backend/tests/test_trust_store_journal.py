"""Notices and the delivered-message ledger live beside the trust record.

They are the fast-growing half of it (50 notices, 500 ledger keys), and with
them inside the Keychain item the record outgrew `security -i`'s line limit
after about fifteen remote commands. The Keychain keeps only what pairing trust
needs; the rest goes to an owner-only file in Navide's data dir.
"""

from __future__ import annotations

import json
import os
import stat
import sys
import time

import pytest

from agent_team_backend import app, trust_store

DEVICE = "4a50baf4-5c26-4785-a792-6fa9fd7387b0"


def _keychain_doc() -> dict:
    return json.loads(app.credential_vault.read_app_secret(trust_store.SECRET_NAME))


def _fill(notices: int, seen: int) -> None:
    for index in range(notices):
        trust_store.note_remote_command(f"{DEVICE}-{index}", device_name="TKM5",
                                        workspace="IDA", pane_name="IDA指揮")
    for index in range(seen):
        trust_store.note_seen_message(f"{DEVICE}:mcp:{index:016x}")
    trust_store.flush_seen_messages()


def test_a_record_at_both_caps_still_saves():
    trust_store.load()
    _fill(trust_store.MAX_NOTICES, trust_store.MAX_SEEN_MESSAGES)

    doc = _keychain_doc()
    assert "notices" not in doc and "seenMessages" not in doc
    trust_store._state = None
    assert len(trust_store.notices()) == trust_store.MAX_NOTICES
    assert trust_store.has_seen_message(f"{DEVICE}:mcp:{0:016x}")


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX permission bits")
def test_the_journal_is_owner_only():
    trust_store.load()
    _fill(1, 1)
    mode = stat.S_IMODE(os.stat(trust_store._journal_path()).st_mode)
    assert mode == 0o600


def test_a_legacy_record_is_read_and_migrated_on_the_next_save():
    trust_store.load()
    legacy = dict(_keychain_doc())
    legacy["notices"] = [{"key": "remote-command:x:1", "kind": "remote-command",
                          "deviceId": DEVICE, "at": 1791639602, "deviceName": "TKM5",
                          "workspace": "IDA", "paneName": "IDA指揮"}]
    legacy["seenMessages"] = {"old-key": int(time.time())}
    app.credential_vault.write_app_secret(
        trust_store.SECRET_NAME, json.dumps(legacy, ensure_ascii=False, separators=(",", ":")))
    trust_store._state = None

    assert [n["key"] for n in trust_store.notices()] == ["remote-command:x:1"]
    assert trust_store.has_seen_message("old-key")

    trust_store.note_pairing(DEVICE, kind="paired", device_name="TKM5")
    doc = _keychain_doc()
    assert "notices" not in doc and "seenMessages" not in doc
    trust_store._state = None
    assert len(trust_store.notices()) == 2
    assert trust_store.has_seen_message("old-key")


def test_an_unreadable_journal_costs_the_notices_not_the_pairings(caplog):
    trust_store.load()
    _fill(2, 0)
    trust_store._journal_path().write_text("{not json", encoding="utf-8")
    trust_store._state = None

    assert trust_store.notices() == []
    assert trust_store.locked_reason() == ""
    assert "journal" in caplog.text


def test_a_rebuild_clears_the_journal_too():
    trust_store.load()
    _fill(2, 0)
    app.credential_vault.write_app_secret(trust_store.SECRET_NAME, "{")
    trust_store._state = None
    trust_store.rebuild_locked_store()

    assert not trust_store._journal_path().exists()
    assert trust_store.notices() == []


def test_a_first_start_keeps_an_existing_journal():
    """Review KC-10: with no marker and no readable record, initialising wrote
    _blank() and replaced the journal it never read."""
    from agent_team_backend.trust_store import INITIALISED_KEY

    trust_store.load()
    _fill(2, 1)
    app.credential_vault.write_app_secret(trust_store.SECRET_NAME, "{")
    app.database.kv_set(INITIALISED_KEY, None, now=0)
    trust_store._state = None
    trust_store._forget_written()

    trust_store.load()
    assert len(trust_store.notices()) == 2
    assert trust_store.has_seen_message(f"{DEVICE}:mcp:{0:016x}")
