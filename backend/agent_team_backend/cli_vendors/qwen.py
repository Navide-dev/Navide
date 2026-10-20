"""Qwen Code CLI conversation log reader.

Layout (root = $QWEN_RUNTIME_DIR, default ~/.qwen):
  <root>/projects/<encoded-cwd>/chats/<sessionId>.jsonl
  <root>/projects/<encoded-cwd>/chats/archive/<sessionId>.jsonl  (archived —
  still history, so listing/attribution include it)

<encoded-cwd> uses the exact encoding Claude Code uses for its projects dirs
(every non-alphanumeric char → "-"), so encode_claude_cwd is reused.

Every JSONL record carries uuid/parentUuid/sessionId/timestamp/type/cwd.
Token-relevant lines have type=="assistant" with usageMetadata populated.
Mapping into TokenUsage (cache folded into input, reasoning into output):
  input_tokens  = promptTokenCount (already includes cachedContentTokenCount,
                  Qwen's cache-read figure)
  output_tokens = candidatesTokenCount + thoughtsTokenCount
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..log_readers.base import (
    ActivityEvent,
    IncrementalParseResult,
    LogReader,
    TokenUsage,
    activity_high_water,
    read_jsonl_tail,
    set_activity_high_water,
    user_prompt_text,
)
from ..log_readers.base import encode_claude_cwd
from .base import ExtensionsSource, ExtensionsSpec  # noqa: F401
from .base import (
    AccountSwitchSpec,
    Dep,
    McpServerConfig,
    McpValue,
    McpWiring,
    PushChannel,
    SkillsWiring,
    VendorSpec,
    VendorRuntimeContext,
    command_text,
    dotenv_extract,
    dotenv_merge,
)
from ..usage_common import (
    HTTP_TIMEOUT,
    _epoch_to_iso,
    _num,
    _snapshot,
    _window,
    parse_retry_after,
)

log = logging.getLogger("agent_team_backend.log_readers.qwen")

# Automated / mid-turn user records. Marker binding searches raw file text, so
# these never affect it — but they are not human prompts and must not count as
# user activity (cron/notification are injected by the CLI itself; a mid-turn
# message arrives while assistant records already carry the activity signal).
# agent_mention / agent_message (Qwen Code 0.25) are session multi-agent
# records another agent writes into the transcript; upstream never treats them
# as a prompt or a turn boundary (chatRecordingService.rebuildTurnBoundaries).
_EXCLUDED_USER_SUBTYPES = (
    "mid_turn_user_message", "cron", "notification", "agent_mention", "agent_message",
)

# Qwen writes no end-of-turn record, so a turn is closed either by the next
# real user prompt or — for the latest turn, which has no successor — once the
# file has stopped growing for _TURN_IDLE_SECONDS. File mtime stands in for
# wall-clock activity: the log's own timestamps are ISO strings, and a write to
# the file is the same signal with none of the parsing.
_TURN_IDLE_SECONDS = 8.0
_STATE_PREFIX = "qwen_turn::"
_TEXT_PREFIX = "qwen_text::"
_TEXT_MAX_CHARS = 4_000


def _cap_text(text: str) -> str:
    if len(text) <= _TEXT_MAX_CHARS:
        return text
    half = _TEXT_MAX_CHARS // 2
    return f"{text[:half]}\n…\n{text[-half:]}"


def _parts_text(rec: dict) -> str:
    """Joined text blocks of a record's message.parts[] (user and assistant
    records share the shape)."""
    msg = rec.get("message")
    parts = msg.get("parts") if isinstance(msg, dict) else None
    if not isinstance(parts, list):
        return ""
    return "\n".join(
        p["text"] for p in parts
        if isinstance(p, dict) and isinstance(p.get("text"), str)
    )


def _read_sentinel(seen_keys: set[str], prefix: str) -> str:
    for k in seen_keys:
        if k.startswith(prefix):
            return k[len(prefix):]
    return ""


def _write_sentinel(seen_keys: set[str], prefix: str, value: str) -> None:
    seen_keys.difference_update({k for k in seen_keys if k.startswith(prefix)})
    if value:
        seen_keys.add(f"{prefix}{value}")


def qwen_root() -> Path:
    """Qwen Code's runtime output root ($QWEN_RUNTIME_DIR, default ~/.qwen)."""
    env = os.environ.get("QWEN_RUNTIME_DIR")
    return Path(env) if env else Path.home() / ".qwen"


def _int(v) -> int:  # noqa: ANN001
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return 0


def _usage_tokens(usage: dict) -> tuple[int, int]:
    """promptTokenCount already includes cachedContentTokenCount (cache read),
    matching TokenUsage's cache-folded-into-input design; thought (reasoning)
    tokens fold into output like other vendors' reasoning tokens."""
    input_tokens = _int(usage.get("promptTokenCount"))
    output_tokens = _int(usage.get("candidatesTokenCount")) + _int(
        usage.get("thoughtsTokenCount")
    )
    return input_tokens, output_tokens


class QwenLogReader(LogReader):
    vendor: str = "qwen"

    #: parse_activity walks a dense ascending line counter and resumes from
    #: one high-water mark, so an old file can be seeded to EOF by counting
    #: lines rather than replaying it (log_readers.base).
    activity_resumes_by_line: bool = True

    def _projects_root(self) -> Path:
        return qwen_root() / "projects"

    def project_dirs(self) -> list[Path]:
        """The single projects root (empty list when it doesn't exist)."""
        default = self._projects_root()
        return [default] if default.is_dir() else []

    def _chats_files(self, chats: Path) -> list[Path]:
        """All session jsonl files in one chats dir, archive/ included."""
        out: list[Path] = []
        for d in (chats, chats / "archive"):
            if not d.is_dir():
                continue
            try:
                for f in d.iterdir():
                    if f.is_file() and f.suffix == ".jsonl":
                        out.append(f)
            except OSError as err:
                log.debug("enumerate %s failed: %s", d, err)
        return out

    def session_files(self) -> list[Path]:
        out: list[Path] = []
        for root in self.project_dirs():
            try:
                for child in root.iterdir():
                    if child.is_dir():
                        out.extend(self._chats_files(child / "chats"))
            except OSError as err:
                log.debug("enumerate %s failed: %s", root, err)
        return out

    def session_files_for_workspace(self, workspace_path: str) -> list[Path]:
        """Only the jsonl files under this workspace's project chats dir.

        Qwen names each project dir after the Claude-encoded cwd, so one
        workspace maps to exactly one folder — enumerate just that folder.
        """
        encoded = encode_claude_cwd(workspace_path)
        out: list[Path] = []
        for root in self.project_dirs():
            out.extend(self._chats_files(root / encoded / "chats"))
        return out

    def _in_chats_dir(self, path: Path) -> bool:
        parent = path.parent
        if parent.name == "archive":
            parent = parent.parent
        return parent.name == "chats"

    def cwd_from_file(self, path: Path) -> str:
        """Every record carries the session's cwd — read it from the first
        parseable line (exact, unlike decoding the "-"-encoded dir name)."""
        try:
            with path.open(encoding="utf-8") as fh:
                for raw in fh:
                    raw = raw.strip()
                    if not raw:
                        continue
                    try:
                        rec = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(rec, dict):
                        return str(rec.get("cwd") or "")
        except OSError as err:
            log.debug("open %s failed: %s", path, err)
        return ""

    def session_id_from_path(self, path: Path) -> str:
        """Session files are named <sessionId>.jsonl inside chats/ (or
        chats/archive/). Anything else (writer locks, stray siblings) returns
        '' so the resume-binding sink never coins a bogus id."""
        if path.suffix != ".jsonl" or not self._in_chats_dir(path):
            return ""
        return path.stem

    def has_session(self, session_id: str) -> bool:
        """True when any project's chats dir (archive included) holds
        <session_id>.jsonl. The resume preflight uses this so a stale
        persisted id fails fast instead of launching a doomed
        `qwen --resume <id>`."""
        session_id = session_id.strip()
        if not session_id:
            return False
        name = f"{session_id}.jsonl"
        for root in self.project_dirs():
            try:
                for child in root.iterdir():
                    if not child.is_dir():
                        continue
                    chats = child / "chats"
                    if (chats / name).is_file() or (chats / "archive" / name).is_file():
                        return True
            except OSError:
                continue
        return False

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        out: list[TokenUsage] = []
        file_cwd = self.cwd_from_file(path)
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
                usage = rec.get("usageMetadata")
                if not isinstance(usage, dict):
                    continue

                dedup_key = str(rec.get("uuid") or "")
                if not dedup_key or dedup_key in seen_keys:
                    continue

                input_tokens, output_tokens = _usage_tokens(usage)
                if input_tokens == 0 and output_tokens == 0:
                    continue

                seen_keys.add(dedup_key)
                out.append(
                    TokenUsage(
                        vendor="qwen",
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                        cwd=str(rec.get("cwd") or "") or file_cwd,
                        session_id=session_id,
                        file_path=str(path),
                        dedup_key=dedup_key,
                        timestamp=str(rec.get("timestamp") or ""),
                        model=str(rec.get("model") or ""),
                        cli_version=str(rec.get("version") or ""),
                        cache_read_tokens=_int(usage.get("cachedContentTokenCount")),
                    )
                )
        return out

    def parse_incremental(
        self,
        path: Path,
        checkpoint: dict,
    ) -> IncrementalParseResult:
        """Parse only complete JSONL records after the persisted byte offset.

        Qwen appends whole records under a per-session writer lock, so a byte
        offset plus a short recent-uuid window guarantees no double count.
        """
        records, final_checkpoint, rotated = read_jsonl_tail(path, checkpoint)
        recent = [] if rotated else [str(k) for k in checkpoint.get("recent_keys", [])][-64:]
        recent_set = set(recent)
        out: list[TokenUsage] = []
        session_id = path.stem

        for end, rec in records:
            if rec is None or rec.get("type") != "assistant":
                continue
            usage = rec.get("usageMetadata")
            if not isinstance(usage, dict):
                continue
            dedup_key = str(rec.get("uuid") or "")
            if not dedup_key or dedup_key in recent_set:
                continue
            input_tokens, output_tokens = _usage_tokens(usage)
            if input_tokens == 0 and output_tokens == 0:
                continue
            recent.append(dedup_key)
            recent = recent[-64:]
            recent_set = set(recent)
            event_checkpoint = dict(final_checkpoint)
            event_checkpoint["offset"] = end
            event_checkpoint["recent_keys"] = list(recent)
            out.append(TokenUsage(
                vendor="qwen",
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cwd=str(rec.get("cwd") or ""),
                session_id=session_id,
                file_path=str(path),
                dedup_key=dedup_key,
                timestamp=str(rec.get("timestamp") or ""),
                model=str(rec.get("model") or ""),
                checkpoint=event_checkpoint,
                cli_version=str(rec.get("version") or ""),
                cache_read_tokens=_int(usage.get("cachedContentTokenCount")),
            ))

        final_checkpoint["recent_keys"] = recent
        return IncrementalParseResult(out, final_checkpoint)

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Emit `agent_active` for assistant records and real user prompts, and
        `turn_complete` once per user-facing turn.

        Qwen's chat log carries no explicit end-of-turn record (assistant
        records have no stop_reason, and one user turn spans several
        assistant/tool steps), so the turn boundary is inferred: the next real
        user prompt closes the previous turn, and the latest turn is flushed
        once the file has been quiet for _TURN_IDLE_SECONDS. turn_complete
        carries the assistant's closing text, which is what lets a Qwen pane
        send inter-CLI messages — the frontend only parses the
        ---MSG-START--- protocol out of a turn_complete that has text.

        Automated user records (_EXCLUDED_USER_SUBTYPES) are not user activity
        and do not open a turn.
        """
        out: list[ActivityEvent] = []
        cwd = self.cwd_from_file(path)
        session_id = path.stem
        state_raw = _read_sentinel(seen_keys, _STATE_PREFIX)
        state: dict | None = None
        if state_raw:
            try:
                parsed = json.loads(state_raw)
                state = parsed if isinstance(parsed, dict) else None
            except json.JSONDecodeError:
                state = None
        last_text = _read_sentinel(seen_keys, _TEXT_PREFIX)

        def _complete(state: dict, detail: str) -> ActivityEvent:
            # The turn's own last record supplies the timestamp. It must be a
            # real one: the frontend dedups messaging turns by timestamp and
            # treats an unparseable one as always-fresh, which would resend a
            # turn delivered twice and replay history after a backend restart.
            return ActivityEvent(
                vendor="qwen", event_type="turn_complete",
                cwd=cwd, session_id=session_id, file_path=str(path),
                dedup_key=f"turn:{int(state['idx'])}",
                timestamp=str(state.get("ts") or ""), detail=detail,
                text=last_text,
            )

        try:
            fh = path.open(encoding="utf-8")
        except OSError:
            return out

        # Every line that passes the seen test is marked immediately, before
        # the JSON parse or the record-type filter can skip it, and the walk is
        # a dense ascending scan from line 1 — so one high-water mark says the
        # same thing as the per-line keys did. See log_readers.base.
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
                        # read on the next poll: advancing past it would
                        # drop that line's events for good (GitHub #21).
                        if not raw_line.endswith("\n"):
                            break
                        last_line = line_no
                        continue
                    last_line = line_no

                    rtype = rec.get("type")
                    ts = str(rec.get("timestamp") or "")
                    is_user_prompt = (
                        rtype == "user"
                        and str(rec.get("subtype") or "") not in _EXCLUDED_USER_SUBTYPES
                    )
                    if rtype == "assistant" or is_user_prompt:
                        # User prompts live in message.parts[].text; join them so
                        # the frontend can name the pane from the first user text.
                        text = ""
                        if is_user_prompt:
                            # A new prompt closes the previous turn (if still open).
                            if state is not None and not state.get("flushed"):
                                out.append(_complete(state, "boundary"))
                                last_text = ""
                            idx = (int(state["idx"]) + 1) if state is not None else 0
                            state = {"idx": idx, "flushed": False, "ts": ts}
                            text = user_prompt_text(_parts_text(rec))
                        else:
                            # An assistant record with no preceding prompt (a
                            # resumed session joined mid-turn) still opens a turn.
                            if state is None or state.get("flushed"):
                                idx = (int(state["idx"]) + 1) if state is not None else 0
                                state = {"idx": idx, "flushed": False, "ts": ts}
                            state["ts"] = ts
                            reply = _parts_text(rec).strip()
                            if reply:
                                last_text = _cap_text(reply)
                        out.append(ActivityEvent(
                            vendor="qwen",
                            event_type="agent_active",
                            cwd=cwd, session_id=session_id, file_path=str(path),
                            dedup_key=key, timestamp=ts,
                            detail=str(rtype), text=text,
                        ))

                # The latest turn has no following prompt; flush it once the file
                # has stopped being written to for long enough to call it finished.
                if state is not None and not state.get("flushed"):
                    try:
                        quiet_for = time.time() - path.stat().st_mtime
                    except OSError:
                        quiet_for = 0.0
                    if quiet_for >= _TURN_IDLE_SECONDS:
                        out.append(_complete(state, "idle"))
                        state["flushed"] = True
                        last_text = ""

        finally:
            set_activity_high_water(seen_keys, last_line)
            _write_sentinel(
                seen_keys, _STATE_PREFIX, json.dumps(state) if state is not None else ""
            )
            _write_sentinel(seen_keys, _TEXT_PREFIX, last_text)
        return out

    # ---- attribution/watch hooks (see log_readers.base.LogReader) --------

    binds_by_marker_file = True
    emits_session_sink = True
    binds_new_session_single_candidate = True

    def workspace_match(
        self, usage: TokenUsage, ws_path: str,
        owner_workspace: str | None = None,
    ) -> bool | None:
        # Reader emits cwd = the record's own cwd field (every jsonl line
        # carries the session's exact cwd).
        return bool(usage.cwd and usage.cwd == ws_path)

    def pane_cwd_match(
        self, usage: TokenUsage, pane_cwd: str, pane_id: str
    ) -> bool | None:
        return usage.cwd == pane_cwd


# ---- usage quota -----------------------------------------------------------
# Alibaba ModelStudio Coding Plan. The quota endpoint is the console gateway
# API — undocumented. The request says ``Navide`` and carries the API key the
# user configured, which is what the gateway actually authenticates.
# Origin/Referer stay because the gateway rejects cross-site posts without
# them; they name the console the API belongs to, not a client we are
# pretending to be. The alternate region is retried on failure.

_QWEN_USAGE_QUERY = (
    "?action=zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2"
    "&product=broadscope-bailian&api=queryCodingPlanInstanceInfoV2"
)
QWEN_INTL_USAGE_URL = (
    "https://modelstudio.console.alibabacloud.com/data/api.json"
    + _QWEN_USAGE_QUERY + "&currentRegionId=ap-southeast-1"
)
QWEN_CN_USAGE_URL = (
    "https://bailian.console.aliyun.com/data/api.json"
    + _QWEN_USAGE_QUERY + "&currentRegionId=cn-beijing"
)
# (url, commodityCode, Origin, Referer) per region, tried in order.
QWEN_REGIONS = (
    (QWEN_INTL_USAGE_URL, "sfm_codingplan_public_intl",
     "https://modelstudio.console.alibabacloud.com",
     "https://modelstudio.console.alibabacloud.com/ap-southeast-1/"
     "?tab=coding-plan#/efm/coding_plan"),
    (QWEN_CN_USAGE_URL, "sfm_codingplan_public_cn",
     "https://bailian.console.aliyun.com",
     "https://bailian.console.aliyun.com/"),
)
# The env key qwen-code itself resolves, then CodexBar's accepted aliases.
QWEN_ENV_KEYS = (
    "BAILIAN_CODING_PLAN_API_KEY",
    "ALIBABA_CODING_PLAN_API_KEY",
    "ALIBABA_QWEN_API_KEY",
    "DASHSCOPE_API_KEY",
)

_QWEN_WINDOWS = (
    ("per5Hour", "session", "Session (5h)"),
    ("perWeek", "weekly", "Weekly"),
    ("perBillMonth", "monthly", "Monthly"),
)


def _qwen_env_lookup(mapping: dict) -> str | None:
    for key in QWEN_ENV_KEYS:
        value = mapping.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _parse_dotenv(text: str) -> dict:
    """Minimal ``KEY=VALUE`` .env parse (comments/blank lines skipped,
    ``export`` prefix and surrounding quotes stripped) — enough for the .env
    files qwen-code resolves its API key from."""
    result: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        result[key] = value.strip().strip("'\"")
    return result


def read_qwen_credentials(home: Path, env: dict | None = None) -> str | None:
    """The Alibaba ModelStudio Coding Plan API key, resolved the way qwen-code
    does (read-only): process env first, then ``~/.qwen/.env``, then the
    ``env`` object in ``~/.qwen/settings.json``."""
    key = _qwen_env_lookup(env or {})
    if key is not None:
        return key
    qwen_home = home / ".qwen"
    try:
        key = _qwen_env_lookup(
            _parse_dotenv((qwen_home / ".env").read_text(encoding="utf-8")))
    except OSError:
        key = None
    if key is not None:
        return key
    try:
        settings = json.loads(
            (qwen_home / "settings.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    env_obj = settings.get("env") if isinstance(settings, dict) else None
    return _qwen_env_lookup(env_obj) if isinstance(env_obj, dict) else None


QWEN_ACCOUNT_SCOPE = "coding-plan"


def _qwen_env_file(home: Path) -> Path:
    return home / ".qwen" / ".env"


def _qwen_settings_file(home: Path) -> Path:
    return home / ".qwen" / "settings.json"


def _qwen_credential_file(home: Path) -> Path:
    """The file a switch rewrites: whichever of ``~/.qwen/.env`` and
    ``~/.qwen/settings.json`` currently carries the Coding Plan key, in the
    order qwen-code consults them; ``.env`` when neither does. A key in the
    process environment outranks both and is out of the vault's reach."""
    for path in (_qwen_env_file(home), _qwen_settings_file(home)):
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        if _qwen_extract(text, QWEN_ACCOUNT_SCOPE) is not None:
            return path
    return _qwen_env_file(home)


def _qwen_extract(document: str | None, scope: str) -> str | None:
    """The Coding Plan key out of either credential file, as the JSON text
    ``{"<ENV NAME>": "<key>"}`` so a restore puts it back under the same
    variable name. A settings.json document is told apart by its shape."""
    if document is None or scope != QWEN_ACCOUNT_SCOPE:
        return None
    if document.lstrip().startswith("{"):
        try:
            settings = json.loads(document)
        except ValueError:
            return None
        env_obj = settings.get("env") if isinstance(settings, dict) else None
        mapping = env_obj if isinstance(env_obj, dict) else {}
        for key in QWEN_ENV_KEYS:
            value = mapping.get(key)
            if isinstance(value, str) and value.strip():
                return json.dumps({key: value.strip()}, separators=(",", ":"))
        return None
    return dotenv_extract(document, QWEN_ENV_KEYS)


def _qwen_merge(document: str | None, scope: str, portion: str | None) -> str:
    """Rewrite only the Coding Plan key: in settings.json the ``env`` object's
    key-variant entries; in ``.env`` the lines naming them. Everything else
    in the file is carried through (settings.json is re-serialised; .env
    lines are kept verbatim)."""
    if scope != QWEN_ACCOUNT_SCOPE:
        raise ValueError(f"qwen has no credential scope {scope!r}")
    text = document or ""
    if not text.lstrip().startswith("{"):
        return dotenv_merge(text, QWEN_ENV_KEYS, portion)
    entry = json.loads(portion) if portion is not None else None
    if entry is not None and (
        not isinstance(entry, dict) or len(entry) != 1
        or next(iter(entry)) not in QWEN_ENV_KEYS
        or not isinstance(next(iter(entry.values())), str)
    ):
        raise ValueError("qwen credential portion must map one Coding Plan variable")
    settings = json.loads(text)
    if not isinstance(settings, dict):
        raise ValueError("settings.json is not a JSON object")
    env_obj = settings.get("env")
    if env_obj is None:
        env_obj = settings["env"] = {}
    elif not isinstance(env_obj, dict):
        raise ValueError("settings.json env is not an object")
    for key in QWEN_ENV_KEYS:
        env_obj.pop(key, None)
    if entry:
        env_obj.update(entry)
    if not env_obj and entry is None:
        settings.pop("env")
    return json.dumps(settings, indent=2)


def identity_from_secret(secret):
    """A scoped slot holds ``{"<ENV NAME>": "<key>"}``; signed in when the key
    is non-empty. Alibaba's key carries no identity to show."""
    data = None
    if secret is not None:
        try:
            data = json.loads(secret)
        except ValueError:
            data = None
    signed_in = isinstance(data, dict) and any(
        isinstance(v, str) and v.strip() for k, v in data.items() if k in QWEN_ENV_KEYS
    )
    return {"email": None, "signedIn": signed_in}


def qwen_legacy_oauth_present(home: Path) -> bool:
    """True when the defunct Qwen OAuth credential file exists. The free tier
    it belonged to was discontinued and no quota endpoint accepts the token,
    so it maps to status=unavailable rather than inventing client-side counts."""
    return (home / ".qwen" / "oauth_creds.json").is_file()


def _qwen_reset_iso(raw) -> str | None:
    """``*QuotaNextRefreshTime`` arrives as epoch ms, epoch s, ISO8601 or
    ``yyyy-MM-dd HH:mm[:ss]`` depending on gateway version."""
    num = _num(raw)
    if num is not None:
        return _epoch_to_iso(num / 1000 if num > 1e11 else num)
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        parsed = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.isoformat()


def _qwen_instance_infos(data, depth: int = 0) -> list | None:
    """Deep-search the console-gateway envelope for
    ``codingPlanInstanceInfos`` — the data/statusCode wrapping shifts between
    gateway versions, so CodexBar searches by key and so do we."""
    if depth > 6 or not isinstance(data, dict):
        return None
    infos = data.get("codingPlanInstanceInfos")
    if isinstance(infos, list):
        return infos
    for value in data.values():
        found = _qwen_instance_infos(value, depth + 1)
        if found is not None:
            return found
    return None


def normalize_qwen(data: dict) -> tuple[list[dict], str | None]:
    """First usable ``codingPlanInstanceInfos[]`` entry: per5Hour/perWeek/
    perBillMonth Used/Total quota pairs -> session/weekly/monthly windows;
    planName (falling back to instanceName/packageName) -> planType."""
    for info in _qwen_instance_infos(data) or []:
        if not isinstance(info, dict):
            continue
        windows: list[dict] = []
        for prefix, kind, label in _QWEN_WINDOWS:
            total = _num(info.get(f"{prefix}TotalQuota"))
            used = _num(info.get(f"{prefix}UsedQuota"))
            if not total or used is None:
                continue
            windows.append(_window(
                kind, label, used / total * 100,
                _qwen_reset_iso(info.get(f"{prefix}QuotaNextRefreshTime"))))
        if not windows:
            continue
        plan = next(
            (info[k] for k in ("planName", "instanceName", "packageName")
             if isinstance(info.get(k), str) and info[k]), None)
        return windows, plan
    return [], None


async def _fetch_qwen_region(client, key: str, region: tuple) -> dict:
    """One region's console-gateway query -> snapshot.

    The API key is the credential the gateway checks; the browser User-Agent
    this used to send was decoration and is gone. Origin/Referer stay: the
    gateway refuses cross-site posts without them, and they name the console
    the endpoint belongs to rather than claiming to be its client."""
    url, commodity_code, origin, referer = region
    headers = {
        "Authorization": f"Bearer {key}",
        "x-api-key": key,
        "X-DashScope-API-Key": key,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Navide",
        "Origin": origin,
        "Referer": referer,
    }
    resp = await client.post(
        url, headers=headers,
        json={"queryCodingPlanInstanceInfoRequest":
              {"commodityCode": commodity_code}})
    if resp.status_code in (401, 403):
        return _snapshot("qwen", "expired")
    if resp.status_code == 429:
        snap = _snapshot("qwen", "rate-limited")
        snap["retryAfterSec"] = parse_retry_after(resp.headers.get("Retry-After"))
        return snap
    if resp.status_code != 200:
        return _snapshot("qwen", "error", error=f"HTTP {resp.status_code}")
    try:
        payload = resp.json()
    except ValueError:
        return _snapshot("qwen", "error", error="non-JSON response")
    # The gateway tunnels auth failures (invalid key, api-key mode unavailable
    # in this region) through HTTP 200 + a NeedLogin marker in the body.
    if "NeedLogin" in json.dumps(payload):
        return _snapshot("qwen", "expired")
    windows, plan = normalize_qwen(payload if isinstance(payload, dict) else {})
    if not windows:
        return _snapshot("qwen", "error",
                         error="response had no usable quota fields")
    return _snapshot("qwen", "ok", windows=windows, plan_type=plan)


async def fetch_qwen(home: Path, env: dict | None = None) -> dict:
    env = env if env is not None else dict(os.environ)
    key = read_qwen_credentials(home, env)
    if key is None:
        if qwen_legacy_oauth_present(home):
            return _snapshot(
                "qwen", "unavailable",
                error="legacy Qwen OAuth has no usage API (free tier "
                      "discontinued; a Coding Plan API key is required)")
        return _snapshot("qwen", "no-credentials")
    import httpx

    first: dict | None = None
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        for region in QWEN_REGIONS:
            try:
                snap = await _fetch_qwen_region(client, key, region)
            except httpx.HTTPError as err:
                snap = _snapshot("qwen", "error", error=str(err))
            # ok answers; 429 means the key works, so the alternate region
            # would not help. Everything else retries the other region,
            # surfacing the FIRST failure when both refuse.
            if snap["status"] in ("ok", "rate-limited"):
                return snap
            first = first or snap
    return first or _snapshot("qwen", "error", error="no region answered")


# ---- resume / session ------------------------------------------------------

_RESUME_RE = re.compile(r"^qwen\s+(?:\S+\s+)*(?:--resume|-r)\s+([^-\s]\S*)")


def _resume_id_from_command(command) -> str:
    """Session id from a `qwen ... --resume <id>` / `-r <id>` command
    ('' otherwise)."""
    m = _RESUME_RE.match(command_text(command).strip())
    return m.group(1) if m else ""


def _session_path(workspace_path: str, session_id: str) -> Path:
    # Qwen Code reuses Claude's cwd encoding for its per-project dirs; the
    # session file is named after the id `qwen --resume <id>` accepts.
    project_dir = encode_claude_cwd(workspace_path)
    return qwen_root() / "projects" / project_dir / "chats" / f"{session_id}.jsonl"


def _session_exists(workspace_path: str, session_id: str) -> bool:
    # Ask the reader (which also scans chats/archive/ and other project dirs)
    # so an archived-but-resumable session still passes preflight.
    return QwenLogReader().has_session(session_id)


# ---- vendor spec -----------------------------------------------------------

def _install_hooks(port_file: str, *, skip: frozenset[str] = frozenset()) -> Any:
    # Qwen Code ships Claude's hook design, so the same mechanism gives its
    # panes the one signal the PTY cannot provide. Lazy import — see claude.py.
    from ..qwen_hooks import install_hooks

    return install_hooks(port_file, skip=skip)


def _risk_data_dirs(ctx: VendorRuntimeContext) -> tuple[Path, ...]:
    # Verified in installed @qwen-code/qwen-code Storage.getRuntimeBaseDir:
    # QWEN_RUNTIME_DIR overrides runtime output, otherwise QWEN_HOME is used.
    # Config remains at QWEN_HOME. Storage.resolvePath expands ~/ itself.
    def path(value: str | Path) -> Path:
        text = str(value)
        if text == "~":
            return ctx.home
        if text.startswith(("~/", "~\\")):
            return ctx.home.joinpath(*re.split(r"[/\\]+", text[2:]))
        return ctx.path(value)

    root = path(ctx.env.get("QWEN_HOME") or ctx.home / ".qwen")
    runtime = ctx.env.get("QWEN_RUNTIME_DIR")
    return tuple(dict.fromkeys((root, path(runtime)))) if runtime else (root,)


# Where this CLI keeps the extensions it installed for itself (read-only
# inventory, cli_extensions). Verified 2026-10-10 against the installed
# binary's --help and the files on disk.
_EXTENSIONS = ExtensionsSpec(sources=(
    ExtensionsSource("qwen-extensions", (".qwen", "extensions"), "Qwen extension"),
    ExtensionsSource("hooks", (".qwen", "settings.json"), "Qwen hook", section=("hooks",)),
))

SPEC = VendorSpec(
    extensions=_EXTENSIONS,
    key="qwen",
    # OpenAI-compatible/custom providers; quota hosts cover another interface.
    expected_hosts=(),
    data_dirs=_risk_data_dirs,
    data_dir_env_vars=("QWEN_HOME", "QWEN_RUNTIME_DIR"),
    supports_model=True,
    # Verified 2026-08-15: QWEN_HOME *is* the .qwen directory (its
    # resolveQwenHome falls back to ~/.qwen), so skills sit one level in.
    skills_supported=True,
    skills_wiring=SkillsWiring(
        root_env="QWEN_HOME",
        root_home=(".qwen",),
        skills_rel=("skills",),
    ),
    label="Qwen Code (Alibaba Cloud)",
    # `--mcp-config` is undocumented in `qwen --help` but registered, takes
    # inline JSON or a path, and merges over settings.json. No "type"
    # discriminator: httpUrl is streamable HTTP, a plain url would be SSE.
    mcp_wiring=McpWiring(
        config=McpServerConfig(
            section=("mcpServers",),
            entry=(("httpUrl", McpValue.URL),),
        ),
        flag="--mcp-config",
        flag_file_prefix="",
    ),
    # `--input-file` is registered but absent from `qwen --help` (verified in
    # 0.21.12's own bundle: "File path for receiving remote input commands
    # (bidirectional sync). An external process writes JSONL commands; the TUI
    # watches and processes them"). The TUI polls the file every 500ms and hands
    # each `submit` record to the SAME queue a typed message goes through, so
    # nothing reaches the composer and a busy pane simply queues it.
    #
    # Two properties of that watcher decide how push_delivery writes the file,
    # both read out of RemoteInputWatcher in 0.21.12:
    #   - it consumes only up to the last newline it can see, so a record is
    #     written as one complete line;
    #   - it re-reads the file from the start if it ever SHRINKS (or if the
    #     bytes it already consumed change), so the file is created empty at
    #     spawn and only ever appended to. Rotating it would replay every
    #     message in it.
    push_channel=PushChannel(
        holds_input_box=False,
        input_file_flag="--input-file",
        record_type="submit",
    ),
    install_hooks=_install_hooks,
    # Late-bound on purpose: the module global is looked up at call time, so
    # tests can monkeypatch `cli_vendors.qwen.fetch_qwen` and the poller sees
    # the patched function. Binding the function object directly would freeze
    # the original into the spec.
    fetch_usage=lambda home: fetch_qwen(home),
    # Multi-account: the Coding Plan API key, resolved the way qwen-code does
    # (process env > ~/.qwen/.env > settings.json "env"). A switch rewrites
    # the key in whichever file holds it and nothing else in that file. The
    # key is read at startup: restart, then ``qwen --resume <uuid>``. The
    # legacy ``oauth_creds.json`` (discontinued free tier) is not an account.
    live_file=(".qwen", ".env"),
    live_file_resolver=_qwen_credential_file,
    slot_file="credential.json",
    identity_from_secret=identity_from_secret,
    account_switch=AccountSwitchSpec(
        auth_scope="qwen",
        method="restart",
        store="compound-file",
        evidence="source",
        verified_version="0.22.2",
        scopes=(QWEN_ACCOUNT_SCOPE,),
        extract=_qwen_extract,
        merge=_qwen_merge,
        # read_qwen_credentials: the process environment is consulted first.
        shadowing_env=QWEN_ENV_KEYS,
        resume="native",
        todo="a Coding Plan key in the pane environment outranks both files and cannot be switched; no real-account round-trip recorded",
    ),
    resume_id_from_command=_resume_id_from_command,
    session_path=_session_path,
    session_exists=_session_exists,
    home_env_vars=("QWEN_HOME", "QWEN_RUNTIME_DIR"),
    make_log_reader=QwenLogReader,
    # Qwen Code ships `qwen update` but no doctor subcommand; its autoupdate
    # opt-out is a settings.json key, not an env var — autoupdate_env stays empty.
    install_dep=Dep("qwen", "Qwen Code (Alibaba Cloud)", "Alibaba Qwen Code coding agent CLI", "agent_cli",
        ["qwen", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="npm install -g @qwen-code/qwen-code", needs_terminal=True,
        requires_binaries=("npm",),
        optional=True, docs_url="https://qwenlm.github.io/qwen-code-docs/",
        update_cmd="qwen update",
        npm_package="@qwen-code/qwen-code"),
)
