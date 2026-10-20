"""MCP tools that list and focus Navide's windows (DESIGN-C S3).

window_list asks every main window to describe itself; window_focus brings
one to the front. Both address one window's own WS session by its page-load
id (see the window helpers in server.py, which the cross-workspace spawn also
uses). Every window_focus is recorded with its caller (agent_window_actions)
and the focused window says which pane did it — disclosed, not limited.

Registered on the core server by the import at the end of server.py.
"""

from __future__ import annotations

import sys
from typing import Any

from mcp.server.fastmcp import Context

from . import server as core


@core.server.tool()
async def window_list(ctx: Context) -> dict[str, Any]:
    """List every Navide window on this machine, with its projects and panes.

    Read-only; any caller may use it. Each window is asked to describe itself,
    all at once; a window that does not answer in time is still listed, with
    `answered: false` and only its id, rather than holding the others up.

    Returns {ok, you, windows}. `you` is {window_id, workspace_path} for a CLI
    pane caller (the window mirroring you) and null for a host or external
    caller. Each window: {window_id, kind ("main" | "detached-group"),
    on_screen (the project it shows), workspaces (every project it holds),
    detached_group? (the tab group a detached window carries), focused,
    panes: [{pane_id, address, workspace_path}], is_yours, answered}.

    `window_id` is the key window_focus takes. It names one page load: after
    that window reloads, the old id answers "unknown-window" — list again.
    `is_yours` marks the window you run in and any main window holding your
    own project; it is shown so you know which windows are yours, and decides
    nothing by itself.
    """
    from agent_team_backend import agent_messaging

    try:
        caller = core._resolve_caller(ctx)
    except core.CallerUnknown as err:
        return {"ok": False, "error": str(err), "error_code": "caller-unknown"}
    described = await core._describe_windows(caller)
    yours = core._display_self_windows(caller, described)
    windows: list[dict[str, Any]] = []
    for session, answer in described:
        result = answer.get("result") if answer and answer.get("ok") else None
        if not isinstance(result, dict):
            windows.append({"window_id": session.window_id, "answered": False, "is_yours": session.window_id in yours})
            continue
        panes = []
        for pane in result.get("panes") or []:
            if not isinstance(pane, dict):
                continue
            pane_id = str(pane.get("pane_id") or "")
            entry = agent_messaging.get(pane_id)
            panes.append({
                "pane_id": pane_id,
                "address": entry.qualified_name if entry else "",
                "workspace_path": str(pane.get("workspace_path") or ""),
            })
        view: dict[str, Any] = {
            "window_id": session.window_id,
            "kind": "detached-group" if result.get("kind") == "detached-group" else "main",
            "on_screen": str(result.get("on_screen") or ""),
            "workspaces": [str(p) for p in result.get("workspaces") or []],
            "focused": bool(result.get("focused")),
            "panes": panes,
            "is_yours": session.window_id in yours,
            "answered": True,
        }
        if result.get("detached_group"):
            view["detached_group"] = str(result["detached_group"])
        windows.append(view)
    you = None
    if caller.kind == "pane":
        me = agent_messaging.get(caller.pane_id)
        you = {"window_id": core._pane_window_id(caller.pane_id), "workspace_path": me.workspace_path if me else ""}
    return {"ok": True, "you": you, "windows": windows}


@core.server.tool()
async def window_focus(window_id: str, ctx: Context, workspace_path: str = "") -> dict[str, Any]:
    """Bring a Navide window to the front, optionally switching it to a project.

    `window_id` comes from window_list (or a cli_list_targets row's
    `window_id`). `workspace_path`, when given, must be a project that window
    already holds; it is switched to the way the sidebar would, and refused
    while a pipeline runs there (the abort question is the user's). Windows on
    other machines cannot be focused ("window-local-only").

    The window being focused shows which pane did it, and the action is
    recorded with the caller. Returns {ok, window_id, on_screen, previous:
    {focused_window_id, on_screen}} — the window that had focus before and
    what this one showed before, which is all an undo needs — or {ok: false,
    error, error_code} ("unknown-window", "window-local-only",
    "ui_action_timeout", or the switch's own refusal).
    """
    from agent_team_backend import agent_window_actions, app

    try:
        caller = core._resolve_caller(ctx)
    except core.CallerUnknown as err:
        return {"ok": False, "error": str(err), "error_code": "caller-unknown"}
    if "/" in window_id:
        return {
            "ok": False,
            "error": "window ids name windows on this machine only; another device's windows cannot be focused",
            "error_code": "window-local-only",
        }
    session = core._window_session(window_id)
    if session is None:
        return {
            "ok": False,
            "error": f"no Navide window has id {window_id!r} — it may have closed or reloaded; call window_list for the current ids",
            "error_code": "unknown-window",
        }
    who = core._caller_view(caller)
    focused = max(app.main_window_sessions(), key=lambda s: s.ui_focused_at, default=None)
    previous_focused = focused.window_id if focused is not None and focused.ui_focused_at else ""
    args = {"workspace_path": workspace_path, "caller_address": who.get("address") or who.get("kind", "")}
    answer = await core._window_request(session, "ui.window.focus", args, caller)
    target = {"window_id": window_id, "workspace_path": workspace_path}
    if answer is None:
        error = f"window {window_id} did not answer within {core._UI_INVOKE_TIMEOUT_S:.0f}s — it may be blocked by a native dialog"
        agent_window_actions.record("window_focus", who, target, ok=False, error=error)
        return {"ok": False, "error": error, "error_code": "ui_action_timeout"}
    if not answer.get("ok"):
        error = str(answer.get("error") or "the window refused to focus")
        agent_window_actions.record("window_focus", who, target, ok=False, error=error)
        return {"ok": False, "error": error, "error_code": "window-focus-failed"}
    result = answer.get("result") if isinstance(answer.get("result"), dict) else {}
    previous = {"focused_window_id": previous_focused, "on_screen": str(result.get("previous_on_screen") or "")}
    agent_window_actions.record("window_focus", who, target, ok=True, undo={"tool": "window_focus", "previous": previous})
    return {
        "ok": True,
        "window_id": window_id,
        "on_screen": str(result.get("on_screen") or ""),
        "previous": previous,
    }


# ── window_close / workspace_close (DESIGN-C S4a) ───────────────────────────
# Only a CLI pane may call these (the record says which pane did it), and never
# on its own window or workspace: both go through S1's _self_scope_refusal, the
# one place that decides what is the caller's own. Neither ends a CLI unless
# the user agrees in a dialog (workspace_close keep_panes=false).

#: What keeping the panes running means for the caller, measured in an isolated
#: backend (0.2.28): a PTY outlives its window for as long as it runs and
#: re-attaches when the project is opened again.
_KEPT_PANES_NOTES = [
    "Their CLIs keep running; workspace_open on the project brings each pane back attached to the same process.",
    "Until then their output is not read: a ---MSG-START--- report one of them writes meanwhile reaches nobody.",
    "They leave the roster at once: cli_send cannot reach them and their own Navide tools are refused until the project is open again.",
]


def _last_window_quits() -> bool:
    """Off macOS, closing the last window quits Navide and ends every CLI."""
    return sys.platform != "darwin"


def _pane_caller_required(tool: str) -> dict[str, Any]:
    return {
        "ok": False,
        "error": f"{tool} can be called only from a CLI pane, so the record can say which pane did it; ask the user to do it in Navide instead",
        "error_code": "pane-caller-required",
    }


def _addresses(panes: Any) -> list[str]:
    """The roster addresses of the panes a window reported (pane ids it knows)."""
    from agent_team_backend import agent_messaging

    out: list[str] = []
    for pane in panes or []:
        pane_id = str((pane or {}).get("pane_id") or "") if isinstance(pane, dict) else ""
        entry = agent_messaging.get(pane_id) if pane_id else None
        out.append(entry.qualified_name if entry else pane_id)
    return out


def _window_error_code(error: str, default: str) -> str:
    """The code a window put in front of its refusal ("pipeline-running: …")."""
    head, sep, _ = error.partition(":")
    return head if sep and head and " " not in head else default


async def _tell_caller_window(caller: Any, event: dict[str, Any]) -> None:
    """Show the caller's own window what it just did (it is the one the user is
    watching the agent in, and the affected window may be gone)."""
    from agent_team_backend import agent_messaging, app
    from agent_team_backend.ipc import make_event

    await app.unicast_to(agent_messaging.owner(caller.pane_id), make_event("agent.window_action", event))


@core.server.tool()
async def window_close(window_id: str, ctx: Context) -> dict[str, Any]:
    """Close a Navide window, leaving every CLI in it running.

    `window_id` comes from window_list. Only a CLI pane may call this, and
    never on a window it runs in or a window holding its own project
    ("self-window-close"; an empty id means your own window). No CLI is
    ended: each project the window held is let go of the way the sidebar's
    plain "Close workspace" does, and the window closes. A window running a
    pipeline is refused ("pipeline-running") — stopping a run is the user's
    call.

    What that means for the panes, and the answer says it too (`notes`):
    their CLIs keep running and come back attached when the project is opened
    again (`undo`: workspace_open per project); until then their output is not
    read, so a ---MSG-START--- report one of them writes reaches nobody; and
    they leave the roster at once, so cli_send cannot reach them. Because your
    own window can never be closed, this never closes the last window (which
    off macOS would quit Navide and end every CLI).

    Recorded with your pane, and your own window shows what was closed with
    an undo. Returns {ok, window_id, workspaces, panes_left_running
    [address], undo [{tool, args}], notes} or {ok: false, error, error_code}
    ("pane-caller-required", "self-window-close", "window-local-only",
    "unknown-window", "last-window", "pipeline-running", "ui_action_timeout").
    A paused pipeline does not block it: nothing is ended, and the run is
    still there when the project is opened again.
    """
    from agent_team_backend import agent_window_actions

    try:
        caller = core._resolve_caller(ctx)
    except core.CallerUnknown as err:
        return {"ok": False, "error": str(err), "error_code": "caller-unknown"}
    if caller.kind != "pane":
        return _pane_caller_required("window_close")
    who = core._caller_view(caller)
    target = {"window_id": window_id}

    def refused(result: dict[str, Any]) -> dict[str, Any]:
        agent_window_actions.record("window_close", who, target, ok=False, error=str(result.get("error") or ""))
        return result

    if "/" in window_id:
        return refused({
            "ok": False,
            "error": "window ids name windows on this machine only; another device's windows cannot be closed",
            "error_code": "window-local-only",
        })
    # An empty id means "my window", never "whichever window is focused".
    named = window_id or core._pane_window_id(caller.pane_id)
    refusal = core._self_scope_refusal(caller, "ui.window.close", {"windowId": named})
    if refusal is not None:
        return refused({k: v for k, v in refusal.items() if k != "result"})
    session = core._window_session(window_id)
    if session is None:
        return refused({
            "ok": False,
            "error": f"no Navide window has id {window_id!r} — it may have closed or reloaded; call window_list for the current ids",
            "error_code": "unknown-window",
        })
    # Your own window can never be closed, so another one stays open — but
    # that rests on the caller's window being known. Checked outright too:
    # closing the last window off macOS would quit Navide.
    from agent_team_backend import app

    others = [s for s in app.main_window_sessions() if s is not session and getattr(s, "window_id", "")]
    if not others and _last_window_quits():
        return refused({
            "ok": False,
            "error": "that is the last Navide window; closing it would quit Navide and end every CLI",
            "error_code": "last-window",
        })
    args = {"windowId": window_id, "caller_address": who.get("address") or ""}
    answer = await core._window_request(session, "ui.window.close", args, caller)
    if answer is None:
        return refused({
            "ok": False,
            "error": f"window {window_id} did not answer within {core._UI_INVOKE_TIMEOUT_S:.0f}s — it may be blocked by a native dialog",
            "error_code": "ui_action_timeout",
        })
    if not answer.get("ok"):
        error = str(answer.get("error") or "the window refused to close")
        return refused({"ok": False, "error": error, "error_code": _window_error_code(error, "window-close-failed")})
    result = answer.get("result") if isinstance(answer.get("result"), dict) else {}
    workspaces = [str(p) for p in result.get("workspaces") or []]
    undo = [{"tool": "workspace_open", "args": {"path": p}} for p in workspaces]
    left = _addresses(result.get("panes"))
    agent_window_actions.record("window_close", who, target, ok=True, undo=undo)
    await _tell_caller_window(caller, {
        "tool": "window_close", "caller": who.get("address") or "", "workspaces": workspaces,
        "panes_left_running": left, "undo": undo,
    })
    notes = list(_KEPT_PANES_NOTES)
    if result.get("reattached_to_main"):
        # A detached group window: closing it hands its group back to the main
        # window holding the project, so nothing left the screen.
        notes = ["That was a detached tab group window; its panes went back to the main window holding their project."]
    return {
        "ok": True,
        "window_id": window_id,
        "workspaces": workspaces,
        "panes_left_running": left,
        "undo": undo,
        "notes": notes,
    }


@core.server.tool()
async def workspace_close(path: str, ctx: Context, keep_panes: bool = True) -> dict[str, Any]:
    """Take a project out of the Navide window holding it.

    `path` is required: an empty one means your own project and is refused,
    like any spelling of it ("self-workspace-close") — closing it would take
    your pane with it. Only a CLI pane may call this. A project that is its
    window's only one is refused ("last-workspace"); close the window with
    window_close instead. A project with a running pipeline is refused
    ("pipeline-running").

    keep_panes true (the default) is the sidebar's plain "Close workspace":
    every CLI keeps running and comes back attached when the project is
    opened again (`undo`: workspace_open). Until then their output is not
    read — a ---MSG-START--- report written meanwhile reaches nobody — and
    they leave the roster at once (see `notes`).

    keep_panes false ends the project's CLIs (their records stay, so a reopen
    brings each back as a card to resume). That window always asks the user
    first, naming your pane — whatever "don't ask again" says — and answers
    "user-declined" on a no or no answer within a minute.

    Recorded with your pane; the window shows which pane closed it. Returns
    {ok, path, window_id, keep_panes, panes_left_running | panes_ended,
    undo?, notes?} or {ok: false, error, error_code} ("pane-caller-required",
    "self-workspace-close", "workspace-not-open", "last-workspace",
    "pipeline-running", "user-declined", "ui_action_timeout").
    """
    import os

    from agent_team_backend import agent_messaging, agent_window_actions

    try:
        caller = core._resolve_caller(ctx)
    except core.CallerUnknown as err:
        return {"ok": False, "error": str(err), "error_code": "caller-unknown"}
    if caller.kind != "pane":
        return _pane_caller_required("workspace_close")
    who = core._caller_view(caller)
    target: dict[str, Any] = {"workspace_path": path, "keep_panes": keep_panes}

    def refused(result: dict[str, Any]) -> dict[str, Any]:
        agent_window_actions.record("workspace_close", who, target, ok=False, error=str(result.get("error") or ""))
        return result

    # An empty path means "my project", never "whichever one is on screen".
    me = agent_messaging.get(caller.pane_id)
    named = path or (me.workspace_path if me else "")
    refusal = core._self_scope_refusal(caller, "ui.workspace.close", {"path": named})
    if refusal is not None:
        return refused({k: v for k, v in refusal.items() if k != "result"})
    if not path:
        return refused({"ok": False, "error": "path is required", "error_code": "self-workspace-close"})
    wanted = core._norm_workspace(os.path.expanduser(path))
    holder = None
    held_as = ""
    held_count = 0
    for session, answer in await core._describe_windows(caller):
        described = answer.get("result") if answer and answer.get("ok") else None
        if not isinstance(described, dict) or described.get("kind") == "detached-group":
            continue
        workspaces = [str(p) for p in described.get("workspaces") or []]
        match = next((p for p in workspaces if core._norm_workspace(p) == wanted), None)
        if match is not None:
            holder, held_as, held_count = session, match, len(workspaces)
            break
    if holder is None:
        return refused({
            "ok": False,
            "error": f"no Navide window holds {path!r} — window_list shows which projects are open where",
            "error_code": "workspace-not-open",
        })
    target["window_id"] = holder.window_id
    if held_count < 2:
        return refused({
            "ok": False,
            "error": f"{held_as} is the only project in window {holder.window_id}; close the window with window_close instead",
            "error_code": "last-workspace",
        })
    args = {"path": held_as, "keepPanes": keep_panes, "caller_address": who.get("address") or ""}
    timeout = core._UI_INVOKE_TIMEOUT_S if keep_panes else core._UI_INVOKE_SLOW_TIMEOUT_S
    answer = await core._window_request(holder, "ui.workspace.close", args, caller, timeout=timeout)
    if answer is None:
        return refused({
            "ok": False,
            "error": f"window {holder.window_id} did not answer within {timeout:.0f}s — it may be blocked by a native dialog",
            "error_code": "ui_action_timeout",
        })
    if not answer.get("ok"):
        error = str(answer.get("error") or "the window did not close the project")
        return refused({"ok": False, "error": error, "error_code": _window_error_code(error, "workspace-close-failed")})
    result = answer.get("result") if isinstance(answer.get("result"), dict) else {}
    panes = _addresses(result.get("panes"))
    out: dict[str, Any] = {"ok": True, "path": held_as, "window_id": holder.window_id, "keep_panes": keep_panes}
    if keep_panes:
        undo: dict[str, Any] | None = {"tool": "workspace_open", "args": {"path": held_as}}
        out.update(panes_left_running=panes, undo=undo, notes=list(_KEPT_PANES_NOTES))
    else:
        undo = None
        out["panes_ended"] = panes
    agent_window_actions.record("workspace_close", who, target, ok=True, undo=undo)
    return out
