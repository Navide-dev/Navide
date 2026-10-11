"""The sealed cross-device trust record (plan 797ad7, B1).

The record outgrew the one Keychain line ``security -i`` writes (4095 bytes),
which capped pairing at a handful of devices. So the record moves into an
owner-only file, sealed with AES-256-GCM, and the Keychain keeps only the key:
32 random bytes, 44 characters of base64, which always fit.

This module is the sealing and the key and nothing else. Where the file lives,
when it is written and what happens when it cannot be read is trust_store's
business, as it was for the Keychain item.
"""

from __future__ import annotations

import base64
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from agent_team_backend import cloud_secrets

#: The app secret holding the key. Its own item, so the record and the key are
#: never in the same place: the file alone is ciphertext.
KEY_SECRET = "navide-device-trust-key"

#: First bytes of every sealed blob. Lets a reader tell a sealed journal from a
#: plaintext one an earlier build wrote.
MAGIC = b"NAVIDE-TRUST-1\n"

#: What a blob is for, bound into the seal: a sealed journal cannot be put in
#: the record's place, nor the other way round.
AAD_RECORD = b"navide/device-trust/v1"
AAD_JOURNAL = b"navide/device-trust-journal/v1"

_KEY_LEN = 32
_NONCE_LEN = 12


class SealError(RuntimeError):
    """A blob that is not one this key sealed for this purpose, or a key that is
    not a key. Never says which part was wrong."""


def _vault():
    # Late import for the same reason trust_store does it: app imports both,
    # and tests swap the app-wide vault wholesale to stay off the real Keychain.
    from agent_team_backend import trust_store

    return trust_store._vault()


def key(*, create: bool) -> bytes | None:
    """The record key, made and stored first when *create* and there is none.

    None when there is none and *create* is false. Raises what the vault raises
    when it cannot be read — a locked keychain is not "no key", and making a new
    one then would orphan every record sealed with the old one.
    """
    vault = _vault()
    stored = vault.read_app_secret(KEY_SECRET)
    if stored:
        try:
            raw = base64.b64decode(stored, validate=True)
        except ValueError as err:
            raise SealError("the device trust key is not a key") from err
        if len(raw) != _KEY_LEN:
            raise SealError("the device trust key is not a key")
        return raw
    if not create:
        return None
    raw = os.urandom(_KEY_LEN)
    cloud_secrets.write(vault, KEY_SECRET, base64.b64encode(raw).decode("ascii"))
    return raw


def seal(key: bytes, plaintext: bytes, aad: bytes) -> bytes:
    nonce = os.urandom(_NONCE_LEN)
    return MAGIC + nonce + AESGCM(key).encrypt(nonce, plaintext, aad)


def unseal(key: bytes, blob: bytes, aad: bytes) -> bytes:
    if not blob.startswith(MAGIC) or len(blob) < len(MAGIC) + _NONCE_LEN + 16:
        raise SealError("not a sealed device trust blob")
    nonce = blob[len(MAGIC):len(MAGIC) + _NONCE_LEN]
    try:
        return AESGCM(key).decrypt(nonce, blob[len(MAGIC) + _NONCE_LEN:], aad)
    except (InvalidTag, ValueError) as err:
        raise SealError("the device trust blob does not open with this key") from err
