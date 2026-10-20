"""Developer qualification (DX report §5): a Navide Cloud account applies with
its real-name details, an admin approves or rejects, and only an approved
account can claim a namespace or obtain a publish token.

The record is keyed by `navide_member_id` and lives only in the registry;
Cloud's `members` table is never touched. Revoking a qualification, in one
transaction: revokes every token the account holds (publisher and account
tokens, unused login codes, an admin-issued token on its namespaces), freezes
its namespaces, yanks every version of them in every channel, and revokes
their publisher keys, and blocks the digest of every version they published
(reason qualification-revoked). Every step is written to the audit trail
(audit.py).

A namespace self-claimed before qualification existed is grandfathered
(migration 13, decision d4(a)): it keeps publishing for 30 days while its owner
applies. The owner's first application, filed inside the period, pauses it
until the decision, and a rejection resumes it with the time it had left.
Nothing else pauses it: an application filed after the deadline, or a
re-application after a rejection, leaves the clock running, so the period
cannot be stretched indefinitely. Once it runs out with no approved owner and
no paused application, the namespace is reclaimed the way a revocation tears
one down (reclaim_expired).

Admin-created (first-party) publishers have no owner and are always vetted.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from . import audit, blocklist
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
    RegistryAudit,
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

GRANDFATHER_REMINDER_DAYS = 7
"""The owner of a grandfathered namespace is reminded this close to the end."""
GRANDFATHER_EXPIRED_REASON = "developer qualification was not applied for within the 30-day grace period"
REVOKED_DIGEST_REASON = "Developer qualification revoked"
"""Public reason on the digest entries a revocation or reclaim adds."""

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


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def grandfather_deadline(publisher: Publisher, now: datetime) -> datetime | None:
    """End of the grace period; while it is paused, the end moves with the clock."""
    until = _aware(publisher.grandfather_until)
    paused = _aware(publisher.grandfather_paused_at)
    if until is None:
        return None
    if paused is not None:
        until += max(now - paused, timedelta(0))
    return until


def _paused(session: Session, publisher: Publisher) -> bool:
    """A pending application holds the period only while it paused it."""
    return publisher.grandfather_paused_at is not None and status_of(session, publisher.navide_member_id) == PENDING


def grandfathered(session: Session, publisher: Publisher, now: datetime | None = None) -> bool:
    """Whether the grace period still lets an unapproved owner publish: the
    period is running, or the owner's first application paused it."""
    if publisher.grandfather_until is None or publisher.navide_member_id is None:
        return False
    if _paused(session, publisher):
        return True
    now = now or _now()
    return now < grandfather_deadline(publisher, now)


def grandfather_view(session: Session, publisher: Publisher, now: datetime | None = None) -> dict | None:
    """What the owner is told about the grace period; None when none applies
    (no grace, a frozen namespace, or an approved owner). `remind` is set in
    the last GRANDFATHER_REMINDER_DAYS of a running period."""
    if publisher.grandfather_until is None or publisher.navide_member_id is None or publisher.frozen_at is not None:
        return None
    status = status_of(session, publisher.navide_member_id)
    if status == APPROVED:
        return None
    now = now or _now()
    deadline = grandfather_deadline(publisher, now)
    paused = _paused(session, publisher)
    left = deadline - now
    return {
        "until": _iso(deadline),
        "paused": paused,
        "days_left": max(0, math.ceil(left.total_seconds() / 86400)),
        "remind": not paused and left <= timedelta(days=GRANDFATHER_REMINDER_DAYS),
        "expired": not paused and left <= timedelta(0),
    }


def _pause_grandfather(session: Session, member_id: str, now: datetime) -> None:
    """Pause every period of this owner that is still running at `now`; an
    expired one stays expired."""
    for publisher in session.exec(
        select(Publisher).where(
            Publisher.navide_member_id == member_id,
            Publisher.grandfather_until.is_not(None),
            Publisher.grandfather_paused_at.is_(None),
            Publisher.frozen_at.is_(None),
        )
    ).all():
        if grandfather_deadline(publisher, now) <= now:
            continue
        publisher.grandfather_paused_at = now
        session.add(publisher)


def _resume_grandfather(session: Session, member_id: str, now: datetime) -> None:
    """Resume a paused period, extended by the time it was paused."""
    for publisher in session.exec(
        select(Publisher).where(
            Publisher.navide_member_id == member_id, Publisher.grandfather_paused_at.is_not(None)
        )
    ).all():
        publisher.grandfather_until = grandfather_deadline(publisher, now)
        publisher.grandfather_paused_at = None
        session.add(publisher)


def publisher_problem(session: Session, publisher: Publisher) -> tuple[str, str] | None:
    """(code, message) when nothing may be published or issued under this
    namespace; None when it may."""
    if publisher.frozen_at is not None:
        return "NAMESPACE_FROZEN", f"namespace '{publisher.name}' is frozen: {publisher.frozen_reason or 'qualification revoked'}"
    if publisher.navide_member_id is not None and not is_approved(session, publisher.navide_member_id):
        if grandfathered(session, publisher):
            return None
        if publisher.grandfather_until is not None:
            return (
                "QUALIFICATION_REQUIRED",
                "the 30-day grace period for this namespace has ended without a developer "
                "application; apply on the marketplace website or in Navide",
            )
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
    # Only the first application pauses a grace period (S8 R-MED-2): a
    # re-application after a rejection leaves the clock running.
    first = row is None
    if row is None:
        row = DeveloperQualification(navide_member_id=member_id, status=PENDING)
    row.status = PENDING
    row.application = clean
    row.field_sources = sources
    row.source = source
    row.submitted_at = _now()
    if first:
        _pause_grandfather(session, member_id, row.submitted_at)
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
    try:
        session.commit()
    except IntegrityError as exc:
        # Two first applications raced: the other one committed first, and
        # this whole transaction (pause included) rolls back.
        session.rollback()
        raise QualificationError("APPLICATION_EXISTS", "an application is already pending") from exc
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
    if not approve:
        _resume_grandfather(session, member_id, row.decided_at)
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


def _tear_down(
    session: Session, publishers: list[Publisher], *, reason: str, actor: str, now: datetime
) -> tuple[int, int, int, list[str]]:
    """Freeze these namespaces: drop the admin-issued token, freeze, yank every
    version, revoke the keys and block the digest of every version
    (qualification-revoked). The caller revokes the publisher tokens and login
    codes. Does not commit. Returns (versions yanked, keys revoked, tokens
    dropped, digests blocked)."""
    yanked = 0
    keys = 0
    tokens = 0
    blocked: list[str] = []
    for publisher in publishers:
        if publisher.token_hash is not None:
            publisher.token_hash = None
            tokens += 1
        publisher.frozen_at = now
        publisher.frozen_reason = reason
        session.add(publisher)
        extension_ids = list(session.exec(select(Extension.id).where(Extension.publisher_id == publisher.id)).all())
        versions: list[str] = []
        digests: list[str] = []
        if extension_ids:
            rows = session.exec(
                select(ExtensionVersion).where(ExtensionVersion.extension_id.in_(extension_ids))
            ).all()
            identities = {
                e.id: e.identity for e in session.exec(select(Extension).where(Extension.id.in_(extension_ids))).all()
            }
            for version in rows:
                digests.append(version.package_digest)
                if version.yanked:
                    continue
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
        added = blocklist.block_digests(
            session,
            digests,
            reason=REVOKED_DIGEST_REASON,
            digest_reason=blocklist.DIGEST_QUALIFICATION_REVOKED,
            created_by=actor,
        )
        blocked += added
        audit.record(
            session,
            actor=actor,
            action="namespace.freeze",
            target=f"publisher:{publisher.name}",
            reason=reason,
            detail={"yanked": versions, "keys_revoked": key_count, "digests_blocked": added},
        )
    return yanked, keys, tokens, blocked


def _revoke_publisher_tokens(session: Session, publisher_ids: list[int], now: datetime) -> int:
    if not publisher_ids:
        return 0
    revoked = session.execute(
        update(PublisherToken)
        .where(PublisherToken.publisher_id.in_(publisher_ids), PublisherToken.revoked_at.is_(None))
        .values(revoked_at=now)
    ).rowcount
    session.execute(
        update(CliAuthCode)
        .where(CliAuthCode.publisher_id.in_(publisher_ids), CliAuthCode.used_at.is_(None))
        .values(used_at=now)
    )
    return revoked


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

    tokens = _revoke_publisher_tokens(session, publisher_ids, now)
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

    yanked, keys, tokens_torn, digests = _tear_down(
        session, publishers, reason=reason, actor=audit.SYSTEM_REVOCATION, now=now
    )
    tokens += tokens_torn

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
            "digests_blocked": len(digests),
        },
    )
    session.commit()
    return RevocationResult(
        namespaces=[p.name for p in publishers], tokens_revoked=tokens, versions_yanked=yanked, keys_revoked=keys
    )


def reclaim_expired(session: Session, now: datetime | None = None) -> list[str]:
    """Reclaim every grandfathered namespace whose grace period ran out with
    no approved owner and no paused application: tear it down as a revocation does
    (the account keeps its account token and may still apply). Commits.
    Returns the namespaces reclaimed."""
    now = now or _now()
    by_member: dict[str, list[Publisher]] = {}
    for publisher in session.exec(
        select(Publisher).where(
            Publisher.grandfather_until.is_not(None),
            Publisher.frozen_at.is_(None),
            Publisher.navide_member_id.is_not(None),
        )
    ).all():
        if is_approved(session, publisher.navide_member_id) or _paused(session, publisher):
            continue
        if grandfather_deadline(publisher, now) > now:
            continue
        by_member.setdefault(publisher.navide_member_id, []).append(publisher)
    reclaimed: list[str] = []
    for member_id, publishers in by_member.items():
        tokens = _revoke_publisher_tokens(session, [p.id for p in publishers], now)
        yanked, keys, dropped, digests = _tear_down(
            session, publishers, reason=GRANDFATHER_EXPIRED_REASON, actor=audit.SYSTEM_GRANDFATHER_EXPIRED, now=now
        )
        audit.record(
            session,
            actor=audit.SYSTEM_GRANDFATHER_EXPIRED,
            action="namespace.reclaim",
            target=member_target(member_id),
            reason=GRANDFATHER_EXPIRED_REASON,
            detail={
                "namespaces": [p.name for p in publishers],
                "tokens_revoked": tokens + dropped,
                "versions_yanked": yanked,
                "keys_revoked": keys,
                "digests_blocked": len(digests),
            },
        )
        reclaimed += [p.name for p in publishers]
    session.commit()
    return reclaimed


@dataclass(frozen=True)
class UnfreezeResult:
    namespace: str
    restored_versions: list[str]
    digests_unblocked: list[str]


def unfreeze(session: Session, namespace: str, *, actor: str, reason: str, restore_versions: bool = False) -> UnfreezeResult:
    """Give a frozen namespace back to the account that owned it, once that
    account is approved again (user decision 2026-10-21: only the original
    account, never another developer). Commits.

    The freeze's dropped tokens and revoked keys stay dead: the owner issues a
    new token and registers a new key. Versions stay yanked and their digests
    blocked unless `restore_versions`, which undoes only what this freeze did:
    the `qualification-revoked` digest entries its `namespace.freeze` audit
    row added (still as that freeze wrote them), and the versions it yanked
    whose digest is then no longer blocked. A version yanked or a digest
    blocked for any other reason is left as it is."""
    from .self_service import MAX_NAMESPACES_PER_ACCOUNT, counted_namespaces  # self_service imports this module

    publisher = session.exec(select(Publisher).where(Publisher.name == namespace.strip().lower())).first()
    if publisher is None:
        raise QualificationError("NOT_FOUND", "no such namespace")
    if publisher.frozen_at is None:
        raise QualificationError("NOT_FROZEN", "this namespace is not frozen")
    reason = _reason(reason, required=True)
    member_id = publisher.navide_member_id
    if member_id is None or not is_approved(session, member_id):
        raise QualificationError(
            "OWNER_NOT_APPROVED", "the account that owns this namespace is not an approved developer now"
        )
    if session.exec(select(counted_namespaces(member_id))).one() >= MAX_NAMESPACES_PER_ACCOUNT:
        raise QualificationError(
            "OVER_ALLOWANCE", f"the owner already has {MAX_NAMESPACES_PER_ACCOUNT} namespaces that are not frozen"
        )

    restored: list[str] = []
    unblocked: list[str] = []
    if restore_versions:
        freeze = session.exec(
            select(RegistryAudit)
            .where(RegistryAudit.target == f"publisher:{publisher.name}", RegistryAudit.action == "namespace.freeze")
            .order_by(RegistryAudit.id.desc())
        ).first()
        detail = freeze.detail if freeze is not None else {}
        for digest in sorted(set(detail.get("digests_blocked") or [])):
            entry = blocklist.digest_blocked(session, digest)
            if (
                entry is not None
                and entry.digest_reason == blocklist.DIGEST_QUALIFICATION_REVOKED
                and entry.created_by == freeze.actor
            ):
                session.delete(entry)
                unblocked.append(digest)
        session.flush()
        yanked_by_freeze = set(detail.get("yanked") or [])
        extensions = {
            e.id: e.identity for e in session.exec(select(Extension).where(Extension.publisher_id == publisher.id)).all()
        }
        if extensions:
            for version in session.exec(
                select(ExtensionVersion).where(ExtensionVersion.extension_id.in_(list(extensions)))
            ).all():
                label = f"{extensions[version.extension_id]}@{version.version}#{version.target}"
                if not version.yanked or label not in yanked_by_freeze:
                    continue
                if blocklist.digest_blocked(session, version.package_digest) is not None:
                    continue
                version.yanked = False
                session.add(version)
                restored.append(label)
        restored.sort()

    publisher.frozen_at = None
    publisher.frozen_reason = None
    session.add(publisher)
    audit.record(
        session,
        actor=actor,
        action="namespace.unfreeze",
        target=f"publisher:{publisher.name}",
        reason=reason,
        detail={
            "member_id": member_id,
            "restore_versions": restore_versions,
            "restored_versions": restored,
            "digests_unblocked": unblocked,
        },
    )
    session.commit()
    return UnfreezeResult(namespace=publisher.name, restored_versions=restored, digests_unblocked=unblocked)


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
def local_install_entries(session: Session) -> tuple[list[dict], list[dict]]:
    """(publisherKeys, blockedDigests) for the root-signed local-install
    document; each blocked digest carries its reason (blocklist.DIGEST_REASONS). Keys of first-party publishers and of accounts that are or were
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
    digests = [
        {"digest": value, "reason": digest_reason or blocklist.DIGEST_ADMIN}
        for value, digest_reason in sorted(
            session.exec(
                select(BlocklistEntry.value, BlocklistEntry.digest_reason).where(BlocklistEntry.kind == "digest")
            ).all()
        )
    ]
    return keys, digests
