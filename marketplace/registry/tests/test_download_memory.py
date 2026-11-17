"""Serving a large stored package must not hold it in memory (0.2.44).

The website read the whole stored package onto the heap to pull a README,
a CHANGELOG or one screenshot out of it, and the admin review download
returned the whole package as one bytes object. These tests store a
synthetic 32 MiB package, generated at run time, and bound the peak of the
Python heap while each route serves it. Responses are driven through ASGI
directly and hashed chunk by chunk (the TestClient buffers the whole body,
which would hide the handler's own allocations).
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import os
import tracemalloc
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from registry.models import ExtensionVersion
from tests.fixtures import build_package, valid_manifest
from tests.phase2_helpers import ADMIN_MEMBER, cloud_settings, make_client, publish, register_official, sign_in

BIG = 32 * 1024 * 1024
PNG = b"\x89PNG\r\n\x1a\n"
CHANGELOG = b"# Changelog\n\n## 1.0.0\n- first\n"


def _files(screenshot: bytes) -> dict[str, bytes]:
    return {"CHANGELOG.md": CHANGELOG, "screenshots/main.png": screenshot}


def _publish_small(client: TestClient, publisher: str, publish_fn) -> None:
    manifest = valid_manifest(id=f"{publisher}.big", publisher=publisher, icon="icon.png")
    resp = publish_fn(build_package(manifest=manifest, extra_files=_files(PNG + b"small")))
    assert resp.status_code == 201, resp.text


def _swap_in_large_blob(client: TestClient, publisher: str, tmp_path: Path) -> tuple[Path, bytes]:
    """Replace the stored package with one whose screenshot is BIG bytes of
    incompressible data; the asset rows recorded at publish time still match.
    Returns the large archive and the screenshot bytes."""
    manifest = valid_manifest(id=f"{publisher}.big", publisher=publisher, icon="icon.png")
    screenshot = PNG + os.urandom(BIG - len(PNG))
    path = tmp_path / "large.vsix"
    path.write_bytes(build_package(manifest=manifest, extra_files=_files(screenshot)))
    state = client.app.state.registry
    with Session(state.engine) as session:
        key = session.exec(select(ExtensionVersion.package_key)).one()
    with path.open("rb") as fp:
        state.storage.put_stream(key, fp)
    return path, screenshot


async def _streamed_get(app, path: str, cookie: str = "") -> tuple[int, str, bytes]:
    """GET `path`; return the status, the body's sha256 and its first bytes."""
    status = 0
    digest = hashlib.sha256()
    head = b""

    requested = False

    async def receive():
        # The request has no body; after it, wait as a connected client does
        # (a streaming response listens for a disconnect while it sends).
        nonlocal requested
        if requested:
            await asyncio.Event().wait()
        requested = True
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        nonlocal status, head
        if message["type"] == "http.response.start":
            status = message["status"]
        elif message["type"] == "http.response.body":
            body = message.get("body", b"")
            digest.update(body)
            if len(head) < 4096:
                head += body[: 4096 - len(head)]

    headers = [(b"host", b"testserver")]
    if cookie:
        headers.append((b"cookie", cookie.encode()))
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "https",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": headers,
        "client": ("127.0.0.1", 50000),
        "server": ("testserver", 443),
    }
    await app(scope, receive, send)
    return status, digest.hexdigest(), head


def _peak(run):
    tracemalloc.start()
    try:
        tracemalloc.reset_peak()
        result = run()
        return result, tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()


def _get(app, path: str, cookie: str = ""):
    return _peak(lambda: asyncio.run(_streamed_get(app, path, cookie)))


def test_web_routes_keep_heap_small_with_a_large_package(client: TestClient, tmp_path: Path) -> None:
    _publish_small(client, "acme", lambda data: client.post("/api/publish", files={"package": ("p.vsix", data, "application/zip")}))
    package, screenshot = _swap_in_large_blob(client, "acme", tmp_path)
    size = package.stat().st_size
    assert size > 30 * 1024 * 1024

    (status, digest, _), peak = _get(client.app, "/extensions/acme/big/1.0.0/assets/screenshots/main.png")
    print(f"asset from {size / 2**20:.1f} MiB package: peak traced heap {peak / 2**20:.1f} MiB")
    assert status == 200
    assert digest == hashlib.sha256(screenshot).hexdigest()
    assert peak < size / 4

    (status, _, head), peak = _get(client.app, "/api/extensions/acme/big/readme")
    print(f"readme from {size / 2**20:.1f} MiB package: peak traced heap {peak / 2**20:.1f} MiB")
    assert status == 200 and b"Demo extension." in head
    assert peak < size / 4

    (status, _, head), peak = _get(client.app, "/api/extensions/acme/big/changelog")
    print(f"changelog from {size / 2**20:.1f} MiB package: peak traced heap {peak / 2**20:.1f} MiB")
    assert status == 200 and b"first" in head
    assert peak < size / 4

    (status, _, _), peak = _get(client.app, "/extensions/acme/big")
    print(f"detail page from {size / 2**20:.1f} MiB package: peak traced heap {peak / 2**20:.1f} MiB")
    assert status == 200
    assert peak < size / 4


def test_admin_download_streams_a_large_package(tmp_path: Path) -> None:
    client = make_client(cloud_settings(tmp_path))
    sign_in(client, ADMIN_MEMBER, "Admin")
    token = register_official(client)
    _publish_small(client, "navide", lambda data: publish(client, token, data))
    package, _ = _swap_in_large_blob(client, "navide", tmp_path)
    size = package.stat().st_size
    cookie = "; ".join(f"{name}={value}" for name, value in client.cookies.items())

    (status, digest, _), peak = _get(client.app, "/admin/review/navide/big/1.0.0/universal/package", cookie)
    print(f"admin download of {size / 2**20:.1f} MiB package: peak traced heap {peak / 2**20:.1f} MiB")
    assert status == 200
    assert digest == hashlib.sha256(package.read_bytes()).hexdigest()
    assert peak < size / 4


def test_admin_download_headers_and_missing_blob(tmp_path: Path) -> None:
    client = make_client(cloud_settings(tmp_path))
    sign_in(client, ADMIN_MEMBER, "Admin")
    token = register_official(client)
    _publish_small(client, "navide", lambda data: publish(client, token, data))
    resp = client.get("/admin/review/navide/big/1.0.0/universal/package")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/zip"
    assert resp.headers["content-disposition"] == 'attachment; filename="navide.big-1.0.0@universal.vsix"'
    assert resp.headers["cache-control"] == "no-store"
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        assert zf.read("README.md").startswith(b"# Hello")

    state = client.app.state.registry
    with Session(state.engine) as session:
        key = session.exec(select(ExtensionVersion.package_key)).one()
    state.storage.delete(key)
    assert client.get("/admin/review/navide/big/1.0.0/universal/package").status_code == 404
