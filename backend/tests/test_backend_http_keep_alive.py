"""The backend keeps idle HTTP connections long enough for MCP calls to reuse them.

Every MCP tool call from a CLI pane is a POST to /plan-mcp on loopback. With
uvicorn's 5s default keep-alive, an agent that pauses between calls opens a new
connection each time, and each closed one holds a local port in TIME_WAIT for
about 30s; cli_usage failed with EADDRNOTAVAIL on connect during a busy release
gate (2026-10-28). __main__.py sets the keep-alive on uvicorn.Config.
"""

from __future__ import annotations

import ast
from pathlib import Path

MAIN = Path(__file__).resolve().parents[1] / "agent_team_backend" / "__main__.py"


def _uvicorn_config_keywords() -> dict[str, ast.expr]:
    tree = ast.parse(MAIN.read_text(encoding="utf-8"))
    calls = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "Config"
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "uvicorn"
    ]
    assert len(calls) == 1
    return {kw.arg: kw.value for kw in calls[0].keywords if kw.arg}


def test_keep_alive_outlasts_a_pause_between_mcp_calls() -> None:
    value = _uvicorn_config_keywords().get("timeout_keep_alive")
    assert isinstance(value, ast.Constant)
    assert value.value >= 60
