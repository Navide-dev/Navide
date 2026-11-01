"""Attribute CLI log-file token events to Agent-Team workspaces + panes.

Design (B — workspace ↔ CLI folder association):

  1. The user registers a workspace by ever telling Agent-Team about its path
     (project.peek / project.upsert / pipeline.start / terminal.create).
     Each workspace records its expected CLI session folders:
       • Claude  → ~/.claude/projects/<encoded-cwd>/ (encode_claude_cwd)
       • Codex   → matched by session_meta.cwd at parse time
  2. When a token-usage event arrives, we look up which registered workspace
     the file belongs to. Events outside any registered workspace are dropped
     by the sink layer (workspace_path=None) so "All time" only tracks usage
     in workspaces the user has actually opened in Agent-Team.
  3. Optional pane attribution: within the current run we still know which
     pane spawned which session (for the "By Pane" panel section). This is
     ephemeral — gone after restart, but the workspace mapping persists.

Side effect of the design:
  - Sessions in a workspace folder that the user opens in Claude Code directly
    (without going through Agent-Team) STILL count toward that workspace.
    This matches what the user wants: usage on the project, by any means.
  - Workspace registration persists to disk so historic sessions count from
    the moment a workspace is first opened, including past .jsonl files.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from threading import Lock
from typing import Callable, Iterable

from ..applog import app_data_dir
from ..db import DB_FILENAME, Database
from .base import LogReader, TokenUsage
from .claude import encode_claude_cwd

log = logging.getLogger("agent_team_backend.log_readers.attribution")

_KV_KEY = "workspace_associations"


@dataclass
class AttributedUsage:
    usage: TokenUsage
    pane_id: str | None       # ephemeral frontend UUID — use for event routing only
    workspace_path: str | None
    stage_id: str | None
    slot_key: str | None = None  # stable "stageId:slotLabel" — use as tokens_store by_pane key
    group_id: str = ""           # sidebar run group ("" = ungrouped) — tokens_store by_group key


@dataclass
class SessionBinding:
    pane_id: str
    resume_id: str
    workspace_path: str
    stage_id: str | None = None
    session_file: str = ""


@dataclass
class WorkspaceMapping:
    workspace_path: str
    claude_dir: str = ""        # ~/.claude/projects/<encoded>/ (or "" if unknown)
    registered_at: float = field(default_factory=time.time)


@dataclass
class _PaneRegistration:
    pane_id: str              # ephemeral frontend UUID (for event routing)
    vendor: str
    cwd: str
    workspace_path: str
    stage_id: str | None
    slot_key: str = ""        # stable "stageId:slotLabel" (for tokens_store by_pane key)
    group_id: str = ""        # sidebar run group ("" = ungrouped); live-updated by set_pane_group
    registered_at: float = field(default_factory=time.time)
    baseline_files: set[Path] = field(default_factory=set)
    # True while the baseline is still being scanned (register_pane with
    # defer_baseline=True). Until scan_pane_baseline fills it in, the pane is
    # not a candidate for the first-come claims that read baseline_files —
    # only the deterministic paths (explicit id, per-pane home, marker) bind.
    baseline_pending: bool = False
    claimed_session_ids: set[str] = field(default_factory=set)
    session_home_id: str = ""
    # Codex/Antigravity only: unique string embedded in this pane's kickoff so the
    # first session file containing it can be bound to this pane (those CLIs
    # can't pin a session id at launch, unlike Claude's --session-id).
    session_marker: str = ""


class Attribution:
    """Maps log-file events → (workspace_path, pane_id, stage_id).

    Persists workspace registrations across backend restarts; pane registrations
    are ephemeral (only valid during the running uvicorn process).
    """

    def __init__(
        self,
        readers: Iterable[LogReader],
        *,
        workspaces_path: Path | None = None,
        db: Database | None = None,
    ) -> None:
        self._readers: dict[str, LogReader] = {r.vendor: r for r in readers}
        self._workspaces: dict[str, WorkspaceMapping] = {}
        self._workspaces_path = workspaces_path or (app_data_dir() / "workspace-associations.json")
        self._db = db or Database(self._workspaces_path.parent / DB_FILENAME)
        self._panes: dict[str, _PaneRegistration] = {}
        self._session_owner: dict[str, str] = {}  # session_id → pane_id (ephemeral)
        self._unbound_markers: dict[str, str] = {}  # session_marker → pane_id (Codex/Antigravity)
        self._announced_session_keys: set[str] = set()
        self._lock = Lock()
        # Called (outside the lock) with the pane id whenever a live
        # registration is dropped — the pane account history closes its open
        # interval there, so every kill / unspawn / PTY-death path counts.
        self.on_unregister: Callable[[str], None] | None = None
        self._load_workspaces()

    # ───────────────────────── persistence ─────────────────────────────────

    def _import_legacy(self, cur: object, data: object) -> None:
        if isinstance(data, dict):
            self._db.kv_set(_KV_KEY, data, now=int(time.time()))

    def _load_workspaces(self) -> None:
        data = self._db.kv_get(_KV_KEY)
        if data is None:
            self._db.import_json(_KV_KEY, self._workspaces_path, self._import_legacy)
            data = self._db.kv_get(_KV_KEY)
        if isinstance(data, dict):
            for ws_path, body in data.items():
                if not isinstance(body, dict):
                    continue
                self._workspaces[str(ws_path)] = WorkspaceMapping(
                    workspace_path=str(ws_path),
                    claude_dir=str(body.get("claude_dir") or ""),
                    registered_at=float(body.get("registered_at") or time.time()),
                )
        log.info("loaded %d workspace association(s)", len(self._workspaces))

    def _save_workspaces(self) -> None:
        data = {ws: asdict(m) for ws, m in self._workspaces.items()}
        try:
            self._db.kv_set(_KV_KEY, data, now=int(time.time()))
        except sqlite3.Error as err:
            # Same degradation as the old JSON file store: registration keeps
            # working in memory and the persistence failure is only logged.
            log.warning("workspace-associations save failed: %s", err)

    # ───────────────────────── workspace lifecycle ─────────────────────────

    def register_workspace(self, workspace_path: str) -> None:
        """Idempotent. Bind the workspace path to its CLI session folders.

        Once registered, any session file under those folders is attributed
        to this workspace — including files that existed before registration
        (so historic usage retroactively shows up in the workspace tally).
        """
        if not workspace_path:
            return
        with self._lock:
            mapping = self._workspaces.get(workspace_path) or WorkspaceMapping(
                workspace_path=workspace_path
            )

            # Claude: project folder name = encode_claude_cwd(cwd). Recompute
            # on every (re-)registration so a stale claude_dir persisted by an
            # older encoder self-corrects the next time the workspace opens.
            claude_dir = mapping.claude_dir
            if "claude" in self._readers:
                encoded = encode_claude_cwd(workspace_path)
                for root in self._readers["claude"].project_dirs():
                    claude_dir = str(root / encoded)
                    break

            if workspace_path in self._workspaces and claude_dir == mapping.claude_dir:
                return
            mapping.claude_dir = claude_dir
            self._workspaces[workspace_path] = mapping
            self._save_workspaces()
        log.info(
            "registered workspace=%s claude_dir=%s",
            workspace_path,
            mapping.claude_dir or "(none)",
        )

    def unregister_workspace(self, workspace_path: str) -> None:
        with self._lock:
            self._workspaces.pop(workspace_path, None)
            self._save_workspaces()

    def known_workspaces(self) -> list[str]:
        with self._lock:
            return sorted(self._workspaces.keys())

    def existing_workspace_roots(self) -> list[Path]:
        """Registered workspace roots that still exist, resolved once.

        The path-allowlist checks (plugin terminal.run, shell.run) rebuild this
        list on every call to ask "is this cwd inside a registered workspace".
        The registry is never pruned — 44 of 115 entries on one real install
        point at folders that are gone — so most of that resolve() work is
        spent on roots nothing can ever be inside of.

        Dropping them changes no answer. Every caller already rejects a cwd
        that is not an existing directory, and a directory cannot exist inside
        one that does not; a root that is only temporarily away (unmounted
        volume) takes its subtree with it, so requests under it fail either
        way. What does change is WHICH rejection: such a cwd is now "not
        registered" rather than "invalid path". Both refuse.

        The property that matters for a security check: filtering can only
        make the allowlist SMALLER, so it can reject more but never permit
        more. Pruning the registry itself would not be equivalent — it is also
        the record historic usage is attributed against.
        """
        roots: list[Path] = []
        for w in self.known_workspaces():
            # isdir on the raw string FIRST, and that order is the whole point:
            # it is one stat, while resolve() walks and readlinks every
            # component. Resolving all 115 and then testing each is measurably
            # SLOWER than the unfiltered list it replaced (1.31 ms vs 0.90 ms
            # on a real registry); this way round is 0.72 ms.
            if not os.path.isdir(w):
                continue
            try:
                roots.append(Path(w).resolve())
            except OSError:
                # A root on a wedged mount answers neither yes nor no; treat it
                # as absent rather than letting one bad path break every check.
                continue
        return roots

    def active_workspaces(self) -> list[str]:
        """Workspaces that have at least one registered pane right now.

        The scanning scope for ACTIVITY. known_workspaces() is the wrong list
        for that: it is every workspace ever opened, kept forever on purpose so
        historic usage can still be attributed (see register_workspace), and
        nothing prunes it. Activity only ever answers "what is happening now",
        so scoping it to panes that exist keeps a cold start from re-parsing
        every transcript the machine has ever accumulated.

        Ephemeral by nature — panes register when the frontend connects and
        unregister when their terminal is killed — so this is empty until the
        first pane arrives. That is the intended shape, not a gap: a workspace
        with no pane has nothing live to report.
        """
        with self._lock:
            return sorted({r.workspace_path for r in self._panes.values() if r.workspace_path})

    # ───────────────────────── pane lifecycle ──────────────────────────────

    def register_pane(
        self,
        pane_id: str,
        *,
        vendor: str,
        cwd: str,
        workspace_path: str = "",
        stage_id: str | None = None,
        slot_key: str = "",
        group_id: str = "",
        explicit_session_id: str = "",
        session_marker: str = "",
        session_home_id: str = "",
        defer_baseline: bool = False,
    ) -> None:
        """Bind a current-run pane to its expected log-file vendor + cwd.

        Also implicitly registers the workspace so the pane's sessions count
        toward the workspace tally.

        `defer_baseline`: register now (cheap, lock only) and leave the
        baseline scan to a later scan_pane_baseline call. The scan enumerates
        the vendor's session tree — for Codex it opens every rollout under
        ~/.codex/sessions and ~/.codex-panes/*/sessions to read its header —
        and on a large tree that takes long enough to push terminal.create's
        ack past the renderer's deadline (issue #118). The caller runs the
        scan off-loop after acking the spawn.

        `explicit_session_id` (Claude `--session-id`): when the pane was launched
        with a pinned session id, we bind session→pane RIGHT NOW. The first event
        for that session then maps to THIS pane directly — no first-come-claim
        guessing, which mis-routed sessions across panes sharing one workspace.

        `session_marker` (Codex/Antigravity): those CLIs can't pin a session id, so
        instead a unique marker is embedded in the kickoff. maybe_bind_by_marker()
        binds the first session file containing it to this pane.
        """
        # Register the workspace too — convenience for callers that only call
        # register_pane and not register_workspace explicitly.
        ws = workspace_path or cwd
        if ws:
            self.register_workspace(ws)

        if vendor not in self._readers:
            log.debug("register_pane: unknown vendor %s, pane attribution skipped", vendor)
            return

        baseline = set() if defer_baseline else self._scan_baseline(vendor, ws)

        reg = _PaneRegistration(
            pane_id=pane_id, vendor=vendor, cwd=cwd,
            workspace_path=ws, stage_id=stage_id, slot_key=slot_key,
            group_id=group_id,
            baseline_files=baseline, baseline_pending=defer_baseline,
            session_marker=session_marker,
            session_home_id=session_home_id,
        )
        with self._lock:
            self._panes[pane_id] = reg
            # Pinned session id → bind to THIS pane immediately (precise, no claim).
            if explicit_session_id:
                self._session_owner[explicit_session_id] = pane_id
                reg.claimed_session_ids.add(explicit_session_id)
            elif session_marker:
                self._unbound_markers[session_marker] = pane_id
        log.debug("registered pane=%s vendor=%s cwd=%s baseline=%d files marker=%s",
                  pane_id, vendor, cwd, len(baseline), session_marker or "(none)")

    def _scan_baseline(self, vendor: str, ws: str) -> set[Path]:
        """The vendor's session files that exist now — files a pane registered
        at this moment must never claim as its own. Blocking (disk)."""
        reader = self._readers[vendor]
        try:
            # Scope the baseline to THIS pane's workspace folder when the reader
            # can (Claude/Kimi/Antigravity/Codex map a workspace to one dir). A
            # pane only ever claims sessions under its own cwd, so the whole-tree
            # enumeration was pure waste — on a large ~/.claude it stat'd ~1500
            # files per spawn. Grok (shared DB) / missing ws → None → full tree.
            scoped = reader.session_files_for_workspace(ws) if ws else None
            files = scoped if scoped is not None else reader.session_files()
            return set(files)
        except Exception as err:  # noqa: BLE001
            log.warning("baseline scan failed for vendor=%s: %s", vendor, err)
            return set()

    def scan_pane_baseline(self, pane_id: str) -> None:
        """Fill in the baseline a register_pane(defer_baseline=True) left
        pending. Blocking (disk) — run it in an executor. A no-op when the
        pane was unregistered meanwhile or never deferred, so a late scan can
        never revive a dead registration."""
        with self._lock:
            reg = self._panes.get(pane_id)
            if reg is None or not reg.baseline_pending:
                return
            vendor, ws = reg.vendor, reg.workspace_path or reg.cwd
        started = time.monotonic()
        baseline = self._scan_baseline(vendor, ws)
        with self._lock:
            if self._panes.get(pane_id) is not reg:
                return
            reg.baseline_files = baseline
            reg.baseline_pending = False
        elapsed_ms = int((time.monotonic() - started) * 1000)
        # Slow scans are the #118 signature; keep them visible in backend.log.
        log.log(
            logging.WARNING if elapsed_ms >= 2000 else logging.DEBUG,
            "baseline scan pane=%s vendor=%s files=%d took %dms",
            pane_id, vendor, len(baseline), elapsed_ms,
        )

    def slot_key_for(self, pane_id: str) -> str:
        """The registered pane's tokens_store bucket key ("" when unknown).
        Callers that credit tokens outside the attribute() path need the same
        `slot_key or pane_id` choice the sink makes."""
        with self._lock:
            reg = self._panes.get(pane_id)
            return reg.slot_key if reg else ""

    def set_pane_group(self, pane_id: str, group_id: str) -> bool:
        """Re-point a live pane's run-group attribution. Only usage attributed
        from now on is credited to `group_id`; buckets already recorded stay
        where they are. False when the pane is not registered."""
        with self._lock:
            reg = self._panes.get(pane_id)
            if reg is None:
                return False
            reg.group_id = group_id
            return True

    def unregister_pane(self, pane_id: str) -> None:
        with self._lock:
            reg = self._panes.pop(pane_id, None)
            if not reg:
                return
            for sid in reg.claimed_session_ids:
                if self._session_owner.get(sid) == pane_id:
                    del self._session_owner[sid]
            if reg.session_marker:
                self._unbound_markers.pop(reg.session_marker, None)
        if self.on_unregister is not None:
            try:
                self.on_unregister(pane_id)
            except Exception as err:  # noqa: BLE001 — bookkeeping must not break the release
                log.warning("pane unregister hook failed for %s: %s", pane_id, err)

    # ───────────────────────── attribution ─────────────────────────────────

    def attribute(self, usage: TokenUsage) -> AttributedUsage:
        """Map a usage event to (workspace, pane, stage). Workspace is the
        gate — if no registered workspace matches, the sink should drop this
        event (it's an external session not associated with any Agent-Team
        workspace)."""
        with self._lock:
            ws_path = self._lookup_workspace_for(usage)
            if ws_path is None:
                return AttributedUsage(
                    usage=usage, pane_id=None, workspace_path=None, stage_id=None,
                )

            # Pane attribution within the current run (best-effort for "By Pane")
            pane_id, stage_id, slot_key = self._lookup_pane_for(usage)
            reg = self._panes.get(pane_id) if pane_id else None
            return AttributedUsage(
                usage=usage,
                pane_id=pane_id,
                workspace_path=ws_path,
                stage_id=stage_id,
                slot_key=slot_key,
                group_id=reg.group_id if reg else "",
            )

    def maybe_announce_session(self, usage: TokenUsage) -> SessionBinding | None:
        """Return the first pane binding that should be persisted for resume.

        Handles the preferred non-marker identity path first:
          - Codex: per-pane CODEX_HOME path encodes pane_id; resume id is
            session_meta.payload.id.

        Falls back to marker matching for older sessions and during rollout.
        Antigravity has no identity path at launch (`agy --conversation` can't
        create a chosen id), so it relies on marker matching plus the
        single-candidate new-session fallback; its resume id is the
        conversation .db filename stem (= usage.session_id).
        Kimi likewise can't pin an id (`kimi --session` only resumes); its
        marker is typed into the TUI post-launch and is silently lost when the
        injection loses the startup timing race, so the single-candidate
        fallback is its safety net — resume id is the `session_<uuid>` dir
        name (= usage.session_id).
        Grok relies on markers exclusively, but stores every session in
        one shared SQLite db — its binding queries the db via the reader.
        OpenCode works the same way (`opencode --session <id>` can only
        resume, and all sessions live in one shared db), as does Kilo Code
        (an OpenCode fork — `kilo --session <id>`, shared kilo.db).
        Qwen writes one jsonl per session (like Claude) and preserves user
        text verbatim, so the kickoff marker lands in the session file —
        marker matching plus the single-candidate fallback bind it; the
        resume id is the file stem accepted by `qwen --resume <id>`
        (= usage.session_id).
        Pi likewise writes one jsonl per session and preserves user text
        verbatim, so marker matching plus the single-candidate fallback
        bind it — but the file only appears after the FIRST assistant reply
        completes (lazy flush), so its binding lands later than other
        vendors'. The resume id is the header id `pi --session-id <id>`
        accepts (= usage.session_id; the filename stem carries a timestamp
        prefix and is NOT the id).
        Copilot writes one events.jsonl per session dir and preserves user
        text verbatim (user.message data.content), so the kickoff marker
        lands in the session file — marker matching plus the
        single-candidate fallback bind it; the resume id is the session dir
        name accepted by `copilot --resume=<id>` (= usage.session_id).
        Cursor writes one store.db per session, but its content is opaque
        protobuf blobs, so marker resolution belongs to the reader (a raw
        bytes scan via find_sessions_by_marker) — the same reader-driven
        binding path as the shared-db vendors, even though the dbs are
        per-session; the resume id is the session dir name accepted by
        `agent --resume=<id>`.
        Aider appends every session to ONE per-project Markdown history file
        and preserves user text verbatim (`#### ` lines), so the kickoff
        marker lands in the file — but only the file's LAST started-at
        section is the live session, so marker matching scans just that
        section and there is no single-candidate fallback (the shared file
        usually pre-exists in the pane's baseline). Aider has no session id;
        the announced "resume id" is the section's started-at slug, and
        resume itself is the id-less, lossy `aider --restore-chat-history`.
        """
        shared_db_reader = self._readers.get(usage.vendor)
        if (
            shared_db_reader is not None
            and shared_db_reader.binds_shared_db_by_marker
        ):
            binding = self._bind_shared_db_by_marker(usage)
            # A shared-db vendor whose marker injection lost the startup race
            # has no marker to find, so returning unconditionally here would
            # leave that pane permanently unbound (copilot types its marker
            # into the TUI). Fall through to the single-candidate fallback
            # when the vendor declares it. Inert for the other shared-db
            # vendors (grok/opencode/cursor): none of them declare it.
            if binding or not shared_db_reader.binds_new_session_single_candidate:
                return binding
            return self._bind_new_session_single_candidate(usage)
        # Tuple = vendors not yet migrated to reader hooks; a migrated
        # vendor's reader declares binds_by_marker_file instead.
        marker_reader = self._readers.get(usage.vendor)
        if not (marker_reader is not None and marker_reader.binds_by_marker_file):
            return None

        # Once a session is bound, every binding path below no-ops — but their
        # short-circuits sit behind per-event file reads, so a bound session
        # would still pay a capped-512KB read on every write. This runs in the
        # session_sink hot path on the loop's thread pool; bail before any IO.
        sid = usage.session_id
        if sid:
            with self._lock:
                if sid in self._session_owner:
                    return None

        # Identity path: vendors whose session-file PATH names the pane
        # (codex's per-pane CODEX_HOME). Three-state hook: None = not an
        # identity-path file; (pane, "") = pane known but the vendor's real
        # resume id isn't readable yet, so WAIT rather than announce a
        # malformed fallback id; (pane, id) = bind.
        if marker_reader is not None:
            identity = marker_reader.path_identity(usage)
            if identity is not None:
                pane_id, resume_id = identity
                if not resume_id:
                    return None
                binding = self._bind_and_announce_path_session(
                    usage=usage,
                    pane_id=pane_id,
                    resume_id=resume_id,
                    session_file=usage.file_path,
                )
                if binding:
                    return binding

        marker_binding = self.maybe_bind_by_marker(usage)
        if marker_binding:
            pane_id, resume_id = marker_binding
        elif (
            marker_reader is not None
            and marker_reader.binds_new_session_single_candidate
        ):
            return self._bind_new_session_single_candidate(usage)
        else:
            return None
        with self._lock:
            reg = self._panes.get(pane_id)
            if reg is None:
                return None
            return SessionBinding(
                pane_id=pane_id,
                resume_id=resume_id,
                workspace_path=reg.workspace_path,
                stage_id=reg.stage_id,
                session_file=usage.file_path,
            )

    def maybe_bind_by_marker(self, usage: TokenUsage) -> tuple[str, str] | None:
        """Codex/Antigravity: bind a session file to its pane by the marker embedded
        in the kickoff. Returns (pane_id, resume_id) on the binding transition
        (the first time this session is matched), else None.

        `resume_id` is the id the CLI's resume command actually needs, which is
        NOT the same as the reader's `usage.session_id`:
          • Codex:  session_meta `payload.id` (the filename stem includes a
            timestamp prefix, so the stem can't be passed to `codex resume`).
        Falls back to usage.session_id if the file shape is unexpected.

        Reads the session file only while there are still unbound markers for an
        unowned session — once bound, the session_owner short-circuit means no
        further reads. The file read happens outside the lock.
        """
        gate_reader = self._readers.get(usage.vendor)
        if not (gate_reader is not None and gate_reader.binds_by_marker_file):
            return None
        sid = usage.session_id
        with self._lock:
            if not self._unbound_markers or (sid and sid in self._session_owner):
                return None
            markers = dict(self._unbound_markers)  # snapshot for lock-free read

        try:
            # Markers live in the first user turn; cap the read so a long session
            # doesn't cost a full file scan on every event.
            # A migrated vendor's hook owns its own read budget (it may
            # combine several sources, e.g. a db plus its -wal journal).
            scan_override = (
                gate_reader.marker_scan_text(Path(usage.file_path))
                if gate_reader is not None else None
            )
            if scan_override is not None:
                text = scan_override
            else:
                text = Path(usage.file_path).read_text(encoding="utf-8", errors="ignore")[:524_288]
        except OSError:
            return None

        matched_pane = next((pid for marker, pid in markers.items() if marker in text), None)
        if matched_pane is None:
            return None

        resume_id = (
            gate_reader.resume_id_from_session_text(text)
            if gate_reader is not None else ""
        )
        if not resume_id and gate_reader is not None \
                and gate_reader.requires_real_resume_id:
            # Do not consume the marker or claim the session file until the
            # vendor's real resume id appears. Watcher updates will retry.
            return None
        resume_id = resume_id or sid
        with self._lock:
            # Re-check under lock: another event may have bound it meanwhile.
            if sid in self._session_owner:
                return None
            reg = self._panes.get(matched_pane)
            if reg is None:
                return None  # pane was killed between snapshot and now
            self._session_owner[sid] = matched_pane
            reg.claimed_session_ids.add(sid)
            self._unbound_markers.pop(reg.session_marker, None)
        log.info("bound session=%s → pane=%s via marker (resume_id=%s)", sid, matched_pane, resume_id)
        return matched_pane, resume_id

    def _bind_shared_db_by_marker(self, usage: TokenUsage) -> SessionBinding | None:
        """Grok/OpenCode/Kilo keep ALL sessions in one shared SQLite db, so marker
        binding asks the reader to resolve markers → session ids in the db
        instead of scanning a per-session file. Cursor keeps one db PER
        session, but its blobs are opaque protobuf, so it uses the same
        reader-driven resolution (with ws_root always '' — the store records
        no cwd — which intentionally keeps the workspace gate below
        permissive for it). Binds at most one session per
        call; the watcher fires again on every db write, so any remaining
        markers resolve on subsequent events. Resume id is the db's session id
        that `grok -s <id>` / `opencode --session <id>` accepts."""
        vendor = usage.vendor
        reader = self._readers.get(vendor)
        if reader is None:
            return None
        with self._lock:
            markers = [
                marker for marker, pid in self._unbound_markers.items()
                if (reg := self._panes.get(pid)) is not None and reg.vendor == vendor
            ]
        if not markers:
            return None
        # DB read outside the lock (short read-only connection; {} on failure).
        found = reader.find_sessions_by_marker(markers)
        for marker, (session_id, ws_root) in found.items():
            if not session_id:
                continue
            with self._lock:
                pane_id = self._unbound_markers.get(marker)
                owner = self._session_owner.get(session_id)
                if pane_id is None or owner not in (None, pane_id):
                    continue  # bound meanwhile / pane killed
                # A usage row can claim the session for this same pane before
                # the turn carrying the marker lands; the marker then confirms
                # that claim and announces it once.
                key = f"{vendor}:{session_id}:{session_id}"
                if owner == pane_id and key in self._announced_session_keys:
                    self._unbound_markers.pop(marker, None)
                    continue
                reg = self._panes.get(pane_id)
                if reg is None or reg.vendor != vendor:
                    continue
                # Workspace gate: the reader reports the session's workspace
                # root (grok: workspaces.scope_key, opencode/kilo:
                # session.directory);
                # require it to match the pane so a marker echoed in another
                # project can't cross-bind.
                if ws_root and ws_root not in (reg.cwd, reg.workspace_path):
                    continue
                self._session_owner[session_id] = pane_id
                reg.claimed_session_ids.add(session_id)
                self._unbound_markers.pop(marker, None)
                self._announced_session_keys.add(key)
                binding = SessionBinding(
                    pane_id=pane_id,
                    resume_id=session_id,
                    workspace_path=reg.workspace_path,
                    stage_id=reg.stage_id,
                    session_file=usage.file_path,
                )
            log.info(
                "bound %s session=%s → pane=%s via marker", vendor, session_id, pane_id
            )
            return binding
        return None

    def _bind_new_session_single_candidate(self, usage: TokenUsage) -> SessionBinding | None:
        """Fallback Antigravity/Kimi resume capture when the marker is not visible.

        Antigravity writes SQLite conversations and may create the .db before the
        injected marker lands in either the main db or WAL. Kimi creates its
        session dir at launch, but its marker is typed into the TUI after
        startup and is silently dropped whenever that injection loses the
        timing race — without a fallback the session id is never captured and
        resume-on-restart spawns a blank fresh session. If exactly one
        registered pane of this vendor in this cwd has a new, unclaimed session
        file, bind it to that pane. Multiple candidates are intentionally left
        unbound so marker matching can resolve them later without cross-pane
        corruption.
        """
        sc_reader = self._readers.get(usage.vendor)
        if not (
            sc_reader is not None
            and sc_reader.binds_new_session_single_candidate
        ) or not usage.session_id:
            return None
        file_path = Path(usage.file_path)
        key = f"{usage.vendor}:{usage.session_id}:{usage.session_id}"
        with self._lock:
            if key in self._announced_session_keys:
                return None
            owner = self._session_owner.get(usage.session_id)
            if owner is not None:
                return None
            candidates = [
                reg for reg in self._panes.values()
                if reg.vendor == usage.vendor
                and self._cwd_matches(reg.cwd, usage, reg.pane_id)
                and not reg.baseline_pending
                and file_path not in reg.baseline_files
                and not reg.claimed_session_ids
            ]
            if len(candidates) != 1:
                return None
            reg = candidates[0]
            self._session_owner[usage.session_id] = reg.pane_id
            reg.claimed_session_ids.add(usage.session_id)
            if reg.session_marker:
                self._unbound_markers.pop(reg.session_marker, None)
            self._announced_session_keys.add(key)
            binding = SessionBinding(
                pane_id=reg.pane_id,
                resume_id=usage.session_id,
                workspace_path=reg.workspace_path,
                stage_id=reg.stage_id,
                session_file=usage.file_path,
            )
        log.info(
            "bound %s session=%s → pane=%s via new-session fallback",
            usage.vendor, usage.session_id, binding.pane_id,
        )
        return binding

    def _bind_and_announce_path_session(
        self,
        *,
        usage: TokenUsage,
        pane_id: str,
        resume_id: str,
        session_file: str,
    ) -> SessionBinding | None:
        if not usage.session_id or not resume_id:
            return None
        key = f"{usage.vendor}:{usage.session_id}:{resume_id}"
        with self._lock:
            reg = self._pane_registration_for_home_id(pane_id)
            if reg is None or reg.vendor != usage.vendor:
                return None
            if key in self._announced_session_keys:
                return None
            owner = self._session_owner.get(usage.session_id)
            if owner is not None and owner != reg.pane_id:
                return None
            self._session_owner[usage.session_id] = reg.pane_id
            reg.claimed_session_ids.add(usage.session_id)
            self._announced_session_keys.add(key)
            binding = SessionBinding(
                pane_id=reg.pane_id,
                resume_id=resume_id,
                workspace_path=reg.workspace_path,
                stage_id=reg.stage_id,
                session_file=session_file,
            )
        log.info(
            "bound session=%s → pane=%s via codex home path (resume_id=%s)",
            usage.session_id, pane_id, resume_id,
        )
        return binding

    def bind_confirmed_session(
        self, *, vendor: str, pane_id: str, resume_id: str, session_file: str,
        session_id: str,
    ) -> SessionBinding | None:
        """Bind an authenticated, transcript-verified lifecycle callback.

        Both the filename key and the real UUID are used by Codex readers.
        Never steal either from another pane, including same-cwd siblings.
        """
        with self._lock:
            reg = self._panes.get(pane_id)
            if reg is None or reg.vendor != vendor:
                return None
            ids = {session_id, resume_id}
            if any(self._session_owner.get(sid, pane_id) != pane_id for sid in ids):
                return None
            key = f"{vendor}:{session_id}:{resume_id}"
            for sid in ids:
                self._session_owner[sid] = pane_id
                reg.claimed_session_ids.add(sid)
            self._unbound_markers.pop(reg.session_marker, None)
            if key in self._announced_session_keys:
                return None
            self._announced_session_keys.add(key)
            return SessionBinding(
                pane_id=pane_id, resume_id=resume_id,
                workspace_path=reg.workspace_path, stage_id=reg.stage_id,
                session_file=session_file,
            )

    def pane_for_session(
        self, session_id: str
    ) -> tuple[str | None, str | None, str | None]:
        """Resolve (pane_id, workspace_path, stage_id) from session_id alone.

        For hook payloads (Claude Stop / PreToolUse) that carry session_id + cwd
        but NO file_path, so they cannot pass the file_path-based workspace gate
        in attribute(). This bypasses the gate by reusing the session→pane claim
        the JSONL path already made (_session_owner). Returns (None, None, None)
        if the session isn't claimed yet (race: stop arriving before the JSONL
        path claimed it) — the caller should fall back to an empty pane_id and
        let the JSONL path's matching event supply it shortly."""
        if not session_id:
            return None, None, None
        with self._lock:
            owner = self._session_owner.get(session_id)
            if owner is None:
                return None, None, None
            reg = self._panes.get(owner)
            if reg is None:
                return None, None, None
            return reg.pane_id, reg.workspace_path, reg.stage_id

    def _lookup_workspace_for(self, usage: TokenUsage) -> str | None:
        """Find which registered workspace this log file belongs to."""
        file_path = usage.file_path
        ws_reader = self._readers.get(usage.vendor)
        # Workspace of the pane a marker binding already assigned this session
        # to (None when unbound) — vendors whose logs carry no cwd (cursor)
        # attribute bound sessions through it.
        owner = self._session_owner.get(usage.session_id) if usage.session_id else None
        owner_reg = self._panes.get(owner) if owner else None
        owner_ws = owner_reg.workspace_path if owner_reg is not None else None
        claude_hits: list[str] = []
        for ws_path, mapping in self._workspaces.items():
            # Migrated vendors answer through their reader; None falls to the
            # legacy chain below, deleted one vendor at a time.
            if ws_reader is not None:
                verdict = ws_reader.workspace_match(usage, ws_path, owner_ws)
                if verdict is True:
                    return ws_path
                if verdict is False:
                    continue
            if usage.vendor == "claude":
                # Path-prefix match against claude_dir (default config home).
                # Managed-account panes write via a symlinked profile home whose
                # ``projects`` resolves back into this same default root, so the
                # single prefix check covers every account.
                if mapping.claude_dir and (
                    file_path == mapping.claude_dir
                    or file_path.startswith(mapping.claude_dir + "/")
                    or file_path.startswith(mapping.claude_dir + os.sep)
                ):
                    claude_hits.append(ws_path)
        return self._pick_claude_workspace(usage, claude_hits, owner_ws)

    def _pick_claude_workspace(
        self, usage: TokenUsage, hits: list[str], owner_ws: str | None
    ) -> str | None:
        """Workspaces whose names encode alike share a project folder, so ``hits``
        can hold several. Only then is the transcript's own cwd read. A session the
        file cannot place stays on the first hit, as it always did: dropping it here
        would take its usage out of the global and account totals as well."""
        if len(hits) < 2:
            return hits[0] if hits else None
        if owner_ws in hits:
            return owner_ws
        reader = self._readers["claude"]
        return next(
            (ws for ws in hits if reader.session_in_workspace(usage.file_path, ws)),
            hits[0],
        )

    def _lookup_pane_for(
        self, usage: TokenUsage
    ) -> tuple[str | None, str | None, str | None]:
        """Best-effort current-run pane lookup. Doesn't gate workspace attr.

        Returns (pane_id, stage_id, slot_key).
        pane_id    — ephemeral frontend UUID, used for event routing.
        slot_key   — stable "stageId:slotLabel", used as tokens_store by_pane key.
        """
        owner = self._session_owner.get(usage.session_id)
        if owner is not None:
            reg = self._panes.get(owner)
            if reg:
                return reg.pane_id, reg.stage_id, reg.slot_key or None

        home_reader = self._readers.get(usage.vendor)
        home_id = home_reader.pane_home_id(usage.file_path) if home_reader else ""
        if home_id:
            reg = self._pane_registration_for_home_id(home_id)
            if reg and reg.vendor == usage.vendor:
                self._session_owner[usage.session_id] = reg.pane_id
                reg.claimed_session_ids.add(usage.session_id)
                return reg.pane_id, reg.stage_id, reg.slot_key or None

        # Try to claim with a freshly-spawned pane
        file_path = Path(usage.file_path)
        candidates = [
            reg for reg in self._panes.values()
            if reg.vendor == usage.vendor
            and self._cwd_matches(reg.cwd, usage, reg.pane_id)
            and not reg.baseline_pending
            and file_path not in reg.baseline_files
            and not reg.claimed_session_ids
        ]
        if len(candidates) != 1:
            # Zero candidates: nothing to claim. Several candidates: ambiguous
            # provenance — guessing (old behavior: oldest registration wins)
            # could route one pane's session to a sibling, which the frontend
            # may then adopt AND persist, silently replacing that pane's
            # session. Do nothing; only a deterministic path (explicit
            # --session-id, per-pane home dir, kickoff marker) may bind it.
            # Mirrors _bind_new_session_single_candidate's exactly-one rule.
            return None, None, None
        reg = candidates[0]
        self._session_owner[usage.session_id] = reg.pane_id
        reg.claimed_session_ids.add(usage.session_id)
        return reg.pane_id, reg.stage_id, reg.slot_key or None

    def _cwd_matches(self, pane_cwd: str, usage: TokenUsage, pane_id: str = "") -> bool:
        if not pane_cwd:
            return False
        file_path = usage.file_path
        reader = self._readers.get(usage.vendor)
        if reader is not None:
            verdict = reader.pane_cwd_match(usage, pane_cwd, pane_id)
            if verdict is not None:
                return verdict
        return False

    def _pane_registration_for_home_id(self, home_id: str) -> _PaneRegistration | None:
        if not home_id:
            return None
        reg = self._panes.get(home_id)
        if reg and (not reg.session_home_id or reg.session_home_id == home_id):
            return reg
        return next(
            (p for p in self._panes.values() if p.session_home_id == home_id),
            None,
        )
