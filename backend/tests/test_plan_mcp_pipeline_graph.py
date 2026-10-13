"""MCP pipeline_graph / pipeline_gate / pipeline_restart_from, role properties
and per-node state in pipeline_status. Real StagesStore on a temp dir."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.mcp_server import auth as plan_mcp_auth
from agent_team_backend.mcp_server import server as plan_mcp
from agent_team_backend.roles_store import RolesStore
from agent_team_backend.stages_store import PIPELINES_FILE, StagesStore


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


def _ctx() -> Any:
    params = {"client": "host", "t": plan_mcp_auth.internal_token()}
    return SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))


@pytest.fixture
def wired(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    stages = StagesStore(tmp_path / PIPELINES_FILE)
    roles = RolesStore(tmp_path / "roles.json")
    project: dict[str, Any] = {"value": None}
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kw: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "stages_store", stages, raising=False)
    monkeypatch.setattr(app, "roles_store", roles, raising=False)
    monkeypatch.setattr(app, "project_store", SimpleNamespace(peek=lambda ws: project["value"]), raising=False)
    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    return SimpleNamespace(stages=stages, roles=roles, project=project, events=events)


GATE = [{"op": "add_node", "node": {"id": "gate", "kind": "gate", "position": {"x": 0, "y": 0}},
         "after": ["n-01-0"], "before": ["n-02-0"]}]


@pytest.mark.asyncio
async def test_get_is_read_only_and_derived_for_a_legacy_pipeline(wired: SimpleNamespace) -> None:
    before = wired.stages.export_document()
    out = await plan_mcp.pipeline_graph(_ctx(), "get", pipeline_id="default")
    assert out["ok"] is True and out["derived"] is True
    assert wired.stages.export_document() == before
    assert wired.events == []


@pytest.mark.asyncio
async def test_apply_writes_and_announces_like_the_ws_handler(wired: SimpleNamespace) -> None:
    out = await plan_mcp.pipeline_graph(_ctx(), "apply", pipeline_id="default", ops=GATE)
    assert out["ok"] is True
    assert any(n["id"] == "gate" for n in out["graph"]["nodes"])
    assert [e["type"] for e in wired.events] == ["pipeline.graph_changed", "stages.changed", "pipelines.changed"]


@pytest.mark.asyncio
async def test_invalid_ops_report_errors_and_write_nothing(wired: SimpleNamespace) -> None:
    before = wired.stages.export_document()
    out = await plan_mcp.pipeline_graph(_ctx(), "apply", pipeline_id="default", ops=[
        {"op": "add_edge", "edge": {"id": "back", "from": "n-02-0", "to": "n-01-0"}},
    ])
    assert out["ok"] is False and out["error_code"] == "invalid"
    assert any("cycle" in e for e in out["errors"])
    assert wired.stages.export_document() == before
    bad = await plan_mcp.pipeline_graph(_ctx(), "nope")
    assert bad["error_code"] == "bad_op"
    missing = await plan_mcp.pipeline_graph(_ctx(), "apply")
    assert missing["error_code"] == "missing_argument"


@pytest.mark.asyncio
async def test_graph_write_is_refused_while_the_pipeline_runs(wired: SimpleNamespace) -> None:
    wired.project["value"] = SimpleNamespace(state="running", pipeline_id="default", workspace_path="/ws")
    out = await plan_mcp.pipeline_graph(_ctx(), "apply", pipeline_id="default", ops=GATE, workspace_path="/ws")
    assert out["error_code"] == "pipeline_running"
    assert (await plan_mcp.pipeline_graph(_ctx(), "get", pipeline_id="default"))["derived"] is True


@pytest.mark.asyncio
async def test_stage_define_on_a_nonlinear_graph_is_graph_nonlinear(wired: SimpleNamespace) -> None:
    await plan_mcp.pipeline_graph(_ctx(), "apply", pipeline_id="default", ops=GATE)
    ids = [s["id"] for s in wired.stages.list("default")]
    out = await plan_mcp.stage_define(_ctx(), "reorder", pipeline_id="default", ids=list(reversed(ids)))
    assert out["error_code"] == "graph_nonlinear"


@pytest.mark.asyncio
async def test_role_define_properties_round_trip_and_survive_rename(wired: SimpleNamespace) -> None:
    props = [{"name": "mode", "type": "options", "options": [{"value": "a"}, {"value": "b"}]}]
    out = await plan_mcp.role_define(_ctx(), "upsert", key="qa", label="QA", system_prompt="p", properties=props)
    assert out["ok"] is True and out["role"]["properties"] == props
    renamed = await plan_mcp.role_define(_ctx(), "rename", key="qa", new_key="tester")
    assert renamed["role"]["properties"] == props
    bad = await plan_mcp.role_define(_ctx(), "upsert", key="x", label="X", system_prompt="p",
                                     properties=[{"name": "a", "type": "weird"}])
    assert bad["ok"] is False and bad["error_code"] == "invalid"


def test_pipeline_status_carries_node_states_and_the_gate(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from agent_team_backend.projects import ProjectStore

    ws = str(tmp_path)
    store = ProjectStore()
    store.start_pipeline(ws, task_description="t", total_stages=1, stage_blueprint=[{"stage_id": "01", "slots": []}])
    store.record_node_states(ws, nodes={"n-01-0": {"status": "running", "summary": "long tail", "attempts": 1}},
                             gate={"gateId": "gate", "label": "OK?"})
    monkeypatch.setattr(app, "project_store", store, raising=False)
    status = plan_mcp._pipeline_status_of(ws)
    assert status["nodes"] == {"n-01-0": {"status": "running", "attempts": 1}}
    assert status["gate"] == {"gateId": "gate", "label": "OK?"}


@pytest.fixture
def ui_calls(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    async def fake_ui_request(workspace_path: str, op: str, *, caller: Any = None, action: str | None = None,
                              args: dict[str, Any] | None = None, is_global: bool = False) -> dict[str, Any]:
        calls.append({"workspace_path": workspace_path, "action": action, "args": args})
        return {"ok": True, "result": {}, "error": None}

    monkeypatch.setattr(plan_mcp, "_ui_request", fake_ui_request)
    return calls


@pytest.mark.asyncio
async def test_gate_and_restart_from_go_to_the_window(ui_calls: list[dict[str, Any]]) -> None:
    await plan_mcp.pipeline_gate(_ctx(), "pass", workspace_path="/ws")
    await plan_mcp.pipeline_gate(_ctx(), "reject", node_id="gate", comment="fix tests", workspace_path="/ws")
    await plan_mcp.pipeline_restart_from(_ctx(), "n-02-0", workspace_path="/ws")
    assert ui_calls == [
        {"workspace_path": "/ws", "action": "ui.pipeline.gate_pass", "args": {}},
        {"workspace_path": "/ws", "action": "ui.pipeline.gate_reject", "args": {"nodeId": "gate", "comment": "fix tests"}},
        {"workspace_path": "/ws", "action": "ui.pipeline.restart_from", "args": {"nodeId": "n-02-0"}},
    ]
    assert (await plan_mcp.pipeline_gate(_ctx(), "approve"))["error_code"] == "bad_op"
    assert (await plan_mcp.pipeline_restart_from(_ctx(), ""))["error_code"] == "missing_argument"
    for action in ("ui.pipeline.gate_pass", "ui.pipeline.gate_reject", "ui.pipeline.restart_from"):
        assert action in plan_mcp._UI_INVOKE_SLOW_ACTIONS


@pytest.mark.asyncio
@pytest.mark.parametrize("op", ["get", "apply", "set"])
async def test_unknown_pipeline_is_a_clear_not_found(wired: SimpleNamespace, op: str) -> None:
    out = await plan_mcp.pipeline_graph(
        _ctx(), op, pipeline_id="no-such-pipeline", ops=GATE, graph={"version": 1, "nodes": [], "edges": []}
    )
    assert out["ok"] is False and out["error_code"] == "not_found", out
    assert out["error"] == "pipeline not found: no-such-pipeline"
