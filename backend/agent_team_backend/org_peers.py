"""Cross-organisation peers: what ``peers.list`` says this device can reach.

The server answers ``peers.list`` with the live grants this device is on one
side of, each listing the devices on the *other* side. This module only reads
that reply into a bounded, well-typed shape; deciding what a grant means for a
pin lives in ``trust_store`` (the downgrade rules) and ``server_link`` (when
to apply them).

Everything here is the server's word. A peer's keys are only candidates for a
first pin — the six-digit pairing is what authenticates them — and a peer's
member id decides nothing about the own-device ring, which stays reserved for
this account's own machines.
"""

from __future__ import annotations

from typing import Any

#: The org view, before any answer has arrived on this connection.
STATUS_UNKNOWN = "unknown"
#: ``peers.list`` answered.
STATUS_OK = "ok"
#: The server does not offer ``peers.list`` (an older server), or says this
#: device is in no organisation. Shown as "not in an organisation"; nothing
#: else about the link changes.
STATUS_UNSUPPORTED = "unsupported"
#: It was asked and the answer did not come back usable this time.
STATUS_ERROR = "error"

#: Error codes that mean "there is nothing here", not "try again".
UNSUPPORTED_CODES = frozenset({"UNKNOWN_TYPE", "NOT_FOUND", "BAD_REQUEST"})

#: Bounds, because the reply is filled by other people's machines.
MAX_GRANTS = 50
MAX_PEERS_PER_GRANT = 200

#: Why a pin was downgraded. The first four arrive with ``org.grant.revoked``;
#: ``lapsed`` is this machine's own finding when ``peers.list`` no longer lists
#: the grant or the device (an expired grant, or a push missed while offline).
REASONS = frozenset(
    {"link-revoked", "member-removed", "exposure-withdrawn", "org-deleted", "lapsed"}
)
REASON_LAPSED = "lapsed"


def _text(value: Any, limit: int = 200) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _org(value: Any) -> dict[str, str]:
    data = value if isinstance(value, dict) else {}
    return {"orgId": _text(data.get("orgId")), "name": _text(data.get("name"))}


def _int(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def parse(payload: Any) -> list[dict[str, Any]]:
    """The grants in a ``peers.list`` reply, normalised.

    A grant without an id, or a peer without a device id, cannot be acted on
    and is dropped rather than guessed at.
    """
    data = payload if isinstance(payload, dict) else {}
    raw_grants = data.get("grants")
    grants: list[dict[str, Any]] = []
    for raw in raw_grants if isinstance(raw_grants, list) else []:
        if not isinstance(raw, dict):
            continue
        grant_id = _text(raw.get("grantId"))
        if not grant_id:
            continue
        peers: list[dict[str, Any]] = []
        raw_peers = raw.get("peers")
        for peer in raw_peers if isinstance(raw_peers, list) else []:
            if not isinstance(peer, dict):
                continue
            device_id = _text(peer.get("deviceId"))
            if not device_id:
                continue
            peers.append(
                {
                    "deviceId": device_id,
                    "deviceName": _text(peer.get("deviceName")),
                    "memberId": _text(peer.get("memberId")),
                    "ownerName": _text(peer.get("ownerName")),
                    "online": peer.get("online") is True,
                    "publicKey": _text(peer.get("publicKey"), 400),
                    "signPublicKey": _text(peer.get("signPublicKey"), 400),
                }
            )
            if len(peers) >= MAX_PEERS_PER_GRANT:
                break
        grants.append(
            {
                "grantId": grant_id,
                "version": _int(raw.get("version")),
                "expiresAt": _int(raw.get("expiresAt")),
                "localOrg": _org(raw.get("localOrg")),
                "peerOrg": _org(raw.get("peerOrg")),
                "peers": peers,
            }
        )
        if len(grants) >= MAX_GRANTS:
            break
    return grants


def find(grants: list[dict[str, Any]], device_id: str) -> tuple[dict, dict] | None:
    """The grant and peer row through which *device_id* is reachable, if any."""
    if not device_id:
        return None
    for grant in grants:
        for peer in grant["peers"]:
            if peer["deviceId"] == device_id:
                return grant, peer
    return None


def live_map(grants: list[dict[str, Any]]) -> dict[str, set[str]]:
    """grantId -> the peer device ids it currently lists."""
    return {grant["grantId"]: {p["deviceId"] for p in grant["peers"]} for grant in grants}


def pin_org(grant: dict[str, Any], peer: dict[str, Any]) -> dict[str, str]:
    """What a pin taken through *grant* records about where it came from."""
    return {
        "grantId": grant["grantId"],
        "orgId": grant["peerOrg"]["orgId"],
        "orgName": grant["peerOrg"]["name"],
        "ownerName": peer["ownerName"],
    }
