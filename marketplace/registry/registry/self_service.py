"""Self-service publishing for Navide Cloud accounts (D6, D7, D9).

- Namespace claims: first come, first served; reserved words and look-alikes
  are refused (similarity.py); at most MAX_NAMESPACES_PER_ACCOUNT per account.
  A claimed namespace is review-required: nothing it publishes is public
  before an admin approves it.
- Publish tokens: random, stored as sha256, scoped to one namespace, with an
  expiry of at most MAX_TOKEN_DAYS and revocable from the dashboard.
- CLI login codes: one-time, 5-minute codes bound to a PKCE challenge; the
  CLI exchanges code + verifier for a publish token.
- Domain verification: optional DNS TXT proof (dns_verify.py); unverified
  publishers can still publish, only without the badge.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import Boolean, DateTime, String, func, insert, literal, update
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from . import audit, qualification
from .dns_verify import TxtResolver, is_verified, new_token, normalize_domain
from .models import CliAuthCode, Publisher, PublisherToken
from .repository import hash_token
from .signing import public_key_fingerprint
from .similarity import ClaimVerdict, check_namespace_claim

MAX_NAMESPACES_PER_ACCOUNT = 3
DEFAULT_TOKEN_DAYS = 30
MAX_TOKEN_DAYS = 90
CLI_TOKEN_DAYS = 30
CLI_CODE_TTL = timedelta(minutes=5)
MAX_LABEL_LENGTH = 64
TOKEN_PREFIX = "nvp_"


class SelfServiceError(ValueError):
    pass


class QualificationRequired(SelfServiceError):
    """The account's developer qualification is not approved, or the
    namespace is frozen; `code` is QUALIFICATION_REQUIRED or NAMESPACE_FROZEN."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _require_vetted(session: Session, publisher: Publisher) -> None:
    problem = qualification.publisher_problem(session, publisher)
    if problem is not None:
        raise QualificationRequired(*problem)


def _owner_actor(publisher: Publisher) -> str:
    if publisher.navide_member_id is None:
        return f"publisher:{publisher.name}"
    return audit.member_actor(publisher.navide_member_id)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


# -- namespaces -----------------------------------------------------------
def owned_publishers(session: Session, member_id: str) -> list[Publisher]:
    return list(
        session.exec(
            select(Publisher).where(Publisher.navide_member_id == member_id).order_by(Publisher.name)
        ).all()
    )


def owned_publisher(session: Session, member_id: str, namespace: str) -> Publisher | None:
    return session.exec(
        select(Publisher).where(Publisher.name == namespace, Publisher.navide_member_id == member_id)
    ).first()


def check_claim(session: Session, member_id: str, namespace: str) -> ClaimVerdict:
    namespace = namespace.strip().lower()
    if not qualification.is_approved(session, member_id):
        return ClaimVerdict(
            False,
            "Only an approved developer can claim a namespace. Apply for developer "
            "qualification first and wait for review.",
        )
    if len(owned_publishers(session, member_id)) >= MAX_NAMESPACES_PER_ACCOUNT:
        return ClaimVerdict(
            False, f"An account can own at most {MAX_NAMESPACES_PER_ACCOUNT} namespaces."
        )
    taken = session.exec(select(Publisher.name)).all()
    return check_namespace_claim(namespace, taken)


def claim_namespace(session: Session, *, member_id: str, display_name: str, namespace: str) -> Publisher:
    namespace = namespace.strip().lower()
    if not qualification.is_approved(session, member_id):
        raise QualificationRequired(
            "QUALIFICATION_REQUIRED", check_claim(session, member_id, namespace).message
        )
    verdict = check_claim(session, member_id, namespace)
    if not verdict.ok:
        raise SelfServiceError(verdict.message)
    # One INSERT ... SELECT: SQLite evaluates the per-account count under the
    # statement's write lock, so two concurrent claims cannot both pass the
    # cap; the unique name index settles a race for the same namespace.
    owned = (
        select(func.count())
        .select_from(Publisher)
        .where(Publisher.navide_member_id == member_id)
        .scalar_subquery()
    )
    source = select(
        literal(namespace, String),
        literal(display_name or None, String),
        literal(member_id, String),
        literal(True, Boolean),
        literal(_now(), DateTime),
    ).where(owned < MAX_NAMESPACES_PER_ACCOUNT)
    statement = insert(Publisher).from_select(
        ["name", "display_name", "navide_member_id", "review_required", "created_at"], source
    )
    try:
        inserted = session.execute(statement)
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise SelfServiceError(f"“{namespace}” is already taken.") from exc
    if inserted.rowcount != 1:
        raise SelfServiceError(f"An account can own at most {MAX_NAMESPACES_PER_ACCOUNT} namespaces.")
    audit.record(
        session, actor=audit.member_actor(member_id), action="namespace.claim", target=f"publisher:{namespace}"
    )
    session.commit()
    return session.exec(select(Publisher).where(Publisher.name == namespace)).one()


def set_public_key(session: Session, publisher: Publisher, pem: str) -> str:
    pem = pem.strip() + "\n"
    try:
        fingerprint = public_key_fingerprint(pem)
    except Exception as exc:  # noqa: BLE001 - any parse failure is a bad key
        raise SelfServiceError("That is not an Ed25519 public key in PEM form.") from exc
    _require_vetted(session, publisher)
    publisher.public_key = pem
    session.add(publisher)
    qualification.record_key(session, publisher, pem)
    audit.record(
        session,
        actor=_owner_actor(publisher),
        action="publisher-key.set",
        target=f"publisher:{publisher.name}",
        detail={"key_id": fingerprint},
    )
    session.commit()
    return fingerprint


# -- publish tokens -------------------------------------------------------
def _label(value: str) -> str:
    value = value.strip()
    if not value or len(value) > MAX_LABEL_LENGTH:
        raise SelfServiceError(f"Give the token a name of 1-{MAX_LABEL_LENGTH} characters.")
    return value


def create_token(session: Session, publisher: Publisher, *, label: str, days: int = DEFAULT_TOKEN_DAYS) -> tuple[str, PublisherToken]:
    """Return (plain token, row). The plain token is shown once, never stored."""
    if not 1 <= days <= MAX_TOKEN_DAYS:
        raise SelfServiceError(f"A token can last 1-{MAX_TOKEN_DAYS} days.")
    _require_vetted(session, publisher)
    plain = TOKEN_PREFIX + secrets.token_urlsafe(32)
    row = PublisherToken(
        publisher_id=publisher.id,
        label=_label(label),
        token_hash=hash_token(plain),
        expires_at=_now() + timedelta(days=days),
    )
    session.add(row)
    session.flush()
    audit.record(
        session,
        actor=_owner_actor(publisher),
        action="publisher-token.issue",
        target=f"publisher:{publisher.name}",
        detail={"token_id": row.id, "label": row.label, "days": days},
    )
    session.commit()
    session.refresh(row)
    return plain, row


def list_tokens(session: Session, publisher: Publisher) -> list[PublisherToken]:
    return list(
        session.exec(
            select(PublisherToken)
            .where(PublisherToken.publisher_id == publisher.id)
            .order_by(PublisherToken.created_at.desc())
        ).all()
    )


def revoke_token(session: Session, publisher: Publisher, token_id: int) -> bool:
    row = session.get(PublisherToken, token_id)
    if row is None or row.publisher_id != publisher.id:
        return False
    if row.revoked_at is None:
        row.revoked_at = _now()
        session.add(row)
        audit.record(
            session,
            actor=_owner_actor(publisher),
            action="publisher-token.revoke",
            target=f"publisher:{publisher.name}",
            detail={"token_id": row.id},
        )
        session.commit()
    return True


def token_state(row: PublisherToken, now: datetime | None = None) -> str:
    now = now or _now()
    if row.revoked_at is not None:
        return "revoked"
    if _aware(row.expires_at) <= now:
        return "expired"
    return "active"


def publisher_for_token(session: Session, token: str) -> Publisher | None:
    """Resolve an active short-lived token; records its last use."""
    row = session.exec(
        select(PublisherToken).where(PublisherToken.token_hash == hash_token(token))
    ).first()
    if row is None or token_state(row) != "active":
        return None
    row.last_used_at = _now()
    session.add(row)
    session.commit()
    return session.get(Publisher, row.publisher_id)


# -- CLI login (loopback + state + PKCE) ---------------------------------
def pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def issue_cli_code(session: Session, publisher: Publisher, *, code_challenge: str, label: str) -> str:
    if not (43 <= len(code_challenge) <= 128):
        raise SelfServiceError("invalid code_challenge")
    _require_vetted(session, publisher)
    code = secrets.token_urlsafe(32)
    session.add(
        CliAuthCode(
            code_hash=hash_token(code),
            publisher_id=publisher.id,
            code_challenge=code_challenge,
            label=_label(label),
            expires_at=_now() + CLI_CODE_TTL,
        )
    )
    session.commit()
    return code


def exchange_cli_code(session: Session, *, code: str, code_verifier: str) -> tuple[str, PublisherToken, Publisher]:
    row = session.exec(select(CliAuthCode).where(CliAuthCode.code_hash == hash_token(code))).first()
    if row is None or row.used_at is not None or _aware(row.expires_at) <= _now():
        raise SelfServiceError("invalid or expired code")
    # Burn the code before checking the verifier so a wrong guess cannot retry.
    # Conditional UPDATE: of two concurrent redemptions only one sees rowcount 1.
    burned = session.execute(
        update(CliAuthCode)
        .where(CliAuthCode.id == row.id, CliAuthCode.used_at.is_(None))
        .values(used_at=_now())
    )
    session.commit()
    if burned.rowcount != 1:
        raise SelfServiceError("invalid or expired code")
    if not secrets.compare_digest(pkce_challenge(code_verifier).encode(), row.code_challenge.encode()):
        raise SelfServiceError("invalid or expired code")
    publisher = session.get(Publisher, row.publisher_id)
    plain, token = create_token(session, publisher, label=row.label, days=CLI_TOKEN_DAYS)
    return plain, token, publisher


# -- domain verification --------------------------------------------------
def set_domain(session: Session, publisher: Publisher, domain: str) -> Publisher:
    domain = normalize_domain(domain)
    if publisher.verified_domain != domain or publisher.domain_token is None:
        publisher.verified_domain = domain
        publisher.domain_token = new_token()
        publisher.domain_verified_at = None
        session.add(publisher)
        session.commit()
        session.refresh(publisher)
    return publisher


def check_domain(session: Session, publisher: Publisher, resolver: TxtResolver) -> bool:
    if not publisher.verified_domain or not publisher.domain_token:
        raise SelfServiceError("Add a domain first.")
    if is_verified(publisher.verified_domain, publisher.domain_token, resolver):
        publisher.domain_verified_at = _now()
        session.add(publisher)
        session.commit()
        return True
    return False


def verified_domain(publisher: Publisher | None) -> str | None:
    if publisher is None or publisher.domain_verified_at is None:
        return None
    return publisher.verified_domain
