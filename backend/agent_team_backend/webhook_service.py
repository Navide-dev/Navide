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

A run can also go on after its record here has closed: Resume, Start Over and
restart-from-node open new panes on the same task, which holds what the webhook
sent, and a window reload is enough to close the record. So a pipeline pane with
no open run is still held to the rule while the workspace's pipeline is one a
webhook ran, whoever pressed the button. It never gets the unattended bypass
back: a person chose that for the run the webhook started, not for this one.

A restored pane gets a new id, so the id alone does not recognise it. Its
session does: every session a run pane used is kept in `webhook_run_sessions`,
for as long as the transcript can be resumed. A resume that cannot be named, or
a lookup that fails, loses the bypass rather than keeping it.
"""

from __future__ import annotations

import asyncio
import datetime
import logging
import os
import re
import sqlite3
import time
from collections.abc import Callable
from typing import Any, NamedTuple, Protocol

from . import guard_fail_closed, pipeline_graph, pipeline_liveness, webhook_keystore, webhook_payload, webhook_triggers
from .db import Database

log = logging.getLogger(__name__)

#: Vendors a webhook run may use. Copilot and Qwen have a Guard hook whose ask and
#: deny have not been tested. Codex 0.166 was measured and stays out for now: it
#: has no mode that asks before every call, and its hook trust screen stopped the
#: run. The Codex rows below are kept for when it comes back; nothing reaches them.
VENDORS = frozenset({"claude"})

#: How long a request waits for the window to answer that it holds the
#: workspace. The 0.2.37 Linux VM, starved of CPU, stalled the backend's event
#: loop 2–8 s at a time; at 2 s the probe timed out with the window open and
#: the request was refused "no-window" (503), which GitHub does not redeliver.
#: A late answer still counts within the wait, so it covers the worst stall.
PROBE_S = 8.0
#: After ui.pipeline.start went unanswered (ui_action_timeout): how long to
#: wait for the window's pipeline.start to adopt the run. The window is not
#: told to stop on that timeout, so a slow start goes on and the run comes up
#: late; failing it here dropped its arming and audited a run that ran as
#: "start-failed".
LATE_START_S = 120.0
LATE_START_POLL_S = 1.0
WATCH_EVERY_S = 15.0
#: A run ends here whatever it is doing.
RUN_CAP_S = 4 * 60 * 60
#: Between interrupting a pane and reclaiming it: a CLI needs a moment to leave
#: its prompt, and reclaim refuses a pane that is still awaiting.
SETTLE_S = 3.0

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
_BYPASS = {
    "claude": "--dangerously-skip-permissions",
    "codex": "--dangerously-bypass-approvals-and-sandbox",
}
_ASK = {
    "claude": "--permission-mode default",
    # Codex 0.166 has no ask-every-call mode: the flag takes only on-request and
    # never, and config refuses untrusted. on-request alone lets the model decide,
    # and in workspace-write a command then runs unasked, so the sandbox is what
    # holds here: read-only stops writes and network whatever the model decides.
    "codex": "--ask-for-approval on-request --sandbox read-only",
}


#: Quotes count as a boundary: `bash -lc 'claude --resume x'` has the flag next to one.
_BYPASS_FLAG = re.compile(
    r"""\s*(?<![^\s'"])(?:--(?:allow-)?dangerously-skip-permissions|--permission-mode(?:=|\s+)['"]?bypassPermissions)(?![^\s'"])"""
)
_TOKEN = re.compile(r"""'[^']*'|"[^"]*"|\S+""")
_SESSION_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]*\Z")
_ID_FLAGS = frozenset({"--resume", "-r", "--session-id"})
_RESUME_FLAGS = frozenset({"--resume", "-r"})
_CONTINUE_FLAGS = frozenset({"--continue", "-c"})


class LaunchRefused(RuntimeError):
    """A pane of a webhook run that cannot be started without a bypass."""


class _SessionRefs(NamedTuple):
    """What a Claude command says about sessions."""

    ids: tuple[str, ...] = ()
    #: It reopens a conversation, as opposed to pinning a new one's id.
    resumes: bool = False
    #: It reopens one the line does not name, or names in a way that cannot be read.
    unclear: bool = False


def _session_refs(line: str) -> _SessionRefs:
    ids: list[str] = []
    resumes = unclear = False
    tokens = [token.strip("'\"") if token[0] in "'\"" else token for token in _TOKEN.findall(line)]
    for raw, token in zip(_TOKEN.findall(line), tokens, strict=True):
        if raw[0] in "'\"" and " " in token and token[0] not in "{[":
            inner = _session_refs(token)
            ids.extend(inner.ids)
            resumes, unclear = resumes or inner.resumes, unclear or inner.unclear
    for index, token in enumerate(tokens):
        flag, sign, value = token.partition("=")
        if token in _CONTINUE_FLAGS:
            resumes = unclear = True
        elif flag in _ID_FLAGS:
            resumes = resumes or flag in _RESUME_FLAGS
            if not sign:
                value = tokens[index + 1] if index + 1 < len(tokens) else ""
            if _SESSION_ID.match(value):
                ids.append(value)
            else:
                unclear = True
    return _SessionRefs(tuple(ids), resumes, unclear)


def _dropped_bypass(command: Any) -> Any:
    """`command` without a bypass flag, and the same object if it had none."""
    if _BYPASS_FLAG.search(_line(command)) is None:
        return command
    return _rewrite(command, lambda text: _BYPASS_FLAG.sub("", text).strip())


def without_bypass(agent_key: str, command: Any) -> Any:
    """For when the service itself could not start: nothing can say whose
    session this is, so a pane that reopens one keeps its CLI's own prompts."""
    if agent_key not in VENDORS or not _session_refs(_line(command)).resumes:
        return command
    return _dropped_bypass(command)


def bypass_dropped_from(requested: Any, launched: Any) -> str:
    """What the pane really runs when the window asked for a bypass and did not
    get one, else ''. The window keeps its own command for later launches, so
    without this its card goes on showing the flag."""
    if _BYPASS_FLAG.search(_line(requested)) is None or _BYPASS_FLAG.search(_line(launched)) is not None:
        return ""
    return _line(launched)


def end_state_of(project: Any) -> str:
    """What a run's row records when the run's record is about to be
    overwritten (a new run, a reset): what the run had come to. One still going
    is being stopped."""
    if project is None:
        return "finished"
    if pipeline_liveness.is_interrupted(project):
        return "interrupted"
    state = getattr(project, "state", "")
    if state == "running":
        return "aborted"
    return state if state in ("completed", "aborted") else "finished"


def _workspace_key(path: str) -> str:
    return os.path.normcase(path.rstrip("/\\"))


class Window(Protocol):
    async def probe(self, workspace: str) -> bool: ...
    async def app_lock(self, workspace: str) -> str: ...
    async def run_active(self, workspace: str) -> bool: ...
    async def start(self, workspace: str, task: str, pipeline_id: str, taint_detail: str) -> dict[str, Any]: ...
    async def run_status(self, workspace: str) -> dict[str, Any]: ...
    async def pane_awaiting(self, workspace: str, pane_id: str) -> bool: ...
    async def abort(self, workspace: str) -> None: ...
    async def interrupt(self, workspace: str, pane_id: str) -> None: ...
    async def reclaim(self, workspace: str, pane_id: str) -> bool: ...


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


    async def run_status(self, workspace: str) -> dict[str, Any]:
        from .mcp_server import server as mcp

        return await asyncio.to_thread(mcp._pipeline_status_of, workspace)

    async def pane_awaiting(self, workspace: str, pane_id: str) -> bool:
        from .mcp_server import server as mcp

        reply = await mcp._ui_request(
            workspace, "invoke", caller=mcp._pane_caller(pane_id), action="ui.pane.getStatus", args={"paneId": pane_id},
        )
        result = reply.get("result") if reply.get("ok") else None
        return isinstance(result, dict) and result.get("status") == "awaiting"

    async def abort(self, workspace: str) -> None:
        from .mcp_server import server as mcp

        await mcp._ui_request(workspace, "invoke", caller=mcp._Caller(kind="host"), action="ui.pipeline.abort", args={})

    async def interrupt(self, workspace: str, pane_id: str) -> None:
        from .mcp_server import server as mcp

        await mcp._ui_request(
            workspace, "invoke", caller=mcp._pane_caller(pane_id), action="ui.pane.interrupt", args={"paneId": pane_id},
        )

    async def reclaim(self, workspace: str, pane_id: str) -> bool:
        from .mcp_server import server as mcp

        reply = await mcp._ui_request(
            workspace, "invoke", caller=mcp._Caller(kind="host"), route_pane_id=pane_id,
            action="ui.pane.reclaim", args={"paneId": pane_id},
        )
        return bool(reply.get("ok"))


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


def _with_mode(agent_key: str, line: str, *, unattended: bool) -> str:
    """`line` with whatever it said about permissions out and the run's mode
    right after the program, where `codex resume` still accepts it."""
    for flag in _DROP[agent_key]:
        line = flag.sub(" ", line)
    head = _FIRST_TOKEN.match(line)
    end = head.end() if head else 0
    rest = " ".join(line[end:].split())
    mode = _BYPASS[agent_key] if unattended else _ASK[agent_key]
    return " ".join(part for part in (line[:end].strip(), mode, rest) if part)


class WebhookService:
    def __init__(
        self,
        *,
        store: webhook_triggers.WebhookStore,
        db: Database,
        window: Window,
        pipeline: Callable[[str], dict[str, Any] | None],
        known_program: Callable[[str, str], bool],
        keystore: webhook_keystore.Keystore | None = None,
        project: Callable[[str], Any] = lambda _workspace: None,
    ) -> None:
        self.store, self.db, self.window = store, db, window
        self.keystore = keystore or webhook_keystore.Keystore()
        self._pipeline = pipeline
        self._project = project
        self._known_program = known_program
        self._guarded = store.run_panes()
        self._noted_sessions: set[str] = set()
        self._active: dict[str, dict[str, Any]] = {run["workspace"]: run for run in store.open_runs()}
        self._armed: dict[str, dict[str, Any]] = {}
        self._starting: set[str] = set()
        #: Workspaces whose start went unanswered and wait for the run to come
        #: up (_adopted_late): a run adopted then never runs unattended.
        self._late: set[str] = set()
        self._checks: dict[str, asyncio.Lock] = {}
        self._tasks: set[asyncio.Task[None]] = set()
        self._waiting_since: dict[str, float] = {}
        #: Runs seen interrupted (a Reload or crash), which never run unattended
        #: again. Read back from the audit, so a restart does not note one twice.
        self._interrupted: set[str] = store.interrupted_open_runs()
        #: Per workspace, a run the watchdog closed as aborted that Resume may
        #: still carry on: a failed kickoff is stored aborted too.
        self._closed: dict[str, dict[str, Any]] = {}
        self._watchdog: asyncio.Task[None] | None = None
        self._clock = time.time

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

    def listener_snapshot(self) -> dict[str, dict[str, Any]]:
        """What the listener holds in memory, GitHub secrets opened. A secret
        that no longer opens disables its trigger; a key that cannot be read
        right now leaves the trigger on, answering 503. Called off the loop."""
        snapshot = self.store.snapshot()
        for trigger_id, trigger in list(snapshot.items()):
            blob = trigger.pop("github_secret", None)
            if trigger["kind"] != "github":
                continue
            try:
                trigger["secret"] = webhook_keystore.decrypt(self.keystore.load(), trigger_id, blob or b"")
            except webhook_keystore.KeyUnavailable:
                trigger["secret"] = None
                self.audit([{"trigger_id": trigger_id, "outcome": "key-unavailable", "status": 503}])
            except webhook_keystore.KeyLost:
                self.store.set_enabled(trigger_id, False)
                del snapshot[trigger_id]
                self.audit([{"trigger_id": trigger_id, "outcome": "secret-lost", "status": 0}])
        return snapshot

    async def accept(self, trigger: dict[str, Any], text: str, body_sha256: str) -> tuple[int, int, str]:
        """(status, Retry-After, audit outcome). Answers once the run is on its
        way, because a pane spawn takes longer than a caller's own timeout: a
        start that then fails is in the audit trail."""
        workspace = trigger["workspace"]
        github = trigger["kind"] == "github"
        lock = self._checks.setdefault(workspace, asyncio.Lock())
        async with lock:
            now = int(time.time())
            if github and await asyncio.to_thread(self.store.seen_recently, trigger["id"], body_sha256, now):
                # 200, not an error: GitHub shows it as delivered, and the audit
                # row is where a redelivery that did nothing can be looked up.
                return 200, 0, "duplicate"
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
                if github:
                    await asyncio.to_thread(self.store.mark_seen, trigger["id"], body_sha256, now)
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
        before = self._active.get(workspace)
        try:
            answer = await self.window.start(
                workspace, webhook_payload.build_task(trigger["name"], text), trigger["pipeline_id"],
                f'webhook trigger "{trigger["name"]}"',
            )
            if answer.get("error_code") == "ui_action_timeout" and await self._adopted_late(workspace, before):
                answer = {"ok": True, "late": True}
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
            "detail": ("late-answer" if answer.get("late") else None)
            if started
            else str(answer.get("error_code") or "start-refused")[:80],
        }])

    async def _adopted_late(self, workspace: str, before: Any) -> bool:
        """Did run_started adopt a run for this workspace, within LATE_START_S
        of an unanswered start? `before` is the open row from before the start;
        the arming stays in place meanwhile so the late run is still ours."""
        if self._active.get(workspace) not in (None, before):
            return True  # adopted before the answer timed out, as usual
        # Adopted from here on, the run is ours but never unattended: nothing
        # ties it to this start but its workspace and pipeline. The watchdog
        # and RUN_CAP_S still stop it if it waits on a prompt.
        self._late.add(workspace)
        try:
            deadline = time.monotonic() + LATE_START_S
            while True:
                current = self._active.get(workspace)
                if current is not None and current is not before:
                    return True
                if time.monotonic() >= deadline:
                    return False
                await asyncio.sleep(LATE_START_POLL_S)
        finally:
            self._late.discard(workspace)

    def note_kickoff_failed(self, workspace: str) -> None:
        """A run that had been reported started never got its task. While the
        start is still in progress its own answer reports this."""
        active = self._active.get(workspace)
        if active is not None and workspace not in self._starting:
            self.audit([{"trigger_id": active["trigger_id"], "outcome": "start-failed", "status": 0, "detail": "kickoff"}])

    def audit(self, events: list[dict[str, Any]]) -> None:
        now = int(time.time())
        try:
            self.store.record_events([{"ts": now, **event} for event in events])
        except Exception:  # noqa: BLE001 - an audit write never fails a request
            log.exception("webhook: audit write failed")

    # ── the run's panes ──────────────────────────────────────────────────

    def run_started(self, project: Any, *, child: bool, ended: str = "finished") -> None:
        """pipeline.start in the window, on the main loop. Adopts the arming of
        a run this service asked for. A run nobody armed is someone else's and
        ends the policy, unless it is a sub-pipeline of the run in progress.
        `ended` is end_state_of the record this start overwrote."""
        workspace = project.workspace_path
        if not child:
            self._closed.pop(workspace, None)
        trigger = self._armed.get(workspace)
        if trigger is not None and getattr(project, "pipeline_id", "") != trigger["pipeline_id"]:
            # Another pipeline started in the workspace while this one was
            # armed, by hand or by anyone else: not this trigger's run, and
            # never one to hand the trigger's unattended setting to.
            trigger = None
        if trigger is not None:
            # The watchdog only looks every WATCH_EVERY_S, so the last run can
            # still be open here, and overwriting it would leave it open for good.
            self.finish_run(workspace, ended)
            self._active[workspace] = self.store.open_run(
                trigger_id=trigger["id"], workspace=workspace, project_id=project.id,
                pipeline_id=getattr(project, "pipeline_id", ""),
                unattended=bool(trigger.get("unattended")) and guard_fail_closed.unattended_supported()
                and workspace not in self._late,
            )
        elif not child and workspace in self._active:
            self.finish_run(workspace, ended if ended in ("completed", "aborted", "interrupted") else "replaced")

    def run_reset(self, workspace: str, ended: str) -> None:
        """pipeline.reset returned the workspace's record to idle: the open row
        ends with what the run had come to (end_state_of, read before)."""
        self._closed.pop(workspace, None)
        if workspace in self._active:
            self._ended(workspace, ended)

    def run_resumed(self, workspace: str) -> None:
        """pipeline.resume carries on the run the watchdog closed as aborted
        (a failed kickoff is stored so): its row opens again, to end with the
        run's real outcome. Before any pane of it starts, and never unattended."""
        run = self._closed.pop(workspace, None)
        if run is None or workspace in self._active:
            return
        try:
            self.store.reopen_run(run["id"])
        except sqlite3.Error:
            log.exception("webhook: could not reopen a resumed run")
            return
        self._active[workspace] = {**run, "state": "running", "unattended": 0}

    def finish_run(self, workspace: str, state: str) -> None:
        run = self._active.pop(workspace, None)
        if run is not None:
            self._interrupted.discard(run["id"])
            self.store.close_run(run["id"], state)

    def launch_command(self, agent_key: str, command: Any, *, pane_id: str, metadata: dict[str, Any]) -> Any:
        """The command a pane starts with: `command` itself, unchanged, unless
        the pane belongs to a webhook run."""
        known = self._guarded.get(pane_id)
        parent = self._guarded.get(str(metadata.get("spawned_by") or ""))
        refs = _session_refs(_line(command)) if agent_key in VENDORS else _SessionRefs()
        resumed = None
        if known is None and parent is None:
            try:
                resumed = self._resumed_run(refs)
            except sqlite3.Error as err:
                # No run id to trust, so the pane is not recorded as one.
                log.warning("webhook: session lookup failed, starting this pane without a bypass: %s", err)
                return _dropped_bypass(command)
        workspace = str(metadata.get("workspace_path") or "")
        if known is not None:
            run_id, unattended = known
        elif parent is not None:
            # A pane an agent opened never inherits the bypass: nobody chose it
            # for that pane, and without it a failed hook still leaves the
            # CLI's own prompt, so it needs no fail-closed hook either.
            run_id, unattended = parent[0], False
        elif resumed is not None:
            run_id, unattended = resumed
        else:
            active = self._active.get(workspace)
            if metadata.get("origin") != "pipeline":
                return self._unsure(command, refs, workspace)
            if active is not None:
                run_id, unattended = active["id"], bool(active["unattended"])
            else:
                try:
                    earlier = self._earlier_run(workspace)
                except Exception as err:  # noqa: BLE001 - whatever failed, this pane may be a run's
                    log.warning("webhook: could not tell whose run this is, starting this pane without a bypass: %s", err)
                    return _dropped_bypass(command)
                if earlier is None:
                    return self._unsure(command, refs, workspace)
                run_id, unattended = earlier, False
        if unattended and workspace and pipeline_liveness.is_interrupted(self._project(workspace)):
            # Restored before the watchdog looked: nobody drives the run now.
            self.note_interrupted(workspace)
            unattended = False
        unattended = unattended and self._still_unattended(run_id)
        if agent_key not in VENDORS:
            raise LaunchRefused(f"a webhook run cannot start {agent_key or 'this CLI'}: it has no tested Guard hook")
        line = _line(command)
        head = _FIRST_TOKEN.match(line)
        program = next((g for g in head.groups() if g), "") if head else ""
        if _SHELL_SYNTAX.search(line) or not self._known_program(agent_key, program):
            # A custom launch command: whatever it runs is out of sight here.
            raise LaunchRefused(f"a webhook run needs the standard {agent_key} command, not a custom launch command")
        try:
            if self._guarded.get(pane_id) != (run_id, unattended):
                self.store.add_run_pane(pane_id, run_id, unattended)
                self._guarded[pane_id] = (run_id, unattended)
            self.store.add_run_sessions(refs.ids, agent_key, run_id, unattended, pane_id)
        except sqlite3.Error as err:
            # An unrecorded session would look like nobody's after a restart.
            raise LaunchRefused("a webhook run pane could not be recorded") from err
        return _rewrite(command, lambda text: _with_mode(agent_key, text, unattended=unattended))

    def _earlier_run(self, workspace: str) -> str | None:
        """The webhook run behind the workspace's current pipeline record. A
        sub-pipeline's record names its parents in the stack."""
        project = self._project(workspace)
        if project is None:
            return None
        frames = getattr(project, "run_stack", None) or []
        pipelines = [getattr(project, "pipeline_id", ""), *(frame["run"].get("pipeline_id", "") for frame in frames)]
        return self.store.latest_run_of(project.workspace_path, pipelines)

    def _resumed_run(self, refs: _SessionRefs) -> tuple[str, bool] | None:
        """The run one of these sessions belongs to."""
        for session_id in refs.ids:
            found = self.store.run_session(session_id)
            if found is not None:
                return found
        return None

    def _unsure(self, command: Any, refs: _SessionRefs, workspace: str) -> Any:
        """A pane no run claims. It may still reopen a run's conversation when
        the line does not say which one and that workspace has had runs."""
        if not refs.unclear or _BYPASS_FLAG.search(_line(command)) is None:
            return command
        try:
            workspaces = {_workspace_key(path) for path in self.store.run_workspaces()}
        except sqlite3.Error as err:
            log.warning("webhook: run lookup failed, starting this pane without a bypass: %s", err)
            return _dropped_bypass(command)
        if _workspace_key(workspace) in workspaces or (workspaces and not workspace):
            return _dropped_bypass(command)
        return command

    def _still_unattended(self, run_id: str) -> bool:
        """Unattended holds only while its trigger exists and still says so, and
        the run was never interrupted."""
        if run_id in self._interrupted:
            return False
        try:
            return self.store.run_trigger_unattended(run_id)
        except sqlite3.Error as err:
            log.warning("webhook: trigger lookup failed, this pane will ask: %s", err)
            return False

    def note_pane_session(self, pane_id: str, vendor: str, session_id: str) -> None:
        """A run pane moved to another session, as /clear does."""
        known = self._guarded.get(pane_id)
        if known is None or vendor not in VENDORS or not session_id or session_id in self._noted_sessions:
            return
        try:
            self.store.add_run_sessions((session_id,), vendor, known[0], known[1], pane_id)
        except sqlite3.Error:
            log.exception("webhook: could not record a run pane's session")
            return
        self._noted_sessions.add(session_id)

    def is_run_pane(self, pane_id: str) -> bool:
        return pane_id in self._guarded

    def launch_env(self, pane_id: str) -> dict[str, str]:
        """What only an unattended run pane's environment holds."""
        known = self._guarded.get(pane_id)
        return {guard_fail_closed.ENV: "1"} if known is not None and known[1] else {}


    # ── nobody at the computer ───────────────────────────────────────────

    def open_run_views(self) -> list[dict[str, Any]]:
        """Open runs for the screen, each with how long it may still wait."""
        views = []
        for workspace, run in self._active.items():
            since = self._waiting_since.get(run["id"])
            limit = self.store.approval_timeout_s(run["trigger_id"])
            views.append({
                "trigger_id": run["trigger_id"], "workspace": workspace, "started_at": run["started_at"],
                "unattended": bool(run["unattended"]),
                "waiting_since": int(since) if since is not None else None,
                "stops_at": int(since + limit) if since is not None else None,
            })
        return views

    def start_watchdog(self) -> None:
        self._watchdog = asyncio.create_task(self._watch())

    async def stop_watchdog(self) -> None:
        task, self._watchdog = self._watchdog, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def _watch(self) -> None:
        while True:
            await asyncio.sleep(WATCH_EVERY_S)
            try:
                await self.tick()
            except Exception:  # noqa: BLE001 - the next tick tries again
                log.exception("webhook: watchdog tick failed")

    async def tick(self) -> None:
        """One look at every open run. A run that waited too long for a person
        is stopped: nothing is ever approved on anyone's behalf."""
        for workspace, run in list(self._active.items()):
            await self._check_run(workspace, run)

    def _panes_of(self, run: dict[str, Any]) -> list[str]:
        return [pane for pane, (run_id, _) in self._guarded.items() if run_id == run["id"]]

    async def _awaiting(self, workspace: str, run: dict[str, Any], status: dict[str, Any]) -> bool:
        if status.get("gate"):
            return True
        panes = self._panes_of(run)
        return any([await self.window.pane_awaiting(workspace, pane) for pane in panes])

    async def _check_run(self, workspace: str, run: dict[str, Any]) -> None:
        status = await self.window.run_status(workspace)
        state = status.get("state")
        if state == "interrupted":
            # Nobody drives the run now, but Resume carries on this same run,
            # so its row stays open until the run really ends, or the cap.
            self._waiting_since.pop(run["id"], None)
            self.note_interrupted(workspace)
            if self._clock() - run["started_at"] >= RUN_CAP_S:
                self._ended(workspace, "interrupted")
            return
        if not status.get("active"):
            # Only a stored end state names the outcome; anything else (a row
            # closed as 'running' would be read back as open) is "finished".
            self._ended(workspace, state if state in ("completed", "aborted") else "finished")
            if state == "aborted":
                self._closed[workspace] = run
            return
        now = self._clock()
        if now - run["started_at"] >= RUN_CAP_S:
            await self._stop_run(workspace, run, "run-timeout")
            return
        if not await self._awaiting(workspace, run, status):
            self._waiting_since.pop(run["id"], None)
            return
        since = self._waiting_since.get(run["id"])
        if since is None:
            self._waiting_since[run["id"]] = now
            self.audit([{"trigger_id": run["trigger_id"], "outcome": "awaiting-approval", "status": 0}])
            return
        limit = await asyncio.to_thread(self.store.approval_timeout_s, run["trigger_id"])
        if now - since >= limit:
            await self._stop_run(workspace, run, "approval-timeout")

    def note_interrupted(self, workspace: str) -> None:
        """The workspace's run is driven by no window (a Reload or crash). The
        run may be resumed, still working from what the webhook sent, so it
        never runs unattended again, after a restart too."""
        run = self._active.get(workspace)
        if run is None or run["id"] in self._interrupted:
            return
        self._interrupted.add(run["id"])
        run["unattended"] = 0
        try:
            self.store.end_unattended(run["id"])
        except sqlite3.Error:
            log.exception("webhook: could not record that a run was interrupted")
        self.audit([{"trigger_id": run["trigger_id"], "outcome": "interrupted", "status": 0, "detail": run["id"]}])

    def _ended(self, workspace: str, state: str) -> None:
        run = self._active.get(workspace)
        if run is not None:
            self._waiting_since.pop(run["id"], None)
        self.finish_run(workspace, state)

    async def _stop_run(self, workspace: str, run: dict[str, Any], outcome: str) -> None:
        """Abort, take the panes off whatever prompt holds them, and free them.
        The prompt is cancelled, which refuses the call that was waiting."""
        await self.window.abort(workspace)
        panes = self._panes_of(run)
        for pane in panes:
            await self.window.interrupt(workspace, pane)
        if panes:
            await asyncio.sleep(SETTLE_S)
        kept = [pane for pane in panes if not await self.window.reclaim(workspace, pane)]
        self.audit([{
            "trigger_id": run["trigger_id"], "outcome": outcome, "status": 0,
            "detail": f"{len(kept)} pane(s) not reclaimed" if kept else None,
        }])
        self._ended(workspace, "stopped")


_service: WebhookService | None = None
_unavailable = False


def current() -> WebhookService | None:
    """The service once startup built it. None means no webhook code has run,
    so callers on an existing path stay exactly what they were."""
    return _service


def mark_unavailable() -> None:
    """Startup failed: every launch goes without this service from here on."""
    global _unavailable
    _unavailable = True


def unavailable() -> bool:
    return _unavailable


def configure(service: WebhookService | None) -> None:
    global _service
    _service = service
