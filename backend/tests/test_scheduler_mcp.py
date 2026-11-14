"""The scheduler_* MCP tools: registered, backed by the one SchedulerService the
WS handlers use, sharing its validator, and announcing every mutation."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend import app as app_module
from agent_team_backend import scheduler as sched_mod
from agent_team_backend.db import Database
from agent_team_backend.mcp_server import auth as plan_mcp_auth
from agent_team_backend.mcp_server import server as plan_mcp
from agent_team_backend.mcp_server import wiring as plan_mcp_wiring
from agent_team_backend.scheduler import SchedulerService
from agent_team_backend.scheduler_store import SchedulerStore


def _host_ctx() -> Any:
    params = {"client": "host", "t": plan_mcp_auth.internal_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _pane_ctx(pane_id: str) -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


class _Bridge:
    def __init__(self) -> None:
        self.delivered: list = []

    def has_window(self) -> bool:
        return True

    def still_queued(self, msg_key) -> bool:
        return False

    async def budget_limited(self, action) -> bool:
        return False

    async def deliver(self, action) -> dict:
        self.delivered.append(action)
        return {"status": "ok", "msg_key": "k"}


@pytest.fixture
def wired(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    agent_messaging._reset_for_test()
    db = Database(tmp_path / "navide.db")
    events: list = []

    async def fake_broadcast(event: dict, *, exclude=None) -> None:
        events.append(event)

    monkeypatch.setattr(app_module, "broadcast", fake_broadcast)
    bridge = _Bridge()
    service = SchedulerService(SchedulerStore(db), clock=lambda: 1_800_000_000.0, bridge=bridge)
    monkeypatch.setattr(sched_mod, "_service", service)
    yield {"service": service, "events": events, "bridge": bridge}
    db.close()
    agent_messaging._reset_for_test()


JOB = {
    "name": "report",
    # An agent's job may not run more often than every 5 minutes.
    "schedule": {"kind": "every", "every_ms": 600_000},
    "action": {"kind": "message", "workspace": "/ws", "pane_name": "report", "text": "go"},
}


def changed(events: list) -> list:
    return [e for e in events if e["type"] == "scheduler.changed"]


async def test_tools_are_registered_with_their_arguments() -> None:
    tools = {tool.name: tool for tool in await plan_mcp.server.list_tools()}
    expected = {
        "scheduler_list": set(),
        "scheduler_upsert": {"job"},
        "scheduler_remove": {"id"},
        "scheduler_set_enabled": {"id", "enabled"},
        "scheduler_run_now": {"id"},
        "scheduler_runs": {"id", "limit"},
    }
    for name, args in expected.items():
        assert name in tools, name
        assert set(tools[name].inputSchema.get("properties") or {}) == args
    assert "24" in (tools["scheduler_upsert"].description or "")


async def test_tools_drive_the_same_service_and_announce_changes(wired) -> None:
    ctx = _host_ctx()
    created = await plan_mcp.scheduler_upsert(JOB, ctx)
    assert created["ok"] is True
    job_id = created["job"]["id"]
    # Visible through the WS-side service, i.e. the same instance.
    assert [j["id"] for j in (await wired["service"].list())["jobs"]] == [job_id]
    listed = await plan_mcp.scheduler_list(ctx)
    assert listed["ok"] is True and listed["jobs"][0]["id"] == job_id and listed["now"]
    assert len(changed(wired["events"])) == 1

    assert await plan_mcp.scheduler_set_enabled(job_id, False, ctx) == {"ok": True}
    assert len(changed(wired["events"])) == 2

    assert await plan_mcp.scheduler_run_now(job_id, ctx) == {"ok": True, "enqueued": True}
    for task, _manual in list(wired["service"]._runs.values()):  # noqa: SLF001
        await task
    assert len(wired["bridge"].delivered) == 1
    runs = await plan_mcp.scheduler_runs(job_id, ctx)
    assert runs["ok"] is True and runs["runs"][0]["status"] == "ok"

    before = len(changed(wired["events"]))
    assert await plan_mcp.scheduler_remove(job_id, ctx) == {"ok": True}
    assert len(changed(wired["events"])) == before + 1
    assert (await plan_mcp.scheduler_remove(job_id, ctx))["ok"] is False


@pytest.mark.parametrize(
    "job",
    [
        {**JOB, "schedule": {"kind": "cron"}},
        {**JOB, "action": {"kind": "spawn", "workspace": "/ws", "agent": "claude", "prompt": "x"}},
        {**JOB, "id": "no-such-job"},
        {**JOB, "name": ""},
    ],
)
async def test_validation_errors_come_back_as_ok_false(wired, job) -> None:
    result = await plan_mcp.scheduler_upsert(job, _host_ctx())
    assert result["ok"] is False and result["error"]
    assert changed(wired["events"]) == []
    assert (await wired["service"].list())["jobs"] == []


async def test_host_caller_must_name_workspace_and_target(wired) -> None:
    job = {**JOB, "action": {"kind": "message", "text": "go"}}
    result = await plan_mcp.scheduler_upsert(job, _host_ctx())
    assert result["ok"] is False


async def test_pane_caller_defaults_to_its_own_pane(wired, tmp_path) -> None:
    ws = str(tmp_path)
    agent_messaging.register("me-1", "planner", ws, "claude")
    job = {**JOB, "action": {"kind": "message", "text": "wake up and continue"}}
    result = await plan_mcp.scheduler_upsert(job, _pane_ctx("me-1"))
    assert result["ok"] is True
    action = result["job"]["action"]
    assert action == {
        "kind": "message", "workspace": ws, "pane_id": "me-1",
        "pane_name": "planner", "text": "wake up and continue",
    }


async def test_pane_caller_keeps_an_explicit_target(wired, tmp_path) -> None:
    ws = str(tmp_path)
    agent_messaging.register("me-1", "planner", ws, "claude")
    job = {**JOB, "action": {"kind": "message", "pane_name": "report", "text": "go"}}
    result = await plan_mcp.scheduler_upsert(job, _pane_ctx("me-1"))
    assert result["job"]["action"] == {
        "kind": "message", "workspace": ws, "pane_name": "report", "text": "go",
    }


async def test_unwired_caller_is_refused(wired) -> None:
    ctx = SimpleNamespace(request_context=SimpleNamespace(request=None))
    assert (await plan_mcp.scheduler_list(ctx))["ok"] is False


async def test_update_sends_only_what_changes(wired) -> None:
    ctx = _host_ctx()
    created = (await plan_mcp.scheduler_upsert(
        {**JOB, "policy": {"max_runs_per_day": 5}}, ctx
    ))["job"]
    updated = await plan_mcp.scheduler_upsert(
        {"id": created["id"], "policy": {"catch_up": "skip"}}, ctx
    )
    assert updated["ok"] is True
    job = updated["job"]
    assert job["name"] == created["name"] and job["action"] == created["action"]
    assert job["schedule"] == created["schedule"]
    assert job["policy"] == {"catch_up": "skip", "max_runs_per_day": 5, "timeout_s": 1800}
    assert job["state"]["next_run_at"] == created["state"]["next_run_at"]


async def test_wake_me_in_an_hour_is_a_once_job(wired, tmp_path) -> None:
    tools = {tool.name: tool for tool in await plan_mcp.server.list_tools()}
    doc = tools["scheduler_upsert"].description or ""
    assert '{kind: "once", in_ms: 3600000}' in doc and "disables itself" in doc
    agent_messaging.register("me-1", "planner", str(tmp_path), "claude")
    job = {
        "name": "resume",
        "schedule": {"kind": "once", "in_ms": 3_600_000},
        "action": {"kind": "message", "text": "wake up and continue"},
    }
    result = await plan_mcp.scheduler_upsert(job, _pane_ctx("me-1"))
    assert result["ok"] is True
    assert result["job"]["schedule"] == {"kind": "once", "at_ms": 1_800_000_000_000 + 3_600_000}


async def _job_in(workspace: str, wired) -> dict:
    """A host-created job aimed at `workspace`, with a run and an error on record."""
    ctx = _host_ctx()
    job = {**JOB, "action": {"kind": "message", "workspace": workspace,
                              "pane_name": "report", "text": "secret client path /c/x"}}
    created = (await plan_mcp.scheduler_upsert(job, ctx))["job"]
    await plan_mcp.scheduler_run_now(created["id"], ctx)
    for task, _manual in list(wired["service"]._runs.values()):  # noqa: SLF001
        await task
    stored = await wired["service"].store.get_job(created["id"])
    await wired["service"].store.set_state(
        created["id"], {**stored["state"], "last_error": "failed in /c/x"}
    )
    return created


async def test_pane_sees_its_own_workspace_jobs_in_full(wired, tmp_path) -> None:
    ws = str(tmp_path / "a")
    agent_messaging.register("me-1", "planner", ws, "claude")
    created = await _job_in(ws, wired)
    [job] = (await plan_mcp.scheduler_list(_pane_ctx("me-1")))["jobs"]
    assert "redacted" not in job
    assert job["action"]["text"] == "secret client path /c/x"
    assert job["action"]["pane_name"] == "report"
    assert job["state"]["last_error"] == "failed in /c/x"
    runs = await plan_mcp.scheduler_runs(created["id"], _pane_ctx("me-1"))
    assert runs["ok"] is True and len(runs["runs"]) == 1


async def test_pane_sees_another_workspace_job_as_metadata_only(wired, tmp_path) -> None:
    agent_messaging.register("me-1", "planner", str(tmp_path / "a"), "claude")
    other = str(tmp_path / "b")
    created = await _job_in(other, wired)
    [job] = (await plan_mcp.scheduler_list(_pane_ctx("me-1")))["jobs"]
    assert job["redacted"] is True
    assert job["id"] == created["id"] and job["name"] == "report" and job["enabled"] is True
    assert job["schedule"] == created["schedule"] and job["owner"] == created["owner"]
    assert job["editable"] is False
    assert job["action"] == {"kind": "message", "workspace": other}
    assert "last_error" not in job["state"] and "last_msg_key" not in job["state"]
    assert job["state"]["last_status"] == "ok"
    assert "/c/x" not in repr(job)


async def test_pane_may_not_read_another_workspace_job_runs(wired, tmp_path) -> None:
    agent_messaging.register("me-1", "planner", str(tmp_path / "a"), "claude")
    created = await _job_in(str(tmp_path / "b"), wired)
    runs = await plan_mcp.scheduler_runs(created["id"], _pane_ctx("me-1"))
    assert runs["ok"] is False and runs["code"] == "SCHEDULER_CROSS_WORKSPACE"
    assert "runs" not in runs


async def test_host_caller_still_sees_every_job_in_full(wired, tmp_path) -> None:
    agent_messaging.register("me-1", "planner", str(tmp_path / "a"), "claude")
    created = await _job_in(str(tmp_path / "b"), wired)
    [job] = (await plan_mcp.scheduler_list(_host_ctx()))["jobs"]
    assert "redacted" not in job
    assert job["action"]["text"] == "secret client path /c/x"
    assert job["state"]["last_error"] == "failed in /c/x"
    runs = await plan_mcp.scheduler_runs(created["id"], _host_ctx())
    assert runs["ok"] is True and len(runs["runs"]) == 1
