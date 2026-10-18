"""Where a `to:` target goes — the one answer, for every way of asking.

Two surfaces send messages between agents: the MCP tool ``cli_send``, and the
bare-line protocol an agent prints into its own terminal, which the window
routes through the ``agent_msg.route`` handler. They took the same strings and
gave different answers.

Cross-device addressing was built onto ``cli_send`` alone (8cca3aed: "cli_send
only ever reached panes on the same machine"), and the roster that resolves a
device *name* came later (a0358412). Neither touched the bare-line handler, and
nothing in either commit says that was a decision — so ``<device>/<ws>/<pane>``
worked from the tool and answered "unknown device" from a printed block, for the
same address, at the same moment. The error even said the roster was "not
available yet", written before the roster existed and never revisited.

So the resolution order lives here, once, and both callers use it. Keeping two
copies in step is not something anybody would notice failing: the paths agree
today and would drift on the next change to either.

Layering: ``agent_messaging`` is the pane registry and must not know about the
link (it imports only ``device_identity`` and ``remote_roster``). This module
sits above both, which is the position ``mcp_server.server`` already occupied.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass, field
from typing import Any

from . import agent_messaging

# Server-side refusals of messages.send, in the vocabulary the local resolver
# already uses. DEVICE_OFFLINE stays distinct from "target-offline": one is the
# whole machine unreachable, the other one window disconnected, and only the
# second is worth waiting out.
RELAY_ERROR_CODES = {
    "DEVICE_OFFLINE": "device-offline",
    "NOT_FOUND": "unknown-target",
    # Minted by the link itself (server_link.LINK_OFFLINE / LINK_UNAUTHORIZED),
    # not by the server: the message never left this machine.
    "LINK_OFFLINE": "link-offline",
    "LINK_UNAUTHORIZED": "link-unauthorized",
}

# The subset of the above that describes *this machine's* link, not the target.
# They get a different sentence because "refused" would point the agent at its
# address when the address was never the problem.
LINK_STATE_CODES = frozenset({"link-offline", "link-unauthorized"})


@dataclass
class Routed:
    """Where a target resolved to.

    Exactly one of ``pane``, ``remote`` and ``code`` is meaningful. A remote
    answer is an address, not a delivery: the caller decides whether to relay it,
    because the two callers report the outcome in different shapes.
    """

    pane: Any = None
    cross_workspace: bool = False
    remote: agent_messaging.Address | None = None
    error: str = ""
    code: str = ""
    params: dict[str, str] = field(default_factory=dict)


def route(from_pane_id: str, to: str) -> Routed:
    """Resolve *to* as seen from the sending pane.

    The order is the load-bearing part, and it is the order ``cli_send`` already
    used:

    1. An explicit device segment that is not this machine goes remote — unless
       the whole address names a pane here, read as a workspace path with a
       UUID-shaped folder in it. Local wins in this step too (M4): such
       folders are common on macOS, and a message for a pane on this machine
       must never leave it.
    2. Otherwise the local resolver answers. **Local addressing wins**: a target
       that resolves on this machine never reaches step 3, so naming a laptop
       after a folder can never redirect an address that works today.
    3. Only once local resolution has failed is the first segment reconsidered
       as a device *name*. With no server configured the roster is empty and
       this is a no-op, which leaves the answer exactly what it was before
       cross-device addressing existed.
    """
    address = agent_messaging.parse_target(to)
    if address.device_id and not agent_messaging.is_local_device(address.device_id):
        # The error is carried alongside the address, not instead of it: a
        # machine with no server configured has no link to relay over, and the
        # caller then answers with exactly what it answered before cross-device
        # addressing existed rather than inventing a failure for a feature this
        # machine was never set up for.
        unreachable = agent_messaging.resolve(from_pane_id, to)
        if unreachable.pane is not None:
            return Routed(pane=unreachable.pane, cross_workspace=unreachable.cross_workspace)
        return Routed(
            remote=address,
            error=unreachable.error or "",
            code=unreachable.code or "",
            params=unreachable.params or {},
        )

    result = agent_messaging.resolve(from_pane_id, to)
    if result.pane is not None:
        return Routed(pane=result.pane, cross_workspace=result.cross_workspace)

    remote = agent_messaging.parse_remote_target(to)
    if remote.error:
        return Routed(error=remote.error, code=remote.code or "", params=remote.params or {})
    if remote.address is not None:
        return Routed(remote=remote.address)

    return Routed(
        error=result.error or f'unknown target "{to}"',
        code=result.code or "unknown-target",
        params=result.params or {},
    )


@dataclass
class Relayed:
    """What the link did with a message aimed at another machine."""

    ok: bool
    msg_key: str = ""
    target: str = ""
    error: str = ""
    code: str = ""
    link_state: str = ""
    last_error: str = ""


async def relay(
    address: agent_messaging.Address,
    text: str,
    *,
    from_pane_id: str,
    msg_key: str,
) -> Relayed | None:
    """Send *text* to a pane on another machine.

    Returns None when there is no link to relay over, so a caller can answer the
    way it did before cross-device addressing existed rather than inventing a
    failure for a feature the machine was never configured for. A
    configured-but-unreachable server does not come back as None — that answers
    ``link-offline``.
    """
    from . import server_link

    sender = agent_messaging.get(from_pane_id) if from_pane_id else None
    reply = await server_link.send_message(
        to={
            "deviceId": address.device_id,
            "workspace": address.workspace,
            "paneName": address.pane_name,
        },
        sender=(
            {
                "workspace": sender.workspace_label,
                "paneName": sender.name,
                "paneId": sender.pane_id,
            }
            if sender
            else None
        ),
        text=text,
        msg_key=msg_key,
    )
    if reply is None:
        return None
    if not reply.get("ok"):
        error = reply.get("error") if isinstance(reply.get("error"), dict) else {}
        code = str(error.get("code") or "SEND_FAILED")
        detail = str(error.get("message") or "")
        mapped = RELAY_ERROR_CODES.get(code, code)
        if mapped in LINK_STATE_CODES:
            # The link's own words plus what to do about them. "Not connected"
            # alone sent an agent looking at the address it typed, when the
            # address was never the problem — and worse, told it to retry in the
            # two states where retrying cannot help.
            state = str(error.get("state") or "")
            what_to_do = {
                "unauthorized": "this machine has to sign in to the server again",
                "unreachable": "the server address is not answering from here",
                "connecting": "the link is still starting up; this one is worth retrying",
            }.get(state, "")
            return Relayed(
                ok=False,
                target=address.to_string(),
                error=f'"{address.to_string()}" could not be reached — '
                + (detail or code)
                + (f". {what_to_do}" if what_to_do else ""),
                code=mapped,
                link_state=state,
                last_error=str(error.get("lastError") or ""),
            )
        return Relayed(
            ok=False,
            target=address.to_string(),
            error=f'sending to "{address.to_string()}" was refused ({code})'
            + (f": {detail}" if detail else ""),
            code=mapped,
        )
    return Relayed(ok=True, msg_key=msg_key, target=address.to_string())


def mint_msg_key(origin: str) -> str:
    """A key for one relayed message. Unique per send, and prefixed with whoever
    sent it so a log line says where to look."""
    return f"{origin}:relay:{secrets.token_hex(8)}"
