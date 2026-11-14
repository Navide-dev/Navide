"""``host.cloud.identity`` / ``host.cloud.registry_assertion``: the Marketplace
developer sign-in reuses the Navide Cloud account (0.2.43 #2b).

The main process asks over its Host session for a short-lived assertion bound
to its own PKCE challenge; the server link carries ``auth.assertion.issue`` and
hands back only the assertion and member id, never the server token.
"""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import app, server_link, ws_handlers

CHALLENGE = "c" * 43


class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session(*, host: bool) -> Any:
    session = app.Session(_FakeWebSocket())  # type: ignore[arg-type]
    session.host_authenticated = host
    return session


def _sent(session: Any) -> list[dict[str, Any]]:
    for value in vars(session).values():
        if isinstance(value, _FakeWebSocket):
            return value.sent
    raise AssertionError("no fake websocket on the session")


@pytest.mark.asyncio
async def test_refused_without_host_session(monkeypatch: pytest.MonkeyPatch) -> None:
    called = False

    async def fake(**_kwargs: Any) -> dict[str, Any]:
        nonlocal called
        called = True
        return {"ok": True}

    monkeypatch.setattr(server_link, "registry_assertion", fake)
    session = _session(host=False)
    await ws_handlers.host_cloud_registry_assertion(
        session, "1", "host.cloud.registry_assertion", {"scope": "account", "namespace": None, "challenge": CHALLENGE}
    )
    assert _sent(session)[-1]["error"]["code"] == "UNAUTHORIZED"
    assert not called
    await ws_handlers.host_cloud_identity(session, "2", "host.cloud.identity", {})
    assert _sent(session)[-1]["error"]["code"] == "UNAUTHORIZED"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        {"scope": "account", "namespace": None},
        {"scope": "account", "namespace": "acme", "challenge": CHALLENGE},
        {"scope": "publish", "namespace": None, "challenge": CHALLENGE},
        {"scope": "publish", "namespace": "Bad NS", "challenge": CHALLENGE},
        {"scope": "admin", "namespace": None, "challenge": CHALLENGE},
        {"scope": "account", "namespace": None, "challenge": "short"},
        {"scope": "account", "namespace": None, "challenge": CHALLENGE, "extra": 1},
    ],
)
async def test_malformed_requests_never_reach_the_server(monkeypatch: pytest.MonkeyPatch, payload: dict) -> None:
    async def fake(**_kwargs: Any) -> dict[str, Any]:
        raise AssertionError("must not be called")

    monkeypatch.setattr(server_link, "registry_assertion", fake)
    session = _session(host=True)
    await ws_handlers.host_cloud_registry_assertion(session, "1", "host.cloud.registry_assertion", payload)
    assert _sent(session)[-1]["error"]["code"] == "BAD_REQUEST"


@pytest.mark.asyncio
async def test_returns_only_assertion_and_member(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}
    assertion = "nvsa1." + "k" * 4 + ".payload.sig"

    async def fake(**kwargs: Any) -> dict[str, Any]:
        seen.update(kwargs)
        return {"ok": True, "payload": {"assertion": assertion, "memberId": "m_1", "expiresAt": 1, "other": "x"}}

    monkeypatch.setattr(server_link, "registry_assertion", fake)
    session = _session(host=True)
    await ws_handlers.host_cloud_registry_assertion(
        session, "1", "host.cloud.registry_assertion", {"scope": "publish", "namespace": "acme", "challenge": CHALLENGE}
    )
    reply = _sent(session)[-1]
    assert reply["ok"] is True
    assert reply["payload"] == {"assertion": assertion, "memberId": "m_1"}
    assert seen == {"scope": "publish", "namespace": "acme", "challenge": CHALLENGE}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("reply", "code"),
    [
        (None, "CLOUD_NOT_CONFIGURED"),
        ({"ok": False, "error": {"code": "AUTH_REQUIRED", "message": "sign in"}}, "AUTH_REQUIRED"),
        ({"ok": False, "error": {"code": "ASSERTION_DISABLED", "message": "off"}}, "ASSERTION_DISABLED"),
        ({"ok": False, "error": {"code": "LINK_OFFLINE", "message": "down"}}, "LINK_OFFLINE"),
        ({"ok": True, "payload": {}}, "ASSERTION_UNAVAILABLE"),
    ],
)
async def test_server_errors_pass_through(monkeypatch: pytest.MonkeyPatch, reply: Any, code: str) -> None:
    async def fake(**_kwargs: Any) -> Any:
        return reply

    monkeypatch.setattr(server_link, "registry_assertion", fake)
    session = _session(host=True)
    await ws_handlers.host_cloud_registry_assertion(
        session, "1", "host.cloud.registry_assertion", {"scope": "account", "namespace": None, "challenge": CHALLENGE}
    )
    assert _sent(session)[-1]["error"]["code"] == code


@pytest.mark.asyncio
async def test_link_sends_issue_request_without_the_server_token(monkeypatch: pytest.MonkeyPatch) -> None:
    frames: list[tuple[str, dict[str, Any]]] = []

    class _FakeLink:
        async def _carry(self, msg_type: str, payload: dict[str, Any]) -> dict[str, Any]:
            frames.append((msg_type, payload))
            return {"ok": True, "payload": {"assertion": "a", "memberId": "m"}}

    monkeypatch.setattr(server_link, "_link", _FakeLink())
    reply = await server_link.registry_assertion(scope="account", namespace=None, challenge=CHALLENGE)
    assert reply == {"ok": True, "payload": {"assertion": "a", "memberId": "m"}}
    assert frames == [
        ("auth.assertion.issue", {"aud": "registry", "scope": "account", "namespace": None, "challenge": CHALLENGE})
    ]


@pytest.mark.asyncio
async def test_no_server_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(server_link, "_link", None)
    assert await server_link.registry_assertion(scope="account", namespace=None, challenge=CHALLENGE) is None
    assert server_link.cloud_identity() is None


@pytest.mark.asyncio
async def test_identity_only_while_authenticated(monkeypatch: pytest.MonkeyPatch) -> None:
    class _FakeLink:
        _ws = object()
        _authenticated = True
        member_id = "m_1"
        display_name = "Neo"

    link = _FakeLink()
    monkeypatch.setattr(server_link, "_link", link)
    session = _session(host=True)
    await ws_handlers.host_cloud_identity(session, "1", "host.cloud.identity", {})
    assert _sent(session)[-1]["payload"] == {"identity": {"memberId": "m_1", "name": "Neo"}}
    link._authenticated = False
    await ws_handlers.host_cloud_identity(session, "2", "host.cloud.identity", {})
    assert _sent(session)[-1]["payload"] == {"identity": None}
