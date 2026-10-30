"""Plan document versions under ``<plans dir>/.history/<plan stem>/``.

Every version is a full, gzip-compressed copy of the plan file's bytes, named
``<YYYYMMDDTHHMMSS>_<stage><suffix>.gz``. A plan that embeds images as
``data:`` URIs is stored as ``<...><suffix>.parts.gz`` instead: its text with
each large base64 payload replaced by a reference to ``blobs/<sha256>`` in the
same directory, so an image unchanged across a hundred versions is stored
once (see :func:`_split_blobs`). Reading puts the payloads back and returns
the plan's bytes exactly. Older stage snapshots, named the same without
``.gz``, and plain ``.gz`` versions stay as they are and read the same
(:func:`read_version`); nothing is ever rewritten into a new form. ``sha256``
is always of the plan's own bytes. ``index.jsonl`` in the same directory
records, one JSON object per line, who made each version, when and why::

    {"file": "...html", "ts": "<ISO-8601>", "sha256": "<hex>", "stage": "draft",
     "author": {"kind": "user" | "agent" | "external", "pane": "<name or id>"?},
     "reason": "save" | "stage" | "restore" | "conflict" | "external",
     "restoredFrom": "<file>"?, "detached": true?}

A later line about the same file replaces an earlier one. A line that is not
valid JSON, or not an object of that shape, is skipped and reported; it never
hides the other versions. A snapshot with no line at all is an older stage
snapshot and is kept like one. ``{"announce": "<sha256>", "author", "reason",
"ts"}`` lines are a writer saying, just before it writes, whose bytes those
will be (see :func:`announce_write`); they are not versions.

Two processes record versions (the Plans backend, which knows who wrote, and
the core plans watcher, which also sees writes made outside the plan tools),
so every change to a history directory happens under one OS file lock on its
index. Only the standard library and fs_write's lock are used: the packaged
Plans backend bundles this module.

Retention (user decision 2026-10-30, g4): every version from the last 30 days
is kept; of older ones the newest 50 are kept; stage snapshots are kept
forever. Only snapshot files inside the history directory, and blobs no
remaining version refers to, are ever removed; there is no size limit.
"""

from __future__ import annotations

import base64
import binascii
import gzip
import hashlib
import json
import os
import re
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from .fs_write import _target_lock

HISTORY_DIR_NAME = ".history"
INDEX_NAME = "index.jsonl"
MERGE_WINDOW = timedelta(minutes=10)
KEEP_ALL_FOR = timedelta(days=30)
KEEP_OLDER = 50
# A writer that knows who wrote may relabel a version the watcher recorded
# first for the same bytes, within this long of it.
ATTRIBUTION_WINDOW = timedelta(seconds=60)

AUTHOR_KINDS = frozenset({"user", "agent", "external"})
REASONS = frozenset({"save", "stage", "restore", "conflict", "external"})
# Versions a later change of the same author may fold into: a save into the
# same author's save, and a change the watcher saw into the watcher's previous
# version (agents editing a plan directly do so many times a day). Only the
# newest attached version is ever folded into, so a named version in between
# always ends the run; stage, restore and pinned conflict versions never fold.
# A Plans write announces itself first, so the watcher never mistakes it for
# an outside change and folds it into one.
_MERGEABLE = frozenset({"save", "external"})
# Kept forever by retention.
_PERMANENT = frozenset({"stage"})

_TS_FORMAT = "%Y%m%dT%H%M%S"
SNAPSHOT_NAME_RE = re.compile(r"(\d{8}T\d{6})_([a-z-]+)(\.html|\.plan\.md)(\.gz|\.parts\.gz)?")
COMPRESSED_SUFFIX = ".gz"
PARTS_SUFFIX = ".parts.gz"

# Embedded images (user decision 2026-10-30, PR6 option A).
BLOBS_DIR_NAME = "blobs"
# Shorter base64 payloads (icons, tiny images) stay in the version's text.
BLOB_MIN_LENGTH = 1024
_BLOB_NAME_RE = re.compile(r"[0-9a-f]{64}")
_DATA_URI_RE = re.compile(rb"data:[A-Za-z0-9.+/-]+(?:;[A-Za-z0-9=.+-]+)*;base64,([A-Za-z0-9+/]+={0,2})")
# A parts version, once uncompressed, is this line and then records:
#   b"L<n>\n" + n literal bytes,
#   b"D<sha256>\n" a blob holding decoded base64, put back encoded,
#   b"B<sha256>\n" a blob holding the payload text as it was.
_PARTS_HEADER = b"navide-plan-parts 1\n"

Warn = Callable[[str], None]


def _no_warn(_message: str) -> None:
    return None


def history_dir_for(plan_path: Path) -> Path:
    """``<plan's dir>/.history/<stem>`` for ``<stem>.html`` or ``<stem>.plan.md``."""
    name = plan_path.name
    stem = name[: -len(".plan.md")] if name.endswith(".plan.md") else plan_path.stem
    return plan_path.parent / HISTORY_DIR_NAME / stem


def suffix_for(plan_path: Path) -> str:
    return ".plan.md" if plan_path.name.endswith(".plan.md") else ".html"


def _valid_entry(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    file = value.get("file")
    author = value.get("author")
    return (
        isinstance(file, str)
        and SNAPSHOT_NAME_RE.fullmatch(file) is not None
        and isinstance(value.get("ts"), str)
        and isinstance(value.get("sha256"), str)
        and isinstance(value.get("stage"), str)
        and isinstance(author, dict)
        and author.get("kind") in AUTHOR_KINDS
        # Which agent pane, when the Host says so (a name or id, nothing else).
        and isinstance(author.get("pane", ""), str)
        and value.get("reason") in REASONS
    )


def _valid_announcement(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("announce"), str)
        and isinstance(value.get("ts"), str)
        and isinstance(value.get("author"), dict)
        and value["author"].get("kind") in AUTHOR_KINDS - {"external"}
        and isinstance(value["author"].get("pane", ""), str)
        and value.get("reason") in REASONS
    )


def read_index(
    history_dir: Path, warn: Warn = _no_warn, announcements: list[dict[str, Any]] | None = None,
) -> dict[str, dict[str, Any]]:
    """Each snapshot file's latest index entry. Bad lines are skipped and
    reported through ``warn``; a missing or unreadable index is empty.
    Announcement lines are collected into ``announcements`` when given."""
    path = history_dir / INDEX_NAME
    try:
        raw = path.read_bytes()
    except OSError:
        return {}
    entries: dict[str, dict[str, Any]] = {}
    for number, line in enumerate(raw.split(b"\n"), start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            warn(f"{path}: line {number} is not JSON; skipped")
            continue
        if isinstance(value, dict) and "announce" in value:
            if _valid_announcement(value):
                if announcements is not None:
                    announcements.append(value)
            else:
                warn(f"{path}: line {number} is not a write announcement; skipped")
            continue
        if not _valid_entry(value):
            warn(f"{path}: line {number} is not a version entry; skipped")
            continue
        entries[value["file"]] = value
    return entries


def read_version(history_dir: Path, name: str) -> bytes:
    """A version's plan bytes, uncompressed whatever form it was stored in.
    ``name`` must be a snapshot name; a symbolic link is refused."""
    if SNAPSHOT_NAME_RE.fullmatch(name) is None:
        raise ValueError("not a version name")
    path = history_dir / name
    if path.is_symlink():
        raise OSError(f"{path} is a symbolic link")
    data = path.read_bytes()
    if name.endswith(PARTS_SUFFIX):
        return _join_parts(history_dir, gzip.decompress(data))
    return gzip.decompress(data) if name.endswith(COMPRESSED_SUFFIX) else data


def _split_blobs(data: bytes) -> tuple[bytes, dict[str, bytes]] | None:
    """``data`` as a parts version and the blobs it refers to, by sha256 of
    their stored bytes; None when it embeds no large base64 ``data:`` URI.

    A payload that decodes and encodes back to itself is stored decoded (a
    quarter smaller); any other is stored as its text."""
    out = [_PARTS_HEADER]
    blobs: dict[str, bytes] = {}
    last = 0
    for match in _DATA_URI_RE.finditer(data):
        payload = match.group(1)
        if len(payload) < BLOB_MIN_LENGTH:
            continue
        try:
            decoded: bytes | None = base64.b64decode(payload, validate=True)
        except (binascii.Error, ValueError):
            decoded = None
        if decoded is not None and base64.b64encode(decoded) == payload:
            kind, stored = b"D", decoded
        else:
            kind, stored = b"B", payload
        sha = hashlib.sha256(stored).hexdigest()
        blobs[sha] = stored
        start, end = match.span(1)
        out += [b"L%d\n" % (start - last), data[last:start], kind + sha.encode("ascii") + b"\n"]
        last = end
    if not blobs:
        return None
    out += [b"L%d\n" % (len(data) - last), data[last:]]
    return b"".join(out), blobs


def _parse_parts(raw: bytes) -> list[tuple[bytes, bytes]]:
    """The records of an uncompressed parts version: (b"L", literal bytes) or
    (b"D" | b"B", sha256). Raises ValueError for anything malformed."""
    if not raw.startswith(_PARTS_HEADER):
        raise ValueError("not a parts version")
    records: list[tuple[bytes, bytes]] = []
    pos = len(_PARTS_HEADER)
    while pos < len(raw):
        end = raw.find(b"\n", pos)
        if end < 0:
            raise ValueError("truncated parts version")
        kind, value = raw[pos:pos + 1], raw[pos + 1:end]
        pos = end + 1
        if kind == b"L" and value.isdigit():
            length = int(value)
            if pos + length > len(raw):
                raise ValueError("truncated parts version")
            records.append((kind, raw[pos:pos + length]))
            pos += length
        elif kind in (b"D", b"B") and _BLOB_NAME_RE.fullmatch(value.decode("ascii", "replace")):
            records.append((kind, value))
        else:
            raise ValueError("malformed parts version")
    return records


def _join_parts(history_dir: Path, raw: bytes) -> bytes:
    out = []
    for kind, value in _parse_parts(raw):
        if kind == b"L":
            out.append(value)
            continue
        stored = _read_blob(history_dir, value.decode("ascii"))
        out.append(base64.b64encode(stored) if kind == b"D" else stored)
    return b"".join(out)


def _read_blob(history_dir: Path, sha: str) -> bytes:
    blobs_dir = history_dir / BLOBS_DIR_NAME
    path = blobs_dir / sha
    if blobs_dir.is_symlink() or path.is_symlink():
        raise OSError(f"{path} is a symbolic link")
    stored = path.read_bytes()
    if hashlib.sha256(stored).hexdigest() != sha:
        raise ValueError(f"{path} is damaged")
    return stored


def _safe_blobs_dir(history_dir: Path) -> Path | None:
    """``blobs/`` in ``history_dir``, created if needed, or None when it is a
    symbolic link or would leave the history directory."""
    blobs_dir = history_dir / BLOBS_DIR_NAME
    try:
        if blobs_dir.is_symlink():
            return None
        blobs_dir.mkdir(exist_ok=True)
        if blobs_dir.resolve() != history_dir.resolve() / BLOBS_DIR_NAME:
            return None
    except OSError:
        return None
    return blobs_dir


def _write_blob(blobs_dir: Path, sha: str, stored: bytes) -> None:
    """Store a blob once; one already there is kept unless it is damaged."""
    path = blobs_dir / sha
    try:
        if path.is_file() and not path.is_symlink() and hashlib.sha256(path.read_bytes()).hexdigest() == sha:
            return
    except OSError:
        pass
    if path.is_symlink():
        path.unlink()
    _write_atomic(path, stored)


def _stored_form(history_dir: Path, base: str, data: bytes) -> tuple[str, bytes]:
    """The file name (``base`` plus its suffix) and bytes a version of ``data``
    is written as, with any blobs it refers to already stored."""
    split = _split_blobs(data)
    blobs_dir = _safe_blobs_dir(history_dir) if split is not None else None
    if split is None or blobs_dir is None:
        # mtime=0: the same bytes always compress to the same file.
        return base + COMPRESSED_SUFFIX, gzip.compress(data, mtime=0)
    parts, blobs = split
    for sha, stored in blobs.items():
        _write_blob(blobs_dir, sha, stored)
    return base + PARTS_SUFFIX, gzip.compress(parts, mtime=0)


def _blob_refs(history_dir: Path, name: str) -> set[str]:
    """The blobs a version refers to (none for any other form)."""
    if not name.endswith(PARTS_SUFFIX):
        return set()
    raw = gzip.decompress((history_dir / name).read_bytes())
    return {value.decode("ascii") for kind, value in _parse_parts(raw) if kind != b"L"}


def _sweep_blobs(history_dir: Path, candidates: set[str] | None, warn: Warn) -> None:
    """Remove the blobs no version in ``history_dir`` refers to, among
    ``candidates`` (every blob when None). Nothing is removed while any parts
    version cannot be read, since its references are unknown."""
    blobs_dir = history_dir / BLOBS_DIR_NAME
    if candidates == set() or blobs_dir.is_symlink() or not blobs_dir.is_dir():
        return
    referenced: set[str] = set()
    for child in history_dir.iterdir():
        if (
            not child.name.endswith(PARTS_SUFFIX)
            or SNAPSHOT_NAME_RE.fullmatch(child.name) is None
            or child.is_symlink()
            or not child.is_file()
        ):
            continue
        try:
            referenced |= _blob_refs(history_dir, child.name)
        except (OSError, ValueError, EOFError, gzip.BadGzipFile) as error:
            warn(f"{child}: unreadable version; no image blob removed: {error}")
            return
    for blob in blobs_dir.iterdir():
        name = blob.name
        if _BLOB_NAME_RE.fullmatch(name) is None or blob.is_symlink() or name in referenced:
            continue
        if candidates is not None and name not in candidates:
            continue
        try:
            blob.unlink()
        except OSError as error:
            warn(f"{blob}: could not remove an unused image blob: {error}")


def _plan_suffix(name: str) -> str:
    """The plan format a version name belongs to (``.html`` or ``.plan.md``)."""
    match = SNAPSHOT_NAME_RE.fullmatch(name)
    return match.group(3) if match else ""


def list_versions(history_dir: Path, warn: Warn = _no_warn) -> list[dict[str, Any]]:
    """Every snapshot in ``history_dir``, newest first, with its index entry
    when it has one (``entry: None`` for an older stage snapshot)."""
    if not history_dir.is_dir():
        return []
    entries = read_index(history_dir, warn)
    versions = []
    for child in history_dir.iterdir():
        match = SNAPSHOT_NAME_RE.fullmatch(child.name)
        if match is None or child.is_symlink() or not child.is_file():
            continue
        versions.append({"file": child.name, "stage": match.group(2), "entry": entries.get(child.name)})
    # Newest first: names carry the time, and a directory holds one version
    # per second (older snapshots may share one; their order stays stable).
    versions.sort(key=lambda version: (version["file"].split("_", 1)[0], version["file"]), reverse=True)
    return versions


def _file_time(name: str) -> datetime | None:
    match = SNAPSHOT_NAME_RE.fullmatch(name)
    if match is None:
        return None
    try:
        return datetime.strptime(match.group(1), _TS_FORMAT).astimezone()
    except ValueError:
        return None


def _write_atomic(target: Path, data: bytes) -> None:
    tmp = target.parent / f".{target.name}.{uuid.uuid4().hex}.tmp"
    try:
        tmp.write_bytes(data)
        os.replace(tmp, target)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _append(history_dir: Path, entry: dict[str, Any]) -> None:
    line = (json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    fd = os.open(history_dir / INDEX_NAME, os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_BINARY", 0), 0o600)
    try:
        os.write(fd, line)
    finally:
        os.close(fd)


def _compact(history_dir: Path, entries: dict[str, dict[str, Any]], present: set[str]) -> None:
    """Rewrite the index with one line per existing snapshot."""
    lines = [
        json.dumps(entries[name], ensure_ascii=False, separators=(",", ":"))
        for name in sorted(entries)
        if name in present
    ]
    _write_atomic(history_dir / INDEX_NAME, ("\n".join(lines) + "\n" if lines else "").encode("utf-8"))


def _same_author(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return a.get("kind") == b.get("kind") and a.get("pane") == b.get("pane")


def _safe_history_dir(plan_path: Path) -> Path | None:
    """The plan's history directory, created if needed, or None when it would
    leave the plan's directory (a symbolic link planted as ``.history`` or as
    the stem). Checked before anything is created, so nothing lands outside."""
    history_root = plan_path.parent / HISTORY_DIR_NAME
    history_dir = history_dir_for(plan_path)
    try:
        if history_root.is_symlink() or history_dir.is_symlink():
            return None
        history_root.mkdir(exist_ok=True)
        history_dir.mkdir(exist_ok=True)
        expected = plan_path.parent.resolve() / HISTORY_DIR_NAME / history_dir.name
        if history_dir.resolve() != expected:
            return None
    except OSError:
        return None
    return history_dir


def announce_write(
    plan_path: Path, data: bytes, *, author: dict[str, Any], reason: str,
    now: datetime | None = None, warn: Warn = _no_warn,
) -> None:
    """Say, just before writing ``data`` to ``plan_path``, whose bytes they are.

    The watcher may see the new file before the writer records its version;
    with the announcement it records the writer as the author instead of an
    outside change, so it never folds the write into the previous outside
    version. An announcement older than a minute is ignored.
    """
    if reason not in REASONS or author.get("kind") not in AUTHOR_KINDS - {"external"}:
        raise ValueError("invalid announcement")
    history_dir = _safe_history_dir(plan_path)
    if history_dir is None:
        warn(f"{plan_path}: history directory is not inside the plan's directory; not announced")
        return
    moment = (now or datetime.now()).astimezone()
    with _target_lock(history_dir / INDEX_NAME):
        _append(history_dir, {
            "announce": hashlib.sha256(data).hexdigest(), "author": dict(author), "reason": reason,
            "ts": moment.isoformat(),
        })


def record_version(
    plan_path: Path,
    data: bytes,
    *,
    stage: str,
    author: dict[str, Any],
    reason: str,
    restored_from: str | None = None,
    detached: bool = False,
    now: datetime | None = None,
    warn: Warn = _no_warn,
) -> str | None:
    """Record ``data`` as a version of ``plan_path``; returns the snapshot name
    written or relabelled, or None when nothing changed.

    - Bytes equal to the newest version are not stored twice; a known author
      relabels a version the watcher recorded for them moments ago.
    - A save by the same author within 10 minutes of their last save replaces
      it, unless the stage changed. The watcher's versions never merge.
    - A change of stage is always its own version (``reason: stage``).
    - ``detached`` versions (the side the user did not keep in a conflict)
      are stored but never become the version later writes compare against.
    """
    if (
        reason not in REASONS
        or author.get("kind") not in AUTHOR_KINDS
        or not isinstance(author.get("pane", ""), str)
        or set(author) - {"kind", "pane"}
    ):
        raise ValueError("invalid version reason or author")
    history_dir = _safe_history_dir(plan_path)
    if history_dir is None:
        warn(f"{plan_path}: history directory is not inside the plan's directory; not recorded")
        return None
    suffix = suffix_for(plan_path)
    now = (now or datetime.now()).astimezone()
    sha = hashlib.sha256(data).hexdigest()
    with _target_lock(history_dir / INDEX_NAME):
        announcements: list[dict[str, Any]] = []
        read_index(history_dir, announcements=announcements)
        if author["kind"] == "external":
            for announcement in reversed(announcements):
                announced = _parse_ts(announcement["ts"])
                if (
                    announcement["announce"] == sha
                    and announced is not None
                    and timedelta(0) <= now - announced <= ATTRIBUTION_WINDOW
                ):
                    # A Plans write the watcher saw first: record its author.
                    author, reason = dict(announcement["author"]), announcement["reason"]
                    break
        versions = list_versions(history_dir, warn)
        attached = [
            version for version in versions
            if _plan_suffix(version["file"]) == suffix and not (version["entry"] or {}).get("detached")
        ]
        newest = attached[0] if attached else None
        newest_entry = newest["entry"] if newest else None
        if newest is not None and newest_entry is None:
            # An older stage snapshot: give it the entry it never had.
            try:
                legacy_sha = hashlib.sha256(read_version(history_dir, newest["file"])).hexdigest()
            except (OSError, ValueError, EOFError, gzip.BadGzipFile):
                legacy_sha = ""
            when = _file_time(newest["file"])
            newest_entry = {
                "file": newest["file"], "ts": (when or now).isoformat(), "sha256": legacy_sha,
                "stage": newest["stage"], "author": {"kind": "external"}, "reason": "stage",
            }
            _append(history_dir, newest_entry)
        if not detached and reason != "conflict" and newest_entry is not None and newest_entry["sha256"] == sha:
            # Same bytes: relabel the watcher's version when the real author
            # arrives right after it, otherwise nothing to do.
            recorded = _parse_ts(newest_entry["ts"])
            if (
                newest_entry["author"]["kind"] == "external"
                and author["kind"] != "external"
                and newest_entry["reason"] == "external"
                and recorded is not None
                and now - recorded <= ATTRIBUTION_WINDOW
            ):
                _append(history_dir, {**newest_entry, "author": dict(author), "reason": reason})
                return newest_entry["file"]
            return None
        if not detached and reason == "conflict" and newest_entry is not None and newest_entry["sha256"] == sha:
            # Pin the version already holding these bytes: nothing folds into it.
            _append(history_dir, {**newest_entry, "reason": "conflict"})
            return newest_entry["file"]

        if (
            not detached
            and reason in {"save", "external"}
            and (newest_entry is None or newest_entry["stage"] != stage)
        ):
            # The first version is the baseline, kept like a stage snapshot.
            reason = "stage"
        merged_from: str | None = None
        if (
            not detached
            and reason in _MERGEABLE
            and newest_entry is not None
            and newest_entry["reason"] == reason
            and _same_author(newest_entry["author"], author)
            and newest_entry["stage"] == stage
            # Only a compressed version is folded into: an older uncompressed
            # file is never rewritten.
            and newest_entry["file"].endswith(COMPRESSED_SUFFIX)
        ):
            recorded = _parse_ts(newest_entry["ts"])
            if recorded is not None and timedelta(0) <= now - recorded <= MERGE_WINDOW:
                merged_from = newest_entry["file"]
        if merged_from is not None:
            base = merged_from.removesuffix(PARTS_SUFFIX).removesuffix(COMPRESSED_SUFFIX)
            try:
                replaced_refs = _blob_refs(history_dir, merged_from)
            except (OSError, ValueError, EOFError, gzip.BadGzipFile):
                replaced_refs = set()
        else:
            # One version per second per directory, whatever its stage or
            # form, so name order is always time order.
            taken = {version["file"].split("_", 1)[0] for version in versions}
            moment = now
            while moment.strftime(_TS_FORMAT) in taken:
                moment += timedelta(seconds=1)
            base = f"{moment.strftime(_TS_FORMAT)}_{stage}{suffix}"
            replaced_refs = set()
        target_name, stored = _stored_form(history_dir, base, data)
        _write_atomic(history_dir / target_name, stored)
        if merged_from is not None and merged_from != target_name:
            # The folded-into version changed form (images added or removed).
            (history_dir / merged_from).unlink(missing_ok=True)
        entry: dict[str, Any] = {
            "file": target_name, "ts": now.isoformat(), "sha256": sha, "stage": stage,
            "author": dict(author), "reason": reason,
        }
        if restored_from is not None:
            entry["restoredFrom"] = restored_from
        if detached:
            entry["detached"] = True
        _append(history_dir, entry)
        unused = replaced_refs - _blob_refs(history_dir, target_name) if replaced_refs else set()
        _prune(history_dir, now, warn, unused)
        return target_name


def prune_history(history_dir: Path, now: datetime | None = None, warn: Warn = _no_warn) -> None:
    """Apply retention to ``history_dir`` under its lock."""
    if not history_dir.is_dir() or history_dir.is_symlink():
        return
    with _target_lock(history_dir / INDEX_NAME):
        _prune(history_dir, (now or datetime.now()).astimezone(), warn)
        # Also clears blobs a crash left behind before their version was written.
        _sweep_blobs(history_dir, None, warn)


def _parse_ts(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.astimezone()


def _prune(history_dir: Path, now: datetime, warn: Warn, unused: set[str] | None = None) -> None:
    """Apply retention to one history directory (caller holds its lock), then
    remove the blobs only removed versions, or ``unused``, referred to."""
    versions = list_versions(history_dir, warn)
    older: list[str] = []
    for version in versions:
        entry = version["entry"]
        if entry is None or entry["reason"] in _PERMANENT:
            continue  # stage snapshots, including older ones without an entry
        when = _parse_ts(entry["ts"]) or _file_time(version["file"])
        if when is None or now - when <= KEEP_ALL_FOR:
            continue
        older.append(version["file"])
    present = {version["file"] for version in versions}
    removed = False
    candidates = set(unused or ())
    for name in older[KEEP_OLDER:]:  # versions are newest first
        target = history_dir / name
        if SNAPSHOT_NAME_RE.fullmatch(name) is None or target.parent != history_dir or target.is_symlink():
            continue
        try:
            candidates |= _blob_refs(history_dir, name)
        except (OSError, ValueError, EOFError, gzip.BadGzipFile):
            pass
        try:
            target.unlink()
        except OSError as error:
            warn(f"{target}: could not remove an expired version: {error}")
            continue
        present.discard(name)
        removed = True
    entries = read_index(history_dir)
    # Keep the index from growing without bound: merges append a line per save.
    line_count = 0
    try:
        line_count = (history_dir / INDEX_NAME).read_bytes().count(b"\n")
    except OSError:
        pass
    if removed or line_count > 4 * max(len(present), 16):
        _compact(history_dir, entries, present)
    _sweep_blobs(history_dir, candidates, warn)
