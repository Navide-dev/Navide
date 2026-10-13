"""Antigravity CLI conversation reader (session discovery + activity).

Files: ~/.gemini/antigravity-cli/conversations/<uuid>.db — SQLite databases
whose payloads are undocumented protobuf blobs. Token usage is therefore NOT
parsed (parse_session_file returns []). What this reader does provide:

  • the watcher's session sink can bind a conversation to its pane via the
    kickoff marker (the .db filename stem is the id `agy --conversation`
    resumes),
  • cwd_from_file() can map a conversation to its workspace — the
    trajectory_metadata_blob table embeds the workspace as a `file:///…` URI,
    extractable without decoding protobuf, and
  • parse_activity() reports per-step activity: the `steps` table keeps
    `idx`/`step_type`/`status` as plain integers, so working-vs-done needs no
    protobuf at all, and only the turn's text is decoded out of a blob.
"""

from __future__ import annotations

import logging
import re
import sqlite3
from collections import Counter
from pathlib import Path
from urllib.parse import unquote

import asyncio
import base64
import json
import os
import sys
import time

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
    keychain_payload_items,
    simple_command_args,
)
from ..usage_common import (
    HTTP_TIMEOUT,
    _KEYCHAIN_COOLDOWN_S,
    _epoch_to_iso,
    _num,
    _snapshot,
    _window,
    communicate_or_kill as _communicate_or_kill,
    parse_retry_after,
)
from ..log_readers.base import (
    ActivityEvent,
    LogReader,
    TokenUsage,
    user_prompt_text,
)

log = logging.getLogger("agent_team_backend.log_readers.antigravity")

# A file URI run inside blob text: stop at control bytes (protobuf field
# boundaries); printable junk that follows the path is trimmed by the
# is_dir()/most-common selection in _extract_cwd. The path is either rooted
# (`file:///Users/...`, `file:///C:/...`) or a bare drive path (`file://C:\...`).
_FILE_URI_RE = re.compile(r"file://(/[^\x00-\x1f\x7f]+|[A-Za-z]:[\\/][^\x00-\x1f\x7f]+)")
# `file:///C:/...` keeps a slash before the drive letter that is not part of
# the path.
_DRIVE_SLASH_RE = re.compile(r"^/+(?=[A-Za-z]:)")


def _extract_cwd(text: str) -> str:
    """Best candidate workspace path from blob text.

    The URI appears several times; occurrences directly followed by protobuf
    tag bytes pick up printable junk suffixes. Prefer candidates that exist on
    disk, then the most frequent, then the shortest (the clean path is a
    prefix of its junk-suffixed variants).
    """
    counts: Counter[str] = Counter()
    for m in _FILE_URI_RE.finditer(text):
        # Not url2pathname: on Windows it raises on a second ":" in the run,
        # and a run is often the clean URI plus a junk-suffixed repeat of it.
        path = unquote(_DRIVE_SLASH_RE.sub("", m.group(1))).rstrip("/")
        if path:
            counts[str(Path(path))] += 1
    if not counts:
        return ""
    candidates = sorted(
        counts,
        key=lambda p: (not Path(p).is_dir(), -counts[p], len(p)),
    )
    return candidates[0]


# Read-only busy wait: long enough to ride out an agent write transaction,
# short enough not to stall the watcher's drain thread (same as Cursor).
_BUSY_TIMEOUT_MS = 250

# Sentinel prefix persisted inside the watcher-owned per-file seen_keys set,
# carrying the highest `steps.idx` already reported for this conversation.
# `idx` is a monotonic primary key, so it plays the role a byte offset plays
# for a JSONL reader.
_IDX_PREFIX = "agy_idx::"
# An unfinished assistant row can be updated in place after the idx advances.
_PENDING_PREFIX = "agy_pending::"

# Steps read per pass. A resumed conversation can be thousands of rows deep;
# the watcher only needs the recent tail to decide "working" vs "done".
_MAX_STEPS_PER_PASS = 256

# `steps.step_type` values, established by decoding the payloads of ~15k steps
# across the on-disk conversations. Anything not listed here is a tool call or
# an internal bookkeeping step — still real agent activity, just unnamed.
_STEP_USER = 14        # payload field 19 = the user's prompt, verbatim
_STEP_ASSISTANT = 15   # payload field 20 = the assistant's text for this step
_STEP_QUESTION = 138   # ask_question tool: the agent is waiting on the user

# `steps.status`: 3 is the only value a finished step ever carries.
_STATUS_DONE = 3

# `step_payload` / `metadata` field numbers (protobuf, no .proto available;
# established by decoding the on-disk conversations).
_F_USER_PAYLOAD = 19
_F_ASSISTANT_PAYLOAD = 20
_F_META_END_TS = (8, 7, 6)  # end, then start — first one present wins

# Fields INSIDE those payloads. The assistant payload separates the reply the
# user sees from the model's own reasoning, which is what makes a real
# end-of-turn signal possible: a step carrying reply text finished saying
# something, a step carrying only reasoning is still mid-thought. (A `bot-<uuid>`
# in field 6 is an id, not text, and is deliberately not read.)
_F_USER_TEXT = (2,)
_F_REPLY_TEXT = (1, 8)
_F_THINKING_TEXT = (3,)


def _varint(buf: bytes, i: int) -> tuple[int | None, int]:
    """(value, next index), or (None, …) on a truncated/oversized varint."""
    shift = 0
    val = 0
    while i < len(buf):
        byte = buf[i]
        i += 1
        val |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return val, i
        shift += 7
        if shift > 63:
            return None, i
    return None, i


def _pb_scan(blob: bytes) -> list[tuple[int, int, int | bytes]]:
    """Top-level (field number, wire type, value) triples of a protobuf blob.

    Stops at the first byte that does not parse rather than raising: these
    blobs are undocumented and a partially-written one must not take the
    watcher down.
    """
    out: list[tuple[int, int, int | bytes]] = []
    i, n = 0, len(blob)
    while i < n:
        key, i = _varint(blob, i)
        if key is None:
            break
        field, wire = key >> 3, key & 7
        if wire == 0:
            val, i = _varint(blob, i)
            if val is None:
                break
            out.append((field, wire, val))
        elif wire == 2:
            ln, i = _varint(blob, i)
            if ln is None or i + ln > n:
                break
            out.append((field, wire, blob[i:i + ln]))
            i += ln
        elif wire == 5:
            i += 4
        elif wire == 1:
            i += 8
        else:  # groups (3/4) and anything invalid — we cannot resynchronize
            break
    return out


def _pb_bytes(blob: bytes, field: int) -> bytes:
    for f, wire, val in _pb_scan(blob):
        if f == field and wire == 2 and isinstance(val, bytes):
            return val
    return b""


def _pb_varint(blob: bytes, field: int) -> int | None:
    for f, wire, val in _pb_scan(blob):
        if f == field and wire == 0 and isinstance(val, int):
            return val
    return None


def _pb_text(payload: bytes, outer: int, inner: tuple[int, ...]) -> str:
    """Text of `payload`'s `outer` submessage, from the first `inner` field
    that holds a clean string ("" when none does).

    Neighbouring fields hold the same text re-wrapped with a length prefix, so
    a decodable-looking field is not enough — anything carrying protobuf
    framing (control characters, which real prose does not contain) is skipped.
    """
    blob = _pb_bytes(payload, outer)
    if not blob:
        return ""
    for field in inner:
        for f, wire, val in _pb_scan(blob):
            if f != field or wire != 2 or not isinstance(val, bytes):
                continue
            try:
                text = val.decode("utf-8")
            except UnicodeDecodeError:
                continue
            if any(ch < " " and ch not in "\t\n\r" for ch in text):
                continue
            if text.strip():
                return text.strip()
    return ""


def _step_timestamp(metadata: bytes) -> str:
    """ISO 8601 for a step, from the google.protobuf.Timestamp in metadata."""
    for field in _F_META_END_TS:
        ts = _pb_bytes(metadata, field)
        if not ts:
            continue
        seconds = _pb_varint(ts, 1)
        if seconds:
            return _epoch_to_iso(seconds) or ""
    return ""


class AntigravityLogReader(LogReader):
    vendor: str = "antigravity"

    #: The log records no token usage, so there are no turns to cut.
    turns_method: str = "unsupported"

    def __init__(self) -> None:
        self._cwd_cache: dict[str, tuple[float, str]] = {}  # path → (mtime, cwd)

    def project_dirs(self) -> list[Path]:
        root = Path.home() / ".gemini" / "antigravity-cli" / "conversations"
        return [root] if root.is_dir() else []

    def session_files(self) -> list[Path]:
        out: list[Path] = []
        for root in self.project_dirs():
            try:
                out.extend(
                    f for f in root.iterdir()
                    if f.is_file() and f.suffix == ".db"  # skip -wal / -shm
                )
            except OSError as err:
                log.debug("enumerate %s failed: %s", root, err)
        return out

    def session_files_for_workspace(self, workspace_path: str) -> list[Path]:
        return [
            p for p in self.session_files()
            if self.cwd_from_file(p) == workspace_path
        ]

    def cwd_from_file(self, path: Path) -> str:
        try:
            mtime = path.stat().st_mtime
        except OSError:
            return ""
        cached = self._cwd_cache.get(str(path))
        if cached is not None and cached[0] == mtime:
            return cached[1]
        cwd = _extract_cwd(self._metadata_text(path))
        self._cwd_cache[str(path)] = (mtime, cwd)
        return cwd

    def _metadata_text(self, path: Path) -> str:
        """trajectory_metadata_blob rows decoded as text (errors ignored)."""
        try:
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            try:
                rows = con.execute(
                    "SELECT data FROM trajectory_metadata_blob"
                ).fetchall()
            finally:
                con.close()
            parts: list[str] = []
            for (data,) in rows:
                if isinstance(data, bytes):
                    parts.append(data.decode("utf-8", errors="ignore"))
                elif isinstance(data, str):
                    parts.append(data)
            return "".join(parts)
        except (sqlite3.Error, OSError) as err:
            log.debug("sqlite read %s failed (%s), falling back to raw scan", path, err)
        # Live db mid-write / locked: best-effort raw byte scan.
        try:
            return path.read_bytes().decode("utf-8", errors="ignore")
        except OSError:
            return ""

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        # Token counts live in undocumented protobuf blobs — intentionally not
        # parsed. Session binding happens via the watcher session sink instead.
        return []

    # ── activity ────────────────────────────────────────────────────────────

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """One event per new row in the conversation's `steps` table.

        Unlike the other SQLite-backed vendors, the columns that matter here
        (`idx`, `step_type`, `status`) are plain integers, so this is a real
        per-step signal rather than a "the file changed" approximation. Only
        the text rides in protobuf, and only the fields we decode below.

        Without this, antigravity emitted neither `agent_active` nor
        `turn_complete`, which left the inter-CLI messaging gate permanently
        open: a message could be injected mid-turn, where the TUI leaves it
        sitting unsent in the composer.
        """
        session_id = self.session_id_from_path(path)
        if not session_id:
            return []
        prev = next(
            (k[len(_IDX_PREFIX):] for k in seen_keys if k.startswith(_IDX_PREFIX)),
            None,
        )
        def remember(idx: int) -> None:
            seen_keys.difference_update(
                {k for k in seen_keys if k.startswith(_IDX_PREFIX)}
            )
            seen_keys.add(_IDX_PREFIX + str(idx))

        # First sight of a conversation: the rows already there are history,
        # not activity happening now. Skip to the LAST step rather than the end
        # of one capped page — a long conversation would otherwise replay its
        # remaining pages as fresh activity on the next pass, showing a resumed
        # pane as working.
        if prev is None:
            newest = self._max_step_idx(path)
            if newest is not None:
                remember(newest)
            return []
        pending_raw = next(
            (key[len(_PENDING_PREFIX):] for key in seen_keys
             if key.startswith(_PENDING_PREFIX)), "[]",
        )
        pending = set(json.loads(pending_raw))
        rows = self._read_steps(path, int(prev), pending)
        if not rows:
            return []
        newest = max(int(prev), rows[-1][0])
        remember(newest)
        cwd = self.cwd_from_file(path)
        events: list[ActivityEvent] = []
        for row in rows:
            idx, step_type, status, _, _ = row
            if step_type == _STEP_ASSISTANT and status != _STATUS_DONE:
                if idx in pending:
                    continue  # still streaming; do not repeat the active event
                pending.add(idx)
            else:
                pending.discard(idx)
            events.extend(self._step_event(
                path, session_id, cwd, row, is_last=idx == newest
            ))
        # One sentinel stays under the watcher's persisted-key count limit,
        # even when several assistant rows are unfinished at the same time.
        seen_keys.difference_update(
            {key for key in seen_keys if key.startswith(_PENDING_PREFIX)}
        )
        if pending:
            seen_keys.add(_PENDING_PREFIX + json.dumps(sorted(pending)))
        return events

    def _max_step_idx(self, path: Path) -> int | None:
        """Highest `steps.idx` in the conversation (None when unreadable)."""
        try:
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            try:
                con.execute(f"PRAGMA busy_timeout = {_BUSY_TIMEOUT_MS}")
                row = con.execute("SELECT MAX(idx) FROM steps").fetchone()
            finally:
                con.close()
        except (sqlite3.Error, OSError) as err:
            log.debug("steps max read %s failed: %s", path, err)
            return None
        return int(row[0]) if row and row[0] is not None else None

    def _read_steps(
        self, path: Path, after_idx: int, pending: set[int] | None = None,
    ) -> list[tuple[int, int, int, bytes, bytes]]:
        """New rows and pending assistant rows, oldest first
        ([] when the db cannot be read)."""
        try:
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            try:
                con.execute(f"PRAGMA busy_timeout = {_BUSY_TIMEOUT_MS}")
                pending_ids = sorted(pending or ())
                pending_clause = (
                    f" OR idx IN ({','.join('?' for _ in pending_ids)})"
                    if pending_ids else ""
                )
                rows = con.execute(
                    "SELECT idx, step_type, status, metadata, step_payload "
                    f"FROM steps WHERE idx > ?{pending_clause} ORDER BY idx LIMIT ?",
                    (after_idx, *pending_ids, _MAX_STEPS_PER_PASS),
                ).fetchall()
            finally:
                con.close()
        except (sqlite3.Error, OSError) as err:
            log.debug("steps read %s failed: %s", path, err)
            return []
        return [
            (
                int(idx),
                int(step_type or 0),
                int(status or 0),
                metadata if isinstance(metadata, bytes) else b"",
                payload if isinstance(payload, bytes) else b"",
            )
            for idx, step_type, status, metadata, payload in rows
            if idx is not None
        ]

    def _step_event(
        self,
        path: Path,
        session_id: str,
        cwd: str,
        row: tuple[int, int, int, bytes, bytes],
        is_last: bool = True,
    ) -> list[ActivityEvent]:
        idx, step_type, status, metadata, payload = row

        def make(event_type: str, detail: str, text: str = "") -> ActivityEvent:
            return ActivityEvent(
                vendor="antigravity",
                event_type=event_type,
                cwd=cwd,
                session_id=session_id,
                file_path=str(path),
                dedup_key=f"step:{session_id}:{idx}",
                timestamp=_step_timestamp(metadata),
                detail=detail,
                text=text,
            )

        if step_type == _STEP_USER:
            return [make(
                "agent_active", "user",
                user_prompt_text(
                    _pb_text(payload, _F_USER_PAYLOAD, _F_USER_TEXT)
                ),
            )]
        if step_type == _STEP_QUESTION:
            # The agent asked and is now blocked on an answer — the turn is
            # over as far as "can this pane take a message" is concerned.
            return [make("turn_complete", "assistant:question")]
        if step_type == _STEP_ASSISTANT:
            reply = _pb_text(payload, _F_ASSISTANT_PAYLOAD, _F_REPLY_TEXT)
            # The format has no end-of-turn flag. A finished step that carries
            # a reply is the closest thing to one: the agent said something to
            # the user. Steps holding only reasoning, or only a tool call the
            # reply will follow, keep the pane marked active instead.
            #
            # `is_last` removes the cases this pass can already rule out: a
            # reply with more steps behind it in the same batch was mid-turn
            # narration, and the steps that followed prove it. The agent talks
            # while it works, so without this a long turn reports itself
            # finished several times over, and each report drops the pane to
            # idle. It cannot rule out the same thing across passes — a reply
            # that is last only because the next step has not been written yet
            # still reads as end-of-turn.
            if reply and status == _STATUS_DONE and is_last:
                return [make("turn_complete", "assistant", reply)]
            thinking = _pb_text(
                payload, _F_ASSISTANT_PAYLOAD, _F_THINKING_TEXT
            )
            return [make(
                "agent_active", "assistant:thinking" if thinking else "assistant"
            )]
        return [make("agent_active", f"step-{step_type}")]


# ---- attribution/watch hooks ----------------------------------------------

def _marker_scan_text(self, path):
    # Markers live in the metadata blob; recent frames (incl. the just-typed
    # marker) often sit in the -wal journal before being checkpointed into
    # the main db, so search it too. The hook owns its own read budget.
    text = self._metadata_text(path)[:524_288]
    try:
        text += Path(str(path) + "-wal").read_text(
            encoding="utf-8", errors="ignore")[:524_288]
    except OSError:
        pass
    return text


def _workspace_match(self, usage, ws_path, owner_workspace=None):
    # cwd is extracted from trajectory_metadata_blob.
    return bool(usage.cwd and usage.cwd == ws_path)


def _pane_cwd_match(self, usage, pane_cwd, pane_id):
    return usage.cwd == pane_cwd


AntigravityLogReader.binds_by_marker_file = True
AntigravityLogReader.binds_new_session_single_candidate = True
AntigravityLogReader.emits_session_sink = True
AntigravityLogReader.marker_scan_text = _marker_scan_text
AntigravityLogReader.workspace_match = _workspace_match
AntigravityLogReader.pane_cwd_match = _pane_cwd_match


# ---- usage quota -----------------------------------------------------------

# Antigravity (Google). Credentials are READ-ONLY: the refresh token comes
# from the CLI's Keychain entry (stale-file fallback) and the minted access
# token stays in memory — Google's refresh grant returns no new refresh token
# (verified live), so nothing the CLI owns ever rotates. client_id/secret are
# Antigravity's public installed-app OAuth constants (the same values ship in
# its OSS auth plugin); an optional app-data override file can replace them.
ANTIGRAVITY_KEYCHAIN_SERVICE = "gemini"
ANTIGRAVITY_KEYCHAIN_ACCOUNT = "antigravity"
ANTIGRAVITY_KEYRING_PREFIX = "go-keyring-base64:"
ANTIGRAVITY_TOKEN_FILE_REL = (".gemini", "antigravity-cli", "antigravity-oauth-token")
ANTIGRAVITY_TOKEN_URL = "https://oauth2.googleapis.com/token"
ANTIGRAVITY_API_BASE = "https://cloudcode-pa.googleapis.com"
ANTIGRAVITY_LOAD_URL = f"{ANTIGRAVITY_API_BASE}/v1internal:loadCodeAssist"
ANTIGRAVITY_QUOTA_URL = f"{ANTIGRAVITY_API_BASE}/v1internal:retrieveUserQuotaSummary"
ANTIGRAVITY_LOAD_METADATA = {
    "ideType": "ANTIGRAVITY",
    "platform": "PLATFORM_UNSPECIFIED",
    "pluginType": "GEMINI",
}
# Minting an access token needs Antigravity's own OAuth client credentials.
# This app ships none and stores none: the values come from the environment, so
# enabling this provider is the operator's explicit act, not something a build
# carries. Unset (the default) means the quota read is skipped with a status
# that says why, rather than a mystery error.
ANTIGRAVITY_CLIENT_ID = os.environ.get("NAVIDE_ANTIGRAVITY_CLIENT_ID", "")
ANTIGRAVITY_CLIENT_SECRET = os.environ.get("NAVIDE_ANTIGRAVITY_CLIENT_SECRET", "")
ANTIGRAVITY_NEEDS_OAUTH_CONFIG = (
    "signed in, but reading the quota needs Antigravity's OAuth client "
    "credentials; set NAVIDE_ANTIGRAVITY_CLIENT_ID and "
    "NAVIDE_ANTIGRAVITY_CLIENT_SECRET to enable it"
)


def _antigravity_refresh_token(raw: str) -> str | None:
    """Extract ``token.refresh_token`` from a stored Antigravity credential
    blob. Accepts both the Keychain form (``go-keyring-base64:`` + base64(JSON))
    and the bare JSON token file. The stored access_token is deliberately
    ignored — it is almost always expired and a fresh one is minted in memory
    from the refresh token."""
    raw = raw.strip()
    if raw.startswith(ANTIGRAVITY_KEYRING_PREFIX):
        try:
            raw = base64.b64decode(
                raw[len(ANTIGRAVITY_KEYRING_PREFIX):]).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    token = data.get("token") if isinstance(data, dict) else None
    if isinstance(token, dict):
        rt = token.get("refresh_token")
        if isinstance(rt, str) and rt:
            return rt
    return None


def read_antigravity_credentials_file(home: Path) -> str | None:
    """Stale-file fallback: ``~/.gemini/antigravity-cli/antigravity-oauth-token``.
    Returns the refresh_token or None."""
    path = home.joinpath(*ANTIGRAVITY_TOKEN_FILE_REL)
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    return _antigravity_refresh_token(raw)


def identity_from_secret(secret):
    """A parked slot holds the vault's keychain payload (macOS) or the bare
    token file (elsewhere). Signed in when a refresh token can be read out
    of it; the blob names no account, so ``email`` stays None."""
    items = keychain_payload_items(secret)
    raw = next(iter(items.values()), None) if items else secret
    signed_in = raw is not None and _antigravity_refresh_token(raw) is not None
    return {"email": None, "signedIn": signed_in}


_agy_keychain_failed_at: float | None = None


async def read_antigravity_credentials(home: Path) -> str | None:
    """Keychain first (macOS ``security find-generic-password``, read-only),
    then the stale token file. Returns the refresh_token or None. A failed
    Keychain read is remembered for ``_KEYCHAIN_COOLDOWN_S`` so a denial does
    not re-prompt every poll (mirrors ``read_claude_credentials``)."""
    global _agy_keychain_failed_at
    now = time.monotonic()
    if sys.platform == "darwin" and (
        _agy_keychain_failed_at is None
        or now - _agy_keychain_failed_at >= _KEYCHAIN_COOLDOWN_S
    ):
        try:
            proc = await asyncio.create_subprocess_exec(
                "/usr/bin/security", "find-generic-password",
                "-s", ANTIGRAVITY_KEYCHAIN_SERVICE,
                "-a", ANTIGRAVITY_KEYCHAIN_ACCOUNT, "-w",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            out = await _communicate_or_kill(proc, timeout=2.0)
            if proc.returncode == 0:
                _agy_keychain_failed_at = None
                rt = _antigravity_refresh_token(out.decode("utf-8", "replace"))
                if rt is not None:
                    return rt
            else:
                _agy_keychain_failed_at = now
        except (OSError, asyncio.TimeoutError):
            _agy_keychain_failed_at = now
    return read_antigravity_credentials_file(home)




_ANTIGRAVITY_WINDOW_KINDS = {"5h": "session", "weekly": "weekly"}


def normalize_antigravity(data: dict) -> tuple[list[dict], str | None]:
    """``groups[].buckets[]`` from retrieveUserQuotaSummary. remainingFraction
    is a 0..1 remaining ratio (omitted when a full quota is implied -> 0 used);
    ``window`` is "5h"/"weekly". The tightest (lowest remaining) bucket sorts
    first so a windows[0]-only consumer surfaces the most-constrained quota."""
    ranked: list[tuple[float, dict]] = []
    for group in data.get("groups") or []:
        if not isinstance(group, dict):
            continue
        group_name = group.get("displayName")
        for bucket in group.get("buckets") or []:
            if not isinstance(bucket, dict):
                continue
            frac = _num(bucket.get("remainingFraction"))
            if frac is None:
                frac = 1.0  # omitted when the quota is untouched
            window = bucket.get("window")
            kind = _ANTIGRAVITY_WINDOW_KINDS.get(window) or (
                window if isinstance(window, str) and window else "other")
            names = [n for n in (group_name, bucket.get("displayName"))
                     if isinstance(n, str) and n]
            label = " — ".join(names) or str(bucket.get("bucketId") or "Quota")
            reset = bucket.get("resetTime")
            ranked.append((frac, _window(
                kind, label, 100.0 * (1.0 - frac),
                reset if isinstance(reset, str) else None)))
    ranked.sort(key=lambda item: item[0])
    return [w for _, w in ranked], None


def antigravity_plan(data: dict) -> str | None:
    """loadCodeAssist ``currentTier`` -> plan label (name, falling back to id),
    surfaced as-is."""
    tier = data.get("currentTier")
    if not isinstance(tier, dict):
        return None
    for key in ("name", "id"):
        value = tier.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def antigravity_project(data: dict) -> str | None:
    """loadCodeAssist ``cloudaicompanionProject`` is a plain string or ``{id}``."""
    project = data.get("cloudaicompanionProject")
    if isinstance(project, str) and project:
        return project
    if isinstance(project, dict):
        pid = project.get("id")
        if isinstance(pid, str) and pid:
            return pid
    return None




async def refresh_antigravity_token(refresh_token: str) -> str | None:
    """Exchange the refresh_token for an access_token, held in memory only.

    Never written back to the Keychain or ``~/.gemini``; Google's grant returns
    no new refresh token, so nothing the CLI owns rotates. None on 400/401
    (invalid_grant -> expired); other failures raise for the caller to map."""
    import httpx

    body = {
        "grant_type": "refresh_token",
        "client_id": ANTIGRAVITY_CLIENT_ID,
        "client_secret": ANTIGRAVITY_CLIENT_SECRET,
        "refresh_token": refresh_token,
    }
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.post(ANTIGRAVITY_TOKEN_URL, data=body)
    if resp.status_code in (400, 401):
        return None
    resp.raise_for_status()
    token = resp.json().get("access_token")
    if not isinstance(token, str) or not token:
        raise ValueError("token response had no access_token")
    return token


async def fetch_antigravity(home: Path) -> dict:
    """Quota via Google's Code Assist API, using the CLI's stored refresh token.

    The heaviest read of the set, and the only one whose enablement is a
    deliberate act: it needs Antigravity's OAuth client credentials, which this
    app neither ships nor stores (see ANTIGRAVITY_CLIENT_ID). Without them the
    account still reports as signed in — that part is a local file lookup — and
    the quota is reported as unavailable with the reason."""
    refresh_token = await read_antigravity_credentials(home)
    if refresh_token is None:
        return _snapshot("antigravity", "no-credentials")
    if not (ANTIGRAVITY_CLIENT_ID and ANTIGRAVITY_CLIENT_SECRET):
        return _snapshot("antigravity", "unavailable",
                         error=ANTIGRAVITY_NEEDS_OAUTH_CONFIG)
    import httpx

    try:
        access_token = await refresh_antigravity_token(refresh_token)
    except (httpx.HTTPError, ValueError) as err:
        return _snapshot("antigravity", "error", error=f"token refresh: {err}")
    if access_token is None:
        return _snapshot("antigravity", "expired")

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Navide",
    }
    plan: str | None = None
    project: str | None = None
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            # loadCodeAssist supplies the project id + tier. Best effort — a
            # failure must not block the quota read ({} still works there).
            try:
                load = await client.post(
                    ANTIGRAVITY_LOAD_URL, headers=headers,
                    json={"metadata": ANTIGRAVITY_LOAD_METADATA})
                if load.status_code == 200:
                    payload = load.json()
                    if isinstance(payload, dict):
                        project = antigravity_project(payload)
                        plan = antigravity_plan(payload)
            except (httpx.HTTPError, ValueError):
                pass
            resp = await client.post(
                ANTIGRAVITY_QUOTA_URL, headers=headers,
                json={"project": project} if project else {})
    except httpx.HTTPError as err:
        return _snapshot("antigravity", "error", error=str(err))
    if resp.status_code == 401:
        return _snapshot("antigravity", "expired")
    if resp.status_code == 429:
        snap = _snapshot("antigravity", "rate-limited")
        snap["retryAfterSec"] = parse_retry_after(resp.headers.get("Retry-After"))
        return snap
    if resp.status_code != 200:
        return _snapshot("antigravity", "error", error=f"HTTP {resp.status_code}")
    windows, _ = normalize_antigravity(resp.json())
    return _snapshot("antigravity", "ok", windows=windows, plan_type=plan)




# ---- session ---------------------------------------------------------------

def _resume_id_from_command(command) -> str:
    args = simple_command_args(command)
    if not args or args[0] != "agy":
        return ""
    for index, arg in enumerate(args[1:], 1):
        if arg == "--":
            break
        if arg == "--conversation" and index + 1 < len(args):
            value = args[index + 1]
        elif arg.startswith("--conversation="):
            value = arg.partition("=")[2]
        else:
            continue
        return value if value and not value.startswith("-") else ""
    return ""


def _session_path(workspace_path: str, session_id: str) -> Path:
    # Each conversation is a SQLite db; the id is the filename stem accepted
    # by `agy --conversation <id>`.
    return (Path.home() / ".gemini" / "antigravity-cli" / "conversations"
            / f"{session_id}.db")


# ---- vendor spec -----------------------------------------------------------

# Where this CLI keeps the extensions it installed for itself (read-only
# inventory, cli_extensions). Verified 2026-10-10 against the installed
# binary's --help and the files on disk.
_EXTENSIONS = ExtensionsSpec(
    supported=False,
    note="agy has plugins (`agy plugin list`), but where it keeps them is not verified yet.",
)

SPEC = VendorSpec(
    extensions=_EXTENSIONS,
    key="antigravity",
    # Quota/OAuth constants above do not establish CLI service expectations.
    expected_hosts=(),
    # Conversation root from AntigravityLogReader; honor the pane HOME shim.
    data_dirs=lambda ctx: (ctx.path(ctx.home / ".gemini" / "antigravity-cli"),),
    supports_model=True,
    supports_effort=True,
    known_efforts=('low', 'medium', 'high'),
    # Verified 2026-08-15: `gemini skills list` reports locations under
    # ~/.gemini/skills — not the ~/.gemini/antigravity-cli/skills that other
    # shared configs assume. Rides the HOME shim its MCP wiring builds.
    skills_supported=True,
    skills_wiring=SkillsWiring(
        root_env="HOME",
        skills_rel=(".gemini", "skills"),
    ),
    label="Antigravity CLI (Google)",
    # Multi-account: the refresh token is one fixed-name macOS Keychain item
    # (service "gemini", account "antigravity" — go-keyring, base64 JSON),
    # with the token file below as the stale copy the reader falls back to.
    # There is no config-dir variable, so a login pane cannot be isolated:
    # `agy` signs in against the real Keychain and the result is captured.
    # Only macOS is declared — which of the two locations is authoritative
    # elsewhere has not been established from source. The CLI mints its
    # access token at startup from the refresh token: restart, then
    # ``agy --conversation <id>``.
    live_file=ANTIGRAVITY_TOKEN_FILE_REL,
    slot_file="credential.json",
    identity_from_secret=identity_from_secret,
    account_switch=AccountSwitchSpec(
        auth_scope="antigravity",
        method="restart",
        store="keychain",
        evidence="source",
        verified_version="1.2.7",
        platforms=("darwin",),
        keychain_items=((ANTIGRAVITY_KEYCHAIN_SERVICE, ANTIGRAVITY_KEYCHAIN_ACCOUNT),),
        resume="native",
        todo="Keychain item/file precedence outside macOS not established; the stale token file is left as is after a swap; no real-account round-trip recorded",
    ),
    # No flag, no config variable, and no config-dir variable either — the
    # config root is hardcoded under the home directory, shared with the
    # Antigravity IDE. "url"/"httpUrl" are rejected as legacy: a remote server
    # is keyed by serverUrl.
    mcp_wiring=McpWiring(
        config=McpServerConfig(
            section=("mcpServers",),
            entry=(("serverUrl", McpValue.URL),),
        ),
        config_dir=".gemini",
        config_file=("config", "mcp_config.json"),
    ),
    # Late-bound (module global at call time) so tests can monkeypatch.
    fetch_usage=lambda home: fetch_antigravity(home),
    resume_id_from_command=_resume_id_from_command,
    session_path=_session_path,
    make_log_reader=AntigravityLogReader,
    install_dep=Dep("antigravity", "Antigravity CLI (Google)", "Google Antigravity CLI", "agent_cli",
        ["agy", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="curl -fsSL https://antigravity.google/cli/install.sh | bash",
        needs_terminal=True, requires_binaries=("curl",), optional=True,
        docs_url="https://antigravity.google/docs/getting-started?tab=cli",
        # Windows: the official PowerShell installer, per
        # https://antigravity.google/docs/getting-started?tab=cli
        install_cmds={"win32": PlatformInstall(
            "irm https://antigravity.google/cli/install.ps1 | iex", needs_terminal=True)},
        update_cmd="agy update"),
)
