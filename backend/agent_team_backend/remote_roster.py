"""Panes on *other* devices, as Navide-Server last described them.

``agent_messaging`` is this machine's roster: every window mirrors its panes
there and the backend owns their addressing. This module is the other half —
the sessions Navide-Server reports for every *other* device in the team space.
Without it a `<device>/<workspace>/<pane>` address is only usable by someone who
already knows the target device's id by heart, which is to say the whole
cross-device path is unreachable for an agent.

It is a cache of what the server said, never a source of truth. ``server_link``
is the only writer: it fills this from ``sessions.directory`` once per
connection and then from the ``sessions.changed`` push, both of which carry the
*whole* directory, so every write is a wholesale replace rather than a diff
this module would have to get right.

**Empty is the normal state.** A machine with no server configured never
receives a single entry, so every read here answers "no remote panes" and the
on-machine paths behave exactly as they did before cross-device addressing
existed.

**The cache survives a disconnect**, deliberately, the same way ``server_link``
keeps the pane policy across one: a link that dropped a second ago does not make
the panes it knew about stop existing, and forgetting them would turn every
reconnect into a window where an agent is told the device it was just talking to
is unknown.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

log = logging.getLogger("agent_team_backend.remote_roster")

#: Upper bound on cached remote panes. The directory is fed by other machines,
#: so it is only as small as they are well behaved; a cap keeps a runaway team
#: space from growing this process's memory without limit. Sessions past the cap
#: are dropped from the *end* of the server's own ordering (it sorts by
#: startedAt), so the oldest ones survive rather than an arbitrary set.
MAX_PANES = 500

#: The server's ``status`` vocabulary, as ``sessions.upsert`` enforces it: the
#: sending window's own badge words (idle / starting / running / awaiting /
#: exited / error / stopped), plus ``disconnected`` which only the directory
#: knows, plus ``waiting`` from a machine too old to send a badge word. Only the
#: values named below are interpreted — the raw word is reported alongside, so a
#: value this build has never heard of is passed through rather than hidden.
#:
#: ``awaiting`` is deliberately *not* busy: a pane holding a prompt open is the
#: opposite of working, and it is the one state a person looking at another
#: machine most needs to pick out. It used to arrive here as "running", because
#: the old sender had no word for it.
STATUS_BUSY = "running"
#: All mean "addressable, but a message would not land right now": the owning
#: window disconnected, the session ended, or the CLI behind it died. The last
#: two are new words — before them a crashed pane arrived as "waiting", which
#: claims the opposite.
STATUS_UNREACHABLE = frozenset({"disconnected", "exited", "error", "stopped"})


@dataclass
class RemotePane:
    """One session row from the server, in this codebase's vocabulary."""

    device_id: str
    device_name: str
    workspace: str
    workspace_path: str
    pane_name: str
    pane_id: str
    agent_key: str
    status: str
    host_online: bool
    #: That device's message public key, as the server distributes it. Empty
    #: when the far machine has never published one — which is what an
    #: un-upgraded peer looks like, and the only case where a message may still
    #: leave here as plaintext. See server_link._sealed_for.
    device_public_key: str = ""
    #: That device's *signing* public key, from the same channel. Only ever a
    #: candidate for a first pin: once ``trust_store`` has pinned a device, this
    #: field is compared against the pin and never replaces it, so a server that
    #: swaps it makes the device unreachable rather than impersonable.
    device_sign_public_key: str = ""

    @property
    def device_label(self) -> str:
        """How a human would name the device: its name when the server knows
        one, otherwise the id, which is always there."""
        return self.device_name or self.device_id

    @property
    def address(self) -> str:
        """The `to:` string that reaches this pane.

        Always spelled with the device *id*, never the name: the id is unique by
        construction and is recognised before any local workspace is consulted,
        while a name is only tried after local resolution has failed (see
        ``agent_messaging.parse_remote_target``). Handing an agent the id form
        means the address it copies works the same whatever this machine's own
        workspaces happen to be called.
        """
        return f"{self.device_id}/{self.workspace}/{self.pane_name}"

    @property
    def busy(self) -> bool:
        return self.status == STATUS_BUSY

    @property
    def offline(self) -> bool:
        return not self.host_online or self.status in STATUS_UNREACHABLE

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.pane_name,
            "address": self.address,
            "device": self.device_label,
            "workspace": self.workspace,
            "workspace_path": self.workspace_path,
            "agent_key": self.agent_key,
            "busy": self.busy,
            "offline": self.offline,
            # The two halves of `offline`, kept apart because they call for
            # different answers: a whole machine that is away can only be
            # waited for, while one window reconnecting is over in seconds.
            "host_online": self.host_online,
            "status": self.status,
            # Which segment is down, so a report can say so (2026-11-22).
            **({"offline_reason": self.offline_reason} if self.offline else {}),
        }

    @property
    def offline_reason(self) -> str:
        """"device-offline": that machine has no connection to the server;
        "window-disconnected": it has, the window holding the pane has not;
        "session-ended": the CLI behind the pane is gone. "" when reachable."""
        if not self.host_online:
            return "device-offline"
        if self.status == "disconnected":
            return "window-disconnected"
        if self.status in STATUS_UNREACHABLE:
            return "session-ended"
        return ""


# sessionId -> pane. The server's own key, so a row that is updated replaces
# itself even when its paneId changed underneath (a detach mints a new one).
_PANES: dict[str, RemotePane] = {}


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _pane_from_row(row: dict[str, Any]) -> RemotePane | None:
    """Read one ``sessions.directory`` row, or None if it cannot be addressed.

    A row with no device, workspace or title is not rejected as malformed — it
    is simply unaddressable, because those three are exactly what a
    `<device>/<workspace>/<pane>` address is made of. Listing it would show an
    agent a target it has no way to name.
    """
    device_id = _text(row.get("deviceId"))
    workspace = _text(row.get("workspace"))
    pane_name = _text(row.get("title"))
    if not device_id or not workspace or not pane_name:
        return None
    return RemotePane(
        device_id=device_id,
        # Not part of the session row today (see the module note in
        # server_link._apply_directory); read anyway so a server that starts
        # sending it needs no change here.
        device_name=_text(row.get("deviceName")),
        workspace=workspace,
        workspace_path=_text(row.get("workspacePath")),
        pane_name=pane_name,
        pane_id=_text(row.get("paneId")),
        agent_key=_text(row.get("agentKey")),
        status=_text(row.get("status")),
        host_online=bool(row.get("hostOnline")),
        device_public_key=_text(row.get("devicePublicKey")),
        device_sign_public_key=_text(row.get("deviceSignPublicKey")),
    )


def replace(sessions: list[Any], *, local_device_id: str) -> None:
    """Rebuild the cache from a full session directory.

    ``local_device_id`` is dropped rather than kept and filtered later: this
    machine's own panes are already in ``agent_messaging`` with live state,
    whereas the server's copy of them is whatever was last reported. Two
    answers for one pane is one too many, and the stale one would be the one an
    agent reaches for a `<device>/...` address aimed back at this very machine.
    """
    fresh: dict[str, RemotePane] = {}
    dropped = 0
    for row in sessions:
        if not isinstance(row, dict):
            continue
        session_id = _text(row.get("sessionId"))
        if not session_id:
            continue
        if local_device_id and _text(row.get("deviceId")) == local_device_id:
            continue
        pane = _pane_from_row(row)
        if pane is None:
            continue
        if len(fresh) >= MAX_PANES:
            dropped += 1
            continue
        fresh[session_id] = pane
    if dropped:
        log.warning(
            "navide-server reported more remote panes than this cache holds; "
            "dropped %d beyond %d",
            dropped,
            MAX_PANES,
        )
    _PANES.clear()
    _PANES.update(fresh)


def set_online_devices(device_ids: set[str]) -> None:
    """Re-flag every cached pane from a presence snapshot.

    Needed because the two facts arrive on different events: the server pushes
    ``sessions.changed`` when a session row changes, but a device dropping off
    changes no row — it only changes ``hostOnline``, and that goes out as
    ``presence.changed``. Without this the cache would keep reporting a machine
    that left as online until something else happened to touch its sessions.
    """
    for pane in _PANES.values():
        pane.host_online = pane.device_id in device_ids


def public_key_for(device_id: str) -> str:
    """That device's message public key, or "" when the roster has never seen
    one for it.

    Read from the roster rather than from a key store because the roster *is*
    how keys are distributed — the server sends them alongside the sessions,
    the same way Tailscale hands out node keys with the netmap. A device with
    no sessions is therefore also a device nobody can encrypt to, which is not
    a gap: without a session there is no pane to address either.
    """
    for pane in _PANES.values():
        if pane.device_id == device_id and pane.device_public_key:
            return pane.device_public_key
    return ""


def sign_public_key_for(device_id: str) -> str:
    """That device's signing public key as the directory currently reports it,
    or "" when it reports none.

    Read from the same channel as the message key, and worth just as little on
    its own: this is what the *server* says, so it is only ever a candidate for
    a first pin. Once ``trust_store`` holds a pin, verification uses the pin and
    this value's only job is to say whether the far side's key has changed.
    """
    for pane in _PANES.values():
        if pane.device_id == device_id and pane.device_sign_public_key:
            return pane.device_sign_public_key
    return ""


def list_panes() -> list[RemotePane]:
    """Every known remote pane, ordered for stable listing."""
    return sorted(
        _PANES.values(), key=lambda p: (p.device_label, p.workspace, p.pane_name)
    )


def list_devices() -> list[dict[str, Any]]:
    """The devices this cache knows of, for the pane-policy editor's picker.

    Derived from the panes rather than tracked separately: the session
    directory is the only thing the server sends, so a device with no session
    in it is one nobody could have addressed anyway. ``deviceName`` may be
    empty — the server does not put it on session rows today (see
    ``_pane_from_row``) — so a caller rendering a label falls back to the id,
    which is what a rule is written against either way.
    """
    devices: dict[str, dict[str, Any]] = {}
    for pane in _PANES.values():
        entry = devices.setdefault(
            pane.device_id,
            {"deviceId": pane.device_id, "deviceName": "", "paneCount": 0},
        )
        entry["paneCount"] = int(entry["paneCount"]) + 1
        if not entry["deviceName"] and pane.device_name:
            entry["deviceName"] = pane.device_name
    return sorted(devices.values(), key=lambda d: (d["deviceName"] or d["deviceId"]))


def devices_named(label: str) -> list[str]:
    """Device ids addressable as ``label``: its id exactly, or its name
    case-insensitively.

    Returns every match, so the caller can refuse an ambiguous name instead of
    picking a machine for the user: two people can name their laptops the same
    thing, and sending an instruction to the wrong one is not recoverable by
    reading an error message afterwards. Case folding makes that collision
    slightly more likely (``Laptop`` and ``laptop`` are now one name) and it is
    still refused, never resolved to whichever came first.
    """
    want = _text(label)
    if not want:
        return []
    # The two halves of the label are different kinds of string, so they get
    # different rules. A deviceId is an opaque machine-issued identifier: folding
    # its case can only make two distinct ids collide, never help anyone, so it
    # stays exact. A deviceName is typed by the person who named the machine
    # "MacBook" and then addresses it as "macbook"; Navide-Server stores that
    # name verbatim (no normalisation) and never resolves anything by it, so how
    # loosely it is matched is entirely this machine's call and cannot diverge
    # from the server's.
    #
    # Deliberately the opposite of ``pane_policy``, which compares every field
    # case-sensitively — see the note beside ``pane_policy._FIELDS``. The
    # asymmetry is in the cost of being wrong: loosening a *policy* match widens
    # a grant under deny-by-default, i.e. it authorizes what the rule's author
    # meant to refuse, while loosening an *address* match only ever reaches a
    # machine the sender already named. The failure here is "device not found",
    # and a collision is refused rather than guessed
    # (``agent_messaging.parse_remote_target``).
    folded = want.casefold()
    return sorted(
        {
            p.device_id
            for p in _PANES.values()
            if want == p.device_id or (p.device_name and folded == p.device_name.casefold())
        }
    )


def clear() -> None:
    """Forget everything — the server was unconfigured, so its roster is no
    longer this machine's to report."""
    _PANES.clear()


def _reset_for_test() -> None:
    _PANES.clear()
