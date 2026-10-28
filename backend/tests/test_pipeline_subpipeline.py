"""A parent run suspends at a subpipeline node while its child runs here.

The workspace still has one run going at a time: the parent's run fields sit
on Project.run_stack, the child runs as an ordinary run, and when it ends the
parent comes back with the node done (or failed) and resumes. These drive the
real ProjectStore, TokensStore, Guard run taint and the pipeline.* handlers.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from agent_team_backend import app as app_module
from agent_team_backend import ws_handlers
from agent_team_backend.guard import taint as guard_taint
from agent_team_backend.mcp_server import server as mcp
from agent_team_backend.projects import ParentRunSuspended, ProjectStore
from agent_team_backend.tokens_store import TokensStore


class _Session:
    def __init__(self) -> None:
        self.sent: list = []
        self.dead = False

    async def send_json(self, message: dict) -> None:
        self.sent.append(message)


def _blueprint(prefix: str, n: int) -> list[dict]:
    return [{"stage_id": f"{prefix}{i}", "title": f"{prefix}{i}", "slots": [{"label": "a", "agent": "claude"}]} for i in range(n)]


@pytest.fixture
def ws(tmp_path: Path) -> str:
    path = tmp_path / "ws"
    path.mkdir()
    return str(path)


@pytest.fixture
def wired(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> SimpleNamespace:
    store = ProjectStore()
    tokens = TokensStore(global_path=tmp_path / "global-tokens.json", workspace_base_dir=tmp_path / "workspaces")

    async def fake_broadcast(event: dict) -> None:
        pass

    monkeypatch.setattr(app_module, "project_store", store, raising=False)
    monkeypatch.setattr(app_module, "tokens_store", tokens, raising=False)
    monkeypatch.setattr(app_module, "broadcast", fake_broadcast, raising=False)
    monkeypatch.setattr(app_module, "_SESSIONS", [], raising=False)
    monkeypatch.setattr(app_module, "main_window_sessions", lambda: [], raising=False)
    monkeypatch.setattr(
        app_module, "recent_workspaces_store",
        SimpleNamespace(touch=lambda *a, **k: None, list=lambda: [], set_last_state=lambda *a, **k: None),
        raising=False,
    )
    monkeypatch.setattr(app_module, "stages_store", SimpleNamespace(get_active_pipeline_id=lambda: "parent"), raising=False)
    monkeypatch.setattr(app_module, "_register_workspace_and_backfill", lambda *a, **k: None, raising=False)
    monkeypatch.setattr(app_module, "_project_payload", lambda p: {"project": p.to_dict()}, raising=False)
    guard_taint._reset_pipeline_runs_for_test()
    yield SimpleNamespace(store=store, tokens=tokens)
    guard_taint._reset_pipeline_runs_for_test()


async def _call(handler, payload: dict) -> dict:
    session = _Session()
    await handler(session, "1", "t", payload)
    return session.sent[-1]


async def _start(ws: str, pipeline_id: str, prefix: str, n: int, child_of: str = "") -> dict:
    return await _call(ws_handlers.pipeline_start, {
        "workspace_path": ws, "task_description": f"task of {pipeline_id}", "total_stages": n,
        "stage_blueprint": _blueprint(prefix, n), "pipeline_id": pipeline_id, **({"child_of": child_of} if child_of else {}),
    })


async def _suspend(ws: str, node_id: str = "call", next_index: int = 1, name: str = "Parent", child: str = "child") -> dict:
    return await _call(ws_handlers.pipeline_suspend, {
        "workspace_path": ws, "node_id": node_id, "next_index": next_index,
        "pipeline_name": name, "child_pipeline_id": child,
    })


async def test_a_child_runs_while_its_parent_waits_then_the_parent_comes_back(wired, ws) -> None:
    assert (await _start(ws, "parent", "p", 3))["ok"] is True
    await _call(ws_handlers.pipeline_stage_spawn, {"workspace_path": ws, "stage_index": 0, "pane_id": "pane-p0"})
    await _call(ws_handlers.pipeline_slot_spawn, {
        "workspace_path": ws, "stage_index": 0, "slot_label": "a", "pane_id": "pane-p0", "agent": "claude", "role": "",
    })
    parent_log = wired.store.peek(ws).log_file_name

    suspended = await _suspend(ws)
    assert suspended["ok"] is True
    project = wired.store.peek(ws)
    assert project.state == "suspended" and len(project.run_stack) == 1
    frame = project.run_stack[0]
    assert frame["run"]["stages"][0]["status"] == "completed"

    # Only the child it waits for may start here.
    refused = await _start(ws, "other", "o", 1)
    assert refused["ok"] is False
    assert refused["error"]["code"] == "PIPELINE_SUSPENDED"
    assert "Parent" in refused["error"]["message"] and "resume or reset" in refused["error"]["message"]
    with pytest.raises(ParentRunSuspended):
        wired.store.start_pipeline(ws, task_description="x", total_stages=1, stage_blueprint=_blueprint("x", 1), child_of="nope")

    assert (await _start(ws, "child", "c", 2, child_of=frame["id"]))["ok"] is True
    child = wired.store.peek(ws)
    assert child.state == "running" and child.pipeline_id == "child"
    assert [s.stage_id for s in child.stages] == ["c0", "c1"]
    assert all(p.origin != "pipeline" for p in child.panes)
    # A second child cannot start while the first one runs.
    assert (await _start(ws, "child", "c", 2, child_of=frame["id"]))["ok"] is False

    await _call(ws_handlers.pipeline_complete, {"workspace_path": ws})
    done = await _call(ws_handlers.pipeline_child_finished, {
        "workspace_path": ws, "outcome": "completed", "summary": "child summary", "output": {"ok": True},
    })
    assert done["ok"] is True and done["payload"]["popped"] is True and done["payload"]["next_index"] == 1
    parent = wired.store.peek(ws)
    assert parent.run_stack == []
    assert parent.pipeline_id == "parent" and parent.task_description == "task of parent"
    assert parent.log_file_name == parent_log
    assert [s.stage_id for s in parent.stages] == ["p0", "p1", "p2"]
    assert [p.pane_id for p in parent.panes if p.origin == "pipeline"] == ["pane-p0"]
    assert parent.node_states["call"]["status"] == "done"
    assert parent.node_states["call"]["output"] == {"ok": True}
    assert parent.node_outputs["call"]["summary"] == "child summary"
    # The parent resumes where it left off: the stage after the call.
    resumed = await _call(ws_handlers.pipeline_resume, {"workspace_path": ws})
    assert resumed["payload"]["resume_index"] == 1
    assert wired.store.peek(ws).state == "running"


async def test_a_failed_child_fails_the_node(wired, ws) -> None:
    await _start(ws, "parent", "p", 2)
    frame_id = (await _suspend(ws))["payload"]["frame_id"]
    await _start(ws, "child", "c", 1, child_of=frame_id)
    await _call(ws_handlers.pipeline_abort, {"workspace_path": ws, "reason": "failed"})
    done = await _call(ws_handlers.pipeline_child_finished, {"workspace_path": ws, "outcome": "failed", "error": "kickoff never landed"})
    assert done["payload"]["popped"] is True
    state = wired.store.peek(ws).node_states["call"]
    assert state["status"] == "failed" and state["error"] == "kickoff never landed"
    assert "call" not in wired.store.peek(ws).node_outputs


async def test_without_a_parent_nothing_pops(wired, ws) -> None:
    await _start(ws, "parent", "p", 1)
    done = await _call(ws_handlers.pipeline_child_finished, {"workspace_path": ws, "outcome": "completed"})
    assert done["payload"] == {"popped": False}
    refused = await _start(ws, "parent", "p", 1, child_of="call-1")
    assert refused["ok"] is False and refused["error"]["code"] == "BAD_REQUEST"


async def test_nesting_stops_at_three_runs_deep(wired, ws) -> None:
    await _start(ws, "a", "a", 2)
    f1 = (await _suspend(ws, name="A", child="b"))["payload"]["frame_id"]
    await _start(ws, "b", "b", 2, child_of=f1)
    f2 = (await _suspend(ws, name="B", child="c"))["payload"]["frame_id"]
    await _start(ws, "c", "c", 2, child_of=f2)
    too_deep = await _suspend(ws, name="C", child="d")
    assert too_deep["ok"] is False and "at most 3 deep" in too_deep["error"]["message"]
    status = mcp._pipeline_status_of(ws)
    assert status["depth"] == 3
    assert [f["pipeline_name"] for f in status["run_stack"]] == ["A", "B"]
    assert status["parent"]["pipeline_id"] == "b"


async def test_reset_ends_every_suspended_parent(wired, ws) -> None:
    await _start(ws, "parent", "p", 2)
    f = (await _suspend(ws))["payload"]["frame_id"]
    await _start(ws, "child", "c", 1, child_of=f)
    await _call(ws_handlers.pipeline_reset, {"workspace_path": ws})
    project = wired.store.peek(ws)
    assert project.run_stack == [] and project.state == "idle"
    assert (await _start(ws, "other", "o", 1))["ok"] is True


async def test_stopped_between_suspend_and_child_start_resumes_the_parent(wired, ws) -> None:
    await _start(ws, "parent", "p", 3)
    await _suspend(ws, next_index=2)
    project, index = wired.store.resume_pipeline(ws)
    assert project.run_stack == [] and project.pipeline_id == "parent"
    assert index == 2


async def test_a_child_inherits_its_parents_taint_and_the_parent_gets_it_back(wired, ws) -> None:
    guard_taint.arm_pipeline_run(ws, "started by worker")
    await _start(ws, "parent", "p", 2)
    assert guard_taint.pipeline_run_taint(ws) == "started by worker"
    f = (await _suspend(ws))["payload"]["frame_id"]
    await _start(ws, "child", "c", 1, child_of=f)
    assert guard_taint.pipeline_run_taint(ws) == "started by worker"
    await _call(ws_handlers.pipeline_complete, {"workspace_path": ws})
    await _call(ws_handlers.pipeline_child_finished, {"workspace_path": ws, "outcome": "completed"})
    assert guard_taint.pipeline_run_taint(ws) == "started by worker"


async def test_a_tainted_child_keeps_its_taint_on_the_parent(wired, ws) -> None:
    await _start(ws, "parent", "p", 2)
    f = (await _suspend(ws))["payload"]["frame_id"]
    await _start(ws, "child", "c", 1, child_of=f)
    # The child run picked up a taint of its own (its parent's was clean).
    guard_taint.restore_pipeline_run_taint(ws, "child read external content")
    await _call(ws_handlers.pipeline_complete, {"workspace_path": ws})
    await _call(ws_handlers.pipeline_child_finished, {"workspace_path": ws, "outcome": "completed"})
    assert guard_taint.pipeline_run_taint(ws) == "child read external content"


async def test_a_clean_parent_has_a_clean_child(wired, ws) -> None:
    await _start(ws, "parent", "p", 2)
    f = (await _suspend(ws))["payload"]["frame_id"]
    await _start(ws, "child", "c", 1, child_of=f)
    assert guard_taint.pipeline_run_taint(ws) == ""


async def test_token_runs_link_the_child_to_its_parent(wired, ws) -> None:
    await _start(ws, "parent", "p", 2)
    parent_run = wired.tokens.snapshot(ws)["workspace"]["current_run"]["run_id"]
    f = (await _suspend(ws))["payload"]["frame_id"]
    assert wired.tokens.snapshot(ws)["workspace"]["current_run"] is None
    await _start(ws, "child", "c", 1, child_of=f)
    child_run = wired.tokens.snapshot(ws)["workspace"]["current_run"]
    assert child_run["parent_run_id"] == parent_run
    await _call(ws_handlers.pipeline_complete, {"workspace_path": ws})
    await _call(ws_handlers.pipeline_child_finished, {"workspace_path": ws, "outcome": "completed"})
    snap = wired.tokens.snapshot(ws)["workspace"]
    assert snap["current_run"]["run_id"] == parent_run
    assert snap["current_run"]["child_run_ids"] == [child_run["run_id"]]
    assert any(r["run_id"] == child_run["run_id"] for r in snap["runs"])
    assert "suspended_runs" not in snap


async def test_a_run_without_calls_reports_no_stack(wired, ws) -> None:
    await _start(ws, "parent", "p", 1)
    status = mcp._pipeline_status_of(ws)
    assert "run_stack" not in status and "parent" not in status and "depth" not in status
    assert (await _call(ws_handlers.pipeline_stack, {"workspace_path": ws}))["payload"] == {"frames": [], "state": "running"}
