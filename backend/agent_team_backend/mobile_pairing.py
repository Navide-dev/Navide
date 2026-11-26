"""Pairing a phone with this machine: a QR code, six digits, one button.

The desktop shows a QR code carrying a one-time code, this machine's id, its
public signing key and a nonce. The phone scans it, sends the code with its own
public key and nonce through the server, and both screens derive the same six
digits from both keys and both nonces. A person compares them and presses
"Trust this phone"; this machine then signs the phone's key so the phone can
tell the approval came from the machine whose key it scanned.

The key arrives at the phone through the camera, not through the server, so a
relay that swapped either key on the way would make the two screens disagree.

**What is deliberately not here.** Offers and pending requests live in memory
only: a backend that restarts has forgotten every half-finished exchange, the
same safe direction as ``device_pairing``. The trusted-phone list is a small JSON
file of public keys and names. No phone private key ever exists on this side,
and nothing in that file is a secret.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import secrets
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from agent_team_backend import device_signing
from agent_team_backend.applog import app_data_dir
from agent_team_backend.osplat import secret_files

log = logging.getLogger(__name__)

#: How long a QR code can be redeemed. Long enough to find the phone and open
#: the app; short enough that a photo of the screen goes stale quickly.
OFFER_TTL_S = 300.0
#: How long a scanned request waits for somebody to compare the digits.
REQUEST_TTL_S = 300.0

_SAS_DOMAIN = b"navide/mobile-pair/v1"
_APPROVAL_DOMAIN = "navide/mobile-approval/v1"
_KEY_LEN = 32
_MAX_NAME = 80

TRUSTED_FILENAME = "mobile-phones.json"


class MobilePairingError(Exception):
    """A request that cannot be acted on. Carries no key material."""


@dataclass
class Offer:
    code: str
    nonce: str
    code_hash: str
    expires_at: float


@dataclass
class PairRequest:
    request_id: str
    phone_key: str
    phone_nonce: str
    device_name: str
    code: str
    received_at: float
    expires_at: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "requestId": self.request_id,
            "deviceName": self.device_name,
            "code": self.code,
            "receivedAt": self.received_at,
            "expiresAt": self.expires_at,
        }


_lock = threading.Lock()
_offer: Offer | None = None
_requests: dict[str, PairRequest] = {}


# ---- encoding and crypto -------------------------------------------------------


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def from_b64url(text: str) -> bytes:
    padded = text + "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def code_hash(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def pairing_code(
    desktop_key: bytes, phone_key: bytes, desktop_nonce: str, phone_nonce: str
) -> str:
    """The six digits both screens show, derived from both keys and both nonces."""
    digest = hashlib.sha256(
        _SAS_DOMAIN
        + desktop_key
        + phone_key
        + desktop_nonce.encode("utf-8")
        + phone_nonce.encode("utf-8")
    ).digest()
    return f"{int.from_bytes(digest[:4], 'big') % 1_000_000:06d}"


def approval_message(device_id: str, phone_key: str, phone_nonce: str) -> bytes:
    """The exact bytes this machine signs when somebody presses "Trust"."""
    return f"{_APPROVAL_DOMAIN}\n{device_id}\n{phone_key}\n{phone_nonce}".encode("utf-8")


def desktop_key_raw() -> bytes:
    return base64.b64decode(device_signing.public_key())


def sign_approval(device_id: str, phone_key: str, phone_nonce: str) -> str:
    """This machine's Ed25519 signature over the approval, base64url."""
    try:
        signature = device_signing.private_key().sign(
            approval_message(device_id, phone_key, phone_nonce)
        )
    except Exception as exc:  # noqa: BLE001 - never leak the reason
        raise device_signing.SigningError("could not sign") from exc
    return b64url(signature)


def _valid_phone_key(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        return len(from_b64url(value)) == _KEY_LEN
    except (ValueError, TypeError):
        return False


# ---- offers ----------------------------------------------------------------------


def _purge(now: float) -> None:
    global _offer
    if _offer is not None and _offer.expires_at <= now:
        _offer = None
    for request_id in [r for r, req in _requests.items() if req.expires_at <= now]:
        _requests.pop(request_id, None)


def create_offer() -> Offer:
    """A fresh offer, replacing any earlier one: one QR code on screen at a time."""
    global _offer
    code = secrets.token_urlsafe(16)
    offer = Offer(
        code=code,
        nonce=secrets.token_urlsafe(16),
        code_hash=code_hash(code),
        expires_at=time.time() + OFFER_TTL_S,
    )
    with _lock:
        _offer = offer
    return offer


def cancel_offer(offer: Offer) -> None:
    global _offer
    with _lock:
        if _offer is offer:
            _offer = None


def active_offer() -> Offer | None:
    with _lock:
        _purge(time.time())
        return _offer


def offer_text(device_id: str, offer: Offer, desktop_key: bytes) -> str:
    """What the QR code says. Read by the phone's ``parseOffer``."""
    query = urlencode(
        [
            ("v", "1"),
            ("d", device_id),
            ("k", b64url(desktop_key)),
            ("n", offer.nonce),
            ("c", offer.code),
        ]
    )
    return f"navide://pair?{query}"


# ---- requests --------------------------------------------------------------------


def receive_request(payload: Any, desktop_key: bytes) -> PairRequest | None:
    """A phone redeemed a code. Kept only when it matches the live offer.

    The offer is single use: the first matching request consumes it, so a
    second phone holding the same photo of the screen gets nothing.
    """
    global _offer
    if not isinstance(payload, dict):
        return None
    request_id = str(payload.get("requestId") or "")
    hashed = str(payload.get("codeHash") or "")
    phone_key = payload.get("phoneKey")
    phone_nonce = payload.get("phoneNonce")
    if not request_id or not hashed or not _valid_phone_key(phone_key):
        return None
    if not isinstance(phone_nonce, str) or not phone_nonce:
        return None
    device_name = str(payload.get("deviceName") or "").strip()[:_MAX_NAME]
    now = time.time()
    with _lock:
        _purge(now)
        offer = _offer
        if offer is None or not secrets.compare_digest(offer.code_hash, hashed):
            return None
        _offer = None
        request = PairRequest(
            request_id=request_id,
            phone_key=phone_key,
            phone_nonce=phone_nonce,
            device_name=device_name,
            code=pairing_code(desktop_key, from_b64url(phone_key), offer.nonce, phone_nonce),
            received_at=now,
            expires_at=now + REQUEST_TTL_S,
        )
        _requests[request_id] = request
    return request


def get_request(request_id: str) -> PairRequest | None:
    with _lock:
        _purge(time.time())
        return _requests.get(request_id)


def take_request(request_id: str) -> PairRequest | None:
    with _lock:
        _purge(time.time())
        return _requests.pop(request_id, None)


def pending_requests() -> list[PairRequest]:
    with _lock:
        _purge(time.time())
        return sorted(_requests.values(), key=lambda r: r.received_at)


# ---- trusted phones --------------------------------------------------------------


def trusted_path() -> Path:
    return app_data_dir() / TRUSTED_FILENAME


def load_trusted() -> list[dict[str, Any]]:
    path = trusted_path()
    try:
        raw = json.loads(secret_files.read_private(path).decode("utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as exc:
        log.warning("trusted phone list %s is unreadable (%s)", path, exc)
        return []
    phones = raw.get("phones") if isinstance(raw, dict) else None
    return [p for p in phones if isinstance(p, dict) and p.get("phoneId")] if isinstance(phones, list) else []


def _save_trusted(phones: list[dict[str, Any]]) -> None:
    payload = json.dumps({"version": 1, "phones": phones}, ensure_ascii=False)
    secret_files.write_private(trusted_path(), payload.encode("utf-8"))


def add_trusted(phone_id: str, device_name: str, public_key: str) -> dict[str, Any]:
    with _lock:
        phones = [p for p in load_trusted() if p.get("phoneId") != phone_id]
        entry = {
            "phoneId": phone_id,
            "deviceName": device_name,
            "publicKey": public_key,
            "pairedAt": time.time(),
        }
        phones.append(entry)
        _save_trusted(phones)
    return entry


def remove_trusted(phone_id: str) -> bool:
    with _lock:
        phones = load_trusted()
        kept = [p for p in phones if p.get("phoneId") != phone_id]
        if len(kept) == len(phones):
            return False
        _save_trusted(kept)
    return True


def _reset_for_test() -> None:
    global _offer
    with _lock:
        _offer = None
        _requests.clear()
