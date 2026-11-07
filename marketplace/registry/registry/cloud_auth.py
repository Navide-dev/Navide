"""Navide Cloud sign-in through navide-auth, and the registry's own session.

The registry is navide-auth's `registry` client: it signs a request with its
own client secret (never Discourse's), navide-auth checks the password and
account state, and redirects back to `/auth/callback` with a payload signed
by the same secret. The payload carries only the member id, display name and
the email-verified flag. The registry then issues its own session cookie; the
Navide account token never reaches the registry.

Wire format (shared with navide-auth's client-connect.ts): `sso` is base64 of
a form-encoded querystring and `sig` is hex HMAC-SHA256 over the base64
string itself.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
import urllib.parse
from dataclasses import dataclass

from fastapi import Request, Response
from sqlalchemy import Engine
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlmodel import Session

from . import host_routing
from .config import Settings
from .models import MemberSession

SESSION_COOKIE = "navide_registry_session"
LOGIN_STATE_COOKIE = "navide_registry_login"
SESSION_TTL_SECONDS = 12 * 3600
LOGIN_STATE_TTL_SECONDS = 10 * 60
CLIENT_ID = "registry"
MAX_CLOCK_SKEW_SECONDS = 60


@dataclass(frozen=True)
class Viewer:
    member_id: str
    name: str
    session_id: str
    is_admin: bool


def constant_time_equal(a: str, b: str) -> bool:
    """hmac.compare_digest on bytes: on `str` it raises TypeError for any
    non-ASCII input, which would turn a hostile value into a 500."""
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


# -- DiscourseConnect-style wire -----------------------------------------
def sign(secret: str, sso: str) -> str:
    return hmac.new(secret.encode(), sso.encode(), hashlib.sha256).hexdigest()


def encode_payload(fields: dict[str, str]) -> str:
    return base64.b64encode(urllib.parse.urlencode(fields).encode()).decode()


def decode_payload(sso: str) -> dict[str, str] | None:
    try:
        raw = base64.b64decode(sso.encode(), validate=True).decode()
    except (ValueError, UnicodeDecodeError):
        return None
    return dict(urllib.parse.parse_qsl(raw, keep_blank_values=True))


def build_login_redirect(settings: Settings, nonce: str, return_url: str | None = None) -> str:
    sso = encode_payload({"nonce": nonce, "return_sso_url": return_url or settings.auth_return_url})
    query = urllib.parse.urlencode({"sso": sso, "sig": sign(settings.auth_secret, sso)})
    return f"{settings.auth_url}/{CLIENT_ID}/sso?{query}"


@dataclass(frozen=True)
class CallbackIdentity:
    member_id: str
    name: str


def verify_callback(
    settings: Settings, sso: str, sig: str, expected_nonce: str, now: float
) -> CallbackIdentity | None:
    """Signature, client, nonce, freshness and email-verified, in that order."""
    if not sso or not sig or len(sig) != 64:
        return None
    if not constant_time_equal(sign(settings.auth_secret, sso), sig.lower()):
        return None
    fields = decode_payload(sso)
    if fields is None or fields.get("client") != CLIENT_ID:
        return None
    if not constant_time_equal(fields.get("nonce", ""), expected_nonce):
        return None
    try:
        issued_at = int(fields.get("issued_at", "")) / 1000
    except ValueError:
        return None
    if not (now - LOGIN_STATE_TTL_SECONDS <= issued_at <= now + MAX_CLOCK_SKEW_SECONDS):
        return None
    if fields.get("email_verified") != "true":
        return None
    member_id = fields.get("external_id", "").strip()
    if not member_id:
        return None
    return CallbackIdentity(member_id=member_id, name=fields.get("name", "").strip() or member_id)


# -- signed cookies ------------------------------------------------------
def _key(settings: Settings, purpose: str) -> bytes:
    return hmac.new(settings.session_secret.encode(), purpose.encode(), hashlib.sha256).digest()


def seal(settings: Settings, purpose: str, value: dict) -> str:
    body = base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).decode().rstrip("=")
    mac = hmac.new(_key(settings, purpose), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{mac}"


def unseal(settings: Settings, purpose: str, token: str | None, now: float) -> dict | None:
    if not token or "." not in token:
        return None
    body, _, mac = token.rpartition(".")
    expected = hmac.new(_key(settings, purpose), body.encode(), hashlib.sha256).hexdigest()
    if not constant_time_equal(expected, mac):
        return None
    try:
        value = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(value, dict) or not isinstance(value.get("exp"), (int, float)):
        return None
    if value["exp"] < now:
        return None
    return value


def cookie_path(request: Request) -> str:
    return request.scope.get("root_path", "").rstrip("/") or "/"


def set_cookie(response: Response, request: Request, settings: Settings, name: str, value: str, max_age: int) -> None:
    response.set_cookie(
        name,
        value,
        max_age=max_age,
        path=cookie_path(request),
        secure=settings.cookie_secure,
        httponly=True,
        samesite="lax",
    )


def clear_cookie(response: Response, request: Request, settings: Settings, name: str) -> None:
    response.delete_cookie(
        name, path=cookie_path(request), secure=settings.cookie_secure, httponly=True, samesite="lax"
    )


def return_url(request: Request) -> str:
    """The callback navide-auth returns to: the storefront and the developer
    console each sign in on their own host (host-only cookies), and any other
    host uses the configured REGISTRY_AUTH_RETURN_URL."""
    settings: Settings = request.app.state.registry.settings
    role = host_routing.request_role(request)
    if role in (host_routing.STORE, host_routing.DEVELOPER):
        return host_routing.origin_for(settings, role) + "/auth/callback"
    return settings.auth_return_url


def start_login(
    settings: Settings, next_path: str, now: float, return_url: str | None = None
) -> tuple[str, str]:
    """Return (login-state cookie value, navide-auth redirect URL)."""
    nonce = secrets.token_urlsafe(24)
    state = seal(
        settings,
        "login-state",
        {"nonce": nonce, "next": next_path, "exp": now + LOGIN_STATE_TTL_SECONDS},
    )
    return state, build_login_redirect(settings, nonce, return_url)


def session_version(engine: Engine, member_id: str) -> int:
    with Session(engine) as session:
        row = session.get(MemberSession, member_id)
        return row.version if row is not None else 0


def revoke_sessions(engine: Engine, member_id: str) -> None:
    """Invalidate every session this account holds (sign-out)."""
    statement = sqlite_insert(MemberSession).values(member_id=member_id, version=1)
    statement = statement.on_conflict_do_update(
        index_elements=["member_id"], set_={"version": MemberSession.version + 1}
    )
    with Session(engine) as session:
        session.execute(statement)
        session.commit()


def new_session(settings: Settings, identity: CallbackIdentity, now: float, version: int) -> str:
    return seal(
        settings,
        "session",
        {
            "mid": identity.member_id,
            "name": identity.name,
            "sid": secrets.token_urlsafe(16),
            "ver": version,
            "exp": now + SESSION_TTL_SECONDS,
        },
    )


def current_viewer(request: Request) -> Viewer | None:
    settings: Settings = request.app.state.registry.settings
    if not settings.cloud_auth_enabled:
        return None
    value = unseal(settings, "session", request.cookies.get(SESSION_COOKIE), time.time())
    if value is None:
        return None
    member_id = str(value.get("mid", ""))
    if not member_id:
        return None
    if value.get("ver") != session_version(request.app.state.registry.engine, member_id):
        return None
    return Viewer(
        member_id=member_id,
        name=str(value.get("name", member_id)),
        session_id=str(value.get("sid", "")),
        is_admin=member_id in settings.admin_member_ids,
    )


def csrf_token(settings: Settings, viewer: Viewer) -> str:
    return hmac.new(_key(settings, "csrf"), viewer.session_id.encode(), hashlib.sha256).hexdigest()


def csrf_ok(settings: Settings, viewer: Viewer, presented: str | None) -> bool:
    return bool(presented) and constant_time_equal(csrf_token(settings, viewer), presented)


def viewer_context(request: Request) -> dict:
    """Template context: who is signed in, and the header's sign-out token."""
    settings: Settings = request.app.state.registry.settings
    viewer = current_viewer(request)
    return {
        "viewer": viewer,
        "csrf": csrf_token(settings, viewer) if viewer is not None else "",
        "cloud_auth": settings.cloud_auth_enabled,
    }


def safe_next(value: str | None, default: str = "/publisher") -> str:
    """A local path under the site, never an absolute or protocol-relative URL."""
    if not value or not value.startswith("/") or value.startswith("//") or "\\" in value:
        return default
    return value
