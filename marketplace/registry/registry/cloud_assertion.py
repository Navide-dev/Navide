"""Navide-Server sign-in assertions for `POST /api/cli/cloud-exchange`.

A desktop App already signed in to Navide Cloud asks Navide-Server for a
short-lived assertion naming the member, then exchanges it here together with
its PKCE code_verifier for the same `nva_` / `nvp_` tokens the browser sign-in
issues. The format is fixed by the three-party contract:

    nvsa1.<kid>.<payload_b64>.<sig_b64>

base64url without padding; Ed25519 over the ASCII bytes `nvsa1.<kid>.<payload_b64>`;
at most 4096 bytes. The keys are static public keys from
REGISTRY_CLOUD_ASSERTION_KEYS_FILE (config.py), never fetched at runtime.

The checks run in the contract's order and each failure names a stable code:
ASSERTION_INVALID or ASSERTION_EXPIRED (401), then ASSERTION_REPLAYED once the
jti was already redeemed. An assertion is never logged or stored; only its jti
is, to make it single-use.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from sqlalchemy import delete
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session

from .config import CLOUD_ASSERTION_KID_PATTERN
from .models import UsedCloudAssertion
from .self_service import pkce_challenge

PREFIX = "nvsa1"
MAX_ASSERTION_BYTES = 4096
ISSUER = "navide-server"
AUDIENCE = "registry"
SCOPE_ACCOUNT = "account"
SCOPE_PUBLISH = "publish"
CLOCK_SKEW_SECONDS = 30
MAX_LIFETIME_SECONDS = 60
MAX_MEMBER_ID_LENGTH = 128
PRUNE_AFTER = timedelta(minutes=5)
"""A used jti is kept this long past its assertion's `exp`: by then the
assertion fails the expiry check (exp + CLOCK_SKEW_SECONDS) before the jti
table is consulted, so dropping the row cannot reopen a replay."""

CLOUD_EXCHANGE_FAILURES_PER_WINDOW = 30
CLOUD_EXCHANGE_FAILURE_WINDOW_SECONDS = 600
"""Failed verifications allowed per client address before every exchange from
it is refused for the rest of the window. A real App fails at most a few
times (clock skew, a key rotation); anything more is someone probing."""

INVALID = "ASSERTION_INVALID"
EXPIRED = "ASSERTION_EXPIRED"
REPLAYED = "ASSERTION_REPLAYED"

_B64URL = re.compile(r"^[A-Za-z0-9_-]+$")
_CHALLENGE = re.compile(r"^[A-Za-z0-9_-]{43,128}$")
_JTI = re.compile(r"^[A-Za-z0-9_-]{22,128}$")
_FIELDS = {
    "iss": str,
    "aud": str,
    "sub": str,
    "name": str,
    "email_verified": bool,
    "scope": str,
    "challenge": str,
    "iat": int,
    "exp": int,
    "jti": str,
}
# `namespace` is also required but is a string or null; checked separately.


class AssertionRejected(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class CloudAssertion:
    kid: str
    sub: str
    scope: str
    namespace: str | None
    challenge: str
    iat: int
    exp: int
    jti: str


def _b64decode(value: str) -> bytes:
    if not _B64URL.match(value):
        raise ValueError("not unpadded base64url")
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _no_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate key {key!r}")
        result[key] = value
    return result


def _public_keys(keys: tuple[tuple[str, str], ...]) -> dict[str, Ed25519PublicKey]:
    loaded = {}
    for kid, pem in keys:
        key = serialization.load_pem_public_key(pem.encode("ascii"))
        if isinstance(key, Ed25519PublicKey):  # Settings already refused anything else
            loaded[kid] = key
    return loaded


def verify(assertion: str, keys: tuple[tuple[str, str], ...], *, now: int) -> CloudAssertion:
    """Contract steps 2-4: format, signature, claims, lifetime. Raises
    AssertionRejected; nothing is written."""
    # Step 2: format, length, kid, signature.
    if len(assertion.encode("utf-8")) > MAX_ASSERTION_BYTES:
        raise AssertionRejected(INVALID, "assertion is too long")
    parts = assertion.split(".")
    if len(parts) != 4 or parts[0] != PREFIX or not CLOUD_ASSERTION_KID_PATTERN.match(parts[1]):
        raise AssertionRejected(INVALID, "malformed assertion")
    _, kid, payload_b64, sig_b64 = parts
    try:
        payload_raw = _b64decode(payload_b64)
        signature = _b64decode(sig_b64)
    except (ValueError, binascii.Error) as exc:
        raise AssertionRejected(INVALID, "malformed assertion") from exc
    key = _public_keys(keys).get(kid)
    if key is None:
        raise AssertionRejected(INVALID, "unknown signing key")
    try:
        key.verify(signature, f"{PREFIX}.{kid}.{payload_b64}".encode("ascii"))
    except InvalidSignature as exc:
        raise AssertionRejected(INVALID, "bad assertion signature") from exc

    # Step 3: issuer, audience, every field present with its type, verified email.
    try:
        payload = json.loads(payload_raw.decode("utf-8"), object_pairs_hook=_no_duplicate_keys)
    except (UnicodeError, ValueError) as exc:
        raise AssertionRejected(INVALID, "assertion payload is not a JSON object") from exc
    if not isinstance(payload, dict):
        raise AssertionRejected(INVALID, "assertion payload is not a JSON object")
    for field, kind in _FIELDS.items():
        value = payload.get(field)
        # bool is an int subclass: an integer field never accepts true/false.
        if not isinstance(value, kind) or (kind is int and isinstance(value, bool)):
            raise AssertionRejected(INVALID, f"assertion field {field} is missing or has the wrong type")
    if "namespace" not in payload or not isinstance(payload["namespace"], (str, type(None))):
        raise AssertionRejected(INVALID, "assertion field namespace is missing or has the wrong type")
    if payload["iss"] != ISSUER or payload["aud"] != AUDIENCE:
        raise AssertionRejected(INVALID, "assertion is not for this registry")
    if payload["email_verified"] is not True:
        raise AssertionRejected(INVALID, "the account's email is not verified")
    sub = payload["sub"]
    if not sub or len(sub) > MAX_MEMBER_ID_LENGTH:
        raise AssertionRejected(INVALID, "assertion field sub is invalid")
    scope, namespace = payload["scope"], payload["namespace"]
    if not (
        (scope == SCOPE_ACCOUNT and namespace is None)
        or (scope == SCOPE_PUBLISH and isinstance(namespace, str) and namespace)
    ):
        raise AssertionRejected(INVALID, "assertion scope and namespace do not match")
    if not _CHALLENGE.match(payload["challenge"]) or not _JTI.match(payload["jti"]):
        raise AssertionRejected(INVALID, "assertion challenge or jti is malformed")

    # Step 4: lifetime.
    iat, exp = payload["iat"], payload["exp"]
    if exp < iat or exp - iat > MAX_LIFETIME_SECONDS:
        raise AssertionRejected(INVALID, "assertion lifetime is invalid")
    if iat > now + CLOCK_SKEW_SECONDS:
        raise AssertionRejected(INVALID, "assertion is issued in the future")
    if now > exp + CLOCK_SKEW_SECONDS:
        raise AssertionRejected(EXPIRED, "assertion has expired")
    return CloudAssertion(
        kid=kid,
        sub=sub,
        scope=scope,
        namespace=namespace,
        challenge=payload["challenge"],
        iat=iat,
        exp=exp,
        jti=payload["jti"],
    )


def check_binding(claims: CloudAssertion, *, code_verifier: str, scope: str, namespace: str | None) -> None:
    """Contract steps 5-6: the caller holds the PKCE verifier the assertion
    was issued for, and asks for exactly what the assertion names."""
    if not secrets.compare_digest(pkce_challenge(code_verifier).encode(), claims.challenge.encode()):
        raise AssertionRejected(INVALID, "code_verifier does not match the assertion")
    if scope != claims.scope or namespace != claims.namespace:
        raise AssertionRejected(INVALID, "requested scope or namespace differs from the assertion")


def burn(session: Session, claims: CloudAssertion, *, now: datetime | None = None) -> None:
    """Contract step 7: record the jti, or raise ASSERTION_REPLAYED. From here
    on the assertion is spent even if issuing the token fails. Expired rows
    are pruned in the same transaction, so the table stays small without a
    separate job."""
    now = now or datetime.now(timezone.utc)
    session.execute(delete(UsedCloudAssertion).where(UsedCloudAssertion.expires_at < now - PRUNE_AFTER))
    session.add(
        UsedCloudAssertion(
            jti=claims.jti,
            navide_member_id=claims.sub,
            expires_at=datetime.fromtimestamp(claims.exp, timezone.utc),
            used_at=now,
        )
    )
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise AssertionRejected(REPLAYED, "this assertion was already used") from exc
