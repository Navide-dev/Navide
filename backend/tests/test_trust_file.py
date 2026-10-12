"""The sealed trust record: a 32-byte key in the Keychain, the record itself
AES-GCM-sealed in an owner-only file (plan 797ad7, B1)."""

from __future__ import annotations

import base64

import pytest

from agent_team_backend import app, trust_file


def test_a_key_is_made_once_and_then_read_back():
    assert trust_file.key(create=False) is None
    first = trust_file.key(create=True)
    assert isinstance(first, bytes) and len(first) == 32
    assert trust_file.key(create=False) == first
    assert trust_file.key(create=True) == first
    stored = app.credential_vault.read_app_secret(trust_file.KEY_SECRET)
    assert base64.b64decode(stored) == first and len(stored) == 44


def test_a_sealed_record_opens_with_its_key_and_purpose():
    key = trust_file.key(create=True)
    blob = trust_file.seal(key, b'{"v":1}', trust_file.AAD_RECORD)
    assert blob.startswith(trust_file.MAGIC)
    assert b'"v"' not in blob
    assert trust_file.unseal(key, blob, trust_file.AAD_RECORD) == b'{"v":1}'
    # A new nonce every time.
    assert trust_file.seal(key, b'{"v":1}', trust_file.AAD_RECORD) != blob


@pytest.mark.parametrize("damage", ["flip", "truncate", "magic", "purpose", "key"])
def test_anything_but_the_sealed_bytes_is_refused(damage):
    key = trust_file.key(create=True)
    blob = trust_file.seal(key, b'{"v":1}', trust_file.AAD_RECORD)
    aad = trust_file.AAD_RECORD
    if damage == "flip":
        blob = blob[:-1] + bytes([blob[-1] ^ 1])
    elif damage == "truncate":
        blob = blob[:-5]
    elif damage == "magic":
        blob = b"X" + blob[1:]
    elif damage == "purpose":
        aad = trust_file.AAD_JOURNAL
    elif damage == "key":
        key = bytes(32)
    with pytest.raises(trust_file.SealError):
        trust_file.unseal(key, blob, aad)


def test_a_key_that_is_not_32_bytes_is_not_a_key():
    app.credential_vault.write_app_secret(trust_file.KEY_SECRET, base64.b64encode(b"short").decode())
    with pytest.raises(trust_file.SealError):
        trust_file.key(create=True)
