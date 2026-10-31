"""Workspace file query behind the public ``fs.queryFiles`` capability.

The Host side of file search: list a workspace, filter it the way the caller
asked, and return candidates with their match positions. Ranking belongs to
the caller, so results come back in path order.

Paths are held per workspace and listing settings, so a query per keystroke
does not walk the tree each time. A disk change drops the listing (see
``invalidate``); ``_MAX_AGE_S`` covers a workspace with no watcher.
"""

from __future__ import annotations

import fnmatch
import os
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .fs_service import _NOISE_SEGMENTS
from .search_service import _rg_bin

MATCH_ON = ("name", "path")
MODES = ("substring", "subsequence", "glob")
DEFAULT_LIMIT = 100
MAX_LIMIT = 1_000

# Request limits. The catalog validator holds the same numbers; these keep a
# caller that reaches the handler another way just as bounded.
MAX_QUERY_CHARS = 1_024
MAX_EXCLUDES = 64
MAX_EXCLUDE_CHARS = 256

_MAX_PATHS = 300_000
_MAX_WORKSPACES = 4
_MAX_AGE_S = 30.0
_IDLE_S = 300.0
# Both sit under the Host's 10 s capability timeout, past which nobody is
# waiting for the answer and the work would only stack up.
_LIST_DEADLINE_S = 6.0
_QUERY_DEADLINE_S = 3.0
_DEADLINE_CHECK_EVERY = 1_024
# Queries running in this process, whoever asked. The Host holds one per plugin
# but lets go when its own wait times out; this counts the work itself, on
# worker threads it shares with Git and file reads.
_MAX_RUNNING_QUERIES = 4
_running_queries = threading.BoundedSemaphore(_MAX_RUNNING_QUERIES)


@dataclass
class _Listing:
    paths: list[str]
    gitignore_applied: bool
    truncated: bool
    built_at: float


@dataclass
class _Entry:
    lock: threading.Lock = field(default_factory=threading.Lock)
    listing: _Listing | None = None
    used_at: float = 0.0


_entries: dict[tuple[str, bool, bool, bool], _Entry] = {}
_entries_lock = threading.Lock()


def _list_with_rg(rg: str, root: Path, include_hidden: bool, include_noise: bool) -> tuple[list[str], bool] | None:
    args = [rg, "--files", "--no-messages", "--no-config"]
    if include_hidden:
        args.append("--hidden")
    args += ["-g", "!.git/"]
    if not include_noise:
        for segment in sorted(_NOISE_SEGMENTS):
            args += ["-g", f"!{segment}/"]
    try:
        proc = subprocess.Popen(
            args, cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, encoding="utf-8", errors="surrogateescape",
        )
    except OSError:
        return None
    # A timer, not a check per line: a stuck rg prints no next line to check on.
    expired = threading.Event()

    def stop() -> None:
        expired.set()
        proc.kill()

    timer = threading.Timer(_LIST_DEADLINE_S, stop)
    timer.daemon = True
    timer.start()
    paths: list[str] = []
    truncated = False
    assert proc.stdout is not None
    try:
        for line in proc.stdout:
            paths.append(line.rstrip("\r\n").replace("\\", "/"))
            if len(paths) >= _MAX_PATHS:
                truncated = True
                break
    finally:
        timer.cancel()
        proc.stdout.close()
        if truncated:
            proc.kill()
        returncode = proc.wait()
    if expired.is_set():
        return paths, True
    # rg exits 1 for "no files", 2 for an unreadable entry it skipped.
    if not truncated and returncode not in (0, 1, 2):
        return None
    return paths, truncated


def _list_with_walk(root: Path, include_hidden: bool, include_noise: bool) -> tuple[list[str], bool]:
    deadline = time.monotonic() + _LIST_DEADLINE_S
    paths: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        if time.monotonic() > deadline:
            return paths, True
        dirnames[:] = [
            d for d in dirnames
            if d != ".git"
            and (include_hidden or not d.startswith("."))
            and (include_noise or d not in _NOISE_SEGMENTS)
        ]
        rel_dir = Path(dirpath).relative_to(root).as_posix()
        prefix = "" if rel_dir == "." else f"{rel_dir}/"
        for name in filenames:
            # Links stay out, as with rg: their target may be outside the workspace.
            if (include_hidden or not name.startswith(".")) and not os.path.islink(os.path.join(dirpath, name)):
                paths.append(prefix + name)
                if len(paths) >= _MAX_PATHS:
                    return paths, True
    return paths, False


def _build_listing(root: Path, respect_gitignore: bool, include_hidden: bool, include_noise: bool) -> _Listing:
    rg = _rg_bin() if respect_gitignore else None
    listed = _list_with_rg(rg, root, include_hidden, include_noise) if rg else None
    gitignore_applied = listed is not None
    paths, truncated = listed if listed is not None else _list_with_walk(root, include_hidden, include_noise)
    paths.sort()
    return _Listing(paths, gitignore_applied, truncated, time.monotonic())


def _evict(now: float) -> None:
    """Release idle listings, then the oldest beyond the workspace cap."""
    with _entries_lock:
        for key, entry in list(_entries.items()):
            if entry.listing is not None and now - entry.used_at > _IDLE_S:
                del _entries[key]
        excess = len(_entries) - _MAX_WORKSPACES
        if excess > 0:
            for key, _ in sorted(_entries.items(), key=lambda item: item[1].used_at)[:excess]:
                del _entries[key]


def _listing(root: Path, respect_gitignore: bool, include_hidden: bool, include_noise: bool) -> _Listing | None:
    """The listing, built if needed; None when another build held it past the deadline."""
    key = (str(root), respect_gitignore, include_hidden, include_noise)
    now = time.monotonic()
    with _entries_lock:
        entry = _entries.setdefault(key, _Entry())
        entry.used_at = now
    # One build per listing: keystrokes queue here rather than each walking.
    if not entry.lock.acquire(timeout=_LIST_DEADLINE_S):
        return None
    try:
        listing = entry.listing
        if listing is None or now - listing.built_at > _MAX_AGE_S:
            listing = _build_listing(root, respect_gitignore, include_hidden, include_noise)
            entry.listing = listing
    finally:
        entry.lock.release()
    _evict(now)
    return listing


def invalidate(workspace_path: str) -> None:
    """Drop every listing of a workspace; the next query lists it again."""
    root = str(Path(workspace_path).resolve())
    with _entries_lock:
        for key in [key for key in _entries if key[0] == root]:
            del _entries[key]


def _spans(subject: str, query: str, mode: str) -> list[list[int]] | None:
    """Half-open `[start, end]` match positions in *subject*, or None for no match."""
    if mode == "glob":
        return [] if fnmatch.fnmatchcase(subject.lower(), query.lower()) else None
    lowered = subject.lower()
    needle = query.lower()
    if not needle:
        return []
    if mode == "substring":
        start = lowered.find(needle)
        return None if start < 0 else [[start, start + len(needle)]]
    spans: list[list[int]] = []
    position = 0
    for char in needle:
        found = lowered.find(char, position)
        if found < 0:
            return None
        if spans and spans[-1][1] == found:
            spans[-1][1] = found + 1
        else:
            spans.append([found, found + 1])
        position = found + 1
    return spans


def _row(root: Path, rel: str, spans: list[list[int]]) -> dict[str, Any] | None:
    try:
        info = (root / rel).lstat()
    except OSError:
        return None
    return {
        "path": rel,
        "name": rel.rsplit("/", 1)[-1],
        "matchSpans": spans,
        "size": info.st_size,
        "mtime": info.st_mtime,
    }


def query_files(
    workspace_path: str,
    query: str = "",
    *,
    match_on: str = "name",
    mode: str = "substring",
    exclude: list[str] | None = None,
    respect_gitignore: bool = True,
    include_hidden: bool = False,
    include_noise_dirs: bool = False,
    limit: int = DEFAULT_LIMIT,
    cursor: str = "",
) -> dict[str, Any]:
    """Return workspace files matching *query*, in path order, one page at a time."""
    root = Path(workspace_path).resolve()
    if not root.is_dir():
        return {"ok": False, "error": "workspace not found"}
    if match_on not in MATCH_ON or mode not in MODES:
        return {"ok": False, "error": "invalid matchOn or mode"}
    if cursor and not cursor.isdecimal():
        return {"ok": False, "error": "invalid cursor"}
    excludes = exclude or []
    if (
        len(query) > MAX_QUERY_CHARS
        or len(excludes) > MAX_EXCLUDES
        or any(len(pattern) > MAX_EXCLUDE_CHARS for pattern in excludes)
    ):
        return {"ok": False, "error": "query or exclude is too long"}
    if not _running_queries.acquire(blocking=False):
        return {"ok": False, "error": "busy"}
    try:
        return _run_query(
            root, query, match_on, mode, excludes, respect_gitignore, include_hidden,
            include_noise_dirs, max(1, min(limit, MAX_LIMIT)), int(cursor or 0),
        )
    finally:
        _running_queries.release()


def _run_query(
    root: Path,
    query: str,
    match_on: str,
    mode: str,
    excludes: list[str],
    respect_gitignore: bool,
    include_hidden: bool,
    include_noise_dirs: bool,
    limit: int,
    start: int,
) -> dict[str, Any]:
    listing = _listing(root, respect_gitignore, include_hidden, include_noise_dirs)
    if listing is None:
        return {"ok": False, "error": "busy"}
    deadline = time.monotonic() + _QUERY_DEADLINE_S
    needle = query.replace("\\", "/")
    files: list[dict[str, Any]] = []
    next_cursor: str | None = None
    timed_out = False
    for index in range(start, len(listing.paths)):
        if index % _DEADLINE_CHECK_EVERY == 0 and time.monotonic() > deadline:
            next_cursor = str(index)
            timed_out = True
            break
        rel = listing.paths[index]
        if any(fnmatch.fnmatchcase(rel, pattern) for pattern in excludes):
            continue
        spans = _spans(rel if match_on == "path" else rel.rsplit("/", 1)[-1], needle, mode)
        if spans is None:
            continue
        if len(files) == limit:
            next_cursor = str(index)
            break
        row = _row(root, rel, spans)
        if row is not None:
            files.append(row)
        # A slow disk spends its time here, between the periodic checks.
        if time.monotonic() > deadline:
            next_cursor = str(index + 1)
            timed_out = True
            break
    result: dict[str, Any] = {
        "ok": True,
        "files": files,
        "gitignoreApplied": listing.gitignore_applied,
        "listingTruncated": listing.truncated,
    }
    if next_cursor is not None:
        result["nextCursor"] = next_cursor
    if timed_out:
        result["timedOut"] = True
    return result
