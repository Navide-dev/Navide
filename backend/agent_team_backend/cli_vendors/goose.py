"""Goose CLI (AAIF, formerly Block) conversation reader.

Storage: ONE shared SQLite database (WAL journal, schema version 17 on
1.55.0) holding every session — ``<data dir>/sessions/sessions.db`` where the
data dir is, in the CLI's own order (crates/goose/src/config/paths.rs):

  * ``$GOOSE_PATH_ROOT/data`` when the variable holds an absolute path;
  * otherwise etcetera's ``choose_app_strategy``: the XDG layout on macOS and
    Linux (``$XDG_DATA_HOME/goose``, default ``~/.local/share/goose`` —
    verified live on macOS with 1.55.0, NOT ``~/Library/Application
    Support``), and ``%APPDATA%\\Block\\goose\\data`` on Windows (source only).

Tables read here (recorded from a live 1.55.0 session in a scratch home):

  sessions      id (``YYYYMMDD_N``, the UTC date), name, session_type
                ("user" for an interactive session), working_dir (the cwd),
                parent_session_id (non-NULL = a sub-agent's session)
  messages      AUTOINCREMENT id, session_id, role, content_json (a list of
                blocks: text, toolRequest, toolResponse, actionRequired, …),
                metadata_json ({userVisible, agentVisible, turnContext, usage})
  usage_ledger  AUTOINCREMENT id, one row per model call: model and
                input/output/cache tokens. ``input_tokens`` already includes
                the cache reads and writes, which are subsets of it
                (goose-provider-types conversation/token_usage.rs).

Turn end: there is no turn-end record. Goose's agent loop stops when a model
response carries no tool request, and a response is stored as ONE message row
(text and toolRequest blocks together — verified live by streaming the text
and the tool call as separate chunks), so an agent-visible assistant row with
text and no toolRequest is the turn's final reply. A turn interrupted with
Ctrl+C writes no row at all (verified live): it is seen to end only when the
next prompt starts a new turn.

Every connection here is read-only (``file:…?mode=ro``) and short-lived; the
goose process owns the WAL writer. A busy, locked or missing db is "no new
data this cycle".
"""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
from collections.abc import Iterable
from pathlib import Path

from .base import Dep, ExtensionsSpec, PlatformInstall, VendorSpec, command_text
from ..osplat import platform_id as _platform_id
from ..usage_common import _epoch_to_iso
from ..log_readers.base import (
    ActivityEvent,
    IncrementalParseResult,
    LogReader,
    TokenUsage,
    user_prompt_text,
)

log = logging.getLogger("agent_team_backend.log_readers.goose")

_DB_NAME = "sessions.db"

# Row-fetch busy wait: long enough to ride out a goose write transaction,
# short enough not to stall the watcher's drain thread.
_BUSY_TIMEOUT_MS = 250

# One row per model call; AUTOINCREMENT ids are never handed out again, so
# the id is a watermark that cannot skip or repeat a row.
_USAGE_SQL = """
SELECT u.id, u.session_id, u.created_timestamp, COALESCE(u.model, ''),
       u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens,
       COALESCE(s.working_dir, '')
FROM usage_ledger u
JOIN sessions s ON s.id = u.session_id
WHERE u.id > ?
ORDER BY u.id
"""

# Markers are typed by the user, so they live in the text of user rows of
# interactive top-level sessions — a marker forwarded into a sub-agent's
# prompt must not bind the child id (it is not the pane's session).
_MARKER_SQL = """
SELECT m.session_id, m.content_json, m.metadata_json, COALESCE(s.working_dir, '')
FROM messages m
JOIN sessions s ON s.id = m.session_id
WHERE m.role = 'user' AND m.content_json LIKE '%at-pane:%'
  AND s.parent_session_id IS NULL AND s.session_type = 'user'
ORDER BY m.id
"""

_ACTIVITY_PREFIX = "goose_message::"
_MAX_MESSAGES_PER_PASS = 256

_ACTIVITY_SQL = """
SELECT m.id, m.session_id, m.role, m.content_json, m.metadata_json,
       m.created_timestamp, COALESCE(s.working_dir, ''),
       s.parent_session_id, s.session_type
FROM messages m
JOIN sessions s ON s.id = m.session_id
WHERE m.id > ?
ORDER BY m.id
LIMIT ?
"""


def _int(v) -> int:  # noqa: ANN001
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return 0


def _json(raw):  # noqa: ANN001, ANN202
    try:
        return json.loads(str(raw or ""))
    except json.JSONDecodeError:
        return None


def _blocks(raw) -> list[dict]:  # noqa: ANN001
    parsed = _json(raw)
    return [b for b in parsed if isinstance(b, dict)] if isinstance(parsed, list) else []


def _text_of(blocks: list[dict]) -> str:
    return "\n".join(
        str(b.get("text") or "").strip()
        for b in blocks
        if b.get("type") == "text" and str(b.get("text") or "").strip()
    )


def _absolute(value: str | None) -> Path | None:
    return Path(value) if value and os.path.isabs(value) else None


def _data_dir(env: dict | None = None, home: Path | None = None, platform: str | None = None) -> Path:
    """The CLI's data dir, by its own rule (see the module docstring).
    ``platform`` defaults to this process's (``osplat.platform_id``)."""
    env = os.environ if env is None else env
    home = Path.home() if home is None else home
    root = _absolute(env.get("GOOSE_PATH_ROOT"))
    if root is not None:
        return root / "data"
    if (platform or _platform_id) == "win32":
        appdata = env.get("APPDATA")
        base = Path(appdata) if appdata else home / "AppData" / "Roaming"
        return base / "Block" / "goose" / "data"
    xdg = _absolute(env.get("XDG_DATA_HOME"))
    return (xdg if xdg is not None else home / ".local" / "share") / "goose"


class GooseLogReader(LogReader):
    vendor: str = "goose"

    def _sessions_dir(self) -> Path:
        return _data_dir() / "sessions"

    def _db_path(self) -> Path:
        return self._sessions_dir() / _DB_NAME

    def project_dirs(self) -> list[Path]:
        d = self._sessions_dir()
        return [d] if d.is_dir() else []

    def session_files(self) -> list[Path]:
        db = self._db_path()
        return [db] if db.is_file() else []

    def session_id_from_path(self, path: Path) -> str:
        """Only the shared db is a session source; its -wal/-shm siblings and
        anything else under the dir must not coin ids or trigger scans."""
        return path.stem if path.name == _DB_NAME else ""

    def _query(self, path: Path, sql: str, params: tuple = ()) -> list[tuple] | None:
        """Short-lived read-only query; None when the db cannot be read this
        cycle (busy, locked, gone, or a schema this reader does not know)."""
        try:
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            try:
                con.execute(f"PRAGMA busy_timeout = {_BUSY_TIMEOUT_MS}")
                return con.execute(sql, params).fetchall()
            finally:
                con.close()
        except (sqlite3.Error, OSError) as err:
            log.debug("goose sqlite read %s failed: %s", path, err)
            return None

    def has_session(self, session_id: str) -> bool:
        """True if the shared db knows this session id. The resume preflight
        uses it: ``goose session -r --session-id <unknown>`` exits with
        "no such session exists" (verified live)."""
        session_id = session_id.strip()
        db = self._db_path()
        if not session_id or not db.is_file():
            return False
        return bool(self._query(db, "SELECT 1 FROM sessions WHERE id = ?", (session_id,)))

    # ── tokens ──────────────────────────────────────────────────────────────

    def _usage_events(self, path: Path, after: int) -> list[TokenUsage]:
        rows = self._query(path, _USAGE_SQL, (after,))
        out: list[TokenUsage] = []
        for (row_id, session_id, created, model, input_t, output_t,
             cache_read, cache_write, working_dir) in rows or []:
            input_tokens, output_tokens = _int(input_t), _int(output_t)
            if input_tokens == 0 and output_tokens == 0:
                continue
            out.append(TokenUsage(
                vendor=self.vendor,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cwd=str(working_dir or ""),
                session_id=str(session_id or ""),
                file_path=str(path),
                dedup_key=f"usage:{int(row_id)}",
                timestamp=_epoch_to_iso(_int(created)) or "",
                model=str(model or ""),
                cache_read_tokens=_int(cache_read),
                cache_creation_tokens=_int(cache_write),
                raw={"row_id": int(row_id)},
            ))
        return out

    def parse_session_file(self, path: Path, seen_keys: set[str]) -> list[TokenUsage]:
        if path.name != _DB_NAME:
            return []
        out: list[TokenUsage] = []
        for event in self._usage_events(path, 0):
            if event.dedup_key in seen_keys:
                continue
            seen_keys.add(event.dedup_key)
            out.append(event)
        return out

    def parse_incremental(self, path: Path, checkpoint: dict) -> IncrementalParseResult:
        if path.name != _DB_NAME:
            return IncrementalParseResult([], dict(checkpoint))
        try:
            stat = path.stat()
        except OSError:
            return IncrementalParseResult([], dict(checkpoint))
        identity = f"{stat.st_dev}:{stat.st_ino}"
        replaced = bool(checkpoint.get("identity") and checkpoint.get("identity") != identity)
        last = 0 if replaced else _int(checkpoint.get("row_id"))
        events = self._usage_events(path, last)
        out: list[TokenUsage] = []
        for event in events:
            last = max(last, int(event.raw["row_id"]))
            out.append(TokenUsage(**{
                **event.__dict__,
                "checkpoint": {"kind": "sqlite", "row_id": last, "identity": identity},
            }))
        return IncrementalParseResult(out, {"kind": "sqlite", "row_id": last, "identity": identity})

    # ── activity ────────────────────────────────────────────────────────────

    def parse_activity(self, path: Path, seen_keys: set[str]) -> list[ActivityEvent]:
        """One event per new `messages` row; see the module docstring for
        why a text-only assistant row is the turn end."""
        if path.name != _DB_NAME:
            return []
        prev = next(
            (k[len(_ACTIVITY_PREFIX):] for k in seen_keys if k.startswith(_ACTIVITY_PREFIX)),
            None,
        )

        def remember(row_id: int) -> None:
            seen_keys.difference_update({k for k in seen_keys if k.startswith(_ACTIVITY_PREFIX)})
            seen_keys.add(_ACTIVITY_PREFIX + str(row_id))

        # First sight of the db: everything in it is history. The db holds
        # every session goose ever ran, so reporting it would light up panes
        # that are doing nothing; skip to the newest row (an empty table is a
        # watermark of 0).
        if prev is None:
            newest = self._query(path, "SELECT COALESCE(MAX(id), 0) FROM messages")
            if newest is not None:
                remember(_int(newest[0][0]))
            return []
        rows = self._query(path, _ACTIVITY_SQL, (_int(prev), _MAX_MESSAGES_PER_PASS))
        if not rows:
            return []
        remember(int(rows[-1][0]))
        return [self._activity_from_row(path, row) for row in rows]

    def _activity_from_row(self, path: Path, row: tuple) -> ActivityEvent:
        (row_id, session_id, role, content_json, metadata_json, created,
         working_dir, parent_id, session_type) = row
        blocks = _blocks(content_json)
        meta = _json(metadata_json)
        meta = meta if isinstance(meta, dict) else {}
        kinds = {str(b.get("type") or "") for b in blocks}

        def make(event_type: str, detail: str, text: str = "") -> ActivityEvent:
            return ActivityEvent(
                vendor=self.vendor,
                event_type=event_type,
                cwd=str(working_dir or ""),
                session_id=str(session_id or ""),
                file_path=str(path),
                dedup_key=f"message:{int(row_id)}",
                timestamp=_epoch_to_iso(_int(created)) or "",
                detail=detail,
                text=text,
            )

        if role == "assistant":
            tool = next((b for b in blocks if b.get("type") == "toolRequest"), None)
            if tool is not None:
                call = ((tool.get("toolCall") or {}).get("value") or {})
                return make("agent_active", f"tool:{call.get('name') or 'unknown'}")
            if "actionRequired" in kinds:
                return make("agent_active", "assistant:action-required")
            text = _text_of(blocks)
            if text and meta.get("agentVisible") is not False:
                if parent_id or session_type != "user":
                    # A sub-agent finished; its parent is still working.
                    return make("agent_active", "subagent:done")
                return make("turn_complete", "assistant", text)
            return make("agent_active", "assistant")
        if role == "user":
            if "toolResponse" in kinds:
                return make("agent_active", "tool:result")
            if "actionRequired" in kinds:
                return make("agent_active", "user:action-response")
            # turnContext rows are the CLI's own injected context, not typed.
            if meta.get("turnContext") or meta.get("userVisible") is False:
                return make("agent_active", "user:context")
            # "user" is the cross-end contract detail panes are named from.
            return make("agent_active", "user", user_prompt_text(_text_of(blocks)))
        return make("agent_active", str(role or "message"))

    def find_sessions_by_marker(self, markers: Iterable[str]) -> dict[str, tuple[str, str]]:
        """marker → (session_id, working_dir) for kickoff markers typed into
        an interactive top-level session. Earliest match wins per marker."""
        wanted = [m for m in markers if m]
        db = self._db_path()
        if not wanted or not db.is_file():
            return {}
        found: dict[str, tuple[str, str]] = {}
        for session_id, content_json, metadata_json, working_dir in self._query(db, _MARKER_SQL) or []:
            meta = _json(metadata_json)
            if isinstance(meta, dict) and meta.get("turnContext"):
                continue
            text = _text_of(_blocks(content_json))
            for marker in wanted:
                if marker not in found and marker in text:
                    found[marker] = (str(session_id or ""), str(working_dir or ""))
        return found


# ---- attribution/watch hooks ----------------------------------------------

def _workspace_match(self, usage, ws_path, owner_workspace=None):
    # Reader emits cwd = sessions.working_dir (the cwd the session started in).
    return bool(usage.cwd and usage.cwd == ws_path)


def _pane_cwd_match(self, usage, pane_cwd, pane_id):
    return usage.cwd == pane_cwd


GooseLogReader.binds_shared_db_by_marker = True
GooseLogReader.emits_session_sink = True
GooseLogReader.workspace_match = _workspace_match
GooseLogReader.pane_cwd_match = _pane_cwd_match


# ---- resume / session ------------------------------------------------------

# `goose session -r --session-id <id>` (also `s` for session, `--resume`).
_RESUME_RE = re.compile(
    r"^goose\s+(?:session|s)\s+(?:\S+\s+)*?--session-id[\s=]+([^-\s]\S*)"
)


def _resume_id_from_command(command) -> str:
    m = _RESUME_RE.match(command_text(command).strip())
    return m.group(1) if m else ""


def _session_exists(workspace_path: str, session_id: str) -> bool:
    return GooseLogReader().has_session(session_id)


# ---- vendor spec -----------------------------------------------------------

SPEC = VendorSpec(
    key="goose",
    label="Goose (AAIF)",
    # Plugins live in ~/.agents/plugins and extensions in config.yaml's
    # `extensions:` map (source, 1.55.0); neither layout has been checked
    # against a populated install, so nothing is listed yet.
    extensions=ExtensionsSpec(
        supported=False,
        note="Goose plugins (~/.agents/plugins) and config.yaml extensions are not inventoried yet",
    ),
    # Arbitrary provider config; no CLI host set to declare.
    expected_hosts=(),
    # The same data dir the reader opens, resolved against the pane's runtime.
    data_dirs=lambda ctx: (ctx.path(_data_dir(dict(ctx.env), ctx.home)),),
    data_dir_env_vars=("GOOSE_PATH_ROOT", "XDG_DATA_HOME", "APPDATA"),
    resume_id_from_command=_resume_id_from_command,
    session_exists=_session_exists,
    make_log_reader=GooseLogReader,
    # No usage/quota surface and no account switching: goose talks to the
    # provider the user configured, and Navide reads no credential of it.
    install_dep=Dep("goose", "Goose (AAIF)", "Goose open-source AI agent", "agent_cli",
        ["goose", "--version"], r"(\d+\.\d+\.\d+)",
        # 1.55.0 prints a bare ` 1.55.0` (verified live). `goose` is also the
        # name of pressly's database-migration tool, which prints
        # `goose version: v3.x` — the bare shape is what tells them apart.
        identity_regex=r"^\s*\d+\.\d+\.\d+\s*$",
        install_cmd="curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash",
        needs_terminal=True, requires_binaries=("curl",), optional=True,
        docs_url="https://goose-docs.ai/docs/getting-started/installation",
        # Windows: no installer command has been verified, so the wizard
        # offers the docs link instead of a guess.
        install_cmds={"win32": PlatformInstall("")},
        update_cmd="goose update",
        doctor_cmd="goose doctor"),
)
