"""_sweep_pane_ptys must reach a PTY recorded under the pane's former id.

A restore mints a fresh pane id, but a reattached PTY keeps the pane id it was
created with — the backend learns of the rename only through the alias table
(agent_messaging.add_aliases). The sweep is the safety net for a pane whose
renderer-side kill was refused; looking up the current id alone found nothing
for every reattached pane, so their processes outlived the record.
"""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import agent_messaging, app, ws_handlers


class FakeWebSocket:
    async def send_json(self, payload: dict[str, Any]) -> None:
        pass


class FakeTerminals:
    def __init__(self, by_pane: dict[str, list[str]]) -> None:
        self._by_pane = by_pane
        self.killed: list[tuple[str, bool]] = []

    def live_session_ids_for_pane(self, pane_id: str) -> list[str]:
        return list(self._by_pane.get(pane_id, []))

    async def kill(self, session_id: str, force: bool = False) -> None:
        self.killed.append((session_id, force))


@pytest.fixture(autouse=True)
def _clean_registry():
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


def _session(terminals: FakeTerminals) -> "app.Session":
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = terminals  # type: ignore[assignment]
    return session


@pytest.mark.asyncio
async def test_sweep_reaches_pty_created_under_a_former_pane_id(tmp_path) -> None:
    ws = str(tmp_path)
    agent_messaging.register("pane-new", "worker", ws)
    agent_messaging.add_aliases("pane-new", ["pane-old"], ws)
    terminals = FakeTerminals({"pane-old": ["t-reattached"]})

    await ws_handlers._sweep_pane_ptys(_session(terminals), "pane-new")

    assert terminals.killed == [("t-reattached", True)]


@pytest.mark.asyncio
async def test_sweep_leaves_another_panes_former_ids_alone(tmp_path) -> None:
    ws = str(tmp_path)
    agent_messaging.register("pane-new", "worker", ws)
    agent_messaging.register("pane-other", "other", ws)
    agent_messaging.add_aliases("pane-other", ["pane-old"], ws)
    terminals = FakeTerminals({"pane-old": ["t-other"], "pane-new": ["t-mine"]})

    await ws_handlers._sweep_pane_ptys(_session(terminals), "pane-new")

    assert terminals.killed == [("t-mine", True)]
