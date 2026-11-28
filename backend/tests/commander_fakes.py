"""Shared fakes for the commander tests: panes, a clock and a service."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

from agent_team_backend.commander_service import CommanderService
from agent_team_backend.commander_store import CommanderStore
from agent_team_backend.db import Database


def pane(pane_id: str, name: str = "", *, workspace: str = "/ws", agent_key: str = "claude",
         busy: bool = False, display_status: str = "") -> SimpleNamespace:
    return SimpleNamespace(pane_id=pane_id, name=name or pane_id, workspace_path=workspace,
                           agent_key=agent_key, busy=busy, display_status=display_status)


class World:
    """Registered panes, their activity and sent messages, on a fake clock."""

    def __init__(self) -> None:
        self.panes: dict[str, SimpleNamespace] = {}
        self.aliases: dict[str, str] = {}
        self.activity: dict[str, dict[str, Any]] = {}
        self.messages: list[tuple[str, str, int]] = []
        self.mono = 1000.0
        self.wall = 1_700_000_000.0

    def add(self, p: SimpleNamespace) -> SimpleNamespace:
        self.panes[p.pane_id] = p
        return p

    def lookup(self, pane_id: str) -> SimpleNamespace | None:
        return self.panes.get(self.aliases.get(pane_id, pane_id))

    def touch(self, pane_id: str) -> None:
        self.activity[pane_id] = {"event_type": "agent_active", "ts_monotonic": self.mono, "text": ""}

    def advance(self, seconds: float) -> None:
        self.mono += seconds
        self.wall += seconds

    def reported(self, sender: str, recipient: str, since: int) -> bool:
        return any(s == sender and r == recipient and at >= since for s, r, at in self.messages)


def service(tmp_path: Path, world: World | None = None) -> CommanderService:
    world = world or World()
    store = CommanderStore(Database(tmp_path / "navide.db"), memory_root=tmp_path / "commanders")
    return CommanderService(
        store, pane=world.lookup, activity=world.activity.get, reported=world.reported,
        monotonic=lambda: world.mono, clock=lambda: world.wall,
    )
