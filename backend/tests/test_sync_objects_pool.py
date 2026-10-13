"""The keep-alive HTTP pool sync objects travel over.

Each record of a sync round is its own object, so a fresh TLS handshake per
GET would cost more than the object itself. These tests hold the pool to
reusing one connection, and to surviving the server closing an idle one.
"""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from agent_team_backend import sync_objects


class KeepAlive:
    """An HTTP/1.1 server that records which client connection served each request."""

    def __init__(self) -> None:
        self.peers: list[int] = []
        self.bodies: list[bytes] = []
        self.close_after_next = False
        server = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: Any) -> None:
                pass

            def _reply(self, status: int, body: bytes) -> None:
                server.peers.append(self.client_address[1])
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                if server.close_after_next:
                    server.close_after_next = False
                    self.close_connection = True

            def do_GET(self) -> None:  # noqa: N802 - http.server naming
                if self.path.startswith("/missing"):
                    self._reply(404, b"no")
                    return
                self._reply(200, self.path.encode())

            def do_PUT(self) -> None:  # noqa: N802
                body = self.rfile.read(int(self.headers["Content-Length"]))
                server.bodies.append(body)
                self._reply(200, b"")

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.http.server_address[1]}"
        threading.Thread(target=self.http.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.http.shutdown()
        self.http.server_close()


@pytest.fixture
def server():
    s = KeepAlive()
    yield s
    s.close()


def test_sequential_requests_share_one_connection(server: KeepAlive) -> None:
    pool = sync_objects.HttpPool()
    for i in range(10):
        status, body = pool.request("GET", f"{server.base}/obj/{i}")
        assert (status, body) == (200, f"/obj/{i}".encode())
    assert len(set(server.peers)) == 1
    pool.close()


def test_parallel_requests_are_capped_by_the_pool_not_the_request_count(server: KeepAlive) -> None:
    pool = sync_objects.HttpPool(per_host=4)
    with ThreadPoolExecutor(4) as ex:
        results = list(ex.map(lambda i: pool.request("GET", f"{server.base}/obj/{i}"), range(40)))
    assert all(status == 200 for status, _ in results)
    assert len(set(server.peers)) <= 4
    pool.close()


def test_a_connection_the_server_closed_is_replaced_transparently(server: KeepAlive) -> None:
    pool = sync_objects.HttpPool()
    server.close_after_next = True
    assert pool.request("GET", f"{server.base}/a")[0] == 200
    assert pool.request("GET", f"{server.base}/b") == (200, b"/b")
    pool.close()


def test_put_sends_the_body_and_errors_come_back_as_status(server: KeepAlive) -> None:
    pool = sync_objects.HttpPool()
    assert pool.request("PUT", f"{server.base}/up", body=b"sealed")[0] == 200
    assert server.bodies == [b"sealed"]
    assert pool.request("GET", f"{server.base}/missing")[0] == 404
    # An error status does not cost the connection.
    assert pool.request("GET", f"{server.base}/ok")[0] == 200
    assert len(set(server.peers)) == 1
    pool.close()
