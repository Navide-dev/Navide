"""A second message signature that covers the send time (plan 797ad7, B4).

The v1 signature covers no time, so a message the relay held back could be
replayed once the receiver's one-hour ledger had forgotten it. v2 travels as
`sig2` beside the unchanged `sig` — 0.2.19 receivers verify `sig` with strict
base64 and would refuse anything else there — and Navide-Server forwards it.

Receiving: no sig2 is exactly the v1 path; a sig2 is checked against the pinned
key and its send time against a window inside the ledger's TTL; the first one
that verifies marks the pin, and from then on that device's messages without a
sig2 are refused. Until it has proven it sends v2, nothing is locked.
"""

from __future__ import annotations

import base64
import time

from agent_team_backend import device_identity, device_signing, server_link, trust_store

from .test_server_link import (  # noqa: F401 - fixtures
    PEER,
    FakeServer,
    _clean_registry,
    _confirmable,
    _connected,
    _fast_timers,
    _paired_peer,
    _pending,
    _until,
    broadcasts,
)


def _sig2(msg_key: str, *, kind: str, body: str, sent_at: int) -> str:
    payload = {**device_signing.message_payload(
        msg_key=msg_key, from_device=PEER.device_id, to_device=device_identity.device_id(),
        kind=kind, body=body,
    ), "sentAt": sent_at}
    raw = PEER._private.sign(
        device_signing._MESSAGE_CONTEXT_V2 + b"\x00" + device_signing._canonical(payload)
    )
    return f"v2.{sent_at}.{base64.b64encode(raw).decode('ascii')}"


def _pending_v2(msg_key: str, *, sent_at: int | None = None, keep_v1: bool = True) -> dict:
    payload = _pending(msg_key)
    payload["sig2"] = _sig2(msg_key, kind="text", body=payload["text"],
                            sent_at=int(time.time()) if sent_at is None else sent_at)
    if not keep_v1:
        payload.pop("sig")
    return payload


async def _receive(payload: dict, broadcasts) -> tuple[list, list]:
    from agent_team_backend import agent_messaging

    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push({"type": "messages.pending", "payload": payload})
        await _until(lambda: bool(broadcasts) or bool(conn.acks))
        return list(broadcasts), list(conn.acks)
    finally:
        await link.stop()


def test_the_window_sits_inside_the_ledger():
    """A message inside the window is still in the ledger, so the window plus
    the clock allowance must not outlast the ledger's TTL."""
    assert server_link.SIG2_MAX_AGE_S + server_link.SIG2_MAX_AHEAD_S <= trust_store.SEEN_MESSAGE_TTL_S


async def test_a_message_with_a_verifying_sig2_is_delivered_and_marks_the_pin(broadcasts):
    delivered, acks = await _receive(_pending_v2("pa:mcp:v2-1"), broadcasts)
    assert [d["payload"]["msg_key"] for d in delivered] == ["pa:mcp:v2-1"]
    assert acks == []
    assert trust_store.pin_for(PEER.device_id).get("sigV2") is True


async def test_a_message_without_sig2_is_the_v1_path_until_the_peer_proves_v2(broadcasts):
    delivered, _acks = await _receive(_pending("pa:mcp:v1-only"), broadcasts)
    assert [d["payload"]["msg_key"] for d in delivered] == ["pa:mcp:v1-only"]
    assert not trust_store.pin_for(PEER.device_id).get("sigV2")


async def test_once_a_peer_signs_v2_a_message_without_it_is_refused(broadcasts):
    trust_store.note_signs_v2(PEER.device_id)
    delivered, acks = await _receive(_pending("pa:mcp:stripped"), broadcasts)
    assert delivered == []
    assert acks and acks[0]["state"] == "rejected"
    assert acks[0]["reason"] == server_link.REASON_UNAUTHENTICATED


async def test_a_sig2_sent_too_long_ago_is_refused(broadcasts):
    old = int(time.time()) - server_link.SIG2_MAX_AGE_S - 30
    delivered, acks = await _receive(_pending_v2("pa:mcp:held", sent_at=old), broadcasts)
    assert delivered == [] and acks[0]["state"] == "rejected"
    assert not trust_store.pin_for(PEER.device_id).get("sigV2")


async def test_a_sig2_from_too_far_ahead_is_refused(broadcasts):
    ahead = int(time.time()) + server_link.SIG2_MAX_AHEAD_S + 30
    delivered, acks = await _receive(_pending_v2("pa:mcp:ahead", sent_at=ahead), broadcasts)
    assert delivered == [] and acks[0]["state"] == "rejected"


async def test_a_sig2_that_does_not_verify_is_refused_and_marks_nothing(broadcasts):
    payload = _pending_v2("pa:mcp:forged")
    head, sent_at, signature = payload["sig2"].split(".", 2)
    payload["sig2"] = f"{head}.{int(sent_at) - 1}.{signature}"  # another time, same signature
    delivered, acks = await _receive(payload, broadcasts)
    assert delivered == [] and acks[0]["state"] == "rejected"
    assert not trust_store.pin_for(PEER.device_id).get("sigV2")


async def test_an_outgoing_message_carries_v1_unchanged_and_a_v2_beside_it():
    server = FakeServer()
    link = await _connected(server)
    try:
        before = int(time.time())
        reply = await link.send_message(
            to={"deviceId": "dev-b", "workspace": "beta", "paneName": "builder"},
            sender={"workspace": "alpha", "paneName": "sender", "paneId": "pa"},
            text="ship it",
            msg_key="pa:mcp:out",
        )
        assert reply["ok"] is True
        sent = server.opened[0].sends[0]
        mine = device_signing.public_key()
        args = dict(msg_key="pa:mcp:out", from_device=device_identity.device_id(),
                    to_device="dev-b", kind="text", body="ship it")
        assert device_signing.verify_message(sent["sig"], public_key_b64=mine, **args)
        sent_at = device_signing.verify_message_v2(sent["sig2"], public_key_b64=mine, **args)
        assert sent_at is not None and before <= sent_at <= int(time.time())
    finally:
        await link.stop()
