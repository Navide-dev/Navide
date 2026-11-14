"""Which panes' CLIs never reached the navide MCP server (/plan-mcp).

On 2026-11-12 a mass restore slowed /plan-mcp past Claude Code's connect
budget; thirteen panes gave up after three retries and sat without any Navide
tool until someone typed /mcp the next day. Nothing noticed: the backend kept
no record of whether a pane's CLI had ever connected.

Every accepted pane credential on /plan-mcp records the time here. A pane
whose CLI is up — realized, and reported idle/running/awaiting by its window —
for NEVER_CONNECTED_AFTER_S without one is "never-connected": cli_get_status
and cli_list_targets say so, and the sweep reports it once so the window and
the bound chats can tell the user. Only vendors that dial the server at
startup are judged; one that connects lazily would be flagged for no fault.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable

from . import agent_messaging
from .mcp_server import wiring as mcp_wiring

log = logging.getLogger(__name__)

NEVER_CONNECTED_AFTER_S = 180.0
SWEEP_INTERVAL_S = 30.0
STATE_NEVER_CONNECTED = "never-connected"

#: Vendors whose CLI connects to its MCP servers while it starts.
EAGER_AGENTS = frozenset({"claude"})
_UP_STATUSES = frozenset({"idle", "running", "awaiting"})

#: Presented pane id -> wall-clock time of its last accepted /plan-mcp request.
_last_seen: dict[str, float] = {}
#: Pane id -> monotonic time its CLI was first seen up without a connection.
_up_since: dict[str, float] = {}
#: Pane ids already reported by sweep(), so each is reported once.
_reported: set[str] = set()
#: Reported pane ids that have since connected, until take_cleared() reads them.
_cleared: list[str] = []


def record_connect(pane_id: str) -> None:
    """A /plan-mcp request from ``pane_id`` passed its credential check."""
    _last_seen[pane_id] = time.time()


def last_connect(pane_id: str) -> float | None:
    """Latest /plan-mcp time of this pane under its current or a former id."""
    ids = [pane_id, *agent_messaging.former_ids(pane_id)]
    times = [_last_seen[i] for i in ids if i in _last_seen]
    return max(times) if times else None


def _judged(entry: agent_messaging.RegisteredPane) -> bool:
    if entry.agent_key not in EAGER_AGENTS or not entry.realized or entry.is_dock:
        return False
    ids = [entry.pane_id, *agent_messaging.former_ids(entry.pane_id)]
    return any(mcp_wiring.bound_pane_token(i) for i in ids)


def state(pane_id: str, now: float | None = None) -> str:
    """STATE_NEVER_CONNECTED, or "" when connected, not judged or not yet due."""
    entry = agent_messaging.current(pane_id)
    if entry is None or not _judged(entry) or last_connect(entry.pane_id) is not None:
        return ""
    since = _up_since.get(entry.pane_id)
    now = time.monotonic() if now is None else now
    if since is None or now - since < NEVER_CONNECTED_AFTER_S:
        return ""
    return STATE_NEVER_CONNECTED


def sweep(now: float | None = None) -> list[agent_messaging.RegisteredPane]:
    """Advance the clocks and return panes that just became never-connected."""
    now = time.monotonic() if now is None else now
    live: set[str] = set()
    newly: list[agent_messaging.RegisteredPane] = []
    for entry in agent_messaging.list_panes():
        if not _judged(entry) or last_connect(entry.pane_id) is not None:
            continue
        live.add(entry.pane_id)
        if entry.offline_since is not None or entry.display_status not in _UP_STATUSES:
            continue
        _up_since.setdefault(entry.pane_id, now)
        if state(entry.pane_id, now) and entry.pane_id not in _reported:
            _reported.add(entry.pane_id)
            newly.append(entry)
    for pane_id in [p for p in _up_since if p not in live]:
        del _up_since[pane_id]
    _cleared.extend(
        p for p in _reported
        if p not in live and agent_messaging.current(p) is not None and last_connect(p) is not None
    )
    _reported.intersection_update(live)
    return newly


def take_cleared() -> list[str]:
    """Reported panes that connected after all (a manual /mcp, a rebuild)."""
    out = list(_cleared)
    _cleared.clear()
    return out


async def run(
    notify: Callable[[agent_messaging.RegisteredPane], Awaitable[None]],
    notify_cleared: Callable[[str], Awaitable[None]] | None = None,
) -> None:
    """Sweep every SWEEP_INTERVAL_S: hand each newly flagged pane to
    ``notify``, and each flagged pane that has since connected to
    ``notify_cleared``."""
    while True:
        await asyncio.sleep(SWEEP_INTERVAL_S)
        for entry in sweep():
            try:
                await notify(entry)
            except Exception as err:  # noqa: BLE001 — the loop must survive a failed notice
                log.warning("mcp connect watch: notice for %s failed: %s", entry.pane_id, err)
        for pane_id in take_cleared():
            if notify_cleared is None:
                continue
            try:
                await notify_cleared(pane_id)
            except Exception as err:  # noqa: BLE001
                log.warning("mcp connect watch: cleared notice for %s failed: %s", pane_id, err)


def _reset_for_test() -> None:
    _cleared.clear()
    _last_seen.clear()
    _up_since.clear()
    _reported.clear()
