"""terminal.input inject_id/seq: a resent chunk is written once.

2026-11-15 10:16 a 15.9 s event-loop stall outlasted the renderer's 10 s
request timeout on chunk 1/3 of a message; the renderer gave the message up
while the backend went on to write the chunk once it got to it. Resending is
only safe when the backend can tell a resend from new text: a write tagged with
the same (inject_id, seq) as one already applied is answered again, not
written again.
"""

from __future__ import annotations

import uuid

import pytest

from agent_team_backend import app as app_module


class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, data: dict) -> None:
        self.sent.append(data)

    async def send_text(self, data: str) -> None:
        import json

        self.sent.append(json.loads(data))


class _RecordingTerminals:
    def __init__(self) -> None:
        self.writes: list[tuple[str, str]] = []

    def write(self, session_id: str, data: str) -> int:
        if data:
            self.writes.append((session_id, data))
        return 0

    def get(self, session_id: str):
        return None

    def shell_in_foreground(self, session_id: str):
        return None


async def _send(session, payload: dict) -> dict:
    msg_id = str(uuid.uuid4())
    await app_module.handle_message(session, {"id": msg_id, "type": "terminal.input", "payload": payload})
    frames = [f for f in session.websocket.sent if f.get("id") == msg_id]
    return frames[-1]["payload"]


def _session():
    s = app_module.Session(_FakeWebSocket())  # type: ignore[arg-type]
    s.terminals = _RecordingTerminals()  # type: ignore[assignment]
    return s


@pytest.mark.asyncio
async def test_a_resent_chunk_is_acknowledged_without_a_second_write():
    session = _session()
    inject_id = uuid.uuid4().hex
    first = await _send(session, {"terminal_session_id": "t", "data": "hello", "inject_id": inject_id, "seq": 0})
    again = await _send(session, {"terminal_session_id": "t", "data": "hello", "inject_id": inject_id, "seq": 0})
    assert session.terminals.writes == [("t", "hello")]
    assert first == {"ok": True, "pending": 0}
    assert again == {"ok": True, "pending": 0, "duplicate": True}


@pytest.mark.asyncio
async def test_the_next_seq_of_the_same_injection_is_written():
    session = _session()
    inject_id = uuid.uuid4().hex
    await _send(session, {"terminal_session_id": "t", "data": "a", "inject_id": inject_id, "seq": 0})
    await _send(session, {"terminal_session_id": "t", "data": "b", "inject_id": inject_id, "seq": 1})
    assert session.terminals.writes == [("t", "a"), ("t", "b")]


@pytest.mark.asyncio
async def test_untagged_writes_are_never_deduplicated():
    session = _session()
    await _send(session, {"terminal_session_id": "t", "data": "x"})
    await _send(session, {"terminal_session_id": "t", "data": "x"})
    assert session.terminals.writes == [("t", "x"), ("t", "x")]


@pytest.mark.asyncio
async def test_the_same_tag_on_another_session_is_its_own_write():
    session = _session()
    inject_id = uuid.uuid4().hex
    await _send(session, {"terminal_session_id": "t1", "data": "a", "inject_id": inject_id, "seq": 0})
    await _send(session, {"terminal_session_id": "t2", "data": "a", "inject_id": inject_id, "seq": 0})
    assert session.terminals.writes == [("t1", "a"), ("t2", "a")]


@pytest.mark.asyncio
async def test_a_refused_write_is_not_remembered_as_applied():
    session = _session()
    inject_id = uuid.uuid4().hex
    session.terminals.shell_in_foreground = lambda _sid: False  # type: ignore[method-assign]
    busy = await _send(session, {
        "terminal_session_id": "t", "data": "ls", "inject_id": inject_id, "seq": 0, "require_shell_prompt": True,
    })
    assert busy == {"ok": False, "error": "foreground-busy"}
    session.terminals.shell_in_foreground = lambda _sid: None  # type: ignore[method-assign]
    await _send(session, {
        "terminal_session_id": "t", "data": "ls", "inject_id": inject_id, "seq": 0, "require_shell_prompt": True,
    })
    assert session.terminals.writes == [("t", "ls")]


def test_the_remembered_tags_stay_bounded():
    from agent_team_backend import ws_handlers

    ws_handlers._APPLIED_INJECT_CHUNKS.clear()
    for i in range(ws_handlers._APPLIED_INJECT_MAX + 50):
        ws_handlers._remember_inject_chunk("t", f"id-{i}", 0)
    assert len(ws_handlers._APPLIED_INJECT_CHUNKS) == ws_handlers._APPLIED_INJECT_MAX
    assert ws_handlers._inject_chunk_applied("t", f"id-{ws_handlers._APPLIED_INJECT_MAX + 49}", 0)
    assert not ws_handlers._inject_chunk_applied("t", "id-0", 0)
