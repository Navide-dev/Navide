"""Grok CLI (xAI grok-build) conversation reader.

Storage: one directory per session under ``$GROK_HOME/sessions`` (default
``~/.grok/sessions``), grouped by the working directory the session ran in::

    sessions/<url-encoded-cwd>/<session-uuid7>/
        updates.jsonl   ACP session/update notifications — the transcript
        usage.json      per-session and per-turn token totals
        summary.json    title, timestamps, model id, message counts

The group directory is ``urllib.parse.quote(cwd, safe="")``. When that would
exceed 255 bytes grok uses a slug plus a hash instead and records the real path
in a ``.cwd`` file inside the group, so the decode below prefers that file
whenever it exists.

Each ``updates.jsonl`` line is one JSON-RPC notification::

    {"method": "session/update" | "_x.ai/session/update",
     "timestamp": 1789379453,
     "params": {"sessionId": "<uuid7>",
                "_meta": {"eventId": "<sessionId>-<n>",
                          "agentTimestampMs": 1789379453711},
                "update": {"sessionUpdate": "<kind>", ...}}}

The kinds this reader acts on:

  ``user_message_chunk`` / ``agent_message_chunk``
      the conversation text (``content`` is ``{"type": "text", "text": ...}``)
  ``turn_completed``
      end of turn, carrying that turn's ``usage``

``turn_completed`` is the important one. The community ``grok-cli`` this
replaced wrote no end-of-turn record, so the old reader inferred a boundary
from 8 seconds of silence — which is why a grok pane took 8 seconds to hand a
message to another CLI. The official CLI writes the record explicitly, with the
turn's tokens attached, so neither the inference nor a separate usage store is
needed. Note this contradicts the shipped docs (``17-sessions.md`` documents no
end-of-turn marker); the events above were read off a real transcript.

``_meta.eventId`` is ``<sessionId>-<n>`` with n ascending per session, and every
dedup key here is built from it. It is NOT a dense per-file line counter —
``hook_execution`` events consume the same sequence — so this reader keeps exact
per-event keys rather than the line high-water mark of
``activity_resumes_by_line``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections.abc import Iterable
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote
from uuid import UUID

from .. import osplat
from .base import ExtensionsSource, ExtensionsSpec  # noqa: F401
from .base import AccountSwitchSpec, Dep, PlatformInstall, McpServerConfig, McpValue, McpWiring, SkillsWiring, VendorSpec, simple_command_args
from ..usage_common import _num, _snapshot, _window
from ..log_readers.base import (
    ActivityEvent,
    IncrementalParseResult,
    LogReader,
    TokenUsage,
    TurnCall,
    TurnUsage,
    merge_prompt_excerpt,
    read_jsonl_tail,
    user_prompt_text,
)

log = logging.getLogger("agent_team_backend.log_readers.grok")

_TRANSCRIPT = "updates.jsonl"
_SESSIONS_DIRNAME = "sessions"
#: Written by grok inside a group directory whose encoded name had to be
#: shortened; holds the real cwd.
_CWD_FILE = ".cwd"
_TEXT_MAX_CHARS = 4_000


def _cap_text(text: str) -> str:
    if len(text) <= _TEXT_MAX_CHARS:
        return text
    half = _TEXT_MAX_CHARS // 2
    return f"{text[:half]}\n…\n{text[-half:]}"


def _int(v: Any) -> int:
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return 0


def _chunk_text(update: dict) -> str:
    """Visible text of a message chunk.

    ``content`` is a single ``{"type": "text", "text": ...}`` block in every
    transcript seen, but a list is accepted too so a future multi-block chunk
    does not read as empty.
    """
    content = update.get("content")
    if isinstance(content, dict):
        content = [content]
    if not isinstance(content, list):
        return ""
    parts = [
        str(b.get("text") or "")
        for b in content
        if isinstance(b, dict) and b.get("type") == "text"
    ]
    return "".join(parts)


def _iso(params: dict, record: dict) -> str:
    """ISO-8601 stamp for one record.

    The frontend dedups messaging turns by timestamp and treats an unparseable
    one as always-fresh — which would resend a delivered turn and replay history
    after a backend restart — so this never returns a non-time string.
    ``_meta.agentTimestampMs`` is preferred for its millisecond resolution; the
    top-level ``timestamp`` (unix seconds) is the fallback.
    """
    meta = params.get("_meta")
    ms = (meta or {}).get("agentTimestampMs") if isinstance(meta, dict) else None
    seconds = _num(ms) / 1000.0 if ms is not None else _num(record.get("timestamp"))
    if not seconds:
        return ""
    return (
        time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(seconds))
        + f".{int((seconds % 1) * 1000):03d}Z"
    )


#: parse_activity gets no checkpoint argument — only the watcher's per-file
#: `seen_keys` bag — so its cursor is persisted as ONE sentinel inside that bag.
#: Exact per-event keys were the obvious alternative and are what the base
#: guidance prescribes for a per-session sequence counter, but they grow the bag
#: with the conversation, which is the failure GitHub #28 was (one key per row,
#: bag too large to persist, whole history replayed on every backend start).
#: Byte offsets are dense and ascending in file order, which eventId is NOT:
#: hook_execution records take their number when they are queued and are written
#: later, so a real transcript runs …4, 3, 50, 55, 51, 56. A high-water mark over
#: that sequence would swallow every record that arrives out of order.
_ACT_CURSOR_PREFIX = "grok_act::"
#: A turn's reply text accumulates over several agent_message_chunk records and
#: is handed to the turn_completed that follows. Those can land in different
#: passes, so the partial text rides in the bag too.
_ACT_TEXT_PREFIX = "grok_text::"


def _read_sentinel(seen_keys: set[str], prefix: str) -> Any:
    for k in seen_keys:
        if k.startswith(prefix):
            try:
                return json.loads(k[len(prefix):])
            except json.JSONDecodeError:
                return None
    return None


def _write_sentinel(seen_keys: set[str], prefix: str, value: Any) -> None:
    seen_keys.difference_update({k for k in seen_keys if k.startswith(prefix)})
    if value:
        seen_keys.add(f"{prefix}{json.dumps(value, sort_keys=True)}")


class _Event:
    """One decoded transcript record, or nothing useful."""

    __slots__ = ("kind", "event_id", "session_id", "update", "timestamp")

    def __init__(self, record: Any) -> None:
        self.kind = ""
        self.event_id = ""
        self.session_id = ""
        self.update: dict = {}
        self.timestamp = ""
        if not isinstance(record, dict):
            return
        params = record.get("params")
        if not isinstance(params, dict):
            return
        update = params.get("update")
        if not isinstance(update, dict):
            return
        meta = params.get("_meta")
        self.session_id = str(params.get("sessionId") or "")
        self.event_id = str((meta or {}).get("eventId") or "") if isinstance(meta, dict) else ""
        self.kind = str(update.get("sessionUpdate") or "")
        self.update = update
        self.timestamp = _iso(params, record)

    def key(self, prefix: str, fallback: object) -> str:
        """Dedup key for this event.

        eventId is the CLI's own per-session counter and is what makes a key
        stable across restarts. A record without one (never seen in practice)
        falls back to the byte offset, which is unique within a file but moves
        if the file is ever rewritten — acceptable for something that does not
        occur, and better than dropping the event.
        """
        ident = self.event_id or f"{self.session_id}@{fallback}"
        return f"{prefix}:{ident}"


class GrokLogReader(LogReader):
    vendor: str = "grok"

    #: turns_for_session reads the turn_completed record's own usage.
    turns_method: str = "exact"

    # ---- layout ------------------------------------------------------------

    def _home(self) -> Path:
        """grok's home. ``GROK_HOME`` relocates the whole tree (sessions and
        credentials alike), which is how a pane is isolated."""
        env = os.environ.get("GROK_HOME")
        return Path(env) if env else Path.home() / ".grok"

    def _sessions_root(self) -> Path:
        return self._home() / _SESSIONS_DIRNAME

    def project_dirs(self) -> list[Path]:
        root = self._sessions_root()
        return [root] if root.is_dir() else []

    def watch_dirs(self) -> list[Path]:
        # The per-cwd groups and per-session dirs below are created as sessions
        # start, so the stable parent is what can actually be subscribed to.
        return self.project_dirs()

    def session_files(self) -> list[Path]:
        root = self._sessions_root()
        if not root.is_dir():
            return []
        try:
            return sorted(root.glob(f"*/*/{_TRANSCRIPT}"))
        except OSError:
            return []

    def session_files_for_workspace(self, workspace_path: str) -> list[Path] | None:
        """Only the sessions of one workspace — the group directory IS the
        index, so a per-workspace rescan never touches another project.

        Returns None (meaning "cannot scope, scan everything") for a workspace
        whose group name was shortened: the mapping is one-way then, and the
        real path lives in a ``.cwd`` file the caller would have to read anyway.
        """
        if not workspace_path:
            return None
        group = self._sessions_root() / quote(workspace_path.rstrip("/"), safe="")
        if not group.is_dir():
            # Either no sessions yet, or a shortened group name. Distinguishing
            # them costs a full scan of the root either way.
            return None if self._has_shortened_group() else []
        try:
            return sorted(group.glob(f"*/{_TRANSCRIPT}"))
        except OSError:
            return None

    def _has_shortened_group(self) -> bool:
        root = self._sessions_root()
        try:
            return any((d / _CWD_FILE).is_file() for d in root.iterdir() if d.is_dir())
        except OSError:
            return False

    def session_id_from_path(self, path: Path) -> str:
        """The session id is the directory name; every file inside is named
        after its role (``updates.jsonl``), so the inherited filename-stem
        default would coin ``updates`` for all of them."""
        if path.name != _TRANSCRIPT:
            return ""
        return path.parent.name

    def cwd_from_file(self, path: Path) -> str:
        """The cwd this session ran in, from its group directory.

        A ``.cwd`` file wins when present: that group's name was shortened and
        cannot be decoded back.
        """
        group = path.parent.parent
        marker = group / _CWD_FILE
        try:
            if marker.is_file():
                return marker.read_text(encoding="utf-8").strip()
        except OSError:
            pass
        return unquote(group.name)

    def accepts_watch_path(self, path_str: str) -> bool:
        # Every session directory holds a dozen sibling files (chat_history,
        # signals, tool_definitions, lock files) that change on every turn.
        # Only the transcript carries events, so the rest never wake a parse.
        return path_str.endswith(_TRANSCRIPT)

    # ---- reading -----------------------------------------------------------

    def _read_records(self, path: Path) -> list[tuple[int, Any]]:
        """Every complete record in the file, as (byte offset, value)."""
        records, _checkpoint, _rotated = read_jsonl_tail(path, {})
        return list(records)

    def _usage_from(
        self, event: _Event, path: Path, cwd: str, offset: int, checkpoint: dict | None = None
    ) -> TokenUsage | None:
        usage = event.update.get("usage")
        if not isinstance(usage, dict):
            return None
        # inputTokens is the whole input: the sample transcripts satisfy
        # totalTokens == inputTokens + outputTokens with the cache counters
        # reported alongside rather than added, which is also how Navide models
        # it (cache folded into input). outputTokens likewise already contains
        # reasoningTokens.
        input_tokens = _int(usage.get("inputTokens"))
        output_tokens = _int(usage.get("outputTokens"))
        if input_tokens == 0 and output_tokens == 0:
            return None
        model = ""
        per_model = usage.get("modelUsage")
        if isinstance(per_model, dict) and per_model:
            model = str(next(iter(per_model)))
        return TokenUsage(
            vendor="grok",
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cwd=cwd,
            session_id=event.session_id,
            file_path=str(path),
            dedup_key=event.key("usage", offset),
            timestamp=event.timestamp,
            model=model,
            checkpoint=dict(checkpoint or {}),
        )

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        if path.name != _TRANSCRIPT:
            return []
        try:
            records = self._read_records(path)
        except OSError as err:
            log.debug("grok transcript unreadable %s: %s", path, err)
            return []
        cwd = self.cwd_from_file(path)
        out: list[TokenUsage] = []
        for offset, value in records:
            event = _Event(value)
            if event.kind != "turn_completed":
                continue
            usage = self._usage_from(event, path, cwd, offset)
            if usage is None:
                continue
            if usage.dedup_key in seen_keys:
                continue
            seen_keys.add(usage.dedup_key)
            out.append(usage)
        return out

    def parse_incremental(
        self, path: Path, checkpoint: dict
    ) -> IncrementalParseResult:
        if path.name != _TRANSCRIPT:
            return IncrementalParseResult([], dict(checkpoint))
        try:
            records, next_checkpoint, _rotated = read_jsonl_tail(path, checkpoint)
        except OSError as err:
            log.debug("grok transcript unreadable %s: %s", path, err)
            return IncrementalParseResult([], dict(checkpoint))
        cwd = self.cwd_from_file(path)
        out: list[TokenUsage] = []
        for offset, value in records:
            event = _Event(value)
            if event.kind != "turn_completed":
                continue
            cursor = dict(next_checkpoint)
            cursor["offset"] = offset
            usage = self._usage_from(event, path, cwd, offset, cursor)
            if usage is not None:
                out.append(usage)
        return IncrementalParseResult(out, next_checkpoint)

    def turns_for_session(self, path: Path, session_id: str = "") -> list[TurnUsage]:
        """One turn per `turn_completed` record, which carries the whole
        turn's usage: inputTokens is the full input with cachedReadTokens /
        cacheCreationTokens reported as parts of it (totalTokens is input +
        output), so input here is the uncached remainder. The record has no
        per-call breakdown — `modelCalls` is the count, and `modelUsage`
        (one entry per model) is what calls_detail shows.
        """
        if path.name != _TRANSCRIPT:
            return []
        try:
            records = self._read_records(path)
        except OSError as err:
            log.debug("grok transcript unreadable %s: %s", path, err)
            return []
        turns: list[TurnUsage] = []
        pending_text = ""
        pending_ts: str | None = None
        for _offset, value in records:
            event = _Event(value)
            if session_id and event.session_id != session_id:
                continue
            if event.kind == "user_message_chunk":
                if pending_ts is None:
                    pending_ts = event.timestamp or None
                pending_text = merge_prompt_excerpt(pending_text, _chunk_text(event.update))
                continue
            if event.kind != "turn_completed":
                continue
            usage = event.update.get("usage")
            if not isinstance(usage, dict):
                continue
            turn = TurnUsage(
                turn_index=0, session_id=event.session_id,
                started_at=pending_ts, ended_at=event.timestamp or None,
                prompt_excerpt=pending_text,
                model_calls=_int(usage.get("modelCalls")) or None,
            )
            pending_text, pending_ts = "", None
            per_model = usage.get("modelUsage")
            parts = (
                list(per_model.items())
                if isinstance(per_model, dict) and per_model
                else [("", usage)]
            )
            for model, counts in parts:
                if not isinstance(counts, dict):
                    continue
                cache_read = _int(counts.get("cachedReadTokens"))
                cache_creation = _int(counts.get("cacheCreationTokens"))
                turn.add_call(TurnCall(
                    ts=event.timestamp or None, model=str(model),
                    input=max(0, _int(counts.get("inputTokens")) - cache_read - cache_creation),
                    cache_read=cache_read, cache_creation=cache_creation,
                    output=_int(counts.get("outputTokens")),
                ))
            if turn.total == 0:
                continue
            turns.append(turn)
        for n, turn in enumerate(turns, 1):
            turn.turn_index = n
        return turns

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """`agent_active` per message chunk, `turn_complete` per finished turn.

        The turn boundary is read, not inferred: the official CLI writes a
        ``turn_completed`` record carrying the turn's stop reason. The community
        grok-cli this replaced wrote none, so the old reader closed a turn after
        8 seconds of silence — which is why a grok pane took 8 seconds to hand a
        message to another CLI.

        ``turn_complete`` carries the assistant's closing text, which is what
        lets a grok pane send inter-CLI messages at all — the frontend only
        parses the ---MSG-START--- protocol out of a turn_complete that has
        text.

        Resumes from a byte cursor kept in ``seen_keys`` (see
        _ACT_CURSOR_PREFIX), so a restart continues instead of replaying and the
        bag stays one key wide however long the conversation runs.
        """
        if path.name != _TRANSCRIPT:
            return []
        cursor = _read_sentinel(seen_keys, _ACT_CURSOR_PREFIX)
        try:
            records, next_cursor, rotated = read_jsonl_tail(
                path, cursor if isinstance(cursor, dict) else {}
            )
        except OSError as err:
            log.debug("grok transcript unreadable %s: %s", path, err)
            return []
        cwd = self.cwd_from_file(path)
        # A rewritten file re-reads from zero, so a half-built reply from the
        # generation before it would be spliced onto a turn it never belonged
        # to.
        pending = "" if rotated else str(_read_sentinel(seen_keys, _ACT_TEXT_PREFIX) or "")

        out: list[ActivityEvent] = []
        for offset, value in records:
            event = _Event(value)
            if event.kind == "agent_message_chunk":
                text = _chunk_text(event.update)
                if text:
                    pending = _cap_text(pending + text)
            if event.kind == "turn_completed":
                out.append(ActivityEvent(
                    vendor="grok", event_type="turn_complete",
                    cwd=cwd, session_id=event.session_id, file_path=str(path),
                    dedup_key=event.key("turn", offset), timestamp=event.timestamp,
                    detail=str(event.update.get("stop_reason") or "end_turn"),
                    text=pending,
                ))
                pending = ""
                continue
            if event.kind not in ("user_message_chunk", "agent_message_chunk"):
                continue
            role = "user" if event.kind == "user_message_chunk" else "assistant"
            out.append(ActivityEvent(
                vendor="grok", event_type="agent_active",
                cwd=cwd, session_id=event.session_id, file_path=str(path),
                dedup_key=event.key("act", offset), timestamp=event.timestamp,
                detail=role,
                text=user_prompt_text(_chunk_text(event.update)) if role == "user" else "",
            ))

        _write_sentinel(seen_keys, _ACT_CURSOR_PREFIX, next_cursor)
        _write_sentinel(seen_keys, _ACT_TEXT_PREFIX, pending)
        return out

    def find_sessions_by_marker(
        self, markers: Iterable[str]
    ) -> dict[str, tuple[str, str]]:
        """marker → (session_id, workspace_root) for kickoff markers found in a
        transcript. Earliest match wins per marker."""
        wanted = [m for m in markers if m]
        if not wanted:
            return {}
        found: dict[str, tuple[str, str]] = {}
        for path in self.session_files():
            if len(found) == len(wanted):
                break
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for marker in wanted:
                if marker not in found and marker in text:
                    found[marker] = (self.session_id_from_path(path), self.cwd_from_file(path))
        return found


# ---- attribution/watch hooks ----------------------------------------------

def _workspace_match(self, usage, ws_path, owner_workspace=None):
    # Reader emits cwd = the session's own group directory, decoded.
    return bool(usage.cwd and usage.cwd == ws_path)


def _pane_cwd_match(self, usage, pane_cwd, pane_id):
    return usage.cwd == pane_cwd


# One directory per session now, so binding goes through the ordinary
# marker-FILE path. `binds_shared_db_by_marker` described the community CLI's
# single ~/.grok/grok.db and no longer applies.
GrokLogReader.binds_by_marker_file = True
GrokLogReader.emits_session_sink = True
GrokLogReader.workspace_match = _workspace_match
GrokLogReader.pane_cwd_match = _pane_cwd_match


def _resume_id_from_command(command) -> str:
    args = simple_command_args(command)
    if not args or args[0] != "grok":
        return ""
    for index, arg in enumerate(args[1:], 1):
        if arg == "--":
            break
        if arg in ("-r", "--resume") and index + 1 < len(args):
            value = args[index + 1]
        elif arg.startswith("--resume="):
            value = arg.partition("=")[2]
        else:
            continue
        # Grok also accepts titles. Only a UUID identifies the transcript for
        # attribution and duplicate-PTY reaping without asking the CLI.
        try:
            session_id = str(UUID(value))
        except ValueError:
            return ""
        return session_id if session_id == value.lower() else ""
    return ""


def _session_path(workspace_path: str, session_id: str) -> Path | None:
    """The transcript the resume preflight checks, or None when it cannot be
    named.

    The per-cwd group directory makes this reconstructable, which the community
    CLI's one shared SQLite store never allowed. It stays unanswerable for a
    workspace whose encoded name grok had to shorten: the real path then lives
    in a ``.cwd`` file inside a group whose name is a hash, so the id alone
    cannot point at it and "assume resumable" remains the right answer.
    """
    if not workspace_path or not session_id:
        return None
    reader = GrokLogReader()
    if reader._has_shortened_group():
        return None
    group = reader._sessions_root() / quote(workspace_path.rstrip("/"), safe="")
    return group / session_id / _TRANSCRIPT


# ---- credentials (vault layout + identity) ---------------------------------

def identity_from_secret(secret):
    """Display identity for the accounts UI: grok's ``auth.json`` is a map
    keyed by scope URL; prefer the OIDC entry, fall back to the legacy
    ``/sign-in`` scope (mirrors the usage reader)."""
    data = None
    if secret is not None:
        try:
            data = json.loads(secret)
        except ValueError:
            data = None
    if not isinstance(data, dict):
        data = None
    oidc, legacy = None, None
    for scope, entry in (data or {}).items():
        if not isinstance(entry, dict) or not entry.get("key"):
            continue
        if str(scope).startswith("https://auth.x.ai::"):
            oidc = oidc or entry
        elif "/sign-in" in str(scope):
            legacy = legacy or entry
    entry = oidc or legacy
    email = entry.get("email") if entry else None
    return {
        "email": email if isinstance(email, str) and email else None,
        "signedIn": entry is not None,
    }


# ---- usage quota -----------------------------------------------------------

GROK_INIT_TIMEOUT = 4.0
GROK_BILLING_TIMEOUT = 3.0


def read_grok_credentials(home: Path, env: dict | None = None) -> dict | None:
    """``auth.json`` is a map keyed by scope URL. Prefer the OIDC entry
    (``https://auth.x.ai::`` prefix, SuperGrok), fall back to a legacy
    ``/sign-in`` scope. Returns {key, email, expires_at} or None."""
    env = env or {}
    grok_home = Path(env["GROK_HOME"]) if env.get("GROK_HOME") else home / ".grok"
    try:
        data = json.loads((grok_home / "auth.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    oidc, legacy = None, None
    for scope, entry in data.items():
        if not isinstance(entry, dict) or not entry.get("key"):
            continue
        if str(scope).startswith("https://auth.x.ai::"):
            oidc = oidc or entry
        elif "/sign-in" in str(scope):
            legacy = legacy or entry
    entry = oidc or legacy
    if entry is None:
        return None
    return {"key": entry["key"], "email": entry.get("email"),
            "expires_at": entry.get("expires_at")}




def normalize_grok(billing: dict) -> tuple[list[dict], str | None]:
    """``x.ai/billing`` result: cent amounts wrapped as ``{"val": n}``."""
    def val(node: Any) -> float | None:
        if isinstance(node, dict):
            return _num(node.get("val"))
        return _num(node)

    windows: list[dict] = []
    limit = val((billing or {}).get("monthlyLimit"))
    used = val(((billing or {}).get("usage") or {}).get("totalUsed"))
    cycle = (billing or {}).get("billingCycle") or {}
    resets = cycle.get("billingPeriodEnd")
    if limit and used is not None:
        windows.append(_window("monthly", "Monthly credits", used / limit * 100,
                               resets if isinstance(resets, str) else None))
    return windows, None




async def grok_billing_rpc(binary: str, env: dict | None = None) -> dict:
    """Spawn ``grok agent stdio`` and ask ``x.ai/billing`` over newline-delimited
    JSON-RPC. The subprocess is short-lived — spawned, queried, terminated.
    json.dumps never escapes ``/`` so the method name arrives intact.

    ``env`` (``None`` = inherit the parent environment) lets a profile point the
    CLI at its isolated ``HOME`` shim so billing reflects that account."""
    proc = await asyncio.create_subprocess_exec(
        *osplat.paths.launch_argv(binary, ("agent", "stdio")),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        env=env,
    )

    async def rpc(req_id: int, method: str, params: dict, timeout: float) -> dict:
        assert proc.stdin is not None and proc.stdout is not None
        msg = {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}
        proc.stdin.write((json.dumps(msg, separators=(",", ":")) + "\n").encode())
        await proc.stdin.drain()
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise asyncio.TimeoutError()
            line = await asyncio.wait_for(proc.stdout.readline(), timeout=remaining)
            if not line:
                raise ConnectionError("grok agent closed stdout")
            try:
                payload = json.loads(line)
            except ValueError:
                continue
            if isinstance(payload, dict) and payload.get("id") == req_id:
                if "error" in payload:
                    raise ConnectionError(str(payload["error"]))
                return payload.get("result") or {}

    try:
        await rpc(1, "initialize", {
            "protocolVersion": "1",
            "clientCapabilities": {
                "fs": {"readTextFile": False, "writeTextFile": False},
                "terminal": False,
            },
        }, GROK_INIT_TIMEOUT)
        return await rpc(2, "x.ai/billing", {}, GROK_BILLING_TIMEOUT)
    finally:
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                proc.kill()


async def fetch_grok(home: Path, env: dict | None = None) -> dict:
    creds = read_grok_credentials(home, env)
    if creds is None:
        return _snapshot("grok", "no-credentials")
    binary = osplat.paths.resolve_program("grok")
    if not binary:
        return _snapshot("grok", "unavailable", error="grok CLI not found")
    try:
        billing = await grok_billing_rpc(binary)
    except (OSError, ConnectionError, asyncio.TimeoutError) as err:
        return _snapshot("grok", "unavailable", error=str(err) or "grok agent stdio failed")
    windows, plan = normalize_grok(billing)
    if not windows:
        return _snapshot("grok", "error", error="billing response had no usable fields")
    return _snapshot("grok", "ok", windows=windows, plan_type=plan)




# ---- vendor spec -----------------------------------------------------------

# Where this CLI keeps the extensions it installed for itself (read-only
# inventory, cli_extensions). Verified 2026-10-10 against the installed
# binary's --help and the files on disk.
_EXTENSIONS = ExtensionsSpec(sources=(
    ExtensionsSource("plugin-dirs", (".grok", "installed-plugins"), "Grok plugin"),
))

SPEC = VendorSpec(
    extensions=_EXTENSIONS,
    key="grok",
    # auth.x.ai proves login routing only; grok-build service hosts unverified.
    expected_hosts=(),
    # GrokLogReader._home layout, including GROK_HOME and the HOME shim.
    data_dirs=lambda ctx: (ctx.path(ctx.env.get("GROK_HOME") or ctx.home / ".grok"),),
    data_dir_env_vars=("GROK_HOME",),
    supports_model=True,
    # ~/.agents/skills is still a scanned tier on the official CLI (docs
    # 08-skills.md lists .agents/skills alongside .grok/skills at every level),
    # and there is still no variable that relocates the skills root on its own
    # — only GROK_HOME, which moves the whole tree — so this keeps riding the
    # HOME shim its MCP wiring builds.
    skills_supported=True,
    skills_wiring=SkillsWiring(
        root_env="HOME",
        reads_shared_root=True,
        skills_rel=(".agents", "skills"),
    ),
    label="Grok Build (SpaceXAI)",
    # Wired through the per-pane HOME shim (mcp_server/pane_home.py): the
    # official CLI reads its servers as a MAP of `[mcp_servers.<name>]` tables
    # in ~/.grok/config.toml, and `config_file` + `section` below is the whole
    # description of that — pane_home picks the serializer by suffix
    # (`_is_toml` -> tomli_w) since f3d77f0d, so the TOML is written, not
    # JSON. config.toml also holds the user's own settings and BYO API key,
    # which is why the shim copies that one file instead of linking it. The
    # community grok-cli this replaced kept a `mcp.servers` LIST in
    # ~/.grok/user-settings.json; nothing reads that any more.
    mcp_wiring=McpWiring(
        # `[mcp_servers.<name>]` in TOML: a map keyed by the server's name, so
        # no list_key. A bare `url` is how the CLI's own `grok mcp add` writes
        # a streamable-HTTP server (transport is inferred from the scheme), and
        # `enabled` defaults to true.
        config=McpServerConfig(
            section=("mcp_servers",),
            entry=(("url", McpValue.URL),),
        ),
        config_dir=".grok",
        config_file=("config.toml",),
    ),
    # `grok login` defaults to the browser OAuth flow at auth.x.ai, which a PTY
    # pane can carry: the CLI opens the browser and waits. `--device-auth` is
    # the headless alternative and is not what a desktop pane needs.
    login_command_args="login",
    live_file=(".grok", "auth.json"),
    slot_file="auth.json",
    login_home_secret_file=("home", ".grok", "auth.json"),
    profile_home_secret_file=(".grok", "auth.json"),
    identity_from_secret=identity_from_secret,
    # Whole-file swap of ``~/.grok/auth.json`` (a map keyed by scope URL —
    # one file per account, so it is swapped whole); the CLI reads it at
    # startup, so affected panes restart and resume (``grok -r <id>``). Layout
    # from the installed CLI; no two-account round-trip on record yet.
    account_switch=AccountSwitchSpec(
        auth_scope="grok",
        method="restart",
        store="file",
        evidence="source",
        verified_version="1.0.34",
        # The 1.0.34 binary reports "You are using XAI_API_KEY." / "Auth
        # method: API key (XAI_API_KEY)" when the variable is set: the key
        # replaces the OAuth login for that process.
        shadowing_env=("XAI_API_KEY",),
        resume="native",
        todo="A -> B -> A round-trip on two real accounts not yet recorded",
    ),
    # Late-bound (module global at call time) so tests can monkeypatch.
    fetch_usage=lambda home: fetch_grok(home),
    home_env_vars=(
        "GROK_HOME",
        # Child/daemon runtime markers the community grok-cli stamped on its
        # own subprocesses — same inheritance hazard class as claude's
        # child-session marker. Kept after the move to the official CLI rather
        # than dropped: a string scan of the official binary finds neither, but
        # that scan is not evidence of absence — GROK_SANDBOX, which `grok
        # --help` states outright, does not show up in it either. Stripping a
        # marker that does exist would reintroduce the hazard; carrying one
        # that does not costs nothing.
        "GROK_BACKGROUND_CHILD",
        "GROK_DAEMON_CHILD",
    ),
    make_log_reader=GrokLogReader,
    resume_id_from_command=_resume_id_from_command,
    # Newly answerable: sessions live at a path derived from the cwd and the
    # id, so a resume preflight can check instead of assuming.
    session_path=_session_path,
    # xAI's own grok-build CLI. A same-named community CLI (superagent-ai/
    # grok-cli) installs to the same ~/.grok/bin/grok, so `which grok` cannot
    # tell them apart — the version string can: this one prints
    # "grok <x.y.z> (<commit>)", the community one a bare "1.1.7".
    install_dep=Dep("grok", "Grok Build (SpaceXAI)", "xAI Grok coding agent", "agent_cli",
        ["grok", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="curl -fsSL https://x.ai/cli/install.sh | bash",
        needs_terminal=True, requires_binaries=("curl",), optional=True,
        docs_url="https://docs.x.ai/build/overview",
        # Windows: the official PowerShell installer, per
        # https://github.com/xai-org/grok-build (README) and
        # https://docs.x.ai/build/overview
        install_cmds={"win32": PlatformInstall(
            "irm https://x.ai/cli/install.ps1 | iex", needs_terminal=True)},
        update_cmd="grok update"),
)
