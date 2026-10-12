"""D3: item ids the server cannot read a name out of.

``h1.`` + HMAC-SHA256(K, scope ‖ 0x00 ‖ name), K derived from the ring key the
account fixed when it adopted hashed ids (``itemIdKid``). That key must stay
in every ring for good — a ring that lost it would name every item afresh —
and has to reach a newly paired device with the rest of the ring.
"""

from __future__ import annotations

import hashlib
import hmac

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from agent_team_backend import device_crypto, sync_keyring


@pytest.fixture
def fresh_ring() -> bytes:
    raw = sync_keyring.ensure_account_key()
    yield raw
    sync_keyring.forget_account_key()


def test_the_id_follows_the_contract(fresh_ring) -> None:
    kid = sync_keyring.active_key_id()
    k = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=b"navide/item-id/v1").derive(fresh_ring)
    expected = "h1." + hmac.new(k, b"mcp\x00github", hashlib.sha256).hexdigest()
    assert sync_keyring.hashed_item_id("mcp", "github", kid) == expected


def test_the_id_names_neither_the_item_nor_its_scope(fresh_ring) -> None:
    kid = sync_keyring.active_key_id()
    a = sync_keyring.hashed_item_id("prompts", "deploy-checklist", kid)
    assert "deploy" not in a and "prompts" not in a
    assert sync_keyring.is_hashed_item_id(a)
    assert not sync_keyring.is_hashed_item_id("deploy-checklist")
    # Scope is part of the input.
    assert a != sync_keyring.hashed_item_id("mcp", "deploy-checklist", kid)


def test_a_rotation_keeps_the_id_key_and_the_ids(fresh_ring) -> None:
    root = sync_keyring.active_key_id()
    before = sync_keyring.hashed_item_id("skills", "pdf", root)
    sync_keyring.rotate_account_key()
    sync_keyring.rotate_account_key()
    assert root in sync_keyring.ring()["keys"]
    assert sync_keyring.active_key_id() != root
    assert sync_keyring.hashed_item_id("skills", "pdf", root) == before


def test_no_write_can_drop_a_key_the_ring_holds(fresh_ring) -> None:
    root = sync_keyring.active_key_id()
    sync_keyring.rotate_account_key()
    held = sync_keyring.ring()
    shrunk = {**held, "keys": {k: v for k, v in held["keys"].items() if k != root}}
    with pytest.raises(sync_keyring.KeyringError):
        sync_keyring._store_ring(shrunk)  # noqa: SLF001 - the guard itself
    assert root in sync_keyring.ring()["keys"]


def test_a_newly_paired_device_holds_the_id_key_and_computes_the_same_ids(fresh_ring) -> None:
    root = sync_keyring.active_key_id()
    here = sync_keyring.hashed_item_id("mcp", "github", root)
    sync_keyring.rotate_account_key()
    wire = sync_keyring.wrap_for(
        recipient_public_key=device_crypto.public_key(), from_device="dev-a", to_device="dev-b"
    )
    # The new device: nothing held until the offer arrives.
    sync_keyring.forget_account_key()
    sync_keyring.accept_wrapped(wire, from_device="dev-a", to_device="dev-b")
    assert root in sync_keyring.ring()["keys"]
    assert sync_keyring.hashed_item_id("mcp", "github", root) == here


def test_a_missing_id_key_is_said_plainly(fresh_ring) -> None:
    with pytest.raises(sync_keyring.UnknownKeyId):
        sync_keyring.hashed_item_id("mcp", "github", "00" * 8)
