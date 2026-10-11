"""The trust record in a sealed file, the Keychain keeping only its key
(plan 797ad7, B1–B3).

The record outgrew the one Keychain line it was written through, which capped
pairing at a handful of devices. It now lives in ``device-trust/`` as an
AES-GCM-sealed file; the Keychain item it used to be is still written while it
fits, so a build from before the move reads current pairings after a downgrade.
"""

from __future__ import annotations

import json

import pytest

from agent_team_backend import app, trust_file, trust_store

KEY = "A" * 43 + "="


def _device(index: int) -> str:
    return f"4a50baf4-5c26-4785-a792-{index:012x}"


def _pin(index: int) -> None:
    trust_store.pin_paired_device(_device(index), sign_key=KEY, enc_key="b" * 64,
                                  member_id=f"m-{index:032x}")


def _restart() -> None:
    with trust_store._lock:
        trust_store._state = None
        trust_store._store_mode = None
        trust_store._record_key = None
        trust_store._seen_pending.clear()
        trust_store._unsaved_blocks.clear()
        trust_store._forget_written()


def _marker() -> dict:
    return app.database.kv_get(trust_store.INITIALISED_KEY)


def _keychain_doc() -> dict | None:
    raw = app.credential_vault.read_app_secret(trust_store.SECRET_NAME)
    return json.loads(raw) if raw else None


def test_a_first_start_keeps_the_record_in_a_sealed_file():
    trust_store.load()
    _pin(1)
    path = trust_store._record_path()
    blob = path.read_bytes()
    assert blob.startswith(trust_file.MAGIC)
    assert _device(1).encode() not in blob
    assert _marker()["store"] == trust_store.STORE_FILE
    # Mirrored to the Keychain item while it fits, for a downgrade.
    assert _device(1) in _keychain_doc()["pins"]


def test_a_restart_reads_the_file_not_the_keychain_item():
    trust_store.load()
    _pin(1)
    app.credential_vault.write_app_secret(trust_store.SECRET_NAME, None)
    _restart()
    assert trust_store.pin_for(_device(1)) is not None


def test_a_record_from_before_the_move_is_moved_into_the_file():
    trust_store.load()
    _pin(1)
    # What an earlier build left: the Keychain item and a marker naming no store.
    path = trust_store._record_path()
    path.unlink()
    marker = dict(_marker())
    marker.pop("store")
    app.database.kv_set(trust_store.INITIALISED_KEY, marker, now=0)
    _restart()

    assert trust_store.pin_for(_device(1)) is not None
    assert path.exists()
    assert _marker()["store"] == trust_store.STORE_FILE


def test_the_file_has_no_line_to_outgrow():
    """Thirty pairings, where the Keychain item held seven."""
    trust_store.load()
    for index in range(30):
        _pin(index)
    for index in range(30):
        trust_store.note_blocked(_device(index), "")
    _restart()
    assert all(trust_store.pin_for(_device(index)) for index in range(30))
    assert trust_store.is_blocked_locally(device_id=_device(29), member_id="")


def test_a_mirror_that_no_longer_fits_stops_quietly():
    trust_store.load()
    for index in range(30):
        _pin(index)
    mirrored = _keychain_doc()
    # It stopped at the last record that fit, and nothing failed.
    assert 0 < len(mirrored["pins"]) < 30


@pytest.mark.parametrize("damage", ["tampered", "missing-file", "missing-key"])
def test_a_sealed_record_that_cannot_be_trusted_locks(damage):
    trust_store.load()
    _pin(1)
    path = trust_store._record_path()
    if damage == "tampered":
        blob = bytearray(path.read_bytes())
        blob[-1] ^= 1
        path.write_bytes(bytes(blob))
    elif damage == "missing-file":
        path.unlink()
    else:
        app.credential_vault.write_app_secret(trust_file.KEY_SECRET, None)
    _restart()
    assert trust_store.locked_reason()
    with pytest.raises(trust_store.TrustStoreLocked):
        trust_store.load()


def test_a_tampered_record_reads_as_damaged():
    trust_store.load()
    _pin(1)
    path = trust_store._record_path()
    blob = bytearray(path.read_bytes())
    blob[-1] ^= 1
    path.write_bytes(bytes(blob))
    _restart()
    trust_store.locked_reason()
    assert trust_store.damaged()


def test_starting_over_clears_the_file_too():
    trust_store.load()
    _pin(1)
    trust_store._record_path().write_bytes(b"garbage")
    _restart()
    trust_store.locked_reason()
    trust_store.rebuild_locked_store()
    assert not trust_store._record_path().exists()
    assert trust_store.pin_for(_device(1)) is None


@pytest.fixture
def record_writes_fail(monkeypatch):
    def refuse(_core):
        raise OSError("disk full")

    trust_store.load()
    monkeypatch.setattr(trust_store, "_write_record_locked", refuse)


def test_a_decision_the_file_would_not_take_is_rolled_back(record_writes_fail):
    """KC-1, for the file: memory never holds a decision the record does not."""
    with pytest.raises(OSError):
        _pin(1)
    assert trust_store.pin_for(_device(1)) is None


def test_a_block_the_file_would_not_take_still_holds(record_writes_fail):
    """Fail closed, for the file too."""
    with pytest.raises(OSError):
        trust_store.note_blocked("dev-z", "")
    assert trust_store.is_blocked_locally(device_id="dev-z", member_id="")


def test_notices_in_a_record_from_before_the_move_reach_the_journal():
    trust_store.load()
    _pin(1)
    legacy = dict(_keychain_doc())
    legacy["notices"] = [{"key": "remote-command:x:1", "kind": "remote-command", "deviceId": "d",
                          "at": 1791639602, "deviceName": "TKM5", "workspace": "w", "paneName": "p"}]
    legacy["seenMessages"] = {"old-key": 1791639602}
    app.credential_vault.write_app_secret(
        trust_store.SECRET_NAME, json.dumps(legacy, separators=(",", ":")))
    trust_store._record_path().unlink()
    marker = dict(_marker())
    marker.pop("store")
    app.database.kv_set(trust_store.INITIALISED_KEY, marker, now=0)
    _restart()

    assert "remote-command:x:1" in [n["key"] for n in trust_store.notices()]
    assert trust_store.has_seen_message("old-key")
    _restart()
    assert "remote-command:x:1" in [n["key"] for n in trust_store.notices()]
    assert trust_store.pin_for(_device(1)) is not None


def test_what_an_earlier_build_wrote_after_a_downgrade_is_kept_on_the_way_back():
    """B3: after a downgrade the earlier build keeps working on the Keychain
    item. Coming back, that item is newer than the file, and is taken."""
    trust_store.load()
    _pin(1)
    earlier = dict(_keychain_doc())
    earlier["pins"] = dict(earlier["pins"])
    earlier["pins"][_device(2)] = dict(earlier["pins"][_device(1)])
    earlier["blocked"] = [{"deviceId": _device(1), "memberId": ""}]
    app.credential_vault.write_app_secret(
        trust_store.SECRET_NAME, json.dumps(earlier, separators=(",", ":")))
    _restart()

    assert trust_store.pin_for(_device(2)) is not None
    assert trust_store.is_blocked_locally(device_id=_device(1), member_id="")
    # And it is in the file now, not only read from the item.
    app.credential_vault.write_app_secret(trust_store.SECRET_NAME, None)
    _restart()
    assert trust_store.pin_for(_device(2)) is not None


def test_a_copy_that_stopped_because_it_no_longer_fit_is_not_taken_back():
    trust_store.load()
    for index in range(30):
        _pin(index)
    _restart()
    assert all(trust_store.pin_for(_device(index)) for index in range(30))


def _legacy_record(cut_at_key: str, *, blocked: bool = True) -> str:
    """A Keychain record from before the move with three pairings, a block, an
    encrypted peer and a policy sequence, cut off by security -i inside the field
    *cut_at_key* — the way a write too long was stored — and the marker of a
    build from before the move."""
    trust_store.load()
    for index in range(3):
        _pin(index)
    if blocked:
        trust_store.note_blocked(_device(1), "")
    trust_store.note_encrypted_peer(_device(0))
    trust_store.reserve_policy_seq("dev-self")
    trust_store.note_remote_command(_device(0), device_name="TKM5", workspace="w", pane_name="p")
    doc = dict(_keychain_doc())
    doc["notices"] = [{"key": f"n-{i}", "kind": "remote-command", "deviceId": "d", "at": 1, "pad": "x" * 40}
                      for i in range(5)]
    whole = json.dumps(doc, separators=(",", ":"))
    cut_at = whole.index(f'"{cut_at_key}":') + len(cut_at_key) + 12
    app.credential_vault.write_app_secret(trust_store.SECRET_NAME, whole[:cut_at])
    trust_store._record_path().unlink()
    trust_store._journal_path().unlink(missing_ok=True)
    marker = dict(_marker())
    marker.pop("store")
    marker.pop("mirror", None)
    app.database.kv_set(trust_store.INITIALISED_KEY, marker, now=0)
    _restart()
    return whole[:cut_at]


@pytest.mark.parametrize("file_store", [True, False])
def test_a_record_cut_off_in_its_notices_keeps_every_decision(file_store, monkeypatch):
    """Q2, review F1: the cut usually lands in the notices at the end, after
    the blocks, encrypted peers and policy sequences were written whole. Those
    are kept — a block above all — and the pins go back to unapproved."""
    _legacy_record("notices")
    monkeypatch.setattr(trust_store, "FILE_STORE", file_store)
    assert trust_store.locked_reason() == ""
    assert trust_store.is_blocked_locally(device_id=_device(1), member_id="")
    assert trust_store.is_encrypted_peer(_device(0))
    assert trust_store.policy_seq("dev-self") == 1
    for index in range(3):
        pin = trust_store.pin_for(_device(index))
        assert pin is not None and pin["signKey"] == KEY and pin["approved"] is False
    salvaged = [n for n in trust_store.notices()
                if n["kind"] == trust_store.NOTICE_PAIRING and n.get("pairing") == "salvaged"]
    assert sorted(n["deviceId"] for n in salvaged) == sorted(_device(i) for i in range(3))


@pytest.mark.parametrize("cut_in", ["pins", "policySeqs", "blocked", "encryptedPeers"])
@pytest.mark.parametrize("file_store", [True, False])
def test_a_record_cut_off_in_a_decision_still_locks_like_main(cut_in, file_store, monkeypatch):
    """Review F1: kept pins without the blocks after them trusted a blocked
    device again. A cut anywhere in what decides trust locks as damaged, as
    main does — salvage is never looser than main."""
    _legacy_record(cut_in)
    monkeypatch.setattr(trust_store, "FILE_STORE", file_store)
    assert trust_store.locked_reason()
    assert trust_store.damaged()


def test_the_journal_is_sealed_with_the_record_key():
    """Q3: the ledger decides which messages are replays, so it is sealed too —
    a journal edited on disk is set aside, not believed."""
    trust_store.load()
    trust_store.note_remote_command(_device(1), device_name="TKM5", workspace="w", pane_name="p")
    trust_store.note_seen_message("k-sealed")
    trust_store.flush_seen_messages()
    blob = trust_store._journal_path().read_bytes()
    assert blob.startswith(trust_file.MAGIC)
    assert b"k-sealed" not in blob and b"TKM5" not in blob
    _restart()
    assert trust_store.has_seen_message("k-sealed")


def test_a_plaintext_journal_from_before_is_read_and_sealed_on_the_next_save():
    trust_store.load()
    _pin(1)
    trust_store._journal_path().write_text(
        '{"v":1,"notices":[],"seenMessages":{"old-key":%d}}' % int(__import__("time").time()),
        encoding="utf-8")
    _restart()
    assert trust_store.has_seen_message("old-key")
    trust_store.note_seen_message("new-key")
    trust_store.flush_seen_messages()
    assert trust_store._journal_path().read_bytes().startswith(trust_file.MAGIC)
    _restart()
    assert trust_store.has_seen_message("old-key") and trust_store.has_seen_message("new-key")


def test_a_sealed_journal_that_does_not_open_is_set_aside():
    trust_store.load()
    trust_store.note_seen_message("k-1")
    trust_store.flush_seen_messages()
    path = trust_store._journal_path()
    blob = bytearray(path.read_bytes())
    blob[-1] ^= 1
    path.write_bytes(bytes(blob))
    _restart()
    assert not trust_store.has_seen_message("k-1")
    assert "set aside" in trust_store.journal_problem()
    assert trust_store.locked_reason() == ""
