"""Chat-channel gateway: bridge Navide panes to Telegram/Discord/Slack/...

``start()`` / ``stop()`` run from the app lifespan; ``get_manager()`` serves the
ws handlers. ``default_seams()`` is the only place that reaches into the rest of
the backend — the manager itself is pure pipeline and tested with fakes.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from ..db_executor import run_in_db_thread
from ..pane_account_history import parse_event_time
from . import relay, wake
from .manager import ChannelManager, Seams

log = logging.getLogger(__name__)

# How long a window the wake just opened gets to restore the pane (its placeholder registers
# then). A window that already held the workspace restored it long ago, so it gets only a
# moment. Past either, the pane is opened onto its conversation instead of waited for.
WAKE_PANE_WAIT_S = 30.0
WAKE_HELD_GRACE_S = 3.0
WAKE_PANE_POLL_S = 0.5
# How long the pane a wake opened gets for its window to write its record. The window answers
# the open before it persists the pane, and the replaced records' children can only be handed
# to a record that exists.
WAKE_SUCCESSOR_WAIT_S = 5.0
WAKE_SUCCESSOR_POLL_S = 0.1

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
        await run_in_db_thread(app.project_store.set_pane_stopped, pane.workspace_path, pane_id=pane.pane_id, stopped=False)
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
            "agent": pane.agent_key or "",
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

    async def cli_health(pane_id: str) -> dict[str, Any]:
        # The renderer's loginExpired reading, as cli_get_status reports it; read-only.
        pane = agent_messaging.current(pane_id)
        if pane is None:
            return {}
        reply = await mcp._ui_request(
            pane.workspace_path, "invoke", caller=mcp._pane_caller(pane.pane_id),
            action="ui.pane.getStatus", args={"paneId": pane.pane_id},
        )
        result = reply.get("result") or {}
        return {"login_expired": result.get("loginExpired") is True}

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

    def pane_live(pane_id: str) -> bool:
        pane = agent_messaging.current(pane_id)
        return pane is not None and pane.realized and not pane.offline

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
        from . import agent_requests

        # An agent waiting on a Telegram creation or a link code hears the outcome here.
        agent_requests.on_event(event_type, payload)
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

    def pane_model(pane_id: str) -> dict[str, Any]:
        from .. import app
        from ..cli_vendors import registry

        pane = agent_messaging.current(pane_id)
        if pane is None:
            return {}
        spec = registry.VENDORS.get(pane.agent_key or "")
        project = app.project_store.peek(pane.workspace_path)
        records = list(project.panes) if project else []
        me = next((r for r in records if r.pane_id == pane.pane_id), None)
        known: list[str] = []
        for r in reversed(records):  # newest records last: most recent first
            model = (r.model or "").strip()
            if r.agent == pane.agent_key and model and model not in known:
                known.append(model)
        return {
            "agent_key": pane.agent_key or "",
            "model": (me.model if me else "") or "",
            "effort": (me.effort if me else "") or "",
            "supports_model": bool(spec and spec.supports_model),
            "efforts": list(spec.known_efforts) if spec and spec.supports_effort else [],
            "known": known,
        }

    async def set_model(pane_id: str, model: str, effort: str, who: str) -> dict[str, Any]:
        from ..mcp_server import pane_model_tool

        pane = agent_messaging.current(pane_id)
        if pane is None:
            return {"ok": False, "error": "pane is gone", "error_code": "pane-gone"}
        if pane.agent_key == mcp._TERMINAL_AGENT:
            return {"ok": False, "error": "a terminal pane has no model", "error_code": "not-agent-pane"}
        # No caller: a chat sender is not a pane, so the window sees a host request.
        result = await pane_model_tool.switch_pane_model(
            pane, model, effort, caller=None, who=who, source="channel",
        )
        if not result.get("ok"):
            # A chat's refused attempt is on the record too (a switch is audited on its own).
            await run_in_db_thread(
                pane_model_tool._audit, pane, who, model, effort, "",
                source="channel", refused=str(result.get("error_code") or "failed"),
            )
        return result

    def windows_open() -> bool:
        from .. import app

        return bool(app.live_main_window_ids())

    async def wake(pane_id: str, workspace_path: str, session_id: str) -> dict[str, Any]:
        return await wake_pane(pane_id, workspace_path, session_id)

    async def turn_text(pane_id: str, since_s: float) -> str:
        from .. import app

        target = wake_target(pane_id)
        agent = pane_agent(pane_id)
        # Line readers only: a shared-db reader scanned with an empty bag would walk
        # every session in its store.
        reader = next((r for r in app._readers if r.vendor == agent and r.activity_resumes_by_line), None)
        if reader is None or not target.get("session_id"):
            return ""

        def read() -> str:
            path = app._resolve_session_log(reader, target["workspace_path"], target["session_id"], "")
            return _last_turn_text(reader, path, since_s) if path is not None else ""

        return await asyncio.to_thread(read)

    return Seams(
        deliver=deliver, await_verdict=await_verdict, interrupt=interrupt, pane_state=pane_state,
        awaiting_info=awaiting_info, answer=answer, limit_info=limit_info, cli_health=cli_health, resolve_pane=resolve_pane, broadcast=broadcast,
        read_secret=read_secret, write_secret=write_secret, pane_workspace=pane_workspace,
        pane_directory=pane_directory, inherit_taint=inherit_taint,
        ui_settings=ui_settings, pane_agent=pane_agent, agent_skills=agent_skills, cancel=cancel, resume=resume,
        agent_mcp=agent_mcp, navide_mcp=navide_mcp, navide_mcp_tools=navide_mcp_tools,
        wake_target=wake_target, windows_open=windows_open, pane_live=pane_live, wake=wake, turn_text=turn_text,
        is_login_pane=login_panes.is_login_pane, pane_model=pane_model, set_model=set_model,
    )


def _last_turn_text(reader: Any, path: Path, since_s: float) -> str:
    """Text of the last turn in ``path`` that ended at or after ``since_s`` ("" when none)."""
    text = ""
    for event in reader.parse_activity(path, set()):
        when = parse_event_time(event.timestamp)
        if event.event_type == "turn_complete" and event.text.strip() and when is not None and when >= since_s:
            text = event.text
    return text


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


def _held_entry(pane_id: str) -> Any | None:
    """The registry entry a connected window holds for ``pane_id`` (or the pane it is now
    known by), else None. An entry waiting out its offline grace is not one: its window closed,
    so no window has that pane to open, and the window holding the workspace, asked to open
    it, answers "unknown pane" at once (0.2.38: a duplicate window holding only a pane's
    children, the pane's own entry left behind by the window that closed)."""
    from .. import agent_messaging

    entry = agent_messaging.current(pane_id)
    return None if entry is None or entry.offline else entry


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
    """The pane a connected window holds behind the binding: its id (or an alias), else the
    live record that holds the same conversation."""
    from .. import app

    entry = _held_entry(pane_id)
    if entry is not None:
        return entry
    project = app.project_store.peek(workspace_path)
    for record in reversed(project.panes if project else []):
        if (getattr(record, "session_id", "") or "").strip() == session_id \
                and getattr(record, "spawn_status", "") != "removed":
            entry = _held_entry(record.pane_id)
            if entry is not None:
                return entry
    return None


async def wake_pane(pane_id: str, workspace_path: str, session_id: str) -> dict[str, Any]:
    """The chat's wake (see _wake_pane), with one log line per outcome."""
    result = await _wake_pane(pane_id, workspace_path, session_id)
    log.info("channels: wake of %s in %s: %s", pane_id, workspace_path,
             "ok" if result.get("ok") else result.get("code") or "?")
    return result


def _has_live_record(workspace_path: str, pane_id: str) -> bool:
    from .. import app

    project = app.project_store.peek(workspace_path)
    return any(p.pane_id == pane_id and getattr(p, "spawn_status", "") != "removed"
               for p in (project.panes if project else []))


async def _await_successor_record(workspace_path: str, pane_id: str) -> bool:
    """Wait, up to WAKE_SUCCESSOR_WAIT_S, for the window to write the woken pane's record."""
    deadline = asyncio.get_running_loop().time() + WAKE_SUCCESSOR_WAIT_S
    while not await asyncio.to_thread(_has_live_record, workspace_path, pane_id):
        if asyncio.get_running_loop().time() >= deadline:
            return False
        await asyncio.sleep(WAKE_SUCCESSOR_POLL_S)
    return True


def _retire_superseded(workspace_path: str, session_id: str, keep: str) -> tuple[list[str], list[str]]:
    """Retire the records the woken pane replaced: the ones of the same conversation that no
    window holds. Left in place, the next restore of the workspace would bring the
    conversation back a second time. Returns the retired pane ids, and those of them whose
    children the store actually handed to `keep` (it does only while `keep`'s record is live;
    otherwise they move up a level)."""
    from .. import app

    retired: list[str] = []
    inherited: list[str] = []
    project = app.project_store.peek(workspace_path)
    for record in list(project.panes if project else []):
        if record.pane_id == keep or getattr(record, "spawn_status", "") == "removed" \
                or (getattr(record, "session_id", "") or "").strip() != session_id \
                or _held_entry(record.pane_id) is not None:
            continue
        # Its children follow the conversation to `keep`; a plain retire would make them roots.
        after, _ = app.project_store.record_pane_unspawn_by_id(
            workspace_path, pane_id=record.pane_id, successor=keep)
        retired.append(record.pane_id)
        # The store chose the heir under its lock against this same state.
        if any(p.pane_id == keep and getattr(p, "spawn_status", "") != "removed" for p in after.panes):
            inherited.append(record.pane_id)
    return retired, inherited


async def _announce_lineage_handoff(retired: list[str], pane_id: str, workspace_path: str) -> None:
    """Tell the windows the records moved: _retire_superseded re-keyed the retired panes'
    children onto the woken pane, and a window still holding the old ids in their spawnedBy
    would render them as roots until its next reload. Only the hand-offs the store made:
    announcing one it did not would leave the window disagreeing with the records."""
    from .. import app
    from ..ipc import make_event

    for previous in retired:
        await app.broadcast_main_windows(make_event("pane.lineage_rekeyed", {
            "workspace_path": workspace_path, "old_pane_id": previous, "new_pane_id": pane_id,
        }))


async def _hand_over_jobs(retired: list[str], pane_id: str, session_id: str) -> None:
    """Move the scheduled jobs of the panes a wake replaced onto the woken pane.

    The spawn itself cannot: its records were still live when it was recorded, and it names
    no previous pane. The session check already passed, so this is the same hop a rebuild
    makes. The wake succeeded either way."""
    from .. import scheduler

    for previous in retired:
        try:
            await scheduler.get_service().rebind_after_rebuild(previous, pane_id, session_id, session_id)
        except Exception:  # noqa: BLE001
            log.exception("channels: scheduled jobs of %s did not follow the wake", previous)


async def _open_onto_session(record: Any, workspace_path: str, session_id: str) -> dict[str, Any]:
    """Have the window holding the workspace open a pane onto ``session_id`` (the same spawn as
    cli_open_agent(session_id)) for a pane it holds no placeholder of."""
    from ..mcp_server import server as mcp

    name = (getattr(record, "custom_name", "") or getattr(record, "auto_name", "") or str(record.agent)).strip()
    opened = await mcp.cli_open_agent(agent=str(record.agent), name=name.replace("/", "-"), task="",
                                      ctx=_host_ctx(), workspace_path=workspace_path, session_id=session_id)
    if not opened.get("ok"):
        code = str(opened.get("error_code") or "")
        if code in wake.UNRESUMABLE_REASONS:
            return {"ok": False, "code": code, "started": True}
        if code == "window_not_ready" or "no answer from the window" in str(opened.get("error") or ""):
            return {"ok": False, "code": "window-timeout", "started": True}
        return {"ok": False, "code": "window-refused", "started": True}
    new_pane_id = str(opened.get("pane_id") or "")
    # The window launched it with the vendor's resume syntax on the id asked for, checked on
    # disk before the spawn; a window that answers otherwise is not taken on trust.
    if not new_pane_id or opened.get("resumed_session_id") != session_id:
        return {"ok": False, "code": "session-mismatch", "started": True}
    await _await_successor_record(workspace_path, new_pane_id)
    retired, inherited = await asyncio.to_thread(_retire_superseded, workspace_path, session_id, new_pane_id)
    await _hand_over_jobs(retired, new_pane_id, session_id)
    for previous in retired:
        if previous not in inherited:
            log.warning("channels: children of %s moved up a level, not to %s: its record was not "
                        "written within %.1fs; no lineage hand-off announced",
                        previous, new_pane_id, WAKE_SUCCESSOR_WAIT_S)
    await _announce_lineage_handoff(inherited, new_pane_id, workspace_path)
    return {"ok": True, "pane_id": new_pane_id}


async def _wake_pane(pane_id: str, workspace_path: str, session_id: str) -> dict[str, Any]:
    """Bring a pane that is not online back onto its own conversation (the chat's wake).

    Refused before anything opens, with ``started`` False: no Navide window, no record of
    the conversation, a conversation the CLI cannot resume, an API key that might not be the
    pane's own, a CLI out of quota (the cached reading only; a pane on a key does not spend
    it), or Navide set never to resume (opening the window would start every pane of the
    workspace fresh). Then the workspace's window is opened if needed, and the pane is
    opened in place onto that same session: its placeholder when the window restored one,
    otherwise a pane the window opens onto the session. It succeeds only when the pane was
    launched on exactly ``session_id``; a conversation open in another pane is never opened
    a second time."""
    from .. import api_key_accounts, app, quota_failover
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
    key = await asyncio.to_thread(api_key_accounts.wake_verdict, agent_key, getattr(record, "profile_id", "") or "")
    if key == "unclear":
        return {"ok": False, "code": "key-account-unclear", "started": False}
    if key != "key" and quota_failover.snapshot_exhausted(await mcp._cached_usage_snapshot(agent_key)):
        return {"ok": False, "code": "quota", "agent": agent_key, "started": False}
    billed = {"paid": True} if key == "key" else {}
    settings = await asyncio.to_thread(app.ui_settings_store.get)
    behavior = (settings or {}).get(RESUME_BEHAVIOR_KEY)
    if behavior == "never":
        return {"ok": False, "code": "fresh-refused", "started": False}
    if behavior == "ask":
        # Opening the window would put the restore question on the user's screen from a chat.
        return {"ok": False, "code": "ask-refused", "started": False}
    if await asyncio.to_thread(_session_open_elsewhere, pane_id, workspace_path, session_id):
        return {"ok": False, "code": "session-open-elsewhere", "started": False}
    wait_s = WAKE_HELD_GRACE_S
    if not await mcp._probe_window(workspace_path, mcp._WINDOW_PROBE_TIMEOUT_S):
        opened = await mcp.workspace_open(workspace_path, _host_ctx())
        if not opened.get("ok") or not opened.get("ready"):
            return {"ok": False, "code": "window-not-ready", "started": True}
        wait_s = WAKE_PANE_WAIT_S
    loop = asyncio.get_running_loop()
    deadline = loop.time() + wait_s
    entry = _registered_pane(pane_id, workspace_path, session_id)
    while entry is None and loop.time() < deadline:
        await asyncio.sleep(WAKE_PANE_POLL_S)
        entry = _registered_pane(pane_id, workspace_path, session_id)
    if entry is None:
        # No placeholder: the window's restore skipped the record (a detached group's, a
        # pipeline run holding the restore), the pane left its layout, or only the entry its
        # closed window left behind remains. Asked again first,
        # in case the conversation came back in a pane under another record meanwhile.
        if await asyncio.to_thread(_session_open_elsewhere, pane_id, workspace_path, session_id):
            return {"ok": False, "code": "session-open-elsewhere", "started": True}
        result = await _open_onto_session(record, workspace_path, session_id)
        return {**result, **billed} if result["ok"] else result
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
    return {"ok": True, "pane_id": opened["pane"].pane_id, **billed}


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
        app.hook_reply_listeners.append(manager.on_hook_reply)
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
        (app.hook_reply_listeners, manager.on_hook_reply),
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
