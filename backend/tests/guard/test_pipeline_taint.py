"""A pipeline run started by a tainted caller taints the panes it spawns."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app, ws_handlers
from agent_team_backend.guard import is_tainted, mark_tainted, taint
from agent_team_backend.mcp_server import server as plan_mcp, wiring as plan_mcp_wiring

pytestmark = pytest.mark.asyncio

WS = "/ws/alpha"


@pytest.fixture(autouse=True)
def _runs():
    taint._reset_pipeline_runs_for_test()
    yield
    taint._reset_pipeline_runs_for_test()


class _Store:
    """Just enough project_store for the two spawn handlers and pipeline.start."""

    def start_pipeline(self, workspace_path, **_kw):
        return SimpleNamespace(workspace_path=workspace_path, log_file_name="", id="run", task_description="")

    def record_slot_spawn(self, workspace_path, **_kw):
        return SimpleNamespace(workspace_path=workspace_path)

    def record_stage_spawn(self, workspace_path, **_kw):
        return SimpleNamespace(workspace_path=workspace_path)


class _Session:
    async def send_json(self, _event: dict) -> None:
        pass


@pytest.fixture
def window(monkeypatch):
    """Stand in for the window: on ui.pipeline.start it records the run and
    spawns two slots through the real ws handlers."""
    monkeypatch.setattr(app, "project_store", _Store())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    monkeypatch.setattr(ws_handlers, "_mirror_pipeline_state", lambda _p: None)
    monkeypatch.setattr(app, "tokens_store", SimpleNamespace(start_run=lambda *a, **k: None, snapshot=lambda _ws: {}))
    monkeypatch.setattr(app, "_project_payload", lambda _p: {})
    monkeypatch.setattr(app, "pane_account_history", SimpleNamespace(pin=lambda *a: None))
    monkeypatch.setattr(ws_handlers, "_profile_pin_for_bookkeeping", lambda *a: "")

    async def quiet(*_a, **_k):
        pass

    monkeypatch.setattr(app, "broadcast", quiet)
    spawned: list[list[str]] = []

    async def fake_ui_request(workspace_path, op, *, caller=None, action=None, args=None, is_global=False):
        n = len(spawned)
        panes = [f"slot-{n}-a", f"stage-{n}-b"]
        s = _Session()
        await ws_handlers.pipeline_start(s, "m", "pipeline.start", {"workspace_path": workspace_path + "/"})
        await ws_handlers.pipeline_slot_spawn(s, "m", "pipeline.slot_spawn", {
            "workspace_path": workspace_path, "stage_index": 0, "slot_label": "a", "pane_id": panes[0],
        })
        await ws_handlers.pipeline_stage_spawn(s, "m", "pipeline.stage_spawn", {
            "workspace_path": workspace_path, "stage_index": 1, "pane_id": panes[1],
        })
        spawned.append(panes)
        return {"ok": True, "result": {"state": "running"}, "error": None}

    monkeypatch.setattr(plan_mcp, "_ui_request", fake_ui_request)
    return spawned


def _ctx(pane_id: str) -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))


async def test_a_tainted_caller_taints_the_run_it_starts_and_only_that_run(window) -> None:
    agent_messaging.register("pa", "lead", WS, agent_key="claude")
    mark_tainted("pa", "remote", "chat message")
    assert (await plan_mcp.pipeline_start(_ctx("pa"), task="t", workspace_path=WS))["ok"]
    assert all(is_tainted(p) for p in window[0])

    # The next run, started by someone untainted, is clean.
    agent_messaging.register("pc", "clean", WS, agent_key="claude")
    assert (await plan_mcp.pipeline_start(_ctx("pc"), task="t", workspace_path=WS))["ok"]
    assert not any(is_tainted(p) for p in window[1])


async def test_an_untainted_caller_starts_a_clean_run(window) -> None:
    agent_messaging.register("pa", "lead", WS, agent_key="claude")
    assert (await plan_mcp.pipeline_start(_ctx("pa"), task="t", workspace_path=WS))["ok"]
    assert not any(is_tainted(p) for p in window[0])


async def test_a_refused_start_leaves_nothing_armed(monkeypatch) -> None:
    agent_messaging.register("pa", "lead", WS, agent_key="claude")
    mark_tainted("pa", "remote", "chat message")

    async def refused(*_a, **_k):
        return {"ok": False, "result": None, "error": "no pipeline"}

    monkeypatch.setattr(plan_mcp, "_ui_request", refused)
    await plan_mcp.pipeline_start(_ctx("pa"), task="t", workspace_path=WS)
    taint.pipeline_run_started(WS)  # a run someone then starts at the computer
    taint.pipeline_pane_spawned(WS, "later")
    assert not is_tainted("later")
