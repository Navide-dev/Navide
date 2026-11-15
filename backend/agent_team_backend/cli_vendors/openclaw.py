"""OpenClaw (``openclaw``) — a general personal AI assistant, offered in the
＋ menu's Agent list.

Measured on 2026-11-10 against OpenClaw 2026.11.2 (b556fdf) on Ubuntu 24.04
arm64, driven by a local OpenAI-compatible stub with a fake key (plan
openclaw-hermes-0-2-40_a50148):

* **Launch.** A pane runs ``openclaw tui --local``: the terminal UI on the
  local embedded agent runtime. A bare ``openclaw`` would attach to a running
  Gateway (the long-lived background process that owns schedules, memory and
  chat channels) when there is one; Navide never starts the Gateway —
  ``openclaw gateway install/start`` is the user's decision, and a pane must
  not leave a service running behind it. ``--local`` left no background
  process in the measurement.
* **Session.** Navide names the session: a pane runs ``--session
  agent:main:navide-<uuid>`` (``tui --session <key>``); the same key reattaches
  it later (measured: the second turn on one key carried the first turn's
  messages). OpenClaw also gives each session a UUID ``sessionId``.
* **Log.** Not JSONL: ``<state>/agents/<agentId>/agent/openclaw-agent.sqlite``
  (docs/concepts/session.md), table ``transcript_events``. The reader opens it
  read-only and depends on four columns — ``session_id``, ``seq``,
  ``event_json``, ``message_role`` — nothing else. Each event is the JSON of
  one transcript entry (``session``, ``model_change``, ``message`` …); a
  ``message`` carries ``role`` and, for the assistant, ``stopReason``. Some rows
  are zstd-compressed instead (``event_json`` empty); Python 3.12 cannot read
  them, so they are skipped.
* **Key ↔ sessionId.** ``transcript_events.session_id`` holds the UUID and
  the header event (seq 0) carries no key (VM run 2026-11-10: ``{type,
  version, id, timestamp, cwd}`` only). The link lives in the same store:
  ``session_windows`` (``session_id`` → ``session_key``, one row per
  transcript window, earlier windows included) and ``session_nodes``
  (``session_key``, ``current_session_id``). The reader asks those two, in
  that order, after the column itself and the header; a build without them
  reads as before. A session none of them names keeps the raw id (no pane can
  claim it), is logged once, and is asked again on the next pass — the
  mapping row may land after the first transcript rows.
* **Turn end.** An assistant ``message`` whose ``stopReason`` is set and is
  not ``toolUse``. Measured on the stub only (``stop``).
* **Tokens.** An assistant message's ``usage`` (input / output / cacheRead /
  cacheWrite), only when the row carries it.
* **Working directory.** The agent works in ``~/.openclaw/workspace``, not in
  the pane's cwd (systemPromptReport.workspaceDir in the measurement).
* **Kickoff.** ``tui --message <text>`` sends an initial message, but a
  pane's role text is typed into the composer like every other vendor's.
* **Keys.** Model providers and keys live in OpenClaw's own config and SQLite
  auth store. Navide reads none of it: no credential fields, no account
  switching, no usage fetcher.
* **Install.** The official installer is a ``curl | bash`` script (the npm
  package needs Node >=24.16 <25 or >=26.1), so the install entry carries no
  command — the guided install shows the docs link and the user runs it.
* **Not wired.** Model/effort flags (the TUI has none; ``agent --model`` is
  non-interactive and ``models set`` changes the global default), permission
  bypass, MCP (``openclaw mcp set`` configures the Gateway, not a pane),
  skills, extensions inventory, the ``agent_end`` plugin hook.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from ..log_readers.base import (
    ActivityEvent,
    IncrementalParseResult,
    LogReader,
    TokenUsage,
    join_text_blocks,
    user_prompt_text,
)
from ._declared import declared
from .base import Dep, ExtensionsSpec, VendorSpec
from .base import USER_SCOPE, MemorySource
from ..usage_common import _epoch_to_iso, _num

log = logging.getLogger("agent_team_backend.log_readers.openclaw")

_DB_NAME = "openclaw-agent.sqlite"
_BUSY_TIMEOUT_MS = 250
_MAX_ROWS_PER_PASS = 512
_MAX_TURN_TEXT = 8000
_MAX_MARKER_ROWS = 512
_REQUIRED = {"session_id", "seq", "event_json", "message_role"}
#: Prefix of every session key Navide hands OpenClaw.
KEY_PREFIX = "agent:"
_HEADER_KEYS = ("sessionKey", "key")

# Watermarks kept in the watcher-owned per-file seen_keys set: one entry per
# session (its last read seq) and one that says the store was anchored.
_SEQ_PREFIX = "openclaw_seq::"
_ANCHOR = "openclaw_anchor::"


def _state_dir() -> Path:
    override = os.environ.get("OPENCLAW_STATE_DIR")
    return Path(override) if override else Path.home() / ".openclaw"


def _cap_text(text: str) -> str:
    if len(text) <= _MAX_TURN_TEXT:
        return text
    half = _MAX_TURN_TEXT // 2
    return f"{text[:half]}\n…\n{text[-half:]}"


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return join_text_blocks(content, "text")
    return ""


def _timestamp(event: dict, message: dict) -> str:
    for value in (event.get("timestamp"), message.get("timestamp")):
        if isinstance(value, str) and value:
            return value
        number = _num(value)
        if number:
            return _epoch_to_iso(number / 1000 if number > 1e11 else number) or ""
    return ""


def _message(event_json: Any) -> tuple[dict, dict] | None:
    """(event, message) for a readable ``message`` entry, else None."""
    if not isinstance(event_json, str) or not event_json:
        return None
    try:
        event = json.loads(event_json)
    except ValueError:
        return None
    if not isinstance(event, dict) or event.get("type") != "message":
        return None
    message = event.get("message")
    return (event, message) if isinstance(message, dict) else None


def _resume_key(value: Any) -> str:
    return value if isinstance(value, str) and value.startswith(KEY_PREFIX) else ""


class OpenclawLogReader(LogReader):
    vendor: str = "openclaw"
    #: The generic cut re-reads activity with an empty watermark, which this
    #: reader anchors (no replay), so it would see no boundaries at all.
    turns_method: str = "unsupported"

    def __init__(self) -> None:
        self._schema_warned = False
        self._unkeyed_warned = False
        self._keys: dict[str, str] = {}

    def _agents_dir(self) -> Path:
        return _state_dir() / "agents"

    def project_dirs(self) -> list[Path]:
        root = self._agents_dir()
        return [root] if root.is_dir() else []

    def session_files(self) -> list[Path]:
        out: list[Path] = []
        for root in self.project_dirs():
            try:
                out.extend(p for p in root.glob(f"*/agent/{_DB_NAME}") if p.is_file())
            except OSError as err:
                log.debug("glob %s failed: %s", root, err)
        return out

    def accepts_watch_path(self, path_str: str) -> bool:
        # The generic filter knows .db/.json/.jsonl; this store is .sqlite.
        return path_str.endswith(_DB_NAME)

    def session_id_from_path(self, path: Path) -> str:
        return path.stem if path.name == _DB_NAME else ""

    # ── sqlite access ───────────────────────────────────────────────────────

    def _connect(self, path: Path) -> sqlite3.Connection | None:
        try:
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        except (sqlite3.Error, OSError) as err:
            log.debug("openclaw store open %s failed: %s", path, err)
            return None
        try:
            con.execute(f"PRAGMA busy_timeout = {_BUSY_TIMEOUT_MS}")
            have = {row[1] for row in con.execute("PRAGMA table_info(transcript_events)")}
            missing = _REQUIRED - have
            if missing:
                if not self._schema_warned:
                    self._schema_warned = True
                    log.warning(
                        "openclaw store %s: transcript_events lacks %s — no turn signal "
                        "or token counts from this store", path, sorted(missing),
                    )
                con.close()
                return None
            return con
        except (sqlite3.Error, OSError) as err:
            log.debug("openclaw store read %s failed: %s", path, err)
            con.close()
            return None

    def _key(self, con: sqlite3.Connection, path: Path, sid: str) -> str:
        """The session key a transcript_events session belongs to: the column
        itself when it is a key, else a key in the session's header event.
        Unresolvable → the raw id (logged once)."""
        cached = self._keys.get(sid)
        if cached is not None:
            return cached
        key = _resume_key(sid) or self._mapped_key(con, sid)
        if not key:
            row = con.execute(
                "SELECT event_json FROM transcript_events WHERE session_id = ? "
                "ORDER BY seq LIMIT 1", (sid,),
            ).fetchone()
            try:
                header = json.loads(row[0]) if row and isinstance(row[0], str) else None
            except ValueError:
                header = None
            if isinstance(header, dict) and header.get("type") == "session":
                key = next((k for k in (_resume_key(header.get(n)) for n in _HEADER_KEYS) if k), "")
        if not key:
            if not self._unkeyed_warned:
                self._unkeyed_warned = True
                log.warning(
                    "openclaw store %s: session %s names no session key in transcript_events, "
                    "session_windows or session_nodes — its turns reach no pane", path, sid,
                )
            return sid  # not cached: the mapping row may be written later
        self._keys[sid] = key
        return key

    def _mapped_key(self, con: sqlite3.Connection, sid: str) -> str:
        """The key OpenClaw's session tables give a transcript UUID; "" when
        neither table exists or names it."""
        for sql in (
            "SELECT session_key FROM session_windows WHERE session_id = ? LIMIT 1",
            "SELECT session_key FROM session_nodes WHERE current_session_id = ? LIMIT 1",
        ):
            try:
                row = con.execute(sql, (sid,)).fetchone()
            except sqlite3.Error:
                continue  # table or column absent in this build
            key = _resume_key(row[0]) if row else ""
            if key:
                return key
        return ""

    def _tops(self, con: sqlite3.Connection) -> dict[str, int]:
        return {str(sid): int(top) for sid, top in con.execute(
            "SELECT session_id, MAX(seq) FROM transcript_events GROUP BY session_id"
        ) if sid is not None and top is not None}

    def _rows(self, con: sqlite3.Connection, sid: str, after: int) -> list[tuple]:
        """Rows after ``after``; a trailing assistant message without its
        stopReason yet is held back so the next pass reads it again."""
        rows = con.execute(
            "SELECT seq, message_role, event_json FROM transcript_events "
            "WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?",
            (sid, after, _MAX_ROWS_PER_PASS),
        ).fetchall()
        if rows:
            parsed = _message(rows[-1][2])
            if parsed and parsed[1].get("role") == "assistant" and not parsed[1].get("stopReason"):
                rows = rows[:-1]
        return rows

    # ── tokens: assistant rows that carry usage ─────────────────────────────

    def _usage(self, path: Path, key: str, sid: str, seq: int, event_json: Any) -> TokenUsage | None:
        parsed = _message(event_json)
        if parsed is None:
            return None
        event, message = parsed
        usage = message.get("usage")
        if message.get("role") != "assistant" or not isinstance(usage, dict):
            return None
        inp, out = _num(usage.get("input")), _num(usage.get("output"))
        if inp is None or out is None:
            return None
        cread = int(_num(usage.get("cacheRead")) or 0)
        cwrite = int(_num(usage.get("cacheWrite")) or 0)
        return TokenUsage(
            vendor="openclaw", input_tokens=int(inp) + cread + cwrite, output_tokens=int(out),
            cwd="", session_id=key, file_path=str(path), dedup_key=f"openclaw:{sid}:{seq}",
            timestamp=_timestamp(event, message), model=str(message.get("model") or ""),
            cache_read_tokens=cread, cache_creation_tokens=cwrite,
        )

    def parse_session_file(self, path: Path, seen_keys: set[str]) -> list[TokenUsage]:
        result = self.parse_incremental(path, {})
        out = [u for u in result.events if u.dedup_key not in seen_keys]
        seen_keys.update(u.dedup_key for u in out)
        return out

    def parse_incremental(self, path: Path, checkpoint: dict[str, Any]) -> IncrementalParseResult:
        if path.name != _DB_NAME:
            return IncrementalParseResult([], dict(checkpoint))
        last = checkpoint.get("sessions") if checkpoint.get("kind") == "openclaw_seq" else None
        state = {str(k): int(v) for k, v in (last or {}).items() if isinstance(v, int)}
        con = self._connect(path)
        if con is None:
            return IncrementalParseResult([], dict(checkpoint))
        events: list[TokenUsage] = []
        try:
            for sid, top in self._tops(con).items():
                after = state.get(sid, -1)
                if top <= after:
                    continue
                key = self._key(con, path, sid)
                for seq, _role, event_json in self._rows(con, sid, after):
                    usage = self._usage(path, key, sid, int(seq), event_json)
                    if usage is not None:
                        events.append(usage)
                    state[sid] = int(seq)
        except sqlite3.Error as err:
            log.debug("openclaw tokens %s failed: %s", path, err)
            return IncrementalParseResult([], dict(checkpoint))
        finally:
            con.close()
        return IncrementalParseResult(events, {"kind": "openclaw_seq", "sessions": state})

    # ── activity ────────────────────────────────────────────────────────────

    def parse_activity(self, path: Path, seen_keys: set[str]) -> list[ActivityEvent]:
        """user message → agent_active "user"; tool results and tool-using
        assistant messages → agent_active; an assistant message with a final
        stopReason → turn_complete. Per-session seq watermarks; first sight
        anchors every existing session at its newest row."""
        if path.name != _DB_NAME:
            return []
        marks = {}
        for entry in seen_keys:
            if entry.startswith(_SEQ_PREFIX):
                sid, _, seq = entry[len(_SEQ_PREFIX):].rpartition("::")
                if seq.lstrip("-").isdigit():
                    marks[sid] = int(seq)

        def remember(sid: str, seq: int) -> None:
            prefix = f"{_SEQ_PREFIX}{sid}::"
            seen_keys.difference_update({k for k in seen_keys if k.startswith(prefix)})
            seen_keys.add(f"{prefix}{seq}")

        con = self._connect(path)
        if con is None:
            return []
        out: list[ActivityEvent] = []
        try:
            tops = self._tops(con)
            if _ANCHOR not in seen_keys:
                for sid, top in tops.items():
                    remember(sid, top)
                seen_keys.add(_ANCHOR)
                return []
            for sid, top in tops.items():
                after = marks.get(sid, -1)
                if top < after:
                    remember(sid, top)  # session rewritten: re-anchor, no replay
                    continue
                if top == after:
                    continue
                key = self._key(con, path, sid)
                for seq, role, event_json in self._rows(con, sid, after):
                    remember(sid, int(seq))
                    event = self._activity(path, key, sid, int(seq), role, event_json)
                    if event is not None:
                        out.append(event)
        except sqlite3.Error as err:
            log.debug("openclaw activity %s failed: %s", path, err)
        finally:
            con.close()
        return out

    def _activity(self, path: Path, key: str, sid: str, seq: int, role: Any,
                  event_json: Any) -> ActivityEvent | None:
        parsed = _message(event_json)
        if parsed is None:
            return None  # not a message, or a compressed row Python cannot read
        event, message = parsed
        role = str(message.get("role") or role or "")
        common = dict(vendor="openclaw", cwd="", session_id=key, file_path=str(path),
                      dedup_key=f"seq:{sid}:{seq}", timestamp=_timestamp(event, message))
        if role == "user":
            text = user_prompt_text(_text(message.get("content")))
            return ActivityEvent(event_type="agent_active", detail="user", text=text, **common) if text else None
        if role == "assistant":
            stop = message.get("stopReason")
            if stop and stop != "toolUse":
                return ActivityEvent(event_type="turn_complete", detail=str(stop),
                                     text=_cap_text(_text(message.get("content"))), **common)
            return ActivityEvent(event_type="agent_active", detail="assistant", **common)
        if role in ("toolResult", "tool"):
            return ActivityEvent(event_type="agent_active", detail="tool", **common)
        return None

    # ── marker binding / resume ─────────────────────────────────────────────

    def find_sessions_by_marker(self, markers: Iterable[str]) -> dict[str, tuple[str, str]]:
        wanted = [m for m in markers if m]
        if not wanted:
            return {}
        found: dict[str, tuple[str, str]] = {}
        for db in self.session_files():
            con = self._connect(db)
            if con is None:
                continue
            try:
                rows = con.execute(
                    "SELECT session_id, event_json FROM transcript_events WHERE message_role = 'user' "
                    "ORDER BY seq DESC LIMIT ?", (_MAX_MARKER_ROWS,),
                ).fetchall()
                for sid, event_json in reversed(rows):
                    parsed = _message(event_json)
                    text = _text(parsed[1].get("content")) if parsed else ""
                    for marker in wanted:
                        if marker not in found and marker in text:
                            found[marker] = (self._key(con, db, str(sid)), "")
            except sqlite3.Error:
                continue
            finally:
                con.close()
        return found

    def has_session(self, key: str) -> bool | None:
        """Does a session with this key exist? None = unknown (no store could
        be read, or none of its sessions names a key at all)."""
        files = self.session_files()
        if not files:
            return False
        keyed = False
        for db in files:
            con = self._connect(db)
            if con is None:
                return None
            try:
                for sid in self._tops(con):
                    resolved = self._key(con, db, sid)
                    keyed = keyed or resolved.startswith(KEY_PREFIX)
                    if resolved == key:
                        return True
            except sqlite3.Error:
                return None
            finally:
                con.close()
        return False if keyed else None


def _workspace_match(self, usage, ws_path, owner_workspace=None):
    # The store records no cwd (the agent works in ~/.openclaw/workspace); a
    # session attributes only through the pane that owns it.
    return owner_workspace is not None and owner_workspace == ws_path


def _pane_cwd_match(self, usage, pane_cwd, pane_id):
    return False


OpenclawLogReader.binds_shared_db_by_marker = True
OpenclawLogReader.emits_session_sink = True
OpenclawLogReader.workspace_match = _workspace_match
OpenclawLogReader.pane_cwd_match = _pane_cwd_match


# The session key an `openclaw tui … --session <key>` launch targets is read
# by the launch declaration (native/navide-cli-runtime/src/vendors/
# openclaw.rs; see _declared).


def _session_exists(workspace_path: str, session_id: str) -> bool:
    # Unknown (unreadable store, or keys not recorded) assumes resumable; a
    # fresh launch and a resume run the same `--session <key>` anyway.
    found = OpenclawLogReader().has_session(session_id)
    return True if found is None else found


# Instruction files: bootstrap files come from the agent workspace
# (~/.openclaw/workspace; OPENCLAW_WORKSPACE_DIR / profile relocate it), not
# from the TUI's cwd (docs/concepts/agent-workspace, read 2026-11-07).
_MEMORY_SOURCES = (
    MemorySource("openclaw", USER_SCOPE, (".openclaw", "workspace", "AGENTS.md"), canonical=True),
    MemorySource("openclaw", USER_SCOPE, (".openclaw", "workspace", "SOUL.md")),
)

SPEC = VendorSpec(
    memory_sources=_MEMORY_SOURCES,
    cli_unverified_reason="wired from the docs (read 2026-11-07); no install to run, so no version was checked",
    key="openclaw",
    extensions=ExtensionsSpec(
        supported=False,
        note="OpenClaw plugins and skills (~/.openclaw) are not inventoried yet",
    ),
    # Any provider the user configures; no fixed host to declare.
    expected_hosts=(),
    # OPENCLAW_STATE_DIR moves the state dir (config, credentials, sessions;
    # docs.openclaw.ai/concepts/agent-workspace), else ~/.openclaw.
    data_dirs=lambda ctx: (ctx.path(ctx.env.get("OPENCLAW_STATE_DIR") or ctx.home / ".openclaw"),),
    data_dir_env_vars=("OPENCLAW_STATE_DIR",),
    # Resume by session key: the launch declaration.
    **declared("openclaw"),
    session_exists=_session_exists,
    make_log_reader=OpenclawLogReader,
    install_dep=Dep("openclaw", "OpenClaw", "OpenClaw personal AI assistant", "agent_cli",
        ["openclaw", "--version"], r"(\d+\.\d+\.\d+)",
        # The official installer is `curl | bash`; Navide does not run it.
        optional=True, docs_url="https://docs.openclaw.ai/install"),
)
