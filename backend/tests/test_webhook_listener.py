"""The webhook listener, over a real loopback socket."""

import asyncio
import hashlib
import socket
import threading

import pytest

from agent_team_backend import webhook_listener as wl
from agent_team_backend import webhook_triggers as wt

from .webhook_client import OneWriteConnection

TRIGGER_ID = "ab" * 16
TOKEN = "nvwh_" + "fixture-key-" + "x" * 31


def record(**over):
    return {
        "id": TRIGGER_ID, "name": "ci", "workspace": "/w", "pipeline_id": "p", "kind": "webhook", "enabled": True,
        "per_minute": 60, "per_day": 500, "token_hash": wt.hash_token(TOKEN), **over,
    }


class Host:
    """Stands in for the main loop's side of the listener."""

    def __init__(self):
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()
        self.accepted = []
        self.audit = []
        self.answer = (202, 0, "accepted")
        self.guard_on = True

    async def accept(self, trigger, text, body_sha256):
        self.accepted.append((trigger["id"], text, body_sha256))
        return self.answer

    def on_audit(self, rows):
        self.audit.extend(rows)

    def close(self):
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(5)
        self.loop.close()


@pytest.fixture
def host():
    h = Host()
    yield h
    h.close()


@pytest.fixture
def listener(host):
    server = wl.WebhookListener(
        port=0, public_host="hooks.example.com", accept=host.accept, on_audit=host.on_audit,
        loop=host.loop, guard_enabled=lambda: host.guard_on,
    )
    server.update({TRIGGER_ID: record()})
    server.start()
    yield server
    server.stop()


def request(port, method="POST", path=f"/webhook/{TRIGGER_ID}", body=b'{"a": 1}', token=TOKEN, headers=None):
    conn = OneWriteConnection("127.0.0.1", port, timeout=10)
    send = {"Content-Type": "application/json"} if body is not None else {}
    if token:
        send["Authorization"] = "Bearer " + token
    send.update(headers or {})
    conn.request(method, path, body=body, headers=send)
    response = conn.getresponse()
    data = response.read()
    answer = (response.status, data, {k.lower(): v for k, v in response.getheaders()})
    conn.close()
    return answer


def test_a_valid_request_is_accepted_and_the_body_reaches_the_host(listener, host):
    body = b'{"event": "deploy"}'
    status, data, headers = request(listener.port, body=body)
    assert status == 202 and data == b'{"ok":true}'
    assert host.accepted == [(TRIGGER_ID, body.decode(), hashlib.sha256(body).hexdigest())]
    assert "server" not in headers


def test_it_binds_loopback_only_and_offers_no_way_not_to(listener):
    assert listener.address == ("127.0.0.1", listener.port)
    assert "host" not in wl.WebhookListener.__init__.__code__.co_varnames


def test_no_thread_or_socket_exists_until_started(host):
    before = {t.name for t in threading.enumerate()}
    server = wl.WebhookListener(port=0, public_host="", accept=host.accept, on_audit=host.on_audit, loop=host.loop, guard_enabled=lambda: True)
    assert {t.name for t in threading.enumerate()} == before
    assert server.port == 0


def test_stop_releases_the_port_and_ends_the_thread(host):
    server = wl.WebhookListener(port=0, public_host="", accept=host.accept, on_audit=host.on_audit, loop=host.loop, guard_enabled=lambda: True)
    server.start()
    port = server.port
    server.stop()
    assert wl.THREAD_NAME not in {t.name for t in threading.enumerate()}
    with socket.socket() as probe:
        assert probe.connect_ex(("127.0.0.1", port)) != 0


def test_a_port_in_use_is_an_error_not_another_port(host):
    with socket.socket() as taken:
        taken.bind(("127.0.0.1", 0))
        taken.listen()
        server = wl.WebhookListener(port=taken.getsockname()[1], public_host="", accept=host.accept, on_audit=host.on_audit, loop=host.loop, guard_enabled=lambda: True)
        with pytest.raises(wl.ListenerError):
            server.start()
    assert wl.THREAD_NAME not in {t.name for t in threading.enumerate()}


@pytest.mark.parametrize(
    "kwargs",
    [
        {"token": ""},
        {"token": TOKEN + "x"},
        {"token": "nvwh_wrong"},
        {"path": "/webhook/" + "cd" * 16},
        {"path": "/webhook/short"},
        {"path": "/"},
        {"path": "/docs"},
        {"path": "/openapi.json"},
        {"path": "/health"},
        {"path": "/ws"},
        {"method": "GET", "body": None},
        {"method": "PUT"},
        {"method": "DELETE", "body": None},
        {"method": "OPTIONS", "body": None},
        {"headers": {"Authorization": "Basic " + TOKEN}},
    ],
)
def test_every_refusal_looks_the_same(listener, host, kwargs):
    status, data, _ = request(listener.port, **kwargs)
    assert (status, data) == (404, b"")
    assert host.accepted == []


def test_a_disabled_trigger_is_unknown(listener, host):
    listener.update({})
    assert request(listener.port)[0] == 404
    assert host.accepted == []


def test_the_key_is_not_accepted_in_the_query_string(listener, host):
    assert request(listener.port, path=f"/webhook/{TRIGGER_ID}?token={TOKEN}", token="")[0] == 404
    assert host.accepted == []


@pytest.mark.parametrize("value", ["evil.example.com", "evil.example.com:80", "127.0.0.1.evil.com", ""])
def test_a_foreign_host_header_is_refused(listener, host, value):
    assert request(listener.port, headers={"Host": value})[0] == 404
    assert host.accepted == []


@pytest.mark.parametrize("value", ["127.0.0.1", "localhost", "hooks.example.com", "HOOKS.example.com:443"])
def test_loopback_and_the_declared_host_are_accepted(listener, value):
    assert request(listener.port, headers={"Host": value})[0] == 202


def test_a_request_from_a_web_page_is_refused(listener, host):
    assert request(listener.port, headers={"Origin": "https://attacker.example"})[0] == 404
    assert request(listener.port, headers={"Origin": "null"})[0] == 404
    assert host.accepted == []


def test_guard_off_answers_503_after_the_key_check(listener, host):
    host.guard_on = False
    assert request(listener.port)[0] == 503
    assert request(listener.port, token="")[0] == 404
    assert host.accepted == []


def status_or_reset(call):
    """The status, or None when the server closed on a body it refused to read:
    the client may then see a reset before the answer, depending on the OS."""
    try:
        return call()
    except ConnectionError:
        return None


def test_a_body_over_the_limit_is_413_with_a_length(listener, host):
    status = status_or_reset(
        lambda: request(listener.port, body=b"x" * (wl.MAX_BODY + 1), headers={"Content-Type": "text/plain"})[0]
    )
    assert status in (413, None)
    assert host.accepted == []


def test_a_body_at_the_limit_passes(listener):
    assert request(listener.port, body=b"x" * wl.MAX_BODY, headers={"Content-Type": "text/plain"})[0] == 202


def test_a_chunked_body_over_the_limit_is_413(listener, host):
    chunks = (b"y" * 8192 for _ in range(wl.MAX_BODY // 8192 + 2))
    conn = OneWriteConnection("127.0.0.1", listener.port, timeout=10)

    def send():
        conn.request("POST", f"/webhook/{TRIGGER_ID}", body=chunks, encode_chunked=True, headers={
            "Authorization": "Bearer " + TOKEN, "Content-Type": "text/plain", "Transfer-Encoding": "chunked",
        })
        return conn.getresponse().status

    assert status_or_reset(send) in (413, None)
    conn.close()
    assert host.accepted == []


def test_an_unauthenticated_oversized_body_is_never_read(listener, host):
    assert status_or_reset(lambda: request(listener.port, body=b"x" * (wl.MAX_BODY * 3), token="")[0]) in (404, None)
    assert host.accepted == []


def test_the_wrong_type_is_415_and_bad_json_is_400(listener, host):
    assert request(listener.port, headers={"Content-Type": "application/octet-stream"})[0] == 415
    assert request(listener.port, body=b"{nope")[0] == 400
    assert host.accepted == []


def test_a_slow_body_is_cut_off(host, monkeypatch):
    monkeypatch.setattr(wl, "BODY_TIMEOUT_S", 0.3)
    server = wl.WebhookListener(port=0, public_host="", accept=host.accept, on_audit=host.on_audit, loop=host.loop, guard_enabled=lambda: True)
    server.update({TRIGGER_ID: record()})
    server.start()
    try:
        with socket.create_connection(("127.0.0.1", server.port), timeout=5) as s:
            s.sendall(
                f"POST /webhook/{TRIGGER_ID} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {TOKEN}\r\n"
                "Content-Type: text/plain\r\nContent-Length: 100\r\n\r\nabc".encode()
            )
            assert b" 408 " in s.recv(200)
    finally:
        server.stop()
    assert host.accepted == []


def test_a_connection_that_never_finishes_its_headers_is_closed(host, monkeypatch):
    monkeypatch.setattr(wl, "HEADER_TIMEOUT_S", 0.3)
    server = wl.WebhookListener(port=0, public_host="", accept=host.accept, on_audit=host.on_audit, loop=host.loop, guard_enabled=lambda: True)
    server.start()
    try:
        with socket.create_connection(("127.0.0.1", server.port), timeout=5) as s:
            s.sendall(b"POST /webhook/x HTTP/1.1\r\nHost: 127")
            assert s.recv(100) == b""
    finally:
        server.stop()


def test_oversized_headers_are_refused(listener, host):
    with socket.create_connection(("127.0.0.1", listener.port), timeout=5) as s:
        s.sendall(b"POST /x HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Pad: " + b"a" * (wl.MAX_HEADERS * 2) + b"\r\n\r\n")
        answer = s.recv(100)
    assert b" 431 " in answer
    assert host.accepted == []


def test_the_per_minute_limit_answers_429_with_retry_after(host):
    server = wl.WebhookListener(port=0, public_host="", accept=host.accept, on_audit=host.on_audit, loop=host.loop, guard_enabled=lambda: True)
    server.update({TRIGGER_ID: record(per_minute=2)})
    server.start()
    try:
        assert request(server.port)[0] == 202
        assert request(server.port)[0] == 202
        status, _, headers = request(server.port)
    finally:
        server.stop()
    assert status == 429 and int(headers["retry-after"]) >= 1
    assert len(host.accepted) == 2


def test_the_global_limit_covers_requests_for_any_id(host, monkeypatch):
    monkeypatch.setattr(wl, "GLOBAL_PER_MINUTE", 3)
    server = wl.WebhookListener(port=0, public_host="", accept=host.accept, on_audit=host.on_audit, loop=host.loop, guard_enabled=lambda: True)
    server.start()
    try:
        statuses = [request(server.port, path="/webhook/" + "ee" * 16)[0] for _ in range(5)]
    finally:
        server.stop()
    assert statuses == [404, 404, 404, 429, 429]


def test_failed_keys_have_their_own_limit(host, monkeypatch):
    monkeypatch.setattr(wl, "FAILED_PER_MINUTE", 2)
    server = wl.WebhookListener(port=0, public_host="", accept=host.accept, on_audit=host.on_audit, loop=host.loop, guard_enabled=lambda: True)
    server.update({TRIGGER_ID: record()})
    server.start()
    try:
        statuses = [request(server.port, token="nvwh_bad")[0] for _ in range(4)]
    finally:
        server.stop()
    assert statuses == [404, 404, 429, 429]


def test_forged_forwarding_headers_do_not_get_around_a_limit(host):
    server = wl.WebhookListener(port=0, public_host="", accept=host.accept, on_audit=host.on_audit, loop=host.loop, guard_enabled=lambda: True)
    server.update({TRIGGER_ID: record(per_minute=1)})
    server.start()
    try:
        assert request(server.port, headers={"X-Forwarded-For": "1.1.1.1"})[0] == 202
        assert request(server.port, headers={"X-Forwarded-For": "2.2.2.2"})[0] == 429
    finally:
        server.stop()


@pytest.mark.parametrize("answer", [(409, 30, "run-active"), (503, 0, "no-window"), (429, 3600, "daily-limit")])
def test_the_hosts_answer_is_passed_on(listener, host, answer):
    host.answer = answer
    status, data, headers = request(listener.port)
    assert status == answer[0] and data == b""
    if answer[1]:
        assert headers["retry-after"] == str(answer[1])


def test_a_host_that_does_not_answer_is_503(host, monkeypatch):
    monkeypatch.setattr(wl, "ACCEPT_TIMEOUT_S", 0.2)

    async def never(trigger, text, body_sha256):
        await asyncio.sleep(30)

    server = wl.WebhookListener(port=0, public_host="", accept=never, on_audit=host.on_audit, loop=host.loop, guard_enabled=lambda: True)
    server.update({TRIGGER_ID: record()})
    server.start()
    try:
        assert request(server.port)[0] == 503
    finally:
        server.stop()


def test_audit_holds_the_outcome_and_never_the_key_or_body(host):
    server = wl.WebhookListener(port=0, public_host="", accept=host.accept, on_audit=host.on_audit, loop=host.loop, guard_enabled=lambda: True)
    server.update({TRIGGER_ID: record()})
    server.start()
    body = b'{"secret": "payload-marker"}'
    request(server.port, body=body, headers={"X-Custom": "header-marker"})
    request(server.port, path=f"/webhook/{TRIGGER_ID}?q=query-marker", token="nvwh_bad-marker")
    server.stop()
    text = repr(host.audit)
    for marker in ("payload-marker", "header-marker", "query-marker", "bad-marker", TOKEN):
        assert marker not in text
    outcomes = {r["outcome"]: r for r in host.audit}
    assert outcomes["accepted"]["size"] == len(body)
    assert outcomes["accepted"]["body_sha256"] == hashlib.sha256(body).hexdigest()
    assert outcomes["bad-key"]["trigger_id"] == TRIGGER_ID


def test_a_flood_becomes_one_audit_row_with_a_count(host, monkeypatch):
    monkeypatch.setattr(wl, "GLOBAL_PER_MINUTE", 1)
    server = wl.WebhookListener(port=0, public_host="", accept=host.accept, on_audit=host.on_audit, loop=host.loop, guard_enabled=lambda: True)
    server.start()
    for _ in range(6):
        request(server.port, path="/nothing")
    server.stop()
    limited = [r for r in host.audit if r["outcome"] == "rate-limited"]
    assert len(limited) == 1 and limited[0]["count"] == 5


def test_nothing_is_logged_about_a_key(listener, caplog):
    with caplog.at_level("DEBUG"):
        request(listener.port)
        request(listener.port, token="nvwh_bad-marker")
    assert TOKEN not in caplog.text and "bad-marker" not in caplog.text


def test_rate_limiter_window_slides():
    now = [100.0]
    limiter = wl.RateLimiter(2, 60.0, clock=lambda: now[0])
    assert limiter.allow() == 0 and limiter.allow() == 0
    assert limiter.allow() == 60
    now[0] = 161.0
    assert limiter.allow() == 0
