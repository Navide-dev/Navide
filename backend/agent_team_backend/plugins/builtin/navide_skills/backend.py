"""Backend entry for managed-Skills spawn wiring."""

from __future__ import annotations

from typing import Any

from agent_team_backend.plugins.builtin.navide_skills import skills_tools, skills_wiring


def activate(context: Any) -> None:
    context.register_spawn_transformer(skills_wiring.wire_command)
    context.register_mcp_tools(skills_tools.install)
    skills_wiring.set_active(True)


def deactivate() -> None:
    skills_wiring.set_active(False)
