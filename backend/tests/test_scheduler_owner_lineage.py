"""A pane-owned job's owner follows the session lineage: a pane that resumes
exactly the session its gone owner held inherits the job, and the hop is
recorded. A different session, a pane name, or an owner that is merely not
registered yet (a backend restart) never moves it."""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend import scheduler as sched_mod
from agent_team_backend.db import Database
from agent_team_backend.scheduler import NOT_OWNER, SchedulerService
from agent_team_backend.scheduler_store import SchedulerStore

MINUTE = 60_000


class Bridge:
    def has_window(self) -> bool:
        return True

    def still_queued(self, msg_key: str | None) -> bool:
        return False

    async def budget_limited(self, action: dict) -> bool:
        return False

    async def deliver(self, action: dict) -> dict:
        return {"status": "ok", "msg_key": "k"}

    async def notify_disabled(self, job: dict) -> None:
        pass


@pytest.fixture
def service(tmp_path: Path, monkeypatch):
    agent_messaging._reset_for_test()
    db = Database(tmp_path / "navide.db")

    async def notify(jobs: list) -> None:
        pass

    svc = SchedulerService(SchedulerStore(db), clock=lambda: 1_800_000_000.0,
                           bridge=Bridge(), notify=notify)
    monkeypatch.setattr(sched_mod, "_service", svc)
    yield svc
    db.close()
    agent_messaging._reset_for_test()


def actor(pane_id: str, name: str = "watcher") -> dict:
    return {"kind": "pane", "pane_id": pane_id, "pane_name": name, "workspace": "/ws"}


def job_def(target: str = "boss-1") -> dict:
    return {
        "name": "poll",
        "schedule": {"kind": "every", "every_ms": 60 * MINUTE},
        "action": {"kind": "message", "workspace": "/ws", "pane_id": target, "text": "poll"},
    }


async def owned_job(service: SchedulerService, owner_pane: str) -> dict:
    agent_messaging.register(owner_pane, "watcher", "/ws", "claude")
    job = (await service.upsert(job_def(), actor(owner_pane)))["job"]
    agent_messaging.unregister(owner_pane)
    return job


class Ws:
    async def send_json(self, payload: dict) -> None:
        pass


@pytest.fixture
def workspace(tmp_path: Path):
    path = tmp_path / "proj"
    path.mkdir()
    return str(path)


async def ws_call(kind: str, payload: dict) -> None:
    await app.handle_message(app.Session(Ws()), {  # type: ignore[arg-type]
        "id": "m", "type": kind, "payload": payload,
    })


async def spawn(ws: str, **payload) -> None:
    await ws_call("manual_pane.spawn",
                  {"workspace_path": ws, "agent": "claude", "command": "claude", **payload})


async def close(ws: str, pane_id: str) -> None:
    await ws_call("manual_pane.unspawn", {"workspace_path": ws, "pane_id": pane_id})


# ── service level ───────────────────────────────────────────────────────────


async def test_exact_session_inherits_and_is_recorded(service) -> None:
    job = await owned_job(service, "old-1")
    moved = await service.inherit_owner({"old-1"}, "new-2", "sess-a")
    assert moved == [job["id"]]
    stored = await service.store.get_job(job["id"])
    assert stored["owner"]["pane_id"] == "new-2"
    assert stored["owner"]["pane_name"] == "watcher"
    assert stored["state"]["owner_inherited"]["from"] == "old-1"
    assert stored["state"]["owner_inherited"]["to"] == "new-2"
    assert stored["state"]["owner_inherited"]["session_id"] == "sess-a"
    # The inheriting pane may now change it; nobody else may.
    agent_messaging.register("new-2", "watcher", "/ws", "claude")
    assert (await service.set_enabled(job["id"], False, actor("new-2")))["ok"] is True
    agent_messaging.register("other-3", "other", "/ws", "claude")
    refused = await service.set_enabled(job["id"], True, actor("other-3", "other"))
    assert refused["code"] == NOT_OWNER


async def test_a_live_owner_is_never_taken_over(service) -> None:
    job = await owned_job(service, "old-1")
    agent_messaging.register("old-1", "watcher", "/ws", "claude")
    assert await service.inherit_owner({"old-1"}, "new-2", "sess-a") == []
    assert (await service.store.get_job(job["id"]))["owner"]["pane_id"] == "old-1"


async def test_inherit_touches_only_jobs_owned_by_the_lineage(service) -> None:
    mine = await owned_job(service, "old-1")
    theirs = await owned_job(service, "else-9")
    user_job = (await service.upsert(job_def()))["job"]
    assert await service.inherit_owner({"old-1"}, "new-2", "sess-a") == [mine["id"]]
    assert (await service.store.get_job(theirs["id"]))["owner"]["pane_id"] == "else-9"
    assert (await service.store.get_job(user_job["id"]))["owner"] == {"kind": "user"}


async def test_rebuild_with_the_same_session_moves_the_owner_too(service) -> None:
    job = await owned_job(service, "old-1")
    await service.rebind_after_rebuild("old-1", "new-2", "sess-a", "sess-a")
    stored = await service.store.get_job(job["id"])
    assert stored["owner"]["pane_id"] == "new-2"
    assert stored["state"]["owner_inherited"]["from"] == "old-1"


@pytest.mark.parametrize("before,after", [("sess-a", "sess-b"), ("", "sess-a"), ("sess-a", "")])
async def test_rebuild_with_another_session_keeps_the_owner(service, before, after) -> None:
    job = await owned_job(service, "old-1")
    await service.rebind_after_rebuild("old-1", "new-2", before, after)
    stored = await service.store.get_job(job["id"])
    assert stored["owner"]["pane_id"] == "old-1"
    assert "owner_inherited" not in stored["state"]


# ── the real WS path: close a pane, resume its conversation in a new one ────


async def test_resuming_the_closed_owners_session_inherits(service, workspace) -> None:
    await spawn(workspace, pane_id="old-1", session_id="sess-a")
    job = await owned_job(service, "old-1")
    await close(workspace, "old-1")
    await spawn(workspace, pane_id="new-2", session_id="sess-a")
    assert (await service.store.get_job(job["id"]))["owner"]["pane_id"] == "new-2"


async def test_resuming_another_session_does_not_inherit(service, workspace) -> None:
    await spawn(workspace, pane_id="old-1", session_id="sess-a")
    job = await owned_job(service, "old-1")
    await close(workspace, "old-1")
    await spawn(workspace, pane_id="new-2", session_id="sess-b")
    await spawn(workspace, pane_id="new-3")
    assert (await service.store.get_job(job["id"]))["owner"]["pane_id"] == "old-1"


async def test_a_pane_name_alone_never_inherits(service, workspace) -> None:
    await spawn(workspace, pane_id="old-1", session_id="sess-a", role="watcher")
    job = await owned_job(service, "old-1")
    await close(workspace, "old-1")
    agent_messaging.register("new-2", "watcher", "/ws", "claude")
    await spawn(workspace, pane_id="new-2", session_id="sess-z", role="watcher")
    assert (await service.store.get_job(job["id"]))["owner"]["pane_id"] == "old-1"


async def test_owner_not_yet_registered_after_restart_is_not_taken(service, workspace) -> None:
    """After a backend restart the owner's pane is not registered yet, so it
    reads as gone; its record was never closed, so a second pane resuming the
    same conversation must not take the job from it."""
    await spawn(workspace, pane_id="old-1", session_id="sess-a")
    job = await owned_job(service, "old-1")
    assert sched_mod.owner_gone((await service.store.get_job(job["id"]))["owner"])
    await spawn(workspace, pane_id="second-2", session_id="sess-a")
    assert (await service.store.get_job(job["id"]))["owner"]["pane_id"] == "old-1"
