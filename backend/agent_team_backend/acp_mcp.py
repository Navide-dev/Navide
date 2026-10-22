"""The MCP tools' answers for an ACP pane, kept out of mcp_server/server.py.

ACP is added beside the existing modes, never woven into them (user,
2026-10-23). Each tool in server.py gets one added hand-off here, ahead of its
unchanged body; for every pane that is not a live ACP pane each function below
returns its "not mine" value at once (None, {} or ""), so the tool goes on
exactly as before. test_acp_tui_unchanged.py pins the rest of each tool to
main's text.

An ACP pane is one whose agent the backend runs over the Agent Client Protocol
(acp_ws / acp_sessions); its own session state is authoritative, so none of
this asks a window or reads a terminal.
"""

from __future__ import annotations

import asyncio
import time
from contextlib import AbstractContextManager
from typing import Any, Callable

# How often cli_wait_idle looks at an ACP pane's state (the same cadence the
# tool uses for every other pane).
WAIT_POLL_S = 1.0


def _session(pane_id: str) -> Any:
    from agent_team_backend import acp_ws

    return acp_ws.session_for_pane(pane_id)


def transcript_path(pane_id: str) -> str:
    """cli_read_log's fallback: the transcript the backend appends itself, for
    an ACP pane whose window recorded no log path. "" for any other pane."""
    acp = _session(pane_id)
    if acp is None or acp.transcript_path is None:
        return ""
    return str(acp.transcript_path)


def status_fields(pane_id: str) -> dict[str, Any]:
    """cli_get_status's extra keys for an ACP pane; {} for any other pane."""
    acp = _session(pane_id)
    if acp is None:
        return {}
    return {
        "display": "acp",
        "acp": {
            "state": acp.state,
            "queued": len(acp.queue),
            "pending_permissions": len(acp.permissions),
        },
    }


async def interrupt(pane: Any) -> dict[str, Any] | None:
    """cli_interrupt for an ACP pane: session/cancel over the protocol, no
    window needed. None for any other pane (the tool asks the window)."""
    from agent_team_backend import acp_ws

    acp = _session(pane.pane_id)
    if acp is None:
        return None
    status_before = acp.state
    try:
        issued = await acp_ws.get_service().cancel(acp.id)
    except KeyError:
        issued = False
    answer: dict[str, Any] = {
        "ok": True,
        "target": pane.qualified_name,
        "name": pane.name,
        "sent": issued,
        "status_before": status_before,
        "via": "acp",
    }
    if not issued:
        answer["advisories"] = [
            f'"{pane.name}" had no running turn (state {status_before}); nothing was cancelled'
        ]
    return answer


async def wait_idle(
    pane_id: str,
    timeout: float,
    done: Callable[[str], dict[str, Any]],
    timed_out: Callable[[float], dict[str, Any]],
    waiting_on: Callable[[], AbstractContextManager[None]],
) -> dict[str, Any] | None:
    """cli_wait_idle for an ACP pane, with the tool's own result shapes
    (``done`` / ``timed_out``) and its waiting_on registration. None for any
    other pane (the tool runs its own loop).

    Idle = the session is idle with nothing queued ("acp_state"); the agent
    exiting ends the wait too ("acp_exited"). A turn parked on a permission
    request times out as "awaiting", not "busy".
    """
    if _session(pane_id) is None:
        return None
    started = time.monotonic()
    with waiting_on():
        while True:
            acp = _session(pane_id)
            if acp is None:
                return done("acp_exited")
            if acp.state == "idle" and not acp.queue:
                return done("acp_state")
            waited = time.monotonic() - started
            if waited >= timeout:
                out = timed_out(waited)
                if acp.permissions:
                    out["reason"] = "awaiting"
                    out["ui_status"] = "awaiting"
                return out
            await asyncio.sleep(min(WAIT_POLL_S, max(0.0, timeout - waited)))
