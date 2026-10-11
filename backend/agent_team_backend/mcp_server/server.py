"""Plan MCP server — plan-document tools over streamable HTTP.

Mounted on the backend's FastAPI app in the same process (later phases must
reach in-process singletons like TerminalService, so no stdio subprocess).
The backend has no single "current workspace" — every ws_handler receives
``workspace_path`` per request from the client — so the MCP tools follow the
same convention and take ``workspace_path`` as a call-time argument. A caller
authenticated as a pane may omit it: the tools then use that pane's own
workspace, which is the value Navide's plan window resolves plans against, so
a plan cannot land where the window will not look for it (see
:func:`_caller_workspace`).

Path safety reuses :func:`fs_service._resolve_safe` (the same guard the fs.*
handlers use), plus a plans-subtree containment check on top.

Lifecycle: the SDK's ``StreamableHTTPSessionManager.run()`` is once-only per
instance, so instead of ``FastMCP.streamable_http_app()`` (which caches one
manager forever) this module exposes a thin ASGI endpoint that delegates to
the manager created by the latest :func:`startup` call. ``startup`` /
``shutdown`` are registered as plugin lifecycle hooks (see backend.py) and run
from app.py's startup/shutdown events, which Starlette runs in the same
lifespan task — safe for the anyio task group inside.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import secrets
import time
from collections.abc import Iterator
from contextlib import AsyncExitStack, contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from html import escape as html_escape
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from starlette.responses import PlainTextResponse
from starlette.types import Receive, Scope, Send

from agent_team_backend import osplat as _osplat
from agent_team_backend.fs_service import FsError
from agent_team_backend.pending_registry import TIMEOUT, PendingRegistry
# Workspace normalisation, not a plan dependency: preview_* resolves a
# workspace the same way plans do, and both must agree on what one root means.
from agent_team_backend.plan_index import resolve_plan_root
from agent_team_backend.stages_store import GraphNonLinearError
from agent_team_backend.preview_log import MAX_INLINE_CHARS, MAX_ROWS

#: Where this server is mounted. Baked into every pane config file already
#: written to disk and hardcoded in three places that never import it
#: (native_mcp's "is this ours" regex, SettingsModal's external URL,
#: McpHelp's docs), so changing it is a migration, not an edit.
ROUTE_PATH = "/plan-mcp"
ROUTE_METHODS = ["GET", "POST", "DELETE"]

PLANS_REL_DIR = ".agent-team/plans"

# The one sentence that decides where delegated work goes. It is quoted in the
# server instructions, in cli_open_agent's docstring and in cli_whoami's
# `delegation_hint`, and a test pins all three to this constant so the rule
# cannot drift into three slightly different rules.
DELEGATION_RULE = (
    "Delegation rule: work that edits files, runs longer than a few minutes, "
    "or that the user may want to watch, interrupt or take over goes to a "
    "Navide CLI pane via cli_open_agent — not to your own subagent facility "
    "(Agent / Task tools). A pane is visible in Navide, can be opened mid-run "
    "and outlives your session; a subagent is a black box that hands back one "
    "summary. Keep subagents for short read-only lookups whose whole result "
    "is a paragraph."
)

server = FastMCP(
    name="navide",
    instructions=(
        "Navide plan documents: HTML files under "
        f"{PLANS_REL_DIR}/ in a workspace, which the user reads and approves "
        "in Navide's Plan view.\n"
        "\n"
        "workspace_path: omit it. Running as a Navide CLI pane, every tool "
        "defaults to the workspace of the pane you are in — the same workspace "
        "Navide's plan view resolves plans against, so an omitted argument can "
        "never send a plan somewhere the user cannot open it. Pass it only to "
        "work on a different project on purpose, as the absolute path of that "
        "project root; a tool then warns when no pane uses it, meaning Navide "
        "is not watching that project and will not show the plan (check "
        "cli_list_targets for the workspaces panes actually use). An external "
        "client, which is not a pane, has no default and must always pass "
        "it.\n"
        "\n"
        "When to use: whenever the user asks for a plan, or a task is large "
        "enough that its steps and progress should be tracked. Create the "
        "plan with plan_create instead of hand-writing a markdown or HTML "
        "file — only documents created this way are visible in Navide, and "
        "the workspace's "
        f"{PLANS_REL_DIR}/_spec.md describes the format they follow.\n"
        "\n"
        "Flow: plan_list to discover plans, plan_read to fetch one, "
        "plan_create to start a new one (it begins at stage \"draft\"). Wait "
        "for the user to approve before writing code: start implementing once "
        "the stage is \"approved\" or later, and use plan_update_stage to move "
        "it through draft, in-review, approved, in-progress, done, abandoned. "
        "Mark each step with plan_update_todo (pending, in-progress, done, "
        "skipped) as you go, and record findings or decisions with "
        "plan_add_note. Always edit through these tools — writing the HTML "
        "yourself corrupts the plan-meta island Navide reads.\n"
        "\n"
        "Talking to other CLI panes: you can send an instruction to another "
        "CLI agent Navide is running — in this workspace or in another "
        "workspace window — with cli_send. Call cli_list_targets first to see "
        "who exists and how to address them (a bare pane name in your own "
        "workspace, `<folder>/<pane>` for another one). Use it to hand work "
        "to, ask something of, or coordinate with another pane or project — "
        "on your own judgment, not only when the user asks you to; delivery "
        "is queued until that pane is idle, "
        "so cli_send returns before the other agent has read anything. It "
        "returns a msg_key — pass it to cli_check_message to find out whether "
        "the message was delivered, refused (with a reason) or still queued. "
        "That table is backend memory, not a log: only the last hour and the "
        "last few hundred sends, gone on restart, so an unknown key means "
        "\"no longer tracked\", not \"never sent\".\n"
        "\n"
        "Other machines: when this machine is linked to a Navide-Server, the "
        "user's other machines are in reach too. cli_list_targets returns "
        "their panes as a separate `remote_targets` list, addressed by the "
        "three-part `<device>/<workspace>/<pane>` form that cli_send, "
        "cli_send_and_wait, cli_get_status and cli_wait_idle all accept. "
        "Reaching one travels through the server, so it fails in ways a local "
        "send cannot — the far machine may be offline or refuse on policy "
        "grounds — and there is no reading its log, interrupting it or "
        "closing it from here. `remote_targets` is absent whenever there is "
        "nothing to reach, which covers an unlinked machine and a linked one "
        "whose other machines simply have no pane open; cli_whoami's `cloud` "
        "key is what tells those two apart, so read it before telling the "
        "user anything about why. Linking itself — signing in, pairing a "
        "device, trusting or blocking one — moves trust state and is on no "
        "tool by design: it is the user's to do in Navide's account window, "
        "and saying so is the answer, not hunting for a tool that would do "
        "it for them.\n"
        "\n"
        "When you need the answer and not just the send, use cli_send_and_wait "
        "instead: it sends and then waits for that pane to finish the turn, "
        "handling the race a hand-written cli_send + cli_wait_idle loses (the "
        "target is still idle the instant you send, so a plain wait returns "
        "\"already idle\" before it has read you — this one only accepts a "
        "turn newer than the one it saw before sending). Always read the "
        "returned `source`: \"turn_complete\" is the other CLI's own word that "
        "its turn ended, while \"quiet_period\" only means the pane went "
        "silent, so check what it actually said before trusting it.\n"
        "\n"
        "Delegating to a new agent: cli_open_agent opens a fresh CLI pane and "
        "hands it a task. " + DELEGATION_RULE + " The new pane is asked to "
        "report back to you "
        "by message when it finishes, but that report is the child's own "
        "output rather than something Navide guarantees — it waits until you "
        "are between turns, and it never arrives at all if the child does not "
        "write the block, so poll cli_get_status / cli_wait_idle whenever you "
        "need to be sure. There is no hard cap on child "
        "panes, workspace CLI panes, or spawn-chain depth, but going well past "
        "sane advisory thresholds gets logged as a diagnostic warning (readable "
        "via ui_diagnostics) rather than refused.\n"
        "\n"
        "Picking up an earlier conversation: a CLI session outlives the pane "
        "that ran it — the pane closes, the app restarts, and the vendor's "
        "transcript stays on disk. cli_list_sessions lists the ones this "
        "workspace still has, and cli_open_agent(session_id=...) opens a pane "
        "that starts with that conversation's memory rather than an empty "
        "one, so `task` should be the follow-up and not a restatement of what "
        "it already knows. Two flags decide whether a row is usable: "
        "`resumable: false` is history — the transcript is gone and the id is "
        "refused — and `live: true` means the pane that owns it is still "
        "open, where resuming into a second pane forks the conversation and "
        "cli_send to that pane is the right move instead. This is a different "
        "call from reopening a pane Navide is itself holding: a "
        "cli_list_targets row with `realized: false` is a restore placeholder, "
        "woken with cli_open_agent(pane_id=...).\n"
        "\n"
        "Checking on another pane: cli_read_log reads the tail of a pane's "
        "conversation log, cli_get_status reports whether it is busy and its "
        "last known activity, and cli_wait_idle blocks until it goes idle or a "
        "timeout passes — the reliable way to learn a pane is done, and the "
        "only way for an external caller, which gets no completion message at "
        "all."
    ),
)


# ── workspace resolution ────────────────────────────────────────────────────

_WORKSPACE_REQUIRED = (
    "workspace_path is required for a caller with no pane identity — only a "
    "Navide CLI pane has an own workspace to fall back to. Pass the absolute "
    "path of the project root."
)


def _caller_workspace(caller: _Caller) -> str:
    """The calling pane's own workspace, or "" for a caller that is not a pane.

    Navide's plan window resolves plans against the *pane's* workspace, so
    defaulting to it is the one value that cannot mismatch (a self-reported one
    can, and then the window shows "Failed to load the plan document"). host and
    external callers have no pane identity, hence no default.
    """
    if caller.kind != "pane":
        return ""
    from agent_team_backend import agent_messaging

    pane = agent_messaging.get(caller.pane_id)
    # _resolve_caller has just rejected a stale pane id, so this is set.
    return pane.workspace_path if pane else ""


async def _plan_workspace(caller: _Caller, workspace_path: str) -> str:
    """The plan root a call operates on: the argument, else the caller's pane.

    Both go through :func:`resolve_plan_root`, the same normalisation
    plan_provisioning applies before writing _template.html: a plan and the
    assets it is built from must land under one root or creation fails outright.
    """
    chosen = workspace_path or _caller_workspace(caller)
    if not chosen:
        raise FsError(_WORKSPACE_REQUIRED)
    return await asyncio.to_thread(resolve_plan_root, chosen)


def _norm_workspace(path: str) -> str:
    """Comparable form of a workspace path (symlinks + trailing slash)."""
    try:
        return str(Path(path).resolve())
    except OSError:
        return str(path or "").rstrip("/")


def _live_pane_workspaces() -> list[str]:
    """Workspaces of live CLI panes; empty when the check is unavailable.

    Uses :func:`_terminal_service` lazily (defined below, resolved at call
    time) so a backend without terminals never breaks plan creation.
    """
    try:
        terminals = _terminal_service()
        sessions = list(getattr(terminals, "_sessions", {}).values())  # snapshot
    except Exception:  # noqa: BLE001 — advisory check, never fatal
        return []
    workspaces: list[str] = []
    for session in sessions:
        try:
            if session.closed:
                continue
            metadata = session.metadata if isinstance(session.metadata, dict) else {}
            workspaces.append(str(metadata.get("workspace_path") or session.cwd))
        except AttributeError:
            continue  # defensive: session shape changed mid-iteration
    return workspaces


def _workspace_mismatch_warning(workspace_path: str) -> str | None:
    """Advise when no live pane uses ``workspace_path``.

    Navide's plan window resolves plans against a *pane's* workspace, so a
    plan written to any other root is invisible there ("Failed to load the
    plan document"). None when the workspace matches a pane or no pane
    workspace is known (headless/external MCP clients must not be warned).
    """
    panes = _live_pane_workspaces()
    if not panes:
        return None
    target = _norm_workspace(workspace_path)
    if any(_norm_workspace(pane) == target for pane in panes):
        return None
    known = ", ".join(sorted(set(panes)))
    return (
        f"no live Navide pane uses workspace_path '{workspace_path}', so this plan "
        "will not be visible in Navide's plan view (it resolves plans against the "
        f"pane's own workspace). Pane workspaces right now: {known}"
    )


# ── terminal access ─────────────────────────────────────────────────────────


def _terminal_service() -> Any:
    """Resolve the app-level TerminalService at call time (never at import —
    app.py imports this module, and the singleton binds to the running loop).
    Maps an unavailable service to a clear tool error.
    """
    from agent_team_backend import app as _app  # local import, resolved at call time

    try:
        service = _app.get_terminals()
    except Exception as err:  # noqa: BLE001
        raise RuntimeError(f"terminal service unavailable: {err}") from err
    if service is None:
        raise RuntimeError("terminal service unavailable (backend not initialized)")
    return service


# ── Inter-CLI messaging (cli_send / cli_list_targets) ───────────────────────
# The `---MSG---` output protocol only reaches agents that were taught it in
# their kickoff, so a hand-opened pane has no way to discover it. These tools do
# — they show up in the agent's tool list on their own. Both route through the
# same backend registry as the protocol, and delivery still runs in the frontend
# (idle gate, rate limit, injection verification), so the two paths behave alike.


class CallerUnknown(Exception):
    """The request carries no usable / accepted credential."""


_UNWIRED = (
    "this MCP endpoint could not identify your pane — reopen the pane so Navide "
    "can wire it, or use the ---MSG-START--- output protocol"
)
_STALE = (
    "this pane's id is stale and names no pane any more — if this pane was just "
    "closed, or its window has been gone long enough to be forgotten, there is "
    "nothing left to act as. Reopen the pane to use these tools, or use the "
    "---MSG-START--- output protocol, which always resolves against the pane's "
    "current identity"
)
# Same refusal as _STALE, for an id the registry never saw: the window that
# started this CLI did not register its pane. Kept apart so the caller (and the
# log) can tell a pane that went away from one that never arrived — the second
# is a wiring bug, not something reopening the pane fixes on its own.
_UNREGISTERED = (
    "this pane's id is stale: it was never registered with Navide, so there is "
    "no pane to act as — the window that started this CLI did not register it "
    "(an embedded AI panel on a build that predates registering them does this). "
    "Restart the panel or reopen the pane, or use the ---MSG-START--- output "
    "protocol"
)
_HOST_TOKEN_REJECTED = "host token rejected"
_EXTERNAL_TOKEN_REJECTED = "external token rejected"
_EXTERNAL_DISABLED = (
    "external access to this MCP endpoint is disabled — turn it on in Navide's "
    "Settings before using an external client credential"
)
# Every cli_* tool that addresses another pane requires the sender's own pane
# identity to resolve a bare name against its own workspace (see
# agent_messaging.resolve). A caller with no pane identity (host / external)
# has no "own workspace", so it must always spell out the full address.
_QUALIFIED_TARGET_REQUIRED = (
    'a caller with no pane identity must address a pane as "<folder>/<pane>" '
    "— call cli_list_targets for the qualified address"
)


_log = logging.getLogger(__name__)
# Pane ids already logged as never registered (see _resolve_caller).
_logged_unregistered: set[str] = set()


@dataclass
class _Caller:
    """The credential kind that authenticated a /plan-mcp request.

    kind is "pane" (pane_id set), "host" (this backend's own CLI wiring with
    no pane id known at spawn time), or "external" (a client outside Navide's
    process tree, only accepted while enabled).
    """

    kind: str
    pane_id: str = ""


def _resolve_caller(ctx: Context) -> _Caller:
    """Validate the request's credential (pane / host / external).

    Every pane is spawned pointing at `/plan-mcp?pane=<id>&t=<token>`; backend-
    written CLI config without a known pane id instead carries
    `?client=host&t=<internal token>` (see mcp_wiring.plan_mcp_url); an
    external client carries `?client=external&t=<external token>`, accepted
    only while auth.external_enabled() is True. Raises CallerUnknown
    with a caller-facing message when none of these validate.

    For the pane kind specifically: the id is fixed at spawn time while a
    pane's id is not — re-attaching a live PTY (detach to a window, reload)
    mints a new pane id without re-running spawn wiring, leaving the CLI
    holding one that no longer refers to anything by itself. The window records
    where that id went (agent_messaging.add_aliases), so the caller is resolved
    to the pane its process is actually attached to and the answer carries that
    pane's *current* identity — every downstream check (self-send, the caller's
    own workspace, who "you" is in cli_list_targets) is made against the live
    pane, so following the alias costs no protection.

    What is still refused is an id that resolves to nothing at all: a pane that
    was closed, or one whose window has been gone long enough to be forgotten.
    Acting on that would leave the sender resolving to nobody — every
    same-workspace name becomes "unknown target", the pane fails its own
    self-send check (so it can message itself in a loop), and the recipient is
    shown an unaddressable sender.
    """
    from agent_team_backend import agent_messaging
    from agent_team_backend.mcp_server import auth, wiring as mcp_wiring

    request = getattr(ctx.request_context, "request", None)
    params = getattr(request, "query_params", None)
    if params is None:
        raise CallerUnknown(_UNWIRED)
    token = str(params.get("t") or "")
    client = str(params.get("client") or "")
    if client == "host":
        if not secrets.compare_digest(token, auth.internal_token()):
            raise CallerUnknown(_HOST_TOKEN_REJECTED)
        return _Caller(kind="host")
    if client == "external":
        if not auth.external_enabled():
            raise CallerUnknown(_EXTERNAL_DISABLED)
        if not secrets.compare_digest(token, auth.external_token()):
            raise CallerUnknown(_EXTERNAL_TOKEN_REJECTED)
        return _Caller(kind="external")
    pane_id = str(params.get("pane") or "")
    if not pane_id:
        raise CallerUnknown(_UNWIRED)
    if not secrets.compare_digest(token, mcp_wiring.caller_token()):
        raise CallerUnknown("caller token rejected; reopen the pane to re-wire it")
    entry = agent_messaging.current(pane_id)
    if entry is None:
        if agent_messaging.was_forgotten(pane_id):
            raise CallerUnknown(_STALE)
        if pane_id not in _logged_unregistered:
            # Once per id: a CLI that keeps calling would otherwise write the
            # same line on every tool call for the rest of its life.
            _logged_unregistered.add(pane_id)
            _log.warning("plan-mcp: refused pane %s — it was never registered", pane_id)
        raise CallerUnknown(_UNREGISTERED)
    return _Caller(kind="pane", pane_id=entry.pane_id)


def _target_view(entry: Any, same_workspace: bool) -> dict[str, Any]:
    """One addressable pane, as cli_list_targets reports it."""
    view: dict[str, Any] = {
        "name": entry.name,
        "address": entry.qualified_name,
        # The messaging tools address a pane by `address`; every ui.pane.* action
        # takes this instead. Without it here the roster names panes it cannot
        # tell you how to focus or close, and the id↔name map is only reachable
        # through ui_snapshot, whose shape nothing documents.
        "pane_id": entry.pane_id,
        "workspace_path": entry.workspace_path,
        "same_workspace": same_workspace,
        "busy": entry.busy,
        "offline": entry.offline,
        # False for a cold-restore placeholder: the window holds the saved pane
        # but no CLI is running behind it, so it reads as busy forever and a
        # message for it parks until someone opens it. Open it with ui.pane.open
        # (ui_invoke) or cli_send(open_target=True).
        "realized": entry.realized,
    }
    # Absent, not null, when nothing is queued for the pane: a target with no
    # message in flight has no hold to report, and an explicit null would read
    # as "nothing is holding it", which is a different claim.
    hold_reason = _hold_reason_for(entry.qualified_name)
    if hold_reason:
        view["hold_reason"] = hold_reason
    # Only an embedded AI panel carries these (which window hosts it); a window
    # pane never sets them, so its view keeps exactly the keys it always had.
    if entry.surface:
        view["surface"] = entry.surface
    if entry.window_kind:
        view["window_kind"] = entry.window_kind
    return view


#: How long a read waits for one pane's git snapshot before leaving `git` off
#: that pane. The computation carries on and fills the cache for the next read.
_PANE_GIT_WAIT_S = 3.0


def _pane_cwd(pane_id: str) -> str:
    """Where the pane's CLI runs — its live terminal's cwd — or '' when unknown.

    Not the workspace: a pane opened in a linked worktree runs there, and its
    branch is the worktree's, not the workspace checkout's.
    """
    from agent_team_backend import app as _app

    # Read the service only if it exists: get_terminals() would create one, and
    # a roster read has no business starting the terminal service.
    service = getattr(_app, "_TERMINALS", None)
    sessions = list(getattr(service, "_sessions", {}).values())
    for session in sessions:
        if getattr(session, "pane_id", "") == pane_id and not getattr(session, "closed", True):
            return str(getattr(session, "cwd", "") or "")
    return ""


async def pane_git(pane_id: str, workspace_path: str) -> dict[str, Any] | None:
    """The pane's git snapshot, or None outside a repository or on a slow read."""
    from agent_team_backend import git_service

    path = _pane_cwd(pane_id) or workspace_path
    try:
        snapshot = await asyncio.wait_for(
            git_service.pane_git_snapshots.get(path), _PANE_GIT_WAIT_S
        )
    except Exception:  # noqa: BLE001 - timeout included: a decoration, never a failure
        return None
    return snapshot if snapshot.get("worktreeRoot") else None


async def _with_git(views: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Add `git` to each local target view that has one, in place."""
    snapshots = await asyncio.gather(
        *(pane_git(view["pane_id"], view["workspace_path"]) for view in views)
    )
    for view, snapshot in zip(views, snapshots):
        if snapshot is not None:
            view["git"] = snapshot
    return views


@server.tool()
async def cli_list_targets(ctx: Context) -> dict[str, Any]:
    """List the CLI panes you can send instructions to with cli_send.

    Returns {you, targets}. Each target: {name, address, pane_id,
    workspace_path, same_workspace, busy, offline, git?}. Address a pane in YOUR
    workspace by its bare name; a pane in another workspace window by the
    `<folder>/<pane>` address given here. A caller with no pane identity (host
    / external credential) has no "own workspace" — every target comes back
    with same_workspace false and "you" set to the credential kind ("host" or
    "external"); always use the qualified address. Read-only.

    Plain terminal panes (login shells) are listed too; cli_get_status reports
    their `agent_key` as "terminal", and whatever you cli_send one runs as a
    shell command — see cli_send.

    This is who exists, not who is related to you — the list carries no
    lineage. The panes you opened with cli_open_agent are yours to keep track
    of; that record lives in your own context, not in this answer. Refer to
    them however reads naturally when talking to the user; the word does not
    matter, remembering who you opened does.

    `pane_id` is that pane's internal id. It is the key every `ui.pane.*` action
    takes (`ui.pane.close`, `ui.pane.focus`, `ui.pane.getStatus` via ui_invoke)
    — those reject a pane NAME — and it is also accepted by cli_send,
    cli_send_and_wait, cli_read_log, cli_get_status and cli_wait_idle in place
    of an address. Prefer `address`: it is stable and readable, and it survives
    the pane being rebuilt. Reach for `pane_id` when an address cannot say
    which pane you mean — two targets below with the SAME address are two panes
    sharing a name, and every one of those tools refuses that address as
    "ambiguous-target" rather than guessing between them. Remote targets have no
    local id and carry none, so they can only be addressed by name.

    `offline` marks a pane whose Navide window has lost its connection: it still
    exists and is expected back, but sending to it fails until it returns.

    `git` appears on a local target whose pane works inside a git checkout:
    {branch, worktreeRoot, isLinkedWorktree, dirty, ahead, behind, fetchedAt}.
    It describes the checkout the pane's CLI runs in (its terminal's cwd, so a
    pane in a linked worktree reports that worktree), not the workspace folder.
    `branch` is the short sha when HEAD is detached; `dirty` is the number of
    `git status --porcelain` lines; `ahead` / `behind` count commits against
    `origin/main` (null when there is no origin/main); `fetchedAt` is when
    FETCH_HEAD was last written (ISO-8601 UTC, null when never fetched) —
    nothing here fetches, so ahead/behind are only as fresh as that. The
    snapshot is cached per worktree for up to ~30 s and refreshed early when
    Navide's git watcher sees a change, so a just-made edit can take that long
    to count. Absent outside a repository, or when git did not answer in
    time; remote targets never carry it.

    `hold_reason` appears on a target that has a cli_send message still waiting
    to go in, and names what is holding it ("typing", "mid-turn", "starting",
    "behind", …). It is the same reason the Messages panel shows, and it is
    what makes `busy` explainable — but it exists only while a message sent
    from here is queued for that pane, so its absence says nothing.

    `remote_targets` appears only when this machine is linked to a Navide-Server
    and that server knows of panes on *other* machines. Those are a separate
    list because they are a separate deal: their `address` is the three-part
    `<device>/<workspace>/<pane>` form, the message travels through the server
    (so it can fail in ways a local one cannot — the far machine may be offline,
    or refuse on policy grounds), and there is no reading their output from
    here. Each carries `device` (the machine's human-readable label, or its id
    when the server knows no name), `host_online` (that whole machine is
    reachable) and `status` (the server's own word for the pane). `offline` is
    true when either half says the message would not land right now. Prefer a
    local target when one would do.

    Four tools take that three-part address: cli_send, cli_send_and_wait,
    cli_get_status and cli_wait_idle. So a remote pane can be told something,
    asked something and watched — but never read, stopped or closed, because
    those three need the pane's own machine. Two of them say so: cli_interrupt
    refuses a remote address with "interrupt-local-only" and cli_close_agent
    with "close-local-only". cli_read_log does not — it has no remote branch,
    so the address falls through to the local lookup and comes back
    "unknown-target", which reads like a typo and is not one. `pane_id` is no
    way around any of it: remote targets carry none, so the three-part name is
    the only handle there is.

    That key being absent covers two situations that are not the same: this
    machine has no server link at all, or it has one and no other machine has a
    pane open. cli_whoami's `cloud` key tells them apart, and only the first is
    something the user can go do anything about. Linking itself — signing in,
    pairing a device, trusting or blocking one — moves trust state and is on no
    tool by design: it is the user's to do in Navide's account window, so say
    that rather than looking for a tool that would do it for them.
    """
    from agent_team_backend import agent_messaging, remote_roster

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"error": str(err), "targets": []}
    if caller.kind == "pane":
        me_entry = agent_messaging.get(caller.pane_id)
        targets = [
            _target_view(
                entry, bool(me_entry and me_entry.workspace_path == entry.workspace_path)
            )
            for entry in agent_messaging.list_panes()
            if entry.pane_id != caller.pane_id
        ]
        result = {"you": me_entry.qualified_name if me_entry else None, "targets": targets}
    else:
        targets = [_target_view(entry, False) for entry in agent_messaging.list_panes()]
        result = {"you": caller.kind, "targets": targets}
    await _with_git(targets)
    # Absent, not empty, when there is nothing to say: a machine with no server
    # configured has an empty roster and must see byte-for-byte the answer it
    # saw before cross-device addressing existed.
    remote = [pane.to_dict() for pane in remote_roster.list_panes()]
    if remote:
        result["remote_targets"] = remote
    return result


@server.tool()
async def cli_whoami(ctx: Context) -> dict[str, Any]:
    """Your own entry, in the same shape cli_list_targets gives you for others.

    cli_list_targets deliberately leaves you out of its `targets` and names you
    only as `you`, a single address string. So every field it hands you about
    everyone else — `pane_id` above all — was the one thing you could not learn
    about yourself. That is what this answers. Read-only.

    `pane_id` is why this exists. It is the key every `ui.pane.*` action takes
    (`ui.pane.close`, `ui.pane.focus`, `ui.pane.getStatus` via ui_invoke) and
    those REFUSE a pane name, so without it you could close or focus any pane
    but your own. It also disambiguates you to cli_read_log and cli_get_status
    when another pane in your workspace shares your name — an address both of
    them refuse as "ambiguous-target".

    `spawned_by` names the pane that opened you, when one did, as
    {pane_id, name, address}. This is the only place that fact survives: the
    name of whoever opened you was written into the words of your kickoff task
    and nowhere else, so a compaction of your context loses it permanently —
    along with any idea of who your finished work should go back to. When that
    pane has since closed, only `pane_id` comes back alongside `gone: true`;
    the key is absent entirely when nobody opened you.

    This is a fact about yourself, not the roster's lineage: cli_list_targets
    still says nothing about who is related to whom, and who *you* opened is
    still yours alone to remember.

    `waiting_on_me` is who is BLOCKED on you at this moment — every caller
    currently parked in a cli_wait_idle or cli_send_and_wait aimed at your
    pane, as [{waiting_s, pane_id?, name?, address?, caller?}], longest wait
    first. Waiting was one-way before this: someone could sit on a two-minute
    budget while you, deciding you had another twenty minutes of digging in
    you, had no way to learn that finishing now was worth more than finishing
    well. Read it before committing to a long stretch of work — a waiter at 90
    seconds is about to time out. `caller` ("host" / "external") stands in for
    a waiter that has no pane and therefore no name. The key is ABSENT when
    nobody is waiting; it is never an empty list. It is also process memory: a
    backend restart forgets every wait, so absence is "nobody is parked on me
    that this backend knows of", not proof that nobody wants your answer.

    `cloud` says whether this machine is linked to a Navide-Server, which is
    what decides whether panes on the user's OTHER machines can be addressed at
    all. `state` is "connected" when they can, and "connecting", "unreachable",
    "unauthorized" or "waiting-for-keychain" when the link exists but is not
    carrying anything right now — each one a different thing to tell the user.
    `device_id` is this machine's own id once the server has issued one. The
    key is ABSENT when no link is configured. Read it when cli_list_targets
    came back with no `remote_targets`: that absence means "no server" and "a
    server, but no pane open on any other machine" alike, and this is what
    tells the two apart. Nothing here is a control: signing in, pairing a
    device, trusting or blocking one all move trust state, so they are the
    user's to do in Navide's account window and are deliberately on no tool.

    `delegation_hint` restates the rule for where delegated work goes (a
    Navide pane via cli_open_agent rather than your own subagents) so that a
    pane which never read the server instructions still meets it here.

    A caller with no pane identity (host / external credential) is not a pane
    and has none of these: it gets {ok, caller} only.
    Returns {ok, caller, name, address, pane_id, workspace_path, agent_key,
    busy, offline, delegation_hint, hold_reason?, surface?, window_kind?,
    spawned_by?, waiting_on_me?,
    cloud?} or {ok: false, error}.
    """
    from agent_team_backend import agent_messaging

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    if caller.kind != "pane":
        return {"ok": True, "caller": caller.kind}
    me = agent_messaging.get(caller.pane_id)
    if me is None:
        return {
            "ok": False,
            "error": "your pane is no longer registered — reopen it to re-wire it",
        }
    # Built through the very function cli_list_targets uses for everybody else:
    # the asymmetry being closed here is that you saw a different shape for
    # yourself than for a peer, and two hand-written dicts would reopen it the
    # first time one of them gained a field.
    result: dict[str, Any] = {"ok": True, "caller": "pane"}
    result.update(_target_view(me, True))
    # Not in _target_view because a peer's is on the roster elsewhere; yours is
    # not reported anywhere at all, and it is what tells you which CLI you are.
    result["agent_key"] = me.agent_key
    result["delegation_hint"] = DELEGATION_RULE
    if me.spawned_by:
        # Through `current`, not `get`: a parent that was rebuilt around its
        # still-running CLI answers to a new id, and the retired one is exactly
        # what a child mirrored before the rebuild.
        parent = agent_messaging.current(me.spawned_by)
        if parent is None:
            result["spawned_by"] = {"pane_id": me.spawned_by, "gone": True}
        else:
            result["spawned_by"] = {
                "pane_id": parent.pane_id,
                "name": parent.name,
                "address": parent.qualified_name,
            }
    # Absent, not empty, like every optional key here: a pane nobody is waiting
    # on must read byte-for-byte as it did before anyone could wait visibly.
    waiting = _waiting_on_me(me.pane_id)
    if waiting:
        result["waiting_on_me"] = waiting
    # Absent on an unlinked machine, for the same reason every optional key
    # here is: it must read byte-for-byte as it did before cross-device
    # addressing existed. Present the moment there is a link, because that is
    # the one question cli_list_targets cannot answer — a missing
    # `remote_targets` means "no server" and "a server, but nobody else has a
    # pane open" alike, and only the first of those is worth telling the user
    # to go fix.
    from agent_team_backend import server_link

    state = server_link.link_state()
    if state != server_link.STATE_UNCONFIGURED:
        cloud: dict[str, Any] = {"state": state}
        device_id = server_link.local_device_id()
        if device_id:
            cloud["device_id"] = device_id
        result["cloud"] = cloud
    return result


# Spawn verdicts come from the window that owns the requesting pane — only it
# knows the pane counts, chain depth and name collisions the gate needs. The
# tool waits for that verdict instead of reporting "requested", so the agent
# learns whether it actually got a pane and, if not, why.
#
# The verdict lands once the pane exists, not once its CLI has booted. The
# KICKOFF verdict follows separately: the window emits agent_spawn.kickoff once
# the task's injection settles (sent / unverified / failed), and the tool waits
# for that too before answering — a cold CLI can take tens of seconds to reach
# its prompt, and "ok" without the kickoff was read as "delivered" by every
# caller, who then never learned the pane sat idle with an empty prompt.
_SPAWN_VERDICT_TIMEOUT_S = 40.0
_KICKOFF_VERDICT_TIMEOUT_S = 45.0
_pending_spawns: dict[str, asyncio.Future[dict[str, Any]]] = {}
_pending_kickoffs: dict[str, asyncio.Future[dict[str, Any]]] = {}


def resolve_spawn(request_id: str, verdict: dict[str, Any]) -> bool:
    """Hand a window's verdict to the waiting cli_open_agent call."""
    future = _pending_spawns.get(request_id)
    if future is None or future.done():
        return False
    future.set_result(verdict)
    return True


def resolve_kickoff(request_id: str, verdict: dict[str, Any]) -> bool:
    """Hand a window's kickoff verdict ({pane_id, kickoff, reason?}) to the
    cli_open_agent call waiting on it."""
    future = _pending_kickoffs.get(request_id)
    if future is None or future.done():
        return False
    future.set_result(verdict)
    return True


def _refuse_unsupported_model(agent_key: str, model: str, effort: str) -> str:
    """Why this CLI cannot be asked for that model or effort, or "" if it can.

    Checked here, before the request is broadcast, so an unsupported ask is
    answered at once instead of waiting out the spawn verdict and then
    reporting a timeout that blames the window. The capability mirrors the
    frontend spec, which owns the flags themselves; the guard test in
    test_cli_vendors_registry.py keeps the two from drifting.
    """
    # Trimmed here rather than trusting the caller, so this helper gives the
    # same answer as the renderer's modelArgsFor for any input. cli_open_agent
    # already strips; a future caller that forgets would otherwise get a
    # backend/renderer disagreement instead of a refusal.
    from agent_team_backend.model_args import refuse_unsafe_shape

    # Trimmed here rather than trusting the caller, so this helper gives the
    # same answer as the renderer's modelArgsFor for any input.
    model = model.strip()
    effort = effort.strip()
    if not model and not effort:
        return ""
    from agent_team_backend.cli_vendors import registry

    # Shape first, and regardless of what this vendor supports: a value that
    # would split into extra arguments is malformed no matter who receives it,
    # and saying "unsupported" here would send the caller off to try another
    # CLI with the same injected string.
    unsafe = refuse_unsafe_shape(model, effort)
    if unsafe:
        return unsafe
    spec = registry.VENDORS.get(agent_key)
    if spec is None:
        return ""  # unknown agent key — the spawn gate reports that itself
    if model and not spec.supports_model:
        return (
            f"{agent_key} cannot be told which model to run at launch, so this "
            f"would have started on its default. Open it without `model`, or "
            f"pick a CLI that takes one."
        )
    if effort and not spec.supports_effort:
        if spec.supports_model:
            return (
                f"{agent_key} has no separate effort setting — it takes effort "
                f"as part of the model id (like `gpt-5.3-codex-high`). Put it "
                f"in `model` instead."
            )
        return f"{agent_key} cannot be told a reasoning effort at launch."
    if effort and spec.known_efforts and effort not in spec.known_efforts:
        accepted = ", ".join(spec.known_efforts)
        return f"{agent_key} does not accept effort {effort!r}. It accepts: {accepted}."
    return ""


#: Characters a session id may contain. Every vendor's ids are drawn from this
#: set — UUIDs (claude, cursor, copilot, qwen, pi), hex (grok), `ses_`-prefixed
#: slugs (opencode, kilo), `session_<uuid>` directory names (kimi) — and codex's
#: is a path, which is why `/` is in it.
#:
#: This is a SHELL SAFETY boundary, not a formatting preference. buildResumeCommand
#: interpolates the id into a command string that is run as `[shell, '-ilc', cmd]`,
#: so an id carrying `;` or a backtick is code, not an argument. The on-disk check
#: below is not sufficient on its own: a filename may legally contain a semicolon
#: and a space, so anything that can write into a vendor's session directory could
#: otherwise turn a resume into arbitrary execution.
_SAFE_SESSION_ID = re.compile(r"^[A-Za-z0-9._:/-]{1,255}$")


def _refuse_unresumable_session(
    agent_key: str, workspace_path: str, session_id: str
) -> dict[str, Any] | None:
    """Why this CLI cannot resume that session id, or None when it can.

    Checked before the spawn is broadcast for the same reason the model guard
    is: a pane that opens and silently starts a fresh conversation looks
    exactly like a successful resume until someone reads the transcript, and by
    then the caller has already sent a follow-up that makes no sense to a CLI
    with no memory of what it follows.

    The existence check is the vendor's own (``app._session_exists``), which is
    what the renderer's resume preflight uses, so a refusal here and a greyed
    out Rebuild button in the UI agree on what "resumable" means.
    """
    from agent_team_backend import app
    from agent_team_backend.cli_vendors import registry

    # Shape first, and regardless of which vendor is being asked: an id that
    # could split into extra shell words is malformed no matter who receives
    # it, and answering "unknown session" there would send the caller off to
    # try the same string against another CLI.
    if not _SAFE_SESSION_ID.match(session_id):
        return {
            "ok": False,
            "error": (
                "session_id may only contain letters, digits and . _ : / - — "
                "it is interpolated into the launch command, so anything else "
                "would be read as shell syntax rather than as an id"
            ),
            "error_code": "malformed-session-id",
        }
    spec = registry.VENDORS.get(agent_key)
    if spec is None:
        return None  # unknown agent key — the spawn gate reports that itself
    # A vendor with no session ids cannot be asked for one. aider is the only
    # such CLI: it restores from a chat-history FILE, so there is no id to name
    # and nothing this argument could mean. Read from the declared capability,
    # never from `session_exists is None` — several vendors resume perfectly
    # well through app._session_exists' path fallback without declaring one.
    if not spec.supports_session_resume:
        return {
            "ok": False,
            "error": (
                f"{agent_key} has no session ids to resume — it restores from a "
                f"chat-history file instead. Open it without `session_id`."
            ),
            "error_code": "no-session-support",
        }
    if not workspace_path:
        return {
            "ok": False,
            "error": (
                "resuming a session needs a workspace to look it up in — pass "
                "workspace_path"
            ),
            "error_code": "workspace-required",
        }
    if app._session_exists(agent_key, workspace_path, session_id):
        return None
    return {
        "ok": False,
        "error": (
            f'{agent_key} has no session "{session_id}" in {workspace_path} — '
            f"opening it would have started a fresh conversation that looks "
            f"resumed. Read a current id from cli_list_sessions"
        ),
        "error_code": "unknown-session-id",
    }



def _inherited_taint(caller: _Caller, verb: str) -> str:
    """The taint detail a caller passes on to panes it has the window start,
    or "" when it passes none: a tainted pane or an MCP client does."""
    from agent_team_backend.guard.taint import is_tainted

    try:
        inherits = caller.kind == "external" or (caller.kind == "pane" and is_tainted(caller.pane_id))
    except Exception:  # noqa: BLE001 - marking only adds friction, so fail closed
        inherits = True
    return f"{verb} by {caller.pane_id or caller.kind}" if inherits else ""


def _taint_spawned(caller: _Caller, pane_id: str) -> None:
    """Navide Guard: a spawned pane's task is typed by the window, not sent
    through _dispatch_delivery, so it would start unmarked. A tainted pane (or
    an MCP client) must not launder its instructions through a fresh pane."""
    if not pane_id:
        return
    from agent_team_backend.guard.taint import safe_mark_tainted

    detail = _inherited_taint(caller, "opened")
    if detail:
        safe_mark_tainted(pane_id, "agent", detail)

#: agent key of a plain login-shell pane (see cli_open_agent / cli_send).
_TERMINAL_AGENT = "terminal"

#: Whether this platform can tell a terminal's shell at its prompt from a
#: program it started (tcgetpgrp). Windows cannot: its PTY handle reports the
#: shell as the foreground whatever runs, so the window falls back to holding
#: only while the terminal prints — and every answer about a terminal says so.
_TERMINAL_PROMPT_CHECK = _osplat.terminal_backend.reports_foreground
_TERMINAL_NO_PROMPT_CHECK = (
    "this platform cannot tell whether the terminal's shell is at its prompt: "
    "a quiet running program (an editor, a password prompt, a REPL) may receive "
    "the text as its own input — check cli_read_log before sending"
)


@server.tool()
async def cli_open_agent(
    agent: str,
    name: str,
    task: str,
    ctx: Context,
    workspace_path: str = "",
    model: str = "",
    effort: str = "",
    pane_id: str = "",
    session_id: str = "",
    run_group_id: str | None = None,
) -> dict[str, Any]:
    """Open a new CLI pane and give it a task.

    Delegation rule: work that edits files, runs longer than a few minutes, or
    that the user may want to watch, interrupt or take over goes to a Navide
    CLI pane via cli_open_agent — not to your own subagent facility (Agent /
    Task tools). A pane is visible in Navide, can be opened mid-run and
    outlives your session; a subagent is a black box that hands back one
    summary. Keep subagents for short read-only lookups whose whole result is
    a paragraph.

    `agent` is the CLI to run (e.g. "claude", "codex"), `name` is what the pane
    will be called — that name is also its messaging address, so pick something
    role-shaped like "reviewer" — and `task` is what it should do.

    `agent: "terminal"` opens a plain login-shell pane instead of an agent.
    Its `task` is optional: a shell command line typed once after the prompt
    is up, exactly as given — nothing is appended, so the report-back advice
    below does not apply (a shell cannot report). Empty `task` opens it on a
    bare prompt. `model`, `effort` and `session_id` are refused for it. Its
    kickoff is typed once and never retyped (a retype would run the command
    twice), so an unconfirmed one answers "unverified": read cli_read_log
    before resending. A destructive `task` is refused before the pane opens
    (error_code "terminal-command-refused" — see cli_send). Talk to it
    afterwards with cli_send — see there.

    The pane you open is related to you: you opened it, so its result needs to
    come back to you. When you talk to the user about it, use whatever reads
    naturally — partner, junior, the one you sent out, your child agent. No
    word is prescribed and none is more correct than another; what matters is
    not the label but that you remember who you opened.

    Say both of these in `task`: who opened it (your own name, from
    cli_list_targets' `you`), and who to send the result to when it is done.
    Without that line it finishes, writes the answer to its own screen, and
    nobody ever sees it.

    Pane callers open the pane in their own workspace; `workspace_path` is
    ignored for them. A caller with no pane identity (host / external
    credential) has no workspace of its own, so `workspace_path` is required —
    the pane opens there with no parent, so it has no child/depth counts of
    its own; the workspace's CLI-pane count is still tracked for the advisory
    below.

    `run_group_id` optionally chooses an existing tab group in the pane's
    workspace. Omit it (or pass null) to keep the usual parent/resume/active
    tab placement. `""` explicitly selects the ungrouped manual tab. Nonempty
    ids must belong to that workspace; read them from ui_snapshot or
    cli_list_sessions. This overrides a resumed conversation's saved group,
    but keeps its saved parent. It cannot be combined with `pane_id`: reopen
    that pane first, then use cli_place_pane to move it.
    When explicitly requested, a successful answer includes `run_group_id`.

    `ok: true` means the pane exists, and `kickoff` says whether the task
    reached it. The call blocks until the window has booted the CLI, waited
    for its prompt and typed the task (up to ~45s on top of the spawn), then
    answers `kickoff: "sent"` — our own text was observed landing and being
    submitted — or `kickoff: "failed"`: the injection could not be verified
    after a bounded retry, or no verdict arrived in time. A failed kickoff is
    still `ok: true` (the pane is open; do NOT open it again) and comes with
    `hint` and the window's reason in `advisories`. FOLLOW THE HINT: when the
    window saw the task not go in, it says to resend with cli_send to the
    returned address; when the window could not tell (its text may be sitting
    in the composer, or it was still typing when the deadline hit), it says to
    read cli_get_status first — a blind resend there doubles the task.
    For a pane caller, the new pane is asked to report its result to you by
    message when it finishes — but that report is the child agent's own
    output, not a guarantee from Navide: it is held until you are between
    turns, and nothing arrives if the child never writes the block. Poll
    cli_get_status / cli_wait_idle whenever you need to be sure it is still
    working. An external or host caller gets no such message at all and must
    poll.

    `model` names the model the new pane runs, and `effort` its reasoning
    level. Both are optional, and asking a CLI that cannot take them is
    REFUSED rather than ignored — otherwise the pane would start on the
    default and look no different from one that got what it asked for.

    That guarantee covers the vendor, not the value: a CLI that accepts
    `--model` may still reject the id itself, and several report that only
    briefly before continuing on their default. So a refusal here means the
    pane did not open, while silence means it opened — not that the model was
    recognised. Which CLIs accept them differs: most take a
    model, only some take a separate effort — the rest encode effort in the
    model id itself (cursor's `gpt-5.3-codex-high`), and two take neither.
    The refusal names what that CLI accepts, so ask for what you want and
    read the error rather than guessing first. Model ids are not checked
    here — an unknown one is the CLI's own error to report — but effort is
    checked against that CLI's vocabulary before the pane opens.

    Use the returned name, not the one you asked for: a concurrent request may
    have taken that name, in which case yours gets a suffix.

    Refused when the name is taken, the agent key is unknown, or the task is
    empty. A high child/workspace/depth count never refuses the spawn — it
    just gets logged as a diagnostic warning and, on success, also returned
    here as `advisories` (a list of human-readable notes; the key is absent
    when there is nothing to report).
    `pane_id` is the new pane's internal id — the key `ui.pane.close`,
    `ui.pane.focus` and `ui.pane.getStatus` take through ui_invoke, all of which
    refuse a pane NAME. Keep it if you may want to close or focus what you
    opened; `address` remains the right thing to send to.
    Returns {ok, name, address, pane_id, kickoff, hint?, advisories?} or
    {ok: false, error}.

    Passing `pane_id` REOPENS an existing pane instead of creating one: the
    one whose cli_list_targets row says `realized: false` — a restore
    placeholder holding a saved pane with no CLI behind it. Use the id, not the
    name: the placeholder already owns that name, so asking for it by `name`
    opens a second pane called `<name>-2` and leaves the first one closed.
    `agent`, `name` and `task` are ignored on this path — the pane keeps its
    own, and nothing is injected; send the task with cli_send afterwards (or
    use cli_send(open_target=True) to do both at once). Answers {ok, pane_id,
    name, address, realized, reason, reopened: true}; `reason: "fresh"` means
    a new session with no memory of the earlier conversation. A pane that is
    already open answers reopened: false, reason "already-open" and is left
    alone. Unknown ids are refused with "unknown-pane-id".

    `session_id` opens a NEW pane that RESUMES an existing conversation — the
    CLI's own session id, not a Navide pane id. This is what `pane_id` cannot
    do: a placeholder can only ever resume the one conversation its own record
    remembers, while this takes any session the vendor still has on disk,
    including one started outside Navide in a plain terminal. Read the ids from
    cli_list_sessions. The pane opens with the vendor's own resume syntax
    (`claude --resume <id>`, `codex resume <id>`, `opencode --session <id>`, …)
    so it starts with the earlier conversation's memory intact, and `task` is
    then typed into it as usual — send the follow-up, not a restatement of what
    that conversation already knows.

    The id is checked against the vendor's own session store before the pane
    opens: an id with nothing on disk is REFUSED with "unknown-session-id"
    rather than opening a pane that silently starts fresh, which is
    indistinguishable from a successful resume until you read the transcript.
    `session_id` and `pane_id` are mutually exclusive — one reopens a pane
    Navide already holds, the other opens a new pane onto an old conversation.
    aider has no session ids at all and is refused.
    """
    from agent_team_backend import agent_messaging, app
    from agent_team_backend.ipc import make_event

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    reopen_id = (pane_id or "").strip()
    resume_id = (session_id or "").strip()
    if reopen_id and resume_id:
        return {
            "ok": False,
            "error": (
                "pane_id and session_id are mutually exclusive — pane_id reopens a "
                "pane Navide already holds, session_id opens a new pane onto an "
                "existing conversation. Pass one"
            ),
            "error_code": "conflicting-target",
        }
    if reopen_id:
        if run_group_id is not None:
            return {
                "ok": False,
                "error": "run_group_id cannot be combined with pane_id — reopen the "
                "pane first, then move it with cli_place_pane",
                "error_code": "conflicting-target",
            }
        return await _reopen_pane(reopen_id)
    agent_key = (agent or "").strip()
    pane_name = (name or "").strip()
    if not agent_key:
        return {"ok": False, "error": "agent is required (e.g. \"claude\", \"codex\")"}
    if not pane_name:
        return {"ok": False, "error": "name is required — it doubles as the pane's address"}
    # A fresh pane with nothing to do is a mistake; a RESUMED one is not — the
    # conversation already has its own context and the caller may only want it
    # back on screen, talking to it later with cli_send. So an empty task is
    # refused only when there is no session to resume.
    if not (task or "").strip() and not resume_id and agent_key != _TERMINAL_AGENT:
        return {"ok": False, "error": "task is empty"}
    if agent_key == _TERMINAL_AGENT and ((model or "").strip() or (effort or "").strip() or resume_id):
        return {
            "ok": False,
            "error": "a terminal pane is a plain shell — it takes no model, effort or session_id",
        }
    refusal = _refuse_unsupported_model(agent_key, (model or "").strip(), (effort or "").strip())
    if refusal:
        return {"ok": False, "error": refusal}
    target_workspace = ""
    if caller.kind == "pane":
        me = caller.pane_id
    else:
        me = ""
        target_workspace = (workspace_path or "").strip()
        if not target_workspace:
            return {
                "ok": False,
                "error": "workspace_path is required for a caller with no pane identity",
            }
    if run_group_id:
        group_workspace = target_workspace or _caller_workspace(caller)
        project = await asyncio.to_thread(app.project_store.peek, group_workspace)
        groups = project.ui_run_groups if project is not None else None
        if not any(group.get("id") == run_group_id for group in (groups or [])):
            return {
                "ok": False,
                "error": f'unknown run group "{run_group_id}" in {group_workspace}',
                "error_code": "unknown-run-group",
            }
    if resume_id:
        # A pane caller's own workspace is where its sessions live, so it never
        # has to name one; the fallback matches every other tool's default.
        resume_workspace = target_workspace or _caller_workspace(caller)
        # Off the loop: for claude this is an iterdir + a stat per project dir
        # under ~/.claude/projects, for kimi a glob — the same call
        # _session_rows already offloads for the same reason.
        refusal = await asyncio.to_thread(
            _refuse_unresumable_session, agent_key, resume_workspace, resume_id
        )
        if refusal:
            return refusal
        # Resuming is not opening a new pane under the caller — it is putting a
        # conversation back where it was. Read the position the pane that last
        # held it sat in; the window applies it instead of parenting to us.
        lineage = await asyncio.to_thread(
            _resume_lineage, resume_workspace, agent_key, resume_id
        )

    if agent_key == _TERMINAL_AGENT and (task or "").strip():
        # Checked before the pane exists: a refused first command should not
        # leave a shell behind that the caller then types into another way.
        refused = _terminal_refusal(
            task, workspace=target_workspace or _caller_workspace(caller), pane_id="", via="cli_open_agent"
        )
        if refused:
            return refused
    # The spawn request is a broadcast only the window holding the workspace
    # answers, and it is not replayed: sent before that window is up (a
    # workspace_open a moment ago) or with no such window at all, nobody would
    # answer and the call would sit out the whole verdict deadline. Make sure
    # someone is listening first, and say so plainly when nobody is.
    if target_workspace and not await _wait_window_ready(target_workspace):
        return {
            "ok": False,
            "error": (
                f"no Navide window holds {target_workspace} (none answered within "
                f"{_WINDOW_READY_TIMEOUT_S:.0f}s). Open it with workspace_open and "
                "retry once workspace_list shows window_ready for it; no pane was opened"
            ),
            "error_code": "window_not_ready",
        }
    request_id = f"{me or caller.kind}:spawn:{secrets.token_hex(8)}"
    loop = asyncio.get_running_loop()
    future: asyncio.Future[dict[str, Any]] = loop.create_future()
    _pending_spawns[request_id] = future
    # Registered BEFORE the broadcast: the standalone path types the task
    # before it answers the spawn, so its kickoff verdict can arrive first.
    kickoff_future: asyncio.Future[dict[str, Any]] = loop.create_future()
    _pending_kickoffs[request_id] = kickoff_future
    try:
        spawn_payload: dict[str, Any] = {
            "request_id": request_id,
            "requester_pane_id": me,
            "agent_key": agent_key,
            "name": pane_name,
            "task": task,
        }
        # Only sent when asked for: a window on an older build ignores keys it
        # does not know, and an empty one would be indistinguishable anyway.
        if (model or "").strip():
            spawn_payload["model"] = model.strip()
        if (effort or "").strip():
            spawn_payload["effort"] = effort.strip()
        if run_group_id is not None:
            spawn_payload["run_group_id"] = run_group_id
        # The window turns this into the vendor's own resume command; absent
        # means a fresh conversation, which is what every older build does with
        # a key it does not know.
        if resume_id:
            spawn_payload["session_id"] = resume_id
            # Sent even when empty: "" for resume_spawned_by is the real answer
            # for a conversation that was a root pane, and the window must put
            # it back at the root rather than fall through to parenting it on
            # the caller. Only the presence of session_id enables the branch.
            spawn_payload["resume_spawned_by"] = lineage.get("spawned_by", "")
            spawn_payload["resume_run_group_id"] = lineage.get("run_group_id", "")
        if target_workspace:
            # No parent pane owns this request — the owning window is decided
            # by workspace match instead (see App.vue's agent_spawn.request
            # handler).
            spawn_payload["target_workspace"] = target_workspace
        await app.broadcast(make_event("agent_spawn.request", spawn_payload))
        verdict = await asyncio.wait_for(future, timeout=_SPAWN_VERDICT_TIMEOUT_S)
    except asyncio.TimeoutError:
        _pending_kickoffs.pop(request_id, None)
        return {
            "ok": False,
            "error": "no answer from the window that owns your pane — it may have "
            "closed. Check cli_list_targets before retrying: the pane may exist "
            "already, in which case reopening it would duplicate the work",
        }
    except BaseException:
        # Nobody is left to answer the kickoff either (a broadcast that threw,
        # a cancelled call) — drop it with the spawn rather than leaking it.
        _pending_kickoffs.pop(request_id, None)
        raise
    finally:
        _pending_spawns.pop(request_id, None)

    if not verdict.get("ok"):
        _pending_kickoffs.pop(request_id, None)
        return {"ok": False, "error": str(verdict.get("error") or "spawn refused")}
    _taint_spawned(caller, str(verdict.get("pane_id") or ""))
    # The pane exists; now the task. Waited for here rather than reported by
    # message: the caller acts on this answer, and "ok" alone was taken as
    # "delivered" by every caller that got it.
    try:
        kickoff_verdict = await asyncio.wait_for(
            kickoff_future, timeout=_KICKOFF_VERDICT_TIMEOUT_S
        )
    except asyncio.TimeoutError:
        # The window may still be typing it (a cold CLI plus its session
        # marker turn can outlast this deadline), so this is "unknown", not
        # "did not arrive" — the hint below must not say resend outright.
        kickoff_verdict = {
            "kickoff": "unverified",
            "reason": f"no kickoff verdict from the window within "
            f"{_KICKOFF_VERDICT_TIMEOUT_S:.0f}s — it may still be typing the task",
        }
    finally:
        _pending_kickoffs.pop(request_id, None)
    new_pane_id = str(verdict.get("pane_id") or "")
    entry = agent_messaging.get(new_pane_id)
    result: dict[str, Any] = {
        "ok": True,
        "name": str(verdict.get("name") or pane_name),
        "address": entry.qualified_name if entry else str(verdict.get("name") or pane_name),
    }
    # The id of the pane you just opened. Without it you could send to what you
    # opened but never close or focus it: every ui.pane.* action takes an id and
    # refuses a name, and the only other way to that id is finding your own
    # pane again in cli_list_targets. Absent, not empty, when the window
    # answered ok without naming a pane — an id that is the empty string would
    # be handed to ui.pane.close as if it addressed something.
    if new_pane_id:
        result["pane_id"] = new_pane_id
    # Present only on the resume path, and it is the id that was ASKED for: the
    # window was told to launch with it and the id was verified on disk before
    # the broadcast, but whether the CLI actually reloaded that transcript is
    # the CLI's own business and is not observable from here.
    if resume_id:
        result["resumed_session_id"] = resume_id
        # Where it was put back. Absent keys would read as "lineage unknown";
        # these are always present on a resume so the caller can see that the
        # pane went back to its own parent and group rather than under them.
        result["restored_lineage"] = {
            "spawned_by": lineage.get("spawned_by", ""),
            "run_group_id": run_group_id if run_group_id is not None else lineage.get("run_group_id", ""),
        }
    if run_group_id is not None:
        result["run_group_id"] = run_group_id
    advisories = list(verdict.get("advisories") or [])
    if agent_key == _TERMINAL_AGENT and not _TERMINAL_PROMPT_CHECK:
        result["prompt_check"] = "unavailable"
        advisories.append(_TERMINAL_NO_PROMPT_CHECK)
    # Two answers only. "unverified" is the window's honest word for "bytes
    # written, nothing seen" — to the caller that is a task that did not
    # arrive, and the cure is the same as for an outright failure.
    kickoff = str(kickoff_verdict.get("kickoff") or "")
    if kickoff == "sent":
        result["kickoff"] = "sent"
    elif kickoff == "failed":
        result["kickoff"] = "failed"
        result["hint"] = (
            f"the task never reached the pane's prompt — resend it with "
            f"cli_send(to=\"{result['address']}\", text=...); the pane is open, "
            f"do not open another"
        )
    else:
        # "unverified" (the window saw its text still sitting in the composer,
        # or could not tell) and the timeout above: the task may well be in.
        # A blind resend here is what doubles a task, so the caller is told to
        # look first.
        result["kickoff"] = "failed"
        result["hint"] = (
            f"the task could not be confirmed as delivered — it may already be "
            f"in the pane. Read cli_get_status(target=\"{result['address']}\") "
            f"first: resend with cli_send only if ui.kickoff is not \"sent\" and "
            f"ui.buffer shows an empty prompt; the pane is open, do not open another"
        )
    if kickoff != "sent":
        reason = str(kickoff_verdict.get("reason") or "")
        if reason:
            advisories.append(f"kickoff: {reason}")
    if advisories:
        result["advisories"] = advisories
    return result


async def _reopen_pane(pane_id: str) -> dict[str, Any]:
    """cli_open_agent(pane_id=...): open a restore placeholder in place."""
    from agent_team_backend import agent_messaging

    entry = agent_messaging.current(pane_id)
    if entry is None:
        return {
            "ok": False,
            "error": (
                f'unknown pane_id "{pane_id}" — it names no pane on this machine. '
                "Pane ids change when a pane is rebuilt; read a fresh one from "
                "cli_list_targets"
            ),
            "error_code": "unknown-pane-id",
        }
    if entry.realized:
        return {
            "ok": True,
            "pane_id": entry.pane_id,
            "name": entry.name,
            "address": entry.qualified_name,
            "realized": True,
            "reason": "already-open",
            "reopened": False,
        }
    opened = await _open_placeholder(entry)
    if not opened["ok"]:
        return {
            "ok": False,
            "error": (
                f'"{entry.qualified_name}" could not be opened ({opened["reason"]})'
            ),
            "error_code": "open-failed",
            "pane_id": entry.pane_id,
            "realized": False,
            "reason": opened["reason"],
        }
    pane = opened["pane"]
    return {
        "ok": True,
        "pane_id": pane.pane_id,
        "name": pane.name,
        "address": pane.qualified_name,
        "realized": True,
        "reason": opened["reason"],
        "reopened": True,
    }


def _pane_records_by_session(workspace_path: str) -> dict[tuple[str, str], Any]:
    """(agent, session_id) -> the pane record that conversation last lived in.

    A pane's record OUTLIVES the pane: closing one sets spawn_status
    "removed" rather than deleting it, so the lineage of a long-gone pane —
    who opened it, which tab group it sat in — is still on disk and a resumed
    conversation can be put back where it was.

    Several records can name one session (every rebuild writes a fresh one);
    the LAST wins, which is the pane that most recently held the conversation
    and therefore the position it was last in.
    """
    from agent_team_backend import app

    # peek, not load_or_create: the latter CREATES and saves a project document
    # (and emits project_created) for a workspace that has none, and this is
    # reached from cli_list_sessions — documented read-only and callable by an
    # external client with any directory as workspace_path.
    project = app.project_store.peek(workspace_path)
    if project is None:
        return {}
    found: dict[tuple[str, str], Any] = {}
    for pane in project.panes:
        session_id = (getattr(pane, "session_id", "") or "").strip()
        agent = (getattr(pane, "agent", "") or "").strip()
        if session_id and agent:
            found[(agent, session_id)] = pane
    return found


def _resume_lineage(workspace_path: str, agent_key: str, session_id: str) -> dict[str, str]:
    """Where the pane that last held this conversation sat: its parent and tab
    group, or empty strings when nothing is recorded.

    Empty `spawned_by` is a real answer, not a missing one — it means that pane
    was a root, and a resumed conversation belongs back at the root rather than
    under whoever happened to ask for it.
    """
    record = _pane_records_by_session(workspace_path).get((agent_key, session_id))
    if record is None:
        return {}
    return {
        "spawned_by": (getattr(record, "spawned_by", "") or "").strip(),
        "run_group_id": (getattr(record, "run_group_id", "") or "").strip(),
    }


#: How far back through the spawn history one cli_list_sessions call reads.
#: The store keeps up to 5000 entries and most of them are long-dead panes, so
#: a page is scanned and then filtered rather than the whole history — a
#: workspace with years of panes would otherwise stat every one of them.
_SESSION_SCAN_LIMIT = 400


def _session_rows(
    workspace_path: str, want_agent: str, limit: int, include_gone: bool
) -> tuple[list[dict[str, Any]], int]:
    """Resumable conversations for a workspace, newest first.

    Runs whole in a worker thread: the history read opens the workspace db and
    every row costs a filesystem check for the vendor's session file, which is
    exactly the kind of work that must not sit on the event loop.
    """
    from agent_team_backend import agent_messaging, app
    from agent_team_backend.cli_vendors import registry

    # Read once for the whole page: the lineage lives in the project document,
    # not in the spawn history, and opening it per row would be 400 reads.
    lineage = _pane_records_by_session(workspace_path)
    entries, _total = app.spawn_history_store.read_page(
        workspace_path, offset=0, limit=_SESSION_SCAN_LIMIT
    )
    rows: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    scanned = 0
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        scanned += 1
        session_id = str(entry.get("sessionId") or "").strip()
        agent_key = str(entry.get("agentKey") or "").strip()
        if not session_id or not agent_key:
            continue  # a pane that never bound a session has nothing to resume
        if want_agent and agent_key != want_agent:
            continue
        # One conversation, however many panes have pointed at it: a rebuilt or
        # restored pane writes a new history entry with the SAME session id, and
        # resuming any of them resumes the one conversation.
        key = (agent_key, session_id)
        if key in seen:
            continue
        seen.add(key)
        pane_id = str(entry.get("paneId") or "")
        # `live` is the claim "a CLI is holding this conversation open, so a
        # second reader would fork it". A registered entry is not enough: a
        # cold-restore placeholder is registered with realized=False and has
        # no CLI at all, and a closed pane lingers in the registry through
        # its offline grace. Both would steer the caller to cli_send against
        # a pane with no PTY.
        current = agent_messaging.current(pane_id) if pane_id else None
        live = current is not None and bool(getattr(current, "realized", True)) and not bool(
            getattr(current, "offline", False)
        )
        if not include_gone and not live:
            continue
        rows.append(
            {
                "session_id": session_id,
                "agent_key": agent_key,
                "pane_id": pane_id,
                "pane_name": str(entry.get("customName") or ""),
                "spawned_at": str(entry.get("spawnedAt") or ""),
                "removed_at": str(entry.get("removedAt") or ""),
                "starred": bool(entry.get("starred")),
                # Where this conversation sat. Resuming it puts a pane back in
                # the same place rather than under whoever asked, so these say
                # in advance where it will land; "" for spawned_by means it was
                # a root pane, which is a position too.
                "spawned_by": (
                    getattr(lineage.get((agent_key, session_id)), "spawned_by", "") or ""
                ),
                "run_group_id": (
                    getattr(lineage.get((agent_key, session_id)), "run_group_id", "") or ""
                ),
                # The pane that owned this conversation is still on screen. Its
                # CLI is holding the session open, so resuming it into a SECOND
                # pane is what forks or conflicts — talk to the live pane with
                # cli_send instead.
                "live": live,
                # The vendor's own answer, the same check the Rebuild button
                # uses — and the same capability gate cli_open_agent applies, so
                # a row marked resumable is one that tool will actually accept.
                # False means the transcript is gone from disk, or this CLI has
                # no id-based resume (aider), and the id would be refused.
                "resumable": (
                    getattr(
                        registry.VENDORS.get(agent_key), "supports_session_resume", True
                    )
                    and app._session_exists(agent_key, workspace_path, session_id)
                ),
            }
        )
        if len(rows) >= limit:
            break
    return rows, scanned


@server.tool()
async def cli_list_sessions(
    ctx: Context,
    agent: str = "",
    workspace_path: str = "",
    limit: int = 50,
    include_gone: bool = True,
) -> dict[str, Any]:
    """Conversations in this workspace a new pane could be opened onto.

    This is where the `session_id` cli_open_agent takes comes from. A CLI
    session outlives the pane that ran it: the pane is closed, the app is
    restarted, the pane is rebuilt — the vendor's transcript stays on disk, and
    naming its id opens a pane that starts with that conversation's memory
    rather than an empty one.

    Newest first. Each row is `{session_id, agent_key, pane_id, pane_name,
    spawned_at, removed_at, starred, live, resumable}`:

    - `resumable` is the vendor's own on-disk check — the same one behind the
      Rebuild button. **A row with `resumable: false` is history, not an
      option**: the transcript is gone and cli_open_agent refuses the id.
    - `live` says the pane that owned the conversation is still open. Resuming
      a live session into a second pane is what forks or corrupts it, because
      the CLI holding it does not expect a second reader — send to that pane
      with cli_send instead. Pass `include_gone: false` to see only live ones.
    - `pane_id` is the pane that owned it, and it may be gone; it is for
      recognising the row, not for addressing anything. Reopening a *placeholder*
      is cli_open_agent(pane_id=…), which is a different operation.

    `agent` narrows to one vendor key ("claude", "codex", …). `limit` is capped
    at 200, and one call scans the most recent few hundred panes rather than
    the whole history, so `scanned` says how deep it actually went. One
    conversation appears once however many panes pointed at it.

    A pane caller's own workspace is the default; a host or external caller has
    none and must pass `workspace_path`. Read-only — nothing here opens,
    closes or changes a pane.
    """
    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    chosen = (workspace_path or "").strip() or _caller_workspace(caller)
    if not chosen:
        return {
            "ok": False,
            "error": (
                "workspace_path is required for a caller with no pane identity — "
                "sessions are per project. Read one from workspace_list"
            ),
            "error_code": "workspace-required",
        }
    try:
        want = max(1, min(int(limit), 200))
    except (TypeError, ValueError):
        want = 50
    rows, scanned = await asyncio.to_thread(
        _session_rows, chosen, (agent or "").strip(), want, bool(include_gone)
    )
    result: dict[str, Any] = {
        "ok": True,
        "workspace_path": chosen,
        "sessions": rows,
        "count": len(rows),
        "scanned": scanned,
    }
    warning = await asyncio.to_thread(_workspace_mismatch_warning, chosen)
    if warning:
        result["warning"] = warning
    return result


async def _send_to_device(
    address: Any, text: str, *, caller: Any, me: str
) -> dict[str, Any] | None:
    """Relay a `<device>/<workspace>/<pane>` message through the server link.

    The relay itself is shared with the bare-line path (see message_routing);
    what is MCP's own is the msg_key bookkeeping that cli_check_message reads
    back, which exists nowhere else in the backend.

    Returns None when there is no link to relay over, so the caller can answer
    the way it always did for an unknown device.
    """
    from agent_team_backend import message_routing

    origin = me or caller.kind
    msg_key = f"{origin}:mcp:{secrets.token_hex(8)}"
    relayed = await message_routing.relay(
        address, text, from_pane_id=me, msg_key=msg_key
    )
    if relayed is None:
        return None
    if not relayed.ok:
        answer: dict[str, Any] = {
            "ok": False,
            "error": relayed.error,
            "error_code": relayed.code,
        }
        if relayed.code in message_routing.LINK_STATE_CODES:
            answer["link_state"] = relayed.link_state
            answer["last_error"] = relayed.last_error
        return answer
    _record_message_sent(msg_key, address.to_string(), origin, text)
    return {
        "ok": True,
        "target": address.to_string(),
        "cross_workspace": True,
        "msg_key": msg_key,
    }


async def _open_placeholder(entry: Any) -> dict[str, Any]:
    """Ask the window holding *entry* to open it (ui.pane.open) and re-read it.

    Returns {ok, realized, reason, pane} — `pane` is the registry entry the
    target is known by afterwards. A restore rebuilds the pane under a fresh
    runtime id and registers the old one as an alias, so the entry that was
    resolved before the open names a pane the window has already replaced;
    delivering to it would be dropped by the receiving window. `reason` is the
    renderer's word: "opened", "fresh" (a new session — resume behavior
    "never", or the user chose start-fresh — so the agent does not remember
    its earlier conversation), or why it stayed closed.
    """
    from agent_team_backend import agent_messaging

    ui = await _ui_request(
        entry.workspace_path,
        "invoke",
        caller=_pane_caller(entry.pane_id),
        action="ui.pane.open",
        args={"paneId": entry.pane_id},
    )
    outcome = (ui.get("result") or {}) if ui.get("ok") else {}
    if not ui.get("ok") or not outcome.get("realized"):
        return {
            "ok": False,
            "realized": False,
            "reason": outcome.get("reason") or ui.get("error_code") or ui.get("error") or "unknown",
            "pane": entry,
        }
    return {
        "ok": True,
        "realized": True,
        "reason": outcome.get("reason"),
        "pane": agent_messaging.current(entry.pane_id) or entry,
    }


#: Reserved `to:` value that fans a message out to the sender's own tab group.
#: Deliberately NOT the bare-line protocol's "all"/"*": that one means every
#: pane in the window, and one word meaning two scopes would be very hard to
#: debug. A pane actually named "group" therefore cannot be addressed by name —
#: the same trade-off "all" already carries.
GROUP_TARGET = "group"


def _is_group_target(to: str) -> bool:
    return (to or "").strip().lower() == GROUP_TARGET


def _is_chat_target(to: str) -> bool:
    """A chat sender (`telegram:alice`), as the window's isChannelTarget reads it."""
    from agent_team_backend.channels.registry import PLATFORMS

    platform, sep, _ = (to or "").strip().partition(":")
    return bool(sep) and platform in PLATFORMS


async def _send_to_group(
    caller: "_Caller", me: str, text: str, reply_to: str = "", kind: str = ""
) -> dict[str, Any]:
    """Deliver *text* to every other pane in the sender's own tab group.

    Groups are UI state the backend never learns — ``agent_msg.register``
    carries no group id — so the recipient set is asked of the window that owns
    the sender, and each recipient is then delivered to through the ordinary
    single-message path. That is what keeps a broadcast's per-recipient
    rate-limit budget, idle hold and delivery report identical to a direct send.
    """
    from agent_team_backend import agent_messaging

    sender = agent_messaging.get(me)
    if sender is None:
        return {
            "ok": False,
            "error": "your pane is no longer registered — reopen it to broadcast",
            "error_code": "unknown-target",
        }

    ui = await _ui_request(
        sender.workspace_path,
        "invoke",
        caller=_pane_caller(me),
        action="ui.groupPeers",
        args={"paneId": me},
    )
    if not ui.get("ok"):
        return {
            "ok": False,
            "error": ui.get("error") or "the window owning your pane did not answer",
            "error_code": ui.get("error_code") or "ui_action_timeout",
        }

    result = ui.get("result") or {}
    peers = result.get("peers") or []
    recipients: list[dict[str, Any]] = []
    for peer in peers:
        pane_id = str((peer or {}).get("pane_id") or "")
        name = str((peer or {}).get("name") or "")
        entry = agent_messaging.current(pane_id) if pane_id else None
        if entry is None or entry.offline:
            # The window listed it a moment ago; it went away in between. Say so
            # per recipient rather than failing the whole broadcast.
            recipients.append(
                {"name": name, "pane_id": pane_id, "accepted": False, "reason": "target-offline"}
            )
            continue
        msg_key = await _dispatch_delivery(
            entry, text, caller=caller, me=me, cross_workspace=False,
            reply_to=reply_to, kind=kind,
        )
        recipients.append(
            {"name": entry.name, "pane_id": entry.pane_id, "msg_key": msg_key, "accepted": True}
        )
    return {
        "ok": True,
        "broadcast": GROUP_TARGET,
        "group_id": str(result.get("group_id") or ""),
        "delivered_to": sum(1 for r in recipients if r["accepted"]),
        "recipients": recipients,
    }


def _terminal_refusal(text: str, *, workspace: str, pane_id: str, via: str) -> dict[str, Any] | None:
    """The tool answer for a command a terminal must not be typed, or None.
    See guard.terminal_policy: refused whatever the Guard switch says, audited,
    and shown on the pane; nothing is broadcast, so no window ever sees it."""
    from agent_team_backend.guard import terminal_policy

    refusal = terminal_policy.enforce(text, workspace=workspace, pane_id=pane_id, via=via)
    if refusal is None:
        return None
    return {
        "ok": False,
        "error": refusal.message(),
        "error_code": "terminal-command-refused",
        "refused": refusal.as_dict(),
    }


class TerminalExternalRefused(Exception):
    """External content (a chat channel, another device) addressed to a plain
    terminal pane. Refused here, before it is broadcast or taints anything:
    the renderer refuses it too, but a shell would run it, so the backend does
    not leave that to the window alone."""


TERMINAL_EXTERNAL_ERROR = (
    "external content is never typed into a plain terminal pane — the shell would run it"
)


async def _dispatch_delivery(
    entry: Any, text: str, *, caller: "_Caller", me: str, cross_workspace: bool,
    reply_to: str = "", kind: str = "", from_display: str = "",
    origin: str = "", taint_detail: str = "", taint_source: str = "agent",
) -> str:
    """Hand one message to the windows and record it; returns its msg_key.

    Shared by the single-target send and the group broadcast, which differ only
    in how they pick recipients — every message is delivered, rate-limited, held
    and reported exactly alike whichever way it was addressed.

    ``reply_to`` is a correlation id the caller is echoing back; it travels in
    the delivery payload under the same key the bare-line path uses
    (``agent_msg.route`` in ws_handlers), so the receiving window links the two
    rows through the one ``acceptRemoteMessage`` path either way. Absent unless
    the caller passed one, which keeps the payload a non-reply produces exactly
    what it always was.

    ``kind`` is "ack" for a message the receiving window must log and never
    inject, and empty for every other send. The group broadcast passes it
    through too: every group peer is a pane in the sender's own window, so an
    ack reaches each of them under the same guarantee a direct one gets. It
    rides the payload only when set, for the same reason ``reply_to`` does: an
    ordinary send produces exactly the payload it always did.
    """
    from agent_team_backend import agent_messaging, app
    from agent_team_backend.ipc import make_event

    if origin in ("channel", "remote") and getattr(entry, "agent_key", "") == _TERMINAL_AGENT:
        raise TerminalExternalRefused(TERMINAL_EXTERNAL_ERROR)
    sender = agent_messaging.get(me) if me else None
    msg_key = f"{me or caller.kind}:mcp:{secrets.token_hex(8)}"
    if kind != "ack" and (caller.kind in ("pane", "external") or taint_detail):
        # Navide Guard: text from another agent or an MCP client taints the
        # target. A host caller passes taint_detail when the text is
        # agent-authored (an agent's scheduled job); a chat channel passes its
        # own detail with taint_source="remote".
        from agent_team_backend.guard.taint import safe_mark_tainted

        sender_name = agent_messaging.readable_sender(me, from_display) if me else caller.kind
        safe_mark_tainted(entry.pane_id, taint_source, taint_detail or f"message from {sender_name}", msg_key)
    await app.broadcast(
        make_event(
            "agent_msg.deliver",
            {
                "msg_key": msg_key,
                "target_pane_id": entry.pane_id,
                "target_workspace_path": entry.workspace_path,
                "target_name": entry.name,
                "target_agent_key": entry.agent_key,
                "from_pane_id": me,
                # A chat channel names the chat sender ("telegram:alice") instead.
                "from_display": from_display or agent_messaging.sender_display(
                    me, "an external client" if caller.kind == "external" else "a host client"
                ),
                "from_workspace_path": sender.workspace_path if sender else "",
                "from_agent_key": sender.agent_key if sender else "",
                "cross_workspace": cross_workspace,
                "content": text,
                # The frontend applies the per-pair rate limit when it sends;
                # a message that entered here never passed through that, so the
                # receiving window has to apply it instead. Without this, two
                # agents replying to each other through cli_send have no loop
                # guard at all.
                "rate_limit": True,
                # Only present for a reply — see the docstring.
                **({"reply_to": reply_to} if reply_to else {}),
                # Only present for an ack — see the docstring.
                **({"kind": kind} if kind else {}),
                # "channel" for a chat-channel message, so the window can mark
                # it as external; absent otherwise.
                **({"origin": origin} if origin else {}),
            },
        )
    )
    _record_message_sent(msg_key, entry.qualified_name, me or caller.kind, text)
    return msg_key


@server.tool()
async def cli_send(
    to: str,
    text: str,
    ctx: Context,
    wait_for_delivery_s: float = 0.0,
    pane_id: str = "",
    reply_to: str = "",
    kind: str = "message",
    open_target: bool = False,
) -> dict[str, Any]:
    """Send an instruction to another CLI pane, in this or another workspace.

    `to` is a pane name for a pane in your own workspace, or `<folder>/<pane>`
    for one in another workspace window — cli_list_targets shows both forms. A
    caller with no pane identity (host / external credential) has no "own
    workspace" and must always use the qualified `<folder>/<pane>` form. The
    text is delivered verbatim and submitted for the receiving agent to act on,
    once that pane is idle; it is queued if the pane is mid-turn. An unknown or
    ambiguous target is refused rather than guessed.

    A chat sender (`telegram:alice`) is not a pane: answer it in your turn (an
    MSG block addressed to it), which Navide posts to your bound chat when the
    turn ends. Sent here, nothing goes out — the answer is {ok: true,
    handed_to_channel: true, note} and the text is dropped.

    A plain terminal pane (agent_key "terminal" in cli_get_status) is a
    login shell, not an agent: `text` is typed in bare — no sender line, no
    reply instructions — and Enter runs it as a shell command line with the
    user's privileges. It is held while anything but the shell is in front of
    its tty — a running command, an editor, a sudo/ssh password prompt, a REPL,
    printing or not — and for 60s after the user's last keystroke in it; it
    never gets a turn end, so cli_wait_idle / cli_send_and_wait settle on
    "quiet_period" for it; read cli_read_log for the result. Where the platform
    cannot see the shell's prompt (Windows) the answer carries
    `prompt_check: "unavailable"` and a warning, and it is held only while
    printing. Enter is pressed once: "delivered" means the line went in, not
    that the command succeeded. A multi-line `text` fails (send one line at a
    time) when the shell has no bracketed paste, and a message still queued
    after 2 minutes fails rather than running late. A terminal cannot reply, is
    left out of `to: "group"` broadcasts, and refuses content from a chat
    channel or remote device.

    Destructive commands are refused for a terminal, never typed — whatever
    the Guard switch says. The line is split into segments (; && || | &,
    newlines, $( ), backticks) and one refused segment refuses it all:
    anything Guard rates critical (high too, if the user turned that
    category on — it is off by default), recursive deletes of / ~ or outside
    the workspace (Remove-Item -Recurse C:\\ and rmdir /s too), sudo/su/doas,
    disk formatting and raw device writes, shutdown/reboot, killall/pkill,
    recursive chmod/chown on / or ~, writes into system folders, disabling
    services, fork bombs, piping a download into a shell, credential files,
    force-pushing main, and lines that cannot be judged statically. The answer
    is ok: false with error_code "terminal-command-refused" and `refused`
    {rule, segment, reason}; tell the user to run it themselves. The user
    tunes the categories and patterns in Settings → Security.

    `to: "group"` broadcasts instead: every other pane in YOUR OWN tab group,
    in your own workspace. Deliberately narrower than the bare-line protocol's
    `all`, which means every pane in the window regardless of group. Panes in no
    group share one implicit group, so they reach each other rather than nobody.
    A caller with no pane identity has no group and is refused ("no-group").
    The answer is a different shape — {ok, broadcast, group_id, delivered_to,
    recipients: [{name, pane_id, msg_key, accepted, reason?}]} — with ONE
    msg_key per recipient, because each is an ordinary independent message:
    its own rate-limit budget, its own idle hold, its own delivery report. Pass
    each key to cli_check_message separately; `wait_for_delivery_s` does not
    apply to a broadcast and is ignored. An empty `recipients` means your group
    has nobody else in it — not a failure.

    `pane_id` addresses one exact pane and makes `to` unnecessary — copy it from
    cli_list_targets. Reach for it when a name cannot say which pane you mean:
    two panes in one workspace may share a name, and that is refused as
    "ambiguous-target" however the name is spelled. It also survives a rename.
    It names a pane on this machine only, so a cross-device target must still be
    addressed by name. An id follows its pane through a window reload or a
    detach, but a pane restarted around a fresh CLI gets a new one — treat
    "unknown-pane-id" as "read a fresh id from cli_list_targets", not as "that
    pane is gone".

    `reply_to` threads this message onto one you were sent, instead of starting
    a new conversation. Pass back the `correlation_id` of the message you are
    answering — cli_read_incoming reports it, and so does the `re:` field of an
    envelope typed into your pane. The recipient's Messages panel then shows
    this as the answer to that message rather than as an unrelated one, and its
    own cli_read_incoming reports it under `in_reply_to`. An id the receiving
    window never handed out is ignored, exactly as an unrecognised `re:` is:
    the message still goes, it simply arrives unthreaded. Omit it for a message
    that starts a thread — the send is then exactly what it always was.

    One limit, and it is the bare-line protocol's too: `reply_to` does NOT
    travel to another device. The relay frame carries to/sender/text/msg_key
    and nothing else, so threading across machines needs a wire field both ends
    understand — a protocol change, not a routing one (`agent_msg.route` in
    ws_handlers says the same at the same seam). The far side still mints a
    correlation id from the msg_key, so the thread holds over there; what is
    lost is the link back to the row on this machine.

    `kind: "ack"` is for a pure acknowledgement — "got it", "done", "thanks" —
    and it changes what the message IS. An ack is written to the user's message
    log and is NEVER put into the receiving agent's input box: that agent is not
    interrupted, is not woken, and will not know you sent it. Use it to close a
    loop the user is watching without spending another agent's turn. Anything
    the other side has to act on, answer, or even know about must go as an
    ordinary message — an ack carrying an instruction is an instruction nobody
    reads. Any other value is treated as an ordinary message.

    An ack reaches panes on this machine only, `to: "group"` included. A
    `<device>/<workspace>/<pane>` target is refused with `ack-not-relayable`:
    the relay cannot promise a message stays out of an input box on someone
    else's machine, and a guarantee that holds only sometimes is one no agent
    should build on. Send it as an ordinary message if it has to cross devices.

    Delivery is asynchronous: this returns once the message is accepted for
    delivery, not once the other agent has read it. Returns
    {ok, target, cross_workspace, msg_key} or {ok: false, error, error_code}.
    Pass `msg_key` to cli_check_message to learn whether the receiving window
    actually delivered it.

    `wait_for_delivery_s` (0 by default, capped at 120) is the alternative to
    remembering to poll: wait that long for the message to actually go in, and
    answer with what happened. 10-30s is the useful range — the wait costs your
    own turn, and a pane that is mid-turn or being typed in can hold a message
    far longer than that. With it set, the answer also carries:

      - `status: "delivered"` and `settled_after_s` — it went in.
      - `status: "failed"` (or "rejected" for another device) and `reason` —
        the receiving window refused it. `ok` stays TRUE: the send itself
        happened and `msg_key` is real, so re-sending on this would dispatch
        the work twice. Read the reason and decide.
      - `status: "unconfirmed"` and `reason: "delivery-unconfirmed"` — it was
        typed and submitted into a CLI that had just been resumed, and that
        CLI has not shown it received it. It may well be running. Do NOT
        resend on this alone: check cli_get_status (is the pane busy?) or
        cli_read_log (is the message in its output?) first. The status turns
        "delivered" if the CLI shows it later.
      - `status: "queued"` with `waited_s`, plus `hold` and `held_for_s` when
        the receiving window said why — the message is still waiting. `hold.key`
        is "typing" (someone is at that keyboard), "mid-turn" (the agent is
        working), "behind" (other messages first), "starting", "settling",
        "not-ready" or "gone". Nothing was lost; it goes in when the pane frees
        up, and cli_check_message picks the story up later.

    `error_code` "target-offline" is not "unknown-target": the pane exists but
    its Navide window is disconnected. Wait for it to come back and retry —
    re-sending elsewhere or reopening the pane would duplicate the work.

    A `<device>/<workspace>/<pane>` target names a pane on another machine and
    is relayed through the configured Navide-Server. Copy the address from
    cli_list_targets' `remote_targets` rather than assembling it: `device` may
    be either the machine's id or its name, and only the id is guaranteed not
    to collide with one of this machine's own workspace paths. "device-offline"
    means that machine has no connection at all, so waiting is the only option;
    the receiving device may also refuse on policy grounds, which shows up in
    cli_check_message as status "rejected".

    Three error codes tell apart the ways cross-device sending can fail before
    the message even leaves here, and only the first is about the address:
    "unknown-device" (no server is configured on this machine, so no device but
    this one can be named), "link-offline" (a server is configured but this
    machine is not connected to it — the address may be perfectly good) and
    "link-unauthorized" (this machine's server credential was rejected or
    revoked; retrying cannot help until it is signed in again).

    The two link errors also carry ``link_state`` and ``last_error``, and the
    message says what to do: "connecting" is the only one worth retrying,
    "unreachable" means the address is not answering from here, and
    "unauthorized" means somebody has to sign in again. Telling all three to
    retry shortly — which is what this used to do — is advice that works for
    one of them.

    A target whose cli_list_targets row says `realized: false` is a restore
    placeholder: the window holds the saved pane but no CLI is running behind
    it, so it is busy forever and the message parks until someone opens it.
    The send still succeeds, and the answer says so with
    `target_state: "not-opened"` and a `warning`. `open_target: true` opens it
    first — the same restore the user's click would do, without the "resume
    which?" modal — and only then delivers; the answer then carries
    `opened: {realized: true, reason}`. `reason: "fresh"` means the pane came
    up on a NEW session (resume behavior "never", or the user had chosen start
    fresh for that workspace): the agent does not remember its earlier
    conversation, so say what it needs to know. If the open fails the message
    is NOT sent — {ok: false, error_code: "open-failed", open: {realized:
    false, reason}}. A target that is already open is unaffected by the flag.

    `open_target` applies to ONE named pane only. It is ignored — never
    forwarded, never acted on — for `to: "group"` and for a cross-device
    target: a broadcast must not be able to pull a whole batch of reclaimed
    panes back up, and another machine's placeholders are that machine's to
    open. This is a fixed boundary, not a missing feature.
    """
    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    return await _send(
        caller,
        to,
        text,
        wait_for_delivery_s=wait_for_delivery_s,
        pane_id=pane_id,
        reply_to=reply_to,
        kind=kind,
        open_target=open_target,
    )


async def _send(
    caller: _Caller,
    to: str,
    text: str,
    *,
    wait_for_delivery_s: float = 0.0,
    pane_id: str = "",
    reply_to: str = "",
    kind: str = "message",
    open_target: bool = False,
    taint_detail: str = "",
) -> dict[str, Any]:
    """cli_send once its caller is resolved.

    Shared with the scheduler (scheduler.LiveBridge), which sends as the host
    with open_target=True, so a scheduled message takes exactly the path — and
    gets exactly the answer — an agent's cli_send does.
    """
    from agent_team_backend import agent_messaging, app, message_routing
    from agent_team_backend.ipc import make_event

    if not (text or "").strip():
        return {"ok": False, "error": "text is empty"}
    # Anything but the one special value is an ordinary message; a typo must not
    # fail a send that would otherwise have gone through.
    send_kind = "ack" if kind == "ack" else ""
    me = caller.pane_id if caller.kind == "pane" else ""
    target_id = (pane_id or "").strip()
    if not target_id and _is_group_target(to):
        if caller.kind != "pane":
            return {
                "ok": False,
                "error": 'a caller with no pane identity has no group to broadcast to — '
                'address panes individually, or by pane_id',
                "error_code": "no-group",
            }
        return await _send_to_group(caller, me, text, reply_to, send_kind)
    if not target_id and _is_chat_target(to):
        # Same as the window's isChannelTarget: a chat sender is not a pane, and
        # the reply goes out from the turn itself when it ends
        # (channels/manager.py _send_reply). Nothing is sent from here.
        return {
            "ok": True,
            "target": to.strip(),
            "handed_to_channel": True,
            "note": (
                "Chat senders are answered from your turn, not by this tool: this "
                "text was NOT sent. Write the reply in your answer as an MSG block "
                f"addressed to {to.strip()} (or as plain text); Navide posts it to "
                "your pane's bound chat when the turn ends."
            ),
        }
    # An id is already as qualified as an address gets, so the rule that a
    # caller with no workspace of its own must name one does not apply to it.
    if not target_id and caller.kind != "pane" and "/" not in (to or ""):
        return {"ok": False, "error": _QUALIFIED_TARGET_REQUIRED}
    wait_s = min(max(float(wait_for_delivery_s), 0.0), _WAIT_IDLE_MAX_TIMEOUT_S)

    if target_id:
        # An id skips address resolution entirely — including the cross-device
        # path, which an id cannot reach anyway.
        result = agent_messaging.resolve_pane_id(me, target_id)
        if result.pane is None:
            return {
                "ok": False,
                "error": result.error,
                "error_code": result.code or "unknown-pane-id",
            }
    else:
        # The resolution order lives in message_routing, shared with the
        # bare-line path so the two cannot answer the same address differently.
        routed = message_routing.route(me, to)
        if routed.remote is not None:
            if send_kind == "ack":
                # Refused rather than relayed, because the relay cannot carry
                # the one thing an ack IS. The frame has no field for it
                # (server_link builds a fixed payload, and the cloud server
                # rebuilds the forwarded frame from named DB columns), and
                # there is no capability negotiation — so even once every layer
                # learns the field, a peer on an older build would still type
                # the ack straight into its pane.
                #
                # An ack whose silence is probabilistic is worse than no ack at
                # all: an agent picks it precisely because it promises not to
                # interrupt anyone. Better to say no here than to be quietly
                # wrong on somebody else's machine.
                return {
                    "ok": False,
                    "error": (
                        'kind="ack" cannot cross devices: this machine cannot '
                        "promise the message stays out of that pane's input "
                        "box. Send it as an ordinary message, or ack a pane on "
                        "this machine."
                    ),
                    "error_code": "ack-not-relayable",
                }
            relayed = await _send_to_device(routed.remote, text, caller=caller, me=me)
            # None means no server was ever configured on this machine; falling
            # through leaves the answer exactly what it was before cross-device
            # addressing existed. A configured-but-unreachable server does not come
            # back as None — it answers "link-offline" above.
            if relayed is not None:
                return await _with_delivery_wait(relayed, wait_s)
        if routed.pane is None:
            return {
                "ok": False,
                "error": routed.error or f'unknown target "{to}"',
                "error_code": routed.code or "unknown-target",
            }
        result = agent_messaging.ResolveResult(
            pane=routed.pane, cross_workspace=routed.cross_workspace
        )
    if me and result.pane.pane_id == me:
        return {"ok": False, "error": "that is your own pane"}

    # Only the single-target path gets here: the group broadcast and the
    # cross-device relay returned above, so open_target cannot reach them.
    target = result.pane
    opened: dict[str, Any] | None = None
    if not target.realized and open_target:
        open_result = await _open_placeholder(target)
        if not open_result["ok"]:
            return {
                "ok": False,
                "error": (
                    f'"{target.qualified_name}" is a restore placeholder and could not '
                    f'be opened ({open_result["reason"]}); the message was not sent'
                ),
                "error_code": "open-failed",
                "open": {"realized": False, "reason": open_result["reason"]},
            }
        opened = {"realized": True, "reason": open_result["reason"]}
        target = open_result["pane"]

    if target.agent_key == _TERMINAL_AGENT and send_kind != "ack":
        refused = _terminal_refusal(text, workspace=target.workspace_path, pane_id=target.pane_id, via="cli_send")
        if refused:
            return refused
    msg_key = await _dispatch_delivery(
        target,
        text,
        caller=caller,
        me=me,
        cross_workspace=result.cross_workspace,
        reply_to=reply_to,
        kind=send_kind,
        taint_detail=taint_detail,
    )
    answer: dict[str, Any] = {
        "ok": True,
        "target": target.qualified_name,
        "cross_workspace": result.cross_workspace,
        "msg_key": msg_key,
    }
    if opened is not None:
        answer["opened"] = opened
    elif not target.realized:
        answer["target_state"] = "not-opened"
        answer["warning"] = (
            "the target is a restore placeholder with no CLI running; the message "
            "waits until someone opens it (ui.pane.open, or open_target=True)"
        )
    if target.agent_key == _TERMINAL_AGENT and not _TERMINAL_PROMPT_CHECK:
        answer["prompt_check"] = "unavailable"
        answer["warning"] = "; ".join(
            w for w in (answer.get("warning"), _TERMINAL_NO_PROMPT_CHECK) if w
        )
    return await _with_delivery_wait(answer, wait_s)


# ── Delivery outcome of a cli_send (cli_check_message) ─────────────────────
# msg_key is minted per cli_send call and exists nowhere else in the backend:
# the SQLite message log is keyed by a separate uid the renderer owns, and the
# sending window's own map of msg_key lives in renderer memory. So the outcome
# is tracked here, in memory, bounded by both a count and a TTL — a restart
# loses it, which is fine for a key nothing outlives the process anyway.
_MESSAGE_STATUS_MAX = 500
_MESSAGE_STATUS_TTL_S = 3600.0
# How long a message may sit in "queued" before it stops reading as "on its way"
# and starts reading as "stuck". Deliberately far below the receiving window's
# 30-minute no-report backstop: this is the point where a sender should look,
# not the point where the message is given up on.
_STALE_HOLD_S = 120.0
# How much of a message cli_inbox_summary quotes back, counted in code points so
# the cut cannot split a surrogate pair.
_INBOX_EXCERPT_CHARS = 60
_mcp_message_status: dict[str, dict[str, Any]] = {}
# When this process started keeping the table above. cli_inbox_summary reports
# how far back its answer reaches, because otherwise "nothing of yours is
# stuck" and "I was restarted and remember nothing you sent" are the same empty
# list — and an orchestrator that has been running longer than this backend has
# no way to tell those apart. This does NOT make the table durable: the comment
# above still holds and the outcomes are still lost on restart. It only stops
# the loss from being silent.
_status_tracking_since = time.monotonic()
# Calls parked in cli_send(wait_for_delivery_s=…), by the key they are waiting
# on. One event per waiting call rather than one per key: two agents may wait on
# the same message, and neither may swallow the other's wake-up.
_status_waiters: dict[str, list[asyncio.Event]] = {}


def _prune_message_status(now: float) -> None:
    for key, entry in list(_mcp_message_status.items()):
        if now - entry["created_at"] >= _MESSAGE_STATUS_TTL_S:
            del _mcp_message_status[key]
    # Insertion-ordered, so the front of the dict is the oldest send.
    while len(_mcp_message_status) >= _MESSAGE_STATUS_MAX:
        _mcp_message_status.pop(next(iter(_mcp_message_status)))


def _tracking_window_s(now: float) -> float:
    """How far back the send-status table's records reach, in seconds.

    Three bounds, and the smallest wins: how long this process has been keeping
    records at all (a restart puts it back to zero, which is the number that
    matters), the TTL, and — once the table is full and evicting by count — the
    age of the oldest record still in it.
    """
    covered = min(now - _status_tracking_since, _MESSAGE_STATUS_TTL_S)
    if len(_mcp_message_status) >= _MESSAGE_STATUS_MAX:
        # Insertion-ordered, so this is the oldest surviving send.
        oldest = next(iter(_mcp_message_status.values()))
        covered = min(covered, now - oldest["created_at"])
    return round(max(covered, 0.0), 1)


def _record_message_sent(msg_key: str, target: str, origin: str, text: str) -> None:
    now = time.monotonic()
    _prune_message_status(now)
    _mcp_message_status[msg_key] = {
        "status": "queued",
        "target": target,
        "reason": None,
        "delivered_at": None,
        "created_at": now,
        # Filled in by the window that owns the target, which is the only place
        # the delivery gate exists. Stays None for a message that goes out
        # before any hold was ever reported.
        "hold": None,
        "hold_since": None,
        # Who sent it, as cli_inbox_summary identifies its own caller: a pane id
        # for a pane, otherwise the caller kind. The msg_key already starts with
        # this, but a pane id may contain anything, so it is kept as its own
        # field rather than parsed back out of the key.
        "origin": origin,
        "excerpt": "".join(list(" ".join(text.split()))[:_INBOX_EXCERPT_CHARS]),
    }


def record_message_hold(msg_key: str, hold: dict[str, Any] | None) -> bool:
    """Record why the receiving window has not injected a cli_send message yet.

    The window reports a change, never a heartbeat (see setHold in
    useAgentMessaging), so this is called once per hold rather than once per
    pump tick.

    A settled entry is left alone: a hold report that lost a race with the
    delivery it was overtaken by must not put a delivered message back on
    "waiting for the pane".

    Returns False for a msg_key this server never sent or has already settled —
    every window reports for every tracked message it holds, so that is the
    ordinary case, not an error.
    """
    entry = _mcp_message_status.get(msg_key)
    if entry is None or entry["status"] != "queued":
        return False
    key = str((hold or {}).get("key") or "")
    if not key:
        entry["hold"] = None
        entry["hold_since"] = None
        return True
    view: dict[str, Any] = {"key": key}
    n = (hold or {}).get("n")
    if isinstance(n, (int, float)) and not isinstance(n, bool):
        view["n"] = int(n)
    entry["hold"] = view
    # Timed by this process's own clock rather than the window's: held_for_s is
    # read next to age_seconds and settled_after_s, and a renderer's wall clock
    # is neither of those. The report is sent the moment the hold changes, so
    # the two agree to within one round trip.
    entry["hold_since"] = time.monotonic()
    return True


def _hold_view(entry: dict[str, Any], now: float) -> dict[str, Any]:
    """The hold half of a status answer, for a message that is still waiting.

    Empty once the message has settled: what was holding it stopped being true
    the moment it went in.
    """
    hold = entry.get("hold")
    if entry["status"] != "queued" or not hold:
        return {}
    view: dict[str, Any] = {"hold": hold}
    if entry.get("hold_since") is not None:
        view["held_for_s"] = round(now - entry["hold_since"], 1)
    return view


def _is_stale(entry: dict[str, Any], now: float) -> bool:
    """True once a queued message has waited long enough to be worth looking at.

    Read from the send's own age rather than from `hold_since`: a hold that
    flips between "mid-turn" and "typing" restarts that clock every time, and a
    message no window ever reported a hold for — the case this exists for —
    has no hold clock at all.

    Computed on read rather than stamped by a timer. Nothing on the backend
    needs to act at the moment the threshold is crossed: the renderer owns the
    queue and pushes the still-held notice itself (STALE_HOLD_MS in
    useAgentMessaging), and everything here answers a question that was asked.
    """
    return entry["status"] == "queued" and now - entry["created_at"] >= _STALE_HOLD_S


def _hold_reason_for(target: str) -> str | None:
    """The hold key of the oldest still-queued cli_send message for `target`.

    Only messages sent from here are tracked, so a pane whose queue holds
    nothing of ours simply has no reason to give. Matched on the qualified name
    the send recorded, which is the address cli_list_targets reports — a pane
    renamed since then stops matching, and reports nothing rather than a stale
    reason.
    """
    for entry in _mcp_message_status.values():
        if entry["target"] != target or entry["status"] != "queued":
            continue
        hold = entry.get("hold")
        if hold:
            return str(hold["key"])
    return None


def _settle_status_waiters(msg_key: str) -> None:
    """Wake every cli_send parked on this key. Waiters remove themselves."""
    for event in _status_waiters.get(msg_key, ()):
        event.set()


def _decode_reason(reason: str) -> str:
    """The renderer encodes its structured reason as JSON; keep the key only."""
    try:
        parsed = json.loads(reason)
    except (ValueError, TypeError):
        return reason
    if isinstance(parsed, dict) and isinstance(parsed.get("key"), str):
        return parsed["key"]
    return reason


def record_delivery_result(msg_key: str, ok: bool, reason: str) -> bool:
    """Record a receiving window's agent_msg.delivered verdict for cli_check_message.

    Returns False for a msg_key this server never sent (every message the UI
    sends goes through the same event), which is not an error.
    """
    entry = _mcp_message_status.get(msg_key)
    if entry is None:
        return False
    decoded = _decode_reason(reason) if reason else None
    # A withdrawal comes back down the delivered path with ok=False, but it is
    # not a failure: nothing went wrong and nothing should be resent. Collapsing
    # it into "failed" would invite exactly the resend the withdrawal was meant
    # to prevent — the same reason "read" is reported as delivered.
    if not ok and decoded == "cancelled":
        entry["status"] = "cancelled"
    elif not ok and decoded == "delivery-unconfirmed":
        # Typed and submitted into a resumed CLI that has not shown it yet. Not
        # a failure either: resending on it may dispatch the work twice. The
        # window reports again, ok, if the transcript shows it later.
        entry["status"] = "unconfirmed"
    else:
        entry["status"] = "delivered" if ok else "failed"
    entry["reason"] = decoded
    entry["delivered_at"] = time.monotonic()
    _clear_hold(entry)
    _settle_status_waiters(msg_key)
    return True


def _clear_hold(entry: dict[str, Any]) -> None:
    """A settled message is not being held by anything any more."""
    entry["hold"] = None
    entry["hold_since"] = None


# A remote ack keeps its three-way state instead of collapsing to ok/not-ok:
# "rejected" means the receiving device's pane policy refused, and re-sending
# will refuse again. An agent that cannot tell that apart from a transient
# failure retries a permission problem until someone notices.
_REMOTE_ACK_STATES = ("delivered", "failed", "rejected")


def record_remote_ack(msg_key: str, state: str, reason: str) -> bool:
    """Record another device's messages.ack for a message sent from here.

    Returns False for a msg_key this server never sent, which is not an error.
    """
    entry = _mcp_message_status.get(msg_key)
    if entry is None:
        return False
    entry["status"] = state if state in _REMOTE_ACK_STATES else "failed"
    entry["reason"] = reason or None
    entry["delivered_at"] = time.monotonic()
    _clear_hold(entry)
    _settle_status_waiters(msg_key)
    return True


async def _await_delivery(msg_key: str, timeout: float) -> None:
    """Wait until a message leaves "queued", or the timeout passes.

    Nothing here blocks the event loop: the waiting call is parked on its own
    event while every other request — including the receiving window's report,
    which is what wakes it — carries on.
    """
    entry = _mcp_message_status.get(msg_key)
    if entry is None or entry["status"] != "queued":
        return
    event = asyncio.Event()
    _status_waiters.setdefault(msg_key, []).append(event)
    try:
        await asyncio.wait_for(event.wait(), timeout)
    except (asyncio.TimeoutError, TimeoutError):
        pass
    finally:
        waiters = _status_waiters.get(msg_key)
        if waiters is not None:
            if event in waiters:
                waiters.remove(event)
            if not waiters:
                del _status_waiters[msg_key]


def _delivery_outcome(msg_key: str, waited: float) -> dict[str, Any]:
    """What waiting for delivery adds to an accepted send's answer."""
    entry = _mcp_message_status.get(msg_key)
    if entry is None:
        # Evicted from the bounded table while we waited. The send itself still
        # happened, and "queued" is the last thing that was true of it.
        return {"status": "queued", "waited_s": round(waited, 1)}
    now = time.monotonic()
    outcome: dict[str, Any] = {"status": entry["status"]}
    if entry["status"] == "queued":
        outcome["waited_s"] = round(waited, 1)
        outcome.update(_hold_view(entry, now))
        if _is_stale(entry, now):
            outcome["stale"] = True
        return outcome
    if entry["reason"]:
        outcome["reason"] = entry["reason"]
    if entry["delivered_at"] is not None:
        outcome["settled_after_s"] = round(entry["delivered_at"] - entry["created_at"], 1)
    return outcome


async def _with_delivery_wait(sent: dict[str, Any], wait_s: float) -> dict[str, Any]:
    """Extend an accepted send with the outcome of waiting for it to land.

    Adds nothing at all when the caller did not ask to wait, so the default
    answer stays exactly the one every existing caller already parses.
    """
    if wait_s <= 0 or not sent.get("ok"):
        return sent
    msg_key = str(sent.get("msg_key") or "")
    if not msg_key:
        return sent
    started = time.monotonic()
    await _await_delivery(msg_key, wait_s)
    return {**sent, **_delivery_outcome(msg_key, time.monotonic() - started)}


@server.tool()
async def cli_check_message(msg_key: str, ctx: Context) -> dict[str, Any]:
    """Look up what became of a message you sent with cli_send.

    `msg_key` is the value cli_send returned. Returns {ok, msg_key, status,
    target, age_seconds, reason?, settled_after_s?, hold?, held_for_s?,
    stale?}. `status` is one of:

      - "queued"    — broadcast for delivery; no window has reported back yet.
                      A message held for a busy pane stays here until it is
                      actually injected.
      - "delivered" — the receiving window injected and submitted it.
      - "failed"    — the receiving window refused or lost it; see `reason`.
      - "unconfirmed" — typed and submitted into a just-resumed CLI that has
                      not shown it received it (`reason`
                      "delivery-unconfirmed"). Sent, not lost: it may be
                      running. Check cli_get_status or cli_read_log before
                      resending, or the work may run twice. Becomes
                      "delivered" if the CLI shows it later.
      - "rejected"  — only for a message sent to another device: that device's
                      pane policy refuses this sender. Re-sending refuses
                      again; this is a permission question for a human, not
                      something to retry.
      - "cancelled" — withdrawn before it went in, by cli_cancel_message or by
                      someone using the Messages panel. Nothing went wrong and
                      nothing is waiting; resend only if you still mean it.

    `reason` values come from the receiving window: "rate-limit" (too many
    messages between the same pair too quickly), "queue-full" (the target's
    pending-message queue is at its cap), "inject-failed" (typing it into the
    pane did not take), "pane-closed" (the target went away before delivery),
    "no-report" (the delivery attempt never reported an outcome). Two reasons
    do NOT mean something went wrong: "read" pairs with "delivered" and means
    the recipient took the message with cli_read_incoming instead of having it
    typed in, and "cancelled" pairs with the status of the same name.

    On a "queued" message, `hold` is why it has not gone in yet — {key, n?},
    the same reason the Messages panel shows — and `held_for_s` is how long it
    has been that way. `hold.key` is "typing" (someone is typing in that pane),
    "mid-turn" (its agent is working), "behind" (`n` messages ahead of it),
    "starting", "settling", "not-ready", "gone", "paused" or "remote-ack". Both
    keys are absent once the message settles, and while no window has reported
    a hold at all — a message queued with no hold is simply on its way in.

    A message to another device that has gone a minute without an answer is
    asked about through the server, and its hold then says which silence it is:
    "remote-busy" (the target pane is mid-turn by the roster, so the message is
    waiting for that turn to end — wait, or ask whoever runs that machine to
    let it finish) or "remote-unreported" (the pane is not working and the far
    side has still said nothing — waiting longer is unlikely to help). An answer
    the far side gave while this machine was disconnected is picked up the same
    way, so a message never stays "queued" just because its ack was missed.

    `stale` is true once a queued message has been waiting more than two
    minutes. It is not a failure and nothing has given up on it — it is the
    point at which waiting longer is probably not the answer, so read `hold`
    and decide whether to wait, address someone else, or tell the user.

    Bounds: this is in-memory backend state, not a log. It is lost on backend
    restart, keeps only the last hour, and only the most recent few hundred
    sends — an unknown `msg_key` means "not tracked any more", not "never
    sent". Returns {ok: false, error} for an unknown key.
    """
    try:
        _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    key = (msg_key or "").strip()
    entry = _mcp_message_status.get(key)
    if entry is None:
        return {
            "ok": False,
            "error": f"unknown msg_key {key!r} — it was never sent from here, or it "
            "aged out of the in-memory table (last hour only)",
        }
    now = time.monotonic()
    status: dict[str, Any] = {
        "ok": True,
        "msg_key": key,
        "status": entry["status"],
        "target": entry["target"],
        "age_seconds": round(now - entry["created_at"], 1),
    }
    if entry["reason"]:
        status["reason"] = entry["reason"]
    if entry["delivered_at"] is not None:
        status["settled_after_s"] = round(entry["delivered_at"] - entry["created_at"], 1)
    status.update(_hold_view(entry, now))
    if _is_stale(entry, now):
        status["stale"] = True
    return status


@server.tool()
async def cli_inbox_summary(ctx: Context) -> dict[str, Any]:
    """List the messages you sent that are stuck or that never got through.

    Takes no arguments and asks about no one but you: it returns the sends made
    from this caller — this pane, or this external client — that are currently
    stale (queued more than two minutes), failed, or unconfirmed (see
    cli_check_message — check the pane before resending one of those). Everything that was
    delivered, and everything still on its way in, is left out.

    This is the pull half of delivery feedback, and it exists for the agent the
    push half cannot reach. A failure notice is typed back into the sending
    pane once that pane is idle, so an agent that stays busy for an hour never
    sees one, and an external client has no pane to type into at all. Calling
    this between pieces of your own work is how you find out that the message
    you sent twenty minutes ago is still sitting in a queue.

    Returns {ok, count, messages: [{msg_key, target, status, age_seconds,
    stale?, reason?, hold?, held_for_s?, excerpt}], tracked, tracking_since_s},
    newest send last. `excerpt` is the first 60 characters of what you sent, so
    a message is recognizable without keeping every msg_key. The same in-memory
    bounds as cli_check_message apply: the last hour, the last few hundred
    sends, gone on backend restart. An empty list means nothing of yours is
    stuck — it never means nothing was sent.

    `tracked` and `tracking_since_s` are what make that last sentence checkable
    instead of a warning you have to remember. `tracked` is how many of YOUR
    sends this table still holds, delivered ones included; `tracking_since_s`
    is how far back its records reach at all. "0 of your sends, and I have only
    been keeping records for 40 seconds" is a backend that restarted under you
    and took every msg_key you were holding with it — every one of them now
    answers cli_check_message with "unknown", and you cannot tell from here
    whether those messages were delivered. "12 tracked, none stuck" is the
    other thing entirely. Neither number counts anybody else's sends.
    """
    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    origin = (caller.pane_id if caller.kind == "pane" else "") or caller.kind
    now = time.monotonic()
    messages: list[dict[str, Any]] = []
    tracked = 0
    for key, entry in _mcp_message_status.items():
        if entry.get("origin") != origin:
            continue
        tracked += 1
        stale = _is_stale(entry, now)
        if not stale and entry["status"] not in ("failed", "rejected", "unconfirmed"):
            continue
        row: dict[str, Any] = {
            "msg_key": key,
            "target": entry["target"],
            "status": entry["status"],
            "age_seconds": round(now - entry["created_at"], 1),
            "excerpt": entry.get("excerpt", ""),
        }
        if stale:
            row["stale"] = True
        if entry["reason"]:
            row["reason"] = entry["reason"]
        row.update(_hold_view(entry, now))
        messages.append(row)
    # Always present, unlike the optional keys elsewhere in this file: they
    # exist to give the EMPTY answer a meaning, so omitting them when there is
    # nothing to report would omit them exactly when they are needed.
    return {
        "ok": True,
        "count": len(messages),
        "messages": messages,
        "tracked": tracked,
        "tracking_since_s": _tracking_window_s(now),
    }


def _hold_for_correlation(correlation_id: str) -> dict[str, Any]:
    """The recorded hold for a message, looked up by the id both ends share.

    ``_mcp_message_status`` is the SENDER's bookkeeping: the receiving window
    reports a hold change against the msg_key its delivery arrived with, and
    cli_check_message reads it back. The recipient's copy of that same message
    carries the same string as its ``correlation_id``, so the recipient can ask
    the identical question — which is the point: sender and receiver see one
    hold, not two accounts of it.

    Empty for a message this backend never routed (two panes of one window
    mint no key at all), for one from another device, and for one already
    evicted from the bounded table. Absence therefore means "nothing recorded
    here", never "nothing is holding it".
    """
    entry = _mcp_message_status.get(correlation_id) if correlation_id else None
    if entry is None:
        return {}
    now = time.monotonic()
    view = dict(_hold_view(entry, now))
    if _is_stale(entry, now):
        view["stale"] = True
    return view


def _incoming_hold(row: Any, correlation_id: str) -> dict[str, Any]:
    """Why an incoming message has not been typed into your pane yet.

    Two sources for one fact. The window that owns the queue knows the live
    ``{key, n}`` and puts it on a cli_read_incoming row; the backend has only
    what that window reported for a message IT dispatched, but it is the only
    side holding a clock, so ``held_for_s`` and ``stale`` come from there
    whichever side supplied the hold.

    The owning window wins when it answered at all: it is the authority on its
    own queue, and a backend record left behind by a race must not contradict
    a window that just said nothing is holding this message.
    """
    view = _hold_for_correlation(correlation_id)
    if isinstance(row, dict) and "hold" in row:
        live = row.get("hold")
        if isinstance(live, dict) and live.get("key"):
            hold: dict[str, Any] = {"key": str(live["key"])}
            n = live.get("n")
            if isinstance(n, (int, float)) and not isinstance(n, bool):
                hold["n"] = int(n)
            view["hold"] = hold
        else:
            view.pop("hold", None)
            view.pop("held_for_s", None)
    return view


def _threading_of(row: Any) -> tuple[str, str]:
    """``(correlation_id, in_reply_to)`` from a row, whichever side wrote it.

    A cli_read_incoming row comes from the renderer in camelCase; every other
    read here comes from the sqlite log in its column names. Both spellings
    carry the same two values, so they are read here rather than at two call
    sites that could drift apart.
    """
    if not isinstance(row, dict):
        return "", ""
    correlation = str(row.get("correlationId") or row.get("correlation_id") or "")
    in_reply_to = str(row.get("inReplyTo") or row.get("reply_to") or "")
    return correlation, in_reply_to


# How much of an incoming message cli_pending_incoming quotes back. Larger than
# the outgoing excerpt: you wrote the ones cli_inbox_summary lists and only need
# to recognize them, while these you have never seen, and the whole point is to
# judge whether to break off what you are doing.
_INCOMING_EXCERPT_CHARS = 200


@server.tool()
async def cli_pending_incoming(ctx: Context, limit: int = 20) -> dict[str, Any]:
    """List the messages waiting to be delivered *to you*.

    The mirror of cli_inbox_summary, which asks only about what you sent. This
    asks what is queued for you and has not gone in yet — which, while you are
    working, is everything anyone has sent you: a message is typed into a pane
    only between turns, so an agent that stays busy is precisely the one that
    cannot be told. Until this existed there was no way to find out; the queue
    lives in the receiving window, and nothing offered the recipient's view of
    it.

    Call it between pieces of your own work when something may be waiting on
    you — after dispatching a task with cli_open_agent, or during a long run
    someone might need to interrupt. A non-empty answer is grounds to wrap up
    the turn you are in, which is what lets the message land.

    `excerpt` is 200 characters with the whitespace flattened: enough to tell
    what a message is about, not enough to act on. cli_read_incoming returns
    what was actually written, and can take a message off the queue so it is
    not typed in afterwards.

    Returns {ok, count, messages: [{uid, sender, status, age_seconds, kind?,
    excerpt, correlation_id?, in_reply_to?, hold?, held_for_s?, stale?}]},
    oldest first. `status` is "queued" (waiting for you to be between turns) or
    "delivering" (going in right now). `kind` marks a message Navide wrote
    rather than an agent: "notice" is delivery feedback about your own send,
    "fallback" is a spawned pane's turn forwarded because it ended without
    writing a report.

    `correlation_id` is the one string you and the sender both know this
    message by — the sender's `msg_key`. Pass it to cli_send's `reply_to` to
    answer this message rather than start a new thread. `in_reply_to` is the
    `uid` of the message THIS one answers, when it is itself a reply. Both are
    absent for a message between two panes of a single window: that message is
    never routed, so no such id is ever minted, and the two of you already
    share this `uid`.

    `hold` says why your queue is not moving — {key, n?}, the same reason the
    sender reads from cli_check_message, with `held_for_s` and `stale` (waiting
    over two minutes) beside it. "mid-turn" is you: the message goes in when
    you finish this turn. "typing" is a human at that keyboard, "paused" is
    delivery switched off in that window, and "behind" means `n` messages are
    ahead of this one. It is absent unless this backend dispatched the message
    and the owning window has reported a hold for it — so absence means
    "nothing recorded", not "nothing is holding it". For the live queue state
    of a message this cannot explain, read it with cli_read_incoming
    (`peek: true` leaves delivery alone), which asks the window that owns the
    queue instead of this log.

    Read from the persisted message log, so unlike cli_inbox_summary this
    survives a backend restart. Two limits are worth knowing: the log is
    written by the receiving window a moment after a message is queued, so
    something sent in the last second may not be listed yet; and messages are
    matched by your current messaging name, so anything queued for a name you
    have since been renamed away from is not yours to see. An empty list means
    nothing is waiting — it never means nothing was sent.
    """
    from agent_team_backend import agent_messaging, app

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    if caller.kind != "pane":
        return {
            "ok": False,
            "error": (
                "only a Navide CLI pane has an inbox — a host or external caller "
                "has no messaging name for anything to be addressed to."
            ),
        }
    # _resolve_caller has just rejected a stale pane id, so this is set; the
    # guard is here for the type, not for a reachable state.
    me = agent_messaging.get(caller.pane_id)
    if me is None:
        return {"ok": False, "error": "this pane is no longer registered for messaging"}
    rows = await asyncio.to_thread(
        app.agent_message_log.pending_incoming, me.name, max(1, min(int(limit), 200))
    )
    now_ms = time.time() * 1000.0
    messages: list[dict[str, Any]] = []
    for row in rows:
        excerpt = "".join(list(" ".join(str(row.get("content") or "").split()))[
            :_INCOMING_EXCERPT_CHARS
        ])
        message: dict[str, Any] = {
            "uid": row.get("uid", ""),
            "sender": row.get("sender", ""),
            "status": row.get("status", ""),
            "age_seconds": round(max(0.0, now_ms - float(row.get("created_at") or now_ms)) / 1000.0, 1),
            "excerpt": excerpt,
        }
        if row.get("kind"):
            message["kind"] = row["kind"]
        correlation, in_reply_to = _threading_of(row)
        if correlation:
            message["correlation_id"] = correlation
        if in_reply_to:
            message["in_reply_to"] = in_reply_to
        message.update(_incoming_hold(row, correlation))
        messages.append(message)
    return {"ok": True, "count": len(messages), "messages": messages}


# The full text of one incoming message, bounded by what the log itself stores
# (agent_message_log clamps content at 64K chars on the way in, so anything
# longer was already truncated before this tool could see it).
_INCOMING_FULL_MAX_CHARS = 64 * 1024

# How many messages one read may take at once. Small on purpose: each one is up
# to 64K of the caller's context, and taking more than a handful in a single
# call is a sign of an agent draining a backlog it should be answering.
_INCOMING_READ_MAX = 20


@server.tool()
async def cli_read_incoming(
    ctx: Context,
    uid: str = "",
    limit: int = 5,
    include_delivered: bool = False,
    peek: bool = False,
) -> dict[str, Any]:
    """Read the full text of messages sent TO you.

    cli_pending_incoming tells you a message exists and shows 200 characters
    of it with the whitespace flattened. This returns what was actually
    written. Until it existed you could read another pane's entire log but not
    one message addressed to yourself.

    BY DEFAULT READING CONSUMES. A message you read here is not typed into
    your input box afterwards — you have it, so delivering it again would
    repeat it. Pass `peek: true` to read without consuming, which leaves
    delivery exactly as it was.

    `uid` reads one message (the uid comes from cli_pending_incoming);
    omitting it reads the oldest `limit` waiting for you. `include_delivered`
    also returns messages already typed into your pane, for looking back at
    what someone said — those are never consumed, because they already were.

    Consuming is two steps, and the failure mode is deliberate: the message is
    reserved, handed to you, and only then released. If the release is lost
    the reservation expires and the message goes BACK to the queue, so it may
    reach you a second time. That is the safe direction — a duplicate is
    visible and a loss is not. Treat a message you have already handled as
    something to recognise, not something that cannot arrive twice.

    Returns {ok, count, messages: [{uid, sender, status, kind?, content,
    age_seconds, consumed, correlation_id?, in_reply_to?, hold?, held_for_s?,
    stale?}]}. `consumed` is per message and is false when the read was a peek,
    when the message was already delivered, or when the window could not be
    reached to release the reservation — in that last case you have the text
    but delivery was left alone, so expect it in your pane.

    `correlation_id` is the one string you and the sender both know this
    message by. Pass it to cli_send's `reply_to` and your answer lands ON this
    message instead of starting a new thread — the same thing an envelope typed
    into your pane asks for with its `re:` field, which until now was the only
    way to reply to a specific message. `in_reply_to` is the `uid` of the
    message THIS one answers, when it is itself a reply. Both are absent for a
    message between two panes of a single window: nothing routes it, so no such
    id exists, and you and the sender already share this `uid`.

    `hold` is why the message had not been typed in yet — {key, n?}: "mid-turn"
    (you are working; it goes in when this turn ends), "typing" (a human at
    that keyboard), "behind" (`n` messages ahead of it), "paused" (delivery
    switched off in that window), "starting", "settling", "not-ready", "gone"
    or "remote-ack". `held_for_s` and `stale` (waiting over two minutes) come
    with it when this backend dispatched the message. Absent means nothing is
    holding it, not that nothing is known — and note that a read of your own
    reserves what it returns, so a hold you read here is the state BEFORE that.

    Only a Navide CLI pane has an inbox. Messages are matched by your current
    messaging name, so anything queued for a name you have been renamed away
    from is not yours to see.
    """
    from agent_team_backend import agent_messaging

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    if caller.kind != "pane":
        return {
            "ok": False,
            "error": (
                "only a Navide CLI pane has an inbox — a host or external caller "
                "has no messaging name for anything to be addressed to."
            ),
        }
    me = agent_messaging.get(caller.pane_id)
    if me is None:
        return {"ok": False, "error": "this pane is no longer registered for messaging"}

    wanted = [uid.strip()] if uid.strip() else []
    count = max(1, min(int(limit), _INCOMING_READ_MAX))
    args: dict[str, Any] = {
        "paneId": caller.pane_id,
        "uids": wanted,
        "limit": count,
        "includeDelivered": bool(include_delivered),
        "reserve": not peek,
        "maxChars": _INCOMING_FULL_MAX_CHARS,
    }
    reply = await _ui_request(
        me.workspace_path,
        "invoke",
        caller=_pane_caller(caller.pane_id),
        action="ui.messaging.readIncoming",
        args=args,
    )
    degraded = ""
    paused = False
    if reply.get("ok"):
        result = reply.get("result") or {}
        rows = result.get("messages") or []
        reserved = [str(u) for u in (result.get("reserved") or [])]
        paused = bool(result.get("paused"))
    else:
        # The window did not answer. Read from the log instead of failing: the
        # text is what was asked for and the log has it. Nothing is reserved,
        # so delivery is untouched and the message still reaches the pane —
        # answering with the text and saying so beats refusing outright.
        from agent_team_backend import app

        rows = await asyncio.to_thread(
            app.agent_message_log.incoming, me.name, bool(include_delivered), count
        )
        if wanted:
            rows = [r for r in rows if str(r.get("uid") or "") in set(wanted)]
        reserved = []
        degraded = str(reply.get("error") or "the window owning this pane did not answer")

    # Second step. Nothing is consumed until the window is told the text
    # reached us; if this call fails the reservation expires on its own and the
    # message returns to the queue, which is why `consumed` is reported per
    # message rather than assumed.
    released: set[str] = set()
    if reserved:
        settle = await _ui_request(
            me.workspace_path,
            "invoke",
            caller=_pane_caller(caller.pane_id),
            action="ui.messaging.settleRead",
            args={"paneId": caller.pane_id, "uids": reserved, "ok": True},
        )
        if settle.get("ok"):
            released = {str(u) for u in ((settle.get("result") or {}).get("settled") or [])}

    now_ms = time.time() * 1000.0
    messages: list[dict[str, Any]] = []
    for row in rows:
        row_uid = str(row.get("uid") or "")
        created = float(row.get("createdAt") or row.get("created_at") or now_ms)
        message: dict[str, Any] = {
            "uid": row_uid,
            "sender": str(row.get("sender") or ""),
            "status": str(row.get("status") or ""),
            "content": str(row.get("content") or "")[:_INCOMING_FULL_MAX_CHARS],
            "age_seconds": round(max(0.0, now_ms - created) / 1000.0, 1),
            "consumed": row_uid in released,
        }
        if row.get("kind"):
            message["kind"] = row["kind"]
        correlation, in_reply_to = _threading_of(row)
        if correlation:
            message["correlation_id"] = correlation
        if in_reply_to:
            message["in_reply_to"] = in_reply_to
        message.update(_incoming_hold(row, correlation))
        messages.append(message)

    answer: dict[str, Any] = {"ok": True, "count": len(messages), "messages": messages}
    if degraded:
        answer["note"] = (
            f"read from the message log because the window did not answer ({degraded}); "
            "nothing was consumed, so these still reach your pane."
        )
        return answer
    if paused and not reserved:
        # Delivery being paused is why a read can come back with nothing while
        # messages are in fact waiting. An empty answer would read as "you have
        # no mail", which is the one thing this tool must never imply.
        answer["note"] = (
            "delivery is paused in this window, so nothing could be taken. Any "
            "messages listed were read only; more may be waiting behind the pause."
        )
        return answer
    stranded = [u for u in reserved if u not in released]
    if stranded:
        # Say it plainly rather than leaving the agent to compare two lists.
        answer["note"] = (
            f"{len(stranded)} message(s) were read but not consumed — the window "
            "could not confirm. They stay queued and will reach your pane."
        )
    return answer


# How long to wait for the owning window to say whether a withdrawal landed.
# Short: the answer comes from a window that already has the queue in memory,
# so it is a round trip rather than a piece of work — and a caller that has
# just changed its mind should not be parked for long.
_CANCEL_VERDICT_TIMEOUT_S = 5.0


@server.tool()
async def cli_cancel_message(msg_key: str, ctx: Context) -> dict[str, Any]:
    """Withdraw a message you sent, if it has not gone in yet.

    A message sits in the recipient's queue until that pane is between turns,
    which is often a long time. Until now a sender that changed its mind — the
    wrong target, a premise that stopped being true, a task already done by
    someone else — could only watch it go in and then send a correction, which
    costs the recipient a whole turn to work out that the first message no
    longer applies.

    `msg_key` is what cli_send returned. Withdrawal is decided by the window
    that owns the queue, because only it knows whether the message is still
    waiting: if it is, the message is dropped and the status becomes
    "cancelled"; if delivery already started, the withdrawal is ignored and the
    delivery reports its own outcome as usual. Either way you get the settled
    status back, so a "delivered" answer here means you were too late rather
    than that something failed.

    Withdrawing is not failing. The status is "cancelled" and no failure notice
    is written back to you — there is nothing to explain to the pane that just
    changed its mind. Resend with cli_send if you still mean it.

    Only messages this server sent can be withdrawn, and only for about an
    hour, which is how long their keys are tracked. An unknown key means "not
    tracked any more", not "never sent" — the same caveat cli_check_message
    carries.

    Returns {ok, msg_key, status, reason?} or {ok: false, error}.
    """
    from agent_team_backend import app
    from agent_team_backend.ipc import make_event

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    key = (msg_key or "").strip()
    if not key:
        return {"ok": False, "error": "msg_key is required — it is what cli_send returned"}

    entry = _mcp_message_status.get(key)
    if entry is None:
        return {
            "ok": False,
            "error": (
                f"unknown msg_key {key!r} — it was never sent from here, or it is older "
                "than the hour these are tracked for. An untracked key says nothing "
                "about whether the message arrived; ask cli_check_message."
            ),
        }
    origin = (caller.pane_id if caller.kind == "pane" else "") or caller.kind
    if entry.get("origin") != origin:
        return {
            "ok": False,
            "error": f"msg_key {key!r} was not sent from here — you can only withdraw your own messages",
        }
    if entry["status"] != "queued":
        # Already settled. Say what it settled as rather than refusing flatly:
        # "delivered" is the answer to "can I still take it back", not an error.
        answer: dict[str, Any] = {
            "ok": False,
            "msg_key": key,
            "status": entry["status"],
            "error": f"too late — this message is already {entry['status']}",
        }
        if entry.get("reason"):
            answer["reason"] = entry["reason"]
        return answer

    await app.broadcast(make_event("agent_msg.cancel", {"msg_key": key}))
    # The owning window answers over the ordinary delivered path, so waiting for
    # a settled status is the same wait a send with wait_for_delivery_s does.
    await _await_delivery(key, _CANCEL_VERDICT_TIMEOUT_S)

    settled = _mcp_message_status.get(key)
    status = settled["status"] if settled else "unknown"
    result: dict[str, Any] = {"ok": status == "cancelled", "msg_key": key, "status": status}
    if settled and settled.get("reason"):
        result["reason"] = settled["reason"]
    if status == "queued":
        # No window claimed it within the timeout. The message is still on its
        # way, so say that rather than implying the withdrawal took.
        result["error"] = (
            "no window answered in time; the message is still queued and may yet "
            "be delivered. Check cli_check_message before assuming it was withdrawn."
        )
    elif status != "cancelled":
        result["error"] = f"too late — the message was already {status}"
    return result


# ── Reading another pane (cli_read_log / cli_get_status / cli_wait_idle) ────

# Bounds one read of an arbitrarily large conversation log. The cost here is
# the caller's context window, not backend memory — a string this size is
# nothing to the process — and the tool also returns log_path so a caller that
# needs the whole file can read it directly. Sized to let an agent review a
# genuinely long exchange in one call rather than paging through it.
_LOG_TAIL_MAX_BYTES = 512 * 1024


def _read_log_window(path: Path, since: int | None, tail_lines: int) -> tuple[str, bool, bool, int]:
    """A window of a log file, bounded by both a byte budget and a line count.

    With `since` None this is the tail: at most _LOG_TAIL_MAX_BYTES from the
    end of the file (bounds memory for an arbitrarily large log). With `since`
    set it is everything appended after that byte offset, still capped by the
    same byte budget. Either way only the last `tail_lines` lines survive.

    Returns (text, truncated, rotated, next_cursor). `truncated` is True
    whenever content before the returned text was dropped — the byte budget
    clipped the window, or more lines existed in it than `tail_lines` kept.
    `rotated` is True when `since` pointed past the end of the file, meaning
    the log was truncated or replaced and the cursor no longer refers to
    anything; the read then falls back to a plain tail. `next_cursor` is the
    offset to pass as `since` next time.
    """
    size = path.stat().st_size
    rotated = since is not None and since > size
    base = 0 if (since is None or rotated) else max(0, since)
    start = max(base, size - _LOG_TAIL_MAX_BYTES)
    with path.open("rb") as f:
        if start:
            f.seek(start)
        data = f.read()
    text = data.decode("utf-8", errors="replace")
    byte_truncated = start > base
    lines = text.splitlines()
    line_truncated = len(lines) > tail_lines
    if line_truncated:
        lines = lines[-tail_lines:]
    return "\n".join(lines), byte_truncated or line_truncated, rotated, size


# ── Reading a pane on ANOTHER machine ──────────────────────────────────────
# The observing tools answer for a remote pane out of `remote_roster`, which is
# Navide-Server's session directory as this machine last received it. Nothing
# new is uploaded for them: cli_list_targets already hands `busy` / `offline` /
# `host_online` / `status` back for every remote pane.
#
# It is a genuinely weaker source than the local path, and every tool below
# says so in its own docstring. The three ways it is weaker, once:
#
#   1. ONE WORD PER PANE. The roster carries the sending window's own sidebar
#      badge (server_link._pane_status) and nothing else — no turn_complete, no
#      last_activity, no log. "The turn ended" is never observed remotely; the
#      most that can be seen is that the pane stopped being busy.
#   2. NO `awaitingKind`. The local path splits "awaiting" into a permission
#      prompt (parked on a HUMAN) and an open question (which counts as idle,
#      see _ui_status_is_idle). The far side sends one word for both, so that
#      split cannot be made here at all.
#   3. IT ARRIVES LATE. The owning window debounces its uploads
#      (server_link.ROSTER_DEBOUNCE_S, 0.5s) and re-sweeps every
#      ROSTER_SWEEP_S (30s), so a status read here is near-live, not live.

#: Roster words that end a wait as "this pane is not working". "idle" is the
#: badge of a pane sitting at its prompt; the other three are terminal — the
#: session is over — and the local path settles on those too
#: (_UI_IDLE_STATUSES), so a remote pane that died ends a wait rather than
#: running it out.
_ROSTER_IDLE_STATUSES = frozenset({"idle", "exited", "stopped", "error"})

#: Roster words that mean the pane is doing something. Deliberately a closed
#: list rather than "anything that is not idle": "waiting" is what a machine too
#: old to send a badge word reports for every pane whatever it is doing, and a
#: word this build has never heard of says nothing at all. Neither may be read
#: as "your message started a turn", so both stay outside this set and leave the
#: wait running. "awaiting" is inside it — the pane is parked, which is
#: something it started doing — but it is not in _ROSTER_IDLE_STATUSES, so it
#: never ends a wait either (see weakness 2 above).
_ROSTER_WORKING_STATUSES = frozenset({"running", "starting", "awaiting"})


@dataclass
class _RemoteResolution:
    """A resolved target that lives on another machine.

    `pane` is always None, and named the same as ResolveResult's on purpose: a
    tool that did not ask for remote targets keeps meeting the local registry
    entry it always did, and only the ones passing `allow_remote=True` ever see
    one of these.
    """

    address: Any
    entry: Any
    pane: None = None


def _remote_pane_for(address: Any) -> Any:
    """The roster row `address` names, or None when the roster has none.

    Matched on the three parts an address is made of. The roster is rebuilt
    wholesale on every push (remote_roster.replace), so a row is replaced rather
    than mutated — a poll has to look it up again each time instead of holding
    on to one.
    """
    from agent_team_backend import remote_roster

    for pane in remote_roster.list_panes():
        if (
            pane.device_id == address.device_id
            and pane.workspace == address.workspace
            and pane.pane_name == address.pane_name
        ):
            return pane
    return None


def _resolve_local_or_remote(me: str, target: str) -> tuple[Any, dict[str, Any] | None]:
    """`_resolve_pane_target`'s answer for a tool that can also read a remote pane.

    Local addressing wins exactly as it does in cli_send, because this is the
    same message_routing.route call: a target that resolves on this machine
    never reaches the roster, so the local answer is the one it always was.
    """
    from agent_team_backend import agent_messaging, message_routing

    routed = message_routing.route(me, target)
    if routed.pane is not None:
        return (
            agent_messaging.ResolveResult(
                pane=routed.pane, cross_workspace=routed.cross_workspace
            ),
            None,
        )
    if routed.remote is not None:
        entry = _remote_pane_for(routed.remote)
        if entry is not None:
            return _RemoteResolution(address=routed.remote, entry=entry), None
        # The address names another machine, but this machine's copy of the
        # session directory has no such pane in it — either no server is
        # configured at all, in which case `routed.error` already says that, or
        # the far pane is gone. Either way there is nothing here to read.
        return None, {
            "ok": False,
            "error": routed.error
            or (
                f'"{routed.remote.to_string()}" names a pane on another device, and '
                f"this machine's copy of the server's session directory does not "
                f"list it — read cli_list_targets' remote_targets for the ones it "
                f"does know about"
            ),
            "error_code": routed.code or "unknown-remote-pane",
        }
    return None, {
        "ok": False,
        "error": routed.error or f'unknown target "{target}"',
        "error_code": routed.code or "unknown-target",
    }


# ── Resolving a pane for the read-only cli_* tools ─────────────────────────
def _resolve_pane_target(
    caller: "_Caller", me: str, target: str, pane_id: str, allow_remote: bool = False
) -> tuple[Any, dict[str, Any] | None]:
    """Resolve `pane_id` when one was given, `target` otherwise.

    Shared by the tools that only read a pane, so an id means the same thing in
    all of them as it does in cli_send. Returns (result, failure): `failure` is
    the error dict to hand straight back, or None when `result.pane` is set.

    `allow_remote` opts a tool into `<device>/<workspace>/<pane>` targets. It is
    off by default because most of these tools cannot serve one — cli_read_log
    and cli_interrupt need something on this machine — and with it off the
    resolution is the local one, unchanged. With it on, a target that resolves
    locally still resolves locally; only one that does not can come back as a
    `_RemoteResolution`, whose `pane` is None and whose `entry` is a roster row.
    """
    from agent_team_backend import agent_messaging

    ident = (pane_id or "").strip()
    if ident:
        result = agent_messaging.resolve_pane_id(me, ident)
        if result.pane is None:
            return result, {
                "ok": False,
                "error": result.error,
                "error_code": result.code or "unknown-pane-id",
            }
        return result, None
    if caller.kind != "pane" and "/" not in (target or ""):
        return None, {"ok": False, "error": _QUALIFIED_TARGET_REQUIRED}
    if allow_remote:
        return _resolve_local_or_remote(me, target)
    result = agent_messaging.resolve(me, target)
    if result.pane is None:
        return result, {
            "ok": False,
            "error": result.error or f'unknown target "{target}"',
            "error_code": result.code or "unknown-target",
        }
    return result, None


@server.tool()
async def cli_read_log(
    target: str,
    ctx: Context,
    tail_lines: int = 200,
    since: int | None = None,
    pane_id: str = "",
) -> dict[str, Any]:
    """Read a CLI pane's conversation log file.

    `target` uses the same addressing as cli_send (cli_list_targets shows the
    forms); a caller with no pane identity must use the qualified
    `<folder>/<pane>` form. `pane_id` names one exact pane and makes `target`
    unnecessary — cli_send documents when to reach for it. Returns
    {ok, target, log_path, text, truncated, next_cursor, rotated} — `text` is
    at most 512KB and `tail_lines` lines, whichever is smaller; `truncated` is
    true when older content was dropped to fit. Fails when the target is
    unknown or its log file was never recorded / no longer exists.

    `since` reads incrementally: pass the `next_cursor` from your previous
    call to get only what the pane has said since then, instead of re-reading
    the same tail. The cursor is a byte offset into an append-only capture
    file. If the file was truncated or replaced under you the cursor no longer
    means anything — the call then returns a plain tail with `rotated: true`,
    so treat that read as a fresh start rather than as new output.
    """
    from agent_team_backend import app

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    me = caller.pane_id if caller.kind == "pane" else ""
    result, failure = _resolve_pane_target(caller, me, target, pane_id)
    if failure is not None:
        return failure

    def _find_log_path() -> str:
        project = app.project_store.peek(result.pane.workspace_path)
        if project is None:
            return ""
        record = next((p for p in project.panes if p.pane_id == result.pane.pane_id), None)
        return record.output_log_file if record else ""

    log_path_str = await asyncio.to_thread(_find_log_path)
    if not log_path_str:
        return {
            "ok": False,
            "error": f"no log file recorded for pane {result.pane.qualified_name!r}",
        }
    log_path = Path(log_path_str)
    if not log_path.is_file():
        return {"ok": False, "error": f"log file no longer exists: {log_path}"}

    text, truncated, rotated, next_cursor = await asyncio.to_thread(
        _read_log_window,
        log_path,
        None if since is None else max(0, int(since)),
        max(1, int(tail_lines)),
    )
    return {
        "ok": True,
        "target": result.pane.qualified_name,
        "log_path": str(log_path),
        "text": text,
        "truncated": truncated,
        "rotated": rotated,
        "next_cursor": next_cursor,
    }


def _activity_summary(pane_id: str) -> dict[str, Any] | None:
    """The pane's last recorded activity, shaped for a tool result.

    Only turn_complete carries text; agent_active never does.
    """
    from agent_team_backend import app

    activity = app.pane_activity(pane_id)
    if activity is None:
        return None
    last: dict[str, Any] = {
        "type": activity["event_type"],
        "age_seconds": round(time.monotonic() - activity["ts_monotonic"], 1),
    }
    if activity["text"]:
        last["text"] = activity["text"]
    return last


async def _cached_usage_snapshot(agent_key: str) -> dict[str, Any] | None:
    """The quota row usage_service already holds for *agent_key*, or None.

    Cache only — the same `payload()` cli_usage serves, off the loop for the
    same reason (it walks stale snapshots to re-check reset windows). Never
    asks for a refresh: cli_get_status sits under cli_wait_idle's poll, and a
    vendor read there would turn a millisecond call into a multi-second one.
    A payload failure is answered with None rather than failing the status
    the rest of the reply already has — the same degraded answer `ui` gives.
    """
    from agent_team_backend.usage_service import service

    try:
        payload = await asyncio.to_thread(service.payload)
    except Exception:  # noqa: BLE001 — status must still answer without quota
        return None
    snapshot = (payload.get("providers") or {}).get(agent_key)
    return dict(snapshot) if isinstance(snapshot, dict) else None


@server.tool()
async def cli_get_status(target: str, ctx: Context, pane_id: str = "") -> dict[str, Any]:
    """Report whether a CLI pane is busy and its most recent activity.

    `target` uses the same addressing as cli_send, and `pane_id` names one
    exact pane instead. Returns {ok, name,
    agent_key, busy, last_activity?, usage?, git?, ui?, prompt_fingerprint?}. `last_activity`, when known,
    is {type: "agent_active"|"turn_complete", text? (turn_complete only),
    age_seconds}. `ui`, when the owning Navide window answers in time, is
    {status, buffer, logPath?, awaitingKind?, kickoff?, agentLabel?, model?,
    effort?, profileId?, loginExpired?, usageLimitUntil?} straight from the
    renderer; it is omitted (not a failure) when the window does not reply.
    `busy` is the backend's own activity verdict OR'd with that badge: true
    when `ui.status` is "running" or "starting", since the renderer sees
    things the activity log cannot (a delivered message the CLI has queued
    but not yet consumed). Without a `ui` block it is the backend's alone.

    The identity keys in `ui` describe what the pane was LAUNCHED with, each
    present only when it has a value: `agentLabel` is the vendor's display
    name behind `agent_key`; `model` / `effort` are what cli_open_agent or the
    spawn form asked for — absent means the vendor's own default, and a
    `/model` switch typed inside the CLI is invisible here; `profileId` is
    the account pin the pane was spawned on ("__default__" = the real home),
    bookkeeping only — every pane runs on the vendor's live credentials, so
    after an account switch it names the old login while the CLI already runs
    on the new one; `loginExpired` (true) and `usageLimitUntil` (wall-clock
    ms) appear only while the CLI has printed its expired-login / hit-your-
    limit message — live detection from the pane's output, not a poll.

    `usage` is the quota snapshot Navide holds for this pane's vendor, the
    same row cli_usage reports under `providers[agent_key]` and unchanged from
    what the vendor said: {provider, status, planType, windows, fetchedAt,
    stale, …}. It is a CACHED read — nothing is refreshed on this call, which
    cli_wait_idle polls every second — so `fetchedAt` / `stale` say how old it
    is, and cli_usage or the window's own refresh is where a fresh number
    comes from. For claude it is the ACTIVE account's snapshot, which is the
    login every claude pane actually runs on (see `profileId` above). Absent
    when Navide has no snapshot for that vendor at all.

    `git` is the pane's checkout, in the shape and with the caveats
    cli_list_targets gives it: branch, worktree, dirty count and drift against
    origin/main, cached for up to ~30 s. Absent outside a repository, when git
    did not answer in time, and for a remote target.

    While `ui.status` is "awaiting", `ui` also carries what the pane is
    waiting on, read off its screen: `awaitingPrompt` (the prompt text) and,
    when the screen shows a numbered menu, `awaitingOptions` (its rows, option
    1 first). The reply then has a top-level `prompt_fingerprint` naming that
    exact prompt; pass it to cli_answer_prompt to answer the pane, which
    refuses when the screen has moved on.

    `ui.kickoff` is how this pane's spawn-time task injection ended, and it is
    the authoritative answer to "did cli_open_agent's task actually arrive":

      - "sent" — our own text was observed landing in the composer.
      - "unverified" — the bytes were written and the echo check passed, but
        only on buffer growth, which a CLI painting its first screen does
        whatever happened to our text. Treat it as "probably not delivered":
        read `buffer`, and re-send with cli_send if the prompt is empty.
      - "failed" — the injection did not go in. 
      - "pending" — still running.

    Absent when the pane was not spawned with a task.

    A `<device>/<workspace>/<pane>` target is answered from Navide-Server's
    session directory instead, and comes back in cli_list_targets'
    `remote_targets` shape — {ok, remote: true, source: "roster_status", name,
    address, device, workspace, workspace_path, agent_key, busy, offline,
    host_online, status} — with `source` naming where the answer came from.
    That answer is WEAKER in three ways and none of them are hidden: there is
    no `last_activity` and no `ui` block (neither the local activity log nor
    the owning window is reachable from here), `status` is one word with no
    `awaitingKind` behind it, so an "awaiting" pane may be parked on a human or
    merely asking a question, and the word itself is what the far window last
    uploaded — near-live, not live. `offline` is its own answer, not a kind of
    busy: it means the far machine or its window is away, and the row you are
    reading is the last thing the server said about a pane nobody can reach.
    There is no `usage` either: this machine's quota cache describes this
    machine's logins, which is the wrong answer for a pane running elsewhere.
    """

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    me = caller.pane_id if caller.kind == "pane" else ""
    result, failure = _resolve_pane_target(caller, me, target, pane_id, allow_remote=True)
    if failure is not None:
        return failure
    if result.pane is None:
        # A pane on another machine: the roster row is the whole answer, and
        # `source` says as much rather than letting it pass for a local read.
        return {
            "ok": True,
            "remote": True,
            "source": "roster_status",
            **result.entry.to_dict(),
        }
    pane = result.pane

    status: dict[str, Any] = {
        "ok": True,
        "name": pane.name,
        "agent_key": pane.agent_key,
        "busy": pane.busy,
    }
    last = _activity_summary(pane.pane_id)
    if last is not None:
        status["last_activity"] = last
    usage = await _cached_usage_snapshot(pane.agent_key)
    if usage is not None:
        status["usage"] = usage
    git = await pane_git(pane.pane_id, pane.workspace_path)
    if git is not None:
        status["git"] = git

    ui_result = await _ui_request(
        pane.workspace_path,
        "invoke",
        caller=_pane_caller(pane.pane_id),
        action="ui.pane.getStatus",
        args={"paneId": pane.pane_id},
    )
    if ui_result.get("ok") and isinstance(ui_result.get("result"), dict):
        status["ui"] = ui_result["result"]
        # One answer, not two that disagree: the badge only ever ADDS busy.
        if ui_result["result"].get("status") in ("running", "starting"):
            status["busy"] = True
        prompt = ui_result["result"].get("awaitingPrompt")
        if ui_result["result"].get("status") == "awaiting" and isinstance(prompt, str) and prompt.strip():
            options = ui_result["result"].get("awaitingOptions")
            status["prompt_fingerprint"] = _prompt_fingerprint(
                prompt, [str(o) for o in options] if isinstance(options, list) else [])
    return status


_WAIT_IDLE_POLL_S = 1.0
_WAIT_IDLE_QUIET_S = 10.0
_WAIT_IDLE_MAX_TIMEOUT_S = 120.0


# ── Who is parked waiting on a pane (cli_whoami's `waiting_on_me`) ─────────
# A wait used to be invisible to the pane it waited on. An agent a minute into
# somebody's two-minute budget would keep digging, because nothing told it that
# anyone had stopped to wait — so the waiter timed out and both ends acted on a
# decision they would not have made had either known. Every wait registers here
# for as long as it is parked, and cli_whoami hands the answer back.
#
# Keyed by the target's live pane id, then by WHO is waiting: one entry per
# caller per target, refcounted, because cli_send_and_wait nests cli_wait_idle
# inside its own registration and two rows for one waiting call would overstate
# the queue. A caller with no pane identity has no name to give, so every host
# caller shares the key "host" and every external one "external"; concurrent
# waits from those collapse into one row dated from the earliest of them, which
# understates how many are waiting and never how long.
#
# Nothing prunes this and nothing needs to: a row only exists inside a call
# hard-capped at _WAIT_IDLE_MAX_TIMEOUT_S, and the finally below runs on
# timeout, exception and cancellation alike (a client that disconnects cancels
# the task), so the table is bounded by the waits actually in flight. It is
# process memory like _mcp_message_status: a restart forgets every wait, and
# every waiter is gone with it.
_idle_waiters: dict[str, dict[str, dict[str, Any]]] = {}


@contextmanager
def _waiting_on(target_pane_id: str, caller: _Caller) -> Iterator[None]:
    """Register *caller* as blocked on *target_pane_id* for the duration."""
    key = caller.pane_id if caller.kind == "pane" else caller.kind
    waiters = _idle_waiters.setdefault(target_pane_id, {})
    entry = waiters.get(key)
    if entry is None:
        waiters[key] = {"kind": caller.kind, "since": time.monotonic(), "count": 1}
    else:
        entry["count"] += 1
    try:
        yield
    finally:
        held = _idle_waiters.get(target_pane_id, {}).get(key)
        if held is not None:
            held["count"] -= 1
            if held["count"] <= 0:
                del _idle_waiters[target_pane_id][key]
                if not _idle_waiters[target_pane_id]:
                    del _idle_waiters[target_pane_id]


def _waiting_on_me(pane_id: str) -> list[dict[str, Any]]:
    """Who is parked in a wait on *pane_id* right now, longest wait first.

    Identities are resolved now rather than at registration, so a waiter whose
    pane was rebuilt around its running CLI is reported under the identity it
    answers to today — the same reason cli_whoami reads `spawned_by` through
    ``current``. A waiter that is no longer registered at all is still waiting,
    so its row keeps the id and simply has no name to show.
    """
    from agent_team_backend import agent_messaging

    now = time.monotonic()
    rows: list[dict[str, Any]] = []
    for key, entry in _idle_waiters.get(pane_id, {}).items():
        row: dict[str, Any] = {"waiting_s": round(now - entry["since"], 1)}
        if entry["kind"] == "pane":
            waiter = agent_messaging.current(key)
            if waiter is None:
                row["pane_id"] = key
            else:
                row["pane_id"] = waiter.pane_id
                row["name"] = waiter.name
                row["address"] = waiter.qualified_name
        else:
            row["caller"] = entry["kind"]
        rows.append(row)
    rows.sort(key=lambda row: row["waiting_s"], reverse=True)
    return rows

# Poll the owning window this often (in poll ticks) for its own view of the
# pane. The registry's busy flag is reported by the frontend and can stay
# stale, and log-reader activity only exists for the CLIs whose reader emits
# it — the renderer's status is the one signal that is always current.
_WAIT_IDLE_UI_PROBE_EVERY = 5
# A window that misses one probe is not necessarily gone — it may just be busy
# enough to miss the deadline — but with no window listening at all every probe
# burns the full _ui_request timeout. So back off (the interval doubles per
# consecutive failure) instead of retrying at the normal rate, and only give up
# for good after this many failures in a row.
_WAIT_IDLE_UI_MAX_FAILURES = 3
# Deliberately excludes "awaiting": a pane parked on a permission prompt is
# quiet, but it is waiting on the USER, and sending it work would answer the
# prompt instead of starting a turn. Waiting it out until the timeout is the
# safe failure here.
_UI_IDLE_STATUSES = frozenset({"idle", "exited", "stopped", "error"})

# ...with one exception inside "awaiting". The renderer merged its two parked
# states into one badge, so "awaiting" now covers both a permission prompt and
# the agent asking a question, and only `awaitingKind` separates them. A
# question renames panes the renderer already reported as "idle" here (a turn
# that ended on one), so treating it as busy would make cli_wait_idle newly
# block until timeout on exchanges it has always returned from. It mirrors the
# messaging gate in App.vue, which passes a question for the same reason.
#
# A reply with no awaitingKind is treated as the permission case: this crosses
# a language boundary that no type checker guards, so an older window that
# does not send the field must fail toward the safe side.
_UI_IDLE_AWAITING_KINDS = frozenset({"question"})


async def _wait_idle_remote(address: Any, timeout_s: float) -> dict[str, Any]:
    """cli_wait_idle for a pane on another machine.

    Polls the roster, because none of the three local signals exist here: there
    is no activity log for a pane this machine does not own, no turn_complete
    ever crosses the link, and the window that could be probed belongs to
    somebody else. One word per poll is the whole input.

    Settles on four answers instead of the local five:

      - `source: "roster_status"`, idle true — the far window's badge says the
        pane is not working (idle) or that its session is over (exited /
        stopped / error, which the local path settles on too).
      - `source: "roster_offline"`, idle false, `reason: "offline"` — the far
        machine is away or its window disconnected. Deliberately its own
        answer: it is neither busy nor idle, and the roster keeps the pane
        listed while it is gone, so "no answer" and "not working" would
        otherwise look the same. Returned as soon as it is seen rather than
        waited out — a window that is not there cannot report a turn ending.
      - `source: "timeout"` with `reason` — see below.
      - `{ok: false}` — the pane dropped out of the roster entirely during the
        wait, so there is nothing left to watch.

    `reason` on timeout is "busy" for a pane that stayed at work, and
    "awaiting_unclassified" for one parked on "awaiting". That second one is
    the honest name for what cannot be known from here: locally `awaitingKind`
    separates a permission prompt (waiting on a HUMAN) from an open question
    (which counts as idle), and the roster carries no such field, so an
    "awaiting" pane is left running the wait out and the reason says why the
    two were never told apart.
    """
    timeout = min(max(float(timeout_s), 0.0), _WAIT_IDLE_MAX_TIMEOUT_S)
    started = time.monotonic()
    while True:
        # Looked up again every poll: a roster push replaces the row object
        # rather than mutating it, so a held reference would never change.
        entry = _remote_pane_for(address)
        if entry is None:
            return {
                "ok": False,
                "error": f'"{address.to_string()}" is no longer listed in the session '
                f"directory this machine has from the server, so there is nothing "
                f"left to wait on",
                "error_code": "unknown-remote-pane",
            }
        waited = time.monotonic() - started
        answer: dict[str, Any] = {
            "waited_s": round(waited, 1),
            "remote": True,
            "address": entry.address,
            "status": entry.status,
            "host_online": entry.host_online,
        }
        if not entry.host_online or entry.status == "disconnected":
            return {**answer, "idle": False, "source": "roster_offline", "reason": "offline"}
        if entry.status in _ROSTER_IDLE_STATUSES:
            return {**answer, "idle": True, "source": "roster_status"}
        if waited >= timeout:
            return {
                **answer,
                "idle": False,
                "source": "timeout",
                "reason": (
                    "awaiting_unclassified" if entry.status == "awaiting" else "busy"
                ),
            }
        await asyncio.sleep(_WAIT_IDLE_POLL_S)


def _ui_status_is_idle(payload: dict[str, Any]) -> bool:
    """Whether a `ui.pane.getStatus` reply means the pane can take work."""
    status = str(payload.get("status") or "")
    if status in _UI_IDLE_STATUSES:
        return True
    if status != "awaiting":
        return False
    return str(payload.get("awaitingKind") or "") in _UI_IDLE_AWAITING_KINDS


@server.tool()
async def cli_wait_idle(
    target: str, ctx: Context, timeout_s: float = 60.0, pane_id: str = ""
) -> dict[str, Any]:
    """Block until a CLI pane goes idle, or a timeout passes.

    `target` uses the same addressing as cli_send, and `pane_id` names one
    exact pane instead. `timeout_s` is capped at
    120s. Three signals settle it, in the order they become available: the
    pane's last activity was a turn_complete (aider/antigravity/claude/codex/
    copilot/cursor/kilo/muse/opencode report one directly, so detection is
    precise for them; grok/kimi/pi/qwen synthesize one from 8s of silence, so
    theirs is already an inference); at least 10s of silence
    passed since its last activity; or, while the registry still reports busy,
    the owning window reports the pane itself as idle/exited/stopped/error.
    That last one matters because the busy flag is frontend-reported and can
    stay stale. Returns {idle, source, waited_s, last_activity?, ui_status?}
    where source is "turn_complete", "quiet_period", "ui_status",
    "never_started", or "timeout"; or {ok: false, error} if `target` cannot be
    resolved.

    `last_activity` is what cli_get_status reports under the same key — {type,
    text? (turn_complete only), age_seconds} — so a caller that waited for a
    turn to end also gets what the turn said, without a second call. It is
    absent for a pane whose CLI records no activity at all. `ui_status` is the
    owning window's own word for the pane, present only when a probe reached
    it during the wait.

    "never_started" is idle in the sense that nothing is running, but the pane
    has shown no activity at all — a CLI that finished booting and is sitting
    at its prompt. If you just gave it a task, that task has not begun yet;
    keep waiting rather than treating it as done.

    On timeout the result also carries `reason`, which separates three very
    different failures: "awaiting" (the pane is parked on a permission prompt
    and is waiting on a HUMAN, not on work — answer it in the UI), "busy" (it
    really is still working; wait longer), and "unreachable" (the window that
    owns the pane stopped answering, so nothing here is current).

    A `<device>/<workspace>/<pane>` target is waited on through Navide-Server's
    session directory, and that wait is WEAKER than this one — read `source`,
    which never says "turn_complete" for a remote pane because no end-of-turn
    signal crosses the link. It settles as "roster_status" (the far window's
    badge stopped saying the pane was working), "roster_offline" (that machine
    or its window went away — a third answer, neither busy nor idle), or
    "timeout" with `reason` "busy" or "awaiting_unclassified" — the latter
    meaning the pane is parked and the roster does not carry the
    `awaitingKind` that would say whether it is stuck on a human or merely
    asking a question. There is no `last_activity` and no `ui_status`; the
    badge word is reported as `status`, and it is what the far window last
    uploaded (it debounces by 0.5s and re-sweeps every 30s), so it is near-live
    rather than live.
    """
    from agent_team_backend import agent_messaging, app

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    me = caller.pane_id if caller.kind == "pane" else ""
    result, failure = _resolve_pane_target(caller, me, target, pane_id, allow_remote=True)
    if failure is not None:
        return failure
    if result.pane is None:
        # No _waiting_on registration for a remote target: that table is keyed
        # by a local pane id and is read back by cli_whoami on this machine, so
        # a row for a pane on another one could never be seen by the pane it
        # was about.
        return await _wait_idle_remote(result.address, timeout_s)
    pane_id = result.pane.pane_id

    workspace_path = result.pane.workspace_path
    timeout = min(max(float(timeout_s), 0.0), _WAIT_IDLE_MAX_TIMEOUT_S)
    started = time.monotonic()

    ui_reachable = True
    ui_failures = 0
    next_ui_probe_tick = 0
    ui_status: str | None = None

    def done(source: str) -> dict[str, Any]:
        out: dict[str, Any] = {
            "idle": True,
            "source": source,
            "waited_s": round(time.monotonic() - started, 1),
        }
        last = _activity_summary(pane_id)
        if last is not None:
            out["last_activity"] = last
        if ui_status is not None:
            out["ui_status"] = ui_status
        return out

    def timed_out(waited: float) -> dict[str, Any]:
        # Three failures a caller has to tell apart, and only one of them is
        # "wait longer": parked on a human, genuinely working, or nobody left
        # to ask.
        if ui_status == "awaiting":
            reason = "awaiting"
        elif not ui_reachable or (ui_failures and ui_status is None):
            reason = "unreachable"
        else:
            reason = "busy"
        out: dict[str, Any] = {
            "idle": False,
            "source": "timeout",
            "reason": reason,
            "waited_s": round(waited, 1),
        }
        last = _activity_summary(pane_id)
        if last is not None:
            out["last_activity"] = last
        if ui_status is not None:
            out["ui_status"] = ui_status
        return out

    # Registered for exactly as long as this call is parked, so the pane
    # being waited on can see the wait (cli_whoami's `waiting_on_me`) and
    # wrap up rather than run out somebody's budget without knowing it.
    with _waiting_on(pane_id, caller):
        tick = 0
        while True:
            entry = agent_messaging.get(pane_id)
            busy = bool(entry.busy) if entry else False
            if not busy:
                activity = app.pane_activity(pane_id)
                if activity is None:
                    return done("quiet_period")
                if activity["event_type"] == "turn_complete":
                    return done("turn_complete")
                if time.monotonic() - activity["ts_monotonic"] >= _WAIT_IDLE_QUIET_S:
                    return done("quiet_period")
            elif ui_reachable and tick >= next_ui_probe_tick:
                # busy says otherwise, so ask the window that can actually see the
                # pane.
                ui = await _ui_request(
                    workspace_path,
                    "invoke",
                    caller=_pane_caller(pane_id),
                    action="ui.pane.getStatus",
                    args={"paneId": pane_id},
                )
                payload = ui.get("result") if ui.get("ok") else None
                if not isinstance(payload, dict):
                    ui_failures += 1
                    if ui_failures >= _WAIT_IDLE_UI_MAX_FAILURES:
                        ui_reachable = False
                    else:
                        next_ui_probe_tick = tick + _WAIT_IDLE_UI_PROBE_EVERY * (2**ui_failures)
                else:
                    ui_failures = 0
                    next_ui_probe_tick = tick + _WAIT_IDLE_UI_PROBE_EVERY
                    ui_status = str(payload.get("status") or "")
                    if _ui_status_is_idle(payload):
                        # A window reporting idle only means "not working right
                        # now". For a pane that has never shown any activity that
                        # means "has not started yet", not "finished" — a caller
                        # that just handed it a task must be able to tell those
                        # apart.
                        if app.pane_activity(pane_id) is None:
                            return done("never_started")
                        return done("ui_status")
            tick += 1
            waited = time.monotonic() - started
            if waited >= timeout:
                return timed_out(waited)
            await asyncio.sleep(_WAIT_IDLE_POLL_S)


# ── Interrupting another pane ────────────────────────────────────────────
@server.tool()
async def cli_interrupt(target: str, ctx: Context, pane_id: str = "") -> dict[str, Any]:
    """Ask a CLI pane to stop what it is doing, without closing it.

    This presses that CLI's interrupt key in its terminal — Ctrl-C for most
    vendors, Esc for codex — exactly what the pane's own stop button does. It
    is the middle rung: cli_send asks and waits for the current turn to finish,
    ui_invoke "ui.pane.close" takes the pane and its PTY away, and until now
    there was nothing in between.

    WHAT THIS DOES NOT DO. It sends a keystroke; it does not stop a turn. What
    the CLI makes of that keystroke is the CLI's business — most abort the
    running turn, some only clear the text sitting in the input box, and one
    already at an idle prompt may take a second press as "quit" and exit.
    Nothing here waits for a stop or verifies that one happened, so a result
    with `sent: true` means the bytes were written and nothing more. Check with
    cli_get_status or cli_wait_idle if you need to know, and prefer cli_send
    whenever the work can be allowed to finish.

    Interrupting an idle pane is NOT refused — clearing whatever is in its
    input box is a real reason to want it — but it is reported rather than
    passed off as a stop: `status_before` is the pane's status at the instant
    the key went in, and `advisories` says when no turn was interrupted (and
    that a line somebody had typed but not sent may be gone with it).

    `target` uses the same addressing as cli_send and `pane_id` names one exact
    pane instead. Panes on this machine only: an interrupt is a byte written
    into a local PTY and there is no relay for it, so a
    `<device>/<workspace>/<pane>` address fails with "interrupt-local-only" —
    that is a limit of this tool, not a wrong address.

    Returns {ok, target, name, sent, status_before, advisories?}. `sent` false
    means the interrupt was never issued — no live CLI behind the pane (a
    cold-restore placeholder, or one whose session is gone), or the owning
    window's own socket was down, in which case it drops the request rather
    than queueing a stop for whatever turn is running after it reconnects.
    `sent` true means the keystroke was issued and accepted; it is not a
    receipt from the CLI, and a PTY write that fails on the far side is logged
    there rather than reported here.
    """
    from agent_team_backend import message_routing

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    me = caller.pane_id if caller.kind == "pane" else ""
    result, failure = _resolve_pane_target(caller, me, target, pane_id)
    if failure is not None:
        # A name that failed locally may still be a perfectly good address for
        # a pane on another machine, and the local errors do not say so: an
        # id-shaped device segment answers "unknown-device", which is worded
        # for cli_send — the one caller that relays before it can reach that
        # error — and blames a missing server link; a device *name* does not
        # even get that far and comes back as "unknown workspace". Both would
        # send the caller to re-check an address that is not the problem.
        # message_routing.route is the same resolution cli_send uses, so
        # "this names a remote pane" means here exactly what it means there.
        if not (pane_id or "").strip():
            routed = message_routing.route(me, target)
            if routed.remote is not None:
                return {
                    "ok": False,
                    "error": (
                        f'cannot interrupt "{target}": it names a pane on another '
                        f"device, and an interrupt is a byte written straight into a "
                        f"local PTY — there is no relay for one at any link state. The "
                        f"address may be perfectly good; only panes on this machine can "
                        f"be interrupted from here. To stop a remote pane, cli_send it a "
                        f"message asking it to stop."
                    ),
                    "error_code": "interrupt-local-only",
                }
        return failure
    pane = result.pane
    if caller.kind == "pane" and pane.pane_id == caller.pane_id:
        # Interrupting yourself aborts the very turn making this call, so the
        # answer would never reach the caller that asked for it. cli_send
        # refuses a self-send for a milder reason (it would just be noise);
        # here the call destroys its own result.
        return {
            "ok": False,
            "target": pane.qualified_name,
            "error": (
                "that is your own pane — interrupting it would abort the turn "
                "making this call, so you would never see the answer. Stop by "
                "ending your turn instead."
            ),
            "error_code": "self-interrupt",
        }

    reply = await _ui_request(
        pane.workspace_path,
        "invoke",
        caller=_pane_caller(pane.pane_id),
        action="ui.pane.interrupt",
        args={"paneId": pane.pane_id},
    )
    if not reply.get("ok"):
        # Unlike cli_get_status's `ui` block there is no degraded answer to
        # give: the window is the only thing that can write to the PTY, so a
        # window that did not answer means nothing was sent.
        return {
            "ok": False,
            "target": pane.qualified_name,
            "error": str(reply.get("error") or "the window owning this pane did not answer"),
            "error_code": str(reply.get("error_code") or "ui_action_failed"),
        }
    payload = reply.get("result") or {}
    answer: dict[str, Any] = {
        "ok": True,
        "target": pane.qualified_name,
        "name": pane.name,
        "sent": bool(payload.get("sent")),
        "status_before": str(payload.get("status") or ""),
    }
    advisories = [str(a) for a in (payload.get("advisories") or [])]
    if advisories:
        answer["advisories"] = advisories
    return answer


# ── Answering another pane's prompt ──────────────────────────────────────
#: The answer words cli_answer_prompt takes besides an option number, as the
#: chat relay's choice letters (channels/relay.py).
_ANSWER_WORDS = {"allow": "y", "deny": "n"}


def _prompt_fingerprint(prompt: str, options: list[str]) -> str:
    """A short id for what a pane is waiting on: its prompt text and its menu,
    equal up to whitespace — the same rule the chat relay binds an answer to
    its prompt with (relay.same_prompt), since a re-rendered screen re-wraps."""
    text = " ".join((prompt or "").split()) + "\n" + "\n".join(" ".join(str(o).split()) for o in options)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _caller_label(caller: _Caller) -> str:
    from agent_team_backend import agent_messaging

    if caller.kind == "pane":
        entry = agent_messaging.current(caller.pane_id)
        return entry.qualified_name if entry is not None else caller.pane_id
    return caller.kind


def _record_agent_answer(pane: Any, who: str, what: str, decision: Any, action: str) -> None:
    """Write an agent's answer into the pane's Navide Guard audit trail — who
    answered, what it pressed, and Guard's verdict — so it can be traced back
    to an agent rather than passing for the user's own keypress."""
    from agent_team_backend.guard import runtime as guard_runtime

    try:
        guard_runtime.store().audit_add({
            "ts": time.time(), "pane_id": pane.pane_id, "vendor": pane.agent_key or "",
            "source": "agent", "tool": "answer_prompt",
            "excerpt": f"answered by agent {who} via MCP: {what}"[:500],
            "level": decision.level if decision is not None else "normal",
            "action": action,
            "rule_ids": list(decision.rule_ids) if decision is not None else [],
            "tainted": bool(decision.tainted) if decision is not None else False,
        })
    except Exception:  # noqa: BLE001 — the answer itself already stands
        _log.warning("cli_answer_prompt: audit write failed", exc_info=True)


def _answer_refusal(pane: Any, code: str, error: str, **extra: Any) -> dict[str, Any]:
    return {"ok": False, "target": pane.qualified_name, "sent": False,
            "error": error, "error_code": code, **extra}


@server.tool()
async def cli_answer_prompt(
    target: str, answer: str, prompt_fingerprint: str, ctx: Context, pane_id: str = ""
) -> dict[str, Any]:
    """Answer another CLI pane's permission prompt or option menu, as an agent.

    For a pane parked on "awaiting" — claude's permission box or
    AskUserQuestion menu, codex's approval menu, aider's (Y)es/(N)o line —
    this presses the CLI's own key for one choice, instead of cli_send typing
    prose the menu would not take. Read the prompt first: cli_get_status
    returns it as `ui.awaitingPrompt` and `ui.awaitingOptions` (the numbered
    menu rows), and `prompt_fingerprint` identifies exactly that screen.

    `answer` is "allow" (the menu's "Yes", option 1), "deny" (its "No"), or
    an option number "1".."9" from `ui.awaitingOptions`. aider takes only
    allow / deny. `prompt_fingerprint` must be the one cli_get_status gave
    for the prompt you decided on; when the screen has moved on since, the
    answer is refused with `error_code` "prompt-changed" and the reply
    carries the current `prompt`, `options` and `prompt_fingerprint` to
    decide again with.

    THIS IS DISCLOSED, NOT HIDDEN. Every answer is written to that pane's
    Navide Guard audit trail (source "agent", tool "answer_prompt": who
    answered, what was pressed, Guard's verdict), and the reply carries
    `answered_by_agent: true` with a `disclosure` line to pass on to the
    user. Approving a prompt is approving that pane's action on the user's
    behalf.

    Refused, each with its own `error_code` and nothing pressed:
      - "permanent-allow-refused" — a "don't ask again" / "always allow" /
        "for this session" option, or "allow" when option 1 is one: that
        choice is the user's, at the computer.
      - "guard-veto" — Navide Guard rates the prompt high or critical (or
        cannot screen it); approving needs the user. `guard` says why.
        Refusing ("deny", or a "No …" option) is never vetoed.
      - "computer-only" — a multi-select menu or a free-text row.
      - "unsupported-cli" — only claude, codex and aider have mapped keys.
      - "not-awaiting", "prompt-changed", "invalid-answer".
      - "answer-local-only" — a pane on another device: there is no relay.
    The raw key action (ui_invoke "ui.pane.sendKeys") stays refused for
    agents; this tool is the fenced way to the same keys.

    Returns {ok, target, sent, answer, chosen?, answered_by_agent,
    disclosure, guard?}. The window re-reads its screen right before pressing
    and refuses with "prompt-changed" when the prompt checked here (and
    screened by Guard) is no longer the one showing. `sent` true means the
    keys were written into the pane; it is not a receipt from the CLI —
    cli_get_status or cli_wait_idle tells you what happened next.
    """
    from agent_team_backend import message_routing
    from agent_team_backend.channels import relay

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    me = caller.pane_id if caller.kind == "pane" else ""
    result, failure = _resolve_pane_target(caller, me, target, pane_id)
    if failure is not None:
        if not (pane_id or "").strip() and message_routing.route(me, target).remote is not None:
            return {
                "ok": False,
                "error": (
                    f'cannot answer "{target}": it names a pane on another device, and '
                    f"an answer is keys written into a local PTY — there is no relay "
                    f"for one. Only panes on this machine can be answered from here."
                ),
                "error_code": "answer-local-only",
            }
        return failure
    pane = result.pane

    word = (answer or "").strip().lower()
    choice = _ANSWER_WORDS.get(word) or (word if len(word) == 1 and word in "123456789" else "")
    if not choice:
        return _answer_refusal(pane, "invalid-answer",
                               f'answer must be "allow", "deny" or an option number 1-9, not {answer!r}')
    if pane.agent_key not in relay.ANSWERABLE_AGENTS:
        return _answer_refusal(
            pane, "unsupported-cli",
            f"Navide has no answer keys for {pane.agent_key or 'this CLI'}; only "
            f"{', '.join(sorted(relay.ANSWERABLE_AGENTS))} can be answered. Answer it at the computer.")

    reply = await _ui_request(pane.workspace_path, "invoke", caller=_pane_caller(pane.pane_id),
                              action="ui.pane.getStatus", args={"paneId": pane.pane_id})
    if not reply.get("ok") or not isinstance(reply.get("result"), dict):
        return _answer_refusal(pane, str(reply.get("error_code") or "ui_action_failed"),
                               str(reply.get("error") or "the window owning this pane did not answer"))
    screen = reply["result"]
    if screen.get("status") != "awaiting":
        return _answer_refusal(pane, "not-awaiting",
                               f"the pane is {screen.get('status') or 'not awaiting'}, not waiting on a prompt")
    prompt = str(screen.get("awaitingPrompt") or "")
    raw_options = screen.get("awaitingOptions")
    options = [str(o) for o in raw_options] if isinstance(raw_options, list) else []
    current = _prompt_fingerprint(prompt, options)
    if (prompt_fingerprint or "").strip() != current:
        return _answer_refusal(
            pane, "prompt-changed",
            "the prompt on screen is not the one prompt_fingerprint names; read it and decide again",
            prompt=prompt, options=options, prompt_fingerprint=current)

    request = relay.RelayRequest(
        id="", pane_id=pane.pane_id, kind="question" if choice.isdigit() else "permission",
        options=options, loc=relay.Location("mcp", "", ""), prompt=prompt)
    if any(relay.is_multi_select(o) for o in options):
        return _answer_refusal(pane, "computer-only", relay.COMPUTER_ONLY)
    if relay.refuses_permanent(request, choice):
        return _answer_refusal(pane, "permanent-allow-refused",
                               "that choice allows more than this one prompt; only the user can make it")
    if choice.isdigit() and int(choice) <= len(options) and relay.is_free_text(options[int(choice) - 1]):
        return _answer_refusal(pane, "computer-only", relay.COMPUTER_ONLY)
    payload = relay.answer_payload(request, choice)
    if payload is None:
        return _answer_refusal(pane, "invalid-answer",
                               f"option {choice} is not on the menu (1-{len(options)})", options=options)
    chosen = options[int(choice) - 1] if choice.isdigit() and options else ""
    what = (f"option {choice} — {chosen}" if chosen else f"option {choice}") if choice.isdigit() else word
    who = _caller_label(caller)

    decision = None
    if not relay.is_deny(request, payload):
        decision = relay.screen_approval(pane.pane_id, prompt, pane.workspace_path)
        if decision.action != "allow":
            _record_agent_answer(pane, who, f"{what} (refused by Navide Guard)", decision, "deny")
            return _answer_refusal(
                pane, "guard-veto", "Navide Guard: approving this prompt needs the user at the computer",
                guard={"level": decision.level, "reason": decision.reason, "rule_ids": list(decision.rule_ids)})

    sent_reply = await _ui_request(pane.workspace_path, "invoke", caller=_pane_caller(pane.pane_id),
                                   action="ui.pane.sendKeys",
                                   # The window presses only while this same prompt is on screen: Guard
                                   # screened it, and one that has replaced it since must not be answered.
                                   args={"paneId": pane.pane_id, "answer": payload,
                                         "expected": {"prompt": prompt, "options": options}})
    keys = sent_reply.get("result") if isinstance(sent_reply.get("result"), dict) else {}
    sent = bool(sent_reply.get("ok")) and keys.get("ok", True) is not False and bool(keys.get("sent"))
    _record_agent_answer(pane, who, what if sent else f"{what} (not sent)", decision, "allow" if sent else "error")
    out: dict[str, Any] = {
        "ok": sent, "target": pane.qualified_name, "sent": sent, "answer": payload,
        "answered_by_agent": True,
        "disclosure": f"{pane.qualified_name}'s prompt was answered by agent {who}, not the user: {what}",
    }
    if chosen:
        out["chosen"] = chosen
    if decision is not None:
        out["guard"] = {"level": decision.level, "reason": decision.reason}
    if not sent:
        out["error"] = str(keys.get("error") or sent_reply.get("error") or "not sent")
        out["error_code"] = str(keys.get("error_code") or sent_reply.get("error_code") or "not-sent")
    return out


@server.tool()
async def cli_place_pane(
    target: str,
    ctx: Context,
    pane_id: str = "",
    run_group_id: str | None = None,
    spawned_by: str | None = None,
) -> dict[str, Any]:
    """Move a pane: change the tab group it sits in and/or the pane it is a
    child of. The write half of the lineage cli_list_targets and
    cli_list_sessions report.

    Two independent halves, each optional — pass only what should change:

    - `run_group_id`: the tab (run group) to move the pane to. `""` is the
      ungrouped 手動 tab. Read group ids off cli_list_sessions rows or
      ui_snapshot; an id no tab has is refused.
    - `spawned_by`: the pane to make this one a child of, as a `pane_id`
      (not a name — names are messaging addresses and can change). `""` makes
      it a root. Refused when the parent is the pane itself or one of its own
      descendants (the tree would loop), or a pane in another workspace.

    Both take `""` as a real value, which is why a half you do not pass is
    left alone rather than reset. Group is applied first, then parent, and the
    answer's `applied` says which halves landed — a parent refusal does not
    undo a group move that already did. Same write paths as dragging the pane
    in the sidebar, so the record and the screen agree and a restart keeps
    the position.

    Use it to tidy up after a resume that landed somewhere unhelpful, to adopt
    a pane opened by someone else into your own subtree, or to gather related
    panes onto one tab. It does not touch the pane's CLI: nothing is sent,
    interrupted or restarted. Local panes only — a `<device>/…` address is
    refused, since another machine's tree is that machine's to arrange.
    Returns `{ok, target, name, pane_id, applied, run_group_id, spawned_by}`
    with the position as it is afterwards.
    """
    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    if run_group_id is None and spawned_by is None:
        return {
            "ok": False,
            "error": "pass run_group_id and/or spawned_by — nothing to change",
            "error_code": "nothing-to-change",
        }
    me = caller.pane_id if caller.kind == "pane" else ""
    result, failure = _resolve_pane_target(caller, me, target, pane_id)
    if failure is not None:
        return failure
    # _resolve_pane_target without allow_remote already refuses a
    # `<device>/…` address, so only a local pane reaches here.
    pane = result.pane
    args: dict[str, Any] = {"paneId": pane.pane_id}
    if run_group_id is not None:
        args["runGroupId"] = run_group_id.strip()
    if spawned_by is not None:
        parent_id = spawned_by.strip()
        # Accept an alias for the parent too: ids change across rebuilds and
        # the caller may be holding one it read a while ago.
        if parent_id:
            current = agent_messaging_current(parent_id)
            if current is not None:
                parent_id = current.pane_id
        args["spawnedBy"] = parent_id
    reply = await _ui_request(
        pane.workspace_path,
        "invoke",
        caller=_pane_caller(pane.pane_id),
        action="ui.pane.place",
        args=args,
    )
    if not reply.get("ok"):
        return {
            "ok": False,
            "target": pane.qualified_name,
            "error": str(reply.get("error") or "the window owning this pane did not answer"),
            "error_code": str(reply.get("error_code") or "ui_action_failed"),
        }
    payload = reply.get("result") or {}
    return {
        "ok": True,
        "target": pane.qualified_name,
        "name": pane.name,
        "pane_id": pane.pane_id,
        "applied": payload.get("applied") or {},
        "run_group_id": str(payload.get("runGroupId") or ""),
        "spawned_by": str(payload.get("spawnedBy") or ""),
    }


def agent_messaging_current(pane_id: str) -> Any:
    """Alias-aware pane lookup, split out so the tool body stays readable."""
    from agent_team_backend import agent_messaging

    return agent_messaging.current(pane_id)


# How long to keep watching for the target to pick the message up before
# falling through to the idle wait. Delivery is queued behind whatever the
# pane is doing and the injected text only shows up as activity once its CLI
# records the prompt, so "nothing yet" right after the send is normal.
_SEND_AND_WAIT_START_GRACE_S = 10.0


def _never_arrived(sent: dict[str, Any], started: float) -> dict[str, Any]:
    """The message never reached the pane, so there is no turn to wait for.

    The bug this closes: a target that is idle when you send, with the message
    then held (someone typing in it, a queue ahead of it), used to answer
    "idle" from the state it was sent into — read as "it finished your work"
    when the work had not even been handed over.

    `ok` stays true for the same reason target_lost does: the send happened and
    `msg_key` is real, so answering false would read as "never sent" and invite
    a resend.
    """
    result: dict[str, Any] = {
        "ok": True,
        "target": sent["target"],
        "msg_key": sent["msg_key"],
        "idle": False,
        "source": "not_delivered",
        "delivery_status": sent.get("status", "queued"),
        "waited_s": round(time.monotonic() - started, 1),
    }
    for key in ("reason", "hold", "held_for_s", "stale"):
        if key in sent:
            result[key] = sent[key]
    return result


async def _send_and_wait_remote(
    target: _RemoteResolution,
    to: str,
    text: str,
    ctx: Context,
    *,
    timeout_s: float,
    pane_id: str,
    reply_to: str,
) -> dict[str, Any]:
    """cli_send_and_wait for a pane on another machine.

    The same three steps as the local path — buy the delivery with half the
    budget, give the target a moment to pick the message up, then wait for it
    to go quiet — with the one signal that does not exist across the link
    swapped out. Locally "did my message start a turn" is answered from the
    pane's activity log; here the only observable is the roster badge, so it is
    answered by having SEEN the pane working since the send
    (_ROSTER_WORKING_STATUSES). A pane that never visibly started still ends as
    reason "never_started", so an idle roster row can no more pass for a
    finished turn than a stale activity record can locally.

    The delivery gate itself is the same one and needs nothing special: a
    relayed message settles through record_remote_ack, whose three states
    (delivered / failed / rejected) land in the very table
    `wait_for_delivery_s` parks on.
    """
    started = time.monotonic()
    timeout = min(max(float(timeout_s), 0.0), _WAIT_IDLE_MAX_TIMEOUT_S)
    delivery_budget = timeout / 2
    sent = await cli_send(
        to, text, ctx, wait_for_delivery_s=delivery_budget, pane_id=pane_id,
        reply_to=reply_to,
    )
    if not sent.get("ok"):
        return sent
    if delivery_budget > 0 and sent.get("status") != "delivered":
        return _never_arrived(sent, started)

    def wrap(result: dict[str, Any]) -> dict[str, Any]:
        return {**result, "ok": True, "target": sent["target"], "msg_key": sent["msg_key"]}

    started_working = False

    def poll_started() -> bool:
        """Latch: has the roster shown this pane working since we sent?

        Latched rather than sampled because the badge is debounced on its way
        here — a turn that begins and ends between two uploads is a transition
        this side never sees, and a sample taken after it would say "idle" for
        a pane that did the work.
        """
        nonlocal started_working
        entry = _remote_pane_for(target.address)
        if entry is not None and entry.status in _ROSTER_WORKING_STATUSES:
            started_working = True
        return started_working

    # Same grace as the local path, waiting on the same question: give the
    # target a moment to pick the message up, so what follows is about its turn
    # rather than about the state it was already in.
    grace_deadline = started + min(timeout, _SEND_AND_WAIT_START_GRACE_S)
    while True:
        if poll_started() or time.monotonic() >= grace_deadline:
            break
        await asyncio.sleep(_WAIT_IDLE_POLL_S)

    while True:
        # Look before giving up, as the local path does: the grace window runs
        # to the deadline whenever timeout_s is under its cap, so the pane can
        # be first seen working with no budget left — and a pane seen working
        # is not "never_started". With no time left cli_wait_idle still checks
        # once.
        left = timeout - (time.monotonic() - started)
        waited = await cli_wait_idle(to, ctx, timeout_s=max(left, 0.0), pane_id=pane_id)
        if waited.get("ok") is False:
            # Same reading as the local target_lost: the send happened and
            # msg_key is real, so this is "delivered, but I can no longer
            # confirm it was finished" and must not invite a resend.
            return wrap(
                {
                    "idle": False,
                    "source": "target_lost",
                    "error": waited.get("error") or "the target is no longer addressable",
                    "waited_s": round(time.monotonic() - started, 1),
                }
            )
        if not waited.get("idle") or poll_started():
            return wrap(waited)
        if timeout - (time.monotonic() - started) <= 0:
            break
        await asyncio.sleep(_WAIT_IDLE_POLL_S)

    return wrap(
        {
            "idle": False,
            "source": "timeout",
            "reason": "never_started",
            "waited_s": round(time.monotonic() - started, 1),
        }
    )


@server.tool()
async def cli_send_and_wait(
    to: str,
    text: str,
    ctx: Context,
    timeout_s: float = 60.0,
    pane_id: str = "",
    reply_to: str = "",
) -> dict[str, Any]:
    """Send an instruction to another CLI pane and wait for it to finish it.

    cli_send followed by cli_wait_idle, with the race between them handled:
    the target is idle at the moment you send, so a plain wait would return
    "already idle" before it ever read your message. This one waits for the
    message to actually GO IN first, then remembers the target's last activity
    before sending and only accepts a turn NEWER than that as your answer.

    `to`, `text`, `pane_id`, `reply_to` and addressing are cli_send's — an id
    given here addresses both halves, the send and the wait. Answering a
    question with this tool is the case `reply_to` exists for, so it threads
    the same way a plain send does. `timeout_s` (capped at 120s)
    covers the whole thing, not just the wait: at most half of it is spent
    getting the message in, and whatever is left waits for the turn.

    On success returns cli_wait_idle's result — {idle: true, source, waited_s,
    last_activity?, ui_status?} — plus {ok: true, target, msg_key}.
    `last_activity.text` is what the other agent said, when its CLI records
    that. ALWAYS read `source`, because it says how much the "finished" is
    worth:

      - "turn_complete" — the CLI reported the turn ended. Trustworthy.
        aider/antigravity/claude/codex/copilot/cursor/kilo/muse/opencode report
        it directly; grok/kimi/pi/qwen infer it from 8s of silence, so it is a
        heuristic for them and a long pause mid-turn can end the wait early.
      - "quiet_period" — no end-of-turn signal ever arrived, the pane just
        went quiet. This is the only outcome available for a plain terminal
        pane, and the fallback whenever a turn ends without its reader
        recording one. Treat it as a guess and check the content.
      - "ui_status" — the owning window reports the pane idle.
      - "target_lost" — the target stopped being addressable during the wait
        (its window closed, the pane was killed), so the wait could not
        finish. The send still happened and `msg_key` is still valid; this is
        "delivered, but I can no longer confirm it was finished", NOT a failed
        send — do not resend on it. `error` carries the resolve failure.
      - "not_delivered" — the message never got into the pane, so there was no
        turn to wait for. `delivery_status` is "queued" (still waiting, with
        `hold` and `held_for_s` saying what for — typically someone typing in
        that pane, or a queue ahead of it), "failed"/"rejected" with
        `reason`, or "unconfirmed" (typed into a just-resumed CLI that has not
        shown it — check cli_get_status or cli_read_log before resending). A queued message is not lost: it goes in when the pane frees
        up, and cli_check_message picks the story up. Do NOT resend on this.

    On timeout returns {ok: true, idle: false, source: "timeout", reason,
    ...}: `reason` is cli_wait_idle's ("awaiting" / "busy" / "unreachable"),
    or "never_started" when the target stayed idle and never showed any sign
    of having read the message. `reason` is only meaningful for "timeout" and
    is absent from every other source. A send that is refused outright returns
    cli_send's {ok: false, error} unchanged.

    A `<device>/<workspace>/<pane>` target works end to end, and `source` is
    where you see what it cost. It is NEVER "turn_complete" for a remote pane
    — no end-of-turn signal crosses the link — and instead settles as
    "roster_status" (Navide-Server's session directory stopped reporting the
    pane as working, which is the strongest thing observable from here),
    "roster_offline" (the far machine or its window went away mid-wait: a
    third answer, neither busy nor idle), or "timeout" with `reason` "busy",
    "never_started", or "awaiting_unclassified" — that last one meaning the
    pane is parked and the roster carries no `awaitingKind`, so whether it is
    stuck on a human or merely asking a question could not be told apart. Nor
    is there a `last_activity`: what the other agent said cannot be read back
    from here, only that it appears to have stopped. "not_delivered" reaches
    remote targets too, and there `reason` is the far device's own ack —
    "rejected" meaning its pane policy refused, which resending will not fix.
    """
    from agent_team_backend import app

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    me = caller.pane_id if caller.kind == "pane" else ""
    if not (pane_id or "").strip() and _is_group_target(to):
        # Without this the group keyword would be resolved as a pane name and
        # come back "unknown target", which reads like a typo rather than like
        # the real answer: waiting is per-turn, and a broadcast has no single
        # turn to wait for.
        return {
            "ok": False,
            "error": 'cli_send_and_wait cannot broadcast — "group" reaches several '
            "panes and there is no one turn to wait for. Use cli_send with "
            'to="group", then cli_wait_idle on the recipients you care about',
            "error_code": "broadcast-unsupported",
        }
    # Same gate as cli_send, applied before the resolve below so an unqualified
    # address gets the same answer here as it would there.
    resolved, failure = _resolve_pane_target(caller, me, to, pane_id, allow_remote=True)
    if failure is not None:
        return failure
    if resolved.pane is None:
        return await _send_and_wait_remote(
            resolved, to, text, ctx,
            timeout_s=timeout_s, pane_id=pane_id, reply_to=reply_to,
        )
    target_pane_id = resolved.pane.pane_id

    baseline = app.pane_activity(target_pane_id)

    def has_new_activity() -> bool:
        # Identity, not timestamps: every recorded event is a new dict, while
        # two events inside one tick of a coarse monotonic clock (15.6 ms on
        # Windows) carry the same ts_monotonic and would read as no change.
        current = app.pane_activity(target_pane_id)
        return current is not None and current is not baseline

    started = time.monotonic()
    timeout = min(max(float(timeout_s), 0.0), _WAIT_IDLE_MAX_TIMEOUT_S)
    # Half the budget buys the delivery, the other half the turn it should
    # produce. Time spent waiting to get in is not lost — the message lands when
    # the pane frees up, which is most of what the idle wait was going to sit
    # through anyway — but a message still held at the halfway mark is unlikely
    # to be answered in what is left, and its hold reason is a far more useful
    # answer than "timeout, busy".
    delivery_budget = timeout / 2
    # The wait starts here, not at the idle loop below: a message held behind
    # whatever the target is mid-way through is the exact case this closes —
    # the target is busy, the sender is already parked on it, and only
    # `waiting_on_me` can tell the target that. The nested cli_wait_idle
    # registers the same caller against the same pane and is refcounted away.
    with _waiting_on(target_pane_id, caller):
        sent = await cli_send(
            to, text, ctx, wait_for_delivery_s=delivery_budget, pane_id=pane_id,
            reply_to=reply_to,
        )
    if not sent.get("ok"):
        return sent
    if delivery_budget > 0 and sent.get("status") != "delivered":
        return _never_arrived(sent, started)

    def remaining() -> float:
        return timeout - (time.monotonic() - started)

    def wrap(result: dict[str, Any]) -> dict[str, Any]:
        return {**result, "ok": True, "target": sent["target"], "msg_key": sent["msg_key"]}

    def target_lost(result: dict[str, Any]) -> dict[str, Any]:
        """Translate cli_wait_idle's {ok: false, error} into a wait outcome.

        It refuses that way when the target stops being addressable partway
        through — its window closed, the pane was killed — and passing that
        shape to wrap() would bury an `ok: false` under wrap's `ok: true` and
        return a result that contradicts itself. The send itself succeeded and
        `msg_key` is real, so answering `ok: false` would tell the caller the
        message never went out and invite a resend — duplicate dispatch, which
        is far worse than an unconfirmed wait. Report the send as the success
        it was, and let `source` say that the finish can no longer be
        confirmed. No `reason`: that key only means anything for "timeout".
        """
        return wrap(
            {
                "idle": False,
                "source": "target_lost",
                "error": result.get("error") or "the target is no longer addressable",
                "waited_s": round(time.monotonic() - started, 1),
            }
        )

    # Give the target a moment to pick the message up, so the wait below is
    # about its turn rather than about the state it was already in.
    grace_deadline = started + min(timeout, _SEND_AND_WAIT_START_GRACE_S)
    with _waiting_on(target_pane_id, caller):
        while True:
            if has_new_activity() or time.monotonic() >= grace_deadline:
                break
            await asyncio.sleep(_WAIT_IDLE_POLL_S)

    while True:
        # Look before giving up. The budget can be gone by the time the new
        # turn is first seen — the grace window runs to the deadline whenever
        # timeout_s is under its cap, and a stalled host spends it early — and
        # a turn already seen is the answer, not "never_started". With no time
        # left cli_wait_idle still checks once.
        waited = await cli_wait_idle(to, ctx, timeout_s=max(remaining(), 0.0), pane_id=pane_id)
        if waited.get("ok") is False:
            return target_lost(waited)
        if not waited.get("idle"):
            return wrap(waited)
        if has_new_activity():
            return wrap(waited)
        # Idle, but nothing has happened since the send — it has not started
        # the work yet, so this idleness is the state we sent into.
        if remaining() <= 0:
            break
        await asyncio.sleep(_WAIT_IDLE_POLL_S)

    # No last_activity here on purpose: the only thing on record is the state
    # the pane was in BEFORE the send, and handing that back is exactly the
    # mistake this tool exists to avoid.
    return wrap(
        {
            "idle": False,
            "source": "timeout",
            "reason": "never_started",
            "waited_s": round(time.monotonic() - started, 1),
        }
    )


# ── Host capability handoff (internal 23C seam) ─────────────────────────────
# This is deliberately not registered as a public MCP tool yet. Issue 23E
# supplies the production Plans tool route. Keeping the handoff here lets that
# route use the same authenticated Host boundary without allowing an MCP
# caller or package child to supply an Initiator object.
#
# The Host gives a backend call its own deadline (payload ``timeoutMs`` within
# its 120 s bound, else 30 s) and answers with a specific timeout error when it
# passes. Waiting a short grace past that deadline lets that answer arrive
# instead of the generic "did not answer".
_HOST_BACKEND_DEFAULT_TIMEOUT_S = 30.0
_HOST_BACKEND_MAX_TIMEOUT_MS = 120_000
_HOST_ANSWER_GRACE_S = 5.0
_AGENT_CAPABILITY_TIMEOUT_S = _HOST_BACKEND_DEFAULT_TIMEOUT_S + _HOST_ANSWER_GRACE_S
_agent_capability_pending: PendingRegistry[dict[str, Any]] = PendingRegistry()


def _host_answer_timeout_s(payload: dict[str, Any]) -> float:
    """How long to wait for the Host to answer a request carrying ``payload``."""
    timeout_ms = payload.get("timeoutMs")
    if (
        isinstance(timeout_ms, (int, float))
        and not isinstance(timeout_ms, bool)
        and 0 < timeout_ms <= _HOST_BACKEND_MAX_TIMEOUT_MS
    ):
        return timeout_ms / 1000 + _HOST_ANSWER_GRACE_S
    return _AGENT_CAPABILITY_TIMEOUT_S


def resolve_agent_capability(request_id: str, result: dict[str, Any]) -> bool:
    """Resolve one Host-brokered agent operation."""
    return _agent_capability_pending.resolve(request_id, result)


async def request_host_agent_capability(
    instance_id: str,
    operation: str,
    payload: dict[str, Any],
    *,
    caller: "_Caller",
) -> dict[str, Any]:
    """Handoff an authenticated MCP request to the Electron Host.

    ``caller`` has already passed :func:`_resolve_caller`. It is intentionally
    used only as an admission proof; the event carries no caller-provided
    Initiator. The Host mints the opaque agent Initiator after receiving it on
    its token-authenticated WebSocket session.
    """
    from agent_team_backend import app
    from agent_team_backend.ipc import make_event

    if not isinstance(instance_id, str) or not instance_id:
        return {"ok": False, "error": "plugin instance is required", "error_code": "bad_request"}
    if operation not in {"capability", "backend"} or not isinstance(payload, dict):
        return {"ok": False, "error": "agent capability request is malformed", "error_code": "bad_request"}
    if caller.kind not in {"pane", "host", "external"}:
        return {"ok": False, "error": "caller is not authenticated", "error_code": "unauthorized"}

    request_id = f"mcp:{secrets.token_hex(16)}"
    future = _agent_capability_pending.register(request_id)
    try:
        sent = await app.unicast_host(
            make_event(
                "agent.capability.request",
                {
                    "request_id": request_id,
                    "instance_id": instance_id,
                    "operation": operation,
                    "payload": payload,
                },
            )
        )
        if not sent:
            return {
                "ok": False,
                "error": "Navide Host is not connected",
                "error_code": "host_unavailable",
            }
        result = await _agent_capability_pending.wait(
            request_id,
            future,
            timeout=_host_answer_timeout_s(payload),
        )
        if result is TIMEOUT:
            return {
                "ok": False,
                "error": "Navide Host did not answer the capability request",
                "error_code": "host_timeout",
            }
        return result
    finally:
        _agent_capability_pending.discard(request_id)


async def request_host_agent_workspace_backend(
    plugin_id: str,
    workspace_path: str,
    payload: dict[str, Any],
    *,
    caller: "_Caller",
) -> dict[str, Any]:
    """Route one agent backend call to a Host-owned workspace binding.

    The workspace is a routing target, never an Initiator or package identity.
    The Electron Host authenticates the backend session, resolves/reuses its
    own headless package runtime, and mints the agent Initiator at that final
    boundary.
    """
    from agent_team_backend import app
    from agent_team_backend.ipc import make_event

    if not isinstance(plugin_id, str) or not plugin_id:
        return {"ok": False, "error": "plugin id is required", "error_code": "bad_request"}
    if not isinstance(workspace_path, str) or not workspace_path:
        return {"ok": False, "error": "workspace path is required", "error_code": "bad_request"}
    if not isinstance(payload, dict) or caller.kind not in {"pane", "host", "external"}:
        return {"ok": False, "error": "agent backend request is malformed", "error_code": "bad_request"}
    request_id = f"mcp:{secrets.token_hex(16)}"
    future = _agent_capability_pending.register(request_id)
    try:
        sent = await app.unicast_host(
            make_event(
                "agent.capability.request",
                {
                    "request_id": request_id,
                    "target": {"plugin_id": plugin_id, "workspace_path": workspace_path},
                    "operation": "backend",
                    "payload": payload,
                },
            )
        )
        if not sent:
            return {
                "ok": False,
                "error": "Navide Host is not connected",
                "error_code": "host_unavailable",
            }
        result = await _agent_capability_pending.wait(
            request_id,
            future,
            timeout=_host_answer_timeout_s(payload),
        )
        if result is TIMEOUT:
            return {
                "ok": False,
                "error": "Navide Host did not answer the backend request",
                "error_code": "host_timeout",
            }
        return result
    finally:
        _agent_capability_pending.discard(request_id)


# ── UI control (ui_invoke / ui_snapshot / ui_list_actions) ─────────────────
# Routes a request to the renderer window that owns `workspace_path` over WS
# (`ui.invoke.request`), and waits for its `ui.invoke.result` reply. Most
# requests broadcast, and every renderer decides for itself whether it owns
# the workspace; `global=True` requests (currently only ui.workspace.open, to
# open a workspace no window has yet) unicast to one arbitrary session instead,
# since any live window can perform them and broadcasting would just make every
# other window ignore it.

_UI_INVOKE_TIMEOUT_S = 15.0
# Spawning a pane has to wait out the CLI's own startup before it can hand it
# the task, which on its own reaches the default timeout — measured at 15s for
# claude. Giving these actions the same budget as an unanswered request means
# reporting failure for work that in fact succeeded, so they get their own.
_UI_INVOKE_SLOW_TIMEOUT_S = 60.0
#: Renderer commands whose argument names a pane's PRIVATE data — an inbox —
#: rather than a window or a project. `ui_invoke` forwards action and args
#: verbatim, so without this list a caller could name another pane's id and
#: read and consume its mail. These two are refused unless args.paneId is the
#: caller's own pane; the only legitimate emitter, cli_read_incoming, always
#: names its own.
#:
#: This is NOT a boundary around the inbox, and reading it as one would be a
#: mistake. A pane caller's identity is the `pane=<id>` query param it was
#: wired with, checked against a token shared by every pane on the machine
#: (wiring.caller_token — a freshness check, readable via `ps` by anything
#: running as the same user). So a local caller can present itself AS the
#: victim pane and satisfy the check below. What this list buys is that a
#: caller acting under its own identity cannot reach across to someone else's
#: inbox; closing the impersonation case needs a per-pane token.
#:
#: Deliberately a short explicit list, not "every action with a paneId": focus,
#: close, getStatus and interrupt are cross-pane by design.
_PANE_PRIVATE_UI_ACTIONS = frozenset({"ui.messaging.readIncoming", "ui.messaging.settleRead"})


def _human_only_refusal(action: str, args: dict[str, Any] | None) -> dict[str, Any] | None:
    """Refuse what only the user at the computer may do, for any MCP caller.

    ui.pane.sendKeys answers a pane's permission prompt or option menu, and
    ui.settings.yolo with yolo true makes every CLI skip its prompts; an agent
    doing either approves its own actions. Reading the switch and turning it
    off stay open. The chat relay presses keys through _ui_request directly
    (channels.default_seams), not through these tools, and is not affected.
    """
    if action == "ui.pane.sendKeys":
        error = "ui.pane.sendKeys answers a pane's prompt; only the user can do that, at the computer"
    elif action == "ui.settings.yolo" and (args or {}).get("yolo") is True:
        error = "請在 Settings 由使用者切換: turning the permission bypass on is the user's call"
    else:
        return None
    return {"ok": False, "result": None, "error": error, "error_code": "ui_human_only"}

# ui.pipeline.start spawns every slot of the run's first stage before it
# answers, so it is at least as slow as a single pane create and usually
# several times over. next / resume / restart all reach the same spawn loop
# (App.vue: onPipelineNext and onPipelineResume both await activateStage,
# onPipelineRestart kills the old panes and re-enters onPipelineStart), so a
# SUCCESSFUL call would report itself as an unresponsive window on the normal
# budget. ui.pipeline.reset and ui.pipeline.abort only tear down and stay out.
_UI_INVOKE_SLOW_ACTIONS = frozenset({
    "ui.pane.create",
    # Restores a placeholder around a spawned (often resumed) CLI: the same
    # startup wait as ui.pane.create, plus a session probe before it.
    "ui.pane.open",
    "ui.pipeline.start",
    "ui.pipeline.next",
    "ui.pipeline.resume",
    "ui.pipeline.restart",
    # Passing a gate hands off to the next stage; a reject re-runs a stage;
    # restart_from re-enters onPipelineStart. All three spawn panes.
    "ui.pipeline.gate_pass",
    "ui.pipeline.gate_reject",
    "ui.pipeline.restart_from",
})
_ui_invoke_pending: PendingRegistry[dict[str, Any]] = PendingRegistry()


def resolve_ui_invoke(request_id: str, result: dict[str, Any]) -> bool:
    """Hand a renderer window's ui.invoke.result to the waiting MCP call."""
    return _ui_invoke_pending.resolve(request_id, result)


def _pane_caller(pane_id: str) -> _Caller:
    """Address a UI request at the window hosting *pane_id* itself.

    For requests that are ABOUT one pane (ui.pane.getStatus) rather than about
    the caller: only the window that has that pane can answer them, and it is
    not necessarily the caller's own — a pane may ask about a pane in another
    window, and a host/external caller has no window at all. Handing
    :func:`_caller_window` the subject pane's identity resolves the right one;
    without it these fell back to broadcast, where a window that has since
    switched project answers nothing and each probe burns a full timeout.
    """
    return _Caller(kind="pane", pane_id=pane_id)


def _caller_window(caller: "_Caller | None", workspace_path: str) -> Any | None:
    """The WS connection of the window that mirrors the calling pane.

    A pane asking about its own workspace can only mean "in my own window", and
    that window is known: agent_messaging records which connection mirrors each
    pane. Addressing it directly is what lets a pane drive its own UI while its
    window sits in the background, or after that window switched to another
    project — neither of which the broadcast path survives, because there each
    window self-selects by comparing workspace_path against the workspace it
    *currently* has open, and a window that no longer matches simply says
    nothing (indistinguishable from a hang, at the cost of a full timeout).

    A workspace_path naming a *different* project is a deliberate call on
    someone else's window ("what does that window have registered?"), so it
    keeps the broadcast path rather than being quietly redirected home.

    Returns None for a host or external caller (no pane, so no window to
    address) and for a pane whose window is gone — both fall back to broadcast.
    """
    if caller is None or caller.kind != "pane":
        return None
    from agent_team_backend import agent_messaging

    # caller.pane_id is already the live id: _resolve_caller followed any alias
    # a re-attach left behind before handing it over.
    pane = agent_messaging.get(caller.pane_id)
    if pane is None:
        return None
    if workspace_path and _norm_workspace(workspace_path) != _norm_workspace(pane.workspace_path):
        return None
    session = agent_messaging.owner(caller.pane_id)
    return None if session is None or getattr(session, "dead", False) else session


def _ui_timeout_error(
    workspace_path: str, timeout: float, *, addressed: bool, global_action: str | None = None
) -> dict[str, Any]:
    """Explain an unanswered ui.invoke.request as one of three failures.

    The fixes are opposite — inspect a stuck window vs. check the path — so a
    silent deadline must not blend them into one sentence.

    An *addressed* request went to one known window (the caller's own, see
    :func:`_caller_window`), so reaching the deadline can only mean that window
    is busy or wedged; workspace_path never entered into it.

    A broadcast one is ambiguous. Windows mirror their CLI panes into
    agent_messaging, so a workspace with a connected pane has a live window
    *somewhere* — but the pane registry records the workspace a pane was
    spawned under, which is not the workspace its window has open now, so this
    cannot promise the path is right either; it says what it can prove and
    names the check. The reverse is a weaker hint still — a window with no CLI
    pane open answers ui.invoke while leaving no trace in the registry — so
    that branch names the failure it can prove (no window *known*) and hands
    over the workspaces the backend can see. All three read state the backend
    already holds; none adds a round trip.
    """
    from agent_team_backend import agent_messaging

    if global_action is not None:
        # A global request went to one window that announced it runs the UI
        # bus; workspace_path played no part in choosing it (it is often empty).
        return {
            "ok": False,
            "result": None,
            "error": (
                f"a Navide window received {global_action} but did not answer within "
                f"{timeout:.0f}s — it may still be running there, or the window is "
                "blocked (a native dialog freezes it). Retry, or check the window"
            ),
            "error_code": "ui_action_timeout",
        }
    if addressed:
        return {
            "ok": False,
            "result": None,
            "error": (
                f"your own Navide window was asked directly and did not answer within "
                f"{timeout:.0f}s — the action may still be running there, or that window "
                "is blocked (a native dialog freezes it). Retry, or check the window; "
                "workspace_path is not involved in this failure"
            ),
            "error_code": "ui_action_timeout",
        }
    connected = [e for e in agent_messaging.list_panes(workspace_path) if not e.offline]
    if connected:
        return {
            "ok": False,
            "result": None,
            "error": (
                f"no window answered for workspace_path {workspace_path!r} within "
                f"{timeout:.0f}s. A pane is registered under that path, so a window "
                "exists — but a broadcast request is answered only by the window whose "
                "*currently open* workspace matches, and a window that has since "
                "switched project no longer matches. Check what that window has open, "
                "or call from a CLI pane inside it (a pane's own window is addressed "
                "directly and needs no path match)"
            ),
            "error_code": "ui_action_timeout",
        }
    known = sorted({e.workspace_path for e in agent_messaging.list_panes() if not e.offline})
    return {
        "ok": False,
        "result": None,
        "error": (
            f"no reply for workspace_path {workspace_path!r} within {timeout:.0f}s, and "
            f"the backend sees no connected window for it. Workspaces it can see a "
            f"window for: {known}. Check workspace_path against that list first — but a "
            "window with no CLI pane open leaves no trace there, so if the path is "
            "right, treat this as a timeout and retry"
        ),
        "error_code": "ui_no_window_known",
    }


async def _ui_request(
    workspace_path: str,
    op: str,
    *,
    caller: "_Caller | None" = None,
    action: str | None = None,
    args: dict[str, Any] | None = None,
    is_global: bool = False,
) -> dict[str, Any]:
    from agent_team_backend import app
    from agent_team_backend.ipc import make_event

    request_id = secrets.token_hex(16)
    # Three ways out, narrowest first: a global action has no fixed owner and
    # goes to any one window; a pane caller's own window is known and is asked
    # directly ("addressed", so it answers without checking workspace_path);
    # anything else is broadcast for the windows to filter, as before.
    owner = None if is_global else _caller_window(caller, workspace_path)
    fut = _ui_invoke_pending.register(request_id)
    payload: dict[str, Any] = {
        "request_id": request_id,
        "workspace_path": workspace_path,
        "op": op,
        "action": action,
        "args": args,
        "global": is_global,
        "addressed": owner is not None,
        # Who is asking, from the credential and never from args: the renderer
        # refuses the pane-private actions when this is not the pane named in
        # args.paneId. Empty for host / external callers, which have no inbox.
        "caller_pane_id": caller.pane_id if caller is not None and caller.kind == "pane" else "",
    }
    # The event is built inside each branch, after `addressed` has settled:
    # make_event stores the payload by reference today, so mutating it after
    # the fact happened to reach the wire — but a make_event that copied or
    # serialized would have shipped addressed:true on the broadcast fallback,
    # and every window answers an addressed request without checking
    # workspace_path, racing N replies for one request id.
    if is_global:
        sent = await app.unicast_any(make_event("ui.invoke.request", payload))
        if not sent:
            _ui_invoke_pending.discard(request_id)
            return {
                "ok": False,
                "result": None,
                "error": "no Navide window is open to handle this request",
                "error_code": "ui_no_window",
            }
    elif owner is not None and await app.unicast_to(owner, make_event("ui.invoke.request", payload)):
        pass
    else:
        # The owner dropped between lookup and send: broadcast rather than fail,
        # and stop claiming the request was addressed — the timeout message
        # tells the two apart.
        payload["addressed"] = False
        await app.broadcast(make_event("ui.invoke.request", payload))

    timeout = _UI_INVOKE_SLOW_TIMEOUT_S if action in _UI_INVOKE_SLOW_ACTIONS else _UI_INVOKE_TIMEOUT_S
    result = await _ui_invoke_pending.wait(request_id, fut, timeout=timeout)
    if result is TIMEOUT:
        return _ui_timeout_error(
            workspace_path,
            timeout,
            addressed=bool(payload["addressed"]),
            global_action=(action or op) if is_global else None,
        )
    return result


#: How long workspace_open and cli_open_agent wait for a window to hold a
#: workspace. A new window loads its renderer and connects to the backend
#: before it answers anything; until then a broadcast for its workspace is
#: answered by nobody and is never replayed.
_WINDOW_READY_TIMEOUT_S = 15.0
#: One probe's wait. Short, because a probe sent before the window subscribed
#: is simply lost — the next one is what reaches it.
_WINDOW_PROBE_TIMEOUT_S = 1.0
#: Paths workspace_open has opened in this backend's lifetime, oldest first,
#: with when. workspace_list lists the ones Recent does not already hold.
_mcp_opened_workspaces: dict[str, str] = {}


async def _probe_window(workspace_path: str, timeout: float) -> bool:
    """Is a window holding *workspace_path* up and answering right now?

    A broadcast list_actions: the renderer answers it under the same ownership
    test (isLocalWorkspace) that agent_spawn.request uses, so an answer means
    a spawn request for that workspace would be picked up too.
    """
    from agent_team_backend import app
    from agent_team_backend.ipc import make_event

    request_id = secrets.token_hex(16)
    fut = _ui_invoke_pending.register(request_id)
    payload: dict[str, Any] = {
        "request_id": request_id,
        "workspace_path": workspace_path,
        "op": "list_actions",
        "action": None,
        "args": None,
        "global": False,
        "addressed": False,
        "caller_pane_id": "",
    }
    try:
        await app.broadcast(make_event("ui.invoke.request", payload))
    except BaseException:
        _ui_invoke_pending.discard(request_id)
        raise
    return await _ui_invoke_pending.wait(request_id, fut, timeout=timeout) is not TIMEOUT


async def _wait_window_ready(workspace_path: str) -> bool:
    """Probe until a window holds *workspace_path*, for at most
    _WINDOW_READY_TIMEOUT_S. False means no window answered in that time."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + _WINDOW_READY_TIMEOUT_S
    while (remaining := deadline - loop.time()) > 0:
        if await _probe_window(workspace_path, min(_WINDOW_PROBE_TIMEOUT_S, remaining)):
            return True
    return False


@server.tool()
async def ui_list_actions(workspace_path: str, ctx: Context) -> dict[str, Any]:
    """List the UI actions registered by the Navide window for workspace_path.

    Returns the list of registered action ids (plain strings), so a caller
    can discover what ui_invoke accepts before calling it. Errors if no
    window owns workspace_path within 15s.

    Called from a CLI pane, this goes to that pane's own window when
    workspace_path names that pane's own workspace (or is empty) — see
    ui_invoke.
    """
    caller = _resolve_caller(ctx)
    return await _ui_request(workspace_path, "list_actions", caller=caller)


@server.tool()
async def ui_invoke(
    workspace_path: str, action: str, ctx: Context, args: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Invoke a registered UI action in the Navide window for workspace_path.

    `action` must be one returned by ui_list_actions; `args` is passed through
    to it verbatim. `action` "ui.workspace.open" is routed differently: it has
    no fixed owner (the workspace may not have a window yet), so it is sent to
    any one live Navide window instead of broadcast to all. Errors if no
    window owns workspace_path (or, for ui.workspace.open, no window is open
    at all) within 15s.

    Called from a CLI pane, the request is delivered straight to the window
    that hosts that pane — whether or not it is focused, and whatever project
    that window currently has open — as long as workspace_path names that
    pane's own workspace (or is empty). Naming a DIFFERENT project is a
    deliberate call on someone else's window and keeps the broadcast path,
    where only a window with that project open answers; a caller with no pane
    identity (host / external) always depends on that match.

    Being delivered is not the same as being run against workspace_path. The
    actions that act on "the project this window is showing" — ui.pane.create,
    ui.preview.show, ui.window.openGit — are refused with an error when the
    hosting window has switched to another project, rather than silently
    running against the wrong one. Switch that window back, or spawn the pane
    from a window that has the project open.

    ui.pane.sendKeys, and ui.settings.yolo with yolo true, are refused with
    error_code "ui_human_only": answering a pane's prompt and switching the
    permission bypass on are the user's to do.

    ui.pane.reclaim frees a finished pane's resources without closing it — the
    same "reclaim now" the status bar and Resource Manager offer; cli_reclaim_agent
    does the same for one pane addressed by name, in whichever window has it. args
    {"paneId": id} or {"paneId": [id, ...]} (pane ids from cli_list_targets).
    Each CLI process ends and the pane stays as a click-to-resume card holding
    its conversation; the user resumes it by clicking. Use it from a parent pane
    on the children it opened once their work is reported. The status bar's
    guards apply unchanged, so a pane that is busy or awaiting an answer, the
    one the user has focused, one with unsent input, one with queued messages
    or a running pipeline/loop, and one whose session cannot be resumed are
    refused. Returns {reclaimed: [paneId], refused: [{paneId, reason, detail}]}
    with ok true even when every pane was refused.
    """
    caller = _resolve_caller(ctx)
    refusal = _human_only_refusal(action, args)
    if refusal is not None:
        return refusal
    if action in _PANE_PRIVATE_UI_ACTIONS:
        # Refused here as well as in the window: the renderer check is the one
        # that holds for every path a request can take, this one gives the
        # caller the reason without a round trip. Same rule on both sides.
        own = caller.pane_id if caller.kind == "pane" else ""
        named = str((args or {}).get("paneId") or "")
        if not own or named != own:
            return {
                "ok": False,
                "result": None,
                "error": (
                    f"{action} reads a pane's own inbox; it can only be invoked by that "
                    "pane for itself (use cli_read_incoming), not for another pane "
                    "and not by a host or external caller"
                ),
                "error_code": "ui_pane_private",
            }
    return await _ui_request(
        workspace_path,
        "invoke",
        caller=caller,
        action=action,
        args=args,
        is_global=action == "ui.workspace.open",
    )


@server.tool()
async def ui_snapshot(workspace_path: str, ctx: Context) -> dict[str, Any]:
    """Return a structured snapshot of UI state for the Navide window at workspace_path.

    Shape is decided by the renderer (panes, tabs, focus, etc.). Errors if no
    window owns workspace_path within 15s.

    Called from a CLI pane, this snapshots that pane's own window when
    workspace_path names that pane's own workspace (or is empty) — see
    ui_invoke. The snapshot then describes the project that window has open
    right now, which is not necessarily workspace_path.
    """
    caller = _resolve_caller(ctx)
    return await _ui_request(workspace_path, "snapshot", caller=caller)


@server.tool()
async def ui_diagnostics(
    workspace_path: str, ctx: Context, since_seq: int = 0, pane_id: str = "", limit: int = 50
) -> dict[str, Any]:
    """Read renderer-side diagnostics recorded by the Navide window at workspace_path.

    These are warnings the renderer logged about its own UI actions — e.g.
    injectText resending content because its echo check timed out, or giving
    up entirely — that a `ui_invoke` caller cannot see from `ok: true` alone
    (they only ever appeared in that window's devtools console before this).
    Use this to diagnose cases where a tool reported success but the actual
    in-window behavior looked wrong (duplicated input, a stuck send, etc.).

    `since_seq` returns only entries recorded after that sequence number —
    pass the `nextSeq` from a previous call to poll incrementally without
    re-reading old entries. `pane_id` filters to one pane; `limit` caps how
    many entries come back. Errors if no window owns workspace_path within 15s.

    Called from a CLI pane, this reads that pane's own window when
    workspace_path names that pane's own workspace (or is empty) — see
    ui_invoke.
    """
    caller = _resolve_caller(ctx)
    return await _ui_request(
        workspace_path,
        "invoke",
        caller=caller,
        action="ui.diagnostics.read",
        args={"sinceSeq": since_seq, "paneId": pane_id, "limit": limit},
    )


# ── Preview record (preview_record / preview_list / preview_show) ───────────
# One feed per workspace of what was changed or shown there, persisted by
# preview_log in the workspace database. These tools are the agent's end of it:
# a session reports its own writes, reads back what other writers reported, and
# pushes something in front of the user. The vocabulary mirrors preview_log's,
# minus what an agent must not claim by hand — "shown" is written by
# preview_show itself, only after the window confirms it took the push.

_RECORDABLE_CHANGES = ("created", "modified", "deleted")
_LISTABLE_CHANGES = (*_RECORDABLE_CHANGES, "shown")
_PREVIEW_KINDS = ("file", "diff", "snippet", "html", "markdown")
_INLINE_KINDS = ("snippet", "html", "markdown")


def _preview_log() -> Any:
    """The app-level PreviewLog, resolved at call time (app.py imports this
    module, so the singleton cannot be reached at import time)."""
    from agent_team_backend import app as _app

    return _app.preview_log


def _preview_pane(caller: _Caller) -> Any:
    """The calling pane's registry entry, or None for a non-pane caller.

    Attribution is taken from the credential, never from an argument: a caller
    cannot claim to be a pane it is not, and host/external callers simply
    record without attribution.
    """
    if caller.kind != "pane":
        return None
    from agent_team_backend import agent_messaging

    return agent_messaging.get(caller.pane_id)


async def _broadcast_preview_row(workspace_path: str, row: dict[str, Any] | None) -> None:
    """Put a freshly recorded row on every window showing that workspace.

    A None row is the store saying nothing new is on the feed (rejected, or
    folded into a record already there), so there is nothing to announce.
    """
    if row is None:
        return
    from agent_team_backend import app as _app
    from agent_team_backend.ipc import make_event

    await _app.broadcast(
        make_event("preview.recorded", {"workspace_path": workspace_path, "entry": row})
    )


def _preview_content(kind: str, rel_path: str, content: str) -> str:
    """Validate the kind/rel_path/content combination; returns the payload.

    File-backed kinds are addressed by path and carry no payload; inline kinds
    are the payload and have no path. Getting this wrong is the one failure the
    renderer reports as a flat "invalid preview target", so it is caught here.
    """
    if kind not in _PREVIEW_KINDS:
        raise FsError(f"invalid kind: {kind!r} (valid: {', '.join(_PREVIEW_KINDS)})")
    if kind not in _INLINE_KINDS:
        if not rel_path:
            raise FsError(f"kind {kind!r} previews a file — pass rel_path")
        return ""
    if not content:
        raise FsError(f"kind {kind!r} previews inline content — pass content")
    if len(content) > MAX_INLINE_CHARS:
        raise FsError(
            f"content is {len(content)} characters, over the {MAX_INLINE_CHARS} "
            "limit — write it to a file and preview that instead"
        )
    return content


@server.tool()
async def preview_record(
    ctx: Context,
    rel_path: str = "",
    change: str = "modified",
    note: str = "",
    kind: str = "file",
    content: str = "",
    title: str = "",
    workspace_path: str = "",
) -> dict[str, Any]:
    """Report a file you just created, modified or deleted in this workspace.

    Call it once per write, right after the write lands: the user then sees
    what you touched in Navide's Preview panel, and other sessions read it back
    with preview_list. The record is persisted in the workspace and survives
    restarts. Attribution (which pane, which agent) comes from your own
    credential — there is nothing to pass for it.

    change is one of created, modified, deleted; a preview push is recorded by
    preview_show instead, so "shown" is not accepted here. kind defaults to
    "file": pass rel_path (workspace-relative) for kind "file" or "diff", or
    content for an inline "snippet" / "html" / "markdown" record. note is a
    short reason ("added the retry guard"); title labels an inline record.

    Returns {uid, created_at, rel_path, change, merged}. merged is true when
    the event folded into a record already on the feed — same path, same
    change, a couple of seconds apart, e.g. the file watcher got there first —
    in which case nothing new was added and uid is "" with created_at 0. A
    "warning" field means no live Navide pane uses workspace_path, so the user
    cannot see this record where it landed.

    workspace_path defaults to your own pane's workspace; pass it only to
    record against another project.
    """
    caller = _resolve_caller(ctx)
    workspace_path = await _plan_workspace(caller, workspace_path)
    change = str(change or "").strip()
    if change not in _RECORDABLE_CHANGES:
        raise FsError(
            f"invalid change: {change!r} (valid: {', '.join(_RECORDABLE_CHANGES)})"
        )
    kind = str(kind or "").strip()
    rel_path = str(rel_path or "").strip()
    payload = _preview_content(kind, rel_path, content)
    pane = _preview_pane(caller)
    row = await asyncio.to_thread(
        _preview_log().append,
        workspace_path,
        change=change,
        kind=kind,
        rel_path=rel_path or None,
        title=title or None,
        source="agent",
        pane_id=pane.pane_id if pane else None,
        agent=(pane.agent_key or None) if pane else None,
        note=note or None,
        payload=payload or None,
    )
    await _broadcast_preview_row(workspace_path, row)
    result: dict[str, Any] = {
        "uid": row["uid"] if row else "",
        "created_at": row["created_at"] if row else 0,
        "rel_path": rel_path,
        "change": change,
        "merged": row is None,
    }
    warning = await asyncio.to_thread(_workspace_mismatch_warning, workspace_path)
    if warning:
        result["warning"] = warning
    return result


@server.tool()
async def preview_list(
    ctx: Context,
    limit: int = 50,
    since: int = 0,
    change: str = "",
    agent: str = "",
    workspace_path: str = "",
) -> dict[str, Any]:
    """Read back what has been created, modified, deleted or shown here.

    Use it to catch up on a workspace before editing in it: the feed carries
    what other sessions, the user, and the file watcher did, newest first, and
    survives restarts.

    limit caps how many come back (300 at most). since takes a created_at from
    an earlier call and returns only what happened after it, so you can poll
    without re-reading. change filters to one of created / modified / deleted /
    shown; agent filters to one vendor key (e.g. "claude").

    Returns {workspace_path, entries, truncated}; truncated is true when the
    limit cut the answer off, so raise it or page with since. Each entry has
    uid, created_at (epoch milliseconds), change, rel_path, kind, title, source
    (user / agent / watcher), pane_id, agent, tool, note, payload.

    workspace_path defaults to your own pane's workspace; pass it only to read
    another project's feed.
    """
    caller = _resolve_caller(ctx)
    workspace_path = await _plan_workspace(caller, workspace_path)
    change = str(change or "").strip()
    if change and change not in _LISTABLE_CHANGES:
        raise FsError(
            f"invalid change: {change!r} (valid: {', '.join(_LISTABLE_CHANGES)})"
        )
    limit = max(1, min(int(limit), MAX_ROWS))
    entries = await asyncio.to_thread(
        _preview_log().tail,
        workspace_path,
        limit,
        since=int(since) or None,
        change=change or None,
        agent=str(agent or "").strip() or None,
    )
    result: dict[str, Any] = {
        "workspace_path": workspace_path,
        "entries": entries,
        "truncated": len(entries) >= limit,
    }
    warning = await asyncio.to_thread(_workspace_mismatch_warning, workspace_path)
    if warning:
        result["warning"] = warning
    return result


@server.tool()
async def preview_show(
    ctx: Context,
    rel_path: str = "",
    kind: str = "file",
    content: str = "",
    title: str = "",
    workspace_path: str = "",
) -> dict[str, Any]:
    """Show a file, a diff, or inline content in Navide's Preview panel.

    This is how you put something in front of the user without them going
    looking for it: the file you just rewrote, the diff you want reviewed, a
    rendered report. The push reaches the Navide window that owns the
    workspace, and only lands on the record feed once that window confirms it
    took it — so a push nobody saw is never recorded as shown.

    kind "file" or "diff" needs rel_path (workspace-relative); "snippet",
    "html" and "markdown" need content (512 KB at most) and take an optional
    title.

    Returns the window's own reply — {ok, result, error} — plus recorded
    (whether a "shown" record was landed), uid, and merged (true when the push
    folded into an identical one already on the feed). ok false means no window
    took it: nothing was recorded, and the error says whether workspace_path is
    wrong or the window did not answer in time.

    workspace_path defaults to your own pane's workspace, which is the window
    the user is looking at; pass it only to show something in another project's
    window.
    """
    caller = _resolve_caller(ctx)
    workspace_path = await _plan_workspace(caller, workspace_path)
    kind = str(kind or "").strip()
    rel_path = str(rel_path or "").strip()
    payload = _preview_content(kind, rel_path, content)
    pane = _preview_pane(caller)
    args: dict[str, Any] = {"kind": kind, "source": "agent"}
    if pane is not None:
        args["origin"] = pane.name
    if kind in _INLINE_KINDS:
        args["content"] = payload
        if title:
            args["title"] = title
    else:
        args["workspacePath"] = workspace_path
        args["relPath"] = rel_path
    reply = await _ui_request(
        workspace_path, "invoke", caller=caller, action="ui.preview.show", args=args
    )
    result: dict[str, Any] = dict(reply)
    if result.get("ok") is not True:
        # The window never took it, so recording it as shown would log
        # something the user did not see.
        result["recorded"] = False
        return result
    row = await asyncio.to_thread(
        _preview_log().append,
        workspace_path,
        change="shown",
        kind=kind,
        rel_path=rel_path or None,
        title=title or None,
        source="agent",
        pane_id=pane.pane_id if pane else None,
        agent=(pane.agent_key or None) if pane else None,
        payload=payload or None,
    )
    await _broadcast_preview_row(workspace_path, row)
    result["recorded"] = True
    result["uid"] = row["uid"] if row else ""
    result["merged"] = row is None
    warning = await asyncio.to_thread(_workspace_mismatch_warning, workspace_path)
    if warning:
        result["warning"] = warning
    return result


# ── Read-only inventory (usage / workspaces / pipelines / skills / log) ─────
# Six Navide surfaces an agent could see nothing of: how much CLI quota is
# left, which projects it may address by path, the pipeline templates and roles
# a run is assembled from, where a run has got to, the shared skill library,
# and the persisted message log. Every tool here only reads — nothing is
# written, nothing is broadcast, and no window is asked for anything.

#: Whole prompts are what an inventory must not hand back: a role's
#: system_prompt and a slot's kickoff_body are each larger than the answer they
#: would be attached to, and neither is needed to choose between pipelines.
_PIPELINE_STAGE_FIELDS = (
    "id",
    "title",
    "short_title",
    "description",
    "sentinel",
    "allow_questions",
)
_PIPELINE_SLOT_FIELDS = ("agent_key", "role_key", "label", "is_commander")
_ROLE_FIELDS = ("key", "label", "one_line", "is_default")
# NodeRunState (src/renderer/src/lib/pipelineGraph.ts) minus `summary`, which
# is a whole output tail.
_NODE_STATE_FIELDS = ("status", "startedAt", "endedAt", "tokens", "paneId", "attempts", "pinned")

#: Execution state of a project: the run, not the window it is drawn in.
#: workspace_path is left out on purpose — the resolved one is reported instead.
_PROJECT_FIELDS = (
    "id",
    "name",
    "state",
    "task_description",
    "current_stage_index",
    "total_stages",
    "pipeline_id",
    "run_count",
    "log_file_name",
    "updated_at",
)
_STAGE_RECORD_FIELDS = (
    "stage_id",
    "title",
    "agent",
    "role",
    "pane_id",
    "status",
    "started_at",
    "ended_at",
)
_PIPELINE_PANE_FIELDS = (
    "pane_id",
    "agent",
    "role",
    "stage_id",
    "stage_index",
    "slot_label",
    "spawn_status",
    "kickoff_status",
)

#: A skill's `body` is the instructions themselves — the one field a listing
#: must leave behind. `fields` is the parsed frontmatter it was read from.
_SKILL_FIELDS = (
    "name",
    "description",
    "enabled",
    "targets",
    "managed",
    "valid",
    "native_conflict",
)
_NATIVE_SKILL_FIELDS = (
    "name",
    "description",
    "source",
    "owner_agent",
    "real_path",
    "valid",
)

#: The ui-settings key the Prompts settings page saves its skills under. It
#: must match PROMPT_SKILLS_SETTING_KEY in src/renderer/src/lib/promptSkills.ts
#: (line 12); the backend has no other knowledge of that page's data.
_PROMPT_SKILLS_SETTING_KEY = "prompt-skills"
#: A prompt skill's `prompt` and `resumePrompt` are the instructions themselves
#: — the fields a listing leaves behind; prompt_list(id=...) returns them.
_PROMPT_SKILL_FIELDS = (
    "id",
    "name",
    "icon",
    "description",
    "category",
    "enabled",
    "isDefault",
    "maxTurns",
)

#: How many of the caller's own messages one read may return.
_MESSAGE_LOG_MAX_LIMIT = 200
#: Rows read before the privacy filter runs. The log is one flat tail of
#: everybody's messages, so reaching `limit` of the caller's own means
#: over-reading; this is the store's own retention cap, so the over-read can
#: never grow into a full-table scan.
_MESSAGE_LOG_SCAN_ROWS = 500


def _pick(source: dict[str, Any], fields: tuple[str, ...]) -> dict[str, Any]:
    """The named keys of ``source``; a key that is not there is left out."""
    return {key: source[key] for key in fields if key in source}


@server.tool()
async def cli_usage(ctx: Context, agent: str = "") -> dict[str, Any]:
    """Read how much CLI quota each vendor has left, as Navide tracks it.

    Check it before handing work to another pane: cli_send queues a task for a
    CLI whose plan is exhausted just as happily as for one that can run it, and
    the message lands only for the other agent to fail on it. The same is worth
    doing before cli_open_agent picks which vendor to open. Read-only.

    The numbers are the vendors' own, reported unchanged — Navide neither
    recomputes them nor annotates them, so read the fields a vendor gives you
    rather than expecting one shape for all of them.

    agent narrows the answer to one vendor key ("claude", "codex", ...) — the
    same key cli_whoami reports as agent_key. Left empty, every tracked vendor
    comes back.

    Returns {ok, providers, accounts, enabled, intervalSec}, plus `agent` when
    a filter was applied. `providers` maps a vendor key to its current
    snapshot; `accounts` maps a vendor key to that vendor's per-account
    snapshots, keyed by account slot, for the vendors where Navide tracks more
    than one login. `enabled` false means quota polling is switched off, so
    whatever is here is only what was read last. A vendor with no entry at all
    is one Navide cannot read a quota for — which is not the same claim as a
    vendor with quota left. A snapshot with status "unverified" is not an
    error: no standard pane has verified that vendor's credential store yet,
    so nothing is read until the user opens one; its quota is unknown.
    """
    try:
        _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    from agent_team_backend.usage_service import service

    # The same call that serves the UI's usage badges, off the loop: it walks
    # every stale snapshot to re-check whether its reset window has passed.
    payload = await asyncio.to_thread(service.payload)
    providers = dict(payload.get("providers") or {})
    accounts = dict(payload.get("accounts") or {})
    agent = str(agent or "").strip().lower()
    result: dict[str, Any] = {"ok": True}
    if agent:
        result["agent"] = agent
        providers = {key: snap for key, snap in providers.items() if key == agent}
        accounts = {key: snap for key, snap in accounts.items() if key == agent}
    result["providers"] = providers
    result["accounts"] = accounts
    result["enabled"] = payload.get("enabled")
    result["intervalSec"] = payload.get("intervalSec")
    return result


def _recent_workspace_rows() -> dict[str, Any]:
    """Recent workspaces, each marked with whether a live pane sits in it.

    One thread's worth of work because both halves touch the disk: the store
    stats every recent path, and _norm_workspace resolves symlinks.
    """
    from agent_team_backend import app as _app

    live = {_norm_workspace(path) for path in _live_pane_workspaces()}
    workspaces = [
        {
            **entry,
            "has_live_panes": _norm_workspace(str(entry.get("path") or "")) in live,
        }
        for entry in _app.recent_workspaces_store.list()
    ]
    # Opened through workspace_open but never recorded in Recent: such a
    # window boots with duplicate=1, which (on purpose, for cloned windows)
    # keeps it out of Recent. Listed here instead, so the path a caller just
    # opened is one it can find again, without the MCP call reordering the
    # user's Recent list.
    listed = {_norm_workspace(str(entry.get("path") or "")) for entry in workspaces}
    for path, opened_at in reversed(list(_mcp_opened_workspaces.items())):
        norm = _norm_workspace(path)
        if norm in listed:
            continue
        listed.add(norm)
        workspaces.append(
            {
                "path": path,
                "name": Path(path).name or path,
                "last_opened_at": opened_at,
                "pinned": False,
                "exists": Path(path).is_dir(),
                "has_live_panes": norm in live,
                "opened_by_mcp": True,
            }
        )
    return {"workspaces": workspaces, "live_pane_workspaces": sorted(live)}


@server.tool()
async def workspace_list(ctx: Context) -> dict[str, Any]:
    """List the projects Navide knows about, so you can name one by path.

    Every tool that takes a workspace_path — plan_create, preview_record,
    cli_open_agent — wants the absolute path of a project root, and nothing
    told you which paths those are. This is that list: the workspaces the user
    has opened, most recently opened first. Read-only.

    Returns {workspaces, live_pane_workspaces}. Each workspace carries the
    store's own record (path, name, last_opened_at, pinned, exists) plus
    has_live_panes: true when a CLI pane is running in it right now. Prefer one
    of those — a workspace with has_live_panes false has no Navide window
    watching it, so a plan or a preview written there is not shown to the user
    at all. `exists` false is the harder failure: the folder is gone from disk.

    `live_pane_workspaces` is that live set on its own, resolved. A pane can be
    running in a project the user never opened from the welcome screen, which
    is a perfectly legal workspace_path that the recent list does not mention.

    Each workspace also carries window_ready: true when a Navide window holds
    it right now and would take a cli_open_agent for it — the readiness
    workspace_open reports, asked again. `window_ready_workspaces` lists those
    paths. Asking costs up to about a second.
    """
    _resolve_caller(ctx)
    rows = await asyncio.to_thread(_recent_workspace_rows)
    paths = [str(entry.get("path") or "") for entry in rows["workspaces"]]
    ready = await asyncio.gather(
        *(_probe_window(path, _WINDOW_PROBE_TIMEOUT_S) for path in paths)
    )
    for entry, is_ready in zip(rows["workspaces"], ready):
        entry["window_ready"] = is_ready
    rows["window_ready_workspaces"] = [path for path, is_ready in zip(paths, ready) if is_ready]
    return rows


@server.tool()
async def workspace_open(path: str, ctx: Context) -> dict[str, Any]:
    """Open `path` as a workspace in Navide.

    Whether that is a new window or an existing one that already has the
    project open is Navide's decision. `path` must be the absolute path of a
    project root — the kind `workspace_list` reports. This is the same as
    `ui_invoke` with action "ui.workspace.open", without having to look the
    action up first; like it, the request goes to any one live window (the
    workspace may not have a window yet), so it errors only when no Navide
    window is open at all.

    A leading "~" is expanded; the `path` returned is the expanded one.

    Returns {ok: true, path, ready} once the window has handled the request,
    or the error the window (or the routing) reported. A new window takes a
    moment to load, so this waits (up to about 15s) for the window holding
    `path` to answer: ready true means cli_open_agent(workspace_path=path)
    will be picked up now. ready false comes with a hint — the window may
    still be loading; workspace_list reports window_ready for it later. The
    workspace is in workspace_list as soon as this returns either way.
    """
    caller = _resolve_caller(ctx)
    if not path:
        return {"ok": False, "result": None, "error": "workspace_open requires path"}
    # Expanded here, once: the window keeps whatever string it is handed as its
    # workspace and never expands "~", so an unexpanded path would be held
    # under a key that the probe, workspace_list (Recent stores expanded paths)
    # and a later cli_open_agent with the absolute path all fail to match.
    # normpath too, only then: on Windows the expansion leaves the separators
    # mixed (C:\Users\me/Desktop/x), unlike the form Recent stores.
    if path.startswith("~"):
        path = os.path.normpath(os.path.expanduser(path))
    result = await _ui_request(
        "",
        "invoke",
        caller=caller,
        action="ui.workspace.open",
        args={"path": path},
        is_global=True,
    )
    if not result.get("ok"):
        return result
    # The window opens with duplicate=1 and so stays out of Recent; this is
    # what puts the path in workspace_list (see _recent_workspace_rows).
    _mcp_opened_workspaces.pop(path, None)
    _mcp_opened_workspaces[path] = datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )
    ready = await _wait_window_ready(path)
    reply: dict[str, Any] = {"ok": True, "path": path, "ready": ready}
    if not ready:
        reply["hint"] = (
            f"no Navide window answered for {path} within {_WINDOW_READY_TIMEOUT_S:.0f}s — "
            "it may still be loading. Check window_ready in workspace_list before "
            "cli_open_agent; do not open the workspace again"
        )
    return reply


@server.tool()
async def workspace_switch(path: str, ctx: Context) -> dict[str, Any]:
    """Switch the window you are in to another workspace it already holds.

    One Navide window can hold several projects (the sidebar lists them);
    this puts `path` on screen in YOUR window. Panes are not affected — the
    ones of the workspace being left keep running. `path` must be one the
    window already holds: otherwise the window refuses with an error that
    points at `workspace_open`, which is the tool for opening a project. The
    window also refuses while a pipeline is running in it (a switch would
    abort it, and the confirmation that asks is not yours to answer): call
    `pipeline_abort` first, or let the user switch from the sidebar.

    Only a CLI pane can call this, because "your window" is the window that
    hosts the calling pane. A host or external caller has no window of its
    own and gets ok: false — it can use `ui_invoke` with a workspace_path and
    action "ui.workspace.switch" instead.

    Returns {ok: true, path} with the workspace now on screen, or the error
    the window reported.
    """
    caller = _resolve_caller(ctx)
    if caller.kind != "pane":
        return {
            "ok": False,
            "result": None,
            "error": (
                "workspace_switch needs a pane caller; use ui_invoke with a "
                "workspace_path instead"
            ),
        }
    if not path:
        return {"ok": False, "result": None, "error": "workspace_switch requires path"}
    result = await _ui_request(
        _caller_workspace(caller),
        "invoke",
        caller=caller,
        action="ui.workspace.switch",
        args={"path": path},
    )
    if not result.get("ok"):
        return result
    switched = result.get("result") or {}
    return {"ok": True, "path": switched.get("path") if isinstance(switched, dict) else path}


def _pipeline_inventory() -> dict[str, Any]:
    """Pipelines with their stages, the active pipeline id, and the roles.

    All four reads in a single thread: they are four reads of the same stored
    document, and handing each one to the pool separately buys nothing.
    """
    from agent_team_backend import app as _app

    pipelines: list[dict[str, Any]] = []
    for pipeline in _app.stages_store.list_pipelines():
        stages: list[dict[str, Any]] = []
        for stage in _app.stages_store.list(pipeline["id"]):
            view = _pick(stage, _PIPELINE_STAGE_FIELDS)
            view["recommended_roles"] = list(stage.get("recommended_roles") or [])
            view["slots"] = [
                _pick(slot, _PIPELINE_SLOT_FIELDS) for slot in stage.get("slots") or []
            ]
            stages.append(view)
        pipelines.append({**pipeline, "stages": stages})
    return {
        "pipelines": pipelines,
        "active_pipeline_id": _app.stages_store.get_active_pipeline_id(),
        "roles": [_pick(role, _ROLE_FIELDS) for role in _app.roles_store.list()],
    }


@server.tool()
async def pipeline_list(ctx: Context) -> dict[str, Any]:
    """List Navide's pipeline templates and the roles their stages are cast from.

    A pipeline is a saved multi-stage run: an ordered set of stages, each with
    slots naming which CLI plays which role. The user starts one from the
    Pipelines window, and it is the shape a whole team of panes is built in —
    none of which was visible from here. Read it to describe what the user's
    Navide can run, or to see which stage a task belongs to before opening a
    pane for it yourself. Read-only: nothing here starts a run.

    Returns {pipelines, active_pipeline_id, roles}. Each pipeline is {id, name,
    builtin, stage_count, stages}; each stage is {id, title, short_title,
    description, sentinel, allow_questions, recommended_roles, slots}, and each
    slot {agent_key, role_key, label, is_commander}. `active_pipeline_id` is
    the template the Pipelines window currently has selected.

    Two things are deliberately not here, because both are whole prompts: a
    slot's kickoff body, and a role's system prompt. `roles` gives each role's
    {key, label, one_line, is_default} — enough to know what a role_key means.

    Templates only. Where a run has actually got to is pipeline_status.
    """
    _resolve_caller(ctx)
    return await asyncio.to_thread(_pipeline_inventory)


def _pipeline_status_of(workspace_path: str) -> dict[str, Any]:
    """Execution state of the project stored for ``workspace_path``.

    peek() never creates a project, so a workspace that has never run a
    pipeline answers with the empty state rather than an error — and rather
    than a file this call wrote on its way past.
    """
    from agent_team_backend import app as _app

    project = _app.project_store.peek(workspace_path)
    if project is None:
        return {"workspace_path": workspace_path, "active": False}
    # Through _project_payload, the same serialisation project.get serves the
    # renderer from, and then narrowed: the full payload is mostly persisted UI
    # state (themes, tab order, spawn history) that would bury the answer.
    stored = _app._project_payload(project)["project"]
    status: dict[str, Any] = {"workspace_path": workspace_path}
    status["active"] = stored.get("state") == "running"
    status.update(_pick(stored, _PROJECT_FIELDS))
    status["stages"] = [
        _pick(stage, _STAGE_RECORD_FIELDS) for stage in stored.get("stages") or []
    ]
    status["panes"] = [
        _pick(pane, _PIPELINE_PANE_FIELDS)
        for pane in stored.get("panes") or []
        if pane.get("origin") == "pipeline"
    ]
    # Per graph node (pipeline_graph op "get" names them): the run engine's
    # reported state, and the gate the run is paused on ({} when none).
    status["nodes"] = {
        node_id: _pick(state, _NODE_STATE_FIELDS)
        for node_id, state in (stored.get("node_states") or {}).items()
        if isinstance(state, dict)
    }
    status["gate"] = stored.get("node_gate") or {}
    return status


@server.tool()
async def pipeline_status(ctx: Context, workspace_path: str = "") -> dict[str, Any]:
    """Report where a workspace's pipeline run has got to, if it has one.

    Use it to find out whether you are part of something larger: a pane opened
    as a pipeline slot is told its task, not that it is stage three of five,
    and the stage after yours does not start until yours is recorded finished.
    Read it before deciding how much of a job is yours. Read-only.

    Returns {workspace_path, active, ...}. `active` is true only while a run is
    in progress. A workspace that has never run a pipeline answers with
    {workspace_path, active: false} and nothing else — that is the empty state,
    not an error.

    When a project exists it also carries: state (idle / running / completed /
    aborted), task_description (what the run was started for), pipeline_id
    (which template from pipeline_list), current_stage_index and total_stages,
    run_count, log_file_name, updated_at, plus `stages` — {stage_id, title,
    agent, role, pane_id, status, started_at, ended_at} each — and `panes`,
    the pipeline slots as {pane_id, agent, role, stage_id, stage_index,
    slot_label, spawn_status, kickoff_status}. Panes the user or an agent
    opened by hand are not pipeline slots and are left out; cli_list_targets is
    where every pane is listed.

    Per graph node it also carries `nodes` — {node_id: {status, startedAt,
    endedAt, tokens, paneId, attempts, pinned}}, status one of pending /
    running / done / awaiting / rejected / failed / skipped / aborted — and
    `gate`, the gate the run is paused on ({gateId, label, prompt, nextIndex},
    or {} when it is not paused). Node ids are the ones pipeline_graph op
    "get" returns; a pipeline without a stored graph uses n-<stage_id>-<slot
    index>. A paused gate is resolved with pipeline_gate.

    workspace_path defaults to your own pane's workspace; pass it only to ask
    about another project.
    """
    caller = _resolve_caller(ctx)
    workspace_path = await _plan_workspace(caller, workspace_path)
    return await asyncio.to_thread(_pipeline_status_of, workspace_path)


def _skills_inventory(agent_key: str) -> dict[str, Any]:
    """The skill library, narrowed to a summary, plus what ``agent_key`` gets.

    ``agent_key`` empty is a caller with no pane identity: it is nobody's
    delivery target, so the "mine" half is omitted rather than guessed at.
    """
    from agent_team_backend import app as _app
    from agent_team_backend.plugins.builtin.navide_skills.skills_tools import delivery_context, skill_id

    listing = _app.skills_store.list_skills()
    result: dict[str, Any] = {
        "skills": [
            {**_pick(skill, _SKILL_FIELDS), "id": skill_id(skill)}
            for skill in listing.get("skills") or []
        ],
        "native": [
            {**_pick(skill, _NATIVE_SKILL_FIELDS), "id": skill_id(skill, native=True)}
            for skill in listing.get("native") or []
        ],
        "root": listing.get("root", ""),
        "agents": listing.get("agents") or [],
        **delivery_context(listing.get("agents") or []),
    }
    if agent_key:
        result["delivered_to_me"] = {
            "agent_key": agent_key,
            "skills": _app.skills_store.targets_for(agent_key),
            "native_paths": _app.skills_store.native_targets_for(agent_key),
        }
        result["configured_for_me"] = {
            **result["delivered_to_me"],
            "materialized_in_current_session": None,
            "loaded_in_current_session": None,
            "activation": "new_session",
        }
    return result


@server.tool()
async def skills_list(ctx: Context) -> dict[str, Any]:
    """List known skills and configured delivery, not proof of CLI loading.

    A skill is a folder of instructions a CLI loads on demand. Navide keeps a
    shared library the user can deliver to any vendor, and also reflects the
    ones each CLI keeps in its own directory. Read this to find out what is
    available before writing an instruction yourself, or to tell the user which
    skill would cover what they are asking for. Read-only. Use skills_inspect
    with a listed id for instructions and a delivery revision; authorized
    changes use skills_set_delivery. Install through skills_prepare_install
    then skills_install after reviewing the preview; the user approves the
    install in Navide, and skills_install_status reports the outcome.

    Returns {skills, native, root, agents}. Each shared skill is {name,
    id, description, enabled, targets, managed, valid, native_conflict}: `targets`
    null means every vendor receives it, a list means only those vendors, and
    `enabled` false disables Navide's projected delivery; automatic shared-root
    discovery is unaffected. Each native entry is {name, description,
    source, owner_agent, real_path, valid} — a skill some CLI already owns.
    `agents` is every vendor with its delivery support (wired / planned /
    unsupported), so "not delivered" and "cannot be delivered" stay apart.

    `configured_for_me` contains the current routing decision for your vendor.
    `delivered_to_me` is its legacy alias: both describe configuration, not a
    spawn snapshot or proof the running CLI loaded it. Current-session
    materialization and loading are explicitly unknown; changes take effect in
    a new session. Both are absent without pane identity.
    Shared-root readers in `automatic_agents` discover original shared files
    regardless of Navide routing. `skills_sync_enabled` reports whether managed
    content and routing are eligible for the user's cross-device Skills sync.

    Names and descriptions only. A skill's instructions are read from its own
    folder when you use it, not from here.
    """
    caller = _resolve_caller(ctx)
    agent_key = ""
    if caller.kind == "pane":
        from agent_team_backend import agent_messaging

        me = agent_messaging.get(caller.pane_id)
        agent_key = me.agent_key if me else ""
    return await asyncio.to_thread(_skills_inventory, agent_key)


@server.tool()
async def cli_message_log(ctx: Context, limit: int = 50) -> dict[str, Any]:
    """Read your own message history — what you sent and what reached you.

    cli_inbox_summary reports only your sends that are stuck, and
    cli_pending_incoming only what has not been delivered yet. Neither answers
    "what did we already say to each other": once a message lands it leaves
    both of those, and after a compaction it is gone from your context too.
    This is the persisted log, so it survives a backend restart. Read-only —
    reading here never takes a message off anyone's queue.

    limit is how many of your own messages come back (1..200, newest last).

    Only your own messages are returned: a row is yours when you are its sender
    or its recipient, matched on your current messaging name. Everybody else's
    traffic is not readable from here, and a message queued for a name you have
    since been renamed away from stops matching as yours.

    Returns {ok, count, messages, scanned, truncated}. Each message is {uid,
    created_at (epoch milliseconds), status, sender, recipient, direction,
    excerpt} plus, when set, kind / reason / delivered_at / correlation_id /
    reply_to / remote / remote_workspace. `direction` is "sent" when you were
    the sender, "received" otherwise. `excerpt` is 200 characters with the
    whitespace flattened; cli_read_incoming is what returns a message in full.

    `truncated` true means older messages of yours were cut off — either by
    `limit`, or by the window of recent rows this scans. `scanned` is how many
    rows that window held.
    """
    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    if caller.kind != "pane":
        return {
            "ok": False,
            "error": (
                "only a Navide CLI pane has a message history — a host or "
                "external caller has no messaging name to have sent or "
                "received anything under."
            ),
        }
    from agent_team_backend import agent_messaging, app

    # _resolve_caller has just rejected a stale pane id, so this is set; the
    # guard is here for the type, not for a reachable state.
    me = agent_messaging.get(caller.pane_id)
    if me is None:
        return {"ok": False, "error": "this pane is no longer registered for messaging"}
    limit = max(1, min(int(limit), _MESSAGE_LOG_MAX_LIMIT))
    # Both forms: a message from another workspace was addressed to the
    # qualified name, one from this window to the bare one.
    mine = {me.name, me.qualified_name}
    rows = await asyncio.to_thread(app.agent_message_log.tail, _MESSAGE_LOG_SCAN_ROWS)
    messages: list[dict[str, Any]] = []
    for row in rows:
        sender = str(row.get("sender") or "")
        recipient = str(row.get("recipient") or "")
        if sender not in mine and recipient not in mine:
            continue
        excerpt = "".join(
            list(" ".join(str(row.get("content") or "").split()))[
                :_INCOMING_EXCERPT_CHARS
            ]
        )
        message: dict[str, Any] = {
            "uid": row.get("uid", ""),
            "created_at": row.get("created_at", 0),
            "status": row.get("status", ""),
            "sender": sender,
            "recipient": recipient,
            "direction": "sent" if sender in mine else "received",
            "excerpt": excerpt,
        }
        for key in (
            "kind",
            "reason",
            "delivered_at",
            "correlation_id",
            "reply_to",
            "remote",
            "remote_workspace",
        ):
            if row.get(key):
                message[key] = row[key]
        messages.append(message)
    truncated = len(messages) > limit or len(rows) >= _MESSAGE_LOG_SCAN_ROWS
    messages = messages[-limit:]
    return {
        "ok": True,
        "count": len(messages),
        "messages": messages,
        "scanned": len(rows),
        "truncated": truncated,
    }


# ── Second round: clearing the feed / tokens / instruction files / closing ──
# Four gaps the first round left. preview_record, preview_list and preview_show
# gave the record feed three verbs and no way to empty it; the token panel's
# numbers were readable only by the user looking at the panel; the instruction
# files every CLI loads were invisible to the agents loading them; and closing a
# pane was reachable only through ui_invoke, one rung past cli_interrupt with no
# tool of its own. Only preview_clear writes anything.

#: Archived runs a token snapshot hands back, newest last. The store already
#: caps its own list at 20; this trims further because each run carries three
#: breakdown maps and none of them answer "how much has this project spent".
_TOKEN_RUNS_LIMIT = 5
#: Per-run fields kept: the run's own aggregate, never the by_vendor /
#: by_stage / by_pane maps hanging off it.
_TOKEN_RUN_FIELDS = ("run_id", "task", "started_at", "ended_at", "totals")
#: Live per-session tallies returned, busiest first.
_TOKEN_SESSIONS_LIMIT = 10
#: Days of the global by_day history returned, oldest first. The map grows by
#: one key a day forever, so it is the one part of a snapshot with no bound.
_TOKEN_DAYS_LIMIT = 7


@server.tool()
async def preview_clear(
    ctx: Context, workspace_path: str = "", before: int = 0
) -> dict[str, Any]:
    """Empty this workspace's Preview record feed.

    The fourth verb: preview_record adds to the feed, preview_list reads it,
    preview_show pushes to it, and until now nothing could take anything off
    it. Use it when the feed is stale enough to mislead — a finished task's
    churn sitting above what the user is about to review.

    This deletes rows the user can see in the Preview panel and cannot be
    undone. Everything on the feed goes, not only your own records: the file
    watcher's and the user's are on it too, so prefer `before` over a full
    clear whenever the point is "drop what is already dealt with".

    before is a created_at timestamp from preview_list (epoch milliseconds):
    rows stamped BEFORE it go and everything at or after it stays, which is
    what makes clearing safe while other sessions are still recording. Left at
    0 the whole feed is cleared.

    Returns {workspace_path, removed, before}; `removed` is how many rows went,
    0 when the feed was already empty. A "warning" field means no live Navide
    pane uses workspace_path, so this cleared a feed the user is not watching.

    workspace_path defaults to your own pane's workspace; pass it only to clear
    another project's feed.
    """
    caller = _resolve_caller(ctx)
    workspace_path = await _plan_workspace(caller, workspace_path)
    cutoff = int(before) or None
    if cutoff is not None and cutoff < 0:
        raise FsError(
            f"before must be a created_at timestamp from preview_list, not {before!r}"
        )
    removed = await asyncio.to_thread(
        _preview_log().clear, workspace_path, before=cutoff
    )
    if removed:
        # Same event the preview.log_clear handler emits, for the same reason:
        # every window showing this workspace is drawing the rows that just
        # went, and nothing else tells it they are gone.
        from agent_team_backend import app as _app
        from agent_team_backend.ipc import make_event

        await _app.broadcast(
            make_event(
                "preview.log_cleared",
                {
                    "workspace_path": workspace_path,
                    "before": cutoff,
                    "removed": removed,
                },
            )
        )
    result: dict[str, Any] = {
        "workspace_path": workspace_path,
        "removed": removed,
        "before": cutoff or 0,
    }
    warning = await asyncio.to_thread(_workspace_mismatch_warning, workspace_path)
    if warning:
        result["warning"] = warning
    return result


def _token_stats_of(workspace_path: str) -> dict[str, Any]:
    """A token snapshot narrowed to what fits in an answer.

    The store's own snapshot carries twenty archived runs with three breakdown
    maps each, every live session, and one entry per day since the store was
    created. Handed back whole it would be larger than whatever question it was
    asked in aid of, so the aggregates come through intact and the lists are
    cut to their most recent or busiest few.
    """
    from agent_team_backend import app as _app

    snapshot = _app.tokens_store.snapshot(workspace_path)
    workspace = dict(snapshot.get("workspace") or {})
    runs = list(workspace.get("runs") or [])
    sessions = dict(workspace.get("live_by_session") or {})
    busiest = sorted(
        sessions.items(),
        key=lambda item: int(item[1].get("input", 0)) + int(item[1].get("output", 0)),
        reverse=True,
    )
    global_doc = dict(snapshot.get("global") or {})
    by_day = dict(global_doc.get("by_day") or {})
    recent_days = sorted(by_day)[-_TOKEN_DAYS_LIMIT:]
    return {
        "workspace_path": snapshot.get("workspace_path", ""),
        "current_run": workspace.get("current_run"),
        "cumulative": workspace.get("cumulative"),
        "runs": [_pick(run, _TOKEN_RUN_FIELDS) for run in runs[-_TOKEN_RUNS_LIMIT:]],
        "runs_truncated": len(runs) > _TOKEN_RUNS_LIMIT,
        "live_sessions": dict(busiest[:_TOKEN_SESSIONS_LIMIT]),
        "live_session_count": len(sessions),
        "all_time": global_doc.get("all_time"),
        "by_vendor": global_doc.get("by_vendor"),
        "by_day": {day: by_day[day] for day in recent_days},
    }


@server.tool()
async def cli_token_stats(ctx: Context, workspace_path: str = "") -> dict[str, Any]:
    """Read how many tokens this workspace has spent, as Navide counts them.

    The numbers behind the Token panel: what the current run has used, what the
    project has used across every run, and what every vendor has used all time.
    Read it when the user asks what a job has cost, or before starting
    something long enough that the answer matters. cli_usage is the other half
    — that is quota left with the vendor, this is spend recorded here.
    Read-only.

    Returns {workspace_path, current_run, cumulative, runs, runs_truncated,
    live_sessions, live_session_count, all_time, by_vendor, by_day}. The three
    aggregates come through whole: `cumulative` is this project's totals with
    by_vendor and by_stage breakdowns, `all_time` and `by_vendor` are every
    project's. `current_run` is null when no pipeline run is open. `runs` is the
    last few archived runs, aggregate only, with runs_truncated true when older
    ones were cut. `live_sessions` is the busiest CLI sessions running now
    ({input, output, calls} each, keyed by session), `live_session_count` how
    many there are in total, and `by_day` the last week of global usage.

    A count is what a vendor's own session log holds, so a vendor whose log
    Navide cannot read contributes nothing rather than a zero.

    workspace_path defaults to your own pane's workspace; pass it only to ask
    about another project.
    """
    caller = _resolve_caller(ctx)
    workspace_path = await _plan_workspace(caller, workspace_path)
    return await asyncio.to_thread(_token_stats_of, workspace_path)


def _memory_workspace_root(workspace_path: str) -> Path | None:
    """The workspace an instruction-file request is scoped to, or None.

    Deliberately NOT resolve_plan_root: the Memory settings page scopes its
    listing to the window's workspace verbatim, and a tool that walked up to
    the git root instead would report a different set of project-scoped files
    than the page the user checks it against. A path that is not a directory
    yields None, which limits the answer to user scope rather than failing it.
    """
    if not workspace_path:
        return None
    path = Path(workspace_path).expanduser()
    return path if path.is_dir() else None


def _memory_inventory(workspace_path: str, path: str) -> dict[str, Any]:
    """The instruction-file listing, or the text of one file from it."""
    from agent_team_backend import native_memory

    workspace = _memory_workspace_root(workspace_path)
    listing = [entry.as_dict() for entry in native_memory.scan(None, workspace)]
    if not path:
        return {
            "workspace_path": str(workspace) if workspace else "",
            "files": listing,
            "agents": native_memory.agent_targets(),
        }
    wanted = str(Path(path).expanduser())
    entry = next((row for row in listing if row.get("path") == wanted), None)
    if entry is None:
        # The security boundary, not a convenience check: without it any
        # absolute path would be readable through a tool whose whole promise is
        # "the instruction files". native_memory.read enforces the same list
        # again from its own table; both stay, because the two lists agreeing
        # is what this asserts rather than assumes.
        raise FsError(
            f"not a known instruction file: {path!r} — pass one of the paths "
            "memory_list returns when called with no path"
        )
    try:
        content = native_memory.read(wanted, None, workspace)
    except ValueError as err:
        raise FsError(str(err)) from err
    return {
        "workspace_path": str(workspace) if workspace else "",
        "file": entry,
        **content,
    }


@server.tool()
async def memory_list(
    ctx: Context, workspace_path: str = "", path: str = ""
) -> dict[str, Any]:
    """List the instruction files the CLIs here load, or read one of them.

    CLAUDE.md, AGENTS.md, GEMINI.md and the rest: the standing instructions a
    vendor reads at startup, in this project and in the user's home. Read them
    before writing something that has to live alongside them — a convention the
    project already states, or the reason another vendor behaves differently
    from you. Read-only: editing an instruction file is the user's decision,
    made in Settings, and there is no tool here for it.

    Called with no path this lists metadata only — {workspace_path, files,
    agents}. Each file is {scope (user / project), path, relative, readers (the
    vendor keys that load it), canonical, exists, size, modified, error}; a
    file that does not exist yet is still listed, because it names where a
    convention would go. `agents` is every vendor with how Navide finds its
    files (mapped / configured).

    Called with a path it returns that one file: {workspace_path, file, path,
    text, exists, modified}. The path must be one this listing reported —
    anything else is refused, so this is not a way to read arbitrary files.

    workspace_path defaults to your own pane's workspace; pass it only to ask
    about another project. Without one, only user-scope files are listed.
    """
    caller = _resolve_caller(ctx)
    chosen = workspace_path or _caller_workspace(caller)
    # One thread for the whole inventory: scan() stats every candidate in the
    # home and the workspace, and read() opens a file.
    return await asyncio.to_thread(_memory_inventory, chosen, str(path or "").strip())


def _managed_mcp_rows() -> list[dict[str, Any]]:
    """The servers Navide itself connects to, secrets masked.

    list_servers() is unmasked because the Settings page round-trips it; every
    row here goes through native_mcp.mask_server_row before it leaves.
    """
    from agent_team_backend import app as _app
    from agent_team_backend import native_mcp

    return [native_mcp.mask_server_row(row) for row in _app.mcp_settings_store.list_servers()]


def _native_mcp_inventory() -> dict[str, Any]:
    """What each CLI's own config declares — scan() masks as it reads."""
    from agent_team_backend import native_mcp

    return {
        "native": [entry.as_dict() for entry in native_mcp.scan()],
        "agents": native_mcp.agent_targets(),
    }


@server.tool()
async def mcp_list(ctx: Context) -> dict[str, Any]:
    """List the MCP servers configured here — Navide's own and each CLI's.

    Two sources, both the ones Settings → MCP shows. The servers Navide
    connects to as a client come with their live state; the servers each CLI
    keeps in its own config (`~/.claude.json`, `~/.codex/config.toml`, ...)
    are reflected as that file states them. Read it to learn what a server is
    called, whether it is up, and how many tools it exposes before telling the
    user a capability is missing. Read-only — adding, enabling or editing a
    server is the user's decision, made in Settings; there is no tool here for
    it.

    Returns {servers, native, agents}. Each managed server is {name, enabled,
    transport, command, args, env} or {name, enabled, transport, url, headers},
    plus `status` (disabled / connected / error / unknown) and `tool_count`.
    Each native entry is {name, agent, transport, path, command, args, url,
    env, headers, enabled, valid, error}. `agents` is every vendor with what
    Navide can do with its MCP (wired / planned / unsupported) and whether its
    own config is reflected here.

    Every credential-shaped value — env and header values, `--api-key=` style
    arguments, URL userinfo and secret query parameters — is already masked
    as `***` in both halves; names and hosts are kept so an entry stays
    recognisable. This is a global inventory: it does not vary by workspace.
    """
    from agent_team_backend import app as _app
    from agent_team_backend.mcp_settings import MCPSettingsError

    _resolve_caller(ctx)
    try:
        configured = await asyncio.to_thread(_managed_mcp_rows)
    except (MCPSettingsError, OSError) as err:
        return {"ok": False, "error": str(err)}
    live = await _app.mcp_manager.list_status()
    live_map = {entry["name"]: entry for entry in live}
    servers = []
    for row in configured:
        info = live_map.get(row["name"], {})
        if not row.get("enabled", True):
            status = "disabled"
        else:
            status = info.get("status", "unknown")
        # The tool list itself stays out: this is a summary, and a server with
        # dozens of tools would swamp the answer.
        servers.append({**row, "status": status, "tool_count": info.get("tool_count", 0)})
    reflected = await asyncio.to_thread(_native_mcp_inventory)
    return {"servers": servers, **reflected}


@server.tool()
async def cli_extensions_list(ctx: Context) -> dict[str, Any]:
    """List the CLI extensions each AI CLI installed for itself.

    These are the CLIs' own add-ons, not Navide plugins (see
    docs/en-US/glossary.md): Claude plugins and mods, Codex plugins and
    hooks, Copilot and Droid plugins, opencode and Kilo plugins, Pi
    extensions, Qwen extensions, and every CLI's hooks. The same inventory
    Settings → CLI Extensions shows. Read it before telling the user a CLI
    has, or lacks, an add-on. Read-only: installing, enabling or removing a
    CLI extension is the user's decision and there is no tool here for it.

    Returns {vendors, items}. `vendors` is every CLI with an extension system
    ({cli, label, supported, note, count}); `supported: false` means Navide
    cannot read where that CLI keeps them yet. Each item is {cli, id, name,
    version, kind (plugin / mod / extension / hook / package), type_label
    (the vendor's own name), scope, enabled, exec_tier (L1 text assets, L2
    subprocess such as hooks and MCP, L3 code inside the CLI's own process),
    capabilities, native_consent (what the CLI itself asks before running
    it), owner (navide when Navide installed it), evidence (inferred when
    capabilities were read off source text)}.

    Names and metadata only: no paths and no hook command lines, which can
    name scripts, hosts and tokens. A global inventory: it does not vary by
    workspace.
    """
    from agent_team_backend import cli_extensions

    _resolve_caller(ctx)
    inventory = await asyncio.to_thread(cli_extensions.scan)
    return inventory.public_dict()


async def _credentials_scan_result() -> dict[str, Any]:
    from agent_team_backend import credentials_scan

    try:
        return await credentials_scan.service().scan(force=False)
    except Exception as err:  # noqa: BLE001 - report, never log details
        _log.warning("credentials scan failed (%s)", type(err).__name__)
        return {"ok": False, "error": "credentials scan failed", "error_code": "internal-error"}


@server.tool()
async def credentials_list(ctx: Context) -> dict[str, Any]:
    """List this machine's credentials and keys by name and metadata only.

    What the user sees in Settings → Credentials & keys: git credential
    helpers, gh / glab accounts, SSH private keys, OS keyring item metadata,
    remotes whose URL carries userinfo, token-looking environment variable
    names, and plaintext credential files. Read it to tell the user which
    identity or key exists before suggesting a push or a fix.

    Values are never returned — no token, password, private key or
    passphrase, and no prefix, length or hash of one. The scan is read-only:
    it never writes git config, the keychain, ~/.ssh or a remote, and it
    runs no command that prints a secret. Results are cached for 60 seconds.

    Returns {ok, scanned_at, platform, keyring: {available, backend,
    reason?}, items: [{id, kind, label, detail}]}. Keyring items carry only
    their class and dates: no service, server or account (the lookup keys of
    a keychain query).
    """
    caller = _resolve_caller(ctx)
    _log.info("credentials_list called by %s", getattr(caller, "kind", "unknown"))
    result = await _credentials_scan_result()
    if not result.get("ok"):
        return result
    items = []
    for item in result["items"]:
        if item.get("kind") == "keychain-item":
            detail = {k: v for k, v in item.get("detail", {}).items()
                      if k not in {"service", "server", "account"}}
            item = {**item, "label": str(detail.get("class", "keychain-item")), "detail": detail}
        items.append(item)
    return {"ok": True, "scanned_at": result["scanned_at"], "platform": result["platform"],
            "keyring": result["keyring"], "items": items}


@server.tool()
async def credentials_findings(ctx: Context) -> dict[str, Any]:
    """Risk findings from the read-only credentials and keys scan.

    Each finding is {id, code, severity (high/medium/low), kind, location,
    params, links, actions, manual_fix, reminder}. `location` is already
    redacted (a URL token shows as removed, never as a value).
    `reminder.state` is active, snoozed or dismissed as the user set it in
    Navide. `manual_fix` true means no safe command exists and the user has
    to fix it by hand. `actions` are fix action names
    (remote-set-url, ssh-add-passphrase, chmod-600, gh-auth-switch,
    gh-login-keyring, glab-login-keyring, inspect-helper-config,
    inspect-url-rewrite, manual-fix); no shell command is returned here.
    Codes include url-token,
    ssh-no-passphrase-default-host, ssh-no-passphrase, ssh-key-unreferenced,
    ssh-key-mode, cli-token-plaintext, gh-active-account-only,
    helper-duplicate, helper-shadowed, env-token-in-shell-rc, env-token-set,
    plaintext-credential-file and keyring-unavailable.

    Values are never returned, and nothing here changes anything: report a
    finding to the user; fixing it (and snoozing or dismissing it) is the
    user's decision, made in Navide. Returns {ok, scanned_at, summary:
    {high, medium, low, active_reminders}, findings}.
    """
    caller = _resolve_caller(ctx)
    _log.info("credentials_findings called by %s", getattr(caller, "kind", "unknown"))
    result = await _credentials_scan_result()
    if not result.get("ok"):
        return result
    findings = [{k: v for k, v in finding.items() if k != "steps"} for finding in result["findings"]]
    return {"ok": True, "scanned_at": result["scanned_at"], "summary": result["summary"],
            "findings": findings}


def _prompt_skills_inventory(skill_id: str) -> dict[str, Any]:
    """The Prompts page's saved skills, as a summary or one of them in full."""
    from agent_team_backend import app as _app

    from agent_team_backend import prompt_skills

    settings = _app.ui_settings_store.get()
    raw = settings.get(_PROMPT_SKILLS_SETTING_KEY)
    rows = [row for row in raw if isinstance(row, dict)] if isinstance(raw, list) else []
    if _PROMPT_SKILLS_SETTING_KEY not in settings:
        rows = prompt_skills.builtin(settings)
    if skill_id:
        skill = next((row for row in rows if row.get("id") == skill_id), None)
        if skill is None:
            return {"ok": False, "error": f"no prompt skill with id {skill_id!r}"}
        return {"skill": skill}
    result: dict[str, Any] = {
        "skills": [_pick(row, _PROMPT_SKILL_FIELDS) for row in rows],
        "default_id": next((str(row.get("id", "")) for row in rows if row.get("isDefault")), ""),
    }
    if _PROMPT_SKILLS_SETTING_KEY not in settings:
        result["note"] = "no prompt skills saved yet; this is the builtin skill the app starts with"
    return result


@server.tool()
async def prompt_list(ctx: Context, id: str = "") -> dict[str, Any]:
    """List the prompt skills the user keeps in Settings → Prompts, or read one.

    A prompt skill is a saved instruction the user fires at a CLI pane from
    the app — a name, a description and the prompt text itself, optionally
    with a resume prompt and a turn limit. Read the list to find out what the
    user has already written before drafting an instruction of your own, or
    to tell them which saved prompt covers what they are asking. Read-only:
    creating or editing one is done in Settings.

    Called with no id this lists metadata only — {skills, default_id}. Each
    skill is {id, name, icon, description, category, enabled, isDefault,
    maxTurns}; `default_id` is the id of the skill marked default, or "" when
    none is. A `note` is added when the user has never saved any: the list is
    then the builtin skill the app starts with.

    Called with an id it returns that one skill in full — {skill}, carrying
    `prompt` and `resumePrompt` as well. An id the list does not contain
    answers {ok: false, error}.
    """
    _resolve_caller(ctx)
    return await asyncio.to_thread(_prompt_skills_inventory, str(id or "").strip())


# ── Closing another pane ─────────────────────────────────────────────────────
@server.tool()
async def cli_close_agent(target: str, ctx: Context, pane_id: str = "") -> dict[str, Any]:
    """Close a CLI pane: the other half of cli_open_agent.

    THIS ENDS THE OTHER AGENT'S WORK. The pane and its PTY go away, whatever
    turn was running dies with them, and anything queued for that pane is never
    delivered. It cannot be undone — a closed pane's session is gone, not
    parked. Check cli_get_status first and do not close a pane that is working;
    cli_interrupt is the softer rung (it presses the interrupt key and leaves
    the pane open), and cli_send is softer still (it waits for the turn to
    finish).

    Use it to clean up a pane you opened with cli_open_agent and no longer
    need. Panes the user opened are the user's; closing one takes their work
    away with no warning they will see first. To free a finished pane's memory
    but leave it for the user to check, use cli_reclaim_agent instead: the CLI
    process ends and the pane stays as a click-to-resume card.

    `target` uses the same addressing as cli_send and `pane_id` names one exact
    pane instead. Panes on this machine only: closing one is an action taken by
    the window that owns it and there is no relay for it, so a
    `<device>/<workspace>/<pane>` address fails with "close-local-only" — that
    is a limit of this tool, not a wrong address.

    Returns {ok, target, name, closed, advisories?}. `advisories` is what
    closing cost that nobody else would have reported: the pane was mid-turn,
    messages were queued for it, it had children that are now orphaned. They
    are gathered before the kill because none of it is knowable afterwards.
    `ok` false means nothing was closed — an unknown target, or the owning
    window did not answer.
    """
    from agent_team_backend import message_routing

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    me = caller.pane_id if caller.kind == "pane" else ""
    result, failure = _resolve_pane_target(caller, me, target, pane_id)
    if failure is not None:
        # Same reason cli_interrupt re-reads the address here: the local errors
        # would send the caller back to fix an address that is not the problem.
        if not (pane_id or "").strip():
            routed = message_routing.route(me, target)
            if routed.remote is not None:
                return {
                    "ok": False,
                    "error": (
                        f'cannot close "{target}": it names a pane on another '
                        f"device, and closing one is an action taken by the window "
                        f"that owns it — there is no relay for that at any link "
                        f"state. The address may be perfectly good; only panes on "
                        f"this machine can be closed from here. To end a remote "
                        f"pane's work, cli_send it a message asking it to stop."
                    ),
                    "error_code": "close-local-only",
                }
        return failure
    pane = result.pane
    if caller.kind == "pane" and pane.pane_id == caller.pane_id:
        # Closing yourself takes the PTY the answer would come back through, so
        # the caller could never read the result of its own call.
        return {
            "ok": False,
            "target": pane.qualified_name,
            "error": (
                "that is your own pane — closing it would take away the turn "
                "making this call, so you would never see the answer. Ask the "
                "user to close it instead."
            ),
            "error_code": "self-close",
        }

    reply = await _ui_request(
        pane.workspace_path,
        "invoke",
        caller=_pane_caller(pane.pane_id),
        action="ui.pane.close",
        args={"paneId": pane.pane_id},
    )
    if not reply.get("ok"):
        # The window is the only thing that can close a pane, so a window that
        # did not answer means nothing was closed.
        return {
            "ok": False,
            "target": pane.qualified_name,
            "error": str(reply.get("error") or "the window owning this pane did not answer"),
            "error_code": str(reply.get("error_code") or "ui_action_failed"),
        }
    payload = reply.get("result") or {}
    answer: dict[str, Any] = {
        "ok": True,
        "target": pane.qualified_name,
        "name": pane.name,
        "closed": True,
    }
    advisories = [str(a) for a in (payload.get("advisories") or [])]
    if advisories:
        answer["advisories"] = advisories
    return answer


# ── Reclaiming another pane ──────────────────────────────────────────────────
@server.tool()
async def cli_reclaim_agent(target: str, ctx: Context, pane_id: str = "") -> dict[str, Any]:
    """Reclaim a finished CLI pane: end its CLI process, keep the pane.

    The pane stays where it is as a click-to-resume card holding its
    conversation — the same "reclaim now" the status bar and Resource Manager
    offer (ui_invoke "ui.pane.reclaim"). Use it on a pane whose work is done
    and reported, to free its memory while leaving it for the user to check or
    resume. cli_close_agent is the permanent version: it removes the pane.

    The status bar's guards apply unchanged, so a pane that is busy or awaiting
    an answer, the one the user has focused, one with unsent input, one with
    queued messages or a running pipeline/loop, and one whose session cannot be
    resumed are refused rather than reclaimed.

    `target` uses the same addressing as cli_send and `pane_id` names one exact
    pane instead. Panes on this machine only: a `<device>/<workspace>/<pane>`
    address fails with "reclaim-local-only", and your own pane with
    "self-reclaim".

    Returns {ok, target, name, reclaimed}. A refused pane answers ok false,
    reclaimed false, `reason` (the guard's code, e.g. "focused", "not-idle")
    and `error` saying why, with error_code "reclaim-refused". A Navide window
    older than v0.2.16 cannot reclaim and answers error_code
    "reclaim-unsupported": the app needs updating — do not fall back to
    cli_close_agent, which ends the session instead of parking it.
    """
    from agent_team_backend import message_routing

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    me = caller.pane_id if caller.kind == "pane" else ""
    result, failure = _resolve_pane_target(caller, me, target, pane_id)
    if failure is not None:
        # Same re-read as cli_close_agent: a remote address is not a bad one.
        if not (pane_id or "").strip():
            routed = message_routing.route(me, target)
            if routed.remote is not None:
                return {
                    "ok": False,
                    "error": (
                        f'cannot reclaim "{target}": it names a pane on another '
                        f"device, and reclaiming one is an action taken by the "
                        f"window that owns it — there is no relay for that. Only "
                        f"panes on this machine can be reclaimed from here."
                    ),
                    "error_code": "reclaim-local-only",
                }
        return failure
    pane = result.pane
    if caller.kind == "pane" and pane.pane_id == caller.pane_id:
        return {
            "ok": False,
            "target": pane.qualified_name,
            "error": (
                "that is your own pane — reclaiming it would end the CLI making "
                "this call, so you would never see the answer."
            ),
            "error_code": "self-reclaim",
        }

    reply = await _ui_request(
        pane.workspace_path,
        "invoke",
        caller=_pane_caller(pane.pane_id),
        action="ui.pane.reclaim",
        args={"paneId": pane.pane_id},
    )
    if not reply.get("ok"):
        error = str(reply.get("error") or "the window owning this pane did not answer")
        # A window before v0.2.16 has no such command; its wording reads like
        # a typo when the real answer is the app's version.
        if "unknown command: ui.pane.reclaim" in error:
            return {
                "ok": False,
                "target": pane.qualified_name,
                "error": (
                    "the Navide window holding this pane is older than v0.2.16 "
                    "and cannot reclaim panes; update the app. Do not use "
                    "cli_close_agent instead — it ends the session for good."
                ),
                "error_code": "reclaim-unsupported",
            }
        return {
            "ok": False,
            "target": pane.qualified_name,
            "error": error,
            "error_code": str(reply.get("error_code") or "ui_action_failed"),
        }
    # The window answers for a batch; one pane was asked about, so its entry
    # is the answer.
    payload = reply.get("result") or {}
    answer: dict[str, Any] = {"target": pane.qualified_name, "name": pane.name}
    if pane.pane_id in (payload.get("reclaimed") or []):
        return {"ok": True, **answer, "reclaimed": True}
    refused = next(
        (r for r in (payload.get("refused") or []) if r.get("paneId") == pane.pane_id),
        {},
    )
    return {
        "ok": False,
        **answer,
        "reclaimed": False,
        "reason": str(refused.get("reason") or "unknown"),
        "error": str(refused.get("detail") or "the window did not reclaim this pane"),
        "error_code": "reclaim-refused",
    }


# ── Pipelines: starting and aborting a run ──────────────────────────────────
# pipeline_list and pipeline_status only read. These two act, and both go
# through the window rather than the backend's own project_store: the
# `pipeline.start` handler writes the run record, while the panes for each
# stage are spawned by the renderer (onPipelineStart → preSpawnStage →
# activateStage). Writing the record from here would leave a run that reads as
# started and did nothing at all.


@server.tool()
async def pipeline_start(
    ctx: Context,
    task: str = "",
    pipeline_id: str = "",
    workspace_path: str = "",
) -> dict[str, Any]:
    """Start a pipeline run: open the first stage's panes and hand them the task.

    THIS OPENS CLI PANES AND SPENDS THEIR QUOTA. A pipeline is a template of
    stages, and every slot of a stage is a fresh CLI process with its own
    context and its own bill; later stages open as the run advances. Read
    pipeline_list first for the templates this machine has and what each one is
    made of, and pipeline_status for whether a run is already in progress —
    starting one is not a step to take on a guess.

    `pipeline_id` is the template to run, as pipeline_list reports its id. Left
    empty, the workspace's currently selected pipeline runs; a workspace with
    none selected refuses rather than picking one for you. `task` is what the
    run is for — the text each stage's kickoff message is built from.

    Returns the window's own reply — {ok, result, error}. `result` carries
    {pipelineId, stages, workspacePath, state} for a run that actually started.
    ok false means nothing started: a run already going (abort it first), no
    pipeline to run, or a first stage whose panes all failed to spawn. The
    window reports the run's own state rather than the fact that the call
    returned, so "ok" here is not the "started but nothing happened" answer.

    workspace_path defaults to your own pane's workspace; pass it only to start
    a run in another project's window.
    """
    caller = _resolve_caller(ctx)
    workspace_path = await _plan_workspace(caller, workspace_path)
    args: dict[str, Any] = {"task": str(task or "")}
    pipeline_id = str(pipeline_id or "").strip()
    if pipeline_id:
        args["pipelineId"] = pipeline_id
    # Navide Guard: the run's panes are spawned and briefed by the window, so
    # the caller's taint travels with the run (guard.taint arm/adopt).
    from agent_team_backend.guard import taint as guard_taint

    detail = _inherited_taint(caller, "pipeline started")
    if detail:
        guard_taint.arm_pipeline_run(workspace_path, detail)
    result: dict[str, Any] = {}
    try:
        result = await _ui_request(
            workspace_path, "invoke", caller=caller, action="ui.pipeline.start", args=args
        )
    finally:
        if detail:
            # Adopted by the run if it started; a leftover arming must not
            # taint the next run someone starts at the computer.
            guard_taint.disarm_pipeline_run(workspace_path)
    return result


@server.tool()
async def pipeline_abort(ctx: Context, workspace_path: str = "") -> dict[str, Any]:
    """Stop the pipeline run in progress in a workspace.

    Abort is a pause, not a kill: the orchestration stops (no further stage is
    activated, no more routing between the panes), and the panes already open
    stay open with their work intact, so the user can resume the run from the
    banner the window then shows. Nothing is deleted.

    Returns the window's own reply — {ok, result, error}, `result` carrying
    {workspacePath, state}. ok false means nothing was aborted, the usual
    reason being that no run was in progress; pipeline_status says whether one
    is.

    workspace_path defaults to your own pane's workspace; pass it only to stop
    a run in another project's window.
    """
    caller = _resolve_caller(ctx)
    workspace_path = await _plan_workspace(caller, workspace_path)
    return await _ui_request(
        workspace_path, "invoke", caller=caller, action="ui.pipeline.abort", args={}
    )
# ── Pipelines: editing the definitions themselves ───────────────────────────
# pipeline_start / pipeline_abort go through the window, because the renderer
# owns a *run*. These three do not: pipelines, stages and roles are backend
# state (stages_store / roles_store), and the ws handlers that maintain them
# write the store and then broadcast so every open window redraws itself.
#
# So each op below emits exactly the events its ws.* twin emits. A tool that
# wrote the store and stayed quiet would leave the Pipelines window showing the
# definition it loaded at open time — the change is on disk, the screen never
# moves, and the user reports it as "it did nothing".

_PIPELINE_DEFINE_OPS = ("create", "rename", "delete", "set_active", "reset_builtin")
_STAGE_DEFINE_OPS = ("upsert", "delete", "reorder", "reset")
_ROLE_DEFINE_OPS = ("upsert", "rename", "delete", "reset")


def _bad_op(op: str, allowed: tuple[str, ...]) -> dict[str, Any]:
    """Refuse an op we do not know rather than falling through to a default.

    An op-dispatched tool that treats anything unrecognised as its most common
    op turns a typo into a silent write of the wrong kind, so the whole set is
    named back to the caller instead.
    """
    return {
        "ok": False,
        "error": f"unknown op {op!r}; expected one of: {', '.join(allowed)}",
        "error_code": "bad_op",
    }


def _missing_arg(op: str, names: str) -> dict[str, Any]:
    """Refuse before the store is touched, so a half-given op writes nothing."""
    return {
        "ok": False,
        "error": f"op {op!r} requires {names}",
        "error_code": "missing_argument",
    }


def _run_in_progress(what: str) -> dict[str, Any]:
    return {
        "ok": False,
        "error": (
            f"cannot {what} while a pipeline run is in progress in this "
            "workspace — pipeline_status shows the run, pipeline_abort stops it"
        ),
        "error_code": "pipeline_running",
    }


def _store_refused(exc: Exception) -> dict[str, Any]:
    """A store-level rejection (bad id, last-of-its-kind, no seed data)."""
    code = "not_found" if isinstance(exc, KeyError) else "invalid"
    message = exc.args[0] if isinstance(exc, KeyError) and exc.args else str(exc)
    return {"ok": False, "error": str(message), "error_code": code}


async def _definition_workspace(caller: _Caller, workspace_path: str) -> str:
    """The workspace whose run guards a definition edit, or "" for none.

    Unlike :func:`_plan_workspace` this never raises: the ws handlers treat a
    blank workspace_path as "no run to check", and a host or external caller
    with no pane of its own has exactly that. Passing one turns the guards on.
    """
    chosen = workspace_path or _caller_workspace(caller)
    if not chosen:
        return ""
    return await asyncio.to_thread(resolve_plan_root, chosen)


def _run_is_active(workspace_path: str) -> bool:
    """True while `workspace_path` has a pipeline run in the running state."""
    from agent_team_backend import app as _app

    if not workspace_path:
        return False
    project = _app.project_store.peek(workspace_path)
    return bool(project is not None and project.state == "running")


def _stage_edit_blocked(workspace_path: str, pipeline_id: str) -> bool:
    """The ws handlers' own guard, imported rather than restated.

    ws_handlers._stage_edit_hits_running_pipeline compares against the pipeline
    the run recorded, not against whichever one the request named — a
    distinction that was a bug fix, and one a second copy here would drift
    away from at the first change.
    """
    from agent_team_backend.ws_handlers import _stage_edit_hits_running_pipeline

    return _stage_edit_hits_running_pipeline(workspace_path, pipeline_id or None)


async def _publish_pipelines(reason: str) -> dict[str, Any]:
    """Broadcast pipelines.changed and hand the same snapshot to the caller.

    The pipeline summaries carry stage_count, which is why every stage edit
    republishes them too (ws_handlers._broadcast_pipeline_summaries): a stage
    edit that only says stages.changed leaves a stale "N stages" on screen.
    """
    from agent_team_backend import app as _app
    from agent_team_backend.ipc import make_event

    def _snapshot() -> dict[str, Any]:
        return {
            "pipelines": _app.stages_store.list_pipelines(),
            "active_pipeline_id": _app.stages_store.get_active_pipeline_id(),
        }

    snapshot = await asyncio.to_thread(_snapshot)
    await _app.broadcast(make_event("pipelines.changed", {**snapshot, "reason": reason}))
    return snapshot


async def _publish_stages(pipeline_id: str, reason: str) -> dict[str, Any]:
    """Broadcast stages.changed for one pipeline and return what was sent."""
    from agent_team_backend import app as _app
    from agent_team_backend.ipc import make_event

    def _snapshot() -> dict[str, Any]:
        return {
            "stages": _app.stages_store.list(pipeline_id or None),
            "pipeline_id": pipeline_id or _app.stages_store.get_active_pipeline_id(),
        }

    snapshot = await asyncio.to_thread(_snapshot)
    await _app.broadcast(make_event("stages.changed", {**snapshot, "reason": reason}))
    return snapshot


async def _publish_role_stage_changes(pipeline_ids: list[str], reason: str) -> None:
    """Republish the stages of every pipeline a role edit rewrote.

    Only role_key moved, so the stage counts are untouched and pipelines.changed
    would say nothing new — the same reasoning as
    ws_handlers._broadcast_stage_role_changes, whose events these match.
    """
    from agent_team_backend import app as _app
    from agent_team_backend.ipc import make_event

    if not pipeline_ids:
        return

    def _snapshot() -> list[tuple[str, list[dict[str, Any]]]]:
        return [(pid, _app.stages_store.list(pid)) for pid in pipeline_ids]

    for pipeline_id, stages in await asyncio.to_thread(_snapshot):
        await _app.broadcast(make_event("stages.changed", {
            "stages": stages,
            "pipeline_id": pipeline_id,
            "reason": reason,
        }))


@server.tool()
async def pipeline_define(
    ctx: Context,
    op: str,
    pipeline_id: str = "",
    name: str = "",
    workspace_path: str = "",
) -> dict[str, Any]:
    """Create, rename, delete or re-seed a pipeline TEMPLATE (not a run).

    A pipeline is the template pipeline_start runs: a named, ordered set of
    stages. This edits the template list itself; stage_define edits what is
    inside one, and role_define the roles its slots are cast from. Nothing here
    starts, stops or advances a run.

    `op` selects the operation and decides which other arguments are required:

    - "create"        — needs `name`. Adds an empty pipeline (no stages) and
                        returns it with its generated id. It is not made
                        active; use "set_active" for that, and stage_define
                        with op "upsert" to give it stages — a pipeline with no
                        stages cannot be run.
    - "rename"        — needs `pipeline_id` and `name`. Renames in place; ids
                        and stages are untouched.
    - "delete"        — needs `pipeline_id`. DESTRUCTIVE, see below.
    - "set_active"    — needs `pipeline_id`. Selects the template the Pipelines
                        window shows and that pipeline_start uses when called
                        with no pipeline_id of its own.
    - "reset_builtin" — needs `pipeline_id`, and only "default" or
                        "maintenance" have seed data. DESTRUCTIVE, see below.

    `workspace_path` names the project whose run the guards check; it defaults
    to your own pane's workspace, and a caller with no pane that passes nothing
    gets no guard at all. Pass it when editing on behalf of another project.

    What the destructive ops actually do to a run in progress:

    - "delete" and "set_active" are REFUSED outright while that workspace has
      a run in the running state (error_code "pipeline_running"). Abort the run
      first if you mean it.
    - "reset_builtin" replaces every stage of the pipeline with its seed set,
      and is refused while the run in progress is using that pipeline — a run
      records which pipeline it belongs to, and naming it explicitly does not
      get past the guard.
    - A deleted pipeline does not stop or rewind a run that was already
      started: the run keeps its own recorded pipeline_id and the panes it has
      already opened. What breaks is resuming it later, since the template it
      names is gone. The last remaining pipeline cannot be deleted at all.
    - Nothing here touches a run's recorded progress. Editing a template while
      an unrelated workspace runs a different one is fine.

    Returns {ok, op, pipelines, active_pipeline_id}, plus `pipeline` for the
    ops that produce one ("create", "rename", "reset_builtin"). ok false
    carries `error` and `error_code` — one of "bad_op", "missing_argument",
    "pipeline_running", "not_found", "invalid" — and nothing was written.
    """
    caller = _resolve_caller(ctx)
    op = str(op or "").strip()
    if op not in _PIPELINE_DEFINE_OPS:
        return _bad_op(op, _PIPELINE_DEFINE_OPS)
    pipeline_id = str(pipeline_id or "").strip()
    name = str(name or "").strip()
    if op != "create" and not pipeline_id:
        return _missing_arg(op, "pipeline_id")
    if op in ("create", "rename") and not name:
        return _missing_arg(op, "name")

    from agent_team_backend import app as _app

    workspace_path = await _definition_workspace(caller, workspace_path)
    if op in ("delete", "set_active"):
        if await asyncio.to_thread(_run_is_active, workspace_path):
            return _run_in_progress(
                "delete a pipeline" if op == "delete" else "switch pipeline"
            )
    elif op == "reset_builtin":
        if await asyncio.to_thread(_stage_edit_blocked, workspace_path, pipeline_id):
            return _run_in_progress("reset a pipeline's stages")

    try:
        if op == "create":
            pipeline = await asyncio.to_thread(_app.stages_store.create_pipeline, name)
        elif op == "rename":
            pipeline = await asyncio.to_thread(
                _app.stages_store.rename_pipeline, pipeline_id, name
            )
        elif op == "delete":
            await asyncio.to_thread(_app.stages_store.delete_pipeline, pipeline_id)
            pipeline = None
        elif op == "set_active":
            await asyncio.to_thread(_app.stages_store.set_active_pipeline, pipeline_id)
            pipeline = None
        else:
            pipeline = await asyncio.to_thread(
                _app.stages_store.reset_builtin, pipeline_id
            )
    except (KeyError, ValueError) as exc:
        return _store_refused(exc)

    answer: dict[str, Any] = {"ok": True, "op": op}
    answer.update(await _publish_pipelines(op))
    # reset_builtin replaced the stage list as well, so the stage view has to
    # be republished too — the ws handler broadcasts both for the same reason.
    if op == "reset_builtin":
        await _publish_stages(pipeline_id, "reset_builtin")
    if pipeline is not None:
        answer["pipeline"] = pipeline
    return answer


@server.tool()
async def stage_define(
    ctx: Context,
    op: str,
    pipeline_id: str = "",
    stage_id: str = "",
    stage: dict[str, Any] | None = None,
    ids: list[str] | None = None,
    workspace_path: str = "",
) -> dict[str, Any]:
    """Add, edit, remove, reorder or re-seed the STAGES inside one pipeline.

    A stage is one step of a pipeline and holds the slots that become panes:
    each slot names a CLI (agent_key) and a role (role_key) and carries the
    kickoff text that pane is started with. pipeline_list shows the current
    shape of every pipeline; this changes it.

    `op` selects the operation and decides which other arguments are required:

    - "upsert"  — needs `stage`, a full stage object. Matched by `stage["id"]`:
                  an existing id is merged over (fields you omit keep their old
                  values), a new one is appended at the end. The store requires
                  `id` (alphanumeric, hyphen, underscore and dot only) and a
                  non-empty `slots` list. A stage looks like
                  {id, title, short_title, question, description, sentinel,
                  recommended_roles, allow_questions, doc_query, slots}, and
                  each slot {agent_key, role_key, label, kickoff_body,
                  is_commander}. Read one out of pipeline_list first and edit
                  that shape rather than composing one blind — but note
                  pipeline_list deliberately omits kickoff_body, so an upsert
                  built from it alone would blank the kickoffs of the slots it
                  rewrites.
    - "delete"  — needs `stage_id`. Refused for the last remaining stage of a
                  pipeline.
    - "reorder" — needs `ids`, the stage ids in the order you want. Ids not
                  listed keep their relative order at the end, unknown ids and
                  duplicates are ignored. The order IS the run order.
    - "reset"   — takes no extra argument. DESTRUCTIVE, see below.

    `pipeline_id` picks which pipeline to edit; left empty it means the active
    one, which is what the Pipelines window has selected and not necessarily
    the one you were reading. Name it.

    `workspace_path` names the project whose run the guard checks; it defaults
    to your own pane's workspace.

    What this does to a run in progress: EVERY op here is refused while the
    workspace has a run using this pipeline (error_code "pipeline_running") —
    a run compares against the pipeline it recorded at start, so naming that
    pipeline explicitly does not slip past. That is the whole protection: a
    stage list edited mid-run would change the flow underneath the run. Runs in
    other workspaces, or on other pipelines, are unaffected — and an edit
    landing between two runs changes what the NEXT one does, silently, which is
    the case to warn the user about.

    "reset" throws away every stage of the pipeline and puts back the seed set:
    the built-in stages for "default" and "maintenance", and NOTHING AT ALL for
    a pipeline you created — a custom pipeline reset this way is left empty and
    unrunnable, and there is no undo. Read it out of pipeline_list first if you
    might want it back.

    A pipeline whose graph has gates, reject loops or cross-layer edges cannot
    be expressed as a stage list: "upsert", "delete" and "reorder" are refused
    for it (error_code "graph_nonlinear") — edit it with pipeline_graph. On a
    pipeline whose graph is still linear they work and the graph follows.

    Returns {ok, op, stages, pipeline_id, pipelines, active_pipeline_id}, plus
    `stage` for "upsert". ok false carries `error` and `error_code` — one of
    "bad_op", "missing_argument", "pipeline_running", "graph_nonlinear",
    "not_found", "invalid" — and nothing was written.
    """
    caller = _resolve_caller(ctx)
    op = str(op or "").strip()
    if op not in _STAGE_DEFINE_OPS:
        return _bad_op(op, _STAGE_DEFINE_OPS)
    pipeline_id = str(pipeline_id or "").strip()
    stage_id = str(stage_id or "").strip()
    if op == "upsert" and not isinstance(stage, dict):
        return _missing_arg(op, "stage (a stage object)")
    if op == "delete" and not stage_id:
        return _missing_arg(op, "stage_id")
    if op == "reorder" and not ids:
        return _missing_arg(op, "ids (the stage ids in the wanted order)")

    from agent_team_backend import app as _app

    workspace_path = await _definition_workspace(caller, workspace_path)
    if await asyncio.to_thread(_stage_edit_blocked, workspace_path, pipeline_id):
        return _run_in_progress(f"{op} stages")

    try:
        if op == "upsert":
            written = await asyncio.to_thread(
                _app.stages_store.upsert, dict(stage or {}), pipeline_id or None
            )
        elif op == "delete":
            await asyncio.to_thread(
                _app.stages_store.delete, stage_id, pipeline_id or None
            )
            written = None
        elif op == "reorder":
            await asyncio.to_thread(
                _app.stages_store.reorder, [str(i) for i in ids or []], pipeline_id or None
            )
            written = None
        else:
            await asyncio.to_thread(_app.stages_store.reset, pipeline_id or None)
            written = None
    except GraphNonLinearError as exc:
        return {"ok": False, "error": str(exc), "error_code": "graph_nonlinear"}
    except (KeyError, ValueError) as exc:
        return _store_refused(exc)

    answer: dict[str, Any] = {"ok": True, "op": op}
    answer.update(await _publish_stages(pipeline_id, op))
    # The pipeline summaries carry stage_count, so they go out too.
    answer.update(await _publish_pipelines(f"stage_{op}"))
    if written is not None:
        answer["stage"] = written
    return answer


@server.tool()
async def role_define(
    ctx: Context,
    op: str,
    key: str = "",
    new_key: str = "",
    label: str = "",
    one_line: str = "",
    system_prompt: str = "",
    properties: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Create, edit, rename, delete or re-seed the ROLES pipeline slots cast from.

    A role is a named system prompt: a stage slot names one by `role_key`, and
    the pane that slot opens is started with that role's prompt. Roles are
    global to the machine, not per pipeline and not per workspace, so an edit
    here reaches every pipeline that names the role. pipeline_list lists the
    roles that exist (key, label, one_line) but never their prompt bodies.

    `op` selects the operation and decides which other arguments are required:

    - "upsert" — needs `key`, `label` and `system_prompt`; `one_line` is the
                 short description shown next to the label. An existing key is
                 overwritten, a new one created. `key` must be lowercase
                 letters, digits, underscore or dash, 1-32 characters.
                 REPLACES the whole role: label and system_prompt you do not
                 pass are not kept, they are written blank — and blank is
                 refused, which is the only thing stopping a partial upsert
                 from erasing a prompt.
    - "rename" — needs `key` (the current one) and `new_key`. Renames in one
                 step and repoints every stage slot that named the old key, so
                 there is no intermediate state where slots point at nothing.
                 `label` / `one_line` / `system_prompt` are optional here: what
                 you omit is carried over from the existing role. Refused if
                 `key` does not exist, or if `new_key` is already taken —
                 merging two roles would silently drop one side's prompt.
    - "delete" — needs `key`. REFUSED while any stage slot still names the
                 role, and the refusal lists those slots in `usages` so you can
                 repoint them (stage_define op "upsert") or rename instead. A
                 slot pointing at a deleted role fails role injection and
                 leaves that stage's pane sitting at an empty prompt with
                 nothing on screen to say why — which is what the refusal is
                 for. The last remaining role cannot be deleted at all.
    - "reset"  — takes no extra argument. DESTRUCTIVE: throws away every role,
                 custom ones included, and puts back the built-in set. Slots
                 left naming a role the seed set does not have are then blanked
                 rather than left dangling, so pipelines survive but those
                 slots lose their role and must be re-cast. There is no undo.

    `properties` (optional, "upsert" and "rename") declares the settings form a
    slot of this role shows: a list of {name, type, label?, description?,
    default?, options?, required?, displayOptions?}, type one of string / text
    / template / number / boolean / options ("options" needs `options`, a list
    of {value, label?}), displayOptions {show?, hide?} mapping another
    property's name to the values that show or hide this one. Omitted, a
    role's existing properties are kept; [] clears them. A slot stores its
    values in `params`.

    Roles have no run guard: unlike stages, editing one is allowed while a
    pipeline runs. A pane already started keeps the prompt it was given — the
    change reaches the next pane opened for that slot, not the ones on screen.

    Returns {ok, op, roles}, plus `role` for "upsert" and "rename", and
    `repointed_pipeline_ids` for "rename". ok false carries `error` and
    `error_code` — one of "bad_op", "missing_argument", "not_found",
    "role_key_exists", "role_in_use", "invalid" — and nothing was written.
    """
    # Credential checked and then discarded: roles are global to the machine,
    # so unlike the other two there is no workspace for the caller to pick.
    _resolve_caller(ctx)
    op = str(op or "").strip()
    if op not in _ROLE_DEFINE_OPS:
        return _bad_op(op, _ROLE_DEFINE_OPS)
    key = str(key or "").strip()
    new_key = str(new_key or "").strip()
    if op != "reset" and not key:
        return _missing_arg(op, "key")
    if op == "upsert" and not label.strip():
        return _missing_arg(op, "label")
    if op == "upsert" and not system_prompt.strip():
        return _missing_arg(op, "system_prompt")
    if op == "rename" and not new_key:
        return _missing_arg(op, "new_key")

    from agent_team_backend import app as _app
    from agent_team_backend.ipc import make_event

    if op == "upsert":
        try:
            role = await asyncio.to_thread(
                lambda: _app.roles_store.upsert(
                    key=key,
                    label=label,
                    one_line=one_line,
                    system_prompt=system_prompt,
                    properties=properties,
                )
            )
        except (KeyError, ValueError) as exc:
            return _store_refused(exc)
        roles = await asyncio.to_thread(_app.roles_store.list)
        await _app.broadcast(make_event("roles.changed", {"roles": roles, "reason": "upsert"}))
        return {"ok": True, "op": op, "role": role, "roles": roles}

    if op == "rename":
        existing = await asyncio.to_thread(_app.roles_store.get, key)
        if existing is None:
            return {
                "ok": False,
                "error": f"no such role: {key!r}",
                "error_code": "not_found",
            }
        if new_key != key and await asyncio.to_thread(_app.roles_store.get, new_key):
            return {
                "ok": False,
                "error": f"role {new_key!r} already exists",
                "error_code": "role_key_exists",
            }

        # Carry the prompt across unless the caller deliberately replaced it:
        # roles_store.upsert refuses a blank label or system_prompt, so a
        # rename that passed the arguments through untouched would fail on
        # every role whose text the caller did not happen to resend.
        next_label = label.strip() or str(existing.get("label", ""))
        next_one_line = one_line.strip() or str(existing.get("one_line", ""))
        next_prompt = system_prompt.strip() or str(existing.get("system_prompt", ""))
        next_properties = properties if properties is not None else existing.get("properties")

        def _rename() -> tuple[dict[str, Any], list[str], list[dict[str, Any]]]:
            role = _app.roles_store.upsert(
                key=new_key,
                label=next_label,
                one_line=next_one_line,
                system_prompt=next_prompt,
                properties=next_properties,
            )
            # The stores' locks are taken one after the other, never nested —
            # the same ordering ws_handlers.roles_rename keeps.
            touched = _app.stages_store.repoint_role_references(key, new_key)
            if new_key != key:
                _app.roles_store.delete(key)
            return role, touched, _app.roles_store.list()

        try:
            role, touched, roles = await asyncio.to_thread(_rename)
        except (KeyError, ValueError) as exc:
            return _store_refused(exc)
        await _app.broadcast(make_event("roles.changed", {"roles": roles, "reason": "rename"}))
        await _publish_role_stage_changes(touched, "role_rename")
        return {
            "ok": True,
            "op": op,
            "role": role,
            "roles": roles,
            "repointed_pipeline_ids": touched,
        }

    if op == "delete":
        # Ask before stranding the slots that name it, exactly as roles.delete
        # does, and hand the caller the slots so it can offer to edit them.
        usages = await asyncio.to_thread(_app.stages_store.find_role_usages, key)
        if usages:
            return {
                "ok": False,
                "error": (
                    f"role {key!r} is still used by {len(usages)} pipeline stage "
                    "slot(s); repoint or rename them first"
                ),
                "error_code": "role_in_use",
                "usages": usages,
            }
        try:
            roles = await asyncio.to_thread(_app.roles_store.delete, key)
        except (KeyError, ValueError) as exc:
            return _store_refused(exc)
        await _app.broadcast(make_event("roles.changed", {"roles": roles, "reason": "delete"}))
        return {"ok": True, "op": op, "roles": roles}

    roles = await asyncio.to_thread(_app.roles_store.reset)
    await _app.broadcast(make_event("roles.changed", {"roles": roles, "reason": "reset"}))

    # Blank the slots left naming a role the seed set dropped; the surviving
    # keys are read first and handed to the stages store, so the two stores'
    # locks are taken one after the other (ws_handlers._clear_dangling_role_refs).
    def _clear_dangling() -> list[str]:
        valid = {str(r.get("key", "")) for r in _app.roles_store.list()}
        return _app.stages_store.clear_missing_role_references(valid)

    await _publish_role_stage_changes(await asyncio.to_thread(_clear_dangling), "roles_reset")
    return {"ok": True, "op": op, "roles": roles}


_PIPELINE_GRAPH_OPS = ("get", "apply", "set")


@server.tool()
async def pipeline_graph(
    ctx: Context,
    op: str,
    pipeline_id: str = "",
    ops: list[dict[str, Any]] | None = None,
    graph: dict[str, Any] | None = None,
    workspace_path: str = "",
) -> dict[str, Any]:
    """Read or edit a pipeline TEMPLATE as a graph: nodes, edges, gates, loops.

    A pipeline's shape is a graph — slot nodes (one CLI pane each, carrying the
    same agentKey / roleKey / label / kickoffBody / isCommander a stage slot
    has, plus optional `params`), gate nodes (the run pauses there until
    pipeline_gate passes or rejects it) and a trigger — joined by edges keyed
    by id. Its stages (what stage_define and pipeline_list show) are derived
    from it: each longest-path layer of slot nodes is one stage, run in order,
    so a node waits for every node upstream of it. A pipeline that has never
    been edited as a graph answers "get" with the graph its stages imply
    (derived: true) and is unchanged until you write one.

    `op`:
    - "get"   — returns {graph, derived, stages}.
    - "apply" — needs `ops`, a list applied all-or-nothing:
        {op:"add_node", node:{id, kind:"slot"|"gate"|"trigger", label?,
           position:{x,y}, slot?:{agentKey, roleKey, label, kickoffBody,
           isCommander?, params?}, gate?:{prompt?}}, after?:[ids], before?:[ids]}
           (after/before wire main edges; an edge after→before is replaced,
           i.e. inserting on an edge)
        {op:"remove_node", id, reconnect?:true}  (upstream rewired to downstream)
        {op:"update_node", id, label?, slot?:{...partial}, gate?:{prompt?}}
        {op:"move_node", id, position:{x,y}}
        {op:"add_edge", edge:{id?, from, to, kind?:"main"|"reject", maxLoops?}}
        {op:"remove_edge", id}
        {op:"set_gate", id, prompt?}
        {op:"set_pin", id, pinned}   (a pinned slot is skipped on later runs and
           its last output reused)
        {op:"set_stage_meta", stageId, title?, shortTitle?, question?,
           description?, sentinel?, allowQuestions?, docQuery?,
           recommendedRoles?}  (metadata of the stage a layer derives to)
    - "set"   — needs `graph` ({version:1, nodes, edges}); replaces it whole.

    Rules a write must satisfy: main edges form no cycle; the only loops are
    "reject" edges, which must point to an upstream node and carry maxLoops
    1..10 (default 2) — a rejected gate follows its reject edge back and re-runs
    from there at most that many times, then the run fails.

    Refused while the workspace's run is using this pipeline (error_code
    "pipeline_running"), like stage_define. `pipeline_id` empty means the
    active pipeline; name it. Returns {ok, op, pipeline_id, graph, stages}
    (+ derived for "get"); ok false carries `error`, `error_code` ("bad_op",
    "missing_argument", "pipeline_running", "not_found", "invalid") and, for
    an invalid graph, `errors` — nothing was written.
    """
    caller = _resolve_caller(ctx)
    op = str(op or "").strip()
    if op not in _PIPELINE_GRAPH_OPS:
        return _bad_op(op, _PIPELINE_GRAPH_OPS)
    pipeline_id = str(pipeline_id or "").strip()
    if op == "apply" and not isinstance(ops, list):
        return _missing_arg(op, "ops (a list of graph ops)")
    if op == "set" and not isinstance(graph, dict):
        return _missing_arg(op, "graph (an object with nodes and edges)")

    from agent_team_backend import app as _app
    from agent_team_backend.pipeline_graph import GraphError

    try:
        if op == "get":
            out = await asyncio.to_thread(_app.stages_store.get_graph, pipeline_id or None)
            return {"ok": True, "op": op, **out}
        workspace_path = await _definition_workspace(caller, workspace_path)
        if await asyncio.to_thread(_stage_edit_blocked, workspace_path, pipeline_id):
            return _run_in_progress("edit the pipeline graph")
        if op == "apply":
            out = await asyncio.to_thread(
                _app.stages_store.apply_graph_ops, pipeline_id or None, list(ops or [])
            )
        else:
            out = await asyncio.to_thread(_app.stages_store.set_graph, pipeline_id or None, graph)
    except GraphError as exc:
        return {"ok": False, "error": str(exc), "error_code": "invalid", "errors": exc.errors}
    except (KeyError, ValueError) as exc:
        return _store_refused(exc)
    # The same three events the pipelines.graph.* ws handlers send.
    from agent_team_backend.ws_handlers import _broadcast_graph_change

    await _broadcast_graph_change(out, f"graph_{op}")
    return {"ok": True, "op": op, **out}


# ── Pipelines: driving a run that is already going ──────────────────────────
# Same reason pipeline_start and pipeline_abort go through the window: the
# renderer owns the orchestration — it watches the panes, decides a stage is
# finished and spawns the next one. These four are the buttons the user has,
# addressed by MCP.


@server.tool()
async def pipeline_next(ctx: Context, workspace_path: str = "") -> dict[str, Any]:
    """Advance a running pipeline to its next stage now, without waiting.

    THIS OPENS CLI PANES AND SPENDS THEIR QUOTA. Normally the window decides a
    stage is finished by watching its panes; this says so on their behalf and
    activates the next stage immediately, spawning a pane for each of its
    slots. Work still in flight in the current stage is not waited for — its
    output simply does not reach the stage that follows.

    On the last stage there is nothing to advance to and this is REFUSED, not
    quietly turned into a completion: a caller that asked to step forward must
    not get a finished run back instead. Ending a run there is the window's own
    job, or pipeline_abort's. pipeline_status shows current_stage_index and
    total_stages, which is how to see that case coming before calling.

    Returns the window's own reply — {ok, result, error}. ok false means
    nothing advanced, the usual reason being that no run is in progress.

    workspace_path defaults to your own pane's workspace; pass it only to drive
    a run in another project's window.
    """
    caller = _resolve_caller(ctx)
    workspace_path = await _plan_workspace(caller, workspace_path)
    return await _ui_request(
        workspace_path, "invoke", caller=caller, action="ui.pipeline.next", args={}
    )


@server.tool()
async def pipeline_resume(ctx: Context, workspace_path: str = "") -> dict[str, Any]:
    """Carry on a pipeline run that was aborted or interrupted, from where it stopped.

    THIS OPENS CLI PANES AND SPENDS THEIR QUOTA. Resume is the other half of
    pipeline_abort: the recorded run is picked back up at the stage after the
    last finished one, and that stage's panes are spawned. Progress already
    made is kept — this is the non-destructive way back into a run, unlike
    pipeline_reset and pipeline_restart.

    The run is resumed against the pipeline it was started with, switching the
    active pipeline back if it has since changed; if that pipeline is gone or
    its stages no longer reach the recorded index, the resume stops and says so
    rather than running an unrelated stage against this run's task.

    Returns the window's own reply — {ok, result, error}. ok false means
    nothing resumed: no recorded run to resume, or one already running.
    pipeline_status shows whether a run exists and what state it is in.

    workspace_path defaults to your own pane's workspace; pass it only to
    resume a run in another project's window.
    """
    caller = _resolve_caller(ctx)
    workspace_path = await _plan_workspace(caller, workspace_path)
    return await _ui_request(
        workspace_path, "invoke", caller=caller, action="ui.pipeline.resume", args={}
    )


@server.tool()
async def pipeline_reset(ctx: Context, workspace_path: str = "") -> dict[str, Any]:
    """Clear the workspace back to idle: close EVERY pane and drop the run's progress.

    DESTRUCTIVE, AND WIDER THAN IT SOUNDS. Unlike pipeline_abort, which pauses
    the orchestration and leaves the panes alive to be resumed, reset tears
    down every pane in the workspace — the ones the pipeline opened AND the
    ones the user or another agent opened by hand — and returns the workspace
    to an idle, empty state with the run's task, stage index and log cleared.
    There is no resume afterwards and no undo.

    Read pipeline_status first: it says whether a run is in progress and how
    far it got, and cli_list_targets says which panes are about to be closed.
    If the intent is only to stop the run, pipeline_abort keeps the work.

    Returns the window's own reply — {ok, result, error}.

    workspace_path defaults to your own pane's workspace; pass it only to reset
    another project's window.
    """
    caller = _resolve_caller(ctx)
    workspace_path = await _plan_workspace(caller, workspace_path)
    return await _ui_request(
        workspace_path, "invoke", caller=caller, action="ui.pipeline.reset", args={}
    )


@server.tool()
async def pipeline_restart(ctx: Context, workspace_path: str = "") -> dict[str, Any]:
    """Throw the current run away and run the same pipeline again from stage one.

    DESTRUCTIVE, AND IT OPENS CLI PANES AND SPENDS THEIR QUOTA. Every pane the
    pipeline opened is closed, the progress recorded for the run is discarded,
    and the run starts over at the first stage with the same task — so the
    stages that had already finished are paid for and run a second time. There
    is no undo.

    Read pipeline_status first: a run three stages in is three stages of work
    to redo, and if the goal is only to move past a stuck stage then
    pipeline_next costs nothing already spent.

    Returns the window's own reply — {ok, result, error}. ok false means
    nothing restarted, the usual reason being that the workspace has no run to
    restart.

    workspace_path defaults to your own pane's workspace; pass it only to
    restart a run in another project's window.
    """
    caller = _resolve_caller(ctx)
    workspace_path = await _plan_workspace(caller, workspace_path)
    return await _ui_request(
        workspace_path, "invoke", caller=caller, action="ui.pipeline.restart", args={}
    )


_PIPELINE_GATE_OPS = ("pass", "reject")


@server.tool()
async def pipeline_gate(
    ctx: Context,
    op: str,
    node_id: str = "",
    comment: str = "",
    workspace_path: str = "",
) -> dict[str, Any]:
    """Pass or reject the gate a running pipeline is paused on.

    A gate node stops the run between two stages until someone decides.
    pipeline_status shows it in `gate` ({gateId, label, prompt, ...}) — read
    that prompt and look at the work before deciding.

    - "pass"   — the run carries on with the next stage. THIS OPENS CLI PANES
                 AND SPENDS THEIR QUOTA.
    - "reject" — the gate's reject edge is followed back and the stages from
                 its target on run again, with `comment` put in front of their
                 kickoffs so the agents know what to fix. Each reject edge has
                 a loop budget; once it is spent, or when the gate has no
                 reject edge, rejecting ends the run as failed.

    `node_id` is optional: given, it must be the gate the run is waiting on,
    which guards against deciding a different gate than the one you read.

    Returns the window's own reply — {ok, result, error}; ok false means no
    run is waiting on a gate (or on that one) and nothing changed.
    """
    caller = _resolve_caller(ctx)
    op = str(op or "").strip()
    if op not in _PIPELINE_GATE_OPS:
        return _bad_op(op, _PIPELINE_GATE_OPS)
    workspace_path = await _plan_workspace(caller, workspace_path)
    args: dict[str, Any] = {}
    if node_id:
        args["nodeId"] = str(node_id)
    if op == "reject" and comment:
        args["comment"] = str(comment)
    return await _ui_request(
        workspace_path, "invoke", caller=caller,
        action="ui.pipeline.gate_pass" if op == "pass" else "ui.pipeline.gate_reject",
        args=args,
    )


@server.tool()
async def pipeline_restart_from(
    ctx: Context,
    node_id: str,
    task: str = "",
    workspace_path: str = "",
) -> dict[str, Any]:
    """Start a new run of the pipeline at one node instead of stage one.

    THIS CLOSES THE PIPELINE'S PANES, OPENS NEW ONES AND SPENDS THEIR QUOTA.
    The stages before the node's stage are not run again: their last recorded
    output is reused as context (the same as a pinned node). Use it when an
    early stage's work is good and only a later one needs redoing — cheaper
    than pipeline_restart, which re-runs everything. Refused while a run is in
    progress (pipeline_abort first).

    `node_id` comes from pipeline_graph op "get" (or pipeline_status `nodes`).
    `task` defaults to the recorded run's task.

    Returns the window's own reply — {ok, result, error}.
    """
    caller = _resolve_caller(ctx)
    if not str(node_id or "").strip():
        return _missing_arg("restart_from", "node_id")
    workspace_path = await _plan_workspace(caller, workspace_path)
    args: dict[str, Any] = {"nodeId": str(node_id).strip()}
    if task:
        args["task"] = str(task)
    return await _ui_request(
        workspace_path, "invoke", caller=caller, action="ui.pipeline.restart_from", args=args
    )


# ── Scheduler: timed messages to a CLI pane ─────────────────────────────────
# The same SchedulerService the scheduler.* WS handlers drive, called directly
# rather than through a WS round trip; a job saved here is the job the Schedule
# panel shows. Every mutation broadcasts scheduler.changed, as the WS twins do,
# so an open panel redraws itself.


def _scheduler_service() -> Any:
    from agent_team_backend import scheduler

    return scheduler.get_service()


async def _announce_scheduler() -> None:
    from agent_team_backend import scheduler

    await scheduler.broadcast_changed()


def _scheduler_actor(caller: _Caller) -> dict[str, Any]:
    """Who an MCP caller acts as on a job. A caller with no pane identity (host
    or external) is one shared "external" agent."""
    from agent_team_backend import agent_messaging

    if caller.kind != "pane":
        return {"kind": "external"}
    me = agent_messaging.get(caller.pane_id)
    return {
        "kind": "pane",
        "pane_id": caller.pane_id,
        "pane_name": me.name if me is not None else "",
        "workspace": _caller_workspace(caller),
    }


_CROSS_WORKSPACE = "SCHEDULER_CROSS_WORKSPACE"


@server.tool()
async def scheduler_list(ctx: Context) -> dict[str, Any]:
    """List Navide's scheduled jobs. Returns {ok, jobs, now}.

    Every job is listed, including ones you may not change: `editable` says
    whether you may (you may change only jobs you created), `owner` says who
    created it ({kind: "user"}, {kind: "pane", pane_id, pane_name, workspace}
    or {kind: "external"}), and `owner_gone` is true when the creating pane is
    gone — such a job is the user's to change now. `limits` reports the agent
    limits (see scheduler_upsert, LIMITS) and how much of them is in use:
    yours_enabled, agent_enabled, agent_runs_today.

    Jobs fire only while Navide is running; nothing wakes the machine or the
    app. See scheduler_upsert for the shape of a job.
    """
    from agent_team_backend.scheduler import may_change

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    actor = _scheduler_actor(caller)
    result = await _scheduler_service().list()
    result["jobs"] = [{**job, "editable": may_change(actor, job)} for job in result["jobs"]]
    result["limits"]["yours_enabled"] = sum(
        1 for job in result["jobs"] if job["editable"] and job["enabled"]
    )
    return result


@server.tool()
async def scheduler_upsert(job: dict[str, Any], ctx: Context) -> dict[str, Any]:
    """Create a scheduled job, or update one (pass its `id`). Returns {ok, job}.

    A job wakes a CLI pane on a timetable and sends it an instruction. It fires
    ONLY WHILE NAVIDE IS RUNNING: a slot missed while the app was closed is run
    once on the next start (catch_up "once") or dropped (catch_up "skip").

    UNATTENDED RUNS SPEND QUOTA. Every run is a turn the target agent pays for,
    with nobody watching. Each job is capped at max_runs_per_day (default 24),
    a run whose target CLI is marked out of quota is skipped, and failures back
    off 30s → 1m → 5m → 15m → 60m. Pick the slowest schedule that does the job.

    Skips are not errors: "no_window" (no Navide window open), "busy" (this
    job's previous message is still queued at the pane), "budget" (daily cap or
    quota), "budget_global" (agent jobs' daily total), "expired" (see LIMITS),
    "target_gone" (pane_id no longer names a pane). A message to a pane
    that is mid-turn is queued by the normal delivery path and runs as "ok".

    Defaults for a pane caller: action.workspace is your own workspace, and an
    action with neither pane_id nor pane_name targets YOUR OWN pane — so
    "wake me up in an hour and continue" is a once job whose action is just
    `text`: {name, schedule: {kind: "once", in_ms: 3600000}, action: {kind:
    "message", text}}. Do not use "every" for a one-off wake-up — it repeats. A
    caller with no pane identity must pass workspace and a target.

    OWNERSHIP. A job you create is yours; you may update, remove, pause/resume
    or run_now only your own jobs — the user's and other agents' answer {ok:
    false, code: "SCHEDULER_NOT_OWNER"}; ask the user to change those. If your
    pane is closed, its jobs keep running but become the user's to change. A
    pane caller may only target panes in its own workspace (another workspace
    answers code "SCHEDULER_CROSS_WORKSPACE"); a caller with no pane identity
    has no own workspace and is not limited this way.

    LIMITS on agents' jobs (the user's own jobs have none): at most 10 enabled
    jobs of yours and 100 enabled agent jobs in all; every_ms at least 300000
    (5 minutes) and max_runs_per_day at most 288; 300 runs a day across all
    agent jobs (your run_now included) — past that a slot is skipped as
    "budget_global". A periodic job of yours disables itself 7 days after you
    last saved or enabled it (skip reason "expired"; the user can keep it), so
    save or re-enable it to keep it going. A finished once job of yours is
    deleted 30 days after it ran. A limit answers {ok: false, code:
    "SCHEDULER_LIMIT", limit, max, used, error}; `max` is the bound (the
    minimum, for "min_every_ms").

    A once job runs a single time, then disables itself whatever the outcome
    (ok, error or skipped); it stays listed with its state. Enabling it again
    after its moment has passed is refused — give it a new at_ms / in_ms.

    Invalid definitions answer {ok: false, error} and save nothing.

    Updating (with `id`) is partial: send only what changes — a field left out
    keeps its stored value, and `policy` merges key by key. A sent `action` is
    validated whole (it replaces the stored one; it is not merged). Creating
    (no `id`) needs name, schedule and action.

    A job is {id, name, enabled, created_at, updated_at, schedule, action, policy,
    state, owner, updated_by, owner_gone}; times are epoch milliseconds. owner
    and updated_by are recorded by Navide; anything sent there is ignored.

      schedule — one of:
        {kind: "every",  every_ms, anchor_ms?}   every N ms (60000 .. 7 days),
                                                 on a grid from anchor_ms (default: now)
        {kind: "daily",  at: "HH:MM", tz}        tz is an IANA zone, e.g. "Asia/Taipei"
        {kind: "weekly", days: [1..7], at, tz}   1 = Monday .. 7 = Sunday
        {kind: "once",   at_ms}                  one run at that moment (at most 1 min
                                                 in the past, at most 10 years ahead)
        {kind: "once",   in_ms}                  shorthand: saved as at_ms = now + in_ms
      action — {kind: "message", workspace, pane_id?, pane_name?, text}: wake that
        CLI pane (a closed-idle restore placeholder is opened first) and send
        `text`, exactly as cli_send(open_target=True) would. At least one of
        pane_id / pane_name. pane_id pins one exact pane (read it from
        cli_list_targets or cli_whoami); if that pane is gone the run is skipped as
        "target_gone" — it never falls back to another pane of the same name.
        A pane rebuilt by resuming the same session keeps its jobs: they move
        to the new pane id. Three "target_gone" runs in a row disable the job
        (state.disabled_reason "target_gone") and tell its creator once.
      policy — optional {catch_up: "once" | "skip", max_runs_per_day, timeout_s};
        defaults {"once", 24, 1800}.
      state — owned by Navide (next_run_at, running_at, last_status, last_error,
        consecutive_errors, backoff_until, ...); anything sent there is ignored.
    """
    from agent_team_backend import agent_messaging
    from agent_team_backend.scheduler import JobInvalid

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    if not isinstance(job, dict):
        return {"ok": False, "error": "job must be an object"}
    job = dict(job)
    action = job.get("action")
    if caller.kind == "pane" and isinstance(action, dict):
        action = dict(action)
        if not action.get("workspace"):
            action["workspace"] = _caller_workspace(caller)
        if not action.get("pane_id") and not action.get("pane_name"):
            me = agent_messaging.get(caller.pane_id)
            action["pane_id"] = caller.pane_id
            if me is not None:
                action["pane_name"] = me.name
        job["action"] = action
        own = agent_messaging._normalize_workspace(_caller_workspace(caller))
        target = agent_messaging._normalize_workspace(str(action.get("workspace") or ""))
        if target != own:
            return {
                "ok": False,
                "code": _CROSS_WORKSPACE,
                "error": f'a pane may only schedule panes in its own workspace ("{own}"), '
                f'not "{target}" — ask the user, or a pane in that workspace, to schedule it',
            }
    try:
        result = await _scheduler_service().upsert(job, _scheduler_actor(caller))
    except JobInvalid as err:
        return {"ok": False, "error": str(err)}
    if result.get("ok"):
        await _announce_scheduler()
    return result


@server.tool()
async def scheduler_remove(id: str, ctx: Context) -> dict[str, Any]:
    """Delete a scheduled job and its run history. Returns {ok} or {ok: false, error}.

    Only a job you created (see scheduler_upsert, OWNERSHIP).
    """
    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    result = await _scheduler_service().remove(str(id or ""), _scheduler_actor(caller))
    if result.get("ok"):
        await _announce_scheduler()
    return result


@server.tool()
async def scheduler_set_enabled(id: str, enabled: bool, ctx: Context) -> dict[str, Any]:
    """Pause (enabled=false) or resume a scheduled job. Returns {ok}.

    Resuming never fires a slot that passed while the job was paused; it waits
    for the next one. Resuming a once job whose moment has passed answers
    {ok: false, error} — set a new time with scheduler_upsert instead. Only a
    job you created (see scheduler_upsert, OWNERSHIP).
    """
    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    result = await _scheduler_service().set_enabled(
        str(id or ""), bool(enabled), _scheduler_actor(caller)
    )
    if result.get("ok"):
        await _announce_scheduler()
    return result


@server.tool()
async def scheduler_run_now(id: str, ctx: Context) -> dict[str, Any]:
    """Run a job once, right now, outside its timetable. Returns {ok, enqueued}.

    Answers as soon as the run has started, not when it ends — read
    scheduler_runs for the outcome. Refused while that job is already running.
    Clears a failure backoff; the error count resets only if this run succeeds.
    The run does not move the job's next scheduled slot. Only a job you created
    (see scheduler_upsert, OWNERSHIP).
    """
    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    return await _scheduler_service().run_now(str(id or ""), _scheduler_actor(caller))


@server.tool()
async def scheduler_runs(id: str, ctx: Context, limit: int = 20) -> dict[str, Any]:
    """A job's run history, newest first (up to 200 kept). Returns {ok, runs}.

    Each run is {id, job_id, started_at, ended_at, status: "ok" | "error" |
    "skipped", reason, detail}.
    """
    try:
        _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    return await _scheduler_service().runs(str(id or ""), limit)


@server.tool()
async def evolve_report(
    run_id: str,
    status: str,
    summary: str,
    ctx: Context,
    commits: list[dict[str, Any]] | None = None,
    proposals: list[dict[str, Any]] | None = None,
    panes: list[str] | None = None,
    tokens: int | None = None,
    run_token: str = "",
) -> dict[str, Any]:
    """Finish a Navide self-evolution run. Only for a pane Navide opened (or
    sent) a self-evolution task to: its task names the run_id.

    Call it exactly once, as the last step, with the run_id and run_token
    your task gave you — a report without the matching token is refused.
    `status` is "ok" or "error";
    `summary` 3–8 lines for the user (mask secrets first); `commits` is
    [{hash, title}] of fixes now on the main branch; `proposals` is
    [{rel_path, name}] of plans created; `panes` the names of panes you opened;
    `tokens` your estimate of tokens used. Navide records it in the workspace's
    self-evolution history and then reclaims the run's pane. Only the run's own
    pane, or a pane it opened, may report it. Returns {ok, run_id, status}.
    """
    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    if caller.kind != "pane":
        return {"ok": False, "error": "evolve_report must come from the run's own Navide pane"}
    from agent_team_backend import evolve_service

    return await evolve_service.get_service().report(caller.pane_id, {
        "run_id": run_id, "status": status, "summary": summary, "commits": commits,
        "proposals": proposals, "panes": panes, "tokens": tokens, "run_token": run_token,
    })


# ── The CLI permission switch ───────────────────────────────────────────────
# Global, not per project and not per pipeline: yolo feeds skipFlagFor() in the
# renderer, which every spawn / resume / restore path calls, and it persists in
# the user-level ui_settings under `agentTeam.yolo`. Which is why the renderer
# leaves ui.settings.yolo out of WORKSPACE_SCOPED_ACTIONS — a window answers it
# whatever project it happens to be showing, because there is no wrong project
# for a global setting to land in. workspace_path here only picks the window.


@server.tool()
async def cli_permission_settings(
    ctx: Context, yolo: bool | None = None, workspace_path: str = ""
) -> dict[str, Any]:
    """Read, or change, the global switch that lets CLIs skip their permission prompts.

    "Yolo" is Navide's name for the permission-bypass flag it passes a CLI at
    spawn (claude's --dangerously-skip-permissions and each vendor's
    equivalent). It is ONE setting for the whole app — not per workspace, not
    per pipeline, not per pane — stored with the user's settings and read by
    every path that starts a CLI: new panes, pipeline slots, resumes and
    restores alike.

    Called with no argument it only reads. Passing `yolo=false` turns it off,
    and the new value applies to CLIs started AFTER the change; processes
    already running keep the flags they were launched with, so turning it off
    does not reach back into a pane that is already going.

    `yolo=true` is REFUSED (ok false, error_code "ui_human_only"): with it on,
    the CLIs Navide starts stop asking before they edit files, run shell
    commands or make network calls in the user's workspace. Only the user can
    switch it on, in Settings. Ask them if your work needs it.

    Returns {ok, result, error}; `result` is {yolo, agents}. `yolo` is the
    global switch. `agents` is one entry per CLI vendor — {agent, mode,
    skipFlag} — and it is the half that actually answers "will this CLI skip
    its prompts":

    - `mode` is that vendor's own override and BEATS the global switch:
      "inherit" follows it, "force-on" and "force-off" ignore it. So `yolo`
      true on its own does not mean every CLI bypasses, and `yolo` false does
      not mean none does — reading only the switch will mislead you.
    - `skipFlag` is the flag that vendor would actually be launched with right
      now, and empty string means none. Vendors with no bypass flag at all
      (grok, opencode, pi) are always empty here whatever the switch says.

    Read `agents[].skipFlag` for the per-CLI answer; `yolo` is only the default
    the ones on "inherit" fall back to.

    `workspace_path` is ADDRESSING ONLY — it picks which window is asked, not
    what the change applies to. The setting is one global value whichever
    window reads or writes it, so every window gives the same answer and a
    write through any of them reaches all of them. It defaults to your own
    pane's window, and a caller with no pane that names nothing simply gets
    whichever window is open. There is no per-project version of this setting
    to reach by passing a different path.

    ok false with error_code "ui_no_window" means no Navide window was open to
    ask.
    """
    caller = _resolve_caller(ctx)
    # Read-only unless the caller actually passed a value: an args dict that
    # always carried the key would turn every read into a write of whatever
    # the default happened to serialise to.
    args: dict[str, Any] = {} if yolo is None else {"yolo": bool(yolo)}
    refusal = _human_only_refusal("ui.settings.yolo", args)
    if refusal is not None:
        return refusal
    # Soft resolve: unlike the pipeline tools this must not refuse a caller who
    # has no workspace, because the setting does not belong to one. With
    # nothing to address, is_global sends it to any one open window.
    window_path = await _definition_workspace(caller, workspace_path)
    return await _ui_request(
        window_path,
        "invoke",
        caller=caller,
        action="ui.settings.yolo",
        args=args,
        is_global=not window_path,
    )



# ── Resources: the same read-only surfaces, addressed by URI ────────────────
# An MCP client lists and reads resources on the user's behalf — attaching one
# to a conversation is something they do, not something an agent is talked
# into. So these three are strictly read-only, and each is a view of data a
# tool already serves rather than a second implementation of it.
#
# The credential is not injected here. A resource function that declares a
# Context parameter and NO uri parameter is registered by the SDK as a
# *template* (the decorator branches on "has any parameters", not on "has uri
# parameters"), and a template with no parameters never matches its own uri:
# its matcher hands back an empty parameter dict, which the resource manager
# reads as "no match" — the resource becomes unreadable, with "Unknown
# resource" as the only symptom. So a parameterless resource takes its context
# from :meth:`FastMCP.get_context` instead, which returns the very object the
# decorator would have injected; the templated one, which has a uri parameter,
# takes the injected Context. Both reach the same authenticated HTTP request,
# so `_resolve_caller` applies to a resource read exactly as it does to a tool
# call, and an unwired caller is refused the same way.


@server.resource(
    "navide://workspace/plans",
    name="workspace_plans",
    title="Plans in this workspace",
    description=(
        "Index of the plan documents in your workspace's .agent-team/plans/ "
        "directory — the same listing plan_list returns, as JSON."
    ),
    mime_type="application/json",
)
async def workspace_plans_resource() -> dict[str, Any]:
    """The workspace's plan index, for a client that reads resources."""
    from agent_team_backend.plugins.builtin.navide_plans import plan_tools

    ctx = server.get_context()
    caller = _resolve_caller(ctx)
    workspace_path = await _plan_workspace(caller, "")
    return {"workspace_path": workspace_path, "plans": await plan_tools.plan_list(ctx)}


@server.resource(
    "navide://workspace/plan/{rel_path}",
    name="workspace_plan",
    title="One plan document",
    description=(
        "One plan document from your workspace's .agent-team/plans/ directory: "
        "{rel_path, meta, html}. rel_path is the document's bare filename — a "
        "uri template matches one path segment, so the full "
        "'.agent-team/plans/<file>' form has to be percent-encoded."
    ),
    mime_type="application/json",
)
async def workspace_plan_resource(rel_path: str, ctx: Context) -> dict[str, Any]:
    """One plan document, read through plan_read's own path guard.

    ``rel_path`` arrives percent-encoded (a uri template segment cannot carry a
    raw "/"), and is decoded before it is resolved. Decoding is what makes the
    guard load-bearing rather than decorative: `%2E%2E%2F` is `../` by the time
    it reaches the filesystem, so this must not resolve the path itself —
    plan_read's ``_plan_target`` does, and refuses anything that leaves the
    plans subtree.
    """
    from agent_team_backend.plugins.builtin.navide_plans import plan_tools

    return await plan_tools.plan_read(unquote(str(rel_path or "")), ctx)


@server.resource(
    "navide://panes",
    name="panes",
    title="Addressable CLI panes",
    description=(
        "The CLI panes you can send instructions to — the same roster "
        "cli_list_targets returns, as JSON."
    ),
    mime_type="application/json",
)
async def panes_resource() -> dict[str, Any]:
    """The addressable-pane roster, for a client that reads resources."""
    return await cli_list_targets(server.get_context())


# ── Prompts: templates the USER fills in and sends ──────────────────────────
# A prompt is not documentation for the model — a client surfaces these to the
# person, usually as a slash command, and what comes back is inserted into
# their message. So each one renders a filled-in instruction that stands on its
# own when sent, not an explanation of how the tools work.


@server.prompt(
    title="Delegate a task to another pane",
    description="Hand a task to another Navide CLI pane and ask to be told when it lands.",
)
def delegate_to_pane(target: str, task: str) -> str:
    """Delegate `task` to the pane addressed by `target`, with a report back."""
    return (
        f"Send this task to the CLI pane `{target}` with cli_send, then stop and "
        f"wait for its reply rather than doing the work yourself.\n\n"
        f"Task for {target}:\n"
        f"{task}\n\n"
        f"Address it exactly as `{target}` — run cli_list_targets first if that "
        f"address is not in the roster, and ask me which pane I meant rather "
        f"than guessing at a similar name. In the message you send, tell "
        f"{target} to report back to you with cli_send when it is done: what it "
        f"changed, how it verified it, and anything it decided that I should "
        f"know about. Then tell me the message is away, and pass its report on "
        f"to me when it arrives."
    )


@server.prompt(
    title="Start a pipeline run",
    description="Run this workspace's pipeline against a task, after checking what it will open.",
)
def start_pipeline(task: str) -> str:
    """Start a pipeline run for `task`, with the pre-flight checks first."""
    return (
        f"Start a pipeline run in this workspace for the following task:\n\n"
        f"{task}\n\n"
        f"Before starting it: read pipeline_status to make sure no run is "
        f"already in progress, and pipeline_list to see which pipeline would "
        f"run and which stages it opens. Tell me what it is about to open — "
        f"this spends CLI quota — and wait for me to say go. Then call "
        f"pipeline_start with the task above, report whether the run actually "
        f"started, and if it did not, say what the window gave as the reason."
    )


@server.prompt(
    title="Review a plan document",
    description="Read a plan document, review it, and leave the findings on it as review notes.",
)
def review_plan(rel_path: str) -> str:
    """Review the plan at `rel_path` and record the findings on the document."""
    return (
        f"Review the plan document `{rel_path}`.\n\n"
        f"Read it with plan_read first. Then go through it as a reviewer: is "
        f"the goal stated clearly enough to tell whether it has been met, does "
        f"each phase have a verification that would actually fail if the work "
        f"were wrong, what is missing, and what would you do differently. Check "
        f"the claims against the code where the plan makes any.\n\n"
        f"Record each finding on the document itself with plan_add_note — one "
        f"note per finding, specific enough to act on — rather than only "
        f"telling me here. Then summarise for me what you left on it, and say "
        f"whether the plan is ready to approve as it stands."
    )


# ── ASGI mount + lifecycle ──────────────────────────────────────────────────

_session_manager: StreamableHTTPSessionManager | None = None
_lifecycle = AsyncExitStack()


class _PlanMcpASGI:
    """ASGI endpoint (class instance so Starlette's Route treats it as raw
    ASGI, not a request-response function); 503 until startup() has run."""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        manager = _session_manager
        if manager is None:
            response = PlainTextResponse("plan MCP server not started", status_code=503)
            await response(scope, receive, send)
            return
        await manager.handle_request(scope, receive, send)


asgi_app = _PlanMcpASGI()


async def startup() -> None:
    """Start a fresh streamable-HTTP session manager for the mounted endpoint.

    Stateless + JSON responses: every tool call is an independent POST, no
    server-side session table. A fresh manager per startup keeps app lifespan
    cycles (tests) restartable — the SDK's run() is once-only per instance.
    """
    global _session_manager
    manager = StreamableHTTPSessionManager(
        # Same low-level-server access the SDK's own in-memory test helper
        # (mcp.shared.memory) uses; FastMCP has no public accessor.
        app=server._mcp_server,  # noqa: SLF001
        json_response=True,
        stateless=True,
    )
    await _lifecycle.enter_async_context(manager.run())
    _session_manager = manager


async def shutdown() -> None:
    """Stop the session manager started by startup(). Idempotent."""
    global _session_manager
    _session_manager = None
    await _lifecycle.aclose()
