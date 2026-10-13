"""OpenCode CLI conversation reader.

Storage: ONE shared SQLite database (WAL journal) holding all projects and
sessions — <XDG_DATA_HOME|~/.local/share>/opencode/opencode.db:

  session   id (`ses_…`), project_id, parent_id (non-NULL = subagent child
            session), directory (the session's cwd), token totals
  message   id (`msg_…`), session_id, data = message JSON. Assistant data
            carries tokens {input, output, reasoning, cache{read,write}},
            modelID and time {created, completed}; rows are UPDATEd in place
            while a turn streams, so tokens are only credited once
            time.completed lands.
  part      message content blocks; user input text is stored verbatim in
            data ({"type":"text","text":…}) — the `at-pane:` marker lives here.

Responsibilities:
  • parse_session_file()/parse_incremental(): completed assistant messages →
    TokenUsage (cache folded into input, reasoning into output). cwd is the
    session's `directory` so Attribution's workspace gate matches the pane cwd.
  • find_sessions_by_marker(): resolve `at-pane:<paneId>` kickoff markers to
    (session_id, directory) by scanning user-message text parts of top-level
    sessions (subagent child sessions are excluded) — used by Attribution to
    emit session.detected (resume id = session.id, `opencode --session <id>`).

Concurrency: the opencode process owns the WAL writer, so every connection
here is read-only (`file:…?mode=ro` URI), short-lived, and busy/locked-
tolerant — any sqlite error is treated as "no new data this cycle". A missing
db just means the CLI isn't installed → silently skip.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
from collections.abc import Iterable
from dataclasses import replace
from pathlib import Path

import re

from .base import ExtensionsSource, ExtensionsSpec  # noqa: F401
from .base import (
    PlatformInstall,
    AccountSwitchSpec,
    Dep,
    McpServerConfig,
    McpValue,
    McpWiring,
    PushChannel,
    SkillsWiring,
    VendorSpec,
    command_text,
    provider_entry_identity,
    provider_map_extract,
    provider_map_merge,
)
from . import _protocols
from ..usage_common import HTTP_TIMEOUT, _epoch_to_iso, _num, _snapshot, _window, parse_retry_after
from ..log_readers.base import (
    ActivityEvent,
    IncrementalParseResult,
    LogReader,
    TokenUsage,
    user_prompt_text,
)

log = logging.getLogger("agent_team_backend.log_readers.opencode")

_DB_NAME = "opencode.db"

# Row-fetch busy wait: long enough to ride out an opencode write transaction,
# short enough not to stall the watcher's drain thread.
_BUSY_TIMEOUT_MS = 250

# In-flight (not yet completed) assistant rows re-checked on later cycles.
# Bounded so the compact checkpoint stays compact; rows abandoned mid-stream
# (CLI crash) eventually fall off the front.
_PENDING_CAP = 64

# message.id is a text key, so incremental parsing watermarks on the table's
# implicit rowid (monotonic per INSERT; UPDATEs keep it stable).
_USAGE_SQL = """
SELECT m.rowid, m.id, m.session_id, m.data, COALESCE(s.directory, '')
FROM message m
JOIN session s ON s.id = m.session_id
{where}
ORDER BY m.rowid
"""

# The watermark row's immutable columns (`data` is rewritten while an
# assistant message streams), so a replacement db can be recognised even
# when it lands on the same dev:ino (Linux reuses a freed inode number for
# the very next file created).
_ANCHOR_SQL = "SELECT id, session_id FROM message WHERE rowid = ?"


def _anchor(values: tuple) -> str:
    """Fingerprint of one message row, columns in `_ANCHOR_SQL` order."""
    return "|".join(str(v) for v in values)

# Markers are typed by the user, so they live in text parts of user messages.
# parent_id IS NULL keeps subagent child sessions out — a marker forwarded
# into a subagent prompt must not bind the child id (it can't be resumed as
# the pane's session).
_MARKER_SQL = """
SELECT p.session_id, p.data, m.data, COALESCE(s.directory, '')
FROM part p
JOIN message m ON m.id = p.message_id
JOIN session s ON s.id = p.session_id
WHERE p.data LIKE '%at-pane:%' AND s.parent_id IS NULL
ORDER BY p.time_created
"""


# Activity watermark: `part.rowid`. Unlike `message` — whose rows are updated
# in place while a reply streams, which is why the token path needs its
# `pending` list — `part` is append-only content blocks, so a rowid watermark
# can never skip one.
_ACTIVITY_PREFIX = "opencode_part::"
_MAX_PARTS_PER_PASS = 256

# parent_id comes along so a subagent's turn end can be told apart from the
# pane's own: child sessions share their parent's `directory`, so both resolve
# to the same pane and a child's "stop" would open the messaging gate while the
# parent is still working.
_ACTIVITY_SQL = """
SELECT p.rowid, p.session_id, p.message_id, p.data, m.data,
       COALESCE(s.directory, ''), s.parent_id, p.time_created
FROM part p
JOIN message m ON m.id = p.message_id
JOIN session s ON s.id = p.session_id
WHERE p.rowid > ?
ORDER BY p.rowid
LIMIT ?
"""

# Text blocks of one message, for the reply a completed turn carries.
_TURN_TEXT_SQL = "SELECT data FROM part WHERE message_id = ? ORDER BY rowid"


def _int(v) -> int:  # noqa: ANN001
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return 0


def _json_obj(raw) -> dict:  # noqa: ANN001
    """Parsed JSON column, {} when absent or malformed."""
    try:
        parsed = json.loads(str(raw or ""))
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _data_dir(app_dir: str) -> Path:
    env = os.environ.get("XDG_DATA_HOME")
    base = Path(env) if env else Path.home() / ".local" / "share"
    return base / app_dir


def _tokens_from_data(data: dict) -> tuple[int, int]:
    """(input, output) with cache reads/writes folded into input and
    reasoning folded into output (per TokenUsage design)."""
    tokens = data.get("tokens")
    if not isinstance(tokens, dict):
        return 0, 0
    cache = tokens.get("cache")
    if not isinstance(cache, dict):
        cache = {}
    input_tokens = (
        _int(tokens.get("input")) + _int(cache.get("read")) + _int(cache.get("write"))
    )
    output_tokens = _int(tokens.get("output")) + _int(tokens.get("reasoning"))
    return input_tokens, output_tokens


def _completed_ms(data: dict) -> int:
    """time.completed (epoch ms) of an assistant message; 0 while streaming."""
    t = data.get("time")
    return _int(t.get("completed")) if isinstance(t, dict) else 0


class OpencodeLogReader(LogReader):
    vendor: str = "opencode"
    # Kilo Code is an OpenCode fork with the same schema — KiloLogReader
    # subclasses this reader and overrides only these location attributes.
    _dir_name: str = "opencode"
    _db_name: str = _DB_NAME

    def _opencode_dirs(self) -> list[Path]:
        """The single shared data dir (as a list for callers that iterate it)."""
        return [_data_dir(self._dir_name)]

    def _db_paths(self) -> list[Path]:
        return [d / self._db_name for d in self._opencode_dirs()]

    def project_dirs(self) -> list[Path]:
        return [d for d in self._opencode_dirs() if d.is_dir()]

    def session_files(self) -> list[Path]:
        return [db for db in self._db_paths() if db.is_file()]

    def session_id_from_path(self, path: Path) -> str:
        """Only the shared db is a session source. Sibling files under the
        data dir (auth.json, legacy storage/*.json) must not coin bogus ids
        or trigger pointless marker scans."""
        if path.name != self._db_name:
            return ""
        return path.stem

    def has_session(self, session_id: str) -> bool:
        """True if the shared db knows this session id. The resume preflight
        uses this so a stale persisted id fails preflight instead of
        launching a doomed `opencode --session <id>`."""
        session_id = session_id.strip()
        if not session_id:
            return False
        for db in self._db_paths():
            if not db.is_file():
                continue
            rows = self._query(
                db, "SELECT 1 FROM session WHERE id = ?", (session_id,)
            )
            if rows:
                return True
        return False

    def _query(
        self, path: Path, sql: str, params: tuple = ()
    ) -> list[tuple] | None:
        """Short-lived read-only query. None = db unreadable this cycle
        (missing / busy / locked / mid-write) — callers treat it as no data."""
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

    def _session_versions(self, path: Path) -> dict[str, str]:
        """session id → the CLI version that wrote it (``session.version``).
        A schema without the column (older CLIs) simply yields no versions;
        the usage query itself must not depend on it."""
        rows = self._query(path, "SELECT id, version FROM session")
        if not rows:
            return {}
        return {str(sid): str(ver or "") for sid, ver in rows if sid}

    def _event_from_row(
        self, path: Path, row: tuple, versions: dict[str, str] | None = None
    ) -> tuple[TokenUsage | None, bool]:
        """(event, done) for one message row. done=False means the row is a
        still-streaming assistant message — retry it on a later cycle."""
        _row_id, message_id, session_id, data_json, directory = row
        try:
            data = json.loads(str(data_json or ""))
        except json.JSONDecodeError:
            data = None
        if not isinstance(data, dict) or data.get("role") != "assistant":
            return None, True
        completed = _completed_ms(data)
        if not completed:
            return None, False
        input_tokens, output_tokens = _tokens_from_data(data)
        if input_tokens == 0 and output_tokens == 0:
            return None, True
        return TokenUsage(
            vendor=self.vendor,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cwd=str(directory or ""),
            session_id=str(session_id or ""),
            file_path=str(path),
            dedup_key=f"msg:{message_id}",
            timestamp=str(completed),
            model=str(data.get("modelID") or ""),
            cli_version=(versions or {}).get(str(session_id or ""), ""),
        ), True

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        # The watcher routes every .json/.db under the data dir here (e.g.
        # auth.json, legacy storage/); only the shared db carries sessions.
        if path.name != self._db_name:
            return []
        rows = self._query(path, _USAGE_SQL.format(where=""))
        if rows is None:
            return []
        versions = self._session_versions(path) if rows else {}
        out: list[TokenUsage] = []
        for row in rows:
            key = f"msg:{row[1]}"
            if key in seen_keys:
                continue
            event, done = self._event_from_row(path, row, versions)
            if not done:
                continue  # still streaming — not marked seen, retried next cycle
            seen_keys.add(key)
            if event is not None:
                out.append(event)
        return out

    def parse_incremental(
        self,
        path: Path,
        checkpoint: dict,
    ) -> IncrementalParseResult:
        if path.name != self._db_name:
            return IncrementalParseResult([], dict(checkpoint))
        try:
            stat = path.stat()
        except OSError:
            return IncrementalParseResult([], dict(checkpoint))
        identity = f"{stat.st_dev}:{stat.st_ino}"
        replaced = bool(checkpoint.get("identity") and checkpoint.get("identity") != identity)
        last_row_id = 0 if replaced else max(0, int(checkpoint.get("row_id") or 0))
        anchor = "" if replaced else str(checkpoint.get("anchor") or "")
        pending: set[int] = (
            set()
            if replaced
            else {int(r) for r in (checkpoint.get("pending") or []) if int(r) > 0}
        )
        if last_row_id and anchor:
            # Same dev:ino is not proof of the same db. A row standing under
            # the watermark rowid that is not the message the mark was taken
            # from was never credited — the db was replaced, or the newest
            # rows were deleted and the rowid handed out again. Re-anchor just
            # below it; anything further down is left alone, as for a drop,
            # so a stale mark can never re-credit history. A missing row is
            # left to the drop check below.
            current = self._query(path, _ANCHOR_SQL, (last_row_id,))
            if current and _anchor(current[0]) != anchor:
                last_row_id -= 1
                anchor = ""
                pending = set()

        def _where(watermark: int, pend: set[int]) -> str:
            clause = f"WHERE m.rowid > {watermark}"
            if pend:
                clause += f" OR m.rowid IN ({','.join(str(r) for r in sorted(pend))})"
            return clause

        rows = self._query(path, _USAGE_SQL.format(where=_where(last_row_id, pending)))
        if rows is None:
            return IncrementalParseResult([], dict(checkpoint))
        if not rows and last_row_id:
            max_rows = self._query(path, "SELECT COALESCE(MAX(rowid), 0) FROM message")
            max_row_id = int(max_rows[0][0]) if max_rows else last_row_id
            if max_row_id < last_row_id:
                # Watermark dropped (session deleted with ON DELETE CASCADE, or
                # a Drizzle table rebuild on upgrade): re-anchor, never rescan —
                # everything at or below the new max was already credited under
                # the old numbering. Trade-off: a message created between the
                # drop and this poll goes uncredited (bounded, tiny), which is
                # strictly preferable to re-crediting the whole history.
                last_row_id = max_row_id
                pending = set()
                current = self._query(path, _ANCHOR_SQL, (last_row_id,))
                anchor = _anchor(current[0]) if current else ""

        out: list[TokenUsage] = []
        next_row_id = last_row_id
        versions = self._session_versions(path) if rows else {}

        def _cursor() -> dict:
            trimmed = sorted(pending)[-_PENDING_CAP:]
            return {
                "kind": "sqlite",
                "row_id": next_row_id,
                "pending": trimmed,
                "identity": identity,
                "anchor": anchor,
            }

        for row in rows:
            row_id = int(row[0])
            if row_id > next_row_id:
                next_row_id = row_id
                anchor = _anchor(row[1:3])
            event, done = self._event_from_row(path, row, versions)
            if not done:
                pending.add(row_id)  # streaming assistant row — recheck later
                continue
            pending.discard(row_id)
            if event is None:
                continue
            out.append(replace(event, checkpoint=_cursor()))
        return IncrementalParseResult(out, _cursor())

    # ── activity ────────────────────────────────────────────────────────────

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """One event per new `part` row.

        This vendor records turn ends outright, which is rarer than it sounds:
        a `step-finish` part carries the LLM's own finish reason, and `"stop"`
        means the agent has finished replying (as opposed to `"tool-calls"`,
        which means it is pausing to run something). No silence window and no
        inference is needed.

        Without this, opencode and kilo emitted no activity at all, leaving the
        inter-CLI messaging gate permanently open — a message could land in the
        composer mid-turn, where the TUI leaves it unsent.
        """
        if path.name != self._db_name:
            return []
        prev = next(
            (k[len(_ACTIVITY_PREFIX):] for k in seen_keys if k.startswith(_ACTIVITY_PREFIX)),
            None,
        )
        def remember(row_id: int) -> None:
            seen_keys.difference_update(
                {k for k in seen_keys if k.startswith(_ACTIVITY_PREFIX)}
            )
            seen_keys.add(_ACTIVITY_PREFIX + str(row_id))

        # First sight of the db: everything in it is history, not activity
        # happening now. The db is shared across every session this CLI has
        # ever run, so reporting it would light up panes that are doing
        # nothing. Skip to the LAST row rather than the last row of one capped
        # page — otherwise the pages after it read as fresh activity next pass.
        if prev is None:
            newest = self._query(path, "SELECT MAX(rowid) FROM part")
            if newest and newest[0][0] is not None:
                remember(int(newest[0][0]))
            return []
        rows = self._query(path, _ACTIVITY_SQL, (int(prev), _MAX_PARTS_PER_PASS))
        if not rows:
            return []
        remember(int(rows[-1][0]))
        return [ev for row in rows for ev in self._activity_from_part(path, row)]

    def _turn_reply_text(self, path: Path, message_id: str) -> str:
        """The assistant text of one message, joined across its text parts."""
        rows = self._query(path, _TURN_TEXT_SQL, (message_id,))
        if not rows:
            return ""
        chunks: list[str] = []
        for (data_json,) in rows:
            part = _json_obj(data_json)
            if part.get("type") == "text":
                text = str(part.get("text") or "").strip()
                if text:
                    chunks.append(text)
        return "\n".join(chunks)

    def _activity_from_part(self, path: Path, row: tuple) -> list[ActivityEvent]:
        row_id, session_id, message_id, part_json, msg_json, directory, parent_id, created_ms = row
        part = _json_obj(part_json)
        part_type = str(part.get("type") or "")
        role = str(_json_obj(msg_json).get("role") or "")

        def make(event_type: str, detail: str, text: str = "") -> ActivityEvent:
            return ActivityEvent(
                vendor=self.vendor,  # kilo inherits this reader unchanged
                event_type=event_type,
                cwd=str(directory or ""),
                session_id=str(session_id or ""),
                file_path=str(path),
                dedup_key=f"part:{int(row_id)}",
                timestamp=_epoch_to_iso(_int(created_ms) / 1000) or "",
                detail=detail,
                text=text,
            )

        if part_type == "step-finish":
            reason = str(part.get("reason") or "")
            # "tool-calls" is a pause to run something, not the end of a turn.
            if reason != "stop":
                return [make("agent_active", f"step-finish:{reason or 'unknown'}")]
            if parent_id:
                # A subagent finished. Its parent is still working, and both
                # share a directory, so calling this a turn end would hand the
                # pane's gate to the wrong session.
                return [make("agent_active", "subagent:done")]
            return [make(
                "turn_complete", "assistant",
                self._turn_reply_text(path, str(message_id or "")),
            )]
        if part_type == "tool":
            return [make("agent_active", f"tool:{part.get('tool') or 'unknown'}")]
        if part_type == "text" and role == "user":
            # "user" is the cross-end contract detail panes are named from.
            return [make(
                "agent_active", "user",
                user_prompt_text(str(part.get("text") or "")),
            )]
        if part_type == "reasoning":
            return [make("agent_active", "assistant:thinking")]
        if part_type == "text":
            return [make("agent_active", "assistant")]
        return [make("agent_active", part_type or "part")]

    def find_sessions_by_marker(
        self, markers: Iterable[str]
    ) -> dict[str, tuple[str, str]]:
        """marker → (session_id, session directory) for kickoff markers found
        in user-message text parts of top-level sessions. Earliest match wins
        per marker. Empty dict when nothing matches or the db is unreadable
        this cycle."""
        wanted = [m for m in markers if m]
        if not wanted:
            return {}
        found: dict[str, tuple[str, str]] = {}
        for db in self._db_paths():
            if not db.is_file():
                continue
            rows = self._query(db, _MARKER_SQL)
            if rows is None:
                continue
            for session_id, part_json, message_json, directory in rows:
                try:
                    message = json.loads(str(message_json or ""))
                except json.JSONDecodeError:
                    continue
                if not isinstance(message, dict) or message.get("role") != "user":
                    continue
                text = str(part_json or "")
                for marker in wanted:
                    if marker not in found and marker in text:
                        found[marker] = (str(session_id or ""), str(directory or ""))
        return found


# ---- attribution/watch hooks ----------------------------------------------

def _workspace_match(self, usage, ws_path, owner_workspace=None):
    # Reader emits cwd = session.directory (the cwd the session started in).
    return bool(usage.cwd and usage.cwd == ws_path)


def _pane_cwd_match(self, usage, pane_cwd, pane_id):
    return usage.cwd == pane_cwd


OpencodeLogReader.binds_shared_db_by_marker = True
OpencodeLogReader.emits_session_sink = True
OpencodeLogReader.workspace_match = _workspace_match
OpencodeLogReader.pane_cwd_match = _pane_cwd_match


# ---- usage quota -----------------------------------------------------------
# Aggregator: auth.json entries route to their own providers. The Anthropic
# OAuth grant goes through the shared protocol (cli_vendors/_protocols);
# minimax-coding-plan hits MiniMax's own endpoint; Zen / plain BYOK keys
# have no readable quota and map to unavailable.

OPENCODE_AUTH_FILE_REL = (".local", "share", "opencode", "auth.json")
# Providers whose ``auth.json`` entry is an account of its own — the ids the
# CLI's ``auth login`` offers (its ordering map in 1.15.12 lists opencode,
# openai, github-copilot, google, anthropic, openrouter, vercel; the ChatGPT
# OAuth is stored under "openai") plus the MiniMax coding-plan key the quota
# reader already understands. Any other provider id stays untouched by a
# switch: it is not a scope a profile can bind to.
OPENCODE_ACCOUNT_SCOPES = (
    "anthropic",
    "openai",
    "github-copilot",
    "google",
    "opencode",
    "openrouter",
    "vercel",
    "minimax-coding-plan",
)


def _opencode_auth_file(home: Path, env: dict | None = None) -> Path:
    """The CLI's own rule (1.15.12): ``$XDG_DATA_HOME/opencode/auth.json``
    when the variable is set, else ``~/.local/share/opencode/auth.json``."""
    env = os.environ if env is None else env
    xdg = env.get("XDG_DATA_HOME")
    return Path(xdg) / "opencode" / "auth.json" if xdg else home.joinpath(*OPENCODE_AUTH_FILE_REL)
OPENCODE_MINIMAX_USAGE_URL = "https://api.minimax.io/v1/token_plan/remains"


def read_opencode_credentials(home: Path, env: dict | None = None) -> dict | None:
    """Parse ``<XDG_DATA_HOME|~/.local/share>/opencode/auth.json``: providerID ->
    credential entry ({type: "api", key} or {type: "oauth", access, refresh,
    expires}). Returns the dict-valued entries, or None when the file is
    absent/malformed/empty."""
    path = _opencode_auth_file(home, env)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    entries = {k: v for k, v in data.items() if isinstance(v, dict)}
    return entries or None


def opencode_minimax_key(auth: dict) -> str | None:
    """The MiniMax coding-plan API key from an opencode auth map, or None."""
    entry = auth.get("minimax-coding-plan")
    if not isinstance(entry, dict) or entry.get("type") != "api":
        return None
    key = entry.get("key")
    return key if isinstance(key, str) and key else None


def opencode_anthropic_oauth(auth: dict) -> dict | None:
    """Map an ``anthropic`` {type: "oauth"} entry to the claudeAiOauth shape
    (accessToken + epoch-ms expiresAt) so the existing Claude usage flow can
    be reused as-is."""
    entry = auth.get("anthropic")
    if not isinstance(entry, dict) or entry.get("type") != "oauth":
        return None
    access = entry.get("access")
    if not isinstance(access, str) or not access:
        return None
    return {"accessToken": access, "expiresAt": entry.get("expires")}




def normalize_opencode_minimax(data: dict) -> list[dict]:
    """MiniMax ``token_plan/remains``: ``model_remains[]`` per model; the
    coding plan is the ``model_name == "general"`` entry. Percents are
    remaining -> used; epoch-ms end times -> ISO resetsAt."""
    for entry in data.get("model_remains") or []:
        if not isinstance(entry, dict) or entry.get("model_name") != "general":
            continue
        windows: list[dict] = []
        interval = _num(entry.get("current_interval_remaining_percent"))
        if interval is not None:
            end = _num(entry.get("end_time"))
            windows.append(_window(
                "session", "MiniMax (5h)", 100.0 - interval,
                _epoch_to_iso(end / 1000) if end is not None else None))
        weekly = _num(entry.get("current_weekly_remaining_percent"))
        if weekly is not None:
            end = _num(entry.get("weekly_end_time"))
            windows.append(_window(
                "weekly", "MiniMax weekly", 100.0 - weekly,
                _epoch_to_iso(end / 1000) if end is not None else None))
        return windows
    return []




async def _fetch_opencode_minimax(key: str) -> dict:
    import httpx

    headers = {
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
        "User-Agent": "Navide",
    }
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(OPENCODE_MINIMAX_USAGE_URL, headers=headers)
    if resp.status_code in (401, 403):
        return _snapshot("opencode", "expired")
    if resp.status_code == 429:
        snap = _snapshot("opencode", "rate-limited")
        snap["retryAfterSec"] = parse_retry_after(resp.headers.get("Retry-After"))
        return snap
    if resp.status_code != 200:
        return _snapshot("opencode", "error", error=f"HTTP {resp.status_code}")
    payload = resp.json()
    base = payload.get("base_resp") if isinstance(payload, dict) else None
    status_code = _num((base or {}).get("status_code"))
    if status_code is not None and status_code != 0:
        msg = (base or {}).get("status_msg")
        return _snapshot("opencode", "error",
                         error=str(msg or f"MiniMax status {int(status_code)}"))
    return _snapshot("opencode", "ok", windows=normalize_opencode_minimax(payload))


async def fetch_opencode(home: Path, env: dict | None = None) -> dict:
    """opencode is an aggregator: each supported ``auth.json`` entry is asked
    its own provider's usage endpoint. Any source that answers makes the
    snapshot "ok" (windows combined); with none answering the first failure
    is surfaced; entries without a usage surface (Zen, BYOK keys) alone ->
    unavailable."""
    auth = read_opencode_credentials(home, env)
    if auth is None:
        return _snapshot("opencode", "no-credentials")
    sub_snaps: list[dict] = []
    key = opencode_minimax_key(auth)
    if key is not None:
        sub_snaps.append(await _fetch_opencode_minimax(key))
    oauth = opencode_anthropic_oauth(auth)
    if oauth is not None:
        snap = await _protocols.fetch_claude_oauth(oauth)
        snap["provider"] = "opencode"
        snap["windows"] = [dict(w, label=f"Claude — {w['label']}")
                           for w in snap["windows"]]
        sub_snaps.append(snap)
    if not sub_snaps:
        return _snapshot(
            "opencode", "unavailable",
            error="no auth.json entry has a usage API "
                  "(opencode Zen and plain API keys expose none)")
    ok = [s for s in sub_snaps if s["status"] == "ok"]
    if ok:
        return _snapshot("opencode", "ok",
                         windows=[w for s in ok for w in s["windows"]])
    return sub_snaps[0]




# ---- resume / session ------------------------------------------------------

_RESUME_RE = re.compile(r"^opencode\s+(?:\S+\s+)*(?:--session|-s)\s+([^-\s]\S*)")


def _resume_id_from_command(command) -> str:
    """Session id from an `opencode ... --session <id>` / `-s <id>` command
    ('' otherwise)."""
    m = _RESUME_RE.match(command_text(command).strip())
    return m.group(1) if m else ""


def _session_exists(workspace_path: str, session_id: str) -> bool:
    # Every session lives in one shared SQLite db; ask the reader so a stale
    # persisted id fails preflight instead of launching a doomed
    # `opencode --session <id>`.
    return OpencodeLogReader().has_session(session_id)


# ---- vendor spec -----------------------------------------------------------

# Where this CLI keeps the extensions it installed for itself (read-only
# inventory, cli_extensions). Verified 2026-10-10 against the installed
# binary's --help and the files on disk.
_EXTENSIONS = ExtensionsSpec(sources=(
    ExtensionsSource("code-files", (".config", "opencode", "plugins"), "opencode plugin"),
    ExtensionsSource("npm-list", (".config", "opencode", "opencode.json"), "opencode plugin", section=("plugin",)),
    ExtensionsSource("npm-list", (".config", "opencode", "opencode.jsonc"), "opencode plugin", section=("plugin",)),
))

SPEC = VendorSpec(
    extensions=_EXTENSIONS,
    key="opencode",
    # Arbitrary provider config; a selected quota provider is not a CLI host set.
    expected_hosts=(),
    # Same XDG database/auth root as _data_dir("opencode").
    data_dirs=lambda ctx: (ctx.path(ctx.env.get("XDG_DATA_HOME") or ctx.home / ".local" / "share") / "opencode",),
    data_dir_env_vars=("XDG_DATA_HOME",),
    supports_model=True,
    skills_supported=True,
    # skills.paths registers extra roots; opencode deep-merges this document
    # over the user's own config, so their skills keep loading.
    skills_wiring=SkillsWiring(
        config_env="OPENCODE_CONFIG_CONTENT",
        reads_shared_root=True,
        config_paths_key=("skills", "paths"),
    ),
    label="OpenCode (Anomaly)",
    # No MCP flag; instead a whole config document read out of
    # OPENCODE_CONFIG_CONTENT and deep-merged over the user's files, so nothing
    # on disk is touched and the value dies with the pane. Verified against
    # `opencode mcp list`: a remote server is type "remote", and an
    # "mcpServers" key is rejected outright as unrecognised.
    mcp_wiring=McpWiring(
        config=McpServerConfig(
            section=("mcp",),
            entry=(
                ("type", "remote"),
                ("url", McpValue.URL),
                ("enabled", True),
            ),
            document=(("$schema", "https://opencode.ai/config.json"),),
        ),
        config_env="OPENCODE_CONFIG_CONTENT",
    ),
    # The TUI is a client of a server the same process runs, and `/tui/*` drives
    # that TUI. Bare `opencode` opens no port at all, so the pane is spawned with
    # one; `--hostname` is passed explicitly rather than relied on as the default
    # so nothing in the user's setup can widen it past loopback.
    #
    # NO PASSWORD, deliberately. Verified against 1.15.12: OPENCODE_SERVER_
    # PASSWORD protects the server from us but not for us — the CLI's own TUI
    # does not authenticate against it, so every request it makes to itself
    # comes back 401 and the pane dies on startup. The port is therefore open to
    # anything running as this user, which is the cost of the channel and is
    # documented as such in docs/en-US/inter-cli-messaging.md.
    #
    # Verified end to end: append lands in the composer (repeated calls
    # concatenate), submit starts a real turn and empties it, and `?directory=`
    # is NOT a workspace gate — a wrong path is accepted just the same, so the
    # per-pane port is the only isolation there is.
    push_channel=PushChannel(
        holds_input_box=True,
        port_flag="--port",
        host_flag="--hostname",
        append_path="/tui/append-prompt",
        submit_path="/tui/submit-prompt",
        clear_path="/tui/clear-prompt",
    ),
    # `opencode auth login [url]` (verified against `opencode auth --help`,
    # 1.15.12) opens the provider picker, then the chosen provider's own
    # OAuth or key prompt — a flow a PTY pane carries.
    login_command_args="auth login",
    # Multi-account: ``auth.json`` is a provider map, so a profile binds to
    # ONE provider entry (``scopes``) and a switch rewrites that entry only.
    # The data dir follows XDG_DATA_HOME alone — no dedicated variable to
    # give a login pane its own file — so a sign-in runs against the real
    # home and is captured afterwards (as kilo). The CLI loads the file at
    # startup: restart, then ``opencode --session <id>``.
    live_file=OPENCODE_AUTH_FILE_REL,
    live_file_resolver=lambda home: _opencode_auth_file(home),
    live_file_from_context=lambda ctx: ctx.path(_opencode_auth_file(ctx.home, ctx.env)),
    credential_path_env_vars=("XDG_DATA_HOME",),
    slot_file="auth.json",
    identity_from_secret=provider_entry_identity,
    account_switch=AccountSwitchSpec(
        auth_scope="opencode",
        method="restart",
        store="compound-file",
        evidence="source",
        verified_version="1.15.12",
        scopes=OPENCODE_ACCOUNT_SCOPES,
        extract=provider_map_extract,
        merge=provider_map_merge,
        # Per-provider env keys from the 1.15.12 binary's provider table. The
        # loader consults env and auth.json both (source "env" / "api"); which
        # wins when both exist is not readable from the minified code, so a
        # pane carrying THIS provider's key is credential-source-unknown.
        uncertain_env_by_scope=(
            ("anthropic", ("ANTHROPIC_API_KEY",)),
            ("openai", ("OPENAI_API_KEY",)),
            ("github-copilot", ("GITHUB_TOKEN",)),
            ("google", ("GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY")),
            ("opencode", ("OPENCODE_API_KEY",)),
            ("openrouter", ("OPENROUTER_API_KEY",)),
            ("vercel", ("AI_GATEWAY_API_KEY",)),
            ("minimax-coding-plan", ("MINIMAX_API_KEY",)),
        ),
        resume="native",
        todo="layout from the 1.15.12 binary; no A -> B -> A round-trip on two real accounts recorded",
    ),
    # Late-bound (module global at call time) so tests can monkeypatch.
    fetch_usage=lambda home: fetch_opencode(home),
    fetch_usage_from_context=lambda ctx: fetch_opencode(ctx.home, dict(ctx.env)),
    resume_id_from_command=_resume_id_from_command,
    session_exists=_session_exists,
    home_env_vars=("OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG"),
    make_log_reader=OpencodeLogReader,
    # OpenCode ships `opencode upgrade` but no doctor subcommand.
    install_dep=Dep("opencode", "OpenCode (Anomaly)", "OpenCode terminal coding agent", "agent_cli",
        ["opencode", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="curl -fsSL https://opencode.ai/install | bash",
        needs_terminal=True, requires_binaries=("curl",), optional=True,
        docs_url="https://opencode.ai/docs",
        # Windows: no PowerShell installer exists (install.ps1 is a 404);
        # https://opencode.ai/docs lists Scoop, Chocolatey and npm. npm is the
        # one `opencode upgrade --method` knows, and Navide already has it.
        install_cmds={"win32": PlatformInstall(
            "npm install -g opencode-ai", ("npm",), needs_terminal=True)},
        update_cmd="opencode upgrade",
        npm_package="opencode-ai",
        config_home_env="OPENCODE_CONFIG_DIR",
        autoupdate_env="OPENCODE_DISABLE_AUTOUPDATE"),
)
