"""Convenience features: the one gate every write outside Navide's data passes.

Navide may write the user's settings and other tools' configs when a feature
needs it, but always says so (docs/en-US/convenience-features.md). Each such
write belongs to a named convenience feature the user has allowed — all of
them are allowed by default, so today's behaviour is kept. ``apply`` runs one
write through the gate:

1. a feature that is off writes nothing;
2. an entry Navide wrote before and the user has since deleted turns the
   feature off — a removal is the user's choice, never re-added;
3. the target file is backed up into Navide's own data;
4. the write runs unchanged;
5. a change is announced (``notify``) and appended to the audit log.

A target that already carries Navide's entry when first seen was written
before this ledger existed (an upgraded install): it is adopted and named in
the one-time upgrade notice, or — first seen after that notice was decided,
as a per-spawn feature's target is — announced on its own as ``first``.
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .db import Database

log = logging.getLogger("agent_team_backend.convenience")


@dataclass(frozen=True)
class Feature:
    id: str
    #: Agent key, or "all".
    cli: str
    #: False for the features panes cannot run without: listed, never switched.
    toggleable: bool = True


REGISTRY: tuple[Feature, ...] = (
    Feature("claude.hooks", "claude"),
    Feature("qwen.hooks", "qwen"),
    Feature("copilot.hooks", "copilot"),
    Feature("codex.hook-trust", "codex"),
    Feature("codex.login-promote", "codex"),
    Feature("cursor.project-mcp", "cursor"),
    Feature("cursor.project-skills", "cursor"),
    Feature("credentials.auto-repair", "all"),
    Feature("codex.pane-homes", "codex", toggleable=False),
    Feature("pane-shims", "all", toggleable=False),
    Feature("claude.account-homes", "claude", toggleable=False),
)
_BY_ID = {feature.id: feature for feature in REGISTRY}

#: Log actions. ``first``/``repair``: a write changed a target; ``removed``:
#: the user deleted an entry; ``off``/``allowed``: the switch moved;
#: ``cleanup``: Navide took back its own entry; ``cleanup-failed``: it could
#: not, so the feature stayed on; ``removed-entry``: the user deleted one of
#: several entries in a target, which stays out while the rest keep working;
#: ``prompt``: a decision is waiting on the user.
ACTIONS = (
    "first", "repair", "removed", "removed-entry", "off", "allowed", "cleanup", "cleanup-failed", "prompt",
)

UPGRADE_KEY = "convenience.upgrade_notice"

#: Backups kept per target. Each is the whole file, secrets included, so a
#: target that changes on every pane start must not pile them up for ever; a
#: feature turned off or an entry removed keeps only its latest.
BACKUPS_PER_TARGET = 5


def feature(feature_id: str) -> Feature:
    return _BY_ID[feature_id]


@dataclass(frozen=True)
class Takeback:
    """One target the off switch takes Navide's entry back out of.

    ``present`` tells afterwards whether the entry is still there; without
    it the removal counts as done when ``remove`` did not raise. ``file`` is
    backed up before ``remove`` runs.
    """

    target: str
    remove: Callable[[], Any]
    present: Callable[[], bool] | None = None
    file: Path | None = None


class CleanupIncomplete(RuntimeError):
    """Off could not take Navide's entry back out of ``targets`` (a file
    that does not parse, a failed write). The feature stays allowed, because
    those entries still work; the user is told which targets and why."""

    def __init__(self, feature_id: str, targets: list[str]) -> None:
        super().__init__(f"{feature_id}: could not take Navide's entry back from {', '.join(targets)}")
        self.feature_id = feature_id
        self.targets = targets


class ConvenienceGate:
    """Ledger, switches and audit log, in navide.db. Thread-safe."""

    def __init__(
        self,
        db: Database,
        *,
        backup_root: Path,
        notify: Callable[[dict[str, Any]], None] | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.db = db
        self.backup_root = backup_root
        self.notify = notify
        self._clock = clock
        self._lock = threading.RLock()
        self._adopted: set[str] = set()
        with db.transaction() as cur:
            cur.execute(
                "CREATE TABLE IF NOT EXISTS convenience_features ("
                " id TEXT PRIMARY KEY, state TEXT NOT NULL, reason TEXT NOT NULL,"
                " updated_at INTEGER NOT NULL)"
            )
            cur.execute(
                "CREATE TABLE IF NOT EXISTS convenience_targets ("
                " feature TEXT NOT NULL, target TEXT NOT NULL, written_at INTEGER NOT NULL,"
                " present INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(feature, target))"
            )
            cur.execute(
                "CREATE TABLE IF NOT EXISTS convenience_log ("
                " id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,"
                " feature TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,"
                " detail TEXT NOT NULL, backup TEXT NOT NULL, notify INTEGER NOT NULL,"
                " source TEXT NOT NULL DEFAULT '')"
            )
            # The entries one target holds, for a target with several (one
            # hook per CLI event): what Navide wrote, and what the user
            # deleted by hand and so must never be written back.
            cur.execute(
                "CREATE TABLE IF NOT EXISTS convenience_parts ("
                " feature TEXT NOT NULL, target TEXT NOT NULL, part TEXT NOT NULL,"
                " state TEXT NOT NULL, PRIMARY KEY(feature, target, part))"
            )
            columns = {row[1] for row in cur.execute("PRAGMA table_info(convenience_log)").fetchall()}
            if "source" not in columns:
                cur.execute("ALTER TABLE convenience_log ADD COLUMN source TEXT NOT NULL DEFAULT ''")

    # ── switches ────────────────────────────────────────────────────────

    def state(self, feature_id: str) -> tuple[str, str]:
        feature(feature_id)
        with self.db.transaction() as cur:
            row = cur.execute(
                "SELECT state, reason FROM convenience_features WHERE id = ?", (feature_id,)
            ).fetchone()
        return (row["state"], row["reason"]) if row else ("allowed", "default")

    def allowed(self, feature_id: str) -> bool:
        return self.state(feature_id)[0] == "allowed"

    def set_allowed(
        self,
        feature_id: str,
        allowed: bool,
        *,
        remove: Callable[[], Any] | None = None,
        takeback: Callable[[], list[Takeback]] | None = None,
        source: str = "",
    ) -> None:
        """Move the switch. Off first takes back Navide's own entries.

        ``takeback`` lists them per target: each is backed up, removed and
        logged as ``cleanup``. When one cannot be taken back the switch does
        not move — the entry still works, so "off" would be untrue — and
        ``CleanupIncomplete`` names the targets. The flip is announced like
        any write, and ``source`` records who moved it (see ``record``).
        """
        if not feature(feature_id).toggleable:
            raise ValueError(f"{feature_id} is required and has no switch")
        with self._lock:
            if not allowed and remove is not None:
                remove()
            if not allowed and takeback is not None:
                self._take_back(feature_id, takeback())
            if not allowed:
                self._prune(feature_id, keep=1)
            self._set_state(feature_id, "allowed" if allowed else "off", "user")
            if allowed:
                # A fresh start: what the user deleted before re-allowing is
                # not a removal to hold against the next write.
                with self.db.transaction() as cur:
                    cur.execute("DELETE FROM convenience_targets WHERE feature = ?", (feature_id,))
                    cur.execute("DELETE FROM convenience_parts WHERE feature = ?", (feature_id,))
            self.record(feature_id, "allowed" if allowed else "off", "", source=source)

    def _take_back(self, feature_id: str, items: list[Takeback]) -> None:
        stuck: list[str] = []
        done: list[str] = []
        for item in items:
            before = _read(item.file)
            backup = self._backup(feature_id, item.target, before)
            error = ""
            try:
                item.remove()
            except Exception as err:  # noqa: BLE001 — reported below, never swallowed
                error = str(err) or type(err).__name__
            still = _probe(item.present) if item.present is not None else False
            if error or still is not False:
                stuck.append(item.target)
                reason = error or ("the file cannot be read" if still is None else "the entry is still there")
                self.record(
                    feature_id, "cleanup-failed", item.target,
                    detail=f"could not take Navide's entry back: {reason}", backup=backup,
                )
                continue
            done.append(item.target)
            if item.file is None or before != _read(item.file):
                self.record(
                    feature_id, "cleanup", item.target,
                    detail="took Navide's entry back", backup=backup, notify=False,
                )
        if stuck:
            # What was taken back is gone by Navide's own hand: the next write
            # is a first one again, never the user's removal.
            for target in done:
                self.forget(feature_id, target)
            raise CleanupIncomplete(feature_id, stuck)

    def _set_state(self, feature_id: str, state: str, reason: str) -> None:
        with self.db.transaction() as cur:
            cur.execute(
                "INSERT INTO convenience_features (id, state, reason, updated_at) VALUES (?, ?, ?, ?)"
                " ON CONFLICT(id) DO UPDATE SET state = excluded.state,"
                " reason = excluded.reason, updated_at = excluded.updated_at",
                (feature_id, state, reason, int(self._clock())),
            )

    # ── the gate ────────────────────────────────────────────────────────

    def apply(
        self,
        feature_id: str,
        target: str | Path,
        *,
        write: Callable[[], Any],
        present: Callable[[], bool],
        file: Path | None = None,
        detail: str = "",
        quiet_repairs: bool = False,
        parts: Callable[[], set[str]] | None = None,
        reset_when_missing: Path | None = None,
    ) -> str:
        """Run one write through the gate.

        Returns "off", "removed", "unchanged", "first" or "repair". ``file`` is
        the file whose bytes the write changes, when there is one: it is what
        gets backed up and compared. Without it every completed write counts
        as a change. ``quiet_repairs`` logs later changes without announcing
        them, for a target that grows routinely (one trust row per pane).
        An exception from ``write`` propagates after nothing was recorded. One
        from ``present`` reads as "unknown": a file the gate cannot read is
        never mistaken for a removal, and never recorded or adopted as one
        that carries Navide's entry either — fixing it later would otherwise
        read as the user's removal.

        ``parts`` lists the separate entries a target holds (one hook per
        event). One Navide wrote that is gone while others remain is the
        user's removal of that entry alone: it is logged as
        ``removed-entry``, ``excluded`` names it from then on so ``write``
        leaves it out, and the feature stays allowed for the rest.

        ``reset_when_missing`` is the path whose absence means the user
        reset the CLI rather than removed Navide's entry: the user's own file
        Navide merges into (a CLI's settings.json), or the CLI's whole config
        folder when the target file is Navide's alone. When it is gone,
        Navide's entry went with everything else: that is a fresh start, not
        the user's removal, so the target is forgotten and the next write is
        a ``first``.
        """
        feature(feature_id)
        key = str(target)
        with self._lock:
            if not self.allowed(feature_id):
                return "off"
            known = self._known(feature_id, key)
            was_present = _probe(present)
            if known and was_present is False and reset_when_missing is not None and not reset_when_missing.exists():
                self.forget(feature_id, key)
                known = False
            if known and was_present is False:
                self._set_state(feature_id, "off", "removed")
                self._mark(feature_id, key, present=False)
                self.record(feature_id, "removed", key, detail="deleted outside Navide")
                self._prune(feature_id, key, keep=1)
                return "removed"
            if parts is not None and known and was_present is True:
                self._note_removed_parts(feature_id, key, parts)
            before = _read(file)
            write()
            after = _read(file)
            changed = file is None or before != after
            # Only a target that now carries Navide's entry joins the ledger:
            # an installer that skipped wrote nothing, and remembering the
            # target would read its absence next time as the user's removal.
            now_present = _probe(present)
            if now_present is True:
                self._mark(feature_id, key, present=True)
                if parts is not None:
                    self._note_written_parts(feature_id, key, parts)
            elif known and now_present is False:
                self._mark(feature_id, key, present=False)
            if not changed:
                if not known and was_present is True:
                    self._adopt(feature_id, key)
                return "unchanged"
            action = "repair" if known else "first"
            backup = self._backup(feature_id, key, before)
            notify = not (quiet_repairs and action == "repair")
            self.record(feature_id, action, key, detail=detail, backup=backup, notify=notify)
            return action

    def excluded(self, feature_id: str, target: str | Path) -> frozenset[str]:
        """The entries of ``target`` the user deleted by hand."""
        with self.db.transaction() as cur:
            rows = cur.execute(
                "SELECT part FROM convenience_parts WHERE feature = ? AND target = ? AND state = 'removed'",
                (feature_id, str(target)),
            ).fetchall()
        return frozenset(row["part"] for row in rows)

    def _note_removed_parts(self, feature_id: str, key: str, parts: Callable[[], set[str]]) -> None:
        try:
            now = set(parts())
        except Exception as err:  # noqa: BLE001 — unknown is not removed
            log.warning("listing the entries of %s failed (%s); treating as unknown", key, err)
            return
        with self.db.transaction() as cur:
            written = {row["part"] for row in cur.execute(
                "SELECT part FROM convenience_parts WHERE feature = ? AND target = ? AND state = 'written'",
                (feature_id, key),
            ).fetchall()}
        for part in sorted(written - now):
            with self.db.transaction() as cur:
                cur.execute(
                    "UPDATE convenience_parts SET state = 'removed' WHERE feature = ? AND target = ? AND part = ?",
                    (feature_id, key, part),
                )
            self.record(feature_id, "removed-entry", f"{key} [{part}]", detail=part)

    def _note_written_parts(self, feature_id: str, key: str, parts: Callable[[], set[str]]) -> None:
        """Navide's own write decides what it wrote: an entry it no longer
        writes (a switched-off push channel) is not one the user removed."""
        try:
            now = set(parts())
        except Exception as err:  # noqa: BLE001
            log.warning("listing the entries of %s failed (%s)", key, err)
            return
        with self.db.transaction() as cur:
            cur.execute(
                "DELETE FROM convenience_parts WHERE feature = ? AND target = ? AND state = 'written'",
                (feature_id, key),
            )
            cur.executemany(
                "INSERT INTO convenience_parts (feature, target, part, state) VALUES (?, ?, ?, 'written')"
                " ON CONFLICT(feature, target, part) DO NOTHING",
                [(feature_id, key, part) for part in sorted(now)],
            )

    def _adopt(self, feature_id: str, key: str) -> None:
        """An entry an earlier Navide wrote, first seen now. During the
        startup pass it joins the one-time upgrade notice; after that notice
        was decided (a per-spawn feature, first seen when its pane opens) it
        is announced on its own, once, since the ledger now knows it."""
        if self.db.kv_get(UPGRADE_KEY) is None:
            self._adopted.add(feature_id)
            return
        self.record(feature_id, "first", key, detail="found Navide's entry from an earlier version; kept")

    def record(
        self,
        feature_id: str,
        action: str,
        target: str,
        *,
        detail: str = "",
        backup: str = "",
        notify: bool = True,
        source: str = "",
    ) -> dict[str, Any]:
        """Append to the audit log; announce it when ``notify``.

        ``source`` says who asked, for a row a caller triggered: "settings"
        (a Navide window), "ws-client" (any other client holding the backend
        token). Empty for what Navide did on its own.
        """
        feature(feature_id)
        if action not in ACTIONS:
            raise ValueError(action)
        at = int(self._clock())
        with self.db.transaction() as cur:
            cur.execute(
                "INSERT INTO convenience_log (at, feature, action, target, detail, backup, notify, source)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (at, feature_id, action, target, detail, backup, int(notify), source),
            )
            entry_id = cur.lastrowid
        entry = {
            "id": entry_id, "at": at, "feature": feature_id, "action": action,
            "target": target, "detail": detail, "backup": backup, "notify": notify,
            "source": source,
        }
        log.info("convenience %s %s %s %s", feature_id, action, target, detail)
        if notify and self.notify is not None:
            try:
                self.notify({"feature": feature_id, "entry": entry})
            except Exception as err:  # noqa: BLE001 — the log row is the record
                log.warning("announcing %s %s failed: %s", feature_id, action, err)
        return entry

    def note(self, feature_id: str, target: str | Path, *, detail: str = "") -> bool:
        """Disclose a target a required feature created, once: True the first
        time (logged and announced), False after that."""
        feature(feature_id)
        key = str(target)
        with self._lock:
            if self._known(feature_id, key):
                return False
            self._mark(feature_id, key, present=True)
            self.record(feature_id, "first", key, detail=detail)
            return True

    def forget(self, feature_id: str, target: str | Path) -> None:
        """Drop a target Navide took back itself (a reclaimed pane home)."""
        with self.db.transaction() as cur:
            cur.execute(
                "DELETE FROM convenience_targets WHERE feature = ? AND target = ?",
                (feature_id, str(target)),
            )
            cur.execute(
                "DELETE FROM convenience_parts WHERE feature = ? AND target = ?",
                (feature_id, str(target)),
            )

    def _known(self, feature_id: str, key: str) -> bool:
        with self.db.transaction() as cur:
            return cur.execute(
                "SELECT 1 FROM convenience_targets WHERE feature = ? AND target = ?",
                (feature_id, key),
            ).fetchone() is not None

    def _mark(self, feature_id: str, key: str, *, present: bool) -> None:
        with self.db.transaction() as cur:
            cur.execute(
                "INSERT INTO convenience_targets (feature, target, written_at, present)"
                " VALUES (?, ?, ?, ?) ON CONFLICT(feature, target) DO UPDATE SET"
                " present = excluded.present"
                + (", written_at = excluded.written_at" if present else ""),
                (feature_id, key, int(self._clock()), int(present)),
            )

    def _backup_dir(self, feature_id: str, key: str) -> Path:
        return self.backup_root / feature_id / hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]

    def _backup(self, feature_id: str, key: str, content: bytes | None) -> str:
        """Copy ``content`` into the target's own backup folder (deduplicated
        by content), then keep only its latest ``BACKUPS_PER_TARGET``."""
        if content is None:
            return ""
        digest = hashlib.sha256(content).hexdigest()
        path = self._backup_dir(feature_id, key) / f"{digest}.bak"
        try:
            if path.exists():
                os.utime(path)  # the same content again is the latest backup
            else:
                _private_dirs(self.backup_root, path.parent)
                # 0600 from creation: a backup holds the whole file, secrets
                # included, and must never be readable by others in between.
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as handle:
                    handle.write(content)
        except FileExistsError:
            pass
        except OSError as err:
            log.warning("backing up %s failed: %s", feature_id, err)
            return ""
        self._prune(feature_id, key, keep=BACKUPS_PER_TARGET)
        return str(path)

    def _prune(self, feature_id: str, key: str | None = None, *, keep: int) -> None:
        """Keep the latest ``keep`` backups of one target, or of every target
        of the feature."""
        root = self.backup_root / feature_id
        folders = [self._backup_dir(feature_id, key)] if key is not None else (
            [p for p in root.iterdir() if p.is_dir()] if root.is_dir() else []
        )
        for folder in folders:
            try:
                backups = sorted(folder.glob("*.bak"), key=lambda p: p.stat().st_mtime_ns, reverse=True)
                for stale in backups[keep:]:
                    stale.unlink()
            except OSError as err:
                log.warning("pruning backups of %s failed: %s", feature_id, err)

    # ── upgrade notice ──────────────────────────────────────────────────

    def upgrade_features(self) -> list[str]:
        return sorted(self._adopted)

    def finish_startup_scan(self) -> None:
        """After the startup writes: publish the one-time upgrade notice.

        Decided once. An install with nothing of Navide's already on disk is
        a fresh one, whose first writes are announced one by one instead.
        """
        if self.db.kv_get(UPGRADE_KEY) is not None:
            return
        features = self.upgrade_features()
        value = {"features": features, "acked": not features}
        self.db.kv_set(UPGRADE_KEY, value, now=int(self._clock()))

    def upgrade_notice(self) -> dict[str, Any] | None:
        value = self.db.kv_get(UPGRADE_KEY)
        if not isinstance(value, dict) or value.get("acked"):
            return None
        return {"features": list(value.get("features") or [])}

    def acknowledge_upgrade(self, *, source: str = "") -> None:
        """The user read the upgrade notice: each feature it named stays
        allowed, now with the user's say-so on the log."""
        value = self.db.kv_get(UPGRADE_KEY)
        if isinstance(value, dict):
            self.db.kv_set(UPGRADE_KEY, {**value, "acked": True}, now=int(self._clock()))
            if not value.get("acked"):
                for feature_id in value.get("features") or []:
                    if feature_id in _BY_ID:
                        self.record(
                            feature_id, "allowed", "", detail="kept allowed: upgrade notice acknowledged",
                            notify=False, source=source,
                        )

    # ── reads ───────────────────────────────────────────────────────────

    def history(self, feature_id: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
        query = "SELECT * FROM convenience_log"
        args: tuple[Any, ...] = ()
        if feature_id:
            query += " WHERE feature = ?"
            args = (feature_id,)
        query += " ORDER BY id DESC LIMIT ?"
        with self.db.transaction() as cur:
            rows = cur.execute(query, (*args, max(1, min(int(limit), 1000)))).fetchall()
        return [_entry(row) for row in rows]

    def notices(self, limit: int = 50) -> list[dict[str, Any]]:
        with self.db.transaction() as cur:
            rows = cur.execute(
                "SELECT * FROM convenience_log WHERE notify = 1 ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [_entry(row) for row in rows]

    def listing_feature(self, feature_id: str) -> dict[str, Any]:
        spec = feature(feature_id)
        state, reason = self.state(feature_id)
        with self.db.transaction() as cur:
            rows = cur.execute(
                "SELECT target, written_at, present FROM convenience_targets"
                " WHERE feature = ? ORDER BY target",
                (feature_id,),
            ).fetchall()
        return {
            "id": spec.id, "cli": spec.cli, "toggleable": spec.toggleable,
            "state": state, "reason": reason,
            "targets": [
                {"path": row["target"], "writtenAt": row["written_at"], "present": bool(row["present"])}
                for row in rows
            ],
        }

    def listing(self) -> dict[str, Any]:
        return {
            "features": [self.listing_feature(spec.id) for spec in REGISTRY],
            "notices": self.notices(),
            "upgrade": self.upgrade_notice(),
        }


def _probe(present: Callable[[], bool]) -> bool | None:
    """True or False as ``present`` says; None when it cannot tell."""
    try:
        return bool(present())
    except Exception as err:  # noqa: BLE001 — unreadable is neither present nor removed
        log.warning("presence check failed (%s); treating as unknown", err)
        return None


def _private_dirs(root: Path, leaf: Path) -> None:
    """Create ``leaf`` and every folder up to ``root`` as 0700."""
    relative = leaf.relative_to(root)
    for directory in [root / part for part in (*reversed(relative.parents), relative)]:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        directory.chmod(0o700)


def _read(file: Path | None) -> bytes | None:
    if file is None:
        return None
    try:
        return file.read_bytes() if file.is_file() else None
    except OSError:
        return None


def _entry(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"], "at": row["at"], "feature": row["feature"], "action": row["action"],
        "target": row["target"], "detail": row["detail"], "backup": row["backup"],
        "notify": bool(row["notify"]), "source": row["source"],
    }
