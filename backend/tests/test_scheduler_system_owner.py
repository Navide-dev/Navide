"""System-owned scheduler jobs (a workspace's self-evolution clock).

Guards two things: nobody but the owning feature can change such a job — not
an agent and not the user's window — and adding the "system" owner kind leaves
the existing user / pane / external owner and expiry semantics unchanged.
"""

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
from agent_team_backend.scheduler import JobInvalid, SchedulerService
from agent_team_backend.scheduler_store import SchedulerStore

NOW_S = 1_800_000_000.0


def _ctx(params: dict[str, str]) -> Any:
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def pane(pane_id: str) -> Any:
    return _ctx({"pane": pane_id, "t": plan_mcp_wiring.caller_token()})


def host() -> Any:
    return _ctx({"client": "host", "t": plan_mcp_auth.internal_token()})


class _Bridge:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []
        self.evolve: list[tuple[str, bool]] = []

    def has_window(self) -> bool:
        return True

    def still_queued(self, msg_key) -> bool:
        return False

    async def budget_limited(self, action) -> bool:
        return False

    async def deliver(self, action) -> dict:
        self.messages.append(action)
        return {"status": "ok", "msg_key": "k"}

    async def deliver_evolve(self, action, manual) -> dict:
        self.evolve.append((action["workspace"], manual))
        return {"status": "ok", "detail": "run started"}


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    agent_messaging._reset_for_test()
    db = Database(tmp_path / "navide.db")

    async def fake_broadcast(event: dict, *, exclude=None) -> None:
        pass

    monkeypatch.setattr(app_module, "broadcast", fake_broadcast)
    bridge = _Bridge()
    service = SchedulerService(SchedulerStore(db), clock=lambda: NOW_S, bridge=bridge)
    monkeypatch.setattr(sched_mod, "_service", service)
    ws = str(tmp_path / "proj")
    agent_messaging.register("a-1", "alpha", ws, "claude")
    yield SimpleNamespace(service=service, ws=ws, db=db, bridge=bridge)
    for task, _manual in list(service._runs.values()):  # noqa: SLF001
        task.cancel()
    db.close()
    agent_messaging._reset_for_test()


def evolve_job(ws: str, **extra: Any) -> dict[str, Any]:
    return {
        "name": "Self-evolution",
        "schedule": {"kind": "daily", "at": "09:00", "tz": "Asia/Taipei"},
        "action": {"kind": "evolve", "workspace": ws},
        **extra,
    }


async def put_system(env, **extra: Any) -> dict[str, Any]:
    owner = sched_mod.system_owner("evolve", env.ws)
    result = await env.service.system_put("evolve:test", evolve_job(env.ws, **extra), owner)
    assert result["ok"] is True, result
    return result["job"]


# ── the new owner kind ─────────────────────────────────────────────────────


async def test_system_job_records_its_owner_without_expiry(env) -> None:
    job = await put_system(env)
    owner = {"kind": "system", "feature": "evolve", "workspace": env.ws}
    assert job["id"] == "evolve:test"
    assert job["owner"] == owner and job["updated_by"] == owner
    assert "expires_at" not in job["owner"]
    assert job["owner_gone"] is False
    listed = await env.service.list()
    assert listed["limits"]["agent_enabled"] == 0  # not counted as an agent's


async def test_user_window_cannot_change_a_system_job(env) -> None:
    job = await put_system(env)
    answers = [
        await env.service.upsert({"id": job["id"], "name": "renamed"}),
        await env.service.set_enabled(job["id"], False),
        await env.service.run_now(job["id"]),
        await env.service.remove(job["id"]),
        await env.service.adopt(job["id"]),
        await env.service.keep(job["id"]),
    ]
    for answer in answers:
        assert answer["ok"] is False and answer["code"] == sched_mod.SYSTEM_JOB, answer
    stored = await env.service.store.get_job(job["id"])
    assert stored["name"] == "Self-evolution" and stored["enabled"] is True
    assert stored["owner"]["kind"] == "system"


@pytest.mark.parametrize("ctx", [lambda: pane("a-1"), host])
async def test_agents_cannot_change_a_system_job(env, ctx) -> None:
    job = await put_system(env)
    caller = ctx()
    answers = [
        await plan_mcp.scheduler_upsert({"id": job["id"], "name": "renamed"}, caller),
        await plan_mcp.scheduler_set_enabled(job["id"], False, caller),
        await plan_mcp.scheduler_run_now(job["id"], caller),
        await plan_mcp.scheduler_remove(job["id"], caller),
    ]
    for answer in answers:
        assert answer["ok"] is False and answer["code"] == sched_mod.SYSTEM_JOB, answer
    assert (await env.service.store.get_job(job["id"])) is not None


async def test_only_the_system_may_create_an_evolve_action(env) -> None:
    with pytest.raises(JobInvalid):
        await env.service.upsert(evolve_job(env.ws))
    answer = await plan_mcp.scheduler_upsert(evolve_job(env.ws), pane("a-1"))
    assert answer["ok"] is False
    assert (await env.service.list())["jobs"] == []


async def test_another_feature_or_workspace_cannot_take_it_over(env) -> None:
    job = await put_system(env)
    other = sched_mod.system_owner("evolve", env.ws + "-other")
    answer = await env.service.system_put(job["id"], evolve_job(env.ws, name="x"), other)
    assert answer["ok"] is False and answer["code"] == sched_mod.SYSTEM_JOB
    with pytest.raises(JobInvalid):
        await env.service.system_put("evolve:x", evolve_job(env.ws), {"kind": "user"})


async def test_system_put_toggles_and_keeps_the_id(env) -> None:
    job = await put_system(env)
    off = await put_system(env, enabled=False)
    assert off["id"] == job["id"] and off["enabled"] is False
    on = await put_system(env, enabled=True)
    assert on["enabled"] is True and on["state"]["next_run_at"] is not None
    assert len((await env.service.list())["jobs"]) == 1


async def test_system_job_never_expires_and_does_not_spend_agent_runs(env) -> None:
    job = await put_system(env)
    # Far past the agent expiry: the sweep leaves it enabled.
    later = NOW_S + (sched_mod.AGENT_EXPIRE_MS / 1000) * 3
    env.service.clock = lambda: later
    assert await env.service._sweep_agent_job(  # noqa: SLF001
        await env.service.store.get_job(job["id"]), int(later * 1000)
    ) is False
    stored = await env.service.store.get_job(job["id"])
    assert stored["enabled"] is True
    owner = sched_mod.system_owner("evolve", env.ws)
    answer = await env.service.run_now(job["id"], owner)
    assert answer["ok"] is True, answer
    task, _manual = env.service._runs[job["id"]]  # noqa: SLF001
    await task
    assert env.bridge.evolve == [(env.ws, True)]
    assert env.bridge.messages == []
    assert await env.service.store.usage(sched_mod._usage_day(int(later * 1000))) == 0  # noqa: SLF001


async def test_a_due_evolve_job_fires_through_deliver_evolve(env) -> None:
    job = await put_system(env)
    due = job["state"]["next_run_at"]
    env.service.clock = lambda: due / 1000 + 1
    await env.service.tick()
    task, manual = env.service._runs[job["id"]]  # noqa: SLF001
    await task
    assert manual is False and env.bridge.evolve == [(env.ws, False)]
    runs = (await env.service.runs(job["id"]))["runs"]
    assert runs[0]["status"] == "ok"


# ── existing semantics are untouched ───────────────────────────────────────


def test_is_agent_is_unchanged_for_existing_kinds() -> None:
    assert sched_mod.is_agent({"kind": "user"}) is False
    assert sched_mod.is_agent(None) is False
    assert sched_mod.is_agent({"kind": "pane", "pane_id": "p"}) is True
    assert sched_mod.is_agent({"kind": "external"}) is True
    assert sched_mod.is_agent({"kind": "user", "legacy": True}) is False
    assert sched_mod.is_agent({"kind": "system", "feature": "evolve"}) is False


def test_may_change_is_unchanged_for_existing_kinds() -> None:
    user_job = {"owner": {"kind": "user"}}
    external_job = {"owner": {"kind": "external"}}
    assert sched_mod.may_change({"kind": "user"}, user_job) is True
    assert sched_mod.may_change({"kind": "user"}, external_job) is True
    assert sched_mod.may_change({"kind": "external"}, external_job) is True
    assert sched_mod.may_change({"kind": "external"}, user_job) is False
    # A system actor gets no rights over anyone else's job.
    system = sched_mod.system_owner("evolve", "/w")
    assert sched_mod.may_change(system, user_job) is False
    assert sched_mod.may_change(system, external_job) is False


async def test_agent_job_still_expires_and_user_job_still_does_not(env) -> None:
    agent = (await plan_mcp.scheduler_upsert({
        "name": "report", "schedule": {"kind": "every", "every_ms": 600_000},
        "action": {"kind": "message", "workspace": env.ws, "pane_name": "alpha", "text": "go"},
    }, pane("a-1")))["job"]
    assert agent["owner"]["expires_at"] == int(NOW_S * 1000) + sched_mod.AGENT_EXPIRE_MS
    user = (await env.service.upsert({
        "name": "mine", "schedule": {"kind": "every", "every_ms": 600_000},
        "action": {"kind": "message", "workspace": env.ws, "pane_name": "alpha", "text": "go"},
    }))["job"]
    assert user["owner"] == {"kind": "user"}
    # The user can still adopt and keep an agent's job.
    assert (await env.service.keep(agent["id"]))["ok"] is True
    assert (await env.service.adopt(agent["id"]))["ok"] is True
