"""Keeping "we sent you a link" from outliving the click that answered it.

The link learned whether an account's address was confirmed exactly once, in
``auth.hello``, and never read it again. Nothing on the server pushed it either.
So a person who clicked the link in their browser came back to a panel still
telling them to check their mail, and the only thing that moved it was
restarting the app — which is not a thing anybody thinks to try, because from
where they are sitting the click simply did not work.

Three paths close that, and they exist together because each covers the case the
others cannot: a push for the server that can send one, a poll for the server
that cannot, and a reconnect for the server too old to be asked at all.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from agent_team_backend import server_link
from agent_team_backend.server_link import ServerLink


class FakeWs:
    def __init__(self) -> None:
        self.closed = False

    async def close(self) -> None:
        self.closed = True


def _link(monkeypatch: pytest.MonkeyPatch, replies: list[dict[str, Any]]) -> ServerLink:
    """An authenticated link whose ``account.status`` answers from *replies*."""
    link = ServerLink(connect=lambda url: None, config_loader=lambda: None)
    link._ws = FakeWs()
    link._authenticated = True
    asked: list[str] = []

    async def fake_request(msg_type: str, payload: dict) -> dict:
        asked.append(msg_type)
        return replies.pop(0) if replies else {"ok": False, "error": {}}

    monkeypatch.setattr(link, "_request", fake_request)
    link.asked = asked  # type: ignore[attr-defined]
    return link


@pytest.fixture(autouse=True)
def _quiet_broadcast(monkeypatch: pytest.MonkeyPatch):
    """Announcements go through the app module; these tests are about the link."""
    from agent_team_backend import app

    sent: list[dict] = []

    async def capture(event: dict, **_kwargs) -> None:
        sent.append(event)

    monkeypatch.setattr(app, "broadcast", capture)
    monkeypatch.setattr(server_link, "_link", None)
    return sent


@pytest.fixture(autouse=True)
def _fast_verify(monkeypatch: pytest.MonkeyPatch):
    """The real gaps are half a minute and a minute; the behaviour is the same."""
    monkeypatch.setattr(server_link, "VERIFY_POLL_S", 0.01)
    monkeypatch.setattr(server_link, "VERIFY_RETRY_S", 0.01)


# ---- the push ----------------------------------------------------------------


async def test_the_push_flips_the_status_and_tells_the_windows(
    monkeypatch: pytest.MonkeyPatch, _quiet_broadcast: list[dict]
) -> None:
    link = _link(monkeypatch, [])
    monkeypatch.setattr(server_link, "_link", link)
    assert link.email_verified is False

    await link._on_account_verified()

    assert link.email_verified is True
    assert [e["type"] for e in _quiet_broadcast] == ["p2p.link.changed"]
    assert _quiet_broadcast[0]["payload"]["status"]["emailVerified"] is True


async def test_a_second_push_announces_nothing(
    monkeypatch: pytest.MonkeyPatch, _quiet_broadcast: list[dict]
) -> None:
    """The server may send it on every connection. Redrawing every window for
    news that is already on screen is not free."""
    link = _link(monkeypatch, [])
    monkeypatch.setattr(server_link, "_link", link)
    link.email_verified = True

    await link._on_account_verified()

    assert _quiet_broadcast == []


async def test_the_push_is_wired_to_the_dispatcher(monkeypatch: pytest.MonkeyPatch) -> None:
    """A handler nothing routes to is the same as no handler."""
    link = _link(monkeypatch, [])
    seen: list[str] = []
    monkeypatch.setattr(link, "_spawn", lambda coro: (coro.close(), seen.append("spawned")))

    await link._handle(json.dumps({"type": "account.verified", "payload": {"memberId": "m1"}}))

    assert seen == ["spawned"]


# ---- the poll ----------------------------------------------------------------

# The loop is awaited to its own return, not under a deadline. Its last step is
# the announcement, and status() makes three asyncio.to_thread hops for it (one
# of them generates the device signing key), so a starved thread pool on
# a loaded Windows runner stretched it past the one second these tests allowed.
# A loop that never stops is still caught, by pytest-timeout.


async def test_the_poll_adopts_the_answer_and_stops(
    monkeypatch: pytest.MonkeyPatch, _quiet_broadcast: list[dict]
) -> None:
    link = _link(monkeypatch, [{"ok": True, "payload": {"emailVerified": True}}])
    monkeypatch.setattr(server_link, "_link", link)

    await link._verify_loop()

    assert link.email_verified is True
    assert link.asked == ["account.status"]
    assert [e["type"] for e in _quiet_broadcast] == ["p2p.link.changed"]


async def test_the_poll_keeps_asking_while_the_answer_is_no(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """"Not yet" is not an answer to stop on — it is the state the loop exists
    for. Stopping there would put the panel right back where it was."""
    link = _link(
        monkeypatch,
        [
            {"ok": True, "payload": {"emailVerified": False}},
            {"ok": True, "payload": {"emailVerified": False}},
            {"ok": True, "payload": {"emailVerified": True}},
        ],
    )
    monkeypatch.setattr(server_link, "_link", link)

    await link._verify_loop()

    assert link.asked == ["account.status"] * 3
    assert link.email_verified is True


async def test_a_verified_account_is_never_polled(monkeypatch: pytest.MonkeyPatch) -> None:
    """Most accounts are already verified, and they should cost nothing."""
    link = _link(monkeypatch, [])
    link.email_verified = True

    await asyncio.wait_for(link._verify_loop(), 1)

    assert link.asked == []


# ---- the fallback ------------------------------------------------------------


async def test_an_old_server_is_asked_more_slowly_and_never_hung_up_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The first version dropped the connection here, to force a fresh
    auth.hello. That put a reconnect on a timer inside a loop that reconnects on
    its own, and the socket must stay up."""
    link = _link(
        monkeypatch,
        [
            {"ok": False, "error": {"code": "UNKNOWN_TYPE"}},
            {"ok": False, "error": {"code": "UNKNOWN_TYPE"}},
            {"ok": True, "payload": {"emailVerified": True}},
        ],
    )
    monkeypatch.setattr(server_link, "_link", link)
    ws = link._ws

    await link._verify_loop()

    # Kept asking, so a server upgraded under a running link is noticed.
    assert link.asked == ["account.status"] * 3
    assert link.email_verified is True
    assert ws.closed is False


async def test_a_failed_request_does_not_become_a_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A server that answered with some other error still knows the verb. Taking
    a one-off failure as "too old" would trade a retry for a reconnect."""
    link = _link(
        monkeypatch,
        [
            {"ok": False, "error": {"code": "RATE_LIMITED"}},
            {"ok": True, "payload": {"emailVerified": True}},
        ],
    )
    monkeypatch.setattr(server_link, "_link", link)

    await link._verify_loop()

    assert link._verify_fallback is False
    assert link.asked == ["account.status"] * 2


async def test_a_raising_request_is_not_a_fallback_either(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    link = _link(monkeypatch, [])

    async def boom(msg_type: str, payload: dict) -> dict:
        raise ConnectionError("gone")

    monkeypatch.setattr(link, "_request", boom)

    assert await link._read_account_status() is None
    assert link._verify_fallback is False


# ---- asking on demand --------------------------------------------------------


async def test_check_now_reads_the_server_and_reports_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    link = _link(monkeypatch, [{"ok": True, "payload": {"emailVerified": True}}])

    reply = await link.check_verification()

    assert reply == {"ok": True, "payload": {"emailVerified": True}}
    assert link.asked == ["account.status"]


async def test_check_now_on_an_old_server_answers_without_reconnecting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """It cannot answer the question there, so it answers what this machine
    believes. Going off to find a better answer by re-dialling is exactly what
    turned the first version of this into a loop."""
    link = _link(monkeypatch, [{"ok": False, "error": {"code": "UNKNOWN_TYPE"}}])
    ws = link._ws

    reply = await link.check_verification()

    assert reply["ok"] is True
    assert reply["payload"]["emailVerified"] is False
    assert link._verify_fallback is True
    assert ws.closed is False


async def test_check_now_needs_a_live_link(monkeypatch: pytest.MonkeyPatch) -> None:
    link = _link(monkeypatch, [])
    link._ws = None

    reply = await link.check_verification()

    assert reply["ok"] is False
    assert link.asked == []


# ---- the seam the unit tests above could not see -----------------------------
#
# Every test above drives ``_verify_loop`` directly, and all of them passed
# while the link reconnected once a second on every normal account. What they
# could not see is what ``_session`` *does* when that loop finishes: it was in
# the ``asyncio.wait`` set that means "the connection is over when any of these
# finishes", and the loop is designed to finish — instantly, for an account that
# is already verified. So these drive the real loop.


class ScriptedServer:
    """A server that authenticates and then answers account.status from a
    script. Counts hellos, which is the number a reconnect loop inflates."""

    def __init__(self, *, verified: bool, status: list[dict[str, Any]]) -> None:
        self.verified = verified
        self.status = status
        self.hellos = 0
        self._out: asyncio.Queue = asyncio.Queue()
        self.closed = False

    async def send(self, raw: str) -> None:
        frame = json.loads(raw)
        kind = frame.get("type")
        if kind == "auth.hello":
            self.hellos += 1
            reply = {"ok": True, "payload": {"memberId": "m1", "displayName": "",
                                             "emailVerified": self.verified,
                                             "deviceId": "dev-1"}}
        elif kind == "account.status":
            reply = self.status.pop(0) if self.status else {
                "ok": False, "error": {"code": "UNKNOWN_TYPE"}
            }
        else:
            # policy.get, sessions.list, roster pushes: answered emptily, which
            # is enough for the link to settle into a normal connected session.
            reply = {"ok": True, "payload": {}}
        await self._out.put({**reply, "id": frame.get("id"), "type": kind})

    async def close(self) -> None:
        self.closed = True
        await self._out.put(None)

    def __aiter__(self) -> "ScriptedServer":
        return self

    async def __anext__(self) -> str:
        frame = await self._out.get()
        if frame is None:
            raise StopAsyncIteration
        return json.dumps(frame)

    async def __aenter__(self) -> "ScriptedServer":
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        self.closed = True


def _running_link(server: ScriptedServer) -> ServerLink:
    link = ServerLink(
        connect=lambda url: server,
        config_loader=lambda: server_link.ServerLinkConfig(url="ws://s/ws", token="t"),
    )
    return link


#: Generous on purpose: only a link that is stuck should take this long.
PRECONDITION_S = 30.0


async def _run_briefly(link: ServerLink, seconds: float, until=None) -> None:
    """Run the link for `seconds`; when `until` is given, wait for it to hold
    first and only then start that window.

    A window measured from the task's first tick lost races on the Windows
    runner, where timer slices are ~15 ms: the link had not even connected
    when it closed. Waiting for the thing under test to happen and then
    watching for `seconds` is both steadier and stricter — the quiet the
    caller asserts is quiet *after* the event, not instead of it.

    Reaching the event is a precondition, not the thing measured, so it is not
    held to a short deadline. Before its first hello the link reads the trust
    store and writes device keys — each a disk flush — and a Windows runner has
    taken over 0.8 s per flush, which a 2 s deadline turned into `assert 0 == 1`
    as if the link had been silent. A link that never gets there fails here,
    under its own name.
    """
    task = asyncio.create_task(link._run())
    try:
        if until is not None:
            try:
                async with asyncio.timeout(PRECONDITION_S):
                    while not until():
                        await asyncio.sleep(0.01)
            except TimeoutError:
                pytest.fail(f"the link never got there in {PRECONDITION_S:.0f}s")
        await asyncio.sleep(seconds)
    finally:
        link._stopped = True
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass


async def test_a_verified_account_does_not_reconnect_in_a_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The regression, in the shape the user saw it: an account that is already
    verified, a link that authenticated and then tore itself down a millisecond
    later, once a second, for ever.

    One hello is the whole assertion. The loop showed up as thousands.
    """
    monkeypatch.setattr(server_link, "RECONNECT_BASE_S", 0.01)
    monkeypatch.setattr(server_link, "RECONNECT_MAX_S", 0.01)
    server = ScriptedServer(verified=True, status=[])
    link = _running_link(server)

    await _run_briefly(link, 0.3, until=lambda: server.hellos >= 1)

    assert server.hellos == 1


async def test_an_old_server_does_not_provoke_a_reconnect_loop_either(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The other half of the same mistake: the fallback used to close the socket
    to force a fresh hello, inside a loop that already reconnects on its own."""
    monkeypatch.setattr(server_link, "RECONNECT_BASE_S", 0.01)
    monkeypatch.setattr(server_link, "RECONNECT_MAX_S", 0.01)
    monkeypatch.setattr(server_link, "VERIFY_POLL_S", 0.01)
    monkeypatch.setattr(server_link, "VERIFY_RETRY_S", 0.01)
    server = ScriptedServer(verified=False, status=[])  # every status: UNKNOWN_TYPE
    link = _running_link(server)

    await _run_briefly(link, 0.3, until=lambda: server.hellos >= 1)

    assert server.hellos == 1


async def test_the_fallback_is_lifted_when_the_server_learns_the_verb(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A machine that met an old server once must not keep the fallback for
    ever. It is cleared on every hello, so a server upgraded underneath is
    noticed on the next connection — and asked again on this one regardless."""
    monkeypatch.setattr(server_link, "VERIFY_POLL_S", 0.01)
    monkeypatch.setattr(server_link, "VERIFY_RETRY_S", 0.01)
    link = _link(
        monkeypatch,
        [
            {"ok": False, "error": {"code": "UNKNOWN_TYPE"}},
            {"ok": True, "payload": {"emailVerified": False}},
        ],
    )
    assert await link._read_account_status() is None
    assert link._verify_fallback is True

    # Same connection: it keeps asking, and gets a real answer once the server
    # can give one.
    assert await link._read_account_status() is False


async def test_a_fresh_hello_clears_the_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(server_link, "RECONNECT_BASE_S", 0.01)
    server = ScriptedServer(verified=True, status=[])
    link = _running_link(server)
    link._verify_fallback = True

    await _run_briefly(link, 0.2, until=lambda: link._verify_fallback is False)

    assert link._verify_fallback is False
