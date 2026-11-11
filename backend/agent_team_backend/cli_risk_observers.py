"""Read-only CLI risk observations. Unknown samples never assert absence."""

from __future__ import annotations

import asyncio
import concurrent.futures
import ipaddress
import os
import re
import socket
import stat
import threading
import time
from dataclasses import dataclass
from pathlib import Path

MIB100 = 100 * 1024 * 1024
SNIFF_BYTES = 64 * 1024
DNS_TTL = 300.0
DNS_TIMEOUT = 3.0
MAX_DECLARATIONS = 64
MAX_ADDRESSES = 256
MAX_FILES = 100_000
DISK_TIMEOUT = 20.0


def normalize_ip(value: str) -> str:
    ip = ipaddress.ip_address(value)
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return str(ip)


@dataclass(frozen=True)
class ExpectedAddresses:
    status: str
    addresses: frozenset[str] = frozenset()
    observed_at: float | None = None


class ExpectedResolver:
    """At most one daemon resolver job, even if libc DNS never returns.

    A timed-out getaddrinfo cannot be cancelled. Retaining its future prevents
    each subsequent poll from leaking another thread or queueing more work.
    """

    def __init__(self, *, clock=time.time, lookup=socket.getaddrinfo):
        self.clock = clock
        self.lookup = lookup
        self._pending: concurrent.futures.Future | None = None
        self._cache: dict[tuple[str, ...], ExpectedAddresses] = {}

    def _resolve(self, declarations: tuple[str, ...]) -> ExpectedAddresses:
        addresses: set[str] = set()
        deadline = time.monotonic() + DNS_TIMEOUT
        for name in declarations:
            if time.monotonic() > deadline:
                return ExpectedAddresses("unknown")
            try:
                addresses.add(normalize_ip(name))
            except ValueError:
                if not re.fullmatch(r"(?=.{1,253}\.?$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.?", name):
                    return ExpectedAddresses("unknown")
                answers = self.lookup(name, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
                if not answers:
                    return ExpectedAddresses("unknown")
                addresses.update(normalize_ip(row[4][0]) for row in answers)
            if len(addresses) > MAX_ADDRESSES:
                return ExpectedAddresses("unknown")
        return ExpectedAddresses("successful", frozenset(addresses), self.clock())

    async def resolve(self, declarations: tuple[str, ...]) -> ExpectedAddresses:
        if not declarations:
            return ExpectedAddresses("unsupported")
        if len(declarations) > MAX_DECLARATIONS:
            return ExpectedAddresses("unknown")
        key = tuple(sorted(set(declarations)))
        cached = self._cache.get(key)
        if cached and 0 <= self.clock() - cached.observed_at < DNS_TTL:
            return cached
        if self._pending is not None and not self._pending.done():
            return ExpectedAddresses("unknown")
        future: concurrent.futures.Future = concurrent.futures.Future()
        self._pending = future

        def run():
            try:
                future.set_result(self._resolve(key))
            except Exception:
                future.set_result(ExpectedAddresses("unknown"))

        threading.Thread(target=run, name="cli-risk-dns", daemon=True).start()
        try:
            result = await asyncio.wait_for(
                asyncio.shield(asyncio.wrap_future(future)), DNS_TIMEOUT
            )
        except TimeoutError:
            return ExpectedAddresses("unknown")
        if result.status == "successful":
            # One cache entry per active declaration profile, with bounded size.
            if len(self._cache) >= 64:
                self._cache.clear()
            self._cache[key] = result
        return result


@dataclass(frozen=True)
class DiskFile:
    size: int
    opaque: bool


@dataclass(frozen=True)
class DiskSample:
    status: str
    files: dict[str, DiskFile] | None = None
    root: str | None = None


def recognized_content(path: Path, data: bytes) -> bool:
    """Content signatures plus compatible suffixes; extensions never suffice."""
    suffix = path.suffix.lower()
    mach_o = {".dylib", ".so", ".node", ".bundle", ".bin"}
    formats = (
        (b"SQLite format 3\x00", {".db", ".sqlite", ".sqlite3"}),
        (b"PK\x03\x04", {".zip", ".jar", ".whl", ".npz", ".docx", ".xlsx"}),
        (b"\x1f\x8b", {".gz", ".tgz"}),
        (b"BZh", {".bz2"}),
        (b"\xfd7zXZ\x00", {".xz"}),
        (b"\x28\xb5\x2f\xfd", {".zst"}),
        (b"7z\xbc\xaf\x27\x1c", {".7z"}),
        (b"%PDF-", {".pdf"}),
        (b"\x89PNG\r\n\x1a\n", {".png"}),
        (b"\xff\xd8\xff", {".jpg", ".jpeg"}),
        (b"GGUF", {".gguf"}),
        (b"\x7fELF", {".so", ".bin", ".node"}),
        (b"\xcf\xfa\xed\xfe", mach_o),
        (b"\xfe\xed\xfa\xcf", mach_o),
        (b"\xce\xfa\xed\xfe", mach_o),
        (b"\xfe\xed\xfa\xce", mach_o),
        # Universal (fat) Mach-O; 0xCAFEBABE is also the Java class-file magic.
        (b"\xca\xfe\xba\xbe", mach_o | {".class"}),
        (b"\xbe\xba\xfe\xca", mach_o),
        (b"\xca\xfe\xba\xbf", mach_o),
        (b"MZ", {".exe", ".dll", ".node", ".sys"}),
    )
    for magic, suffixes in formats:
        if data.startswith(magic):
            return not suffix or suffix in suffixes
    if len(data) > 262 and data[257:262] == b"ustar":
        return suffix in ("", ".tar")
    if suffix in ("", ".txt", ".log", ".json", ".jsonl", ".csv", ".md", ".yaml", ".yml", ".toml"):
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            return False
        return bool(text) and all(ch.isprintable() or ch in "\r\n\t" for ch in text)
    return False


def scan_disk(root: str, *, deadline: float | None = None) -> DiskSample:
    """Bounded inventory; skip symlinks/reparse points, inspect regular files only."""
    base = Path(root)
    canonical_root = None
    files: dict[str, DiskFile] = {}
    deadline = deadline if deadline is not None else time.monotonic() + DISK_TIMEOUT
    pending = [base]
    visited = 0
    try:
        if not base.is_absolute():
            return DiskSample("unknown")
        # Declared homes may contain .. or a symlink prefix (e.g. macOS /tmp).
        # Resolve the approved root here, off the response path, then refuse
        # symlinks beneath that canonical boundary.
        base = base.resolve()
        canonical_root = str(base)
        pending = [base]
        try:
            root_stat = base.lstat()
        except FileNotFoundError:
            return DiskSample("successful", {}, str(base))
        if not stat.S_ISDIR(root_stat.st_mode):
            return DiskSample("unknown", root=str(base))
        while pending:
            directory = pending.pop()
            if directory.resolve() != directory:
                return DiskSample("unknown", root=str(base))
            with os.scandir(directory) as entries:
                for entry in entries:
                    visited += 1
                    if visited > MAX_FILES or time.monotonic() > deadline:
                        return DiskSample("unknown", root=str(base))
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                        continue
                    path = Path(entry.path)
                    # On Windows, DirEntry.stat() obtains FindFirstFile metadata
                    # whose device/inode fields are zero.  Use a real lstat for
                    # the identity that must match the descriptor below. On
                    # POSIX that stat already is an lstat.
                    path_stat = os.lstat(path) if os.name == "nt" else info
                    # The parent was checked canonical when it was popped and
                    # this entry is no symlink or reparse point, so the path is
                    # canonical too; a per-file resolve() made a 100k-file home
                    # exceed the scan budget. Directories are still resolved.
                    if not path.is_relative_to(base):
                        return DiskSample("unknown", root=str(base))
                    if stat.S_ISDIR(info.st_mode):
                        pending.append(path)
                    elif stat.S_ISREG(info.st_mode):
                        opaque = False
                        if path_stat.st_size > MIB100:
                            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
                            fd = os.open(path, flags)
                            try:
                                opened = os.fstat(fd)
                                if (opened.st_dev, opened.st_ino, opened.st_size) != (path_stat.st_dev, path_stat.st_ino, path_stat.st_size):
                                    return DiskSample("unknown", root=str(base))
                                data = os.read(fd, SNIFF_BYTES)
                                if len(data) != SNIFF_BYTES:
                                    return DiskSample("unknown", root=str(base))
                                opaque = not recognized_content(path, data)
                            finally:
                                os.close(fd)
                        files[str(path)] = DiskFile(path_stat.st_size, opaque)
        return DiskSample("successful", files, str(base))
    except (OSError, ValueError, RuntimeError):
        return DiskSample("unknown", root=canonical_root)
