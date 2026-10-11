"""This device's signing identity, and what it puts its name to.

``device_crypto`` answers *confidentiality*: the relay cannot read a message it
has no key for. This module answers the other half — *authenticity* — and the
two are not the same question. A sealed box has no sender authentication by
construction: anybody holding the recipient's public key can produce a
ciphertext that opens correctly, and the recipient's public key is exactly what
the server stores and hands out. So encryption alone leaves the relay able to
*write* messages while unable to read them, and to sign them with whatever
sender identity it likes.

The fix is an Ed25519 keypair per device whose private half never leaves the
machine. Every cross-device message carries a signature over

    (msgKey, fromDeviceId, toDeviceId, which body field, SHA-256 of that body)

and the receiver verifies it against a key it has **pinned itself** before the
message is allowed anywhere near a trust decision. Three things fall out of
that tuple, and each is there for a reason:

*msgKey* stops a signature being lifted onto a different message.

*from/to device ids* stop the relay re-addressing a signed message to another
machine — the same binding the sealed box's associated data already makes, now
extended to the plaintext path, which had none.

*Which body field, and its hash.* Signing the bytes actually on the wire means
the signature is checkable before decryption, which matters because the
delivery path deliberately decrypts last. Naming the field as well as hashing
it means the relay cannot present a ciphertext as if it were plaintext and have
a wall of base64 typed into somebody's CLI under a valid signature.

The policy document is signed the same way, with its own context string, so a
signature over one can never be replayed as a signature over the other.

**What this does not do.** A signature proves a message came from the holder of
some private key; it says nothing about who that holder is. That question is
answered by pinning, which lives in ``trust_store`` — and pinning is
trust-on-first-use, so the first key seen for a device is believed. See the
note there for what that does and does not buy.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import threading
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from agent_team_backend.applog import app_data_dir
from agent_team_backend.osplat import secret_files

log = logging.getLogger(__name__)

KEYS_FILENAME = "device-signing-key.json"

#: Domain separation, one context per thing that gets signed. Prefixed to the
#: canonical payload with a separator that cannot occur inside JSON text, so no
#: payload can ever be made to read as another context's payload.
_MESSAGE_CONTEXT = b"navide/cross-device-message-signature/v1"
#: v2 adds the send time (plan 797ad7, B4). Its own context, so no v1 signature
#: can be read as a v2 one or the other way round.
_MESSAGE_CONTEXT_V2 = b"navide/cross-device-message-signature/v2"
_POLICY_CONTEXT = b"navide/pane-policy-signature/v1"
_SYNC_CONTEXT = b"navide/sync-record-signature/v1"
_SEPARATOR = b"\x00"

_KEY_LEN = 32
_SIG_LEN = 64

_lock = threading.Lock()


class SigningError(Exception):
    """A signature could not be produced. Never carries key material."""


# ---- key material ------------------------------------------------------------


def keys_path() -> Path:
    return app_data_dir() / KEYS_FILENAME


def _write_private(path: Path, raw: bytes) -> None:
    """Same shape as ``device_crypto._write_private``, and for the same reason:
    a reader that opened the file between truncate and write would see an empty
    key and this machine would mint a second identity for itself."""
    payload = json.dumps({"ed25519_private": base64.b64encode(raw).decode("ascii")})
    secret_files.write_private(path, payload.encode("utf-8"))


def _load_private() -> Ed25519PrivateKey:
    """This device's long-term signing key, generating one on first use.

    A key that cannot be read is regenerated rather than fatal, which is the
    right direction for this particular failure: a new signing key makes every
    peer that pinned the old one refuse this machine's messages, so losing it
    breaks something *visibly*. The failure mode worth fearing is the opposite
    one — state that goes missing and takes a protection with it silently —
    and that is why ``trust_store`` refuses to start over the way this does.
    """
    path = keys_path()
    try:
        raw = json.loads(secret_files.read_private(path).decode("utf-8"))
        material = base64.b64decode(raw["ed25519_private"], validate=True)
        return Ed25519PrivateKey.from_private_bytes(material)
    except FileNotFoundError:
        pass
    except (OSError, ValueError, KeyError, TypeError) as exc:
        log.warning("device signing key %s is unusable (%s); generating a new one", path, exc)

    key = Ed25519PrivateKey.generate()
    _write_private(
        path,
        key.private_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PrivateFormat.Raw,
            encryption_algorithm=serialization.NoEncryption(),
        ),
    )
    log.info("generated a new device signing key at %s", path)
    return key


def private_key() -> Ed25519PrivateKey:
    with _lock:
        return _load_private()


def public_key() -> str:
    """This device's signing public key, base64, for publishing to the server."""
    raw = private_key().public_key().public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    )
    return base64.b64encode(raw).decode("ascii")


def is_public_key(value: Any) -> bool:
    """Whether *value* is shaped like a key ``verify`` could use. Checked on
    shape rather than on trust: every one of these arrives from the server."""
    if not isinstance(value, str) or not value:
        return False
    try:
        return len(base64.b64decode(value, validate=True)) == _KEY_LEN
    except (ValueError, TypeError):
        return False


def fingerprint(public_key_b64: str) -> str:
    """A short, human-comparable name for a key.

    Shown when a device is seen for the first time and, more importantly, when
    the key behind a device changes: the two fingerprints side by side are the
    only way a person can tell "they reinstalled" from "somebody is standing in
    for them". Truncated to 16 hex characters, which is far past what a human
    will compare and far short of inviting anyone to treat it as the identity.
    """
    if not isinstance(public_key_b64, str) or not public_key_b64:
        return ""
    digest = hashlib.sha256(public_key_b64.encode("utf-8")).hexdigest()[:16]
    return " ".join(digest[i : i + 4] for i in range(0, 16, 4))


# ---- what gets signed --------------------------------------------------------


def _canonical(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _signed_bytes(context: bytes, payload: dict[str, Any]) -> bytes:
    return context + _SEPARATOR + _canonical(payload)


def _body_digest(body: str) -> str:
    return base64.b64encode(hashlib.sha256(body.encode("utf-8")).digest()).decode("ascii")


def message_payload(
    *, msg_key: str, from_device: str, to_device: str, kind: str, body: str
) -> dict[str, Any]:
    """The tuple a message signature covers. ``kind`` is "cipher" or "text"."""
    return {
        "msgKey": msg_key,
        "from": from_device,
        "to": to_device,
        "kind": kind,
        "body": _body_digest(body),
    }


def sync_payload(
    *, scope: str, item_id: str, updated_at: str, deleted: bool, body: str
) -> dict[str, Any]:
    """The tuple a synced record's signature covers.

    The server's ``rev`` is deliberately absent: it is assigned after the
    signature is made, and a receiver that required it would be asking the
    relay to certify its own numbering. What the signature states is "this
    device wrote this body for this item at this time" — everything a peer
    needs to refuse a record the relay rewrote or moved to another item.
    """
    return {
        "scope": scope,
        "itemId": item_id,
        "updatedAt": updated_at,
        "deleted": bool(deleted),
        "body": _body_digest(body),
    }


def policy_payload(*, device_id: str, seq: int, document: Any) -> dict[str, Any]:
    """The tuple a policy signature covers.

    ``seq`` is the receiver's own counter, not the server's ``revision``:
    monotonicity checked against a number the server issues would be asking the
    one party with a motive to roll the policy back to certify that it did not.
    """
    return {"deviceId": device_id, "seq": seq, "policy": document}


# ---- signing and verifying ---------------------------------------------------


def _sign(context: bytes, payload: dict[str, Any]) -> str:
    try:
        return base64.b64encode(
            private_key().sign(_signed_bytes(context, payload))
        ).decode("ascii")
    except Exception as exc:  # noqa: BLE001 - never leak the reason
        raise SigningError("could not sign") from exc


def _verify(context: bytes, payload: dict[str, Any], signature: str, public_key_b64: str) -> bool:
    """Whether *signature* is this payload signed by that key.

    Returns False for every failure — malformed base64, wrong length, wrong
    key, tampered payload — rather than distinguishing them. The caller answers
    the wire identically in all four cases, so telling them apart here would
    only make it possible to tell them apart there.
    """
    if not is_public_key(public_key_b64) or not isinstance(signature, str) or not signature:
        return False
    try:
        raw = base64.b64decode(signature, validate=True)
    except (ValueError, TypeError):
        return False
    if len(raw) != _SIG_LEN:
        return False
    try:
        key = Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key_b64))
        key.verify(raw, _signed_bytes(context, payload))
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False


def sign_message(*, msg_key: str, from_device: str, to_device: str, kind: str, body: str) -> str:
    return _sign(
        _MESSAGE_CONTEXT,
        message_payload(
            msg_key=msg_key, from_device=from_device, to_device=to_device, kind=kind, body=body
        ),
    )


def verify_message(
    signature: str,
    *,
    public_key_b64: str,
    msg_key: str,
    from_device: str,
    to_device: str,
    kind: str,
    body: str,
) -> bool:
    return _verify(
        _MESSAGE_CONTEXT,
        message_payload(
            msg_key=msg_key, from_device=from_device, to_device=to_device, kind=kind, body=body
        ),
        signature,
        public_key_b64,
    )


def sign_message_v2(
    *, msg_key: str, from_device: str, to_device: str, kind: str, body: str, sent_at: int
) -> str:
    """The v2 signature as it travels in ``sig2``: ``v2.<sent_at>.<signature>``,
    the signature covering the v1 tuple plus the send time."""
    payload = {
        **message_payload(msg_key=msg_key, from_device=from_device, to_device=to_device, kind=kind, body=body),
        "sentAt": sent_at,
    }
    return f"v2.{sent_at}.{_sign(_MESSAGE_CONTEXT_V2, payload)}"


def verify_message_v2(
    signature: str,
    *,
    public_key_b64: str,
    msg_key: str,
    from_device: str,
    to_device: str,
    kind: str,
    body: str,
) -> int | None:
    """The send time a ``sig2`` vouches for, or None when it does not verify.
    Whether that time is acceptable is the caller's to decide."""
    if not isinstance(signature, str):
        return None
    parts = signature.split(".", 2)
    if len(parts) != 3 or parts[0] != "v2" or not parts[1].isdigit() or len(parts[1]) > 12:
        return None
    sent_at = int(parts[1])
    payload = {
        **message_payload(msg_key=msg_key, from_device=from_device, to_device=to_device, kind=kind, body=body),
        "sentAt": sent_at,
    }
    return sent_at if _verify(_MESSAGE_CONTEXT_V2, payload, parts[2], public_key_b64) else None


def sign_policy(*, device_id: str, seq: int, document: Any) -> str:
    return _sign(_POLICY_CONTEXT, policy_payload(device_id=device_id, seq=seq, document=document))


def verify_policy(
    signature: str, *, public_key_b64: str, device_id: str, seq: int, document: Any
) -> bool:
    return _verify(
        _POLICY_CONTEXT,
        policy_payload(device_id=device_id, seq=seq, document=document),
        signature,
        public_key_b64,
    )


def sign_sync(
    *, scope: str, item_id: str, updated_at: str, deleted: bool, body: str
) -> str:
    return _sign(
        _SYNC_CONTEXT,
        sync_payload(
            scope=scope, item_id=item_id, updated_at=updated_at, deleted=deleted, body=body
        ),
    )


def verify_sync(
    signature: str,
    *,
    public_key_b64: str,
    scope: str,
    item_id: str,
    updated_at: str,
    deleted: bool,
    body: str,
) -> bool:
    return _verify(
        _SYNC_CONTEXT,
        sync_payload(
            scope=scope, item_id=item_id, updated_at=updated_at, deleted=deleted, body=body
        ),
        signature,
        public_key_b64,
    )


def _reset_for_test() -> None:
    """Drop this process's signing key. Tests set AGENT_TEAM_DATA_DIR, so this
    only ever touches a temporary directory."""
    with _lock:
        keys_path().unlink(missing_ok=True)
