"""Scheduler jobs that start a pipeline run (p3-scheduler).

The job goes the way MCP pipeline_start goes (ui.pipeline.start in the window
holding the workspace) and never opens a window: with none, the run is an
error that says why, not a silent skip.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app as app_module
from agent_team_backend import scheduler as sched_mod
from agent_team_backend.mcp_server import server as mcp
from agent_team_backend.scheduler import JobInvalid, LiveBridge, normalize_job, resolve_pipeline

from .test_scheduler_service import MINUTE, Bridge, env, runs, settle, state  # noqa: F401

NOW = 1_800_000_000_000


def pipeline_job(**action) -> dict:
    base = {"kind": "pipeline_start", "workspace": "/ws", "pipeline_name": "Nightly", "task": "refresh the report"}
    base.update(action)
    return {"name": "nightly", "schedule": {"kind": "every", "every_ms": 10 * MINUTE}, "action": base}


class PipelineBridge(Bridge):
    def __init__(self) -> None:
        super().__init__()
        self.started: list[dict[str, Any]] = []
        self.pipeline_outcome: dict[str, Any] = {"status": "ok", "detail": "started"}

    async def deliver_pipeline(self, action: dict[str, Any]) -> dict[str, Any]:
        self.started.append(action)
        return self.pipeline_outcome


class TestValidation:
    def test_needs_exactly_one_of_id_or_name(self) -> None:
        job = normalize_job(pipeline_job(), None, NOW)
        assert job["action"] == {"kind": "pipeline_start", "workspace": "/ws", "pipeline_name": "Nightly", "task": "refresh the report"}
        for bad in ({"pipeline_id": "p1"}, {"pipeline_name": ""}):
            raw = pipeline_job(**bad)
            if "pipeline_id" in bad:
                with pytest.raises(JobInvalid, match="exactly one of pipeline_id or pipeline_name"):
                    normalize_job(raw, None, NOW)
            else:
                with pytest.raises(JobInvalid, match="exactly one"):
                    normalize_job(raw, None, NOW)

    def test_needs_a_task_and_a_workspace(self) -> None:
        with pytest.raises(JobInvalid, match="action.task"):
            normalize_job(pipeline_job(task=""), None, NOW)
        with pytest.raises(JobInvalid, match="action.workspace"):
            normalize_job(pipeline_job(workspace=""), None, NOW)

    def test_unknown_kind_names_both_kinds(self) -> None:
        with pytest.raises(JobInvalid, match='"message" or "pipeline_start"'):
            normalize_job(pipeline_job(kind="nope"), None, NOW)


def test_resolve_pipeline_by_id_or_unique_exact_name() -> None:
    pipelines = [{"id": "p1", "name": "Nightly"}, {"id": "p2", "name": "Dup"}, {"id": "p3", "name": "Dup"}]
    assert resolve_pipeline(pipelines, {"pipeline_id": "p2"}) == ("p2", "")
    assert resolve_pipeline(pipelines, {"pipeline_name": "Nightly"}) == ("p1", "")
    assert resolve_pipeline(pipelines, {"pipeline_id": "zz"})[1] == 'no pipeline has id "zz"'
    assert resolve_pipeline(pipelines, {"pipeline_name": "nightly"})[1] == 'no pipeline is named "nightly"'
    assert "2 pipelines are named" in resolve_pipeline(pipelines, {"pipeline_name": "Dup"})[1]


async def test_a_due_job_starts_the_pipeline_even_with_no_window(env) -> None:  # noqa: F811
    bridge = PipelineBridge()
    bridge.window = False
    bridge.pipeline_outcome = {"status": "error", "reason": "no_window", "detail": "no Navide window has /ws open"}
    env["bridge"] = bridge
    async def no_sleep(seconds: float) -> None:
        pass

    async def no_notify(jobs: list) -> None:
        pass

    service = sched_mod.SchedulerService(
        env["make"]().store, clock=env["clock"], sleep=no_sleep, bridge=bridge, notify=no_notify
    )
    job = (await service.upsert(pipeline_job()))["job"]
    env["clock"].advance_ms(10 * MINUTE)
    await service.tick()
    await settle(service)
    assert len(bridge.started) == 1 and bridge.delivered == []
    st = await state(service, job["id"])
    # An error, not a skip: the job says why it did not run.
    assert st["last_status"] == "error"
    assert st["last_error"] == "no Navide window has /ws open"
    assert [(r["status"], r["reason"]) for r in await runs(service, job["id"])] == [("error", "no_window")]


@pytest.fixture
def live(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    calls = SimpleNamespace(probe=True, probed=[], started=[], answer={"ok": True, "result": {"state": "running"}})
    monkeypatch.setattr(
        app_module, "stages_store",
        SimpleNamespace(list_pipelines=lambda: [{"id": "p1", "name": "Nightly"}, {"id": "p2", "name": "Dup"}, {"id": "p3", "name": "Dup"}]),
        raising=False,
    )

    async def probe(workspace: str, timeout: float) -> bool:
        calls.probed.append(workspace)
        return calls.probe

    async def start(caller, workspace, task, pipeline_id, *, taint_detail=""):
        calls.started.append({"caller": caller.kind, "workspace": workspace, "task": task, "pipeline_id": pipeline_id, "taint": taint_detail})
        return calls.answer

    monkeypatch.setattr(mcp, "_probe_window", probe)
    monkeypatch.setattr(mcp, "_start_pipeline_run", start)
    return calls


async def test_live_bridge_starts_the_run_through_pipeline_starts_path(live) -> None:
    action = {**pipeline_job()["action"], sched_mod.TAINT_KEY: "scheduled by worker"}
    outcome = await LiveBridge().deliver_pipeline(action)
    assert outcome == {"status": "ok", "detail": 'started pipeline "p1"'}
    assert live.started == [{"caller": "host", "workspace": "/ws", "task": "refresh the report", "pipeline_id": "p1", "taint": "scheduled by worker"}]


async def test_live_bridge_never_opens_a_window(live) -> None:
    live.probe = False
    outcome = await LiveBridge().deliver_pipeline(pipeline_job()["action"])
    assert outcome["status"] == "error" and outcome["reason"] == "no_window"
    assert "never opens one" in outcome["detail"]
    assert live.started == []


async def test_live_bridge_reports_an_unknown_or_ambiguous_pipeline(live) -> None:
    for name, why in (("Gone", 'no pipeline is named "Gone"'), ("Dup", "2 pipelines are named")):
        outcome = await LiveBridge().deliver_pipeline(pipeline_job(pipeline_name=name)["action"])
        assert outcome["status"] == "error" and outcome["reason"] == "pipeline_not_found"
        assert why in outcome["detail"]
    assert live.started == [] and live.probed == []


async def test_live_bridge_reports_a_refused_start(live) -> None:
    live.answer = {"ok": False, "result": None, "error": "a run is already going", "error_code": "ui_failed"}
    outcome = await LiveBridge().deliver_pipeline(pipeline_job()["action"])
    assert outcome == {"status": "error", "reason": "ui_failed", "detail": "a run is already going"}


async def test_an_agent_job_carries_its_taint_to_the_run(env) -> None:  # noqa: F811
    job = normalize_job(pipeline_job(), None, NOW)
    job["owner"] = {"kind": "pane", "pane_id": "p-9", "pane_name": "worker", "workspace": "/ws"}
    assert sched_mod._with_origin(job)[sched_mod.TAINT_KEY] == "scheduled by worker"  # noqa: SLF001
