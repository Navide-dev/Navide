"""Servers a pane left running after it was gone (Settings → Resource limits).

An agent that starts a dev server with `nohup … &` from a short-lived shell
hands it to launchd within milliseconds — before the terminals descendant
snapshot can see it — so neither the pane's group kill nor the breakaway
sweep ever reaches it. Every pane carries MARK_ENV, a random value per
terminal session, and such a server inherits it. A process reparented away
from its parent, owned by this user, carrying a marker no live pane owns, is
a leftover.

Only ever listed on request and stopped on the user's say-so, after checking
it is still the same process. Nothing here runs in the background or kills on
its own; every read that fails just leaves that process out.
"""

from __future__ import annotations

import logging
import os
import secrets
from collections.abc import Callable, Iterable
from typing import Any

import psutil

log = logging.getLogger("agent_team_backend.detached_servers")

MARK_ENV = "NAVIDE_PANE_MARK"
_ATTRS = ["pid", "ppid", "uids", "create_time", "cmdline"]
_COMMAND_MAX = 300


def new_mark() -> str:
    return secrets.token_hex(8)


def _uid() -> int | None:
    getuid = getattr(os, "getuid", None)
    return getuid() if getuid is not None else None


def _orphaned(ppid: int) -> bool:
    """Reparented away from whoever started it: launchd/init on POSIX, or a
    parent that no longer exists (Windows orphans keep their stale ppid; on
    POSIX a live process never points at a dead parent, so this costs nothing)."""
    return ppid in (0, 1) or not psutil.pid_exists(ppid)


def find(
    live_marks: set[str],
    *,
    procs: Callable[[], Iterable[Any]] | None = None,
    uid: int | None = None,
) -> list[dict[str, Any]]:
    """Every leftover, oldest first. Unreadable processes are skipped."""
    uid = _uid() if uid is None else uid
    listing = procs() if procs is not None else psutil.process_iter(_ATTRS)
    items: list[dict[str, Any]] = []
    for proc in listing:
        try:
            info = proc.info
            if not _orphaned(int(info.get("ppid") or 0)):
                continue
            uids = info.get("uids")
            if uid is not None and (uids is None or uids.real != uid):
                continue
            mark = proc.environ().get(MARK_ENV)
            if not mark or mark in live_marks:
                continue
            try:
                cwd = proc.cwd()
            except (psutil.Error, OSError):
                cwd = ""
            try:
                rss = int(proc.memory_info().rss)
            except (psutil.Error, OSError):
                rss = 0
            items.append({
                "pid": int(info["pid"]),
                "started_at": float(info.get("create_time") or 0.0),
                "command": " ".join(info.get("cmdline") or [])[:_COMMAND_MAX],
                "cwd": cwd,
                "rss": rss,
            })
        except (psutil.Error, OSError, KeyError, TypeError, ValueError):
            continue  # gone, denied or malformed — not listed
    items.sort(key=lambda item: item["started_at"])
    return items


def stop(
    pid: int,
    started_at: float,
    *,
    live: set[str],
    get: Callable[[int], Any] = psutil.Process,
) -> dict[str, Any]:
    """Terminate one listed leftover, only if it is still that process: same
    start time, still orphaned, still carrying a marker no live pane owns."""
    try:
        proc = get(int(pid))
        if abs(float(proc.create_time()) - float(started_at)) > 0.01:
            return {"ok": False, "error": "that process has exited; the pid now names another one"}
        if not _orphaned(int(proc.ppid())):
            return {"ok": False, "error": "that process has a parent again; it is not a leftover"}
        mark = proc.environ().get(MARK_ENV)
        if not mark or mark in live:
            return {"ok": False, "error": "that process belongs to an open pane"}
        proc.terminate()
    except psutil.NoSuchProcess:
        return {"ok": False, "error": "that process has already exited"}
    except (psutil.Error, OSError, TypeError, ValueError) as err:
        return {"ok": False, "error": str(err) or type(err).__name__}
    log.info("stopped leftover pid %s at the user's request", pid)
    return {"ok": True}
