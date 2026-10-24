"""Append-only registry audit trail (models.RegistryAudit).

`record` only adds the row; the caller commits it together with the change it
describes, so an action and its audit row land or fail together. Rows are
never updated or deleted. `detail` holds facts only: never a token, a key or
any other secret.
"""

from __future__ import annotations

from sqlmodel import Session, select

from .models import RegistryAudit

SYSTEM_REVOCATION = "system:qualification-revoked"
SYSTEM_GRANDFATHER_EXPIRED = "system:grandfather-expired"


def member_actor(member_id: str) -> str:
    return f"member:{member_id}"


def admin_actor(member_id: str) -> str:
    return f"admin:member:{member_id}"


ADMIN_TOKEN_ACTOR = "admin-token"


def record(
    session: Session,
    *,
    actor: str,
    action: str,
    target: str,
    reason: str | None = None,
    detail: dict | None = None,
) -> RegistryAudit:
    row = RegistryAudit(actor=actor, action=action, target=target, reason=reason, detail=detail or {})
    session.add(row)
    return row


def entries(session: Session, *, target: str | None = None, limit: int = 200) -> list[RegistryAudit]:
    statement = select(RegistryAudit).order_by(RegistryAudit.id.desc()).limit(limit)
    if target is not None:
        statement = statement.where(RegistryAudit.target == target)
    return list(session.exec(statement).all())
