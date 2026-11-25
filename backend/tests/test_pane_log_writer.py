"""Pane logs are written off the event loop, in order, flushed within a bound
(pane_log_writer). 2026-11-26: the synchronous write and flush of the log
mirror was the loop's second most common stall frame at load 88."""

from __future__ import annotations

import time
from pathlib import Path

from agent_team_backend import pane_log_writer
from agent_team_backend.pane_log_writer import FLUSH_WITHIN_S, PaneLogWriter


class _SlowFile:
    """Records writes and flushes; every write takes ``delay`` (a busy disk)."""

    def __init__(self, delay: float = 0.0) -> None:
        self.delay = delay
        self.events: list[tuple[str, str]] = []
        self.closed = False

    def write(self, text: str) -> int:
        time.sleep(self.delay)
        self.events.append(("write", text))
        return len(text)

    def flush(self) -> None:
        self.events.append(("flush", ""))

    def close(self) -> None:
        self.closed = True
        self.events.append(("close", ""))


def test_writes_keep_their_order_across_files() -> None:
    writer = PaneLogWriter()
    a, b = _SlowFile(), _SlowFile()
    for i in range(200):
        writer.write(a if i % 2 else b, f"{i},")
    assert writer.drain()
    assert "".join(t for k, t in a.events if k == "write") == "".join(f"{i}," for i in range(1, 200, 2))
    assert "".join(t for k, t in b.events if k == "write") == "".join(f"{i}," for i in range(0, 200, 2))


def test_an_idle_writer_flushes_at_once() -> None:
    writer = PaneLogWriter()
    f = _SlowFile()
    writer.write(f, "x")
    assert writer.drain()
    assert f.events == [("write", "x"), ("flush", "")]


def test_a_steady_stream_is_flushed_at_least_every_bound() -> None:
    """Writes keep coming (a slow disk keeps the queue full): the file is still
    flushed every FLUSH_WITHIN_S, not only once the queue drains."""
    writer = PaneLogWriter()
    delay = 0.05
    f = _SlowFile(delay)
    for i in range(30):
        writer.write(f, str(i))
    assert writer.drain(10.0)
    kinds = [k for k, _ in f.events]
    runs, run = [], 0
    for k in kinds:
        if k == "write":
            run += 1
        else:
            runs.append(run)
            run = 0
    # At most bound/delay writes (plus the one under way) between two flushes.
    assert max(runs) <= int(FLUSH_WITHIN_S / delay) + 1
    assert kinds[-1] == "flush"


def test_close_comes_after_everything_queued_for_the_file() -> None:
    writer = PaneLogWriter()
    f = _SlowFile(0.01)
    for i in range(5):
        writer.write(f, str(i))
    writer.close(f)
    assert writer.drain()
    assert f.closed
    assert [t for k, t in f.events if k == "write"] == ["0", "1", "2", "3", "4"]
    assert f.events[-1] == ("close", "")


def test_writing_does_not_wait_for_the_disk() -> None:
    """The caller (the event loop) only queues."""
    writer = PaneLogWriter()
    f = _SlowFile(0.2)
    started = time.monotonic()
    for i in range(5):
        writer.write(f, str(i))
    assert time.monotonic() - started < 0.1
    assert writer.drain(10.0)


def test_a_real_log_file_reads_back_within_the_bound(tmp_path: Path) -> None:
    path = tmp_path / "pane.log"
    fp = open(path, "a", encoding="utf-8", buffering=1)  # noqa: SIM115 — as terminals opens it
    try:
        pane_log_writer.WRITER.write(fp, "no newline here")
        deadline = time.monotonic() + FLUSH_WITHIN_S + 2.0
        while "no newline here" not in path.read_text(encoding="utf-8") and time.monotonic() < deadline:
            time.sleep(0.01)
        assert "no newline here" in path.read_text(encoding="utf-8")
    finally:
        pane_log_writer.WRITER.close(fp)
        assert pane_log_writer.WRITER.drain()


def test_a_failing_file_does_not_stop_the_others() -> None:
    class Broken(_SlowFile):
        def write(self, text: str) -> int:
            raise OSError("disk gone")

    writer = PaneLogWriter()
    good = _SlowFile()
    writer.write(Broken(), "x")
    writer.write(good, "y")
    assert writer.drain()
    assert ("write", "y") in good.events
