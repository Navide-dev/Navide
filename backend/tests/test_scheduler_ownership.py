"""Scheduler job ownership: an agent (MCP caller) may change only the jobs it
created; a Navide window (the user) may change any job."""

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
from agent_team_backend.scheduler_store import SchedulerStore, _create_scheduler_schema


def _ctx(params: dict[str, str]) -> Any:
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def pane(pane_id: str) -> Any:
    return _ctx({"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)})


def host() -> Any:
    return _ctx({"client": "host", "t": plan_mcp_auth.internal_token()})


class _Bridge:
    def has_window(self) -> bool:
        return True

    def still_queued(self, msg_key) -> bool:
        return False

    async def budget_limited(self, action) -> bool:
        return False

    async def deliver(self, action) -> dict:
        return {"status": "ok", "msg_key": "k"}


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    agent_messaging._reset_for_test()
    db = Database(tmp_path / "navide.db")

    async def fake_broadcast(event: dict, *, exclude=None) -> None:
        pass

    monkeypatch.setattr(app_module, "broadcast", fake_broadcast)
    service = SchedulerService(SchedulerStore(db), clock=lambda: 1_800_000_000.0, bridge=_Bridge())
    monkeypatch.setattr(sched_mod, "_service", service)
    ws = str(tmp_path / "proj")
    agent_messaging.register("a-1", "alpha", ws, "claude")
    agent_messaging.register("b-1", "beta", ws, "claude")
    yield SimpleNamespace(service=service, ws=ws, db=db)
    for task, _manual in list(service._runs.values()):  # noqa: SLF001
        task.cancel()
    db.close()
    agent_messaging._reset_for_test()


def job(ws: str, **extra: Any) -> dict[str, Any]:
    return {
        "name": "report",
        "schedule": {"kind": "every", "every_ms": 600_000},
        "action": {"kind": "message", "workspace": ws, "pane_name": "alpha", "text": "go"},
        **extra,
    }


async def by_agent(env, pane_id: str = "a-1") -> dict[str, Any]:
    result = await plan_mcp.scheduler_upsert(job(env.ws), pane(pane_id))
    assert result["ok"] is True, result
    return result["job"]


async def by_user(env) -> dict[str, Any]:
    return (await env.service.upsert(job(env.ws)))["job"]


async def refused_everywhere(job_id: str, ctx: Any) -> list[dict[str, Any]]:
    return [
        await plan_mcp.scheduler_upsert({"id": job_id, "name": "renamed"}, ctx),
        await plan_mcp.scheduler_set_enabled(job_id, False, ctx),
        await plan_mcp.scheduler_run_now(job_id, ctx),
        await plan_mcp.scheduler_remove(job_id, ctx),
    ]


async def test_owner_and_updated_by_are_recorded(env) -> None:
    created = await by_agent(env)
    identity = {"kind": "pane", "pane_id": "a-1", "pane_name": "alpha", "workspace": env.ws}
    assert created["owner"] == {**identity, "expires_at": 1_800_000_000_000 + 7 * 86_400_000}
    assert created["updated_by"] == identity and created["owner_gone"] is False
    assert (await by_user(env))["owner"] == {"kind": "user"}
    # A window edit keeps the agent as owner but records who changed it.
    edited = (await env.service.upsert({"id": created["id"], "name": "renamed"}))["job"]
    assert edited["owner"]["pane_id"] == "a-1" and edited["updated_by"] == {"kind": "user"}
    await env.service.set_enabled(created["id"], False)
    stored = await env.service.store.get_job(created["id"])
    assert stored["updated_by"] == {"kind": "user"} and stored["owner"]["kind"] == "pane"


async def test_client_cannot_write_owner(env) -> None:
    raw = {**job(env.ws), "owner": {"kind": "user"}, "updated_by": {"kind": "user"}}
    created = (await plan_mcp.scheduler_upsert(raw, pane("a-1")))["job"]
    assert created["owner"]["kind"] == "pane"


async def test_agent_may_not_touch_the_users_job_but_the_window_may(env) -> None:
    user_job = await by_user(env)
    for result in await refused_everywhere(user_job["id"], pane("a-1")):
        assert result["ok"] is False and result["code"] == "SCHEDULER_NOT_OWNER"
        assert result["owner"] == {"kind": "user"} and "created by the user" in result["error"]
    assert (await env.service.store.get_job(user_job["id"]))["name"] == "report"
    assert (await env.service.upsert({"id": user_job["id"], "name": "x"}))["ok"] is True
    assert (await env.service.set_enabled(user_job["id"], False))["ok"] is True
    assert (await env.service.remove(user_job["id"]))["ok"] is True


async def test_agent_may_not_touch_another_agents_job(env) -> None:
    theirs = await by_agent(env, "b-1")
    for result in await refused_everywhere(theirs["id"], pane("a-1")):
        assert result["code"] == "SCHEDULER_NOT_OWNER" and '"beta"' in result["error"]
    for result in await refused_everywhere(theirs["id"], host()):
        assert result["code"] == "SCHEDULER_NOT_OWNER"


async def test_agent_manages_its_own_job(env) -> None:
    mine = await by_agent(env)
    ctx = pane("a-1")
    assert (await plan_mcp.scheduler_upsert({"id": mine["id"], "name": "renamed"}, ctx))["ok"] is True
    assert await plan_mcp.scheduler_set_enabled(mine["id"], False, ctx) == {"ok": True}
    assert await plan_mcp.scheduler_set_enabled(mine["id"], True, ctx) == {"ok": True}
    assert await plan_mcp.scheduler_run_now(mine["id"], ctx) == {"ok": True, "enqueued": True}
    for task, _manual in list(env.service._runs.values()):  # noqa: SLF001
        await task
    assert (await plan_mcp.scheduler_runs(mine["id"], ctx))["ok"] is True
    assert await plan_mcp.scheduler_remove(mine["id"], ctx) == {"ok": True}


async def test_run_history_is_readable_by_anyone(env) -> None:
    user_job = await by_user(env)
    assert (await plan_mcp.scheduler_runs(user_job["id"], pane("b-1")))["ok"] is True


async def test_owner_follows_a_reattached_pane(env) -> None:
    mine = await by_agent(env)
    agent_messaging.register("a-2", "alpha", env.ws, "claude")
    agent_messaging.add_aliases("a-2", ["a-1"], env.ws)
    agent_messaging.unregister("a-1")
    # The CLI still quotes a-1; it resolves to a-2, which the job belongs to.
    assert await plan_mcp.scheduler_set_enabled(mine["id"], False, pane("a-1")) == {"ok": True}
    listed = await plan_mcp.scheduler_list(pane("a-2"))
    assert listed["jobs"][0]["editable"] is True and listed["jobs"][0]["owner_gone"] is False


async def test_closed_creator_leaves_the_job_to_the_user(env) -> None:
    mine = await by_agent(env)
    agent_messaging.unregister("a-1")
    # A new pane with the same name in the same workspace inherits nothing.
    agent_messaging.register("a-9", "alpha", env.ws, "claude")
    for result in await refused_everywhere(mine["id"], pane("a-9")):
        assert result["code"] == "SCHEDULER_NOT_OWNER" and "gone" in result["error"]
    listed = await plan_mcp.scheduler_list(pane("a-9"))
    assert listed["jobs"][0]["owner_gone"] is True and listed["jobs"][0]["editable"] is False
    assert (await env.service.list())["jobs"][0]["owner_gone"] is True
    # The window can take it over.
    adopted = await env.service.adopt(mine["id"])
    assert adopted["job"]["owner"] == {"kind": "user"} and adopted["job"]["owner_gone"] is False
    assert (await env.service.set_enabled(mine["id"], False))["ok"] is True


async def test_list_marks_what_the_caller_may_change(env) -> None:
    mine = await by_agent(env)
    user_job = await by_user(env)
    listed = await plan_mcp.scheduler_list(pane("a-1"))
    editable = {j["id"]: j["editable"] for j in listed["jobs"]}
    assert editable == {mine["id"]: True, user_job["id"]: False}
    assert {j["id"]: j["editable"] for j in (await plan_mcp.scheduler_list(pane("b-1")))["jobs"]} == {
        mine["id"]: False, user_job["id"]: False,
    }


async def test_cross_workspace_target_is_refused_for_a_pane(env, tmp_path) -> None:
    other = str(tmp_path / "other")
    raw = job(other)
    result = await plan_mcp.scheduler_upsert(raw, pane("a-1"))
    assert result["ok"] is False and result["code"] == "SCHEDULER_CROSS_WORKSPACE"
    assert (await env.service.list())["jobs"] == []
    # Retargeting an own job to another workspace is refused the same way.
    mine = await by_agent(env)
    moved = await plan_mcp.scheduler_upsert({"id": mine["id"], "action": raw["action"]}, pane("a-1"))
    assert moved["code"] == "SCHEDULER_CROSS_WORKSPACE"
    # A trailing slash is the same workspace.
    same = job(env.ws + "/")
    assert (await plan_mcp.scheduler_upsert(same, pane("a-1")))["ok"] is True


async def test_caller_without_pane_identity_is_one_external_agent(env, tmp_path) -> None:
    created = await plan_mcp.scheduler_upsert(job(str(tmp_path / "anywhere")), host())
    assert created["ok"] is True and created["job"]["owner"]["kind"] == "external"
    job_id = created["job"]["id"]
    assert await plan_mcp.scheduler_set_enabled(job_id, False, host()) == {"ok": True}
    for result in await refused_everywhere(job_id, pane("a-1")):
        assert result["code"] == "SCHEDULER_NOT_OWNER"
    user_job = await by_user(env)
    assert (await plan_mcp.scheduler_remove(user_job["id"], host()))["code"] == "SCHEDULER_NOT_OWNER"


def test_v1_database_upgrades_existing_jobs_to_the_user(tmp_path: Path) -> None:
    db = Database(tmp_path / "navide.db")
    db.migrate("scheduler", 1, _create_scheduler_schema)
    with db.transaction() as cur:
        cur.execute(
            "INSERT INTO scheduler_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("old", "legacy", 1, 1, 2, '{"kind":"every","every_ms":60000}',
             '{"kind":"message","workspace":"/w","pane_name":"p","text":"t"}', "{}", "{}"),
        )
    store = SchedulerStore(db)
    assert db.schema_version("scheduler") >= 2
    row = store._get_job("old")  # noqa: SLF001
    assert row["owner"] == {"kind": "user", "legacy": True} and row["updated_by"] is None
    assert row["name"] == "legacy" and row["schedule"] == {"kind": "every", "every_ms": 60000}
    # A row a downgraded build writes has no owner; it reads as the user's too.
    with db.transaction() as cur:
        cur.execute("UPDATE scheduler_jobs SET owner = NULL WHERE id = 'old'")
    assert store._get_job("old")["owner"] == {"kind": "user", "legacy": True}  # noqa: SLF001
    db.close()
