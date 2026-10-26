"""Process-wide guard state: the store and the renderer event sink."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .store import GuardStore

log = logging.getLogger(__name__)

_store: GuardStore | None = None
# The backend's event loop. Hook endpoints run evaluate() in a worker thread,
# where there is no running loop; events raised there are handed back to it.
_loop: asyncio.AbstractEventLoop | None = None


def store() -> GuardStore:
    global _store
    if _store is None:
        from .. import app

        _store = GuardStore(app.database)
    return _store


def enabled_cached() -> bool | None:
    """The Guard switch if a store is open and has read it, else None. Opens
    nothing and reads no database, so the event loop may call it."""
    return _store.enabled_cached() if _store is not None else None


def flush() -> None:
    """Write the queued audit rows, if a store was ever opened."""
    if _store is not None:
        _store.flush()


def set_store_for_test(s: GuardStore | None) -> None:
    global _store
    _store = s


def remember_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Called at app startup (and on any in-loop emit) so off-loop emits work."""
    global _loop
    _loop = loop


def emit(event_type: str, payload: dict[str, Any]) -> None:
    """Broadcast a guard event to renderer windows, from the loop or a thread."""
    from ..ipc import make_event

    event = make_event(event_type, payload)
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = _loop
        if loop is None or loop.is_closed():
            log.warning("guard: %s dropped: no event loop known yet", event_type)
            return
        loop.call_soon_threadsafe(_send_all, loop, event)
        return
    remember_loop(loop)
    _send_all(loop, event)


def _send_all(loop: asyncio.AbstractEventLoop, event: dict[str, Any]) -> None:
    from .. import app

    # Straight to each session rather than through app.broadcast: guard events
    # ride alongside message deliveries, and callers (and their tests) that
    # count the broadcasts of a delivery must keep seeing exactly one.
    for session in list(app._SESSIONS):
        task = loop.create_task(session.send_json(event))
        task.add_done_callback(_log_failure)


def _log_failure(task: asyncio.Task) -> None:
    if not task.cancelled() and task.exception() is not None:
        log.warning("guard: event broadcast failed: %s", task.exception())
