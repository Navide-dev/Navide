"""A chat command asks the Host to list or stop third-party Navide plugins (plan P2).

``/plugins status`` and ``/plugins stop <id>`` in a bound chat reach the Host
as ``plugins.stop.request`` over its authenticated session; the Host answers
with ``plugins.stop.result``. A stop is the user's own (the chat is theirs):
it is the Host's Disabled switch plus a record of where it came from and what
the plugin was doing, and enabling again stays in the Navide window. Nothing
here can start a plugin.
"""

from __future__ import annotations

import secrets
from typing import Any

from ..pending_registry import TIMEOUT, PendingRegistry
from . import agent_tools_contract as contract

#: How long a chat waits for the Host. A stop drains the plugin first.
HOST_TIMEOUT_S = 30.0

_pending: PendingRegistry[dict[str, Any]] = PendingRegistry()


async def ask_host(
    action: str, plugin_id: str | None = None, *, requester: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """The Host's answer to ``status``, ``stop`` or ``stop-all``, or None when no
    Host answered in time. ``requester`` (``stop-all`` from MCP only) names the
    agent; without it the stop is the user's own."""
    from .. import app
    from ..ipc import make_event

    request_id = f"ps:{secrets.token_hex(16)}"
    payload: dict[str, Any] = {"request_id": request_id, "action": action}
    if plugin_id is not None:
        payload["plugin_id"] = plugin_id
    if requester is not None:
        payload["requester"] = requester
    future = _pending.register(request_id)
    try:
        sent = await app.unicast_host(make_event(contract.PLUGIN_STOP_REQUEST_EVENT, payload))
        result = await _pending.wait(request_id, future, timeout=HOST_TIMEOUT_S) if sent else TIMEOUT
    finally:
        _pending.discard(request_id)
    return None if result is TIMEOUT else result  # type: ignore[return-value]


def resolve(request_id: str, response: dict[str, Any]) -> bool:
    """Resolve one ``plugins.stop.request`` with the Host's answer."""
    return _pending.resolve(request_id, response)
