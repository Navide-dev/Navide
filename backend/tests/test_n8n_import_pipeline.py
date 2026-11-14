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
from agent_team_backend import pipeline_graph as pg
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


# ── sub-workflows ────────────────────────────────────────────────────────
def _calling(wid: str, name: str, calls: str = "", tool: str = "") -> dict[str, Any]:
    """Workflow `wid`: Start → Work (→ Execute Workflow `calls`); an AI Agent
    with a workflow tool calling `tool` instead when given."""
    nodes: list[dict[str, Any]] = [
        {"id": "1", "name": "Start", "type": ni.BASE + "manualTrigger", "typeVersion": 1, "position": [0, 0],
         "parameters": {}},
        {"id": "2", "name": "Work", "type": ni.BASE + "set", "typeVersion": 3.4, "position": [200, 0],
         "parameters": {"value": "x"}},
    ]
    conns: dict[str, Any] = {"Start": {"main": [[{"node": "Work", "type": "main", "index": 0}]]}}
    if calls:
        nodes.append({"id": "3", "name": f"Run {calls}", "type": ni.BASE + "executeWorkflow", "typeVersion": 1.2,
                      "position": [400, 0], "parameters": {
                          "source": "database", "workflowId": {"__rl": True, "mode": "list", "value": calls}}})
        conns["Work"] = {"main": [[{"node": f"Run {calls}", "type": "main", "index": 0}]]}
    if tool:
        nodes += [
            {"id": "4", "name": "Agent", "type": ni.LANGCHAIN + "agent", "typeVersion": 1.7, "position": [400, 200],
             "parameters": {"text": "help"}},
            {"id": "5", "name": "Tool", "type": ni.LANGCHAIN + "toolWorkflow", "typeVersion": 2,
             "position": [400, 400], "parameters": {
                 "source": "database", "workflowId": {"__rl": True, "mode": "id", "value": tool}}},
        ]
        conns["Work"] = {"main": [[{"node": "Agent", "type": "main", "index": 0}]]}
        conns["Tool"] = {"ai_tool": [[{"node": "Agent", "type": "ai_tool", "index": 0}]]}
    return {"id": wid, "name": name, "nodes": nodes, "connections": conns}


def _sub_nodes(graph: dict[str, Any]) -> list[dict[str, Any]]:
    return [n for n in graph["nodes"] if n["kind"] == "subpipeline"]


def test_a_list_import_creates_the_called_workflow_first(wired: SimpleNamespace) -> None:
    parent, child = _calling("wf-a", "Parent", calls="wf-b"), _calling("wf-b", "Child")
    out = ni.import_into_store(wired.store, json.dumps([child, parent]), dry_run=False)
    assert out["pipeline"]["name"] == "Parent"  # the one nobody calls, wherever it is in the list
    names = _names(wired.store)
    assert names.index("Child") < names.index("Parent")
    child_id = next(p["id"] for p in wired.store.list_pipelines() if p["name"] == "Child")
    stored = wired.store.get_graph(out["pipeline"]["id"])["graph"]
    assert [n["subpipeline"]["pipelineId"] for n in _sub_nodes(stored)] == [child_id]
    assert pg.validate_graph(stored) == []
    assert out["report"]["subworkflows"] == [
        {"workflowId": "wf-b", "name": "Child", "status": "imported", "pipelineId": child_id}]
    assert wired.store.imported_from(child_id)["workflowId"] == "wf-b"


def test_a_list_dry_run_writes_nothing_and_previews_the_call(wired: SimpleNamespace) -> None:
    before = wired.store.export_document()
    out = ni.import_into_store(wired.store, [_calling("wf-a", "Parent", calls="wf-b"), _calling("wf-b", "Child")])
    assert wired.store.export_document() == before and "pipeline" not in out
    (sub,) = _sub_nodes(out["graph"])
    assert sub["subpipeline"]["pipelineId"] == "n8n:wf-b"
    assert pg.validate_graph(out["graph"]) == []
    assert out["report"]["subworkflows"] == [{"workflowId": "wf-b", "name": "Child", "status": "will-import"}]


def test_a_workflow_imported_before_is_reused(wired: SimpleNamespace) -> None:
    first = ni.import_into_store(wired.store, _calling("wf-b", "Child"), dry_run=False)
    out = ni.import_into_store(wired.store, _calling("wf-a", "Parent", calls="wf-b"), dry_run=False)
    stored = wired.store.get_graph(out["pipeline"]["id"])["graph"]
    assert [n["subpipeline"]["pipelineId"] for n in _sub_nodes(stored)] == [first["pipeline"]["id"]]
    assert out["report"]["subworkflows"] == [
        {"workflowId": "wf-b", "name": "Child", "status": "existing", "pipelineId": first["pipeline"]["id"]}]
    assert _names(wired.store).count("Child") == 1


def test_a_call_to_a_workflow_navide_does_not_have_is_missing(wired: SimpleNamespace) -> None:
    out = ni.import_into_store(wired.store, _calling("wf-a", "Parent", calls="wf-z"), dry_run=False)
    assert _sub_nodes(out["graph"]) == []
    assert out["report"]["subworkflows"] == [{"workflowId": "wf-z", "name": "", "status": "missing"}]
    assert "paste-subworkflow" in next(e for e in out["report"]["nodes"] if e["name"] == "Run wf-z")["actions"]


@pytest.mark.parametrize("pair", [
    [("wf-x", "X", "wf-y"), ("wf-y", "Y", "wf-x")],  # X → Y → X
    [("wf-s", "Self", "wf-s")],  # a workflow that calls itself
])
def test_recursive_calls_import_without_a_cycle(wired: SimpleNamespace, pair: list[tuple[str, str, str]]) -> None:
    out = ni.import_into_store(wired.store, [_calling(*p) for p in pair], dry_run=False)
    for p in wired.store.list_pipelines():
        if p["name"] in {name for _, name, _ in pair}:
            graph = wired.store.get_graph(p["id"])["graph"]
            assert _sub_nodes(graph) == [] and pg.validate_graph(graph) == []
    assert {s["status"] for s in out["report"]["subworkflows"]} == {"recursive"}
    e = next(e for e in out["report"]["nodes"] if e["type"].endswith("executeWorkflow"))
    assert e["reason"] == "recursive-subworkflow" and "paste-subworkflow" not in e["actions"]


def test_a_workflow_tool_is_disclosed_not_converted(wired: SimpleNamespace) -> None:
    out = ni.import_into_store(wired.store, [_calling("wf-a", "Parent", tool="wf-t"), _calling("wf-t", "Lookup")],
                               dry_run=False)
    lookup_id = next(p["id"] for p in wired.store.list_pipelines() if p["name"] == "Lookup")
    assert _sub_nodes(out["graph"]) == []
    tool = next(e for e in out["report"]["nodes"] if e["name"] == "Tool")
    assert (tool["category"], tool["result"]) == ("pending", "folded") and lookup_id in tool["detail"]
    assert any(f"imported here as the pipeline {lookup_id}" in s["kickoffBody"] for s in out["report"]["slots"])
    assert out["report"]["subworkflows"] == [
        {"workflowId": "wf-t", "name": "Lookup", "status": "imported", "pipelineId": lookup_id}]


async def test_mcp_and_ws_take_a_list_too(wired: SimpleNamespace) -> None:
    text = json.dumps([_calling("wf-a", "Parent", calls="wf-b"), _calling("wf-b", "Child")])
    out = await plan_mcp.pipeline_import_n8n(_ctx(), text)
    assert out["ok"] is True and out["report"]["subworkflows"][0]["status"] == "will-import"
    session = _Session()
    await ws_handlers.pipelines_import_n8n(session, "m1", "pipelines.import_n8n", {"json": text, "dry_run": True})
    assert session.last["payload"]["report"]["subworkflows"][0]["workflowId"] == "wf-b"
    bad = await plan_mcp.pipeline_import_n8n(_ctx(), json.dumps([_calling("wf-a", "A"), {"nodes": "x"}]))
    assert bad["ok"] is False and bad["error_code"] == "invalid" and bad["error"].startswith("workflow 2:")


# ── resend, size limit, rollback ─────────────────────────────────────────
async def test_a_resend_of_the_same_import_returns_the_pipeline_it_made(wired: SimpleNamespace) -> None:
    # The window gives up after 30 s while the import may still finish: the
    # same request again answers with that pipeline instead of a "(2)" copy.
    text = json.dumps(_workflow())
    a = await plan_mcp.pipeline_import_n8n(_ctx(), text, dry_run=False)
    s = _Session()
    await ws_handlers.pipelines_import_n8n(s, "1", "pipelines.import_n8n", {"json": text, "dry_run": False})
    b = s.last["payload"]
    assert b["pipeline"]["id"] == a["pipeline"]["id"] and b["reused"] is True
    assert _names(wired.store).count("Lead intake") == 1 and "Lead intake (2)" not in _names(wired.store)
    # Whitespace does not make it another workflow; another name or CLI does.
    c = await plan_mcp.pipeline_import_n8n(_ctx(), json.dumps(_workflow(), indent=2), dry_run=False)
    assert c["pipeline"]["id"] == a["pipeline"]["id"]
    d = await plan_mcp.pipeline_import_n8n(_ctx(), text, dry_run=False, default_agent="codex")
    assert d["pipeline"]["id"] != a["pipeline"]["id"] and "reused" not in d


async def test_a_resend_after_the_reuse_window_imports_again(wired: SimpleNamespace, monkeypatch) -> None:
    text = json.dumps(_workflow())
    monkeypatch.setattr(ni, "_now_iso", lambda: "2026-10-29T00:00:00Z")
    a = ni.import_into_store(wired.store, text, dry_run=False)
    monkeypatch.setattr(ni, "_now_iso", lambda: "2026-10-29T00:11:00Z")
    b = ni.import_into_store(wired.store, text, dry_run=False)
    assert b["pipeline"]["id"] != a["pipeline"]["id"] and b["pipeline"]["name"] == "Lead intake (2)"


async def test_a_list_resend_reuses_every_pipeline_it_made(wired: SimpleNamespace) -> None:
    text = json.dumps([_calling("wf-a", "Parent", calls="wf-b"), _calling("wf-b", "Child")])
    a = ni.import_into_store(wired.store, text, dry_run=False)
    count = len(wired.store.list_pipelines())
    b = ni.import_into_store(wired.store, text, dry_run=False)
    assert b["pipeline"]["id"] == a["pipeline"]["id"] and b["reused"] is True
    assert b["report"]["subworkflows"] == a["report"]["subworkflows"]
    assert len(wired.store.list_pipelines()) == count


async def test_a_workflow_over_the_size_limit_is_refused_on_both_paths(wired: SimpleNamespace) -> None:
    big = _workflow()
    big["nodes"][1]["parameters"]["body"] = "x" * ni.MAX_IMPORT_BYTES
    text = json.dumps(big)
    before = wired.store.export_document()
    out = await plan_mcp.pipeline_import_n8n(_ctx(), text)
    assert out["ok"] is False and out["error_code"] == "too_large"
    assert "5 MB" in out["error"]
    s = _Session()
    await ws_handlers.pipelines_import_n8n(s, "1", "pipelines.import_n8n", {"json": text, "dry_run": False})
    err = s.last["error"]
    assert err["code"] == "N8N_TOO_LARGE"
    assert err["details"] == {"reason": "too-large", "params": {"limitMb": 5, "sizeMb": 5.0}}
    assert wired.store.export_document() == before


async def test_a_store_refusal_mid_list_rolls_back_and_says_why(wired: SimpleNamespace, monkeypatch) -> None:
    text = json.dumps([_calling("wf-a", "Parent", calls="wf-b"), _calling("wf-b", "Child")])
    real = wired.store.create_imported_pipeline
    calls = {"n": 0}

    def flaky(*a: Any, **kw: Any) -> Any:
        calls["n"] += 1
        if calls["n"] == 2:
            raise pg.GraphError(["sub-pipeline cycle: x → y → x"])
        return real(*a, **kw)

    monkeypatch.setattr(wired.store, "create_imported_pipeline", flaky)
    before = [p["id"] for p in wired.store.list_pipelines()]
    out = await plan_mcp.pipeline_import_n8n(_ctx(), text, dry_run=False)
    assert out["ok"] is False and out["error_code"] == "refused"
    assert "Parent" in out["error"] and "sub-pipeline cycle" in out["error"]
    assert [p["id"] for p in wired.store.list_pipelines()] == before
    assert wired.events == []
    calls["n"] = 0
    s = _Session()
    await ws_handlers.pipelines_import_n8n(s, "1", "pipelines.import_n8n", {"json": text, "dry_run": False})
    assert s.last["error"]["code"] == "N8N_REFUSED"
    assert s.last["error"]["details"]["reason"] == "store-refused"
    assert [p["id"] for p in wired.store.list_pipelines()] == before
