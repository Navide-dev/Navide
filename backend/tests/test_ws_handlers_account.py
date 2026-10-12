"""p2p.account.*: signing in to a Navide-Server account from the Settings pane.

The transport (a throwaway connection to an unauthenticated endpoint) is
server_link's; these tests own the handler layer — what is required before
anything is sent, which failures keep the server's own code and which collapse
into a link error, and what is allowed to reach the vault and the settings.

The distinction these tests exist to protect: a *credential* failure tells the
user to retype something, a *link* failure tells them the server is unreachable.
Reporting one as the other sends them to change a password that was correct.
"""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import agent_messaging, app, server_link, ws_handlers


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


async def _call(msg_type: str, payload: dict) -> dict:
    session = _session()
    await app.handle_message(session, {"id": "x1", "type": msg_type, "payload": payload})
    return session.websocket.sent[-1]  # type: ignore[attr-defined]


class FakeSettings:
    """Enough of ui_settings_store for these handlers: set() returns the delta."""

    def __init__(self) -> None:
        self.values: dict[str, Any] = {}

    def get(self) -> dict[str, Any]:
        return dict(self.values)

    def set(self, delta: dict[str, Any]) -> dict[str, Any]:
        applied: dict[str, Any] = {}
        for key, value in delta.items():
            if value is None:
                self.values.pop(key, None)
            else:
                self.values[key] = value
            applied[key] = value
        return applied


# The shape auth.login and auth.register actually answer with. Kept in step
# with the server by hand, which is the weak point of every test in this file:
# the fixture *is* the contract here, so a field invented in it is asserted
# against itself. `tenantId`, `tenantName` and `role` used to be in this dict
# and were asserted below; the identity convergence removed all three from the
# server and nothing here went red, because nothing here talks to a server.
GOOD_ACCOUNT = {
    "memberId": "m-1",
    "displayName": "neil",
    "email": "neil@example.com",
    "token": "tok-long-lived",
    # Soft gate: a fresh account is unverified and still fully usable.
    "emailVerified": False,
    "verificationSent": True,
}


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch):
    """Wire the handlers to fakes and record what each layer was asked to do."""
    settings = FakeSettings()
    tokens: list[str | None] = []
    requests: list[tuple[str, str, dict]] = []
    reconfigured: list[int] = []

    async def fake_account_request(url: str, msg_type: str, payload: dict) -> dict:
        requests.append((url, msg_type, payload))
        return dict(GOOD_ACCOUNT)

    def fake_set_token(token: str | None) -> None:
        tokens.append(token)

    async def fake_reconfigure() -> None:
        reconfigured.append(1)

    async def fake_status() -> dict:
        return {"state": "connected", "serverUrl": "ws://s/ws", "hasToken": bool(tokens and tokens[-1])}

    async def fake_broadcast(_event: Any) -> None:
        return None

    monkeypatch.setenv(server_link.SERVER_URL_ENV, "ws://s/ws")
    monkeypatch.setattr(app, "ui_settings_store", settings)
    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    monkeypatch.setattr(server_link, "account_request", fake_account_request)
    monkeypatch.setattr(server_link, "set_access_token", fake_set_token)
    monkeypatch.setattr(server_link, "reconfigure", fake_reconfigure)
    monkeypatch.setattr(server_link, "status", fake_status)
    return {
        "settings": settings,
        "tokens": tokens,
        "requests": requests,
        "reconfigured": reconfigured,
    }


# The address is the build's, so it is no longer part of the call.
LOGIN = {"email": " neil@example.com ", "password": "passw0rd!"}


# ---- happy path -------------------------------------------------------------


async def test_login_stores_token_and_reconnects(env) -> None:
    resp = await _call("p2p.account.login", dict(LOGIN))
    assert resp["ok"] is True
    assert env["tokens"] == ["tok-long-lived"]
    assert env["reconfigured"] == [1]
    # The address came from the build, not from the caller.
    url, verb, sent = env["requests"][0]
    assert (url, verb) == ("ws://s/ws", "auth.login")
    assert sent["email"] == "neil@example.com"


async def test_login_never_echoes_the_password(env) -> None:
    resp = await _call("p2p.account.login", dict(LOGIN))
    assert "passw0rd!" not in repr(resp)


async def test_login_persists_the_email_but_not_the_token(env) -> None:
    await _call("p2p.account.login", dict(LOGIN))
    stored = env["settings"].get()
    assert stored[server_link.ACCOUNT_EMAIL_SETTING] == "neil@example.com"
    # The address is built in, so nothing user-entered is kept for it.
    assert server_link.SERVER_URL_SETTING not in stored
    # The long-lived credential belongs in the vault, never in plain settings.
    assert "tok-long-lived" not in repr(stored)


async def test_login_clears_a_stale_user_entered_address(env) -> None:
    """An install upgrading from the configurable era still carries one. Leaving
    it would show a value that looks like it is in effect but is never read."""
    env["settings"].set({server_link.SERVER_URL_SETTING: "ws://stale/ws"})
    await _call("p2p.account.login", dict(LOGIN))
    assert server_link.SERVER_URL_SETTING not in env["settings"].get()


async def test_register_forwards_a_trimmed_display_name(env) -> None:
    await _call("p2p.account.register", {**LOGIN, "displayName": " Neil "})
    _url, verb, sent = env["requests"][0]
    assert verb == "auth.register"
    assert sent["displayName"] == "Neil"


async def test_register_omits_a_blank_display_name(env) -> None:
    # Omitted rather than sent empty: the server derives one from the email when
    # the field is absent, and an empty string would win over that.
    await _call("p2p.account.register", {**LOGIN, "displayName": "   "})
    _url, _verb, sent = env["requests"][0]
    assert "displayName" not in sent


async def test_login_answers_with_status_and_account(env) -> None:
    resp = await _call("p2p.account.login", dict(LOGIN))
    assert resp["payload"]["status"]["state"] == "connected"
    assert resp["payload"]["account"]["displayName"] == "neil"
    assert resp["payload"]["account"]["email"] == "neil@example.com"


# ---- refusals before anything is sent ---------------------------------------


@pytest.mark.parametrize("missing", ["email", "password"])
async def test_required_fields(env, missing: str) -> None:
    payload = dict(LOGIN)
    payload[missing] = "   "
    resp = await _call("p2p.account.login", payload)
    assert resp["ok"] is False
    assert resp["error"]["code"] == "BAD_REQUEST"
    # Nothing may reach the server, the vault, or the settings on a bad request.
    assert env["requests"] == [] and env["tokens"] == [] and env["settings"].get() == {}


# ---- failures: credential vs link -------------------------------------------


async def test_server_refusal_keeps_its_own_code(env, monkeypatch: pytest.MonkeyPatch) -> None:
    async def taken(url: str, msg_type: str, payload: dict) -> dict:
        raise server_link.AccountError("EMAIL_TAKEN", "already registered")

    monkeypatch.setattr(server_link, "account_request", taken)
    resp = await _call("p2p.account.register", dict(LOGIN))
    assert resp["error"]["code"] == "EMAIL_TAKEN"
    # A refused registration must not disturb what is already configured.
    assert env["tokens"] == [] and env["settings"].get() == {}


async def test_unreachable_server_is_a_link_error_not_a_credential_error(
    env, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def down(url: str, msg_type: str, payload: dict) -> dict:
        raise ConnectionError("connection refused")

    monkeypatch.setattr(server_link, "account_request", down)
    resp = await _call("p2p.account.login", dict(LOGIN))
    # Not AUTH_REJECTED: the password was never judged, so telling the user it
    # was wrong sends them to change something that is already correct.
    assert resp["error"]["code"] == "LINK_OFFLINE"


async def test_reply_without_a_token_is_rejected(env, monkeypatch: pytest.MonkeyPatch) -> None:
    async def tokenless(url: str, msg_type: str, payload: dict) -> dict:
        return {"memberId": "m-1"}

    monkeypatch.setattr(server_link, "account_request", tokenless)
    resp = await _call("p2p.account.login", dict(LOGIN))
    assert resp["error"]["code"] == "SERVER_ERROR"
    assert env["tokens"] == []


async def test_vault_write_failure_is_reported(env, monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(token: str | None) -> None:
        raise RuntimeError("keychain locked")

    monkeypatch.setattr(server_link, "set_access_token", boom)
    resp = await _call("p2p.account.login", dict(LOGIN))
    assert resp["error"]["code"] == "P2P_TOKEN_WRITE_FAILED"
    assert env["reconfigured"] == []


# ---- logout -----------------------------------------------------------------


async def test_logout_clears_credential_and_email(env) -> None:
    await _call("p2p.account.login", dict(LOGIN))
    resp = await _call("p2p.account.logout", {})
    assert resp["ok"] is True
    assert env["tokens"][-1] is None
    assert server_link.ACCOUNT_EMAIL_SETTING not in env["settings"].get()


async def test_logout_revokes_on_the_server_before_erasing(env, monkeypatch) -> None:
    """The server is asked to revoke this device's token while the link can
    still carry it; the local token is erased afterwards, and also when the
    server could not be reached."""
    order: list[str] = []

    async def fake_logout_on_server() -> bool:
        order.append("server")
        return False  # offline: the local erase must still happen

    monkeypatch.setattr(server_link, "logout_on_server", fake_logout_on_server)
    await _call("p2p.account.login", dict(LOGIN))
    env["tokens"].clear()
    resp = await _call("p2p.account.logout", {})
    assert resp["ok"] is True
    assert order == ["server"]
    assert env["tokens"] == [None]


async def test_logout_forgets_the_member_pin_of_the_token(env, monkeypatch) -> None:
    """N1b: a sign-out drops the trust store's member pin for this token, so
    signing out and in again does not add an entry to the Keychain record."""
    from agent_team_backend import trust_store

    monkeypatch.setattr(server_link, "access_token", lambda: "tok-signed-in")
    trust_store.load()
    trust_store.adopt_own_member("ws://s/ws", "tok-signed-in", "m1")
    resp = await _call("p2p.account.logout", {})
    assert resp["ok"] is True
    assert trust_store.member_for_credential("ws://s/ws", "tok-signed-in") == ""


async def test_logout_leaves_the_address_reachable(env) -> None:
    """Signing out is "not right now", not "never again": the next sign-in must
    not need an address from the user. It is built in, so it always resolves."""
    await _call("p2p.account.login", dict(LOGIN))
    await _call("p2p.account.logout", {})
    assert server_link.server_url() == "ws://s/ws"


async def test_logout_reconnects_so_the_link_drops(env) -> None:
    await _call("p2p.account.login", dict(LOGIN))
    env["reconfigured"].clear()
    await _call("p2p.account.logout", {})
    assert env["reconfigured"] == [1]


# ---- e-mail verification ----------------------------------------------------
#
# The gate is soft: an unverified account signs in and works. What has to reach
# the renderer is the *flag* — the notice and its Resend button are the only
# things standing between a mistyped address and an account nobody can recover.


async def test_register_reports_the_unverified_flag_and_that_mail_went_out(env) -> None:
    resp = await _call("p2p.account.register", dict(LOGIN))
    account = resp["payload"]["account"]
    assert account["emailVerified"] is False
    assert account["verificationSent"] is True


async def test_account_reply_never_carries_a_verification_token(
    env, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A leaked verify token is a one-click flip of emailVerified. The server
    strips it; this side must not reintroduce it by copying the reply wholesale."""

    async def leaky(url: str, msg_type: str, payload: dict) -> dict:
        return {**GOOD_ACCOUNT, "verifyToken": "should-never-be-relayed"}

    monkeypatch.setattr(server_link, "account_request", leaky)
    resp = await _call("p2p.account.register", dict(LOGIN))
    assert "should-never-be-relayed" not in repr(resp)
    assert "verifyToken" not in resp["payload"]["account"]


async def test_resend_forwards_and_reports_the_flag(env, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[int] = []

    async def fake_resend() -> dict:
        calls.append(1)
        return {"ok": True, "payload": {"emailVerified": False, "verificationSent": True}}

    monkeypatch.setattr(server_link, "resend_verification", fake_resend)
    resp = await _call("p2p.account.resend_verification", {})
    assert resp["ok"] is True and calls == [1]
    assert resp["payload"]["emailVerified"] is False
    assert resp["payload"]["verificationSent"] is True
    # The refreshed link status rides along so the modal need not poll for it.
    assert resp["payload"]["status"]["state"] == "connected"


async def test_resend_keeps_the_servers_own_code(env, monkeypatch: pytest.MonkeyPatch) -> None:
    """RATE_LIMITED is an answer to show ("you just asked"), not one to retry.
    Collapsing it into a generic failure would hide the one actionable part."""

    async def limited() -> dict:
        return {"ok": False, "error": {"code": "RATE_LIMITED", "message": "wait 42s"}}

    monkeypatch.setattr(server_link, "resend_verification", limited)
    resp = await _call("p2p.account.resend_verification", {})
    assert resp["ok"] is False
    assert resp["error"]["code"] == "RATE_LIMITED"
    assert resp["error"]["message"] == "wait 42s"


async def test_resend_without_a_server_is_not_configured(
    env, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def none() -> None:
        return None

    monkeypatch.setattr(server_link, "resend_verification", none)
    resp = await _call("p2p.account.resend_verification", {})
    assert resp["error"]["code"] == "P2P_NOT_CONFIGURED"


async def test_resend_offline_link_is_a_link_error(env, monkeypatch: pytest.MonkeyPatch) -> None:
    async def offline() -> dict:
        return {"ok": False, "error": {"code": server_link.LINK_OFFLINE, "message": "down"}}

    monkeypatch.setattr(server_link, "resend_verification", offline)
    resp = await _call("p2p.account.resend_verification", {})
    assert resp["error"]["code"] == server_link.LINK_OFFLINE


def test_link_status_reports_the_verification_flag() -> None:
    """The renderer decides whether to nag from this one field, so it has to be
    present in both shapes — including the one with no link at all."""
    import asyncio

    unconfigured = asyncio.run(server_link.status())
    assert unconfigured["emailVerified"] is False


def test_handlers_are_registered() -> None:
    for name in (
        "p2p.account.register",
        "p2p.account.login",
        "p2p.account.logout",
        "p2p.account.resend_verification",
    ):
        assert ws_handlers.lookup(name) is not None


# ---- p2p.network.snapshot ---------------------------------------------------
#
# One read answers the whole "who is on my network" view: devices, and the CLI
# panes on each. The handler adds nothing but the not-configured refusal — the
# grouping is server_link's, and the tests below pin both halves.


async def test_network_snapshot_passes_the_whole_shape_through(
    env, monkeypatch: pytest.MonkeyPatch
) -> None:
    snapshot = {
        "state": "connected",
        "deviceId": "dev-1",
        "memberId": "m-1",
        "devices": [
            {
                "deviceId": "dev-1",
                "deviceName": "Neil's Mac",
                "isLocal": True,
                "online": True,
                "paneCount": 1,
                "panes": [{"sessionId": "s1", "agentKey": "claude", "status": "running"}],
            }
        ],
    }

    async def fake() -> dict:
        return snapshot

    monkeypatch.setattr(server_link, "network_snapshot", fake)
    resp = await _call("p2p.network.snapshot", {})
    assert resp["ok"] is True
    assert resp["payload"] == snapshot


async def test_network_snapshot_without_a_server_is_not_configured(
    env, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def none() -> None:
        return None

    monkeypatch.setattr(server_link, "network_snapshot", none)
    resp = await _call("p2p.network.snapshot", {})
    assert resp["ok"] is False
    assert resp["error"]["code"] == "P2P_NOT_CONFIGURED"


async def test_network_snapshot_answers_while_the_link_is_offline(
    env, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An unreachable link is not an error here: the machines it knew about did
    not stop existing, and refusing would read as "you have no network"."""

    async def stale() -> dict:
        return {"state": "unreachable", "deviceId": "dev-1", "devices": []}

    monkeypatch.setattr(server_link, "network_snapshot", stale)
    resp = await _call("p2p.network.snapshot", {})
    assert resp["ok"] is True
    assert resp["payload"]["state"] == "unreachable"


def _link_with(directory: list[dict], *, device_id: str = "dev-1") -> Any:
    link = server_link.ServerLink(device_name="Neil's Mac")
    link._device_id = device_id
    link._directory = directory
    link._authenticated = True
    return link


def test_network_snapshot_groups_panes_by_device() -> None:
    link = _link_with(
        [
            {
                "sessionId": "s1", "deviceId": "dev-1", "deviceName": "Neil's Mac",
                "paneId": "p1", "agentKey": "claude", "title": "backend",
                "workspace": "Agent-Team", "status": "running", "hostOnline": True,
            },
            {
                "sessionId": "s2", "deviceId": "dev-1", "deviceName": "Neil's Mac",
                "paneId": "p2", "agentKey": "codex", "title": "docs",
                "workspace": "Agent-Team", "status": "waiting", "hostOnline": True,
            },
            {
                "sessionId": "s3", "deviceId": "dev-2", "deviceName": "studio",
                "paneId": "p3", "agentKey": "claude", "title": "web",
                "workspace": "Navide-Server", "status": "exited", "hostOnline": False,
            },
        ]
    )
    snapshot = link.network_snapshot()
    assert [d["deviceId"] for d in snapshot["devices"]] == ["dev-1", "dev-2"]
    local, other = snapshot["devices"]
    assert local["isLocal"] is True and other["isLocal"] is False
    assert local["paneCount"] == 2 and other["paneCount"] == 1
    assert [p["title"] for p in local["panes"]] == ["backend", "docs"]
    assert other["panes"][0]["status"] == "exited"


def test_network_snapshot_carries_the_trust_state_in_the_same_read() -> None:
    """Who knocked and who is refused, alongside who is here.

    One read, not three: this view is polled while it is open, and separate
    round trips would let it draw a picture that is half one moment and half
    the next. Both lists are local state, so folding them in costs the server
    nothing.
    """
    agent_messaging._reset_for_test()
    try:
        link = _link_with([])
        link._policy = {
            "version": 1,
            "default": "deny",
            "rules": [],
            "blocked": [{"deviceId": "dev-gone", "reason": "stolen"}],
        }
        link._access_requests.record(
            member_id="m-them",
            device_id="dev-theirs",
            device_name="their box",
            workspace="proj",
            pane_name="reviewer",
        )
        snapshot = link.network_snapshot()
        assert [b["deviceId"] for b in snapshot["blocked"]] == ["dev-gone"]
        assert [r["paneName"] for r in snapshot["accessRequests"]] == ["reviewer"]
    finally:
        agent_messaging._reset_for_test()


def test_network_snapshot_calls_this_devices_unopened_panes_what_they_are() -> None:
    """A restored-but-never-opened pane is published as "disconnected" — the
    closest of the contract's four words — but this machine does not have to
    read that compromise back. It holds the realized flag itself, and the
    sidebar already calls the state "not opened", so the network view says the
    same thing. Showing it as running is what started this: the window reports
    every pane it cannot inject into as busy, placeholders included.
    """
    agent_messaging._reset_for_test()
    agent_messaging.register("p1", "scan", "/tmp/proj", agent_key="claude", realized=False)
    agent_messaging.register("p2", "docs", "/tmp/proj", agent_key="codex")
    try:
        link = _link_with(
            [
                {
                    "sessionId": "s1", "deviceId": "dev-1", "paneId": "p1",
                    "agentKey": "claude", "title": "scan", "workspace": "proj",
                    "status": "disconnected", "hostOnline": True,
                },
                {
                    "sessionId": "s2", "deviceId": "dev-1", "paneId": "p2",
                    "agentKey": "codex", "title": "docs", "workspace": "proj",
                    "status": "waiting", "hostOnline": True,
                },
                {
                    # Another machine's placeholder: the registry here knows
                    # nothing about it, so it keeps the word the server used.
                    "sessionId": "s3", "deviceId": "dev-2", "paneId": "p1",
                    "agentKey": "claude", "title": "theirs", "workspace": "proj",
                    "status": "disconnected", "hostOnline": True,
                },
            ]
        )
        local, other = link.network_snapshot()["devices"]
        by_title = {p["title"]: p["status"] for p in local["panes"]}
        assert by_title == {"scan": "not-opened", "docs": "waiting"}
        assert other["panes"][0]["status"] == "disconnected"
    finally:
        agent_messaging._reset_for_test()


def test_network_snapshot_keeps_this_devices_own_panes() -> None:
    """remote_roster drops them on purpose — addressing must use the live local
    roster — but the whole point of this view is the machine the user is on."""
    link = _link_with(
        [
            {
                "sessionId": "s1", "deviceId": "dev-1", "paneId": "p1",
                "agentKey": "claude", "title": "backend", "workspace": "Agent-Team",
                "status": "running", "hostOnline": True,
            }
        ]
    )
    assert link.network_snapshot()["devices"][0]["panes"][0]["title"] == "backend"


def test_network_snapshot_lists_this_device_with_nothing_running() -> None:
    """"No devices" and "one device, no panes" are different answers, and only
    the second one is true for a machine that has just signed in."""
    link = _link_with([])
    devices = link.network_snapshot()["devices"]
    assert len(devices) == 1
    assert devices[0]["isLocal"] is True
    assert devices[0]["deviceName"] == "Neil's Mac"
    assert devices[0]["paneCount"] == 0 and devices[0]["panes"] == []
    # A live link is the only evidence the server has that this machine is here.
    assert devices[0]["online"] is True


def test_network_snapshot_takes_remote_presence_from_presence_changed() -> None:
    """A device going offline changes no session row, so hostOnline alone would
    go on reporting a machine that has left as reachable."""
    row = {
        "sessionId": "s3", "deviceId": "dev-2", "deviceName": "studio", "paneId": "p3",
        "agentKey": "claude", "title": "web", "workspace": "w", "status": "running",
        "hostOnline": True,
    }
    link = _link_with([row])
    # Before any presence push, the per-session flag is all there is.
    assert link.network_snapshot()["devices"][1]["online"] is True
    link._on_presence_changed({"devices": [{"deviceId": "dev-1", "memberId": "m-1"}]})
    assert link.network_snapshot()["devices"][1]["online"] is False


def test_network_snapshot_reports_an_offline_link_rather_than_an_empty_network() -> None:
    link = _link_with([{
        "sessionId": "s3", "deviceId": "dev-2", "paneId": "p3", "agentKey": "claude",
        "title": "web", "workspace": "w", "status": "running", "hostOnline": True,
    }])
    link._authenticated = False
    link.last_error = "connection refused"
    snapshot = link.network_snapshot()
    assert snapshot["state"] == server_link.STATE_UNREACHABLE
    assert len(snapshot["devices"]) == 2
    # The local row cannot be online when the link carrying it is not.
    assert snapshot["devices"][0]["online"] is False


def test_network_snapshot_is_registered() -> None:
    assert ws_handlers.lookup("p2p.network.snapshot") is not None
