"""WebSocket message-handler registry (strangler-fig migration target).

Handlers are registered here and dispatched from ``app.handle_message`` before
the legacy ``if/elif msg_type`` chain. Each handler has the signature
``(session, msg_id, msg_type, payload) -> None`` and is a pure side-effect
coroutine: it responds via ``session.send_json`` and returns nothing.

Module-level imports must not import ``.app`` (that would be circular, since
``app`` imports this module). Handlers that need app-level module globals use a
function-level ``from . import app``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
import functools
import itertools
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Awaitable, Callable

from pydantic import ValidationError

from . import (
    agent_messaging,
    confirm_token,
    device_trust,
    executions_service,
    launch_id,
    native_mcp,
    native_memory,
    osplat,
    pane_policy,
    pipeline_liveness,
    quota_failover,
    remote_roster,
    server_link,
    storage_service,
    trust_store,
)
from .cli_vendors.codex import command_with_resume_id as codex_command_with_resume_id
from .cli_vendors.registry import VENDORS as CLI_VENDORS
from .cli_vendors.registry import vendor as cli_vendor
from .ipc import make_error, make_event, make_response
from .log_readers.claude import ClaudeLogReader, first_user_prompts
from .applog import app_data_dir, in_data_dir
from .credential_vault import DEFAULT_SLOT_ID, vault_to_thread
from .host_shell import parse_public_allowlisted_command, run_public_allowlisted_text
from .mcp_settings import (
    MCPSettingsConflictError,
    MCPSettingsError,
    restore_mcp_server_secrets,
    unfilled_mcp_secrets,
)
from .plan_index import resolve_plan_root
from .stages_store import GraphNonLinearError
from .plan_provisioning import SPEC_FILENAME, TEMPLATE_FILENAME, ensure_plan_assets
from .profiles_store import SUPPORTED_AGENT_KEYS as PROFILE_AGENT_KEYS
from .skills_events import notify_skills_changed
from .skills_store import (
    SkillConflictError,
    SkillConsentRequired,
    SkillNotFoundError,
    SkillValidationError,
    SkillsStoreError,
)
from .spawn_history import (
    canonical_workspace_path,
    filter_foreign_entries,
    MAX_ENTRIES as SPAWN_HISTORY_MAX_ENTRIES,
    read_pane_transcript,
    TRANSCRIPT_MAX_BYTES,
    TRANSCRIPT_CHUNK_CHARS,
)

if TYPE_CHECKING:
    from .app import Session
    from .projects import Project

Handler = Callable[["Session", str, str, dict], Awaitable[None]]

_REGISTRY: dict[str, Handler] = {}

# Diagnostics forwarded from the renderer (see the client.diagnostic handler).
# Its own logger so a reader can tell at a glance which half of the app a line
# came from, since the two halves now share one file.
client_log = logging.getLogger("agent_team_backend.client")
#: This module's own log, for decisions it makes rather than for what a
#: client said. Kept separate so a client cannot make its own noise look
#: like the backend's.
log = logging.getLogger(__name__)

# Dedicated pool for onboarding.status, whose dep probing (version subprocesses
# + config-home scans) can run for seconds. Keeping it off asyncio's shared
# default executor stops it from starving latency-sensitive requests such as
# workspace.list_recent, which fire concurrently on the same connect event.
# A single worker suffices: this pool only provides isolation — the actual
# dep fan-out happens inside get_status's own pool — so concurrent
# onboarding.status calls (multi-window connect) queue here rather than
# racing, which also avoids doubling up first-run state migrations.
_ONBOARDING_EXECUTOR = ThreadPoolExecutor(
    max_workers=1, thread_name_prefix="onboarding"
)

# Dedicated pool for the pre-spawn CLI work of terminal.create: the agent CLI
# probe (a subprocess with an 8s budget) and the login-shell PATH refresh (a
# subprocess with a 3s budget). Opening a dozen panes at once used to fill
# asyncio's shared default executor with these, starving every other
# to_thread in the backend — including the credential I/O that runs while an
# agent's switch_lock is held, so the lock was never released and the very
# spawns that filled the pool then deadlocked waiting for it.
# Workers: probes are subprocess-bound, not CPU-bound — the thread spends its
# budget waiting on a child process — so this pool is sized by the burst it
# must absorb, not by core count. Fresh spawns are not throttled frontend-side
# (only resumes are), so a fan-out arrives all at once. With an 8s probe budget
# against the frontend's 30s terminal.create timeout, each worker clears ~3
# panes before that deadline, so N workers absorb a ~3N burst. Eight covered
# the old 8-pane-per-workspace cap with room to spare; that cap is gone (see
# agentSpawnGate.ts — spawn quotas are advisory now), so a burst is bounded by
# what the user asks for rather than by a constant. Thirty-two keeps a ~96-pane
# fan-out inside the timeout, which is far past where per-CLI memory
# (~150-440MB each) becomes the real ceiling.
_CLI_PROBE_EXECUTOR = ThreadPoolExecutor(
    max_workers=32, thread_name_prefix="cli-probe"
)

# Ceiling on acquiring an agent's credential switch lock before a spawn: a
# legitimate account switch completes in well under a second, so this is purely
# a deadlock backstop the normal path never reaches. Kept just UNDER the
# frontend's 30s TERMINAL_CREATE_TIMEOUT_MS (resume-command.ts) on purpose —
# at 30s the client gives up first and reports a generic request timeout, and
# the named reason below (the whole point of the backstop) never arrives.
_SWITCH_LOCK_TIMEOUT_SEC = 25.0


def handler(*msg_types: str) -> Callable[[Handler], Handler]:
    """Register ``fn`` for one or more ``msg_type`` values.

    Duplicate registration for the same ``msg_type`` raises ``ValueError`` so
    that accidental collisions surface at import time rather than silently
    shadowing an earlier handler.
    """

    def decorate(fn: Handler) -> Handler:
        for mt in msg_types:
            if mt in _REGISTRY:
                raise ValueError(f"duplicate handler registration for msg_type {mt!r}")
            _REGISTRY[mt] = fn
        return fn

    return decorate


def lookup(msg_type: str) -> Handler | None:
    return _REGISTRY.get(msg_type)


# ── Editor AI (editor.*) ────────────────────────────────────────────────────
#: The Navide plugins whose Disabled switch the Host reports (sent only while
#: one is disabled).
_DISABLEABLE_BUILTIN_PLUGINS = frozenset({"navide.plans", "navide.git", "navide.mini-ide"})


def _valid_disabled_plugins(value: object) -> bool:
    return (
        isinstance(value, list)
        and len(value) <= len(_DISABLEABLE_BUILTIN_PLUGINS)
        and all(isinstance(item, str) and item in _DISABLEABLE_BUILTIN_PLUGINS for item in value)
    )


@handler("host.register")
async def host_register(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Authenticate Electron's private Host WebSocket session."""
    from . import app

    if (
        not isinstance(payload, dict)
        or set(payload) not in ({"token"}, {"token", "features"})
        or not app.host_session_token_matches(payload.get("token"))
        or (
            "features" in payload
            and (
                not isinstance(payload["features"], dict)
                or set(payload["features"]) - {"plans_backend_v2", "disabled_plugins"}
                or not isinstance(payload["features"].get("plans_backend_v2", False), bool)
                or not _valid_disabled_plugins(payload["features"].get("disabled_plugins", []))
            )
        )
    ):
        session.host_authenticated = False
        session.plans_backend_v2 = False
        session.disabled_plugins = frozenset()
        await session.send_json(
            make_error(msg_id, msg_type, "UNAUTHORIZED", "Host session authentication failed")
        )
        return
    session.host_authenticated = True
    features = payload.get("features", {})
    session.plans_backend_v2 = isinstance(features, dict) and features.get("plans_backend_v2") is True
    session.disabled_plugins = frozenset(features.get("disabled_plugins", []) if isinstance(features, dict) else [])
    app.note_host_disabled_plugins(session.disabled_plugins)
    await session.send_json(make_response(msg_id, msg_type, {"registered": True}))
    # A Host that connects again (its session dropped, this backend did not)
    # starts from idle: tell it the result helper's state when there is one.
    from .mcp_server.plugin_agent_tools import _result_worker
    from .plugins.agent_tools_contract import AGENT_TOOLS_RESULT_HELPER_EVENT

    if _result_worker.state != "idle":
        await session.send_json(make_event(AGENT_TOOLS_RESULT_HELPER_EVENT, _result_worker.snapshot()))


@handler("window.prove")
async def window_prove(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Answer this connection's `ws.welcome` challenge. Accepted once per
    connection: a right proof spends the challenge. A wrong one does not -- a
    proof meant for the previous socket can arrive on a fresh one during a
    reconnect, and must not lock that window out."""
    from . import app

    challenge = getattr(session, "window_challenge", "")
    proof = payload.get("proof") if isinstance(payload, dict) else None
    if not app.navide_window_proof_matches(challenge, proof):
        await session.send_json(
            make_error(msg_id, msg_type, "UNAUTHORIZED", "window proof refused")
        )
        return
    session.window_challenge = ""
    session.navide_window = True
    await session.send_json(make_response(msg_id, msg_type, {"proved": True}))


@handler("diagnostics.record")
async def diagnostics_record(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """A renderer warn/error diagnostic, kept in the on-disk error ledger so a
    reload does not wipe it (the window's own ring buffer still has it too)."""
    from . import error_ledger

    if (
        not isinstance(payload, dict)
        or payload.get("level") not in error_ledger.LEVELS
        or not isinstance(payload.get("code"), str) or not payload["code"]
        or not isinstance(payload.get("message"), str)
    ):
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "expected {level: warn|error, code, message}")
        )
        return
    pane_id = payload.get("paneId")
    workspace = payload.get("workspace")
    entry = await asyncio.to_thread(
        error_ledger.record, "renderer", payload["level"], payload["code"], payload["message"],
        pane_id=pane_id if isinstance(pane_id, str) else "",
        workspace=workspace if isinstance(workspace, str) else "",
    )
    await session.send_json(make_response(msg_id, msg_type, {"recorded": entry is not None}))


@handler("agent.capability.result")
async def agent_capability_result(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Return a Host-brokered agent capability response to the MCP waiter."""
    if not session.host_authenticated:
        await session.send_json(
            make_error(msg_id, msg_type, "UNAUTHORIZED", "Host session is not authenticated")
        )
        return
    from .mcp_server import server as plan_mcp

    if not isinstance(payload, dict) or set(payload) != {"request_id", "response"}:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "agent.capability.result is malformed")
        )
        return
    request_id = payload.get("request_id")
    response = payload.get("response")
    if not isinstance(request_id, str) or not request_id or not isinstance(response, dict):
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "agent.capability.result is malformed")
        )
        return
    delivered = plan_mcp.resolve_agent_capability(request_id, response)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "delivered": delivered}))


@handler("agent.capability.result_chunk")
async def agent_capability_result_chunk(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """One piece of a Host agent tool result (agent-tools contract 4.4, R2)."""
    if not session.host_authenticated:
        await session.send_json(
            make_error(msg_id, msg_type, "UNAUTHORIZED", "Host session is not authenticated")
        )
        return
    from .mcp_server import server as plan_mcp

    if not isinstance(payload, dict) or set(payload) != {"request_id", "seq", "data"} or not isinstance(
        payload.get("request_id"), str
    ):
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "agent.capability.result_chunk is malformed")
        )
        return
    accepted = plan_mcp.accept_agent_result_piece(payload["request_id"], payload["seq"], payload["data"])
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "accepted": accepted}))


@handler("agent.capability.progress")
async def agent_capability_progress(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """The Host says a pending agent tool call is alive (contract 4.4, Timing)."""
    if not session.host_authenticated:
        await session.send_json(
            make_error(msg_id, msg_type, "UNAUTHORIZED", "Host session is not authenticated")
        )
        return
    from .mcp_server import server as plan_mcp

    if (
        not isinstance(payload, dict)
        or set(payload) != {"request_id", "phase"}
        or not isinstance(payload.get("request_id"), str)
        or payload.get("phase") not in ("arguments", "execution", "result")
    ):
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "agent.capability.progress is malformed")
        )
        return
    accepted = plan_mcp.note_agent_capability_activity(payload["request_id"])
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "accepted": accepted}))


@handler("plugins.agentTools.sync")
async def plugins_agent_tools_sync(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """The Host's full catalog of third-party agent tools (contract 4.1).

    Only the authenticated Host session may send it. A snapshot replaces the
    previous one; one from a new Host session starts again from its revision.
    """
    if not session.host_authenticated:
        await session.send_json(
            make_error(msg_id, msg_type, "UNAUTHORIZED", "Host session is not authenticated")
        )
        return
    from .mcp_server import plugin_agent_tools

    result = plugin_agent_tools.apply_sync(payload, plugin_agent_tools.session_key(session))
    if not result["applied"] and result["error"] == "malformed snapshot":
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "plugins.agentTools.sync is malformed")
        )
        return
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("marketplace.query.result")
async def marketplace_query_result(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Return the Host's answer to a ``marketplace.query.request`` (plan B, B2-a)."""
    if not session.host_authenticated:
        await session.send_json(
            make_error(msg_id, msg_type, "UNAUTHORIZED", "Host session is not authenticated")
        )
        return
    from .mcp_server import server as plan_mcp

    request_id = payload.get("request_id") if isinstance(payload, dict) else None
    if not isinstance(request_id, str) or not request_id or not isinstance(payload.get("ok"), bool):
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "marketplace.query.result is malformed")
        )
        return
    response = {key: value for key, value in payload.items() if key != "request_id"}
    delivered = plan_mcp.resolve_marketplace_query(request_id, response)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "delivered": delivered}))


@handler("marketplace.developer.result")
async def marketplace_developer_result(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Return the Host's answer to a ``marketplace.developer.request`` (W3 status tools)."""
    if not session.host_authenticated:
        await session.send_json(
            make_error(msg_id, msg_type, "UNAUTHORIZED", "Host session is not authenticated")
        )
        return
    from .mcp_server import marketplace_forms

    request_id = payload.get("request_id") if isinstance(payload, dict) else None
    if not isinstance(request_id, str) or not request_id or not isinstance(payload.get("ok"), bool):
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "marketplace.developer.result is malformed")
        )
        return
    response = {key: value for key, value in payload.items() if key != "request_id"}
    delivered = marketplace_forms.resolve_developer_query(request_id, response)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "delivered": delivered}))


@handler("plugins.agent_action.result")
async def plugins_agent_action_result(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Return the Host's answer to a ``plugins.agent_action.request`` (plan B, B2-c)."""
    if not session.host_authenticated:
        await session.send_json(
            make_error(msg_id, msg_type, "UNAUTHORIZED", "Host session is not authenticated")
        )
        return
    from .mcp_server import server as plan_mcp

    request_id = payload.get("request_id") if isinstance(payload, dict) else None
    if not isinstance(request_id, str) or not request_id or not isinstance(payload.get("ok"), bool):
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "plugins.agent_action.result is malformed")
        )
        return
    response = {key: value for key, value in payload.items() if key != "request_id"}
    delivered = plan_mcp.resolve_plugin_agent_action(request_id, response)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "delivered": delivered}))


_ACTIVITY_ROW_REQUIRED = frozenset(("plugin_id", "plugin_version", "source", "address", "outcome"))
_ACTIVITY_ROW_FIELDS = _ACTIVITY_ROW_REQUIRED | {"workspace", "denied_reason", "fs_path", "shell_command", "at", "count"}
#: The Host records broker and shell-broker calls; agent tool calls are the
#: backend's own rows (B1).
_HOST_ACTIVITY_SOURCES = frozenset(("broker", "shell"))
#: Calls into a plugin's own backend, counted by the Host per batch.
_BACKEND_CALL_ROW_FIELDS = frozenset(("plugin_id", "plugin_version", "workspace", "source", "address", "outcome", "count"))
#: Card K4: the Host events a row may report, the Developer Mode switch and
#: (A2-5) its settings changed outside Navide. They are filed under the Host's
#: own event identity, which no plugin can hold.
_HOST_EVENT_PLUGIN_ID = "host"
_HOST_EVENT_ADDRESSES = frozenset(("developerMode.on", "developerMode.off", "developerMode.externalChange"))


def _host_event_row(app: Any, row: dict) -> str | None:
    """Record one Host event row; the skip reason when it is not recorded.

    Exact fields (``at`` optional, Unix ms), the Host's own identity, no
    workspace, a known address, ``allowed`` and a count of one.
    """
    if set(row) - {"at"} != _BACKEND_CALL_ROW_FIELDS:
        return "malformed"
    if (
        row["plugin_id"] != _HOST_EVENT_PLUGIN_ID
        or not isinstance(row["plugin_version"], str)
        or row["workspace"] != ""
        or row["address"] not in _HOST_EVENT_ADDRESSES
        or row["outcome"] != "allowed"
        or row["count"] != 1
        or isinstance(row["count"], bool)
    ):
        return "malformed"
    at = row.get("at")
    if "at" in row and (isinstance(at, bool) or not isinstance(at, int) or at < 0):
        return "bad at"
    recorded = app.plugin_audit_log.record_activity(
        plugin_id=_HOST_EVENT_PLUGIN_ID, plugin_version=row["plugin_version"], source="host",
        address=row["address"], outcome="allowed", at_ms=at,
    )
    return None if recorded else "refused"


def _backend_call_row(app: Any, row: dict) -> str | None:
    """Record one counted backend-call row; the skip reason when it is not recorded.

    Exact fields (``at`` optional: the minute the calls fell in, Unix ms), a
    ``backend.`` address and a positive count.
    """
    from .plugins import agent_tools_contract as contract

    if set(row) - {"at"} != _BACKEND_CALL_ROW_FIELDS:
        return "malformed"
    if not all(isinstance(row[key], str) for key in _BACKEND_CALL_ROW_FIELDS - {"count"}):
        return "malformed"
    if not row["address"].startswith(contract.PLUGIN_BACKEND_CALL_ADDRESS_PREFIX):
        return "malformed"
    at = row.get("at")
    if "at" in row and (isinstance(at, bool) or not isinstance(at, int) or at < 0):
        return "bad at"
    recorded = app.plugin_audit_log.record_backend_calls(
        plugin_id=row["plugin_id"], plugin_version=row["plugin_version"], workspace=row["workspace"],
        address=row["address"], outcome=row["outcome"], count=row["count"], at_ms=at,
    )
    return None if recorded else "refused"


@handler("plugin.activity.record")
async def plugin_activity_record(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Store the Host's batch of broker and shell-broker calls (plan B, D-e).

    Write-only: each row (calls the Host counted per key and minute, with
    ``count``) is redacted and counted by ``record_activity``; a row
    it refuses is skipped, and nothing here can fail the calls it records.
    Rows with source ``backend`` (calls into a plugin's own backend, counted)
    go to the per-minute counts instead. The ``backend.`` address prefix and
    the source must agree: a backend row with another address, or another row
    with a ``backend.`` address, is skipped. A ``host`` row (card K4: the
    Developer Mode switch) must be exactly the Host's own event shape.
    """
    from . import app

    if not session.host_authenticated:
        await session.send_json(
            make_error(msg_id, msg_type, "UNAUTHORIZED", "Host session is not authenticated")
        )
        return
    rows = payload.get("rows") if isinstance(payload, dict) and set(payload) == {"rows"} else None
    if not isinstance(rows, list):
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "plugin.activity.record is malformed")
        )
        return
    accepted = 0
    # Skipped rows are counted by reason and logged, never their content (#373 F3).
    skipped = {"malformed": 0, "bad at": 0, "refused": 0}
    for row in rows:
        if isinstance(row, dict) and row.get("source") == "backend":
            reason = _backend_call_row(app, row)
            if reason is None:
                accepted += 1
            else:
                skipped[reason] += 1
            continue
        if isinstance(row, dict) and row.get("source") == "host":
            reason = _host_event_row(app, row)
            if reason is None:
                accepted += 1
            else:
                skipped[reason] += 1
            continue
        if (
            not isinstance(row, dict)
            or not _ACTIVITY_ROW_REQUIRED <= set(row) <= _ACTIVITY_ROW_FIELDS
            or row.get("source") not in _HOST_ACTIVITY_SOURCES
            or (isinstance(row.get("address"), str) and row["address"].startswith("backend."))
        ):
            skipped["malformed"] += 1
            continue
        # `at`: when the call happened on the Host (Unix ms); record_activity
        # clamps it to now. Without it, the row is dated when it arrives.
        at = row.get("at")
        if "at" in row and (isinstance(at, bool) or not isinstance(at, int) or at < 0):
            skipped["bad at"] += 1
            continue
        # `count`: calls the Host counted under this key in that minute (1 when absent).
        count = row.get("count", 1)
        if isinstance(count, bool) or not isinstance(count, int) or count < 1:
            skipped["malformed"] += 1
            continue
        fields = {key: value for key, value in row.items() if key not in ("at", "count") and isinstance(value, str)}
        if len(fields) != len(row) - ("at" in row) - ("count" in row):
            skipped["malformed"] += 1
            continue
        if app.plugin_audit_log.record_activity(**fields, at_ms=at, count=count):
            accepted += 1
        else:
            skipped["refused"] += 1
    if accepted < len(rows):
        reasons = ", ".join(f"{reason}: {n}" for reason, n in skipped.items() if n)
        log.warning("plugin activity: %d of %d rows skipped (%s)", len(rows) - accepted, len(rows), reasons)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "accepted": accepted}))


_DECLARED_KINDS = frozenset(("system", "shell", "backendMethod", "agentTool"))


def _declared_items(value: Any) -> list[dict[str, str]] | None:
    """``declared`` of a report request: ``[{kind, key}]``, None when malformed."""
    if not isinstance(value, list):
        return None
    items = []
    for item in value:
        if (
            not isinstance(item, dict)
            or set(item) != {"kind", "key"}
            or item["kind"] not in _DECLARED_KINDS
            or not isinstance(item["key"], str)
        ):
            return None
        items.append({"kind": item["kind"], "key": item["key"]})
    return items


_RESOURCE_DECISION_FIELDS = frozenset(
    ("plugin_id", "plugin_version", "item", "usage", "threshold", "decision", "at")
)
_MAX_SAFE_INTEGER = 2**53 - 1


def _resource_decision_row(row: Any) -> dict[str, Any] | None:
    """A ``plugin.resource.decision`` row with exactly the contract's fields
    and types (``parsePluginResourceDecisionRow``'s rules), or None."""
    from .plugins import agent_tools_contract as contract

    if not isinstance(row, dict) or set(row) != _RESOURCE_DECISION_FIELDS:
        return None

    def number(value: Any) -> bool:
        return (
            not isinstance(value, bool) and isinstance(value, (int, float))
            and math.isfinite(value) and value >= 0
        )

    at = row["at"]
    if (
        not isinstance(row["plugin_id"], str) or not row["plugin_id"]
        or not isinstance(row["plugin_version"], str)
        or row["item"] not in contract.PLUGIN_RESOURCE_ITEMS
        or row["decision"] not in contract.PLUGIN_RESOURCE_DECISIONS
        or not number(row["usage"]) or not number(row["threshold"])
        or isinstance(at, bool) or not isinstance(at, int) or not 0 <= at <= _MAX_SAFE_INTEGER
    ):
        return None
    return dict(row)


@handler("plugin.resource.decision")
async def plugin_resource_decision(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Store the Host's watchdog notices and the user's decisions (contract 5.2).

    Write-only: rows are queued for the audit's batched flush. A row that is
    not exactly the contract's shape is skipped and only counted in the log.
    """
    from . import app

    if not session.host_authenticated:
        await session.send_json(
            make_error(msg_id, msg_type, "UNAUTHORIZED", "Host session is not authenticated")
        )
        return
    rows = payload.get("rows") if isinstance(payload, dict) and set(payload) == {"rows"} else None
    if not isinstance(rows, list):
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "plugin.resource.decision is malformed")
        )
        return
    accepted = 0
    for raw in rows:
        row = _resource_decision_row(raw)
        if row is not None and app.plugin_audit_log.record_resource_decision(**row):
            accepted += 1
    if accepted < len(rows):
        log.warning("plugin resource decision: %d of %d rows skipped", len(rows) - accepted, len(rows))
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "accepted": accepted}))


@handler("plugin.activity.forget")
async def plugin_activity_forget(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """A plugin was removed: forget its first-seen rows (Host-authenticated)."""
    from . import app

    if not session.host_authenticated:
        await session.send_json(
            make_error(msg_id, msg_type, "UNAUTHORIZED", "Host session is not authenticated")
        )
        return
    plugin_id = payload.get("plugin_id") if isinstance(payload, dict) else None
    if not isinstance(plugin_id, str) or not plugin_id or set(payload) != {"plugin_id"}:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "plugin.activity.forget is malformed")
        )
        return
    await asyncio.to_thread(app.plugin_audit_log.forget_plugin, plugin_id)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("plugins.activity.report")
async def plugins_activity_report(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """One plugin's ``PluginActivityReport`` for the activity page (contract 5.1, D-f).

    Host-authenticated: the main window asks the Host over IPC and the Host
    forwards, adding the ``declared`` items from the installed manifest.
    """
    from . import app

    if not session.host_authenticated:
        await session.send_json(
            make_error(msg_id, msg_type, "UNAUTHORIZED", "Host session is not authenticated")
        )
        return
    plugin_id = payload.get("plugin_id") if isinstance(payload, dict) else None
    declared = _declared_items(payload.get("declared", [])) if isinstance(payload, dict) else None
    # When the Host installed this package (Unix ms), optional (#373 F1).
    installed_at = payload.get("installedAt") if isinstance(payload, dict) else None
    if installed_at is not None and (isinstance(installed_at, bool) or not isinstance(installed_at, int) or installed_at < 0):
        declared = None
    if (
        not isinstance(plugin_id, str)
        or not plugin_id
        or not set(payload) <= {"plugin_id", "declared", "installedAt"}
        or declared is None
    ):
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "plugins.activity.report is malformed")
        )
        return
    report = await asyncio.to_thread(
        app.plugin_audit_log.activity_report, plugin_id, declared=declared, installed_at=installed_at
    )
    await session.send_json(make_response(msg_id, msg_type, report))


@handler("editor.rewrite")
async def editor_rewrite(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app
    from .ai_chat_cli_engine import run_cli_text

    await app._ensure_fresh_path_for_spawn("claude")
    _rew_code = payload.get("code", "") or ""
    _rew_instr = payload.get("instruction", "") or ""
    _rew_lang = payload.get("language", "") or ""
    _lang_hint = f" ({_rew_lang})" if _rew_lang else ""
    _prompt = (
        f"Rewrite the following code{_lang_hint} per this instruction: {_rew_instr}\n\n"
        f"```\n{_rew_code}\n```\n\nReturn ONLY the rewritten code, no explanation."
    )
    try:
        _text = await run_cli_text(
            _prompt,
            system_prompt="You are a code rewriting assistant. Output only code.",
        )
        # Strip markdown fences if model wrapped the code
        _text = re.sub(r'^```[a-zA-Z]*\n?', '', _text).strip()
        _text = re.sub(r'\n?```$', '', _text).strip()
        result = {"ok": True, "text": _text} if _text else {"ok": False, "error": "Empty response"}
    except Exception as _rew_exc:  # noqa: BLE001
        result = {"ok": False, "error": str(_rew_exc)}
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("editor.complete")
async def editor_complete(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    result = await app.editor_service.complete(
        app._az_base_url(),
        payload.get("model") or app.ANALYZER_DEFAULT_MODEL,
        payload.get("prefix", "") or "",
        payload.get("suffix", "") or "",
        payload.get("language", "") or "",
    )
    await session.send_json(make_response(msg_id, msg_type, result))


# ── Explorer filesystem (fs.*) ──────────────────────────────────────────────
# Read-only directory scans run in a worker thread: os.scandir/os.walk
# on a large repo or slow/network disk would otherwise block the event
# loop and stall every other in-flight request on the connection.
@handler("fs.list_dir")
async def fs_list_dir(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    mode = payload.get("mode", "display")
    if mode not in ("display", "discovery"):
        await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": "invalid list_dir mode"}))
        return

    ws_path = payload.get("workspace_path") or ""
    rel = payload.get("rel_path", "") or ""
    # Registering a watch resolves the path and schedules a recursive observer —
    # blocking syscalls that stall for minutes on a slow/network mount, so it
    # goes to a worker thread too. Awaited, not fired off: the watch must be in
    # place before the scan below reports the tree it is watching.
    await asyncio.to_thread(app._watch_plans_workspace, ws_path, rel)
    show_hidden = bool(payload.get("show_hidden", False))
    result = await asyncio.to_thread(app.fs_service.list_dir, ws_path, rel, show_hidden=show_hidden, mode=mode)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("fs.list_files_flat")
async def fs_list_files_flat(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    query = payload.get("query", "") or ""
    max_results = int(payload.get("max_results", 100))
    result = await asyncio.to_thread(
        app.fs_service.list_files_flat, ws_path, query=query, max_results=max_results
    )
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("fs.glob_files")
async def fs_glob_files(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    pattern = payload.get("pattern", "") or ""
    result = await asyncio.to_thread(app.fs_service.glob_files, ws_path, pattern=pattern)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("fs.mkdir")
async def fs_mkdir(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await asyncio.to_thread(app.fs_service.mkdir, ws_path, payload.get("rel_path", "") or "")
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("fs.create_file")
async def fs_create_file(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await asyncio.to_thread(
        app.fs_service.create_file,
        ws_path, payload.get("rel_path", "") or "", payload.get("content", "") or ""
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("fs.rename")
async def fs_rename(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await asyncio.to_thread(
        app.fs_service.rename,
        ws_path, payload.get("src_path", "") or "", payload.get("dst_path", "") or ""
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("fs.delete")
async def fs_delete(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    # to_thread: moving a large directory to the filesystem Trash may block.
    result = await asyncio.to_thread(app.fs_service.delete, ws_path, payload.get("rel_path", "") or "")
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("fs.write_file")
async def fs_write_file(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    await asyncio.to_thread(
        app._watch_plans_workspace, ws_path, payload.get("rel_path", "") or ""
    )
    expected_mtime = payload.get("expected_mtime")
    result = await asyncio.to_thread(
        app.fs_service.write_file,
        ws_path, payload.get("rel_path", "") or "", payload.get("content", "") or "",
        encoding=payload.get("encoding") or "utf-8",
        expected_mtime=float(expected_mtime) if expected_mtime is not None else None,
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("fs.write_part")
async def fs_write_part(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    result = await asyncio.to_thread(
        app.fs_service.write_part,
        payload.get("workspace_path") or "",
        payload.get("rel_path", "") or "",
        payload.get("upload_id"),
        payload.get("offset"),
        payload.get("data_base64"),
    )
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("fs.write_commit")
async def fs_write_commit(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    await asyncio.to_thread(
        app._watch_plans_workspace, ws_path, payload.get("rel_path", "") or ""
    )
    expected_mtime = payload.get("expected_mtime")
    result = await asyncio.to_thread(
        app.fs_service.write_commit,
        ws_path,
        payload.get("rel_path", "") or "",
        payload.get("upload_id"),
        payload.get("total_size"),
        float(expected_mtime) if expected_mtime is not None else None,
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("fs.write_abort")
async def fs_write_abort(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    result = await asyncio.to_thread(
        app.fs_service.write_abort,
        payload.get("workspace_path") or "",
        payload.get("rel_path", "") or "",
        payload.get("upload_id"),
    )
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("fs.read_file")
async def fs_read_file(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    await asyncio.to_thread(
        app._watch_plans_workspace, ws_path, payload.get("rel_path", "") or ""
    )
    enc_override = payload.get("encoding_override") or None
    rel_path = payload.get("rel_path", "") or ""
    # Plan documents open at any size; every other file keeps the editor limit.
    read_kwargs: dict = {"size_limit": None} if app.fs_service.is_plan_document(ws_path, rel_path) else {}
    result = await asyncio.to_thread(
        app.fs_service.read_file, ws_path, rel_path, encoding_override=enc_override, **read_kwargs
    )
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("fs.read_range")
async def fs_read_range(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    result = await asyncio.to_thread(
        app.fs_service.read_range,
        payload.get("workspace_path") or "",
        payload.get("rel_path", "") or "",
        payload.get("offset"),
        payload.get("length"),
    )
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("fs.stat_path")
async def fs_stat_path(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    result = await asyncio.to_thread(app.fs_service.stat_path, payload.get("path", "") or "")
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("fs.stat_workspace_path")
async def fs_stat_workspace_path(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    result = await asyncio.to_thread(
        app.fs_service.stat_workspace_path,
        payload.get("workspace_path") or "",
        payload.get("rel_path", "") or "",
    )
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("fs.page_capability")
async def fs_page_capability(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """The capability the renderer needs to build a /fs/page URL for one workspace.

    Answered over the socket, so only a client that already holds the ws token
    can obtain it; the capability itself is scoped to this workspace's URL
    segment and is what goes into the path instead of the token
    (ws_auth.page_capability explains why the token must not).
    """
    import base64

    from . import ws_auth

    ws_path = str(payload.get("workspace_path") or "")
    if not ws_path:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", "workspace_path is required"))
        return
    ws_b64 = base64.urlsafe_b64encode(ws_path.encode("utf-8")).decode("ascii").rstrip("=")
    cap = ws_auth.page_capability(ws_b64)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "ws_b64": ws_b64, "cap": cap}))


@handler("fs.read_image")
async def fs_read_image(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await asyncio.to_thread(app.fs_service.read_image, ws_path, payload.get("rel_path", "") or "")
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("fs.list_archive")
async def fs_list_archive(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await asyncio.to_thread(
        app.fs_service.list_archive, ws_path, payload.get("rel_path", "") or ""
    )
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("fs.convert_office")
async def fs_convert_office(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await asyncio.to_thread(
        app.fs_service.convert_office, ws_path, payload.get("rel_path", "") or ""
    )
    await session.send_json(make_response(msg_id, msg_type, result))


# ── Plan documents (plans.*) ────────────────────────────────────────────────
# One scan of every plan/report directory, carrying the meta the caller parsed
# last time whenever the file has not changed since. Replaces a per-directory
# fs.list_dir fan-out plus one fs.read_file per document on every refresh.
@handler("plans.ensure_assets")
async def plans_ensure_assets(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Provision the canonical Plans assets for a Host-owned create dispatch."""
    if not session.host_authenticated:
        await session.send_json(
            make_error(msg_id, msg_type, "UNAUTHORIZED", "Host session is not authenticated")
        )
        return
    if (
        not isinstance(payload, dict)
        or set(payload) != {"workspace_path"}
        or not isinstance(payload.get("workspace_path"), str)
        or not payload["workspace_path"]
    ):
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "Plans asset request is malformed")
        )
        return
    from . import app

    if app.plans_plugin_disabled():
        await session.send_json(
            make_error(msg_id, msg_type, "PLUGIN_TOOL_UNAVAILABLE", "Navide plugin Plans is disabled")
        )
        return
    workspace_path = payload["workspace_path"]
    root = await asyncio.to_thread(resolve_plan_root, workspace_path)
    await asyncio.to_thread(ensure_plan_assets, workspace_path)
    plans_dir = Path(root) / ".agent-team" / "plans"
    if not (
        (plans_dir / SPEC_FILENAME).is_file()
        and (plans_dir / TEMPLATE_FILENAME).is_file()
    ):
        await session.send_json(
            make_error(msg_id, msg_type, "BACKEND_UNAVAILABLE", "Plans assets could not be provisioned")
        )
        return
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "root": root}))


@handler("plans.list_docs")
async def plans_list_docs(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    if app.plans_plugin_disabled():
        await session.send_json(
            make_error(msg_id, msg_type, "PLUGIN_TOOL_UNAVAILABLE", "Navide plugin Plans is disabled")
        )
        return

    # Plans live in the project root (plan_provisioning writes the spec there,
    # and every writer resolves to it), so a workspace opened on a
    # subdirectory must look up to find them — otherwise a plan an agent just
    # created is invisible in the very window that asked for it. `root` goes
    # back with the list because rel_path is relative to it, and fs.read_file
    # refuses to escape the workspace it is given.
    ws_path = await asyncio.to_thread(
        resolve_plan_root, str(payload.get("workspace_path") or "")
    )
    await asyncio.to_thread(app._watch_plans_workspace_now, ws_path)
    result = await asyncio.to_thread(app.plan_index.list_docs, ws_path)
    if isinstance(result, dict) and result.get("ok"):
        result["root"] = ws_path
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("plans.resolve_root")
async def plans_resolve_root(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """The project root a workspace's plans live in — see plans.list_docs.

    For a surface that opens one plan without listing first (the plan window
    launched straight at a rel_path), which would otherwise resolve that path
    against a workspace the file is not under.
    """
    ws_path = await asyncio.to_thread(
        resolve_plan_root, str(payload.get("workspace_path") or "")
    )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "root": ws_path}))


@handler("plans.cache_put")
async def plans_cache_put(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    if app.plans_plugin_disabled():
        await session.send_json(
            make_error(msg_id, msg_type, "PLUGIN_TOOL_UNAVAILABLE", "Navide plugin Plans is disabled")
        )
        return

    # Same root as the scan that produced these entries, or the cache keys
    # would never match on the next list.
    ws_path = await asyncio.to_thread(
        resolve_plan_root, str(payload.get("workspace_path") or "")
    )
    result = await asyncio.to_thread(
        app.plan_index.cache_put, ws_path, payload.get("entries")
    )
    await session.send_json(make_response(msg_id, msg_type, result))


# ── Search (search.*) ───────────────────────────────────────────────────────
@handler("search.find_in_files")
async def search_find_in_files(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # A new search supersedes any in-flight one from this session:
    # cancel it so stale scans don't stack up server-side. (The
    # frontend's seq guard already discards the stale response.)
    if session._search_cancel is not None:
        session._search_cancel.set()
    cancel_event = threading.Event()
    session._search_cancel = cancel_event
    result = await asyncio.to_thread(
        app.search_service.find_in_files,
        payload.get("workspace_path") or "",
        payload.get("query", "") or "",
        is_regex=bool(payload.get("is_regex")),
        case_sensitive=bool(payload.get("case_sensitive")),
        whole_word=bool(payload.get("whole_word")),
        includes=payload.get("includes", "") or "",
        excludes=payload.get("excludes", "") or "",
        cancel_event=cancel_event,
    )
    if session._search_cancel is cancel_event:
        session._search_cancel = None
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("search.replace_in_files")
async def search_replace_in_files(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await asyncio.to_thread(
        app.search_service.replace_in_files,
        ws_path,
        payload.get("query", "") or "",
        payload.get("replacement", "") or "",
        payload.get("files", []) or [],
        is_regex=bool(payload.get("is_regex")),
        case_sensitive=bool(payload.get("case_sensitive")),
        whole_word=bool(payload.get("whole_word")),
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok") and result.get("total"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


# ── Git (git.*) ───────────────────────────────────────────────────────────────
@handler("git.init")
async def git_init(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    create_gi = bool(payload.get("create_gitignore", True))
    result = await app.git_service.init_repo(ws_path, create_gitignore=create_gi)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.status")
async def git_status(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    # The GitPane is now looking at this workspace — start (idempotently)
    # watching it on disk so external changes refresh near-instantly.
    if app._git_watcher is not None:
        await asyncio.to_thread(app._git_watcher.watch, ws_path)
    include_ignored = bool(payload.get("include_ignored", False))
    result = await app.git_service.get_status(ws_path, include_ignored=include_ignored)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.discover_repositories")
async def git_discover_repositories(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    max_depth = min(int(payload.get("max_depth", 3)), 8)
    limit = min(int(payload.get("limit", 20)), 100)
    force = bool(payload.get("force", False))
    result = await app.git_service.discover_repositories(
        ws_path, max_depth=max_depth, limit=limit, force=force
    )
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.log")
async def git_log(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    n = min(int(payload.get("n", 20)), 500)
    all_branches = bool(payload.get("all", False))
    query = payload.get("query") or None
    order = payload.get("order") or "ancestor"
    result = await app.git_service.coalesced(
        ("log", ws_path, n, all_branches, query, order),
        lambda: app.git_service.get_log(ws_path, n, all_branches, query, order),
    )
    await session.send_json(make_response(msg_id, msg_type, {"commits": result}))


@handler("git.stage")
async def git_stage(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    files = payload.get("files") or []
    result = await app.git_service.stage_files(ws_path, files)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.unstage")
async def git_unstage(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    files = payload.get("files") or []
    result = await app.git_service.unstage_files(ws_path, files)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.stage_all")
async def git_stage_all(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.stage_all(ws_path)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.check_staged")
async def git_check_staged(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.check_staged(ws_path)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.commit")
async def git_commit(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    message = payload.get("message") or ""
    commit_all = bool(payload.get("all"))
    result = await app.git_service.commit(ws_path, message, commit_all)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.sync")
async def git_sync(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.sync(
        ws_path,
        on_credential_request=app.build_credential_request_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
        on_credential_settled=app.build_credential_settled_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
        credential=app._git_credential(payload),
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.generate_message")
async def git_generate_message(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    ollama_url = app._az_base_url()
    attempt_count = int(payload.get("attempt_count") or 0)
    chat_settings = app.ai_chat_settings_store.get()
    model = payload.get("model") or chat_settings.get("model") or app.ANALYZER_DEFAULT_MODEL
    result = await app.git_service.generate_commit_message(ws_path, ollama_url, model, attempt_count, settings=chat_settings)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.discard")
async def git_discard(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    files = payload.get("files") or []
    result = await app.git_service.discard_changes(ws_path, files)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.fetch")
async def git_fetch(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.fetch(
        ws_path,
        on_credential_request=app.build_credential_request_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
        on_credential_settled=app.build_credential_settled_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
        credential=app._git_credential(payload),
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.pull")
async def git_pull(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.pull_only(
        ws_path,
        on_credential_request=app.build_credential_request_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
        on_credential_settled=app.build_credential_settled_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
        credential=app._git_credential(payload),
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.push")
async def git_push(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    remote = payload.get("remote") or ""
    branch = payload.get("branch") or ""
    result = await app.git_service.push_only(
        ws_path,
        remote,
        branch,
        on_credential_request=app.build_credential_request_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
        on_credential_settled=app.build_credential_settled_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
        credential=app._git_credential(payload),
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.credential_submit")
async def git_credential_submit(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    request_id = str(payload.get("request_id") or "")
    value = payload.get("value")
    ok = app.git_service.resolve_credential(request_id, str(value) if value is not None else None)
    await session.send_json(make_response(msg_id, msg_type, {"ok": ok}))


@handler("git.credential_cancel")
async def git_credential_cancel(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    request_id = str(payload.get("request_id") or "")
    ok = app.git_service.resolve_credential(request_id, None)
    await session.send_json(make_response(msg_id, msg_type, {"ok": ok}))


@handler("git.branches")
async def git_branches(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.coalesced(
        ("branches", ws_path), lambda: app.git_service.list_branches(ws_path)
    )
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.create_branch")
async def git_create_branch(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    name = payload.get("name") or ""
    switch_to = bool(payload.get("switch_to", True))
    start_point = payload.get("start_point") or ""
    result = await app.git_service.create_branch(
        ws_path, name, switch_to=switch_to, start_point=start_point
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.switch_branch")
async def git_switch_branch(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    name = payload.get("name") or ""
    result = await app.git_service.switch_branch(ws_path, name)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.checkout_commit")
async def git_checkout_commit(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    commit_hash = payload.get("commit_hash") or ""
    result = await app.git_service.checkout_commit(ws_path, commit_hash)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.reset")
async def git_reset(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    commit_hash = payload.get("commit") or ""
    mode = payload.get("mode") or ""
    result = await app.git_service.reset_to_commit(ws_path, commit_hash, mode)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.checkout_remote_branch")
async def git_checkout_remote_branch(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    remote_ref = payload.get("remote_ref") or ""
    result = await app.git_service.checkout_remote_branch(ws_path, remote_ref)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.delete_branch")
async def git_delete_branch(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    name = payload.get("name") or ""
    force = bool(payload.get("force", False))
    result = await app.git_service.delete_branch(ws_path, name, force=force)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.stash_list")
async def git_stash_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    entries = await app.git_service.coalesced(
        ("stash_list", ws_path), lambda: app.git_service.stash_list(ws_path)
    )
    await session.send_json(make_response(msg_id, msg_type, {"stashes": entries}))


@handler("git.stash")
async def git_stash(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    message = payload.get("message") or ""
    paths = payload.get("paths") or None
    result = await app.git_service.stash_push(ws_path, message, paths)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.stash_pop")
async def git_stash_pop(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    index = int(payload.get("index", 0))
    result = await app.git_service.stash_pop(ws_path, index)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.stash_drop")
async def git_stash_drop(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    index = int(payload.get("index", 0))
    result = await app.git_service.stash_drop(ws_path, index)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.amend")
async def git_amend(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    message = payload.get("message") or ""
    result = await app.git_service.amend_commit(ws_path, message)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.undo_commit")
async def git_undo_commit(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.undo_last_commit(ws_path)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.diff_file")
async def git_diff_file(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    filepath = payload.get("filepath") or ""
    staged = bool(payload.get("staged", False))
    commit = payload.get("commit") or ""
    result = await app.git_service.diff_file(ws_path, filepath, staged=staged, commit=commit)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.diff_blame")
async def git_diff_blame(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    filepath = payload.get("filepath") or ""
    staged = bool(payload.get("staged", False))
    result = await app.git_service.diff_blame(ws_path, filepath, staged=staged)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.commit_file_diff")
async def git_commit_file_diff(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    commit_hash = payload.get("commit_hash") or ""
    filepath = payload.get("filepath") or ""
    result = await app.git_service.commit_file_diff(ws_path, commit_hash, filepath)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.diff_all")
async def git_diff_all(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    staged = bool(payload.get("staged", False))
    result = await app.git_service.diff_all(ws_path, staged=staged)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.merge")
async def git_merge(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    branch = payload.get("branch") or ""
    result = await app.git_service.merge_branch(ws_path, branch)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.merge_into")
async def git_merge_into(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    target = payload.get("target") or ""
    result = await app.git_service.merge_into(ws_path, target)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.revert")
async def git_revert(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    commit_hash = payload.get("commit_hash") or ""
    result = await app.git_service.revert_commit(ws_path, commit_hash)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.remotes")
async def git_remotes(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    remotes = await app.git_service.coalesced(
        ("remotes", ws_path), lambda: app.git_service.list_remotes(ws_path)
    )
    await session.send_json(make_response(msg_id, msg_type, {"remotes": remotes}))


@handler("git.add_remote")
async def git_add_remote(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    name = payload.get("name") or ""
    url = payload.get("url") or ""
    result = await app.git_service.add_remote(ws_path, name, url)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.connect_to_remote")
async def git_connect_to_remote(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    url = payload.get("url") or ""
    result = await app.git_service.connect_to_remote(ws_path, url)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.remove_remote")
async def git_remove_remote(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    name = payload.get("name") or ""
    result = await app.git_service.remove_remote(ws_path, name)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.cherry_pick")
async def git_cherry_pick(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    commit_hash = payload.get("commit_hash") or ""
    result = await app.git_service.cherry_pick(ws_path, commit_hash)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.tags")
async def git_tags(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    tags = await app.git_service.coalesced(("tags", ws_path), lambda: app.git_service.list_tags(ws_path))
    await session.send_json(make_response(msg_id, msg_type, {"tags": tags}))


@handler("git.create_tag")
async def git_create_tag(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    name = payload.get("name") or ""
    message = payload.get("message") or ""
    commit_hash = payload.get("commit_hash") or ""
    result = await app.git_service.create_tag(ws_path, name, message, commit_hash)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.delete_tag")
async def git_delete_tag(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    name = payload.get("name") or ""
    result = await app.git_service.delete_tag(ws_path, name)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.file_log")
async def git_file_log(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    filepath = payload.get("filepath") or ""
    n = int(payload.get("n", 15))
    commits = await app.git_service.file_log(ws_path, filepath, n)
    await session.send_json(make_response(msg_id, msg_type, {"commits": commits}))


@handler("git.show_file")
async def git_show_file(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    filepath = payload.get("filepath") or ""
    rev = payload.get("rev") or "HEAD"
    result = await app.git_service.show_file(ws_path, filepath, rev)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.resolve_ours")
async def git_resolve_ours(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    filepath = payload.get("filepath") or ""
    result = await app.git_service.resolve_conflict_ours(ws_path, filepath)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.resolve_theirs")
async def git_resolve_theirs(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    filepath = payload.get("filepath") or ""
    result = await app.git_service.resolve_conflict_theirs(ws_path, filepath)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.conflict_stages")
async def git_conflict_stages(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    filepath = payload.get("filepath") or ""
    result = await app.git_service.conflict_stages(ws_path, filepath)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.list_conflicts")
async def git_list_conflicts(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.list_conflicts(ws_path)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.mark_resolved")
async def git_mark_resolved(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    filepath = payload.get("filepath") or ""
    result = await app.git_service.mark_resolved(ws_path, filepath)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.clean")
async def git_clean(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    dry_run = bool(payload.get("dry_run", True))
    result = await app.git_service.clean_untracked(ws_path, dry_run=dry_run)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok") and not dry_run:
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.show_commit")
async def git_show_commit(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    commit_hash = payload.get("commit_hash") or ""
    result = await app.git_service.show_commit(ws_path, commit_hash)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.worktrees")
async def git_worktrees(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    entries = await app.git_service.coalesced(
        ("worktrees", ws_path), lambda: app.git_service.list_worktrees(ws_path)
    )
    await session.send_json(make_response(msg_id, msg_type, {"worktrees": entries}))


@handler("git.add_worktree")
async def git_add_worktree(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    wt_path = payload.get("worktree_path") or ""
    branch = payload.get("branch") or ""
    new_branch = bool(payload.get("new_branch", False))
    result = await app.git_service.add_worktree(ws_path, wt_path, branch, new_branch=new_branch)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.remove_worktree")
async def git_remove_worktree(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    wt_path = payload.get("worktree_path") or ""
    force = bool(payload.get("force", False))
    result = await app.git_service.remove_worktree(ws_path, wt_path, force=force)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.prune_worktrees")
async def git_prune_worktrees(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.prune_worktrees(ws_path)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.lock_worktree")
async def git_lock_worktree(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    wt_path = payload.get("worktree_path") or ""
    reason = payload.get("reason") or ""
    result = await app.git_service.lock_worktree(ws_path, wt_path, reason)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.unlock_worktree")
async def git_unlock_worktree(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    wt_path = payload.get("worktree_path") or ""
    result = await app.git_service.unlock_worktree(ws_path, wt_path)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.move_worktree")
async def git_move_worktree(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    wt_path = payload.get("worktree_path") or ""
    new_path = payload.get("new_path") or ""
    result = await app.git_service.move_worktree(ws_path, wt_path, new_path)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.repair_worktrees")
async def git_repair_worktrees(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.repair_worktree(ws_path)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.config_get")
async def git_config_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.get_config(ws_path)
    result["allowed_keys"] = sorted(app.git_service._ALLOWED_CONFIG_KEYS)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.config_set")
async def git_config_set(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    key = payload.get("key") or ""
    value = payload.get("value") or ""
    result = await app.git_service.set_config(ws_path, key, value)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.blame")
async def git_blame(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    filepath = payload.get("filepath") or ""
    result = await app.git_service.blame_file(ws_path, filepath)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.compare_branches")
async def git_compare_branches(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    base = payload.get("base") or ""
    compare = payload.get("compare") or ""
    result = await app.git_service.compare_branches(ws_path, base, compare)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.diff_branches")
async def git_diff_branches(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    base = payload.get("base") or "main"
    compare = payload.get("compare") or ""
    result = await app.git_service.diff_branches(ws_path, base, compare)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.rebase")
async def git_rebase(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    branch = payload.get("branch") or ""
    result = await app.git_service.rebase_on(ws_path, branch)
    await session.send_json(make_response(msg_id, msg_type, result))
    # Refresh on success or when a rebase was left in progress on conflict,
    # so the UI shows the in-progress operation and conflicted files.
    if result.get("ok") or result.get("conflict_files"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.restore_from_branch")
async def git_restore_from_branch(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    branch = payload.get("branch") or ""
    filepath = payload.get("filepath") or ""
    result = await app.git_service.restore_file_from_branch(ws_path, branch, filepath)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.push_upstream")
async def git_push_upstream(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    branch = payload.get("branch") or ""
    remote = payload.get("remote") or "origin"
    result = await app.git_service.push_set_upstream(
        ws_path,
        branch,
        remote,
        on_credential_request=app.build_credential_request_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
        on_credential_settled=app.build_credential_settled_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
        credential=app._git_credential(payload),
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.apply_patch")
async def git_apply_patch(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    patch = payload.get("patch") or ""
    reverse = bool(payload.get("reverse", False))
    cached = bool(payload.get("cached", True))
    result = await app.git_service.apply_patch(ws_path, patch, reverse=reverse, cached=cached)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.clone")
async def git_clone(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    url = payload.get("url") or ""
    target_dir = payload.get("target_dir") or ""
    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.clone_repo(
        url,
        target_dir,
        on_credential_request=app.build_credential_request_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
        on_credential_settled=app.build_credential_settled_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
        credential=app._git_credential(payload),
    )
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.ignore")
async def git_ignore(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    pattern = payload.get("pattern") or ""
    target = payload.get("target") or "project"
    untrack = bool(payload.get("untrack", True))
    result = await app.git_service.add_to_gitignore(ws_path, pattern, target=target, untrack=untrack)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.check_ignore")
async def git_check_ignore(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    filepath = payload.get("filepath") or ""
    result = await app.git_service.check_ignore(ws_path, filepath)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.abort")
async def git_abort(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    op = payload.get("op") or ""
    result = await app.git_service.abort_operation(ws_path, op)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.stash_apply")
async def git_stash_apply(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    index = int(payload.get("index", 0))
    result = await app.git_service.stash_apply(ws_path, index)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.pull_rebase")
async def git_pull_rebase(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.pull_rebase(
        ws_path,
        on_credential_request=app.build_credential_request_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
        on_credential_settled=app.build_credential_settled_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
        credential=app._git_credential(payload),
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.push_force")
async def git_push_force(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    remote = payload.get("remote") or ""
    branch = payload.get("branch") or ""
    result = await app.git_service.push_force(
        ws_path,
        remote,
        branch,
        on_credential_request=app.build_credential_request_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
        on_credential_settled=app.build_credential_settled_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
        credential=app._git_credential(payload),
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


# ── Codex home cleanup (codex_home.cleanup) ─────────────────────────────────
async def _reclaim_codex_home(home_id: str) -> None:
    """Drop a pane home its pane no longer needs (#121). reclaim() keeps any
    home that still owns a resumable session, so this is safe to call for
    every pane that goes away; a manager without it (test fakes) is a no-op."""
    from . import app

    reclaim = getattr(app.codex_home_manager, "reclaim", None)
    if not home_id or not callable(reclaim):
        return
    try:
        if await asyncio.to_thread(reclaim, home_id):
            app.log.info("reclaimed codex pane home %s", home_id)
    except Exception as err:  # noqa: BLE001 — the pane is already gone; only disk is lost
        app.log.warning("reclaiming codex pane home %s failed: %s", home_id, err)


@handler("codex_home.cleanup")
async def codex_home_cleanup(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    cleaned = app.codex_home_manager.cleanup(str(payload.get("session_home_id") or ""))
    await session.send_json(
        make_response(msg_id, msg_type, {"ok": True, "cleaned": cleaned})
    )


# ── CLI account profiles (cli_profiles.*) ───────────────────────────────────
def _profile_error(err: Exception) -> str:
    return str(err.args[0]) if err.args else str(err)


def _profile_account_view() -> dict:
    """``{"identities": {agentKey: {slotId: {email, signedIn}}},
    "duplicates": {agentKey: {slotId: {email, slotIds}}}}`` for every account
    row the UI shows. ``__default__`` keys the built-in Default row.

    ``identities`` is what a row displays: the active slot's identity comes
    from the live credential state (slot storage lags live until the next
    capture/harvest).

    ``duplicates`` answers a different question — which rows hold the SAME
    account — and so compares slot snapshots only, the active row included:
    the live state belongs to exactly one account, and reading it for the
    active row would make that row duplicate whichever row actually stores
    the account. Emails match case-insensitively; a snapshot carrying no email
    (kimi, an empty ``__default__``, a claude login with no ``oauthAccount``)
    names no account and takes no part. Every slot of a duplicated account is
    listed, its own included, ``__default__`` among them — that row stores a
    snapshot and can be deleted like any other.

    Blocking reads (files, plus the Keychain for claude secrets) — run in a
    thread."""
    from . import app

    doc = app.cli_profiles_store.list()
    identities: dict[str, dict] = {}
    duplicates: dict[str, dict] = {}
    account_dirs: dict[str, dict] = {}
    for agent_key in PROFILE_AGENT_KEYS:
        active = doc["defaults"].get(agent_key) or DEFAULT_SLOT_ID
        slot_ids = [DEFAULT_SLOT_ID] + [
            p["id"] for p in doc["profiles"] if p.get("agentKey") == agent_key
        ]
        rows: dict[str, dict] = {}
        groups: dict[str, list[str]] = {}
        labels: dict[str, str] = {}
        for sid in slot_ids:
            snapshot = app.credential_vault.identity(agent_key, sid)
            rows[sid] = (
                app.credential_vault.identity(agent_key, None)
                if sid == active
                else snapshot
            )
            email = snapshot.get("email")
            if not isinstance(email, str) or not email:
                continue
            key = email.casefold()
            groups.setdefault(key, []).append(sid)
            labels.setdefault(key, email)
        if agent_key == "claude":
            # Accounts that signed in inside their own config dir: their row
            # shows that login — the one their panes run on — whatever the
            # swap slot still holds.
            dirs: dict[str, dict] = {}
            for sid in slot_ids:
                if sid == DEFAULT_SLOT_ID:
                    continue
                signed_in = app.credential_vault.account_dir_signed_in(sid)
                account = app.credential_vault.account_dir_identity(sid) if signed_in else None
                email = account.get("emailAddress") if isinstance(account, dict) else None
                email = email if isinstance(email, str) and email else None
                dirs[sid] = {"signedIn": signed_in, "email": email}
                if signed_in:
                    rows[sid] = {"email": email or rows[sid].get("email"), "signedIn": True}
            account_dirs[agent_key] = dirs
        identities[agent_key] = rows
        dupes = {
            sid: {"email": labels[key], "slotIds": ids}
            for key, ids in groups.items()
            if len(ids) > 1
            for sid in ids
        }
        if dupes:
            duplicates[agent_key] = dupes
    return {"identities": identities, "duplicates": duplicates, "accountDirs": account_dirs}


def _profile_pin_for_spawn(agent_key: str, payload_profile_id: object) -> str:
    """The profile a pane was created under, persisted in its restore record.
    Bookkeeping only (account attribution / history): spawns get no per-profile
    env, so the pin never affects which credentials a pane runs on — every
    regular pane uses the live (active-account) credentials in the real home.
    A restore carries the pane's recorded pin (``payload_profile_id``); a fresh
    spawn pins to the agent's currently active default. Returns "" for
    non-account agents, "__default__" when the active account is the unmanaged
    Default (real home), else the managed profile id."""
    from . import app

    if agent_key not in PROFILE_AGENT_KEYS:
        return ""
    pin = str(payload_profile_id or "")
    if pin:
        return pin
    pane_default = _pane_default_profile_id(agent_key)
    if pane_default:
        return pane_default
    active = app.cli_profiles_store.get_default_profile(agent_key)
    return active["id"] if active else DEFAULT_SLOT_ID


#: Terminal metadata key naming the claude account whose own config dir the
#: pane runs on (CLAUDE_CONFIG_DIR). Set by the backend only; such a pane does
#: not use the live credential, so an account switch never touches it.
ACCOUNT_DIR_METADATA_KEY = "account_dir_profile_id"


def _pane_default_profile_id(agent_key: str) -> str:
    """The account new panes start on when one was chosen apart from the
    live credential's owner (``paneDefaults``), or "". A choice whose profile
    is gone reads as none."""
    from . import app

    getter = getattr(app.cli_profiles_store, "get_pane_default", None)
    chosen = getter(agent_key) if callable(getter) else None
    if chosen and app.cli_profiles_store.get(chosen) is not None:
        return str(chosen)
    return ""


def _account_dir_for_spawn(
    agent_key: str, payload_profile_id: object, *, login: bool
) -> str:
    """The claude account whose own config dir this spawn runs on, or "" for
    the live credential (the swap model, unchanged). A sign-in into the dir
    (``login``) prepares it for the named profile even before it holds a
    login; any other spawn uses a dir only once its account signed in there,
    so an account that never did keeps running exactly as before. Blocking
    (directory I/O and, on macOS, a Keychain presence check).

    Only an explicit pin (``payload_profile_id``: a pane fixed to its account,
    or a dir sign-in) runs on a dir. A spawn without one follows the live
    credential even when the pane default or the live owner signed in inside
    its dir, so an account switch reaches it (plan claude_f1bf4b, scheme A).
    The pin recorded for bookkeeping is still _profile_pin_for_spawn's."""
    from . import app

    if agent_key != "claude":
        return ""
    slot = str(payload_profile_id or "")
    if not slot or slot == DEFAULT_SLOT_ID:
        return ""
    profile = app.cli_profiles_store.get(slot)
    if profile is None or profile.get("agentKey") != agent_key:
        return ""
    vault = app.credential_vault
    if not login and not vault.account_dir_signed_in(slot):
        return ""
    vault.prepare_account_dir(slot)
    return slot


def _profile_pin_for_bookkeeping(
    agent_key: str, pane_id: object, payload_profile_id: object
) -> str:
    """``_profile_pin_for_spawn`` for the bookkeeping messages."""
    return _profile_pin_for_spawn(agent_key, payload_profile_id)


def _account_pin_for_history(pin: str) -> str:
    """The id the pane account history records for a bookkeeping pin. A
    non-account agent pins "" in its restore record, but its usage samples
    are filed under the Default slot (usage_service._file_quota_samples), and
    the quota cycle's token side only finds the pane's slices when both name
    the same account — so the history gets DEFAULT_SLOT_ID for that pane."""
    return pin or DEFAULT_SLOT_ID


async def _broadcast_profiles_changed(
    reason: str,
    harvested_profile_ids: list[str] | None = None,
    agent_key: str | None = None,
    forced: bool | None = None,
    hot_switched_panes: list[dict[str, Any]] | None = None,
) -> None:
    from . import app

    view = await asyncio.to_thread(_profile_account_view)
    doc = app.cli_profiles_store.list()
    payload = {
        "profiles": doc["profiles"],
        "defaults": doc["defaults"],
        "defaultNames": doc["defaultNames"],
        "identities": view["identities"],
        # Account rows storing the same login as another row of the same agent
        # — the Accounts pane flags them so the user can delete the spare.
        "duplicates": view["duplicates"],
        # claude accounts' own config-dir logins: {"claude": {slotId:
        # {signedIn, email}}}, and the account new panes start on.
        "accountDirs": view["accountDirs"],
        "paneDefaults": doc["paneDefaults"],
        "reason": reason,
    }
    if harvested_profile_ids:
        # login-harvest: which profiles just captured a completed isolated
        # login — the initiating window uses this to close the login pane
        # and toast the signed-in identity.
        payload["harvestedProfileIds"] = harvested_profile_ids
    if agent_key is not None:
        # set_default: which agent switched accounts and whether the request
        # forced past the quiescence gate — every window uses this to restart
        # its own panes of that agent onto the new credentials.
        payload["agent_key"] = agent_key
        payload["forced"] = bool(forced)
    if hot_switched_panes is not None:
        # Another window can switch again while the account views are read.
        # Never pair rows from that earlier switch with the newer default.
        payload["hotSwitchedPanes"] = [
            row for row in hot_switched_panes
            if agent_key in doc["defaults"] and row["profileId"] == doc["defaults"][agent_key]
        ]
    await app.broadcast(make_event("cli_profiles.changed", payload))


@handler("cli_profiles.list")
async def cli_profiles_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    doc = app.cli_profiles_store.list()
    view = await asyncio.to_thread(_profile_account_view)
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "profiles": doc["profiles"],
                "defaults": doc["defaults"],
                "defaultNames": doc["defaultNames"],
                "identities": view["identities"],
                "duplicates": view["duplicates"],
                "accountDirs": view["accountDirs"],
                "paneDefaults": doc["paneDefaults"],
                "supported_agents": list(PROFILE_AGENT_KEYS),
                # Per vendor: hot/restart/manual, the credential pool, the
                # provider scopes a new profile may bind to, resume ability.
                "account_capabilities": quota_failover.capabilities(),
            },
        )
    )


@handler("cli_profiles.portable_removal_notice")
async def cli_profiles_portable_removal_notice(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """``{"show": true}`` exactly once on a machine whose pasted credentials the
    0.2.32 upgrade erased (portable_credentials_cleanup); false everywhere else."""
    from . import app, portable_credentials_cleanup

    show = await asyncio.to_thread(
        portable_credentials_cleanup.take_notice, app.database, now=int(time.time()))
    await session.send_json(make_response(msg_id, msg_type, {"show": show}))


@handler("cli_profiles.create")
async def cli_profiles_create(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # ``scope``: the provider a profile of a per-provider vendor (opencode,
    # pi …) binds to; the store validates it against the vendor's declared
    # scopes and refuses a multi-scope vendor without one.
    raw_scope = payload.get("scope")
    try:
        profile = app.cli_profiles_store.create(
            agent_key=str(payload.get("agent_key") or ""),
            name=str(payload.get("name") or ""),
            scope=str(raw_scope) if raw_scope else None,
        )
    except ValueError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", _profile_error(err))
        )
        return
    session._created_cli_profile_id = profile["id"]
    doc = app.cli_profiles_store.list()
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {"profile": profile, "profiles": doc["profiles"], "defaults": doc["defaults"]},
        )
    )
    await _broadcast_profiles_changed("create")


@handler("cli_profiles.rename")
async def cli_profiles_rename(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    profile_id = str(payload.get("id") or "")
    name = payload.get("name")
    try:
        # Only an explicit "" clears an alias; a missing or non-string name
        # is malformed, not a request to clear.
        if not isinstance(name, str):
            raise ValueError("name must be a string")
        if profile_id == DEFAULT_SLOT_ID:
            # The built-in Default slot has no profile record; its alias is
            # kept per agent, so the agent must be named.
            agent_key = str(payload.get("agent_key") or payload.get("agentKey") or "")
            if not agent_key:
                raise ValueError("agent_key is required to rename the Default account")
            app.cli_profiles_store.set_default_name(agent_key, name)
            profile = None
        else:
            profile = app.cli_profiles_store.rename(profile_id, name)
    except (KeyError, ValueError) as err:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", _profile_error(err))
        )
        return
    doc = app.cli_profiles_store.list()
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "profile": profile,
                "profiles": doc["profiles"],
                "defaults": doc["defaults"],
                "defaultNames": doc["defaultNames"],
            },
        )
    )
    await _broadcast_profiles_changed("rename")


@handler("cli_profiles.delete")
async def cli_profiles_delete(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    raw_id = payload.get("id")
    profile_id = str(raw_id) if raw_id else ""
    if not profile_id or profile_id == "__default__":
        agent_key = str(payload.get("agent_key") or payload.get("agentKey") or "")
        if not agent_key:
            await session.send_json(
                make_error(msg_id, msg_type, "BAD_REQUEST", "missing agent_key for default clear")
            )
            return
        if _running_login_terminals(agent_key, "__default__"):
            await session.send_json(
                make_error(
                    msg_id, msg_type, "LOGIN_IN_PROGRESS",
                    f"a {agent_key} sign-in for this account is still running; "
                    "finish or close its pane first",
                )
            )
            return
        async with app.credential_vault.switch_lock(agent_key):
            active_id = app.cli_profiles_store.list()["defaults"].get(agent_key)
            if active_id is None:
                clear_fn = getattr(app.credential_vault, "clear_live", None)
                if callable(clear_fn):
                    await vault_to_thread(clear_fn, agent_key)
            else:
                await vault_to_thread(
                    app.credential_vault.delete_slot_secrets, agent_key, "__default__"
                )
        await _broadcast_profiles_changed("delete")
        doc = app.cli_profiles_store.list()
        await session.send_json(
            make_response(
                msg_id,
                msg_type,
                {"profiles": doc["profiles"], "defaults": doc["defaults"]},
            )
        )
        return

    profile = app.cli_profiles_store.get(profile_id)
    if profile is None:
        await session.send_json(
            make_error(
                msg_id, msg_type, "BAD_REQUEST", f"profile not found: {profile_id}"
            )
        )
        return
    agent_key = str(profile.get("agentKey") or "")
    if _running_login_terminals(agent_key, profile_id):
        # Deleting the login home under a running login CLI breaks it; the
        # user finishes or closes the pane first (no auto-kill).
        await session.send_json(
            make_error(
                msg_id, msg_type, "LOGIN_IN_PROGRESS",
                f"a {agent_key} sign-in for this account is still running; "
                "finish or close its pane first",
            )
        )
        return
    # Serialize with account switches: the active check must see the latest
    # persisted default, and the secret cleanup must not interleave with a
    # credential swap on the same agent.
    async with app.credential_vault.switch_lock(agent_key):
        if app.cli_profiles_store.list()["defaults"].get(agent_key) == profile_id:
            # The active account's credentials ARE the live state; deleting it
            # would orphan them (the next switch would capture into a slot
            # nobody can select any more).
            await session.send_json(
                make_error(
                    msg_id, msg_type, "PROFILE_ACTIVE",
                    f"this {agent_key} account is currently active; "
                    "switch to another account before deleting it",
                )
            )
            return
        # A pane running on the account's own config dir would lose that dir
        # when the slot is archived below and drop to "Login expired".
        dir_panes = _running_account_dir_terminals(profile_id)
        if dir_panes:
            await session.send_json(
                make_error(
                    msg_id, msg_type, "ACCOUNT_DIR_IN_USE",
                    f"{len(dir_panes)} running {agent_key} pane(s) use this "
                    "account's own config dir; close them before deleting it",
                    {"count": len(dir_panes), "agent_key": agent_key},
                )
            )
            return
        # Remove secrets the archived slot dir cannot carry (claude's slot
        # Keychain item + oauth-account.json) and any leftover login home,
        # BEFORE the store renames the slot dir away. Cleanup failures must
        # never block the delete.
        try:
            await vault_to_thread(
                app.credential_vault.delete_slot_secrets, agent_key, profile_id
            )
        except Exception as err:  # noqa: BLE001
            app.log.warning(
                "slot secret cleanup for %s/%s failed: %s", agent_key, profile_id, err
            )
        try:
            doc = app.cli_profiles_store.delete(profile_id)
        except KeyError as err:
            await session.send_json(
                make_error(msg_id, msg_type, "BAD_REQUEST", _profile_error(err))
            )
            return
    await _broadcast_profiles_changed("delete")
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {"profiles": doc["profiles"], "defaults": doc["defaults"]},
        )
    )


def _running_account_dir_terminals(profile_id: str) -> list[str]:
    """Terminal ids of the live panes running on ``profile_id``'s own claude
    config dir (``ACCOUNT_DIR_METADATA_KEY``)."""
    from . import app

    running: list[str] = []
    for tid, owner in list(app._PTY_OWNERS.items()):
        lookup = getattr(getattr(owner, "terminals", None), "get", None)
        term = lookup(tid) if callable(lookup) else None
        if (
            term is not None
            and not getattr(term, "closed", False)
            and getattr(term, "metadata", {}).get(ACCOUNT_DIR_METADATA_KEY) == profile_id
        ):
            running.append(tid)
    return running


def _live_login_pending(agent_key: str) -> bool:
    """Has a non-isolated sign-in of any profile of this agent started and
    not been harvested or discarded yet? Read off the vault's pre-login
    snapshot, so it survives a backend restart. Blocking — thread it."""
    from . import app

    vault = app.credential_vault
    isolated = getattr(vault, "_login_isolated", None)
    if callable(isolated) and isolated(agent_key):
        return False
    try:
        profiles = app.cli_profiles_store.list()["profiles"]
    except Exception:  # noqa: BLE001
        return False
    for profile in profiles:
        if profile.get("agentKey") != agent_key or not profile.get("id"):
            continue
        slot_id = str(profile["id"])
        if quota_failover.login_pending(vault, agent_key, slot_id) and not (
            vault.login_home_path(agent_key, slot_id).is_dir()
        ):
            return True
    return False


def _running_live_login_terminals(agent_key: str) -> list[str]:
    """Terminal ids of the agent's running sign-in panes that write the LIVE
    credential store (a vendor with no login isolation; marked ``live_login``
    at spawn). While one runs, the live credential is not any account's own
    yet: no switch may capture it and no regular pane may be pinned to the
    store's default on it."""
    from . import app

    running: list[str] = []
    for tid, owner in list(app._PTY_OWNERS.items()):
        # An owner may be another window's opaque handle (no terminals): on
        # the terminal.create hot path this guard must never raise.
        lookup = getattr(getattr(owner, "terminals", None), "get", None)
        term = lookup(tid) if callable(lookup) else None
        if (
            term is not None
            and not getattr(term, "closed", False)
            and getattr(term, "agent_key", None) == agent_key
            and getattr(term, "metadata", {}).get("live_login")
        ):
            running.append(tid)
    return running


def _running_login_terminals(agent_key: str, profile_id: str) -> list[tuple[str, "Session"]]:
    """(terminal_id, owner session) for every live isolated LOGIN pane of the
    given profile. While one runs, its login home must not be harvested: the
    CLI could still rotate the token after the snapshot, and deleting the
    config home under a running CLI breaks it."""
    from . import app

    running: list[tuple[str, "Session"]] = []
    for tid, owner in list(app._PTY_OWNERS.items()):
        term = owner.terminals.get(tid)
        if (
            term is not None
            and not term.closed
            and term.agent_key == agent_key
            and term.metadata.get("login_profile_id") == profile_id
        ):
            running.append((tid, owner))
    return running


# CLIs that consult their credential source on every request instead of
# caching it in memory for the life of the process. Their live panes pick the
# swapped-in account up on their next turn, so an account switch needs neither
# the quiescence gate nor a pane restart. Verified by decompiling Claude Code
# 2.1.223: the client factory awaits a credential re-read before every request,
# and that re-read happens BEFORE the token-expiry check — see
# .agent-team/plans/cli-claude-hot-swap_abd651.html. codex caches auth in
# memory (AuthManager::auth_cached) and reloads only on 401 recovery; kimi and
# grok are unaudited. Add an agent here only with the same kind of evidence.
HOT_SWAP_AGENTS = frozenset({"claude"})

# Switching accounts is a manual, deliberate action. These bounds exist so it
# stays one: without the quiescence gate a hot-swap agent has no friction left,
# and unbounded programmatic switching would turn multi-account support into
# automatic rotation ("swap when the quota runs low"), which is a different
# thing from using several accounts. Deliberately loose — hands never reach it.
SWITCH_RATE_WINDOW_S = 60.0
SWITCH_RATE_MAX = 3
_switch_history: dict[str, list[float]] = {}


def _switch_rate_retry_after(agent_key: str) -> float:
    """Seconds until this agent may switch again; 0.0 while within quota.
    Prunes the window as a side effect. Callers hold the agent's switch_lock,
    so no extra synchronization is needed."""
    now = time.monotonic()
    recent = [t for t in _switch_history.get(agent_key, []) if now - t < SWITCH_RATE_WINDOW_S]
    _switch_history[agent_key] = recent
    if len(recent) < SWITCH_RATE_MAX:
        return 0.0
    return SWITCH_RATE_WINDOW_S - (now - recent[0])


def _record_switch(agent_key: str) -> None:
    """Count one completed switch against the rate window. Only swaps that
    actually happened are recorded — a no-op or a refused switch does not
    consume quota."""
    _switch_history.setdefault(agent_key, []).append(time.monotonic())


def _running_regular_terminals(agent_key: str) -> list[str]:
    """Terminal ids of every live NON-login pane of the given agent. Every
    regular pane runs on the live credentials in the real home — the very
    credentials an account switch swaps. For agents outside HOT_SWAP_AGENTS
    the CLI holds those credentials in memory for the life of the process, so
    a pane that keeps running after a swap stays on the outgoing account until
    it is restarted."""
    from . import app

    running: list[str] = []
    for tid, owner in list(app._PTY_OWNERS.items()):
        term = owner.terminals.get(tid)
        if (
            term is not None
            and not term.closed
            and term.agent_key == agent_key
            and not term.metadata.get("login_profile_id")
        ):
            running.append(tid)
    return running


def _slot_login_reason(agent_key: str, slot_id: str) -> str | None:
    """Why restoring this slot leaves the CLI unable to authenticate, or None
    when it can. The caller starts a sign-in for any reason it returns.

    Two shapes, and the difference is worth telling the user. ``signed-out``:
    the slot holds no secret at all (restore() then CLEARS the live credentials
    — an empty slot signs the user out), or claude's snapshot was wiped in place
    by Claude Code (both tokens emptied after an ``invalid_grant``, so it
    restores as a non-credential). ``expired``: claude's snapshot sat parked
    long enough for its access token to expire AND it carries no refresh token
    to renew it with. Nothing renews a parked slot — the CLI is the only
    refresher — so an aged access token is routine: it goes live expired and
    Claude Code renews it from the restored refresh token on its next run. That
    case is usable and must not start a sign-in (every account parked longer
    than one access-token lifetime would otherwise re-login on each switch).
    Only a snapshot with nothing left to refresh from needs one, and it must
    not be announced as "signed out". A claude login with no OAuth block
    (long-lived token) carries nothing to judge, so it counts as usable.
    Blocking reads (Keychain) — thread it."""
    from . import app
    from .credential_vault import _claude_credential_is_wiped
    from .usage_service import claude_token_expired, parse_claude_credentials

    try:
        creds = app.credential_vault.read_slot(agent_key, slot_id)
    except Exception:  # noqa: BLE001 — a read failure must not invent a logout
        return None
    if creds.secret is None:
        return "signed-out"
    if agent_key != "claude":
        return None
    # A wiped blob parses as "no OAuth block to judge", which the expiry check
    # below would pass as usable — catch it before that.
    if _claude_credential_is_wiped(creds.secret):
        return "signed-out"
    oauth = parse_claude_credentials(creds.secret)
    if (
        oauth is not None
        and claude_token_expired(oauth)
        and not oauth.get("refreshToken")
    ):
        return "expired"
    return None


@handler("cli_profiles.account_dir_expired")
async def cli_profiles_account_dir_expired(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """A pane running on a claude account's own config dir reported "Login
    expired". The dir stops counting as signed in until its login changes, so
    new panes fall back to the live credential and the account list offers
    the sign-in again. ``marked`` is False when the login carries no change
    stamp to clear the mark by — then only the pane's own hint applies."""
    from . import app

    profile_id = str(payload.get("profile_id") or "")
    profile = app.cli_profiles_store.get(profile_id) if profile_id else None
    if profile is None or profile.get("agentKey") != "claude":
        await session.send_json(make_error(
            msg_id, msg_type, "NOT_FOUND", f"claude profile not found: {profile_id}",
        ))
        return
    marked = await vault_to_thread(app.credential_vault.mark_account_dir_expired, profile_id)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "marked": marked}))
    if marked:
        await _broadcast_profiles_changed("account_dir_expired")


@handler("cli_profiles.set_pane_default")
async def cli_profiles_set_pane_default(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Choose the claude account new panes start on, by its own config dir.
    Nothing is swapped and no running pane changes account — that is what
    ``set_default`` (the live-credential switch) is for. Only an account that
    signed in inside its config dir can be chosen; ``profile_id`` null/""
    clears the choice so new panes follow the live credential again."""
    from . import app

    agent_key = str(payload.get("agent_key") or "")
    profile_id = str(payload.get("profile_id") or "")
    if agent_key != "claude":
        await session.send_json(make_error(
            msg_id, msg_type, "BAD_REQUEST",
            f"per-account config dirs are claude-only, not {agent_key!r}",
        ))
        return
    if profile_id:
        profile = app.cli_profiles_store.get(profile_id)
        if profile is None or profile.get("agentKey") != agent_key:
            await session.send_json(make_error(
                msg_id, msg_type, "NOT_FOUND", f"profile not found: {profile_id}",
            ))
            return
        if not await vault_to_thread(app.credential_vault.account_dir_signed_in, profile_id):
            await session.send_json(make_error(
                msg_id, msg_type, "ACCOUNT_DIR_SIGNED_OUT",
                "this account has not signed in inside its own config dir yet",
                {"agent_key": agent_key, "profile_id": profile_id},
            ))
            return
    pane_defaults = app.cli_profiles_store.set_pane_default(agent_key, profile_id or None)
    await session.send_json(make_response(
        msg_id, msg_type, {"ok": True, "paneDefaults": pane_defaults},
    ))
    await _broadcast_profiles_changed("set_pane_default")


def _record_switch_back(agent_key: str, failure: str) -> None:
    """The audit row of an account prompt's "switch back" (credentials.auto-repair)."""
    from .convenience_wiring import gate as convenience_gate

    g = convenience_gate()
    if g is not None:
        detail = "switched back from the account prompt"
        g.record("credentials.auto-repair", "repair", f"{agent_key} live login",
                 detail=f"{detail}; {failure}" if failure else detail)


@handler("cli_profiles.set_default")
async def cli_profiles_set_default(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Switch the agent's active account: capture the live credentials into the
    outgoing account's slot, then restore the target slot into the real home.

    Three ways it can be refused. Every switch is rate limited
    (SWITCH_RATE_LIMITED, not bypassable). Agents outside HOT_SWAP_AGENTS are
    additionally gated on quiescence, because their live panes hold the
    outgoing credentials in memory: live non-login panes fail with
    PANES_RUNNING unless the request carries force=true (the frontend then
    restarts the affected panes itself — the backend never kills them).
    A still-running isolated sign-in for the target account blocks it
    (LOGIN_IN_PROGRESS), because the switch harvests its login home into the
    slot before restoring it.

    Hot-swap agents skip the quiescence gate and never get the restart
    broadcast: their CLI re-reads the credential source every request, so live
    panes land on the new account by themselves."""
    from . import app

    agent_key = str(payload.get("agent_key") or "")
    raw_profile_id = payload.get("profile_id")
    profile_id = str(raw_profile_id) if raw_profile_id else None
    hot_switched_panes: list[dict[str, Any]] | None = None

    # Validate before touching any credentials.
    if agent_key not in PROFILE_AGENT_KEYS:
        await session.send_json(
            make_error(
                msg_id, msg_type, "BAD_REQUEST",
                f"unsupported agent for CLI profiles: {agent_key!r}",
            )
        )
        return
    if profile_id is not None:
        profile = app.cli_profiles_store.get(profile_id)
        if profile is None:
            await session.send_json(
                make_error(
                    msg_id, msg_type, "BAD_REQUEST",
                    f"profile not found: {profile_id}",
                )
            )
            return
        if profile.get("agentKey") != agent_key:
            await session.send_json(
                make_error(
                    msg_id, msg_type, "BAD_REQUEST",
                    f"profile {profile_id} does not belong to agent {agent_key!r}",
                )
            )
            return

    # Serialize the whole read-current → swap → persist-default sequence per
    # agent: concurrent switches (multiple windows, or a switch racing the usage
    # poller's harvest) would otherwise both read the same current_id and clobber
    # a slot. Reading current_id inside the lock is essential — a second waiter
    # must see the first switch's persisted result.
    async with app.credential_vault.switch_lock(agent_key):
        guard = getattr(app.credential_vault, "require_store_mutation", None)
        if guard is not None:
            try:
                await vault_to_thread(guard, agent_key)
            except ValueError as err:
                await session.send_json(make_error(msg_id, msg_type, "CREDENTIAL_STORE_UNVERIFIED", str(err)))
                return
        pending = app.quota_failover.unreconciled(agent_key)
        if pending is not None:
            # A failover swap moved the credentials but could not persist the
            # default: the store's "current" is not who is live. Capturing
            # the live account into that slot would destroy the slot's own
            # credentials. Refuse until quota_failover.reconcile has run.
            await session.send_json(
                make_error(
                    msg_id, msg_type, "UNRECONCILED_STATE",
                    "an earlier account switch is not reconciled; finish it before "
                    "switching again",
                    dict(pending),
                )
            )
            return
        current_id = app.cli_profiles_store.list()["defaults"].get(agent_key)
        # Optional optimistic-concurrency fields, mandatory when the caller
        # is confirming an unverifiable live credential (assume_live_is_current):
        # the answer must be about the state the user was shown. Compared
        # here, under the lock and before any harvest, capture or write.
        # ``expected_epoch`` is the agent's failover epoch (quota_failover
        # State.epochs), which moves on every credential swap and reconcile —
        # A -> C -> A leaves the account the same but not the epoch.
        assume = bool(payload.get("assume_live_is_current"))
        has_expected = (
            "expected_current_slot_id" in payload and "expected_epoch" in payload
            and bool(str(payload.get("live_fingerprint") or ""))
        )
        if assume and not has_expected:
            # The epoch cannot see a CLI rewriting the live store during the
            # dialog; the fingerprint from the refusal can. All three or none.
            await session.send_json(
                make_error(
                    msg_id, msg_type, "BAD_REQUEST",
                    "assume_live_is_current requires expected_current_slot_id, "
                    "expected_epoch and live_fingerprint from the refusal it answers",
                )
            )
            return
        if "expected_current_slot_id" in payload and \
                str(payload.get("expected_current_slot_id") or DEFAULT_SLOT_ID) != (current_id or DEFAULT_SLOT_ID):
            await session.send_json(
                make_error(
                    msg_id, msg_type, "STALE_STATE",
                    "the active account changed since this was proposed",
                    {"currentSlotId": current_id or DEFAULT_SLOT_ID},
                )
            )
            return
        if "expected_epoch" in payload:
            try:
                expected_epoch = int(payload.get("expected_epoch"))
            except (TypeError, ValueError):
                await session.send_json(
                    make_error(msg_id, msg_type, "BAD_REQUEST", "expected_epoch must be an integer")
                )
                return
            if expected_epoch != app.quota_failover.epoch(agent_key):
                await session.send_json(
                    make_error(
                        msg_id, msg_type, "STALE_EPOCH",
                        "an account switch already happened",
                        {"epoch": app.quota_failover.epoch(agent_key)},
                    )
                )
                return
        # The account prompt's "switch back" (restore_live) answers one prompt
        # about one live login. It carries that login's fingerprint and is
        # refused once another login is live, so a stale prompt never
        # overwrites, or captures into a slot, a login it did not name.
        restore_live = bool(payload.get("restore_live"))
        prompt_live: str | None = None
        prompt_kw: dict[str, Any] = {}
        if restore_live:
            from .convenience_wiring import login_fingerprint

            expected_fingerprint = payload.get("restore_live_fingerprint")
            if not isinstance(expected_fingerprint, str):
                await session.send_json(
                    make_error(
                        msg_id, msg_type, "BAD_REQUEST",
                        "restore_live requires the prompt's restore_live_fingerprint",
                    )
                )
                return
            prompt_scope = quota_failover.profile_scope(
                agent_key, app.cli_profiles_store.get(profile_id) if profile_id else None
            )
            prompt_kw = {"scope": prompt_scope} if prompt_scope else {}
            try:
                prompt_live = await vault_to_thread(
                    lambda: app.credential_vault.read_live(agent_key, strict=True, **prompt_kw).secret
                )
            except Exception as err:  # noqa: BLE001 — unread is not signed out
                await session.send_json(
                    make_error(msg_id, msg_type, "PROFILE_SWAP_FAILED", _profile_error(err))
                )
                return
            if login_fingerprint(prompt_live) != expected_fingerprint:
                await session.send_json(
                    make_error(
                        msg_id, msg_type, "LIVE_CHANGED",
                        f"another {agent_key} login is live since this prompt; nothing was switched",
                    )
                )
                return
        # The switch-back while its account is still the active one: the live
        # login is someone else's (or nobody's), so "already active" would be
        # a false ok. It runs as the normal switch below, guards and all, from
        # the profile that keeps the live login (see restore_over_live).
        restore_over_live = restore_live and current_id == profile_id
        if restore_over_live:
            try:
                own = await vault_to_thread(
                    lambda: app.credential_vault.read_slot(
                        agent_key, profile_id or DEFAULT_SLOT_ID, **prompt_kw
                    ).secret
                )
            except Exception as err:  # noqa: BLE001
                await session.send_json(
                    make_error(msg_id, msg_type, "PROFILE_SWAP_FAILED", _profile_error(err))
                )
                return
            restore_over_live = prompt_live != own
        if current_id == profile_id and not restore_over_live:
            # Already active — nothing to swap, nothing changed.
            await session.send_json(
                make_response(
                    msg_id, msg_type, {"defaults": app.cli_profiles_store.list()["defaults"]}
                )
            )
            return

        # The provider entry a per-provider vendor's swap moves: the profile
        # on whichever side has one (the built-in default has no record and
        # takes the other side's). Two profiles must name the same provider.
        # Whole-file vendors get None, the vault's "the whole file" answer.
        current_profile = app.cli_profiles_store.get(current_id) if current_id else None
        target_profile = app.cli_profiles_store.get(profile_id) if profile_id else None
        scope_from = quota_failover.profile_scope(agent_key, current_profile)
        scope_to = quota_failover.profile_scope(agent_key, target_profile)
        if current_profile is not None and target_profile is not None and scope_from != scope_to:
            await session.send_json(
                make_error(
                    msg_id, msg_type, "SCOPE_MISMATCH",
                    "the two accounts belong to different provider credential pools",
                )
            )
            return
        switch_scope = scope_to if target_profile is not None else scope_from
        # Rate limit: keeps account switching a manual action (see the
        # SWITCH_RATE_* constants). Checked before anything is touched, and
        # deliberately NOT bypassable by force — force means "I accept the pane
        # restart", not "let me switch as fast as I like".
        retry_after = _switch_rate_retry_after(agent_key)
        if retry_after > 0:
            await session.send_json(
                make_error(
                    msg_id, msg_type, "SWITCH_RATE_LIMITED",
                    f"too many {agent_key} account switches; retry in "
                    f"{retry_after:.0f}s",
                    {"retryAfter": retry_after},
                )
            )
            return

        # Quiescence gate: outside HOT_SWAP_AGENTS a live regular pane holds
        # the outgoing account's credentials in memory and stays on them until
        # it restarts. Refuse unless the caller forces the switch (it then
        # restarts the affected panes itself; the backend never kills them).
        # Hot-swap agents re-read their credential source every request, so
        # their panes need neither the gate nor a restart.
        if agent_key not in HOT_SWAP_AGENTS and not payload.get("force"):
            running_count = len(_running_regular_terminals(agent_key))
            if running_count:
                await session.send_json(
                    make_error(
                        msg_id, msg_type, "PANES_RUNNING",
                        f"{running_count} running {agent_key} pane(s) still use "
                        "the current account; close them or force the switch",
                        {"count": running_count},
                    )
                )
                return

        # A running sign-in pane means a credential is still being written:
        # the target's (its login home, or the live store itself for a vendor
        # with no login isolation), or — for a live-store sign-in of ANY
        # profile — the very credential this switch would capture as the
        # outgoing account's. Refuse for every vendor, home or no home.
        if (profile_id is not None and _running_login_terminals(agent_key, profile_id)) \
                or _running_live_login_terminals(agent_key):
            await session.send_json(
                make_error(
                    msg_id, msg_type, "LOGIN_IN_PROGRESS",
                    f"a {agent_key} sign-in is still running; finish or close its pane first",
                )
            )
            return
        # A started, unharvested sign-in for the target must land in its slot
        # BEFORE restore() — restoring the still-empty slot would sign the
        # live state out and the next capture() would erase the completed
        # login. ``login_pending`` covers both the isolated login home and a
        # non-isolated sign-in's parked pre-login snapshot (the vault then
        # parks the new credential and puts the outgoing one back live).
        if profile_id is not None and await vault_to_thread(
            quota_failover.login_pending, app.credential_vault, agent_key, profile_id
        ):
            try:
                await vault_to_thread(
                    functools.partial(
                        app.credential_vault.harvest_login_home, agent_key, profile_id,
                        scope=switch_scope,
                    )
                )
            except Exception as err:  # noqa: BLE001 — credentials untouched, refuse cleanly
                await session.send_json(
                    make_error(msg_id, msg_type, "PROFILE_SWAP_FAILED", _profile_error(err))
                )
                return

        if restore_over_live and prompt_live is not None:
            # Keep the live login before it is replaced: the profile holding
            # it becomes the outgoing account (one registered for it when
            # none does), so the switch below captures it there.
            from .usage_service import _follow_live_account

            try:
                live_email = await vault_to_thread(
                    lambda: app.credential_vault.identity(agent_key, strict=True, **prompt_kw).get("email")
                )
            except Exception as err:  # noqa: BLE001 — nothing moved; refuse cleanly
                await session.send_json(
                    make_error(msg_id, msg_type, "PROFILE_SWAP_FAILED", _profile_error(err))
                )
                return
            followed = await vault_to_thread(
                _follow_live_account, agent_key, profile_id or DEFAULT_SLOT_ID,
                live_email or None, switch_scope,
            )
            if followed is None:
                await session.send_json(
                    make_error(
                        msg_id, msg_type, "PROFILE_SWAP_FAILED",
                        f"the live {agent_key} login could not be kept in a profile; nothing was switched",
                    )
                )
                return
            current_id = None if followed == DEFAULT_SLOT_ID else followed
        # Nobody is signed in: there is nothing to capture, only the slot to
        # bring back.
        restore_only = restore_over_live and prompt_live is None

        # Judged BEFORE the swap, while the slot still holds what will become
        # live: an empty or dead-token slot signs the CLI out, and the caller
        # opens a sign-in instead of leaving the user at a "not logged in"
        # prompt they have to resolve by hand.
        login_reason = await vault_to_thread(
            _slot_login_reason, agent_key, profile_id or DEFAULT_SLOT_ID
        )

        # Is the live credential still the outgoing account's? switch()
        # begins by capturing live into the outgoing slot; if a sign-in
        # against the live store (a vendor with no login isolation) already
        # replaced it, that capture would overwrite the outgoing account's
        # only copy with someone else's credential. When the target slot is
        # empty the live credential can only be the target's fresh sign-in:
        # park it there and bring nothing else live. Otherwise the user's
        # pick wins: a manual switch is never refused for drift (the
        # reconcile gate belongs to the quota failover transaction alone),
        # so the risk is logged and reported as ``warning``.
        drift = "none" if restore_only else await vault_to_thread(
            quota_failover.live_drift, app.credential_vault, agent_key,
            current_id or DEFAULT_SLOT_ID, scope_from,
        )
        adopted = False
        warning = None
        target_slot = profile_id or DEFAULT_SLOT_ID
        if drift == "drifted":
            target_empty = await vault_to_thread(
                lambda: app.credential_vault.read_slot(
                    agent_key, target_slot, **({"scope": switch_scope} if switch_scope else {})
                ).secret is None
            )
            if not target_empty:
                warning = "live-drift"
        elif drift == "unverifiable":
            warning = "live-drift-unverified"
        if warning is not None:
            app.log.warning(
                "manual %s switch %s -> %s: %s; the live credential is captured into "
                "the outgoing slot as-is", agent_key, current_id or DEFAULT_SLOT_ID,
                target_slot, warning,
            )
        if drift == "drifted" and warning is None:
            try:
                await vault_to_thread(
                    functools.partial(
                        app.credential_vault.capture, agent_key, target_slot,
                        **({"scope": switch_scope} if switch_scope else {}),
                    )
                )
            except Exception as err:  # noqa: BLE001 — nothing moved; refuse cleanly
                await session.send_json(
                    make_error(msg_id, msg_type, "PROFILE_SWAP_FAILED", _profile_error(err))
                )
                return
            adopted = True
            login_reason = None
        else:
            try:
                if restore_only:
                    await vault_to_thread(functools.partial(
                        app.credential_vault.restore, agent_key,
                        profile_id or DEFAULT_SLOT_ID, **prompt_kw,
                    ))
                else:
                    await vault_to_thread(
                        functools.partial(
                            app.credential_vault.switch,
                            agent_key,
                            current_id or DEFAULT_SLOT_ID,
                            profile_id or DEFAULT_SLOT_ID,
                            scope=switch_scope,
                        )
                    )
            except Exception as err:  # noqa: BLE001 — switch() already rolled the live state back
                if restore_live:
                    _record_switch_back(agent_key, f"failed: {err}")
                await session.send_json(
                    make_error(msg_id, msg_type, "PROFILE_SWAP_FAILED", _profile_error(err))
                )
                return
        if restore_live:
            _record_switch_back(agent_key, "")

        # The credentials moved — count it, whatever happens to the bookkeeping
        # below (a persisted-default failure still leaves the new account live).
        _record_switch(agent_key)

        try:
            defaults = app.cli_profiles_store.set_default(agent_key, profile_id)
        except (KeyError, ValueError) as err:
            await session.send_json(
                make_error(msg_id, msg_type, "BAD_REQUEST", _profile_error(err))
            )
            return
        if agent_key in HOT_SWAP_AGENTS:
            auth_scope = quota_failover.auth_scope_for_scope(agent_key, switch_scope)
            hot_switched_panes = app.quota_failover.rebind_hot_panes(
                agent_key, profile_id or DEFAULT_SLOT_ID, auth_scope,
            )
        await session.send_json(
            make_response(msg_id, msg_type, {
                "defaults": defaults,
                # True when the live credential was already the target's fresh
                # sign-in and was parked into its slot instead of swapped.
                "adoptedLiveLogin": adopted,
                "needsLogin": login_reason is not None,
                # Which of the two is on screen decides whether the sign-in
                # pane reads as "you were logged out" or "this needs
                # re-authenticating" — the latter is routine after parking.
                "needsLoginReason": login_reason,
                # "live-drift" / "live-drift-unverified": the live credential
                # captured into the outgoing slot may not have been its own.
                "warning": warning,
            })
        )
    # The user switched by hand: any automatic proposal still pending for this
    # agent is withdrawn and the failover epoch moves, so a stale proposal
    # cannot commit against the account the user just chose. Publish this
    # before profiles.changed so windows recognize a manual restart.
    try:
        await app.quota_failover.on_manual_switch(agent_key, profile_id)
    except Exception:  # noqa: BLE001 — the switch itself succeeded and was answered
        app.log.exception("quota_failover: manual switch hook failed")
    # `forced` is what makes every window restart its panes of this agent. A
    # hot-swap agent's panes must never be restarted, so the flag stays False
    # for them even when the caller passed force=true.
    await _broadcast_profiles_changed(
        "set_default",
        agent_key=agent_key,
        forced=agent_key not in HOT_SWAP_AGENTS and bool(payload.get("force")),
        hot_switched_panes=hot_switched_panes,
    )
    # The usage badges read the active account's credentials — force the poller
    # to re-fetch now so the badge reflects the switch immediately.
    from .usage_service import service

    if agent_key == "claude":
        # A Claude read boots a whole CLI, so "immediately" is tens of seconds
        # away. Announce the new active account and mark it as being read, or
        # the badge sits on the outgoing account's numbers with no sign why.
        # An account that has to sign in first gets the pointer but not the
        # promise: "reading its quota" next to a login pane is a contradiction.
        try:
            await service.announce_claude_switch(profile_id, reading=login_reason is None)
        except Exception:  # noqa: BLE001
            # The switch itself already succeeded and was answered. Letting this
            # escape would send a second, contradictory frame for a message the
            # caller has resolved; the worst real cost is a badge that waits for
            # the next poll, which is where it was before this announcement.
            app.log.exception("usage: failed to announce the claude account switch")
    else:
        service.request_refresh()


# ── Quota failover (quota_failover.*) ────────────────────────────────────────
# Thin adapters over quota_failover.QuotaFailoverService — the authority for
# off/notify/auto, incidents, candidates, the persisted automatic budget and
# switch transactions. See that module's docstring and the plan
# quota-exhaustion-auto-switch_7b3e91.

async def _failover_call(
    session: "Session", msg_id: str, msg_type: str, call, *, shape
) -> None:
    """Run one authority call and answer it; a FailoverRefused becomes the WS
    error it names."""
    try:
        result = await call()
    except quota_failover.FailoverRefused as refused:
        await session.send_json(
            make_error(msg_id, msg_type, refused.code, refused.message, refused.details)
        )
        return
    await session.send_json(make_response(msg_id, msg_type, shape(result)))


@handler("quota_failover.get_state")
async def quota_failover_get_state(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    await session.send_json(make_response(msg_id, msg_type, app.quota_failover.state()))


@handler("quota_failover.set_policy")
async def quota_failover_set_policy(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    mode = str(payload.get("mode") or "")

    async def call():
        await app.quota_failover.set_policy(mode)
        return app.quota_failover.state()

    await _failover_call(session, msg_id, msg_type, call, shape=lambda state: state)


@handler("quota_failover.report")
async def quota_failover_report(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    await _failover_call(
        session, msg_id, msg_type, lambda: app.quota_failover.report(payload),
        shape=lambda result: {"incident": result[0].to_dict(), "created": result[1]},
    )


@handler("quota_failover.candidates")
async def quota_failover_candidates(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    agent_key = str(payload.get("agent_key") or "")
    await _failover_call(
        session, msg_id, msg_type, lambda: app.quota_failover.candidates(agent_key),
        shape=lambda rows: {"agentKey": agent_key, "candidates": rows},
    )


@handler("quota_failover.switch")
async def quota_failover_switch(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    await _failover_call(
        session, msg_id, msg_type, lambda: app.quota_failover.begin_switch(payload),
        shape=lambda tx: {"transaction": tx.to_dict()},
    )


@handler("quota_failover.confirm")
async def quota_failover_confirm(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    tx_id = str(payload.get("transaction_id") or "")
    await _failover_call(
        session, msg_id, msg_type, lambda: app.quota_failover.confirm(tx_id),
        shape=lambda tx: {"transaction": tx.to_dict()},
    )


@handler("quota_failover.ack")
async def quota_failover_ack(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    await _failover_call(
        session, msg_id, msg_type, lambda: app.quota_failover.ack(payload),
        shape=lambda tx: {"transaction": tx.to_dict()},
    )


@handler("quota_failover.settle")
async def quota_failover_settle(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    await _failover_call(
        session, msg_id, msg_type, lambda: app.quota_failover.settle(payload, owner=session),
        shape=lambda tx: {"transaction": tx.to_dict()},
    )


@handler("quota_failover.reconcile")
async def quota_failover_reconcile(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    agent_key = str(payload.get("agent_key") or "")
    tx_id = str(payload.get("transaction_id") or "")
    live = payload.get("live_slot_id")
    await _failover_call(
        session, msg_id, msg_type,
        lambda: app.quota_failover.reconcile(agent_key, tx_id, str(live) if live else None),
        shape=lambda result: result,
    )


@handler("quota_failover.cancel")
async def quota_failover_cancel(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    tx_id = str(payload.get("transaction_id") or "")
    await _failover_call(
        session, msg_id, msg_type, lambda: app.quota_failover.cancel(tx_id),
        shape=lambda tx: {"transaction": tx.to_dict()},
    )


# ── Agent session / orphans (agent.*) ───────────────────────────────────────
@handler("agent.session_exists")
async def agent_session_exists(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    _agent = str(payload.get("agent", ""))
    _ws = str(payload.get("workspace_path", ""))
    _sid = str(payload.get("session_id", ""))
    exists = app._session_exists(_agent, _ws, _sid)
    checked_path = app._session_lookup_path(_agent, _ws, _sid)
    if not exists and _sid.strip():
        # Diagnostic: a resume that reports "not found" logs exactly
        # where it looked, so a colliding/encoded path is visible.
        app.log.info(
            "resume preflight miss: agent=%s session=%s checked=%s",
            _agent.strip().lower(), _sid.strip(),
            checked_path or "(vendor-managed)",
        )
    await session.send_json(
        make_response(msg_id, msg_type, {"exists": exists, "checked_path": checked_path})
    )


@handler("agent.orphan_scan")
async def agent_orphan_scan(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # Read-only leftover count (dead-backend PTY children still alive).
    orphans = await asyncio.to_thread(in_data_dir(app_data_dir(), app.pty_registry.scan_orphans))
    await session.send_json(
        make_response(msg_id, msg_type, {"orphans": orphans, "count": len(orphans)})
    )


@handler("agent.reap_orphans")
async def agent_reap_orphans(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # Manual cleanup: kill the leftover process groups reap_stale finds.
    reaped = await asyncio.to_thread(in_data_dir(app_data_dir(), app.pty_registry.reap_stale))
    await session.send_json(
        make_response(msg_id, msg_type, {"reaped": reaped, "count": len(reaped)})
    )


# ── MCP servers (mcp.*) ─────────────────────────────────────────────────────
# Live MCP status fields passed through to Settings -> MCP as they are.
_MCP_LIVE_DETAIL = ("starting_seconds", "slow_start", "error", "stderr_tail", "tools_error")


@handler("mcp.list_servers")
async def mcp_list_servers(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    try:
        configured = app.mcp_settings_store.list_servers()
    except MCPSettingsError as err:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "MCP_SETTINGS_INVALID",
                str(err),
                {"path": str(app.mcp_settings_store.path)},
            )
        )
        return
    revision = str(app.mcp_settings_store.revision)
    # The servers each CLI already loads on its own. Scanning reads the user's
    # config files and reports its own failures per file, so it never raises;
    # a thread keeps that file I/O off the loop.
    native = await asyncio.to_thread(native_mcp.scan)
    live = await app.mcp_manager.list_status()
    live_map = {s["name"]: s for s in live}
    merged = []
    for srv in configured:
        info = live_map.get(srv["name"], {})
        if not srv.get("enabled", True):
            live_status = "disabled"
        else:
            live_status = info.get("status", "unknown")
        merged.append({
            **srv,
            "status": live_status,
            "tool_count": info.get("tool_count", 0),
            "tools": info.get("tools", []),
            # Why it is still starting or why it failed (mcp_manager.list_status).
            **{key: info[key] for key in _MCP_LIVE_DETAIL if key in info},
        })
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "servers": merged,
                "path": str(app.mcp_settings_store.path),
                "revision": revision,
                "native": [server.as_dict() for server in native],
                "agents": native_mcp.agent_targets(),
            },
        )
    )


@handler("mcp.save_servers")
async def mcp_save_servers(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    servers_raw = payload.get("servers", [])
    expected_raw = payload.get("expected_revision")
    if expected_raw is None:
        expected_revision = None
    elif isinstance(expected_raw, (str, int)) and not isinstance(expected_raw, bool):
        try:
            expected_revision = int(expected_raw)
        except ValueError:
            expected_revision = None
    else:
        expected_revision = None
    if expected_raw is not None and expected_revision is None:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "MCP_VALIDATION_ERROR",
                "expected_revision must be an integer revision string",
                {"field": "expected_revision"},
            )
        )
        return
    try:
        servers = app.mcp_settings_store.replace_servers(
            servers_raw,
            expected_revision=expected_revision,
        )
    except MCPSettingsConflictError as err:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "MCP_SETTINGS_CONFLICT",
                str(err),
                {
                    "expected_revision": str(err.expected_revision),
                    "actual_revision": str(err.actual_revision),
                    "path": str(app.mcp_settings_store.path),
                },
            )
        )
        return
    except ValidationError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "MCP_VALIDATION_ERROR", str(err))
        )
        return
    except MCPSettingsError as err:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "MCP_SETTINGS_INVALID",
                str(err),
                {"path": str(app.mcp_settings_store.path)},
            )
        )
        return
    await app.mcp_manager.reload(app.mcp_settings_store.path)
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "ok": True,
                "servers": servers,
                "revision": str(app.mcp_settings_store.revision),
            },
        )
    )
    server_link.sync_soon("mcp")


# ── Managed Skills (skills.*) ────────────────────────────────────────────────
async def _run_skill_operation(
    session: "Session",
    msg_id: str,
    msg_type: str,
    operation: Callable[..., dict[str, Any]],
    *args: Any,
    name: str = "",
    expected_revision: Any = None,
    kwargs: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    try:
        result = await asyncio.to_thread(operation, *args, **(kwargs or {}))
        if msg_type in {
            "skills.create", "skills.save", "skills.set_enabled", "skills.set_targets",
            "skills.set_native_targets", "skills.migrate_native", "skills.restore_native",
            "skills.delete",
        }:
            await notify_skills_changed(name, msg_type.removeprefix("skills."))
            server_link.sync_soon("skills")
        return result
    except SkillNotFoundError as err:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "SKILL_NOT_FOUND",
                str(err),
                {"name": name},
            )
        )
    except SkillConflictError as err:
        from . import app

        details = {"name": name, "expected_revision": expected_revision}
        try:
            current = await asyncio.to_thread(app.skills_store.get_skill, name)
            details["actual_revision"] = current["skill"]["revision"]
        except SkillsStoreError:
            pass
        await session.send_json(
            make_error(msg_id, msg_type, "SKILL_CONFLICT", str(err), details)
        )
    except SkillConsentRequired as err:
        # Not a failure: the UI asks the user, then retries with consent=True.
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "SKILL_CONSENT_REQUIRED",
                str(err),
                {"root": err.root},
            )
        )
    except SkillValidationError as err:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "SKILL_VALIDATION_ERROR",
                str(err),
                {"name": name},
            )
        )
    except SkillsStoreError as err:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "SKILLS_STORE_ERROR",
                str(err),
                {"name": name},
            )
        )
    return None


@handler("skills.list")
async def skills_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    from .sync_scopes import annotate_content_sync

    def list_skills() -> dict[str, Any]:
        return annotate_content_sync(app.skills_store.list_skills(), app.skills_store)

    result = await _run_skill_operation(session, msg_id, msg_type, list_skills)
    if result is not None:
        await session.send_json(make_response(msg_id, msg_type, result))


@handler("skills.get")
async def skills_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    name = payload.get("name", "")
    result = await _run_skill_operation(
        session, msg_id, msg_type, app.skills_store.get_skill, name, name=name
    )
    if result is not None:
        await session.send_json(make_response(msg_id, msg_type, result))


@handler("skills.create")
async def skills_create(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    name = payload.get("name", "")
    result = await _run_skill_operation(
        session,
        msg_id,
        msg_type,
        app.skills_store.create_skill,
        name,
        payload.get("description", ""),
        name=name,
        kwargs={"consent": payload.get("consent") is True},
    )
    if result is not None:
        await session.send_json(make_response(msg_id, msg_type, result))


@handler("skills.save")
async def skills_save(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    name = payload.get("name", "")
    expected_revision = payload.get("expected_revision")
    result = await _run_skill_operation(
        session,
        msg_id,
        msg_type,
        app.skills_store.save_skill,
        name,
        payload.get("fields", {}),
        payload.get("body", ""),
        expected_revision,
        name=name,
        expected_revision=expected_revision,
    )
    if result is not None:
        await session.send_json(make_response(msg_id, msg_type, result))


@handler("skills.set_enabled")
async def skills_set_enabled(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    from . import app

    name = payload.get("name", "")
    result = await _run_skill_operation(
        session,
        msg_id,
        msg_type,
        app.skills_store.set_enabled,
        name,
        payload.get("enabled"),
        name=name,
    )
    if result is not None:
        await session.send_json(make_response(msg_id, msg_type, result))


@handler("skills.set_targets")
async def skills_set_targets(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Restrict one skill to a set of agents; a null ``agents`` means all."""
    from . import app

    name = payload.get("name", "")
    agents = payload.get("agents")
    result = await _run_skill_operation(
        session,
        msg_id,
        msg_type,
        app.skills_store.set_targets,
        name,
        agents,
        name=name,
    )
    if result is not None:
        await session.send_json(make_response(msg_id, msg_type, result))


def _set_native_targets_op(store: Any, real_path: str, agents: Any) -> dict[str, Any]:
    store.set_native_targets(real_path, agents)
    return {"ok": True}


@handler("skills.set_native_targets")
async def skills_set_native_targets(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Deliver a CLI's own skill to other agents; keyed by real path, opt-in."""
    from . import app

    real_path = payload.get("real_path", "")
    agents = payload.get("agents")
    result = await _run_skill_operation(
        session,
        msg_id,
        msg_type,
        _set_native_targets_op,
        app.skills_store,
        real_path,
        agents,
        name=Path(real_path).name,
    )
    if result is not None:
        await session.send_json(make_response(msg_id, msg_type, result))


@handler("skills.migrate_native")
async def skills_migrate_native(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Move a CLI's own skill into ~/.agents/skills, leaving a link behind.

    Consent is per item and never remembered: it must arrive on every call."""
    from . import app

    real_path = payload.get("real_path", "")
    result = await _run_skill_operation(
        session,
        msg_id,
        msg_type,
        app.skills_store.migrate_native,
        real_path,
        name=Path(real_path).name,
        kwargs={"consent": payload.get("consent") is True},
    )
    if result is not None:
        await session.send_json(make_response(msg_id, msg_type, result))


@handler("skills.restore_native")
async def skills_restore_native(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Undo a migration: the skill goes back where it came from."""
    from . import app

    name = payload.get("name", "")
    result = await _run_skill_operation(
        session, msg_id, msg_type, app.skills_store.restore_native, name, name=name
    )
    if result is not None:
        await session.send_json(make_response(msg_id, msg_type, result))


@handler("skills.delete")
async def skills_delete(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    name = payload.get("name", "")
    result = await _run_skill_operation(
        session, msg_id, msg_type, app.skills_store.delete_skill, name, name=name
    )
    if result is not None:
        await session.send_json(make_response(msg_id, msg_type, result))


@handler("skills.install_approvals.list")
async def skills_install_approvals_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from .skills_approvals import public, registry

    approvals = [public(record) for record in registry.pending()]
    await session.send_json(make_response(msg_id, msg_type, {"approvals": approvals}))


@handler("skills.install_approval.decide")
async def skills_install_approval_decide(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from .plugins.builtin.navide_skills.skills_tools import _installer
    from .skills_approvals import SkillApprovalError, decide

    approval_id = str(payload.get("approval_id") or "")
    approve = payload.get("approve") is True
    # MCP and the plugin broker hold this socket too; only a window can mint the
    # confirmation, so an agent cannot approve its own request.
    subject = f"{approval_id}:{'approve' if approve else 'reject'}"
    if not await _confirmed(session, msg_id, msg_type, payload, subject=subject):
        return
    try:
        approval = await decide(approval_id, approve, _installer())
    except SkillApprovalError as err:
        await session.send_json(make_error(msg_id, msg_type, err.code, str(err), {"approval_id": approval_id}))
        return
    await session.send_json(make_response(msg_id, msg_type, {"approval": approval}))


@handler("plugins.agent_request.decide")
async def plugins_agent_request_decide(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """The user's decision on an agent's plugin request (contract section 6).

    Only the main window can mint the confirmation, bound to this approval_id
    and to the decision, so an agent cannot approve its own request and a
    reject confirmation cannot be spent as an approval; no other field grants
    anything.
    """
    from .skills_approvals import SkillApprovalError, decide_plugin

    approval_id = str(payload.get("approval_id") or "")
    approve = payload.get("approve") is True
    subject = f"{approval_id}:{'approve' if approve else 'reject'}"
    if not await _confirmed(
        session, msg_id, msg_type, {"confirm": payload.get("confirmation")}, subject=subject
    ):
        return
    from . import app

    try:
        approval = await decide_plugin(
            approval_id, approve, window_id=session.window_id if app.is_main_window(session) else "",
        )
    except SkillApprovalError as err:
        await session.send_json(make_error(msg_id, msg_type, err.code, str(err), {"approval_id": approval_id}))
        return
    _audit_user_decision(approval, "decide-approve" if approve else "decide-reject")
    await session.send_json(make_response(msg_id, msg_type, {"approval": approval}))


def _audit_user_decision(approval: dict, action: str, error_code: str = "") -> None:
    """A person's decision or result on a plugin request, in plugin_agent_actions (B2-c)."""
    from . import app

    target = approval.get("target") if isinstance(approval.get("target"), dict) else {}
    app.plugin_audit_log.record_agent_action(
        plugin_id=str(target.get("id") or ""), plugin_version=str(target.get("version") or ""),
        action=action, caller_kind="user", approval_id=str(approval.get("approval_id") or ""),
        outcome="allowed" if not error_code else "error", error_code=error_code,
    )


@handler("plugins.agent_requests.list")
async def plugins_agent_requests_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """The plugin requests still open (pending and applying), e.g. to recover after a window restart.

    Main windows only: a record names the requester's pane and workspace.
    ``applyingInLiveWindow`` lists the applying requests a connected main
    window approved and is still carrying out; recovery leaves those alone.
    """
    from . import app
    from .skills_approvals import registry

    if not app.is_main_window(session):
        await session.send_json(make_error(msg_id, msg_type, "FORBIDDEN", "only a Navide main window may list plugin requests"))
        return
    requests = registry.plugin_requests()
    live = app.live_main_window_ids()
    in_live_window = [
        r["approval_id"] for r in requests
        if r["status"] == "applying" and registry.applying_by(r["approval_id"]) in live
    ]
    await session.send_json(make_response(msg_id, msg_type, {"requests": requests, "applyingInLiveWindow": in_live_window}))


@handler("plugins.agent_request.finish")
async def plugins_agent_request_finish(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """The window carried out an approved plugin request: applying -> completed | failed.

    Only a window can mint the confirmation, bound to the approval_id and the
    status (``<approval_id>:completed|failed``), so an agent cannot report a
    change that never happened and a "failed" confirmation cannot report success.
    """
    from . import app
    from .ipc import make_event
    from .plugins import agent_tools_contract as contract
    from .skills_approvals import SkillApprovalError, registry

    approval_id = str(payload.get("approval_id") or "")
    status = payload.get("status")
    error = payload.get("error")
    if status not in {"completed", "failed"} or (error is not None and not isinstance(error, str)):
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", "status must be completed or failed"))
        return
    if not await _confirmed(
        session, msg_id, msg_type, {"confirm": payload.get("confirmation")}, subject=f"{approval_id}:{status}"
    ):
        return
    try:
        approval = registry.finish_plugin(
            approval_id, status, error=error if status == "failed" else None,
            window_id=session.window_id if app.is_main_window(session) else "",
        )
    except SkillApprovalError as err:
        await session.send_json(make_error(msg_id, msg_type, err.code, str(err), {"approval_id": approval_id}))
        return
    late = approval.get("finished_late") is True
    _audit_user_decision(
        approval, f"finish-late-{status}" if late else f"finish-{status}",
        "" if status == "completed" else ("INTERRUPTED" if error == "interrupted" else "ACTION_FAILED"),
    )
    resolved = {"approval_id": approval_id, "status": approval["status"], "error": approval["error"]}
    if late:
        resolved.update(finished_late=True, settled=approval.get("settled"))
    await app.broadcast(make_event(contract.PLUGIN_APPROVAL_RESOLVED_EVENT, resolved))
    await session.send_json(make_response(msg_id, msg_type, {"approval": approval}))


# ── CLI instruction files (memory.*) ────────────────────────────────────────
def _memory_workspace(payload: dict) -> Path | None:
    """The workspace root a memory request is scoped to, or None.

    Project-scoped instruction files belong to the folder the user has open,
    so every memory handler takes the workspace from the caller. An absent or
    non-directory path yields None, which limits the request to user scope
    rather than failing it — a window with no workspace still has a home.
    """
    raw = str(payload.get("workspace_path") or "").strip()
    if not raw:
        return None
    path = Path(raw).expanduser()
    return path if path.is_dir() else None


@handler("memory.list")
async def memory_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    workspace = _memory_workspace(payload)
    # The scan stats every candidate in the home and the workspace; a thread
    # keeps that file I/O off the loop, as the native MCP scan does.
    files = await asyncio.to_thread(native_memory.scan, None, workspace)
    # Shown even before Claude has written anything, so the page can say where
    # its notes for this project will appear.
    memory_dir = await asyncio.to_thread(native_memory.auto_memory_dir, None, workspace)
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "files": [f.as_dict() for f in files],
                "agents": native_memory.agent_targets(),
                "workspace_path": str(workspace) if workspace else "",
                "auto_memory_dir": str(memory_dir) if memory_dir else "",
            },
        )
    )


@handler("memory.get")
async def memory_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    workspace = _memory_workspace(payload)
    path = str(payload.get("path") or "")
    try:
        result = await asyncio.to_thread(native_memory.read, path, None, workspace)
    except ValueError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "MEMORY_FILE_REJECTED", str(err), {"path": path})
        )
        return
    except OSError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "MEMORY_READ_FAILED", str(err), {"path": path})
        )
        return
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("memory.save")
async def memory_save(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    workspace = _memory_workspace(payload)
    path = str(payload.get("path") or "")
    text = payload.get("text")
    if not isinstance(text, str):
        await session.send_json(
            make_error(msg_id, msg_type, "MEMORY_FILE_REJECTED", "text is required", {"path": path})
        )
        return
    expected_raw = payload.get("expected_modified")
    expected = float(expected_raw) if isinstance(expected_raw, (int, float)) else None
    try:
        result = await asyncio.to_thread(
            native_memory.save, path, text, None, workspace, expected
        )
    except native_memory.MemoryConflictError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "MEMORY_FILE_CONFLICT", str(err), {"path": path})
        )
        return
    except ValueError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "MEMORY_FILE_REJECTED", str(err), {"path": path})
        )
        return
    except OSError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "MEMORY_WRITE_FAILED", str(err), {"path": path})
        )
        return
    await session.send_json(make_response(msg_id, msg_type, result))
    server_link.sync_soon("memory")


@handler("memory.restore")
async def memory_restore(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Write back the version the last save replaced, kept in Navide's data dir."""
    workspace = _memory_workspace(payload)
    path = str(payload.get("path") or "")
    expected_raw = payload.get("expected_modified")
    expected = float(expected_raw) if isinstance(expected_raw, (int, float)) else None
    try:
        result = await asyncio.to_thread(
            native_memory.restore_previous, path, None, workspace, expected
        )
    except native_memory.MemoryConflictError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "MEMORY_FILE_CONFLICT", str(err), {"path": path})
        )
        return
    except ValueError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "MEMORY_FILE_REJECTED", str(err), {"path": path})
        )
        return
    except OSError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "MEMORY_WRITE_FAILED", str(err), {"path": path})
        )
        return
    await session.send_json(make_response(msg_id, msg_type, result))


# ── Cross-device sync (sync.*) ──────────────────────────────────────────────
#
# The engine lives on the server link, because a round is a conversation with
# the server; these handlers are the Settings pane's view of it. Everything
# here answers rather than raises when the link is down — a pane that cannot
# say "off and not connected" apart from "broken" is a pane that makes people
# re-enter credentials that were never wrong.
@handler("sync.status")
async def sync_status(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app, sync_engine, sync_keyring, sync_scopes

    scopes = await asyncio.to_thread(sync_scopes.enabled_scopes)
    # Reading the key touches the Keychain, which can block on a dialog.
    has_key, key_id, legacy_pending = await asyncio.to_thread(_sync_key_facts)
    conflicts = await asyncio.to_thread(app.sync_store.conflicts, None)
    link = await server_link.status()
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "available": list(sync_engine.SCOPES),
                "scopes": scopes,
                # Scopes no round ever syncs, whatever their switch above says.
                "neverSynced": sorted(sync_scopes.NEVER_SYNCED),
                "hasKey": has_key,
                # The active key's id (never the key) so a person can see a
                # rotation took, and whether a ring from before accounts were
                # bound is waiting for someone to say whose it is.
                "keyId": key_id,
                "legacyRingPending": legacy_pending,
                "conflicts": len(conflicts),
                "link": link,
                # Each scope's last round, the same payload ``sync.result``
                # carries, so a pane opened after the round still sees it.
                "last": server_link.sync_last_results(),
                # Which account these scopes sync with — said beside them,
                # because switching accounts switches them all off.
                "account": {
                    "email": str(link.get("accountEmail") or ""),
                    "memberId": str(link.get("memberId") or ""),
                },
            },
        )
    )


def _sync_key_facts() -> tuple[bool, str, bool]:
    from . import sync_keyring

    has_key = sync_keyring.has_account_key()
    key_id = (sync_keyring.active_key_id() or "") if has_key else ""
    try:
        legacy = bool(sync_keyring.legacy_ring_pending())
    except Exception:  # noqa: BLE001 - an unreadable vault is "nothing pending"
        legacy = False
    return has_key, key_id, legacy


@handler("sync.adopt_legacy_key")
async def sync_adopt_legacy_key(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """The person says the ring from before accounts were bound is this
    account's. Explicit, once, never inferred: the module cannot tell whose
    it was, and minting a fresh key instead would leave everything that ring
    wrote unreadable."""
    from . import sync_keyring

    try:
        await asyncio.to_thread(sync_keyring.adopt_legacy_ring)
    except sync_keyring.KeyringError as err:
        await session.send_json(make_error(msg_id, msg_type, "SYNC_KEY_REFUSED", str(err)))
        return
    try:
        results = await server_link.sync_now()
    except Exception as err:  # noqa: BLE001 - the key is adopted either way
        results = [{"scope": "all", "error": str(err)}]
    await session.send_json(make_response(msg_id, msg_type, {"results": results}))


@handler("sync.rotate_key")
async def sync_rotate_key(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Retire the active sync key and re-seal every record under a new one.

    The old keys stay readable, so nothing already on the server goes dark;
    the round that follows pushes each unchanged item again under the new
    key (the engine notices the key id changed). Paired devices receive the
    new ring over the same signed channel that handed them the first one,
    and until then write under the old key — which this device reads fine.
    """
    from . import sync_keyring

    try:
        key_id = await asyncio.to_thread(sync_keyring.rotate_account_key)
    except sync_keyring.KeyringError as err:
        await session.send_json(make_error(msg_id, msg_type, "SYNC_KEY_REFUSED", str(err)))
        return
    # Distribution is part of the rotation, not an extra: a reply that said
    # "rotated" while every other device still wrote under the old key would
    # be the leak continuing under a new name. So it is called by name, and
    # its failure is reported in the reply rather than swallowed.
    try:
        offered: Any = await server_link.offer_sync_key_to_peers()
    except Exception as err:  # noqa: BLE001 - said in the reply, see above
        offered = {"error": str(err)}
    try:
        results = await server_link.sync_now()
    except Exception as err:  # noqa: BLE001 - the key is rotated either way
        results = [{"scope": "all", "error": str(err)}]
    await session.send_json(
        make_response(msg_id, msg_type, {"keyId": key_id, "results": results, "offered": offered})
    )


@handler("sync.set_scope")
async def sync_set_scope(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app, sync_engine, sync_scopes

    scope = str(payload.get("scope") or "")
    enabled = bool(payload.get("enabled"))
    if scope not in sync_engine.SCOPES:
        await session.send_json(
            make_error(msg_id, msg_type, "SYNC_UNKNOWN_SCOPE", f"unknown scope {scope!r}")
        )
        return
    try:
        scopes = await asyncio.to_thread(sync_scopes.set_scope_enabled, scope, enabled)
    except sync_engine.SyncError as err:
        # A scope may refuse to be switched on (credentials, while a paired
        # device predates encryption-key pinning); the reason is the message.
        await session.send_json(make_error(msg_id, msg_type, "SYNC_SCOPE_REFUSED", str(err)))
        return
    await session.send_json(make_response(msg_id, msg_type, {"scopes": scopes}))
    # The settings store returns the delta but does not announce it; the
    # renderer's cloud views listen for this key to drop what they show, so
    # a successful change is broadcast here (a refused one above is not).
    await app.broadcast(
        make_event("ui.settings_changed", {"settings": {sync_scopes.SCOPES_SETTING: scopes}})
    )
    if enabled:
        # Turning a section on is a request to be up to date, not just a flag.
        asyncio.create_task(_sync_after_enable(scope))


async def _sync_after_enable(scope: str) -> None:
    try:
        await server_link.sync_now(scope)
    except Exception as err:  # noqa: BLE001 - the flag is saved either way
        app_log().warning("the first sync of %s did not run: %s", scope, err)


def app_log():
    from . import app

    return app.log


@handler("sync.now")
async def sync_now(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    scope = str(payload.get("scope") or "")
    try:
        results = await server_link.sync_now(scope)
    except Exception as err:  # noqa: BLE001 - report, never tear down the session
        await session.send_json(make_error(msg_id, msg_type, "SYNC_FAILED", str(err)))
        return
    await session.send_json(make_response(msg_id, msg_type, {"results": results}))


@handler("sync.conflicts")
async def sync_conflicts(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    scope = str(payload.get("scope") or "")
    rows = await asyncio.to_thread(server_link.sync_conflicts, scope)
    await session.send_json(make_response(msg_id, msg_type, {"conflicts": rows}))


@handler("sync.approvals")
async def sync_approvals_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Synced skills and MCP servers waiting for approval (decision D1), and
    the scopes whose queue is full (new records there are being refused)."""
    from . import sync_approvals

    rows = await asyncio.to_thread(server_link.sync_approvals)
    full = await asyncio.to_thread(sync_approvals.full_scopes)
    await session.send_json(make_response(msg_id, msg_type, {"approvals": rows, "full": full}))


@handler("sync.approval.detail")
async def sync_approval_detail(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """One held record whole, for a card the listing sent collapsed."""
    from . import sync_approvals

    scope = str(payload.get("scope") or "")
    item_id = str(payload.get("itemId") or "")
    try:
        row = await asyncio.to_thread(sync_approvals.detail, scope, item_id)
    except Exception as err:  # noqa: BLE001 - a hold that went away is a normal race
        await session.send_json(make_error(msg_id, msg_type, "SYNC_APPROVAL_FAILED", str(err)))
        return
    await session.send_json(make_response(msg_id, msg_type, {"approval": row}))


@handler("sync.approval.decide")
async def sync_approval_decide(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    scope = str(payload.get("scope") or "")
    item_id = str(payload.get("itemId") or "")
    approve = payload.get("approve")
    shown = str(payload.get("digest") or "")
    if not isinstance(approve, bool) or not shown:
        await session.send_json(
            make_error(msg_id, msg_type, "SYNC_BAD_CHOICE", "approve must be true or false, with the digest shown")
        )
        return
    try:
        result = await asyncio.to_thread(server_link.decide_sync_approval, scope, item_id, approve, shown)
    except Exception as err:  # noqa: BLE001 - a hold that went away is a normal race
        await session.send_json(make_error(msg_id, msg_type, "SYNC_APPROVAL_FAILED", str(err)))
        return
    rows = await asyncio.to_thread(server_link.sync_approvals)
    await session.send_json(make_response(msg_id, msg_type, {"approval": result, "approvals": rows}))


@handler("sync.secret_warnings")
async def sync_secret_warnings(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Items that look like they carry a secret, before they sync (decision
    D2): a warning, never a block. Names where, never what."""
    from . import sync_scopes

    rows = await asyncio.to_thread(sync_scopes.secret_warnings)
    await session.send_json(make_response(msg_id, msg_type, {"warnings": rows}))


@handler("sync.secret_warning.dismiss")
async def sync_secret_warning_dismiss(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import sync_scopes

    scope = str(payload.get("scope") or "")
    item_id = str(payload.get("itemId") or "")
    await asyncio.to_thread(sync_scopes.dismiss_secret_warning, scope, item_id)
    rows = await asyncio.to_thread(sync_scopes.secret_warnings)
    await session.send_json(make_response(msg_id, msg_type, {"warnings": rows}))


@handler("sync.resolve")
async def sync_resolve(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import sync_engine

    scope = str(payload.get("scope") or "")
    item_id = str(payload.get("itemId") or "")
    keep = str(payload.get("keep") or "")
    if keep not in (sync_engine.KEEP_LOCAL, sync_engine.KEEP_REMOTE):
        await session.send_json(
            make_error(msg_id, msg_type, "SYNC_BAD_CHOICE", "keep must be 'local' or 'remote'")
        )
        return
    try:
        await asyncio.to_thread(server_link.resolve_sync_conflict, scope, item_id, keep)
    except Exception as err:  # noqa: BLE001 - a stale conflict is a normal race
        await session.send_json(make_error(msg_id, msg_type, "SYNC_RESOLVE_FAILED", str(err)))
        return
    rows = await asyncio.to_thread(server_link.sync_conflicts, "")
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "conflicts": rows}))


@handler("sync.inventory")
async def sync_inventory(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """The local/cloud comparison, for one scope or all four. Writes nothing.

    Answers for a scope that is switched off too: somebody deciding whether to
    turn one on wants to see what turning it on would bring down, and looking
    is the one thing this cannot be dangerous for. ``scopeEnabled`` says which
    are on, so the pane can show it without inferring it from an empty list.
    """
    scope = str(payload.get("scope") or "")
    try:
        result = await server_link.sync_inventory(scope)
    except Exception as err:  # noqa: BLE001 - report, never tear down the session
        await session.send_json(make_error(msg_id, msg_type, "SYNC_INVENTORY_FAILED", str(err)))
        return
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("sync.push_items")
async def sync_push_items(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    item_ids = _sync_item_ids(payload)
    scope = str(payload.get("scope") or "")
    if not await _sync_selection_ok(session, msg_id, msg_type, scope, item_ids):
        return
    try:
        results = await server_link.sync_push_items(scope, item_ids)
    except Exception as err:  # noqa: BLE001 - a link that went down is not a crash
        await session.send_json(make_error(msg_id, msg_type, "SYNC_PUSH_FAILED", str(err)))
        return
    await session.send_json(make_response(msg_id, msg_type, {"scope": scope, "results": results}))


@handler("sync.pull_items")
async def sync_pull_items(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    item_ids = _sync_item_ids(payload)
    scope = str(payload.get("scope") or "")
    if not await _sync_selection_ok(session, msg_id, msg_type, scope, item_ids):
        return
    try:
        results = await server_link.sync_pull_items(scope, item_ids)
    except Exception as err:  # noqa: BLE001 - same reason as the push above
        await session.send_json(make_error(msg_id, msg_type, "SYNC_PULL_FAILED", str(err)))
        return
    await session.send_json(make_response(msg_id, msg_type, {"scope": scope, "results": results}))


@handler("sync.versions")
async def sync_versions(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    scope = str(payload.get("scope") or "")
    item_id = str(payload.get("itemId") or "")
    if not scope or not item_id:
        await session.send_json(make_error(msg_id, msg_type, "SYNC_BAD_CHOICE", "scope and itemId are required"))
        return
    try:
        versions = await server_link.sync_versions(scope, item_id)
    except Exception as err:  # noqa: BLE001 - a link that went down is not a crash
        await session.send_json(make_error(msg_id, msg_type, "SYNC_VERSIONS_FAILED", str(err)))
        return
    await session.send_json(
        make_response(msg_id, msg_type, {"scope": scope, "itemId": item_id, "versions": versions})
    )


@handler("sync.restore_version")
async def sync_restore_version(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    scope = str(payload.get("scope") or "")
    item_id = str(payload.get("itemId") or "")
    rev = payload.get("rev")
    if not scope or not item_id or not isinstance(rev, int) or isinstance(rev, bool) or rev < 1:
        await session.send_json(
            make_error(msg_id, msg_type, "SYNC_BAD_CHOICE", "scope, itemId and a positive rev are required")
        )
        return
    try:
        result = await server_link.sync_restore_version(scope, item_id, rev)
    except Exception as err:  # noqa: BLE001 - same reason as the listing above
        await session.send_json(make_error(msg_id, msg_type, "SYNC_RESTORE_FAILED", str(err)))
        return
    await session.send_json(make_response(msg_id, msg_type, result))


def _sync_item_ids(payload: dict) -> list[str]:
    raw = payload.get("itemIds")
    return [str(i) for i in raw if isinstance(i, str) and i] if isinstance(raw, list) else []


async def _sync_selection_ok(
    session: "Session", msg_id: str, msg_type: str, scope: str, item_ids: list[str]
) -> bool:
    """Refuse a selective move that names nothing, or names an invented scope.

    An empty selection is a caller bug rather than a request to move
    everything: ``sync.now`` is how "all of it" is asked for, and reading a
    missing list as "all" would make a UI that failed to collect a tick box
    upload the whole scope.
    """
    from . import sync_approvals, sync_engine

    if scope not in sync_engine.SCOPES:
        await session.send_json(
            make_error(msg_id, msg_type, "SYNC_UNKNOWN_SCOPE", f"unknown scope {scope!r}")
        )
        return False
    if scope in sync_approvals.RETIRED_SCOPES:
        await session.send_json(
            make_error(msg_id, msg_type, "SYNC_SCOPE_RETIRED", str(sync_approvals.RetiredScopeError(scope)))
        )
        return False
    if not item_ids:
        await session.send_json(
            make_error(msg_id, msg_type, "SYNC_NO_ITEMS", "itemIds must name at least one item")
        )
        return False
    return True


# ── Recent workspaces (workspace.*) ─────────────────────────────────────────
def _live_pane_workspaces_for_recent() -> list[str]:
    """Workspaces with a live CLI pane — open somewhere, so never trimmed."""
    from . import app

    try:
        terminals = app.get_terminals()
        sessions = list(getattr(terminals, "_sessions", {}).values())
    except Exception:  # noqa: BLE001 — protection is best-effort, never fatal
        return []
    out: list[str] = []
    for s in sessions:
        try:
            if s.closed:
                continue
            meta = s.metadata if isinstance(s.metadata, dict) else {}
            out.append(str(meta.get("workspace_path") or s.cwd))
        except AttributeError:
            continue
    return out


def _recent_payload() -> dict:
    """The Recent list plus its safety bound, as every workspace.* reply sends it."""
    from . import app

    store = app.recent_workspaces_store
    return {"recent": store.list(), **store.info()}


@handler("workspace.list_recent")
async def workspace_list_recent(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # list() reads the JSON file and os.path.isdir()s every recent path; a stale
    # or slow path would block the event loop. Offload it like the other fs
    # handlers so it can't stall other requests.
    payload = await asyncio.to_thread(_recent_payload)
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                **payload,
                "path": str(app.recent_workspaces_store.path),
            },
        )
    )


@handler("workspace.touch")
async def workspace_touch(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # Workspaces open in the asking window (its own list, which knows
    # pane-less ones) and anywhere a CLI pane runs are never trimmed.
    open_paths = [p for p in payload.get("open") or [] if isinstance(p, str)]
    app.recent_workspaces_store.touch(
        payload["path"],
        state=payload.get("state", ""),
        task=payload.get("task", ""),
        keep=[*open_paths, *_live_pane_workspaces_for_recent()],
    )
    # Re-seed the display-name mirror from the project document, which is the
    # truth for it. The entry this touch just created — a workspace dropped
    # from the recent list and then reopened — carries only the folder
    # basename, so without this the alias the project document still holds
    # would be gone from every recent list until the next rename.
    #
    # Unconditional, in BOTH directions: an alias cleared in the project
    # document has to push the basename back over a mirror still holding the
    # old one, or "truth" would only mean truth while it is non-empty
    # (set_name("") does the basename fallback itself).
    #
    # peek() (never load_or_create) — touching a recent entry must not create
    # files inside the workspace. Offloaded for the same reason as
    # list_recent above: peek opens a sqlite connection, and on a workspace
    # with a legacy project.json it also WRITES (the one-time import), neither
    # of which belongs on the event loop.
    def _reseed_display_name_mirror() -> None:
        project = app.project_store.peek(payload["path"])
        if project is not None:
            app.recent_workspaces_store.set_name(payload["path"], project.display_name)

    await asyncio.to_thread(_reseed_display_name_mirror)
    data = _recent_payload()
    await session.send_json(
        make_response(msg_id, msg_type, data)
    )
    await app.broadcast(
        make_event("workspace.recent_changed", {**data, "reason": "touch"})
    )


@handler("workspace.set_recent_limit")
async def workspace_set_recent_limit(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    try:
        app.recent_workspaces_store.set_limit(
            payload.get("limit"), keep=_live_pane_workspaces_for_recent()
        )
    except ValueError as err:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", str(err)))
        return
    data = _recent_payload()
    await session.send_json(make_response(msg_id, msg_type, data))
    await app.broadcast(
        make_event("workspace.recent_changed", {**data, "reason": "limit"})
    )


@handler("workspace.pin")
async def workspace_pin(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    app.recent_workspaces_store.pin(payload["path"])
    recent = app.recent_workspaces_store.list()
    await session.send_json(
        make_response(msg_id, msg_type, {"recent": recent})
    )
    await app.broadcast(
        make_event("workspace.recent_changed", {"recent": recent, "reason": "pin"})
    )


@handler("workspace.unpin")
async def workspace_unpin(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    app.recent_workspaces_store.unpin(payload["path"])
    recent = app.recent_workspaces_store.list()
    await session.send_json(
        make_response(msg_id, msg_type, {"recent": recent})
    )
    await app.broadcast(
        make_event("workspace.recent_changed", {"recent": recent, "reason": "unpin"})
    )


@handler("workspace.remove")
async def workspace_remove(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    app.recent_workspaces_store.remove(payload["path"])
    recent = app.recent_workspaces_store.list()
    await session.send_json(
        make_response(msg_id, msg_type, {"recent": recent})
    )
    await app.broadcast(
        make_event("workspace.recent_changed", {"recent": recent, "reason": "remove"})
    )


# ── UI settings (generic KV store, localStorage replacement) ────────────────
@handler("ui.settings.get")
async def ui_settings_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    await session.send_json(
        make_response(msg_id, msg_type, {"settings": app.ui_settings_store.get()})
    )


async def _reinstall_claude_hooks() -> None:
    """Re-run claude's hook installer after its push-channel switch moved.

    Claude's channel is not something Navide holds — it is an entry in the
    user's own settings file, written by the installer, which otherwise runs
    only at startup. Without this the entry would appear or disappear a backend
    restart late, and switching the channel back on would promise a waiter that
    has no hook to come from. Same call the startup installer makes; the
    installer itself decides whether the rewake entry belongs, so both
    directions are this one call.

    A pane already running fired up with whatever the file said then, so this
    reaches the next CLI start, not the panes open now. Failure is logged and
    swallowed: the setting was already written, and the old behaviour — the
    hook settling at the next restart — is what a failure falls back to.
    """
    from . import app
    from .applog import backend_port_file

    spec = CLI_VENDORS.get("claude")
    if spec is None or spec.install_hooks is None:
        return
    from . import convenience_wiring

    try:
        result = await asyncio.to_thread(
            convenience_wiring.install_hooks_gated, "claude", spec.install_hooks, str(backend_port_file())
        )
        app.log.info("claude hooks reinstalled after a push-channel switch: %s", result)
    except Exception as err:  # noqa: BLE001
        app.log.warning("claude hooks reinstall failed: %s", err)


#: UI settings only the backend writes: sync's own bookkeeping (detached
#: marks, dismissed secret warnings, and the key an earlier build kept sync
#: approvals under). A window writing them could hide items from sync or
#: approve what the user never saw, so ui.settings.set drops them.
UI_SETTINGS_BACKEND_ONLY_KEYS = frozenset({"sync-detached", "sync-secret-dismissed", "sync-approvals"})


@handler("ui.settings.set")
async def ui_settings_set(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    from . import push_delivery

    updates = payload.get("updates")
    if isinstance(updates, dict) and UI_SETTINGS_BACKEND_ONLY_KEYS & set(updates):
        log.warning(
            "ui.settings.set: ignoring backend-only keys %s",
            sorted(UI_SETTINGS_BACKEND_ONLY_KEYS & set(updates)),
        )
        updates = {k: v for k, v in updates.items() if k not in UI_SETTINGS_BACKEND_ONLY_KEYS}
    touches_channels = (
        isinstance(updates, dict) and push_delivery.DISABLED_SETTING_KEY in updates
    )
    claude_was_off = (
        "claude" in push_delivery.disabled_agents() if touches_channels else False
    )
    delta = app.ui_settings_store.set(updates) if isinstance(updates, dict) else {}
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))
    from . import sync_scopes

    if sync_scopes.PROMPT_SKILLS_KEY in delta or sync_scopes.LOOP_PROMPT_KEY in delta:
        # The prompt list is saved as a setting; nothing else tells sync.
        server_link.sync_soon("prompts")
    if push_delivery.DISABLED_SETTING_KEY in delta:
        # A pane already running keeps its port and its watch file; what changes
        # is whether anything is pushed to it. Both directions are announced —
        # a window told to stop offering a channel would otherwise never start
        # again when the switch goes back on.
        for pane_id, kind, ready in push_delivery.apply_switches():
            await app.broadcast(make_event("agent_msg.push_state", {
                "pane_id": pane_id, "kind": kind, "ready": ready,
            }))
        if ("claude" in push_delivery.disabled_agents()) != claude_was_off:
            await _reinstall_claude_hooks()
    if delta:
        # Other windows (EditorWindow, roles/stages) hold their own ws
        # connections — broadcast the merged delta so their caches
        # converge; the sender already applied it locally.
        await app.broadcast(
            make_event("ui.settings_changed", {"settings": delta}),
            exclude=session,
        )


# ── Cross-device link (p2p.*) ───────────────────────────────────────────────
# The Navide-Server URL lives in ui_settings and its access token in the
# credential vault, so a settings pane that wrote them through the generic
# handlers would need two round trips in the right order — and would still not
# make the link dial, because server_link.start() only runs at boot. These two
# handlers exist so the whole configuration is one write followed by one
# reconnect, and so the token only ever travels toward the vault.
#: Where the pause switch lives. In ui_settings rather than in the link itself:
#: the link is rebuilt on every reconnect and forgets anything it holds, while
#: this has to survive a restart — a switch that quietly turns itself back on is
#: worse than no switch, because the user believes they are disconnected.
LINK_PAUSED_SETTING = "agentTeam.p2p.linkPaused"


def _link_paused() -> bool:
    from . import app

    return bool(app.ui_settings_store.get().get(LINK_PAUSED_SETTING))


@handler("p2p.link.status")
async def p2p_link_status(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    status = await server_link.status()
    # Reported alongside the link's own state rather than folded into it: paused
    # is a thing the *user* did, and showing it as "unconfigured" or
    # "unreachable" would blame the network for a switch they flipped.
    status["paused"] = _link_paused()
    await session.send_json(make_response(msg_id, msg_type, {"status": status}))


@handler("p2p.link.set_paused")
async def p2p_link_set_paused(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Turn the cross-device link off without forgetting the account.

    Signing out was the only way to stop this machine talking to the server, and
    it throws away the credential — so "I want this off for now" cost the user
    their account on this device. Pausing keeps everything and stops the socket.

    The stop is real: the link is torn down, not merely marked. A switch that
    left the connection open while claiming to be off would be a lie told by the
    one surface whose whole job is telling the truth about the connection.
    """
    from . import app

    paused = bool(payload.get("paused"))
    app.ui_settings_store.set({LINK_PAUSED_SETTING: paused})
    if paused:
        await server_link.stop()
    else:
        await server_link.start()
    status = await server_link.status()
    status["paused"] = paused
    await app.broadcast(make_event("p2p.link.changed", {"status": status}))
    await session.send_json(make_response(msg_id, msg_type, {"status": status}))


@handler("p2p.link.configure")
async def p2p_link_configure(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Store or clear the access token, then reconnect.

    The server address used to be part of this call. It is now built into the
    build (server_link.DEFAULT_SERVER_URL) because there is exactly one service
    to talk to and a typo'd address produced a link that silently never dialled.
    A `serverUrl` sent by an older renderer is accepted and ignored rather than
    rejected, so a stale window cannot fail every save.

    An absent token means "leave it alone" so a caller can reconnect without
    retyping a credential it is never allowed to see; an empty string is not
    absence — it is how the user clears it, which takes the link back to inert.
    """
    from . import app

    token = payload.get("token")
    if token is not None and not isinstance(token, str):
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "token must be a string")
        )
        return

    # An install upgrading from the configurable era still carries the address
    # its user typed. Nothing reads it any more, so drop it rather than leave a
    # value that looks like it is in effect.
    delta = app.ui_settings_store.set({server_link.SERVER_URL_SETTING: None})
    if token is not None:
        try:
            await vault_to_thread(server_link.replace_access_token, token)
        except Exception as err:  # noqa: BLE001
            await session.send_json(
                make_error(msg_id, msg_type, "P2P_TOKEN_WRITE_FAILED", str(err))
            )
            return

    await server_link.reconfigure()
    await session.send_json(
        make_response(msg_id, msg_type, {"status": await server_link.status()})
    )
    if delta:
        await app.broadcast(make_event("ui.settings_changed", {"settings": delta}))


# Account sign-in. Registering creates an account — a private network of this
# user's own machines; logging in exchanges the password
# for the long-lived device token. Both are the same write as p2p.link.configure
# ends in — url to settings, token to the vault, then reconnect — so the user
# never has to see or handle the token at all.
#
# The password is not stored anywhere and is not echoed back. It exists for the
# duration of one request and is exchanged for a token, which is what a
# previously hand-pasted credential already was.
async def _account_call(
    session: "Session", msg_id: str, msg_type: str, payload: dict, verb: str
) -> None:
    from . import app

    email = payload.get("email")
    password = payload.get("password")
    for name, value in (("email", email), ("password", password)):
        if not isinstance(value, str) or not value.strip():
            await session.send_json(
                make_error(msg_id, msg_type, "BAD_REQUEST", f"{name} is required")
            )
            return
    # The address is the build's, not the caller's — see p2p.link.configure.
    url = await asyncio.to_thread(server_link.server_url)

    request: dict = {"email": email.strip(), "password": password}
    if verb == "auth.register":
        # One optional field, not two: auth.register's signature is
        # (email, password, displayName), so a tenantName sent alongside it was
        # being dropped on the floor by the server rather than doing anything.
        for optional in ("displayName",):
            value = payload.get(optional)
            if isinstance(value, str) and value.strip():
                request[optional] = value.strip()

    try:
        result = await server_link.account_request(url, verb, request)
    except server_link.AccountError as err:
        # Keep the server's own code (EMAIL_TAKEN, AUTH_REJECTED, BAD_REQUEST):
        # the UI tells these apart to decide whether to offer "sign in instead"
        # or just let the user retype the password.
        await session.send_json(make_error(msg_id, msg_type, err.code, err.message))
        return
    except Exception as err:  # noqa: BLE001
        # Anything that stopped the call reaching a server is a link problem,
        # not a credential problem — saying "wrong password" for an unreachable
        # host sends the user to change something that was already right.
        await session.send_json(
            make_error(msg_id, msg_type, "LINK_OFFLINE", str(err) or "server unreachable")
        )
        return

    token = result.get("token")
    if not isinstance(token, str) or not token:
        await session.send_json(
            make_error(msg_id, msg_type, "SERVER_ERROR", "server returned no token")
        )
        return

    delta = app.ui_settings_store.set(
        {
            # Only the signed-in identity is stored; the address is built in and
            # any stale user-entered one is cleared on the way past.
            server_link.SERVER_URL_SETTING: None,
            server_link.ACCOUNT_EMAIL_SETTING: str(result.get("email") or email).strip(),
        }
    )
    try:
        await vault_to_thread(server_link.replace_access_token, token)
    except Exception as err:  # noqa: BLE001
        await session.send_json(
            make_error(msg_id, msg_type, "P2P_TOKEN_WRITE_FAILED", str(err))
        )
        return

    await server_link.reconfigure()
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "status": await server_link.status(),
                "account": {
                    "email": result.get("email"),
                    "memberId": result.get("memberId"),
                    "displayName": result.get("displayName"),

                    # Soft gate: a fresh account is unverified and still fully
                    # usable. Carried here as well as in `status` because the
                    # link has only just been told to reconnect — its own
                    # auth.hello answer may not have landed yet, and the modal
                    # has to show the "check your mail" notice now, not in
                    # three seconds.
                    "emailVerified": bool(result.get("emailVerified")),
                    "verificationSent": bool(result.get("verificationSent")),
                },
            },
        )
    )
    if delta:
        await app.broadcast(make_event("ui.settings_changed", {"settings": delta}))


@handler("p2p.account.register")
async def p2p_account_register(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    await _account_call(session, msg_id, msg_type, payload, "auth.register")


@handler("p2p.account.login")
async def p2p_account_login(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    await _account_call(session, msg_id, msg_type, payload, "auth.login")


@handler("p2p.account.check_verification")
async def p2p_account_check_verification(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """"Clicked the link and nothing happened?" — ask the server right now.

    The link learns whether an address is confirmed at ``auth.hello`` and had no
    second read, so somebody who confirmed in their browser watched "we sent you
    a link" until the next restart. A push and a poll both cover that now; this
    is the same question asked on demand, because the wait is otherwise up to
    half a minute of a person staring at a stale sentence.

    Never an error when the answer is simply "still no": the reply carries what
    this machine now believes, and the caller shows it.
    """
    reply = await server_link.check_verification()
    if reply is None:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "P2P_NOT_CONFIGURED",
                "no navide-server is configured, so there is no account to check",
            )
        )
        return
    if not reply.get("ok"):
        error = reply.get("error") if isinstance(reply.get("error"), dict) else {}
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                str(error.get("code") or "P2P_LINK_OFFLINE"),
                str(error.get("message") or "the navide-server link is not available"),
            )
        )
        return
    result = reply.get("payload")
    result = result if isinstance(result, dict) else {}
    await session.send_json(
        make_response(
            msg_id, msg_type, {"emailVerified": bool(result.get("emailVerified"))}
        )
    )


@handler("p2p.account.resend_verification")
async def p2p_account_resend_verification(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Ask the server for a fresh verification mail for the signed-in account.

    Unlike register and login this one rides the existing authenticated link:
    the server decides *which* account from the connection, so there is nothing
    for the caller to name and no way to ask for someone else's mail.

    The server's own codes come straight through — RATE_LIMITED in particular
    means "you already asked in the last minute", which is a thing to show, not
    a thing to retry.
    """
    reply = await server_link.resend_verification()
    if reply is None:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "P2P_NOT_CONFIGURED",
                "no navide-server is configured, so there is no account to verify",
            )
        )
        return
    if not reply.get("ok"):
        error = reply.get("error") if isinstance(reply.get("error"), dict) else {}
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                str(error.get("code") or "P2P_VERIFY_RESEND_FAILED"),
                str(error.get("message") or "the navide-server refused the request"),
            )
        )
        return
    result = reply.get("payload")
    result = result if isinstance(result, dict) else {}
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "emailVerified": bool(result.get("emailVerified")),
                "verificationSent": bool(result.get("verificationSent")),
                "status": await server_link.status(),
            },
        )
    )


@handler("p2p.account.logout")
async def p2p_account_logout(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Forget this machine's credential. The server keeps the account.

    The server URL is deliberately left in place: signing out is "not right
    now", not "I will never use this server again", and making the user retype
    the address every time is the kind of friction that gets a feature abandoned.
    """
    from . import app

    # Revoke the token on the server first, while the link can still carry the
    # request; offline that is skipped and the local token is erased anyway.
    revoked = await server_link.logout_on_server()
    # N1b: this token is never used again here, so its member pin goes too;
    # otherwise every sign-out and sign-in adds an entry to the trust record.
    # R4-4: only once the token reads back erased — a delete that failed
    # quietly leaves it stored, and a stored token keeps its pin.
    try:
        await vault_to_thread(server_link.replace_access_token, None)
    except Exception as err:  # noqa: BLE001
        await session.send_json(
            make_error(msg_id, msg_type, "P2P_TOKEN_WRITE_FAILED", str(err))
        )
        return
    if not revoked:
        log.info(
            "signed out locally only: the navide-server did not confirm the sign-out "
            "(offline, or a server without auth.logout), so this device's token may "
            "stay valid there until it is revoked from another device"
        )
    delta = app.ui_settings_store.set({server_link.ACCOUNT_EMAIL_SETTING: None})
    await server_link.reconfigure()
    await session.send_json(
        make_response(msg_id, msg_type, {"status": await server_link.status()})
    )
    if delta:
        await app.broadcast(make_event("ui.settings_changed", {"settings": delta}))


# The receiver-side pane policy: who, on another device, may drive a pane on
# this machine. It lives on the server (only this device or an admin may write
# it) and is cached here, so the two handlers below are a read that always
# answers and a write that only a connected link can carry. Neither touches the
# on-machine path — panes on one machine have never consulted this policy.
@handler("p2p.policy.get")
async def p2p_policy_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    await session.send_json(make_response(msg_id, msg_type, await _policy_payload()))


@handler("p2p.policy.set")
async def p2p_policy_set(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Replace this device's pane policy with the one the editor composed.

    The whole document is written at once because that is the server's only
    write: it stores the policy verbatim and never merges. The editor therefore
    sends back the rules it was shown plus its edit.
    """
    # No device in this one, so "" is what the confirmation is bound to. It
    # still binds the action, which is what stops a token minted to approve a
    # device being spent to replace the rules.
    # Bound to the document as sent: a confirmation minted to sign one rule set
    # cannot be spent on another. The window canonicalises the same object it
    # then sends, so the two spellings meet here.
    policy = payload.get("policy")
    if not await _confirmed(
        session, msg_id, msg_type, payload, subject=confirm_token.canonical_json(policy)
    ):
        return
    problem = pane_policy.validate(policy) or device_trust.validate_blocked(policy)
    if problem:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", problem))
        return

    # A document with no `blocked` key is an editor that never had one to send,
    # not somebody asking for the list to be emptied — and the server stores
    # what it is given verbatim, so the difference decides whether every block
    # survives the write. The rules editor composes from the whole cached
    # document and keeps it; the account view's "sign rules now" composes the
    # default for a machine that has no rules at all, and would have dropped it.
    # Absent means keep; only an explicit list clears one.
    cached = (await server_link.policy_state()).get("policy")
    if isinstance(policy, dict) and "blocked" not in policy:
        carried = cached.get("blocked") if isinstance(cached, dict) else None
        if carried:
            log.warning(
                "a policy write arrived with no blocked list; keeping the %d "
                "existing entries rather than clearing them",
                len(carried),
            )
            policy = {**policy, "blocked": carried}

    reply = await server_link.set_policy(policy)
    if reply is None:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "P2P_NOT_CONFIGURED",
                "no navide-server is configured, so this device has no policy to write",
            )
        )
        return
    if not reply.get("ok"):
        error = reply.get("error") if isinstance(reply.get("error"), dict) else {}
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                str(error.get("code") or "P2P_POLICY_WRITE_FAILED"),
                str(error.get("message") or "the navide-server rejected the policy"),
            )
        )
        return
    # The block list goes to the local copy too, as p2p.trust.block and
    # unblock send it, so a server that stops serving this document cannot
    # lift a block made here — nor keep one lifted here.
    await asyncio.to_thread(_mirror_blocks_locally, cached, policy)
    await session.send_json(make_response(msg_id, msg_type, await _policy_payload()))


def _mirror_blocks_locally(before: Any, after: Any) -> None:
    """Apply the change from *before*'s block list to *after*'s to the local copy."""
    def keys(policy: Any) -> set[tuple[str, str]]:
        return {(e["deviceId"], e["memberId"]) for e in device_trust.blocked_entries(policy)}

    old, new = keys(before), keys(after)
    for device_id, member_id in old - new:
        trust_store.note_unblocked(device_id, member_id)
    for device_id, member_id in new:
        try:
            trust_store.note_blocked(device_id, member_id)
        except Exception as err:  # noqa: BLE001 - held in memory by note_blocked
            log.warning("could not keep a local copy of a block: %s", err)


@handler("p2p.access_requests.list")
async def p2p_access_requests_list(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Who knocked and was refused. Read-only, and answered from memory."""
    await session.send_json(
        make_response(msg_id, msg_type, {"requests": server_link.access_requests()})
    )


@handler("p2p.access_requests.approve")
async def p2p_access_requests_approve(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Turn one refused knock into an ordinary allow rule.

    Deliberately not a second authorization store: after this there is still
    exactly one answer to "may that sender drive that pane", and it is the rule
    set the policy editor shows. Approving is a shortcut for writing the rule a
    person would otherwise have to compose by hand from four opaque ids.

    The grant is as narrow as the knock was — this member, this device, this
    workspace, this pane. Widening it to a wildcard is an edit the user makes
    in the editor, where they can see what they are widening.

    Guarded like ``policy.set`` because it *is* a policy write: an allow rule
    for a remote sender, minus the editor. Checked before the key is looked
    up, so a socket without a confirmation learns nothing about which knocks
    are waiting. Bound to the knock's key rather than a device: the key names
    member, device, workspace and pane at once, so a confirmation minted for
    one knock cannot approve another.
    """
    key = str(payload.get("key") or "")
    if not await _confirmed(session, msg_id, msg_type, payload, subject=key):
        return
    request = next((r for r in server_link.access_requests() if r["key"] == key), None)
    if request is None:
        await session.send_json(
            make_error(msg_id, msg_type, "NOT_FOUND", "that request is no longer waiting")
        )
        return

    def add_rule(policy: dict) -> None:
        rule = {
            "from": {"memberId": request["memberId"], "deviceId": request["deviceId"]},
            "to": {"workspace": request["workspace"], "paneName": request["paneName"]},
            "action": "allow",
        }
        if rule not in policy["rules"]:
            policy["rules"].append(rule)

    problem = await _write_policy(session, msg_id, msg_type, add_rule)
    if problem:
        return
    server_link.forget_access_request(key)
    await _announce_requests()
    await session.send_json(make_response(msg_id, msg_type, await _policy_payload()))


@handler("p2p.access_requests.dismiss")
async def p2p_access_requests_dismiss(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Clear a knock without granting anything. The sender is told nothing —
    dismissing is not a decision about them, it is one about this list."""
    forgotten = server_link.forget_access_request(str(payload.get("key") or ""))
    if forgotten:
        await _announce_requests()
    await session.send_json(make_response(msg_id, msg_type, {"forgotten": forgotten}))


@handler("p2p.trust.notices.list")
async def p2p_trust_notices_list(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Devices seen for the first time, and pinned devices whose key changed."""
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "notices": trust_store.notices(),
                "pending": trust_store.unapproved_devices(),
                "locked": trust_store.locked_reason(),
            },
        )
    )


@handler("p2p.trust.notices.dismiss")
async def p2p_trust_notices_dismiss(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Clear one notice — a first sighting only.

    A changed key is not a notification to acknowledge; it is a refusal that is
    currently in force, and a button that made it go away would reduce "somebody
    may be standing in for that machine" to one click. That click is the one an
    attacker who deleted this machine's key material is counting on, because the
    natural next move is to pair again and make everything work. So the answer
    here is a refusal, and the notice stays until the two fingerprints have been
    compared somewhere this program is not.
    """
    dismissed = trust_store.dismiss_notice(str(payload.get("key") or ""))
    if not dismissed:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "FORBIDDEN",
                "a changed device key cannot be dismissed; compare the two "
                "fingerprints with the other machine's owner first",
            )
        )
        return
    await _announce_trust_notices()
    await session.send_json(make_response(msg_id, msg_type, {"dismissed": True}))


async def _confirmed(
    session: "Session",
    msg_id: str,
    msg_type: str,
    payload: dict,
    *,
    device_id: str = "",
    subject: str = "",
) -> bool:
    """Whether this trust-changing request carries a live confirmation.

    Answers the caller with an error and returns False when it does not, so a
    handler's whole use of this is one guard at the top.

    The action name is the message type, and it is signed along with the device
    the request names: a confirmation minted to approve one machine cannot be
    spent to block another. See ``confirm_token`` for what this is for — it is
    the MCP and plugin paths, not a process running as this user.
    """
    reason = confirm_token.check(
        payload.get("confirm"), action=msg_type, device_id=device_id, subject=subject
    )
    if not reason:
        return True
    log.warning("refusing %s: %s", msg_type, reason)
    await session.send_json(make_error(msg_id, msg_type, "CONFIRMATION_REQUIRED", reason))
    return False


@handler("p2p.pair.start")
async def p2p_pair_start(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Ask another device to pair.

    This is a request, not a grant: nothing changes here or there until a person
    at *each* machine has compared the same six digits. The button it replaces
    did the opposite — it let one side decide, and the other side found out when
    something started running on it.
    """
    device_id = str(payload.get("deviceId") or "").strip()
    if not device_id:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "deviceId is required")
        )
        return
    if not await _confirmed(session, msg_id, msg_type, payload, device_id=device_id):
        return
    reply = await server_link.start_pairing(device_id)
    if reply is None:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "P2P_NOT_CONFIGURED",
                "no navide-server is configured, so there is no device to pair with",
            )
        )
        return
    if not reply.get("ok"):
        error = reply.get("error") if isinstance(reply.get("error"), dict) else {}
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                str(error.get("code") or "P2P_PAIRING_FAILED"),
                str(error.get("message") or "the pairing request could not be sent"),
            )
        )
        return
    await session.send_json(make_response(msg_id, msg_type, reply.get("payload") or {}))


@handler("p2p.pair.confirm")
async def p2p_pair_confirm(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """"The digits match" — or they do not.

    Both answers are decisions and both need a confirmation token: refusing is
    as much a thing a remote agent must not be able to do on somebody's behalf
    as accepting is. A refusal tells the other side, so their card leaves the
    screen instead of waiting out the five minutes.
    """
    device_id = str(payload.get("deviceId") or "").strip()
    if not device_id:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "deviceId is required")
        )
        return
    if not await _confirmed(session, msg_id, msg_type, payload, device_id=device_id):
        return
    reply = await server_link.confirm_pairing(device_id, accept=bool(payload.get("accept")))
    if reply is None:
        await session.send_json(
            make_error(msg_id, msg_type, "P2P_NOT_CONFIGURED", "no navide-server is configured")
        )
        return
    if not reply.get("ok"):
        error = reply.get("error") if isinstance(reply.get("error"), dict) else {}
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                str(error.get("code") or "P2P_PAIRING_FAILED"),
                str(error.get("message") or "that pairing could not be answered"),
            )
        )
        return
    await _announce_trust_notices()
    await session.send_json(make_response(msg_id, msg_type, reply.get("payload") or {}))


@handler("p2p.trust.device.defer")
async def p2p_trust_device_defer(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """"Not now": stop showing a pinned device until it knocks again.

    Deliberately weaker than every other button on that card. Approving and
    blocking are decisions and are written where they are enforced; this one
    changes nothing about what that device may reach — it stays pinned,
    unapproved, and held to rules that deny by default. All it does is take an
    already-answered-once question off a panel that would otherwise re-ask it
    every three seconds for as long as the pin exists.

    ``trust_store.note_knock`` clears it on the next verified message, so this
    cannot be used to make a machine quietly go away.
    """
    device_id = str(payload.get("deviceId") or "")
    if not device_id:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "deviceId is required")
        )
        return
    if not await _confirmed(session, msg_id, msg_type, payload, device_id=device_id):
        return
    deferred = await asyncio.to_thread(trust_store.defer_device, device_id)
    if deferred:
        await _announce_trust_notices()
    await session.send_json(make_response(msg_id, msg_type, {"deferred": deferred}))


@handler("p2p.trust.device.unpair")
async def p2p_trust_device_unpair(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Forget a device: drop its pin and everything decided alongside it.

    The other half of approve, and the only way back out of a pairing this
    program had. Without it a pin taken on a first sighting was permanent — a
    device id seen once was pinned forever, and the panel could ask about it but
    never finish with it.

    Addressed by device id alone, deliberately. Unpairing grants nothing, so it
    does not need the fingerprint comparison approving does; what it costs is
    that the next message from that device is a first sighting again, which is
    visible and reversible by a person.

    It does not lift a block. A block is policy — a refusal ahead of every rule
    — and pairing is identity; a device that was blocked stays blocked with no
    pin, which is strictly the more careful of the two states.
    """
    device_id = str(payload.get("deviceId") or "").strip()
    if not device_id:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "deviceId is required")
        )
        return
    if not await _confirmed(session, msg_id, msg_type, payload, device_id=device_id):
        return
    # Never this machine. The device list hides the button on its own row, and
    # that was the only thing enforcing it — anything that can reach this socket
    # could hand over this machine's own id. There is no pairing with yourself
    # to undo, so this is not a decision being refused; it is a request that
    # means nothing and takes real state with it.
    local = server_link.local_device_id()
    if local and device_id == local:
        await session.send_json(
            make_error(
                msg_id, msg_type, "FORBIDDEN", "this machine cannot be unpaired from itself"
            )
        )
        return
    removed = await asyncio.to_thread(trust_store.forget_device, device_id)
    # Told, not just forgotten. Two machines disagreeing about whether they are
    # paired is a state where one silently refuses everything the other sends,
    # and the sender's only symptom is silence.
    await server_link.revoke_pairing(device_id)
    if removed.get("found") and server_link.trust_full():
        # R4-3: the room this made is what a full record was waiting for, and
        # only a hello re-adopts the pin (see p2p.trust.rebuild).
        await server_link.reconfigure()
    if removed.get("found"):
        # The pin and its notices both feed this event, so the panel that was
        # showing the device empties in the same tick it is forgotten.
        await _announce_trust_notices()
    await session.send_json(make_response(msg_id, msg_type, {"removed": removed}))


@handler("p2p.trust.rebuild")
async def p2p_trust_rebuild(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Start the trust record over after it has failed closed.

    The one way out of a lock, and deliberately the only one. Everything about
    it is shaped by what a lock means: this machine holds a marker saying it
    once had cross-device trust, and cannot read the record — which is either a
    real attack (somebody removed the state so the machine would re-pin their
    keys) or, far more often, a Keychain item this build can no longer open.
    Nothing here can tell those apart, and neither can the person; what it can
    do is make sure the choice is theirs.

    So it needs a confirmation token, which is minted in the renderer and
    nowhere else: an MCP tool, a plugin, or anything else holding this socket
    cannot perform it, however convincing its argument. And it refuses when the
    store is healthy — a rebuild costs every pairing on this machine, and a
    caller that asks for one against a readable store has misunderstood it.
    """
    if not await _confirmed(session, msg_id, msg_type, payload):
        return
    try:
        result = await asyncio.to_thread(trust_store.rebuild_locked_store)
    except trust_store.TrustStoreNotLocked as err:
        await session.send_json(make_error(msg_id, msg_type, "NOT_LOCKED", str(err)))
        return
    except Exception as err:  # noqa: BLE001 - a vault that will not answer is worth saying
        await session.send_json(
            make_error(msg_id, msg_type, "REBUILD_FAILED", str(err))
        )
        return
    # Reconnect, rather than clear the stop and call it done.
    #
    # The store is only half of it: the link caches the store's answer in
    # `_trust_locked`, written once during authentication and by nothing else,
    # and four paths read that cache — message delivery, policy writes, the
    # roster and the snapshot. A rebuild that only cleared the store left the
    # card on screen saying the record was unreadable, and cross-device traffic
    # genuinely still refused, until the link happened to reconnect. On the
    # machine this was reported from it had not reconnected for hours.
    #
    # And clearing the cache alone would be worse than leaving it: the rebuild
    # erases the member pin too, so `_own_member` would go on naming a pin that
    # no longer exists — a machine that looks recovered and answers "yes, that
    # is one of mine" from a record that was deleted. Only re-authenticating
    # settles both, because `_adopt_member` runs on the `auth.hello` reply and
    # cannot be invoked without one.
    #
    # Unconditional. Getting here means the store was locked, and the case that
    # a condition would skip — locked *after* a successful adoption, so the
    # cache is empty and the link is up — is exactly the case that needs it.
    await server_link.reconfigure()
    # The panel is showing the lock; this is what empties it.
    await _announce_trust_notices()
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("p2p.trust.block")
async def p2p_trust_block(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Refuse a device outright, ahead of every rule.

    Takes a deviceId, a memberId, or both — see device_trust.is_blocked for why
    they are alternatives rather than a pair. Blocking also clears whatever that
    device had waiting in the knock list: the point of a block is that this
    machine stops being asked about it.
    """
    device_id = str(payload.get("deviceId") or "").strip()
    member_id = str(payload.get("memberId") or "").strip()
    if not device_id and not member_id:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "block needs a deviceId or a memberId")
        )
        return
    if not await _confirmed(
        session, msg_id, msg_type, payload, device_id=device_id, subject=member_id
    ):
        return
    entry = {
        "deviceId": device_id,
        "memberId": member_id,
        "deviceName": str(payload.get("deviceName") or ""),
        "reason": str(payload.get("reason") or ""),
        "at": datetime.now(timezone.utc).isoformat(),
    }

    def add_block(policy: dict) -> None:
        blocked = policy.setdefault("blocked", [])
        for existing in blocked:
            if isinstance(existing, dict) and (
                (device_id and existing.get("deviceId") == device_id)
                or (member_id and not device_id and existing.get("memberId") == member_id)
            ):
                return
        blocked.append(entry)

    if await _write_policy(session, msg_id, msg_type, add_block):
        return
    # Recorded here as well as in the policy, and only after the policy write
    # succeeded so the two cannot disagree about a block that was never made.
    # The local copy is what still refuses this device when the policy document
    # cannot be verified — see device_trust.is_blocked.
    problem: Exception | None = None
    try:
        await asyncio.to_thread(trust_store.note_blocked, device_id, member_id)
    except Exception as err:  # noqa: BLE001
        problem = err
    if device_id and server_link.forget_access_requests_for_device(device_id):
        await _announce_requests()
    if problem is not None:
        # Fail closed. The server's block stands, and note_blocked holds the
        # local one in memory until the restart; only the saved copy is missing.
        # Taking the server's block back instead left the device trusted.
        await session.send_json(_block_not_kept(problem, msg_id, msg_type))
        return
    await session.send_json(make_response(msg_id, msg_type, await _policy_payload()))


def _block_not_kept(err: Exception, msg_id: str, msg_type: str) -> dict:
    # Its own code even for a full record (review F2): p2p-trust-store-full is
    # also what a block refused before it reached the server answers, and the
    # two must not read alike — this one is in force.
    code = (
        "P2P_BLOCK_NOT_SAVED_LOCALLY_FULL"
        if isinstance(err, trust_store.TrustStoreFull)
        else "P2P_BLOCK_NOT_SAVED_LOCALLY"
    )
    return make_error(
        msg_id,
        msg_type,
        code,
        "the block is in force on the server, and on this machine until it restarts, "
        f"but this machine could not save its own copy ({err})",
    )


@handler("p2p.trust.unblock")
async def p2p_trust_unblock(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Lift a block. It grants nothing on its own — the device goes back to
    being decided by the rules, which deny by default."""
    device_id = str(payload.get("deviceId") or "").strip()
    member_id = str(payload.get("memberId") or "").strip()
    # The same check block has. Without it an empty request rewrote the policy
    # to say exactly what it already said — a signed write, a revision bump and
    # a success, for a request that named nobody.
    if not device_id and not member_id:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "unblock needs a deviceId or a memberId")
        )
        return

    if not await _confirmed(
        session, msg_id, msg_type, payload, device_id=device_id, subject=member_id
    ):
        return

    def drop_block(policy: dict) -> None:
        policy["blocked"] = [
            entry
            for entry in policy.get("blocked", [])
            if not (
                isinstance(entry, dict)
                and (
                    (device_id and entry.get("deviceId") == device_id)
                    or (member_id and entry.get("memberId") == member_id)
                )
            )
        ]

    if await _write_policy(session, msg_id, msg_type, drop_block):
        return
    # Lifting has to reach the local copy too, or a device unblocked in the
    # policy stays refused here with nothing on screen to explain it.
    await asyncio.to_thread(trust_store.note_unblocked, device_id, member_id)
    await session.send_json(make_response(msg_id, msg_type, await _policy_payload()))


async def _announce_trust_notices() -> None:
    """Same shape the link broadcasts on its own paths, so a window has one
    event to listen for whether the notice came from a message that was refused
    or from a person clearing one here."""
    from . import app

    await app.broadcast(
        make_event(
            "p2p.trust_notices.changed",
            {
                "notices": trust_store.notices(),
                "pending": trust_store.unapproved_devices(),
                "locked": trust_store.locked_reason(),
            },
        )
    )


async def _announce_requests() -> None:
    from . import app

    await app.broadcast(
        make_event("p2p.access_requests.changed", {"requests": server_link.access_requests()})
    )


async def _write_policy(session: "Session", msg_id: str, msg_type: str, mutate) -> bool:
    """Read the cached policy, apply *mutate*, write the whole document back.

    Read-modify-write because the server's only write is a replace — it stores
    the document verbatim and never merges. It starts from the cache rather
    than a fresh fetch for the same reason authorization does: the decision must
    not depend on the control plane answering at that instant.

    Returns True when it already answered the caller with an error.
    """
    state = await server_link.policy_state()
    if not state.get("editable"):
        # `editable` is the link's own honest answer: the policy lives on the
        # server, so an unconfigured or offline machine can read its cached
        # rules and must not pretend to have saved a change to them.
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "P2P_NOT_CONFIGURED"
                if state.get("state") == server_link.STATE_UNCONFIGURED
                else "P2P_LINK_OFFLINE",
                "this device has no writable policy right now",
            )
        )
        return True
    policy = state.get("policy")
    if not isinstance(policy, dict):
        # No policy yet is the normal state of a device nobody has configured;
        # the base document is the one the server hands out at revision 0.
        policy = {"version": 1, "default": "deny", "rules": []}
    else:
        policy = json.loads(json.dumps(policy))
    policy.setdefault("version", 1)
    policy.setdefault("default", "deny")
    if not isinstance(policy.get("rules"), list):
        policy["rules"] = []
    # The document is stored verbatim by the server and can therefore hold
    # whatever some other client wrote into it. The read side forgives that —
    # device_trust skips a row it cannot parse — but the mutators below append
    # to and filter these lists, and a string or a number here would raise
    # inside a handler rather than deny anything. Normalising once is what
    # keeps every caller from having to.
    if "blocked" in policy and not isinstance(policy.get("blocked"), list):
        from . import app as _app

        _app.log.warning(
            "policy blocked was %s, not a list; replacing it", type(policy["blocked"]).__name__
        )
        policy["blocked"] = []

    mutate(policy)

    problem = pane_policy.validate(policy) or device_trust.validate_blocked(policy)
    if problem:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", problem))
        return True
    reply = await server_link.set_policy(policy)
    if reply is None or not reply.get("ok"):
        error = (reply or {}).get("error") if isinstance((reply or {}).get("error"), dict) else {}
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                str(error.get("code") or "P2P_POLICY_WRITE_FAILED"),
                str(error.get("message") or "the navide-server rejected the policy"),
            )
        )
        return True
    return False


async def _policy_payload() -> dict:
    """The policy plus the devices a rule could name, in one answer.

    The device list comes from the cached session directory rather than a
    device registry, because that directory is all the server sends — and a
    rule naming a device that has never had a pane grants nothing anyone could
    have used. It is a convenience for the picker, never a constraint: the
    policy is written with ids, so an id typed by hand works the same.
    """
    state = await server_link.policy_state()
    state["devices"] = remote_roster.list_devices()
    return state


# The whole network in one read: which devices are signed in to this team
# space, and which CLI panes are running on each. One call rather than a
# directory read plus a presence read plus a member read, because the account
# modal polls it while it is open and three round trips per tick would be three
# chances to render a half-updated picture.
#
# Answered from server_link's cache, which its own subscriptions keep current
# (sessions.changed for the rows, presence.changed for who is reachable), so a
# poll here costs no traffic to the server at all.
@handler("p2p.network.snapshot")
async def p2p_network_snapshot(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    snapshot = await server_link.network_snapshot()
    if snapshot is None:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "P2P_NOT_CONFIGURED",
                "no navide-server is configured, so this machine has no network",
            )
        )
        return
    # A link that is down still answers, carrying `state` and the last picture
    # the server sent: "the network you had a moment ago, and the link is
    # offline" is the truth, while an error would read as "you have no network".
    await _add_local_pane_git(snapshot)
    await session.send_json(make_response(msg_id, msg_type, snapshot))


async def _add_local_pane_git(snapshot: dict) -> None:
    """Give this machine's own pane rows their `git` snapshot, in place.

    Local panes only: another machine's checkout is not readable from here, and
    nothing about git is uploaded to the server.
    """
    from .mcp_server.server import pane_git_cached

    panes = [
        pane
        for device in snapshot.get("devices") or []
        if isinstance(device, dict) and device.get("isLocal")
        for pane in device.get("panes") or []
        if isinstance(pane, dict) and pane.get("paneId")
    ]
    workspaces = {entry.pane_id: entry.workspace_path for entry in agent_messaging.list_panes()}
    # Polled every 3 s by each main window: answered from the last snapshot,
    # refreshed in the background once it is older than the cache's TTL, so a
    # stream of git.changed no longer re-runs git on every poll.
    snapshots = [pane_git_cached(pane["paneId"], workspaces.get(pane["paneId"], "")) for pane in panes]
    for pane, git in zip(panes, snapshots):
        if git is not None:
            pane["git"] = git


# ── Settings bundle / metadata (settings.*) ─────────────────────────────────
@handler("settings.paths")
async def settings_paths(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    await session.send_json(make_response(msg_id, msg_type, {"paths": app._settings_paths()}))


@handler("settings.bundle.export")
async def settings_bundle_export(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    try:
        bundle = app._settings_bundle()
    except MCPSettingsError as err:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "MCP_SETTINGS_INVALID",
                str(err),
                {"path": str(app.mcp_settings_store.path)},
            )
        )
        return
    await session.send_json(make_response(msg_id, msg_type, {"bundle": bundle}))


@handler("settings.bundle.import")
async def settings_bundle_import(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    bundle = payload.get("bundle") if isinstance(payload.get("bundle"), dict) else payload
    if not isinstance(bundle, dict):
        await session.send_json(make_error(msg_id, msg_type, "INVALID_BUNDLE", "settings bundle must be an object"))
        return
    applied: list[str] = []
    if isinstance(bundle.get("roles"), list):
        roles = app.roles_store.replace_all(bundle["roles"])
        applied.append("roles")
        await app.broadcast(make_event("roles.changed", {"roles": roles, "reason": "bundle_import"}))
    if isinstance(bundle.get("pipelines_document"), dict):
        app.stages_store.replace_document(bundle["pipelines_document"])
        pipelines = app.stages_store.list_pipelines()
        active_id = app.stages_store.get_active_pipeline_id()
        applied.append("pipelines")
        await app.broadcast(make_event("pipelines.changed", {
            "pipelines": pipelines,
            "active_pipeline_id": active_id,
            "reason": "bundle_import",
        }))
        await app.broadcast(make_event("stages.changed", {
            "stages": app.stages_store.list(active_id),
            "pipeline_id": active_id,
            "reason": "bundle_import",
        }))
    if "roles" in applied or "pipelines" in applied:
        # After the pipelines document, not inside the roles branch above: a
        # bundle carrying both parts must be cleaned against the document it
        # just imported, whose slots the earlier branch has never seen. Either
        # half alone can strand a slot too — a new role set can drop a key the
        # stages still name, and an imported document can name a key this
        # machine has never had.
        await _clear_dangling_role_refs("bundle_import")
    mcp_needs_secrets: list[str] = []
    if isinstance(bundle.get("mcp_servers"), list):
        incoming_servers = bundle["mcp_servers"]
        if not all(isinstance(server, dict) for server in incoming_servers):
            await session.send_json(
                make_error(
                    msg_id,
                    msg_type,
                    "MCP_VALIDATION_ERROR",
                    "mcp_servers must contain only server objects",
                )
            )
            return
        try:
            existing_servers = app.mcp_settings_store.list_servers()
            restored_servers = restore_mcp_server_secrets(
                incoming_servers,
                existing_servers,
            )
            mcp_needs_secrets = unfilled_mcp_secrets(incoming_servers, restored_servers)
            app.mcp_settings_store.replace_servers(restored_servers)
        except ValidationError as err:
            await session.send_json(
                make_error(msg_id, msg_type, "MCP_VALIDATION_ERROR", str(err))
            )
            return
        except MCPSettingsError as err:
            await session.send_json(
                make_error(
                    msg_id,
                    msg_type,
                    "MCP_SETTINGS_INVALID",
                    str(err),
                    {"path": str(app.mcp_settings_store.path)},
                )
            )
            return
        await app.mcp_manager.reload(app.mcp_settings_store.path)
        applied.append("mcp")
    if isinstance(bundle.get("analyzer"), dict):
        updated = app.analyzer_settings_store.set(bundle["analyzer"])
        applied.append("analyzer")
        await app.broadcast(make_event("analyzer.settings_changed", updated))
    if isinstance(bundle.get("ai_chat"), dict):
        safe_chat = {
            k: v for k, v in bundle["ai_chat"].items()
            if k not in app._AI_SECRET_KEYS and v != "__redacted__"
        }
        if safe_chat:
            app.ai_chat_settings_store.set(safe_chat)
            applied.append("ai_chat")
    await session.send_json(make_response(msg_id, msg_type, {
        "ok": True,
        "applied": applied,
        "mcp_needs_secrets": mcp_needs_secrets,
        "paths": app._settings_paths(),
    }))


# ── Shareable settings bundles (share.*) ────────────────────────────────────
#
# A different document from settings.bundle.* above: four scopes (prompts, mcp,
# skills, memory), built to be handed to another person, and stripped of every
# secret on the way out. The whole of it lives in settings_bundle.py; these are
# the wire endings. Every call reads files and SQLite, so all four hop off the
# event loop.
async def _share_call(
    session: "Session",
    msg_id: str,
    msg_type: str,
    work: Callable[[], Any],
) -> Any:
    """Run one settings_bundle call off the loop, answering an error itself."""
    from . import settings_bundle

    try:
        return await asyncio.to_thread(work)
    except settings_bundle.BundleError as err:
        await session.send_json(make_error(msg_id, msg_type, err.code, err.message, err.details))
        return None


@handler("share.inventory")
async def share_inventory(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import settings_bundle

    scopes = await _share_call(session, msg_id, msg_type, settings_bundle.inventory)
    if scopes is None:
        return
    await session.send_json(make_response(msg_id, msg_type, {"scopes": scopes}))


@handler("share.export")
async def share_export(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import settings_bundle

    selection = payload.get("selection")
    if not isinstance(selection, dict):
        await session.send_json(
            make_error(msg_id, msg_type, "INVALID_SELECTION", "selection must be an object")
        )
        return
    name = payload.get("name") if isinstance(payload.get("name"), str) else ""
    description = payload.get("description") if isinstance(payload.get("description"), str) else ""
    bundle = await _share_call(
        session,
        msg_id,
        msg_type,
        lambda: settings_bundle.export_bundle(selection, name=name, description=description),
    )
    if bundle is None:
        return
    await session.send_json(make_response(msg_id, msg_type, {"bundle": bundle}))


@handler("share.import_preview")
async def share_import_preview(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import settings_bundle

    bundle = payload.get("bundle")
    rows = await _share_call(
        session, msg_id, msg_type, lambda: settings_bundle.preview_import(bundle)
    )
    if rows is None:
        return
    await session.send_json(make_response(msg_id, msg_type, {"items": rows}))


@handler("share.import_apply")
async def share_import_apply(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app, settings_bundle

    bundle = payload.get("bundle")
    selection = payload.get("selection")
    if not isinstance(selection, dict):
        await session.send_json(
            make_error(msg_id, msg_type, "INVALID_SELECTION", "selection must be an object")
        )
        return
    outcome = await _share_call(
        session, msg_id, msg_type, lambda: settings_bundle.apply_import(bundle, selection)
    )
    if outcome is None:
        return
    # The same event ui.settings.set sends, so every open window converges on an
    # imported prompt the way it does on a locally edited one.
    for delta in outcome["settings_deltas"]:
        await app.broadcast(make_event("ui.settings_changed", {"settings": delta}))
    if outcome["mcp_changed"]:
        await app.mcp_manager.reload(app.mcp_settings_store.path)
    await session.send_json(
        make_response(msg_id, msg_type, {"ok": True, "items": outcome["results"]})
    )


# ── Cross-account shares (share.publish / claim / list / revoke) ─────────────
# The four handlers above build and apply a bundle on this machine; these move
# one through navide-server to a *different* account. The seam between the two
# is the share code: publish seals a bundle under a key the server never sees
# and hands the code back, claim turns a code back into the bundle and stops
# there — the window takes it to share.import_preview, the same path a bundle
# read from a file takes. Nothing here applies anything.
_SHARE_TTL_DEFAULT_S = 24 * 3600


async def _share_code_call(
    session: "Session",
    msg_id: str,
    msg_type: str,
    work: Callable[[], Any],
) -> Any:
    """Run one share_codes call off the loop, answering an error itself.

    The same shape as ``_share_call``, for the other module: sealing gzips and
    encrypts, opening does the reverse plus a JSON parse, and a bundle near the
    limit is enough work to keep off the event loop.
    """
    from . import share_codes

    try:
        return await asyncio.to_thread(work)
    except share_codes.ShareCodeError as err:
        await session.send_json(make_error(msg_id, msg_type, err.code, err.message, err.details))
        return None


async def _share_link_reply(
    session: "Session",
    msg_id: str,
    msg_type: str,
    reply: dict | None,
    fallback_code: str,
) -> dict | None:
    """Unwrap a server_link reply frame into its payload, answering errors itself.

    None from the link means no server is configured — the same meaning it has
    for every other ``server_link`` wrapper. The server's own codes come
    through unchanged so the window can show them (a claim of a revoked share
    is the server's word, not this side's guess).
    """
    if reply is None:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "P2P_NOT_CONFIGURED",
                "no navide-server is configured, so there is nowhere to send a share",
            )
        )
        return None
    if not reply.get("ok"):
        error = reply.get("error") if isinstance(reply.get("error"), dict) else {}
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                str(error.get("code") or fallback_code),
                str(error.get("message") or "the navide-server refused the request"),
            )
        )
        return None
    result = reply.get("payload")
    return result if isinstance(result, dict) else {}


@handler("share.publish")
async def share_publish(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Seal one bundle, store the ciphertext on the server, hand back the code.

    The size gate runs before the request leaves: over the server's frame
    limit the connection is closed at the framing layer, which the user sees
    as a disconnect and nothing else. The error minted here names the file
    export as the way out instead.
    """
    from . import settings_bundle, share_codes

    bundle = payload.get("bundle")
    if not isinstance(bundle, dict):
        await session.send_json(
            make_error(msg_id, msg_type, "INVALID_BUNDLE", "bundle must be an object")
        )
        return
    try:
        bundle = settings_bundle.without_secrets(bundle)
    except settings_bundle.BundleError as err:
        await session.send_json(make_error(msg_id, msg_type, err.code, err.message, err.details))
        return
    ttl = payload.get("ttlSeconds")
    if not isinstance(ttl, int) or isinstance(ttl, bool) or ttl <= 0:
        ttl = _SHARE_TTL_DEFAULT_S

    def seal() -> tuple[bytes, str]:
        key = share_codes.new_key()
        blob = share_codes.seal_bundle(bundle, key)
        share_codes.ensure_blob_within_limit(blob)
        return key, blob

    sealed = await _share_code_call(session, msg_id, msg_type, seal)
    if sealed is None:
        return
    key, blob = sealed
    result = await _share_link_reply(
        session,
        msg_id,
        msg_type,
        await server_link.create_share(blob=blob, size_bytes=len(blob), ttl_seconds=ttl),
        "SHARE_PUBLISH_FAILED",
    )
    if result is None:
        return
    share_id = str(result.get("shareId") or "")
    code = await _share_code_call(
        session, msg_id, msg_type, lambda: share_codes.encode_share_code(share_id, key)
    )
    if code is None:
        return
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "code": code,
                "shareId": share_codes.normalize_share_id(share_id),
                "expiresAt": result.get("expiresAt"),
            },
        )
    )


@handler("share.claim")
async def share_claim(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Turn a share code back into the bundle it names, and stop there.

    A mistyped code is refused by its checksum before anything is asked of the
    server, so "no such share" only ever means the server said so.
    """
    from . import share_codes

    code = payload.get("code")
    if not isinstance(code, str) or not code.strip():
        await session.send_json(
            make_error(msg_id, msg_type, "INVALID_SHARE_CODE", "code must be a non-empty string")
        )
        return
    decoded = await _share_code_call(
        session, msg_id, msg_type, lambda: share_codes.decode_share_code(code)
    )
    if decoded is None:
        return
    share_id, key = decoded
    result = await _share_link_reply(
        session, msg_id, msg_type, await server_link.claim_share(share_id), "SHARE_CLAIM_FAILED"
    )
    if result is None:
        return
    blob = result.get("blob")
    if not isinstance(blob, str) or not blob:
        await session.send_json(
            make_error(
                msg_id, msg_type, "SHARE_CLAIM_FAILED", "the navide-server returned no document"
            )
        )
        return
    bundle = await _share_code_call(
        session, msg_id, msg_type, lambda: share_codes.open_bundle(blob, key)
    )
    if bundle is None:
        return
    await session.send_json(
        make_response(msg_id, msg_type, {"bundle": bundle, "shareId": share_id})
    )


@handler("share.list_published")
async def share_list_published(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    result = await _share_link_reply(
        session, msg_id, msg_type, await server_link.list_shares(), "SHARE_LIST_FAILED"
    )
    if result is None:
        return
    shares = result.get("shares")
    await session.send_json(
        make_response(msg_id, msg_type, {"shares": shares if isinstance(shares, list) else []})
    )


@handler("share.revoke_published")
async def share_revoke_published(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    from . import share_codes

    raw = payload.get("shareId")
    if not isinstance(raw, str) or not raw.strip():
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_SHARE_ID", "shareId must be a non-empty string")
        )
        return
    try:
        share_id = share_codes.normalize_share_id(raw)
    except share_codes.ShareCodeError as err:
        await session.send_json(make_error(msg_id, msg_type, err.code, err.message, err.details))
        return
    result = await _share_link_reply(
        session, msg_id, msg_type, await server_link.revoke_share(share_id), "SHARE_REVOKE_FAILED"
    )
    if result is None:
        return
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "shareId": share_id}))


# ── Share links (share.* → links.* on Navide-Server) ─────────────────────────
# Encrypted, read-only links to a plan or report (share_links). A server
# without links answers UNKNOWN_TYPE or UNSUPPORTED, passed through as the
# error code so the UI can hide the feature rather than show a failure.


async def _share_links_call(
    session: "Session", msg_id: str, msg_type: str, call: Callable[[Any], Awaitable[dict]]
) -> None:
    from . import share_links, sync_keyring

    # The link first: without it nothing may reach the account key or the server.
    state = server_link.link_state()
    if state != server_link.STATE_CONNECTED:
        code = "NOT_CONFIGURED" if state == server_link.STATE_UNCONFIGURED else "LINK_OFFLINE"
        await session.send_json(make_error(msg_id, msg_type, code, f"Navide Cloud is {state}"))
        return
    try:
        result = await call(share_links.ServerLinksClient())
    except share_links.ShareRefused as err:
        await session.send_json(make_error(msg_id, msg_type, "SHARE_REFUSED", str(err), {"reason": err.code}))
        return
    except share_links.ShareRemoteError as err:
        await session.send_json(make_error(msg_id, msg_type, err.code, str(err)))
        return
    except sync_keyring.KeyringError as err:
        await session.send_json(make_error(msg_id, msg_type, "NO_SYNC_KEY", str(err)))
        return
    except share_links.ShareError as err:
        await session.send_json(make_error(msg_id, msg_type, "SHARE_FAILED", str(err)))
        return
    await session.send_json(make_response(msg_id, msg_type, result))


def _link_id_of(payload: dict) -> str:
    raw = payload.get("linkId")
    return raw.strip() if isinstance(raw, str) else ""


def _ttl_of(payload: dict) -> int | None:
    raw = payload.get("ttlSeconds")
    return raw if isinstance(raw, int) and not isinstance(raw, bool) else None


@handler("share.caps")
async def share_caps(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import share_links

    await _share_links_call(session, msg_id, msg_type, share_links.caps)


@handler("share.create")
async def share_create(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Share one file the user picked: {path, kind?, ttlSeconds?, requireLogin?,
    sendToChat?} — sendToChat posts the link to the user's chat (Channels)."""
    from . import app, share_links

    path = payload.get("path")
    kind = payload.get("kind") or "plan"
    if not isinstance(path, str) or not path or not isinstance(kind, str):
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", "path must be a non-empty string"))
        return
    require_login = payload.get("requireLogin")

    async def call(client: Any) -> dict:
        created = await share_links.create_share(
            client,
            path,
            kind,
            ttl_seconds=_ttl_of(payload),
            require_login=require_login if isinstance(require_login, bool) else None,
            created_by="user",
        )
        result = share_created_payload(created, created_by="user")
        try:
            await app.broadcast(make_event("share.created", {k: v for k, v in result.items() if k != "url"}))
        except Exception as err:  # noqa: BLE001 - the link exists; its creator must still get the URL
            log.warning("announcing a new share link failed: %s", err)
        if payload.get("sendToChat") is True:
            chat_id = payload.get("chatId") if isinstance(payload.get("chatId"), str) else ""
            await share_links.announce_to_chat(created, created_by="user", chat_id=chat_id)
        return result

    await _share_links_call(session, msg_id, msg_type, call)


def share_created_payload(created: Any, *, created_by: str, pane: str = "", agent: str = "") -> dict:
    """What a new link's creator is told: the URL (the only copy of its key the
    creator gets) and where the content was masked, never the masked values."""
    return {
        "linkId": created.link_id,
        "url": created.url,
        "expiresAt": created.expires_at,
        "createdBy": created_by,
        "pane": pane,
        "agent": agent,
        "masked": [{"line": f.line, "category": f.category, "action": f.action} for f in created.findings],
    }


@handler("share.list")
async def share_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import share_links

    async def call(client: Any) -> dict:
        return {"links": await share_links.list_links(client)}

    await _share_links_call(session, msg_id, msg_type, call)


@handler("share.copy_link")
async def share_copy_link(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import share_links

    link_id = _link_id_of(payload)

    async def call(client: Any) -> dict:
        return {"linkId": link_id, "url": await share_links.copy_link(client, link_id)}

    await _share_links_call(session, msg_id, msg_type, call)


@handler("share.revoke")
async def share_revoke(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import share_links

    link_id = _link_id_of(payload)
    await _share_links_call(session, msg_id, msg_type, lambda client: share_links.revoke(client, link_id))


@handler("share.revoke_all")
async def share_revoke_all(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import share_links

    device_id = payload.get("deviceId") if isinstance(payload.get("deviceId"), str) else ""
    await _share_links_call(session, msg_id, msg_type, lambda client: share_links.revoke_all(client, device_id))


@handler("share.extend")
async def share_extend(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import share_links

    link_id = _link_id_of(payload)
    ttl = _ttl_of(payload)
    if ttl is None:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", "ttlSeconds must be an integer"))
        return
    await _share_links_call(session, msg_id, msg_type, lambda client: share_links.extend(client, link_id, ttl))


@handler("share.rekey")
async def share_rekey(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import share_links

    link_id = _link_id_of(payload)

    async def call(client: Any) -> dict:
        moved = await share_links.rekey(client, link_id)
        return {
            "linkId": moved.link_id,
            "url": moved.url,
            "expiresAt": moved.expires_at,
            "replaces": link_id,
            "oldRevoked": moved.replaced,
        }

    await _share_links_call(session, msg_id, msg_type, call)


@handler("share.update")
async def share_update(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Publish the source file's current content under the same link."""
    from . import share_links

    link_id = _link_id_of(payload)
    path = payload.get("path") if isinstance(payload.get("path"), str) else ""
    await _share_links_call(
        session, msg_id, msg_type, lambda client: share_links.update_content(client, link_id, path)
    )


# ── Roles registry (roles.*) ────────────────────────────────────────────────
async def _broadcast_stage_role_changes(pipeline_ids: list[str], reason: str) -> None:
    """Publish the rewritten stages of every pipeline a role edit touched.

    Only role_key changed, so the stage count the pipeline summaries carry is
    untouched and pipelines.changed would say nothing new.
    """
    from . import app

    for pipeline_id in pipeline_ids:
        await app.broadcast(make_event("stages.changed", {
            "stages": app.stages_store.list(pipeline_id),
            "pipeline_id": pipeline_id,
            "reason": reason,
        }))


async def _clear_dangling_role_refs(reason: str) -> None:
    """Blank stage slots left naming a role that the new role set dropped.

    For the wholesale replacements (roles.reset, settings bundle import), which
    cannot be refused the way a single roles.delete is. Reads the surviving keys
    first and hands them to the stages store, so the two stores' locks are taken
    one after the other and never nested.
    """
    from . import app

    valid = {str(r.get("key", "")) for r in app.roles_store.list()}
    touched = app.stages_store.clear_missing_role_references(valid)
    await _broadcast_stage_role_changes(touched, reason)


@handler("roles.list")
async def roles_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {"roles": app.roles_store.list(), "path": str(app.roles_store.path)},
        )
    )


@handler("roles.upsert")
async def roles_upsert(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    role = app.roles_store.upsert(
        key=payload["key"],
        label=payload.get("label", ""),
        one_line=payload.get("one_line", ""),
        system_prompt=payload.get("system_prompt", ""),
        properties=payload.get("properties"),
    )
    await session.send_json(
        make_response(msg_id, msg_type, {"role": role, "roles": app.roles_store.list()})
    )
    await app.broadcast(
        make_event("roles.changed", {"roles": app.roles_store.list(), "reason": "upsert"})
    )


@handler("roles.rename")
async def roles_rename(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Change a role's key, carrying the stage slots that name it across.

    A rename used to be the caller's job: upsert under the new key, then delete
    the old one. roles.delete refuses while a slot still names the role, so on a
    default install that sequence stops halfway — both keys in the registry, the
    slots still on the old one, and the only way out (delete the old key) refused
    for the same reason. Doing it here keeps every intermediate state consistent:
    the new role exists before anything points at it, and the old one goes only
    after nothing does.
    """
    from . import app

    old_key = payload["old_key"]
    new_key = payload["new_key"]
    if app.roles_store.get(old_key) is None:
        await session.send_json(
            make_error(
                msg_id, msg_type, "ROLE_NOT_FOUND",
                f"no such role: {old_key!r}", {"role_key": old_key},
            )
        )
        return
    if new_key != old_key and app.roles_store.get(new_key) is not None:
        # Merging two roles would silently drop one side's prompt, so refuse and
        # let the caller decide which one it meant.
        await session.send_json(
            make_error(
                msg_id, msg_type, "ROLE_KEY_EXISTS",
                f"role {new_key!r} already exists", {"role_key": new_key},
            )
        )
        return
    # A rename must not drop the role's declarative properties.
    properties = payload.get("properties")
    if properties is None:
        properties = (app.roles_store.get(old_key) or {}).get("properties")
    role = app.roles_store.upsert(
        key=new_key,
        label=payload.get("label", ""),
        one_line=payload.get("one_line", ""),
        system_prompt=payload.get("system_prompt", ""),
        properties=properties,
    )
    touched = app.stages_store.repoint_role_references(old_key, new_key)
    if new_key != old_key:
        app.roles_store.delete(old_key)
    roles = app.roles_store.list()
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {"role": role, "roles": roles, "repointed_pipeline_ids": touched},
        )
    )
    await app.broadcast(
        make_event("roles.changed", {"roles": roles, "reason": "rename"})
    )
    await _broadcast_stage_role_changes(touched, "role_rename")


@handler("roles.delete")
async def roles_delete(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    key = payload["key"]
    # Refuse rather than strand the slots that name it: a slot pointing at a
    # deleted role fails role injection and returns before the kickoff step, so
    # that stage's agent waits at an empty prompt with nothing on screen to say
    # why. The caller gets the exact slots so it can offer to edit them.
    usages = app.stages_store.find_role_usages(key)
    if usages:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "ROLE_IN_USE",
                f"role {key!r} is still used by {len(usages)} pipeline stage slot(s)",
                {"role_key": key, "usages": usages},
            )
        )
        return
    roles = app.roles_store.delete(key)
    await session.send_json(
        make_response(msg_id, msg_type, {"roles": roles})
    )
    await app.broadcast(
        make_event("roles.changed", {"roles": roles, "reason": "delete"})
    )


@handler("roles.reset")
async def roles_reset(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    roles = app.roles_store.reset()
    await session.send_json(
        make_response(msg_id, msg_type, {"roles": roles})
    )
    await app.broadcast(
        make_event("roles.changed", {"roles": roles, "reason": "reset"})
    )
    await _clear_dangling_role_refs("roles_reset")


# ── Pipelines registry (pipelines.*) ────────────────────────────────────────
@handler("pipelines.list")
async def pipelines_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    pipelines = app.stages_store.list_pipelines()
    active_id = app.stages_store.get_active_pipeline_id()
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {"pipelines": pipelines, "active_pipeline_id": active_id, "path": str(app.stages_store.path)},
        )
    )


@handler("pipelines.create")
async def pipelines_create(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    name = payload.get("name", "New Pipeline")
    pipeline = app.stages_store.create_pipeline(name)
    pipelines = app.stages_store.list_pipelines()
    await session.send_json(
        make_response(msg_id, msg_type, {"pipeline": pipeline, "pipelines": pipelines})
    )
    await app.broadcast(make_event("pipelines.changed", {
        "pipelines": pipelines,
        "active_pipeline_id": app.stages_store.get_active_pipeline_id(),
        "reason": "create",
    }))


@handler("pipelines.rename")
async def pipelines_rename(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    pipeline_id = payload.get("pipeline_id", "")
    name = payload.get("name", "")
    pipeline = app.stages_store.rename_pipeline(pipeline_id, name)
    pipelines = app.stages_store.list_pipelines()
    await session.send_json(
        make_response(msg_id, msg_type, {"pipeline": pipeline, "pipelines": pipelines})
    )
    await app.broadcast(make_event("pipelines.changed", {
        "pipelines": pipelines,
        "active_pipeline_id": app.stages_store.get_active_pipeline_id(),
        "reason": "rename",
    }))


@handler("pipelines.delete")
async def pipelines_delete(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    pipeline_id = payload.get("pipeline_id", "")
    ws_path = payload.get("workspace_path", "") or ""
    if ws_path:
        proj = app.project_store.peek(ws_path)
        if pipeline_liveness.run_is_live(proj):
            await session.send_json(
                make_error(msg_id, msg_type, "PIPELINE_RUNNING", "Cannot delete pipeline while a project is running")
            )
            return
    pipelines = app.stages_store.delete_pipeline(pipeline_id)
    await session.send_json(
        make_response(msg_id, msg_type, {"pipelines": pipelines})
    )
    await app.broadcast(make_event("pipelines.changed", {
        "pipelines": pipelines,
        "active_pipeline_id": app.stages_store.get_active_pipeline_id(),
        "reason": "delete",
    }))


@handler("pipelines.set_active")
async def pipelines_set_active(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    pipeline_id = payload.get("pipeline_id", "")
    ws_path = payload.get("workspace_path", "") or ""
    if ws_path:
        proj = app.project_store.peek(ws_path)
        if pipeline_liveness.run_is_live(proj):
            await session.send_json(
                make_error(msg_id, msg_type, "PIPELINE_RUNNING", "Cannot switch pipeline while a project is running")
            )
            return
    app.stages_store.set_active_pipeline(pipeline_id)
    pipelines = app.stages_store.list_pipelines()
    await session.send_json(
        make_response(msg_id, msg_type, {
            "active_pipeline_id": pipeline_id,
            "pipelines": pipelines,
        })
    )
    await app.broadcast(make_event("pipelines.changed", {
        "pipelines": pipelines,
        "active_pipeline_id": pipeline_id,
        "reason": "set_active",
    }))


@handler("pipelines.reset_builtin")
async def pipelines_reset_builtin(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    pipeline_id = payload.get("pipeline_id", "")
    ws_path = payload.get("workspace_path", "") or ""
    # Restoring a builtin replaces every stage the pipeline has, so it needs the
    # same guard as editing one stage — the helper's question ("is this the
    # pipeline the run is using?") is exactly the one to ask here.
    if _stage_edit_hits_running_pipeline(ws_path, pipeline_id):
        await session.send_json(
            make_error(msg_id, msg_type, "PIPELINE_RUNNING", "Cannot reset stages while the active pipeline is running")
        )
        return
    pipeline = app.stages_store.reset_builtin(pipeline_id)
    pipelines = app.stages_store.list_pipelines()
    stages = app.stages_store.list(pipeline_id)
    await session.send_json(
        make_response(msg_id, msg_type, {"pipeline": pipeline, "pipelines": pipelines})
    )
    await app.broadcast(make_event("pipelines.changed", {
        "pipelines": pipelines,
        "active_pipeline_id": app.stages_store.get_active_pipeline_id(),
        "reason": "reset_builtin",
    }))
    await app.broadcast(make_event("stages.changed", {
        "stages": stages,
        "pipeline_id": pipeline_id,
        "reason": "reset_builtin",
    }))


# ── Stages registry (stages.*) ──────────────────────────────────────────────
def _stage_edit_hits_running_pipeline(ws_path: str, pipeline_id: str | None) -> bool:
    """True when the pipeline a stage edit targets is the one a run is using.

    The comparison is against the pipeline the run recorded (pipeline.start
    writes Project.pipeline_id), not against whether the request bothered to
    name a pipeline: naming the running one explicitly used to walk straight
    past the guard and edit the flow mid-run.
    """
    from . import app

    if not ws_path:
        return False
    proj = app.project_store.peek(ws_path)
    if not pipeline_liveness.run_is_live(proj):
        return False
    if not pipeline_id:
        # No id means "the active pipeline", which is what the run uses.
        return True
    # A parent suspended at a sub-pipeline resumes on its own definition, so
    # it is as much in use as the child's.
    parents = {str((f.get("run") or {}).get("pipeline_id") or "") for f in getattr(proj, "run_stack", None) or []}
    return pipeline_id == (proj.pipeline_id or app.stages_store.get_active_pipeline_id()) or pipeline_id in parents


async def _broadcast_pipeline_summaries(reason: str) -> None:
    """Republish the pipeline list: it carries stage_count, so a stage edit that
    only broadcasts stages.changed leaves a stale "N stages" on screen."""
    from . import app

    await app.broadcast(make_event("pipelines.changed", {
        "pipelines": app.stages_store.list_pipelines(),
        "active_pipeline_id": app.stages_store.get_active_pipeline_id(),
        "reason": reason,
    }))


@handler("stages.list")
async def stages_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    pipeline_id = payload.get("pipeline_id") or None
    stages = app.stages_store.list(pipeline_id)
    active_id = app.stages_store.get_active_pipeline_id()
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {"stages": stages, "path": str(app.stages_store.path), "pipeline_id": pipeline_id or active_id},
        )
    )


@handler("stages.upsert")
async def stages_upsert(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    pipeline_id = payload.get("pipeline_id") or None
    ws_path = payload.get("workspace_path", "") or ""
    if _stage_edit_hits_running_pipeline(ws_path, pipeline_id):
        await session.send_json(
            make_error(msg_id, msg_type, "PIPELINE_RUNNING", "Cannot edit stages while the active pipeline is running")
        )
        return
    try:
        stage = app.stages_store.upsert(payload["stage"], pipeline_id)
    except GraphNonLinearError as err:
        await session.send_json(make_error(msg_id, msg_type, "GRAPH_NONLINEAR", str(err)))
        return
    effective_pipeline_id = pipeline_id or app.stages_store.get_active_pipeline_id()
    updated_stages = app.stages_store.list(pipeline_id)
    await session.send_json(
        make_response(msg_id, msg_type, {"stage": stage, "stages": updated_stages})
    )
    await app.broadcast(make_event("stages.changed", {
        "stages": updated_stages,
        "pipeline_id": effective_pipeline_id,
        "reason": "upsert",
    }))
    await _broadcast_pipeline_summaries("stage_upsert")


@handler("stages.reorder")
async def stages_reorder(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    pipeline_id = payload.get("pipeline_id") or None
    ws_path = payload.get("workspace_path", "") or ""
    if _stage_edit_hits_running_pipeline(ws_path, pipeline_id):
        await session.send_json(
            make_error(msg_id, msg_type, "PIPELINE_RUNNING", "Cannot reorder stages while the active pipeline is running")
        )
        return
    try:
        updated_stages = app.stages_store.reorder(payload["ids"], pipeline_id)
    except GraphNonLinearError as err:
        await session.send_json(make_error(msg_id, msg_type, "GRAPH_NONLINEAR", str(err)))
        return
    effective_pipeline_id = pipeline_id or app.stages_store.get_active_pipeline_id()
    await session.send_json(
        make_response(msg_id, msg_type, {"stages": updated_stages})
    )
    await app.broadcast(make_event("stages.changed", {
        "stages": updated_stages,
        "pipeline_id": effective_pipeline_id,
        "reason": "reorder",
    }))
    await _broadcast_pipeline_summaries("stage_reorder")


@handler("stages.delete")
async def stages_delete(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    pipeline_id = payload.get("pipeline_id") or None
    ws_path = payload.get("workspace_path", "") or ""
    if _stage_edit_hits_running_pipeline(ws_path, pipeline_id):
        await session.send_json(
            make_error(msg_id, msg_type, "PIPELINE_RUNNING", "Cannot delete stages while the active pipeline is running")
        )
        return
    try:
        updated_stages = app.stages_store.delete(payload["id"], pipeline_id)
    except GraphNonLinearError as err:
        await session.send_json(make_error(msg_id, msg_type, "GRAPH_NONLINEAR", str(err)))
        return
    effective_pipeline_id = pipeline_id or app.stages_store.get_active_pipeline_id()
    await session.send_json(
        make_response(msg_id, msg_type, {"stages": updated_stages})
    )
    await app.broadcast(make_event("stages.changed", {
        "stages": updated_stages,
        "pipeline_id": effective_pipeline_id,
        "reason": "delete",
    }))
    await _broadcast_pipeline_summaries("stage_delete")


@handler("stages.reset")
async def stages_reset(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    pipeline_id = payload.get("pipeline_id") or None
    ws_path = payload.get("workspace_path", "") or ""
    if _stage_edit_hits_running_pipeline(ws_path, pipeline_id):
        await session.send_json(
            make_error(msg_id, msg_type, "PIPELINE_RUNNING", "Cannot reset stages while the active pipeline is running")
        )
        return
    updated_stages = app.stages_store.reset(pipeline_id)
    effective_pipeline_id = pipeline_id or app.stages_store.get_active_pipeline_id()
    await session.send_json(
        make_response(msg_id, msg_type, {"stages": updated_stages})
    )
    await app.broadcast(make_event("stages.changed", {
        "stages": updated_stages,
        "pipeline_id": effective_pipeline_id,
        "reason": "reset",
    }))
    await _broadcast_pipeline_summaries("stage_reset")


# ── Pipeline graph (pipelines.graph.*) ──────────────────────────────────────
# Contract: src/renderer/src/lib/pipelineGraph.ts (file header).
@handler("pipelines.graph.get")
async def pipelines_graph_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    try:
        out = app.stages_store.get_graph(payload.get("pipeline_id") or None)
    except KeyError as err:
        await session.send_json(_pipeline_not_found(msg_id, msg_type, err))
        return
    await session.send_json(make_response(msg_id, msg_type, out))


def _pipeline_not_found(msg_id: str, msg_type: str, err: KeyError) -> dict:
    return make_error(msg_id, msg_type, "PIPELINE_NOT_FOUND", str(err.args[0] if err.args else err))


async def _write_graph(session: "Session", msg_id: str, msg_type: str, payload: dict, write: Any, reason: str) -> None:
    from . import app
    from .pipeline_graph import GraphError

    pipeline_id = payload.get("pipeline_id") or None
    ws_path = payload.get("workspace_path", "") or ""
    if _stage_edit_hits_running_pipeline(ws_path, pipeline_id):
        await session.send_json(
            make_error(msg_id, msg_type, "PIPELINE_RUNNING", "Cannot edit the graph while the pipeline is running")
        )
        return
    try:
        out = write(pipeline_id)
    except GraphError as err:
        await session.send_json(make_error(msg_id, msg_type, "GRAPH_INVALID", str(err), {"errors": err.errors}))
        return
    except KeyError as err:
        await session.send_json(_pipeline_not_found(msg_id, msg_type, err))
        return
    await session.send_json(make_response(msg_id, msg_type, out))
    await _broadcast_graph_change(out, reason)


async def _broadcast_graph_change(out: dict, reason: str) -> None:
    """graph_changed first (the canvas), then the two events every legacy
    view already listens to, since the derived stages changed with it."""
    from . import app

    await app.broadcast(make_event("pipeline.graph_changed", {**out, "reason": reason}))
    await app.broadcast(make_event("stages.changed", {
        "stages": out["stages"],
        "pipeline_id": out["pipeline_id"],
        "reason": reason,
    }))
    await _broadcast_pipeline_summaries(reason)


@handler("pipelines.graph.set")
async def pipelines_graph_set(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    graph = payload["graph"]
    await _write_graph(
        session, msg_id, msg_type, payload,
        lambda pid: app.stages_store.set_graph(pid, graph), "graph_set",
    )


@handler("pipelines.graph.apply")
async def pipelines_graph_apply(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ops = payload["ops"]
    await _write_graph(
        session, msg_id, msg_type, payload,
        lambda pid: app.stages_store.apply_graph_ops(pid, ops), "graph_apply",
    )


# ── Analyzer (local LLM / Ollama) (analyzer.*) ──────────────────────────────
@handler("analyzer.detect_llama_cli")
async def analyzer_detect_llama_cli(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    import shutil as _shutil
    candidates = [
        "llama-completion",
        "llama-cli",
        "/opt/homebrew/bin/llama-completion",
        "/opt/homebrew/bin/llama-cli",
        "/usr/local/bin/llama-completion",
        "/usr/local/bin/llama-cli",
    ]
    found = []
    for c in candidates:
        p = _shutil.which(c) or (c if __import__("os.path", fromlist=["exists"]).exists(c) else None)
        if p and p not in found:
            found.append(p)
    await session.send_json(make_response(msg_id, msg_type, {
        "found": found,
        "recommended": found[0] if found else None,
    }))


@handler("analyzer.settings.get")
async def analyzer_settings_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    await session.send_json(
        make_response(msg_id, msg_type, app.analyzer_settings_store.get())
    )


@handler("analyzer.settings.set")
async def analyzer_settings_set(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    updated = app.analyzer_settings_store.set(payload)
    await session.send_json(make_response(msg_id, msg_type, updated))
    await app.broadcast(make_event("analyzer.settings_changed", updated))


@handler("analyzer.health")
async def analyzer_health_h(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    data = await app.analyzer_health()
    data["default_model"] = app.ANALYZER_DEFAULT_MODEL
    data["backend"] = app._az_settings().get("backend", "llama_cpp")
    await session.send_json(make_response(msg_id, msg_type, data))


@handler("analyzer.models")
async def analyzer_models(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    models = await app.analyzer_list_models()
    await session.send_json(
        make_response(msg_id, msg_type, {"models": models, "default": app.ANALYZER_DEFAULT_MODEL})
    )


@handler("analyzer.classify")
async def analyzer_classify_h(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    text = payload.get("text", "") or ""
    model = payload.get("model") or app.ANALYZER_DEFAULT_MODEL
    # llama_cpp calls are serialised via _llama_sem (analyzer.py); if one
    # is already running, this call will queue behind it for up to 60s.
    # Tell the frontend now so it shows "queued" instead of looking hung.
    if not app._az_is_ollama() and app._llama_cli_busy():
        await app.broadcast(make_event("analyzer.queued", {
            "pane_id": payload.get("pane_id") or "",
            "stage_id": payload.get("stage_id") or "",
            "workspace_path": payload.get("workspace_path") or "",
        }))
    result = await app.analyzer_classify(text, model)
    app._record_analyzer_tokens(result, payload)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("analyzer.benchmark")
async def analyzer_benchmark_h(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    async def _benchmark_bg() -> None:
        async def _on_progress(
            model: str, task_id: str, passed: bool, elapsed_s: float, score: int
        ) -> None:
            await app.broadcast(make_event("analyzer.benchmark_progress", {
                "model": model, "task_id": task_id,
                "passed": passed, "elapsed_s": elapsed_s, "score": score,
            }))
        try:
            results = await app.analyzer_benchmark(progress_cb=_on_progress)
            await app.broadcast(make_event("analyzer.benchmark_done", {"results": results}))
        except Exception as _bench_err:  # noqa: BLE001
            app.log.warning("benchmark error: %s", _bench_err)
            await app.broadcast(make_event("analyzer.benchmark_done", {"results": [], "error": str(_bench_err)}))

    # Tracked like every other handler task (see Session._handler_tasks): the
    # progress it reports goes to this connection's UI, so outliving the
    # connection means holding Ollama — up to 25s per task per installed model —
    # to broadcast into an empty set. Keeping the reference also satisfies
    # CPython's requirement that a create_task result stay reachable.
    task = asyncio.create_task(_benchmark_bg())
    session._handler_tasks.add(task)
    task.add_done_callback(session._handler_tasks.discard)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "started": True}))


@handler("analyzer.pull")
async def analyzer_pull(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # Only valid in Ollama mode.
    model_name = payload.get("name", "")
    if not model_name:
        await session.send_json(
            make_response(msg_id, msg_type, {"ok": False, "error": "name required"})
        )
    elif not app._az_is_ollama():
        await session.send_json(
            make_response(msg_id, msg_type, {"ok": False, "error": "pull only available in Ollama mode"})
        )
    else:
        async def _pull_bg(name: str = model_name) -> None:
            try:
                async for progress in app._ollama_pull_model(name, app._az_base_url()):
                    await app.broadcast(make_event("analyzer.pull_progress", {"name": name, **progress}))
                await app.broadcast(make_event("analyzer.pull_done", {"name": name, "ok": True}))
            except Exception as _pull_err:
                await app.broadcast(make_event("analyzer.pull_done", {"name": name, "ok": False, "error": str(_pull_err)}))

        # Tracked for the same reason as the benchmark above. A cancelled pull
        # is recoverable: Ollama keeps the blobs it already wrote, so pressing
        # download again resumes rather than restarts.
        task = asyncio.create_task(_pull_bg())
        session._handler_tasks.add(task)
        task.add_done_callback(session._handler_tasks.discard)
        await session.send_json(make_response(msg_id, msg_type, {"ok": True, "started": True}))


@handler("analyzer.delete")
async def analyzer_delete(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    model_name = payload.get("name", "")
    if not model_name:
        await session.send_json(
            make_response(msg_id, msg_type, {"ok": False, "error": "name required"})
        )
    elif not app._az_is_ollama():
        await session.send_json(
            make_response(msg_id, msg_type, {"ok": False, "error": "delete only available in Ollama mode"})
        )
    else:
        result = await app._ollama_delete_model(model_name, app._az_base_url())
        await session.send_json(make_response(msg_id, msg_type, result))


@handler("analyzer.ollama_health")
async def analyzer_ollama_health(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    data = await app._ollama_health(app._az_base_url())
    await session.send_json(make_response(msg_id, msg_type, data))


# ── Token stats (tokens.*) ──────────────────────────────────────────────────
@handler("tokens.snapshot")
async def tokens_snapshot(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    workspace_path = payload.get("workspace_path") or None
    # Answer from the cached scan results immediately; anything whose session
    # log changed since is rescanned in the background and lands as a
    # `tokens.changed` broadcast.
    app.refresh_live_scans(workspace_path or "")
    snap = app.tokens_store.snapshot(workspace_path)
    await session.send_json(make_response(msg_id, msg_type, snap))


@handler("tokens.turns")
async def tokens_turns(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # Per-turn cut of one session log, read on demand (contract: at least
    # pane_id or session_id; the reply shape is fixed by the Turn Stats
    # window, errors are ok:false + error code).
    result = await app.scan_session_turns(
        pane_id=str(payload.get("pane_id") or ""),
        session_id=str(payload.get("session_id") or ""),
        agent_key=str(payload.get("agent_key") or ""),
        include_calls=bool(payload.get("include_calls")),
    )
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("tokens.reset")
async def tokens_reset(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    scope = payload.get("scope", "run")
    snap = app.tokens_store.reset(scope, payload.get("workspace_path") or None)
    await session.send_json(make_response(msg_id, msg_type, snap))
    await app.broadcast(make_event("tokens.changed", snap))


@handler("tokens.quota_cycles")
async def tokens_quota_cycles(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # One account's quota cycles (contract-dimensions §3): newest reset first,
    # open cycles summed live. Only an unknown vendor is an error; an account
    # with nothing recorded answers ok with an empty list.
    agent_key = str(payload.get("agent_key") or "")
    profile_id = str(payload.get("profile_id") or "")
    window_kind = str(payload.get("window_kind") or "") or None
    if agent_key not in CLI_VENDORS:
        await session.send_json(make_response(
            msg_id, msg_type, {"ok": False, "error": "unknown-vendor"}))
        return
    try:
        await asyncio.to_thread(app.quota_ledger.reconcile_pending, app.tokens_store)
        result = await asyncio.to_thread(
            app.quota_ledger.query_cycles, agent_key, profile_id, window_kind,
            **{key: payload[key] for key in (
                "range_start", "range_end", "include_current", "limit", "cursor", "snapshot", "export",
            ) if key in payload},
        )
    except ValueError as err:
        result = {"ok": False, "error": str(err)}
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("tokens.quota_accounts")
async def tokens_quota_accounts(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    agent_key = str(payload.get("agent_key") or "")
    if agent_key and agent_key not in CLI_VENDORS:
        await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": "unknown-vendor"}))
        return
    quota = await asyncio.to_thread(app.quota_ledger.identities)
    tokens = {(a, p) for a, p, _day, _bucket in app.tokens_store.account_day_rows()}
    await session.send_json(make_response(msg_id, msg_type, {
        "ok": True, "accounts": [
            {"agent_key": a, "profile_id": p, "has_quota_history": (a, p) in quota,
             "has_token_history": (a, p) in tokens}
            for a, p in sorted(quota | tokens) if not agent_key or a == agent_key
        ],
    }))


@handler("tokens.quota_exhausted")
async def tokens_quota_exhausted(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app
    from .pane_account_history import UNKNOWN_PROFILE_ID, parse_event_time

    # The renderer saw the CLI's "hit your limit" message in a pane: stamp
    # the cycle that message named with that moment when it beats the first
    # 100 % sample. No account for the pane → nothing to stamp (ok, empty).
    # Same for a message with no reset clock in it: which window ran out is
    # then unknown, and the ledger declines to guess.
    agent_key = str(payload.get("agent_key") or "")
    pane_id = str(payload.get("pane_id") or "")
    at = parse_event_time(str(payload.get("at") or ""))
    resets_at = parse_event_time(str(payload.get("resets_at") or ""))
    if agent_key not in CLI_VENDORS:
        await session.send_json(make_response(
            msg_id, msg_type, {"ok": False, "error": "unknown-vendor"}))
        return
    profile_id = app.pane_account_history.profile_at(pane_id, at)
    updated: list[str] = []
    if at is not None and profile_id != UNKNOWN_PROFILE_ID:
        updated = await asyncio.to_thread(
            app.quota_ledger.mark_exhausted, agent_key, profile_id, at, resets_at,
            window_kind=str(payload.get("window_kind") or "") or None,
            model_scope=str(payload.get("model_scope") or "") or None,
            reset_precision=str(payload.get("reset_precision") or "unknown"),
        )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "updated": updated}))
    for window_kind in updated:
        await app.broadcast(make_event("tokens.quota_cycles_changed", {
            "agent_key": agent_key, "profile_id": profile_id, "window_kind": window_kind,
        }))


@handler("tokens.account_periods")
async def tokens_account_periods(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # Monthly / yearly per-account totals (contract-dimensions §4): the
    # by_account_day ledger summed per period, joined with the quota cycle
    # counts of the same period. Both filters optional.
    agent_key = str(payload.get("agent_key") or "")
    profile_id = str(payload.get("profile_id") or "")
    granularity = "year" if payload.get("granularity") == "year" else "month"
    if agent_key and agent_key not in CLI_VENDORS:
        await session.send_json(make_response(
            msg_id, msg_type, {"ok": False, "error": "unknown-vendor"}))
        return
    try:
        await asyncio.to_thread(app.quota_ledger.reconcile_pending, app.tokens_store)
        result = await asyncio.to_thread(
            app.account_periods, agent_key, profile_id, granularity,
            **{key: payload[key] for key in (
                "range_start", "range_end", "window_kind", "offset", "limit", "export",
            ) if key in payload},
        )
    except ValueError as err:
        result = {"ok": False, "error": str(err)}
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("tokens.monitor")
async def tokens_monitor(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from .token_monitor import snapshot

    result = await snapshot(payload.get("days", 30))
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("devtime.snapshot")
async def devtime_snapshot(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    workspace_path = str(payload.get("workspace_path") or "")
    snap = app.dev_time_store.snapshot(workspace_path)
    await session.send_json(make_response(msg_id, msg_type, snap))
    # First look at a workspace: replay its pre-feature Claude transcripts
    # once, off the loop; the panel hears about the rows via devtime.changed.
    app.dev_time_store.start_backfill(
        workspace_path,
        lambda ws: app.broadcast(make_event("devtime.changed", {"workspace_path": ws})),
    )


@handler("devtime.reset")
async def devtime_reset(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    workspace_path = str(payload.get("workspace_path") or "")
    app.dev_time_store.reset(workspace_path)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))
    await app.broadcast(make_event("devtime.changed", {"workspace_path": workspace_path}))


# ── Pipeline history (timeline) (history.*) ─────────────────────────────────
@handler("history.snapshot")
async def history_snapshot(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    # Resolve the active run's folder so the timeline scopes to it.
    _proj = app.project_store.peek(ws_path) if ws_path else None
    _log_name = _proj.log_file_name if _proj else ""
    run_dir = _log_name.rsplit("/", 1)[0] if "/" in _log_name else ""
    snap = app.history_store.snapshot(ws_path, run_dir, int(payload.get("limit", 500)))
    await session.send_json(make_response(msg_id, msg_type, snap))


# ── Cloud issues (issues.*) ─────────────────────────────────────────────────
# GitHub via gh / GitLab via glab, host auto-detected from origin remote.
# No git.changed broadcast — issues are remote state, not local repo state.
@handler("issues.provider")
async def issues_provider(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.issue_service.detect_provider(ws_path)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("issues.list")
async def issues_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    limit = payload.get("limit") or 30
    result = await app.issue_service.list_issues(ws_path, limit)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("issues.get")
async def issues_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    number = payload.get("number")
    result = await app.issue_service.get_issue(ws_path, number)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("issues.create")
async def issues_create(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    title = payload.get("title") or ""
    body = payload.get("body") or ""
    result = await app.issue_service.create_issue(ws_path, title, body)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("issues.comment")
async def issues_comment(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    number = payload.get("number")
    body = payload.get("body") or ""
    result = await app.issue_service.comment_issue(ws_path, number, body)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("issues.set_state")
async def issues_set_state(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    number = payload.get("number")
    state = payload.get("state") or ""
    result = await app.issue_service.set_issue_state(ws_path, number, state)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("issues.public")
async def issues_public(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Run one fixed, Host-authenticated public Issue operation."""
    from . import app

    if not session.host_authenticated:
        await session.send_json(
            make_error(msg_id, msg_type, "UNAUTHORIZED", "Host session is not authenticated")
        )
        return
    if (
        not isinstance(payload, dict)
        or set(payload) != {"workspace_path", "operation", "arguments", "execution_policy"}
        or not isinstance(payload.get("workspace_path"), str)
        or not payload["workspace_path"].strip()
        or not isinstance(payload.get("operation"), str)
        or payload["operation"] not in {
            "provider", "list", "get", "create", "comment", "set_state",
        }
        or not isinstance(payload.get("arguments"), dict)
        or not isinstance(payload.get("execution_policy"), dict)
    ):
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "issues.public request is malformed")
        )
        return

    workspace_path = payload["workspace_path"]
    resolved_cwd = app.Path(workspace_path).resolve()
    known_roots = app.attribution.existing_workspace_roots()
    registered_root = next(
        (
            root
            for root in known_roots
            if resolved_cwd == root or resolved_cwd.is_relative_to(root)
        ),
        None,
    )
    if registered_root is None:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "workspace path not registered")
        )
        return
    if not resolved_cwd.is_dir():
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "invalid workspace path")
        )
        return

    try:
        result = await app.issue_service.public_request(
            payload["operation"],
            str(resolved_cwd),
            payload["arguments"],
            payload["execution_policy"],
        )
    except ValueError as exc:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", str(exc)))
        return
    except PermissionError as exc:
        await session.send_json(make_error(msg_id, msg_type, "PERMISSION_DENIED", str(exc)))
        return
    await session.send_json(make_response(msg_id, msg_type, result))


# ── Shell run (shell.run) ───────────────────────────────────────────────────
# Security notes:
# - Manifest v2 public calls take the ``host_mode=allowlist`` branch above and
#   use the Host shell broker. The shell-backed branch below is retained for
#   legacy terminal.run compatibility until that later migration removes it.
# - The legacy branch uses create_subprocess_exec('/bin/sh', '-c', cmd) instead
#   of create_subprocess_shell to avoid implicit shell injection.
# - ws_path is resolved and validated to be an existing directory.
# - Frontend shows full command in confirm dialog before invoking.
# - This is a local-only Electron app; the WebSocket server binds to
#   localhost only, reducing (but not eliminating) external attack surface.
_SHELL_RUN_TIMEOUT_S = 30
# Each text field of a shell.run response carries at most this many characters
# (unchanged). What was cut is disclosed with ``truncated`` and the full UTF-8
# size (``stdoutBytes``; ``stderrBytes`` when stderr was cut too).
_SHELL_RUN_OUTPUT_CHARS = 8000


def _shell_run_truncation(stdout: str, stderr: str = "") -> dict:
    """``truncated`` plus the full sizes of what shell.run cut at 8000 characters."""
    fields: dict = {
        "truncated": len(stdout) > _SHELL_RUN_OUTPUT_CHARS or len(stderr) > _SHELL_RUN_OUTPUT_CHARS,
        "stdoutBytes": len(stdout.encode("utf-8", "replace")),
    }
    if len(stderr) > _SHELL_RUN_OUTPUT_CHARS:
        fields["stderrBytes"] = len(stderr.encode("utf-8", "replace"))
    return fields


@handler("shell.run")
async def shell_run(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    cmd = payload.get("command", "") or ""
    if payload.get("host_mode") == "allowlist":
        if not isinstance(ws_path, str) or not ws_path.strip():
            await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": "workspace path is required"}))
            return
        resolved_cwd = app.Path(ws_path).resolve()
        known_roots = app.attribution.existing_workspace_roots()
        registered_root = next((root for root in known_roots if (
            resolved_cwd == root or resolved_cwd.is_relative_to(root)
        )), None)
        cwd_allowed = registered_root is not None
        if not cwd_allowed:
            await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": "workspace path not registered"}))
            return
        if resolved_cwd and not resolved_cwd.is_dir():
            await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": "invalid workspace path"}))
            return
        try:
            argv = parse_public_allowlisted_command(
                cmd,
                cwd=str(resolved_cwd),
                workspace_root=str(registered_root),
            )
        except ValueError as exc:
            await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": str(exc)}))
            return
        rc, stdout, stderr = await run_public_allowlisted_text(
            argv,
            str(resolved_cwd),
            workspace_root=str(registered_root),
            timeout=30.0,
        )
        await session.send_json(make_response(msg_id, msg_type, {
            "ok": True,
            "output": stdout[:8000],
            "stdout": stdout[:8000],
            "stderr": stderr[:8000],
            "exit_code": rc,
            **_shell_run_truncation(stdout, stderr),
        }))
        return
    if not cmd:
        await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": "no command"}))
    elif not isinstance(ws_path, str) or not ws_path.strip():
        # Required here too: without one this branch skipped the workspace
        # check below and ran the command in the backend's own cwd (d1).
        await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": "workspace path is required"}))
    else:
        resolved_cwd = app.Path(ws_path).resolve()
        # Validate that cwd is a known registered workspace (or its subdirectory)
        known_roots = app.attribution.existing_workspace_roots()
        cwd_allowed = any(
            resolved_cwd == r or resolved_cwd.is_relative_to(r)
            for r in known_roots
        )
        if not cwd_allowed:
            await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": "workspace path not registered"}))
        elif resolved_cwd and not resolved_cwd.is_dir():
            await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": "invalid workspace path"}))
        else:
            try:
                proc = await asyncio.create_subprocess_exec(
                    *osplat.paths.shell_command(cmd),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    cwd=str(resolved_cwd) if resolved_cwd else None,
                    # Own group, so a timeout reaches what sh started too.
                    start_new_session=True,
                )
                try:
                    stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=_SHELL_RUN_TIMEOUT_S)
                    output = stdout.decode("utf-8", errors="replace")
                    await session.send_json(make_response(msg_id, msg_type, {
                        "ok": True, "output": output[:8000], "exit_code": proc.returncode,
                        **_shell_run_truncation(output),
                    }))
                except asyncio.TimeoutError:
                    from .ai_chat_cli_engine import _terminate_proc_tree

                    # Killing only sh orphaned its children, and one still
                    # holding the stdout pipe kept communicate() waiting.
                    await _terminate_proc_tree(proc)
                    await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": f"timeout after {_SHELL_RUN_TIMEOUT_S}s"}))
            except Exception as exc:
                await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": str(exc)}))


# ── Onboarding (onboarding.*) ───────────────────────────────────────────────
@handler("onboarding.status")
async def onboarding_status(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # fresh=True re-probes the login-shell PATH (sent right after an install,
    # whose PATH export the cache cannot have seen yet).
    fresh = bool(payload.get("fresh"))
    loop = asyncio.get_running_loop()
    status = await loop.run_in_executor(
        _ONBOARDING_EXECUTOR,
        in_data_dir(app_data_dir(), lambda: app.onboarding_deps.get_status(fresh=fresh)),
    )
    status["complete"] = app.onboarding_deps.is_complete()
    await session.send_json(make_response(msg_id, msg_type, status))


@handler("onboarding.status_quick")
async def onboarding_status_quick(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """PATH-presence-only pass for the UI's first paint (see quick_status).

    Runs inline: pure filesystem stats, no subprocesses — and it must NOT go
    through _ONBOARDING_EXECUTOR, whose single worker would queue it behind a
    multi-second full get_status and defeat the point."""
    from . import app

    status = app.onboarding_deps.quick_status()
    status["complete"] = app.onboarding_deps.is_complete()
    await session.send_json(make_response(msg_id, msg_type, status))


#: The agent_key of a PTY started by onboarding.run. Reserved: terminal.create
#: refuses it, so no renderer can open a pane that passes as an install run.
ONBOARDING_RUN_AGENT_KEY = "onboarding-run"


@handler("onboarding.run")
async def onboarding_run(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Start a whitelisted install / maintenance / ollama command in a PTY.

    The window names a kind and ids; the command comes from the registry via
    onboarding_deps.resolve_run, with the same prerequisite checks as before.
    Output, input, resize, kill and the exit code then travel over the
    ordinary terminal.* messages, keyed by the returned run_id.
    """
    from . import app

    try:
        cols = int(payload.get("cols") or 100)
        rows = int(payload.get("rows") or 24)
    except (TypeError, ValueError):
        # A malformed request, not a PTY failure: no external-terminal fallback.
        await session.send_json(make_error(
            msg_id, msg_type, "BAD_REQUEST", "cols and rows must be integers",
        ))
        return
    # Offloaded: pull_model's reachability check shells out to `ollama list`.
    resolved = await asyncio.to_thread(
        in_data_dir(app_data_dir(), app.onboarding_deps.resolve_run, payload)
    )
    if not resolved.get("ok"):
        await session.send_json(make_response(msg_id, msg_type, resolved))
        return
    command = str(resolved["command"])
    try:
        term = session.terminals.create(
            pane_id=f"{ONBOARDING_RUN_AGENT_KEY}-{__import__('uuid').uuid4().hex}",
            agent_key=ONBOARDING_RUN_AGENT_KEY,
            command=app.onboarding_deps.run_argv(command),
            cwd=str(Path.home()),
            cols=cols,
            rows=rows,
        )
    except (OSError, RuntimeError, ValueError) as exc:
        # The command is still returned: the window offers it in an external
        # terminal, so a PTY failure never makes the install impossible.
        log.warning("onboarding.run could not start %r: %s", command, exc)
        await session.send_json(make_response(msg_id, msg_type, {
            **resolved, "ok": False, "spawn_failed": True, "error": str(exc),
        }))
        return
    app._PTY_OWNERS[term.id] = session
    session._onboarding_runs.add(term.id)
    log.info("onboarding.run %s started: %s", term.id, command)
    await session.send_json(make_response(msg_id, msg_type, {**resolved, "run_id": term.id}))


@handler("onboarding.complete")
async def onboarding_complete(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    result = app.onboarding_deps.set_complete(bool(payload.get("complete", True)))
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("onboarding.install_prompt")
async def onboarding_install_prompt(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Silence (or restore) the guided-install prompt for one CLI."""
    from . import app

    result = app.onboarding_deps.set_install_prompt_dismissed(
        str(payload.get("dep_id") or ""),
        bool(payload.get("dismissed", True)),
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    # The opt-out is a per-user setting stored once in the backend, but each
    # window keeps its own mirror of it and only loads that mirror at startup.
    # Without this a second window keeps prompting for a CLI the user just
    # switched off. Broadcasting the whole list rather than the one flip keeps
    # every mirror idempotent — a window that missed an earlier event is
    # repaired by the next one.
    if result.get("ok"):
        await app.broadcast(make_event("cli.install_prompt_changed", {
            "dismissed_ids": app.onboarding_deps.install_prompt_dismissals(),
        }))


@handler("codex.hook_trust_blocked")
async def codex_hook_trust_blocked(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """The window saw Codex demand approval for the hook Navide injects.

    Reported rather than predicted: whether a Codex build gates a command-line
    hook behind its trust screen cannot be read off a version number, and a
    machine where it does would otherwise open every pane onto a modal. Later
    spawns leave the hook out; nothing in the user's environment is written.
    Idempotent — the window may report the same screen more than once.
    """
    from . import codex_session_hooks

    blocked = bool(payload.get("blocked", True))
    changed = await asyncio.to_thread(codex_session_hooks.set_trust_gate_blocked, blocked)
    if changed:
        log.info(
            "codex hook injection %s: trust screen %s",
            "disabled" if blocked else "re-enabled",
            "reported by a pane" if blocked else "cleared",
        )
        await app_broadcast_hook_trust(blocked)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "blocked": blocked, "changed": changed}))


async def app_broadcast_hook_trust(blocked: bool) -> None:
    """Tell every window, so a second one does not report the same screen."""
    from . import app

    await app.broadcast(make_event("codex.hook_trust_changed", {"blocked": blocked}))


@handler("onboarding.cli_health.dismiss")
async def onboarding_cli_health_dismiss(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    result = app.onboarding_deps.dismiss_cli_health(str(payload.get("fingerprint") or ""))
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("onboarding.cli_autoupdate")
async def onboarding_cli_autoupdate(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    result = app.onboarding_deps.set_cli_autoupdate_policy(
        str(payload.get("agent_key") or ""),
        str(payload.get("policy") or ""),
    )
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("onboarding.cli_health.select_binary")
async def onboarding_cli_health_select_binary(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    result = app.onboarding_deps.select_cli_binary(
        str(payload.get("agent_key") or ""),
        str(payload.get("path") or ""),
    )
    await session.send_json(make_response(msg_id, msg_type, result))


# ── AI settings + review (ai.chat.settings.*, ai.review.*) ───────────────────
# ai.chat.settings.* outlives the removed AI chat: review and
# git.generate_message still read the shared system prompt from it.
@handler("ai.chat.settings.get")
async def ai_chat_settings_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    await session.send_json(make_response(msg_id, msg_type, app.ai_chat_settings_store.get()))


@handler("ai.chat.settings.set")
async def ai_chat_settings_set(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    updated = app.ai_chat_settings_store.set(payload)
    await session.send_json(make_response(msg_id, msg_type, updated))


@handler("ai.review.stop")
async def ai_review_stop(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    for t in list(session._review_tasks):
        t.cancel()
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("ai.review.start")
async def ai_review_start(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # Cancel any in-progress review before starting a new one.
    for _t in list(session._review_tasks):
        _t.cancel()
    session._review_tasks.clear()
    ws_path = payload.get("workspace_path") or ""
    review_id = payload.get("review_id") or str(__import__("uuid").uuid4())
    mode = payload.get("mode") or "working"  # "working" | "branch"
    base = payload.get("base") or ""
    compare = payload.get("compare") or ""

    async def _run_review(rid=review_id, m=mode, b=base, c=compare, ws=ws_path):
        import re as _re
        import json as _json
        from .review_service import stream_review
        try:
            await app._ensure_fresh_path_for_spawn("claude")
            if m == "branch":
                _b = b or "main"
                if not c:
                    _rc, _cur, _ = await app.git_service._run(
                        ["git", "rev-parse", "--abbrev-ref", "HEAD"], ws
                    )
                    _c = _cur.strip() if _rc == 0 and _cur.strip() else "HEAD"
                else:
                    _c = c
                diff_result = await app.git_service.diff_branches(ws, _b, _c)
                diff = diff_result.get("diff", "") if diff_result.get("ok") else ""
            else:
                # working mode: staged + unstaged (git diff HEAD)
                diff_result = await app.git_service.diff_branches(ws, "", "")
                diff = diff_result.get("diff", "") if diff_result.get("ok") else ""
            _truncated = diff_result.get("truncated", False) if diff_result.get("ok") else False
            chunks: list[str] = []
            async for chunk in stream_review(diff, truncated=_truncated, workspace_path=ws):
                chunks.append(chunk)
            # Parse and validate structured JSON result from streamed text
            full_text = "".join(chunks)
            try:
                # Use raw_decode so it stops at the matching closing brace,
                # handling both: (a) embedded ```fences``` inside JSON string
                # values (where .*? would truncate) and (b) multiple JSON
                # blocks in the output (where .* would merge them).
                _fence_mo = _re.search(r"```json\s*", full_text)
                raw = None
                if _fence_mo:
                    try:
                        raw, _ = _json.JSONDecoder().raw_decode(
                            full_text[_fence_mo.end():].lstrip()
                        )
                    except _json.JSONDecodeError:
                        raw = None
                if raw:
                    _VALID_VERDICTS = {"approve", "approve_with_comments", "request_changes"}
                    _VALID_SEVS = {"critical", "warning", "suggestion"}
                    validated: dict = {
                        "summary": str(raw.get("summary", "")),
                        "verdict": raw.get("verdict") if raw.get("verdict") in _VALID_VERDICTS else "approve_with_comments",
                        "findings": [],
                    }
                    for _i, _f in enumerate(raw.get("findings") or []):
                        if not isinstance(_f, dict):
                            continue
                        validated["findings"].append({
                            "id": str(_f.get("id") or f"f{_i}"),
                            "file": str(_f.get("file") or ""),
                            "line": _f["line"] if isinstance(_f.get("line"), int) else None,
                            "severity": _f.get("severity") if _f.get("severity") in _VALID_SEVS else "suggestion",
                            "title": str(_f.get("title") or ""),
                            "body": str(_f.get("body") or ""),
                        })
                    await app.broadcast(make_event("ai.review.result", {"review_id": rid, "result": validated}))
                else:
                    app.log.warning("ai.review: no ```json block found in LLM output")
            except Exception:
                app.log.warning("ai.review: failed to parse JSON from streamed output")
            await app.broadcast(make_event("ai.review.end", {"review_id": rid}))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            app.log.exception("ai.review.start failed: %s", exc)
            await app.broadcast(make_event("ai.review.error", {"review_id": rid, "message": str(exc)}))

    task = asyncio.create_task(_run_review())
    session._review_tasks.add(task)
    task.add_done_callback(session._review_tasks.discard)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "review_id": review_id}))


# ── ping ─────────────────────────────────────────────────────────────────────
@handler("ping")
async def ping(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    await session.send_json(
        make_response(msg_id, msg_type, {"pong": True, "echo": payload})
    )


# ── Terminals (terminal.*) ───────────────────────────────────────────────────
@handler("terminal.create")
async def terminal_create(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    if payload.get("agent_key") == ONBOARDING_RUN_AGENT_KEY:
        await session.send_json(make_error(
            msg_id, msg_type, "RESERVED_AGENT_KEY",
            f"{ONBOARDING_RUN_AGENT_KEY} terminals are started by onboarding.run only",
        ))
        return
    pane_id = str(payload["pane_id"])
    generation = str(payload.get("create_generation") or msg_id)
    key = (pane_id, generation)
    gate = session._terminal_create_gates.setdefault(pane_id, asyncio.Lock())
    async with gate:
        existing = session._terminal_create_transactions.get(key)
        if existing and existing.get("committed"):
            app._PTY_OWNERS[existing["term_id"]] = session
            await session.send_json(
                make_response(msg_id, msg_type, existing["response_payload"])
            )
            return
        if key in session._terminal_create_tombstones:
            await session.send_json(
                make_error(
                    msg_id,
                    msg_type,
                    "CREATE_CANCELLED",
                    "terminal create was cancelled",
                    {"pane_id": pane_id, "create_generation": generation},
                )
            )
            return

        transaction: dict[str, Any] = {
            "pane_id": pane_id,
            "generation": generation,
            "cancelled": False,
            "committed": False,
            "term_id": "",
            "attribution_future": None,
            "attribution_started": False,
            "cleanup_task": None,
            "codex_home_id": "",
        }
        session._terminal_create_transactions[key] = transaction
        try:
            await _terminal_create_impl(
                session, msg_id, msg_type, payload, transaction, generation
            )
        except asyncio.CancelledError:
            await _rollback_terminal_create(session, transaction)
            raise
        except _TerminalCreateCancelled:
            await _rollback_terminal_create(session, transaction)
            if not session.dead:
                await session.send_json(
                    make_error(
                        msg_id,
                        msg_type,
                        "CREATE_CANCELLED",
                        "terminal create was cancelled",
                        {"pane_id": pane_id, "create_generation": generation},
                    )
                )
        except _TerminalCreateReapTimeout as err:
            # Its own code, not CREATE_CANCELLED: nobody cancelled this, and a
            # retry is the right response — the previous CLI has to be gone
            # first, and saying "cancelled" would hide that from the user.
            await _rollback_terminal_create(session, transaction)
            if not session.dead:
                await session.send_json(
                    make_error(
                        msg_id,
                        msg_type,
                        "CREATE_REAP_TIMEOUT",
                        "the previous CLI did not exit; refusing to start a "
                        "second one on the same session",
                        {
                            "pane_id": pane_id,
                            "create_generation": generation,
                            "terminal_session_id": err.terminal_id,
                        },
                    )
                )
        except quota_failover.FailoverRefused as err:
            await _rollback_terminal_create(session, transaction)
            session._terminal_create_transactions.pop(key, None)
            if not session.dead:
                await session.send_json(make_error(msg_id, msg_type, err.code, str(err), err.details))
        except BaseException:
            await _rollback_terminal_create(session, transaction)
            session._terminal_create_transactions.pop(key, None)
            raise


class _TerminalCreateCancelled(Exception):
    pass


class _TerminalCreateReapTimeout(Exception):
    """A PTY this create had to reap first outlived its kill.

    Raised instead of spawning. The reap ceiling covers the vendor's grace,
    the SIGKILL escalation and the wait that reaps the zombie, so reaching it
    means the old CLI survived a SIGKILL — and spawning the replacement then
    is the two-CLIs-on-one-session-file corruption both reap sites exist to
    prevent. Failing the create is recoverable (the user retries, or opens a
    fresh session); a corrupted transcript is not.
    """

    def __init__(self, terminal_id: str) -> None:
        super().__init__(terminal_id)
        self.terminal_id = terminal_id


async def _finish_pane_attribution(
    attribution_future: "asyncio.Future[None]", pane_id: str, codex_launch_token: str
) -> None:
    """Tail of terminal.create's attribution, detached from the ack."""
    from . import app

    try:
        await asyncio.shield(attribution_future)
    except Exception as err:  # noqa: BLE001 — the pane is already running; only its baseline is lost
        app.log.warning("baseline scan for pane %s failed: %s", pane_id, err)
        return
    # A SessionStart callback can arrive before the baseline scan completes.
    # Retry its already recorded transcript after claiming.
    if codex_launch_token:
        await app._retry_codex_session_start(codex_launch_token)


async def _rollback_terminal_create(
    session: "Session", transaction: dict[str, Any]
) -> None:
    async def cleanup() -> None:
        from . import app

        attribution_future = transaction.get("attribution_future")
        if attribution_future is not None:
            try:
                await asyncio.shield(attribution_future)
            except Exception:  # noqa: BLE001
                pass
        if transaction.get("attribution_started"):
            # register_pane runs in an executor and keeps running if its asyncio
            # waiter is cancelled.  Queue unregister behind it and await the
            # shared attribution lock so a late registration cannot revive.
            try:
                await asyncio.to_thread(
                    app.attribution.unregister_pane, transaction["pane_id"]
                )
            except Exception as err:  # noqa: BLE001
                app.log.warning("terminal create attribution rollback failed: %s", err)
        term_id = str(transaction.get("term_id") or "")
        if term_id:
            if app._PTY_OWNERS.get(term_id) is session:
                app._PTY_OWNERS.pop(term_id, None)
            await session.terminals.kill(term_id, force=True)
        snapshot = transaction.pop("store_login_snapshot", None)
        if snapshot is not None:
            agent_key, slot_id, scope_kw = snapshot
            async with app.credential_vault.switch_lock(agent_key):
                await vault_to_thread(functools.partial(
                    app.credential_vault.discard_pending_login, agent_key, slot_id, **scope_kw))
        # The per-pane CODEX_HOME this create prepared: without a rollout in
        # it there is nothing to resume, and a failed spawn used to leave one
        # behind every time (#121).
        await _reclaim_codex_home(str(transaction.get("codex_home_id") or ""))
        # The push channel was wired before the spawn, so a rolled-back create
        # would otherwise leave a registered channel — and a watch file — for a
        # pane that never came to exist.
        app.push_delivery.forget_pane(transaction["pane_id"])

    cleanup_task = transaction.get("cleanup_task")
    if cleanup_task is None:
        cleanup_task = asyncio.create_task(cleanup())
        transaction["cleanup_task"] = cleanup_task
    await asyncio.shield(cleanup_task)


# A panel CLI that exits non-zero this soon after its spawn never got going —
# typically a restore resuming a session its vendor no longer has. Left
# 'spawned', its record would make every window open retry the same launch.
_DOCK_FAILED_START_MS = 15_000
# Live panel PTYs whose launch outcome is still open:
# terminal session id -> (workspace, pane id, surface, session id).
_DOCK_PTYS: dict[str, tuple[str, str, str, str]] = {}


def _note_dock_pty(term_id: str, workspace_path: str, pane_id: str, surface: str, session_id: str) -> None:
    _DOCK_PTYS[term_id] = (workspace_path, pane_id, surface, session_id)


def _dock_target(metadata: dict, cwd: str = "") -> tuple[str, str] | None:
    """(workspace, surface) when terminal metadata names a panel surface."""
    surface = str(metadata.get("surface") or "")
    workspace_path = str(metadata.get("workspace_path") or cwd or "")
    if not surface or surface == "main" or not workspace_path:
        return None
    return workspace_path, surface


def _retire_dock_record(workspace_path: str, pane_id: str, surface: str, session_id: str = "") -> None:
    """Retire a panel's restore record, as manual_pane.unspawn retires one.

    Only the panel's own record — never a window pane's under the same id — and,
    given a session id, only while the record still names that session (a newer
    Start in the same panel keeps its own)."""
    from . import app

    try:
        project = app.project_store.load_or_create(workspace_path)
        if any(
            p.pane_id == pane_id
            and p.surface == surface
            and (not session_id or not p.session_id or p.session_id == session_id)
            for p in project.panes
        ):
            app.project_store.record_manual_pane_unspawn(workspace_path, pane_id=pane_id)
    except Exception:  # noqa: BLE001 — the PTY is already gone; a lost record update must not fail its caller
        log.exception("retiring panel record %s in %s failed", pane_id, workspace_path)


def note_terminal_exit(payload: dict) -> None:
    """A PTY ended: retire its panel's record when the CLI failed at launch or
    the user ended it cleanly from inside (/exit, a zero exit).

    A crash after a working start (the panel restores it), a shutdown (the app
    quit — the panel restores next launch) and a kill (Stop and window close
    retire on their own paths) leave the record as it is."""
    entry = _dock_record_to_retire(payload)
    if entry is not None:
        _retire_dock_record(*entry)
    target = _live_stamp_to_clear(payload)
    if target is not None:
        _clear_live_stamp(*target)


async def note_terminal_exit_async(payload: dict) -> None:
    """note_terminal_exit with the record update run off the event loop: it
    reads and writes the project store on disk."""
    entry = _dock_record_to_retire(payload)
    if entry is not None:
        await asyncio.to_thread(_retire_dock_record, *entry)
    target = _live_stamp_to_clear(payload)
    if target is not None:
        await asyncio.to_thread(_clear_live_stamp, *target)


def _live_stamp_to_clear(payload: dict) -> tuple[str, str] | None:
    """The (workspace, pane) whose last_live_launch an exit clears, or None.

    The 'auto' resume scope restores the panes whose CLI was still running when
    the app ended. A CLI that stops while the app runs — on its own ("exit",
    "error") or through a requested kill ("killed": Kill All, closing a
    workspace, a pipeline restart, an idle reclaim) — is not one of them. The
    app ending is "shutdown" (kill_all at backend shutdown) and keeps the stamp.
    A rebuild's kill names the OLD pane id, which the replacement's spawn
    re-keys away, so the rebuilt pane stays stamped."""
    if payload.get("reason") not in ("exit", "error", "killed"):
        return None
    workspace_path = str(payload.get("workspace_path") or "")
    pane_id = str(payload.get("pane_id") or "")
    if not workspace_path or not pane_id:
        return None
    return workspace_path, pane_id


def _clear_live_stamp(workspace_path: str, pane_id: str) -> None:
    from . import app

    try:
        # peek, not load_or_create: an exit must never create a project.
        project = app.project_store.peek(workspace_path)
        if project is None or not any(p.pane_id == pane_id for p in project.panes):
            return
        app.project_store.set_pane_resume_state(workspace_path, pane_id=pane_id, last_live_launch="")
    except Exception:  # noqa: BLE001 — the PTY is already gone; a lost stamp clear must not fail its caller
        log.exception("clearing live stamp of %s in %s failed", pane_id, workspace_path)


def _dock_record_to_retire(payload: dict) -> tuple[str, str, str, str] | None:
    """The panel record an exit retires (see note_terminal_exit), or None."""
    entry = _DOCK_PTYS.pop(str(payload.get("terminal_session_id") or ""), None)
    if entry is None or payload.get("reason") not in ("exit", "error"):
        return None
    exit_code = payload.get("exit_code")
    uptime_ms = payload.get("uptime_ms")
    if payload.get("reason") == "exit" and exit_code == 0:
        return entry
    if not isinstance(exit_code, int) or exit_code <= 0:
        return None
    if not isinstance(uptime_ms, int) or uptime_ms > _DOCK_FAILED_START_MS:
        return None
    return entry


def _record_dock_spawn(payload: dict, metadata: dict, agent_key: str, term_id: str = "") -> None:
    """File an embedded AI panel's restore record and Agent History entry.

    A window pane is recorded by its own window (manual_pane.spawn plus the
    set_ui_state history snapshot); a panel (AiCliDock) has no window running
    either, so its terminal.create does it here, reusing the same two writers.
    Only metadata naming a panel surface reaches this — the main window never
    sends `surface`, so its creates write nothing new."""
    from . import app

    surface = str(metadata.get("surface") or "")
    if not surface or surface == "main":
        return
    workspace_path = str(metadata.get("workspace_path") or payload.get("cwd") or "")
    if not workspace_path:
        return
    pane_id = str(payload["pane_id"])
    window_kind = str(metadata.get("window_kind") or "")
    origin = str(metadata.get("origin") or "")
    command = str(metadata.get("cli_command") or "")
    session_id = str(metadata.get("explicit_session_id") or "")
    output_log_file = str(payload.get("output_log_file") or "")
    try:
        # A window pane's Agent History entry under this id — its history can
        # outlive its project record — stays exactly as its window wrote it:
        # merge() replaces by paneId. So the id is not recorded as a panel's.
        rows, _total = app.spawn_history_store.read_page(workspace_path, limit=SPAWN_HISTORY_MAX_ENTRIES)
        if any(
            r.get("paneId") == pane_id and str(r.get("surface") or "main") == "main"
            for r in rows
        ):
            log.warning("terminal.create: pane %s is a window pane's; not recorded as a panel", pane_id)
            return
        project = app.project_store.record_manual_pane_spawn(
            workspace_path,
            pane_id=pane_id,
            agent=agent_key,
            command=command,
            session_id=session_id,
            output_log_file=output_log_file,
            origin=origin,
            surface=surface,
            window_kind=window_kind,
            launch_id=launch_id.current(),
        )
        # The store leaves a window pane's record alone when a panel's create
        # names its id; its Agent History entry must be left alone with it.
        record = next((p for p in project.panes if p.pane_id == pane_id), None)
        if record is None or record.surface != surface:
            log.warning("terminal.create: pane %s is a window pane's; not recorded as a panel", pane_id)
            return
        # Same shape the main window pushes for its panes (App.vue spawnPane).
        entry: dict[str, Any] = {
            "paneId": pane_id,
            "agentKey": agent_key,
            "command": command,
            "origin": origin,
            "workspacePath": workspace_path,
            "spawnedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "outputLogFile": output_log_file,
            "surface": surface,
            "windowKind": window_kind,
        }
        if session_id:
            entry["sessionId"] = session_id
        agent_label = str(metadata.get("agent_label") or "")
        if agent_label:
            entry["agentLabel"] = agent_label
        app.spawn_history_store.merge(workspace_path, [entry])
        if term_id:
            _note_dock_pty(term_id, workspace_path, pane_id, surface, session_id)
    except Exception:  # noqa: BLE001 — the PTY is up; a lost record must not fail the create
        log.exception("terminal.create: recording dock pane %s failed", pane_id)


async def _terminal_create_impl(
    session: "Session",
    msg_id: str,
    msg_type: str,
    payload: dict,
    transaction: dict[str, Any],
    generation: str,
) -> None:
    from . import app

    metadata = payload.get("metadata") or {}
    # These are server attestations, never renderer-provided metadata.
    for key in ("quota_transaction_id", "quota_original_pane_id", "credential_epoch",
                "credential_store_verified", "credential_store_id", "credential_store_error",
                "credential_launch_term_id", "guard_pane_token",
                ACCOUNT_DIR_METADATA_KEY, "account_dir_login"):
        metadata.pop(key, None)
    agent_key = payload.get("agent_key") or ""
    # The window's per-vendor env settings, first in the chain on purpose: the
    # vendor defaults below use setdefault, while onboarding, login profiles,
    # home management and wiring all update over the top,
    # so a user value can never displace something the backend must control.
    # It is also the only untrusted source in the chain — filter it here, and
    # keep what survived so the window can be told which of its settings a
    # later source went on to replace (see `cli.env_ignored` after the spawn).
    env, denied_env_keys = app.filter_spawn_env_request(dict(payload.get("env") or {}))
    requested_env = dict(env)
    vendor_spec = cli_vendor(agent_key)
    if vendor_spec is not None:
        for key, value in vendor_spec.spawn_env_defaults:
            if key not in os.environ:
                env.setdefault(key, value)
    await app._ensure_fresh_path_for_spawn(agent_key)
    payload["command"] = app._command_with_persisted_cli_binary(
        agent_key, payload.get("command")
    )
    payload["command"] = app._command_with_installed_cli_alias(
        agent_key, payload.get("command")
    )
    try:
        startup_probe = await asyncio.get_running_loop().run_in_executor(
            _CLI_PROBE_EXECUTOR,
            app._probe_agent_cli_for_spawn, agent_key, payload.get("command"),
        )
    except app.AgentCliProbeError as probe_error:
        # A CLI that simply is not installed is not an error the user can act on
        # from a dead pane full of red text — tell the window so it can open the
        # guided install. The error still propagates and cancels the spawn.
        if probe_error.details.get("reason") == "not_found":
            dep = app.onboarding_deps.DEPS_BY_ID.get(agent_key)
            missing: dict[str, Any] = {
                "agent_key": agent_key,
                "label": dep.label if dep else agent_key,
                "reason": "not_found",
            }
            # Carry the pane id only when there really is one. An empty string
            # used to go out for a spawn that named no pane, and the window
            # reads a falsy pane id as "no pane at all" — the branch that
            # bypasses the don't-ask-again opt-out (see promptCliInstall).
            pane_id = str(payload.get("pane_id") or "")
            if pane_id:
                missing["pane_id"] = pane_id
            await session.send_json(make_event("cli.missing", missing))
        raise
    if startup_probe:
        # A degraded not_found probe deliberately sends no cli.missing. The
        # spawn goes ahead because the pane's login shell may well find the
        # CLI, and the window opens the install wizard on cli.missing
        # unconditionally — announcing "not installed" for a CLI about to run
        # puts that wizard over a working pane. One that really is absent exits
        # 127, and the window's terminal.exit handler offers the install then,
        # once the shell has confirmed it.
        metadata["startup_probe"] = startup_probe
    # The vendor's own auto-update switch, only when the user opted out of it.
    env.update(app.onboarding_deps.spawn_env_for(agent_key))
    # CLI accounts share the real home — regular spawns get no profile env
    # isolation (sessions and settings are global; profiles only swap
    # credentials, so the active account's secret already sits in the live
    # location). The one account-driven exception is a LOGIN pane
    # (login_profile_id set): it runs the CLI inside the profile's isolated
    # login home, so completing the login never touches the live credentials
    # or any running pane; the usage poller later harvests the home into the
    # profile's slot (see credential_vault.harvest_login_home).
    env_remove: list[str] | None = None
    login_profile_id = str(payload.get("login_profile_id") or "")
    # Two decisions that used to be one. `is_login` says the pane exists in
    # order to sign in, and so selects the COMMAND; `login_profile_id` says
    # where it signs in, and so selects the HOME. A live login — signing in to
    # the account that is already active — carries the first and not the
    # second, so keying the rewrite on the profile id left it sitting at a bare
    # REPL. A profile id still implies a login on its own: an older frontend
    # sends only that.
    is_login = bool(payload.get("is_login")) or bool(login_profile_id)
    stores = getattr(app.credential_vault, "stores", None)
    managed_path = stores is not None and stores.enabled(agent_key)
    if login_profile_id:
        profile = app.cli_profiles_store.get(login_profile_id)
        if (
            agent_key not in PROFILE_AGENT_KEYS
            or profile is None
            or profile.get("agentKey") != agent_key
        ):
            await session.send_json(
                make_error(
                    msg_id, msg_type, "BAD_REQUEST",
                    f"invalid login profile for agent {agent_key!r}: {login_profile_id}",
                )
            )
            return
        if managed_path:
            # Snapshot creation is deferred until this same invocation has
            # reported its post-rc path under the final spawn lock.
            metadata["login_profile_id"] = login_profile_id
            metadata["live_login"] = True
        else:
            # The pending snapshot reserves a live credential store before its
            # PTY exists. Inspect it and create it under the same lock as regular
            # spawns and swaps; a rejected duplicate must never touch it.
            login_lock = app.credential_vault.switch_lock(agent_key)
            await asyncio.wait_for(login_lock.acquire(), timeout=_SWITCH_LOCK_TIMEOUT_SEC)
            try:
                isolated = getattr(app.credential_vault, "_login_isolated", None)
                if callable(isolated) and not isolated(agent_key):
                    running = _running_regular_terminals(agent_key) + _running_live_login_terminals(agent_key)
                    pending = await vault_to_thread(_live_login_pending, agent_key)
                    if running or pending:
                        await session.send_json(make_error(
                            msg_id, msg_type, "LOGIN_BLOCKED_BY_LIVE_PANES",
                            "the live credential is in use or a sign-in is already pending; "
                            "finish or close it first",
                            {"count": len(running), "agent_key": agent_key},
                        ))
                        return
                login_set, login_remove = await vault_to_thread(
                    functools.partial(
                        app.credential_vault.login_spawn_env, agent_key, login_profile_id,
                        **quota_failover.scope_kwargs(
                            app.credential_vault.login_spawn_env, agent_key, profile),
                    )
                )
            except Exception as err:  # noqa: BLE001 — the vault refused before any write
                # e.g. copilot's plaintext-token mode, or a multi-provider profile
                # with no scope: the vault cannot say where the sign-in would land,
                # so no pane opens and nothing was touched.
                await session.send_json(
                    make_error(
                        msg_id, msg_type, "LOGIN_UNAVAILABLE", _profile_error(err),
                        {"agent_key": agent_key, "profile_id": login_profile_id},
                    )
                )
                await _reclaim_codex_home(str(transaction.get("codex_home_id") or ""))
                return
            finally:
                login_lock.release()
            env.update(login_set)
            env_remove = login_remove or None
            # Mark the terminal as a LOGIN pane: the login harvest (on account
            # switch) must wait for it to exit (see _running_login_terminals).
            metadata["login_profile_id"] = login_profile_id
            if not login_set and not login_remove:
                # No isolation: this sign-in rewrites the LIVE credential store.
                # The vault has just parked the pre-login credential; still, a
                # pane already working on the live credential would be switched
                # under the user's feet, so refuse while any runs — and give the
                # parked snapshot back, since no sign-in will happen. A second
                # live-store sign-in at the same time is refused the same way.
                running = _running_regular_terminals(agent_key) + _running_live_login_terminals(agent_key)
                if running:
                    discard = getattr(app.credential_vault, "discard_pending_login", None)
                    if callable(discard):
                        try:
                            await vault_to_thread(functools.partial(
                                discard, agent_key, login_profile_id,
                                **quota_failover.scope_kwargs(discard, agent_key, profile)))
                        except Exception:  # noqa: BLE001 — the watch discards it later
                            app.log.exception("login: discard of the pre-login snapshot failed")
                    await session.send_json(
                        make_error(
                            msg_id, msg_type, "LOGIN_BLOCKED_BY_LIVE_PANES",
                            f"{len(running)} running {agent_key} pane(s) use the live "
                            "credential this sign-in would replace; finish or close them first",
                            {"count": len(running), "agent_key": agent_key},
                        )
                    )
                    return
                metadata["live_login"] = True
    # A claude account that signed in inside its own config dir runs there:
    # Claude Code owns that login, refreshes it under the dir's own locks, and
    # an account switch (which swaps only the live credential) never reaches
    # it. ``account_dir_login`` is the sign-in that puts the login there.
    account_dir_slot = ""
    if agent_key == "claude" and not login_profile_id:
        account_dir_login = bool(payload.get("account_dir_login"))
        try:
            account_dir_slot = await vault_to_thread(functools.partial(
                _account_dir_for_spawn, agent_key, metadata.get("profile_id"),
                login=account_dir_login,
            ))
        except Exception as err:  # noqa: BLE001 — the dir could not be prepared
            if account_dir_login:
                await session.send_json(make_error(
                    msg_id, msg_type, "LOGIN_UNAVAILABLE", _profile_error(err),
                    {"agent_key": agent_key, "profile_id": str(metadata.get("profile_id") or "")},
                ))
                return
            app.log.warning("claude account dir unavailable; using the live login: %s", err)
            account_dir_slot = ""
        if account_dir_login and not account_dir_slot:
            await session.send_json(make_error(
                msg_id, msg_type, "BAD_REQUEST",
                f"invalid account for a claude sign-in: {metadata.get('profile_id')!r}",
            ))
            return
        if account_dir_slot:
            dir_set, dir_remove = app.credential_vault.account_dir_spawn_env(account_dir_slot)
            env.update(dir_set)
            env_remove = list(env_remove or []) + dir_remove
            metadata[ACCOUNT_DIR_METADATA_KEY] = account_dir_slot
            metadata["profile_id"] = account_dir_slot
            if account_dir_login:
                is_login = True
                metadata["account_dir_login"] = True
        elif not metadata.get("profile_id") and _pane_default_profile_id(agent_key):
            # The chosen account has no usable dir login: this pane runs on
            # the live credential, so file it under that credential's owner.
            active = app.cli_profiles_store.get_default_profile(agent_key)
            metadata["profile_id"] = active["id"] if active else DEFAULT_SLOT_ID
    # True only when the rewrite below really turns the command into an auth
    # SUBCOMMAND. That, not `is_login` on its own, is what makes the spawn
    # wiring inapplicable further down — a subcommand takes none of the
    # top-level flags it appends. Nine vendors declare no sign-in invocation
    # (`login_command_args is None`, see _login_spawn_command) and keep their
    # ordinary command: such a pane is a working REPL and must stay wired.
    login_subcommand = False
    if is_login:
        # Run the CLI's direct sign-in trigger (e.g. `claude auth login`) so
        # the browser authorization opens by itself — the user never types a
        # command in the login pane. Ahead of the codex home block on purpose:
        # the rewritten command carries no resume id, so a login pane takes the
        # fresh-home path instead of being bound to a session's home.
        login_spec = cli_vendor(agent_key)
        login_subcommand = bool(login_spec is not None and login_spec.login_command_args)
        payload["command"] = app._login_spawn_command(agent_key, payload["command"])
    elif not account_dir_slot and app._agent_signed_out(agent_key):
        # Installed, but with no credentials to run on — the counterpart to
        # cli.missing, which only ever fires for a CLI that is not there at
        # all. Advisory: unlike cli.missing the spawn is perfectly valid and
        # goes ahead, and the vendor's own prompt stays the fallback. A login
        # pane is skipped by the `elif`: being signed out is its premise.
        dep = app.onboarding_deps.DEPS_BY_ID.get(agent_key)
        await session.send_json(make_event("cli.signed_out", {
            "agent_key": agent_key,
            "label": dep.label if dep else agent_key,
            "pane_id": str(payload.get("pane_id") or ""),
        }))
    if agent_key == "codex" and not login_profile_id:
        from . import codex_session_hooks, hook_auth
        # Compatibility: `codex resume <id>` only works inside the home
        # that recorded the session. Resume in whichever home owns it;
        # only unknown/fresh sessions get a (new) per-pane home.
        resume_id = app._resume_id_for_agent("codex", payload.get("command"))
        if resume_id:
            # Repair a pin that names a sub-agent thread. Builds shipped before
            # sub-agent rollouts were recognised could pin one, and codex
            # refuses direct input on such a thread — the pane comes back
            # unusable until the id is pointed at the user thread it came from.
            resolver = getattr(app.codex_home_manager, "resolve_user_thread_id", None)
            if callable(resolver):
                repaired = await asyncio.to_thread(resolver, resume_id)
            else:
                repaired = resume_id
            if repaired != resume_id:
                app.log.info(
                    "codex resume id repaired: sub-agent %s → user thread %s",
                    resume_id, repaired,
                )
                payload["command"] = codex_command_with_resume_id(
                    payload.get("command"), resume_id, repaired
                )
                resume_id = repaired
            # Resume selectors (names/--last) are not a known thread UUID.
            known_id = codex_session_hooks.resume_identity(resume_id)
            if known_id:
                metadata["explicit_session_id"] = known_id
        session_home = (
            await asyncio.to_thread(app.codex_home_manager.find_session_home, resume_id)
            if resume_id
            else None
        )
        if session_home is None:
            home_id = str(metadata.get("session_home_id") or payload["pane_id"])
            codex_home = await asyncio.to_thread(
                app.codex_home_manager.prepare,
                home_id,
            )
            env["CODEX_HOME"] = str(codex_home)
            metadata["session_home_id"] = home_id
            transaction["codex_home_id"] = home_id
        elif session_home != app.codex_home_manager.real_home:
            env["CODEX_HOME"] = str(session_home)
            metadata["session_home_id"] = session_home.name
        # else: session lives in the real ~/.codex — resume with the
        # default env so codex can find it.
        if not is_login:
            payload["command"] = await asyncio.to_thread(
                codex_session_hooks.wire, payload["command"], env, metadata,
                Path(env.get("CODEX_HOME") or app.codex_home_manager.real_home),
                app.backend_port_file(), hook_auth.header_file(),
            )
    from . import guard_hooks

    if agent_key in guard_hooks.PANE_TOKEN_VENDORS:
        # Navide Guard: names this pane to its PreToolUse hook when the hook's
        # session id is not attributed yet. Only this pane's processes see it.
        import secrets

        guard_token = secrets.token_urlsafe(24)
        metadata["guard_pane_token"] = guard_token
        env[guard_hooks.PANE_TOKEN_ENV] = guard_token
    # Settings → Resource limits. Empty unless the user turned a limit on, and
    # an unreadable store reads as "none" — the spawn never depends on it.
    from . import resource_limits

    for key, value in resource_limits.spawn_env(
        resource_limits.read_settings(app.ui_settings_store.get)
    ).items():
        env.setdefault(key, value)
    # Lines the pane prints at startup when this machine cannot wire it (see
    # wire_command): the only other trace is a backend log the user never sees.
    wiring_warnings: list[str] = []
    # Keyed on the sign-in SUBCOMMAND, not on `login_profile_id` (which a live
    # login does not carry) nor on `is_login` (which a REPL-launching vendor
    # also sets): a subcommand rejects the top-level flags wired below —
    # `--mcp-config` from the MCP endpoint, `--add-dir` from skills. An unwired
    # login pane costs nothing (it signs in and exits); a wired one dies on
    # `unknown option`, measured against claude 2.1.275.
    if not login_subcommand:
        # Run plugin-registered spawn transformers over the command (e.g. the
        # builtin navide.plans plugin appends Plan-MCP flags for claude/codex);
        # no-op with no plugins, and a failing transformer never breaks a spawn.
        # env is passed last and mutated in place: CLIs with no additive MCP
        # flag take their wiring through a variable instead, and it is settled
        # by this point (CODEX_HOME above is the last writer).
        # Navide's own MCP endpoint first — it is core, not a plugin, and a
        # pane that misses it loses every navide tool. env is mutated in place
        # for the CLIs that take their wiring through a variable.
        from .mcp_server import wiring as mcp_server_wiring

        payload["command"] = await asyncio.to_thread(
            mcp_server_wiring.wire_command,
            agent_key,
            payload["command"],
            mcp_server_wiring.backend_port(),
            str(payload.get("pane_id") or ""),
            env,
            str(payload.get("cwd") or ""),
            warnings=wiring_warnings,
        )
        payload["command"] = await asyncio.to_thread(
            app.plugin_wiring.apply_spawn_wiring,
            app.plugin_host,
            agent_key,
            payload["command"],
            str(payload.get("pane_id") or ""),
            env,
            str(payload.get("cwd") or ""),
        )
        # The builtin skills transformer cannot return lines; it keeps them.
        from .plugins.builtin.navide_skills import skills_wiring

        wiring_warnings.extend(skills_wiring.take_spawn_warnings(str(payload.get("pane_id") or "")))
    # Give the pane whatever its push channel needs (a port to serve on, a file
    # to watch) so a message can later reach it without being typed in. Last,
    # so the flags it adds cannot be displaced by MCP or skills wiring; a CLI
    # with no push channel — most of them — is left untouched. Skipped for a
    # login pane for the same reason as the MCP wiring above: its subcommand
    # takes no top-level flags.
    push_channel = None
    if not login_subcommand:
        payload["command"], push_channel = app.push_delivery.wire_spawn(
            agent_key, payload["command"], str(payload.get("pane_id") or ""), env
        )
    # Claude's hooks, when the panes carry them instead of ~/.claude/settings.json:
    # a file of Navide's, merged by Claude Code with the user's own settings —
    # for a resume and an account-dir pane alike. Not for a login subcommand.
    from . import convenience_wiring

    if agent_key == "claude" and not login_subcommand and convenience_wiring.pane_carries_hooks("claude"):
        from . import claude_hooks

        payload["command"] = claude_hooks.wire_spawn(payload["command"])
    # Skills wiring mirrors ~/.codex/hooks.json into the per-pane CODEX_HOME,
    # and codex keys hook trust by that path — without this every spawn stops
    # at "Hooks need review". CODEX_HOME is final only after all wiring above.
    seeder = getattr(app.codex_home_manager, "seed_hook_trust", None)
    if agent_key == "codex" and not login_profile_id and env.get("CODEX_HOME") and callable(seeder):
        from . import convenience_wiring

        if convenience_wiring.pane_carries_hooks("codex"):
            # Phase 3: the trust rows ride on the command line instead of
            # config.toml. After codex_session_hooks.wire, which leaves a
            # command already holding any `-c hooks…` unwired — Navide's own
            # SessionStart and Guard hooks would be lost.
            override = await asyncio.to_thread(
                app.codex_home_manager.hook_trust_override, Path(env["CODEX_HOME"])
            )
            if override and not login_subcommand:
                command = payload["command"]
                flag = " -c " + osplat.paths.quote_arg(override)
                payload["command"] = (
                    [*command[:-1], f"{command[-1]}{flag}"] if isinstance(command, list) and command
                    else f"{command}{flag}"
                )
        else:
            seeded = await asyncio.to_thread(
                convenience_wiring.seed_hook_trust_gated, app.codex_home_manager, Path(env["CODEX_HOME"])
            )
            if seeded:
                app.log.info("codex hook trust seeded for %s (%d hooks)", env["CODEX_HOME"], seeded)
    if transaction["cancelled"]:
        raise _TerminalCreateCancelled
    # The pane's previous PTY, when this create replaces it (restore/rebuild).
    # Resume-id dedup below can't catch it: a CLI rewrites its session id on
    # every resume, so across restores the ids never match and the old PTY
    # would linger ownerless forever. Pane identity is stable — use it, but
    # only kill a PTY that really belongs to this pane (frontend-bug guard).
    replaces_tid = str(payload.get("replaces_terminal_id") or "")
    if replaces_tid:
        create_pane_id = str(payload["pane_id"])
        stale = session.terminals.get(replaces_tid)
        if stale is not None and not stale.closed:
            # Kill only the pane's own predecessor (same pane id — rebuild) or
            # an ownerless leftover (pane ids regenerate across restores, but
            # a predecessor with no owning WebSocket can't be anyone's live
            # pane). A PTY another window still owns is never touched.
            if stale.pane_id == create_pane_id or stale.id not in app._PTY_OWNERS:
                app.log.info(
                    "terminal.create: reaping replaced PTY %s for pane %s",
                    replaces_tid,
                    create_pane_id,
                )
                await session.terminals.kill(replaces_tid, force=True)
                # A vendor with a graceful ShutdownSpec (claude) is put down
                # by a background task, so kill() alone no longer means the
                # old CLI is gone — and the spawn below would overlap it.
                # Returns immediately for every other vendor.
                if not await session.terminals.wait_until_reaped(replaces_tid):
                    app.log.error(
                        "terminal.create: replaced PTY %s outlived its kill "
                        "— refusing to spawn over it for pane %s",
                        replaces_tid,
                        create_pane_id,
                    )
                    raise _TerminalCreateReapTimeout(replaces_tid)
            else:
                app.log.warning(
                    "terminal.create: replaces_terminal_id %s is another live "
                    "pane's PTY (pane %s, not %s) — refusing to kill",
                    replaces_tid,
                    stale.pane_id,
                    create_pane_id,
                )
    # One live CLI per resume id: a --resume spawn can race a still-live PTY
    # resuming the same session (cross-window restore, cleared localStorage —
    # tryReattach only sees the spawning window's own PTY id), leaving two
    # CLIs appending to one session file. Reap the survivor first.
    resume_dedup_id = app._resume_id_for_agent(agent_key, payload.get("command"))
    if resume_dedup_id:
        for stale in session.terminals.find_live_by_resume_id(
            agent_key,
            resume_dedup_id,
            lambda cmd: app._resume_id_for_agent(agent_key, cmd),
        ):
            app.log.info(
                "terminal.create: reaping stale PTY %s resuming %s/%s",
                stale.id,
                agent_key,
                resume_dedup_id,
            )
            await session.terminals.kill(stale.id, force=True)
            # Two CLIs appending to one session file is exactly what this loop
            # exists to prevent, so wait out a graceful shutdown before the
            # --resume spawn below rather than only signalling it — and if the
            # wait runs out, do not spawn at all. Proceeding here would hand
            # the user the corruption this loop was written to stop.
            if not await session.terminals.wait_until_reaped(stale.id):
                app.log.error(
                    "terminal.create: stale PTY %s resuming %s/%s outlived "
                    "its kill — refusing to spawn a second one",
                    stale.id,
                    agent_key,
                    resume_dedup_id,
                )
                raise _TerminalCreateReapTimeout(stale.id)
    def _spawn_and_claim(spawn_command=None) -> Any:
        term = session.terminals.create(
            pane_id=payload["pane_id"],
            agent_key=agent_key,
            command=payload["command"],
            cwd=payload["cwd"],
            cols=int(payload.get("cols", 100)),
            rows=int(payload.get("rows", 30)),
            env=env or None,
            env_remove=env_remove,
            metadata=metadata,
            output_log_file=payload.get("output_log_file") or "",
            **({"spawn_command": spawn_command} if spawn_command is not None else {}),
        )
        transaction["term_id"] = term.id
        # Claim immediately. A CLI can die while attribution registration is
        # still running; its terminal.exit must still reach this renderer.
        app._PTY_OWNERS[term.id] = session
        return term

    # The account this launch is pinned to, resolved ONCE (under the switch
    # lock, below) and reused by the history pin after the spawn: two reads
    # could straddle a switch and file the pane under two accounts.
    history_pin: str | None = None
    if agent_key in PROFILE_AGENT_KEYS and (not login_profile_id or managed_path):
        # A regular pane of a profile agent starts on the live credentials —
        # the very state an account switch swaps. Spawning under the agent's
        # switch lock closes the quiescence gate's TOCTOU window: the pane is
        # either created and claimed in _PTY_OWNERS before the switch handler
        # takes the lock (so its gate counts the pane), or the spawn waits for
        # the swap to finish and picks up the new account's credentials. The
        # lock also covers the post-rc report, binding and GO for managed
        # destinations. Their live-store logins snapshot inside this same
        # section; isolated login homes retain their existing separate path.
        # Bounded acquire (_SWITCH_LOCK_TIMEOUT_SEC): if the lock is somehow
        # held forever the spawn must fail visibly instead of hanging with no
        # response and no log.
        switch_lock = app.credential_vault.switch_lock(agent_key)
        try:
            await asyncio.wait_for(
                switch_lock.acquire(), timeout=_SWITCH_LOCK_TIMEOUT_SEC
            )
        except asyncio.TimeoutError:
            app.log.warning(
                "terminal.create for %s timed out after %.0fs waiting for the "
                "credential switch lock", agent_key, _SWITCH_LOCK_TIMEOUT_SEC,
            )
            # Name both plausible causes: a wedged switch/harvest, and a
            # Keychain authorization prompt sitting unanswered (each `security`
            # call has its own 10s budget, so an unattended prompt blows this
            # ceiling). Also say the previous PTY is gone: the reap of
            # replaces_terminal_id above already ran, so a Respawn that lands
            # here has lost its old pane and must be started again by hand.
            raise RuntimeError(
                f"timed out after {_SWITCH_LOCK_TIMEOUT_SEC:.0f}s waiting for the "
                f"{agent_key} credential switch lock; an account switch or "
                "credential harvest appears to be stuck, or a Keychain "
                "authorization prompt is waiting for an answer. If this was a "
                "respawn, the previous session was already closed — start the "
                "pane again"
            ) from None
        launch = None
        try:
            if managed_path and is_login and _running_regular_terminals(agent_key):
                raise quota_failover.FailoverRefused("LOGIN_BLOCKED_BY_LIVE_PANES", "close running CLI panes before signing in")
            if _running_live_login_terminals(agent_key) or await vault_to_thread(
                _live_login_pending, agent_key
            ):
                # Recheck inside the spawn lock: a login may have reserved
                # the live store while this request was waiting for it.
                await session.send_json(make_error(
                    msg_id, msg_type, "LOGIN_IN_PROGRESS",
                    f"a {agent_key} sign-in is rewriting the live credential; wait for it "
                    "to finish before opening a new pane",
                    {"agent_key": agent_key},
                ))
                await _reclaim_codex_home(str(transaction.get("codex_home_id") or ""))
                return
            # Launch provenance for the account-switch authority: the profile
            # this pane starts on and the credential pool it resolves to,
            # decided under the same lock as the credentials themselves. The
            # failover transaction reads only this to tell which live panes a
            # swap of that pool touches — never the default of the moment.
            launch_pin = _profile_pin_for_bookkeeping(
                agent_key, payload["pane_id"], metadata.get("profile_id"))
            history_pin = launch_pin
            launch_profile = (
                app.cli_profiles_store.get(launch_pin)
                if launch_pin and launch_pin != DEFAULT_SLOT_ID else None
            )
            provenance = quota_failover.pane_auth_scope(
                agent_key, launch_profile, env=env, env_remove=env_remove or (),
                account_dir=bool(account_dir_slot),
            )
            metadata["launch_profile_id"] = provenance["profileId"]
            metadata["profile_scope"] = provenance["scope"]
            metadata["auth_scope"] = provenance["authScope"]
            metadata["credential_source"] = provenance["credentialSource"]
            metadata["credential_env"] = provenance["credentialEnv"]
            metadata["credential_epoch"] = app.quota_failover.epoch(agent_key)
            quota_tx_id = str(payload.get("quota_transaction_id") or "")
            quota_pane_id = str(payload.get("quota_original_pane_id") or "")
            if managed_path:
                from .credential_launch import CredentialLaunch, wrap_command
                from .credential_store import StoreUnverified

                async def owned_vault_call(fn):
                    # Cancellation cannot release the vendor lock while its
                    # executor is still persisting a binding or snapshot.
                    task = asyncio.create_task(vault_to_thread(fn))
                    try:
                        return await asyncio.shield(task)
                    except asyncio.CancelledError:
                        await task
                        raise

                metadata["credential_store_verified"] = False
                launch = await CredentialLaunch.start(vendor_spec.credential_path_env_vars)
                names = tuple(dict.fromkeys((*quota_failover.credential_env_vars(agent_key),
                    *(name for _, values in vendor_spec.account_switch.uncertain_env_by_scope for name in values))))
                wrapped = wrap_command(payload["command"], vendor_spec,
                    launch.helper_argv(login=is_login, vendor=agent_key, credential_env=names),
                    env={key: value for key, value in {**os.environ, **env}.items() if key not in (env_remove or ())})
                if wrapped is None and is_login:
                    raise quota_failover.FailoverRefused("CREDENTIAL_STORE_UNVERIFIED", "this login command cannot verify its credential store")
                if wrapped is not None:
                    env.update(launch.env)
                term = _spawn_and_claim(wrapped)
                metadata["credential_launch_term_id"] = term.id
                term.metadata.update(metadata)
                try:
                    if wrapped is None:
                        raise StoreUnverified("custom command cannot verify its credential store")
                    report = await launch.wait_report()
                    if report["credentialEnv"]:
                        metadata["credential_source"] = "env-override"
                        metadata["credential_env"] = report["credentialEnv"]
                        raise StoreUnverified("the CLI environment overrides file credentials")
                    doc = app.cli_profiles_store.list()
                    new_profile = login_profile_id if login_profile_id == getattr(session, "_created_cli_profile_id", "") else ""
                    has_managed_state = any(p.get("agentKey") == agent_key and p.get("id") != new_profile
                                            for p in doc["profiles"])
                    with stores._db.transaction() as cur:
                        if cur.execute("SELECT 1 FROM sqlite_master WHERE name='pane_account_history'").fetchone():
                            for row in cur.execute("SELECT DISTINCT pane_id, profile_id FROM pane_account_history"):
                                known = [p for p in doc["profiles"] if p.get("id") == row["profile_id"]]
                                live_agents = {
                                    getattr(other, "agent_key", "")
                                    for term_id, owner in list(app._PTY_OWNERS.items())
                                    if (other := owner.terminals.get(term_id)) is not None
                                    and not getattr(other, "closed", False)
                                    and getattr(other, "pane_id", "") == row["pane_id"]
                                }
                                # A historical default/deleted/ambiguous profile
                                # remains unknown even if a live pane has a vendor.
                                known_agent = known[0].get("agentKey") if len(known) == 1 else None
                                if (known_agent not in CLI_VENDORS or known_agent == agent_key
                                        or live_agents - {known_agent}):
                                    has_managed_state = True
                                    break
                    metadata["credential_store_id"] = await owned_vault_call(functools.partial(
                        stores.bind, agent_key, report, vault=app.credential_vault,
                        slot_id=launch_pin or DEFAULT_SLOT_ID,
                        scope=quota_failover.profile_scope(agent_key, launch_profile),
                        has_managed_state=has_managed_state, exclude_term_id=term.id,
                        new_login_profile=bool(new_profile)))
                    if new_profile:
                        session._created_cli_profile_id = ""
                    metadata["credential_store_verified"] = True
                    term.metadata.update(metadata)
                    watcher = getattr(app, "_credential_watcher", None)
                    if watcher is not None:
                        await watcher.watch_bound_store(agent_key, stores.path(agent_key))
                    if login_profile_id:
                        scope_kw = quota_failover.scope_kwargs(app.credential_vault.login_spawn_env, agent_key, profile)
                        transaction["store_login_snapshot"] = (agent_key, login_profile_id, scope_kw)
                        await owned_vault_call(functools.partial(
                            app.credential_vault.login_spawn_env, agent_key, login_profile_id, **scope_kw))
                except Exception as err:  # noqa: BLE001 — preserve ordinary CLI launch on observation failure
                    metadata["credential_store_error"] = str(err) or "credential path report timed out"
                    metadata["credential_store_verified"] = False
                    if metadata["credential_source"] == "vault":
                        metadata["credential_source"] = "unverified-store"
                    term.metadata.update(metadata)
                    if is_login:
                        raise quota_failover.FailoverRefused("CREDENTIAL_STORE_UNVERIFIED", metadata["credential_store_error"]) from err
            else:
                term = None
            if quota_tx_id or quota_pane_id:
                app.quota_failover.validate_restart_spawn(
                    quota_tx_id, quota_pane_id, owner=session, agent_key=agent_key, metadata=metadata,
                )
                metadata["quota_transaction_id"] = quota_tx_id
                metadata["quota_original_pane_id"] = quota_pane_id
            if term is None:
                term = _spawn_and_claim()
            if managed_path:
                term.metadata.update(metadata)
            if quota_tx_id:
                app.quota_failover.record_restart_spawn(quota_tx_id, quota_pane_id, term.id)
            if launch is not None:
                launch.release(bool(metadata.get("credential_store_verified")))
                if metadata.get("credential_store_verified") and not await launch.wait_received():
                    metadata["credential_store_verified"] = False
                    metadata["credential_source"] = "unverified-store"
                    metadata["credential_store_error"] = "credential helper timed out before confirming GO"
                    term.metadata.update(metadata)
                    if is_login:
                        raise quota_failover.FailoverRefused("CREDENTIAL_STORE_UNVERIFIED", metadata["credential_store_error"])
        finally:
            try:
                if launch is not None:
                    await launch.close()
            finally:
                switch_lock.release()
    else:
        term = _spawn_and_claim()
    # What became of the window's own env settings. Only now is the answer
    # final: `env` is written by six later sources and `env_remove` (applied
    # last of all, in terminals.spawn) can still delete a key that survived
    # them. Advisory like cli.signed_out — the pane is already running; this
    # only tells the window which of its settings never reached the CLI.
    overridden_env_keys = app.spawn_env_overridden_keys(requested_env, env, env_remove)
    if denied_env_keys or overridden_env_keys:
        dep = app.onboarding_deps.DEPS_BY_ID.get(agent_key)
        await session.send_json(make_event("cli.env_ignored", {
            "agent_key": agent_key,
            "label": dep.label if dep else agent_key,
            "pane_id": str(payload.get("pane_id") or ""),
            # Refused on the way in: Navide owns these (credentials, CLI homes).
            "denied": sorted(denied_env_keys),
            # Accepted, then replaced or removed by a higher-priority source.
            "overridden": overridden_env_keys,
        }))
    # Announced only now the PTY exists. Wiring the channel is a spawn-time
    # decision, but advertising it before the CLI is actually running would tell
    # the window it can push into a pane that may still fail to start — and a
    # spawn that rolls back has already dropped the channel again.
    if push_channel is not None:
        await app.broadcast(make_event("agent_msg.push_state", {
            "pane_id": push_channel.pane_id,
            "kind": push_channel.kind,
            "ready": True,
        }))
    # Register the pane with the log-attribution layer so any session
    # file appearing after this point can be attributed back to us.
    # Registry membership == the 12 CLI vendors; the drift test pins the set.
    if agent_key in CLI_VENDORS:
        ws_for_pane = str(metadata.get("workspace_path") or payload["cwd"])
        # Workspace registration via helper triggers a force-rescan
        # if the workspace is newly known — so historic CLI sessions
        # in that workspace's folder appear in the panel right away.
        app._register_workspace_and_backfill(ws_for_pane)
        explicit_session_id = str(metadata.get("explicit_session_id") or "")
        # One-file-per-vendor bridge: a migrated vendor claims its resume id
        # through its spec (the why-claim rationale moves into the vendor
        # file); the elif chain below is the legacy fallback, deleted one
        # vendor at a time. Codex stays out of both paths here — its resume
        # id is claimed via the per-pane CODEX_HOME flow.
        if (not explicit_session_id and agent_key != "codex"
                and vendor_spec is not None
                and vendor_spec.resume_id_from_command is not None):
            explicit_session_id = vendor_spec.resume_id_from_command(
                payload.get("command")
            )
        # Vendors absent from both paths above deliberately claim no resume
        # id here (e.g. an id-less lossy resume); the rationale lives in each
        # vendor's module. Such panes bind via the kickoff marker instead.
        # A re-created pane (renderer reload respawn keeps its pane id)
        # must not lose its fresh registration to a pending grace-period
        # cleanup from the previous PTY's exit.
        app._cancel_pane_unregister(term.pane_id)
        # Open the pane's account interval now, before the CLI's first call
        # can land: the bookkeeping message repeats the same pin (a no-op)
        # a beat later. Non-account agents pin the Default slot.
        app.pane_account_history.pin(
            term.pane_id,
            _account_pin_for_history(
                history_pin if history_pin is not None else _profile_pin_for_bookkeeping(
                    agent_key, term.pane_id, metadata.get("profile_id"))
            ),
        )
        # Register now — a lock and a dict insert — so the pane owns its
        # identity before the ack below; the frontend's next messages
        # (manual_pane.spawn, pane.set_run_group) and the CLI's first
        # session-file event all expect it. The baseline scan is the
        # expensive half: it enumerates the vendor's session tree (Codex
        # opens every rollout under ~/.codex/sessions and every
        # ~/.codex-panes/*/sessions to read its header), and awaiting it
        # here held the ack past the renderer's 30s deadline on large trees
        # while the CLI itself sat at its prompt (issue #118). It runs
        # off-loop after the ack; until it lands the pane binds only through
        # the deterministic paths (explicit id, per-pane home, marker).
        app.attribution.register_pane(
            term.pane_id,
            vendor=agent_key,
            cwd=payload["cwd"],
            workspace_path=ws_for_pane,
            stage_id=metadata.get("stage_id") or metadata.get("stageId"),
            slot_key=app._stable_pane_key(metadata, ""),
            group_id=str(metadata.get("run_group_id") or ""),
            explicit_session_id=explicit_session_id,
            session_marker=str(metadata.get("session_marker") or ""),
            session_home_id=str(metadata.get("session_home_id") or ""),
            defer_baseline=True,
        )
        transaction["attribution_started"] = True
        attribution_future = asyncio.get_running_loop().run_in_executor(
            None, app.attribution.scan_pane_baseline, term.pane_id
        )
        # Kept on the transaction so a rollback (cancel, dead socket) waits
        # for the scan before unregistering — scan_pane_baseline itself
        # refuses to revive a registration that is gone.
        transaction["attribution_future"] = attribution_future
        # Tracked so the task stays reachable (CPython drops an unreferenced
        # task). The scan itself runs in the executor and installs its result
        # regardless; a disconnect only cancels the codex retry behind it.
        tail = asyncio.create_task(
            _finish_pane_attribution(
                attribution_future,
                term.pane_id,
                str(metadata.get("codex_launch_token") or ""),
            ),
            name=f"pane-baseline:{term.pane_id[:8]}",
        )
        session._handler_tasks.add(tail)
        tail.add_done_callback(session._handler_tasks.discard)
        # The live "THIS SESSION" tally is read straight from the vendor log.
        # Now that the pane owns this session id, start tracking it and take
        # the first scan. Fire and forget — a multi-MB parse must not delay
        # the create ack below.
        app.track_live_session(
            workspace_path=ws_for_pane,
            pane_id=term.pane_id,
            vendor=agent_key,
            session_id=explicit_session_id,
        )
    if transaction["cancelled"]:
        raise _TerminalCreateCancelled
    if getattr(term, "closed", False):
        app._PTY_OWNERS.pop(term.id, None)
        # A panel's restore launch that died on the spot would otherwise stay
        # 'spawned' from its last run and be retried on every window open.
        dock = _dock_target(metadata, str(payload.get("cwd") or ""))
        if dock and isinstance(getattr(term, "exit_code", None), int) and term.exit_code > 0:
            await asyncio.to_thread(_retire_dock_record, dock[0], str(payload["pane_id"]), dock[1])
        details = {
            "agent_key": agent_key,
            "binary_path": (startup_probe or {}).get("binary_path", ""),
            "reason": getattr(term, "close_reason", None),
            "exit_code": getattr(term, "exit_code", None),
            "signal": getattr(term, "exit_signal", None),
            "uptime_ms": getattr(term, "uptime_ms", None),
            "startup_probe": startup_probe,
        }
        cause = getattr(term, "exit_signal", None) or f"exit code {getattr(term, 'exit_code', None)}"
        raise app.AgentCliProbeError(
            f"Process died {getattr(term, 'uptime_ms', None)}ms after spawn ({cause})",
            details,
        )
    if login_profile_id:
        # Fast login feedback: watch the isolated login home and harvest the
        # moment the browser authorization completes — the usage poll alone is
        # too slow for the accounts UI to flip to signed-in.
        from .usage_service import start_login_watch

        start_login_watch(agent_key, login_profile_id)
    elif metadata.get("account_dir_login") and account_dir_slot:
        # Same fast feedback for a sign-in into an account's own config dir:
        # nothing is harvested (Claude Code keeps that login), the watch only
        # reports the moment the dir holds it.
        from .usage_service import start_account_dir_login_watch

        start_account_dir_login_watch(account_dir_slot)
    response_payload = {
        "terminal_session_id": term.id,
        "pane_id": term.pane_id,
        "pid": term.proc.pid,
        "command": term.command,
        "startup_probe": startup_probe,
        "create_generation": generation,
    }
    if wiring_warnings:
        response_payload["wiring_warnings"] = wiring_warnings
    await session.send_json(make_response(msg_id, msg_type, response_payload))
    if session.dead or transaction["cancelled"]:
        raise _TerminalCreateCancelled
    transaction["response_payload"] = response_payload
    transaction["committed"] = True
    _record_dock_spawn(payload, metadata, agent_key, term.id)


@handler("terminal.create.cancel")
async def terminal_create_cancel(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    pane_id = str(payload["pane_id"])
    generation = str(payload["create_generation"])
    key = (pane_id, generation)
    transaction = session._terminal_create_transactions.get(key)
    cancelled = bool(transaction and not transaction.get("committed"))
    if transaction and not transaction.get("committed"):
        transaction["cancelled"] = True
        session._terminal_create_tombstones.add(key)
        await _rollback_terminal_create(session, transaction)
    elif transaction is None:
        session._terminal_create_tombstones.add(key)
        cancelled = True
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "ok": True,
                "pane_id": pane_id,
                "create_generation": generation,
                "cancelled": cancelled,
            },
        )
    )


#: Per terminal session: the text guarded injections have typed since their
#: last Enter (see terminal_input). Paste guards are stripped; they are not part
#: of the command.
_GUARDED_LINES: dict[str, str] = {}
_PASTE_GUARDS = ("\x1b[200~", "\x1b[201~")


def _guarded_terminal_write_refusal(session: "Session", session_id: str, data: str) -> Any:
    """terminal_policy's refusal for a guarded write to a plain terminal, or
    None (also for a PTY that is not a terminal pane: only a shell runs what it
    is typed). Records the write into the session's pending line when it
    passes; an Enter clears it."""
    term = session.terminals.get(session_id)
    if term is None or getattr(term, "agent_key", "") != "terminal":
        return None
    from .guard import terminal_policy

    text = data
    for guard in _PASTE_GUARDS:
        text = text.replace(guard, "")
    submit = "\r" in text
    line = _GUARDED_LINES.get(session_id, "") + text.replace("\r", "")
    workspace = str(term.metadata.get("workspace_path") or term.cwd)
    refusal = terminal_policy.enforce(line, workspace=workspace, pane_id=term.pane_id, via="terminal.input")
    if refusal is not None:
        _GUARDED_LINES.pop(session_id, None)
        return refusal
    if submit:
        _GUARDED_LINES.pop(session_id, None)
    else:
        _GUARDED_LINES[session_id] = line
    return None


@handler("terminal.input")
async def terminal_input(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # `pending` = bytes the kernel has not accepted yet; the renderer must not
    # resend those (they are queued, not lost).  Empty data is a pure probe of
    # that count and must leave no other trace.
    # A write into a plain terminal pane on behalf of a message asks that the
    # shell be at its prompt: checked here, next to the write, so a program
    # started between the renderer's last look and this write still refuses it.
    session_id = payload["terminal_session_id"]
    if payload.get("require_shell_prompt") is True and payload["data"]:
        if session.terminals.shell_in_foreground(session_id) is False:
            await session.send_json(
                make_response(msg_id, msg_type, {"ok": False, "error": "foreground-busy"})
            )
            return
        # Everything a guarded injection has typed since its last Enter is one
        # command line, checked as a whole before each write — a line split
        # across chunks is judged together, and the Enter re-checks it.
        refusal = _guarded_terminal_write_refusal(session, session_id, payload["data"])
        if refusal is not None:
            await session.send_json(
                make_response(
                    msg_id, msg_type, {"ok": False, "error": "command-refused", "refusal": refusal.as_dict()}
                )
            )
            return
    elif payload["data"]:
        # Anything else written (a person typing, a kill-line after a failed
        # injection) means the line is no longer only what was injected.
        _GUARDED_LINES.pop(session_id, None)
    pending = session.terminals.write(session_id, payload["data"])
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "pending": pending}))
    # A keyboard frame (the renderer flags only those: not mouse/focus reports,
    # not paste or programmatic injection) is a human dev-time heartbeat for
    # the pane behind the PTY. human_input never raises.
    if payload.get("human") is True and payload["data"]:
        term = session.terminals.get(payload["terminal_session_id"])
        if term is not None:
            workspace_path = str(term.metadata.get("workspace_path") or term.cwd)
            if app.dev_time_store.human_input(workspace_path, term.pane_id):
                await app.broadcast(make_event("devtime.changed", {"workspace_path": workspace_path}))


@handler("terminal.shell_at_prompt")
async def terminal_shell_at_prompt(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Per plain-terminal session: whether its shell is at its prompt (True),
    running something in front of it (False), or unknown (None). Polled by the
    renderer's messaging gate; a tcgetpgrp per session, no subprocess."""
    ids = [str(x) for x in (payload.get("terminal_session_ids") or [])]
    states = {sid: session.terminals.shell_in_foreground(sid) for sid in ids}
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "states": states}))


@handler("terminal.memory_usage")
async def terminal_memory_usage(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Per-pane memory footprint, measured on demand.

    Answers the one question the memory panel exists for — which panes are
    holding the machine's memory — with the number the kernel charges each
    process, not `ps` RSS (which counts shared pages once per process and so
    over-reports a fleet of identical CLIs).

    On demand, never on a timer: the sweep shells out, and its cost scales with
    the pane count. Off Darwin, or when footprint cannot run, `available` is
    false and the panel says it cannot measure rather than showing a number
    that means something else.
    """
    from . import process_memory

    groups = session.terminals.memory_pid_groups()
    pids = [pid for _, pids in groups.values() for pid in pids]
    measured = await asyncio.to_thread(process_memory.footprints, pids)
    totals = process_memory.sum_by_group(
        {sid: pids for sid, (_, pids) in groups.items()}, measured
    )
    panes = [
        {
            "terminal_session_id": sid,
            "pane_id": pane_id,
            "bytes": totals.get(sid, 0),
        }
        for sid, (pane_id, _) in groups.items()
    ]
    await session.send_json(make_response(msg_id, msg_type, {
        # measured being empty with live panes means the sweep failed, which is
        # not the same as "no panes" — the panel has to tell those apart.
        "available": process_memory.available() and bool(measured or not groups),
        "panes": panes,
        "total_bytes": sum(totals.values()),
    }))


#: One sweep serves every window that asks within this window of time.
#:
#: The panel it feeds is machine-wide, so N open windows all ask for the same
#: numbers on their own timers — and the sweep shells out twice, on the shared
#: executor, at a cost that scales with the pane count. Without this, three
#: windows plus the Resource Manager mean three redundant `footprint` runs
#: contending for the same thread pool (a failure this backend has hit before,
#: from a different caller). The lock serialises them; the TTL means the ones
#: that queued behind it get the reading that just completed instead of
#: starting another.
#:
#: It does not blur anyone's CPU differencing: each caller subtracts against
#: its OWN previous sample, and `sampled_at` travels with the reading, so a
#: shared sample is simply a sample both callers took at the same instant.
_RESOURCE_SWEEP_TTL_S = 1.0
_resource_sweep_lock = asyncio.Lock()
_resource_sweep_cache: dict[str, object] = {"at": 0.0, "payload": None}


@handler("terminal.resource_usage")
async def terminal_resource_usage(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Per-pane CPU and memory in one sweep, for the resource panel.

    Memory is the footprint number `terminal.memory_usage` already returns.
    CPU is the *accumulated* CPU seconds of the pane's process tree, not a
    percentage: a percentage only exists between two readings, and two windows
    sampling at different rates would each need their own interval. Returning
    the raw counter with the clock it was read at lets every caller difference
    against its own previous sample.

    The two sweeps are independent subprocesses, so they run concurrently; the
    whole call costs about as much as the slower one. Concurrent callers share
    one sweep — see _RESOURCE_SWEEP_TTL_S.
    """
    from . import app
    from .cli_risk import active_panes

    # Sampling is request-triggered but independent of the CPU/memory cache.
    # A cached CPU response must still deliver the latest completed risk state.
    app.cli_risk_service.request(active_panes(session.terminals, app._PTY_OWNERS))
    async with _resource_sweep_lock:
        now = time.monotonic()
        cached = _resource_sweep_cache["payload"]
        if cached is not None and now - float(_resource_sweep_cache["at"]) < _RESOURCE_SWEEP_TTL_S:
            # Projection is CPU work over every recorded signal: off the loop.
            risks = await asyncio.to_thread(
                app.cli_risk_service.current, active_panes(session.terminals, app._PTY_OWNERS)
            )
            await session.send_json(make_response(msg_id, msg_type, {**cached, "cliRisks": risks}))
            return
        result = await _collect_resource_usage(session)
        from . import acp_ws
        result = await acp_ws.with_resource_rows(result)
        _resource_sweep_cache["at"] = now
        _resource_sweep_cache["payload"] = result
    risks = await asyncio.to_thread(
        app.cli_risk_service.current, active_panes(session.terminals, app._PTY_OWNERS)
    )
    await session.send_json(make_response(msg_id, msg_type, {**result, "cliRisks": risks}))


@handler("terminal.cli_risk_action")
async def terminal_cli_risk_action(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app
    from .cli_risk import active_panes

    pane_id, signal_id, action = (payload.get(key) for key in ("paneId", "signalId", "action"))
    if not isinstance(pane_id, str) or not isinstance(signal_id, str) or action not in ("ignore", "allow"):
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", "invalid CLI risk action"))
        return
    owned = {sid: owner for sid, owner in app._PTY_OWNERS.items() if owner is session}
    panes = active_panes(session.terminals, owned)
    if not any(pane.pane_id == pane_id for pane in panes):
        await session.send_json(make_error(msg_id, msg_type, "TERMINAL_NOT_OWNED", "pane is not owned by this connection"))
        return
    try:
        # Disk evidence is vendor-wide, including roots active in another
        # owned window. Authorization above remains local to the target pane.
        await app.cli_risk_service.action(
            active_panes(session.terminals, app._PTY_OWNERS), pane_id, signal_id, action
        )
    except ValueError as err:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", str(err)))
        return
    risks = app.cli_risk_service.current(active_panes(session.terminals, app._PTY_OWNERS))
    await session.send_json(make_response(msg_id, msg_type, {"cliRisks": risks}))


@handler("cli_risk.ranges.list", "cli_risk.ranges.add", "cli_risk.ranges.update", "cli_risk.ranges.delete")
async def cli_risk_ranges(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Shared-CDN ranges whose connections are recorded without lighting the pill."""
    from . import app

    ranges = app.cli_risk_service.store.ranges
    operation = msg_type.rsplit(".", 1)[1]
    try:
        if operation == "add":
            await asyncio.to_thread(ranges.add, payload.get("cidr"), payload.get("label"))
        elif operation == "update":
            await asyncio.to_thread(ranges.set_enabled, payload.get("cidr"), payload.get("enabled"))
        elif operation == "delete":
            await asyncio.to_thread(ranges.delete, payload.get("cidr"))
        result = await asyncio.to_thread(ranges.list)
    except ValueError as err:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", str(err)))
        return
    await session.send_json(make_response(msg_id, msg_type, {"ranges": result}))


async def _collect_resource_usage(session: "Session") -> dict:
    """One CPU + memory sweep over every live PTY this backend owns."""
    from . import process_cpu, process_memory

    groups = session.terminals.memory_pid_groups()
    pids = [pid for _, pids in groups.values() for pid in pids]
    by_session = {sid: pids for sid, (_, pids) in groups.items()}
    measured, (cpu_measured, sampled_at) = await asyncio.gather(
        asyncio.to_thread(process_memory.footprints, pids),
        asyncio.to_thread(process_cpu.cpu_times, pids),
    )
    totals = process_memory.sum_by_group(by_session, measured)
    cpu_totals = process_cpu.sum_by_group(by_session, cpu_measured)
    panes = [
        {
            "terminal_session_id": sid,
            "pane_id": pane_id,
            "bytes": totals.get(sid, 0),
            "cpu_seconds": cpu_totals.get(sid, 0.0),
        }
        for sid, (pane_id, _) in groups.items()
    ]
    cpu_count, machine_memory = process_cpu.machine_capacity()
    return {
        # An empty sweep with live panes means it failed, which is not the same
        # as "no panes" — the panel has to tell those apart, per metric.
        "available": process_memory.available() and bool(measured or not groups),
        "cpu_available": process_cpu.available() and bool(cpu_measured or not groups),
        "sampled_at": sampled_at,
        "panes": panes,
        "total_bytes": sum(totals.values()),
        # Denominators for "how much of this machine", which is the question the
        # summary answers; the per-pane column stays relative to one core.
        "cpu_count": cpu_count,
        "machine_memory_bytes": machine_memory,
    }


@handler("terminal.log_sent")
async def terminal_log_sent(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    # Fire-and-forget: log injected text to the session's output log file.
    # No response needed — caller does not await this.
    session.terminals.log_sent(
        payload["terminal_session_id"],
        payload.get("label", "sent"),
        payload.get("text", ""),
    )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("client.diagnostic")
async def client_diagnostic(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Write a renderer-side diagnostic line into the backend log.

    The renderer has no log file of its own, so the timings only it can see —
    how long a pane sat in each preparation step, an IME composition that
    latched and started swallowing keys — had nowhere to land. An input-latency
    report therefore arrived with evidence for the PTY half and nothing for the
    half the user actually touches. Routing these here puts both halves on one
    timeline, in the file the user already reads.

    Deliberately dumb: the renderer decides what deserves a line (its probes
    are threshold-gated on that side), this only writes it down.
    """
    message = str(payload.get("message") or "")[:1000]
    if message:
        category = str(payload.get("category") or "ui")[:40]
        if payload.get("level") == "warning":
            client_log.warning("%s: %s", category, message)
        else:
            client_log.info("%s: %s", category, message)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("terminal.history")
async def terminal_history(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Return a pane's recorded transcript so a restore can replay its history.

    Exists because xterm keeps no scrollback for the alternate buffer and drops
    lines that scroll off it, so a restored pane could show only what the CLI
    repaints — the conversation above it was simply gone. The transcript on
    disk is ANSI-stripped plain text (terminals.py `_clean_for_log`), which is
    why replaying it is width-safe: there are no cursor coordinates to land in
    the wrong cell. It restores the conversation, not the coloured screen.

    The caller names a pane, never a path: the filename is derived from
    agent_key + pane_id, so this cannot be pointed at an arbitrary file.
    """
    workspace_path = str(payload.get("workspace_path") or "")
    agent_key = str(payload.get("agent_key") or "")
    pane_id = str(payload.get("pane_id") or "")
    if not (workspace_path and agent_key and pane_id):
        await session.send_json(make_response(msg_id, msg_type, {"ok": False, "text": ""}))
        return
    max_bytes = int(payload.get("max_bytes") or TRANSCRIPT_MAX_BYTES)
    # Plain file IO, but a long-lived pane's transcript can run to hundreds of
    # KB across several days' files — off the event loop so a restore storm
    # cannot stall it.
    text, truncated = await asyncio.to_thread(
        read_pane_transcript, workspace_path, agent_key, pane_id, max_bytes
    )
    # Answer ONE chunk per request. A whole transcript runs to hundreds of KB,
    # and shipping that as a single frame would hold the session send lock for
    # one serialize+write — long enough to sit in front of a heartbeat pong,
    # which is the shape behind the spurious-disconnect reports. terminal.output
    # slices at this size for the same reason; the caller loops for the rest.
    chunks = [
        text[i : i + TRANSCRIPT_CHUNK_CHARS]
        for i in range(0, len(text), TRANSCRIPT_CHUNK_CHARS)
    ] or [""]
    index = max(0, int(payload.get("chunk") or 0))
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "ok": True,
                "text": chunks[index] if index < len(chunks) else "",
                "chunk": index,
                "total_chunks": len(chunks),
                "truncated": truncated,
            },
        )
    )


@handler("terminal.resize")
async def terminal_resize(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    # Drain old-width output BEFORE the ioctl + ack so it reaches the
    # frontend first — otherwise xterm re-wraps stale-width content
    # after narrowing and the CLI's repaints strand corrupt frames in
    # scrollback (visible as residual text). See drain_output().
    await session.terminals.drain_output(payload["terminal_session_id"])
    session.terminals.resize(
        payload["terminal_session_id"],
        int(payload["cols"]),
        int(payload["rows"]),
    )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("terminal.interrupt")
async def terminal_interrupt(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    session.terminals.interrupt(payload["terminal_session_id"])
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("terminal.kill")
async def terminal_kill(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # We don't have direct session_id → pane_id mapping at the app layer;
    # the TerminalService does. Look it up before killing so we can
    # release the attribution registration.
    term_session_id = payload["terminal_session_id"]
    force = bool(payload.get("force", False))
    owner = app._PTY_OWNERS.get(term_session_id)
    # An ownerless PTY is killable by anyone. The owner entry is dropped when a
    # connection goes away, so refusing every caller once it was gone left a
    # live PTY nothing could reach: the renderer had already dropped the pane
    # record, and the process only died with the hourly ownerless sweep. A
    # different LIVE connection still blocks the kill, which is the
    # cross-window guard this check exists for.
    if owner is not None and owner is not session:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "TERMINAL_NOT_OWNED",
                "terminal session is not owned by this connection; reattach it first",
                {"terminal_session_id": term_session_id},
            )
        )
        return
    pane_id_for_unreg = ""
    dock: tuple[str, str] | None = None
    for sess in session.terminals._sessions.values():  # noqa: SLF001
        if sess.id == term_session_id:
            pane_id_for_unreg = sess.pane_id
            dock = _dock_target(getattr(sess, "metadata", None) or {})
            break
    try:
        await session.terminals.kill(term_session_id, force=force)
        if pane_id_for_unreg:
            app.attribution.unregister_pane(pane_id_for_unreg)
    finally:
        if app._PTY_OWNERS.get(term_session_id) is session:
            app._PTY_OWNERS.pop(term_session_id, None)
    # A panel's CLI the user stopped is not one to bring back on the next
    # window open. Only the panel's Stop flags its kill: the Host also kills
    # panel PTYs (plugin recovery, a revoked version, a create cleanup), and
    # those must leave the record to restore. The flag reaches no record but
    # the killed session's own panel one (its metadata, not the payload).
    if dock and pane_id_for_unreg and payload.get("retire_restore") is True:
        _DOCK_PTYS.pop(term_session_id, None)
        await asyncio.to_thread(_retire_dock_record, dock[0], pane_id_for_unreg, dock[1])
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))
    # The process behind the pane is gone (idle reclaim comes through here
    # too): nothing can beat for it until a respawn, so close its intervals.
    if pane_id_for_unreg:
        for workspace_path in app.dev_time_store.pane_removed(pane_id_for_unreg):
            await app.broadcast(make_event("devtime.changed", {"workspace_path": workspace_path}))


@handler("terminal.kill_surface")
async def terminal_kill_surface(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """End the embedded AI panels one window held.

    Sent when a Plan / Git / Editor window closes (not on app quit, whose
    records stay 'spawned' to restore next launch), and when the main window
    closes a workspace (its Pipeline Manager panel). `workspace_path` scopes it
    to one workspace; a single-instance window that cannot say which workspace
    its panel last ran in leaves it out and ends its surface everywhere. Each
    matching PTY goes down, its restore record is retired the way
    manual_pane.unspawn retires one, and its roster entry is dropped. Only
    sessions whose terminal metadata names this panel surface are reached: a
    window pane's create carries none, so nothing a window shows is ever
    touched. Idempotent; replies with the pane ids it ended."""
    from . import app

    surface = str(payload.get("surface") or "")
    ended: dict[str, str] = {}  # pane id -> workspace its panel ran in
    # Panels whose kill raised: still running, so the caller is told which.
    failed: list[dict[str, str]] = []
    for term_session_id, pane_id, workspace_path in session.terminals.live_ids_for_surface(
        surface, str(payload.get("workspace_path") or "")
    ):
        # Kill this session id, not every PTY under the pane id: only the
        # session that names the surface is known to be a panel.
        try:
            await session.terminals.kill(term_session_id, force=True)
        except Exception as exc:  # noqa: BLE001 — one panel's failed kill must not leave the rest running
            log.exception("terminal.kill_surface: killing %s (%s) failed", term_session_id, pane_id)
            failed.append({"pane_id": pane_id, "terminal_session_id": term_session_id,
                           "error": str(exc) or type(exc).__name__})
            continue
        app._PTY_OWNERS.pop(term_session_id, None)
        app.attribution.unregister_pane(pane_id)
        ended.setdefault(pane_id, workspace_path)
    for pane_id, workspace_path in ended.items():
        for ws in app.dev_time_store.pane_removed(pane_id):
            await app.broadcast(make_event("devtime.changed", {"workspace_path": ws}))
        entry = agent_messaging.get(pane_id)
        if entry is not None and entry.is_dock and agent_messaging.unregister(pane_id):
            app.forget_pane_activity(pane_id)
            server_link.roster_changed()
        if not workspace_path:
            continue
        try:
            # Only a panel's own record: the store never lets a panel take over
            # a window pane's, and ending the panel must not retire one either.
            project = app.project_store.load_or_create(workspace_path)
            if any(p.pane_id == pane_id and p.surface == surface for p in project.panes):
                app.project_store.record_manual_pane_unspawn(workspace_path, pane_id=pane_id)
        except Exception:  # noqa: BLE001 — the PTY is down; a lost record update must not fail the close
            log.exception("terminal.kill_surface: retiring %s in %s failed", pane_id, workspace_path)
    await session.send_json(
        make_response(msg_id, msg_type, {"ok": True, "pane_ids": list(ended), "failed": failed})
    )


@handler("terminal.dock_record")
async def terminal_dock_record(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """An embedded AI panel's restore record, for the panel to resume on its own
    after an app quit: {agent, session_id} while the record is 'spawned', else
    None. A read through the write-free peek — the Mini-IDE opens sub-folders,
    which must not get a project written into them — and only ever a panel's
    record, never a window pane's."""
    from . import app

    pane_id = str(payload.get("pane_id") or "")
    project = app.project_store.peek(str(payload.get("workspace_path") or "")) if pane_id else None
    record = next(
        (
            p for p in (project.panes if project else [])
            if p.pane_id == pane_id
            and p.spawn_status == "spawned"
            and p.surface
            and p.surface != "main"
        ),
        None,
    )
    await session.send_json(make_response(msg_id, msg_type, {
        "record": {"agent": record.agent, "session_id": record.session_id} if record else None,
    }))


@handler("terminal.dock_retire")
async def terminal_dock_retire(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Retire one panel's restore record instead of resuming it — the panel asks
    when the plugin that provides its surface is gone. Same rule as a Stop: only
    that pane's record under that panel surface, never a window pane's."""
    pane_id = str(payload.get("pane_id") or "")
    surface = str(payload.get("surface") or "")
    workspace_path = str(payload.get("workspace_path") or "")
    if pane_id and workspace_path and surface and surface != "main":
        _retire_dock_record(workspace_path, pane_id, surface)
    await session.send_json(make_response(msg_id, msg_type, {}))


@handler("terminal.reattach")
async def terminal_reattach(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # A reconnecting renderer rebinds to still-running PTYs. Report which
    # ids survived; the frontend rebinds those and falls back to
    # spawn+resume for the rest. Force a one-shot SIGWINCH on survivors so
    # agent TUIs repaint into the fresh (empty) xterm. This is NOT the
    # forbidden "auto-redraw a running, visible pane" (no existing content
    # to reflow-corrupt) — it's the only way a reattached blank xterm
    # recovers its screen, since there is no server-side output buffer.
    if not isinstance(payload, dict):
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "terminal.reattach request is malformed")
        )
        return
    attestation_fields = {
        "expected_workspace_path", "expected_origin", "expected_profile_ids",
    }
    if attestation_fields.intersection(payload) and not session.host_authenticated:
        await session.send_json(
            make_error(msg_id, msg_type, "UNAUTHORIZED", "Host session is not authenticated")
        )
        return
    if (
        "expected_workspace_path" in payload
        and not isinstance(payload["expected_workspace_path"], str)
    ) or (
        "expected_origin" in payload
        and not isinstance(payload["expected_origin"], str)
    ) or (
        "expected_profile_ids" in payload
        and (
            not isinstance(payload["expected_profile_ids"], list)
            or not all(isinstance(profile_id, str) for profile_id in payload["expected_profile_ids"])
        )
    ):
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "terminal.reattach attestation is malformed")
        )
        return

    ids = [str(x) for x in (payload.get("terminal_session_ids") or [])]
    cols = int(payload.get("cols", 0))
    rows = int(payload.get("rows", 0))
    expected_workspace_path = payload.get("expected_workspace_path")
    expected_origin = payload.get("expected_origin")
    expected_profile_ids = payload.get("expected_profile_ids")
    stored_sessions = session.terminals._sessions  # noqa: SLF001
    alive: list[str] = []
    dead: list[str] = []
    for tid in ids:
        stored = stored_sessions.get(tid)
        if stored is None or stored.closed:
            dead.append(tid)
            continue
        if expected_workspace_path is not None and os.path.realpath(stored.cwd) != os.path.realpath(expected_workspace_path):
            dead.append(tid)
            continue
        if expected_origin is not None:
            stored_origin = stored.metadata.get("origin")
            if stored_origin != expected_origin and not (
                expected_origin == "mini-ide" and stored_origin == "editor"
            ):
                dead.append(tid)
                continue
        if expected_profile_ids is not None and stored.agent_key not in expected_profile_ids:
            dead.append(tid)
            continue
        alive.append(tid)
    # Transfer ownership of reattached PTYs to this window.
    app._claim_ptys(session, alive)
    if cols > 0 and rows > 0:
        for tid in alive:
            session.terminals.force_redraw(tid, cols, rows)
    # Where each survivor is actually writing its transcript. A reattaching
    # pane has a fresh pane id, and the path its caller derives from that id
    # names a file no one ever opened — the conversation is in the log the
    # session opened at create time. Absent for a session started without one.
    from .terminals import live_output_log_for

    logs = {tid: live_output_log_for(tid) for tid in alive}
    sessions: dict[str, dict[str, str]] = {}
    if session.host_authenticated:
        for tid in alive:
            stored = stored_sessions.get(tid)
            if stored is None:
                continue
            row = {
                "agent_key": stored.agent_key or "",
                "workspace_path": os.path.realpath(stored.cwd),
            }
            origin = stored.metadata.get("origin")
            if isinstance(origin, str) and origin:
                row["origin"] = origin
            sessions[tid] = row
    response_payload: dict[str, Any] = {
        "alive": alive,
        "dead": dead,
        "logs": {tid: path for tid, path in logs.items() if path},
    }
    if session.host_authenticated:
        response_payload["sessions"] = sessions
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            response_payload,
        )
    )


@handler("terminal.redraw")
async def terminal_redraw(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    # One-shot SIGWINCH nudge so a TUI repaints cleanly after a resize
    # settles, clearing the reflow residue xterm leaves when it re-wraps
    # the old frame at the new width. Unlike terminal.reattach this does
    # NOT re-route the active session — it is a pure repaint of an
    # already-attached, visible pane (the frontend gates it on width
    # stable + CLI quiet, see useTerminal scheduleResizeRedraw).
    tid = str(payload.get("terminal_session_id") or "")
    cols = int(payload.get("cols", 0))
    rows = int(payload.get("rows", 0))
    if tid and cols > 0 and rows > 0:
        # Order the repaint SIGWINCH AFTER any pending output, the same
        # barrier terminal.resize uses (drain_output). The frontend can
        # fire this mid-stream when a busy pane hits its bounded-wait
        # deadline; without draining first, the SIGWINCH could interrupt
        # an in-flight frame and strand a corrupt repaint — exactly what
        # the resize drain/grace machinery exists to prevent.
        await session.terminals.drain_output(tid)
        session.terminals.force_redraw(tid, cols, rows)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


# ── Projects (project.*) ─────────────────────────────────────────────────────
@handler("project.upsert")
async def project_upsert(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    project = app.project_store.load_or_create(
        payload["workspace_path"],
        name=payload.get("name", ""),
        backend_version=app.__version__,
    )
    app._register_workspace_and_backfill(project.workspace_path)
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


@handler("project.get")
async def project_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    project = app.project_store.load_or_create(payload["workspace_path"])
    app._register_workspace_and_backfill(project.workspace_path)
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


@handler("project.peek")
async def project_peek(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    project = app.project_store.peek(ws_raw)
    if project:
        app._register_workspace_and_backfill(project.workspace_path)
        peek_payload = app._project_payload(project)
        peek_payload["plan_spec_available"] = app.plan_spec_exists(
            project.workspace_path
        )
        await session.send_json(
            make_response(msg_id, msg_type, peek_payload)
        )
    else:
        # Even when no .agent-team/project.json exists yet, register
        # any valid directory the user "opens" so its historic CLI
        # sessions can show up in cumulative immediately.
        import os as _os
        ws_abs = _os.path.abspath(ws_raw) if ws_raw else ""
        if ws_abs and _os.path.isdir(ws_abs):
            app._register_workspace_and_backfill(ws_abs)
        await session.send_json(
            make_response(
                msg_id,
                msg_type,
                {
                    "project": None,
                    "paths": None,
                    "plan_spec_available": app.plan_spec_exists(ws_abs),
                },
            )
        )


@handler("project.set_layout_mode")
async def project_set_layout_mode(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    mode = payload.get("layout_mode", "grid")
    if mode not in ("auto", "grid", "spotlight", "fullscreen"):
        mode = "grid"
    app.project_store.set_layout_mode(ws_raw, mode)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("project.set_pane_order")
async def project_set_pane_order(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    pane_ids = payload.get("pane_ids") or []
    if isinstance(pane_ids, list):
        app.project_store.set_pane_order(
            ws_raw, pane_ids=[p for p in pane_ids if isinstance(p, str)]
        )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("project.set_pane_stopped")
async def project_set_pane_stopped(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    pane_id = payload.get("pane_id", "") or ""
    stopped = bool(payload.get("stopped", False))
    if ws_raw and pane_id:
        app.project_store.set_pane_stopped(ws_raw, pane_id=pane_id, stopped=stopped)
        asyncio.create_task(
            app.broadcast(make_event("pane.stopped", {
                "workspace_path": ws_raw, "pane_id": pane_id, "stopped": stopped,
            }))
        )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("project.set_pane_minimized")
async def project_set_pane_minimized(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Collapsed-to-sidebar state.

    The renderer has been sending this since the feature shipped, but no
    handler existed — backend.send is fire-and-forget, so nothing surfaced and
    the state silently reset on every restart.
    """
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    pane_id = payload.get("pane_id", "") or ""
    is_minimized = bool(payload.get("is_minimized", False))
    if ws_raw and pane_id:
        app.project_store.set_pane_minimized(ws_raw, pane_id=pane_id, is_minimized=is_minimized)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("project.set_pane_muted")
async def project_set_pane_muted(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Per-pane mute: the renderer stops this pane's desktop notification and
    sound; persisted so a restart keeps the pane quiet."""
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    pane_id = payload.get("pane_id", "") or ""
    is_muted = bool(payload.get("is_muted", False))
    if ws_raw and pane_id:
        app.project_store.set_pane_muted(ws_raw, pane_id=pane_id, is_muted=is_muted)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("project.set_pane_resume_state")
async def project_set_pane_resume_state(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """What a pane was doing and the report it owes its parent, so a manual
    restart can bring back the panes it interrupted. Each field is optional;
    only the ones sent are written."""
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    pane_id = payload.get("pane_id", "") or ""
    turn_state = payload.get("last_turn_state")
    report_to = payload.get("report_to")
    report_pending = payload.get("report_pending")
    report_cross = payload.get("report_cross")
    live_launch = payload.get("last_live_launch")
    applied = False
    if ws_raw and pane_id:
        project = app.project_store.set_pane_resume_state(
            ws_raw,
            pane_id=pane_id,
            last_turn_state=turn_state if isinstance(turn_state, str) else None,
            report_to=report_to if isinstance(report_to, str) else None,
            report_pending=report_pending if isinstance(report_pending, bool) else None,
            last_live_launch=live_launch if isinstance(live_launch, str) else None,
            report_cross=report_cross if isinstance(report_cross, bool) else None,
        )
        # Not an error, but say so: a write that matched no record is lost.
        applied = any(p.pane_id == pane_id for p in project.panes)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "applied": applied}))


@handler("project.set_pane_collapsed")
async def project_set_pane_collapsed(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Whether this pane's lineage subtree is folded in the agent lists."""
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    pane_id = payload.get("pane_id", "") or ""
    collapsed = bool(payload.get("collapsed", False))
    if ws_raw and pane_id:
        app.project_store.set_pane_collapsed(ws_raw, pane_id=pane_id, collapsed=collapsed)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("project.set_tab_order")
async def project_set_tab_order(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    tab_order = payload.get("tab_order") or []
    if isinstance(tab_order, list):
        app.project_store.set_tab_order(
            ws_raw, tab_order=[t for t in tab_order if isinstance(t, str)]
        )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("project.set_ui_state")
async def project_set_ui_state(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    raw_groups = payload.get("run_groups")
    run_groups = (
        [g for g in raw_groups if isinstance(g, dict)]
        if isinstance(raw_groups, list)
        else None
    )
    raw_tab = payload.get("active_tab")
    active_tab = raw_tab if isinstance(raw_tab, str) else None
    raw_repo = payload.get("git_tab_repo")
    git_tab_repo = raw_repo if isinstance(raw_repo, str) else None
    raw_history = payload.get("spawn_history")
    full_history = (
        [entry for entry in raw_history if isinstance(entry, dict)]
        if isinstance(raw_history, list)
        else None
    )
    raw_cli_order = payload.get("cli_agent_order")
    cli_agent_order = (
        [k for k in raw_cli_order if isinstance(k, str)]
        if isinstance(raw_cli_order, list)
        else None
    )
    raw_cli_disabled = payload.get("cli_agent_disabled")
    cli_agent_disabled = (
        [k for k in raw_cli_disabled if isinstance(k, str)]
        if isinstance(raw_cli_disabled, list)
        else None
    )
    if full_history is not None and ws_raw:
        # Workspace isolation at the write layer: never persist entries that
        # belong to another workspace, in the full store or the mirror.
        # merge() filters again on its own — each layer stands alone.
        full_history = filter_foreign_entries(
            ws_raw, full_history, context="set_ui_state"
        )
    spawn_history = full_history[-100:] if full_history is not None else None

    # Offload the blocking read-modify-write (json.dumps + write_text +
    # os.replace) to a worker thread: during cold-start restore storms the
    # event loop is contended enough that a synchronous save can blow the
    # frontend's 10s RPC deadline and lose UI state. The store's save lock
    # serializes concurrent offloaded calls.
    def _persist():
        # Full-store merge first (upsert-only, never deletes), then the
        # legacy 100-entry mirror in project.json for backward compat. The
        # peek gates the merge so an unknown workspace still creates no
        # files, and seeds the one-time migration from the old mirror.
        if full_history is not None:
            prev = app.project_store.peek(ws_raw)
            if prev is not None:
                # Discovery may precede the first renderer history snapshot.
                # Keep the backend's durable identity when that snapshot has
                # not received session.detected yet.
                sessions = {p.pane_id: p.session_id for p in prev.panes if p.session_id}
                for entry in full_history:
                    if not entry.get("sessionId") and entry.get("paneId") in sessions:
                        entry["sessionId"] = sessions[entry["paneId"]]
                app.spawn_history_store.merge(
                    ws_raw, full_history, seed=prev.ui_spawn_history
                )
        return app.project_store.set_ui_state(
            ws_raw,
            run_groups=run_groups,
            active_tab=active_tab,
            git_tab_repo=git_tab_repo,
            spawn_history=spawn_history,
            cli_agent_order=cli_agent_order,
            cli_agent_disabled=cli_agent_disabled,
        )

    project = await asyncio.to_thread(_persist)
    if project is not None:
        # Peer windows on the same workspace adopt the change live
        # (replaces the old cross-window localStorage `storage` event).
        delta: dict = {"workspace_path": project.workspace_path}
        if run_groups is not None:
            delta["run_groups"] = run_groups
        if active_tab is not None:
            delta["active_tab"] = active_tab
        if git_tab_repo is not None:
            delta["git_tab_repo"] = git_tab_repo
        if spawn_history is not None:
            delta["spawn_history"] = spawn_history
        if cli_agent_order is not None:
            delta["cli_agent_order"] = cli_agent_order
        if cli_agent_disabled is not None:
            delta["cli_agent_disabled"] = cli_agent_disabled
        await app.broadcast(
            make_event("project.ui_state_changed", delta), exclude=session
        )
    # ok mirrors persistence so the frontend's one-time localStorage
    # migration only deletes its legacy copy after a real ack.
    await session.send_json(
        make_response(msg_id, msg_type, {"ok": project is not None})
    )


@handler("project.get_spawn_history")
async def project_get_spawn_history(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Paged read of the full spawn history (spawn-history.json).

    `offset` counts from the newest end (0 = latest); the returned page is
    newest → oldest. Falls back to seeding the full store from the
    project.json mirror for projects created before the store existed.
    """
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    raw_offset = payload.get("offset")
    offset = raw_offset if isinstance(raw_offset, int) and raw_offset >= 0 else 0
    raw_limit = payload.get("limit")
    limit = raw_limit if isinstance(raw_limit, int) and 0 < raw_limit <= 1000 else 100

    def _read() -> tuple[list[dict], int]:
        project = app.project_store.peek(ws_raw)
        seed = project.ui_spawn_history if project is not None else None
        return app.spawn_history_store.read_page(
            ws_raw, offset=offset, limit=limit, seed=seed
        )

    entries, total = await asyncio.to_thread(_read)
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "entries": entries,
                "total": total,
                "offset": offset,
                # Symlink-resolved identity of the workspace so the renderer
                # can also match entries recorded under the canonical spelling.
                "canonical_workspace_path": (
                    canonical_workspace_path(ws_raw) if ws_raw else ""
                ),
            },
        )
    )


@handler("project.set_display_name")
async def project_set_display_name(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Persist a user-set display name for the workspace itself.

    The truth lives in the workspace's own project document, alongside that
    project's other ui state: the alias stays with the project folder, is
    independent per project, and survives the global settings caches being
    rebuilt or cleared. It does NOT leave this machine — `.agent-team/` is
    git-ignored (the repo ignores it, and db.py writes a self-ignoring
    `.gitignore` inside it), so the alias is never committed, pulled, or seen
    by a teammate.

    The global recent-workspaces store keeps a `name` mirror on top, because
    the Welcome and sidebar recent lists draw many workspaces at once and
    cannot open every project's db to find their names.

    Empty `display_name` clears the alias: the project document goes back to ""
    and the mirror back to the folder basename. The path stays the only
    identifier — aliases are cosmetic and may repeat.

    The store uses load_or_create rather than peek, so a workspace that has no
    project document yet gets one instead of swallowing the rename. `ok`
    therefore reports whether the name was really persisted: there is no path
    that answers a rename with a success the user did not get.
    """
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    display_name = (payload.get("display_name", "") or "").strip()
    if not ws_raw.strip():
        await session.send_json(
            make_response(
                msg_id, msg_type, {"ok": False, "error": "workspace_path is required"}
            )
        )
        return

    # Same reason as set_ui_state: the read-modify-write plus save is
    # blocking, and the store's save lock serializes offloaded callers.
    def _persist():
        proj = app.project_store.set_display_name(ws_raw, display_name)
        if proj is not None:
            app.recent_workspaces_store.set_name(ws_raw, display_name)
        return proj

    project = await asyncio.to_thread(_persist)
    if project is None:
        await session.send_json(
            make_response(
                msg_id,
                msg_type,
                {"ok": False, "error": "could not write the project document"},
            )
        )
        return

    # Peer windows adopt the new name live (sidebar, title bar).
    await app.broadcast(
        make_event(
            "project.ui_state_changed",
            {
                "workspace_path": project.workspace_path,
                "display_name": display_name,
            },
        ),
        exclude=session,
    )
    # And the Welcome recent list re-reads the mirror.
    recent = await asyncio.to_thread(app.recent_workspaces_store.list)
    await app.broadcast(
        make_event(
            "workspace.recent_changed",
            {"recent": recent, "reason": "display_name"},
        )
    )
    await session.send_json(
        make_response(msg_id, msg_type, {"ok": True, "display_name": display_name})
    )


@handler("project.rename_pane")
async def project_rename_pane(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    pane_id = payload.get("pane_id", "") or ""
    custom_name = (payload.get("custom_name", "") or "").strip()
    if pane_id:
        project = app.project_store.rename_pane(
            ws_raw, pane_id=pane_id, custom_name=custom_name
        )
        # Patch the full store (spawn-history.json) at the source too: the
        # renderer's debounced snapshot merge also carries the rename, but it
        # can be lost on quit and never runs in detached windows.
        if project is not None:
            await asyncio.to_thread(
                app.spawn_history_store.patch_entry,
                ws_raw,
                pane_id,
                {"customName": custom_name or None},
                seed=project.ui_spawn_history,
            )
        # rename_pane() patches the persisted history mirror; push it to
        # peer windows so their in-memory copies (and later snapshots)
        # don't clobber the rename with stale entries. renamed_pane lets
        # peers also patch their live panes[] state — spawn_history alone
        # leaves their pane titles/lists showing the old name.
        if project is not None:
            delta: dict = {
                "workspace_path": project.workspace_path,
                "renamed_pane": {"pane_id": pane_id, "custom_name": custom_name},
            }
            if project.ui_spawn_history is not None:
                delta["spawn_history"] = project.ui_spawn_history
            await app.broadcast(
                make_event("project.ui_state_changed", delta),
                exclude=session,
            )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("project.set_pane_auto_name")
async def project_set_pane_auto_name(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Persist an auto-generated pane title (custom_name always wins).

    *source* is "heuristic" (the renderer's instant string title) or "llm" (the
    model's answer, which may upgrade a heuristic title once); see
    ProjectStore.set_pane_auto_name for the full write ordering. Anything else
    is treated as "heuristic" rather than rejected — an unknown source from an
    older window should still be able to name a pane.

    An accepted write patches both the project.json spawn-history mirror
    (autoName key, via the store) and the full spawn-history store, the same
    way rename_pane does — the mirror only holds the last 100 entries, so
    older ones would otherwise depend entirely on the renderer's debounced
    snapshot. A no-op (empty name, or a write the ordering rejects) touches
    neither store and is not broadcast — the store is the final arbiter of the
    cross-window race, so only the winning write reaches peer windows.
    """
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    pane_id = payload.get("pane_id", "") or ""
    auto_name = (payload.get("auto_name", "") or "").strip()
    source = (payload.get("source", "") or "heuristic").strip()
    if source not in ("heuristic", "llm"):
        source = "heuristic"
    if pane_id:
        project, changed = app.project_store.set_pane_auto_name(
            ws_raw, pane_id=pane_id, auto_name=auto_name, source=source
        )
        if project is not None and changed:
            # Patch the full store at the source too: the renderer's debounced
            # snapshot merge also carries the name, but it can be lost on quit
            # and never runs in detached windows.
            await asyncio.to_thread(
                app.spawn_history_store.patch_entry,
                ws_raw,
                pane_id,
                {"autoName": auto_name},
                seed=project.ui_spawn_history,
            )
            # Peers patch their live panes[] state from auto_named_pane so
            # their titles converge on the winning name.
            await app.broadcast(
                make_event(
                    "project.ui_state_changed",
                    {
                        "workspace_path": project.workspace_path,
                        "auto_named_pane": {
                            "pane_id": pane_id,
                            "auto_name": auto_name,
                            "source": source,
                        },
                    },
                ),
                exclude=session,
            )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("pane.generate_auto_name")
async def pane_generate_auto_name(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Ask the local model for a better pane title than the string heuristic.

    Best-effort by construction: the renderer has already titled the pane
    before it sends this, so a failure here just leaves that title in place.
    The answer is persisted through the same set_pane_auto_name arbiter (with
    source="llm"), which is what stops a slow answer from renaming a pane the
    user has since renamed themselves.
    """
    from . import app
    from . import pane_name_service

    ws_raw = payload.get("workspace_path", "") or ""
    pane_id = payload.get("pane_id", "") or ""
    material = payload.get("material", "") or ""
    model = payload.get("model", "") or app.ANALYZER_DEFAULT_MODEL
    if not pane_id or not material.strip():
        await session.send_json(make_response(msg_id, msg_type, {"ok": False, "name": ""}))
        return

    result = await pane_name_service.generate_pane_name(material, app._az_base_url(), model)
    if not result.get("ok"):
        await session.send_json(make_response(
            msg_id, msg_type, {"ok": False, "name": "", "error": result.get("error", "")}
        ))
        return

    name = result["name"]
    project, changed = app.project_store.set_pane_auto_name(
        ws_raw, pane_id=pane_id, auto_name=name, source="llm"
    )
    if project is not None and changed:
        await asyncio.to_thread(
            app.spawn_history_store.patch_entry,
            ws_raw,
            pane_id,
            {"autoName": name},
            seed=project.ui_spawn_history,
        )
        await app.broadcast(
            make_event(
                "project.ui_state_changed",
                {
                    "workspace_path": project.workspace_path,
                    "auto_named_pane": {
                        "pane_id": pane_id,
                        "auto_name": name,
                        "source": "llm",
                    },
                },
            ),
            exclude=session,
        )
    # 'changed' is reported so the caller can tell an accepted upgrade from one
    # the arbiter refused (the pane was renamed while the model was thinking).
    await session.send_json(make_response(
        msg_id, msg_type, {"ok": True, "name": name, "changed": changed}
    ))


@handler("project.rename_spawn_history")
async def project_rename_spawn_history(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Rename a spawn-history entry whose pane no longer exists.

    Unlike project.rename_pane this never creates a pane record: it patches
    the full store (spawn-history.json) plus the project.json mirror, then
    broadcasts the updated mirror so peer windows adopt the new name.
    """
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    pane_id = payload.get("pane_id", "") or ""
    custom_name = (payload.get("custom_name", "") or "").strip()
    patched = False
    if pane_id:

        def _patch():
            project = app.project_store.peek(ws_raw)
            seed = project.ui_spawn_history if project is not None else None
            ok = app.spawn_history_store.patch_entry(
                ws_raw, pane_id, {"customName": custom_name or None}, seed=seed
            )
            # Entries past the mirror's 100-entry window simply aren't there
            # to patch — rename_history_entry() returns None and no broadcast
            # is needed (peers can't be showing them from the mirror anyway).
            mirror_project = app.project_store.rename_history_entry(
                ws_raw, pane_id=pane_id, custom_name=custom_name
            )
            return ok, mirror_project

        patched, project = await asyncio.to_thread(_patch)
        if project is not None and project.ui_spawn_history is not None:
            await app.broadcast(
                make_event(
                    "project.ui_state_changed",
                    {
                        "workspace_path": project.workspace_path,
                        "spawn_history": project.ui_spawn_history,
                    },
                ),
                exclude=session,
            )
    await session.send_json(
        make_response(msg_id, msg_type, {"ok": True, "patched": patched})
    )


@handler("project.star_spawn_history")
async def project_star_spawn_history(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Star or unstar a spawn-history entry.

    Same dual-layer patch as project.rename_spawn_history: the full store
    (spawn-history.json) plus the project.json mirror, then a mirror
    broadcast so peer windows adopt the flag. Unstarring removes the key
    (patch_entry deletes on None) instead of storing False. Starred entries
    are skipped by bulk cleanup (see SpawnHistoryStore.delete_entries).
    """
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    pane_id = payload.get("pane_id", "") or ""
    starred = bool(payload.get("starred"))
    patched = False
    if pane_id:

        def _patch():
            project = app.project_store.peek(ws_raw)
            seed = project.ui_spawn_history if project is not None else None
            ok = app.spawn_history_store.patch_entry(
                ws_raw, pane_id, {"starred": True if starred else None}, seed=seed
            )
            # Entries past the mirror's 100-entry window aren't there to
            # patch — star_history_entry() returns None and no broadcast is
            # needed (peers can't be showing them from the mirror anyway).
            mirror_project = app.project_store.star_history_entry(
                ws_raw, pane_id=pane_id, starred=starred
            )
            return ok, mirror_project

        patched, project = await asyncio.to_thread(_patch)
        if project is not None and project.ui_spawn_history is not None:
            await app.broadcast(
                make_event(
                    "project.ui_state_changed",
                    {
                        "workspace_path": project.workspace_path,
                        "spawn_history": project.ui_spawn_history,
                    },
                ),
                exclude=session,
            )
    await session.send_json(
        make_response(msg_id, msg_type, {"ok": True, "patched": patched})
    )


@handler("project.delete_spawn_history")
async def project_delete_spawn_history(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Delete spawn-history entries from the full store and the mirror.

    Modes: "ids" (explicit pane_ids), "removed" (every removed entry),
    "older_than" (removed entries spawned before cutoff_iso). A live pane is
    never killed, but the entry's CLI transcript log is unlinked with it.
    Peers get the updated mirror via project.ui_state_changed.

    ``dry_run: true`` reports what the same request would delete — identical
    response shape, no store rewrite, no unlink, no broadcast — so the
    renderer can confirm the log loss and the reclaimed space first.
    """
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    mode = payload.get("mode")
    # Truthy (not strictly `True`) so a sloppy client errs toward previewing
    # rather than toward an unconfirmed destructive delete.
    dry_run = bool(payload.get("dry_run"))
    raw_ids = payload.get("pane_ids")
    pane_ids = (
        [p for p in raw_ids if isinstance(p, str) and p]
        if isinstance(raw_ids, list)
        else []
    )
    raw_cutoff = payload.get("cutoff_iso")
    cutoff_iso = raw_cutoff if isinstance(raw_cutoff, str) and raw_cutoff else None
    if (
        mode not in ("ids", "removed", "older_than")
        or (mode == "ids" and not pane_ids)
        or (mode == "older_than" and cutoff_iso is None)
    ):
        await session.send_json(
            make_error(
                msg_id, msg_type, "BAD_REQUEST", "invalid delete_spawn_history request"
            )
        )
        return

    def _delete():
        project = app.project_store.peek(ws_raw)
        seed = project.ui_spawn_history if project is not None else None
        result = app.spawn_history_store.delete_entries(
            ws_raw,
            mode=mode,
            pane_ids=pane_ids,
            cutoff_iso=cutoff_iso,
            seed=seed,
            dry_run=dry_run,
        )
        # Keep the project.json mirror consistent: drop exactly the entries
        # the store deleted (the store is a superset of the mirror after the
        # seed migration above, so filtering by id is complete).
        if not dry_run and result.deleted_ids and project is not None and project.ui_spawn_history:
            gone = set(result.deleted_ids)
            mirror = [
                e
                for e in project.ui_spawn_history
                if not (isinstance(e, dict) and e.get("paneId") in gone)
            ]
            project = app.project_store.set_ui_state(ws_raw, spawn_history=mirror)
        return result, project

    result, project = await asyncio.to_thread(_delete)
    deleted_ids = result.deleted_ids
    if not dry_run and deleted_ids and project is not None:
        await app.broadcast(
            make_event(
                "project.ui_state_changed",
                {
                    "workspace_path": project.workspace_path,
                    "spawn_history": project.ui_spawn_history or [],
                },
            ),
            exclude=session,
        )
    # `deleted`/`total` are what the existing renderer reads; the two log
    # fields are additive so the Storage settings page can show what the
    # delete reclaimed.
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "deleted": len(deleted_ids),
                "total": result.total,
                "freed_bytes": result.freed_bytes,
                "removed_log_files": result.removed_log_files,
            },
        )
    )


@handler("project.set_theme")
async def project_set_theme(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # Backup-only persistence: localStorage in the renderer is the source
    # of truth. We just stash the latest theme + custom overrides so they
    # can sync across devices. Unknown workspace → silently no-op.
    ws_raw = payload.get("workspace_path", "") or ""
    theme = payload.get("theme")
    custom = payload.get("theme_custom")
    app.project_store.set_theme(
        ws_raw,
        theme=theme if isinstance(theme, str) and theme else None,
        theme_custom=custom if isinstance(custom, dict) else None,
    )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("project.set_language")
async def project_set_language(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # Backup-only persistence: localStorage in the renderer is the source
    # of truth. Unknown workspace → silently no-op.
    ws_raw = payload.get("workspace_path", "") or ""
    lang = payload.get("language")
    app.project_store.set_language(ws_raw, lang if isinstance(lang, str) and lang else None)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("project.log_event")
async def project_log_event(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload["workspace_path"]
    # Route to the run-specific log file (e.g. pipeline-20260528-…log)
    # rather than the generic pipeline.log fallback.
    _proj = app.project_store.peek(ws_path)
    _log_name = _proj.log_file_name if _proj else ""
    app.project_store.record_pane_event(
        ws_path,
        event_type=payload.get("event_type", "note"),
        pane_id=payload.get("pane_id", ""),
        agent=payload.get("agent", ""),
        role=payload.get("role", ""),
        origin=payload.get("origin", "manual"),
        details=payload.get("details"),
        log_file_name=_log_name,
    )
    # Mirror into the structured history timeline. Orchestrator log lines
    # carry their text in details.line; classify those, store others as-is.
    _run_dir = _log_name.rsplit("/", 1)[0] if "/" in _log_name else ""
    _details = payload.get("details") or {}
    _line = _details.get("line") if isinstance(_details, dict) else None
    if payload.get("event_type") == "orchestrator_log" and _line:
        _ev = app.history_store.record_line(
            ws_path,
            _line,
            run_dir=_run_dir,
            pane_id=payload.get("pane_id") or None,
            vendor=payload.get("agent") or None,
        )
    else:
        _ev = app.history_store.record(
            ws_path,
            run_dir=_run_dir,
            type=payload.get("event_type", "note"),
            summary=str(_line or payload.get("event_type", "note")),
            pane_id=payload.get("pane_id") or None,
            vendor=payload.get("agent") or None,
            detail=_details if isinstance(_details, dict) and _details else None,
        )
    asyncio.create_task(
        app.broadcast(make_event("history.appended", {"workspace_path": ws_path, "event": _ev}))
    )
    await session.send_json(
        make_response(msg_id, msg_type, {"ok": True})
    )


# ── Pipeline execution (pipeline.*) ──────────────────────────────────────────
def _mirror_pipeline_state(project: "Project") -> None:
    """Copy a pipeline's state onto its recent-workspaces entry.

    The store keeps last_known_state/task purely so Welcome can badge a folder
    with how its last run ended; nothing else writes them, so without this every
    entry falls through to the 'spawn-only' default. Called from the handlers
    that move Project.state (start / resume / complete / abort) — the backend is
    the authority, and mirroring here also survives the window being closed
    right after a run.
    """
    from . import app

    try:
        app.recent_workspaces_store.touch(
            project.workspace_path,
            state=project.state,
            task=project.task_description,
            keep=_live_pane_workspaces_for_recent(),
        )
        recent = app.recent_workspaces_store.list()
    except Exception:  # noqa: BLE001 — a badge must not fail a pipeline
        # Callers are the start/complete/abort handlers, which had no dependency
        # on the recent store before this. A store failure here would answer
        # their request with an error for a run that actually succeeded, so it
        # stays local: the badge falls back to whatever it showed before.
        app.log.exception("recent-workspaces: failed to mirror pipeline state")
        return
    asyncio.create_task(
        app.broadcast(
            make_event("workspace.recent_changed", {"recent": recent, "reason": "pipeline"})
        )
    )


@handler("pipeline.suspend")
async def pipeline_suspend(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """The run reached a subpipeline node: suspend it (run_stack) so the
    window can start the child run in this workspace."""
    from . import app
    from .guard.taint import pipeline_run_taint

    ws = payload["workspace_path"]
    try:
        project, frame = app.project_store.suspend_for_child(
            ws,
            node_id=str(payload.get("node_id") or ""),
            next_index=int(payload.get("next_index", 0) or 0),
            pipeline_name=str(payload.get("pipeline_name") or ""),
            child_pipeline_id=str(payload.get("child_pipeline_id") or ""),
            taint=pipeline_run_taint(ws),
        )
    except ValueError as err:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", str(err)))
        return
    app.tokens_store.suspend_run(ws)
    _mirror_pipeline_state(project)
    resp = app._project_payload(project)
    resp["frame_id"] = frame["id"]
    await session.send_json(make_response(msg_id, msg_type, resp))


@handler("pipeline.child_finished")
async def pipeline_child_finished(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """The child run ended: restore its parent (run_stack pop) with the
    subpipeline node done or failed. {popped: false} when no parent waits."""
    from . import app
    from .guard.taint import pipeline_run_taint, restore_pipeline_run_taint

    ws = payload["workspace_path"]
    child = app.project_store.peek(ws)
    child_run_id = _token_run_id(child.log_file_name, child.id) if child is not None else ""
    outcome = "completed" if payload.get("outcome") == "completed" else "failed"
    popped = app.project_store.finish_child(
        ws, outcome=outcome, summary=str(payload.get("summary") or ""),
        output=payload.get("output"), error=str(payload.get("error") or ""),
    )
    if popped is None:
        await session.send_json(make_response(msg_id, msg_type, {"popped": False}))
        return
    project, frame = popped
    app.tokens_store.resume_suspended_run(ws, child_run_id=child_run_id)
    # Merged, never cleared: the child's output flows into the parent, so a
    # taint the child run carries stays on the parent too.
    restore_pipeline_run_taint(ws, str(frame.get("taint") or "") or pipeline_run_taint(ws))
    _mirror_pipeline_state(project)
    resp = app._project_payload(project)
    resp.update({"popped": True, "node_id": frame["node_id"], "next_index": frame["next_index"]})
    await session.send_json(make_response(msg_id, msg_type, resp))


@handler("pipeline.stack")
async def pipeline_stack(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """The parent runs suspended in a workspace, outermost first, without
    their saved run fields."""
    from . import app

    project = app.project_store.peek(payload.get("workspace_path") or "")
    frames = [run_frame_view(f) for f in (project.run_stack if project is not None else [])]
    await session.send_json(make_response(msg_id, msg_type, {"frames": frames, "state": project.state if project else ""}))


def run_frame_view(frame: dict) -> dict:
    """A run_stack frame as status surfaces show it."""
    run = frame.get("run") or {}
    return {
        "id": frame.get("id", ""), "node_id": frame.get("node_id", ""),
        "pipeline_id": run.get("pipeline_id", ""), "pipeline_name": frame.get("pipeline_name", ""),
        "child_pipeline_id": frame.get("child_pipeline_id", ""), "next_index": frame.get("next_index", 0),
        "task_description": run.get("task_description", ""), "suspended_at": frame.get("suspended_at", ""),
    }


@handler("pipeline.claim")
async def pipeline_claim(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """A window's claim of the pipeline runs it drives, sent on every
    (re)connect — an empty list when it drives none. See pipeline_liveness."""
    workspaces = payload.get("workspaces")
    if not isinstance(workspaces, list):
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", "workspaces must be a list"))
        return
    pipeline_liveness.record_claim(session, [w for w in workspaces if isinstance(w, str)])
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("pipeline.resume")
async def pipeline_resume(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    project, resume_index = app.project_store.resume_pipeline(payload["workspace_path"])
    pipeline_liveness.claim_run(session, project.workspace_path)
    _mirror_pipeline_state(project)
    resp = app._project_payload(project)
    resp["resume_index"] = resume_index
    await session.send_json(make_response(msg_id, msg_type, resp))


def _token_run_id(log_file_name: str, project_id: str) -> str:
    """The tokens_store run id pipeline.start gives a run: its run directory."""
    log_name = log_file_name or ""
    return (log_name.rsplit("/", 1)[0] if "/" in log_name else "") or project_id


@handler("pipeline.start")
async def pipeline_start(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app
    from .projects import ParentRunSuspended

    child_of = str(payload.get("child_of") or "")
    frame = None
    if child_of:
        before = app.project_store.peek(payload["workspace_path"])
        stack = getattr(before, "run_stack", None) or []
        frame = stack[-1] if stack else None
    try:
        project = app.project_store.start_pipeline(
            payload["workspace_path"],
            task_description=payload.get("task_description", ""),
            total_stages=int(payload.get("total_stages", 4)),
            stage_blueprint=payload.get("stage_blueprint", []),
            backend_version=app.__version__,
            pipeline_id=payload.get("pipeline_id", "") or app.stages_store.get_active_pipeline_id(),
            start_index=int(payload.get("start_index", 0) or 0),
            child_of=child_of,
        )
    except ParentRunSuspended as err:
        await session.send_json(make_error(msg_id, msg_type, "PIPELINE_SUSPENDED", str(err)))
        return
    except ValueError as err:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", str(err)))
        return
    from .guard.taint import arm_pipeline_run, pipeline_run_started

    if child_of and frame is not None and frame.get("taint"):
        # A child run carries its parent's taint, task text included.
        arm_pipeline_run(payload["workspace_path"], str(frame["taint"]))
    pipeline_run_started(payload["workspace_path"])
    pipeline_liveness.claim_run(session, project.workspace_path)
    app._register_workspace_and_backfill(project.workspace_path)
    _mirror_pipeline_state(project)
    # Start a fresh token-stats run for this workspace.
    log_name = project.log_file_name or ""
    run_dir = log_name.rsplit("/", 1)[0] if "/" in log_name else ""
    app.tokens_store.start_run(
        project.workspace_path,
        run_id=run_dir or project.id,
        task=project.task_description,
        run_dir=run_dir,
        pipeline_id=getattr(project, "pipeline_id", ""),
        parent_run_id=_token_run_id(frame["run"].get("log_file_name", ""), project.id) if child_of and frame else "",
    )
    asyncio.create_task(
        app.broadcast(make_event("tokens.changed", app.tokens_store.snapshot(project.workspace_path)))
    )
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


@handler("pipeline.stage_spawn")
async def pipeline_stage_spawn(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    project = app.project_store.record_stage_spawn(
        payload["workspace_path"],
        stage_index=int(payload["stage_index"]),
        pane_id=payload["pane_id"],
        agent=payload.get("agent", ""),
        role=payload.get("role", ""),
    )
    from .guard.taint import pipeline_pane_spawned

    pipeline_pane_spawned(payload["workspace_path"], str(payload["pane_id"]))
    pipeline_liveness.claim_run(session, project.workspace_path)
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


@handler("pipeline.slot_spawn")
async def pipeline_slot_spawn(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    slot_pin = _profile_pin_for_bookkeeping(
        payload.get("agent", ""), payload.get("pane_id"), payload.get("profile_id"))
    project = app.project_store.record_slot_spawn(
        payload["workspace_path"],
        stage_index=int(payload["stage_index"]),
        slot_label=payload["slot_label"],
        pane_id=payload["pane_id"],
        agent=payload.get("agent", ""),
        role=payload.get("role", ""),
        # Claude passes its pinned --session-id here; Codex/Antigravity pass
        # "" and persist later via pipeline.slot_session once detected.
        session_id=payload.get("session_id", ""),
        session_home_id=payload.get("session_home_id", ""),
        profile_id=slot_pin,
        run_group_id=payload.get("run_group_id", ""),
        launch_id=launch_id.current(),
    )
    app.pane_account_history.pin(str(payload["pane_id"]), _account_pin_for_history(slot_pin))
    from .guard.taint import pipeline_pane_spawned

    pipeline_pane_spawned(payload["workspace_path"], str(payload["pane_id"]))
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


@handler("pipeline.slot_session")
async def pipeline_slot_session(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    project = app.project_store.record_slot_session(
        payload["workspace_path"],
        stage_index=int(payload["stage_index"]),
        slot_label=payload["slot_label"],
        session_id=payload.get("session_id", ""),
    )
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


async def _sweep_pane_ptys(session: "Session", pane_id: str, *, force: bool = True) -> None:
    """Take down any PTY still running under a pane whose record is going away.

    The renderer kills through its own terminal ref first and this then finds
    nothing; it is the panes without one — a restore placeholder, or a pane
    whose kill was refused — that would otherwise have their record removed
    while the process kept running with nothing left pointing at it.

    force=False for a caller that keeps the record: the CLI it reaches is one
    the renderer never managed to kill, so it is running normally, and the
    record left behind promises a resume that reads the transcript it has not
    finished writing. kill() escalates to SIGKILL after its own grace either
    way, so the process still goes down.

    Note for a future caller: this also closes the pane's dev-time interval and
    drops its attribution registration, because every caller so far means "the
    process behind this pane is ending" even when the record survives (a closed
    workspace's panes come back as placeholders, which re-register on realize).
    A caller that keeps the pane RUNNING on screen must not come through here.
    """
    from . import app

    if not pane_id:
        # A slot with no pane record resolves to a blank id; sweeping on that
        # would match whatever the lookup returns for "no pane".
        return
    # A reattached PTY keeps the pane id it was created with; a restore since
    # then renamed the pane, and only the alias table knows the old id.
    term_session_ids: list[str] = []
    for known_id in (pane_id, *agent_messaging.former_ids(pane_id)):
        for term_session_id in session.terminals.live_session_ids_for_pane(known_id):
            if term_session_id not in term_session_ids:
                term_session_ids.append(term_session_id)
    for term_session_id in term_session_ids:
        await session.terminals.kill(term_session_id, force=force)
        app._PTY_OWNERS.pop(term_session_id, None)
        app.attribution.unregister_pane(pane_id)
    for workspace_path in app.dev_time_store.pane_removed(pane_id):
        await app.broadcast(make_event("devtime.changed", {"workspace_path": workspace_path}))


@handler("pipeline.slot_unspawn")
async def pipeline_slot_unspawn(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    stage_index = int(payload["stage_index"])
    slot_label = payload["slot_label"]
    project = app.project_store.record_slot_unspawn(
        payload["workspace_path"],
        stage_index=stage_index,
        slot_label=slot_label,
    )
    # A pipeline slot is closed through the same paths as a manual pane, so it
    # needs the same sweep: the record is now 'removed' and nothing will point
    # at the process again.
    pane_id = next(
        (p.pane_id for p in project.panes
         if p.origin == "pipeline"
         and p.stage_index == stage_index
         and p.slot_label == slot_label),
        "",
    )
    await _sweep_pane_ptys(session, pane_id)
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


@handler("pipeline.slot_kickoff")
async def pipeline_slot_kickoff(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    project = app.project_store.update_slot_kickoff(
        payload["workspace_path"],
        stage_index=int(payload["stage_index"]),
        slot_label=payload["slot_label"],
        kickoff_status=payload.get("kickoff_status", "sent"),
    )
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


@handler("pipeline.complete")
async def pipeline_complete(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    project = app.project_store.complete_pipeline(payload["workspace_path"])
    _mirror_pipeline_state(project)
    app.tokens_store.end_run(project.workspace_path, outcome="completed", node_states=project.node_states)
    asyncio.create_task(
        app.broadcast(make_event("tokens.changed", app.tokens_store.snapshot(project.workspace_path)))
    )
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


@handler("pipeline.abort")
async def pipeline_abort(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    reason = payload.get("reason", "user")
    project = app.project_store.abort_pipeline(payload["workspace_path"], reason=reason)
    _mirror_pipeline_state(project)
    app.tokens_store.end_run(
        project.workspace_path,
        # The engine aborts with reason "failed" when a run cannot go on (a
        # reject loop out of budget); everything else is a stop.
        outcome="failed" if reason == "failed" else "aborted",
        node_states=project.node_states,
    )
    asyncio.create_task(
        app.broadcast(make_event("tokens.changed", app.tokens_store.snapshot(project.workspace_path)))
    )
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


@handler("pipeline.reset")
async def pipeline_reset(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """The backend leg of pipeline_reset: the renderer kills the panes, this
    returns the stored run to idle so it stops answering pipeline_status and
    survives no restart (#417). Run history (log, run directory) is kept."""
    from . import app

    project = app.project_store.reset_pipeline(payload["workspace_path"])
    if project is not None:
        log.info("pipeline reset: %s is idle again", project.workspace_path)
        _mirror_pipeline_state(project)
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project) if project is not None else {"project": None})
    )


@handler("pipeline.start_refused")
async def pipeline_start_refused(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """The renderer refused a start before it reached pipeline.start. Recorded
    in the backend log and the workspace's pipeline.log (outside any run, so
    not the last run's file), since a refusal used to leave no trace (#417)."""
    from . import app

    ws_path = payload["workspace_path"]
    reason = str(payload.get("reason", ""))
    pipeline_id = str(payload.get("pipeline_id", ""))
    log.warning("pipeline start refused in %s (pipeline %s): %s", ws_path, pipeline_id or "?", reason)
    app.project_store.append_event(
        ws_path,
        {"event": "pipeline_start_refused", "pipeline_id": pipeline_id, "reason": reason},
    )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("pipeline.node_states")
async def pipeline_node_states(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """The renderer engine reports per-graph-node run state; stored on the
    project so MCP pipeline_status can read it, then broadcast for canvases in
    every window. Contract: src/renderer/src/lib/pipelineGraph.ts."""
    from . import app

    nodes = payload.get("nodes", {})
    gate = payload.get("gate")
    outputs = payload.get("outputs")
    if not isinstance(nodes, dict) or (gate is not None and not isinstance(gate, dict)) or (
        outputs is not None and not isinstance(outputs, dict)
    ):
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", "nodes/gate/outputs must be objects"))
        return
    project = app.project_store.record_node_states(
        payload["workspace_path"], nodes=nodes, gate=gate, outputs=outputs
    )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))
    await app.broadcast(make_event("pipeline.node_states_changed", {
        "workspace_path": project.workspace_path,
        "pipeline_id": project.pipeline_id,
        "state": project.state,
        "nodes": project.node_states,
        "gate": project.node_gate,
    }))


@handler("pipeline.fetch_docs")
async def pipeline_fetch_docs(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # Fetch framework docs from Context7 via MCP for dynamic kickoff injection.
    # Best-effort: returns { doc_prefix: "" } on any error.
    task = payload.get("task", "")
    doc_query = payload.get("doc_query", "")
    workspace_path = payload.get("workspace_path", "")
    analyzer_model = payload.get("analyzer_model", "") or app.ANALYZER_DEFAULT_MODEL
    try:
        doc_prefix = await app.fetch_stage_docs(
            task=task,
            doc_query=doc_query,
            mcp_manager=app.mcp_manager,
            workspace_path=workspace_path,
            analyzer_model=analyzer_model,
        )
    except Exception as fetch_err:  # noqa: BLE001
        app.log.warning("pipeline.fetch_docs error: %s", fetch_err)
        doc_prefix = ""
    await session.send_json(
        make_response(msg_id, msg_type, {"doc_prefix": doc_prefix})
    )


@handler("pipeline.auto_answer")
async def pipeline_auto_answer(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    result = await app.analyzer_auto_answer(
        questions=payload.get("questions", []),
        task=payload.get("task", ""),
        stage_title=payload.get("stage_title", ""),
        model=payload.get("model") or app.ANALYZER_DEFAULT_MODEL,
    )
    app._record_analyzer_tokens(result, payload)
    await session.send_json(make_response(msg_id, msg_type, result))


# ── Manual panes (manual_pane.*) + pane grouping (pane.*) ────────────────────
@handler("manual_pane.spawn")
async def manual_pane_spawn(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app
    from .model_args import refuse_unsafe_shape

    # Checked before the store sees it, not only where argv is built. A stored
    # model is replayed on every restore, far from any assembly site, so this
    # has to hold as an invariant of what is persisted rather than a habit of
    # everything that later reads it.
    unsafe = refuse_unsafe_shape(
        str(payload.get("model") or ""), str(payload.get("effort") or "")
    )
    if unsafe:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", unsafe))
        return

    manual_pin = _profile_pin_for_bookkeeping(
        payload.get("agent", ""), payload.get("pane_id"), payload.get("profile_id"))
    # A rebuild re-keys the old record onto the new id; read the session the old
    # record held before that overwrites it, so a scheduled job can follow the
    # hop only when the rebuild resumed that very session.
    previous_pane_id = str(payload.get("previous_pane_id") or "")
    previous_session_id = ""
    if previous_pane_id:
        before = app.project_store.load_or_create(payload["workspace_path"])
        previous = next((p for p in before.panes
                         if p.origin != "pipeline" and p.pane_id == previous_pane_id), None)
        previous_session_id = previous.session_id if previous is not None else ""
    # Closed panes that held exactly the session this spawn resumes: the jobs
    # one of them owned pass to this pane. Only a closed record counts, so an
    # owner merely not registered yet (after a restart) keeps its jobs.
    session_id = str(payload.get("session_id") or "")
    closed_lineage: set[str] = set()
    if session_id:
        known = app.project_store.load_or_create(payload["workspace_path"])
        closed_lineage = {p.pane_id for p in known.panes
                          if p.origin != "pipeline" and p.spawn_status == "removed"
                          and p.session_id == session_id}
    project = app.project_store.record_manual_pane_spawn(
        payload["workspace_path"],
        pane_id=payload["pane_id"],
        previous_pane_id=payload.get("previous_pane_id", ""),
        agent=payload.get("agent", ""),
        role=payload.get("role", ""),
        command=payload.get("command", ""),
        model=payload.get("model", ""),
        effort=payload.get("effort", ""),
        session_id=payload.get("session_id", ""),
        session_home_id=payload.get("session_home_id", ""),
        profile_id=manual_pin,
        run_group_id=payload.get("run_group_id", ""),
        output_log_file=payload.get("output_log_file", ""),
        origin=payload.get("origin", ""),
        spawned_by=payload.get("spawned_by", ""),
        launch_id=launch_id.current(),
    )
    app.pane_account_history.pin(str(payload["pane_id"]), _account_pin_for_history(manual_pin))
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )
    if previous_session_id:
        from . import scheduler

        try:
            await scheduler.get_service().rebind_after_rebuild(
                previous_pane_id, str(payload["pane_id"]),
                previous_session_id, str(payload.get("session_id") or ""),
            )
        except Exception:  # noqa: BLE001 — the spawn is recorded either way
            log.exception("manual_pane.spawn: scheduler rebind failed")
    if closed_lineage:
        from . import scheduler

        try:
            await scheduler.get_service().inherit_owner(
                closed_lineage, str(payload["pane_id"]), session_id)
        except Exception:  # noqa: BLE001 — the spawn is recorded either way
            log.exception("manual_pane.spawn: scheduler owner inheritance failed")


@handler("manual_pane.unspawn")
async def manual_pane_unspawn(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # Unspawn is the renderer saying this pane is gone for good, so a PTY still
    # running under it goes with it. Record first, then sweep what the store
    # actually removed: the session fallback can retire a record filed under a
    # drifted id, and that pane's PTY has to go down too. The requested id is
    # always swept, matching record or not.
    pane_id = payload["pane_id"]
    project, removed_pane_ids = app.project_store.record_manual_pane_unspawn(
        payload["workspace_path"],
        pane_id=pane_id,
        session_id=payload.get("session_id", "") or "",
    )
    for swept_id in dict.fromkeys([pane_id, *removed_pane_ids]):
        await _sweep_pane_ptys(session, swept_id)
    # A Codex pane's home is named after its pane id, or after the id a
    # restored pane kept using (session_home_id). Its PTY is down by now.
    for home_id in dict.fromkeys([
        pane_id,
        *removed_pane_ids,
        *(p.session_home_id for p in project.panes
          if p.pane_id in removed_pane_ids and p.session_home_id),
    ]):
        await _reclaim_codex_home(str(home_id))
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


@handler("pipeline.slot_unspawn_by_pane")
async def pipeline_slot_unspawn_by_pane(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Retire a pipeline pane's record by pane id, and take its PTY with it.

    pipeline.slot_unspawn addresses a slot by (stage_index, slot_label), which
    the renderer can only resolve against the pipeline its window is showing —
    the wrong one when the workspace being closed ran a different pipeline, and
    a wrong-but-valid index retires some other slot's record. The pane id is
    shared verbatim between the live pane and the record, so it cannot drift.
    """
    from . import app

    pane_id = payload["pane_id"]
    # Sweep BEFORE the store: load_or_create raises when the workspace folder
    # is gone (renamed, deleted, unmounted while Navide held it open), and the
    # PTY of a pane that never realized has nothing else pointing at it — the
    # renderer could not kill what it has no terminal ref for. Losing the
    # record update to that is recoverable; losing the process is not.
    await _sweep_pane_ptys(session, pane_id)
    project, retired = app.project_store.record_pane_unspawn_by_id(
        payload["workspace_path"], pane_id=pane_id
    )
    if not retired:
        # Not an error — the record may already be removed. Worth a line all the
        # same: the caller closed a workspace after telling the user these panes
        # would not come back, and a miss here is how they come back anyway.
        log.info(
            "slot_unspawn_by_pane matched no live record: pane=%s workspace=%s",
            pane_id,
            payload["workspace_path"],
        )
    await session.send_json(
        make_response(msg_id, msg_type, {**app._project_payload(project), "retired": retired})
    )


@handler("manual_pane.release_pty")
async def manual_pane_release_pty(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """End a pane's PTY while its record stays 'spawned'.

    Closing a workspace ends the CLIs running in it but keeps the records, so
    reopening it brings the panes back as resumable placeholders. The renderer
    kills through its own terminal ref — and a pane that never realized has
    none, which is why unspawn carried the sweep that reached it. A close that
    keeps the record sends no unspawn, so it says this instead; without it the
    placeholder's process would keep running with nothing pointing at it.
    """
    await _sweep_pane_ptys(session, payload["pane_id"], force=False)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


# ── Settings → Resource limits: servers panes left behind ──────────────────
# Host window only: the list shows other processes' commands and folders, and
# stop signals one. Both run only when the user asks (detached_servers).


@handler("limits.detached.list")
async def limits_detached_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import detached_servers, resource_limits

    if not session.host_authenticated:
        await session.send_json(make_error(msg_id, msg_type, "UNAUTHORIZED", "Host session is not authenticated"))
        return
    enabled = resource_limits.track_detached(resource_limits.current())
    items: list[dict[str, Any]] = []
    if enabled:
        try:
            items = await asyncio.to_thread(detached_servers.find, session.terminals.live_pane_marks())
        except Exception as err:  # noqa: BLE001 — a failed scan lists nothing
            log.warning("leftover-server scan failed: %s", err)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "enabled": enabled, "items": items}))


@handler("limits.detached.stop")
async def limits_detached_stop(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import detached_servers

    if not session.host_authenticated:
        await session.send_json(make_error(msg_id, msg_type, "UNAUTHORIZED", "Host session is not authenticated"))
        return
    result = await asyncio.to_thread(
        detached_servers.stop,
        int(payload["pid"]),
        float(payload["started_at"]),
        live=session.terminals.live_pane_marks(),
    )
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("manual_pane.session")
async def manual_pane_session(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    project = app.project_store.record_manual_pane_session(
        payload["workspace_path"],
        pane_id=payload["pane_id"],
        session_id=payload.get("session_id", ""),
    )
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


@handler("pane.set_run_group")
async def pane_set_run_group(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    project = app.project_store.set_pane_run_group(
        payload["workspace_path"],
        pane_id=payload["pane_id"],
        run_group_id=payload.get("run_group_id", ""),
    )
    if project is None:
        # Say so rather than answering ok: the caller acts on this reply by
        # dropping the pane's group id locally, which must not happen when
        # nothing was written.
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "PANE_NOT_FOUND",
                f"no pane record for {payload['pane_id']!r} in this workspace",
            )
        )
        return
    # Re-point the live token attribution too, so usage from here on lands in
    # the new group's bucket. A pane the attribution layer never registered
    # (e.g. a placeholder) has nothing to move — that is not an error.
    app.attribution.set_pane_group(
        payload["pane_id"], str(payload.get("run_group_id") or "")
    )
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


@handler("pane.set_parent")
async def pane_set_parent(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Re-parent a pane in the project record — the lineage half of moving a
    pane, next to pane.set_run_group. "" as spawned_by makes it a root."""
    from . import app

    outcome = app.project_store.set_pane_parent(
        payload["workspace_path"],
        pane_id=payload["pane_id"],
        spawned_by=str(payload.get("spawned_by") or ""),
    )
    if isinstance(outcome, str):
        # Say so rather than answering ok: the caller re-points the pane
        # locally on this reply, which must not happen when nothing was
        # written — and a cycle refused here would otherwise be shown as a
        # tree that the record does not hold.
        code, message = {
            "not_found": ("PANE_NOT_FOUND", f"no pane record for {payload['pane_id']!r} in this workspace"),
            "parent_not_found": ("PARENT_NOT_FOUND", f"no pane record for parent {payload.get('spawned_by')!r} in this workspace"),
            "cycle": ("LINEAGE_CYCLE", "that parent is the pane itself or one of its descendants"),
        }[outcome]
        await session.send_json(make_error(msg_id, msg_type, code, message))
        return
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(outcome))
    )


# ── Reconnect lost conversations (workspace/pane.*) ──────────────────────────
def _collect_orphan_sessions(workspace_path: str) -> list[dict]:
    """Enumerate this workspace's Claude transcripts that no live pane holds.

    A transcript is orphaned when its session id is not the current session_id
    of any SPAWNED pane in the workspace's project — those are the ones a
    reconnect can safely adopt. Pending records are stubs whose spawn never
    landed (see record_manual_pane_session): counting them as live would hide
    their transcript from reconnect forever. Each orphan carries a short
    human-prompt preview, size/mtime, its resumable flag, and (best-effort) the
    spawn-history customName last associated with the id. Sorted newest mtime
    first. Blocking file IO — call via asyncio.to_thread.
    """
    from . import app

    files = ClaudeLogReader().session_files_for_workspace(workspace_path)
    project = app.project_store.peek(workspace_path)
    live_ids: set[str] = set()
    history_names: dict[str, str] = {}
    if project is not None:
        for pane in project.panes:
            if pane.spawn_status == "spawned" and pane.session_id:
                live_ids.add(pane.session_id)
        # Oldest→newest order: overwriting keeps the name last associated.
        for entry in project.ui_spawn_history or []:
            if not isinstance(entry, dict):
                continue
            sid = entry.get("sessionId")
            name = entry.get("customName")
            if isinstance(sid, str) and sid and isinstance(name, str) and name:
                history_names[sid] = name

    orphans: list[dict] = []
    for f in files:
        sid = f.stem
        if sid in live_ids:
            continue
        try:
            st = f.stat()
        except OSError:
            continue
        orphans.append({
            "session_id": sid,
            "preview": first_user_prompts(f, limit=2),
            "size_bytes": st.st_size,
            "mtime": st.st_mtime,
            "resumable": app._session_exists("claude", workspace_path, sid),
            "custom_name": history_names.get(sid, ""),
        })
    orphans.sort(key=lambda o: o["mtime"], reverse=True)
    return orphans


@handler("workspace.list_orphan_sessions")
async def workspace_list_orphan_sessions(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    workspace_path = str(payload.get("workspace_path", ""))
    orphans = await asyncio.to_thread(_collect_orphan_sessions, workspace_path)
    await session.send_json(make_response(msg_id, msg_type, {"orphans": orphans}))


@handler("pane.reconnect_session")
async def pane_reconnect_session(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    workspace_path = str(payload.get("workspace_path", ""))
    pane_id = str(payload.get("pane_id", ""))
    session_id = str(payload.get("session_id", ""))
    if not app._session_exists("claude", workspace_path, session_id):
        await session.send_json(make_error(
            msg_id, msg_type, "NO_TRANSCRIPT",
            f"no Claude transcript for session {session_id!r} in this workspace",
        ))
        return
    try:
        project = app.project_store.reconnect_pane_session(
            workspace_path, pane_id=pane_id, session_id=session_id,
        )
    except KeyError as err:
        await session.send_json(make_error(msg_id, msg_type, "PANE_NOT_FOUND", str(err)))
        return
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


# ── CLI usage/quota badges (usage.*) ────────────────────────────────────────
@handler("usage.get")
async def usage_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from .usage_service import service

    await session.send_json(make_response(msg_id, msg_type, service.payload()))


@handler("usage.refresh")
async def usage_refresh(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from .usage_service import service

    # Scoped by the account card that asked; absent, the header button's
    # "every CLI" refresh.
    agent_key = payload.get("agentKey")
    slot_id = payload.get("slotId")
    service.request_refresh(
        provider=str(agent_key) if agent_key else None,
        slot_id=str(slot_id) if slot_id else None,
    )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("usage.configure")
async def usage_configure(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from .usage_service import service

    service.configure(
        enabled=bool(payload.get("enabled", True)),
        interval_sec=payload.get("intervalSec"),
    )
    await session.send_json(make_response(msg_id, msg_type, service.payload()))


# ── Storage usage & cleanup (storage.*) ─────────────────────────────────────
def _storage_request_args(payload: dict) -> tuple[list[str], int]:
    raw_paths = payload.get("workspacePaths")
    paths = (
        [p for p in raw_paths if isinstance(p, str) and p]
        if isinstance(raw_paths, list)
        else []
    )
    return paths, storage_service.coerce_stale_days(payload.get("staleDays"))


@handler("storage.usage")
async def storage_usage(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Disk-usage report for the Storage settings page.

    Walks several large trees (app data, CLI profile homes, codex pane homes,
    every open workspace), so it always runs on a worker thread.
    """
    workspace_paths, stale_days = _storage_request_args(payload)
    try:
        report = await asyncio.to_thread(
            storage_service.collect_usage, workspace_paths, stale_days
        )
    except OSError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "SCAN_FAILED", f"storage scan failed: {err}")
        )
        return
    await session.send_json(make_response(msg_id, msg_type, report))


@handler("storage.cleanup")
async def storage_cleanup(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Delete the storage buckets named by ``itemIds``.

    Unknown, info-only and Electron-owned ids come back as ``ok: false`` rows
    instead of failing the whole request.
    """
    raw_ids = payload.get("itemIds")
    item_ids = (
        [i for i in raw_ids if isinstance(i, str) and i]
        if isinstance(raw_ids, list)
        else []
    )
    workspace_paths, stale_days = _storage_request_args(payload)
    try:
        result = await asyncio.to_thread(
            storage_service.cleanup, item_ids, workspace_paths, stale_days
        )
    except OSError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "CLEANUP_FAILED", f"cleanup failed: {err}")
        )
        return
    await session.send_json(make_response(msg_id, msg_type, result))


# ── Background executions (executions.*) ────────────────────────────────────
_EXECUTION_KINDS = ("crontab", "launchagent")


def _executions_target(payload: dict) -> tuple[str, str] | None:
    """Validate ``kind``/``target``; None when the request is malformed."""
    kind = payload.get("kind")
    target = payload.get("target")
    if kind not in _EXECUTION_KINDS or not isinstance(target, str) or not target.strip():
        return None
    return kind, target


async def _broadcast_executions_changed(session: "Session") -> None:
    """Tell the *other* windows to rescan.

    The acting window refreshes off its own response, so including it here
    would make every mutation cost two full scans.
    """
    from . import app

    await app.broadcast(make_event("executions.changed", {}), exclude=session)


@handler("executions.list")
async def executions_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Scan the machine's crontab entries and macOS LaunchAgents."""
    await session.send_json(
        make_response(msg_id, msg_type, await executions_service.list_executions())
    )


@handler("executions.set_enabled")
async def executions_set_enabled(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Enable or disable one crontab entry or LaunchAgent.

    Operational failures come back as ``ok: false`` with the real stderr so the
    UI can show it in place; only malformed requests are protocol errors.
    """
    parsed = _executions_target(payload)
    enabled = payload.get("enabled")
    if parsed is None or not isinstance(enabled, bool):
        await session.send_json(
            make_error(
                msg_id, msg_type, "BAD_REQUEST",
                "executions.set_enabled needs kind ('crontab'|'launchagent'), target and enabled",
            )
        )
        return
    kind, target = parsed
    try:
        if kind == "crontab":
            await executions_service.set_crontab_enabled(target, enabled)
        else:
            await executions_service.set_launch_agent_enabled(target, enabled)
    except executions_service.ExecutionsError as err:
        await session.send_json(
            make_response(msg_id, msg_type, {"ok": False, "error": str(err)})
        )
        return
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))
    await _broadcast_executions_changed(session)


@handler("executions.remove")
async def executions_remove(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Delete one crontab entry, or unload and delete one LaunchAgent plist."""
    parsed = _executions_target(payload)
    if parsed is None:
        await session.send_json(
            make_error(
                msg_id, msg_type, "BAD_REQUEST",
                "executions.remove needs kind ('crontab'|'launchagent') and target",
            )
        )
        return
    kind, target = parsed
    try:
        if kind == "crontab":
            await executions_service.remove_crontab_entry(target)
        else:
            await executions_service.remove_launch_agent(target)
    except executions_service.ExecutionsError as err:
        await session.send_json(
            make_response(msg_id, msg_type, {"ok": False, "error": str(err)})
        )
        return
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))
    await _broadcast_executions_changed(session)


# ── Cross-workspace inter-CLI messaging (agent_msg.*) ───────────────────────
# Each renderer window mirrors its own pane handles here so the backend — the
# only process that sees every workspace — can resolve `to: <folder>/<pane>`
# targets. Delivery stays in the frontend: a resolved cross-workspace message is
# broadcast back out as an `agent_msg.deliver` event, and the window that owns
# the target pane runs it through the existing injection queue.


@handler("agent_msg.register")
async def agent_msg_register(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    pane_id = str(payload.get("pane_id") or "")
    name = str(payload.get("name") or "")
    workspace_path = str(payload.get("workspace_path") or "")
    if not pane_id or not name or not workspace_path:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "BAD_REQUEST",
                "agent_msg.register needs pane_id, name and workspace_path",
            )
        )
        return
    entry = agent_messaging.register(
        pane_id,
        name,
        workspace_path,
        agent_key=str(payload.get("agent_key") or ""),
        owner=session,
        # Absent means realized: every caller that has a live pane omits it, and
        # a window from before this field existed only ever mirrored live panes.
        realized=bool(payload.get("realized", True)),
        # Pane id of whoever opened this pane. The window is the only process
        # that knows it (lineage is renderer state), and cli_whoami is the only
        # reader — a child asking who it owes its report to.
        spawned_by=str(payload.get("spawned_by") or ""),
        # Only an embedded AI panel (AiCliDock) sends these; a window pane
        # leaves them out and is registered exactly as before.
        surface=str(payload.get("surface") or ""),
        window_kind=str(payload.get("window_kind") or ""),
        deliverable=bool(payload.get("deliverable", False)),
    )
    # The ids this same CLI process was known by before the window rebuilt its
    # pane around it (reload, detach, group reattach). They stay resolvable, so
    # a CLI still quoting the id baked into its /plan-mcp URL at spawn time is
    # answered as the pane it is actually attached to.
    former_pane_ids = [str(x) for x in (payload.get("former_pane_ids") or [])]
    aliased = agent_messaging.add_aliases(pane_id, former_pane_ids, workspace_path)
    # A register is also how a rename and a post-reconnect re-mirror arrive, so
    # this is the single point where the remote roster learns about all three.
    server_link.roster_changed()
    # ...and the single point where a window that reloaded, or reattached to a
    # PTY it did not spawn, learns the pane still has a push channel. Without
    # this it would keep typing into a pane it could have pushed to, for as long
    # as it lives.
    from . import push_delivery

    # A pane whose window reloaded keeps the channel its CLI was launched with,
    # and that channel is filed under the pane id the launch used. Move it onto
    # the id the pane answers to now, or the pane would be typed into for the
    # rest of its life despite having a working push channel. Only an id nobody
    # live is holding gives it up — see push_delivery.adopt.
    push_delivery.adopt(pane_id, aliased)
    state = push_delivery.get(pane_id)
    if state is not None and push_delivery.is_ready(pane_id):
        await session.send_json(
            make_event(
                "agent_msg.push_state",
                {"pane_id": pane_id, "kind": state.kind, "ready": True},
            )
        )
    await session.send_json(make_response(msg_id, msg_type, entry.to_dict()))


@handler("agent_msg.unregister")
async def agent_msg_unregister(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    pane_id = str(payload.get("pane_id") or "")
    removed = bool(pane_id) and agent_messaging.unregister(pane_id, owner=session)
    if removed:
        # The pane is gone for good (a detach keeps the entry, see unregister),
        # so drop its cached activity instead of leaking one entry per pane.
        from . import app
        app.forget_pane_activity(pane_id)
        server_link.roster_changed()
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "removed": removed}))


@handler("agent_msg.register_dock")
async def agent_msg_register_dock(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """agent_msg.register for an embedded AI panel (AiCliDock), and the only
    roster write a plugin window's broker can reach. It is the same register,
    fenced so it can only ever create or refresh a panel: the surface must name
    one, and a pane id a window pane already holds is refused rather than
    renamed and turned into a panel under that window's feet."""
    pane_id = str(payload.get("pane_id") or "")
    surface = str(payload.get("surface") or "")
    if not surface or surface == "main":
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "agent_msg.register_dock needs a panel surface")
        )
        return
    existing = agent_messaging.get(pane_id) if pane_id else None
    if existing is not None and not existing.is_dock:
        await session.send_json(
            make_error(msg_id, msg_type, "FORBIDDEN", "that pane id belongs to a window pane, not a panel")
        )
        return
    # A panel another live window holds is that window's to rename or move;
    # one whose window disconnected (no owner) may be reclaimed by its reload.
    holder = agent_messaging.owner_of(pane_id) if pane_id else None
    if holder is not None and holder is not session:
        await session.send_json(
            make_error(msg_id, msg_type, "FORBIDDEN", "that panel is held by another window")
        )
        return
    # Only the fields a panel describes itself with. `former_pane_ids` would
    # alias other pane ids to this entry — a window pane's CLI would then act
    # as the panel and its push channel would move here — and `spawned_by`
    # would claim a parent; neither is something a panel ever has.
    allowed = (
        "pane_id", "name", "workspace_path", "agent_key", "realized", "surface", "window_kind", "deliverable",
    )
    await agent_msg_register(session, msg_id, msg_type, {k: payload[k] for k in allowed if k in payload})


@handler("agent_msg.unregister_dock")
async def agent_msg_unregister_dock(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """agent_msg.unregister fenced the same way: it removes panels only."""
    pane_id = str(payload.get("pane_id") or "")
    existing = agent_messaging.get(pane_id) if pane_id else None
    if existing is not None and not existing.is_dock:
        await session.send_json(
            make_error(msg_id, msg_type, "FORBIDDEN", "that pane id belongs to a window pane, not a panel")
        )
        return
    await agent_msg_unregister(session, msg_id, msg_type, payload)


@handler("agent_msg.set_busy")
async def agent_msg_set_busy(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """The owning window reports what a pane is doing: whether its agent is
    mid-turn (so cli_list_targets can tell a caller the target is working) and
    the word its own sidebar badge is showing (so the network view can call the
    pane the same thing this window does)."""
    pane_id = str(payload.get("pane_id") or "")
    # Absent means "this window does not report a status word", which is what an
    # older build looks like; an empty string would blank the last one we had.
    raw_status = payload.get("status")
    display_status = None if raw_status is None else str(raw_status)
    changed = bool(pane_id) and agent_messaging.set_busy(
        pane_id, bool(payload.get("busy")), display_status
    )
    if changed:
        server_link.roster_changed()
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "changed": changed}))


def _external_access_status() -> dict:
    """{enabled, token, port} for the Settings UI's external-access panel."""
    from .mcp_server import auth as plan_mcp_auth, wiring as plan_mcp_wiring

    return {
        "enabled": plan_mcp_auth.external_enabled(),
        "token": plan_mcp_auth.external_token(),
        "port": plan_mcp_wiring.backend_port() or 0,
    }


@handler("external_access.get")
async def external_access_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Settings UI: current /plan-mcp external-access config."""
    await session.send_json(make_response(msg_id, msg_type, _external_access_status()))


@handler("external_access.set")
async def external_access_set(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Settings UI: turn external access to /plan-mcp on or off."""
    from .mcp_server import auth as plan_mcp_auth

    plan_mcp_auth.set_external_enabled(bool(payload.get("enabled")))
    await session.send_json(make_response(msg_id, msg_type, _external_access_status()))


@handler("external_access.regenerate")
async def external_access_regenerate(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Settings UI: mint a new external token, invalidating the old one."""
    from .mcp_server import auth as plan_mcp_auth

    plan_mcp_auth.regenerate_external_token()
    await session.send_json(make_response(msg_id, msg_type, _external_access_status()))


@handler("agent_spawn.result")
async def agent_spawn_result(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """A window's verdict on an agent_spawn.request, handed to the waiting
    cli_open_agent call."""
    from .mcp_server import server as plan_mcp

    request_id = str(payload.get("request_id") or "")
    if not request_id:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "agent_spawn.result needs request_id")
        )
        return
    verdict: dict[str, Any] = {
        "ok": bool(payload.get("ok", False)),
        "error": str(payload.get("error") or ""),
        "pane_id": str(payload.get("pane_id") or ""),
        "name": str(payload.get("name") or ""),
    }
    if payload.get("advisories"):
        verdict["advisories"] = payload["advisories"]
    delivered = plan_mcp.resolve_spawn(request_id, verdict)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "delivered": delivered}))


@handler("agent_spawn.kickoff")
async def agent_spawn_kickoff(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """A window's kickoff verdict for an agent_spawn.request — whether the
    task was observed landing in the new pane — handed to the cli_open_agent
    call still waiting on it."""
    from .mcp_server import server as plan_mcp

    request_id = str(payload.get("request_id") or "")
    if not request_id:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "agent_spawn.kickoff needs request_id")
        )
        return
    verdict: dict[str, Any] = {
        "pane_id": str(payload.get("pane_id") or ""),
        "kickoff": str(payload.get("kickoff") or ""),
    }
    if payload.get("reason"):
        verdict["reason"] = str(payload["reason"])
    delivered = plan_mcp.resolve_kickoff(request_id, verdict)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "delivered": delivered}))


@handler("ui.invoke.result")
async def ui_invoke_result(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """A renderer window's reply to a ui.invoke.request, handed to the
    waiting ui_invoke/ui_snapshot/ui_list_actions MCP call."""
    from .mcp_server import server as plan_mcp

    request_id = str(payload.get("request_id") or "")
    if not request_id:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "ui.invoke.result needs request_id")
        )
        return
    result: dict[str, Any] = {
        "ok": bool(payload.get("ok", False)),
        "result": payload.get("result"),
        "error": str(payload["error"]) if payload.get("error") is not None else None,
    }
    if payload.get("warnings"):
        result["warnings"] = payload["warnings"]
    delivered = plan_mcp.resolve_ui_invoke(request_id, result)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "delivered": delivered}))


# Focus order for app.unicast_any. A counter rather than a clock reading:
# Windows' monotonic clock ticks every ~15.6ms, so two focus changes in quick
# succession would tie and the request could go to the window focused first.
_UI_FOCUS_SEQ = itertools.count(1)


#: A main window's page-load id (B2-c): what renderer code generates (a UUID).
_WINDOW_ID = re.compile(r"[A-Za-z0-9-]{8,64}")


@handler("ui.invoke.ready")
async def ui_invoke_ready(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """A main window announcing that it answers ui.invoke.request — sent on
    every (re)connect, and again with focused true whenever it gains focus,
    so app.unicast_any can hand a global UI action to a window that will
    answer it, preferring the one the user touched last."""
    session.ui_bus_ready = True
    window_id = payload.get("window_id")
    if isinstance(window_id, str) and _WINDOW_ID.fullmatch(window_id):
        session.window_id = window_id
    held = payload.get("workspaces")
    if isinstance(held, list):
        session.held_workspaces = tuple(p for p in held if isinstance(p, str) and p)
    if payload.get("focused"):
        session.ui_focused_at = next(_UI_FOCUS_SEQ)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("agent_msg.list")
async def agent_msg_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    raw_ws = payload.get("workspace_path")
    workspace_path = str(raw_ws) if isinstance(raw_ws, str) and raw_ws else None
    entries = [e.to_dict() for e in agent_messaging.list_panes(workspace_path)]

    # Add `workspace_display_name` — the workspace's user-set alias — so mention
    # menus can title a section with the name the user chose. Done HERE, on the
    # dict the roster handed back, rather than in RegisteredPane.to_dict():
    # workspace_label / qualified_name there are the `<folder>/<pane>`
    # addressing protocol (also MCP cli_list_targets' `address` and the
    # cross-device three-part address), so the roster stays a roster and this
    # stays a presentation detail of one payload.
    #
    # Source is the recent-list mirror, which the backend keeps equal to the
    # display name (alias when set, folder basename otherwise). A path that is
    # not in the mirror — a workspace never opened from this machine's recent
    # list — gets NO field at all: the mirror has nothing to say about it, and
    # the frontend falls back to `workspace_label` (the basename) on its own.
    # The mirror cannot tell "no alias" from "alias equal to the folder name"
    # either way — it stores the basename for both.
    #
    # Offloaded like workspace.list_recent: the mirror is sqlite plus an
    # isdir() per entry, and this handler is polled every few seconds by every
    # AI dock panel — so with nothing to enrich the read is skipped outright.
    def _display_names() -> dict[str, str]:
        store = app.recent_workspaces_store
        return {
            str(e.get("path", "")): str(e.get("name", "") or "")
            for e in store.list()
        }

    names = await asyncio.to_thread(_display_names) if entries else {}
    if names:
        normalize = app.recent_workspaces_store._normalize
        for entry in entries:
            raw_path = entry.get("workspace_path") or ""
            if not raw_path:
                continue
            # Both sides through the store's own normalization: the mirror keys
            # are abspath(expanduser(...)) and a roster path is whatever the
            # window registered, so comparing them raw misses silently.
            display = names.get(normalize(str(raw_path)), "")
            if display:
                entry["workspace_display_name"] = display

    await session.send_json(make_response(msg_id, msg_type, {"panes": entries}))


@handler("agents.public")
async def agents_public(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """One read-only plugin `agents.*` query, Host-authenticated. The Host has
    already checked Manifest, Grant and Execution Policy and binds the
    workspace; see agents_host_api for what each answer may contain."""
    from . import agents_host_api

    if not session.host_authenticated:
        await session.send_json(
            make_error(msg_id, msg_type, "UNAUTHORIZED", "Host session is not authenticated")
        )
        return
    if (
        not isinstance(payload, dict)
        or set(payload) != {"workspace_path", "operation", "arguments"}
        or not isinstance(payload.get("workspace_path"), str)
        or not payload["workspace_path"].strip()
        or payload.get("operation") not in agents_host_api.OPERATIONS
        or not isinstance(payload.get("arguments"), dict)
    ):
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "agents.public is malformed")
        )
        return
    try:
        result = await asyncio.to_thread(
            agents_host_api.run,
            payload["workspace_path"],
            payload["operation"],
            payload["arguments"],
        )
    except agents_host_api.AgentsApiError as err:
        await session.send_json(make_error(msg_id, msg_type, err.code, str(err)))
        return
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("agent_msg.route")
async def agent_msg_route(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app, message_routing

    from_pane_id = str(payload.get("from_pane_id") or "")
    to = str(payload.get("to") or "")
    content = str(payload.get("content") or "")
    msg_key = str(payload.get("msg_key") or "")
    # Correlation id the sender echoed back when this message is a reply. Carried
    # through untouched so the window that handed it out can link the two rows;
    # absent for a message that starts a thread.
    reply_to = str(payload.get("reply_to") or "")
    if not from_pane_id or not to or not msg_key:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "BAD_REQUEST",
                "agent_msg.route needs from_pane_id, to and msg_key",
            )
        )
        return

    # The same resolver cli_send uses, so one address cannot mean two different
    # things depending on whether an agent printed a block or called the tool.
    # It answered "unknown device … not available yet" here for a target the
    # tool delivered, because cross-device addressing was only ever wired into
    # the tool (see message_routing).
    routed = message_routing.route(from_pane_id, to)
    if routed.remote is not None:
        # `reply_to` does not travel. The relay frame carries to/sender/text/
        # msg_key and nothing else (server_link.send_message), so threading a
        # reply across machines would need a wire field the server and the far
        # side both understand — a protocol change, not a routing one. The
        # receiver still mints a correlation id from this msg_key, so the thread
        # holds on its side; what is lost is the link back to the row on this
        # one. Said here rather than left to be discovered from a missing field.
        relayed = await message_routing.relay(
            routed.remote, content, from_pane_id=from_pane_id, msg_key=msg_key
        )
        if relayed is not None:
            await session.send_json(
                make_response(
                    msg_id,
                    msg_type,
                    {
                        "ok": relayed.ok,
                        "error": relayed.error or None,
                        "code": relayed.code or None,
                        "params": {},
                        # No local pane to report: the window that owns the
                        # target is on another machine and delivers it there.
                        "target_display": routed.remote.to_string(),
                        "target_workspace_path": routed.remote.workspace,
                        "target_agent_key": "",
                        "cross_workspace": True,
                    },
                )
            )
            return
        # No link configured on this machine: fall through to the answer this
        # handler gave before, which `route` carried along with the address.

    if routed.pane is None:
        # `code`/`params` let the sending window show the failure in the user's
        # language instead of parsing the English sentence in `error`.
        await session.send_json(
            make_response(
                msg_id,
                msg_type,
                {
                    "ok": False,
                    "error": routed.error or "unresolved",
                    "code": routed.code or None,
                    "params": routed.params or {},
                },
            )
        )
        return
    result = agent_messaging.ResolveResult(
        pane=routed.pane, cross_workspace=routed.cross_workspace
    )

    if result.pane.pane_id == from_pane_id:
        await session.send_json(
            make_response(
                msg_id,
                msg_type,
                {
                    "ok": False,
                    "error": "sender and target are the same pane",
                    "code": "self-send",
                    "params": {},
                },
            )
        )
        return

    if result.pane.agent_key == "terminal":
        from .guard import terminal_policy

        refusal = terminal_policy.enforce(
            content, workspace=result.pane.workspace_path, pane_id=result.pane.pane_id, via="agent_msg.route"
        )
        if refusal is not None:
            await session.send_json(
                make_response(
                    msg_id,
                    msg_type,
                    {
                        "ok": False,
                        "error": refusal.message(),
                        "code": "terminal-command-refused",
                        "params": {"rule": refusal.rule, "segment": refusal.segment},
                    },
                )
            )
            return
    sender = agent_messaging.get(from_pane_id)
    from_display = agent_messaging.sender_display(
        from_pane_id, str(payload.get("from_name") or "")
    )
    deliver_payload: dict[str, Any] = {
        "msg_key": msg_key,
        "target_pane_id": result.pane.pane_id,
        "target_workspace_path": result.pane.workspace_path,
        "target_name": result.pane.name,
        "target_agent_key": result.pane.agent_key,
        "from_pane_id": from_pane_id,
        "from_display": from_display,
        "from_workspace_path": sender.workspace_path if sender else "",
        "from_agent_key": sender.agent_key if sender else "",
        "cross_workspace": result.cross_workspace,
        "content": content,
    }
    # Only present for a reply, so a sender that never sends one keeps seeing the
    # exact payload it saw before.
    if reply_to:
        deliver_payload["reply_to"] = reply_to
    from .guard.taint import safe_mark_tainted

    safe_mark_tainted(
        result.pane.pane_id,
        "agent",
        f"message from {agent_messaging.readable_sender(from_pane_id, from_display)}",
        msg_key,
    )
    asyncio.create_task(app.broadcast(make_event("agent_msg.deliver", deliver_payload)))
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "ok": True,
                "target_pane_id": result.pane.pane_id,
                "target_workspace_path": result.pane.workspace_path,
                "target_display": result.pane.qualified_name,
                "target_agent_key": result.pane.agent_key,
                "cross_workspace": result.cross_workspace,
            },
        )
    )


@handler("agent_msg.hook_drain_result")
async def agent_msg_hook_drain_result(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """A window's answer to `agent_msg.hook_drain`, handed to the Stop hook that
    is holding a claude pane open while it waits.

    An empty `envelope` is a valid answer — it means the pane's queue had
    nothing deliverable — and is what lets the hook return promptly instead of
    sitting out its timeout.
    """
    from . import hook_drain

    request_id = str(payload.get("request_id") or "")
    if not request_id:
        await session.send_json(
            make_error(
                msg_id, msg_type, "BAD_REQUEST", "agent_msg.hook_drain_result needs request_id"
            )
        )
        return
    delivered = hook_drain.resolve_drain(
        request_id, {"envelope": str(payload.get("envelope") or "")}
    )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "delivered": delivered}))


@handler("agent_msg.push")
async def agent_msg_push(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Hand an envelope to a pane's push channel instead of typing it in.

    The window that owns the pane decides whether to push — it holds the queue,
    the rate limit and the idle gate — so this only performs the transport and
    reports whether it landed. A `false` answer is not a failed message: the
    caller retries the same envelope over the PTY, which is what every pane did
    before it had a channel at all.
    """
    from . import app, push_delivery

    pane_id = str(payload.get("pane_id") or "")
    text = str(payload.get("text") or "")
    if not pane_id or not text:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "agent_msg.push needs pane_id and text")
        )
        return
    state = push_delivery.get(pane_id)
    ok, reason = await push_delivery.deliver(pane_id, text)
    if ok:
        # The pane is about to start a turn on this message, and nothing else
        # will say so for a while: a CLI that took the text over HTTP or out of
        # a watched file writes its conversation log at its own pace, and a
        # rewoken agent has no PTY output yet. Without this the window would
        # keep calling the pane idle and start typing the next queued message
        # into a pane already working on this one.
        app._record_pane_activity(pane_id, "agent_active", "")
        await app.broadcast(make_event("agent.activity", {
            "vendor": state.agent_key if state else "",
            "event_type": "agent_active",
            "workspace_path": "",
            "pane_id": pane_id,
            "stage_id": "",
            "session_id": "",
            "cwd": "",
            "timestamp": "",
            "detail": f"push:{state.kind if state else ''}",
            "notification_type": "",
        }))
    kind = state.kind if state else ""
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "ok": ok,
                "kind": kind,
                "reason": reason,
                # "the pane may still be holding this text": the window must
                # then re-queue the message rather than typing it in, or the
                # envelope goes in twice, concatenated.
                "unclear": (not ok) and push_delivery.leaves_text_behind(kind, reason),
            },
        )
    )


@handler("agent_msg.hold_update")
async def agent_msg_hold_update(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """The receiving window reports why a message is still sitting in its queue.

    Delivery lives in the window, so the reason a message has not gone in yet
    exists nowhere else — and an MCP caller, which has no Messages panel to
    look at, could otherwise only see "queued". Sent on a change, never per
    tick.

    `hold` is {key, n?} or null (nothing holding it any more). Keys this server
    never minted are ignored, exactly as agent_msg.delivered ignores them.
    """
    from .mcp_server import server as plan_mcp

    msg_key = str(payload.get("msg_key") or "")
    if not msg_key:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "agent_msg.hold_update needs msg_key")
        )
        return
    hold = payload.get("hold")
    tracked = plan_mcp.record_message_hold(msg_key, hold if isinstance(hold, dict) else None)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "tracked": tracked}))


@handler("agent_msg.cancel")
async def agent_msg_cancel(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """A sending window withdraws a message whose queue another window owns.

    Relayed, not decided here: the queue lives in the receiving window, so only
    it knows whether the message is still waiting or already going in. It
    answers over the ordinary `agent_msg.delivered` path — as cancelled if it
    dropped the message, and not at all if it was too late, because the
    delivery that beat this will report its own outcome.

    Not excluding the sender, for the same reason `agent_msg.delivered` does
    not: a workspace-qualified target can resolve to a pane in the SAME window.
    """
    from . import app

    msg_key = str(payload.get("msg_key") or "")
    if not msg_key:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "agent_msg.cancel needs msg_key")
        )
        return
    asyncio.create_task(
        app.broadcast(make_event("agent_msg.cancel", {"msg_key": msg_key}))
    )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("agent_msg.delivered")
async def agent_msg_delivered(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """The receiving window reports the outcome so the sending window's message
    log can leave the `queued` state.

    Not excluding the reporter: a workspace-qualified target may resolve to a
    pane in the SAME window, and then sender and receiver are one connection —
    excluding it would strand that message in `queued` forever. Windows with no
    matching msg_key ignore the event.
    """
    from . import app
    from .mcp_server import server as plan_mcp

    msg_key = str(payload.get("msg_key") or "")
    if not msg_key:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "agent_msg.delivered needs msg_key")
        )
        return
    # A message that came from cli_send has no window of its own to keep the
    # outcome for, so the MCP server records it for cli_check_message. Ignores
    # every key it did not mint.
    plan_mcp.record_delivery_result(
        msg_key, bool(payload.get("ok", False)), str(payload.get("reason") or "")
    )
    # A message relayed in from another device is acked back to the server from
    # here — this is the only place the receiving window's verdict is observed.
    # Ignores every key that did not arrive over the link.
    server_link.note_delivery_result(
        msg_key, bool(payload.get("ok", False)), str(payload.get("reason") or "")
    )
    asyncio.create_task(
        app.broadcast(
            make_event(
                "agent_msg.delivery_result",
                {
                    "msg_key": msg_key,
                    "ok": bool(payload.get("ok", False)),
                    "reason": str(payload.get("reason") or ""),
                },
            )
        )
    )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


# ── Message-log persistence (agent_msg.log_*) ───────────────────────────────
# The renderer's message log is in-memory and dies with the window; these
# mirror it into the global database. Per-window queries — never broadcast.


@handler("agent_msg.log_snapshot")
async def agent_msg_log_snapshot(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    raw_limit = payload.get("limit", 500)
    try:
        limit = int(raw_limit)
    except (TypeError, ValueError, OverflowError):
        # null / "abc" / Infinity — a bad field is BAD_REQUEST, like the
        # neighbouring agent_msg.route and agent_msg.delivered handlers.
        await session.send_json(
            make_error(
                msg_id, msg_type, "BAD_REQUEST", "agent_msg.log_snapshot needs a numeric limit"
            )
        )
        return
    rows = app.agent_message_log.tail(max(1, min(limit, 500)))
    await session.send_json(make_response(msg_id, msg_type, {"rows": rows}))


@handler("agent_msg.log_append")
async def agent_msg_log_append(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    rows = payload.get("rows")
    if not isinstance(rows, list):
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "agent_msg.log_append needs a rows list")
        )
        return
    # Which workspace each side is, resolved here while those panes are still
    # registered; the renderer's own word for it is never taken.
    for row in rows:
        if isinstance(row, dict):
            row["sender_workspace"] = agent_messaging.workspace_of_name(str(row.get("sender") or ""), session)
            row["recipient_workspace"] = agent_messaging.workspace_of_name(str(row.get("recipient") or ""), session)
    written = app.agent_message_log.append(rows)
    agent_messaging.notify_message_rows(rows)
    await session.send_json(make_response(msg_id, msg_type, {"written": written}))


@handler("agent_msg.log_update")
async def agent_msg_log_update(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    updates = payload.get("updates")
    if not isinstance(updates, list):
        await session.send_json(
            make_error(
                msg_id, msg_type, "BAD_REQUEST", "agent_msg.log_update needs an updates list"
            )
        )
        return
    updated = app.agent_message_log.update(updates)
    await session.send_json(make_response(msg_id, msg_type, {"updated": updated}))


@handler("agent_msg.log_clear")
async def agent_msg_log_clear(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    keep = payload.get("keep_statuses")
    if keep is not None and not isinstance(keep, list):
        await session.send_json(
            make_error(
                msg_id, msg_type, "BAD_REQUEST", "agent_msg.log_clear keep_statuses must be a list"
            )
        )
        return
    deleted = app.agent_message_log.clear(
        [str(s) for s in keep] if keep is not None else None
    )
    await session.send_json(make_response(msg_id, msg_type, {"deleted": deleted}))


# ── Preview record track (preview.log_*) ────────────────────────────────────
# The preview panel's record track is backend-authored and per-workspace. The
# watcher and the MCP tools write straight into the store; these handlers cover
# the third writer — a user action inside the app — plus the read the panel
# hydrates from. Unlike agent_msg.log_*, a write here IS broadcast: every window
# showing that workspace has the same track on screen.


@handler("preview.log_snapshot")
async def preview_log_snapshot(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    workspace_path = str(payload.get("workspace_path") or "")
    if not workspace_path:
        await session.send_json(
            make_error(
                msg_id, msg_type, "BAD_REQUEST", "preview.log_snapshot needs a workspace_path"
            )
        )
        return
    # Same root every writer resolves to (see app._preview_workspace), or a
    # window opened on a subdirectory reads a database nobody writes into.
    # `root` goes back with the entries (as plans.list_docs does) because the
    # broadcast carries this resolved value too: a window that only knew the
    # raw path it was opened on would drop every live `preview.recorded`.
    workspace_path = await asyncio.to_thread(resolve_plan_root, workspace_path)
    raw_limit = payload.get("limit", 50)
    try:
        limit = int(raw_limit)
    except (TypeError, ValueError, OverflowError):
        await session.send_json(
            make_error(
                msg_id, msg_type, "BAD_REQUEST", "preview.log_snapshot needs a numeric limit"
            )
        )
        return
    # tail() clamps the limit to the store's own ceiling.
    entries = app.preview_log.tail(workspace_path, limit)
    await session.send_json(
        make_response(msg_id, msg_type, {"entries": entries, "root": workspace_path})
    )


@handler("preview.log_append")
async def preview_log_append(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    workspace_path = str(payload.get("workspace_path") or "")
    change = str(payload.get("change") or "")
    if not workspace_path or not change:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "BAD_REQUEST",
                "preview.log_append needs a workspace_path and a change",
            )
        )
        return
    # The broadcast below carries this same value, so it has to be the
    # normalised one the snapshot reads back.
    workspace_path = await asyncio.to_thread(resolve_plan_root, workspace_path)
    entry = app.preview_log.append(
        workspace_path,
        change=change,
        kind=str(payload.get("kind") or "file"),
        rel_path=payload.get("rel_path"),
        title=payload.get("title"),
        # A row written through this handler is by definition the user acting
        # inside the app, so the wire does not get to claim agent or watcher.
        source="user",
        pane_id=payload.get("pane_id"),
        note=payload.get("note"),
    )
    # None means the store rejected the row or folded it into one already on the
    # feed — there is nothing new for the other windows to show.
    if entry is not None:
        await app.broadcast(
            make_event(
                "preview.recorded", {"workspace_path": workspace_path, "entry": entry}
            )
        )
    await session.send_json(make_response(msg_id, msg_type, {"entry": entry}))


@handler("preview.log_clear")
async def preview_log_clear(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    workspace_path = str(payload.get("workspace_path") or "")
    if not workspace_path:
        await session.send_json(
            make_error(
                msg_id, msg_type, "BAD_REQUEST", "preview.log_clear needs a workspace_path"
            )
        )
        return
    workspace_path = await asyncio.to_thread(resolve_plan_root, workspace_path)
    raw_before = payload.get("before")
    before: int | None = None
    if raw_before is not None:
        try:
            before = int(raw_before)
        except (TypeError, ValueError, OverflowError):
            await session.send_json(
                make_error(
                    msg_id, msg_type, "BAD_REQUEST", "preview.log_clear before must be a timestamp"
                )
            )
            return
    removed = app.preview_log.clear(workspace_path, before=before)
    if removed:
        await app.broadcast(
            make_event(
                "preview.log_cleared",
                {"workspace_path": workspace_path, "before": before, "removed": removed},
            )
        )
    await session.send_json(make_response(msg_id, msg_type, {"removed": removed}))


# ── Navide scheduler (scheduler.*) ──────────────────────────────────────────
# Thin wrappers over scheduler.SchedulerService, which the scheduler_* MCP
# tools call too. Malformed requests are BAD_REQUEST; an operation that fails
# (unknown id, already running) answers {ok: false, error}. Mutations answer
# first, then push the whole job list to the other windows.


def _scheduler_id(payload: dict) -> str | None:
    job_id = payload.get("id")
    return job_id if isinstance(job_id, str) and job_id.strip() else None


async def _scheduler_bad_request(session: "Session", msg_id: str, msg_type: str, message: str) -> None:
    await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", message))


@handler("scheduler.list")
async def scheduler_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import scheduler

    await session.send_json(
        make_response(msg_id, msg_type, await scheduler.get_service().list())
    )


@handler("scheduler.upsert")
async def scheduler_upsert(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Create (no id) or update (with id) a job; the definition is validated
    by the same function the MCP tool uses."""
    from . import scheduler

    job = payload.get("job")
    if not isinstance(job, dict):
        await _scheduler_bad_request(session, msg_id, msg_type, "scheduler.upsert needs a job object")
        return
    try:
        result = await scheduler.get_service().upsert(job)
    except scheduler.JobInvalid as err:
        await _scheduler_bad_request(session, msg_id, msg_type, str(err))
        return
    await session.send_json(make_response(msg_id, msg_type, result))
    await scheduler.broadcast_changed(exclude=session)


@handler("scheduler.remove")
async def scheduler_remove(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import scheduler

    job_id = _scheduler_id(payload)
    if job_id is None:
        await _scheduler_bad_request(session, msg_id, msg_type, "scheduler.remove needs an id")
        return
    result = await scheduler.get_service().remove(job_id)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        await scheduler.broadcast_changed(exclude=session)


@handler("scheduler.set_enabled")
async def scheduler_set_enabled(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import scheduler

    job_id = _scheduler_id(payload)
    enabled = payload.get("enabled")
    if job_id is None or not isinstance(enabled, bool):
        await _scheduler_bad_request(
            session, msg_id, msg_type, "scheduler.set_enabled needs an id and enabled (true|false)"
        )
        return
    result = await scheduler.get_service().set_enabled(job_id, enabled)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        await scheduler.broadcast_changed(exclude=session)


@handler("scheduler.adopt")
async def scheduler_adopt(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Make an agent's job the user's ("make it mine"). Deliberately not an MCP
    tool: it is how the user takes over a job no agent may change any more."""
    from . import scheduler

    job_id = _scheduler_id(payload)
    if job_id is None:
        await _scheduler_bad_request(session, msg_id, msg_type, "scheduler.adopt needs an id")
        return
    result = await scheduler.get_service().adopt(job_id)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        await scheduler.broadcast_changed(exclude=session)


@handler("scheduler.keep")
async def scheduler_keep(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Stop an agent's periodic job from expiring. Not an MCP tool, for the same
    reason as scheduler.adopt: the expiry exists to outlive a forgetful agent."""
    from . import scheduler

    job_id = _scheduler_id(payload)
    if job_id is None:
        await _scheduler_bad_request(session, msg_id, msg_type, "scheduler.keep needs an id")
        return
    result = await scheduler.get_service().keep(job_id)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        await scheduler.broadcast_changed(exclude=session)


@handler("scheduler.run_now")
async def scheduler_run_now(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Start one run and answer at once; the run's own start and end reach
    every window (this one included) as scheduler.changed."""
    from . import scheduler

    job_id = _scheduler_id(payload)
    if job_id is None:
        await _scheduler_bad_request(session, msg_id, msg_type, "scheduler.run_now needs an id")
        return
    await session.send_json(
        make_response(msg_id, msg_type, await scheduler.get_service().run_now(job_id))
    )


@handler("scheduler.runs")
async def scheduler_runs(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import scheduler

    job_id = _scheduler_id(payload)
    limit = payload.get("limit", 20)
    if job_id is None or isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 200:
        await _scheduler_bad_request(
            session, msg_id, msg_type, "scheduler.runs needs an id and an optional limit of 1..200"
        )
        return
    await session.send_json(
        make_response(msg_id, msg_type, await scheduler.get_service().runs(job_id, limit))
    )


# ── A workspace's self-evolution (evolve.*) ─────────────────────────────────
# Thin wrappers over evolve_service. Every request names the workspace it is
# about; settings and runs live in that workspace's own database.


def _evolve_workspace(payload: dict) -> str | None:
    workspace = payload.get("workspace")
    return workspace if isinstance(workspace, str) and workspace.strip() else None


@handler("evolve.get")
async def evolve_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import evolve_service

    workspace = _evolve_workspace(payload)
    if workspace is None:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", "evolve.get needs a workspace"))
        return
    await session.send_json(
        make_response(msg_id, msg_type, await evolve_service.get_service().get(workspace))
    )


@handler("evolve.set")
async def evolve_set(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import evolve_service, scheduler

    workspace = _evolve_workspace(payload)
    settings = payload.get("settings")
    if workspace is None or not isinstance(settings, dict):
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "evolve.set needs a workspace and a settings object")
        )
        return
    result = await evolve_service.get_service().set(workspace, settings)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        await scheduler.broadcast_changed()


@handler("evolve.run_now")
async def evolve_run_now(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import evolve_service

    workspace = _evolve_workspace(payload)
    if workspace is None:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", "evolve.run_now needs a workspace"))
        return
    await session.send_json(
        make_response(msg_id, msg_type, await evolve_service.get_service().run_now(workspace))
    )


@handler("evolve.badges")
async def evolve_badges(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import evolve_service

    workspaces = payload.get("workspaces")
    if not isinstance(workspaces, list) or len(workspaces) > 200:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "evolve.badges needs a list of at most 200 workspaces")
        )
        return
    await session.send_json(
        make_response(msg_id, msg_type, await evolve_service.get_service().badges(workspaces))
    )


# ── CLI extensions (cli_extensions.*) ──────────────────────────────────────
# The read-only inventory behind Settings → Extensions. Scanning reads
# files and at most a declared listing command with a timeout, so a thread
# keeps it off the loop.
@handler("cli_extensions.list")
async def cli_extensions_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import cli_extensions

    inventory = await asyncio.to_thread(cli_extensions.scan)
    from . import app

    listing = await asyncio.to_thread(app.convenience_gate.listing)
    inventory.items.extend(cli_extensions.navide_changes(listing["features"]))
    await session.send_json(make_response(msg_id, msg_type, inventory.as_dict()))


# ── Convenience features (convenience.*) ───────────────────────────────────
# What Navide changes outside its own data; docs/en-US/convenience-features.md.


def _convenience_source(session: "Session") -> str:
    """Who moved a switch, for the audit log: a main window (it runs the UI
    action bus, where the overview lives) or some other client holding the
    backend token — a script, or an agent that read the token file. Pane
    agents have no MCP tool for convenience.*, so this is how one would show.
    ui.invoke.ready is the client's own word, so the window proof checked at
    connect is what makes it "settings"."""
    window = getattr(session, "navide_window", False) and getattr(session, "ui_bus_ready", False)
    return "settings" if window else "ws-client"


@handler("convenience.list")
async def convenience_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    listing = await asyncio.to_thread(app.convenience_gate.listing)
    await session.send_json(make_response(msg_id, msg_type, listing))


@handler("convenience.history")
async def convenience_history(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    feature_id = str(payload.get("feature") or "") or None
    try:
        limit = int(payload.get("limit") or 200)
        entries = await asyncio.to_thread(app.convenience_gate.history, feature_id, limit)
    except (KeyError, ValueError) as err:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", str(err)))
        return
    await session.send_json(make_response(msg_id, msg_type, {"entries": entries}))


@handler("convenience.set")
async def convenience_set(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app, convenience_wiring
    from .applog import backend_port_file
    from .convenience import CleanupIncomplete

    feature_id = str(payload.get("id") or "")
    allowed = payload.get("allowed")
    if not isinstance(allowed, bool):
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", "allowed must be a boolean"))
        return
    try:
        await asyncio.to_thread(
            convenience_wiring.set_feature, feature_id, allowed,
            port_file=str(backend_port_file()), source=_convenience_source(session),
        )
    except KeyError:
        await session.send_json(make_error(msg_id, msg_type, "UNKNOWN_FEATURE", feature_id))
        return
    except CleanupIncomplete as err:
        # The switch did not move: Navide's entry is still in those files and
        # still works. The cleanup rows already announced which and why.
        await session.send_json(make_error(msg_id, msg_type, "CLEANUP_INCOMPLETE", str(err)))
        await app.broadcast(make_event("convenience.changed", {"feature": feature_id}))
        return
    except ValueError as err:
        await session.send_json(make_error(msg_id, msg_type, "REQUIRED_FEATURE", str(err)))
        return
    feature = await asyncio.to_thread(app.convenience_gate.listing_feature, feature_id)
    await session.send_json(make_response(msg_id, msg_type, {"feature": feature}))
    await app.broadcast(make_event("convenience.changed", {"feature": feature_id}))


@handler("convenience.upgrade_ack")
async def convenience_upgrade_ack(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    await asyncio.to_thread(app.convenience_gate.acknowledge_upgrade, source=_convenience_source(session))
    await session.send_json(make_response(msg_id, msg_type, {}))
    await app.broadcast(make_event("convenience.changed", {}))


# ── Voice input (voice.*) ───────────────────────────────────────────────────
# Handlers live in voice_handlers; the sidecar and model in stt_service. Both
# stay inert until one of these messages arrives.
from . import voice_handlers  # noqa: E402

handler("voice.status")(voice_handlers.voice_status)
handler("voice.model.download")(voice_handlers.voice_model_download)
handler("voice.prewarm")(voice_handlers.voice_prewarm)
handler("voice.shutdown")(voice_handlers.voice_shutdown)
handler("voice.start")(voice_handlers.voice_start)
handler("voice.chunk")(voice_handlers.voice_chunk)
handler("voice.stop")(voice_handlers.voice_stop)
handler("voice.cancel")(voice_handlers.voice_cancel)


# ── Chat channels (channels.*) ──────────────────────────────────────────────
# Logic lives in channels/ (manager + adapters); these are thin wrappers.
from .channels import ws_api as channels_ws_api  # noqa: E402

handler(*channels_ws_api.MESSAGE_TYPES)(channels_ws_api.handle)

# The Host's answer to a channel attachment's PDF print (channels/pdf.py).
from .channels import pdf as channels_pdf  # noqa: E402

handler(channels_pdf.RESULT_TYPE)(channels_pdf.handle_result)

# ── Navide Guard (guard.*) ──
# Renderer-only: ws request types, unreachable through MCP ui_invoke.
from .guard import ws_api as guard_ws_api  # noqa: E402

handler(*guard_ws_api.MESSAGE_TYPES)(guard_ws_api.handle)

# ── Credentials & keys (credentials.*) ──
# Read-only risk scan plus reminder state; logic in credentials_scan. No
# handler here returns or accepts a secret value.
from . import credentials_scan  # noqa: E402

for _credentials_type, _credentials_fn in credentials_scan.MESSAGE_HANDLERS.items():
    handler(_credentials_type)(_credentials_fn)
