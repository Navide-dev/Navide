"""WebSocket requests for ACP panes (acp.*), and their events to the window.

Requests: ``acp.create``, ``acp.prompt``, ``acp.cancel``,
``acp.permission_answer``, ``acp.kill``, ``acp.list``. Events (from
``AcpSessionService``) go to the window that created the session:
``acp.state``, ``acp.update``, ``acp.permission``, ``acp.permission_closed``,
``acp.turn_end``, ``acp.exit``. A vendor without ``VendorSpec.acp`` is refused
with ``ACP_UNAVAILABLE``; nothing falls back to a terminal pane on its own.
Which CLIs have an ACP mode is ``acp_vendors``, not ``cli_vendors``.

Ownership, like a terminal pane's PTY: a session belongs to the window that
created it, and only its owner may prompt, cancel, answer or kill it. A window
that disconnects gives its sessions up (``drop_owner``); they keep running
and may be claimed back (``acp.list`` with ``claim``) only by a window that
created them (same page-load window id, i.e. a reconnect) or that now holds
the session's pane (agent_messaging) — never one another live window owns.
A session left without an owner is ended after the same grace as an
ownerless PTY (app._OWNERLESS_GRACE_SEC, one hour), by the same janitor.

Registered on import (app imports this module next to ws_handlers).
"""

from __future__ import annotations

import logging
import os
import time
from typing import TYPE_CHECKING, Any

from .acp_sessions import AcpSessionService, AcpStartError
from .acp_vendors import acp_launch
from .cli_vendors.registry import vendor as cli_vendor
from .ipc import make_error, make_event, make_response
from .ws_handlers import handler

if TYPE_CHECKING:
    from .app import Session

log = logging.getLogger("agent_team_backend.acp_ws")

# ACP session id -> the window (WS session) that owns it and gets its events.
_OWNERS: dict[str, "Session"] = {}
# ACP session id -> the page-load window id of the window that created it.
_CREATORS: dict[str, str] = {}
# ACP session id -> when it was last left without a live owner (monotonic).
_OWNERLESS_SINCE: dict[str, float] = {}
# pane id -> the windows with an acp.create for it still under way.
_STARTING: dict[str, set["Session"]] = {}
_SERVICE: AcpSessionService | None = None


def _owner(session_id: str) -> "Session | None":
    owner = _OWNERS.get(session_id)
    return owner if owner is not None and not getattr(owner, "dead", False) else None


def _may_claim(window: "Session", item: Any) -> bool:
    """A window may take over a session nobody live owns when it created it
    (a reconnect keeps the page-load id) or holds its pane now."""
    if _owner(item.id) is not None:
        return False
    window_id = getattr(window, "window_id", "")
    if window_id and _CREATORS.get(item.id) == window_id:
        return True
    from . import agent_messaging

    return agent_messaging.owner_of(item.pane_id) is window


def _may_close_pane(window: "Session", pane_id: str) -> bool:
    """Closing by pane id (a start still under way): the window that started
    it, the window that holds the pane, or the owner of its agent."""
    from . import agent_messaging

    if window in _STARTING.get(pane_id, ()) or agent_messaging.owner_of(pane_id) is window:
        return True
    if _SERVICE is None:
        return False
    return any(_owner(item.id) is window for item in _SERVICE.list() if item.pane_id == pane_id)


def _set_owner(session_id: str, window: "Session") -> None:
    _OWNERS[session_id] = window
    _OWNERLESS_SINCE.pop(session_id, None)


def drop_owner(window: "Session") -> None:
    """A window disconnected: its sessions keep running, ownerless, until a
    window claims them back or the janitor ends them (see the module doc)."""
    now = time.monotonic()
    for session_id, owner in list(_OWNERS.items()):
        if owner is window:
            del _OWNERS[session_id]
            _OWNERLESS_SINCE[session_id] = now


async def sweep_ownerless(now: float | None = None) -> list[str]:
    """End the sessions ownerless for longer than an ownerless PTY may live.
    Run by app's ownerless janitor, after (not inside) its PTY sweep; never
    raises. Returns the ended session ids."""
    from . import app

    if _SERVICE is None:
        return []
    now = time.monotonic() if now is None else now
    ended: list[str] = []
    try:
        await _sweep(app._OWNERLESS_GRACE_SEC, now, ended)
    except Exception as err:  # noqa: BLE001 — the janitor must survive
        log.warning("ACP ownerless sweep failed: %s", err, exc_info=True)
    return ended


async def _sweep(grace: float, now: float, ended: list[str]) -> None:
    assert _SERVICE is not None
    for item in _SERVICE.list():
        if _owner(item.id) is not None:
            _OWNERLESS_SINCE.pop(item.id, None)
            continue
        since = _OWNERLESS_SINCE.setdefault(item.id, now)
        # The deadline first, then the comparison: (since + grace) - since can
        # round below grace (3599.9999999999995 for since=700.685087237).
        if now < since + grace:
            continue
        log.info("ACP %s: no window for %.0fs; ending its agent", item.id, now - since)
        await _SERVICE.kill(item.id)
        _OWNERLESS_SINCE.pop(item.id, None)
        ended.append(item.id)


async def _emit(event: dict[str, Any]) -> None:
    payload = event.get("payload") or {}
    session_id = str(payload.get("session_id") or "")
    owner = _owner(session_id)
    if event.get("type") == "acp.state" and payload.get("state") == "exited":
        _OWNERS.pop(session_id, None)
        _CREATORS.pop(session_id, None)
        _OWNERLESS_SINCE.pop(session_id, None)
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
    """Stop every ACP agent (backend shutdown). Never raises: a failed sweep
    must not skip the rest of the backend's teardown."""
    if _SERVICE is None:
        return
    try:
        await _SERVICE.kill_all()
    except Exception as err:  # noqa: BLE001
        log.warning("ACP shutdown sweep failed: %s", err)


def _spawn_env(spec: Any) -> dict[str, str]:
    env = dict(os.environ)
    for key, value in (spec.spawn_env_defaults if spec is not None else ()):
        env.setdefault(key, value)
    return env


@handler("acp.create")
async def acp_create(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    agent_key = str(payload.get("agent_key") or "")
    pane_id = str(payload.get("pane_id") or "")
    cwd = str(payload.get("cwd") or "")
    launch = acp_launch(agent_key)
    if launch is None:
        await session.send_json(make_error(
            msg_id, msg_type, "ACP_UNAVAILABLE", f"{agent_key or 'this CLI'} has no ACP mode in Navide",
        ))
        return
    if not pane_id or not cwd or not os.path.isabs(cwd):
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", "pane_id and an absolute cwd are required"))
        return
    _STARTING.setdefault(pane_id, set()).add(session)
    try:
        created = await get_service().create(
            pane_id=pane_id, agent_key=agent_key, argv=list(launch.argv), cwd=cwd,
            env=_spawn_env(cli_vendor(agent_key)), load_session_id=str(payload.get("load_session_id") or ""),
        )
    except AcpStartError as err:
        await session.send_json(make_error(
            msg_id, msg_type, err.code.upper().replace("-", "_"), str(err),
            {"stderr_tail": err.stderr_tail},
        ))
        return
    finally:
        starting = _STARTING.get(pane_id)
        if starting is not None:
            starting.discard(session)
            if not starting:
                del _STARTING[pane_id]
    _CREATORS[created.id] = getattr(session, "window_id", "")
    if getattr(session, "dead", False):
        # The window went away while the agent started: ownerless from now.
        _OWNERLESS_SINCE[created.id] = time.monotonic()
    else:
        _set_owner(created.id, session)
    await session.send_json(make_response(msg_id, msg_type, {"session": created.snapshot()}))


async def _with_session(session: "Session", msg_id: str, msg_type: str, payload: dict, act) -> None:
    session_id = str(payload.get("session_id") or "")
    if get_service().get(session_id) is not None and _owner(session_id) is not session:
        await session.send_json(make_error(
            msg_id, msg_type, "ACP_NOT_OWNER", f"ACP session {session_id} belongs to another window",
        ))
        return
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
        pane_id = str(payload["pane_id"])
        if not _may_close_pane(session, pane_id):
            await session.send_json(make_error(
                msg_id, msg_type, "ACP_NOT_OWNER", f"pane {pane_id} is not this window's to close",
            ))
            return
        stopped = await get_service().abandon(pane_id)
        await session.send_json(make_response(msg_id, msg_type, {"stopped": stopped}))
        return

    async def act(service: AcpSessionService, session_id: str) -> dict[str, Any]:
        await service.kill(session_id)
        return {}

    await _with_session(session, msg_id, msg_type, payload, act)


@handler("acp.list")
async def acp_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """The ACP sessions this window owns or may claim (see the module doc);
    with ``claim``, it takes over the claimable ones and gets their events."""
    sessions = [
        item for item in get_service().list()
        if _owner(item.id) is session or _may_claim(session, item)
    ]
    if payload.get("claim"):
        for item in sessions:
            _set_owner(item.id, session)
    await session.send_json(make_response(msg_id, msg_type, {"sessions": [s.snapshot() for s in sessions]}))
