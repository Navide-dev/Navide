"""Publisher identity via bearer tokens (p3-publish).

A publisher authenticates with `Authorization: Bearer <token>`; the token is
matched (by sha256) against `Publisher.token_hash`. In dev (`require_auth`
False) an anonymous caller is allowed and the publisher is taken from the
manifest, preserving the pre-auth behavior. Namespace entitlement (a publisher
may only publish under its own namespace) is enforced by the endpoints using
the resolved identity.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Header, HTTPException, Request
from sqlmodel import Session

from . import qualification
from .account_auth import BearerError, parse_bearer, resolve

DEV_PUBLISHER = "dev"


@dataclass(frozen=True)
class PublisherIdentity:
    publisher: str | None
    authenticated: bool
    actor: str | None = None
    """Audit actor for an authenticated caller (account_auth.Bearer.actor)."""


def _parse_bearer(authorization: str | None) -> str | None:
    return parse_bearer(authorization)


def get_publisher_identity(
    request: Request,
    authorization: str | None = Header(default=None),
    x_publisher: str | None = Header(default=None),
) -> PublisherIdentity:
    """Resolve the calling publisher from a bearer token, or dev fallback.

    Errors carry a stable code in `detail.code`: 401 TOKEN_MISSING /
    TOKEN_INVALID / TOKEN_REVOKED / TOKEN_EXPIRED, 403 TOKEN_SCOPE (an
    account token), QUALIFICATION_REQUIRED or NAMESPACE_FROZEN."""
    state = request.app.state.registry
    token = _parse_bearer(authorization)
    if token is not None:
        with Session(state.engine) as session:
            try:
                bearer = resolve(session, token)
            except BearerError as exc:
                raise exc.http() from exc
            if bearer.publisher is None:
                raise HTTPException(
                    status_code=403,
                    detail={
                        "code": "TOKEN_SCOPE",
                        "message": "an account token cannot publish or yank; use a publisher token",
                    },
                )
            problem = qualification.publisher_problem(session, bearer.publisher)
            if problem is not None:
                raise HTTPException(status_code=403, detail={"code": problem[0], "message": problem[1]})
            return PublisherIdentity(publisher=bearer.publisher.name, authenticated=True, actor=bearer.actor)

    if state.settings.require_auth:
        raise HTTPException(
            status_code=401,
            detail={"code": "TOKEN_MISSING", "message": "missing publisher bearer token"},
        )
    # Dev fallback: anonymous; publisher comes from the manifest downstream.
    return PublisherIdentity(publisher=x_publisher, authenticated=False)
