"""Handlers that write and then tell the windows in several steps finish all
of them when the requester hangs up (0.2.45 broadcast-decoupling report).

ws_endpoint cancels a closed connection's handler tasks. app.broadcast itself
finishes once started, but a handler that broadcasts twice, or still has work
after its first broadcast, used to stop there: the write landed and the rest
never went. Each test cancels the handler as the first broadcast goes out and
checks that every later one still arrives.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Awaitable, Callable

import pytest

from agent_team_backend import app as app_module
from agent_team_backend import ws_handlers
from agent_team_backend.roles_store import ROLES_FILE, RolesStore
from agent_team_backend.stages_store import PIPELINES_FILE, StagesStore


class _Session:
    def __init__(self) -> None:
        self.sent: list = []

    async def send_json(self, message: dict) -> None:
        self.sent.append(message)


@pytest.fixture
def wired(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Real roles and stages stores; a broadcast slow enough to hang up in."""
    roles = RolesStore(tmp_path / ROLES_FILE)
    stages = StagesStore(tmp_path / PIPELINES_FILE)
    events: list = []

    async def slow_broadcast(event: dict, **_kwargs: Any) -> None:
        events.append(event)
        await asyncio.sleep(0.02)

    monkeypatch.setattr(app_module, "roles_store", roles, raising=False)
    monkeypatch.setattr(app_module, "stages_store", stages, raising=False)
    monkeypatch.setattr(app_module, "broadcast", slow_broadcast, raising=False)
    monkeypatch.setattr(app_module, "_settings_paths", lambda: {}, raising=False)
    monkeypatch.setattr(
        app_module, "project_store", SimpleNamespace(peek=lambda _p: None), raising=False
    )
    pid = stages.create_pipeline("Custom")["id"]
    stages.upsert(_stage("s-01", _slot("pm"), _slot("qa")), pid)
    return SimpleNamespace(roles=roles, stages=stages, events=events, pipeline_id=pid)


def _slot(role_key: str) -> dict:
    return {"label": role_key, "role_key": role_key, "count": 1}


def _stage(stage_id: str, *slots: dict) -> dict:
    return {"id": stage_id, "title": stage_id, "slots": list(slots)}


async def _hang_up_at_first_broadcast(
    events: list, start: Callable[[], Awaitable[None]], settle: int,
) -> list[str]:
    """Start the handler, cancel it once its first broadcast is out (as
    ws_endpoint does on a close), then wait for ``settle`` events."""
    task = asyncio.create_task(start())
    while not events and not task.done():
        await asyncio.sleep(0.001)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    for _ in range(300):
        if len(events) >= settle:
            break
        await asyncio.sleep(0.01)
    await asyncio.sleep(0.05)  # nothing more should trickle in
    return [e["type"] for e in events]


async def test_roles_rename_moves_the_stages_after_a_hang_up(wired) -> None:
    using = {u["pipeline_id"] for u in wired.stages.find_role_usages("qa")}
    session = _Session()
    types = await _hang_up_at_first_broadcast(wired.events, lambda: ws_handlers.roles_rename(
        session, "1", "roles.rename",
        {"old_key": "qa", "new_key": "tester", "label": "Tester", "one_line": "", "system_prompt": "x"},
    ), 1 + len(using))
    # One stages.changed per pipeline naming the role.
    assert types == ["roles.changed"] + ["stages.changed"] * len(using)


async def test_roles_reset_still_clears_dangling_slots_after_a_hang_up(wired) -> None:
    wired.roles.upsert(key="custom", label="Custom", one_line="", system_prompt="x")
    wired.stages.upsert(_stage("s-03", _slot("custom")), wired.pipeline_id)
    session = _Session()
    types = await _hang_up_at_first_broadcast(
        wired.events, lambda: ws_handlers.roles_reset(session, "1", "roles.reset", {}), 2,
    )
    assert types[0] == "roles.changed"
    assert "stages.changed" in types
    stage = next(s for s in wired.stages.list(wired.pipeline_id) if s["id"] == "s-03")
    assert stage["slots"][0]["role_key"] == ""


async def test_stages_upsert_republishes_the_pipeline_list_after_a_hang_up(wired) -> None:
    session = _Session()
    types = await _hang_up_at_first_broadcast(wired.events, lambda: ws_handlers.stages_upsert(
        session, "1", "stages.upsert",
        {"stage": _stage("s-02", _slot("pm")), "pipeline_id": wired.pipeline_id},
    ), 2)
    assert types == ["stages.changed", "pipelines.changed"]


async def test_pipelines_reset_builtin_sends_both_events_after_a_hang_up(wired) -> None:
    builtin = next(p for p in wired.stages.list_pipelines() if p.get("builtin"))
    session = _Session()
    types = await _hang_up_at_first_broadcast(wired.events, lambda: ws_handlers.pipelines_reset_builtin(
        session, "1", "pipelines.reset_builtin", {"pipeline_id": builtin["id"]},
    ), 2)
    assert types == ["pipelines.changed", "stages.changed"]


async def test_settings_bundle_import_finishes_after_a_hang_up(wired) -> None:
    bundle = {
        "roles": [{"key": "pm", "label": "PM", "one_line": "", "system_prompt": "x"}],
        "pipelines_document": wired.stages.export_document(),
    }
    session = _Session()
    types = await _hang_up_at_first_broadcast(wired.events, lambda: ws_handlers.settings_bundle_import(
        session, "1", "settings.bundle.import", {"bundle": bundle},
    ), 3)
    assert types[:3] == ["roles.changed", "pipelines.changed", "stages.changed"]


async def test_pipelines_graph_apply_sends_all_three_events_after_a_hang_up(wired) -> None:
    ops = [
        {"op": "add_node", "node": {"id": "gate", "kind": "gate", "position": {"x": 0, "y": 0}},
         "after": ["n-01-0"], "before": ["n-02-0"]},
    ]
    session = _Session()
    types = await _hang_up_at_first_broadcast(wired.events, lambda: ws_handlers.pipelines_graph_apply(
        session, "1", "pipelines.graph.apply", {"pipeline_id": "default", "ops": ops},
    ), 3)
    assert types == ["pipeline.graph_changed", "stages.changed", "pipelines.changed"]


def _slow_in_thread(started, result):
    """A store write that blocks its thread a while, as a real disk write may."""
    import time

    def write(*_args: Any, **_kwargs: Any) -> Any:
        started.set()
        time.sleep(0.1)
        return result(*_args) if callable(result) else result

    return write


async def _hang_up_mid_write(start: Callable[[], Awaitable[None]], started) -> None:
    task = asyncio.create_task(start())
    while not started.is_set():
        await asyncio.sleep(0.001)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def _wait_for(predicate: Callable[[], bool]) -> None:
    for _ in range(300):
        if predicate():
            return
        await asyncio.sleep(0.01)


async def test_ui_settings_set_still_tells_the_other_windows_after_a_hang_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import threading

    events: list = []

    async def broadcast(event: dict, **_kwargs: Any) -> None:
        events.append(event)

    started = threading.Event()
    monkeypatch.setattr(app_module, "broadcast", broadcast)
    monkeypatch.setattr(app_module.ui_settings_store, "set", _slow_in_thread(started, lambda u: dict(u)))
    session = _Session()
    await _hang_up_mid_write(lambda: ws_handlers.ui_settings_set(
        session, "1", "ui.settings.set", {"updates": {"theme": "dark"}},
    ), started)
    await _wait_for(lambda: bool(events))
    assert [e["type"] for e in events] == ["ui.settings_changed"]
    assert events[0]["payload"]["settings"] == {"theme": "dark"}


async def test_codex_hook_trust_blocked_still_broadcasts_after_a_hang_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import threading

    from agent_team_backend import codex_session_hooks

    events: list = []

    async def broadcast(event: dict, **_kwargs: Any) -> None:
        events.append(event)

    started = threading.Event()
    monkeypatch.setattr(app_module, "broadcast", broadcast)
    monkeypatch.setattr(codex_session_hooks, "set_trust_gate_blocked", _slow_in_thread(started, True))
    session = _Session()
    await _hang_up_mid_write(lambda: ws_handlers.codex_hook_trust_blocked(
        session, "1", "codex.hook_trust_blocked", {"blocked": True},
    ), started)
    await _wait_for(lambda: bool(events))
    assert [e["type"] for e in events] == ["codex.hook_trust_changed"]


class _SlowTerminals:
    def __init__(self, by_pane: dict[str, list[str]]) -> None:
        self._by_pane = by_pane
        self.killing: list[str] = []
        self.killed: list[str] = []

    def live_session_ids_for_pane(self, pane_id: str) -> list[str]:
        return list(self._by_pane.get(pane_id, []))

    async def kill(self, session_id: str, force: bool = False) -> None:
        self.killing.append(session_id)
        await asyncio.sleep(0.05)
        self.killed.append(session_id)


async def test_slot_unspawn_kills_every_pty_even_after_a_hang_up(tmp_path: Path) -> None:
    """Removing a slot and then closing the window must not leave the slot's
    second PTY running with nothing pointing at it."""
    ws = str(tmp_path)
    app_module.project_store.start_pipeline(
        ws, task_description="t", total_stages=1,
        stage_blueprint=[{"stage_id": "01", "title": "Build",
                          "slots": [{"label": "Build", "agent": "codex", "role": "eng"}]}],
    )
    app_module.project_store.record_slot_spawn(
        ws, stage_index=0, slot_label="Build", pane_id="P1", agent="codex",
    )
    terminals = _SlowTerminals({"P1": ["term-1", "term-2"]})
    session = app_module.Session(_Session())  # type: ignore[arg-type]
    session.terminals = terminals  # type: ignore[assignment]
    task = asyncio.create_task(ws_handlers.pipeline_slot_unspawn(
        session, "1", "pipeline.slot_unspawn",
        {"workspace_path": ws, "stage_index": 0, "slot_label": "Build"},
    ))
    while not terminals.killing:
        await asyncio.sleep(0.001)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await _wait_for(lambda: len(terminals.killed) == 2)
    assert terminals.killed == ["term-1", "term-2"]
