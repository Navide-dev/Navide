"""terminal.kill_surface — closing a window ends that window's embedded AI panels.

A panel (AiCliDock) PTY is created with `surface` / `workspace_path` in its
terminal metadata. When the window holding it closes, the main process asks the
backend to end every panel of that surface in that workspace: the PTY goes down,
its restore record is retired and its roster entry is dropped. A session whose
metadata names no panel surface is a window pane and must never be touched.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.projects import ProjectStore
from agent_team_backend.terminals import TerminalService


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _term(term_id: str, pane_id: str, metadata: dict[str, Any], *, closed: bool = False) -> SimpleNamespace:
    return SimpleNamespace(id=term_id, pane_id=pane_id, metadata=metadata, closed=closed)


class FakeTerminals:
    """The real lookup over a fake session table, plus a recording kill."""

    def __init__(self, sessions: list[SimpleNamespace]) -> None:
        self._sessions = {s.id: s for s in sessions}
        self.killed: list[str] = []

    def live_ids_for_surface(self, surface: str, workspace_path: str) -> list[tuple[str, str]]:
        return TerminalService.live_ids_for_surface(self, surface, workspace_path)  # type: ignore[arg-type]

    def live_session_ids_for_pane(self, pane_id: str) -> list[str]:
        return [s.id for s in self._sessions.values() if s.pane_id == pane_id and not s.closed]

    async def kill(self, session_id: str, force: bool = False) -> None:
        self.killed.append(session_id)


class FakeAttribution:
    def __init__(self) -> None:
        self.unregistered: list[str] = []

    def unregister_pane(self, pane_id: str) -> None:
        self.unregistered.append(pane_id)


@pytest.fixture()
def store(monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    project_store = ProjectStore()
    monkeypatch.setattr(app, "project_store", project_store)
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    agent_messaging._reset_for_test()
    yield project_store
    agent_messaging._reset_for_test()


def _session(terminals: FakeTerminals) -> app.Session:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = terminals  # type: ignore[assignment]
    return session


async def _kill_surface(session: app.Session, payload: dict[str, Any]) -> dict[str, Any]:
    await app.handle_message(session, {"id": "k1", "type": "terminal.kill_surface", "payload": payload})
    return session.websocket.sent[-1]  # type: ignore[attr-defined]


def _dock_meta(ws: str, surface: str) -> dict[str, Any]:
    return {"workspace_path": ws, "surface": surface, "window_kind": surface}


@pytest.mark.asyncio
async def test_ends_only_the_panels_of_that_surface_and_workspace(tmp_path: Path, store: ProjectStore) -> None:
    ws = str(tmp_path / "a")
    other_ws = str(tmp_path / "b")
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    store.record_manual_pane_spawn(ws, pane_id="dock-plans", agent="claude", origin="plan-window", surface="plans")
    store.record_manual_pane_spawn(ws, pane_id="dock-git", agent="claude", origin="git-window", surface="git")
    store.record_manual_pane_spawn(other_ws, pane_id="dock-plans-b", agent="claude", origin="plan-window", surface="plans")
    terminals = FakeTerminals([
        _term("t-plans", "dock-plans", _dock_meta(ws, "plans")),
        _term("t-git", "dock-git", _dock_meta(ws, "git")),
        _term("t-plans-b", "dock-plans-b", _dock_meta(other_ws, "plans")),
    ])
    session = _session(terminals)

    reply = await _kill_surface(session, {"surface": "plans", "workspace_path": ws + "/"})

    assert reply["payload"]["pane_ids"] == ["dock-plans"]
    assert terminals.killed == ["t-plans"]
    statuses = {p.pane_id: p.spawn_status for p in store.load_or_create(ws).panes}
    assert statuses == {"dock-plans": "removed", "dock-git": "spawned"}
    assert [p.spawn_status for p in store.load_or_create(other_ws).panes] == ["spawned"]


@pytest.mark.asyncio
async def test_never_touches_a_session_without_a_panel_surface(tmp_path: Path, store: ProjectStore) -> None:
    """T10: a window pane's session carries no surface — whatever its pane id or
    workspace, kill_surface must leave both its PTY and its record alone."""
    ws = str(tmp_path)
    store.record_manual_pane_spawn(ws, pane_id="main-pane", agent="claude")
    terminals = FakeTerminals([
        _term("t-main", "main-pane", {"workspace_path": ws}),
        _term("t-main-explicit", "main-pane-2", {"workspace_path": ws, "surface": "main"}),
        _term("t-bare", "main-pane-3", {}),
    ])
    session = _session(terminals)

    reply = await _kill_surface(session, {"surface": "plans", "workspace_path": ws})

    assert reply["payload"]["pane_ids"] == []
    assert terminals.killed == []
    assert [p.spawn_status for p in store.load_or_create(ws).panes] == ["spawned"]


@pytest.mark.asyncio
async def test_unregisters_the_panel_but_not_a_window_pane(tmp_path: Path, store: ProjectStore) -> None:
    ws = str(tmp_path)
    store.record_manual_pane_spawn(ws, pane_id="dock-plans", agent="claude", origin="plan-window", surface="plans")
    agent_messaging.register(
        pane_id="dock-plans", name="plans-claude", workspace_path=ws, agent_key="claude",
        surface="plans", window_kind="plans",
    )
    agent_messaging.register(pane_id="main-pane", name="claude-1", workspace_path=ws, agent_key="claude")
    terminals = FakeTerminals([_term("t-plans", "dock-plans", _dock_meta(ws, "plans"))])
    session = _session(terminals)

    await _kill_surface(session, {"surface": "plans", "workspace_path": ws})

    assert agent_messaging.get("dock-plans") is None
    assert agent_messaging.get("main-pane") is not None


@pytest.mark.asyncio
async def test_a_window_pane_record_under_the_same_id_is_not_retired(tmp_path: Path, store: ProjectStore) -> None:
    """The store refuses to turn a window pane's record into a panel's; ending
    the panel must likewise leave that record (and its roster entry) alone."""
    ws = str(tmp_path)
    store.record_manual_pane_spawn(ws, pane_id="shared-id", agent="claude")
    agent_messaging.register(pane_id="shared-id", name="claude-1", workspace_path=ws, agent_key="claude")
    terminals = FakeTerminals([_term("t-dock", "shared-id", _dock_meta(ws, "plans"))])
    session = _session(terminals)

    await _kill_surface(session, {"surface": "plans", "workspace_path": ws})

    assert [p.spawn_status for p in store.load_or_create(ws).panes] == ["spawned"]
    assert agent_messaging.get("shared-id") is not None


@pytest.mark.asyncio
@pytest.mark.parametrize("surface", ["", "main", "nonexistent"])
async def test_unknown_or_main_surface_is_a_no_op(tmp_path: Path, store: ProjectStore, surface: str) -> None:
    ws = str(tmp_path)
    terminals = FakeTerminals([
        _term("t-plans", "dock-plans", _dock_meta(ws, "plans")),
        _term("t-main", "main-pane", {"workspace_path": ws}),
    ])
    session = _session(terminals)

    reply = await _kill_surface(session, {"surface": surface, "workspace_path": ws})

    assert reply["payload"]["pane_ids"] == []
    assert terminals.killed == []


@pytest.mark.asyncio
async def test_is_idempotent(tmp_path: Path, store: ProjectStore) -> None:
    ws = str(tmp_path)
    store.record_manual_pane_spawn(ws, pane_id="dock-plans", agent="claude", origin="plan-window", surface="plans")
    term = _term("t-plans", "dock-plans", _dock_meta(ws, "plans"))
    terminals = FakeTerminals([term])
    session = _session(terminals)

    await _kill_surface(session, {"surface": "plans", "workspace_path": ws})
    term.closed = True
    reply = await _kill_surface(session, {"surface": "plans", "workspace_path": ws})

    assert reply["type"] == "terminal.kill_surface.result"
    assert reply["payload"]["pane_ids"] == []
    assert terminals.killed == ["t-plans"]
    assert [p.spawn_status for p in store.load_or_create(ws).panes] == ["removed"]


@pytest.mark.asyncio
async def test_closed_sessions_are_skipped(tmp_path: Path, store: ProjectStore) -> None:
    ws = str(tmp_path)
    terminals = FakeTerminals([_term("t-old", "dock-plans", _dock_meta(ws, "plans"), closed=True)])
    session = _session(terminals)

    reply = await _kill_surface(session, {"surface": "plans", "workspace_path": ws})

    assert reply["payload"]["pane_ids"] == []
    assert terminals.killed == []


@pytest.mark.asyncio
async def test_without_a_workspace_ends_that_surface_everywhere(tmp_path: Path, store: ProjectStore) -> None:
    """A single-instance window (the Git window, the Mini-IDE) does not tell the
    main process which workspace its panel last ran in; closing it ends every
    panel of its surface. Other surfaces and window panes stay."""
    ws_a = str(tmp_path / "a")
    ws_b = str(tmp_path / "b")
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    store.record_manual_pane_spawn(ws_a, pane_id="git-a", agent="claude", origin="git-window", surface="git")
    store.record_manual_pane_spawn(ws_b, pane_id="git-b", agent="claude", origin="git-window", surface="git")
    terminals = FakeTerminals([
        _term("t-git-a", "git-a", _dock_meta(ws_a, "git")),
        _term("t-git-b", "git-b", _dock_meta(ws_b, "git")),
        _term("t-plans", "plans-a", _dock_meta(ws_a, "plans")),
        _term("t-main", "main-a", {"workspace_path": ws_a}),
    ])
    session = _session(terminals)

    reply = await _kill_surface(session, {"surface": "git"})

    assert reply["payload"]["pane_ids"] == ["git-a", "git-b"]
    assert terminals.killed == ["t-git-a", "t-git-b"]
    assert [p.spawn_status for p in store.load_or_create(ws_a).panes] == ["removed"]
    assert [p.spawn_status for p in store.load_or_create(ws_b).panes] == ["removed"]


@pytest.mark.asyncio
async def test_one_failing_kill_does_not_stop_the_others(tmp_path: Path, store: ProjectStore) -> None:
    """A kill that raises is logged and skipped: the remaining panels still go
    down, have their records retired, and the reply still goes out."""
    ws_a = str(tmp_path / "a")
    ws_b = str(tmp_path / "b")
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    store.record_manual_pane_spawn(ws_a, pane_id="git-a", agent="claude", origin="git-window", surface="git")
    store.record_manual_pane_spawn(ws_b, pane_id="git-b", agent="claude", origin="git-window", surface="git")

    class FailingFirstKill(FakeTerminals):
        async def kill(self, session_id: str, force: bool = False) -> None:
            if session_id == "t-git-a":
                raise OSError("kill failed")
            await super().kill(session_id, force)

    terminals = FailingFirstKill([
        _term("t-git-a", "git-a", _dock_meta(ws_a, "git")),
        _term("t-git-b", "git-b", _dock_meta(ws_b, "git")),
    ])
    session = _session(terminals)

    reply = await _kill_surface(session, {"surface": "git"})

    assert reply["type"] == "terminal.kill_surface.result"
    assert reply["payload"]["pane_ids"] == ["git-b"]
    assert terminals.killed == ["t-git-b"]
    # The caller learns which panel is still running, and why.
    assert reply["payload"]["failed"] == [
        {"pane_id": "git-a", "terminal_session_id": "t-git-a", "error": "kill failed"}
    ]
    assert [p.spawn_status for p in store.load_or_create(ws_b).panes] == ["removed"]
