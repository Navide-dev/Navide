"""Large skill files as blobs: sealed on this machine, stored in object storage.

A skill whose files do not fit in one sync record (the ``skills`` scope carries
only its settings then) has its files moved as blobs. A record in the
``skill-files`` scope lists them — path → blob id, size, key id — and that
record is sealed and synced like any other. This module is the blob half:
naming a file, uploading it, downloading it back. It does not decide which
skills take part; the scope adapter does.

Neither end ever holds a whole file. On the way up the file is read twice,
both times as a stream: once to name it (a keyed hash, ``sync_keyring.blob_hasher``),
once to seal it segment by segment straight into the upload. On the way down the
object is read as a stream, each segment opened as it arrives and written to a
staging file, and the name is recomputed at the end; only a file whose name
matches ever leaves staging.

The bytes never touch the Navide server. It hands out short-lived presigned
URLs (``blobs.presignPut`` / ``blobs.presignGet``) and object storage is spoken
to directly — which is also why a file of hundreds of megabytes is not bound
by the 1 MiB WebSocket frame. The layout below comes from ``blobs.caps``:

    segment = nonce ‖ AES-GCM(≤ segment_bytes of plaintext) ‖ tag
    part    = segments_per_part whole segments (S3 multipart; only the last is short)

so part ``n`` starts at plaintext offset ``(n-1) × segment_bytes × segments_per_part``,
and a resumed upload re-seals exactly the parts object storage does not hold.
HTTP is the standard library's: nothing here adds a dependency.
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
from dataclasses import dataclass
from http.client import HTTPException
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from . import sync_keyring
from .db import Database

log = logging.getLogger("agent_team_backend.skill_blobs")

_COMPONENT = "skill_blobs"
#: How much of a file is read at a time while naming it.
_HASH_READ = 1024 * 1024
#: Per-request socket timeout. A stalled transfer fails and is resumed, rather
#: than holding a sync round forever.
_HTTP_TIMEOUT_S = 60
#: Parts presigned per request; URLs expire, so they are fetched in small runs.
_PRESIGN_BATCH = 16
#: Whole-download attempts. Each resumes from what staging already verified.
_DOWNLOAD_ATTEMPTS = 3

#: ``(request_type, payload) -> reply``: the server link's raw request, the same
#: callable the sync engine is given. A reply is ``{ok, payload}`` or ``{ok: False, error}``.
RequestFn = Callable[[str, dict[str, Any]], Awaitable[Any]]
#: ``(done_bytes, total_bytes)``, called as a transfer advances.
Progress = Callable[[int, int], None]


class BlobError(Exception):
    """A blob could not be moved. Retrying later is always safe."""


class BlobRemoteError(BlobError):
    """The server refused a blob request."""

    def __init__(self, code: str, message: str, details: Any = None) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.details = details


class BlobIntegrityError(BlobError):
    """What came back is not what was named: tampered, truncated, or another file."""


class BlobChanged(BlobError):
    """The file changed while it was being uploaded; it is named again next round."""


#: Most blob ids one ``blobs.stat`` may ask about (server blobs.ts MAX_STAT).
STAT_BATCH = 256
#: Most blob ids one record may name, when ``blobs.caps`` does not say
#: (server blobs.ts MAX_REFS).
MAX_REFS = 256


@dataclass(frozen=True)
class Layout:
    """How a blob is cut, as the server reported it in ``blobs.caps``."""

    segment_bytes: int
    segments_per_part: int
    #: Most distinct blobs one record may name; the server refuses more.
    max_refs: int = MAX_REFS

    @property
    def sealed_segment(self) -> int:
        return self.segment_bytes + sync_keyring.BLOB_SEGMENT_OVERHEAD

    @property
    def part_bytes(self) -> int:
        return self.segments_per_part * self.sealed_segment

    def segment_count(self, size: int) -> int:
        """Segments for *size* plaintext bytes. An empty file is one empty segment,
        so every blob has at least one tag to check."""
        return max(1, -(-size // self.segment_bytes))

    def sealed_size(self, size: int) -> int:
        return size + self.segment_count(size) * sync_keyring.BLOB_SEGMENT_OVERHEAD

    def part_count(self, size: int) -> int:
        return -(-self.segment_count(size) // self.segments_per_part)

    def part_segments(self, part_number: int, size: int) -> range:
        first = (part_number - 1) * self.segments_per_part
        return range(first, min(first + self.segments_per_part, self.segment_count(size)))

    def part_sealed_size(self, part_number: int, size: int) -> int:
        segs = self.part_segments(part_number, size)
        plain = min(size, segs.stop * self.segment_bytes) - segs.start * self.segment_bytes
        return plain + len(segs) * sync_keyring.BLOB_SEGMENT_OVERHEAD


@dataclass(frozen=True)
class BlobRef:
    """One file as a manifest names it. ``size`` is the plaintext size."""

    blob_id: str
    kid: str
    size: int

    def to_manifest(self) -> dict[str, Any]:
        return {"blob": self.blob_id, "kid": self.kid, "size": self.size}

    @classmethod
    def from_manifest(cls, entry: Any) -> BlobRef:
        if not isinstance(entry, dict):
            raise BlobError("a manifest entry is not an object")
        blob_id, kid, size = entry.get("blob"), entry.get("kid"), entry.get("size")
        if not (isinstance(blob_id, str) and len(blob_id) == 64 and all(c in "0123456789abcdef" for c in blob_id)):
            raise BlobError("a manifest entry names no valid blob id")
        if not (isinstance(kid, str) and kid) or not (isinstance(size, int) and size >= 0):
            raise BlobError("a manifest entry has no key id or size")
        return cls(blob_id, kid, size)


def _payload(reply: Any) -> dict[str, Any]:
    if not isinstance(reply, dict):
        raise BlobError("the server sent a reply that is not an object")
    if not reply.get("ok"):
        error = reply.get("error") if isinstance(reply.get("error"), dict) else {}
        raise BlobRemoteError(
            str(error.get("code") or "UNKNOWN"),
            str(error.get("message") or "the server refused the request"),
            error.get("details"),
        )
    payload = reply.get("payload")
    return payload if isinstance(payload, dict) else {}


async def server_layout(request: RequestFn) -> Layout | None:
    """The server's blob layout, or None when it has no blob storage.

    None covers both a server that predates blobs (``UNKNOWN_TYPE``) and one
    running without object storage (``UNSUPPORTED``): either way large skills
    keep syncing their settings without their files, exactly as before.
    """
    try:
        caps = _payload(await request("blobs.caps", {}))
    except BlobRemoteError as err:
        if err.code in ("UNKNOWN_TYPE", "UNSUPPORTED"):
            return None
        raise
    if caps.get("version") != 2:
        log.info("the server offers blob layout version %r; this build speaks 2", caps.get("version"))
        return None
    layout = Layout(int(caps["segmentBytes"]), int(caps["segmentsPerPart"]),
                    int(caps.get("maxRefs") or MAX_REFS))
    if layout.part_bytes != int(caps.get("partBytes") or 0):
        raise BlobError("the server's part size does not follow from its segment layout")
    return layout


# ── naming ────────────────────────────────────────────────────────────


def hash_file(path: Path, kid: str | None = None) -> BlobRef:
    """Name *path* by a keyed hash of its contents, reading it as a stream."""
    kid, mac = sync_keyring.blob_hasher(kid)
    size = 0
    with open(path, "rb") as fh:
        while chunk := fh.read(_HASH_READ):
            mac.update(chunk)
            size += len(chunk)
    return BlobRef(mac.hexdigest(), kid, size)


def _schema_v1(cur: Any) -> None:
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS skill_blob_digests (
            path     TEXT    PRIMARY KEY,
            size     INTEGER NOT NULL,
            mtime_ns INTEGER NOT NULL,
            kid      TEXT    NOT NULL,
            blob_id  TEXT    NOT NULL
        )
        """
    )


def _schema_v2(cur: Any) -> None:
    cur.execute("CREATE TABLE IF NOT EXISTS skill_file_executable (path TEXT PRIMARY KEY)")


class DigestCache:
    """Blob names of files already hashed, keyed by path, size and mtime.

    A sync round lists every large skill's files; without this each round would
    re-read hundreds of megabytes to learn nothing changed. A hit needs the same
    size, the same mtime and the same key: a rotation renames every blob.
    """

    def __init__(self, db: Database) -> None:
        self._db = db
        self._db.migrate(_COMPONENT, 1, _schema_v1)
        self._db.migrate(_COMPONENT, 2, _schema_v2)

    def ref_for(self, path: Path) -> BlobRef:
        st = path.stat()
        kid = sync_keyring.active_key_id()
        with self._db.transaction() as cur:
            row = cur.execute(
                "SELECT size, mtime_ns, kid, blob_id FROM skill_blob_digests WHERE path = ?",
                (str(path),),
            ).fetchone()
        if row is not None and row[0] == st.st_size and row[1] == st.st_mtime_ns and row[2] == kid:
            return BlobRef(row[3], row[2], row[0])
        ref = hash_file(path)
        after = path.stat()
        if (after.st_size, after.st_mtime_ns) == (st.st_size, st.st_mtime_ns):
            # Only remembered when the file held still while it was read.
            with self._db.transaction() as cur:
                cur.execute(
                    "INSERT INTO skill_blob_digests (path, size, mtime_ns, kid, blob_id) VALUES (?, ?, ?, ?, ?)"
                    " ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ns = excluded.mtime_ns,"
                    " kid = excluded.kid, blob_id = excluded.blob_id",
                    (str(path), ref.size, st.st_mtime_ns, ref.kid, ref.blob_id),
                )
        return ref

    def is_executable(self, path: Path) -> bool:
        """Whether *path* last landed marked executable, on a file system whose
        modes cannot say so themselves."""
        with self._db.transaction() as cur:
            row = cur.execute("SELECT 1 FROM skill_file_executable WHERE path = ?", (str(path),)).fetchone()
        return row is not None

    def set_executable(self, path: Path, executable: bool) -> None:
        with self._db.transaction() as cur:
            if executable:
                cur.execute("INSERT OR IGNORE INTO skill_file_executable (path) VALUES (?)", (str(path),))
            else:
                cur.execute("DELETE FROM skill_file_executable WHERE path = ?", (str(path),))


# ── upload ────────────────────────────────────────────────────────────


class _SealedPart(io.RawIOBase):
    """One multipart part as a readable stream, sealing a segment at a time.

    Handed to urllib as the request body with an explicit Content-Length, so
    http.client pulls it in small blocks and at most one segment of plaintext
    and one of ciphertext are in memory.
    """

    def __init__(self, fh: io.BufferedReader, ref: BlobRef, layout: Layout, part_number: int) -> None:
        self._fh = fh
        self._ref = ref
        self._layout = layout
        self._segments = iter(layout.part_segments(part_number, ref.size))
        self._count = layout.segment_count(ref.size)
        self._buf = b""
        self._pos = 0
        fh.seek((part_number - 1) * layout.segments_per_part * layout.segment_bytes)

    def readable(self) -> bool:
        return True

    def readinto(self, out: Any) -> int:
        while self._pos >= len(self._buf):
            index = next(self._segments, None)
            if index is None:
                return 0
            plain = self._fh.read(self._layout.segment_bytes)
            self._buf = sync_keyring.seal_segment(
                plain, kid=self._ref.kid, blob_id=self._ref.blob_id, index=index, count=self._count
            )
            self._pos = 0
        # An offset, not a slice: slicing the rest off after every small read
        # would copy a whole segment per block the socket takes.
        n = min(len(out), len(self._buf) - self._pos)
        out[:n] = memoryview(self._buf)[self._pos : self._pos + n]
        self._pos += n
        return n


def _put_part(url: str, path: Path, ref: BlobRef, layout: Layout, part_number: int, stamp: tuple[int, int]) -> int:
    """Seal and PUT one part. Returns the bytes sent. Runs in a worker thread."""
    with open(path, "rb") as fh:
        body = _SealedPart(fh, ref, layout, part_number)
        length = layout.part_sealed_size(part_number, ref.size)
        # Content-Type is explicit because urllib otherwise labels any body as a
        # url-encoded form, and a server that believes it tries to parse 8 MiB of
        # ciphertext as fields. It is not part of the presigned signature.
        req = Request(
            url,
            data=io.BufferedReader(body),
            method="PUT",
            headers={"Content-Length": str(length), "Content-Type": "application/octet-stream"},
        )
        try:
            with urlopen(req, timeout=_HTTP_TIMEOUT_S) as res:
                res.read()
        except (HTTPError, URLError, OSError) as err:
            raise BlobError(f"part {part_number} did not upload: {err}") from err
    st = path.stat()
    if (st.st_size, st.st_mtime_ns) != stamp:
        raise BlobChanged(f"{path} changed while it was being uploaded")
    return length


async def upload(
    request: RequestFn, path: Path, ref: BlobRef, layout: Layout, progress: Progress | None = None
) -> None:
    """Put *path* up as blob *ref*, resuming whatever object storage already holds.

    Returns once the blob is complete on the server — straight away when it
    already was (same file elsewhere in this account: that is the dedup).
    """
    st = path.stat()
    stamp = (st.st_size, st.st_mtime_ns)
    if st.st_size != ref.size:
        raise BlobChanged(f"{path} is no longer the file that was named")
    total = layout.sealed_size(ref.size)
    for attempt in range(2):
        begun = _payload(await request("blobs.begin", {"blobId": ref.blob_id, "sizeBytes": total}))
        if begun.get("state") == "complete":
            if progress:
                progress(total, total)
            return
        part_count = int(begun.get("partCount") or 0)
        if part_count != layout.part_count(ref.size):
            raise BlobError("the server cut this blob into a different number of parts")
        held = {int(p["partNumber"]) for p in begun.get("parts") or [] if isinstance(p, dict)}
        done = sum(int(p.get("size") or 0) for p in begun.get("parts") or [] if isinstance(p, dict))
        if progress:
            progress(done, total)
        todo = [n for n in range(1, part_count + 1) if n not in held]
        for i in range(0, len(todo), _PRESIGN_BATCH):
            signed = _payload(
                await request("blobs.presignPut", {"blobId": ref.blob_id, "partNumbers": todo[i : i + _PRESIGN_BATCH]})
            )
            for entry in signed.get("urls") or []:
                done += await asyncio.to_thread(
                    _put_part, str(entry["url"]), path, ref, layout, int(entry["partNumber"]), stamp
                )
                if progress:
                    progress(done, total)
        try:
            _payload(await request("blobs.commit", {"blobId": ref.blob_id}))
            return
        except BlobRemoteError as err:
            details = err.details if isinstance(err.details, dict) else {}
            # A part that went missing or came out the wrong size: one more pass
            # uploads exactly those. Anything else, or a second failure, is final.
            if err.code != "INCOMPLETE" or attempt:
                raise
            log.info("blob %s was incomplete after upload (%s); resuming once", ref.blob_id[:12], details)


# ── download ──────────────────────────────────────────────────────────


def _read_exact(stream: Any, n: int) -> bytes:
    chunks = []
    while n:
        try:
            chunk = stream.read(n)
        except (OSError, HTTPException) as err:
            # A reset mid-stream is a broken transfer like any other: retryable,
            # and resumed from the segments already verified.
            raise BlobError(f"the download broke off: {err}") from err
        if not chunk:
            break
        chunks.append(chunk)
        n -= len(chunk)
    return b"".join(chunks)


def _download_to(url: str, dest: Path, ref: BlobRef, layout: Layout, progress: Progress | None) -> None:
    """Stream the object into ``dest``'s staging file, opening each segment as
    it arrives. Resumes from the segments staging already verified. Runs in a
    worker thread."""
    staging = dest.with_name(dest.name + ".part")
    count = layout.segment_count(ref.size)
    have = staging.stat().st_size if staging.exists() else 0
    first = min(have // layout.segment_bytes, count - 1)
    total = layout.sealed_size(ref.size)
    _, mac = sync_keyring.blob_hasher(ref.kid)
    with open(staging, "a+b") as out:
        # Only whole verified segments are kept; the name is re-derived over them
        # so the final check still covers every byte of the file.
        out.truncate(first * layout.segment_bytes)
        out.seek(0)
        while chunk := out.read(_HASH_READ):
            mac.update(chunk)
        headers = {"Range": f"bytes={first * layout.sealed_segment}-"} if first else {}
        try:
            res = urlopen(Request(url, headers=headers), timeout=_HTTP_TIMEOUT_S)
        except (HTTPError, URLError, OSError) as err:
            raise BlobError(f"the blob did not download: {err}") from err
        with res:
            if first and res.status != 206:
                # The server ignored the range: start over from the top.
                first = 0
                out.truncate(0)
                _, mac = sync_keyring.blob_hasher(ref.kid)
            out.seek(0, os.SEEK_END)
            for index in range(first, count):
                plain_len = min(layout.segment_bytes, ref.size - index * layout.segment_bytes)
                sealed = _read_exact(res, plain_len + sync_keyring.BLOB_SEGMENT_OVERHEAD)
                if len(sealed) != plain_len + sync_keyring.BLOB_SEGMENT_OVERHEAD:
                    raise BlobError(f"the download stopped at segment {index} of {count}")
                try:
                    plain = sync_keyring.open_segment(
                        sealed, kid=ref.kid, blob_id=ref.blob_id, index=index, count=count
                    )
                except sync_keyring.UnknownKeyId:
                    raise
                except sync_keyring.KeyringError as err:
                    out.truncate(0)
                    raise BlobIntegrityError(str(err)) from err
                out.write(plain)
                mac.update(plain)
                if progress:
                    progress(min(total, (index + 1) * layout.sealed_segment), total)
            if res.read(1):
                out.truncate(0)
                raise BlobIntegrityError("the object is longer than the blob it claims to be")
        out.flush()
        os.fsync(out.fileno())
    if mac.hexdigest() != ref.blob_id:
        staging.unlink(missing_ok=True)
        raise BlobIntegrityError("the downloaded file is not the one the manifest names")
    os.replace(staging, dest)


async def download(
    request: RequestFn, ref: BlobRef, dest: Path, layout: Layout, progress: Progress | None = None
) -> None:
    """Fetch blob *ref* into *dest*, verified. *dest* only appears once every
    segment opened and the file's name matched; until then it is ``dest.part``,
    which a later call resumes from. A fresh URL is asked for on every attempt,
    because a stalled transfer can outlive one."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(_DOWNLOAD_ATTEMPTS):
        signed = _payload(await request("blobs.presignGet", {"blobId": ref.blob_id}))
        if int(signed.get("sizeBytes") or -1) != layout.sealed_size(ref.size):
            raise BlobIntegrityError("the stored blob is not the size the manifest names")
        try:
            await asyncio.to_thread(_download_to, str(signed["url"]), dest, ref, layout, progress)
            return
        except BlobIntegrityError:
            raise
        except BlobError as err:
            if attempt == _DOWNLOAD_ATTEMPTS - 1:
                raise
            log.info("download of blob %s broke off (%s); resuming", ref.blob_id[:12], err)
