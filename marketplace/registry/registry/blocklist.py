"""Admin-managed blocklist and the public removed-extensions list.

Before Phase 2 the blocklist lived only in the official trust config file.
Entries added here are merged with it everywhere the config lists are used
(publish refusal and the root-signed trust metadata clients enforce), and a
blocked package or publisher is also hidden from public reads.
"""

from __future__ import annotations

import re
from datetime import timezone

from sqlalchemy import Engine
from sqlmodel import Session, select

from . import audit
from .config import PACKAGE_PATTERN, PUBLISHER_PATTERN, Settings
from .models import BlocklistEntry

KINDS = ("publisher", "package", "digest")
_DIGEST_RE = re.compile(r"[0-9a-f]{64}")
MAX_REASON_LENGTH = 500


class BlocklistError(ValueError):
    pass


def validate(kind: str, value: str) -> str:
    value = value.strip()
    if kind == "publisher":
        if not PUBLISHER_PATTERN.fullmatch(value):
            raise BlocklistError("publisher must be a namespace such as acme-tools")
    elif kind == "package":
        if not PACKAGE_PATTERN.fullmatch(value):
            raise BlocklistError("package must be namespace.name or namespace.name@version")
    elif kind == "digest":
        value = value.lower()
        if not _DIGEST_RE.fullmatch(value):
            raise BlocklistError("digest must be the 64-character sha256 hex of a .vsix file")
    else:
        raise BlocklistError("kind must be publisher, package or digest")
    return value


def add_entry(session: Session, *, kind: str, value: str, reason: str, created_by: str) -> BlocklistEntry:
    value = validate(kind, value)
    reason = reason.strip()
    if not reason or len(reason) > MAX_REASON_LENGTH:
        raise BlocklistError(f"a reason of 1-{MAX_REASON_LENGTH} characters is required")
    existing = session.exec(
        select(BlocklistEntry).where(BlocklistEntry.kind == kind, BlocklistEntry.value == value)
    ).first()
    if existing is not None:
        raise BlocklistError(f"{value} is already blocked")
    entry = BlocklistEntry(kind=kind, value=value, reason=reason, created_by=created_by)
    session.add(entry)
    audit.record(session, actor=created_by, action="blocklist.add", target=f"{kind}:{value}", reason=reason)
    session.commit()
    session.refresh(entry)
    return entry


def remove_entry(session: Session, entry_id: int, *, actor: str | None = None) -> bool:
    """Delete an entry; with `actor`, the removal is written to the audit
    trail (the entry itself does not survive)."""
    entry = session.get(BlocklistEntry, entry_id)
    if entry is None:
        return False
    if actor is not None:
        audit.record(
            session,
            actor=actor,
            action="blocklist.remove",
            target=f"{entry.kind}:{entry.value}",
            detail={"reason_was": entry.reason, "created_by": entry.created_by},
        )
    session.delete(entry)
    session.commit()
    return True


def digest_blocked(session: Session, digest: str) -> BlocklistEntry | None:
    """A package whose sha256 is blocked is refused at publish and listed in
    the local-install trust document (qualification.local_install_entries)."""
    return session.exec(
        select(BlocklistEntry).where(BlocklistEntry.kind == "digest", BlocklistEntry.value == digest.lower())
    ).first()


def db_entries(session: Session) -> list[BlocklistEntry]:
    return list(session.exec(select(BlocklistEntry).order_by(BlocklistEntry.created_at.desc())).all())


def db_blocklists(engine: Engine) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """(publishers, packages) from the database, for RegistryTrustSigner."""
    with Session(engine) as session:
        entries = db_entries(session)
    return (
        tuple(e.value for e in entries if e.kind == "publisher"),
        tuple(e.value for e in entries if e.kind == "package"),
    )


def hides_extension(publishers: set[str], packages: set[str], namespace: str, identity: str) -> bool:
    """Whole-package and whole-publisher entries hide an extension from public
    reads; a single blocked version only refuses that version."""
    return namespace in publishers or identity in packages


def removed_list(session: Session, settings: Settings) -> list[dict]:
    """Public list: admin entries (with reason and date) plus config entries."""
    items: list[dict] = [
        {
            "kind": e.kind,
            "value": e.value,
            "reason": e.reason,
            "removed_at": e.created_at.replace(tzinfo=e.created_at.tzinfo or timezone.utc),
            "source": "admin",
        }
        for e in db_entries(session)
    ]
    seen = {(i["kind"], i["value"]) for i in items}
    for kind, values in (("publisher", settings.blocked_publishers), ("package", settings.blocked_packages)):
        for value in values:
            if (kind, value) not in seen:
                items.append(
                    {"kind": kind, "value": value, "reason": None, "removed_at": None, "source": "config"}
                )
    return items
