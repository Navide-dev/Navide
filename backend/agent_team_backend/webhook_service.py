"""From an accepted webhook request to a pipeline run, and how its panes start.

Runs on the main loop. The listener hands a request over once it has passed
the key, the size and the rate limits; everything that needs the store or a
window is checked here, each check failing closed.

Why the launch policy lives at terminal.create: the window builds a pane's
command from its own YOLO setting, on a dozen spawn, resume and restore paths,
and a custom launch command skips that code altogether. The backend sees every
one of them, so a webhook run cannot start a pane with a permission bypass
whichever path made it. Panes are remembered in the store, so a resume after a
restart is held to the same rule, and a pane a run pane opened inherits it.
"""

from __future__ import annotations

import asyncio
import datetime
import logging
import re
from collections.abc import Callable
from typing import Any, Protocol

from . import pipeline_graph, webhook_payload, webhook_triggers
from .db import Database

log = logging.getLogger(__name__)

#: Vendors with a measured Guard hook. Copilot and Qwen have one too, but its
#: ask and deny have not been tested, so they stay out until they are.
VENDORS = frozenset({"claude", "codex"})

PROBE_S = 2.0

_SHELL_SYNTAX = re.compile(r"[;&|`<>]|\$\(|\$\{")
_FIRST_TOKEN = re.compile(r"^\s*(?:'([^']*)'|\"([^\"]*)\"|(\S+))")

_DROP = {
    "claude": (
        re.compile(r"(?<!\S)--(?:allow-)?dangerously-skip-permissions(?!\S)"),
        re.compile(r"(?<!\S)--permission-mode(?:=|\s+)\S+"),
    ),
    "codex": (
        re.compile(r"(?<!\S)--(?:dangerously-bypass-approvals-and-sandbox|yolo|full-auto)(?!\S)"),
        re.compile(r"(?<!\S)(?:-a|--ask-for-approval)(?:=|\s+)\S+"),
        re.compile(r"(?<!\S)(?:-s|--sandbox)(?:=|\s+)\S+"),
        re.compile(r"(?<!\S)(?:-c|--config)(?:=|\s+)['\"]?(?:approval_policy|sandbox_mode)\s*=\S*"),
    ),
}
#: Named rather than left to the default: a CLI's default mode can change, and
#: its settings file can set a bypass the command line has to outrank.
_ASK = {
    "claude": "--permission-mode default",
    # untrusted: anything beyond plain reads asks. on-request would leave the
    # decision to the model, which is what a payload is trying to steer.
    "codex": "--ask-for-approval untrusted --sandbox workspace-write",
}


class LaunchRefused(RuntimeError):
    """A pane of a webhook run that cannot be started without a bypass."""


class Window(Protocol):
    async def probe(self, workspace: str) -> bool: ...
    async def app_lock(self, workspace: str) -> str: ...
    async def run_active(self, workspace: str) -> bool: ...
    async def start(self, workspace: str, task: str, pipeline_id: str, taint_detail: str) -> dict[str, Any]: ...


class LiveWindow:
    """The real thing: the same path a scheduled pipeline_start job takes."""

    async def probe(self, workspace: str) -> bool:
        from .mcp_server import server as mcp

        return await mcp._probe_window(workspace, PROBE_S)

    async def app_lock(self, workspace: str) -> str:
        from .mcp_server import server as mcp

        reply = await mcp._ui_request(
            workspace, "invoke", caller=mcp._Caller(kind="host"), action="ui.window.describe", args={},
        )
        result = reply.get("result") if reply.get("ok") else None
        return str(result.get("app_lock") or "") if isinstance(result, dict) else ""

    async def run_active(self, workspace: str) -> bool:
        from .mcp_server import server as mcp

        return await asyncio.to_thread(mcp._run_is_active, workspace)

    async def start(self, workspace: str, task: str, pipeline_id: str, taint_detail: str) -> dict[str, Any]:
        from .mcp_server import server as mcp

        return await mcp._start_pipeline_run(
            mcp._Caller(kind="host"), workspace, task, pipeline_id, taint_detail=taint_detail,
        )


def today() -> str:
    return datetime.date.today().isoformat()


def _seconds_to_midnight() -> int:
    now = datetime.datetime.now()
    midnight = datetime.datetime.combine(now.date() + datetime.timedelta(days=1), datetime.time.min)
    return max(1, int((midnight - now).total_seconds()))


def _rewrite(command: Any, change: Callable[[str], str]) -> Any:
    """`change` applied to the line a [shell, -lc, line] wrapper runs, or to a
    plain string."""
    if isinstance(command, list):
        return [*command[:-1], change(str(command[-1]))] if command else command
    return change(str(command or ""))


def _line(command: Any) -> str:
    return str(command[-1]) if isinstance(command, list) and command else str(command or "")


def _without_bypass(agent_key: str, line: str) -> str:
    """`line` with the vendor's bypass flags out and its ask flags right after
    the program, where a subcommand such as `codex resume` still accepts them."""
    for flag in _DROP[agent_key]:
        line = flag.sub(" ", line)
    head = _FIRST_TOKEN.match(line)
    end = head.end() if head else 0
    rest = " ".join(line[end:].split())
    return " ".join(part for part in (line[:end].strip(), _ASK[agent_key], rest) if part)


class WebhookService:
    def __init__(
        self,
        *,
        store: webhook_triggers.WebhookStore,
        db: Database,
        window: Window,
        pipeline: Callable[[str], dict[str, Any] | None],
        known_program: Callable[[str, str], bool],
    ) -> None:
        self.store, self.db, self.window = store, db, window
        self._pipeline = pipeline
        self._known_program = known_program
        self._guarded = store.run_panes()
        self._active: dict[str, dict[str, Any]] = {run["workspace"]: run for run in store.open_runs()}
        self._armed: dict[str, dict[str, Any]] = {}
        self._starting: set[str] = set()
        self._checks: dict[str, asyncio.Lock] = {}
        self._tasks: set[asyncio.Task[None]] = set()

    # ── what a pipeline may be bound to ──────────────────────────────────

    def _nodes(self, pipeline_id: str, seen: set[str]) -> list[dict[str, Any]] | None:
        """Every node the run can reach, sub-pipelines included; None when one
        of them is gone, since then nobody can say what would run."""
        record = self._pipeline(pipeline_id)
        if record is None:
            return None
        seen.add(pipeline_id)
        graph = record.get("graph")
        if not isinstance(graph, dict):
            graph = pipeline_graph.derive_graph_from_stages(record.get("stages") or [])
        nodes = list(graph.get("nodes") or [])
        for node in graph.get("nodes") or []:
            child = (node.get("subpipeline") or {}).get("pipelineId") if node.get("kind") == "subpipeline" else None
            if child and child not in seen:
                below = self._nodes(child, seen)
                if below is None:
                    return None
                nodes += below
        return nodes

    @staticmethod
    def _starts_with_gate(record: dict[str, Any]) -> bool:
        graph = record.get("graph")
        if not isinstance(graph, dict):
            return False
        kinds = {n.get("id"): n.get("kind") for n in graph.get("nodes") or []}
        roots = {n["id"] for n in graph.get("nodes") or [] if n.get("kind") == "trigger"}
        first = [e.get("to") for e in graph.get("edges") or [] if e.get("from") in roots]
        return bool(first) and all(kinds.get(target) == "gate" for target in first)

    def binding_problem(self, trigger: dict[str, Any]) -> str:
        """Why this trigger may not start a run now, or ''. Asked at creation,
        when enabling and on every request: a pipeline can change in between."""
        pipeline_id = trigger["pipeline_id"]
        record = self._pipeline(pipeline_id)
        if record is None:
            return "pipeline-missing"
        nodes = self._nodes(pipeline_id, set())
        if nodes is None or any(
            n.get("kind") == "slot" and (n.get("slot") or {}).get("agentKey") not in VENDORS for n in nodes
        ):
            return "vendor-refused"
        if not trigger["no_gate_ack"] and not self._starts_with_gate(record):
            return "no-gate"
        return ""

    # ── a request ────────────────────────────────────────────────────────

    async def accept(self, trigger: dict[str, Any], text: str, body_sha256: str) -> tuple[int, int, str]:
        """(status, Retry-After, audit outcome). Answers once the run is on its
        way, because a pane spawn takes longer than a caller's own timeout: a
        start that then fails is in the audit trail."""
        workspace = trigger["workspace"]
        lock = self._checks.setdefault(workspace, asyncio.Lock())
        async with lock:
            if await asyncio.to_thread(self.store.runs_on, trigger["id"], today()) >= trigger["per_day"]:
                return 429, _seconds_to_midnight(), "daily-limit"
            problem = await asyncio.to_thread(self.binding_problem, trigger)
            if problem:
                return 409, 0, problem
            if not await self.window.probe(workspace):
                return 503, 0, "no-window"
            if await self.window.app_lock(workspace) != "unlocked":
                return 503, 0, "app-locked"
            if workspace in self._starting or await self.window.run_active(workspace):
                return 409, 0, "run-active"
            self._starting.add(workspace)
            try:
                await asyncio.to_thread(self.store.count_run, trigger["id"], today())
            except BaseException:
                self._starting.discard(workspace)
                raise
            task = asyncio.create_task(self._start(trigger, text, body_sha256))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
        return 202, 0, "accepted"

    async def _start(self, trigger: dict[str, Any], text: str, body_sha256: str) -> None:
        workspace = trigger["workspace"]
        self._armed[workspace] = trigger
        try:
            answer = await self.window.start(
                workspace, webhook_payload.build_task(trigger["name"], text), trigger["pipeline_id"],
                f'webhook trigger "{trigger["name"]}"',
            )
        except Exception:  # noqa: BLE001 - the caller already has its 202
            log.exception("webhook: starting a run failed")
            answer = {"ok": False, "error_code": "start-error"}
        finally:
            self._armed.pop(workspace, None)
            self._starting.discard(workspace)
        started = bool(answer.get("ok"))
        self.audit([{
            "trigger_id": trigger["id"],
            "outcome": "started" if started else "start-failed",
            "status": 202,
            "body_sha256": body_sha256,
            # The code only: a window's error text can quote the task.
            "detail": None if started else str(answer.get("error_code") or "start-refused")[:80],
        }])

    def audit(self, events: list[dict[str, Any]]) -> None:
        import time

        now = int(time.time())
        try:
            self.store.record_events([{"ts": now, **event} for event in events])
        except Exception:  # noqa: BLE001 - an audit write never fails a request
            log.exception("webhook: audit write failed")

    # ── the run's panes ──────────────────────────────────────────────────

    def run_started(self, project: Any, *, child: bool) -> None:
        """pipeline.start in the window, on the main loop. Adopts the arming of
        a run this service asked for. A run nobody armed is someone else's and
        ends the policy, unless it is a sub-pipeline of the run in progress."""
        workspace = project.workspace_path
        trigger = self._armed.get(workspace)
        if trigger is not None:
            self._active[workspace] = self.store.open_run(
                trigger_id=trigger["id"], workspace=workspace, project_id=project.id,
                pipeline_id=getattr(project, "pipeline_id", ""),
            )
        elif not child and workspace in self._active:
            self.finish_run(workspace, "replaced")

    def finish_run(self, workspace: str, state: str) -> None:
        run = self._active.pop(workspace, None)
        if run is not None:
            self.store.close_run(run["id"], state)

    def launch_command(self, agent_key: str, command: Any, *, pane_id: str, metadata: dict[str, Any]) -> Any:
        """The command a pane starts with: `command` itself, unchanged, unless
        the pane belongs to a webhook run."""
        run_id = self._guarded.get(pane_id) or self._guarded.get(str(metadata.get("spawned_by") or ""))
        if run_id is None:
            active = self._active.get(str(metadata.get("workspace_path") or ""))
            if active is None or metadata.get("origin") != "pipeline":
                return command
            run_id = active["id"]
        if agent_key not in VENDORS:
            raise LaunchRefused(f"a webhook run cannot start {agent_key or 'this CLI'}: it has no tested Guard hook")
        line = _line(command)
        head = _FIRST_TOKEN.match(line)
        program = next((g for g in head.groups() if g), "") if head else ""
        if _SHELL_SYNTAX.search(line) or not self._known_program(agent_key, program):
            # A custom launch command: whatever it runs is out of sight here.
            raise LaunchRefused(f"a webhook run needs the standard {agent_key} command, not a custom launch command")
        if pane_id not in self._guarded:
            self._guarded[pane_id] = run_id
            self.store.add_run_pane(pane_id, run_id)
        return _rewrite(command, lambda text: _without_bypass(agent_key, text))


_service: WebhookService | None = None


def current() -> WebhookService | None:
    """The service once startup built it. None means no webhook code has run,
    so callers on an existing path stay exactly what they were."""
    return _service


def configure(service: WebhookService | None) -> None:
    global _service
    _service = service
