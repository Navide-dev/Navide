"""Write log records from a thread per handler, not from the event loop.

Every record the backend logs used to be filtered, formatted and written by
the thread that logged it — on the event loop, almost always. That is the
token redaction a second time (the handlers' copy of log_redaction's filter),
the rotating log file, and stderr, which is a pipe the app reads: when the app
falls behind reading it, a write blocks until it catches up, and the whole
loop with it. Under host load on 2026-11-15 a stalled loop's stack sat in the
redaction of a "pty reader suspended" warning.

Each existing handler is wrapped: the loop only renders the record's message
(so a mutable argument cannot change underneath, and the record factory has
already redacted it) and queues it; a thread of that handler's own runs its
filters, formats and writes. One thread per handler, so a stuck stderr pipe
does not hold the log file back. A full queue drops records rather than
blocking the loop, and the next record written says how many were dropped.
The record factory's redaction (log_redaction.install) still runs on the
logging thread, before any handler sees a record.

Installed by the production entry point only, after log_redaction.install;
flushed at exit.
"""

from __future__ import annotations

import atexit
import logging
import queue
import threading

#: Records waiting per handler before new ones are dropped.
QUEUE_MAX = 20_000
_CLOSE_TIMEOUT_S = 5.0
_STOP = object()

#: The loggers whose handlers are wrapped: the ones the backend and uvicorn
#: attach handlers to (applog.setup_file_logging, basicConfig, dictConfig).
_LOGGERS = ("", "agent_team_backend", "mcp", "uvicorn", "uvicorn.error", "uvicorn.access", "uvicorn.asgi")

_installed: dict[int, "OffloadHandler"] = {}
_atexit_registered = False


def _freeze(record: logging.LogRecord) -> None:
    """Render the message now, once per record, as QueueHandler does."""
    if record.args:
        try:
            record.msg, record.args = record.getMessage(), None
        except Exception:  # noqa: BLE001 — the handler reports a bad format itself
            pass


class OffloadHandler(logging.Handler):
    """Queues records for ``target``, which a thread of its own handles."""

    def __init__(self, target: logging.Handler, maxsize: int = QUEUE_MAX) -> None:
        super().__init__(level=target.level)
        self.target = target
        self._queue: queue.Queue[object] = queue.Queue(maxsize)
        self._dropped = 0
        self._thread = threading.Thread(
            target=self._run, name=f"log-{type(target).__name__}", daemon=True
        )
        self._thread.start()

    def handle(self, record: logging.LogRecord) -> bool:  # type: ignore[override]
        if record.levelno < self.target.level:
            return False
        _freeze(record)
        try:
            self._queue.put_nowait(record)
        except queue.Full:
            self._dropped += 1
        return True

    def emit(self, record: logging.LogRecord) -> None:
        self.handle(record)

    def _run(self) -> None:
        while True:
            record = self._queue.get()
            if record is _STOP:
                return
            dropped, self._dropped = self._dropped, 0
            try:
                if dropped:
                    self.target.handle(logging.makeLogRecord({
                        "name": __name__, "levelno": logging.WARNING, "levelname": "WARNING",
                        "msg": f"{dropped} log record(s) dropped: this log fell behind",
                    }))
                self.target.handle(record)  # type: ignore[arg-type]
            except Exception:  # noqa: BLE001 — a failing handler must not end its thread
                pass

    def flush(self) -> None:
        self.target.flush()

    def close(self) -> None:
        """Write what is queued, then close the target."""
        if self._thread.is_alive():
            try:
                self._queue.put(_STOP, timeout=_CLOSE_TIMEOUT_S)
            except queue.Full:
                pass
            self._thread.join(_CLOSE_TIMEOUT_S)
        self.target.close()
        super().close()


def install() -> None:
    """Wrap the handlers of the backend's loggers. Idempotent."""
    global _atexit_registered
    for name in _LOGGERS:
        logger = logging.getLogger(name)
        wrapped: list[logging.Handler] = []
        for handler in logger.handlers:
            if isinstance(handler, OffloadHandler):
                wrapped.append(handler)
                continue
            offload = _installed.get(id(handler))
            if offload is None:
                offload = _installed[id(handler)] = OffloadHandler(handler)
            wrapped.append(offload)
        logger.handlers = wrapped
    if _installed and not _atexit_registered:
        _atexit_registered = True
        atexit.register(_close_all)


def _close_all() -> None:
    for offload in list(_installed.values()):
        try:
            offload.close()
        except Exception:  # noqa: BLE001
            pass
