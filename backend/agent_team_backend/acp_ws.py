"""WebSocket requests for ACP panes (acp.*), and their events to the window.

Requests: ``acp.create``, ``acp.prompt``, ``acp.cancel``,
``acp.permission_answer``, ``acp.kill``, ``acp.list``. Events (from
``AcpSessionService``) go to the window that created the session:
``acp.state``, ``acp.update``, ``acp.permission``, ``acp.permission_closed``,
``acp.turn_end``, ``acp.exit``. A vendor without ``VendorSpec.acp`` is refused
with ``ACP_UNAVAILABLE``; nothing falls back to a terminal pane on its own.

Registered on import (app imports this module next to ws_handlers).
"""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING, Any

from .acp_sessions import AcpSessionService, AcpStartError
from .cli_vendors.registry import vendor as cli_vendor
from .ipc import make_error, make_event, make_response
from .ws_handlers import handler

if TYPE_CHECKING:
    from .app import Session

log = logging.getLogger("agent_team_backend.acp_ws")

# ACP session id -> the window (WS session) that created it, which gets its events.
_OWNERS: dict[str, "Session"] = {}
_SERVICE: AcpSessionService | None = None


async def _emit(event: dict[str, Any]) -> None:
    payload = event.get("payload") or {}
    owner = _OWNERS.get(str(payload.get("session_id") or ""))
    if event.get("type") == "acp.state" and payload.get("state") == "exited":
        _OWNERS.pop(str(payload.get("session_id") or ""), None)
    if owner is None:
        return  # no window: the agent keeps running; a window asks with acp.list
    await owner.send_json(make_event(str(event["type"]), payload))


def get_service() -> AcpSessionService:
    """The one app-level AcpSessionService (lazy: it binds to the running loop)."""
    global _SERVICE
    if _SERVICE is None:
        _SERVICE = AcpSessionService(emit=_emit)
    return _SERVICE


async def shutdown() -> None:
    """Stop every ACP agent (backend shutdown)."""
    if _SERVICE is not None:
        await _SERVICE.kill_all()


def _spawn_env(spec: Any) -> dict[str, str]:
    env = dict(os.environ)
    for key, value in spec.spawn_env_defaults:
        env.setdefault(key, value)
    return env


@handler("acp.create")
async def acp_create(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    agent_key = str(payload.get("agent_key") or "")
    pane_id = str(payload.get("pane_id") or "")
    cwd = str(payload.get("cwd") or "")
    spec = cli_vendor(agent_key)
    if spec is None or spec.acp is None:
        await session.send_json(make_error(
            msg_id, msg_type, "ACP_UNAVAILABLE", f"{agent_key or 'this CLI'} has no ACP mode in Navide",
        ))
        return
    if not pane_id or not cwd or not os.path.isabs(cwd):
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", "pane_id and an absolute cwd are required"))
        return
    try:
        created = await get_service().create(
            pane_id=pane_id, agent_key=agent_key, argv=list(spec.acp.argv), cwd=cwd,
            env=_spawn_env(spec), load_session_id=str(payload.get("load_session_id") or ""),
        )
    except AcpStartError as err:
        await session.send_json(make_error(
            msg_id, msg_type, err.code.upper().replace("-", "_"), str(err),
            {"stderr_tail": err.stderr_tail},
        ))
        return
    _OWNERS[created.id] = session
    await session.send_json(make_response(msg_id, msg_type, {"session": created.snapshot()}))


async def _with_session(session: "Session", msg_id: str, msg_type: str, payload: dict, act) -> None:
    session_id = str(payload.get("session_id") or "")
    try:
        result = await act(get_service(), session_id)
    except KeyError:
        await session.send_json(make_error(msg_id, msg_type, "ACP_NO_SESSION", f"no ACP session {session_id}"))
        return
    except ValueError as err:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", str(err)))
        return
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("acp.prompt")
async def acp_prompt(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    text = str(payload.get("text") or "")

    async def act(service: AcpSessionService, session_id: str) -> dict[str, Any]:
        return {"status": await service.prompt(session_id, text)}

    await _with_session(session, msg_id, msg_type, payload, act)


@handler("acp.cancel")
async def acp_cancel(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    async def act(service: AcpSessionService, session_id: str) -> dict[str, Any]:
        return {"cancel_sent": await service.cancel(session_id)}

    await _with_session(session, msg_id, msg_type, payload, act)


@handler("acp.permission_answer")
async def acp_permission_answer(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    request_id = str(payload.get("request_id") or "")
    option = payload.get("option_id")
    option_id = str(option) if option is not None else None

    async def act(service: AcpSessionService, session_id: str) -> dict[str, Any]:
        return {"answered": service.answer_permission(session_id, request_id, option_id)}

    await _with_session(session, msg_id, msg_type, payload, act)


@handler("acp.kill")
async def acp_kill(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """By ``session_id``; or by ``pane_id`` for a pane closed while its agent
    is still starting (the window has no session id yet and must not wait
    minutes for one): its start is abandoned and nothing it started survives."""
    if not payload.get("session_id") and payload.get("pane_id"):
        stopped = await get_service().abandon(str(payload["pane_id"]))
        await session.send_json(make_response(msg_id, msg_type, {"stopped": stopped}))
        return

    async def act(service: AcpSessionService, session_id: str) -> dict[str, Any]:
        await service.kill(session_id)
        return {}

    await _with_session(session, msg_id, msg_type, payload, act)


@handler("acp.list")
async def acp_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Every running ACP session; with ``claim``, this window takes their events."""
    sessions = get_service().list()
    if payload.get("claim"):
        for item in sessions:
            _OWNERS[item.id] = session
    await session.send_json(make_response(msg_id, msg_type, {"sessions": [s.snapshot() for s in sessions]}))
