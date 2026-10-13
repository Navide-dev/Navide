"""ui.pane.reclaim: the MCP side of the status bar's "reclaim now".

The action lives in the renderer; what the backend owes it is to let it through
(it is not one of the human-only actions) and to tell an agent it exists, at
the two places an agent decides how to get rid of a finished pane.
"""

from __future__ import annotations

from agent_team_backend.mcp_server import server as plan_mcp


def test_reclaim_is_not_human_only() -> None:
    assert plan_mcp._human_only_refusal("ui.pane.reclaim", {"paneId": "p1"}) is None
    assert plan_mcp._human_only_refusal("ui.pane.reclaim", {"paneId": ["p1", "p2"]}) is None


def test_send_keys_stays_human_only() -> None:
    refusal = plan_mcp._human_only_refusal("ui.pane.sendKeys", {"paneId": "p1"})
    assert refusal is not None and refusal["error_code"] == "ui_human_only"


def test_ui_invoke_documents_reclaim() -> None:
    doc = plan_mcp.ui_invoke.__doc__ or ""
    assert "ui.pane.reclaim" in doc
    # The guards are the part a caller has to plan around.
    assert "refused" in doc and "focused" in doc and "unsent" in doc


def test_close_agent_points_at_reclaim() -> None:
    doc = plan_mcp.cli_close_agent.__doc__ or ""
    assert "cli_reclaim_agent" in doc
