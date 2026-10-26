"""Claude Code conversation log reader.

Format reference: docs/cli-log-formats.md (Claude section).

Path resolution (first hit wins):
  1. $CLAUDE_CONFIG_DIR/projects
  2. ~/.config/claude/projects
  3. ~/.claude/projects

Each cwd → one subdirectory named per encode_claude_cwd (every
non-alphanumeric char → "-").
Each session → one {uuid}.jsonl file inside that subdirectory.
Token-relevant lines have type="assistant" and message.usage populated.
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path

import asyncio
import base64
import hashlib
import os
import re
import sys
import time
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .. import osplat
from .base import ExtensionsSource, ExtensionsSpec  # noqa: F401
from .base import (
    AccountSwitchSpec,
    Dep,
    McpServerConfig,
    McpValue,
    McpWiring,
    PortableCredential,
    PushChannel,
    ShutdownSpec,
    SkillsWiring,
    SlotKind,
    VendorSpec,
    command_text,
)
from ..usage_common import (
    _KEYCHAIN_COOLDOWN_S,
    _snapshot,
    communicate_or_kill as _communicate_or_kill,
)
from ..log_readers.base import (
    ActivityEvent,
    IncrementalParseResult,
    LogReader,
    TokenUsage,
    TurnCall,
    TurnUsage,
    activity_high_water,
    join_text_blocks,
    merge_prompt_excerpt,
    read_jsonl_tail,
    set_activity_high_water,
    user_prompt_text,
)

log = logging.getLogger("agent_team_backend.log_readers.claude")


from ..log_readers.base import encode_claude_cwd  # noqa: F401


def _assistant_text(msg: dict) -> str:
    """Join the text blocks of an assistant message ("" when none)."""
    return join_text_blocks(msg.get("content"), "text")


def _has_pasted_images(content: object) -> bool:
    """A prompt with pasted images: a content list of text and image blocks, as
    opposed to tool results (which may hold images too) and injected text lists."""
    if not isinstance(content, list):
        return False
    types = {b.get("type") for b in content if isinstance(b, dict)}
    return "image" in types and "tool_result" not in types


# Claude's tool for putting a multiple-choice question to the user. The turn
# pauses on it with stop_reason=tool_use, so no turn_complete is emitted and
# the pane would otherwise just fall silent and drift to idle.
_QUESTION_TOOL = "AskUserQuestion"


def _asks_user_question(msg: dict) -> bool:
    """True when this assistant message parks the turn on a user question."""
    content = msg.get("content")
    if not isinstance(content, list):
        return False
    return any(
        isinstance(b, dict)
        and b.get("type") == "tool_use"
        and b.get("name") == _QUESTION_TOOL
        for b in content
    )


# Background work the CLI keeps running after its own turn ends: a Bash call
# with run_in_background (or one moved there by its timeout) and an async
# subagent. The main turn still ends with end_turn, so without these the pane
# reads as idle while the work runs. Detail values are the cross-end contract
# the frontend's RUNNING badge keys on; the task ids ride in `text`, one per
# line, because an end record can name several tasks at once.
BACKGROUND_START_DETAIL = "background:start"
BACKGROUND_END_DETAIL = "background:end"
# Tools the agent uses to stop a background task itself. Such a stop writes no
# <task-notification>, so the tool call is the only end record it leaves.
_TASK_STOP_TOOLS = frozenset({"TaskStop", "KillShell", "KillBash"})
_TASK_NOTIFICATION_ID_RE = re.compile(r"<task-id>([^<]+)</task-id>")


def _background_task_started(rec: dict) -> str:
    """Task id a tool_result record launched in the background, or ""."""
    result = rec.get("toolUseResult")
    if not isinstance(result, dict):
        return ""
    task_id = result.get("backgroundTaskId")
    if task_id:
        return str(task_id)
    status = result.get("status")
    if status == "async_launched" or (status == "forked" and result.get("background")):
        return str(result.get("agentId") or "")
    return ""


def _background_tasks_stopped_by_tool(msg: dict) -> list[str]:
    """Task ids an assistant message stops with TaskStop (or its older names)."""
    content = msg.get("content")
    if not isinstance(content, list):
        return []
    ids: list[str] = []
    for b in content:
        if not (isinstance(b, dict) and b.get("type") == "tool_use"
                and b.get("name") in _TASK_STOP_TOOLS):
            continue
        inp = b.get("input") if isinstance(b.get("input"), dict) else {}
        task_id = inp.get("task_id") or inp.get("shell_id")
        if task_id:
            ids.append(str(task_id))
    return ids


def _background_tasks_finished(rec: dict) -> list[str]:
    """Task ids a queued <task-notification> reports as finished.

    Only notifications carrying a <status> end a task: a Monitor event rides
    the same wrapper without one, and its task keeps running.
    """
    if rec.get("operation") != "enqueue":
        return []
    content = rec.get("content")
    if not isinstance(content, str) or "<task-notification>" not in content:
        return []
    if "<status>" not in content:
        return []
    return _TASK_NOTIFICATION_ID_RE.findall(content)


_PREVIEW_MAX_CHARS = 80


def first_user_prompts(path: Path, limit: int = 2) -> list[str]:
    """The first ``limit`` real human prompts from a Claude .jsonl (best-effort).

    Mirrors parse_session_file's per-line ``json.loads`` loop. A "real" prompt
    is a ``type=="user"`` record whose ``message.content`` is a plain string of
    human text — not a tool_result / injected-text list, and not a slash-command
    or system wrapper (those render as a string starting with "<", e.g.
    ``<command-name>``, ``<task-notification>``, ``<local-command-stdout>``).
    Each prompt is truncated to ~80 chars. Malformed lines are skipped;
    returns ``[]`` when the file cannot be opened.
    """
    out: list[str] = []
    try:
        fh = path.open(encoding="utf-8")
    except OSError as err:
        log.debug("open %s failed: %s", path, err)
        return out

    with fh:
        for raw in fh:
            if len(out) >= limit:
                break
            raw = raw.strip()
            if not raw:
                continue
            try:
                rec = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if rec.get("type") != "user" or rec.get("isMeta"):
                continue  # isMeta: Claude Code's own notes (an image Read's size line)
            msg = rec.get("message")
            if not isinstance(msg, dict):
                continue
            content = msg.get("content")
            if not isinstance(content, str):
                continue  # tool_result / injected-text lists aren't human prompts
            text = content.strip()
            if not text or text.startswith("<"):
                continue  # command wrappers, task-notifications, resume stubs
            out.append(text[:_PREVIEW_MAX_CHARS])
    return out


def _int(v) -> int:  # noqa: ANN001
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return 0


def claude_projects_root() -> Path | None:
    """First-hit-wins default projects root (backend-process view).

    $CLAUDE_CONFIG_DIR overrides; the fallbacks are tried in CodexBar order.
    Returning a single root (not all of them) avoids double-counting if a
    user has both ~/.config/claude and ~/.claude populated by accident.

    Module-level so the log reader and the resume preflight resolve the root
    the same way — the preflight used to hardcode ~/.claude.
    """
    env_dir = os.environ.get("CLAUDE_CONFIG_DIR")
    candidates: list[Path] = []
    if env_dir:
        candidates.append(Path(env_dir) / "projects")
    candidates.append(Path.home() / ".config" / "claude" / "projects")
    candidates.append(Path.home() / ".claude" / "projects")
    for p in candidates:
        if p.is_dir():
            return p
    return None


class ClaudeLogReader(LogReader):
    vendor: str = "claude"

    #: turns_for_session groups on the transcript's own promptId.
    turns_method: str = "exact"

    #: parse_activity walks a dense ascending line counter and resumes from
    #: one high-water mark, so an old file can be seeded to EOF by counting
    #: lines rather than replaying it (log_readers.base).
    activity_resumes_by_line: bool = True

    def _default_root(self) -> Path | None:
        return claude_projects_root()

    def project_dirs(self) -> list[Path]:
        """The single default projects root (empty list when none exists).

        Managed-account panes run with CLAUDE_CONFIG_DIR pointed at an isolated
        home, but that home's ``projects`` is symlinked back to the real home
        (credential_vault), so every account's sessions resolve into this one
        root — no separate profile-home scan is needed. Returned as a list for
        the callers that iterate it."""
        default = self._default_root()
        return [default] if default is not None else []

    def session_files(self) -> list[Path]:
        out: list[Path] = []
        for root in self.project_dirs():
            try:
                for child in root.iterdir():
                    if not child.is_dir():
                        continue
                    for f in child.iterdir():
                        if f.is_file() and f.suffix == ".jsonl":
                            out.append(f)
            except OSError as err:
                log.debug("enumerate %s failed: %s", root, err)
        return out

    def session_files_for_workspace(self, workspace_path: str) -> list[Path]:
        """Only the jsonl files under this workspace's project subdirectory.

        Claude names each project dir after the encoded cwd, so one
        workspace maps to exactly one folder — we can enumerate just that
        folder instead of the entire (potentially multi-GB) projects root.
        """
        encoded = encode_claude_cwd(workspace_path)
        out: list[Path] = []
        for root in self.project_dirs():
            d = root / encoded
            if not d.is_dir():
                continue
            try:
                for f in d.iterdir():
                    if f.is_file() and f.suffix == ".jsonl":
                        out.append(f)
            except OSError as err:
                log.debug("enumerate %s failed: %s", d, err)
        return out

    def cwd_from_file(self, path: Path) -> str:
        """Reverse cwd-hash: project-dir-name `-foo-bar-baz` → `/foo/bar/baz`.

        Edge case: a literal `-` in the original path is ambiguous. Best-effort
        only; attribution layer handles "unmatched cwd" gracefully.
        """
        try:
            project_dir_name = path.parent.name
        except Exception:
            return ""
        if not project_dir_name.startswith("-"):
            return ""
        return project_dir_name.replace("-", "/")

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        out: list[TokenUsage] = []
        cwd = self.cwd_from_file(path)
        session_id = path.stem

        try:
            fh = path.open(encoding="utf-8")
        except OSError as err:
            log.debug("open %s failed: %s", path, err)
            return out

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

                if rec.get("type") != "assistant":
                    continue
                msg = rec.get("message")
                if not isinstance(msg, dict):
                    continue
                usage = msg.get("usage")
                if not isinstance(usage, dict):
                    continue

                msg_id = str(msg.get("id") or "")
                req_id = str(rec.get("requestId") or "")
                dedup_key = f"{msg_id}::{req_id}"
                if dedup_key == "::" or dedup_key in seen_keys:
                    continue

                input_tokens = (
                    _int(usage.get("input_tokens"))
                    + _int(usage.get("cache_read_input_tokens"))
                    + _int(usage.get("cache_creation_input_tokens"))
                )
                output_tokens = _int(usage.get("output_tokens"))
                if input_tokens == 0 and output_tokens == 0:
                    continue

                seen_keys.add(dedup_key)
                out.append(
                    TokenUsage(
                        vendor="claude",
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                        cwd=cwd,
                        session_id=session_id,
                        file_path=str(path),
                        dedup_key=dedup_key,
                        timestamp=str(rec.get("timestamp") or ""),
                        model=str(msg.get("model") or ""),
                        cache_read_tokens=_int(usage.get("cache_read_input_tokens")),
                        cache_creation_tokens=_int(usage.get("cache_creation_input_tokens")),
                        cli_version=str(rec.get("version") or ""),
                    )
                )
        return out

    def parse_incremental(
        self,
        path: Path,
        checkpoint: dict,
    ) -> IncrementalParseResult:
        """Parse only complete JSONL records after the persisted byte offset."""
        records, final_checkpoint, rotated = read_jsonl_tail(path, checkpoint)
        recent = [] if rotated else [str(k) for k in checkpoint.get("recent_keys", [])][-64:]
        recent_set = set(recent)
        out: list[TokenUsage] = []
        cwd = self.cwd_from_file(path)
        session_id = path.stem

        for end, rec in records:
            if rec is None or rec.get("type") != "assistant":
                continue
            msg = rec.get("message")
            if not isinstance(msg, dict):
                continue
            usage = msg.get("usage")
            if not isinstance(usage, dict):
                continue
            dedup_key = f"{msg.get('id') or ''}::{rec.get('requestId') or ''}"
            if dedup_key == "::" or dedup_key in recent_set:
                continue
            input_tokens = (
                _int(usage.get("input_tokens"))
                + _int(usage.get("cache_read_input_tokens"))
                + _int(usage.get("cache_creation_input_tokens"))
            )
            output_tokens = _int(usage.get("output_tokens"))
            if input_tokens == 0 and output_tokens == 0:
                continue
            recent.append(dedup_key)
            recent = recent[-64:]
            recent_set = set(recent)
            event_checkpoint = dict(final_checkpoint)
            event_checkpoint["offset"] = end
            event_checkpoint["recent_keys"] = list(recent)
            out.append(TokenUsage(
                vendor="claude",
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cwd=cwd,
                session_id=session_id,
                file_path=str(path),
                dedup_key=dedup_key,
                timestamp=str(rec.get("timestamp") or ""),
                model=str(msg.get("model") or ""),
                checkpoint=event_checkpoint,
                cache_read_tokens=_int(usage.get("cache_read_input_tokens")),
                cache_creation_tokens=_int(usage.get("cache_creation_input_tokens")),
                cli_version=str(rec.get("version") or ""),
            ))

        final_checkpoint["recent_keys"] = recent
        return IncrementalParseResult(out, final_checkpoint)

    def turns_for_session(self, path: Path, session_id: str = "") -> list[TurnUsage]:
        """One turn per `promptId`: every human `user` record (no
        toolUseResult) carries the id of the prompt it belongs to, and the
        assistant records that follow — which carry none — belong to the
        latest one. Grouping on the id rather than on each user record keeps
        a prompt's attachments, images and a compaction summary (all written
        as extra user records under the same id) inside their turn, and a
        resumed session that keeps appending to this file simply adds ids.

        Same dedup as parse_session_file (message id + requestId, so a
        streamed message split over several lines counts once), but the four
        usage counters stay apart instead of folding cache into input.
        """
        try:
            fh = path.open(encoding="utf-8")
        except OSError as err:
            log.debug("open %s failed: %s", path, err)
            return []
        sid = path.stem
        turns: dict[str, TurnUsage] = {}
        current: TurnUsage | None = None
        seen: set[str] = set()
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
                rtype = rec.get("type")
                msg = rec.get("message")
                if not isinstance(msg, dict):
                    continue
                ts = str(rec.get("timestamp") or "") or None
                if rtype == "user" and "toolUseResult" not in rec:
                    key = str(rec.get("promptId") or f"line:{line_no}")
                    current = turns.get(key)
                    if current is None:
                        current = turns[key] = TurnUsage(
                            turn_index=0, session_id=sid,
                            started_at=ts, ended_at=None, prompt_excerpt="",
                        )
                    content = msg.get("content")
                    text = content if isinstance(content, str) else join_text_blocks(content, "text")
                    current.prompt_excerpt = merge_prompt_excerpt(current.prompt_excerpt, text)
                    continue
                if rtype != "assistant" or current is None:
                    continue
                usage = msg.get("usage")
                if not isinstance(usage, dict):
                    continue
                dedup_key = f"{msg.get('id') or ''}::{rec.get('requestId') or ''}"
                if dedup_key == "::" or dedup_key in seen:
                    continue
                call = TurnCall(
                    ts=ts, model=str(msg.get("model") or ""),
                    input=_int(usage.get("input_tokens")),
                    cache_read=_int(usage.get("cache_read_input_tokens")),
                    cache_creation=_int(usage.get("cache_creation_input_tokens")),
                    output=_int(usage.get("output_tokens")),
                    cli_version=str(rec.get("version") or ""),
                )
                if call.input + call.cache_read + call.cache_creation + call.output == 0:
                    continue
                seen.add(dedup_key)
                current.add_call(call)
                current.ended_at = ts or current.ended_at
        out = [t for t in turns.values() if t.calls]
        for n, turn in enumerate(out, 1):
            turn.turn_index = n
        return out

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Emit `agent_active` for every tool_use/text content, and
        `turn_complete` when an assistant turn ends with stop_reason=end_turn.

        Dedup keys are line-relative (file_lineno) so a streaming line that
        gets appended-to won't re-fire.
        """
        out: list[ActivityEvent] = []
        cwd = self.cwd_from_file(path)
        session_id = path.stem
        try:
            fh = path.open(encoding="utf-8")
        except OSError:
            return out

        # Every non-blank line below marks itself seen on every branch, and the
        # scan is a dense ascending walk from line 1, so one high-water mark is
        # equivalent to the per-line keys this used to leave in seen_keys — and
        # does not grow with the transcript. See log_readers.base.
        high_water = activity_high_water(seen_keys)
        last_line = high_water

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
                    ts = str(rec.get("timestamp") or "")
                    if rtype == "assistant":
                        msg = rec.get("message") or {}
                        stop_reason = str(msg.get("stop_reason") or "")
                        # Mark every assistant line as activity so the watcher
                        # knows the agent is producing content. Text rides only on
                        # turn_complete (the sole event the frontend judges), so a
                        # tool-heavy turn doesn't broadcast its text on every line.
                        out.append(ActivityEvent(
                            vendor="claude",
                            event_type="agent_active",
                            cwd=cwd, session_id=session_id, file_path=str(path),
                            dedup_key=key, timestamp=ts,
                            detail="assistant",
                        ))
                        # AskUserQuestion parks the turn on the user without ending
                        # it, so it produces no turn_complete. Emit a distinct
                        # detail the frontend can raise QUESTION on; the matching
                        # tool_result arrives as a plain `user` event and releases
                        # it. Separate dedup key so it rides alongside the
                        # `assistant` event above rather than replacing it.
                        if _asks_user_question(msg):
                            out.append(ActivityEvent(
                                vendor="claude",
                                event_type="agent_active",
                                cwd=cwd, session_id=session_id, file_path=str(path),
                                dedup_key=f"q:{line_no}", timestamp=ts,
                                detail="assistant:question",
                            ))
                        stopped = _background_tasks_stopped_by_tool(msg)
                        if stopped:
                            out.append(ActivityEvent(
                                vendor="claude",
                                event_type="agent_active",
                                cwd=cwd, session_id=session_id, file_path=str(path),
                                dedup_key=f"bg:{line_no}", timestamp=ts,
                                detail=BACKGROUND_END_DETAIL, text="\n".join(stopped),
                            ))
                        # end_turn = clean finish, not a tool_use pause.
                        if stop_reason == "end_turn":
                            out.append(ActivityEvent(
                                vendor="claude",
                                event_type="turn_complete",
                                cwd=cwd, session_id=session_id, file_path=str(path),
                                dedup_key=f"turn:{line_no}", timestamp=ts,
                                detail=stop_reason, text=_assistant_text(msg),
                            ))
                    elif rtype in ("tool_use", "user"):
                        # Real human prompts (same test as first_user_prompts:
                        # plain-string content, non-empty, not a "<...>" wrapper)
                        # carry their text so the frontend can name the pane.
                        # tool_result lists / command wrappers stay text-less.
                        text = ""
                        # A compaction summary is written as a plain-string user
                        # record but nobody typed it, and an idle compaction has
                        # no turn after it: as prompt text it opened a chat run
                        # that never ended.
                        # An isMeta record is Claude Code's own note, such as the
                        # size line after the agent Reads an image; posted as the
                        # user's prompt it read "你：[Image: original ...]".
                        if rtype == "user" and not rec.get("isCompactSummary") and not rec.get("isMeta"):
                            msg = rec.get("message")
                            content = msg.get("content") if isinstance(msg, dict) else None
                            if isinstance(content, str):
                                text = user_prompt_text(content)
                            elif _has_pasted_images(content):
                                text = user_prompt_text(join_text_blocks(content, "text"))
                        out.append(ActivityEvent(
                            vendor="claude",
                            event_type="agent_active",
                            cwd=cwd, session_id=session_id, file_path=str(path),
                            dedup_key=key, timestamp=ts,
                            detail=str(rtype), text=text,
                        ))
                        started = _background_task_started(rec) if rtype == "user" else ""
                        if started:
                            out.append(ActivityEvent(
                                vendor="claude",
                                event_type="agent_active",
                                cwd=cwd, session_id=session_id, file_path=str(path),
                                dedup_key=f"bg:{line_no}", timestamp=ts,
                                detail=BACKGROUND_START_DETAIL, text=started,
                            ))
                    elif rtype == "queue-operation":
                        # A background task's end is queued for the agent as a
                        # <task-notification>; the enqueue is written the moment
                        # it lands, whether or not the agent is mid-turn.
                        finished = _background_tasks_finished(rec)
                        if finished:
                            out.append(ActivityEvent(
                                vendor="claude",
                                event_type="agent_active",
                                cwd=cwd, session_id=session_id, file_path=str(path),
                                dedup_key=f"bg:{line_no}", timestamp=ts,
                                detail=BACKGROUND_END_DETAIL, text="\n".join(finished),
                            ))
        finally:
            set_activity_high_water(seen_keys, last_line)
        return out


# ---- attribution/watch hooks ----------------------------------------------

def _pane_cwd_match(self, usage, pane_cwd, pane_id):
    # Claude names its per-project dir after the encoded cwd; the file path
    # carries it.
    expected_dir = encode_claude_cwd(pane_cwd)
    return expected_dir in Path(usage.file_path).parts


ClaudeLogReader.pane_cwd_match = _pane_cwd_match


# ---- credentials -----------------------------------------------------------

CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials"


def read_claude_credentials_file(home: Path) -> dict | None:
    """Parse ``~/.claude/.credentials.json``. Returns the claudeAiOauth dict
    or None when absent/unusable (an mcpOAuth-only payload counts as absent)."""
    path = home / ".claude" / ".credentials.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    oauth = data.get("claudeAiOauth") if isinstance(data, dict) else None
    if not isinstance(oauth, dict) or not oauth.get("accessToken"):
        return None
    return oauth


def parse_claude_credentials(raw: str | None) -> dict | None:
    """Extract Claude OAuth data from a vault credential payload."""
    if raw is None:
        return None
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None
    oauth = data.get("claudeAiOauth") if isinstance(data, dict) else None
    if not isinstance(oauth, dict) or not oauth.get("accessToken"):
        return None
    return oauth




# A failed Keychain read (denied prompt, timeout) is remembered so we don't
# re-prompt every poll — but only for a cooldown window, so a transient failure
# (e.g. a slow security call during an account switch) self-heals without an app
# restart. monotonic timestamp; None means no active cooldown.
_KEYCHAIN_COOLDOWN_S = 300.0
_keychain_failed_at: float | None = None


from ..usage_common import (  # noqa: E402,F401
    _KEYCHAIN_COOLDOWN_S as _SHARED_KEYCHAIN_COOLDOWN_S,
    communicate_or_kill as _communicate_or_kill,
)


async def read_claude_credentials(home: Path) -> dict | None:
    """File first; on macOS fall back to the Keychain generic password the
    Claude Code CLI writes. A failed Keychain read is remembered for
    ``_KEYCHAIN_COOLDOWN_S`` (the prompt/denial would otherwise re-fire every
    poll), then retried so a transient failure self-heals."""
    global _keychain_failed_at
    oauth = read_claude_credentials_file(home)
    if oauth is not None:
        return oauth
    if sys.platform != "darwin":
        return None
    now = time.monotonic()
    if _keychain_failed_at is not None and now - _keychain_failed_at < _KEYCHAIN_COOLDOWN_S:
        return None
    try:
        proc = await asyncio.create_subprocess_exec(
            "/usr/bin/security", "find-generic-password",
            "-s", CLAUDE_KEYCHAIN_SERVICE, "-w",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        out = await _communicate_or_kill(proc, timeout=2.0)
        if proc.returncode != 0:
            _keychain_failed_at = now
            return None
        _keychain_failed_at = None
        data = json.loads(out.decode("utf-8", "replace").strip())
        oauth = data.get("claudeAiOauth") if isinstance(data, dict) else None
        if not isinstance(oauth, dict) or not oauth.get("accessToken"):
            return None
        return oauth
    except (OSError, ValueError, asyncio.TimeoutError):
        _keychain_failed_at = now
        return None




# ---- usage quota: the CLI's own /usage report --------------------------------
# (nothing here talks to Anthropic; Claude Code makes the request under its own
# identity and prints the answer.)

# ``claude -p /usage`` prints the quota report to stdout and exits — no pty, no
# prompt to wait for, no keystrokes to time. The MCP flags keep the probe from
# starting the user's MCP servers; ``--no-session-persistence`` keeps it out of
# the session list. It does not consume quota and needs no trust record for the
# cwd. Older CLIs that lack the print form fail here with a clear error; there
# is deliberately no fallback to driving the interactive UI.
USAGE_ARGS = (
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--no-session-persistence",
    "-p", "/usage",
)
# ~2s idle, but that is the floor, not the shape: the probe boots a whole
# Claude Code, so it scales with how busy the machine already is. Measured on a
# machine running ~20 CLI panes: 21s, 25s, 26s, 52s for the same command back to
# back. At 90s that left no headroom — a run of eight consecutive timeouts froze
# the badge on a 2.5h-old reading, each one paying for a full CLI boot and
# throwing the result away. The read is rate-limited to one per
# CLAUDE_CLI_READ_INTERVAL either way, so waiting longer costs nothing a
# failed read did not already cost; giving up early costs the whole reading.
USAGE_TIMEOUT_S = 180.0

_ENV_DROP = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR")

# "Current session: 61% used · resets Aug 26 at 5:29am (Asia/Taipei)"
# "Current week (all models): 63% used · resets Aug 26 at 4:59am (Asia/Taipei)"
# "Current week (Fable): 35% used · resets Aug 26 at 4:59am (Asia/Taipei)"
_SESSION_LINE = re.compile(r"^Current session\s*:\s*(.*)$", re.I)
_WEEK_LINE = re.compile(r"^Current week\s*\((.+?)\)\s*:\s*(.*)$", re.I)
_PERCENT = re.compile(r"(\d+(?:\.\d+)?)%\s+used", re.I)
_RESETS = re.compile(r"\bresets\s+(.+?)\s*$", re.I)


def _parse_reset(phrase: str, now: datetime) -> str | None:
    """"Aug 7 at 11:59am (Asia/Taipei)" / "5:59am (Asia/Taipei)" -> ISO 8601.

    Returns None whenever the phrase is not confidently understood — the UI
    drops the countdown for that window, which beats inventing a time. The
    wording is the CLI's own and localized, so this only claims to handle the
    English form it ships today."""
    tz_match = re.search(r"\(([A-Za-z_]+/[A-Za-z_+\-]+)\)", phrase)
    if not tz_match:
        return None
    try:
        tz = ZoneInfo(tz_match.group(1))
    except (ZoneInfoNotFoundError, ValueError):
        return None
    body = phrase[: tz_match.start()].strip().rstrip("·").strip()

    clock = re.search(r"(\d{1,2})(?::(\d{2}))?\s*([ap]m)", body, re.I)
    if not clock:
        return None
    hour = int(clock.group(1)) % 12
    if clock.group(3).lower() == "pm":
        hour += 12
    minute = int(clock.group(2) or 0)

    local_now = now.astimezone(tz)
    dated = re.match(r"([A-Z][a-z]{2})\s+(\d{1,2})\b", body)
    if dated:
        months = ("jan", "feb", "mar", "apr", "may", "jun",
                  "jul", "aug", "sep", "oct", "nov", "dec")
        try:
            month = months.index(dated.group(1).lower()) + 1
        except ValueError:
            return None
        day = int(dated.group(2))
        year = local_now.year
        # The panel never dates the past; a month behind us means next year.
        if month < local_now.month - 6:
            year += 1
        try:
            when = local_now.replace(
                year=year, month=month, day=day,
                hour=hour, minute=minute, second=0, microsecond=0,
            )
        except ValueError:
            return None
    else:
        when = local_now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if when <= local_now:  # a bare clock time means the next one
            when += timedelta(days=1)
    return when.astimezone(ZoneInfo("UTC")).isoformat().replace("+00:00", "Z")


def parse_usage_panel(text: str, *, now: datetime | None = None) -> list[dict]:
    """Windows in the shape ``usage_service._window`` produces, read from the
    plain text ``claude -p /usage`` prints — one line per window."""
    from ..usage_common import _window

    now = now or datetime.now().astimezone()
    found: dict[str, dict] = {}

    for line in text.splitlines():
        line = line.strip()
        session = _SESSION_LINE.match(line)
        if session:
            key, kind, label, rest = "session", "session", "Session (5h)", session.group(1)
        else:
            week = _WEEK_LINE.match(line)
            if not week:
                continue
            scope = week.group(1).strip()
            rest = week.group(2)
            if scope.lower() == "all models":
                key, kind, label = "weekly", "weekly", "Weekly (all models)"
            else:
                key, kind, label = f"weekly:{scope}", "weekly-model", f"Weekly ({scope})"
        pct_hit = _PERCENT.search(rest)
        if not pct_hit:
            continue  # a window with no figure is dropped, never guessed
        reset_hit = _RESETS.search(rest)
        resets = _parse_reset(reset_hit.group(1), now) if reset_hit else None
        found[key] = _window(kind, label, float(pct_hit.group(1)), resets)

    order = {"session": 0, "weekly": 1}
    return [found[k] for k in sorted(found, key=lambda k: (order.get(k, 2), k))]


def _panel_probe_env(config_dir: str | None = None) -> dict[str, str]:
    """The probe's environment. ``config_dir`` asks an account that signed in
    inside its own CLAUDE_CONFIG_DIR instead of the live login."""
    env = dict(os.environ)
    for key in _ENV_DROP:
        env.pop(key, None)
    env.update({"TERM": "xterm-256color", "COLUMNS": "100", "LINES": "40"})
    if config_dir:
        env["CLAUDE_CONFIG_DIR"] = config_dir
    return env


def _kill_group_now(pid: int) -> None:
    """Force-kill a probe's process group without awaiting anything.

    The async `_kill_group` sleeps between its SIGTERM and its SIGKILL, and a
    cancellation handler is not a safe place to await — the handler may never
    resume, which is exactly how a process gets abandoned. A probe being
    cancelled is being thrown away, so it goes straight to SIGKILL."""
    try:
        osplat.process_tree.kill_group(osplat.process_tree.group_of(pid), force=True)
    except (ProcessLookupError, PermissionError, OSError):
        pass


async def _kill_group(pid: int) -> None:
    # Async on purpose: this runs on the backend's only event loop, and a
    # blocking sleep here freezes every WebSocket session for its duration.
    for force in (False, True):
        try:
            osplat.process_tree.kill_group(
                osplat.process_tree.group_of(pid), force=force
            )
        except (ProcessLookupError, PermissionError, OSError):
            return
        await asyncio.sleep(0.2)


def _first_line(*streams: str) -> str:
    for stream in streams:
        for line in stream.splitlines():
            if line.strip():
                return line.strip()
    return ""


async def read_usage_panel(binary: str, config_dir: str | None = None) -> str:
    """Run ``claude -p /usage`` and return what it printed.

    Raises ``RuntimeError`` with a message fit for the badge's ``error`` field:
    a timeout, a non-zero exit with the CLI's first stderr line, or — when the
    exit carried no usage line at all — a note that the CLI needs updating."""
    started = time.monotonic()
    proc = await asyncio.create_subprocess_exec(
        *osplat.paths.launch_argv(binary, USAGE_ARGS),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=_panel_probe_env(config_dir), start_new_session=True,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=USAGE_TIMEOUT_S)
        # A successful read used to leave no trace, so how close the probe was
        # running to USAGE_TIMEOUT_S could only be guessed at after the fact —
        # and guessing is what set the budget too low the first time.
        log.info("claude /usage read ok in %.1fs (budget %.0fs)",
                 time.monotonic() - started, USAGE_TIMEOUT_S)
    except asyncio.CancelledError:
        # An account switch abandons this read (UsageService.
        # _cancel_claude_reads). The probe runs in its own session, so nothing
        # reaps it once we stop waiting: without this an abandoned Claude Code
        # keeps running for minutes — on the very machine whose load made the
        # read slow enough to be worth abandoning. Same leak the timeout path
        # was written to prevent; cancellation is just the second way in.
        _kill_group_now(proc.pid)
        raise
    except asyncio.TimeoutError:
        await _kill_group(proc.pid)
        try:
            await asyncio.wait_for(proc.wait(), timeout=3)
        except (asyncio.TimeoutError, ProcessLookupError):
            pass
        raise RuntimeError(f"claude -p /usage timed out after {USAGE_TIMEOUT_S:.0f}s")
    text = out.decode("utf-8", "replace")
    stderr = err.decode("utf-8", "replace")
    if proc.returncode != 0:
        detail = _first_line(stderr, text)
        if not any(_SESSION_LINE.match(l.strip()) or _WEEK_LINE.match(l.strip())
                   for l in text.splitlines()):
            raise RuntimeError(
                f"claude exited {proc.returncode} without a usage report — "
                f"the CLI needs updating to one that understands `-p /usage`"
                + (f": {detail}" if detail else "")
            )
        raise RuntimeError(
            f"claude exited {proc.returncode}" + (f": {detail}" if detail else "")
        )
    return text


async def fetch_claude_usage_via_cli(
    home: Path, config_dir: str | None = None
) -> dict[str, Any] | None:
    """Snapshot for the usage badge, or None when there is no CLI to ask.

    A read that actually started a Claude Code but came back empty returns an
    ``unavailable`` snapshot carrying a transient ``costlyRead`` flag: the
    poller prices that retry like a success (a spawn is a spawn), instead of
    re-running a full CLI boot on the short failure cooldown, forever."""
    from ..ai_chat_cli_engine import resolve_cli_binary
    from ..usage_common import _snapshot

    def _costly(error: str) -> dict[str, Any]:
        snap = _snapshot("claude", "unavailable", error=error)
        snap["costlyRead"] = True
        return snap

    # Logged out is knowable without a spawn. The CLI would only present its
    # login wizard — at a full boot's cost, on every retry, forever — and the
    # badge would say "unavailable" where it means "log in".
    # An account dir is only ever read once its own login exists (the caller
    # checks), and that credential is Claude Code's to read, not ours.
    if config_dir is None and await read_claude_credentials(home) is None:
        return _snapshot("claude", "no-credentials")
    try:
        binary = resolve_cli_binary("claude")
    except Exception:  # noqa: BLE001
        binary = ""
    if not binary:
        # The one failure here that leaves no other trace: nothing was spawned,
        # so no CLI output explains it. The backend inherits the GUI's PATH
        # (topped up from a login shell at startup and before every spawn), so
        # this is what a CLI installed somewhere that probe never saw looks
        # like — log the PATH that was searched, or the report is unactionable.
        log.warning(
            "claude /usage skipped: no claude binary found on PATH=%s",
            os.environ.get("PATH", ""),
        )
        return None
    try:
        raw = await (
            read_usage_panel(binary, config_dir) if config_dir else read_usage_panel(binary)
        )
    except Exception as err:  # noqa: BLE001 — a failed read is just "no data"
        log.warning("claude /usage read failed: %s", err)
        return _costly(str(err) or type(err).__name__)
    windows = parse_usage_panel(raw)
    if not windows:
        log.info("claude /usage produced no readable windows")
        return _costly("claude -p /usage printed no usage windows")
    return _snapshot("claude", "ok", windows=windows)


# ---- delegated OAuth refresh (merged from claude_delegated_refresh.py) -----
# The CLI mints, this app only observes; see the fingerprint contract below.

# Outcomes (also the log labels).
OUTCOME_REFRESHED = "refreshed"
OUTCOME_UNCHANGED = "unchanged"
OUTCOME_SKIPPED_COOLDOWN = "skipped-cooldown"
OUTCOME_CLI_UNAVAILABLE = "cli-unavailable"
OUTCOME_UNOBSERVABLE = "unobservable"
OUTCOME_FAILED = "failed"
OUTCOME_PANE_RUNNING = "pane-running"

# A successful renewal is good for hours, so a full cooldown after one that
# changed nothing keeps the probe rare. The short cooldown is for the cases we
# could not judge (CLI missing, Keychain unreadable) — those can self-heal.
COOLDOWN_S = 300.0
SHORT_COOLDOWN_S = 20.0
PROBE_TIMEOUT_S = 8.0

# Consecutive failures escalate, because the expensive failure mode is a macOS
# Keychain prompt the user declines: the probe spawns Claude Code in the
# background, so a flat retry would put a dialog on screen every poll with no
# user action to explain it. Escalating to a 6h ceiling means a denial costs a
# handful of dialogs, not one every five minutes forever. A probe that merely
# found nothing to renew is a healthy run and clears the streak.
FAILURE_BACKOFF_S = (300.0, 1_200.0, 3_600.0, 21_600.0)

# Read-only: prints the current auth status as JSON and exits. No prompt is
# sent to the model, so this costs no quota.
_PROBE_ARGS = ("auth", "status", "--json")

# An inherited API key would make the CLI authenticate with that instead of the
# OAuth credential, so the probe would never touch what we want renewed.
# CLAUDE_CONFIG_DIR would point it at some other account's home entirely; the
# backend already strips it at startup, but this must not depend on that having
# run first — the probe only means anything against the live credential.

_lock = asyncio.Lock()
_cooldown_until: float | None = None  # time.monotonic() deadline
_consecutive_failures = 0


def cooldown_remaining_seconds(now: float | None = None) -> float:
    """Seconds until the next probe is allowed (0.0 when one may run)."""
    if _cooldown_until is None:
        return 0.0
    return max(0.0, _cooldown_until - (time.monotonic() if now is None else now))


def reset_state_for_testing() -> None:
    global _cooldown_until, _consecutive_failures
    _cooldown_until = None
    _consecutive_failures = 0


def _arm_cooldown(seconds: float) -> None:
    global _cooldown_until
    _cooldown_until = time.monotonic() + seconds


def _arm_failure_backoff() -> None:
    """Escalate one step and hold there once the ceiling is reached."""
    global _consecutive_failures
    _consecutive_failures += 1
    step = min(_consecutive_failures, len(FAILURE_BACKOFF_S)) - 1
    _arm_cooldown(FAILURE_BACKOFF_S[step])


def _clear_failure_streak() -> None:
    global _consecutive_failures
    _consecutive_failures = 0


def _claude_pane_running() -> bool:
    """True when a live Claude pane already owns the credential.

    Claude Code renews its own token as it works, so probing alongside a
    running pane spawns a background process for something that is about to
    happen anyway — and every avoided spawn is one less chance of a Keychain
    dialog appearing with no user action behind it. The trade is that an idle
    pane may sit on an expired token until it next needs one; the badge reads
    expired for that stretch, which is what it did before this existed.

    False when the ws layer is unavailable (unit tests, early startup)."""
    try:
        from ..ws_handlers import _running_regular_terminals

        return bool(_running_regular_terminals("claude"))
    except Exception:  # noqa: BLE001 — never block the probe on introspection
        return False


def _refresh_probe_env() -> dict[str, str]:
    """The backend already drops CLI home relocations at startup (see
    ``app._sanitize_inherited_cli_env``), so the real home is inherited as-is."""
    env = dict(os.environ)
    for key in _ENV_DROP:
        env.pop(key, None)
    return env


def _live_fingerprint(vault) -> str | None:
    """Digest of the live claude secret, or None when it cannot be read.

    Never returns the secret itself. A read failure is reported as None rather
    than a sentinel digest so it can't be mistaken for "unchanged"."""
    try:
        secret = vault.read_live("claude").secret
    except Exception:  # noqa: BLE001 — observation must not sink the poll
        return None
    if not secret:
        return None
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


async def _run_probe(binary: str, timeout: float) -> tuple[bool, str]:
    """(ran_cleanly, detail). Never raises.

    stderr is folded into stdout so a failing probe's last line can go in the
    log; the JSON payload itself is ignored — the credential is the verdict."""
    from ..ai_chat_cli_engine import _terminate_proc_tree

    try:
        proc = await asyncio.create_subprocess_exec(
            *osplat.paths.launch_argv(binary, _PROBE_ARGS),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=_refresh_probe_env(),
            start_new_session=True,
        )
    except Exception as exc:  # noqa: BLE001 — a broken spawn is just a failure
        return False, f"spawn failed: {exc}"
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        # start_new_session put the CLI in its own process group, so killing
        # the leader alone would strand anything it spawned. Take the group
        # down the same way every other CLI spawn in this app does.
        await _terminate_proc_tree(proc)
        return False, "timeout"
    except Exception as exc:  # noqa: BLE001
        return False, f"probe failed: {exc}"
    if proc.returncode != 0:
        tail = (out or b"").decode("utf-8", "replace").strip().splitlines()
        return False, f"exit {proc.returncode}" + (f": {tail[-1][:120]}" if tail else "")
    return True, ""


async def attempt(vault, *, timeout: float = PROBE_TIMEOUT_S) -> str:
    """Ask the CLI to renew the live claude credential. Returns an outcome.

    Serialized and rate-limited: concurrent callers queue on the lock and the
    later ones fall out on the cooldown the first one armed. Never raises — the
    caller is a usage poll that must survive anything this does."""
    async with _lock:
        if _claude_pane_running():
            # No cooldown armed: the moment the pane closes, a probe is useful
            # again and should not have to wait one out.
            return OUTCOME_PANE_RUNNING
        if cooldown_remaining_seconds() > 0:
            return OUTCOME_SKIPPED_COOLDOWN

        try:
            from ..ai_chat_cli_engine import resolve_cli_binary

            binary = resolve_cli_binary("claude")
        except Exception:  # noqa: BLE001 — an unresolvable binary is "no CLI"
            binary = ""
        if not binary:
            _arm_cooldown(SHORT_COOLDOWN_S)
            return OUTCOME_CLI_UNAVAILABLE

        before = await asyncio.to_thread(_live_fingerprint, vault)
        if before is None:
            # Nothing signed in, or the Keychain read failed. Either way there
            # is no baseline, so a later read cannot prove a renewal happened.
            _arm_cooldown(SHORT_COOLDOWN_S)
            return OUTCOME_UNOBSERVABLE

        ran, detail = await _run_probe(binary, timeout)
        if not ran:
            # A declined Keychain dialog surfaces here, so escalate rather than
            # re-prompt on the same cadence forever.
            _arm_failure_backoff()
            log.info(
                "claude delegated refresh probe failed (%d in a row, next in %ds): %s",
                _consecutive_failures, int(cooldown_remaining_seconds()), detail,
            )
            return OUTCOME_FAILED

        after = await asyncio.to_thread(_live_fingerprint, vault)
        if after is None:
            _arm_cooldown(SHORT_COOLDOWN_S)
            return OUTCOME_UNOBSERVABLE

        # The probe ran cleanly, so whatever went wrong before is over.
        _clear_failure_streak()
        if after == before:
            # The CLI had nothing to renew (or declined to). Back off fully —
            # retrying every poll would just re-run the probe for nothing.
            _arm_cooldown(COOLDOWN_S)
            return OUTCOME_UNCHANGED

        # Renewed. Leave the cooldown clear: the caller re-reads immediately and
        # the fresh token is good for hours anyway.
        log.info("claude credential renewed by the CLI")
        return OUTCOME_REFRESHED


async def fetch_claude(home: Path) -> dict:
    """Claude quota, read from the CLI's own ``/usage`` panel.

    Claude Code asks Anthropic under its own identity and prints the answer;
    this reads what it printed. It replaced a direct HTTP call this app made
    while presenting itself as ``claude-code/<version>``. ``home`` locates the
    live credential for the logged-out precheck; the CLI itself still reads
    whichever credential is live.

    No CLI to ask is its own status: ``unavailable`` reads as "this provider
    has no usage surface", which is wrong here and leaves the one thing the
    user can act on — install it, or point the app at the right binary —
    indistinguishable from a panel that failed to render."""
    return await fetch_claude_usage_via_cli(home) or _snapshot("claude", "cli-missing")


async def fetch_claude_account_dir(config_dir: Path) -> dict:
    """Claude quota for an account that signed in inside its own config dir:
    the same ``/usage`` read, run on that dir. Unlike the live login, such an
    account can be measured while another one is active."""
    return await fetch_claude_usage_via_cli(
        config_dir, os.fspath(config_dir)
    ) or _snapshot("claude", "cli-missing")




# ---- resume / session ------------------------------------------------------

_RESUME_RE = re.compile(r"^claude\s+(?:\S+\s+)*--resume\s+(\S+)")


def _resume_id_from_command(command) -> str:
    """Session id from a `claude ... --resume <id>` command ('' otherwise)."""
    m = _RESUME_RE.match(command_text(command).strip())
    return m.group(1) if m else ""


def _session_path(workspace_path: str, session_id: str) -> Path:
    # A managed-account pane resumes inside its profile's isolated config
    # home, but that home's ``projects`` is symlinked back to the real home
    # (credential_vault), so the session jsonl always resolves to the default
    # location — one check covers every account.
    # Stays a SINGLE path: it is what _session_lookup_path reports for
    # diagnostics ("this is where we looked"). The wider search that mirrors
    # the CLI lives in _session_exists below.
    root = claude_projects_root() or Path.home() / ".claude" / "projects"
    project_dir = encode_claude_cwd(workspace_path)
    return root / project_dir / f"{session_id}.jsonl"


def _session_exists(workspace_path: str, session_id: str) -> bool:
    """True when the id names a transcript under ANY project in the root.

    Claude Code >= 2.1.223 widened the id search: "When you pass a session ID,
    Claude Code searches the current project directory and its git worktrees,
    then every other project on this machine. Before v2.1.223, the ID search
    covered only the current project directory and its git worktrees."
    (https://code.claude.com/docs/en/cli-reference)

    Checking only this workspace's project dir therefore rejected resumes the
    CLI would have honoured — the preflight blocked the launch and Agent
    History reported resumable=false, so the pane came back with no memory.
    Sibling project dirs also cover the git worktrees of this project, which
    Claude stores as their own encoded-cwd directories.
    """
    if not session_id or "/" in session_id or session_id.startswith("."):
        return False  # ids are filename stems; never let one walk the tree
    if _session_path(workspace_path, session_id).is_file():
        return True  # this workspace's own project — the common case
    root = claude_projects_root()
    if root is None:
        return False
    name = f"{session_id}.jsonl"
    try:
        return any((d / name).is_file() for d in root.iterdir() if d.is_dir())
    except OSError as err:
        log.debug("scan %s for %s failed: %s", root, name, err)
        return False


# ---- vendor spec -----------------------------------------------------------

def _install_hooks(port_file: str, *, skip: frozenset[str] = frozenset()) -> Any:
    # Lazy import: claude_hooks lives outside cli_vendors, and a module-level
    # import here would be a cycle. Inside a function it is a plain runtime
    # backreference (see test_vendor_modules_import_only_allowed_modules).
    from ..claude_hooks import install_hooks

    return install_hooks(port_file, skip=skip)


def classify_secret(secret: str) -> SlotKind:
    """A parked ``.credentials.json`` is a ``/login`` OAuth credential when it
    carries ``claudeAiOauth.accessToken``. Nothing else is claimed: a
    Console login keeps its API key elsewhere, and a shape this does not
    recognise is left UNKNOWN for the shared side to refuse."""
    try:
        data = json.loads(secret)
    except ValueError:
        return SlotKind.UNKNOWN
    oauth = data.get("claudeAiOauth") if isinstance(data, dict) else None
    if isinstance(oauth, dict) and oauth.get("accessToken"):
        return SlotKind.OAUTH
    return SlotKind.UNKNOWN


# Auth-precedence keys as documented (code.claude.com/docs/en/authentication,
# "Authentication precedence", read 2026-09-16): cloud provider selection,
# then ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, apiKeyHelper all rank ABOVE
# CLAUDE_CODE_OAUTH_TOKEN. A settings ``env`` block sets the same variables,
# and ANTHROPIC_BASE_URL would send the token to another endpoint. Each is
# checked in every settings file the CLI merges, and in the managed policy
# — which is reported as blocking, never overridden.
_PORTABLE_SHADOW_KEYS: tuple[tuple[str, ...], ...] = (
    ("apiKeyHelper",),
    ("env", "ANTHROPIC_AUTH_TOKEN"),
    ("env", "ANTHROPIC_API_KEY"),
    ("env", "ANTHROPIC_BASE_URL"),
    ("env", "CLAUDE_CODE_USE_BEDROCK"),
    ("env", "CLAUDE_CODE_USE_VERTEX"),
    ("env", "CLAUDE_CODE_USE_FOUNDRY"),
    ("env", "CLAUDE_CODE_USE_MANTLE"),
)
_PORTABLE_SETTINGS_FILES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("home", (".claude", "settings.json")),
    ("cwd", (".claude", "settings.json")),
    ("cwd", (".claude", "settings.local.json")),
    ("managed", ("managed-settings.json",)),
)
_PORTABLE_SHADOWING_SETTINGS = tuple(
    (root, parts, key)
    for root, parts in _PORTABLE_SETTINGS_FILES
    for key in _PORTABLE_SHADOW_KEYS
) + (
    # An administrator forcing a sign-in method decides the credential; a
    # pasted token must not be the thing that quietly contradicts it.
    ("managed", ("managed-settings.json",), ("forceLoginMethod",)),
)


# Where this CLI keeps the extensions it installed for itself (read-only
# inventory, cli_extensions). Verified 2026-10-10 against the installed
# binary's --help and the files on disk.
_EXTENSIONS = ExtensionsSpec(sources=(
    ExtensionsSource("plugins-json", (".claude", "plugins", "installed_plugins.json"), "Claude plugin",
        settings=(".claude", "settings.json"), mod_label="Claude mod"),
    ExtensionsSource("hooks", (".claude", "settings.json"), "Claude hook", section=("hooks",)),
))

SPEC = VendorSpec(
    extensions=_EXTENSIONS,
    key="claude",
    # Official standalone CLI network requirements (verified 2026-09-21):
    # https://code.claude.com/docs/en/network-config#network-access-requirements
    # Only concrete hosts: dynamic artifact/Gerrit hosts and arbitrary tools
    # remain outside this declared set, not presumed malicious.
    expected_hosts=(
        "api.anthropic.com", "claude.ai", "claude.com", "platform.claude.com",
        "mcp-proxy.anthropic.com", "downloads.claude.ai", "storage.googleapis.com",
        "registry.npmjs.org", "bridge.claudeusercontent.com", "raw.githubusercontent.com",
        "http-intake.logs.us5.datadoghq.com", "browser-intake-us5-datadoghq.com",
        "formulae.brew.sh", "code.claude.com",
    ),
    # Provider/gateway variables: https://code.claude.com/docs/en/env-vars
    # Keep only presence, never URL values.
    network_override_env_vars=(
        "ANTHROPIC_BASE_URL", "ANTHROPIC_AWS_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL",
        "ANTHROPIC_BEDROCK_MANTLE_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL",
        "ANTHROPIC_FOUNDRY_BASE_URL", "ANTHROPIC_FOUNDRY_RESOURCE",
        "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
        "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_MANTLE",
        "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
    ),
    # Same config home as install_dep; never use the backend reader's fallback
    # search across other accounts when this pane has an isolated config dir.
    data_dirs=lambda ctx: (ctx.path(ctx.env.get("CLAUDE_CONFIG_DIR") or ctx.home / ".claude"),),
    data_dir_env_vars=("CLAUDE_CONFIG_DIR",),
    supports_model=True,
    supports_effort=True,
    known_efforts=('low', 'medium', 'high', 'xhigh', 'max'),
    skills_supported=True,
    # --add-dir adds another project directory, and Claude Code discovers a
    # project's skills below .claude/skills — so the view has to carry that
    # layout for the flag to reach them.
    skills_wiring=SkillsWiring(
        flag="--add-dir",
        view_layout=(".claude", "skills"),
    ),
    label="Claude Code (Anthropic)",
    # `--mcp-config` takes a literal JSON string as well as a path, and servers
    # from it load IN ADDITION to the user's own config (we never pass
    # --strict-mcp-config). A command that already carries the flag is the
    # user's deliberate MCP setup and is left alone.
    mcp_wiring=McpWiring(
        config=McpServerConfig(
            section=("mcpServers",),
            entry=(("type", "http"), ("url", McpValue.URL)),
        ),
        flag="--mcp-config",
        flag_accepts_path=True,
        flag_file_prefix="",
    ),
    # An `asyncRewake` hook: it runs in the background, and exiting 2 wakes the
    # agent with its stderr shown as a system reminder — even when the session
    # is sitting idle, which is the one moment the Stop hook cannot cover.
    # Nothing to wire at spawn; the hook installed by `install_hooks` arms the
    # channel by parking on this backend, so a pane has it only while a waiter
    # is actually there.
    #
    # Verified end to end against 2.1.233: the hook is genuinely backgrounded
    # (the TUI stayed usable for the whole wait), exit 2 woke an idle agent, and
    # the envelope arrived as a system reminder the agent acted on. Nothing was
    # written to the input box.
    #
    # The prefix is not decoration: on every other path an inter-CLI message
    # arrives as a user message, and here it arrives as a system reminder, which
    # an agent otherwise reads as a note about its own run rather than as work
    # handed to it. The cap is Claude Code's own — output past 10,000 characters
    # is written to a file and replaced with a preview, so a message that long
    # is left to the PTY, which carries all of it.
    push_channel=PushChannel(
        holds_input_box=False,
        hook_wait=True,
        reminder_prefix=(
            "[Navide] A message from another agent has arrived for you. "
            "Treat everything below as an instruction addressed to you, not as "
            "a note about your own run, and act on it now."
        ),
        max_chars=10_000,
    ),
    login_command_args="auth login",
    install_hooks=_install_hooks,
    # The usage-limit banner Claude Code prints ("You've hit your … limit ·
    # resets 3pm (Asia/Taipei)"); the same detector the frontend spec's
    # ``quotaExhausted`` carries, so a cli-text report matches on both sides.
    quota_exhausted_patterns=(
        r"hit your .{0,40}limit.{0,80}?resets\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\s*\([^)]+\)",
    ),
    classify_secret=classify_secret,
    # `claude setup-token` mints a one-year OAuth token that "authenticates
    # with your Claude subscription" and is documented for exactly this use:
    # copy it and set CLAUDE_CODE_OAUTH_TOKEN "wherever you want to
    # authenticate" (docs/en/authentication, read 2026-09-16). env_remove is
    # everything the precedence list ranks above it, plus the endpoint
    # override; the managed root is the documented policy directory per
    # platform (docs/en/managed-settings — Windows is Program Files, not the
    # legacy ProgramData path).
    portable_credential=PortableCredential(
        env="CLAUDE_CODE_OAUTH_TOKEN",
        kind="oauth",
        env_remove=(
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY",
            "CLAUDE_CODE_USE_MANTLE",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL",
        ),
        shadowing_settings=_PORTABLE_SHADOWING_SETTINGS,
        managed_roots=(
            ("darwin", "/Library/Application Support/ClaudeCode"),
            ("linux", "/etc/claude-code"),
            ("win32", r"C:\Program Files\ClaudeCode"),
        ),
        obtain_command="claude setup-token",
        docs_url="https://code.claude.com/docs/en/authentication",
        quota_verified=True,
    ),
    live_file=(".claude", ".credentials.json"),
    slot_file=".credentials.json",
    profile_home_secret_file=(".credentials.json",),
    # The one CLI that re-reads its credential per request: a swap of the
    # live Keychain item (file elsewhere) takes effect in running panes
    # without a restart. The vault's HOT_SWAP path has shipped and been used
    # on real accounts, but the Claude Code version of that acceptance was
    # never recorded, so the evidence stays "source" until an A -> B -> A
    # round-trip is logged against a named version. No ``expires_at``: the
    # stored ``expiresAt`` is the ACCESS token's, which Claude Code refreshes
    # on its own — reporting it would mark a valid parked account expired.
    account_switch=AccountSwitchSpec(
        auth_scope="claude",
        method="hot",
        store="keychain",
        evidence="source",
        verified_version="2.1.278",
        keychain_items=(("Claude Code-credentials", ""),),
        # An API key / auth token in the environment, or Navide's own
        # portable long-lived token, replaces the OAuth login entirely.
        shadowing_env=("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"),
        # The OAuth token variable, then everything the documented precedence
        # list ranks above it, plus the endpoint override.
        credential_env_vars=(
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY",
            "CLAUDE_CODE_USE_MANTLE",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL",
        ),
        resume="native",
        todo="hot swap shipped and used on real accounts; record an A -> B -> A round-trip against 2.1.278",
    ),
    # login_home_secret_file stays None: claude's login-home secret lives in
    # a path-hashed Keychain item, not a peekable file (see credential_vault).
    # The vault's claude behavior branches (Keychain dual-track, oauthAccount,
    # wiped guard, login CLAUDE_CONFIG_DIR + env removals) are the documented
    # exemption list and are NOT routed through this spec.
    resume_id_from_command=_resume_id_from_command,
    session_path=_session_path,
    session_exists=_session_exists,
    home_env_vars=(
        "CLAUDE_CONFIG_DIR",
        # Claude Code stamps its own subprocesses with this; inherited, a
        # spawned pane silently skips transcript saving (blank pane after
        # restart — root-caused live 2026-08-07).
        "CLAUDE_CODE_CHILD_SESSION",
    ),
    make_log_reader=ClaudeLogReader,
    # Step 2 — Agent CLIs (≥ 1 required) + Analyzer
    # Anthropic now lists `curl -fsSL https://claude.ai/install.sh | bash` (or
    # the Homebrew cask) as the primary install and npm under "Advanced
    # installation options". npm is still officially supported and is kept here
    # deliberately: the rest of this Dep describes an npm-managed install —
    # requires_binaries gates on npm, npm_package drives duplicate-install
    # detection and the uninstall command, and `claude update` reads
    # .last-update-result.json. Switching install_cmd alone would install a
    # native binary none of those fields describe.
    install_dep=Dep("claude", "Claude Code (Anthropic)", "Anthropic Claude CLI", "agent_cli",
        ["claude", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="npm install -g @anthropic-ai/claude-code", needs_terminal=True,
        requires_binaries=("npm",),
        optional=True, docs_url="https://platform.claude.com/docs/claude-code",
        update_cmd="claude update", doctor_cmd="claude doctor",
        npm_package="@anthropic-ai/claude-code",
        update_state_file=".last-update-result.json",
        config_home_env="CLAUDE_CONFIG_DIR", config_home_default=".claude",
        autoupdate_env="DISABLE_AUTOUPDATER"),
    # claude writes fullscreenBootPending[pid] into ~/.claude.json when it
    # starts in fullscreen and clears it from a SIGTERM handler on the way out.
    # A SIGKILL never runs that handler, so the entry survives; the next start
    # sees a pending entry whose pid is gone, counts a strike, and at two
    # strikes writes fullscreenAutoDisabled — which is how the dim header row
    # (previous prompts shown when scrolling up) disappears. 3s is the room the
    # handler needs for a read-modify-write of that file, and the master stays
    # open across it because a HUP mid-write is the same lost entry.
    shutdown=ShutdownSpec(graceful=True, grace_s=3.0, defer_master_close=True),
)
