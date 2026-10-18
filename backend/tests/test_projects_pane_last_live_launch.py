"""Which app launch a pane's CLI last ran in, so the 'auto' resume scope brings
back only the panes that had a live CLI when the app last closed.

The backend draws a launch id at startup and keeps the one before it in
ui_settings (`agentTeam.launchId` / `agentTeam.previousLaunchId`). Every spawn
record stamps the current id onto PaneRecord.last_live_launch; an idle reclaim
clears it through project.set_pane_resume_state. "" = no live CLI known, which
is every record written before the field existed.
"""

from __future__ import annotations

from dataclasses import fields
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app, launch_id
from agent_team_backend.projects import PaneRecord, Project, ProjectStore
from agent_team_backend.ui_settings import UiSettingsStore


@pytest.fixture
def store_ws(tmp_path: Path) -> tuple[ProjectStore, str]:
    return ProjectStore(), str(tmp_path)


# ── launch id rotation ───────────────────────────────────────────────────────


def test_rotation_keeps_the_previous_launch(tmp_path: Path) -> None:
    settings = UiSettingsStore(path=tmp_path / "ui_settings.json")
    first = launch_id.rotate(settings)
    assert first
    assert settings.get()[launch_id.PREVIOUS_KEY] == ""
    second = launch_id.rotate(settings)
    assert second and second != first
    doc = settings.get()
    assert (doc[launch_id.CURRENT_KEY], doc[launch_id.PREVIOUS_KEY]) == (second, first)
    assert launch_id.current() == second


def test_rotation_ignores_a_non_string_current(tmp_path: Path) -> None:
    settings = UiSettingsStore(path=tmp_path / "ui_settings.json")
    settings.set({launch_id.CURRENT_KEY: 42})
    launch_id.rotate(settings)
    assert settings.get()[launch_id.PREVIOUS_KEY] == ""


# ── store ────────────────────────────────────────────────────────────────────


def test_default_means_no_live_cli_known() -> None:
    assert PaneRecord(pane_id="x").last_live_launch == ""


def test_manual_spawn_stamps_the_launch(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude", launch_id="L1")
    assert ProjectStore().peek(ws).panes[0].last_live_launch == "L1"


def test_spawn_without_a_launch_leaves_the_stamp(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude", launch_id="L1")
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")
    assert ProjectStore().peek(ws).panes[0].last_live_launch == "L1"


def test_rebuild_hop_keeps_the_record_live(store_ws: tuple[ProjectStore, str]) -> None:
    """A rebuild re-spawns the record under a new id in the same launch: the
    pane is still live, so the stamp must survive (and carry the new launch)."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="old", agent="claude", session_id="s1", launch_id="L1")
    store.record_manual_pane_spawn(
        ws, pane_id="new", previous_pane_id="old", agent="claude", session_id="s1", launch_id="L2",
    )
    pane = next(p for p in ProjectStore().peek(ws).panes if p.pane_id == "new")
    assert pane.last_live_launch == "L2"


def test_pipeline_slot_spawn_stamps_the_launch(store_ws: tuple[ProjectStore, str]) -> None:
    # Pipeline panes get their PaneRecord here; record_stage_spawn writes only
    # the stage, never a pane.
    store, ws = store_ws
    store.start_pipeline(
        ws, task_description="t", total_stages=1,
        stage_blueprint=[{"stage_id": "01", "title": "Build",
                          "slots": [{"label": "Build", "agent": "codex", "role": "eng"}]}],
    )
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build", pane_id="slot", agent="codex", launch_id="L1")
    stamps = {p.pane_id: p.last_live_launch for p in ProjectStore().peek(ws).panes}
    assert stamps["slot"] == "L1"


def test_resume_state_clears_the_stamp(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude", launch_id="L1")
    store.set_pane_resume_state(ws, pane_id="p1", last_turn_state="idle")
    assert ProjectStore().peek(ws).panes[0].last_live_launch == "L1"
    store.set_pane_resume_state(ws, pane_id="p1", last_live_launch="")
    assert ProjectStore().peek(ws).panes[0].last_live_launch == ""


# ── compatibility ────────────────────────────────────────────────────────────


def test_old_record_reads_as_no_live_cli(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude", launch_id="L1")
    raw = store.load_or_create(ws).to_dict()
    del raw["panes"][0]["last_live_launch"]
    assert Project.from_dict(raw).panes[0].last_live_launch == ""


def test_new_record_loads_with_the_old_field_set(store_ws: tuple[ProjectStore, str]) -> None:
    """An older build filters a record's keys to the PaneRecord fields it knows
    (Project.from_dict). Emulate that field set: the new key is dropped, every
    other field comes through unchanged."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude", session_id="s1", launch_id="L1")
    raw = store.load_or_create(ws).to_dict()["panes"][0]
    old_known = {f.name for f in fields(PaneRecord)} - {"last_live_launch"}
    old = {k: v for k, v in raw.items() if k in old_known}
    pane = PaneRecord(**old)
    assert (pane.pane_id, pane.session_id, pane.spawn_status) == ("p1", "s1", "spawned")


# ── WS handlers ──────────────────────────────────────────────────────────────


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> "app.Session":
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_spawn_handler_stamps_the_current_launch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(launch_id, "_current", "LIVE")
    ws = str(tmp_path)
    await app.handle_message(_session(), {
        "id": "m0",
        "type": "manual_pane.spawn",
        "payload": {"workspace_path": ws, "pane_id": "P1", "agent": "claude", "command": "claude"},
    })
    assert ProjectStore().peek(ws).panes[0].last_live_launch == "LIVE"


@pytest.mark.asyncio
async def test_resume_state_handler_clears_and_ignores_non_strings(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(launch_id, "_current", "LIVE")
    ws = str(tmp_path)
    await app.handle_message(_session(), {
        "id": "m0",
        "type": "manual_pane.spawn",
        "payload": {"workspace_path": ws, "pane_id": "P1", "agent": "claude", "command": "claude"},
    })
    await app.handle_message(_session(), {
        "id": "m1",
        "type": "project.set_pane_resume_state",
        "payload": {"workspace_path": ws, "pane_id": "P1", "last_live_launch": 7},
    })
    assert ProjectStore().peek(ws).panes[0].last_live_launch == "LIVE"
    await app.handle_message(_session(), {
        "id": "m2",
        "type": "project.set_pane_resume_state",
        "payload": {"workspace_path": ws, "pane_id": "P1", "last_live_launch": ""},
    })
    assert ProjectStore().peek(ws).panes[0].last_live_launch == ""


def test_backend_startup_rotates_the_launch() -> None:
    import inspect

    assert "launch_id.rotate(ui_settings_store)" in inspect.getsource(app._start_log_watcher)


# ── a CLI that stops while the app keeps running ─────────────────────────────
#
# 'auto' means "the CLI was still running when the app ended". Every way a CLI
# stops mid-session reaches the backend as a terminal.exit: on its own ("exit",
# "error"), or through a requested kill ("killed": Kill All, closing a
# workspace, a pipeline restart, an idle reclaim). The app ending is the one
# exit labelled "shutdown" (kill_all at backend shutdown, for ⌘Q and for the
# update-install restart alike) and must leave the stamp alone, or Auto would
# have nothing to restore.


def _exit(ws: str, pane_id: str, reason: str, exit_code: int | None = 0) -> dict[str, Any]:
    return {
        "terminal_session_id": f"t-{pane_id}", "pane_id": pane_id, "workspace_path": ws,
        "reason": reason, "exit_code": exit_code, "uptime_ms": 60_000,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("reason", ["exit", "error", "killed"])
async def test_a_cli_stopping_mid_session_clears_the_stamp(tmp_path: Path, reason: str) -> None:
    from agent_team_backend import ws_handlers

    ws = str(tmp_path)
    store = app.project_store
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude", launch_id="L1")
    await ws_handlers.note_terminal_exit_async(_exit(ws, "p1", reason, exit_code=1))
    assert ProjectStore().peek(ws).panes[0].last_live_launch == ""


@pytest.mark.asyncio
async def test_the_app_ending_keeps_the_stamp(tmp_path: Path) -> None:
    from agent_team_backend import ws_handlers

    ws = str(tmp_path)
    app.project_store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude", launch_id="L1")
    await ws_handlers.note_terminal_exit_async(_exit(ws, "p1", "shutdown"))
    assert ProjectStore().peek(ws).panes[0].last_live_launch == "L1"


def test_the_sync_exit_hook_follows_the_same_rule(tmp_path: Path) -> None:
    from agent_team_backend import ws_handlers

    ws = str(tmp_path)
    app.project_store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude", launch_id="L1")
    app.project_store.record_manual_pane_spawn(ws, pane_id="p2", agent="claude", launch_id="L1")
    ws_handlers.note_terminal_exit(_exit(ws, "p1", "shutdown"))
    ws_handlers.note_terminal_exit(_exit(ws, "p2", "killed"))
    stamps = {p.pane_id: p.last_live_launch for p in ProjectStore().peek(ws).panes}
    assert stamps == {"p1": "L1", "p2": ""}


@pytest.mark.asyncio
async def test_an_exit_never_creates_a_project(tmp_path: Path) -> None:
    from agent_team_backend import ws_handlers

    ws = str(tmp_path / "no-project")
    Path(ws).mkdir()
    await ws_handlers.note_terminal_exit_async(_exit(ws, "p1", "exit"))
    await ws_handlers.note_terminal_exit_async(_exit("", "p1", "exit"))
    assert ProjectStore().peek(ws) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("exit_first", [True, False])
async def test_a_rebuild_keeps_the_pane_live_whichever_lands_first(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, exit_first: bool,
) -> None:
    """A rebuild kills the old PTY ("killed", old pane id) and records the
    replacement under a new id through previous_pane_id. The old exit can land
    before or after that re-key; either way the rebuilt pane stays stamped."""
    from agent_team_backend import ws_handlers

    monkeypatch.setattr(launch_id, "_current", "LIVE")
    ws = str(tmp_path)

    async def spawn(pane_id: str, previous: str = "") -> None:
        await app.handle_message(_session(), {
            "id": pane_id, "type": "manual_pane.spawn",
            "payload": {"workspace_path": ws, "pane_id": pane_id, "previous_pane_id": previous,
                        "agent": "claude", "command": "claude", "session_id": "s1"},
        })

    await spawn("old")
    if exit_first:
        await ws_handlers.note_terminal_exit_async(_exit(ws, "old", "killed"))
        await spawn("new", previous="old")
    else:
        await spawn("new", previous="old")
        await ws_handlers.note_terminal_exit_async(_exit(ws, "old", "killed"))
    live = [p for p in ProjectStore().peek(ws).panes if p.spawn_status == "spawned"]
    assert [(p.pane_id, p.last_live_launch) for p in live] == [("new", "LIVE")]


@pytest.mark.asyncio
async def test_terminal_exit_carries_the_workspace_and_the_real_reasons(tmp_path: Path) -> None:
    """The hook needs the pane's workspace, which only the PTY session knows;
    and the reasons it keys on are the ones the terminal service really emits."""
    import asyncio

    from agent_team_backend.terminals import TerminalService

    events: list[dict[str, Any]] = []

    async def emit(event: Any) -> None:
        if isinstance(event, dict):  # output frames arrive as bytes
            events.append(event)

    svc = TerminalService(emit=emit)
    cmd = ["sh", "-c", 'trap "exit 0" TERM; while :; do sleep 0.05; done']
    killed = svc.create(pane_id="k", agent_key=None, command=cmd, cwd="/",
                        metadata={"workspace_path": str(tmp_path)})
    svc.create(pane_id="s", agent_key=None, command=cmd, cwd="/",
               metadata={"workspace_path": str(tmp_path)})
    await asyncio.sleep(0.3)
    await svc.kill(killed.id)
    for _ in range(60):
        if any(e.get("type") == "terminal.exit" for e in events):
            break
        await asyncio.sleep(0.05)
    await svc.kill_all(grace=0.5)
    await asyncio.sleep(0.1)
    exits = {e["payload"]["pane_id"]: e["payload"] for e in events if e.get("type") == "terminal.exit"}
    assert (exits["k"]["reason"], exits["k"]["workspace_path"]) == ("killed", str(tmp_path))
    assert (exits["s"]["reason"], exits["s"]["workspace_path"]) == ("shutdown", str(tmp_path))
