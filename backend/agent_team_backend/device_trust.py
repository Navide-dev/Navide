"""Which trust ring a remote device sits in, and who knocked and was refused.

``pane_policy`` answers one question well: does this receiver's rule set let
that sender drive that pane. It is allow-only on purpose — with no deny rules
there is no precedence to argue about — and that design is worth keeping. But
it leaves two things unsaid, and both of them are structure rather than rules:

*Which ring is the sender in.* Signing one account in on a second machine is
itself the grant, exactly as joining a tailnet is, so your own devices never
consult the rules at all. Until now that lived as one ``==`` in the middle of
the delivery path, which is a poor place for a trust boundary: nothing named
it, nothing tested it as a concept, and the next person to touch that function
had no reason to know it was load-bearing. Naming it also made it possible to
notice what it was comparing — two strings the server had written — which is
why ``own_device`` now arrives as a verdict rather than as an identity to test.

*How to refuse a device outright.* An allow-only rule set cannot say "not this
one, ever". You can decline to grant, but you cannot revoke reach from a
machine that some broader rule already covers — and the case that needs it is
the sharp one: a laptop of your own that walked off. That is why ``blocked`` is
checked **before** the own-device shortcut. Blocking cannot lock you out of the
machine you are sitting at: the local device is never a remote sender.

The third gap is not authorization but *observation*. A denied message today
fails silently — the sender is told, and the person whose machine refused it is
told nothing. RustDesk's model is built the other way round: the refusing side
is the side that sees the request and decides. ``AccessRequests`` below is that
surface. It is deliberately not a second authorization system: approving a
request writes an ordinary ``pane_policy`` allow rule, so there stays exactly
one place where "may this sender drive this pane" is answered.

Storage: both the block list and the rules live in the same receiver-authored
policy document, which the server stores verbatim and never interprets. The
document stays at ``version: 1`` — a bump would make every older build
fail-closed and lock its owner out of their own network. ``blocked`` is an
optional field an older build ignores, so an un-upgraded machine keeps exactly
today's behaviour and a new one is strictly stricter. That direction is the
only safe one for a field that takes reach away.
"""

from __future__ import annotations

import logging
import time
from typing import Any

log = logging.getLogger(__name__)

#: Your own machine: same member, so no rule stands between them.
RING_SELF = "self"
#: Explicitly refused, ahead of every other consideration.
RING_BLOCKED = "blocked"
#: Someone you invited into this network. ``pane_policy`` decides the rest.
RING_MEMBER = "member"

#: Bounds on the knock ledger. Same shape and reasoning as the inbound-message
#: bookkeeping in ``server_link``: nothing here outlives the process, and an
#: unbounded map fed by a remote peer is a leak with a sender attached to it.
REQUESTS_MAX = 100
REQUESTS_TTL_S = 86400.0


def ring(
    policy: Any,
    *,
    member_id: str,
    device_id: str,
    own_device: bool,
) -> str:
    """Which ring the sender is in. Never raises; unreadable input is a member.

    Treating garbage as ``RING_MEMBER`` is the safe default because that ring
    grants nothing by itself — it hands the decision to ``pane_policy``, which
    denies by default. The two rings that *do* decide something (self grants,
    blocked refuses) are only ever reached from data this machine can vouch
    for: the block list was authored here, and ``own_device`` is settled before
    the call by evidence this machine holds.

    ``own_device`` used to be ``member_id == own_member_id``, with both sides of
    that comparison supplied by the server — the ``from`` field of the pushed
    message and the answer to ``auth.hello``. A relay that filled in the same
    string twice therefore landed in ``RING_SELF``, which skips the policy
    entirely; it did not need a key, a member, or an invitation, only the two
    fields it was already writing. The caller now settles the question from a
    signature it verified against a key *it* pinned, and passes the verdict in.
    Which is why this is a bool and not two ids: there is nothing left here to
    compare, and an identity comparison is exactly the shape that invited the
    server's answer to stand in for our own.
    """
    if is_blocked(policy, member_id=member_id, device_id=device_id):
        return RING_BLOCKED
    if own_device:
        return RING_SELF
    return RING_MEMBER


def is_blocked(policy: Any, *, member_id: str, device_id: str) -> bool:
    """Whether the block list names this sender.

    A device id alone is enough — that is the identity a stolen machine keeps
    and the one a user recognises in the network view. An entry may also name a
    member, which blocks every device that member signs in with; the two are
    read as alternatives, not as a pair to match together, because an entry
    that had to match both would silently stop working the moment the blocked
    person used a different machine.
    """
    for entry in _entries(policy, "blocked"):
        if _usable(entry.get("deviceId")) and entry["deviceId"] == device_id:
            return True
        if _usable(entry.get("memberId")) and entry["memberId"] == member_id:
            return True
    # And this machine's own copy, which is the half that survives the policy
    # being unreadable. ``_entries`` returns nothing for a policy of None — the
    # state a refused signature leaves behind — and reading that as "nothing is
    # blocked" made a failed verification into a way to lift every block: the
    # devices came back onto the "waiting for you to vouch" card and the
    # delivery path stopped refusing them. Breaking the signature is much
    # cheaper for a server than forging one without the block in it, so the
    # decision has to be recorded somewhere the server cannot reach.
    #
    # Imported here rather than at module scope: this module is the rule, and
    # the store is where one of its inputs happens to live.
    from agent_team_backend import trust_store

    return trust_store.is_blocked_locally(device_id=device_id, member_id=member_id)


def blocked_entries(policy: Any) -> list[dict[str, Any]]:
    """The block list as the editor should show it. Malformed rows are dropped
    rather than surfaced: the list is remote-authored JSON like the rules are,
    and a row this build cannot read is a row it is not enforcing either."""
    out: list[dict[str, Any]] = []
    for entry in _entries(policy, "blocked"):
        device_id = entry.get("deviceId") if _usable(entry.get("deviceId")) else ""
        member_id = entry.get("memberId") if _usable(entry.get("memberId")) else ""
        if not device_id and not member_id:
            continue
        out.append(
            {
                "deviceId": device_id,
                "memberId": member_id,
                "deviceName": entry.get("deviceName") if _usable(entry.get("deviceName")) else "",
                "at": entry.get("at") if _usable(entry.get("at")) else "",
                "reason": entry.get("reason") if _usable(entry.get("reason")) else "",
            }
        )
    return out


def validate_blocked(policy: Any) -> str:
    """Why the block list must not be written, or ``""`` when it may be.

    The mirror of ``pane_policy.validate``, and for the same reason: what
    ``is_blocked`` reads was authored elsewhere and forgives everything, but
    what leaves this machine came from our own editor, and a row this build
    would later skip is a refusal the user believes they made.
    """
    if not isinstance(policy, dict):
        return "policy must be an object"
    blocked = policy.get("blocked")
    if blocked is None:
        return ""
    if not isinstance(blocked, list):
        return "policy blocked must be a list"
    for index, entry in enumerate(blocked):
        if not isinstance(entry, dict):
            return f"blocked {index} must be an object"
        if not _usable(entry.get("deviceId")) and not _usable(entry.get("memberId")):
            return f"blocked {index} needs a deviceId or a memberId"
    return ""


def _entries(policy: Any, field: str) -> list[dict[str, Any]]:
    if not isinstance(policy, dict):
        return []
    value = policy.get(field)
    if value is None:
        return []
    if not isinstance(value, list):
        log.warning("policy %s is %s, not a list — ignoring", field, type(value).__name__)
        return []
    return [entry for entry in value if isinstance(entry, dict)]


def _usable(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


class AccessRequests:
    """Who tried to reach this machine and was refused.

    One entry per (device, workspace, pane) — a sender retrying does not add
    rows, it refreshes the one it already has and counts the attempt. That
    keeps a loop on the other end from evicting the requests a person still
    needs to look at, which is the failure mode a plain append-only list has.

    Blocked senders are deliberately **not** recorded. The point of a block is
    that the machine stops being asked about that device; a block that still
    filled the user's screen would just be a noisier deny.
    """

    def __init__(self) -> None:
        self._rows: dict[str, dict[str, Any]] = {}

    def record(
        self,
        *,
        member_id: str,
        device_id: str,
        device_name: str,
        workspace: str,
        pane_name: str,
        grant_id: str = "",
    ) -> dict[str, Any]:
        """Note a refused attempt and return the row as it now stands.

        ``grant_id`` is the organisation grant the sender was paired through,
        kept so the knock is still known to come from one when the pin cannot
        be read later."""
        self._evict()
        key = f"{device_id}\n{workspace}\n{pane_name}"
        now = time.time()
        row = self._rows.get(key)
        if row is None:
            row = {
                "key": key,
                "memberId": member_id,
                "deviceId": device_id,
                "deviceName": device_name,
                "workspace": workspace,
                "paneName": pane_name,
                "firstSeenAt": now,
                "attempts": 0,
            }
            self._rows[key] = row
        # A rename between attempts should show the name the device answers to
        # now, not the one it had the first time it knocked.
        if device_name:
            row["deviceName"] = device_name
        # Overwritten every time, cleared when absent: the row says how the
        # sender is paired *now*, never how it was paired some earlier time.
        if grant_id:
            row["grantId"] = grant_id
        else:
            row.pop("grantId", None)
        row["lastSeenAt"] = now
        row["attempts"] = int(row["attempts"]) + 1
        return dict(row)

    def list(self) -> list[dict[str, Any]]:
        """Newest knock first — the one a person is most likely acting on."""
        self._evict()
        return sorted(self._rows.values(), key=lambda r: r["lastSeenAt"], reverse=True)

    def forget(self, key: str) -> bool:
        """Drop one row once it has been acted on. False when it was already
        gone, which is what a second click on a stale list looks like."""
        return self._rows.pop(key, None) is not None

    def forget_device(self, device_id: str) -> int:
        """Drop every row for one device — what approving or blocking the whole
        device means for the requests it had outstanding."""
        keys = [k for k, r in self._rows.items() if r["deviceId"] == device_id]
        for key in keys:
            del self._rows[key]
        return len(keys)

    def clear(self) -> None:
        self._rows.clear()

    def _evict(self) -> None:
        now = time.time()
        for key, row in list(self._rows.items()):
            if now - row["lastSeenAt"] >= REQUESTS_TTL_S:
                del self._rows[key]
        # Insertion order is knock order, so the front is the oldest request.
        while len(self._rows) > REQUESTS_MAX:
            self._rows.pop(next(iter(self._rows)))
