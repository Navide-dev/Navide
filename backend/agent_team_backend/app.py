from __future__ import annotations

import asyncio
import base64
import functools
import hashlib
import hmac
import json
import logging
import mimetypes
import os
import re
import secrets
import signal
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from uvicorn.protocols.utils import ClientDisconnected

from . import __version__
from . import agent_messaging
from . import hook_auth
from . import hook_drain
from . import guard_hooks
from .guard import runtime as guard_runtime
from . import ws_auth
from . import error_ledger
from . import launch_id
from . import loop_watchdog
from . import mem_probe
from . import osplat
from . import portable_credentials
from . import push_delivery
from . import resource_limits
from . import subagent_tracker
from .analyzer import DEFAULT_MODEL as ANALYZER_DEFAULT_MODEL
from .analyzer import (
    classify as _llama_classify,
    health as _llama_health,
    list_models as _llama_list_models,
    auto_answer as _llama_auto_answer,
    benchmark as _llama_benchmark,
    llama_cli_busy as _llama_cli_busy,
)
from .analyzer_ollama import (
    classify as _ollama_classify,
    health as _ollama_health,
    list_models as _ollama_list_models,
    auto_answer as _ollama_auto_answer,
    benchmark as _ollama_benchmark,
    pull_model as _ollama_pull_model,
    delete_model as _ollama_delete_model,
)
from .analyzer_settings import AnalyzerSettingsStore
from .ai_chat_settings import AIChatSettingsStore
from .applog import app_data_dir, backend_log_path, backend_port_file, in_data_dir
from .cli_vendors.registry import VENDORS as _CLI_VENDORS
from .cli_vendors.registry import vendor as cli_vendor
from .codex_home import CodexHomeManager
from .ipc import make_error, make_event, make_response
from .log_readers import (
    ActivityEvent,
    LogWatcher,
    TokenSinkResult,
    TokenUsage,
)
from .log_readers.attribution import Attribution
from .log_readers.claude import encode_claude_cwd
from .credential_vault import CredentialVault
from .credential_watcher import CredentialWatcher, reconcile_live_account
from .doc_injector import fetch_stage_docs
from .mcp_manager import MCPManager
from .mcp_server import server as mcp_server
from .mcp_server import wiring as mcp_server_wiring
from .mcp_settings import (
    MCPSettingsStore,
    redact_mcp_server_secrets,
)
from .plan_index import PlanIndex, resolve_plan_root
from .plan_provisioning import ensure_plan_assets, plan_spec_exists
from .pane_account_history import PaneAccountHistory, parse_event_time
from .quota_ledger import QuotaLedger
from .quota_failover import QuotaFailoverService
from .profile_migration import migrate_legacy_claude_homes
from .profiles_store import CLAUDE_ENV_OVERRIDES, CliProfilesStore
from .skills_store import SkillsStore
from .projects import ProjectStore
from .spawn_history import SpawnHistoryStore
from .recent_workspaces import RecentWorkspacesStore
from .roles_store import RolesStore
from .stages_store import StagesStore
from .db import DB_FILENAME, Database, WorkspaceDatabases
from .dev_time_store import DevTimeStore
from .store_migrations import run_startup_migrations, version_change
from .terminals import TerminalService, output_frame_session_id
from .tokens_store import TokensStore


# Electron gives the backend one bearer used only for the private Host WebSocket
# registration. It arrives on stdin, on the confirm key's line after a space (see
# __main__ and set_host_session_token) -- never in the environment: on macOS a
# same-uid process reads the spawn env block with `ps -E` even after a pop.
# The variable is still scrubbed, never adopted, so a stale launcher that sets
# it cannot leak it into backend-launched shells, PTYs, Git hooks or helpers.
os.environ.pop("NAVIDE_BACKEND_HOST_TOKEN", None)
_HOST_SESSION_TOKEN = ""
from .ui_settings import UiSettingsStore
from .cli_risk import CliRiskService
from .cli_risk_store import CliRiskStore
from .sync_engine import SyncStore
from .history_store import HistoryStore
from .agent_message_log import AgentMessageLog
from .preview_log import MAX_ROWS as PREVIEW_MAX_ROWS, PreviewLog
from . import git_service
from . import issue_service
from . import fs_service
from . import pty_registry
from . import search_service
from . import server_link
from . import channels
from . import editor_service
from . import onboarding_deps
from . import plan_history
from .plugins import wiring as plugin_wiring
from .plugins.host import PluginHost
from . import ws_handlers
from .git_watcher import GitWatcher

log = logging.getLogger("agent_team_backend")

STARTED_AT = datetime.now(timezone.utc).isoformat()

app = FastAPI(
    title="navide-backend",
    version=__version__,
    # The schema and its viewers are an unauthenticated route table plus a
    # product name, served to anything that finds the port. Nothing in the app
    # reads them.
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

#: Hostnames this loopback server answers to. A browser cannot forge Host (it
#: is a forbidden header name), so a DNS-rebinding page that has made itself
#: same-origin with 127.0.0.1 still arrives here as ``Host: evil.com``. The
#: /ws handshake already refuses a web Origin (see ws_auth); this is the same
#: defence for the HTTP routes, which non-browser clients reach without ever
#: sending an Origin at all.
_LOCAL_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


def is_local_host_header(host_header: str) -> bool:
    """Whether a Host header names this loopback server.

    Parsed rather than compared as a string so ``[::1]:1234`` and a bare
    ``localhost`` both resolve to a hostname; splitting on ':' by hand gets
    IPv6 wrong. A missing Host resolves to None and is refused.

    The port is deliberately not compared. Hook commands baked into a user's
    ``~/.claude/settings.json`` resolve the port from the port file at run
    time, and one pointing at a previous run must fail as a connection error
    rather than be rejected here as the wrong host.
    """
    return urlparse(f"//{host_header or ''}").hostname in _LOCAL_HOSTS


@app.middleware("http")
async def reject_foreign_host(request: Request, call_next: Any) -> Response:
    """Refuse a request whose Host is not this loopback server.

    A DNS-rebinding page can make itself same-origin with 127.0.0.1 and read
    our replies, but it cannot forge Host — it is a forbidden header name — so
    it still arrives as ``Host: evil.com``. The /ws handshake already refuses a
    web Origin (see ws_auth); this is the same defence for the HTTP routes,
    which non-browser clients reach without sending an Origin at all.

    Registered on the app rather than per-route because plugin routes are
    appended straight to ``app.router`` at startup (see plugins/wiring.py) and
    never pass through FastAPI's dependency system.
    """
    if not is_local_host_header(request.headers.get("host", "")):
        return Response(status_code=403)
    return await call_next(request)

database = Database(app_data_dir() / DB_FILENAME)
# Every write outside Navide's own data goes through this gate
# (docs/en-US/convenience-features.md).
from . import convenience_wiring  # noqa: E402
from .convenience import ConvenienceGate  # noqa: E402

convenience_gate = ConvenienceGate(
    database,
    backup_root=app_data_dir() / "convenience-backups",
    notify=convenience_wiring.broadcast_change,
)
convenience_wiring.install(convenience_gate)
workspace_databases = WorkspaceDatabases()
project_store = ProjectStore(databases=workspace_databases)
spawn_history_store = SpawnHistoryStore(databases=workspace_databases)
recent_workspaces_store = RecentWorkspacesStore(db=database)
roles_store = RolesStore(db=database)
stages_store = StagesStore(db=database)
tokens_store = TokensStore(db=database)
# Which account each pane was pinned to, and when — global like the pane ids.
pane_account_history = PaneAccountHistory(db=database)
# Navide plugin audit (plan B, B1-d): agent tool calls and plugin activity,
# write-only. Creating the tables is the only work done here; writing and
# pruning run in the background task started at startup.
from .plugins.audit_log import PluginAuditLog  # noqa: E402

plugin_audit_log = PluginAuditLog(db=database)
# Quota cycles per account: the usage poller files samples here; an open
# cycle's token side is summed from the store's per-account slices.
quota_ledger = QuotaLedger(db=database, totals_provider=tokens_store.account_window_totals)
# Account-switch failover authority (policy, incidents, persisted auto budget,
# switch transactions) — global like the profiles it switches.
quota_failover = QuotaFailoverService(db=database)
history_store = HistoryStore(databases=workspace_databases)
plan_index = PlanIndex(databases=workspace_databases)
preview_log = PreviewLog(databases=workspace_databases)
# resolve_pane: file activity under the id the pane answers to now, like
# _current_pane_id below (a rebuilt pane must not split its time in two).
dev_time_store = DevTimeStore(
    databases=workspace_databases, resolve_pane=agent_messaging.resolve_alias
)
# Cross-workspace by construction, so it lives in the global database.
agent_message_log = AgentMessageLog(db=database)
codex_home_manager = CodexHomeManager()
cli_profiles_store = CliProfilesStore(db=database)
from .credential_store import CredentialStores, active_store_metadata, managed_watch_path

credential_vault = CredentialVault(stores=CredentialStores(database, active_store_metadata))
mcp_manager = MCPManager()
plugin_host = PluginHost()
mcp_settings_store = MCPSettingsStore()
skills_store = SkillsStore()
analyzer_settings_store = AnalyzerSettingsStore(db=database)
ai_chat_settings_store = AIChatSettingsStore(db=database)
ui_settings_store = UiSettingsStore(db=database)
cli_risk_service = CliRiskService(CliRiskStore(database))
sync_store = SyncStore(database)
# Module-level stores share the same database handle.
pty_registry.set_database(database)
onboarding_deps.set_database(database)

# ─── Analyzer backend routing ────────────────────────────────────────────────

def _az_settings() -> dict:
    return analyzer_settings_store.get()

def _az_is_ollama() -> bool:
    return _az_settings().get("backend") == "ollama"

def _az_base_url() -> str:
    return _az_settings().get("ollama_base_url", "http://localhost:11434")

def _az_llama_cli() -> str | None:
    v = _az_settings().get("llama_cli", "").strip()
    return v or None

def _az_gguf_path() -> str | None:
    v = _az_settings().get("gguf_path", "").strip()
    return v or None

_AI_SECRET_KEYS = {
    "anthropic_api_key",
    "openai_api_key",
    "google_api_key",
    "groq_api_key",
    "deepseek_api_key",
    "mistral_api_key",
    "xai_api_key",
    "openai_compatible_api_key",
}


def _settings_paths() -> dict[str, str]:
    return {
        "app_data_dir": str(app_data_dir()),
        "roles": str(roles_store.path),
        "pipelines": str(stages_store.path),
        "mcp": str(mcp_settings_store.path),
        "skills": str(skills_store.root),
        "skills_state": str(skills_store.state_path),
        "analyzer": str(analyzer_settings_store.path),
        "ai_chat": str(ai_chat_settings_store.path),
        "backend_log": str(backend_log_path()),
    }


def _redact_ai_chat_settings(settings: dict[str, Any]) -> dict[str, Any]:
    return {
        key: ("__redacted__" if key in _AI_SECRET_KEYS and value else value)
        for key, value in settings.items()
        if key != "model"
    }


def _settings_bundle() -> dict[str, Any]:
    return {
        "format_version": 1,
        "exported_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "paths": _settings_paths(),
        "roles": roles_store.list(),
        "pipelines_document": stages_store.export_document(),
        "mcp_servers": redact_mcp_server_secrets(mcp_settings_store.list_servers()),
        "analyzer": analyzer_settings_store.get(),
        "ai_chat": _redact_ai_chat_settings(ai_chat_settings_store.get()),
        "notes": {
            "secrets": "API keys and tokens are redacted; local values are preserved on import.",
        },
    }


async def analyzer_health() -> dict:
    if _az_is_ollama():
        return await _ollama_health(_az_base_url())
    return await _llama_health(llama_cli_override=_az_llama_cli(), gguf_path_override=_az_gguf_path())

async def analyzer_list_models() -> list:
    if _az_is_ollama():
        return await _ollama_list_models(_az_base_url())
    return await _llama_list_models()

async def analyzer_classify(text: str, model: str) -> dict:
    if _az_is_ollama():
        return await _ollama_classify(text, model=model, base_url=_az_base_url())
    return await _llama_classify(text, model=model,
                                 llama_cli_override=_az_llama_cli(),
                                 gguf_path_override=_az_gguf_path())

async def analyzer_auto_answer(questions: list, task: str, stage_title: str, model: str) -> dict:
    if _az_is_ollama():
        return await _ollama_auto_answer(questions, task, stage_title, model=model, base_url=_az_base_url())
    return await _llama_auto_answer(questions, task, stage_title, model=model,
                                    llama_cli_override=_az_llama_cli(),
                                    gguf_path_override=_az_gguf_path())

async def analyzer_benchmark(progress_cb=None) -> list:
    if _az_is_ollama():
        return await _ollama_benchmark(_az_base_url(), progress_cb=progress_cb)
    return await _llama_benchmark(progress_cb=progress_cb)

# Log readers: one per vendor. Attribution maps log session files to panes.
# One reader per registered vendor — the registry is the single source.
_readers = [
    spec.make_log_reader()
    for spec in _CLI_VENDORS.values()
    if spec.make_log_reader is not None
]
attribution = Attribution(_readers, db=database)
# Every path that drops a pane's registration (kill, unspawn, PTY death after
# the grace period) closes its account interval through this one hook.
attribution.on_unregister = pane_account_history.release
_log_watcher: LogWatcher | None = None
_git_watcher: GitWatcher | None = None
_credential_watcher: CredentialWatcher | None = None


# Module-level registry of all currently-connected WebSocket sessions so that
# state changes (e.g. roles edits) can be broadcast to every window the user
# has open (main + role manager + future windows).
_SESSIONS: set["Session"] = set()


async def broadcast(event: dict[str, Any], *, exclude: "Session | None" = None) -> None:
    """Fire-and-forget send to every connected session (optionally minus one)."""
    for session in list(_SESSIONS):
        if session is exclude:
            continue
        try:
            await session.send_json(event)
        except Exception as err:  # noqa: BLE001
            # send_json already marks dead + discards on send failure; this is
            # a defensive net for anything unexpected it re-raised.
            log.warning("broadcast send failed: %s", err)
            _SESSIONS.discard(session)


async def unicast_to(session: "Session | None", event: dict[str, Any]) -> bool:
    """Send *event* to one named session. Returns False when it is not there.

    For a request whose owner is known — the window mirroring a particular pane
    — rather than one any window may service (unicast_any) or one every window
    has to filter for itself (broadcast). A False return is the caller's cue to
    fall back, not an error: the window may have dropped between the lookup and
    the send.

    That miss is read off `dead` AFTER the send, not from an exception:
    send_json never raises on a dead peer (it marks the session dead, discards
    it and no-ops instead), so a try/except here would never fire and a request
    sent into a window that had just closed would be reported as delivered —
    suppressing the caller's fallback and costing it a full timeout.
    """
    if session is None or getattr(session, "dead", False):
        return False
    await session.send_json(event)
    return not getattr(session, "dead", False)


async def unicast_any(event: dict[str, Any]) -> bool:
    """Send *event* to one connected window that runs the UI action bus.

    For requests any live window can service (e.g. a global UI action with no
    fixed owner), so a broadcast that every window would otherwise have to
    ignore is unnecessary. Only sessions that announced `ui.invoke.ready` are
    candidates — any other session (a plugin or editor window) would drop the
    request and leave the caller to time out — and the most recently focused
    one goes first. Returns False when no such window is connected.
    """
    ready = [s for s in _SESSIONS if s.ui_bus_ready]
    for session in sorted(ready, key=lambda s: s.ui_focused_at, reverse=True):
        if session.dead:
            continue
        try:
            await session.send_json(event)
        except Exception as err:  # noqa: BLE001
            # Same defensive net as broadcast(): try the next session rather
            # than failing the request outright.
            log.warning("unicast send failed: %s", err)
            _SESSIONS.discard(session)
            continue
        if session.dead:
            # send_json marks a vanished peer dead instead of raising.
            continue
        return True
    return False


def is_main_window(session: "Session") -> bool:
    """A proven Navide window that runs the UI action bus: a main window."""
    return bool(getattr(session, "navide_window", False) and getattr(session, "ui_bus_ready", False))


async def broadcast_main_windows(event: dict[str, Any]) -> None:
    """Send *event* to every connected main window only (not plugin, editor
    or other WS clients): for records naming a requester's pane and workspace."""
    for session in list(_SESSIONS):
        if session.dead or not is_main_window(session):
            continue
        try:
            await session.send_json(event)
        except Exception as err:  # noqa: BLE001
            log.warning("main-window broadcast send failed: %s", err)
            _SESSIONS.discard(session)


async def nudge_plugin_request_recovery(session: "Session") -> None:
    """A main window went away (review-370 R1): if it was carrying out approved
    plugin requests, ask the main windows still open to settle them, instead of
    leaving them ``applying`` until another window opens. Each window waits a
    short grace before settling, so a window that is only reconnecting claims
    its request back first (R2). Never raises."""
    window_id = getattr(session, "window_id", "")
    if not window_id or not is_main_window(session):
        return
    try:
        from .ipc import make_event
        from .plugins import agent_tools_contract as contract
        from .skills_approvals import registry

        held = [
            r["approval_id"] for r in registry.plugin_requests()
            if r["status"] == "applying" and registry.applying_by(r["approval_id"]) == window_id
        ]
        if held:
            await broadcast_main_windows(make_event(contract.PLUGIN_APPROVAL_RECOVER_EVENT, {"approval_ids": held}))
    except Exception as err:  # noqa: BLE001 - a closing socket must not fail on this
        log.warning("plugin request recovery nudge failed: %s", err)


def has_main_window() -> bool:
    """Whether a main window is connected now (forms open there)."""
    return any(not s.dead and is_main_window(s) for s in list(_SESSIONS))


def live_main_window_ids() -> set[str]:
    """The page-load ids (``ui.invoke.ready`` window_id) of the main windows connected now."""
    return {
        s.window_id for s in list(_SESSIONS)
        if not s.dead and is_main_window(s) and getattr(s, "window_id", "")
    }


def main_window_sessions() -> list["Session"]:
    """The main windows connected now that announced a page-load id."""
    return [
        s for s in list(_SESSIONS)
        if not s.dead and is_main_window(s) and getattr(s, "window_id", "")
    ]


async def unicast_host(event: dict[str, Any]) -> bool:
    """Send one internal agent request to the authenticated Electron Host."""
    for session in list(_SESSIONS):
        if session.dead or not session.host_authenticated:
            continue
        try:
            await session.send_json(event)
        except Exception as err:  # noqa: BLE001
            log.warning("host unicast send failed: %s", err)
            _SESSIONS.discard(session)
            continue
        return not session.dead
    return False


def host_supports_plans_backend() -> bool:
    """Return whether the authenticated Electron Host owns production Plans."""
    return any(
        not session.dead and session.host_authenticated and session.plans_backend_v2
        for session in list(_SESSIONS)
    )


#: The Navide plugins whose Disabled switch the Host reports.
DISABLEABLE_BUILTIN_PLUGINS = frozenset({"navide.plans", "navide.git", "navide.mini-ide"})
#: Set by main on every backend start: the built-ins disabled at that moment,
#: comma-separated. Absent when none is.
DISABLED_BUILTIN_PLUGINS_ENV = "NAVIDE_DISABLED_BUILTIN_PLUGINS"
#: What the last authenticated Host registration reported, kept across a Host
#: reconnect. None until a Host has registered in this process.
_host_reported_disabled: frozenset[str] | None = None


def note_host_disabled_plugins(disabled: frozenset[str]) -> None:
    """Record a Host registration's disabled built-ins (see host.register)."""
    global _host_reported_disabled
    _host_reported_disabled = frozenset(disabled)


def _disabled_at_spawn() -> frozenset[str]:
    raw = os.environ.get(DISABLED_BUILTIN_PLUGINS_ENV, "")
    return frozenset(item for item in raw.split(",") if item in DISABLEABLE_BUILTIN_PLUGINS)


def host_disabled_plugins() -> frozenset[str]:
    """Built-in Navide plugins the user disabled.

    An authenticated Host session is authoritative. Without one (before the
    Host registers, or while it reconnects) the last registration's answer
    stands, and before any registration the set main passed at spawn. With
    nothing disabled every source is empty, which is main's behaviour."""
    disabled: set[str] = set()
    hosted = False
    for session in list(_SESSIONS):
        if not session.dead and session.host_authenticated:
            hosted = True
            disabled |= session.disabled_plugins
    if hosted:
        return frozenset(disabled)
    if _host_reported_disabled is not None:
        return _host_reported_disabled
    return _disabled_at_spawn()


def plans_plugin_disabled() -> bool:
    """Whether the user disabled the built-in Plans plugin."""
    return "navide.plans" in host_disabled_plugins()


def navide_window_proof_matches(challenge: str, proof: Any) -> bool:
    """Whether `proof` answers this connection's window challenge: main
    returns HMAC-SHA256(host token, "navide-window/v2\\0" + challenge) to its
    main windows (backend:proveWindow) and to nothing else. The token file is
    readable by every pane process, so it cannot say this; the host token
    never leaves main and this process. The challenge is per connection, so a
    proof seen once is worth nothing on any other."""
    expected = _HOST_SESSION_TOKEN
    if not isinstance(proof, str) or not expected or not challenge:
        return False
    digest = hmac.new(
        expected.encode(), b"navide-window/v2\0" + challenge.encode(), hashlib.sha256
    ).hexdigest()
    # Bytes, not str: compare_digest raises on a str with non-ASCII in it.
    return secrets.compare_digest(proof.encode(), digest.encode())


def set_host_session_token(token: str) -> bool:
    """Adopt the host token main handed over on stdin. Returns whether there
    was one; without it host.register refuses and no session is a window."""
    global _HOST_SESSION_TOKEN
    _HOST_SESSION_TOKEN = token if isinstance(token, str) else ""
    return bool(_HOST_SESSION_TOKEN)


def host_session_token_matches(token: Any) -> bool:
    """Validate the per-backend token used by Electron's Host session."""
    expected = _HOST_SESSION_TOKEN
    return (
        isinstance(token, str)
        and bool(expected)
        and secrets.compare_digest(token.encode(), expected.encode())
    )


# A send slower than this is worth attributing; see Session._note_send_timing.
_SEND_SLOW_WARN_MS = 500.0
# Floor between two slow-send lines. The probe fires hardest exactly when the
# loop can least afford another write to the log pipe, so it must not be the
# thing that makes a stall worse.
_SEND_SLOW_LOG_INTERVAL_S = 10.0


class Session:
    """Per-WebSocket-connection state."""

    def __init__(self, websocket: WebSocket) -> None:
        self.websocket = websocket
        # Handlers run as concurrent tasks and the PTY output pump writes too;
        # the websockets protocol forbids concurrent writes on one connection
        # (its drain assertion trips and wedges the socket permanently), so
        # every outbound frame must go through send_json() below.
        self._send_lock = asyncio.Lock()
        # Token attribution now happens via log_readers (background log scan),
        # NOT via PTY output. The TerminalService is app-level (PTYs outlive this
        # connection); output routes back through _active_emit → the attached
        # Session's send_json. See get_terminals().
        self.terminals = get_terminals()
        # Track background tasks so they can be cancelled on disconnect.
        self._review_tasks: set[asyncio.Task] = set()
        # In-flight handle_message tasks; cancelled in ws() finally so handlers
        # never outlive the connection and drain onto a closed socket.
        self._handler_tasks: set[asyncio.Task] = set()
        # terminal.create is transactional until its result is sent.  Gates
        # serialize generations for one pane; tombstones let a concurrent
        # terminal.create.cancel stop work before Popen; transactions hold the
        # post-Popen resources that cancellation must roll back.
        self._terminal_create_gates: dict[str, asyncio.Lock] = {}
        self._terminal_create_tombstones: set[tuple[str, str]] = set()
        self._terminal_create_transactions: dict[tuple[str, str], dict[str, Any]] = {}
        # PTYs this connection started through onboarding.run. They have no
        # pane to reattach to, so they are killed with the connection.
        self._onboarding_runs: set[str] = set()
        # Server-created target for the next add-account login, never persisted.
        self._created_cli_profile_id = ""
        # In-flight find_in_files cancellation handle: a newer search from
        # this session sets the event so the superseded scan stops early.
        self._search_cancel: threading.Event | None = None
        # Set once the peer is gone (send failed or ws() loop exited). All
        # further send_json calls become silent no-ops.
        self.dead = False
        # Only the Electron main process may receive Host-private agent
        # handoffs. The bearer is registered over this WebSocket and never
        # appears in renderer/backend-info payloads.
        self.host_authenticated = False
        self.plans_backend_v2 = False
        # Built-in Navide plugins the user disabled, as the Host registered them.
        self.disabled_plugins: frozenset[str] = frozenset()
        # Set by `ui.invoke.ready`: only a main window runs the UI action bus,
        # while plugin, editor and manager windows share this server and never
        # answer a ui.invoke.request. unicast_any picks among these alone, the
        # most recently focused first.
        self.ui_bus_ready = False
        self.ui_focused_at = 0.0
        # A main window's page-load id (`ui.invoke.ready` window_id): stays the
        # same across reconnects, changes when the window reloads (B2-c).
        self.window_id = ""
        # Set by `window.prove` answering this connection's challenge (see
        # navide_window_proof_matches): a Navide window, as opposed to any
        # other client holding the token. ui_bus_ready is self-declared.
        self.navide_window = False
        # The nonce sent in `ws.welcome`; cleared by the first right
        # `window.prove`, so a connection is proved at most once.
        self.window_challenge = secrets.token_hex(32)
        # Throttle state for the slow-send probe (see _note_send_timing).
        # None rather than 0.0: the first slow send must always report, which a
        # zero baseline would swallow whenever the clock starts near zero.
        self._slow_send_last_log: float | None = None
        self._slow_send_suppressed = 0

    async def send_json(self, data: dict[str, Any]) -> None:
        """Serialized websocket send — sole writer for this connection.

        Never raises on a dead peer: the first send failure marks the session
        dead and removes it from _SESSIONS; subsequent calls are silent no-ops.
        Callers must not crash just because the client went away.
        """
        if self.dead:
            return
        started = time.monotonic()
        try:
            async with self._send_lock:
                acquired = time.monotonic()
                # Re-check under the lock: on disconnect, a swarm of producers
                # (broadcast + PTY output pump) can all pass the pre-lock guard
                # while dead is still False, then serialize here. Without this
                # re-check every one of them sends onto the closed socket, fails,
                # and logs — turning a single disconnect into thousands of
                # identical warnings that saturate the event loop. The first
                # failure sets dead=True; the rest must no-op as documented.
                if self.dead:
                    return
                await self.websocket.send_json(data)
            # Outside the lock deliberately: this probe logs, and a log write
            # blocks the event loop whenever the stderr pipe is full — holding
            # the lock across that would worsen the very contention it exists
            # to measure.
            self._note_send_timing(started, acquired, time.monotonic())
        except (RuntimeError, WebSocketDisconnect, ClientDisconnected) as err:
            # RuntimeError: starlette's 'Cannot call "send" once a close
            # message has been sent'; ClientDisconnected: uvicorn transport
            # torn down mid-send.
            self.dead = True
            _SESSIONS.discard(self)
            # DEBUG, not WARNING: a peer that went away is this method's
            # documented path (window closed, HMR reload, app quit), so it is
            # not actionable — yet at one line per disconnect it was the single
            # most numerous message in the log. Logged with the exception TYPE
            # because these carry no message and rendered as an empty tail that
            # read like a truncated error.
            log.debug("ws peer gone (%s); marking session %#x dead", type(err).__name__, id(self))

    async def send_bytes(self, data: bytes) -> None:
        """Serialized binary websocket send — shares send_json's lock (one
        writer per connection) and its dead-peer semantics: never raises, the
        first failure marks the session dead and later calls silently no-op.
        Used for terminal-output frames (see terminals._build_output_frame).
        """
        if self.dead:
            return
        started = time.monotonic()
        try:
            async with self._send_lock:
                acquired = time.monotonic()
                # Re-check under the lock — same disconnect swarm as send_json.
                if self.dead:
                    return
                await self.websocket.send_bytes(data)
            self._note_send_timing(started, acquired, time.monotonic())
        except (RuntimeError, WebSocketDisconnect, ClientDisconnected) as err:
            self.dead = True
            _SESSIONS.discard(self)
            log.debug("ws peer gone (%s); marking session %#x dead", type(err).__name__, id(self))

    def _note_send_timing(self, started: float, acquired: float, done: float) -> None:
        """Split a slow send into lock contention vs transport backpressure.

        `pty reader suspended ... held=N` reports that an outbound flush was
        slow but not why, and the two causes want opposite fixes. Time spent
        waiting for _send_lock means another producer was mid-flush, so a
        heartbeat given its own path would skip the queue. Time spent inside
        send_json means the peer is not draining, and no amount of reordering
        helps — every writer is stuck behind the same TCP window. Measure
        before rebuilding either one.

        Takes `done` rather than reading the clock so it stays a pure function
        of three timestamps; patching time.monotonic to test it would derange
        the event loop that schedules on the same clock.
        """
        total_ms = (done - started) * 1000
        if total_ms < _SEND_SLOW_WARN_MS:
            return
        if (
            self._slow_send_last_log is not None
            and done - self._slow_send_last_log < _SEND_SLOW_LOG_INTERVAL_S
        ):
            self._slow_send_suppressed += 1
            return
        tail = f" (+{self._slow_send_suppressed} suppressed)" if self._slow_send_suppressed else ""
        self._slow_send_suppressed = 0
        self._slow_send_last_log = done
        log.warning(
            "slow ws send: total=%.0fms lock_wait=%.0fms transport=%.0fms%s",
            total_ms,
            (acquired - started) * 1000,
            (done - acquired) * 1000,
            tail,
        )

    async def _send_event(self, event: dict[str, Any]) -> None:
        try:
            await self.send_json(event)
        except Exception as err:  # noqa: BLE001
            log.warning("send_event failed: %s", err)


# ── Preview record: one track per project root ──────────────────────────────
# Every writer (this file's two, the preview.log_* handlers, the MCP tools)
# resolves the workspace it was handed to the project root first. A workspace
# opened on a subdirectory otherwise starts a second `.agent-team` database one
# level down, and the panel — which reads the root's — never shows those rows.


def _preview_workspace(ws_path: str) -> str:
    """The project root a preview record for `ws_path` belongs to.

    Only the database moves: `rel_path` stays relative to the workspace the
    caller named, because that is what the panel resolves it against.

    Falls back to `ws_path` itself for anything `resolve_plan_root` cannot
    place (no repository, not a directory): recording somewhere is better than
    the write path raising.
    """
    try:
        return resolve_plan_root(ws_path) or ws_path
    except Exception as err:  # noqa: BLE001
        log.warning("preview workspace resolution failed for %s: %s", ws_path, err)
        return ws_path


# watchdog event type -> preview_log change. The watcher already split a
# `moved` into its deleted and created halves (only it sees both paths), so
# nothing else reaches here; an unknown type is dropped rather than guessed at.
_GIT_EVENT_CHANGES = {
    "created": "created",
    "modified": "modified",
    "deleted": "deleted",
}
_GIT_CHANGED_MAX_PATHS = 1_000


def _record_watcher_changes(
    ws_path: str, entries: list[dict[str, str]]
) -> tuple[str, list[dict[str, Any]]]:
    """Land the watcher's unattributed view of a change burst. Runs off-loop:
    a `git checkout` can debounce thousands of paths into one call.

    Returns the root the rows landed in and the rows worth broadcasting —
    at most the store's own ceiling, because a burst that long has already
    pruned everything older than its own tail.
    """
    root = _preview_workspace(ws_path)
    rows: list[dict[str, Any]] = []
    with preview_log.batch(root):
        for entry in entries:
            row = preview_log.append(
                root,
                change=entry["change"],
                kind="file",
                rel_path=entry["rel_path"],
                title=os.path.basename(entry["rel_path"]),
                source="watcher",
            )
            if row is not None:
                rows.append(row)
    return root, rows[-PREVIEW_MAX_ROWS:]


async def _broadcast_git_changed(
    ws_path: str, paths: list[tuple[str, str]] | None = None
) -> None:
    """GitWatcher sink: a repo's working tree / .git changed on disk.

    `paths` is additive — `workspace_path` stays exactly as the existing
    `git.changed` consumers read it."""
    git_service.pane_git_snapshots.invalidate(ws_path)
    entries = [
        {"rel_path": rel_path, "change": _GIT_EVENT_CHANGES[event_type]}
        for rel_path, event_type in (paths or [])
        if event_type in _GIT_EVENT_CHANGES
    ]
    if entries:
        try:
            root, rows = await asyncio.to_thread(_record_watcher_changes, ws_path, entries)
            # One frame for the whole burst: a checkout that debounces into
            # thousands of paths would otherwise put thousands of events on
            # every window's socket. The other two writers report a single
            # change at a time and keep sending `entry`.
            if rows:
                await broadcast(
                    make_event(
                        "preview.recorded", {"workspace_path": root, "entries": rows}
                    )
                )
        except Exception as err:  # noqa: BLE001
            log.warning("preview record from watcher failed for %s: %s", ws_path, err)
    # Every reader refreshes the whole workspace on the event, so the paths are
    # only a hint; a burst of hundreds of thousands must not become one frame
    # serialised per session on the loop. `paths_truncated` says the list stops.
    event: dict[str, Any] = {
        "workspace_path": ws_path,
        "paths": entries[:_GIT_CHANGED_MAX_PATHS],
    }
    if len(entries) > _GIT_CHANGED_MAX_PATHS:
        event["paths_truncated"] = True
    await broadcast(make_event("git.changed", event))


async def _broadcast_plans_changed(ws_path: str) -> None:
    """GitWatcher plans sink: a plan document under `.agent-team/plans/`
    changed on disk (any writer — App write path or an agent CLI editing the
    file directly). Record stage-transition snapshots first so subscribers
    refreshing on the event see up-to-date history, then notify."""
    try:
        # Snapshots are plan-document writes (`.history/`); none while the user
        # has Plans disabled. The change is still announced.
        if not plans_plugin_disabled():
            await asyncio.to_thread(plan_history.snapshot_plans, ws_path)
    except Exception as err:  # noqa: BLE001
        log.warning("plan snapshot scan failed for %s: %s", ws_path, err)
    await broadcast(make_event("plans.changed", {"workspace_path": ws_path}))


_PLAN_DOC_PREFIXES = (
    ".agent-team/plans",
    ".agent-team/reports",
    ".claude/loop-reports",
    ".claude/plans",
    ".cursor/plans",
    "docs/plans",
    "docs/reports",
)


def _watch_plans_workspace(ws_path: str, rel_path: str) -> None:
    """A plan/report subtree fs access means a plan surface is open — start watching
    that workspace (idempotent) so plan edits push `plans.changed`."""
    if _git_watcher is not None and any(rel_path.startswith(prefix) for prefix in _PLAN_DOC_PREFIXES):
        _git_watcher.watch(ws_path)


def _watch_plans_workspace_now(ws_path: str) -> None:
    """Same, for callers whose request *is* the plans list (no rel_path to match)."""
    if _git_watcher is not None and ws_path:
        _git_watcher.watch(ws_path)


_ASKPASS_PROMPT_URL_RE = re.compile(r"for '([^']+)'")


def _extract_host_from_prompt(prompt: str) -> str:
    """Best-effort remote host extraction from a git askpass prompt, e.g.
    "Username for 'https://gitlab.com': " -> "gitlab.com". Empty string if the
    prompt doesn't match git's usual "<field> for '<url>':" format."""
    match = _ASKPASS_PROMPT_URL_RE.search(prompt)
    if not match:
        return ""
    try:
        return urlparse(match.group(1)).hostname or ""
    except ValueError:
        return ""


def build_credential_request_emitter(
    workspace_path: str,
    credential_owner_nonce: str = "",
) -> Callable[[str, str], Awaitable[None]]:
    """Build the `on_request` callback for git_service.create_askpass_context()
    (Phase C). Broadcasts a git.credential_request event to every connected
    session; frontends filter by workspace_path, same convention as
    git.changed. Each call corresponds to exactly one askpass prompt (git asks
    Username and Password as separate invocations), so `request_id` here
    identifies a single field's answer, not a combined credential pair."""

    async def _on_request(request_id: str, prompt: str) -> None:
        await broadcast(
            make_event(
                "git.credential_request",
                {
                    "request_id": request_id,
                    "workspace_path": workspace_path,
                    "host": _extract_host_from_prompt(prompt),
                    "prompt": prompt,
                    **(
                        {"credential_owner_nonce": credential_owner_nonce}
                        if credential_owner_nonce
                        else {}
                    ),
                },
            )
        )

    return _on_request


def build_credential_settled_emitter(
    workspace_path: str,
    credential_owner_nonce: str = "",
) -> Callable[[str, str | None], Awaitable[None]]:
    """Build the `on_settled` callback for git_service.create_askpass_context()
    (Phase C). Emits git.credential_cancelled only when a request settles with
    no value (timeout or explicit cancellation), so the frontend can close its
    modal; a successful submission needs no further event."""

    async def _on_settled(request_id: str, value: str | None) -> None:
        if value is None:
            await broadcast(
                make_event(
                    "git.credential_cancelled",
                    {
                        "request_id": request_id,
                        "workspace_path": workspace_path,
                        **(
                            {"credential_owner_nonce": credential_owner_nonce}
                            if credential_owner_nonce
                            else {}
                        ),
                    },
                )
            )

    return _on_settled


def _git_credential(payload: dict[str, Any]) -> dict[str, str] | None:
    """Extract a bound-account credential from a git op payload, if the renderer
    attached one (main-process safeStorage store, decrypted just for this op).
    Returns None when absent/malformed so git_service falls back to the normal
    interactive askpass flow."""
    cred = payload.get("credential")
    if isinstance(cred, dict) and cred.get("token") and isinstance(cred.get("expectedHost"), str):
        return {
            "username": str(cred.get("username") or ""),
            "token": str(cred.get("token")),
            "expected_host": cred["expectedHost"],
        }
    return None


# ── App-level terminal ownership (true persistence) ──────────────────────────
# PTYs must outlive any single WebSocket: a renderer reload / window close drops
# the ws, but the terminal (agent CLI, bash, build) keeps running in the
# background until it exits, the user explicitly kills the pane, or the whole
# app quits. So a single app-level TerminalService owns every PTY.
# Output is routed per-PTY: each terminal session is owned by whichever WS
# Session created or last reattached to it. A second window never steals PTYs
# it didn't explicitly claim via terminal.create / terminal.reattach.
_TERMINALS: TerminalService | None = None
# terminal_session_id → owning WS Session. Populated on terminal.create and
# updated on terminal.reattach. Entries removed when the owning WS disconnects.
_PTY_OWNERS: "dict[str, Session]" = {}


# An autonomous PTY death (exit/EOF) must release the attribution registration
# — otherwise the pane's session marker leaks in _unbound_markers forever. But
# the release is DELAYED: the CLI's final log flush reaches attribution through
# the watcher's queue drain / 30s rescan AFTER the exit event, and a marker
# session may still bind late (short-lived run). Immediate unregister would
# drop that usage tail and the pane's resume id. terminal.create for the same
# pane cancels the pending cleanup (a renderer-reload respawn keeps its pane id).
_UNREGISTER_GRACE_SEC = 90.0
_PENDING_UNREGISTERS: dict[str, asyncio.TimerHandle] = {}


def _schedule_pane_unregister(pane_id: str) -> None:
    _cancel_pane_unregister(pane_id)

    def _fire() -> None:
        _PENDING_UNREGISTERS.pop(pane_id, None)
        attribution.unregister_pane(pane_id)

    _PENDING_UNREGISTERS[pane_id] = asyncio.get_running_loop().call_later(
        _UNREGISTER_GRACE_SEC, _fire
    )


def _cancel_pane_unregister(pane_id: str) -> None:
    handle = _PENDING_UNREGISTERS.pop(pane_id, None)
    if handle:
        handle.cancel()


async def _active_emit(event: dict[str, Any] | bytes) -> None:
    """Output sink: route each PTY's output to its owning Session.

    Terminal output arrives as a pre-built binary frame (bytes); everything
    else (e.g. terminal.exit) stays a JSON event dict. Routing and the
    detached-pane drop behave identically for both.
    """
    if isinstance(event, (bytes, bytearray)):
        frame = bytes(event)
        session_id = output_frame_session_id(frame)
        sess = _PTY_OWNERS.get(session_id) if session_id else None
        if sess is None:
            return  # detached: drop output, PTY keeps running, TUI redraws on reattach
        try:
            await sess.send_bytes(frame)
        except Exception as err:  # noqa: BLE001
            log.warning("terminal output send failed: %s", err)
        return
    payload = event.get("payload", {})
    # Runs before the owner check: cleanup applies even when the pane is
    # detached.
    if event.get("type") == "terminal.exit" and isinstance(payload, dict):
        exit_pane_id = payload.get("pane_id")
        if exit_pane_id:
            _schedule_pane_unregister(exit_pane_id)
            # The CLI holding the pane's /plan-mcp token is gone; the token
            # goes too unless the pane is still on screen (see wiring).
            mcp_server_wiring.release_pane_token(str(exit_pane_id))
            # A CLI that exits with subagents still running never reports their
            # stops, so the count would stay above zero for a pane id that no
            # longer has a CLI behind it.
            subagent_tracker.reset(str(exit_pane_id))
        await ws_handlers.note_terminal_exit_async(payload)
    session_id = payload.get("terminal_session_id") if isinstance(payload, dict) else None
    if session_id and event.get("type") == "terminal.exit":
        sess = _PTY_OWNERS.pop(session_id, None)
        if sess is not None:
            # An ended onboarding run needs no kill on disconnect.
            sess._onboarding_runs.discard(session_id)
    else:
        sess = _PTY_OWNERS.get(session_id) if session_id else None
    if sess is None:
        return  # detached: drop output, PTY keeps running, TUI redraws on reattach
    try:
        await sess.send_json(event)
    except Exception as err:  # noqa: BLE001
        log.warning("terminal output send failed: %s", err)


def get_terminals() -> TerminalService:
    """The one app-level TerminalService. Lazy (not at import) because
    TerminalService.__init__ binds to the running event loop."""
    global _TERMINALS
    if _TERMINALS is None:
        _TERMINALS = TerminalService(emit=_active_emit)
    return _TERMINALS


def _claim_ptys(session: "Session", terminal_session_ids: list[str]) -> None:
    """Transfer ownership of the given PTY ids to `session`."""
    for tid in terminal_session_ids:
        _PTY_OWNERS[tid] = session
        quota_failover.note_pty_owner(tid, session)


# ── Ownerless-PTY janitor ────────────────────────────────────────────────────
# PTYs deliberately survive a WebSocket disconnect so a reloading renderer can
# reattach. But a renderer that never comes back (window closed for good, or
# a restore that spawned a REPLACEMENT PTY instead of reattaching) leaves the
# old PTY running detached forever — observed as a slow accumulation of idle
# `claude --resume` processes at 200-400MB each. The janitor kills a PTY only
# after it has had no owning WebSocket for a full grace period, which is far
# longer than any transient disconnect/reload.
_OWNERLESS_GRACE_SEC = 60 * 60.0
_OWNERLESS_SWEEP_INTERVAL_SEC = 5 * 60.0
# terminal_session_id → monotonic time it was first seen ownerless.
_OWNERLESS_SINCE: dict[str, float] = {}
_ownerless_sweeper_task: "asyncio.Task[None] | None" = None
_mem_probe_task: "asyncio.Task[None] | None" = None
_dev_time_sweeper_task: "asyncio.Task[None] | None" = None
_plugin_audit_task: "asyncio.Task[None] | None" = None


async def _sweep_ownerless_ptys_once(now: float | None = None) -> list[str]:
    """One janitor pass: kill live PTYs ownerless longer than the grace.
    Returns the killed terminal ids (for tests/logging)."""
    if _TERMINALS is None:
        return []
    now = time.monotonic() if now is None else now
    live = set(_TERMINALS.list_session_ids())
    # A PTY that died or got (re)claimed is no longer a candidate.
    for tid in list(_OWNERLESS_SINCE):
        if tid not in live or tid in _PTY_OWNERS:
            _OWNERLESS_SINCE.pop(tid, None)
    killed: list[str] = []
    for tid in live:
        if tid in _PTY_OWNERS:
            continue
        first_seen = _OWNERLESS_SINCE.setdefault(tid, now)
        if now - first_seen < _OWNERLESS_GRACE_SEC:
            continue
        _OWNERLESS_SINCE.pop(tid, None)
        log.info(
            "ownerless-pty janitor: killing terminal %s (no owner for %.0fs)",
            tid,
            now - first_seen,
        )
        await _TERMINALS.kill(tid, force=True)
        killed.append(tid)
    return killed


async def _ownerless_pty_janitor() -> None:
    while True:
        await asyncio.sleep(_OWNERLESS_SWEEP_INTERVAL_SEC)
        try:
            await _sweep_ownerless_ptys_once()
        except Exception as err:  # noqa: BLE001 — the janitor must survive
            log.warning("ownerless-pty sweep failed: %s", err)


# SessionStart is run at the first turn in Codex 0.154, not at TUI startup.
# It complements the existing path/marker detector; nothing waits for a hook.
from . import codex_session_hooks  # noqa: E402

_codex_pending_starts = codex_session_hooks.PendingStarts()


def _pane_for_guard_token(token: str) -> str:
    """The pane whose spawn environment carries this guard token, or ""."""
    if not token:
        return ""
    for terminal_id, owner in list(_PTY_OWNERS.items()):
        term = owner.terminals.get(terminal_id)
        if term and not term.closed and secrets.compare_digest(
            str(term.metadata.get("guard_pane_token") or ""), token
        ):
            return str(getattr(term, "pane_id", "") or "")
    return ""


def _live_codex_hook_terms() -> dict[str, Any]:
    live = {}
    for terminal_id, owner in list(_PTY_OWNERS.items()):
        term = owner.terminals.get(terminal_id)
        if term and not term.closed and term.agent_key == "codex":
            token = term.metadata.get("codex_launch_token")
            if token:
                live[str(token)] = term
    return live


async def _retry_codex_session_start(token: str) -> None:
    if not _codex_pending_starts.has_pending(token):
        return
    term = _live_codex_hook_terms().get(token)
    if term is None:
        return
    paths = _codex_pending_starts.paths(token)
    if not paths:
        paths = await asyncio.to_thread(
            _codex_pending_starts.find_paths, token,
            Path(term.metadata["codex_session_home"]),
        )
    for path in paths:
        await _on_session_file("codex", path)


async def _maybe_announce_session(usage: TokenUsage) -> None:
    """Codex/Antigravity/Grok/OpenCode: when a session file is first matched to its pane,
    tell the frontend so it can persist the id/path for resume-on-restart."""
    bound = None
    if usage.vendor == "codex" and _codex_pending_starts.has_pending():
        live = _live_codex_hook_terms()
        matched = await asyncio.to_thread(
            _codex_pending_starts.match, Path(usage.file_path),
            {token: (term.pane_id, term.cwd) for token, term in live.items()},
        )
        if matched:
            token, pane_id, resume_id = matched
            # Recheck after disk IO: a respawn may have replaced this process.
            term = _live_codex_hook_terms().get(token)
            current_id = term.metadata.get("codex_current_session_id") if term else None
            if term is None or current_id and current_id != resume_id:
                _codex_pending_starts.consume(token, resume_id)
                return
            if term:
                bound = attribution.bind_confirmed_session(
                    vendor="codex", pane_id=pane_id, resume_id=resume_id,
                    session_file=usage.file_path, session_id=usage.session_id,
                )
                if bound or attribution.pane_for_session(resume_id)[0] == pane_id:
                    _codex_pending_starts.consume(token, resume_id)
    if bound is None:
        bound = await asyncio.to_thread(attribution.maybe_announce_session, usage)
    if not bound:
        return
    pane_id = _current_pane_id(bound.pane_id)
    workspace_path = bound.workspace_path or usage.cwd

    def persist() -> None:
        project = project_store.record_detected_session(
            workspace_path, pane_id=pane_id, session_id=bound.resume_id,
        )
        spawn_history_store.patch_entry(
            workspace_path, pane_id, {"sessionId": bound.resume_id},
            seed=project.ui_spawn_history,
        )

    try:
        await asyncio.to_thread(persist)
    except OSError:
        # Keep the renderer's existing persistence path available if a local
        # write failed; a storage error must not suppress live discovery.
        log.exception("could not persist detected session for pane=%s", pane_id)
    if usage.vendor == "codex":
        # Record log-driven changes too (for example /clear). A delayed first
        # SessionStart must not put an earlier conversation back on the pane.
        for term in _live_codex_hook_terms().values():
            if term.pane_id == bound.pane_id:
                term.metadata["codex_current_session_id"] = bound.resume_id
    # Second tracking hook, for the vendors that cannot pin a session id at
    # spawn (they bind here, at first match) and for a pane that switches to
    # another session mid-life. terminal.create's hook covers the pinned-id
    # case; tracking the same session twice is a no-op.
    track_live_session(
        workspace_path=bound.workspace_path or usage.cwd,
        pane_id=bound.pane_id,
        vendor=usage.vendor,
        # The live bucket is keyed by the id the token sink passes through
        # (usage.session_id), which is not always the resume id announced here.
        session_id=usage.session_id,
        session_file=bound.session_file,
    )
    await broadcast(make_event("session.detected", {
        "vendor": usage.vendor,
        "pane_id": pane_id,
        "session_id": bound.resume_id,  # the id/path `<cli> resume` actually needs
        "workspace_path": bound.workspace_path or usage.cwd,
        "session_file": bound.session_file,
    }))


async def _on_session_file(vendor: str, path: Path) -> None:
    """Watcher session sink: a Codex/Antigravity/Grok/Kimi/OpenCode session file changed.
    Attempt marker binding directly off the file (decoupled from token parsing,
    so it works for session-file formats the token reader doesn't understand)."""
    reader = next((r for r in _readers if r.vendor == vendor), None)
    session_id = reader.session_id_from_path(path) if reader else path.stem
    if not session_id:
        return  # not a real session file (e.g. Kimi's state.json / logs)
    usage = TokenUsage(
        vendor=vendor, input_tokens=0, output_tokens=0,
        cwd=reader.cwd_from_file(path) if reader else "",
        session_id=session_id, file_path=str(path), dedup_key="",
    )
    await _maybe_announce_session(usage)


# Safety bound on the assistant turn text carried on turn_complete events. It
# only needs to keep a full turn (leading QUESTION block + trailing sentinel)
# intact; the cap is generous and, when exceeded, keeps BOTH ends so neither a
# head QUESTION block nor the last-line sentinel is lost. Long text rides once
# per turn (turn_complete); user-record agent_active events carry only a short
# prompt snippet (<= 500 chars), so this is not a per-line hot-path cost.
_ACTIVITY_TEXT_MAX_CHARS = 200_000


def _cap_activity_text(text: str) -> str:
    if len(text) <= _ACTIVITY_TEXT_MAX_CHARS:
        return text
    half = _ACTIVITY_TEXT_MAX_CHARS // 2
    return f"{text[:half]}\n…\n{text[-half:]}"


# Last agent-activity event per pane, for the Plan MCP server's cli_get_status
# / cli_wait_idle tools. Single most-recent entry per pane (not a history);
# text is kept only for turn_complete (agent_active only ever carries a short
# prompt snippet, not meant for replay outside pane naming).
_pane_activity: dict[str, dict[str, Any]] = {}
# Observers of the table above (chat channels): called as (pane_id, entry) on
# every record and (pane_id, None) when a closed pane is forgotten. Must not raise.
pane_activity_listeners: list[Callable[[str, dict[str, Any] | None], None]] = []
# Observers of the user's own prompts (chat channels): (pane_id, text) for every
# user-record event: the reader's longer copy when it has one (up to 16K chars),
# else the naming snippet. Must not raise.
pane_prompt_listeners: list[Callable[[str, str], None]] = []
_USER_PROMPT_DETAILS = frozenset({"user", "prompt", "user_message"})


def _current_pane_id(pane_id: str) -> str:
    """Where this pane's activity is filed.

    Writers identify the pane through session attribution, which records the id
    the PTY was created under, while readers (cli_get_status, cli_wait_idle) ask
    by the id the pane answers to now — a pane rebuilt around a live PTY (window
    reload, detach) has a newer one. Both go through here, so the two ends
    cannot drift apart: a read that skipped it would miss what a hook wrote, and
    a write that skipped it would be invisible to the tools.
    """
    return agent_messaging.resolve_alias(pane_id) or pane_id


def pane_activity(pane_id: str) -> dict[str, Any] | None:
    return _pane_activity.get(_current_pane_id(pane_id))


def _record_pane_activity(
    pane_id: str, event_type: str, text: str, *, detail: str = ""
) -> None:
    if not pane_id:
        return
    key = _current_pane_id(pane_id)
    now = time.monotonic()
    prior = _pane_activity.get(key)
    # When the turn this event belongs to began: the first agent_active after
    # the previous turn ended opens a turn, later events of the same turn
    # carry that start forward, and the turn_complete closes it. The account
    # failover reads the pair (start, complete) to tell a turn that ran
    # entirely under the new account from one that began under the old.
    if prior is not None and prior["event_type"] != "turn_complete":
        turn_started = prior.get("turn_started_monotonic", prior["ts_monotonic"])
    elif event_type == "turn_complete":
        # A turn end with no observed start (the reader saw only the end, or
        # the pane is new): when it began is unknown, not "now".
        turn_started = None
    else:
        turn_started = now
    _pane_activity[key] = {
        "event_type": event_type,
        # Same cap as the broadcast path — this dict must not become the one
        # place an unbounded turn_complete text is retained.
        "text": _cap_activity_text(text) if event_type == "turn_complete" else "",
        "ts_monotonic": now,
        "turn_started_monotonic": turn_started,
        # The reader's structured detail (a stop reason such as droid's
        # ``model_usage_exhausted``) — kept only for turn ends, bounded.
        "detail": (detail or "")[:200] if event_type == "turn_complete" else "",
    }
    for listener in pane_activity_listeners:
        listener(key, _pane_activity[key])


def forget_pane_activity(pane_id: str) -> None:
    """Drop a closed pane's entry so the cache tracks live panes only."""
    _pane_activity.pop(pane_id, None)
    for listener in pane_activity_listeners:
        listener(pane_id, None)
    hook_drain.forget_pane(pane_id)
    push_delivery.forget_pane(pane_id)
    portable_credentials.forget_launch(pane_id)
    forget_pane_live_sessions(pane_id)


async def _on_log_activity(event: ActivityEvent) -> None:
    """Sink for agent-activity events (agent_active / turn_complete).

    Broadcasts to all sessions so the frontend watcher can use these signals
    as supplemental "agent still working" / "turn ended" indicators that
    don't depend on TUI buffer scanning.
    """
    try:
        # Attribution was designed for TokenUsage but only reads vendor/cwd/
        # file_path/session_id. Wrap as a placeholder so we get pane mapping.
        fake_usage = TokenUsage(
            vendor=event.vendor, input_tokens=0, output_tokens=0,
            cwd=event.cwd, session_id=event.session_id,
            file_path=event.file_path, dedup_key=event.dedup_key,
            timestamp=event.timestamp,
        )
        attributed = attribution.attribute(fake_usage)
        if attributed.workspace_path is None:
            # External session — skip; no pane to deliver to.
            return
        pane_id = attributed.pane_id or ""
        # A turn a Stop hook blocked is still written to the conversation log,
        # and its reader reports it as a turn end — after the hook already said
        # the agent is working on the message it was handed. Flagged rather than
        # relabelled: everything this event carries (the turn's text, and the
        # MSG blocks, sentinels and pane name derived from it) is real and still
        # wanted. Only "the pane is free now" is wrong, so only that is dropped.
        superseded = event.event_type == "turn_complete" and hook_drain.turn_end_is_superseded(
            pane_id
        )
        _record_pane_activity(
            pane_id, "agent_active" if superseded else event.event_type, event.text,
            detail=event.detail,
        )
        if (
            event.event_type == "agent_active" and event.text and pane_id
            and event.detail in _USER_PROMPT_DETAILS
        ):
            for prompt_listener in pane_prompt_listeners:
                try:
                    prompt_listener(
                        _current_pane_id(pane_id), getattr(event.text, "full", "") or event.text
                    )
                except Exception as err:  # noqa: BLE001
                    log.warning("prompt listener failed: %s", err)
        if event.event_type == "turn_complete":
            # The per-account turn count (by_account_day / quota cycles): the
            # reader's turn end is the one signal every vendor emits, on the
            # transcript's own clock. A superseded turn still finished in
            # the log — only "the pane is free" is wrong about it.
            tokens_store.record_turn(
                event.vendor,
                pane_account_history.profile_at(
                    pane_id, parse_event_time(event.timestamp)
                ),
                event.timestamp,
            )
        await broadcast(make_event("agent.activity", {
            "vendor": event.vendor,
            "event_type": event.event_type,
            "superseded": superseded,
            "workspace_path": attributed.workspace_path,
            "pane_id": pane_id,
            "stage_id": attributed.stage_id or "",
            "session_id": event.session_id,
            "cwd": event.cwd,
            "timestamp": event.timestamp,
            "detail": event.detail,
            # Assistant turn text (turn_complete) for sentinel/question
            # judgment, or the user's prompt snippet (<= 500 chars) on
            # user-record agent_active events for pane naming. Bounded but
            # generous — see _ACTIVITY_TEXT_MAX_CHARS.
            "text": _cap_activity_text(event.text),
        }))
        if dev_time_store.agent_event(
            attributed.workspace_path, pane_id,
            "agent_active" if superseded else event.event_type, event.timestamp,
        ):
            await broadcast(make_event(
                "devtime.changed", {"workspace_path": attributed.workspace_path}
            ))
    except Exception as err:  # noqa: BLE001
        log.warning("activity sink failed: %s", err)


# A startup rescan of historical CLI logs emits thousands of token events in a
# burst; broadcasting a full workspace snapshot per event saturated the event
# loop and starved concurrent requests past the frontend's 10s timeout (real
# case: terminal.create timeouts during session restore, 2026-07-14). Coalesce
# to at most one broadcast per workspace per window; the trailing snapshot
# includes every record accumulated during the wait.
_TOKENS_BROADCAST_DEBOUNCE_SEC = 0.3
_pending_tokens_broadcast: set[str] = set()


def _schedule_tokens_broadcast(workspace_path: str) -> None:
    if workspace_path in _pending_tokens_broadcast:
        return
    _pending_tokens_broadcast.add(workspace_path)

    async def _fire() -> None:
        try:
            await asyncio.sleep(_TOKENS_BROADCAST_DEBOUNCE_SEC)
        finally:
            _pending_tokens_broadcast.discard(workspace_path)
        await broadcast(
            make_event("tokens.changed", tokens_store.snapshot(workspace_path))
        )
        changed = await asyncio.to_thread(quota_ledger.reconcile_pending, tokens_store)
        for agent, profile, kind in changed:
            await broadcast(make_event("tokens.quota_cycles_changed", {
                "agent_key": agent, "profile_id": profile, "window_kind": kind,
            }))
        if tokens_store.has_quota_changes():
            _schedule_tokens_broadcast(workspace_path)

    asyncio.create_task(_fire())


# ── live per-session token tally (read from the session log) ──────────────
#
# "THIS SESSION" used to be accumulated from the token events the watcher
# ingested during this process's lifetime, which made it wrong in three ways:
# a missed or deduped event was lost forever, a backend restart zeroed it, and
# a one-shot backfill patch had to argue with the accumulator. It is now
# derived instead: the vendor's session log IS the number. We keep, per
# tracked session, the last scan result plus the file identity it was taken
# from and the reader cursor to resume from, and refresh it when the file
# changes. Nothing survives a restart — nothing needs to, because the first
# scan re-derives the whole total straight from the file.
#
# Dedicated single-worker pool, NOT the shared default executor: a session
# file can be tens of MB and enumerating a vendor's session tree stats
# thousands of paths. Concurrent heavy work on the shared pool has starved
# backend startup three separate times (list_recent, onboarding, plugin
# activation) — max_workers=1 also serializes bursts of pane spawns.
_live_scan_pool = ThreadPoolExecutor(
    max_workers=1, thread_name_prefix="tokens-live-scan"
)

# (workspace_path, session_key) -> {vendor, session_id, session_file,
#   identity, size, mtime, cursor, totals, panes}. `panes` is the set of pane
# ids currently bound to the session; the entry (and its bucket) goes when the
# last one closes. Keyed on the SESSION, not the pane: a restored or respawned
# pane carries a new ephemeral id for the same session, and keying on the pane
# split one session into several buckets.
_live_scans: dict[tuple[str, str], dict[str, Any]] = {}
# Keys with a scan in flight — a burst of token events for one session must
# not queue one parse per event behind the single worker.
_live_scan_inflight: set[tuple[str, str]] = set()


def _empty_totals() -> dict[str, int]:
    return {"input": 0, "output": 0, "calls": 0}


def _resolve_session_log(
    reader, workspace_path: str, session_id: str, session_file: str
) -> Path | None:
    """The session's log file, or None when it does not exist yet."""
    path = Path(session_file) if session_file else None
    if path is not None and path.exists():
        return path
    if not session_id:
        return None
    # No usable hint from the caller (Claude pins its id at spawn, before any
    # file exists): find the file whose id matches, scoped to this workspace's
    # folder when the vendor's layout allows it.
    scoped = reader.session_files_for_workspace(workspace_path)
    candidates = scoped if scoped is not None else reader.session_files()
    path = next(
        (p for p in candidates if reader.session_id_from_path(p) == session_id),
        None,
    )
    return path if path is not None and path.exists() else None


def _scan_live_session(
    workspace_path: str, state: dict[str, Any]
) -> dict[str, Any] | None:
    """Re-derive one session's total from its log. Runs on the scan pool.

    Reads only the bytes/rows appended since the last scan when the file is
    the same one that merely grew; falls back to reading the whole source when
    there is no cursor yet, or when the file shrank or was replaced (rotation).
    Returns the new scan state, or None when there is nothing to read.
    """
    reader = next((r for r in _readers if r.vendor == state["vendor"]), None)
    if reader is None:
        return None
    session_id = state["session_id"]
    path = _resolve_session_log(
        reader, workspace_path, session_id, state["session_file"]
    )
    if path is None:
        return None  # brand-new session — its log does not exist yet
    try:
        st = path.stat()
    except OSError:
        return None
    identity = f"{st.st_dev}:{st.st_ino}"
    # Size is captured BEFORE the parse on purpose: a file that grows while we
    # read it then looks changed on the next cheap check, so the next scan
    # picks the remainder up instead of skipping it.
    grew_in_place = bool(
        state["cursor"]
        and state["identity"] == identity
        and st.st_size >= state["size"]
    )
    if grew_in_place:
        delta, cursor = reader.usage_since_for_session(
            path, session_id, state["cursor"], with_cache_read=True
        )
        totals = {
            field: state["totals"].get(field, 0) + delta[field]
            for field in ("input", "output", "calls", "cache_read")
        }
    else:
        totals, cursor = reader.usage_since_for_session(
            path, session_id, {}, with_cache_read=True
        )
    return {
        **state,
        "session_file": str(path),
        "identity": identity,
        "size": st.st_size,
        "mtime": st.st_mtime,
        "cursor": cursor,
        "totals": totals,
    }


def _live_log_changed(state: dict[str, Any]) -> bool:
    """Cheap on-loop test: is a rescan worth a thread? One os.stat, no parse."""
    if not state["session_file"] or not state["cursor"]:
        return True  # never scanned, or the log still has to be located
    try:
        st = os.stat(state["session_file"])
    except OSError:
        return True  # let the scan decide (rotated, moved, or gone)
    return (
        f"{st.st_dev}:{st.st_ino}" != state["identity"]
        or st.st_size != state["size"]
        or st.st_mtime != state["mtime"]
    )


def _schedule_live_scan(key: tuple[str, str], *, only_if_changed: bool = False) -> None:
    """Fire-and-forget rescan. Never awaited: `terminal.create` must ack
    without waiting for a multi-MB parse, and the panel just updates when the
    broadcast lands."""
    state = _live_scans.get(key)
    if state is None or key in _live_scan_inflight:
        return
    if only_if_changed and not _live_log_changed(state):
        return
    _live_scan_inflight.add(key)
    workspace_path, session_key = key

    async def _run() -> None:
        try:
            scanned = await asyncio.get_running_loop().run_in_executor(
                _live_scan_pool, _scan_live_session, workspace_path, dict(state)
            )
            if scanned is None:
                return
            current = _live_scans.get(key)
            if current is None:
                return  # the last pane closed while we were reading
            current.update(scanned)
            published = {
                field: scanned["totals"][field] for field in ("input", "output", "calls")
            }
            if tokens_store.set_live_total(workspace_path, session_key, published):
                _schedule_tokens_broadcast(workspace_path)
        except Exception as err:  # noqa: BLE001 — cosmetic tally, never fatal
            log.warning("live token scan failed for session=%s: %s", session_key, err)
        finally:
            _live_scan_inflight.discard(key)

    asyncio.create_task(_run())


def track_live_session(
    *,
    workspace_path: str,
    pane_id: str,
    vendor: str,
    session_id: str,
    session_file: str = "",
) -> None:
    """Track a pane's session log as the source of its live tally, and refresh
    it now. Safe to call repeatedly — every bind and every ingested token event
    for the session goes through here."""
    session_key = tokens_store.live_session_key(session_id, session_file)
    if not (workspace_path and pane_id and vendor and session_key):
        return
    key = (workspace_path, session_key)
    state = _live_scans.get(key)
    if state is None:
        state = _live_scans[key] = {
            "vendor": vendor,
            "session_id": session_id,
            "session_file": session_file,
            "identity": "",
            "size": -1,
            "mtime": -1.0,
            "cursor": {},
            "totals": _empty_totals(),
            "panes": set(),
        }
    elif session_file and not state["session_file"]:
        state["session_file"] = session_file
    state["panes"].add(pane_id)
    pane_account_history.bind_session(session_id, pane_id)
    _schedule_live_scan(key)


def pane_token_total(pane_id: str) -> dict[str, int] | None:
    """The live token totals of every session ``pane_id`` is bound to, summed;
    None when the pane has no tracked session. Read-only."""
    found = False
    total = _empty_totals()
    for state in list(_live_scans.values()):
        if pane_id and pane_id in state["panes"]:
            found = True
            for key, value in (state.get("totals") or {}).items():
                if isinstance(value, int):
                    total[key] = total.get(key, 0) + value
    return total if found else None


def refresh_live_scans(workspace_path: str) -> None:
    """os.stat sweep over a workspace's tracked sessions, rescanning only the
    logs that changed. Called from `tokens.snapshot` so the panel is
    self-correcting even when a watcher event never arrived."""
    if not workspace_path:
        return
    for key in [k for k in _live_scans if k[0] == workspace_path]:
        _schedule_live_scan(key, only_if_changed=True)


def forget_pane_live_sessions(pane_id: str) -> None:
    """Release a closed pane's claim on its sessions. The tally survives while
    another pane still holds the session — a restored pane resumes the same
    log under a new id, and dropping the numbers per pane is what made one
    session read as several."""
    if not pane_id:
        return
    for key in list(_live_scans):
        state = _live_scans[key]
        state["panes"].discard(pane_id)
        if not state["panes"]:
            _live_scans.pop(key, None)
            tokens_store.drop_live_session(*key)


async def scan_session_turns(
    *,
    pane_id: str = "",
    session_id: str = "",
    agent_key: str = "",
    include_calls: bool = False,
) -> dict[str, Any]:
    """Per-turn split of one session log, for `tokens.turns`.

    A pane resolves to its session through the live-scan registry — the same
    binding the "THIS SESSION" tally uses, so the turns are cut from the very
    file that tally reads. A bare session id is looked up there too, and
    outside the registry needs `agent_key` to pick the reader. The parse runs
    on the live-scan pool (single worker), never on the shared executor.

    Each turn is stamped with the account the session's pane was pinned to at
    the turn's start (pane account history); a session with no pane, or a
    turn from before the pane's first pin, reads "unknown".
    """
    workspace_path = ""
    session_file = ""
    vendor = agent_key
    found = next(
        (
            (key, state) for key, state in _live_scans.items()
            if (pane_id and pane_id in state["panes"])
            or (not pane_id and session_id and state["session_id"] == session_id)
        ),
        None,
    )
    account_pane = pane_id
    if found is not None:
        (workspace_path, _session_key), state = found
        vendor = state["vendor"]
        session_id = state["session_id"]
        session_file = state["session_file"]
        if not account_pane:
            # A bare session id: the pane currently bound to it (a session
            # has at most a handful; the newest binding names the account).
            bound = sorted(state["panes"])
            account_pane = bound[-1] if bound else ""
    # No pane, not in the registry, and nothing says which reader to try:
    # that is "no session to read", not an unknown vendor named "".
    if not session_id or not vendor:
        return {"ok": False, "error": "no-session"}
    reader = next((r for r in _readers if r.vendor == vendor), None)
    if reader is None:
        return {"ok": False, "error": "unknown-vendor", "detail": vendor}

    def _scan() -> tuple[Path, dict[str, Any]]:
        if workspace_path:
            path = _resolve_session_log(reader, workspace_path, session_id, session_file)
        else:
            path = next(
                (
                    p for p in reader.session_files()
                    if reader.session_id_from_path(p) == session_id and p.exists()
                ),
                None,
            )
        if path is None:
            raise FileNotFoundError(session_id)
        return path, tokens_store.turns_for(
            reader, path, session_id, include_calls=include_calls,
            profile_resolver=lambda started_at: pane_account_history.profile_for_session(
                session_id, account_pane, parse_event_time(started_at or "")
            ),
        )

    try:
        path, cut = await asyncio.get_running_loop().run_in_executor(_live_scan_pool, _scan)
    except FileNotFoundError:
        return {"ok": False, "error": "file-missing", "detail": session_id}
    except Exception as err:  # noqa: BLE001 — reported to the caller, never fatal
        log.warning("turn scan failed for session=%s: %s", session_id, err)
        return {"ok": False, "error": "scan-failed", "detail": str(err)}
    reply: dict[str, Any] = {"ok": True}
    if pane_id:
        reply["pane_id"] = pane_id
    reply.update({
        "session_id": session_id,
        "vendor": vendor,
        "file_path": str(path),
        **cut,
        "scanned_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    })
    return reply


def account_periods(
    agent_key: str, profile_id: str, granularity: str, *,
    range_start: str | None = None, range_end: str | None = None,
    window_kind: str | None = None, offset: int = 0, limit: int = 50, export: bool = False,
) -> dict[str, Any]:
    """`tokens.account_periods`: by_account_day rolled up to months or years
    per (agent, account), with the quota ledger's cycle counts joined in.
    Runs off-loop (the ledger reads SQLite)."""
    from .pane_account_history import parse_event_time

    wall = time.time()
    start = parse_event_time(str(range_start)) if range_start is not None else wall - 30 * 86400
    end = parse_event_time(str(range_end)) if range_end is not None else wall
    if start is None or end is None or start >= end:
        raise ValueError("invalid-range")
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 200:
        raise ValueError("invalid-page")
    if type(export) is not bool:
        raise ValueError("invalid-query")

    def iso(ts: float) -> str:
        return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z")

    def bounds(period: str) -> tuple[float, float]:
        year = int(period[:4])
        month = 1 if granularity == "year" else int(period[5:7])
        first = datetime(year, month, 1, tzinfo=timezone.utc)
        next_year, next_month = (year + 1, 1) if granularity == "year" or month == 12 else (year, month + 1)
        return first.timestamp(), datetime(next_year, next_month, 1, tzinfo=timezone.utc).timestamp()

    def selected(period: str) -> bool:
        first, last = bounds(period)
        return first < end and last > start

    rows: dict[tuple[str, str, str], dict[str, Any]] = {}
    for agent, profile, day, bucket in tokens_store.account_day_rows():
        if agent_key and agent != agent_key:
            continue
        if profile_id and profile != profile_id:
            continue
        period = day[:4] if granularity == "year" else day[:7]
        if not selected(period):
            continue
        row = rows.setdefault((period, agent, profile), {
            "period": period, "agent_key": agent, "profile_id": profile,
            "input": 0, "cache_read": 0, "cache_creation": 0, "output": 0,
            "total": 0, "calls": 0, "turns": 0,
            "cycles": 0, "exhausted": 0, "avg_total_exhausted": None,
            "weekly_exhausted": 0,
        })
        for field in ("input", "cache_read", "cache_creation", "output", "calls", "turns"):
            row[field] += int(bucket.get(field, 0))
        row["total"] = row["input"] + row["cache_read"] + row["cache_creation"] + row["output"]
    for key, stats in quota_ledger.period_stats(granularity, now=wall, window_kind=window_kind).items():
        period, agent, profile = key
        if agent_key and agent != agent_key:
            continue
        if profile_id and profile != profile_id:
            continue
        if not selected(period):
            continue
        row = rows.setdefault(key, {
            "period": period, "agent_key": agent, "profile_id": profile,
            "input": 0, "cache_read": 0, "cache_creation": 0, "output": 0,
            "total": 0, "calls": 0, "turns": 0,
            "cycles": 0, "exhausted": 0, "avg_total_exhausted": None,
            "weekly_exhausted": 0,
        })
        row.update({
            "cycles": stats["cycles"], "exhausted": stats["exhausted"],
            "avg_total_exhausted": stats["avg_total_exhausted"],
            "weekly_exhausted": stats["weekly_exhausted"],
            "eligible_count": stats["eligible_count"], "excluded_count": stats["excluded_count"],
            "exclusions": stats["exclusions"],
        })
    if len(rows) > 10000:
        raise ValueError("range-too-large")
    # period newest first, then total descending within a period
    ordered = sorted(rows.values(), key=lambda r: (-r["total"], r["agent_key"], r["profile_id"]))
    ordered.sort(key=lambda r: r["period"], reverse=True)
    totals: dict[str, dict[str, Any]] = {}
    for row in ordered:
        entry = totals.setdefault(row["period"], {
            "period": row["period"], "total": 0, "calls": 0, "turns": 0,
        })
        entry["total"] += row["total"]
        entry["calls"] += row["calls"]
        entry["turns"] += row["turns"]
    fields = ("input", "cache_read", "cache_creation", "output", "total", "calls", "turns")
    for row in ordered:
        first, last = bounds(row["period"])
        known = first >= tokens_store.slices_since
        state = "available" if known else (
            "partial" if min(last, wall) > tokens_store.slices_since else "unavailable"
        )
        row.update({
            "period_start": iso(first), "period_end": iso(last),
            "coverage_state": state, "coverage_reason": None if known else "collection_started_late",
            "detail_known": known, "recorded_totals": {f: row[f] for f in fields},
        })
        row.setdefault("eligible_count", 0)
        row.setdefault("excluded_count", 0)
        row.setdefault("exclusions", {k: 0 for k in ("ongoing", "no_limit", "untrusted_source", "unavailable_detail")})
        if not known:
            row.update({f: None for f in fields})
    for entry in totals.values():
        components = [r for r in ordered if r["period"] == entry["period"]]
        known = all(r["detail_known"] for r in components)
        entry.update({
            "detail_known": known,
            "coverage_state": "available" if known else (
                "unavailable" if all(r["coverage_state"] == "unavailable" for r in components) else "partial"
            ),
            "coverage_reason": None if known else "collection_started_late",
            "recorded_totals": {f: entry[f] for f in ("total", "calls", "turns")},
            "period_start": components[0]["period_start"], "period_end": components[0]["period_end"],
        })
        if not known:
            entry.update({f: None for f in ("total", "calls", "turns")})
    eligible = sum(r["eligible_count"] for r in ordered)
    summary = {
        "cycles": sum(r["cycles"] for r in ordered),
        "exhausted": sum(r["exhausted"] for r in ordered),
        "weekly_exhausted": sum(r["weekly_exhausted"] for r in ordered),
        "eligible_count": eligible, "excluded_count": sum(r["excluded_count"] for r in ordered),
        "avg_total_exhausted": sum((r["avg_total_exhausted"] or 0) * r["eligible_count"] for r in ordered) / eligible if eligible else None,
        "exclusions": {k: sum(r["exclusions"][k] for r in ordered)
                       for k in ("ongoing", "no_limit", "untrusted_source", "unavailable_detail")},
    }
    page = ordered if export else ordered[offset:offset + limit]
    effective_start = bounds(datetime.fromtimestamp(start, timezone.utc).strftime("%Y" if granularity == "year" else "%Y-%m"))[0]
    effective_end = bounds(datetime.fromtimestamp(end - 0.000001, timezone.utc).strftime("%Y" if granularity == "year" else "%Y-%m"))[1]
    return {
        "ok": True,
        "schema_version": 2, "calendar_timezone": "UTC", "token_time_key": "event_time",
        "cycle_time_key": "started_at_or_resets_at", "refreshed_at": iso(wall),
        "granularity": granularity,
        "rows": page, "summary": summary, "total_count": len(ordered),
        "next_offset": offset + len(page) if not export and offset + len(page) < len(ordered) else None,
        "range_start": iso(start), "range_end": iso(end), "export": export,
        "effective_range_start": iso(effective_start), "effective_range_end": iso(effective_end),
        "totals_by_period": sorted(
            totals.values(), key=lambda t: t["period"], reverse=True
        ),
    }


# Historic-log backfill can enqueue hundreds of files; coalesce the per-file
# progress into at most one broadcast per workspace per window (same lesson as
# the token burst above) so the indicator updates smoothly without flooding.
_BACKFILL_BROADCAST_DEBOUNCE_SEC = 0.3
_pending_backfill_broadcast: set[str] = set()
_backfill_remaining: dict[str, int] = {}


def _on_backfill_progress(workspace_path: str, remaining: int) -> None:
    """LogWatcher progress_sink (runs on the loop): remember the latest count and
    debounce-broadcast `backfill.changed` so the UI can show a small status."""
    _backfill_remaining[workspace_path] = remaining
    if workspace_path in _pending_backfill_broadcast:
        return
    _pending_backfill_broadcast.add(workspace_path)

    async def _fire() -> None:
        try:
            await asyncio.sleep(_BACKFILL_BROADCAST_DEBOUNCE_SEC)
        finally:
            _pending_backfill_broadcast.discard(workspace_path)
        count = _backfill_remaining.get(workspace_path, 0)
        await broadcast(make_event("backfill.changed", {
            "workspace_path": workspace_path,
            "active": count > 0,
            "count": count,
        }))

    asyncio.create_task(_fire())


async def _on_log_token_usage(usage: TokenUsage) -> TokenSinkResult:
    """Sink for token events from CLI log files.

    Drops events not associated with any registered Agent-Team workspace so
    the All-time tally only counts usage in workspaces the user has actually
    opened in Agent-Team. Passes the event's dedup_key to tokens_store so
    re-rescans after workspace registration don't double-count.
    """
    try:
        attributed = attribution.attribute(usage)
        if usage.replay_workspace:
            if attributed.workspace_path != usage.replay_workspace:
                # Shared sources (notably Grok's single SQLite DB) contain rows
                # for many workspaces. This row is safely consumed for the
                # target workspace, but must not be attributed or retried.
                return TokenSinkResult(True)
            workspace_path = usage.replay_workspace
        else:
            workspace_path = attributed.workspace_path
        if workspace_path is None:
            # External session — outside any registered workspace. Skip silently.
            return TokenSinkResult(False)
        # Namespace the dedup key by vendor + file_path so collisions across
        # vendors (unlikely but possible) can't masquerade as the same event.
        composite_key = f"{usage.vendor}::{usage.file_path}::{usage.dedup_key}"
        # The account this usage was made on: whatever the pane was pinned to
        # at the event's own time (a resumed transcript's old turns belong to
        # whoever ran them, not to the pane resuming it now). No pane, or no
        # interval covering that moment → "unknown".
        usage.profile_id = pane_account_history.profile_at(
            attributed.pane_id or "", parse_event_time(usage.timestamp)
        )
        handled = tokens_store.record(
            workspace_path,
            source="cli",
            vendor=usage.vendor,
            agent_key=usage.vendor,
            # Prefer stable slot_key as the by_pane bucket so data survives
            # frontend restarts; fall back to ephemeral pane_id for manual panes.
            pane_id=attributed.slot_key or attributed.pane_id,
            session_id=usage.session_id,
            stage_id=attributed.stage_id,
            group_id=attributed.group_id,
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            dedup_key=composite_key,
            ingestion_file=usage.file_path,
            ingestion_checkpoint=usage.checkpoint,
            replay_workspace=usage.replay_workspace,
            legacy_dedup_key=usage.dedup_key,
            profile_id=usage.profile_id,
            cli_version=usage.cli_version,
            cache_read_tokens=usage.cache_read_tokens,
            cache_creation_tokens=usage.cache_creation_tokens,
            timestamp=usage.timestamp,
        )
        # The watcher just told us this session's log grew — the cheapest and
        # most timely rescan trigger there is, since it already carries the
        # vendor, the session id and the attributed workspace/pane. Skipped for
        # a replay pass, which walks historic files nobody has a pane on.
        if not usage.replay_workspace and attributed.pane_id:
            track_live_session(
                workspace_path=workspace_path,
                pane_id=attributed.pane_id,
                vendor=usage.vendor,
                session_id=usage.session_id,
                session_file=usage.file_path,
            )
        _schedule_tokens_broadcast(workspace_path)
        return TokenSinkResult(handled, workspace_path)
    except Exception as err:  # noqa: BLE001
        log.warning("log token sink failed: %s", err)
        return TokenSinkResult(False)


def _stable_pane_key(metadata: dict, fallback: str) -> str:
    """Return a key for tokens_store.by_pane that survives frontend restarts.

    Pipeline panes use "<stage_id>:<slot_label>" (e.g. "01:architect") so the
    key is deterministic across sessions. Manual panes (no stage/slot) fall
    back to the ephemeral pane UUID — they don't persist across restarts anyway.
    """
    stage = str(metadata.get("stage_id") or metadata.get("stageId") or "").strip()
    slot  = str(metadata.get("slot_label") or "").strip()
    if stage and slot:
        return f"{stage}:{slot}"
    if stage:
        return stage
    return fallback


def _register_workspace_and_backfill(workspace_path: str) -> None:
    """Idempotent: associate the workspace with its CLI folders AND trigger a
    one-shot LogWatcher re-rescan so historic sessions in those folders get
    retroactively counted into the workspace's cumulative."""
    if not workspace_path:
        return
    is_new = workspace_path not in attribution.known_workspaces()
    attribution.register_workspace(workspace_path)
    # Provision plan-document infrastructure (_spec.md + _template.html) into
    # <workspace>/.agent-team/plans/. Idempotent, never overwrites, never
    # raises — see plan_provisioning. Not while the user has Plans disabled.
    if not plans_plugin_disabled():
        ensure_plan_assets(workspace_path)
    # Start watching for disk changes here rather than waiting for the GitPane's
    # first `git.status`: the watcher is the only catch-all writer of the
    # preview record, and until this call it never saw a workspace nobody had
    # opened Git on. Idempotent, and a no-op before start().
    if _git_watcher is not None:
        _git_watcher.watch(workspace_path)
    if is_new and _log_watcher is not None:
        # New association → parse from this workspace's independent checkpoint
        # so cumulative populates without double-counting Global. Scope to THIS
        # workspace so we don't
        # re-parse the entire (multi-GB) Claude history and stall the loop.
        #
        # force_rescan still enumerates session files synchronously (Codex
        # readers fall back to ALL their files), which blocks the event
        # loop and stalls every terminal.create queued behind it. Run it
        # off-loop so spawns return immediately; the rescan only backfills
        # stats, so its timing isn't on the critical path.
        watcher = _log_watcher
        try:
            asyncio.get_running_loop().run_in_executor(
                None, watcher.force_rescan, workspace_path
            )
        except RuntimeError:
            # No running loop (non-async caller) — fall back to inline.
            watcher.force_rescan(workspace_path)


_INHERITED_CLI_HOME_VARS = (
    "GROK_HOME",
    # Not home relocators, but the same inheritance hazard with a worse
    # failure mode: runtime markers a CLI stamps on its own subprocesses.
    # Claude Code's child-session marker makes an inheriting pane skip
    # transcript saving (observed: `pnpm dev` launched from a claude pane —
    # the pane works all day and restores as a blank after restart). Grok's
    # child markers are the same shape, stripped preemptively; they are
    # process-lifecycle flags no user config legitimately sets.
)


def _inherited_cli_home_vars() -> tuple[str, ...]:
    """Legacy table plus every migrated vendor's declared home vars. A var a
    vendor's round moves into its spec is deleted from the tuple above; until
    every round lands, the union covers both."""
    from .cli_vendors.registry import VENDORS

    merged = dict.fromkeys(_INHERITED_CLI_HOME_VARS)
    for spec in VENDORS.values():
        merged.update(dict.fromkeys(spec.home_env_vars))
    return tuple(merged)


def spawn_env_deny_list() -> frozenset[str]:
    """Env var names a spawn REQUEST may not set.

    The existing lists are all removal lists — things stripped on the way out.
    This is the one input filter, and it is deliberately their union rather
    than a fourth rule, so a var can never be denied here and allowed there:

    * ``CLAUDE_ENV_OVERRIDES`` — API-key vars that displace a managed
      account's OAuth login.
    * ``_inherited_cli_home_vars()`` — the legacy table plus every vendor's
      declared home/config relocators and runtime markers, i.e. exactly what
      is stripped from the backend's own inherited environment.

    ``cli_vendors.claude._ENV_DROP`` needs no third source: its three names
    (the two above plus CLAUDE_CONFIG_DIR, which is in claude's
    ``home_env_vars``) are already covered by the union.
    """
    return frozenset(CLAUDE_ENV_OVERRIDES) | frozenset(_inherited_cli_home_vars())


def filter_spawn_env_request(requested: dict[str, str]) -> tuple[dict[str, str], list[str]]:
    """Soft-block: drop the denied keys, keep the rest, name what was dropped.

    Soft because the spawn still goes ahead — a user-configured env var that
    happens to collide with a home relocator is a misconfiguration to report,
    not a reason to refuse the pane.

    Names are compared the way the platform's process environment compares
    them (``osplat.paths.env_name_key``): on Windows ``minimax_data_dir``
    sets MINIMAX_DATA_DIR and is denied as such, while on POSIX it is a
    different variable and passes. ``denied`` names the key as requested, so
    the notice shows the user what they typed.
    """
    fold = osplat.paths.env_name_key
    deny = {fold(name) for name in spawn_env_deny_list()}
    denied = [key for key in requested if fold(key) in deny]
    kept = {key: value for key, value in requested.items() if key not in denied}
    return kept, denied


def spawn_env_overridden_keys(
    requested: dict[str, str],
    final_env: dict[str, str],
    env_remove: list[str] | None,
) -> list[str]:
    """Requested keys that a later source in the spawn chain went on to win.

    Answerable only once the whole chain has run: vendor defaults, onboarding,
    login profiles, CLI home management, MCP/plugin/push wiring and portable
    credentials all write after the request, and ``env_remove`` — applied last
    of all, in ``terminals.spawn`` — can still delete a key that survived them.
    """
    removed = set(env_remove or ())
    return sorted(
        key for key, value in requested.items()
        if key in removed or final_env.get(key) != value
    )


def _sanitize_inherited_cli_env() -> None:
    """Drop CLI home-relocating vars inherited from whatever launched us.

    The account design assumes every CLI reads its real home; an inherited
    relocation (e.g. `pnpm dev` run from a pane that still carried
    CLAUDE_CONFIG_DIR) would silently poison every spawned pane and
    log-reader scan with a home nobody's sessions live in.
    """
    for key in _inherited_cli_home_vars():
        if os.environ.pop(key, None) is not None:
            log.info("dropped inherited %s from backend environment", key)


async def _reclaim_orphan_codex_homes() -> None:
    """Startup sweep of ``~/.codex-panes``: closed panes and failed spawns
    accumulated one home each with nothing to resume (#121). Every removal
    goes through ``CodexHomeManager.reclaim``, which keeps any home that
    still holds a rollout."""
    started = time.monotonic()
    try:
        reclaimed = await asyncio.to_thread(codex_home_manager.sweep_orphans)
    except Exception as err:  # noqa: BLE001
        log.warning("codex pane home sweep failed: %s", err)
        return
    if reclaimed:
        log.info(
            "reclaimed %d orphan codex pane home(s) in %.0fms: %s",
            len(reclaimed), (time.monotonic() - started) * 1000,
            " ".join(reclaimed),
        )


@app.on_event("startup")
async def _start_log_watcher() -> None:
    _sanitize_inherited_cli_env()
    # Before any client connects: every spawn record stamps this launch, and the
    # renderer's 'auto' resume scope compares against the one before it.
    launch_id.rotate(ui_settings_store)
    if tokens_store.has_quota_changes():
        _schedule_tokens_broadcast("")

    # Push channels read the user's per-vendor switches through this rather
    # than importing the settings store, which imports back into here.
    push_delivery.set_disabled_reader(
        lambda: set(
            ui_settings_store.get().get(push_delivery.DISABLED_SETTING_KEY) or []
        )
    )
    # Settings → Resource limits, for code with no handle on the store
    # (terminals marks new panes for the leftover-server list).
    resource_limits.set_settings_reader(lambda: ui_settings_store.get())
    # Per-pane watch files hold message text in the clear and belong to panes
    # that died with the previous process. Only a startup sweep ever removes
    # the ones a killed backend left behind.
    try:
        await asyncio.to_thread(push_delivery.sweep_runtime_files)
    except Exception as err:  # noqa: BLE001
        log.warning("push watch-file sweep failed: %s", err)

    # One-time data protection on a version upgrade: back up the persisted JSON
    # stores and forward-migrate their schema. Idempotent and best-effort —
    # run_startup_migrations never raises, so it can't block startup. File I/O
    # runs off the event loop.
    try:
        await asyncio.to_thread(run_startup_migrations)
    except Exception as err:  # noqa: BLE001
        log.warning("store backup/migration failed: %s", err)

    # One-time: fold legacy isolated claude profile homes back into the real
    # home (session logs + credential harvest). Idempotent — migrated homes
    # are archived, so a restart finds nothing to do. Runs before the log
    # watcher starts so the merged sessions are in its very first scan.
    try:
        await asyncio.to_thread(
            migrate_legacy_claude_homes, cli_profiles_store, credential_vault
        )
    except Exception as err:  # noqa: BLE001
        log.warning("legacy CLI profile home migration failed: %s", err)

    # One-time promotion of credentials still living in legacy per-profile
    # isolated homes into their slots (+ the live location for the active
    # account). Idempotent; background task — credential I/O must never block
    # startup.
    asyncio.create_task(
        credential_vault.promote_profile_home_secrets(cli_profiles_store)
    )

    # Sweep leftover isolated login homes into their slots, independently of
    # the usage poller (which only harvests while usage polling is enabled).
    # Background task — credential I/O must never block startup.
    from .usage_service import sweep_pending_login_homes

    asyncio.create_task(sweep_pending_login_homes())

    # Reap PTY children left behind by a previous run that died without its
    # shutdown sweep (SIGKILL, crash). Blocking ps/sleep — off the loop.
    try:
        await asyncio.to_thread(in_data_dir(app_data_dir(), pty_registry.reap_stale))
    except Exception as err:  # noqa: BLE001
        log.warning("pty orphan reap failed: %s", err)

    # Codex pane homes nothing can resume from (#121). Awaited, after the
    # reap above and before any renderer can connect: no pane is live, so a
    # home is kept only because it still owns a rollout.
    await _reclaim_orphan_codex_homes()

    # Kill PTYs whose owning WebSocket never came back (see janitor above).
    global _ownerless_sweeper_task
    _ownerless_sweeper_task = asyncio.create_task(_ownerless_pty_janitor())

    # Watch the pymalloc arena high-water mark. Silent until it steps up, so
    # a retained-memory report can name the event instead of only the total.
    global _mem_probe_task
    _mem_probe_task = asyncio.create_task(mem_probe.probe_loop())

    # Close dev-time intervals nobody is beating any more (see DevTimeStore).
    global _dev_time_sweeper_task
    _dev_time_sweeper_task = asyncio.create_task(dev_time_store.stale_sweeper(
        lambda ws: broadcast(make_event("devtime.changed", {"workspace_path": ws}))
    ))

    # Navide plugin audit: flush queued rows every second, prune hourly.
    global _plugin_audit_task
    _plugin_audit_task = asyncio.create_task(plugin_audit_log.run())

    # Navide's in-process scheduler (timed messages to CLI panes). Built off
    # the loop: its first use runs the schema migration.
    from . import scheduler

    try:
        await (await asyncio.to_thread(scheduler.get_service)).start()
    except Exception as err:  # noqa: BLE001
        log.warning("scheduler startup failed: %s", err)

    # Each workspace's self-evolution: its watchdog notices runs that ran past
    # their time or budget, and runs a missed slot once its workspace opens.
    from . import evolve_service

    try:
        await evolve_service.get_service().start()
    except Exception as err:  # noqa: BLE001
        log.warning("evolve startup failed: %s", err)

    # Name a frozen backend the moment it freezes: a daemon thread logs the
    # loop thread's stack when the loop stops turning (issue #24), instead of
    # the freeze being reproducible only under sample(1).
    loop_watchdog.start(asyncio.get_running_loop())
    # Exceptions nobody retrieved (a create_task without a done-callback)
    # reached only stderr; record them in the error ledger as well.
    error_ledger.install_loop_handler(asyncio.get_running_loop())
    # Guard events raised in hook worker threads are handed back to this loop.
    guard_runtime.remember_loop(asyncio.get_running_loop())

    global _log_watcher
    _log_watcher = LogWatcher(
        sink=_on_log_token_usage,
        activity_sink=_on_log_activity,
        session_sink=_on_session_file,
        # Scope periodic/startup scanning to workspaces that have a pane right
        # now. known_workspaces() — every workspace ever opened, never pruned —
        # meant a cold start re-parsed the whole multi-GB CLI history and
        # broadcast an agent.activity per entry: measured at ~800k messages over
        # two minutes with the backend pegged at a core.
        workspace_provider=attribution.active_workspaces,
        # Token/usage ingestion shares that scope on purpose: usage is counted
        # for what Navide is watching and nothing else. A CLI run while Navide
        # was closed, or in a workspace with no live pane, is not counted — a
        # product decision, so that the ledger never depends on re-walking a
        # multi-GB history nobody asked to be re-read.
        checkpoint_provider=tokens_store.get_ingestion_checkpoint,
        checkpoint_sink=tokens_store.advance_ingestion_checkpoint,
        progress_sink=_on_backfill_progress,
    )
    for r in _readers:
        _log_watcher.add_reader(r)
    _log_watcher.start()

    # Git filesystem watcher: fires `git.changed` near-instantly when the
    # working tree or `.git` state changes on disk (external edits, another
    # terminal running git). Workspaces are registered lazily on first
    # git.status — see the WebSocket handler.
    global _git_watcher
    _git_watcher = GitWatcher(_broadcast_git_changed, on_plans_change=_broadcast_plans_changed)
    _git_watcher.start()

    # CLI credential watcher: a sign-in outside Navide (a plain `claude /login`)
    # rewrites the live credentials without touching the profile ledger. This
    # notices the new identity and re-points `defaults[agentKey]` at the account
    # that is actually live — no credential is ever moved.
    global _credential_watcher
    _credential_watcher = CredentialWatcher(reconcile_live_account, resolver=managed_watch_path)
    _credential_watcher.start()

    # Navide-Server control-plane link: dials out to the configured server and
    # publishes this machine's pane roster so agents on other devices can
    # address it. Does nothing at all when no server URL / access token is
    # configured, which is every single-machine install.
    await server_link.start()
    # Chat channels (Telegram, Discord, ...): adapters start in the background.
    await channels.start()

    # Start MCP servers in the background so they're ready for the first pipeline run.
    asyncio.create_task(mcp_manager.startup())

    # Best-effort install of every vendor's CLI hooks, pointing them at this
    # backend for reliable "agent active / turn complete / parked on a prompt"
    # signals that buffer scanning cannot give. Each installer no-ops when its
    # CLI's config root is absent, and failure is non-fatal — the orchestrator
    # falls back to log-tail + sentinel detection. Each is the convenience
    # feature "<cli>.hooks": announced when it changes a file, skipped when the
    # user turned it off or deleted the hooks by hand.
    convenience_wiring.remember_loop(asyncio.get_running_loop())
    # Claude's hooks ride on the panes Navide starts (--settings), not on the
    # user's ~/.claude/settings.json; registered before the pass that moves them
    # (the CLI hooks pass below, after the plugins).
    from . import claude_hooks

    convenience_wiring.register_pane_carrier("claude", claude_hooks.prepare_pane_settings)

    # Backend plugin host: load and activate only bundled legacy v1 plugins.
    # The Host-bound Manifest v2 activation catalog is validated by the wiring
    # layer, but its packaged binaries await the Electron-owned child-process
    # supervisor and are never imported into this Python service. Guarded —
    # plugins must never block startup; per-plugin/per-hook failures are
    # isolated inside the wiring layer.
    try:
        activated = await asyncio.to_thread(plugin_wiring.startup, plugin_host)
        if activated:
            log.info("backend plugins activated: %s", activated)
        # Before the server starts: its session manager snapshots the tool
        # registry, so a tool installed afterwards is missing from the list
        # clients see, with no error anywhere.
        contributed = plugin_wiring.apply_mcp_tools(plugin_host, mcp_server.server)
        if contributed:
            log.info("plugins contributing MCP tools: %s", contributed)
        plugin_wiring.apply_routes(plugin_host, app.router)
        await plugin_wiring.run_startup_hooks(plugin_host)
    except Exception as err:  # noqa: BLE001
        log.warning("plugin host startup failed: %s", err)

    # The CLI hooks pass (see above), after the plugins: Copilot's hooks ride
    # on the pane shims the skills plugin builds (copilot_hooks), and fall
    # back to the shared file when that plugin is not running.
    from . import copilot_hooks

    convenience_wiring.register_pane_carrier("copilot", copilot_hooks.prepare_pane_hooks)
    convenience_wiring.install_cli_hooks(str(backend_port_file()))

    # Navide's own MCP server. Deliberately outside the guard above: this is
    # the endpoint every CLI pane is wired to, and it must come up even if
    # every plugin failed to load. A Route, not a Mount — a Mount would
    # 307-redirect the slashless path and some MCP clients drop the body.
    from starlette.routing import Route

    try:
        app.router.routes.append(
            Route(
                mcp_server.ROUTE_PATH,
                endpoint=mcp_server.asgi_app,
                methods=mcp_server.ROUTE_METHODS,
            )
        )
        await mcp_server.startup()
    except Exception as err:  # noqa: BLE001
        log.warning("MCP server startup failed: %s", err)
    try:
        await asyncio.to_thread(mcp_server_wiring.write_claude_config_for_current_port)
    except Exception as err:  # noqa: BLE001
        log.warning("claude mcp-config refresh failed: %s", err)


@app.on_event("shutdown")
async def _stop_log_watcher() -> None:
    global _log_watcher, _git_watcher, _credential_watcher
    try:
        await cli_risk_service.close()
        if _ownerless_sweeper_task is not None:
            _ownerless_sweeper_task.cancel()
        if _mem_probe_task is not None:
            _mem_probe_task.cancel()
        if _dev_time_sweeper_task is not None:
            _dev_time_sweeper_task.cancel()
        if _plugin_audit_task is not None:
            # Cancelling runs its final flush; wait for it so queued rows land.
            _plugin_audit_task.cancel()
            await asyncio.gather(_plugin_audit_task, return_exceptions=True)
        from . import scheduler

        await scheduler.shutdown()
        from . import evolve_service

        await evolve_service.shutdown()
        from . import voice_handlers

        await voice_handlers.shutdown()
        await loop_watchdog.stop()
        # PTY children are detached process groups (start_new_session=True); they
        # must be killed here or they outlive the app as CPU-spinning orphans.
        # Guarded so a sweep failure never skips the watcher/MCP teardown below.
        if _TERMINALS is not None:
            try:
                await _TERMINALS.kill_all()
            except Exception as err:  # noqa: BLE001
                log.warning("pty shutdown sweep failed: %s", err)
        if _log_watcher is not None:
            # Settle what the drain has read but not yet counted, BEFORE stop()
            # cancels the flush task that would have done it. See
            # LogWatcher.drain_pending_tokens.
            await _log_watcher.drain_pending_tokens()
            _log_watcher.stop()
        try:
            tokens_store.flush()
        except Exception as err:  # noqa: BLE001
            log.warning("token store shutdown flush failed: %s", err)
        try:
            dev_time_store.shutdown()
        except Exception as err:  # noqa: BLE001
            log.warning("dev time store shutdown failed: %s", err)
        if _git_watcher is not None:
            _git_watcher.stop()
        if _credential_watcher is not None:
            _credential_watcher.stop()
        await channels.stop()
        await server_link.stop()
    finally:
        # Delivered message keys still in the batch: written now, or a message
        # received just before a normal restart could be replayed after it.
        # After channels and the link stop, since they record keys until then,
        # and in a finally so no earlier step that raises can skip it (R2-1).
        try:
            from . import trust_store

            trust_store.flush_seen_messages()
        except Exception as err:  # noqa: BLE001
            log.warning("delivered-message ledger shutdown flush failed: %s", err)
    await mcp_manager.shutdown()
    log.info("shutdown: MCP clients stopped")
    try:
        await plugin_wiring.run_shutdown_hooks(plugin_host)
    except Exception as err:  # noqa: BLE001
        log.warning("plugin shutdown hooks failed: %s", err)
    log.info("shutdown: plugin hooks done")
    try:
        await mcp_server.shutdown()
    except Exception as err:  # noqa: BLE001
        log.warning("MCP server shutdown failed: %s", err)
    log.info("shutdown: MCP server stopped")
    try:
        plugin_wiring.shutdown(plugin_host)
    except Exception as err:  # noqa: BLE001
        log.warning("plugin host shutdown failed: %s", err)
    log.info("shutdown: plugin host stopped")
    try:
        guard_runtime.flush()
    except Exception as err:  # noqa: BLE001
        log.warning("guard audit flush failed: %s", err)
    log.info("shutdown: guard audit flushed")
    # Last: nothing may touch the databases after this point.
    try:
        workspace_databases.close_all()
    except Exception as err:  # noqa: BLE001
        log.warning("workspace database close failed: %s", err)
    log.info("shutdown: workspace databases closed")
    try:
        database.close()
    except Exception as err:  # noqa: BLE001
        log.warning("database close failed: %s", err)
    log.info("shutdown: database closed")
    _log_watcher = None
    _git_watcher = None
    _credential_watcher = None


def _default_pool_reading(loop: asyncio.AbstractEventLoop) -> dict[str, int]:
    """The shared default executor's size and backlog. It is created lazily,
    so before the first to_thread it reads as empty. Private attributes of
    ThreadPoolExecutor — read-only, and the caller drops the reading on error."""
    executor = getattr(loop, "_default_executor", None)
    if executor is None:
        return {"threads": 0, "max_workers": 0, "queued": 0}
    return {
        "threads": len(executor._threads),  # noqa: SLF001
        "max_workers": int(executor._max_workers),  # noqa: SLF001
        "queued": int(executor._work_queue.qsize()),  # noqa: SLF001
    }


async def _loop_lag_ms(loop: asyncio.AbstractEventLoop) -> float:
    """How long a callback waits behind the work already queued on the loop."""
    started = time.monotonic()
    ran = loop.create_future()
    loop.call_soon(ran.set_result, None)
    await ran
    return round((time.monotonic() - started) * 1000, 3)


@app.get("/health")
async def health() -> dict[str, Any]:
    # backend_log is deliberately absent: the absolute path carries the account
    # name, and this is the one route that answers without a credential. The
    # clients that need it read it from the ws settings.paths reply instead.
    body: dict[str, Any] = {
        "status": "ok",
        "version": __version__,
        "started_at": STARTED_AT,
    }
    # A load reading for diagnosing starvation. Measuring must never cost the
    # route its answer, so any failure just leaves the block out.
    try:
        loop = asyncio.get_running_loop()
        body["diagnostics"] = {
            "loop_lag_ms": await _loop_lag_ms(loop),
            "default_pool": _default_pool_reading(loop),
        }
    except Exception as err:  # noqa: BLE001 — fail open
        log.debug("health diagnostics unavailable: %s", err)
    return body


# Font mimes served inline (specimen @font-face fetch, /fs/page subresources).
_FONT_MIMES = ("font/ttf", "font/otf", "font/woff", "font/woff2")
# Windows' mimetypes table (the registry) knows none of these, so
# `guess_type` would hand every font to the octet-stream branch there.
for _mime, _ext in zip(_FONT_MIMES, (".ttf", ".otf", ".woff", ".woff2")):
    mimetypes.add_type(_mime, _ext)


def _serve_workspace_file(workspace: str, rel: str, *, allow_css: bool = False) -> FileResponse:
    """Serve a workspace file over HTTP (Range/206 handled by FileResponse).

    Shared policy for /fs/raw and /fs/page. Same trust boundary as the ws
    fs.* handlers: the workspace argument is not checked against a
    known-workspace set (fs.list_dir does not do that either) — any existing
    directory is accepted, and path safety (escape + .agent-team guard) is
    enforced by fs_service._resolve_safe.

    Media, fonts, PDF, and (X)HTML are served inline (plus text/css when
    ``allow_css`` — /fs/page relative subresources); HTML is confined by
    `Content-Security-Policy: sandbox` (opaque origin, no scripts/forms/
    plugins) for the sandboxed iframe preview. Every other type is downgraded
    to an application/octet-stream attachment.
    """
    try:
        target = fs_service._resolve_safe(workspace, rel, allow_mockups=True)
    except fs_service.FsError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if target.is_dir():
        raise HTTPException(status_code=400, detail="path is a directory")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    media_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    # XSS hardening: only types the preview pane embeds are served inline.
    # HTML is inline for the sandboxed iframe preview but neutralized by
    # `Content-Security-Policy: sandbox` — the document runs in an opaque
    # origin with scripts/forms/plugins blocked. Every other non-media type
    # is downgraded to an opaque attachment. PDF is exempt from the CSP
    # sandbox because it would disable Chromium's embedded viewer.
    inline = (
        media_type in ("application/pdf", "text/html", "application/xhtml+xml")
        or media_type in _FONT_MIMES
        or (allow_css and media_type == "text/css")
        or media_type.startswith(("image/", "video/", "audio/"))
    )
    headers = {"X-Content-Type-Options": "nosniff"}
    if media_type != "application/pdf":
        headers["Content-Security-Policy"] = "sandbox"
    if not inline:
        return FileResponse(
            target,
            media_type="application/octet-stream",
            filename=target.name,
            content_disposition_type="attachment",
            headers=headers,
        )
    return FileResponse(target, media_type=media_type, headers=headers)


def _require_ws_token(t: str) -> None:
    """The HTTP file routes share the ws token as their credential.

    Without it, /fs/raw was reachable by any local account: the backend binds
    loopback but never asked who was calling, and ``workspace=/`` turned the
    escape check into a no-op. The ws token file is 0600 — that permission is
    the one boundary between this user's processes and everyone else on the
    machine, and this route sat outside it. Same shape as /hooks/claude/rewake.
    """
    if not ws_auth.token_matches(t):
        raise HTTPException(status_code=403, detail="missing or invalid token")


@app.get("/fs/raw")
async def fs_raw(workspace: str, rel: str, t: str = "") -> FileResponse:
    """Serve a raw workspace file (query-addressed). See _serve_workspace_file."""
    _require_ws_token(t)
    # The helper is pure-sync and does real syscalls (_resolve_safe → resolve(),
    # is_dir, is_file) that block for minutes on a stalled network/cloud mount.
    # An `async def` route is not handed to FastAPI's threadpool, so it would
    # block the event loop — offload it, same rule as the fs.* ws handlers.
    return await asyncio.to_thread(_serve_workspace_file, workspace, rel)


@app.get("/fs/page/{cap}/{ws_b64}/{rel:path}")
async def fs_page(cap: str, ws_b64: str, rel: str) -> FileResponse:
    """Serve a workspace file path-addressed so relative subresources resolve.

    ``ws_b64`` is the URL-safe base64 of the absolute workspace path (padding
    optional). Same policy as /fs/raw, plus text/css inline — an HTML preview
    loaded from this route can fetch its ./style.css, images, and fonts via
    relative URLs.

    ``cap`` is the per-workspace capability from ``ws_auth.page_capability``
    (the renderer asks for it over the socket, ``fs.page_capability``). It sits
    in the path, ahead of the workspace, so the relative subresources a
    previewed page loads carry it automatically — and it is deliberately not
    the ws token itself; see ``page_capability`` for why a token in this path
    would leave the machine.
    """
    if not ws_auth.page_capability_matches(ws_b64, cap):
        raise HTTPException(status_code=403, detail="missing or invalid capability")
    try:
        padded = ws_b64 + "=" * (-len(ws_b64) % 4)
        workspace = base64.urlsafe_b64decode(padded).decode("utf-8")
    except (ValueError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=400, detail="invalid workspace encoding") from exc
    return await asyncio.to_thread(_serve_workspace_file, workspace, rel, allow_css=True)


# Derived, not listed: a vendor that installs hooks is exactly the one allowed
# to post them back. Keeping these in step by construction means a new vendor
# cannot end up installing hooks the endpoint then rejects.
_HOOK_VENDORS = frozenset(
    key for key, spec in _CLI_VENDORS.items() if spec.install_hooks is not None
)

# Vendors whose hooks report BOTH halves of a subagent's life — the Task going
# in (PreToolUse) and its stop coming back out (SubagentStop). Counting on a
# vendor that reports only the first would climb forever, and a count stuck
# above zero holds the unattended loop back for its whole staleness window.
# Listed rather than derived: what an installer writes is a fact about that
# vendor's hook file, not something the vendor spec exposes.
_SUBAGENT_COUNTING_VENDORS = frozenset({"claude"})

# Hook events that pair a permission box with the tool result that answers it.
# PermissionRequest carries no tool_use_id, so the pairing is the tool name plus
# a fingerprint of its input — both Post events repeat the same tool_input.
_TOOL_KEYED_EVENTS = frozenset({"permission_request", "post_tool_use", "post_tool_use_failure"})

# The two tool results. Both hooks are installed async, so the last tool's result
# can land after Stop: they only release a permission hold and must never count
# as the agent working, or a finished pane would read as mid-turn again.
_TOOL_RESULT_EVENTS = frozenset({"post_tool_use", "post_tool_use_failure"})


# Tools whose answer is written into their input (AskUserQuestion's `answers`,
# ExitPlanMode's approved plan), so the input a Post event repeats differs from
# the one the box was raised with. They are keyed by name alone, which is enough:
# only one such box is ever open at a time.
_INPUT_REWRITTEN_TOOLS = frozenset({"AskUserQuestion", "ExitPlanMode"})


def _hook_tool_key(payload: dict) -> str:
    """`<tool_name>:<hash of tool_input>`, or "" when the payload names no tool."""
    name = str(payload.get("tool_name") or "")
    if not name:
        return ""
    if name in _INPUT_REWRITTEN_TOOLS:
        return name
    try:
        canonical = json.dumps(payload.get("tool_input"), sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError):
        return ""
    return f"{name}:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()[:16]}"

# Tools whose PreToolUse payload names a file the agent is about to write.
# Read-only tools carry a file_path too, so the set — not the field — is what
# decides whether a hook becomes a preview record.
_WRITE_TOOLS = frozenset({"Write", "Edit", "MultiEdit", "NotebookEdit"})


def _record_hook_file_write(
    vendor: str,
    pane_id: str,
    ws_path: str,
    tool_name: str,
    payload: dict,
) -> tuple[str, dict[str, Any]] | None:
    """Log a PreToolUse write as an attributed preview record.

    PreToolUse fires *before* the tool runs, which is the only moment the
    created/modified split can be read off the filesystem. Paths outside the
    pane's workspace are dropped: a preview record lives in that workspace's
    database and means nothing outside it.

    Returns the root the row landed in and the row itself, or None when there
    was nothing to record or the store folded the event into an existing row.
    """
    if tool_name not in _WRITE_TOOLS or not ws_path:
        return None
    tool_input = payload.get("tool_input")
    raw_path = (tool_input or {}).get("file_path") if isinstance(tool_input, dict) else None
    abs_path = str(raw_path or "")
    if not abs_path or not os.path.isabs(abs_path):
        return None
    # realpath both sides so a symlink cannot point out of the workspace; the
    # target need not exist yet (Write creating a file is the common case).
    resolved = os.path.realpath(abs_path)
    root = os.path.realpath(ws_path)
    if resolved != root and not resolved.startswith(root + os.sep):
        return None
    # Forward slashes, as `preview_record` over MCP stores them: the same
    # file must land under one key on Windows too.
    rel_path = Path(os.path.relpath(resolved, root)).as_posix()
    # The gate above stays the pane's workspace; only the database the row
    # lands in moves up to the project root.
    record_root = _preview_workspace(ws_path)
    row = preview_log.append(
        record_root,
        change="modified" if os.path.exists(resolved) else "created",
        kind="file",
        rel_path=rel_path,
        title=os.path.basename(resolved),
        source="agent",
        pane_id=pane_id or None,
        agent=vendor,
        tool=tool_name,
    )
    return (record_root, row) if row is not None else None


@app.post("/hooks/codex/session-start")
async def codex_session_start_hook(request: Request) -> Response:
    if not hook_auth.presented(request.headers.get(hook_auth.HEADER)):
        return Response(status_code=403)
    token = request.headers.get(codex_session_hooks.LAUNCH_HEADER, "")
    if not token or token not in _live_codex_hook_terms():
        return Response(status_code=403)
    try:
        payload = await request.json()
    except ValueError:
        return Response(status_code=400)
    if not isinstance(payload, dict) or not _codex_pending_starts.add(token, payload):
        return Response(status_code=400)
    await _retry_codex_session_start(token)
    # Hook stdout is empty: identity reporting adds no context or model turn.
    return Response(status_code=200)


@app.post("/hooks/{vendor}/pretooluse")
async def cli_pretooluse_guard_hook(vendor: str, request: Request) -> Response:
    """Navide Guard's synchronous PreToolUse decision (see guard_hooks).

    The body is printed to the CLI as the hook's own output, so it is either a
    vendor-native decision or empty — empty is "no decision", which is also
    what every failure answers (local fail-open).
    """
    if vendor not in guard_hooks.VENDORS:
        return Response(status_code=404)
    if not hook_auth.presented(request.headers.get(hook_auth.HEADER)):
        return Response(status_code=403)
    try:
        payload = await request.json()
    except ValueError:
        payload = None
    if not isinstance(payload, dict):
        return Response(status_code=200)
    cwd = str(payload.get("cwd") or "")
    pane_id, ws_path = "", ""
    if vendor == "codex":
        # Same identity the SessionStart hook uses: the per-launch token in the
        # pane's environment, which exists before any rollout is attributed.
        term = _live_codex_hook_terms().get(
            request.headers.get(codex_session_hooks.LAUNCH_HEADER, "")
        )
        pane_id = str(getattr(term, "pane_id", "") or "")
    if not pane_id:
        pane_id, ws_path, _ = attribution.pane_for_session(
            str(payload.get("session_id") or payload.get("sessionId") or "")
        )
    if not pane_id:
        # Not attributed yet: the per-pane token from the pane's environment.
        # A hook fired outside Navide sends none and stays unattributed.
        pane_id = _pane_for_guard_token(request.headers.get(guard_hooks.PANE_TOKEN_HEADER, ""))
        pane = agent_messaging.current(pane_id) if pane_id else None
        ws_path = pane.workspace_path if pane is not None else ws_path
    answer = await guard_hooks.respond(
        vendor, payload, pane_id=pane_id or "", cwd=cwd, workspace=ws_path or cwd
    )
    # ASCII-only JSON: the body goes back through the hook's shell, and a
    # Windows PowerShell re-encodes native output with the console code page.
    return Response(json.dumps(answer), media_type="application/json") if answer else Response(status_code=200)


@app.post("/hooks/{vendor}")
async def cli_hook(vendor: str, request: Request) -> Any:
    """Receive a CLI hook payload.

    Hook commands installed by `claude_hooks` / `qwen_hooks` / `copilot_hooks`
    POST here with:
      - Header X-Agent-Team-Event: pre_tool_use | stop | notification |
        subagent_stop | permission_request | post_tool_use |
        post_tool_use_failure
      - Body: the JSON payload the CLI pipes to the hook on stdin

    The three vendors disagree on where hooks are configured but agree on what
    a notification says — same `notification_type` vocabulary — so one handler
    serves all of them and `vendor` only labels the broadcast. The path is
    parameterized rather than per-vendor so hooks written by an older build,
    which point at /hooks/claude, keep resolving here unchanged.

    We map these to `agent.activity` broadcasts so the frontend watcher gets
    100% reliable signals without buffer-scanning. We do NOT pane-attribute
    here (the hook payload has cwd + session_id; we let the frontend match
    by current-stage panes based on those).
    """
    if vendor not in _HOOK_VENDORS:
        return {"ok": False, "reason": f"unknown hook vendor: {vendor!r}"}
    if not hook_auth.presented(request.headers.get(hook_auth.HEADER)):
        # Not installed by this machine's backend — another local account, or a
        # hook written by a build before the secret existed. Empty 403 so a
        # Stop hook reading the body still sees "no decision" rather than an
        # error object it would show the user.
        return Response(status_code=403)
    event_kind = request.headers.get("X-Agent-Team-Event", "").strip()
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    # Map the CLI's lifecycle to our two event_type buckets. subagent_stop
    # joins agent_active rather than earning a third bucket: a subagent
    # finishing means the main agent is about to pick its work back up, which
    # is what agent_active already says. Its own contribution — the pending
    # count below — rides on the broadcast instead, so no consumer has to learn
    # a new event_type to keep working.
    if event_kind == "stop":
        event_type = "turn_complete"
    elif event_kind in (
        "pre_tool_use", "notification", "subagent_stop",
        "permission_request", "post_tool_use", "post_tool_use_failure",
    ):
        event_type = "agent_active"
    else:
        return {"ok": False, "reason": f"unknown event kind: {event_kind!r}"}

    session_id = str(payload.get("session_id") or payload.get("sessionId") or "")
    cwd = str(payload.get("cwd") or "")
    # Notification fires for eight different situations and only some mean "the
    # user has to act" — permission_prompt blocks the turn, idle_prompt fires
    # every time Claude finishes and waits for the next instruction. Forwarded
    # raw; the frontend owns which ones raise its AWAITING badge. Empty on
    # every other event kind, and on Claude versions that predate the field.
    # Both vendors use the same vocabulary here (qwen fires permission_prompt /
    # idle_prompt / auth_success from the same field).
    notification_type = str(payload.get("notification_type") or "")
    # Resolve pane_id from session_id (claimed by the JSONL path). Hook payloads
    # have no file_path so they can't pass attribute()'s workspace gate; this
    # lookup bypasses it. Race (stop before JSONL claimed the session) → empty
    # pane_id, and the JSONL path's matching event supplies it shortly.
    pane_id, ws_path, stage_id = attribution.pane_for_session(session_id)
    # Background-subagent bookkeeping: Task in on PreToolUse, out on
    # SubagentStop. The frontend loop reads the resulting count to tell a turn
    # that ended DONE from one that ended to WAIT — see subagent_tracker.
    #
    # Gated on the vendor because the two halves must come as a pair: a vendor
    # that reports tool use but never reports a subagent finishing would count
    # only upwards, and a count stuck above zero holds the loop back. Today
    # claude is the only vendor installing both (qwen registers Notification
    # alone), so this gate is also the reminder for whoever adds the next one.
    if vendor in _SUBAGENT_COUNTING_VENDORS:
        if event_kind == "pre_tool_use":
            subagent_tracker.note_tool_use(pane_id, str(payload.get("tool_name") or ""))
        elif event_kind == "subagent_stop":
            subagent_tracker.note_subagent_stop(pane_id)
    if event_kind == "pre_tool_use":
        # Beside the tracker rather than inside it: the preview record is not
        # gated on subagent counting, and a failure here must never disturb the
        # response this endpoint owes the busy-state path.
        try:
            recorded = _record_hook_file_write(
                vendor, pane_id or "", ws_path or "", str(payload.get("tool_name") or ""), payload
            )
            # Inside the same guard as the write: the panels seeing this row
            # matter less than the response this endpoint owes the busy path.
            if recorded is not None:
                await broadcast(
                    make_event(
                        "preview.recorded",
                        {"workspace_path": recorded[0], "entry": recorded[1]},
                    )
                )
        except Exception as err:  # noqa: BLE001
            log.warning("preview record from %s hook failed: %s", vendor, err)
    # Stop-hook delivery: a claude pane with a message waiting is told to keep
    # going and act on it, instead of stopping and being typed at afterwards.
    # Only claude, because only its Stop hook can block — and only its hook
    # command forwards this response body to the CLI's stdin-reading parser.
    blocked_envelope = ""
    if vendor == "claude" and event_kind == "stop":
        blocked_envelope = await hook_drain.drain_for_stop_hook(
            pane_id or "", stop_hook_active=bool(payload.get("stop_hook_active"))
        )
        if blocked_envelope:
            # The turn did not end: Claude picks the message up as its next
            # instruction. Reporting turn_complete here would make the frontend
            # call the pane idle and start injecting the NEXT queued message
            # over stdin, into a pane that is already working.
            event_type = "agent_active"
    # idle_prompt fires about a minute after EVERY finished turn (draft in the
    # composer or not). It reports the pane waiting, not working, so recording
    # it as agent_active would replace the turn_complete entry for good —
    # cli_get_status would show a finished pane as active, with no turn text.
    # The broadcast below still carries it for the renderer to judge. A tool
    # result is left out for the same reason: it can arrive after Stop.
    if pane_id and notification_type != "idle_prompt" and event_kind not in _TOOL_RESULT_EVENTS:
        # The log-reader sink is not the only writer of _pane_activity any
        # more: for the hook vendors the Stop hook is the earliest and most
        # reliable end-of-turn signal there is, and cli_wait_idle could not see
        # it — it had to sit out the 10s quiet threshold instead. Hook payloads
        # carry no assistant text, so keep the text the sink already recorded
        # for this same turn rather than blanking it.
        prior = pane_activity(pane_id)
        prior_text = prior["text"] if prior and event_type == "turn_complete" else ""
        _record_pane_activity(pane_id, event_type, prior_text)
    await broadcast(make_event("agent.activity", {
        "vendor": vendor,
        "event_type": event_type,
        "workspace_path": ws_path or cwd,
        "pane_id": pane_id or "",
        "stage_id": stage_id or "",
        "session_id": session_id,
        "cwd": cwd,
        "timestamp": "",
        "detail": "hook:stop-blocked" if blocked_envelope else f"hook:{event_kind}",
        "notification_type": notification_type,
        # Which tool a permission box is for, and which tool a result is of, so
        # the frontend releases a held box only on its own tool finishing.
        # Empty on every other event kind.
        "tool_key": _hook_tool_key(payload) if event_kind in _TOOL_KEYED_EVENTS else "",
        # Background subagents this pane is still waiting on. Always present so
        # the frontend can trust a 0 as "none running" rather than "not
        # reported"; vendors without these hooks never send the field at all
        # and their panes simply never gate on it.
        "pending_subagents": subagent_tracker.pending(pane_id),
    }))
    # Dev time: only real work signals. A notification (idle_prompt /
    # permission_prompt) or a permission_request is mapped to agent_active above
    # for the busy-state path, but it marks the agent WAITING — beating on it would open an agent
    # interval at exactly the moment nothing is running. Guarded like the
    # preview record: this endpoint's response must not depend on the store.
    # A late tool result is no work signal either: it can follow Stop.
    if event_kind not in ("notification", "permission_request", *_TOOL_RESULT_EVENTS):
        try:
            if dev_time_store.agent_event(ws_path or cwd, pane_id or "", event_type, ""):
                await broadcast(
                    make_event("devtime.changed", {"workspace_path": ws_path or cwd})
                )
        except Exception as err:  # noqa: BLE001
            log.warning("dev time record from %s hook failed: %s", vendor, err)
    if vendor == "claude" and event_kind == "stop":
        # This body is read by Claude Code as the Stop hook's own output, so it
        # is either a valid decision object or nothing at all: an unrecognized
        # object on a hook's stdout is reported to the user as a hook error.
        if blocked_envelope:
            return JSONResponse({"decision": "block", "reason": blocked_envelope})
        return Response(status_code=200)
    return {"ok": True}


#: How long a rewake waiter waits for its session to be attributed to a pane
#: before giving up. SessionStart fires before the conversation log exists, so a
#: fresh pane has nothing to match on for a moment; a pane that never resolves
#: (an external `claude` the user started themselves) simply gets no channel,
#: and the Stop hook re-arms one later if it ever does.
_REWAKE_ATTRIBUTION_WAIT_S = 30.0

#: How often a parked waiter checks that the hook is still on the other end.
#: The hook is a curl the CLI backgrounded, and it dies with the CLI: a user
#: running `/exit` inside a pane that stays open takes it with them, and nothing
#: about that reaches the future the request is awaiting.
_REWAKE_DISCONNECT_POLL_S = 1.0


async def _hook_still_connected(request: Request) -> None:
    """Return once the hook's HTTP connection is gone.

    Polled rather than awaited on an event, because that is all the ASGI
    contract offers. Cheap: one call a second per parked pane, and the pane
    count is the number of claude panes open.
    """
    while True:
        if await request.is_disconnected():
            return
        await asyncio.sleep(_REWAKE_DISCONNECT_POLL_S)


async def _rewake_pane_id(session_id: str) -> str:
    """The pane this session belongs to, waiting a little for it to be known."""
    deadline = time.monotonic() + _REWAKE_ATTRIBUTION_WAIT_S
    while True:
        pane_id, _, _ = attribution.pane_for_session(session_id)
        if pane_id or time.monotonic() >= deadline:
            return pane_id or ""
        await asyncio.sleep(0.5)


async def _announce_push_state(pane_id: str, kind: str, ready: bool) -> None:
    await broadcast(
        make_event("agent_msg.push_state", {
            "pane_id": pane_id, "kind": kind, "ready": ready,
        })
    )


@app.post("/hooks/claude/rewake")
async def claude_rewake_hook(request: Request) -> Response:
    """Park a claude pane's background hook until there is a message for it.

    This is the idle half of Stop-hook delivery. The Stop hook covers a message
    that lands while the agent is working; a pane sitting idle runs no hook at
    all, so instead one is left waiting here. Answering it with an envelope
    makes Claude Code wake the agent and show that text as a system reminder,
    without anything being typed into the pane.

    The response body IS the protocol: non-empty means "wake, and say this",
    empty means "nothing to report" and the hook exits without a decision. The
    wait is bounded well inside the hook's own deadline, so this side is always
    the one that gives up first — the reverse would resolve a message into a
    hook that had already gone.

    The waiter is also given up the moment the connection drops. A message
    handed to a hook that is no longer there would be marked delivered with no
    agent anywhere near it, and that is exactly what a user running `/exit`
    inside a pane they leave open produces.
    """
    if not hook_auth.presented(request.headers.get(hook_auth.HEADER)):
        # Not installed by this machine's backend — another local account, or
        # a hook written before the header file existed. Empty body: a hook
        # reading a 403 must still exit without a decision rather than showing
        # the user an error.
        return Response(status_code=403)
    if push_delivery.channel_for("claude") is None:
        # Answered before the attribution wait below rather than after it: a
        # switched-off channel, or a `claude` the user started outside Navide,
        # would otherwise leave a background curl parked here for 30 seconds on
        # every single Stop, for a pane that is never going to get a waiter.
        return Response(status_code=200)
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        payload = {}
    session_id = str((payload or {}).get("session_id") or "") if isinstance(payload, dict) else ""
    pane_id = await _rewake_pane_id(session_id) if session_id else ""
    # Session attribution answers with the id the PTY was created under; the
    # window pushes to the id the pane answers to now. Park the waiter on the
    # latter or a reattached pane would never be woken.
    pane_id = agent_messaging.resolve_alias(pane_id) or pane_id
    if not pane_id:
        return Response(status_code=200)
    if push_delivery.register_hook_pane(pane_id, "claude") is None:
        return Response(status_code=200)
    armed = push_delivery.arm_hook(pane_id)
    if armed is None:
        return Response(status_code=200)
    request_id, future = armed
    await _announce_push_state(pane_id, push_delivery.KIND_HOOK, True)
    envelope = ""
    try:
        waiting = asyncio.ensure_future(
            push_delivery.wait_for_hook(pane_id, request_id, future)
        )
        watching = asyncio.ensure_future(_hook_still_connected(request))
        done, _ = await asyncio.wait(
            {waiting, watching}, return_when=asyncio.FIRST_COMPLETED
        )
        if waiting in done:
            watching.cancel()
            envelope = waiting.result() or ""
        else:
            # The hook is gone. Drop the waiter BEFORE awaiting anything else,
            # so a push arriving in between cannot resolve into it.
            push_delivery.discard_waiter(pane_id, request_id)
            waiting.cancel()
    finally:
        if not push_delivery.is_ready(pane_id):
            await _announce_push_state(pane_id, push_delivery.KIND_HOOK, False)
    if not envelope:
        return Response(status_code=200)
    return Response(content=envelope, media_type="text/plain; charset=utf-8")


@app.websocket("/ws")
async def ws(websocket: WebSocket) -> None:
    # Refused before accept(), so a caller without the credential never reaches
    # the dispatch loop — and `terminal.create`, which takes a command and an
    # env straight from the caller, lives in that loop. Binding to 127.0.0.1
    # keeps the network out but not the browser: a WebSocket handshake is not
    # subject to the same-origin policy, so any page the user visits can scan
    # the ephemeral range and talk to us. It cannot read a file, which is what
    # the token is. See ws_auth.
    refusal = ws_auth.check(
        websocket.query_params.get("t") or "",
        websocket.headers.get("origin") or "",
    )
    if refusal:
        log.warning("refused a ws handshake: %s", refusal)
        # Accept-then-close rather than a bare close: a browser is told nothing
        # useful either way, and an app client gets a close code it can show
        # instead of an opaque network error.
        await websocket.accept()
        await websocket.close(code=ws_auth.WS_UNAUTHORIZED)
        return
    await websocket.accept()
    log.info("ws client connected")
    session = Session(websocket)
    _SESSIONS.add(session)
    # First thing on every connection: the challenge a Navide main window
    # answers through main (window.prove) to be told apart from any other
    # client holding the token. Fresh per connection, so a reconnect proves
    # again and a proof seen once cannot be replayed.
    await session.send_json(
        make_event("ws.welcome", {"windowChallenge": session.window_challenge})
    )
    # An MCP client reads this backend's tool list once, when it connects, so a
    # CLI that was already talking to the previous backend keeps the tools it
    # saw then. Told to the window rather than logged: only the window can put
    # it in front of the person who has to reopen the pane. Sent on every
    # connect because a window may open at any point after startup; the feed
    # dedupes it by id.
    changed = version_change()
    if changed is not None:
        await session.send_json(
            make_event("app.version_changed", {"from": changed[0], "to": changed[1]})
        )
    try:
        while True:
            if session.dead:
                # A send already failed on this connection; stop receiving.
                log.info("ws session marked dead; closing receive loop")
                break
            try:
                msg = await websocket.receive_json()
            except (ValueError, KeyError) as parse_err:
                # Malformed JSON frame — log and continue; don't crash the session.
                log.warning("ws malformed message (ignored): %s", parse_err)
                continue
            # Dispatch each message as a concurrent task so long-running handlers
            # (e.g. analyzer.classify that takes 10-60s for LLM inference) never
            # block the receive loop.  Without this, a classify in flight would
            # cause terminal.create messages to queue in the OS buffer and time
            # out on the frontend's 10-second deadline.
            task = asyncio.create_task(handle_message(session, msg))
            session._handler_tasks.add(task)
            task.add_done_callback(session._handler_tasks.discard)
    except WebSocketDisconnect as exc:
        # Record who hung up. Without the code these lines cannot distinguish
        # uvicorn timing out its own ping (1006/1011) from a window simply
        # closing (1001). The frontend no longer closes sockets on its own.
        log.info(
            "ws client disconnected code=%s reason=%s",
            exc.code,
            exc.reason or "-",
        )
    finally:
        # Peer is gone: silence any in-flight sends before cancelling tasks.
        session.dead = True
        _SESSIONS.discard(session)
        await nudge_plugin_request_recovery(session)
        await _kill_onboarding_runs(session)
        # Release PTY ownership so their output is dropped until reattached.
        orphaned = [tid for tid, owner in _PTY_OWNERS.items() if owner is session]
        for tid in orphaned:
            del _PTY_OWNERS[tid]
        # Flag the messaging handles this window mirrored as offline. They are
        # kept for a grace period rather than dropped: the window is usually
        # just reconnecting, and a deleted entry told callers the pane did not
        # exist. See agent_messaging.drop_owner.
        agent_messaging.drop_owner(session)
        from . import voice_handlers

        voice_handlers.drop_owner(session)
        server_link.roster_changed()
        # PTYs survive this disconnect so the frontend can reattach after a
        # transient network outage. They are killed only when the user explicitly
        # closes a pane (terminal.kill) or the whole app process exits.
        for t in session._review_tasks:
            t.cancel()
        for t in session._handler_tasks:
            t.cancel()


async def _kill_onboarding_runs(session: Session) -> None:
    """Kill the PTYs this connection started through onboarding.run.

    A run has no pane a reloaded window could reattach: left alive it would
    sit on a sudo or OAuth prompt nobody can answer.
    """
    for tid in list(session._onboarding_runs):
        try:
            await session.terminals.kill(tid)
        except Exception:  # noqa: BLE001 - disconnect cleanup must finish
            log.exception("could not kill onboarding run %s on disconnect", tid)
    session._onboarding_runs.clear()


def _project_payload(project) -> dict[str, Any]:
    """Serialize a Project plus paths to its on-disk files."""
    log_file_name: str = getattr(project, "log_file_name", "") or ""
    # run_dir is the relative path from .agent-team/ to the run folder, e.g.
    # "runs/20260528-020041-task". Empty string for projects with no active run.
    run_dir = log_file_name.rsplit("/", 1)[0] if "/" in log_file_name else ""
    project_dict = asdict(project)
    return {
        "project": project_dict,
        "paths": {
            "dir": str(project_store.project_dir(project.workspace_path)),
            "project_file": str(project_store.project_file(project.workspace_path)),
            "pipeline_log": str(project_store.log_file(project.workspace_path, log_file_name)),
            "backend_log": str(backend_log_path()),
            "run_dir": run_dir,
        },
    }



# Shared with vendor modules — the canonical definition moved to
# cli_vendors.base so specs can parse commands without importing app.
from .cli_vendors.base import command_text as _command_text  # noqa: E402





def _resume_id_for_agent(agent_key: str, command: Any) -> str:
    """Resume/session id a launch command targets for this agent ('' when the
    agent has no id-carrying resume flag or the command doesn't resume).
    Fully registry-driven since R12 — vendors own their parsers."""
    spec = cli_vendor(agent_key)
    if spec is not None and spec.resume_id_from_command is not None:
        return spec.resume_id_from_command(command)
    return ""


def _session_lookup_path(agent: str, workspace_path: str, session_id: str) -> str:
    """The filesystem path the resume preflight checks for this session — logged
    and returned so a failed resume is diagnosable (e.g. a cwd whose non-ASCII
    chars encode to a colliding claude projects dir). '' when the vendor owns
    the location and there is no single stable path (codex/grok/opencode/kilo,
    pi — whose filename carries a timestamp prefix the id alone can't
    reconstruct — and cursor, whose path has a project-hash segment the id
    alone can't name)."""
    agent = agent.strip().lower()
    session_id = session_id.strip()
    if not session_id:
        return ""
    spec = cli_vendor(agent)
    if spec is not None and spec.session_path is not None:
        path = spec.session_path(workspace_path, session_id)
        return str(path) if path is not None else ""
    return ""


def _session_exists(agent: str, workspace_path: str, session_id: str) -> bool:
    agent = agent.strip().lower()
    session_id = session_id.strip()
    if not session_id:
        return False
    spec = cli_vendor(agent)
    if spec is not None and spec.session_exists is not None:
        return spec.session_exists(workspace_path, session_id)
    path = _session_lookup_path(agent, workspace_path, session_id)
    if path:
        return Path(path).is_file()
    return True  # unknown agent: assume resumable (unchanged behaviour)


def _record_analyzer_tokens(result: dict[str, Any], payload: dict[str, Any]) -> None:
    """Push an analyzer call's real token count into the store + broadcast.

    Fire-and-forget broadcast so a slow client doesn't delay the response.
    """
    ev = int(result.get("eval_count", 0) or 0)
    pev = int(result.get("prompt_eval_count", 0) or 0)
    if ev == 0 and pev == 0:
        return
    workspace_path = payload.get("workspace_path") or None
    stage_id = payload.get("stage_id") or None
    pane_id = payload.get("pane_id") or None
    tokens_store.record(
        workspace_path,
        source="analyzer",
        vendor="analyzer",
        pane_id=pane_id,
        stage_id=stage_id,
        input_tokens=pev,
        output_tokens=ev,
    )
    asyncio.create_task(
        broadcast(make_event("tokens.changed", tokens_store.snapshot(workspace_path)))
    )


# Agent-CLI spawns inherit the backend's PATH (terminals.py copies os.environ),
# but the backend was launched with the GUI's restricted PATH. Refresh from the
# user's shell — throttled, it shells out — before spawning, so a CLI the user
# just installed is found without first passing through an onboarding.status
# call (real case: install grok → click Respawn → still exit 127).
_PATH_REFRESH_INTERVAL_SEC = 30.0
_last_path_refresh = 0.0


async def _ensure_fresh_path_for_spawn(agent_key: str) -> None:
    global _last_path_refresh
    if agent_key in ("", "terminal"):
        return
    now = time.monotonic()
    if now - _last_path_refresh < _PATH_REFRESH_INTERVAL_SEC:
        return
    _last_path_refresh = now
    # Same dedicated pool as the spawn probe: a login-shell subprocess is the
    # same kind of heavy pre-spawn work and must stay off the shared default
    # executor (see ws_handlers._CLI_PROBE_EXECUTOR).
    # A tight ceiling on purpose: terminal.create has 30s and has already
    # promised 25s of it to the credential switch lock, so a probe that waits
    # longer than this turns the lock's named timeout into a generic
    # "request terminal.create timeout" the user cannot act on. The probe is
    # speculative here anyway — whatever it misses, the pane's own login shell
    # still resolves.
    await asyncio.get_running_loop().run_in_executor(
        ws_handlers._CLI_PROBE_EXECUTOR,
        lambda: onboarding_deps._refresh_path_from_login_shell(
            timeout_s=onboarding_deps._PATH_PROBE_TIMEOUT_SPAWN_S
        ),
    )


def _spawn_execs_the_cli_directly(command: Any, known_names: "tuple[str, ...]") -> bool:
    """Whether the spawn will exec the CLI itself, with no shell in between.

    Decides whether a probe miss is a hint or a verdict. An agent pane runs
    `zsh -ilc '<cli> ...'`, so argv[0] is the shell and the name gets resolved
    a second time against rc files this process never read — a miss there is
    worth spawning through. Two paths exec the CLI directly instead: the
    plugin `ai.cli.start` capability (aiCliCommand builds a bare argv) and
    Windows agent panes (shellCommandArgv returns the plain command). No
    second opinion is coming on those, so a miss is final.
    """
    if isinstance(command, list):
        head = str(command[0]) if command else ""
    else:
        try:
            parts = osplat.terminal_backend.parse_command(str(command or ""))
        except (ValueError, OSError):
            return False
        head = parts[0] if parts else ""
    return bool(head) and _names_a_known_command(head, known_names)


class AgentCliProbeError(RuntimeError):
    def __init__(self, message: str, details: dict[str, Any]) -> None:
        super().__init__(message)
        self.details = details


def _with_replaced_executable(command: Any, text: str, executable: str) -> Any:
    """Swap the command's first token, preserving flags and the list wrapper."""
    first_token = re.match(r"^\s*(?:'[^']*'|\"[^\"]*\"|\S+)", text)
    if first_token is None:
        return command
    replaced = f"{text[:first_token.start()]}{osplat.paths.quote_arg(executable)}{text[first_token.end():]}"
    if isinstance(command, list):
        updated = list(command)
        if updated:
            updated[-1] = replaced
        return updated
    return replaced


def _names_a_known_command(program: str, names: "tuple[str, ...]") -> bool:
    """Whether `program` is one of `names`, as this platform spells them.

    A Windows PATH lookup answers `claude.cmd`, so comparing the bare stem
    against the pinned name would say no and leave the rewrite undone — the
    very rewrite that exists to make the spawn work. The pinned name itself
    stays accepted: a pane command names the CLI without an extension, which
    is not among the candidates Windows would try on PATH.
    """
    spelled = {name.casefold() for name in names}
    spelled.update(
        candidate.casefold()
        for name in names
        for candidate in osplat.paths.executable_candidates(name)
    )
    return Path(program).name.casefold() in spelled


def _command_with_persisted_cli_binary(agent_key: str, command: Any) -> Any:
    """Replace the CLI executable while preserving shell flags and list wrappers."""
    selected = onboarding_deps.cli_binary_override(agent_key)
    dep = onboarding_deps.DEPS_BY_ID.get(agent_key)
    if not selected or dep is None:
        return command
    text = _command_text(command)
    try:
        parts = osplat.terminal_backend.parse_command(text)
    except (ValueError, OSError):
        return command
    if not parts or not _names_a_known_command(parts[0], (dep.check_cmd[0],)):
        return command
    return _with_replaced_executable(command, text, selected)


def _command_with_installed_cli_alias(agent_key: str, command: Any) -> Any:
    """Point the command at the executable name this machine actually has.

    agentSpecs pins ONE name per CLI, but a vendor rename leaves the other one
    installed (cursor ships `agent`; older installs only have `cursor-agent`).
    Spawning the pinned name then dies with exit 127 while detection reports
    the CLI as present — so resolve the alias here instead.
    """
    dep = onboarding_deps.DEPS_BY_ID.get(agent_key)
    if dep is None or not dep.alt_commands:
        return command
    text = _command_text(command)
    try:
        parts = osplat.terminal_backend.parse_command(text)
    except (ValueError, OSError):
        return command
    if not parts or not _names_a_known_command(parts[0], (dep.check_cmd[0], *dep.alt_commands)):
        return command
    if osplat.paths.resolve_program(parts[0]):
        return command  # the requested name resolves — nothing to fix
    installed = onboarding_deps.resolve_executable(dep)
    if not installed:
        return command
    return _with_replaced_executable(command, text, installed)


def _login_spawn_command(agent_key: str, command: Any) -> Any:
    """Rewrite a login pane's command to the CLI's direct sign-in trigger.

    A login pane must jump straight into the vendor's browser/device sign-in
    flow instead of sitting at a bare REPL. The trigger itself is per-vendor
    knowledge and lives in each vendor's `login_command_args`.

    Keeps the first token (the resolved binary, possibly an override path from
    _command_with_persisted_cli_binary) and drops every other flag — YOLO
    flags like --dangerously-skip-permissions don't apply to auth subcommands.
    Preserves the frontend's [shell, -lc, cmd] wrapper.
    """
    spec = cli_vendor(agent_key)
    args = spec.login_command_args if spec is not None else None
    if args is None:
        return command
    text = _command_text(command)
    first_token = re.match(r"^\s*(?:'[^']*'|\"[^\"]*\"|\S+)", text)
    if first_token is None:
        return command
    replaced = first_token.group(0).strip()
    if args:
        replaced = f"{replaced} {args}"
    if isinstance(command, list):
        updated = list(command)
        if updated:
            updated[-1] = replaced
        return updated
    return replaced


def _agent_signed_out(agent_key: str) -> bool:
    """True when this CLI is installed but its live credentials are absent.

    The spawn probe is a `--version` smoke test, so it can only answer "is it
    installed" — a signed-out CLI passes it and then opens the pane on the
    vendor's own sign-in prompt with nothing in Navide to explain why.

    Only vendors that declare a `live_file` can be asked. For every other CLI
    `credential_vault.identity` answers signedIn=False by default, which is
    absence of evidence rather than evidence of absence; reporting it would put
    a false "not signed in" notice on every CLI Navide cannot inspect.

    Display-only, like `identity` itself: never raises, and False means "no
    evidence of a signed-out state", not "signed in".
    """
    spec = cli_vendor(agent_key)
    if spec is None or spec.live_file is None:
        return False
    try:
        # A selected portable credential that can be put in effect is what
        # the pane will run on, whatever the live login says. One that is
        # missing or shadowed does not count: the spawn refuses it with the
        # reason, and the native answer below stays the honest one.
        if portable_credentials.selection_usable(agent_key, home=Path.home()):
            return False
        return not bool(credential_vault.identity(agent_key).get("signedIn"))
    except Exception:  # noqa: BLE001 — advisory only, never fails a spawn
        return False


# Aligned with onboarding_deps' detection probe (was 3s here — too tight, so a
# momentarily overloaded machine timed out and made EVERY CLI unlaunchable).
_SPAWN_PROBE_TIMEOUT_S = 8
#: Ceiling on the reap that follows a kill. A process wedged in an
#: uninterruptible state (or an ignored signal) must not pin a probe worker.
_SPAWN_PROBE_CLEANUP_TIMEOUT_S = 1.0
#: How much of each stream the probe keeps. A `--version` banner is tiny; the
#: cap is here so a flooding child cannot grow the worker's memory unbounded.
_SPAWN_PROBE_MAX_OUTPUT_CHARS = 1 << 20
_SPAWN_PROBE_READ_CHUNK = 4096


def _drain_probe_pipe(stream: Any, sink: list[str]) -> None:
    """Read one probe pipe to EOF on a daemon thread, keeping at most the cap.

    Reading off the probe's own thread is what makes the read bounded: the
    probe joins the reader under a deadline instead of blocking on an EOF a
    surviving descendant may never deliver (see `_run_spawn_probe`).
    """
    kept = 0
    try:
        while True:
            chunk = stream.read(_SPAWN_PROBE_READ_CHUNK)
            if not chunk:
                break
            if kept < _SPAWN_PROBE_MAX_OUTPUT_CHARS:
                sink.append(chunk[: _SPAWN_PROBE_MAX_OUTPUT_CHARS - kept])
                kept += len(chunk)
    except (OSError, ValueError):
        # The probe is closing this pipe out from under the reader after a
        # timeout; stop quietly rather than letting a daemon thread traceback.
        pass


def _kill_probe_process(proc: subprocess.Popen[str]) -> None:
    """Kill the probe and its descendants, then reap it — every step bounded.

    The child leads its own POSIX session (`start_new_session=True`), so
    `kill_group` can never reach the backend's own group, and the group id
    stays signalable after the direct child exits while a same-group
    descendant still holds the output pipes. If that seam fails (already gone,
    or a Windows subtree whose root exited) the direct child is killed
    directly. The wait is capped so an unkillable process cannot hang the
    probe worker forever.
    """
    try:
        osplat.process_tree.kill_group(proc.pid, force=True)
    except OSError as err:
        log.warning(
            "startup probe process-tree cleanup failed for pid %s: %s",
            proc.pid,
            err,
        )
        try:
            proc.kill()
        except OSError as kill_err:
            log.warning(
                "startup probe direct-child cleanup failed for pid %s: %s",
                proc.pid,
                kill_err,
            )
    try:
        proc.wait(timeout=_SPAWN_PROBE_CLEANUP_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        log.error("startup probe process %s did not exit after kill", proc.pid)


def _run_spawn_probe(command: list[str]) -> subprocess.CompletedProcess[str]:
    """Run the CLI version probe under hard bounds on its pipes and its wait.

    `subprocess.run(capture_output=True, timeout=...)` is not enough. Its
    timeout branch kills the process it started and then, on Windows, drains
    the pipes with `communicate()` and NO timeout: a CLI whose descendant
    inherited those pipes keeps the write end open, so the probe never returns
    and its executor worker is wedged for the life of the backend. Here the
    pipes are drained by daemon readers, the child is awaited under the probe
    budget, and the process tree is killed (closing the pipes) before the
    bounded reap, on timeout and on any other failure alike.
    """
    proc = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=os.environ.copy(),
        # POSIX: own session/group, so kill_group targets the probe and never
        # the backend whose executor runs it. Ignored on Windows, where
        # kill_group walks the subtree instead.
        start_new_session=True,
    )
    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []
    assert proc.stdout is not None and proc.stderr is not None
    readers = [
        threading.Thread(
            target=_drain_probe_pipe,
            args=(proc.stdout, stdout_chunks),
            name="spawn-probe-stdout",
            daemon=True,
        ),
        threading.Thread(
            target=_drain_probe_pipe,
            args=(proc.stderr, stderr_chunks),
            name="spawn-probe-stderr",
            daemon=True,
        ),
    ]
    for reader in readers:
        reader.start()
    deadline = time.monotonic() + _SPAWN_PROBE_TIMEOUT_S
    try:
        proc.wait(timeout=_SPAWN_PROBE_TIMEOUT_S)
        # The CLI can exit while a descendant it left behind still holds the
        # pipes. Wait for the readers only until the budget expires, then kill
        # the tree: read to an EOF that may never arrive would be the hang.
        for reader in readers:
            reader.join(timeout=max(0.0, deadline - time.monotonic()))
        if any(reader.is_alive() for reader in readers):
            raise subprocess.TimeoutExpired(command, _SPAWN_PROBE_TIMEOUT_S)
    except BaseException:
        _kill_probe_process(proc)
        for reader in readers:
            reader.join(timeout=_SPAWN_PROBE_CLEANUP_TIMEOUT_S)
        raise
    finally:
        # Only close a stream whose reader has finished. Closing one a daemon
        # reader is still blocked in would free the fd under it — the reader
        # could then read from a reused descriptor. The reader that never
        # finishes (a descendant survived a failed tree kill) leaks its fd
        # instead, which is the lesser evil and still bounded to one probe.
        for reader, stream in zip(readers, (proc.stdout, proc.stderr)):
            if reader.is_alive():
                continue
            try:
                stream.close()
            except OSError:
                pass
    return subprocess.CompletedProcess(
        command, proc.returncode, "".join(stdout_chunks), "".join(stderr_chunks)
    )


def _probe_agent_cli_for_spawn(agent_key: str, requested_command: Any = None) -> dict[str, Any] | None:
    """Resolve and smoke-test an agent CLI before allocating its PTY.

    Environmental/transient failures (timeout, exec error) DEGRADE to a warning
    dict and let the spawn proceed — the binary is almost certainly fine (a
    `--version` probe is near-instant when the box is idle) and a genuinely
    broken one still fails visibly at spawn. Only definitive failures
    (not_found / nonzero exit / fatal signal) still raise to block the spawn.
    """
    dep = onboarding_deps.DEPS_BY_ID.get(agent_key)
    if dep is None or dep.group != "agent_cli":
        return None
    executable = None
    try:
        command_parts = osplat.terminal_backend.parse_command(_command_text(requested_command))
    except (ValueError, OSError):
        command_parts = []
    requested_executable = command_parts[0] if command_parts else ""
    known_names = (dep.check_cmd[0], *dep.alt_commands)
    if requested_executable and _names_a_known_command(requested_executable, known_names):
        executable = osplat.paths.resolve_program(requested_executable)
    executable = executable or onboarding_deps.resolve_executable(dep)
    if not executable:
        if _spawn_execs_the_cli_directly(requested_command, known_names):
            # No shell will get a second look at the name, so the miss is a
            # verdict. Block, and keep the specific error: letting this run on
            # would only reach terminals.create's own which() and surface as a
            # bare FileNotFoundError with none of these details.
            raise AgentCliProbeError(
                f"{dep.label} startup probe failed: executable not found ({dep.check_cmd[0]})",
                {
                    "agent_key": agent_key,
                    "binary_path": "",
                    "probe_command": dep.check_cmd,
                    "reason": "not_found",
                },
            )
        # Otherwise not definitive. This probe sees only the backend's own
        # PATH, while the pane runs the CLI through an interactive login
        # shell, which reads the rc files that put nvm, volta and npm-global
        # on PATH. Blocking here made "runs in Terminal, unlaunchable in
        # Navide" the norm for every CLI installed by `npm install -g`.
        # Degrade: let the shell have its say. A real absence then exits 127,
        # which the window answers with the guided install (see
        # ws_handlers._terminal_create_impl for why no cli.missing goes out).
        log.warning(
            "%s startup probe found no %s on the backend PATH — spawning anyway, "
            "the pane's login shell may still resolve it",
            dep.label, dep.check_cmd[0],
        )
        return {
            "agent_key": agent_key,
            "binary_path": "",
            "resolved_path": "",
            "probe_command": list(dep.check_cmd),
            "duration_ms": 0,
            "reason": "not_found",
            "degraded": True,
            "version": None,
        }
    resolved = os.path.realpath(executable)
    executable_display = (
        f"{executable} → {resolved}" if resolved != executable else executable
    )
    # The interpreter included: a Windows CLI installed by npm is a `.cmd`
    # shim, which only cmd.exe can start. Reported as the probe command too,
    # so the detail names what actually ran.
    command = osplat.paths.launch_argv(executable, dep.check_cmd[1:])
    started = time.monotonic()
    try:
        proc = _run_spawn_probe(command)
    except subprocess.TimeoutExpired:
        # Transient: the box is momentarily overloaded (fork queued behind a
        # swap storm), not a broken binary. Degrade to a warning and let the
        # spawn proceed instead of blocking every CLI.
        duration_ms = max(0, round((time.monotonic() - started) * 1000))
        log.warning(
            "%s startup probe timed out after %dms (%s) — spawning anyway",
            dep.label, duration_ms, executable_display,
        )
        return {
            "agent_key": agent_key,
            "binary_path": executable,
            "resolved_path": resolved,
            "probe_command": command,
            "duration_ms": duration_ms,
            "reason": "timeout",
            "degraded": True,
            "version": None,
        }
    except OSError as err:
        # Transient: the probe's own fork/exec failed (e.g. EAGAIN under load).
        # Degrade rather than block — a truly unrunnable binary fails at spawn.
        duration_ms = max(0, round((time.monotonic() - started) * 1000))
        log.warning(
            "%s startup probe could not execute %s: %s — spawning anyway",
            dep.label, executable_display, err,
        )
        return {
            "agent_key": agent_key,
            "binary_path": executable,
            "resolved_path": resolved,
            "probe_command": command,
            "duration_ms": duration_ms,
            "reason": "exec_error",
            "degraded": True,
            "version": None,
        }

    duration_ms = max(0, round((time.monotonic() - started) * 1000))
    output = ((proc.stdout or "") + (proc.stderr or "")).strip()
    version = onboarding_deps._parse_version(output, dep.version_regex)
    signal_name: str | None = None
    if proc.returncode < 0:
        try:
            signal_name = signal.Signals(-proc.returncode).name
        except ValueError:
            signal_name = f"SIG{-proc.returncode}"
    details = {
        "agent_key": agent_key,
        "binary_path": executable,
        "resolved_path": resolved,
        "probe_command": command,
        "duration_ms": duration_ms,
        "exit_code": proc.returncode,
        "signal": signal_name,
        "version": version,
    }
    if proc.returncode != 0 and version:
        # The binary ran and identified itself; the exit code is the probe
        # command's own business. `--version`/`--help` are not always declared
        # flags — Go's stdlib `flag` exits 0 on ErrHelp, pflag and cobra do not
        # — and onboarding_deps.detect_dep already counts a parsed version as
        # installed whatever the code was. Disagreeing here is what would show
        # a CLI as installed in Settings while every pane spawn refused it.
        log.info(
            "%s startup probe exited with code %s but reported version %s — accepting",
            dep.label, proc.returncode, version,
        )
    elif proc.returncode != 0:
        cause = f"was terminated by {signal_name}" if signal_name else f"exited with code {proc.returncode}"
        message = f"{dep.label} startup probe {cause} after {duration_ms}ms ({executable_display})"
        error_details = {**details, "reason": "signal" if signal_name else "nonzero_exit"}
        if signal_name == "SIGKILL" and duration_ms < 500:
            hint = (
                "the binary may be quarantined or corrupt (e.g. a broken auto-update); "
                f"try running '{executable} --version' in a terminal"
            )
            message += f" — {hint}"
            error_details["hint"] = hint
        raise AgentCliProbeError(message, error_details)
    if dep.official_regex and re.search(dep.official_regex, output) is None:
        # A same-named CLI from someone else (issue #402: a community `grok`
        # at ~/.grok/bin/grok). The spawn goes ahead — it may be what the user
        # wants — but the pane says what it is running.
        install = dep.install_for(osplat.platform_id).command or dep.docs_url
        details["warning"] = (
            f"{executable_display} does not identify as {dep.label} "
            f"(--version printed {output.splitlines()[0][:60] if output else 'nothing'!r}); "
            f"to use {dep.label}, install it with: {install}"
        )
    return details


_HOME_PREFIX = str(Path.home())
# A whole path component only: /Users/neil must not eat /Users/neilson.
_HOME_RE = re.compile(re.escape(_HOME_PREFIX) + r"(?![\w.-])")


def _redact_home(text: str) -> str:
    """Swap the user's home directory for ``~`` in a message bound for the UI.

    ``OSError.__str__`` embeds the filename, so an unhandled FileNotFoundError
    puts an absolute path -- and the account name inside it -- into UI text
    that gets screenshotted into bug reports.
    """
    if not _HOME_PREFIX or _HOME_PREFIX == os.sep:
        return text
    return _HOME_RE.sub("~", text)


async def handle_message(session: Session, msg: dict[str, Any]) -> None:
    msg_id: str = msg.get("id", "")
    msg_type: str = msg.get("type", "")
    payload: dict[str, Any] = msg.get("payload") or {}

    try:
        # -------- strangler-fig registry dispatch --------
        _h = ws_handlers.lookup(msg_type)
        if _h is not None:
            await _h(session, msg_id, msg_type, payload)
            return
        await session.send_json(
            make_error(msg_id, msg_type, "UNKNOWN_TYPE", f"Unsupported message type: {msg_type!r}")
        )
    except AgentCliProbeError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "CLI_PROBE_FAILED", str(err), err.details)
        )
    except FileNotFoundError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "SETUP_ERROR", _redact_home(str(err)))
        )
    except KeyError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", f"missing field: {err}")
        )
    except Exception as err:  # noqa: BLE001
        log.exception("handle_message failed for type=%s", msg_type)
        error_ledger.record("backend", "error", "ws.internal_error", f"{msg_type}: {type(err).__name__}: {err}")
        if not session.dead:
            await session.send_json(
                make_error(msg_id, msg_type, "INTERNAL_ERROR", _redact_home(str(err)))
            )
