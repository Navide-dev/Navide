"""#448 diagnostics, counters only: how many terminal frames the backend
dropped because no window owns the PTY, and how many terminal requests named
a terminal id it does not know. Read through ui_diagnostics (frame_drops);
nothing about routing changes."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend import ws_handlers
from agent_team_backend.ipc import make_event


def _frame(session_id: str, data: bytes = b"hi") -> bytes:
    sid = session_id.encode()
    return b"".join((b"\x01", (1).to_bytes(4, "little"), bytes((len(sid),)), sid, b"\x00", data))


class _Session:
    def __init__(self) -> None:
        self.sent: list[Any] = []
        self.dead = False

    async def send_json(self, message: dict[str, Any]) -> None:
        self.sent.append(message)

    async def send_bytes(self, frame: bytes) -> None:
        self.sent.append(frame)


@pytest.fixture(autouse=True)
def _fresh_counters(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app, "_FRAME_DROPS", {"ownerless": 0, "unknown_terminal": 0})
    monkeypatch.setattr(app, "_PTY_OWNERS", {})


async def test_output_for_a_pty_no_window_owns_is_counted() -> None:
    owner = _Session()
    app._PTY_OWNERS["owned"] = owner

    await app._active_emit(_frame("owned"))
    await app._active_emit(_frame("nobody"))
    await app._active_emit(make_event("terminal.title", {"terminal_session_id": "nobody", "title": "t"}))

    assert owner.sent == [_frame("owned")]
    assert app.frame_drop_counts() == {"ownerless": 2, "unknown_terminal": 0}


async def test_a_request_for_an_unknown_terminal_id_is_counted(monkeypatch: pytest.MonkeyPatch) -> None:
    async def write_unknown(session, msg_id, msg_type, payload):
        raise KeyError("unknown terminal session: t-gone")

    async def missing_field(session, msg_id, msg_type, payload):
        raise KeyError("workspace_path")

    handlers = {"terminal.input": write_unknown, "pipeline.start": missing_field}
    monkeypatch.setattr(ws_handlers, "lookup", lambda t: handlers.get(t))
    session = _Session()

    await app.handle_message(session, {"id": "1", "type": "terminal.input", "payload": {}})
    await app.handle_message(session, {"id": "2", "type": "pipeline.start", "payload": {}})

    assert [m["error"]["code"] for m in session.sent] == ["BAD_REQUEST", "BAD_REQUEST"]
    assert app.frame_drop_counts() == {"ownerless": 0, "unknown_terminal": 1}


async def test_ui_diagnostics_carries_the_counts(monkeypatch: pytest.MonkeyPatch) -> None:
    from agent_team_backend.mcp_server import server as mcp

    app._FRAME_DROPS["ownerless"] = 3

    async def window_answer(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {"ok": True, "result": {"entries": [], "nextSeq": 0}}

    monkeypatch.setattr(mcp, "_ui_request", window_answer)
    monkeypatch.setattr(mcp, "_resolve_caller", lambda ctx: mcp._Caller(kind="host"))
    monkeypatch.setattr(mcp, "_persisted_scope", lambda caller, ws: None)

    answer = await mcp.ui_diagnostics("/ws", SimpleNamespace())

    assert answer["frame_drops"] == {"ownerless": 3, "unknown_terminal": 0}
