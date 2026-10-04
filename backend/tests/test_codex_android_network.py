"""Codex on Android: a static musl binary with no /etc/resolv.conf.

The fix is a loopback CONNECT proxy in the backend plus HTTPS_PROXY,
SSL_CERT_FILE and TMPDIR for the spawn. On every desktop platform the extra
env is empty, so spawns stay byte-for-byte what they were.
"""
from __future__ import annotations

import base64
import socket
import tempfile
import threading
from urllib.parse import urlsplit

import certifi
import pytest

from agent_team_backend import loopback_connect_proxy, osplat
from agent_team_backend.cli_vendors import codex as codex_vendor
from agent_team_backend.cli_vendors.base import apply_spawn_env_extra


def test_desktop_codex_spawn_env_extra_is_empty() -> None:
    assert codex_vendor.SPEC.spawn_env_extra() == {}


def test_android_codex_spawn_env_points_at_the_loopback_proxy(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(osplat.paths, "needs_loopback_dns_proxy", lambda: True)
    env = codex_vendor.SPEC.spawn_env_extra()
    proxy = urlsplit(env["HTTPS_PROXY"])
    assert (proxy.scheme, proxy.hostname, proxy.port) == ("http", "127.0.0.1", loopback_connect_proxy.ensure_started())
    # Credentials ride in the URL so Codex sends Proxy-Authorization itself.
    assert (proxy.username, proxy.password) == ("navide", loopback_connect_proxy.token())
    assert env["SSL_CERT_FILE"] == certifi.where()
    assert env["TMPDIR"] == tempfile.gettempdir()


def test_spawn_env_extra_never_displaces_a_value_already_set() -> None:
    class Spec:
        @staticmethod
        def spawn_env_extra():
            return {"HTTPS_PROXY": "http://127.0.0.1:1", "TMPDIR": "/x"}

    env = {"HTTPS_PROXY": "http://user-choice:3128"}
    apply_spawn_env_extra(Spec, env, inherited={"TMPDIR": "/inherited"})
    assert env == {"HTTPS_PROXY": "http://user-choice:3128"}


def _echo_server() -> int:
    srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(1)

    def serve():
        conn, _ = srv.accept()
        conn.sendall(conn.recv(64).upper()); conn.close(); srv.close()

    threading.Thread(target=serve, daemon=True).start()
    return srv.getsockname()[1]


def _auth_header(token: str) -> str:
    return "Proxy-Authorization: Basic " + base64.b64encode(f"navide:{token}".encode()).decode() + "\r\n"


def _connect(port: int, target: int, header: str = "") -> bytes:
    with socket.create_connection(("127.0.0.1", port), timeout=5) as s:
        s.sendall(f"CONNECT localhost:{target} HTTP/1.1\r\nHost: localhost\r\n{header}\r\n".encode())
        return s.recv(64)


def test_proxy_refuses_connect_without_the_token() -> None:
    # Any app on an Android device can reach loopback; without the token the
    # proxy would be an open relay for all of them.
    port = loopback_connect_proxy.ensure_started()
    assert _connect(port, 9).startswith(b"HTTP/1.1 407")
    assert _connect(port, 9, _auth_header("wrong-token")).startswith(b"HTTP/1.1 407")


def test_proxy_relays_connect_and_records_the_host() -> None:
    port = loopback_connect_proxy.ensure_started()
    target = _echo_server()
    with socket.create_connection(("127.0.0.1", port), timeout=5) as s:
        s.sendall(f"CONNECT localhost:{target} HTTP/1.1\r\nHost: localhost\r\n"
                  f"{_auth_header(loopback_connect_proxy.token())}\r\n".encode())
        assert s.recv(64).startswith(b"HTTP/1.1 200")
        s.sendall(b"hello")
        assert s.recv(64) == b"HELLO"
    assert "localhost" in loopback_connect_proxy.hosts_seen()


def test_proxy_listens_on_loopback_only() -> None:
    port = loopback_connect_proxy.ensure_started()
    assert loopback_connect_proxy.bound_address() == ("127.0.0.1", port)
    assert loopback_connect_proxy.ensure_started() == port
