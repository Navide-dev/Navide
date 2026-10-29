"""A run left at ``running`` by a crash reads as interrupted, not active (p2-crash-state).

The backend is auto-restarted on its own while the windows and their runs
live on, so a stored running run is only interrupted once the windows have
had their say: see agent_team_backend.pipeline_liveness. These drive the real
ProjectStore, the real pipeline.* handlers and the MCP status builder.
"""

from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent_team_backend import app as app_module
from agent_team_backend import pipeline_liveness, ws_handlers
from agent_team_backend.mcp_server import server as mcp
from agent_team_backend.projects import ProjectStore


class _Session:
    """A window's backend session: what pipeline_liveness reads off one."""

    def __init__(self, held: tuple[str, ...] = (), window_id: str = "win-1") -> None:
        self.sent: list = []
        self.dead = False
        self.window_id = window_id
        self.held_workspaces = held

    async def send_json(self, message: dict) -> None:
        self.sent.append(message)


@pytest.fixture
def ws(tmp_path: Path) -> str:
    path = tmp_path / "ws"
    path.mkdir()
    return str(path)


@pytest.fixture
def wired(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    store = ProjectStore()
    sessions: list[_Session] = []

    async def fake_broadcast(event: dict) -> None:
        pass

    monkeypatch.setattr(app_module, "project_store", store, raising=False)
    monkeypatch.setattr(app_module, "broadcast", fake_broadcast, raising=False)
    monkeypatch.setattr(app_module, "_SESSIONS", sessions, raising=False)
    monkeypatch.setattr(app_module, "main_window_sessions", lambda: [s for s in sessions if not s.dead], raising=False)
    monkeypatch.setattr(
        app_module,
        "tokens_store",
        SimpleNamespace(start_run=lambda *a, **k: None, end_run=lambda *a, **k: None, snapshot=lambda *a, **k: {}),
        raising=False,
    )
    monkeypatch.setattr(
        app_module, "stages_store", SimpleNamespace(get_active_pipeline_id=lambda: "pl-1", imported_from=lambda pid: None), raising=False
    )
    monkeypatch.setattr(app_module, "_register_workspace_and_backfill", lambda *a, **k: None, raising=False)
    monkeypatch.setattr(
        app_module, "_project_payload", lambda p: {"project": {"state": p.state}, "state": p.state}, raising=False
    )
    # A backend that just started: inside the reconnect grace, no claim yet.
    monkeypatch.setattr(pipeline_liveness, "_started_at", time.monotonic())
    monkeypatch.setattr(pipeline_liveness, "_claims_seen", False)
    return SimpleNamespace(store=store, sessions=sessions, monkeypatch=monkeypatch)


def _restart_backend(w: SimpleNamespace, *, grace_over: bool = False) -> None:
    """A fresh backend process: a new store reading the same files, no sessions."""
    w.store = ProjectStore()
    w.monkeypatch.setattr(app_module, "project_store", w.store, raising=False)
    w.sessions.clear()
    started = time.monotonic() - (pipeline_liveness.CLAIM_GRACE_S + 1 if grace_over else 0)
    w.monkeypatch.setattr(pipeline_liveness, "_started_at", started)
    w.monkeypatch.setattr(pipeline_liveness, "_claims_seen", False)


async def _some_window_synced(w: SimpleNamespace, held: tuple[str, ...] = ("/somewhere/else",)) -> _Session:
    """A window that holds other workspaces connects and claims nothing."""
    other = _Session(held=held, window_id="win-other")
    w.sessions.append(other)
    await ws_handlers.pipeline_claim(other, "9", "pipeline.claim", {"workspaces": []})
    return other


async def _start_run(w: SimpleNamespace, ws: str, session: _Session) -> None:
    await ws_handlers.pipeline_start(
        session, "1", "pipeline.start",
        {"workspace_path": ws, "task_description": "t", "total_stages": 2,
         "stage_blueprint": [{"stage_id": "s0", "title": "S0", "slots": [{"label": "a", "agent": "claude"}]}]},
    )
    assert w.store.peek(ws).state == "running"


def _status(ws: str) -> dict:
    return mcp._pipeline_status_of(ws)


async def test_a_run_the_window_still_drives_survives_a_backend_auto_restart(wired, ws) -> None:
    window = _Session(held=(ws,))
    wired.sessions.append(window)
    await _start_run(wired, ws, window)

    _restart_backend(wired)
    # The window has not reconnected yet: nobody holds the workspace, inside the grace.
    assert _status(ws)["active"] is True
    assert ws_handlers._stage_edit_hits_running_pipeline(ws, "") is True
    # It reconnects and announces what it holds, but has not claimed yet.
    reconnected = _Session(held=(ws,))
    wired.sessions.append(reconnected)
    assert _status(ws)["active"] is True
    assert ws_handlers._stage_edit_hits_running_pipeline(ws, "") is True
    # Its claim names the run: still active, never marked interrupted.
    await ws_handlers.pipeline_claim(reconnected, "2", "pipeline.claim", {"workspaces": [ws]})
    assert reconnected.sent[-1]["ok"] is True
    status = _status(ws)
    assert status["active"] is True and status["state"] == "running" and "resumable" not in status
    # Even after the grace: the claim is what counts.
    wired.monkeypatch.setattr(pipeline_liveness, "_started_at", time.monotonic() - pipeline_liveness.CLAIM_GRACE_S - 1)
    assert _status(ws)["active"] is True
    assert mcp._run_is_active(ws) is True


async def test_after_a_whole_app_restart_the_run_is_interrupted_and_still_resumable(wired, ws) -> None:
    await _start_run(wired, ws, _Session(held=(ws,)))

    _restart_backend(wired)
    window = _Session(held=(ws,))
    wired.sessions.append(window)
    # The new window holds the workspace and syncs: it drives no run.
    await ws_handlers.pipeline_claim(window, "2", "pipeline.claim", {"workspaces": []})
    status = _status(ws)
    assert status["active"] is False
    assert status["state"] == "interrupted"
    assert status["resumable"] is True
    # Definition edits are no longer refused, over WS and over MCP.
    assert ws_handlers._stage_edit_hits_running_pipeline(ws, "") is False
    assert mcp._run_is_active(ws) is False
    # The stored record is untouched, so opening the workspace offers resume as before.
    assert ProjectStore().peek(ws).state == "running"
    # And resume picks it up: the resuming window claims it again.
    await ws_handlers.pipeline_resume(window, "3", "pipeline.resume", {"workspace_path": ws})
    assert window.sent[-1]["ok"] is True
    assert _status(ws)["active"] is True
    assert ws_handlers._stage_edit_hits_running_pipeline(ws, "") is True


async def test_with_no_window_holding_the_workspace_the_grace_decides(wired, ws) -> None:
    await _start_run(wired, ws, _Session(held=(ws,)))
    _restart_backend(wired)
    other = _Session(held=("/somewhere/else",))
    wired.sessions.append(other)
    await ws_handlers.pipeline_claim(other, "2", "pipeline.claim", {"workspaces": []})
    # Another window syncing says nothing about this workspace's window.
    assert _status(ws)["active"] is True
    _restart_backend(wired, grace_over=True)
    await _some_window_synced(wired)
    assert _status(ws)["state"] == "interrupted"


async def test_two_windows_holding_the_workspace_both_have_to_sync(wired, ws) -> None:
    await _start_run(wired, ws, _Session(held=(ws,)))
    _restart_backend(wired)
    a, b = _Session(held=(ws,), window_id="win-a"), _Session(held=(ws,), window_id="win-b")
    wired.sessions.extend([a, b])
    await ws_handlers.pipeline_claim(a, "2", "pipeline.claim", {"workspaces": []})
    assert _status(ws)["active"] is True
    await ws_handlers.pipeline_claim(b, "3", "pipeline.claim", {"workspaces": []})
    assert _status(ws)["active"] is False


async def test_stage_spawn_claims_the_run_for_its_window(wired, ws) -> None:
    await _start_run(wired, ws, _Session(held=(ws,)))
    _restart_backend(wired, grace_over=True)
    await _some_window_synced(wired)
    assert _status(ws)["state"] == "interrupted"
    window = _Session(held=(ws,))
    wired.sessions.append(window)
    await ws_handlers.pipeline_stage_spawn(
        window, "2", "pipeline.stage_spawn", {"workspace_path": ws, "stage_index": 0, "pane_id": "p1"}
    )
    assert _status(ws)["active"] is True


async def test_a_dead_session_claims_nothing(wired, ws) -> None:
    window = _Session(held=(ws,))
    wired.sessions.append(window)
    await _start_run(wired, ws, window)
    window.dead = True
    survivor = _Session(held=(ws,), window_id="win-2")
    wired.sessions.append(survivor)
    await ws_handlers.pipeline_claim(survivor, "2", "pipeline.claim", {"workspaces": []})
    assert _status(ws)["state"] == "interrupted"


async def test_a_backend_no_window_ever_claimed_judges_nothing(wired, ws) -> None:
    # A test process, or a backend no Navide window reached: a running run
    # stays active however long it has been up, as before p2-crash-state.
    await _start_run(wired, ws, _Session(held=(ws,)))
    _restart_backend(wired, grace_over=True)
    assert _status(ws)["active"] is True
    assert ws_handlers._stage_edit_hits_running_pipeline(ws, "") is True


async def test_idle_completed_and_aborted_runs_are_never_interrupted(wired, ws) -> None:
    assert pipeline_liveness.is_interrupted(None) is False
    for state in ("idle", "completed", "aborted"):
        assert pipeline_liveness.is_interrupted(SimpleNamespace(state=state, workspace_path=ws)) is False


async def test_a_claim_must_be_a_list(wired, ws) -> None:
    window = _Session(held=(ws,))
    await ws_handlers.pipeline_claim(window, "1", "pipeline.claim", {"workspaces": "nope"})
    assert window.sent[-1]["ok"] is False
    assert getattr(window, "pipeline_claimed", False) is False
