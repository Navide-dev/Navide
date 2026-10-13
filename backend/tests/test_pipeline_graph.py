"""Pipeline graph model: pure helpers + StagesStore graph storage.

The pure helpers mirror src/renderer/src/lib/pipelineGraph.ts; the cases here
match lib/__tests__/pipelineGraph.test.ts so the two cannot drift silently.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_team_backend import pipeline_graph as pg
from agent_team_backend.roles_store import RolesStore
from agent_team_backend.stages_store import PIPELINES_FILE, GraphNonLinearError, StagesStore


def stage(sid: str, labels: list[str]) -> dict:
    return {
        "id": sid,
        "title": f"T{sid}",
        "short_title": f"S{sid}",
        "question": "",
        "description": "",
        "recommended_roles": [],
        "sentinel": f"---{sid}---",
        "allow_questions": False,
        "doc_query": "",
        "slots": [
            {"agent_key": "claude", "role_key": "pm", "label": lab, "kickoff_body": f"do {lab}", "is_commander": False}
            for lab in labels
        ],
    }


LEGACY = [stage("01", ["plan"]), stage("02", ["fe", "be"]), stage("03", ["review"])]


def slot_node(nid: str) -> dict:
    return {
        "id": nid, "kind": "slot", "position": {"x": 0, "y": 0},
        "slot": {"agentKey": "claude", "roleKey": "", "label": nid, "kickoffBody": ""},
    }


class TestPureHelpers:
    def test_derived_graph_is_linear_and_round_trips(self):
        g = pg.derive_graph_from_stages(LEGACY)
        assert [n["id"] for n in g["nodes"]] == ["trigger", "n-01-0", "n-02-0", "n-02-1", "n-03-0"]
        assert [(e["from"], e["to"]) for e in g["edges"]] == [
            ("trigger", "n-01-0"), ("n-01-0", "n-02-0"), ("n-01-0", "n-02-1"),
            ("n-02-0", "n-03-0"), ("n-02-1", "n-03-0"),
        ]
        assert pg.validate_graph(g) == []
        assert pg.is_linear_graph(g)
        assert pg.derive_stages_from_graph(g, LEGACY) == LEGACY

    def test_longest_path_layering(self):
        g = {
            "version": 1,
            "nodes": [slot_node(i) for i in "abcde"],
            "edges": [{"id": f + t, "from": f, "to": t} for f, t in ["ab", "bc", "ce", "ad", "de"]],
        }
        assert pg.layer_graph(g)[0] == [["a"], ["b", "d"], ["c"], ["e"]]

    def test_reject_edges_are_ignored_by_layering_but_validated(self):
        g = pg.derive_graph_from_stages(LEGACY)
        g["edges"].append({"id": "loop", "from": "n-03-0", "to": "n-02-0", "kind": "reject", "maxLoops": 2})
        assert pg.validate_graph(g) == []
        assert not pg.is_linear_graph(g)
        g["edges"].append({"id": "fwd", "from": "n-01-0", "to": "n-03-0", "kind": "reject"})
        g["edges"].append({"id": "big", "from": "n-03-0", "to": "n-01-0", "kind": "reject", "maxLoops": 99})
        errs = "\n".join(pg.validate_graph(g))
        assert "fwd must point to an upstream" in errs
        assert "big: maxLoops" in errs

    def test_main_cycle_is_rejected(self):
        g = pg.derive_graph_from_stages(LEGACY)
        g["edges"].append({"id": "back", "from": "n-03-0", "to": "n-01-0"})
        assert any("cycle" in e for e in pg.validate_graph(g))

    def test_gate_only_layer_produces_no_stage(self):
        g = pg.apply_graph_ops(pg.derive_graph_from_stages(LEGACY), [
            {"op": "add_node", "node": {"id": "gate", "kind": "gate", "position": {"x": 0, "y": 0}},
             "after": ["n-02-0", "n-02-1"], "before": ["n-03-0"]},
            {"op": "add_node", "node": slot_node("extra"), "after": ["n-03-0"]},
        ])
        assert pg.validate_graph(g) == []
        stages = pg.derive_stages_from_graph(g, LEGACY)
        assert [s["id"] for s in stages] == ["01", "02", "03", "L4"]
        assert stages[2]["sentinel"] == "---03---"
        assert stages[3]["slots"][0]["label"] == "extra"

    def test_remove_node_reconnects(self):
        g0 = pg.derive_graph_from_stages([stage("01", ["a"]), stage("02", ["b"])])
        g1 = pg.apply_graph_ops(g0, [{"op": "add_node", "node": {"id": "g", "kind": "gate", "position": {"x": 1, "y": 1}},
                                       "after": ["n-01-0"], "before": ["n-02-0"]}])
        assert [(e["from"], e["to"]) for e in g1["edges"]] == [("trigger", "n-01-0"), ("n-01-0", "g"), ("g", "n-02-0")]
        g2 = pg.apply_graph_ops(g1, [{"op": "remove_node", "id": "g"}])
        assert [(e["from"], e["to"]) for e in g2["edges"]] == [("trigger", "n-01-0"), ("n-01-0", "n-02-0")]
        assert len(g0["nodes"]) == 3

    def test_bad_op_raises(self):
        with pytest.raises(pg.GraphError):
            pg.apply_graph_ops(pg.derive_graph_from_stages(LEGACY), [{"op": "move_node", "id": "nope", "position": {"x": 0, "y": 0}}])


class TestStoreGraph:
    def store(self, tmp_path: Path) -> StagesStore:
        return StagesStore(tmp_path / PIPELINES_FILE)

    def test_legacy_pipeline_loads_unchanged_and_graph_is_derived_without_writing(self, tmp_path):
        s = self.store(tmp_path)
        before = s.export_document()
        out = s.get_graph("default")
        assert out["derived"] is True
        assert pg.validate_graph(out["graph"]) == []
        assert s.export_document() == before
        assert all(p["has_graph"] is False for p in s.list_pipelines())

    def test_graph_ops_store_graph_and_rederive_stages(self, tmp_path):
        s = self.store(tmp_path)
        pid = s.create_pipeline("g")["id"]
        s.upsert(stage("01", ["plan"]), pid)
        s.upsert(stage("02", ["impl"]), pid)
        out = s.apply_graph_ops(pid, [
            {"op": "add_node", "node": {"id": "gate", "kind": "gate", "position": {"x": 0, "y": 0}},
             "after": ["n-01-0"], "before": ["n-02-0"]},
            {"op": "add_edge", "edge": {"id": "rej", "from": "gate", "to": "n-01-0", "kind": "reject", "maxLoops": 3}},
        ])
        assert [st["id"] for st in out["stages"]] == ["01", "02"]
        assert s.get_graph(pid)["derived"] is False
        assert s.list(pid)[1]["slots"][0]["label"] == "impl"
        # Non-linear now: stage tools must refuse instead of losing the gate.
        with pytest.raises(GraphNonLinearError):
            s.upsert(stage("03", ["x"]), pid)
        with pytest.raises(GraphNonLinearError):
            s.reorder(["02", "01"], pid)

    def test_invalid_graph_is_refused_and_nothing_written(self, tmp_path):
        s = self.store(tmp_path)
        before = s.export_document()
        bad = pg.derive_graph_from_stages(LEGACY)
        bad["edges"].append({"id": "back", "from": "n-03-0", "to": "n-01-0"})
        with pytest.raises(pg.GraphError):
            s.set_graph("default", bad)
        assert s.export_document() == before

    def test_stage_edit_on_linear_graph_resyncs_and_keeps_positions(self, tmp_path):
        s = self.store(tmp_path)
        pid = s.create_pipeline("g")["id"]
        s.upsert(stage("01", ["plan"]), pid)
        s.apply_graph_ops(pid, [{"op": "move_node", "id": "n-01-0", "position": {"x": 77, "y": 88}},
                                {"op": "set_pin", "id": "n-01-0", "pinned": True}])
        s.upsert(stage("02", ["impl"]), pid)
        g = s.get_graph(pid)["graph"]
        node = next(n for n in g["nodes"] if n["id"] == "n-01-0")
        assert node["position"] == {"x": 77, "y": 88}
        assert node["pinned"] is True
        assert ("n-01-0", "n-02-0") in {(e["from"], e["to"]) for e in g["edges"]}

    def test_replace_document_keeps_graph(self, tmp_path):
        s = self.store(tmp_path)
        s.apply_graph_ops("default", [{"op": "move_node", "id": "trigger", "position": {"x": 5, "y": 5}}])
        doc = s.export_document()
        s2 = StagesStore(tmp_path / "other" / PIPELINES_FILE)
        s2.replace_document(doc)
        assert s2.get_graph("default")["graph"]["nodes"][0]["position"] == {"x": 5, "y": 5}

    def test_role_repoint_reaches_graph_nodes(self, tmp_path):
        s = self.store(tmp_path)
        pid = s.create_pipeline("g")["id"]
        s.upsert(stage("01", ["plan"]), pid)
        s.apply_graph_ops(pid, [{"op": "move_node", "id": "n-01-0", "position": {"x": 1, "y": 1}}])
        s.repoint_role_references("pm", "lead")
        g = s.get_graph(pid)["graph"]
        assert next(n for n in g["nodes"] if n["id"] == "n-01-0")["slot"]["roleKey"] == "lead"
        assert s.list(pid)[0]["slots"][0]["role_key"] == "lead"

    def test_reset_builtin_drops_graph(self, tmp_path):
        s = self.store(tmp_path)
        s.apply_graph_ops("default", [{"op": "move_node", "id": "trigger", "position": {"x": 5, "y": 5}}])
        s.reset_builtin("default")
        assert s.get_graph("default")["derived"] is True


class TestRoleProperties:
    def test_properties_are_optional_validated_and_preserved(self, tmp_path):
        r = RolesStore(tmp_path / "roles.json")
        props = [
            {"name": "doneWhen", "type": "options", "default": "turnEnd", "options": [{"value": "turnEnd"}, {"value": "message"}]},
            {"name": "reportKey", "type": "string", "displayOptions": {"show": {"doneWhen": ["message"]}}},
        ]
        role = r.upsert(key="x", label="X", one_line="", system_prompt="p", properties=props)
        assert role["properties"] == props
        # properties=None keeps them
        assert r.upsert(key="x", label="X2", one_line="", system_prompt="p")["properties"] == props
        with pytest.raises(ValueError):
            r.upsert(key="y", label="Y", one_line="", system_prompt="p", properties=[{"name": "a", "type": "nope"}])
        with pytest.raises(ValueError):
            r.upsert(key="y", label="Y", one_line="", system_prompt="p",
                     properties=[{"name": "a", "type": "string", "displayOptions": {"show": {"b": "notalist"}}}])
        # A role without properties keeps the old shape exactly.
        assert "properties" not in r.upsert(key="z", label="Z", one_line="", system_prompt="p")
        all_roles = r.replace_all(r.list())
        assert next(x for x in all_roles if x["key"] == "x")["properties"] == props


class TestContractExtensions:
    def test_slot_params_round_trip_between_stages_and_graph(self):
        st = stage("01", ["plan"])
        st["slots"][0]["params"] = {"doneWhen": "message", "n": 2}
        g = pg.derive_graph_from_stages([st])
        assert g["nodes"][1]["slot"]["params"] == {"doneWhen": "message", "n": 2}
        assert pg.derive_stages_from_graph(g, [st]) == [st]

    def test_set_stage_meta_writes_onto_the_derived_stage(self, tmp_path):
        s = StagesStore(tmp_path / PIPELINES_FILE)
        out = s.apply_graph_ops("default", [
            {"op": "add_node", "node": slot_node("tail"), "after": [n for n in [
                nid for nid in [x["id"] for x in s.get_graph("default")["graph"]["nodes"]]] if n.startswith("n-")][-1:]},
        ])
        new_id = out["stages"][-1]["id"]
        out = s.apply_graph_ops("default", [{"op": "set_stage_meta", "stageId": new_id, "title": "Tail", "allowQuestions": True}])
        assert out["stages"][-1]["title"] == "Tail"
        assert out["stages"][-1]["allow_questions"] is True
        assert s.list("default")[-1]["title"] == "Tail"
        with pytest.raises(pg.GraphError):
            s.apply_graph_ops("default", [{"op": "set_stage_meta", "stageId": "nope", "title": "x"}])


class TestProjectNodeStates:
    def test_node_states_merge_reset_on_start_and_outputs_survive(self, tmp_path):
        from agent_team_backend.projects import Project, ProjectStore

        ws = str(tmp_path)
        store = ProjectStore()
        store.start_pipeline(ws, task_description="t", total_stages=1, stage_blueprint=[{"stage_id": "01", "slots": []}])
        store.record_node_states(ws, nodes={"a": {"status": "running"}}, gate={"nodeId": "g"},
                                 outputs={"a": {"summary": "done a"}})
        store.record_node_states(ws, nodes={"b": {"status": "done"}})
        p = ProjectStore().peek(ws)
        assert p.node_states == {"a": {"status": "running"}, "b": {"status": "done"}}
        assert p.node_gate == {"nodeId": "g"}
        store.start_pipeline(ws, task_description="t2", total_stages=1, stage_blueprint=[{"stage_id": "01", "slots": []}])
        p = ProjectStore().peek(ws)
        assert p.node_states == {} and p.node_gate == {}
        assert p.node_outputs == {"a": {"summary": "done a"}}
        # A project document written before these fields existed still loads.
        d = p.to_dict()
        for k in ("node_states", "node_gate", "node_outputs"):
            d.pop(k)
        assert Project.from_dict(d).node_outputs == {}


class TestTokensRunRecord:
    def test_run_record_carries_pipeline_outcome_and_node_states(self, tmp_path):
        from agent_team_backend.tokens_store import TokensStore

        ts = TokensStore(global_path=tmp_path / "tokens.json", workspace_base_dir=tmp_path / "workspaces")
        (tmp_path / "ws").mkdir()
        ws = str(tmp_path / "ws")
        ts.start_run(ws, run_id="r1", task="t", run_dir="runs/r1", pipeline_id="p1")
        ts.end_run(ws, outcome="failed", node_states={"a": {"status": "failed"}})
        run = ts.snapshot(ws)["workspace"]["runs"][-1]
        assert run["pipeline_id"] == "p1"
        assert run["outcome"] == "failed"
        assert run["node_states"] == {"a": {"status": "failed"}}
        # Old call shape still works and adds nothing.
        ts.start_run(ws, run_id="r2", task="t", run_dir="runs/r2")
        ts.end_run(ws)
        run2 = ts.snapshot(ws)["workspace"]["runs"][-1]
        assert "outcome" not in run2 and "pipeline_id" not in run2


def test_start_index_records_skipped_stages_as_completed(tmp_path):
    from agent_team_backend.projects import ProjectStore

    ws = str(tmp_path)
    store = ProjectStore()
    bp = [{"stage_id": sid, "slots": []} for sid in ("01", "02", "03")]
    store.start_pipeline(ws, task_description="t", total_stages=3, stage_blueprint=bp, start_index=2)
    assert [s.status for s in ProjectStore().peek(ws).stages] == ["completed", "completed", "pending"]
    _, nxt = store.resume_pipeline(ws)
    assert nxt == 2
    store.start_pipeline(ws, task_description="t", total_stages=3, stage_blueprint=bp)
    assert [s.status for s in ProjectStore().peek(ws).stages] == ["pending"] * 3


def test_paused_gate_survives_abort_and_resume_until_a_new_run(tmp_path):
    from agent_team_backend.projects import ProjectStore

    ws = str(tmp_path)
    store = ProjectStore()
    bp = [{"stage_id": "01", "slots": []}, {"stage_id": "02", "slots": []}]
    store.start_pipeline(ws, task_description="t", total_stages=2, stage_blueprint=bp)
    store.record_node_states(ws, nodes={}, gate={"gateId": "gate", "nextIndex": 1})
    store.abort_pipeline(ws)
    assert ProjectStore().peek(ws).node_gate == {"gateId": "gate", "nextIndex": 1}
    store.resume_pipeline(ws)
    assert ProjectStore().peek(ws).node_gate == {"gateId": "gate", "nextIndex": 1}
    store.start_pipeline(ws, task_description="t", total_stages=2, stage_blueprint=bp)
    assert ProjectStore().peek(ws).node_gate == {}
