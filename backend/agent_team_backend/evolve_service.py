"""A workspace's self-evolution: settings, runs, and the pane each run uses.

Everything is per workspace. Settings live in that workspace's own database
(``<workspace>/.agent-team/navide.db``, kv key ``evolve_settings``) and so do
its runs (table ``evolve_runs``, component ``evolve``). The only global piece
is the clock: one system-owned scheduler job per workspace
(``evolve:<project id>``), which nobody but this module changes — the Schedule
panel shows it read-only.

A run, when the clock fires or the user asks for one:

1. checks the workspace still exists, that no run of it is still going, and
   that today's run count is under the user's limit;
2. looks at the repository the workspace is in (root, main branch) — a folder
   that is not a git repository only ever gets proposals;
3. renders the built-in rules (:mod:`evolve_rules`) with the settings;
4. opens a new CLI pane for it (mode "auto"), or sends it to the pane the user
   picked (mode "pane"; a pane that is gone falls back to "auto", disclosed);
5. waits for the agent to call the ``evolve_report`` MCP tool, then reclaims
   the pane it opened (the pane stays as a click-to-resume card; only the last
   few such cards per workspace are kept).

Nothing here stops an agent from doing what the rules forbid — the rules are
disclosed, not enforced. A run past its time limit is reported as timed out,
never killed; one far past its token budget is interrupted once, disclosed.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import secrets
import sqlite3
import time
import uuid
from datetime import datetime
from types import SimpleNamespace
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from . import evolve_rules

log = logging.getLogger(__name__)

FEATURE = "evolve"
_KV_KEY = "evolve_settings"
_COMPONENT = "evolve"
#: Runs kept per workspace; older rows are deleted when a new one is added.
RUNS_KEPT = 30
#: Reclaimed auto-run panes kept as resumable cards per workspace (D2).
CARDS_KEPT = 3
#: A run is interrupted once when it passes this multiple of its budget (D6).
OVER_BUDGET_FACTOR = 1.5
WATCH_INTERVAL_S = 30.0
#: Reclaim waits for the pane to be idle this long, then retries a refusal.
RECLAIM_IDLE_WAIT_S = 600.0
RECLAIM_RETRY_S = 60.0
RECLAIM_TRIES = 10
#: An unreported run whose pane has sat idle this long gets a nudge to finish.
IDLE_NUDGE_AFTER_S = 600
#: At most this many nudges per run.
IDLE_NUDGE_MAX = 2
IDLE_NUDGE_TEXT = (
    "[Navide self-evolution run {run_id}] This run is unattended: nobody will answer a "
    "question. Finish now and call evolve_report (status=\"error\" if needed), listing "
    "the work done and any branches or worktrees left behind."
)
#: How long the scheduler may spend handing a run over (opening a pane).
SCHEDULER_TIMEOUT_S = 600
PANE_PREFIX = "evolve-"
TAINT = "scheduled by Navide self-evolution"

#: The pane-owned evolve-scout jobs this feature replaces (D7). Matched by the
#: start of their text; the reminders by naming the main job's id.
LEGACY_TEXT_PREFIX = "【evolve-scout 每日偵察任務】"
LEGACY_REMINDER_MARK = "evolve-scout"

DEFAULTS: dict[str, Any] = {
    "enabled": False,
    "at": "09:00",
    "tz": "",
    "catch_up": "once",
    "mode": "auto",
    "pane_id": "",
    "pane_name": "",
    "agent": "claude",
    "model": "",
    "effort": "",
    "token_budget": 200_000,
    "max_runs_per_day": 2,
    "max_fixes": 2,
    "max_minutes": 90,
    "scope": "fix",
    "extra": "",
    "ledger_plan": "",
}
_INT_BOUNDS = {
    "token_budget": (1_000, 10_000_000),
    "max_runs_per_day": (1, 10),
    "max_fixes": (0, 10),
    "max_minutes": (10, 600),
}
_AT_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
_PANE_ID_RE = re.compile(r"^[A-Za-z0-9._:\-]{1,128}$")
_LEDGER_RE = re.compile(r"^\.agent-team/plans/[A-Za-z0-9._\-]+\.(?:html|plan\.md)$")
_MAX_EXTRA = 4000

#: Same families the rules ask the agent to mask; applied again on the way in.
_SECRET_RES = [
    re.compile(r"sk-[A-Za-z0-9_\-]{8,}"),
    re.compile(r"(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{8,}"),
    re.compile(r"xox[a-z]-[A-Za-z0-9\-]{8,}"),
    re.compile(r"AKIA[0-9A-Z]{12,}"),
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-]{8,}"),
    re.compile(r"eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}(?:\.[A-Za-z0-9_\-]+)?"),
    re.compile(r"(?i)((?:password|token|secret)=)\S+"),
    re.compile(r"\b[0-9a-fA-F]{32,}\b"),
    re.compile(r"\b[A-Za-z0-9+/]{40,}={0,2}"),
]


class SettingsInvalid(ValueError):
    """A settings change that cannot be saved; the message is caller-facing."""


def mask(text: str) -> str:
    out = text
    for pattern in _SECRET_RES:
        if pattern.groups:
            out = pattern.sub(lambda m: m.group(1) + "[REDACTED]", out)
        else:
            out = pattern.sub("[REDACTED]", out)
    return out


def _canonical(workspace: str) -> str:
    return os.path.realpath(os.path.abspath(workspace)) if workspace else ""


def job_id_for(workspace: str) -> str:
    from .projects import _project_id_for

    return f"evolve:{_project_id_for(_canonical(workspace))}"


def _local_tz() -> str:
    try:
        key = getattr(datetime.now().astimezone().tzinfo, "key", None)
        if key:
            return str(key)
    except Exception:  # noqa: BLE001
        pass
    tz = os.environ.get("TZ") or ""
    try:
        ZoneInfo(tz)
        return tz
    except (ZoneInfoNotFoundError, ValueError):
        return "UTC"


def _field(key: str, value: Any) -> Any:
    """One settings field, validated; raises :class:`SettingsInvalid`."""
    if key == "enabled":
        if not isinstance(value, bool):
            raise SettingsInvalid("enabled must be true or false")
    elif key == "at":
        if not isinstance(value, str) or not _AT_RE.match(value):
            raise SettingsInvalid('at must be "HH:MM"')
    elif key == "tz":
        if not isinstance(value, str):
            raise SettingsInvalid("tz must be a time zone name")
        if value:
            try:
                ZoneInfo(value)
            except (ZoneInfoNotFoundError, ValueError) as err:
                raise SettingsInvalid(f"unknown time zone {value!r}") from err
    elif key == "catch_up":
        if value not in ("once", "skip"):
            raise SettingsInvalid('catch_up must be "once" or "skip"')
    elif key == "mode":
        if value not in ("auto", "pane"):
            raise SettingsInvalid('mode must be "auto" or "pane"')
    elif key == "scope":
        if value not in ("fix", "propose"):
            raise SettingsInvalid('scope must be "fix" or "propose"')
    elif key in _INT_BOUNDS:
        low, high = _INT_BOUNDS[key]
        if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
            raise SettingsInvalid(f"{key} must be an integer from {low} to {high}")
    elif key == "extra":
        if not isinstance(value, str) or len(value) > _MAX_EXTRA:
            raise SettingsInvalid(f"extra must be text of at most {_MAX_EXTRA} characters")
    else:  # pane_id, pane_name, agent, model, effort, ledger_plan
        if not isinstance(value, str) or len(value) > 512:
            raise SettingsInvalid(f"{key} must be a short string")
        value = value.strip()
        _check_word(key, value)
    return value


def normalize_settings(raw: Any, current: dict[str, Any]) -> dict[str, Any]:
    """Validate a partial settings change over ``current``."""
    if not isinstance(raw, dict):
        raise SettingsInvalid("settings must be an object")
    out = dict(current)
    for key, value in raw.items():
        if key not in DEFAULTS or value is None:
            continue
        out[key] = _field(key, value)
    if out["mode"] == "pane" and not out["pane_id"]:
        raise SettingsInvalid('mode "pane" needs a pane_id')
    if not out["agent"]:
        raise SettingsInvalid("agent is required")
    return out


def sanitize_stored(stored: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Settings read back from the database, held to the same rules as a save.

    The row may have been written by another build or edited by hand, so it is
    never trusted: each field that fails validation falls back to its default
    and is named in the second value, for the caller to disclose.
    """
    out = dict(DEFAULTS)
    invalid: list[str] = []
    for key in DEFAULTS:
        if key not in stored:
            continue
        try:
            out[key] = _field(key, stored[key])
        except SettingsInvalid:
            invalid.append(key)
    out["tz"] = out["tz"] or _local_tz()
    if out["mode"] == "pane" and not out["pane_id"]:
        out["mode"] = DEFAULTS["mode"]
        if "mode" not in invalid:
            invalid.append("mode")
    pending = stored.get("pending_catch_up", False)
    out["pending_catch_up"] = pending if isinstance(pending, bool) else False
    if not isinstance(pending, bool):
        invalid.append("pending_catch_up")
    return out, invalid


def _check_word(key: str, value: str) -> None:
    """The fields that reach a command line or the rules text, held to the
    shapes Navide itself uses for them."""
    if key == "agent":
        from .cli_vendors import registry

        if value not in registry.VENDORS:
            raise SettingsInvalid(f"unknown CLI {value!r}")
    elif key in ("model", "effort"):
        from .model_args import refuse_unsafe_shape

        why = refuse_unsafe_shape(value if key == "model" else "", value if key == "effort" else "")
        if why:
            raise SettingsInvalid(why)
    elif key == "pane_id":
        if value and not _PANE_ID_RE.match(value):
            raise SettingsInvalid("pane_id is not a pane id")
    elif key == "ledger_plan":
        if value and not _LEDGER_RE.match(value):
            raise SettingsInvalid("ledger_plan must be a plan file under .agent-team/plans/")
    elif key == "pane_name":
        if re.search(r"[\x00-\x1f\x7f]", value):
            raise SettingsInvalid("pane_name contains a control character")


# ── persistence ─────────────────────────────────────────────────────────────


def _create_schema(cur: sqlite3.Cursor) -> None:
    cur.execute(
        "CREATE TABLE evolve_runs ("
        " id TEXT PRIMARY KEY,"
        " trigger TEXT NOT NULL,"
        " status TEXT NOT NULL,"
        " reason TEXT,"
        " started_at INTEGER NOT NULL,"
        " ended_at INTEGER,"
        " mode TEXT,"
        " pane_id TEXT,"
        " pane_name TEXT,"
        " agent TEXT,"
        " model TEXT,"
        " scope TEXT,"
        " template_version INTEGER,"
        " tokens INTEGER,"
        " summary TEXT,"
        " commits TEXT,"
        " proposals TEXT,"
        " panes TEXT,"
        " reclaimed INTEGER,"
        " interrupted INTEGER NOT NULL DEFAULT 0,"
        " detail TEXT)"
    )
    cur.execute("CREATE INDEX evolve_runs_started ON evolve_runs (started_at)")


def _add_token_hash(cur: sqlite3.Cursor) -> None:
    # The run token's hash: evolve_report must present the token that only the
    # run's task text carried. A downgraded build ignores the extra column.
    cur.execute("ALTER TABLE evolve_runs ADD COLUMN token_hash TEXT")


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


_JSON_COLUMNS = ("commits", "proposals", "panes")


def _row(row: sqlite3.Row) -> dict[str, Any]:
    run = dict(row)
    run.pop("token_hash", None)  # never handed back out
    for key in _JSON_COLUMNS:
        try:
            run[key] = json.loads(run[key]) if run[key] else []
        except json.JSONDecodeError:
            run[key] = []
    if run.get("reclaimed") is not None:
        run["reclaimed"] = bool(run["reclaimed"])
    run["interrupted"] = bool(run.get("interrupted"))
    return run


class _Store:
    """One workspace's settings and runs, in that workspace's database."""

    def __init__(self, databases: Any) -> None:
        self._databases = databases
        self._ready: set[str] = set()

    def db(self, workspace: str, *, create: bool) -> Any | None:
        db = self._databases.get(workspace) if create else self._databases.peek(workspace)
        if db is None:
            return None
        key = str(db.path)
        if key not in self._ready:
            db.migrate(_COMPONENT, 1, _create_schema)
            db.migrate(_COMPONENT, 2, _add_token_hash)
            self._ready.add(key)
        return db

    def settings(self, workspace: str) -> dict[str, Any] | None:
        checked = self.settings_checked(workspace)
        return None if checked is None else checked[0]

    def settings_checked(self, workspace: str) -> tuple[dict[str, Any], list[str]] | None:
        """Stored settings, re-validated, with the names of fields reset."""
        db = self.db(workspace, create=False)
        stored = db.kv_get(_KV_KEY) if db is not None else None
        if stored is None:
            return None
        if not isinstance(stored, dict):
            return dict(DEFAULTS, pending_catch_up=False), ["*"]
        return sanitize_stored(stored)

    def save_settings(self, workspace: str, settings: dict[str, Any]) -> None:
        db = self.db(workspace, create=True)
        if db is None:
            raise SettingsInvalid("the workspace folder does not exist")
        db.kv_set(_KV_KEY, settings, now=int(time.time()))

    def runs(self, workspace: str, limit: int = RUNS_KEPT) -> list[dict[str, Any]]:
        db = self.db(workspace, create=False)
        if db is None:
            return []
        with db.transaction() as cur:
            rows = cur.execute(
                "SELECT * FROM evolve_runs ORDER BY started_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [_row(r) for r in rows]

    def token_matches(self, workspace: str, run_id: str, token: str) -> bool:
        db = self.db(workspace, create=False)
        if db is None or not token:
            return False
        with db.transaction() as cur:
            row = cur.execute("SELECT token_hash FROM evolve_runs WHERE id = ?", (run_id,)).fetchone()
        stored = row["token_hash"] if row is not None else None
        return bool(stored) and secrets.compare_digest(stored, _token_hash(token))

    def run(self, workspace: str, run_id: str) -> dict[str, Any] | None:
        db = self.db(workspace, create=False)
        if db is None:
            return None
        with db.transaction() as cur:
            row = cur.execute("SELECT * FROM evolve_runs WHERE id = ?", (run_id,)).fetchone()
        return _row(row) if row is not None else None

    def running(self, workspace: str) -> list[dict[str, Any]]:
        db = self.db(workspace, create=False)
        if db is None:
            return []
        with db.transaction() as cur:
            rows = cur.execute(
                "SELECT * FROM evolve_runs WHERE status = 'running' ORDER BY started_at"
            ).fetchall()
        return [_row(r) for r in rows]

    def timed_out_unreclaimed(self, workspace: str) -> list[dict[str, Any]]:
        """Timed-out runs that still hold a pane nobody tried to reclaim."""
        db = self.db(workspace, create=False)
        if db is None:
            return []
        with db.transaction() as cur:
            rows = cur.execute(
                "SELECT * FROM evolve_runs WHERE status = 'timeout' AND reclaimed IS NULL"
                " AND pane_id != '' ORDER BY started_at"
            ).fetchall()
        return [_row(r) for r in rows]

    def count_since(self, workspace: str, since_ms: int) -> int:
        db = self.db(workspace, create=False)
        if db is None:
            return 0
        with db.transaction() as cur:
            row = cur.execute(
                "SELECT COUNT(*) AS n FROM evolve_runs WHERE started_at >= ? AND status != 'skipped'",
                (since_ms,),
            ).fetchone()
        return int(row["n"])

    def insert(self, workspace: str, run: dict[str, Any]) -> None:
        db = self.db(workspace, create=True)
        if db is None:
            return
        values = {**run}
        for key in _JSON_COLUMNS:
            values[key] = json.dumps(values.get(key) or [], ensure_ascii=False)
        columns = list(values)
        with db.transaction() as cur:
            cur.execute(
                f"INSERT INTO evolve_runs ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
                [values[c] for c in columns],
            )
            cur.execute(
                "DELETE FROM evolve_runs WHERE id NOT IN"
                " (SELECT id FROM evolve_runs ORDER BY started_at DESC LIMIT ?)",
                (RUNS_KEPT,),
            )

    def update(self, workspace: str, run_id: str, fields: dict[str, Any]) -> None:
        db = self.db(workspace, create=False)
        if db is None or not fields:
            return
        values = dict(fields)
        for key in _JSON_COLUMNS:
            if key in values:
                values[key] = json.dumps(values[key] or [], ensure_ascii=False)
        if "reclaimed" in values and values["reclaimed"] is not None:
            values["reclaimed"] = 1 if values["reclaimed"] else 0
        if "interrupted" in values:
            values["interrupted"] = 1 if values["interrupted"] else 0
        assignments = ", ".join(f"{key} = ?" for key in values)
        with db.transaction() as cur:
            cur.execute(
                f"UPDATE evolve_runs SET {assignments} WHERE id = ?",
                [*values.values(), run_id],
            )


# ── what the service needs from the rest of the backend ─────────────────────


class LiveHost:
    """The seam to panes, windows and the scheduler; tests swap it for a fake."""

    def _host_ctx(self) -> Any:
        from .mcp_server import auth

        params = {"client": "host", "t": auth.internal_token()}
        return SimpleNamespace(
            request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
        )

    async def git_info(self, workspace: str) -> dict[str, Any]:
        from .git_service import _run

        info = {"is_repo": False, "root": "", "branch": "", "subdir": ""}
        try:
            rc, out, _ = await _run(["git", "rev-parse", "--show-toplevel"], workspace)
        except Exception:  # noqa: BLE001 — no git at all reads as "not a repository"
            return info
        if rc != 0 or not out.strip():
            return info
        root = os.path.realpath(out.strip())
        info["is_repo"] = True
        info["root"] = root
        rel = os.path.relpath(_canonical(workspace), root)
        info["subdir"] = "" if rel == "." else rel
        branch = ""
        rc, out, _ = await _run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root)
        if rc == 0 and out.strip().startswith("origin/"):
            branch = out.strip()[len("origin/"):]
        if not branch:
            for candidate in ("main", "master"):
                rc, _, _ = await _run(["git", "rev-parse", "--verify", "--quiet", f"refs/heads/{candidate}"], root)
                if rc == 0:
                    branch = candidate
                    break
        if not branch:
            rc, out, _ = await _run(["git", "branch", "--show-current"], root)
            branch = out.strip() if rc == 0 else ""
        info["branch"] = branch or "main"
        return info

    def pane(self, pane_id: str) -> Any | None:
        from . import agent_messaging

        return agent_messaging.current(pane_id) if pane_id else None

    def workspace_has_panes(self, workspace: str) -> bool:
        from . import agent_messaging

        target = _canonical(workspace)
        return any(_canonical(ws) == target for ws in agent_messaging.workspaces())

    async def open_pane(self, workspace: str, settings: dict[str, Any], name: str, task: str) -> dict[str, Any]:
        from .mcp_server import server as mcp

        return await mcp.cli_open_agent(
            settings["agent"], name, task, self._host_ctx(),
            workspace_path=workspace, model=settings["model"], effort=settings["effort"],
        )

    async def send(self, pane_id: str, task: str) -> dict[str, Any]:
        from .mcp_server import server as mcp

        return await mcp._send(
            mcp._Caller(kind="host"), "", task, wait_for_delivery_s=30.0,
            pane_id=pane_id, open_target=True, taint_detail=TAINT,
        )

    async def pane_action(self, workspace: str, action: str, pane_id: str) -> dict[str, Any]:
        """ui.pane.reclaim / ui.pane.interrupt / ui.pane.close on one pane."""
        from .mcp_server import server as mcp

        reply = await mcp._ui_request(
            workspace, "invoke", caller=mcp._pane_caller(pane_id),
            action=action, args={"paneId": pane_id},
        )
        if action == "ui.pane.reclaim" and reply.get("ok"):
            result = reply.get("result") or {}
            if isinstance(result, dict) and pane_id not in (result.get("reclaimed") or []):
                refused = result.get("refused") or []
                return {"ok": False, "error": str(refused[0].get("reason") if refused else "refused")}
        return reply

    def pane_tokens(self, pane_id: str) -> int | None:
        from . import app

        total = app.pane_token_total(pane_id)
        return None if total is None else int(total.get("input", 0)) + int(total.get("output", 0))

    async def broadcast(self, event: str, payload: dict[str, Any]) -> None:
        from . import app
        from .ipc import make_event

        await app.broadcast(make_event(event, payload))

    def scheduler(self) -> Any:
        from . import scheduler

        return scheduler.get_service()


# ── the service ─────────────────────────────────────────────────────────────


def _now_ms() -> int:
    return int(time.time() * 1000)


class EvolveService:
    def __init__(self, databases: Any, *, host: Any = None, clock: Any = None, limits: Any = None) -> None:
        self.store = _Store(databases)
        self.host = host or LiveHost()
        self._clock = clock or _now_ms
        #: Settings → Resource limits reader (the shared UI settings snapshot).
        self._limits = limits or dict
        #: Run ids whose timeout reclaim has been started by this process.
        self._timeout_reclaims: set[str] = set()
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._side: set[asyncio.Task] = set()
        #: Workspaces this process has touched; the watchdog looks at these
        #: and at every workspace that has a system evolve job.
        self._known: set[str] = set()
        #: run id → (ms the run's pane was first seen idle, nudges sent). In
        #: memory only: a restart at worst grants a run another round of nudges.
        self._idle: dict[str, tuple[int | None, int]] = {}

    def now_ms(self) -> int:
        return int(self._clock())

    # ── lifecycle ────────────────────────────────────────────────────────

    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._watch_loop())

    async def close(self) -> None:
        tasks = [t for t in (self._task, *self._side) if t is not None]
        for task in tasks:
            task.cancel()
        for task in tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._task = None
        self._side.clear()

    def _spawn(self, coro: Any) -> None:
        task = asyncio.create_task(coro)
        self._side.add(task)
        task.add_done_callback(self._side.discard)

    # ── reads ────────────────────────────────────────────────────────────

    async def _workspaces(self) -> set[str]:
        found = set(self._known)
        try:
            for job in await self.host.scheduler().store.list_jobs():
                owner = job.get("owner") or {}
                if owner.get("kind") == "system" and owner.get("feature") == FEATURE:
                    found.add(_canonical(str(owner.get("workspace") or "")))
        except Exception as err:  # noqa: BLE001
            log.warning("evolve: listing workspaces failed: %s", err)
        return {ws for ws in found if ws}

    async def _job(self, workspace: str) -> dict[str, Any] | None:
        return await self.host.scheduler().store.get_job(job_id_for(workspace))

    async def legacy_jobs(self, workspace: str) -> list[dict[str, Any]]:
        """Old pane-owned evolve-scout jobs aimed at ``workspace`` (D7)."""
        target = _canonical(workspace)
        jobs = await self.host.scheduler().store.list_jobs()
        main_ids = {
            job["id"] for job in jobs
            if job["action"].get("kind") == "message"
            and str(job["action"].get("text") or "").startswith(LEGACY_TEXT_PREFIX)
            and _canonical(str(job["action"].get("workspace") or "")) == target
        }
        out = []
        for job in jobs:
            if (job.get("owner") or {}).get("kind") == "system":
                continue
            text = str(job["action"].get("text") or "")
            reminder = LEGACY_REMINDER_MARK in text and any(i in text for i in main_ids)
            if job["id"] in main_ids or (
                reminder and _canonical(str(job["action"].get("workspace") or "")) == target
            ):
                out.append(job)
        return out

    def _defaults_for(self, workspace: str, legacy: list[dict[str, Any]]) -> dict[str, Any]:
        settings = {**DEFAULTS, "tz": _local_tz()}
        if (ledger := self._default_ledger(workspace)):
            settings["ledger_plan"] = ledger
        for job in legacy:
            schedule = job.get("schedule") or {}
            if str(job["action"].get("text") or "").startswith(LEGACY_TEXT_PREFIX) and schedule.get("kind") == "daily":
                settings["at"] = schedule.get("at") or settings["at"]
                settings["tz"] = schedule.get("tz") or settings["tz"]
        return settings

    @staticmethod
    def _default_ledger(workspace: str) -> str:
        plans = os.path.join(workspace, ".agent-team", "plans")
        try:
            names = sorted(n for n in os.listdir(plans) if n.startswith("navide-self-evolution-loop_") and n.endswith(".html"))
        except OSError:
            return ""
        return f".agent-team/plans/{names[0]}" if names else ""

    async def _settings(self, workspace: str) -> dict[str, Any]:
        stored = await asyncio.to_thread(self.store.settings, workspace)
        if stored is not None:
            return stored
        return self._defaults_for(workspace, await self.legacy_jobs(workspace))

    async def get(self, workspace: str) -> dict[str, Any]:
        workspace = _canonical(workspace)
        if not os.path.isdir(workspace):
            return {"ok": False, "error": "the workspace folder does not exist", "reason": "workspace_gone"}
        settings = await self._settings(workspace)
        checked = await asyncio.to_thread(self.store.settings_checked, workspace)
        git = await self.host.git_info(workspace)
        job = await self._job(workspace)
        runs = await asyncio.to_thread(self.store.runs, workspace)
        legacy = await self.legacy_jobs(workspace)
        return {
            "ok": True,
            "workspace": workspace,
            "settings": settings,
            "git": git,
            "job": None if job is None else {
                "id": job["id"], "enabled": job["enabled"],
                "next_run_at": job["state"].get("next_run_at"),
            },
            "running": next((r for r in runs if r["status"] == "running"), None),
            "runs": runs,
            "legacy": [{"id": j["id"], "name": j["name"], "enabled": j["enabled"]} for j in legacy],
            "template": {"version": evolve_rules.VERSION, "text": evolve_rules.preview()},
            # Stored fields that failed validation and were reset to defaults.
            "invalid_settings": checked[1] if checked else [],
        }

    async def badge(self, workspace: str) -> dict[str, Any]:
        workspace = _canonical(workspace)
        stored = await asyncio.to_thread(self.store.settings, workspace)
        runs = await asyncio.to_thread(self.store.runs, workspace) if stored is not None else []
        running = [r for r in runs if r["status"] == "running"]
        job = await self._job(workspace)
        last = runs[0] if runs else None
        return {
            "enabled": bool(stored and stored.get("enabled")),
            "running": bool(running),
            "running_since": running[0]["started_at"] if running else None,
            "next_run_at": job["state"].get("next_run_at") if job and job["enabled"] else None,
            "last_status": last["status"] if last else None,
            # Panes Navide opened or used for this workspace's runs, so the
            # sidebar can mark them without opening the panel first.
            "pane_ids": list(dict.fromkeys(r["pane_id"] for r in runs if r["pane_id"])),
        }

    async def badges(self, workspaces: list[str]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for ws in workspaces:
            if isinstance(ws, str) and ws:
                out[ws] = await self.badge(ws)
        return {"ok": True, "badges": out}

    # ── writes ───────────────────────────────────────────────────────────

    async def _sync_job(self, workspace: str, settings: dict[str, Any]) -> None:
        from .scheduler import system_owner

        name = f"Self-evolution · {os.path.basename(workspace) or workspace}"
        raw = {
            "name": name,
            "enabled": bool(settings["enabled"]),
            "schedule": {"kind": "daily", "at": settings["at"], "tz": settings["tz"] or _local_tz()},
            "action": {"kind": "evolve", "workspace": workspace},
            "policy": {
                "catch_up": settings["catch_up"],
                "max_runs_per_day": settings["max_runs_per_day"],
                "timeout_s": SCHEDULER_TIMEOUT_S,
            },
        }
        answer = await self.host.scheduler().system_put(
            job_id_for(workspace), raw, system_owner(FEATURE, workspace)
        )
        if not answer.get("ok"):
            raise SettingsInvalid(str(answer.get("error") or "could not save the schedule"))

    async def set(self, workspace: str, updates: Any) -> dict[str, Any]:
        workspace = _canonical(workspace)
        if not os.path.isdir(workspace):
            return {"ok": False, "error": "the workspace folder does not exist", "reason": "workspace_gone"}
        disabled_legacy: list[str] = []
        async with self._lock:
            current = await self._settings(workspace)
            try:
                settings = normalize_settings(updates, current)
            except SettingsInvalid as err:
                return {"ok": False, "error": str(err)}
            if not settings["tz"]:
                settings["tz"] = _local_tz()
            turning_on = settings["enabled"] and not current.get("enabled")
            try:
                await asyncio.to_thread(self.store.save_settings, workspace, settings)
                await self._sync_job(workspace, settings)
            except SettingsInvalid as err:
                return {"ok": False, "error": str(err)}
            self._known.add(workspace)
            if turning_on:
                # The user turned this on: the jobs it replaces stop (never
                # deleted), as the user — they are the only one who may.
                for job in await self.legacy_jobs(workspace):
                    if job["enabled"]:
                        answer = await self.host.scheduler().set_enabled(job["id"], False)
                        if answer.get("ok"):
                            disabled_legacy.append(job["id"])
        await self._changed(workspace)
        answer = await self.get(workspace)
        if answer.get("ok"):
            answer["disabled_legacy"] = disabled_legacy
        return answer

    async def run_now(self, workspace: str) -> dict[str, Any]:
        """Start a run now, through the scheduler so it lands in its history."""
        from .scheduler import system_owner

        workspace = _canonical(workspace)
        if not os.path.isdir(workspace):
            return {"ok": False, "error": "the workspace folder does not exist", "reason": "workspace_gone"}
        async with self._lock:
            settings = await self._settings(workspace)
            if await self._job(workspace) is None:
                await asyncio.to_thread(self.store.save_settings, workspace, settings)
                await self._sync_job(workspace, settings)
            self._known.add(workspace)
        refusal = await self._gate(workspace, settings)
        if refusal is not None:
            return {"ok": False, "reason": refusal["reason"], "error": refusal["detail"]}
        answer = await self.host.scheduler().run_now(
            job_id_for(workspace), system_owner(FEATURE, workspace)
        )
        if not answer.get("ok"):
            return {"ok": False, "reason": "busy", "error": str(answer.get("error") or "")}
        return {"ok": True}

    # ── runs ─────────────────────────────────────────────────────────────

    def _day_start_ms(self, settings: dict[str, Any]) -> int:
        try:
            tz = ZoneInfo(settings.get("tz") or _local_tz())
        except (ZoneInfoNotFoundError, ValueError):
            tz = ZoneInfo("UTC")
        now = datetime.fromtimestamp(self.now_ms() / 1000, tz)
        return int(now.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)

    async def _gate(self, workspace: str, settings: dict[str, Any]) -> dict[str, Any] | None:
        if await asyncio.to_thread(self.store.running, workspace):
            return {"reason": "busy", "detail": "a run of this workspace is still going"}
        used = await asyncio.to_thread(self.store.count_since, workspace, self._day_start_ms(settings))
        if used >= settings["max_runs_per_day"]:
            return {
                "reason": "budget",
                "detail": f"today's {settings['max_runs_per_day']} runs are used up",
            }
        return None

    async def start_from_scheduler(self, workspace: str, *, manual: bool) -> dict[str, Any]:
        """The scheduler fired (or the user asked): start a run; answer a run outcome."""
        return await self.start_run(workspace, "manual" if manual else "schedule")

    async def start_run(self, workspace: str, trigger: str) -> dict[str, Any]:
        workspace = _canonical(workspace)
        if not os.path.isdir(workspace):
            await self._notice(workspace, "failed", {"status": "skipped", "reason": "workspace_gone"})
            return {"status": "skipped", "reason": "workspace_gone", "detail": "the workspace folder does not exist"}
        settings = await self._settings(workspace)
        self._known.add(workspace)
        now = self.now_ms()
        run: dict[str, Any] = {
            "id": uuid.uuid4().hex[:12], "trigger": trigger, "status": "running", "reason": None,
            "started_at": now, "ended_at": None, "mode": settings["mode"], "pane_id": "",
            "pane_name": "", "agent": settings["agent"], "model": settings["model"],
            "scope": settings["scope"], "template_version": evolve_rules.VERSION,
            "tokens": None, "summary": "", "commits": [], "proposals": [], "panes": [],
            "reclaimed": None, "interrupted": 0, "detail": "",
        }
        token = secrets.token_hex(16)
        async with self._lock:
            refusal = await self._gate(workspace, settings)
            if refusal is not None:
                skipped = {**run, "status": "skipped", "reason": refusal["reason"],
                           "ended_at": now, "detail": refusal["detail"]}
                await asyncio.to_thread(self.store.insert, workspace, skipped)
                await self._notice(workspace, "skipped", skipped)
                await self._changed(workspace)
                return {"status": "skipped", "reason": refusal["reason"], "detail": refusal["detail"]}
            # Claimed before anything is opened: this row is the reentry lock.
            await asyncio.to_thread(self.store.insert, workspace, {**run, "token_hash": _token_hash(token)})
        return await self._launch(workspace, settings, run, token)

    async def _launch(
        self, workspace: str, settings: dict[str, Any], run: dict[str, Any], token: str
    ) -> dict[str, Any]:
        git = await self.host.git_info(workspace)
        scope = settings["scope"] if git["is_repo"] else "propose"
        if not git["is_repo"] and settings["scope"] == "fix":
            await self._notice(workspace, "not_git", run)
        render = {
            "run_id": run["id"], "run_token": token, "workspace": workspace, "repo_root": git["root"],
            "branch": git["branch"], "is_repo": git["is_repo"], "scope": scope,
            "token_budget": settings["token_budget"], "max_minutes": settings["max_minutes"],
            "max_fixes": settings["max_fixes"], "ledger_plan": settings["ledger_plan"],
            "extra": settings["extra"],
        }
        fields: dict[str, Any] = {"scope": scope}
        checked = await asyncio.to_thread(self.store.settings_checked, workspace)
        if checked and checked[1]:
            fields["detail"] = "stored settings reset to defaults: " + ", ".join(checked[1])
        try:
            task = evolve_rules.render(render)
        except evolve_rules.UnsafeValue as err:
            return await self._fail(workspace, run, fields, "error", "unsafe_value", str(err))
        mode = settings["mode"]
        if mode == "pane":
            entry = self.host.pane(settings["pane_id"])
            if entry is None:
                mode = "auto"
                fields["detail"] = (str(fields.get("detail") or "") + " the chosen pane is gone; "
                                    "opened a new pane instead").strip()
                await self._notice(workspace, "fallback_auto", {**run, **fields})
            else:
                answer = await self.host.send(entry.pane_id, task)
                ok = bool(answer.get("ok")) and answer.get("status") not in ("failed", "rejected")
                fields.update(mode="pane", pane_id=entry.pane_id, pane_name=entry.name)
                if not ok:
                    return await self._fail(workspace, run, fields, "error", "send_failed",
                                            str(answer.get("error") or answer.get("reason") or "send failed"))
        if mode == "auto":
            name = f"{PANE_PREFIX}{datetime.fromtimestamp(run['started_at'] / 1000).strftime('%m%d-%H%M')}"
            answer = await self.host.open_pane(workspace, settings, name, task)
            if not answer.get("ok"):
                error = str(answer.get("error") or "could not open a pane")
                if "no answer" in error or not self.host.workspace_has_panes(workspace):
                    # Nobody has this workspace open: run it when someone does (D4).
                    await self._mark_catch_up(workspace)
                    return await self._fail(workspace, run, fields, "skipped", "workspace_not_open", error)
                return await self._fail(workspace, run, fields, "error", "open_failed", error)
            fields.update(mode="auto", pane_id=str(answer.get("pane_id") or ""),
                          pane_name=str(answer.get("name") or name))
            if answer.get("kickoff") == "failed":
                fields["detail"] = (fields.get("detail", "") + " kickoff unverified: "
                                    + str(answer.get("hint") or "")).strip()
        await asyncio.to_thread(self.store.update, workspace, run["id"], fields)
        started = {**run, **fields}
        await self._notice(workspace, "started", started)
        await self._changed(workspace)
        return {"status": "ok", "detail": f"run {run['id']} started in {fields.get('pane_name') or 'a pane'}"}

    async def _fail(self, workspace: str, run: dict[str, Any], fields: dict[str, Any],
                    status: str, reason: str, detail: str) -> dict[str, Any]:
        fields = {**fields, "status": status, "reason": reason, "detail": detail, "ended_at": self.now_ms()}
        await asyncio.to_thread(self.store.update, workspace, run["id"], fields)
        await self._notice(workspace, "skipped" if status == "skipped" else "failed", {**run, **fields})
        await self._changed(workspace)
        return {"status": status, "reason": reason, "detail": detail}

    async def _mark_catch_up(self, workspace: str) -> None:
        settings = await asyncio.to_thread(self.store.settings, workspace)
        if settings is not None and settings.get("catch_up") == "once":
            await asyncio.to_thread(self.store.save_settings, workspace, {**settings, "pending_catch_up": True})

    async def report(self, caller_pane_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        """The agent's evolve_report: record the outcome, then reclaim its pane."""
        run_id = str(payload.get("run_id") or "").strip()
        caller = self.host.pane(caller_pane_id)
        if not run_id or caller is None:
            return {"ok": False, "error": "evolve_report needs a run_id and must come from a Navide pane"}
        workspace = _canonical(caller.workspace_path)
        run = await asyncio.to_thread(self.store.run, workspace, run_id)
        if run is None:
            return {"ok": False, "error": f'no self-evolution run "{run_id}" in this workspace'}
        allowed = {run["pane_id"]}
        parent = getattr(caller, "spawned_by", "")
        if caller.pane_id not in allowed and parent not in allowed:
            return {"ok": False, "error": "only the run's own pane (or a pane it opened) may report it"}
        if run["status"] not in ("running", "timeout"):
            return {"ok": False, "error": f"run {run_id} is already {run['status']}"}
        # The pane id alone proves little: an MCP caller names its own pane id.
        # The token was only ever written into this run's task.
        if not await asyncio.to_thread(
            self.store.token_matches, workspace, run_id, str(payload.get("run_token") or "")
        ):
            return {"ok": False, "error": "run_token does not match this run; copy it from your task"}
        status = "ok" if payload.get("status") != "error" else "error"
        reported = payload.get("tokens")
        measured = self.host.pane_tokens(run["pane_id"]) if run["pane_id"] else None
        tokens = max([t for t in (reported, measured, run.get("tokens")) if isinstance(t, int) and not isinstance(t, bool)] or [0]) or None
        fields = {
            "status": status, "ended_at": self.now_ms(), "tokens": tokens,
            "summary": mask(str(payload.get("summary") or ""))[:8000],
            "commits": _clean_list(payload.get("commits"), ("hash", "title")),
            "proposals": _clean_list(payload.get("proposals"), ("rel_path", "name")),
            "panes": [mask(str(p))[:200] for p in (payload.get("panes") or []) if isinstance(p, str)][:10],
        }
        await asyncio.to_thread(self.store.update, workspace, run_id, fields)
        finished = {**run, **fields}
        await self._notice(workspace, "finished", finished)
        await self._changed(workspace)
        # A timed-out run whose pane the timeout reclaim already took (or is
        # taking) is not reclaimed twice: the second attempt would find a
        # placeholder, be refused every time, and record reclaimed=False.
        already = run.get("reclaimed") is not None or run_id in self._timeout_reclaims
        if run["mode"] == "auto" and run["pane_id"] and not already:
            self._spawn(self._reclaim(workspace, run_id, run["pane_id"]))
        return {"ok": True, "run_id": run_id, "status": status}

    async def _reclaim(self, workspace: str, run_id: str, pane_id: str) -> None:
        waited = 0.0
        while waited < RECLAIM_IDLE_WAIT_S:
            entry = self.host.pane(pane_id)
            if entry is None or not getattr(entry, "busy", False):
                break
            await asyncio.sleep(10.0)
            waited += 10.0
        reclaimed = False
        for attempt in range(RECLAIM_TRIES):
            answer = await self.host.pane_action(workspace, "ui.pane.reclaim", pane_id)
            if answer.get("ok"):
                reclaimed = True
                break
            if attempt + 1 < RECLAIM_TRIES:
                await asyncio.sleep(RECLAIM_RETRY_S)
        await asyncio.to_thread(self.store.update, workspace, run_id, {"reclaimed": reclaimed})
        await self._changed(workspace)
        if reclaimed:
            await self._prune_cards(workspace)

    async def _prune_cards(self, workspace: str) -> None:
        """Keep only the newest CARDS_KEPT reclaimed auto-run panes (D2)."""
        runs = await asyncio.to_thread(self.store.runs, workspace)
        cards = [r for r in runs if r["mode"] == "auto" and r["pane_id"] and r.get("reclaimed")]
        for old in cards[CARDS_KEPT:]:
            answer = await self.host.pane_action(workspace, "ui.pane.close", old["pane_id"])
            if answer.get("ok"):
                await asyncio.to_thread(self.store.update, workspace, old["id"], {"pane_id": ""})

    # ── the watchdog ─────────────────────────────────────────────────────

    async def _watch_loop(self) -> None:
        while True:
            try:
                await self.watch_once()
            except asyncio.CancelledError:
                raise
            except Exception as err:  # noqa: BLE001 — the loop must survive anything
                log.warning("evolve watchdog failed: %s", err)
            await asyncio.sleep(WATCH_INTERVAL_S)

    async def watch_once(self) -> None:
        now = self.now_ms()
        for workspace in await self._workspaces():
            settings = await asyncio.to_thread(self.store.settings, workspace)
            if settings is None:
                continue
            running = await asyncio.to_thread(self.store.running, workspace)
            for run in running:
                await self._watch_run(workspace, settings, run, now)
            await self._reclaim_timed_out(workspace, now)
            live = {workspace + "\0" + r["id"] for r in running}
            for key in [k for k in self._idle if k not in live and k.startswith(workspace + "\0")]:
                del self._idle[key]
            if settings.get("pending_catch_up") and self.host.workspace_has_panes(workspace):
                await asyncio.to_thread(
                    self.store.save_settings, workspace, {**settings, "pending_catch_up": False}
                )
                if settings.get("enabled"):
                    self._spawn(self.start_run(workspace, "catch_up"))

    async def _reclaim_timed_out(self, workspace: str, now: int) -> None:
        """Reclaim the pane of a run that timed out and never reported, once
        the grace from Settings → Resource limits has passed (0 = never)."""
        from . import resource_limits

        grace = resource_limits.evolve_timeout_reclaim_minutes(resource_limits.read_settings(self._limits))
        if grace <= 0:
            return
        for run in await asyncio.to_thread(self.store.timed_out_unreclaimed, workspace):
            if run["mode"] != "auto" or run["id"] in self._timeout_reclaims:
                continue
            if now - int(run.get("ended_at") or now) < grace * 60_000:
                continue
            self._timeout_reclaims.add(run["id"])
            self._spawn(self._reclaim(workspace, run["id"], run["pane_id"]))

    async def _watch_run(self, workspace: str, settings: dict[str, Any], run: dict[str, Any], now: int) -> None:
        fields: dict[str, Any] = {}
        tokens = self.host.pane_tokens(run["pane_id"]) if run["pane_id"] else None
        if tokens is not None and tokens != run.get("tokens"):
            fields["tokens"] = tokens
        budget = int(settings["token_budget"])
        if tokens is not None and tokens > budget * OVER_BUDGET_FACTOR and not run["interrupted"]:
            answer = await self.host.pane_action(workspace, "ui.pane.interrupt", run["pane_id"])
            fields["interrupted"] = True
            fields["detail"] = (str(run.get("detail") or "") + f" interrupted at {tokens} tokens"
                                + ("" if answer.get("ok") else " (interrupt not delivered)")).strip()
            await self._notice(workspace, "over_budget", {**run, **fields})
        if now - int(run["started_at"]) > int(settings["max_minutes"]) * 60_000:
            fields.update(status="timeout", reason="timeout", ended_at=now)
            await self._notice(workspace, "timeout", {**run, **fields})
        else:
            await self._nudge_if_idle(workspace, run, now)
        if fields:
            await asyncio.to_thread(self.store.update, workspace, run["id"], fields)
            await self._changed(workspace)

    async def _nudge_if_idle(self, workspace: str, run: dict[str, Any], now: int) -> None:
        """Tell a run's pane that sat idle without reporting to finish (bounded)."""
        key = workspace + "\0" + run["id"]
        entry = self.host.pane(run["pane_id"]) if run["pane_id"] else None
        since, sent = self._idle.get(key, (None, 0))
        if entry is None or getattr(entry, "busy", False) or getattr(entry, "offline", False):
            self._idle[key] = (None, sent)
            return
        if since is None:
            since = now
        self._idle[key] = (since, sent)
        if sent >= IDLE_NUDGE_MAX or now - since < IDLE_NUDGE_AFTER_S * 1000:
            return
        answer = await self.host.send(entry.pane_id, IDLE_NUDGE_TEXT.format(run_id=run["id"]))
        self._idle[key] = (now, sent + 1)
        await self._notice(workspace, "nudged", {**run, "nudges": sent + 1, "delivered": bool(answer.get("ok"))})

    # ── events ───────────────────────────────────────────────────────────

    async def _changed(self, workspace: str) -> None:
        try:
            await self.host.broadcast("evolve.changed", {"workspace": workspace, "badge": await self.badge(workspace)})
        except Exception as err:  # noqa: BLE001
            log.warning("evolve.changed broadcast failed: %s", err)

    async def _notice(self, workspace: str, kind: str, run: dict[str, Any]) -> None:
        try:
            await self.host.broadcast("evolve.notice", {"workspace": workspace, "kind": kind, "run": run})
        except Exception as err:  # noqa: BLE001
            log.warning("evolve.notice broadcast failed: %s", err)


def _clean_list(value: Any, keys: tuple[str, str]) -> list[dict[str, str]]:
    out = []
    for item in value if isinstance(value, list) else []:
        if isinstance(item, dict):
            out.append({key: mask(str(item.get(key) or ""))[:300] for key in keys})
    return out[:20]


_service: EvolveService | None = None


def get_service() -> EvolveService:
    global _service
    if _service is None:
        from . import app

        _service = EvolveService(app.workspace_databases, limits=lambda: app.ui_settings_store.get())
    return _service


async def shutdown() -> None:
    global _service
    if _service is not None:
        service, _service = _service, None
        await service.close()
