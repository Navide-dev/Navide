"""File-system watcher that polls registered LogReaders for new token events.

Uses `watchdog` for change notifications, with a periodic full-rescan
fallback (default 30s) to recover from missed events (network mounts,
edge-case file ops). Token readers resume from compact per-file checkpoints
owned by TokensStore; the watcher persists its activity dedup marks into the
same store, under the reserved "@activity" scope, so a restart resumes where
the last one stopped instead of replaying every transcript from line 1.

Architecture:

    LogWatcher.start()
        ├─ observer (watchdog Observer) — async file events → enqueue(path)
        ├─ drain loop (asyncio) — immediate session/activity processing
        ├─ rescan loop (asyncio) — every N s → enqueue changed session files
        └─ token loop (asyncio) — every 300s → parse coalesced paths
                                             → emit TokenUsage to sink

The sink callback runs on the asyncio loop. It MUST be fast (just enqueue
to tokens_store + broadcast); long work blocks the drain.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import replace
from pathlib import Path

from watchdog.events import FileSystemEvent, FileSystemEventHandler

from ..fs_observer import Observer
from .base import (
    ActivityEvent,
    LogReader,
    TokenSinkResult,
    TokenUsage,
    rewind_past_eof_mark,
    seed_pre_start_activity,
)

log = logging.getLogger("agent_team_backend.log_readers.watcher")

# A file's activity dedup set used to hold one short key per line ever parsed
# from it (see LogReader.parse_activity), for the whole process lifetime, so a
# full-corpus scan pinned that memory permanently — and because those keys are
# allocated interleaved with the transient json.loads garbage of the same scan,
# they scatter across every pymalloc arena and stop CPython returning any of
# them (an arena is only ever munmap'd once it is completely empty).
# Measured 2026-08-18 on a zero-pane startup scan of 5209 transcripts:
# 452,693 retained keys, ~47 MB of live strings/sets, holding 481 MB of arenas.
# A file that is gone can never be scanned again, so its set is pure garbage.
# A file that still exists keeps its set however old it looks: resuming an old
# session is a first-class flow here, and a resumed transcript with no dedup
# state replays every historical turn — text, turn_complete and all — at a pane
# that is already registered and attributed. (The durable "@activity"
# checkpoint below would rebuild the mark on the next read, but only after the
# file has already been re-enqueued and re-walked; the in-memory bag is what
# makes the common case free.)
_ACTIVITY_SEEN_SWEEP_S = 600.0

# Reserved checkpoint scope for the activity dedup bag. Real scopes are either
# "" (Global) or an absolute workspace path, so a leading "@" cannot collide —
# and the tokens_store paths that iterate workspace scopes (reset, prune) match
# on a literal workspace path, never on "any scope".
_ACTIVITY_SCOPE = "@activity"
_ACTIVITY_KIND = "activity"
# The bag is stored whole, so it is only stored while it stays small. Most
# readers keep a handful of sentinel keys (a line high-water mark, a cumulative
# total, the last turn's text) and stay far under this; a reader that keeps one
# key per item falls back to the old in-memory-only behaviour rather than
# writing an unbounded blob into the checkpoint row of every transcript.
#
# grok and copilot used to keep per-item keys (act:<session>:<seq> per message
# row; act:<line>, db_act:* per row) and were the two readers this limit shut
# out, so they replayed their history on every start while every other vendor
# stopped. Both now consolidate into a watermark instead (grok on a global
# messages.rowid, copilot on a line high-water mark), so they are covered.
# copilot still leaves activity_resumes_by_line False on purpose — that flag is
# per-READER and this one also serves session-store.db, keyed on db row ids.
# Measured 2026-09-07 over 426 real session files: the covered readers peak at
# 4 keys / 97 bytes, so this limit has roughly a 2x margin for them.
_ACTIVITY_KEYS_PERSIST_LIMIT = 8

# How long a quit will wait for coalesced token paths to settle before giving
# up on them. See drain_pending_tokens: this is on the shutdown critical path.
_SHUTDOWN_FLUSH_TIMEOUT_S = 5.0

# Files the watchdog handler queues without a reader's say-so. .db =
# Antigravity conversations / Grok's grok.db / OpenCode's opencode.db / Kilo's
# kilo.db.
_WATCHED_SUFFIXES = (".jsonl", ".json", ".db")

TokenSink = Callable[[TokenUsage], Awaitable[TokenSinkResult | None]]
ActivitySink = Callable[[ActivityEvent], Awaitable[None]]
SessionSink = Callable[[str, Path], Awaitable[None]]  # (vendor, file_path)
CheckpointProvider = Callable[[str, str | None], dict]
CheckpointSink = Callable[[str, dict, str | None], None]


class _Handler(FileSystemEventHandler):
    """watchdog event handler → push affected paths onto an asyncio queue."""

    def __init__(
        self,
        on_path: Callable[[Path], None],
        accepts_path: Callable[[str], bool] | None = None,
    ) -> None:
        super().__init__()
        self._on_path = on_path
        # Vendor hook (LogReader.accepts_watch_path): paths the generic
        # extension filter below would drop but some reader claims.
        self._accepts_path = accepts_path or (lambda _s: False)

    def on_modified(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        s = str(event.src_path)
        # Antigravity/Grok/OpenCode stores are SQLite: live writes land in the
        # -wal journal first, so accept it but enqueue the canonical .db path.
        if s.endswith(".db-wal"):
            self._on_path(Path(s[: -len("-wal")]))
            return
        # The same for a store a reader claims under another name (OpenClaw's
        # .sqlite): its -wal journal stands for the canonical file.
        if s.endswith("-wal") and self._accepts_path(s[: -len("-wal")]):
            self._on_path(Path(s[: -len("-wal")]))
            return
        if self._accepts_path(s):
            self._on_path(Path(s))
            return
        # .db = Antigravity conversations / Grok's grok.db / OpenCode's
        # opencode.db / Kilo's kilo.db.
        if not s.endswith(_WATCHED_SUFFIXES):
            return
        self._on_path(Path(s))

    def on_created(self, event: FileSystemEvent) -> None:
        self.on_modified(event)


class LogWatcher:
    """Orchestrates one Observer + multiple LogReaders.

    Lifecycle: `start()` spawns the watchdog observer + asyncio worker
    tasks. `stop()` shuts them down cleanly. Safe to call start() twice
    (subsequent calls are no-ops).
    """

    def __init__(
        self,
        sink: TokenSink,
        *,
        activity_sink: ActivitySink | None = None,
        session_sink: SessionSink | None = None,
        rescan_interval_s: float = 30.0,
        token_interval_s: float = 300.0,
        seen_path: Path | None = None,
        save_interval_s: float = 10.0,
        workspace_provider: Callable[[], list[str]] | None = None,
        checkpoint_provider: CheckpointProvider | None = None,
        checkpoint_sink: CheckpointSink | None = None,
        progress_sink: Callable[[str, int], None] | None = None,
    ) -> None:
        self._sink = sink
        # Called on the loop with (workspace_path, remaining_backfill_files) each
        # time a workspace's historic-log backfill starts or advances; 0 = done.
        # Lets the UI show a small "tidying token history" status instead of the
        # backfill silently competing for CPU during startup.
        self._progress_sink = progress_sink
        self._backfill_remaining: dict[str, int] = {}
        # Returns the workspaces the user has actually opened. Periodic/startup
        # backfill is scoped to these so we never re-stat the entire multi-GB
        # CLI history every cycle. None → legacy full scan.
        self._workspace_provider = workspace_provider
        self._activity_sink = activity_sink
        self._session_sink = session_sink
        self._rescan_interval_s = rescan_interval_s
        self._token_interval_s = token_interval_s
        # seen_path/save_interval_s remain accepted for compatibility with
        # third-party callers; token persistence now belongs to the unified
        # checkpoint store supplied below.
        _ = (seen_path, save_interval_s)
        self._local_checkpoints: dict[tuple[str, str], dict] = {}
        self._checkpoint_provider = checkpoint_provider or self._local_checkpoint
        self._checkpoint_sink = checkpoint_sink or self._advance_local_checkpoint
        self._readers: list[LogReader] = []
        # Per-file activity dedup bags, restored from the durable "@activity"
        # checkpoint on first sight and written back as they advance
        # (_restore_activity_seen / _persist_activity_seen). This dict is the
        # hot cache, not the record: a restart with an empty one used to mean
        # every reader walked its transcript from line 1 and broadcast an
        # agent.activity per historical entry — ~148,000 in the first 60s of a
        # cold start (GitHub #28). Bags are dropped once the file is deleted
        # (_sweep_activity_seen); they used to be lifetime-bound, which is how
        # this became the backend's largest retained structure.
        self._activity_seen: dict[str, set[str]] = {}
        self._activity_seen_swept_at: float | None = None
        self._scan_mtimes: dict[str, float] = {}
        # Last seen size per file: a stat is how an append skips the line count.
        self._activity_sizes: dict[str, int] = {}
        self._queue: asyncio.Queue[tuple[Path | None, str]] = asyncio.Queue()
        # Paths waiting in _queue for a realtime walk (see _enqueue_realtime).
        self._realtime_queued: set[Path] = set()
        # Queued paths to walk before the FIFO order (see prioritize), and how
        # many FIFO entries a priority walk has already served per path.
        self._priority: dict[Path, None] = {}
        self._served_early: dict[Path, int] = {}
        self._pending_token_paths: dict[tuple[str, str], Path] = {}
        self._pending_token_backfills: dict[tuple[str, str], int] = {}
        self._token_flush_lock = asyncio.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._observer: Observer | None = None
        self._drain_task: asyncio.Task[None] | None = None
        self._rescan_task: asyncio.Task[None] | None = None
        self._token_task: asyncio.Task[None] | None = None
        self._token_flush_tasks: set[asyncio.Task[None]] = set()
        self._watched_dirs: set[Path] = set()
        self._handler: _Handler | None = None
        self._started = False

    def add_reader(self, reader: LogReader) -> None:
        self._readers.append(reader)

    # ───────────────────────── lifecycle ──────────────────────────────────

    def _local_checkpoint(self, file_path: str, workspace_path: str | None) -> dict:
        return dict(self._local_checkpoints.get((file_path, workspace_path or ""), {}))

    def _advance_local_checkpoint(
        self, file_path: str, checkpoint: dict, workspace_path: str | None
    ) -> None:
        self._local_checkpoints[(file_path, workspace_path or "")] = dict(checkpoint)

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        self._loop = asyncio.get_event_loop()
        self._observer = Observer()

        # Bridge watchdog (synchronous) thread → asyncio queue (main thread).
        def on_path(p: Path) -> None:
            loop = self._loop
            if loop is None or loop.is_closed():
                return
            try:
                loop.call_soon_threadsafe(self._enqueue_realtime, p)
            except RuntimeError:
                # loop closed mid-flight
                pass

        def accepts_path(s: str) -> bool:
            # Live view, not a snapshot — readers may register after start().
            return any(r.accepts_watch_path(s) for r in self._readers)

        handler = _Handler(on_path, accepts_path)
        self._handler = handler

        # Watch every existing watch root from every reader. Skip duplicates.
        # Most readers watch the same dirs they scan; Codex also watches the
        # stable ~/.codex-panes parent because per-pane session dirs appear
        # after the backend has already started. Roots that don't exist yet
        # (fresh install: CLI homes are created on first spawn/login) are
        # re-checked every rescan cycle by _watch_new_dirs.
        self._watch_new_dirs()

        self._observer.start()
        self._drain_task = asyncio.create_task(self._drain_loop(), name="logwatcher.drain")
        self._rescan_task = asyncio.create_task(self._rescan_loop(), name="logwatcher.rescan")
        self._token_task = asyncio.create_task(self._token_loop(), name="logwatcher.tokens")
        log.info(
            "LogWatcher started · %d reader(s) · %d dir(s) · rescan %.0fs · tokens %.0fs",
            len(self._readers), len(self._watched_dirs),
            self._rescan_interval_s, self._token_interval_s,
        )

    def watch_dir(self, directory: Path) -> bool:
        """Subscribe the observer to an extra directory at runtime.

        A managed account's persistent config home appears/becomes relevant
        only when a profile pane spawns — after start() already scheduled the
        static watch roots. Watching the home recursively covers claude's
        <home>/projects, kimi's <home>/sessions and grok's <home>/.grok in one
        subscription; the home dir is checked for existence below so the
        schedule can't fail on a not-yet-created session subdir. Lazy + deduped:
        only homes with a live pane are added, and an already-watched dir is a
        no-op. Returns True when a new subscription was created."""
        if not self._started or self._observer is None or self._handler is None:
            return False
        d = Path(directory)
        if d in self._watched_dirs:
            return False
        try:
            if not d.exists():
                return False
            self._observer.schedule(self._handler, str(d), recursive=True)
            self._watched_dirs.add(d)
            log.info("watching %s (profile config home)", d)
            return True
        except Exception as err:  # noqa: BLE001
            log.warning("schedule watch on %s failed: %s", d, err)
            return False

    def _watch_new_dirs(self) -> None:
        """Subscribe reader watch roots that exist now but didn't earlier.

        On a fresh install none of the CLI homes (~/.codex-panes,
        ~/.codex/sessions, …) exist when start() runs — they are created by
        the first pane spawn or in-pane login. watch_dirs() only returns
        existing dirs, so without a periodic re-check watchdog never observes
        those vendors and delivery degrades to the rescan loop alone (a
        single point of failure). Called from start() and once per rescan
        cycle; already-watched dirs are deduped so steady-state cost is a few
        exists() checks."""
        if self._observer is None or self._handler is None:
            return
        for reader in self._readers:
            for d in reader.watch_dirs():
                if d in self._watched_dirs or not d.exists():
                    continue
                try:
                    self._observer.schedule(self._handler, str(d), recursive=True)
                    self._watched_dirs.add(d)
                    log.info("watching %s for %s logs", d, reader.vendor)
                except Exception as err:  # noqa: BLE001
                    log.warning("schedule watch on %s failed: %s", d, err)

    async def drain_pending_tokens(self) -> None:
        """Settle coalesced token paths before shutdown.

        Token ingestion is deliberately lazy: a path seen by the drain is only
        remembered, and the numbers land on the next _token_interval_s flush.
        stop() then cancels that flush, so on a normal quit everything read
        since the last one was simply dropped and had to be rediscovered by the
        next start's sweep. Now that usage is only counted for what Navide is
        watching, that sweep is no longer a safety net wide enough to find it
        again — a workspace whose pane does not come back is never rescanned —
        so the flush has to happen while we still have it.

        Best-effort by design, and bounded: this now sits in the FastAPI
        shutdown path ahead of the git watcher, server link, MCP teardown and
        the database close, where stop() used to be a synchronous cancel. One
        slow transcript — a network mount, a locked sqlite store, a stalled
        sink — would otherwise hold the whole quit open indefinitely, so the
        wait is capped. Whatever does not settle in time is still recoverable
        from the durable checkpoints the next time that file is seen.
        """
        if not self._started:
            return
        try:
            await asyncio.wait_for(
                self._flush_pending_tokens(), timeout=_SHUTDOWN_FLUSH_TIMEOUT_S
            )
        except TimeoutError:
            log.warning(
                "shutdown token flush timed out after %.0fs; %d path(s) left for the "
                "next start", _SHUTDOWN_FLUSH_TIMEOUT_S, len(self._pending_token_paths)
            )
        except Exception as err:  # noqa: BLE001
            log.warning("shutdown token flush failed: %s", err)

    def stop(self) -> None:
        if not self._started:
            return
        self._started = False
        for t in (
            self._drain_task,
            self._rescan_task,
            self._token_task,
            *self._token_flush_tasks,
        ):
            if t:
                t.cancel()
        if self._observer:
            self._observer.stop()
            try:
                self._observer.join(timeout=2.0)
            except Exception:  # noqa: BLE001
                pass
        log.info("LogWatcher stopped")

    # ───────────────────────── workers ────────────────────────────────────

    def _enqueue_realtime(self, path: Path) -> None:
        """Queue a changed file for its realtime walk (on the loop), once.

        Every append is a watchdog event and every queued entry a walk of the
        whole file, so a busy transcript queued once per line made the serial
        drain fall minutes behind the CLI (turn ends 120-733 s after their
        Stop hook). A walk reads to the end of the file as it is when it runs,
        so the entry already waiting covers later appends.
        """
        if path in self._realtime_queued:
            return
        self._realtime_queued.add(path)
        self._queue.put_nowait((path, ""))

    def prioritize(self, path: Path) -> None:
        """Walk ``path`` next, ahead of the files already queued (on the loop).

        A Stop hook names the transcript whose reply someone is waiting on;
        behind a backed-up FIFO it waited for every other file's walk. Every
        prioritized path also has exactly one FIFO entry (the one already
        waiting, or the one queued here to wake the drain); the priority walk
        makes that entry stale, so the file is still walked once.

        ``path`` comes from a hook payload any local process can post, so it is
        followed only when, symlinks resolved, it is a transcript (a watched
        suffix or one a reader accepts) under a root the watcher already reads,
        and a reader claims it. It is matched to a queued entry by that resolved
        form, so a different spelling of a waiting file does not walk it twice.
        """
        try:
            resolved = path.resolve(strict=True)
        except (OSError, RuntimeError):
            log.debug("hook transcript ignored: %s does not resolve", path)
            return
        under_root = False
        for reader in self._readers:
            try:
                if reader.under_project_dirs(resolved):
                    under_root = True
                    break
            except (OSError, RuntimeError):
                continue
        for root in () if under_root else self._watched_dirs:
            try:
                if resolved.is_relative_to(root.resolve()):
                    under_root = True
                    break
            except (OSError, RuntimeError):
                continue
        name = str(resolved)
        transcript = name.endswith(_WATCHED_SUFFIXES) or any(r.accepts_watch_path(name) for r in self._readers)
        if not (under_root and transcript and resolved.is_file() and self._reader_for(resolved)):
            log.debug("hook transcript ignored: %s is not a watched transcript", path)
            return
        for queued in self._realtime_queued:
            try:
                if queued.resolve() == resolved:
                    resolved = queued
                    break
            except (OSError, RuntimeError):
                continue
        self._enqueue_realtime(resolved)
        self._priority[resolved] = None

    def _queue_token_path(self, path: Path, replay_workspace: str = "") -> None:
        """Coalesce one path for the next token-ingestion pass."""
        try:
            path_key = str(path.resolve())
        except OSError:
            path_key = str(path)
        key = (path_key, replay_workspace)
        self._pending_token_paths[key] = path
        if replay_workspace:
            self._pending_token_backfills[key] = (
                self._pending_token_backfills.get(key, 0) + 1
            )

    async def _drain_loop(self) -> None:
        """Process session/activity immediately and defer only token ingestion."""
        processed = 0
        while True:
            try:
                path, replay_workspace = await self._queue.get()
            except asyncio.CancelledError:
                return
            if path is None:
                task = asyncio.create_task(
                    self._flush_pending_tokens(), name="logwatcher.tokens.flush"
                )
                self._token_flush_tasks.add(task)
                task.add_done_callback(self._token_flush_tasks.discard)
                continue
            while self._priority:
                early = next(iter(self._priority))
                del self._priority[early]
                self._served_early[early] = self._served_early.get(early, 0) + 1
                await self._walk_realtime(early, "")
            if not replay_workspace and self._served_early.get(path):
                # Its priority walk already ran; this FIFO entry is spent.
                self._served_early[path] -= 1
                if not self._served_early[path]:
                    del self._served_early[path]
                continue
            await self._walk_realtime(path, replay_workspace)
            processed += 1
            if processed % 10 == 0:
                await asyncio.sleep(0)

    async def _walk_realtime(self, path: Path, replay_workspace: str) -> None:
        if not replay_workspace:
            # Before the walk: an append that lands during it queues again.
            self._realtime_queued.discard(path)
        try:
            await self._process_realtime_path(path)
        except Exception as err:  # noqa: BLE001
            log.warning("processing realtime signals from %s failed: %s", path, err)
        finally:
            # Token retry/progress is independent of session/activity
            # parsing. Even an unclaimed replay path must reach the token
            # pass so its backfill count can complete.
            self._queue_token_path(path, replay_workspace)

    async def _token_loop(self) -> None:
        """Commit coalesced token paths at most once per configured interval."""
        while True:
            try:
                await asyncio.sleep(self._token_interval_s)
            except asyncio.CancelledError:
                return
            await self._flush_pending_tokens()

    async def _flush_pending_tokens(self) -> None:
        async with self._token_flush_lock:
            pending, self._pending_token_paths = self._pending_token_paths, {}
            backfills, self._pending_token_backfills = self._pending_token_backfills, {}
            for key, path in pending.items():
                replay_workspace = key[1]
                try:
                    handled = await self._process_token_path(path, replay_workspace)
                    if not handled:
                        self._pending_token_paths.setdefault(key, path)
                except Exception as err:  # noqa: BLE001
                    self._pending_token_paths.setdefault(key, path)
                    log.warning("processing tokens from %s failed: %s", path, err)
                finally:
                    if replay_workspace:
                        self._emit_backfill(
                            replay_workspace, -backfills.get(key, 0)
                        )

    def _emit_backfill(self, workspace_path: str, delta: int) -> None:
        """Adjust a workspace's remaining backfill count and notify the UI.

        Must run on the loop thread: force_rescan schedules it via
        call_soon_threadsafe (it runs in an executor); _process_path calls it
        directly. Clamped at 0 so out-of-order deltas never go negative.
        """
        if not workspace_path or self._progress_sink is None:
            return
        remaining = max(0, self._backfill_remaining.get(workspace_path, 0) + delta)
        if remaining:
            self._backfill_remaining[workspace_path] = remaining
        else:
            self._backfill_remaining.pop(workspace_path, None)
        try:
            self._progress_sink(workspace_path, remaining)
        except Exception as err:  # noqa: BLE001
            log.warning("backfill progress sink raised: %s", err)

    def force_rescan(self, workspace_path: str | None = None) -> None:
        """Re-enqueue session files using a workspace-specific checkpoint.

        Used when a new workspace registration means previously-parsed
        session files may now belong to that workspace and need re-counting.
        Global and workspace checkpoints advance independently, so a replay
        can fill missing workspace totals without incrementing Global twice.

        When `workspace_path` is given, only that workspace's files are
        re-enqueued: readers that map a workspace to a specific folder (Claude)
        return just that subset; readers that can't (Codex by-date) fall back
        to all their files — those vendors keep far fewer files so the cost
        stays bounded. This avoids re-parsing the entire
        (multi-GB) Claude history on every new workspace registration, which
        would saturate the event loop and stall the whole backend.

        Without `workspace_path`, every file from every reader is re-enqueued
        (legacy full rescan).
        """
        if self._loop is None or self._loop.is_closed():
            return
        files: list[Path] = []
        for reader in self._readers:
            scoped = (
                reader.session_files_for_workspace(workspace_path)
                if workspace_path
                else None
            )
            files.extend(scoped if scoped is not None else reader.session_files())
        # Announce the backfill size first (runs on the loop, before any per-file
        # decrement) so the UI can show progress. Only workspace-scoped replays
        # count — legacy full rescans (no workspace) don't drive the indicator.
        if workspace_path and files:
            try:
                self._loop.call_soon_threadsafe(
                    self._emit_backfill, workspace_path, len(files)
                )
            except RuntimeError:
                return
        for p in files:
            try:
                self._loop.call_soon_threadsafe(
                    self._queue.put_nowait, (p, workspace_path or "")
                )
            except RuntimeError:
                return
        # Flush sentinel behind the batch. The backfill count only decrements in
        # _flush_pending_tokens, and the periodic token loop is _token_interval_s
        # (5 min) away — without this the "tidying" indicator sticks until then.
        if workspace_path and files:
            try:
                self._loop.call_soon_threadsafe(self._queue.put_nowait, (None, ""))
            except RuntimeError:
                return
        log.info(
            "force_rescan: queued %d file(s) for re-parse%s",
            len(files),
            f" (workspace={workspace_path})" if workspace_path else " (all readers)",
        )

    def _reader_files(
        self,
        reader: LogReader,
        workspace: str | None,
        memo: dict[tuple[int, str | None], list[Path]],
    ) -> list[Path]:
        """One enumeration per (reader, workspace) per sweep.

        Readers that cannot narrow by workspace (Codex files itself by date;
        Grok/Kilo/Muse/OpenCode keep every session in one shared store) return
        None from session_files_for_workspace and fall back to their whole
        list — for every workspace, in every scope. Without this memo the two
        scopes would walk those trees N_workspaces × 2 times per sweep instead
        of once.
        """
        key = (id(reader), workspace)
        cached = memo.get(key)
        if cached is not None:
            return cached
        if workspace is None:
            files = list(reader.session_files())
        else:
            scoped = reader.session_files_for_workspace(workspace)
            files = (
                list(scoped)
                if scoped is not None
                else self._reader_files(reader, None, memo)
            )
        memo[key] = files
        return files

    def _collect_candidates(
        self,
        workspaces: list[str],
        seen: set[str],
        memo: dict[tuple[int, str | None], list[Path]],
    ) -> list[Path]:
        """Enumerate the scope's candidate files, once each.

        `seen` dedupes a file two workspaces both claim; `memo` keeps a reader
        tree walked once per sweep rather than once per workspace naming it."""
        files: list[Path] = []
        # Empty workspace list = legacy unscoped full scan.
        sources = [None] if not workspaces else list(workspaces)
        for reader in self._readers:
            for ws in sources:
                for p in self._reader_files(reader, ws, memo):
                    k = str(p)
                    if k not in seen:
                        seen.add(k)
                        files.append(p)
        return files

    def _candidate_files(self) -> list[Path]:
        """Backfill candidates scoped to opened workspaces (no mtime filter).

        When a workspace_provider is set we only enumerate files belonging to
        the workspaces the user has actually opened (readers that can't map a
        workspace to a subset fall back to their full list — those vendors keep
        far fewer files). No provider / nothing registered yet → full scan
        (legacy).

        Activity and token ingestion share this one list: usage is counted for
        what Navide is watching, and nothing else. A CLI run while Navide was
        closed, or in a workspace with no live pane, is deliberately not
        counted — a product decision, not a limitation. Token ingestion briefly
        carried a second, wider scope of its own; the shutdown flush
        (drain_pending_tokens) is what replaced it.
        """
        provider = self._workspace_provider
        if provider is not None:
            workspaces = list(provider())
            if not workspaces:
                # When a workspace provider is configured but has no open workspaces
                # yet (e.g. startup with empty project list), skip full-disk scans.
                return []
        else:
            workspaces = []
        return self._collect_candidates(workspaces, set(), {})

    def _sweep_activity_seen(self, now: float) -> None:
        """Forget the activity dedup set of every file that no longer exists.

        Runs at most every _ACTIVITY_SEEN_SWEEP_S off the rescan loop; `now`
        is loop-monotonic.

        Only deleted files are forgotten. A file that still exists keeps its
        set no matter how long it has been idle: dropping it does not free a
        session, it arms one. The next append re-enqueues the file, the reader
        starts from line 1 with an empty set, and every historical
        `agent_active` / `turn_complete` — carrying turn text and MSG blocks —
        is broadcast again, this time to a live, attributed pane. The durable
        "@activity" checkpoint now backs the bag up, so the replay is bounded
        by what the store still holds rather than by the file — but it is one
        provider call and a re-walk of the file either way, and the per-file
        sets are bounded by the readers' high-water marks (see
        log_readers.base), so retaining them is cheap.

        The checkpoint row of a deleted file is deliberately left alone here:
        tokens_store prunes an unreadable path after DEAD_ENTRY_DAYS, which
        tolerates a file that is only temporarily missing (an unmounted volume,
        a rename in flight) where an eager delete here would not.
        """
        if (
            self._activity_seen_swept_at is not None
            and now - self._activity_seen_swept_at < _ACTIVITY_SEEN_SWEEP_S
        ):
            return
        dropped = 0
        keys = 0
        for path in list(self._activity_seen):
            if Path(path).exists():
                continue
            keys += len(self._activity_seen.pop(path, ()))
            dropped += 1
            self._scan_mtimes.pop(path, None)
            self._activity_sizes.pop(path, None)
        self._activity_seen_swept_at = now
        if dropped:
            log.info(
                "activity dedup sweep: dropped %d deleted file(s), %d key(s); "
                "%d file(s) still tracked",
                dropped, keys, len(self._activity_seen),
            )

    def _files_to_scan(self) -> list[Path]:
        """Backfill candidates whose mtime changed since the last sweep.

        Workspace scoping (_candidate_files) bounds which files we look at;
        this mtime gate stops us from re-enqueueing unchanged files. Without
        it every 30-second cycle re-reads every workspace session file —
        including 100 MB+ Claude histories — saturating the drain task.

        Takes no arguments and returns a list: test_watcher_offloop_discovery
        replaces this method wholesale with a zero-arg spy to prove discovery
        stays off the event loop.
        """
        return self._changed_since_last_scan(self._candidate_files())

    def _changed_since_last_scan(self, files: list[Path]) -> list[Path]:
        """Drop files whose mtime is unchanged since we last enqueued them.

        _scan_mtimes is shared by both scopes on purpose: a file is worth
        re-reading once per change, whichever scope surfaced it.
        """
        out: list[Path] = []
        for p in files:
            try:
                mtime = p.stat().st_mtime
            except OSError:
                continue
            k = str(p)
            if self._scan_mtimes.get(k) == mtime:
                continue
            self._scan_mtimes[k] = mtime
            out.append(p)
        return out

    async def _rescan_loop(self) -> None:
        """Enqueue changed files immediately at startup, then every rescan."""
        first_scan = True
        delay = 0.0
        while True:
            try:
                await asyncio.sleep(delay)
            except asyncio.CancelledError:
                return
            # The sweep body must never kill this task: it is the only
            # delivery path for vendors watchdog isn't observing, and nothing
            # restarts a dead rescan loop. One reader raising (corrupt store,
            # unexpected file shape) skips this cycle, not all future ones.
            try:
                self._watch_new_dirs()
                # Discovery is disk-bound (vendor tree walks, per-file header
                # reads, one stat per candidate) and must stay off the event
                # loop: on a cold page cache a sweep takes seconds, and the
                # loop freezing that long suspends every PTY reader and WS
                # send. Only the enqueue runs back on the loop. _scan_mtimes
                # stays safe: this coroutine is its only writer, and the
                # sweep below runs strictly after the thread returns.
                for path in await asyncio.to_thread(self._files_to_scan):
                    self._enqueue_realtime(path)
                if self._loop is not None:
                    self._sweep_activity_seen(self._loop.time())
            except Exception as err:  # noqa: BLE001
                log.warning("rescan sweep failed: %s", err)
            if first_scan:
                # The drain processes all startup paths before this marker, so
                # historic token usage catches up immediately and atomically
                # through the existing sink/checkpoint path.
                self._queue.put_nowait((None, ""))
                first_scan = False
            delay = self._rescan_interval_s

    async def _process_path(self, path: Path, replay_workspace: str = "") -> None:
        """Compatibility helper: process every concern immediately."""
        await self._process_realtime_path(path)
        await self._process_token_path(path, replay_workspace)

    async def _process_realtime_path(self, path: Path) -> bool:
        """Capture session identity and activity without token batching delay."""
        reader = self._reader_for(path)
        if reader is None:
            return False
        # Session-id capture for resume (Codex/Antigravity). Runs
        # independent of token parsing so it works even for session-file formats
        # the token reader doesn't (yet) understand — it only needs the file to
        # exist + contain the pane marker.
        if self._session_sink is not None and reader.emits_session_sink:
            try:
                await self._session_sink(reader.vendor, path)
            except Exception as err:  # noqa: BLE001
                log.warning("session sink raised: %s", err)
        key = str(path.resolve())

        # Activity parsing stays realtime even though token accounting is
        # intentionally delayed.
        if self._activity_sink is not None:
            act_seen = self._activity_seen.get(key)
            seeded = False
            if act_seen is None:
                act_seen, seeded = await self._restore_activity_seen(key, path, reader)
                self._activity_seen[key] = act_seen
            if await self._rewind_replaced_file(key, path, reader, act_seen, seeded):
                seeded = True
            before = frozenset(act_seen)
            try:
                activity_events = await asyncio.to_thread(
                    reader.parse_activity, path, act_seen
                )
            except FileNotFoundError:
                return False
            except Exception as err:  # noqa: BLE001
                log.warning("parse_activity %s (%s) failed: %s", path, reader.vendor, err)
                return False
            for aev in activity_events:
                try:
                    await self._activity_sink(aev)
                except Exception as err:  # noqa: BLE001
                    log.warning("activity sink raised: %s", err)
            # After delivery, so the durable mark can never run ahead of what
            # was actually broadcast. `seeded` is its own signal because a seed
            # leaves the bag unchanged across the parse that follows it — the
            # reader finds nothing new and rewrites the same mark.
            if seeded or frozenset(act_seen) != before:
                self._persist_activity_seen(key, act_seen)
        return True

    async def _restore_activity_seen(
        self, key: str, path: Path, reader: LogReader
    ) -> tuple[set[str], bool]:
        """The dedup bag for a file not in the hot cache: (bag, was_seeded).

        Restored from the durable checkpoint when one exists. When none does,
        this is the first time any process has looked at the file, and a
        line-resuming reader gets it seeded to EOF instead of replayed — see
        seed_pre_start_activity for the mtime gate that keeps a live pane's
        fresh transcript out of that path.
        """
        try:
            stored = self._checkpoint_provider(key, _ACTIVITY_SCOPE) or {}
        except Exception as err:  # noqa: BLE001
            log.warning("activity checkpoint provider raised for %s: %s", path, err)
            stored = {}
        if stored.get("kind") == _ACTIVITY_KIND:
            keys = stored.get("keys")
            if isinstance(keys, list):
                return {str(k) for k in keys}, False
            return set(), False
        seen: set[str] = set()
        if not reader.activity_resumes_by_line:
            return seen, False
        # stat + line walk are disk-bound; the drain runs on the loop.
        seeded = await asyncio.to_thread(seed_pre_start_activity, path, seen)
        return seen, seeded

    async def _rewind_replaced_file(
        self, key: str, path: Path, reader: LogReader, act_seen: set[str], seeded: bool
    ) -> bool:
        """True when `act_seen` held a mark from a file that is no longer at `path`.

        Only asks on first sight and when the file shrank, both of which a stat
        answers: an append costs nothing here, however long the transcript. A
        mark seeded a moment ago came from this very file and needs no asking.
        """
        if not reader.activity_resumes_by_line:
            return False
        try:
            size = path.stat().st_size
        except OSError:
            return False
        last_size = self._activity_sizes.get(key)
        self._activity_sizes[key] = size
        if seeded or (last_size is not None and size >= last_size):
            return False
        if not await asyncio.to_thread(rewind_past_eof_mark, path, act_seen):
            return False
        log.info("activity mark of %s was past its end: the file was replaced", path)
        return True

    def _persist_activity_seen(self, key: str, act_seen: set[str]) -> None:
        """Write a file's dedup bag back to the durable checkpoint store.

        Sorted so the serialized row is stable and _checkpoint_is_newer's
        difference test does not fire on set-iteration order alone. An
        over-limit bag is left unwritten rather than truncated: a partial bag
        would read back as a real resume point and silently swallow the lines
        it dropped.
        """
        if len(act_seen) > _ACTIVITY_KEYS_PERSIST_LIMIT:
            return
        try:
            self._checkpoint_sink(
                key,
                {"kind": _ACTIVITY_KIND, "keys": sorted(act_seen)},
                _ACTIVITY_SCOPE,
            )
        except Exception as err:  # noqa: BLE001
            log.warning("activity checkpoint sink raised for %s: %s", key, err)

    async def _process_token_path(
        self, path: Path, replay_workspace: str = ""
    ) -> bool:
        """Parse and commit token usage plus its durable checkpoint."""
        reader = self._reader_for(path)
        if reader is None:
            return True
        key = str(path.resolve())
        checkpoint = self._checkpoint_provider(key, replay_workspace or None)
        try:
            parsed = await asyncio.to_thread(reader.parse_incremental, path, checkpoint)
        except FileNotFoundError:
            return True
        except Exception as err:  # noqa: BLE001
            log.warning("parse %s (%s) failed: %s", path, reader.vendor, err)
            return False
        handled_workspaces: set[str] = set()
        for ev in parsed.events:
            try:
                result = await self._sink(
                    replace(ev, replay_workspace=replay_workspace) if replay_workspace else ev
                )
            except Exception as err:  # noqa: BLE001
                log.warning("token sink raised: %s", err)
                return False
            if isinstance(result, TokenSinkResult):
                if not result.handled:
                    return False
                if result.workspace_path:
                    handled_workspaces.add(result.workspace_path)

        if replay_workspace:
            self._checkpoint_sink(key, parsed.checkpoint, replay_workspace)
            # Yield so a big history backfill doesn't starve startup spawns /
            # live events queued behind it on the loop. Backfill progress is
            # decremented by _flush_pending_tokens after this pass finishes.
            await asyncio.sleep(0)
        else:
            self._checkpoint_sink(key, parsed.checkpoint, None)
            for workspace_path in handled_workspaces:
                self._checkpoint_sink(key, parsed.checkpoint, workspace_path)
        return True

    def _reader_for(self, path: Path) -> LogReader | None:
        try:
            resolved = path.resolve()
        except OSError:
            resolved = path
        for reader in self._readers:
            try:
                if reader.claims_path(resolved):
                    return reader
            except OSError:
                continue
        return None
