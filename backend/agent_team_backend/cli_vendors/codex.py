"""Codex CLI rollout log reader.

Format reference: docs/cli-log-formats.md (Codex section).

Files: ~/.codex/sessions/{Y}/{M}/{D}/rollout-{ts}-{uuid}.jsonl
       (`codex archive` moves a rollout to ~/.codex/archived_sessions/)
Event filter: type=event_msg, payload.type=token_count
Token fields are CUMULATIVE session totals — we compute delta against the
previous totals seen in the same file.

cwd: extracted from the session_meta event (type=session_meta, payload.cwd).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import asyncio
import base64
import os
import tempfile
import re
import shutil
import sqlite3
import threading
import time
import tomllib

import psutil

from .base import ExtensionsSource, ExtensionsSpec  # noqa: F401
from .base import AccountSwitchSpec, Dep, McpWiring, SkillsWiring, VendorRuntimeContext, VendorSpec, command_text
from ..applog import app_data_dir
from ..skills_store import SkillsStore
from . import _protocols
from ..usage_common import HTTP_TIMEOUT, _snapshot, parse_retry_after
from ..log_readers.base import (
    ActivityEvent,
    IncrementalParseResult,
    LogReader,
    TokenUsage,
    TurnCall,
    TurnUsage,
    activity_high_water,
    join_text_blocks,
    read_jsonl_tail,
    set_activity_high_water,
    turn_excerpt,
    user_prompt_text,
)

log = logging.getLogger("agent_team_backend.log_readers.codex")

# Sentinel prefix for storing the file's prior cumulative totals inside the
# per-file seen_keys set (avoids needing a separate state dict).
_CUM_PREFIX = "__cum__:"
# Prefix for stashing the last assistant text inside seen_keys, so a turn whose
# assistant message and task_complete boundary land in different poll batches
# still delivers the text on its turn_complete (Codex's per-turn boundary).
_TEXT_PREFIX = "__lasttext__:"


def _read_last_text(seen_keys: set[str]) -> str:
    for k in seen_keys:
        if k.startswith(_TEXT_PREFIX):
            return k[len(_TEXT_PREFIX):]
    return ""


def _write_last_text(seen_keys: set[str], text: str) -> None:
    for k in [k for k in seen_keys if k.startswith(_TEXT_PREFIX)]:
        seen_keys.discard(k)
    seen_keys.add(f"{_TEXT_PREFIX}{text}")


def _int(v) -> int:  # noqa: ANN001
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return 0


def _typed_prompt(payload: dict) -> str | None:
    """The user's typed prompt carried by an `event_msg` payload, or None when
    the record is not a user prompt at all.

    Two shapes, because Codex changed the rollout format: up to mid-2026 the
    prompt was its own `user_message` event with a `message` string; rollouts
    written since (codex-cli 0.155 observed) have no `user_message` record and
    instead complete the prompt as an `item_completed` whose `item.type` is
    `UserMessage`, with the text spread over `content` blocks of type `text`
    (images ride as `local_image` blocks with no text). An empty string means
    a prompt record with nothing typed in it.
    """
    ptype = payload.get("type")
    if ptype == "user_message":
        return str(payload.get("message") or "")
    if ptype != "item_completed":
        return None
    item = payload.get("item")
    if not isinstance(item, dict) or item.get("type") != "UserMessage":
        return None
    content = item.get("content")
    if not isinstance(content, list):
        return ""
    return "\n".join(
        str(block.get("text") or "")
        for block in content
        if isinstance(block, dict) and block.get("type") == "text"
    )


def _read_cumulative(seen_keys: set[str]) -> tuple[int, int]:
    """Return (prev_input, prev_output) from sentinel key, or (0, 0)."""
    for k in seen_keys:
        if k.startswith(_CUM_PREFIX):
            try:
                _, body = k.split(":", 1)
                parts = dict(p.split("=") for p in body.split(","))
                return int(parts.get("in", 0)), int(parts.get("out", 0))
            except (ValueError, KeyError):
                continue
    return 0, 0


def _write_cumulative(seen_keys: set[str], input_total: int, output_total: int) -> None:
    # Drop any prior sentinel, write new one.
    for k in [k for k in seen_keys if k.startswith(_CUM_PREFIX)]:
        seen_keys.discard(k)
    seen_keys.add(f"{_CUM_PREFIX}in={input_total},out={output_total}")


def _dedupe_resolved(roots: list[Path]) -> list[Path]:
    """Drop roots that resolve to a path an earlier root already covers.

    Pane homes made before 9ab9e87c mirror `sessions` as a symlink back to
    ~/.codex/sessions, so each of them re-listed the whole default tree (#121:
    39k rollouts x 27 homes ≈ 6 min per scan). Order is kept so the default
    root, listed first, is the spelling that survives.
    """
    out: list[Path] = []
    seen: set[Path] = set()
    for root in roots:
        try:
            key = root.resolve()
        except OSError:
            key = root
        if key in seen:
            continue
        seen.add(key)
        out.append(root)
    return out


class CodexLogReader(LogReader):
    vendor: str = "codex"

    #: turns_for_session cuts on the rollout's own user prompt records.
    turns_method: str = "exact"

    #: parse_activity walks a dense ascending line counter and resumes from
    #: one high-water mark, so an old file can be seeded to EOF by counting
    #: lines rather than replaying it (log_readers.base).
    activity_resumes_by_line: bool = True

    #: One filesystem sweep serves every workspace in a rescan cycle. The
    #: watcher calls session_files_for_workspace once per open workspace, so
    #: without this the sessions trees are re-walked N times per cycle — on a
    #: cold page cache that stalls the event loop for seconds per walk. Kept
    #: well under the watcher's rescan interval; a rollout created inside the
    #: window is picked up by the fs watcher, not this backfill enumeration.
    _SESSION_FILES_TTL_S = 5.0

    #: A rollout's session_meta is its FIRST record, written at creation. A
    #: file this much older than its last write and still headerless will
    #: never grow one (rollouts only append), so the miss is cached instead
    #: of re-opening the file on every rescan of every workspace forever.
    #: Fresh files stay uncached: their header may simply not have landed.
    _HEADER_GRACE_S = 60.0

    def __init__(self) -> None:
        # path -> cwd from the rollout's session_meta header. The header is
        # immutable once written, so each file is opened at most once — an
        # entry is stored once the meta record was read, or as "" once the
        # file aged past _HEADER_GRACE_S without one; a rollout whose header
        # has not landed yet is retried next pass.
        self._cwd_cache: dict[str, str] = {}
        #: Same header read, same lifetime: whether the rollout is a sub-agent's.
        self._subagent_cache: dict[str, bool] = {}
        self._files_cache: list[Path] = []
        self._files_cached_at: float = float("-inf")
        # Discovery runs concurrently from the rescan worker thread and the
        # executor threads behind register_pane/force_rescan. The lock keeps
        # the TTL coherent so overlapping callers share one tree walk instead
        # of each paying a cold rglob.
        self._discovery_lock = threading.Lock()

    def project_dirs(self) -> list[Path]:
        roots: list[Path] = []
        default_root = Path.home() / ".codex" / "sessions"
        if default_root.is_dir():
            roots.append(default_root)
        panes_root = Path.home() / ".codex-panes"
        if panes_root.is_dir():
            try:
                roots.extend(
                    p / "sessions"
                    for p in panes_root.iterdir()
                    if (p / "sessions").is_dir()
                )
            except OSError as err:
                log.debug("enumerate %s failed: %s", panes_root, err)
        return _dedupe_resolved(roots)

    def watch_dirs(self) -> list[Path]:
        roots: list[Path] = []
        default_root = Path.home() / ".codex" / "sessions"
        if default_root.is_dir():
            roots.append(default_root)
        panes_root = Path.home() / ".codex-panes"
        if panes_root.is_dir():
            roots.append(panes_root)
        return _dedupe_resolved(roots)

    def session_files(self) -> list[Path]:
        with self._discovery_lock:
            now = time.monotonic()
            if now - self._files_cached_at <= self._SESSION_FILES_TTL_S:
                return list(self._files_cache)
            out: list[Path] = []
            for root in self.project_dirs():
                try:
                    for f in root.rglob("rollout-*.jsonl"):
                        if f.is_file():
                            out.append(f)
                except OSError as err:
                    log.debug("rglob %s failed: %s", root, err)
            self._files_cache = out
            self._files_cached_at = now
            # Deleted/archived rollouts must not pin their header entries forever.
            existing = {str(p) for p in out}
            for k in list(self._cwd_cache):
                if k not in existing:
                    del self._cwd_cache[k]
            for k in list(self._subagent_cache):
                if k not in existing:
                    del self._subagent_cache[k]
            return list(out)

    def _cwd_from_meta(self, path: Path) -> str:
        """Read just the session_meta header for this rollout's cwd.

        Codex stores sessions by date, not cwd, but every file opens with a
        `session_meta` record carrying payload.cwd. We read only the first few
        lines (not the whole rollout) so per-workspace scoping stays cheap.
        """
        key = str(path)
        with self._discovery_lock:
            cached = self._cwd_cache.get(key)
            if cached is not None:
                return cached
            try:
                with path.open("r", encoding="utf-8", errors="replace") as fh:
                    for _ in range(5):  # session_meta is the first record
                        line = fh.readline()
                        if not line:
                            break
                        try:
                            rec = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if rec.get("type") == "session_meta":
                            payload = rec.get("payload") or {}
                            cwd = str(payload.get("cwd") or "") if isinstance(payload, dict) else ""
                            self._cwd_cache[key] = cwd
                            self._subagent_cache[key] = isinstance(
                                payload, dict
                            ) and is_subagent_session_meta(payload)
                            return cwd
            except OSError:
                return ""
            # No header in the first records. Once the file is old enough
            # that the header must have landed if it ever will, cache the
            # miss — otherwise this rollout is re-opened by every rescan of
            # every workspace for as long as it exists.
            try:
                if time.time() - path.stat().st_mtime >= self._HEADER_GRACE_S:
                    self._cwd_cache[key] = ""
            except OSError:
                pass
            return ""

    def _is_subagent_rollout(self, path: Path) -> bool:
        """Whether *path* is a sub-agent's rollout, from its own (first)
        session_meta; read once with the cwd header (see _cwd_from_meta)."""
        self._cwd_from_meta(path)
        with self._discovery_lock:
            return self._subagent_cache.get(str(path), False)

    def session_files_for_workspace(self, workspace_path: str) -> list[Path]:
        """Only rollouts whose session_meta.cwd matches this workspace.

        Reading each file's header to filter is far cheaper than parsing every
        full rollout, and keeps a per-workspace rescan from touching unrelated
        sessions.
        """
        return [
            p for p in self.session_files()
            if self._cwd_from_meta(p) == workspace_path
        ]

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        try:
            fh = path.open(encoding="utf-8")
        except OSError as err:
            log.debug("open %s failed: %s", path, err)
            return []

        prev_in, prev_out = _read_cumulative(seen_keys)
        latest_in, latest_out = prev_in, prev_out
        latest_event: dict | None = None
        cwd = ""
        model = ""
        cli_version = ""
        session_id = path.stem

        with fh:
            for line_no, raw in enumerate(fh, 1):
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    rec = json.loads(raw)
                except json.JSONDecodeError:
                    log.debug("%s:%d malformed JSON, skipping", path.name, line_no)
                    continue

                # Pick up cwd / model from session_meta if present
                if rec.get("type") == "session_meta":
                    payload = rec.get("payload") or {}
                    if isinstance(payload, dict):
                        cwd = str(payload.get("cwd") or cwd)
                        model = str(payload.get("model_provider") or payload.get("model") or model)
                        cli_version = str(payload.get("cli_version") or cli_version)
                    continue

                # Token count events are the only ones we care about
                if rec.get("type") != "event_msg":
                    continue
                payload = rec.get("payload") or {}
                if not isinstance(payload, dict) or payload.get("type") != "token_count":
                    continue
                info = payload.get("info")
                if not isinstance(info, dict):
                    continue
                totals = info.get("total_token_usage")
                if not isinstance(totals, dict):
                    continue

                cur_in = _int(totals.get("input_tokens")) + _int(totals.get("cached_input_tokens"))
                cur_out = _int(totals.get("output_tokens")) + _int(totals.get("reasoning_output_tokens"))
                # Accept any monotonically non-decreasing pair; if values shrink
                # the user likely rotated session — reset baseline silently.
                if cur_in < latest_in or cur_out < latest_out:
                    latest_in = cur_in
                    latest_out = cur_out
                    latest_event = rec
                    continue
                latest_in = cur_in
                latest_out = cur_out
                latest_event = rec

        if latest_event is None:
            return []

        delta_in = latest_in - prev_in
        delta_out = latest_out - prev_out
        # Detect session rotation: the totals shrank. Reset baseline to the
        # smaller value WITHOUT emitting (or we'd emit a negative delta).
        if delta_in < 0 or delta_out < 0:
            _write_cumulative(seen_keys, latest_in, latest_out)
            return []
        if delta_in == 0 and delta_out == 0:
            return []

        # Persist new baseline for the next call
        _write_cumulative(seen_keys, latest_in, latest_out)

        return [
            TokenUsage(
                vendor="codex",
                input_tokens=max(0, delta_in),
                output_tokens=max(0, delta_out),
                cwd=cwd,
                session_id=session_id,
                file_path=str(path),
                dedup_key=f"codex_cumulative::{session_id}::{latest_in}::{latest_out}",
                timestamp=str(latest_event.get("timestamp") or ""),
                model=model,
                cli_version=cli_version,
            )
        ]

    def parse_incremental(
        self,
        path: Path,
        checkpoint: dict,
    ) -> IncrementalParseResult:
        """Read only the rollout tail while persisting cumulative baselines."""
        records, next_checkpoint, rotated = read_jsonl_tail(path, checkpoint)
        replaced = bool(
            rotated
            and checkpoint.get("identity")
            and checkpoint.get("identity") != next_checkpoint.get("identity")
        )
        prev_in = 0 if replaced else max(0, int(checkpoint.get("input_total") or 0))
        prev_out = 0 if replaced else max(0, int(checkpoint.get("output_total") or 0))
        latest_in, latest_out = prev_in, prev_out
        cwd = "" if replaced else str(checkpoint.get("cwd") or "")
        model = "" if replaced else str(checkpoint.get("model") or "")
        cli_version = "" if replaced else str(checkpoint.get("cli_version") or "")
        session_id = path.stem if replaced else str(checkpoint.get("session_id") or path.stem)
        # The rollout's own id is its FIRST session_meta: a sub-agent's rollout
        # replays its ancestors' records after it, and taking the last one
        # filed the sub-agent's tokens under its parent's session.
        meta_seen = False if replaced else bool(checkpoint.get("meta_seen"))
        latest_event: dict | None = None
        latest_end = int(next_checkpoint.get("offset") or 0)

        for end, rec in records:
            if rec is None:
                continue
            if rec.get("type") == "session_meta":
                payload = rec.get("payload") or {}
                if isinstance(payload, dict) and not meta_seen:
                    meta_seen = True
                    cwd = str(payload.get("cwd") or cwd)
                    session_id = str(payload.get("id") or session_id)
                    model = str(payload.get("model_provider") or payload.get("model") or model)
                    cli_version = str(payload.get("cli_version") or cli_version)
                continue
            if rec.get("type") != "event_msg":
                continue
            payload = rec.get("payload") or {}
            if not isinstance(payload, dict) or payload.get("type") != "token_count":
                continue
            info = payload.get("info")
            totals = info.get("total_token_usage") if isinstance(info, dict) else None
            if not isinstance(totals, dict):
                continue
            latest_in = _int(totals.get("input_tokens")) + _int(totals.get("cached_input_tokens"))
            latest_out = _int(totals.get("output_tokens")) + _int(totals.get("reasoning_output_tokens"))
            latest_event = rec
            latest_end = end

        next_checkpoint.update({
            "input_total": latest_in,
            "output_total": latest_out,
            "cwd": cwd,
            "model": model,
            "session_id": session_id,
            "cli_version": cli_version,
            "meta_seen": meta_seen,
        })
        if latest_event is None:
            return IncrementalParseResult([], next_checkpoint)

        delta_in = latest_in - prev_in
        delta_out = latest_out - prev_out
        if delta_in < 0 or delta_out < 0 or (delta_in == 0 and delta_out == 0):
            return IncrementalParseResult([], next_checkpoint)

        event_checkpoint = dict(next_checkpoint)
        event_checkpoint["offset"] = latest_end
        event = TokenUsage(
            vendor="codex",
            input_tokens=delta_in,
            output_tokens=delta_out,
            cwd=cwd,
            session_id=session_id,
            file_path=str(path),
            dedup_key=f"codex_cumulative::{session_id}::{latest_in}::{latest_out}",
            timestamp=str(latest_event.get("timestamp") or ""),
            model=model,
            checkpoint=event_checkpoint,
            cli_version=cli_version,
        )
        return IncrementalParseResult([event], next_checkpoint)

    def turns_for_session(self, path: Path, session_id: str = "") -> list[TurnUsage]:
        """A turn opens at each user prompt record (see _typed_prompt); every `token_count`
        inside it is one model call, measured as the delta of the cumulative
        `total_token_usage` against the previous one (the same counters
        parse_session_file differences, kept apart instead of folded). A
        rollout with no prompt record at all falls back to one turn
        per token_count.

        Codex's input_tokens already contains cached_input_tokens and its
        output_tokens already contains reasoning_output_tokens (its
        total_tokens is input + output), so input here is the uncached
        remainder, output is taken as is, and the turn total equals the
        CLI's own total_tokens.
        """
        try:
            fh = path.open(encoding="utf-8")
        except OSError as err:
            log.debug("open %s failed: %s", path, err)
            return []
        sid = path.stem
        meta_seen = False
        model = ""
        cli_version = ""
        prev = (0, 0, 0)
        turns: list[TurnUsage] = []
        current: TurnUsage | None = None
        saw_prompt = False
        with fh:
            for line_no, raw in enumerate(fh, 1):
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    rec = json.loads(raw)
                except json.JSONDecodeError:
                    log.debug("%s:%d malformed JSON, skipping", path.name, line_no)
                    continue
                payload = rec.get("payload") or {}
                if not isinstance(payload, dict):
                    continue
                if rec.get("type") == "session_meta":
                    # The first one is this rollout's own (see parse_incremental).
                    if not meta_seen:
                        meta_seen = True
                        sid = str(payload.get("id") or sid)
                        model = str(payload.get("model_provider") or payload.get("model") or model)
                        cli_version = str(payload.get("cli_version") or cli_version)
                    continue
                if rec.get("type") != "event_msg":
                    continue
                ts = str(rec.get("timestamp") or "") or None
                ptype = payload.get("type")
                prompt = _typed_prompt(payload)
                if prompt is not None:
                    saw_prompt = True
                    current = TurnUsage(
                        turn_index=0, session_id=sid, started_at=ts, ended_at=None,
                        prompt_excerpt=turn_excerpt(prompt),
                    )
                    turns.append(current)
                    continue
                if ptype != "token_count":
                    continue
                info = payload.get("info")
                totals = info.get("total_token_usage") if isinstance(info, dict) else None
                if not isinstance(totals, dict):
                    continue
                cur = (
                    _int(totals.get("input_tokens")),
                    _int(totals.get("cached_input_tokens")),
                    _int(totals.get("output_tokens")),
                )
                delta = tuple(c - p for c, p in zip(cur, prev))
                prev = cur
                if any(d < 0 for d in delta):
                    continue  # totals shrank: rotated session, new baseline
                if not any(delta):
                    continue
                if current is None or not saw_prompt:
                    current = TurnUsage(
                        turn_index=0, session_id=sid, started_at=ts, ended_at=None,
                        prompt_excerpt="",
                    )
                    turns.append(current)
                current.add_call(TurnCall(
                    ts=ts, model=model,
                    input=max(0, delta[0] - delta[1]), cache_read=delta[1],
                    cache_creation=0, output=delta[2], cli_version=cli_version,
                ))
                current.ended_at = ts or current.ended_at
        # Either id names this rollout: the session_meta id (what the token
        # sink and the live registry carry) or the file stem (what
        # session_id_from_path answers and a bare tokens.turns lookup uses).
        if session_id and session_id not in (sid, path.stem):
            return []
        out = [t for t in turns if t.calls]
        for n, turn in enumerate(out, 1):
            turn.turn_index = n
        return out

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Emit `agent_active` for assistant + event_msg lines.

        `task_complete` (and `turn_aborted`) is the turn end; `token_count`
        is per model call and is only counted, never used as a boundary.

        A sub-agent's rollout sits in its parent pane's CODEX_HOME and is read
        as that pane's, but its turns are not the pane's: its task_complete
        landed inside the parent's turn and freed the pane early, with the
        sub-agent's text as the pane's reply. It emits only
        `subagent_turn_end` at each of its turn ends, which keeps the
        per-account turn count exactly as before and nothing else.
        """
        out: list[ActivityEvent] = []
        session_id = path.stem
        subagent = self._is_subagent_rollout(path)
        # The session_meta header sits below the high-water mark on every poll
        # after the first, so seed cwd from it rather than from this batch.
        cwd = self._cwd_from_meta(path)
        # Latest assistant text for this turn. Persisted in seen_keys (per-file,
        # owned by the watcher) so a turn whose assistant message and its
        # token_count boundary land in DIFFERENT poll batches still delivers the
        # text on turn_complete — a scan-local variable would reset to "".
        last_text = _read_last_text(seen_keys)
        text_changed = False
        try:
            fh = path.open(encoding="utf-8")
        except OSError:
            return out

        # Every rtype branch below — including the malformed-JSON one and the
        # `else` catch-all — used to mark its line seen, and the walk is a
        # dense ascending scan from line 1, so one high-water mark says exactly
        # what the per-line keys said without growing with the rollout. See
        # log_readers.base.
        high_water = activity_high_water(seen_keys)
        last_line = high_water
        # Below the mark, the header was read on an earlier poll.
        header_seen = high_water > 0

        try:
            with fh:
                for line_no, raw_line in enumerate(fh, 1):
                    raw = raw_line.strip()
                    if not raw:
                        continue
                    if line_no <= high_water:
                        continue
                    key = f"act:{line_no}"
                    try:
                        rec = json.loads(raw)
                    except json.JSONDecodeError:
                        # An unterminated final line is still being written.
                        # Leave the mark behind it so the completed line is
                        # read on the next poll: advancing past it dropped
                        # that line's events for good, and when the lost line
                        # was the turn's end record the pane stayed
                        # "mid-turn" forever (GitHub #21).
                        if not raw_line.endswith("\n"):
                            break
                        # A terminated line that will not parse is genuinely
                        # corrupt. Step over it for good rather than
                        # re-reading — and re-emitting — the rest of the file
                        # on every poll.
                        last_line = line_no
                        continue
                    last_line = line_no

                    rtype = rec.get("type")
                    if rtype == "session_meta":
                        payload = rec.get("payload") or {}
                        if isinstance(payload, dict):
                            cwd = str(payload.get("cwd") or cwd)
                            # The file's own header is the first session_meta (a
                            # sub-agent replays its parent's after it). When this
                            # batch holds it, it decides: the header read above
                            # can run before the header landed and say "not a
                            # sub-agent", and this batch then went past the
                            # high-water mark as the parent's turn.
                            if not header_seen:
                                header_seen = True
                                subagent = subagent or is_subagent_session_meta(payload)
                        continue

                    ts = str(rec.get("timestamp") or "")
                    if subagent:
                        payload = rec.get("payload") or {}
                        ptype = str(payload.get("type") or "") if isinstance(payload, dict) else ""
                        if rtype == "event_msg" and ptype in ("task_complete", "turn_aborted"):
                            out.append(ActivityEvent(
                                vendor="codex", event_type="subagent_turn_end",
                                cwd=cwd, session_id=session_id, file_path=str(path),
                                dedup_key=f"turn:{line_no}", timestamp=ts, detail=ptype,
                            ))
                        continue
                    if rtype == "assistant":
                        out.append(ActivityEvent(
                            vendor="codex", event_type="agent_active",
                            cwd=cwd, session_id=session_id, file_path=str(path),
                            dedup_key=key, timestamp=ts, detail="assistant",
                        ))
                    elif rtype == "response_item":
                        payload = rec.get("payload") or {}
                        if (
                            isinstance(payload, dict)
                            and payload.get("role") == "assistant"
                            and payload.get("type") == "message"
                        ):
                            text = join_text_blocks(payload.get("content"), "output_text")
                            if text:
                                last_text = text
                                text_changed = True
                    elif rtype == "event_msg":
                        payload = rec.get("payload") or {}
                        ptype = str(payload.get("type") or "") if isinstance(payload, dict) else ""
                        if ptype == "agent_message":
                            msg_text = str(payload.get("message") or "")
                            if msg_text:
                                last_text = msg_text
                                text_changed = True
                        # Turn text rides only on turn_complete (the event the
                        # frontend judges). The one exception: the user's typed
                        # prompt rides on its own agent_active event so the
                        # frontend can name the pane from the first user text.
                        # Both rollout shapes (see _typed_prompt) surface as
                        # detail "user_message" — the frontend keys on it.
                        # "<...>"-wrapped records are injected instruction/context
                        # stubs, not typed prompts.
                        text = ""
                        detail = ptype
                        prompt = _typed_prompt(payload)
                        if prompt is not None:
                            detail = "user_message"
                            text = user_prompt_text(prompt)
                        out.append(ActivityEvent(
                            vendor="codex", event_type="agent_active",
                            cwd=cwd, session_id=session_id, file_path=str(path),
                            dedup_key=key, timestamp=ts, detail=detail, text=text,
                        ))
                        # task_complete is the turn's real end. token_count is
                        # NOT: it fires once per model call, i.e. after every
                        # tool call inside a turn, so ending the turn there
                        # fired "done" mid-turn. turn_aborted (Esc) ends the
                        # turn too, with nothing completed to judge.
                        if ptype in ("task_complete", "turn_aborted"):
                            text = ""
                            if ptype == "task_complete":
                                text = last_text or str(payload.get("last_agent_message") or "")
                            out.append(ActivityEvent(
                                vendor="codex", event_type="turn_complete",
                                cwd=cwd, session_id=session_id, file_path=str(path),
                                dedup_key=f"turn:{line_no}", timestamp=ts,
                                detail=ptype, text=text,
                            ))
                            # Turn consumed the text; reset so the next turn's
                            # empty-text boundary can't reuse it.
                            last_text = ""
                            text_changed = True
        finally:
            set_activity_high_water(seen_keys, last_line)
            if text_changed:
                _write_last_text(seen_keys, last_text)
        return out


# ---- per-pane CODEX_HOME management (merged from codex_home.py) ------------

_SAFE_HOME_ID = re.compile(r"^[A-Za-z0-9_.:-]+$")
# Home ids Navide itself generates: a pane's crypto.randomUUID(), or a plugin
# window's `<8 hex>-<surface>-ai-terminal` (aiTerminalPaneId). Reclaim only
# touches these — anything else under ~/.codex-panes was put there by hand.
_NAVIDE_HOME_ID = re.compile(
    r"^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    r"|[0-9a-f]{8}-[a-z]+-ai-terminal)$"
)

# CODEX_HOME *routing* lookup only: which home physically holds a rollout.
# `sessions` is nested {Y}/{M}/{D}; `codex archive` moves a rollout into the
# flat `archived_sessions` instead. Do NOT reuse this for watcher roots or for
# `_pane_id_from_home_path` — that helper hardcodes `parts[1] == "sessions"`,
# so an archived path would silently attribute to no pane (empty pane id).
# Resumability is a separate question: see `find_resumable_session_home`.
_SESSION_SUBDIRS = ("sessions", "archived_sessions")
# Sub-agent nesting seen in the wild is depth 3; the cap only stops a
# corrupted parent chain from looping.
_MAX_THREAD_HOPS = 8
# Same budget the attribution layer reads session files with.
_META_READ_BYTES = 524_288
# Runtime locations from Codex 0.155.1. Keep config resources (including
# relative paths in named profiles) visible without sharing session storage.
_HOME_RUNTIME_ENTRIES = frozenset({
    *_SESSION_SUBDIRS, "session_index.jsonl", "history.jsonl", "shell_snapshots",
    "thread-writer-locks", "log", "tmp", "app-server-control", "app-server-daemon",
})
_HOME_RUNTIME_DATABASE = re.compile(
    r"(?:state|logs|goals|memories(?:_v2)?|queue|thread_history)_\d+\.sqlite"
    r"(?:-(?:wal|shm|journal))?"
)


#: Per pane home: the config.toml trust rows Navide seeded for it, so a
#: removal check never counts a row Navide did not write.
_SEEDED_TRUST_FILE = ".navide-hook-trust.json"


class CodexHomeManager:
    """Create isolated CODEX_HOME dirs while sharing stable user config."""

    def __init__(
        self,
        *,
        real_home: Path | None = None,
        panes_root: Path | None = None,
        managed_skills_root: Path | None = None,
    ) -> None:
        self.real_home = real_home or (Path.home() / ".codex")
        self.panes_root = panes_root or (Path.home() / ".codex-panes")
        self.managed_skills_root = managed_skills_root or (app_data_dir() / "runtime" / "skills")
        self._refresh_managed_skills = managed_skills_root is None

    def prepare(self, home_id: str, *, source_home: Path | None = None) -> Path:
        """Create the per-pane home, symlinking shared entries from
        ``source_home`` (a CLI account profile home) or the real ~/.codex."""
        source = source_home or self.real_home
        if source_home is None:
            # A prior in-pane login may sit stranded in another pane's home
            # (fresh install: no real auth.json existed to symlink at that
            # pane's spawn). Adopt it first so this pane seeds logged-in.
            self.promote_stranded_auth()
        safe_id = self._safe_home_id(home_id)
        pane_home = self.panes_root / safe_id
        pane_home.mkdir(parents=True, exist_ok=True)
        from ..convenience_wiring import note

        note("codex.pane-homes", self.panes_root, detail="per-pane CODEX_HOME directories")
        self._share_config_entries(pane_home, source)
        self._prepare_skills_view(pane_home, source / "skills")
        return pane_home

    def _share_config_entries(self, pane_home: Path, source: Path) -> None:
        if not source.is_dir():
            return
        for src in source.iterdir():
            if (
                src.name in _HOME_RUNTIME_ENTRIES
                or _HOME_RUNTIME_DATABASE.fullmatch(src.name)
                or src.name == "skills" or src.name.startswith(".navide-skills")
            ):
                continue
            dst = pane_home / src.name
            if not src.exists() or dst.exists() or dst.is_symlink():
                continue
            try:
                dst.symlink_to(src, target_is_directory=src.is_dir())
            except OSError as err:
                log.warning("codex home symlink %s -> %s failed: %s", dst, src, err)

    def _prepare_skills_view(self, pane_home: Path, native_root: Path) -> None:
        """Expose native and enabled managed skills under ``CODEX_HOME/skills``.

        The generated view is rebuilt on every prepare so disabled managed
        skills disappear on the next spawn. Native entries are linked first;
        a managed skill with the same name is skipped. Every failure is logged
        and contained so optional skill wiring can never block a pane spawn.
        """
        view = pane_home / ".navide-skills"
        skills_link = pane_home / "skills"
        tmp: Path | None = None
        backup = pane_home / ".navide-skills.old"
        try:
            managed_root = self.managed_skills_root
            if self._refresh_managed_skills:
                try:
                    managed_root = SkillsStore().rebuild_runtime_projection()
                except Exception as err:  # noqa: BLE001 - optional wiring cannot block spawn
                    log.warning("refreshing managed Skills projection failed: %s", err)
                    managed_root = pane_home / ".navide-skills-unavailable"
            tmp = Path(tempfile.mkdtemp(prefix=".navide-skills-", dir=pane_home))
            native_entries = (
                sorted(native_root.iterdir(), key=lambda path: path.name)
                if native_root.is_dir()
                else []
            )
            native_names = {
                entry.name
                for entry in native_entries
                if entry.is_dir() or entry.is_file() or entry.is_symlink()
            }
            for entry in native_entries:
                if entry.is_dir():
                    (tmp / entry.name).symlink_to(entry, target_is_directory=True)
            if managed_root.is_dir():
                for entry in sorted(managed_root.iterdir(), key=lambda path: path.name):
                    if not entry.is_dir() or entry.name in native_names:
                        continue
                    (tmp / entry.name).symlink_to(entry, target_is_directory=True)

            if backup.exists() or backup.is_symlink():
                self._remove_generated_path(backup)
            if view.exists() or view.is_symlink():
                os.replace(view, backup)
            os.replace(tmp, view)
            tmp = None

            if skills_link.is_symlink():
                # Imported here: credential_vault imports the vendor registry.
                from ..credential_vault import _link_target

                if _link_target(os.readlink(skills_link)) != os.fspath(view):
                    skills_link.unlink()
            elif skills_link.exists():
                log.warning("leaving real Codex skills directory unmodified: %s", skills_link)
                return
            if not skills_link.is_symlink():
                skills_link.symlink_to(view, target_is_directory=True)
            if backup.exists() or backup.is_symlink():
                self._remove_generated_path(backup)
        except OSError as err:
            log.warning("codex managed-skills view failed for %s: %s", pane_home, err)
            if not view.exists() and backup.exists():
                try:
                    os.replace(backup, view)
                except OSError:
                    pass
            if not skills_link.exists() and not skills_link.is_symlink() and native_root.is_dir():
                try:
                    skills_link.symlink_to(native_root, target_is_directory=True)
                except OSError:
                    pass
        finally:
            if tmp is not None:
                self._remove_generated_path(tmp)

    def promote_stranded_auth(self) -> bool:
        """Adopt an in-pane Codex login as the shared credential.

        On a fresh install the real ~/.codex/auth.json does not exist when a
        pane home is prepared, so prepare() seeds no auth.json symlink; an
        OAuth login completed INSIDE that pane then writes a real auth.json
        into the per-pane home — invisible to every other pane and to usage
        polling. While the real file is still absent, promote the newest such
        stranded credential: hard-link it into the real home (atomic; a
        concurrent writer beating us simply wins) and swap the pane's copy
        for the standard symlink so codex token refreshes write through to
        the shared file. Returns True when the real home gained the
        credential.

        Through the convenience gate this happens once. A shared login that
        existed and is gone was signed out outside Navide: the user gets a
        prompt, and no pane login — least of all an older or different
        account — takes its place."""
        real_auth = self.real_home / "auth.json"
        from ..convenience_wiring import gate

        convenience = gate()
        try:
            if convenience is not None and not convenience.allowed("codex.login-promote"):
                return False
        except Exception as err:  # noqa: BLE001 — an unread ledger never promotes
            log.warning("codex login promotion skipped: the convenience ledger failed: %s", err)
            return False
        try:
            if real_auth.exists() or real_auth.is_symlink():
                return False
            if not self.panes_root.is_dir():
                return False
            if convenience is not None and self._prompted_for_outside_logout(convenience, real_auth):
                return False
            stranded = [
                p for p in self.panes_root.glob("*/auth.json")
                if p.is_file() and not p.is_symlink()
            ]
            if not stranded:
                return False
            newest = max(stranded, key=lambda p: p.stat().st_mtime)
            self.real_home.mkdir(parents=True, exist_ok=True)
            try:
                os.link(newest, real_auth)
            except FileExistsError:
                return False
        except OSError as err:
            log.warning("promoting in-pane codex login failed: %s", err)
            return False
        try:
            tmp = newest.with_name(".auth.json.promote-tmp")
            tmp.unlink(missing_ok=True)
            tmp.symlink_to(real_auth)
            os.replace(tmp, newest)
        except OSError as err:
            # Promotion itself succeeded; the pane keeps its own copy and
            # will diverge on refresh until its next prepare() re-links it.
            log.warning("relinking %s to shared codex auth failed: %s", newest, err)
        log.info("promoted in-pane codex login %s -> %s", newest, real_auth)
        if convenience is not None:
            try:
                convenience.note("codex.login-promote", real_auth, detail=f"from {newest.parent.name}")
            except Exception as err:  # noqa: BLE001 — the promotion stands
                log.warning("announcing the codex login promotion failed: %s", err)
        return True

    def _prompted_for_outside_logout(self, convenience: Any, real_auth: Path) -> bool:
        """Whether the shared login was signed out outside Navide, which is
        told (once) instead of promoting a pane login. True as well when the
        ledger cannot be read: no promotion then, a spawn or a quota poll
        never fails on it."""
        try:
            if not self._shared_login_existed(convenience, real_auth):
                return False
            latest = convenience.history("codex.login-promote", limit=1)
            if not latest or latest[0]["action"] != "prompt":
                convenience.record(
                    "codex.login-promote", "prompt", str(real_auth),
                    detail=json.dumps({"agentKey": "codex", "reason": "logout"}),
                )
        except Exception as err:  # noqa: BLE001
            log.warning("codex login promotion skipped: the convenience ledger failed: %s", err)
        return True

    def _shared_login_existed(self, convenience: Any, real_auth: Path) -> bool:
        """Whether the real auth.json was there before: Navide promoted it (the
        ledger), or a pane home still links to it."""
        if any(t["path"] == str(real_auth) for t in convenience.listing_feature("codex.login-promote")["targets"]):
            return True
        from ..credential_vault import _link_target

        for link in self.panes_root.glob("*/auth.json"):
            try:
                # Windows reads a link back as an extended-length path.
                if link.is_symlink() and Path(_link_target(os.readlink(link))) == real_auth:
                    return True
            except OSError:
                continue
        return False

    @staticmethod
    def _remove_generated_path(path: Path) -> None:
        if path.is_symlink() or path.is_file():
            path.unlink(missing_ok=True)
        elif path.exists():
            shutil.rmtree(path)

    def seed_hook_trust(self, pane_home: Path) -> int:
        """Carry the user's hooks.json trust over to a per-pane CODEX_HOME.

        Codex (>= 0.15x) keys hook trust in the shared config.toml by the
        *path* of the hooks.json that defines the hook —
        ``[hooks.state."<CODEX_HOME>/hooks.json:<event>:<i>:<j>"]`` — with a
        content hash as the value. A pane home mirrors ``~/.codex/hooks.json``
        under its own path, so the same file lands under a key the user never
        trusted and every spawn (resume included) stops at "Hooks need review".
        Copy the real-home entries under the pane-home key; the hash is
        content-only, so it stays valid. Only hooks the user already trusted
        are seeded, and only when the pane file is byte-identical. Returns
        the number of entries appended.
        """
        config = self.real_home / "config.toml"
        trust = self._pane_hook_trust(pane_home)
        additions = [
            f'[hooks.state."{_toml_escape(key)}"]\ntrusted_hash = "{_toml_escape(hashed)}"\n'
            for key, hashed in trust.items()
        ]
        seeded = list(trust)
        if not additions:
            return 0
        try:
            lead = "" if config.read_text(encoding="utf-8").endswith("\n") else "\n"
            with config.open("a", encoding="utf-8") as f:
                f.write(lead + "\n" + "\n".join(additions))
        except OSError as err:
            log.warning("seeding codex hook trust for %s failed: %s", pane_home, err)
            return 0
        self._remember_seeded_trust(pane_home, seeded)
        return len(additions)

    def hook_trust_override(self, pane_home: Path) -> str:
        """The rows `seed_hook_trust` would write, as one ``-c`` value instead.

        Phase 3: ``hooks.state={"<pane key>"={trusted_hash="<hash>"}, ...}``
        given on the command line merges with the rows persisted in
        config.toml (codex 0.160), so the pane starts trusted and the user's
        file is never written. Only the inline-table form does; the dotted
        ``hooks.state."<key>".trusted_hash=`` is ignored. '' when there is
        nothing to carry.
        """
        rows = [
            f"{_toml_inline_key(key)}={{trusted_hash={_toml_inline_key(hashed)}}}"
            for key, hashed in self._pane_hook_trust(pane_home).items()
        ]
        return "hooks.state={" + ",".join(rows) + "}" if rows else ""

    def _pane_hook_trust(self, pane_home: Path) -> dict[str, str]:
        """The user's trusted rows for the real hooks.json, re-keyed on the
        pane home's mirror of it: only when the pane file is byte-identical,
        and never a row config.toml already holds for that key."""
        pane_hooks = pane_home / "hooks.json"
        real_hooks = self.real_home / "hooks.json"
        try:
            if not (pane_hooks.is_file() and real_hooks.is_file()):
                return {}
            if pane_hooks.read_bytes() != real_hooks.read_bytes():
                return {}
            rows = _hook_state_rows((self.real_home / "config.toml").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        real_prefix = f"{real_hooks}:"
        pane_prefix = f"{pane_hooks}:"
        trust: dict[str, str] = {}
        for key, hashed in rows.items():
            if hashed is None or not key.startswith(real_prefix):
                continue
            new_key = pane_prefix + key[len(real_prefix):]
            if new_key not in rows:
                trust[new_key] = hashed
        return trust

    @staticmethod
    def _seeded_trust(pane_home: Path) -> list[str]:
        """The trust rows `seed_hook_trust` wrote for this home; [] if unknown."""
        try:
            keys = json.loads((pane_home / _SEEDED_TRUST_FILE).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        return [k for k in keys if isinstance(k, str)] if isinstance(keys, list) else []

    def _remember_seeded_trust(self, pane_home: Path, keys: list[str]) -> None:
        known = self._seeded_trust(pane_home)
        merged = known + [k for k in keys if k not in known]
        try:
            (pane_home / _SEEDED_TRUST_FILE).write_text(json.dumps(merged), encoding="utf-8")
        except OSError as err:
            log.warning("recording seeded codex hook trust for %s failed: %s", pane_home, err)

    def find_session_home(self, resume_id: str) -> Path | None:
        """Locate the CODEX_HOME that physically holds this session, if any.

        Routing only: `codex resume <id>` reads the home it was recorded under
        (rollout file + that home's own state db), so a resume must be spawned
        with that CODEX_HOME rather than a fresh per-pane one. Checks the real
        ~/.codex first (sessions predating per-pane homes), then every per-pane
        home (covers persisted home ids that drifted from the dir actually
        holding the session). Returns None when no home has it.

        Archived rollouts count here — `codex archive` only moves the file into
        archived_sessions/, and routing to the owning home is still the right
        env for an unarchive. It does NOT mean the session can be resumed: use
        `find_resumable_session_home` for that question.
        """
        return self._locate_session_home(resume_id, _SESSION_SUBDIRS)

    def find_resumable_session_home(self, resume_id: str) -> Path | None:
        """Like `find_session_home`, but only for sessions codex will resume.

        `sessions/` only: codex refuses to resume an archived thread — the
        0.147.0 binary carries "session <id> is archived. Run `codex unarchive
        <id>` to unarchive it first." (alongside "failed to locate archived
        thread id"). Treating an archived id as existing would pass preflight
        and launch a doomed `codex resume`.
        """
        return self._locate_session_home(resume_id, ("sessions",))

    def _locate_session_home(
        self, resume_id: str, subdirs: tuple[str, ...]
    ) -> Path | None:
        rid = resume_id.strip()
        if not _SAFE_HOME_ID.match(rid):
            return None
        pattern = f"rollout-*{rid}.jsonl"

        def holds_session(home: Path) -> bool:
            for name in subdirs:
                subdir = home / name
                if not subdir.is_dir():
                    continue
                if next(subdir.rglob(pattern), None) is not None:
                    return True
            return False

        try:
            if holds_session(self.real_home):
                return self.real_home
        except OSError:
            pass
        if self.panes_root.is_dir():
            try:
                for pane_home in sorted(self.panes_root.iterdir()):
                    if holds_session(pane_home):
                        self._share_config_entries(pane_home, self.real_home)
                        self._prepare_skills_view(pane_home, self.real_home / "skills")
                        return pane_home
            except OSError:
                pass
        return None

    def resolve_user_thread_id(self, resume_id: str) -> str:
        """Repair a resume id that names a SUB-AGENT thread.

        Builds shipped before sub-agent rollouts were recognised pinned
        whichever thread wrote last to a pane's CODEX_HOME, which is the
        sub-agent whenever codex spawned one. Resuming that id lands on a
        thread the parent owns and codex refuses the pane's input outright.
        The id the pane meant is the user thread the sub-agent descends from:
        take the ancestor session_meta the fork replayed into its own rollout,
        else hop to `parent_thread_id` and ask again (nesting is allowed).

        Returns `resume_id` unchanged for a normal thread, an unknown id, or a
        chain that cannot be resolved — the caller then resumes exactly what it
        was given, as it did before.
        """
        rid = resume_id.strip()
        seen: set[str] = set()
        for _ in range(_MAX_THREAD_HOPS):
            if not rid or rid in seen or not _SAFE_HOME_ID.match(rid):
                return resume_id
            seen.add(rid)
            rollout = self._rollout_path(rid)
            if rollout is None:
                return resume_id
            try:
                text = rollout.read_text(encoding="utf-8", errors="ignore")[:_META_READ_BYTES]
            except OSError:
                return resume_id
            metas = _session_meta_payloads(text)
            if not metas or not is_subagent_session_meta(metas[0]):
                return rid  # already a user thread
            ancestor = next(
                (str(m["id"]) for m in metas
                 if not is_subagent_session_meta(m) and m.get("id")),
                "",
            )
            if ancestor:
                return ancestor
            source = metas[0].get("source")
            subagent = source.get("subagent") if isinstance(source, dict) else None
            spawn = subagent.get("thread_spawn") if isinstance(subagent, dict) else None
            nested_parent = spawn.get("parent_thread_id") if isinstance(spawn, dict) else None
            rid = str(metas[0].get("parent_thread_id") or nested_parent or "")
        return resume_id

    def _rollout_path(self, resume_id: str) -> Path | None:
        """The rollout file recording this session, in whichever home holds it.
        Same search order as `_locate_session_home`, without its skills-view
        side effect — this runs while repairing an id, not while routing one."""
        pattern = f"rollout-*{resume_id}.jsonl"
        roots = [self.real_home]
        if self.panes_root.is_dir():
            try:
                roots.extend(sorted(self.panes_root.iterdir()))
            except OSError:
                pass
        for home in roots:
            for name in _SESSION_SUBDIRS:
                subdir = home / name
                if not subdir.is_dir():
                    continue
                try:
                    found = next(subdir.rglob(pattern), None)
                except OSError:
                    continue
                if found is not None:
                    return found
        return None

    def owns_session(self, pane_home: Path) -> bool:
        """True when a rollout can only be resumed through this home.

        `codex resume <id>` only works from the home that recorded the rollout
        (its file plus that home's own state db), so a home holding one must
        outlive its pane. Archived rollouts count too — `codex unarchive`
        needs the same home. Fails closed: a subdir that cannot be read is
        treated as owning a session.

        A symlinked `sessions` (a mirror back to ~/.codex/sessions) holds no
        file of its own, but codex 0.155 resolves a resume through the
        `rollout_path` in its state db — and a rollout written through the
        link was recorded under THIS home's path. Removing the home leaves
        that pointer dangling ("no rollout found for thread id") even though
        the file survives in the real home, so a mirrored home is owned by
        every thread the real home's state db still keys on it.
        """
        for name in _SESSION_SUBDIRS:
            subdir = pane_home / name
            if subdir.is_symlink():
                if self._state_db_references(pane_home):
                    return True
                continue
            if not subdir.is_dir():
                continue
            try:
                if next(subdir.rglob("rollout-*.jsonl"), None) is not None:
                    return True
            except OSError:
                return True
        return False

    def _state_db_references(self, pane_home: Path) -> bool:
        """True when the real home's state db keys a rollout on ``pane_home``.

        Fails closed: a db that exists but cannot be queried — a schema this
        code does not know included — counts as a reference. No db at all
        means codex never wrote there.
        """
        prefix = f"{pane_home}{os.sep}"
        if not self.real_home.is_dir():
            return False
        try:
            dbs = [
                p for p in self.real_home.iterdir()
                if p.name.startswith("state_") and p.suffix == ".sqlite"
            ]
        except OSError:
            return True
        for db in dbs:
            try:
                # A plain connection: read-only mode cannot create the -shm a
                # WAL database needs when its writer is not around. `_` in a
                # home path is a LIKE wildcard; a false match only keeps a home.
                conn = sqlite3.connect(db, timeout=5)
                try:
                    row = conn.execute(
                        "SELECT 1 FROM threads WHERE rollout_path LIKE ? LIMIT 1",
                        (prefix + "%",),
                    ).fetchone()
                finally:
                    conn.close()
            except sqlite3.Error as err:
                # Includes "no such table": codex renames its files and moves
                # tables across schema bumps (state_4 -> state_5,
                # thread_history split out), and a bump that moves `threads`
                # must not read as "nothing references this home".
                log.warning("cannot read codex state db %s: %s", db, err)
                return True
            if row is not None:
                return True
        return False

    def reclaim(self, home_id: str) -> bool:
        """Remove a pane home its pane no longer needs. Returns True on removal.

        Refuses anything that is not a Navide-shaped id, a home that still
        owns a session (see `owns_session`), and a home holding a real (not
        symlinked) auth.json — a fresh-install login that
        `promote_stranded_auth` has not adopted yet. A home that is itself a
        symlink is unlinked, never followed; nested symlinks (the shared
        config entries) are removed as links by rmtree.
        """
        safe_id = self._safe_home_id(home_id)
        if not _NAVIDE_HOME_ID.match(safe_id):
            return False
        pane_home = self.panes_root / safe_id
        if pane_home.is_symlink():
            pane_home.unlink()
            return True
        if not pane_home.is_dir():
            return False
        if self.owns_session(pane_home):
            return False
        auth = pane_home / "auth.json"
        if auth.is_file() and not auth.is_symlink():
            return False
        shutil.rmtree(pane_home)
        self._drop_hook_trust(pane_home)
        return True

    def _drop_hook_trust(self, pane_home: Path) -> None:
        """Remove the ``hooks.state`` rows `seed_hook_trust` wrote for a home.

        They are keyed on that home's path, so once it is gone they can never
        match again and would only pile up in the user's config.toml.
        """
        self._drop_trust_rows(f"{pane_home / 'hooks.json'}:")

    def drop_all_hook_trust(self) -> None:
        """Remove every ``hooks.state`` row seeded for any pane home."""
        if not self._drop_trust_rows(f"{self.panes_root}{os.sep}"):
            return
        for record in self.panes_root.glob(f"*/{_SEEDED_TRUST_FILE}"):
            record.unlink(missing_ok=True)

    def any_pane_hook_trust(self) -> bool:
        """Whether config.toml still holds a ``hooks.state`` row keyed on any
        pane home — what `drop_all_hook_trust` takes out."""
        try:
            text = (self.real_home / "config.toml").read_text(encoding="utf-8")
        except FileNotFoundError:
            return False
        prefix = f"{self.panes_root}{os.sep}"
        return any(key.startswith(prefix) for key in _hook_state_rows(text))

    def hook_trust_intact(self, exclude: Path | None = None) -> bool:
        """Whether every live pane home still has the trust rows it was seeded.

        Only the rows `seed_hook_trust` recorded writing are checked: a hook
        the user trusted later, in plain Codex or behind a pane's symlinked
        hooks.json, was never seeded and is not missing. False means a seeded
        row was deleted outside Navide. ``exclude`` is the home about to be
        seeded.
        """
        try:
            rows = _hook_state_rows((self.real_home / "config.toml").read_text(encoding="utf-8"))
            homes = [p for p in self.panes_root.iterdir() if p.is_dir() and not p.is_symlink()]
        except (OSError, ValueError):
            # Unreadable or not TOML: nothing says a row was deleted.
            return True
        for home in homes:
            if exclude is not None and home == exclude:
                continue
            if any(key not in rows for key in self._seeded_trust(home)):
                return False
        return True

    def _drop_trust_rows(self, prefix: str) -> bool:
        """Returns False when the rewrite failed and the rows are still there."""
        config = self.real_home / "config.toml"
        try:
            text = config.read_text(encoding="utf-8")
        except OSError:
            return True
        # Textual, to leave the rest of the file byte-identical, but any
        # spelling TOML allows for the header and value matches.
        block = re.compile(
            r'\n*^\[[ \t]*hooks[ \t]*\.[ \t]*state[ \t]*\.[ \t]*(' + _TOML_KEY + r')[ \t]*\][ \t]*(?:#[^\n]*)?\n'
            r'\s*trusted_hash[ \t]*=[ \t]*(?:' + _TOML_KEY + r')[ \t]*(?:#[^\n]*)?(?:\n|\Z)',
            flags=re.MULTILINE,
        )
        kept = block.sub(
            lambda m: "\n" if (_toml_key(m.group(1)) or "").startswith(prefix) else m.group(0),
            text,
        )
        if kept == text:
            return True
        # Through the resolved path: a dotfiles symlink stays a symlink.
        target = config.resolve()
        tmp = target.with_name(target.name + ".navide-tmp")
        try:
            # Private from the first byte, then the original's mode: the file
            # can carry secrets, and a default-umask rewrite would widen it.
            _discard_temp(tmp)
            with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8") as f:
                f.write(kept)
            shutil.copymode(target, tmp)
            os.replace(tmp, target)
        except OSError as err:
            try:
                _discard_temp(tmp)
            except OSError as cleanup:
                log.warning("removing %s failed: %s", tmp, cleanup)
            log.warning("dropping codex hook trust under %s failed: %s", prefix, err)
            return False
        return True

    def sweep_orphans(self) -> list[str]:
        """Reclaim every pane home no pane needs. Runs once at backend start.

        This backend has no live pane then, but another Navide on the same
        machine (a packaged build beside `pnpm dev`) may: its codex processes
        carry CODEX_HOME in their environment, and a home one of them runs in
        is skipped. Otherwise the only homes kept are the ones `reclaim`
        refuses. Returns the ids it removed."""
        if not self.panes_root.is_dir():
            return []
        try:
            names = sorted(p.name for p in self.panes_root.iterdir())
        except OSError as err:
            log.warning("enumerating %s failed: %s", self.panes_root, err)
            return []
        live = self._live_codex_homes()
        reclaimed: list[str] = []
        for name in names:
            if not _NAVIDE_HOME_ID.match(name):
                continue
            if name in live:
                continue
            try:
                if self.reclaim(name):
                    reclaimed.append(name)
            except OSError as err:
                log.warning("reclaiming codex pane home %s failed: %s", name, err)
        return reclaimed

    def _live_codex_homes(self) -> set[str]:
        """Names of the pane homes some running process has as CODEX_HOME.

        Only this user's processes expose their environment; anything else
        is skipped, not treated as live. Read once per sweep."""
        root = self.panes_root.resolve()
        live: set[str] = set()
        for proc in psutil.process_iter():
            try:
                home = proc.environ().get("CODEX_HOME")
            except (psutil.Error, OSError):
                continue
            if not home:
                continue
            try:
                path = Path(home).resolve()
            except OSError:
                continue
            if path.parent == root:
                live.add(path.name)
        return live

    def cleanup(self, home_id: str) -> bool:
        safe_id = self._safe_home_id(home_id)
        pane_home = (self.panes_root / safe_id).resolve()
        root = self.panes_root.resolve()
        try:
            pane_home.relative_to(root)
        except ValueError:
            raise ValueError(f"refusing to clean path outside codex panes root: {pane_home}")
        if pane_home == root:
            raise ValueError("refusing to clean codex panes root")
        if not pane_home.exists() and not pane_home.is_symlink():
            return False
        if pane_home.is_symlink():
            pane_home.unlink()
            return True
        shutil.rmtree(pane_home)
        return True

    def _safe_home_id(self, home_id: str) -> str:
        value = home_id.strip()
        if not value or not _SAFE_HOME_ID.match(value):
            raise ValueError(f"invalid codex home id: {home_id!r}")
        return value


# ---- attribution/watch hooks ----------------------------------------------

_CODEX_PANES_ROOT_NAME = ".codex-panes"


def _discard_temp(path: Path) -> None:
    """Remove a temp file of ours. Windows refuses to delete a read-only
    file, and the temp file takes the original's mode before the replace.
    Only there, and never through a link: chmod follows one, onto a file
    that is not ours."""
    from .. import osplat

    try:
        path.unlink(missing_ok=True)
    except PermissionError:
        if osplat.paths.enforces_posix_modes() or path.is_symlink():
            raise
        os.chmod(path, 0o600)
        path.unlink(missing_ok=True)


def _hook_state_rows(text: str) -> dict[str, str | None]:
    """Every ``hooks.state`` table in config.toml, by key, to its
    ``trusted_hash`` — the only value seeding copies — else None. Read as
    TOML, so any legal spelling of a header counts. Seeding and its presence
    checks all read the file through this one parser; a file that is not
    TOML raises ``ValueError``."""
    state = tomllib.loads(text).get("hooks", {})
    state = state.get("state", {}) if isinstance(state, dict) else {}
    if not isinstance(state, dict):
        return {}
    rows: dict[str, str | None] = {}
    for key, table in state.items():
        trusted = table.get("trusted_hash") if isinstance(table, dict) else None
        rows[key] = trusted if isinstance(trusted, str) else None
    return rows


#: A quoted TOML key or string: basic ("...", with escapes) or literal ('...').
_TOML_KEY = r'"(?:[^"\\\n]|\\.)*"|\'[^\'\n]*\''


def _toml_key(quoted: str) -> str | None:
    """The value of one quoted TOML key, or None when it does not parse."""
    try:
        value = tomllib.loads(f"k = {quoted}")["k"]
    except ValueError:
        return None
    return value if isinstance(value, str) else None


def _toml_escape(value: str) -> str:
    """Quoted-key body for a TOML basic string (paths: backslash and quote)."""
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _toml_inline_key(value: str) -> str:
    """`value` quoted for an inline ``-c`` table: a literal string, so it
    adds no `"` for cmd.exe to mangle (see codex_session_hooks._toml_literal);
    a basic string only when the value itself holds a `'`."""
    if "'" not in value and "\n" not in value:
        return "'" + value + "'"
    return '"' + _toml_escape(value) + '"'


def _toml_unescape(value: str) -> str:
    return re.sub(r'\\(["\\])', r"\1", value)


def is_subagent_session_meta(payload: dict) -> bool:
    """Codex's optional thread_source is not the only subagent signal."""
    source = payload.get("source")
    return bool(
        payload.get("thread_source") == "subagent"
        or payload.get("parent_thread_id")
        or isinstance(source, dict) and "subagent" in source
    )


def _session_meta_resume_id(text: str) -> str:
    """The session_meta record's payload.id — the id `codex resume` actually
    needs (the filename stem includes a timestamp prefix and is NOT accepted).
    '' when the expected shape isn't found.

    A sub-agent thread is never that id. Codex writes each sub-agent it spawns
    as its own rollout inside the SAME per-pane CODEX_HOME, marked
    `thread_source: "subagent"`; resuming one lands on a thread whose input the
    parent owns, and codex refuses it outright ("This sub-agent is controlled
    by its parent. Direct input is disabled."). The pane is driving the thread
    that spawned the sub-agent, and that thread's own rollout always sits in
    the same home — so a sub-agent file announces nothing and the parent's file
    keeps the binding.
    """
    for payload in _session_meta_payloads(text):
        if is_subagent_session_meta(payload):
            return ""
        if payload.get("id"):
            return str(payload["id"])
    return ""


def _session_meta_payloads(text: str) -> list[dict]:
    """Every session_meta payload in `text`, in file order.

    A rollout normally opens with exactly one. A thread codex forked — a
    sub-agent — replays its ancestors' session_meta records after its own, so
    later entries describe the thread it was spawned from.
    """
    out: list[dict] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or '"session_meta"' not in line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("type") == "session_meta":
            payload = rec.get("payload") or {}
            if isinstance(payload, dict):
                out.append(payload)
    return out


def command_with_resume_id(command: Any, old_id: str, new_id: str) -> Any:
    """The launch command with `old_id` swapped for `new_id`, preserving the
    ``[shell, '-ilc', '<cmd>']`` wrapper the frontend sends (see
    ``command_text``)."""
    if isinstance(command, list):
        if not command:
            return command
        return [*command[:-1], str(command[-1]).replace(old_id, new_id)]
    return str(command or "").replace(old_id, new_id)


def _pane_id_from_home_path(file_path: str) -> str:
    try:
        path = Path(file_path).resolve()
        panes_root = (Path.home() / _CODEX_PANES_ROOT_NAME).resolve()
        rel = path.relative_to(panes_root)
    except (OSError, ValueError):
        return ""
    parts = rel.parts
    if len(parts) >= 3 and parts[1] == "sessions":
        return parts[0]
    return ""


def _path_identity(self, usage):
    # Per-pane CODEX_HOME path encodes the pane id. The rollout file is
    # created before session_meta is always readable; return None until the
    # real resume id appears so a malformed fallback id is never announced.
    pane_id = _pane_id_from_home_path(usage.file_path)
    if not pane_id:
        return None
    try:
        text = Path(usage.file_path).read_text(
            encoding="utf-8", errors="ignore")[:524_288]
    except OSError:
        text = ""
    return pane_id, _session_meta_resume_id(text)


def _workspace_match(self, usage, ws_path, owner_workspace=None):
    # session_meta carries cwd -> usage.cwd.
    return bool(usage.cwd and usage.cwd == ws_path)


def _pane_cwd_match(self, usage, pane_cwd, pane_id):
    return usage.cwd == pane_cwd


def _resume_id_from_session_text(self, text):
    return _session_meta_resume_id(text)


CodexLogReader.binds_by_marker_file = True
CodexLogReader.emits_session_sink = True
CodexLogReader.requires_real_resume_id = True
CodexLogReader.path_identity = _path_identity
CodexLogReader.workspace_match = _workspace_match
CodexLogReader.pane_cwd_match = _pane_cwd_match
CodexLogReader.resume_id_from_session_text = _resume_id_from_session_text


def _pane_home_id(self, file_path):
    return _pane_id_from_home_path(file_path)


CodexLogReader.pane_home_id = _pane_home_id


# ---- credentials (vault identity) ------------------------------------------

def identity_from_secret(secret):
    """Display identity for the accounts UI: codex auth.json's id_token JWT
    carries the login email (display only — signature not verified)."""
    data = None
    if secret is not None:
        try:
            data = json.loads(secret)
        except ValueError:
            data = None
    if not isinstance(data, dict):
        data = None
    tokens = (data or {}).get("tokens")
    id_token = tokens.get("id_token") if isinstance(tokens, dict) else None
    email = None
    if isinstance(id_token, str) and id_token.count(".") >= 2:
        payload = id_token.split(".")[1]
        try:
            decoded = json.loads(
                base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
            value = decoded.get("email")
            email = value if isinstance(value, str) and value else None
        except (ValueError, UnicodeDecodeError):
            email = None
    signed_in = bool(
        isinstance(tokens, dict) and (tokens.get("access_token") or id_token)
        or (data or {}).get("OPENAI_API_KEY")
    )
    return {"email": email, "signedIn": signed_in}


# ---- usage quota -----------------------------------------------------------

def read_codex_credentials(codex_home: Path) -> dict | None:
    """Parse ``auth.json``: tokens object (snake_case or camelCase) or the
    bare ``{"OPENAI_API_KEY": ...}`` form."""
    try:
        data = json.loads((codex_home / "auth.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    tokens = data.get("tokens")
    if isinstance(tokens, dict):
        access = tokens.get("access_token") or tokens.get("accessToken")
        if access:
            return {
                "access_token": access,
                "account_id": tokens.get("account_id") or tokens.get("accountId"),
            }
    api_key = data.get("OPENAI_API_KEY")
    if isinstance(api_key, str) and api_key:
        return {"access_token": api_key, "account_id": None}
    return None


def codex_base_url(codex_home: Path) -> str:
    """``chatgpt_base_url`` from config.toml (simple line parse, matching
    CodexBar), normalized: strip trailing slash; chatgpt.com/chat.openai.com
    bases get ``/backend-api`` appended when missing."""
    base = ""
    try:
        for line in (codex_home / "config.toml").read_text(encoding="utf-8").splitlines():
            line = line.split("#", 1)[0].strip()
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            if key.strip() == "chatgpt_base_url":
                base = value.strip().strip("'\"")
                break
    except OSError:
        pass
    if not base:
        return _protocols.CODEX_DEFAULT_BASE
    base = base.rstrip("/")
    if (base.startswith("https://chatgpt.com") or base.startswith("https://chat.openai.com")) \
            and "/backend-api" not in base:
        base += "/backend-api"
    return base




async def fetch_codex(codex_home: Path) -> dict:
    creds = read_codex_credentials(codex_home)
    if creds is None:
        # Fresh-install rescue: an OAuth login completed inside a manual pane
        # sits stranded in ~/.codex-panes/<pane>/auth.json (no real auth.json
        # existed to symlink at spawn). Adopt it so the credential is shared
        # and the badge lights without waiting for a new pane spawn.
        if await asyncio.to_thread(
            CodexHomeManager(real_home=codex_home).promote_stranded_auth
        ):
            creds = read_codex_credentials(codex_home)
    if creds is None:
        return _snapshot("codex", "no-credentials")
    import httpx

    headers = {
        "Authorization": f"Bearer {creds['access_token']}",
        "User-Agent": "Navide",
        "Accept": "application/json",
    }
    if creds.get("account_id"):
        headers["ChatGPT-Account-Id"] = creds["account_id"]
    url = _protocols.codex_usage_url(codex_base_url(codex_home))
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(url, headers=headers)
    if resp.status_code in (401, 403):
        return _snapshot("codex", "expired")
    if resp.status_code == 429:
        snap = _snapshot("codex", "rate-limited")
        snap["retryAfterSec"] = parse_retry_after(resp.headers.get("Retry-After"))
        return snap
    if resp.status_code != 200:
        return _snapshot("codex", "error", error=f"HTTP {resp.status_code}")
    payload = resp.json()
    windows, plan = _protocols.normalize_codex(payload)
    snap = _snapshot("codex", "ok", windows=windows, plan_type=plan)
    credits = _protocols._codex_credits(payload)
    if credits is not None:
        snap["credits"] = credits
    extra = _protocols._codex_extra_windows(payload)
    if extra:
        snap["extraWindows"] = extra
    return snap




# ---- resume / session ------------------------------------------------------

_RESUME_RE = re.compile(r"^codex\s+resume\s+(\S+)")


def _resume_id_from_command(command) -> str:
    """Session id from a `codex resume <id> ...` command ('' otherwise)."""
    m = _RESUME_RE.match(command_text(command).strip())
    return m.group(1) if m else ""


def _session_exists(workspace_path: str, session_id: str) -> bool:
    # Agent History stores only a pointer to the vendor-owned rollout. A
    # stale pointer must not pass preflight and launch a doomed
    # `codex resume`; search both the real and isolated per-pane homes.
    # Archived rollouts are deliberately excluded — codex refuses to resume
    # them, so "exists" here means "resumable".
    return CodexHomeManager().find_resumable_session_home(session_id) is not None


# ---- vendor spec -----------------------------------------------------------

def _risk_data_dirs(ctx: VendorRuntimeContext) -> tuple[Path, ...]:
    root = ctx.path(ctx.env.get("CODEX_HOME") or ctx.home / ".codex")
    # https://learn.chatgpt.com/docs/config-file/environment-variables
    # SQLite state can move separately; config-file sqlite_home takes precedence
    # inside Codex and is outside this environment-only observation scope.
    sqlite_home = ctx.env.get("CODEX_SQLITE_HOME")
    if sqlite_home:
        return tuple(dict.fromkeys((root, ctx.path(sqlite_home))))
    return (root,)


# Where this CLI keeps the extensions it installed for itself (read-only
# inventory, cli_extensions). Verified 2026-10-10 against the installed
# binary's --help and the files on disk.
_EXTENSIONS = ExtensionsSpec(sources=(
    ExtensionsSource("codex-config", (".codex", "config.toml"), "Codex plugin", section=("plugins",)),
    ExtensionsSource("hooks", (".codex", "hooks.json"), "Codex hook", section=("hooks",), native_consent="hook-trust"),
))

SPEC = VendorSpec(
    extensions=_EXTENSIONS,
    key="codex",
    # Built-in OpenAI API and ChatGPT service defaults (verified 2026-09-21):
    # https://learn.chatgpt.com/docs/config-file/config-sample
    # https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/src/lib.rs
    # https://github.com/openai/codex/blob/main/codex-rs/login/src/server.rs
    # Custom providers/config-file routing and tool traffic are not enumerated.
    expected_hosts=("api.openai.com", "chatgpt.com", "auth.openai.com"),
    network_override_env_vars=("OPENAI_BASE_URL", "CODEX_OSS_BASE_URL", "CODEX_OSS_PORT"),
    # CODEX_HOME is assigned per pane, including resumes in an existing home.
    data_dirs=_risk_data_dirs,
    data_dir_env_vars=("CODEX_HOME", "CODEX_SQLITE_HOME"),
    supports_model=True,
    # Verified 2026-08-15: codex resolves its skills from $CODEX_HOME/skills.
    skills_supported=True,
    skills_wiring=SkillsWiring(
        root_env="CODEX_HOME",
        reads_shared_root=True,
        root_home=(".codex",),
        skills_rel=("skills",),
        isolated_panes_home=(".codex-panes",),
    ),
    label="Codex CLI (OpenAI)",
    # No JSON document at all: `-c` is a one-shot TOML override merged over
    # config.toml at process start, and stays valid after a subcommand
    # (`codex resume`). The dotted key doubles as the already-wired marker.
    mcp_wiring=McpWiring(
        flag="-c",
        flag_value='mcp_servers.{name}.url="{url}"',
        flag_token_env_value='mcp_servers.{name}.bearer_token_env_var="{env}"',
        already_wired="mcp_servers.{name}",
    ),
    login_command_args="login",
    live_file=(".codex", "auth.json"),
    slot_file="auth.json",
    login_home_secret_file=("auth.json",),
    profile_home_secret_file=("auth.json",),
    login_home_env="CODEX_HOME",
    identity_from_secret=identity_from_secret,
    # ``auth.json`` is read at startup, so a swap needs the pane restarted and
    # resumed (``codex resume <id>``). Multi-account switching has run on real
    # accounts through the vault's restart path, but not against a recorded
    # codex version — "source" until a round-trip is logged. No
    # ``expires_at``: the JWT ``exp`` is the access token's and codex
    # refreshes it itself.
    account_switch=AccountSwitchSpec(
        auth_scope="codex",
        method="restart",
        store="file",
        evidence="source",
        verified_version="0.155.1",
        # The 0.155.1 binary accepts a credential from these ("provide an API
        # key through a supported auth env var", "auth is provided by
        # environment"); whether one outranks a ChatGPT login in auth.json is
        # not readable from the binary, so a pane carrying one is reported as
        # credential-source-unknown, not swapped.
        uncertain_env=("OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"),
        resume="native",
        todo="restart switch used on real accounts; record an A -> B -> A round-trip against 0.155.1; env-vs-auth.json precedence unverified",
    ),
    # Late-bound (module global at call time) so tests can monkeypatch. The
    # wham endpoint reads the EFFECTIVE codex home ($CODEX_HOME override,
    # else <home>/.codex) — the same resolution the poller used inline.
    fetch_usage=lambda home: fetch_codex(
        Path(os.environ["CODEX_HOME"]) if os.environ.get("CODEX_HOME")
        else home / ".codex"
    ),
    resume_id_from_command=_resume_id_from_command,
    session_exists=_session_exists,
    home_env_vars=("CODEX_HOME",),
    interrupt_key=b"\x1b",
    make_log_reader=CodexLogReader,
    install_dep=Dep("codex", "Codex CLI (OpenAI)", "OpenAI Codex CLI", "agent_cli",
        ["codex", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="npm install -g @openai/codex", needs_terminal=True,
        requires_binaries=("npm",),
        optional=True, docs_url="https://learn.chatgpt.com/docs/codex/cli",
        update_cmd="codex update", doctor_cmd="codex doctor",
        npm_package="@openai/codex"),
)
