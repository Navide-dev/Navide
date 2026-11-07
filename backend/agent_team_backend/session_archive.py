"""Opt-in archive of CLI session logs: compress idle logs, upload them to S3.

Everything is off by default (ArchiveSettingsStore.DEFAULTS) and nothing runs
unless the user turns it on. archive_candidates only decides which logs
qualify: a jsonl transcript nobody has written to for ``idle_days``, that is
not a session a pane is still bound to, and that has not been archived
already. compress_log writes ``<log>.zst`` next to the log and proves it by
decompressing it again; the original is removed only when the user also turned
on remove_originals, and only after that proof. upload_archive puts a ``.zst``
in the user's own bucket with server-side encryption, through the standard AWS
credential chain: Navide stores no AWS key.
"""

from __future__ import annotations

import hashlib
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .applog import app_data_dir
from .db import DB_FILENAME, Database

log = logging.getLogger("agent_team_backend.session_archive")

#: A log idle this long is finished: a CLI resuming it would write to it.
DEFAULT_IDLE_DAYS = 7

ARCHIVE_SUFFIX = ".zst"


@dataclass(frozen=True)
class Candidate:
    path: Path
    size: int
    mtime: float


def archive_candidates(
    roots: Iterable[Path],
    *,
    idle_days: int = DEFAULT_IDLE_DAYS,
    open_sessions: frozenset[str] = frozenset(),
    now: float | None = None,
) -> list[Candidate]:
    """jsonl logs under ``roots`` (any depth) idle for ``idle_days`` or more.

    A log whose stem is in ``open_sessions`` (a session a pane is bound to) is
    skipped however old it is, and so is one whose archive next to it is
    current (compress_log stamps the archive with the log's mtime, so a log
    resumed and written to since then qualifies again). Unreadable entries are
    skipped, never raised. Oldest first.
    """
    cutoff = (time.time() if now is None else now) - idle_days * 86_400
    out: list[Candidate] = []
    for root in roots:
        try:
            paths = list(root.rglob("*.jsonl"))
        except OSError:
            continue
        for path in paths:
            if path.stem in open_sessions:
                continue
            try:
                st = path.stat()
            except OSError:
                continue
            if _archived_mtime(path) >= st.st_mtime:
                continue
            if st.st_mtime <= cutoff:
                out.append(Candidate(path, st.st_size, st.st_mtime))
    return sorted(out, key=lambda c: c.mtime)


def _archived_mtime(path: Path) -> float:
    try:
        return path.with_name(path.name + ARCHIVE_SUFFIX).stat().st_mtime
    except OSError:
        return -1.0


_KV_KEY = "session_archive_settings"


class ArchiveSettingsStore:
    """The archive's settings, in navide.db. Every switch starts off."""

    DEFAULTS: dict[str, Any] = {
        "compress_enabled": False,
        "idle_days": DEFAULT_IDLE_DAYS,
        "remove_originals": False,   # delete a log once its .zst is proven
        "upload_enabled": False,
        "upload_after_days": 30,
        "s3_bucket": "",
        "s3_prefix": "navide-sessions/",
        "s3_region": "",
    }

    def __init__(self, db: Database | None = None) -> None:
        self._db = db or Database(app_data_dir() / DB_FILENAME)

    def get(self) -> dict[str, Any]:
        raw = self._db.kv_get(_KV_KEY)
        merged = dict(self.DEFAULTS)
        if isinstance(raw, dict):
            merged.update({k: raw[k] for k in self.DEFAULTS if k in raw})
        return merged

    def set(self, updates: dict[str, Any]) -> dict[str, Any]:
        current = self.get()
        for key, value in updates.items():
            if key in self.DEFAULTS and type(value) is type(self.DEFAULTS[key]):
                current[key] = value
        current["idle_days"] = max(1, current["idle_days"])
        current["upload_after_days"] = max(current["idle_days"], current["upload_after_days"])
        self._db.kv_set(_KV_KEY, current, now=int(time.time()))
        return current


def _sha256(chunks: Iterable[bytes]) -> str:
    digest = hashlib.sha256()
    for chunk in chunks:
        digest.update(chunk)
    return digest.hexdigest()


def _file_chunks(path: Path, size: int = 1 << 20) -> Iterable[bytes]:
    with path.open("rb") as fh:
        while chunk := fh.read(size):
            yield chunk


def _zst_chunks(path: Path, size: int = 1 << 20) -> Iterable[bytes]:
    import zstandard

    with path.open("rb") as fh, zstandard.ZstdDecompressor().stream_reader(fh) as reader:
        while chunk := reader.read(size):
            yield chunk


@dataclass(frozen=True)
class Compressed:
    source: Path
    archive: Path
    sha256: str
    removed_original: bool


def compress_log(path: Path, *, remove_original: bool = False, level: int = 19) -> Compressed:
    """Write ``<path>.zst`` and prove it decompresses to the same bytes.

    The archive is written to a temporary name and renamed into place, so a
    crash never leaves a half-written ``.zst`` that archive_candidates would
    take for a finished one. A log that changed while it was read, or an
    archive that does not decompress to its sha256, raises and leaves the log
    untouched. Only then, and only with remove_original, is the log removed.
    """
    import zstandard

    before = path.stat()
    archive = path.with_name(path.name + ARCHIVE_SUFFIX)
    tmp = path.with_name(path.name + ARCHIVE_SUFFIX + ".tmp")
    try:
        with path.open("rb") as src, tmp.open("wb") as dst:
            zstandard.ZstdCompressor(level=level).copy_stream(src, dst)
        original = _sha256(_file_chunks(path))
        after = path.stat()
        if (after.st_size, after.st_mtime_ns) != (before.st_size, before.st_mtime_ns):
            raise RuntimeError(f"{path} changed while it was compressed")
        if _sha256(_zst_chunks(tmp)) != original:
            raise RuntimeError(f"{tmp} does not decompress to {path}")
        os.replace(tmp, archive)
        # The archive carries the log's own age: uploads wait on it, and a log
        # written to later is newer than its archive again.
        os.utime(archive, ns=(before.st_atime_ns, before.st_mtime_ns))
    finally:
        tmp.unlink(missing_ok=True)
    if remove_original:
        path.unlink()
    return Compressed(path, archive, original, remove_original)


def s3_key(prefix: str, archive: Path, root: Path) -> str:
    """The object key: the prefix, then the archive's path under its root."""
    rel = archive.relative_to(root).as_posix()
    return f"{prefix.rstrip('/')}/{rel}" if prefix.strip("/") else rel


def _s3_client(settings: dict[str, Any]) -> Any:
    import boto3

    return boto3.client("s3", region_name=settings.get("s3_region") or None)


def upload_archive(
    archive: Path, root: Path, settings: dict[str, Any], client: Any = None,
) -> str:
    """Upload one ``.zst`` with SSE-S3 encryption and confirm its size; returns the key.

    ``client`` is a boto3 S3 client; without one it is made from the standard
    AWS credential chain (environment, shared profile, SSO), in the configured
    region. The upload is confirmed by reading the object's size back.
    """
    bucket = settings.get("s3_bucket") or ""
    if not bucket:
        raise ValueError("s3_bucket is not set")
    if client is None:
        client = _s3_client(settings)
    key = s3_key(str(settings.get("s3_prefix") or ""), archive, root)
    client.upload_file(
        str(archive), bucket, key, ExtraArgs={"ServerSideEncryption": "AES256"},
    )
    head = client.head_object(Bucket=bucket, Key=key)
    if int(head.get("ContentLength", -1)) != archive.stat().st_size:
        raise RuntimeError(f"s3://{bucket}/{key} does not match {archive}")
    return key


def _create_uploads_v1(cur: Any) -> None:
    cur.execute(
        "CREATE TABLE session_archive_uploads ("
        " archive TEXT PRIMARY KEY,"
        " mtime_ns INTEGER NOT NULL,"
        " bucket TEXT NOT NULL,"
        " key TEXT NOT NULL,"
        " uploaded_at INTEGER NOT NULL)"
    )


def run_once(
    settings: dict[str, Any],
    roots: Iterable[Path],
    db: Database,
    *,
    open_sessions: frozenset[str] = frozenset(),
    now: float | None = None,
    client: Any = None,
) -> dict[str, int]:
    """One archive pass: compress what qualifies, then upload what is old enough.

    Does nothing for a switch that is off. One file failing is logged and
    counted and never stops the pass. An archive is uploaded once per version
    (its path and mtime are recorded in navide.db).
    """
    roots = list(roots)
    now = time.time() if now is None else now
    counts = {"compressed": 0, "uploaded": 0, "failed": 0}
    if settings.get("compress_enabled"):
        for cand in archive_candidates(
            roots, idle_days=int(settings["idle_days"]), open_sessions=open_sessions, now=now,
        ):
            try:
                compress_log(cand.path, remove_original=bool(settings.get("remove_originals")))
                counts["compressed"] += 1
            except Exception as err:  # noqa: BLE001 — one log must not stop the pass
                log.warning("archive: compress %s failed: %s", cand.path, err)
                counts["failed"] += 1
    if settings.get("upload_enabled") and settings.get("s3_bucket"):
        db.migrate("session_archive", 1, _create_uploads_v1)
        cutoff = now - int(settings["upload_after_days"]) * 86_400
        with db.transaction() as cur:
            done = {
                (row[0], row[1]) for row in cur.execute(
                    "SELECT archive, mtime_ns FROM session_archive_uploads"
                ).fetchall()
            }
        for root in roots:
            try:
                archives = sorted(root.rglob("*.jsonl" + ARCHIVE_SUFFIX))
            except OSError:
                continue
            for archive in archives:
                try:
                    st = archive.stat()
                    if st.st_mtime > cutoff or (str(archive), st.st_mtime_ns) in done:
                        continue
                    if client is None:
                        client = _s3_client(settings)
                    key = upload_archive(archive, root, settings, client=client)
                    with db.transaction() as cur:
                        cur.execute(
                            "INSERT OR REPLACE INTO session_archive_uploads"
                            " (archive, mtime_ns, bucket, key, uploaded_at) VALUES (?, ?, ?, ?, ?)",
                            (str(archive), st.st_mtime_ns, settings["s3_bucket"], key, int(now)),
                        )
                    counts["uploaded"] += 1
                except Exception as err:  # noqa: BLE001
                    log.warning("archive: upload %s failed: %s", archive, err)
                    counts["failed"] += 1
    return counts
