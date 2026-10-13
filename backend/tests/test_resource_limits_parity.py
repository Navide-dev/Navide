"""The renderer and the backend agree on every resource-limit key and default.

Settings writes the key in useResourceLimits.ts; resource_limits.py reads it.
Both sides spell the key and the default independently, so a typo on one side
would leave a limit that the UI shows as set and the backend never applies.
"""

from __future__ import annotations

import re
from pathlib import Path

from agent_team_backend import resource_limits

_TS = (Path(__file__).resolve().parents[2] / "src" / "renderer" / "src" / "composables"
       / "useResourceLimits.ts").read_text(encoding="utf-8")


def _ts_const(name: str) -> str:
    match = re.search(rf"export const {name} = (.+)", _TS)
    assert match, f"{name} not exported from useResourceLimits.ts"
    return match.group(1).strip()


def test_keys_match() -> None:
    assert _ts_const("TEST_MAX_WORKERS_KEY") == repr(resource_limits.TEST_WORKERS_KEY)
    assert _ts_const("EVOLVE_RECLAIM_KEY") == repr(resource_limits.EVOLVE_RECLAIM_KEY)
    assert _ts_const("TRACK_DETACHED_KEY") == repr(resource_limits.TRACK_DETACHED_KEY)


def test_defaults_and_bounds_match() -> None:
    assert int(_ts_const("TEST_MAX_WORKERS_MAX")) == resource_limits.TEST_WORKERS_MAX
    assert int(_ts_const("EVOLVE_RECLAIM_DEFAULT_MINUTES")) == resource_limits.EVOLVE_RECLAIM_DEFAULT_MINUTES
    assert eval(_ts_const("EVOLVE_RECLAIM_MAX_MINUTES")) == resource_limits.EVOLVE_RECLAIM_MAX_MINUTES  # noqa: S307 — a literal product
