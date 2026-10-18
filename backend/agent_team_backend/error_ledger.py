"""The error ledger: faults from every Navide process, kept on disk.

Before this, an error lived wherever it happened — a renderer ring buffer that
a reload wiped, a stderr line from a background task nobody awaited, a
traceback in backend.log among thousands of info lines. Nothing an agent (or
the self-evolution run) could read back in one place.

One JSON object per line in ``<app data>/logs/errors.jsonl``, rotated at
``MAX_BYTES`` with ``BACKUPS`` old files kept, so the ledger can never grow
past a few megabytes. Each entry: ``ts`` (ISO, UTC), ``source`` ("backend",
"renderer", "main"), ``level`` ("warn" or "error"), ``code``, ``message``, and
optionally ``pane_id`` / ``workspace``.

Recording never raises: a ledger that fails to write must not turn one fault
into two. Reading skips lines it cannot parse.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

FILE_NAME = "errors.jsonl"
MAX_BYTES = 512 * 1024
BACKUPS = 3
MAX_MESSAGE = 2000
SOURCES = ("backend", "renderer", "main")
LEVELS = ("warn", "error")


class ErrorLedger:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        self._handler: RotatingFileHandler | None = None

    def _writer(self) -> RotatingFileHandler:
        if self._handler is None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            handler = RotatingFileHandler(
                self.path, maxBytes=MAX_BYTES, backupCount=BACKUPS, encoding="utf-8"
            )
            handler.setFormatter(logging.Formatter("%(message)s"))
            self._handler = handler
        return self._handler

    def record(
        self, source: str, level: str, code: str, message: str,
        *, pane_id: str = "", workspace: str = "",
    ) -> dict[str, Any] | None:
        """Append one entry; returns it, or None when it could not be written."""
        entry: dict[str, Any] = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "source": source if source in SOURCES else "backend",
            "level": level if level in LEVELS else "error",
            "code": str(code)[:200],
            "message": str(message)[:MAX_MESSAGE],
        }
        if pane_id:
            entry["pane_id"] = str(pane_id)[:128]
        if workspace:
            entry["workspace"] = str(workspace)[:1024]
        try:
            line = json.dumps(entry, ensure_ascii=False)
            with self._lock:
                self._writer().emit(logging.makeLogRecord({"msg": line, "args": None}))
        except Exception as err:  # noqa: BLE001 — never turn one fault into two
            log.warning("error ledger write failed: %s", err)
            return None
        return entry

    def read(
        self, *, limit: int = 50, source: str = "", pane_id: str = "", since_ts: str = "",
        workspace: str = "",
    ) -> list[dict[str, Any]]:
        """Newest entries last, at most ``limit``, optionally filtered.

        ``workspace`` keeps only entries recorded for that workspace (compared
        resolved); entries with no workspace are left out by it."""
        want = _canonical(workspace) if workspace else ""
        files = [self.path.with_name(f"{self.path.name}.{n}") for n in range(BACKUPS, 0, -1)]
        files.append(self.path)
        out: list[dict[str, Any]] = []
        with self._lock:
            for path in files:
                try:
                    text = path.read_text(encoding="utf-8")
                except OSError:
                    continue
                for line in text.splitlines():
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(entry, dict):
                        continue
                    if source and entry.get("source") != source:
                        continue
                    if pane_id and entry.get("pane_id") != pane_id:
                        continue
                    if since_ts and str(entry.get("ts") or "") <= since_ts:
                        continue
                    if want and _canonical(str(entry.get("workspace") or "")) != want:
                        continue
                    out.append(entry)
        return out[-max(0, limit):] if limit else []

    def close(self) -> None:
        with self._lock:
            if self._handler is not None:
                self._handler.close()
                self._handler = None


def _canonical(path: str) -> str:
    if not path:
        return ""
    try:
        return os.path.realpath(os.path.abspath(path))
    except (OSError, ValueError):
        return path.rstrip("/")


def _pane_workspace(pane_id: str) -> str:
    """The workspace of a pane the registry still knows, else ""."""
    try:
        from . import agent_messaging

        pane = agent_messaging.get(pane_id)
    except Exception:  # noqa: BLE001 — attribution is best effort
        return ""
    return str(getattr(pane, "workspace_path", "") or "") if pane is not None else ""


_ledger: ErrorLedger | None = None


def get() -> ErrorLedger:
    global _ledger
    if _ledger is None:
        from .applog import log_dir

        _ledger = ErrorLedger(log_dir() / FILE_NAME)
    return _ledger


def record(source: str, level: str, code: str, message: str, **extra: str) -> dict[str, Any] | None:
    # An entry for a known pane belongs to that pane's workspace: that is what
    # lets ui_diagnostics show a pane only its own project's faults.
    if extra.get("pane_id") and not extra.get("workspace"):
        workspace = _pane_workspace(extra["pane_id"])
        if workspace:
            extra = {**extra, "workspace": workspace}
    try:
        return get().record(source, level, code, message, **extra)
    except Exception as err:  # noqa: BLE001 — the log dir itself may be unusable
        log.warning("error ledger unavailable: %s", err)
        return None


def install_loop_handler(loop: asyncio.AbstractEventLoop) -> None:
    """Record exceptions nobody retrieved (a task without a done-callback, a
    failed callback) before handing them on unchanged — to the handler that
    was already installed, or to asyncio's default, which still logs them."""
    previous = loop.get_exception_handler()

    def handler(loop: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
        exc = context.get("exception")
        message = str(context.get("message") or "")
        if exc is not None:
            message = f"{message}: {type(exc).__name__}: {exc}" if message else f"{type(exc).__name__}: {exc}"
        task = context.get("task") or context.get("future")
        if task is not None:
            name = task.get_name() if hasattr(task, "get_name") else type(task).__name__
            message = f"{message} [{name}]"
        record("backend", "error", "loop.unhandled", message)
        if previous is not None:
            previous(loop, context)
        else:
            loop.default_exception_handler(context)

    loop.set_exception_handler(handler)
