"""Pi Coding Agent CLI conversation log reader.

Layout (root = $PI_CODING_AGENT_SESSION_DIR, else
$PI_CODING_AGENT_DIR/sessions, default ~/.pi/agent/sessions):
  <root>/--<encoded-cwd>--/<timestamp>_<sessionId>.jsonl

<encoded-cwd>: the leading "/" is dropped, ONLY "/", "\\" and ":" become "-",
and the result is wrapped in "--" (e.g. /Users/x/proj → --Users-x-proj--).
Unlike the Claude/Qwen encoding, every other character (spaces, unicode)
survives verbatim.

Line 1 is a session header {"type":"session","version":3,"id","timestamp",
"cwd"} — the session id and cwd come from it. The filename is only a
fallback for the id: its timestamp prefix is joined to the id with "_", and
ids may themselves contain "_" (charset [A-Za-z0-9._-]), so the id is
everything after the FIRST "_" (the timestamp contains none). Later entries
form a tree (8-hex id / parentId; /tree can branch inside one file); token
accounting scans ALL entries carrying a usage payload (assistant messages
plus compaction / branch-summary records), accepting abandoned branches in
the per-file total.

Usage mapping into TokenUsage (cache folded into input, no reasoning field):
  input_tokens  = input + cacheRead + cacheWrite
  output_tokens = output

Two vendor quirks this reader must survive:
  * Lazy flush — the session file does not exist until the first assistant
    reply completes (header+user+assistant land in one O_EXCL write), so
    "no file yet" is normal for a brand-new busy pane.
  * Whole-file rewrites — version migrations and /tree branch operations
    rewrite the file in place (NOT append-only). read_jsonl_tail's
    identity/shrink check resets the offset for a full re-read; entry-id
    dedup (ids are stable across rewrites) absorbs the re-read entries.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from pathlib import Path

import re

from .base import ExtensionsSource, ExtensionsSpec  # noqa: F401
from .base import (
    AccountSwitchSpec,
    Dep,
    SkillsWiring,
    VendorRuntimeContext,
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
    activity_high_water,
    join_text_blocks,
    read_jsonl_tail,
    set_activity_high_water,
    user_prompt_text,
)

log = logging.getLogger("agent_team_backend.log_readers.pi")

# Rewrites re-read the WHOLE file, so the dedup window must cover far more
# than the append-tail case other vendors need (qwen keeps 64).
_RECENT_KEYS_WINDOW = 256

# Pi writes no end-of-turn record, so a turn is closed either by the next user
# message or — for the latest turn, which has no successor — once the file has
# stopped being written to for _TURN_IDLE_SECONDS. File mtime is the activity
# signal: entry timestamps are ISO strings, and Pi rewrites the whole file, so
# a write is the same evidence with none of the parsing.
_TURN_IDLE_SECONDS = 8.0
_STATE_PREFIX = "pi_turn::"
_TEXT_PREFIX = "pi_text::"
_TEXT_MAX_CHARS = 4_000


def _cap_text(text: str) -> str:
    if len(text) <= _TEXT_MAX_CHARS:
        return text
    half = _TEXT_MAX_CHARS // 2
    return f"{text[:half]}\n…\n{text[-half:]}"


def _read_sentinel(seen_keys: set[str], prefix: str) -> str:
    for k in seen_keys:
        if k.startswith(prefix):
            return k[len(prefix):]
    return ""


def _write_sentinel(seen_keys: set[str], prefix: str, value: str) -> None:
    seen_keys.difference_update({k for k in seen_keys if k.startswith(prefix)})
    if value:
        seen_keys.add(f"{prefix}{value}")


def pi_sessions_root() -> Path:
    """Pi's session root ($PI_CODING_AGENT_SESSION_DIR, else
    $PI_CODING_AGENT_DIR/sessions, default ~/.pi/agent/sessions)."""
    env = os.environ.get("PI_CODING_AGENT_SESSION_DIR")
    if env:
        return Path(env)
    home = os.environ.get("PI_CODING_AGENT_DIR")
    base = Path(home) if home else Path.home() / ".pi" / "agent"
    return base / "sessions"


def encode_pi_cwd(cwd: str) -> str:
    """Pi's cwd → session-dir-name encoding: drop the leading "/", replace
    ONLY [/\\:] with "-", wrap in "--" (all other chars survive)."""
    if cwd.startswith("/"):
        cwd = cwd[1:]
    return "--" + re.sub(r"[/\\:]", "-", cwd) + "--"


def _int(v) -> int:  # noqa: ANN001
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return 0


def _usage_tokens(usage: dict) -> tuple[int, int]:
    """Fold cacheRead/cacheWrite into input (per TokenUsage design); Pi
    reports no reasoning tokens, so output passes through unchanged."""
    input_tokens = (
        _int(usage.get("input"))
        + _int(usage.get("cacheRead"))
        + _int(usage.get("cacheWrite"))
    )
    return input_tokens, _int(usage.get("output"))


def _usage_of(rec: dict) -> dict | None:
    """The usage payload of one entry: assistant messages carry it on the
    message object; compaction / branch-summary entries carry it top-level."""
    msg = rec.get("message")
    if isinstance(msg, dict):
        usage = msg.get("usage")
        return usage if isinstance(usage, dict) else None
    usage = rec.get("usage")
    return usage if isinstance(usage, dict) else None


def _model_of(rec: dict) -> str:
    msg = rec.get("message")
    if isinstance(msg, dict) and msg.get("model"):
        return str(msg["model"])
    return str(rec.get("model") or "")


class PiLogReader(LogReader):
    vendor: str = "pi"

    #: parse_activity walks a dense ascending line counter and resumes from
    #: one high-water mark, so an old file can be seeded to EOF by counting
    #: lines rather than replaying it (log_readers.base).
    activity_resumes_by_line: bool = True

    def project_dirs(self) -> list[Path]:
        """The single sessions root (empty list when it doesn't exist)."""
        default = pi_sessions_root()
        return [default] if default.is_dir() else []

    def _session_dir_files(self, d: Path) -> list[Path]:
        out: list[Path] = []
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
                        out.extend(self._session_dir_files(child))
            except OSError as err:
                log.debug("enumerate %s failed: %s", root, err)
        return out

    def session_files_for_workspace(self, workspace_path: str) -> list[Path]:
        """Only the jsonl files under this workspace's encoded session dir.

        Pi names each session dir after the encoded cwd, so one workspace
        maps to exactly one folder — enumerate just that folder. A missing
        folder is normal (lazy flush: no file exists until the first
        assistant reply completes)."""
        encoded = encode_pi_cwd(workspace_path)
        out: list[Path] = []
        for root in self.project_dirs():
            d = root / encoded
            if d.is_dir():
                out.extend(self._session_dir_files(d))
        return out

    def _in_session_dir(self, path: Path) -> bool:
        name = path.parent.name
        return len(name) > 4 and name.startswith("--") and name.endswith("--")

    def _header(self, path: Path) -> dict:
        """The line-1 session header ({} when unreadable/unexpected). The
        first write creates the file with the header already present, so a
        missing header means the file is not a Pi session file."""
        try:
            with path.open(encoding="utf-8") as fh:
                for raw in fh:
                    raw = raw.strip()
                    if not raw:
                        continue
                    try:
                        rec = json.loads(raw)
                    except json.JSONDecodeError:
                        return {}
                    if isinstance(rec, dict) and rec.get("type") == "session":
                        return rec
                    return {}
        except OSError as err:
            log.debug("open %s failed: %s", path, err)
        return {}

    def _fallback_id(self, path: Path) -> str:
        """Filename fallback: everything after the FIRST "_" (the timestamp
        prefix contains no "_"; the id itself may)."""
        _, sep, sid = path.stem.partition("_")
        return sid if sep else ""

    def cwd_from_file(self, path: Path) -> str:
        """The session's exact cwd from the line-1 header (exact, unlike
        decoding the "-"-encoded dir name, which is lossy for "-")."""
        return str(self._header(path).get("cwd") or "")

    def session_id_from_path(self, path: Path) -> str:
        """The header id is authoritative — the filename's timestamp prefix
        is NOT part of the id `pi --session-id <id>` accepts. Non-session
        siblings return '' so the resume-binding sink never coins bogus ids."""
        if path.suffix != ".jsonl" or not self._in_session_dir(path):
            return ""
        header_id = str(self._header(path).get("id") or "")
        return header_id or self._fallback_id(path)

    def has_session(self, session_id: str) -> bool:
        """True when any session dir holds a file for this id. Filename glob
        first (cheap), then header verification — a glob hit like
        `<ts>_x_<id>.jsonl` (an id ENDING with `_<id>`) must not pass. Used
        by the resume preflight: `pi --session-id <missing-id>` would not
        fail but silently start a blank NEW session under that id."""
        session_id = session_id.strip()
        if not session_id:
            return False
        for root in self.project_dirs():
            try:
                for child in root.iterdir():
                    if not child.is_dir():
                        continue
                    for f in child.glob(f"*_{session_id}.jsonl"):
                        if f.is_file() and self.session_id_from_path(f) == session_id:
                            return True
            except OSError:
                continue
        return False

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        out: list[TokenUsage] = []
        header = self._header(path)
        session_id = str(header.get("id") or "") or self._fallback_id(path)
        file_cwd = str(header.get("cwd") or "")

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
                if not isinstance(rec, dict) or rec.get("type") == "session":
                    continue
                usage = _usage_of(rec)
                if usage is None:
                    continue
                dedup_key = str(rec.get("id") or "")
                if not dedup_key or dedup_key in seen_keys:
                    continue
                input_tokens, output_tokens = _usage_tokens(usage)
                if input_tokens == 0 and output_tokens == 0:
                    continue
                seen_keys.add(dedup_key)
                out.append(
                    TokenUsage(
                        vendor="pi",
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                        cwd=file_cwd,
                        session_id=session_id,
                        file_path=str(path),
                        dedup_key=dedup_key,
                        timestamp=str(rec.get("timestamp") or ""),
                        model=_model_of(rec),
                    )
                )
        return out

    def parse_incremental(
        self,
        path: Path,
        checkpoint: dict,
    ) -> IncrementalParseResult:
        """Parse only complete JSONL records after the persisted byte offset.

        Pi files are NOT append-only: version migrations and /tree branch
        operations rewrite the whole file in place, so mtime/size can go
        backwards and the inode can change. read_jsonl_tail detects both
        (identity/shrink) and resets the offset for a full re-read. The
        recent-id window is KEPT across that reset (the path names one session
        forever and entry ids are stable across rewrites), but it is bounded
        and therefore CANNOT stop a re-read of a session with more credited
        entries than the window holds. The durable `credited_count` is what
        stops the double counting: on a full re-read the first
        `credited_count` usage-bearing entries are replayed silently and only
        what follows them is emitted."""
        records, final_checkpoint, rotated = read_jsonl_tail(path, checkpoint)
        recent = [str(k) for k in checkpoint.get("recent_keys", [])][-_RECENT_KEYS_WINDOW:]
        recent_set = set(recent)
        prior_raw = checkpoint.get("credited_count")  # absent ≠ 0
        prior_credited = max(0, int(prior_raw or 0))
        # A full re-read recounts from zero, suppressing the entries the old
        # count already covers; the append path just carries the count forward.
        skip_remaining = prior_credited if rotated else 0
        credited = 0 if rotated else prior_credited
        # Checkpoints persisted before credited_count existed carry no count at
        # all (rotated already implies a non-zero prior offset, i.e. a tracked
        # file). How many entries were credited is unknowable, so this one
        # re-read suppresses everything and just records the true count: losing
        # the entries that single rewrite added beats re-crediting the whole
        # session. The count is durable from the next poll on.
        legacy_reread = rotated and prior_raw is None
        header_cached = bool(checkpoint.get("session_id")) and not rotated
        if header_cached:
            session_id = str(checkpoint.get("session_id") or "")
            cwd = str(checkpoint.get("cwd") or "")
        else:
            header = self._header(path)
            session_id = str(header.get("id") or "") or self._fallback_id(path)
            cwd = str(header.get("cwd") or "")
        out: list[TokenUsage] = []

        for end, rec in records:
            if rec is None or rec.get("type") == "session":
                continue
            usage = _usage_of(rec)
            if usage is None:
                continue
            dedup_key = str(rec.get("id") or "")
            if not dedup_key:
                continue
            input_tokens, output_tokens = _usage_tokens(usage)
            if input_tokens == 0 and output_tokens == 0:
                continue
            # From here the entry qualifies: it is one of the entries the
            # credited count counts.
            if legacy_reread or skip_remaining > 0:
                skip_remaining = max(0, skip_remaining - 1)
                credited += 1
                recent.append(dedup_key)
                recent = recent[-_RECENT_KEYS_WINDOW:]
                recent_set = set(recent)
                continue
            if dedup_key in recent_set:
                continue
            credited += 1
            recent.append(dedup_key)
            recent = recent[-_RECENT_KEYS_WINDOW:]
            recent_set = set(recent)
            event_checkpoint = dict(final_checkpoint)
            event_checkpoint["offset"] = end
            event_checkpoint["recent_keys"] = list(recent)
            event_checkpoint["session_id"] = session_id
            event_checkpoint["cwd"] = cwd
            event_checkpoint["credited_count"] = credited
            out.append(TokenUsage(
                vendor="pi",
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cwd=cwd,
                session_id=session_id,
                file_path=str(path),
                dedup_key=dedup_key,
                timestamp=str(rec.get("timestamp") or ""),
                model=_model_of(rec),
                checkpoint=event_checkpoint,
            ))

        final_checkpoint["recent_keys"] = recent
        final_checkpoint["session_id"] = session_id
        final_checkpoint["cwd"] = cwd
        final_checkpoint["credited_count"] = credited
        return IncrementalParseResult(out, final_checkpoint)

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Emit `agent_active` for user and assistant message entries, and
        `turn_complete` once per user-facing turn.

        Pi's log carries no explicit end-of-turn record (an assistant turn
        spans several message/tool entries with no stop record), so the turn
        boundary is inferred: the next user message closes the previous turn,
        and the latest turn is flushed once the file has been quiet for
        _TURN_IDLE_SECONDS. turn_complete carries the assistant's closing text,
        which is what lets a Pi pane send inter-CLI messages — the frontend
        only parses the ---MSG-START--- protocol out of a turn_complete that
        has text, and Pi has no MCP support to offer the alternative route.

        Non-message entries (tool results, compaction, branch summaries) are
        not user-visible activity."""
        out: list[ActivityEvent] = []
        header = self._header(path)
        session_id = str(header.get("id") or "") or self._fallback_id(path)
        cwd = str(header.get("cwd") or "")
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
            # The turn's own last entry supplies the timestamp. It must be a
            # real one: the frontend dedups messaging turns by timestamp and
            # treats an unparseable one as always-fresh, which would resend a
            # turn delivered twice and replay history after a backend restart.
            return ActivityEvent(
                vendor="pi", event_type="turn_complete",
                cwd=cwd, session_id=session_id, file_path=str(path),
                dedup_key=f"turn:{int(state['idx'])}",
                timestamp=str(state.get("ts") or ""), detail=detail,
                text=last_text,
            )

        try:
            fh = path.open(encoding="utf-8")
        except OSError:
            return out

        # Every line that passes the seen test is marked right there, before
        # the JSON parse or any of the entry-type filters can skip it, and the
        # walk is a dense ascending scan from line 1 — so a single high-water
        # mark replaces the per-line keys exactly. See log_readers.base.
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
                    if not isinstance(rec, dict) or rec.get("type") != "message":
                        continue
                    msg = rec.get("message")
                    role = str(msg.get("role") or "") if isinstance(msg, dict) else ""
                    if role in ("user", "assistant"):
                        # User message content is either a plain string or text
                        # blocks; carry it so the frontend can name the pane.
                        text = ""
                        entry_ts = str(rec.get("timestamp") or "")
                        if role == "user":
                            # A new message closes the previous turn (if open).
                            if state is not None and not state.get("flushed"):
                                out.append(_complete(state, "boundary"))
                                last_text = ""
                            idx = (int(state["idx"]) + 1) if state is not None else 0
                            state = {"idx": idx, "flushed": False, "ts": entry_ts}
                            text = user_prompt_text(
                                join_text_blocks(msg.get("content"), "text")
                            )
                        else:
                            # An assistant entry with no preceding user message (a
                            # resumed session joined mid-turn) still opens a turn.
                            if state is None or state.get("flushed"):
                                idx = (int(state["idx"]) + 1) if state is not None else 0
                                state = {"idx": idx, "flushed": False, "ts": entry_ts}
                            state["ts"] = entry_ts
                            reply = join_text_blocks(msg.get("content"), "text").strip()
                            if reply:
                                last_text = _cap_text(reply)
                        out.append(ActivityEvent(
                            vendor="pi",
                            event_type="agent_active",
                            cwd=cwd, session_id=session_id, file_path=str(path),
                            dedup_key=key,
                            timestamp=str(rec.get("timestamp") or ""),
                            detail=role, text=text,
                        ))

                # The latest turn has no following message; flush it once the file
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


# ---- attribution/watch hooks ----------------------------------------------

def _workspace_match(self, usage, ws_path, owner_workspace=None):
    # Reader emits cwd = the session header's cwd field.
    return bool(usage.cwd and usage.cwd == ws_path)


def _pane_cwd_match(self, usage, pane_cwd, pane_id):
    return usage.cwd == pane_cwd


PiLogReader.binds_by_marker_file = True
PiLogReader.binds_new_session_single_candidate = True
PiLogReader.emits_session_sink = True
PiLogReader.workspace_match = _workspace_match
PiLogReader.pane_cwd_match = _pane_cwd_match


# ---- usage quota -----------------------------------------------------------
# Aggregator (pi has no server of its own): anthropic oauth goes through the
# shared protocol, openai-codex through the wham protocol, openrouter through
# its key endpoint; BYOK / github-copilot / xai entries have no readable
# quota and map to unavailable.

# pi (Pi coding agent, @earendil-works/pi-coding-agent; the older
# @mariozechner/pi-coding-agent package is deprecated). auth.json is keyed by
# provider id; oauth entries are {type: "oauth", access, refresh, expires
# (epoch ms)}, BYOK keys are {type: "api_key", key}. Credentials are read-only
# here and never refreshed (pi rotates its own refresh tokens): an expired
# oauth entry maps to status=expired.
PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR"
PI_AUTH_FILE_REL = (".pi", "agent", "auth.json")
# The OAuth flows pi-ai 0.84 bundles (auth/oauth/load.js), keyed by the
# provider id the entry is stored under. Each is a subscription login of its
# own, so each is a scope a profile can bind to; BYOK ``api_key`` entries of
# other providers are never touched by a switch.
PI_ACCOUNT_SCOPES = (
    "anthropic",
    "openai-codex",
    "github-copilot",
    "openrouter",
    "kimi-coding",
    "xai",
)


def _pi_auth_file(home: Path, env: dict | None = None) -> Path:
    """``$PI_CODING_AGENT_DIR/auth.json`` when set (config.js getAgentDir),
    else ``~/.pi/agent/auth.json``."""
    env = os.environ if env is None else env
    root = env.get(PI_AGENT_DIR_ENV)
    return Path(root) / "auth.json" if root else home.joinpath(*PI_AUTH_FILE_REL)
PI_OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key"


def read_pi_credentials(home: Path, env: dict | None = None) -> dict | None:
    """Parse pi's ``auth.json`` (under ``$PI_CODING_AGENT_DIR``, default
    ``~/.pi/agent`` — mirroring the pi log reader's root resolution): a map of
    provider id -> credential entry. Returns the dict-valued entries, or None
    when the file is absent/malformed/empty."""
    env = env or {}
    root = Path(env[PI_AGENT_DIR_ENV]) if env.get(PI_AGENT_DIR_ENV) \
        else home / ".pi" / "agent"
    try:
        data = json.loads((root / "auth.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    entries = {k: v for k, v in data.items() if isinstance(v, dict)}
    return entries or None


def pi_oauth_expired(entry: dict, now_ms: float | None = None) -> bool:
    """True when an oauth entry's ``expires`` (epoch ms) has passed. Tokens
    are never refreshed here — pi serializes its own refresh flow and Anthropic
    rotates refresh tokens, so refreshing would invalidate the CLI's copy."""
    expires = _num(entry.get("expires"))
    if expires is None:
        return False
    now = time.time() * 1000 if now_ms is None else now_ms
    return now >= expires


def pi_anthropic_oauth(auth: dict) -> dict | None:
    """Map an ``anthropic`` {type: "oauth"} entry to the claudeAiOauth shape
    (accessToken + epoch-ms expiresAt) so the existing Claude usage flow can
    be reused as-is — pi's Anthropic OAuth uses Claude Code's client id, so
    the stored token works against the same oauth/usage endpoint."""
    entry = auth.get("anthropic")
    if not isinstance(entry, dict) or entry.get("type") != "oauth":
        return None
    access = entry.get("access")
    if not isinstance(access, str) or not access:
        return None
    return {"accessToken": access, "expiresAt": entry.get("expires")}


def pi_codex_oauth(auth: dict) -> dict | None:
    """The ``openai-codex`` {type: "oauth"} entry -> {access_token, account_id,
    expires} for the ChatGPT ``wham/usage`` flow. api_key entries are BYOK and
    have no usage surface -> None."""
    entry = auth.get("openai-codex")
    if not isinstance(entry, dict) or entry.get("type") != "oauth":
        return None
    access = entry.get("access")
    if not isinstance(access, str) or not access:
        return None
    account = entry.get("accountId") or entry.get("account_id")
    return {"access_token": access,
            "account_id": account if isinstance(account, str) and account else None,
            "expires": entry.get("expires")}


def pi_openrouter_key(auth: dict) -> str | None:
    """The ``openrouter`` bearer credential: the oauth access token (the PKCE
    exchange yields a long-lived key) or a plain api key — both are accepted
    by ``GET /api/v1/key``."""
    entry = auth.get("openrouter")
    if not isinstance(entry, dict):
        return None
    if entry.get("type") == "oauth":
        access = entry.get("access")
        return access if isinstance(access, str) and access else None
    if entry.get("type") == "api_key":
        key = entry.get("key")
        return key if isinstance(key, str) and key else None
    return None


# ── Response normalizers (pure) ─────────────────────────────────────────────



def normalize_pi_openrouter(data: dict) -> list[dict]:
    """OpenRouter ``GET /api/v1/key``: ``{"data": {"usage": <credits used>,
    "limit": <credit limit|null>}}`` — dollar/credit based, no reset window.
    With a limit the used/limit ratio is real; a null limit (unlimited key)
    pins usedPercent to 0 and the raw fields are surfaced as-is."""
    entry = data.get("data")
    if not isinstance(entry, dict):
        return []
    used = _num(entry.get("usage"))
    if used is None:
        return []
    limit = _num(entry.get("limit"))
    window = _window("credits", "OpenRouter credits",
                     used / limit * 100 if limit else 0.0, None)
    window["usage"] = used
    window["limit"] = limit
    return [window]



# ── Fetchers ────────────────────────────────────────────────────────────────



async def _fetch_pi_codex(creds: dict) -> dict:
    """pi's ``openai-codex`` oauth token against ChatGPT ``wham/usage`` (the
    same endpoint the codex provider uses; pi has no config.toml base
    override, so the default base applies)."""
    if pi_oauth_expired(creds):
        return _snapshot("pi", "expired")
    import httpx

    headers = {
        "Authorization": f"Bearer {creds['access_token']}",
        "User-Agent": "Navide",
        "Accept": "application/json",
    }
    if creds.get("account_id"):
        headers["ChatGPT-Account-Id"] = creds["account_id"]
    url = _protocols.codex_usage_url(_protocols.CODEX_DEFAULT_BASE)
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(url, headers=headers)
    if resp.status_code in (401, 403):
        return _snapshot("pi", "expired")
    if resp.status_code == 429:
        snap = _snapshot("pi", "rate-limited")
        snap["retryAfterSec"] = parse_retry_after(resp.headers.get("Retry-After"))
        return snap
    if resp.status_code != 200:
        return _snapshot("pi", "error", error=f"HTTP {resp.status_code}")
    windows, plan = _protocols.normalize_codex(resp.json())
    windows = [dict(w, label=f"Codex — {w['label']}") for w in windows]
    return _snapshot("pi", "ok", windows=windows, plan_type=plan)


async def _fetch_pi_openrouter(key: str) -> dict:
    import httpx

    headers = {
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
        "User-Agent": "Navide",
    }
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(PI_OPENROUTER_KEY_URL, headers=headers)
    if resp.status_code in (401, 403):
        return _snapshot("pi", "expired")
    if resp.status_code == 429:
        snap = _snapshot("pi", "rate-limited")
        snap["retryAfterSec"] = parse_retry_after(resp.headers.get("Retry-After"))
        return snap
    if resp.status_code != 200:
        return _snapshot("pi", "error", error=f"HTTP {resp.status_code}")
    try:
        payload = resp.json()
    except ValueError:
        return _snapshot("pi", "error", error="non-JSON response")
    windows = normalize_pi_openrouter(payload if isinstance(payload, dict) else {})
    if not windows:
        return _snapshot("pi", "error", error="response had no usable fields")
    return _snapshot("pi", "ok", windows=windows)


async def fetch_pi(home: Path, env: dict | None = None) -> dict:
    """pi is an aggregator with no server of its own: each supported
    ``auth.json`` credential is asked its own provider's usage endpoint. Any
    source that answers makes the snapshot "ok" (windows combined); with none
    answering the first failure is surfaced; entries without a usage surface
    (BYOK api keys, github-copilot/xai/radius) alone -> unavailable."""
    env = env if env is not None else dict(os.environ)
    auth = read_pi_credentials(home, env)
    if auth is None:
        return _snapshot("pi", "no-credentials")
    sub_snaps: list[dict] = []
    oauth = pi_anthropic_oauth(auth)
    if oauth is not None:
        snap = await _protocols.fetch_claude_oauth(oauth)
        snap["provider"] = "pi"
        snap["windows"] = [dict(w, label=f"Claude — {w['label']}")
                           for w in snap["windows"]]
        sub_snaps.append(snap)
    codex_creds = pi_codex_oauth(auth)
    if codex_creds is not None:
        sub_snaps.append(await _fetch_pi_codex(codex_creds))
    key = pi_openrouter_key(auth)
    if key is not None:
        sub_snaps.append(await _fetch_pi_openrouter(key))
    if not sub_snaps:
        return _snapshot(
            "pi", "unavailable",
            error="no auth.json credential has a usage API "
                  "(plain API keys and github-copilot/xai/radius expose none)")
    ok = [s for s in sub_snaps if s["status"] == "ok"]
    if ok:
        return _snapshot("pi", "ok",
                         windows=[w for s in ok for w in s["windows"]])
    return sub_snaps[0]




# ---- resume / session ------------------------------------------------------

# `pi --session-id <id>` resumes when the id exists and creates a NEW session
# under that id otherwise — either way the id names this pane's session, so
# it is claimed like Claude's --session-id. Flag guard as usual.
_RESUME_RE = re.compile(r"^pi\s+(?:\S+\s+)*--session-id\s+([^-\s]\S*)")


def _resume_id_from_command(command) -> str:
    """Session id from a `pi ... --session-id <id>` command ('' otherwise)."""
    m = _RESUME_RE.match(command_text(command).strip())
    return m.group(1) if m else ""


def _session_exists(workspace_path: str, session_id: str) -> bool:
    # --session-id only resumes within the launch workspace; finding the id
    # in another project would make Pi create a new empty session instead.
    reader = PiLogReader()
    return bool(session_id) and any(
        reader.session_id_from_path(path) == session_id
        for path in reader.session_files_for_workspace(workspace_path)
    )


# ---- vendor spec -----------------------------------------------------------

def _risk_data_dirs(ctx: VendorRuntimeContext) -> tuple[Path, ...]:
    # pi_sessions_root permits moving sessions separately from config/data.
    root = ctx.path(ctx.env.get("PI_CODING_AGENT_DIR") or ctx.home / ".pi" / "agent")
    sessions = ctx.env.get("PI_CODING_AGENT_SESSION_DIR")
    if sessions:
        return tuple(dict.fromkeys((root, ctx.path(sessions))))
    return (root,)


# Where this CLI keeps the extensions it installed for itself (read-only
# inventory, cli_extensions). Verified 2026-10-10 against the installed
# binary's --help and the files on disk.
_EXTENSIONS = ExtensionsSpec(sources=(
    ExtensionsSource("code-files", (".pi", "agent", "extensions"), "Pi extension"),
    ExtensionsSource("npm-list", (".pi", "agent", "settings.json"), "Pi package", section=("packages",)),
))

SPEC = VendorSpec(
    extensions=_EXTENSIONS,
    key="pi",
    # Open-ended provider/model config; OpenRouter quota is not a CLI host set.
    expected_hosts=(),
    data_dirs=_risk_data_dirs,
    data_dir_env_vars=("PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"),
    supports_model=True,
    supports_effort=True,
    known_efforts=('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'),
    skills_supported=True,
    # --skill takes one skill (file or directory) and is repeated; it adds to
    # discovery rather than replacing it (--no-skills is the opt-out).
    skills_wiring=SkillsWiring(flag="--skill", flag_takes="each"),
    label="Pi",
    # Multi-account: ``auth.json`` is a provider map (FileAuthStorageBackend,
    # 0600, written whole under a lock file); a profile binds to one OAuth
    # provider and a switch rewrites that entry only. ``PI_CODING_AGENT_DIR``
    # relocates the whole agent dir, so a login pane gets its own auth.json
    # there and the vault harvests the profile's scope entry out of it.
    # AuthStorage re-reads the file when its revision changes, so a hot swap
    # may work; until that is seen on a real account the safe answer is a
    # restart with ``pi --session-id <id>``.
    live_file=PI_AUTH_FILE_REL,
    live_file_resolver=lambda home: _pi_auth_file(home),
    slot_file="auth.json",
    login_home_secret_file=("auth.json",),
    login_home_env=PI_AGENT_DIR_ENV,
    identity_from_secret=provider_entry_identity,
    account_switch=AccountSwitchSpec(
        auth_scope="pi",
        method="restart",
        store="compound-file",
        evidence="source",
        verified_version="0.84.0",
        scopes=PI_ACCOUNT_SCOPES,
        extract=provider_map_extract,
        merge=provider_map_merge,
        # pi-ai auth/resolve.js: "A stored credential owns the provider:
        # ambient/env is consulted only when nothing is stored" — an env key
        # never outranks the auth.json entry, so nothing shadows a switch.
        shadowing_env=(),
        resume="native",
        todo="layout from the installed 0.84.0 package; hot reload seen in auth-storage.js but unverified; no real-account round-trip recorded",
    ),
    # Late-bound (module global at call time) so tests can monkeypatch.
    fetch_usage=lambda home: fetch_pi(home),
    resume_id_from_command=_resume_id_from_command,
    session_exists=_session_exists,
    home_env_vars=(
        "PI_CODING_AGENT_DIR",
        "PI_CODING_AGENT_SESSION_DIR",
        "PI_PACKAGE_DIR",
    ),
    make_log_reader=PiLogReader,
    # Pi ships `pi update` but no doctor subcommand; PI_SKIP_VERSION_CHECK is
    # its own opt-out for the startup version check.
    install_dep=Dep("pi", "Pi", "Pi coding agent CLI", "agent_cli",
        ["pi", "--version"], r"(\d+\.\d+\.\d+)",
        # --ignore-scripts matches pi's official Quick Start.
        install_cmd="npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
        needs_terminal=True, requires_binaries=("npm",),
        optional=True, docs_url="https://pi.dev/docs",
        update_cmd="pi update",
        npm_package="@earendil-works/pi-coding-agent",
        config_home_env="PI_CODING_AGENT_DIR",
        autoupdate_env="PI_SKIP_VERSION_CHECK"),
)
