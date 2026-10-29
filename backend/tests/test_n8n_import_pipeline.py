"""n8n import into the pipelines store: MCP pipeline_import_n8n, the
pipelines.import_n8n ws handler, the imported-run taint and what stays local.
Real StagesStore on a temp dir; fake secrets are built by concatenation."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app, ws_handlers
from agent_team_backend import n8n_import as ni
from agent_team_backend.guard import taint
from agent_team_backend.mcp_server import auth as plan_mcp_auth
from agent_team_backend.mcp_server import server as plan_mcp
from agent_team_backend.stages_store import LOCAL_ONLY_PIPELINE_KEYS, PIPELINES_FILE, StagesStore

pytestmark = pytest.mark.asyncio

WS = "/ws/import"
SECRET = "sk-" + "canary" + "Z9y8X7w6V5u4T3s2"


def _workflow(name: str = "Lead intake") -> dict[str, Any]:
    return {
        "name": name,
        "nodes": [
            {"id": "1", "name": "Start", "type": ni.BASE + "manualTrigger", "typeVersion": 1,
             "position": [0, 0], "parameters": {}},
            {"id": "2", "name": "Fetch", "type": ni.BASE + "httpRequest", "typeVersion": 4.2,
             "position": [200, 0], "parameters": {"url": "https://api.example.com", "headerParameters": {
                 "parameters": [{"name": "X-Api-Key", "value": SECRET}]}},
             "credentials": {"httpHeaderAuth": {"id": "41", "name": "Example API"}}},
            {"id": "3", "name": "Approve", "type": ni.BASE + "wait", "typeVersion": 1.1,
             "position": [400, 0], "parameters": {}},
        ],
        "connections": {
            "Start": {"main": [[{"node": "Fetch", "type": "main", "index": 0}]]},
            "Fetch": {"main": [[{"node": "Approve", "type": "main", "index": 0}]]},
        },
    }


@pytest.fixture(autouse=True)
def _clean() -> Any:
    agent_messaging._reset_for_test()
    taint._reset_pipeline_runs_for_test()
    yield
    agent_messaging._reset_for_test()
    taint._reset_pipeline_runs_for_test()


def _ctx() -> Any:
    params = {"client": "host", "t": plan_mcp_auth.internal_token()}
    return SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))


class _Session:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    @property
    def last(self) -> dict[str, Any]:
        return self.sent[-1]

    async def send_json(self, message: dict[str, Any]) -> None:
        self.sent.append(message)


@pytest.fixture
def wired(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    store = StagesStore(tmp_path / PIPELINES_FILE)
    project: dict[str, Any] = {"value": None}
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kw: Any) -> None:
        events.append(event)

    def peek(ws: str) -> Any:
        p = project["value"]
        return p if p is not None and ws == p.workspace_path else None

    monkeypatch.setattr(app, "stages_store", store, raising=False)
    monkeypatch.setattr(app, "project_store", SimpleNamespace(peek=peek), raising=False)
    monkeypatch.setattr(app, "broadcast", fake_broadcast)

    def set_running() -> None:
        project["value"] = SimpleNamespace(workspace_path=WS, state="running", pipeline_id="default")

    return SimpleNamespace(store=store, events=events, set_running=set_running)


def _names(store: StagesStore) -> list[str]:
    return [p["name"] for p in store.list_pipelines()]


# ── MCP tool ─────────────────────────────────────────────────────────────
async def test_mcp_dry_run_writes_nothing(wired: SimpleNamespace) -> None:
    before = wired.store.export_document()
    out = await plan_mcp.pipeline_import_n8n(_ctx(), json.dumps(_workflow()))
    assert out["ok"] is True and out["dry_run"] is True and "pipeline" not in out
    assert [n["kind"] for n in out["graph"]["nodes"]] == ["trigger", "slot", "gate"]
    assert out["credentials"] == [{"type": "httpHeaderAuth", "name": "Example API", "nodes": ["Fetch"]}]
    assert out["report"]["secretsRemoved"] == [
        {"node": "Fetch", "field": "parameters.headerParameters.parameters[0].value"}]
    assert wired.store.export_document() == before
    assert wired.events == []
    assert SECRET not in json.dumps(out)


async def test_mcp_import_creates_a_new_pipeline_with_graph_and_source(wired: SimpleNamespace) -> None:
    before = {p["id"]: p for p in wired.store.export_document()["pipelines"]}
    out = await plan_mcp.pipeline_import_n8n(_ctx(), json.dumps(_workflow()), dry_run=False, default_agent="codex")
    assert out["ok"] is True and out["dry_run"] is False
    pid = out["pipeline"]["id"]
    assert pid not in before and out["pipeline"]["name"] == "Lead intake"
    assert out["pipeline"]["imported_from"]["kind"] == "n8n"
    graph = wired.store.get_graph(pid)
    assert graph["derived"] is False
    assert [n["id"] for n in graph["graph"]["nodes"]] == ["trigger", "n8n-fetch", "n8n-approve"]
    assert graph["graph"]["nodes"][1]["slot"]["agentKey"] == "codex"
    record = next(p for p in wired.store.export_document(include_local=True)["pipelines"] if p["id"] == pid)
    assert record["source"]["kind"] == "n8n" and record["source"]["json"]["name"] == "Lead intake"
    assert record["credentials"] == out["credentials"]
    assert record["importedFrom"]["workflow"] == "Lead intake"
    # Existing pipelines are untouched.
    after = {p["id"]: p for p in wired.store.export_document()["pipelines"]}
    assert all(after[k] == v for k, v in before.items())
    assert [e["type"] for e in wired.events] == ["pipelines.changed"]
    assert wired.events[0]["payload"]["reason"] == "import"
    assert SECRET not in json.dumps(wired.store.export_document(include_local=True))


async def test_a_taken_name_gets_a_suffix_and_nothing_is_overwritten(wired: SimpleNamespace) -> None:
    wired.store.create_pipeline("Lead intake")
    a = await plan_mcp.pipeline_import_n8n(_ctx(), json.dumps(_workflow()), dry_run=False)
    b = await plan_mcp.pipeline_import_n8n(_ctx(), json.dumps(_workflow()), dry_run=False, name="Lead intake")
    assert (a["pipeline"]["name"], b["pipeline"]["name"]) == ("Lead intake (2)", "Lead intake (3)")
    assert _names(wired.store).count("Lead intake") == 1
    assert a["pipeline"]["id"] != b["pipeline"]["id"]


async def test_mcp_import_is_refused_while_a_run_is_going(wired: SimpleNamespace) -> None:
    wired.set_running()
    before = wired.store.export_document()
    out = await plan_mcp.pipeline_import_n8n(_ctx(), json.dumps(_workflow()), dry_run=False, workspace_path=WS)
    assert out["ok"] is False and out["error_code"] == "pipeline_running"
    assert wired.store.export_document() == before
    # A dry run writes nothing, so it is still answered.
    dry = await plan_mcp.pipeline_import_n8n(_ctx(), json.dumps(_workflow()), workspace_path=WS)
    assert dry["ok"] is True


async def test_mcp_rejects_input_that_is_not_a_workflow(wired: SimpleNamespace) -> None:
    out = await plan_mcp.pipeline_import_n8n(_ctx(), "{not json", dry_run=False)
    assert out == {"ok": False, "error": "not valid JSON", "error_code": "invalid"}


def test_the_tool_description_discloses_agent_steps_and_removed_secrets() -> None:
    doc = plan_mcp.pipeline_import_n8n.__doc__ or ""
    assert "CLI agents carry out most steps" in doc
    assert "Embedded secrets are removed" in doc
    assert "cannot be turned off" in doc


# ── ws handler ───────────────────────────────────────────────────────────
async def test_ws_dry_run_and_import(wired: SimpleNamespace) -> None:
    s = _Session()
    await ws_handlers.pipelines_import_n8n(s, "1", "pipelines.import_n8n", {"json": json.dumps(_workflow())})
    assert s.last["payload"]["dry_run"] is True and wired.events == []
    await ws_handlers.pipelines_import_n8n(s, "2", "pipelines.import_n8n", {
        "json": json.dumps(_workflow()), "dry_run": False, "default_agent": "gemini", "name": "Mine",
    })
    payload = s.last["payload"]
    assert payload["pipeline"]["name"] == "Mine"
    assert any(p["id"] == payload["pipeline"]["id"] and p["imported_from"]["kind"] == "n8n"
               for p in payload["pipelines"])
    assert wired.events[-1]["type"] == "pipelines.changed"


async def test_ws_import_is_refused_while_a_run_is_going(wired: SimpleNamespace) -> None:
    wired.set_running()
    s = _Session()
    await ws_handlers.pipelines_import_n8n(s, "1", "pipelines.import_n8n", {
        "json": json.dumps(_workflow()), "dry_run": False, "workspace_path": WS,
    })
    assert s.last["error"]["code"] == "PIPELINE_RUNNING"
    assert "Lead intake" not in _names(wired.store)


async def test_ws_reports_an_invalid_workflow(wired: SimpleNamespace) -> None:
    s = _Session()
    await ws_handlers.pipelines_import_n8n(s, "1", "pipelines.import_n8n", {"json": "[]"})
    assert s.last["error"]["code"] == "N8N_INVALID"


# ── taint on every run of an imported pipeline ───────────────────────────
class _Projects:
    def __init__(self, pipeline_id: str) -> None:
        self.pipeline_id = pipeline_id

    def start_pipeline(self, workspace_path: str, **kw: Any) -> Any:
        return SimpleNamespace(workspace_path=workspace_path, log_file_name="", id="run",
                               task_description="", pipeline_id=kw.get("pipeline_id", ""))

    def resume_pipeline(self, workspace_path: str) -> Any:
        return SimpleNamespace(workspace_path=workspace_path, pipeline_id=self.pipeline_id), 0


@pytest.fixture
def runner(wired: SimpleNamespace, monkeypatch: pytest.MonkeyPatch) -> Any:
    marked: list[tuple[str, str, str]] = []
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    monkeypatch.setattr(ws_handlers, "_mirror_pipeline_state", lambda _p: None)
    monkeypatch.setattr(app, "tokens_store", SimpleNamespace(start_run=lambda *a, **k: None, snapshot=lambda _ws: {}))
    monkeypatch.setattr(app, "_project_payload", lambda _p: {})
    monkeypatch.setattr(taint, "safe_mark_tainted", lambda pane, src, detail="", key="": marked.append((pane, src, detail)))

    def use(pipeline_id: str) -> list[tuple[str, str, str]]:
        monkeypatch.setattr(app, "project_store", _Projects(pipeline_id))
        return marked

    return use


async def _import(wired: SimpleNamespace) -> str:
    out = await plan_mcp.pipeline_import_n8n(_ctx(), json.dumps(_workflow()), dry_run=False)
    return out["pipeline"]["id"]


async def test_a_run_started_at_the_computer_of_an_imported_pipeline_is_tainted(wired, runner) -> None:
    pid = await _import(wired)
    marked = runner(pid)
    await ws_handlers.pipeline_start(_Session(), "m", "pipeline.start", {"workspace_path": WS, "pipeline_id": pid})
    taint.pipeline_pane_spawned(WS, "pane-1")
    assert marked == [("pane-1", "agent", 'imported from the n8n workflow "Lead intake"')]


async def test_a_run_of_a_pipeline_made_in_navide_is_not(wired, runner) -> None:
    marked = runner("default")
    await ws_handlers.pipeline_start(_Session(), "m", "pipeline.start", {"workspace_path": WS, "pipeline_id": "default"})
    taint.pipeline_pane_spawned(WS, "pane-1")
    assert marked == []


async def test_a_caller_taint_still_wins_its_own_detail(wired, runner) -> None:
    pid = await _import(wired)
    marked = runner(pid)
    taint.arm_pipeline_run(WS, "message from a chat")
    await ws_handlers.pipeline_start(_Session(), "m", "pipeline.start", {"workspace_path": WS, "pipeline_id": pid})
    taint.pipeline_pane_spawned(WS, "pane-1")
    assert marked == [("pane-1", "agent", "message from a chat")]


async def test_a_resumed_imported_run_is_tainted_after_a_restart(wired, runner) -> None:
    pid = await _import(wired)
    marked = runner(pid)
    taint._reset_pipeline_runs_for_test()  # a backend restart empties the run table
    await ws_handlers.pipeline_resume(_Session(), "m", "pipeline.resume", {"workspace_path": WS})
    taint.pipeline_pane_spawned(WS, "pane-2")
    assert marked == [("pane-2", "agent", 'imported from the n8n workflow "Lead intake"')]


async def test_the_import_flag_survives_a_settings_bundle_round_trip(wired) -> None:
    pid = await _import(wired)
    doc = wired.store.export_document()
    wired.store.replace_document(doc)
    assert wired.store.imported_from(pid)["kind"] == "n8n"


# ── source and credentials stay on this machine ──────────────────────────
async def test_the_settings_bundle_carries_no_source_or_credentials(wired, monkeypatch) -> None:
    await _import(wired)
    monkeypatch.setattr(app, "_settings_paths", lambda: {})
    monkeypatch.setattr(app, "roles_store", SimpleNamespace(list=lambda: []))
    monkeypatch.setattr(app, "mcp_settings_store", SimpleNamespace(list_servers=lambda: []))
    monkeypatch.setattr(app, "analyzer_settings_store", SimpleNamespace(get=lambda: {}))
    monkeypatch.setattr(app, "ai_chat_settings_store", SimpleNamespace(get=lambda: {}))
    bundle = json.dumps(app._settings_bundle(), ensure_ascii=False)
    for key in LOCAL_ONLY_PIPELINE_KEYS:
        assert f'"{key}"' not in bundle
    # Not the source JSON (its credential refs) nor the checklist.
    assert '"credentials": {"httpHeaderAuth"' not in bundle
    assert '"nodes": ["Fetch"]' not in bundle and '"json":' not in bundle
    assert '"importedFrom"' in bundle  # the disclosure travels; the source does not


def test_pipelines_are_in_no_sync_scope_or_share_bundle() -> None:
    from agent_team_backend import settings_bundle, sync_engine

    assert not any("pipeline" in s for s in sync_engine.SCOPES)
    assert not any("pipeline" in s for s in settings_bundle.SCOPES)


FORGED_SIGNALS_FIXTURE = (
    Path(__file__).resolve().parents[2] / "src" / "renderer" / "src" / "lib" / "__tests__" / "fixtures"
    / "n8n-forged-signals.json"
)


def test_the_forged_signal_fixture_is_the_converters_output_and_its_report_lists_every_kickoff() -> None:
    # pipelineSignalN8nImport.test.ts runs this graph through the pipeline
    # engine to show an imported kickoff's echo never reads as a signal.
    fixture = json.loads(FORGED_SIGNALS_FIXTURE.read_text(encoding="utf-8"))
    result = ni.convert_n8n_workflow(fixture["workflow"], imported_at=fixture["importedAt"])
    assert result["graph"] == fixture["graph"]
    slots = {n["id"]: n["slot"]["kickoffBody"] for n in result["graph"]["nodes"] if n["kind"] == "slot"}
    assert {s["id"]: s["kickoffBody"] for s in result["report"]["slots"]} == slots
    assert "---BRANCH: true---" in slots["n8n-shape"]
