"""Commanders: a named, long-lived agent identity that outlives its panes.

A commander is a record in the global ``navide.db`` (component
``commanders``) plus a local memory file. The pane it currently runs in is its
*body*; a body can be replaced (pane closed and reopened, CLI changed) while
the commander, its duty, memory and bindings stay the same.

What is stored is deliberately narrow:

- no credential of any kind: an account is referenced by its
  ``credential_vault`` id only, never a token, key or bot secret;
- the memory file lives under the app data dir with mode 0600 and is not part
  of cloud sync or the settings export;
- a commander manages the relations it created (dispatches, bindings,
  memory). It never stores or changes a pane's own capabilities.

Synchronous: every caller on the event loop goes through ``to_thread``.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from . import share_scan
from .applog import app_data_dir
from .db import Database

_COMPONENT = "commanders"
#: Schema version the code below writes. Bump with a new ``db.migrate`` step.
SCHEMA_VERSION = 1

DEFAULT_STALL_MINUTES = 20
MIN_STALL_MINUTES = 1
MAX_STALL_MINUTES = 24 * 60
MAX_NAME = 64
MAX_DUTY = 20_000
MAX_TASK = 200
MEMORY_FILE = "memory.md"


class CommanderInvalid(ValueError):
    pass


class CommanderNotFound(LookupError):
    pass


@dataclass
class Commander:
    id: str
    name: str
    icon: str = ""
    color: str = ""
    duty: str = ""
    #: Workspace paths; the first one is the main workspace.
    workspaces: list[str] = field(default_factory=list)
    agent_key: str = ""
    #: A credential_vault account id, or "" for the CLI's own default. Never a
    #: token.
    account_id: str = ""
    #: "" means the account's default model (no model is pinned).
    model: str = ""
    skills: list[str] = field(default_factory=list)
    mcp: list[str] = field(default_factory=list)
    stall_minutes: int = DEFAULT_STALL_MINUTES
    created_at: int = 0
    updated_at: int = 0
    #: 0 while active.
    archived_at: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class CommanderBody:
    commander_id: str
    pane_id: str
    workspace: str = ""
    agent_key: str = ""
    session_id: str = ""
    attached_at: int = 0
    #: 0 for the current body.
    detached_at: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class CommanderDispatch:
    commander_id: str
    #: The child pane.
    pane_id: str
    #: The pane that opened it directly: the commander's body, or a child of
    #: it for a grandchild.
    opened_by: str
    task: str = ""
    opened_at: int = 0
    #: 0 while the pane is open. The row is kept after it closes.
    closed_at: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class CommanderMigration:
    """A binding or schedule that upgrading a pane retargeted to the
    commander, with its original value so a downgrade can put it back."""

    commander_id: str
    #: "channel_binding", "scheduler_job", ... (owned by whoever migrates it).
    kind: str
    ref_id: str
    before_json: str
    migrated_at: int = 0
    #: 0 until a downgrade restored it.
    restored_at: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ── schema ─────────────────────────────────────────────────────────────────


def _create_schema(cur: sqlite3.Cursor) -> None:
    cur.execute(
        "CREATE TABLE commanders ("
        " id TEXT PRIMARY KEY,"
        " name TEXT NOT NULL,"
        " icon TEXT NOT NULL DEFAULT '',"
        " color TEXT NOT NULL DEFAULT '',"
        " duty TEXT NOT NULL DEFAULT '',"
        " workspaces TEXT NOT NULL DEFAULT '[]',"
        " agent_key TEXT NOT NULL DEFAULT '',"
        " account_id TEXT,"
        " model TEXT,"
        " skills TEXT NOT NULL DEFAULT '[]',"
        " mcp TEXT NOT NULL DEFAULT '[]',"
        f" stall_minutes INTEGER NOT NULL DEFAULT {DEFAULT_STALL_MINUTES},"
        " created_at INTEGER NOT NULL,"
        " updated_at INTEGER NOT NULL,"
        " archived_at INTEGER NOT NULL DEFAULT 0)"
    )
    # Unique among commanders that are not archived; case-insensitive.
    cur.execute(
        "CREATE UNIQUE INDEX commanders_name ON commanders (lower(name)) WHERE archived_at = 0"
    )
    cur.execute(
        "CREATE TABLE commander_bodies ("
        " commander_id TEXT NOT NULL,"
        " pane_id TEXT NOT NULL,"
        " workspace TEXT NOT NULL DEFAULT '',"
        " agent_key TEXT NOT NULL DEFAULT '',"
        " session_id TEXT NOT NULL DEFAULT '',"
        " attached_at INTEGER NOT NULL,"
        " detached_at INTEGER NOT NULL DEFAULT 0)"
    )
    cur.execute("CREATE INDEX commander_bodies_commander ON commander_bodies (commander_id, detached_at)")
    cur.execute("CREATE INDEX commander_bodies_pane ON commander_bodies (pane_id)")
    cur.execute(
        "CREATE TABLE commander_dispatches ("
        " commander_id TEXT NOT NULL,"
        " pane_id TEXT NOT NULL,"
        " opened_by TEXT NOT NULL DEFAULT '',"
        " task TEXT NOT NULL DEFAULT '',"
        " opened_at INTEGER NOT NULL,"
        " closed_at INTEGER NOT NULL DEFAULT 0)"
    )
    cur.execute("CREATE INDEX commander_dispatches_commander ON commander_dispatches (commander_id, opened_at)")
    cur.execute("CREATE INDEX commander_dispatches_pane ON commander_dispatches (pane_id)")
    cur.execute(
        "CREATE TABLE commander_migrations ("
        " commander_id TEXT NOT NULL,"
        " kind TEXT NOT NULL,"
        " ref_id TEXT NOT NULL,"
        " before_json TEXT NOT NULL,"
        " migrated_at INTEGER NOT NULL,"
        " restored_at INTEGER NOT NULL DEFAULT 0)"
    )
    cur.execute("CREATE INDEX commander_migrations_commander ON commander_migrations (commander_id, restored_at)")


# ── helpers ────────────────────────────────────────────────────────────────


def _names(value: Any, what: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise CommanderInvalid(f"{what} must be a list of strings")
    return [v.strip() for v in value if v.strip()]


def _check_name(name: Any) -> str:
    if not isinstance(name, str) or not name.strip():
        raise CommanderInvalid("a commander needs a name")
    name = name.strip()
    if len(name) > MAX_NAME:
        raise CommanderInvalid(f"name is longer than {MAX_NAME} characters")
    return name


def _check_stall(value: Any) -> int:
    try:
        minutes = int(value)
    except (TypeError, ValueError) as err:
        raise CommanderInvalid("stall_minutes must be a number") from err
    if not MIN_STALL_MINUTES <= minutes <= MAX_STALL_MINUTES:
        raise CommanderInvalid(f"stall_minutes must be {MIN_STALL_MINUTES}-{MAX_STALL_MINUTES}")
    return minutes


def _check_account_id(value: Any) -> str:
    """A credential_vault id; anything that looks like a credential itself is
    refused rather than stored."""
    account_id = str(value or "").strip()
    if len(account_id) > 128 or mask_secrets(account_id) != account_id:
        raise CommanderInvalid("account_id must be an account id, not a credential")
    return account_id


def _row(row: sqlite3.Row | tuple, cur: sqlite3.Cursor) -> dict[str, Any]:
    return {d[0]: row[i] for i, d in enumerate(cur.description)}


def _commander(row: dict[str, Any]) -> Commander:
    return Commander(
        id=row["id"],
        name=row["name"],
        icon=row["icon"] or "",
        color=row["color"] or "",
        duty=row["duty"] or "",
        workspaces=json.loads(row["workspaces"] or "[]"),
        agent_key=row["agent_key"] or "",
        account_id=row["account_id"] or "",
        model=row["model"] or "",
        skills=json.loads(row["skills"] or "[]"),
        mcp=json.loads(row["mcp"] or "[]"),
        stall_minutes=int(row["stall_minutes"]),
        created_at=int(row["created_at"]),
        updated_at=int(row["updated_at"]),
        archived_at=int(row["archived_at"]),
    )


#: Fields commander.update may change. id, timestamps and archived_at are not.
UPDATABLE = ("name", "icon", "color", "duty", "workspaces", "agent_key", "account_id", "model",
             "skills", "mcp", "stall_minutes")


def mask_secrets(text: str) -> str:
    """*text* with anything credential-shaped masked: a duty or a memory note
    is free text, and a pasted key must not land in the db or on disk."""
    return share_scan.scan(text, kind="text").text if text else text


class CommanderStore:
    def __init__(self, db: Database, memory_root: Path | None = None) -> None:
        self.db = db
        self._memory_root = memory_root
        db.migrate(_COMPONENT, 1, _create_schema)

    # ── commanders ──

    def create(
        self,
        *,
        name: str,
        icon: str = "",
        color: str = "",
        duty: str = "",
        workspaces: list[str] | None = None,
        agent_key: str = "",
        account_id: str = "",
        model: str = "",
        skills: list[str] | None = None,
        mcp: list[str] | None = None,
        stall_minutes: int = DEFAULT_STALL_MINUTES,
        now: int | None = None,
    ) -> Commander:
        now = int(time.time()) if now is None else now
        values = self._validated({
            "name": name, "icon": icon, "color": color, "duty": duty, "workspaces": workspaces,
            "agent_key": agent_key, "account_id": account_id, "model": model, "skills": skills,
            "mcp": mcp, "stall_minutes": stall_minutes,
        })
        commander = Commander(id=uuid.uuid4().hex, created_at=now, updated_at=now, **values)
        with self.db.transaction() as cur:
            self._ensure_unique(cur, commander.name, "")
            cur.execute(
                "INSERT INTO commanders (id, name, icon, color, duty, workspaces, agent_key, account_id, model,"
                " skills, mcp, stall_minutes, created_at, updated_at, archived_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
                (commander.id, commander.name, commander.icon, commander.color, commander.duty,
                 json.dumps(commander.workspaces), commander.agent_key, commander.account_id or None,
                 commander.model or None, json.dumps(commander.skills), json.dumps(commander.mcp),
                 commander.stall_minutes, now, now),
            )
        return commander

    def get(self, commander_id: str) -> Commander:
        with self.db.transaction() as cur:
            row = cur.execute("SELECT * FROM commanders WHERE id = ?", (commander_id,)).fetchone()
            if row is None:
                raise CommanderNotFound(commander_id)
            return _commander(_row(row, cur))

    def list(self, *, include_archived: bool = False) -> list[Commander]:
        sql = "SELECT * FROM commanders"
        if not include_archived:
            sql += " WHERE archived_at = 0"
        with self.db.transaction() as cur:
            rows = cur.execute(sql + " ORDER BY created_at, id").fetchall()
            return [_commander(_row(r, cur)) for r in rows]

    def update(self, commander_id: str, changes: dict[str, Any], *, now: int | None = None) -> Commander:
        unknown = set(changes) - set(UPDATABLE)
        if unknown:
            raise CommanderInvalid(f"cannot change {', '.join(sorted(unknown))}")
        current = self.get(commander_id)
        merged = {k: getattr(current, k) for k in UPDATABLE} | changes
        values = self._validated(merged)
        now = int(time.time()) if now is None else now
        with self.db.transaction() as cur:
            if current.archived_at == 0:
                self._ensure_unique(cur, values["name"], commander_id)
            cur.execute(
                "UPDATE commanders SET name = ?, icon = ?, color = ?, duty = ?, workspaces = ?, agent_key = ?,"
                " account_id = ?, model = ?, skills = ?, mcp = ?, stall_minutes = ?, updated_at = ? WHERE id = ?",
                (values["name"], values["icon"], values["color"], values["duty"], json.dumps(values["workspaces"]),
                 values["agent_key"], values["account_id"] or None, values["model"] or None,
                 json.dumps(values["skills"]), json.dumps(values["mcp"]), values["stall_minutes"], now,
                 commander_id),
            )
        return self.get(commander_id)

    def archive(self, commander_id: str, *, now: int | None = None) -> Commander:
        """Archived commanders keep every row; their name becomes free again."""
        now = int(time.time()) if now is None else now
        with self.db.transaction() as cur:
            changed = cur.execute(
                "UPDATE commanders SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at = 0",
                (now, now, commander_id),
            ).rowcount
        if not changed:
            self.get(commander_id)  # raises when it does not exist
        return self.get(commander_id)

    def _validated(self, raw: dict[str, Any]) -> dict[str, Any]:
        duty = mask_secrets(str(raw.get("duty") or ""))
        if len(duty) > MAX_DUTY:
            raise CommanderInvalid(f"duty is longer than {MAX_DUTY} characters")
        return {
            "name": _check_name(raw.get("name")),
            "icon": str(raw.get("icon") or "")[:16],
            "color": str(raw.get("color") or "")[:32],
            "duty": duty,
            "workspaces": _names(raw.get("workspaces"), "workspaces"),
            "agent_key": str(raw.get("agent_key") or "").strip(),
            "account_id": _check_account_id(raw.get("account_id")),
            "model": str(raw.get("model") or "").strip(),
            "skills": _names(raw.get("skills"), "skills"),
            "mcp": _names(raw.get("mcp"), "mcp"),
            "stall_minutes": _check_stall(raw.get("stall_minutes", DEFAULT_STALL_MINUTES)),
        }

    @staticmethod
    def _ensure_unique(cur: sqlite3.Cursor, name: str, own_id: str) -> None:
        row = cur.execute(
            "SELECT id FROM commanders WHERE lower(name) = lower(?) AND archived_at = 0 AND id != ?",
            (name, own_id),
        ).fetchone()
        if row is not None:
            raise CommanderInvalid(f"a commander named {name!r} already exists")

    # ── bodies ──

    def current_body(self, commander_id: str) -> CommanderBody | None:
        with self.db.transaction() as cur:
            row = cur.execute(
                "SELECT * FROM commander_bodies WHERE commander_id = ? AND detached_at = 0"
                " ORDER BY attached_at DESC, rowid DESC LIMIT 1",
                (commander_id,),
            ).fetchone()
            return CommanderBody(**_row(row, cur)) if row is not None else None

    def bodies(self, commander_id: str) -> list[CommanderBody]:
        with self.db.transaction() as cur:
            rows = cur.execute(
                "SELECT * FROM commander_bodies WHERE commander_id = ? ORDER BY attached_at, rowid",
                (commander_id,),
            ).fetchall()
            return [CommanderBody(**_row(r, cur)) for r in rows]

    def attach_body(
        self, commander_id: str, *, pane_id: str, workspace: str = "", agent_key: str = "",
        session_id: str = "", now: int | None = None,
    ) -> CommanderBody:
        """Make *pane_id* the current body; the previous one is detached."""
        if not pane_id:
            raise CommanderInvalid("a body needs a pane id")
        self.get(commander_id)
        now = int(time.time()) if now is None else now
        with self.db.transaction() as cur:
            other = cur.execute(
                "SELECT b.commander_id FROM commander_bodies b JOIN commanders c ON c.id = b.commander_id"
                " WHERE b.pane_id = ? AND b.detached_at = 0 AND b.commander_id != ? AND c.archived_at = 0",
                (pane_id, commander_id),
            ).fetchone()
            if other is not None:
                raise CommanderInvalid("that pane is already another commander's body")
            cur.execute(
                "UPDATE commander_bodies SET detached_at = ? WHERE commander_id = ? AND detached_at = 0",
                (now, commander_id),
            )
            cur.execute(
                "INSERT INTO commander_bodies (commander_id, pane_id, workspace, agent_key, session_id,"
                " attached_at, detached_at) VALUES (?, ?, ?, ?, ?, ?, 0)",
                (commander_id, pane_id, workspace, agent_key, session_id, now),
            )
        return CommanderBody(commander_id, pane_id, workspace, agent_key, session_id, now, 0)

    def detach_body(self, commander_id: str, *, now: int | None = None) -> None:
        now = int(time.time()) if now is None else now
        with self.db.transaction() as cur:
            cur.execute(
                "UPDATE commander_bodies SET detached_at = ? WHERE commander_id = ? AND detached_at = 0",
                (now, commander_id),
            )

    def update_body_pane(self, old_pane_id: str, new_pane_id: str) -> int:
        """A pane got a new id (alias): current bodies and open dispatches follow it."""
        with self.db.transaction() as cur:
            n = cur.execute(
                "UPDATE commander_bodies SET pane_id = ? WHERE pane_id = ? AND detached_at = 0",
                (new_pane_id, old_pane_id),
            ).rowcount
            n += cur.execute(
                "UPDATE commander_dispatches SET pane_id = ? WHERE pane_id = ? AND closed_at = 0",
                (new_pane_id, old_pane_id),
            ).rowcount
            cur.execute(
                "UPDATE commander_dispatches SET opened_by = ? WHERE opened_by = ? AND closed_at = 0",
                (new_pane_id, old_pane_id),
            )
        return n

    def commander_of_body(self, pane_id: str) -> str:
        """The active commander whose current body is *pane_id*, or ""."""
        with self.db.transaction() as cur:
            row = cur.execute(
                "SELECT b.commander_id FROM commander_bodies b JOIN commanders c ON c.id = b.commander_id"
                " WHERE b.pane_id = ? AND b.detached_at = 0 AND c.archived_at = 0 LIMIT 1",
                (pane_id,),
            ).fetchone()
        return str(row[0]) if row is not None else ""

    # ── dispatches ──

    def record_dispatch(
        self, commander_id: str, *, pane_id: str, opened_by: str, task: str = "", now: int | None = None,
    ) -> CommanderDispatch:
        if not pane_id:
            raise CommanderInvalid("a dispatch needs a pane id")
        now = int(time.time()) if now is None else now
        dispatch = CommanderDispatch(commander_id, pane_id, opened_by, str(task or "")[:MAX_TASK], now, 0)
        with self.db.transaction() as cur:
            cur.execute(
                "INSERT INTO commander_dispatches (commander_id, pane_id, opened_by, task, opened_at, closed_at)"
                " VALUES (?, ?, ?, ?, ?, 0)",
                (commander_id, pane_id, dispatch.opened_by, dispatch.task, now),
            )
        return dispatch

    def close_dispatch(self, pane_id: str, *, now: int | None = None) -> int:
        now = int(time.time()) if now is None else now
        with self.db.transaction() as cur:
            return cur.execute(
                "UPDATE commander_dispatches SET closed_at = ? WHERE pane_id = ? AND closed_at = 0",
                (now, pane_id),
            ).rowcount

    def dispatches(self, commander_id: str, *, open_only: bool = False) -> list[CommanderDispatch]:
        sql = "SELECT * FROM commander_dispatches WHERE commander_id = ?"
        if open_only:
            sql += " AND closed_at = 0"
        with self.db.transaction() as cur:
            rows = cur.execute(sql + " ORDER BY opened_at, rowid", (commander_id,)).fetchall()
            return [CommanderDispatch(**_row(r, cur)) for r in rows]

    def dispatch_of(self, pane_id: str) -> CommanderDispatch | None:
        """The open dispatch that opened *pane_id*, if any."""
        with self.db.transaction() as cur:
            row = cur.execute(
                "SELECT * FROM commander_dispatches WHERE pane_id = ? AND closed_at = 0"
                " ORDER BY opened_at DESC, rowid DESC LIMIT 1",
                (pane_id,),
            ).fetchone()
            return CommanderDispatch(**_row(row, cur)) if row is not None else None

    # ── migrations ──

    def record_migration(
        self, commander_id: str, *, kind: str, ref_id: str, before: dict[str, Any], now: int | None = None,
    ) -> CommanderMigration:
        now = int(time.time()) if now is None else now
        before_json = json.dumps(before, sort_keys=True)
        with self.db.transaction() as cur:
            cur.execute(
                "INSERT INTO commander_migrations (commander_id, kind, ref_id, before_json, migrated_at, restored_at)"
                " VALUES (?, ?, ?, ?, ?, 0)",
                (commander_id, kind, ref_id, before_json, now),
            )
        return CommanderMigration(commander_id, kind, ref_id, before_json, now, 0)

    def pending_migrations(self, commander_id: str) -> list[CommanderMigration]:
        with self.db.transaction() as cur:
            rows = cur.execute(
                "SELECT * FROM commander_migrations WHERE commander_id = ? AND restored_at = 0"
                " ORDER BY migrated_at, rowid",
                (commander_id,),
            ).fetchall()
            return [CommanderMigration(**_row(r, cur)) for r in rows]

    def mark_restored(self, commander_id: str, kind: str, ref_id: str, *, now: int | None = None) -> None:
        now = int(time.time()) if now is None else now
        with self.db.transaction() as cur:
            cur.execute(
                "UPDATE commander_migrations SET restored_at = ?"
                " WHERE commander_id = ? AND kind = ? AND ref_id = ? AND restored_at = 0",
                (now, commander_id, kind, ref_id),
            )

    # ── memory file ──

    def memory_path(self, commander_id: str) -> Path:
        if not commander_id or "/" in commander_id or "\\" in commander_id or commander_id.startswith("."):
            raise CommanderInvalid("bad commander id")
        root = self._memory_root if self._memory_root is not None else app_data_dir() / "commanders"
        return root / commander_id / MEMORY_FILE

    def read_memory(self, commander_id: str) -> str:
        try:
            return self.memory_path(commander_id).read_text(encoding="utf-8")
        except FileNotFoundError:
            return ""

    def write_memory(self, commander_id: str, text: str) -> None:
        """Atomically replace the memory file; the file is 0600, its folder 0700."""
        path = self.memory_path(commander_id)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        tmp = path.with_name(f".{MEMORY_FILE}.{uuid.uuid4().hex}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(mask_secrets(text))
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
        os.chmod(path, 0o600)

    def append_memory(self, commander_id: str, text: str) -> None:
        current = self.read_memory(commander_id)
        sep = "" if not current or current.endswith("\n") else "\n"
        self.write_memory(commander_id, current + sep + text.rstrip("\n") + "\n")
