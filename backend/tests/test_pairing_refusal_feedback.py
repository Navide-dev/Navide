"""A pairing that one side refused ends at once, and says why.

Reported on 0.2.19: the far machine answered, this machine refused the answer
because its own trust record could not be read, the log said "refusing message
pair-…" — and the screen kept saying "Waiting for TKM5 to answer" for five
minutes, after which pressing Pair again only said a pairing was already in
progress. The same silence followed every refusal at the *other* end, because
the ack that carried the reason back was read by nothing that knew it was a
pairing frame.

Nothing here changes what is refused or why. Trust, signatures and the
exchange's own rules decide exactly what they decided before; these tests pin
that the refusal now also ends the round it belongs to and leaves a reason
behind, and that the wire carries nothing it did not carry before.
"""

from __future__ import annotations

import pytest

from agent_team_backend import device_identity, device_pairing, trust_store

from .test_server_link import (  # noqa: F401 - broadcasts is a fixture
    ALLOW_ALL_POLICY,
    PEER,
    FakeServer,
    _connected,
    _until,
    broadcasts,
)


@pytest.fixture(autouse=True)
def _keychain_store(monkeypatch):
    monkeypatch.setattr(trust_store, "FILE_STORE", False)


@pytest.fixture(autouse=True)
def _fresh_exchanges():
    device_pairing._reset_for_test()
    yield
    device_pairing._reset_for_test()


def _pair_frame(peer, kind: str, msg_key: str = "pair-k1", **fields):
    """A pairing frame as another machine puts it on the wire."""
    text = device_pairing.envelope(kind, **fields)
    return {
        "msgKey": msg_key,
        "text": text,
        "from": {"deviceId": peer.device_id, "memberId": "m1"},
        "to": {"deviceId": device_identity.device_id(), "workspace": "", "paneName": ""},
        "sig": peer.sign(
            msg_key=msg_key,
            to_device=device_identity.device_id(),
            kind="text",
            body=text,
        ),
    }


def _response(msg_key: str = "pair-resp-1"):
    return _pair_frame(
        PEER,
        device_pairing.PAIR_RESPONSE,
        msg_key=msg_key,
        nonce="bm9uY2U=",
        signKey=PEER.sign_key,
        encKey=PEER.enc_key,
    )


def _sent_pair_frames(conn, since: int = 0) -> list[dict]:
    return [
        f["payload"]
        for f in conn.sent[since:]
        if f.get("type") == "messages.send"
        and str((f.get("payload") or {}).get("msgKey") or "").startswith("pair-")
    ]


async def _started(link, conn) -> str:
    """Ask PEER to pair; returns the request's msgKey."""
    link._online_devices = {PEER.device_id}
    before = len(conn.sent)
    reply = await link.start_pairing(PEER.device_id)
    assert reply["ok"] is True
    (request,) = _sent_pair_frames(conn, before)
    return request["msgKey"]


def _failures(link) -> list[dict]:
    return link.network_snapshot()["pairingFailures"]


# ---- refused here --------------------------------------------------------------


async def test_a_response_refused_for_an_unreadable_trust_record_ends_the_round():
    """The reported case, end to end: the answer arrives, this side cannot read
    its trust record and refuses it — the refusal itself is unchanged — and the
    round it belonged to is over, with the reason left where the card reads."""
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await _started(link, conn)
        link._trust_locked = "the device trust store could not be opened (test)"

        await conn.push({"type": "messages.pending", "payload": _response()})
        await _until(lambda: bool(conn.acks))

        # The refusal is exactly what it was.
        assert conn.acks[0]["state"] == "rejected"
        assert conn.acks[0]["reason"] == "trust-unavailable"
        # And the wait is over, rather than five minutes long.
        assert device_pairing.get(PEER.device_id) is None
        (failure,) = _failures(link)
        assert failure["deviceId"] == PEER.device_id
        assert failure["reason"] == "trust-unavailable"
        assert failure["side"] == "local"
        assert failure["at"] > 0
    finally:
        await link.stop()


async def test_after_that_refusal_pairing_again_is_not_refused_as_busy():
    """The second half of the report: pressing Pair again said a pairing was
    already in progress. With the round ended, the next press is a new round
    (refused here only because the record is still unreadable — see below)."""
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await _started(link, conn)
        link._trust_locked = "the device trust store could not be opened (test)"
        await conn.push({"type": "messages.pending", "payload": _response()})
        await _until(lambda: device_pairing.get(PEER.device_id) is None)
        link._trust_locked = ""

        await _started(link, conn)

        assert device_pairing.get(PEER.device_id) is not None
        # A new round clears what was said about the last one.
        assert _failures(link) == []
    finally:
        await link.stop()


async def test_pairing_is_refused_up_front_while_the_trust_record_is_unreadable():
    """Every answer would be refused on arrival, so sending the request only
    puts a card on the other screen that this side can never finish."""
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    link = await _connected(server)
    try:
        conn = server.opened[0]
        link._online_devices = {PEER.device_id}
        link._trust_locked = "the device trust store could not be opened (test)"
        before = len(conn.sent)

        reply = await link.start_pairing(PEER.device_id)

        assert reply["ok"] is False
        assert reply["error"]["code"] == "TRUST_UNAVAILABLE"
        assert _sent_pair_frames(conn, before) == []
        assert device_pairing.get(PEER.device_id) is None
    finally:
        await link.stop()


async def test_a_frame_from_a_device_with_no_round_here_records_nothing():
    """Only a round this machine is waiting on is ended. A refused frame from
    anyone else is refused exactly as before and leaves nothing on screen."""
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    link = await _connected(server)
    try:
        conn = server.opened[0]
        link._trust_locked = "the device trust store could not be opened (test)"

        await conn.push({"type": "messages.pending", "payload": _response()})
        await _until(lambda: bool(conn.acks))

        assert conn.acks[0]["reason"] == "trust-unavailable"
        assert _failures(link) == []
    finally:
        await link.stop()


async def test_a_response_the_exchange_refuses_ends_the_round_it_was_for():
    """A response the exchange's own rules refuse (here: no encryption key) is
    refused as before. The round was waiting on exactly that frame and no
    other is coming, so it ends instead of sitting out the five minutes."""
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await _started(link, conn)
        frame = _pair_frame(
            PEER, device_pairing.PAIR_RESPONSE, msg_key="pair-resp-x",
            nonce="bm9uY2U=", signKey=PEER.sign_key,
        )

        await conn.push({"type": "messages.pending", "payload": frame})
        await _until(lambda: bool(conn.acks))

        assert conn.acks[0]["reason"] == "pairing-refused"
        assert device_pairing.get(PEER.device_id) is None
        (failure,) = _failures(link)
        assert (failure["reason"], failure["side"]) == ("pairing-refused", "local")
    finally:
        await link.stop()


async def test_a_frame_that_does_not_verify_does_not_end_a_genuine_round():
    """Deliberately unchanged: a frame that fails its signature is not from the
    device it names, and letting it end the round would let anyone on the path
    cancel a pairing they are not part of."""
    from .test_server_link import Peer

    server = FakeServer(policy=ALLOW_ALL_POLICY)
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await _started(link, conn)
        frame = _response()
        frame["sig"] = Peer("dev-somebody").sign(
            msg_key=frame["msgKey"],
            to_device=device_identity.device_id(),
            kind="text",
            body="something else",
        )

        await conn.push({"type": "messages.pending", "payload": frame})
        await _until(lambda: bool(conn.acks))

        assert conn.acks[0]["reason"] == "unauthenticated"
        assert device_pairing.get(PEER.device_id) is not None
        assert _failures(link) == []
    finally:
        await link.stop()


# ---- refused there -------------------------------------------------------------


@pytest.mark.parametrize(
    "reason",
    ["trust-unavailable", "policy-denied", "unauthenticated", "pairing-refused"],
)
async def test_a_request_the_other_side_refused_ends_the_round_with_its_reason(reason):
    """The other machine already says why, in the ack every refusal carries —
    this side used to read that ack for panes only."""
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    link = await _connected(server)
    try:
        conn = server.opened[0]
        request_key = await _started(link, conn)

        await conn.push(
            {
                "type": "messages.acked",
                "payload": {"msgKey": request_key, "state": "rejected", "reason": reason},
            }
        )
        await _until(lambda: device_pairing.get(PEER.device_id) is None)

        (failure,) = _failures(link)
        assert failure["reason"] == reason
        assert failure["side"] == "remote"
    finally:
        await link.stop()


async def test_a_response_the_initiator_refused_ends_the_responders_round_too():
    """The same report seen from the other machine: it answered, and its card
    then waited out the five minutes for a confirm that could never come."""
    asker = PEER
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    server.directory = [asker.session_row()]
    link = await _connected(server)
    try:
        conn = server.opened[0]
        before = len(conn.sent)
        await conn.push(
            {
                "type": "messages.pending",
                "payload": _pair_frame(
                    asker, device_pairing.PAIR_REQUEST, msg_key="pair-req-in",
                    nonce="bm9uY2U=", signKey=asker.sign_key, encKey=asker.enc_key,
                ),
            }
        )
        await _until(lambda: bool(_sent_pair_frames(conn, before)))
        (response,) = _sent_pair_frames(conn, before)
        assert device_pairing.get(asker.device_id) is not None

        await conn.push(
            {
                "type": "messages.acked",
                "payload": {
                    "msgKey": response["msgKey"],
                    "state": "rejected",
                    "reason": "trust-unavailable",
                },
            }
        )
        await _until(lambda: device_pairing.get(asker.device_id) is None)

        (failure,) = _failures(link)
        assert (failure["reason"], failure["side"]) == ("trust-unavailable", "remote")
    finally:
        await link.stop()


async def test_a_delivered_ack_changes_nothing():
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    link = await _connected(server)
    try:
        conn = server.opened[0]
        request_key = await _started(link, conn)

        link._on_message_acked({"msgKey": request_key, "state": "delivered"})

        assert device_pairing.get(PEER.device_id) is not None
        assert _failures(link) == []
    finally:
        await link.stop()


async def test_a_late_refusal_of_an_earlier_round_leaves_the_current_one_alone():
    """The ack names a frame, and the frame belonged to one round. A refusal
    arriving after that round was withdrawn and a new one begun is about the
    old one."""
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    link = await _connected(server)
    try:
        conn = server.opened[0]
        old_key = await _started(link, conn)
        await link.confirm_pairing(PEER.device_id, accept=False)
        await _started(link, conn)

        link._on_message_acked(
            {"msgKey": old_key, "state": "rejected", "reason": "pairing-refused"}
        )

        assert device_pairing.get(PEER.device_id) is not None
        assert _failures(link) == []
    finally:
        await link.stop()


async def test_an_unknown_ack_is_still_only_an_ack():
    """Acks for pane messages are untouched by any of this."""
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await _started(link, conn)

        link._on_message_acked(
            {"msgKey": "m-ordinary", "state": "rejected", "reason": "policy-denied"}
        )

        assert device_pairing.get(PEER.device_id) is not None
        assert _failures(link) == []
    finally:
        await link.stop()


# ---- old and new builds, either way round ---------------------------------------


async def test_a_new_initiator_still_pairs_with_a_peer_that_speaks_only_the_old_frames():
    """Nothing new is asked of the other side: the request, the response and
    the two confirms are the same four frames, and the acks are the ones every
    build has always sent. An older peer is exactly this script."""
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    link = await _connected(server)
    try:
        conn = server.opened[0]
        request_key = await _started(link, conn)
        link._on_message_acked({"msgKey": request_key, "state": "delivered"})
        await conn.push({"type": "messages.pending", "payload": _response()})
        await _until(
            lambda: (device_pairing.get(PEER.device_id) or None) is not None
            and device_pairing.get(PEER.device_id).state == device_pairing.STATE_AWAITING_LOCAL
        )

        await link.confirm_pairing(PEER.device_id, accept=True)
        await conn.push(
            {
                "type": "messages.pending",
                "payload": _pair_frame(PEER, device_pairing.PAIR_CONFIRM, msg_key="pair-conf-in"),
            }
        )
        await _until(lambda: trust_store.pin_for(PEER.device_id) is not None)

        assert trust_store.pin_for(PEER.device_id)["signKey"] == PEER.sign_key
        assert _failures(link) == []
        # Every frame this side sent is one of the kinds every build knows.
        kinds = {
            device_pairing.parse(frame["text"])["kind"] for frame in _sent_pair_frames(conn)
        }
        assert kinds <= {
            device_pairing.PAIR_REQUEST,
            device_pairing.PAIR_CONFIRM,
            device_pairing.SYNC_KEY_OFFER,
        }
    finally:
        await link.stop()


async def test_refusing_sends_no_new_kind_of_message_to_an_older_initiator():
    """What an older initiator receives when this side refuses is the ack it
    always received — and nothing else. The reason is not carried in any new
    frame, so a build that predates this change sees no difference at all."""
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    server.directory = [PEER.session_row()]
    link = await _connected(server)
    try:
        conn = server.opened[0]
        link._trust_locked = "the device trust store could not be opened (test)"
        before = len(conn.sent)

        await conn.push(
            {
                "type": "messages.pending",
                "payload": _pair_frame(
                    PEER, device_pairing.PAIR_REQUEST, msg_key="pair-req-old",
                    nonce="bm9uY2U=", signKey=PEER.sign_key, encKey=PEER.enc_key,
                ),
            }
        )
        await _until(lambda: bool(conn.acks))

        assert conn.acks == [
            {**conn.acks[0], "msgKey": "pair-req-old", "state": "rejected", "reason": "trust-unavailable"}
        ]
        assert _sent_pair_frames(conn, before) == []
    finally:
        await link.stop()


async def test_a_pairing_row_says_when_it_stops_waiting():
    """What "already in progress" has to be able to say: how long is left."""
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await _started(link, conn)

        (row,) = link.pairing_rows()
        pairing = device_pairing.get(PEER.device_id)
        assert row["expiresAt"] == pairing.deadline
    finally:
        await link.stop()
