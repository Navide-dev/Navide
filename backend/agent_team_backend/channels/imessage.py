"""iMessage adapter (macOS only): poll ~/Library/Messages/chat.db read-only, reply via osascript.

Verified facts (read 2026-09-24; Apple publishes no chat.db schema, so this follows the
official Claude Code iMessage plugin, github.com/anthropics/claude-plugins-official
external_plugins/imessage/server.ts, which does the same thing):
- chat.db needs Full Disk Access for the process that opens it; without it opening or the
  first query fails ("unable to open database file" / "authorization denied").
- New rows: message JOIN chat_message_join JOIN chat, LEFT JOIN handle, WHERE ROWID >
  watermark ORDER BY ROWID; the watermark starts at MAX(ROWID) so history is not replayed.
- message.date is nanoseconds since 2001-01-01 UTC (older macOS: seconds). chat.style 45 =
  direct chat, 43 = group. Newer macOS leaves message.text NULL and stores the text in
  attributedBody (typedstream NSAttributedString): after "NSString" and the '+' marker comes
  a length (one byte, or 0x81 + int16 LE, or 0x82 + int32 LE) and the UTF-8 text.
- Send: `osascript - <text> <chat guid>` with the script on stdin:
  `tell application "Messages" to send (item 1 of argv) to chat id (item 2 of argv)`; text and
  guid travel as argv, never spliced into AppleScript source. osascript returns no message id.
- Messaging yourself (same Apple ID on phone and Mac) arrives as is_from_me=0 from your own
  address, so replies echo back; they are filtered by (chat, normalised text) for 15 s.
Gaps: no threads, edit, typing, buttons or chat creation (a pane binds an existing
conversation). Tapbacks/reactions are skipped; attachments are reported, not fetched. The first
send to a chat makes macOS ask for Automation permission to control Messages. Not verified
on this machine's real chat.db (tests use a fixture database and a stub osascript).
Replies (InboundMessage.reply_to_id): not mappable. osascript sends return no message
id, so there is nothing for chat.db's thread_originator_guid to match; reply_to_id
stays empty (``@name`` still routes to a child).
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import random
import re
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

from .. import osplat
from .adapter_runtime import ReceiveLoop
from .base import (
    STALL_WATCHDOG_S,
    AdapterStatus,
    Capabilities,
    ChannelAuthError,
    ChannelSendError,
    Emit,
    InboundAttachment,
    InboundMessage,
    Location,
    backoff_delay,
)
from .text import TEXT_LIMITS, chunk_text

log = logging.getLogger(__name__)

DEFAULT_DB_PATH = "~/Library/Messages/chat.db"
APPLE_EPOCH_S = 978307200
STYLE_DIRECT = 45
ECHO_WINDOW_S = 15.0
SEND_TIMEOUT_S = 30.0
SEND_SCRIPT = (
    "on run argv\n"
    '  tell application "Messages" to send (item 1 of argv) to chat id (item 2 of argv)\n'
    "end run\n"
)
FDA_HINT = ("cannot read chat.db — grant Navide Full Disk Access in System Settings → "
            "Privacy & Security → Full Disk Access, then re-enable iMessage")

_POLL_SQL = """
SELECT m.ROWID AS rowid, m.guid, m.text, m.attributedBody, m.date, m.is_from_me,
       m.associated_message_type, m.item_type, h.id AS handle_id,
       c.guid AS chat_guid, c.style AS chat_style, c.display_name
FROM message m
JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
JOIN chat c ON c.ROWID = cmj.chat_id
LEFT JOIN handle h ON h.ROWID = m.handle_id
WHERE m.ROWID > ?
ORDER BY m.ROWID ASC
LIMIT 500
"""


def parse_attributed_body(blob: bytes | None) -> str:
    """Extract the NSString payload of a typedstream NSAttributedString, or ""."""
    if not blob:
        return ""
    i = blob.find(b"NSString")
    if i < 0:
        return ""
    i = blob.find(b"+", i + len(b"NSString"))
    if i < 0 or i + 1 >= len(blob):
        return ""
    i += 1
    tag = blob[i]
    i += 1
    if tag == 0x81:
        size, i = int.from_bytes(blob[i:i + 2], "little"), i + 2
    elif tag == 0x82:
        size, i = int.from_bytes(blob[i:i + 4], "little"), i + 4
    else:
        size = tag
    if i + size > len(blob):
        return ""
    return blob[i:i + size].decode("utf-8", errors="replace")


def _apple_ts(value: Any) -> float:
    if not isinstance(value, (int, float)) or value <= 0:
        return time.time()
    seconds = value / 1e9 if value > 1e11 else float(value)
    return seconds + APPLE_EPOCH_S


def _echo_key(text: str) -> str:
    text = re.sub(r"[‍︀-️]", "", text)
    text = text.replace("‘", "'").replace("’", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", text.strip())[:120]


def _norm_address(addr: str) -> str:
    # message.account looks like "E:me@icloud.com" or "p:+15551234567".
    addr = addr.strip()
    if len(addr) > 2 and addr[1] == ":":
        addr = addr[2:]
    return addr.lower()


class IMessageAdapter:
    platform = "imessage"
    capabilities = Capabilities(
        threads=False, create_location=False, edit=False, typing=False, buttons=False,
        text_limit=TEXT_LIMITS["imessage"],
    )

    def __init__(
        self,
        *,
        account: str = "default",
        db_path: str = DEFAULT_DB_PATH,
        osascript: str = "osascript",
        poll_interval_s: float = 1.0,
        backoff: Callable[[int, float], float] = backoff_delay,
        stall_timeout_s: float = STALL_WATCHDOG_S,
        platform_name: str = osplat.platform_id,
    ) -> None:
        self.account = account
        self._db_path = str(Path(db_path).expanduser())
        self._osascript = osascript
        self._poll_s = poll_interval_s
        self._platform_name = platform_name
        self.status = AdapterStatus()
        self._emit: Emit | None = None
        self._loop = ReceiveLoop(
            "imessage", self.status, self._connect_once,
            stall_s=stall_timeout_s, delay=lambda n: backoff(n, random.random()),
        )
        # Own single thread: sqlite reads never touch the shared default pool.
        self._executor: ThreadPoolExecutor | None = None
        self._watermark: int | None = None
        self._self_addresses: set[str] = set()
        self._echo: dict[str, float] = {}
        self._known_chats: dict[str, dict[str, Any]] = {}

    # --- lifecycle ------------------------------------------------------------

    def token_fingerprint(self) -> str:
        # No credential: the lease guards the local Messages database instead.
        return hashlib.sha256(f"imessage:{self._db_path}".encode()).hexdigest()

    async def start(self, emit: Emit) -> None:
        self._emit = emit
        if self._platform_name != "darwin":
            self.status.lifecycle = "blocked"
            self.status.last_error = "iMessage is only available on macOS"
            return
        if self._executor is None:
            self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="imessage-db")
        self._loop.start()

    async def stop(self) -> None:
        await self._loop.stop()
        if self._executor is not None:
            self._executor.shutdown(wait=False, cancel_futures=True)
            self._executor = None

    def known_locations(self) -> list[dict[str, Any]]:
        return list(self._known_chats.values())

    # --- polling ----------------------------------------------------------------

    async def _db(self, fn: Callable[[sqlite3.Connection], Any], conn: sqlite3.Connection) -> Any:
        assert self._executor is not None
        return await asyncio.get_running_loop().run_in_executor(self._executor, fn, conn)

    def _open(self) -> sqlite3.Connection:
        uri = f"file:{quote(self._db_path)}?mode=ro"
        try:
            conn = sqlite3.connect(uri, uri=True, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("SELECT ROWID FROM message LIMIT 1").fetchone()
            return conn
        except sqlite3.OperationalError as exc:
            msg = str(exc).lower()
            if "unable to open" in msg or "authorization denied" in msg or "not authorized" in msg:
                raise ChannelAuthError(f"{FDA_HINT} ({exc})") from exc
            raise

    @staticmethod
    def _bootstrap(conn: sqlite3.Connection) -> tuple[int, list[str]]:
        top = conn.execute("SELECT MAX(ROWID) FROM message").fetchone()[0] or 0
        rows = conn.execute(
            "SELECT DISTINCT account FROM message WHERE is_from_me = 1 AND account IS NOT NULL "
            "AND account != '' LIMIT 50"
        ).fetchall()
        return int(top), [str(r[0]) for r in rows]

    async def _connect_once(self) -> None:
        assert self._executor is not None
        loop = asyncio.get_running_loop()
        conn = await loop.run_in_executor(self._executor, self._open)
        try:
            top, accounts = await self._db(self._bootstrap, conn)
            if self._watermark is None:
                self._watermark = top
            self._self_addresses = {_norm_address(a) for a in accounts}
            self._loop.mark_ready(sorted(self._self_addresses)[0] if self._self_addresses else "")
            while True:
                watermark = self._watermark
                rows = await self._db(lambda c: c.execute(_POLL_SQL, (watermark,)).fetchall(), conn)
                self._loop.touch()
                for row in rows:
                    self._watermark = max(self._watermark or 0, int(row["rowid"]))
                    await self._on_row(row)
                await asyncio.sleep(self._poll_s)
        finally:
            self._executor.submit(conn.close)

    async def _on_row(self, row: sqlite3.Row) -> None:
        chat_guid = str(row["chat_guid"] or "")
        handle = str(row["handle_id"] or "")
        is_direct = row["chat_style"] == STYLE_DIRECT
        if chat_guid:
            self._known_chats[chat_guid] = {
                "chat_id": chat_guid, "title": str(row["display_name"] or handle or chat_guid),
                "kind": "direct" if is_direct else "group", "supports_topics": False,
            }
        if row["is_from_me"] or row["associated_message_type"] or row["item_type"]:
            return
        raw = row["text"] or parse_attributed_body(row["attributedBody"])
        text = raw.replace("￼", "").strip()
        # U+FFFC marks an attachment in the text; it is reported, not fetched (no media support yet).
        files = [InboundAttachment("file", "", None, "", "") for _ in range(raw.count("￼"))]
        if not (text or files) or not handle or not chat_guid or self._emit is None:
            return
        if handle.lower() in self._self_addresses and self._consume_echo(chat_guid, text):
            return
        self.status.last_inbound_at = time.time()
        await self._emit(InboundMessage(
            platform=self.platform, account=self.account, chat_id=chat_guid, thread_id="",
            sender_id=handle, sender_name=handle, text=text, message_id=str(row["guid"] or row["rowid"]),
            is_direct=is_direct, ts=_apple_ts(row["date"]), attachments=files,
        ))

    def _track_echo(self, chat_guid: str, text: str) -> None:
        now = time.monotonic()
        self._echo = {k: t for k, t in self._echo.items() if now - t <= ECHO_WINDOW_S}
        self._echo[f"{chat_guid}\x00{_echo_key(text)}"] = now

    def _consume_echo(self, chat_guid: str, text: str) -> bool:
        sent = self._echo.pop(f"{chat_guid}\x00{_echo_key(text)}", None)
        return sent is not None and time.monotonic() - sent <= ECHO_WINDOW_S

    # --- outbound -------------------------------------------------------------

    async def _send_one(self, chat_guid: str, text: str) -> None:
        try:
            proc = await asyncio.create_subprocess_exec(
                self._osascript, "-", text, chat_guid,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
        except OSError as exc:
            raise ChannelSendError(f"cannot run osascript: {exc}", retryable=True) from exc
        try:
            _, err = await asyncio.wait_for(proc.communicate(SEND_SCRIPT.encode()), SEND_TIMEOUT_S)
        except asyncio.TimeoutError as exc:
            proc.kill()
            await proc.wait()
            raise ChannelSendError("osascript timed out") from exc
        if proc.returncode != 0:
            detail = err.decode(errors="replace").strip() or f"osascript exit {proc.returncode}"
            raise ChannelSendError(detail)
        self._track_echo(chat_guid, text)

    async def send_text(
        self, loc: Location, text: str, *, buttons: list[tuple[str, str]] | None = None
    ) -> list[str]:
        chunks = chunk_text(text, self.capabilities.text_limit) or [text or "…"]
        for chunk in chunks:
            await self._send_one(loc.chat_id, chunk)
        # osascript returns no message id.
        return ["" for _ in chunks]

    async def edit_text(self, loc: Location, message_id: str, text: str) -> None:
        raise NotImplementedError("iMessage messages cannot be edited from AppleScript")

    async def send_typing(self, loc: Location) -> None:
        return None

    async def create_location(self, chat_id: str, title: str) -> Location:
        raise NotImplementedError("iMessage cannot create conversations; bind an existing one")


def create_adapter(config: dict[str, Any], secret: dict[str, Any], *, store: Any = None) -> IMessageAdapter:
    """Manager entry point: no credential; config may override db_path (tests only)."""
    return IMessageAdapter(
        account=str(config.get("account") or "default"),
        db_path=str(config.get("db_path") or DEFAULT_DB_PATH),
    )
