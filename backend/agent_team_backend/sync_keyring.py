"""The account-wide key that makes synced records readable on every device.

Cross-device *messages* are sealed boxes: the sender needs only the
recipient's public key, nothing is stored, and the ephemeral half is thrown
away the moment the message is sealed. Synced *records* are the opposite
shape. They sit on the server until some device comes to read them — possibly
one that does not exist yet — so "seal it to the recipient" has no recipient
to name, and sealing one copy per device would leave a machine paired next
month unable to read anything written before it arrived.

So the records are encrypted with one symmetric key per account, and that key
is what travels by sealed box:

    account key (32 bytes, never leaves the Keychain in the clear)
        │
        ├─ AES-256-GCM ──→ every synced record body
        │
        └─ device_crypto.seal(recipient public key) ──→ handed to a new device
                                                        over the paired channel

Three decisions worth naming:

*The server never holds a key, and this module gives it no way to grow one.*
Only ciphertext is ever handed to ``server_link``; the plaintext boundary is
this file.

*A second key is refused, not merged.* Accepting an unrelated account key would
orphan everything already written under the first one — silently, because the
old ciphertext would simply stop opening. ``accept_wrapped`` raises instead,
and the caller surfaces it.

*Scope and item are bound into the ciphertext.* They go in as AEAD associated
data, so a record lifted from one item cannot be replayed as another. Same
reason the message layer binds the device ids.

**Rotation.** What is stored is not one key but a *ring*: every key this
account has ever used, the id of the one currently written with, and a
generation counter that goes up by one per rotation. Rotating mints a new
active key and keeps the old ones for reading, so a record written last month
still opens; every record written from then on names the key it is under, so
a device that lacks it says so instead of guessing. The ring is what travels
by sealed box, and a ring from a peer is adopted only when it is a *later
generation of the same lineage* — it shares at least one key with what is
held here. Two rings with nothing in common are the second-key case above,
and are still refused.

Rotation protects what is written after it. A record sealed under the old key
stays sealed under the old key until something re-writes it; ``needs_reseal``
and ``resealed`` are what a re-push uses to find and fix those.

The key id is derived from the key material (a truncated SHA-256), so two
devices holding the same key name it the same way without ever exchanging the
name, and the legacy single key — stored as bare base64 before rings existed —
gets an id the moment it is read, with no migration step to run.

**One ring per account, not per install.** The ring is stored under a
namespace derived from the server address and the member id the trust store
pinned for the credential, and nothing here answers until ``bind`` has named
one. Signing out therefore does not touch the ring — the next sign-in to the
same account binds the same namespace and reads the same keys — while
signing in to a *different* account binds a different one, finds nothing, and
can neither read the first account's records nor write under its key. The
ring the first version stored, unbound, is not attributed to whichever account
happens to sign in next: ``legacy_ring_pending`` says one is there,
``adopt_legacy_ring`` moves it under the bound namespace, and until one of
the callers with evidence does that, minting is refused rather than a fresh
key quietly orphaning what the old one wrote.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import threading
from typing import Any

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from . import device_crypto

log = logging.getLogger("agent_team_backend.sync_keyring")

#: Vault entry holding a ring: this prefix, a colon, and the bound namespace.
#: The bare name is the entry the first version wrote, before rings were per
#: account — see ``legacy_ring_pending``.
ACCOUNT_KEY_SECRET = "navide-sync-account-key"
_NAMESPACE_CONTEXT = b"navide/sync/namespace"

_KEY_LEN = 32
_NONCE_LEN = 12
#: Bytes of key id inside a v2 record envelope; the id string is its hex.
_KID_LEN = 8
#: The first byte of a v2 record body. A v1 body starts with a random nonce,
#: so it can begin with this byte too; ``decrypt`` tries both readings rather
#: than trusting the byte alone.
_ENVELOPE_V2 = b"\x02"
_AAD_PREFIX_V1 = b"navide/sync/v1"
_AAD_PREFIX_V2 = b"navide/sync/v2"
_KID_CONTEXT = b"navide/sync/kid"

RING_VERSION = 2

#: The ring, once read. A sync round encrypts or opens one record per item, and
#: without this every one of them was a separate Keychain call — slow, and on
#: macOS a queue of authorisation prompts waiting to happen. Cleared by the
#: functions that change what is stored, so the cache can never outlive it.
#: The cache is tagged with the namespace it was read under, so a ring read
#: for one account can never be answered for another even if a read and a
#: ``bind`` are interleaved.
_cached: tuple[str, dict[str, Any]] | None = None
#: Which account's ring every call below is about. None until ``bind``.
_bound: str | None = None
#: One lock around every read-modify-write of the ring and around the binding
#: itself. Reentrant, because the operations compose (rotate loads, adopt
#: loads and stores) and each of them takes it. The cache alone used to be
#: what was locked, which left rotate and adopt — both run off the loop in
#: worker threads — free to read the same ring and overwrite each other's
#: write, and left a load begun under one namespace free to finish after a
#: bind to another.
_op_lock = threading.RLock()


class KeyringError(Exception):
    """The account key could not be read, created, or agreed on."""


class KeyConflict(KeyringError):
    """An unrelated account key arrived while this machine already holds one."""


class UnknownKeyId(KeyringError):
    """A record names a key this machine does not hold.

    Distinct from a record that will not open, because the fix is different:
    this one opens as soon as a paired device hands over the newer ring.
    """


def namespace_for(url: str, member_id: str) -> str:
    """The namespace an account's ring is stored under.

    Both halves are what ``trust_store.adopt_own_member`` pinned: the address
    this machine chose to talk to and the member id it will only ever accept
    for that credential. The token itself is not in it — it changes on every
    sign-in, and the ring has to survive that.
    """
    return hashlib.sha256(
        b"\x00".join((_NAMESPACE_CONTEXT, url.encode("utf-8"), member_id.encode("utf-8")))
    ).digest()[:16].hex()


def bind(namespace: str) -> None:
    """Name the account every call below is about. Clears the cache, so a ring
    read under one account is never answered for another."""
    global _bound
    if not namespace:
        raise KeyringError("a sync key namespace cannot be empty")
    with _op_lock:
        _bound = namespace
        _remember(None)


def unbind() -> None:
    """No account: every read answers "no key", every write is refused."""
    global _bound
    with _op_lock:
        _bound = None
        _remember(None)


def bound_namespace() -> str | None:
    with _op_lock:
        return _bound


def _secret_name() -> str:
    with _op_lock:
        namespace = _bound
    if not namespace:
        raise KeyringError("no account is bound, so there is no sync key to read")
    return f"{ACCOUNT_KEY_SECRET}:{namespace}"


def _vault():
    # Late import for the same reason server_link does it: app imports this
    # module, and tests swap the singleton wholesale to stay off the Keychain.
    from . import app

    return app.credential_vault


def _encode(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _decode(value: str) -> bytes:
    return base64.b64decode(value.encode("ascii"), validate=True)


def key_id(raw: bytes) -> str:
    """The name a key goes by: 16 hex characters of a keyed SHA-256.

    Derived rather than assigned so every device names the same key the same
    way. A truncated hash of 32 random bytes reveals nothing about them.
    """
    return hashlib.sha256(_KID_CONTEXT + b"\x00" + raw).digest()[:_KID_LEN].hex()


# ---- the ring on disk ----------------------------------------------------------


def _decode_key(value: Any, what: str) -> bytes:
    if not isinstance(value, str):
        raise KeyringError(f"{what} is not a string")
    try:
        raw = _decode(value.strip())
    except (ValueError, TypeError) as err:
        raise KeyringError(f"{what} is not valid base64") from err
    if len(raw) != _KEY_LEN:
        raise KeyringError(f"{what} is not 32 bytes")
    return raw


def _ring_of(raw: bytes) -> dict[str, Any]:
    """A generation-0 ring holding one key: what a bare legacy key means."""
    kid = key_id(raw)
    return {"v": RING_VERSION, "gen": 0, "active": kid, "keys": {kid: raw}}


def _parse_ring(stored: str, what: str) -> dict[str, Any]:
    """The ring in *stored*: a v2 JSON document, or the bare base64 key the
    first version wrote. Keys come out as bytes; ids are checked against the
    material, so a document whose names do not match its keys is refused
    rather than read into a ring nobody else would agree with."""
    text = stored.strip()
    if not text.startswith("{"):
        return _ring_of(_decode_key(text, what))
    try:
        doc = json.loads(text)
    except (ValueError, TypeError) as err:
        raise KeyringError(f"{what} is not valid JSON") from err
    if not isinstance(doc, dict) or doc.get("v") != RING_VERSION:
        raise KeyringError(f"{what} has an unknown ring version")
    keys_doc = doc.get("keys")
    if not isinstance(keys_doc, dict) or not keys_doc:
        raise KeyringError(f"{what} holds no keys")
    keys: dict[str, bytes] = {}
    for kid, value in keys_doc.items():
        raw = _decode_key(value, f"{what} key {kid!r}")
        if key_id(raw) != kid:
            raise KeyringError(f"{what} names key {kid!r} wrongly")
        keys[kid] = raw
    active = doc.get("active")
    if active not in keys:
        raise KeyringError(f"{what} names an active key it does not hold")
    gen = doc.get("gen")
    if not isinstance(gen, int) or isinstance(gen, bool) or gen < 0:
        raise KeyringError(f"{what} has no generation")
    return {"v": RING_VERSION, "gen": gen, "active": active, "keys": keys}


def _serialise(ring: dict[str, Any]) -> str:
    # One line: the vault refuses multi-line payloads and truncates at the
    # first newline (see trust_store._write), which for a ring would mean a
    # document that parses as far as "{" and every record unreadable.
    return json.dumps(
        {
            "v": RING_VERSION,
            "gen": ring["gen"],
            "active": ring["active"],
            "keys": {kid: _encode(raw) for kid, raw in ring["keys"].items()},
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def _load_ring() -> dict[str, Any] | None:
    """The stored ring, or None when this machine has none yet.

    A vault that will not answer reads as "no key this time round" rather than
    "no key at all": a locked Keychain must not send the caller down the path
    that mints a second one.
    """
    with _op_lock:
        name = _secret_name()
        if _cached is not None and _cached[0] == name:
            return _cached[1]
        try:
            stored = _vault().read_app_secret(name)
        except Exception as err:  # noqa: BLE001 - a locked vault is not "no key"
            raise KeyringError(f"the sync key could not be read: {err}") from err
        if not stored:
            return None
        ring = _parse_ring(stored, "the stored sync key")
        _remember(ring)
        return ring


def _store_ring(ring: dict[str, Any]) -> None:
    with _op_lock:
        _vault().write_app_secret(_secret_name(), _serialise(ring))
        _remember(ring)


def _legacy_stored() -> str:
    """The unbound entry the first version wrote, or ""."""
    try:
        return (_vault().read_app_secret(ACCOUNT_KEY_SECRET) or "").strip()
    except Exception as err:  # noqa: BLE001 - a locked vault is not "no legacy key"
        raise KeyringError(f"the sync key could not be read: {err}") from err


def legacy_ring_pending() -> bool:
    """Whether the unbound ring from before accounts were bound is still there
    and the bound account has none of its own.

    While this is true ``ensure_account_key`` refuses to mint: a fresh key
    would leave everything the old one wrote unreadable, silently. Which
    account the old ring belongs to is not something this module can tell —
    the caller with evidence (one account ever signed in here) adopts it, or
    a person does.
    """
    with _op_lock:
        if _load_ring() is not None:
            return False
        return bool(_legacy_stored())


def adopt_legacy_ring() -> bytes:
    """Move the unbound ring under the bound account, once. Returns its active
    key. Refused when the account already holds a ring — nothing is merged."""
    with _op_lock:
        if _load_ring() is not None:
            raise KeyringError(
                "this account already holds a sync key; the legacy one is not merged"
            )
        stored = _legacy_stored()
        if not stored:
            raise KeyringError("there is no legacy sync key to adopt")
        ring = _parse_ring(stored, "the legacy sync key")
        _store_ring(ring)
        _vault().write_app_secret(ACCOUNT_KEY_SECRET, None)
    log.info("adopted the sync key from before accounts were bound")
    return ring["keys"][ring["active"]]


def _remember(ring: dict[str, Any] | None) -> None:
    global _cached
    with _op_lock:
        _cached = None if ring is None else (_secret_name(), ring)


# ---- what callers ask ----------------------------------------------------------


def account_key() -> bytes | None:
    """The key records are written with, or None when this machine has none yet."""
    ring = _load_ring()
    if ring is None:
        return None
    return ring["keys"][ring["active"]]


def active_key_id() -> str | None:
    ring = _load_ring()
    return None if ring is None else ring["active"]


def ring() -> dict[str, Any] | None:
    """A copy of the held ring — ``{v, gen, active, keys: {kid: bytes}}`` —
    or None. For callers that report on it; nothing here is meant to leave
    the process except through ``wrap_for``."""
    held = _load_ring()
    if held is None:
        return None
    return {**held, "keys": dict(held["keys"])}


def has_account_key() -> bool:
    try:
        return account_key() is not None
    except KeyringError:
        return False


def ensure_account_key() -> bytes:
    """This machine's account key, minting one only when there is none.

    Minting is safe exactly once per account: the first device to sync creates
    it, every later device receives it through ``accept_wrapped``. A machine
    that mints a second one would write records nobody else can open, which is
    why callers must only reach here after the pairing path has had its chance.
    """
    with _op_lock:
        existing = account_key()
        if existing is not None:
            return existing
        if legacy_ring_pending():
            raise KeyringError(
                "a sync key from before accounts were bound is still stored; adopt it "
                "or discard it before this account mints its own"
            )
        raw = os.urandom(_KEY_LEN)
        _store_ring(_ring_of(raw))
    log.info("minted this account's sync key")
    return raw


def rotate_account_key() -> str:
    """Mint a new active key and keep the old ones for reading. Returns the
    new key id.

    This is the stop-the-bleeding move after a key is suspected leaked: from
    here on nothing new is written under the old key. It is not, by itself,
    the whole cure — records already on the server stay under the key they
    were sealed with until something re-writes them (see ``needs_reseal``),
    and every other device keeps writing under the old key until it receives
    this ring, which the ordinary offer path hands over.
    """
    with _op_lock:
        held = _load_ring()
        if held is None:
            raise KeyringError("this machine has no sync key to rotate")
        raw = os.urandom(_KEY_LEN)
        kid = key_id(raw)
        keys = dict(held["keys"])
        keys[kid] = raw
        _store_ring(
            {"v": RING_VERSION, "gen": held["gen"] + 1, "active": kid, "keys": keys}
        )
    log.info("rotated this account's sync key (generation %d)", held["gen"] + 1)
    return kid


def forget_account_key() -> None:
    """Erase the bound account's ring.

    Not what signing out does. Signing out unbinds; the ring stays for the
    next sign-in to the same account, because on a machine that is the
    account's only device it is the only copy of the key every synced record
    is under. This is the deliberate "discard this account's key" — a wipe —
    and for the same reason it is never reached from a routine path.
    """
    with _op_lock:
        _vault().write_app_secret(_secret_name(), None)
        _remember(None)


# ---- record envelopes ----------------------------------------------------------


def _aad_v1(scope: str, item_id: str) -> bytes:
    return b"\x00".join((_AAD_PREFIX_V1, scope.encode("utf-8"), item_id.encode("utf-8")))


def _aad_v2(kid: str, scope: str, item_id: str) -> bytes:
    return b"\x00".join(
        (_AAD_PREFIX_V2, kid.encode("ascii"), scope.encode("utf-8"), item_id.encode("utf-8"))
    )


def encrypt(plaintext: str, *, scope: str, item_id: str) -> str:
    """Seal one record body under the active key. Never falls back to plaintext.

    Wire form, base64: ``0x02 ‖ key id (8 bytes) ‖ nonce (12) ‖ ciphertext``.
    The id selects the key on the way back in, which is what makes a
    relabelled body fail to open; it is repeated inside the AEAD data with
    the envelope version so the two readings of a body can never both
    succeed, not because the label needs protecting on its own.
    """
    held = _load_ring()
    if held is None:
        raise KeyringError("this machine has no sync key yet")
    kid = held["active"]
    nonce = os.urandom(_NONCE_LEN)
    sealed = AESGCM(held["keys"][kid]).encrypt(
        nonce, plaintext.encode("utf-8"), _aad_v2(kid, scope, item_id)
    )
    return _encode(_ENVELOPE_V2 + bytes.fromhex(kid) + nonce + sealed)


def sealed_length(plaintext: str) -> int:
    """How many bytes ``encrypt(plaintext, ...)`` returns, without a key.

    Envelope byte, key id, nonce and the 16-byte GCM tag around the UTF-8
    plaintext, then base64. Lets a caller ask whether a record will fit
    before it holds, or spends, a key.
    """
    raw = 1 + _KID_LEN + _NONCE_LEN + len(plaintext.encode("utf-8")) + 16
    return 4 * ((raw + 2) // 3)


def _v2_key_id(raw: bytes) -> str | None:
    """The key id a body names if it is shaped like a v2 envelope, else None."""
    if len(raw) < 1 + _KID_LEN + _NONCE_LEN + 16 or raw[:1] != _ENVELOPE_V2:
        return None
    return raw[1 : 1 + _KID_LEN].hex()


def decrypt(wire: str, *, scope: str, item_id: str) -> str:
    """Open one record body sealed by ``encrypt`` — this build's or the last one's.

    A v2 body opens under the key it names. A v1 body names nothing, so every
    held key is tried; there are as many as there have been rotations, which
    is few. A v2 body naming a key this machine lacks raises ``UnknownKeyId``
    — after the v1 reading has been tried too, because a v1 nonce can start
    with the v2 marker byte by chance.
    """
    held = _load_ring()
    if held is None:
        raise KeyringError("this machine has no sync key yet")
    try:
        raw = _decode(wire)
    except (ValueError, TypeError) as err:
        raise KeyringError("the record body is not valid base64") from err
    if len(raw) <= _NONCE_LEN:
        raise KeyringError("the record body is too short to be a sealed record")
    kid = _v2_key_id(raw)
    if kid is not None and kid in held["keys"]:
        start = 1 + _KID_LEN
        try:
            opened = AESGCM(held["keys"][kid]).decrypt(
                raw[start : start + _NONCE_LEN],
                raw[start + _NONCE_LEN :],
                _aad_v2(kid, scope, item_id),
            )
        except Exception as err:  # noqa: BLE001 - cryptography raises a bare InvalidTag
            raise KeyringError("the record body did not open with this account key") from err
        return opened.decode("utf-8")
    for raw_key in held["keys"].values():
        try:
            opened = AESGCM(raw_key).decrypt(
                raw[:_NONCE_LEN], raw[_NONCE_LEN:], _aad_v1(scope, item_id)
            )
        except Exception:  # noqa: BLE001 - not this key; try the next
            continue
        return opened.decode("utf-8")
    if kid is not None:
        raise UnknownKeyId(f"the record is sealed under key {kid}, which this machine does not hold")
    raise KeyringError("the record body did not open with this account key")


def needs_reseal(wire: str) -> bool:
    """Whether *wire* is under something other than the active key: a v1 body,
    or a v2 body naming a retired key. What a post-rotation re-push looks for."""
    held = _load_ring()
    if held is None:
        return False
    try:
        raw = _decode(wire)
    except (ValueError, TypeError):
        return False
    kid = _v2_key_id(raw)
    return kid != held["active"]


def resealed(wire: str, *, scope: str, item_id: str) -> str:
    """*wire* opened with whatever key it is under and sealed again under the
    active one. Raises like ``decrypt``."""
    return encrypt(decrypt(wire, scope=scope, item_id=item_id), scope=scope, item_id=item_id)


# ---- auxiliary data --------------------------------------------------------------
#
# Small values that are not sync records but must open on every device of the
# account and nowhere else — a share link's key and its encrypted metadata.
# Same key ring, its own envelope byte and AEAD prefix, so an aux value never
# opens as a record or a record as an aux value. The label is bound in as AEAD
# data the way scope and item are for records.

_ENVELOPE_AUX = b"\x03"
_AAD_PREFIX_AUX = b"navide/aux/v1"


def _aad_aux(kid: str, label: str) -> bytes:
    return b"\x00".join((_AAD_PREFIX_AUX, kid.encode("ascii"), label.encode("utf-8")))


def wrap_aux(label: str, data: bytes) -> str:
    """Seal *data* under the active key for *label*. Wire form, base64:
    ``0x03 ‖ key id (8) ‖ nonce (12) ‖ ciphertext``."""
    held = _load_ring()
    if held is None:
        raise KeyringError("this machine has no sync key yet")
    kid = held["active"]
    nonce = os.urandom(_NONCE_LEN)
    sealed = AESGCM(held["keys"][kid]).encrypt(nonce, data, _aad_aux(kid, label))
    return _encode(_ENVELOPE_AUX + bytes.fromhex(kid) + nonce + sealed)


def unwrap_aux(label: str, wire: str) -> bytes:
    """Open a value sealed by ``wrap_aux`` for the same *label*. Raises
    ``UnknownKeyId`` when it names a key this machine lacks, ``KeyringError``
    for anything else that does not open."""
    try:
        raw = _decode(wire)
    except (ValueError, TypeError) as err:
        raise KeyringError("the wrapped value is not valid base64") from err
    if len(raw) < 1 + _KID_LEN + _NONCE_LEN + 16 or raw[:1] != _ENVELOPE_AUX:
        raise KeyringError("the wrapped value is not an auxiliary envelope")
    kid = raw[1 : 1 + _KID_LEN].hex()
    key = _held_key(kid)
    start = 1 + _KID_LEN
    try:
        return AESGCM(key).decrypt(raw[start : start + _NONCE_LEN], raw[start + _NONCE_LEN :], _aad_aux(kid, label))
    except Exception as err:  # noqa: BLE001 - cryptography raises a bare InvalidTag
        raise KeyringError("the wrapped value did not open with this account key") from err


# ---- handing the ring to another device ----------------------------------------


# ---- blob segments ------------------------------------------------------------
#
# Large skill files do not ride inside a record; they are stored once as a blob
# (``skill_blobs``) and a record names them by id. A blob is a run of segments,
# each sealed on its own so that neither side ever holds the whole file:
#
#     segment = nonce (12) ‖ AES-256-GCM(plaintext ≤ segment size) ‖ tag (16)
#
# The AEAD data binds the key id, the blob id, the segment's index and the total
# count, so segments cannot be swapped between blobs, reordered, or cut short —
# a truncated object is missing segments the count says must be there.

_BLOB_AAD_PREFIX = b"navide/blob/v2"
_BLOB_ID_CONTEXT = b"navide/blob-id/v1"
#: What sealing adds to each segment.
BLOB_SEGMENT_OVERHEAD = _NONCE_LEN + 16


def _held_key(kid: str) -> bytes:
    held = _load_ring()
    if held is None:
        raise KeyringError("this machine has no sync key yet")
    if kid not in held["keys"]:
        raise UnknownKeyId(f"the blob is sealed under key {kid}, which this machine does not hold")
    return held["keys"][kid]


def blob_hasher(kid: str | None = None) -> tuple[str, hmac.HMAC]:
    """A keyed hash to name a blob by, under key *kid* (the active one by default).

    Keyed rather than a plain SHA-256 so the server cannot tell that two
    accounts hold the same file, nor confirm a guess of one; every device of
    this account derives the same key, so identical files still share one blob.
    Returns the key id alongside, because the name is only meaningful with it.
    """
    if kid is None:
        kid = active_key_id()
        if kid is None:
            raise KeyringError("this machine has no sync key yet")
    derived = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=_BLOB_ID_CONTEXT).derive(
        _held_key(kid)
    )
    return kid, hmac.new(derived, digestmod=hashlib.sha256)


def _blob_aad(kid: str, blob_id: str, index: int, count: int) -> bytes:
    return b"\x00".join(
        (_BLOB_AAD_PREFIX, kid.encode("ascii"), blob_id.encode("ascii"), str(index).encode(), str(count).encode())
    )


def seal_segment(plaintext: bytes, *, kid: str, blob_id: str, index: int, count: int) -> bytes:
    """Seal one blob segment under key *kid*. See the layout above."""
    nonce = os.urandom(_NONCE_LEN)
    return nonce + AESGCM(_held_key(kid)).encrypt(nonce, plaintext, _blob_aad(kid, blob_id, index, count))


def open_segment(sealed: bytes, *, kid: str, blob_id: str, index: int, count: int) -> bytes:
    """Open one blob segment; any tampering, reordering or relabelling raises."""
    if len(sealed) < BLOB_SEGMENT_OVERHEAD:
        raise KeyringError("the blob segment is too short to be sealed")
    # Outside the try: a key this machine lacks is UnknownKeyId ("wait for the
    # ring"), not a segment that failed to open ("tampered").
    key = _held_key(kid)
    try:
        return AESGCM(key).decrypt(
            sealed[:_NONCE_LEN], sealed[_NONCE_LEN:], _blob_aad(kid, blob_id, index, count)
        )
    except Exception as err:  # noqa: BLE001 - cryptography raises a bare InvalidTag
        raise KeyringError(f"blob segment {index} of {count} did not open") from err


def _require_namespace(expected: str | None) -> None:
    """Refuse when the caller meant a different account than the one bound.

    The caller runs off the event loop, so between its dispatch and its first
    line the link may have signed out and a different account may have bound.
    A caller that names the account it is acting for cannot then be answered
    for another one.
    """
    if expected is not None and expected != _bound:
        raise KeyringError("the bound account changed under this operation")


def wrap_for(
    *,
    recipient_public_key: str,
    from_device: str,
    to_device: str,
    namespace: str | None = None,
) -> str:
    """The ring, sealed to one device so it can join the account.

    Goes over the paired channel, which is already signed and verified by a
    short authentication string — so the newcomer's public key has been
    confirmed by a human before anything is wrapped for it. The caller reads
    that key out of the pin, never out of the directory: the directory is the
    relay's word, and a relay that could name the recipient here would be
    handed every record in the account. ``namespace`` is the account the
    caller is acting for; see ``_require_namespace``.
    """
    with _op_lock:
        _require_namespace(namespace)
        held = _load_ring()
        if held is None:
            raise KeyringError("this machine has no sync key to share")
        return device_crypto.seal(
            _serialise(held),
            recipient_public_key=recipient_public_key,
            from_device=from_device,
            to_device=to_device,
        )


def accept_wrapped(
    wire: str, *, from_device: str, to_device: str, namespace: str | None = None
) -> bytes:
    """Open a ring another device sealed for us, and store what is new in it.
    Returns the active key afterwards.

    The whole of it — opening included — runs under the operation lock and
    against the account the caller names: an offer opened for one account
    must not land in the ring of whichever account is bound by the time the
    open finishes.

    Idempotent for the same ring — a peer re-sending it is ordinary. The rule
    for a ring that differs from the held one is lineage: it has to share at
    least one key with what is here, or it is a second account key, which is
    refused (adopting it would leave every record written under the first one
    permanently unreadable, and doing that quietly is worse than stopping).
    Within a lineage the *keys* of both rings are always kept — every key
    either side ever wrote with, so nothing written under any of them stops
    opening — and the later generation decides which one is active. An
    earlier generation therefore changes nothing but the key set. Two rings
    of the same generation that disagree about the active key were rotated
    apart while the devices could not talk, and that is refused: whichever
    this machine picked, the other device would go on writing under the other
    one. (Two rings that forked at *different* generations converge instead:
    the higher one is adopted with the other's keys kept, and when it comes
    back round to the other device it is the same generation and active as
    what that device now holds, so the union there fills in what it lacked.)
    """
    with _op_lock:
        _require_namespace(namespace)
        try:
            opened = device_crypto.open_sealed(
                wire, from_device=from_device, to_device=to_device
            )
        except Exception as err:  # noqa: BLE001 - any failure here means "not for us"
            raise KeyringError(f"the wrapped sync key did not open: {err}") from err
        offered = _parse_ring(opened, "the wrapped sync key")
        held = _load_ring()
        if held is None:
            _store_ring(offered)
            log.info("adopted the account sync key from %s", from_device)
            return offered["keys"][offered["active"]]
        if not set(held["keys"]) & set(offered["keys"]):
            raise KeyConflict(
                "this machine already holds a different sync key for this account"
            )
        if offered["gen"] == held["gen"] and offered["active"] != held["active"]:
            raise KeyConflict(
                "this machine and that one rotated the sync key apart; neither ring is newer"
            )
        keys = {**held["keys"], **offered["keys"]}
        newer = offered["gen"] > held["gen"]
        merged = {
            "v": RING_VERSION,
            "gen": offered["gen"] if newer else held["gen"],
            "active": offered["active"] if newer else held["active"],
            "keys": keys,
        }
        if merged != held:
            _store_ring(merged)
            if newer:
                log.info(
                    "adopted the rotated sync key from %s (generation %d)",
                    from_device, offered["gen"],
                )
        return keys[merged["active"]]


def _reset_for_test() -> None:
    """Drop the in-process ring cache and bind a synthetic account.

    The cache is what stops a sync round from making one Keychain call per
    record; it also outlives the per-test vault, so a test that expects "no key
    yet" would otherwise see one a previous test minted. Reset alongside the
    other process-wide singletons in conftest. Bound rather than unbound so the
    many tests that are not about accounts do not each have to name one; the
    tests that are call ``bind``/``unbind`` themselves.
    """
    bind("test-account")
