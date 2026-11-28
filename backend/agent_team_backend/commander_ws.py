"""The window's commander.* messages.

Creating, upgrading, downgrading, editing and archiving a commander are the
user's to do in a Navide main window: those messages are refused from any
other session (a plugin, editor or other WS client). There is deliberately no
MCP route to them. Reading (list / get / tree) is main-window only too: an
answer carries the commander's memory, pane ids and workspaces, and the events
go to main windows only for the same reason.

Events, sent to every main window:

- ``commander.changed`` ``{id, commander}`` - ``commander`` is the summary,
  or None once archived.
- ``commander.stall`` ``{commander_id, pane_id, state}`` - sent by the watch
  module (``broadcast_stall``).
"""

from __future__ import annotations

import asyncio
from typing import Any

from . import agent_messaging, commander_service
from .commander_store import UPDATABLE, CommanderInvalid, CommanderNotFound
from .ipc import make_error, make_event, make_response

#: Fields commander.create / commander.upgrade_pane accept from the window.
_CREATE_FIELDS = UPDATABLE


def _svc() -> commander_service.CommanderService:
    return commander_service.current()


def _main_window(session: Any) -> bool:
    from . import app

    return app.is_main_window(session)


async def _broadcast(event: dict[str, Any]) -> None:
    from . import app

    await app.broadcast_main_windows(event)


async def broadcast_changed(commander_id: str) -> None:
    def build() -> dict[str, Any] | None:
        c = _svc().store.get(commander_id)
        return None if c.archived_at else _svc().summary(c)

    summary = await asyncio.to_thread(build)
    await _broadcast(make_event("commander.changed", {"id": commander_id, "commander": summary}))


async def broadcast_stall(commander_id: str, pane_id: str, state: str) -> None:
    await _broadcast(make_event("commander.stall", {"commander_id": commander_id, "pane_id": pane_id,
                                                    "state": state}))


def _fields(payload: dict[str, Any]) -> dict[str, Any]:
    return {k: payload[k] for k in _CREATE_FIELDS if k in payload}


async def _refuse_unless_main(session: Any, msg_id: str, msg_type: str) -> bool:
    if _main_window(session):
        return False
    await session.send_json(make_error(msg_id, msg_type, "FORBIDDEN", "only a Navide main window may do this"))
    return True


async def _run(session: Any, msg_id: str, msg_type: str, fn: Any, *args: Any) -> Any:
    """Run a service call off the loop; answer errors. Returns None on error."""
    try:
        return await asyncio.to_thread(fn, *args)
    except CommanderNotFound:
        await session.send_json(make_error(msg_id, msg_type, "NOT_FOUND", "no such commander"))
    except (CommanderInvalid, TypeError) as err:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", str(err)))
    return None


def _live_pane(pane_id: str) -> Any:
    pane = agent_messaging.current(pane_id) if pane_id else None
    if pane is None and pane_id:
        raise CommanderInvalid("no such pane")
    return pane


async def commander_list(session: Any, msg_id: str, msg_type: str, payload: dict) -> None:
    if await _refuse_unless_main(session, msg_id, msg_type):
        return
    include = payload.get("include_archived") is True

    def build() -> list[dict[str, Any]]:
        svc = _svc()
        return [svc.summary(c) for c in svc.store.list(include_archived=include)]

    await session.send_json(make_response(msg_id, msg_type, {"commanders": await asyncio.to_thread(build)}))


async def commander_get(session: Any, msg_id: str, msg_type: str, payload: dict) -> None:
    if await _refuse_unless_main(session, msg_id, msg_type):
        return
    commander_id = str(payload.get("id") or "")

    def build() -> dict[str, Any]:
        svc = _svc()
        c = svc.store.get(commander_id)
        return {"commander": svc.summary(c), "memory": svc.store.read_memory(c.id), "tree": svc.tree(c.id)}

    answer = await _run(session, msg_id, msg_type, build)
    if answer is not None:
        await session.send_json(make_response(msg_id, msg_type, answer))


async def commander_tree(session: Any, msg_id: str, msg_type: str, payload: dict) -> None:
    if await _refuse_unless_main(session, msg_id, msg_type):
        return
    answer = await _run(session, msg_id, msg_type, _svc().tree, str(payload.get("id") or ""))
    if answer is not None:
        await session.send_json(make_response(msg_id, msg_type, answer))


async def commander_create(session: Any, msg_id: str, msg_type: str, payload: dict) -> None:
    if await _refuse_unless_main(session, msg_id, msg_type):
        return

    def run() -> dict[str, Any]:
        pane = _live_pane(str(payload.get("pane_id") or ""))
        c = _svc().create(_fields(payload), pane=pane, session_id=str(payload.get("session_id") or ""))
        return _svc().summary(c)

    summary = await _run(session, msg_id, msg_type, run)
    if summary is not None:
        await session.send_json(make_response(msg_id, msg_type, {"commander": summary}))
        await broadcast_changed(summary["id"])


async def commander_upgrade_pane(session: Any, msg_id: str, msg_type: str, payload: dict) -> None:
    if await _refuse_unless_main(session, msg_id, msg_type):
        return

    def run() -> dict[str, Any]:
        pane_id = str(payload.get("pane_id") or "")
        if not pane_id:
            raise CommanderInvalid("upgrade needs a pane_id")
        c = _svc().upgrade_pane(_live_pane(pane_id), _fields(payload),
                                session_id=str(payload.get("session_id") or ""))
        return _svc().summary(c)

    summary = await _run(session, msg_id, msg_type, run)
    if summary is not None:
        await session.send_json(make_response(msg_id, msg_type, {"commander": summary}))
        await broadcast_changed(summary["id"])


async def commander_downgrade(session: Any, msg_id: str, msg_type: str, payload: dict) -> None:
    if await _refuse_unless_main(session, msg_id, msg_type):
        return
    commander_id = str(payload.get("id") or "")
    c = await _run(session, msg_id, msg_type, _svc().downgrade, commander_id)
    if c is not None:
        await session.send_json(make_response(msg_id, msg_type, {"id": c.id}))
        await broadcast_changed(c.id)


async def commander_update(session: Any, msg_id: str, msg_type: str, payload: dict) -> None:
    if await _refuse_unless_main(session, msg_id, msg_type):
        return
    commander_id = str(payload.get("id") or "")
    changes = payload.get("changes")
    if not isinstance(changes, dict):
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", "update needs a changes object"))
        return

    def run() -> dict[str, Any]:
        return _svc().summary(_svc().update(commander_id, changes))

    summary = await _run(session, msg_id, msg_type, run)
    if summary is not None:
        await session.send_json(make_response(msg_id, msg_type, {"commander": summary}))
        await broadcast_changed(commander_id)


async def commander_archive(session: Any, msg_id: str, msg_type: str, payload: dict) -> None:
    if await _refuse_unless_main(session, msg_id, msg_type):
        return
    commander_id = str(payload.get("id") or "")
    c = await _run(session, msg_id, msg_type, _svc().archive, commander_id)
    if c is not None:
        await session.send_json(make_response(msg_id, msg_type, {"id": c.id}))
        await broadcast_changed(c.id)


HANDLERS = {
    "commander.list": commander_list,
    "commander.get": commander_get,
    "commander.tree": commander_tree,
    "commander.create": commander_create,
    "commander.upgrade_pane": commander_upgrade_pane,
    "commander.downgrade": commander_downgrade,
    "commander.update": commander_update,
    "commander.archive": commander_archive,
}
