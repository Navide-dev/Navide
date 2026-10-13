"""A CLI that exits on the SIGTERM a shutdown or a kill sends must still be
reported with the reason the backend chose (shutdown / killed), not "exit".

The reader can see the child's EOF before the closing path runs its own
_close: kill_all sleeps between signalling and closing, and a graceful kill
keeps the master open across its grace. Reported as a clean "exit", a panel's
restore record was retired on every app quit (ws_handlers.note_terminal_exit).
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend.terminals import TerminalService

# Exits 0 on SIGTERM, as a CLI that saves its state on the way out does.
_TRAPS_TERM = ["sh", "-c", 'trap "exit 0" TERM; while :; do sleep 0.05; done']


def _collector() -> tuple[list[dict[str, Any]], Any]:
    events: list[dict[str, Any]] = []

    async def emit(event: dict[str, Any]) -> None:
        events.append(event)

    return events, emit


def _exit_reasons(events: list[dict[str, Any]]) -> list[str]:
    return [
        e["payload"]["reason"] for e in events
        if isinstance(e, dict) and e.get("type") == "terminal.exit"
    ]


@pytest.mark.asyncio
async def test_shutdown_of_a_cli_that_exits_on_sigterm_reads_as_shutdown() -> None:
    events, emit = _collector()
    svc = TerminalService(emit=emit)
    svc.create(pane_id="p1", agent_key=None, command=_TRAPS_TERM, cwd="/")
    await asyncio.sleep(0.3)  # let the shell install its trap
    await svc.kill_all(grace=0.5)
    await asyncio.sleep(0.1)
    assert _exit_reasons(events) == ["shutdown"]


@pytest.mark.asyncio
async def test_graceful_kill_of_a_cli_that_exits_on_sigterm_reads_as_killed(monkeypatch) -> None:
    events, emit = _collector()
    svc = TerminalService(emit=emit)
    session = svc.create(pane_id="p1", agent_key=None, command=_TRAPS_TERM, cwd="/")
    spec = SimpleNamespace(graceful=True, grace_s=2.0, defer_master_close=True)
    monkeypatch.setattr(svc, "_shutdown_spec", lambda _session: spec)
    await asyncio.sleep(0.3)
    await svc.kill(session.id)
    for _ in range(60):
        if _exit_reasons(events):
            break
        await asyncio.sleep(0.05)
    await asyncio.sleep(0.1)
    assert _exit_reasons(events) == ["killed"]
