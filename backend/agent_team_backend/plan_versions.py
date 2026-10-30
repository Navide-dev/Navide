"""Plan document versions under ``<plans dir>/.history/<plan stem>/``.

Every version is a full copy of the plan file's bytes, named
``<YYYYMMDDTHHMMSS>_<stage><suffix>`` as the stage snapshots before it were,
so an older Plans view still lists them. ``index.jsonl`` in the same directory
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
forever. Only snapshot files inside the history directory are ever removed;
there is no size limit.
"""

from __future__ import annotations

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
SNAPSHOT_NAME_RE = re.compile(r"(\d{8}T\d{6})_([a-z-]+)(\.html|\.plan\.md)")

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
    versions.sort(key=lambda version: version["file"], reverse=True)
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
            if version["file"].endswith(suffix) and not (version["entry"] or {}).get("detached")
        ]
        newest = attached[0] if attached else None
        newest_entry = newest["entry"] if newest else None
        if newest is not None and newest_entry is None:
            # An older stage snapshot: give it the entry it never had.
            try:
                legacy_sha = hashlib.sha256((history_dir / newest["file"]).read_bytes()).hexdigest()
            except OSError:
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
        target_name: str | None = None
        if (
            not detached
            and reason in _MERGEABLE
            and newest_entry is not None
            and newest_entry["reason"] == reason
            and _same_author(newest_entry["author"], author)
            and newest_entry["stage"] == stage
        ):
            recorded = _parse_ts(newest_entry["ts"])
            if recorded is not None and timedelta(0) <= now - recorded <= MERGE_WINDOW:
                target_name = newest_entry["file"]
        if target_name is None:
            moment = now
            while True:
                target_name = f"{moment.strftime(_TS_FORMAT)}_{stage}{suffix}"
                if not (history_dir / target_name).exists():
                    break
                moment += timedelta(seconds=1)
        _write_atomic(history_dir / target_name, data)
        entry: dict[str, Any] = {
            "file": target_name, "ts": now.isoformat(), "sha256": sha, "stage": stage,
            "author": dict(author), "reason": reason,
        }
        if restored_from is not None:
            entry["restoredFrom"] = restored_from
        if detached:
            entry["detached"] = True
        _append(history_dir, entry)
        _prune(history_dir, now, warn)
        return target_name


def prune_history(history_dir: Path, now: datetime | None = None, warn: Warn = _no_warn) -> None:
    """Apply retention to ``history_dir`` under its lock."""
    if not history_dir.is_dir() or history_dir.is_symlink():
        return
    with _target_lock(history_dir / INDEX_NAME):
        _prune(history_dir, (now or datetime.now()).astimezone(), warn)


def _parse_ts(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.astimezone()


def _prune(history_dir: Path, now: datetime, warn: Warn) -> None:
    """Apply retention to one history directory (caller holds its lock)."""
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
    for name in older[KEEP_OLDER:]:  # versions are newest first
        target = history_dir / name
        if SNAPSHOT_NAME_RE.fullmatch(name) is None or target.parent != history_dir or target.is_symlink():
            continue
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
