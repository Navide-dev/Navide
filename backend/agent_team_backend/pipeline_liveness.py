"""Is a stored ``running`` pipeline run still driven by a window?

The run engine lives in the renderer; the backend only stores the run record.
A record left at ``running`` by a crashed app would otherwise read as active
forever: pipeline_status reported ``active: true`` and definition edits were
refused until the workspace was opened again.

The backend cannot simply rewrite such records at start-up: it is restarted
on its own when it crashes (src/main/backend-autorestart.ts) while the windows
and their runs live on. So nothing is rewritten. Instead each main window
claims its run on every (re)connect (``pipeline.claim``, an empty list when it
has none), and starting, resuming or spawning a stage claims it too. A stored
running run is *interrupted* only when nobody claims it AND either

- a window holding its workspace has synced (claimed) without it, or
- no window holds the workspace and :data:`CLAIM_GRACE_S` has passed since
  this backend started — time for windows that survived an auto-restart to
  reconnect.

A window holding the workspace that has not synced yet keeps the run active,
as before. Nothing is judged before any window has claimed at all in this
backend's lifetime (every Navide window claims as it connects, so this only
holds a backend no window ever reached, such as a test process): a run is then
active exactly as it always was. An interrupted run is still resumable: its record is untouched, so
opening the workspace offers resume exactly as it always did.
"""

from __future__ import annotations

import os
import time
from typing import Any

#: Seconds after this backend started during which an unheld, unclaimed run
#: still counts as active (windows reconnecting after an auto-restart).
CLAIM_GRACE_S = 30.0

_started_at = time.monotonic()
#: Set by the first claim any window sends to this backend.
_claims_seen = False


def _norm(path: str) -> str:
    return os.path.normpath(str(path)).rstrip("/") if path else ""


def _holds(paths: Any, workspace_path: str) -> bool:
    want = _norm(workspace_path)
    return any(_norm(p) == want for p in (paths or ()) if isinstance(p, str))


def record_claim(session: Any, workspaces: list[str]) -> None:
    """A window's full claim: the runs it drives now (replaces earlier ones)."""
    global _claims_seen
    _claims_seen = True
    session.pipeline_claimed = True
    session.pipeline_runs = {_norm(p) for p in workspaces if isinstance(p, str) and p}


def claim_run(session: Any, workspace_path: str) -> None:
    """The window behind ``session`` drives this workspace's run."""
    if not workspace_path:
        return
    runs = set(getattr(session, "pipeline_runs", set()) or set())
    runs.add(_norm(workspace_path))
    session.pipeline_runs = runs


def is_interrupted(project: Any) -> bool:
    """True for a stored running run no window drives any more."""
    if project is None or getattr(project, "state", "") != "running" or not _claims_seen:
        return False
    from . import app

    ws = getattr(project, "workspace_path", "")
    live = [s for s in list(app._SESSIONS) if not getattr(s, "dead", False)]
    if any(_holds(getattr(s, "pipeline_runs", ()), ws) for s in live):
        return False
    owners = [s for s in app.main_window_sessions() if _holds(getattr(s, "held_workspaces", ()), ws)]
    if owners:
        return all(getattr(s, "pipeline_claimed", False) for s in owners)
    return time.monotonic() - _started_at >= CLAIM_GRACE_S


def run_is_live(project: Any) -> bool:
    """True while the run is ``running`` and not :func:`is_interrupted`."""
    return project is not None and getattr(project, "state", "") == "running" and not is_interrupted(project)
