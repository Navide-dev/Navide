"""A CONNECT-only HTTP proxy on 127.0.0.1, for static CLI binaries on Android.

A musl binary (Codex) resolves names from /etc/resolv.conf alone, and Android
has no such file. Pointed at this proxy through HTTPS_PROXY, the binary never
resolves anything itself: it sends `CONNECT host:port` here and this process,
linked against the system resolver, opens the connection and relays bytes.

It listens on loopback only, never inspects the tunnelled (TLS) bytes, and
records which hosts were asked for so the UI can disclose where a CLI went.
Started on first use in its own thread; idle otherwise.

Loopback is not private on Android: every app on the device can connect to
127.0.0.1. Without a credential this would be an open relay any app could use
to reach the network on Navide's behalf. So each start mints a random token
and a CONNECT without `Proxy-Authorization: Basic navide:<token>` gets 407.
The token travels to the CLI inside HTTPS_PROXY's userinfo; other apps cannot
read another process's environment on Android. Where a CLI may connect is not
restricted, only disclosed (hosts_seen()).
"""
from __future__ import annotations

import asyncio
import base64
import hmac
import logging
import secrets
import threading

log = logging.getLogger(__name__)

_lock = threading.Lock()
_address: tuple[str, int] | None = None
_hosts: set[str] = set()
_USER = "navide"
_token = secrets.token_urlsafe(24)


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, OSError):
        pass
    finally:
        writer.close()


def _credential_ok(value: str) -> bool:
    scheme, _, encoded = value.partition(" ")
    if scheme.lower() != "basic":
        return False
    try:
        supplied = base64.b64decode(encoded.strip(), validate=True)
    except ValueError:
        return False
    return hmac.compare_digest(supplied, f"{_USER}:{_token}".encode())


async def _handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    request = await reader.readline()
    authorized = False
    while (line := await reader.readline()) not in (b"\r\n", b"\n", b""):
        name, _, value = line.decode("latin-1").partition(":")
        if name.strip().lower() == "proxy-authorization":
            authorized = _credential_ok(value.strip())
    if not authorized:
        writer.write(b'HTTP/1.1 407 Proxy Authentication Required\r\n'
                     b'Proxy-Authenticate: Basic realm="navide"\r\n\r\n')
        await writer.drain()
        writer.close()
        return
    parts = request.decode("latin-1").split()
    if len(parts) < 2 or parts[0].upper() != "CONNECT":
        writer.write(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n")
        await writer.drain()
        writer.close()
        return
    host, _, port = parts[1].rpartition(":")
    host = host.strip("[]")
    try:
        upstream_reader, upstream_writer = await asyncio.open_connection(host, int(port))
    except (OSError, ValueError) as err:
        log.info("loopback proxy: CONNECT %s failed: %s", parts[1], err)
        writer.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
        await writer.drain()
        writer.close()
        return
    with _lock:
        _hosts.add(host)
    writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
    await writer.drain()
    await asyncio.gather(_pipe(reader, upstream_writer), _pipe(upstream_reader, writer))


def ensure_started() -> int:
    """The proxy's port, starting it on first call."""
    global _address
    with _lock:
        if _address is not None:
            return _address[1]
        ready = threading.Event()
        box: dict[str, object] = {}

        def run() -> None:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                server = loop.run_until_complete(asyncio.start_server(_handle, "127.0.0.1", 0))
                box["address"] = server.sockets[0].getsockname()[:2]
            except BaseException as err:  # noqa: BLE001 - reported to the caller below
                box["error"] = err
                ready.set()
                return
            ready.set()
            loop.run_forever()

        threading.Thread(target=run, name="loopback-connect-proxy", daemon=True).start()
        ready.wait()
        if "error" in box:
            raise RuntimeError(f"loopback proxy failed to start: {box['error']}")
        _address = box["address"]  # type: ignore[assignment]
        log.info("loopback CONNECT proxy listening on %s:%d", *_address)
        return _address[1]


def token() -> str:
    """The credential a client must present; minted once per process."""
    return _token


def proxy_url() -> str:
    """HTTPS_PROXY value for a CLI spawn, credential included."""
    return f"http://{_USER}:{_token}@127.0.0.1:{ensure_started()}"


def ca_bundle_path() -> str:
    """SSL_CERT_FILE value for a CLI spawn: certifi's bundle. Kept app-side
    because vendor modules may not import third-party packages."""
    import certifi

    return certifi.where()


def bound_address() -> tuple[str, int] | None:
    return _address


def hosts_seen() -> set[str]:
    """Hosts a CLI asked this proxy to reach, for disclosure."""
    with _lock:
        return set(_hosts)
