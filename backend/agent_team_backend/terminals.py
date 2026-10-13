from __future__ import annotations

import asyncio
import codecs
import errno
import logging
import os
import re
import shutil
import signal
import subprocess
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import IO, Any, Awaitable, Callable
from uuid import uuid4

from . import osplat, pty_registry
from .applog import app_data_dir, in_data_dir
from .cli_vendors.base import VendorRuntimeContext
from .cli_vendors.registry import risk_runtime_context
from .osplat import spec
from .osplat.proctree import children_map as _children_map
from .osplat.proctree import walk_descendants as _walk_descendants


# Strip ALL ANSI/VT escape sequences for clean log output:
#   CSI:  \x1b[ ... final-byte
#   OSC:  \x1b] ... \x07  (window title, colour palettes, etc.)
#   OSC (ST-terminated): \x1b] ... \x1b\\
#   DCS:  \x1b P ... \x1b\\
#   APC:  \x1b _ ... \x1b\\
#   SOS:  \x1b X ... \x1b\\
#   PM:   \x1b ^ ... \x1b\\
#   Single-char:  \x1b followed by any byte 0x20-0x7E (includes \x1b7, \x1b8, etc.)
_ANSI_RE = re.compile(
    r"\x1b(?:"
    r"\[[0-?]*[ -/]*[@-~]"          # CSI sequences
    r"|\][^\x07\x1b]*(?:\x07|\x1b\\)"  # OSC (BEL or ST terminated)
    r"|[PX^_][^\x1b]*\x1b\\"        # DCS / APC / SOS / PM
    r"|[@-Z\\-~]"                   # single-byte Fe sequences (incl. \x1b7 \x1b8 = \x1b8)
    r")"
)

# TUI chrome lines we never want in the conversation log.
_TUI_NOISE_RE = re.compile(
    r"bypasspermissions|shift\+tab|esc to interrupt|esctointerrupt"
    r"|tointerrupt|for agents|/effort"
    r"|\[end of text\]"
    r"|^\s*$",   # blank lines (handled separately below)
    re.IGNORECASE,
)


def _clean_for_log(raw: str) -> str:
    """Strip ANSI codes, lone carriage returns, and TUI chrome from terminal output.

    The result is human-readable plain text suitable for a conversation log.
    """
    # 1. Strip all ANSI / VT escape sequences.
    text = _ANSI_RE.sub("", raw)
    # 2. Lone \\r (carriage-return without \\n) means "overwrite this line"
    #    in terminal semantics. Replace with newline so we don't lose content
    #    but accept that some duplicate/overwritten lines may appear.
    text = re.sub(r"\r(?!\n)", "\n", text)
    # 3. Filter out TUI chrome lines and collapse consecutive blank lines.
    lines_out: list[str] = []
    blank_run = 0
    for line in text.splitlines():
        stripped = line.rstrip()
        if _TUI_NOISE_RE.search(stripped):
            continue
        if not stripped:
            blank_run += 1
            if blank_run <= 1:
                lines_out.append("")
        else:
            blank_run = 0
            lines_out.append(stripped)
    return "\n".join(lines_out)


_ARGV_TOKEN_RE = re.compile(r"([?&]t=)[^&\s]+")


def _redact_argv(argv: list[str]) -> list[str]:
    """Mask the `t=` (caller token) query parameter in argv before it reaches
    backend.log. backend.log is 0644, and MCP URLs carry a live caller token
    in that parameter — logging it verbatim hands out a working credential to
    anyone who can read the log file."""
    return [_ARGV_TOKEN_RE.sub(r"\1<redacted>", a) for a in argv]

from .ipc import make_event

log = logging.getLogger("agent_team_backend.terminals")

# JSON event dicts for everything except terminal output; terminal output is
# emitted as pre-built binary WS frames (see _build_output_frame).
EventSink = Callable[[dict[str, Any] | bytes], Awaitable[None]]
# Kept as a deprecated, no-op type alias — historical token sink callback.
# Tokens are now sourced from log files (see agent_team_backend.log_readers).
TokenEventSink = Callable[..., Awaitable[None]]

# Binary terminal-output frame layout (little-endian):
#   u8  frameType = 0x01
#   u32 sequence
#   u8  sessionIdLen, then sessionId utf8 bytes
#   u8  paneIdLen,    then paneId utf8 bytes (may be 0)
#   rest = raw PTY bytes
# Raw bytes go straight to xterm.js (which runs its own streaming UTF-8
# decoder), skipping the decode → JSON-escape → JSON.parse round-trips a text
# frame paid — control-heavy PTY output ballooned ~6x under JSON escaping.
_OUTPUT_FRAME_TYPE = 0x01


def output_frame_session_id(frame: bytes) -> str | None:
    """Session id of a binary terminal-output frame, or None if malformed.

    Only the header is touched — routing (app._active_emit) must not pay for
    scanning the payload.
    """
    if len(frame) < 7 or frame[0] != _OUTPUT_FRAME_TYPE:
        return None
    sid_len = frame[5]
    if len(frame) < 6 + sid_len + 1:
        return None
    return frame[6 : 6 + sid_len].decode("utf-8", errors="replace")


@dataclass
class _InputBlock:
    """One "pty input blocked" episode: from the first EAGAIN until the
    session's _in_buffers drains to empty."""
    since: float                # loop time of the first EAGAIN
    timer: asyncio.TimerHandle | None = None  # pending _INPUT_BLOCK_NOTIFY_MS check
    notified: bool = False      # terminal.input_blocked was sent
    drained: int = 0            # bytes the PTY accepted during the episode


@dataclass
class TerminalSession:
    id: str
    pane_id: str
    agent_key: str | None
    command: list[str]
    cwd: str
    handle: spec.TerminalHandle
    proc: spec.ChildProcess
    started_monotonic: float = field(default_factory=time.monotonic)
    sequence: int = 0
    closed: bool = False
    close_reason: str | None = None
    # Set by a shutdown or kill before it signals the child: a child that exits
    # on that signal reaches EOF first, and its close must still say why.
    pending_close_reason: str | None = None
    exit_code: int | None = None
    uptime_ms: int | None = None
    exit_signal: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    output_log_fp: IO[str] | None = field(default=None, repr=False)
    # Per-session vendor-parser state — used by vendor_parsers.parse_chunk to
    # compute deltas against the last seen cumulative token totals.
    vendor_parser_state: dict[str, Any] = field(default_factory=dict)
    # Rolling snapshot of the child's descendant pids (pid -> ps lstart at
    # capture time), refreshed by the service's snapshot loop while the child
    # is alive. When the child dies on its own (EOF path) its ancestry is
    # already gone from the ps table, so this is the only record of
    # grandchildren in their own process group (e.g. MCP servers a CLI spawns
    # detached) that leak as orphans. lstart is the identity check that keeps
    # a stale entry from ever matching a recycled pid (same pattern as
    # pty_registry).
    descendants: dict[int, str] = field(default_factory=dict)
    # Sanitized path/override context only; never persisted as pane metadata.
    risk_context: VendorRuntimeContext | None = field(default=None, repr=False)


# Output logs currently held open for append by a live session (terminal
# session id -> path). Process-wide on purpose: every WebSocket session owns
# its own TerminalService, while the storage scan that consults this runs
# without any session context. Mutated from the event loop and read from
# worker threads (asyncio.to_thread), hence the lock.
_live_output_logs: dict[str, str] = {}
_live_output_logs_lock = threading.Lock()


def _register_live_log(session_id: str, path: str) -> None:
    with _live_output_logs_lock:
        _live_output_logs[session_id] = path


def _forget_live_log(session_id: str) -> None:
    with _live_output_logs_lock:
        _live_output_logs.pop(session_id, None)


def live_output_log_for(session_id: str) -> str:
    """The transcript path this PTY session is actually appending to.

    A pane that reattaches to a live PTY never calls create(), so no log is
    opened for it and the path its caller computed from the new pane id names
    a file that will never exist. The conversation is in the file the session
    opened when it was first created — this is how a reattaching pane finds it
    instead of inventing a name nothing writes to.
    """
    with _live_output_logs_lock:
        return _live_output_logs.get(session_id, "")


def live_output_log_paths() -> set[str]:
    """Paths of the transcript logs live panes are writing into right now.

    The storage scan uses this to keep such a log out of every cleanable
    bucket: unlinking it would send the PTY's ongoing writes to a deleted
    inode, so the transcript silently stops growing and the file is gone.
    """
    with _live_output_logs_lock:
        return set(_live_output_logs.values())


# Batch PTY output chunks for up to this many milliseconds before sending a
# single WebSocket message.  Without batching, a streaming agent can produce
# hundreds of tiny messages per second and overwhelm Electron's Network service
# process, causing it to crash (exit_code=15 / white-screen).
# 50ms keeps latency acceptable (<1 frame at 60fps perceived) while cutting
# the message rate by ~10-20x vs unbatched — empirically prevents the crash.
_OUTPUT_BATCH_MS = 50

# How much we take from the PTY per readable callback.  This has to be larger
# than one TUI viewport repaint: a full-screen CLI (Claude Code, Codex) rewrites
# its whole viewport plus cursor-positioning escapes on every single keystroke,
# which easily runs past 20 KB.  Reading it 4 KB at a time turned one repaint
# into enough chunks to saturate the fast-path window below, so every keystroke
# echo paid the full batch delay for as long as the user kept typing — the
# window never got a chance to cool down.  Chunk count only means "sustained
# stream" if a chunk is big enough to represent real throughput.
#
# CAVEAT (measured 2026-08-06): on macOS this size is aspirational.  A PTY
# master read returns at most 1024 bytes however much is asked for — a 200 KB
# burst comes back as 196 reads, never one — so a repaint is still split here.
# _COALESCE_MS below is what actually reassembles it.
_READ_CHUNK_BYTES = 64 * 1024

# Because of the 1024-byte cap above, one readable callback that reads once
# only ever takes 1 KB off the PTY, so a 20 KB repaint needs 20 trips through
# the event loop — 20 decodes and 20 flush-scheduling rounds for one keystroke.
# _on_readable instead drains until EAGAIN, which collapses those into a single
# callback.  The drain is bounded so a sustained flood still yields to the loop:
# _flush_output's remove_reader backpressure only engages between callbacks, and
# an unbounded loop would starve every other session.  256 KB is an order of
# magnitude above one repaint and well under _BUF_CAP.
_READ_DRAIN_MAX_BYTES = 256 * 1024

# Interactive fast path: keystroke echo is a trickle of bytes, and delaying it
# the full batch window makes typing feel laggy (worst for IME input, where the
# wait lands on the commit).  When a session produced less than
# _FAST_PATH_MAX_BYTES within _FAST_PATH_WINDOW_S, flush on the next loop tick
# instead.  Sustained streams exceed the threshold and fall back to
# _OUTPUT_BATCH_MS batching, so the flood protection above still holds.
#
# The gate is BYTES, not chunk count.  Counting chunks conflated "many small
# reads" with "high throughput": a CLI that wakes the reader often — repainting
# a spinner, or splitting one repaint across reads — looked like a stream and
# pushed the typist onto the 50ms path even though the actual data rate was
# trivial.  _READ_CHUNK_BYTES above already made one repaint one chunk for the
# well-behaved CLIs; the byte gate covers the ones it didn't.
# 192KB/0.1s ~= 1.9MB/s: an order of magnitude above per-keystroke repaint
# traffic (tens of KB per key, even while a CLI redraws its footer), well
# below what a real output flood sustains.
_FAST_PATH_WINDOW_S = 0.1
_FAST_PATH_MAX_BYTES = 192 * 1024

# Coalescing window on the interactive fast path.  Flushing on the next loop
# tick (0ms) sounds like the lowest-latency choice, but because macOS caps a
# PTY read at 1024 bytes (see _READ_CHUNK_BYTES), one 20 KB repaint arrives as
# ~20 reads and each got its own flush — 20 WebSocket frames per keystroke,
# every one of them paying a remove_reader/send/add_reader cycle that stops
# draining the PTY while it sends, and costing the renderer 20 parses and 20
# xterm writes.  Waiting 2ms lets a whole repaint land in one flush.
#
# Measured (20 KB-per-keystroke TUI, 60 keystrokes, same round):
#   0ms: p50 7.6ms, p95 34.7ms, 20 frames/keystroke
#   2ms: p50 5.4ms, p95 25.1ms,  1 frame/keystroke
# The window pays for itself — the per-frame overhead it removes exceeds the
# wait.  It stays well under one 16.7ms display frame, so the IME-commit
# concern that motivated the 0ms path (a commit must not wait for a frame)
# still holds.
_COALESCE_MS = 2

# Latency probes.  All three stay silent unless the path they watch crosses its
# threshold, so a healthy session writes nothing at all.  They exist because the
# input round-trip had NO observability: a "typing lags" report left nothing in
# the log to tell a slow PTY echo apart from a stalled WS send apart from a CLI
# that stopped reading its own stdin.  A pane has no local echo, so every
# keystroke is a full round-trip and any one of those three is directly visible.
#
# _ECHO_LAG_WARN_MS   keystroke written to the PTY -> that session's next output
#                     flush, i.e. the backend half of what the user feels.
# _ECHO_LAG_MAX_MS    past this the output almost certainly is not the echo (the
#                     CLI was simply busy), so reporting it would be noise.
# _READER_SUSPEND_WARN_MS
#                     how long _flush_output kept the PTY reader detached while
#                     draining to the WS.  Long holds are the backpressure path:
#                     the kernel buffer fills and the CLI blocks on write.
_ECHO_LAG_WARN_MS = 250
_ECHO_LAG_MAX_MS = 5000
_READER_SUSPEND_WARN_MS = 100
# Upper bound on how long _flush_output keeps the PTY reader detached while a
# drain is on the wire.  The pause is deliberate backpressure (a renderer that
# cannot absorb output must not OOM the backend), but an unbounded one starves
# the CLI's stdin: its stdout write blocks on the full PTY queue, it stops
# reading input, and every message written to it sits in _in_buffers as "pty
# input blocked".  Past this bound the reader resumes and the pressure lands on
# our own output buffer instead (see _BUF_CAP's drop policy).
_READER_PAUSE_MAX_MS = 1000
# Output buffered per session before the OOM guard kicks in.  With no drain in
# flight it forces an immediate flush; with one already stalled on the WS it
# drops the OLDEST chunks instead, so memory stays bounded while the reader
# keeps running.  A TUI loses a partial repaint until its next redraw; the CLI
# itself never notices.
_BUF_CAP = 5 * 1024 * 1024
# Input blocked for longer than this is reported to the owning window as
# terminal.input_blocked (and its release as terminal.input_unblocked) so the
# renderer waits for the CLI instead of re-pasting.  Shorter blips — a TUI
# briefly not reading while it repaints — stay silent.
_INPUT_BLOCK_NOTIFY_MS = 500
# Grace between a kill's SIGTERM and the SIGKILL escalation. Named so a test
# can widen it: the CLI's SIGTERM handler is what flushes the transcript, and
# on a loaded runner that flush can outlast a hard-coded window.
_KILL_ESCALATION_GRACE_S = 1.0
# How long _escalate_kill's post-SIGKILL `proc.wait` can hold the reap.
_REAP_CONFIRM_S = 1.0
# Slack on top of the bounded work wait_until_reaped() covers: two executor
# hops (`proc.wait`, and the poll loops' scheduling) that can queue behind
# other lifecycle calls on a loaded machine. Not a budget for a full-system
# `ps` — that sweep is deliberately outside the wait, see _escalate_kill.
_REAP_WAIT_SLACK_S = 3.0


def _max_vendor_grace_s() -> float:
    """The largest grace any vendor asks for, read from the registry.

    Derived rather than written down: the ceiling below has to cover whatever
    the specs declare, and a vendor that later asks for a longer grace must
    widen the ceiling with it instead of silently overrunning one. Cheap
    enough to call per wait (a dict scan over 14 entries).
    """
    from .cli_vendors.registry import VENDORS

    return max(
        (
            spec.shutdown.grace_s
            for spec in VENDORS.values()
            if spec.shutdown is not None and spec.shutdown.graceful
        ),
        default=0.0,
    )


def _reap_wait_timeout_s() -> float:
    """Ceiling on wait_until_reaped().

    Covers exactly the work that runs between the SIGTERM and the moment the
    child is confirmed down: the vendor's grace, the SIGKILL escalation's own
    grace, the wait that reaps the zombie, and slack for executor queueing.
    The breakaway-grandchild sweep is NOT in here — it is a full-system `ps`
    with a 5s budget of its own, it says nothing about whether this child is
    down, and leaving it inside made the ceiling smaller than the work under
    it. A caller that hits this ceiling has a child that survived a SIGKILL.
    """
    return (
        _max_vendor_grace_s()
        + _KILL_ESCALATION_GRACE_S
        + _REAP_CONFIRM_S
        + _REAP_WAIT_SLACK_S
    )
# Only a keystroke-sized write arms the echo timer.  Role injection and pastes
# are bulk writes whose echo is legitimately slower and would only add noise.
_ECHO_PROBE_MAX_INPUT_CHARS = 16

# PTY lifecycle work — registry register/unregister and zombie reaping — runs
# on its own pool.  It used to share asyncio's default executor with
# _snapshot_loop's _ps_snapshot, a full-system process scan that runs
# continuously for as long as any session is live.  That is the same shape as
# the shared-pool starvation this codebase has hit before, and the cost lands
# where it hurts most: create()'s register call is what the terminal.create ack
# waits on, so a queued process scan delays opening a pane.  Keeping the scans
# on the default executor and the lifecycle calls here decouples the two.
# Four workers matched the old 8-pane-per-workspace spawn cap. That cap is now
# advisory (see agentSpawnGate.ts), so a fan-out is bounded by what the user
# asks for — and create()'s register call is what the terminal.create ack waits
# on, so a queue here shows up as "opening panes got slow" rather than as an
# error anyone can trace. These calls are I/O-bound (fork/exec, /dev/ptmx,
# process bookkeeping), so oversubscribing costs idle threads, not CPU.
_LIFECYCLE_EXECUTOR = ThreadPoolExecutor(
    max_workers=32, thread_name_prefix="pty-lifecycle"
)


def _ps_snapshot() -> dict[int, tuple[int, int, str]]:
    """pid -> (ppid, group id, start-time identity) for every process, from
    one table read (osplat.process_tree.snapshot). The start time is the
    identity that defeats pid recycling; the group id distinguishes detached
    descendants (own group) from same-group children. Empty on failure."""
    return osplat.process_tree.snapshot()


def _descendant_pids(root_pid: int) -> dict[int, str]:
    """Every PID descended from root_pid (child, grandchild, ...) with its
    start-time identity, from one snapshot. killpg on the PTY child's process
    group misses any grandchild that called setsid to start its own
    session/group (some CLIs do) — those outlive the group kill and become
    orphans. Snapshot the tree while root is still alive; once it dies the
    grandchildren reparent to launchd (ppid 1) and the ancestry is gone. The
    identity is what `_kill_breakaway` checks before signalling, so a pid
    recycled between this snapshot and the kill is left alone."""
    snap = _ps_snapshot()
    pids = _walk_descendants(_children_map(snap), root_pid)
    return {pid: snap[pid][2] for pid in pids}


# Steady-state cadence of the descendant-snapshot loop. MCP servers and other
# grandchildren appear within seconds of the CLI starting and the set is
# stable afterwards, so a coarse interval is enough once sessions are mature.
_DESCENDANT_SNAPSHOT_INTERVAL_S = 30.0

# Fast cadence while any session is younger than the normal interval: a CLI's
# grandchildren spawn a few seconds after it, and crash-on-startup is the most
# common ungraceful death — without the fast ticks every young session would
# be blind for up to a full interval.
_DESCENDANT_SNAPSHOT_FAST_S = 5.0

# After an EOF (child died on its own), wait this long before sweeping its
# snapshot: a gracefully exiting CLI shuts its own servers down within this
# window, leaving nothing to kill.
_EXIT_ORPHAN_GRACE_S = 1.0


def _same_process(recorded: str, current: str) -> bool:
    """Whether two start-time identities name the same process. Empty on
    either side is never a match — an unverifiable identity must never
    authorize a kill. Whitespace-normalized: `ps` pads the day-of-month."""
    return (
        bool(recorded)
        and bool(current)
        and " ".join(recorded.split()) == " ".join(current.split())
    )


def _kill_breakaway(pids: dict[int, str]) -> None:
    """SIGKILL each recorded pid that is still the recorded process — the
    breakaway grandchildren a process-group kill could not reach. Takes one
    fresh snapshot and signals only pids whose start-time identity still
    matches the one recorded when the tree was snapshotted: a pid recycled
    since then belongs to someone else. On Windows that someone can be the
    backend's own next pane (the pid space is small and reused fast), so no
    identity means no kill; a failed snapshot kills nothing. Blocking (one
    process-table read) — call via asyncio.to_thread from the loop."""
    if not pids:
        return
    snap = _ps_snapshot()
    if not snap:
        return  # cannot verify identities — do not kill blind
    for pid, recorded in pids.items():
        entry = snap.get(pid)
        if entry is None or not _same_process(recorded, entry[2]):
            continue
        try:
            osplat.process_tree.kill(pid, force=True)
        except (ProcessLookupError, PermissionError):
            pass


async def _to_thread_and_drain_on_cancel(func: Callable[..., Any], *args: Any) -> Any:
    """Do not leave blocking DB work running after its awaiting task is cancelled."""
    worker = asyncio.create_task(asyncio.to_thread(func, *args))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        await asyncio.gather(worker, return_exceptions=True)
        raise


class TerminalService:
    def __init__(
        self,
        emit: EventSink,
        token_event_sink: TokenEventSink | None = None,
    ) -> None:
        self._sessions: dict[str, TerminalSession] = {}
        self._emit = emit
        self._token_event_sink = token_event_sink
        self._loop = asyncio.get_event_loop()
        # The crash-recovery registry lives in the data dir this service was
        # started under. Registry jobs run on worker threads and can still be
        # in flight after the process points elsewhere; bound to this dir they
        # never write another dir's navide.db.
        self._data_dir = app_data_dir()
        # Per-session output batching state — raw PTY bytes, shipped verbatim
        # in binary WS frames (xterm.js decodes UTF-8 itself).
        self._out_buffers: dict[str, list[bytes]] = {}  # session_id -> pending chunks
        # Running total of len() over _out_buffers[session_id].  Kept alongside
        # the list because the OOM guard needs the size on every append, and
        # re-summing the whole buffer each time is quadratic in chunk count.
        self._out_buf_bytes: dict[str, int] = {}       # session_id -> buffered bytes
        self._out_handles: dict[str, asyncio.TimerHandle] = {}  # session_id -> timer
        # One in-flight _flush_output drain per session; a flush that lands
        # while it is on the wire leaves its chunks buffered for the drain to
        # pick up when it finishes.
        self._drain_tasks: dict[str, asyncio.Task[None]] = {}
        # The _READER_PAUSE_MAX_MS timer that resumes the reader under a
        # stalled drain.
        self._pause_timers: dict[str, asyncio.TimerHandle] = {}
        # Per-session lock held by drain_output: while held, nothing else
        # starts a drain (the barrier emits the remainder itself), so a
        # streaming CLI cannot keep the resize waiting — and the several
        # resizes a drag sends run their barriers one after another instead
        # of interleaving frames.
        self._resize_barriers: dict[str, asyncio.Lock] = {}
        # Sessions whose vendor asked for a SIGTERM-first shutdown and whose
        # grace is still running, each mapped to the event its task sets when
        # the child is finally down. The session stays in _sessions across the
        # grace, so without this a second kill() would start a second grace —
        # and a caller that must not spawn over a live child awaits the event
        # through wait_until_reaped().
        self._graceful_kills: dict[str, asyncio.Event] = {}
        # Live _kill_gracefully tasks. Strong references, because the loop
        # keeps only weak ones; discarded by the done-callback that logs
        # whatever the task raised.
        self._kill_tasks: set[asyncio.Task[None]] = set()
        # Bytes dropped from _out_buffers in the current overflow episode and
        # not yet marked in the log mirror.  Present = the episode's warning
        # was logged; cleared once the buffer has fully drained so the next
        # overflow reports again.
        self._out_dropped: dict[str, int] = {}
        # Per-session pending INPUT bytes not yet accepted by the non-blocking
        # PTY master (EAGAIN / partial write). Drained via add_writer.
        self._in_buffers: dict[str, bytearray] = {}    # session_id -> pending bytes
        # Per-session incremental UTF-8 decoders — used ONLY to mirror output
        # into output_log_fp (pipeline panes). The transport itself ships raw
        # bytes; incremental decoding keeps a chunk-split multi-byte character
        # from becoming U+FFFD in the log.
        self._decoders: dict[str, codecs.IncrementalDecoder] = {}
        # Per-session (monotonic loop time, byte count) of recent PTY chunks,
        # used to pick the interactive fast path vs. batched flush delay.
        # maxlen only bounds memory against pathological tiny reads; the
        # window itself is trimmed by time in _window_bytes.
        self._recent_chunks: dict[str, deque[tuple[float, int]]] = {}
        # Latency probe state (see _ECHO_LAG_WARN_MS).  session_id -> loop time
        # of the keystroke whose echo is still outstanding.  Only the FIRST
        # keystroke of a burst is timed: a fast typist would otherwise keep
        # resetting the clock and the lag they are feeling would never report.
        self._echo_probe: dict[str, float] = {}
        # Sessions whose PTY refused input (kernel buffer full).  Tracked so the
        # condition is logged on the transition rather than on every retry,
        # and so the release can report how long it lasted.
        self._input_blocked: dict[str, _InputBlock] = {}
        # Background task keeping each live session's descendant snapshot
        # fresh, so the EOF path can reap orphans (see _reap_exit_orphans).
        # The wakeup event lets create() pull the next refresh forward.
        # Dead sessions' snapshots queue in _pending_reaps and one sweeper
        # task drains them in batches (one ps per batch, however many
        # sessions died together); kill_all awaits it so in-flight sweeps
        # finish before shutdown.
        self._snapshot_task: "asyncio.Task[None] | None" = None
        self._snapshot_wakeup = asyncio.Event()
        self._lifecycle_futures: set[asyncio.Future[Any]] = set()
        self._pending_reaps: dict[int, str] = {}
        self._reap_task: "asyncio.Task[None] | None" = None
        # Sessions closed by EOF while their child was not yet reapable; each
        # task waits (bounded) for the child to die before its cleanup.
        self._exit_settles: set[asyncio.Task[None]] = set()
        self._last_persisted: dict[int, dict[int, str]] = {}

    def create(
        self,
        *,
        pane_id: str,
        agent_key: str | None,
        command: str | list[str],
        cwd: str,
        cols: int = 100,
        rows: int = 30,
        env: dict[str, str] | None = None,
        env_remove: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        output_log_file: str = "",
        spawn_command: str | list[str] | None = None,
    ) -> TerminalSession:
        logical_argv = self._resolve_command(command)
        argv = self._resolve_command(spawn_command) if spawn_command is not None else logical_argv
        if not os.path.isdir(cwd):
            # A path that exists as a file is a different mistake from a
            # missing one — a resumed pipeline once spawned into its own
            # navide.db and was told the file "does not exist".
            # lexists, not exists: a broken symlink is a path that is there and
            # is not a directory, which exists() reports as missing.
            problem = "is not a directory" if os.path.lexists(cwd) else "does not exist"
            raise FileNotFoundError(f"cwd {problem}: {cwd}")
        if not shutil.which(argv[0]):
            raise FileNotFoundError(f"executable not found: {argv[0]}")

        final_env = os.environ.copy()
        final_env["TERM"] = final_env.get("TERM", "xterm-256color")
        final_env["COLUMNS"] = str(cols)
        final_env["LINES"] = str(rows)
        if env:
            final_env.update(env)
        for key in env_remove or ():
            final_env.pop(key, None)
        # Settings → Resource limits: a per-session marker a detached server
        # inherits, so it can be listed after this pane is gone. Inert, and
        # skipped entirely when the user turned tracking off.
        from . import detached_servers, resource_limits

        pane_mark = detached_servers.new_mark() if resource_limits.track_detached(resource_limits.current()) else ""
        if pane_mark:
            final_env[detached_servers.MARK_ENV] = pane_mark
            metadata = metadata if metadata is not None else {}
            metadata["pane_mark"] = pane_mark

        try:
            risk_context = risk_runtime_context(final_env, cwd)
        except ValueError:
            risk_context = None

        started_monotonic = time.monotonic()
        # The platform seam owns the PTY and the child's session/controlling
        # terminal (POSIX: openpty + setsid + claim the ctty; Windows: ConPTY
        # in a kill-on-close job). Nothing is left open if it raises.
        handle = osplat.terminal_backend.spawn(
            argv, cwd=cwd, env=final_env, rows=rows, cols=cols
        )
        proc = handle.proc
        # Record the child so a future backend start can reap it if this
        # process dies without running its shutdown sweep. register runs a ps
        # probe + registry-file I/O — keep it off the event loop so the
        # terminal.create ack isn't delayed behind it.
        registry_future: asyncio.Future[Any] | None = None
        try:
            asyncio.get_running_loop()
            registry_future = self._submit_lifecycle(
                in_data_dir(self._data_dir, pty_registry.register, proc.pid, argv),
            )
        except RuntimeError:
            # No running loop (non-async caller) — fall back to inline.
            try:
                in_data_dir(self._data_dir, pty_registry.register, proc.pid, argv)()
            except BaseException:
                self._abort_failed_create(handle, registry_future=None)
                raise
        except BaseException:
            self._abort_failed_create(handle, registry_future=None)
            raise

        # Open output log file if requested (pipeline panes pass a path).
        log_fp: IO[str] | None = None
        if output_log_file:
            try:
                os.makedirs(os.path.dirname(output_log_file), exist_ok=True)
                log_fp = open(output_log_file, "a", encoding="utf-8", buffering=1)  # noqa: SIM115
            except Exception as err:  # noqa: BLE001
                log.warning("cannot open output log %s: %s", output_log_file, err)

        session: TerminalSession | None = None
        try:
            session = TerminalSession(
                id=str(uuid4()),
                pane_id=pane_id,
                agent_key=agent_key,
                command=logical_argv,
                cwd=cwd,
                handle=handle,
                proc=proc,
                started_monotonic=started_monotonic,
                metadata=metadata or {},
                output_log_fp=log_fp,
                risk_context=risk_context,
            )
            self._sessions[session.id] = session
            if log_fp is not None:
                _register_live_log(session.id, output_log_file)
            handle.start_reading(self._loop, lambda: self._on_readable(session))
        except BaseException:
            if session is not None:
                self._sessions.pop(session.id, None)
                _forget_live_log(session.id)
            if log_fp:
                try:
                    log_fp.close()
                except Exception:  # noqa: BLE001
                    pass
            self._abort_failed_create(handle, registry_future=registry_future)
            raise
        if self._snapshot_task is None or self._snapshot_task.done():
            try:
                self._snapshot_task = asyncio.get_running_loop().create_task(
                    self._snapshot_loop()
                )
            except RuntimeError:
                # No running loop (non-async caller, e.g. sync tests) — rolling
                # snapshots stay empty; kill() still sweeps via its own snapshot.
                pass
        else:
            # Pull the next refresh forward so this session isn't blind for a
            # full interval (the loop then ticks fast while it is young).
            self._snapshot_wakeup.set()
        log.info(
            "terminal session created id=%s pane=%s pid=%s cmd=%s",
            session.id,
            pane_id,
            proc.pid,
            _redact_argv(argv),
        )
        return session

    def _abort_failed_create(
        self,
        handle: spec.TerminalHandle,
        *,
        registry_future: asyncio.Future[Any] | None,
    ) -> None:
        """Undo a spawn whose TerminalSession setup did not complete."""
        proc = handle.proc
        handle.close()
        try:
            osplat.process_tree.kill_group(
                osplat.process_tree.group_of(proc.pid), force=True
            )
        except (ProcessLookupError, PermissionError):
            pass
        try:
            proc.wait(timeout=1.0)
        except (subprocess.TimeoutExpired, OSError):
            pass

        def unregister(_future: asyncio.Future[Any] | None = None) -> None:
            try:
                pty_registry.unregister(proc.pid)
            except Exception as err:  # noqa: BLE001
                log.warning("failed-create registry cleanup failed for pid %s: %s", proc.pid, err)

        # register() may already be running in the executor.  Queue unregister
        # only after it settles, or its eventual write could resurrect the
        # failed child in the crash-recovery registry.
        if registry_future is not None:
            registry_future.add_done_callback(
                lambda _future: self._submit_lifecycle(
                    in_data_dir(self._data_dir, unregister)
                )
            )
        else:
            in_data_dir(self._data_dir, unregister)()

    def _submit_lifecycle(self, operation: Callable[[], Any]) -> asyncio.Future[Any]:
        """Run a registry operation and retain it until its DB use completes."""
        future = self._loop.run_in_executor(_LIFECYCLE_EXECUTOR, operation)
        self._lifecycle_futures.add(future)
        future.add_done_callback(self._lifecycle_futures.discard)
        return future

    async def _drain_lifecycle(self) -> None:
        """Wait for registry work that could still touch the shared database."""
        # Only the unfinished ones: a finished write stays in the set until its
        # discard callback runs, and gather() over futures that are all done
        # completes without yielding (Python 3.12), so re-gathering it would
        # spin without ever letting that callback run.
        while pending := [f for f in self._lifecycle_futures if not f.done()]:
            await asyncio.gather(*pending, return_exceptions=True)

    def get(self, session_id: str) -> TerminalSession | None:
        """The session for ``session_id``, or None when unknown."""
        return self._sessions.get(session_id)

    def shell_in_foreground(self, session_id: str) -> bool | None:
        """Whether the PTY's own child (a plain terminal pane's login shell) is
        the group in front of the tty — sitting at its prompt — rather than a
        program it started (a running command, an editor, a sudo or ssh
        password prompt, a REPL). None when that cannot be told: an unknown or
        closed session, or Windows, whose handle reports the child's pid as
        its foreground group whatever is running."""
        session = self._sessions.get(session_id)
        if session is None or session.closed or not osplat.terminal_backend.reports_foreground:
            return None
        fg = session.handle.foreground_group()
        if fg <= 0:
            return None
        try:
            return fg == osplat.process_tree.group_of(session.proc.pid)
        except (ProcessLookupError, PermissionError):
            return None

    def live_pane_marks(self) -> set[str]:
        """The detached-server markers of every live session."""
        return {
            str(s.metadata.get("pane_mark"))
            for s in self._sessions.values()
            if not s.closed and s.metadata.get("pane_mark")
        }

    def list_session_ids(self) -> list[str]:
        """Ids of all live (not closed) sessions."""
        return [s.id for s in self._sessions.values() if not s.closed]

    def memory_pid_groups(self) -> dict[str, tuple[str, list[int]]]:
        """Per live session: its pane id and every pid in its process tree.

        A pane's memory is the whole tree, not the PTY child: that child is a
        login shell, and the CLI, the MCP servers it spawned and anything else
        below it are where the hundreds of megabytes actually live. The
        descendant snapshot the kill path already maintains is reused rather
        than re-walked, so this stays a dictionary lookup.
        """
        groups: dict[str, tuple[str, list[int]]] = {}
        for session in self._sessions.values():
            if session.closed:
                continue
            pids = [session.proc.pid, *session.descendants.keys()]
            groups[session.id] = (session.pane_id, pids)
        return groups

    def live_session_ids_for_pane(self, pane_id: str) -> list[str]:
        """Every still-running terminal session belonging to a pane.

        Closing a pane normally kills its PTY through the renderer's own
        terminal ref. A pane that never realized has no ref to kill through,
        and its unspawn record is the only signal the backend gets — this is
        what lets that path reach a process the renderer could not.
        """
        if not pane_id:
            return []
        return [
            session.id
            for session in self._sessions.values()
            if session.pane_id == pane_id and not session.closed
        ]

    def live_ids_for_surface(self, surface: str, workspace_path: str = "") -> list[tuple[str, str, str]]:
        """(session id, pane id, workspace) of every running embedded AI panel
        (AiCliDock) that `surface` hosts — in `workspace_path`, or in any
        workspace when it is empty — read from the terminal metadata the
        panel's create carried. A window pane's create names no surface (or
        "main"), so it can never match."""
        if not surface or surface == "main":
            return []

        def norm(path: str) -> str:
            return path.rstrip("/") or path

        workspace = norm(workspace_path)
        hits: list[tuple[str, str, str]] = []
        for session in self._sessions.values():
            if session.closed or str(session.metadata.get("surface") or "") != surface:
                continue
            session_workspace = str(session.metadata.get("workspace_path") or "")
            if workspace and norm(session_workspace) != workspace:
                continue
            hits.append((session.id, session.pane_id, session_workspace))
        return hits

    def find_live_by_resume_id(
        self,
        agent_key: str,
        resume_id: str,
        extract_resume_id: Callable[[list[str]], str],
    ) -> list[TerminalSession]:
        """Live sessions of ``agent_key`` whose launch command resumes
        ``resume_id`` (extractor injected to keep argv parsing out of this
        module)."""
        return [
            s
            for s in self._sessions.values()
            if not s.closed
            and s.agent_key == agent_key
            and extract_resume_id(s.command) == resume_id
        ]

    def write(self, session_id: str, data: str) -> int:
        """Queue `data` for the PTY and return the bytes still pending after
        the flush attempt (0 = the kernel accepted everything)."""
        session = self._require(session_id)
        if session.closed:
            return 0
        if not data:
            # A probe of the pending count (the renderer polls this while it
            # waits out a blocked episode): no bytes, no timers, no flush.
            return len(self._in_buffers.get(session_id) or b"")
        # Queue the bytes and try to drain now. The PTY master is non-blocking,
        # so a full kernel buffer raises EAGAIN. The old code dropped the chunk
        # on EAGAIN (silent data loss — the agent's input box stayed empty while
        # the caller still logged "✓ sent"). Instead we buffer whatever the
        # kernel won't take and finish it from an add_writer callback. partial
        # writes (os.write accepting < len) are handled the same way.
        if len(data) <= _ECHO_PROBE_MAX_INPUT_CHARS:
            self._echo_probe.setdefault(session_id, self._loop.time())
        buf = self._in_buffers.setdefault(session_id, bytearray())
        buf.extend(data.encode("utf-8"))
        self._flush_input(session)
        return len(buf)

    def _flush_input(self, session: TerminalSession) -> None:
        """Drain a session's pending input into the PTY master without blocking.

        Loops on partial writes; on EAGAIN leaves the remainder buffered and
        registers an add_writer callback to resume once the fd is writable.
        """
        buf = self._in_buffers.get(session.id)
        if buf is None or session.closed:
            return
        block = self._input_blocked.get(session.id)
        while buf:
            try:
                n = session.handle.write(buf)
            except BlockingIOError:
                break  # kernel buffer full — resume on writable
            except OSError as err:
                log.warning("write to session %s failed: %s", session.id, err)
                buf.clear()
                self._end_input_block(session)
                self._unwatch_writable(session)
                return
            if n <= 0:
                break
            del buf[:n]
            if block is not None:
                block.drained += n
        if buf:
            # The PTY's kernel buffer is full, i.e. the CLI has stopped reading
            # its stdin. The user sees typed characters simply not appear, so
            # this is worth a line even though it usually self-heals.
            if block is None:
                log.warning(
                    "pty input blocked session=%s agent=%s pending=%d bytes",
                    session.id, session.agent_key, len(buf),
                )
                self._input_blocked[session.id] = _InputBlock(
                    since=self._loop.time(),
                    timer=self._loop.call_later(
                        _INPUT_BLOCK_NOTIFY_MS / 1000,
                        self._notify_input_blocked,
                        session,
                    ),
                )
            self._watch_writable(session)
        else:
            self._end_input_block(session)
            self._unwatch_writable(session)

    def _notify_input_blocked(self, session: TerminalSession) -> None:
        """_INPUT_BLOCK_NOTIFY_MS after the first EAGAIN: still blocked, so
        tell the owning window the CLI has not seen those bytes."""
        block = self._input_blocked.get(session.id)
        if block is None or session.closed:
            return
        block.timer = None
        block.notified = True
        buf = self._in_buffers.get(session.id)
        self._emit_session_event(
            session, "terminal.input_blocked", {"pending": len(buf) if buf else 0}
        )

    def _end_input_block(self, session: TerminalSession) -> None:
        """Close the session's blocked episode, if any.  Only an episode the
        window was told about gets the release event and the log line; short
        blips that never crossed _INPUT_BLOCK_NOTIFY_MS stay silent.
        `drained` is what the PTY actually accepted during the episode —
        also on close or a write error, where the rest was discarded."""
        block = self._input_blocked.pop(session.id, None)
        if block is None:
            return
        if block.timer is not None:
            block.timer.cancel()
        if not block.notified:
            return
        drained = block.drained
        duration_ms = (self._loop.time() - block.since) * 1000
        log.warning(
            "pty input unblocked session=%s agent=%s after=%.0fms drained=%d bytes",
            session.id, session.agent_key, duration_ms, drained,
        )
        self._emit_session_event(
            session,
            "terminal.input_unblocked",
            {"duration_ms": round(duration_ms), "drained": drained},
        )

    def _emit_session_event(
        self, session: TerminalSession, type_: str, fields: dict[str, Any]
    ) -> None:
        """Route a per-session JSON event to the window that owns the PTY —
        the same path terminal.exit takes (the sink keys on
        terminal_session_id)."""
        event = make_event(
            type_,
            {
                "terminal_session_id": session.id,
                "session_id": session.id,
                "pane_id": session.pane_id,
                **fields,
            },
        )
        self._loop.create_task(self._emit(event))

    def _on_writable(self, session: TerminalSession) -> None:
        self._flush_input(session)

    def _watch_writable(self, session: TerminalSession) -> None:
        session.handle.watch_writable(self._loop, lambda: self._on_writable(session))

    def _unwatch_writable(self, session: TerminalSession) -> None:
        session.handle.unwatch_writable()

    def log_sent(self, session_id: str, label: str, text: str) -> None:
        """Append a human-readable record of injected text to the session log.

        Call this BEFORE chunked write() calls so the log shows the full
        message in one block rather than fragmented 512-byte slices.
        The output_log_fp is only set for pipeline panes — silently ignored
        for manual/interactive panes.
        """
        session = self._sessions.get(session_id)
        if not session or not session.output_log_fp:
            return
        ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
        marker = f"[→ {label.upper()} @ {ts}]"
        sep = "─" * min(60, len(marker) + 4)
        try:
            session.output_log_fp.write(
                f"\n{sep}\n{marker}\n{sep}\n{text}\n{sep}\n\n"
            )
        except Exception as err:  # noqa: BLE001
            log.warning("log_sent write failed: %s", err)

    def resize(self, session_id: str, cols: int, rows: int) -> None:
        session = self._require(session_id)
        if session.closed:
            return
        session.handle.resize(rows, cols)

    def force_redraw(self, session_id: str, cols: int, rows: int) -> None:
        """Nudge the PTY size to raise SIGWINCH so a TUI repaints after reattach.
        Resizing to the identical current size would not signal the program, so
        set a transient off-by-one row then the real size. This is how a
        reattaching renderer recovers the screen — there is no output buffer."""
        session = self._sessions.get(session_id)
        if not session or session.closed:
            return
        session.handle.resize(max(rows - 1, 1), cols)
        session.handle.resize(rows, cols)

    async def drain_output(self, session_id: str) -> None:
        """Flush all pending and kernel-buffered output before the caller's
        next send (the resize ack), AWAITING each emit so it lands first.

        Output is normally batched behind a 50ms timer (`_out_handles`) and
        emitted via `create_task`, so old-width bytes can reach the frontend
        AFTER the resize ack — xterm then re-wraps stale-width content and the
        CLI's cursor-up repaints strand corrupt frames in scrollback. Draining
        makes the ack a true ordering barrier: old-width output < ack < any
        new-width output.
        """
        session = self._sessions.get(session_id)
        if not session or session.closed:
            return
        lock = self._resize_barriers.setdefault(session.id, asyncio.Lock())
        try:
            async with lock:
                await self._drain_output_behind_barrier(session)
        finally:
            # Output read while the barrier held was deferred by the lock and
            # its debounce timer may already have fired into nothing.  (A
            # waiting barrier re-acquires on its next turn, so the lock reads
            # free here; the drain this starts is what it will wait on.)
            if not session.closed and not lock.locked() and self._out_buffers.get(session.id):
                self._flush_output(session)

    async def _drain_output_behind_barrier(self, session: TerminalSession) -> None:
        if session.closed:
            return
        # 0. A batched drain already on the wire carries old-width bytes; let
        #    it land first or it would follow the ack.  The barrier flag keeps
        #    its finally (and any debounce timer) from starting another drain
        #    with what queued behind it — that remainder is emitted below, so
        #    this is one await even under a CLI that never stops printing.
        task = self._drain_tasks.get(session.id)
        if task is not None:
            try:
                await asyncio.shield(task)
            except Exception as err:  # noqa: BLE001
                log.warning(
                    "resize barrier: in-flight drain for session %s failed: %s",
                    session.id, err,
                )
            if session.closed:
                self._out_buf_bytes.pop(session.id, None)
                self._out_buffers.pop(session.id, None)
                return
        # 1. Slurp any kernel-buffered bytes the reader hasn't picked up yet.
        #    Raw bytes — the frontend's streaming decoder handles any split
        #    multi-byte character.
        while True:
            try:
                chunk = session.handle.read(4096)
            except (BlockingIOError, OSError):
                break
            if not chunk:
                break
            self._out_buffers.setdefault(session.id, []).append(chunk)
            self._out_buf_bytes[session.id] = (
                self._out_buf_bytes.get(session.id, 0) + len(chunk)
            )
        # Discard any outstanding echo probe rather than let _flush_output
        # attribute this resize drain to the user's last keystroke.
        self._echo_probe.pop(session.id, None)
        # 2. Cancel the pending batch timer; we emit synchronously below.
        handle = self._out_handles.pop(session.id, None)
        if handle:
            handle.cancel()
        # 3. Emit everything buffered, awaiting so it precedes the ack on the wire.
        self._out_buf_bytes.pop(session.id, None)
        chunks = self._out_buffers.pop(session.id, None)
        if not chunks:
            return
        combined = b"".join(chunks)
        for piece in self._split_chunks(combined):
            await self._emit(self._build_output_frame(session, piece))
        self._mirror_flush_to_log(session, combined)

    def interrupt(self, session_id: str) -> None:
        session = self._require(session_id)
        if session.closed:
            return
        try:
            from .cli_vendors.registry import vendor

            spec = vendor(session.agent_key or "")
            seq = spec.interrupt_key if spec is not None and spec.interrupt_key is not None else b"\x03"
            session.handle.write(seq)
        except OSError as err:
            log.warning("interrupt session %s failed: %s", session_id, err)

    async def kill(self, session_id: str, force: bool = False) -> None:
        session = self._sessions.get(session_id)
        if not session or session.closed:
            return

        # A graceful reap already owns this session. Closing a pane kills it and
        # then sends manual_pane.unspawn, whose sweep addresses the same pane —
        # and that sweep reaches kill() only because the grace keeps the session
        # registered (before it, _close had already popped it, so the sweep
        # found nothing). The sweep stays: it is the only signal for a pane the
        # renderer had no ref to kill through, and the net under a kill that
        # failed. Answering here rather than after the snapshot below is the
        # point — that snapshot is a full-system `ps` with a 5s budget, and one
        # per pane close to arrive at the same no-op is pure waste. Never
        # populated for a vendor without a ShutdownSpec.
        if session_id in self._graceful_kills:
            log.debug(
                "terminal kill: graceful already in flight session=%s pane=%s "
                "vendor=%s",
                session.id, session.pane_id, session.agent_key,
            )
            return

        # Snapshot the descendant tree BEFORE close: killpg below only reaches
        # the child's own process group, so a grandchild that called setsid
        # would survive. Capture the tree now — after the child dies its
        # grandchildren reparent to launchd and can no longer be found.
        # Offload the full-system `ps` snapshot (timeout 5s) to a thread so a
        # slow snapshot never blocks the event loop — a batch of kills on
        # workspace switch would otherwise stall unrelated requests (e.g. the
        # Welcome screen's workspace.list_recent) past their 10s timeout.
        descendants = await asyncio.to_thread(_descendant_pids, session.proc.pid)
        # Read the foreground group BEFORE _close() shuts the master fd.
        fg_pgid = session.handle.foreground_group()

        # A vendor that declares a ShutdownSpec gets a SIGTERM-first prefix in
        # front of everything below; every other vendor (13 of 14) falls
        # straight through to the path that has always run here.
        shutdown = self._shutdown_spec(session)
        if shutdown is not None and shutdown.graceful:
            # Re-read the two guards: the descendant snapshot above is a
            # full-system `ps` off the loop, and across it the child can exit
            # on its own (its EOF closes the session and pops it) or another
            # kill can claim the grace. Acting on the pre-await state would
            # start a second grace whose fg_pgid was read from a handle that
            # is now closed — a pgid the kernel may already have recycled to
            # someone else's process group.
            if session.closed or session.id not in self._sessions:
                log.info(
                    "terminal kill: graceful skipped, session already down "
                    "session=%s pane=%s vendor=%s",
                    session.id, session.pane_id, session.agent_key,
                )
                return
            if session.id in self._graceful_kills:
                # The same no-op as the fast path above, reached when a grace
                # started while this call was in the snapshot.
                log.debug(
                    "terminal kill: graceful already in flight session=%s "
                    "pane=%s vendor=%s",
                    session.id, session.pane_id, session.agent_key,
                )
                return
            self._graceful_kills[session.id] = asyncio.Event()
            log.info(
                "terminal kill: path=graceful session=%s pane=%s vendor=%s "
                "signal=SIGTERM grace=%.1fs defer_master_close=%s "
                "force_fallback=%s",
                session.id, session.pane_id, session.agent_key,
                shutdown.grace_s, shutdown.defer_master_close, force,
            )
            # A task, not an await: kill()'s own latency gates pane close and
            # the spawn path's replace-a-stale-terminal step, and holding
            # either open for the grace would be a visible regression.
            task = self._loop.create_task(
                self._kill_gracefully(
                    session, fg_pgid, force, shutdown, descendants
                )
            )
            # kill() has already told its caller the kill is under way, so a
            # task that dies has nobody to raise to: without this the
            # traceback surfaces only as asyncio's "Task exception was never
            # retrieved" at GC time, on stderr rather than in the log. Holding
            # the reference also keeps the loop's weak set from dropping it.
            self._kill_tasks.add(task)
            task.add_done_callback(self._on_graceful_kill_done)
            return

        log.info(
            "terminal kill: path=legacy session=%s pane=%s vendor=%s "
            "signal=%s grace=%.1fs",
            session.id, session.pane_id, session.agent_key,
            "SIGKILL" if force else "SIGTERM", _KILL_ESCALATION_GRACE_S,
        )
        try:
            pgid = osplat.process_tree.group_of(session.proc.pid)
            osplat.process_tree.kill_group(pgid, force=force)
        except ProcessLookupError:
            # Group already gone — closing the PTY master HUPs the child, so
            # it often dies before the SIGTERM lands. The escalation task
            # still runs to reap it and drop its crash-recovery record.
            pgid = 0
        if fg_pgid > 0 and fg_pgid != pgid:
            # The PTY child is a login shell, and with job control live it puts
            # the CLI in a group of its own — the shell's group no longer
            # covers it. Signal the foreground group too, or the CLI would
            # first hear about this as the SIGHUP from the close below and lose
            # the chance to flush the transcript that resume depends on.
            try:
                osplat.process_tree.kill_group(fg_pgid, force=force)
            except (ProcessLookupError, PermissionError):
                pass

        self._close(session, reason="killed")

        # A CLI that traps SIGTERM would survive the close and, being gone
        # from _sessions, escape the shutdown sweep — escalate to SIGKILL
        # after a grace period and only then drop its crash-recovery record.
        self._loop.create_task(
            self._escalate_kill(
                session, pgid, _KILL_ESCALATION_GRACE_S, descendants=descendants
            )
        )

    async def wait_until_reaped(
        self, session_id: str, timeout: float | None = None
    ) -> bool:
        """Block until a graceful kill of ``session_id`` has put the child down.

        kill() returns before the grace is over so that closing a pane stays
        instant, but a caller that spawns a replacement — terminal.create's
        replaces_terminal_id reap and its resume-id dedup — needs the old CLI
        gone first, or two of them briefly append to one session file. Those
        callers await this; nobody else has to, and the direct kill path is
        still synchronous, so every other caller and every vendor without a
        ShutdownSpec is unaffected.

        Returns True when there is nothing in flight (the common case, and an
        immediate return) or the reap finished, False when the wait ran out.
        False means the child outlived a SIGKILL — the ceiling covers every
        other bounded step (see _reap_wait_timeout_s), so a caller that must
        not spawn over a live CLI can treat it as one rather than as noise.
        """
        done = self._graceful_kills.get(session_id)
        if done is None:
            return True
        if timeout is None:
            timeout = _reap_wait_timeout_s()
        try:
            await asyncio.wait_for(done.wait(), timeout)
        except TimeoutError:
            log.warning(
                "terminal kill: reap wait timed out session=%s timeout=%.1fs "
                "— the child survived the escalation and may still be alive",
                session_id, timeout,
            )
            return False
        return True

    def _on_graceful_kill_done(self, task: "asyncio.Task[None]") -> None:
        """Log what a graceful-kill task raised, and let go of it."""
        self._kill_tasks.discard(task)
        if task.cancelled():
            return
        err = task.exception()
        if err is not None:
            log.error("terminal kill: graceful task failed: %r", err, exc_info=err)

    def _shutdown_spec(self, session: TerminalSession) -> "Any | None":
        """This session's vendor ShutdownSpec, or None — for an unknown key,
        a plain terminal, or a vendor that declares no shutdown behavior."""
        from .cli_vendors.registry import vendor

        spec = vendor(session.agent_key or "")
        return spec.shutdown if spec is not None else None

    async def _kill_gracefully(
        self,
        session: TerminalSession,
        fg_pgid: int,
        force: bool,
        shutdown: Any,
        descendants: dict[int, str],
    ) -> None:
        """SIGTERM first, then the same close-and-escalate the direct path runs.

        claude rewrites ~/.claude.json from a SIGTERM handler; a SIGKILL skips
        it and leaves a stale fullscreenBootPending entry, and two of those
        make claude disable its own fullscreen TUI. So the signal order is
        inverted for vendors that ask, and with defer_master_close the PTY
        master stays open across the grace — closing it HUPs the child and
        takes the far end of its stdout away mid-hook.
        """
        started = self._loop.time()
        done = self._graceful_kills.get(session.id)
        # Everything below is inside the try: this task owns the only entry in
        # _graceful_kills for this session, and kill() short-circuits on that
        # entry. An exception escaping before the finally would leave it there
        # forever — the session never closed, the child never killable again,
        # and every reap site burning its full ceiling to learn nothing.
        try:
            try:
                pgid = osplat.process_tree.group_of(session.proc.pid)
            except (ProcessLookupError, PermissionError):
                # Already gone, or not ours to ask about; the close and
                # escalation below still run so the session is unregistered
                # and its crash-recovery record dropped.
                pgid = 0
            session.pending_close_reason = "killed"
            # Job control puts the CLI in a group the login shell's pgid does
            # not cover. Same guard as the direct path.
            for target in (pgid, fg_pgid if fg_pgid != pgid else 0):
                if target <= 0:
                    continue
                try:
                    osplat.process_tree.kill_group(target, force=False)
                except (ProcessLookupError, PermissionError):
                    pass
            if not shutdown.defer_master_close:
                self._close(session, reason="killed")
            deadline = self._loop.time() + shutdown.grace_s
            # ASYNC110 suppressed: bounded poll (<= grace_s) with awaited
            # sleeps, as in _escalate_kill.
            while (  # noqa: ASYNC110
                session.proc.poll() is None and self._loop.time() < deadline
            ):
                await asyncio.sleep(0.05)
            waited_ms = int((self._loop.time() - started) * 1000)
            timed_out = session.proc.poll() is None
            log.info(
                "terminal kill: graceful grace ended session=%s pane=%s "
                "vendor=%s exited=%s after=%dms grace=%.1fs timed_out=%s",
                session.id, session.pane_id, session.agent_key,
                not timed_out, waited_ms, shutdown.grace_s, timed_out,
            )
            if timed_out:
                # Still there — hand it back to the caller's own force choice,
                # exactly as the direct path would have signalled it.
                for target in (pgid, fg_pgid if fg_pgid != pgid else 0):
                    if target <= 0:
                        continue
                    try:
                        osplat.process_tree.kill_group(target, force=force)
                    except (ProcessLookupError, PermissionError):
                        pass
            self._close(session, reason="killed")
            await self._escalate_kill(
                session, pgid, _KILL_ESCALATION_GRACE_S,
                descendants=descendants, reaped=done,
            )
        finally:
            # Also the failure release: _escalate_kill sets the event the
            # moment the child is confirmed down, and this catches every path
            # that never got there. Event.set() twice is a no-op.
            stale = self._graceful_kills.pop(session.id, None)
            if stale is not None:
                stale.set()

    async def _put_down_error_survivor(self, session: TerminalSession) -> None:
        """Kill a child whose PTY master died on a read error while the child
        itself is still alive. The session is already closed and popped from
        _sessions at this point, so without this the child would escape both
        terminal.kill and the shutdown sweep until the next backend start's
        reap_stale — yet nobody can ever interact with it again (its tty is
        gone). Mirrors kill(): snapshot descendants while the child is alive,
        then TERM the group and escalate."""
        descendants = await asyncio.to_thread(_descendant_pids, session.proc.pid)
        try:
            pgid = osplat.process_tree.group_of(session.proc.pid)
            osplat.process_tree.kill_group(pgid, force=False)
        except (ProcessLookupError, PermissionError):
            pgid = 0
        await self._escalate_kill(session, pgid, descendants=descendants)

    async def _escalate_kill(
        self,
        session: TerminalSession,
        pgid: int,
        grace: float = 1.0,
        descendants: dict[int, str] | None = None,
        reaped: asyncio.Event | None = None,
    ) -> None:
        deadline = self._loop.time() + grace
        # ASYNC110 suppressed: bounded poll (<= grace) with awaited sleeps —
        # the loop is never blocked, and there is no event source for
        # child-exit here.
        while session.proc.poll() is None and self._loop.time() < deadline:  # noqa: ASYNC110
            await asyncio.sleep(0.05)
        escalated = session.proc.poll() is None and pgid > 0
        log.info(
            "terminal kill: escalation session=%s pane=%s vendor=%s "
            "waited=%dms grace=%.1fs escalated_sigkill=%s",
            session.id, session.pane_id, session.agent_key,
            int((self._loop.time() - (deadline - grace)) * 1000), grace,
            escalated,
        )
        if escalated:
            try:
                osplat.process_tree.kill_group(pgid, force=True)
            except (ProcessLookupError, PermissionError):
                pass
            try:
                # Reap the zombie so poll() flips before we unregister.
                await self._loop.run_in_executor(
                    _LIFECYCLE_EXECUTOR, session.proc.wait, 1.0
                )
            except subprocess.TimeoutExpired:
                pass
        # This child is now as down as this path can make it, which is the
        # whole of what wait_until_reaped() promises. Release its waiters here
        # rather than after the sweep below: that sweep is about OTHER
        # processes (grandchildren that left the group), it is a full-system
        # `ps` with a 5s budget, and holding the reap across it made the
        # ceiling smaller than the work under it.
        if reaped is not None:
            reaped.set()
        # Reap breakaway grandchildren that escaped the process group via setsid.
        await asyncio.to_thread(_kill_breakaway, descendants or {})
        if session.proc.poll() is not None:
            await self._submit_lifecycle(
                in_data_dir(self._data_dir, pty_registry.unregister, session.proc.pid),
            )

    async def _snapshot_loop(self) -> None:
        """Keep every live session's descendant snapshot fresh. kill()
        snapshots on demand because the child is still alive then; the EOF
        path cannot — by the time the PTY master reports EIO the child is
        dead and its grandchildren have reparented, so the tree must have
        been captured beforehand. Self-terminating: returns when no live
        session remains (create() restarts it). Ticks fast while any session
        is young, at the normal interval otherwise; create() can also pull
        the next tick forward via the wakeup event."""
        while True:
            live = [s for s in self._sessions.values() if not s.closed]
            if not live:
                return
            try:
                snap = await asyncio.to_thread(_ps_snapshot)
                payload = self._refresh_descendants(snap)
                # Persist into the crash-recovery registry so a backend that
                # dies without its shutdown sweep leaves the next start's
                # reap_stale enough to take detached grandchildren down too.
                # Skipped entirely when nothing changed since the last write
                # (steady state) — no lock, no file read.
                if payload and payload != self._last_persisted:
                    await _to_thread_and_drain_on_cancel(
                        in_data_dir(self._data_dir, pty_registry.update_descendants, payload)
                    )
                    self._last_persisted = payload
            except Exception as err:  # noqa: BLE001 — the loop must survive
                log.warning("descendant snapshot failed: %s", err)
            youngest = min(time.monotonic() - s.started_monotonic for s in live)
            interval = (
                _DESCENDANT_SNAPSHOT_FAST_S
                if youngest < _DESCENDANT_SNAPSHOT_INTERVAL_S
                else _DESCENDANT_SNAPSHOT_INTERVAL_S
            )
            self._snapshot_wakeup.clear()
            try:
                await asyncio.wait_for(self._snapshot_wakeup.wait(), timeout=interval)
            except TimeoutError:
                pass

    def _refresh_descendants(
        self, snap: dict[int, tuple[int, int, str]]
    ) -> dict[int, dict[int, str]]:
        """Update every live session's in-memory descendant snapshot and
        return the registry-worthy view: only descendants that escaped the
        root's process group can outlive its killpg, so persisting same-group
        churn (transient git/rg children) would rewrite the registry every
        tick for nothing. A live session with no detached descendants is
        still included (empty dict) so a stale registry record gets cleared."""
        if not snap:
            return {}  # ps failed — keep the last good snapshots
        children = _children_map(snap)
        persist: dict[int, dict[int, str]] = {}
        for session in self._sessions.values():
            if session.closed:
                continue
            if session.proc.pid not in snap:
                # Child already gone from the table (its death racing the EOF
                # callback) — keep the last snapshot; _close still needs it.
                continue
            pids = _walk_descendants(children, session.proc.pid)
            session.descendants = {pid: snap[pid][2] for pid in pids}
            persist[session.proc.pid] = {
                pid: snap[pid][2]
                for pid in pids
                if snap[pid][1] != session.proc.pid
            }
        return persist

    async def _reap_pending_orphans(self) -> None:
        """Batch sweeper for _pending_reaps: sessions that died around the
        same time share one grace window and one ps snapshot — a mass die-off
        (e.g. an OOM sweep killing dozens of CLIs in the same second) would
        otherwise fork one full-table ps per session at once. The queue is
        drained BEFORE the grace sleep so every dead session gets at least
        the full grace (a death landing during the sleep or sweep waits for
        the next round). Exception-guarded — a failed sweep must not strand
        queued entries; self-terminating when the queue drains (_close
        restarts it on the next death)."""
        while self._pending_reaps:
            batch, self._pending_reaps = self._pending_reaps, {}
            await asyncio.sleep(_EXIT_ORPHAN_GRACE_S)
            try:
                await self._reap_exit_orphans(batch)
            except Exception as err:  # noqa: BLE001 — the sweeper must survive
                log.warning("exit-orphan sweep failed: %s", err)

    async def _reap_exit_orphans(self, descendants: dict[int, str]) -> None:
        """After a PTY child died on its own (EOF/error path — no kill() ran)
        and the sweeper's grace elapsed, sweep its last descendant snapshot.
        A pid is killed only when it is (a) now orphaned — reparented to
        launchd (ppid 1) or to this backend (observed macOS behavior) — and
        (b) still the same process, verified by comparing its ps lstart
        against the one recorded at snapshot time (defeats pid recycling;
        an empty lstart on either side is no match — never kill unverified).
        A verified orphan's current subtree is killed with it (a leaked
        `npm exec` wrapper still parents its own node child at sweep time)."""
        snap = await asyncio.to_thread(_ps_snapshot)
        if not snap:
            return  # ps failed — cannot verify identities, do not kill blind
        children = _children_map(snap)
        me = os.getpid()
        targets: dict[int, str] = {}
        for pid, recorded_lstart in descendants.items():
            entry = snap.get(pid)
            if entry is None:
                continue
            ppid, _pgid, lstart = entry
            if not osplat.process_tree.is_orphan_parent(ppid, me):
                continue  # still parented by a live process — not our orphan
            if not _same_process(recorded_lstart, lstart):
                continue  # recycled since the snapshot, or unverifiable — not ours
            targets[pid] = lstart
            for child in _walk_descendants(children, pid):
                targets[child] = snap[child][2]
        if targets:
            log.info("reaping %d orphaned descendant(s): %s", len(targets), list(targets))
            await asyncio.to_thread(_kill_breakaway, targets)

    async def kill_all(self, grace: float = 1.0) -> None:
        """Terminate every live PTY child. Children run with
        start_new_session=True (own process group), so killing the backend
        never propagates to them — without this explicit sweep on shutdown
        they outlive the app as orphans."""
        if self._snapshot_task is not None:
            snapshot_task = self._snapshot_task
            snapshot_task.cancel()
            await asyncio.gather(snapshot_task, return_exceptions=True)
            if self._snapshot_task is snapshot_task:
                self._snapshot_task = None
        targets: list[tuple[TerminalSession, int]] = []
        breakaway: dict[int, str] = {}
        # One shared ps snapshot for every session's descendant sweep. The
        # previous per-session snapshot (a full `ps -Ao` each, 5s budget)
        # pushed a many-pane shutdown past Electron's SIGKILL deadline, so
        # the sweep never got to the actual kills. Off the loop via to_thread.
        snap = await asyncio.to_thread(_ps_snapshot)
        children = _children_map(snap)
        for session in list(self._sessions.values()):
            if session.closed:
                continue
            # Snapshot descendants while the child is still alive (see kill()).
            for pid in _walk_descendants(children, session.proc.pid):
                breakaway[pid] = snap[pid][2]
            try:
                targets.append((session, osplat.process_tree.group_of(session.proc.pid)))
            except ProcessLookupError:
                # Child already gone — still close so the session is removed
                # and its registry entry is dropped.
                self._close(session, reason="shutdown")
        for session, pgid in targets:
            session.pending_close_reason = "shutdown"
            try:
                osplat.process_tree.kill_group(pgid, force=False)
            except (ProcessLookupError, PermissionError):
                pass
            # Job control puts the CLI in its own group; the shell's pgid does
            # not reach it. See the same guard in kill().
            fg_pgid = session.handle.foreground_group()
            if fg_pgid > 0 and fg_pgid != pgid:
                try:
                    osplat.process_tree.kill_group(fg_pgid, force=False)
                except (ProcessLookupError, PermissionError):
                    pass
        # A vendor that declared a grace asked for it because its SIGTERM
        # handler needs that long to finish — and quitting the app is when
        # every one of its panes runs that handler at once, against the same
        # file. Honouring only kill()'s grace here left the exact stale-state
        # bug the ShutdownSpec exists to prevent alive on the quit path.
        # The poll below waits on all targets together, so widening this costs
        # the LARGEST declared grace once, not one per pane.
        effective = grace
        for session, _pgid in targets:
            spec = self._shutdown_spec(session)
            if spec is not None and spec.graceful:
                effective = max(effective, spec.grace_s)
        if effective != grace:
            log.info(
                "terminal kill_all: grace widened %.1fs -> %.1fs for %d "
                "session(s) with a declared shutdown",
                grace, effective, len(targets),
            )
        deadline = self._loop.time() + effective
        # ASYNC110 suppressed: bounded poll with awaited sleeps, as above.
        while (  # noqa: ASYNC110
            any(s.proc.poll() is None for s, _ in targets)
            and self._loop.time() < deadline
        ):
            await asyncio.sleep(0.05)
        for session, pgid in targets:
            if session.proc.poll() is None:
                try:
                    osplat.process_tree.kill_group(pgid, force=True)
                except (ProcessLookupError, PermissionError):
                    pass
                try:
                    # Reap immediately (SIGKILL is not trappable) so _close's
                    # death-confirmed unregister drops the registry entry.
                    session.proc.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    pass
            self._close(session, reason="shutdown")
        # An EOF close still waiting for its child may yet queue a sweep and a
        # registry write; let it settle first. Unfinished tasks only (see
        # _drain_lifecycle).
        if settling := [t for t in self._exit_settles if not t.done()]:
            await asyncio.gather(*settling, return_exceptions=True)
        # Let the in-flight exit-orphan sweep finish: a CLI that EOF'd moments
        # before shutdown would otherwise leak its orphans when the loop
        # closes mid-grace.
        if self._reap_task is not None and not self._reap_task.done():
            await asyncio.gather(self._reap_task, return_exceptions=True)
        # Reap breakaway grandchildren that escaped every process group.
        await asyncio.to_thread(_kill_breakaway, breakaway)
        # _close() schedules registry writes in the lifecycle executor. The
        # app closes the shared database immediately after this sweep, so let
        # those writes finish first.
        await self._drain_lifecycle()

    def _require(self, session_id: str) -> TerminalSession:
        session = self._sessions.get(session_id)
        if not session:
            raise KeyError(f"unknown terminal session: {session_id}")
        return session

    def _resolve_command(self, command: str | list[str]) -> list[str]:
        if isinstance(command, list):
            argv = list(command)
        else:
            argv = osplat.terminal_backend.parse_command(command)
        if not argv:
            raise ValueError("command is empty")
        return argv

    def _on_readable(self, session: TerminalSession) -> None:
        if session.closed:
            return
        # Drain until the PTY would block, rather than taking one read per
        # callback — see _READ_DRAIN_MAX_BYTES for why that mattered on macOS.
        raw: list[bytes] = []
        nbytes = 0
        close_reason: str | None = None
        while nbytes < _READ_DRAIN_MAX_BYTES:
            try:
                chunk = session.handle.read(_READ_CHUNK_BYTES)
            except BlockingIOError:
                break
            except OSError as err:
                if err.errno in (errno.EIO,):
                    # PTY closed (child exited and tty was released)
                    close_reason = "exit"
                else:
                    log.warning("read session %s failed: %s", session.id, err)
                    close_reason = "error"
                break
            if not chunk:
                close_reason = "exit"
                break
            raw.append(chunk)
            nbytes += len(chunk)

        # Whatever arrived before EOF still has to reach the client, and _close
        # flushes the output buffer — so absorb first, then close.
        if raw:
            self._absorb_output(session, b"".join(raw), nbytes)
        if close_reason is not None:
            pending = getattr(session, "pending_close_reason", None)
            if close_reason == "exit" and pending:
                close_reason = pending
            self._close(session, reason=close_reason)

    def _absorb_output(
        self, session: TerminalSession, chunk: bytes, nbytes: int
    ) -> None:
        """Buffer one drained batch of raw bytes and schedule (or force) a
        flush. No decoding here — bytes ship verbatim in binary frames and the
        frontend's streaming decoder handles chunk-split multi-byte chars."""
        buf = self._out_buffers.setdefault(session.id, [])
        buf.append(chunk)
        window = self._recent_chunks.setdefault(session.id, deque(maxlen=512))
        now = self._loop.time()
        window.append((now, nbytes))
        buf_size = self._out_buf_bytes.get(session.id, 0) + len(chunk)
        self._out_buf_bytes[session.id] = buf_size
        barrier = self._resize_barriers.get(session.id)
        if buf_size >= _BUF_CAP and (
            session.id in self._drain_tasks or (barrier is not None and barrier.locked())
        ):
            # A drain (or a resize barrier's inline emit) is already stalled
            # on the WS and the reader was resumed so the CLI keeps running
            # (see _READER_PAUSE_MAX_MS) — a flush would only defer, so the
            # only place left for the pressure is our own buffer.  Drop the
            # oldest chunks: the newest carry the TUI's current screen state.
            dropped = 0
            while buf_size >= _BUF_CAP and len(buf) > 1:
                old = buf.pop(0)
                buf_size -= len(old)
                dropped += len(old)
            self._out_buf_bytes[session.id] = buf_size
            if session.id not in self._out_dropped:
                log.warning(
                    "pty output dropped session=%s agent=%s bytes=%d (ws not draining)",
                    session.id, session.agent_key, dropped,
                )
            self._out_dropped[session.id] = self._out_dropped.get(session.id, 0) + dropped
        elif buf_size >= _BUF_CAP:
            # Cancel the pending debounce timer and flush now to avoid OOM.
            existing = self._out_handles.pop(session.id, None)
            if existing:
                existing.cancel()
            self._flush_output(session)
        elif session.id not in self._out_handles:
            handle = self._loop.call_later(
                self._flush_delay(session.id, now=now),
                self._flush_output,
                session,
            )
            self._out_handles[session.id] = handle

    def _window_bytes(self, session_id: str, *, now: float | None = None) -> int:
        """Bytes read from this PTY within the last _FAST_PATH_WINDOW_S,
        dropping entries that fell out of the window.  `now` lets the caller
        reuse a loop time it already took instead of paying a second call."""
        window = self._recent_chunks.get(session_id)
        if not window:
            return 0
        if now is None:
            now = self._loop.time()
        cutoff = now - _FAST_PATH_WINDOW_S
        while window and window[0][0] < cutoff:
            window.popleft()
        return sum(nbytes for _, nbytes in window)

    def _flush_delay(self, session_id: str, *, now: float | None = None) -> float:
        """Batch delay for the next flush: _COALESCE_MS while the output rate
        looks interactive, _OUTPUT_BATCH_MS once it looks like a stream."""
        if self._window_bytes(session_id, now=now) > _FAST_PATH_MAX_BYTES:
            return _OUTPUT_BATCH_MS / 1000
        return _COALESCE_MS / 1000

    def _flush_output(self, session: TerminalSession) -> None:
        """Send all buffered output for this session as a single WS message.

        If the combined payload exceeds _MAX_WS_PAYLOAD_BYTES we split it into
        chunks so the Electron Network service is never given a single massive
        frame (large frames have been observed to trigger the crash).
        """
        self._out_handles.pop(session.id, None)
        barrier = self._resize_barriers.get(session.id)
        if session.id in self._drain_tasks or (barrier is not None and barrier.locked()):
            # One drain on the wire per session: whatever is buffered now is
            # picked up by that task when it finishes (see _drain's finally) —
            # or by the resize barrier, which emits the remainder itself.
            return
        self._out_buf_bytes.pop(session.id, None)
        chunks = self._out_buffers.pop(session.id, None)
        if not chunks:
            self._out_dropped.pop(session.id, None)
            return
        combined = b"".join(chunks)

        # Echo probe: this flush is the first output since the user's keystroke,
        # so the gap between them is the backend's share of the round-trip.
        started = self._echo_probe.pop(session.id, None)
        if started is not None:
            lag_ms = (self._loop.time() - started) * 1000
            if _ECHO_LAG_WARN_MS <= lag_ms < _ECHO_LAG_MAX_MS:
                log.warning(
                    "input echo lag session=%s agent=%s lag=%.0fms bytes=%d",
                    session.id, session.agent_key, lag_ms, len(combined),
                )

        # Suspend reading from the PTY while we drain the network buffer.
        # This provides natural backpressure so the CLI blocks when writing
        # instead of OOMing the Python backend or Electron WebSocket receiver.
        # The hold is bounded (_READER_PAUSE_MAX_MS): a CLI blocked on its
        # stdout stops reading its stdin, so past that the reader resumes and
        # _absorb_output's drop policy takes over as the OOM guard.
        session.handle.pause_reading()

        suspended_at = self._loop.time()
        resumed_at: float | None = None

        def _resume_reader() -> None:
            nonlocal resumed_at
            if resumed_at is not None or session.closed:
                return
            resumed_at = self._loop.time()
            try:
                session.handle.resume_reading()
            except (ValueError, OSError) as err:
                log.warning("re-add reader for session %s failed: %s", session.id, err)

        def _resume_early() -> None:
            self._pause_timers.pop(session.id, None)
            _resume_reader()

        self._pause_timers[session.id] = self._loop.call_later(
            _READER_PAUSE_MAX_MS / 1000, _resume_early
        )

        async def _drain() -> None:
            try:
                for piece in self._split_chunks(combined):
                    await self._emit(self._build_output_frame(session, piece))
            finally:
                timer = self._pause_timers.pop(session.id, None)
                if timer is not None:
                    timer.cancel()
                # Nothing is read from the PTY for this whole span, so a long
                # one is the backpressure path reaching the CLI.
                held_until = resumed_at if resumed_at is not None else self._loop.time()
                held_ms = (held_until - suspended_at) * 1000
                if held_ms >= _READER_SUSPEND_WARN_MS:
                    log.warning(
                        "pty reader suspended session=%s agent=%s held=%.0fms bytes=%d",
                        session.id, session.agent_key, held_ms, len(combined),
                    )
                _resume_reader()
                self._drain_tasks.pop(session.id, None)
                if session.closed:
                    # _close ran mid-drain: the fd is gone (its number may
                    # already be reused), so no further pause/resume — drop
                    # whatever was deferred to us.
                    self._out_buffers.pop(session.id, None)
                    self._out_buf_bytes.pop(session.id, None)
                    self._out_dropped.pop(session.id, None)
                    return
                # Output that arrived while this drain was on the wire is
                # still buffered (flushes defer to the in-flight drain).  Under
                # a resize barrier _flush_output defers again and drain_output
                # emits the remainder itself.
                if self._out_buffers.get(session.id):
                    pending = self._out_handles.pop(session.id, None)
                    if pending:
                        pending.cancel()
                    self._flush_output(session)
                else:
                    # Fully drained: the next overflow is a new episode.
                    self._out_dropped.pop(session.id, None)

        self._drain_tasks[session.id] = self._loop.create_task(_drain())

        # Persist cleaned output to the conversation log (if one was opened).
        self._mirror_flush_to_log(session, combined)

    def _mirror_flush_to_log(self, session: TerminalSession, combined: bytes) -> None:
        """Mirror one flushed payload into the log, marking any gap first.

        Chunks dropped under a stalled drain never reach the log, so the gap
        is marked ahead of the survivors (the count is final: drops only
        happen while a drain is in flight, and a flush runs after it
        finished).  The marker stays out of the live PTY stream the renderer
        sees.
        """
        dropped = self._out_dropped.get(session.id)
        if dropped:
            self._out_dropped[session.id] = 0
            self._mirror_to_log(
                session, f"\r\n[navide: {dropped} bytes of output dropped]\r\n".encode()
            )
        self._mirror_to_log(session, combined)

    def _mirror_to_log(self, session: TerminalSession, data: bytes) -> None:
        """Decode a copy of the raw output and append it to output_log_fp.

        Only sessions with an open log (pipeline panes) pay for decoding; the
        per-session incremental decoder keeps chunk-split multi-byte chars from
        becoming U+FFFD in the log.
        """
        if not session.output_log_fp:
            return
        decoder = self._decoders.get(session.id)
        if decoder is None:
            decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
            self._decoders[session.id] = decoder
        try:
            session.output_log_fp.write(_clean_for_log(decoder.decode(data)))
        except Exception as err:  # noqa: BLE001
            log.warning("output log write failed: %s", err)

    @staticmethod
    def _split_chunks(combined: bytes) -> list[bytes]:
        """Split a payload into <=64 KB pieces.

        Caps individual WS messages well below the point where the Electron
        Network service becomes overwhelmed. Any byte boundary is safe: the
        frontend reassembles UTF-8 with a streaming decoder.
        """
        _MAX_BYTES = 64 * 1024
        if len(combined) <= _MAX_BYTES:
            return [combined]
        return [
            combined[pos : pos + _MAX_BYTES]
            for pos in range(0, len(combined), _MAX_BYTES)
        ]

    def _build_output_frame(self, session: TerminalSession, data: bytes) -> bytes:
        """Build one binary terminal-output WS frame (layout at module top)."""
        session.sequence += 1
        sid = session.id.encode("utf-8")
        pane = (session.pane_id or "").encode("utf-8")
        return b"".join(
            (
                bytes((_OUTPUT_FRAME_TYPE,)),
                (session.sequence & 0xFFFFFFFF).to_bytes(4, "little"),
                bytes((len(sid),)),
                sid,
                bytes((len(pane),)),
                pane,
                data,
            )
        )

    def _close(self, session: TerminalSession, *, reason: str) -> None:
        if session.closed:
            return
        session.closed = True
        session.handle.stop_reading()
        # Stop any pending input drain and discard unwritten bytes before the
        # fd is closed (remove_writer needs a still-valid fd).
        self._unwatch_writable(session)
        self._in_buffers.pop(session.id, None)
        self._recent_chunks.pop(session.id, None)
        self._echo_probe.pop(session.id, None)
        # An open blocked episode ends here; the window still gets its release
        # event (with what the PTY had accepted so far) if it was told about
        # the block.
        self._end_input_block(session)
        session.handle.close()
        # Cancel pending batch timer and flush any buffered output before the
        # exit event so the client sees all output in order.
        handle = self._out_handles.pop(session.id, None)
        if handle:
            handle.cancel()
        timer = self._pause_timers.pop(session.id, None)
        if timer:
            timer.cancel()
        self._resize_barriers.pop(session.id, None)
        self._flush_output(session)
        # The transport ships raw bytes, so nothing is ever held back there —
        # but the log-mirror decoder may still hold a final chunk that ended
        # mid-character. Flush its tail into the log before the fp closes.
        decoder = self._decoders.pop(session.id, None)
        if decoder and session.output_log_fp:
            tail = decoder.decode(b"", final=True)
            if tail:
                try:
                    session.output_log_fp.write(_clean_for_log(tail))
                except Exception as err:  # noqa: BLE001
                    log.warning("output log write failed: %s", err)
        # Best-effort wait for child to avoid zombies
        try:
            session.proc.poll()
        except Exception:
            pass
        exit_code = session.proc.returncode
        uptime_ms = max(0, round((time.monotonic() - session.started_monotonic) * 1000))
        exit_signal: str | None = None
        if exit_code is not None and exit_code < 0:
            try:
                exit_signal = signal.Signals(-exit_code).name
            except ValueError:
                exit_signal = f"SIG{-exit_code}"
        session.close_reason = reason
        session.exit_code = exit_code
        session.uptime_ms = uptime_ms
        session.exit_signal = exit_signal
        log.info("terminal session closed id=%s reason=%s exit=%s", session.id, reason, exit_code)
        if session.output_log_fp:
            try:
                session.output_log_fp.close()
            except Exception:  # noqa: BLE001
                pass
            session.output_log_fp = None
        _forget_live_log(session.id)
        event = make_event(
            "terminal.exit",
            {
                "terminal_session_id": session.id,
                "pane_id": session.pane_id,
                "reason": reason,
                "exit_code": exit_code,
                "uptime_ms": uptime_ms,
                "signal": exit_signal,
                "startup_probe": session.metadata.get("startup_probe"),
            },
        )
        self._loop.create_task(self._emit(event))
        self._sessions.pop(session.id, None)
        child_gone = session.proc.poll() is not None
        # Child died on its own (no kill() ran, so no on-demand descendant
        # sweep happened) — queue its snapshot for the batch sweeper. The poll
        # gate skips the error path's still-alive child: its descendants are
        # not orphans, and killing under a live CLI would be wrong.
        if reason in ("exit", "error") and session.descendants and child_gone:
            self._queue_exit_reap(session.descendants)
        # A read error closed the PTY while the child is still alive: it is
        # now unreachable (tty gone, session popped) — put it down, or it
        # escapes both terminal.kill and the shutdown sweep until the next
        # backend start. kill()'s own close passes reason="killed", so this
        # never double-kills.
        if reason == "error" and session.proc.poll() is None:
            self._loop.create_task(self._put_down_error_survivor(session))
        # Drop the crash-recovery record only once the child is confirmed
        # dead: a still-live child (e.g. a TERM-trapping CLI) must stay
        # visible to the next start's reap_stale. kill()'s escalation task
        # and kill_all() unregister the survivors they put down.
        if child_gone:
            self._submit_lifecycle(
                in_data_dir(self._data_dir, pty_registry.unregister, session.proc.pid),
            )
        elif reason == "exit":
            # EOF can arrive before the child is reapable: it has closed its
            # end of the PTY but not finished exiting (seen under load). Both
            # cleanups above need it confirmed dead, so wait for that, bounded.
            task = self._loop.create_task(self._settle_exit(session))
            self._exit_settles.add(task)
            task.add_done_callback(self._exit_settles.discard)

    def _queue_exit_reap(self, descendants: dict[int, str]) -> None:
        self._pending_reaps.update(descendants)
        if self._reap_task is None or self._reap_task.done():
            self._reap_task = self._loop.create_task(self._reap_pending_orphans())

    async def _settle_exit(self, session: TerminalSession) -> None:
        """Finish an EOF close whose child was not yet reapable: once it is
        confirmed dead, queue its descendant sweep and drop its registry
        record. A child still alive after _EXIT_ORPHAN_GRACE_S kept running
        without its PTY; it is left alone (never sweep under a live CLI), and
        its record stays for the next start's reap_stale."""
        deadline = self._loop.time() + _EXIT_ORPHAN_GRACE_S
        # ASYNC110 suppressed: bounded poll with awaited sleeps, as in kill_all.
        while (  # noqa: ASYNC110
            session.proc.poll() is None and self._loop.time() < deadline
        ):
            await asyncio.sleep(0.05)
        if session.proc.poll() is None:
            log.warning(
                "terminal session %s: EOF but pid %s still alive after %.1fs — "
                "orphan sweep and registry cleanup skipped",
                session.id, session.proc.pid, _EXIT_ORPHAN_GRACE_S,
            )
            return
        if session.descendants:
            self._queue_exit_reap(session.descendants)
        self._submit_lifecycle(
            in_data_dir(self._data_dir, pty_registry.unregister, session.proc.pid),
        )
