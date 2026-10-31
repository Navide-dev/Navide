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

_MAX_PATHS = 300_000
_MAX_WORKSPACES = 4
_MAX_AGE_S = 30.0
_IDLE_S = 300.0
_RG_TIMEOUT_S = 30.0


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
    deadline = time.monotonic() + _RG_TIMEOUT_S
    paths: list[str] = []
    truncated = False
    assert proc.stdout is not None
    try:
        for line in proc.stdout:
            paths.append(line.rstrip("\r\n").replace("\\", "/"))
            if len(paths) >= _MAX_PATHS or time.monotonic() > deadline:
                truncated = True
                break
    finally:
        proc.stdout.close()
        if truncated:
            proc.kill()
        returncode = proc.wait()
    # rg exits 1 for "no files", 2 for an unreadable entry it skipped.
    if not truncated and returncode not in (0, 1, 2):
        return None
    return paths, truncated


def _list_with_walk(root: Path, include_hidden: bool, include_noise: bool) -> tuple[list[str], bool]:
    paths: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
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


def _listing(root: Path, respect_gitignore: bool, include_hidden: bool, include_noise: bool) -> _Listing:
    key = (str(root), respect_gitignore, include_hidden, include_noise)
    now = time.monotonic()
    with _entries_lock:
        entry = _entries.setdefault(key, _Entry())
        entry.used_at = now
    # One build per listing: keystrokes queue here rather than each walking.
    with entry.lock:
        listing = entry.listing
        if listing is None or now - listing.built_at > _MAX_AGE_S:
            listing = _build_listing(root, respect_gitignore, include_hidden, include_noise)
            entry.listing = listing
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
    limit = max(1, min(limit, MAX_LIMIT))
    listing = _listing(root, respect_gitignore, include_hidden, include_noise_dirs)
    excludes = exclude or []
    needle = query.replace("\\", "/")
    start = int(cursor or 0)
    files: list[dict[str, Any]] = []
    next_cursor: str | None = None
    for index in range(start, len(listing.paths)):
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
    result: dict[str, Any] = {
        "ok": True,
        "files": files,
        "gitignoreApplied": listing.gitignore_applied,
        "listingTruncated": listing.truncated,
    }
    if next_cursor is not None:
        result["nextCursor"] = next_cursor
    return result
