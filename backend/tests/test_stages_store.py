"""Tests for the multi-pipeline StagesStore."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.stages_store import (
    StagesStore,
    default_stages,
    default_maintenance_stages,
    PIPELINES_FILE,
    STAGES_FILE,
)


# ── helpers ────────────────────────────────────────────────────────────────────

def make_store(tmp_path: Path, *, seed: dict | None = None) -> StagesStore:
    pipelines_file = tmp_path / PIPELINES_FILE
    store = StagesStore(pipelines_file)
    if seed is not None:
        pipelines_file.write_text(
            json.dumps(seed, indent=2, ensure_ascii=False), encoding="utf-8"
        )
    return store


def fresh_store(tmp_path: Path) -> StagesStore:
    return make_store(tmp_path)


# ── Phase A: data model + migration ───────────────────────────────────────────

class TestSeedDoc:
    def test_creates_two_builtin_pipelines(self, tmp_path):
        store = fresh_store(tmp_path)
        doc = store._read_doc()
        assert doc["version"] == 2
        ids = [p["id"] for p in doc["pipelines"]]
        assert "default" in ids
        assert "maintenance" in ids

    def test_default_pipeline_has_five_stages(self, tmp_path):
        store = fresh_store(tmp_path)
        stages = store.list("default")
        assert len(stages) == 6  # 01, 02, 03, 04, 04.5, 05

    def test_maintenance_pipeline_has_three_stages(self, tmp_path):
        store = fresh_store(tmp_path)
        stages = store.list("maintenance")
        assert len(stages) == 3

    def test_active_pipeline_defaults_to_default(self, tmp_path):
        store = fresh_store(tmp_path)
        assert store.get_active_pipeline_id() == "default"


class TestMigration:
    def test_migrates_legacy_flat_stages_json(self, tmp_path):
        # Write old stages.json (flat list) in the same dir as pipelines.json
        legacy = tmp_path / STAGES_FILE
        old_stages = default_stages()[:3]
        legacy.write_text(json.dumps(old_stages, ensure_ascii=False), encoding="utf-8")

        store = StagesStore(tmp_path / PIPELINES_FILE)
        stages = store.list("default")
        # Should have migrated old 3 stages into default pipeline
        assert len(stages) == 3

    def test_migration_retires_legacy_stages_file(self, tmp_path):
        legacy = tmp_path / STAGES_FILE
        old_stages = default_stages()[:2]
        legacy.write_text(json.dumps(old_stages, ensure_ascii=False), encoding="utf-8")

        store = StagesStore(tmp_path / PIPELINES_FILE)
        store.list()  # trigger migration

        assert not legacy.exists()
        assert (tmp_path / (STAGES_FILE + ".migrated-v1")).exists()
        # One-time only: a second instance keeps the migrated data.
        assert len(StagesStore(tmp_path / PIPELINES_FILE).list("default")) == 2

    def test_legacy_pipelines_json_imported_once_and_retired(self, tmp_path):
        legacy = tmp_path / PIPELINES_FILE
        doc = {
            "version": 2,
            "schemaVersion": 1,
            "active_pipeline_id": "custom",
            "pipelines": [
                {"id": "custom", "name": "Custom", "builtin": False,
                 "stages": default_stages()[:2]},
            ],
        }
        legacy.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")

        store = StagesStore(legacy)
        assert store.get_active_pipeline_id() == "custom"
        assert [s["id"] for s in store.list("custom")] == [
            s["id"] for s in default_stages()[:2]
        ]
        assert not legacy.exists()
        assert (tmp_path / (PIPELINES_FILE + ".migrated-v1")).exists()
        # Second instance re-reads the imported document.
        assert StagesStore(legacy).get_active_pipeline_id() == "custom"

    def test_handles_corrupt_file_gracefully(self, tmp_path):
        pipelines_file = tmp_path / PIPELINES_FILE
        pipelines_file.write_text("NOT JSON", encoding="utf-8")
        store = StagesStore(pipelines_file)
        # Should regenerate defaults, not raise
        stages = store.list()
        assert len(stages) > 0


# ── Pipeline CRUD ──────────────────────────────────────────────────────────────

class TestPipelineCRUD:
    def test_list_pipelines_returns_summaries(self, tmp_path):
        store = fresh_store(tmp_path)
        pipelines = store.list_pipelines()
        assert len(pipelines) >= 2
        for p in pipelines:
            assert {"id", "name", "builtin", "stage_count"} <= p.keys()

    def test_create_pipeline(self, tmp_path):
        store = fresh_store(tmp_path)
        p = store.create_pipeline("我的流程")
        assert p["name"] == "我的流程"
        assert p["builtin"] is False
        assert p["stage_count"] == 0
        ids = [x["id"] for x in store.list_pipelines()]
        assert p["id"] in ids

    def test_rename_pipeline(self, tmp_path):
        store = fresh_store(tmp_path)
        p = store.create_pipeline("舊名")
        store.rename_pipeline(p["id"], "新名")
        found = next(x for x in store.list_pipelines() if x["id"] == p["id"])
        assert found["name"] == "新名"

    def test_delete_any_pipeline(self, tmp_path):
        store = fresh_store(tmp_path)
        original_len = len(store.list_pipelines())
        remaining = store.delete_pipeline("maintenance")
        assert len(remaining) == original_len - 1
        assert not any(x["id"] == "maintenance" for x in remaining)

    def test_can_delete_builtin_pipeline(self, tmp_path):
        # Builtin pipelines are now deletable (only last one is protected)
        store = fresh_store(tmp_path)
        store.delete_pipeline("maintenance")  # should not raise
        assert not any(p["id"] == "maintenance" for p in store.list_pipelines())

    def test_cannot_delete_last_pipeline(self, tmp_path):
        # Manually seed with only one pipeline
        doc = {
            "version": 2,
            "active_pipeline_id": "solo",
            "pipelines": [{"id": "solo", "name": "Only", "builtin": False, "stages": []}],
            # The landing built-in was seeded once and deleted: it stays gone.
            "seeded_builtins": ["evolve-landing"],
        }
        store = make_store(tmp_path, seed=doc)
        with pytest.raises(ValueError, match="last"):
            store.delete_pipeline("solo")

    def test_delete_active_falls_back_to_default(self, tmp_path):
        store = fresh_store(tmp_path)
        p = store.create_pipeline("temp")
        store.set_active_pipeline(p["id"])
        assert store.get_active_pipeline_id() == p["id"]
        store.delete_pipeline(p["id"])
        assert store.get_active_pipeline_id() == "default"

    def test_set_active_pipeline(self, tmp_path):
        store = fresh_store(tmp_path)
        store.set_active_pipeline("maintenance")
        assert store.get_active_pipeline_id() == "maintenance"

    def test_set_active_unknown_raises(self, tmp_path):
        store = fresh_store(tmp_path)
        with pytest.raises(KeyError):
            store.set_active_pipeline("nonexistent")

    def test_reset_builtin_default(self, tmp_path):
        store = fresh_store(tmp_path)
        # Delete a stage from default
        store.delete("01", "default")
        assert len(store.list("default")) < 6
        # Reset
        store.reset_builtin("default")
        assert len(store.list("default")) == 6

    def test_reset_builtin_maintenance(self, tmp_path):
        store = fresh_store(tmp_path)
        store.delete("m01", "maintenance")
        assert len(store.list("maintenance")) == 2
        store.reset_builtin("maintenance")
        assert len(store.list("maintenance")) == 3

    def test_reset_non_builtin_raises(self, tmp_path):
        store = fresh_store(tmp_path)
        p = store.create_pipeline("test")
        with pytest.raises(ValueError, match="builtin"):
            store.reset_builtin(p["id"])


# ── Stage CRUD (pipeline-scoped) ──────────────────────────────────────────────

class TestStageCRUD:
    def test_list_uses_active_pipeline_by_default(self, tmp_path):
        store = fresh_store(tmp_path)
        # default active = "default" → 6 stages
        stages = store.list()
        assert len(stages) == 6

    def test_list_specific_pipeline(self, tmp_path):
        store = fresh_store(tmp_path)
        stages = store.list("maintenance")
        assert len(stages) == 3

    def test_upsert_creates_new_stage(self, tmp_path):
        store = fresh_store(tmp_path)
        p = store.create_pipeline("test")
        stage = {
            "id": "new-01",
            "title": "Test Stage",
            "short_title": "Test",
            "question": "?",
            "description": "",
            "recommended_roles": [],
            "sentinel": "---DONE---",
            "slots": [{"agent_key": "claude", "role_key": "", "label": "Test", "kickoff_body": "", "is_commander": False}],
        }
        result = store.upsert(stage, p["id"])
        assert result["id"] == "new-01"
        assert len(store.list(p["id"])) == 1

    def test_upsert_updates_existing_stage(self, tmp_path):
        store = fresh_store(tmp_path)
        # Update the first stage of default pipeline
        orig = store.list("default")[0]
        updated = {**orig, "title": "Updated Title"}
        result = store.upsert(updated, "default")
        assert result["title"] == "Updated Title"
        # Verify persisted
        assert store.list("default")[0]["title"] == "Updated Title"

    def test_delete_stage(self, tmp_path):
        store = fresh_store(tmp_path)
        before = len(store.list("default"))
        store.delete("01", "default")
        assert len(store.list("default")) == before - 1

    def test_delete_nonexistent_raises(self, tmp_path):
        store = fresh_store(tmp_path)
        with pytest.raises(KeyError):
            store.delete("NOPE", "default")

    def test_cannot_delete_last_stage(self, tmp_path):
        store = fresh_store(tmp_path)
        p = store.create_pipeline("single")
        stage = {
            "id": "only",
            "title": "Only",
            "short_title": "Only",
            "question": "?",
            "description": "",
            "recommended_roles": [],
            "sentinel": "---DONE---",
            "slots": [{"agent_key": "claude", "role_key": "", "label": "A", "kickoff_body": "", "is_commander": False}],
        }
        store.upsert(stage, p["id"])
        with pytest.raises(ValueError, match="last remaining stage"):
            store.delete("only", p["id"])

    def test_reorder_stages(self, tmp_path):
        store = fresh_store(tmp_path)
        ids = [s["id"] for s in store.list("default")]
        reversed_ids = list(reversed(ids))
        result = store.reorder(reversed_ids, "default")
        assert [s["id"] for s in result] == reversed_ids

    def test_reset_default_pipeline(self, tmp_path):
        store = fresh_store(tmp_path)
        store.delete("01", "default")
        store.reset("default")
        assert len(store.list("default")) == 6

    def test_stage_changes_dont_bleed_across_pipelines(self, tmp_path):
        store = fresh_store(tmp_path)
        before_maint = len(store.list("maintenance"))
        store.delete("01", "default")
        after_maint = len(store.list("maintenance"))
        assert before_maint == after_maint

    def test_unknown_pipeline_raises(self, tmp_path):
        store = fresh_store(tmp_path)
        with pytest.raises(KeyError, match="pipeline not found"):
            store.list("no-such-pipeline")


# ── Persistence ────────────────────────────────────────────────────────────────

class TestPersistence:
    def test_data_survives_reload(self, tmp_path):
        store1 = fresh_store(tmp_path)
        p = store1.create_pipeline("持久化測試")
        pid = p["id"]

        store2 = StagesStore(tmp_path / PIPELINES_FILE)
        ids = [x["id"] for x in store2.list_pipelines()]
        assert pid in ids

    def test_active_pipeline_survives_reload(self, tmp_path):
        store1 = fresh_store(tmp_path)
        store1.set_active_pipeline("maintenance")

        store2 = StagesStore(tmp_path / PIPELINES_FILE)
        assert store2.get_active_pipeline_id() == "maintenance"


# ── The "proposal landing" built-in (evolve S3) ───────────────────────────────

import copy  # noqa: E402

from agent_team_backend import pipeline_graph as pg  # noqa: E402
from agent_team_backend import stages_store as ss  # noqa: E402

LANDING = "evolve-landing"


def _main_seed_pipelines() -> list[dict]:
    """The two built-ins exactly as main seeds them."""
    return [
        {"id": "default", "name": "預設流程", "builtin": True, "stages": default_stages()},
        {"id": "maintenance", "name": "維護流程", "builtin": True, "stages": default_maintenance_stages()},
    ]


def _old_doc() -> dict:
    """A document an older build wrote: no landing built-in, a user edit, a custom pipeline."""
    pipelines = _main_seed_pipelines()
    pipelines[0]["name"] = "My flow"
    pipelines[0]["stages"] = pipelines[0]["stages"][:2]
    pipelines.append({"id": "mine", "name": "Mine", "builtin": False, "stages": default_stages()[:1]})
    return {"version": 2, "schemaVersion": 1, "active_pipeline_id": "mine", "pipelines": pipelines}


def _seed_kv(tmp_path: Path, doc: dict) -> StagesStore:
    store = fresh_store(tmp_path)
    store._db.kv_set("pipelines", doc, now=1)
    return store


def _landing(doc: dict) -> dict:
    return next(p for p in doc["pipelines"] if p["id"] == LANDING)


class TestEvolveLandingBuiltin:
    def test_a_fresh_document_keeps_main_seeds_and_adds_the_landing_builtin(self, tmp_path):
        doc = fresh_store(tmp_path)._read_doc()
        assert doc["pipelines"][:2] == _main_seed_pipelines()
        assert [p["id"] for p in doc["pipelines"]] == ["default", "maintenance", LANDING]
        assert doc["active_pipeline_id"] == "default"
        landing = _landing(doc)
        assert landing["builtin"] is True and landing["name"] == "提案落地流程"
        assert doc["seeded_builtins"] == [LANDING]

    def test_an_older_document_gains_only_the_landing_builtin_once(self, tmp_path):
        old = _old_doc()
        store = _seed_kv(tmp_path, copy.deepcopy(old))
        doc = store._read_doc()
        assert doc["pipelines"][:-1] == old["pipelines"]  # nothing else touched
        assert doc["active_pipeline_id"] == "mine"
        assert doc["pipelines"][-1]["id"] == LANDING
        stored = store._db.kv_get("pipelines")
        assert [p["id"] for p in stored["pipelines"]] == ["default", "maintenance", "mine", LANDING]
        # A second read writes nothing new.
        assert StagesStore(tmp_path / PIPELINES_FILE)._read_doc() == stored

    def test_a_deleted_landing_builtin_is_not_added_back(self, tmp_path):
        store = _seed_kv(tmp_path, _old_doc())
        store._read_doc()
        store.delete_pipeline(LANDING)
        again = StagesStore(tmp_path / PIPELINES_FILE)
        assert LANDING not in [p["id"] for p in again.list_pipelines()]
        # Like default and maintenance, which were never re-added either.
        again.delete_pipeline("maintenance")
        assert "maintenance" not in [p["id"] for p in StagesStore(tmp_path / PIPELINES_FILE).list_pipelines()]

    def test_an_imported_document_keeps_the_seeded_mark(self, tmp_path):
        store = _seed_kv(tmp_path, _old_doc())
        exported = store._read_doc()
        exported["pipelines"] = [p for p in exported["pipelines"] if p["id"] != LANDING]
        store.replace_document(exported)
        assert LANDING not in [p["id"] for p in StagesStore(tmp_path / PIPELINES_FILE).list_pipelines()]

    def test_a_newer_document_is_not_rewritten(self, tmp_path):
        newer = {**_old_doc(), "schemaVersion": ss.SCHEMA_VERSION + 1}
        store = _seed_kv(tmp_path, copy.deepcopy(newer))
        assert store._read_doc() == newer
        assert store._db.kv_get("pipelines") == newer

    def test_reset_builtin_drops_the_graph_of_main_seeds_and_keeps_the_landing_graph(self, tmp_path):
        store = fresh_store(tmp_path)
        doc = store._read_doc()
        for p in doc["pipelines"][:2]:
            p["graph"] = pg.derive_graph_from_stages(p["stages"])
            p["stages"] = p["stages"][:1]
        landing = _landing(doc)
        landing["stages"] = landing["stages"][:1]
        landing["graph"] = {"version": 1, "nodes": [], "edges": []}
        store._write_doc(doc)
        for pid in ("default", "maintenance"):
            store.reset_builtin(pid)
        store.reset_builtin(LANDING)
        after = store._read_doc()
        assert after["pipelines"][:2] == _main_seed_pipelines()  # graph gone, seed back
        seed = ss.default_evolve_landing_pipeline()
        assert _landing(after)["stages"] == seed["stages"] and _landing(after)["graph"] == seed["graph"]

    def test_the_landing_template_ends_at_the_users_gate(self):
        seed = ss.default_evolve_landing_pipeline()
        graph = seed["graph"]
        assert pg.validate_graph(graph) == []
        layers, _ = pg.layer_graph(graph)
        kinds = {n["id"]: n["kind"] for n in graph["nodes"]}
        assert [kinds[i] for layer in layers for i in layer] == ["slot", "slot", "slot", "gate"]
        assert pg.derive_stages_from_graph(graph, seed["stages"]) == seed["stages"]
        labels = [s["slots"][0]["label"] for s in seed["stages"]]
        assert labels == ["Implement", "Review", "CI check"]

    def test_the_landing_template_has_no_merge_publish_load_deliver_or_start_step(self):
        seed = ss.default_evolve_landing_pipeline()
        bodies = [slot["kickoff_body"] for s in seed["stages"] for slot in s["slots"]]
        text = "\n".join(bodies).lower()
        for tool in ("gh pr merge", "pipeline_start", "pipeline_gate", "gate_pass", "plugins_enable",
                     "skills_install", "skills_set_delivery", "scheduler_upsert", "marketplace_publish",
                     "git push --force", "gh run rerun"):
            assert tool not in text, tool
        ci = seed["stages"][2]["slots"][0]["kickoff_body"]
        assert "不要 rerun" in ci and "不要合併" in ci and "gh" in ci
        review = seed["stages"][1]["slots"][0]["kickoff_body"]
        assert "唯讀" in review

    def test_the_landing_builtin_is_never_made_active(self, tmp_path):
        store = _seed_kv(tmp_path, _old_doc())
        assert store.get_active_pipeline_id() == "mine"
        assert fresh_store(tmp_path / "x").get_active_pipeline_id() == "default"
