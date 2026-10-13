"""Cursor CLI (`agent`, legacy `cursor-agent`) conversation store reader.

Layout (root = ~/.cursor/chats — Cursor offers no official env override for
its data home, so the root is fixed; tests relocate it via Path.home()).
Sampled 2026-08-16 against a live cursor-agent 2026.08.11-e8db854 session:

  ~/.cursor/chats/<project-hash>/<session-uuid>/store.db    one db per session
  ~/.cursor/chats/<project-hash>/<session-uuid>/meta.json   plain-JSON sidecar

  store.db has exactly two tables:
    meta  (key TEXT PRIMARY KEY, value TEXT) — single row (key '0'), value =
                  hex-encoded JSON (agentId, latestRootBlobId,
                  blobEncryptionKey, createdAt; NO cwd)
    blobs (id TEXT PRIMARY KEY, data BLOB) — content-addressed (SHA256 keys)
                  and MIXED: some rows are plain JSON chat messages
                  ({"role": "system"|"user"|"assistant", "content": …}), the
                  rest are protobuf structure nodes with no public schema.
                  Protobuf rows are NEVER decoded — they fail json.loads and
                  are skipped, and the marker scan only reads their raw bytes
                  (user input is embedded verbatim as UTF-8, which is how the
                  kickoff's `at-pane:<paneId>` marker is found).

  meta.json is the only place the workspace is recorded:
    {"schemaVersion":1,"createdAtMs":…,"hasConversation":true,
     "updatedAtMs":…,"cwd":"/abs/path"}

  <project-hash> is md5(cwd) hexdigest — community-documented (agentgrep) and
  CONFIRMED 2026-08-16 (md5 of the sampled meta.json cwd equals the dir name).
  Cursor is still closed source, so it stays a best-effort workspace filter
  and never gates marker binding (markers are globally unique).

  ~/.cursor/acp-sessions/<id>/store.db (ACP mode) is intentionally ignored,
  as is ~/.cursor/projects/<slug>/agent-transcripts/*.jsonl — that is Cursor
  IDE data, not the CLI's.

Token usage: none is emitted (parse_session_file/parse_incremental return
empty). The JSON blobs carry no usage, and whatever the store keeps lives in
the protobuf nodes, which are out of reach. The headless
`--output-format stream-json` path does report usage per result (sampled:
inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens, with
inputTokens EXCLUDING cacheReadTokens — Anthropic's convention, the opposite
of Meta/OpenAI), but `--print` runs one prompt and exits, so it can never
observe an interactive pane. Left unimplemented on purpose.

Activity: parse_activity watermarks on blobs.rowid (monotonic per INSERT) and
turns each new JSON message row into an event — role=user → agent_active,
role=assistant → turn_complete carrying the reply text. That turn_complete is
what lets a Cursor pane send inter-CLI messages: the frontend only parses the
---MSG-START--- protocol out of a turn_complete that has text. Nothing else is
reported: there is deliberately NO db-write heartbeat (see parse_activity).

Everything here is maximally defensive: any missing table, unexpected
schema, undecodable value, or sqlite error is tolerated by silently skipping
that db — never by raising.

resume: `agent --resume=<chatId>` (session id = the <session-uuid> dir name).
"""

from __future__ import annotations

import hashlib
import logging
import re
import sqlite3
from collections.abc import Iterable
from pathlib import Path

import asyncio
import base64
import json
import sys
import time

from ..log_readers.base import (
    ActivityEvent,
    IncrementalParseResult,
    LogReader,
    TokenUsage,
    join_text_blocks,
    user_prompt_text,
)
from .base import ExtensionsSource, ExtensionsSpec  # noqa: F401
from .base import (
    PlatformInstall,
    AccountSwitchSpec,
    Dep,
    McpServerConfig,
    McpValue,
    McpWiring,
    SkillsWiring,
    VendorSpec,
    command_text,
    keychain_payload_items,
    platform_paths,
)
from ..usage_common import (
    HTTP_TIMEOUT,
    _KEYCHAIN_COOLDOWN_S,
    _epoch_to_iso,
    _num,
    _snapshot,
    _window,
    communicate_or_kill,
    parse_retry_after,
)

log = logging.getLogger("agent_team_backend.log_readers.cursor")

_DB_NAME = "store.db"
_META_NAME = "meta.json"

# Read-only busy wait: long enough to ride out an agent write transaction,
# short enough not to stall the watcher's drain thread (same as Grok).
_BUSY_TIMEOUT_MS = 250

# Marker-scan bounds. The kickoff marker lands in an early, small user-input
# blob, so scanning the head of each blob is enough; the caps keep a huge or
# blob-heavy session db from turning every scan into a performance disaster.
_MAX_BLOB_BYTES = 262_144   # bytes searched per blob (truncated in SQL)
_MAX_BLOBS_PER_DB = 512     # blobs examined per store.db

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

# Sentinel prefix persisted inside the watcher-owned per-file seen_keys set
# (same trick as Kimi's turn state): the last scanned blobs.rowid.
_ACTIVITY_PREFIX = "cursor_blob::"

# rowid is monotonic per INSERT; a content-addressed row re-inserted under an
# existing id lands on a NEW, higher rowid, so the watermark only moves
# forward. Sampled turns write ~10 blobs each and first sight anchors at the
# newest row, so one page per pass is never the limiting factor in practice.
_ACTIVITY_SQL = (
    "SELECT rowid, id, data FROM blobs WHERE rowid > ? ORDER BY rowid LIMIT ?"
)
_MAX_BLOBS_PER_PASS = 512

# Cap on the reply text a turn_complete carries (matches the other readers'
# intent: enough for the messaging protocol, not a transcript dump).
_MAX_TURN_TEXT = 8000


def _cap_text(text: str) -> str:
    """Head-and-tail cap, same shape as the other readers' _cap_text: the
    loop's <<LOOP_DONE>> and the messaging ---MSG-END--- both sit on the reply's
    LAST line, so a head-only slice of a long reply silently dropped them."""
    if len(text) <= _MAX_TURN_TEXT:
        return text
    half = _MAX_TURN_TEXT // 2
    return f"{text[:half]}\n…\n{text[-half:]}"

# What the user actually typed, inside Cursor's prompt wrapper. Sampled rows:
#
#   <timestamp>Sunday, Aug 16, 2026, 10:33 AM (UTC+9)</timestamp>
#   <user_query>
#   Reply with exactly: ok
#   </user_query>
#
# The tag does double duty. It recovers the text panes are named from —
# user_prompt_text drops anything '<'-prefixed, so the raw row always
# filtered down to '' — and it separates a real prompt from the context
# Cursor injects as its own `user` row: the first row of a session is
# ~30k characters of <user_info>/<rules>/<agent_transcripts> and carries no
# <user_query> at all. Without the distinction that injection would read as
# the user's opening message and name the pane after it.
_USER_QUERY_RE = re.compile(r"<user_query>\s*(.*?)\s*</user_query>", re.DOTALL)

# Navide's own session marker, as it reaches the store. Cursor cannot pin a
# session id at launch, so a fresh pane's marker is TYPED into the TUI as a
# standalone prompt (App.vue sendSessionMarkerBootstrap pastes
# `<!-- agent-team-session: at-pane:<paneId> -->` and hits Enter). Cursor wraps
# it like any other prompt, so it arrives as a perfectly normal <user_query>
# row — indistinguishable from something the person typed unless matched here.
# It is Navide talking to itself, never user activity, so a row whose whole
# body is the marker emits nothing.
#
# Anchored on the ENTIRE unwrapped body on purpose: a real prompt that merely
# mentions `at-pane:` (discussing this very mechanism, forwarding a pane id)
# is a genuine prompt and must still be reported.
_MARKER_ONLY_RE = re.compile(
    r"^(?:<!--\s*agent-team-session:\s*)?"
    r"at-pane:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
    r"(?:\s*-->)?$"
)


def _read_meta_json(session_dir: Path) -> dict:
    """The plain-JSON sidecar next to store.db ({} when absent/unreadable).

    Unlike the db's own `meta` table this one is not hex-encoded and does
    carry `cwd`, which makes it the only workspace record Cursor writes.
    """
    try:
        raw = (session_dir / _META_NAME).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _json_message(data) -> dict | None:
    """A blobs row decoded as a chat message, or None when it is one of the
    protobuf structure nodes — those are skipped, never decoded."""
    if isinstance(data, memoryview):
        data = bytes(data)
    if not isinstance(data, (bytes, bytearray, str)):
        return None
    try:
        message = json.loads(data)
    except (ValueError, UnicodeDecodeError):
        return None
    return message if isinstance(message, dict) else None


def cursor_chats_root() -> Path:
    """Cursor CLI's per-session chat-store root (fixed, no env override)."""
    return Path.home() / ".cursor" / "chats"


def cursor_project_hash(cwd: str) -> str:
    """Community-documented <project-hash> for a workspace: md5(cwd) hexdigest.

    UNCONFIRMED upstream — callers must treat a non-match as "unknown", never
    as proof a session belongs elsewhere.
    """
    if not cwd:
        return ""
    return hashlib.md5(cwd.encode("utf-8")).hexdigest()


class CursorLogReader(LogReader):
    vendor: str = "cursor"

    #: The log records no token usage, so there are no turns to cut.
    turns_method: str = "unsupported"

    def _chats_root(self) -> Path:
        return cursor_chats_root()

    def project_dirs(self) -> list[Path]:
        """The single chats root (empty list when it doesn't exist)."""
        root = self._chats_root()
        return [root] if root.is_dir() else []

    def session_files(self) -> list[Path]:
        out: list[Path] = []
        for root in self.project_dirs():
            try:
                for f in root.glob(f"*/*/{_DB_NAME}"):
                    if _UUID_RE.match(f.parent.name) and f.is_file():
                        out.append(f)
            except OSError as err:
                log.debug("glob %s failed: %s", root, err)
        return out

    def session_id_from_path(self, path: Path) -> str:
        """Id is the session dir name (the chatId `agent --resume=<id>`
        accepts), NOT the stem — every session file is store.db. Sibling
        files (store.db-wal, -shm, anything unexpected) are not session
        files → '' so the resume sink skips them instead of coining bogus
        ids."""
        if path.name != _DB_NAME or not _UUID_RE.match(path.parent.name):
            return ""
        return path.parent.name

    def cwd_from_file(self, path: Path) -> str:
        """The workspace recorded in the sibling meta.json ('' when absent).

        store.db itself cannot answer this: its meta JSON has no cwd and the
        <project-hash> dir name is a one-way digest. meta.json is written by
        the CLI next to the db and holds the absolute path verbatim.
        """
        return str(_read_meta_json(path.parent).get("cwd") or "")

    def has_session(self, session_id: str) -> bool:
        """True when <root>/<any-project-hash>/<id>/store.db exists. The
        project-hash segment is not reliably derivable from the workspace
        (md5(cwd) is unconfirmed), so glob across every project dir."""
        session_id = session_id.strip()
        if not _UUID_RE.match(session_id):
            return False
        for root in self.project_dirs():
            try:
                if any(root.glob(f"*/{session_id}/{_DB_NAME}")):
                    return True
            except OSError:
                continue
        return False

    def session_files_for_workspace(self, workspace_path: str) -> list[Path] | None:
        """Best-effort md5(cwd) scoping: when the community-documented hash
        dir exists, return only its sessions; otherwise None → the caller
        falls back to session_files(), so a wrong hash assumption can only
        widen the scan, never hide sessions."""
        hash_dir = cursor_project_hash(workspace_path)
        if not hash_dir:
            return None
        base = self._chats_root() / hash_dir
        try:
            if not base.is_dir():
                return None
            return [
                f for f in base.glob(f"*/{_DB_NAME}")
                if _UUID_RE.match(f.parent.name) and f.is_file()
            ]
        except OSError:
            return None

    def _query(
        self, path: Path, sql: str, params: tuple = ()
    ) -> list[tuple] | None:
        """Short-lived read-only query. None = db unreadable this cycle
        (missing / busy / locked / missing table / mid-write) — callers
        treat it as no data."""
        try:
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            try:
                con.execute(f"PRAGMA busy_timeout = {_BUSY_TIMEOUT_MS}")
                return con.execute(sql, params).fetchall()
            finally:
                con.close()
        except (sqlite3.Error, OSError) as err:
            log.debug("sqlite read %s failed: %s", path, err)
            return None

    # ── token interface: Cursor stores no usage locally ────────────────────

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        """Cursor CLI keeps no token usage on disk → never any events."""
        return []

    def parse_incremental(
        self,
        path: Path,
        checkpoint: dict,
    ) -> IncrementalParseResult:
        """No token events, ever (usage is not stored locally). The
        checkpoint passes through unchanged; change detection for activity
        lives in parse_activity."""
        return IncrementalParseResult([], dict(checkpoint))

    # ── activity: per-message blob scan ─────────────────────────────────────

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Turn events from the JSON message blobs — and nothing else.

        There is deliberately no db-write (mtime/size) heartbeat. It used to
        exist to prove "still working" between turn boundaries, since the
        writes in between are protobuf structure nodes with no decodable role,
        but that rationale assumed reader events drive the pane's RUNNING
        display. They do not: RUNNING comes from raw PTY bytes
        (useTerminal's lastRawActivityAt), so a pane mid-turn still looks busy
        with no heartbeat at all.

        What the heartbeat DID drive is the App's paneLastActiveAt — and there
        it was actively harmful. A live store keeps writing protobuf rows
        AFTER the turn's last assistant row (sampled: rowids 20/23 and 32
        follow assistant rows 19 and 30). A pass that observed only those
        would emit a bare agent_active stamped LATER than the turn_complete,
        and completion.ts's turnCompleteDone requires
        turnCompleteAt >= lastActiveAt — so the pane would never read as done:
        no notification, and an unattended loop stalls forever waiting for
        loopContinueReady.
        """
        session_id = self.session_id_from_path(path)
        if not session_id:
            return []
        cwd = self.cwd_from_file(path)
        return self._blob_activity(path, session_id, cwd, seen_keys)

    def _store_epoch(self, path: Path) -> float:
        """Epoch seconds to stamp this pass's events with.

        blobs has no time column at all, so there is no per-message timestamp
        to read; the closest real one is meta.json's `updatedAtMs`, which the
        CLI rewrites as part of each turn's commit (so consecutive turns get
        distinct values). The scan clock is the only fallback.

        The db's own mtime is NOT usable, tempting as it looks: store.db runs
        in WAL mode, and a WAL commit lands in store.db-wal without touching
        the main file's mtime or size (measured: 30 consecutive commits, no
        change; only close/checkpoint moves it). Falling back to it would
        stamp every turn of a session with the session's start time, and past
        60s isReplayedTurnComplete would then silently discard all of them —
        killing done notifications, pipeline sentinels and the inter-CLI
        messaging this reader exists for.
        """
        updated = _num(_read_meta_json(path.parent).get("updatedAtMs"))
        if updated:
            return updated / 1000
        return time.time()

    def _blob_activity(
        self, path: Path, session_id: str, cwd: str, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """One event per new JSON message blob, watermarked on blobs.rowid."""
        prev = next(
            (
                k[len(_ACTIVITY_PREFIX):]
                for k in seen_keys
                if k.startswith(_ACTIVITY_PREFIX)
            ),
            None,
        )

        def remember(row_id: int) -> None:
            seen_keys.difference_update(
                {k for k in seen_keys if k.startswith(_ACTIVITY_PREFIX)}
            )
            seen_keys.add(_ACTIVITY_PREFIX + str(row_id))

        newest = self._query(path, "SELECT COALESCE(MAX(rowid), 0) FROM blobs")
        if newest is None:
            return []  # unreadable this cycle: no data, no state change
        top = int(newest[0][0] or 0)
        if prev is None:
            # First sight: what is already stored is history, not activity
            # happening now. A backend restart re-sees every session db, and
            # replaying those turns would resend their messages.
            remember(top)
            return []
        watermark = int(prev)
        if top < watermark:
            # The store shrank (session db recreated, vacuumed, replaced):
            # re-anchor rather than rescan, so old turns are never replayed.
            remember(top)
            return []
        rows = self._query(path, _ACTIVITY_SQL, (watermark, _MAX_BLOBS_PER_PASS))
        if not rows:
            return []
        remember(int(rows[-1][0]))

        base = self._store_epoch(path)
        out: list[ActivityEvent] = []

        def stamp() -> str:
            # One pass can carry several events, and meta.json gives the whole
            # pass a single time. Nudge each event 1ms past the previous one:
            # App.vue's onTurnCompleteForMessaging admits a turn only when
            # eventMs > paneMsgProcessedAt (STRICTLY greater), so two turns
            # sharing an identical stamp would lose the second one's
            # ---MSG--- block. Still plain ISO-8601 — an unparseable stamp
            # reads as always-fresh and resends a delivered turn.
            return _epoch_to_iso(base + len(out) * 0.001) or ""

        for _row_id, blob_id, data in rows:
            message = _json_message(data)
            if message is None:
                continue  # protobuf structure node — never decoded
            role = str(message.get("role") or "")
            content = message.get("content")
            # Dedup on the content-addressed id, not the rowid: a row
            # re-inserted under the same id is the same message.
            key = f"blob:{blob_id}"
            if role == "assistant":
                # A new assistant message IS the end of a turn. Only the
                # "text" parts are the reply — "reasoning" parts are the
                # model's thinking and must never be sent to another CLI.
                out.append(ActivityEvent(
                    vendor="cursor", event_type="turn_complete", cwd=cwd,
                    session_id=session_id, file_path=str(path), dedup_key=key,
                    timestamp=stamp(), detail="assistant",
                    text=_cap_text(join_text_blocks(content, "text")),
                ))
            elif role == "user":
                # "user" is the cross-end contract detail panes are named
                # from, so it has to carry what the person typed. Unwrap
                # Cursor's <user_query> first (see _USER_QUERY_RE): a row
                # without it is the injected context, not a prompt, and
                # reporting that as user activity would name the pane after
                # ~30k characters of rules.
                query = _USER_QUERY_RE.search(join_text_blocks(content, "text"))
                if query is None:
                    continue
                typed = query.group(1).strip()
                # Navide's own session marker is typed into the TUI as a
                # standalone prompt, so it lands in a normal <user_query> row
                # at spawn time. It is not user activity (see _MARKER_ONLY_RE).
                if _MARKER_ONLY_RE.match(typed):
                    continue
                out.append(ActivityEvent(
                    vendor="cursor", event_type="agent_active", cwd=cwd,
                    session_id=session_id, file_path=str(path), dedup_key=key,
                    timestamp=stamp(), detail="user",
                    text=user_prompt_text(typed),
                ))
            # role=system (the prompt preamble) is not activity.
        return out

    # ── marker binding ──────────────────────────────────────────────────────

    def find_sessions_by_marker(
        self, markers: Iterable[str]
    ) -> dict[str, tuple[str, str]]:
        """marker → (session_id, workspace_root) resolved by a raw UTF-8
        bytes substring scan over each session db's blobs (protobuf is never
        decoded). workspace_root is reported as '' even though meta.json now
        supplies one, which keeps Attribution's shared-db workspace gate
        permissive — a marker is globally unique, so it needs no corroboration.
        Unreadable dbs / missing tables / non-bytes values are skipped."""
        wanted = {m: m.encode("utf-8") for m in markers if m}
        if not wanted:
            return {}
        found: dict[str, tuple[str, str]] = {}
        sql = (
            f"SELECT substr(data, 1, {_MAX_BLOB_BYTES}) FROM blobs "
            f"LIMIT {_MAX_BLOBS_PER_DB}"
        )
        for db in self.session_files():
            if len(found) == len(wanted):
                break
            rows = self._query(db, sql)
            if rows is None:
                continue
            session_id = self.session_id_from_path(db)
            for (value,) in rows:
                if isinstance(value, memoryview):
                    value = bytes(value)
                elif isinstance(value, str):
                    value = value.encode("utf-8", errors="ignore")
                if not isinstance(value, bytes):
                    continue
                for marker, needle in wanted.items():
                    if marker not in found and needle in value:
                        found[marker] = (session_id, "")
        return found


# ---- attribution/watch hooks (appended at module level: the reader class
# gains them via assignment below, keeping the copied class body untouched) --

def _workspace_match(self, usage, ws_path, owner_workspace=None):
    # store.db carries no cwd (only the meta.json sidecar does, and it is not
    # on the TokenUsage path). A session already bound to a pane (marker hit)
    # attributes to that pane's workspace, so the gate can never drop a
    # marker-bound session; otherwise fall back to the md5(cwd) project-hash
    # dir name in the file path, which the 2026-08-16 sample confirmed.
    if owner_workspace is not None and owner_workspace == ws_path:
        return True
    hash_dir = cursor_project_hash(ws_path)
    if hash_dir and hash_dir in Path(usage.file_path).parts:
        return True
    return False


def _pane_cwd_match(self, usage, pane_cwd, pane_id):
    # No cwd inside store.db; match the md5(cwd) project-hash dir in the file
    # path instead. Only the claim fallbacks use this — marker binding never
    # depends on it.
    hash_dir = cursor_project_hash(pane_cwd)
    return bool(hash_dir) and hash_dir in Path(usage.file_path).parts


CursorLogReader.binds_shared_db_by_marker = True
CursorLogReader.emits_session_sink = True
CursorLogReader.workspace_match = _workspace_match
CursorLogReader.pane_cwd_match = _pane_cwd_match


# ---- usage quota -----------------------------------------------------------

CURSOR_KEYCHAIN_SERVICE = "cursor-access-token"
CURSOR_REFRESH_KEYCHAIN_SERVICE = "cursor-refresh-token"
CURSOR_KEYCHAIN_ACCOUNT = "cursor-user"
#: Where Cursor keeps `state.vscdb` *below* its own application-support
#: directory. The part above it differs per platform — `~/Library/Application
#: Support` on macOS, `~/.config` on Linux, `%APPDATA%` on Windows — so it is
#: resolved through the platform seam rather than spelled out here. Written as
#: a macOS-shaped tuple, this reader could only ever find the database on
#: macOS, even though Cursor ships on all three.
CURSOR_IDE_STATE_DB_SUFFIX = ("User", "globalStorage", "state.vscdb")
CURSOR_IDE_TOKEN_KEY = "cursorAuth/accessToken"
CURSOR_USAGE_SUMMARY_URL = "https://cursor.com/api/usage-summary"


def _cursor_jwt_claims(token: str) -> dict | None:
    """Decode a JWT's payload (no signature check — the claims are only used
    to build the session cookie and pre-check expiry)."""
    parts = token.split(".")
    if len(parts) != 3:
        return None
    payload = parts[1]
    try:
        raw = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


def identity_from_secret(secret):
    """A parked slot holds both Keychain items (access + refresh). Signed in
    when the access token is a decodable session JWT; its ``sub`` user id is
    surfaced as the identity (no email is stored beside the token)."""
    items = keychain_payload_items(secret)
    access = items.get(f"{CURSOR_KEYCHAIN_SERVICE}|{CURSOR_KEYCHAIN_ACCOUNT}")
    user = cursor_user_id(access) if access else None
    return {"email": user, "signedIn": user is not None}


def cursor_user_id(token: str) -> str | None:
    """The WorkosCursorSessionToken user id: the JWT ``sub`` after the last
    ``|`` (e.g. ``google-oauth2|user_xxx`` -> ``user_xxx``)."""
    claims = _cursor_jwt_claims(token)
    sub = claims.get("sub") if claims else None
    if not isinstance(sub, str) or not sub:
        return None
    return sub.split("|")[-1] or None


def cursor_token_expired(token: str, now: float | None = None) -> bool:
    """True when the JWT ``exp`` (epoch seconds) has passed. Tokens are never
    refreshed here — the CLI/IDE rotate their own; missing/unreadable claims
    assume valid and let the endpoint's 401 decide."""
    claims = _cursor_jwt_claims(token)
    exp = _num(claims.get("exp")) if claims else None
    if exp is None:
        return False
    now = time.time() if now is None else now
    return now >= exp


def cursor_ide_state_db_path(home: Path) -> Path:
    """`state.vscdb` for this platform, below `home`.

    `home` is passed rather than assumed because the credential vault runs
    CLIs under per-pane home directories; resolving against the real user
    directory would read the wrong account's database.
    """
    return platform_paths.app_support_dir("Cursor", home=home).joinpath(
        *CURSOR_IDE_STATE_DB_SUFFIX
    )


def read_cursor_ide_token(home: Path) -> str | None:
    """The Cursor IDE fallback: the ``cursorAuth/accessToken`` ItemTable row of
    ``state.vscdb`` (sqlite, opened read-only) holds the raw session JWT."""
    path = cursor_ide_state_db_path(home)
    if not path.is_file():
        return None
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except sqlite3.Error:
        return None
    try:
        row = conn.execute("SELECT value FROM ItemTable WHERE key = ?",
                           (CURSOR_IDE_TOKEN_KEY,)).fetchone()
    except sqlite3.Error:
        return None
    finally:
        conn.close()
    if not row:
        return None
    value = row[0]
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    if not isinstance(value, str):
        return None
    value = value.strip()
    if value.startswith('"'):  # some rows store JSON-encoded strings
        try:
            value = json.loads(value)
        except ValueError:
            return None
    return value if isinstance(value, str) and value else None


_cursor_keychain_failed_at: float | None = None


async def read_cursor_credentials(home: Path) -> str | None:
    """cursor-agent CLI Keychain first (macOS ``security
    find-generic-password``, read-only), then the Cursor IDE state db. Returns
    the raw session JWT or None. A failed Keychain read is remembered for
    ``_KEYCHAIN_COOLDOWN_S`` (mirrors ``read_claude_credentials``). The CLI's
    Keychain slot is per-user, so per-pane isolated homes do not isolate
    cursor-agent credentials."""
    global _cursor_keychain_failed_at
    now = time.monotonic()
    if sys.platform == "darwin" and (
        _cursor_keychain_failed_at is None
        or now - _cursor_keychain_failed_at >= _KEYCHAIN_COOLDOWN_S
    ):
        try:
            proc = await asyncio.create_subprocess_exec(
                "/usr/bin/security", "find-generic-password",
                "-s", CURSOR_KEYCHAIN_SERVICE, "-w",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            out = await communicate_or_kill(proc, timeout=2.0)
            if proc.returncode == 0:
                _cursor_keychain_failed_at = None
                token = out.decode("utf-8", "replace").strip()
                if token:
                    return token
            else:
                _cursor_keychain_failed_at = now
        except (OSError, asyncio.TimeoutError):
            _cursor_keychain_failed_at = now
    return read_cursor_ide_token(home)


def normalize_cursor(data: dict) -> tuple[list[dict], str | None]:
    """``usage-summary``: ``individualUsage.plan`` (cent amounts;
    ``totalPercentUsed`` is already in percent units, used/limit is the
    fallback) -> one billing-cycle window resetting at ``billingCycleEnd``;
    an enabled, limited ``individualUsage.onDemand`` adds an on-demand
    window; ``membershipType`` -> planType."""
    plan = data.get("membershipType")
    plan = plan if isinstance(plan, str) and plan else None
    resets = data.get("billingCycleEnd")
    resets = resets if isinstance(resets, str) and resets else None
    individual = data.get("individualUsage")
    individual = individual if isinstance(individual, dict) else {}
    windows: list[dict] = []
    plan_usage = individual.get("plan")
    if isinstance(plan_usage, dict):
        pct = _num(plan_usage.get("totalPercentUsed"))
        if pct is None:
            limit = _num(plan_usage.get("limit"))
            used = _num(plan_usage.get("used"))
            if limit and used is not None:
                pct = used / limit * 100
        if pct is not None:
            windows.append(_window("cycle", "Plan usage", pct, resets))
    on_demand = individual.get("onDemand")
    if isinstance(on_demand, dict) and on_demand.get("enabled"):
        limit = _num(on_demand.get("limit"))
        used = _num(on_demand.get("used"))
        if limit and used is not None:
            windows.append(_window("on-demand", "On-demand",
                                   used / limit * 100, resets))
    return windows, plan


async def fetch_cursor(home: Path) -> dict:
    token = await read_cursor_credentials(home)
    if token is None:
        return _snapshot("cursor", "no-credentials")
    if cursor_token_expired(token):
        return _snapshot("cursor", "expired")
    user_id = cursor_user_id(token)
    if user_id is None:
        return _snapshot("cursor", "error",
                         error="session token has no usable sub claim")
    import httpx

    # The one provider here that still needs a browser-shaped credential. The
    # User-Agent is honest, but ``usage-summary`` authenticates a signed-in
    # cursor.com session and nothing else: measured 2026-08-05, the same token
    # as ``Authorization: Bearer`` returns 401 while the session cookie returns
    # 200. The token is the user's own, read from their own machine — but this
    # is a dashboard session rebuilt from it, not an API credential, and that
    # distinction is the reason this one is worth revisiting if Cursor ever
    # publishes a real endpoint.
    headers = {
        "Cookie": f"WorkosCursorSessionToken={user_id}%3A%3A{token}",
        "Accept": "application/json",
        "User-Agent": "Navide",
    }
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(CURSOR_USAGE_SUMMARY_URL, headers=headers)
    if resp.status_code in (401, 403):
        return _snapshot("cursor", "expired")
    if resp.status_code == 429:
        snap = _snapshot("cursor", "rate-limited")
        snap["retryAfterSec"] = parse_retry_after(resp.headers.get("Retry-After"))
        return snap
    if resp.status_code != 200:
        return _snapshot("cursor", "error", error=f"HTTP {resp.status_code}")
    try:
        payload = resp.json()
    except ValueError:
        return _snapshot("cursor", "error", error="non-JSON response")
    windows, plan = normalize_cursor(payload if isinstance(payload, dict) else {})
    if not windows:
        return _snapshot("cursor", "error",
                         error="response had no usable quota fields")
    return _snapshot("cursor", "ok", windows=windows, plan_type=plan)


# ---- resume / session ------------------------------------------------------

# Cursor CLI's binary is `agent` (legacy installs: `cursor-agent`); both take
# --resume=<id> / --resume <id>.
_RESUME_RE = re.compile(
    r"^(?:agent|cursor-agent)\s+(?:\S+\s+)*--resume(?:=(\S+)|\s+([^-\s]\S*))"
)


def _resume_id_from_command(command) -> str:
    """Session id from an `agent ... --resume=<id>` /
    `cursor-agent ... --resume <id>` command ('' otherwise)."""
    m = _RESUME_RE.match(command_text(command).strip())
    return (m.group(1) or m.group(2)) if m else ""


def _session_path(workspace_path: str, session_id: str) -> Path | None:
    # The session path has a project-hash segment the id alone can't name —
    # no single stable path for the preflight to report.
    return None


def _session_exists(workspace_path: str, session_id: str) -> bool:
    # Ask the reader so a stale persisted id fails preflight instead of
    # launching a doomed `agent --resume`.
    return CursorLogReader().has_session(session_id)


# ---- vendor spec -----------------------------------------------------------

# Where this CLI keeps the extensions it installed for itself (read-only
# inventory, cli_extensions). Verified 2026-10-10 against the installed
# binary's --help and the files on disk.
_EXTENSIONS = ExtensionsSpec(sources=(
    ExtensionsSource("plugin-dirs", (".cursor", "plugins", "cache"), "Cursor plugin"),
    ExtensionsSource("plugin-dirs", (".cursor", "plugins", "local"), "Cursor plugin"),
    ExtensionsSource("hooks", (".cursor", "hooks.json"), "Cursor hook", section=("hooks",)),
))

SPEC = VendorSpec(
    extensions=_EXTENSIONS,
    key="cursor",
    # The web quota endpoint is not evidence of the CLI's inference hosts.
    expected_hosts=(),
    # Verified CLI conversation store; exclude the IDE's other .cursor data.
    data_dirs=lambda ctx: (ctx.path(ctx.home / ".cursor" / "chats"),),
    supports_model=True,
    # Verified 2026-08-15 (docs): .cursor/skills and .agents/skills in the
    # project, ~/.cursor/skills globally, and no relocation variable at all —
    # the same corner its MCP wiring is in, so the workspace file is again the
    # only surface. Its CLI is also documented not to load ~/.agents/skills.
    skills_supported=True,
    skills_wiring=SkillsWiring(
        project_rel=(".cursor", "skills"),
        # ~/.agents/skills too, per its docs — though its CLI is documented
        # not to load that root, so the automatic cell is best-effort here.
        reads_shared_root=True,
    ),
    label="Cursor CLI",
    # Multi-account: cursor-agent keeps its session in two macOS Keychain
    # items (access + refresh, account "cursor-user"), swapped as a pair. No
    # config-dir variable isolates a login, so a sign-in runs against the
    # real Keychain and is captured afterwards. The display ``authInfo`` in
    # cli-config.json is the CLI's own cache and is left alone (it re-derives
    # it from the token). Non-macOS storage not established from source.
    # Restart, then ``cursor-agent --resume=<uuid>``.
    slot_file="credential.json",
    identity_from_secret=identity_from_secret,
    account_switch=AccountSwitchSpec(
        auth_scope="cursor",
        method="restart",
        store="keychain",
        evidence="source",
        verified_version="2026.08.25-3e8eec8",
        platforms=("darwin",),
        keychain_items=(
            (CURSOR_KEYCHAIN_SERVICE, CURSOR_KEYCHAIN_ACCOUNT),
            (CURSOR_REFRESH_KEYCHAIN_SERVICE, CURSOR_KEYCHAIN_ACCOUNT),
        ),
        # `cursor-agent` honours CURSOR_API_KEY over the stored session.
        shadowing_env=("CURSOR_API_KEY",),
        resume="native",
        todo="cli-config.json authInfo shows the previous account until the CLI refreshes it; non-macOS storage unknown; no real-account round-trip recorded",
    ),
    # The one CLI with no spawn-time surface — no MCP flag, no config
    # variable — so its per-project config file is the only way in. A bare
    # "url" is read as a remote server (stdio is the shape that names its
    # transport), and cursor interpolates ${env:...} inside it, which is what
    # lets one shared file serve panes with different per-pane URLs.
    mcp_wiring=McpWiring(
        config=McpServerConfig(
            section=("mcpServers",),
            entry=(("url", McpValue.URL),),
        ),
        project_config=(".cursor", "mcp.json"),
        url_env_template="${env:%s}",
    ),
    # Late-bound (module global at call time) so tests can monkeypatch.
    fetch_usage=lambda home: fetch_cursor(home),
    resume_id_from_command=_resume_id_from_command,
    session_path=_session_path,
    session_exists=_session_exists,
    make_log_reader=CursorLogReader,
    # Cursor CLI (closed source; binary `agent`, legacy installs `cursor-agent`)
    # ships `agent update` but no doctor subcommand. Autoupdate is on by default
    # with no confirmed opt-out env, and its data home is fixed at ~/.cursor
    # (no config-home env) — both stay empty. `cursor-agent` is declared as an
    # alternate so a machine still carrying the legacy binary is detected and
    # spawnable instead of being reported as not installed.
    install_dep=Dep("cursor", "Cursor CLI", "Cursor terminal coding agent CLI", "agent_cli",
        ["agent", "--version"], r"^(\d+\.\d+\.\d+)",
        alt_commands=("cursor-agent",),
        # Cursor prints a bare version (`2026.08.25-3e8eec8`); a squatter on
        # the `agent` name prints its own name first. Anchoring the version
        # pattern and asking for the same shape here is what tells the two
        # apart — measured against both binaries on 2026-09-18.
        identity_regex=r"^\d+\.\d+",
        install_cmd="curl https://cursor.com/install -fsS | bash",
        needs_terminal=True, requires_binaries=("curl",), optional=True,
        docs_url="https://cursor.com/docs/cli",
        # Windows (native): per https://cursor.com/docs/cli/installation
        install_cmds={"win32": PlatformInstall(
            "irm 'https://cursor.com/install?win32=true' | iex", needs_terminal=True)},
        update_cmd="agent update"),
)
