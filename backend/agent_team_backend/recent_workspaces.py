"""Recent-workspaces registry.

Tracks the workspaces a user has opened so the Welcome screen can offer a
"recent" list (à la VS Code's Open Recent). Persisted as a single JSON file
under the macOS app-data dir.

History is kept, not rotated: an entry leaves only when the user removes it.
``limit`` is a storage safety bound (default 1000, ``None`` turns it off). When
it bites, the oldest entries that are neither pinned nor open in a window go
first, and the count is recorded so the UI can say something was trimmed.

Documents written before ``limit`` existed carry ``max_size: 20``. That was a
default nobody could change, so it is ignored rather than honoured — honouring
it would keep silently dropping the entries this exists to protect. It is still
written, as a mirror of ``limit``, because those older builds read it.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from collections.abc import Iterable
from typing import Any

from .applog import app_data_dir
from .db import DB_FILENAME, Database

log = logging.getLogger("agent_team_backend.recent_workspaces")

RECENT_FILE = "recent-workspaces.json"
_KV_KEY = "recent_workspaces"
DEFAULT_MAX_SIZE = 20  # legacy default; the stored max_size is never read back
DEFAULT_LIMIT = 1000


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _empty_doc() -> dict[str, Any]:
    return {"version": 1, "recent": [], "max_size": DEFAULT_MAX_SIZE}


class RecentWorkspacesStore:
    def __init__(self, path: Path | None = None, db: Database | None = None) -> None:
        self._path = path or (app_data_dir() / RECENT_FILE)
        self._db = db or Database(self._path.parent / DB_FILENAME)
        self._lock = threading.Lock()

    @property
    def path(self) -> Path:
        return self._db.path

    def _import_legacy(self, cur: Any, data: Any) -> None:
        if isinstance(data, dict) and isinstance(data.get("recent"), list):
            self._db.kv_set(_KV_KEY, data, now=int(time.time()))
        else:
            log.warning("legacy recent-workspaces.json malformed; starting empty")

    def _read(self) -> dict[str, Any]:
        data = self._db.kv_get(_KV_KEY)
        if data is None:
            self._db.import_json(_KV_KEY, self._path, self._import_legacy)
            data = self._db.kv_get(_KV_KEY)
        if data is None:
            return _empty_doc()
        if not isinstance(data, dict) or not isinstance(data.get("recent"), list):
            log.warning("stored recent-workspaces document malformed; resetting")
            return _empty_doc()
        data.setdefault("version", 1)
        data.setdefault("max_size", DEFAULT_MAX_SIZE)
        return data

    def _write(self, doc: dict[str, Any]) -> None:
        # Older builds cap at the stored max_size and know no "off"; mirror the
        # limit there so a downgrade does not cut the list back to 20.
        doc["max_size"] = self._limit(doc) or DEFAULT_LIMIT
        self._db.kv_set(_KV_KEY, doc, now=int(time.time()))

    @staticmethod
    def _normalize(path: str) -> str:
        return os.path.abspath(os.path.expanduser(path))

    @staticmethod
    def _default_name(norm: str) -> str:
        """Folder name shown when the workspace has no user-set alias."""
        return os.path.basename(norm.rstrip("/")) or norm

    @staticmethod
    def _limit(doc: dict[str, Any]) -> int | None:
        return doc["limit"] if "limit" in doc else DEFAULT_LIMIT

    def _cap(
        self, recent: list[dict[str, Any]], limit: int | None, keep: Iterable[str] = ()
    ) -> tuple[list[dict[str, Any]], int]:
        """Drop the oldest unprotected entries until len <= limit.

        ``recent`` is most-recent-first. Pinned entries and entries in ``keep``
        (workspaces open in a window) are never dropped, but still occupy a
        slot, so the list may stay above ``limit``. Returns the kept list and
        how many were dropped.
        """
        if limit is None or len(recent) <= limit:
            return recent, 0
        open_paths = {self._normalize(p) for p in keep}
        protected = [e for e in recent if e.get("pinned") or e["path"] in open_paths]
        others = [e for e in recent if not (e.get("pinned") or e["path"] in open_paths)]
        others = others[: max(0, limit - len(protected))]
        # Re-merge preserving original most-recent-first order.
        kept = {id(e) for e in protected} | {id(e) for e in others}
        result = [e for e in recent if id(e) in kept]
        return result, len(recent) - len(result)

    def _apply_cap(self, doc: dict[str, Any], keep: Iterable[str]) -> None:
        doc["recent"], dropped = self._cap(doc["recent"], self._limit(doc), keep)
        if dropped:
            doc["trimmed"] = int(doc.get("trimmed", 0)) + dropped
            log.info("recent workspaces: trimmed %d entries over the limit", dropped)

    # ---- public API ----

    def list(self) -> list[dict[str, Any]]:
        """Return entries most-recent-first, each annotated with ``exists``.

        ``exists`` reflects whether the folder is still on disk so the UI can
        grey out stale entries without dropping them.
        """
        recent = self._read()["recent"]
        return [{**e, "exists": os.path.isdir(e["path"])} for e in recent]

    def info(self) -> dict[str, Any]:
        """The safety bound and how many entries it has ever trimmed."""
        doc = self._read()
        return {"limit": self._limit(doc), "trimmed": int(doc.get("trimmed", 0))}

    def set_limit(self, limit: int | None, *, keep: Iterable[str] = ()) -> None:
        """Set the safety bound (``None`` = off) and apply it now."""
        if limit is not None and (
            isinstance(limit, bool) or not isinstance(limit, int) or limit < 1
        ):
            raise ValueError(f"limit must be a positive integer or None, got {limit!r}")
        with self._lock:
            doc = self._read()
            doc["limit"] = limit
            self._apply_cap(doc, keep)
            self._write(doc)

    def touch(
        self, path: str, *, state: str = "", task: str = "", keep: Iterable[str] = ()
    ) -> dict[str, Any]:
        """Record that ``path`` was just opened; move it to the front.

        ``keep`` names workspaces open in a window, which the limit never drops.
        """
        norm = self._normalize(path)
        with self._lock:
            doc = self._read()
            recent: list[dict[str, Any]] = doc["recent"]
            now = _now_iso()

            idx = next((i for i, e in enumerate(recent) if e["path"] == norm), -1)
            if idx >= 0:
                entry = recent.pop(idx)
                entry["last_opened_at"] = now
                if state:
                    entry["last_known_state"] = state
                if task:
                    entry["last_known_task"] = task
            else:
                entry = {
                    "path": norm,
                    "name": self._default_name(norm),
                    "last_opened_at": now,
                    "pinned": False,
                    "last_known_state": state,
                    "last_known_task": task,
                }
            recent.insert(0, entry)
            self._apply_cap(doc, [norm, *keep])
            self._write(doc)
            return entry

    def set_name(self, path: str, name: str) -> None:
        """Mirror a workspace's display name onto its recent-list entry.

        The truth for the alias is the workspace's own project document; this
        store only caches it so the Welcome / sidebar recent lists can be drawn
        without opening every project's db. An empty ``name`` clears the alias
        and restores the folder basename.

        No-op when the path has no entry: creating one here would make a
        workspace the user never opened appear in their recent list.
        """
        norm = self._normalize(path)
        resolved = name.strip() or self._default_name(norm)
        with self._lock:
            doc = self._read()
            for e in doc["recent"]:
                if e["path"] == norm:
                    if e.get("name") != resolved:
                        e["name"] = resolved
                        self._write(doc)
                    return

    def pin(self, path: str) -> None:
        self._set_pinned(path, True)

    def unpin(self, path: str) -> None:
        self._set_pinned(path, False)

    def _set_pinned(self, path: str, pinned: bool) -> None:
        norm = self._normalize(path)
        with self._lock:
            doc = self._read()
            for e in doc["recent"]:
                if e["path"] == norm:
                    e["pinned"] = pinned
                    self._write(doc)
                    return
            raise KeyError(f"workspace not in recent list: {norm}")

    def remove(self, path: str) -> None:
        norm = self._normalize(path)
        with self._lock:
            doc = self._read()
            new_recent = [e for e in doc["recent"] if e["path"] != norm]
            if len(new_recent) == len(doc["recent"]):
                raise KeyError(f"workspace not in recent list: {norm}")
            doc["recent"] = new_recent
            self._write(doc)
