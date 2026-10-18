"""A second message signature that covers the send time (plan 797ad7, B4).

The v1 signature covers no time, so a message the relay held back could be
replayed once the receiver's one-hour ledger had forgotten it. v2 travels as
`sig2` beside the unchanged `sig` — 0.2.19 receivers verify `sig` with strict
base64 and would refuse anything else there — and Navide-Server forwards it.

Receiving: no sig2 is exactly the v1 path; a sig2 is checked against the pinned
key and its send time against a window inside the ledger's TTL; the first one
that verifies marks the pin. In 0.2.20 a marked device's message without a sig2
was still taken (Q4) and left a log line and one notice; from 0.2.23
REFUSE_V1_FROM_V2_PEERS is on and a marked device's message without a usable
sig2 is refused. A device never marked is decided on v1 as before.
"""

from __future__ import annotations

import base64
import logging
import time

import pytest

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

#: How long a test waits for the pushed message to reach an outcome, delivered
#: or acked. The wait asserts nothing about time: whichever outcome comes first
#: is what the test then checks. Not `_until`'s 3s: before either outcome the
#: receive path reads and writes the trust record several times (the seen
#: ledger, the pin, a notice), and on Windows that record goes through DPAPI,
#: the latency #171 widened the connect wait for. Run 38257798883 failed here
#: twice with the right delivery already in `broadcasts` by the time pytest
#: reported it — late, not wrong.
RECEIVE_TIMEOUT_S = 20.0


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
        await _until(lambda: bool(broadcasts) or bool(conn.acks), timeout=RECEIVE_TIMEOUT_S)
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


async def _two(first: dict, second: dict, broadcasts) -> tuple[list, list]:
    """One message, then another on the same link."""
    from agent_team_backend import agent_messaging

    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server = FakeServer()
    link = await _connected(server)
    try:
        conn = server.opened[0]
        for payload in (first, second):
            seen = len(broadcasts) + len(conn.acks)
            await conn.push({"type": "messages.pending", "payload": payload})
            await _until(lambda: len(broadcasts) + len(conn.acks) > seen, timeout=RECEIVE_TIMEOUT_S)
        return list(broadcasts), list(conn.acks)
    finally:
        await link.stop()


def _sig2_missing_notices() -> list:
    return [n for n in trust_store.notices()
            if n["kind"] == trust_store.NOTICE_PAIRING and n.get("pairing") == "sig2-missing"]


async def test_a_server_rolled_back_to_one_without_sig2_cuts_no_device_off(broadcasts, monkeypatch):
    """With the switch off: after a v2 message marked the pin, the server goes
    back to a release that drops sig2: the next message arrives with v1 only,
    and is delivered."""
    monkeypatch.setattr(server_link, "REFUSE_V1_FROM_V2_PEERS", False)
    delivered, acks = await _two(_pending_v2("pa:mcp:before"), _pending("pa:mcp:after"), broadcasts)
    assert trust_store.pin_for(PEER.device_id).get("sigV2") is True
    assert [d["payload"]["msg_key"] for d in delivered] == ["pa:mcp:before", "pa:mcp:after"]
    assert acks == []
    assert [n["deviceId"] for n in _sig2_missing_notices()] == [PEER.device_id]


async def test_with_the_switch_off_a_relay_stripping_sig2_does_not_stop_delivery(broadcasts, monkeypatch):
    monkeypatch.setattr(server_link, "REFUSE_V1_FROM_V2_PEERS", False)
    trust_store.note_signs_v2(PEER.device_id)
    stripped = _pending_v2("pa:mcp:stripped")
    stripped.pop("sig2")
    delivered, acks = await _receive(stripped, broadcasts)
    assert [d["payload"]["msg_key"] for d in delivered] == ["pa:mcp:stripped"]
    assert acks == []
    assert len(_sig2_missing_notices()) == 1


async def test_one_notice_per_device_not_one_per_message(broadcasts, monkeypatch, caplog):
    """A downgrade is noticed once per device, but every one of them is logged
    and counted, so a device that keeps arriving without sig2 can be seen."""
    monkeypatch.setattr(server_link, "REFUSE_V1_FROM_V2_PEERS", False)
    trust_store.note_signs_v2(PEER.device_id)
    with caplog.at_level(logging.WARNING, logger=trust_store.log.name):
        delivered, _acks = await _two(_pending("pa:mcp:one"), _pending("pa:mcp:two"), broadcasts)
    assert [d["payload"]["msg_key"] for d in delivered] == ["pa:mcp:one", "pa:mcp:two"]
    assert len(_sig2_missing_notices()) == 1
    assert trust_store.sig2_downgrade_count(PEER.device_id, "sig2-missing") == 2
    counted = [r for r in caplog.records
               if "v2 signature" in r.getMessage() and PEER.device_id in r.getMessage()
               and r.name == trust_store.log.name]
    assert [r.getMessage().rsplit("#", 1)[-1] for r in counted] == ["1)", "2)"]


async def test_an_unusable_sig2_is_counted_every_time_and_noticed_once(broadcasts):
    """A device never marked whose clock is off: every message is delivered on
    v1, each is counted, one notice."""
    await _two(_stale_v2("pa:mcp:u1"), _stale_v2("pa:mcp:u2"), broadcasts)
    assert len(_sig2_unusable_notices()) == 1
    assert trust_store.sig2_downgrade_count(PEER.device_id, "sig2-unusable") == 2


def test_the_refusal_is_on():
    """0.2.23 (plan 797ad7, Q4): a marked device's v1-only message is refused."""
    assert server_link.REFUSE_V1_FROM_V2_PEERS is True


def _refused_notices(pairing: str) -> list:
    return [n for n in trust_store.notices()
            if n["kind"] == trust_store.NOTICE_PAIRING and n.get("pairing") == pairing]


async def test_a_marked_device_with_a_verifying_sig2_is_delivered(broadcasts):
    trust_store.note_signs_v2(PEER.device_id)
    delivered, acks = await _receive(_pending_v2("pa:mcp:marked-ok"), broadcasts)
    assert [d["payload"]["msg_key"] for d in delivered] == ["pa:mcp:marked-ok"]
    assert acks == []
    assert not any(str(n.get("pairing", "")).startswith("sig2-") for n in trust_store.notices())


async def test_a_marked_device_with_sig2_stripped_is_refused(broadcasts):
    trust_store.note_signs_v2(PEER.device_id)
    delivered, acks = await _receive(_pending("pa:mcp:stripped"), broadcasts)
    assert delivered == []
    assert acks and acks[0]["state"] == "rejected"
    assert acks[0]["reason"] == server_link.REASON_UNAUTHENTICATED
    assert [n["deviceId"] for n in _refused_notices("sig2-refused-missing")] == [PEER.device_id]
    assert _sig2_missing_notices() == []  # that one says "delivered"
    assert trust_store.sig2_downgrade_count(PEER.device_id, "sig2-refused-missing") == 1


@pytest.mark.parametrize(
    ("make", "direction", "minutes"),
    [
        (lambda k: _pending_v2(k, sent_at=int(time.time()) - 70 * 60), "behind", 70),
        (lambda k: _pending_v2(k, sent_at=int(time.time()) + 12 * 60), "ahead", 12),
    ],
    ids=["behind", "ahead"],
)
async def test_a_marked_device_outside_the_window_is_refused_for_clock_skew(
    make, direction, minutes, broadcasts, caplog
):
    trust_store.note_signs_v2(PEER.device_id)
    with caplog.at_level(logging.WARNING, logger=server_link.log.name):
        delivered, acks = await _receive(make("pa:mcp:skewed"), broadcasts)
    assert delivered == []
    assert acks and acks[0]["state"] == "rejected"
    reason = f"clock skew: sender is {minutes} minutes {direction}"
    assert any("refusing message pa:mcp:skewed" in r.getMessage() and reason in r.getMessage()
               for r in caplog.records)
    [notice] = _refused_notices(f"sig2-refused-clock-{direction}")
    assert notice["deviceId"] == PEER.device_id
    assert notice["minutes"] == minutes
    assert _sig2_unusable_notices() == []


async def test_a_marked_device_with_a_forged_sig2_is_refused_as_unusable(broadcasts):
    trust_store.note_signs_v2(PEER.device_id)
    delivered, acks = await _receive(_forged_v2("pa:mcp:forged"), broadcasts)
    assert delivered == [] and acks and acks[0]["state"] == "rejected"
    assert [n["deviceId"] for n in _refused_notices("sig2-refused-unusable")] == [PEER.device_id]


def _sig2_unusable_notices() -> list:
    return [n for n in trust_store.notices()
            if n["kind"] == trust_store.NOTICE_PAIRING and n.get("pairing") == "sig2-unusable"]


def _stale_v2(msg_key: str) -> dict:
    return _pending_v2(msg_key, sent_at=int(time.time()) - server_link.SIG2_MAX_AGE_S - 30)


def _ahead_v2(msg_key: str) -> dict:
    return _pending_v2(msg_key, sent_at=int(time.time()) + server_link.SIG2_MAX_AHEAD_S + 30)


def _forged_v2(msg_key: str) -> dict:
    payload = _pending_v2(msg_key)
    head, sent_at, signature = payload["sig2"].split(".", 2)
    payload["sig2"] = f"{head}.{int(sent_at) - 1}.{signature}"  # another time, same signature
    return payload


@pytest.mark.parametrize("make", [_stale_v2, _ahead_v2, _forged_v2], ids=["behind", "ahead", "forged"])
async def test_a_sig2_that_cannot_be_used_falls_back_to_v1(make, broadcasts):
    """Review B4-1: a device whose clock is off sends every message outside the
    window, and refusing them cut it off where main delivers. With the switch
    off, a sig2 that does not verify or is outside the window is treated as no
    sig2 at all: v1 decides, the message is delivered, a notice says why, and
    the pin is not marked."""
    delivered, acks = await _receive(make("pa:mcp:unusable"), broadcasts)
    assert [d["payload"]["msg_key"] for d in delivered] == ["pa:mcp:unusable"]
    assert acks == []
    assert [n["deviceId"] for n in _sig2_unusable_notices()] == [PEER.device_id]
    assert not trust_store.pin_for(PEER.device_id).get("sigV2")


async def test_an_unusable_sig2_with_a_v1_that_does_not_verify_is_still_refused(broadcasts):
    payload = _stale_v2("pa:mcp:both-bad")
    payload["sig"] = payload["sig"][:-4] + "AAA="
    delivered, acks = await _receive(payload, broadcasts)
    assert delivered == [] and acks and acks[0]["state"] == "rejected"
    # Review L1: the notice says "delivered on v1"; a refused message must
    # not leave it, nor use up the device's one notice.
    assert _sig2_unusable_notices() == []


@pytest.mark.parametrize("make", [_stale_v2, _ahead_v2, _forged_v2], ids=["behind", "ahead", "forged"])
async def test_with_the_switch_on_an_unusable_sig2_from_a_marked_device_is_refused(make, broadcasts):
    trust_store.note_signs_v2(PEER.device_id)
    delivered, acks = await _receive(make("pa:mcp:unusable"), broadcasts)
    assert delivered == [] and acks and acks[0]["state"] == "rejected"


async def test_a_device_never_marked_sending_v1_only_is_still_delivered(broadcasts):
    """Old peers: the switch only reaches a device that has proven it signs v2."""
    assert server_link.REFUSE_V1_FROM_V2_PEERS is True
    delivered, acks = await _two(_pending("pa:mcp:old-1"), _pending("pa:mcp:old-2"), broadcasts)
    assert [d["payload"]["msg_key"] for d in delivered] == ["pa:mcp:old-1", "pa:mcp:old-2"]
    assert acks == []
    assert not trust_store.pin_for(PEER.device_id).get("sigV2")
    assert not any(str(n.get("pairing", "")).startswith("sig2-") for n in trust_store.notices())


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


@pytest.mark.parametrize("strip", [True, False], ids=["no-sig2", "forged-sig2"])
async def test_a_refusal_the_device_did_not_sign_leaves_no_notice(strip, broadcasts):
    """A relay can strip or forge sig2 at will; only a refusal whose v1 still
    verifies — the device really sent it — is noticed and counted."""
    trust_store.note_signs_v2(PEER.device_id)
    payload = _forged_v2("pa:mcp:relay")
    if strip:
        payload.pop("sig2")
    payload["sig"] = payload["sig"][:-4] + "AAA="
    delivered, acks = await _receive(payload, broadcasts)
    assert delivered == [] and acks and acks[0]["state"] == "rejected"
    assert not any(str(n.get("pairing", "")).startswith("sig2-") for n in trust_store.notices())
