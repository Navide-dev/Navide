"""Hermes Agent (``hermes``, Nous Research) — a general AI agent, offered in
the ＋ menu's Agent list.

Measured on 2026-11-10 against Hermes Agent v0.23.0 (2bd378ed1b) on Ubuntu
24.04 arm64, driven by a local OpenAI-compatible stub with a fake key (plan
openclaw-hermes-0-2-40_a50148):

* **Launch.** A pane runs ``hermes chat``: the interactive chat, which honours
  ``display.interface`` exactly as a bare ``hermes`` does. It is the
  subcommand rather than the bare command because ``--create-if-missing`` —
  what lets Navide name the session — exists only there (``hermes chat
  --help``). ``--yolo`` (skip the dangerous-command approval prompt) is
  accepted by ``chat`` too.
* **Model / effort.** Not wired. ``chat`` lists ``-m`` / ``--reasoning``, but
  v0.23.1 refuses both on every ``--continue`` launch — creation through
  ``--create-if-missing`` included — with exit 2 ("creation overrides are
  unsupported on resume"; VM run 2026-11-10, b9-hermes-repro.txt). The
  ``/model`` and ``/reasoning`` slash commands switch the session only when
  typed raw into the PTY; a cli_send or kickoff arrives wrapped and is sent to
  the model as text.
* **Session.** Navide names the session: a fresh pane is launched with
  ``--create-if-missing --continue navide-<uuid>``, which creates a session
  titled with that name; a resume is ``--continue navide-<uuid>``, which
  picks the latest session in that title's lineage (Hermes titles a
  continuation ``<name> #2``). The name is therefore the session id Navide
  stores; the CLI's own ``local-<64hex>`` id is never needed.
* **Log.** Not JSONL: one SQLite store, ``<home>/state.db``. ``sessions``
  (id, title, parent_session_id, cwd, cumulative token counters) and
  ``messages`` (id AUTOINCREMENT, session_id, role, content, tool_calls,
  timestamp epoch seconds, finish_reason). The reader opens it read-only and
  depends on those columns alone; a store lacking any of them is reported
  once in the log and read as "no signal".
* **Turn end.** An assistant row with a ``finish_reason`` other than
  ``tool_calls`` closes the turn. Measured on the stub only (``stop``); the
  event order of a real provider with tools or an interrupt is unverified.
* **Tokens.** Only the ``sessions`` counters carry numbers (input / output /
  cache read / cache write, cumulative per session); a token event is the
  growth of those counters since the last read. Cache is folded into input
  per the TokenUsage contract — whether Hermes's own ``input_tokens``
  already includes the cache portion is unverified (the stub reported none).
* **Kickoff.** ``hermes chat -q <text>`` seeds the first turn on a TTY, but a
  pane's role text is typed into the composer like every other vendor's.
* **Windows.** Native PowerShell is an official install path
  (``iex (irm https://hermes-agent.nousresearch.com/install.ps1)``, data under
  ``%LOCALAPPDATA%\\hermes``), so the vendor is offered on every platform.
* **Keys.** Providers and keys live in Hermes's own home (``~/.hermes/.env``,
  ``config.yaml``; ``$HERMES_HOME`` relocates it). Navide reads none of it: no
  credential fields, no account switching, no usage fetcher.
* **Install.** Both official installers pipe a downloaded script into a shell,
  so the install entry carries no command — the guided install shows the docs
  link and the user runs it themselves.
* **Background gateway.** The first chat starts ``hermes gateway run
  --idle-exit`` in the background (ppid 1), which outlived 12.5 idle minutes
  in the measurement. It is Hermes's own process; Navide neither starts nor
  stops it.
* **Not wired.** MCP, skills, extensions inventory, the ``on_session_end``
  shell hook (it would mean editing the user's config.yaml).
"""

from __future__ import annotations

import json
import logging
import os
import re
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
from .base import Dep, ExtensionsSpec, VendorRuntimeContext, VendorSpec
from .base import PROJECT_SCOPE, USER_SCOPE, MemorySource
from ..osplat import platform_id as _platform_id
from ..usage_common import _epoch_to_iso

log = logging.getLogger("agent_team_backend.log_readers.hermes")


def _home(ctx: VendorRuntimeContext, platform: str | None = None) -> Path:
    """$HERMES_HOME, else %LOCALAPPDATA%\\hermes on Windows, else ~/.hermes."""
    override = ctx.env.get("HERMES_HOME")
    if override:
        return ctx.path(override)
    if (platform or _platform_id) == "win32":
        local = ctx.env.get("LOCALAPPDATA")
        return ctx.path(local) / "hermes" if local else ctx.home / "AppData" / "Local" / "hermes"
    return ctx.home / ".hermes"


_DB_NAME = "state.db"
_BUSY_TIMEOUT_MS = 250
_MAX_ROWS_PER_PASS = 512
_MAX_TURN_TEXT = 8000
_MAX_MARKER_ROWS = 512

#: Prefix of every session name Navide hands Hermes.
SESSION_PREFIX = "navide-"
# "<name> #3" is the third session in <name>'s lineage.
_LINEAGE_SUFFIX = re.compile(r" #\d+$")
# Lineage walk bound (a session continued from a session continued from …).
_MAX_PARENT_HOPS = 8

# The columns the reader depends on; anything else in the store is ignored.
_REQUIRED = {
    "sessions": {"id", "title", "parent_session_id", "cwd", "input_tokens", "output_tokens",
                 "cache_read_tokens", "cache_write_tokens", "last_activity_at"},
    "messages": {"id", "session_id", "role", "content", "tool_calls", "timestamp",
                 "finish_reason"},
}

# Watermark entry kept in the watcher-owned per-file seen_keys set.
_ACTIVITY_PREFIX = "hermes_msg::"


def _cap_text(text: str) -> str:
    """Head-and-tail cap: the messaging ---MSG-END--- and loop sentinels sit on
    a reply's LAST line, so a head-only slice would drop them."""
    if len(text) <= _MAX_TURN_TEXT:
        return text
    half = _MAX_TURN_TEXT // 2
    return f"{text[:half]}\n…\n{text[-half:]}"


def _message_text(content: Any) -> str:
    """messages.content is plain text; a JSON list of content blocks is
    joined like the other readers join theirs."""
    if not isinstance(content, str):
        return ""
    stripped = content.lstrip()
    if stripped.startswith("["):
        try:
            blocks = json.loads(stripped)
        except ValueError:
            return content
        if isinstance(blocks, list):
            return join_text_blocks(blocks, "text")
    return content


def session_name(title: Any) -> str:
    """The Navide session name a Hermes session title belongs to ('' when the
    session was not started by Navide)."""
    if not isinstance(title, str):
        return ""
    name = _LINEAGE_SUFFIX.sub("", title.strip())
    return name if name.startswith(SESSION_PREFIX) else ""


def hermes_home() -> Path:
    """The backend's own view of Hermes's home (same rules as the spec)."""
    home = Path.home()
    return _home(VendorRuntimeContext(home=home, env=os.environ, cwd=home))


class HermesLogReader(LogReader):
    vendor: str = "hermes"
    #: Token events are counter growth, not per-call usage: no turns to cut.
    turns_method: str = "unsupported"

    def __init__(self) -> None:
        self._schema_warned = False

    def _db_path(self) -> Path:
        return hermes_home() / _DB_NAME

    def project_dirs(self) -> list[Path]:
        root = hermes_home()
        return [root] if root.is_dir() else []

    def session_files(self) -> list[Path]:
        db = self._db_path()
        return [db] if db.is_file() else []

    def session_id_from_path(self, path: Path) -> str:
        """Only state.db is a session source; sibling files (config, logs,
        the install checkout) must not coin ids or trigger marker scans."""
        return path.stem if path.name == _DB_NAME else ""

    # ── sqlite access ───────────────────────────────────────────────────────

    def _connect(self, path: Path) -> sqlite3.Connection | None:
        """Read-only connection with the schema checked, or None (unreadable
        this cycle, or a store this reader does not understand)."""
        try:
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        except (sqlite3.Error, OSError) as err:
            log.debug("hermes state.db open %s failed: %s", path, err)
            return None
        try:
            con.execute(f"PRAGMA busy_timeout = {_BUSY_TIMEOUT_MS}")
            for table, needed in _REQUIRED.items():
                have = {row[1] for row in con.execute(f"PRAGMA table_info({table})")}
                missing = needed - have
                if missing:
                    if not self._schema_warned:
                        self._schema_warned = True
                        log.warning(
                            "hermes state.db %s: table %s lacks %s — no turn signal "
                            "or token counts from this store", path, table, sorted(missing),
                        )
                    con.close()
                    return None
            return con
        except (sqlite3.Error, OSError) as err:
            log.debug("hermes state.db read %s failed: %s", path, err)
            con.close()
            return None

    def _sessions(self, con: sqlite3.Connection, ids: Iterable[str]) -> dict[str, tuple[str, str]]:
        """session row id → (Navide session id, cwd). The Navide id is the
        lineage's name when one is found up the parent chain, else the row id
        itself (a session Navide did not start)."""
        out: dict[str, tuple[str, str]] = {}
        for sid in set(ids):
            current, cwd, name = sid, None, ""
            for _ in range(_MAX_PARENT_HOPS):
                row = con.execute(
                    "SELECT title, parent_session_id, cwd FROM sessions WHERE id = ?", (current,),
                ).fetchone()
                if row is None:
                    break
                if cwd is None:
                    cwd = str(row[2] or "")
                name = session_name(row[0])
                if name or not row[1]:
                    break
                current = str(row[1])
            out[sid] = (name or sid, cwd or "")
        return out

    def has_session(self, session_id: str) -> bool | None:
        """Does a session of this name exist? None = the store could not be
        read (unknown, never "absent")."""
        db = self._db_path()
        if not db.is_file():
            return False
        con = self._connect(db)
        if con is None:
            return None
        try:
            rows = con.execute(
                "SELECT title FROM sessions WHERE title = ? OR title LIKE ?",
                (session_id, session_id + " #%"),
            ).fetchall()
        except sqlite3.Error:
            return None
        finally:
            con.close()
        return any(session_name(title) == session_id for (title,) in rows)

    # ── tokens: growth of the per-session counters ──────────────────────────

    def _counter_rows(self, path: Path) -> list[tuple] | None:
        con = self._connect(path)
        if con is None:
            return None
        try:
            rows = con.execute(
                "SELECT id, cwd, input_tokens, output_tokens, cache_read_tokens, "
                "cache_write_tokens, last_activity_at FROM sessions"
            ).fetchall()
            names = self._sessions(con, (str(r[0]) for r in rows))
        except sqlite3.Error as err:
            log.debug("hermes counters %s failed: %s", path, err)
            return None
        finally:
            con.close()
        return [(names[str(r[0])], *r) for r in rows]

    def _usage(self, path: Path, named: tuple[str, str], row: tuple,
               base: tuple[int, int, int, int]) -> TokenUsage | None:
        _sid, _cwd, inp, out, cread, cwrite, last = row
        now = tuple(int(v or 0) for v in (inp, out, cread, cwrite))
        delta = [max(a - b, 0) for a, b in zip(now, base)]
        if not any(delta):
            return None
        session_id, cwd = named
        return TokenUsage(
            vendor="hermes",
            input_tokens=delta[0] + delta[2] + delta[3],
            output_tokens=delta[1],
            cwd=cwd, session_id=session_id, file_path=str(path),
            dedup_key=f"hermes:{_sid}:{':'.join(str(v) for v in now)}",
            timestamp=_epoch_to_iso(last) or "",
            cache_read_tokens=delta[2], cache_creation_tokens=delta[3],
        )

    def parse_session_file(self, path: Path, seen_keys: set[str]) -> list[TokenUsage]:
        """Every session's counters as one event each (the whole history)."""
        if path.name != _DB_NAME:
            return []
        out: list[TokenUsage] = []
        for named, *row in self._counter_rows(path) or []:
            usage = self._usage(path, named, tuple(row), (0, 0, 0, 0))
            if usage is not None and usage.dedup_key not in seen_keys:
                seen_keys.add(usage.dedup_key)
                out.append(usage)
        return out

    def parse_incremental(self, path: Path, checkpoint: dict[str, Any]) -> IncrementalParseResult:
        """Counter growth since the checkpoint, which keeps each session's last
        counters. Unreadable this cycle = no events, checkpoint unchanged."""
        if path.name != _DB_NAME:
            return IncrementalParseResult([], dict(checkpoint))
        rows = self._counter_rows(path)
        if rows is None:
            return IncrementalParseResult([], dict(checkpoint))
        last = checkpoint.get("sessions") if checkpoint.get("kind") == "hermes_counters" else None
        last = last if isinstance(last, dict) else {}
        events: list[TokenUsage] = []
        state: dict[str, list[int]] = {}
        for named, *row in rows:
            sid = str(row[0])
            prev = last.get(sid)
            base = tuple(int(v) for v in prev) if isinstance(prev, list) and len(prev) == 4 else (0, 0, 0, 0)
            usage = self._usage(path, named, tuple(row), base)
            if usage is not None:
                events.append(usage)
            state[sid] = [int(v or 0) for v in row[2:6]]
        return IncrementalParseResult(events, {"kind": "hermes_counters", "sessions": state})

    # ── activity: one event per new message row ─────────────────────────────

    def parse_activity(self, path: Path, seen_keys: set[str]) -> list[ActivityEvent]:
        """user row → agent_active "user"; tool rows and tool-calling
        assistant rows → agent_active; an assistant row with a final
        finish_reason → turn_complete carrying the reply. Watermarked on
        messages.id; first sight anchors at the newest row so a backend
        restart never replays history."""
        if path.name != _DB_NAME:
            return []
        prev = next((k[len(_ACTIVITY_PREFIX):] for k in seen_keys
                     if k.startswith(_ACTIVITY_PREFIX)), None)

        def remember(row_id: int) -> None:
            seen_keys.difference_update({k for k in seen_keys if k.startswith(_ACTIVITY_PREFIX)})
            seen_keys.add(_ACTIVITY_PREFIX + str(row_id))

        con = self._connect(path)
        if con is None:
            return []
        try:
            top = int(con.execute("SELECT COALESCE(MAX(id), 0) FROM messages").fetchone()[0] or 0)
            if prev is None or top < int(prev):
                # First sight, or the store was replaced: history, not activity.
                remember(top)
                return []
            rows = con.execute(
                "SELECT id, session_id, role, content, tool_calls, timestamp, finish_reason "
                "FROM messages WHERE id > ? ORDER BY id LIMIT ?",
                (int(prev), _MAX_ROWS_PER_PASS),
            ).fetchall()
            sessions = self._sessions(con, (str(r[1]) for r in rows))
        except sqlite3.Error as err:
            log.debug("hermes activity %s failed: %s", path, err)
            return []
        finally:
            con.close()

        out: list[ActivityEvent] = []
        watermark = int(prev)
        for index, (row_id, sid, role, content, tool_calls, stamp, finish) in enumerate(rows):
            final = role == "assistant" and bool(finish) and finish != "tool_calls" and not tool_calls
            if (role == "assistant" and not finish and not tool_calls
                    and index == len(rows) - 1):
                # The newest row is an assistant reply with no finish_reason
                # yet: read it again next pass rather than lose its turn end.
                break
            watermark = int(row_id)
            session_id, cwd = sessions.get(str(sid), (str(sid), ""))
            common = dict(vendor="hermes", cwd=cwd, session_id=session_id, file_path=str(path),
                          dedup_key=f"msg:{row_id}", timestamp=_epoch_to_iso(stamp) or "")
            if role == "user":
                text = user_prompt_text(_message_text(content))
                if text:
                    out.append(ActivityEvent(event_type="agent_active", detail="user", text=text, **common))
            elif final:
                out.append(ActivityEvent(event_type="turn_complete", detail=str(finish),
                                         text=_cap_text(_message_text(content)), **common))
            elif role in ("assistant", "tool"):
                out.append(ActivityEvent(event_type="agent_active", detail=str(role), **common))
        remember(watermark)
        return out

    # ── marker binding (a custom command with no Navide session name) ──────

    def find_sessions_by_marker(self, markers: Iterable[str]) -> dict[str, tuple[str, str]]:
        """marker → (session id, cwd) for kickoff markers found in user rows."""
        wanted = [m for m in markers if m]
        db = self._db_path()
        if not wanted or not db.is_file():
            return {}
        con = self._connect(db)
        if con is None:
            return {}
        found: dict[str, tuple[str, str]] = {}
        try:
            rows = con.execute(
                "SELECT session_id, content FROM messages WHERE role = 'user' "
                "ORDER BY id DESC LIMIT ?", (_MAX_MARKER_ROWS,),
            ).fetchall()
            sessions = self._sessions(con, (str(r[0]) for r in rows))
        except sqlite3.Error:
            return {}
        finally:
            con.close()
        for sid, content in reversed(rows):
            text = content if isinstance(content, str) else ""
            for marker in wanted:
                if marker not in found and marker in text:
                    found[marker] = sessions.get(str(sid), (str(sid), ""))
        return found


def _workspace_match(self, usage, ws_path, owner_workspace=None):
    # The session row records the cwd Hermes ran in; a bound session also
    # attributes to its pane's workspace.
    if owner_workspace is not None and owner_workspace == ws_path:
        return True
    return bool(usage.cwd and usage.cwd == ws_path)


def _pane_cwd_match(self, usage, pane_cwd, pane_id):
    return bool(usage.cwd) and usage.cwd == pane_cwd


HermesLogReader.binds_shared_db_by_marker = True
HermesLogReader.emits_session_sink = True
HermesLogReader.workspace_match = _workspace_match
HermesLogReader.pane_cwd_match = _pane_cwd_match


# The Navide session name a `hermes chat --continue <name>` launch targets is
# read by the launch declaration (native/navide-cli-runtime/src/vendors/
# hermes.rs; see _declared).


def _session_exists(workspace_path: str, session_id: str) -> bool:
    # One shared store; an unreadable store is unknown, so assume resumable.
    found = HermesLogReader().has_session(session_id)
    return True if found is None else found


# Instruction files: one project file per session, first match of .hermes.md /
# HERMES.md (up to the git root), AGENTS.override.md, AGENTS.md (merged git
# root -> cwd), CLAUDE.md, .cursorrules; SOUL.md only from the Hermes home
# (docs/user-guide/features/context-files, read 2026-11-07).
_MEMORY_SOURCES = (
    MemorySource("hermes", USER_SCOPE, (".hermes", "SOUL.md"), canonical=True),
    MemorySource("hermes", PROJECT_SCOPE, ("AGENTS.md",), canonical=True),
    MemorySource("hermes", PROJECT_SCOPE, (".hermes.md",)),
    MemorySource("hermes", PROJECT_SCOPE, ("HERMES.md",)),
    MemorySource("hermes", PROJECT_SCOPE, ("AGENTS.override.md",)),
    MemorySource("hermes", PROJECT_SCOPE, ("CLAUDE.md",)),
)

SPEC = VendorSpec(
    memory_sources=_MEMORY_SOURCES,
    cli_unverified_reason="wired from the docs (read 2026-11-07); no install to run, so no version was checked",
    key="hermes",
    extensions=ExtensionsSpec(
        supported=False,
        note="Hermes skills and plugins (~/.hermes) are not inventoried yet",
    ),
    # Nous Portal, OpenRouter, OpenAI or a custom endpoint; no fixed host.
    expected_hosts=(),
    data_dirs=lambda ctx: (_home(ctx),),
    data_dir_env_vars=("HERMES_HOME", "LOCALAPPDATA"),
    # Resume by session name, and no model / effort (`-m` and `--reasoning`
    # are refused on a `--continue` launch, see the module docstring): the
    # launch declaration.
    **declared("hermes"),
    session_exists=_session_exists,
    make_log_reader=HermesLogReader,
    install_dep=Dep("hermes", "Hermes Agent", "Nous Research general AI agent", "agent_cli",
        ["hermes", "--version"], r"(\d+\.\d+\.\d+)",
        # The official installers are `curl | bash` and `iex (irm …)`;
        # Navide does not run them.
        optional=True,
        docs_url="https://hermes-agent.nousresearch.com/docs/getting-started/installation",
        update_cmd="hermes update",
        doctor_cmd="hermes doctor"),
)
