"""Pane conversation logs, written off the event loop.

terminals mirrors every flushed PTY payload into the pane's log file
(output_log_fp) and used to write and flush it on the event loop. With the
disk busy that write blocks, and the loop with it: on 2026-11-26 (load 88,
85 panes) it was the second most common frame of the loop's 2–8 s stalls
(terminals._mirror_to_log), stalls that made panes' CLIs give up their
navide MCP connection.

One thread does every write, in the order the calls were made, so a pane's
log reads exactly as before (one queue, so one order for all of them). It
flushes as soon as it has nothing more queued, and at least every
FLUSH_WITHIN_S while writes keep coming: cli_read_log reads the file, and
what it sees may lag the PTY by at most that much (plus the disk itself).
A file is closed by the same thread, after everything queued for it.
"""

from __future__ import annotations

import atexit
import logging
import queue
import threading
import time
from typing import IO

log = logging.getLogger(__name__)

#: The most a log file's contents trail its writes while writes keep coming.
FLUSH_WITHIN_S = 0.25

_CLOSE = object()


class PaneLogWriter:
    def __init__(self) -> None:
        self._queue: queue.Queue[tuple[IO[str], object]] = queue.Queue()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None

    def write(self, fp: IO[str], text: str) -> None:
        if text:
            self._put(fp, text)

    def close(self, fp: IO[str]) -> None:
        """Close ``fp`` once everything written to it so far is in."""
        self._put(fp, _CLOSE)

    def drain(self, timeout: float = 5.0) -> bool:
        """Wait until every queued write is in its file and flushed. True if
        it got there within ``timeout``."""
        done = threading.Event()
        deadline = time.monotonic() + timeout
        waiter = threading.Thread(target=lambda: (self._queue.join(), done.set()), daemon=True)
        waiter.start()
        return done.wait(max(0.0, deadline - time.monotonic()))

    def _put(self, fp: IO[str], item: object) -> None:
        self._start()
        self._queue.put((fp, item))

    def _start(self) -> None:
        if self._thread is not None:
            return
        with self._lock:
            if self._thread is None:
                self._thread = threading.Thread(target=self._run, name="pane-log-writer", daemon=True)
                self._thread.start()

    def _run(self) -> None:
        dirty: dict[int, IO[str]] = {}
        last_flush = time.monotonic()
        while True:
            try:
                fp, item = self._queue.get(timeout=FLUSH_WITHIN_S if dirty else None)
            except queue.Empty:
                last_flush = self._flush(dirty)
                continue
            try:
                if item is _CLOSE:
                    dirty.pop(id(fp), None)
                    try:
                        fp.close()
                    except Exception:  # noqa: BLE001 — closing is best effort, as before
                        pass
                else:
                    try:
                        fp.write(item)  # type: ignore[arg-type]
                        dirty[id(fp)] = fp
                    except Exception as err:  # noqa: BLE001
                        log.warning("output log write failed: %s", err)
                if dirty and (self._queue.empty() or time.monotonic() - last_flush >= FLUSH_WITHIN_S):
                    last_flush = self._flush(dirty)
            finally:
                self._queue.task_done()

    @staticmethod
    def _flush(dirty: dict[int, IO[str]]) -> float:
        for fp in dirty.values():
            try:
                fp.flush()
            except Exception as err:  # noqa: BLE001
                log.warning("output log flush failed: %s", err)
        dirty.clear()
        return time.monotonic()


WRITER = PaneLogWriter()


@atexit.register
def _drain_at_exit() -> None:
    WRITER.drain(2.0)
