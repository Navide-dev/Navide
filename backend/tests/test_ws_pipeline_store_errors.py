"""Pipeline definition and run-record handlers answer a user's mistake with a
code the window can translate, not a crash (pipeline UX PR-B, B1/B5).

Before: the store's KeyError/ValueError escaped the definition handlers, so the
generic dispatcher answered ``BAD_REQUEST "missing field: 'pipeline not found:
x'"`` or ``INTERNAL_ERROR`` and recorded the user's mistake in the error ledger
as a backend crash. pipeline.resume and pipeline.auto_answer had no try;
update_slot_kickoff answered ok for a slot that does not exist; an
out-of-range stage index did not say what the range was.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from agent_team_backend import app as app_module
from agent_team_backend import ws_handlers
from agent_team_backend.projects import ProjectStore
from agent_team_backend.stages_store import PIPELINES_FILE, StagesStore


class _Session:
    def __init__(self) -> None:
        self.sent: list = []
        self.dead = False
        self.window_id = "win-1"
        self.held_workspaces = ()

    @property
    def error(self) -> dict:
        assert self.sent, "the handler must answer the request"
        last = self.sent[-1]
        assert last["ok"] is False, last
        return last["error"]

    async def send_json(self, message: dict) -> None:
        self.sent.append(message)


@pytest.fixture
def store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> StagesStore:
    s = StagesStore(tmp_path / PIPELINES_FILE)

    async def fake_broadcast(event: dict) -> None:
        pass

    monkeypatch.setattr(app_module, "stages_store", s, raising=False)
    monkeypatch.setattr(app_module, "broadcast", fake_broadcast, raising=False)
    monkeypatch.setattr(app_module, "project_store", SimpleNamespace(peek=lambda _ws: None), raising=False)
    return s


async def _call(type_: str, payload: dict) -> _Session:
    session = _Session()
    await ws_handlers.lookup(type_)(session, "m1", type_, payload)
    return session


# ── B1: definition handlers ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_rename_unknown_pipeline_is_not_found_with_the_known_ids(store: StagesStore) -> None:
    err = (await _call("pipelines.rename", {"pipeline_id": "nope", "name": "x"})).error
    assert err["code"] == "PIPELINE_NOT_FOUND"
    assert err["details"]["pipeline_id"] == "nope"
    assert "default" in err["details"]["available_ids"]


@pytest.mark.asyncio
async def test_set_active_and_stage_list_of_unknown_pipeline_are_not_found(store: StagesStore) -> None:
    assert (await _call("pipelines.set_active", {"pipeline_id": "nope"})).error["code"] == "PIPELINE_NOT_FOUND"
    assert (await _call("stages.list", {"pipeline_id": "nope"})).error["code"] == "PIPELINE_NOT_FOUND"
    assert (await _call("stages.reset", {"pipeline_id": "nope"})).error["code"] == "PIPELINE_NOT_FOUND"


@pytest.mark.asyncio
async def test_deleting_the_last_pipeline_is_a_refusal_with_a_reason(store: StagesStore) -> None:
    for p in store.list_pipelines()[1:]:
        store.delete_pipeline(p["id"])
    only = store.list_pipelines()[0]["id"]
    err = (await _call("pipelines.delete", {"pipeline_id": only})).error
    assert err["code"] == "PIPELINE_REFUSED"
    assert err["details"]["reason"] == "last-pipeline"


@pytest.mark.asyncio
async def test_reset_builtin_on_a_custom_pipeline_is_a_refusal(store: StagesStore) -> None:
    custom = store.create_pipeline("Mine")
    err = (await _call("pipelines.reset_builtin", {"pipeline_id": custom["id"]})).error
    assert err["code"] == "PIPELINE_REFUSED"
    assert err["details"]["reason"] == "not-builtin"


@pytest.mark.asyncio
async def test_stage_without_a_slot_is_a_refusal(store: StagesStore) -> None:
    err = (await _call("stages.upsert", {"pipeline_id": "default", "stage": {"id": "s1", "slots": []}})).error
    assert err["code"] == "PIPELINE_REFUSED"
    assert err["details"]["reason"] == "stage-needs-slot"


@pytest.mark.asyncio
async def test_deleting_an_unknown_stage_lists_the_stages_there_are(store: StagesStore) -> None:
    err = (await _call("stages.delete", {"pipeline_id": "default", "id": "nope"})).error
    assert err["code"] == "STAGE_NOT_FOUND"
    assert err["details"]["stage_id"] == "nope"
    assert err["details"]["available_stage_ids"] == [s["id"] for s in store.list("default")]


@pytest.mark.asyncio
async def test_a_missing_request_field_is_still_the_dispatchers_bad_request(store: StagesStore) -> None:
    # Only the store's own refusals are mapped: a request without "id" is a
    # malformed request, which stays the KeyError the dispatcher reports.
    with pytest.raises(KeyError):
        await _call("stages.delete", {"pipeline_id": "default"})


# ── B5: run-record handlers ─────────────────────────────────────────────────


@pytest.fixture
def ws(tmp_path: Path) -> str:
    path = tmp_path / "ws"
    path.mkdir()
    return str(path)


@pytest.fixture
def projects(monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    p = ProjectStore()
    monkeypatch.setattr(app_module, "project_store", p, raising=False)
    monkeypatch.setattr(
        app_module, "_project_payload", lambda proj: {"state": proj.state}, raising=False
    )
    return p


def _started(projects: ProjectStore, ws: str) -> None:
    projects.start_pipeline(
        ws,
        task_description="t",
        total_stages=2,
        stage_blueprint=[
            {"stage_id": "a", "title": "A", "slots": [{"agent": "claude", "role": "", "label": "x"}]},
            {"stage_id": "b", "title": "B", "slots": [{"agent": "claude", "role": "", "label": "y"}]},
        ],
        backend_version="test",
        pipeline_id="default",
    )


@pytest.mark.asyncio
async def test_resume_with_no_run_is_a_coded_refusal(projects: ProjectStore, ws: str) -> None:
    err = (await _call("pipeline.resume", {"workspace_path": ws})).error
    assert err["code"] == "NO_RUN_TO_RESUME"


@pytest.mark.asyncio
async def test_kickoff_for_a_slot_that_does_not_exist_is_an_error(projects: ProjectStore, ws: str) -> None:
    _started(projects, ws)
    err = (await _call(
        "pipeline.slot_kickoff",
        {"workspace_path": ws, "stage_index": 0, "slot_label": "ghost", "kickoff_status": "sent"},
    )).error
    assert err["code"] == "SLOT_NOT_FOUND"
    assert err["details"] == {"stage_index": 0, "slot_label": "ghost"}


@pytest.mark.asyncio
async def test_out_of_range_stage_index_names_the_range(projects: ProjectStore, ws: str) -> None:
    _started(projects, ws)
    err = (await _call(
        "pipeline.stage_spawn", {"workspace_path": ws, "stage_index": 5, "pane_id": "p1"}
    )).error
    assert err["code"] == "STAGE_OUT_OF_RANGE"
    assert err["details"] == {"stage_index": 5, "total_stages": 2}
    assert "0..1" in err["message"]


@pytest.mark.asyncio
async def test_auto_answer_failure_is_answered_not_raised(monkeypatch: pytest.MonkeyPatch) -> None:
    async def broken(**_kw):
        raise RuntimeError("ollama is not running")

    monkeypatch.setattr(app_module, "analyzer_auto_answer", broken, raising=False)
    monkeypatch.setattr(app_module, "ANALYZER_DEFAULT_MODEL", "m", raising=False)
    err = (await _call("pipeline.auto_answer", {"questions": ["q"]})).error
    assert err["code"] == "AUTO_ANSWER_FAILED"
    assert "ollama is not running" in err["message"]


# ── B3: graph refusals only the backend can see carry a problem code ─────────


@pytest.mark.asyncio
async def test_a_sub_pipeline_calling_itself_is_coded(store: StagesStore) -> None:
    mine = store.create_pipeline("Mine")
    graph = {
        "version": 1,
        "nodes": [
            {"id": "t", "kind": "trigger", "label": "Start", "position": {"x": 0, "y": 0}},
            {"id": "c", "kind": "subpipeline", "label": "Call", "position": {"x": 200, "y": 0},
             "subpipeline": {"pipelineId": mine["id"]}},
        ],
        "edges": [{"id": "e1", "from": "t", "to": "c"}],
    }
    err = (await _call("pipelines.graph.set", {"pipeline_id": mine["id"], "graph": graph})).error
    assert err["code"] == "GRAPH_INVALID"
    assert err["details"]["code"] == "subpipeline-links"
    assert err["details"]["errors"], "the English sentences are still there for MCP callers"


# ── Coded store errors from elsewhere (PR-E's PipelineAlreadyRunning) ────────


class _CodedRefusal(ValueError):
    """Stands in for a store error that names itself, as PR-E's
    PipelineAlreadyRunning does (error_code = "pipeline_already_running")."""

    error_code = "pipeline_already_running"


@pytest.mark.asyncio
async def test_a_store_error_with_an_error_code_answers_that_code_in_capitals(
    store: StagesStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(*_a, **_k):
        raise _CodedRefusal("a pipeline is already running in this workspace")

    monkeypatch.setattr(store, "rename_pipeline", refuse)
    err = (await _call("pipelines.rename", {"pipeline_id": "default", "name": "x"})).error
    assert err["code"] == "PIPELINE_ALREADY_RUNNING"
    assert err["message"] == "a pipeline is already running in this workspace"


@pytest.mark.asyncio
async def test_pipeline_start_maps_a_coded_refusal_too(monkeypatch: pytest.MonkeyPatch, ws: str) -> None:
    def refuse(*_a, **_k):
        raise _CodedRefusal("a pipeline is already running in this workspace")

    monkeypatch.setattr(app_module, "project_store", SimpleNamespace(peek=lambda _ws: None, start_pipeline=refuse), raising=False)
    monkeypatch.setattr(app_module, "stages_store", SimpleNamespace(get_active_pipeline_id=lambda: "default"), raising=False)
    err = (await _call("pipeline.start", {"workspace_path": ws, "pipeline_id": "default"})).error
    assert err["code"] == "PIPELINE_ALREADY_RUNNING"


@pytest.mark.asyncio
async def test_a_plain_value_error_still_reaches_the_dispatcher(store: StagesStore, monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(*_a, **_k):
        raise ValueError("a real fault")

    monkeypatch.setattr(store, "rename_pipeline", broken)
    with pytest.raises(ValueError, match="a real fault"):
        await _call("pipelines.rename", {"pipeline_id": "default", "name": "x"})
