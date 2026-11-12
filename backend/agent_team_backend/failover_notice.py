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
from typing import Any, Callable

log = logging.getLogger(__name__)

REQUESTER = "quota-failover"
_DEFAULT_SLOT_ID = "__default__"

_remove: Callable[[], None] | None = None


def account_name(app: Any, agent_key: str, profile_id: str) -> str:
    """The name the user gave the account (never an email lookup of its own)."""
    if profile_id == _DEFAULT_SLOT_ID:
        names = app.cli_profiles_store.list().get("defaultNames") or {}
        return str(names.get(agent_key) or "Default")
    profile = app.cli_profiles_store.get(profile_id) or {}
    return str(profile.get("name") or profile_id)


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
        from_id=from_id, from_label=from_name, to_id=to_id, to_label=to_name, needs_login=needs_login,
    )


def install() -> None:
    global _remove
    from .quota_failover import add_commit_listener

    if _remove is None:
        _remove = add_commit_listener(on_commit)


def uninstall() -> None:
    global _remove
    if _remove is not None:
        _remove()
        _remove = None
