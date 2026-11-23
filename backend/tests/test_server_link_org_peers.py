"""Cross-organisation peers: ``peers.list``, its two pushes, and the pin rules.

What is pinned here:

* an older server (no ``peers.list``) or NOT_FOUND leaves the org view at
  "unsupported" and touches nothing else;
* a machine a live grant reaches can be paired with the same six-digit
  exchange, and its pin records the grant — yet it lands in the member ring,
  never the own-device one;
* ``org.grant.revoked`` and the reconnect read downgrade (never delete) only
  the pins of that grant, and a downgraded pin is refused as ``not-paired``;
* a one-click rule written for such a machine is tied to its grant;
* ``remote_targets`` names the organisation and owner of such a machine.
"""

from __future__ import annotations

import pytest

from agent_team_backend import (
    agent_messaging,
    device_identity,
    device_pairing,
    org_peers,
    pane_policy,
    remote_roster,
    trust_store,
)

from .test_server_link import (  # noqa: F401 - fixtures are used by name
    ALLOW_ALL_POLICY,
    PEER,
    FakeServer,
    Peer,
    _clean_registry,
    _connected,
    _fast_timers,
    _ok,
    _paired_peer,
    _pending,
    _until,
    broadcasts,
    default_responder,
)

ORG_PEER = Peer("dev-org-1", name="設計部 iMac")
OTHER_ORG_PEER = Peer("dev-org-2", name="陳怡君 的 MacBook Air")
ORG_MEMBER = "m-org"


@pytest.fixture(autouse=True)
def _keychain_store(monkeypatch):
    monkeypatch.setattr(trust_store, "FILE_STORE", False)


@pytest.fixture(autouse=True)
def _fresh_exchanges():
    device_pairing._reset_for_test()
    yield
    device_pairing._reset_for_test()


def _grant(grant_id: str = "g_1", *peers: Peer, online: bool = True) -> dict:
    return {
        "grantId": grant_id,
        "linkId": "lnk_1",
        "version": 1,
        "expiresAt": 4_000_000_000_000,
        "localOrg": {"orgId": "org_a", "name": "星河工作室"},
        "peerOrg": {"orgId": "org_b", "name": "北辰設計"},
        "peers": [
            {
                "deviceId": peer.device_id,
                "deviceName": peer.name,
                "memberId": ORG_MEMBER,
                "ownerName": "陳怡君",
                "online": online,
                "publicKey": peer.enc_key,
                "signPublicKey": peer.sign_key,
            }
            for peer in (peers or (ORG_PEER,))
        ],
    }


def _org_responder(server_state: dict):
    """default_responder plus ``peers.list``, answered from *server_state*.

    ``grants`` None stands for a server that predates organisations: it
    answers the way an unknown type is answered.
    """

    def responder(conn, message):
        if message.get("type") == "peers.list":
            server_state["calls"] = server_state.get("calls", 0) + 1
            code = server_state.get("error")
            if code:
                return {"id": message["id"], "type": "peers.list.result", "ok": False,
                        "error": {"code": code, "message": "no"}}
            if server_state.get("grants") is None:
                return default_responder(conn, message)
            return _ok(message, {"asOf": 1, "grants": server_state["grants"]})
        return default_responder(conn, message)

    return responder


def _pin_org(peer: Peer = ORG_PEER, grant_id: str = "g_1") -> None:
    trust_store.pin_paired_device(
        peer.device_id,
        sign_key=peer.sign_key,
        enc_key=peer.enc_key,
        member_id=ORG_MEMBER,
        own_member_id="m1",
        org={"grantId": grant_id, "orgId": "org_b", "orgName": "北辰設計", "ownerName": "陳怡君"},
    )


async def _link_with(state: dict, **kwargs):
    server = FakeServer(responder=_org_responder(state), **kwargs)
    link = await _connected(server)
    await _until(lambda: link._org_status != org_peers.STATUS_UNKNOWN)
    return server, link


# ---- compatibility ------------------------------------------------------------


async def test_a_server_without_peers_list_reads_as_not_in_an_organisation():
    server, link = await _link_with({"grants": None})
    try:
        _pin_org()
        snapshot = link.network_snapshot()
        assert snapshot["org"]["status"] == org_peers.STATUS_UNSUPPORTED
        assert snapshot["org"]["grants"] == []
        # Nothing else changed: the personal device list is what it was, and no
        # pin was downgraded for want of an answer.
        assert [d["deviceId"] for d in snapshot["devices"] if not d["isLocal"]] == [PEER.device_id]
        assert trust_store.pin_for(ORG_PEER.device_id)["approved"] is True
    finally:
        await link.stop()


async def test_not_found_also_reads_as_not_in_an_organisation():
    server, link = await _link_with({"error": "NOT_FOUND"})
    try:
        assert link.network_snapshot()["org"]["status"] == org_peers.STATUS_UNSUPPORTED
    finally:
        await link.stop()


async def test_peers_list_fills_the_org_view_and_offers_pairing():
    server, link = await _link_with({"grants": [_grant()]})
    try:
        org = link.network_snapshot()["org"]
        assert org["status"] == org_peers.STATUS_OK
        (grant,) = org["grants"]
        assert grant["peerOrg"]["name"] == "北辰設計"
        (peer,) = grant["peers"]
        assert peer["deviceId"] == ORG_PEER.device_id
        assert peer["ownerName"] == "陳怡君"
        assert peer["trustState"] == "pending"
        assert peer["canTrust"] is True
        assert peer["signFingerprint"]
    finally:
        await link.stop()


async def test_can_trust_on_the_device_list_widens_to_a_reachable_org_machine():
    state = {"grants": [_grant()]}
    server = FakeServer(responder=_org_responder(state))
    server.directory = [
        PEER.session_row(),
        ORG_PEER.session_row(sessionId="s-org", hostMemberId=ORG_MEMBER),
    ]
    link = await _connected(server)
    try:
        await _until(lambda: link._org_status == org_peers.STATUS_OK)
        link._online_devices = {PEER.device_id, ORG_PEER.device_id}
        rows = {d["deviceId"]: d for d in link.network_snapshot()["devices"]}
        assert rows[ORG_PEER.device_id]["canTrust"] is True
        # A stranger outside every grant is still not offered.
        state["grants"] = []
        await link._refresh_peers()
        rows = {d["deviceId"]: d for d in link.network_snapshot()["devices"]}
        assert rows[ORG_PEER.device_id]["canTrust"] is False
    finally:
        await link.stop()


# ---- pairing ------------------------------------------------------------------


def _frame(peer: Peer, kind: str, msg_key: str, **fields) -> dict:
    text = device_pairing.envelope(kind, **fields)
    return {
        "msgKey": msg_key,
        "text": text,
        "from": {"deviceId": peer.device_id, "memberId": ORG_MEMBER},
        "to": {"deviceId": device_identity.device_id(), "workspace": "", "paneName": ""},
        "sig": peer.sign(msg_key=msg_key, to_device=device_identity.device_id(),
                         kind="text", body=text),
    }


async def _pair(link, conn, peer: Peer = ORG_PEER, tag: str = "1") -> None:
    reply = await link.start_pairing(peer.device_id)
    assert reply["ok"] is True, reply
    await conn.push({"type": "messages.pending", "payload": _frame(
        peer, device_pairing.PAIR_RESPONSE, f"pair-resp-{tag}",
        nonce="bm9uY2U=", signKey=peer.sign_key, encKey=peer.enc_key)})
    await _until(lambda: (device_pairing.get(peer.device_id) or None) is not None
                 and bool(device_pairing.get(peer.device_id).their_key))
    assert (await link.confirm_pairing(peer.device_id, accept=True))["ok"] is True
    await conn.push({"type": "messages.pending", "payload": _frame(
        peer, device_pairing.PAIR_CONFIRM, f"pair-confirm-{tag}")})
    await _until(lambda: (trust_store.pin_for(peer.device_id) or {}).get("approved") is True)


async def test_pairing_an_org_machine_records_the_grant_and_stays_in_the_member_ring(broadcasts):
    server, link = await _link_with({"grants": [_grant()]})
    try:
        conn = server.opened[0]
        await _pair(link, conn)
        pin = trust_store.pin_for(ORG_PEER.device_id)
        assert pin["grantId"] == "g_1"
        assert pin["org"]["orgName"] == "北辰設計"
        assert pin["org"]["ownerName"] == "陳怡君"
        # Paired, yet not one of this account's own machines.
        assert link._own_device(pin) is False
        assert link.pairing_rows() == []
    finally:
        await link.stop()


async def test_the_pairing_card_names_the_organisation():
    server, link = await _link_with({"grants": [_grant()]})
    try:
        assert (await link.start_pairing(ORG_PEER.device_id))["ok"] is True
        (row,) = link.pairing_rows()
        assert row["org"] == {"grantId": "g_1", "orgName": "北辰設計", "ownerName": "陳怡君"}
    finally:
        await link.stop()


async def test_personal_pairing_rows_carry_no_org_field():
    server, link = await _link_with({"grants": [_grant()]})
    try:
        link._online_devices = {PEER.device_id}
        trust_store.forget_device(PEER.device_id)
        assert (await link.start_pairing(PEER.device_id))["ok"] is True
        (row,) = link.pairing_rows()
        assert "org" not in row
    finally:
        await link.stop()


async def test_an_org_pin_messages_through_the_pane_policy(broadcasts):
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server, link = await _link_with(
        {"grants": [_grant()]}, policy={"version": 1, "default": "deny", "rules": []}
    )
    try:
        _pin_org()
        conn = server.opened[0]
        await conn.push({"type": "messages.pending",
                         "payload": _pending("pa:org:1", member_id=ORG_MEMBER, peer=ORG_PEER)})
        await _until(lambda: bool(conn.acks))
        assert conn.acks[0]["reason"] == "policy-denied"
        (knock,) = link.access_requests()
        assert knock["grantId"] == "g_1"  # remembered on the knock itself
        assert knock["org"]["orgName"] == "北辰設計"
        assert knock["org"]["grantId"] == "g_1"
    finally:
        await link.stop()


# ---- revocation ---------------------------------------------------------------


async def test_grant_revoked_downgrades_that_grant_only_and_refuses_as_not_paired(broadcasts):
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    state = {"grants": [_grant()]}
    server, link = await _link_with(state)
    try:
        _pin_org()
        _pin_org(OTHER_ORG_PEER, grant_id="g_other")
        conn = server.opened[0]
        state["grants"] = [_grant("g_other", OTHER_ORG_PEER)]
        await conn.push({"type": "org.grant.revoked", "payload": {
            "grantId": "g_1", "scope": "grant", "deviceIds": [],
            "reason": "link-revoked", "at": 1763870000000}})
        await _until(lambda: trust_store.pin_for(ORG_PEER.device_id)["approved"] is False)

        pin = trust_store.pin_for(ORG_PEER.device_id)
        assert pin["orgRevoked"] == {"reason": "link-revoked", "at": 1763870000000}
        assert pin["signKey"] == ORG_PEER.sign_key  # kept, not deleted
        assert trust_store.pin_for(OTHER_ORG_PEER.device_id)["approved"] is True
        # This account's own pin is never touched by a grant.
        own = trust_store.pin_for(PEER.device_id)
        assert "grantId" not in own and "orgRevoked" not in own

        await conn.push({"type": "messages.pending",
                         "payload": _pending("pa:org:2", member_id=ORG_MEMBER, peer=ORG_PEER)})
        await _until(lambda: bool(conn.acks))
        assert conn.acks[0] == {"msgKey": "pa:org:2", "state": "rejected", "reason": "not-paired"}

        await _until(lambda: bool(link.network_snapshot()["org"]["revokedGrants"]))
        (gone,) = link.network_snapshot()["org"]["revokedGrants"]
        assert gone["grantId"] == "g_1"
        assert gone["peers"][0]["trustState"] == "revoked"
        # The personal pending list is not where this is answered.
        assert ORG_PEER.device_id not in {r["deviceId"] for r in trust_store.unapproved_devices()}
    finally:
        await link.stop()


async def test_devices_scope_downgrades_only_the_listed_devices():
    server, link = await _link_with({"grants": [_grant("g_1", ORG_PEER, OTHER_ORG_PEER)]})
    try:
        _pin_org(ORG_PEER)
        _pin_org(OTHER_ORG_PEER)
        await link._on_grant_revoked({"grantId": "g_1", "scope": "devices",
                                      "deviceIds": [OTHER_ORG_PEER.device_id],
                                      "reason": "member-removed", "at": 5})
        assert trust_store.pin_for(ORG_PEER.device_id)["approved"] is True
        assert trust_store.pin_for(OTHER_ORG_PEER.device_id)["orgRevoked"]["reason"] == "member-removed"
    finally:
        await link.stop()


async def test_devices_scope_naming_this_device_downgrades_every_pin_of_the_grant():
    server, link = await _link_with({"grants": [_grant("g_1", ORG_PEER, OTHER_ORG_PEER)]})
    try:
        _pin_org(ORG_PEER)
        _pin_org(OTHER_ORG_PEER)
        await link._on_grant_revoked({"grantId": "g_1", "scope": "devices",
                                      "deviceIds": [device_identity.device_id()],
                                      "reason": "exposure-withdrawn", "at": 5})
        assert trust_store.pin_for(ORG_PEER.device_id)["approved"] is False
        assert trust_store.pin_for(OTHER_ORG_PEER.device_id)["approved"] is False
    finally:
        await link.stop()


async def test_reconnect_reconciles_pins_whose_grant_is_gone():
    _pin_org(ORG_PEER, grant_id="g_gone")
    _pin_org(OTHER_ORG_PEER, grant_id="g_1")
    server, link = await _link_with({"grants": [_grant("g_1", OTHER_ORG_PEER)]})
    try:
        await _until(lambda: trust_store.pin_for(ORG_PEER.device_id)["approved"] is False)
        assert trust_store.pin_for(ORG_PEER.device_id)["orgRevoked"]["reason"] == org_peers.REASON_LAPSED
        assert trust_store.pin_for(OTHER_ORG_PEER.device_id)["approved"] is True
        assert trust_store.pin_for(PEER.device_id).get("grantId") is None
    finally:
        await link.stop()


async def test_peers_changed_rereads_the_list():
    state = {"grants": [_grant()]}
    server, link = await _link_with(state)
    try:
        before = state["calls"]
        state["grants"] = []
        await server.opened[0].push({"type": "peers.changed",
                                     "payload": {"grantId": "g_1", "version": 2}})
        await _until(lambda: state["calls"] > before and not link._org_grants)
    finally:
        await link.stop()


async def test_a_revoked_org_machine_can_pair_again_only_through_a_live_grant():
    state = {"grants": []}
    server, link = await _link_with(state)
    try:
        _pin_org()
        trust_store.revoke_org_pins("g_1", device_ids=None, local_device_id="",
                                    reason="link-revoked", at=1)
        reply = await link.start_pairing(ORG_PEER.device_id)
        assert reply["error"]["code"] == "ORG_LINK_REVOKED"

        state["grants"] = [_grant("g_new")]
        await link._refresh_peers()
        await _pair(link, server.opened[0], tag="again")
        pin = trust_store.pin_for(ORG_PEER.device_id)
        assert pin["grantId"] == "g_new"
        assert "orgRevoked" not in pin
    finally:
        await link.stop()


# ---- policy -------------------------------------------------------------------


def test_a_grant_scoped_rule_only_applies_through_its_grant():
    rule = {"from": {"memberId": ORG_MEMBER, "deviceId": ORG_PEER.device_id},
            "to": {"workspace": "proj-a", "paneName": "reviewer"},
            "action": "allow", "grantId": "g_1"}
    policy = {"version": 1, "default": "deny", "rules": [rule]}
    assert pane_policy.validate(policy) == ""
    request = dict(member_id=ORG_MEMBER, device_id=ORG_PEER.device_id,
                   workspace="proj-a", pane_name="reviewer")
    assert pane_policy.is_allowed(pane_policy.for_grant(policy, "g_1"), **request) is True
    assert pane_policy.is_allowed(pane_policy.for_grant(policy, "g_new"), **request) is False
    # A sender with no grant gets none of the grant-tagged rules…
    assert pane_policy.is_allowed(pane_policy.for_grant(policy, ""), **request) is False
    # …and a policy with no grant-tagged rules is passed through untouched.
    plain = {"version": 1, "default": "deny", "rules": [{k: v for k, v in rule.items() if k != "grantId"}]}
    assert pane_policy.for_grant(plain, "") is plain


def test_org_pairing_over_an_older_unapproved_pin_records_the_grant():
    trust_store.pin_device(ORG_PEER.device_id, sign_key=ORG_PEER.sign_key, member_id=ORG_MEMBER)
    _pin_org()
    pin = trust_store.pin_for(ORG_PEER.device_id)
    assert pin["approved"] is True
    assert pin["grantId"] == "g_1"


# ---- remote targets -----------------------------------------------------------


def test_remote_targets_name_the_organisation_and_owner():
    remote_roster.replace(
        [
            {**PEER.session_row()},
            {**ORG_PEER.session_row(sessionId="s-org"), "grantId": "g_1",
             "peerOrg": {"orgId": "org_b", "name": "北辰設計"}, "hostOwnerName": "陳怡君"},
        ],
        local_device_id="self",
    )
    rows = {row["address"].split("/")[0]: row for row in
            (pane.to_dict() for pane in remote_roster.list_panes())}
    assert rows[ORG_PEER.device_id]["org"] == "北辰設計"
    assert rows[ORG_PEER.device_id]["owner"] == "陳怡君"
    assert "org" not in rows[PEER.device_id] and "owner" not in rows[PEER.device_id]


def test_parse_drops_unaddressable_rows():
    grants = org_peers.parse({"grants": [
        {"grantId": "", "peers": []},
        {"grantId": "g", "peers": [{"deviceId": ""}, {"deviceId": "d", "online": "yes"}]},
        "junk",
    ]})
    assert [g["grantId"] for g in grants] == ["g"]
    assert grants[0]["peers"][0]["online"] is False
    assert org_peers.parse(None) == []


async def test_a_grant_revoked_mid_exchange_ends_the_pairing_without_a_pin():
    """Began through a grant, finished after it ended: no pin at all, rather
    than one outside every grant."""
    state = {"grants": [_grant()]}
    server, link = await _link_with(state)
    try:
        conn = server.opened[0]
        assert (await link.start_pairing(ORG_PEER.device_id))["ok"] is True
        await conn.push({"type": "messages.pending", "payload": _frame(
            ORG_PEER, device_pairing.PAIR_RESPONSE, "pair-resp-mid",
            nonce="bm9uY2U=", signKey=ORG_PEER.sign_key, encKey=ORG_PEER.enc_key)})
        await _until(lambda: bool((device_pairing.get(ORG_PEER.device_id) or None)
                                  and device_pairing.get(ORG_PEER.device_id).their_key))
        state["grants"] = []
        await link._refresh_peers()
        assert (await link.confirm_pairing(ORG_PEER.device_id, accept=True))["ok"] is True
        await conn.push({"type": "messages.pending", "payload": _frame(
            ORG_PEER, device_pairing.PAIR_CONFIRM, "pair-confirm-mid")})
        await _until(lambda: device_pairing.get(ORG_PEER.device_id) is None)
        assert trust_store.pin_for(ORG_PEER.device_id) is None
    finally:
        await link.stop()


async def test_a_refused_second_request_does_not_rewrite_the_grant_of_the_running_exchange():
    state = {"grants": [_grant()]}
    server, link = await _link_with(state)
    try:
        conn = server.opened[0]
        assert (await link.start_pairing(ORG_PEER.device_id))["ok"] is True
        assert link._pairing_grants[ORG_PEER.device_id] == "g_1"
        state["grants"] = []
        await link._refresh_peers()
        await conn.push({"type": "messages.pending", "payload": _frame(
            ORG_PEER, device_pairing.PAIR_REQUEST, "pair-req-2",
            nonce="bm9uY2U=", signKey=ORG_PEER.sign_key, encKey=ORG_PEER.enc_key)})
        await _until(lambda: any(a.get("msgKey") == "pair-req-2" for a in conn.acks))
        assert link._pairing_grants[ORG_PEER.device_id] == "g_1"
    finally:
        await link.stop()


async def test_confirms_on_either_side_of_a_revocation_still_end_without_a_pin():
    """They confirm first (nothing completes), the grant is revoked, then this
    side confirms: the second, completing call must still see the check."""
    state = {"grants": [_grant()]}
    server, link = await _link_with(state)
    try:
        conn = server.opened[0]
        assert (await link.start_pairing(ORG_PEER.device_id))["ok"] is True
        await conn.push({"type": "messages.pending", "payload": _frame(
            ORG_PEER, device_pairing.PAIR_RESPONSE, "pair-resp-x",
            nonce="bm9uY2U=", signKey=ORG_PEER.sign_key, encKey=ORG_PEER.enc_key)})
        await _until(lambda: bool((device_pairing.get(ORG_PEER.device_id) or None)
                                  and device_pairing.get(ORG_PEER.device_id).their_key))
        await conn.push({"type": "messages.pending", "payload": _frame(
            ORG_PEER, device_pairing.PAIR_CONFIRM, "pair-confirm-x")})
        await _until(lambda: any(a.get("msgKey") == "pair-confirm-x" for a in conn.acks))
        assert device_pairing.get(ORG_PEER.device_id) is not None
        state["grants"] = []
        await link._on_grant_revoked({"grantId": "g_1", "scope": "grant", "reason": "link-revoked", "at": 1})
        await link.confirm_pairing(ORG_PEER.device_id, accept=True)
        assert trust_store.pin_for(ORG_PEER.device_id) is None
        assert ORG_PEER.device_id not in link._pairing_grants
    finally:
        await link.stop()


async def test_a_revocation_leaves_the_grant_unusable_even_if_the_reread_fails():
    state = {"grants": [_grant("g_1", ORG_PEER, OTHER_ORG_PEER)]}
    server, link = await _link_with(state)
    try:
        state["error"] = "INTERNAL"  # the follow-up peers.list fails
        await link._on_grant_revoked({"grantId": "g_1", "scope": "devices",
                                      "deviceIds": [OTHER_ORG_PEER.device_id], "reason": "member-removed", "at": 1})
        assert link._org_peer(OTHER_ORG_PEER.device_id) is None
        assert link._org_peer(ORG_PEER.device_id) is not None
        await link._on_grant_revoked({"grantId": "g_1", "scope": "grant", "reason": "link-revoked", "at": 2})
        assert link._org_peer(ORG_PEER.device_id) is None
        assert (await link.start_pairing(ORG_PEER.device_id))["ok"] is False
    finally:
        await link.stop()


async def test_a_dropped_connection_forgets_the_grants():
    server, link = await _link_with({"grants": [_grant()]})
    try:
        assert link._org_grants
        await server.opened[0].close()
        await _until(lambda: not link._org_grants)
        assert link._org_status in (org_peers.STATUS_UNKNOWN, org_peers.STATUS_OK)
    finally:
        await link.stop()


async def test_a_knock_left_under_a_personal_pairing_cannot_become_an_unscoped_rule(broadcasts):
    """Personal pairing knocks → unpaired → paired again through a grant →
    knocks again: the knock carries the grant, so a locked trust record
    refuses to approve it instead of writing a rule with no grantId."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server, link = await _link_with(
        {"grants": [_grant()]}, policy={"version": 1, "default": "deny", "rules": []}
    )
    try:
        conn = server.opened[0]
        trust_store.pin_paired_device(ORG_PEER.device_id, sign_key=ORG_PEER.sign_key,
                                      enc_key=ORG_PEER.enc_key, member_id=ORG_MEMBER)
        await conn.push({"type": "messages.pending",
                         "payload": _pending("pa:k:1", member_id=ORG_MEMBER, peer=ORG_PEER)})
        await _until(lambda: bool(link.access_requests()))
        assert "grantId" not in link.access_requests()[0]

        # They unpair: the knock made under that pairing goes with it.
        await conn.push({"type": "messages.pending", "payload": _frame(
            ORG_PEER, device_pairing.PAIR_REVOKED, "pair-revoked-k")})
        await _until(lambda: trust_store.pin_for(ORG_PEER.device_id) is None)
        assert link.access_requests() == []

        # Paired again, through the grant; a knock now remembers it.
        await _pair(link, conn, tag="k")
        assert trust_store.pin_for(ORG_PEER.device_id)["grantId"] == "g_1"
        await conn.push({"type": "messages.pending",
                         "payload": _pending("pa:k:2", member_id=ORG_MEMBER, peer=ORG_PEER)})
        await _until(lambda: bool(link.access_requests()))
        (knock,) = link.access_requests()
        assert knock["grantId"] == "g_1"
    finally:
        await link.stop()


def test_a_knock_row_says_how_its_sender_is_paired_now():
    from agent_team_backend import device_trust

    requests = device_trust.AccessRequests()
    common = dict(member_id="m", device_id="d", device_name="n", workspace="w", pane_name="p")
    assert "grantId" not in requests.record(**common)
    assert requests.record(**common, grant_id="g_1")["grantId"] == "g_1"
    assert "grantId" not in requests.record(**common)


async def test_an_org_pin_never_reaches_the_own_device_ring_whatever_the_frame_says(broadcasts):
    """The relay writes the frame's member id. Pairing through a grant pins the
    grant's member id instead, and a grant-bearing pin is never 'ours' even if
    it carries this account's member id."""
    server, link = await _link_with({"grants": [_grant()]})
    try:
        conn = server.opened[0]
        reply = await link.start_pairing(ORG_PEER.device_id)
        assert reply["ok"] is True
        await conn.push({"type": "messages.pending", "payload": {**_frame(
            ORG_PEER, device_pairing.PAIR_RESPONSE, "pair-resp-ring",
            nonce="bm9uY2U=", signKey=ORG_PEER.sign_key, encKey=ORG_PEER.enc_key)}})
        await _until(lambda: bool((device_pairing.get(ORG_PEER.device_id) or None)
                                  and device_pairing.get(ORG_PEER.device_id).their_key))
        assert (await link.confirm_pairing(ORG_PEER.device_id, accept=True))["ok"] is True
        confirm = _frame(ORG_PEER, device_pairing.PAIR_CONFIRM, "pair-confirm-ring")
        confirm["from"]["memberId"] = "m1"  # this account's own member id, as a relay could write it
        await conn.push({"type": "messages.pending", "payload": confirm})
        await _until(lambda: (trust_store.pin_for(ORG_PEER.device_id) or {}).get("approved") is True)
        pin = trust_store.pin_for(ORG_PEER.device_id)
        assert pin["memberId"] == ORG_MEMBER
        assert link._own_device(pin) is False
        assert link._own_device({**pin, "memberId": "m1"}) is False
    finally:
        await link.stop()


def test_a_grant_pin_is_not_approved_again_without_a_grant():
    _pin_org()
    trust_store.revoke_org_pins("g_1", device_ids=None, local_device_id="", reason="link-revoked", at=1)
    changed = trust_store.pin_paired_device(
        ORG_PEER.device_id, sign_key=ORG_PEER.sign_key, enc_key=ORG_PEER.enc_key, member_id=ORG_MEMBER,
    )
    assert changed is False
    pin = trust_store.pin_for(ORG_PEER.device_id)
    assert pin["approved"] is False
    assert pin["orgRevoked"]["reason"] == "link-revoked"


async def test_not_found_downgrades_grant_pins_but_an_older_server_does_not():
    _pin_org()
    server, link = await _link_with({"error": "NOT_FOUND"})
    try:
        await _until(lambda: trust_store.pin_for(ORG_PEER.device_id)["approved"] is False)
        assert trust_store.pin_for(ORG_PEER.device_id)["orgRevoked"]["reason"] == org_peers.REASON_LAPSED
        assert "grantId" not in trust_store.pin_for(PEER.device_id)
    finally:
        await link.stop()


async def test_an_older_server_leaves_grant_pins_alone():
    _pin_org()
    server, link = await _link_with({"error": "UNKNOWN_TYPE"})
    try:
        assert link._org_status == org_peers.STATUS_UNSUPPORTED
        assert trust_store.pin_for(ORG_PEER.device_id)["approved"] is True
    finally:
        await link.stop()


async def test_an_org_sender_is_judged_by_its_pinned_member_not_the_frame(broadcasts):
    """A frame naming this account's member id must not match the own-devices
    rule for an organisation machine; it is refused outright."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    own_devices = {"version": 1, "default": "deny", "rules": [
        {"from": {"memberId": "m1", "deviceId": "*"}, "to": {"workspace": "*", "paneName": "*"}, "action": "allow"}]}
    server, link = await _link_with({"grants": [_grant()]}, policy=own_devices)
    try:
        _pin_org()
        conn = server.opened[0]
        await conn.push({"type": "messages.pending",
                         "payload": _pending("pa:own:1", member_id="m1", peer=ORG_PEER)})
        await _until(lambda: bool(conn.acks))
        assert conn.acks[0]["state"] == "rejected"
        assert broadcasts == []
        # With its real member id it is held to the rules, which deny it.
        await conn.push({"type": "messages.pending",
                         "payload": _pending("pa:own:2", member_id=ORG_MEMBER, peer=ORG_PEER)})
        await _until(lambda: len(conn.acks) == 2)
        assert conn.acks[1]["reason"] == "policy-denied"
    finally:
        await link.stop()


async def test_a_revocation_during_authentication_is_seen_before_the_rules(broadcasts, monkeypatch):
    """The pin is read again after the awaits, so a revocation that lands in
    between refuses the message instead of letting the stale approval through."""
    agent_messaging.register("p1", "reviewer", "/tmp/proj-a", agent_key="claude")
    server, link = await _link_with({"grants": [_grant()]})
    try:
        _pin_org()
        original = link._ensure_policy

        async def revoke_meanwhile():
            trust_store.revoke_org_pins("g_1", device_ids=None, local_device_id="",
                                        reason="link-revoked", at=1)
            await original()

        monkeypatch.setattr(link, "_ensure_policy", revoke_meanwhile)
        conn = server.opened[0]
        await conn.push({"type": "messages.pending",
                         "payload": _pending("pa:race:1", member_id=ORG_MEMBER, peer=ORG_PEER)})
        await _until(lambda: bool(conn.acks))
        assert conn.acks[0] == {"msgKey": "pa:race:1", "state": "rejected", "reason": "not-paired"}
        assert broadcasts == []
    finally:
        await link.stop()
