"""Backend entry for the builtin ``navide.shipped-log`` plugin.

It owns the ``ship_log_*`` MCP tools and the per-workspace ledger behind them.
The ``/shipped`` chat command is the Host's (channels/shipped_cmds.py): a
plugin cannot register a chat command, so the Host answers it with this
plugin's report.

The host loads this file by path, so the import below must be absolute.
"""

from __future__ import annotations

from typing import Any

from agent_team_backend.plugins.builtin.navide_shipped_log import ship_log_tools


def activate(context: Any) -> None:
    context.register_mcp_tools(ship_log_tools.install)


def deactivate() -> None:
    # Tools stay on the core server for the life of the process (FastMCP has
    # no unregister); the Host hides them from tools/list while disabled.
    pass
