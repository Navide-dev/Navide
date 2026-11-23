"""Publishing a large package must not hold it in memory (0.2.43).

A 25 MB linux-arm64 upload pushed the 256 MB Registry container past its
limit: the handler read the whole upload, then held every decompressed entry
at once, then each scanner read the backend executable whole again. These
tests publish a synthetic package of tens of MB, generated at run time,
through a streaming ASGI request (the TestClient buffers the whole body,
which would hide the handler's own allocations) and bound the peak of the
Python heap during the request.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import stat
import tracemalloc
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient

from registry import secret_scan
from registry.native_backend import MIN_NAVIDE_FOR_THIRD_PARTY_BACKEND
from registry.package import read_package
from registry.static_scan import scan_package as static_scan_package
from tests.fixtures import contract_manifest

TARGET = "linux-arm64"
BACKEND_SIZE = 32 * 1024 * 1024
CHUNK = 64 * 1024
# The ELF64 little-endian header of an arm64 executable (e_machine 183).
ELF_ARM64 = b"\x7fELF\x02\x01\x01" + b"\0" * 11 + (183).to_bytes(2, "little")
AWS_KEY = b"\nAKIA" + b"Q" * 16 + b"\n"


def _frozen() -> float:
    """A clock that never advances: the scan's 30 s budget must not cut a
    32 MiB random executable short on a loaded machine (that would make the
    result depend on timing, not on how the package is read)."""
    return 0.0


def _manifest() -> dict:
    manifest = contract_manifest("backend-only-skills.json")
    manifest["backend"]["methods"] = ["skills.list"]
    manifest["engines"] = {"navide": f">={MIN_NAVIDE_FOR_THIRD_PARTY_BACKEND}"}
    return manifest


def _write_large_package(path: Path, *, secret: bytes = b"") -> dict:
    """A backend-only package whose executable is BACKEND_SIZE bytes of
    incompressible data, so the archive itself is about that size too."""
    manifest = _manifest()
    backend = bytearray(ELF_ARM64 + os.urandom(BACKEND_SIZE - len(ELF_ARM64)))
    if secret:
        backend[BACKEND_SIZE // 2 : BACKEND_SIZE // 2 + len(secret)] = secret
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        info = zipfile.ZipInfo(manifest["backend"]["entry"])
        info.create_system = 3
        info.external_attr = (stat.S_IFREG | 0o755) << 16
        zf.writestr(info, bytes(backend))
    return manifest


async def _streamed_publish(app, package: Path, target: str) -> tuple[int, dict]:
    """POST /api/publish with the multipart body fed in small chunks."""
    boundary = "navide-memory-test-boundary"
    head = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="package"; filename="pkg.vsix"\r\n'
        "Content-Type: application/zip\r\n\r\n"
    ).encode()
    tail = f"\r\n--{boundary}--\r\n".encode()
    length = len(head) + package.stat().st_size + len(tail)

    def body():
        yield head
        with package.open("rb") as fp:
            while chunk := fp.read(CHUNK):
                yield chunk
        yield tail

    chunks = body()
    pending = next(chunks)

    async def receive():
        nonlocal pending
        if pending is None:
            return {"type": "http.disconnect"}
        current = pending
        pending = next(chunks, None)
        return {"type": "http.request", "body": current, "more_body": pending is not None}

    status = 0
    parts: list[bytes] = []

    async def send(message):
        nonlocal status
        if message["type"] == "http.response.start":
            status = message["status"]
        elif message["type"] == "http.response.body":
            parts.append(message.get("body", b""))

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/api/publish",
        "raw_path": b"/api/publish",
        "query_string": f"target={target}".encode(),
        "root_path": "",
        "headers": [
            (b"host", b"testserver"),
            (b"content-type", f"multipart/form-data; boundary={boundary}".encode()),
            (b"content-length", str(length).encode()),
        ],
        "client": ("127.0.0.1", 50000),
        "server": ("testserver", 80),
    }
    await app(scope, receive, send)
    return status, json.loads(b"".join(parts) or b"{}")


def _peak(run):
    tracemalloc.start()
    try:
        tracemalloc.reset_peak()
        result = run()
        return result, tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()


def test_publish_peak_heap_stays_far_below_package_size(client: TestClient, tmp_path: Path) -> None:
    package = tmp_path / "large.vsix"
    _write_large_package(package)
    size = package.stat().st_size
    assert size > 30 * 1024 * 1024

    (status, body), peak = _peak(lambda: asyncio.run(_streamed_publish(client.app, package, TARGET)))
    print(f"publish of {size / 2**20:.1f} MiB package: peak traced heap {peak / 2**20:.1f} MiB")

    assert status == 201, body
    digest = hashlib.sha256(package.read_bytes()).hexdigest()
    assert body["package_digest"] == digest
    # The stored blob is the uploaded archive, byte for byte.
    download = client.get(f"/api/extensions/navide/skills/1.0.0/download", params={"target": TARGET})
    assert download.status_code == 200
    assert hashlib.sha256(download.content).hexdigest() == digest
    # Before the fix the peak was several times the package size.
    assert peak < size / 4


def test_read_package_from_file_keeps_heap_small(tmp_path: Path) -> None:
    package = tmp_path / "large.vsix"
    _write_large_package(package)
    size = package.stat().st_size

    with package.open("rb") as fp:
        loaded, peak = _peak(lambda: read_package(fp, target=TARGET))
    print(f"read_package: peak traced heap {peak / 2**20:.1f} MiB")
    assert loaded.digest == hashlib.sha256(package.read_bytes()).hexdigest()
    assert peak < size / 4


def test_scanners_keep_heap_small_and_still_find_the_secret(tmp_path: Path) -> None:
    package = tmp_path / "large.vsix"
    manifest = _write_large_package(package, secret=AWS_KEY)
    size = package.stat().st_size

    with package.open("rb") as fp:
        report, peak = _peak(lambda: secret_scan.scan_package(fp, backend_prefix="backend/"))
    print(f"secret scan: peak traced heap {peak / 2**20:.1f} MiB")
    assert [f.rule for f in report.findings] == ["AWS access key id"]
    assert peak < size / 4

    with package.open("rb") as fp:
        scan, peak = _peak(
            lambda: static_scan_package(fp, artifact_digest="a" * 64, target=TARGET, manifest=manifest, clock=_frozen)
        )
    print(f"static scan: peak traced heap {peak / 2**20:.1f} MiB")
    assert scan is not None and scan["coverage"]["filesScanned"] == 1
    assert scan["native"][0]["format"] == "elf"
    assert peak < size / 4


def test_file_and_bytes_sources_give_identical_results(tmp_path: Path) -> None:
    """Reading from a file is a memory change only: digest, manifest, assets
    and both scan reports match the in-memory path exactly."""
    package = tmp_path / "large.vsix"
    manifest = _write_large_package(package, secret=AWS_KEY)
    data = package.read_bytes()
    with package.open("rb") as fp:
        from_file = read_package(fp, target=TARGET)
        secrets_file = secret_scan.scan_package(fp, backend_prefix="backend/")
        scan_file = static_scan_package(fp, artifact_digest="a" * 64, target=TARGET, manifest=manifest, clock=_frozen)
    from_bytes = read_package(data, target=TARGET)
    assert (from_file.digest, from_file.manifest, from_file.assets) == (
        from_bytes.digest,
        from_bytes.manifest,
        from_bytes.assets,
    )
    assert secrets_file == secret_scan.scan_package(data, backend_prefix="backend/")
    scan_bytes = static_scan_package(data, artifact_digest="a" * 64, target=TARGET, manifest=manifest, clock=_frozen)
    assert scan_file is not None and scan_bytes is not None
    scan_file.pop("scannedAt")
    scan_bytes.pop("scannedAt")
    assert scan_file == scan_bytes
