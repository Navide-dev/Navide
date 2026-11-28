"""project.log_event reads and writes the project store off the event loop.

Under ~80 panes, peek() (a db kv read plus Project.from_dict) sat in 37
event-loop stall stacks in one day of backend.log (2026-11-28), reached from
project_log_event on the loop.
"""

from __future__ import annotations

import threading

import pytest

from agent_team_backend import app as app_module
from agent_team_backend import ws_handlers


class _Session:
    def __init__(self) -> None:
        self.sent: list = []
        self.dead = False
        self.window_id = "win-1"

    async def send_json(self, message: dict) -> None:
        self.sent.append(message)


class _Store:
    def __init__(self) -> None:
        self.threads: dict[str, int] = {}

    def peek(self, workspace_path: str):
        self.threads["peek"] = threading.get_ident()
        return None

    def record_pane_event(self, workspace_path: str, **kwargs) -> None:
        self.threads["record_pane_event"] = threading.get_ident()


class _History:
    def record(self, *args, **kwargs):
        return None

    def record_line(self, *args, **kwargs):
        return None


async def test_project_store_is_used_off_the_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    store = _Store()
    monkeypatch.setattr(app_module, "project_store", store)
    monkeypatch.setattr(app_module, "history_store", _History())
    loop_thread = threading.get_ident()

    await ws_handlers.lookup("project.log_event")(
        _Session(), "m1", "project.log_event",
        {"workspace_path": "/tmp/ws", "event_type": "note", "pane_id": "p1"},
    )

    assert set(store.threads) == {"peek", "record_pane_event"}
    assert loop_thread not in store.threads.values()
