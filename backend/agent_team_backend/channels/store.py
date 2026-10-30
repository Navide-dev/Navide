"""Channel persistence in the shared global ``navide.db`` (component ``channels``).

Only non-secret data lives here. Bot tokens and app secrets go to
``credential_vault.write_app_secret(f"channel-{platform}-{account}", ...)``.
"""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass
from typing import Any

from ..db import Database
from .base import Location, is_shared_sender

COMPONENT = "channels"
KV_ENABLED = "channels.enabled"
KV_SHARE_OPEN_NOTIFY = "channels.share_open_notify"
# location key -> previews of the messages kept for a wake, so a restart can say which were lost
KV_WAKE_KEPT = "channels.wake_kept"
# the same, carried over from before a restart until each chat's bot is running to be told
KV_WAKE_LOST = "channels.wake_lost"


def _v1(cur: sqlite3.Cursor) -> None:
    cur.execute(
        "CREATE TABLE IF NOT EXISTS channel_accounts ("
        " platform TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1,"
        " config_json TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL)"
    )
    cur.execute(
        "CREATE TABLE IF NOT EXISTS channel_pairing_requests ("
        " platform TEXT NOT NULL, code TEXT NOT NULL, sender_id TEXT NOT NULL,"
        " sender_name TEXT NOT NULL, chat_id TEXT NOT NULL, created_at INTEGER NOT NULL,"
        " PRIMARY KEY (platform, code))"
    )
    cur.execute(
        "CREATE TABLE IF NOT EXISTS channel_allow ("
        " platform TEXT NOT NULL, sender_id TEXT NOT NULL, sender_name TEXT NOT NULL,"
        " added_at INTEGER NOT NULL, PRIMARY KEY (platform, sender_id))"
    )
    cur.execute(
        "CREATE TABLE IF NOT EXISTS channel_bindings ("
        " pane_id TEXT PRIMARY KEY, platform TEXT NOT NULL, account TEXT NOT NULL,"
        " chat_id TEXT NOT NULL, thread_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',"
        " created_at INTEGER NOT NULL, UNIQUE (platform, account, chat_id, thread_id))"
    )
    cur.execute(
        "CREATE TABLE IF NOT EXISTS channel_offsets ("
        " platform TEXT NOT NULL, account TEXT NOT NULL, bot_id TEXT NOT NULL,"
        " offset INTEGER NOT NULL, PRIMARY KEY (platform, account))"
    )


def _v2(cur: sqlite3.Cursor) -> None:
    # Chats a bot has seen, so the pane picker survives a backend restart.
    cur.execute(
        "CREATE TABLE IF NOT EXISTS channel_chats ("
        " platform TEXT NOT NULL, chat_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',"
        " kind TEXT NOT NULL DEFAULT 'group', supports_topics INTEGER NOT NULL DEFAULT 0,"
        " last_seen INTEGER NOT NULL, PRIMARY KEY (platform, chat_id))"
    )


def _v3(cur: sqlite3.Cursor) -> None:
    # Seen chats belong to the bot that saw them: a new token must not offer the
    # old bot's chats. Rows from v2 keep bot '' until their platform next starts.
    cur.execute(
        "CREATE TABLE channel_chats_v3 ("
        " platform TEXT NOT NULL, bot TEXT NOT NULL DEFAULT '', chat_id TEXT NOT NULL,"
        " title TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'group',"
        " supports_topics INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL,"
        " PRIMARY KEY (platform, bot, chat_id))"
    )
    cur.execute(
        "INSERT INTO channel_chats_v3 (platform, bot, chat_id, title, kind, supports_topics, last_seen)"
        " SELECT platform, '', chat_id, title, kind, supports_topics, last_seen FROM channel_chats"
    )
    cur.execute("DROP TABLE channel_chats")
    cur.execute("ALTER TABLE channel_chats_v3 RENAME TO channel_chats")


def _v4(cur: sqlite3.Cursor) -> None:
    # Two-way mirroring: how much of a pane's activity its chat receives, and
    # which bindings were auto-created for a child pane (parent_pane_id set).
    # Bindings made before mirroring keep what they agreed to: replies to the chat only.
    # New bindings always pass their level, so this default only reaches existing rows.
    cur.execute("ALTER TABLE channel_bindings ADD COLUMN verbosity TEXT NOT NULL DEFAULT 'replies'")
    cur.execute("ALTER TABLE channel_bindings ADD COLUMN parent_pane_id TEXT NOT NULL DEFAULT ''")
    cur.execute("ALTER TABLE channel_bindings ADD COLUMN auto INTEGER NOT NULL DEFAULT 0")


def _v5(cur: sqlite3.Cursor) -> None:
    # Several bots per platform: an account is (platform, account), and who may
    # talk to a bot is that bot's own list. Rows from v4 become account 'default',
    # which bindings, offsets and seen chats already use.
    cur.execute(
        "CREATE TABLE channel_accounts_v5 ("
        " platform TEXT NOT NULL, account TEXT NOT NULL DEFAULT 'default',"
        " enabled INTEGER NOT NULL DEFAULT 1, config_json TEXT NOT NULL DEFAULT '{}',"
        " updated_at INTEGER NOT NULL, PRIMARY KEY (platform, account))"
    )
    cur.execute(
        "INSERT INTO channel_accounts_v5 (platform, account, enabled, config_json, updated_at)"
        " SELECT platform, 'default', enabled, config_json, updated_at FROM channel_accounts"
    )
    cur.execute("DROP TABLE channel_accounts")
    cur.execute("ALTER TABLE channel_accounts_v5 RENAME TO channel_accounts")
    cur.execute(
        "CREATE TABLE channel_allow_v5 ("
        " platform TEXT NOT NULL, account TEXT NOT NULL DEFAULT 'default', sender_id TEXT NOT NULL,"
        " sender_name TEXT NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY (platform, account, sender_id))"
    )
    cur.execute(
        "INSERT INTO channel_allow_v5 (platform, account, sender_id, sender_name, added_at)"
        " SELECT platform, 'default', sender_id, sender_name, added_at FROM channel_allow"
    )
    cur.execute("DROP TABLE channel_allow")
    cur.execute("ALTER TABLE channel_allow_v5 RENAME TO channel_allow")
    # The bot a pairing request reached: its approval notice goes back through it.
    cur.execute("ALTER TABLE channel_pairing_requests ADD COLUMN account TEXT NOT NULL DEFAULT 'default'")


def _v6(cur: sqlite3.Cursor) -> None:
    # Waking a pane that is not online from its chat: the workspace and the conversation it
    # is resumed onto. Rows from v5 keep '' until their pane is next seen online; until then
    # an offline pane is only reported, as before.
    cur.execute("ALTER TABLE channel_bindings ADD COLUMN workspace_path TEXT NOT NULL DEFAULT ''")
    cur.execute("ALTER TABLE channel_bindings ADD COLUMN session_id TEXT NOT NULL DEFAULT ''")


def _v7(cur: sqlite3.Cursor) -> None:
    # How a sender got on the allowlist: "pairing" (a pairing code) or "invite" (a link
    # code), shown in Settings. Rows from v6 keep NULL: nothing recorded how they came.
    cur.execute("ALTER TABLE channel_allow ADD COLUMN source TEXT")


DEFAULT_ACCOUNT = "default"

# "replies": only answers to turns the chat started (the pre-mirror behaviour).
VERBOSITIES = ("replies", "minimal", "standard", "full")
# A bind that names no level mirrors nothing the chat did not ask for; the user
# picks a louder level explicitly when binding or later from the pane's chip.
DEFAULT_VERBOSITY = "replies"


@dataclass
class PairingRequest:
    platform: str
    code: str
    sender_id: str
    sender_name: str
    chat_id: str
    created_at: int
    account: str = DEFAULT_ACCOUNT  # the bot the sender wrote to

    def public(self) -> dict[str, Any]:
        return {"platform": self.platform, "account": self.account, "code": self.code,
                "sender_id": self.sender_id, "sender_name": self.sender_name, "created_at": self.created_at}


@dataclass
class Binding:
    pane_id: str
    platform: str
    account: str
    chat_id: str
    thread_id: str
    title: str
    created_at: int
    verbosity: str = DEFAULT_VERBOSITY
    parent_pane_id: str = ""
    auto: bool = False
    workspace_path: str = ""  # where the pane lives, for waking it ("" = unknown)
    session_id: str = ""  # the conversation a wake resumes ("" = unknown)

    def location(self) -> Location:
        return Location(self.platform, self.account, self.chat_id, self.thread_id, self.title)

    def public(self) -> dict[str, Any]:
        return {"pane_id": self.pane_id, "platform": self.platform, "account": self.account,
                "chat_id": self.chat_id, "thread_id": self.thread_id, "title": self.title,
                "verbosity": self.verbosity, "parent_pane_id": self.parent_pane_id, "auto": self.auto}


class ChannelStore:
    def __init__(self, db: Database) -> None:
        self._db = db
        db.migrate(COMPONENT, 1, _v1)
        db.migrate(COMPONENT, 2, _v2)
        db.migrate(COMPONENT, 3, _v3)
        db.migrate(COMPONENT, 4, _v4)
        db.migrate(COMPONENT, 5, _v5)
        db.migrate(COMPONENT, 6, _v6)
        db.migrate(COMPONENT, 7, _v7)

    def _rows(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self._db.transaction() as cur:
            return list(cur.execute(sql, args).fetchall())

    def _exec(self, sql: str, args: tuple = ()) -> int:
        with self._db.transaction() as cur:
            cur.execute(sql, args)
            return cur.rowcount

    # --- kill switch ----------------------------------------------------------

    def global_enabled(self) -> bool:
        return bool(self._db.kv_get(KV_ENABLED, True))

    def set_global_enabled(self, enabled: bool) -> None:
        self._db.kv_set(KV_ENABLED, bool(enabled), now=int(time.time()))

    def share_open_notify(self) -> bool:
        """Tell the chat when a new device opens one of this machine's share links."""
        return bool(self._db.kv_get(KV_SHARE_OPEN_NOTIFY, True))

    def set_share_open_notify(self, enabled: bool) -> None:
        self._db.kv_set(KV_SHARE_OPEN_NOTIFY, bool(enabled), now=int(time.time()))

    def kept_previews(self) -> dict[str, list[str]]:
        kept = self._db.kv_get(KV_WAKE_KEPT, {})
        return {str(k): [str(p) for p in v] for k, v in kept.items() if isinstance(v, list)} \
            if isinstance(kept, dict) else {}

    def set_kept_previews(self, kept: dict[str, list[str]]) -> None:
        self._db.kv_set(KV_WAKE_KEPT, kept, now=int(time.time()))

    def lost_previews(self) -> dict[str, list[str]]:
        lost = self._db.kv_get(KV_WAKE_LOST, {})
        return {str(k): [str(p) for p in v] for k, v in lost.items() if isinstance(v, list)} \
            if isinstance(lost, dict) else {}

    def set_lost_previews(self, lost: dict[str, list[str]]) -> None:
        self._db.kv_set(KV_WAKE_LOST, lost, now=int(time.time()))

    # --- accounts -------------------------------------------------------------

    def accounts(self) -> dict[tuple[str, str], dict[str, Any]]:
        """Every configured bot, keyed by (platform, account)."""
        out: dict[tuple[str, str], dict[str, Any]] = {}
        for r in self._rows("SELECT platform, account, enabled, config_json FROM channel_accounts"
                            " ORDER BY platform, account != 'default', updated_at"):
            try:
                config = json.loads(r["config_json"] or "{}")
            except json.JSONDecodeError:
                config = {}
            out[(r["platform"], r["account"])] = {"enabled": bool(r["enabled"]), "config": config}
        return out

    def upsert_account(self, platform: str, config: dict[str, Any], enabled: bool | None = None,
                       account: str = DEFAULT_ACCOUNT) -> None:
        payload = json.dumps(config, ensure_ascii=False, separators=(",", ":"))
        now = int(time.time())
        with self._db.transaction() as cur:
            cur.execute(
                "INSERT INTO channel_accounts (platform, account, enabled, config_json, updated_at)"
                " VALUES (?, ?, ?, ?, ?) ON CONFLICT(platform, account) DO UPDATE SET"
                " config_json = excluded.config_json, updated_at = excluded.updated_at",
                (platform, account, 1 if enabled is None else int(bool(enabled)), payload, now),
            )
            if enabled is not None:
                cur.execute("UPDATE channel_accounts SET enabled = ? WHERE platform = ? AND account = ?",
                            (int(bool(enabled)), platform, account))

    def set_account_enabled(self, platform: str, enabled: bool, account: str = DEFAULT_ACCOUNT) -> bool:
        return self._exec("UPDATE channel_accounts SET enabled = ?, updated_at = ?"
                          " WHERE platform = ? AND account = ?",
                          (int(bool(enabled)), int(time.time()), platform, account)) > 0

    def remove_account(self, platform: str, account: str) -> None:
        """One bot goes: its row, bindings, polling offset, allowlist and pairing requests."""
        with self._db.transaction() as cur:
            for table in ("channel_accounts", "channel_bindings", "channel_offsets", "channel_allow",
                          "channel_pairing_requests"):
                cur.execute(f"DELETE FROM {table} WHERE platform = ? AND account = ?", (platform, account))

    def remove_platform(self, platform: str) -> None:
        with self._db.transaction() as cur:
            for table in ("channel_accounts", "channel_pairing_requests", "channel_allow",
                          "channel_bindings", "channel_offsets", "channel_chats"):
                cur.execute(f"DELETE FROM {table} WHERE platform = ?", (platform,))

    # --- seen chats -----------------------------------------------------------

    def remember_chat(self, platform: str, bot: str, chat_id: str, title: str, kind: str,
                      supports_topics: bool, now: int) -> bool:
        """Upsert a chat ``bot`` has seen; True when it (or its topic support) is new."""
        with self._db.transaction() as cur:
            prev = cur.execute("SELECT supports_topics FROM channel_chats"
                               " WHERE platform = ? AND bot = ? AND chat_id = ?",
                               (platform, bot, chat_id)).fetchone()
            cur.execute(
                "INSERT INTO channel_chats (platform, bot, chat_id, title, kind, supports_topics, last_seen)"
                " VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(platform, bot, chat_id) DO UPDATE SET"
                " title = CASE WHEN excluded.title != '' THEN excluded.title ELSE channel_chats.title END,"
                " kind = excluded.kind,"
                " supports_topics = MAX(channel_chats.supports_topics, excluded.supports_topics),"
                " last_seen = excluded.last_seen",
                (platform, bot, chat_id, title, kind, int(bool(supports_topics)), now),
            )
        return prev is None or (bool(supports_topics) and not prev["supports_topics"])

    def adopt_chats(self, platform: str, bot: str) -> int:
        """Hand v2 rows (seen before chats had a bot) to the bot now running."""
        return self._exec("UPDATE OR IGNORE channel_chats SET bot = ? WHERE platform = ? AND bot = ''",
                          (bot, platform))

    def chats(self, platform: str, bot: str) -> list[dict[str, Any]]:
        return [{"chat_id": r["chat_id"], "title": r["title"], "kind": r["kind"],
                 "supports_topics": bool(r["supports_topics"])}
                for r in self._rows("SELECT * FROM channel_chats WHERE platform = ? AND bot = ?"
                                    " ORDER BY last_seen DESC", (platform, bot))]

    # --- pairing --------------------------------------------------------------

    @staticmethod
    def _pairing(r: sqlite3.Row) -> PairingRequest:
        return PairingRequest(r["platform"], r["code"], r["sender_id"], r["sender_name"],
                              r["chat_id"], int(r["created_at"]), r["account"])

    def list_pairing(self, platform: str | None, account: str | None = None) -> list[PairingRequest]:
        if platform and account is not None:
            rows = self._rows("SELECT * FROM channel_pairing_requests WHERE platform = ? AND account = ?"
                              " ORDER BY created_at", (platform, account))
        elif platform:
            rows = self._rows("SELECT * FROM channel_pairing_requests WHERE platform = ?"
                              " ORDER BY created_at", (platform,))
        else:
            rows = self._rows("SELECT * FROM channel_pairing_requests ORDER BY created_at")
        return [self._pairing(r) for r in rows]

    def add_pairing(self, req: PairingRequest) -> None:
        self._exec("INSERT INTO channel_pairing_requests (platform, code, sender_id, sender_name, chat_id,"
                   " created_at, account) VALUES (?, ?, ?, ?, ?, ?, ?)",
                   (req.platform, req.code, req.sender_id, req.sender_name, req.chat_id, req.created_at,
                    req.account))

    def pop_pairing(self, platform: str, code: str) -> PairingRequest | None:
        with self._db.transaction() as cur:
            r = cur.execute("SELECT * FROM channel_pairing_requests WHERE platform = ? AND code = ?",
                            (platform, code)).fetchone()
            if r is None:
                return None
            cur.execute("DELETE FROM channel_pairing_requests WHERE platform = ? AND code = ?",
                        (platform, code))
            return self._pairing(r)

    def delete_pairing_older_than(self, cutoff: float) -> int:
        return self._exec("DELETE FROM channel_pairing_requests WHERE created_at < ?", (int(cutoff),))

    # --- allowlist (per bot) ----------------------------------------------------

    def is_allowed(self, platform: str, sender_id: str, account: str = DEFAULT_ACCOUNT) -> bool:
        return bool(self._rows("SELECT 1 FROM channel_allow WHERE platform = ? AND account = ? AND sender_id = ?",
                               (platform, account, sender_id)))

    def add_allow(self, platform: str, sender_id: str, sender_name: str, added_at: int,
                  account: str = DEFAULT_ACCOUNT, source: str | None = None) -> None:
        if is_shared_sender(platform, sender_id):
            raise ValueError(f"{platform} sender {sender_id} is shared by many people and cannot be allowed")
        self._exec("INSERT INTO channel_allow (platform, account, sender_id, sender_name, added_at, source)"
                   " VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(platform, account, sender_id)"
                   " DO UPDATE SET sender_name = excluded.sender_name",
                   (platform, account, sender_id, sender_name, added_at, source))

    def list_allow(self, platform: str | None) -> list[dict[str, Any]]:
        if platform:
            rows = self._rows("SELECT * FROM channel_allow WHERE platform = ? ORDER BY added_at", (platform,))
        else:
            rows = self._rows("SELECT * FROM channel_allow ORDER BY added_at")
        return [dict(r) for r in rows]

    def remove_allow(self, platform: str, sender_id: str, account: str = DEFAULT_ACCOUNT) -> bool:
        return self._exec("DELETE FROM channel_allow WHERE platform = ? AND account = ? AND sender_id = ?",
                          (platform, account, sender_id)) > 0

    # --- bindings -------------------------------------------------------------

    @staticmethod
    def _binding(r: sqlite3.Row) -> Binding:
        return Binding(r["pane_id"], r["platform"], r["account"], r["chat_id"], r["thread_id"],
                       r["title"], int(r["created_at"]), r["verbosity"], r["parent_pane_id"], bool(r["auto"]),
                       r["workspace_path"], r["session_id"])

    def bindings(self) -> list[Binding]:
        return [self._binding(r) for r in self._rows("SELECT * FROM channel_bindings ORDER BY created_at")]

    def bind(self, pane_id: str, loc: Location, *, verbosity: str = DEFAULT_VERBOSITY,
             parent_pane_id: str = "", auto: bool = False) -> Binding:
        now = int(time.time())
        with self._db.transaction() as cur:
            # One pane <-> one location: rebinding either side replaces the old row.
            cur.execute("DELETE FROM channel_bindings WHERE pane_id = ? OR (platform = ? AND account = ?"
                        " AND chat_id = ? AND thread_id = ?)",
                        (pane_id, loc.platform, loc.account, loc.chat_id, loc.thread_id))
            cur.execute("INSERT INTO channel_bindings (pane_id, platform, account, chat_id, thread_id, title,"
                        " created_at, verbosity, parent_pane_id, auto) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (pane_id, loc.platform, loc.account, loc.chat_id, loc.thread_id, loc.title, now,
                         verbosity, parent_pane_id, int(auto)))
        return Binding(pane_id, loc.platform, loc.account, loc.chat_id, loc.thread_id, loc.title, now,
                       verbosity, parent_pane_id, auto)

    def unbind(self, pane_id: str) -> Binding | None:
        with self._db.transaction() as cur:
            r = cur.execute("SELECT * FROM channel_bindings WHERE pane_id = ?", (pane_id,)).fetchone()
            if r is None:
                return None
            cur.execute("DELETE FROM channel_bindings WHERE pane_id = ?", (pane_id,))
            return self._binding(r)

    def rename_pane(self, old_pane_id: str, new_pane_id: str) -> bool:
        with self._db.transaction() as cur:
            cur.execute("UPDATE channel_bindings SET parent_pane_id = ? WHERE parent_pane_id = ?",
                        (new_pane_id, old_pane_id))
            return cur.execute("UPDATE channel_bindings SET pane_id = ? WHERE pane_id = ?",
                               (new_pane_id, old_pane_id)).rowcount > 0

    def set_wake_target(self, pane_id: str, workspace_path: str, session_id: str) -> bool:
        return self._exec("UPDATE channel_bindings SET workspace_path = ?, session_id = ? WHERE pane_id = ?",
                          (workspace_path, session_id, pane_id)) > 0

    def set_verbosity(self, pane_id: str, verbosity: str) -> Binding | None:
        with self._db.transaction() as cur:
            cur.execute("UPDATE channel_bindings SET verbosity = ? WHERE pane_id = ?", (verbosity, pane_id))
            r = cur.execute("SELECT * FROM channel_bindings WHERE pane_id = ?", (pane_id,)).fetchone()
            return self._binding(r) if r is not None else None

    # --- offsets (Telegram OffsetStore protocol) --------------------------------

    def get_offset(self, platform: str, account: str, bot_id: str) -> int | None:
        rows = self._rows("SELECT bot_id, offset FROM channel_offsets WHERE platform = ? AND account = ?",
                          (platform, account))
        if not rows or rows[0]["bot_id"] != bot_id:
            return None  # none stored, or it belongs to a previous bot token
        return int(rows[0]["offset"])

    def set_offset(self, platform: str, account: str, bot_id: str, offset: int) -> None:
        self._exec("INSERT INTO channel_offsets VALUES (?, ?, ?, ?) ON CONFLICT(platform, account)"
                   " DO UPDATE SET bot_id = excluded.bot_id, offset = excluded.offset",
                   (platform, account, bot_id, int(offset)))
