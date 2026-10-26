"""Testplace: invite-only test builds on the same registry (B2-B5).

A testplace version is published, scanned and registry-signed like any other,
with `channel: testplace` and an `expiresAt` 90 days out in its signed
envelope. Public reads never return one (repository.py); a tester reaches it
only through the member-authenticated endpoints in testplace_api.py, and only
while holding a live seat:

- a personal invite: the developer creates a single-use join token and sends
  it; the first Cloud member to redeem it owns the seat;
- a public test code: reusable up to its cap, usable only after the first code
  of the extension passed a light admin review (D2).

Revoking a code stops new joins; seats already taken stay, like a TestFlight
public link. Revoking or yanking a version takes it back; its testers see
it in the tester detail's `withdrawn` list, and their App labels it and asks
once (0.2.28; never stopped automatically) and never offers to keep it once
expired. Nothing goes into the public signed blocklist, where
`ns.name@version` would tell anyone the test build exists (R-MED-3); the
root-signed local-install document lists only its digest, as
`testplace-withdrawn` (qualification.testplace_withdrawn_digests), so a tester
who is offline or signed out is told too.

Promotion sends the same artifact (digest unchanged) to an admin; approval
re-signs it on the channel its SemVer implies, so a tester's installed copy
becomes the Marketplace version without a reinstall.
"""

from __future__ import annotations

import secrets
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, insert, literal, update
from sqlalchemy import select as sa_select
from sqlmodel import Session, select

from . import review
from .disclosure import sign_disclosure
from .models import (
    Extension,
    ExtensionReport,
    ExtensionVersion,
    TestplaceCode,
    TestplaceInvite,
)
from .registry_trust import RegistryTrustSigner
from .repository import hash_token
from .review import APPROVED, PENDING, REJECTED, MAX_REASON_LENGTH, manifest_listing
from .trust import compute_trust_tier
from .versions import (
    TESTPLACE_CHANNEL,
    TESTPLACE_VALIDITY_DAYS,
    latest_stable_version,
    version_channel,
)

MAX_LABEL_LENGTH = 120
INVITE_PREFIX = "tpi_"
CODE_PREFIX = "tpc_"
REQUESTED = "requested"


class TestplaceError(ValueError):
    """`code` is the stable error code the API returns with `message`."""

    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def expiry(now: datetime | None = None) -> datetime:
    return (now or _now()) + timedelta(days=TESTPLACE_VALIDITY_DAYS)


# -- versions --------------------------------------------------------------
def live_rows(
    session: Session, extension: Extension, now: datetime | None = None
) -> list[ExtensionVersion]:
    """Installable testplace artifacts: signed, not yanked, not expired."""
    now = now or _now()
    rows = session.exec(
        select(ExtensionVersion).where(
            ExtensionVersion.extension_id == extension.id,
            ExtensionVersion.channel == TESTPLACE_CHANNEL,
            ExtensionVersion.review_status == APPROVED,
            ExtensionVersion.yanked == False,  # noqa: E712
        )
    ).all()
    return [r for r in rows if r.expires_at is not None and _aware(r.expires_at) > now]


def withdrawn_rows(session: Session, extension: Extension) -> list[ExtensionVersion]:
    """Testplace artifacts taken back: yanked by the developer, revoked by the
    developer or an admin, or withdrawn with the publisher's qualification.
    Listed to the extension's testers only, so an expired build that was
    taken back is never offered to keep (T-MED-1)."""
    return list(
        session.exec(
            select(ExtensionVersion)
            .where(
                ExtensionVersion.extension_id == extension.id,
                ExtensionVersion.channel == TESTPLACE_CHANNEL,
                ExtensionVersion.yanked == True,  # noqa: E712
            )
            .order_by(ExtensionVersion.version, ExtensionVersion.target)
        ).all()
    )


def seat_ended(session: Session, extension_id: int, member_id: str) -> datetime | None:
    """When `member_id`'s access to the extension's test builds ended: now
    for a live seat, the latest revocation otherwise; None when the member
    never held a seat. Builds published after it are none of theirs."""
    seats = session.exec(
        select(TestplaceInvite).where(
            TestplaceInvite.extension_id == extension_id,
            TestplaceInvite.member_id == member_id,
        )
    ).all()
    if not seats:
        return None
    if any(seat.revoked_at is None for seat in seats):
        return _now()
    return max(_aware(seat.revoked_at) for seat in seats)


def testplace_rows(session: Session, extension: Extension) -> list[ExtensionVersion]:
    """Every testplace artifact of the extension, whatever its state."""
    return list(
        session.exec(
            select(ExtensionVersion)
            .where(ExtensionVersion.extension_id == extension.id, ExtensionVersion.channel == TESTPLACE_CHANNEL)
            .order_by(ExtensionVersion.version, ExtensionVersion.target)
        ).all()
    )


def version_rows(
    session: Session, extension: Extension, version: str
) -> list[ExtensionVersion]:
    """Every testplace artifact of one version, whatever its state."""
    return list(
        session.exec(
            select(ExtensionVersion)
            .where(
                ExtensionVersion.extension_id == extension.id,
                ExtensionVersion.version == version,
                ExtensionVersion.channel == TESTPLACE_CHANNEL,
            )
            .order_by(ExtensionVersion.target)
        ).all()
    )


# -- seats -------------------------------------------------------------------
def _live_seats(session: Session, extension: Extension):
    return select(TestplaceInvite).where(
        TestplaceInvite.extension_id == extension.id,
        TestplaceInvite.revoked_at.is_(None),
    )


def is_tester(session: Session, extension: Extension, member_id: str) -> bool:
    return is_tester_id(session, extension.id, member_id)


def is_tester_id(session: Session, extension_id: int, member_id: str) -> bool:
    return (
        session.exec(
            select(TestplaceInvite).where(
                TestplaceInvite.extension_id == extension_id,
                TestplaceInvite.revoked_at.is_(None),
                TestplaceInvite.member_id == member_id,
            )
        ).first()
        is not None
    )


def tester_extensions(session: Session, member_id: str) -> list[Extension]:
    ids = session.exec(
        select(TestplaceInvite.extension_id).where(
            TestplaceInvite.member_id == member_id,
            TestplaceInvite.revoked_at.is_(None),
        )
    ).all()
    if not ids:
        return []
    return list(
        session.exec(select(Extension).where(Extension.id.in_(set(ids))).order_by(Extension.identity)).all()
    )


def _label(value: str) -> str:
    value = " ".join(value.split())
    if len(value) > MAX_LABEL_LENGTH:
        raise TestplaceError("BAD_REQUEST", f"a label is at most {MAX_LABEL_LENGTH} characters")
    return value


def create_invites(
    session: Session, extension: Extension, labels: list[str]
) -> list[tuple[str, TestplaceInvite]]:
    """One single-use join token per label; the plain tokens are returned
    once and only their hashes are kept."""
    if not labels:
        raise TestplaceError("BAD_REQUEST", "name at least one invitee")
    clean = [_label(label) for label in labels]
    created = []
    for label in clean:
        plain = INVITE_PREFIX + secrets.token_urlsafe(24)
        row = TestplaceInvite(extension_id=extension.id, label=label, token_hash=hash_token(plain))
        session.add(row)
        created.append((plain, row))
    session.commit()
    for _, row in created:
        session.refresh(row)
    return created


def list_invites(session: Session, extension: Extension) -> list[TestplaceInvite]:
    return list(
        session.exec(
            select(TestplaceInvite)
            .where(TestplaceInvite.extension_id == extension.id)
            .order_by(TestplaceInvite.id)
        ).all()
    )


def invite_state(row: TestplaceInvite) -> str:
    if row.revoked_at is not None:
        return "revoked"
    return "joined" if row.member_id is not None else "pending"


def revoke_invite(session: Session, extension: Extension, invite_id: int) -> TestplaceInvite:
    row = session.get(TestplaceInvite, invite_id)
    if row is None or row.extension_id != extension.id:
        raise TestplaceError("NOT_FOUND", "invite not found", status=404)
    if row.revoked_at is None:
        row.revoked_at = _now()
        session.add(row)
        session.commit()
        session.refresh(row)
    return row


# -- public codes ------------------------------------------------------------
def create_code(
    session: Session, extension: Extension, max_testers: int
) -> tuple[str, TestplaceCode]:
    if max_testers < 1:
        raise TestplaceError("BAD_REQUEST", "max_testers must be at least 1")
    if not live_rows(session, extension):
        raise TestplaceError(
            "NO_TESTPLACE_VERSION", "publish a testplace version before opening a code", status=409
        )
    # D2: the first public code waits for a light review; once one passed,
    # later codes of the same extension open at once.
    reviewed = session.exec(
        select(TestplaceCode).where(
            TestplaceCode.extension_id == extension.id,
            TestplaceCode.review_status == APPROVED,
        )
    ).first()
    plain = CODE_PREFIX + secrets.token_urlsafe(12)
    row = TestplaceCode(
        extension_id=extension.id,
        code_hash=hash_token(plain),
        max_testers=max_testers,
        review_status=APPROVED if reviewed is not None else PENDING,
    )
    if reviewed is not None:
        row.reviewed_at = _now()
        row.reviewed_by = "previously-reviewed"
    session.add(row)
    session.commit()
    session.refresh(row)
    return plain, row


def list_codes(session: Session, extension: Extension) -> list[TestplaceCode]:
    return list(
        session.exec(
            select(TestplaceCode)
            .where(TestplaceCode.extension_id == extension.id)
            .order_by(TestplaceCode.id)
        ).all()
    )


def code_testers(session: Session, code: TestplaceCode) -> int:
    return session.exec(
        select(func.count()).select_from(TestplaceInvite).where(
            TestplaceInvite.code_id == code.id,
            TestplaceInvite.revoked_at.is_(None),
        )
    ).one()


def code_state(row: TestplaceCode) -> str:
    if row.revoked_at is not None:
        return "revoked"
    return {PENDING: "in-review", APPROVED: "open", REJECTED: "rejected"}[row.review_status]


def revoke_code(session: Session, extension: Extension, code_id: int) -> TestplaceCode:
    row = session.get(TestplaceCode, code_id)
    if row is None or row.extension_id != extension.id:
        raise TestplaceError("NOT_FOUND", "code not found", status=404)
    if row.revoked_at is None:
        row.revoked_at = _now()
        session.add(row)
        session.commit()
        session.refresh(row)
    return row


def code_queue(session: Session) -> list[TestplaceCode]:
    return list(
        session.exec(
            select(TestplaceCode)
            .where(TestplaceCode.review_status == PENDING, TestplaceCode.revoked_at.is_(None))
            .order_by(TestplaceCode.created_at)
        ).all()
    )


def decide_code(
    session: Session, code_id: int, *, approve: bool, reviewer: str, reason: str = ""
) -> TestplaceCode:
    reason = reason.strip()
    if not approve and not reason:
        raise TestplaceError("BAD_REQUEST", "a rejection needs a reason")
    if len(reason) > MAX_REASON_LENGTH:
        raise TestplaceError("BAD_REQUEST", f"reason is longer than {MAX_REASON_LENGTH} characters")
    result = session.exec(
        update(TestplaceCode)
        .where(TestplaceCode.id == code_id, TestplaceCode.review_status == PENDING)
        .values(
            review_status=APPROVED if approve else REJECTED,
            review_reason=reason or None,
            reviewed_at=_now(),
            reviewed_by=reviewer,
        )
        .execution_options(synchronize_session=False)
    )
    session.commit()
    if result.rowcount != 1:
        raise TestplaceError("NOT_FOUND", "no code waiting for review", status=404)
    row = session.get(TestplaceCode, code_id)
    session.refresh(row)
    return row


# -- joining -----------------------------------------------------------------
def join(session: Session, member_id: str, token: str) -> Extension:
    """Redeem a personal invite token or a public code for `member_id`.
    Every failure is the same NOT_FOUND, so a guess learns nothing."""
    token = token.strip()
    not_found = TestplaceError("NOT_FOUND", "invite or code not found", status=404)
    if token.startswith(INVITE_PREFIX):
        row = session.exec(
            select(TestplaceInvite).where(TestplaceInvite.token_hash == hash_token(token))
        ).first()
        if row is None or row.revoked_at is not None:
            raise not_found
        extension = session.get(Extension, row.extension_id)
        if row.member_id == member_id:
            return extension
        if row.member_id is not None:
            raise not_found
        if is_tester(session, extension, member_id):
            # Already in through another seat: leave this invite for its owner.
            return extension
        claimed = session.exec(
            update(TestplaceInvite)
            .where(TestplaceInvite.id == row.id, TestplaceInvite.member_id.is_(None))
            .values(member_id=member_id, claimed_at=_now())
            .execution_options(synchronize_session=False)
        )
        session.commit()
        if claimed.rowcount != 1:
            raise not_found
        return extension
    if token.startswith(CODE_PREFIX):
        code = session.exec(
            select(TestplaceCode).where(TestplaceCode.code_hash == hash_token(token))
        ).first()
        if code is None or code.revoked_at is not None or code.review_status != APPROVED:
            raise not_found
        extension = session.get(Extension, code.extension_id)
        if is_tester(session, extension, member_id):
            return extension
        full = TestplaceError("CODE_FULL", "this test code has no seats left", status=409)
        if code_testers(session, code) >= code.max_testers:
            raise full
        # The count above is only a fast answer: the seat is taken by one
        # INSERT ... SELECT that counts again, so two members joining at once
        # cannot both pass the cap (SQLite runs each write statement alone).
        now = _now()
        columns = TestplaceInvite.__table__.c
        live_seats = (
            sa_select(func.count())
            .select_from(TestplaceInvite)
            .where(TestplaceInvite.code_id == code.id, TestplaceInvite.revoked_at.is_(None))
            .scalar_subquery()
        )
        seated = session.exec(
            insert(TestplaceInvite).from_select(
                ["extension_id", "code_id", "member_id", "label", "created_at", "claimed_at"],
                sa_select(
                    literal(extension.id, columns.extension_id.type),
                    literal(code.id, columns.code_id.type),
                    literal(member_id, columns.member_id.type),
                    literal("", columns.label.type),
                    literal(now, columns.created_at.type),
                    literal(now, columns.claimed_at.type),
                ).where(live_seats < code.max_testers),
            )
        )
        session.commit()
        if seated.rowcount != 1:
            raise full
        return extension
    raise not_found


def leave(session: Session, extension: Extension, member_id: str) -> None:
    for row in session.exec(
        _live_seats(session, extension).where(TestplaceInvite.member_id == member_id)
    ).all():
        row.revoked_at = _now()
        session.add(row)
    session.commit()


# -- revoking a version ------------------------------------------------------
def revoke_version(
    session: Session, extension: Extension, version: str, *, reason: str, actor: str
) -> list[ExtensionVersion]:
    rows = version_rows(session, extension, version)
    if not rows:
        raise TestplaceError("NOT_FOUND", "testplace version not found", status=404)
    # R-MED-3: no `ns.name@version` entry in the public signed blocklist, which
    # would tell anyone the test build exists. Its testers learn of it from
    # the tester detail's `withdrawn` (withdrawn_rows), as for a yank.
    for row in rows:
        row.yanked = True
        session.add(row)
    session.commit()
    return rows


# -- promotion ---------------------------------------------------------------
def request_promotion(
    session: Session, extension: Extension, version: str
) -> list[ExtensionVersion]:
    rows = [r for r in version_rows(session, extension, version) if not r.yanked]
    if not rows or any(r.review_status != APPROVED for r in rows):
        raise TestplaceError("NOT_FOUND", "testplace version not found", status=404)
    if any(r.promotion_status == REQUESTED for r in rows):
        raise TestplaceError("ALREADY_REQUESTED", "this version is already in review", status=409)
    now = _now()
    for row in rows:
        row.promotion_status = REQUESTED
        row.promotion_requested_at = now
        row.promotion_reason = None
        session.add(row)
    session.commit()
    return rows


@dataclass(frozen=True)
class PromotionFacts:
    """What an admin sees next to a promotion request (9.5)."""

    testers: int
    first_published_at: datetime
    reports: int


def promotion_facts(session: Session, extension: Extension) -> PromotionFacts:
    testers = session.exec(
        select(func.count()).select_from(TestplaceInvite).where(
            TestplaceInvite.extension_id == extension.id,
            TestplaceInvite.revoked_at.is_(None),
            TestplaceInvite.member_id.is_not(None),
        )
    ).one()
    first = session.exec(
        select(func.min(ExtensionVersion.published_at)).where(
            ExtensionVersion.extension_id == extension.id,
            ExtensionVersion.channel == TESTPLACE_CHANNEL,
        )
    ).one()
    reports = session.exec(
        select(func.count()).select_from(ExtensionReport).where(
            ExtensionReport.extension_id == extension.id
        )
    ).one()
    return PromotionFacts(testers=testers, first_published_at=_aware(first), reports=reports)


def promotion_queue(session: Session) -> list[tuple[Extension, str, list[ExtensionVersion]]]:
    rows = session.exec(
        select(ExtensionVersion)
        .where(ExtensionVersion.promotion_status == REQUESTED)
        .order_by(ExtensionVersion.promotion_requested_at)
    ).all()
    grouped: dict[tuple[int, str], list[ExtensionVersion]] = {}
    for row in rows:
        grouped.setdefault((row.extension_id, row.version), []).append(row)
    return [
        (session.get(Extension, extension_id), version, items)
        for (extension_id, version), items in grouped.items()
    ]


def _requested_rows(session: Session, extension: Extension, version: str, artifacts: list[str]):
    rows = [
        r
        for r in version_rows(session, extension, version)
        if r.promotion_status == REQUESTED and not r.yanked
    ]
    if not rows:
        raise TestplaceError("NOT_FOUND", "no promotion request for this version", status=404)
    if sorted(r.package_digest for r in rows) != sorted(artifacts):
        raise TestplaceError(
            "STALE_REVIEW", "the artifacts changed since the review was loaded; reload", status=409
        )
    return rows


def approve_promotion(
    session: Session,
    signer: RegistryTrustSigner,
    *,
    extension: Extension,
    version: str,
    reviewer: str,
    artifacts: list[str],
    acknowledge_secret_findings: bool = False,
    inspected_native_backend: bool = False,
    rescan: Callable[[ExtensionVersion], dict | None] | None = None,
) -> list[ExtensionVersion]:
    """Re-sign the same artifacts (digest unchanged) on the channel their
    SemVer implies, without an expiry, and make them public. The approval
    passes exactly the checks a pending stable submission does
    (`review.check_approvable`: blocklist, pack nesting, similarity, the
    secret and native backend confirmations, a rescan), since a testplace
    build itself only had the automatic checks."""
    rows = _requested_rows(session, extension, version, artifacts)
    try:
        publisher_id, scans = review.check_approvable(
            session,
            signer,
            extension=extension,
            version=version,
            rows=rows,
            acknowledge_secret_findings=acknowledge_secret_findings,
            inspected_native_backend=inspected_native_backend,
            rescan=rescan,
        )
    except review.ReviewError as exc:
        raise TestplaceError("REVIEW_REFUSED", str(exc), status=409) from exc
    previously_public = [
        v.version
        for v in session.exec(
            select(ExtensionVersion).where(
                ExtensionVersion.extension_id == extension.id,
                ExtensionVersion.review_status == APPROVED,
                ExtensionVersion.channel != TESTPLACE_CHANNEL,
                ExtensionVersion.yanked == False,  # noqa: E712
            )
        ).all()
    ]
    claimed = session.exec(
        update(ExtensionVersion)
        .where(
            ExtensionVersion.id.in_([r.id for r in rows]),
            ExtensionVersion.promotion_status == REQUESTED,
        )
        .values(promotion_status=APPROVED)
        .execution_options(synchronize_session=False)
    )
    if claimed.rowcount != len(rows):
        session.rollback()
        raise TestplaceError("STALE_REVIEW", "another reviewer decided this meanwhile", status=409)
    now = _now()
    channel = version_channel(version)
    for row in rows:
        envelope, signature = signer.sign_envelope(
            artifact_digest=row.package_digest,
            package_id=extension.identity,
            version=row.version,
            target=row.target,
            publisher_id=publisher_id,
            channel=channel,
        )
        row.registry_envelope = envelope
        row.registry_signature = signature
        if rescan is not None:
            row.scan = scans[row.id]
        row.disclosure, row.disclosure_envelope, row.disclosure_signature = sign_disclosure(
            signer, row.manifest or {}, envelope, row.scan
        )
        row.trust_tier = compute_trust_tier(signed=True)
        row.channel = channel
        row.expires_at = None
        row.reviewed_at = now
        row.reviewed_by = reviewer
        row.promotion_status = APPROVED
        row.promotion_reviewed_at = now
        row.promotion_reviewed_by = reviewer
        session.add(row)
    if not previously_public or latest_stable_version([*previously_public, version]) == version:
        display_name, description, categories = manifest_listing(rows[0].manifest)
        extension.display_name = display_name
        extension.description = description
        extension.categories = categories
        extension.updated_at = now
        session.add(extension)
    session.commit()
    for row in rows:
        session.refresh(row)
    return rows


def reject_promotion(
    session: Session,
    *,
    extension: Extension,
    version: str,
    reviewer: str,
    reason: str,
    artifacts: list[str],
) -> list[ExtensionVersion]:
    reason = reason.strip()
    if not reason:
        raise TestplaceError("BAD_REQUEST", "a rejection needs a reason")
    if len(reason) > MAX_REASON_LENGTH:
        raise TestplaceError("BAD_REQUEST", f"reason is longer than {MAX_REASON_LENGTH} characters")
    rows = _requested_rows(session, extension, version, artifacts)
    now = _now()
    for row in rows:
        row.promotion_status = REJECTED
        row.promotion_reason = reason
        row.promotion_reviewed_at = now
        row.promotion_reviewed_by = reviewer
        session.add(row)
    session.commit()
    return rows
