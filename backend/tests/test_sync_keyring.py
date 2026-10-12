"""The account key ring: versioned record envelopes, key ids, and rotation.

The first version stored one bare key and wrote records that named no key at
all. Both are still read here — a record written last month has to open — and
what is asserted is the shape that replaced them: every new record names the
key it is under, rotating mints a new one without orphaning the old, and a
ring from a peer is adopted only when it is a later generation of the same
lineage. Everything below runs against the per-test in-memory vault; no
Keychain, no real key material.
"""

from __future__ import annotations

import base64
import json
import os

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from agent_team_backend import app, device_crypto, sync_keyring


def _stored() -> str:
    """The bound account's ring, as the vault holds it."""
    return app.credential_vault.read_app_secret(sync_keyring._secret_name()) or ""


def _v1_body(raw_key: bytes, plaintext: str, *, scope: str, item_id: str) -> str:
    """A record exactly as the previous build wrote it: nonce ‖ ciphertext,
    with the v1 associated data and no key id anywhere."""
    nonce = os.urandom(12)
    aad = b"\x00".join((b"navide/sync/v1", scope.encode(), item_id.encode()))
    return base64.b64encode(nonce + AESGCM(raw_key).encrypt(nonce, plaintext.encode(), aad)).decode()


def _write_legacy(raw: bytes) -> None:
    """The vault as the previous build left it: one bare base64 key, bound to
    no account."""
    app.credential_vault.write_app_secret(
        sync_keyring.ACCOUNT_KEY_SECRET, base64.b64encode(raw).decode()
    )
    sync_keyring._reset_for_test()


@pytest.fixture
def legacy_key() -> bytes:
    """That key, adopted by the bound account — the migration path."""
    raw = b"\x07" * 32
    _write_legacy(raw)
    assert sync_keyring.legacy_ring_pending() is True
    sync_keyring.adopt_legacy_ring()
    yield raw
    sync_keyring.forget_account_key()


@pytest.fixture
def fresh_ring() -> bytes:
    raw = sync_keyring.ensure_account_key()
    yield raw
    sync_keyring.forget_account_key()


# ---- reading what the previous build left ----------------------------------------


def test_a_bare_legacy_key_reads_as_a_generation_zero_ring(legacy_key) -> None:
    assert sync_keyring.account_key() == legacy_key
    ring = sync_keyring.ring()
    assert ring["gen"] == 0
    assert ring["active"] == sync_keyring.key_id(legacy_key)
    assert ring["keys"] == {sync_keyring.key_id(legacy_key): legacy_key}


def test_a_record_the_previous_build_wrote_still_opens(legacy_key) -> None:
    wire = _v1_body(legacy_key, '{"a":1}', scope="prompts", item_id="p1")
    assert sync_keyring.decrypt(wire, scope="prompts", item_id="p1") == '{"a":1}'
    # And it is one a re-push would rewrite: it names no key.
    assert sync_keyring.needs_reseal(wire) is True


def test_a_legacy_record_is_still_bound_to_its_scope_and_item(legacy_key) -> None:
    wire = _v1_body(legacy_key, '{"a":1}', scope="prompts", item_id="p1")
    with pytest.raises(sync_keyring.KeyringError):
        sync_keyring.decrypt(wire, scope="prompts", item_id="p2")


def test_the_key_id_is_the_same_on_every_machine() -> None:
    """Derived from the material, never assigned: two devices that hold the
    same key must name it identically without ever exchanging the name."""
    raw = b"\x11" * 32
    assert sync_keyring.key_id(raw) == sync_keyring.key_id(bytes(raw))
    assert len(sync_keyring.key_id(raw)) == 16
    assert sync_keyring.key_id(raw) != sync_keyring.key_id(b"\x12" * 32)


# ---- the versioned envelope --------------------------------------------------------


def test_a_new_record_names_the_key_it_is_under(fresh_ring) -> None:
    wire = sync_keyring.encrypt('{"a":1}', scope="prompts", item_id="p1")
    raw = base64.b64decode(wire)
    assert raw[:1] == b"\x02"
    assert raw[1:9].hex() == sync_keyring.active_key_id()
    assert sync_keyring.decrypt(wire, scope="prompts", item_id="p1") == '{"a":1}'
    assert sync_keyring.needs_reseal(wire) is False


def test_old_and_new_envelopes_coexist_under_one_key(fresh_ring) -> None:
    """The migration is nothing: a device reads whichever shape a record has."""
    old = _v1_body(fresh_ring, '{"v":1}', scope="mcp", item_id="m1")
    new = sync_keyring.encrypt('{"v":2}', scope="mcp", item_id="m2")
    assert sync_keyring.decrypt(old, scope="mcp", item_id="m1") == '{"v":1}'
    assert sync_keyring.decrypt(new, scope="mcp", item_id="m2") == '{"v":2}'


def test_a_relabelled_body_does_not_open_under_another_held_key(fresh_ring) -> None:
    """The id selects the key, so a body relabelled to a key this machine also
    holds is tried under the wrong key and fails — it must not fall through to
    "try everything" and open under the right one, which would make the label
    meaningless for a re-push that reads it."""
    old = sync_keyring.encrypt('{"a":1}', scope="prompts", item_id="p1")
    new_kid = sync_keyring.rotate_account_key()
    raw = bytearray(base64.b64decode(old))
    raw[1:9] = bytes.fromhex(new_kid)
    with pytest.raises(sync_keyring.KeyringError):
        sync_keyring.decrypt(base64.b64encode(bytes(raw)).decode(), scope="prompts", item_id="p1")


def test_a_record_under_a_key_this_machine_lacks_says_so(fresh_ring) -> None:
    """A distinct error, because the fix is different: it opens once a paired
    device hands over the newer ring, whereas a tampered body never will."""
    elsewhere = b"\x33" * 32
    kid = sync_keyring.key_id(elsewhere)
    nonce = os.urandom(12)
    aad = b"\x00".join((b"navide/sync/v2", kid.encode(), b"prompts", b"p1"))
    body = b"\x02" + bytes.fromhex(kid) + nonce + AESGCM(elsewhere).encrypt(nonce, b"{}", aad)
    with pytest.raises(sync_keyring.UnknownKeyId):
        sync_keyring.decrypt(base64.b64encode(body).decode(), scope="prompts", item_id="p1")


def test_a_legacy_body_that_happens_to_start_with_the_marker_still_opens(fresh_ring) -> None:
    """A v1 nonce is random and can begin with 0x02; the byte alone must not
    decide the reading."""
    for _ in range(200):
        wire = _v1_body(fresh_ring, "x", scope="s", item_id="i")
        raw = bytearray(base64.b64decode(wire))
        if raw[0] == 2:
            break
    else:
        nonce = b"\x02" + os.urandom(11)
        aad = b"\x00".join((b"navide/sync/v1", b"s", b"i"))
        raw = bytearray(nonce + AESGCM(fresh_ring).encrypt(nonce, b"x", aad))
    assert sync_keyring.decrypt(base64.b64encode(bytes(raw)).decode(), scope="s", item_id="i") == "x"


# ---- rotation ----------------------------------------------------------------------


def test_rotating_keeps_the_old_key_for_reading(fresh_ring) -> None:
    before = sync_keyring.encrypt('{"old":1}', scope="prompts", item_id="p1")
    old_kid = sync_keyring.active_key_id()

    new_kid = sync_keyring.rotate_account_key()

    assert new_kid != old_kid
    assert sync_keyring.active_key_id() == new_kid
    assert sync_keyring.ring()["gen"] == 1
    assert set(sync_keyring.ring()["keys"]) == {old_kid, new_kid}
    # Last month's record still opens; the new one is under the new key.
    assert sync_keyring.decrypt(before, scope="prompts", item_id="p1") == '{"old":1}'
    after = sync_keyring.encrypt('{"new":1}', scope="prompts", item_id="p1")
    assert base64.b64decode(after)[1:9].hex() == new_kid


def test_a_rotation_stops_writing_under_the_leaked_key(fresh_ring) -> None:
    leaked = sync_keyring.account_key()
    sync_keyring.rotate_account_key()
    wire = sync_keyring.encrypt("secret", scope="credentials", item_id="c1")
    raw = base64.b64decode(wire)
    kid = raw[1:9].hex()
    aad = b"\x00".join((b"navide/sync/v2", kid.encode(), b"credentials", b"c1"))
    with pytest.raises(Exception):
        AESGCM(leaked).decrypt(raw[9:21], raw[21:], aad)


def test_resealing_moves_a_record_under_the_active_key(fresh_ring) -> None:
    """What a post-rotation re-push does per record."""
    old = sync_keyring.encrypt('{"a":1}', scope="prompts", item_id="p1")
    sync_keyring.rotate_account_key()
    assert sync_keyring.needs_reseal(old) is True

    moved = sync_keyring.resealed(old, scope="prompts", item_id="p1")

    assert sync_keyring.needs_reseal(moved) is False
    assert base64.b64decode(moved)[1:9].hex() == sync_keyring.active_key_id()
    assert sync_keyring.decrypt(moved, scope="prompts", item_id="p1") == '{"a":1}'


def test_rotating_with_no_key_is_refused() -> None:
    sync_keyring.forget_account_key()
    with pytest.raises(sync_keyring.KeyringError):
        sync_keyring.rotate_account_key()


def test_the_ring_is_stored_on_one_line_and_names_its_keys_honestly(fresh_ring) -> None:
    """The vault truncates at a newline, and a ring whose ids do not match its
    keys is one nobody else would agree with — both refused up front."""
    sync_keyring.rotate_account_key()
    stored = _stored()
    assert "\n" not in stored
    doc = json.loads(stored)
    assert doc["v"] == sync_keyring.RING_VERSION and doc["gen"] == 1
    for kid, value in doc["keys"].items():
        assert sync_keyring.key_id(base64.b64decode(value)) == kid

    doc["keys"] = {"00" * 8: next(iter(doc["keys"].values()))}
    doc["active"] = "00" * 8
    app.credential_vault.write_app_secret(sync_keyring._secret_name(), json.dumps(doc))
    sync_keyring._reset_for_test()
    with pytest.raises(sync_keyring.KeyringError):
        sync_keyring.account_key()


# ---- handing the ring to another device ------------------------------------------


def _offered(ring_doc: dict, monkeypatch) -> None:
    """Make the next ``accept_wrapped`` open to *ring_doc*, as if a peer had
    sealed it for us. The seal itself is exercised by the round-trip test."""
    monkeypatch.setattr(
        device_crypto, "open_sealed", lambda *a, **k: json.dumps(ring_doc)
    )


def _doc(gen: int, active: bytes, *retired: bytes) -> dict:
    keys = {sync_keyring.key_id(k): base64.b64encode(k).decode() for k in (active, *retired)}
    return {
        "v": sync_keyring.RING_VERSION,
        "gen": gen,
        "active": sync_keyring.key_id(active),
        "keys": keys,
    }


def test_the_whole_ring_travels_and_opens_on_the_other_device(fresh_ring) -> None:
    """A real seal to this device's own key, then adopted on a machine with
    nothing: the shape the offer path sends is the shape the adopt path reads."""
    sync_keyring.rotate_account_key()
    expected = sync_keyring.ring()
    wire = sync_keyring.wrap_for(
        recipient_public_key=device_crypto.public_key(), from_device="dev-a", to_device="dev-b"
    )
    sync_keyring.forget_account_key()

    adopted = sync_keyring.accept_wrapped(wire, from_device="dev-a", to_device="dev-b")

    assert adopted == expected["keys"][expected["active"]]
    assert sync_keyring.ring() == expected


def test_a_bare_key_from_the_previous_build_is_still_adopted(monkeypatch) -> None:
    sync_keyring.forget_account_key()
    raw = b"\x44" * 32
    monkeypatch.setattr(
        device_crypto, "open_sealed", lambda *a, **k: base64.b64encode(raw).decode()
    )
    assert sync_keyring.accept_wrapped("x", from_device="dev-a", to_device="dev-b") == raw
    assert sync_keyring.ring()["gen"] == 0
    sync_keyring.forget_account_key()


def test_a_later_generation_of_the_same_lineage_is_adopted(fresh_ring, monkeypatch) -> None:
    """The other device rotated while this one held the original: it takes the
    new active key and keeps reading under the old one."""
    original = fresh_ring
    rotated = b"\x55" * 32
    _offered(_doc(1, rotated, original), monkeypatch)

    assert sync_keyring.accept_wrapped("x", from_device="dev-a", to_device="dev-b") == rotated

    ring = sync_keyring.ring()
    assert ring["gen"] == 1 and ring["active"] == sync_keyring.key_id(rotated)
    assert set(ring["keys"].values()) == {original, rotated}


def test_an_earlier_generation_changes_nothing(fresh_ring, monkeypatch) -> None:
    """A peer that has not caught up yet re-offers what this machine already
    moved past. Nothing goes backwards."""
    original = fresh_ring
    new_kid = sync_keyring.rotate_account_key()
    _offered(_doc(0, original), monkeypatch)

    sync_keyring.accept_wrapped("x", from_device="dev-a", to_device="dev-b")

    assert sync_keyring.active_key_id() == new_kid
    assert sync_keyring.ring()["gen"] == 1


def test_an_unrelated_ring_is_refused_not_adopted(fresh_ring, monkeypatch) -> None:
    """No key in common means a second account key, whichever generation it
    claims: adopting it would orphan everything written under this one."""
    _offered(_doc(5, b"\x66" * 32, b"\x67" * 32), monkeypatch)
    with pytest.raises(sync_keyring.KeyConflict):
        sync_keyring.accept_wrapped("x", from_device="dev-a", to_device="dev-b")
    assert sync_keyring.account_key() == fresh_ring


def test_two_rings_rotated_apart_are_refused(fresh_ring, monkeypatch) -> None:
    """Same lineage, same generation, different active key: both devices rotated
    while they could not talk. Picking one silently would leave the other
    writing under a key this machine has just stopped using."""
    original = fresh_ring
    mine = sync_keyring.rotate_account_key()
    _offered(_doc(1, b"\x77" * 32, original), monkeypatch)
    with pytest.raises(sync_keyring.KeyConflict):
        sync_keyring.accept_wrapped("x", from_device="dev-a", to_device="dev-b")
    assert sync_keyring.active_key_id() == mine


def test_the_same_ring_offered_again_is_ordinary(fresh_ring, monkeypatch) -> None:
    sync_keyring.rotate_account_key()
    ring = sync_keyring.ring()
    _offered(
        {
            "v": sync_keyring.RING_VERSION,
            "gen": ring["gen"],
            "active": ring["active"],
            "keys": {k: base64.b64encode(v).decode() for k, v in ring["keys"].items()},
        },
        monkeypatch,
    )
    assert sync_keyring.accept_wrapped("x", from_device="dev-a", to_device="dev-b") == (
        ring["keys"][ring["active"]]
    )
    assert sync_keyring.ring() == ring


def test_a_malformed_ring_is_refused(fresh_ring, monkeypatch) -> None:
    _offered({"v": 2, "gen": 0, "active": "nope", "keys": {}}, monkeypatch)
    with pytest.raises(sync_keyring.KeyringError):
        sync_keyring.accept_wrapped("x", from_device="dev-a", to_device="dev-b")


# ---- one ring per account ------------------------------------------------------------


def test_nothing_answers_until_an_account_is_bound() -> None:
    sync_keyring.unbind()
    try:
        assert sync_keyring.bound_namespace() is None
        assert sync_keyring.has_account_key() is False
        with pytest.raises(sync_keyring.KeyringError):
            sync_keyring.ensure_account_key()
        with pytest.raises(sync_keyring.KeyringError):
            sync_keyring.encrypt("{}", scope="prompts", item_id="p1")
        with pytest.raises(sync_keyring.KeyringError):
            sync_keyring.bind("")
    finally:
        sync_keyring._reset_for_test()


def test_signing_out_and_back_in_to_the_same_account_finds_the_same_ring() -> None:
    """The sole device of an account holds the only copy of its key. Unbinding
    is what a sign-out does; the ring is still there for the next sign-in."""
    sync_keyring.bind("acct-a")
    raw = sync_keyring.ensure_account_key()
    wire = sync_keyring.encrypt('{"a":1}', scope="prompts", item_id="p1")

    sync_keyring.unbind()
    assert sync_keyring.has_account_key() is False
    sync_keyring.bind("acct-a")

    assert sync_keyring.account_key() == raw
    assert sync_keyring.decrypt(wire, scope="prompts", item_id="p1") == '{"a":1}'
    sync_keyring.forget_account_key()


def test_a_different_account_cannot_read_or_write_under_the_first_ones_key() -> None:
    sync_keyring.bind("acct-a")
    a_key = sync_keyring.ensure_account_key()
    wire = sync_keyring.encrypt('{"a":1}', scope="prompts", item_id="p1")

    sync_keyring.bind("acct-b")
    assert sync_keyring.has_account_key() is False
    with pytest.raises(sync_keyring.KeyringError):
        sync_keyring.decrypt(wire, scope="prompts", item_id="p1")
    b_key = sync_keyring.ensure_account_key()
    assert b_key != a_key
    with pytest.raises(sync_keyring.KeyringError):
        sync_keyring.decrypt(wire, scope="prompts", item_id="p1")
    sync_keyring.forget_account_key()

    sync_keyring.bind("acct-a")
    assert sync_keyring.account_key() == a_key
    sync_keyring.forget_account_key()


def test_the_namespace_follows_the_server_and_the_member_not_the_token() -> None:
    same = sync_keyring.namespace_for("wss://s.example/ws", "m1")
    assert same == sync_keyring.namespace_for("wss://s.example/ws", "m1")
    assert same != sync_keyring.namespace_for("wss://other.example/ws", "m1")
    assert same != sync_keyring.namespace_for("wss://s.example/ws", "m2")
    assert len(same) == 32


def test_an_older_unbound_key_is_not_attributed_by_binding_alone() -> None:
    """It waits, and the account cannot mint over it: a fresh key would leave
    everything the old one wrote unreadable, and quietly."""
    _write_legacy(b"\x08" * 32)
    try:
        assert sync_keyring.has_account_key() is False
        assert sync_keyring.legacy_ring_pending() is True
        with pytest.raises(sync_keyring.KeyringError):
            sync_keyring.ensure_account_key()
        assert app.credential_vault.read_app_secret(sync_keyring.ACCOUNT_KEY_SECRET)
    finally:
        app.credential_vault.write_app_secret(sync_keyring.ACCOUNT_KEY_SECRET, None)
        sync_keyring._reset_for_test()


def test_adopting_the_older_key_moves_it_under_the_account_once() -> None:
    raw = b"\x09" * 32
    _write_legacy(raw)
    assert sync_keyring.adopt_legacy_ring() == raw
    assert sync_keyring.account_key() == raw
    assert sync_keyring.legacy_ring_pending() is False
    assert app.credential_vault.read_app_secret(sync_keyring.ACCOUNT_KEY_SECRET) is None
    # A second account binding later finds nothing to adopt, and nothing merges
    # into an account that already has a ring.
    sync_keyring.bind("acct-other")
    assert sync_keyring.legacy_ring_pending() is False
    with pytest.raises(sync_keyring.KeyringError):
        sync_keyring.adopt_legacy_ring()
    sync_keyring._reset_for_test()
    sync_keyring.forget_account_key()


# ---- lineage convergence and concurrency -----------------------------------------------


def test_the_same_generation_and_active_key_still_adds_the_keys_it_lacks(fresh_ring, monkeypatch) -> None:
    """A ring that agrees with ours about where it is may still carry a key we
    never saw; without taking it, records written under that key stay shut."""
    original = fresh_ring
    extra = b"\x88" * 32
    doc = _doc(0, original, extra)
    _offered(doc, monkeypatch)

    sync_keyring.accept_wrapped("x", from_device="dev-a", to_device="dev-b")

    ring = sync_keyring.ring()
    assert ring["gen"] == 0 and ring["active"] == sync_keyring.key_id(original)
    assert set(ring["keys"].values()) == {original, extra}


def test_two_devices_that_forked_at_different_generations_converge(monkeypatch) -> None:
    """A rotated once (KA); B, cut off, rotated twice (KB, KB2). A adopts B's
    ring and keeps KA. When B then sees A's ring — same generation and active
    as its own now — it takes KA too, so both can open everything either
    wrote. The first version of the merge ignored a ring that agreed on
    generation and active key, and B never learned KA.
    """
    k0, ka, kb, kb2 = b"\x10" * 32, b"\x1a" * 32, b"\x1b" * 32, b"\x1c" * 32

    # A: gen 1, active KA.
    sync_keyring.bind("device-a")
    sync_keyring._store_ring({"v": 2, "gen": 1, "active": sync_keyring.key_id(ka), "keys": {
        sync_keyring.key_id(k0): k0, sync_keyring.key_id(ka): ka}})
    _offered(_doc(2, kb2, k0, kb), monkeypatch)
    sync_keyring.accept_wrapped("x", from_device="dev-b", to_device="dev-a")
    a = sync_keyring.ring()
    assert a["gen"] == 2 and a["active"] == sync_keyring.key_id(kb2)
    assert set(a["keys"].values()) == {k0, ka, kb, kb2}

    # B: gen 2, active KB2, never saw KA — receives A's merged ring.
    sync_keyring.bind("device-b")
    sync_keyring._store_ring({"v": 2, "gen": 2, "active": sync_keyring.key_id(kb2), "keys": {
        sync_keyring.key_id(k0): k0, sync_keyring.key_id(kb): kb, sync_keyring.key_id(kb2): kb2}})
    _offered(
        {"v": 2, "gen": a["gen"], "active": a["active"],
         "keys": {k: base64.b64encode(v).decode() for k, v in a["keys"].items()}},
        monkeypatch,
    )
    sync_keyring.accept_wrapped("x", from_device="dev-a", to_device="dev-b")
    b = sync_keyring.ring()
    assert b["gen"] == 2 and b["active"] == sync_keyring.key_id(kb2)
    assert set(b["keys"].values()) == {k0, ka, kb, kb2}

    sync_keyring.forget_account_key()
    sync_keyring.bind("device-a")
    sync_keyring.forget_account_key()
    sync_keyring._reset_for_test()


def test_a_rotate_and_an_adopt_racing_lose_neither_update(fresh_ring, monkeypatch) -> None:
    """Both run off the loop in worker threads and both are read-modify-write
    on the same ring. Released together, with the read slowed so both would
    read the same starting ring if nothing serialised them: whichever order
    they land in, the ring afterwards holds every key either of them added."""
    import threading
    import time

    original = fresh_ring
    theirs = b"\x99" * 32
    _offered(_doc(5, theirs, original), monkeypatch)
    vault = app.credential_vault
    real_read = vault.read_app_secret

    def slow_read(name):
        value = real_read(name)
        time.sleep(0.05)
        return value

    monkeypatch.setattr(vault, "read_app_secret", slow_read)
    gate = threading.Barrier(2)
    errors: list[BaseException] = []

    def rotate():
        gate.wait()
        try:
            sync_keyring._remember(None)
            sync_keyring.rotate_account_key()
        except BaseException as err:  # noqa: BLE001
            errors.append(err)

    def adopt():
        gate.wait()
        try:
            sync_keyring._remember(None)
            sync_keyring.accept_wrapped("x", from_device="dev-a", to_device="dev-b")
        except BaseException as err:  # noqa: BLE001
            errors.append(err)

    threads = [threading.Thread(target=rotate), threading.Thread(target=adopt)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(5)

    assert errors == []
    sync_keyring._remember(None)
    ring = sync_keyring.ring()
    held = set(ring["keys"].values())
    assert original in held and theirs in held
    assert len(held) == 3, "the rotated key or the adopted one was overwritten"
    assert ring["gen"] >= 5


def test_a_load_in_flight_cannot_be_cached_under_the_account_bound_afterwards(fresh_ring, monkeypatch) -> None:
    """A read begun for account A must not finish after a bind to B and be
    remembered as B's. bind waits for the read; the read stays A's."""
    import threading

    a_key = fresh_ring
    vault = app.credential_vault
    real_read = vault.read_app_secret
    entered = threading.Event()
    release = threading.Event()

    def blocking_read(name):
        entered.set()
        assert release.wait(5)
        return real_read(name)

    monkeypatch.setattr(vault, "read_app_secret", blocking_read)
    sync_keyring._remember(None)
    seen: list = []
    reader = threading.Thread(target=lambda: seen.append(sync_keyring.account_key()))
    reader.start()
    assert entered.wait(5)
    binder = threading.Thread(target=lambda: sync_keyring.bind("acct-b"))
    binder.start()
    binder.join(0.2)
    assert binder.is_alive(), "bind went ahead while a read for the other account was in flight"
    release.set()
    reader.join(5)
    binder.join(5)

    assert seen == [a_key]
    assert sync_keyring.bound_namespace() == "acct-b"
    monkeypatch.setattr(vault, "read_app_secret", real_read)
    assert sync_keyring.has_account_key() is False, "A's ring was cached as B's"
    sync_keyring._reset_for_test()
    sync_keyring.forget_account_key()


def test_an_offer_being_opened_for_one_account_cannot_land_in_another(fresh_ring, monkeypatch) -> None:
    """The open runs off the loop. Pausing it, binding another account, and
    letting it finish must leave the offered ring with the account it was
    opened for — bind waits — and never in the empty ring of the new one."""
    import threading

    sync_keyring.forget_account_key()
    sync_keyring.bind("acct-a")
    theirs = b"\xa1" * 32
    doc = _doc(0, theirs)
    entered = threading.Event()
    release = threading.Event()

    def paused_open(*a, **k):
        entered.set()
        assert release.wait(5)
        return json.dumps(doc)

    monkeypatch.setattr(device_crypto, "open_sealed", paused_open)
    accepter = threading.Thread(
        target=lambda: sync_keyring.accept_wrapped(
            "x", from_device="dev-p", to_device="dev-a", namespace="acct-a"
        )
    )
    accepter.start()
    assert entered.wait(5)
    binder = threading.Thread(target=lambda: sync_keyring.bind("acct-b"))
    binder.start()
    binder.join(0.2)
    assert binder.is_alive(), "bind went ahead while an offer was being opened"
    release.set()
    accepter.join(5)
    binder.join(5)

    assert sync_keyring.bound_namespace() == "acct-b"
    assert sync_keyring.has_account_key() is False, "A's offer landed in B"
    sync_keyring.bind("acct-a")
    assert sync_keyring.account_key() == theirs
    sync_keyring.forget_account_key()
    sync_keyring._reset_for_test()


def test_an_offer_dispatched_for_one_account_is_refused_once_another_is_bound(monkeypatch) -> None:
    """The other order: the worker only starts after the sign-out and the new
    sign-in. It names the account it was dispatched for, and is refused."""
    sync_keyring.bind("acct-b")
    _offered(_doc(0, b"\xa2" * 32), monkeypatch)
    with pytest.raises(sync_keyring.KeyringError):
        sync_keyring.accept_wrapped("x", from_device="dev-p", to_device="dev-a", namespace="acct-a")
    assert sync_keyring.has_account_key() is False
    with pytest.raises(sync_keyring.KeyringError):
        sync_keyring.wrap_for(
            recipient_public_key=device_crypto.public_key(), from_device="a", to_device="b",
            namespace="acct-a",
        )
    sync_keyring._reset_for_test()


# ---- auxiliary data (share-link keys and metadata) --------------------------------


def test_aux_data_round_trips_under_its_label(fresh_ring) -> None:
    secret = os.urandom(32)
    wire = sync_keyring.wrap_aux("link:abc:v1", secret)
    assert secret not in base64.b64decode(wire)
    assert sync_keyring.unwrap_aux("link:abc:v1", wire) == secret


def test_aux_data_does_not_open_under_another_label(fresh_ring) -> None:
    wire = sync_keyring.wrap_aux("link:abc:v1", b"k" * 32)
    with pytest.raises(sync_keyring.KeyringError):
        sync_keyring.unwrap_aux("link:abc:v2", wire)


def test_aux_data_does_not_open_with_another_accounts_key(fresh_ring) -> None:
    wire = sync_keyring.wrap_aux("link:abc:v1", b"k" * 32)
    sync_keyring.forget_account_key()
    sync_keyring.ensure_account_key()  # an unrelated key
    with pytest.raises(sync_keyring.KeyringError):
        sync_keyring.unwrap_aux("link:abc:v1", wire)


def test_aux_data_is_not_a_sync_record(fresh_ring) -> None:
    """Same key, different envelope: neither side opens as the other."""
    wire = sync_keyring.wrap_aux("prompts", b"body")
    with pytest.raises(sync_keyring.KeyringError):
        sync_keyring.decrypt(wire, scope="prompts", item_id="")
    record = sync_keyring.encrypt("body", scope="link:abc:v1", item_id="")
    with pytest.raises(sync_keyring.KeyringError):
        sync_keyring.unwrap_aux("link:abc:v1", record)


def test_aux_data_still_opens_after_rotation(fresh_ring) -> None:
    wire = sync_keyring.wrap_aux("link:abc:v1", b"k" * 32)
    sync_keyring.rotate_account_key()
    assert sync_keyring.unwrap_aux("link:abc:v1", wire) == b"k" * 32


def test_aux_data_without_a_key_is_a_clear_error() -> None:
    assert sync_keyring.has_account_key() is False
    with pytest.raises(sync_keyring.KeyringError, match="no sync key"):
        sync_keyring.wrap_aux("link:abc:v1", b"k")


def test_aux_data_names_itself_when_its_key_is_missing(fresh_ring) -> None:
    wire = sync_keyring.wrap_aux("link:abc:v1", b"k" * 32)
    raw = base64.b64decode(wire)
    forged = base64.b64encode(raw[:1] + b"\xff" * 8 + raw[9:]).decode()
    with pytest.raises(sync_keyring.UnknownKeyId) as err:
        sync_keyring.unwrap_aux("link:abc:v1", forged)
    assert "blob" not in str(err.value)
