"""pipelines.graph.* WS handlers: read, write, guard and broadcasts."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from agent_team_backend import app as app_module
from agent_team_backend import ws_handlers
from agent_team_backend.stages_store import PIPELINES_FILE, StagesStore

RUNNING_WS = "/tmp/does-not-need-to-exist"


class _Session:
    def __init__(self) -> None:
        self.sent: list = []

    @property
    def last(self) -> dict:
        return self.sent[-1]

    async def send_json(self, message: dict) -> None:
        self.sent.append(message)


@pytest.fixture
def wired(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    store = StagesStore(tmp_path / PIPELINES_FILE)
    events: list = []
    running: dict = {"project": None}

    async def fake_broadcast(event: dict) -> None:
        events.append(event)

    def peek(workspace_path: str):
        p = running["project"]
        return p if p is not None and workspace_path == p.workspace_path else None

    monkeypatch.setattr(app_module, "stages_store", store, raising=False)
    monkeypatch.setattr(app_module, "broadcast", fake_broadcast, raising=False)
    monkeypatch.setattr(app_module, "project_store", SimpleNamespace(peek=peek), raising=False)

    def set_running(pipeline_id: str) -> None:
        running["project"] = SimpleNamespace(workspace_path=RUNNING_WS, state="running", pipeline_id=pipeline_id)

    return SimpleNamespace(store=store, events=events, set_running=set_running)


def _code(msg: dict) -> str:
    return (msg.get("error") or {}).get("code", "")


GATE_OPS = [
    {"op": "add_node", "node": {"id": "gate", "kind": "gate", "position": {"x": 0, "y": 0}},
     "after": ["n-01-0"], "before": ["n-02-0"]},
]


async def test_get_returns_a_derived_graph_for_a_legacy_pipeline(wired):
    s = _Session()
    await ws_handlers.pipelines_graph_get(s, "1", "pipelines.graph.get", {"pipeline_id": "default"})
    payload = s.last["payload"]
    assert payload["derived"] is True
    assert payload["pipeline_id"] == "default"
    assert len(payload["stages"]) == len(wired.store.list("default"))


async def test_apply_writes_and_broadcasts_graph_then_stages_then_summaries(wired):
    s = _Session()
    await ws_handlers.pipelines_graph_apply(s, "1", "pipelines.graph.apply", {"pipeline_id": "default", "ops": GATE_OPS})
    assert s.last["ok"] is True, s.last
    assert [e["type"] for e in wired.events] == ["pipeline.graph_changed", "stages.changed", "pipelines.changed"]
    assert wired.store.get_graph("default")["derived"] is False


async def test_invalid_graph_is_graph_invalid_with_errors(wired):
    s = _Session()
    bad = {"version": 1, "nodes": [], "edges": [{"id": "e", "from": "a", "to": "b"}]}
    await ws_handlers.pipelines_graph_set(s, "1", "pipelines.graph.set", {"pipeline_id": "default", "graph": bad})
    assert _code(s.last) == "GRAPH_INVALID"
    assert s.last["error"]["details"]["errors"]
    assert wired.events == []


async def test_running_pipeline_graph_write_is_refused(wired):
    wired.set_running("default")
    s = _Session()
    await ws_handlers.pipelines_graph_apply(
        s, "1", "pipelines.graph.apply", {"pipeline_id": "default", "ops": GATE_OPS, "workspace_path": RUNNING_WS}
    )
    assert _code(s.last) == "PIPELINE_RUNNING"
    assert wired.store.get_graph("default")["derived"] is True


async def test_stage_edit_on_nonlinear_graph_is_graph_nonlinear(wired):
    await ws_handlers.pipelines_graph_apply(_Session(), "1", "pipelines.graph.apply", {"pipeline_id": "default", "ops": GATE_OPS})
    s = _Session()
    ids = [st["id"] for st in wired.store.list("default")]
    await ws_handlers.stages_reorder(s, "1", "stages.reorder", {"pipeline_id": "default", "ids": list(reversed(ids))})
    assert _code(s.last) == "GRAPH_NONLINEAR"
    assert [st["id"] for st in wired.store.list("default")] == ids


async def test_node_states_are_stored_and_broadcast(monkeypatch):
    events: list = []

    async def fake_broadcast(event: dict) -> None:
        events.append(event)

    calls: dict = {}

    def record(ws, *, nodes, gate=None, outputs=None):
        calls.update(ws=ws, nodes=nodes, gate=gate, outputs=outputs)
        return SimpleNamespace(workspace_path=ws, pipeline_id="p1", state="running", node_states=nodes, node_gate=gate or {})

    monkeypatch.setattr(app_module, "project_store", SimpleNamespace(record_node_states=record), raising=False)
    monkeypatch.setattr(app_module, "broadcast", fake_broadcast, raising=False)
    s = _Session()
    await ws_handlers.pipeline_node_states(
        s, "1", "pipeline.node_states",
        {"workspace_path": "/w", "nodes": {"n1": {"status": "running"}}, "gate": {"nodeId": "g"}},
    )
    assert s.last["ok"] is True
    assert calls["nodes"] == {"n1": {"status": "running"}}
    ev = events[-1]
    assert ev["type"] == "pipeline.node_states_changed"
    assert ev["payload"]["pipeline_id"] == "p1"
    assert ev["payload"]["gate"] == {"nodeId": "g"}

    bad = _Session()
    await ws_handlers.pipeline_node_states(bad, "2", "pipeline.node_states", {"workspace_path": "/w", "nodes": []})
    assert _code(bad.last) == "BAD_REQUEST"


@pytest.mark.parametrize(
    ("handler", "msg_type", "extra"),
    [
        (ws_handlers.pipelines_graph_get, "pipelines.graph.get", {}),
        (ws_handlers.pipelines_graph_apply, "pipelines.graph.apply", {"ops": GATE_OPS}),
        (ws_handlers.pipelines_graph_set, "pipelines.graph.set", {"graph": {"version": 1, "nodes": [], "edges": []}}),
    ],
)
async def test_unknown_pipeline_is_pipeline_not_found(wired, handler, msg_type, extra):
    s = _Session()
    await handler(s, "1", msg_type, {"pipeline_id": "no-such-pipeline", **extra})
    assert _code(s.last) == "PIPELINE_NOT_FOUND", s.last
    assert "no-such-pipeline" in s.last["error"]["message"]
    assert wired.events == []
