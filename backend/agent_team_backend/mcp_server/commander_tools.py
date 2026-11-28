"""commander_* MCP tools and the commander hooks cli_open_agent / cli_whoami
call (0.2.51, plan bot_48c8f6 section C).

Read-only views of commanders, plus one write: a commander's own pane appending
to its own memory. Creating, upgrading and binding a commander stay in the
window (the user's to do); none of it is on a tool.

Registered on the core server from its own module, after cli_set_model, so the
tools/list before it stays main's.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from mcp.server.fastmcp import Context

from agent_team_backend import commander_service
from agent_team_backend.commander_store import (
    MAX_TASK,
    Commander,
    CommanderInvalid,
    CommanderNotFound,
    mask_secrets,
)
from agent_team_backend.db_executor import run_in_db_thread

# Through the module, not imported names, so a test's monkeypatch of the core
# helpers reaches these tools too.
from . import server as core

_log = logging.getLogger(__name__)

#: Upper bound on the opened_by walk; it is a tree, this only stops a corrupt
#: cycle from spinning.
_LINEAGE_MAX_HOPS = 64
#: One memory note. The file itself is the commander's; this only keeps a
#: single call from being a dump.
MAX_MEMORY_APPEND = 8_000

MEMORY_REMINDER = (
    "memory is for what this commander learned about its own duty; a problem "
    "with the process itself (how panes, reviews or releases work) belongs in "
    "the repo's rules (CLAUDE.md, docs), where every pane reads it"
)


# ── hooks for cli_open_agent / cli_whoami ──────────────────────────────────


def _opened_by_chain(pane_id: str) -> list[str]:
    """*pane_id*, then who opened it, then who opened that, ... Walks
    opened_by (fixed at spawn), never spawned_by (the sidebar position, which
    cli_place_pane can move)."""
    chain: list[str] = []
    entry = core.agent_messaging_current(pane_id)
    current_id = entry.pane_id if entry is not None else pane_id
    for _ in range(_LINEAGE_MAX_HOPS):
        if not current_id or current_id in chain:
            break
        chain.append(current_id)
        parent_id = (getattr(entry, "opened_by", "") or "").strip() if entry is not None else ""
        if not parent_id:
            break
        entry = core.agent_messaging_current(parent_id)
        current_id = entry.pane_id if entry is not None else parent_id
    return chain


def _commander_of(svc: commander_service.CommanderService, pane_id: str) -> str:
    """The active commander *pane_id* is the body of, or dispatched work of."""
    commander_id = svc.store.commander_of_body(pane_id)
    if commander_id:
        return commander_id
    d = svc.store.dispatch_of(pane_id)
    if d is None or svc.store.get(d.commander_id).archived_at:
        return ""
    return d.commander_id


def note_dispatch(opener_pane_id: str, child_pane_id: str, task: str) -> None:
    """Record that *opener_pane_id* opened *child_pane_id* when the opener, or
    one of its opened_by ancestors, belongs to a commander. Synchronous (db
    thread); never raises, so the spawn it follows is never failed by it."""
    if not opener_pane_id or not child_pane_id:
        return
    try:
        svc = commander_service.current()
        # Masked before it is stored: a kickoff can quote a key.
        masked = mask_secrets(str(task or ""))[:MAX_TASK]
        if svc.note_open(opener_pane_id, child_pane_id, masked) is not None:
            return
        # The opener itself is not the commander's (a pane opened before the
        # upgrade, say); an ancestor may be. opened_by stays the direct opener.
        for ancestor in _opened_by_chain(opener_pane_id)[1:]:
            commander_id = _commander_of(svc, ancestor)
            if commander_id:
                svc.store.record_dispatch(commander_id, pane_id=child_pane_id, opened_by=opener_pane_id,
                                          task=masked, now=int(time.time()))
                return
    except Exception as err:  # noqa: BLE001 - bookkeeping must not fail a spawn
        _log.warning("commander dispatch not recorded for %s: %s", child_pane_id, err)


def _pane_ref(pane_id: str) -> dict[str, Any]:
    live = core.agent_messaging_current(pane_id) if pane_id else None
    if live is None:
        return {"pane_id": pane_id, "gone": True}
    return {"pane_id": live.pane_id, "name": live.name, "address": live.qualified_name}


def whoami_commander(pane_id: str) -> dict[str, Any] | None:
    """cli_whoami's `commander`: {id, name, role: "commander"} or {id, name,
    role: "worker", dispatched_by: {pane_id, name, address} | {pane_id, gone}}
    or None. Synchronous (db thread); a failed read is None, never an error."""
    try:
        role = commander_service.current().role_of(pane_id)
    except Exception as err:  # noqa: BLE001 - whoami must answer anyway
        _log.debug("commander role read failed for %s: %s", pane_id, err)
        return None
    if role is None:
        return None
    out: dict[str, Any] = {"id": role["id"], "name": role["name"], "role": role["role"]}
    if role["role"] == "worker":
        out["dispatched_by"] = _pane_ref(str(role.get("dispatched_by") or ""))
    return out


# ── views ──────────────────────────────────────────────────────────────────


def _caller_workspace(caller: Any) -> str | None:
    """The caller pane's workspace, or None for a caller with no workspace
    (host / external credential, a pane gone): it gets public fields only."""
    if caller.kind != "pane":
        return None
    me = core.agent_messaging_current(caller.pane_id)
    return me.workspace_path if me is not None else None


def _same_workspace(c: Commander, workspace: str | None) -> bool:
    if not workspace:
        return False
    from agent_team_backend.agent_messaging import _normalize_workspace

    return _normalize_workspace(workspace) in {_normalize_workspace(w) for w in c.workspaces}


def _public(c: Commander) -> dict[str, Any]:
    return {"id": c.id, "name": c.name, "icon": c.icon, "color": c.color, "visibility": "public"}


def _full(svc: commander_service.CommanderService, c: Commander) -> dict[str, Any]:
    """Fixed fields. No account id, session id or anything credential-like."""
    s = svc.summary(c)
    body = s.get("body")
    view: dict[str, Any] = {
        "id": c.id,
        "name": c.name,
        "icon": c.icon,
        "color": c.color,
        "visibility": "full",
        "duty": c.duty,
        "workspaces": list(c.workspaces),
        "agent_key": c.agent_key,
        "model": c.model,
        "skills": list(c.skills),
        "mcp": list(c.mcp),
        "stall_minutes": c.stall_minutes,
        "created_at": c.created_at,
        "updated_at": c.updated_at,
        "body": None,
        "bindings": [
            {k: b.get(k) for k in ("kind", "ref_id", "label", "target", "paused") if k in b}
            for b in s.get("bindings") or []
        ],
        "dispatch_counts": dict(s.get("dispatch_counts") or {}),
    }
    if body:
        view["body"] = {
            **_pane_ref(str(body["pane_id"])),
            "workspace": body.get("workspace", ""),
            "agent_key": body.get("agent_key", ""),
            "attached_at": body.get("attached_at", 0),
            "live": bool(s.get("body_live")),
        }
    return view


def _find(svc: commander_service.CommanderService, commander: str) -> Commander:
    """An active commander by id or by name."""
    key = (commander or "").strip()
    if not key:
        raise CommanderNotFound("commander is required (an id or a name from commander_list)")
    for c in svc.store.list():
        if c.id == key or c.name == key:
            return c
    raise CommanderNotFound(f"no active commander {key!r} — see commander_list")


def _not_found(err: Exception) -> dict[str, Any]:
    return {"ok": False, "error_code": "commander-not-found", "error": str(err.args[0] if err.args else err)}


def _list_sync(workspace: str | None) -> list[dict[str, Any]]:
    svc = commander_service.current()
    return [_full(svc, c) if _same_workspace(c, workspace) else _public(c) for c in svc.store.list()]


def _get_sync(commander: str, workspace: str | None) -> dict[str, Any]:
    svc = commander_service.current()
    c = _find(svc, commander)
    return _full(svc, c) if _same_workspace(c, workspace) else _public(c)


def _tree_node(node: dict[str, Any]) -> dict[str, Any]:
    return {
        "pane_id": node.get("pane_id", ""),
        "name": node.get("name", ""),
        "opened_by": node.get("opened_by", ""),
        "task": mask_secrets(str(node.get("task") or "")),
        "opened_at": node.get("opened_at", 0),
        "closed_at": node.get("closed_at", 0),
        "state": node.get("state", ""),
        "children": [_tree_node(child) for child in node.get("children") or []],
    }


def _tree_sync(commander: str, workspace: str | None) -> dict[str, Any]:
    svc = commander_service.current()
    c = _find(svc, commander)
    if not _same_workspace(c, workspace):
        return {
            "ok": False,
            "error_code": "commander-other-workspace",
            "error": f"{c.name} works in another workspace; its dispatch tree is shown only to panes there",
        }
    tree = svc.tree(c.id)
    return {"ok": True, "commander_id": c.id, "name": c.name, "root": _tree_node(tree["root"])}


def _caller_or_error(ctx: Context) -> tuple[Any, dict[str, Any] | None]:
    try:
        return core._resolve_caller(ctx), None
    except core.CallerUnknown as err:
        return None, {"ok": False, "error": str(err)}


# ── tools ──────────────────────────────────────────────────────────────────


@core.server.tool()
async def commander_list(ctx: Context) -> dict[str, Any]:
    """List the active commanders. Read-only.

    A commander is a named, long-lived agent identity the user set up in
    Navide's window: a duty, a memory, the chats and schedules bound to it, and
    the pane it currently runs in (its `body`). Panes come and go; the commander
    stays. Commanders are created, upgraded from a pane and bound to chats only
    by the user in the window — no tool does that.

    For a commander whose workspaces include yours you get every field:
    {id, name, icon, color, visibility: "full", duty, workspaces, agent_key,
    model ("" = the account's default), skills, mcp, stall_minutes, created_at,
    updated_at, body: {pane_id, name, address, workspace, agent_key,
    attached_at, live} | {pane_id, gone, ...} | null, bindings: [{kind, ref_id,
    label, target, paused}], dispatch_counts: {working, waiting, reported,
    idle, stalled, gone}}. For one in another workspace — and for any caller
    with no pane identity (host / external credential) — you get only {id,
    name, icon, color, visibility: "public"}. No account id, session id, token
    or other credential is ever returned.

    Returns {ok, commanders: [...]} or {ok: false, error}.
    """
    caller, error = _caller_or_error(ctx)
    if error:
        return error
    rows = await run_in_db_thread(_list_sync, _caller_workspace(caller))
    return {"ok": True, "commanders": rows}


@core.server.tool()
async def commander_get(commander: str, ctx: Context) -> dict[str, Any]:
    """One active commander, by `commander` id or name (see commander_list).
    Read-only, with the same fields and the same workspace rule as
    commander_list: every field when its workspaces include yours, otherwise
    {id, name, icon, color, visibility: "public"} only.

    Returns {ok, commander} or {ok: false, error_code: "commander-not-found",
    error}.
    """
    caller, error = _caller_or_error(ctx)
    if error:
        return error
    try:
        view = await run_in_db_thread(_get_sync, commander, _caller_workspace(caller))
    except CommanderNotFound as err:
        return _not_found(err)
    return {"ok": True, "commander": view}


@core.server.tool()
async def commander_tree(commander: str, ctx: Context) -> dict[str, Any]:
    """A commander's dispatch tree: every pane its body opened with
    cli_open_agent, and the panes those opened, with a detected state each.
    Read-only; nothing here wakes, interrupts or changes a pane.

    `root` is the commander's body. Each node is {pane_id, name, opened_by,
    task (first 200 characters of the kickoff), opened_at, closed_at, state,
    children}. `state` is one of: "working" (busy, recently active),
    "waiting" (parked on a question or permission prompt), "reported" (turn
    ended and it has messaged the pane that opened it), "idle" (turn ended, no
    report yet), "stalled" (busy but silent past the commander's
    stall_minutes), "gone" (closed — the record stays).

    Shown only to panes in one of the commander's workspaces; any other caller
    gets error_code "commander-other-workspace".

    Returns {ok, commander_id, name, root} or {ok: false, error_code, error}.
    """
    caller, error = _caller_or_error(ctx)
    if error:
        return error
    try:
        return await run_in_db_thread(_tree_sync, commander, _caller_workspace(caller))
    except CommanderNotFound as err:
        return _not_found(err)


def _append_sync(pane_id: str, text: str) -> dict[str, Any]:
    svc = commander_service.current()
    commander_id = svc.store.commander_of_body(pane_id)
    if not commander_id:
        return {
            "ok": False,
            "error_code": "not-a-commander",
            "error": "only a commander's own pane can write its memory, and this pane is none "
            "(cli_whoami's `commander` says what you are)",
        }
    c = svc.store.get(commander_id)
    svc.store.append_memory(commander_id, text)
    return {"ok": True, "commander_id": c.id, "name": c.name, "reminder": MEMORY_REMINDER}


@core.server.tool()
async def commander_memory_append(text: str, ctx: Context) -> dict[str, Any]:
    """Append a note to YOUR OWN commander memory.

    Only the pane that is a commander's current body can call it, and it
    writes that commander's memory only — never another's (error_code
    "not-a-commander" otherwise; cli_whoami's `commander` tells you whether you
    are one). The memory is a local file Navide hands back to the commander's
    next body; it is not synced to any cloud. Anything credential-shaped in
    `text` is masked before it is written, but do not put keys or tokens here.

    Write what you learned about your own duty (who owns what, what the user
    decided, what to check next time). A problem with the process itself — how
    panes, reviews or releases work — belongs in the repo's rules (CLAUDE.md,
    docs) instead, where every pane reads it; the answer's `reminder` says so.

    `text` is one note, at most 8000 characters.
    Returns {ok, commander_id, name, reminder} or {ok: false, error_code?, error}.
    """
    caller, error = _caller_or_error(ctx)
    if error:
        return error
    if caller.kind != "pane":
        return {"ok": False, "error_code": "not-a-commander", "error": "only a commander's own pane can write its memory"}
    note = (text or "").strip()
    if not note:
        return {"ok": False, "error": "text is empty"}
    if len(note) > MAX_MEMORY_APPEND:
        return {"ok": False, "error": f"text is {len(note)} characters; one note is at most {MAX_MEMORY_APPEND}"}
    me = core.agent_messaging_current(caller.pane_id)
    pane_id = me.pane_id if me is not None else caller.pane_id
    try:
        return await run_in_db_thread(_append_sync, pane_id, note)
    except (CommanderInvalid, CommanderNotFound) as err:
        return {"ok": False, "error": str(err)}
