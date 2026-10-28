"""Tainted panes: panes that received text from outside the local user.

A pane is marked when a message from a chat channel, another device, another
pane, or an MCP client is delivered into it; a human typing never marks it.
The mark lives in navide.db so it survives restarts, and it follows pane-id
aliases: a pane restored under a new id inherits its former id's mark.
Only the renderer (``guard.taint.clear`` ws request) clears it.

Every marking delivery is also recorded as an event carrying the message's
routing key, so the badge can show what was actually sent: the text itself
stays in the message log and is looked up by that key.
"""

from __future__ import annotations

import logging
import time

from . import runtime

log = logging.getLogger(__name__)


def _canonical(pane_id: str) -> str:
    from .. import agent_messaging

    pane = agent_messaging.current(pane_id)
    return pane.pane_id if pane is not None else pane_id


def _former_ids(canonical: str) -> list[str]:
    from .. import agent_messaging

    return [old for old, alias in agent_messaging._ALIASES.items() if alias.pane_id == canonical]


def _row(pane_id: str) -> dict | None:
    """The taint row for a pane, adopting a former id's row when needed."""
    store = runtime.store()
    canonical = _canonical(pane_id)
    row = store.taint_get(canonical)
    if row is not None:
        return row
    for old in _former_ids(canonical) + ([pane_id] if pane_id != canonical else []):
        prior = store.taint_get(old)
        if prior is not None:
            store.taint_upsert(canonical, prior["sources"], prior["since"], prior["detail"])
            store.taint_delete(old)
            store.taint_events_move(old, canonical)
            return store.taint_get(canonical)
    return None


def mark_tainted(pane_id: str, source: str, detail: str = "", msg_key: str = "") -> None:
    if not pane_id:
        return
    canonical = _canonical(pane_id)
    row = _row(canonical)
    now = time.time()
    runtime.store().taint_event_add(canonical, now, source, (detail or "")[:200], msg_key or "")
    if row is not None and source in row["sources"]:
        return
    sources = (row["sources"] if row else []) + [source]
    since = row["since"] if row else now
    runtime.store().taint_upsert(canonical, sources, since, (detail or "")[:200])
    if row is None:
        runtime.emit("guard.taint_changed", {"pane_id": canonical, "tainted": True})


def safe_mark_tainted(pane_id: str, source: str, detail: str = "", msg_key: str = "") -> None:
    """For delivery paths: marking must never break message delivery."""
    try:
        mark_tainted(pane_id, source, detail, msg_key)
    except Exception as err:  # noqa: BLE001
        log.warning("guard: could not mark pane %s tainted: %s", pane_id, err)


def is_tainted(pane_id: str) -> bool:
    return bool(pane_id) and _row(pane_id) is not None


def clear_taint(pane_id: str) -> None:
    canonical = _canonical(pane_id)
    removed = False
    for pid in {canonical, pane_id, *_former_ids(canonical)}:
        removed = runtime.store().taint_delete(pid) or removed
        runtime.store().taint_events_delete(pid)
    if removed:
        runtime.emit("guard.taint_changed", {"pane_id": canonical, "tainted": False})


def list_tainted() -> list[dict]:
    """Rows under each pane's current id: a restored pane's row stays under its
    former id until a lookup adopts it, and the window only knows the new id."""
    rows: dict[str, dict] = {}
    for row in runtime.store().taint_list():
        pane_id = _canonical(row["pane_id"])
        rows.setdefault(pane_id, {**row, "pane_id": pane_id})
    return list(rows.values())


# ── pipeline runs ────────────────────────────────────────────────────────
# A pipeline's panes are spawned and handed their kickoffs by the window, so
# none of it passes a delivery seam. A run started by a tainted caller taints
# every pane it spawns: pipeline_start arms the workspace before asking the
# window, the window's pipeline.start adopts the arming for that run (a start
# nobody armed clears it), and each slot the run records is marked. In memory
# only: panes already marked stay marked across a restart, respawns after one
# do not inherit.
_ARMED_RUNS: dict[str, str] = {}
_TAINTED_RUNS: dict[str, str] = {}


def _ws_key(workspace: str) -> str:
    from .. import agent_messaging

    return agent_messaging._normalize_workspace(workspace)


def arm_pipeline_run(workspace: str, detail: str) -> None:
    _ARMED_RUNS[_ws_key(workspace)] = detail


def disarm_pipeline_run(workspace: str) -> None:
    _ARMED_RUNS.pop(_ws_key(workspace), None)


def pipeline_run_started(workspace: str) -> None:
    key = _ws_key(workspace)
    detail = _ARMED_RUNS.pop(key, None)
    if detail:
        _TAINTED_RUNS[key] = detail
    else:
        _TAINTED_RUNS.pop(key, None)


def pipeline_pane_spawned(workspace: str, pane_id: str) -> None:
    detail = _TAINTED_RUNS.get(_ws_key(workspace))
    if detail:
        safe_mark_tainted(pane_id, "agent", detail)


def pipeline_run_taint(workspace: str) -> str:
    """The taint detail of the workspace's run ('' when it is clean)."""
    return _TAINTED_RUNS.get(_ws_key(workspace), "")


def restore_pipeline_run_taint(workspace: str, detail: str) -> None:
    """Put back a parent run's taint when it resumes after its sub-pipeline."""
    key = _ws_key(workspace)
    if detail:
        _TAINTED_RUNS[key] = detail
    else:
        _TAINTED_RUNS.pop(key, None)


def _reset_pipeline_runs_for_test() -> None:
    _ARMED_RUNS.clear()
    _TAINTED_RUNS.clear()


def taint_events(pane_id: str) -> list[dict]:
    """A pane's marking deliveries, newest first, each with the delivered
    message looked up in the message log by its routing key. ``message`` is
    None when the path minted no key or the log has pruned the row."""
    from .. import app

    canonical = _canonical(pane_id)
    events = runtime.store().taint_events(sorted({canonical, pane_id, *_former_ids(canonical)}))
    messages = app.agent_message_log.by_correlation([e["msg_key"] for e in events if e["msg_key"]])
    return [{**e, "message": messages.get(e["msg_key"])} for e in events]
