"""Git operations for the Agent-Team backend.

All I/O is performed via asyncio subprocesses so the FastAPI event loop is
never blocked.  No gitpython or other heavy dependency is required.
"""

from __future__ import annotations

import asyncio
import copy
import functools
import glob
import json
import logging
import os
import queue
import re
import secrets
import shutil
import sys
import threading
import time
import unicodedata
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable
from urllib.parse import urlparse

import httpx

from agent_team_backend.applog import app_data_dir
from agent_team_backend.osplat import paths
from agent_team_backend import commit_message_prompt
from agent_team_backend.git_security import is_remote_helper_form
from agent_team_backend.git_askpass_helper import ASKPASS_FLAG
from agent_team_backend.http_ssl import default_ssl_context
from agent_team_backend.host_shell import (
    run_allowlisted,
    run_allowlisted_capped,
    run_allowlisted_text,
)
from agent_team_backend.pending_registry import TIMEOUT, PendingRegistry

log = logging.getLogger("agent_team_backend.git_service")

_MAX_DIFF_CHARS = 8_000  # truncate staged diff before sending to Ollama
_COMMIT_SUMMARY_FILE_THRESHOLD = 30
_COMMIT_SUMMARY_LINE_THRESHOLD = 1_200
_COMMIT_SUMMARY_UNTRACKED_BYTES_THRESHOLD = 32_000
_DISCOVERY_SCAN_BUDGET_S = 5.0

# Only allow https/http and SSH-style URLs; block git pseudo-protocols (ext::, fd::, file://, etc.)
_SAFE_GIT_URL = re.compile(r"^(https?://|ssh://|git@[\w.\-]+:)")

# ─── Data classes ─────────────────────────────────────────────────────────────

@dataclass
class GitFileEntry:
    path: str
    status: str  # 'M', 'A', 'D', 'R', '?', etc.


@dataclass
class GitStatus:
    is_git_repo: bool
    branch: str = ""
    remote_branch: str = ""
    ahead: int = 0
    behind: int = 0
    staged: list[GitFileEntry] = field(default_factory=list)
    unstaged: list[GitFileEntry] = field(default_factory=list)
    untracked: list[GitFileEntry] = field(default_factory=list)
    ignored: list[GitFileEntry] = field(default_factory=list)
    operation_in_progress: str = ""  # "", "merge", "rebase", "cherry-pick"
    truncated: bool = False  # entries stop at _STATUS_ENTRY_LIMIT / _STATUS_MAX_BYTES


@dataclass
class GitCommit:
    hash: str
    short_hash: str
    message: str
    branches: list[str] = field(default_factory=list)
    parents: list[str] = field(default_factory=list)
    author: str = ""
    date: str = ""


@dataclass
class GitSyncResult:
    ok: bool
    pull_output: str = ""
    push_output: str = ""
    error: str = ""


# ─── Input validation helpers ─────────────────────────────────────────────────

_HASH_RE = re.compile(r"^[0-9a-fA-F]{4,40}$")
# Blocklist of characters/sequences git itself forbids in ref names (see
# git-check-ref-format). Non-ASCII (e.g. CJK) refs are legal in git, so we
# reject only what git rejects rather than allowlisting ASCII — an ASCII
# allowlist wrongly blocked branches like "AI修改". Not the security boundary:
# subprocess calls are exec-not-shell, and leading-'-'/'..' are checked
# separately below.
_INVALID_REF_RE = re.compile(
    r"(^-|\.\.|\x00|@\{|\\|[ ~^:?*\[\]]|/$|\.lock$|\.lock/)"
)


def _validate_commit_hash(value: str) -> str | None:
    """Return None if valid, else an error string."""
    if not value or not _HASH_RE.match(value.strip()):
        return "invalid commit hash (expected 4–40 hex chars)"
    return None


# ── Per-repository write serialization ────────────────────────────────────────
# Concurrent mutating git commands on one working tree collide on .git/index.lock
# and surface a raw "another git process is running" error. Serialize writes per
# repo (keyed by realpath); reads stay unlocked so a status refresh never blocks
# behind a slow push. Deadlock-safe: no mutating op calls another mutating op.
_repo_write_locks: dict[str, asyncio.Lock] = {}


def _repo_write_lock(workspace_path: str) -> asyncio.Lock:
    try:
        key = os.path.realpath(workspace_path) if workspace_path else ""
    except OSError:
        key = workspace_path or ""
    lock = _repo_write_locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _repo_write_locks[key] = lock
    return lock


def _serialize_write(fn):
    """Decorator: serialize a mutating git op per workspace (its first argument)."""
    @functools.wraps(fn)
    async def wrapper(workspace_path, *args, **kwargs):
        async with _repo_write_lock(workspace_path):
            return await fn(workspace_path, *args, **kwargs)
    return wrapper


_GIT_ESCAPE_RE = re.compile(r'\\([\\abtnvfr"]|[0-7]{3})')

def _unquote_git_path(raw: str) -> str:
    """Strip surrounding double-quotes and unescape C-style escapes that git
    adds to paths with spaces or non-ASCII chars in porcelain output."""
    if len(raw) >= 2 and raw[0] == '"' and raw[-1] == '"':
        inner = raw[1:-1]
        def _repl(m: re.Match) -> str:
            s = m.group(1)
            if s == '\\': return '\\'
            if s == 'a':  return '\a'
            if s == 'b':  return '\b'
            if s == 't':  return '\t'
            if s == 'n':  return '\n'
            if s == 'v':  return '\v'
            if s == 'f':  return '\f'
            if s == 'r':  return '\r'
            if s == '"':  return '"'
            return chr(int(s, 8))
        return _GIT_ESCAPE_RE.sub(_repl, inner)
    return raw


def _validate_ref_name(value: str, label: str = "name") -> str | None:
    """Return None if valid, else an error string.

    Rejects values starting with '-' (argv flag smuggling) and chars that
    git itself disallows in ref names.
    """
    v = value.strip()
    if not v:
        return f"{label} is required"
    if v.startswith("-"):
        return f"invalid {label}: must not start with '-'"
    if ".." in v:
        return f"invalid {label}: must not contain '..'"
    if _INVALID_REF_RE.search(v):
        return f"invalid {label}: contains characters git disallows in ref names"
    return None


# ─── subprocess helper ────────────────────────────────────────────────────────

# Cap concurrent git subprocesses globally. Read paths (status/discover/list_*)
# have no per-repo lock, so one git.changed broadcast can otherwise fan out into
# an unbounded number of parallel git processes across windows and repos.
_GIT_PROC_LIMIT = 4
# Keyed per event loop: asyncio.Semaphore binds to the loop it is first awaited
# on, and tests run each case on a fresh loop.
_git_proc_semaphores: dict[asyncio.AbstractEventLoop, asyncio.Semaphore] = {}


def _git_proc_semaphore() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    sem = _git_proc_semaphores.get(loop)
    if sem is None:
        sem = asyncio.Semaphore(_GIT_PROC_LIMIT)
        _git_proc_semaphores[loop] = sem
    return sem


async def _run(
    args: list[str], cwd: str, env: dict[str, str] | None = None
) -> tuple[int, str, str]:
    """Run a git command; return (returncode, stdout, stderr)."""
    async with _git_proc_semaphore():
        rc, stdout, stderr = await run_allowlisted_text(args, cwd, timeout=15.0, env=env)
    return rc, stdout, stderr


async def _run_with_input(args: list[str], cwd: str, stdin_text: str) -> tuple[int, str, str]:
    """Run a git command feeding *stdin_text* to stdin; return (rc, stdout, stderr)."""
    async with _git_proc_semaphore():
        rc, stdout, stderr = await run_allowlisted_text(
            args, cwd, timeout=15.0, input_text=stdin_text
        )
    return rc, stdout, stderr


async def _run_capped(
    args: list[str], cwd: str, max_stdout_bytes: int
) -> tuple[int, str, str, bool]:
    """Run a git command, stopping at *max_stdout_bytes*; return (rc, out, err, truncated).

    For commands whose output the caller only shows the head of. Reading the
    whole of a large ``git diff`` before truncating makes the memory peak scale
    with the full diff; this stops the read -- and the git process -- at the cap.
    Callers must check *truncated* before *rc*, which is the kill signal when
    the cap was hit.
    """
    async with _git_proc_semaphore():
        rc, stdout, stderr, truncated = await run_allowlisted_capped(
            args, cwd, timeout=15.0, max_stdout_bytes=max_stdout_bytes
        )
    return (
        rc,
        stdout.decode("utf-8", errors="replace"),
        stderr.decode("utf-8", errors="replace"),
        truncated,
    )


async def _run_bytes(args: list[str], cwd: str) -> tuple[int, bytes, str]:
    """Run a git command returning raw stdout bytes.

    ``_run`` decodes stdout with ``errors="replace"``, which silently corrupts
    binary blobs; conflict stages must be inspected as bytes to tell text from
    binary before any decoding happens.
    """
    async with _git_proc_semaphore():
        rc, stdout, stderr = await run_allowlisted(args, cwd, timeout=15.0)
    decoded = stderr.decode("utf-8", errors="replace")
    return rc, stdout, decoded


# ─── Public API ───────────────────────────────────────────────────────────────

# A repo with hundreds of thousands of untracked files (generated output) made
# `git status -uall` print tens of MB, and building one entry per line on the
# event loop stalled it for minutes (#144). Like VS Code's git.statusLimit, stop
# at a fixed count; the byte cap also stops the read and git process early.
_STATUS_ENTRY_LIMIT = 10_000
_STATUS_MAX_BYTES = 4 * 1024 * 1024


# One git.changed fans out into several status reads per window (Git pane,
# repo badges, status bar); each used to take its own slot of the 4-process
# semaphore and run the same tree walk. Concurrent reads of one
# (workspace, include_ignored) share a run instead. A read that arrives while a
# run is already going waits for one queued run that starts after it, so it
# never gets a result from before the change that prompted it -- a burst costs
# at most two runs.
_StatusKey = tuple[asyncio.AbstractEventLoop, str, bool]
_status_running: dict[_StatusKey, asyncio.Future[dict[str, Any]]] = {}
_status_queued: dict[_StatusKey, asyncio.Future[dict[str, Any]]] = {}


async def get_status(workspace_path: str, include_ignored: bool = False) -> dict[str, Any]:
    """Return serialisable GitStatus dict for the given workspace.

    When *include_ignored* is True, also surface git-ignored paths (``!!`` in
    porcelain) so the UI can optionally show them — mirrors VS Code's
    "show ignored files" toggle.

    When ``git status`` itself fails or times out, returns
    ``{"ok": False, "error": ...}`` with no ``is_git_repo``: the UI keeps the
    last good status and shows the error instead of a fake clean repo.
    """
    key = (asyncio.get_running_loop(), workspace_path, include_ignored)
    task = _status_queued.get(key)
    if task is None:
        running = _status_running.get(key)
        if running is None:
            task = asyncio.ensure_future(_read_status(workspace_path, include_ignored))
            _status_running[key] = task
        else:
            task = asyncio.ensure_future(
                _read_status_after(running, key, workspace_path, include_ignored)
            )
            _status_queued[key] = task
        task.add_done_callback(lambda done: _forget_status_run(key, done))
    return dict(await asyncio.shield(task))


def _forget_status_run(key: _StatusKey, done: asyncio.Future[dict[str, Any]]) -> None:
    for table in (_status_running, _status_queued):
        if table.get(key) is done:
            del table[key]


async def _read_status_after(
    previous: asyncio.Future[dict[str, Any]],
    key: _StatusKey,
    workspace_path: str,
    include_ignored: bool,
) -> dict[str, Any]:
    await asyncio.wait([previous])
    this = asyncio.current_task()
    assert this is not None
    _status_queued.pop(key, None)
    _status_running[key] = this
    return await _read_status(workspace_path, include_ignored)


# The Git pane re-reads log, branches, stashes, remotes, tags and worktrees on
# every git.changed, once per Git pane instance (each editor window, each repo
# of a multi-repo view). Only status was shared; the other reads share a run
# the same way through ``coalesced``.
_coalesce_running: dict[tuple[Any, ...], asyncio.Future[Any]] = {}
_coalesce_queued: dict[tuple[Any, ...], asyncio.Future[Any]] = {}


async def coalesced(key: tuple[Any, ...], read: Callable[[], Awaitable[Any]]) -> Any:
    """Run *read* once for every concurrent caller with the same *key*.

    Same rule as get_status: a caller that arrives while a run is going waits
    for one queued run that starts after it, so it never gets a result from
    before the change that prompted it. Each caller gets its own copy.
    """
    full = (asyncio.get_running_loop(), *key)
    task = _coalesce_queued.get(full)
    if task is None:
        running = _coalesce_running.get(full)
        if running is None:
            task = asyncio.ensure_future(read())
            _coalesce_running[full] = task
        else:
            task = asyncio.ensure_future(_coalesced_after(running, full, read))
            _coalesce_queued[full] = task
        task.add_done_callback(lambda done: _forget_coalesced(full, done))
    return copy.deepcopy(await asyncio.shield(task))


def _forget_coalesced(key: tuple[Any, ...], done: asyncio.Future[Any]) -> None:
    for table in (_coalesce_running, _coalesce_queued):
        if table.get(key) is done:
            del table[key]


async def _coalesced_after(
    previous: asyncio.Future[Any], key: tuple[Any, ...], read: Callable[[], Awaitable[Any]]
) -> Any:
    await asyncio.wait([previous])
    this = asyncio.current_task()
    assert this is not None
    _coalesce_queued.pop(key, None)
    _coalesce_running[key] = this
    return await read()


async def _read_status(workspace_path: str, include_ignored: bool) -> dict[str, Any]:
    if not workspace_path or not Path(workspace_path).is_dir():
        return asdict(GitStatus(is_git_repo=False))

    # Verify it's a git repo. Only git's own answer means "not a repo": a check
    # that timed out or could not start is a failure to report (#144). The C
    # locale keeps that answer in English whatever the user's language.
    # --git-dir rides along (one process instead of two): it locates the
    # in-progress operation markers read after the status below.
    rc, rev_parse_out, err = await _run(
        ["git", "rev-parse", "--is-inside-work-tree", "--git-dir"],
        workspace_path,
        env={**os.environ, "LC_ALL": "C"},
    )
    if rc != 0:
        if "not a git repository" in err:
            return asdict(GitStatus(is_git_repo=False))
        return {"ok": False, "error": err.strip() or f"git rev-parse exited with {rc}"}

    status = GitStatus(is_git_repo=True)

    # Branch + ahead/behind
    # --no-optional-locks: a read must not refresh and rewrite .git/index --
    # the watcher would report that write as a change and trigger more reads.
    args = [
        "git", "--no-optional-locks", "-c", "core.quotePath=false",
        "status", "--porcelain=v1", "--branch", "-u",
    ]
    if include_ignored:
        args.append("--ignored")
    rc, out, err, byte_capped = await _run_capped(args, workspace_path, _STATUS_MAX_BYTES)
    # A byte-cap kill also exits nonzero; that is truncation, not failure.
    if rc != 0 and not byte_capped:
        return {"ok": False, "error": err.strip() or f"git status exited with {rc}"}
    lines = out.splitlines()
    if byte_capped and len(lines) > 1:
        lines.pop()  # the read stopped mid-line
    if len(lines) - 1 > _STATUS_ENTRY_LIMIT:
        del lines[_STATUS_ENTRY_LIMIT + 1 :]
        byte_capped = True
    status.truncated = byte_capped
    if lines:
        header = lines[0]  # ## main...origin/main [ahead 2, behind 1]
        branch_match = re.match(r"^## (.+?)(?:\.\.\.(.+?))?(?:\s+\[(.+)\])?$", header)
        if branch_match:
            status.branch = branch_match.group(1) or ""
            status.remote_branch = branch_match.group(2) or ""
            tracking_info = branch_match.group(3) or ""
            if m := re.search(r"ahead (\d+)", tracking_info):
                status.ahead = int(m.group(1))
            if m := re.search(r"behind (\d+)", tracking_info):
                status.behind = int(m.group(1))
        for line in lines[1:]:
            if len(line) < 3:
                continue
            xy = line[:2]
            x, y = xy[0], xy[1]
            raw_path = line[3:]
            # Renames/copies render as "orig -> new" (each part may be independently
            # quoted when it contains spaces). Split on " -> " first, then unquote
            # each part separately so "old name" -> "new name" works correctly.
            if (x in ("R", "C") or y in ("R", "C")) and " -> " in raw_path:
                path = _unquote_git_path(raw_path.split(" -> ", 1)[1])
            else:
                path = _unquote_git_path(raw_path)
            if x == "!" and y == "!":
                status.ignored.append(GitFileEntry(path=path, status="!"))
            elif x == "?" and y == "?":
                status.untracked.append(GitFileEntry(path=path, status="?"))
            else:
                if x != " " and x != "?":
                    status.staged.append(GitFileEntry(path=path, status=x))
                if y != " " and y != "?":
                    status.unstaged.append(GitFileEntry(path=path, status=y))

    # Detect an in-progress operation so the UI can offer an Abort action.
    rev_parse_lines = rev_parse_out.splitlines()
    git_dir_out = rev_parse_lines[1] if len(rev_parse_lines) > 1 else ""
    if git_dir_out.strip():
        git_dir = Path(workspace_path) / git_dir_out.strip()
        if (git_dir / "rebase-merge").is_dir() or (git_dir / "rebase-apply").is_dir():
            status.operation_in_progress = "rebase"
        elif (git_dir / "CHERRY_PICK_HEAD").exists():
            status.operation_in_progress = "cherry-pick"
        elif (git_dir / "MERGE_HEAD").exists():
            status.operation_in_progress = "merge"

    return asdict(status)


# ─── Pane git snapshot ────────────────────────────────────────────────────────
# What an agent needs to know about the checkout a pane works in, without
# opening the Git pane: which branch, which worktree, how much is uncommitted,
# and how far it is from origin/main. Read by cli_list_targets / cli_get_status
# and by the network view, all of which can ask for dozens of panes at once, so
# every read goes through `pane_git_snapshots` (one snapshot per worktree root,
# shared by all the panes in it) rather than spawning git per pane.

#: Short on purpose: a snapshot is a decoration on a roster read, and a slow
#: repository must cost that read a missing field, not a stall.
_SNAPSHOT_GIT_TIMEOUT_S = 5.0
#: Its own small budget rather than `_git_proc_semaphore`: a roster read over
#: many worktrees must never hold the slots the Git pane's own commands wait on.
_SNAPSHOT_PROC_LIMIT = 2
#: ``dirty`` saturates here: past it the roster shows "at least this many".
_SNAPSHOT_DIRTY_LIMIT = 10_000
_SNAPSHOT_STATUS_MAX_BYTES = 1024 * 1024
_snapshot_proc_semaphores: dict[asyncio.AbstractEventLoop, asyncio.Semaphore] = {}


def _snapshot_proc_semaphore() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    sem = _snapshot_proc_semaphores.get(loop)
    if sem is None:
        sem = asyncio.Semaphore(_SNAPSHOT_PROC_LIMIT)
        _snapshot_proc_semaphores[loop] = sem
    return sem


async def _run_snapshot_git(args: list[str], cwd: str) -> tuple[int, str]:
    async with _snapshot_proc_semaphore():
        rc, stdout, _ = await run_allowlisted_text(args, cwd, timeout=_SNAPSHOT_GIT_TIMEOUT_S)
    return rc, stdout


def _empty_pane_git_snapshot() -> dict[str, Any]:
    return {
        "branch": None,
        "worktreeRoot": None,
        "isLinkedWorktree": None,
        "dirty": None,
        "ahead": None,
        "behind": None,
        "fetchedAt": None,
    }


async def pane_git_snapshot(path: str) -> dict[str, Any]:
    """Branch, worktree and drift of the checkout containing *path*.

    Returns ``{branch, worktreeRoot, isLinkedWorktree, dirty, ahead, behind,
    fetchedAt}``. ``branch`` is the short sha when HEAD is detached; ``dirty``
    counts ``git status --porcelain`` lines, saturating at
    ``_SNAPSHOT_DIRTY_LIMIT``; ``ahead`` / ``behind`` are against
    ``origin/main`` specifically, not the branch's upstream (``get_status``
    reports that one); ``fetchedAt`` is when FETCH_HEAD was last written, as
    ISO-8601 UTC — this never fetches, so the drift is only as fresh as that.

    Never raises: a non-repository path, a cloud-synced mount, a missing
    ``origin/main`` or a git that times out leaves the affected fields None.
    """
    snapshot = _empty_pane_git_snapshot()
    # Same guard as repository discovery: a stat on a stalled cloud mount can
    # block for minutes, and this runs on roster reads.
    if not path or _is_cloud_synced_path(Path(path)) or not os.path.isdir(path):
        return snapshot
    rc, out = await _run_snapshot_git(
        [
            "git", "rev-parse", "--path-format=absolute",
            "--show-toplevel", "--git-dir", "--git-common-dir",
        ],
        path,
    )
    lines = out.splitlines()
    if rc != 0 or len(lines) < 3:
        return snapshot
    toplevel, git_dir, common_dir = lines[0], lines[1], lines[2]
    # Panes in different folders of one checkout each get here on a cold cache,
    # but the rest depends only on the checkout, so concurrent reads share it.
    key = (asyncio.get_running_loop(), toplevel)
    task = _checkout_snapshots_inflight.get(key)
    if task is None:
        task = asyncio.ensure_future(_checkout_snapshot(toplevel, git_dir, common_dir))
        _checkout_snapshots_inflight[key] = task
        task.add_done_callback(lambda _task: _checkout_snapshots_inflight.pop(key, None))
    return dict(await asyncio.shield(task))


_checkout_snapshots_inflight: dict[
    tuple[asyncio.AbstractEventLoop, str], asyncio.Future[dict[str, Any]]
] = {}


def _latest_fetch_head_mtime(common_dir: str) -> float | None:
    """The newest FETCH_HEAD mtime of a repository, or None when none exists.

    FETCH_HEAD is per worktree (a fetch in a linked worktree writes
    worktrees/<name>/FETCH_HEAD), but the origin/main it refreshes is shared,
    so the latest fetch from any worktree is the one that dates the drift.
    """
    fetch_heads = [os.path.join(common_dir, "FETCH_HEAD")]
    fetch_heads += glob.glob(os.path.join(glob.escape(common_dir), "worktrees", "*", "FETCH_HEAD"))
    mtimes = []
    for fetch_head in fetch_heads:
        try:
            mtimes.append(os.stat(fetch_head).st_mtime)
        except OSError:
            pass
    return max(mtimes) if mtimes else None


async def _checkout_snapshot(toplevel: str, git_dir: str, common_dir: str) -> dict[str, Any]:
    snapshot = _empty_pane_git_snapshot()
    snapshot["worktreeRoot"] = toplevel
    snapshot["isLinkedWorktree"] = os.path.realpath(git_dir) != os.path.realpath(common_dir)

    rc, out = await _run_snapshot_git(["git", "branch", "--show-current"], toplevel)
    branch = out.strip() if rc == 0 else ""
    if not branch:
        rc, out = await _run_snapshot_git(["git", "rev-parse", "--short", "HEAD"], toplevel)
        branch = out.strip() if rc == 0 else ""
    snapshot["branch"] = branch or None

    # --no-optional-locks: a read-only status must not take index.lock and make
    # a concurrent commit in that worktree fail. Capped like get_status (#144):
    # only the count is wanted, so a huge untracked tree saturates it instead of
    # being read whole and split on the event loop.
    async with _snapshot_proc_semaphore():
        rc, raw, _, capped = await run_allowlisted_capped(
            ["git", "--no-optional-locks", "status", "--porcelain"],
            toplevel,
            timeout=_SNAPSHOT_GIT_TIMEOUT_S,
            max_stdout_bytes=_SNAPSHOT_STATUS_MAX_BYTES,
        )
    if capped:
        snapshot["dirty"] = _SNAPSHOT_DIRTY_LIMIT
    elif rc == 0:
        snapshot["dirty"] = min(raw.count(b"\n"), _SNAPSHOT_DIRTY_LIMIT)

    rc, out = await _run_snapshot_git(
        ["git", "rev-list", "--left-right", "--count", "origin/main...HEAD"], toplevel
    )
    counts = out.split()
    if rc == 0 and len(counts) == 2 and all(c.isdigit() for c in counts):
        snapshot["behind"], snapshot["ahead"] = int(counts[0]), int(counts[1])

    # Listing worktrees/ and stat'ing each FETCH_HEAD is disk work that grows
    # with the linked worktrees; on the event loop it showed up in its stalls.
    mtime = await asyncio.to_thread(_latest_fetch_head_mtime, common_dir)
    if mtime is not None:
        snapshot["fetchedAt"] = (
            datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat().replace("+00:00", "Z")
        )
    return snapshot


def _path_within(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def _comparable_path(path: str) -> str:
    # Git for Windows reports C:/Work/repo while the watcher reports the
    # workspace as opened (c:\work\repo); NTFS ignores case and either separator.
    return os.path.normcase(os.path.normpath(path))


class PaneGitSnapshots:
    """`pane_git_snapshot` behind a per-worktree cache.

    Keyed by worktree root, so every pane in one checkout shares one snapshot
    however many of them a roster read asks about; the path → root mapping is
    remembered from the snapshot itself, so a warm read spawns no git at all.
    An entry is recomputed when it is older than ``ttl_s`` or when the git
    watcher reports a change under it (``invalidate``), and concurrent reads of
    one cold root share a single computation.
    """

    def __init__(
        self,
        *,
        ttl_s: float = 30.0,
        compute: Callable[[str], Awaitable[dict[str, Any]]] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._ttl_s = ttl_s
        self._compute = compute or pane_git_snapshot
        self._clock = clock
        #: path asked about -> worktree root ("" for a path outside any repo)
        self._root_of: dict[str, str] = {}
        #: cache key (worktree root, or the path itself when it has none)
        #: -> (snapshot, computed_at)
        self._entries: dict[str, tuple[dict[str, Any], float]] = {}
        self._inflight: dict[str, asyncio.Task[dict[str, Any]]] = {}
        #: Same keys as _entries -> (last snapshot, when it was computed). Kept
        #: across invalidate, for ``peek``.
        self._last: dict[str, tuple[dict[str, Any], float]] = {}
        #: Bumped by every invalidate, so a computation that was already running
        #: when the change landed is stored as stale instead of as fresh.
        self._generation = 0
        #: comparable changed path -> generation of its latest invalidate. Only
        #: a change that overlaps a computation's own path or root makes it
        #: stale: a global flag threw away every other workspace's snapshot
        #: while agents kept editing one, so git was re-run on every poll.
        #: One key per watched workspace, so it stays as small as that set.
        self._changed_at: dict[str, int] = {}

    def _key_for(self, path: str) -> str:
        return self._root_of.get(path) or path

    def _fresh(self, key: str) -> dict[str, Any] | None:
        entry = self._entries.get(key)
        if entry is None or self._clock() - entry[1] >= self._ttl_s:
            return None
        return entry[0]

    async def get(self, path: str) -> dict[str, Any]:
        """The snapshot for *path*; see ``pane_git_snapshot`` for the shape."""
        key = self._key_for(path)
        cached = self._fresh(key)
        if cached is not None:
            return dict(cached)
        task = self._inflight.get(key)
        if task is None:
            task = asyncio.ensure_future(self._refresh(path, key))
            self._inflight[key] = task
        # Shielded so a caller that gives up (a roster read's own timeout) does
        # not cancel the computation every other reader of this root is sharing.
        return dict(await asyncio.shield(task))

    def peek(self, path: str) -> dict[str, Any] | None:
        """The last snapshot for *path*, without waiting; None before the first.

        For a decoration polled every few seconds (the network view): it is
        answered from what was last computed, even after a change, and a
        refresh starts in the background only when that is older than the
        TTL. A git.changed burst therefore no longer re-runs git on each poll;
        ``get`` stays the read that waits for a current answer.
        """
        key = self._key_for(path)
        last = self._last.get(key)
        if (last is None or self._clock() - last[1] >= self._ttl_s) and key not in self._inflight:
            self._inflight[key] = asyncio.ensure_future(self._refresh(path, key))
        return dict(last[0]) if last is not None else None

    async def _refresh(self, path: str, key: str) -> dict[str, Any]:
        generation = self._generation
        try:
            snapshot = await self._compute(path)
        except Exception as err:  # noqa: BLE001 - a decoration must never break its read
            log.warning("pane git snapshot failed for %s: %s", path, err)
            snapshot = _empty_pane_git_snapshot()
        finally:
            self._inflight.pop(key, None)
        root = snapshot.get("worktreeRoot") or ""
        self._root_of[path] = root
        computed_at = float("-inf") if self._changed_since(generation, path, root) else self._clock()
        self._entries[root or path] = (snapshot, computed_at)
        self._last[root or path] = (snapshot, self._clock())
        return snapshot

    def _changed_since(self, generation: int, path: str, root: str) -> bool:
        """Whether an invalidate after *generation* touched *path* or *root*."""
        mine = {_comparable_path(p) for p in (path, root) if p}
        return any(
            at > generation and any(_path_within(k, c) or _path_within(c, k) for k in mine)
            for c, at in self._changed_at.items()
        )

    def invalidate(self, changed_path: str) -> None:
        """Drop every entry a change under *changed_path* can have touched.

        The watcher reports the workspace it watches, which may be a worktree
        root, a folder inside one, or a folder holding several repositories.
        """
        if not changed_path:
            return
        self._generation += 1
        # git reports worktree roots with symlinks resolved (/var → /private/var
        # on macOS), while the watcher reports the workspace as it was opened,
        # so compare both spellings or a change would never reach its entry.
        changed = {
            _comparable_path(changed_path),
            _comparable_path(os.path.realpath(changed_path)),
        }
        for c in changed:
            self._changed_at[c] = self._generation
        for key in list(self._entries):
            k = _comparable_path(key)
            if any(_path_within(k, c) or _path_within(c, k) for c in changed):
                del self._entries[key]
        # A path that was outside any repository may be inside one now (git init).
        for path, root in list(self._root_of.items()):
            p = _comparable_path(path)
            if not root and any(_path_within(p, c) for c in changed):
                del self._root_of[path]


#: The process-wide cache every roster read shares.
pane_git_snapshots = PaneGitSnapshots()


#: Path segments that only ever appear inside a cloud-sync provider's mount.
_CLOUD_SEGMENTS = (".shortcut-targets-by-id", "com~apple~CloudDocs")
#: Segments that mean "cloud mount" only directly under a ``Library`` segment,
#: so an ordinary project folder named e.g. ``CloudStorage`` is not caught.
_CLOUD_LIBRARY_SEGMENTS = ("CloudStorage", "Mobile Documents")


def _is_cloud_synced_path(root: Path) -> bool:
    """True when *root* sits inside a cloud-sync provider mount.

    Google Drive, Dropbox, OneDrive and iCloud Drive expose their trees through
    macOS File Provider domains whose ``readdir()`` can block for minutes while
    the provider materializes a directory — long enough to freeze a whole tree
    walk (issue #24).

    Deliberately no ``os.statvfs``/statfs mount-type probe: those providers are
    File Provider domains living on the local APFS volume, so statfs reports
    them as local and the probe would be dead code. Python's stdlib exposes no
    filesystem type either, and the backend carries no psutil dependency (see
    backend/pyproject.toml) — path segments are the only signal available.

    Matching is on whole path segments, never substrings.
    """
    parts = root.parts
    for index, segment in enumerate(parts):
        if segment in _CLOUD_SEGMENTS:
            return True
        if segment in _CLOUD_LIBRARY_SEGMENTS and index > 0 and parts[index - 1] == "Library":
            return True
    return False


def _discover_workspace(
    workspace_path: str,
    max_depth: int,
    limit: int,
    repos: list[dict[str, str]],
    workspace_validation: queue.SimpleQueue[bool],
    stop_requested: threading.Event,
    deadline: float,
    force: bool,
) -> tuple[bool, bool, bool]:
    """Cloud-mount preflight, then the tree walk. Returns (found, truncated, skipped).

    Runs entirely on a worker thread: ``Path.resolve()`` and the root ``.git``
    stat are real syscalls that hang for minutes on a stalled cloud mount, so
    none of them may run on the event loop.
    """
    if not force:
        try:
            root = Path(workspace_path).resolve()
        except OSError:
            workspace_validation.put(False)
            return False, False, False
        if _is_cloud_synced_path(root):
            if not root.is_dir():
                workspace_validation.put(False)
                return False, False, False
            workspace_validation.put(True)
            # No tree walk here, but a repo sitting directly on the mount must
            # keep working — one stat for the root is cheap enough to risk.
            if (root / ".git").exists():
                repos.append({"rel_path": ".", "abs_path": str(root)})
            return True, True, True

    found, truncated = _discover_repository_paths(
        workspace_path, max_depth, limit, repos, workspace_validation, stop_requested, deadline
    )
    return found, truncated, False


def _discover_repository_paths(
    workspace_path: str,
    max_depth: int,
    limit: int,
    repos: list[dict[str, str]],
    workspace_validation: queue.SimpleQueue[bool],
    stop_requested: threading.Event,
    deadline: float,
) -> tuple[bool, bool]:
    from .fs_service import _NOISE_SEGMENTS

    root = Path(workspace_path).resolve()
    if not root.is_dir():
        workspace_validation.put(False)
        return False, False
    workspace_validation.put(True)

    truncated = False
    for dirpath, dirnames, _filenames in os.walk(root):
        if stop_requested.is_set() or time.monotonic() >= deadline:
            truncated = True
            break
        dirnames[:] = [d for d in dirnames if d not in _NOISE_SEGMENTS and not d.startswith(".")]
        here = Path(dirpath)
        depth = len(here.relative_to(root).parts)
        if (here / ".git").exists():
            rel = "." if depth == 0 else str(here.relative_to(root))
            repos.append({"rel_path": rel, "abs_path": str(here)})
            if depth > 0:
                # Don't descend into a nested repo's subtree.
                dirnames[:] = []
            if len(repos) >= limit:
                truncated = True
                break
            continue
        if depth >= max_depth:
            dirnames[:] = []  # stop descending past the depth cap

    return True, truncated


async def discover_repositories(
    workspace_path: str, max_depth: int = 3, limit: int = 20, force: bool = False
) -> dict[str, Any]:
    """Scan *workspace_path* for git repositories, including the root itself.

    ``git rev-parse`` only searches UPWARD, so nested repos inside a projects
    folder go undetected. This walks the tree — bounded by *max_depth* and
    *limit*, skipping noise dirs — and returns every repo root found. A directory
    is a repo root when it contains a ``.git`` entry (dir or file; worktrees and
    submodules use a ``.git`` file).

    The root is always checked first. If it is itself a repo it is listed as
    ``rel_path: "."`` and scanning continues into its subtree to find nested repos.
    Nested found repos are not descended into further.

    A workspace on a cloud-sync mount is not walked at all unless *force* — see
    ``_is_cloud_synced_path`` — and comes back as ``skipped: "cloud_storage"``.
    """
    repos: list[dict[str, str]] = []
    workspace_validation: queue.SimpleQueue[bool] = queue.SimpleQueue()
    stop_requested = threading.Event()
    deadline = time.monotonic() + _DISCOVERY_SCAN_BUDGET_S
    scan_task = asyncio.create_task(
        asyncio.to_thread(
            _discover_workspace,
            workspace_path,
            max_depth,
            limit,
            repos,
            workspace_validation,
            stop_requested,
            deadline,
            force,
        )
    )
    scan_task.add_done_callback(
        lambda task: None if task.cancelled() else task.exception()
    )
    try:
        done, _pending = await asyncio.wait(
            {scan_task}, timeout=max(0.0, deadline - time.monotonic())
        )
        if scan_task in done:
            found, truncated, skipped_cloud = scan_task.result()
        else:
            stop_requested.set()
            skipped_cloud = False
            try:
                found = workspace_validation.get_nowait()
            except queue.Empty:
                # Validation itself exceeded the budget. Preserve the successful,
                # truncated response shape without claiming the workspace is missing.
                found = True
            truncated = True
            repos = list(repos)
    finally:
        if not scan_task.done():
            stop_requested.set()

    if not found:
        return {"ok": False, "error": "workspace not found", "repositories": []}

    # Annotate each repo with its current branch (best-effort; empty on failure).
    for repo in repos:
        if truncated:
            repo["branch"] = ""
        else:
            rc, out, _ = await _run(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo["abs_path"])
            repo["branch"] = out.strip() if rc == 0 else ""

    result: dict[str, Any] = {"ok": True, "repositories": repos, "truncated": truncated}
    if skipped_cloud:
        result["skipped"] = "cloud_storage"
    return result


async def get_log(
    workspace_path: str,
    n: int = 20,
    all_branches: bool = False,
    query: str | None = None,
    order: str = "ancestor",
) -> list[dict[str, Any]]:
    """Return the last *n* commits as serialisable dicts.

    *all_branches* mirrors SourceTree's default view: ``--all`` includes commits
    from every branch/remote/tag (not just HEAD's ancestry) so the frontend can
    render a true multi-lane DAG.

    *order* picks the sort passed to git: ``"ancestor"`` (default) keeps children
    above their parents via ``--topo-order`` — the ordering the lane layout
    assumes — while ``"date"`` uses ``--date-order`` (SourceTree's "Date Order").
    Any other value falls back to ``"ancestor"`` so callers can never inject a raw
    flag.

    *query*, when non-empty, filters commits whose message matches it via
    ``--grep`` with case-insensitive matching. The query is passed as the single
    ``--grep=<query>`` argv element so a leading ``-`` is never parsed as a flag.
    """
    if not workspace_path or not Path(workspace_path).is_dir():
        return []

    order_flag = "--date-order" if order == "date" else "--topo-order"
    # %H=full hash, %h=short, %s=subject, %D=ref names, %P=parent hashes,
    # %an=author name, %ad=author date (short YYYY-MM-DD)
    fmt = "%H%x00%h%x00%s%x00%D%x00%P%x00%an%x00%ad"
    args = ["git", "log", order_flag, "--date=short", f"--pretty=format:{fmt}", f"-n{n}"]
    if all_branches:
        args.append("--all")
    if query:
        args.extend([f"--grep={query}", "--regexp-ignore-case"])
    rc, out, _ = await _run(args, workspace_path)
    if rc != 0:
        return []

    commits: list[dict[str, Any]] = []
    for line in out.splitlines():
        parts = line.split("\x00")
        if len(parts) < 4:
            continue
        full_hash, short_hash, message, refs = parts[0], parts[1], parts[2], parts[3]
        parent_str = parts[4] if len(parts) > 4 else ""
        author = parts[5] if len(parts) > 5 else ""
        date = parts[6] if len(parts) > 6 else ""
        branches = [r.strip() for r in refs.split(",") if r.strip()] if refs.strip() else []
        parents = [p for p in parent_str.split() if p]
        commits.append(asdict(GitCommit(
            hash=full_hash,
            short_hash=short_hash,
            message=message,
            branches=branches,
            parents=parents,
            author=author,
            date=date,
        )))
    return commits


@_serialize_write
async def cherry_pick(workspace_path: str, commit_hash: str) -> dict[str, Any]:
    """Apply *commit_hash* onto the current branch (`git cherry-pick --no-edit`)."""
    if err := _validate_commit_hash(commit_hash):
        return {"ok": False, "error": err}
    rc, out, stderr = await _run(
        ["git", "cherry-pick", "--no-edit", "--", commit_hash.strip()], workspace_path
    )
    if rc != 0:
        return {"ok": False, "error": stderr.strip() or out.strip()}
    hash_match = re.search(r"\[.+ ([0-9a-f]{7,})\]", out)
    return {"ok": True, "hash": hash_match.group(1) if hash_match else ""}


@dataclass
class GitTag:
    name: str
    commit_hash: str
    message: str = ""


async def list_tags(workspace_path: str) -> list[dict[str, Any]]:
    """Return all tags sorted newest-first."""
    rc, out, _ = await _run(
        ["git", "tag", "-l", "--sort=-creatordate", "--format=%(refname:short)\t%(objectname:short)\t%(subject)"],
        workspace_path,
    )
    if rc != 0 or not out.strip():
        return []
    tags: list[dict] = []
    for line in out.splitlines():
        parts = line.split("\t")
        name = parts[0].strip()
        commit_hash = parts[1].strip() if len(parts) > 1 else ""
        message = parts[2].strip() if len(parts) > 2 else ""
        tags.append(asdict(GitTag(name=name, commit_hash=commit_hash, message=message)))
    return tags


@_serialize_write
async def create_tag(workspace_path: str, name: str, message: str = "", commit_hash: str = "") -> dict[str, Any]:
    """Create an annotated tag (if message given) or lightweight tag."""
    if err := _validate_ref_name(name, "tag name"):
        return {"ok": False, "error": err}
    if commit_hash.strip():
        if err := _validate_commit_hash(commit_hash):
            return {"ok": False, "error": err}
    args = ["git", "tag"]
    if message.strip():
        args += ["-a", "-m", message.strip(), "--", name.strip()]
    else:
        args += ["--", name.strip()]
    if commit_hash.strip():
        args.append(commit_hash.strip())
    rc, _, stderr = await _run(args, workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


@_serialize_write
async def delete_tag(workspace_path: str, name: str) -> dict[str, Any]:
    """Delete a local tag."""
    if err := _validate_ref_name(name, "tag name"):
        return {"ok": False, "error": err}
    rc, _, stderr = await _run(["git", "tag", "-d", "--", name.strip()], workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


async def file_log(workspace_path: str, filepath: str, n: int = 15) -> list[dict[str, Any]]:
    """Return commits that modified *filepath* (follows renames)."""
    fmt = "%H%x00%h%x00%s%x00%D"
    rc, out, _ = await _run(
        ["git", "log", "--follow", f"--pretty=format:{fmt}", f"-n{n}", "--", filepath],
        workspace_path,
    )
    if rc != 0 or not out.strip():
        return []
    commits: list[dict[str, Any]] = []
    for line in out.splitlines():
        parts = line.split("\x00")
        if len(parts) < 4:
            continue
        full_hash, short_hash, message, refs = parts[0], parts[1], parts[2], parts[3]
        branches = [r.strip() for r in refs.split(",") if r.strip()] if refs.strip() else []
        commits.append(asdict(GitCommit(hash=full_hash, short_hash=short_hash, message=message, branches=branches)))
    return commits


@_serialize_write
async def resolve_conflict_ours(workspace_path: str, filepath: str) -> dict[str, Any]:
    """Accept 'ours' side in a merge conflict for *filepath*."""
    rc, _, stderr = await _run(["git", "checkout", "--ours", "--", filepath], workspace_path)
    if rc != 0:
        return {"ok": False, "error": stderr.strip()}
    rc2, _, stderr2 = await _run(["git", "add", "--", filepath], workspace_path)
    return {"ok": rc2 == 0, "error": stderr2.strip() if rc2 != 0 else ""}


@_serialize_write
async def resolve_conflict_theirs(workspace_path: str, filepath: str) -> dict[str, Any]:
    """Accept 'theirs' side in a merge conflict for *filepath*."""
    rc, _, stderr = await _run(["git", "checkout", "--theirs", "--", filepath], workspace_path)
    if rc != 0:
        return {"ok": False, "error": stderr.strip()}
    rc2, _, stderr2 = await _run(["git", "add", "--", filepath], workspace_path)
    return {"ok": rc2 == 0, "error": stderr2.strip() if rc2 != 0 else ""}


# ─── Three-way conflict stages ────────────────────────────────────────────────
# git keeps an unmerged path in the index as up to three entries: stage 1 is the
# merge base, stage 2 "ours", stage 3 "theirs". Which stages exist is what tells
# an add/add conflict (no base) apart from a delete/modify one (a side missing)
# — reading `git show :N:path` three times cannot, because a missing stage and a
# read failure both come back as a non-zero exit.
_CONFLICT_STAGE_KEYS: tuple[tuple[int, str], ...] = ((1, "base"), (2, "ours"), (3, "theirs"))

# Which stages are present → the conflict kind git status renders as AA/DU/UD/…
_CONFLICT_KINDS: dict[frozenset[int], str] = {
    frozenset({1, 2, 3}): "both-modified",
    frozenset({2, 3}): "both-added",
    frozenset({1, 2}): "deleted-by-them",
    frozenset({1, 3}): "deleted-by-us",
    frozenset({1}): "both-deleted",
    frozenset({2}): "added-by-us",
    frozenset({3}): "added-by-them",
}


async def _unmerged_entries(
    workspace_path: str, filepath: str = ""
) -> tuple[bool, dict[str, dict[int, str]], str]:
    """Return ``(ok, {path: {stage: blob_sha}}, error)`` for unmerged index entries.

    ``git ls-files -u -z`` emits ``<mode> SP <sha> SP <stage> TAB <path> NUL``.
    The ``-z`` form leaves paths unquoted, so records are split on NUL — never on
    line breaks, which are legal inside a filename.
    """
    args = ["git", "ls-files", "-u", "-z"]
    if filepath:
        args += ["--", filepath]
    rc, out, stderr = await _run(args, workspace_path)
    if rc != 0:
        return False, {}, stderr.strip() or "git ls-files failed"
    entries: dict[str, dict[int, str]] = {}
    for record in out.split("\x00"):
        if not record:
            continue
        meta, sep, path = record.partition("\t")
        if not sep or not path:
            continue
        parts = meta.split()
        if len(parts) < 3:
            continue
        try:
            stage = int(parts[2])
        except ValueError:
            continue
        entries.setdefault(path, {})[stage] = parts[1]
    return True, entries, ""


def _decode_blob(data: bytes) -> str | None:
    """Decode blob bytes as text, or return None when the blob is binary.

    Follows git's own heuristic (a NUL byte means binary) and additionally
    refuses anything that is not valid UTF-8, so no caller ever receives a
    lossily replaced string.
    """
    if b"\x00" in data:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


async def conflict_stages(workspace_path: str, filepath: str) -> dict[str, Any]:
    """Return the three merge stages of a conflicted *filepath* in one round-trip.

    Blobs are read by sha with ``git cat-file blob`` rather than ``git show
    :N:<path>``: the sha comes straight from the index listing, so no pathspec
    is re-parsed and filenames containing ``:``, leading dashes or newlines are
    a non-issue.

    A stage that does not exist reports ``has_* = False`` with empty content —
    the normal shape of add/add (no base) and delete/modify (a side missing)
    conflicts, not an error. Binary stages set ``binary`` and keep their content
    empty, since there is nothing a text merge view could show.
    """
    empty: dict[str, Any] = {
        "base": "", "ours": "", "theirs": "",
        "has_base": False, "has_ours": False, "has_theirs": False,
        "binary": False,
    }
    if not filepath:
        return {"ok": False, **empty, "error": "filepath is required"}
    ok, entries, err = await _unmerged_entries(workspace_path, filepath)
    if not ok:
        return {"ok": False, **empty, "error": err}
    stages = entries.get(filepath)
    if stages is None and len(entries) == 1:
        # The pathspec matched a single entry under a different spelling
        # (e.g. "./name"); use it rather than claiming there is no conflict.
        stages = next(iter(entries.values()))
    if not stages:
        return {"ok": False, **empty, "error": f"{filepath} is not conflicted"}

    result: dict[str, Any] = {"ok": True, **empty, "error": ""}
    for stage, key in _CONFLICT_STAGE_KEYS:
        sha = stages.get(stage)
        if not sha:
            continue
        result[f"has_{key}"] = True
        rc, blob, stderr = await _run_bytes(["git", "cat-file", "blob", sha], workspace_path)
        if rc != 0:
            return {"ok": False, **empty, "error": stderr.strip() or f"cannot read stage {stage}"}
        text = _decode_blob(blob)
        if text is None:
            result["binary"] = True
        else:
            result[key] = text
    return result


async def list_conflicts(workspace_path: str) -> dict[str, Any]:
    """List every unmerged path with the kind of conflict it is in.

    Survives an app restart (unlike scraping merge output) because the index is
    the source of truth. Outside a merge the index has no unmerged entries, so
    the list is simply empty — that is not an error.
    """
    ok, entries, err = await _unmerged_entries(workspace_path)
    if not ok:
        return {"ok": False, "conflicts": [], "error": err}
    conflicts = [
        {"path": path, "kind": _CONFLICT_KINDS.get(frozenset(stages), "unknown")}
        for path, stages in sorted(entries.items())
    ]
    return {"ok": True, "conflicts": conflicts, "error": ""}


@_serialize_write
async def mark_resolved(workspace_path: str, filepath: str) -> dict[str, Any]:
    """Stage *filepath* as resolved without rewriting it (plain ``git add``).

    ``resolve_conflict_ours``/``_theirs`` overwrite the working-tree file first;
    a merge editor has already written the content it wants, so only the staging
    step is left. The content is deliberately NOT checked for leftover conflict
    markers — text that looks like a marker can be exactly what the user meant to
    keep, and git itself does not object either.
    """
    if not filepath:
        return {"ok": False, "error": "filepath is required"}
    rc, _, stderr = await _run(["git", "add", "--", filepath], workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


@_serialize_write
async def discard_changes(workspace_path: str, files: list[str]) -> dict[str, Any]:
    """Discard unstaged changes in *files* (git restore -- <files>).
    Untracked files are deleted from disk; tracked files revert to HEAD.
    """
    if not files:
        return {"ok": True}
    # Separate untracked vs tracked: untracked can't use git restore
    status = await get_status(workspace_path)
    # Untracked paths are deleted, so the split needs a complete status read:
    # refuse rather than guess when the read failed or stopped short (#144).
    if not isinstance(status.get("is_git_repo"), bool):
        return {"ok": False, "error": status.get("error") or "git status failed"}
    untracked_paths = {f["path"] for f in status.get("untracked", [])}
    if status.get("truncated"):
        listed = untracked_paths | {
            f["path"] for f in status.get("staged", []) + status.get("unstaged", [])
        }
        unlisted = [f for f in files if f not in listed]
        if unlisted:
            return {
                "ok": False,
                "error": "git status was truncated; cannot tell how to discard: "
                + ", ".join(unlisted[:5]),
            }
    to_restore = [f for f in files if f not in untracked_paths]
    to_delete = [f for f in files if f in untracked_paths]

    errors: list[str] = []
    if to_restore:
        rc, _, stderr = await _run(["git", "restore", "--"] + to_restore, workspace_path)
        if rc != 0:
            errors.append(stderr.strip())
    if to_delete:
        for fp in to_delete:
            try:
                (Path(workspace_path) / fp).unlink(missing_ok=True)
            except Exception as exc:
                errors.append(str(exc))

    return {"ok": not errors, "error": "; ".join(errors) if errors else ""}


# ─── Worktree management ──────────────────────────────────────────────────────

def _reject_flag_path(value: str, label: str) -> str | None:
    """Return None if *value* is a safe positional path argument, else an error.

    git worktree subcommands take bare paths (no ``--`` separator in their
    grammar), so a path starting with ``-`` would be read as a flag. Guard it,
    matching how the rest of this module validates path arguments.
    """
    v = (value or "").strip()
    if not v:
        return f"{label} is required"
    if v.startswith("-"):
        return f"invalid {label}: must not start with '-'"
    return None


async def list_worktrees(workspace_path: str) -> list[dict[str, Any]]:
    """Return all worktrees (including the main working tree).

    Each entry carries path/head/branch/is_main plus the porcelain state flags
    ``detached``/``bare``/``locked``/``prunable`` (with their reasons), so the UI
    can badge stale or locked worktrees and offer the right action.
    """
    rc, out, _ = await _run(["git", "worktree", "list", "--porcelain"], workspace_path)
    if rc != 0 or not out.strip():
        return []

    def _blank() -> dict:
        return {
            "path": "", "head": "", "branch": "", "is_main": False,
            "detached": False, "bare": False,
            "locked": False, "lock_reason": "",
            "prunable": False, "prune_reason": "",
        }

    worktrees: list[dict] = []
    current: dict = {}
    first = True
    for line in out.splitlines():
        if line.startswith("worktree "):
            if current:
                worktrees.append(current)
            current = _blank()
            # git prints `C:/Users/...` on Windows; normalise so the path
            # compares equal to the OS-native one the caller holds.
            current["path"] = os.path.normpath(line[len("worktree "):].strip())
            current["is_main"] = first
            first = False
        elif not current:
            continue
        elif line.startswith("HEAD "):
            current["head"] = line[5:].strip()[:8]  # short hash
        elif line.startswith("branch "):
            current["branch"] = line[7:].strip().removeprefix("refs/heads/")
        elif line.strip() == "detached":
            current["detached"] = True
        elif line.strip() == "bare":
            current["bare"] = True
        elif line == "locked" or line.startswith("locked "):
            current["locked"] = True
            current["lock_reason"] = line[len("locked "):].strip() if line.startswith("locked ") else ""
        elif line == "prunable" or line.startswith("prunable "):
            current["prunable"] = True
            current["prune_reason"] = line[len("prunable "):].strip() if line.startswith("prunable ") else ""
        elif line.strip() == "":
            worktrees.append(current)
            current = {}
    if current:
        worktrees.append(current)
    return worktrees


@_serialize_write
async def add_worktree(
    workspace_path: str, worktree_path: str, branch: str, new_branch: bool = False
) -> dict[str, Any]:
    """Create a new worktree at *worktree_path* checked out at *branch*.

    If *new_branch* is True, creates the branch with ``-b``.
    """
    if err := _reject_flag_path(worktree_path, "worktree path"):
        return {"ok": False, "error": err}
    if err := _validate_ref_name(branch, "branch name"):
        return {"ok": False, "error": err}
    args = ["git", "worktree", "add"]
    if new_branch:
        args += ["-b", branch.strip()]
    args.append(worktree_path.strip())
    if not new_branch:
        args.append(branch.strip())
    rc, out, stderr = await _run(args, workspace_path)
    return {"ok": rc == 0, "output": (out + stderr).strip(), "error": stderr.strip() if rc != 0 else ""}


@_serialize_write
async def remove_worktree(workspace_path: str, worktree_path: str, force: bool = False) -> dict[str, Any]:
    """Remove an existing worktree directory (``--force`` for dirty/locked ones)."""
    if err := _reject_flag_path(worktree_path, "worktree path"):
        return {"ok": False, "error": err}
    args = ["git", "worktree", "remove"]
    if force:
        args.append("--force")
    args.append(worktree_path.strip())
    rc, _, stderr = await _run(args, workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


@_serialize_write
async def prune_worktrees(workspace_path: str) -> dict[str, Any]:
    """Prune worktree admin entries whose directories are gone (stale/prunable)."""
    rc, out, stderr = await _run(["git", "worktree", "prune", "-v"], workspace_path)
    return {"ok": rc == 0, "output": (out + stderr).strip(), "error": stderr.strip() if rc != 0 else ""}


@_serialize_write
async def lock_worktree(workspace_path: str, worktree_path: str, reason: str = "") -> dict[str, Any]:
    """Lock a worktree so prune/auto-cleanup won't remove it (e.g. on a removable disk)."""
    if err := _reject_flag_path(worktree_path, "worktree path"):
        return {"ok": False, "error": err}
    args = ["git", "worktree", "lock"]
    if reason.strip():
        args += ["--reason", reason.strip()]
    args.append(worktree_path.strip())
    rc, _, stderr = await _run(args, workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


@_serialize_write
async def unlock_worktree(workspace_path: str, worktree_path: str) -> dict[str, Any]:
    """Unlock a previously locked worktree."""
    if err := _reject_flag_path(worktree_path, "worktree path"):
        return {"ok": False, "error": err}
    rc, _, stderr = await _run(["git", "worktree", "unlock", worktree_path.strip()], workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


@_serialize_write
async def move_worktree(workspace_path: str, worktree_path: str, new_path: str) -> dict[str, Any]:
    """Move a worktree to *new_path* (updates git's admin records)."""
    if err := _reject_flag_path(worktree_path, "worktree path"):
        return {"ok": False, "error": err}
    if err := _reject_flag_path(new_path, "new path"):
        return {"ok": False, "error": err}
    rc, out, stderr = await _run(
        ["git", "worktree", "move", worktree_path.strip(), new_path.strip()], workspace_path
    )
    return {"ok": rc == 0, "output": (out + stderr).strip(), "error": stderr.strip() if rc != 0 else ""}


@_serialize_write
async def repair_worktree(workspace_path: str) -> dict[str, Any]:
    """Repair worktree admin files after the main repo or a worktree was moved."""
    rc, out, stderr = await _run(["git", "worktree", "repair"], workspace_path)
    return {"ok": rc == 0, "output": (out + stderr).strip(), "error": stderr.strip() if rc != 0 else ""}


# ─── Git config ───────────────────────────────────────────────────────────────

# Explicit allowlist — only keys the UI exposes are permitted.
# A regex is NOT used because it could admit dangerous keys like
# core.sshCommand, diff.external, etc. that git uses to execute arbitrary commands.
_ALLOWED_CONFIG_KEYS: frozenset[str] = frozenset({
    "user.name",
    "user.email",
    "core.autocrlf",
    "core.filemode",
    "pull.rebase",
})


async def get_config(workspace_path: str) -> dict[str, Any]:
    """Return local git config as key→value dict (includes global fallback for user.*)."""
    rc, out, _ = await _run(["git", "config", "--local", "--list"], workspace_path)
    result: dict[str, str] = {}
    if rc == 0:
        for line in out.splitlines():
            if "=" in line:
                k, _, v = line.partition("=")
                result[k.strip()] = v.strip()
    # Merge user.name / user.email from global if not set locally
    for key in ("user.name", "user.email"):
        if key not in result:
            rc2, out2, _ = await _run(["git", "config", "--global", key], workspace_path)
            if rc2 == 0 and out2.strip():
                result[key] = out2.strip() + " (global)"
    return {"ok": True, "config": result}


@_serialize_write
async def set_config(workspace_path: str, key: str, value: str) -> dict[str, Any]:
    """Set a local git config key to *value*.

    Only keys in *_ALLOWED_CONFIG_KEYS* are accepted to prevent RCE via
    dangerous git config options such as core.sshCommand or diff.external.
    Values starting with ``-`` are also rejected to prevent flag injection.
    """
    if key not in _ALLOWED_CONFIG_KEYS:
        return {"ok": False, "error": f"config key {key!r} is not in the allowed list"}
    if not value:
        return {"ok": False, "error": "config value must not be empty"}
    if value.startswith("-"):
        return {"ok": False, "error": "config value must not start with '-'"}
    rc, _, stderr = await _run(["git", "config", "--local", key, value], workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


# ─── Blame ────────────────────────────────────────────────────────────────────

@dataclass
class BlameEntry:
    short_hash: str
    author: str
    date: str        # YYYY-MM-DD
    line_no: int
    content: str


async def blame_file(workspace_path: str, filepath: str) -> dict[str, Any]:
    """Return per-line blame for *filepath*.

    Uses ``git blame -s`` (short format) for compact output.
    Returns a list of {short_hash, author, date, line_no, content} entries,
    deduplicated by hash so the caller can group by commit.
    """
    if not filepath.strip() or filepath.strip().startswith("-"):
        return {"ok": False, "lines": [], "error": "invalid filepath"}
    rc, out, stderr = await _run(
        ["git", "-c", "core.quotePath=false", "blame", "--porcelain", "--", filepath.strip()],
        workspace_path,
    )
    if rc != 0:
        return {"ok": False, "lines": [], "error": stderr.strip()}

    entries: list[dict] = []
    commit_cache: dict[str, dict] = {}
    current_hash = ""
    current_line_no = 0
    for line in out.splitlines():
        if re.match(r"^[0-9a-f]{40}(?:[0-9a-f]{24})? ", line):
            parts = line.split()
            current_hash = parts[0][:8]
            current_line_no = int(parts[2]) if len(parts) > 2 else 0
            if current_hash not in commit_cache:
                commit_cache[current_hash] = {"author": "", "date": ""}
        elif line.startswith("author "):
            commit_cache.setdefault(current_hash, {})["author"] = line[7:].strip()
        elif line.startswith("author-time "):
            ts = int(line[12:].strip())
            from datetime import datetime, timezone
            commit_cache.setdefault(current_hash, {})["date"] = (
                datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
            )
        elif line.startswith("\t"):
            meta = commit_cache.get(current_hash, {})
            entries.append(asdict(BlameEntry(
                short_hash=current_hash,
                author=meta.get("author", ""),
                date=meta.get("date", ""),
                line_no=current_line_no,
                content=line[1:],
            )))
    return {"ok": True, "lines": entries}


_ZERO_HASH_RE = re.compile(r"^0+$")  # all-zero object name (SHA-1 or SHA-256) = uncommitted line


def _parse_blame_porcelain(out: str) -> dict[int, dict]:
    """Parse ``git blame --porcelain`` output into {final_line_no: {meta}}.

    Each entry carries short_hash, author, date (YYYY-MM-DD) and a ``committed``
    flag (False for the all-zero hash git uses for not-yet-committed lines).
    """
    from datetime import datetime, timezone

    result: dict[int, dict] = {}
    commit_cache: dict[str, dict] = {}
    current_hash = ""
    current_line_no = 0
    for line in out.splitlines():
        if re.match(r"^[0-9a-f]{40}(?:[0-9a-f]{24})? ", line):
            parts = line.split()
            current_hash = parts[0]
            current_line_no = int(parts[2]) if len(parts) > 2 else 0
            commit_cache.setdefault(current_hash, {"author": "", "date": ""})
        elif line.startswith("author "):
            commit_cache.setdefault(current_hash, {})["author"] = line[7:].strip()
        elif line.startswith("author-time "):
            ts = int(line[12:].strip())
            commit_cache.setdefault(current_hash, {})["date"] = (
                datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
            )
        elif line.startswith("\t"):
            meta = commit_cache.get(current_hash, {})
            result[current_line_no] = {
                "short_hash": current_hash[:8],
                "author": meta.get("author", ""),
                "date": meta.get("date", ""),
                "committed": not _ZERO_HASH_RE.match(current_hash),
            }
    return result


def _annotate_diff(diff: str, new_map: dict[int, dict], old_map: dict[int, dict]) -> list[dict]:
    """Walk a unified diff and tag each line with blame info.

    Context/added lines map to the new (working-tree) blame by new line number;
    removed lines map to the old (HEAD) blame by old line number. Added lines are
    inherently uncommitted.
    """
    hunks: list[dict] = []
    cur: dict | None = None
    old_no = new_no = 0
    for line in diff.splitlines():
        if line.startswith("@@"):
            m = re.match(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@", line)
            if not m:
                continue
            old_no, new_no = int(m.group(1)), int(m.group(2))
            cur = {"header": line, "lines": []}
            hunks.append(cur)
        elif cur is None or line.startswith("\\"):
            continue  # file-header lines before the first hunk / "No newline" markers
        elif line.startswith(" "):
            info = new_map.get(new_no, {})
            cur["lines"].append({
                "kind": " ", "old_no": old_no, "new_no": new_no, "text": line[1:],
                "author": info.get("author", ""), "date": info.get("date", ""),
                "committed": info.get("committed", True),
            })
            old_no += 1
            new_no += 1
        elif line.startswith("-"):
            info = old_map.get(old_no, {})
            cur["lines"].append({
                "kind": "-", "old_no": old_no, "new_no": None, "text": line[1:],
                "author": info.get("author", ""), "date": info.get("date", ""),
                "committed": info.get("committed", True),
            })
            old_no += 1
        elif line.startswith("+"):
            info = new_map.get(new_no, {})
            cur["lines"].append({
                "kind": "+", "old_no": None, "new_no": new_no, "text": line[1:],
                "author": info.get("author", ""), "date": info.get("date", ""),
                "committed": info.get("committed", False),
            })
            new_no += 1
    return hunks


async def diff_blame(workspace_path: str, filepath: str, staged: bool = False) -> dict[str, Any]:
    """Return the diff for *filepath* with per-line blame annotation.

    Combines ``diff_file`` with two ``git blame`` passes (working tree + HEAD) so
    the UI can show only the changed lines and who last touched each one. Added
    lines are reported as uncommitted.
    """
    fp = filepath.strip()
    if not fp or fp.startswith("-"):
        return {"ok": False, "hunks": [], "error": "invalid filepath"}

    diff_res = await diff_file(workspace_path, fp, staged=staged)
    if not diff_res.get("ok"):
        return {"ok": False, "hunks": [], "error": diff_res.get("error", "")}
    diff = diff_res.get("diff", "")

    new_map: dict[int, dict] = {}
    rc, out, _ = await _run(
        ["git", "-c", "core.quotePath=false", "blame", "--porcelain", "--", fp], workspace_path
    )
    if rc == 0:
        new_map = _parse_blame_porcelain(out)

    old_map: dict[int, dict] = {}
    rc, out, _ = await _run(
        ["git", "-c", "core.quotePath=false", "blame", "--porcelain", "HEAD", "--", fp], workspace_path
    )
    if rc == 0:
        old_map = _parse_blame_porcelain(out)

    return {"ok": True, "hunks": _annotate_diff(diff, new_map, old_map)}


async def compare_branches(workspace_path: str, base: str, compare: str) -> dict[str, Any]:
    """Return diff stat summary between *base* and *compare* branches.

    Uses `git diff --stat <base>...<compare>` (three-dot, merge-base diff).
    Returns line counts and a per-file summary.
    """
    if err := _validate_ref_name(base, "base branch"):
        return {"ok": False, "error": err, "stat": "", "files": []}
    if err := _validate_ref_name(compare, "compare branch"):
        return {"ok": False, "error": err, "stat": "", "files": []}
    rc, out, stderr = await _run(
        ["git", "-c", "core.quotePath=false", "diff", "--stat", f"{base.strip()}...{compare.strip()}"],
        workspace_path,
    )
    if rc != 0:
        return {"ok": False, "error": stderr.strip(), "stat": "", "files": []}
    lines = out.strip().splitlines()
    summary = lines[-1] if lines else ""
    files = [ln.strip() for ln in lines[:-1] if ln.strip()]
    return {"ok": True, "stat": summary, "files": files}


# Head of a branch diff kept for the UI. A byte cap rather than a character one
# so the read can stop before the whole diff is decoded.
_DIFF_MAX_BYTES = 30_000


async def diff_branches(workspace_path: str, base: str, compare: str) -> dict[str, Any]:
    """Return a unified diff.

    When *compare* is empty, returns all uncommitted changes (staged + unstaged)
    via ``git diff HEAD`` — the same files shown in the GitPane file list.

    When *compare* is provided, uses three-dot diff (merge-base) so only
    committed changes unique to *compare* relative to *base* are shown.

    Truncated to 30,000 bytes; ``truncated`` says whether it was.
    """
    if not compare.strip():
        # Show all uncommitted changes (staged + unstaged) vs last commit
        cmd = ["git", "-c", "core.quotePath=false", "diff", "HEAD"]
    else:
        if err := _validate_ref_name(base, "base branch"):
            return {"ok": False, "diff": "", "error": err}
        if err := _validate_ref_name(compare, "compare branch"):
            return {"ok": False, "diff": "", "error": err}
        cmd = ["git", "-c", "core.quotePath=false", "diff", f"{base.strip()}...{compare.strip()}"]
    rc, out, stderr, truncated = await _run_capped(cmd, workspace_path, _DIFF_MAX_BYTES)
    # truncated is checked first: capping kills git, so rc is then a signal.
    if not truncated and rc != 0:
        return {"ok": False, "diff": "", "error": stderr.strip()}
    return {"ok": True, "diff": out, "truncated": truncated}


async def _rebase_in_progress(workspace_path: str) -> bool:
    """True if git left a rebase in progress (rebase-merge/rebase-apply dir)."""
    git_dir = await _resolve_git_dir(workspace_path)
    if git_dir is None:
        return False
    return (git_dir / "rebase-merge").is_dir() or (git_dir / "rebase-apply").is_dir()


@_serialize_write
async def rebase_on(workspace_path: str, branch: str) -> dict[str, Any]:
    """Rebase current branch onto *branch*.

    On conflict the rebase is left in progress (like ``merge_into``) so the UI
    can resolve or abort it — ``get_status`` reports the ``rebase`` operation and
    ``abort_operation("rebase")`` backs it out. A rebase that fails before it
    starts (e.g. a dirty tree) leaves nothing in progress and is reported as a
    plain error.
    """
    if err := _validate_ref_name(branch, "branch name"):
        return {"ok": False, "output": "", "error": err, "conflict_files": []}
    rc, out, stderr = await _run(["git", "rebase", branch.strip()], workspace_path)
    output = (out + stderr).strip()
    if rc == 0:
        return {"ok": True, "output": output, "error": "", "conflict_files": []}
    conflict_files = _parse_conflict_files(output)
    if await _rebase_in_progress(workspace_path):
        # Leave it for the UI to resolve (edit + stage + `git rebase --continue`)
        # or abort. Do NOT auto-abort — that made the rebase-conflict UI dead.
        return {
            "ok": False,
            "output": output,
            "error": stderr.strip() or "rebase stopped — resolve conflicts or abort",
            "conflict_files": conflict_files,
        }
    # Never entered a rebase (pre-flight failure) — nothing to leave behind.
    return {"ok": False, "output": output, "error": stderr.strip() or "rebase failed", "conflict_files": conflict_files}


@_serialize_write
async def restore_file_from_branch(workspace_path: str, branch: str, filepath: str) -> dict[str, Any]:
    """Restore a single file from *branch* into the working tree."""
    if err := _validate_ref_name(branch, "branch name"):
        return {"ok": False, "error": err}
    if not filepath.strip() or filepath.strip().startswith("-"):
        return {"ok": False, "error": "invalid filepath"}
    rc, _, stderr = await _run(
        ["git", "checkout", branch.strip(), "--", filepath.strip()],
        workspace_path,
    )
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


@_serialize_write
async def clean_untracked(workspace_path: str, dry_run: bool = True) -> dict[str, Any]:
    """Remove untracked files and directories.

    When *dry_run* is True (default) runs `git clean -nfd` and returns the
    list of files that *would* be removed without touching anything.
    When False runs `git clean -fd` to actually delete them.
    """
    flag = "-nfd" if dry_run else "-fd"
    rc, out, stderr = await _run(["git", "clean", flag], workspace_path)
    if rc != 0:
        return {"ok": False, "files": [], "error": stderr.strip()}
    lines = [ln.removeprefix("Would remove ").removeprefix("Removing ").strip()
             for ln in out.splitlines() if ln.strip()]
    return {"ok": True, "files": lines, "dry_run": dry_run}


@dataclass
class GitCommitDetail:
    hash: str
    short_hash: str
    author_name: str
    author_email: str
    date: str          # ISO-8601
    message: str
    body: str
    files: list[str]


async def show_commit(workspace_path: str, commit_hash: str) -> dict[str, Any]:
    """Return full detail for a single commit (author, date, message, files)."""
    if err := _validate_commit_hash(commit_hash):
        return {"ok": False, "error": err}
    h = commit_hash.strip()

    # Step 1: commit metadata
    fmt = "%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%b"
    rc, out, _ = await _run(
        ["git", "log", "-1", f"--pretty=format:{fmt}", h],
        workspace_path,
    )
    if rc != 0:
        return {"ok": False, "error": f"commit {h!r} not found"}
    parts = out.split("\x00", 6)
    if len(parts) < 6:
        return {"ok": False, "error": "unexpected git log output"}
    full_hash = parts[0]; short_hash = parts[1]; author_name = parts[2]
    author_email = parts[3]; date = parts[4]; message = parts[5]
    body = parts[6].strip() if len(parts) > 6 else ""

    # Step 2: changed files (--root handles the initial commit which has no parent)
    rc2, out2, _ = await _run(
        ["git", "-c", "core.quotePath=false", "diff-tree", "--root", "--no-commit-id", "-r", "--name-only", h],
        workspace_path,
    )
    files = [ln.strip() for ln in out2.splitlines() if ln.strip()] if rc2 == 0 else []

    return {"ok": True, **asdict(GitCommitDetail(
        hash=full_hash, short_hash=short_hash,
        author_name=author_name, author_email=author_email,
        date=date, message=message, body=body,
        files=files,
    ))}


async def commit_file_diff(workspace_path: str, commit_hash: str, filepath: str) -> dict[str, Any]:
    """Return the diff of *filepath* introduced by a single commit, as parsed hunks.

    Reuses _annotate_diff with empty blame maps (no per-line blame for historical
    commits). Merge commits produce no diff here (plain ``git show``), which the UI
    surfaces as "No changes to display".
    """
    if err := _validate_commit_hash(commit_hash):
        return {"ok": False, "hunks": [], "error": err}
    fp = filepath.strip()
    if not fp or fp.startswith("-"):
        return {"ok": False, "hunks": [], "error": "invalid filepath"}
    # :(top) anchors the pathspec to the repo root — file lists come from
    # diff-tree as root-relative paths, so a cwd inside a subdirectory would
    # otherwise silently match nothing (empty diff, rc=0). literal disables
    # glob interpretation: those paths are literal names, and metacharacters
    # in them (e.g. Next/Nuxt's [id].vue) would match the wrong file.
    rc, out, stderr = await _run(
        ["git", "-c", "core.quotePath=false", "show", "--format=", commit_hash.strip(), "--", f":(top,literal){fp}"],
        workspace_path,
    )
    if rc != 0:
        return {"ok": False, "hunks": [], "error": stderr.strip()}
    return {"ok": True, "hunks": _annotate_diff(out, {}, {})}


def _field_for_prompt(prompt: str) -> str:
    """Classify a git askpass prompt as 'username' or 'password'."""
    return "username" if prompt.strip().lower().startswith("username") else "password"


def _canonical_https_prompt_host(prompt: str) -> str | None:
    """Return a normalized HTTPS prompt destination hostname, or None.

    Git's askpass wording is not an authorization input by itself. It becomes
    one only after this strict parse; prompts without an HTTPS URL (or with an
    unreadable host) deliberately receive no bound credential.
    """
    match = re.search(r"https://[^\s'\"]+", prompt, flags=re.IGNORECASE)
    if not match:
        return None
    try:
        parsed = urlparse(match.group(0))
        if parsed.scheme.lower() != "https" or not parsed.hostname:
            return None
        if unicodedata.normalize("NFKC", parsed.hostname) != parsed.hostname:
            return None
        return parsed.hostname.encode("idna").decode("ascii").lower()
    except (UnicodeError, ValueError):
        return None


def _canonical_credential_host(host: str | None) -> str | None:
    raw = (host or "").strip()
    if raw.startswith("[") and raw.endswith("]"):
        raw = raw[1:-1]
    if not raw:
        return None
    if unicodedata.normalize("NFKC", raw) != raw:
        return None
    try:
        return raw.encode("idna").decode("ascii").lower()
    except UnicodeError:
        return None


def _credential_matches_https_url(credential: dict[str, str], remote_url: str) -> bool:
    """Whether a bound account may answer prompts for *remote_url*.

    This guard is intentionally independent from askpass: Git's configured
    remote is the destination authority for fetch/pull/push, while askpass
    prompts are only a second, fail-closed check at credential disclosure.
    """
    expected = _canonical_credential_host(credential.get("expected_host"))
    if not expected:
        return False
    try:
        parsed = urlparse(remote_url)
        return (
            parsed.scheme.lower() == "https"
            and parsed.hostname is not None
            and _canonical_credential_host(parsed.hostname) == expected
        )
    except (UnicodeError, ValueError):
        return False


async def _configured_remote_url(
    workspace_path: str,
    *,
    remote: str = "",
    push: bool = False,
) -> str | None:
    """Resolve the actual configured URL Git will use, without shelling out."""
    remote_name = remote.strip()
    if not remote_name:
        rc, branch, _ = await _run(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], workspace_path)
        if rc == 0 and branch.strip():
            rc, configured, _ = await _run(
                ["git", "config", "--get", f"branch.{branch.strip()}.remote"], workspace_path
            )
            if rc == 0:
                remote_name = configured.strip()
        if not remote_name and push:
            rc, configured, _ = await _run(["git", "config", "--get", "remote.pushDefault"], workspace_path)
            if rc == 0:
                remote_name = configured.strip()
        if not remote_name:
            remote_name = "origin"
    command = ["git", "remote", "get-url"]
    if push:
        command.append("--push")
    command.append(remote_name)
    rc, url, _ = await _run(command, workspace_path)
    return url.strip() if rc == 0 and url.strip() else None


async def _bound_credential_for_remote(
    workspace_path: str,
    credential: dict[str, str] | None,
    *,
    remote: str = "",
    push: bool = False,
) -> tuple[dict[str, str] | None, bool]:
    """Return ``(credential, rejected_https_destination)`` for a remote.

    A bound PAT is relevant only to HTTPS. SSH, git, file, and absent remotes
    retain Git's ordinary authentication/error behavior; only a concrete HTTPS
    destination that is malformed or bound to another host fails closed.
    """
    if credential is None:
        return None, False
    remote_url = await _configured_remote_url(workspace_path, remote=remote, push=push)
    if not remote_url:
        return None, False
    try:
        is_https = urlparse(remote_url).scheme.lower() == "https"
    except ValueError:
        is_https = False
    if not is_https:
        return None, False
    if _credential_matches_https_url(credential, remote_url):
        return credential, False
    return None, True


def _git_base(credential: dict[str, str] | None) -> list[str]:
    """Base git argv. With a bound credential, disable inherited credential
    helpers (e.g. macOS osxkeychain) so git falls through to our GIT_ASKPASS
    auto-answer for that account, instead of using whatever single credential
    the OS keychain holds for the host."""
    return ["git", "-c", "credential.helper="] if credential else ["git"]


@asynccontextmanager
async def _askpass_env(
    on_credential_request: Callable[[str, str], Awaitable[None]] | None,
    on_credential_settled: Callable[[str, str | None], Awaitable[None]] | None,
    credential: dict[str, str] | None = None,
) -> AsyncIterator[dict[str, str] | None]:
    """Yield the subprocess env for an optional GIT_ASKPASS flow, cleaning up on exit.

    Three modes:
      * *credential* given -- auto-answer askpass prompts from the bound
        account's username/token, with no frontend modal. This is what lets a
        workspace push as its bound account (see gitAccountsStore.ts).
      * else *on_credential_request* given -- forward prompts to the frontend
        modal (the original interactive flow).
      * else -- yield None, so callers get byte-for-byte the same subprocess env
        as before any credential wiring existed.
    """
    if credential is not None:
        async def _auto_answer(request_id: str, prompt: str) -> None:
            field = _field_for_prompt(prompt)
            value = credential.get("username", "") if field == "username" else credential.get("token", "")
            resolve_credential(request_id, value)

        on_request: Callable[[str, str], Awaitable[None]] | None = _auto_answer
        on_settled: Callable[[str, str | None], Awaitable[None]] | None = None
    elif on_credential_request is not None:
        on_request = on_credential_request
        on_settled = on_credential_settled
    else:
        yield None
        return

    askpass_env, cleanup = await create_askpass_context(
        on_request,
        on_settled=on_settled,
        expected_host=_canonical_credential_host(credential.get("expected_host")) if credential is not None else None,
    )
    try:
        yield {**os.environ, **askpass_env}
    finally:
        await cleanup()


@_serialize_write
async def push_set_upstream(
    workspace_path: str,
    branch: str,
    remote: str = "origin",
    *,
    on_credential_request: Callable[[str, str], Awaitable[None]] | None = None,
    on_credential_settled: Callable[[str, str | None], Awaitable[None]] | None = None,
    credential: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Push branch and set upstream tracking (`git push --set-upstream <remote> <branch>`)."""
    if err := _validate_ref_name(branch, "branch name"):
        return {"ok": False, "output": "", "error": err}
    if err := _validate_ref_name(remote, "remote name"):
        return {"ok": False, "output": "", "error": err}
    bound_credential, rejected_destination = await _bound_credential_for_remote(
        workspace_path, credential, remote=remote, push=True
    )
    if rejected_destination:
        return {"ok": False, "output": "", "error": "credential destination rejected"}
    async with _askpass_env(on_credential_request, on_credential_settled, bound_credential) as env:
        rc, out, stderr = await _run_with_timeout(
            _git_base(bound_credential) + ["push", "--set-upstream", remote.strip(), branch.strip()],
            workspace_path,
            timeout=60.0,
            env=env,
        )
    return {"ok": rc == 0, "output": (out + stderr).strip(), "error": stderr.strip() if rc != 0 else ""}


@_serialize_write
async def fetch(
    workspace_path: str,
    *,
    on_credential_request: Callable[[str, str], Awaitable[None]] | None = None,
    on_credential_settled: Callable[[str, str | None], Awaitable[None]] | None = None,
    credential: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Run `git fetch --prune` to update remote-tracking refs."""
    bound_credential, rejected_destination = await _bound_credential_for_remote(workspace_path, credential)
    if rejected_destination:
        return {"ok": False, "output": "", "error": "credential destination rejected"}
    async with _askpass_env(on_credential_request, on_credential_settled, bound_credential) as env:
        rc, out, stderr = await _run_with_timeout(
            _git_base(bound_credential) + ["fetch", "--prune"], workspace_path, timeout=60.0, env=env
        )
    return {"ok": rc == 0, "output": (out + stderr).strip(), "error": stderr.strip() if rc != 0 else ""}


@_serialize_write
async def pull_only(
    workspace_path: str,
    *,
    on_credential_request: Callable[[str, str], Awaitable[None]] | None = None,
    on_credential_settled: Callable[[str, str | None], Awaitable[None]] | None = None,
    credential: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Run `git pull` (fast-forward preferred)."""
    bound_credential, rejected_destination = await _bound_credential_for_remote(workspace_path, credential)
    if rejected_destination:
        return {"ok": False, "output": "", "error": "credential destination rejected"}
    async with _askpass_env(on_credential_request, on_credential_settled, bound_credential) as env:
        rc, out, stderr = await _run_with_timeout(
            _git_base(bound_credential) + ["pull"], workspace_path, timeout=60.0, env=env
        )
    return {"ok": rc == 0, "output": (out + stderr).strip(), "error": stderr.strip() if rc != 0 else ""}


@_serialize_write
async def push_only(
    workspace_path: str,
    remote: str = "",
    branch: str = "",
    *,
    on_credential_request: Callable[[str, str], Awaitable[None]] | None = None,
    on_credential_settled: Callable[[str, str | None], Awaitable[None]] | None = None,
    credential: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Run `git push`, or `git push <remote> <branch>` when a remote is given."""
    cmd = ["push"]
    if remote:
        if err := _validate_ref_name(remote, "remote name"):
            return {"ok": False, "output": "", "error": err}
        cmd.append(remote.strip())
        if branch:
            if err := _validate_ref_name(branch, "branch name"):
                return {"ok": False, "output": "", "error": err}
            cmd.append(branch.strip())
    bound_credential, rejected_destination = await _bound_credential_for_remote(workspace_path, credential, remote=remote, push=True)
    if rejected_destination:
        return {"ok": False, "output": "", "error": "credential destination rejected"}
    async with _askpass_env(on_credential_request, on_credential_settled, bound_credential) as env:
        rc, out, stderr = await _run_with_timeout(_git_base(bound_credential) + cmd, workspace_path, timeout=60.0, env=env)
    return {"ok": rc == 0, "output": (out + stderr).strip(), "error": stderr.strip() if rc != 0 else ""}


@_serialize_write
async def pull_rebase(
    workspace_path: str,
    *,
    on_credential_request: Callable[[str, str], Awaitable[None]] | None = None,
    on_credential_settled: Callable[[str, str | None], Awaitable[None]] | None = None,
    credential: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Run `git pull --rebase` (replay local commits on top of upstream)."""
    bound_credential, rejected_destination = await _bound_credential_for_remote(workspace_path, credential)
    if rejected_destination:
        return {"ok": False, "output": "", "error": "credential destination rejected"}
    async with _askpass_env(on_credential_request, on_credential_settled, bound_credential) as env:
        rc, out, stderr = await _run_with_timeout(
            _git_base(bound_credential) + ["pull", "--rebase"], workspace_path, timeout=60.0, env=env
        )
    return {"ok": rc == 0, "output": (out + stderr).strip(), "error": stderr.strip() if rc != 0 else ""}


@_serialize_write
async def push_force(
    workspace_path: str,
    remote: str = "",
    branch: str = "",
    *,
    on_credential_request: Callable[[str, str], Awaitable[None]] | None = None,
    on_credential_settled: Callable[[str, str | None], Awaitable[None]] | None = None,
    credential: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Run `git push --force-with-lease` (safe force: aborts if remote moved).

    When a remote is given, targets `git push --force-with-lease <remote> <branch>`.
    """
    cmd = ["push", "--force-with-lease"]
    if remote:
        if err := _validate_ref_name(remote, "remote name"):
            return {"ok": False, "output": "", "error": err}
        cmd.append(remote.strip())
        if branch:
            if err := _validate_ref_name(branch, "branch name"):
                return {"ok": False, "output": "", "error": err}
            cmd.append(branch.strip())
    bound_credential, rejected_destination = await _bound_credential_for_remote(workspace_path, credential, remote=remote, push=True)
    if rejected_destination:
        return {"ok": False, "output": "", "error": "credential destination rejected"}
    async with _askpass_env(on_credential_request, on_credential_settled, bound_credential) as env:
        rc, out, stderr = await _run_with_timeout(_git_base(bound_credential) + cmd, workspace_path, timeout=60.0, env=env)
    return {"ok": rc == 0, "output": (out + stderr).strip(), "error": stderr.strip() if rc != 0 else ""}


async def show_file(workspace_path: str, filepath: str, rev: str = "HEAD") -> dict[str, Any]:
    """Return the content of *filepath* at *rev* (default HEAD), like ``git show rev:path``."""
    rc, out, stderr = await _run(["git", "show", f"{rev}:{filepath}"], workspace_path)
    if rc != 0:
        return {"ok": False, "content": "", "error": stderr.strip() or f"{filepath} not found at {rev}"}
    return {"ok": True, "content": out, "error": ""}


async def diff_file(
    workspace_path: str, filepath: str, staged: bool = False, commit: str = ""
) -> dict[str, Any]:
    """Return the diff for a single file (staged, working-tree, or one commit).

    Untracked files are invisible to plain ``git diff``, so for the working-tree
    view we diff them against /dev/null to render the whole file as additions
    (matching how VS Code's "Open Changes" presents a new file).

    With *commit*, returns the raw diff that commit introduced for the file
    (same ``git show`` pathspec handling as ``commit_file_diff``); *staged* is
    ignored. Merge commits produce an empty diff here.
    """
    if commit:
        if err := _validate_commit_hash(commit):
            return {"ok": False, "diff": "", "error": err}
        fp = filepath.strip()
        if not fp or fp.startswith("-"):
            return {"ok": False, "diff": "", "error": "invalid filepath"}
        rc, out, stderr = await _run(
            ["git", "-c", "core.quotePath=false", "show", "--format=", commit.strip(), "--", f":(top,literal){fp}"],
            workspace_path,
        )
        if rc != 0:
            return {"ok": False, "diff": "", "error": stderr.strip()}
        return {"ok": True, "diff": out}
    if not staged:
        tracked_rc, _, _ = await _run(
            ["git", "ls-files", "--error-unmatch", "--", filepath], workspace_path
        )
        if tracked_rc != 0:
            # Untracked: --no-index exits 1 when the files differ, which is the
            # normal case here, so only treat rc >= 2 as a real failure.
            rc, out, stderr = await _run(
                ["git", "-c", "core.quotePath=false", "diff", "--no-index", "--", os.devnull, filepath], workspace_path
            )
            if rc >= 2:
                return {"ok": False, "diff": "", "error": stderr.strip()}
            return {"ok": True, "diff": out}

    args = ["git", "-c", "core.quotePath=false", "diff"]
    if staged:
        args.append("--staged")
    args += ["--", filepath]
    rc, out, stderr = await _run(args, workspace_path)
    if rc != 0:
        return {"ok": False, "diff": "", "error": stderr.strip()}
    return {"ok": True, "diff": out}


async def diff_all(workspace_path: str, staged: bool = False) -> dict[str, Any]:
    """Return the full diff for the entire working tree (or staging area)."""
    args = ["git", "-c", "core.quotePath=false", "diff"]
    if staged:
        args.append("--staged")
    rc, out, stderr = await _run(args, workspace_path)
    if rc != 0:
        return {"ok": False, "diff": "", "error": stderr.strip()}
    return {"ok": True, "diff": out}


@_serialize_write
async def apply_patch(
    workspace_path: str, patch: str, reverse: bool = False, cached: bool = True
) -> dict[str, Any]:
    """Apply *patch* to the index via ``git apply``.

    Used for hunk / line-level staging: the frontend builds a single-hunk (or
    selected-lines) unified diff and we apply it to the staging area.
    ``reverse=True`` unstages (applies the patch with -R). ``cached=False``
    applies to the working tree (used for discarding a hunk via reverse).
    """
    if not patch.strip():
        return {"ok": False, "error": "empty patch"}
    args = ["git", "apply", "--recount", "--unidiff-zero", "--whitespace=nowarn"]
    if cached:
        args.append("--cached")
    if reverse:
        args.append("-R")
    args.append("-")
    # git apply requires a trailing newline on the final line.
    payload = patch if patch.endswith("\n") else patch + "\n"
    rc, out, stderr = await _run_with_input(args, workspace_path, payload)
    if rc != 0:
        return {"ok": False, "error": stderr.strip() or out.strip()}
    return {"ok": True}


def _parse_conflict_files(output: str) -> list[str]:
    """Extract conflicted filenames from git merge output."""
    import re
    files = []
    for line in output.splitlines():
        m = re.search(r"CONFLICT.*Merge conflict in (.+)", line)
        if m:
            files.append(m.group(1).strip())
    return files


@_serialize_write
async def merge_branch(workspace_path: str, branch: str) -> dict[str, Any]:
    """Merge *branch* into the current branch (--no-ff to always create a merge commit)."""
    if err := _validate_ref_name(branch, "branch name"):
        return {"ok": False, "output": "", "error": err, "conflict_files": []}
    rc, out, stderr = await _run(["git", "merge", "--no-ff", "--", branch.strip()], workspace_path)
    output = (out + stderr).strip()
    conflict_files = _parse_conflict_files(output) if rc != 0 else []
    return {
        "ok": rc == 0,
        "output": output,
        "error": stderr.strip() if rc != 0 else "",
        "conflict_files": conflict_files,
    }


@_serialize_write
async def merge_into(workspace_path: str, target: str) -> dict[str, Any]:
    """Switch to *target*, merge current branch into it, stay on *target*.

    On conflict the merge is left in-progress so the caller can decide whether
    to abort or resolve manually.  The original source branch is returned so
    the UI can inform the user of the branch switch that already occurred.
    """
    if err := _validate_branch_name(target):
        return {"ok": False, "output": "", "error": err, "conflict_files": [], "source_branch": ""}
    rc, out, _ = await _run(["git", "rev-parse", "--abbrev-ref", "HEAD"], workspace_path)
    if rc != 0:
        return {"ok": False, "output": "", "error": "could not determine current branch", "conflict_files": [], "source_branch": ""}
    source = out.strip()
    if source == target:
        return {"ok": False, "output": "", "error": "already on target branch", "conflict_files": [], "source_branch": source}
    rc, _, stderr = await _run(["git", "switch", "--", target], workspace_path)
    if rc != 0:
        return {"ok": False, "output": "", "error": stderr.strip(), "conflict_files": [], "source_branch": source}
    rc, out, stderr = await _run(["git", "merge", "--no-ff", "--", source], workspace_path)
    output = (out + stderr).strip()
    conflict_files = _parse_conflict_files(output) if rc != 0 else []
    if rc != 0:
        return {"ok": False, "output": output, "error": stderr.strip(), "conflict_files": conflict_files, "source_branch": source}
    return {"ok": True, "output": output, "error": "", "conflict_files": [], "source_branch": source}


@_serialize_write
async def abort_operation(workspace_path: str, op: str) -> dict[str, Any]:
    """Abort an in-progress merge / rebase / cherry-pick."""
    op = (op or "").strip()
    cmd = {
        "merge": ["git", "merge", "--abort"],
        "rebase": ["git", "rebase", "--abort"],
        "cherry-pick": ["git", "cherry-pick", "--abort"],
    }.get(op)
    if cmd is None:
        return {"ok": False, "error": f"invalid operation: {op}"}
    rc, out, stderr = await _run(cmd, workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


@_serialize_write
async def revert_commit(workspace_path: str, commit_hash: str) -> dict[str, Any]:
    """Create a revert commit for *commit_hash* without interactive editor."""
    if err := _validate_commit_hash(commit_hash):
        return {"ok": False, "error": err}
    rc, out, stderr = await _run(
        ["git", "revert", "--no-edit", commit_hash.strip()], workspace_path
    )
    if rc != 0:
        return {"ok": False, "error": stderr.strip() or out.strip()}
    hash_match = re.search(r"\[.+ ([0-9a-f]{7,})\]", out)
    return {"ok": True, "hash": hash_match.group(1) if hash_match else ""}


@dataclass
class GitRemote:
    name: str
    fetch_url: str
    push_url: str


async def list_remotes(workspace_path: str) -> list[dict[str, Any]]:
    """Return all configured remotes with fetch and push URLs."""
    rc, out, _ = await _run(["git", "remote", "-v"], workspace_path)
    if rc != 0 or not out.strip():
        return []
    seen: dict[str, dict] = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        name, url, kind = parts[0], parts[1], parts[2].strip("()")
        if name not in seen:
            seen[name] = {"name": name, "fetch_url": "", "push_url": ""}
        if kind == "fetch":
            seen[name]["fetch_url"] = url
        elif kind == "push":
            seen[name]["push_url"] = url
    return list(seen.values())


@_serialize_write
async def add_remote(workspace_path: str, name: str, url: str) -> dict[str, Any]:
    """Add a new remote."""
    if err := _validate_ref_name(name, "remote name"):
        return {"ok": False, "error": err}
    url = url.strip()
    if not url:
        return {"ok": False, "error": "url is required"}
    if not _SAFE_GIT_URL.match(url):
        return {"ok": False, "error": "Invalid URL scheme; use https:// or git@host:path"}
    rc, _, stderr = await _run(["git", "remote", "add", name.strip(), url], workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


@_serialize_write
async def connect_to_remote(workspace_path: str, url: str, remote: str = "origin") -> dict[str, Any]:
    """git init → remote add → fetch → checkout, connecting an existing directory to a remote repo."""
    url = url.strip()
    if not url:
        return {"ok": False, "error": "url is required"}
    if not _SAFE_GIT_URL.match(url):
        return {"ok": False, "error": "Invalid URL scheme; use https:// or git@host:path"}

    rc, _, stderr = await _run(["git", "init"], workspace_path)
    if rc != 0:
        return {"ok": False, "error": f"git init failed: {stderr.strip()}"}

    # Add remote (if already exists, update its URL)
    rc, _, _ = await _run(["git", "remote", "add", remote, url.strip()], workspace_path)
    if rc != 0:
        rc2, _, stderr2 = await _run(["git", "remote", "set-url", remote, url.strip()], workspace_path)
        if rc2 != 0:
            return {"ok": False, "error": f"Failed to set remote: {stderr2.strip()}"}

    rc, _, stderr = await _run_with_timeout(["git", "fetch", remote], workspace_path, timeout=60.0)
    if rc != 0:
        return {"ok": False, "error": f"git fetch failed: {stderr.strip()}"}

    # Detect default branch
    rc, out, _ = await _run(["git", "symbolic-ref", f"refs/remotes/{remote}/HEAD"], workspace_path)
    if rc == 0:
        branch = out.strip().split("/")[-1]
    else:
        branch = ""
        for b in ("main", "master"):
            rc2, _, _ = await _run(["git", "rev-parse", "--verify", f"{remote}/{b}"], workspace_path)
            if rc2 == 0:
                branch = b
                break
        if not branch:
            return {"ok": False, "error": "Cannot detect default branch (tried main/master); check the URL"}

    rc, _, stderr = await _run(["git", "checkout", "-B", branch, f"{remote}/{branch}"], workspace_path)
    if rc != 0:
        return {"ok": False, "error": f"git checkout failed: {stderr.strip()}"}

    return {"ok": True, "branch": branch}


@_serialize_write
async def remove_remote(workspace_path: str, name: str) -> dict[str, Any]:
    """Remove a remote by name."""
    if err := _validate_ref_name(name, "remote name"):
        return {"ok": False, "error": err}
    rc, _, stderr = await _run(["git", "remote", "remove", name.strip()], workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


@dataclass
class GitBranch:
    name: str
    is_current: bool
    is_remote: bool
    tracking: str = ""
    has_local: bool = False  # for remote entries: True if a local branch already tracks this ref


async def list_branches(workspace_path: str) -> dict[str, Any]:
    """Return local branches (with tracking info) + all remote branches.

    Remote branches carry ``has_local=True`` when a local branch already
    tracks them, so the UI can distinguish "needs checkout" from "already local".
    """
    rc, out, _ = await _run(
        ["git", "branch", "-vv", "--format=%(refname:short)\t%(HEAD)\t%(upstream:short)"],
        workspace_path,
    )
    if rc != 0:
        return {"ok": False, "branches": [], "current": ""}

    branches: list[dict] = []
    current = ""
    local_trackings: set[str] = set()
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        name, head = parts[0].strip(), parts[1].strip()
        tracking = parts[2].strip() if len(parts) > 2 else ""
        is_cur = head == "*"
        if is_cur:
            current = name
        if tracking:
            local_trackings.add(tracking)
        branches.append(asdict(GitBranch(name=name, is_current=is_cur, is_remote=False, tracking=tracking)))

    # Append ALL remote branches; mark those already checked out locally
    rc2, out2, _ = await _run(
        ["git", "branch", "-r", "--format=%(refname:short)"],
        workspace_path,
    )
    if rc2 == 0:
        for line in out2.splitlines():
            name = line.strip()
            # Skip empty, HEAD pointers, and bare remote names (no slash = not a branch)
            if not name or "/" not in name or name.endswith("/HEAD"):
                continue
            branches.append(asdict(GitBranch(
                name=name, is_current=False, is_remote=True,
                tracking="", has_local=name in local_trackings,
            )))

    return {"ok": True, "branches": branches, "current": current}


@_serialize_write
async def checkout_remote_branch(workspace_path: str, remote_ref: str) -> dict[str, Any]:
    """Create a local tracking branch from a remote ref (e.g. 'origin/feat/x').

    Equivalent to: git checkout --track origin/feat/x
    """
    if err := _validate_ref_name(remote_ref, "remote ref"):
        return {"ok": False, "error": err}
    rc, _, stderr = await _run(
        ["git", "checkout", "--track", remote_ref.strip()],
        workspace_path,
    )
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


def _validate_branch_name(name: str) -> str | None:
    """Return an error string if *name* is not a safe git ref, else None."""
    if not name or not name.strip():
        return "empty branch name"
    if _INVALID_REF_RE.search(name):
        return f"invalid branch name: {name!r}"
    return None


@_serialize_write
async def create_branch(
    workspace_path: str, name: str, switch_to: bool = True, start_point: str = ""
) -> dict[str, Any]:
    """Create (and optionally switch to) a new branch, optionally from *start_point*."""
    if err := _validate_branch_name(name):
        return {"ok": False, "error": err}
    sp = start_point.strip()
    if sp and (err := _validate_ref_name(sp, "start point")):
        return {"ok": False, "error": err}
    if switch_to:
        # git checkout -b does not accept -- before <new_branch>; rely on the leading-dash check above.
        args = ["git", "checkout", "-b", name]
    else:
        args = ["git", "branch", "--", name]
    if sp:
        args.append(sp)
    rc, _, stderr = await _run(args, workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


@_serialize_write
async def switch_branch(workspace_path: str, name: str) -> dict[str, Any]:
    """Switch to an existing local branch."""
    if err := _validate_branch_name(name):
        return {"ok": False, "error": err}
    rc, _, stderr = await _run(["git", "switch", "--", name], workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


@_serialize_write
async def checkout_commit(workspace_path: str, commit_hash: str) -> dict[str, Any]:
    """Check out a commit in detached-HEAD state."""
    if err := _validate_commit_hash(commit_hash):
        return {"ok": False, "error": err}
    rc, _, stderr = await _run(["git", "checkout", "--detach", commit_hash.strip()], workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


_RESET_MODES = frozenset({"soft", "mixed", "hard"})


@_serialize_write
async def reset_to_commit(workspace_path: str, commit_hash: str, mode: str) -> dict[str, Any]:
    """Move the current branch to *commit_hash* via ``git reset --<mode>``.

    *mode* is restricted to soft/mixed/hard so the value is never a raw flag:
    soft keeps index and worktree, mixed (git's default) resets the index only,
    hard discards both.
    """
    if mode not in _RESET_MODES:
        return {"ok": False, "error": "invalid reset mode (expected soft/mixed/hard)"}
    if err := _validate_commit_hash(commit_hash):
        return {"ok": False, "error": err}
    rc, _, stderr = await _run(
        ["git", "reset", f"--{mode}", commit_hash.strip()], workspace_path
    )
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


@_serialize_write
async def delete_branch(workspace_path: str, name: str, force: bool = False) -> dict[str, Any]:
    """Delete a local branch (-d or -D)."""
    if err := _validate_branch_name(name):
        return {"ok": False, "error": err}
    flag = "-D" if force else "-d"
    rc, _, stderr = await _run(["git", "branch", flag, "--", name], workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


@dataclass
class GitStashEntry:
    index: int
    ref: str      # e.g. stash@{0}
    message: str


async def stash_list(workspace_path: str) -> list[dict[str, Any]]:
    """Return all stash entries."""
    rc, out, _ = await _run(["git", "stash", "list", "--format=%gd\t%s"], workspace_path)
    if rc != 0 or not out.strip():
        return []
    entries: list[dict] = []
    for i, line in enumerate(out.splitlines()):
        parts = line.split("\t", 1)
        ref = parts[0].strip()
        message = parts[1].strip() if len(parts) > 1 else ""
        entries.append(asdict(GitStashEntry(index=i, ref=ref, message=message)))
    return entries


@_serialize_write
async def stash_push(
    workspace_path: str, message: str = "", paths: list[str] | None = None
) -> dict[str, Any]:
    """Stash local changes (tracked + untracked).

    With no *paths* the whole working tree is stashed; pass *paths* to stash
    only those pathspecs (``git stash push -- <paths>``).
    """
    args = ["git", "stash", "push", "--include-untracked"]
    if message.strip():
        args += ["-m", message.strip()]
    if paths:
        args += ["--", *paths]
    rc, out, stderr = await _run(args, workspace_path)
    return {"ok": rc == 0, "output": (out + stderr).strip(), "error": stderr.strip() if rc != 0 else ""}


@_serialize_write
async def stash_pop(workspace_path: str, index: int = 0) -> dict[str, Any]:
    """Apply and remove stash@{index}."""
    rc, out, stderr = await _run(["git", "stash", "pop", f"stash@{{{index}}}"], workspace_path)
    return {"ok": rc == 0, "output": (out + stderr).strip(), "error": stderr.strip() if rc != 0 else ""}


@_serialize_write
async def stash_apply(workspace_path: str, index: int = 0) -> dict[str, Any]:
    """Apply stash@{index} but keep it in the stash list (unlike pop)."""
    rc, out, stderr = await _run(["git", "stash", "apply", f"stash@{{{index}}}"], workspace_path)
    return {"ok": rc == 0, "output": (out + stderr).strip(), "error": stderr.strip() if rc != 0 else ""}


@_serialize_write
async def stash_drop(workspace_path: str, index: int) -> dict[str, Any]:
    """Drop stash@{index} without applying."""
    rc, _, stderr = await _run(["git", "stash", "drop", f"stash@{{{index}}}"], workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


@_serialize_write
async def amend_commit(workspace_path: str, message: str = "") -> dict[str, Any]:
    """Amend the last commit. If *message* is empty, keep the original message."""
    if message.strip():
        args = ["git", "commit", "--amend", "-m", message.strip()]
    else:
        args = ["git", "commit", "--amend", "--no-edit"]
    rc, out, stderr = await _run(args, workspace_path)
    if rc != 0:
        return {"ok": False, "error": stderr.strip() or out.strip()}
    hash_match = re.search(r"\[.+ ([0-9a-f]{7,})\]", out)
    return {"ok": True, "hash": hash_match.group(1) if hash_match else ""}


@_serialize_write
async def undo_last_commit(workspace_path: str) -> dict[str, Any]:
    """Soft-reset HEAD~1 — files go back to staged, commit is removed."""
    rc, _, stderr = await _run(["git", "reset", "--soft", "HEAD~1"], workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


@_serialize_write
async def stage_files(workspace_path: str, files: list[str]) -> dict[str, Any]:
    if not files:
        return {"ok": True}
    rc, _, stderr = await _run(["git", "add", "--"] + files, workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


async def _run_unstage(workspace_path: str, files: list[str]) -> tuple[int, str]:
    """Drop *files* from the index, keeping the working tree. Returns (rc, stderr)."""
    # Before the first commit there is no HEAD, so `git restore --staged` fails
    # with "could not resolve HEAD". In that case unstage by removing the entries
    # from the index (the working-tree files are kept).
    head_rc, _, _ = await _run(["git", "rev-parse", "--verify", "HEAD"], workspace_path)
    if head_rc == 0:
        rc, _, stderr = await _run(["git", "restore", "--staged", "--"] + files, workspace_path)
    else:
        # -f is required: `git rm --cached` otherwise refuses files whose staged
        # content differs from the working tree (e.g. a log file the app keeps
        # writing to). --cached keeps the working-tree file; we only drop the
        # index entry, so forcing is safe here.
        rc, _, stderr = await _run(["git", "rm", "--cached", "-f", "--quiet", "--"] + files, workspace_path)
    return rc, stderr.strip()


@_serialize_write
async def unstage_files(workspace_path: str, files: list[str]) -> dict[str, Any]:
    if not files:
        return {"ok": True}
    rc, stderr = await _run_unstage(workspace_path, files)
    if rc == 0:
        return {"ok": True, "error": ""}
    # The UI acts on a status snapshot, so a path can already be out of the index
    # when the click lands (a parallel agent ran git, or the row was untracked all
    # along). git rejects the WHOLE batch for one such path — the genuinely staged
    # files stay staged — with "pathspec ... did not match any file(s) known to git".
    # Retry with only the paths that are staged right now; for the dropped ones the
    # requested end state already holds. Everything that succeeded before still runs
    # unfiltered on the first attempt, so directory/glob pathspecs keep working.
    if "did not match any file" not in stderr:
        return {"ok": False, "error": stderr}
    status = await get_status(workspace_path)
    # A failed or truncated read cannot say which paths are still staged.
    if not isinstance(status.get("is_git_repo"), bool) or status.get("truncated"):
        return {"ok": False, "error": stderr}
    staged_paths = {f["path"] for f in status.get("staged", [])}
    remaining = [f for f in files if f in staged_paths]
    if not remaining:
        return {"ok": True, "error": ""}
    if len(remaining) == len(files):
        return {"ok": False, "error": stderr}  # nothing stale to drop — the error is real
    rc, stderr = await _run_unstage(workspace_path, remaining)
    return {"ok": rc == 0, "error": stderr if rc != 0 else ""}


@_serialize_write
async def stage_all(workspace_path: str) -> dict[str, Any]:
    rc, _, stderr = await _run(["git", "add", "-A"], workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


async def _run_with_timeout(
    args: list[str], cwd: str, timeout: float = 30.0, env: dict[str, str] | None = None
) -> tuple[int, str, str]:
    rc, stdout, stderr = await run_allowlisted_text(args, cwd, timeout=timeout, env=env)
    return rc, stdout, stderr


async def check_staged(workspace_path: str) -> dict[str, Any]:
    """Lint staged files with available tools. ok=False only when lint errors are found.
    Tool unavailability is silently skipped so missing linters never block auto-commit."""
    if not workspace_path:
        return {"ok": True, "error_count": 0, "summary": ""}

    # core.quotePath=false keeps non-ASCII filenames raw (not octal-escaped) so
    # their real suffix survives for the eslint/ruff extension filters below.
    rc, stdout, _ = await _run(
        ["git", "-c", "core.quotePath=false", "diff", "--cached", "--name-only"],
        workspace_path,
    )
    if rc != 0:
        return {"ok": True, "error_count": 0, "summary": ""}

    staged = [f.strip() for f in stdout.splitlines() if f.strip()]
    if not staged:
        return {"ok": True, "error_count": 0, "summary": ""}

    ws = Path(workspace_path)
    findings: list[str] = []

    # ── ESLint ────────────────────────────────────────────────────────────────
    ts_exts = {".ts", ".tsx", ".js", ".jsx", ".vue"}
    ts_files = [f for f in staged if Path(f).suffix in ts_exts]
    eslint_bin = ws / "node_modules" / ".bin" / "eslint"
    if ts_files and eslint_bin.exists():
        rc, out, _ = await _run_with_timeout(
            [str(eslint_bin), "--max-warnings", "0", "--format", "compact", *ts_files],
            workspace_path,
        )
        # rc=1 → lint errors; rc=2 → config/internal error (skip)
        if rc == 1 and out.strip():
            findings.append(f"ESLint: {out.strip()[:400]}")

    # ── Ruff ─────────────────────────────────────────────────────────────────
    py_files = [f for f in staged if f.endswith(".py")]
    if py_files:
        venv_ruff = ws / ".venv" / "bin" / "ruff"
        ruff_bin = str(venv_ruff) if venv_ruff.exists() else shutil.which("ruff")
        if ruff_bin:
            rc, out, _ = await _run_with_timeout(
                [ruff_bin, "check", "--output-format", "concise", *py_files],
                workspace_path,
            )
            if rc == 1 and out.strip():
                findings.append(f"Ruff: {out.strip()[:400]}")

    if findings:
        return {"ok": False, "error_count": len(findings), "summary": "\n".join(findings)}
    return {"ok": True, "error_count": 0, "summary": ""}


@_serialize_write
async def commit(workspace_path: str, message: str, all: bool = False) -> dict[str, Any]:
    if not message.strip():
        return {"ok": False, "error": "empty commit message"}
    # all=True: with nothing staged, commit everything — stage all changes first
    # (git add -A) so untracked files are included too, then commit.
    if all:
        rc, out, stderr = await _run(["git", "add", "-A"], workspace_path)
        if rc != 0:
            return {"ok": False, "error": stderr.strip() or out.strip()}
    rc, out, stderr = await _run(["git", "commit", "-m", message], workspace_path)
    if rc != 0:
        return {"ok": False, "error": stderr.strip() or out.strip()}
    # Extract new commit hash from "git commit" output
    hash_match = re.search(r"\[.+ ([0-9a-f]{7,})\]", out)
    return {"ok": True, "hash": hash_match.group(1) if hash_match else ""}


@_serialize_write
async def sync(
    workspace_path: str,
    *,
    on_credential_request: Callable[[str, str], Awaitable[None]] | None = None,
    on_credential_settled: Callable[[str, str | None], Awaitable[None]] | None = None,
    credential: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Pull (rebase) then push.  Returns stdout/stderr for both steps."""
    pull_credential, pull_rejected = await _bound_credential_for_remote(workspace_path, credential)
    push_credential, push_rejected = await _bound_credential_for_remote(workspace_path, credential, push=True)
    if pull_rejected or push_rejected:
        return asdict(GitSyncResult(ok=False, error="credential destination rejected"))
    async with _askpass_env(on_credential_request, on_credential_settled, pull_credential) as env:
        pull_rc, pull_out, pull_err = await _run_with_timeout(
            _git_base(pull_credential) + ["pull", "--rebase"], workspace_path, timeout=60.0, env=env
        )
        pull_output = (pull_out + pull_err).strip()
        if pull_rc != 0:
            return asdict(GitSyncResult(ok=False, pull_output=pull_output, error="pull failed"))

    async with _askpass_env(on_credential_request, on_credential_settled, push_credential) as env:
        push_rc, push_out, push_err = await _run_with_timeout(
            _git_base(push_credential) + ["push"], workspace_path, timeout=60.0, env=env
        )
        push_output = (push_out + push_err).strip()
        if push_rc != 0:
            return asdict(GitSyncResult(ok=False, pull_output=pull_output, push_output=push_output, error="push failed"))

        return asdict(GitSyncResult(ok=True, pull_output=pull_output, push_output=push_output))


async def get_staged_diff(workspace_path: str) -> str:
    """Return the staged diff, truncated to _MAX_DIFF_CHARS."""
    rc, out, _ = await _run(["git", "diff", "--staged"], workspace_path)
    if rc != 0 or not out.strip():
        return ""
    return out[:_MAX_DIFF_CHARS]


async def get_working_diff(workspace_path: str) -> str:
    """Return the working-tree diff (unstaged tracked changes + untracked files).

    Untracked files are invisible to plain ``git diff``, so each is diffed against
    /dev/null to render the whole file as additions (matching ``diff_file``). Used
    as a fallback for commit-message generation when nothing is staged.
    """
    parts: list[str] = []
    rc, out, _ = await _run(["git", "-c", "core.quotePath=false", "diff"], workspace_path)
    if rc == 0 and out.strip():
        parts.append(out)

    rc, out, _ = await _run(["git", "ls-files", "--others", "--exclude-standard"], workspace_path)
    if rc == 0:
        for filepath in out.splitlines():
            filepath = filepath.strip()
            if not filepath:
                continue
            # --no-index exits 1 when the files differ (the normal case here), so
            # only treat rc >= 2 as a real failure.
            drc, dout, _ = await _run(
                ["git", "-c", "core.quotePath=false", "diff", "--no-index", "--", os.devnull, filepath],
                workspace_path,
            )
            if drc < 2 and dout.strip():
                parts.append(dout)
            if sum(len(p) for p in parts) >= _MAX_DIFF_CHARS:
                break

    return "\n".join(parts)[:_MAX_DIFF_CHARS]


_NODE_GITIGNORE = """\
node_modules/
dist/
.env
.env.local
*.log
.DS_Store
"""

_PYTHON_GITIGNORE = """\
__pycache__/
*.pyc
*.pyo
.venv/
venv/
dist/
build/
*.egg-info/
.env
.DS_Store
"""

_GENERIC_GITIGNORE = """\
.DS_Store
*.log
.env
.env.local
"""


def _detect_gitignore_template(workspace_path: str) -> str:
    """Return an appropriate .gitignore based on project files present.

    Full-stack projects (e.g. a Node frontend + Python backend) match more than
    one stack, so the templates are composed rather than picked exclusively —
    otherwise the second stack's artifacts (e.g. __pycache__/) leak into git.
    """
    root = Path(workspace_path)
    parts: list[str] = []
    if (root / "package.json").exists():
        parts.append(_NODE_GITIGNORE)
    if any(root.glob("*.py")) or (root / "pyproject.toml").exists() or (root / "requirements.txt").exists():
        parts.append(_PYTHON_GITIGNORE)
    return "\n".join(parts) if parts else _GENERIC_GITIGNORE


@_serialize_write
async def init_repo(workspace_path: str, create_gitignore: bool = True) -> dict[str, Any]:
    """Run `git init` in *workspace_path*.

    Optionally writes a starter .gitignore (auto-detected from project type)
    unless one already exists.  Returns ``{"ok": bool, "error": str}``.
    """
    if not workspace_path or not Path(workspace_path).is_dir():
        return {"ok": False, "error": "invalid workspace path"}

    rc, out, stderr = await _run(["git", "init"], workspace_path)
    if rc != 0:
        return {"ok": False, "error": stderr.strip() or out.strip()}

    gitignore_created = False
    if create_gitignore:
        gi_path = Path(workspace_path) / ".gitignore"
        if not gi_path.exists():
            gi_path.write_text(_detect_gitignore_template(workspace_path), encoding="utf-8")
            gitignore_created = True

    return {"ok": True, "gitignore_created": gitignore_created}


async def clone_repo(
    url: str,
    target_dir: str,
    *,
    on_credential_request: Callable[[str, str], Awaitable[None]] | None = None,
    on_credential_settled: Callable[[str, str | None], Awaitable[None]] | None = None,
    credential: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Clone *url* into *target_dir*.

    Returns ``{"ok": bool, "path": str, "error": str}`` where ``path`` is the
    cloned working directory on success (so the UI can open it as a workspace).
    """
    url = (url or "").strip()
    target = (target_dir or "").strip()
    if not url or url.startswith("-"):
        return {"ok": False, "path": "", "error": "invalid repository URL"}
    if credential is not None and not _credential_matches_https_url(credential, url):
        return {"ok": False, "path": "", "error": "credential destination rejected"}
    if is_remote_helper_form(url):
        # Block ext::/fd:: remote-helper URLs that can run arbitrary commands,
        # while still permitting http(s)/ssh/git@ URLs and local paths.
        return {"ok": False, "path": "", "error": "unsupported repository URL scheme"}
    if not target:
        return {"ok": False, "path": "", "error": "target directory is required"}
    dest = Path(target)
    if dest.exists() and any(dest.iterdir()):
        return {"ok": False, "path": "", "error": "target directory is not empty"}
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Run from the parent dir so a relative/new target works; pass paths via `--`.
    # Uses _run_with_timeout (not _run) so a GIT_ASKPASS env can be injected for
    # private repos, same as the other network-writing git operations below.
    async with _askpass_env(on_credential_request, on_credential_settled, credential) as env:
        rc, out, stderr = await _run_with_timeout(
            _git_base(credential) + ["clone", "--", url, str(dest)],
            str(dest.parent),
            timeout=60.0,
            env=env,
        )
    if rc != 0:
        return {"ok": False, "path": "", "error": stderr.strip() or out.strip()}
    return {"ok": True, "path": str(dest)}


async def _resolve_git_dir(workspace_path: str) -> Path | None:
    """Absolute path to the repo's .git dir, or None if not a repo."""
    rc, out, _ = await _run(["git", "rev-parse", "--git-dir"], workspace_path)
    if rc != 0 or not out.strip():
        return None
    p = Path(out.strip())
    return p if p.is_absolute() else Path(workspace_path) / p


async def _resolve_global_excludes(workspace_path: str) -> Path:
    """Path to git's global excludes file (core.excludesFile), or its default.

    Default per git: $XDG_CONFIG_HOME/git/ignore, falling back to
    ~/.config/git/ignore.
    """
    rc, out, _ = await _run(["git", "config", "--global", "core.excludesFile"], workspace_path)
    if rc == 0 and out.strip():
        return Path(os.path.expanduser(out.strip()))
    xdg = os.environ.get("XDG_CONFIG_HOME")
    base = Path(xdg) if xdg else Path.home() / ".config"
    return base / "git" / "ignore"


def _append_ignore_pattern(file_path: Path, pattern: str) -> bool:
    """Append *pattern* to *file_path* (creating it + parents) unless already
    present. Returns True when a line was actually written."""
    existing = file_path.read_text(encoding="utf-8") if file_path.exists() else ""
    if pattern in {ln.strip() for ln in existing.splitlines()}:
        return False
    file_path.parent.mkdir(parents=True, exist_ok=True)
    prefix = "" if (not existing or existing.endswith("\n")) else "\n"
    new_content = (existing + prefix + pattern + "\n").encode("utf-8")
    tmp = file_path.with_suffix(file_path.suffix + ".tmp")
    try:
        tmp.write_bytes(new_content)
        os.replace(tmp, file_path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    return True


@_serialize_write
async def add_to_gitignore(
    workspace_path: str,
    pattern: str,
    target: str = "project",
    untrack: bool = True,
) -> dict[str, Any]:
    """Add *pattern* to an ignore file and (by default) untrack matching files.

    *target* selects which of git's four ignore sources to write:
      - ``project`` → ``<workspace>/.gitignore`` (committed, repo-wide)
      - ``nested``  → ``.gitignore`` inside the pattern's own directory
      - ``local``   → ``.git/info/exclude`` (repo-local, not committed)
      - ``global``  → ``core.excludesFile`` (all repos for this user)

    A freshly-added rule has no effect on files already in the index, so unless
    *untrack* is False any tracked path matching *pattern* is removed from the
    index with ``git rm --cached`` (the file stays on disk). This is what makes
    "Add to .gitignore" actually hide an already-committed file.

    Returns ``{"ok", "target_file", "written", "untracked": [paths]}``.
    """
    pattern = (pattern or "").strip()
    if not pattern:
        return {"ok": False, "error": "pattern is required"}
    if not workspace_path or not Path(workspace_path).is_dir():
        return {"ok": False, "error": "invalid workspace path"}

    write_pattern = pattern
    if target == "project":
        dest = Path(workspace_path) / ".gitignore"
    elif target == "nested":
        rel = pattern.rstrip("/")
        if Path(rel).is_absolute() or ".." in Path(rel).parts:
            return {"ok": False, "error": "pattern escapes workspace"}
        ws_real = Path(workspace_path).resolve()
        dest = ((Path(workspace_path) / rel).parent / ".gitignore").resolve()
        try:
            dest.relative_to(ws_real)
        except ValueError:
            return {"ok": False, "error": "pattern escapes workspace"}
        write_pattern = Path(rel).name + ("/" if pattern.endswith("/") else "")
    elif target == "local":
        git_dir = await _resolve_git_dir(workspace_path)
        if git_dir is None:
            return {"ok": False, "error": "not a git repository"}
        dest = git_dir / "info" / "exclude"
    elif target == "global":
        dest = await _resolve_global_excludes(workspace_path)
    else:
        return {"ok": False, "error": f"unknown target: {target}"}

    written = _append_ignore_pattern(dest, write_pattern)

    untracked: list[str] = []
    if untrack:
        path = pattern.rstrip("/")
        rc, out, _ = await _run(["git", "ls-files", "-z", "--", path], workspace_path)
        if rc == 0 and out:
            tracked = [p for p in out.split("\0") if p]
            if tracked:
                # -f: tracked files whose staged content differs from disk/HEAD
                # otherwise make `git rm --cached` refuse.
                rm_rc, _, _ = await _run(
                    ["git", "rm", "--cached", "-r", "-f", "--quiet", "--", path],
                    workspace_path,
                )
                if rm_rc == 0:
                    untracked = tracked

    return {"ok": True, "target_file": str(dest), "written": written, "untracked": untracked}


async def check_ignore(workspace_path: str, filepath: str) -> dict[str, Any]:
    """Explain why *filepath* is (or isn't) ignored — git's own debug tool.

    Runs ``git check-ignore -v --no-index`` so the matching rule is reported
    even for a path that is currently tracked (``--no-index`` evaluates rules
    irrespective of the index). Also reports whether the path is tracked, since
    a tracked file keeps showing up despite a matching rule.

    Returns ``{"ok", "ignored", "tracked", "source", "line", "pattern"}``.
    """
    filepath = (filepath or "").strip()
    if not filepath:
        return {"ok": False, "error": "filepath is required"}
    if not workspace_path or not Path(workspace_path).is_dir():
        return {"ok": False, "error": "invalid workspace path"}

    ls_rc, ls_out, _ = await _run(["git", "ls-files", "--", filepath], workspace_path)
    tracked = ls_rc == 0 and bool(ls_out.strip())

    rc, out, _ = await _run(
        ["git", "check-ignore", "-v", "--no-index", "--", filepath], workspace_path
    )
    if rc == 0 and out.strip():
        first = out.strip().splitlines()[0]
        # "<source>:<line>:<pattern>\t<path>"
        m = re.match(r"^(.*?):(\d+):(.*?)\t", first)
        if m:
            return {
                "ok": True, "ignored": True, "tracked": tracked,
                "source": m.group(1), "line": int(m.group(2)), "pattern": m.group(3),
            }
        return {"ok": True, "ignored": True, "tracked": tracked, "source": "", "line": 0, "pattern": ""}
    # rc == 1: not ignored. rc == 128: error (treat as not ignored).
    return {"ok": True, "ignored": False, "tracked": tracked, "source": "", "line": 0, "pattern": ""}


async def get_recent_commit_messages(workspace_path: str, n: int = 5) -> dict[str, list[str]]:
    """Return recent commit subjects for commit-message *style* reference.

    ``repository``: the last *n* subjects in HEAD's history. ``user``: the last
    *n* subjects authored by the configured ``user.name`` (empty when the name
    can't be resolved). Subjects only (first line), matching Copilot. A repo
    with no commits yet yields two empty lists (``git log`` exits non-zero).
    """
    if not workspace_path or not Path(workspace_path).is_dir():
        return {"repository": [], "user": []}

    rc, out, _ = await _run(["git", "log", f"-n{n}", "--pretty=format:%s"], workspace_path)
    repository = [ln for ln in out.splitlines() if ln.strip()] if rc == 0 else []

    user: list[str] = []
    rc, name_out, _ = await _run(["git", "config", "user.name"], workspace_path)
    author = name_out.strip()
    if rc == 0 and author:
        rc, out, _ = await _run(
            ["git", "log", f"-n{n}", f"--author={author}", "--pretty=format:%s"],
            workspace_path,
        )
        if rc == 0:
            user = [ln for ln in out.splitlines() if ln.strip()]
    return {"repository": repository, "user": user}


def _parse_numstat(output: str) -> dict[str, dict[str, int | bool]]:
    stats: dict[str, dict[str, int | bool]] = {}
    for line in output.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        added_raw, deleted_raw, path = parts[0], parts[1], parts[-1]
        binary = added_raw == "-" or deleted_raw == "-"
        added = 0 if binary else int(added_raw or "0")
        deleted = 0 if binary else int(deleted_raw or "0")
        stats[path] = {"added": added, "deleted": deleted, "binary": binary}
    return stats


async def _commit_diff_summary(
    workspace_path: str,
    entries: list[tuple[str, str, bool]],
    staged: bool,
) -> dict[str, Any]:
    if staged:
        base_args = ["git", "-c", "core.quotePath=false", "diff", "--staged"]
    else:
        base_args = ["git", "-c", "core.quotePath=false", "diff"]

    rc, numstat_out, _ = await _run([*base_args, "--numstat"], workspace_path)
    numstat = _parse_numstat(numstat_out) if rc == 0 else {}

    rc, stat_out, _ = await _run([*base_args, "--stat"], workspace_path)
    diff_stat = stat_out.strip() if rc == 0 else ""

    changes: list[dict[str, Any]] = []
    total_added = 0
    total_deleted = 0
    has_binary = False
    max_untracked_bytes = 0
    for path, status, _is_staged in entries:
        item = numstat.get(path, {"added": 0, "deleted": 0, "binary": False})
        added = int(item["added"])
        deleted = int(item["deleted"])
        binary = bool(item["binary"])
        size_bytes = 0
        if status == "?":
            try:
                full_path = (Path(workspace_path) / path).resolve()
                if full_path.is_file():
                    size_bytes = full_path.stat().st_size
                    max_untracked_bytes = max(max_untracked_bytes, size_bytes)
            except OSError:
                size_bytes = 0
        total_added += added
        total_deleted += deleted
        has_binary = has_binary or binary
        changes.append({
            "path": path,
            "status": status,
            "added": added,
            "deleted": deleted,
            "binary": binary,
            "size_bytes": size_bytes,
        })

    return {
        "file_count": len(entries),
        "added": total_added,
        "deleted": total_deleted,
        "line_count": total_added + total_deleted,
        "has_binary": has_binary,
        "max_untracked_bytes": max_untracked_bytes,
        "diff_stat": diff_stat,
        "changes": changes,
    }


async def get_commit_context(workspace_path: str) -> dict[str, Any]:
    """Collect per-file context for adaptive commit-message generation.

    Mirrors VS Code/Cursor: uses staged files when anything is staged, else the
    unstaged tracked changes + untracked files. For each file it returns the
    path, the ``original`` HEAD content (empty for added/untracked files or a
    repo with no HEAD yet), and the file's unified ``diff``.
    """
    status = await get_status(workspace_path)
    if not isinstance(status.get("is_git_repo"), bool):
        return {"ok": False, "error": status.get("error") or "git status failed", "changes": []}
    staged = status.get("staged") or []
    if staged:
        entries = [(e["path"], e["status"], True) for e in staged]
    else:
        unstaged = status.get("unstaged") or []
        untracked = status.get("untracked") or []
        entries = [(e["path"], e["status"], False) for e in unstaged]
        entries += [(e["path"], "?", False) for e in untracked]

    summary = await _commit_diff_summary(workspace_path, entries, bool(staged))
    summary_reason = ""
    if summary["file_count"] > _COMMIT_SUMMARY_FILE_THRESHOLD:
        summary_reason = f"changed file count exceeds {_COMMIT_SUMMARY_FILE_THRESHOLD}"
    elif summary["line_count"] > _COMMIT_SUMMARY_LINE_THRESHOLD:
        summary_reason = f"changed line count exceeds {_COMMIT_SUMMARY_LINE_THRESHOLD}"
    elif summary["max_untracked_bytes"] > _COMMIT_SUMMARY_UNTRACKED_BYTES_THRESHOLD:
        summary_reason = f"untracked file size exceeds {_COMMIT_SUMMARY_UNTRACKED_BYTES_THRESHOLD} bytes"

    if summary_reason:
        return {
            "repo_name": Path(workspace_path).name,
            "branch": status.get("branch", ""),
            "changes": summary["changes"],
            "staged": bool(staged),
            "mode": "summary",
            "summary": {
                "reason": summary_reason,
                "file_count": summary["file_count"],
                "added": summary["added"],
                "deleted": summary["deleted"],
                "line_count": summary["line_count"],
                "has_binary": summary["has_binary"],
                "max_untracked_bytes": summary["max_untracked_bytes"],
                "diff_stat": summary["diff_stat"],
            },
        }

    changes: list[dict[str, str]] = []
    for path, st, is_staged in entries:
        # original: the HEAD version of the file. Empty for added/untracked
        # files and for a repo without a HEAD commit (git show exits non-zero).
        original = ""
        if st not in ("A", "?"):
            rc, out, _ = await _run(["git", "show", f"HEAD:{path}"], workspace_path)
            if rc == 0:
                original = out

        if is_staged:
            rc, dout, _ = await _run(
                ["git", "-c", "core.quotePath=false", "diff", "--staged", "--", path],
                workspace_path,
            )
            diff = dout if rc == 0 else ""
        elif st == "?":
            # Untracked: --no-index exits 1 when files differ (the normal case),
            # so only rc >= 2 is a real failure. Renders the whole file as adds.
            drc, dout, _ = await _run(
                ["git", "-c", "core.quotePath=false", "diff", "--no-index", "--", os.devnull, path],
                workspace_path,
            )
            diff = dout if drc < 2 else ""
        else:
            rc, dout, _ = await _run(
                ["git", "-c", "core.quotePath=false", "diff", "--", path],
                workspace_path,
            )
            diff = dout if rc == 0 else ""

        changes.append({"path": path, "original": original, "diff": diff})

    return {
        "repo_name": Path(workspace_path).name,
        "branch": status.get("branch", ""),
        "changes": changes,
        "staged": bool(staged),
        "mode": "full",
    }


# Total end-to-end budget for generate_commit_message (context gathering + LLM
# call). The frontend's git.generate_message request timeout (useGit.ts) must
# stay comfortably above this so it never fires while the backend is still
# within its own deadline.
_GENERATE_MESSAGE_BUDGET_S = 60.0


async def generate_commit_message(
    workspace_path: str,
    ollama_url: str,
    model: str = "llama3.2",
    attempt_count: int = 0,
    *,
    settings: dict | None = None,
) -> dict[str, Any]:
    """Generate a commit message that adapts to the repo's existing style.

    Instead of forcing Conventional Commits, this gathers per-file diffs +
    original code and recent commit subjects, then asks Ollama to follow the
    repository's established conventions (matching Cursor's adaptive behaviour).
    Mirrors VS Code/Cursor: targets the staged diff when anything is staged,
    otherwise the whole working tree. *attempt_count* raises the temperature on
    retries to escape a repeated bad answer (Copilot does the same).

    If *settings* contains ``provider == "anthropic"``, the Anthropic API is
    used (non-streaming) instead of Ollama.
    """
    start = time.monotonic()
    context = await get_commit_context(workspace_path)
    if context.get("ok") is False:
        return {"ok": False, "error": context["error"], "message": ""}
    if not context["changes"]:
        return {"ok": False, "error": "no changes", "message": ""}

    recent = await get_recent_commit_messages(workspace_path)
    per_file_budget = _MAX_DIFF_CHARS // max(1, len(context["changes"]))
    system = commit_message_prompt.SYSTEM_PROMPT
    prompt = commit_message_prompt.build_user_prompt(context, recent, per_file_budget)
    temperature = min(0.2 * (1 + attempt_count), 1.0)

    # Context gathering above can itself take several seconds; shrink the LLM
    # call's timeout by however much of the shared budget it already used, so
    # the two phases combined never exceed a single deadline.
    remaining = max(5.0, _GENERATE_MESSAGE_BUDGET_S - (time.monotonic() - start))

    provider = (settings or {}).get("provider", "ollama")

    if provider == "anthropic":
        try:
            import anthropic as _anthropic  # type: ignore
        except ImportError as exc:
            return {"ok": False, "error": "anthropic package not installed: " + str(exc), "message": ""}
        api_key = (settings or {}).get("anthropic_api_key", "").strip()
        anthropic_model = (settings or {}).get("anthropic_model", model)
        try:
            # Held in async with, like the Ollama client below: AsyncAnthropic
            # owns an httpx connection pool and an SSL context, and auto-commit
            # calls this once a minute. Without the context manager each call
            # left one behind for the garbage collector, which cannot close an
            # async transport reliably.
            async with _anthropic.AsyncAnthropic(api_key=api_key or None) as client:
                response = await client.messages.create(
                    model=anthropic_model,
                    max_tokens=256,
                    system=system,
                    messages=[{"role": "user", "content": prompt}],
                    temperature=temperature,
                    timeout=remaining,
                )
                raw = ""
                for block in response.content:
                    if getattr(block, "type", None) == "text":
                        raw += block.text
                message = commit_message_prompt.parse_commit_message(raw)
                if not message:
                    return {"ok": False, "error": "empty response from Anthropic", "message": ""}
                return {"ok": True, "message": message}
        except Exception as exc:
            log.warning("generate_commit_message (anthropic) failed: %s", exc)
            return {"ok": False, "error": str(exc), "message": ""}

    # Default: Ollama path
    try:
        async with httpx.AsyncClient(
            base_url=ollama_url.rstrip("/"), timeout=remaining, verify=await default_ssl_context()
        ) as client:
            resp = await client.post("/api/generate", json={
                "model": model,
                "system": system,
                "prompt": prompt,
                "stream": False,
                "options": {"temperature": temperature, "num_predict": 256},
            })
            resp.raise_for_status()
            data = resp.json()
            message = commit_message_prompt.parse_commit_message(data.get("response") or "")
            if not message:
                return {"ok": False, "error": "empty response from Ollama", "message": ""}
            return {"ok": True, "message": message}
    except Exception as exc:
        log.warning("generate_commit_message failed: %s", exc)
        return {"ok": False, "error": str(exc), "message": ""}


# ── GIT_ASKPASS credential IPC ────────────────────────────────────────────────
# Maps request_id -> Future[str | None], resolved via `resolve_credential()`
# once the frontend responds to a WS `git.credential_submit` message (or a
# timeout/cancellation supplies None). Built on pending_registry.PendingRegistry.
_credentials: PendingRegistry[str | None] = PendingRegistry()

def _resolve_askpass_helper_path() -> str:
    """Return a stable executable helper path for Git's GIT_ASKPASS.

    In PyInstaller onefile builds, bundled data files live under a temporary
    `_MEI...` extraction directory. Git may invoke GIT_ASKPASS after that path
    has gone stale, so copy the helper to Agent-Team's app-data dir and point
    Git at the stable copy instead.
    """
    source = Path(__file__).parent / "git_askpass_helper.py"
    helper = source
    if getattr(sys, "frozen", False):
        helper = app_data_dir() / "runtime" / "git_askpass_helper.py"
        try:
            helper.parent.mkdir(parents=True, exist_ok=True)
            if not helper.exists() or helper.read_bytes() != source.read_bytes():
                shutil.copyfile(source, helper)
        except OSError as err:
            log.warning("git askpass: stable helper copy failed: %s", err)
            helper = source

    # git execs this path directly (no shell), so the seam writes whatever
    # launcher this platform can exec around the argv below. That argv is
    # always this process's own executable and never the name `python`: a
    # frozen build ships no interpreter for that name to find, and on Windows
    # it usually resolves to the Store's alias stub, which prints its install
    # page and answers git with an empty credential. A frozen build re-enters
    # itself through the askpass entry mode; from a checkout the same mode is
    # reached with `-m`.
    launch_argv = (
        [sys.executable, ASKPASS_FLAG]
        if getattr(sys, "frozen", False)
        else [sys.executable, "-m", "agent_team_backend", ASKPASS_FLAG]
    )
    return str(paths.askpass_launcher(helper, launch_argv))


_ASKPASS_HELPER_PATH = _resolve_askpass_helper_path()


def resolve_credential(request_id: str, value: str | None) -> bool:
    """Resolve a pending credential request Future. Returns False if not found."""
    return _credentials.resolve(request_id, value)


async def create_askpass_context(
    on_request: Callable[[str, str], Awaitable[None]],
    *,
    timeout: float = 60.0,
    on_settled: Callable[[str, str | None], Awaitable[None]] | None = None,
    expected_host: str | None = None,
) -> tuple[dict[str, str], Callable[[], Awaitable[None]]]:
    """Start a one-shot loopback TCP server for a GIT_ASKPASS helper to call back into.

    Returns (env, cleanup):
      env     -- vars to merge into the git subprocess environment: the
                 platform's `git_subprocess_env` (GIT_ASKPASS pointing at
                 git_askpass_helper.py and, on POSIX, the SSH_ASKPASS trio so
                 ssh's own prompts arrive here too), plus the port/token the
                 helper needs to reach this server.
      cleanup -- async function that closes the server; callers must invoke it
                 once the git subprocess has finished (success, failure, or
                 timeout) to avoid leaking the loopback socket.

    `on_request(request_id, prompt)` is invoked when the helper connects with a
    credential prompt, so a caller can notify the frontend (a later phase wires
    this to an emitted WS event). This function does not resolve requests
    itself -- that happens via `resolve_credential()`, called once the caller's
    `on_request` plumbing produces an answer (or a cancellation).

    `on_settled(request_id, value)`, if given, is invoked once the request's
    Future has settled -- either resolved via `resolve_credential()` or timed
    out -- with the final value (`None` for a timeout/cancellation). Callers
    use this to notify the frontend the prompt is done (e.g. so it can close
    a modal), distinguishing a timeout/cancellation (`value is None`) from a
    successful submission.
    """
    token = secrets.token_urlsafe(32)

    async def _handle_connection(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        request_id: str | None = None
        try:
            line = await reader.readline()
            if not line:
                return
            try:
                request = json.loads(line.decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                return
            if request.get("token") != token:
                log.warning("git askpass: rejected connection with invalid token")
                return
            prompt = str(request.get("prompt") or "")
            if expected_host is not None:
                prompt_host = _canonical_https_prompt_host(prompt)
                if prompt_host != expected_host:
                    writer.write(b'{"value": null}\n')
                    await writer.drain()
                    return

            request_id = uuid.uuid4().hex
            fut = _credentials.register(request_id)
            await on_request(request_id, prompt)
            value = await _credentials.wait(request_id, fut, timeout=timeout)
            if value is TIMEOUT:
                value = None

            if on_settled is not None:
                try:
                    await on_settled(request_id, value)
                except Exception as exc:
                    log.warning("git askpass: on_settled callback failed: %s", exc)

            writer.write((json.dumps({"value": value}) + "\n").encode("utf-8"))
            await writer.drain()
        except Exception as exc:
            log.warning("git askpass: connection handling failed: %s", exc)
        finally:
            # Normally already popped by _credentials.wait()'s own cleanup;
            # this only catches an error between register() and wait() (e.g.
            # on_request() raising) that would otherwise leak the entry.
            if request_id is not None:
                _credentials.discard(request_id)
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass

    server = await asyncio.start_server(_handle_connection, host="127.0.0.1", port=0)
    port = server.sockets[0].getsockname()[1]

    env = {
        **paths.git_subprocess_env(_ASKPASS_HELPER_PATH),
        "NAVIDE_ASKPASS_PORT": str(port),
        "NAVIDE_ASKPASS_TOKEN": token,
    }

    async def cleanup() -> None:
        server.close()
        await server.wait_closed()

    return env, cleanup
