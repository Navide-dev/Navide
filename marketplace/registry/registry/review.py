"""Review-before-publish state machine (D3).

    pending --approve--> approved   (registry-signs every pending artifact)
    pending --reject---> rejected   (reason required; shown to the publisher)

Nothing else moves: approved and rejected are final, and a version cannot go
back to pending. Only approved rows are signed and visible through public
reads (repository.py filters on `review_status`). There is no auto-approve
for review-required publishers; admin-created (official) publishers are not
review-required, so their publishes are approved at submission as before.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from datetime import datetime, timedelta, timezone

from sqlmodel import Session, select, update

from .disclosure import sign_disclosure
from .discovery import PACK_CATEGORY, pack_members
from .manifest import manifest_capabilities
from .models import Extension, ExtensionVersion, Publisher
from .packs import pack_conflict
from .registry_trust import RegistryTrustSigner
from .repository import RegistryRepository
from .secret_scan import scan_package
from .similarity import check_extension_name
from .trust import compute_trust_tier, sensitive_capabilities
from .versions import TESTPLACE_CHANNEL, latest_stable_version

PENDING = "pending"
APPROVED = "approved"
REJECTED = "rejected"
STATUSES = (PENDING, APPROVED, REJECTED)
_TRANSITIONS = {PENDING: {APPROVED, REJECTED}}

SLA_BUSINESS_DAYS = 3
MAX_REASON_LENGTH = 500


class ReviewError(ValueError):
    pass


def can_transition(current: str, target: str) -> bool:
    return target in _TRANSITIONS.get(current, set())


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def business_deadline(start: datetime, days: int = SLA_BUSINESS_DAYS) -> datetime:
    """`start` plus `days` business days (Saturday and Sunday skipped)."""
    current = _aware(start)
    remaining = days
    while remaining > 0:
        current += timedelta(days=1)
        if current.weekday() < 5:
            remaining -= 1
    return current


def manifest_listing(manifest: dict) -> tuple[str | None, str | None, list[str]]:
    """(display name, description, categories) the way publish derives them."""
    if manifest.get("schemaVersion") == 2:
        marketplace = manifest.get("marketplace") or {}
        categories = list(marketplace.get("categories") or [])
        # A pack is listed under Extension Packs whatever it declares (as at publish).
        if pack_members(manifest) and PACK_CATEGORY not in categories:
            categories.append(PACK_CATEGORY)
        return manifest.get("name"), marketplace.get("description"), categories
    return (
        manifest.get("displayName") or manifest.get("name"),
        manifest.get("description"),
        list(manifest.get("categories") or []),
    )


def submission_report(
    session: Session,
    *,
    namespace: str,
    name: str,
    data: bytes,
    manifest: dict,
    signature_present: bool,
    size_limit: int,
) -> dict:
    """Automatic checks a reviewer sees next to the submission (card 10)."""
    others = [
        (row.namespace, row.name)
        for row in session.exec(select(Extension)).all()
    ]
    has_backend = manifest.get("backend") is not None
    similarity = [
        f.as_dict() for f in check_extension_name(namespace, name, others, strict=has_backend)
    ]
    capabilities = manifest_capabilities(manifest)
    return {
        "signature": "publisher-signed" if signature_present else "unsigned",
        "similarity": similarity,
        "secret_scan": scan_package(
            data, backend_prefix="backend/" if has_backend else None
        ).as_dict(),
        "native_backend": has_backend,
        "capabilities": capabilities,
        "sensitive_capabilities": sensitive_capabilities(capabilities),
        "size": len(data),
        "size_limit": size_limit,
    }


def blocking_similarity(report: dict) -> bool:
    return any(item.get("tier") == "block" for item in report.get("similarity", []))


def secret_findings(report: dict) -> list[dict]:
    return list((report.get("secret_scan") or {}).get("findings", []))


def _pending_rows(session: Session, extension: Extension, version: str) -> list[ExtensionVersion]:
    return list(
        session.exec(
            select(ExtensionVersion)
            .where(
                ExtensionVersion.extension_id == extension.id,
                ExtensionVersion.version == version,
                ExtensionVersion.review_status == PENDING,
            )
            .order_by(ExtensionVersion.target)
        ).all()
    )


def _reviewed_rows(
    session: Session, extension: Extension, version: str, artifacts: Sequence[str]
) -> list[ExtensionVersion]:
    """The pending rows of `extension@version`, provided they are exactly the
    artifacts (package digests) the reviewer was shown. A target uploaded
    after the review page loaded must not ride along on the decision."""
    rows = _pending_rows(session, extension, version)
    if not rows:
        raise ReviewError("no pending submission for this version")
    if sorted(row.package_digest for row in rows) != sorted(artifacts):
        raise ReviewError(
            "the pending artifacts for this version changed since the review "
            "was loaded; reload and review again"
        )
    return rows


def _claim(session: Session, rows: list[ExtensionVersion], status: str, **values: object) -> None:
    """Move `rows` from pending to `status` in one conditional UPDATE, inside
    the caller's transaction. Another decision may have committed since the
    rows were read; if any row is no longer pending, nothing changes and the
    decision is refused instead of overwriting that one."""
    result = session.exec(
        update(ExtensionVersion)
        .where(
            ExtensionVersion.id.in_([row.id for row in rows]),
            ExtensionVersion.review_status == PENDING,
        )
        .values(review_status=status, **values)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != len(rows):
        session.rollback()
        raise ReviewError(
            "another reviewer decided this version meanwhile; reload to see the outcome"
        )


def check_approvable(
    session: Session,
    signer: RegistryTrustSigner,
    *,
    extension: Extension,
    version: str,
    rows: list[ExtensionVersion],
    acknowledge_secret_findings: bool = False,
    inspected_native_backend: bool = False,
    rescan: Callable[[ExtensionVersion], dict | None] | None = None,
) -> tuple[str, dict[int, dict | None]]:
    """Every check a reviewer's approval must pass before `rows` are signed
    and made public: blocklist, pack nesting, similarity, secret and native
    backend confirmations, and (with `rescan`) a fresh scan bound to each
    stored digest. Returns (publisher id, rescans by row id). Shared by
    `approve` and Testplace promotion, so a promoted build meets the same bar."""
    publisher = session.get(Publisher, extension.publisher_id)
    publisher_id = publisher.name if publisher else extension.namespace
    reason = signer.block_reason(
        publisher_id=publisher_id, package_id=extension.identity, version=version
    )
    if reason is not None:
        raise ReviewError(reason)
    # Re-run the pack nesting check against what is public now: two packs
    # that were each fine at submission must not both go live listing each
    # other.
    conflict = pack_conflict(
        RegistryRepository(session),
        extension.identity,
        pack_members(rows[0].manifest),
        include_pending=False,
    )
    if conflict is not None:
        raise ReviewError(f"cannot approve: {conflict}")
    for row in rows:
        if blocking_similarity(row.review_report):
            raise ReviewError("name similarity check blocks this submission; reject it")
        if secret_findings(row.review_report) and not acknowledge_secret_findings:
            raise ReviewError(
                "secret scan has findings; confirm they are false positives to approve"
            )
        if (row.review_report or {}).get("native_backend") and not inspected_native_backend:
            raise ReviewError(
                "this version ships a native backend; confirm every target's "
                "executable was inspected to approve"
            )
    # Rescan before anything is claimed: a stored package that no longer
    # matches its digest is refused here, not halfway through signing.
    scans = {}
    if rescan is not None:
        for row in rows:
            scans[row.id] = rescan(row)
            report = scans[row.id]
            if report is not None and report.get("artifactDigest") != row.package_digest:
                raise ReviewError("stored package does not match its digest; it cannot be approved")
    return publisher_id, scans


def approve(
    session: Session,
    signer: RegistryTrustSigner,
    *,
    extension: Extension,
    version: str,
    reviewer: str,
    artifacts: Sequence[str],
    acknowledge_secret_findings: bool = False,
    inspected_native_backend: bool = False,
    rescan: Callable[[ExtensionVersion], dict | None] | None = None,
) -> list[ExtensionVersion]:
    """Sign and publish the pending artifacts of `extension@version`, which
    must be exactly `artifacts` (the package digests the reviewer saw).
    `rescan` scans a row's stored package with the current scanner (contract
    3.8: the report signed is the one made at approval); without it the
    submission's report is signed."""
    rows = _reviewed_rows(session, extension, version, artifacts)
    publisher_id, scans = check_approvable(
        session,
        signer,
        extension=extension,
        version=version,
        rows=rows,
        acknowledge_secret_findings=acknowledge_secret_findings,
        inspected_native_backend=inspected_native_backend,
        rescan=rescan,
    )
    previously_public = [
        v.version
        for v in session.exec(
            select(ExtensionVersion).where(
                ExtensionVersion.extension_id == extension.id,
                ExtensionVersion.review_status == APPROVED,
                # A testplace build is not public: it must not keep a newer
                # reviewed version from setting the listing (S8 R3-M1).
                ExtensionVersion.channel != TESTPLACE_CHANNEL,
                ExtensionVersion.yanked == False,  # noqa: E712
            )
        ).all()
    ]
    now = _now()
    # Claim first: only rows this decision moved out of pending get signed.
    _claim(session, rows, APPROVED, reviewed_at=now, reviewed_by=reviewer)
    for row in rows:
        envelope, signature = signer.sign_envelope(
            artifact_digest=row.package_digest,
            package_id=extension.identity,
            version=row.version,
            target=row.target,
            publisher_id=publisher_id,
            channel=row.channel,
            expires_at=_aware(row.expires_at) if row.expires_at else None,
        )
        row.registry_envelope = envelope
        row.registry_signature = signature
        if rescan is not None:
            row.scan = scans[row.id]
        row.disclosure, row.disclosure_envelope, row.disclosure_signature = (
            sign_disclosure(signer, row.manifest or {}, envelope, row.scan)
        )
        row.trust_tier = compute_trust_tier(signed=True)
        row.review_status = APPROVED
        row.reviewed_at = now
        row.reviewed_by = reviewer
        session.add(row)
    # The listing follows the latest stable version: approving an older
    # version or a pre-release must not roll it back. The first approved
    # version always sets it, since the listing has nothing else to show.
    becomes_latest = latest_stable_version([*previously_public, version]) == version
    if not previously_public or becomes_latest:
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


def reject(
    session: Session,
    *,
    extension: Extension,
    version: str,
    reviewer: str,
    reason: str,
    artifacts: Sequence[str],
) -> list[ExtensionVersion]:
    reason = reason.strip()
    if not reason:
        raise ReviewError("a rejection needs a reason")
    if len(reason) > MAX_REASON_LENGTH:
        raise ReviewError(f"reason is longer than {MAX_REASON_LENGTH} characters")
    rows = _reviewed_rows(session, extension, version, artifacts)
    now = _now()
    _claim(session, rows, REJECTED, review_reason=reason, reviewed_at=now, reviewed_by=reviewer)
    session.commit()
    for row in rows:
        session.refresh(row)
    return rows


def review_queue(session: Session, now: datetime | None = None) -> list[dict]:
    """Pending submissions grouped by extension version, oldest first."""
    now = now or _now()
    groups: dict[tuple[int, str], dict] = {}
    rows = session.exec(
        select(ExtensionVersion)
        .where(ExtensionVersion.review_status == PENDING)
        .order_by(ExtensionVersion.published_at)
    ).all()
    for row in rows:
        key = (row.extension_id, row.version)
        group = groups.get(key)
        if group is None:
            extension = session.get(Extension, row.extension_id)
            publisher = session.get(Publisher, extension.publisher_id)
            submitted = _aware(row.published_at)
            deadline = business_deadline(submitted)
            group = {
                "extension": extension,
                "publisher": publisher,
                "version": row.version,
                "submitted_at": submitted,
                "waiting": now - submitted,
                "deadline": deadline,
                "overdue": now > deadline,
                "targets": [],
                "artifacts": [],
                "reports": [],
            }
            groups[key] = group
        group["targets"].append(row.target)
        group["artifacts"].append(row.package_digest)
        group["reports"].append(row.review_report)
    return list(groups.values())


def format_wait(delta: timedelta) -> str:
    hours = int(delta.total_seconds() // 3600)
    days, hours = divmod(hours, 24)
    if days:
        return f"{days} day{'s' if days != 1 else ''} {hours} h"
    minutes = int(delta.total_seconds() // 60) % 60
    return f"{hours} h {minutes} min"
