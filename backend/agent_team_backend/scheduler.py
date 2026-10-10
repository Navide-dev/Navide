"""Navide's in-process scheduler: wakes a CLI pane with an instruction on time.

The scheduler only decides *when*. What happens at that moment is exactly one
existing path — the one ``cli_send(open_target=True)`` takes: resolve the pane,
open it first if it is a restore placeholder, hand the text to the owning
window and wait a bounded time for that window's delivery verdict. Nothing here
writes to a PTY, so the idle gate, echo verification, typing hold and per-pair
rate limit all apply to a scheduled message just as they do to an agent's.

Every job has an ``owner``. A change made in a Navide window acts as the user,
who may change any job; an agent (an MCP caller) may change only the jobs it
created. A job whose creating pane is gone belongs to nobody an agent can act
as, so only the user can change it — see :func:`may_change`.

A job may also be owned by Navide itself (``{kind: "system"}``): a feature
such as a workspace's self-evolution keeps its clock here. Nobody changes such
a job through this module's public API — not an agent and not the user, whose
window shows it read-only — only the feature that owns it, acting as that same
system owner. A system job is not an agent's: no agent limits, no expiry.

Jobs an agent owns are also limited (the user's own jobs are not): at most
AGENT_ENABLED_PER_OWNER enabled per owner and AGENT_ENABLED_TOTAL enabled in
all, no interval under AGENT_MIN_EVERY_MS, AGENT_RUNS_PER_DAY_TOTAL runs a day
between them (an agent's run_now included), a periodic job disables itself
AGENT_EXPIRE_MS after it was last saved or enabled unless the user keeps it,
and a finished once job is deleted AGENT_ONCE_KEEP_MS after it ran.

It runs only while the backend runs. Slots missed while Navide was closed are
caught up at most once per job (``catch_up: "once"``) or dropped (``"skip"``).

A ``once`` job has a single slot. Its first scheduled run — ok, error or
skipped — disables it; the job and its state stay for inspection.

Loop structure follows usage_service: a ``_wake`` event plus
``wait_for(timeout=_next_sleep)``; the sleep is the distance to the nearest due
job, capped at 60s and floored at 2s. The clock and the sleep are injectable
(cli_risk style), so tests drive time instead of waiting for it.

Invariant (OpenClaw #13992 / #16156 / #17852): ``next_run_at`` moves forward
only when its slot actually ran or was judged skipped. Reads and re-saves never
advance an overdue value — otherwise a daily job silently becomes a 48-hour one.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Awaitable, Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .scheduler_store import SchedulerStore

log = logging.getLogger(__name__)

MAX_SLEEP_S = 60.0
MIN_SLEEP_S = 2.0
#: Consecutive-failure backoff ladder; a success resets it. A periodic job is
#: never disabled automatically, however long it keeps failing.
BACKOFF_S = (30, 60, 300, 900, 3600)
#: Catch-up after a restart: this many run right away, the rest are spaced
#: CATCH_UP_SPACING_S apart — all of them strictly one after another.
CATCH_UP_BURST = 5
CATCH_UP_SPACING_S = 5.0
#: A restarted backend comes up before any window does, so catch-up waits for a
#: window (and then briefly for its panes to register) instead of skipping every
#: missed job as "no_window".
CATCH_UP_WINDOW_WAIT_S = 120.0
CATCH_UP_SETTLE_S = 10.0
#: How long one run waits for the receiving window's delivery verdict — the
#: same wait cli_send's wait_for_delivery_s performs.
DELIVERY_WAIT_S = 30.0

MIN_EVERY_MS = 60_000
MAX_EVERY_MS = 7 * 24 * 3600 * 1000
#: A once job may be saved up to this far in the past (it then fires right
#: away) and no further ahead than MAX_ONCE_AHEAD_MS.
ONCE_PAST_GRACE_MS = 60_000
MAX_ONCE_AHEAD_MS = 10 * 365 * 24 * 3600 * 1000
DEFAULT_POLICY: dict[str, Any] = {"catch_up": "once", "max_runs_per_day": 24, "timeout_s": 1800}
_MAX_NAME = 200
_MAX_TEXT = 64 * 1024
_AT_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")

#: Skip reasons — a skip is an expected state, never an error: it does not
#: count toward consecutive_errors and does not trigger backoff.
SKIP_NO_WINDOW = "no_window"
SKIP_BUSY = "busy"
SKIP_BUDGET = "budget"
SKIP_TARGET_GONE = "target_gone"
SKIP_MISSED = "missed"
SKIP_INTERRUPTED = "interrupted"
#: An agent-owned job skipped because agent jobs used up the day's total.
SKIP_BUDGET_GLOBAL = "budget_global"
#: An agent-owned periodic job disabled because it expired.
SKIP_EXPIRED = "expired"
#: A pane-id target that is gone (unknown-pane-id, never target-offline) this
#: many runs in a row disables the job and tells its owner — or the user — once.
#: A skip is still not an error; this is the one skip that stops a job.
TARGET_GONE_DISABLE_AFTER = 3

AGENT_ENABLED_PER_OWNER = 10
AGENT_ENABLED_TOTAL = 100
AGENT_MIN_EVERY_MS = 5 * 60_000
AGENT_MAX_RUNS_PER_DAY = 288
AGENT_RUNS_PER_DAY_TOTAL = 300
AGENT_EXPIRE_MS = 7 * 24 * 3600 * 1000
AGENT_ONCE_KEEP_MS = 30 * 24 * 3600 * 1000


#: The actor behind a change made in a Navide window.
USER: dict[str, Any] = {"kind": "user"}
NOT_OWNER = "SCHEDULER_NOT_OWNER"
#: The owner kind of a job Navide itself keeps for one of its features.
SYSTEM = "system"
#: The refusal code for any change to a system job made through the public API.
SYSTEM_JOB = "SCHEDULER_SYSTEM_JOB"
LIMIT = "SCHEDULER_LIMIT"


class JobInvalid(ValueError):
    """A job definition that cannot be saved; the message is caller-facing."""


# ── schedule arithmetic ─────────────────────────────────────────────────────


def _zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def _local_ms(day: date, at: str, tz: ZoneInfo) -> int:
    """Epoch ms of wall-clock ``at`` on ``day`` in ``tz``.

    Built from the calendar date rather than by adding 24h, so a DST switch
    moves the UTC instant and keeps the wall-clock time. A wall time that does
    not exist that day (spring-forward gap) resolves with fold=0, i.e. just
    after the gap; an ambiguous one (fall-back) takes its first occurrence.
    """
    hour, minute = (int(part) for part in at.split(":"))
    when = datetime(day.year, day.month, day.day, hour, minute, tzinfo=tz)
    return int(when.timestamp() * 1000)


def next_run_after(schedule: dict[str, Any], after_ms: int) -> int | None:
    """The first slot strictly later than ``after_ms`` (epoch ms).

    None only for a once job whose moment has passed: it has no next slot.
    """
    kind = schedule.get("kind")
    if kind == "once":
        at = int(schedule["at_ms"])
        return at if at > after_ms else None
    if kind == "every":
        every = int(schedule["every_ms"])
        anchor = int(schedule["anchor_ms"])
        if after_ms < anchor:
            return anchor
        return anchor + ((after_ms - anchor) // every + 1) * every
    tz = _zone(str(schedule.get("tz") or "UTC"))
    at = str(schedule["at"])
    today = datetime.fromtimestamp(after_ms / 1000, tz).date()
    days = set(schedule.get("days") or range(1, 8)) if kind == "weekly" else set(range(1, 8))
    for offset in range(0, 9):
        day = today + timedelta(days=offset)
        if day.isoweekday() not in days:
            continue
        candidate = _local_ms(day, at, tz)
        if candidate > after_ms:
            return candidate
    raise ValueError(f"schedule has no slot: {schedule!r}")


def _day_start_ms(schedule: dict[str, Any], now_ms: int) -> int:
    """Local midnight of ``now_ms`` in the job's zone (system zone for every)."""
    tz = schedule.get("tz")
    zone = _zone(str(tz)) if tz else datetime.now().astimezone().tzinfo or timezone.utc
    local = datetime.fromtimestamp(now_ms / 1000, zone)
    return int(local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)


# ── the one validator (WS scheduler.upsert and MCP scheduler_upsert) ────────


def _require_str(obj: dict, key: str, what: str, *, limit: int = 4096) -> str:
    value = obj.get(key)
    if not isinstance(value, str) or not value.strip():
        raise JobInvalid(f"{what} is required")
    if len(value) > limit:
        raise JobInvalid(f"{what} is too long")
    return value.strip()


def _int(value: Any, what: str, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value:
        raise JobInvalid(f"{what} must be an integer")
    if not low <= int(value) <= high:
        raise JobInvalid(f"{what} must be between {low} and {high}")
    return int(value)


def _valid_tz(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise JobInvalid("schedule.tz is required (an IANA zone such as \"Asia/Taipei\")")
    try:
        ZoneInfo(value.strip())
    except (ZoneInfoNotFoundError, ValueError):
        raise JobInvalid(f'unknown time zone "{value}"') from None
    return value.strip()


def _valid_at(value: Any) -> str:
    if not isinstance(value, str) or not _AT_RE.match(value.strip()):
        raise JobInvalid('schedule.at must be "HH:MM" (24-hour)')
    return value.strip()


def _normalize_schedule(raw: Any, now_ms: int, previous: dict | None) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise JobInvalid("schedule must be an object")
    kind = raw.get("kind")
    if kind == "every":
        every = _int(raw.get("every_ms"), "schedule.every_ms", MIN_EVERY_MS, MAX_EVERY_MS)
        anchor = raw.get("anchor_ms")
        if anchor is None:
            # Keep the phase an unchanged interval already had.
            same = previous and previous.get("kind") == "every" and previous.get("every_ms") == every
            anchor = previous["anchor_ms"] if same else now_ms
        anchor = _int(anchor, "schedule.anchor_ms", 0, 2**53)
        return {"kind": "every", "every_ms": every, "anchor_ms": anchor}
    if kind == "daily":
        return {"kind": "daily", "at": _valid_at(raw.get("at")), "tz": _valid_tz(raw.get("tz"))}
    if kind == "weekly":
        days = raw.get("days")
        if not isinstance(days, list) or not days:
            raise JobInvalid("schedule.days must be a non-empty list of 1 (Mon) .. 7 (Sun)")
        clean = sorted({_int(d, "schedule.days[]", 1, 7) for d in days})
        return {
            "kind": "weekly", "days": clean,
            "at": _valid_at(raw.get("at")), "tz": _valid_tz(raw.get("tz")),
        }
    if kind == "once":
        if raw.get("at_ms") is not None:
            at = _int(raw["at_ms"], "schedule.at_ms", 0, 2**53)
        elif raw.get("in_ms") is not None:
            at = now_ms + _int(raw["in_ms"], "schedule.in_ms", 0, MAX_ONCE_AHEAD_MS)
        else:
            raise JobInvalid("schedule.at_ms or schedule.in_ms is required for a once job")
        # An unchanged moment is not re-checked: renaming a job that already
        # ran must not fail because its time is now in the past.
        unchanged = previous is not None and previous.get("kind") == "once" and previous.get("at_ms") == at
        if not unchanged:
            if at < now_ms - ONCE_PAST_GRACE_MS:
                raise JobInvalid("schedule.at_ms is in the past; pick a future time")
            if at > now_ms + MAX_ONCE_AHEAD_MS:
                raise JobInvalid("schedule.at_ms is more than 10 years ahead")
        return {"kind": "once", "at_ms": at}
    raise JobInvalid('schedule.kind must be "every", "daily", "weekly" or "once"')


def _normalize_action(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise JobInvalid("action must be an object")
    if raw.get("kind") == "evolve":
        # A workspace's self-evolution run: no pane, no text — the feature
        # that owns the job decides both when it fires.
        return {"kind": "evolve", "workspace": _require_str(raw, "workspace", "action.workspace")}
    if raw.get("kind") != "message":
        raise JobInvalid('action.kind must be "message"')
    action: dict[str, Any] = {
        "kind": "message",
        "workspace": _require_str(raw, "workspace", "action.workspace"),
    }
    for key in ("pane_id", "pane_name"):
        value = raw.get(key)
        if value is None or value == "":
            continue
        if not isinstance(value, str) or not value.strip() or "/" in value or len(value) > 256:
            raise JobInvalid(f"action.{key} must be a pane id / name without '/'")
        action[key] = value.strip()
    if "pane_id" not in action and "pane_name" not in action:
        raise JobInvalid("action needs pane_id or pane_name")
    action["text"] = _require_str(raw, "text", "action.text", limit=_MAX_TEXT)
    return action


def _normalize_policy(raw: Any, previous: dict[str, Any] | None) -> dict[str, Any]:
    """Validate ``raw`` key by key over ``previous`` (defaults for a new job)."""
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise JobInvalid("policy must be an object")
    policy = {**DEFAULT_POLICY, **(previous or {})}
    if raw.get("catch_up") is not None:
        if raw["catch_up"] not in ("once", "skip"):
            raise JobInvalid('policy.catch_up must be "once" or "skip"')
        policy["catch_up"] = raw["catch_up"]
    if raw.get("max_runs_per_day") is not None:
        policy["max_runs_per_day"] = _int(raw["max_runs_per_day"], "policy.max_runs_per_day", 1, 1440)
    if raw.get("timeout_s") is not None:
        policy["timeout_s"] = _int(raw["timeout_s"], "policy.timeout_s", 60, 86400)
    return policy


def _initial_state() -> dict[str, Any]:
    return {
        "next_run_at": None,
        "running_at": None,
        "last_run_at": None,
        "last_status": None,
        "last_skip_reason": None,
        "last_error": None,
        "last_duration_ms": None,
        "consecutive_errors": 0,
        "backoff_until": None,
        "last_msg_key": None,
        "consecutive_target_gone": 0,
        "disabled_reason": None,
    }


def _clear_target_gone(state: dict[str, Any]) -> None:
    """Forget a gone-target streak: the job was re-enabled or now aims elsewhere."""
    state["consecutive_target_gone"] = 0
    state["disabled_reason"] = None


def _once_rearm(schedule: dict[str, Any], now_ms: int) -> int:
    """The slot a re-enabled once job waits for; refuses one whose time passed."""
    slot = next_run_after(schedule, now_ms)
    if slot is None:
        raise JobInvalid(
            "this once job's time has passed; set a new schedule.at_ms or in_ms to enable it"
        )
    return slot


def normalize_job(raw: Any, existing: dict[str, Any] | None, now_ms: int) -> dict[str, Any]:
    """Validate a job from a client and merge it onto the stored one.

    The single validator shared by the WS handler and the MCP tool. ``state``
    is server-owned: anything the client sends there is ignored. ``next_run_at``
    is recomputed only when the schedule changes or the job is (re-)enabled —
    never merely because the job was saved again (see the module invariant).

    Updating an existing job is partial: a field left out (or null) keeps its
    stored value, and ``policy`` merges key by key. ``action``, when sent, is
    validated whole — never merged — so a target cannot end up half old, half
    new.
    """
    if not isinstance(raw, dict):
        raise JobInvalid("job must be an object")

    def keep(key: str) -> bool:
        return existing is not None and raw.get(key) is None

    name = existing["name"] if keep("name") else _require_str(raw, "name", "name", limit=_MAX_NAME)
    enabled = raw.get("enabled")
    if enabled is None:
        enabled = existing["enabled"] if existing else True
    if not isinstance(enabled, bool):
        raise JobInvalid("enabled must be true or false")
    schedule = (
        dict(existing["schedule"]) if keep("schedule") else _normalize_schedule(
            raw.get("schedule"), now_ms, existing["schedule"] if existing else None
        )
    )
    action = dict(existing["action"]) if keep("action") else _normalize_action(raw.get("action"))
    policy = _normalize_policy(raw.get("policy"), existing["policy"] if existing else None)
    state = dict(existing["state"]) if existing else _initial_state()
    changed = existing is None or schedule != existing["schedule"]
    reenabled = existing is not None and enabled and not existing["enabled"]
    if schedule["kind"] == "once":
        if changed:
            # Its one slot, even if it lies within the grace minute behind now.
            state["next_run_at"] = schedule["at_ms"]
        elif reenabled:
            state["next_run_at"] = _once_rearm(schedule, now_ms)
    elif changed or reenabled or state.get("next_run_at") is None:
        state["next_run_at"] = next_run_after(schedule, now_ms)
    if reenabled or (existing is not None and action != existing["action"]):
        _clear_target_gone(state)
    return {
        "id": existing["id"] if existing else str(uuid.uuid4()),
        "name": name,
        "enabled": enabled,
        "created_at": existing["created_at"] if existing else now_ms,
        "updated_at": now_ms,
        "schedule": schedule,
        "action": action,
        "policy": policy,
        "state": state,
    }


# ── ownership ───────────────────────────────────────────────────────────────


def owner_of(actor: dict[str, Any]) -> dict[str, Any]:
    """The owner record of a job ``actor`` creates."""
    if actor.get("kind") == "pane":
        return {key: actor.get(key, "") for key in ("kind", "pane_id", "pane_name", "workspace")}
    if actor.get("kind") == SYSTEM:
        return {key: actor.get(key, "") for key in ("kind", "feature", "workspace")}
    return {"kind": actor.get("kind") or "external"}


def system_owner(feature: str, workspace: str) -> dict[str, Any]:
    """The owner (and actor) record of a job Navide keeps for ``feature``."""
    return {"kind": SYSTEM, "feature": feature, "workspace": workspace}


def is_system(who: dict[str, Any] | None) -> bool:
    """Whether an owner or actor is Navide itself."""
    return (who or USER).get("kind") == SYSTEM


def is_agent(who: dict[str, Any] | None) -> bool:
    """Whether an owner or actor is an agent (anything but the user or Navide)."""
    return (who or USER).get("kind") not in ("user", SYSTEM)


def _owner_pane(owner: dict[str, Any]) -> str | None:
    """The live pane id a pane owner resolves to now, or None once it is gone.

    Resolved through the alias table: reattaching a pane mints a new id, and the
    job still belongs to the pane the old one became.
    """
    from . import agent_messaging

    entry = agent_messaging.current(str(owner.get("pane_id") or ""))
    return entry.pane_id if entry is not None else None


def owner_gone(owner: dict[str, Any]) -> bool:
    return owner.get("kind") == "pane" and _owner_pane(owner) is None


def may_change(actor: dict[str, Any], job: dict[str, Any]) -> bool:
    """The user may change any job; an agent only a job it created itself."""
    owner = job.get("owner") or USER
    if is_system(owner):
        # Checked before the user's blanket right: the user changes a system
        # job through the feature that owns it, never directly.
        return is_system(actor) and owner_of(actor) == owner_of(owner)
    if is_system(actor):
        return False  # a feature acts only on its own job
    if not is_agent(actor):
        return True
    if owner.get("kind") == "pane":
        return actor.get("kind") == "pane" and _owner_pane(owner) == actor.get("pane_id")
    return owner.get("kind") == "external" and actor.get("kind") == "external"


def _system_job(job: dict[str, Any]) -> dict[str, Any]:
    owner = job.get("owner") or USER
    return {
        "ok": False,
        "code": SYSTEM_JOB,
        "error": f'this job belongs to Navide\'s "{owner.get("feature") or "system"}" feature for '
        f'{owner.get("workspace") or "a workspace"}; change it from that workspace '
        "(sidebar workspace menu → Self-evolution), not from the Schedule panel",
        "owner": dict(owner),
    }


def _not_owner(job: dict[str, Any]) -> dict[str, Any]:
    owner = job.get("owner") or USER
    if is_system(owner):
        return _system_job(job)
    if not is_agent(owner):
        why = "this job was created by the user"
    elif owner_gone(owner):
        why = "the pane that created this job is gone, so only the user can change it now"
    else:
        name = owner.get("pane_name") or owner.get("kind")
        why = f'this job belongs to another agent ("{name}")'
    return {
        "ok": False,
        "code": NOT_OWNER,
        "error": f"{why}; an agent may only change jobs it created — ask the user to change it "
        "in Navide's Schedule panel, or create a job of your own",
        "owner": dict(owner),
    }


def _limit(limit: str, bound: int, used: int, error: str) -> dict[str, Any]:
    """An agent limit refusal. ``max`` is the bound, a minimum for an interval."""
    return {"ok": False, "code": LIMIT, "limit": limit, "max": bound, "used": used, "error": error}


def _agent_definition_limit(job: dict[str, Any]) -> dict[str, Any] | None:
    schedule = job["schedule"]
    if schedule["kind"] == "every" and schedule["every_ms"] < AGENT_MIN_EVERY_MS:
        return _limit(
            "min_every_ms", AGENT_MIN_EVERY_MS, schedule["every_ms"],
            "an agent's job may run at most every 5 minutes (every_ms >= 300000); "
            "to watch a pane, use cli_wait_idle instead",
        )
    runs = int(job["policy"].get("max_runs_per_day", DEFAULT_POLICY["max_runs_per_day"]))
    if runs > AGENT_MAX_RUNS_PER_DAY:
        return _limit(
            "max_runs_per_day", AGENT_MAX_RUNS_PER_DAY, runs,
            f"an agent's job may run at most {AGENT_MAX_RUNS_PER_DAY} times a day",
        )
    return None


def _stamp_expiry(job: dict[str, Any], now: int, *, refresh: bool) -> None:
    """Set an agent-owned periodic job's expiry; a once job has none.

    ``expires_at: None`` means the user chose to keep the job; that is never
    overwritten.
    """
    owner = dict(job.get("owner") or USER)
    if not is_agent(owner):
        return
    if job["schedule"]["kind"] == "once":
        owner.pop("expires_at", None)
    elif "expires_at" in owner and owner["expires_at"] is None:
        return
    elif refresh or "expires_at" not in owner:
        owner["expires_at"] = now + AGENT_EXPIRE_MS
    job["owner"] = owner


def _usage_day(now_ms: int) -> str:
    """The local calendar day the agent run total is counted in."""
    return datetime.fromtimestamp(now_ms / 1000).date().isoformat()


def view(job: dict[str, Any]) -> dict[str, Any]:
    """A job as clients see it: with ``owner_gone`` for a pane owner that is gone."""
    return {**job, "owner_gone": owner_gone(job.get("owner") or USER)}


# ── bridge to the existing delivery path ────────────────────────────────────


class LiveBridge:
    """What the service needs from the rest of the backend, in one seam.

    Tests swap this for a fake; production reaches cli_send's own send path in
    the MCP server module (imported late — it imports this package's app).
    """

    def has_window(self) -> bool:
        from . import app

        return any(not getattr(s, "dead", False) for s in list(app._SESSIONS))

    def still_queued(self, msg_key: str | None) -> bool:
        """True while this job's previous message still waits in the target's queue."""
        if not msg_key:
            return False
        from .mcp_server import server as mcp

        entry = mcp._mcp_message_status.get(msg_key)
        return entry is not None and entry.get("status") == "queued"

    async def budget_limited(self, action: dict[str, Any]) -> bool:
        """True when the target pane's CLI is marked out of quota in the usage cache.

        Cache only — never asks a vendor for a fresh reading.
        """
        from . import agent_messaging
        from .usage_service import service

        entry = None
        if action.get("pane_id"):
            entry = agent_messaging.current(action["pane_id"])
        elif action.get("pane_name"):
            entry = agent_messaging.resolve("", _qualified(action)).pane
        if entry is None or not entry.agent_key:
            return False
        try:
            payload = await asyncio.to_thread(service.payload)
        except Exception:  # noqa: BLE001 — no reading is not "limited"
            return False
        snap = (payload.get("providers") or {}).get(entry.agent_key)
        if not isinstance(snap, dict):
            return False
        if snap.get("status") == "rate-limited":
            return True
        for window in snap.get("windows") or []:
            used = window.get("usedPercent") if isinstance(window, dict) else None
            if isinstance(used, (int, float)) and used >= 100:
                return True
        return False

    async def deliver(self, action: dict[str, Any]) -> dict[str, Any]:
        """Send through cli_send's path with open_target=True; map its answer."""
        from .mcp_server import server as mcp

        answer = await mcp._send(
            mcp._Caller(kind="host"),
            "" if action.get("pane_id") else _qualified(action),
            action["text"],
            wait_for_delivery_s=DELIVERY_WAIT_S,
            pane_id=action.get("pane_id") or "",
            open_target=True,
            taint_detail=action.get(TAINT_KEY) or "",
        )
        return outcome_of_send(answer)

    async def deliver_evolve(self, action: dict[str, Any], manual: bool) -> dict[str, Any]:
        """Start a workspace's self-evolution run; the evolve service answers
        with a run outcome of the same shape :meth:`deliver` returns."""
        from . import evolve_service

        return await evolve_service.get_service().start_from_scheduler(
            action["workspace"], manual=manual
        )

    async def notify_disabled(self, job: dict[str, Any]) -> None:
        """Tell whoever should know that ``job`` stopped because its target is gone.

        The owner pane hears it as a message, through the same path; when the
        owner is the user, or a pane that is gone too, every window gets a
        ``scheduler.job_disabled`` event to show the user instead.
        """
        from . import app
        from .ipc import make_event
        from .mcp_server import server as mcp

        owner = job.get("owner") or USER
        name = job.get("name") or job.get("id")
        target = (job.get("action") or {}).get("pane_id") or ""
        count = (job.get("state") or {}).get("consecutive_target_gone") or TARGET_GONE_DISABLE_AFTER
        pane = _owner_pane(owner) if owner.get("kind") == "pane" else None
        if pane is not None:
            text = (
                f'[Navide scheduler] Your job "{name}" (id {job.get("id")}) was disabled: '
                f"its target pane {target} was gone {count} runs in a row. Point it at a live "
                "pane with scheduler_upsert and enable it again, or remove it."
            )
            answer = await mcp._send(
                mcp._Caller(kind="host"), "", text, pane_id=pane, open_target=False,
            )
            if answer.get("ok"):
                return
            log.warning("scheduler: could not tell owner pane %s: %s", pane, answer.get("error"))
        await app.broadcast(make_event("scheduler.job_disabled", {
            "id": job.get("id"), "name": name, "reason": SKIP_TARGET_GONE,
            "pane_id": target, "count": count,
        }))


#: Carries "scheduled by <agent>" from a job to LiveBridge.deliver; never stored.
TAINT_KEY = "_guard_taint_detail"


def _with_origin(job: dict[str, Any]) -> dict[str, Any]:
    """The job's action, marked for Navide Guard when an agent wrote it.

    Agent-authored means the owner or the last editor is an agent. A job the
    user adopted is the user's again ("make it mine" is the user vouching for
    it); a job saved before owners were recorded counts as the user's.
    """
    action = job["action"]
    who = next((w for w in (job.get("updated_by"), job.get("owner")) if w and is_agent(w)), None)
    if who is None:
        return action
    name = who.get("pane_name") or who.get("pane_id") or who.get("kind")
    return {**action, TAINT_KEY: f"scheduled by {name}"}


def _qualified(action: dict[str, Any]) -> str:
    """``<workspace path>/<pane name>`` — the qualified form cli_send resolves."""
    return f"{str(action['workspace']).rstrip('/')}/{action['pane_name']}"


def outcome_of_send(answer: dict[str, Any]) -> dict[str, Any]:
    """Map a cli_send answer to a run outcome {status, reason?, detail?, msg_key?}."""
    if not answer.get("ok"):
        code = str(answer.get("error_code") or "")
        detail = str(answer.get("error") or "send refused")
        if code == "target-offline":
            return {"status": "skipped", "reason": SKIP_NO_WINDOW, "detail": detail}
        if code == "unknown-pane-id":
            # Never fall back to another pane of the same name.
            return {"status": "skipped", "reason": SKIP_TARGET_GONE, "detail": detail}
        return {"status": "error", "reason": code or None, "detail": detail}
    msg_key = answer.get("msg_key")
    status = answer.get("status")
    if status in ("failed", "rejected"):
        return {
            "status": "error", "reason": status,
            "detail": str(answer.get("reason") or status), "msg_key": msg_key,
        }
    if status == "queued":
        hold = (answer.get("hold") or {}).get("key") or "pending"
        return {"status": "ok", "detail": f"queued ({hold})", "msg_key": msg_key}
    return {"status": "ok", "detail": str(status or "sent"), "msg_key": msg_key}


# ── the service ─────────────────────────────────────────────────────────────


Notify = Callable[[list[dict[str, Any]]], Awaitable[None]]


async def _broadcast_jobs(jobs: list[dict[str, Any]], exclude: Any = None) -> None:
    from . import app
    from .ipc import make_event

    await app.broadcast(make_event("scheduler.changed", {"jobs": jobs}), exclude=exclude)


class SchedulerService:
    def __init__(
        self,
        store: SchedulerStore,
        *,
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
        bridge: Any = None,
        notify: Notify | None = None,
    ) -> None:
        self.store = store
        self.clock = clock
        self._sleep = sleep
        self.bridge = bridge or LiveBridge()
        self._notify = notify or _broadcast_jobs
        self._wake = asyncio.Event()
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._catch_up_task: asyncio.Task | None = None
        self._catch_up_pending: set[str] = set()
        self._runs: dict[str, tuple[asyncio.Task, bool]] = {}
        self._ticking = False

    def now_ms(self) -> int:
        return int(self.clock() * 1000)

    def wake(self) -> None:
        self._wake.set()

    # ── lifecycle ────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Clear leftovers of the previous run, plan catch-up, start the loop."""
        now = self.now_ms()
        overdue: list[dict[str, Any]] = []
        async with self._lock:
            for job in await self.store.list_jobs():
                state = job["state"]
                if state.get("running_at") is not None:
                    # Interrupted by the restart: cleared, and not caught up
                    # this round.
                    state["running_at"] = None
                    await self._record_skip(job, now, SKIP_INTERRUPTED, "backend restarted mid-run")
                    continue
                if state.get("next_run_at") is None:
                    state["next_run_at"] = next_run_after(job["schedule"], now)
                    await self.store.set_state(job["id"], state)
                    continue
                if job["enabled"] and state["next_run_at"] <= now:
                    if job["policy"].get("catch_up") == "skip":
                        await self._record_skip(job, now, SKIP_MISSED, "missed while Navide was closed")
                    else:
                        overdue.append(job)
        overdue.sort(key=lambda j: j["state"]["next_run_at"])
        if overdue:
            self._catch_up_pending = {job["id"] for job in overdue}
            self._catch_up_task = asyncio.create_task(self._catch_up([j["id"] for j in overdue]))
        self._task = asyncio.create_task(self._run())

    async def close(self) -> None:
        tasks = [t for t in (self._task, self._catch_up_task) if t is not None]
        tasks += [task for task, _manual in self._runs.values()]
        for task in tasks:
            task.cancel()
        for task in tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._task = self._catch_up_task = None
        self._runs.clear()

    async def _run(self) -> None:
        while True:
            self._wake.clear()
            try:
                delay = await self.tick()
            except Exception as err:  # noqa: BLE001 — the loop must survive anything
                log.warning("scheduler tick failed: %s", err)
                delay = MAX_SLEEP_S
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass

    async def _catch_up(self, job_ids: list[str]) -> None:
        """Run missed jobs once each, strictly in sequence, burst then spaced."""
        waited = 0.0
        while not self.bridge.has_window() and waited < CATCH_UP_WINDOW_WAIT_S:
            await self._sleep(MIN_SLEEP_S)
            waited += MIN_SLEEP_S
        if waited:
            await self._sleep(CATCH_UP_SETTLE_S)
        try:
            for index, job_id in enumerate(job_ids):
                if index >= CATCH_UP_BURST:
                    await self._sleep(CATCH_UP_SPACING_S)
                self._catch_up_pending.discard(job_id)
                job = await self.store.get_job(job_id)
                if job is None or not job["enabled"] or job["state"].get("running_at") is not None:
                    continue
                task = await self._fire(job, self.now_ms())
                if task is not None:
                    await asyncio.shield(task)
        finally:
            self._catch_up_pending.clear()
            self.wake()

    # ── engine ───────────────────────────────────────────────────────────

    async def tick(self) -> float:
        """Fire every due job; return how long to sleep before the next tick."""
        if self._ticking:
            return MAX_SLEEP_S
        self._ticking = True
        try:
            now = self.now_ms()
            nearest: int | None = None

            def consider(at: int) -> None:
                nonlocal nearest
                nearest = at if nearest is None else min(nearest, at)

            for job in await self.store.list_jobs():
                if await self._sweep_agent_job(job, now):
                    continue
                state = job["state"]
                running_at = state.get("running_at")
                if running_at is not None:
                    deadline = running_at + int(job["policy"].get("timeout_s", 1800)) * 1000
                    if now >= deadline:
                        await self._fail_stuck(job["id"], now)
                    else:
                        consider(deadline)
                    continue
                if not job["enabled"] or job["id"] in self._catch_up_pending:
                    continue
                backoff = state.get("backoff_until")
                if backoff is not None and now < backoff:
                    consider(backoff)
                    continue
                due = state.get("next_run_at")
                if due is None:
                    continue
                if now < due:
                    consider(due)
                    continue
                await self._fire(job, now)
            if nearest is None:
                return MAX_SLEEP_S
            return max(MIN_SLEEP_S, min(MAX_SLEEP_S, (nearest - now) / 1000))
        finally:
            self._ticking = False

    async def _sweep_agent_job(self, job: dict[str, Any], now: int) -> bool:
        """Expire or delete an agent-owned job whose time is up; True if it was."""
        owner = job.get("owner") or USER
        if not is_agent(owner) or job["state"].get("running_at") is not None:
            return False
        expires = owner.get("expires_at")
        if job["enabled"] and isinstance(expires, int) and now >= expires:
            async with self._lock:
                fresh = await self.store.get_job(job["id"])
                if fresh is None or not fresh["enabled"] or fresh["state"].get("running_at"):
                    return True
                state = fresh["state"]
                state["last_status"] = "skipped"
                state["last_skip_reason"] = SKIP_EXPIRED
                await self.store.set_enabled(job["id"], False, state, now)
                await self.store.append_run(job["id"], {
                    "started_at": now, "ended_at": now, "status": "skipped",
                    "reason": SKIP_EXPIRED,
                    "detail": "an agent's periodic job stops 7 days after it was last saved "
                    "or enabled, unless the user keeps it",
                })
            await self._changed()
            return True
        if (
            not job["enabled"] and job["schedule"]["kind"] == "once"
            and now - int(job["updated_at"]) >= AGENT_ONCE_KEEP_MS
        ):
            async with self._lock:
                await self.store.delete_job(job["id"])
            await self._changed()
            return True
        return False

    async def _gate(self, job: dict[str, Any], now: int) -> str | None:
        if not self.bridge.has_window():
            return SKIP_NO_WINDOW
        if self.bridge.still_queued(job["state"].get("last_msg_key")):
            return SKIP_BUSY
        cap = int(job["policy"].get("max_runs_per_day", DEFAULT_POLICY["max_runs_per_day"]))
        used = await self.store.count_dispatched_since(job["id"], _day_start_ms(job["schedule"], now))
        if used >= cap or await self.bridge.budget_limited(job["action"]):
            return SKIP_BUDGET
        if is_agent(job.get("owner")) and await self._agent_runs_spent(now):
            return SKIP_BUDGET_GLOBAL
        return None

    async def _agent_runs_spent(self, now: int) -> bool:
        return await self.store.usage(_usage_day(now)) >= AGENT_RUNS_PER_DAY_TOTAL

    async def _agent_enable_limit(
        self, actor: dict[str, Any], job_id: str | None
    ) -> dict[str, Any] | None:
        """Refusal when ``actor`` enabling one more job would pass a limit.
        Only agent-owned jobs count, and ``job_id`` itself is not counted."""
        enabled = [
            other for other in await self.store.list_jobs()
            if other["enabled"] and other["id"] != job_id and is_agent(other.get("owner"))
        ]
        mine = sum(1 for other in enabled if may_change(actor, other))
        if mine >= AGENT_ENABLED_PER_OWNER:
            return _limit(
                "per_owner_enabled", AGENT_ENABLED_PER_OWNER, mine,
                f"you already have {mine} enabled jobs, the most an agent may have; "
                "disable or remove one of yours first, or ask the user",
            )
        if len(enabled) >= AGENT_ENABLED_TOTAL:
            return _limit(
                "global_enabled", AGENT_ENABLED_TOTAL, len(enabled),
                f"agents already have {len(enabled)} enabled jobs between them, the most "
                "allowed; disable or remove one of yours first, or ask the user",
            )
        return None

    async def _fire(self, job: dict[str, Any], now: int) -> asyncio.Task | None:
        reason = await self._gate(job, now)
        if reason is not None:
            async with self._lock:
                fresh = await self.store.get_job(job["id"])
                if fresh is not None and fresh["state"].get("running_at") is None:
                    await self._record_skip(fresh, now, reason, None)
            await self._changed()
            return None
        return await self._start(job["id"], manual=False, count=is_agent(job.get("owner")))

    async def _start(
        self, job_id: str, *, manual: bool, count: bool = False
    ) -> asyncio.Task | None:
        """Start a run. ``count`` adds it to the day's agent run total."""
        async with self._lock:
            job = await self.store.get_job(job_id)
            if job is None or job["state"].get("running_at") is not None:
                return None
            started = self.now_ms()
            # A scheduled start comes from a listing read before this lock; a
            # run that finished meanwhile moved next_run_at past now.
            due = job["state"].get("next_run_at")
            if not manual and due is not None and due > started:
                return None
            job["state"]["running_at"] = started
            # Written before anything is dispatched: this is the reentry lock.
            await self.store.set_state(job_id, job["state"])
            if count:
                await self.store.add_usage(_usage_day(started))
            task = asyncio.create_task(self._execute(job, started, manual))
            self._runs[job_id] = (task, manual)
        await self._changed()
        return task

    async def _execute(self, job: dict[str, Any], started: int, manual: bool) -> None:
        try:
            if job["action"].get("kind") == "evolve":
                outcome = await self.bridge.deliver_evolve(job["action"], manual)
            else:
                outcome = await self.bridge.deliver(_with_origin(job))
        except asyncio.CancelledError:
            raise
        except Exception as err:  # noqa: BLE001 — a failed run is an error row
            outcome = {"status": "error", "detail": str(err) or type(err).__name__}
        await self._finish(job["id"], started, outcome, manual)

    async def _finish(
        self, job_id: str, started: int, outcome: dict[str, Any], manual: bool
    ) -> None:
        disabled = None
        try:
            disabled = await self._settle(job_id, started, outcome, manual)
        finally:
            entry = self._runs.get(job_id)
            if entry is not None and entry[0] is asyncio.current_task():
                self._runs.pop(job_id, None)
        await self._changed()
        if disabled is not None:
            try:
                await self.bridge.notify_disabled(disabled)
            except Exception as err:  # noqa: BLE001 — the job is disabled either way
                log.warning("scheduler: disabled-job notice failed: %s", err)

    async def _settle(
        self, job_id: str, started: int, outcome: dict[str, Any], manual: bool
    ) -> dict[str, Any] | None:
        """Record a finished run. Returns the job when this run disabled it
        because its target stayed gone — the caller notifies, outside the lock."""
        async with self._lock:
            job = await self.store.get_job(job_id)
            if job is None or job["state"].get("running_at") != started:
                return None  # removed, or already settled by the stuck sweep
            now = self.now_ms()
            state = job["state"]
            status = outcome["status"]
            state["running_at"] = None
            state["last_run_at"] = started
            state["last_duration_ms"] = max(0, now - started)
            state["last_status"] = status
            state["last_skip_reason"] = outcome.get("reason") if status == "skipped" else None
            if outcome.get("msg_key"):
                state["last_msg_key"] = outcome["msg_key"]
            if status == "ok":
                state["consecutive_errors"] = 0
                state["backoff_until"] = None
                state["last_error"] = None
            elif status == "error":
                errors = int(state.get("consecutive_errors") or 0) + 1
                state["consecutive_errors"] = errors
                state["backoff_until"] = now + BACKOFF_S[min(errors, len(BACKOFF_S)) - 1] * 1000
                state["last_error"] = outcome.get("detail") or outcome.get("reason") or "error"
            if status == "skipped" and outcome.get("reason") == SKIP_TARGET_GONE:
                state["consecutive_target_gone"] = int(state.get("consecutive_target_gone") or 0) + 1
            elif status != "skipped":
                state["consecutive_target_gone"] = 0
            # Only an enabled job can be stopped by this run, so a manual run of
            # one already stopped never notifies a second time.
            gone_out = (
                job["enabled"]
                and state["consecutive_target_gone"] >= TARGET_GONE_DISABLE_AFTER
            )
            if gone_out:
                state["disabled_reason"] = SKIP_TARGET_GONE
            if not manual:
                state["next_run_at"] = next_run_after(job["schedule"], now)
            if gone_out or (not manual and job["schedule"]["kind"] == "once"):
                await self.store.set_enabled(job_id, False, state, now)
            else:
                await self.store.set_state(job_id, state)
            await self.store.append_run(job_id, {
                "started_at": started, "ended_at": now, "status": status,
                "reason": outcome.get("reason"), "detail": outcome.get("detail"),
            })
            return {**job, "enabled": False, "state": state} if gone_out else None

    async def _fail_stuck(self, job_id: str, now: int) -> None:
        entry = self._runs.pop(job_id, None)
        manual = entry[1] if entry else False
        if entry is not None:
            entry[0].cancel()
        job = await self.store.get_job(job_id)
        if job is None or job["state"].get("running_at") is None:
            return
        await self._finish(
            job_id, job["state"]["running_at"],
            {"status": "error", "reason": "timeout", "detail": "run exceeded policy.timeout_s"},
            manual,
        )

    async def _record_skip(
        self, job: dict[str, Any], now: int, reason: str, detail: str | None
    ) -> None:
        """Skipped slot: advance next_run_at, leave the error count alone."""
        state = job["state"]
        state["last_status"] = "skipped"
        state["last_skip_reason"] = reason
        state["next_run_at"] = next_run_after(job["schedule"], now)
        if job["schedule"]["kind"] == "once":
            await self.store.set_enabled(job["id"], False, state, now)
        else:
            await self.store.set_state(job["id"], state)
        await self.store.append_run(job["id"], {
            "started_at": now, "ended_at": now, "status": "skipped",
            "reason": reason, "detail": detail,
        })

    async def _changed(self) -> None:
        try:
            await self._notify([view(job) for job in await self.store.list_jobs()])
        except Exception as err:  # noqa: BLE001 — a notify failure must not stop a run
            log.warning("scheduler.changed broadcast failed: %s", err)

    # ── API shared by the WS handlers and the MCP tools ──────────────────

    async def list(self) -> dict[str, Any]:
        jobs = [view(job) for job in await self.store.list_jobs()]
        now = self.now_ms()
        limits = {
            "agent_enabled_per_owner": AGENT_ENABLED_PER_OWNER,
            "agent_enabled_total": AGENT_ENABLED_TOTAL,
            "agent_enabled": sum(1 for j in jobs if j["enabled"] and is_agent(j["owner"])),
            "agent_min_every_ms": AGENT_MIN_EVERY_MS,
            "agent_max_runs_per_day": AGENT_MAX_RUNS_PER_DAY,
            "agent_runs_per_day": AGENT_RUNS_PER_DAY_TOTAL,
            "agent_runs_today": await self.store.usage(_usage_day(now)),
            "agent_expire_ms": AGENT_EXPIRE_MS,
            "agent_once_keep_ms": AGENT_ONCE_KEEP_MS,
        }
        return {"ok": True, "jobs": jobs, "now": now, "limits": limits}

    async def upsert(self, raw: Any, actor: dict[str, Any] = USER) -> dict[str, Any]:
        """Create or update a job on behalf of ``actor``.

        Raises :class:`JobInvalid` for a bad definition; a job ``actor`` may not
        change answers ``{ok: false, code: SCHEDULER_NOT_OWNER}``.
        """
        job_id = raw.get("id") if isinstance(raw, dict) else None
        async with self._lock:
            existing = None
            if job_id:
                if not isinstance(job_id, str):
                    raise JobInvalid("id must be a string")
                existing = await self.store.get_job(job_id)
                if existing is None:
                    raise JobInvalid(f'unknown job id "{job_id}"')
                if not may_change(actor, existing):
                    return _not_owner(existing)
            now = self.now_ms()
            job = normalize_job(raw, existing, now)
            if job["action"].get("kind") == "evolve" and not is_system(actor):
                raise JobInvalid(
                    'action.kind "evolve" is kept by Navide; turn self-evolution on '
                    "from the workspace instead"
                )
            job["owner"] = existing["owner"] if existing else owner_of(actor)
            job["updated_by"] = owner_of(actor)
            enabling = job["enabled"] and (existing is None or not existing["enabled"])
            if is_agent(actor):
                refusal = _agent_definition_limit(job)
                if refusal is None and enabling:
                    refusal = await self._agent_enable_limit(actor, job["id"])
                if refusal is not None:
                    return refusal
            _stamp_expiry(job, now, refresh=is_agent(actor) or enabling)
            await self.store.put_job(job)
        self.wake()
        return {"ok": True, "job": view(job)}

    async def remove(self, job_id: str, actor: dict[str, Any] = USER) -> dict[str, Any]:
        async with self._lock:
            job = await self.store.get_job(job_id)
            if job is None:
                return {"ok": False, "error": f'unknown job id "{job_id}"'}
            if not may_change(actor, job):
                return _not_owner(job)
            await self.store.delete_job(job_id)
            entry = self._runs.pop(job_id, None)
        if entry is not None:
            entry[0].cancel()
        self.wake()
        return {"ok": True}

    async def adopt(self, job_id: str) -> dict[str, Any]:
        """Make a job the user's ("make it mine"); only a window calls this."""
        async with self._lock:
            job = await self.store.get_job(job_id)
            if job is None:
                return {"ok": False, "error": f'unknown job id "{job_id}"'}
            if is_system(job.get("owner")):
                return _system_job(job)
            job["owner"] = dict(USER)
            job["updated_by"] = dict(USER)
            job["updated_at"] = self.now_ms()
            await self.store.put_job(job)
        return {"ok": True, "job": view(job)}

    async def keep(self, job_id: str) -> dict[str, Any]:
        """Stop an agent's job from expiring ("keep"); only a window calls this."""
        async with self._lock:
            job = await self.store.get_job(job_id)
            if job is None:
                return {"ok": False, "error": f'unknown job id "{job_id}"'}
            if is_system(job.get("owner")):
                return _system_job(job)
            if not is_agent(job["owner"]):
                return {"ok": False, "error": "only an agent's job expires"}
            job["owner"] = {**job["owner"], "expires_at": None}
            job["updated_by"] = dict(USER)
            job["updated_at"] = self.now_ms()
            await self.store.put_job(job)
        self.wake()
        return {"ok": True, "job": view(job)}

    async def set_enabled(
        self, job_id: str, enabled: bool, actor: dict[str, Any] = USER
    ) -> dict[str, Any]:
        async with self._lock:
            job = await self.store.get_job(job_id)
            if job is None:
                return {"ok": False, "error": f'unknown job id "{job_id}"'}
            if not may_change(actor, job):
                return _not_owner(job)
            owner = None
            if enabled and not job["enabled"]:
                if is_agent(actor):
                    refusal = await self._agent_enable_limit(actor, job_id)
                    if refusal is not None:
                        return refusal
                _stamp_expiry(job, self.now_ms(), refresh=True)
                owner = job["owner"]
            state = job["state"]
            if enabled and not job["enabled"]:
                # Re-enabling never fires a slot that passed while disabled.
                if job["schedule"]["kind"] == "once":
                    try:
                        state["next_run_at"] = _once_rearm(job["schedule"], self.now_ms())
                    except JobInvalid as err:
                        return {"ok": False, "error": str(err)}
                else:
                    state["next_run_at"] = next_run_after(job["schedule"], self.now_ms())
                _clear_target_gone(state)
                state["rebound_needs_enable"] = False
            await self.store.set_enabled(
                job_id, enabled, state, self.now_ms(), updated_by=owner_of(actor), owner=owner
            )
        self.wake()
        return {"ok": True}

    async def run_now(self, job_id: str, actor: dict[str, Any] = USER) -> dict[str, Any]:
        """Start one run immediately, outside the schedule; answers before it ends.

        Bypasses the skip gates (the user asked for it) but not the reentry
        lock. Clears any backoff window, which is what "repair" needs; the
        error count resets only if this run succeeds.
        """
        async with self._lock:
            job = await self.store.get_job(job_id)
            if job is None:
                return {"ok": False, "error": f'unknown job id "{job_id}"'}
            if not may_change(actor, job):
                return _not_owner(job)
            if job["state"].get("running_at") is not None:
                return {"ok": False, "error": "that job is already running"}
            if is_agent(actor):
                now = self.now_ms()
                used = await self.store.usage(_usage_day(now))
                if used >= AGENT_RUNS_PER_DAY_TOTAL:
                    return _limit(
                        "agent_runs_per_day", AGENT_RUNS_PER_DAY_TOTAL, used,
                        "agents' jobs have used up today's runs; try again tomorrow, "
                        "or ask the user to run it",
                    )
            if job["state"].get("backoff_until") is not None:
                job["state"]["backoff_until"] = None
                await self.store.set_state(job_id, job["state"])
        task = await self._start(job_id, manual=True, count=is_agent(actor))
        if task is None:
            return {"ok": False, "error": "that job is already running"}
        return {"ok": True, "enqueued": True}

    async def system_put(
        self, job_id: str, raw: dict[str, Any], owner: dict[str, Any]
    ) -> dict[str, Any]:
        """Create or update the system job ``job_id`` for the feature ``owner`` names.

        The one way a system job is written: the id is the feature's own (so a
        workspace has exactly one), and the owner never changes. Raises
        :class:`JobInvalid` for a bad definition, like :meth:`upsert`.
        """
        if not is_system(owner):
            raise JobInvalid("system_put needs a system owner")
        async with self._lock:
            existing = await self.store.get_job(job_id)
            if existing is not None and not may_change(owner, existing):
                return _not_owner(existing)
            now = self.now_ms()
            job = normalize_job(raw, existing, now)
            job["id"] = job_id
            job["owner"] = owner_of(owner)
            job["updated_by"] = owner_of(owner)
            await self.store.put_job(job)
        self.wake()
        await self._changed()
        return {"ok": True, "job": view(job)}

    async def rebind_after_rebuild(
        self, previous_pane_id: str, pane_id: str, previous_session_id: str, session_id: str
    ) -> list[str]:
        """Move jobs aimed at a rebuilt pane's old id onto its new id.

        Only along the session lineage: the rebuild must have resumed exactly
        the session the old pane held. A different or unknown session is a
        different conversation, and a pane name is never evidence at all — the
        same rule outcome_of_send keeps for a gone id. The job's owner and
        updated_by stay as they were (this is not an edit by anyone, and must
        not mark a user's job as agent-written); ``state.rebound_from`` records
        the hop. Returns the ids of the jobs moved.
        """
        if not (previous_pane_id and pane_id and session_id) or previous_pane_id == pane_id:
            return []
        if previous_session_id != session_id:
            return []
        moved: list[str] = []
        async with self._lock:
            for job in await self.store.list_jobs():
                if job["action"].get("pane_id") != previous_pane_id:
                    continue
                job["action"] = {**job["action"], "pane_id": pane_id}
                job["state"]["rebound_from"] = previous_pane_id
                # The target is back, so a stopped job no longer reads as
                # aimed at nothing; it still waits for someone to switch it on.
                _clear_target_gone(job["state"])
                if job["state"].get("last_skip_reason") == SKIP_TARGET_GONE:
                    job["state"]["last_skip_reason"] = None
                if not job["enabled"]:
                    job["state"]["rebound_needs_enable"] = True
                await self.store.put_job(job)
                moved.append(job["id"])
        if moved:
            log.info("scheduler: rebound %s from pane %s to %s", moved, previous_pane_id, pane_id)
            await self._changed()
            self.wake()
        return moved

    async def runs(self, job_id: str, limit: int = 20) -> dict[str, Any]:
        if await self.store.get_job(job_id) is None:
            return {"ok": False, "error": f'unknown job id "{job_id}"'}
        return {"ok": True, "runs": await self.store.list_runs(job_id, max(1, min(int(limit), 200)))}


_service: SchedulerService | None = None


def get_service() -> SchedulerService:
    """The process-wide scheduler, built on the global database on first use."""
    global _service
    if _service is None:
        from . import app

        _service = SchedulerService(SchedulerStore(app.database))
    return _service


async def broadcast_changed(exclude: Any = None) -> None:
    """Push the whole job list to every window (optionally minus the requester)."""
    jobs = await get_service().store.list_jobs()
    await _broadcast_jobs([view(job) for job in jobs], exclude=exclude)


async def shutdown() -> None:
    """Stop the loop and any in-flight run (app shutdown).

    The instance is dropped too: its asyncio primitives belong to this loop.
    """
    global _service
    if _service is not None:
        service, _service = _service, None
        await service.close()
