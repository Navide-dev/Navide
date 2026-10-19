"""An aborted run must not block the workspace from ever starting again (#417).

The reporter aborted a 13-stage run, edited the pipeline down to 2 stages over
MCP, ran pipeline_reset and restarted Navide: pipeline_status still answered
the aborted 13-stage run and no start ever got through, with nothing logged.
These drive the real ProjectStore and the real pipeline.* handlers.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent_team_backend import app as app_module
from agent_team_backend import ws_handlers
from agent_team_backend.projects import ProjectStore


class _Session:
    def __init__(self) -> None:
        self.sent: list = []

    async def send_json(self, message: dict) -> None:
        self.sent.append(message)


def _blueprint(n: int) -> list[dict]:
    return [{"stage_id": f"s{i}", "title": f"S{i}", "slots": [{"label": "a", "agent": "claude"}]} for i in range(n)]


@pytest.fixture
def ws(tmp_path: Path) -> str:
    path = tmp_path / "ws"
    path.mkdir()
    return str(path)


@pytest.fixture
def wired(monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    store = ProjectStore()

    async def fake_broadcast(event: dict) -> None:
        pass

    monkeypatch.setattr(app_module, "project_store", store, raising=False)
    monkeypatch.setattr(app_module, "broadcast", fake_broadcast, raising=False)
    monkeypatch.setattr(
        app_module,
        "recent_workspaces_store",
        SimpleNamespace(touch=lambda *a, **k: None, list=lambda: []),
        raising=False,
    )
    monkeypatch.setattr(
        app_module,
        "tokens_store",
        SimpleNamespace(start_run=lambda *a, **k: None, end_run=lambda *a, **k: None, snapshot=lambda *a, **k: {}),
        raising=False,
    )
    monkeypatch.setattr(
        app_module, "stages_store", SimpleNamespace(get_active_pipeline_id=lambda: "pl-1"), raising=False
    )
    monkeypatch.setattr(app_module, "_register_workspace_and_backfill", lambda *a, **k: None, raising=False)
    monkeypatch.setattr(app_module, "_project_payload", lambda p: {"state": p.state}, raising=False)
    return store


def _aborted_run(store: ProjectStore, ws: str) -> str:
    store.start_pipeline(ws, task_description="old task", total_stages=13, stage_blueprint=_blueprint(13), pipeline_id="pl-1")
    store.abort_pipeline(ws, reason="user")
    return store.peek(ws).log_file_name


async def test_reset_returns_an_aborted_run_to_idle_and_survives_a_restart(wired: ProjectStore, ws: str) -> None:
    old_log = _aborted_run(wired, ws)
    session = _Session()
    await ws_handlers.pipeline_reset(session, "1", "pipeline.reset", {"workspace_path": ws})
    assert session.sent[-1]["ok"] is True
    # A fresh store reads the workspace database again, as a restart does.
    assert ProjectStore().peek(ws).state == "idle"
    # Only the state moves: the run's record and its log stay as history.
    reloaded = ProjectStore().peek(ws)
    assert reloaded.total_stages == 13
    assert reloaded.log_file_name == old_log
    log_lines = (Path(ws) / ".agent-team" / old_log).read_text().splitlines()
    assert json.loads(log_lines[-1].split("] ", 1)[1])["event"] == "pipeline_reset"
    assert any('"pipeline_abort"' in line for line in log_lines)


async def test_reset_with_no_project_is_a_quiet_no_op(wired: ProjectStore, ws: str) -> None:
    session = _Session()
    await ws_handlers.pipeline_reset(session, "1", "pipeline.reset", {"workspace_path": ws})
    assert session.sent[-1]["ok"] is True
    assert wired.peek(ws) is None


async def test_a_new_run_after_abort_reset_restart_uses_the_current_template(wired: ProjectStore, ws: str) -> None:
    old_log = _aborted_run(wired, ws)
    await ws_handlers.pipeline_reset(_Session(), "1", "pipeline.reset", {"workspace_path": ws})
    monkeypatch_store = ProjectStore()
    app_module.project_store = monkeypatch_store  # restored by the fixture's monkeypatch
    session = _Session()
    await ws_handlers.pipeline_start(
        session,
        "2",
        "pipeline.start",
        {"workspace_path": ws, "task_description": "new task", "total_stages": 2, "stage_blueprint": _blueprint(2)},
    )
    project = ProjectStore().peek(ws)
    assert project.state == "running"
    assert project.total_stages == 2
    assert [s.stage_id for s in project.stages] == ["s0", "s1"]
    assert project.task_description == "new task"
    assert project.log_file_name != old_log
    # The aborted run's directory and log are kept.
    assert (Path(ws) / ".agent-team" / old_log).is_file()


async def test_an_aborted_run_does_not_block_a_direct_start(wired: ProjectStore, ws: str) -> None:
    """main behaviour, locked: the backend never refused a start over a
    terminal state; only the reset leg was missing."""
    _aborted_run(wired, ws)
    await ws_handlers.pipeline_start(
        _Session(), "2", "pipeline.start",
        {"workspace_path": ws, "task_description": "t", "total_stages": 2, "stage_blueprint": _blueprint(2)},
    )
    assert wired.peek(ws).state == "running"


async def test_reset_does_not_touch_a_completed_runs_count(wired: ProjectStore, ws: str) -> None:
    wired.start_pipeline(ws, task_description="t", total_stages=1, stage_blueprint=_blueprint(1))
    wired.complete_pipeline(ws)
    await ws_handlers.pipeline_reset(_Session(), "1", "pipeline.reset", {"workspace_path": ws})
    project = wired.peek(ws)
    assert project.state == "idle"
    assert project.run_count == 1


async def test_a_refused_start_is_logged_to_the_backend_and_the_workspace_log(
    wired: ProjectStore, ws: str, caplog: pytest.LogCaptureFixture
) -> None:
    _aborted_run(wired, ws)
    session = _Session()
    with caplog.at_level(logging.WARNING, logger="agent_team_backend.ws_handlers"):
        await ws_handlers.pipeline_start_refused(
            session,
            "3",
            "pipeline.start_refused",
            {"workspace_path": ws, "pipeline_id": "pl-1", "reason": "pipeline pl-1 has no stages"},
        )
    assert session.sent[-1]["ok"] is True
    assert any("pipeline pl-1 has no stages" in r.getMessage() for r in caplog.records)
    # Outside any run: the workspace-level pipeline.log, not the aborted run's.
    last = (Path(ws) / ".agent-team" / "pipeline.log").read_text().splitlines()[-1]
    event = json.loads(last.split("] ", 1)[1])
    assert event["event"] == "pipeline_start_refused"
    assert event["reason"] == "pipeline pl-1 has no stages"
    assert event["pipeline_id"] == "pl-1"
    # The refusal moves no state.
    assert wired.peek(ws).state == "aborted"
