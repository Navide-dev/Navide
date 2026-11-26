"""Pairing a phone: the six digits, the approval signature, the QR text, the
trusted-phone list, and the ws handlers around them.

The phone computes the same digits and verifies the same signature
(apps/mobile/src/features/pairing/sas.ts), so the test vector here is the one
both sides are held to byte for byte.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import stat
import sys
import time
import uuid
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from agent_team_backend import (
    agent_messaging,
    app,
    confirm_token,
    device_signing,
    mobile_pairing,
    server_link,
)

_CONFIRM_KEY = "test-confirmation-key"


@pytest.fixture(autouse=True)
def _clean():
    mobile_pairing._reset_for_test()
    confirm_token._reset_for_test(_CONFIRM_KEY)
    yield
    mobile_pairing._reset_for_test()
    confirm_token._reset_for_test()


def _phone_key() -> str:
    """A well-formed phone public key, made up at run time."""
    return mobile_pairing.b64url(os.urandom(32))


# ---- the crypto contract ------------------------------------------------------


def test_the_six_digits_match_the_shared_test_vector() -> None:
    code = mobile_pairing.pairing_code(
        bytes(range(32)), bytes(range(32, 64)), "desktop-nonce", "phone-nonce"
    )
    assert code == "888618"


def test_changing_any_input_changes_the_digits() -> None:
    base = (bytes(range(32)), bytes(range(32, 64)), "desktop-nonce", "phone-nonce")
    honest = mobile_pairing.pairing_code(*base)
    assert mobile_pairing.pairing_code(bytes(32), *base[1:]) != honest
    assert mobile_pairing.pairing_code(base[0], bytes(32), *base[2:]) != honest
    assert mobile_pairing.pairing_code(*base[:3], "other-nonce") != honest


def test_the_approval_is_signed_by_this_machines_key() -> None:
    phone_key = _phone_key()
    signature = mobile_pairing.sign_approval("dev-mine", phone_key, "phone-nonce")
    assert "=" not in signature and "+" not in signature and "/" not in signature
    public = Ed25519PublicKey.from_public_bytes(base64.b64decode(device_signing.public_key()))
    expected = f"navide/mobile-approval/v1\ndev-mine\n{phone_key}\nphone-nonce".encode()
    public.verify(mobile_pairing.from_b64url(signature), expected)  # raises on mismatch


def test_the_qr_text_is_what_the_phone_parses() -> None:
    offer = mobile_pairing.create_offer()
    key = mobile_pairing.desktop_key_raw()
    text = mobile_pairing.offer_text("dev-mine", offer, key)
    assert text.startswith("navide://pair?")
    query = {k: v[0] for k, v in parse_qs(urlsplit(text).query).items()}
    assert query["v"] == "1"
    assert query["d"] == "dev-mine"
    assert "=" not in query["k"]
    assert mobile_pairing.from_b64url(query["k"]) == key and len(key) == 32
    assert query["n"] == offer.nonce
    assert query["c"] == offer.code
    assert offer.code_hash == hashlib.sha256(offer.code.encode()).hexdigest()
    assert offer.expires_at == pytest.approx(time.time() + 300, abs=5)


# ---- offers and requests ------------------------------------------------------


def _scan(offer: mobile_pairing.Offer, **overrides: Any) -> dict[str, Any]:
    payload = {
        "requestId": "req-1",
        "codeHash": offer.code_hash,
        "phoneKey": _phone_key(),
        "phoneNonce": "phone-nonce",
        "deviceName": "Pixel",
    }
    payload.update(overrides)
    return payload


def test_a_request_for_the_live_offer_is_kept_with_its_digits() -> None:
    offer = mobile_pairing.create_offer()
    key = mobile_pairing.desktop_key_raw()
    scan = _scan(offer)
    request = mobile_pairing.receive_request(scan, key)
    assert request is not None
    assert request.code == mobile_pairing.pairing_code(
        key, mobile_pairing.from_b64url(scan["phoneKey"]), offer.nonce, "phone-nonce"
    )
    assert [r.request_id for r in mobile_pairing.pending_requests()] == ["req-1"]


def test_the_offer_is_single_use() -> None:
    offer = mobile_pairing.create_offer()
    key = mobile_pairing.desktop_key_raw()
    assert mobile_pairing.receive_request(_scan(offer), key) is not None
    assert mobile_pairing.active_offer() is None
    assert mobile_pairing.receive_request(_scan(offer, requestId="req-2"), key) is None


def test_requests_that_do_not_match_are_ignored() -> None:
    offer = mobile_pairing.create_offer()
    key = mobile_pairing.desktop_key_raw()
    assert mobile_pairing.receive_request(_scan(offer, codeHash="0" * 64), key) is None
    assert mobile_pairing.receive_request(_scan(offer, phoneKey="short"), key) is None
    assert mobile_pairing.receive_request(_scan(offer, phoneNonce=""), key) is None
    assert mobile_pairing.receive_request("nope", key) is None
    assert mobile_pairing.active_offer() is offer


def test_an_expired_offer_matches_nothing() -> None:
    offer = mobile_pairing.create_offer()
    offer.expires_at = time.time() - 1
    assert mobile_pairing.receive_request(_scan(offer), mobile_pairing.desktop_key_raw()) is None


# ---- trusted phones -------------------------------------------------------------


def test_trusted_phones_round_trip_in_a_private_file() -> None:
    key = _phone_key()
    mobile_pairing.add_trusted("ph-1", "Pixel", key)
    phones = mobile_pairing.load_trusted()
    assert [(p["phoneId"], p["deviceName"], p["publicKey"]) for p in phones] == [("ph-1", "Pixel", key)]
    if sys.platform != "win32":
        assert stat.S_IMODE(mobile_pairing.trusted_path().stat().st_mode) == 0o600
    assert mobile_pairing.remove_trusted("ph-1") is True
    assert mobile_pairing.remove_trusted("ph-1") is False
    assert mobile_pairing.load_trusted() == []


# ---- the link ---------------------------------------------------------------------


@pytest.fixture
def link(monkeypatch):
    """A connected ServerLink whose requests are answered by a stub."""
    link = server_link.ServerLink(connect=lambda url: None, config_loader=lambda: None)
    link._device_id = "dev-mine"
    link._ws = object()
    link._authenticated = True
    link.sent = []  # type: ignore[attr-defined]
    link.replies = {}  # type: ignore[attr-defined]

    async def fake_carry(msg_type: str, payload: dict) -> dict:
        link.sent.append((msg_type, payload))  # type: ignore[attr-defined]
        return link.replies.get(msg_type, {"ok": True, "payload": {}})  # type: ignore[attr-defined]

    monkeypatch.setattr(link, "_carry", fake_carry)
    events: list[dict] = []

    async def fake_broadcast(event: dict, **_kwargs) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    link.events = events  # type: ignore[attr-defined]
    monkeypatch.setattr(server_link, "_link", link)
    return link


async def test_offer_registers_the_code_hash_and_returns_the_qr(link) -> None:
    reply = await link.create_mobile_offer()
    assert reply["ok"] is True
    offer = mobile_pairing.active_offer()
    assert offer is not None
    assert link.sent == [("mobile.offer.create", {"codeHash": offer.code_hash, "expiresAt": int(offer.expires_at)})]
    assert f"c={offer.code}" in reply["payload"]["qr"]


async def test_a_refused_offer_is_withdrawn(link) -> None:
    link.replies["mobile.offer.create"] = {"ok": False, "error": {"code": "UNKNOWN_TYPE", "message": "no"}}
    reply = await link.create_mobile_offer()
    assert reply["ok"] is False
    assert mobile_pairing.active_offer() is None


async def test_an_inbound_request_is_stored_and_announced(link) -> None:
    offer = mobile_pairing.create_offer()
    await link._on_mobile_pair_request(_scan(offer))
    assert [r.request_id for r in mobile_pairing.pending_requests()] == ["req-1"]
    assert link.events[-1]["type"] == "p2p.mobile.changed"


async def test_approving_signs_and_records_the_phone(link) -> None:
    offer = mobile_pairing.create_offer()
    scan = _scan(offer)
    await link._on_mobile_pair_request(scan)
    link.replies["mobile.pair.approve"] = {"ok": True, "payload": {"phoneId": "ph-1"}}
    reply = await link.approve_mobile_pair("req-1")
    assert reply == {"ok": True, "payload": {"phoneId": "ph-1"}}
    msg_type, sent = link.sent[-1]
    assert msg_type == "mobile.pair.approve"
    assert (sent["requestId"], sent["phoneKey"], sent["phoneNonce"]) == ("req-1", scan["phoneKey"], "phone-nonce")
    public = Ed25519PublicKey.from_public_bytes(base64.b64decode(device_signing.public_key()))
    public.verify(
        mobile_pairing.from_b64url(sent["signature"]),
        mobile_pairing.approval_message("dev-mine", scan["phoneKey"], "phone-nonce"),
    )
    assert [p["phoneId"] for p in mobile_pairing.load_trusted()] == ["ph-1"]
    assert mobile_pairing.pending_requests() == []


async def test_removal_keeps_the_phone_until_the_server_agrees(link) -> None:
    mobile_pairing.add_trusted("ph-1", "Pixel", _phone_key())
    link.replies["mobile.devices.revoke"] = {"ok": False, "error": {"code": "LINK_OFFLINE", "message": "down"}}
    assert (await link.revoke_mobile_device("ph-1"))["ok"] is False
    assert [p["phoneId"] for p in mobile_pairing.load_trusted()] == ["ph-1"]
    link.replies.pop("mobile.devices.revoke")
    assert (await link.revoke_mobile_device("ph-1"))["ok"] is True
    assert mobile_pairing.load_trusted() == []


# ---- ws handlers ------------------------------------------------------------------


class _Socket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


def _confirmation(action: str, device_id: str) -> dict[str, str]:
    nonce = uuid.uuid4().hex
    expires = str(time.time() + 30)
    payload = "\x00".join(("navide/trust-confirm/v2", nonce, expires, action, device_id, ""))
    return {
        "nonce": nonce,
        "expires": expires,
        "mac": hmac.new(_CONFIRM_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest(),
    }


async def _call(msg_type: str, payload: dict) -> dict:
    session = app.Session(_Socket())  # type: ignore[arg-type]
    await app.handle_message(session, {"id": "x1", "type": msg_type, "payload": payload})
    return session.websocket.sent[-1]  # type: ignore[attr-defined]


@pytest.mark.parametrize(
    ("action", "field"),
    [("p2p.mobile.trust", "requestId"), ("p2p.mobile.reject", "requestId"), ("p2p.mobile.remove", "phoneId")],
)
async def test_trust_changes_need_a_confirmation_for_that_id(link, action, field) -> None:
    reply = await _call(action, {field: "id-1"})
    assert reply["error"]["code"] == "CONFIRMATION_REQUIRED"
    # Minted for another id, it does not transfer.
    reply = await _call(action, {field: "id-1", "confirm": _confirmation(action, "id-2")})
    assert reply["error"]["code"] == "CONFIRMATION_REQUIRED"
    assert link.sent == []


async def test_trust_through_the_handler(link) -> None:
    await link._on_mobile_pair_request(_scan(mobile_pairing.create_offer()))
    link.replies["mobile.pair.approve"] = {"ok": True, "payload": {"phoneId": "ph-1"}}
    reply = await _call(
        "p2p.mobile.trust",
        {"requestId": "req-1", "confirm": _confirmation("p2p.mobile.trust", "req-1")},
    )
    assert reply["ok"] is True and reply["payload"] == {"phoneId": "ph-1"}


async def test_state_merges_last_seen_from_the_server(link) -> None:
    mobile_pairing.add_trusted("ph-1", "Pixel", _phone_key())
    link.replies["mobile.devices.list"] = {
        "ok": True,
        "payload": {"devices": [{"phoneId": "ph-1", "deviceName": "Pixel", "lastSeenAt": 1234}]},
    }
    reply = await _call("p2p.mobile.state", {})
    body = reply["payload"]
    assert body["configured"] is True and body["reachable"] is True
    assert body["phones"][0]["phoneId"] == "ph-1" and body["phones"][0]["lastSeenAt"] == 1234
    # Public keys stay on this machine's list; the window does not need them.
    assert "publicKey" not in body["phones"][0]


async def test_state_without_a_server_says_so(monkeypatch) -> None:
    monkeypatch.setattr(server_link, "_link", None)
    reply = await _call("p2p.mobile.state", {})
    assert reply["payload"]["configured"] is False
    offer = await _call("p2p.mobile.offer", {"confirm": _confirmation("p2p.mobile.offer", "")})
    assert offer["error"]["code"] == "P2P_NOT_CONFIGURED"


async def test_a_pairing_code_needs_a_window_confirmation(monkeypatch) -> None:
    monkeypatch.setattr(server_link, "_link", None)
    refused = await _call("p2p.mobile.offer", {})
    assert refused["error"]["code"] == "CONFIRMATION_REQUIRED"
    # A confirmation minted for another action does not open this one.
    wrong = await _call("p2p.mobile.offer", {"confirm": _confirmation("p2p.mobile.trust", "")})
    assert wrong["error"]["code"] == "CONFIRMATION_REQUIRED"


# ---- the roster -----------------------------------------------------------------


@pytest.fixture
def _registry():
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


def test_the_roster_says_what_an_awaiting_pane_waits_on(_registry) -> None:
    entry = agent_messaging.register("pm1", "worker", "/ws/alpha", agent_key="claude")
    agent_messaging.set_busy("pm1", False, "awaiting", "permission")
    assert server_link._session_payload(entry)["awaitingKind"] == "permission"
    # Not awaiting any more: the word goes, even if the window has not cleared it.
    agent_messaging.set_busy("pm1", False, "running")
    assert "awaitingKind" not in server_link._session_payload(entry)
