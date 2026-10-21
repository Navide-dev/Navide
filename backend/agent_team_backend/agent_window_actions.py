"""What agents did to Navide's windows: an append-only action record.

Disclose, don't restrict (DESIGN-C §5): the window tools (window_focus now,
window_move_pane / window_close / workspace_close and cross-workspace spawns
later) carry no count or rate limit of their own. What they get instead is a
record of every call — who asked (the calling pane, from its credential), the
tool, the target, the outcome and how to undo it — so the user can always see
which pane moved what.

Kept in memory for this backend's lifetime and appended to
``<app data>/logs/agent-window-actions.jsonl``. The file rotates like the
error ledger does (that bounds disk use, not how many actions agents may
take). Recording never raises: a record that fails to write must not fail the
action it describes.
"""

from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

FILE_NAME = "agent-window-actions.jsonl"
MAX_BYTES = 512 * 1024
BACKUPS = 3

_lock = threading.Lock()
_entries: list[dict[str, Any]] = []
_handler: RotatingFileHandler | None = None
#: None until first use, then the file path; tests point it at tmp_path.
_file: Path | None = None
_file_resolved = False


def _path() -> Path | None:
    global _file, _file_resolved
    if not _file_resolved:
        try:
            from .applog import app_data_dir

            _file = app_data_dir() / "logs" / FILE_NAME
        except Exception as err:  # noqa: BLE001 - memory-only is still a record
            log.warning("agent window actions: no app data dir: %s", err)
            _file = None
        _file_resolved = True
    return _file


def _writer() -> RotatingFileHandler | None:
    global _handler
    path = _path()
    if path is None:
        return None
    if _handler is None:
        path.parent.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(path, maxBytes=MAX_BYTES, backupCount=BACKUPS, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(message)s"))
        _handler = handler
    return _handler


def record(
    tool: str,
    caller: dict[str, Any],
    target: dict[str, Any],
    *,
    ok: bool,
    error: str = "",
    undo: Any = None,
) -> dict[str, Any]:
    """Append one action and return it.

    ``caller`` is {pane_id, address} for a pane, {kind} for a host or external
    client; ``target`` names what was acted on (window / workspace / pane).
    """
    entry: dict[str, Any] = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "tool": tool,
        "caller": caller,
        "target": target,
        "ok": ok,
    }
    if error:
        entry["error"] = error
    if undo is not None:
        entry["undo"] = undo
    with _lock:
        _entries.append(entry)
        try:
            writer = _writer()
            if writer is not None:
                line = json.dumps(entry, ensure_ascii=False)
                writer.emit(logging.makeLogRecord({"msg": line, "args": None}))
        except Exception as err:  # noqa: BLE001 - never fail the action over its record
            log.warning("agent window actions: write failed: %s", err)
    return entry


def entries() -> list[dict[str, Any]]:
    """Every action recorded in this backend's lifetime, oldest first."""
    with _lock:
        return list(_entries)


def _reset_for_test(path: Path | None) -> None:
    global _handler, _file, _file_resolved
    with _lock:
        _entries.clear()
        if _handler is not None:
            _handler.close()
        _handler = None
        _file = path
        _file_resolved = path is not None
