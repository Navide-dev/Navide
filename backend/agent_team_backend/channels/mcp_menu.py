"""What ``/mcp`` may say about MCP servers, read-only.

Two groups: the bound pane's CLI's own servers, read from that CLI's config file
(``native_mcp.scan``; Navide never connects to them, so they have no status or tools),
and Navide's own servers (``mcp_servers.json``), which Navide does connect to but which
are not wired into a pane's CLI.

A server record can carry secrets in its command, args, url, env and headers, and
masking them is a guess by name. So every row here is an allowlist: name, transport,
enabled, valid, the config file's short name, status, tool count and tool names. No
other field leaves this module, masked or not.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Callable, Iterable

# tools/list on one of Navide's servers; a slower one reads "timed out" rather than
# holding the chat (MCPClient.list_tools itself waits 10s).
TOOLS_TIMEOUT_S = 5.0


def _source(path: str) -> str:
    """``~/.claude.json`` for a file under home, else the bare file name: no user name."""
    p = Path(path)
    try:
        return "~/" + p.relative_to(Path.home()).as_posix()
    except ValueError:
        return p.name


def native_rows(entries: Iterable[Any], agent_key: str) -> list[dict[str, Any]]:
    """``agent_key``'s own servers (``native_mcp.NativeMcpServer``), allowlisted."""
    return [
        {"name": e.name, "transport": e.transport, "enabled": bool(e.enabled), "valid": bool(e.valid),
         "source": _source(e.path)}
        for e in entries if e.agent == agent_key
    ]


async def navide_rows(servers: list[dict[str, Any]], get_client: Callable[[str], Any],
                      timeout: float = TOOLS_TIMEOUT_S) -> list[dict[str, Any]]:
    """Navide's servers as ``{name, status, tool_count}``, all read at once; status is
    connected, error, disabled or timeout (tool_count None unless connected)."""

    async def one(server: dict[str, Any]) -> dict[str, Any]:
        name = str(server.get("name") or "")
        if not server.get("enabled", True):
            return {"name": name, "status": "disabled", "tool_count": None}
        client = get_client(name)
        if client is None or not client.ready:
            return {"name": name, "status": "error", "tool_count": None}
        try:
            tools = await asyncio.wait_for(client.list_tools(), timeout)
        except TimeoutError:
            return {"name": name, "status": "timeout", "tool_count": None}
        return {"name": name, "status": "connected", "tool_count": len(tools)}

    return list(await asyncio.gather(*(one(s) for s in servers if s.get("name"))))


async def navide_tools(get_client: Callable[[str], Any], name: str,
                       timeout: float = TOOLS_TIMEOUT_S) -> list[str] | None:
    """Tool names of Navide's server ``name`` (descriptions are third-party text and
    stay out); [] when it is not running, None when tools/list timed out."""
    client = get_client(name)
    if client is None or not client.ready:
        return []
    try:
        tools = await asyncio.wait_for(client.list_tools(), timeout)
    except TimeoutError:
        return None
    return [str(t.get("name") or "") for t in tools if t.get("name")]
