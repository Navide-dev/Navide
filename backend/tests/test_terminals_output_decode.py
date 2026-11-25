"""Tests for the raw-bytes output path and the log-mirror decoding.

Terminal output ships as raw PTY bytes in binary WS frames — the transport
never decodes, so a chunk ending mid-character stays byte-exact and the
frontend's streaming decoder reassembles it. Decoding only happens for the
conversation-log mirror (pipeline panes), where the per-session incremental
decoder keeps a split multi-byte char from becoming U+FFFD in the log.
"""

import io
import os
from types import SimpleNamespace

import pytest

# Real POSIX PTY behaviour: the module is skipped where these do not exist.
fcntl = pytest.importorskip("fcntl")

from agent_team_backend import pane_log_writer
from agent_team_backend.osplat._posix import PosixTerminalHandle
from agent_team_backend.terminals import TerminalService

def _nonblocking(fd: int) -> None:
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

async def _emit(_event):  # EventSink stub — never actually called on this path
    return None

def _cancel_pending_flush(svc: TerminalService, session_id: str) -> None:
    handle = svc._out_handles.pop(session_id, None)
    if handle:
        handle.cancel()

@pytest.mark.asyncio
async def test_raw_bytes_are_buffered_unmodified_across_a_split_char():
    svc = TerminalService(_emit)
    r, w = os.pipe()
    _nonblocking(r)
    session = SimpleNamespace(id="t-utf8", handle=PosixTerminalHandle(r), closed=False)
    svc._sessions["t-utf8"] = session
    try:
        payload = "中文字".encode("utf-8")  # 9 bytes, 3 bytes per char
        os.write(w, payload[:4])  # ends 1 byte into the second character
        svc._on_readable(session)
        os.write(w, payload[4:])
        svc._on_readable(session)

        # The transport buffers the exact bytes — no decode, no held-back tail.
        assert b"".join(svc._out_buffers["t-utf8"]) == payload
    finally:
        _cancel_pending_flush(svc, "t-utf8")
        os.close(r)
        os.close(w)

@pytest.mark.asyncio
async def test_log_mirror_reassembles_a_split_multibyte_char():
    svc = TerminalService(_emit)
    log_fp = io.StringIO()
    session = SimpleNamespace(
        id="t-log", pane_id="p1", sequence=0, closed=False, output_log_fp=log_fp
    )
    payload = "中文字".encode("utf-8")
    svc._mirror_to_log(session, payload[:4])
    svc._mirror_to_log(session, payload[4:])
    assert pane_log_writer.WRITER.drain()  # written off the loop (pane_log_writer)
    assert "�" not in log_fp.getvalue()
    assert "中文字" in log_fp.getvalue()

@pytest.mark.asyncio
async def test_log_mirror_turns_genuinely_invalid_bytes_into_replacements():
    svc = TerminalService(_emit)
    log_fp = io.StringIO()
    session = SimpleNamespace(
        id="t-bad", pane_id="p1", sequence=0, closed=False, output_log_fp=log_fp
    )
    # 0xFF/0xFE can never start a UTF-8 sequence.
    svc._mirror_to_log(session, b"ok\xff\xfeok\n")
    assert pane_log_writer.WRITER.drain()
    assert "ok��ok" in log_fp.getvalue()
