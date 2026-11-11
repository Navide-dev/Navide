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


#: The ui_settings key of Settings → CLI Agents → "ACP (experimental)". Off
#: (absent or false) by default; acp_switch applies it.
SETTING_KEY = "acpExperimental"

#: The Claude Code ACP adapter release the handshake was checked against: the
#: ACP registry's "claude-acp" entry on 2026-11-10 (ACP protocol version 1,
#: schema v1.30.0). The install pins it; another version is logged, not refused.
CLAUDE_ACP_VERSION = "0.102.0"
CLAUDE_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp"

#: The adapter as an install-wizard dependency. Listed (onboarding) only while
#: the switch is on; acp_switch adds and removes it.
CLAUDE_ACP_ADAPTER = Dep(
    "claude-acp", "Claude Code ACP adapter",
    f"Runs Claude Code over the Agent Client Protocol (experimental; verified with {CLAUDE_ACP_VERSION})",
    "agent_cli", ["claude-agent-acp", "--version"], r"(\d+\.\d+\.\d+)",
    install_cmd=f"npm install -g {CLAUDE_ACP_PACKAGE}@{CLAUDE_ACP_VERSION}",
    requires_binaries=("npm",), optional=True,
    docs_url="https://agentclientprotocol.com/get-started/agents",
    npm_package=CLAUDE_ACP_PACKAGE,
)

#: The CLIs whose ACP mode has been verified, served only while the switch is
#: on. The terminal declaration of each (cli_vendors) is not touched.
VERIFIED_LAUNCHES: dict[str, AcpLaunch] = {
    "claude": AcpLaunch(
        argv=("claude-agent-acp",), adapter=CLAUDE_ACP_ADAPTER, verified_version=CLAUDE_ACP_VERSION,
    ),
}

# agent key -> how to run that CLI over ACP. Empty while the switch is off (the
# default), VERIFIED_LAUNCHES while it is on; every CLI not listed has no ACP pane.
ACP_LAUNCHES: dict[str, AcpLaunch] = {}


def acp_launch(agent_key: str) -> AcpLaunch | None:
    return ACP_LAUNCHES.get(agent_key)


def set_enabled(enabled: bool) -> None:
    """Serve the verified launches (on) or none (off). In place: callers hold
    the dict."""
    ACP_LAUNCHES.clear()
    if enabled:
        ACP_LAUNCHES.update(VERIFIED_LAUNCHES)


def enabled() -> bool:
    return bool(ACP_LAUNCHES)
