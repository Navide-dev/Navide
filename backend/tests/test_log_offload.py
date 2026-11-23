"""Log handlers write from threads of their own (log_offload).

2026-11-15: under host load the backend's event loop stalled with its stack in
the token redaction of a log record; every record was redacted twice,
formatted and written — to the log file and to the stderr pipe the app reads —
on the loop itself.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

import pytest

from agent_team_backend import log_offload, log_redaction


class _Slow(logging.Handler):
    """A handler whose writes block, like a pipe nobody is reading."""

    def __init__(self, delay: float = 0.0) -> None:
        super().__init__()
        self.delay = delay
        self.gate = threading.Event()
        self.lines: list[str] = []
        self.threads: list[int] = []

    def emit(self, record: logging.LogRecord) -> None:
        if self.delay:
            self.gate.wait(self.delay)
        self.threads.append(threading.get_ident())
        self.lines.append(self.format(record))


def _logger(name: str, handler: logging.Handler) -> logging.Logger:
    logger = logging.getLogger(name)
    logger.handlers = [handler]
    logger.propagate = False
    logger.setLevel(logging.INFO)
    return logger


def _wait(predicate: Any, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate() and time.monotonic() < deadline:
        time.sleep(0.01)


def test_a_blocked_handler_does_not_block_the_logging_thread() -> None:
    target = _Slow(delay=30.0)
    offload = log_offload.OffloadHandler(target)
    log = _logger("test.offload.blocked", offload)
    try:
        started = time.monotonic()
        for i in range(50):
            log.warning("pty reader suspended session=%s", i)
        assert time.monotonic() - started < 1.0
        target.gate.set()
        _wait(lambda: len(target.lines) == 50)
        assert target.lines[0] == "pty reader suspended session=0"
        assert set(target.threads) == {offload._thread.ident}
        assert threading.get_ident() not in target.threads
    finally:
        target.gate.set()
        offload.close()


def test_the_message_is_rendered_when_logged_not_when_written() -> None:
    target = _Slow(delay=30.0)
    offload = log_offload.OffloadHandler(target)
    log = _logger("test.offload.render", offload)
    try:
        state = {"n": 1}
        log.warning("state %s", state)
        state["n"] = 2  # changed after the call, before the write
        target.gate.set()
        _wait(lambda: target.lines)
        assert target.lines == ["state {'n': 1}"]
    finally:
        target.gate.set()
        offload.close()


def test_a_full_queue_drops_and_says_how_many(monkeypatch: pytest.MonkeyPatch) -> None:
    target = _Slow(delay=30.0)
    offload = log_offload.OffloadHandler(target, maxsize=3)
    log = _logger("test.offload.full", offload)
    try:
        log.warning("line %d", 0)
        _wait(offload._queue.empty)  # the thread holds line 0, blocked
        for i in range(1, 10):
            log.warning("line %d", i)
        target.gate.set()
        _wait(lambda: len(target.lines) == 5)  # line 0, the notice, the three queued
        log.warning("after")
        _wait(lambda: target.lines[-1:] == ["after"])
        # The notice comes with the first record written after the drops.
        assert target.lines == ["line 0", "6 log record(s) dropped: this log fell behind",
                                "line 1", "line 2", "line 3", "after"]
    finally:
        target.gate.set()
        offload.close()


def test_the_handlers_redaction_still_runs_and_levels_hold() -> None:
    token = "tok-" + "x" * 40
    log_redaction.add_secret(token)
    target = _Slow()
    target.setLevel(logging.WARNING)
    target.addFilter(log_redaction.TokenRedactionFilter())
    offload = log_offload.OffloadHandler(target)
    log = _logger("test.offload.redact", offload)
    try:
        log.info("dropped by level %s", token)
        log.warning("GET /plan-mcp?t=%s and %s", "abc123", token)
        _wait(lambda: target.lines)
        time.sleep(0.05)
        assert target.lines == ["GET /plan-mcp?t=*** and ***"]
    finally:
        log_redaction.remove_secret(token)
        offload.close()


def test_install_wraps_each_handler_once_and_close_drains() -> None:
    target = _Slow()
    a = logging.getLogger("agent_team_backend")
    m = logging.getLogger("mcp")
    saved = (a.handlers[:], m.handlers[:], logging.getLogger().handlers[:])
    a.handlers, m.handlers = [target], [target]
    logging.getLogger().handlers = []
    try:
        log_offload.install()
        log_offload.install()
        assert isinstance(a.handlers[0], log_offload.OffloadHandler)
        assert a.handlers[0] is m.handlers[0]
        assert a.handlers[0].target is target
        logging.getLogger("agent_team_backend.x").warning("last words")
        a.handlers[0].close()
        assert target.lines[-1] == "last words"
    finally:
        log_offload._installed.clear()
        a.handlers, m.handlers, logging.getLogger().handlers = saved
