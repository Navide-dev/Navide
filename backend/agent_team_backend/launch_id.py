"""Which app launch is running, and which one ran before it.

A pane's CLI lives inside this backend process, so "the CLI was live when the
app last closed" means "spawned during the previous backend lifetime and not
reclaimed since". Startup draws a fresh id and keeps the one before it in
ui_settings, where the renderer's 'auto' resume scope reads the previous one;
every spawn record stamps the current one (PaneRecord.last_live_launch).
"""

from __future__ import annotations

import uuid
from typing import Any

CURRENT_KEY = "agentTeam.launchId"
PREVIOUS_KEY = "agentTeam.previousLaunchId"

_current = ""


def rotate(store: Any) -> str:
    """Move the stored current id to previous and store a new current one."""
    global _current
    previous = store.get().get(CURRENT_KEY)
    _current = uuid.uuid4().hex
    store.set({PREVIOUS_KEY: previous if isinstance(previous, str) else "", CURRENT_KEY: _current})
    return _current


def current() -> str:
    """This launch's id; "" before startup rotated it."""
    return _current
