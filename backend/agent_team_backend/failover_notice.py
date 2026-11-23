"""After an automatic quota switch: the record and the chat notice (plan agent-0-2-42_3f728e P3).

quota_failover tells its commit listeners about every switch that moved
credentials. An automatic one (the user set "Switch automatically") is the
one switch nobody clicked, so it goes where the other unattended switches go:
a row in account_switch_log (source "failover") and a notice to the bound
direct chats, with a "switch back" button where the chat has one. A switch
the user started from the window's announcement is their own click and is
left out, as a click in Settings is.

Everything here runs after the commit, on its own task: a failure is logged
and never reaches the switch.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Callable

log = logging.getLogger(__name__)

REQUESTER = "quota-failover"
_DEFAULT_SLOT_ID = "__default__"

_remove: Callable[[], None] | None = None
_remove_stuck: Callable[[], None] | None = None


def account_name(app: Any, agent_key: str, profile_id: str) -> str:
    """The name the user gave the account (never an email lookup of its own)."""
    if profile_id == _DEFAULT_SLOT_ID:
        names = app.cli_profiles_store.list().get("defaultNames") or {}
        return str(names.get(agent_key) or "Default")
    profile = app.cli_profiles_store.get(profile_id) or {}
    return str(profile.get("name") or profile_id)


def chat_name(app: Any, agent_key: str, profile_id: str) -> tuple[str, bool]:
    """The name a chat shows for the account, as the desktop pane header chip names it
    (accountChipLabel): the user's alias, else the signed-in email's local part, else the
    given name. ``(label, builtin)``: builtin when the built-in Default has none of them,
    so the chat words it in its own language. Never the whole email."""
    if profile_id == _DEFAULT_SLOT_ID:
        alias = str((app.cli_profiles_store.list().get("defaultNames") or {}).get(agent_key) or "")
        name = ""
    else:
        profile = app.cli_profiles_store.get(profile_id) or {}
        name = str(profile.get("name") or profile_id)
        alias = name if profile.get("nameIsCustom") else ""
    if alias:
        return alias, False
    email = (app.credential_vault.identity(agent_key, profile_id) or {}).get("email")
    if isinstance(email, str) and "@" in email and email.index("@") > 0:
        return email[: email.index("@")], False
    return (name, False) if name else ("Default", True)


async def on_commit(event: dict[str, Any]) -> None:
    if not event.get("automatic"):
        return
    from . import app

    agent_key = str(event.get("agentKey") or "")
    from_id = str(event.get("fromSlotId") or _DEFAULT_SLOT_ID)
    to_id = str(event.get("toSlotId") or _DEFAULT_SLOT_ID)
    needs_login = bool(event.get("needsLogin"))
    from_name = await asyncio.to_thread(account_name, app, agent_key, from_id)
    to_name = await asyncio.to_thread(account_name, app, agent_key, to_id)
    # The audit row keeps the given names; only the chat gets the email-derived one.
    from_chat, from_builtin = await asyncio.to_thread(chat_name, app, agent_key, from_id)
    to_chat, to_builtin = await asyncio.to_thread(chat_name, app, agent_key, to_id)
    row_id = await asyncio.to_thread(
        app.account_switch_log.record_request,
        source="failover", requester=REQUESTER, agent_key=agent_key, to_profile_id=to_id,
        to_name=to_name, reason=f"quota ran out on {from_name}",
    )
    if row_id is not None:
        state = str(event.get("state") or "")
        await asyncio.to_thread(
            app.account_switch_log.finish, row_id,
            "switched" if state == "committed" else (state or "unknown"),
            code="target-needs-login" if needs_login else None,
            from_profile_id=from_id, from_name=from_name, to_name=to_name,
        )
    from .channels import get_manager

    manager = get_manager()
    if manager is None:
        return
    pane_ids = event.get("paneIds")
    await manager.notify_failover_switch(
        agent_key=agent_key, pane_ids=[str(p) for p in pane_ids] if isinstance(pane_ids, list) else [],
        from_id=from_id, from_label=from_chat, from_builtin=from_builtin,
        to_id=to_id, to_label=to_chat, to_builtin=to_builtin, needs_login=needs_login,
    )


def _duration(seconds: float) -> str:
    minutes = max(0, int(seconds // 60))
    return f"{minutes // 60}h{minutes % 60:02d}m" if minutes >= 60 else f"{minutes}m"


async def on_stuck(event: dict[str, Any]) -> None:
    """A stopped continuation is still open (or just expired): tell the chats,
    so an incident nobody saw in the window does not sit for hours."""
    from datetime import datetime

    from .channels import get_manager

    manager = get_manager()
    if manager is None:
        return
    expires_in = ""
    raw = event.get("expiresAt")
    if isinstance(raw, str) and raw:
        try:
            left = datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp() - time.time()
            expires_in = _duration(left)
        except ValueError:
            expires_in = ""
    pane_ids = event.get("paneIds")
    await manager.notify_failover_stuck(
        agent_key=str(event.get("agentKey") or ""),
        pane_ids=[str(p) for p in pane_ids] if isinstance(pane_ids, list) else [],
        reason=str(event.get("reason") or "unknown"),
        minutes=max(0, int(event.get("stoppedForSec") or 0) // 60),
        expires_in=expires_in, final=bool(event.get("final")),
    )


def install() -> None:
    global _remove, _remove_stuck
    from .quota_failover import add_commit_listener, add_stuck_listener

    if _remove is None:
        _remove = add_commit_listener(on_commit)
    if _remove_stuck is None:
        _remove_stuck = add_stuck_listener(on_stuck)


def uninstall() -> None:
    global _remove, _remove_stuck
    if _remove is not None:
        _remove()
        _remove = None
    if _remove_stuck is not None:
        _remove_stuck()
        _remove_stuck = None
