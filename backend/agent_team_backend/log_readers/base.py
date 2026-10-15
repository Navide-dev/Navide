"""Common types + LogReader abstract base."""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from datetime import datetime, timezone
from typing import Any, BinaryIO

log = logging.getLogger("agent_team_backend.log_readers")


@dataclass
class TokenUsage:
    """Single token-usage delta extracted from a CLI conversation log.

    input_tokens already includes cache_read + cache_creation (per design:
    cache folded into input). output_tokens includes any reasoning/thinking
    tokens for vendors that report them.
    """

    vendor: str                # "claude" | "codex"
    input_tokens: int
    output_tokens: int
    cwd: str                   # absolute working directory the session ran in
    session_id: str            # log file's session identifier (uuid)
    file_path: str             # absolute path to the .jsonl file
    dedup_key: str             # stable key per logical event; readers compose this
    timestamp: str = ""        # ISO 8601 if the log records one
    model: str = ""            # e.g. "claude-opus-4-7"
    checkpoint: dict[str, Any] = field(default_factory=dict, repr=False)
    replay_workspace: str = ""
    raw: dict[str, Any] = field(default_factory=dict, repr=False)
    #: The cache portions already folded into input_tokens, kept apart for the
    #: per-account ledgers (0 when the vendor's log has no split).
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    #: CLI account pin of the pane this usage is attributed to. Readers never
    #: set it (the log carries no account); the ingestion sink fills it from
    #: the pane account history. "unknown" = could not be resolved.
    profile_id: str = "unknown"
    #: CLI version the log records for this event ("" when it has none).
    cli_version: str = ""

    @property
    def total(self) -> int:
        return self.input_tokens + self.output_tokens


#: Cap for the user-prompt text a reader attaches to a user-record
#: "agent_active" event (the frontend names a pane from the first one).
USER_PROMPT_MAX_CHARS = 500


#: Cap for the longer copy of the same prompt kept for chat-channel mirroring.
FULL_PROMPT_MAX_CHARS = 16000


class PromptText(str):
    """A user prompt capped at ``USER_PROMPT_MAX_CHARS`` (what pane naming and every
    other consumer sees) that also carries ``.full``: the same normalized text up to
    ``FULL_PROMPT_MAX_CHARS``. Only the chat mirror reads ``.full``; anything that
    slices or copies the string gets a plain ``str`` and is unaffected."""

    full: str = ""


def user_prompt_text(raw: str) -> str:
    """Normalize a user-record's text for pane auto-naming: strip, drop
    '<'-prefixed injected wrappers (session markers, command stubs), cap
    length. Shared by every reader so the filter is identical across CLIs.
    """
    text = raw.strip()
    if not text or text.startswith("<"):
        return ""
    out = PromptText(text[:USER_PROMPT_MAX_CHARS])
    out.full = text[:FULL_PROMPT_MAX_CHARS]
    return out


@dataclass
class ActivityEvent:
    """Vendor-agnostic activity signal extracted from a CLI conversation log.

    event_type:
      - "agent_active"    : agent produced new content or called a tool
                            (proves "still working", regardless of TUI spinner)
      - "turn_complete"   : agent finished its turn (e.g. Claude assistant line
                            with stop_reason=end_turn) — semantic "done" signal
    """

    vendor: str
    event_type: str            # "agent_active" | "turn_complete"
    cwd: str
    session_id: str
    file_path: str
    dedup_key: str             # stable key per event for in-memory dedup
    timestamp: str = ""        # ISO 8601 if available
    detail: str = ""           # e.g. tool name, stop_reason, record type.
                               # Part of the cross-end contract: the frontend
                               # treats "user"/"prompt"/"user_message" details
                               # as user-prompt events when auto-naming panes.
    text: str = ""             # assistant message text for this turn, when the
                               # vendor log carries it; "" when unavailable
    raw: dict[str, Any] = field(default_factory=dict, repr=False)


def join_text_blocks(content: Any, block_type: str) -> str:
    """Join the text of a message's content blocks of one type ("" when none).

    Shared by the vendor readers so assistant-text extraction stays identical
    across CLIs — the pipeline's sentinel/question judgment depends on this
    normalization being the same for every vendor.
    """
    if isinstance(content, str):
        return content
    parts: list[str] = []
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == block_type:
                parts.append(str(block.get("text") or ""))
    return "\n".join(p for p in parts if p)


@dataclass
class IncrementalParseResult:
    """Token events plus the compact cursor after the last complete source item."""

    events: list[TokenUsage]
    checkpoint: dict[str, Any]


@dataclass(frozen=True)
class TokenSinkResult:
    """Explicit sink acknowledgement used before a watcher advances a cursor."""

    handled: bool
    workspace_path: str = ""


#: Cap for a turn's prompt excerpt (the user's words, for the Turn Stats list).
TURN_EXCERPT_MAX_CHARS = 80


@dataclass
class TurnCall:
    """One model call inside a turn. The four token counts are kept apart —
    unlike TokenUsage, nothing is folded into input here."""

    ts: str | None
    model: str
    input: int
    cache_read: int
    cache_creation: int
    output: int
    cli_version: str = ""      # CLI version the log records for this call


@dataclass
class TurnUsage:
    """One user-facing turn of a session: prompt → reply finished."""

    turn_index: int            # 1-based, in time order
    session_id: str
    started_at: str | None     # ISO 8601 when the log records one
    ended_at: str | None
    prompt_excerpt: str        # user's words, capped at TURN_EXCERPT_MAX_CHARS
    input: int = 0
    cache_read: int = 0
    cache_creation: int = 0
    output: int = 0
    calls: list[TurnCall] = field(default_factory=list)
    #: Model-call count when the log states it without listing the calls
    #: (grok's modelCalls); None means len(calls).
    model_calls: int | None = None
    #: Account pin resolved at query time from the pane account history
    #: (readers leave it "unknown" — a transcript names no account).
    profile_id: str = "unknown"
    #: CLI version of the turn's calls; when they differ (an upgrade mid-turn)
    #: the last call's version wins.
    cli_version: str = ""

    @property
    def total(self) -> int:
        return self.input + self.cache_read + self.cache_creation + self.output

    @property
    def call_count(self) -> int:
        return len(self.calls) if self.model_calls is None else self.model_calls

    def add_call(self, call: TurnCall) -> None:
        self.input += call.input
        self.cache_read += call.cache_read
        self.cache_creation += call.cache_creation
        self.output += call.output
        self.calls.append(call)
        if call.cli_version:
            self.cli_version = call.cli_version


def turn_excerpt(text: str) -> str:
    return " ".join(str(text or "").split())[:TURN_EXCERPT_MAX_CHARS]


def merge_prompt_excerpt(current: str, text: str) -> str:
    """Fold one more user record into a turn's excerpt: the first typed
    prompt wins, and a "<"-prefixed injected wrapper (session marker, command
    stub) only stands in until a typed one arrives."""
    typed = user_prompt_text(text)
    if typed:
        return current if current and not current.startswith("<") else turn_excerpt(typed)
    return current or turn_excerpt(text)


def turn_timestamp(raw: str) -> str | None:
    """Normalize a reader timestamp for the turn contract: epoch-ms strings
    (kimi and friends) become ISO 8601, ISO passes through, "" becomes None."""
    if not raw:
        return None
    try:
        seconds = float(raw) / 1000.0
    except ValueError:
        return raw
    stamp = datetime.fromtimestamp(seconds, tz=timezone.utc)
    return stamp.strftime("%Y-%m-%dT%H:%M:%S") + f".{stamp.microsecond // 1000:03d}Z"


def _turn_sort_key(raw: str) -> float | None:
    """Seconds since epoch for either timestamp form a reader emits, or None
    when the record carries none (such an event stays with the latest turn)."""
    if not raw:
        return None
    try:
        return float(raw) / 1000.0
    except ValueError:
        pass
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


_ANCHOR_BYTES = 512


def tail_anchor(fh: BinaryIO, end: int) -> str:
    """Fingerprint of the bytes ending at `end` (up to `_ANCHOR_BYTES` of them).

    Stored next to a byte-offset watermark so the next read can check the
    file still holds what was consumed up to it. dev:ino alone cannot: Linux
    hands a freed inode number to the next file created in its place, so a
    replacement no shorter than the offset passes the identity and shrink
    checks and gets read from the middle of a line.
    """
    start = max(0, end - _ANCHOR_BYTES)
    fh.seek(start)
    return hashlib.blake2b(fh.read(end - start), digest_size=8).hexdigest()


def read_jsonl_tail(
    path: Path,
    checkpoint: dict[str, Any],
) -> tuple[list[tuple[int, dict[str, Any] | None]], dict[str, Any], bool]:
    """Read complete JSONL records after a byte offset.

    Returns ``(records, next_checkpoint, rotated)``. A partial trailing line is
    intentionally left unread so a later append can complete it. File identity,
    shrink and tail-anchor checks prevent seeking into a replaced/truncated
    generation.
    """
    stat = path.stat()
    identity = f"{stat.st_dev}:{stat.st_ino}"
    prior_identity = str(checkpoint.get("identity") or "")
    prior_anchor = str(checkpoint.get("anchor") or "")
    offset = max(0, int(checkpoint.get("offset") or 0))
    rotated = bool(offset and (prior_identity != identity or stat.st_size < offset))

    records: list[tuple[int, dict[str, Any] | None]] = []
    with path.open("rb") as fh:
        # Checkpoints persisted before the anchor existed carry none and are
        # trusted on identity and size alone, as before.
        if offset and not rotated and prior_anchor and tail_anchor(fh, offset) != prior_anchor:
            rotated = True
        if rotated:
            offset = 0
        committed = offset
        fh.seek(offset)
        while True:
            raw = fh.readline()
            if not raw:
                break
            end = fh.tell()
            if not raw.endswith(b"\n"):
                break
            committed = end
            try:
                value = json.loads(raw.decode("utf-8"))
                records.append((end, value if isinstance(value, dict) else None))
            except (UnicodeDecodeError, json.JSONDecodeError):
                records.append((end, None))
        anchor = tail_anchor(fh, committed) if committed else ""

    next_checkpoint = dict(checkpoint)
    next_checkpoint.update(
        {"kind": "jsonl", "offset": committed, "identity": identity, "anchor": anchor}
    )
    return records, next_checkpoint, rotated


def encode_claude_cwd(cwd: str) -> str:
    """Claude Code's project-dir name for a cwd — the single source of truth.

    Claude replaces EVERY non-alphanumeric char with "-" (dots, underscores,
    spaces, unicode — not just "/"). It encodes its *normalized* cwd, which
    never carries a trailing separator, so strip one before encoding:
    otherwise the extra "-" makes the encoded dir miss the real one.

    Lives here rather than in claude's vendor module because qwen reuses the
    same encoding for its per-project dirs — shared infrastructure, not
    claude-only knowledge.
    """
    return re.sub(r"[^A-Za-z0-9]", "-", cwd.rstrip("/\\"))


# ── activity dedup: line-scan high-water mark ─────────────────────────────
#
# parse_activity's `seen_keys` is a per-file bag the watcher keeps for the life
# of the file (see LogWatcher._activity_seen). Readers that scan a text log from
# line 1 in ascending order used to put one `act:{line_no}` key in it per line,
# which meant the bag grew forever with the transcript: measured 2026-08-18,
# 452,693 live keys two minutes into a startup scan, pinning 481 MB of pymalloc
# arenas the interpreter can never hand back (GitHub #23). Those keys carry no
# information a single integer doesn't — after a scan to line N the set holds
# exactly lines 1..N — so such readers record one sentinel instead.
#
# Only valid for a strictly ascending, dense line counter where every line the
# reader does not skip *before* the seen test is marked. A reader keyed on db
# row ids, byte offsets, per-session sequence numbers, or one that deliberately
# leaves a malformed line unmarked so a later poll re-reads it, must keep exact
# per-item keys.
_ACTIVITY_HW_PREFIX = "act_hw::"


def activity_high_water(seen_keys: set[str]) -> int:
    """Highest line already parsed out of this file, or 0 for a fresh scan."""
    for k in seen_keys:
        if k.startswith(_ACTIVITY_HW_PREFIX):
            try:
                return int(k[len(_ACTIVITY_HW_PREFIX):])
            except ValueError:
                return 0
    return 0


def set_activity_high_water(seen_keys: set[str], line_no: int) -> None:
    """Record progress through `line_no`, replacing any earlier mark.

    Never moves backwards: a truncated or rewritten file leaves the old mark
    standing, which is exactly what the per-line keys used to do.
    """
    current = activity_high_water(seen_keys)
    if line_no <= current:
        return
    seen_keys.difference_update(
        {k for k in seen_keys if k.startswith(_ACTIVITY_HW_PREFIX)}
    )
    seen_keys.add(f"{_ACTIVITY_HW_PREFIX}{line_no}")


#: Wall-clock time this process started, captured at import. A transcript whose
#: last write predates it cannot hold activity the running backend has any live
#: pane state to attach to, so on first sight it is seeded rather than replayed
#: (see seed_pre_start_activity). Patchable in tests.
PROCESS_START_S = time.time()

#: A file untouched for longer than this before the process started can only
#: hold history: the MSG delivery path already refuses anything whose own
#: timestamp is more than 60s old (App.vue's TURN_TEXT_REPLAY_TOLERANCE_MS), so
#: nothing still deliverable can be hiding in it. Anything more recent might —
#: a live pane mid-turn, or a turn written just before a crash — so its tail is
#: read rather than skipped. Generous against that 60s on purpose: the cost of
#: being wrong is one-directional (a dropped turn has no second chance).
SEED_TAIL_GRACE_S = 300.0

#: How much of a recent file's tail is left for the reader to parse. Bounded on
#: purpose: the whole point is that startup cost stops scaling with transcript
#: size. Large enough to hold several turns of any vendor, including Claude's
#: tool-output lines, which are the longest by a wide margin.
SEED_TAIL_BYTES = 256 * 1024


def seed_pre_start_activity(path: Path, seen_keys: set[str]) -> bool:
    """Mark a transcript as read up to a point, without reading its content.

    The watcher has no durable mark for a file it is seeing for the first time
    (fresh install, first start after upgrade), so the reader would walk it from
    line 1 — a json.loads per line and one broadcast per entry, measured at
    ~148,000 events in the first 60 seconds of a cold start (GitHub #28).
    Counting newlines reaches the same resume point for a fraction of the cost.

    Only for readers whose `activity_resumes_by_line` is set: the mark is a line
    number, and a reader keyed on db row ids or per-session sequence numbers
    would not consult it. Returns True when a mark was set.

    How far the mark goes depends on how recently the file was written, because
    the cost of guessing wrong is one-directional — a turn skipped here has no
    second chance, since nothing re-reads a line once the mark is past it:

    * Untouched for more than SEED_TAIL_GRACE_S before this process started:
      history only. Marked to the end; nothing is parsed, nothing is broadcast.
    * More recent than that: it may belong to a live pane mid-turn, or hold the
      last turn written before a crash. Marked only up to SEED_TAIL_BYTES from
      the end, so the reader parses that tail and delivers what is in it.

    The tail is what makes the second case affordable. Refusing to mark such a
    file at all — the earlier shape of this function — left the reader walking
    it from line 1, so the busiest, largest transcripts were exactly the ones
    that still replayed in full.

    Counts what the readers count, so the mark means the same thing to them: a
    blank line never advances it, and an unterminated final line is left in
    front of it so the completed line is still delivered on the next poll
    (GitHub #21 — advancing past a half-written turn-end record left the pane
    "mid-turn" forever).
    """
    try:
        st = path.stat()
    except OSError:
        return False
    # None = mark the whole file; otherwise the byte offset marking stops at.
    stop_at: int | None = None
    if st.st_mtime >= PROCESS_START_S - SEED_TAIL_GRACE_S:
        stop_at = st.st_size - SEED_TAIL_BYTES
        if stop_at <= 0:
            # The file is all tail. Nothing to skip, so leave it unmarked and
            # let the reader do its ordinary walk.
            return False
    last_line = 0
    try:
        # Binary: only newlines matter here, nothing decodes the content, and
        # byte offsets are what the tail boundary is expressed in. Line
        # numbering matches the readers' text-mode walk — both split on "\n",
        # and a "\r\n" line still ends with one.
        with path.open("rb") as fh:
            offset = 0
            for line_no, raw_line in enumerate(fh, 1):
                if not raw_line.endswith(b"\n"):
                    break
                if stop_at is not None and offset >= stop_at:
                    break
                offset += len(raw_line)
                if raw_line.strip():
                    last_line = line_no
    except OSError:
        return False
    if not last_line:
        return False
    set_activity_high_water(seen_keys, last_line)
    return True


class LogReader(ABC):
    """Abstract reader for one CLI vendor's local conversation logs.

    Subclasses implement `vendor` + the three methods below. The watcher
    orchestrator calls them; readers themselves are stateless apart from
    `seen_keys` which the caller passes in to enable per-file dedup.
    """

    #: Vendor identifier matching `agent_key` in panes ("claude" | "codex").
    vendor: str = ""

    # ---- per-vendor attribution/watch hooks (one-file-per-vendor bridge) --
    # Defaults mean "not migrated": attribution/watcher fall back to their
    # legacy vendor-name branches. A vendor's migration round overrides the
    # hooks on its reader and deletes its name from the legacy branches.

    #: Participates in kickoff-marker file binding (attribution's marker
    #: paths). Migrated replacement for membership in the vendor-name tuples.
    binds_by_marker_file: bool = False

    #: Session files feed the session sink (Agent History). Migrated
    #: replacement for membership in the watcher's vendor-name tuple.
    emits_session_sink: bool = False

    #: How turns_for_session splits a session into turns: "exact" when the
    #: log carries its own turn boundaries (a vendor override), "inferred"
    #: for the generic cut on turn_complete timestamps below, "unsupported"
    #: when the vendor records no token usage at all.
    turns_method: str = "inferred"

    #: Binds via the shared-db marker path (one SQLite store for every
    #: session; grok/opencode/kilo/cursor). Migrated replacement for
    #: membership in attribution's shared-db tuple.
    binds_shared_db_by_marker: bool = False

    #: When a kickoff marker misses, fall back to binding a NEW session to
    #: the single unbound candidate pane in the same cwd. Migrated
    #: replacement for membership in attribution's fallback tuple.
    binds_new_session_single_candidate: bool = False

    #: parse_activity resumes from one dense ascending line high-water mark
    #: (activity_high_water), so a first-sight file can be seeded to EOF by
    #: counting lines instead of parsing them — see seed_pre_start_activity.
    #: False for readers keyed on db row ids or per-session sequence numbers.
    activity_resumes_by_line: bool = False

    def marker_scan_text(self, path: Path) -> str | None:
        """Text to scan for a kickoff marker, or None for the generic
        plain-file read. Override when only part of the file may bind
        (e.g. aider: only the last started-at section is the live session).
        May raise OSError; callers treat that as unreadable."""
        return None

    def workspace_match(
        self, usage: TokenUsage, ws_path: str,
        owner_workspace: str | None = None,
    ) -> bool | None:
        """Does this usage event belong to the workspace at ``ws_path``?
        ``owner_workspace`` is the workspace of the pane a marker binding
        already assigned this session to, when one exists — vendors whose
        logs carry no cwd (cursor) attribute bound sessions through it.
        None = not migrated (attribution's legacy chain decides)."""
        return None

    def pane_cwd_match(
        self, usage: TokenUsage, pane_cwd: str, pane_id: str
    ) -> bool | None:
        """Does this usage event belong to a pane running in ``pane_cwd``?
        None = not migrated (attribution's legacy chain decides)."""
        return None

    #: Marker binding must wait for the vendor's REAL resume id to appear in
    #: the session file (codex: session_meta payload.id — the filename stem
    #: is not accepted by its resume command). Migrated replacement for the
    #: vendor-name check in attribution's marker path.
    requires_real_resume_id: bool = False

    def path_identity(self, usage: TokenUsage) -> tuple[str, str] | None:
        """Identity-path binding, three-state:

        - None: this file is not on the vendor's identity path — fall
          through to marker binding.
        - (pane_id, resume_id): bind now.
        - (pane_id, ""): the path names a pane but the vendor's real resume
          id isn't readable yet — the caller must WAIT (bind nothing this
          event) rather than announce a malformed fallback id.
        Codex: per-pane CODEX_HOME encodes the pane id; session_meta carries
        the real id."""
        return None

    def pane_home_id(self, file_path: str) -> str:
        """Pane/home id encoded in the session file's PATH ('' when none).
        Used to claim sessions for panes spawned with an isolated per-pane
        home (codex)."""
        return ""

    def resume_id_from_session_text(self, text: str) -> str:
        """The id the vendor's resume command needs, parsed from session-file
        text ('' when not found — callers fall back to usage.session_id)."""
        return ""

    def accepts_watch_path(self, path_str: str) -> bool:
        """Accept a filesystem-event path the generic extension filter would
        drop (e.g. aider's Markdown history filenames). Hot path — must be
        a cheap string check."""
        return False

    @abstractmethod
    def project_dirs(self) -> list[Path]:
        """Return all existing root directories under which session jsonl files live.

        Implementations should silently skip non-existent paths (e.g. a user
        without the CLI installed). Returns empty list when nothing exists.
        """

    @abstractmethod
    def session_files(self) -> list[Path]:
        """Enumerate every JSONL session file under project_dirs(), recursively."""

    @abstractmethod
    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        """Parse one JSONL file, return NEW TokenUsage events.

        Implementations MUST:
          - Skip malformed lines (log.debug, never raise)
          - Skip lines whose dedup_key is already in seen_keys
          - Add new dedup_keys to seen_keys (mutating in place is fine)
        """

    def parse_incremental(
        self,
        path: Path,
        checkpoint: dict[str, Any],
    ) -> IncrementalParseResult:
        """Parse from a compact cursor.

        Real token readers override this with byte/row watermarks. The fallback
        keeps compatibility for third-party/test readers using the legacy set
        contract; production readers never persist this unbounded form.
        """
        seen = set(str(k) for k in checkpoint.get("legacy_seen", []))
        events = self.parse_session_file(path, seen)
        return IncrementalParseResult(events, {"kind": "legacy", "legacy_seen": sorted(seen)})

    def cwd_from_file(self, path: Path) -> str:
        """Best-effort: derive the spawning cwd from the session file location.

        Default impl returns empty string (subclasses with deterministic
        path → cwd mapping override).
        """
        return ""

    def session_id_from_path(self, path: Path) -> str:
        """The resume session id for a discovered session file.

        Default: the filename stem — Codex/Grok/Antigravity name each session
        file after its id. Readers whose id lives elsewhere (e.g. Kimi, in the
        `session_<uuid>` grandparent dir; every file is named wire.jsonl)
        override. Return '' for a path that is not a real session file so the
        resume-binding sink skips sibling files (state.json, logs) instead of
        coining bogus ids from their stems.
        """
        return path.stem

    def session_files_for_workspace(self, workspace_path: str) -> list[Path] | None:
        """Return only the session files belonging to `workspace_path`.

        Readers whose on-disk layout maps a workspace to a specific folder
        (e.g. Claude's ~/.claude/projects/<encoded-cwd>/) override this to
        return just that subset, so a per-workspace rescan never has to touch
        unrelated files. Return None to signal "can't scope by path" (e.g.
        Codex stores sessions by date), letting the caller fall back to
        session_files(). Default: None.
        """
        return None

    def watch_dirs(self) -> list[Path]:
        """Return directories the watcher should subscribe to.

        By default this is the same as project_dirs(). Readers with dynamic
        child session directories can override this to watch a stable parent
        while still scanning precise session roots.
        """
        return self.project_dirs()

    def claims_path(self, path: Path) -> bool:
        """True when this reader owns `path` (the watcher's routing test).

        Default: the path lives under one of project_dirs(). Readers whose
        files sit outside any fixed root (Aider's per-workspace history
        file) override with their own match. `path` arrives resolved.
        """
        for d in self.project_dirs():
            try:
                if path.is_relative_to(d.resolve()):
                    return True
            except OSError:
                continue
        return False

    def total_usage_for_session(
        self, path: Path, session_id: str
    ) -> dict[str, int]:
        """Sum EVERY usage event this log holds for one session.

        Pure arithmetic for the live per-session backfill: it re-parses the
        whole source with a throwaway dedup set, so nothing is recorded,
        checkpointed, or credited to cumulative/global — replaying through
        the ingestion pipeline would double-count history it already holds.

        The `session_id` filter is what makes this correct for the vendors
        whose sessions share one source (a single SQLite DB for every
        session); for a one-file-per-session vendor it matches every event.
        Pass "" to take the whole file unfiltered.

        Heavy (session files reach tens of MB) — callers MUST run it off the
        event loop. Vendors inherit this; none should need to override it.
        """
        totals = {"input": 0, "output": 0, "calls": 0}
        for usage in self.parse_session_file(path, set()):
            if session_id and usage.session_id != session_id:
                continue
            totals["input"] += int(usage.input_tokens)
            totals["output"] += int(usage.output_tokens)
            totals["calls"] += 1
        return totals

    def usage_since_for_session(
        self, path: Path, session_id: str, checkpoint: dict[str, Any],
        *, with_cache_read: bool = False,
    ) -> tuple[dict[str, int], dict[str, Any]]:
        """Sum what this log gained for one session since `checkpoint`.

        Same arithmetic and session filter as total_usage_for_session, but it
        reads only the bytes/rows after the cursor and returns the cursor to
        resume from, so a session file that only grows is never re-parsed from
        the top. An empty checkpoint means "the whole source", and the totals
        are then identical to total_usage_for_session's.

        Built on parse_incremental — the same per-vendor primitive the
        ingestion watcher uses — so the live per-session tally reads a file
        exactly the way cumulative/global do. Nothing is recorded or
        checkpointed: the cursor is the caller's private bookkeeping.

        A reader still on parse_incremental's legacy fallback hands back an
        unbounded key set; that form is dropped (empty cursor returned), which
        makes the caller re-read in full next time rather than grow forever.

        `with_cache_read` adds a "cache_read" key: the part of "input" that
        was the context re-read from cache, which a token budget leaves out.

        Heavy (session files reach tens of MB) — callers MUST run it off the
        event loop. Vendors inherit this; none should need to override it.
        """
        parsed = self.parse_incremental(path, dict(checkpoint or {}))
        totals = {"input": 0, "output": 0, "calls": 0}
        if with_cache_read:
            totals["cache_read"] = 0
        for usage in parsed.events:
            if session_id and usage.session_id != session_id:
                continue
            totals["input"] += int(usage.input_tokens)
            totals["output"] += int(usage.output_tokens)
            totals["calls"] += 1
            if with_cache_read:
                totals["cache_read"] += int(usage.cache_read_tokens or 0)
        cursor = dict(parsed.checkpoint)
        if str(cursor.get("kind") or "") == "legacy":
            cursor = {}
        return totals, cursor

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Parse one JSONL file for activity events (agent_active / turn_complete).

        Default returns no events — vendor-specific subclasses override.
        Same dedup discipline as parse_session_file: skip already-seen keys,
        mutate seen_keys in place for new ones.
        """
        return []

    def turns_for_session(self, path: Path, session_id: str = "") -> list[TurnUsage]:
        """Split one session's usage into user-facing turns.

        Generic cut: every usage event this reader parses (one per model
        call) is assigned to the first `turn_complete` from parse_activity
        whose timestamp is not earlier than the call's; calls after the last
        boundary form the still-open trailing turn, and a log with no
        boundary at all is one turn. The prompt excerpt comes from the
        user-prompt activity event (detail user/prompt/user_message) that
        falls in the same window. Vendors whose transcript names its own
        turn boundaries override this and set turns_method="exact".

        TokenUsage folds cache into input, so here input carries the folded
        number and both cache fields stay 0. `session_id` filters the vendors
        whose sessions share one source; "" takes the whole file. Heavy —
        callers MUST run it off the event loop.
        """
        if self.turns_method == "unsupported":
            return []
        usages = [
            u for u in self.parse_session_file(path, set())
            if not session_id or u.session_id == session_id
        ]
        activity = [
            a for a in self.parse_activity(path, set())
            if not session_id or a.session_id == session_id
        ]
        boundaries = sorted(
            k for k in (
                _turn_sort_key(a.timestamp)
                for a in activity if a.event_type == "turn_complete"
            ) if k is not None
        )
        prompts = sorted(
            (k, a.timestamp, a.text) for k, a in (
                (_turn_sort_key(a.timestamp), a)
                for a in activity
                if a.event_type == "agent_active"
                and a.detail in ("user", "prompt", "user_message")
                and a.text
            ) if k is not None
        )

        def window(key: float | None) -> int:
            if key is None:
                return len(boundaries)
            for i, edge in enumerate(boundaries):
                if key <= edge:
                    return i
            return len(boundaries)

        sid = session_id or (usages[0].session_id if usages else "")
        turns: dict[int, TurnUsage] = {}

        def turn_at(i: int) -> TurnUsage:
            turn = turns.get(i)
            if turn is None:
                turn = turns[i] = TurnUsage(
                    turn_index=0, session_id=sid,
                    started_at=None, ended_at=None, prompt_excerpt="",
                )
            return turn

        for key, stamp, text in prompts:
            turn = turn_at(window(key))
            if not turn.prompt_excerpt:
                turn.prompt_excerpt = turn_excerpt(text)
                turn.started_at = turn_timestamp(stamp)
        for usage in sorted(usages, key=lambda u: _turn_sort_key(u.timestamp) or float("inf")):
            turn = turn_at(window(_turn_sort_key(usage.timestamp)))
            turn.add_call(TurnCall(
                ts=turn_timestamp(usage.timestamp), model=usage.model,
                input=int(usage.input_tokens), cache_read=0, cache_creation=0,
                output=int(usage.output_tokens),
            ))
            stamp = turn_timestamp(usage.timestamp)
            if stamp:
                turn.started_at = turn.started_at or stamp
                turn.ended_at = stamp
        out = [turns[i] for i in sorted(turns) if turns[i].calls]
        for n, turn in enumerate(out, 1):
            turn.turn_index = n
        return out
