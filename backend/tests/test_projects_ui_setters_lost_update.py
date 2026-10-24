"""project.set_layout_mode / set_theme / set_language must not overwrite a
write made by another thread while they run.

Each used to peek the project, change one field and save the whole document
without holding the store's save lock: a background-thread write landing
between the peek and the save (an unspawn, a live-stamp clear) was replaced
by the stale copy. Same lost update as #603, on the renderer's ui setters.
"""

from __future__ import annotations

import asyncio
import threading
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app, ws_handlers
from agent_team_backend.projects import ProjectStore

# How long the racing write gets to land inside the handler's read-modify-write.
# Unlocked, it lands well within this; locked, it waits for the handler instead.
_RACE_WINDOW_S = 0.3


class _Session:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, message: dict[str, Any]) -> None:
        self.sent.append(message)


def _race_peek(store: ProjectStore, ws: str, monkeypatch: pytest.MonkeyPatch) -> list[threading.Thread]:
    """Make the next peek() let another thread rename the workspace before it returns."""
    real_peek = store.peek
    racers: list[threading.Thread] = []

    def peek(workspace_path: str) -> Any:
        project = real_peek(workspace_path)
        if not racers:
            racer = threading.Thread(target=store.set_display_name, args=(ws, "renamed elsewhere"))
            racers.append(racer)
            racer.start()
            racer.join(_RACE_WINDOW_S)
        return project

    monkeypatch.setattr(store, "peek", peek)
    return racers


@pytest.mark.parametrize(
    ("msg_type", "payload", "field", "expected"),
    [
        ("project.set_layout_mode", {"layout_mode": "spotlight"}, "layout_mode", "spotlight"),
        ("project.set_theme", {"theme": "dark"}, "theme", "dark"),
        ("project.set_language", {"language": "de-DE"}, "language", "de-DE"),
    ],
)
def test_a_ui_setter_keeps_a_write_made_while_it_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    msg_type: str, payload: dict[str, Any], field: str, expected: str,
) -> None:
    ws = str(tmp_path)
    store = ProjectStore()
    store.load_or_create(ws)
    monkeypatch.setattr(app, "project_store", store)
    racers = _race_peek(store, ws, monkeypatch)
    handler = {
        "project.set_layout_mode": ws_handlers.project_set_layout_mode,
        "project.set_theme": ws_handlers.project_set_theme,
        "project.set_language": ws_handlers.project_set_language,
    }[msg_type]
    session = _Session()

    asyncio.run(handler(session, "m1", msg_type, {"workspace_path": ws, **payload}))  # type: ignore[arg-type]
    for racer in racers:
        racer.join(10)
        assert not racer.is_alive()

    project = ProjectStore().peek(ws)
    assert project is not None
    assert getattr(project, field) == expected
    assert project.display_name == "renamed elsewhere"  # not reverted by the stale copy
    assert session.sent and session.sent[-1]["payload"] == {"ok": True}
