"""Backend guards on a pipeline run (PR-E, plan pipeline_0dc134 note n11).

E1: a start or resume while a window still drives the workspace's run is
refused with error_code "pipeline_already_running" (WS: the upper-case twin,
answered by the pipeline handlers' store error mapping),
instead of overwriting the run or re-keying its running stage's pane. A run
nobody drives any more (the crash case, see pipeline_liveness) still starts
over and resumes. Driven through the real ProjectStore, the real pipeline.*
handlers, MCP's start path and the scheduler's LiveBridge.
"""

from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent_team_backend import app as app_module
from agent_team_backend import pipeline_liveness, scheduler, ws_handlers
from agent_team_backend.mcp_server import server as mcp
from agent_team_backend.projects import PipelineAlreadyRunning, ProjectStore

BLUEPRINT = [
    {"stage_id": "s0", "title": "S0", "slots": [{"label": "a", "agent": "claude"}]},
    {"stage_id": "s1", "title": "S1", "slots": [{"label": "b", "agent": "codex"}]},
]


class _Session:
    def __init__(self, held: tuple[str, ...] = (), window_id: str = "win-1") -> None:
        self.sent: list = []
        self.dead = False
        self.window_id = window_id
        self.held_workspaces = held

    async def send_json(self, message: dict) -> None:
        self.sent.append(message)


@pytest.fixture
def ws(tmp_path: Path) -> str:
    path = tmp_path / "ws"
    path.mkdir()
    return str(path)


@pytest.fixture
def wired(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    store = ProjectStore()
    sessions: list[_Session] = []

    async def fake_broadcast(event: dict) -> None:
        pass

    monkeypatch.setattr(app_module, "project_store", store, raising=False)
    monkeypatch.setattr(app_module, "broadcast", fake_broadcast, raising=False)
    monkeypatch.setattr(app_module, "_SESSIONS", sessions, raising=False)
    monkeypatch.setattr(app_module, "main_window_sessions", lambda: [s for s in sessions if not s.dead], raising=False)
    monkeypatch.setattr(
        app_module,
        "tokens_store",
        SimpleNamespace(start_run=lambda *a, **k: None, end_run=lambda *a, **k: None, snapshot=lambda *a, **k: {}),
        raising=False,
    )
    monkeypatch.setattr(
        app_module, "stages_store", SimpleNamespace(get_active_pipeline_id=lambda: "pl-1", imported_from=lambda pid: None), raising=False
    )
    monkeypatch.setattr(app_module, "_register_workspace_and_backfill", lambda *a, **k: None, raising=False)
    monkeypatch.setattr(
        app_module, "_project_payload", lambda p: {"project": {"state": p.state}, "state": p.state}, raising=False
    )
    monkeypatch.setattr(pipeline_liveness, "_started_at", time.monotonic())
    monkeypatch.setattr(pipeline_liveness, "_claims_seen", False)
    return SimpleNamespace(store=store, sessions=sessions, monkeypatch=monkeypatch)


def _start(store: ProjectStore, ws: str, task: str = "first") -> None:
    store.start_pipeline(ws, task_description=task, total_stages=2, stage_blueprint=BLUEPRINT, pipeline_id="pl-1")


def test_a_second_start_is_refused_and_leaves_the_running_run_alone(wired, ws) -> None:
    _start(wired.store, ws)
    wired.store.record_stage_spawn(ws, stage_index=0, pane_id="p0", agent="claude", role="")

    with pytest.raises(PipelineAlreadyRunning) as refused:
        _start(wired.store, ws, task="second")

    assert refused.value.error_code == "pipeline_already_running"
    run = wired.store.peek(ws)
    assert run.task_description == "first"
    assert run.stages[0].pane_id == "p0" and run.stages[0].status == "running"


def test_resume_is_refused_while_the_run_is_live_and_keeps_its_pane(wired, ws) -> None:
    _start(wired.store, ws)
    wired.store.record_stage_spawn(ws, stage_index=0, pane_id="p0", agent="claude", role="")

    with pytest.raises(PipelineAlreadyRunning):
        wired.store.resume_pipeline(ws)

    assert wired.store.peek(ws).stages[0].pane_id == "p0"


def test_a_stopped_run_still_starts_over_and_resumes(wired, ws) -> None:
    _start(wired.store, ws)
    wired.store.abort_pipeline(ws)
    _, next_index = wired.store.resume_pipeline(ws)
    assert next_index == 0
    wired.store.abort_pipeline(ws)
    _start(wired.store, ws, task="again")
    assert wired.store.peek(ws).task_description == "again"


async def test_a_run_nobody_drives_any_more_starts_over(wired, ws) -> None:
    """The crash case: a stored running run no window claims is not live."""
    _start(wired.store, ws)
    window = _Session(held=(ws,))
    wired.sessions.append(window)
    await ws_handlers.pipeline_claim(window, "1", "pipeline.claim", {"workspaces": []})

    _start(wired.store, ws, task="after the crash")

    assert wired.store.peek(ws).task_description == "after the crash"


async def test_mcp_start_answers_the_code_without_asking_the_window(wired, ws, monkeypatch) -> None:
    _start(wired.store, ws)
    asked: list = []

    async def ui_request(*args, **kwargs):
        asked.append(args)
        return {"ok": True}

    monkeypatch.setattr(mcp, "_ui_request", ui_request)

    answer = await mcp._start_pipeline_run(mcp._Caller(kind="host"), ws, "t", "pl-1")

    assert answer["ok"] is False
    assert answer["error_code"] == "pipeline_already_running"
    assert asked == []


async def test_scheduled_start_records_the_code_as_its_reason(wired, ws, monkeypatch) -> None:
    _start(wired.store, ws)
    wired.monkeypatch.setattr(
        app_module, "stages_store",
        SimpleNamespace(list_pipelines=lambda: [{"id": "pl-1", "name": "One"}]), raising=False,
    )

    async def window_holds(workspace, timeout):
        return True

    monkeypatch.setattr(mcp, "_probe_window", window_holds)

    outcome = await scheduler.LiveBridge().deliver_pipeline(
        {"kind": "pipeline_start", "workspace": ws, "pipeline_id": "pl-1", "task": "t"}
    )

    assert outcome["status"] == "error"
    assert outcome["reason"] == "pipeline_already_running"


async def test_ws_start_without_total_stages_counts_the_blueprint(wired, ws) -> None:
    """p3-cleanup: the handler's default was 4 and the record's 5; both are
    now the blueprint's own length (0 for a workspace that never ran)."""
    window = _Session(held=(ws,))
    await ws_handlers.pipeline_start(
        window, "1", "pipeline.start", {"workspace_path": ws, "task_description": "t", "stage_blueprint": BLUEPRINT}
    )
    assert wired.store.peek(ws).total_stages == len(BLUEPRINT)


def test_a_workspace_that_never_ran_reports_no_stages(wired, ws) -> None:
    assert wired.store.load_or_create(ws).total_stages == 0


# ── E2: resetting a custom pipeline does not silently drop its drawn graph ──


def _custom_with_stages(tmp_path: Path):
    from agent_team_backend.stages_store import PIPELINES_FILE, StagesStore

    store = StagesStore(tmp_path / PIPELINES_FILE)
    pid = store.create_pipeline("Mine")["id"]
    for sid in ("a", "b"):
        store.upsert({"id": sid, "title": sid.upper(), "slots": [{"label": sid, "agent_key": "claude", "role_key": "", "kickoff_body": ""}]}, pid)
    return store, pid


def _gate_between_a_and_b() -> list[dict]:
    return [{"op": "add_node", "node": {"id": "g", "kind": "gate", "position": {"x": 0, "y": 0}},
             "after": ["n-a-0"], "before": ["n-b-0"]}]


def test_reset_refuses_to_drop_a_drawn_graph_without_consent(tmp_path) -> None:
    from agent_team_backend.stages_store import GraphNonLinearError

    store, pid = _custom_with_stages(tmp_path)
    store.apply_graph_ops(pid, _gate_between_a_and_b())

    with pytest.raises(GraphNonLinearError):
        store.reset(pid)

    kept = store.get_graph(pid)
    assert kept["derived"] is False
    assert any(n["id"] == "g" for n in kept["graph"]["nodes"])
    assert [s["id"] for s in kept["stages"]] != []


def test_reset_with_consent_clears_a_drawn_graph(tmp_path) -> None:
    store, pid = _custom_with_stages(tmp_path)
    store.apply_graph_ops(pid, _gate_between_a_and_b())

    assert store.reset(pid, discard_graph=True) == []
    assert store.get_graph(pid)["derived"] is True


def test_reset_of_a_linear_custom_pipeline_is_unchanged(tmp_path) -> None:
    """A linear graph is the stage list drawn: nothing beyond the stages the
    reset already says it removes is lost, so no consent is asked."""
    store, pid = _custom_with_stages(tmp_path)
    store.apply_graph_ops(pid, [{"op": "move_node", "id": "n-a-0", "position": {"x": 5, "y": 5}}])

    assert store.reset(pid) == []


def test_reset_of_a_builtin_still_restores_its_seed(tmp_path) -> None:
    from agent_team_backend.stages_store import PIPELINES_FILE, StagesStore, default_stages

    store = StagesStore(tmp_path / PIPELINES_FILE)
    first = store.list("default")[0]["id"]
    store.delete(first, "default")
    assert len(store.reset("default")) == len(default_stages())


# ── p3-cleanup: node states only for nodes the run's pipeline has ──────────


def test_record_node_states_drops_ids_outside_the_known_set(wired, ws) -> None:
    _start(wired.store, ws)
    wired.store.record_node_states(
        ws, nodes={"n-s0-0": {"status": "running"}, "ghost": {"status": "done"}},
        outputs={"ghost": {"summary": "x"}, "n-s0-0": {"summary": "ok"}},
        known_ids={"trigger", "n-s0-0", "n-s1-0"},
    )
    stored = wired.store.peek(ws)
    assert stored.node_states == {"n-s0-0": {"status": "running"}}
    assert stored.node_outputs == {"n-s0-0": {"summary": "ok"}}


def test_record_node_states_without_a_known_set_keeps_every_id(wired, ws) -> None:
    _start(wired.store, ws)
    wired.store.record_node_states(ws, nodes={"anything": {"status": "running"}})
    assert wired.store.peek(ws).node_states == {"anything": {"status": "running"}}


def test_known_node_ids_cover_the_stored_graph_and_the_stage_derived_one(tmp_path) -> None:
    from agent_team_backend.stages_store import PIPELINES_FILE, StagesStore

    store = StagesStore(tmp_path / PIPELINES_FILE)
    store.apply_graph_ops("default", [{"op": "add_node", "node": {"id": "g", "kind": "gate", "position": {"x": 0, "y": 0}},
                                       "after": ["n-01-0"], "before": ["n-02-0"]}])
    ids = store.node_ids("default")
    assert {"trigger", "g", "n-01-0"} <= ids
    assert "ghost" not in ids


async def test_ws_node_states_reports_the_ids_it_dropped(wired, ws, monkeypatch) -> None:
    _start(wired.store, ws)
    wired.monkeypatch.setattr(
        app_module, "stages_store",
        SimpleNamespace(node_ids=lambda pid: {"trigger", "n-s0-0"}), raising=False,
    )
    window = _Session(held=(ws,))
    await ws_handlers.pipeline_node_states(
        window, "1", "pipeline.node_states",
        {"workspace_path": ws, "nodes": {"n-s0-0": {"status": "done"}, "ghost": {"status": "done"}}},
    )
    assert window.sent[-1]["ok"] is True
    assert window.sent[-1]["payload"] == {"ok": True, "dropped": ["ghost"]}
    assert set(wired.store.peek(ws).node_states) == {"n-s0-0"}


async def test_ws_start_while_running_answers_pipeline_already_running(wired, ws) -> None:
    """End to end through the real handler and the pipeline handlers' store
    error mapping: the exception's error_code in capitals."""
    from agent_team_backend import app as app_mod

    window = _Session(held=(ws,))
    wired.sessions.append(window)
    payload = {"workspace_path": ws, "task_description": "t", "total_stages": 2, "stage_blueprint": BLUEPRINT}
    await app_mod.handle_message(window, {"id": "1", "type": "pipeline.start", "payload": payload})
    assert window.sent[-1]["ok"] is True

    await app_mod.handle_message(window, {"id": "2", "type": "pipeline.start", "payload": {**payload, "task_description": "again"}})

    assert window.sent[-1]["ok"] is False
    assert window.sent[-1]["error"]["code"] == "PIPELINE_ALREADY_RUNNING"
    assert wired.store.peek(ws).task_description == "t"


# ── A window's coded refusal reaches the MCP answer as error_code ──────────


async def test_a_window_refusal_with_a_code_answers_error_code_and_params(monkeypatch) -> None:
    resolved: list[dict] = []
    monkeypatch.setattr(mcp, "resolve_ui_invoke", lambda rid, result: resolved.append(result) or True)
    window = _Session()

    await ws_handlers.ui_invoke_result(window, "1", "ui.invoke.result", {
        "request_id": "r1", "ok": False, "result": None,
        "error": "ui.pipeline.next: stage 3 of 3 is the last one",
        "code": "last-stage", "params": {"stage": 3, "stages": 3},
    })
    await ws_handlers.ui_invoke_result(window, "2", "ui.invoke.result", {
        "request_id": "r2", "ok": False, "result": None, "error": "plain",
    })

    assert resolved[0] == {
        "ok": False, "result": None, "error": "ui.pipeline.next: stage 3 of 3 is the last one",
        "error_code": "last-stage", "params": {"stage": 3, "stages": 3},
    }
    assert resolved[1] == {"ok": False, "result": None, "error": "plain"}
