"""A scheduler job may target a commander: upgrade moves the jobs aimed at the pane onto
the commander, a run goes to the commander's current body, archive pauses (disables) them
and downgrade puts each action back. Jobs without a commander are untouched."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend import commander_service as cs
from agent_team_backend import scheduler as sched_mod
from agent_team_backend.db import Database
from agent_team_backend.scheduler import (
    JobInvalid, LiveBridge, SchedulerService, _normalize_action, commander_target,
)
from agent_team_backend.scheduler_store import SchedulerStore

from .commander_fakes import World, pane, service

MINUTE = 60_000


class Bridge:
    def has_window(self) -> bool:
        return True

    def still_queued(self, msg_key: str | None) -> bool:
        return False

    async def budget_limited(self, action: dict[str, Any]) -> bool:
        return False

    async def deliver(self, action: dict[str, Any]) -> dict[str, Any]:
        return {"status": "ok", "detail": "delivered", "msg_key": "k"}

    async def notify_disabled(self, job: dict[str, Any]) -> None:
        pass


@pytest.fixture
async def env(tmp_path: Path, monkeypatch):
    world = World()
    world.add(pane("p1", "api", workspace="/ws"))
    monkeypatch.setattr(agent_messaging, "current", world.lookup)
    (tmp_path / "cmd").mkdir()
    svc = service(tmp_path / "cmd", world)
    cs.configure(svc)
    db = Database(tmp_path / "navide.db")

    async def notify(jobs: list) -> None:
        pass

    sched = SchedulerService(SchedulerStore(db), clock=lambda: 1_800_000_000.0, bridge=Bridge(), notify=notify)
    await sched.start()
    yield SimpleNamespace(world=world, svc=svc, sched=sched, db=db)
    await sched.close()
    db.close()
    cs.configure(None)


def job(**target: str) -> dict:
    return {"name": "watch", "schedule": {"kind": "every", "every_ms": 10 * MINUTE},
            "action": {"kind": "message", "workspace": "/ws", "text": "hi", **target}}


async def put(env, **target: str) -> dict:
    out = await env.sched.upsert(job(**target))
    assert out["ok"], out
    return out["job"]


async def stored(env, job_id: str) -> dict:
    return await env.sched.store.get_job(job_id)


def test_action_accepts_a_commander_id_alone_and_keeps_pane_validation():
    a = _normalize_action({"kind": "message", "workspace": "/ws", "text": "x", "commander_id": "c-1"})
    assert a["commander_id"] == "c-1" and "pane_id" not in a
    with pytest.raises(JobInvalid):
        _normalize_action({"kind": "message", "workspace": "/ws", "text": "x"})
    with pytest.raises(JobInvalid):
        _normalize_action({"kind": "message", "workspace": "/ws", "text": "x", "commander_id": "a/b"})
    plain = _normalize_action({"kind": "message", "workspace": "/ws", "text": "x", "pane_id": "p1"})
    assert "commander_id" not in plain


async def test_upgrade_moves_jobs_aimed_at_the_pane_only(env):
    by_id = await put(env, pane_id="p1")
    by_name = await put(env, pane_name="api")
    other = await put(env, pane_id="p9")
    c = env.svc.upgrade_pane(env.world.panes["p1"], {})
    assert (await stored(env, by_id["id"]))["action"]["commander_id"] == c.id
    assert (await stored(env, by_name["id"]))["action"]["commander_id"] == c.id
    assert "commander_id" not in (await stored(env, other["id"]))["action"]
    labels = {s["ref_id"] for s in env.svc.bindings(c.id) if s["kind"] == "scheduler_job"}
    assert labels == {by_id["id"], by_name["id"]}


async def test_a_run_goes_to_the_commanders_current_body(env):
    j = await put(env, pane_id="p1")
    c = env.svc.upgrade_pane(env.world.panes["p1"], {})
    action = (await stored(env, j["id"]))["action"]
    assert commander_target(action)["pane_id"] == "p1"
    env.world.add(pane("p2", "api"))
    env.svc.store.attach_body(c.id, pane_id="p2", workspace="/ws", agent_key="claude")
    target = commander_target(action)
    assert target["pane_id"] == "p2" and "pane_name" not in target


async def test_live_bridge_sends_to_the_body_and_skips_without_one(env, monkeypatch):
    from agent_team_backend.mcp_server import server as mcp

    sent: list[dict[str, Any]] = []

    async def fake_send(caller, name, text, **kw):
        sent.append({"name": name, **kw})
        return {"ok": True, "status": "delivered", "msg_key": "k"}

    monkeypatch.setattr(mcp, "_send", fake_send)
    c = env.svc.create({"name": "boss", "workspaces": ["/ws"], "agent_key": "claude"})
    out = await LiveBridge().deliver({"kind": "message", "workspace": "/ws", "text": "t", "commander_id": c.id})
    assert out["reason"] == sched_mod.SKIP_TARGET_GONE and sent == []
    env.svc.store.attach_body(c.id, pane_id="p1", workspace="/ws", agent_key="claude")
    out = await LiveBridge().deliver({"kind": "message", "workspace": "/ws", "text": "t", "commander_id": c.id})
    assert out["status"] == "ok" and sent[-1]["pane_id"] == "p1" and sent[-1]["open_target"] is True


async def test_downgrade_restores_each_action_exactly(env):
    a = await put(env, pane_id="p1")
    b = await put(env, pane_name="api")
    before = {j["id"]: (await stored(env, j["id"]))["action"] for j in (a, b)}
    c = env.svc.upgrade_pane(env.world.panes["p1"], {})
    env.svc.downgrade(c.id)
    for job_id, action in before.items():
        assert (await stored(env, job_id))["action"] == action


async def test_downgrade_after_a_body_change_follows_the_new_pane_id(env):
    a = await put(env, pane_id="p1")
    c = env.svc.upgrade_pane(env.world.panes["p1"], {})
    env.world.add(pane("p2", "api"))
    env.svc.store.attach_body(c.id, pane_id="p2", workspace="/ws", agent_key="claude")
    env.svc.downgrade(c.id)
    action = (await stored(env, a["id"]))["action"]
    assert action["pane_id"] == "p2" and "commander_id" not in action


async def test_archive_disables_and_resume_reenables_only_those(env):
    on = await put(env, pane_id="p1")
    off = await put(env, pane_id="p1")
    await env.sched.set_enabled(off["id"], False)
    c = env.svc.upgrade_pane(env.world.panes["p1"], {})
    env.svc.archive(c.id)
    assert not (await stored(env, on["id"]))["enabled"]
    assert (await stored(env, on["id"]))["state"]["commander_paused"] is True
    env.sched._commander_jobs.set_paused(c.id, False)  # noqa: SLF001
    resumed = await stored(env, on["id"])
    assert resumed["enabled"] and "commander_paused" not in resumed["state"]
    assert not (await stored(env, off["id"]))["enabled"]


# ── workspace boundary (a pane may only schedule into its own workspace) ────

PANE_B = {"kind": "pane", "pane_id": "pb", "pane_name": "b", "workspace": "/other"}
PANE_A = {"kind": "pane", "pane_id": "pa", "pane_name": "a", "workspace": "/ws"}


async def test_a_pane_cannot_schedule_another_workspaces_commander(env):
    c = env.svc.create({"name": "boss", "workspaces": ["/ws"], "agent_key": "claude"})
    out = await env.sched.upsert({**job(commander_id=c.id), "action": {
        "kind": "message", "workspace": "/other", "text": "hi", "commander_id": c.id}}, PANE_B)
    assert out["ok"] is False and out["code"] == "SCHEDULER_CROSS_WORKSPACE"
    out = await env.sched.upsert(job(commander_id="no-such-commander"), PANE_A)
    assert out["ok"] is False and out["code"] == "SCHEDULER_CROSS_WORKSPACE"


async def test_a_pane_in_the_commanders_workspace_and_the_user_may(env):
    c = env.svc.create({"name": "boss", "workspaces": ["/ws"], "agent_key": "claude"})
    assert (await env.sched.upsert(job(commander_id=c.id), PANE_A))["ok"]
    assert (await env.sched.upsert(job(commander_id=c.id)))["ok"]  # the user, from a window


async def test_migrated_jobs_still_run_and_resave(env):
    env.world.add(pane("pa", "a"))  # the owner is live, so it may change its job
    mine = await env.sched.upsert(job(pane_id="p1"), PANE_A)  # an agent's own job
    assert mine["ok"]
    c = env.svc.upgrade_pane(env.world.panes["p1"], {})
    action = (await stored(env, mine["job"]["id"]))["action"]
    assert action["commander_id"] == c.id and commander_target(action)["pane_id"] == "p1"
    # Its owner re-saves it unchanged after the migration: not refused for the workspace.
    assert (await env.sched.upsert({"id": mine["job"]["id"], "name": "renamed"}, PANE_A))["ok"]


async def test_a_body_in_another_workspace_is_skipped_not_sent(env, monkeypatch):
    from agent_team_backend.mcp_server import server as mcp

    sent: list[dict[str, Any]] = []

    async def fake_send(caller, name, text, **kw):
        sent.append(kw)
        return {"ok": True, "status": "delivered", "msg_key": "k"}

    monkeypatch.setattr(mcp, "_send", fake_send)
    c = env.svc.create({"name": "boss", "workspaces": ["/ws"], "agent_key": "claude"})
    env.svc.store.attach_body(c.id, pane_id="p1", workspace="/elsewhere", agent_key="claude")
    out = await LiveBridge().deliver({"kind": "message", "workspace": "/ws", "text": "t", "commander_id": c.id})
    assert out["status"] == "skipped" and out["reason"] == sched_mod.SKIP_COMMANDER_WORKSPACE_MISMATCH
    assert sent == []
