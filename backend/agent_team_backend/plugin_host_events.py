"""Host event source for the plugin `agents.*` events (events.subscribe, E1).

The backend observes its own pane registry, message log, plan documents,
pipeline node states and scheduler, and broadcasts each change as one
``plugins.host_event`` frame. The Electron Host is the only consumer that acts
on it: it picks the workspace's plugins whose Manifest declares that event under
``permissions.agents.events`` and whose user Grant holds ``agents``, and emits
the ``payload`` to them unchanged. Windows ignore the frame.

Metadata only. Every payload is a fixed allowlist projection, like
``agents_host_api``: no message text, no plan body, no node summary or output,
no session id, no account, profile, usage or credential field. Message text is
still reachable only through ``agentMessages.read``, which is disclosed and
granted separately. This module must not import the account, quota or
credential modules (the agents_host_api guard test covers it as well).
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

#: The WS event type the Host listens for.
EVENT_TYPE = "plugins.host_event"

#: Event addresses, in the order the capability catalog lists them. Pinned by
#: tests against capabilities-v1.json: adding one is a contract change.
EVENTS = (
    "agents.paneCreated",
    "agents.paneClosed",
    "agents.turnEnded",
    "agents.paneIdle",
    "agents.messageReceived",
    "agents.planStageChanged",
    "agents.pipelineNodeChanged",
    "agents.scheduleFired",
)

_loop: asyncio.AbstractEventLoop | None = None
#: pane_id -> (workspace, name, busy, display_status) for every registered
#: pane: the registry has already dropped the entry when it reports
#: "unregister", and a status change is a transition only against the last one.
_panes: dict[str, tuple[str, str, bool, str]] = {}
#: workspace -> plan file path -> (mtime_ns, stage). A workspace's first scan
#: only fills it: stages that were already there are not changes.
_plan_stages: dict[str, dict[str, tuple[int, str]]] = {}


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _emit(event: str, workspace_path: str, payload: dict[str, Any]) -> None:
    """Schedule one broadcast on the backend loop; safe from any thread."""
    loop = _loop
    if loop is None or loop.is_closed() or not workspace_path:
        return
    from .ipc import make_event

    frame = make_event(EVENT_TYPE, {
        "event": event,
        "workspace_path": workspace_path,
        "payload": payload,
    })

    async def send() -> None:
        from . import app

        await app.broadcast(frame)

    def schedule() -> None:
        task = loop.create_task(send())
        task.add_done_callback(_log_failure)

    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is loop:
        schedule()
    else:
        loop.call_soon_threadsafe(schedule)


def _log_failure(task: asyncio.Task[None]) -> None:
    if not task.cancelled() and task.exception() is not None:
        log.warning("plugin host event broadcast failed: %s", task.exception())


def on_registry(event: str, pane_id: str) -> None:
    """agent_messaging pane listener: created, closed, turn ended, idle."""
    from . import agent_messaging, login_panes

    if event == "unregister":
        known = _panes.pop(pane_id, None)
        if known is not None:
            _emit("agents.paneClosed", known[0], {"paneId": pane_id, "name": known[1]})
        return
    entry = agent_messaging.get(pane_id)
    if entry is None or login_panes.is_login_pane(pane_id):
        return
    workspace = entry.workspace_path
    status = _text(entry.display_status)
    previous = _panes.get(pane_id)
    _panes[pane_id] = (workspace, entry.name, bool(entry.busy), status)
    if event == "register":
        if previous is None:
            _emit("agents.paneCreated", workspace, {
                "paneId": pane_id,
                "name": entry.name,
                "agentKey": _text(entry.agent_key),
                "spawnedBy": _text(entry.spawned_by),
            })
        return
    if event != "status" or previous is None:
        return
    base = {"paneId": pane_id, "name": entry.name}
    if previous[2] and not entry.busy:
        _emit("agents.turnEnded", workspace, base)
    if status == "idle" and previous[3] != "idle":
        _emit("agents.paneIdle", workspace, base)


def on_message_rows(rows: list[dict[str, Any]]) -> None:
    """agent_messaging message-row listener: a message reached a pane of the
    recipient's workspace. Metadata only, the projection agents.listMessages
    returns (bodyLength, never the text)."""
    from .agents_host_api import _message

    for row in rows:
        workspace = _text(row.get("recipient_workspace"))
        if not workspace or row.get("remote") or not row.get("uid"):
            continue
        _emit("agents.messageReceived", workspace, _message(row))


def _scan_plan_stages(workspace_path: str) -> dict[str, tuple[int, str]]:
    """Stage of every plan document in the workspace's plans dirs, reusing the
    cached stage of a file whose mtime has not moved."""
    from . import plan_history

    cached = _plan_stages.get(workspace_path, {})
    root = Path(workspace_path)
    found: dict[str, tuple[int, str]] = {}
    for rel_root in ["", *plan_history.find_nested_plan_roots(root)]:
        base = root / rel_root if rel_root else root
        plans_dir = base / plan_history.PROJECT_DIR_NAME / plan_history._PLANS_DIR_NAME
        if not plans_dir.is_dir():
            continue
        for plan in [*plans_dir.glob("*.html"), *plans_dir.glob("*.plan.md")]:
            if plan.name.startswith(("_", ".")):
                continue
            try:
                mtime = plan.stat().st_mtime_ns
                rel = plan.relative_to(root).as_posix()
                hit = cached.get(rel)
                if hit is not None and hit[0] == mtime:
                    found[rel] = hit
                    continue
                content = plan.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            stage = (
                plan_history.parse_plan_stage(content)
                if plan.name.endswith(".html")
                else plan_history.parse_plan_stage_md(content)
            )
            if stage is not None:
                found[rel] = (mtime, stage)
    return found


async def on_plans_changed(workspace_path: str) -> None:
    """GitWatcher plans sink (after the snapshot scan): one event per plan
    whose stage moved since the last scan of this workspace."""
    if _loop is None:
        return
    first = workspace_path not in _plan_stages
    previous = _plan_stages.get(workspace_path, {})
    try:
        current = await asyncio.to_thread(_scan_plan_stages, workspace_path)
    except Exception as err:  # noqa: BLE001 — an event source must never break the sink
        log.warning("plan stage scan failed for %s: %s", workspace_path, err)
        return
    _plan_stages[workspace_path] = current
    if first:
        return
    for rel, (_mtime, stage) in sorted(current.items()):
        before = previous.get(rel)
        if before is not None and before[1] != stage:
            _emit("agents.planStageChanged", workspace_path, {
                "relPath": rel, "stage": stage, "previousStage": before[1],
            })


def node_statuses(node_states: dict[str, Any] | None) -> dict[str, str]:
    """``{node id: status}`` of a project's node states, taken before a merge
    (the store updates the same dict in place)."""
    return {
        str(node_id): _text(state.get("status"))
        for node_id, state in (node_states or {}).items()
        if isinstance(state, dict)
    }


def on_pipeline_node_states(
    workspace_path: str, pipeline_id: str, before: dict[str, str], node_states: dict[str, Any]
) -> None:
    """pipeline.node_states handler: one event per node whose status moved."""
    for node_id, status in sorted(node_statuses(node_states).items()):
        previous = before.get(node_id, "")
        if status and status != previous:
            _emit("agents.pipelineNodeChanged", workspace_path, {
                "pipelineId": _text(pipeline_id),
                "nodeId": node_id,
                "status": status,
                "previousStatus": previous,
            })


def on_schedule_fired(job: dict[str, Any], manual: bool) -> None:
    """Scheduler: a run of the job started."""
    action = job.get("action") if isinstance(job.get("action"), dict) else {}
    _emit("agents.scheduleFired", _text(action.get("workspace")), {
        "jobId": _text(job.get("id")),
        "name": _text(job.get("name")),
        "actionKind": _text(action.get("kind")),
        "manual": bool(manual),
    })


def start(loop: asyncio.AbstractEventLoop) -> None:
    """Begin observing on ``loop``. Called at every backend start; a second
    call (a restart in the same process) moves to the new loop and keeps one
    registration of each listener, so no shutdown step is needed."""
    from . import agent_messaging

    global _loop
    if _loop is loop:
        return
    _loop = loop
    _plan_stages.clear()
    for entry in agent_messaging.list_panes():
        _panes[entry.pane_id] = (
            entry.workspace_path, entry.name, bool(entry.busy), _text(entry.display_status)
        )
    if on_registry not in agent_messaging.pane_listeners:
        agent_messaging.pane_listeners.append(on_registry)
    if on_message_rows not in agent_messaging.message_row_listeners:
        agent_messaging.message_row_listeners.append(on_message_rows)


def stop() -> None:
    """Stop observing (tests; the backend itself just exits)."""
    from . import agent_messaging

    global _loop
    _loop = None
    _panes.clear()
    _plan_stages.clear()
    for registry, hook in (
        (agent_messaging.pane_listeners, on_registry),
        (agent_messaging.message_row_listeners, on_message_rows),
    ):
        try:
            registry.remove(hook)  # type: ignore[arg-type]
        except ValueError:
            pass
