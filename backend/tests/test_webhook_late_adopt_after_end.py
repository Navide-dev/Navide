"""Reproduces the Linux VM round-12 webhook 409 (0.2.39 candidate e6f70c5a5).

Sequence observed: ui.pipeline.start went unanswered for 60 s (the event loop
stalled 21.7 s on a synchronous SQLite COMMIT and the window's reply came
late); meanwhile the run had been adopted by run_started, aborted by design
and closed by the watchdog (_check_run → _ended). When the start finally
answered ui_action_timeout, _adopted_late saw no open row for the workspace
and treated the run as "never adopted": it polled LATE_START_S (120 s) with
the workspace still in _starting, so every trigger in that window got 409
run-active although the workspace was idle.

Expected: a run that was adopted — even one that has already ended — is a
started run; the late-adopt wait is for a run that never came up.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import webhook_service as svc
from agent_team_backend import webhook_triggers as wt
from agent_team_backend.db import Database

WS = "/ws/one"
PIPE = "p1"
SHA = "a" * 64


def _graph() -> dict[str, Any]:
    # trigger → gate → slot: the shape binding_problem accepts without a
    # no_gate_ack (same as test_webhook_service.graph(GATE, slot("a"))).
    gate = {"id": "g", "kind": "gate", "gate": {"prompt": "go?"}}
    slot = {"id": "a", "kind": "slot", "slot": {"agentKey": "claude"}}
    return {
        "nodes": [{"id": "t", "kind": "trigger"}, gate, slot],
        "edges": [
            {"id": "t-g", "from": "t", "to": "g", "kind": "next"},
            {"id": "g-a", "from": "g", "to": "a", "kind": "next"},
        ],
    }


class Window:
    def __init__(self) -> None:
        self.hold = asyncio.Event()
        self.answer: dict[str, Any] = {"ok": False, "error_code": "ui_action_timeout", "error": "no answer"}
        self.status: dict[str, Any] = {"active": True, "state": "running", "gate": {}}

    async def probe(self, workspace: str) -> bool:
        return True

    async def app_lock(self, workspace: str) -> str:
        return "unlocked"

    async def run_active(self, workspace: str) -> bool:
        return False  # the window is idle again: only _starting can refuse

    async def run_status(self, workspace: str) -> dict[str, Any]:
        return self.status

    async def pane_awaiting(self, workspace: str, pane_id: str) -> bool:
        return False

    async def abort(self, workspace: str) -> None:
        pass

    async def interrupt(self, workspace: str, pane_id: str) -> None:
        pass

    async def reclaim(self, workspace: str, pane_id: str) -> bool:
        return True

    async def start(self, workspace: str, task: str, pipeline_id: str, taint_detail: str) -> dict[str, Any]:
        await self.hold.wait()
        return self.answer


@pytest.fixture
def env(tmp_path):
    db = Database(tmp_path / "navide.db")
    store = wt.WebhookStore(db)
    window = Window()
    pipelines = {PIPE: {"id": PIPE, "graph": _graph()}}
    service = svc.WebhookService(
        store=store, db=db, window=window, pipeline=pipelines.get, known_program=lambda agent, program: program == agent,
    )
    trigger, _ = store.create(name="CI", workspace=WS, pipeline_id=PIPE)
    return SimpleNamespace(service=service, store=store, window=window, trigger=trigger)


async def _settle(env) -> None:
    while env.service._tasks:
        await asyncio.gather(*list(env.service._tasks))


@pytest.mark.asyncio
async def test_adopted_run_that_ended_before_the_late_answer_frees_the_workspace(env, monkeypatch) -> None:
    # Production value: the bug is that this whole window is waited out.
    monkeypatch.setattr(svc, "LATE_START_S", 120.0)
    monkeypatch.setattr(svc, "LATE_START_POLL_S", 0.01)

    status, _, outcome = await env.service.accept(env.trigger, "hello", SHA)
    assert (status, outcome) == (202, "accepted")
    await asyncio.sleep(0)  # _start is now inside window.start

    # The window did start the run: pipeline.start adopted it ...
    env.service.run_started(
        SimpleNamespace(workspace_path=WS, id="run1", log_file_name="runs/x/pipeline.log", pipeline_id=PIPE),
        child=False, ended="finished",
    )
    assert WS in env.service._active
    # ... the run failed by design and the watchdog closed its row (VM: abort
    # 13:59:25, watchdog tick before the 60 s start timeout at 13:59:44).
    env.window.status = {"active": False, "state": "aborted", "gate": {}}
    await env.service.tick()
    assert WS not in env.service._active

    # Now the start answers "unanswered within 60 s".
    env.window.hold.set()
    # A started run needs no late-adopt wait: _start must finish promptly ...
    await asyncio.wait_for(_settle(env), timeout=2.0)
    assert WS not in env.service._starting
    # ... and the next trigger on the idle workspace is accepted, not 409.
    status, _, outcome = await env.service.accept(env.trigger, "again", "b" * 64)
    assert (status, outcome) == (202, "accepted")
    first = env.store.events(env.trigger["id"])[-1] if env.store.events(env.trigger["id"]) else None
    assert first is not None and first["outcome"] == "started"
