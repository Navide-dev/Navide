"""Member reports (moderation): a signed-in member flags an extension or one
of its versions; an admin dismisses it or acts on it.

    open --dismiss----------------------------> dismissed
    open --yank / block-package / block-publisher--> actioned

Acting reuses the existing yank (repository) and blocklist code. Every event
(open, dismiss, act) is appended to `report_audit`. The reporter's identity is
kept for admins only; publisher-facing views never include it.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select, update

from .blocklist import BlocklistError, add_entry
from .models import Extension, ExtensionReport, Publisher, ReportAuditEntry
from .repository import RegistryRepository

REASONS = (
    ("malware", "Malware or data theft"),
    ("impersonation", "Impersonates another publisher or product"),
    ("spam", "Spam or misleading listing"),
    ("broken", "Broken or does not work"),
    ("other", "Something else"),
)
REASON_KEYS = tuple(key for key, _ in REASONS)
ACTIONS = ("dismiss", "yank", "block-package", "block-publisher")
OPEN = "open"
DISMISSED = "dismissed"
ACTIONED = "actioned"
MAX_DETAIL_LENGTH = 1000
MAX_NOTE_LENGTH = 500
REPORT_LIMIT_PER_HOUR = 5
_ALREADY_RESOLVED = "this report is already resolved"


class ReportError(ValueError):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _audit(session: Session, report: ExtensionReport, actor: str, action: str, note: str | None) -> None:
    session.add(ReportAuditEntry(report_id=report.id, actor=actor, action=action, note=note))


def has_open_report(session: Session, extension: Extension, member_id: str) -> bool:
    return (
        session.exec(
            select(ExtensionReport).where(
                ExtensionReport.extension_id == extension.id,
                ExtensionReport.reporter_member_id == member_id,
                ExtensionReport.status == OPEN,
            )
        ).first()
        is not None
    )


def create_report(
    session: Session, *, extension: Extension, member_id: str, reason: str, detail: str, version: str
) -> ExtensionReport:
    if reason not in REASON_KEYS:
        raise ReportError("choose a reason")
    detail = detail.strip()
    if len(detail) > MAX_DETAIL_LENGTH:
        raise ReportError(f"details are limited to {MAX_DETAIL_LENGTH} characters")
    version = version.strip()
    # Public versions only: a testplace or unreviewed version answers like a
    # missing one, so the form cannot tell anyone it exists (R-MED-4).
    if version and not RegistryRepository(session).list_version_artifacts(
        extension.id, version, public_only=True
    ):
        raise ReportError("that version does not exist")
    if has_open_report(session, extension, member_id):
        raise ReportError("you already have an open report for this extension")
    report = ExtensionReport(
        extension_id=extension.id,
        version=version or None,
        reporter_member_id=member_id,
        reason=reason,
        detail=detail,
    )
    session.add(report)
    try:
        session.flush()
    except IntegrityError as exc:  # a concurrent open report won the race
        session.rollback()
        raise ReportError("you already have an open report for this extension") from exc
    _audit(session, report, f"member:{member_id}", "open", reason)
    session.commit()
    session.refresh(report)
    return report


def resolve(session: Session, *, report_id: int, actor: str, action: str, note: str) -> ExtensionReport:
    """Dismiss or act on an open report; the note is required. Blocking uses
    the note as the public reason on the removed list.

    The open -> resolved transition is a conditional UPDATE that takes the
    write lock before the action runs, and the action's own commit carries it,
    so of two admins resolving at once exactly one acts; the other gets
    "already resolved"."""
    report = session.get(ExtensionReport, report_id)
    if report is None:
        raise LookupError("report not found")
    if report.status != OPEN:
        raise ReportError(_ALREADY_RESOLVED)
    if action not in ACTIONS:
        raise ReportError("unknown action")
    note = note.strip()
    if not note or len(note) > MAX_NOTE_LENGTH:
        raise ReportError(f"a resolution note of 1-{MAX_NOTE_LENGTH} characters is required")
    extension = session.get(Extension, report.extension_id)
    if extension is None:
        raise LookupError("extension not found")
    repo = RegistryRepository(session)
    if action == "yank":
        if report.version is None:
            raise ReportError("this report names no version to yank")
        artifacts = repo.list_version_artifacts(extension.id, report.version, public_only=False)
        if not artifacts:
            raise ReportError("version not found")
    elif action == "block-package":
        kind, value = "package", extension.identity
    elif action == "block-publisher":
        publisher = session.get(Publisher, extension.publisher_id)
        kind, value = "publisher", publisher.name if publisher else extension.namespace

    claimed = session.execute(
        update(ExtensionReport)
        .where(ExtensionReport.id == report_id, ExtensionReport.status == OPEN)
        .values(
            status=DISMISSED if action == "dismiss" else ACTIONED,
            resolution=action,
            resolution_note=note,
            resolved_at=_now(),
            resolved_by=actor,
        )
    )
    if claimed.rowcount != 1:
        session.rollback()
        raise ReportError(_ALREADY_RESOLVED)
    _audit(session, report, actor, action, note)
    try:
        # yank_version / add_entry commit, which also commits the claim and
        # the audit row; a refusal before that rolls all three back.
        if action == "yank":
            repo.yank_version(artifacts)
        elif action in ("block-package", "block-publisher"):
            add_entry(session, kind=kind, value=value, reason=note, created_by=actor)
        else:
            session.commit()
    except BlocklistError as exc:
        session.rollback()
        raise ReportError(str(exc)) from exc
    session.refresh(report)
    return report


def audit_trail(session: Session, report_id: int) -> list[ReportAuditEntry]:
    return list(
        session.exec(
            select(ReportAuditEntry)
            .where(ReportAuditEntry.report_id == report_id)
            .order_by(ReportAuditEntry.id)
        ).all()
    )


def admin_queue(session: Session, *, resolved_limit: int = 50) -> tuple[list[dict], list[dict]]:
    """(open reports oldest first, recently resolved newest first), each with
    the reporter and audit trail (admin only)."""
    def view(report: ExtensionReport) -> dict:
        extension = session.get(Extension, report.extension_id)
        return {
            "id": report.id,
            "identity": extension.identity if extension else "?",
            "namespace": extension.namespace if extension else "",
            "name": extension.name if extension else "",
            "version": report.version,
            "reason": report.reason,
            "detail": report.detail,
            "reporter": report.reporter_member_id,
            "created_at": report.created_at,
            "status": report.status,
            "resolution": report.resolution,
            "resolution_note": report.resolution_note,
            "resolved_by": report.resolved_by,
            "resolved_at": report.resolved_at,
            "audit": audit_trail(session, report.id),
        }

    open_rows = session.exec(
        select(ExtensionReport).where(ExtensionReport.status == OPEN).order_by(ExtensionReport.id)
    ).all()
    resolved_rows = session.exec(
        select(ExtensionReport)
        .where(ExtensionReport.status != OPEN)
        .order_by(ExtensionReport.resolved_at.desc())
        .limit(resolved_limit)
    ).all()
    return [view(r) for r in open_rows], [view(r) for r in resolved_rows]


def publisher_reports(session: Session, publisher: Publisher) -> list[dict]:
    """Reports on this publisher's extensions, without reporter identity."""
    rows = session.exec(
        select(ExtensionReport, Extension)
        .where(ExtensionReport.extension_id == Extension.id, Extension.publisher_id == publisher.id)
        .order_by(ExtensionReport.id.desc())
    ).all()
    return [
        {
            "identity": extension.identity,
            "version": report.version,
            "reason": report.reason,
            "detail": report.detail,
            "created_at": report.created_at,
            "status": report.status,
            "resolution": report.resolution,
            "resolution_note": report.resolution_note,
        }
        for report, extension in rows
    ]
