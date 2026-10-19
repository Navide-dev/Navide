"""Developer qualification (DX report §5): a Navide Cloud account applies with
its real-name details, an admin approves or rejects, and only an approved
account can claim a namespace or obtain a publish token.

The record is keyed by `navide_member_id` and lives only in the registry;
Cloud's `members` table is never touched. Revoking a qualification, in one
transaction: revokes every token the account holds (publisher and account
tokens, unused login codes, an admin-issued token on its namespaces), freezes
its namespaces, yanks every version of them in every channel, and revokes
their publisher keys. Every step is written to the audit trail (audit.py).

Admin-created (first-party) publishers have no owner and are always vetted.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import update
from sqlmodel import Session, select

from . import audit
from .config import PUBLISHER_PATTERN
from .models import (
    AccountAuthCode,
    AccountToken,
    BlocklistEntry,
    CliAuthCode,
    DeveloperQualification,
    Extension,
    ExtensionVersion,
    Publisher,
    PublisherKey,
    PublisherToken,
)
from .signing import public_key_fingerprint

PENDING = "pending"
APPROVED = "approved"
REJECTED = "rejected"
REVOKED = "revoked"
NONE = "none"
"""Reported for an account that never applied; never stored."""

SOURCE_USER = "user"
SOURCE_AGENT_DRAFT = "agent-draft"
FIELD_SOURCES = (SOURCE_USER, SOURCE_AGENT_DRAFT)

APPLICANT_TYPES = ("individual", "organization")
REQUIRED_FIELDS = (
    "applicant_type",
    "legal_name",
    "display_name",
    "contact_email",
    "country",
    "intended_namespace",
    "description",
    "agreed_terms",
)
ORGANIZATION_FIELDS = ("organization_name", "organization_id")
OPTIONAL_FIELDS = ("website", "source_url", "needs_native_backend", "domain")
ALL_FIELDS = (*REQUIRED_FIELDS, *ORGANIZATION_FIELDS, *OPTIONAL_FIELDS)
BOOLEAN_FIELDS = ("agreed_terms", "needs_native_backend")
TEXT_LIMITS = {"description": 1000, "website": 500, "source_url": 500}
DEFAULT_TEXT_LIMIT = 200
MAX_SOURCE_LENGTH = 64
MAX_REASON_LENGTH = 1000

_EMAIL_RE = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
_COUNTRY_RE = re.compile(r"[A-Z]{2}")
_URL_RE = re.compile(r"https?://\S+")


class QualificationError(ValueError):
    """`code` is the stable error code the API returns; `field` names the
    offending application field when there is one."""

    def __init__(self, code: str, message: str, field: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.field = field


def _now() -> datetime:
    return datetime.now(timezone.utc)


def member_target(member_id: str) -> str:
    return f"member:{member_id}"


# -- reads ----------------------------------------------------------------
def get(session: Session, member_id: str) -> DeveloperQualification | None:
    return session.get(DeveloperQualification, member_id)


def status_of(session: Session, member_id: str) -> str:
    row = get(session, member_id)
    return row.status if row is not None else NONE


def is_approved(session: Session, member_id: str) -> bool:
    return status_of(session, member_id) == APPROVED


def publisher_problem(session: Session, publisher: Publisher) -> tuple[str, str] | None:
    """(code, message) when nothing may be published or issued under this
    namespace; None when it may."""
    if publisher.frozen_at is not None:
        return "NAMESPACE_FROZEN", f"namespace '{publisher.name}' is frozen: {publisher.frozen_reason or 'qualification revoked'}"
    if publisher.navide_member_id is not None and not is_approved(session, publisher.navide_member_id):
        return (
            "QUALIFICATION_REQUIRED",
            "this account's developer qualification is not approved; apply on the "
            "marketplace website or in Navide and wait for review",
        )
    return None


def publisher_vetted(session: Session, publisher: Publisher) -> bool:
    return publisher_problem(session, publisher) is None


def view(row: DeveloperQualification | None) -> dict:
    """What the applicant sees about their own application."""
    if row is None:
        return {
            "status": NONE,
            "fields": None,
            "field_sources": {},
            "source": None,
            "reason": None,
            "submitted_at": None,
            "decided_at": None,
        }
    return {
        "status": row.status,
        "fields": row.application,
        "field_sources": row.field_sources,
        "source": row.source,
        "reason": row.reason if row.status in (REJECTED, REVOKED) else None,
        "submitted_at": _iso(row.submitted_at),
        "decided_at": _iso(row.decided_at),
    }


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).isoformat()


def queue(session: Session, status: str | None = PENDING) -> list[DeveloperQualification]:
    statement = select(DeveloperQualification).order_by(DeveloperQualification.submitted_at)
    if status is not None:
        statement = statement.where(DeveloperQualification.status == status)
    return list(session.exec(statement).all())


# -- application ----------------------------------------------------------
def validate_application(fields: object, field_sources: object, source: object) -> tuple[dict, dict, str | None]:
    if not isinstance(fields, dict):
        raise QualificationError("APPLICATION_INVALID", "fields must be an object")
    unknown = sorted(set(fields) - set(ALL_FIELDS))
    if unknown:
        raise QualificationError("APPLICATION_INVALID", f"unknown field '{unknown[0]}'", unknown[0])
    clean: dict = {}
    for name, value in fields.items():
        if value is None or value == "":
            continue
        if name in BOOLEAN_FIELDS:
            if not isinstance(value, bool):
                raise QualificationError("APPLICATION_INVALID", f"{name} must be true or false", name)
            clean[name] = value
            continue
        if not isinstance(value, str):
            raise QualificationError("APPLICATION_INVALID", f"{name} must be text", name)
        value = value.strip()
        limit = TEXT_LIMITS.get(name, DEFAULT_TEXT_LIMIT)
        if not value or len(value) > limit:
            raise QualificationError("APPLICATION_INVALID", f"{name} must be 1-{limit} characters", name)
        clean[name] = value
    required = list(REQUIRED_FIELDS)
    if clean.get("applicant_type") == "organization":
        required += ORGANIZATION_FIELDS
    for name in required:
        if name not in clean:
            raise QualificationError("APPLICATION_INVALID", f"{name} is required", name)
    if clean["applicant_type"] not in APPLICANT_TYPES:
        raise QualificationError("APPLICATION_INVALID", "applicant_type must be individual or organization", "applicant_type")
    if clean["agreed_terms"] is not True:
        raise QualificationError("APPLICATION_INVALID", "the developer terms must be accepted", "agreed_terms")
    if not _EMAIL_RE.fullmatch(clean["contact_email"]):
        raise QualificationError("APPLICATION_INVALID", "contact_email is not an email address", "contact_email")
    if not _COUNTRY_RE.fullmatch(clean["country"]):
        raise QualificationError("APPLICATION_INVALID", "country must be an ISO 3166-1 alpha-2 code such as TW", "country")
    namespace = clean["intended_namespace"].lower()
    if not PUBLISHER_PATTERN.fullmatch(namespace):
        raise QualificationError("APPLICATION_INVALID", "intended_namespace must be a namespace such as acme-tools", "intended_namespace")
    clean["intended_namespace"] = namespace
    for name in ("website", "source_url"):
        if name in clean and not _URL_RE.fullmatch(clean[name]):
            raise QualificationError("APPLICATION_INVALID", f"{name} must be an http(s) URL", name)

    if field_sources is None:
        field_sources = {}
    if not isinstance(field_sources, dict):
        raise QualificationError("APPLICATION_INVALID", "field_sources must be an object")
    sources: dict = {}
    for name in clean:
        value = field_sources.get(name, SOURCE_USER)
        if value not in FIELD_SOURCES:
            raise QualificationError("APPLICATION_INVALID", f"field_sources.{name} must be user or agent-draft", name)
        sources[name] = value
    extra = sorted(set(field_sources) - set(clean))
    if extra:
        raise QualificationError("APPLICATION_INVALID", f"field_sources names a field that is not submitted: '{extra[0]}'", extra[0])

    if source is not None and (not isinstance(source, str) or not source.strip() or len(source) > MAX_SOURCE_LENGTH):
        raise QualificationError("APPLICATION_INVALID", f"source must be 1-{MAX_SOURCE_LENGTH} characters")
    return clean, sources, source.strip() if isinstance(source, str) else None


def submit_application(
    session: Session, member_id: str, *, fields: object, field_sources: object = None, source: object = None
) -> DeveloperQualification:
    """Create the application, or replace a rejected one. Commits."""
    clean, sources, source = validate_application(fields, field_sources, source)
    row = get(session, member_id)
    if row is not None and row.status in (PENDING, APPROVED):
        raise QualificationError("APPLICATION_EXISTS", f"an application is already {row.status}")
    if row is not None and row.status == REVOKED:
        raise QualificationError("QUALIFICATION_REVOKED", "this account's developer qualification was revoked")
    if row is None:
        row = DeveloperQualification(navide_member_id=member_id, status=PENDING)
    row.status = PENDING
    row.application = clean
    row.field_sources = sources
    row.source = source
    row.submitted_at = _now()
    row.decided_at = None
    row.decided_by = None
    row.reason = None
    session.add(row)
    audit.record(
        session,
        actor=audit.member_actor(member_id),
        action="qualification.apply",
        target=member_target(member_id),
        detail={
            "source": source,
            "agent_drafted_fields": sorted(k for k, v in sources.items() if v == SOURCE_AGENT_DRAFT),
        },
    )
    session.commit()
    session.refresh(row)
    return row


def _reason(reason: str | None, *, required: bool) -> str | None:
    reason = (reason or "").strip()
    if required and not reason:
        raise QualificationError("REASON_REQUIRED", "a reason is required")
    if len(reason) > MAX_REASON_LENGTH:
        raise QualificationError("REASON_TOO_LONG", f"a reason can be at most {MAX_REASON_LENGTH} characters")
    return reason or None


def decide(session: Session, member_id: str, *, approve: bool, actor: str, reason: str | None = None) -> DeveloperQualification:
    """Approve or reject a pending application. Commits."""
    row = get(session, member_id)
    if row is None:
        raise QualificationError("NOT_FOUND", "no application for this account")
    if row.status != PENDING:
        raise QualificationError("NOT_PENDING", f"the application is {row.status}, not pending")
    reason = _reason(reason, required=not approve)
    row.status = APPROVED if approve else REJECTED
    row.decided_at = _now()
    row.decided_by = actor
    row.reason = reason
    session.add(row)
    audit.record(
        session,
        actor=actor,
        action="qualification.approve" if approve else "qualification.reject",
        target=member_target(member_id),
        reason=reason,
    )
    session.commit()
    session.refresh(row)
    return row


@dataclass(frozen=True)
class RevocationResult:
    namespaces: list[str]
    tokens_revoked: int
    versions_yanked: int
    keys_revoked: int


def revoke(session: Session, member_id: str, *, actor: str, reason: str) -> RevocationResult:
    """Revoke an approved qualification and everything it unlocked, in one
    transaction (see the module docstring). Commits."""
    row = get(session, member_id)
    if row is None or row.status != APPROVED:
        raise QualificationError("NOT_APPROVED", "only an approved qualification can be revoked")
    reason = _reason(reason, required=True)
    now = _now()
    publishers = list(session.exec(select(Publisher).where(Publisher.navide_member_id == member_id)).all())
    publisher_ids = [p.id for p in publishers]

    tokens = 0
    if publisher_ids:
        tokens += session.execute(
            update(PublisherToken)
            .where(PublisherToken.publisher_id.in_(publisher_ids), PublisherToken.revoked_at.is_(None))
            .values(revoked_at=now)
        ).rowcount
        session.execute(
            update(CliAuthCode)
            .where(CliAuthCode.publisher_id.in_(publisher_ids), CliAuthCode.used_at.is_(None))
            .values(used_at=now)
        )
    tokens += session.execute(
        update(AccountToken)
        .where(AccountToken.navide_member_id == member_id, AccountToken.revoked_at.is_(None))
        .values(revoked_at=now)
    ).rowcount
    session.execute(
        update(AccountAuthCode)
        .where(AccountAuthCode.navide_member_id == member_id, AccountAuthCode.used_at.is_(None))
        .values(used_at=now)
    )

    yanked = 0
    keys = 0
    for publisher in publishers:
        if publisher.token_hash is not None:
            publisher.token_hash = None
            tokens += 1
        publisher.frozen_at = now
        publisher.frozen_reason = reason
        session.add(publisher)
        extension_ids = list(session.exec(select(Extension.id).where(Extension.publisher_id == publisher.id)).all())
        versions: list[str] = []
        if extension_ids:
            rows = session.exec(
                select(ExtensionVersion).where(
                    ExtensionVersion.extension_id.in_(extension_ids), ExtensionVersion.yanked.is_(False)
                )
            ).all()
            identities = {
                e.id: e.identity for e in session.exec(select(Extension).where(Extension.id.in_(extension_ids))).all()
            }
            for version in rows:
                version.yanked = True
                session.add(version)
                versions.append(f"{identities[version.extension_id]}@{version.version}#{version.target}")
        yanked += len(versions)
        key_count = session.execute(
            update(PublisherKey)
            .where(PublisherKey.publisher_id == publisher.id, PublisherKey.revoked_at.is_(None))
            .values(revoked_at=now, revoked_reason="qualification revoked")
        ).rowcount
        keys += key_count
        audit.record(
            session,
            actor=audit.SYSTEM_REVOCATION,
            action="namespace.freeze",
            target=f"publisher:{publisher.name}",
            reason=reason,
            detail={"yanked": versions, "keys_revoked": key_count},
        )

    row.status = REVOKED
    row.decided_at = now
    row.decided_by = actor
    row.reason = reason
    session.add(row)
    audit.record(
        session,
        actor=actor,
        action="qualification.revoke",
        target=member_target(member_id),
        reason=reason,
        detail={
            "namespaces": [p.name for p in publishers],
            "tokens_revoked": tokens,
            "versions_yanked": yanked,
            "keys_revoked": keys,
        },
    )
    session.commit()
    return RevocationResult(
        namespaces=[p.name for p in publishers], tokens_revoked=tokens, versions_yanked=yanked, keys_revoked=keys
    )


# -- publisher keys -------------------------------------------------------
def record_key(session: Session, publisher: Publisher, pem: str) -> str:
    """Make `pem` the publisher's one active key in the history; any other
    active key becomes revoked ('replaced'). Does not commit. Returns the keyId."""
    key_id = public_key_fingerprint(pem)
    now = _now()
    session.execute(
        update(PublisherKey)
        .where(
            PublisherKey.publisher_id == publisher.id,
            PublisherKey.key_id != key_id,
            PublisherKey.revoked_at.is_(None),
        )
        .values(revoked_at=now, revoked_reason="replaced")
    )
    existing = session.exec(
        select(PublisherKey).where(PublisherKey.publisher_id == publisher.id, PublisherKey.key_id == key_id)
    ).first()
    if existing is None:
        session.add(PublisherKey(publisher_id=publisher.id, key_id=key_id, public_key=pem))
    elif existing.revoked_at is not None:
        existing.revoked_at = None
        existing.revoked_reason = None
        session.add(existing)
    return key_id


# -- local-install trust --------------------------------------------------
def local_install_entries(session: Session) -> tuple[list[dict], list[str]]:
    """(publisherKeys, blockedDigests) for the root-signed local-install
    document. Keys of first-party publishers and of accounts that are or were
    approved are listed (revoked ones with status 'revoked'); an account that
    was never approved has no key here."""
    vetted_members = set(
        session.exec(
            select(DeveloperQualification.navide_member_id).where(
                DeveloperQualification.status.in_((APPROVED, REVOKED))
            )
        ).all()
    )
    publishers = {p.id: p for p in session.exec(select(Publisher)).all()}
    keys = []
    for key in session.exec(select(PublisherKey).order_by(PublisherKey.publisher_id, PublisherKey.id)).all():
        publisher = publishers.get(key.publisher_id)
        if publisher is None:
            continue
        if publisher.navide_member_id is not None and publisher.navide_member_id not in vetted_members:
            continue
        revoked = key.revoked_at is not None or publisher.frozen_at is not None
        keys.append(
            {
                "publisherId": publisher.name,
                "keyId": key.key_id,
                "publicKey": key.public_key,
                "status": "revoked" if revoked else "active",
                "revokedAt": key.revoked_at or (publisher.frozen_at if revoked else None),
            }
        )
    digests = sorted(
        session.exec(select(BlocklistEntry.value).where(BlocklistEntry.kind == "digest")).all()
    )
    return keys, digests
