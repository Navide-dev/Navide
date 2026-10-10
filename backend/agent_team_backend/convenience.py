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
before this ledger existed (an upgraded install): it is adopted silently and
named in the one-time upgrade notice.
"""

from __future__ import annotations

import hashlib
import logging
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
#: ``cleanup``: Navide took back its own entry; ``prompt``: a decision is
#: waiting on the user.
ACTIONS = ("first", "repair", "removed", "off", "allowed", "cleanup", "prompt")

UPGRADE_KEY = "convenience.upgrade_notice"


def feature(feature_id: str) -> Feature:
    return _BY_ID[feature_id]


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
                " detail TEXT NOT NULL, backup TEXT NOT NULL, notify INTEGER NOT NULL)"
            )

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
        self, feature_id: str, allowed: bool, *, remove: Callable[[], Any] | None = None
    ) -> None:
        """Move the switch. Off first takes back Navide's own entries."""
        if not feature(feature_id).toggleable:
            raise ValueError(f"{feature_id} is required and has no switch")
        with self._lock:
            if not allowed and remove is not None:
                remove()
            self._set_state(feature_id, "allowed" if allowed else "off", "user")
            if allowed:
                # A fresh start: what the user deleted before re-allowing is
                # not a removal to hold against the next write.
                with self.db.transaction() as cur:
                    cur.execute("DELETE FROM convenience_targets WHERE feature = ?", (feature_id,))
            self.record(feature_id, "allowed" if allowed else "off", "", notify=False)

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
    ) -> str:
        """Run one write through the gate.

        Returns "off", "removed", "unchanged", "first" or "repair". ``file`` is
        the file whose bytes the write changes, when there is one: it is what
        gets backed up and compared. Without it every completed write counts
        as a change. An exception from ``write`` propagates after nothing was
        recorded; one from ``present`` reads as "present", so a file the gate
        cannot read is never mistaken for a removal.
        """
        feature(feature_id)
        key = str(target)
        with self._lock:
            if not self.allowed(feature_id):
                return "off"
            known = self._known(feature_id, key)
            was_present = _safe(present)
            if known and not was_present:
                self._set_state(feature_id, "off", "removed")
                self._mark(feature_id, key, present=False)
                self.record(feature_id, "removed", key, detail="deleted outside Navide")
                return "removed"
            before = _read(file)
            write()
            after = _read(file)
            changed = file is None or before != after
            self._mark(feature_id, key, present=True)
            if not changed:
                if not known and was_present:
                    self._adopted.add(feature_id)
                return "unchanged"
            action = "repair" if known or was_present else "first"
            backup = self._backup(feature_id, before)
            self.record(feature_id, action, key, detail=detail, backup=backup)
            return action

    def record(
        self,
        feature_id: str,
        action: str,
        target: str,
        *,
        detail: str = "",
        backup: str = "",
        notify: bool = True,
    ) -> dict[str, Any]:
        """Append to the audit log; announce it when ``notify``."""
        feature(feature_id)
        if action not in ACTIONS:
            raise ValueError(action)
        at = int(self._clock())
        with self.db.transaction() as cur:
            cur.execute(
                "INSERT INTO convenience_log (at, feature, action, target, detail, backup, notify)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (at, feature_id, action, target, detail, backup, int(notify)),
            )
            entry_id = cur.lastrowid
        entry = {
            "id": entry_id, "at": at, "feature": feature_id, "action": action,
            "target": target, "detail": detail, "backup": backup, "notify": notify,
        }
        log.info("convenience %s %s %s %s", feature_id, action, target, detail)
        if notify and self.notify is not None:
            try:
                self.notify({"feature": feature_id, "entry": entry})
            except Exception as err:  # noqa: BLE001 — the log row is the record
                log.warning("announcing %s %s failed: %s", feature_id, action, err)
        return entry

    def forget(self, feature_id: str, target: str | Path) -> None:
        """Drop a target Navide took back itself (a reclaimed pane home)."""
        with self.db.transaction() as cur:
            cur.execute(
                "DELETE FROM convenience_targets WHERE feature = ? AND target = ?",
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

    def _backup(self, feature_id: str, content: bytes | None) -> str:
        if content is None:
            return ""
        digest = hashlib.sha256(content).hexdigest()
        path = self.backup_root / feature_id / f"{digest}.bak"
        try:
            if not path.exists():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
                path.chmod(0o600)
        except OSError as err:
            log.warning("backing up %s failed: %s", feature_id, err)
            return ""
        return str(path)

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

    def acknowledge_upgrade(self) -> None:
        value = self.db.kv_get(UPGRADE_KEY)
        if isinstance(value, dict):
            self.db.kv_set(UPGRADE_KEY, {**value, "acked": True}, now=int(self._clock()))

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


def _safe(present: Callable[[], bool]) -> bool:
    try:
        return bool(present())
    except Exception as err:  # noqa: BLE001 — unreadable is not removed
        log.warning("presence check failed (%s); treating as present", err)
        return True


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
        "notify": bool(row["notify"]),
    }
