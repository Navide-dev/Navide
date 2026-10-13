"""Cross-workspace inter-CLI messaging registry.

Renderer windows mirror their local pane handles here. The backend is the only
process that sees every workspace at once, so it owns target resolution for
`to: <folder>/<pane>` addresses. Delivery itself stays in the frontend
(injectPane), so the idle gate, per-pair rate limit, queue cap and message log
all keep working exactly as before.

Name uniqueness is per workspace — the same handle may exist in two different
workspaces, and a bare `to: <name>` still resolves only within the sender's own
workspace, which is today's behaviour unchanged.

Addresses carry an optional third dimension, the device: `to:
<device>/<workspace>/<pane>` names a pane on a specific machine. A UUID-shaped
leading segment is read as a device id here; anything else is only reconsidered
as a device *after* local resolution has failed, against the remote roster
(`parse_remote_target`), so no address that resolves on this machine today can
be re-pointed at another one.
"""

from __future__ import annotations

import logging
import os
import re
import time
from dataclasses import dataclass
from typing import Any, Callable

from . import device_identity, remote_roster

log = logging.getLogger("agent_team_backend.agent_messaging")

#: How long a disconnected window's panes stay in the registry, flagged offline,
#: before they are forgotten for good. The renderer's reconnect backoff is
#: capped at 30s (`reconnectMaxMs` in src/shared/wsClient.ts), so this has to
#: outlast a couple of those attempts — a window that is merely reloading or
#: riding out a network blip must not have its panes reported as non-existent.
OFFLINE_GRACE_S = 90.0

#: A device segment is always a UUID (device_identity mints and validates it as
#: one), and that is the whole reason `<device>/<workspace>/<pane>` can be told
#: apart from the two-segment `<workspace>/<pane>` — whose workspace part may
#: itself contain slashes (`parent/proj/pane`). A leading segment that is not
#: UUID-shaped is therefore read as workspace, exactly as before.
_DEVICE_SEGMENT_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


@dataclass
class RegisteredPane:
    pane_id: str
    name: str
    workspace_path: str
    agent_key: str
    #: True while the pane's agent is mid-turn. Reported by the owning window on
    #: turn start/end, so it lags reality by one event at worst — good enough to
    #: tell a caller "it is working, your message will wait", not a lock.
    busy: bool = False
    #: Monotonic timestamp of when the owning window's WS connection dropped, or
    #: None while it is connected. The pane itself survives that disconnect (its
    #: PTY is owned by the backend), so the entry is kept and flagged instead of
    #: deleted — "offline" and "does not exist" need different answers.
    offline_since: float | None = None
    #: False while the pane is only a restore placeholder: the window holds the
    #: saved pane but has not started its CLI yet. The handle is registered all
    #: the same, so the pane stays addressable and a message for it parks until
    #: someone opens it — but nothing is running behind it, and a caller that
    #: reads `busy` alone cannot tell that apart from a working agent.
    realized: bool = True
    #: The word the owning window's sidebar badge is showing for this pane, from
    #: the renderer's own DisplayStatus vocabulary (idle / starting / running /
    #: awaiting / exited / error / stopped). Empty until that window reports one,
    #: which is what an older build looks like — callers fall back to `busy`.
    #:
    #: Deliberately separate from `busy` rather than replacing it. `busy` answers
    #: "would a message sent now have to wait", which is a delivery question and
    #: the right one for cli_wait_idle; this answers "what is this pane doing",
    #: which is a display question. They disagree in both directions — a pane
    #: with a half-typed draft is busy but idle, a crashed pane is not busy and
    #: not idle either — and collapsing them is what made the network view call a
    #: dead pane "waiting".
    display_status: str = ""
    #: Pane id of the pane that opened this one (a SPAWN block or
    #: cli_open_agent), mirrored from the owning window's `spawnedBy`. Empty for
    #: a pane nobody opened, and for a window on a build that predates this
    #: field.
    #:
    #: The registry keeps it for one reason: a child agent can otherwise learn
    #: who opened it only from the words of its kickoff prompt, so a compaction
    #: loses its parent for good and it no longer knows who to report to.
    #: cli_whoami answers that from here. It is deliberately NOT reported by
    #: cli_list_targets — the roster is who exists, not who is related to whom;
    #: this is a fact about yourself, which is the one lineage question you are
    #: entitled to ask.
    spawned_by: str = ""
    #: Which window surface hosts this pane, for an embedded AI panel
    #: (AiCliDock): "pm" for the Pipeline Manager modal, "plans" / "git" /
    #: "editor" for those windows. Empty for an ordinary window pane — which is
    #: every pane the main window registers, since it never sends the field.
    surface: str = ""
    #: The kind of window that surface lives in ("main" for the Pipeline
    #: Manager modal, else the surface's own window). Empty alongside `surface`.
    window_kind: str = ""
    #: True when the panel's window delivers messages into it itself (it
    #: listens for agent_msg.deliver and reports agent_msg.delivered). Only a
    #: panel sets it; a panel without it is refused as a target (see _accept).
    deliverable: bool = False

    @property
    def is_dock(self) -> bool:
        """An embedded AI panel rather than a pane of a window's pane pool.

        It can act through the MCP tools like any pane; it is accepted as a
        message target only when it registered as deliverable (see _accept)."""
        return bool(self.surface) and self.surface != "main"

    @property
    def offline(self) -> bool:
        return self.offline_since is not None

    def offline_seconds(self) -> int:
        return 0 if self.offline_since is None else int(time.monotonic() - self.offline_since)

    @property
    def workspace_label(self) -> str:
        """Folder basename used in `<folder>/<pane>` addresses."""
        return os.path.basename(self.workspace_path.rstrip("/")) or self.workspace_path

    @property
    def qualified_name(self) -> str:
        return f"{self.workspace_label}/{self.name}"

    def to_dict(self) -> dict[str, Any]:
        view: dict[str, Any] = {
            "pane_id": self.pane_id,
            "name": self.name,
            "workspace_path": self.workspace_path,
            "workspace_label": self.workspace_label,
            "qualified_name": self.qualified_name,
            "agent_key": self.agent_key,
            "busy": self.busy,
            "offline": self.offline,
            "realized": self.realized,
            "displayStatus": self.display_status,
        }
        # Added only when set, so a pane registered without them — every pane
        # the main window mirrors — reports exactly the keys it always has.
        if self.surface:
            view["surface"] = self.surface
        if self.window_kind:
            view["window_kind"] = self.window_kind
        if self.deliverable:
            view["deliverable"] = True
        return view


@dataclass
class ResolveResult:
    pane: RegisteredPane | None = None
    error: str | None = None
    #: Stable machine code for the same failure, plus its substitutions. `error`
    #: stays the English sentence — it is what the MCP tools hand back to a
    #: calling agent — while the UI localizes from the code instead of parsing
    #: that sentence.
    code: str | None = None
    params: dict[str, str] | None = None
    cross_workspace: bool = False


@dataclass
class Address:
    """A `to:` target broken into its parts — the structured shape used for
    cross-device addressing.

    `device_id` and `workspace` are empty when the address did not name them,
    which is what keeps `<workspace>/<pane>` and a bare `<pane>` meaning today
    what they meant yesterday. `pane_id` is only ever a hint: a detach or a
    reattach mints a new pane id, so the stable identity is the other three
    parts and the hint is checked against them before it is trusted.
    """

    pane_name: str = ""
    workspace: str = ""
    device_id: str = ""
    pane_id: str = ""

    @property
    def local_target(self) -> str:
        """The `<workspace>/<pane>` (or bare `<pane>`) string this address
        resolves as on the device that owns the pane."""
        return f"{self.workspace}/{self.pane_name}" if self.workspace else self.pane_name

    def to_string(self) -> str:
        """The address as an agent would have typed it."""
        return f"{self.device_id}/{self.local_target}" if self.device_id else self.local_target


def _resolve_error(code: str, error: str, **params: object) -> ResolveResult:
    return ResolveResult(
        error=error, code=code, params={k: str(v) for k, v in params.items()}
    )


def _unknown_device(device: str, to: str) -> ResolveResult:
    """Reported instead of "unknown target": the address may well be right, it
    names a machine this one has no way to reach.

    It used to say the roster was "not available yet". That was written before
    the roster existed and never revisited after it was added — by then the
    sentence described nothing, and an agent reading it would wait for something
    that was already there. What actually stops the message now is having no
    link to send it over: every caller that *can* relay does so before this
    error is ever shown (see message_routing.route), so reaching here means this
    machine is not signed in to a Navide-Server at all.
    """
    return _resolve_error(
        "unknown-device",
        f'unknown device "{device}" in target "{to}" — this machine is not '
        f"linked to a Navide-Server, so it can only address panes on itself",
        device=device,
        to=to,
    )


@dataclass
class PaneAlias:
    """A pane id something outside this process still carries, and the pane it
    now names.

    A pane id is minted per pane *object*, not per CLI process: reattaching a
    live PTY (a window reload, a detach, taking a run group back from a detached
    window) builds a new pane around the same running CLI and mints a new id.
    Anything that was handed the old id at spawn time — the `?pane=` in the
    CLI's own /plan-mcp URL above all — keeps quoting it for as long as that
    process lives. The alias is how the old id keeps resolving to the pane it
    describes, instead of resolving to nothing.

    ``workspace_path`` is the workspace the alias was accepted for: an id is
    only ever allowed to follow a pane inside the project it belonged to, so a
    former id cannot be claimed by a pane in another workspace.
    """

    pane_id: str
    workspace_path: str


# pane_id -> RegisteredPane
_PANES: dict[str, RegisteredPane] = {}
# pane_id -> owning WS connection (opaque; only identity is used)
_OWNERS: dict[str, Any] = {}
# superseded pane_id -> the pane that took its place
_ALIASES: dict[str, PaneAlias] = {}

#: How many forgotten pane ids are remembered. Only the MCP caller check reads
#: them, to tell "this id was a pane once" from "this id was never registered";
#: a few hundred covers every pane a long session closes without growing forever.
FORGOTTEN_IDS_MAX = 512
# pane ids removed from the registry, oldest first (insertion order)
_FORGOTTEN: dict[str, None] = {}


def _remember_forgotten(pane_id: str) -> None:
    _FORGOTTEN.pop(pane_id, None)
    _FORGOTTEN[pane_id] = None
    while len(_FORGOTTEN) > FORGOTTEN_IDS_MAX:
        _FORGOTTEN.pop(next(iter(_FORGOTTEN)))


def was_forgotten(pane_id: str) -> bool:
    """Whether ``pane_id`` named a registered pane that has since been removed
    (closed, or offline past the grace period) — as opposed to an id this
    backend never saw registered at all."""
    return pane_id in _FORGOTTEN

# Observers of the registry (chat-channel mirroring), called synchronously as
# (event, pane_id) with event "register" | "unregister" | "status", and of the
# message-log rows windows append. They must be cheap and must not raise.
pane_listeners: list[Callable[[str, str], None]] = []
message_row_listeners: list[Callable[[list[dict[str, Any]]], None]] = []


def _notify_pane(event: str, pane_id: str) -> None:
    for listener in list(pane_listeners):
        try:
            listener(event, pane_id)
        except Exception:  # noqa: BLE001 — an observer must never break the registry
            log.exception("agent_messaging: pane listener failed")


def notify_message_rows(rows: list[Any]) -> None:
    """Tell observers which rows a window just appended to the message log."""
    clean = [r for r in rows if isinstance(r, dict)]
    for listener in list(message_row_listeners):
        try:
            listener(clean)
        except Exception:  # noqa: BLE001
            log.exception("agent_messaging: delivery listener failed")


def _normalize_workspace(path: str) -> str:
    return (path or "").rstrip("/") or (path or "")


def register(
    pane_id: str,
    name: str,
    workspace_path: str,
    agent_key: str = "",
    owner: Any = None,
    realized: bool = True,
    spawned_by: str = "",
    surface: str = "",
    window_kind: str = "",
    deliverable: bool = False,
) -> RegisteredPane:
    """Mirror one window's pane handle. Re-registering the same pane replaces
    its entry, which is how renames propagate."""
    previous = _PANES.get(pane_id)
    entry = RegisteredPane(
        pane_id=pane_id,
        name=name,
        workspace_path=_normalize_workspace(workspace_path),
        agent_key=agent_key,
        # A re-register is a rename or a reconnect, not a state change.
        busy=previous.busy if previous else False,
        display_status=previous.display_status if previous else "",
        # Read from the caller every time instead of being carried over: a
        # window re-mirrors its panes on reconnect, and whether a placeholder
        # has been opened since is exactly what that re-mirror is reporting.
        realized=realized,
        # Read from the caller every time, like `realized`: the owning window
        # holds the pane object this comes from and re-sends it on every mirror,
        # and a re-key (restore mints a new parent pane id) arrives as exactly
        # such a re-register — carrying the old value over would pin the pane to
        # an id nothing answers to any more.
        spawned_by=spawned_by,
        surface=surface,
        window_kind=window_kind,
        deliverable=deliverable,
        # A reconnecting window re-runs agent_msg.register for every pane it
        # mirrors, which is what clears the offline flag drop_owner set:
        # offline_since starts at None on the fresh entry.
    )
    _PANES[pane_id] = entry
    _FORGOTTEN.pop(pane_id, None)
    if owner is not None:
        _OWNERS[pane_id] = owner
    _notify_pane("register", pane_id)
    return entry


def add_aliases(pane_id: str, former_pane_ids: list[str], workspace_path: str) -> list[str]:
    """Record the pane ids this pane used to be known by. Returns those accepted.

    Called from the same register the owning window runs after it rebuilds a
    pane around a CLI that never stopped running, so the id that CLI was given
    at spawn time keeps naming it.

    Two rules keep an alias from meaning more than it should. A former id is
    refused when it is already tied to a *different* workspace — a pane may
    inherit its own past, never another project's. And a chain is flattened as
    it grows: reloading twice makes A→B and then B→C, so everything that
    pointed at B is repointed at C. One lookup always suffices, and forgetting
    B cannot strand A.

    What is *not* checked is whether the former id still names a live pane of
    somebody else's, and it cannot be: a detach registers the pane in the child
    window before the parent lets go of it, so at that moment the id is live,
    online, and owned by a different window — exactly what a mistaken claim
    would look like. The declaration is trusted because it comes from a Navide
    renderer, which is inside the trust boundary; a claim over a pane that is
    still online is logged so it is at least visible, and the one thing it must
    not be allowed to do — take a live pane's push channel away — is refused
    separately (push_delivery.adopt).

    One case is known to reach that warning without a hand-over behind it, and
    is left as a limitation rather than worked around here: a main window
    reloading while one of its run groups is detached restores that group's
    panes (`restoreWorkspacePanes` has no filter for it) before
    `getDetachedGroups` answers, so for a moment it claims the child window's
    ids. It cannot be fixed by ordering alone — the main process answers that
    query with an empty list until it knows the window's workspace — and the
    window drops those panes as soon as it is told, which retires the aliases
    with them.
    """
    workspace = _normalize_workspace(workspace_path)
    accepted: list[str] = []
    for raw in former_pane_ids:
        former = (raw or "").strip()
        if not former or former == pane_id:
            continue
        known = _PANES.get(former)
        if known is not None and known.workspace_path != workspace:
            continue
        existing = _ALIASES.get(former)
        if existing is not None and existing.workspace_path != workspace:
            continue
        if known is not None and not known.offline:
            log.warning(
                "pane %s claims %s as a former id while it is still online "
                "(same owner: %s) — expected during a detach, otherwise a "
                "window restored a pane another window owns",
                pane_id, former, _OWNERS.get(former) is _OWNERS.get(pane_id),
            )
        for key in [k for k, alias in _ALIASES.items() if alias.pane_id == former]:
            if key == pane_id:
                # The pane is that id again (A→B, then A comes back declaring
                # B). An alias from an id to itself is not an alias.
                _ALIASES.pop(key, None)
                continue
            _ALIASES[key] = PaneAlias(pane_id=pane_id, workspace_path=workspace)
        _ALIASES[former] = PaneAlias(pane_id=pane_id, workspace_path=workspace)
        accepted.append(former)
    return accepted


def is_vacated(pane_id: str) -> bool:
    """Whether nothing live is still holding this pane id.

    True when the id was unregistered, or when the window that mirrored it is
    away. Asked before anything is *taken* from a former id rather than merely
    resolved through it — resolving is additive, moving is not.
    """
    entry = _PANES.get(pane_id)
    return entry is None or entry.offline


def resolve_alias(pane_id: str) -> str:
    """The pane id that superseded ``pane_id``, or "" when none did."""
    alias = _ALIASES.get(pane_id)
    return alias.pane_id if alias is not None else ""


def former_ids(pane_id: str) -> list[str]:
    """Every former id that now resolves to this pane (the inverse of
    resolve_alias). Chains are flattened as they grow, so one pass finds them
    all."""
    return [former for former, alias in _ALIASES.items() if alias.pane_id == pane_id]


def owner_of(pane_id: str) -> Any:
    """The WS connection currently mirroring ``pane_id``, or None when no live
    window holds it (never registered, or its window disconnected)."""
    return _OWNERS.get(pane_id)


def current(pane_id: str) -> RegisteredPane | None:
    """The pane a possibly-superseded id names right now.

    An id that has been superseded is never itself any more, even while its own
    entry is still in the registry waiting out the offline grace period — the
    CLI quoting it is attached to the successor, and answering with the old
    entry would let the pane see itself as somebody else.
    """
    purge_expired()
    alias = _ALIASES.get(pane_id)
    if alias is not None:
        return _PANES.get(alias.pane_id)
    return _PANES.get(pane_id)


def _forget_aliases_to(pane_id: str) -> None:
    """Drop the former ids of a pane that is gone for good. Aliases *keyed* by
    it are left alone: an id being unregistered right after something else
    adopted it is exactly what a detach looks like."""
    for key in [k for k, alias in _ALIASES.items() if alias.pane_id == pane_id]:
        _ALIASES.pop(key, None)


def unregister(pane_id: str, owner: Any = None) -> bool:
    """Forget a pane. With ``owner`` given, the entry is kept when another window
    has since claimed the same pane id — which is what a detach does: the child
    window registers the pane before the parent gets around to unregistering it.
    Returns whether the entry was removed."""
    if owner is not None and pane_id in _OWNERS and _OWNERS[pane_id] is not owner:
        return False
    if _PANES.pop(pane_id, None) is not None:
        _remember_forgotten(pane_id)
    _OWNERS.pop(pane_id, None)
    _forget_aliases_to(pane_id)
    _notify_pane("unregister", pane_id)
    return True


def drop_owner(owner: Any) -> list[str]:
    """Flag every pane mirrored by a disconnecting window as offline.

    A dropped WS connection is usually transient — the window reconnects with a
    backoff capped at 30s and re-registers everything — while the panes it
    mirrored keep running the whole time. Deleting the entries here made a
    caller hear "unknown target", i.e. "that pane does not exist", for a pane
    that was merely unreachable. So the entries survive, marked with the moment
    the window went away, and are removed only once OFFLINE_GRACE_S has passed
    without it coming back (see purge_expired).

    The owner mapping is cleared: this connection can never claim the pane
    again, and leaving it in place would make unregister's owner check reject a
    later window's cleanup. Returns the pane ids taken offline.
    """
    now = time.monotonic()
    affected = [pane_id for pane_id, own in _OWNERS.items() if own is owner]
    for pane_id in affected:
        _OWNERS.pop(pane_id, None)
        entry = _PANES.get(pane_id)
        if entry is not None and entry.offline_since is None:
            entry.offline_since = now
    return affected


def purge_expired() -> list[str]:
    """Forget offline panes whose grace period has run out.

    Called from every read path rather than from a timer: the registry is only
    ever consulted synchronously, so a lazy sweep is enough and there is no
    background task to keep alive. Returns the pane ids removed.
    """
    now = time.monotonic()
    expired = [
        pane_id
        for pane_id, entry in _PANES.items()
        if entry.offline_since is not None and now - entry.offline_since >= OFFLINE_GRACE_S
    ]
    for pane_id in expired:
        _PANES.pop(pane_id, None)
        _remember_forgotten(pane_id)
        _OWNERS.pop(pane_id, None)
        _forget_aliases_to(pane_id)
        _notify_pane("unregister", pane_id)
    return expired


def get(pane_id: str) -> RegisteredPane | None:
    purge_expired()
    return _PANES.get(pane_id)


def owner(pane_id: str) -> Any | None:
    """The WS connection of the window mirroring this pane, or None.

    Delivery normally reaches a window by broadcast, but a request that has to
    be answered inside a hook's timeout cannot afford to ask every window and
    wait for the right one to speak up — see `hook_drain`.
    """
    return _OWNERS.get(pane_id)


def set_busy(pane_id: str, busy: bool, display_status: str | None = None) -> bool:
    """Record what a pane is doing. Returns whether anything changed.

    Both facts arrive together because the window derives them in one tick from
    one screen read; sending them as two calls would let the registry hold a
    `busy` from this second and a status word from the last one, and the pair
    disagreeing is exactly the bug this field exists to fix.

    ``display_status=None`` means "not reported" — an older window that only
    knows about ``busy`` — and leaves any previous word alone rather than
    blanking it.
    """
    entry = _PANES.get(pane_id)
    if entry is None:
        return False
    changed = False
    if entry.busy != busy:
        entry.busy = busy
        changed = True
    if display_status is not None and entry.display_status != display_status:
        entry.display_status = display_status
        changed = True
    if changed:
        _notify_pane("status", pane_id)
    return changed


def list_panes(workspace_path: str | None = None) -> list[RegisteredPane]:
    """Every mirrored pane, or only those in one workspace. Sorted for stable
    autocomplete ordering. Includes panes whose window is offline — they carry
    the flag, so a caller can see them without being told they are gone."""
    purge_expired()
    entries = list(_PANES.values())
    if workspace_path is not None:
        target = _normalize_workspace(workspace_path)
        entries = [e for e in entries if e.workspace_path == target]
    return sorted(entries, key=lambda e: (e.workspace_label, e.name))


def workspaces() -> list[str]:
    return sorted({e.workspace_path for e in _PANES.values()})


def _match_workspaces(ws_part: str) -> list[str]:
    """Workspaces addressable as `ws_part`: exact path, folder basename, or a
    trailing path segment run (`parent/proj`)."""
    want = _normalize_workspace(ws_part)
    if not want:
        return []
    exact = [ws for ws in workspaces() if ws == want]
    if exact:
        return exact
    matched: list[str] = []
    for ws in workspaces():
        label = os.path.basename(ws) or ws
        if label == want or ws.endswith("/" + want):
            matched.append(ws)
    return matched


def is_local_device(device: str) -> bool:
    """Whether a device segment names this machine — in *any* account.

    Ids became per-account, so there is more than one right answer. This
    compared against the legacy machine-wide id alone, which is correct on an
    upgraded machine (the first account inherits that id) and wrong on a fresh
    install, where the legacy id is minted lazily by something else entirely and
    is nobody's node. A message addressed to this machine's own node id was then
    judged remote: delivery failed with "not paired", and a message that never
    had to leave the machine went to the relay on the way to failing.
    """
    return bool(device) and device in device_identity.local_ids()


def _split_device_segment(target: str) -> tuple[str, str]:
    """Split a leading device segment off a target, or return no device.

    Only a UUID-shaped first segment of a three-or-more segment address counts
    (see _DEVICE_SEGMENT_RE): `parent/proj/pane` has to keep meaning the pane
    `pane` in the workspace `parent/proj`, which it did before devices existed.
    """
    head, sep, rest = target.partition("/")
    if not sep or "/" not in rest or not _DEVICE_SEGMENT_RE.match(head):
        return "", target
    return head, rest


def parse_target(to: str) -> Address:
    """Split a `to:` string into its addressing parts.

    `<device>/<workspace>/<pane>` fills all three, `<workspace>/<pane>` leaves
    the device empty, and a bare `<pane>` leaves the workspace empty too — the
    pane name is always the trailing segment, so a workspace part may contain
    slashes while a pane name may not.
    """
    device, rest = _split_device_segment((to or "").strip())
    workspace, _, pane_name = rest.rpartition("/")
    return Address(pane_name=pane_name.strip(), workspace=workspace, device_id=device)


@dataclass
class RemoteTarget:
    """What a second, roster-aware reading of a `to:` string produced.

    All three fields empty means "this names no remote device" — the ordinary
    answer, and the only one a machine with no server configured ever gets.
    """

    address: Address | None = None
    error: str | None = None
    code: str | None = None
    params: dict[str, str] | None = None


def parse_remote_target(to: str) -> RemoteTarget:
    """Re-read a target as `<device>/<workspace>/<pane>` against the remote roster.

    **Local addressing wins, always.** This is only ever consulted after the
    local resolver has already failed on the same string, which is what keeps a
    device name from silently stealing an address that works today: `two/proj/
    target` means the pane `target` in the workspace `two/proj` whether or not
    some machine in the team space is called `two`, because the workspace
    reading is tried first and, when it succeeds, this function is never called.
    The reverse order — device names first — would move a working address to
    another machine the moment a colleague named a laptop after a folder, and
    the sender would have no way to notice.

    So a name can only ever *add* reachability where the answer used to be an
    error. Three or more segments are required, matching the rule for id-shaped
    device segments: a two-segment `folder/pane` stays a workspace address.

    A label naming more than one device is refused rather than guessed —
    delivering an instruction to the wrong machine is not something the sender
    can undo after reading about it.
    """
    device_part, sep, rest = (to or "").strip().partition("/")
    if not sep or "/" not in rest:
        return RemoteTarget()
    matches = remote_roster.devices_named(device_part)
    if not matches:
        return RemoteTarget()
    if len(matches) > 1:
        return RemoteTarget(
            error=f'ambiguous device "{device_part}" ({len(matches)} devices answer '
            f"to that name) — use the device id shown by cli_list_targets",
            code="ambiguous-device",
            params={"device": device_part, "n": str(len(matches))},
        )
    workspace, _, pane_name = rest.rpartition("/")
    return RemoteTarget(
        address=Address(
            pane_name=pane_name.strip(), workspace=workspace, device_id=matches[0]
        )
    )


def _prefer_online(hits: list[RegisteredPane]) -> list[RegisteredPane]:
    """A connected pane always wins over an offline one at the same address, so
    the entry a dropped connection left behind cannot shadow — or be mistaken as
    ambiguous with — a pane that is live under that name right now."""
    online = [e for e in hits if not e.offline]
    return online or hits


def _accept(entry: RegisteredPane, to: str, *, cross_workspace: bool = False) -> ResolveResult:
    """Turn a matched pane into a result, refusing it while its window is away.

    Reported separately from "unknown target" because the two demand opposite
    responses: an unknown target means the address is wrong, an offline one
    means the address is right and the answer is to wait or retry.
    """
    if entry.offline_since is None:
        if entry.is_dock and not entry.deliverable:
            # The main window's delivery looks the target up in its own pane
            # pool, which a dock is not part of; only a panel whose own window
            # delivers into it (registered as deliverable) can take a message.
            # Accepting any other would park the message forever, so it is
            # refused while the address is still on screen.
            return _resolve_error(
                "target-is-dock",
                f'target "{to}" is an embedded AI panel ({entry.surface}) — it can '
                f"use Navide's tools but cannot receive messages yet; send to a "
                f"window pane instead",
                to=to,
                surface=entry.surface,
            )
        return ResolveResult(pane=entry, cross_workspace=cross_workspace)
    seconds = entry.offline_seconds()
    return _resolve_error(
        "target-offline",
        f'target "{to}" is offline — the Navide window that owns it disconnected '
        f"{seconds}s ago and may be reconnecting. The pane itself still exists, so "
        f"retry instead of reopening it; it is forgotten only after "
        f"{OFFLINE_GRACE_S:.0f}s offline",
        to=to,
        seconds=seconds,
    )


def resolve(from_pane_id: str, to: str) -> ResolveResult:
    """Resolve a `to:` target as seen from the sending pane.

    A bare `name` only ever looks inside the sender's own workspace — the
    existing single-workspace behaviour. A `folder/name` target selects the
    workspace first; an unknown or ambiguous folder is an error rather than a
    silent fallback, so a typo can never inject into the wrong project. A
    `device/folder/name` target aimed at this machine resolves exactly like the
    `folder/name` it wraps; aimed anywhere else it cannot be resolved here.
    """
    target = (to or "").strip()
    if not target:
        return _resolve_error("empty-target", "empty target")

    device, rest = _split_device_segment(target)
    if device:
        if not is_local_device(device):
            return _unknown_device(device, target)
        target = rest

    purge_expired()
    sender = _PANES.get(from_pane_id)

    if "/" not in target:
        if sender is None:
            return _resolve_error("unknown-target", f'unknown target "{target}"', to=target)
        local = [
            entry
            for entry in _PANES.values()
            if entry.workspace_path == sender.workspace_path and entry.name == target
        ]
        if local:
            # Same refusal the qualified branch makes below, for the same
            # reason: a name matching two panes names neither of them, and
            # picking whichever registered first would inject into an
            # arbitrary one silently. Applied after _prefer_online so a
            # not-yet-expired offline duplicate cannot manufacture an
            # ambiguity that no live pane is part of.
            picks = _prefer_online(local)
            if len(picks) > 1:
                return _resolve_error(
                    "ambiguous-target",
                    f'ambiguous target "{target}" in workspace '
                    f'"{sender.workspace_label}" ({len(picks)} panes share that '
                    f"name) — pass pane_id instead of a name to say which one, "
                    f"or rename one of them",
                    # ws is synthesized from the sender: a bare name never
                    # spelled a workspace, but the UI string needs one.
                    name=target,
                    ws=sender.workspace_label,
                    n=len(picks),
                )
            return _accept(picks[0], target)
        return _resolve_error("unknown-target", f'unknown target "{target}"', to=target)

    # From here on the target is workspace-qualified.

    ws_part, _, name = target.rpartition("/")
    name = name.strip()
    if not name:
        return _resolve_error(
            "missing-pane-name", f'missing pane name in "{target}"', to=target
        )

    candidates = _match_workspaces(ws_part)
    if not candidates:
        return _resolve_error(
            "unknown-workspace", f'unknown workspace "{ws_part}"', ws=ws_part
        )
    if len(candidates) > 1:
        return _resolve_error(
            "ambiguous-workspace",
            f'ambiguous workspace "{ws_part}" ({len(candidates)} matches) '
            f"— use the full path",
            ws=ws_part,
            n=len(candidates),
        )

    workspace = candidates[0]
    # Two windows can hold the same workspace path (a detached run group), and
    # each derives handles from its own local registry — so the same name can
    # legitimately appear twice. Refuse to pick one rather than injecting an
    # instruction into whichever pane happened to register first.
    hits = _prefer_online(
        [e for e in _PANES.values() if e.workspace_path == workspace and e.name == name]
    )
    if not hits:
        return _resolve_error(
            "unknown-target-in-workspace",
            f'unknown target "{name}" in workspace "{ws_part}"',
            name=name,
            ws=ws_part,
        )
    if len(hits) > 1:
        return _resolve_error(
            "ambiguous-target",
            f'ambiguous target "{name}" in workspace "{ws_part}" '
            f"({len(hits)} panes share that name) — pass pane_id instead of a "
            f"name to say which one, or rename one of them",
            name=name,
            ws=ws_part,
            n=len(hits),
        )
    entry = hits[0]
    cross = sender is None or sender.workspace_path != entry.workspace_path
    return _accept(entry, target, cross_workspace=cross)


def resolve_pane_id(from_pane_id: str, pane_id: str) -> ResolveResult:
    """Resolve a pane by its id rather than by its address.

    The one thing a name cannot do: name a pane when two of them share a name.
    Two panes in one workspace are legitimately allowed to be called the same
    thing, and `resolve` refuses them both rather than guessing — an id is how
    a caller says which. It is resolved through the alias table, so an id a CLI
    was handed before a window reload or a detach — which rebuild a pane around
    the same running CLI — still names it. An id does not survive a pane rebuilt
    around a fresh CLI: that path declares no former ids, so nothing links them.

    An id names a pane on this machine only: a remote pane is not in the
    registry, and its id was minted by a registry this one has never seen.
    """
    ident = (pane_id or "").strip()
    if not ident:
        return _resolve_error("empty-target", "empty pane_id")
    entry = current(ident)
    if entry is None:
        return _resolve_error(
            "unknown-pane-id",
            f'unknown pane_id "{ident}" — it names no pane on this machine. '
            f"Pane ids change when a pane is rebuilt; read a fresh one from "
            f"cli_list_targets",
            pane_id=ident,
        )
    sender = _PANES.get(from_pane_id)
    cross = sender is None or sender.workspace_path != entry.workspace_path
    return _accept(entry, entry.qualified_name, cross_workspace=cross)


def _hint_matches(
    entry: RegisteredPane, address: Address, sender: RegisteredPane | None
) -> bool:
    """Whether a cached pane id still sits at the address that produced it."""
    if entry.name != address.pane_name:
        return False
    if not address.workspace:
        # A bare name never leaves the sender's workspace, hint or not.
        return sender is not None and entry.workspace_path == sender.workspace_path
    return entry.workspace_path in _match_workspaces(address.workspace)


def resolve_address(from_pane_id: str, address: Address) -> ResolveResult:
    """Resolve a structured target, treating `pane_id` as a hint only.

    The hint is the fast path: when it still names a pane sitting at the same
    (workspace, pane name), that pane is the answer without a scan. Otherwise
    the address is resolved from the stable parts instead, because a detach or
    a reattach mints a new pane id and a sender's cached hint goes stale — the
    caller reads the current id back off `result.pane.pane_id` and updates its
    cache. A hint pointing at a different pane is never followed.
    """
    if address.device_id and not is_local_device(address.device_id):
        return _unknown_device(address.device_id, address.to_string())

    if address.pane_id and address.pane_name:
        purge_expired()
        entry = _PANES.get(address.pane_id)
        sender = _PANES.get(from_pane_id)
        if entry is not None and _hint_matches(entry, address, sender):
            cross = sender is None or sender.workspace_path != entry.workspace_path
            return _accept(entry, address.local_target, cross_workspace=cross)

    return resolve(from_pane_id, address.local_target)


def sender_display(from_pane_id: str, fallback: str) -> str:
    """How the sender should be shown to a cross-workspace recipient: always
    `<folder>/<pane>` so a reply can address it back."""
    sender = _PANES.get(from_pane_id)
    return sender.qualified_name if sender else fallback


def readable_sender(pane_id: str, fallback: str = "") -> str:
    """A name a person can read for a sending pane: its qualified name while it
    is registered (under this id or a former one), else ``fallback``, and the
    raw id only when nothing better is known."""
    sender = current(pane_id)
    return sender.qualified_name if sender else (fallback or pane_id)


def _reset_for_test() -> None:
    _PANES.clear()
    _OWNERS.clear()
    _ALIASES.clear()
    _FORGOTTEN.clear()
