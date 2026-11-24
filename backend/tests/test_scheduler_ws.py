"""WS contract of scheduler.*: BAD_REQUEST vs {ok:false}, success, and the
scheduler.changed broadcast that skips the requesting window."""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_team_backend import app as app_module
from agent_team_backend import scheduler as sched_mod
from agent_team_backend import ws_handlers
from agent_team_backend.db import Database
from agent_team_backend.scheduler import SchedulerService
from agent_team_backend.scheduler_store import SchedulerStore


class _Session:
    def __init__(self) -> None:
        self.sent: list = []

    @property
    def last(self) -> dict:
        assert self.sent, "the handler must answer the request"
        return self.sent[-1]

    async def send_json(self, message: dict) -> None:
        self.sent.append(message)


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
    db = Database(tmp_path / "navide.db")
    events: list = []

    async def fake_broadcast(event: dict, *, exclude=None) -> None:
        events.append((event, exclude))

    monkeypatch.setattr(app_module, "broadcast", fake_broadcast)
    bridge = _Bridge()
    service = SchedulerService(SchedulerStore(db), clock=lambda: 1_800_000_000.0, bridge=bridge)
    monkeypatch.setattr(sched_mod, "_service", service)
    yield {"service": service, "events": events, "bridge": bridge}
    db.close()


async def call(session: _Session, msg_type: str, payload: dict) -> dict:
    handler = ws_handlers.lookup(msg_type)
    assert handler is not None, msg_type
    await handler(session, "m1", msg_type, payload)
    return session.last


JOB = {
    "name": "report",
    "schedule": {"kind": "daily", "at": "09:00", "tz": "Asia/Taipei"},
    "action": {"kind": "message", "workspace": "/ws", "pane_name": "report", "text": "go"},
}


async def create(session: _Session) -> dict:
    reply = await call(session, "scheduler.upsert", {"job": JOB})
    assert reply["ok"] is True
    return reply["payload"]["job"]


def changed(events: list) -> list:
    return [(e, ex) for e, ex in events if e["type"] == "scheduler.changed"]


async def test_all_handlers_are_registered() -> None:
    for name in ("list", "upsert", "remove", "set_enabled", "run_now", "runs", "adopt", "keep"):
        assert ws_handlers.lookup(f"scheduler.{name}") is not None


async def test_list(wired) -> None:
    session = _Session()
    job = await create(session)
    reply = await call(session, "scheduler.list", {})
    assert reply["payload"]["ok"] is True
    assert [j["id"] for j in reply["payload"]["jobs"]] == [job["id"]]
    assert reply["payload"]["now"] == 1_800_000_000_000


async def test_upsert_success_then_broadcast_excluding_requester(wired) -> None:
    session = _Session()
    job = await create(session)
    assert job["name"] == "report" and job["state"]["next_run_at"]
    events = changed(wired["events"])
    assert len(events) == 1
    event, exclude = events[0]
    assert exclude is session
    assert [j["id"] for j in event["payload"]["jobs"]] == [job["id"]]
    # The response went out before the broadcast.
    assert session.sent[0]["type"] == "scheduler.upsert.result"


@pytest.mark.parametrize(
    "payload",
    [{}, {"job": "x"}, {"job": {**JOB, "schedule": {"kind": "cron"}}}, {"job": {**JOB, "id": "nope"}}],
)
async def test_upsert_bad_request(wired, payload) -> None:
    session = _Session()
    reply = await call(session, "scheduler.upsert", payload)
    assert reply["ok"] is False and reply["error"]["code"] == "BAD_REQUEST"
    assert changed(wired["events"]) == []


async def test_remove(wired) -> None:
    session = _Session()
    job = await create(session)
    wired["events"].clear()
    assert (await call(session, "scheduler.remove", {}))["error"]["code"] == "BAD_REQUEST"
    reply = await call(session, "scheduler.remove", {"id": job["id"]})
    assert reply["payload"] == {"ok": True}
    assert changed(wired["events"])[0][1] is session
    wired["events"].clear()
    reply = await call(session, "scheduler.remove", {"id": job["id"]})
    assert reply["ok"] is True and reply["payload"]["ok"] is False and reply["payload"]["error"]
    assert changed(wired["events"]) == []


async def test_set_enabled(wired) -> None:
    session = _Session()
    job = await create(session)
    wired["events"].clear()
    bad = await call(session, "scheduler.set_enabled", {"id": job["id"], "enabled": "yes"})
    assert bad["error"]["code"] == "BAD_REQUEST"
    reply = await call(session, "scheduler.set_enabled", {"id": job["id"], "enabled": False})
    assert reply["payload"] == {"ok": True}
    assert changed(wired["events"])[0][1] is session
    listed = (await call(session, "scheduler.list", {}))["payload"]["jobs"]
    assert listed[0]["enabled"] is False
    missing = await call(session, "scheduler.set_enabled", {"id": "nope", "enabled": True})
    assert missing["payload"]["ok"] is False


async def test_run_now(wired) -> None:
    session = _Session()
    job = await create(session)
    assert (await call(session, "scheduler.run_now", {}))["error"]["code"] == "BAD_REQUEST"
    reply = await call(session, "scheduler.run_now", {"id": job["id"]})
    assert reply["payload"] == {"ok": True, "enqueued": True}
    for task, _manual in list(wired["service"]._runs.values()):  # noqa: SLF001
        await task
    assert len(wired["bridge"].delivered) == 1
    missing = await call(session, "scheduler.run_now", {"id": "nope"})
    assert missing["payload"]["ok"] is False


async def test_runs(wired) -> None:
    session = _Session()
    job = await create(session)
    await wired["service"].store.append_run(job["id"], {"started_at": 1, "status": "ok"})
    reply = await call(session, "scheduler.runs", {"id": job["id"], "limit": 5})
    assert reply["payload"]["ok"] is True and len(reply["payload"]["runs"]) == 1
    assert (await call(session, "scheduler.runs", {"id": job["id"], "limit": "x"}))["error"]["code"] == "BAD_REQUEST"
    assert (await call(session, "scheduler.runs", {}))["error"]["code"] == "BAD_REQUEST"
    assert (await call(session, "scheduler.runs", {"id": "nope"}))["payload"]["ok"] is False


async def test_adopt_makes_a_job_the_users(wired) -> None:
    session = _Session()
    job = await create(session)
    await wired["service"].store.put_job({**job, "owner": {"kind": "external"}})
    wired["events"].clear()
    assert (await call(session, "scheduler.adopt", {}))["error"]["code"] == "BAD_REQUEST"
    reply = await call(session, "scheduler.adopt", {"id": job["id"]})
    assert reply["payload"]["ok"] is True and reply["payload"]["job"]["owner"] == {"kind": "user"}
    assert changed(wired["events"])[0][1] is session
    assert (await call(session, "scheduler.adopt", {"id": "nope"}))["payload"]["ok"] is False


async def test_keep_stops_an_agent_job_from_expiring(wired) -> None:
    session = _Session()
    job = await create(session)
    await wired["service"].store.put_job({**job, "owner": {"kind": "external", "expires_at": 5}})
    wired["events"].clear()
    assert (await call(session, "scheduler.keep", {}))["error"]["code"] == "BAD_REQUEST"
    reply = await call(session, "scheduler.keep", {"id": job["id"]})
    assert reply["payload"]["job"]["owner"] == {"kind": "external", "expires_at": None}
    assert changed(wired["events"])[0][1] is session


async def test_settings_get_and_set(wired) -> None:
    session = _Session()
    reply = await call(session, "scheduler.settings.get", {})
    assert reply["payload"] == {"ok": True, "settings": {
        "max_runs_per_day": 24, "agent_max_runs_per_day": 288, "agent_runs_per_day": 300,
    }}
    reply = await call(session, "scheduler.settings.set", {"settings": {"agent_runs_per_day": None}})
    assert reply["payload"]["settings"]["agent_runs_per_day"] is None
    assert len(changed(wired["events"])) == 1
    reply = await call(session, "scheduler.settings.set", {"settings": {"max_runs_per_day": 0}})
    assert reply["ok"] is False and reply["error"]["code"] == "BAD_REQUEST"
