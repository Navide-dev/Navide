"""evolve_retro: the three lines a dispatched pane writes before Navide
reclaims it (self-evolution S5b). Registered on the core server from its own
module, after the window tools, so it is the last core tool."""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import Context

from .server import CallerUnknown, _resolve_caller, server


@server.tool()
async def evolve_retro(token: str, lines: list[str], ctx: Context) -> dict[str, Any]:
    """Write a short retrospective before this pane is reclaimed. Only when
    Navide asked you to: its message gives the token, and a call without that
    exact token, or from another pane, is refused.

    `lines` is three lines at most (more are dropped, each is cut to 200
    characters and masked): what you did, where you got stuck, which step you
    repeated by hand. Navide keeps them in this workspace's own database for
    its next self-evolution run; the text never leaves this machine. This tool
    changes no setting and starts nothing. Returns {ok, lines}.
    """
    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    if caller.kind != "pane":
        return {"ok": False, "error": "evolve_retro must come from the pane Navide asked"}
    from agent_team_backend import evolve_service

    return await evolve_service.get_service().retro_submit(caller.pane_id, token, lines)
