"""Read-only check that a claude account just switched in can still sign in.

A switch restores the incoming account's slot: a cold snapshot taken when the
user last switched away from it. Its refresh token may have been rotated since
by a pane that still held that account in memory, and nothing short of a
refresh request can tell — which this module never makes. What it can see is
the outcome: when Claude Code's refresh is rejected (``invalid_grant``) it
empties both tokens of the live credential in place. So for a short window
after the switch this watches the live credential, read only:

  - wiped or missing right after the restore      -> needs a sign-in
  - wiped later in the window                     -> needs a sign-in
  - replaced by a different, non-wiped credential -> renewed, healthy; stop
  - unchanged until the window ends               -> nothing proven; stop

On "needs a sign-in" the user is told once, in the Navide window and in bound
direct chats. Nothing is retried, switched back, refreshed or written, and no
failure here can reach the switch: every path is caught and logged.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from typing import Any, Awaitable, Callable

log = logging.getLogger("agent_team_backend.account_switch_verify")

WATCH_WINDOW_S = 180.0
POLL_INTERVAL_S = 15.0

#: Event the windows turn into a notice (see App.vue).
EVENT = "cli_profiles.switch_login_failed"

_tasks: dict[str, asyncio.Task] = {}

ReadLive = Callable[[], Awaitable[str | None]]
Notify = Callable[[str, str, str], Awaitable[None]]


def _fingerprint(secret: str | None) -> str | None:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest() if secret else None


def verdict(secret: str | None, restored_fp: str | None) -> str:
    """One reading of the live credential against the restored one.

    ``needs-login``: nothing is signed in, or Claude Code wiped the tokens.
    ``renewed``: a different credential that still carries a token.
    ``unchanged``: still the restored credential (or no baseline to judge)."""
    from .credential_vault import _claude_credential_is_wiped

    if secret is None or _claude_credential_is_wiped(secret):
        return "needs-login"
    fp = _fingerprint(secret)
    if restored_fp is not None and fp != restored_fp:
        return "renewed"
    return "unchanged"


async def watch(
    agent_key: str,
    profile_id: str,
    read_live: ReadLive,
    notify: Notify,
    *,
    window_s: float = WATCH_WINDOW_S,
    interval_s: float = POLL_INTERVAL_S,
    clock: Callable[[], float] | None = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> str:
    """Watch the live credential after a switch to ``profile_id``. Returns the
    outcome (``needs-login`` / ``renewed`` / ``timeout`` / ``error``). Never
    raises except on cancellation (a newer switch supersedes this watch)."""
    loop = asyncio.get_running_loop()
    now = clock or loop.time
    try:
        first = await read_live()
        restored_fp = _fingerprint(first)
        result = verdict(first, restored_fp)
        deadline = now() + window_s
        while result == "unchanged" and now() < deadline:
            await sleep(interval_s)
            result = verdict(await read_live(), restored_fp)
        if result == "unchanged":
            return "timeout"
        if result == "needs-login":
            log.info("%s account %s cannot sign in after the switch; telling the user", agent_key, profile_id)
            await notify(agent_key, profile_id, "needs-login")
        return result
    except asyncio.CancelledError:
        raise
    except Exception as err:  # noqa: BLE001 — a check must never reach the switch
        log.warning("post-switch login check for %s/%s failed: %s", agent_key, profile_id, err)
        return "error"


def start(agent_key: str, profile_id: str, read_live: ReadLive, notify: Notify) -> asyncio.Task | None:
    """Begin the watch for a claude switch, superseding any earlier one for the
    same agent. Other agents are not watched (their CLIs do not wipe in place)."""
    if agent_key != "claude":
        return None
    old = _tasks.pop(agent_key, None)
    if old is not None and not old.done():
        old.cancel()
    task = asyncio.create_task(watch(agent_key, profile_id, read_live, notify))
    _tasks[agent_key] = task
    task.add_done_callback(lambda t: _tasks.pop(agent_key, None) if _tasks.get(agent_key) is t else None)
    return task


def _reset_for_test() -> None:
    for task in _tasks.values():
        task.cancel()
    _tasks.clear()


async def notify_windows_and_chats(agent_key: str, profile_id: str, reason: str, *, app: Any) -> None:
    """The default ``notify``: a window event plus a direct-chat notice."""
    from .ipc import make_event

    try:
        await app.broadcast(make_event(EVENT, {"agentKey": agent_key, "profileId": profile_id, "reason": reason}))
    except Exception as err:  # noqa: BLE001
        log.warning("post-switch login notice to the windows failed: %s", err)
    try:
        from .channels import get_manager

        manager = get_manager()
        if manager is not None:
            await manager.notify_account_needs_login(_account_label(app, agent_key, profile_id))
    except Exception as err:  # noqa: BLE001
        log.warning("post-switch login notice to the chats failed: %s", err)


def _account_label(app: Any, agent_key: str, profile_id: str) -> str:
    """The name the user gave the account (never an email lookup of its own)."""
    if profile_id == "__default__":
        names = app.cli_profiles_store.list().get("defaultNames") or {}
        return str(names.get(agent_key) or "Default")
    profile = app.cli_profiles_store.get(profile_id) or {}
    return str(profile.get("name") or profile_id)
