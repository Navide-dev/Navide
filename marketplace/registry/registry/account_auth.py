"""Bearer tokens that name a Navide Cloud account.

Two kinds of bearer reach the JSON API:
- publisher tokens (`nvp_…` from the dashboard or `navide-plugin login`, or
  an admin-issued long-lived token): scoped to one namespace, may publish;
- account tokens (`nva_…` from `/cli/authorize?scope=account`): name the
  account only. They read and submit the account's own developer
  application, list its versions and identify it to testplace downloads;
  they never publish.

`resolve` tells a missing, unknown, revoked and expired token apart so every
caller can return the stable 401 codes TOKEN_MISSING, TOKEN_INVALID,
TOKEN_REVOKED and TOKEN_EXPIRED.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import Header, HTTPException, Request
from sqlalchemy import update
from sqlmodel import Session, select

from . import audit
from .models import AccountAuthCode, AccountToken, Publisher, PublisherToken
from .repository import hash_token
from .self_service import CLI_CODE_TTL, SelfServiceError, _label, pkce_challenge

ACCOUNT_TOKEN_PREFIX = "nva_"
ACCOUNT_TOKEN_DAYS = 30
SCOPE_PUBLISHER = "publisher"
SCOPE_ACCOUNT = "account"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


class BearerError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message

    def http(self) -> HTTPException:
        return HTTPException(status_code=401, detail={"code": self.code, "message": self.message})


@dataclass(frozen=True)
class Bearer:
    scope: str
    """'publisher' or 'account'."""
    member_id: str | None
    """The Cloud account behind the token; None for a first-party publisher."""
    publisher: Publisher | None
    """The namespace a publisher token is scoped to; None for an account token."""
    actor: str
    """Audit actor for actions taken with this token."""
    expires_at: datetime | None
    """None for an admin-issued long-lived publisher token."""


def parse_bearer(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return None
    return token.strip()


def _state_error(revoked_at: datetime | None, expires_at: datetime) -> BearerError | None:
    if revoked_at is not None:
        return BearerError("TOKEN_REVOKED", "this token was revoked")
    if _aware(expires_at) <= _now():
        return BearerError("TOKEN_EXPIRED", "this token has expired")
    return None


def _publisher_actor(publisher: Publisher) -> str:
    if publisher.navide_member_id is not None:
        return audit.member_actor(publisher.navide_member_id)
    return f"publisher:{publisher.name}"


def resolve(session: Session, token: str) -> Bearer:
    """Resolve a bearer token, recording its last use. Raises BearerError."""
    digest = hash_token(token)
    publisher = session.exec(select(Publisher).where(Publisher.token_hash == digest)).first()
    if publisher is not None:
        return Bearer(SCOPE_PUBLISHER, publisher.navide_member_id, publisher, _publisher_actor(publisher), None)
    row = session.exec(select(PublisherToken).where(PublisherToken.token_hash == digest)).first()
    if row is not None:
        error = _state_error(row.revoked_at, row.expires_at)
        if error is not None:
            raise error
        row.last_used_at = _now()
        session.add(row)
        session.commit()
        publisher = session.get(Publisher, row.publisher_id)
        return Bearer(
            SCOPE_PUBLISHER, publisher.navide_member_id, publisher, _publisher_actor(publisher), _aware(row.expires_at)
        )
    account = session.exec(select(AccountToken).where(AccountToken.token_hash == digest)).first()
    if account is not None:
        error = _state_error(account.revoked_at, account.expires_at)
        if error is not None:
            raise error
        account.last_used_at = _now()
        session.add(account)
        session.commit()
        member_id = account.navide_member_id
        return Bearer(SCOPE_ACCOUNT, member_id, None, audit.member_actor(member_id), _aware(account.expires_at))
    raise BearerError("TOKEN_INVALID", "unknown token")


def require_bearer(session: Session, authorization: str | None) -> Bearer:
    token = parse_bearer(authorization)
    if token is None:
        raise BearerError("TOKEN_MISSING", "missing bearer token")
    return resolve(session, token)


def member_for_bearer(session: Session, authorization: str | None) -> str | None:
    """The Cloud account behind an account or publisher token, or None (no
    token, a bad one, or a first-party publisher token with no owner)."""
    try:
        return require_bearer(session, authorization).member_id
    except BearerError:
        return None


def require_member(request: Request, authorization: str | None = Header(default=None)) -> str:
    """FastAPI dependency: the calling Cloud account, or 401 with a stable code."""
    with Session(request.app.state.registry.engine) as session:
        try:
            bearer = require_bearer(session, authorization)
        except BearerError as exc:
            raise exc.http() from exc
    if bearer.member_id is None:
        raise BearerError("TOKEN_INVALID", "this token does not belong to a Navide Cloud account").http()
    return bearer.member_id


# -- account tokens through PKCE -----------------------------------------
def create_account_token(session: Session, member_id: str, *, label: str) -> tuple[str, AccountToken]:
    """Return (plain token, row); the plain token is never stored. Commits."""
    plain = ACCOUNT_TOKEN_PREFIX + secrets.token_urlsafe(32)
    row = AccountToken(
        navide_member_id=member_id,
        label=_label(label),
        token_hash=hash_token(plain),
        expires_at=_now() + timedelta(days=ACCOUNT_TOKEN_DAYS),
    )
    session.add(row)
    session.flush()
    audit.record(
        session,
        actor=audit.member_actor(member_id),
        action="account-token.issue",
        target=f"member:{member_id}",
        detail={"token_id": row.id, "label": row.label},
    )
    session.commit()
    session.refresh(row)
    return plain, row


def issue_account_code(session: Session, member_id: str, *, code_challenge: str, label: str) -> str:
    if not (43 <= len(code_challenge) <= 128):
        raise SelfServiceError("invalid code_challenge")
    code = secrets.token_urlsafe(32)
    session.add(
        AccountAuthCode(
            code_hash=hash_token(code),
            navide_member_id=member_id,
            code_challenge=code_challenge,
            label=_label(label),
            expires_at=_now() + CLI_CODE_TTL,
        )
    )
    session.commit()
    return code


def find_account_code(session: Session, code: str) -> AccountAuthCode | None:
    return session.exec(select(AccountAuthCode).where(AccountAuthCode.code_hash == hash_token(code))).first()


def exchange_account_code(session: Session, *, code: str, code_verifier: str) -> tuple[str, AccountToken]:
    """Same burn-then-verify rules as self_service.exchange_cli_code."""
    row = find_account_code(session, code)
    if row is None or row.used_at is not None or _aware(row.expires_at) <= _now():
        raise SelfServiceError("invalid or expired code")
    burned = session.execute(
        update(AccountAuthCode)
        .where(AccountAuthCode.id == row.id, AccountAuthCode.used_at.is_(None))
        .values(used_at=_now())
    )
    session.commit()
    if burned.rowcount != 1:
        raise SelfServiceError("invalid or expired code")
    if not secrets.compare_digest(pkce_challenge(code_verifier).encode(), row.code_challenge.encode()):
        raise SelfServiceError("invalid or expired code")
    return create_account_token(session, row.navide_member_id, label=row.label)
