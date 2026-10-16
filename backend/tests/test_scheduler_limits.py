"""Limits on agent-owned scheduler jobs, under a fake clock. The user's own jobs
are never limited."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend import app as app_module
from agent_team_backend import scheduler as sched_mod
from agent_team_backend.db import Database
from agent_team_backend.mcp_server import server as plan_mcp
from agent_team_backend.mcp_server import wiring as plan_mcp_wiring
from agent_team_backend.scheduler import (
    AGENT_ENABLED_PER_OWNER,
    AGENT_ENABLED_TOTAL,
    AGENT_EXPIRE_MS,
    AGENT_ONCE_KEEP_MS,
    AGENT_RUNS_PER_DAY_TOTAL,
    SchedulerService,
    _usage_day,
)
from agent_team_backend.scheduler_store import SchedulerStore

T0 = 1_800_000_000.0
MINUTE = 60_000
DAY = 86_400_000


class Clock:
    def __init__(self) -> None:
        self.t = T0

    def __call__(self) -> float:
        return self.t

    def advance_ms(self, ms: int) -> None:
        self.t += ms / 1000


class Bridge:
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
        return {"status": "ok", "msg_key": None}


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    agent_messaging._reset_for_test()
    db = Database(tmp_path / "navide.db")

    async def fake_broadcast(event: dict, *, exclude=None) -> None:
        pass

    monkeypatch.setattr(app_module, "broadcast", fake_broadcast)
    clock = Clock()
    bridge = Bridge()
    service = SchedulerService(SchedulerStore(db), clock=clock, bridge=bridge)
    monkeypatch.setattr(sched_mod, "_service", service)
    ws = str(tmp_path / "proj")
    yield SimpleNamespace(service=service, clock=clock, bridge=bridge, ws=ws, db=db)
    for task, _manual in list(service._runs.values()):  # noqa: SLF001
        task.cancel()
    db.close()
    agent_messaging._reset_for_test()


def agent(env, pane_id: str) -> dict[str, Any]:
    if agent_messaging.get(pane_id) is None:
        agent_messaging.register(pane_id, pane_id, env.ws, "claude")
    return {"kind": "pane", "pane_id": pane_id, "pane_name": pane_id, "workspace": env.ws}


def job(env, **extra: Any) -> dict[str, Any]:
    return {
        "name": "j",
        "schedule": {"kind": "every", "every_ms": 10 * MINUTE},
        "action": {"kind": "message", "workspace": env.ws, "pane_name": "p", "text": "go"},
        **extra,
    }


async def settle(env) -> None:
    for task, _manual in list(env.service._runs.values()):  # noqa: SLF001
        await task


async def fill_usage(env, runs: int) -> None:
    for _ in range(runs):
        await env.service.store.add_usage(_usage_day(env.service.now_ms()))


async def test_each_agent_may_have_ten_enabled_jobs(env) -> None:
    me = agent(env, "a")
    for _ in range(AGENT_ENABLED_PER_OWNER):
        assert (await env.service.upsert(job(env), me))["ok"] is True
    refused = await env.service.upsert(job(env), me)
    assert refused == {
        "ok": False, "code": "SCHEDULER_LIMIT", "limit": "per_owner_enabled",
        "max": 10, "used": 10, "error": refused["error"],
    }
    # A disabled job is not counted, but enabling it is checked.
    parked = (await env.service.upsert(job(env, enabled=False), me))["job"]
    again = await env.service.set_enabled(parked["id"], True, me)
    assert again["code"] == "SCHEDULER_LIMIT" and again["limit"] == "per_owner_enabled"
    assert (await env.service.upsert({"id": parked["id"], "enabled": True}, me))["limit"] == (
        "per_owner_enabled"
    )
    # Another agent has its own ten.
    assert (await env.service.upsert(job(env), agent(env, "b")))["ok"] is True
    # Freeing one makes room. Under the frozen clock every job shares one
    # created_at, so list order falls to the random id: pick one of a's own
    # enabled jobs rather than whichever job happens to sort first.
    first = next(
        j for j in (await env.service.list())["jobs"]
        if j["enabled"] and j["owner"]["pane_id"] == "a"
    )
    assert (await env.service.set_enabled(first["id"], False, me))["ok"] is True
    assert (await env.service.set_enabled(parked["id"], True, me)) == {"ok": True}


async def test_agents_may_have_a_hundred_enabled_jobs_between_them(env) -> None:
    for n in range(AGENT_ENABLED_TOTAL // AGENT_ENABLED_PER_OWNER):
        me = agent(env, f"p{n}")
        for _ in range(AGENT_ENABLED_PER_OWNER):
            assert (await env.service.upsert(job(env), me))["ok"] is True
    refused = await env.service.upsert(job(env), agent(env, "late"))
    assert refused["code"] == "SCHEDULER_LIMIT" and refused["limit"] == "global_enabled"
    assert (refused["max"], refused["used"]) == (100, 100)
    # The user's jobs neither count nor are limited.
    for _ in range(3):
        assert (await env.service.upsert(job(env)))["ok"] is True
    listed = await env.service.list()
    assert listed["limits"]["agent_enabled"] == 100
    # The user may still enable an agent's job past the limit.
    parked = (await env.service.upsert(job(env, enabled=False), agent(env, "late2")))["job"]
    assert (await env.service.set_enabled(parked["id"], True)) == {"ok": True}


async def test_agent_interval_and_daily_cap_bounds(env) -> None:
    me = agent(env, "a")
    too_fast = await env.service.upsert(
        job(env, schedule={"kind": "every", "every_ms": 5 * MINUTE - 1}), me
    )
    assert too_fast["code"] == "SCHEDULER_LIMIT" and too_fast["limit"] == "min_every_ms"
    assert (too_fast["max"], too_fast["used"]) == (300_000, 299_999)
    ok = await env.service.upsert(job(env, schedule={"kind": "every", "every_ms": 5 * MINUTE}), me)
    assert ok["ok"] is True
    # The same bound applies to an update.
    faster = await env.service.upsert(
        {"id": ok["job"]["id"], "schedule": {"kind": "every", "every_ms": MINUTE}}, me
    )
    assert faster["limit"] == "min_every_ms"
    greedy = await env.service.upsert(job(env, policy={"max_runs_per_day": 289}), me)
    assert (greedy["limit"], greedy["max"], greedy["used"]) == ("max_runs_per_day", 288, 289)
    assert (await env.service.upsert(job(env, policy={"max_runs_per_day": 288}), me))["ok"] is True


async def test_users_jobs_have_no_limits(env) -> None:
    fast = job(env, schedule={"kind": "every", "every_ms": MINUTE}, policy={"max_runs_per_day": 1440})
    for _ in range(AGENT_ENABLED_PER_OWNER + 1):
        assert (await env.service.upsert(fast))["ok"] is True
    user_job = (await env.service.list())["jobs"][0]
    assert "expires_at" not in user_job["owner"]
    await fill_usage(env, AGENT_RUNS_PER_DAY_TOTAL)
    assert await env.service.run_now(user_job["id"]) == {"ok": True, "enqueued": True}
    await settle(env)
    # Scheduled runs of the user's job are not held back by the agents' total.
    env.clock.advance_ms(MINUTE)
    await env.service.tick()
    await settle(env)
    runs = (await env.service.runs(user_job["id"]))["runs"]
    assert [r["status"] for r in runs] == ["ok", "ok"]
    assert await env.service.store.usage(_usage_day(env.service.now_ms())) == 300


async def test_agent_runs_share_a_daily_total_including_run_now(env) -> None:
    me = agent(env, "a")
    mine = (await env.service.upsert(job(env), me))["job"]
    await fill_usage(env, AGENT_RUNS_PER_DAY_TOTAL - 1)
    # The 300th run is allowed and counted…
    assert await env.service.run_now(mine["id"], me) == {"ok": True, "enqueued": True}
    await settle(env)
    assert (await env.service.list())["limits"]["agent_runs_today"] == 300
    # …the 301st is refused.
    refused = await env.service.run_now(mine["id"], me)
    assert refused == {
        "ok": False, "code": "SCHEDULER_LIMIT", "limit": "agent_runs_per_day",
        "max": 300, "used": 300, "error": refused["error"],
    }
    # A scheduled slot of an agent's job is skipped as budget_global.
    env.clock.advance_ms(10 * MINUTE)
    await env.service.tick()
    await settle(env)
    runs = (await env.service.runs(mine["id"]))["runs"]
    assert runs[0]["status"] == "skipped" and runs[0]["reason"] == "budget_global"
    # The user may still run it, and that is not counted.
    assert (await env.service.run_now(mine["id"]))["ok"] is True
    await settle(env)
    assert await env.service.store.usage(_usage_day(env.service.now_ms())) == 300
    # The total starts again the next day.
    env.clock.advance_ms(DAY)
    assert (await env.service.run_now(mine["id"], me))["ok"] is True
    await settle(env)
    assert await env.service.store.usage(_usage_day(env.service.now_ms())) == 1


async def test_scheduled_agent_runs_are_counted(env) -> None:
    mine = (await env.service.upsert(job(env), agent(env, "a")))["job"]
    user_job = (await env.service.upsert(job(env)))["job"]
    env.clock.advance_ms(10 * MINUTE)
    await env.service.tick()
    await settle(env)
    assert await env.service.store.usage(_usage_day(env.service.now_ms())) == 1
    assert {mine["id"], user_job["id"]} == {j["id"] for j in (await env.service.list())["jobs"]}


async def test_deleting_a_job_does_not_reset_the_total(env) -> None:
    me = agent(env, "a")
    mine = (await env.service.upsert(job(env), me))["job"]
    await env.service.run_now(mine["id"], me)
    await settle(env)
    await env.service.remove(mine["id"], me)
    assert await env.service.store.usage(_usage_day(env.service.now_ms())) == 1


async def test_agent_periodic_job_expires_after_seven_days(env) -> None:
    me = agent(env, "a")
    mine = (await env.service.upsert(job(env, schedule={"kind": "daily", "at": "03:00", "tz": "UTC"}), me))["job"]
    assert mine["owner"]["expires_at"] == env.service.now_ms() + AGENT_EXPIRE_MS
    env.clock.advance_ms(AGENT_EXPIRE_MS - 1)
    await env.service.tick()
    await settle(env)
    assert (await env.service.store.get_job(mine["id"]))["enabled"] is True
    env.clock.advance_ms(1)
    await env.service.tick()
    stored = await env.service.store.get_job(mine["id"])
    assert stored["enabled"] is False and stored["state"]["last_skip_reason"] == "expired"
    assert (await env.service.runs(mine["id"]))["runs"][0]["reason"] == "expired"
    # Re-enabling gives it another seven days.
    assert await env.service.set_enabled(mine["id"], True, me) == {"ok": True}
    stored = await env.service.store.get_job(mine["id"])
    assert stored["owner"]["expires_at"] == env.service.now_ms() + AGENT_EXPIRE_MS
    assert stored["owner"]["pane_id"] == "a"


async def test_owner_saving_renews_and_keep_stops_expiry(env) -> None:
    me = agent(env, "a")
    mine = (await env.service.upsert(job(env), me))["job"]
    env.clock.advance_ms(DAY)
    renewed = (await env.service.upsert({"id": mine["id"], "name": "renamed"}, me))["job"]
    assert renewed["owner"]["expires_at"] == env.service.now_ms() + AGENT_EXPIRE_MS
    # A window edit does not renew it.
    edited = (await env.service.upsert({"id": mine["id"], "name": "by user"}))["job"]
    assert edited["owner"]["expires_at"] == renewed["owner"]["expires_at"]
    kept = await env.service.keep(mine["id"])
    assert kept["ok"] is True and kept["job"]["owner"]["expires_at"] is None
    assert kept["job"]["owner"]["pane_id"] == "a"
    # An agent's save never undoes the user's keep.
    assert (await env.service.upsert({"id": mine["id"], "name": "x"}, me))["job"]["owner"][
        "expires_at"
    ] is None
    env.clock.advance_ms(AGENT_EXPIRE_MS + DAY)
    await env.service.tick()
    await settle(env)
    assert (await env.service.store.get_job(mine["id"]))["enabled"] is True
    user_job = (await env.service.upsert(job(env)))["job"]
    assert (await env.service.keep(user_job["id"]))["ok"] is False


async def test_once_jobs_do_not_expire_and_agents_are_deleted_after_thirty_days(env) -> None:
    once = {"kind": "once", "in_ms": MINUTE}
    mine = (await env.service.upsert(job(env, schedule=once), agent(env, "a")))["job"]
    assert "expires_at" not in mine["owner"]
    theirs = (await env.service.upsert(job(env, schedule=once)))["job"]
    env.clock.advance_ms(MINUTE)
    await env.service.tick()
    await settle(env)
    assert (await env.service.store.get_job(mine["id"]))["enabled"] is False
    env.clock.advance_ms(AGENT_ONCE_KEEP_MS - 1)
    await env.service.tick()
    assert await env.service.store.get_job(mine["id"]) is not None
    env.clock.advance_ms(1)
    await env.service.tick()
    assert await env.service.store.get_job(mine["id"]) is None
    assert await env.service.store.get_job(theirs["id"]) is not None


def _pane_ctx(pane_id: str) -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


async def test_mcp_limit_answer_and_list_limits(env) -> None:
    agent(env, "a")
    raw = job(env, schedule={"kind": "every", "every_ms": MINUTE})
    refused = await plan_mcp.scheduler_upsert(raw, _pane_ctx("a"))
    assert set(refused) == {"ok", "code", "limit", "max", "used", "error"}
    assert refused["code"] == "SCHEDULER_LIMIT" and (await env.service.list())["jobs"] == []
    await plan_mcp.scheduler_upsert(job(env), _pane_ctx("a"))
    limits = (await plan_mcp.scheduler_list(_pane_ctx("a")))["limits"]
    assert limits == {
        "agent_enabled_per_owner": 10, "agent_enabled_total": 100, "agent_enabled": 1,
        "agent_min_every_ms": 300_000, "agent_max_runs_per_day": 288,
        "agent_runs_per_day": 300, "agent_runs_today": 0,
        "agent_expire_ms": AGENT_EXPIRE_MS, "agent_once_keep_ms": AGENT_ONCE_KEEP_MS,
        "yours_enabled": 1,
    }


async def test_v2_database_gains_the_usage_table(tmp_path: Path) -> None:
    from agent_team_backend.scheduler_store import _add_owners, _create_scheduler_schema

    db = Database(tmp_path / "navide.db")
    db.migrate("scheduler", 1, _create_scheduler_schema)
    db.migrate("scheduler", 2, _add_owners)
    store = SchedulerStore(db)
    assert db.schema_version("scheduler") == 3
    await store.add_usage("2027-01-01")
    await store.add_usage("2027-01-01")
    await store.add_usage("2027-01-02")
    assert (await store.usage("2027-01-01"), await store.usage("2027-01-02")) == (0, 1)
    db.close()
