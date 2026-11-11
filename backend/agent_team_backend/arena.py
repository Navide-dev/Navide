"""Model arena (experimental): one task, 2-4 models, one git worktree each.

The window opens one CLI pane per candidate (the same spawn path
``cli_open_agent`` uses) with its cwd set to the candidate's worktree; this
module owns everything git- and record-shaped around that:

- ``arena.start`` creates ``<ws>/.agent-team/worktrees/arena-<run>/<slug>`` on
  branch ``arena/<run>/<slug>``, every candidate from the same base commit.
- ``arena.status`` reads each candidate's diff stats against the base and its
  spend from the cost ledger (read only; filtered by the worktree as cwd).
- ``arena.compare`` / ``arena.file_diff`` give the per-file view.
- ``arena.merge`` takes one candidate (squash or merge commit into the base
  branch of the main checkout), or a file-level mix built on its own branch,
  or keeps the branch only. Conflicts are reported, never resolved.
- ``arena.cleanup`` removes the run's worktrees and local branches. Nothing
  here pushes, so there is never a remote branch to delete.

Runs are recorded as JSON under ``<ws>/.agent-team/arena/`` (git-ignored with
the rest of ``.agent-team``). A record holds the task, model ids, branch
names, paths and the user's ratings -- never environment values or
credentials.

Renderer-only: these are ws request types, not MCP tools.
"""

from __future__ import annotations

import asyncio
import fnmatch
import json
import logging
import math
import os
import re
import secrets
import shutil
import stat
import tempfile
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from .host_shell import run_allowlisted_text
from .ipc import make_response

if TYPE_CHECKING:
    from .ws_handlers import Session

log = logging.getLogger(__name__)

MIN_CANDIDATES = 2
MAX_CANDIDATES = 4
DEFAULT_TIME_LIMIT_MIN = 30
DEFAULT_BUDGET_USD = 3.0
CANDIDATE_IDS = ("A", "B", "C", "D")
MERGE_MODES = ("squash", "merge", "branch")

RECORD_DIR = (".agent-team", "arena")
WORKTREE_DIR = (".agent-team", "worktrees")
#: Optional per-project additions to PROTECTED_PATTERNS, one glob per line.
PROJECT_PROTECTED_FILE = "protected.txt"

#: Files a candidate should rarely need to touch: flagged red in the compare
#: view and left unpicked by default in a mix.
PROTECTED_PATTERNS: tuple[str, ...] = (
    "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
    "uv.lock", "poetry.lock", "Pipfile.lock", "Cargo.lock", "Gemfile.lock", "go.sum",
    "composer.lock", "package.json", ".env", ".env.*", ".npmrc",
    ".github/*", ".gitlab-ci.yml", ".circleci/*", "Dockerfile", "docker-compose*.yml",
    "tsconfig*.json", "*.config.js", "*.config.ts", "*.config.mjs", "*.config.cjs",
    "pyproject.toml", "setup.cfg", "setup.py",
)

_GIT_TIMEOUT = 120.0
_DIFF_CAP = 400_000
_RUN_ID_RE = re.compile(r"^[0-9a-f]{4,12}$")
_SLUG_RE = re.compile(r"[^a-z0-9.-]+")
_SLUG_OK_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{0,47}$")
_SHA_RE = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")
_STOPPED = ("", "user", "time", "budget")


class ArenaError(ValueError):
    """A request the arena refuses; the message is shown to the user."""


# ── git ──────────────────────────────────────────────────────────────────────

_hooks_dir: str | None = None


def _empty_hooks_dir() -> str:
    global _hooks_dir
    if _hooks_dir is None or not os.path.isdir(_hooks_dir):
        _hooks_dir = tempfile.mkdtemp(prefix="navide-arena-hooks-")
    return _hooks_dir


async def _git(args: list[str], cwd: str, timeout: float = _GIT_TIMEOUT) -> tuple[int, str, str]:
    """git with the repo's own hook and helper commands switched off.

    Every arena call runs in a tree a model has just been working in, so the
    config and hooks it reaches may have been written by that model: no
    fsmonitor, no hooks, no external diff or textconv, no pager."""
    hardened = [
        "git",
        "-c", "core.fsmonitor=false",
        "-c", f"core.hooksPath={_empty_hooks_dir()}",
        "-c", "diff.external=",
        "-c", "core.pager=cat",
        "-c", "core.sshCommand=",
        "-c", "credential.helper=",
        "-c", "protocol.ext.allow=never",
    ]
    if args and args[0] == "diff":
        args = ["diff", "--no-ext-diff", "--no-textconv", *args[1:]]
    elif len(args) > 2 and args[0] == "-c" and args[2] == "diff":
        args = [*args[:3], "--no-ext-diff", "--no-textconv", *args[3:]]
    rc, out, err = await run_allowlisted_text([*hardened, *args], cwd, timeout=timeout)
    return rc, out, err


async def _git_ok(args: list[str], cwd: str) -> str:
    rc, out, err = await _git(args, cwd)
    if rc != 0:
        raise ArenaError((err or out).strip() or f"git {args[0]} failed")
    return out


# ── records ──────────────────────────────────────────────────────────────────

def _norm_ws(workspace: str) -> str:
    ws = (workspace or "").strip()
    if not ws or not os.path.isabs(ws):
        raise ArenaError("workspace_path must be an absolute path")
    return ws.rstrip("/\\") or ws


def _record_dir(ws: str) -> Path:
    return Path(ws, *RECORD_DIR)


def _record_path(ws: str, run_id: str) -> Path:
    if not _RUN_ID_RE.match(run_id or ""):
        raise ArenaError("invalid run id")
    return _record_dir(ws) / f"{run_id}.json"


def _check_record(run: Any, ws: str, run_id: str) -> dict[str, Any]:
    """The record lives inside the repository, where a model could have
    rewritten it: accept it only in the exact shape start_run wrote, so no
    path or branch in it can point git anywhere else."""
    def bad(why: str) -> ArenaError:
        return ArenaError(f"arena run {run_id} record is not valid ({why})")
    if not isinstance(run, dict) or run.get("id") != run_id:
        raise bad("id")
    if run.get("workspace") != ws:
        raise bad("workspace")
    if not isinstance(run.get("base_sha"), str) or not _SHA_RE.match(run["base_sha"]):
        raise bad("base")
    cands = run.get("candidates")
    if not isinstance(cands, list) or not MIN_CANDIDATES <= len(cands) <= MAX_CANDIDATES:
        raise bad("candidates")
    root = Path(ws, *WORKTREE_DIR, f"arena-{run_id}")
    for index, cand in enumerate(cands):
        if not isinstance(cand, dict) or cand.get("id") != CANDIDATE_IDS[index]:
            raise bad("candidate id")
        slug = cand.get("slug")
        if not isinstance(slug, str) or not _SLUG_OK_RE.match(slug) or slug == "mix":
            raise bad("slug")
        if cand.get("worktree") != str(root / slug) or cand.get("branch") != f"arena/{run_id}/{slug}":
            raise bad("worktree or branch")
        if cand.get("stopped", "") not in _STOPPED or not isinstance(cand.get("pane_id", ""), str):
            raise bad("candidate state")
    branch = run.get("base_branch", "")
    if not isinstance(branch, str) or branch.startswith("-"):
        raise bad("base branch")
    for key in ("created_at", "time_limit_min", "budget_usd"):
        value = run.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise bad(key)
    return run


def _worktree(run: dict[str, Any], path: str) -> str | None:
    """``path`` when it is a real directory exactly where start_run put it
    (no symlink anywhere in between); None when it is gone."""
    if not os.path.lexists(path):
        return None
    expected = os.path.join(os.path.realpath(run["workspace"]), *WORKTREE_DIR, f"arena-{run['id']}", os.path.basename(path))
    if os.path.islink(path) or not os.path.isdir(path) or os.path.realpath(path) != expected:
        raise ArenaError(f"arena worktree {path} is not where this run created it")
    return path


def load_run(ws: str, run_id: str) -> dict[str, Any]:
    ws = _norm_ws(ws)
    path = _record_path(ws, run_id)
    try:
        run = json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        raise ArenaError(f"no arena run {run_id}") from None
    except ValueError:
        raise ArenaError(f"arena run {run_id} record is not valid (json)") from None
    return _check_record(run, ws, run_id)


def save_run(run: dict[str, Any]) -> None:
    path = _record_path(run["workspace"], run["id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(run, ensure_ascii=False, indent=1), "utf-8")
    os.replace(tmp, path)


def list_runs(ws: str) -> list[dict[str, Any]]:
    folder = _record_dir(_norm_ws(ws))
    runs: list[dict[str, Any]] = []
    if folder.is_dir():
        for entry in folder.glob("*.json"):
            try:
                runs.append(load_run(ws, entry.stem))
            except (OSError, ArenaError):
                continue
    runs.sort(key=lambda r: r.get("created_at", 0), reverse=True)
    return runs


def _candidate(run: dict[str, Any], cid: str) -> dict[str, Any]:
    for cand in run["candidates"]:
        if cand["id"] == cid:
            return cand
    raise ArenaError(f"no candidate {cid}")


def model_slug(agent: str, model: str) -> str:
    """Branch- and folder-safe name for a candidate: the model id, or the CLI
    when it runs on its default model."""
    raw = (model or agent or "model").strip().lower()
    slug = _SLUG_RE.sub("-", raw).strip("-.") or "model"
    return slug[:40]


def protected_patterns(ws: str) -> tuple[str, ...]:
    extra: list[str] = []
    path = _record_dir(ws) / PROJECT_PROTECTED_FILE
    try:
        for line in path.read_text("utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                extra.append(line)
    except OSError:
        pass
    return PROTECTED_PATTERNS + tuple(extra)


def is_protected(path: str, patterns: tuple[str, ...]) -> bool:
    name = path.rsplit("/", 1)[-1]
    for pat in patterns:
        if fnmatch.fnmatchcase(path, pat) or ("/" not in pat and fnmatch.fnmatchcase(name, pat)):
            return True
    return False


# ── start ────────────────────────────────────────────────────────────────────

def _clean_candidates(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        raise ArenaError("candidates must be a list")
    picked: list[dict[str, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            raise ArenaError("each candidate needs an agent")
        agent = str(item.get("agent") or "").strip()
        if not agent or agent == "terminal":
            raise ArenaError("each candidate needs a CLI agent")
        picked.append({
            "agent": agent,
            "model": str(item.get("model") or "").strip(),
            "effort": str(item.get("effort") or "").strip(),
        })
    if not MIN_CANDIDATES <= len(picked) <= MAX_CANDIDATES:
        raise ArenaError(f"pick {MIN_CANDIDATES}-{MAX_CANDIDATES} models")
    return picked


async def start_run(
    workspace: str,
    task: str,
    candidates: Any,
    *,
    base: str = "",
    time_limit_min: float = DEFAULT_TIME_LIMIT_MIN,
    budget_usd: float = DEFAULT_BUDGET_USD,
    check_command: str = "",
) -> dict[str, Any]:
    ws = _norm_ws(workspace)
    task = (task or "").strip()
    if not task:
        raise ArenaError("task is required")
    picked = _clean_candidates(candidates)
    if base.strip().startswith("-"):
        raise ArenaError("invalid base")
    rc, _, err = await _git(["rev-parse", "--show-toplevel"], ws)
    if rc != 0:
        raise ArenaError(f"the workspace is not a git repository ({err.strip()[:200]})")
    base_sha = (await _git_ok(["rev-parse", "--verify", f"{base.strip() or 'HEAD'}^{{commit}}"], ws)).strip()
    _, branch_out, _ = await _git(["symbolic-ref", "--quiet", "--short", "HEAD"], ws)
    base_branch = branch_out.strip()
    _, dirty_out, _ = await _git(["status", "--porcelain", "--untracked-files=no"], ws)

    run_id = secrets.token_hex(2)
    while _record_path(ws, run_id).exists():
        run_id = secrets.token_hex(2)
    root = Path(ws, *WORKTREE_DIR, f"arena-{run_id}")
    used: set[str] = set()
    made: list[dict[str, str]] = []
    try:
        for index, cand in enumerate(picked):
            slug = model_slug(cand["agent"], cand["model"])
            if slug == "mix":
                slug = "mix-model"
            while slug in used:
                slug = f"{slug[:44]}-{index + 1}"
            used.add(slug)
            path = str(root / slug)
            branch = f"arena/{run_id}/{slug}"
            await _git_ok(["worktree", "add", "-b", branch, path, base_sha], ws)
            made.append({**cand, "id": CANDIDATE_IDS[index], "slug": slug, "branch": branch, "worktree": path})
    except Exception:
        for done in made:
            await _git(["worktree", "remove", "--force", done["worktree"]], ws)
            await _git(["branch", "-D", done["branch"]], ws)
        raise

    run = {
        "id": run_id,
        "workspace": ws,
        "task": task,
        "base_sha": base_sha,
        "base_branch": base_branch,
        "check_command": (check_command or "").strip(),
        "time_limit_min": max(0.0, float(time_limit_min or 0)),
        "budget_usd": max(0.0, float(budget_usd or 0)),
        "created_at": time.time(),
        "state": "running",
        "candidates": [
            {**c, "pane_id": "", "stopped": "", "rating": 0, "adopted": False}
            for c in made
        ],
        "merge": None,
        "dirty_base": bool(dirty_out.strip()),
    }
    save_run(run)
    return run


def update_candidate(workspace: str, run_id: str, cid: str, fields: dict[str, Any]) -> dict[str, Any]:
    run = load_run(workspace, run_id)
    cand = _candidate(run, cid)
    if "pane_id" in fields:
        cand["pane_id"] = str(fields["pane_id"] or "")
    if "stopped" in fields:
        stopped = str(fields["stopped"] or "")
        if stopped not in _STOPPED:
            raise ArenaError("invalid stop reason")
        cand["stopped"] = stopped
    if "rating" in fields:
        cand["rating"] = max(0, min(5, int(fields["rating"] or 0)))
    if "adopted" in fields:
        adopted = bool(fields["adopted"])
        if adopted:
            for other in run["candidates"]:
                other["adopted"] = False
        cand["adopted"] = adopted
    save_run(run)
    return run


# ── status / compare ─────────────────────────────────────────────────────────

async def _changed_files(run: dict[str, Any], cand: dict[str, Any], patterns: tuple[str, ...]) -> list[dict[str, Any]]:
    """Every file the candidate's worktree differs from the base on:
    committed, uncommitted and untracked alike."""
    base_sha = run["base_sha"]
    wt = _worktree(run, cand["worktree"])
    if wt is None:
        return []
    files: dict[str, dict[str, Any]] = {}
    _, numstat, _ = await _git(["-c", "core.quotepath=off", "diff", "--numstat", "-z", base_sha], wt)
    _, names, _ = await _git(["-c", "core.quotepath=off", "diff", "--name-status", "-z", base_sha], wt)
    status_of: dict[str, str] = {}
    parts = names.split("\0")
    i = 0
    while i + 1 < len(parts):
        code = parts[i]
        if code[:1] in ("R", "C"):
            status_of[parts[i + 2] if i + 2 < len(parts) else parts[i + 1]] = "R"
            i += 3
        else:
            status_of[parts[i + 1]] = code[:1]
            i += 2
    tokens = numstat.split("\0")
    j = 0
    while j < len(tokens):
        row = tokens[j]
        if not row:
            j += 1
            continue
        cols = row.split("\t")
        if len(cols) == 3 and cols[2] == "" and j + 2 < len(tokens):
            path = tokens[j + 2]  # rename: "\0old\0new"
            j += 3
        else:
            path = cols[2] if len(cols) == 3 else ""
            j += 1
        if not path:
            continue
        added = int(cols[0]) if cols[0].isdigit() else 0
        deleted = int(cols[1]) if cols[1].isdigit() else 0
        files[path] = {"path": path, "added": added, "deleted": deleted,
                       "status": status_of.get(path, "M"), "binary": cols[0] == "-"}
    _, untracked, _ = await _git(["-c", "core.quotepath=off", "ls-files", "--others", "--exclude-standard", "-z"], wt)
    for path in filter(None, untracked.split("\0")):
        added = await asyncio.to_thread(_count_lines, os.path.join(wt, path))
        files[path] = {"path": path, "added": added, "deleted": 0, "status": "A", "binary": False}
    out = sorted(files.values(), key=lambda f: f["path"])
    for f in out:
        f["protected"] = is_protected(f["path"], patterns)
    return out


def _count_lines(path: str) -> int:
    """Lines in an untracked file, reading regular files only: a FIFO or a
    symlink planted in the worktree must not block or redirect the read."""
    try:
        if not stat.S_ISREG(os.lstat(path).st_mode):
            return 0
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
        with os.fdopen(fd, "rb") as fh:
            return fh.read(2_000_000).count(b"\n")
    except OSError:
        return 0


def _spend(cost_ledger: Any, worktree: str) -> dict[str, Any]:
    """Tokens and dollars spent inside one worktree, read from the ledger."""
    blank = {"usd": 0.0, "tokens": 0, "unpriced_calls": 0, "available": False}
    if cost_ledger is None or not getattr(cost_ledger, "enabled", False):
        return blank
    try:
        report = cost_ledger.report("cwd", cwd=worktree)
    except ValueError:
        return blank
    usd = 0.0
    tokens = unpriced = 0
    for group in report.get("groups", []):
        usd += float(group.get("usd") or 0)
        unpriced += int(group.get("unpriced_calls") or 0)
        tokens += sum(int(group.get(k) or 0) for k in (
            "input", "output", "cache_read", "cache_write_5m", "cache_write_1h"))
    return {"usd": round(usd, 4), "tokens": tokens, "unpriced_calls": unpriced, "available": True}


async def run_status(workspace: str, run_id: str, cost_ledger: Any) -> dict[str, Any]:
    run = load_run(workspace, run_id)
    patterns = protected_patterns(run["workspace"])
    elapsed = time.time() - float(run.get("created_at") or time.time())
    limit_s = float(run.get("time_limit_min") or 0) * 60
    budget = float(run.get("budget_usd") or 0)
    rows = []
    for cand in run["candidates"]:
        files = await _changed_files(run, cand, patterns)
        spend = await asyncio.to_thread(_spend, cost_ledger, cand["worktree"])
        rows.append({
            "id": cand["id"],
            "files": len(files),
            "added": sum(f["added"] for f in files),
            "deleted": sum(f["deleted"] for f in files),
            "protected": [f["path"] for f in files if f["protected"]],
            "spend": spend,
            "over_time": bool(limit_s) and elapsed >= limit_s,
            "over_budget": bool(budget) and spend["usd"] >= budget,
        })
    return {"run": run, "elapsed_s": round(elapsed, 1), "candidates": rows}


async def compare(workspace: str, run_id: str) -> dict[str, Any]:
    run = load_run(workspace, run_id)
    patterns = protected_patterns(run["workspace"])
    per: dict[str, list[dict[str, Any]]] = {}
    for cand in run["candidates"]:
        per[cand["id"]] = await _changed_files(run, cand, patterns)
    paths = sorted({f["path"] for files in per.values() for f in files})
    table = []
    for path in paths:
        row: dict[str, Any] = {"path": path, "protected": is_protected(path, patterns), "by": {}}
        for cid, files in per.items():
            hit = next((f for f in files if f["path"] == path), None)
            if hit:
                row["by"][cid] = {k: hit[k] for k in ("added", "deleted", "status", "binary")}
        table.append(row)
    return {"run": run, "files": table}


async def file_diff(workspace: str, run_id: str, cid: str, path: str) -> dict[str, Any]:
    run = load_run(workspace, run_id)
    cand = _candidate(run, cid)
    wt = _worktree(run, cand["worktree"])
    if wt is None:
        return {"diff": "", "truncated": False}
    if not path or path.startswith("-") or ".." in Path(path).parts or os.path.isabs(path):
        raise ArenaError("invalid path")
    rc, out, _ = await _git(["-c", "core.quotepath=off", "diff", run["base_sha"], "--", path], wt)
    full = os.path.join(wt, path)
    if not out.strip() and os.path.lexists(full) and stat.S_ISREG(os.lstat(full).st_mode):
        # Untracked: diff it against nothing.
        rc, out, _ = await _git(["diff", "--no-index", "--", os.devnull, path], wt)
    truncated = len(out) > _DIFF_CAP
    return {"diff": out[:_DIFF_CAP], "truncated": truncated}


# ── merge / cleanup ──────────────────────────────────────────────────────────

async def _commit_worktree(wt: str, message: str) -> None:
    """Commit whatever the candidate left uncommitted, so its branch holds it."""
    _, dirty, _ = await _git(["status", "--porcelain"], wt)
    if not dirty.strip():
        return
    await _git_ok(["add", "-A"], wt)
    await _git_ok(["commit", "-m", message], wt)


async def merge_preview(workspace: str, run_id: str) -> dict[str, Any]:
    """What a merge would land on: the main checkout's branch and cleanliness,
    and the commits the base branch gained since the run started."""
    run = load_run(workspace, run_id)
    ws = run["workspace"]
    _, branch_out, _ = await _git(["symbolic-ref", "--quiet", "--short", "HEAD"], ws)
    _, dirty, _ = await _git(["status", "--porcelain", "--untracked-files=no"], ws)
    _, ahead, _ = await _git(["log", "--oneline", f"{run['base_sha']}..HEAD"], ws)
    return {
        "branch": branch_out.strip(),
        "expected_branch": run.get("base_branch", ""),
        "dirty": bool(dirty.strip()),
        "new_commits": [line for line in ahead.splitlines() if line.strip()][:50],
    }


async def _conflict_files(ws: str) -> list[str]:
    _, out, _ = await _git(["-c", "core.quotepath=off", "diff", "--name-only", "--diff-filter=U"], ws)
    return [p for p in out.splitlines() if p.strip()]


async def _build_mix(run: dict[str, Any], picks: dict[str, str]) -> dict[str, Any]:
    """A new branch from the base with each file taken from the candidate the
    user picked for it. Returns a pseudo candidate for the merge step."""
    ws = run["workspace"]
    wt = str(Path(ws, *WORKTREE_DIR, f"arena-{run['id']}", "mix"))
    branch = f"arena/{run['id']}/mix"
    if _worktree(run, wt) is None:
        await _git_ok(["worktree", "add", "-b", branch, wt, run["base_sha"]], ws)
    for path, cid in sorted(picks.items()):
        if not cid:
            continue
        if path.startswith("-") or ".." in Path(path).parts or os.path.isabs(path):
            raise ArenaError(f"invalid path {path}")
        cand = _candidate(run, cid)
        rc, _, _ = await _git(["cat-file", "-e", f"{cand['branch']}:{path}"], ws)
        if rc == 0:
            await _git_ok(["checkout", cand["branch"], "--", path], wt)
        else:
            await _git(["rm", "-q", "--ignore-unmatch", "--", path], wt)
    await _commit_worktree(wt, f"arena({run['id']}): mix")
    return {"id": "mix", "branch": branch, "worktree": wt, "model": "mix", "agent": ""}


async def merge(
    workspace: str,
    run_id: str,
    *,
    candidate: str,
    mode: str,
    picks: dict[str, str] | None = None,
    message: str = "",
) -> dict[str, Any]:
    if mode not in MERGE_MODES:
        raise ArenaError(f"mode must be one of {', '.join(MERGE_MODES)}")
    run = load_run(workspace, run_id)
    ws = run["workspace"]
    for cand in run["candidates"]:
        if _worktree(run, cand["worktree"]):
            await _commit_worktree(cand["worktree"], f"arena({run_id}): candidate {cand['id']} {cand['model'] or cand['agent']}")
    if candidate == "mix":
        chosen = await _build_mix(run, picks or {})
    else:
        chosen = _candidate(run, candidate)
    result: dict[str, Any] = {"ok": True, "branch": chosen["branch"], "mode": mode, "conflict_files": []}
    if mode != "branch":
        preview = await merge_preview(ws, run_id)
        if preview["dirty"]:
            raise ArenaError("the main checkout has uncommitted changes; commit or discard them first")
        if run.get("base_branch") and preview["branch"] != run["base_branch"]:
            raise ArenaError(f"the main checkout is on {preview['branch'] or 'a detached HEAD'}, not {run['base_branch']}")
        label = chosen["model"] or chosen["agent"]
        subject = (message or run["task"].splitlines()[0])[:72].strip() or f"arena {run_id}"
        body = f"{subject}\n\nModel arena run {run_id}: candidate {chosen['id']} ({label})."
        if mode == "squash":
            rc, out, err = await _git(["merge", "--squash", chosen["branch"]], ws)
            if rc == 0:
                rc, out, err = await _git(["commit", "-m", body], ws)
        else:
            rc, out, err = await _git(["merge", "--no-ff", "-m", body, chosen["branch"]], ws)
        if rc != 0:
            conflicts = await _conflict_files(ws)
            result.update(ok=False, conflict_files=conflicts, error=(err or out).strip())
        else:
            _, head, _ = await _git(["rev-parse", "HEAD"], ws)
            result["commit"] = head.strip()
    run["merge"] = {k: result.get(k) for k in ("mode", "branch", "commit", "ok")} | {
        "candidate": chosen["id"], "at": time.time()}
    if result["ok"]:
        run["state"] = "merged" if mode != "branch" else "kept"
    save_run(run)
    result["run"] = run
    return result


async def cleanup(workspace: str, run_id: str, *, worktrees: bool = True, branches: bool = True, keep_branch: str = "") -> dict[str, Any]:
    """Remove the run's worktrees and local branches. ``keep_branch`` survives
    (the branch a "keep branch only" merge left for later)."""
    run = load_run(workspace, run_id)
    ws = run["workspace"]
    removed: list[str] = []
    errors: list[str] = []
    entries = list(run["candidates"])
    mix_wt = str(Path(ws, *WORKTREE_DIR, f"arena-{run_id}", "mix"))
    entries.append({"worktree": mix_wt, "branch": f"arena/{run_id}/mix"})
    if worktrees:
        for entry in entries:
            if _worktree(run, entry["worktree"]):
                rc, _, err = await _git(["worktree", "remove", "--force", entry["worktree"]], ws)
                if rc == 0:
                    removed.append(entry["worktree"])
                else:
                    errors.append(err.strip())
        await _git(["worktree", "prune"], ws)
        root = Path(ws, *WORKTREE_DIR, f"arena-{run_id}")
        if root.is_dir() and not any(root.iterdir()):
            shutil.rmtree(root, ignore_errors=True)
    if branches:
        for entry in entries:
            if entry["branch"] == keep_branch:
                continue
            rc, _, _ = await _git(["rev-parse", "--verify", "--quiet", f"refs/heads/{entry['branch']}"], ws)
            if rc != 0:
                continue
            rc, _, err = await _git(["branch", "-D", entry["branch"]], ws)
            if rc == 0:
                removed.append(entry["branch"])
            else:
                errors.append(err.strip())
    if worktrees and run.get("state") == "running":
        run["state"] = "closed"
    run["cleaned"] = {"worktrees": worktrees, "branches": branches, "at": time.time()}
    save_run(run)
    return {"ok": not errors, "removed": removed, "errors": errors, "run": run}


# ── ws handlers ──────────────────────────────────────────────────────────────

async def _answer(session: "Session", msg_id: str, msg_type: str, work: Callable[[], Any]) -> None:
    try:
        result = await work()
        if isinstance(result, list):
            result = {"runs": result}
        result.setdefault("ok", True)
    except ArenaError as err:
        result = {"ok": False, "error": str(err)}
    except Exception as err:  # noqa: BLE001
        log.exception("arena request %s failed", msg_type)
        result = {"ok": False, "error": str(err) or err.__class__.__name__}
    await session.send_json(make_response(msg_id, msg_type, result))


def _ws(payload: dict) -> str:
    return str(payload.get("workspace_path") or "")


def _rid(payload: dict) -> str:
    return str(payload.get("run_id") or "")


async def ws_start(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    async def work() -> dict[str, Any]:
        run = await start_run(
            _ws(payload), str(payload.get("task") or ""), payload.get("candidates"),
            base=str(payload.get("base") or ""),
            time_limit_min=float(payload.get("time_limit_min", DEFAULT_TIME_LIMIT_MIN) or 0),
            budget_usd=float(payload.get("budget_usd", DEFAULT_BUDGET_USD) or 0),
            check_command=str(payload.get("check_command") or ""),
        )
        return {"run": run}
    await _answer(session, msg_id, msg_type, work)


async def ws_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    async def work() -> list[dict[str, Any]]:
        return list_runs(_ws(payload))
    await _answer(session, msg_id, msg_type, work)


async def ws_update(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    async def work() -> dict[str, Any]:
        fields = {k: payload[k] for k in ("pane_id", "stopped", "rating", "adopted") if k in payload}
        return {"run": update_candidate(_ws(payload), _rid(payload), str(payload.get("candidate") or ""), fields)}
    await _answer(session, msg_id, msg_type, work)


async def ws_status(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    async def work() -> dict[str, Any]:
        return await run_status(_ws(payload), _rid(payload), getattr(app, "cost_ledger", None))
    await _answer(session, msg_id, msg_type, work)


async def ws_compare(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    async def work() -> dict[str, Any]:
        return await compare(_ws(payload), _rid(payload))
    await _answer(session, msg_id, msg_type, work)


async def ws_file_diff(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    async def work() -> dict[str, Any]:
        return await file_diff(_ws(payload), _rid(payload), str(payload.get("candidate") or ""), str(payload.get("path") or ""))
    await _answer(session, msg_id, msg_type, work)


async def ws_merge_preview(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    async def work() -> dict[str, Any]:
        return await merge_preview(_ws(payload), _rid(payload))
    await _answer(session, msg_id, msg_type, work)


async def ws_merge(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app
    from .ipc import make_event

    async def work() -> dict[str, Any]:
        picks = payload.get("picks") if isinstance(payload.get("picks"), dict) else None
        result = await merge(
            _ws(payload), _rid(payload),
            candidate=str(payload.get("candidate") or ""),
            mode=str(payload.get("mode") or ""),
            picks={str(k): str(v or "") for k, v in (picks or {}).items()},
            message=str(payload.get("message") or ""),
        )
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": result["run"]["workspace"]})))
        return result
    await _answer(session, msg_id, msg_type, work)


async def ws_cleanup(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    async def work() -> dict[str, Any]:
        return await cleanup(
            _ws(payload), _rid(payload),
            worktrees=bool(payload.get("worktrees", True)),
            branches=bool(payload.get("branches", True)),
            keep_branch=str(payload.get("keep_branch") or ""),
        )
    await _answer(session, msg_id, msg_type, work)


MESSAGE_HANDLERS: dict[str, Callable[..., Any]] = {
    "arena.start": ws_start,
    "arena.list": ws_list,
    "arena.update": ws_update,
    "arena.status": ws_status,
    "arena.compare": ws_compare,
    "arena.file_diff": ws_file_diff,
    "arena.merge_preview": ws_merge_preview,
    "arena.merge": ws_merge,
    "arena.cleanup": ws_cleanup,
}
