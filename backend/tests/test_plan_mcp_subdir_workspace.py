"""Pipeline tools called from a pane whose workspace is a repository subfolder.

The renderer records a run, and answers ui.pipeline.*, under the workspace the
window has open — the pane's own path. The MCP pipeline tools used to rewrite
that path to the enclosing git root (the plan-root normalisation), so for a
pane at /repo/frontend:

- pipeline_status peeked /repo, found nothing and reported no run (M2);
- pipeline_next & co. addressed /repo, which is not the pane's workspace, so
  the request fell back to a broadcast no window answers (M2);
- stage_define / pipeline_define checked /repo for a running run, found none,
  and let a running pipeline's definition be edited mid-run (M1).
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend import app as backend_app
from agent_team_backend.mcp_server import server as plan_mcp
from agent_team_backend.mcp_server import wiring as plan_mcp_wiring
from agent_team_backend.projects import Project


def _ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


class _FakeProjectStore:
    """peek() keyed by the exact path, as ProjectStore keys a workspace."""

    def __init__(self, projects: dict[str, Project]) -> None:
        self._projects = projects

    def peek(self, workspace_path: str) -> Project | None:
        return self._projects.get(workspace_path)

    def project_dir(self, workspace_path: str) -> Path:
        return Path(workspace_path) / ".agent-team"

    def project_file(self, workspace_path: str) -> Path:
        return self.project_dir(workspace_path) / "project.json"

    def log_file(self, workspace_path: str, name: str) -> Path:
        return self.project_dir(workspace_path) / name


@pytest.fixture
def subdir_pane(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    agent_messaging._reset_for_test()
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    frontend = repo / "frontend"
    frontend.mkdir()
    workspace = str(frontend)
    run = Project(
        id="prj-1",
        name="frontend",
        workspace_path=workspace,
        created_at="2026-01-01T00:00:00Z",
        updated_at="2026-01-02T00:00:00Z",
        state="running",
        pipeline_id="default",
    )
    monkeypatch.setattr(backend_app, "project_store", _FakeProjectStore({workspace: run}), raising=False)
    agent_messaging.register("pa", "reviewer", workspace, agent_key="claude")
    yield workspace
    agent_messaging._reset_for_test()


@pytest.mark.asyncio
async def test_pipeline_status_finds_the_run_recorded_under_the_panes_own_workspace(subdir_pane: str) -> None:
    result = await plan_mcp.pipeline_status(_ctx())

    assert result["workspace_path"] == subdir_pane
    assert result["active"] is True


@pytest.mark.asyncio
async def test_pipeline_window_requests_address_the_panes_own_workspace(
    subdir_pane: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    addressed: list[str] = []

    async def fake_ui_request(workspace_path: str, op: str, **_kw: Any) -> dict[str, Any]:
        addressed.append(workspace_path)
        return {"ok": True}

    monkeypatch.setattr(plan_mcp, "_ui_request", fake_ui_request)

    await plan_mcp.pipeline_next(_ctx())
    await plan_mcp.pipeline_resume(_ctx())
    # Reset ends every pane in the window it runs in, so from a pane of that
    # window it is refused before anything is addressed (review #534 R2).
    assert (await plan_mcp.pipeline_reset(_ctx()))["error_code"] == "self-close"
    await plan_mcp.pipeline_restart(_ctx())
    await plan_mcp.pipeline_abort(_ctx())
    await plan_mcp.pipeline_gate(_ctx(), "pass")
    await plan_mcp.pipeline_restart_from(_ctx(), "n-01-0")

    assert addressed == [subdir_pane] * 6


@pytest.mark.asyncio
async def test_a_definition_edit_sees_the_run_in_the_panes_own_workspace(subdir_pane: str) -> None:
    caller = plan_mcp._resolve_caller(_ctx())

    workspace = await plan_mcp._definition_workspace(caller, "")

    assert workspace == subdir_pane
    assert plan_mcp._stage_edit_blocked(workspace, "default") is True
