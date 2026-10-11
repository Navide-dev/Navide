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


def _cut_after_pins(complete: int) -> str:
    """A Keychain record from before the move, cut off by security -i inside the
    pin after *complete* whole ones — the way a write too long was stored."""
    trust_store.load()
    for index in range(complete + 1):
        _pin(index)
    whole = json.dumps(_keychain_doc(), separators=(",", ":"))
    cut_at = whole.index(f'"{_device(complete)}"') + 20
    app.credential_vault.write_app_secret(trust_store.SECRET_NAME, whole[:cut_at])
    trust_store._record_path().unlink()
    marker = dict(_marker())
    marker.pop("store")
    marker.pop("mirror", None)
    app.database.kv_set(trust_store.INITIALISED_KEY, marker, now=0)
    _restart()
    return whole[:cut_at]


def test_whole_pins_in_a_cut_off_record_are_salvaged_unapproved():
    """Q2: a record cut off mid-write keeps the pins that were written whole.
    They pin the key — nobody can swap it — but go back to the default-deny
    rules until a person approves them again."""
    _cut_after_pins(3)
    assert trust_store.locked_reason() == ""
    for index in range(3):
        pin = trust_store.pin_for(_device(index))
        assert pin is not None and pin["signKey"] == KEY and pin["approved"] is False
    assert trust_store.pin_for(_device(3)) is None
    salvaged = [n for n in trust_store.notices()
                if n["kind"] == trust_store.NOTICE_PAIRING and n.get("pairing") == "salvaged"]
    assert sorted(n["deviceId"] for n in salvaged) == sorted(_device(i) for i in range(3))
    assert trust_store._record_path().exists()
    _restart()
    assert trust_store.pin_for(_device(0))["approved"] is False


def test_a_record_cut_off_before_any_whole_pin_still_locks():
    _cut_after_pins(0)
    assert trust_store.locked_reason()
    assert trust_store.damaged()
