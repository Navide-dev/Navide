"""User-adjustable resource limits (Settings → General → Resource limits).

Two rules hold for every limit here. Its default is what Navide did before
the limit existed, so nothing that works today changes until the user turns
it on. And it fails open: an unreadable store or a malformed value means "no
limit", never a blocked spawn or a refused action.

The values live in the shared UI settings store (ui_settings), which the
renderer writes and both sides read; the keys below are the contract.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from typing import Any

log = logging.getLogger("agent_team_backend.resource_limits")

# Test-runner worker cap. 0 (the default) is off. Turned on, new panes carry
# TEST_WORKERS_ENV, which this repo's vitest.config.ts reads to cap its pool.
TEST_WORKERS_KEY = "agentTeam.limits.testMaxWorkers"
TEST_WORKERS_ENV = "NAVIDE_TEST_MAX_WORKERS"
TEST_WORKERS_MAX = 64


# The app installs the live store's reader at startup (set_settings_reader);
# code with no handle on the store (terminals) asks current(). Before that,
# and in tests that do not install one, every limit reads its default.
_settings_reader: Callable[[], Mapping[str, Any]] = dict


def set_settings_reader(reader: Callable[[], Mapping[str, Any]]) -> None:
    global _settings_reader
    _settings_reader = reader


def current() -> Mapping[str, Any]:
    return read_settings(_settings_reader)


def read_settings(get: Callable[[], Mapping[str, Any]]) -> Mapping[str, Any]:
    """The settings snapshot, or an empty one when the store cannot answer."""
    try:
        values = get()
    except Exception as err:  # noqa: BLE001 — fail open
        log.warning("resource limits: settings unreadable, no limits applied: %s", err)
        return {}
    return values if isinstance(values, Mapping) else {}


def _int_setting(settings: Mapping[str, Any], key: str, *, low: int, high: int) -> int | None:
    """An integer in [low, high], or None for anything else (unset, junk,
    out of range) — the caller treats None as its default."""
    raw = settings.get(key)
    if isinstance(raw, bool):
        return None
    if isinstance(raw, str):
        raw = raw.strip()
    try:
        value = int(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return value if low <= value <= high else None


def test_worker_cap(settings: Mapping[str, Any]) -> int:
    """The configured worker cap, or 0 for off."""
    return _int_setting(settings, TEST_WORKERS_KEY, low=1, high=TEST_WORKERS_MAX) or 0


# Reclaim (never close) a self-evolution pane whose run timed out without
# reporting, this many minutes after the timeout. 0 is off. The default is on:
# the run is already over, and a reclaimed pane resumes with one click.
EVOLVE_RECLAIM_KEY = "agentTeam.limits.evolveTimeoutReclaimMinutes"
EVOLVE_RECLAIM_DEFAULT_MINUTES = 30
EVOLVE_RECLAIM_MAX_MINUTES = 24 * 60


def evolve_timeout_reclaim_minutes(settings: Mapping[str, Any]) -> int:
    """Grace before a timed-out run's pane is reclaimed, or 0 for never."""
    value = _int_setting(settings, EVOLVE_RECLAIM_KEY, low=0, high=EVOLVE_RECLAIM_MAX_MINUTES)
    return EVOLVE_RECLAIM_DEFAULT_MINUTES if value is None else value


# Mark each new pane's environment so a server it leaves behind can be listed
# (detached_servers). On by default: the marker is one inert variable, and the
# list is only ever built when the user asks for it.
TRACK_DETACHED_KEY = "agentTeam.limits.trackDetachedServers"


def track_detached(settings: Mapping[str, Any]) -> bool:
    """False only for an explicit off; anything unreadable keeps the default."""
    return settings.get(TRACK_DETACHED_KEY) not in (False, 0, "0", "false")


def spawn_env(settings: Mapping[str, Any]) -> dict[str, str]:
    """Env a new pane gets from the enabled limits — empty when none are on."""
    env: dict[str, str] = {}
    cap = test_worker_cap(settings)
    if cap:
        env[TEST_WORKERS_ENV] = str(cap)
    return env
