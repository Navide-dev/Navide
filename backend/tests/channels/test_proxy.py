"""channels.proxy: a PAC-configured system proxy, resolved by the Host for the channels."""

from __future__ import annotations

import asyncio
import logging
import secrets
from typing import Any

import httpx
import pytest

from agent_team_backend import app
from agent_team_backend.channels import proxy

# Windows' monotonic clock ticks coarsely, so a fallback expiry can read a
# hair past its TTL there (5.000000000000028 on CI) while still being the short one.
_CLOCK_SLACK_S = 0.05


@pytest.fixture(autouse=True)
def _no_fixed_proxy(monkeypatch: pytest.MonkeyPatch) -> None:
    proxy.clear_cache()
    monkeypatch.setattr(proxy.urllib.request, "getproxies", lambda: {})
    monkeypatch.setattr(proxy.urllib.request, "proxy_bypass", lambda host: False)


def _host_answers(monkeypatch: pytest.MonkeyPatch, rules: str | None, asked: list[str]) -> None:
    """A Host that answers every request with `rules` (None: never answers)."""

    async def unicast(event: dict[str, Any]) -> bool:
        payload = event["payload"]
        asked.append(payload["url"])
        if rules is not None:
            asyncio.get_running_loop().call_soon(
                proxy._pending.resolve, payload["request_id"], {"ok": True, "rules": rules})
        return True

    monkeypatch.setattr(proxy, "_unicast_host", unicast)


@pytest.mark.parametrize(("rules", "expected"), [
    ("DIRECT", None),
    ("PROXY proxy.corp:8080", "http://proxy.corp:8080"),
    ("PROXY proxy.corp:8080; DIRECT", "http://proxy.corp:8080"),
    ("HTTPS secure.corp:443", "https://secure.corp:443"),
    ("SOCKS5 s.corp:1080; PROXY p.corp:3128", "http://p.corp:3128"),
    ("SOCKS s.corp:1080; DIRECT", None),
])
def test_the_first_usable_pac_entry_decides(rules: str, expected: str | None) -> None:
    assert proxy.parse_pac_result(rules) == expected


@pytest.mark.parametrize("rules", ["", "SOCKS5 s.corp:1080", "PROXY", "PROXY user:pw@p.corp:1"])
def test_an_unusable_answer_leaves_the_library_default(rules: str) -> None:
    assert proxy.parse_pac_result(rules) is proxy.DEFAULT


async def test_a_pac_proxy_is_used_and_asked_with_the_http_form(monkeypatch: pytest.MonkeyPatch) -> None:
    asked: list[str] = []
    _host_answers(monkeypatch, "PROXY proxy.corp:8080; DIRECT", asked)
    assert await proxy.resolve("https://api.telegram.org/bot123/getUpdates") == "http://proxy.corp:8080"
    assert await proxy.ws_proxy("wss://gateway.discord.gg/?v=10") == "http://proxy.corp:8080"
    assert asked == ["https://api.telegram.org:443/", "https://gateway.discord.gg:443/"]


async def test_direct_connects_directly(monkeypatch: pytest.MonkeyPatch) -> None:
    _host_answers(monkeypatch, "DIRECT", [])
    assert await proxy.resolve("https://api.telegram.org/") is None
    assert await proxy.ws_proxy("wss://example.org/") is None


async def test_a_fixed_proxy_keeps_its_priority(monkeypatch: pytest.MonkeyPatch) -> None:
    asked: list[str] = []
    _host_answers(monkeypatch, "PROXY pac.corp:8080", asked)
    monkeypatch.setattr(proxy.urllib.request, "getproxies", lambda: {"https": "http://fixed:3128"})
    assert await proxy.resolve("https://api.telegram.org/") is proxy.DEFAULT
    assert await proxy.ws_proxy("wss://example.org/") is True
    assert asked == []


async def test_a_no_proxy_host_is_left_to_the_library(monkeypatch: pytest.MonkeyPatch) -> None:
    asked: list[str] = []
    _host_answers(monkeypatch, "PROXY pac.corp:8080", asked)
    monkeypatch.setattr(proxy.urllib.request, "proxy_bypass", lambda host: host == "chat.local")
    assert await proxy.resolve("https://chat.local/api") is proxy.DEFAULT
    assert asked == []


async def test_no_host_or_no_answer_falls_back_to_the_default(monkeypatch: pytest.MonkeyPatch) -> None:
    async def no_host(event: dict[str, Any]) -> bool:
        return False

    monkeypatch.setattr(proxy, "_unicast_host", no_host)
    assert await proxy.resolve("https://api.telegram.org/") is proxy.DEFAULT
    proxy.clear_cache()
    monkeypatch.setattr(proxy, "ANSWER_TIMEOUT_S", 0.05)
    _host_answers(monkeypatch, None, [])
    assert await proxy.resolve("https://api.telegram.org/") is proxy.DEFAULT


async def test_each_fallback_is_logged_and_kept_only_briefly(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setattr(proxy, "ANSWER_TIMEOUT_S", 0.05)
    caplog.set_level(logging.INFO, logger=proxy.__name__)
    secret = "pw" + secrets.token_hex(4)
    key = ("https", "api.telegram.org", 443)

    def kept_for() -> float:
        return proxy._cache[key][0] - proxy.time.monotonic()

    async def no_host(event: dict[str, Any]) -> bool:
        return False

    async def failing_host(event: dict[str, Any]) -> bool:
        asyncio.get_running_loop().call_soon(
            proxy._pending.resolve, event["payload"]["request_id"], {"ok": False, "error": "boom"})
        return True

    monkeypatch.setattr(proxy, "_unicast_host", no_host)
    assert await proxy.resolve(f"https://user:{secret}@api.telegram.org/") is proxy.DEFAULT
    assert "no Host session" in caplog.text
    assert kept_for() <= proxy.FALLBACK_CACHE_TTL_S + _CLOCK_SLACK_S
    proxy.clear_cache()
    _host_answers(monkeypatch, None, [])
    assert await proxy.resolve("https://api.telegram.org/") is proxy.DEFAULT
    assert "did not answer" in caplog.text
    assert kept_for() <= proxy.FALLBACK_CACHE_TTL_S + _CLOCK_SLACK_S
    proxy.clear_cache()
    monkeypatch.setattr(proxy, "_unicast_host", failing_host)
    assert await proxy.resolve("https://api.telegram.org/") is proxy.DEFAULT
    assert "could not resolve" in caplog.text
    assert kept_for() <= proxy.FALLBACK_CACHE_TTL_S + _CLOCK_SLACK_S
    assert secret not in caplog.text and "user" not in caplog.text
    assert proxy.FALLBACK_CACHE_TTL_S < proxy.CACHE_TTL_S / 5

    # Once the fallback lapses the Host, answering now, is asked again; its answer is kept the full minute.
    monkeypatch.setattr(proxy, "FALLBACK_CACHE_TTL_S", 0.05)
    proxy.clear_cache()
    monkeypatch.setattr(proxy, "_unicast_host", no_host)
    assert await proxy.resolve("https://api.telegram.org/") is proxy.DEFAULT
    await asyncio.sleep(0.1)
    _host_answers(monkeypatch, "PROXY pac.corp:8080", [])
    assert await proxy.resolve("https://api.telegram.org/") == "http://pac.corp:8080"
    assert kept_for() > proxy.CACHE_TTL_S - 5


class _InsertionOrdered(dict):  # type: ignore[type-arg]
    """``app._SESSIONS`` iterated in insertion order (a set's order follows the hashes)."""

    def add(self, item: Any) -> None:
        self[item] = None

    def discard(self, item: Any) -> None:
        self.pop(item, None)


class _HostSocket:
    """A Host connection: the live one answers proxy lookups, a stale one never does."""

    def __init__(self, answers: bool) -> None:
        self.answers = answers
        self.lookups = 0

    async def send_json(self, data: dict[str, Any]) -> None:
        if data.get("type") != proxy.REQUEST_TYPE:
            return
        self.lookups += 1
        if self.answers:
            asyncio.get_running_loop().call_soon(
                proxy._pending.resolve, data["payload"]["request_id"], {"ok": True, "rules": "PROXY pac.corp:8080"})


async def test_a_host_session_left_behind_by_a_reconnect_is_not_the_one_asked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Windows VM: the Host's socket reconnects at startup and the backend still holds the
    old, authenticated session. The lookup went to it, waited out the timeout and fell
    back to a direct connection; the Host's live connection is the one to ask."""
    token = "host-" + secrets.token_hex(8)
    monkeypatch.setattr(app, "_HOST_SESSION_TOKEN", token)
    monkeypatch.setattr(proxy, "ANSWER_TIMEOUT_S", 0.2)
    stale, live = _HostSocket(answers=False), _HostSocket(answers=True)
    sessions = _InsertionOrdered()
    monkeypatch.setattr(app, "_SESSIONS", sessions)
    for socket in (stale, live):
        session = app.Session(socket)  # type: ignore[arg-type]
        sessions.add(session)
        await app.handle_message(session, {"id": "r", "type": "host.register", "payload": {"token": token}})
        assert session.host_authenticated is True

    assert await proxy.resolve("https://api.telegram.org/bot1/getUpdates") == "http://pac.corp:8080"
    assert (stale.lookups, live.lookups) == (0, 1)


async def test_an_answer_is_reused_until_it_expires(monkeypatch: pytest.MonkeyPatch) -> None:
    asked: list[str] = []
    _host_answers(monkeypatch, "PROXY p.corp:1", asked)
    clock = [1000.0]
    monkeypatch.setattr(proxy.time, "monotonic", lambda: clock[0])
    await asyncio.gather(*(proxy.resolve("https://api.telegram.org/x") for _ in range(3)))
    await proxy.resolve("https://api.telegram.org/y")
    assert len(asked) == 1
    clock[0] += proxy.CACHE_TTL_S + 1
    await proxy.resolve("https://api.telegram.org/z")
    assert len(asked) == 2


async def test_the_transport_routes_through_the_pac_proxy(monkeypatch: pytest.MonkeyPatch) -> None:
    made: list[str | None] = []

    class Recording(httpx.AsyncBaseTransport):
        def __init__(self, proxy: str | None = None) -> None:
            self.proxy = proxy
            made.append(proxy)

        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"via": self.proxy})

    monkeypatch.setattr(proxy.httpx, "AsyncHTTPTransport", Recording)
    decisions = {"api.telegram.org": "http://p.corp:8080", "direct.example": None}

    async def resolve(url: str) -> Any:
        return decisions[httpx.URL(url).host]

    monkeypatch.setattr(proxy, "resolve", resolve)
    async with httpx.AsyncClient(**proxy.client_options()) as client:
        assert (await client.get("https://api.telegram.org/a")).json() == {"via": "http://p.corp:8080"}
        assert (await client.get("https://api.telegram.org/b")).json() == {"via": "http://p.corp:8080"}
        assert (await client.get("https://direct.example/")).json() == {"via": None}
    assert made == [None, "http://p.corp:8080"]  # one direct pool, one pool per proxy


def test_httpx_fixed_proxies_still_match_before_the_pac_mount(monkeypatch: pytest.MonkeyPatch) -> None:
    # httpx turns its own system proxies off when a client is given `transport=`; the PAC
    # transport is mounted instead, under the more specific HTTPS_PROXY / NO_PROXY mounts.
    monkeypatch.setenv("HTTPS_PROXY", "http://fixed.corp:3128")
    monkeypatch.setenv("NO_PROXY", "chat.local")
    client = httpx.AsyncClient(**proxy.client_options())
    assert not isinstance(client._transport_for_url(httpx.URL("https://api.telegram.org/")), proxy.PacTransport)
    assert not isinstance(client._transport_for_url(httpx.URL("https://chat.local/")), proxy.PacTransport)


def test_all_proxy_or_an_explicit_transport_adds_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    mock = httpx.MockTransport(lambda r: httpx.Response(200))
    assert proxy.client_options(mock) == {"transport": mock}
    monkeypatch.setattr(proxy.urllib.request, "getproxies", lambda: {"all": "http://all.corp:1"})
    assert proxy.client_options() == {}
    monkeypatch.setattr(proxy.urllib.request, "getproxies", lambda: {})
    assert isinstance(proxy.client_options()["mounts"]["all://"], proxy.PacTransport)


async def test_only_the_host_session_may_answer() -> None:
    sent: list[dict[str, Any]] = []

    class S:
        host_authenticated = False

        async def send_json(self, data: dict[str, Any]) -> None:
            sent.append(data)

    await proxy.handle_result(S(), "1", proxy.RESULT_TYPE, {"request_id": "proxy:x", "response": {"ok": True}})
    assert sent[0]["error"]["code"] == "UNAUTHORIZED"
