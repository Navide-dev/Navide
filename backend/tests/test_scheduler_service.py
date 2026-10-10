"""SchedulerService behaviour under a fake clock — nothing here waits for real time."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import scheduler as sched_mod
from agent_team_backend.db import Database
from agent_team_backend.scheduler import (
    BACKOFF_S,
    CATCH_UP_BURST,
    CATCH_UP_SPACING_S,
    MAX_SLEEP_S,
    MIN_SLEEP_S,
    SchedulerService,
    outcome_of_send,
)
from agent_team_backend.scheduler_store import RUNS_PER_JOB, SchedulerStore

T0 = 1_800_000_000.0  # seconds; a fixed epoch for the fake clock
MINUTE = 60_000


class Clock:
    def __init__(self) -> None:
        self.t = T0

    def __call__(self) -> float:
        return self.t

    def advance_ms(self, ms: int) -> None:
        self.t += ms / 1000


class Bridge:
    """Stand-in for LiveBridge: records deliveries, answers from a script."""

    def __init__(self) -> None:
        self.window = True
        self.queued: set[str] = set()
        self.limited = False
        self.outcomes: list[dict[str, Any]] = []
        self.delivered: list[dict[str, Any]] = []
        self.gate: asyncio.Event | None = None
        self.counter = 0

    def has_window(self) -> bool:
        return self.window

    def still_queued(self, msg_key: str | None) -> bool:
        return bool(msg_key) and msg_key in self.queued

    async def budget_limited(self, action: dict[str, Any]) -> bool:
        return self.limited

    async def deliver(self, action: dict[str, Any]) -> dict[str, Any]:
        self.delivered.append(action)
        if self.gate is not None:
            await self.gate.wait()
        if self.outcomes:
            return self.outcomes.pop(0)
        self.counter += 1
        return {"status": "ok", "detail": "delivered", "msg_key": f"k{self.counter}"}


@pytest.fixture
def env(tmp_path: Path):
    db = Database(tmp_path / "navide.db")
    clock = Clock()
    bridge = Bridge()
    sleeps: list[float] = []
    notified: list[list] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        clock.advance_ms(int(seconds * 1000))

    async def notify(jobs: list) -> None:
        notified.append(jobs)

    def make() -> SchedulerService:
        return SchedulerService(
            SchedulerStore(db), clock=clock, sleep=fake_sleep, bridge=bridge, notify=notify
        )

    yield {"db": db, "clock": clock, "bridge": bridge, "sleeps": sleeps,
           "notified": notified, "make": make}
    db.close()


def every_job(minutes: int = 2, **over) -> dict:
    job = {
        "name": "ping",
        "schedule": {"kind": "every", "every_ms": minutes * MINUTE},
        "action": {"kind": "message", "workspace": "/ws", "pane_name": "worker", "text": "hi"},
    }
    job.update(over)
    return job


async def settle(service: SchedulerService) -> None:
    for task, _manual in list(service._runs.values()):  # noqa: SLF001
        await task


async def caught_up(service: SchedulerService) -> None:
    """Wait for the catch-up task to finish. No wall-clock budget: the fake
    clock makes its sleeps instant, so all its time is real SQLite commits,
    and eight jobs' worth took over 5 s on the Windows runner. A hang still
    fails there, on the per-test --timeout the Windows CI job passes."""
    await service._catch_up_task  # noqa: SLF001


async def create(service: SchedulerService, **over) -> dict:
    return (await service.upsert(every_job(**over)))["job"]


async def runs(service: SchedulerService, job_id: str) -> list[dict]:
    return (await service.runs(job_id, 200))["runs"]


async def state(service: SchedulerService, job_id: str) -> dict:
    return (await service.store.get_job(job_id))["state"]


async def test_fires_on_time_and_not_before(env) -> None:
    service = env["make"]()
    job = await create(service)
    delay = await service.tick()
    assert env["bridge"].delivered == []
    assert delay == pytest.approx(MAX_SLEEP_S)  # 2 min away, capped at 60s
    env["clock"].advance_ms(2 * MINUTE - 1_000)
    assert await service.tick() == pytest.approx(MIN_SLEEP_S)  # 1s away, floored at 2s
    env["clock"].advance_ms(1_000)
    await service.tick()
    await settle(service)
    assert len(env["bridge"].delivered) == 1
    st = await state(service, job["id"])
    assert st["last_status"] == "ok" and st["running_at"] is None
    assert st["next_run_at"] == job["state"]["next_run_at"] + 2 * MINUTE
    assert [r["status"] for r in await runs(service, job["id"])] == ["ok"]


async def test_reentry_lock_blocks_a_second_run(env) -> None:
    service = env["make"]()
    job = await create(service, minutes=1)
    env["bridge"].gate = asyncio.Event()
    env["clock"].advance_ms(MINUTE)
    await service.tick()
    await asyncio.sleep(0)
    assert (await state(service, job["id"]))["running_at"] is not None
    env["clock"].advance_ms(5 * MINUTE)
    await service.tick()
    assert (await service.run_now(job["id"]))["ok"] is False
    assert len(env["bridge"].delivered) == 1
    env["bridge"].gate.set()
    await settle(service)
    assert len(env["bridge"].delivered) == 1


async def test_tick_does_not_run_twice_concurrently(env) -> None:
    service = env["make"]()
    service._ticking = True  # noqa: SLF001 — a tick is in progress
    assert await service.tick() == MAX_SLEEP_S


async def test_startup_clears_leftover_running_at_without_catch_up(env) -> None:
    service = env["make"]()
    job = await create(service)
    st = await state(service, job["id"])
    st["running_at"] = service.now_ms()
    await service.store.set_state(job["id"], st)
    env["clock"].advance_ms(10 * MINUTE)
    restarted = env["make"]()
    await restarted.start()
    try:
        after = await state(restarted, job["id"])
        assert after["running_at"] is None and after["last_skip_reason"] == "interrupted"
        assert after["next_run_at"] > restarted.now_ms()
        assert [(r["status"], r["reason"]) for r in await runs(restarted, job["id"])] == [
            ("skipped", "interrupted")
        ]
        assert env["bridge"].delivered == []
    finally:
        await restarted.close()


async def test_stuck_run_times_out_as_error(env) -> None:
    service = env["make"]()
    job = await create(service, policy={"timeout_s": 60})
    env["bridge"].gate = asyncio.Event()  # never released
    env["clock"].advance_ms(2 * MINUTE)
    await service.tick()
    await asyncio.sleep(0)
    env["clock"].advance_ms(61_000)
    await service.tick()
    st = await state(service, job["id"])
    assert st["running_at"] is None and st["last_status"] == "error"
    assert st["consecutive_errors"] == 1
    assert (await runs(service, job["id"]))[0]["reason"] == "timeout"
    assert service._runs == {}  # noqa: SLF001 — the hung task was cancelled


async def test_backoff_ladder_and_reset_on_success(env) -> None:
    service = env["make"]()
    job = await create(service, minutes=1)
    env["bridge"].outcomes = [{"status": "error", "detail": "boom"}] * len(BACKOFF_S) + [
        {"status": "error", "detail": "boom"}
    ]
    for step, backoff in enumerate([*BACKOFF_S, BACKOFF_S[-1]], start=1):
        st = await state(service, job["id"])
        target = max(st["next_run_at"], st["backoff_until"] or 0)
        env["clock"].t = target / 1000
        await service.tick()
        await settle(service)
        st = await state(service, job["id"])
        assert st["consecutive_errors"] == step
        assert st["backoff_until"] == service.now_ms() + backoff * 1000
        # Inside the window nothing fires even though next_run_at has passed.
        env["clock"].advance_ms(backoff * 1000 - 1)
        before = len(env["bridge"].delivered)
        await service.tick()
        assert len(env["bridge"].delivered) == before
    job_after = await service.store.get_job(job["id"])
    assert job_after["enabled"] is True  # never auto-disabled
    st = await state(service, job["id"])
    env["clock"].t = max(st["next_run_at"], st["backoff_until"]) / 1000
    await service.tick()
    await settle(service)
    st = await state(service, job["id"])
    assert st["consecutive_errors"] == 0 and st["backoff_until"] is None and st["last_error"] is None


@pytest.mark.parametrize("reason", ["no_window", "busy", "budget"])
async def test_skips_do_not_count_as_errors(env, reason) -> None:
    service = env["make"]()
    job = await create(service)
    bridge = env["bridge"]
    if reason == "no_window":
        bridge.window = False
    elif reason == "budget":
        bridge.limited = True
    else:
        st = await state(service, job["id"])
        st["last_msg_key"] = "still-waiting"
        await service.store.set_state(job["id"], st)
        bridge.queued.add("still-waiting")
    env["clock"].advance_ms(2 * MINUTE)
    due = (await state(service, job["id"]))["next_run_at"]
    await service.tick()
    assert bridge.delivered == []
    st = await state(service, job["id"])
    assert st["last_status"] == "skipped" and st["last_skip_reason"] == reason
    assert st["consecutive_errors"] == 0 and st["backoff_until"] is None
    assert st["next_run_at"] == due + 2 * MINUTE  # a skip still advances the slot
    assert [(r["status"], r["reason"]) for r in await runs(service, job["id"])] == [
        ("skipped", reason)
    ]


async def test_daily_cap_is_a_budget_skip(env) -> None:
    service = env["make"]()
    job = await create(service, minutes=1, policy={"max_runs_per_day": 2})
    for _ in range(3):
        env["clock"].t = (await state(service, job["id"]))["next_run_at"] / 1000
        await service.tick()
        await settle(service)
    assert len(env["bridge"].delivered) == 2
    assert (await runs(service, job["id"]))[0]["reason"] == "budget"


async def test_catch_up_runs_one_slot_per_job_burst_then_spaced(env) -> None:
    service = env["make"]()
    ids = [(await create(service, minutes=1, name=f"j{i}"))["id"] for i in range(7)]
    skip_id = (await create(service, minutes=1, name="skipper", policy={"catch_up": "skip"}))["id"]
    env["clock"].advance_ms(60 * MINUTE)  # an hour of missed slots while "closed"
    env["bridge"].gate = None
    restarted = env["make"]()
    await restarted.start()
    try:
        assert restarted._catch_up_task is not None  # noqa: SLF001
        # The regular tick must leave pending catch-up jobs to the catch-up task.
        await caught_up(restarted)
        await settle(restarted)
        assert len(env["bridge"].delivered) == 7  # one per job, not one per missed slot
        spacing = [s for s in env["sleeps"] if s == CATCH_UP_SPACING_S]
        assert len(spacing) == 7 - CATCH_UP_BURST
        for job_id in ids:
            st = await state(restarted, job_id)
            assert st["next_run_at"] > restarted.now_ms() - CATCH_UP_SPACING_S * 1000
            assert [r["status"] for r in await runs(restarted, job_id)] == ["ok"]
        assert [(r["status"], r["reason"]) for r in await runs(restarted, skip_id)] == [
            ("skipped", "missed")
        ]
    finally:
        await restarted.close()


async def test_a_tick_acting_on_a_stale_listing_does_not_fire_a_caught_up_job_again(env) -> None:
    """The tick reads every job, then fires the overdue ones. When catch-up ran
    a job in between, the tick's row still shows the old next_run_at; starting
    the run must re-check the fresh row or the job is delivered twice."""
    service = env["make"]()
    job = await create(service, minutes=1, name="j0")
    env["clock"].advance_ms(60 * MINUTE)
    stale = await service.store.list_jobs()
    await service._catch_up([job["id"]])  # noqa: SLF001
    await settle(service)
    assert len(env["bridge"].delivered) == 1

    async def stale_listing() -> list[dict]:
        return stale

    service.store.list_jobs = stale_listing  # type: ignore[method-assign]
    await service.tick()
    await settle(service)

    assert len(env["bridge"].delivered) == 1
    assert [r["status"] for r in await runs(service, job["id"])] == ["ok"]


async def test_catch_up_is_sequential(env) -> None:
    service = env["make"]()
    for i in range(3):
        await create(service, minutes=1, name=f"j{i}")
    env["clock"].advance_ms(10 * MINUTE)
    active = {"now": 0, "max": 0}
    bridge = env["bridge"]
    original = bridge.deliver

    async def tracked(action):
        active["now"] += 1
        active["max"] = max(active["max"], active["now"])
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        try:
            return await original(action)
        finally:
            active["now"] -= 1

    bridge.deliver = tracked  # type: ignore[method-assign]
    restarted = env["make"]()
    await restarted.start()
    try:
        await caught_up(restarted)
        assert len(bridge.delivered) == 3 and active["max"] == 1
    finally:
        await restarted.close()


async def test_catch_up_waits_for_a_window(env) -> None:
    service = env["make"]()
    await create(service, minutes=1)
    env["clock"].advance_ms(10 * MINUTE)
    env["bridge"].window = False
    restarted = env["make"]()
    original_sleep = restarted._sleep  # noqa: SLF001

    async def window_appears(seconds: float) -> None:
        await original_sleep(seconds)
        env["bridge"].window = True

    restarted._sleep = window_appears  # noqa: SLF001
    await restarted.start()
    try:
        await caught_up(restarted)
        await settle(restarted)
        assert len(env["bridge"].delivered) == 1
    finally:
        await restarted.close()


async def test_state_survives_a_rebuilt_service(env) -> None:
    service = env["make"]()
    job = await create(service)
    env["bridge"].outcomes = [{"status": "error", "detail": "boom"}]
    env["clock"].advance_ms(2 * MINUTE)
    await service.tick()
    await settle(service)
    rebuilt = env["make"]()
    st = await state(rebuilt, job["id"])
    assert st["consecutive_errors"] == 1 and st["last_error"] == "boom"
    assert (await rebuilt.list())["jobs"][0]["id"] == job["id"]


async def test_disabled_job_never_fires_and_reenable_does_not_fire_stale_slot(env) -> None:
    service = env["make"]()
    job = await create(service)
    await service.set_enabled(job["id"], False)
    env["clock"].advance_ms(30 * MINUTE)
    await service.tick()
    assert env["bridge"].delivered == []
    await service.set_enabled(job["id"], True)
    await service.tick()
    assert env["bridge"].delivered == []
    assert (await state(service, job["id"]))["next_run_at"] > service.now_ms()


async def test_run_now_is_manual_and_clears_backoff(env) -> None:
    service = env["make"]()
    job = await create(service)
    st = await state(service, job["id"])
    st.update(consecutive_errors=3, backoff_until=service.now_ms() + 3_600_000)
    await service.store.set_state(job["id"], st)
    due = st["next_run_at"]
    answer = await service.run_now(job["id"])
    assert answer == {"ok": True, "enqueued": True}
    await settle(service)
    st = await state(service, job["id"])
    assert st["consecutive_errors"] == 0 and st["backoff_until"] is None
    assert st["next_run_at"] == due  # a manual run is not a slot


async def test_runs_are_trimmed_per_job(env) -> None:
    service = env["make"]()
    job = await create(service)
    for i in range(RUNS_PER_JOB + 5):
        await service.store.append_run(job["id"], {"started_at": i, "status": "skipped"})
    rows = await service.store.list_runs(job["id"], 1000)
    assert len(rows) == RUNS_PER_JOB and rows[0]["started_at"] == RUNS_PER_JOB + 4


async def test_remove_drops_job_and_runs(env) -> None:
    service = env["make"]()
    job = await create(service)
    await service.store.append_run(job["id"], {"started_at": 1, "status": "ok"})
    assert await service.remove(job["id"]) == {"ok": True}
    assert (await service.remove(job["id"]))["ok"] is False
    assert await service.store.list_runs(job["id"], 10) == []


async def test_target_gone_is_a_skip(env) -> None:
    service = env["make"]()
    job = await create(service, action={"kind": "message", "workspace": "/ws", "pane_id": "p-9", "text": "x"})
    env["bridge"].outcomes = [{"status": "skipped", "reason": "target_gone", "detail": "gone"}]
    env["clock"].advance_ms(2 * MINUTE)
    await service.tick()
    await settle(service)
    st = await state(service, job["id"])
    assert st["last_status"] == "skipped" and st["consecutive_errors"] == 0
    assert st["last_skip_reason"] == "target_gone"
    # The next real outcome clears it.
    env["clock"].t = st["next_run_at"] / 1000
    await service.tick()
    await settle(service)
    st = await state(service, job["id"])
    assert st["last_status"] == "ok" and st["last_skip_reason"] is None


def test_outcome_mapping() -> None:
    assert outcome_of_send({"ok": False, "error_code": "unknown-pane-id", "error": "x"})["reason"] == "target_gone"
    assert outcome_of_send({"ok": False, "error_code": "target-offline", "error": "x"})["reason"] == "no_window"
    assert outcome_of_send({"ok": False, "error_code": "unknown-target", "error": "x"})["status"] == "error"
    assert outcome_of_send({"ok": True, "msg_key": "k", "status": "delivered"})["status"] == "ok"
    queued = outcome_of_send({"ok": True, "msg_key": "k", "status": "queued", "hold": {"key": "mid-turn"}})
    assert queued == {"status": "ok", "detail": "queued (mid-turn)", "msg_key": "k"}
    assert outcome_of_send({"ok": True, "msg_key": "k", "status": "failed", "reason": "r"})["status"] == "error"


async def test_live_bridge_delivers_by_pane_id_through_cli_send_path(monkeypatch) -> None:
    from agent_team_backend.mcp_server import server as mcp

    calls: list = []

    async def fake_send(caller, to, text, **kwargs):
        calls.append((caller.kind, to, text, kwargs))
        return {"ok": True, "msg_key": "m1", "status": "delivered"}

    monkeypatch.setattr(mcp, "_send", fake_send)
    bridge = sched_mod.LiveBridge()
    out = await bridge.deliver({"kind": "message", "workspace": "/ws", "pane_id": "p-1", "pane_name": "w", "text": "go"})
    assert out["status"] == "ok"
    kind, to, text, kwargs = calls[0]
    assert kind == "host" and to == "" and text == "go"
    assert kwargs["pane_id"] == "p-1" and kwargs["open_target"] is True
    assert kwargs["wait_for_delivery_s"] == sched_mod.DELIVERY_WAIT_S
    await bridge.deliver({"kind": "message", "workspace": "/ws/", "pane_name": "w", "text": "go"})
    assert calls[1][1] == "/ws/w" and calls[1][3]["pane_id"] == ""


async def test_pane_id_gone_never_falls_back_to_same_name(monkeypatch, tmp_path) -> None:
    """Real cli_send path: an unknown pane_id is refused even when a pane of the
    job's pane_name exists — the run is skipped as target_gone."""
    from agent_team_backend import agent_messaging, app
    from agent_team_backend.mcp_server import server as mcp

    agent_messaging._reset_for_test()
    ws = str(tmp_path)
    agent_messaging.register("live-1", "worker", ws, "claude")
    sent: list = []

    async def fake_broadcast(event, **_kw):
        sent.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    try:
        bridge = sched_mod.LiveBridge()
        out = await bridge.deliver(
            {"kind": "message", "workspace": ws, "pane_id": "gone-9", "pane_name": "worker", "text": "go"}
        )
        assert out["status"] == "skipped" and out["reason"] == "target_gone"
        assert sent == []
        # And the exact id reaches exactly that pane.
        monkeypatch.setattr(sched_mod, "DELIVERY_WAIT_S", 0)
        out = await bridge.deliver(
            {"kind": "message", "workspace": ws, "pane_id": "live-1", "text": "go"}
        )
        assert out["status"] == "ok"
        deliver = [e for e in sent if e["type"] == "agent_msg.deliver"]
        assert deliver[0]["payload"]["target_pane_id"] == "live-1"
        assert deliver[0]["payload"]["rate_limit"] is True
    finally:
        agent_messaging._reset_for_test()


# ── once ───────────────────────────────────────────────────────────────────


def once_job(in_ms: int = 5 * MINUTE, **over) -> dict:
    return every_job(schedule={"kind": "once", "in_ms": in_ms}, **over)


async def job_row(service: SchedulerService, job_id: str) -> dict:
    return await service.store.get_job(job_id)


@pytest.mark.parametrize("outcome", [
    {"status": "ok", "detail": "delivered", "msg_key": "k"},
    {"status": "error", "detail": "boom"},
    {"status": "skipped", "reason": "target_gone", "detail": "gone"},
])
async def test_once_runs_once_then_disables_itself(env, outcome) -> None:
    service = env["make"]()
    job = (await service.upsert(once_job()))["job"]
    env["bridge"].outcomes = [outcome]
    env["clock"].advance_ms(5 * MINUTE)
    await service.tick()
    await settle(service)
    row = await job_row(service, job["id"])
    assert row["enabled"] is False
    assert row["state"]["last_status"] == outcome["status"]
    assert row["state"]["next_run_at"] is None
    env["clock"].advance_ms(60 * MINUTE)
    await service.tick()
    assert len(env["bridge"].delivered) == 1


async def test_once_gate_skip_also_disables(env) -> None:
    service = env["make"]()
    job = (await service.upsert(once_job()))["job"]
    env["bridge"].window = False
    env["clock"].advance_ms(5 * MINUTE)
    await service.tick()
    row = await job_row(service, job["id"])
    assert row["enabled"] is False and row["state"]["last_skip_reason"] == "no_window"
    assert env["bridge"].delivered == []


async def test_once_missed_while_closed_is_caught_up_once(env) -> None:
    service = env["make"]()
    job = (await service.upsert(once_job()))["job"]
    env["clock"].advance_ms(60 * MINUTE)
    restarted = env["make"]()
    await restarted.start()
    try:
        await caught_up(restarted)
        await settle(restarted)
        assert len(env["bridge"].delivered) == 1
        row = await job_row(restarted, job["id"])
        assert row["enabled"] is False and row["state"]["last_status"] == "ok"
    finally:
        await restarted.close()


async def test_once_missed_with_catch_up_skip_is_recorded_and_disabled(env) -> None:
    service = env["make"]()
    job = (await service.upsert(once_job(policy={"catch_up": "skip"})))["job"]
    env["clock"].advance_ms(60 * MINUTE)
    restarted = env["make"]()
    await restarted.start()
    try:
        row = await job_row(restarted, job["id"])
        assert row["enabled"] is False and row["state"]["last_skip_reason"] == "missed"
        assert restarted._catch_up_task is None  # noqa: SLF001
        assert env["bridge"].delivered == []
    finally:
        await restarted.close()


async def test_reenabling_a_passed_once_job_is_refused(env) -> None:
    service = env["make"]()
    job = (await service.upsert(once_job()))["job"]
    env["clock"].advance_ms(5 * MINUTE)
    await service.tick()
    await settle(service)
    answer = await service.set_enabled(job["id"], True)
    assert answer["ok"] is False and "time has passed" in answer["error"]
    assert (await job_row(service, job["id"]))["enabled"] is False


async def test_reenabling_a_future_once_job_keeps_its_moment(env) -> None:
    service = env["make"]()
    job = (await service.upsert(once_job(in_ms=30 * MINUTE)))["job"]
    await service.set_enabled(job["id"], False)
    assert await service.set_enabled(job["id"], True) == {"ok": True}
    assert (await state(service, job["id"]))["next_run_at"] == job["schedule"]["at_ms"]


async def test_run_now_works_on_a_once_job(env) -> None:
    service = env["make"]()
    job = (await service.upsert(once_job(in_ms=30 * MINUTE)))["job"]
    assert await service.run_now(job["id"]) == {"ok": True, "enqueued": True}
    await settle(service)
    row = await job_row(service, job["id"])
    # A manual run is not its slot: the job stays armed for its moment.
    assert row["enabled"] is True and row["state"]["next_run_at"] == job["schedule"]["at_ms"]
    assert len(env["bridge"].delivered) == 1
