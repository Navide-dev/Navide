"""Per-workspace project metadata + per-run pipeline event logs.

Each workspace gets a `.agent-team/` directory containing:
  - navide.db                                    project document (kv "project")
  - pipeline-YYYYMMDD-HHMMSS-<task-slug>.log    one log file per pipeline run

The legacy `project.json` is imported into the database on first access and
renamed `project.json.migrated-v1`.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .db import DB_FILENAME, WorkspaceDatabases
from .path_guard import PROJECT_DIR_NAME

log = logging.getLogger("agent_team_backend.projects")

PROJECT_FILE = "project.json"  # legacy JSON name, still used for import
RUNS_SUBDIR = "runs"
_KV_KEY = "project"
# Same sanity cap the JSON reader enforced; oversize legacy files are treated
# as unreadable at import time (kept on disk for inspection).
_LEGACY_MAX_BYTES = 524_288


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _make_run_name(task_description: str) -> str:
    """Generate YYYYMMDD-HHMMSS-<slug> — used as the run sub-folder name."""
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    # Keep only CJK / alphanumeric chars, replace the rest with hyphens, max 30 chars
    slug = re.sub(r"[^\w一-鿿぀-ヿ]", "-", task_description.strip())
    slug = re.sub(r"-+", "-", slug).strip("-")[:30]
    return f"{ts}-{slug}" if slug else ts


def _make_log_filename(task_description: str) -> str:
    """Return relative path 'runs/{run_name}/pipeline.log' for a new pipeline run."""
    run_name = _make_run_name(task_description)
    return f"{RUNS_SUBDIR}/{run_name}/pipeline.log"


def _project_id_for(workspace_path: str) -> str:
    h = hashlib.sha1(workspace_path.encode("utf-8")).hexdigest()[:10]
    return f"proj_{h}"


def ensure_workspace_data_dir(workspace_path: str) -> Path:
    """Create <workspace>/.agent-team/ and make it self-ignoring for git.

    `.gitignore` with `*` ignores the whole directory (including itself), so
    git never tracks it regardless of the workspace's own .gitignore or
    staging order — same pattern as pytest's .pytest_cache/.gitignore.
    """
    d = Path(workspace_path) / PROJECT_DIR_NAME
    d.mkdir(parents=True, exist_ok=True)
    gi = d / ".gitignore"
    if not gi.exists():
        gi.write_text("*\n", encoding="utf-8")
    return d


@dataclass
class SlotRecord:
    label: str
    agent: str = ""
    role: str = ""
    pane_id: str | None = None
    spawn_status: str = "pending"   # pending / spawned / removed
    kickoff_status: str = "none"    # none / sent / failed
    # CLI session id used to resume this slot's conversation on App restart.
    # Claude: the --session-id we pinned at spawn (known immediately).
    # Codex/Gemini: the CLI-generated id, detected after spawn. "" = no resume.
    session_id: str = ""
    run_group_id: str = ""  # which frontend tab this pane belongs to


@dataclass
class ManualPaneRecord:
    pane_id: str
    agent: str = ""
    role: str = ""
    command: str = ""
    spawn_status: str = "spawned"  # spawned / removed
    session_id: str = ""
    run_group_id: str = ""  # which frontend tab this pane belongs to


@dataclass
class PaneRecord:
    """Unified restore record for both pipeline slots and manual panes."""
    pane_id: str
    agent: str = ""
    role: str = ""
    command: str = ""
    model: str = ""                 # CLI model pick recorded at spawn; "" = unspecified (use the vendor default)
    effort: str = ""                # reasoning-effort pick recorded at spawn; "" = unspecified
    session_id: str = ""
    session_home_id: str = ""       # Codex per-pane CODEX_HOME id; stable across restored pane ids
    profile_id: str = ""            # CLI account pin: the profile this pane was spawned on ("__default__" = real home; "" = legacy/unpinned). Restore re-spawns in the SAME account regardless of the current active default.
    spawn_status: str = "pending"   # pending / spawned / removed
    spawned_at: str = ""            # ISO8601 UTC of the FIRST real spawn; set once, so a restore or a repeat marking keeps the original time. "" = written before this field existed (unknown — never back-filled with now(), the UI shows "—")
    removed_at: str = ""            # ISO8601 UTC of the last removal; overwritten on each removal (only the final one matters). "" = still live, or written before this field existed
    run_group_id: str = ""
    origin: str = "manual"          # "pipeline" | "manual" | "mcp"  (non-pipeline records are matched with != "pipeline")
    spawned_by: str = ""            # pane_id of the parent that spawned this pane; "" = root. Re-keyed on restore alongside pane_id — a stale value is worse than none (see _rekey_spawned_by).
    stage_id: str = ""
    stage_index: int = -1
    slot_label: str = ""
    kickoff_status: str = "none"    # none / sent / failed
    custom_name: str = ""           # user-set display name; empty falls back to the default label
    name_locked: bool = False       # the user named this pane at least once; auto-naming is off for good, even after they clear the name
    auto_name: str = ""             # auto-generated display name; set once, custom_name wins
    auto_name_source: str = ""      # "heuristic" | "llm"; an llm name may upgrade a heuristic one once
    output_log_file: str = ""       # conversation log path recorded at spawn time
    stopped: bool = False           # STOP badge: a stop action was issued and the user hasn't taken over yet
    is_minimized: bool = False      # collapsed to the sidebar. The renderer has been sending this since the feature shipped; the handler was missing, so it never persisted.
    is_muted: bool = False          # per-pane mute: no desktop notification and no sound for this pane; the Dock badge still counts it
    collapsed: bool = False         # lineage subtree folded in the agent lists. Lives here, not in a Project-level id set: pane_id is regenerated every restart, so such a set would silently empty itself.
    surface: str = ""               # embedded AI panel (AiCliDock) host surface ("pm" / "plans" / "git" / "editor"); "" = a main-window pane, which is every record written before this field existed
    window_kind: str = ""           # the window that surface lives in ("main" for the Pipeline Manager modal); "" alongside surface
    last_turn_state: str = ""       # "working" (running a turn, or parked on a permission / question prompt) / "idle"; "" = never reported. Read on a cold restore to bring back the panes a manual restart interrupted.
    report_to: str = ""             # messaging handle of the parent this spawned pane owes a report to
    report_pending: bool = False    # that report is still outstanding — persisted so a pane resumed after a restart still reports when its turn ends


@dataclass
class StageRecord:
    stage_id: str
    title: str = ""
    agent: str = ""
    role: str = ""
    pane_id: str | None = None
    status: str = "pending"  # pending / running / completed / aborted
    started_at: str | None = None
    ended_at: str | None = None
    slots: list[SlotRecord] = field(default_factory=list)


@dataclass
class Project:
    id: str
    name: str
    workspace_path: str
    created_at: str
    updated_at: str
    task_description: str = ""
    state: str = "idle"  # idle / running / completed / aborted
    current_stage_index: int = -1
    total_stages: int = 5
    stages: list[StageRecord] = field(default_factory=list)
    panes: list[PaneRecord] = field(default_factory=list)   # unified: pipeline slots + manual panes
    manual_panes: list[ManualPaneRecord] = field(default_factory=list)  # legacy — kept for backward compat
    agents_spawned: int = 0
    backend_version: str = ""
    log_file_name: str = ""  # set by start_pipeline(); e.g. "pipeline-20260527-183000-建立登入頁面.log"
    layout_mode: str = "grid"
    pipeline_id: str = ""  # which pipeline template was used for this run
    run_count: int = 0     # incremented on each successful pipeline completion
    theme: str = "dark-github"  # backup of the user-level theme (source of truth is the renderer's localStorage)
    theme_custom: dict[str, Any] = field(default_factory=dict)  # backup of custom CSS var overrides (key -> value)
    # Backup of the user-level language (source of truth is the renderer's
    # localStorage). Empty until the user picks one: the renderer adopts this
    # backup as if it were a choice, and a "zh-TW" default here turned every
    # English first launch Chinese on its second start.
    language: str = ""
    tab_order: list[str] = field(default_factory=list)  # run-group tab order (ids); empty = frontend insertion order
    # Renderer-owned run-group tab records ({id, name, createdAt} dicts), stored
    # in display order. None = never persisted (frontend falls back to legacy
    # localStorage migration / default group); [] = the user deleted all groups.
    ui_run_groups: list[dict[str, Any]] | None = None
    ui_active_tab: str = ""  # last active run-group tab id ("" = frontend default)
    ui_git_tab_repo: str = ""  # abs path of the selected repo tab in the multi-repo git view ("" = frontend default)
    # Renderer-owned Agent History. It belongs to the workspace: the previous
    # user-level settings entry mixed projects and could lose custom titles
    # when that global cache was rebuilt.
    ui_spawn_history: list[dict[str, Any]] | None = None
    # Renderer-owned CLI Agents dropdown prefs (Settings modal). None = never
    # persisted for this workspace (frontend falls back to its legacy global
    # per-user default); [] is a valid "explicitly cleared to default" value.
    cli_agent_order: list[str] | None = None
    cli_agent_disabled: list[str] | None = None
    # User-set display name for this workspace. "" = fall back to
    # basename(workspace_path), which is what every surface showed before this
    # field existed. Division of labour with `name`: `name` is the initial
    # value recorded when the project document was created and has no UI to
    # change it; `display_name` is the name the user picked and is the only one
    # the sidebar / title bar / recent list honour. The truth lives here, in
    # the workspace's own db: the alias stays with the project folder, is
    # independent per project, and is not lost when the global settings caches
    # are rebuilt. It is LOCAL — `.agent-team/` is git-ignored, so the alias is
    # never committed and never reaches a teammate. The global
    # recent-workspaces store keeps a `name` mirror for drawing lists without
    # opening every project's db.
    display_name: str = ""
    # DAG run state reported by the renderer engine (pipeline.node_states):
    # graph node id -> NodeRunState dict (src/renderer/src/lib/pipelineGraph.ts).
    # Reset when a run starts. `node_gate` is the gate the run is paused on
    # ({} = none).
    node_states: dict[str, Any] = field(default_factory=dict)
    node_gate: dict[str, Any] = field(default_factory=dict)
    # Last output summary per graph node, kept ACROSS runs so a pinned node
    # can hand its frozen output to downstream nodes ({{prev.summary}}).
    node_outputs: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        # A window pane's record serializes exactly as it did before panels
        # existed: the two panel-only keys appear only when set.
        for pane in d["panes"]:
            for key in ("surface", "window_kind"):
                if not pane[key]:
                    del pane[key]
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Project":
        def _stage(s: dict[str, Any]) -> StageRecord:
            # exclude "slots" — pipeline panes now live in panes[]; old slots are
            # migrated below and should not be set on StageRecord directly.
            known = {f for f in StageRecord.__dataclass_fields__} - {"slots"}
            return StageRecord(**{k: v for k, v in s.items() if k in known})

        stages = [_stage(s) for s in d.get("stages", [])]

        # Unified panes[]: if present use it directly; otherwise migrate from old format.
        pane_known = {f for f in PaneRecord.__dataclass_fields__}
        if "panes" in d:
            panes: list[PaneRecord] = [
                PaneRecord(**{k: v for k, v in p.items() if k in pane_known})
                for p in d["panes"] if isinstance(p, dict)
            ]
            # Records written before name_locked existed carry the intent only in
            # custom_name. Adopt it once so a pane the user already named keeps
            # its lock; a pane they named and then cleared is unrecoverable —
            # that intent was never stored.
            for pane in panes:
                if pane.custom_name:
                    pane.name_locked = True
        else:
            panes = []
            for i, raw_stage in enumerate(d.get("stages", [])):
                for slot in raw_stage.get("slots", []):
                    pid = slot.get("pane_id") or ""
                    if not pid:
                        continue
                    panes.append(PaneRecord(
                        pane_id=pid,
                        agent=slot.get("agent", ""),
                        role=slot.get("role", ""),
                        session_id=slot.get("session_id", ""),
                        session_home_id=slot.get("session_home_id", ""),
                        spawn_status=slot.get("spawn_status", "pending"),
                        run_group_id=slot.get("run_group_id", ""),
                        kickoff_status=slot.get("kickoff_status", "none"),
                        origin="pipeline",
                        stage_id=raw_stage.get("stage_id", ""),
                        stage_index=i,
                        slot_label=slot.get("label", ""),
                    ))
            for mp in d.get("manual_panes", []):
                if not isinstance(mp, dict) or not mp.get("pane_id"):
                    continue
                panes.append(PaneRecord(
                    pane_id=mp["pane_id"],
                    agent=mp.get("agent", ""),
                    role=mp.get("role", ""),
                    command=mp.get("command", ""),
                    session_id=mp.get("session_id", ""),
                    session_home_id=mp.get("session_home_id", ""),
                    spawn_status=mp.get("spawn_status", "spawned"),
                    run_group_id=mp.get("run_group_id", ""),
                    origin="manual",
                ))

        d2 = {**d, "stages": stages, "panes": panes}
        known = {f for f in cls.__dataclass_fields__}
        d2 = {k: v for k, v in d2.items() if k in known}
        return cls(**d2)


class ProjectStore:
    """Manages the project document (workspace navide.db) + pipeline.log."""

    def __init__(self, databases: WorkspaceDatabases | None = None) -> None:
        self._databases = databases or WorkspaceDatabases()
        # Serializes project.json writes. Most mutations run on the asyncio
        # event loop (implicitly serialized); set_ui_state is offloaded to a
        # worker thread (see ws_handlers), so its read-modify-write and every
        # save() must be mutually exclusive to keep the shared .tmp file and
        # snapshot consistent. RLock: set_ui_state holds it across save().
        self._save_lock = threading.RLock()
        # pane_ids whose pending stub was raised (or touched) by a rename, so
        # _adopt_pending_stub knows its empty custom_name is an explicit reset
        # rather than "never named". Runtime-only: the rename-vs-spawn race it
        # arbitrates opens and closes within one App lifetime, and forgetting
        # it degrades to the safe side (keep the carried-over name).
        self._stub_name_intent: set[str] = set()

    def project_dir(self, workspace_path: str) -> Path:
        return Path(workspace_path) / PROJECT_DIR_NAME

    def project_file(self, workspace_path: str) -> Path:
        """Where the project document lives now: the workspace database."""
        return self.project_dir(workspace_path) / DB_FILENAME

    def _legacy_file(self, workspace_path: str) -> Path:
        return self.project_dir(workspace_path) / PROJECT_FILE

    def log_file(self, workspace_path: str, log_file_name: str = "") -> Path:
        """Return the log file path for this workspace.

        If log_file_name is given (from project.log_file_name), use that.
        Falls back to a generic 'pipeline.log' for events outside a run.
        """
        name = log_file_name or "pipeline.log"
        return self.project_dir(workspace_path) / name

    def _ensure_dir(self, workspace_path: str) -> Path:
        return ensure_workspace_data_dir(workspace_path)

    def _parse_legacy(self, text: str) -> Any:
        if len(text.encode("utf-8")) > _LEGACY_MAX_BYTES:
            raise ValueError("project.json exceeds size limit")
        return json.loads(text)

    def _import_legacy(self, workspace_path: str) -> None:
        """One-time import of the legacy project.json into the workspace db."""
        db = self._databases.get(workspace_path)
        if db is None:
            return
        source = self._legacy_file(workspace_path)

        def load(cur: Any, data: Any) -> None:
            if isinstance(data, dict):
                # kv_set joins the surrounding import transaction (reentrant).
                db.kv_set(_KV_KEY, data, now=int(time.time()))
            else:
                # Raising rolls the import back (no marker, file kept), so
                # fail-closed readers (storage_service) keep reporting the
                # malformed file unreadable instead of seeing an empty store.
                raise ValueError("legacy project.json is not an object")

        def merge(cur: Any, data: Any) -> None:
            # Legacy-writer coexistence: an older app version regenerated
            # project.json after the import. The project document cannot be
            # merged field-by-field, so this is last-writer-wins at document
            # granularity: the regenerated file replaces the kv document only
            # when its mtime is newer than the kv row's updated_at.
            if not isinstance(data, dict):
                log.warning(
                    "regenerated project.json for %s is not an object; ignored",
                    workspace_path,
                )
                return
            try:
                mtime = source.stat().st_mtime
            except OSError:
                return
            stamp = db.kv_updated_at(_KV_KEY)
            if stamp is None or mtime > stamp:
                db.kv_set(_KV_KEY, data, now=int(time.time()))

        try:
            db.import_json(
                _KV_KEY, source, load, parse=self._parse_legacy, merge=merge
            )
        except ValueError as err:
            # Malformed shape: the import rolled back and will retry on the
            # next access; the file stays in place for inspection.
            log.warning(
                "legacy project.json for %s not imported: %s", workspace_path, err
            )

    def _read_doc(self, workspace_path: str) -> dict[str, Any] | None:
        """The stored project document after the one-time legacy import."""
        db = self._databases.get(workspace_path)
        if db is None:
            return None
        self._import_legacy(workspace_path)
        doc = db.kv_get(_KV_KEY)
        return doc if isinstance(doc, dict) else None

    def peek(self, workspace_path: str) -> Project | None:
        """Return the existing project for this workspace WITHOUT creating one.

        Returns None when:
          - the workspace path is empty / does not exist
          - neither the workspace db nor a legacy project.json is present
          - the stored document is corrupt (we don't auto-recreate during peek
            so the user isn't surprised by hidden file writes from typing in
            the workspace input)

        Peek stays write-free: when only the legacy project.json exists it is
        read directly and the import is left to the first mutating access.
        """
        if not workspace_path:
            return None
        ws = os.path.abspath(workspace_path)
        if not os.path.isdir(ws):
            return None
        db = self._databases.peek(ws)
        if db is not None:
            self._import_legacy(ws)
            data = db.kv_get(_KV_KEY)
        else:
            pf = self._legacy_file(ws)
            if not pf.exists():
                return None
            try:
                data = self._parse_legacy(pf.read_text(encoding="utf-8"))
            except (OSError, ValueError) as err:
                log.warning("project.json at %s is corrupt during peek (%s)", pf, err)
                return None
        if not isinstance(data, dict):
            # The two corrupt-document branches below say so; this one used to
            # return empty-handed in silence, which reads downstream as "that
            # workspace has no panes" rather than "its record is unreadable".
            if data is not None:
                log.warning("project document for %s is not an object during peek", ws)
            return None
        try:
            project = Project.from_dict(data)
            project.workspace_path = ws
            return project
        except Exception as err:  # noqa: BLE001
            log.warning("project document for %s is corrupt during peek (%s)", ws, err)
            return None

    def _quarantine_corrupt_doc(
        self, ws: str, data: dict[str, Any], err: Exception
    ) -> None:
        """Keep an unreadable document before a fresh one takes its place.

        Recreating is what keeps the workspace usable, but the document being
        replaced holds every pane record for it, so overwriting in place made
        the only copy of them unrecoverable. Keyed by time: a second failure
        must not land on the first one's key and drop it. Never raises —
        failing to keep the copy must not also cost the caller its recovery.
        """
        try:
            db = self._databases.get(ws)
            if db is None:
                return
            base = f"{_KV_KEY}.corrupt-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}"
            # The stamp only resolves to the second, and a retry loop can fail
            # twice inside one — suffix rather than drop the earlier copy.
            key, n = base, 2
            while db.kv_get(key) is not None:
                key, n = f"{base}-{n}", n + 1
            db.kv_set(
                key,
                {"error": str(err), "quarantined_at": _now_iso(), "document": data},
                now=int(time.time()),
            )
            log.warning("kept the corrupt project document for %s at kv key %s", ws, key)
        except Exception:  # noqa: BLE001
            log.exception("could not keep the corrupt project document for %s", ws)

    def load_or_create(
        self, workspace_path: str, *, name: str = "", backend_version: str = ""
    ) -> Project:
        ws = os.path.abspath(workspace_path)
        if not os.path.isdir(ws):
            raise FileNotFoundError(f"workspace does not exist: {ws}")
        data = self._read_doc(ws)
        if data is not None:
            try:
                project = Project.from_dict(data)
                # Keep workspace_path canonical in case the user moved the folder.
                project.workspace_path = ws
                return project
            except Exception as err:  # noqa: BLE001
                log.warning("project document for %s is corrupt (%s); recreating", ws, err)
                self._quarantine_corrupt_doc(ws, data, err)

        now = _now_iso()
        project = Project(
            id=_project_id_for(ws),
            name=name or Path(ws).name,
            workspace_path=ws,
            created_at=now,
            updated_at=now,
            backend_version=backend_version,
        )
        self.save(project)
        self.append_event(
            ws,
            {
                "event": "project_created",
                "project_id": project.id,
                "name": project.name,
            },
        )
        return project

    def save(self, project: Project) -> Path:
        with self._save_lock:
            project.updated_at = _now_iso()
            pf = self.project_file(project.workspace_path)
            db = self._databases.get(project.workspace_path)
            if db is None:
                # The data dir may have vanished mid-session; recreate it
                # (the old file store's _ensure_dir behavior) and retry.
                ensure_workspace_data_dir(project.workspace_path)
                db = self._databases.get(project.workspace_path)
            if db is None:
                raise OSError(
                    f"cannot save project: workspace "
                    f"{project.workspace_path} is not a directory"
                )
            # Import first so a later first-read import cannot clobber this save.
            self._import_legacy(project.workspace_path)
            db.kv_set(_KV_KEY, project.to_dict(), now=int(time.time()))
            return pf

    def append_event(
        self, workspace_path: str, event: dict[str, Any], log_file_name: str = ""
    ) -> Path:
        ws = os.path.abspath(workspace_path)
        self._ensure_dir(ws)
        lf = self.log_file(ws, log_file_name)
        # Auto-create the run sub-folder (e.g. runs/20260528-020041-task/)
        lf.parent.mkdir(parents=True, exist_ok=True)
        line = f"[{_now_iso()}] {json.dumps(event, ensure_ascii=False)}\n"
        with open(lf, "a", encoding="utf-8") as f:
            f.write(line)
        return lf

    # -------- Pipeline-specific high-level ops --------

    def start_pipeline(
        self,
        workspace_path: str,
        *,
        task_description: str,
        total_stages: int,
        stage_blueprint: list[dict[str, Any]],
        backend_version: str = "",
        pipeline_id: str = "",
        start_index: int = 0,
    ) -> Project:
        """start_index > 0 is a restart-from-node run: the stages before it
        are not run again (their last output is reused) and are recorded as
        completed, so a later resume does not walk back into them."""
        project = self.load_or_create(workspace_path, backend_version=backend_version)
        project.task_description = task_description
        project.total_stages = total_stages
        if pipeline_id:
            project.pipeline_id = pipeline_id
        project.state = "running"
        project.current_stage_index = -1  # spawn_stage will bump to 0
        project.stages = [
            StageRecord(
                stage_id=s["stage_id"],
                title=s.get("title", ""),
                slots=[
                    SlotRecord(
                        label=sl.get("label", ""),
                        agent=sl.get("agent", ""),
                        role=sl.get("role", ""),
                    )
                    for sl in s.get("slots", [])
                ],
            )
            for s in stage_blueprint
        ]
        for skipped in project.stages[: max(0, start_index)]:
            skipped.status = "completed"
        # Clear stale pipeline panes from previous runs; preserve manual panes.
        project.panes = [p for p in project.panes if p.origin != "pipeline"]
        project.node_states = {}
        project.node_gate = {}
        # Each pipeline run gets its own log file.
        project.log_file_name = _make_log_filename(task_description)
        self.save(project)
        self.append_event(
            workspace_path,
            {
                "event": "pipeline_start",
                "project_id": project.id,
                "task": task_description,
                "total_stages": total_stages,
                "log_file": project.log_file_name,
            },
            log_file_name=project.log_file_name,
        )
        return project

    def record_stage_spawn(
        self,
        workspace_path: str,
        *,
        stage_index: int,
        pane_id: str,
        agent: str,
        role: str,
    ) -> Project:
        project = self.load_or_create(workspace_path)
        if stage_index < 0 or stage_index >= len(project.stages):
            raise IndexError(f"stage_index {stage_index} out of range")
        # mark previous stage completed (if any) before bumping pointer
        if 0 <= project.current_stage_index < len(project.stages):
            prev = project.stages[project.current_stage_index]
            if prev.status == "running":
                prev.status = "completed"
                prev.ended_at = _now_iso()
        stage = project.stages[stage_index]
        stage.status = "running"
        stage.started_at = _now_iso()
        stage.pane_id = pane_id
        if agent:
            stage.agent = agent
        if role:
            stage.role = role
        project.current_stage_index = stage_index
        project.agents_spawned += 1
        self.save(project)
        self.append_event(
            workspace_path,
            {
                "event": "stage_spawn",
                "stage_index": stage_index,
                "stage_id": stage.stage_id,
                "agent": stage.agent,
                "role": stage.role,
                "pane_id": pane_id,
            },
            log_file_name=project.log_file_name,
        )
        return project

    def _adopt_pending_stub(self, project: "Project", pane: "PaneRecord", pane_id: str) -> None:
        """Fold a pre-spawn stub into the record that survives a spawn/re-key.

        rename_pane(), set_pane_auto_name() and record_manual_pane_session()
        each upsert a pending stub when their write arrives before the spawn
        (or before a restart re-keys the previous record onto the new pane_id).
        Without this fold the stub duplicates the pane_id: lookups and restore
        hit the re-keyed record first, so the user's name silently disappears.

        custom_name transfers only when a rename actually created/touched the
        stub (_stub_name_intent) — then it is the user's latest intent and wins
        even as "" (an explicit reset). A stub raised by a session or auto-name
        write has an empty custom_name that means "never named", so copying it
        would erase the name a re-key just carried over. auto_name and
        session_id transfer when non-empty; the caller applies the spawn's own
        session id right after, and a spawn that carries one is the more
        authoritative writer.
        """
        for stub in [p for p in project.panes
                     if p is not pane and p.pane_id == pane_id and p.spawn_status == "pending"]:
            if pane_id in self._stub_name_intent: pane.custom_name = stub.custom_name
            # The lock is one-way, so OR it in rather than transferring it: a
            # rename that raised the stub locked the pane even when its
            # custom_name is "" (an explicit reset), and a re-keyed record that
            # was already locked must not be unlocked by an unrelated stub.
            pane.name_locked = pane.name_locked or stub.name_locked
            if stub.auto_name:
                pane.auto_name = stub.auto_name
                # Carry the source with the name, or a heuristic stub would look
                # like an llm one and block the upgrade that is still in flight.
                pane.auto_name_source = stub.auto_name_source
            if stub.session_id: pane.session_id = stub.session_id
            project.panes.remove(stub)
        self._stub_name_intent.discard(pane_id)

    def _find_slot_pane(self, project: "Project", stage_index: int, slot_label: str) -> "PaneRecord | None":
        return next(
            (p for p in project.panes
             if p.origin == "pipeline" and p.stage_index == stage_index and p.slot_label == slot_label),
            None,
        )

    def record_slot_spawn(
        self,
        workspace_path: str,
        *,
        stage_index: int,
        slot_label: str,
        pane_id: str,
        agent: str = "",
        role: str = "",
        session_id: str = "",
        session_home_id: str = "",
        profile_id: str = "",
        run_group_id: str = "",
    ) -> Project:
        project = self.load_or_create(workspace_path)
        if stage_index < 0 or stage_index >= len(project.stages):
            raise IndexError(f"stage_index {stage_index} out of range")
        stage = project.stages[stage_index]
        pane = self._find_slot_pane(project, stage_index, slot_label)
        if pane is None:
            pane = PaneRecord(pane_id=pane_id, origin="pipeline",
                              stage_id=stage.stage_id, stage_index=stage_index, slot_label=slot_label)
            project.panes.append(pane)
        self._adopt_pending_stub(project, pane, pane_id)
        # Same re-key as the manual path: a pipeline pane has no parent of its
        # own, but it can be one — an MCP spawn from inside it produces children
        # whose spawned_by points here.
        if pane.pane_id != pane_id:
            self._rekey_spawned_by(project, pane.pane_id, pane_id)
        pane.pane_id = pane_id
        pane.spawn_status = "spawned"
        if not pane.spawned_at: pane.spawned_at = _now_iso()
        if agent: pane.agent = agent
        if role: pane.role = role
        # Claude pins its session id at spawn; Codex/Gemini use record_slot_session() later.
        if session_id: pane.session_id = session_id
        if session_home_id: pane.session_home_id = session_home_id
        if profile_id: pane.profile_id = profile_id
        if run_group_id: pane.run_group_id = run_group_id
        self.save(project)
        return project

    def record_slot_session(
        self,
        workspace_path: str,
        *,
        stage_index: int,
        slot_label: str,
        session_id: str,
    ) -> Project:
        """Persist the CLI session id for a slot so it can be resumed on restart."""
        project = self.load_or_create(workspace_path)
        pane = self._find_slot_pane(project, stage_index, slot_label)
        if pane:
            pane.session_id = session_id
            self.save(project)
        return project

    def record_slot_unspawn(
        self,
        workspace_path: str,
        *,
        stage_index: int,
        slot_label: str,
    ) -> Project:
        """Mark a pipeline slot as manually removed so it is not auto-restored."""
        project = self.load_or_create(workspace_path)
        if stage_index < 0 or stage_index >= len(project.stages):
            raise IndexError(f"stage_index {stage_index} out of range")
        stage = project.stages[stage_index]
        pane = self._find_slot_pane(project, stage_index, slot_label)
        if pane is None:
            return project
        self._adopt_orphans(project, pane)
        pane.spawn_status = "removed"
        pane.removed_at = _now_iso()
        pane.kickoff_status = "none"
        self.save(project)
        self.append_event(
            workspace_path,
            {"event": "slot_unspawn", "stage_index": stage_index,
             "stage_id": stage.stage_id, "slot_label": slot_label},
            log_file_name=project.log_file_name,
        )
        return project

    @staticmethod
    def _rekey_spawned_by(project: "Project", old_id: str, new_id: str) -> None:
        """Point every child of `old_id` at `new_id`.

        Called whenever a record's pane_id is rewritten (restore / rebuild).
        Self-references are dropped rather than kept: a record that ends up its
        own parent would make the lineage walk loop forever.
        """
        if not old_id or old_id == new_id:
            return
        for child in project.panes:
            if child.spawned_by == old_id:
                child.spawned_by = "" if child.pane_id == new_id else new_id

    @staticmethod
    def _adopt_orphans(project: "Project", dying: "PaneRecord") -> None:
        """Re-parent a closing pane's children onto its own parent.

        Keeping partial lineage beats dropping it: the children of a closed
        middle node stay related to the grandparent instead of all becoming
        roots. When the dying pane was itself a root the children become roots
        too, which is the same outcome.

        This must run in the same save() as the spawn_status change, and it
        must run here rather than in the renderer: the frontend's panes list
        only holds the panes of ONE window, so a detached window's children —
        or another run group's — would be missed entirely.
        """
        grandparent = dying.spawned_by
        for child in project.panes:
            if child.spawned_by != dying.pane_id:
                continue
            if not grandparent or grandparent == child.pane_id:
                child.spawned_by = ""
                continue
            child.spawned_by = "" if ProjectStore._would_cycle(
                project, child.pane_id, grandparent, skip=dying.pane_id
            ) else grandparent

    @staticmethod
    def _would_cycle(
        project: "Project", pane_id: str, parent_id: str, *, skip: str = ""
    ) -> bool:
        """True if making `parent_id` the parent of `pane_id` closes a loop.

        Walks up from the proposed parent. `skip` is the pane being removed —
        it is about to leave, so links through it do not count. The visited set
        also stops a pre-existing cycle from spinning here forever.
        """
        by_id = {p.pane_id: p for p in project.panes}
        seen = {pane_id}
        cur = parent_id
        while cur and cur != skip:
            if cur in seen:
                return True
            seen.add(cur)
            nxt = by_id.get(cur)
            cur = nxt.spawned_by if nxt else ""
        return False

    def _find_manual_pane(
        self, project: "Project", pane_id: str, previous_pane_id: str = "", session_id: str = ""
    ) -> "PaneRecord | None":
        # Exact pane_id / previous_pane_id matches take priority over the
        # session fallback — a flat OR would let an earlier record matching
        # only by session shadow a later exact match and hijack its identity.
        # The session fallback itself is a last resort for rebuild hops
        # (previous_pane_id set) whose chain broke because racing spawns
        # crossed; it must NOT apply to plain spawns, where the user may
        # legitimately open a second pane resuming the session of a live one.
        # A pending stub (rename/session upsert) shares the new pane_id but
        # carries no history, so it must NOT outrank the previous record a
        # re-key is moving onto that id — otherwise the old record survives as
        # a spawned ghost that restore resurrects. Match the real record first;
        # _adopt_pending_stub then folds the stub into it.
        manual = [p for p in project.panes if p.origin != "pipeline"]
        for match in (
            lambda p: p.pane_id == pane_id and p.spawn_status != "pending",
            lambda p: bool(previous_pane_id) and p.pane_id == previous_pane_id,
            lambda p: p.pane_id == pane_id,
            lambda p: bool(previous_pane_id) and bool(session_id) and p.session_id == session_id,
        ):
            found = next((p for p in manual if match(p)), None)
            if found is not None:
                return found
        return None

    def record_manual_pane_spawn(
        self,
        workspace_path: str,
        *,
        pane_id: str,
        previous_pane_id: str = "",
        agent: str = "",
        role: str = "",
        command: str = "",
        model: str = "",
        effort: str = "",
        session_id: str = "",
        session_home_id: str = "",
        profile_id: str = "",
        run_group_id: str = "",
        output_log_file: str = "",
        origin: str = "",
        spawned_by: str = "",
        surface: str = "",
        window_kind: str = "",
    ) -> Project:
        project = self.load_or_create(workspace_path)
        pane = self._find_manual_pane(project, pane_id, previous_pane_id, session_id)
        # "main" is a window pane's surface too (unmarked is every older record).
        if surface and pane is not None and pane.surface in ("", "main"):
            # A panel's spawn (it reaches here from terminal.create, which a
            # plugin window's broker can send) naming a window pane's record:
            # leave that record alone. Taking it over would mark it a panel's,
            # and the main window would stop restoring the pane.
            return project
        if surface and any(p.pane_id == pane_id and p.surface in ("", "main") for p in project.panes):
            # Any other record under this id is not a panel's either — a
            # pipeline pane (which _find_manual_pane skips) or a window pane's
            # pending stub. Adding a second record beside it, or folding the
            # stub into the panel's, would corrupt that pane's restore.
            return project
        if pane is None:
            pane = PaneRecord(pane_id=pane_id, origin=origin or "manual")
            project.panes.append(pane)
        self._adopt_pending_stub(project, pane, pane_id)
        # pane_id is regenerated on every restart and re-linked via
        # previous_pane_id. Any child still pointing spawned_by at this
        # record's OLD id becomes a dead pointer the instant we overwrite it,
        # so rewrite the children first — in this same save(), never as a
        # follow-up RPC. A stale lineage is worse than no lineage: spawn-depth
        # checks read it and would mis-count.
        if pane.pane_id != pane_id:
            self._rekey_spawned_by(project, pane.pane_id, pane_id)
        pane.pane_id = pane_id
        pane.agent = agent
        pane.role = role
        pane.command = command
        pane.spawn_status = "spawned"
        # Set once: the rebuild path re-spawns an existing record, and the pane
        # the user is looking at started at the ORIGINAL time, not this hop.
        if not pane.spawned_at: pane.spawned_at = _now_iso()
        if session_id: pane.session_id = session_id
        if session_home_id: pane.session_home_id = session_home_id
        if profile_id: pane.profile_id = profile_id
        # Guarded like origin below: the rebuild path re-spawns with an empty
        # model/effort, and an unconditional write would erase the pick the
        # user made before the restart.
        if model: pane.model = model
        if effort: pane.effort = effort
        if run_group_id: pane.run_group_id = run_group_id
        if output_log_file: pane.output_log_file = output_log_file
        # Guarded like the fields above: an omitted origin must not blank an
        # existing record back to "manual" (that would strip the mcp marker).
        if origin: pane.origin = origin
        if spawned_by: pane.spawned_by = spawned_by
        # Only a dock's spawn passes these; a main-window spawn leaves them
        # empty and the record exactly as before.
        if surface: pane.surface = surface
        if window_kind: pane.window_kind = window_kind
        # A rebuild hop owns its session: retire any OTHER spawned manual
        # record sharing it (legacy duplicate accumulation) so restore cannot
        # resurrect a ghost pane. Gated on previous_pane_id for the same
        # reason as the lookup fallback — plain spawns may share a session
        # with a live pane on purpose.
        if previous_pane_id and session_id:
            for other in project.panes:
                if (other is not pane and other.origin != "pipeline"
                        and other.session_id == session_id
                        and other.spawn_status == "spawned"):
                    other.spawn_status = "removed"
                    other.removed_at = _now_iso()
        self.save(project)
        self.append_event(
            workspace_path,
            {"event": "manual_pane_spawn", "pane_id": pane_id, "agent": agent, "role": role},
            log_file_name=project.log_file_name,
        )
        return project

    def record_pane_unspawn_by_id(
        self,
        workspace_path: str,
        *,
        pane_id: str,
    ) -> tuple["Project", bool]:
        """Retire any pane record by its own id, pipeline slots included.

        record_manual_pane_unspawn refuses pipeline records on purpose, so that
        closing one manual pane can never retire a slot. Closing the whole
        workspace does take the slots with it, and the pane id is the only key
        that cannot drift on the way: a slot is otherwise addressed by
        (stage_index, slot_label), a pair the renderer has to resolve against
        whichever pipeline its window happens to be showing — which is not
        necessarily the one this workspace ran.

        Returns the project and whether a record was actually retired.
        """
        project = self.load_or_create(workspace_path)
        matches = [
            p for p in project.panes
            if p.pane_id == pane_id and p.spawn_status != "removed"
        ]
        if not matches:
            return project, False
        for pane in matches:
            self._adopt_orphans(project, pane)
            pane.spawn_status = "removed"
            pane.removed_at = _now_iso()
            pane.kickoff_status = "none"
        self.save(project)
        self.append_event(
            workspace_path,
            {"event": "pane_unspawn_by_id", "pane_id": pane_id, "count": len(matches)},
            log_file_name=project.log_file_name,
        )
        return project, True

    def record_manual_pane_unspawn(
        self,
        workspace_path: str,
        *,
        pane_id: str,
        session_id: str = "",
    ) -> tuple[Project, list[str]]:
        """Mark a manual pane removed so it isn't re-spawned on the next restart.

        Matches by pane_id, falling back to session_id only when no live record
        carries that pane_id. The pane_id is regenerated on each restart and
        re-linked via previous_pane_id; if that link ever drifts, a stale
        'spawned' record would otherwise be orphaned (un-removable from the UI)
        and resurrect on every launch. session_id is stable across restarts, so
        it recovers that case — and clears any duplicate sharing that session.

        The fallback is never a parallel OR, for the same reason it is gated in
        _find_manual_pane: a plain spawn may deliberately resume the session of
        a pane that is still live, and closing one must not retire the other.

        Returns the project and the ids of the records actually marked removed,
        so the caller can take down every PTY that just lost its record.
        """
        project = self.load_or_create(workspace_path)
        sid = session_id.strip()
        live = [
            p for p in project.panes
            if p.origin != "pipeline" and p.spawn_status != "removed"
        ]
        matches = [p for p in live if p.pane_id == pane_id]
        if not matches and sid:
            matches = [p for p in live if p.session_id == sid]
        if not matches:
            return project, []
        for pane in matches:
            self._adopt_orphans(project, pane)
            pane.spawn_status = "removed"
            pane.removed_at = _now_iso()
        self.save(project)
        self.append_event(
            workspace_path,
            {"event": "manual_pane_unspawn", "pane_id": pane_id, "count": len(matches)},
            log_file_name=project.log_file_name,
        )
        return project, [p.pane_id for p in matches]

    def rename_pane(
        self,
        workspace_path: str,
        *,
        pane_id: str,
        custom_name: str,
    ) -> Project | None:
        """Persist a user-set display name for a pane (any origin), keyed by pane_id.

        Empty custom_name resets to the default label. Returns None when no project
        exists for the workspace.

        Upsert: a rename can race manual_pane.spawn — the PaneRecord may not exist
        yet. Rather than silently dropping the name, create a pending stub keyed by
        pane_id; the later spawn finds it via _find_manual_pane and fills in the
        remaining fields without touching custom_name. An unspawned stub stays
        'pending' and is skipped by restore, so it can't resurrect an empty pane.
        """
        project = self.peek(workspace_path)
        if project is None:
            return None
        pane = next((p for p in project.panes if p.pane_id == pane_id), None)
        if pane is None:
            pane = PaneRecord(pane_id=pane_id, origin="manual")
            project.panes.append(pane)
        if pane.spawn_status == "pending":
            self._stub_name_intent.add(pane_id)
        pane.custom_name = custom_name
        # Naming a pane — including clearing the name — is the user taking
        # ownership of the title, so no auto-namer writes to this record again.
        # A name already stored in auto_name keeps showing (clearing custom_name
        # falls back to it); the lock stops NEW auto-names, it doesn't rewrite
        # the display chain.
        pane.name_locked = True
        # Keep the renderer-owned history mirror consistent at the source:
        # detached windows never persist it themselves and the renderer's
        # debounced snapshot can be lost on quit, so patch it here too.
        for entry in project.ui_spawn_history or []:
            if isinstance(entry, dict) and entry.get("paneId") == pane_id:
                if custom_name:
                    entry["customName"] = custom_name
                else:
                    entry.pop("customName", None)
        self.save(project)
        return project

    def set_pane_auto_name(
        self,
        workspace_path: str,
        *,
        pane_id: str,
        auto_name: str,
        source: str = "heuristic",
    ) -> tuple[Project | None, bool]:
        """Persist an auto-generated display name for a pane, keyed by pane_id.

        This is the final arbiter for the cross-window race. A name is written
        at most twice, and only ever in one direction:

        * a name_locked record is never touched — the user named this pane once,
          so it stays theirs even if they later cleared the name;
        * custom_name always wins — a record carrying one is never touched;
        * an ``llm`` name may replace an existing ``heuristic`` name once, since
          the renderer titles a pane instantly from its string heuristic and
          only then asks the model for a better one;
        * anything else is set-once (first writer wins), so a pane is never
          renamed again turn after turn.

        An empty auto_name is a no-op. Returns (project, changed); project is
        None when no project exists for the workspace.

        Upsert mirrors rename_pane(): the name can arrive before the spawn
        persists the PaneRecord, so create a pending stub keyed by pane_id.
        Like rename_pane(), an accepted write also patches the spawn-history
        mirror (under its own autoName key) so the name survives pane removal.
        """
        project = self.peek(workspace_path)
        if project is None:
            return None, False
        if not auto_name:
            return project, False
        pane = next((p for p in project.panes if p.pane_id == pane_id), None)
        if pane is not None and (pane.custom_name or pane.name_locked):
            return project, False
        if pane is not None and pane.auto_name:
            # The one permitted second write: the model's answer replacing the
            # heuristic placeholder. Two llm writes racing still resolve
            # first-wins, so the name settles.
            upgrading = source == "llm" and pane.auto_name_source != "llm"
            if not upgrading:
                return project, False
        if pane is None:
            pane = PaneRecord(pane_id=pane_id, origin="manual")
            project.panes.append(pane)
        pane.auto_name = auto_name
        pane.auto_name_source = source
        # Keep the renderer-owned history mirror consistent at the source (same
        # reasoning as rename_pane), but under a separate key: customName is the
        # user's name and must never be overwritten by an auto-derived one.
        for entry in project.ui_spawn_history or []:
            if isinstance(entry, dict) and entry.get("paneId") == pane_id:
                entry["autoName"] = auto_name
        self.save(project)
        return project, True

    def rename_history_entry(
        self,
        workspace_path: str,
        *,
        pane_id: str,
        custom_name: str,
    ) -> Project | None:
        """Patch only the ui_spawn_history mirror's customName for pane_id.

        The history-side companion of rename_pane() for entries whose pane no
        longer exists — it never creates a pane record. Empty custom_name
        resets to the default label. Returns None when no project exists or
        the mirror has no matching entry (nothing was saved).
        """
        project = self.peek(workspace_path)
        if project is None:
            return None
        changed = False
        for entry in project.ui_spawn_history or []:
            if isinstance(entry, dict) and entry.get("paneId") == pane_id:
                if custom_name:
                    entry["customName"] = custom_name
                else:
                    entry.pop("customName", None)
                changed = True
        if not changed:
            return None
        self.save(project)
        return project

    def star_history_entry(
        self,
        workspace_path: str,
        *,
        pane_id: str,
        starred: bool,
    ) -> Project | None:
        """Patch only the ui_spawn_history mirror's starred flag for pane_id.

        The star-side companion of rename_history_entry(): it never creates
        a pane record. Unstarring removes the key instead of writing False.
        Returns None when no project exists or the mirror has no matching
        entry (nothing was saved).
        """
        project = self.peek(workspace_path)
        if project is None:
            return None
        changed = False
        for entry in project.ui_spawn_history or []:
            if isinstance(entry, dict) and entry.get("paneId") == pane_id:
                if starred:
                    entry["starred"] = True
                else:
                    entry.pop("starred", None)
                changed = True
        if not changed:
            return None
        self.save(project)
        return project

    def record_detected_session(
        self, workspace_path: str, *, pane_id: str, session_id: str,
    ) -> Project:
        """Persist log discovery even when no renderer receives the event."""
        with self._save_lock:
            project = self.load_or_create(workspace_path)
            pane = next((p for p in project.panes if p.pane_id == pane_id), None)
            if pane is None:
                # Both manual and pipeline spawns adopt this pending stub.
                pane = PaneRecord(pane_id=pane_id, origin="manual")
                project.panes.append(pane)
            pane.session_id = session_id
            for entry in project.ui_spawn_history or []:
                if entry.get("paneId") == pane_id:
                    entry["sessionId"] = session_id
            self.save(project)
            return project

    def record_manual_pane_session(
        self,
        workspace_path: str,
        *,
        pane_id: str,
        session_id: str,
    ) -> Project:
        """Persist the session id a pane's CLI is writing, keyed by pane_id.

        Upsert, mirroring rename_pane(): session detection can beat
        manual_pane.spawn to the backend — every vendor's binding funnels into
        one session.detected event whose persist path is shorter than the
        spawn's await chain, and a busy event loop widens the gap. Rather than
        dropping the id, create a pending stub keyed by pane_id; the later
        spawn finds it via _find_manual_pane and fills in the remaining fields.
        An unspawned stub stays 'pending' and is skipped by restore, so it
        can't resurrect an empty pane. Clearing (empty session_id) never
        creates a stub — there is nothing to preserve.
        """
        project = self.load_or_create(workspace_path)
        pane = self._find_manual_pane(project, pane_id)
        if pane is None:
            if not session_id:
                return project
            pane = PaneRecord(pane_id=pane_id, origin="manual")
            project.panes.append(pane)
        pane.session_id = session_id
        self.save(project)
        return project

    def reconnect_pane_session(
        self,
        workspace_path: str,
        *,
        pane_id: str,
        session_id: str,
    ) -> Project:
        """Point a single pane at a chosen transcript's session id.

        Deterministic reconnect for a ghost pane (its own id has no transcript):
        under the save lock, rewrite ONLY the matching pane's session_id and
        save — the same write shape as record_manual_pane_session. Raises
        KeyError when pane_id is unknown. Never touches any other pane.
        """
        with self._save_lock:
            project = self.load_or_create(workspace_path)
            pane = next((p for p in project.panes if p.pane_id == pane_id), None)
            if pane is None:
                raise KeyError(f"pane {pane_id!r} not found in project {project.id}")
            pane.session_id = session_id
            self.save(project)
            return project

    def set_pane_run_group(
        self,
        workspace_path: str,
        *,
        pane_id: str,
        run_group_id: str,
    ) -> Project | None:
        """Reassign a pane (pipeline or manual) to a run group / tab.

        Looks up by pane_id across all panes regardless of origin. An empty
        run_group_id is allowed (moves the pane to the ungrouped/手動 tab).

        Returns None when no record matches pane_id. Returning the project
        made a miss indistinguishable from a write that landed, and the
        frontend reads that as success: it drops the pane's group id in memory
        while the record on disk keeps it, so the assignment comes back on the
        next restore and the pane lands on a tab that no longer matches.
        """
        project = self.load_or_create(workspace_path)
        pane = next((p for p in project.panes if p.pane_id == pane_id), None)
        if pane is None:
            return None
        pane.run_group_id = run_group_id
        self.save(project)
        return project

    def set_pane_parent(
        self,
        workspace_path: str,
        *,
        pane_id: str,
        spawned_by: str,
    ) -> "Project | str":
        """Re-parent a pane: make `spawned_by` its parent, or "" to make it a
        root. The other half of the lineage next to set_pane_run_group.

        Returns the project on success, or a short reason string on refusal —
        a string rather than None because the three refusals need telling
        apart by the caller: `not_found` (no such pane), `parent_not_found`
        (the proposed parent is not in this workspace), `cycle` (the parent
        is the pane itself or one of its descendants — the tree would loop,
        and the sidebar's lineage walk would spin). A pane cannot be its own
        parent for the same reason.
        """
        project = self.load_or_create(workspace_path)
        pane = next((p for p in project.panes if p.pane_id == pane_id), None)
        if pane is None:
            return "not_found"
        if spawned_by:
            if spawned_by == pane_id:
                return "cycle"
            if not any(p.pane_id == spawned_by for p in project.panes):
                return "parent_not_found"
            if ProjectStore._would_cycle(project, pane_id, spawned_by):
                return "cycle"
        pane.spawned_by = spawned_by
        self.save(project)
        return project

    def set_pane_stopped(
        self,
        workspace_path: str,
        *,
        pane_id: str,
        stopped: bool,
    ) -> Project:
        """Set/clear a pane's STOP badge flag (persisted). No-op if pane not found."""
        project = self.load_or_create(workspace_path)
        pane = next((p for p in project.panes if p.pane_id == pane_id), None)
        if pane is None:
            return project
        pane.stopped = stopped
        self.save(project)
        return project

    def set_pane_minimized(
        self,
        workspace_path: str,
        *,
        pane_id: str,
        is_minimized: bool,
    ) -> Project:
        """Persist the collapsed-to-sidebar state. No-op if pane not found."""
        project = self.load_or_create(workspace_path)
        pane = next((p for p in project.panes if p.pane_id == pane_id), None)
        if pane is None:
            return project
        pane.is_minimized = is_minimized
        self.save(project)
        return project

    def set_pane_muted(
        self,
        workspace_path: str,
        *,
        pane_id: str,
        is_muted: bool,
    ) -> Project:
        """Persist the per-pane mute. No-op if pane not found."""
        project = self.load_or_create(workspace_path)
        pane = next((p for p in project.panes if p.pane_id == pane_id), None)
        if pane is None:
            return project
        pane.is_muted = is_muted
        self.save(project)
        return project

    PANE_TURN_STATES = ("working", "idle")

    def set_pane_resume_state(
        self,
        workspace_path: str,
        *,
        pane_id: str,
        last_turn_state: str | None = None,
        report_to: str | None = None,
        report_pending: bool | None = None,
    ) -> Project:
        """Persist what a pane was doing and the report it owes its parent.

        Only the fields passed are written. The renderer reports on every turn
        transition, so an unchanged write skips the save rather than rewriting
        the project on each one. An unknown turn state is ignored. No-op if
        pane not found.
        """
        project = self.load_or_create(workspace_path)
        pane = next((p for p in project.panes if p.pane_id == pane_id), None)
        if pane is None:
            return project
        changed = False
        if last_turn_state in self.PANE_TURN_STATES and pane.last_turn_state != last_turn_state:
            pane.last_turn_state = last_turn_state
            changed = True
        if report_to is not None and pane.report_to != report_to:
            pane.report_to = report_to
            changed = True
        if report_pending is not None and pane.report_pending != report_pending:
            pane.report_pending = report_pending
            changed = True
        if changed:
            self.save(project)
        return project

    def set_pane_collapsed(
        self,
        workspace_path: str,
        *,
        pane_id: str,
        collapsed: bool,
    ) -> Project:
        """Persist whether this pane's lineage subtree is folded in the lists."""
        project = self.load_or_create(workspace_path)
        pane = next((p for p in project.panes if p.pane_id == pane_id), None)
        if pane is None:
            return project
        pane.collapsed = collapsed
        self.save(project)
        return project

    def set_pane_order(
        self,
        workspace_path: str,
        *,
        pane_ids: list[str],
    ) -> Project | None:
        """Reorder project.panes to match the given pane_ids order.

        Panes whose id is not in pane_ids keep their relative order and are
        appended after the listed ones (no data loss); ids without a matching
        pane are ignored. Returns None when no project exists for the
        workspace (peek semantics — never creates one).
        """
        project = self.peek(workspace_path)
        if project is None:
            return None
        rank = {pid: i for i, pid in enumerate(pane_ids)}
        listed = sorted(
            (p for p in project.panes if p.pane_id in rank),
            key=lambda p: rank[p.pane_id],
        )
        rest = [p for p in project.panes if p.pane_id not in rank]
        project.panes = listed + rest
        self.save(project)
        return project

    def set_display_name(
        self,
        workspace_path: str,
        display_name: str,
    ) -> Project | None:
        """Persist the user-set display name for this workspace.

        The value is stripped; an empty string is a legitimate write meaning
        "clear the alias and go back to basename(workspace_path)".

        Unlike the other ui-state setters this one uses load_or_create, not
        peek: renaming is an explicit action the user takes on a workspace they
        have open, so creating the project document for it is legitimate — and
        it leaves no silent no-op path that would answer the user with a
        success they did not get.

        Returns None ONLY on a real failure: an empty path, a workspace that is
        not a directory on disk, or a document that could not be written. The
        caller is expected to report that to the user.

        The alias is purely cosmetic: the workspace path stays the only
        identifier, so duplicates across workspaces are allowed and nothing
        here validates uniqueness.
        """
        if not workspace_path.strip():
            # abspath("") is the backend's cwd, which IS a directory — without
            # this guard an empty path would happily create a project document
            # somewhere nobody asked for.
            return None
        try:
            # RLock is reentrant: load_or_create may save() a fresh document.
            with self._save_lock:
                project = self.load_or_create(workspace_path)
                project.display_name = display_name.strip()
                self.save(project)
        except (OSError, ValueError) as err:
            log.warning(
                "cannot set display name for %s: %s", workspace_path, err
            )
            return None
        return project

    def set_tab_order(
        self,
        workspace_path: str,
        *,
        tab_order: list[str],
    ) -> Project | None:
        """Persist the run-group tab order (list of run-group ids).

        The run groups themselves live in the renderer; this list is an
        ordering hint applied on restore, so unknown/stale ids are harmless
        (the frontend skips ids with no matching group). Returns None when no
        project exists for the workspace (peek semantics — never creates one).
        """
        project = self.peek(workspace_path)
        if project is None:
            return None
        project.tab_order = list(tab_order)
        self.save(project)
        return project

    def set_ui_state(
        self,
        workspace_path: str,
        *,
        run_groups: list[dict[str, Any]] | None = None,
        active_tab: str | None = None,
        git_tab_repo: str | None = None,
        spawn_history: list[dict[str, Any]] | None = None,
        cli_agent_order: list[str] | None = None,
        cli_agent_disabled: list[str] | None = None,
    ) -> Project | None:
        """Persist renderer-owned per-workspace UI state (partial update).

        Only the arguments that are not None are applied. Returns None when no
        project exists for the workspace (peek semantics — never creates one).
        """
        if (
            run_groups is None
            and active_tab is None
            and git_tab_repo is None
            and spawn_history is None
            and cli_agent_order is None
            and cli_agent_disabled is None
        ):
            return None
        # Runs on a worker thread (asyncio.to_thread from ws_handlers): hold
        # the save lock across the whole read-modify-write so concurrent
        # offloaded calls cannot interleave and drop each other's fields.
        with self._save_lock:
            project = self.peek(workspace_path)
            if project is None:
                return None
            if run_groups is not None:
                project.ui_run_groups = list(run_groups)
            if active_tab is not None:
                project.ui_active_tab = active_tab
            if git_tab_repo is not None:
                project.ui_git_tab_repo = git_tab_repo
            if spawn_history is not None:
                project.ui_spawn_history = list(spawn_history)
            if cli_agent_order is not None:
                project.cli_agent_order = list(cli_agent_order)
            if cli_agent_disabled is not None:
                project.cli_agent_disabled = list(cli_agent_disabled)
            self.save(project)
            return project

    def update_slot_kickoff(
        self,
        workspace_path: str,
        *,
        stage_index: int,
        slot_label: str,
        kickoff_status: str,
    ) -> Project:
        project = self.load_or_create(workspace_path)
        pane = self._find_slot_pane(project, stage_index, slot_label)
        if pane:
            pane.kickoff_status = kickoff_status
            self.save(project)
        return project

    def record_node_states(
        self,
        workspace_path: str,
        *,
        nodes: dict[str, Any],
        gate: dict[str, Any] | None = None,
        outputs: dict[str, Any] | None = None,
    ) -> Project:
        """Merge per-node run states reported by the engine (a node absent from
        `nodes` keeps its last state). gate=None leaves the paused gate as it
        is; {} clears it. outputs merge into node_outputs."""
        project = self.load_or_create(workspace_path)
        for nid, state in nodes.items():
            if isinstance(state, dict):
                project.node_states[str(nid)] = state
        if gate is not None:
            project.node_gate = gate
        for nid, out in (outputs or {}).items():
            if isinstance(out, dict):
                project.node_outputs[str(nid)] = out
        self.save(project)
        return project

    def resume_pipeline(self, workspace_path: str) -> tuple[Project, int]:
        """Mark an existing pipeline as running again. Returns (project, next_stage_index).

        next_stage_index = -1 means "all stages already completed".
        Picks the first stage whose status is not 'completed'.
        """
        project = self.load_or_create(workspace_path)
        if not project.stages:
            raise ValueError("no pipeline to resume — start one first")

        next_idx = -1
        for i, s in enumerate(project.stages):
            if s.status != "completed":
                next_idx = i
                break

        if next_idx == -1:
            project.state = "completed"
        else:
            project.state = "running"
            project.current_stage_index = next_idx
            # Reset that stage's bookkeeping so a fresh pane records cleanly.
            stage = project.stages[next_idx]
            stage.status = "running"
            stage.started_at = _now_iso()
            stage.ended_at = None
            stage.pane_id = None

        self.save(project)
        self.append_event(
            workspace_path,
            {
                "event": "pipeline_resume",
                "project_id": project.id,
                "resume_index": next_idx,
                "total_stages": project.total_stages,
            },
            log_file_name=project.log_file_name,
        )
        return project, next_idx

    def complete_pipeline(self, workspace_path: str) -> Project:
        project = self.load_or_create(workspace_path)
        # Close any still-running stage
        if 0 <= project.current_stage_index < len(project.stages):
            cur = project.stages[project.current_stage_index]
            if cur.status == "running":
                cur.status = "completed"
                cur.ended_at = _now_iso()
        project.state = "completed"
        project.run_count += 1
        self.save(project)
        self.append_event(
            workspace_path,
            {"event": "pipeline_complete", "project_id": project.id, "run_count": project.run_count},
            log_file_name=project.log_file_name,
        )
        return project

    def abort_pipeline(self, workspace_path: str, *, reason: str = "user") -> Project:
        project = self.load_or_create(workspace_path)
        if 0 <= project.current_stage_index < len(project.stages):
            cur = project.stages[project.current_stage_index]
            if cur.status == "running":
                cur.status = "aborted"
                cur.ended_at = _now_iso()
        project.state = "aborted"
        self.save(project)
        self.append_event(
            workspace_path,
            {"event": "pipeline_abort", "reason": reason, "project_id": project.id},
            log_file_name=project.log_file_name,
        )
        return project

    def record_pane_event(
        self,
        workspace_path: str,
        *,
        event_type: str,
        pane_id: str,
        agent: str = "",
        role: str = "",
        origin: str = "manual",
        details: dict[str, Any] | None = None,
        log_file_name: str = "",
    ) -> None:
        """Lightweight event-only log entry (no project.json update)."""
        body: dict[str, Any] = {
            "event": event_type,
            "pane_id": pane_id,
            "agent": agent,
            "role": role,
            "origin": origin,
        }
        if details:
            body["details"] = details
        self.append_event(workspace_path, body, log_file_name=log_file_name)
