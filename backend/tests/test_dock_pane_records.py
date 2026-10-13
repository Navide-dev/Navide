"""Embedded AI panels (AiCliDock) join the pane records and spawn history.

A dock's terminal.create carries `surface` / `window_kind` in its metadata; the
backend then files the panel's restore record and Agent History entry itself,
since no window runs the main window's manual_pane.spawn / set_ui_state for it.
Every assertion about a create WITHOUT a dock surface pins today's behaviour:
the main window never sends the field, and nothing it sees may change.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app, ws_handlers
from agent_team_backend.projects import PaneRecord, Project, ProjectStore
from agent_team_backend.spawn_history import SpawnHistoryStore


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeTerminals:
    def create(self, **kwargs: Any) -> SimpleNamespace:
        return SimpleNamespace(
            id="term-1",
            pane_id=kwargs["pane_id"],
            command=kwargs["command"],
            proc=SimpleNamespace(pid=1234),
        )

    async def kill(self, session_id: str, force: bool = False) -> None:
        return None

    def find_live_by_resume_id(self, *args: Any, **kwargs: Any) -> list[Any]:
        return []


class FakeAttribution:
    def register_pane(self, pane_id: str, **kwargs: Any) -> None:
        return None

    def scan_pane_baseline(self, pane_id: str) -> None:
        return None


def _session() -> app.Session:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = FakeTerminals()  # type: ignore[assignment]
    return session


@pytest.fixture()
def stores(monkeypatch: pytest.MonkeyPatch) -> tuple[ProjectStore, SpawnHistoryStore]:
    project_store = ProjectStore()
    history_store = SpawnHistoryStore()
    monkeypatch.setattr(app, "project_store", project_store)
    monkeypatch.setattr(app, "spawn_history_store", history_store)
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    monkeypatch.setattr(app, "_probe_agent_cli_for_spawn", lambda _key, _command=None: None)
    monkeypatch.setattr(app, "track_live_session", lambda **_: None)
    monkeypatch.setattr(
        app.credential_vault, "identity",
        lambda _key, _slot=None: {"email": None, "signedIn": True},
    )
    return project_store, history_store


_DOCK_PANE = "ab12cd34-plans-ai-terminal"


async def _create(session: app.Session, ws: str, metadata: dict[str, Any]) -> dict[str, Any]:
    await app.handle_message(session, {
        "id": "c1",
        "type": "terminal.create",
        "payload": {
            "pane_id": _DOCK_PANE,
            "agent_key": "claude",
            "command": ["/bin/zsh", "-ilc", "claude --session-id 11111111-2222-3333-4444-555555555555"],
            "cwd": ws,
            "metadata": {"workspace_path": ws, **metadata},
            "output_log_file": f"{ws}/.agent-team/manual/20261004/claude-ab12cd34.log",
        },
    })
    return session.websocket.sent[-1]  # type: ignore[attr-defined,no-any-return]


def _dock_metadata() -> dict[str, Any]:
    return {
        "origin": "plan-window",
        "surface": "plans",
        "window_kind": "plans",
        "explicit_session_id": "11111111-2222-3333-4444-555555555555",
        "cli_command": "claude --session-id 11111111-2222-3333-4444-555555555555",
        "agent_label": "Claude Code",
    }


# ── terminal.create files a dock's record and history ──────────────────────

@pytest.mark.asyncio
async def test_a_dock_create_writes_its_pane_record(tmp_path: Path, stores: Any) -> None:
    project_store, _ = stores
    ws = str(tmp_path)
    resp = await _create(_session(), ws, _dock_metadata())
    assert resp.get("ok") is True, resp

    project = project_store.peek(ws)
    assert project is not None
    [record] = [p for p in project.panes if p.pane_id == _DOCK_PANE]
    assert record.surface == "plans"
    assert record.window_kind == "plans"
    assert record.agent == "claude"
    assert record.origin == "plan-window"
    assert record.session_id == "11111111-2222-3333-4444-555555555555"
    assert record.command == "claude --session-id 11111111-2222-3333-4444-555555555555"
    assert record.output_log_file == f"{ws}/.agent-team/manual/20261004/claude-ab12cd34.log"
    assert record.spawn_status == "spawned"


@pytest.mark.asyncio
async def test_a_dock_create_writes_its_spawn_history_entry(tmp_path: Path, stores: Any) -> None:
    _, history_store = stores
    ws = str(tmp_path)
    await _create(_session(), ws, _dock_metadata())

    page, total = history_store.read_page(ws)
    assert total == 1
    entry = page[0]
    assert entry["paneId"] == _DOCK_PANE
    assert entry["agentKey"] == "claude"
    assert entry["agentLabel"] == "Claude Code"
    assert entry["command"] == "claude --session-id 11111111-2222-3333-4444-555555555555"
    assert entry["sessionId"] == "11111111-2222-3333-4444-555555555555"
    assert entry["origin"] == "plan-window"
    assert entry["workspacePath"] == ws
    assert entry["outputLogFile"] == f"{ws}/.agent-team/manual/20261004/claude-ab12cd34.log"
    assert entry["surface"] == "plans"
    assert entry["windowKind"] == "plans"
    assert entry["spawnedAt"]


@pytest.mark.asyncio
async def test_a_dock_respawn_updates_the_same_record_and_entry(tmp_path: Path, stores: Any) -> None:
    """The dock keeps one pane id per workspace, so a second Start upserts."""
    project_store, history_store = stores
    ws = str(tmp_path)
    await _create(_session(), ws, _dock_metadata())
    second = {**_dock_metadata(), "explicit_session_id": "99999999-2222-3333-4444-555555555555"}
    await _create(_session(), ws, second)

    project = project_store.peek(ws)
    assert project is not None
    records = [p for p in project.panes if p.pane_id == _DOCK_PANE]
    assert len(records) == 1
    assert records[0].session_id == "99999999-2222-3333-4444-555555555555"
    page, total = history_store.read_page(ws)
    assert total == 1
    assert page[0]["sessionId"] == "99999999-2222-3333-4444-555555555555"


@pytest.mark.asyncio
async def test_a_dock_cli_failing_right_after_its_create_retires_the_record(tmp_path: Path, stores: Any) -> None:
    """A restore resuming a session the vendor no longer has exits non-zero
    within seconds; left 'spawned', every window open would retry it."""
    project_store, _ = stores
    ws = str(tmp_path)
    await _create(_session(), ws, _dock_metadata())
    try:
        await app._active_emit({"type": "terminal.exit", "payload": {
            "terminal_session_id": "term-1", "pane_id": _DOCK_PANE,
            "reason": "exit", "exit_code": 1, "uptime_ms": 1500,
        }})
        [record] = [p for p in project_store.load_or_create(ws).panes if p.pane_id == _DOCK_PANE]
        assert record.spawn_status == "removed"
    finally:
        ws_handlers._DOCK_PTYS.clear()


@pytest.mark.asyncio
async def test_a_dock_cli_dying_during_its_create_retires_the_previous_record(
    tmp_path: Path, stores: Any,
) -> None:
    project_store, _ = stores
    ws = str(tmp_path)
    project_store.record_manual_pane_spawn(
        ws, pane_id=_DOCK_PANE, agent="claude", session_id="11111111-2222-3333-4444-555555555555",
        origin="plan-window", surface="plans",
    )

    class DyingTerminals(FakeTerminals):
        def create(self, **kwargs: Any) -> SimpleNamespace:
            term = super().create(**kwargs)
            term.closed = True
            term.close_reason = "exit"
            term.exit_code = 1
            term.exit_signal = None
            term.uptime_ms = 900
            return term

    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = DyingTerminals()  # type: ignore[assignment]
    resp = await _create(session, ws, _dock_metadata())

    assert resp.get("ok") is False, resp
    [record] = [p for p in project_store.load_or_create(ws).panes if p.pane_id == _DOCK_PANE]
    assert record.spawn_status == "removed"


@pytest.mark.asyncio
@pytest.mark.parametrize("surface", [None, "", "main"])
async def test_a_window_pane_create_writes_nothing_new(
    tmp_path: Path, stores: Any, surface: str | None
) -> None:
    """The main window records its panes itself (manual_pane.spawn and
    set_ui_state); terminal.create must stay silent for them."""
    project_store, history_store = stores
    ws = str(tmp_path)
    metadata: dict[str, Any] = {"origin": "manual", "explicit_session_id": "s-1"}
    if surface is not None:
        metadata["surface"] = surface
    resp = await _create(_session(), ws, metadata)
    assert resp.get("ok") is True, resp

    assert project_store.peek(ws) is None
    assert history_store.read_page(ws) == ([], 0)


# ── PaneRecord carries surface / window_kind in its JSON blob ──────────────

def test_a_pane_record_round_trips_its_surface() -> None:
    project = Project(id="p", name="n", workspace_path="/ws", created_at="", updated_at="")
    project.panes.append(PaneRecord(pane_id="d1", surface="editor", window_kind="editor"))
    loaded = Project.from_dict(project.to_dict())
    assert loaded.panes[0].surface == "editor"
    assert loaded.panes[0].window_kind == "editor"


def test_an_old_pane_record_without_the_keys_reads_as_main() -> None:
    project = Project(id="p", name="n", workspace_path="/ws", created_at="", updated_at="")
    project.panes.append(PaneRecord(pane_id="p1"))
    raw = project.to_dict()
    for pane in raw["panes"]:
        pane.pop("surface", None)
        pane.pop("window_kind", None)
    loaded = Project.from_dict(raw)
    assert loaded.panes[0].surface == ""
    assert loaded.panes[0].window_kind == ""


def test_record_manual_pane_spawn_keeps_surface_unset_by_default(tmp_path: Path) -> None:
    store = ProjectStore()
    project = store.record_manual_pane_spawn(str(tmp_path), pane_id="p1", agent="claude")
    assert project.panes[0].surface == ""
    assert project.panes[0].window_kind == ""


def test_record_manual_pane_spawn_stores_a_dock_surface(tmp_path: Path) -> None:
    store = ProjectStore()
    store.record_manual_pane_spawn(
        str(tmp_path), pane_id="d1", agent="claude", surface="pm", window_kind="main"
    )
    reloaded = ProjectStore().peek(str(tmp_path))
    assert reloaded is not None
    assert (reloaded.panes[0].surface, reloaded.panes[0].window_kind) == ("pm", "main")


def test_a_dock_spawn_cannot_take_over_a_window_panes_record_by_pane_id(tmp_path: Path) -> None:
    """terminal.create reaches this from a plugin broker too: a surface must
    never turn a window pane's record into a panel's (the main window would
    then stop restoring it)."""
    store = ProjectStore()
    store.record_manual_pane_spawn(str(tmp_path), pane_id="p1", agent="claude", session_id="s-main")
    store.record_manual_pane_spawn(
        str(tmp_path), pane_id="p1", agent="codex", command="evil", surface="git", window_kind="git"
    )
    pane = ProjectStore().peek(str(tmp_path)).panes[0]  # type: ignore[union-attr]
    assert (pane.surface, pane.agent, pane.command) == ("", "claude", "")


def test_a_dock_spawn_sharing_a_session_id_leaves_the_window_pane_alone(tmp_path: Path) -> None:
    """The session fallback only follows a rebuild hop (previous_pane_id), which a
    panel never sends — so a shared session id adds the panel's own record."""
    store = ProjectStore()
    store.record_manual_pane_spawn(str(tmp_path), pane_id="p1", agent="claude", session_id="s-main")
    store.record_manual_pane_spawn(
        str(tmp_path), pane_id="d1", agent="claude", session_id="s-main", surface="git", window_kind="git"
    )
    panes = ProjectStore().peek(str(tmp_path)).panes  # type: ignore[union-attr]
    assert [(p.pane_id, p.surface) for p in panes] == [("p1", ""), ("d1", "git")]


def test_a_window_pane_respawn_by_pane_id_is_unchanged(tmp_path: Path) -> None:
    """The main window's own respawn of an existing record still updates it."""
    store = ProjectStore()
    store.record_manual_pane_spawn(str(tmp_path), pane_id="p1", agent="claude")
    store.record_manual_pane_spawn(str(tmp_path), pane_id="p1", agent="codex", command="codex")
    pane = ProjectStore().peek(str(tmp_path)).panes[0]  # type: ignore[union-attr]
    assert (pane.agent, pane.command, pane.surface) == ("codex", "codex", "")


@pytest.mark.asyncio
async def test_a_dock_create_naming_a_window_panes_id_leaves_its_history_alone(
    tmp_path: Path, stores: Any
) -> None:
    project_store, history_store = stores
    ws = str(tmp_path)
    project_store.record_manual_pane_spawn(ws, pane_id=_DOCK_PANE, agent="claude")
    history_store.merge(ws, [{"paneId": _DOCK_PANE, "agentKey": "claude", "command": "claude", "workspacePath": ws}])
    await _create(_session(), ws, _dock_metadata())
    rows, _total = history_store.read_page(ws)
    entry = next(r for r in rows if r.get("paneId") == _DOCK_PANE)
    assert "surface" not in entry
    assert project_store.peek(ws).panes[0].surface == ""  # type: ignore[union-attr]


@pytest.mark.asyncio
async def test_a_dock_create_leaves_a_window_panes_history_entry_alone(
    tmp_path: Path, stores: Any
) -> None:
    """QA's scenario: the window pane has an Agent History entry but no project
    record (its history outlives the record). A plugin's terminal.create naming
    that pane id with a panel surface must not replace the entry."""
    project_store, history_store = stores
    ws = str(tmp_path)
    original = {
        "paneId": _DOCK_PANE,
        "agentKey": "claude",
        "command": "claude",
        "sessionId": "original-session",
        "customName": "my pane",
        "workspacePath": ws,
    }
    history_store.merge(ws, [original])
    await _create(_session(), ws, {**_dock_metadata(), "surface": "git", "window_kind": "git"})

    rows, total = history_store.read_page(ws)
    assert total == 1
    assert rows[0] == original
    # Nor is the id filed as a panel's restore record.
    project = project_store.peek(ws)
    assert not any(p.pane_id == _DOCK_PANE and p.surface for p in (project.panes if project else []))


@pytest.mark.asyncio
async def test_a_dock_create_over_its_own_history_entry_still_updates_it(
    tmp_path: Path, stores: Any
) -> None:
    """The guard only spares window panes: a panel's own entry is upserted."""
    _, history_store = stores
    ws = str(tmp_path)
    history_store.merge(ws, [{"paneId": _DOCK_PANE, "agentKey": "codex", "surface": "plans", "workspacePath": ws}])
    await _create(_session(), ws, _dock_metadata())
    rows, total = history_store.read_page(ws)
    assert total == 1
    assert rows[0]["agentKey"] == "claude"
    assert rows[0]["sessionId"] == "11111111-2222-3333-4444-555555555555"


def test_a_dock_spawn_cannot_add_a_second_record_beside_a_pipeline_pane(tmp_path: Path) -> None:
    """_find_manual_pane skips pipeline records, so a panel naming a pipeline
    pane's id used to append a second record under that id."""
    store = ProjectStore()
    project = store.load_or_create(str(tmp_path))
    project.panes.append(PaneRecord(pane_id="pipe-1", origin="pipeline", agent="claude", spawn_status="spawned"))
    store.save(project)
    store.record_manual_pane_spawn(
        str(tmp_path), pane_id="pipe-1", agent="codex", surface="git", window_kind="git"
    )
    panes = ProjectStore().peek(str(tmp_path)).panes  # type: ignore[union-attr]
    assert [(p.pane_id, p.origin, p.agent, p.surface) for p in panes] == [
        ("pipe-1", "pipeline", "claude", ""),
    ]


def test_a_dock_spawn_does_not_fold_a_pipeline_pending_stub(tmp_path: Path) -> None:
    store = ProjectStore()
    project = store.load_or_create(str(tmp_path))
    project.panes.append(PaneRecord(
        pane_id="pipe-2", origin="pipeline", spawn_status="pending", session_id="s-pipe",
    ))
    store.save(project)
    store.record_manual_pane_spawn(
        str(tmp_path), pane_id="pipe-2", agent="codex", surface="git", window_kind="git"
    )
    panes = ProjectStore().peek(str(tmp_path)).panes  # type: ignore[union-attr]
    assert [(p.pane_id, p.origin, p.spawn_status, p.session_id, p.surface) for p in panes] == [
        ("pipe-2", "pipeline", "pending", "s-pipe", ""),
    ]


def test_a_dock_spawn_does_not_fold_a_window_panes_pending_stub(tmp_path: Path) -> None:
    store = ProjectStore()
    store.load_or_create(str(tmp_path))
    store.rename_pane(str(tmp_path), pane_id="p-stub", custom_name="named before spawn")
    store.record_manual_pane_spawn(
        str(tmp_path), pane_id="p-stub", agent="codex", surface="git", window_kind="git"
    )
    panes = ProjectStore().peek(str(tmp_path)).panes  # type: ignore[union-attr]
    assert [(p.pane_id, p.custom_name, p.spawn_status, p.surface) for p in panes] == [
        ("p-stub", "named before spawn", "pending", ""),
    ]


def test_a_pipeline_pane_spawn_beside_a_pipeline_record_is_unchanged(tmp_path: Path) -> None:
    """Without a surface the store behaves as before: a manual spawn whose id a
    pipeline record holds still adds its own manual record."""
    store = ProjectStore()
    project = store.load_or_create(str(tmp_path))
    project.panes.append(PaneRecord(pane_id="pipe-3", origin="pipeline", agent="claude", spawn_status="spawned"))
    store.save(project)
    store.record_manual_pane_spawn(str(tmp_path), pane_id="pipe-3", agent="codex")
    panes = ProjectStore().peek(str(tmp_path)).panes  # type: ignore[union-attr]
    assert [(p.pane_id, p.origin, p.agent) for p in panes] == [
        ("pipe-3", "pipeline", "claude"), ("pipe-3", "manual", "codex"),
    ]


# ── Project.to_dict: a window pane serializes exactly as before ─────────────

def test_a_window_pane_record_serializes_without_the_dock_keys() -> None:
    project = Project(id="p", name="n", workspace_path="/ws", created_at="", updated_at="")
    project.panes.append(PaneRecord(pane_id="p1"))
    pane = project.to_dict()["panes"][0]
    assert "surface" not in pane
    assert "window_kind" not in pane


def test_a_dock_pane_record_serializes_its_keys() -> None:
    project = Project(id="p", name="n", workspace_path="/ws", created_at="", updated_at="")
    project.panes.append(PaneRecord(pane_id="d1", surface="pm", window_kind="main"))
    pane = project.to_dict()["panes"][0]
    assert (pane["surface"], pane["window_kind"]) == ("pm", "main")


# ── delivery: a deliverable dock is accepted, a plain one still refused ─────

@pytest.fixture()
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


def test_a_deliverable_dock_resolves_as_a_target(_clean_registry: Any) -> None:
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("d1", "plans-claude", "/ws/alpha", surface="plans", deliverable=True)
    for to in ("plans-claude", "alpha/plans-claude"):
        result = agent_messaging.resolve("p1", to)
        assert result.pane is not None and result.pane.pane_id == "d1"
        assert result.code is None


def test_a_non_deliverable_dock_is_still_refused(_clean_registry: Any) -> None:
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("d1", "git-claude", "/ws/alpha", surface="git")
    assert agent_messaging.resolve("p1", "git-claude").code == "target-is-dock"


def test_deliverable_is_reported_only_when_true(_clean_registry: Any) -> None:
    plain = agent_messaging.register("d1", "git-claude", "/ws/alpha", surface="git")
    assert "deliverable" not in plain.to_dict()
    window_pane = agent_messaging.register("p1", "sender", "/ws/alpha")
    assert "deliverable" not in window_pane.to_dict()
    open_dock = agent_messaging.register("d2", "pm-claude", "/ws/alpha", surface="pm", deliverable=True)
    assert open_dock.to_dict()["deliverable"] is True


def test_a_deliverable_flag_on_a_window_pane_changes_nothing(_clean_registry: Any) -> None:
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("p2", "reviewer", "/ws/alpha", deliverable=True)
    result = agent_messaging.resolve("p1", "reviewer")
    assert result.pane is not None and result.pane.pane_id == "p2"


@pytest.mark.asyncio
async def test_register_dock_carries_the_deliverable_flag(_clean_registry: Any) -> None:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    await app.handle_message(session, {
        "id": "r1",
        "type": "agent_msg.register_dock",
        "payload": {
            "pane_id": "d1",
            "name": "plans-claude",
            "workspace_path": "/ws/alpha",
            "agent_key": "claude",
            "surface": "plans",
            "window_kind": "plans",
            "deliverable": True,
        },
    })
    entry = agent_messaging.get("d1")
    assert entry is not None and entry.deliverable is True
    assert session.websocket.sent[-1]["payload"]["deliverable"] is True  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_register_dock_without_the_flag_stays_undeliverable(_clean_registry: Any) -> None:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    await app.handle_message(session, {
        "id": "r2",
        "type": "agent_msg.register_dock",
        "payload": {"pane_id": "d1", "name": "git-claude", "workspace_path": "/ws/alpha", "surface": "git"},
    })
    entry = agent_messaging.get("d1")
    assert entry is not None and entry.deliverable is False


def test_a_dock_spawn_cannot_take_over_a_record_marked_main(tmp_path: Path) -> None:
    """surface='main' is a window pane's value, not a panel's: a panel spawn
    naming that record's id must leave it alone like an unmarked one."""
    store = ProjectStore()
    project = store.load_or_create(str(tmp_path))
    from agent_team_backend.projects import PaneRecord

    project.panes.append(
        PaneRecord(pane_id="p1", origin="manual", agent="claude", session_id="s-main", surface="main", window_kind="main")
    )
    store.save(project)
    store.record_manual_pane_spawn(
        str(tmp_path), pane_id="p1", agent="codex", session_id="s-new", surface="git", window_kind="git"
    )
    panes = ProjectStore().peek(str(tmp_path)).panes  # type: ignore[union-attr]
    assert [(p.pane_id, p.surface, p.agent, p.session_id) for p in panes] == [("p1", "main", "claude", "s-main")]
