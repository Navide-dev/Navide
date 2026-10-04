"""A CONNECT-only HTTP proxy on 127.0.0.1, for static CLI binaries on Android.

A musl binary (Codex) resolves names from /etc/resolv.conf alone, and Android
has no such file. Pointed at this proxy through HTTPS_PROXY, the binary never
resolves anything itself: it sends `CONNECT host:port` here and this process,
linked against the system resolver, opens the connection and relays bytes.

It listens on loopback only, never inspects the tunnelled (TLS) bytes, and
records which hosts were asked for so the UI can disclose where a CLI went.
Started on first use in its own thread; idle otherwise.
"""
from __future__ import annotations

import asyncio
import logging
import threading

log = logging.getLogger(__name__)

_lock = threading.Lock()
_address: tuple[str, int] | None = None
_hosts: set[str] = set()


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, OSError):
        pass
    finally:
        writer.close()


async def _handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    request = await reader.readline()
    while (line := await reader.readline()) not in (b"\r\n", b"\n", b""):
        pass
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


def bound_address() -> tuple[str, int] | None:
    return _address


def hosts_seen() -> set[str]:
    """Hosts a CLI asked this proxy to reach, for disclosure."""
    with _lock:
        return set(_hosts)
