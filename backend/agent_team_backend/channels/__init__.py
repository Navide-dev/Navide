"""Chat-channel gateway: bridge Navide panes to Telegram/Discord/Slack/...

``start()`` / ``stop()`` run from the app lifespan; ``get_manager()`` serves the
ws handlers. ``default_seams()`` is the only place that reaches into the rest of
the backend — the manager itself is pure pipeline and tested with fakes.
"""

from __future__ import annotations

import asyncio
import logging
from types import SimpleNamespace
from typing import Any

from . import relay
from .manager import ChannelManager, Seams

log = logging.getLogger(__name__)

# How long a woken workspace's window gets to register the pane after it answers. Past it the
# wake is refused: opening another pane onto the session could run two CLIs on one conversation.
WAKE_PANE_WAIT_S = 30.0
WAKE_PANE_POLL_S = 0.5

_manager: ChannelManager | None = None
_start_task: asyncio.Task[None] | None = None


def get_manager() -> ChannelManager | None:
    return _manager


def default_seams() -> Seams:
    from .. import agent_messaging, login_panes
    from ..ipc import make_event
    from ..mcp_server import server as mcp

    async def deliver(pane_id: str, text: str, from_display: str) -> dict[str, Any]:
        res = agent_messaging.resolve_pane_id("", pane_id)
        if res.pane is None:
            return {"ok": False, "error": res.error or "pane is gone"}
        target = res.pane
        refused = mcp._login_pane_input_refusal(target.pane_id, target.name)
        if refused is not None:
            return refused
        if not target.realized:
            # Same as the scheduler's open_target=True: a restore placeholder
            # would otherwise park the message until someone opens it.
            opened = await mcp._open_placeholder(target)
            if opened.get("ok"):
                target = opened["pane"]
        # _dispatch_delivery marks the pane for Guard, linked to the msg_key it mints.
        try:
            msg_key = await mcp._dispatch_delivery(
                target, text, caller=mcp._Caller(kind="host"), me="",
                cross_workspace=res.cross_workspace, from_display=from_display, origin="channel",
                taint_detail=f"chat message from {from_display}", taint_source="remote",
            )
        except mcp.TerminalExternalRefused as refused:
            return {"ok": False, "error": str(refused)}
        return {"ok": True, "msg_key": msg_key, "pane_id": target.pane_id}

    async def await_verdict(msg_key: str, timeout: float) -> dict[str, Any]:
        await mcp._await_delivery(msg_key, timeout)
        entry = mcp._mcp_message_status.get(msg_key)
        if entry is None:
            return {"status": "queued", "unknown": True}
        return {"status": entry["status"], "reason": entry.get("reason"), "hold": entry.get("hold")}

    async def cancel(msg_key: str) -> str:
        # The same withdrawal cli_cancel_message asks of the window owning the queue.
        from .. import app

        entry = mcp._mcp_message_status.get(msg_key)
        if entry is None:
            return "unknown"
        if entry["status"] != "queued":
            return str(entry["status"])
        await app.broadcast(make_event("agent_msg.cancel", {"msg_key": msg_key}))
        await mcp._await_delivery(msg_key, mcp._CANCEL_VERDICT_TIMEOUT_S)
        settled = mcp._mcp_message_status.get(msg_key)
        return str(settled["status"]) if settled else "unknown"

    async def resume(pane_id: str) -> dict[str, Any]:
        # What project.set_pane_stopped does when the user types into a stopped pane.
        from .. import app

        pane = agent_messaging.current(pane_id)
        if pane is None:
            return {"ok": False, "error": "pane is gone"}
        app.project_store.set_pane_stopped(pane.workspace_path, pane_id=pane.pane_id, stopped=False)
        await app.broadcast(make_event("pane.stopped", {
            "workspace_path": pane.workspace_path, "pane_id": pane.pane_id, "stopped": False,
        }))
        return {"ok": True}

    async def interrupt(pane_id: str) -> dict[str, Any]:
        pane = agent_messaging.current(pane_id)
        if pane is None:
            return {"ok": False, "error": "pane is gone"}
        refused = mcp._login_pane_input_refusal(pane.pane_id, pane.name)
        if refused is not None:
            return refused
        reply = await mcp._ui_request(
            pane.workspace_path, "invoke", caller=mcp._pane_caller(pane.pane_id),
            action="ui.pane.interrupt", args={"paneId": pane.pane_id},
        )
        if not reply.get("ok"):
            return {"ok": False, "error": str(reply.get("error") or "the window did not answer")}
        result = reply.get("result") or {}
        return {"ok": True, "sent": bool(result.get("sent"))}

    def pane_state(pane_id: str) -> dict[str, Any]:
        pane = agent_messaging.current(pane_id)
        if pane is None:
            return {"exists": False, "busy": False, "display_status": ""}
        return {"exists": True, "busy": bool(pane.busy),
                "display_status": getattr(pane, "display_status", "") or ""}

    async def awaiting_info(pane_id: str) -> dict[str, Any]:
        pane = agent_messaging.current(pane_id)
        if pane is None:
            return {}
        reply = await mcp._ui_request(
            pane.workspace_path, "invoke", caller=mcp._pane_caller(pane.pane_id),
            action="ui.pane.getStatus", args={"paneId": pane.pane_id},
        )
        result = reply.get("result") or {}
        kind = str(result.get("awaitingKind") or "")
        if kind not in ("permission", "question"):
            kind = "permission" if result.get("status") == "awaiting" else ""
        options = result.get("awaitingOptions")
        return {
            "kind": kind,
            "prompt": str(result.get("awaitingPrompt") or ""),
            "options": [str(o) for o in options] if isinstance(options, list) else [],
            # A window that does not report the vendor keeps the old behaviour.
            "answerable": not pane.agent_key or pane.agent_key in relay.ANSWERABLE_AGENTS,
        }

    async def limit_info(pane_id: str) -> dict[str, Any]:
        # The renderer's own reading (usageLimitUntil) and screen tail, as cli_get_status
        # reports them; nothing here asks a vendor for quota.
        pane = agent_messaging.current(pane_id)
        if pane is None:
            return {}
        reply = await mcp._ui_request(
            pane.workspace_path, "invoke", caller=mcp._pane_caller(pane.pane_id),
            action="ui.pane.getStatus", args={"paneId": pane.pane_id},
        )
        result = reply.get("result") or {}
        return {"until": result.get("usageLimitUntil"), "buffer": str(result.get("buffer") or "")}

    async def answer(pane_id: str, answer_payload: dict[str, Any],
                     expected: dict[str, Any] | None = None) -> dict[str, Any]:
        pane = agent_messaging.current(pane_id)
        if pane is None:
            return {"ok": False, "error": "pane is gone"}
        refused = mcp._login_pane_input_refusal(pane.pane_id, pane.name)
        if refused is not None:
            return refused
        args: dict[str, Any] = {"paneId": pane.pane_id, "answer": answer_payload}
        if expected is not None:
            # The window presses only while this same prompt is on screen, as for cli_answer_prompt.
            args["expected"] = expected
        reply = await mcp._ui_request(
            pane.workspace_path, "invoke", caller=mcp._pane_caller(pane.pane_id),
            action="ui.pane.sendKeys", args=args,
        )
        if not reply.get("ok"):
            return {"ok": False, "error": str(reply.get("error") or "the window did not answer")}
        result = reply.get("result") or {}
        if not result.get("ok", True) or not result.get("sent"):
            return {"ok": False, "error": str(result.get("error") or "not sent"),
                    "error_code": str(result.get("errorCode") or "")}
        return {"ok": True}

    def resolve_pane(pane_id: str) -> str:
        pane = agent_messaging.current(pane_id)
        return pane.pane_id if pane is not None else ""

    def pane_workspace(pane_id: str) -> str:
        pane = agent_messaging.current(pane_id)
        return pane.workspace_path if pane is not None else ""

    def pane_directory() -> list[dict[str, Any]]:
        return [
            {"pane_id": p.pane_id, "name": p.name, "qualified_name": p.qualified_name,
             "spawned_by": p.spawned_by, "display_status": p.display_status}
            for p in agent_messaging.list_panes()
        ]

    def inherit_taint(child_id: str, parent_id: str) -> None:
        from ..guard import taint

        if taint.is_tainted(parent_id) and not taint.is_tainted(child_id):
            taint.safe_mark_tainted(child_id, "agent", f"spawned by tainted pane {parent_id}")

    def ui_settings() -> dict[str, Any]:
        from .. import app

        return app.ui_settings_store.get()

    def pane_agent(pane_id: str) -> str:
        pane = agent_messaging.current(pane_id)
        return pane.agent_key if pane is not None else ""

    def agent_skills(agent_key: str) -> list[str]:
        from .. import app
        from .quick_menu import agent_skills as listed

        return listed(app.skills_store, agent_key)

    # /mcp: read-only and allowlisted (mcp_menu). A CLI's own servers come from its config
    # file and are never started; Navide's are the ones it already runs.
    def agent_mcp(agent_key: str) -> list[dict[str, Any]]:
        from .. import native_mcp
        from .mcp_menu import native_rows

        return native_rows(native_mcp.scan(), agent_key)

    async def navide_mcp() -> list[dict[str, Any]]:
        from .. import app
        from .mcp_menu import navide_rows

        servers = await asyncio.to_thread(app.mcp_settings_store.list_servers)
        return await navide_rows(servers, app.mcp_manager.get)

    async def navide_mcp_tools(name: str) -> list[str] | None:
        from .. import app
        from .mcp_menu import navide_tools

        return await navide_tools(app.mcp_manager.get, name)

    async def broadcast(event_type: str, payload: dict[str, Any]) -> None:
        from .. import app

        await app.broadcast(make_event(event_type, payload))

    # The vault shells out to the Keychain (blocking, up to 10s): keep it off the loop.
    async def read_secret(name: str) -> str | None:
        from .. import app

        return await asyncio.to_thread(app.credential_vault.read_app_secret, name)

    async def write_secret(name: str, secret: str | None) -> None:
        from .. import app

        await asyncio.to_thread(app.credential_vault.write_app_secret, name, secret)

    def wake_target(pane_id: str) -> dict[str, str]:
        from .. import app

        pane = agent_messaging.current(pane_id)
        if pane is None:
            return {}
        project = app.project_store.peek(pane.workspace_path)
        record = next((r for r in project.panes if r.pane_id == pane.pane_id), None) if project else None
        return {"workspace_path": pane.workspace_path,
                "session_id": (getattr(record, "session_id", "") or "").strip()}

    def windows_open() -> bool:
        from .. import app

        return bool(app.live_main_window_ids())

    async def wake(pane_id: str, workspace_path: str, session_id: str) -> dict[str, Any]:
        return await wake_pane(pane_id, workspace_path, session_id)

    return Seams(
        deliver=deliver, await_verdict=await_verdict, interrupt=interrupt, pane_state=pane_state,
        awaiting_info=awaiting_info, answer=answer, limit_info=limit_info, resolve_pane=resolve_pane, broadcast=broadcast,
        read_secret=read_secret, write_secret=write_secret, pane_workspace=pane_workspace,
        pane_directory=pane_directory, inherit_taint=inherit_taint,
        ui_settings=ui_settings, pane_agent=pane_agent, agent_skills=agent_skills, cancel=cancel, resume=resume,
        agent_mcp=agent_mcp, navide_mcp=navide_mcp, navide_mcp_tools=navide_mcp_tools,
        wake_target=wake_target, windows_open=windows_open, wake=wake,
        is_login_pane=login_panes.is_login_pane,
    )


def _host_ctx() -> Any:
    """The credential this backend's own calls into the MCP tools carry (as evolve_service)."""
    from ..mcp_server import auth

    params = {"client": "host", "t": auth.internal_token()}
    return SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))


# The renderer's resume preference (RESUME_BEHAVIOR_SETTING_KEY in lib/resumeBehavior.ts).
RESUME_BEHAVIOR_KEY = "agentTeam.resumeBehavior"


def _wake_record(workspace_path: str, session_id: str) -> Any | None:
    """The newest pane record of the workspace that held this conversation, or None; None
    too when that pane was closed (a close is the user's word, even if its unbind was lost)."""
    from .. import app

    project = app.project_store.peek(workspace_path)
    if project is None:
        return None
    record = next((r for r in reversed(project.panes)
                   if (getattr(r, "session_id", "") or "").strip() == session_id and getattr(r, "agent", "")), None)
    return None if record is None or getattr(record, "spawn_status", "") == "removed" else record


def _session_open_elsewhere(pane_id: str, workspace_path: str, session_id: str) -> bool:
    """Whether a realized pane other than ``pane_id`` (or the pane it is now known by) already
    runs this conversation in the workspace: opening ours too would put two CLIs on it."""
    from .. import agent_messaging, app

    ours = agent_messaging.current(pane_id)
    ours_id = ours.pane_id if ours is not None else pane_id
    project = app.project_store.peek(workspace_path)
    for record in project.panes if project else []:
        if (getattr(record, "session_id", "") or "").strip() != session_id \
                or getattr(record, "spawn_status", "") == "removed":
            continue
        entry = agent_messaging.current(record.pane_id)
        if entry is not None and entry.realized and entry.pane_id != ours_id:
            return True
    return False


def _registered_pane(pane_id: str, workspace_path: str, session_id: str) -> Any | None:
    """The registered pane behind the binding: its id (or an alias), else the live record
    that holds the same conversation."""
    from .. import agent_messaging, app

    entry = agent_messaging.current(pane_id)
    if entry is not None:
        return entry
    project = app.project_store.peek(workspace_path)
    for record in reversed(project.panes if project else []):
        if (getattr(record, "session_id", "") or "").strip() == session_id \
                and getattr(record, "spawn_status", "") != "removed":
            entry = agent_messaging.current(record.pane_id)
            if entry is not None:
                return entry
    return None


async def wake_pane(pane_id: str, workspace_path: str, session_id: str) -> dict[str, Any]:
    """Bring a pane that is not online back onto its own conversation (the chat's wake).

    Refused before anything opens, with ``started`` False: no Navide window, no record of
    the conversation, a conversation the CLI cannot resume, a CLI out of quota (the cached
    reading only), or Navide set never to resume (opening the window would start every pane
    of the workspace fresh). Then the workspace's window is opened if needed and the pane is
    opened in place onto that same session. It succeeds only when the window reports the
    pane was launched on exactly ``session_id``; a pane the window does not bring back is
    refused, never opened a second time."""
    from .. import app, quota_failover
    from ..mcp_server import server as mcp

    if not app.live_main_window_ids():
        return {"ok": False, "code": "no-window", "started": False}
    record = await asyncio.to_thread(_wake_record, workspace_path, session_id)
    if record is None:
        return {"ok": False, "code": "no-record", "started": False}
    agent_key = str(record.agent)
    refusal = await asyncio.to_thread(mcp._refuse_unresumable_session, agent_key, workspace_path, session_id)
    if refusal:
        return {"ok": False, "code": str(refusal.get("error_code") or "no-record"), "started": False}
    if quota_failover.snapshot_exhausted(await mcp._cached_usage_snapshot(agent_key)):
        return {"ok": False, "code": "quota", "agent": agent_key, "started": False}
    settings = await asyncio.to_thread(app.ui_settings_store.get)
    behavior = (settings or {}).get(RESUME_BEHAVIOR_KEY)
    if behavior == "never":
        return {"ok": False, "code": "fresh-refused", "started": False}
    if behavior == "ask":
        # Opening the window would put the restore question on the user's screen from a chat.
        return {"ok": False, "code": "ask-refused", "started": False}
    if await asyncio.to_thread(_session_open_elsewhere, pane_id, workspace_path, session_id):
        return {"ok": False, "code": "session-open-elsewhere", "started": False}
    if not await mcp._probe_window(workspace_path, mcp._WINDOW_PROBE_TIMEOUT_S):
        opened = await mcp.workspace_open(workspace_path, _host_ctx())
        if not opened.get("ok") or not opened.get("ready"):
            return {"ok": False, "code": "window-not-ready", "started": True}
    loop = asyncio.get_running_loop()
    deadline = loop.time() + WAKE_PANE_WAIT_S
    entry = _registered_pane(pane_id, workspace_path, session_id)
    while entry is None and loop.time() < deadline:
        await asyncio.sleep(WAKE_PANE_POLL_S)
        entry = _registered_pane(pane_id, workspace_path, session_id)
    if entry is None:
        return {"ok": False, "code": "pane-not-restored", "started": True}
    # The window's own restore may have brought the conversation back in another pane.
    if await asyncio.to_thread(_session_open_elsewhere, entry.pane_id, workspace_path, session_id):
        return {"ok": False, "code": "session-open-elsewhere", "started": True}
    # Asked even when it is already open: the window's own restore may have opened it fresh,
    # and only the window knows which session it launched.
    opened = await mcp._open_placeholder(entry, require_resume=True)
    if not opened["ok"]:
        return {"ok": False, "code": str(opened.get("reason") or ""), "started": True}
    if opened.get("reason") == "fresh":
        return {"ok": False, "code": "fresh-refused", "started": True}
    if opened.get("launched_session_id") != session_id:
        return {"ok": False, "code": "session-mismatch", "started": True}
    return {"ok": True, "pane_id": opened["pane"].pane_id}


async def start() -> None:
    """Load channel config and start enabled adapters. Never raises into the lifespan."""
    global _manager, _start_task
    from .. import agent_messaging, app
    from .store import ChannelStore

    if _manager is not None:
        return
    try:
        manager = ChannelManager(ChannelStore(app.database), default_seams())
        _manager = manager
        app.pane_activity_listeners.append(manager.on_pane_activity)
        app.pane_prompt_listeners.append(manager.mirror.on_local_prompt)
        agent_messaging.pane_listeners.append(manager.mirror.on_registry)
        agent_messaging.message_row_listeners.append(manager.mirror.on_message_rows)
        # Keychain reads can take seconds; adapters come up without holding the lifespan.
        _start_task = asyncio.create_task(manager.start(), name="channels-start")
        _start_task.add_done_callback(_log_start_failure)
    except Exception:  # noqa: BLE001 — chat channels must never block startup
        log.exception("channels: start failed")


def _log_start_failure(task: asyncio.Task[None]) -> None:
    if not task.cancelled() and task.exception() is not None:
        log.error("channels: start failed", exc_info=task.exception())


async def stop() -> None:
    global _manager
    from .. import app

    manager, _manager = _manager, None
    if manager is None:
        return
    from .. import agent_messaging

    for registry, hook in (
        (app.pane_activity_listeners, manager.on_pane_activity),
        (app.pane_prompt_listeners, manager.mirror.on_local_prompt),
        (agent_messaging.pane_listeners, manager.mirror.on_registry),
        (agent_messaging.message_row_listeners, manager.mirror.on_message_rows),
    ):
        try:
            registry.remove(hook)
        except ValueError:
            pass
    try:
        await manager.stop()
    except Exception:  # noqa: BLE001
        log.exception("channels: stop failed")
