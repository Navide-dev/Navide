"""pipeline.start and pipeline.slot_spawn commit off the event loop.

0.2.39's VM run measured a single SQLite commit's fsync at 21.7s; the handlers
committed on the loop, so every window froze for that long. The writes now go
to db_executor's single worker: the loop keeps answering while a slow commit
runs, and a slot_spawn still lands after the start that created its run.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from types import SimpleNamespace

import pytest

from agent_team_backend import app as app_module
from agent_team_backend import loop_watchdog, webhook_service, ws_handlers

SLOW_COMMIT_S = 2.0
WS = "/tmp/navide-db-off-loop-ws"


class _Session:
    def __init__(self) -> None:
        self.sent: list = []
        self.dead = False
        self.window_id = "win-1"
        self.held_workspaces = ()

    async def send_json(self, message: dict) -> None:
        self.sent.append(message)


class _SlowStore:
    """A project store whose every commit waits on a slow disk."""

    def __init__(self) -> None:
        self.landed: list[str] = []
        self.threads: list[int] = []
        self.project = SimpleNamespace(
            workspace_path=WS, pipeline_id="p1", log_file_name="", id="proj-1",
            task_description="t", state="running",
        )

    def peek(self, _ws: str):
        return None

    def _commit(self, what: str):
        time.sleep(SLOW_COMMIT_S)
        self.threads.append(threading.get_ident())
        self.landed.append(what)
        return self.project

    def start_pipeline(self, _ws: str, **_kw):
        return self._commit("start")

    def record_slot_spawn(self, _ws: str, **_kw):
        return self._commit("slot_spawn")


@pytest.fixture
def store(monkeypatch: pytest.MonkeyPatch) -> _SlowStore:
    s = _SlowStore()

    async def fake_broadcast(_event: dict) -> None:
        pass

    monkeypatch.setattr(app_module, "project_store", s, raising=False)
    monkeypatch.setattr(app_module, "broadcast", fake_broadcast, raising=False)
    monkeypatch.setattr(app_module, "_project_payload", lambda p: {"id": p.id}, raising=False)
    monkeypatch.setattr(app_module, "_register_workspace_and_backfill", lambda _ws: None, raising=False)
    monkeypatch.setattr(app_module, "tokens_store", SimpleNamespace(
        start_run=lambda *a, **k: {}, snapshot=lambda _ws: {}), raising=False)
    monkeypatch.setattr(app_module, "pane_account_history", SimpleNamespace(
        pin=lambda *a: None), raising=False)
    monkeypatch.setattr(ws_handlers, "_mirror_pipeline_state", lambda _p: None)
    monkeypatch.setattr(ws_handlers, "_profile_pin_for_bookkeeping", lambda *a: "")
    monkeypatch.setattr(ws_handlers, "pipeline_liveness", SimpleNamespace(claim_run=lambda *a: None))
    monkeypatch.setattr(webhook_service, "current", lambda: None)
    return s


async def _call(type_: str, payload: dict) -> _Session:
    session = _Session()
    await ws_handlers.lookup(type_)(session, "m1", type_, payload)
    return session


async def test_loop_answers_while_start_and_slot_spawn_commit(
    store: _SlowStore, caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.WARNING, logger="agent_team_backend.loop_watchdog")
    loop_watchdog.start(asyncio.get_running_loop())
    async def probe() -> float:
        began = time.monotonic()
        await asyncio.sleep(0.1)
        return time.monotonic() - began

    try:
        probing = asyncio.create_task(probe())
        start = asyncio.create_task(_call("pipeline.start", {
            "workspace_path": WS, "task_description": "t", "total_stages": 1,
            "stage_blueprint": [{}], "pipeline_id": "p1",
        }))
        slot = asyncio.create_task(_call("pipeline.slot_spawn", {
            "workspace_path": WS, "stage_index": 0, "slot_label": "a", "pane_id": "pane-1",
        }))
        probe_latency = await probing
        sessions = await asyncio.gather(start, slot)
    finally:
        await loop_watchdog.stop()

    assert probe_latency < 0.3, f"the loop was blocked for {probe_latency:.2f}s"
    assert not [r for r in caplog.records if "stalled" in r.getMessage()]
    assert store.landed == ["start", "slot_spawn"]
    assert threading.get_ident() not in store.threads
    for session in sessions:
        assert session.sent and session.sent[-1]["ok"] is True, session.sent
