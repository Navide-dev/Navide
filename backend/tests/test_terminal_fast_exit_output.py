"""A child that prints and exits before the backend reads must not lose output.

On macOS, once the last slave fd of a PTY closes, whatever the master has not
read yet is discarded and the master reads EOF. The backend used to close its
own slave copy right after spawn, so a short command (or a CLI's final error
line) vanished whenever the event loop was busy at the moment the child
exited: the bench smoke test caught it on a loaded CI runner. These tests make
the loop busy on purpose by blocking it until the child is long gone.
"""

import asyncio
import sys
import tempfile
import time

import pytest

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX PTY behaviour")

from agent_team_backend.terminals import TerminalService

_MARKER = "fast-exit-" + "marker"


class _Sink:
    def __init__(self) -> None:
        self.data = b""
        self.exited = asyncio.Event()

    async def emit(self, event: object) -> None:
        if isinstance(event, (bytes, bytearray)):
            frame = bytes(event)
            off = 6 + frame[5]
            off += 1 + frame[off]
            self.data += frame[off:]
        elif isinstance(event, dict) and event.get("type") == "terminal.exit":
            self.exited.set()


def _spawn(svc: TerminalService, pane: str):
    return svc.create(
        pane_id=pane,
        agent_key=None,
        command=[sys.executable, "-c", f"print({_MARKER!r})"],
        cwd=tempfile.gettempdir(),
    )


async def test_output_survives_a_child_that_exits_before_the_first_read():
    for i in range(3):
        sink = _Sink()
        svc = TerminalService(sink.emit)
        _spawn(svc, f"fast-exit-{i}")
        # Block the loop past the ~0.5 s the exiting child waits for a read.
        time.sleep(1.5)
        await asyncio.wait_for(sink.exited.wait(), 10)
        assert _MARKER.encode() in sink.data, (i, sink.data)


async def test_paused_reader_still_gets_the_output_and_the_exit():
    sink = _Sink()
    svc = TerminalService(sink.emit)
    session = _spawn(svc, "fast-exit-paused")
    # Backpressure holds the reader off while the child prints and exits.
    session.handle.pause_reading()
    time.sleep(1.5)
    await asyncio.sleep(0.2)
    assert not sink.exited.is_set()
    session.handle.resume_reading()
    await asyncio.wait_for(sink.exited.wait(), 10)
    assert _MARKER.encode() in sink.data, sink.data
