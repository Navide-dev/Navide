"""The handlers behind the trust surface: knocks, approve, block, unblock.

These drive the real dispatcher, so they also cover the wiring — a handler that
was never registered fails here rather than silently in production.
"""

from __future__ import annotations

import hashlib
import hmac
import time
import uuid
from typing import Any

import pytest

from agent_team_backend import (
    app,
    confirm_token,
    device_trust,
    server_link,
    trust_store,
    ws_handlers,
)

pytestmark = pytest.mark.asyncio

THEIRS = "m-theirs"
THEIR_BOX = "dev-their-box"

#: Two distinct, well-formed signing keys (base64 of 32 bytes). Their contents
#: are irrelevant here: nothing in these tests verifies a signature, they only
#: have to differ and to be something ``fingerprint`` can name.
_A_KEY = "TFRxJmv2VwcQ0Ck6dQ0kzR8bSMKh1kJm0m1bXbT1RH8="
_B_KEY = "S2ognBz4wA6tOoZO2xLZzFHo7fBLBmB1lJ0Yl4W1JVI="


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


async def _quiet(event: dict, **_kwargs) -> None:
    """Broadcasts are not what these tests are about."""


#: The key these tests pretend the main process handed over on stdin.
_CONFIRM_KEY = "test-confirmation-key"


@pytest.fixture(autouse=True)
def _confirmable():
    """Every test here drives a handler the way a window does, so each one has
    a key to sign with. The tests that are *about* the confirmation reset this
    themselves."""
    confirm_token._reset_for_test(_CONFIRM_KEY)
    yield
    confirm_token._reset_for_test()


def _confirmation(
    action: str, device_id: str = "", subject: str = "", *, ttl: float = 30.0
) -> dict[str, str]:
    """What the main process mints, computed the same way it does."""
    nonce = uuid.uuid4().hex
    expires = str(time.time() + ttl)
    payload = "\x00".join(("navide/trust-confirm/v2", nonce, expires, action, device_id, subject))
    return {
        "nonce": nonce,
        "expires": expires,
        "mac": hmac.new(
            _CONFIRM_KEY.encode(), payload.encode(), hashlib.sha256
        ).hexdigest(),
    }


async def _call(msg_type: str, payload: dict) -> dict:
    """One request, with a fresh confirmation folded in when the handler wants
    one. Tests that care about a *missing* confirmation call _raw instead."""
    if msg_type in _CONFIRMED_ACTIONS and "confirm" not in payload:
        device_id = str(payload.get("deviceId") or "")
        payload = {**payload, "confirm": _confirmation(msg_type, device_id, _subject_of(msg_type, payload))}
    return await _raw(msg_type, payload)


def _subject_of(msg_type: str, payload: dict) -> str:
    """The subject the window binds for each action — mirrors what the modal
    passes to trustConfirm, and what the handler passes to confirm_token.check."""
    if msg_type == "p2p.policy.set":
        return confirm_token.canonical_json(payload.get("policy"))
    if msg_type == "p2p.access_requests.approve":
        return str(payload.get("key") or "")
    if msg_type in ("p2p.trust.block", "p2p.trust.unblock"):
        return str(payload.get("memberId") or "").strip()
    return ""


async def _raw(msg_type: str, payload: dict) -> dict:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    await app.handle_message(session, {"id": "x1", "type": msg_type, "payload": payload})
    return session.websocket.sent[-1]  # type: ignore[attr-defined]


_CONFIRMED_ACTIONS = {
    "p2p.pair.start",
    "p2p.pair.confirm",
    "p2p.policy.set",
    "p2p.trust.device.unpair",
    "p2p.trust.device.defer",
    "p2p.trust.block",
    "p2p.trust.unblock",
    "p2p.access_requests.approve",
}


class FakeLink:
    """Stands in for a connected ServerLink: holds one policy document and the
    knock ledger, and records what would have been written."""

    def __init__(self, policy: Any = None, *, editable: bool = True) -> None:
        self.policy = policy
        self.editable = editable
        self.writes: list[Any] = []
        self.requests = device_trust.AccessRequests()

    async def policy_state(self) -> dict:
        return {
            "state": "connected" if self.editable else "unconfigured",
            "editable": self.editable,
            "policy": self.policy,
            "revision": 1,
            "deviceId": "dev-mine",
            "memberId": "m-mine",
        }

    async def set_policy(self, policy: Any) -> dict:
        self.writes.append(policy)
        self.policy = policy
        return {"ok": True, "payload": {"revision": len(self.writes) + 1}}


@pytest.fixture
def link(monkeypatch):
    fake = FakeLink()
    monkeypatch.setattr(server_link, "policy_state", fake.policy_state)
    monkeypatch.setattr(server_link, "set_policy", fake.set_policy)
    monkeypatch.setattr(server_link, "access_requests", fake.requests.list)
    monkeypatch.setattr(server_link, "forget_access_request", fake.requests.forget)
    monkeypatch.setattr(server_link, "forget_access_requests_for_device", fake.requests.forget_device)
    monkeypatch.setattr(ws_handlers.remote_roster, "list_devices", lambda: [])

    broadcast_calls: list[dict] = []

    async def fake_broadcast(event: dict, **_kwargs) -> None:
        broadcast_calls.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    fake.broadcasts = broadcast_calls  # type: ignore[attr-defined]
    return fake


def _knock(fake: FakeLink, *, pane: str = "reviewer", device: str = THEIR_BOX) -> str:
    return fake.requests.record(
        member_id=THEIRS,
        device_id=device,
        device_name="their box",
        workspace="proj",
        pane_name=pane,
    )["key"]


# ---- reading -----------------------------------------------------------------


async def test_the_knock_list_is_readable(link) -> None:
    _knock(link)
    reply = await _call("p2p.access_requests.list", {})
    assert reply["ok"] is True
    assert [r["paneName"] for r in reply["payload"]["requests"]] == ["reviewer"]


# ---- approving ---------------------------------------------------------------


async def test_approving_writes_one_narrow_allow_rule(link) -> None:
    """The grant is exactly as wide as the knock was. Widening it to a wildcard
    is an edit made in the editor, where the user can see what they widened."""
    key = _knock(link)
    reply = await _call("p2p.access_requests.approve", {"key": key})
    assert reply["ok"] is True
    assert link.writes[-1]["rules"] == [
        {
            "from": {"memberId": THEIRS, "deviceId": THEIR_BOX},
            "to": {"workspace": "proj", "paneName": "reviewer"},
            "action": "allow",
        }
    ]
    # The rule it wrote must be one the enforcement side actually honours —
    # a grant this build would skip is a permission the user believes they gave.
    from agent_team_backend import pane_policy

    assert pane_policy.validate(link.writes[-1]) == ""
    assert pane_policy.is_allowed(
        link.writes[-1],
        member_id=THEIRS,
        device_id=THEIR_BOX,
        workspace="proj",
        pane_name="reviewer",
    )


async def test_approving_one_pane_grants_nothing_next_door(link) -> None:
    key = _knock(link, pane="reviewer")
    await _call("p2p.access_requests.approve", {"key": key})
    from agent_team_backend import pane_policy

    assert not pane_policy.is_allowed(
        link.writes[-1],
        member_id=THEIRS,
        device_id=THEIR_BOX,
        workspace="proj",
        pane_name="deployer",
    )


async def test_approving_clears_the_knock_and_tells_the_windows(link) -> None:
    key = _knock(link)
    await _call("p2p.access_requests.approve", {"key": key})
    assert link.requests.list() == []
    assert any(e["type"] == "p2p.access_requests.changed" for e in link.broadcasts)


async def test_approving_the_same_knock_twice_is_refused_not_duplicated(link) -> None:
    """What a second click on a stale list looks like."""
    key = _knock(link)
    await _call("p2p.access_requests.approve", {"key": key})
    again = await _call("p2p.access_requests.approve", {"key": key})
    assert again["ok"] is False
    assert again["error"]["code"] == "NOT_FOUND"
    assert len(link.writes) == 1


async def test_approving_keeps_the_rules_that_were_already_there(link) -> None:
    existing = {
        "from": {"memberId": "m-other", "deviceId": "dev-other"},
        "to": {"workspace": "*", "paneName": "*"},
        "action": "allow",
    }
    link.policy = {"version": 1, "default": "deny", "rules": [existing]}
    key = _knock(link)
    await _call("p2p.access_requests.approve", {"key": key})
    assert existing in link.writes[-1]["rules"]
    assert len(link.writes[-1]["rules"]) == 2


async def test_approving_does_not_mutate_the_cached_policy_in_place(link) -> None:
    """The cache is what authorization reads; a half-built document must never
    become the live one if the write fails."""
    cached = {"version": 1, "default": "deny", "rules": []}
    link.policy = cached
    key = _knock(link)
    await _call("p2p.access_requests.approve", {"key": key})
    assert cached["rules"] == []


# ---- dismissing --------------------------------------------------------------


async def test_dismissing_grants_nothing(link) -> None:
    key = _knock(link)
    reply = await _call("p2p.access_requests.dismiss", {"key": key})
    assert reply["payload"]["forgotten"] is True
    assert link.writes == []
    assert link.requests.list() == []


# ---- blocking ----------------------------------------------------------------


async def test_blocking_a_device_writes_a_block_and_clears_its_knocks(link) -> None:
    _knock(link, pane="a")
    _knock(link, pane="b")
    _knock(link, device="dev-someone-else", pane="c")
    reply = await _call("p2p.trust.block", {"deviceId": THEIR_BOX, "reason": "stolen"})
    assert reply["ok"] is True
    assert device_trust.is_blocked(link.writes[-1], member_id="", device_id=THEIR_BOX)
    # Blocking stops this machine being asked about that device.
    assert [r["deviceId"] for r in link.requests.list()] == ["dev-someone-else"]


async def test_blocking_needs_something_to_block(link) -> None:
    reply = await _call("p2p.trust.block", {})
    assert reply["ok"] is False
    assert reply["error"]["code"] == "BAD_REQUEST"
    assert link.writes == []


async def test_blocking_twice_does_not_stack_entries(link) -> None:
    await _call("p2p.trust.block", {"deviceId": THEIR_BOX})
    await _call("p2p.trust.block", {"deviceId": THEIR_BOX})
    assert len(link.writes[-1]["blocked"]) == 1


async def test_a_written_block_is_one_the_enforcement_side_reads(link) -> None:
    """The write path and the read path must agree, or the user is looking at a
    refusal that is not happening."""
    await _call("p2p.trust.block", {"memberId": THEIRS})
    written = link.writes[-1]
    assert device_trust.validate_blocked(written) == ""
    assert (
        device_trust.ring(
            written, member_id=THEIRS, device_id="dev-anything", own_device=False
        )
        == device_trust.RING_BLOCKED
    )


async def test_unblocking_lifts_the_refusal_without_granting_anything(link) -> None:
    await _call("p2p.trust.block", {"deviceId": THEIR_BOX})
    await _call("p2p.trust.unblock", {"deviceId": THEIR_BOX})
    written = link.writes[-1]
    assert not device_trust.is_blocked(written, member_id=THEIRS, device_id=THEIR_BOX)
    # Back to being decided by the rules, which deny by default.
    from agent_team_backend import pane_policy

    assert not pane_policy.is_allowed(
        written, member_id=THEIRS, device_id=THEIR_BOX, workspace="proj", pane_name="reviewer"
    )


async def test_a_corrupt_block_list_is_replaced_rather_than_crashing(link) -> None:
    """The document is stored verbatim by the server, so it can hold whatever
    another client wrote. The read side skips what it cannot parse; the write
    side has to survive appending to it."""
    link.policy = {"version": 1, "default": "deny", "rules": [], "blocked": "everyone"}
    reply = await _call("p2p.trust.block", {"deviceId": THEIR_BOX})
    assert reply["ok"] is True
    assert [b["deviceId"] for b in link.writes[-1]["blocked"]] == [THEIR_BOX]


async def test_unblocking_survives_a_corrupt_block_list(link) -> None:
    link.policy = {"version": 1, "default": "deny", "rules": [], "blocked": 7}
    reply = await _call("p2p.trust.unblock", {"deviceId": THEIR_BOX})
    assert reply["ok"] is True
    assert link.writes[-1]["blocked"] == []


async def test_a_policy_that_cannot_be_written_is_refused_before_it_is_sent(link) -> None:
    """An offline or unconfigured link can show its cached rules and must not
    pretend to have saved a change to them."""
    link.editable = False
    reply = await _call("p2p.trust.block", {"deviceId": THEIR_BOX})
    assert reply["ok"] is False
    assert link.writes == []


# ---- trust notices ----------------------------------------------------------


async def test_the_notice_list_is_readable_through_the_dispatcher() -> None:
    """Registration is the thing being tested here as much as the answer: a
    handler nobody routed to fails on this line rather than the first time
    somebody opens the account view."""
    trust_store.load()
    trust_store.pin_device("dev-new", sign_key=_A_KEY, member_id="m-mine")
    reply = await _call("p2p.trust.notices.list", {})
    assert reply["ok"] is True
    assert [n["kind"] for n in reply["payload"]["notices"]] == [
        trust_store.NOTICE_FIRST_SEEN
    ]
    assert reply["payload"]["locked"] == ""


async def test_dismissing_a_first_sighting_walks_the_whole_handler(monkeypatch) -> None:
    """Including the broadcast, which is where an undefined name would hide: it
    runs only after a successful dismissal, so a test that stopped at the reply
    would never reach it."""
    events: list[dict] = []

    async def capture(event: dict, **_kwargs) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", capture)
    trust_store.load()
    trust_store.pin_device("dev-new", sign_key=_A_KEY, member_id="m-mine")
    key = trust_store.notices()[0]["key"]

    reply = await _call("p2p.trust.notices.dismiss", {"key": key})
    assert reply["ok"] is True
    assert trust_store.notices() == []
    assert [e["type"] for e in events] == ["p2p.trust_notices.changed"]
    assert events[0]["payload"]["notices"] == []


async def test_a_changed_key_cannot_be_clicked_away(monkeypatch) -> None:
    """The refusal is in force, not waiting to be acknowledged. Making it go
    away in one click is the move an attacker who wiped this machine's key
    material is counting on, because re-pairing is the natural reaction."""
    events: list[dict] = []

    async def capture(event: dict, **_kwargs) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", capture)
    trust_store.load()
    trust_store.pin_device("dev-new", sign_key=_A_KEY, member_id="m-mine")
    trust_store.note_key_change(
        "dev-new", pinned_key=_A_KEY, offered_key=_B_KEY, member_id="m-mine"
    )
    changed = next(
        n for n in trust_store.notices() if n["kind"] == trust_store.NOTICE_KEY_CHANGED
    )

    reply = await _call("p2p.trust.notices.dismiss", {"key": changed["key"]})
    assert reply["ok"] is False
    assert reply["error"]["code"] == "FORBIDDEN"
    assert any(
        n["kind"] == trust_store.NOTICE_KEY_CHANGED for n in trust_store.notices()
    )
    assert events == [], "nothing changed, so nothing is announced"




# ---- unpairing ---------------------------------------------------------------


async def test_unpairing_walks_the_whole_handler_and_tells_the_windows(monkeypatch) -> None:
    """Registration, the store call and the announcement in one pass: the
    broadcast runs only after something was actually removed, so a test that
    stopped at the reply would never reach it."""
    events: list[dict] = []

    async def capture(event: dict, **_kwargs) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", capture)
    trust_store.load()
    trust_store.pin_device("dev-new", sign_key=_A_KEY, member_id="m-mine")

    reply = await _call("p2p.trust.device.unpair", {"deviceId": "dev-new"})

    assert reply["ok"] is True
    assert reply["payload"]["removed"]["pins"] == 1
    assert reply["payload"]["removed"]["found"] is True
    assert trust_store.pin_for("dev-new") is None
    assert [e["type"] for e in events] == ["p2p.trust_notices.changed"]
    assert events[0]["payload"]["notices"] == []
    assert events[0]["payload"]["pending"] == []


@pytest.mark.parametrize("full", [True, False])
async def test_unpairing_reconnects_only_when_the_record_was_full(monkeypatch, full) -> None:
    """R4-3: a link stopped for a full record re-adopts only on a hello, so the
    unpair that made the room reconnects it; any other unpair does not."""
    reconnects: list[int] = []

    async def fake_reconfigure() -> None:
        reconnects.append(1)

    async def quiet(*_a, **_k) -> None:
        return None

    monkeypatch.setattr(app, "broadcast", quiet)
    monkeypatch.setattr(server_link, "reconfigure", fake_reconfigure)
    monkeypatch.setattr(server_link, "trust_full", lambda: full)
    trust_store.load()
    trust_store.pin_device("dev-new", sign_key=_A_KEY, member_id="m-mine")

    reply = await _call("p2p.trust.device.unpair", {"deviceId": "dev-new"})

    assert reply["ok"] is True
    assert reconnects == ([1] if full else [])


async def test_unpairing_an_unknown_device_announces_nothing(monkeypatch) -> None:
    """It answers, and the answer says nothing went. Broadcasting anyway would
    redraw every window for an act that did not happen."""
    events: list[dict] = []

    async def capture(event: dict, **_kwargs) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", capture)
    trust_store.load()

    reply = await _call("p2p.trust.device.unpair", {"deviceId": "dev-never-here"})

    assert reply["ok"] is True
    assert reply["payload"]["removed"]["found"] is False
    assert events == []


async def test_unpairing_needs_a_device_id() -> None:
    reply = await _call("p2p.trust.device.unpair", {})
    assert reply["ok"] is False
    assert reply["error"]["code"] == "BAD_REQUEST"


async def test_unpairing_a_blocked_device_leaves_the_block_standing(link) -> None:
    """Two different things: a block is a policy refusal ahead of every rule,
    pairing is identity. Unpairing a blocked device must not quietly readmit it
    — no pin and still blocked is the more careful of the two states, and it is
    the one a person asked for."""
    trust_store.load()
    trust_store.pin_device(THEIR_BOX, sign_key=_A_KEY, member_id=THEIRS)
    await _call("p2p.trust.block", {"deviceId": THEIR_BOX, "memberId": THEIRS})
    assert device_trust.blocked_entries(link.policy)

    reply = await _call("p2p.trust.device.unpair", {"deviceId": THEIR_BOX})

    assert reply["ok"] is True
    assert trust_store.pin_for(THEIR_BOX) is None
    assert [e["deviceId"] for e in device_trust.blocked_entries(link.policy)] == [THEIR_BOX]
    assert link.writes, "the block was written by the block handler, not undone here"


# ---- "not now" ---------------------------------------------------------------


async def test_deferring_walks_the_whole_handler_and_tells_the_windows(monkeypatch) -> None:
    """Registration, the store call and the announcement in one pass. The
    broadcast is what takes the row off the card that is already open."""
    events: list[dict] = []

    async def capture(event: dict, **_kwargs) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", capture)
    trust_store.load()
    trust_store.pin_device("dev-not-now", sign_key=_A_KEY, member_id="m-mine")

    reply = await _call("p2p.trust.device.defer", {"deviceId": "dev-not-now"})

    assert reply["ok"] is True
    assert reply["payload"]["deferred"] is True
    assert [e["type"] for e in events] == ["p2p.trust_notices.changed"]


async def test_deferring_grants_nothing(monkeypatch) -> None:
    """The weakest button on the card. Whatever that device could reach before
    it is exactly what it can reach after — the pin is untouched and still
    unapproved, so the ordinary rules apply and those deny by default."""
    async def capture(event: dict, **_kwargs) -> None:
        pass

    monkeypatch.setattr(app, "broadcast", capture)
    trust_store.load()
    trust_store.pin_device("dev-still-held", sign_key=_A_KEY, member_id="m-mine")

    await _call("p2p.trust.device.defer", {"deviceId": "dev-still-held"})

    pin = trust_store.pin_for("dev-still-held")
    assert pin is not None
    assert pin["approved"] is False
    assert pin["signKey"] == _A_KEY


async def test_deferring_an_unknown_device_announces_nothing(monkeypatch) -> None:
    events: list[dict] = []

    async def capture(event: dict, **_kwargs) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", capture)
    trust_store.load()

    reply = await _call("p2p.trust.device.defer", {"deviceId": "dev-nowhere"})

    assert reply["ok"] is True
    assert reply["payload"]["deferred"] is False
    assert events == []


async def test_deferring_needs_a_device_id() -> None:
    reply = await _call("p2p.trust.device.defer", {})
    assert reply["ok"] is False
    assert reply["error"]["code"] == "BAD_REQUEST"


# ---- who may write a pin ------------------------------------------------------


def test_pinning_has_exactly_one_entry_point_in_production_code() -> None:
    """The claim the whole pairing model rests on, checked rather than asserted.

    Three things used to write a pin: a message arriving from an unknown device,
    a button in the device list, and — now — a completed pairing. The first two
    are gone, and a grep is what notices if one comes back, because nothing else
    would: adding a caller breaks no test and changes no behaviour anybody sees
    until the day it matters.
    """
    import pathlib
    import re

    package = pathlib.Path(trust_store.__file__).parent
    callers: list[str] = []
    for path in sorted(package.rglob("*.py")):
        enclosing = ""
        for line in path.read_text(encoding="utf-8").splitlines():
            found = re.match(r"\s*(?:async )?def (\w+)", line)
            if found:
                enclosing = found.group(1)
            if re.search(r"\bpin_paired_device\b|\bpin_device\b", line) and not found:
                callers.append(f"{path.name}:{enclosing}")

    # Named by function rather than by line: a line number fails on every
    # unrelated edit above it, which teaches people to update the number without
    # reading what it was for.
    assert callers == ["server_link.py:_finish_pairing"], callers


def test_the_old_approve_route_is_gone_rather_than_guarded() -> None:
    """A handler that answers at all is a handler somebody can call. This one
    pinned whatever key the directory advertised, with no six digits compared by
    anybody — which is the exact shortcut the pairing exchange replaced."""
    import pathlib

    source = pathlib.Path(ws_handlers.__file__).read_text(encoding="utf-8")
    assert '@handler("p2p.trust.device.approve")' not in source
    assert not hasattr(trust_store, "approve_from_directory")


# ---- a policy write that names no block list ---------------------------------


async def test_a_write_with_no_blocked_list_keeps_the_blocks(link) -> None:
    """Absent means "the editor had none to send", not "empty this".

    The server stores the document verbatim, so the difference decides whether
    every block survives the write. The rules editor composes from the whole
    cached document and keeps the list; the account view's "sign rules now"
    composes the default for a machine with no rules at all — and that document
    has no blocked key.
    """
    link.policy = {
        "version": 1, "default": "deny", "rules": [],
        "blocked": [{"deviceId": "dev-banned", "memberId": ""}],
    }

    reply = await _call(
        "p2p.policy.set", {"policy": {"version": 1, "default": "deny", "rules": []}}
    )

    assert reply["ok"] is True
    assert link.writes[-1]["blocked"] == [{"deviceId": "dev-banned", "memberId": ""}]


async def test_an_explicit_empty_list_still_clears_them(link) -> None:
    """Only saying so clears one. Absent and empty have to stay different, or
    unblocking would have no way to express itself."""
    link.policy = {
        "version": 1, "default": "deny", "rules": [],
        "blocked": [{"deviceId": "dev-banned", "memberId": ""}],
    }

    reply = await _call(
        "p2p.policy.set",
        {"policy": {"version": 1, "default": "deny", "rules": [], "blocked": []}},
    )

    assert reply["ok"] is True
    assert link.writes[-1]["blocked"] == []


async def test_blocking_records_a_local_copy_as_well(link, monkeypatch) -> None:
    """The copy that still refuses this device when the policy cannot be
    verified. Written only after the policy write succeeded, so the two cannot
    disagree about a block that was never made."""
    trust_store.load()

    reply = await _call("p2p.trust.block", {"deviceId": "dev-both", "memberId": "m-both"})

    assert reply["ok"] is True
    assert device_trust.is_blocked(None, member_id="", device_id="dev-both") is True

    await _call("p2p.trust.unblock", {"deviceId": "dev-both", "memberId": "m-both"})
    assert device_trust.is_blocked(None, member_id="", device_id="dev-both") is False


# ---- the second check on the six ---------------------------------------------
#
# ws_auth answers "may you open this socket". Everything past it may send
# anything, and Navide hands that socket to more than the window: the plugin
# broker holds one, and MCP reaches these handlers on behalf of a CLI agent that
# may be taking instructions from a remote peer. These pin down the check that
# separates the two.


async def test_a_trust_change_with_no_confirmation_is_refused(monkeypatch) -> None:
    """The MCP and plugin case, exactly: they reach the handler and have no way
    to obtain a confirmation, because the key that signs one lives in the main
    process and never reaches this socket."""
    monkeypatch.setattr(app, "broadcast", _quiet)
    trust_store.load()
    trust_store.pin_device("dev-unconfirmed", sign_key=_A_KEY, member_id="m-mine")

    reply = await _raw("p2p.pair.start", {"deviceId": "dev-unconfirmed"})

    assert reply["ok"] is False
    assert reply["error"]["code"] == "CONFIRMATION_REQUIRED"
    assert trust_store.pin_for("dev-unconfirmed")["approved"] is False


async def test_every_one_of_the_six_is_covered(monkeypatch) -> None:
    """A handler added to this family without the guard is the whole hole back.
    Named individually rather than looped over a list the code also owns."""
    monkeypatch.setattr(app, "broadcast", _quiet)
    trust_store.load()
    for action, payload in (
        ("p2p.pair.start", {"deviceId": "d1"}),
        ("p2p.pair.confirm", {"deviceId": "d1", "accept": True}),
        ("p2p.policy.set", {"policy": {"version": 1, "default": "deny", "rules": []}}),
        ("p2p.trust.device.unpair", {"deviceId": "d1"}),
        ("p2p.trust.device.defer", {"deviceId": "d1"}),
        ("p2p.trust.block", {"deviceId": "d1"}),
        ("p2p.trust.unblock", {"deviceId": "d1"}),
        # No such key on purpose: the refusal must come before the lookup.
        ("p2p.access_requests.approve", {"key": "no-such-knock"}),
    ):
        reply = await _raw(action, payload)
        assert reply["ok"] is False, action
        assert reply["error"]["code"] == "CONFIRMATION_REQUIRED", action


async def test_a_confirmation_is_spent_the_first_time(monkeypatch) -> None:
    """Replay is the obvious attack on a token that travels in a message the
    same socket can read back."""
    monkeypatch.setattr(app, "broadcast", _quiet)
    trust_store.load()
    trust_store.pin_device("dev-replay", sign_key=_A_KEY, member_id="m-mine")
    token = _confirmation("p2p.trust.device.defer", "dev-replay")

    first = await _raw("p2p.trust.device.defer", {"deviceId": "dev-replay", "confirm": token})
    second = await _raw("p2p.trust.device.defer", {"deviceId": "dev-replay", "confirm": token})

    assert first["ok"] is True
    assert second["ok"] is False
    assert second["error"]["code"] == "CONFIRMATION_REQUIRED"


async def test_an_expired_confirmation_is_refused(monkeypatch) -> None:
    monkeypatch.setattr(app, "broadcast", _quiet)
    trust_store.load()
    trust_store.pin_device("dev-stale", sign_key=_A_KEY, member_id="m-mine")

    reply = await _raw(
        "p2p.trust.device.defer",
        {"deviceId": "dev-stale", "confirm": _confirmation("p2p.trust.device.defer", "dev-stale", ttl=-1)},
    )

    assert reply["ok"] is False
    assert reply["error"]["code"] == "CONFIRMATION_REQUIRED"


async def test_a_confirmation_for_another_action_is_refused(monkeypatch) -> None:
    """Binding the action is what stops the weakest button in the panel minting
    a token for the strongest one."""
    monkeypatch.setattr(app, "broadcast", _quiet)
    trust_store.load()
    trust_store.pin_device("dev-swap", sign_key=_A_KEY, member_id="m-mine")

    reply = await _raw(
        "p2p.pair.start",
        {"deviceId": "dev-swap", "confirm": _confirmation("p2p.trust.device.defer", "dev-swap")},
    )

    assert reply["ok"] is False
    assert reply["error"]["code"] == "CONFIRMATION_REQUIRED"


async def test_a_confirmation_for_another_device_is_refused(monkeypatch) -> None:
    """And binding the device is what stops one minted to approve your own
    laptop being spent to unpair somebody else's."""
    monkeypatch.setattr(app, "broadcast", _quiet)
    trust_store.load()
    trust_store.pin_device("dev-a", sign_key=_A_KEY, member_id="m-mine")

    reply = await _raw(
        "p2p.trust.device.unpair",
        {"deviceId": "dev-a", "confirm": _confirmation("p2p.trust.device.unpair", "dev-b")},
    )

    assert reply["ok"] is False
    assert reply["error"]["code"] == "CONFIRMATION_REQUIRED"


async def test_a_backend_with_no_key_refuses_rather_than_waves_through(monkeypatch) -> None:
    """Fails closed. A backend that received no key is not one a person's window
    is driving — the main process hands it over before anything else — so the
    honest answer is to refuse rather than to quietly become the surface this
    check exists to remove."""
    monkeypatch.setattr(app, "broadcast", _quiet)
    confirm_token._reset_for_test()
    trust_store.load()
    trust_store.pin_device("dev-keyless-backend", sign_key=_A_KEY, member_id="m-mine")

    reply = await _raw(
        "p2p.trust.device.defer",
        {"deviceId": "dev-keyless-backend", "confirm": _confirmation("p2p.trust.device.defer", "dev-keyless-backend")},
    )

    assert reply["ok"] is False
    assert reply["error"]["code"] == "CONFIRMATION_REQUIRED"


async def test_the_ordinary_window_path_goes_through(monkeypatch) -> None:
    """The other half. A check that refused everything would also pass every
    test above."""
    monkeypatch.setattr(app, "broadcast", _quiet)
    trust_store.load()
    trust_store.pin_device("dev-normal", sign_key=_A_KEY, member_id="m-mine")

    reply = await _raw(
        "p2p.trust.device.defer",
        {"deviceId": "dev-normal", "confirm": _confirmation("p2p.trust.device.defer", "dev-normal")},
    )

    assert reply["ok"] is True
    assert reply["payload"]["deferred"] is True


# ---- the premise the whole check rests on ------------------------------------
#
# "The key is only in the main process, never on disk, never in the
# environment." Everything above assumes it; until now only a comment and one
# manual sweep said so, and neither fails when somebody adds the convenient
# line.


def test_the_confirmation_module_cannot_reach_a_file_or_the_environment() -> None:
    """Read from the parse tree rather than by grepping text, so a name reached
    through an alias or an attribute is still caught.

    What this protects is not a clever attack — it is the ordinary afternoon
    where somebody makes the key survive a backend restart by writing it
    somewhere. A file this process can read is a file a CLI agent running as the
    same user can read, and that is precisely the reader this check exists to
    tell apart from a person's window.
    """
    import ast
    import pathlib

    source = pathlib.Path(confirm_token.__file__).read_text(encoding="utf-8")
    tree = ast.parse(source)

    forbidden_modules = {"os", "pathlib", "shutil", "tempfile", "subprocess", "io"}
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    assert not (imported & forbidden_modules), f"reaches the filesystem: {imported}"

    called = {
        node.func.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }
    assert "open" not in called
    assert "getenv" not in called
    # environ is an attribute rather than a call, so it needs its own sweep —
    # and it has to come from the tree, not the text: the word appears in this
    # module's own docstring, and a check that read the file as a string would
    # be failing on prose while missing `o.environ` reached through an alias.
    attributes = {
        node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)
    }
    assert "environ" not in attributes
    assert "getenv" not in attributes


def test_no_mcp_tool_can_address_a_trust_changing_type() -> None:
    """The other half of "only a window can do this".

    MCP tools call in-process functions; they do not dispatch WebSocket message
    types, so today they cannot reach these handlers at all. That is a property
    of how the package is wired rather than a rule anyone wrote down, which is
    exactly the kind that gets undone by a later commit adding one convenient
    tool. This fails on the day that happens.
    """
    import pathlib

    package = pathlib.Path(confirm_token.__file__).parent / "mcp_server"
    hits = [
        (path.name, action)
        for path in package.rglob("*.py")
        for action in sorted(_CONFIRMED_ACTIONS)
        if action in path.read_text(encoding="utf-8")
    ]
    assert hits == [], f"an MCP tool now names a trust-changing type: {hits}"


async def test_the_plugin_broker_entry_is_the_one_that_is_guarded(monkeypatch) -> None:
    """The socket a plugin holds and the socket a window holds are the same
    socket, and both arrive here. This drives that entry directly — no test
    helper folding a confirmation in — and asserts the refusal.
    """
    monkeypatch.setattr(app, "broadcast", _quiet)
    trust_store.load()
    trust_store.pin_device("dev-broker", sign_key=_A_KEY, member_id="m-mine")

    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    await app.handle_message(
        session,
        {"id": "b1", "type": "p2p.pair.start", "payload": {"deviceId": "dev-broker"}},
    )

    reply = session.websocket.sent[-1]  # type: ignore[attr-defined]
    assert reply["ok"] is False
    assert reply["error"]["code"] == "CONFIRMATION_REQUIRED"
    assert trust_store.pin_for("dev-broker")["approved"] is False


async def test_unblocking_needs_something_to_unblock(link) -> None:
    """The same check block has. Without it an empty request rewrote the policy
    to say exactly what it already said — a signed write, a revision bump and a
    success, for a request that named nobody."""
    reply = await _call("p2p.trust.unblock", {})

    assert reply["ok"] is False
    assert reply["error"]["code"] == "BAD_REQUEST"
    assert link.writes == []


async def test_refusing_a_pairing_needs_a_confirmation_too(monkeypatch) -> None:
    """Refusing is a decision. A remote agent talked into clicking "they do not
    match" cancels a pairing somebody was in the middle of, and the person at
    the other end sees only that it was refused."""
    monkeypatch.setattr(app, "broadcast", _quiet)
    trust_store.load()

    reply = await _raw("p2p.pair.confirm", {"deviceId": "dev-x", "accept": False})

    assert reply["ok"] is False
    assert reply["error"]["code"] == "CONFIRMATION_REQUIRED"


# ---------------------------------------------------------------- subject binding (M6)


async def test_a_confirmation_for_one_policy_document_cannot_sign_another(monkeypatch, link) -> None:
    """The MAC covers the canonical text of the document, not just the action:
    a token lifted from one save cannot replace the rules with different ones."""
    monkeypatch.setattr(app, "broadcast", _quiet)
    trust_store.load()
    allow_nothing = {"version": 1, "default": "deny", "rules": []}
    allow_all = {"version": 1, "default": "allow", "rules": []}
    token = _confirmation("p2p.policy.set", "", confirm_token.canonical_json(allow_nothing))

    swapped = await _raw("p2p.policy.set", {"policy": allow_all, "confirm": token})
    assert swapped["ok"] is False
    assert swapped["error"]["code"] == "CONFIRMATION_REQUIRED"

    # Key order and whitespace are not part of the document, so the same rules
    # spelled differently still match — the binding is to meaning, not bytes.
    reordered = {"rules": [], "default": "deny", "version": 1}
    honest = await _raw("p2p.policy.set", {"policy": reordered, "confirm": token})
    assert honest["ok"] is True, honest


async def test_a_confirmation_for_one_knock_cannot_approve_another(monkeypatch) -> None:
    monkeypatch.setattr(app, "broadcast", _quiet)
    trust_store.load()
    token = _confirmation("p2p.access_requests.approve", "", "knock-a")
    reply = await _raw("p2p.access_requests.approve", {"key": "knock-b", "confirm": token})
    assert reply["ok"] is False
    assert reply["error"]["code"] == "CONFIRMATION_REQUIRED"


async def test_a_confirmation_to_unblock_one_member_cannot_unblock_another(monkeypatch) -> None:
    """Unblock by member carries no device, so before the subject binding the
    device slot was empty and any member id would ride on the same token."""
    monkeypatch.setattr(app, "broadcast", _quiet)
    trust_store.load()
    token = _confirmation("p2p.trust.unblock", "", "member-a")
    reply = await _raw("p2p.trust.unblock", {"deviceId": "", "memberId": "member-b", "confirm": token})
    assert reply["ok"] is False
    assert reply["error"]["code"] == "CONFIRMATION_REQUIRED"


def test_canonical_json_matches_the_renderer_fixture_literally() -> None:
    """The renderer computes the same string in TypeScript (src/shared/canonicalJson.ts).
    Both tests pin this one literal; if either side drifts, one of them goes red
    instead of every policy save quietly refusing."""
    fixture = {'version': 1, 'default': 'deny', 'rules': [{'to': {'paneName': '審查者', 'workspace': '/w/α'}, 'from': {'deviceId': 'd-1', 'memberId': 'm-1'}, 'action': 'allow'}], 'blocked': [], 'note': 'tab\there "q" \\ /slash\u2028😀\x7f'}
    assert confirm_token.canonical_json(fixture) == '{"blocked":[],"default":"deny","note":"tab\\there \\"q\\" \\\\ /slash\\u2028\\ud83d\\ude00\\u007f","rules":[{"action":"allow","from":{"deviceId":"d-1","memberId":"m-1"},"to":{"paneName":"\\u5be9\\u67e5\\u8005","workspace":"/w/\\u03b1"}}],"version":1}'
