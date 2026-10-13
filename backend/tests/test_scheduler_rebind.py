"""A job bound to a pane id follows a rebuild along the session lineage, and a
target that stays gone disables the job after a few slots, telling someone once."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend import scheduler as sched_mod
from agent_team_backend.db import Database
from agent_team_backend.scheduler import TARGET_GONE_DISABLE_AFTER, SchedulerService
from agent_team_backend.scheduler_store import SchedulerStore

T0 = 1_800_000_000.0
MINUTE = 60_000
GONE = {"status": "skipped", "reason": "target_gone", "detail": "unknown pane id"}


class Clock:
    def __init__(self) -> None:
        self.t = T0

    def __call__(self) -> float:
        return self.t


class Bridge:
    def __init__(self) -> None:
        self.window = True
        self.outcomes: list[dict[str, Any]] = []
        self.delivered: list[dict[str, Any]] = []
        self.notices: list[dict[str, Any]] = []

    def has_window(self) -> bool:
        return self.window

    def still_queued(self, msg_key: str | None) -> bool:
        return False

    async def budget_limited(self, action: dict[str, Any]) -> bool:
        return False

    async def deliver(self, action: dict[str, Any]) -> dict[str, Any]:
        self.delivered.append(action)
        if self.outcomes:
            return self.outcomes.pop(0)
        return {"status": "ok", "detail": "delivered", "msg_key": "k"}

    async def notify_disabled(self, job: dict[str, Any]) -> None:
        self.notices.append(job)


@pytest.fixture
def env(tmp_path: Path):
    db = Database(tmp_path / "navide.db")
    clock = Clock()
    bridge = Bridge()

    async def notify(jobs: list) -> None:
        pass

    service = SchedulerService(SchedulerStore(db), clock=clock, bridge=bridge, notify=notify)
    yield {"service": service, "clock": clock, "bridge": bridge}
    db.close()


def pane_job(pane_id: str = "old-1") -> dict:
    return {
        "name": "watch",
        "schedule": {"kind": "every", "every_ms": 2 * MINUTE},
        "action": {"kind": "message", "workspace": "/ws", "pane_id": pane_id, "text": "hi"},
    }


async def settle(service: SchedulerService) -> None:
    for task, _manual in list(service._runs.values()):  # noqa: SLF001
        await task


async def next_slot(env) -> None:
    service = env["service"]
    job = (await service.store.list_jobs())[0]
    env["clock"].t = job["state"]["next_run_at"] / 1000
    await service.tick()
    await settle(service)


async def job_of(service: SchedulerService, job_id: str) -> dict:
    return await service.store.get_job(job_id)


# ── Phase A: rebind along the session lineage ───────────────────────────────


async def test_rebuild_with_the_same_session_rebinds_and_delivers(env) -> None:
    service = env["service"]
    job = (await service.upsert(pane_job("old-1")))["job"]
    rebound = await service.rebind_after_rebuild("old-1", "new-2", "sess-a", "sess-a")
    assert rebound == [job["id"]]
    stored = await job_of(service, job["id"])
    assert stored["action"]["pane_id"] == "new-2"
    assert stored["state"]["rebound_from"] == "old-1"
    await next_slot(env)
    assert env["bridge"].delivered[-1]["pane_id"] == "new-2"
    assert (await job_of(service, job["id"]))["state"]["last_status"] == "ok"


@pytest.mark.parametrize("before,after", [("sess-a", "sess-b"), ("", "sess-a"), ("sess-a", ""), ("", "")])
async def test_no_rebind_without_an_identical_session(env, before, after) -> None:
    service = env["service"]
    job = (await service.upsert(pane_job("old-1")))["job"]
    assert await service.rebind_after_rebuild("old-1", "new-2", before, after) == []
    assert (await job_of(service, job["id"]))["action"]["pane_id"] == "old-1"


async def test_rebind_touches_only_jobs_on_the_rebuilt_pane(env) -> None:
    service = env["service"]
    by_name = {
        "name": "by-name",
        "schedule": {"kind": "every", "every_ms": 2 * MINUTE},
        "action": {"kind": "message", "workspace": "/ws", "pane_name": "worker", "text": "x"},
    }
    other = (await service.upsert(pane_job("other-9")))["job"]
    named = (await service.upsert(by_name))["job"]
    assert await service.rebind_after_rebuild("old-1", "new-2", "s", "s") == []
    assert (await job_of(service, other["id"]))["action"]["pane_id"] == "other-9"
    assert "pane_id" not in (await job_of(service, named["id"]))["action"]


async def test_rebind_resets_the_target_gone_count(env) -> None:
    service = env["service"]
    job = (await service.upsert(pane_job("old-1")))["job"]
    env["bridge"].outcomes = [dict(GONE), dict(GONE)]
    await next_slot(env)
    await next_slot(env)
    assert (await job_of(service, job["id"]))["state"]["consecutive_target_gone"] == 2
    await service.rebind_after_rebuild("old-1", "new-2", "s", "s")
    assert (await job_of(service, job["id"]))["state"]["consecutive_target_gone"] == 0


async def test_rebind_clears_the_target_gone_marks_but_keeps_the_job_off(env) -> None:
    service = env["service"]
    job = (await service.upsert(pane_job("old-1")))["job"]
    env["bridge"].outcomes = [dict(GONE) for _ in range(TARGET_GONE_DISABLE_AFTER)]
    for _ in range(TARGET_GONE_DISABLE_AFTER):
        await next_slot(env)
    assert (await job_of(service, job["id"]))["state"]["disabled_reason"] == "target_gone"
    await service.rebind_after_rebuild("old-1", "new-2", "s", "s")
    stored = await job_of(service, job["id"])
    assert stored["enabled"] is False
    assert stored["state"]["disabled_reason"] is None
    assert stored["state"]["last_skip_reason"] is None
    assert stored["state"]["last_status"] == "skipped"
    assert stored["state"]["rebound_from"] == "old-1"
    assert stored["state"]["rebound_needs_enable"] is True


async def test_switching_a_rebound_job_on_ends_the_reenable_ask_for_good(env) -> None:
    service = env["service"]
    job = (await service.upsert(pane_job("old-1")))["job"]
    env["bridge"].outcomes = [dict(GONE) for _ in range(TARGET_GONE_DISABLE_AFTER)]
    for _ in range(TARGET_GONE_DISABLE_AFTER):
        await next_slot(env)
    await service.rebind_after_rebuild("old-1", "new-2", "s", "s")
    assert (await job_of(service, job["id"]))["state"]["rebound_needs_enable"] is True
    assert (await service.set_enabled(job["id"], True))["ok"] is True
    assert (await service.set_enabled(job["id"], False))["ok"] is True
    state = (await job_of(service, job["id"]))["state"]
    assert not state.get("rebound_needs_enable")
    assert state["rebound_from"] == "old-1"


async def test_rebind_clears_a_single_target_gone_skip_on_an_enabled_job(env) -> None:
    service = env["service"]
    job = (await service.upsert(pane_job("old-1")))["job"]
    env["bridge"].outcomes = [dict(GONE)]
    await next_slot(env)
    await service.rebind_after_rebuild("old-1", "new-2", "s", "s")
    stored = await job_of(service, job["id"])
    assert stored["enabled"] is True
    assert stored["state"]["last_skip_reason"] is None
    assert stored["state"]["last_status"] == "skipped"
    assert not stored["state"].get("rebound_needs_enable")


async def test_manual_pane_spawn_rebinds_a_resumed_rebuild(env, tmp_path, monkeypatch) -> None:
    """The real WS path: a rebuild re-keys the project record (previous_pane_id)
    with the session it resumed; the job follows only that hop."""
    service = env["service"]
    monkeypatch.setattr(sched_mod, "_service", service)

    class Ws:
        async def send_json(self, payload: dict) -> None:
            pass

    (tmp_path / "proj").mkdir()
    ws = str(tmp_path / "proj")

    async def spawn(payload: dict) -> None:
        await app.handle_message(app.Session(Ws()), {  # type: ignore[arg-type]
            "id": "m", "type": "manual_pane.spawn",
            "payload": {"workspace_path": ws, "agent": "claude", "command": "claude", **payload},
        })

    await spawn({"pane_id": "old-1", "session_id": "sess-a"})
    assert app.project_store.load_or_create(ws).panes[0].session_id == "sess-a"
    job = (await service.upsert(pane_job("old-1")))["job"]
    # A clean rebuild pins a new session: no rebind.
    await spawn({"pane_id": "clean-2", "previous_pane_id": "old-1", "session_id": "sess-new"})
    assert (await job_of(service, job["id"]))["action"]["pane_id"] == "old-1"

    await spawn({"pane_id": "p-3", "session_id": "sess-c"})
    job2 = (await service.upsert(pane_job("p-3")))["job"]
    await spawn({"pane_id": "p-4", "previous_pane_id": "p-3", "session_id": "sess-c"})
    assert (await job_of(service, job2["id"]))["action"]["pane_id"] == "p-4"


# ── Phase B: disable after N target_gone, notify once ───────────────────────


async def test_disables_after_n_target_gone_and_notifies_once(env) -> None:
    service = env["service"]
    bridge = env["bridge"]
    job = (await service.upsert(pane_job("gone-1")))["job"]
    bridge.outcomes = [dict(GONE) for _ in range(TARGET_GONE_DISABLE_AFTER)]
    for n in range(1, TARGET_GONE_DISABLE_AFTER):
        await next_slot(env)
        stored = await job_of(service, job["id"])
        assert stored["enabled"] is True
        assert stored["state"]["consecutive_target_gone"] == n
    assert bridge.notices == []
    await next_slot(env)
    stored = await job_of(service, job["id"])
    assert stored["enabled"] is False
    assert stored["state"]["disabled_reason"] == "target_gone"
    assert [n["id"] for n in bridge.notices] == [job["id"]]
    # A manual run that meets the same gone target does not notify again.
    bridge.outcomes = [dict(GONE)]
    assert (await service.run_now(job["id"]))["ok"] is True
    await settle(service)
    assert len(bridge.notices) == 1
    assert (await job_of(service, job["id"]))["enabled"] is False


async def test_target_offline_and_no_window_do_not_count(env) -> None:
    service = env["service"]
    bridge = env["bridge"]
    job = (await service.upsert(pane_job("p-1")))["job"]
    offline = {"status": "skipped", "reason": "no_window", "detail": "target-offline"}
    bridge.outcomes = [dict(GONE), dict(GONE), dict(offline), dict(offline)]
    for _ in range(4):
        await next_slot(env)
    bridge.window = False
    await next_slot(env)
    stored = await job_of(service, job["id"])
    assert stored["enabled"] is True
    assert stored["state"]["consecutive_target_gone"] == 2
    assert bridge.notices == []


async def test_a_delivery_resets_the_count(env) -> None:
    service = env["service"]
    job = (await service.upsert(pane_job("p-1")))["job"]
    env["bridge"].outcomes = [dict(GONE), dict(GONE), {"status": "ok", "msg_key": "k"}, dict(GONE)]
    for _ in range(4):
        await next_slot(env)
    stored = await job_of(service, job["id"])
    assert stored["enabled"] is True
    assert stored["state"]["consecutive_target_gone"] == 1


async def test_reenabling_clears_the_disabled_reason(env) -> None:
    service = env["service"]
    job = (await service.upsert(pane_job("gone-1")))["job"]
    env["bridge"].outcomes = [dict(GONE) for _ in range(TARGET_GONE_DISABLE_AFTER)]
    for _ in range(TARGET_GONE_DISABLE_AFTER):
        await next_slot(env)
    assert (await service.set_enabled(job["id"], True))["ok"] is True
    state = (await job_of(service, job["id"]))["state"]
    assert state["disabled_reason"] is None and state["consecutive_target_gone"] == 0


# ── LiveBridge.notify_disabled: owner pane first, else the user ─────────────


@pytest.fixture
def live(monkeypatch):
    from agent_team_backend.mcp_server import server as mcp

    agent_messaging._reset_for_test()
    sent: list = []
    events: list = []

    async def fake_send(caller, to, text, **kwargs):
        sent.append((caller.kind, to, text, kwargs))
        return {"ok": True, "msg_key": "n1", "status": "delivered"}

    async def fake_broadcast(event, **_kw):
        events.append(event)

    monkeypatch.setattr(mcp, "_send", fake_send)
    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    yield {"sent": sent, "events": events}
    agent_messaging._reset_for_test()


def disabled_job(owner: dict) -> dict:
    return {
        "id": "j1", "name": "watch", "owner": owner,
        "action": {"kind": "message", "workspace": "/ws", "pane_id": "gone-1", "text": "hi"},
        "state": {"consecutive_target_gone": 3, "disabled_reason": "target_gone"},
    }


async def test_notify_reaches_a_live_owner_pane(live) -> None:
    agent_messaging.register("owner-1", "boss", "/ws", "claude")
    owner = {"kind": "pane", "pane_id": "owner-1", "pane_name": "boss", "workspace": "/ws"}
    await sched_mod.LiveBridge().notify_disabled(disabled_job(owner))
    assert len(live["sent"]) == 1
    kind, to, text, kwargs = live["sent"][0]
    assert kind == "host" and to == "" and kwargs["pane_id"] == "owner-1"
    assert "watch" in text and "j1" in text
    assert [e for e in live["events"] if e["type"] == "scheduler.job_disabled"] == []


@pytest.mark.parametrize("owner", [
    {"kind": "pane", "pane_id": "owner-gone", "pane_name": "boss", "workspace": "/ws"},
    {"kind": "user"},
])
async def test_notify_falls_back_to_the_user(live, owner) -> None:
    await sched_mod.LiveBridge().notify_disabled(disabled_job(owner))
    assert live["sent"] == []
    notices = [e for e in live["events"] if e["type"] == "scheduler.job_disabled"]
    assert len(notices) == 1
    assert notices[0]["payload"]["id"] == "j1"
    assert notices[0]["payload"]["reason"] == "target_gone"
