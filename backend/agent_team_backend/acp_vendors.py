"""Which CLIs Navide can run as an Agent Client Protocol agent (an ACP pane).

Kept apart from ``cli_vendors``: a CLI's terminal (TUI) declaration is not
touched by its ACP one, and a CLI absent here simply has no ACP pane (nothing
is borrowed from another CLI). Design: DESIGN-acp-mode.md (0.2.28 plan B).
"""

from __future__ import annotations

from dataclasses import dataclass

from .cli_vendors.base import Dep


@dataclass(frozen=True)
class AcpLaunch:
    """How to start one CLI as an ACP agent."""

    # The command line that speaks ACP on stdio, e.g. ("opencode", "acp").
    argv: tuple[str, ...]
    # A separate program that provides ACP for this CLI, when the CLI has no
    # ACP mode of its own (installed through the usual install flow, disclosed).
    adapter: Dep | None = None
    # The version the ACP handshake was last checked against, as --version prints it.
    verified_version: str = ""
    # Whether a session started in the terminal can be loaded in ACP and the
    # other way round. None = not established, so no "reopen in the other mode".
    session_shared_with_tui: bool | None = None


# agent key -> how to run that CLI over ACP. Empty until a CLI's ACP mode is
# verified (P5); every CLI not listed has no ACP pane.
ACP_LAUNCHES: dict[str, AcpLaunch] = {}


def acp_launch(agent_key: str) -> AcpLaunch | None:
    return ACP_LAUNCHES.get(agent_key)
