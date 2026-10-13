"""workspace.* handlers: the Recent safety bound never drops an open workspace.

The store only protects what it is told is open; these drive the real handlers
so that wiring — the window's open list and the live panes — is what is tested.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent_team_backend import app as app_module
from agent_team_backend import ws_handlers
from agent_team_backend.recent_workspaces import RecentWorkspacesStore


class _Session:
    def __init__(self) -> None:
        self.sent: list = []

    async def send_json(self, message: dict) -> None:
        self.sent.append(message)


@pytest.fixture
def wired(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[RecentWorkspacesStore, list]:
    store = RecentWorkspacesStore(path=tmp_path / "recent-workspaces.json")
    events: list = []

    async def fake_broadcast(event: dict) -> None:
        events.append(event)

    monkeypatch.setattr(app_module, "recent_workspaces_store", store, raising=False)
    monkeypatch.setattr(app_module, "broadcast", fake_broadcast, raising=False)
    monkeypatch.setattr(
        app_module, "project_store", SimpleNamespace(peek=lambda _p: None), raising=False
    )
    monkeypatch.setattr(app_module, "get_terminals", lambda: None, raising=False)
    return store, events


def _dirs(tmp_path: Path, *names: str) -> list[str]:
    out = []
    for n in names:
        (tmp_path / n).mkdir()
        out.append(str(tmp_path / n))
    return out


def _touch(path: str, **extra: object) -> dict:
    session = _Session()
    asyncio.run(
        ws_handlers.workspace_touch(session, "m1", "workspace.touch", {"path": path, **extra})
    )
    return session.sent[-1]["payload"]


def test_touch_spares_workspaces_the_window_reports_open(wired, tmp_path: Path) -> None:
    store, _ = wired
    store.set_limit(2)
    a, b, c = _dirs(tmp_path, "a", "b", "c")
    _touch(a)
    _touch(b)
    payload = _touch(c, open=[a])
    assert [e["name"] for e in payload["recent"]] == ["c", "a"]
    assert payload["limit"] == 2
    assert payload["trimmed"] == 1


def test_touch_spares_workspaces_with_live_panes(wired, tmp_path: Path, monkeypatch) -> None:
    store, _ = wired
    store.set_limit(2)
    a, b, c = _dirs(tmp_path, "a", "b", "c")
    live = SimpleNamespace(closed=False, metadata={"workspace_path": a}, cwd=a)
    monkeypatch.setattr(
        app_module, "get_terminals", lambda: SimpleNamespace(_sessions={"s": live}), raising=False
    )
    _touch(a)
    _touch(b)
    _touch(c)
    assert [e["name"] for e in store.list()] == ["c", "a"]


def test_list_recent_reports_limit_and_trimmed(wired) -> None:
    session = _Session()
    asyncio.run(ws_handlers.workspace_list_recent(session, "m1", "workspace.list_recent", {}))
    payload = session.sent[-1]["payload"]
    assert payload["limit"] == 1000
    assert payload["trimmed"] == 0


def test_set_recent_limit_off_and_broadcasts(wired) -> None:
    store, events = wired
    session = _Session()
    asyncio.run(
        ws_handlers.workspace_set_recent_limit(
            session, "m1", "workspace.set_recent_limit", {"limit": None}
        )
    )
    assert store.info()["limit"] is None
    assert session.sent[-1]["payload"]["limit"] is None
    assert events[-1]["payload"]["limit"] is None


def test_set_recent_limit_rejects_garbage(wired) -> None:
    store, _ = wired
    session = _Session()
    asyncio.run(
        ws_handlers.workspace_set_recent_limit(
            session, "m1", "workspace.set_recent_limit", {"limit": 0}
        )
    )
    assert session.sent[-1].get("ok") is False or "error" in session.sent[-1]
    assert store.info()["limit"] == 1000
