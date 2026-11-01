"""Shared plumbing for usage snapshots — importable by vendor modules.

Extracted from ``usage_service`` so ``cli_vendors/<name>.py`` files can build
snapshots without importing ``usage_service`` (which imports the vendor
registry — the reverse edge would be a cycle). ``usage_service`` re-exports
everything here, so its module namespace is unchanged for existing callers
and tests.

Imports nothing from this package on purpose; keep it that way.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

HTTP_TIMEOUT = 30.0

# Fallback cooldown when a 429 carries no usable Retry-After (seconds).
RATE_LIMIT_COOLDOWN = 300.0


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _epoch_to_iso(sec: Any) -> str | None:
    try:
        return datetime.fromtimestamp(float(sec), timezone.utc).isoformat()
    except (TypeError, ValueError, OSError, OverflowError):
        return None


def _num(v: Any) -> float | None:
    """Kimi returns numbers as int, float or string interchangeably."""
    if isinstance(v, bool) or v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _clamp_pct(v: float) -> float:
    return max(0.0, min(100.0, v))


_UNSET = object()


def _window(kind: str, label: str, used_percent: float, resets_at: str | None,
            window_minutes: Any = _UNSET) -> dict:
    w = {
        "kind": kind,
        "label": label,
        "usedPercent": round(_clamp_pct(used_percent), 1),
        "resetsAt": resets_at,
    }
    if window_minutes is not _UNSET:
        w["windowMinutes"] = window_minutes
    return w


def _snapshot(provider: str, status: str, *, windows: list[dict] | None = None,
              plan_type: str | None = None, error: str | None = None) -> dict:
    return {
        "provider": provider,
        "status": status,
        "planType": plan_type,
        "windows": windows or [],
        "fetchedAt": _now_iso(),
        "error": error,
    }


def parse_retry_after(value: str | None) -> float:
    try:
        return max(1.0, float(value))  # seconds form only; date form -> default
    except (TypeError, ValueError):
        return RATE_LIMIT_COOLDOWN


# A failed Keychain read (denied prompt, timeout) is remembered for this many
# seconds so we don't re-prompt every poll; a transient failure self-heals.
_KEYCHAIN_COOLDOWN_S = 300.0


async def communicate_or_kill(proc: Any, timeout: float) -> bytes:
    """``proc.communicate()`` under a deadline; on timeout the child is killed
    and reaped before the TimeoutError propagates. A bare ``wait_for`` leaves
    a hung ``security``/``gh``/CLI child running (and unreaped) forever."""
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except (ProcessLookupError, OSError):
            pass
        try:
            await proc.wait()
        except (ProcessLookupError, OSError):
            pass
        raise
    return out
