"""Settings → CLI Agents → "ACP (experimental)": what the switch changes.

Off (the default, and whenever the setting is absent) means exactly main's
behaviour: no CLI has an ACP launch (acp_vendors.ACP_LAUNCHES is empty), the
install wizard lists no ACP adapter, and the four MCP tools that answer for an
ACP pane carry main's descriptions, so tools/list is byte-identical to main.

On adds, and only adds: the verified launches (Claude Code through the
claude-acp adapter), the adapter as an optional install-wizard entry, and
acp_mcp.TOOL_NOTES appended to those four descriptions. Turning it off again
takes each of them back out, word for word.

Applied at backend startup from the stored setting and again by
``ui.settings.set`` whenever the key changes. An ACP pane already running when
the switch goes off keeps running until it is closed; no new one can start.
"""

from __future__ import annotations

import logging
from typing import Any

from . import acp_mcp, acp_vendors, onboarding_deps

log = logging.getLogger("agent_team_backend.acp_switch")

SETTING_KEY = acp_vendors.SETTING_KEY

# tool name -> its description as main has it, kept while the notes are on.
_MAIN_DESCRIPTIONS: dict[str, str] = {}


def _adapters() -> list[Any]:
    return [launch.adapter for launch in acp_vendors.VERIFIED_LAUNCHES.values() if launch.adapter is not None]


def _apply_deps(enabled: bool) -> None:
    for dep in _adapters():
        listed = dep in onboarding_deps.DEPS
        if enabled and not listed:
            onboarding_deps.DEPS.append(dep)
            onboarding_deps.DEPS_BY_ID[dep.id] = dep
        elif not enabled and listed:
            onboarding_deps.DEPS.remove(dep)
            onboarding_deps.DEPS_BY_ID.pop(dep.id, None)


def _apply_tool_notes(enabled: bool) -> None:
    from .mcp_server import server as mcp

    for name, note in acp_mcp.TOOL_NOTES.items():
        tool = mcp.server._tool_manager.get_tool(name)  # noqa: SLF001
        if tool is None:
            continue
        if enabled and name not in _MAIN_DESCRIPTIONS:
            _MAIN_DESCRIPTIONS[name] = tool.description
            tool.description = f"{tool.description}\n\n{note}"
        elif not enabled and name in _MAIN_DESCRIPTIONS:
            tool.description = _MAIN_DESCRIPTIONS.pop(name)


def apply(enabled: bool) -> None:
    """Make the backend match the switch. Idempotent; never raises."""
    try:
        acp_vendors.set_enabled(enabled)
        _apply_deps(enabled)
        _apply_tool_notes(enabled)
    except Exception as err:  # noqa: BLE001 — a settings write must not fail on this
        log.warning("ACP switch could not be applied (enabled=%s): %s", enabled, err, exc_info=True)
        return
    log.info("ACP (experimental) %s", "on" if enabled else "off")


def apply_settings(settings: Any) -> None:
    """apply() from a ui_settings document (absent or not true = off)."""
    apply(isinstance(settings, dict) and settings.get(SETTING_KEY) is True)
