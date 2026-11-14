"""p2p.link.status reads the paused switch off the event loop.

The setting lives in the SQLite kv store; a `db.kv_get` behind this handler
showed up in loop-stall stacks during the 2026-11-12 mass restore, when the
window polls link status alongside everything else.
"""

from __future__ import annotations

import threading
from typing import Any

import pytest

from agent_team_backend import app, server_link, ws_handlers


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


@pytest.mark.asyncio
async def test_link_status_reads_paused_off_the_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    loop_thread = threading.get_ident()
    seen: list[int] = []

    async def status() -> dict[str, Any]:
        return {"state": "unconfigured"}

    def paused() -> bool:
        seen.append(threading.get_ident())
        return True

    monkeypatch.setattr(server_link, "status", status)
    monkeypatch.setattr(ws_handlers, "_link_paused", paused)
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]

    await app.handle_message(session, {"id": "s1", "type": "p2p.link.status", "payload": {}})

    assert session.websocket.sent[0]["payload"]["status"]["paused"] is True  # type: ignore[attr-defined]
    assert seen and seen[0] != loop_thread
