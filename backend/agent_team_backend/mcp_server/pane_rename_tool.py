"""cli_rename_pane: rename a CLI pane's title and messaging handle (0.2.40).
Registered on the core server from its own module, after the channel tools,
so it is the last core tool and the tools/list before it stays main's."""

from __future__ import annotations

import asyncio
import time
from typing import Any

from mcp.server.fastmcp import Context

# Through the module, not imported names, so a test's monkeypatch of the
# core helpers reaches this tool too.
from . import server as core


#: How long cli_rename_pane waits for the window's handle mirror to reach the
#: registry, so a cli_send to the new name right after the answer resolves.
_RENAME_REGISTRY_WAIT_S = 2.0
#: Upper bound on the spawned_by walk; lineage is a tree, this only stops a
#: corrupt cycle from spinning.
_LINEAGE_MAX_HOPS = 64


def _descends_from(pane_id: str, ancestor_id: str) -> bool:
    """Whether `ancestor_id` is on `pane_id`'s spawned_by chain."""
    seen: set[str] = set()
    entry = core.agent_messaging_current(pane_id)
    for _ in range(_LINEAGE_MAX_HOPS):
        parent_id = (getattr(entry, "spawned_by", "") or "").strip() if entry else ""
        if not parent_id or parent_id in seen:
            return False
        parent = core.agent_messaging_current(parent_id)
        if parent_id == ancestor_id or (parent is not None and parent.pane_id == ancestor_id):
            return True
        seen.add(parent_id)
        entry = parent
    return False


async def _scheduler_jobs_naming(workspace_path: str, name: str) -> list[str]:
    """Ids of scheduled jobs whose action targets `name` in `workspace_path`."""
    from agent_team_backend.agent_messaging import _normalize_workspace

    ws = _normalize_workspace(workspace_path)
    jobs = await core._scheduler_service().store.list_jobs()
    return [
        str(job.get("id") or "")
        for job in jobs
        if isinstance(job.get("action"), dict)
        and job["action"].get("pane_name") == name
        and _normalize_workspace(str(job["action"].get("workspace") or "")) == ws
    ]


@core.server.tool()
async def cli_rename_pane(target: str, new_name: str, ctx: Context, pane_id: str = "") -> dict[str, Any]:
    """Rename a CLI pane: its title and the name other panes address it by.

    The same rename as double-clicking the pane's title: the same checks
    (non-empty, one line; "/" is kept in the title but becomes "-" in the
    address, since it separates `<folder>/<pane>`) and the same write path, so
    the title on screen, cli_list_targets, cli_send, cli_get_status and
    cli_list_sessions' pane_name all switch to the new name. A name another
    pane already answers to is refused with error_code "name-taken" — pick
    another; nothing is suffixed for you.

    `target` uses the same addressing as cli_send (a bare name in your
    workspace, `<folder>/<pane>`), and `pane_id` names one exact pane instead.
    You may rename yourself and panes in your own workspace that you opened,
    directly or through your children (the spawned_by chain); anything else is
    refused with "rename-not-permitted". CLI panes only, restore placeholders
    included; panes on another device are refused ("rename-local-only").

    Scheduled jobs are the user's data and are not rewritten: a job that still
    targets the old name is listed in `warnings` so you can tell the user.

    Returns {ok, old_name, new_name, pane_id, address, warnings?}; `new_name`
    is the address name, `address` its `<folder>/<pane>` form.
    """
    from agent_team_backend import message_routing
    from agent_team_backend.agent_messaging import _normalize_workspace

    try:
        caller = core._resolve_caller(ctx)
    except core.CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    if caller.kind != "pane":
        return {
            "ok": False,
            "error": "only a CLI pane can rename panes: the permission is its own pane and the panes it opened",
            "error_code": "rename-not-permitted",
        }
    me = caller.pane_id
    result, failure = core._resolve_pane_target(caller, me, target, pane_id)
    if failure is not None:
        if not (pane_id or "").strip() and message_routing.route(me, target).remote is not None:
            return {
                "ok": False,
                "error": (
                    f'cannot rename "{target}": it names a pane on another device, '
                    f"and only panes on this machine can be renamed from here."
                ),
                "error_code": "rename-local-only",
            }
        return failure
    pane = result.pane
    own = pane.pane_id == me
    same_ws = _normalize_workspace(pane.workspace_path) == _normalize_workspace(core._caller_workspace(caller))
    if not own and not (same_ws and _descends_from(pane.pane_id, me)):
        return {
            "ok": False,
            "target": pane.qualified_name,
            "error": (
                "you can rename only your own pane and panes in your workspace that "
                "you opened (directly or through your children); ask the user to "
                "rename this one."
            ),
            "error_code": "rename-not-permitted",
        }
    old_name = pane.name
    reply = await core._ui_request(
        pane.workspace_path,
        "invoke",
        caller=caller,
        route_pane_id=pane.pane_id,
        action="ui.pane.rename",
        args={"paneId": pane.pane_id, "name": new_name},
    )
    if not reply.get("ok"):
        return {
            "ok": False,
            "target": pane.qualified_name,
            "error": str(reply.get("error") or "the window owning this pane did not answer"),
            "error_code": str(reply.get("error_code") or "ui_action_failed"),
        }
    payload = reply.get("result") or {}
    applied = str(payload.get("name") or "")
    # The window mirrors the new handle to the registry on its own send; wait
    # for it so the answer and an immediate cli_send agree.
    deadline = time.monotonic() + _RENAME_REGISTRY_WAIT_S
    entry = core.agent_messaging_current(pane.pane_id)
    while entry is not None and entry.name != applied and time.monotonic() < deadline:
        await asyncio.sleep(0.05)
        entry = core.agent_messaging_current(pane.pane_id)
    answer: dict[str, Any] = {
        "ok": True,
        "old_name": old_name,
        "new_name": applied,
        "pane_id": pane.pane_id,
        "address": entry.qualified_name if entry is not None else pane.qualified_name,
    }
    if applied != old_name:
        stale = await _scheduler_jobs_naming(pane.workspace_path, old_name)
        if stale:
            answer["warnings"] = [f"scheduler job {job_id} still targets old name" for job_id in stale]
    return answer
