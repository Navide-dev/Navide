"""How /plan-mcp is doing, for /health, backend.log and the window.

Two readings, kept apart on purpose:

- initialize outcomes the endpoint itself answered (every CLI and the main
  process' probe start with one). On 2026-11-08 every new connection failed
  there for hours while nothing else showed it.
- the main process' probe verdict, as the window reports it (``report``):
  "ok", "degraded" or "down". A probe that cannot reach the endpoint at all
  leaves no initialize behind, so only this reading sees it.

Both are counters and timestamps, nothing a credential or path is part of:
/health answers without a credential. Lines go to backend.log as
``key=value`` pairs so a watchdog schedule can grep them.

Updated from the /plan-mcp listener's own thread and from the main loop, so
a lock guards the state; the counters never await.

Recovery (``handle_report``, ``soft_restart``): a probe verdict turning "down"
restarts the listener's thread and loop once (own_loop.restart — same port, no
PTY touched; a whole-backend restart ends every pane and stays the user's
button). If the probe has not seen it answer again NOTICE_GRACE_S later, the
main bot's direct chat gets one notice.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from typing import Any

_log = logging.getLogger(__name__)

#: The probe verdicts the window may report.
PROBE_STATES = ("ok", "degraded", "down")
#: Cut an error text short before it reaches the log or /health.
_MAX_ERROR_CHARS = 200

_lock = threading.Lock()
_init_failures = 0
_init_consecutive = 0
_init_last_failure_at: float | None = None
_init_last_ok_at: float | None = None
_init_last_error = ""
_probe_state = ""
_probe_failures = 0
_probe_changed_at: float | None = None

#: How long a soft restart gets to show the probe an answer before the chat
#: is told. The probe retries every 30 s while failing (src/main/mcp-health.ts).
NOTICE_GRACE_S = 90.0
#: At most one automatic soft restart this often, however the verdict flaps.
AUTO_RESTART_MIN_INTERVAL_S = 600.0
_last_auto_restart_at: float | None = None
_notice_task: asyncio.Task[None] | None = None


def _clip(text: str) -> str:
    return " ".join(str(text).split())[:_MAX_ERROR_CHARS]


def record_initialize(ok: bool, error: str = "") -> None:
    """One initialize the endpoint answered: ok, or failed with ``error``."""
    global _init_failures, _init_consecutive, _init_last_failure_at, _init_last_ok_at, _init_last_error
    now = time.time()
    with _lock:
        if ok:
            recovered = _init_consecutive
            _init_consecutive = 0
            _init_last_ok_at = now
        else:
            recovered = 0
            _init_failures += 1
            _init_consecutive += 1
            _init_last_failure_at = now
            _init_last_error = _clip(error)
            total, consecutive, last_error = _init_failures, _init_consecutive, _init_last_error
    if ok:
        if recovered:
            _log.info("plan-mcp health: event=initialize_recovered after_failures=%d", recovered)
        return
    _log.warning(
        "plan-mcp health: event=initialize_failed total=%d consecutive=%d error=%s",
        total, consecutive, last_error or "unknown",
    )


def report(state: str, failures: int, error: str = "") -> bool:
    """The main process' probe verdict, as a window reports it. True when the
    state changed: every window reports the same verdict, so only the first
    report of a change is news (the notice goes out once)."""
    global _probe_state, _probe_failures, _probe_changed_at
    if state not in PROBE_STATES:
        raise ValueError(f"unknown MCP probe state: {state!r}")
    failures = max(0, int(failures))
    with _lock:
        changed = state != _probe_state
        previous = _probe_state
        _probe_state = state
        _probe_failures = failures
        if changed:
            _probe_changed_at = time.time()
    if changed and (previous or state != "ok"):
        level = logging.WARNING if state != "ok" else logging.INFO
        _log.log(
            level, "plan-mcp health: event=probe_%s previous=%s consecutive=%d error=%s",
            state, previous or "none", failures, _clip(error) or "none",
        )
    return changed


def snapshot() -> dict[str, Any]:
    """The /health block."""
    with _lock:
        return {
            "initialize_failures": _init_failures,
            "initialize_consecutive_failures": _init_consecutive,
            "initialize_last_failure_at": _init_last_failure_at,
            "initialize_last_ok_at": _init_last_ok_at,
            "probe_state": _probe_state or None,
            "probe_consecutive_failures": _probe_failures,
            "probe_changed_at": _probe_changed_at,
        }


async def soft_restart(trigger: str) -> dict[str, Any]:
    """Restart /plan-mcp's own thread and loop (own_loop.restart). ``trigger``:
    "auto" (the probe went down) or "user" (the status bar button)."""
    from agent_team_backend.mcp_server import own_loop

    try:
        result = await own_loop.restart()
    except Exception as err:  # noqa: BLE001 — reported, never raised into the caller
        result = {"ok": False, "reason": f"{type(err).__name__}: {_clip(str(err))}"}
    _log.log(
        logging.INFO if result.get("ok") else logging.WARNING,
        "plan-mcp health: event=soft_restart trigger=%s ok=%s reason=%s",
        trigger, bool(result.get("ok")), result.get("reason", "none"),
    )
    return result


async def handle_report(state: str, failures: int, error: str = "") -> dict[str, Any]:
    """A window's probe report: record it; on the turn to "down" restart MCP
    once and arm the chat notice; an "ok" disarms it."""
    global _last_auto_restart_at, _notice_task
    changed = report(state, failures, error)
    out: dict[str, Any] = {"changed": changed, "state": state}
    if state == "ok":
        if _notice_task is not None:
            _notice_task.cancel()
            _notice_task = None
        return out
    if not changed or state != "down":
        return out
    now = time.monotonic()
    if _last_auto_restart_at is None or now - _last_auto_restart_at >= AUTO_RESTART_MIN_INTERVAL_S:
        _last_auto_restart_at = now
        out["soft_restart"] = await soft_restart("auto")
    if _notice_task is None or _notice_task.done():
        _notice_task = asyncio.create_task(_notice_if_still_down())
    return out


async def _notice_if_still_down() -> None:
    await asyncio.sleep(NOTICE_GRACE_S)
    with _lock:
        still_down = _probe_state == "down"
    if not still_down:
        return
    from agent_team_backend.channels import get_manager

    manager = get_manager()
    _log.warning("plan-mcp health: event=still_down_after_soft_restart notice=%s",
                 "sent" if manager is not None else "no-channels")
    if manager is not None:
        try:
            await manager.notify_mcp_endpoint_down()
        except Exception as err:  # noqa: BLE001 — a chat failing must not end the loop
            _log.warning("plan-mcp health: the endpoint notice failed: %s", err)


def _reset_for_tests() -> None:
    global _init_failures, _init_consecutive, _init_last_failure_at, _init_last_ok_at, _init_last_error
    global _probe_state, _probe_failures, _probe_changed_at, _last_auto_restart_at, _notice_task
    if _notice_task is not None:
        _notice_task.cancel()
    _notice_task = None
    _last_auto_restart_at = None
    with _lock:
        _init_failures = _init_consecutive = _probe_failures = 0
        _init_last_failure_at = _init_last_ok_at = _probe_changed_at = None
        _init_last_error = _probe_state = ""
