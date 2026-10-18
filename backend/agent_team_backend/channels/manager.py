"""ChannelManager: owns every chat-platform connection and both message pipelines.

One manager per backend process (OpenClaw's Gateway model): a bot token can
have only one consumer, so connections can never follow panes around.

Inbound:  dedup -> sender gate (allowlist by sender id; DM strangers get a
          pairing code, group strangers are dropped) -> binding lookup ->
          stop words interrupt the pane -> delivery through the same seam
          cli_send uses (``_dispatch_delivery``).
Outbound: after a message is injected into pane P, the first ``turn_complete``
          activity for P goes back to P's bound location. Replies never pick
          their own destination: an MSG block addressed to a chat sender
          ("telegram:alice") only narrows what is posted to the blocks' bodies.

Everything that touches the rest of the backend goes through ``Seams`` so the
pipeline is testable with fakes; ``default_seams()`` wires the real ones.
"""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import json
import logging
import math
import os
import re
import secrets
import tempfile
import time
import unicodedata
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import quote

from . import media, pdf, quick_menu, redact, relay, report, share_cmds, wake
from .. import error_ledger, prompt_skills
from .mirror import (
    CHILD_SUMMARY_CHARS, MSG_SUMMARY_TAIL, Mirror, normalize_verbosity, result_text, source_chat, summarize,
)
from .base import ChannelAdapter, InboundMessage, Location, MediaTooLarge
from .pairing import LinkInvites, SenderGate, parse_link_code
from .registry import PLATFORMS, load_module
from .store import DEFAULT_ACCOUNT, DEFAULT_VERBOSITY, VERBOSITIES, Binding, ChannelStore
from .text import chunk_for, msg_blocks, strip_msg_markers

log = logging.getLogger(__name__)

STOP_WORDS = {"stop", "停止", "/stop", "esc"}
CANCEL_WORDS = {"/cancel"}
RESUME_WORDS = {"/resume"}
# The busy acknowledgement's and the stop reply's buttons; a press is handled exactly as
# the typed command.
CANCEL_CALLBACK = "nv4:cancel"
STOP_CALLBACK = "nv4:stop"
RESUME_CALLBACK = "nv4:resume"
PROMPTS_CALLBACK = "nv4:prompts"
SKILLS_CALLBACK = "nv4:skills"
MCP_CALLBACK = "nv4:mcp"
WAKE_CALLBACK = "nv4:wake"
WAKE_WORDS = {"/wake"}
_CALLBACK_COMMANDS = {CANCEL_CALLBACK: "/cancel", STOP_CALLBACK: "stop", RESUME_CALLBACK: "/resume",
                      PROMPTS_CALLBACK: "/prompts", SKILLS_CALLBACK: "/skills", MCP_CALLBACK: "/mcp",
                      WAKE_CALLBACK: "/wake"}
DEDUP_MAX = 5000
MAX_QUEUED_PER_PANE = 20
# A person's own cap on lines into one pane. Chat deliveries skip the window's agent-to-agent
# loop guard (5 per pair per minute), which refused a person's sixth short line in a row.
CHAT_RATE_MAX = 30
CHAT_RATE_WINDOW_S = 60.0
STATUS_EDIT_MIN_INTERVAL_S = 1.0
STATUS_EDIT_MAX_FAILURES = 3
STATUS_EDIT_EVERY_S = 5.0
STATUS_SEND_WAIT_S = 5.0  # how long a turn's end waits for a status message still on its way
TYPING_EVERY_S = 4.0
AWAITING_PROBE_EVERY_S = 5.0
AWAITING_RETRY_MAX = 3  # relay attempts per awaiting prompt before giving up
LIMIT_PROBE_EVERY_S = 15.0  # a running chat run asks the window whether its CLI hit a usage limit
RUN_TICK_S = 0.5
# Claude can write one message as two end_turn lines, thinking only and then the text; across
# 3912 such splits in local transcripts the text came 1.9 s later at the median, 26.6 s at p99
# and 110 s at most. A turn end with no text waits this long for its text before saying so.
EMPTY_TURN_GRACE_S = 120.0
RUN_WATCH_MAX_S = 1800.0  # stop typing/editing after this; a late turn_complete still replies
VERDICT_POLL_S = 5.0
# Right after a restart a platform hands over what queued while Navide was down, before the
# windows have registered their panes again: a pane that does not resolve yet is waited for
# this long after start instead of being answered offline.
STARTUP_GRACE_S = 60.0
STARTUP_POLL_S = 1.0
HELD_NOTICE_AFTER_S = 600.0
HOLD_FAILURE_KEYS = {"gone", "not-ready"}
HOLD_FAILURE_AFTER_S = 60.0
VERDICT_WATCH_MAX_S = 3600.0
STATUS_POLL_S = 1.0
DEBOUNCE_S = 0.5  # lines from one sender to one location within this window become one message
DEBOUNCE_MAX_S = 3.0
LONG_REPLY_MAX_CHUNKS = 3  # past this, a reply is a preview plus the whole text as a file
REPLY_QUOTE_MAX_CHARS = 500  # a native reply's quoted message, cut before it reaches the pane
REPLY_QUOTE_NAME_MAX_CHARS = 64
# Fixed wording: an untrusted author's display name is attacker-controlled text too.
REPLY_QUOTE_OMITTED = "[Replying to a message from a sender who is not allowed here; quote omitted]"

MSG_RECEIVED_BUSY = "已收到，等 pane 空檔…"
MSG_WORKING = "⏳ pane 處理中…"
MSG_NOT_BOUND = "此主題尚未連接 pane"
MSG_INTERRUPTED = "⏹ 已送出中斷"
MSG_INTERRUPTED_QUEUED = "（還有 {n} 則在排隊；傳 /cancel 撤回）"
MSG_CANCELLED = "↩️ 已撤回 {n} 則還沒送進 pane 的訊息"
MSG_CANCEL_NONE = "沒有可以撤回的訊息（已經送進 pane 的不能撤回）"
MSG_CANCEL_LATE = "；{n} 則已經送進 pane，來不及撤回"
MSG_CANCEL_UNSURE = "；{n} 則視窗沒有回應，可能仍會送進 pane"
MSG_RESUMED = "▶️ 已恢復，排隊中的訊息會繼續送進 pane"
MSG_NOT_STOPPED = "pane 沒有停住，不需要恢復"
RESUME_BUTTONS = [("▶️ 繼續", RESUME_CALLBACK)]
# A pane that is not online but can be woken onto its own conversation.
WAKE_BUTTONS = [("▶️ 喚醒", WAKE_CALLBACK)]
# /menu and a bare /start point to the three commands that replaced the quick menu.
MENU_MOVED_BUTTONS = [("💬 Prompts", PROMPTS_CALLBACK), ("🧩 Skills", SKILLS_CALLBACK), ("🔌 MCP", MCP_CALLBACK)]
# Where a platform has no buttons, the reply names the commands they stand for.
MSG_TYPED_HINT = "可直接輸入：{commands}"
BUSY_BUTTONS = [("↩️ 撤回排隊中的訊息", CANCEL_CALLBACK), ("⏹ 中斷 pane", STOP_CALLBACK)]
MSG_UNBOUND = "🔌 這個聊天室已和 pane「{name}」中斷連接，之後的訊息不會再送進 pane。"
MSG_BOUND = "🔗 已連接 pane「{name}」，在這裡傳的訊息會送進這個 pane；傳 stop 可以中斷。"
MSG_CHAT_TAKEN = "這個聊天室已連接到另一個 pane，請先在那個 pane 解除連接"
MSG_UNBOUND_CLOSED = "🔌 pane「{name}」已關閉，這個聊天室已中斷連接。"
MSG_QUEUE_FULL = "⚠️ 這個 pane 已有太多訊息在排隊，請稍後再傳"
MSG_CHAT_RATE = "⚠️ 1 分鐘內傳了超過 {max} 則，這則沒有送進 pane，請 {wait} 秒後重送"
MSG_EMPTY_REPLY = "（pane 回合結束，沒有文字輸出）"
MSG_STILL_RUNNING = "⏳ 仍在執行，完成時會再回覆"
MSG_USAGE_LIMIT = "⚠️ {agent} 額度已用完，{reset} 重置"
MSG_USAGE_LIMIT_NO_RESET = "⚠️ {agent} 額度已用完（重置時間未知）"
MSG_USAGE_LIMIT_MENU = "pane 停在額度選單：1 停下等重置／2 原地等待，重置後自動繼續／3 改用 usage credits"
MSG_USAGE_LIMIT_KEPT = "這則請求先保留，重置後的回覆會照樣送到這裡"
# Claude Code's limit menu, read off the pane's screen (whitespace collapsed). The window's
# awaiting detector does not match it (its footer says "confirm", not "select"), and widening
# that detector would also hold deliveries to the pane, so the channel reads the menu itself.
_LIMIT_MENU_RE = re.compile(r"Stop and wait for limit to reset.{0,300}?Enter to confirm · Esc to cancel")
_LIMIT_RESETS_RE = re.compile(r"hit your .{0,40}?limit\W{0,5}resets\s+(.{3,60}?\([^)]+\))")
MSG_OFFLINE = wake.text(wake.DEFAULT_LANGUAGE, "offline")
MSG_RELAY_EXPIRED = "⚠️ 這個確認已失效"
MSG_RELAY_PROMPT_CHANGED = "⚠️ 畫面上的確認已經換了，這個回覆沒有送出；請在新的確認訊息重新選擇"
# Appended to a relay prompt whose request lapsed, when the platform can edit it.
MSG_RELAY_DONE_LOCALLY = "✔ 已在電腦上處理"
MSG_RELAY_SUPERSEDED = "↪ 已被新的確認取代"
MSG_RELAY_TURN_ENDED = "✔ 回合已結束，不需要再確認"
MSG_RELAY_PANE_GONE = "⚠️ pane 已離線，這個確認已失效"
MSG_RELAY_ANSWERED_IN_CHAT = "✅ 已在聊天室回答："  # + the answer
MSG_RELAY_PERMANENT = "⚠️ 這個選項會永久放行，請在電腦前操作"
MSG_RELAY_NEEDS_LOCAL = "⚠️ 這個動作需要在電腦前確認"
MSG_AWAITING_LOCAL = "pane 在等確認，請在電腦上回答"
MSG_PENDING_NONE = "目前沒有等待確認的 pane"
MSG_PENDING_RELISTED = "↓ 已重新列在下方"
MSG_HELD_BY_PROMPT = "⚠️ pane 正在等確認，這則訊息沒有送出。{how}"
MSG_LINKED = "✅ 已連結 Navide。回到 Navide 在 pane 的聊天按鈕選這個聊天室即可。"
MSG_LINK_FAILED = "⚠️ 連結失敗，請回到 Navide 重新取得代碼"
LINK_TARGETS = ("direct", "group")
QUICK_ADD_TIMEOUT_S = 10.0  # how long a quick add waits for the platform to accept the credential
QUICK_ADD_POLL_S = 0.1
# A whole quick add, the channels lock included: under the window's 45 s (QUICK_ADD_TIMEOUT_MS)
# with room for the undo of a failure (a Keychain delete, up to 10 s) and the round trips.
QUICK_ADD_DEADLINE_S = 30.0
# Telegram Managed Bots (Bot API 9.6): how long a t.me/newbot link waits for its bot.
MANAGED_REQUEST_TTL_S = 600.0
MANAGED_DEFAULT_NAME = "Navide bot"
# Telegram's username limit for bots made in BotFather; unverified for managed bots.
TELEGRAM_USERNAME_MAX = 32
_TELEGRAM_USERNAME_RE = re.compile(r"^[A-Za-z0-9_]+$")


# A bot is (platform, account). "default" is every bot from before several bots
# per platform; added bots get a generated slug that never changes on rename.
BotKey = tuple[str, str]
_ACCOUNT_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")


def _secret_name(platform: str, account: str = DEFAULT_ACCOUNT) -> str:
    return f"channel-{platform}-{account}"


def _legacy_secret_name(platform: str) -> str:
    """Where the one bot per platform kept its secret before accounts; still read for "default"."""
    return f"channel-{platform}"


@dataclass
class Seams:
    """Everything the manager needs from the rest of the backend."""

    # (pane_id, text, from_display) -> {ok, msg_key, pane_id, error?}
    deliver: Callable[[str, str, str], Awaitable[dict[str, Any]]]
    # (msg_key, timeout) -> {status: queued|delivered|failed|cancelled, reason, hold, age_s}
    await_verdict: Callable[[str, float], Awaitable[dict[str, Any]]]
    interrupt: Callable[[str], Awaitable[dict[str, Any]]]
    # pane_id -> {exists, busy, display_status}; cheap, no UI round trip
    pane_state: Callable[[str], dict[str, Any]]
    # pane_id -> {kind: "permission"|"question"|"", prompt: str, options: [str]}, via the UI probe
    awaiting_info: Callable[[str], Awaitable[dict[str, Any]]]
    # (pane_id, answer, expected?) -> {ok, error?, error_code?}; answer is the ui.pane.sendKeys
    # payload, expected the {prompt, options} the window must still show before it presses
    answer: Callable[..., Awaitable[dict[str, Any]]]
    resolve_pane: Callable[[str], str]  # alias -> current pane id ("" if unknown)
    broadcast: Callable[[str, dict[str, Any]], Awaitable[None]]
    read_secret: Callable[[str], Awaitable[str | None]]
    write_secret: Callable[[str, str | None], Awaitable[None]]
    # pane_id -> its workspace path ("" if unknown); scopes Navide Guard's paths
    pane_workspace: Callable[[str], str] = lambda _pane_id: ""
    # () -> every mirrored pane as {pane_id, name, qualified_name, spawned_by, display_status};
    # lineage for two-way mirroring, straight from the messaging registry (no I/O)
    pane_directory: Callable[[], list[dict[str, Any]]] = lambda: []
    # (child_pane_id, parent_pane_id): a child of a tainted pane is tainted too
    inherit_taint: Callable[[str, str], None] = lambda _child, _parent: None
    # () -> the renderer's ui settings (prompt skills, language); blocking, run off the loop
    ui_settings: Callable[[], dict[str, Any]] = lambda: {}
    # pane_id -> its CLI vendor key ("" if unknown)
    pane_agent: Callable[[str], str] = lambda _pane_id: ""
    # agent_key -> skill names that CLI can run (quick_menu.agent_skills); blocking
    agent_skills: Callable[[str], list[str]] = lambda _agent_key: []
    # () -> where inbound chat files are kept (channels.media)
    media_root: Callable[[], Path] = lambda: _default_media_root()
    # () -> where HTML attachments are printed to PDF (channels.pdf)
    pdf_root: Callable[[], Path] = lambda: _default_pdf_root()
    # (html_path, pdf_path, timeout_ms) -> {ok, error_code?}: the Host prints a PDF
    render_pdf: Callable[[Path, Path, int], Awaitable[dict[str, Any]]] = pdf.request_host
    # pane_id -> {until: ms | None, buffer: str}: the pane's usage-limit reading and screen
    # tail, via the UI probe; read-only, never a quota fetch
    limit_info: Callable[[str], Awaitable[dict[str, Any]]] = lambda _pane_id: _no_limit()
    # msg_key -> its settled status after asking the window to withdraw it ("cancelled" when it
    # did; "delivered"/"failed" when too late; "queued" when no window answered; "unknown")
    cancel: Callable[[str], Awaitable[str]] = lambda _msg_key: _no_cancel()
    # pane_id -> {ok, error?}: clear the pane's stopped flag, as the user typing into it does
    resume: Callable[[str], Awaitable[dict[str, Any]]] = lambda _pane_id: _no_resume()
    # /mcp, read-only and allowlisted (channels.mcp_menu). agent_key -> that CLI's own
    # servers from its config file, never started; blocking
    agent_mcp: Callable[[str], list[dict[str, Any]]] = lambda _agent_key: []
    # () -> Navide's own servers as {name, status, tool_count}
    navide_mcp: Callable[[], Awaitable[list[dict[str, Any]]]] = lambda: _no_rows()
    # server name -> its tool names; [] when not running, None when tools/list timed out
    navide_mcp_tools: Callable[[str], Awaitable[list[str] | None]] = lambda _name: _no_tools()
    # pane_id -> {workspace_path, session_id} of an online pane, what a later wake resumes;
    # {} when unknown. Blocking (reads the workspace's pane records)
    wake_target: Callable[[str], dict[str, str]] = lambda _pane_id: {}
    # () -> whether any Navide window is connected
    windows_open: Callable[[], bool] = lambda: True
    # (pane_id, workspace_path, session_id) -> {ok, pane_id} with the pane back on that same
    # conversation, or {ok: False, code, started, detail?, agent?}; never a fresh conversation.
    # `started` is False when it was refused before anything was opened
    wake: Callable[[str, str, str], Awaitable[dict[str, Any]]] = lambda *_a: _no_wake()


async def _no_limit() -> dict[str, Any]:
    return {}


async def _no_cancel() -> str:
    return "unknown"


async def _no_rows() -> list[dict[str, Any]]:
    return []


async def _no_tools() -> list[str] | None:
    return []


async def _no_wake() -> dict[str, Any]:
    return {"ok": False, "code": "no-window", "started": False}


async def _no_resume() -> dict[str, Any]:
    return {"ok": False, "error": "not supported"}


AdapterFactory = Callable[[dict[str, Any], dict[str, Any], ChannelStore], ChannelAdapter]


def _bot_key(adapter: ChannelAdapter) -> str:
    """Which bot saw a chat: a short prefix of the token fingerprint (the lease key)."""
    return adapter.token_fingerprint()[:16]


def default_adapter_factory(platform: str) -> AdapterFactory | None:
    """``channels.<platform>.create_adapter(config, secret, *, store)``, else the
    module's ``<Platform>Adapter(token, account=...)`` for single-token platforms."""
    mod = load_module(platform)
    if mod is None:
        return None
    create = getattr(mod, "create_adapter", None)
    if create is not None:
        return lambda config, secret, store: create(config, secret, store=store)
    cls = getattr(mod, f"{platform.capitalize()}Adapter", None)
    if cls is None:
        return None

    def build(config: dict[str, Any], secret: dict[str, Any], store: ChannelStore) -> ChannelAdapter:
        token = secret.get("token")
        if not token:
            raise ValueError("missing token")
        return cls(token, account=str(config.get("account") or "default"))

    return build


@dataclass
class _Pending:
    """A pane that owes its bound location a reply."""

    loc: Location
    armed_at: float | None = None  # monotonic time the message went in; None while queued
    status_id: str = ""
    status_send: asyncio.Task[str] | None = None  # the status message's send, while its id is not back
    status_failures: int = 0
    last_edit: float = 0.0
    started: float = field(default_factory=time.monotonic)
    awaiting_posted: bool = False
    task: asyncio.Task[None] | None = None
    # Two-way mirroring: what started the turn ("💬 alice" / "🖥 本機" / "🤖 pane"), the
    # child name when the pane rides its ancestor's chat, and how much of the run to show.
    source: str = ""
    child: str = ""
    quiet: bool = False  # no typing / status message (replies/minimal, or a child in the parent chat)
    silent: bool = False  # no result either (replies, or a child at minimal verbosity)
    summary: bool = False  # child result in the parent chat below full: a short excerpt
    owner: str = ""  # pane whose messages these are, for reply-to routing
    limit_noticed: bool = False  # the chat was told this run's pane hit a usage limit
    next_limit_probe: float = 0.0


@dataclass
class _ManagedRequest:
    """A t.me/newbot link handed out for ``manager`` (a Telegram bot account), awaiting its bot."""

    request_id: str
    manager: str
    username: str
    timer: asyncio.Task[None] | None = None


@dataclass
class _Shown:
    """The awaiting prompt a pane last showed its chat."""

    prompt: str
    request_id: str = ""  # its live relay id; "" for a notice, or once answered


@dataclass
class _Worker:
    jobs: deque[Callable[[], Awaitable[None]]] = field(default_factory=deque)
    task: asyncio.Task[None] | None = None


@dataclass
class _Debounce:
    """Lines from one sender to one location, waiting to be joined."""

    msg: InboundMessage
    binding: Binding
    pane_id: str
    texts: list[str]
    first_at: float
    task: asyncio.Task[None] | None = None
    attachments: list[Any] = field(default_factory=list)


class ChannelManager:
    def __init__(
        self,
        store: ChannelStore,
        seams: Seams,
        *,
        factory_for: Callable[[str], AdapterFactory | None] = default_adapter_factory,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.store = store
        self.gate = SenderGate(store)
        self.invites = LinkInvites()
        self._seams = seams
        self._factory_for = factory_for
        self._clock = clock
        self._started_at = clock()
        self._adapters: dict[BotKey, ChannelAdapter] = {}
        self._lease: dict[str, BotKey] = {}  # token fingerprint -> bot
        self._errors: dict[BotKey, str] = {}  # bot -> config error shown in status
        self._secret_hints: dict[BotKey, str] = {}
        self._dedup: OrderedDict[tuple[str, str], None] = OrderedDict()
        self._pending: dict[str, _Pending] = {}
        # pane_id -> a run whose turn ended with no text, and the timer that answers it empty
        self._textless: dict[str, tuple[_Pending, asyncio.Task[Any]]] = {}
        self._queued: dict[str, set[str]] = {}  # pane_id -> msg_keys still queued
        self._queued_loc: dict[str, str] = {}  # msg_key -> the chat location that sent it
        self._chat_sends: dict[tuple[str, str], list[float]] = {}  # (pane_id, sender_id) -> send times
        self._last_status: dict[BotKey, dict[str, Any]] = {}
        self._tasks: set[asyncio.Task[Any]] = set()
        self._status_task: asyncio.Task[None] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock = asyncio.Lock()
        self._quick_adding: set[BotKey] = set()  # bots a quick add is storing and verifying
        # Undos of half-added bots: apart from _tasks so stop() does not cut one short.
        self._quick_add_undos: dict[BotKey, asyncio.Task[None]] = {}
        # Credential writes still running: a cancelled caller stops waiting for one,
        # not the vault write itself, so an undo waits for it before deleting.
        self._secret_writes: dict[BotKey, asyncio.Task[None]] = {}
        # Memory only: a backend restart forgets them, and a later managed_bot update is ignored.
        self._managed: dict[str, _ManagedRequest] = {}  # request_id -> open t.me/newbot request
        self.relay = relay.RelayTable(clock=clock, on_expired=self._relay_expired)
        self.quick = quick_menu.QuickMenus(clock=clock)
        self.share_buttons = share_cmds.RevokeButtons(clock=clock)
        self._debounce: dict[tuple[str, str], _Debounce] = {}
        self._media_pruned_at: float | None = None
        # One serial worker per location: order kept within a chat, chats never block each other.
        self._workers: dict[str, _Worker] = {}
        self._known_panes: set[str] = set()
        self._awaiting_posted: set[str] = set()
        self._awaiting_failures: dict[str, int] = {}
        self._awaiting_shown: dict[str, _Shown] = {}
        self._awaiting_busy: set[str] = set()  # panes whose prompt is being read or relayed
        self._turn_source: dict[str, str] = {}
        self._wake_limits = wake.WakeLimits(clock=clock)
        # location -> (kept at, message): what reached a pane that was not online, for its wake
        self._wake_kept: dict[str, list[tuple[float, InboundMessage]]] = {}
        self.mirror = Mirror(self)

    # --- lifecycle --------------------------------------------------------------

    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._started_at = self._clock()
        # No conversion outlives a backend: whatever is there was left by a crash.
        await asyncio.to_thread(pdf.clear, self._seams.pdf_root())
        if self._status_task is None:
            self._status_task = asyncio.create_task(self._status_watch(), name="channels-status")
        self._adopt_lost_kept()
        if self.store.global_enabled():
            for (platform, account), acct in self.store.accounts().items():
                if acct["enabled"]:
                    await self._start_bot(platform, account)
        self.mirror.schedule_sync()

    async def stop(self) -> None:
        if self._status_task:
            self._status_task.cancel()
            self._status_task = None
        for platform, account in list(self._adapters):
            await self._stop_bot(platform, account)
        self._workers.clear()
        self._debounce.clear()
        self.mirror.stop()
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()

    # --- per-location workers ---------------------------------------------------------

    def _enqueue(self, location_key: str, job: Callable[[], Awaitable[None]]) -> None:
        worker = self._workers.get(location_key)
        if worker is None:
            worker = _Worker()
            self._workers[location_key] = worker
        worker.jobs.append(job)
        if worker.task is None:
            worker.task = self._spawn(self._run_worker(location_key, worker))

    async def _run_worker(self, location_key: str, worker: _Worker) -> None:
        while worker.jobs:
            job = worker.jobs.popleft()
            try:
                await job()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 — one bad message must not stall the chat
                log.exception("channels: inbound job for %s failed", location_key)
        # Idle: retire. No await between the empty check above and this removal,
        # so a job enqueued from here on starts a fresh worker.
        if self._workers.get(location_key) is worker:
            del self._workers[location_key]

    def _cancel_workers(self) -> None:
        for worker in self._workers.values():
            if worker.task:
                worker.task.cancel()
        self._workers.clear()
        for buf in self._debounce.values():
            if buf.task:
                buf.task.cancel()
        self._debounce.clear()

    async def wait_idle(self) -> None:
        """Until every queued inbound job has run (tests, orderly shutdown)."""
        while self._workers or self._debounce:
            pending = [w.task for w in self._workers.values() if w.task]
            pending += [b.task for b in self._debounce.values() if b.task]
            if not pending:
                return
            await asyncio.wait(pending)

    def _spawn(self, coro: Awaitable[Any]) -> asyncio.Task[Any]:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._task_done)
        return task

    def _task_done(self, task: asyncio.Task[Any]) -> None:
        self._tasks.discard(task)
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None:
            log.error("channels: background task %s failed", task.get_name(), exc_info=exc)

    def adapter_for(self, platform: str, account: str = DEFAULT_ACCOUNT) -> ChannelAdapter | None:
        """The running bot ``account`` on ``platform``; None when it is not connected."""
        return self._adapters.get((platform, account))

    async def _load_secret(self, platform: str, account: str) -> dict[str, Any] | None:
        raw = await self._seams.read_secret(_secret_name(platform, account))
        if not raw and account == DEFAULT_ACCOUNT:
            raw = await self._seams.read_secret(_legacy_secret_name(platform))
        if not raw:
            return None
        try:
            secret = json.loads(raw)
        except json.JSONDecodeError:
            return None
        return secret if isinstance(secret, dict) else None

    def _build(self, platform: str, account: str, config: dict[str, Any], secret: dict[str, Any]) -> ChannelAdapter:
        factory = self._factory_for(platform)
        if factory is None:
            raise ValueError(f"{platform} adapter is not available in this build")
        adapter = factory({**config, "account": account}, secret, self.store)
        # Every location, inbound message and offset carries the adapter's account:
        # a bot that ignored it would route into another bot's bindings.
        if str(getattr(adapter, "account", DEFAULT_ACCOUNT)) != account:
            raise ValueError(f"{platform} adapter did not take account {account!r}")
        return adapter

    def _lease_holder(self, fingerprint: str, bot: BotKey) -> str | None:
        holder = self._lease.get(fingerprint)
        return _bot_label(holder) if holder and holder != bot else None

    async def _start_bot(self, platform: str, account: str, secret: dict[str, Any] | None = None) -> str | None:
        """Start (or restart) one bot. Returns an error string or None."""
        bot = (platform, account)
        await self._stop_bot(platform, account)
        acct = self.store.accounts().get(bot)
        if acct is None:
            return "not configured"
        try:
            if secret is None:
                secret = await self._load_secret(platform, account)
            if not secret:
                raise ValueError("尚未設定憑證 (no credential stored)")
            self._secret_hints[bot] = _mask_secret(secret)
            for value in secret.values():
                if isinstance(value, str):
                    redact.add_secret(value)
            adapter = self._build(platform, account, acct["config"], secret)
        except Exception as exc:  # noqa: BLE001 — surfaced as the bot's status
            self._errors[bot] = str(exc)
            return str(exc)
        fp = adapter.token_fingerprint()
        holder = self._lease_holder(fp, bot)
        if holder:
            err = f"同一個 token 已被 {holder} 使用 (token already leased by {holder})"
            self._errors[bot] = err
            return err
        self._lease[fp] = bot
        self._errors.pop(bot, None)
        self._adapters[bot] = adapter
        try:
            self.store.adopt_chats(platform, _bot_key(adapter))
        except Exception as exc:  # noqa: BLE001 — only the picker's list depends on it
            log.warning("channels: adopting seen chats for %s failed: %s", platform, exc)

        async def emit(msg: InboundMessage) -> None:
            await self.handle_inbound(msg)

        if hasattr(adapter, "on_managed_bot"):
            async def on_managed_bot(update: dict[str, Any]) -> None:
                self._on_managed_bot(platform, account, adapter, update)

            adapter.on_managed_bot = on_managed_bot
        if hasattr(adapter, "command_language"):
            # Telegram describes its "/" menu in the language the rest of Navide speaks.
            adapter.command_language = lambda: prompt_skills.language(self._seams.ui_settings())
        await adapter.start(emit)
        await self._report_lost_kept(bot)
        return None

    async def _stop_bot(self, platform: str, account: str) -> None:
        bot = (platform, account)
        adapter = self._adapters.pop(bot, None)
        if adapter is None:
            return
        for fp, holder in list(self._lease.items()):
            if holder == bot:
                del self._lease[fp]
        try:
            await adapter.stop()
        except Exception:  # noqa: BLE001
            log.exception("channels: stopping %s failed", _bot_label(bot))

    # --- status -----------------------------------------------------------------

    def _status_of(self, platform: str, account: str = DEFAULT_ACCOUNT) -> dict[str, Any]:
        bot = (platform, account)
        adapter = self._adapters.get(bot)
        if adapter is not None:
            return dataclasses.asdict(adapter.status)
        status: dict[str, Any] = {
            "lifecycle": "stopped", "connected": False, "reconnect_attempts": 0,
            "last_error": "", "last_connected_at": None, "last_inbound_at": None, "identity": "",
            "display_name": "",
        }
        if bot in self._errors:
            status["lifecycle"] = "blocked"
            status["last_error"] = self._errors[bot]
        return status

    async def _status_watch(self) -> None:
        while True:
            await asyncio.sleep(STATUS_POLL_S)
            try:
                await self.broadcast_status_changes()
            except Exception:  # noqa: BLE001
                log.exception("channels: status broadcast failed")

    async def broadcast_status_changes(self) -> None:
        bots = {(p, DEFAULT_ACCOUNT) for p in PLATFORMS} | set(self._adapters) | set(self._errors) | set(self._last_status)
        for platform, account in sorted(bots):
            status = self._status_of(platform, account)
            if self._last_status.get((platform, account)) != status:
                self._last_status[(platform, account)] = status
                await self._seams.broadcast("channels.status",
                                            {"platform": platform, "account": account, "status": status})

    # unbind_many holds channels.changed so a batch goes out as one event.
    _changed_hold = 0
    _changed_missed = False

    async def _changed(self) -> None:
        if self._changed_hold:
            self._changed_missed = True
            return
        await self._seams.broadcast("channels.changed", {})

    # --- WS-facing API ------------------------------------------------------------

    def _sync_bindings(self) -> bool:
        """Follow panes to their current ids (an app restart re-registers every
        pane under a new id with its old ones as aliases). True if any moved."""
        changed = False
        bindings = self.store.bindings()
        taken = {b.pane_id for b in bindings}
        for b in bindings:
            current = self._seams.resolve_pane(b.pane_id)
            if current and current != b.pane_id and current not in taken:
                if self.store.rename_pane(b.pane_id, current):
                    self.mirror.rename_pane(b.pane_id, current)
                    taken.discard(b.pane_id)
                    taken.add(current)
                    changed = True
        if changed and self._loop is not None:
            self._spawn(self._changed())
        return changed

    def _bot_state(self, platform: str, account: str, acct: dict[str, Any] | None) -> dict[str, Any]:
        adapter = self._adapters.get((platform, account))
        config = acct["config"] if acct else {}
        return {
            "account": account,
            "name": str(config.get("name") or ""),
            "configured": acct is not None,
            "enabled": bool(acct and acct["enabled"]),
            "status": self._status_of(platform, account),
            "config": {**config, "secret_hint": self._secret_hints.get((platform, account), "")},
            "capabilities": dataclasses.asdict(adapter.capabilities) if adapter is not None else None,
        }

    def list(self) -> dict[str, Any]:
        """Per platform: its bots under ``accounts`` ("default" first), and the first
        bot's state flattened onto the platform as before several bots existed."""
        self._sync_bindings()
        accounts = self.store.accounts()
        platforms = []
        for platform in PLATFORMS:
            bots = [self._bot_state(platform, a, acct) for (p, a), acct in accounts.items() if p == platform]
            first = bots[0] if bots else self._bot_state(platform, DEFAULT_ACCOUNT, None)
            platforms.append({
                "platform": platform,
                "configured": bool(bots),
                "enabled": any(b["enabled"] for b in bots),
                "status": first["status"],
                "config": first["config"],
                "capabilities": first["capabilities"],
                "accounts": bots,
            })
        return {"enabled": self.store.global_enabled(), "platforms": platforms}

    async def configure(self, platform: str, config: dict[str, Any], secret: dict[str, Any] | None,
                        account: str = DEFAULT_ACCOUNT) -> dict[str, Any]:
        _check_platform(platform)
        _check_account(account)
        bot = (platform, account)
        config = {k: v for k, v in (config or {}).items() if k not in ("secret_hint", "account")}
        async with self._lock:
            if secret is not None:
                # Refuse a token another bot already polls with before storing anything.
                try:
                    probe = self._build(platform, account, config, secret)
                except Exception as exc:  # noqa: BLE001
                    return {"ok": False, "error": str(exc)}
                holder = self._lease_holder(probe.token_fingerprint(), bot)
                if holder:
                    return {"ok": False, "error": f"同一個 token 已被 {holder} 使用 (token already in use by {holder})"}
                write = asyncio.ensure_future(self._seams.write_secret(
                    _secret_name(platform, account), json.dumps(secret, separators=(",", ":"), ensure_ascii=True)
                ))
                self._secret_writes[bot] = write
                write.add_done_callback(
                    lambda done, bot=bot: self._secret_writes.pop(bot, None)
                    if self._secret_writes.get(bot) is done else None
                )
                await asyncio.shield(write)
            self.store.upsert_account(platform, config, account=account)
            err = None
            acct = self.store.accounts()[bot]
            if self.store.global_enabled() and acct["enabled"]:
                err = await self._start_bot(platform, account, secret)
        await self._changed()
        await self.broadcast_status_changes()
        return {"ok": err is None, "platform": platform, "account": account, **({"error": err} if err else {})}

    async def quick_add(self, platform: str, config: dict[str, Any], secret: dict[str, Any] | None,
                        account: str, link_target: str = "") -> dict[str, Any]:
        """Add a new bot in one step: ``configure`` it, wait until the platform accepted
        its credential, name it after its identity when unnamed, and with ``link_target``
        hand back a link invite (as ``link_create``). Any failure removes everything this
        call stored; ``reason`` is "rejected" (credential refused), "timeout" or "invalid"
        (refused before connecting). The whole call ends within QUICK_ADD_DEADLINE_S."""
        _check_platform(platform)
        _check_account(account)
        try:
            return await asyncio.wait_for(self._quick_add(platform, config, secret, account, link_target),
                                          QUICK_ADD_DEADLINE_S)
        except asyncio.TimeoutError:
            bot = (platform, account)
            self._undo_quick_add(platform, account)  # e.g. cancelled after it succeeded, while naming it
            return {"ok": False, "reason": "timeout",
                    "error": f"adding {_bot_label(bot)} did not finish within {QUICK_ADD_DEADLINE_S:g}s"}

    async def _quick_add(self, platform: str, config: dict[str, Any], secret: dict[str, Any] | None,
                         account: str, link_target: str) -> dict[str, Any]:
        bot = (platform, account)
        if bot in self.store.accounts() or bot in self._quick_adding:
            return {"ok": False, "reason": "invalid", "error": f"{_bot_label(bot)} is already configured"}
        if not self.store.global_enabled():
            return {"ok": False, "reason": "invalid", "error": "chat channels are turned off"}
        self._quick_adding.add(bot)
        try:
            result = await self.configure(platform, config, secret, account)
            if not result.get("ok"):
                if bot in self.store.accounts():  # stored, but the bot could not start
                    await self._discard_bot(platform, account)
                return {"ok": False, "reason": "invalid", "error": result.get("error") or "configure failed"}
            adapter = self._adapters.get(bot)
            if adapter is None:  # stored but never started (channels turned off meanwhile): unverified
                await self._discard_bot(platform, account)
                return {"ok": False, "reason": "invalid", "error": "the bot did not start"}
            failure = await self._await_first_login(bot, adapter)
            if failure is not None:
                await self._discard_bot(platform, account)
                return {"ok": False, **failure}
        except BaseException:
            # Cancelled (the asking window went away, the deadline passed) or failed midway:
            # the caller never hears of this bot, so it must not stay.
            self._undo_quick_add(platform, account)
            raise
        finally:
            if bot not in self._quick_add_undos:
                self._quick_adding.discard(bot)
        identity = adapter.status.identity
        async with self._lock:
            acct = self.store.accounts().get(bot)
            if acct is not None and not acct["config"].get("name") and identity:
                self.store.upsert_account(platform, {**acct["config"], "name": identity}, account=account)
        await self._changed()
        name = str(((self.store.accounts().get(bot) or {}).get("config") or {}).get("name") or "")
        link = self.link_create(platform, link_target, account) if link_target else {}
        return {"ok": True, "platform": platform, "account": account, "name": name, "identity": identity,
                "link": {k: v for k, v in link.items() if k != "ok"} if link.get("ok") else None}

    async def _await_first_login(self, bot: BotKey, adapter: ChannelAdapter) -> dict[str, str] | None:
        """None once ``adapter`` reached ready, or reported an identity when it says that
        proves the credential (or never reports progress at all); otherwise why it did
        not within QUICK_ADD_TIMEOUT_S."""
        status = adapter.status
        identity_proves = bool(getattr(adapter, "identity_confirms_credential", False))
        # An adapter that never left "stopped" has no login signal to wait for.
        if status.lifecycle == "stopped":
            return None

        async def settled() -> dict[str, str] | None:
            while True:
                if status.lifecycle == "blocked":
                    return {"reason": "rejected", "error": status.last_error or "credential rejected"}
                if status.lifecycle == "ready" or (identity_proves and status.identity):
                    return None
                if self._adapters.get(bot) is not adapter:
                    return {"reason": "invalid", "error": "the bot was stopped while connecting"}
                await asyncio.sleep(QUICK_ADD_POLL_S)

        try:
            return await asyncio.wait_for(settled(), QUICK_ADD_TIMEOUT_S)
        except asyncio.TimeoutError:
            detail = f": {status.last_error}" if status.last_error else ""
            return {"reason": "timeout", "error": f"no answer from {bot[0]} within {QUICK_ADD_TIMEOUT_S:g}s{detail}"}

    def _undo_quick_add(self, platform: str, account: str) -> None:
        """Discard a half-added bot in the background, never waited for: the lock the undo
        needs may be what held the quick add up. The bot stays reserved in _quick_adding
        until it is gone, so adding it again cannot race the undo; a second call is a no-op."""
        bot = (platform, account)
        pending_write = self._secret_writes.get(bot)
        if bot in self._quick_add_undos or (
            bot not in self.store.accounts() and bot not in self._adapters and pending_write is None
        ):
            return
        self._quick_adding.add(bot)

        async def undo() -> None:
            try:
                if pending_write is not None:
                    # Cancelled mid-store: let the write land, then delete what it wrote.
                    with contextlib.suppress(Exception):
                        await pending_write
                await self._discard_bot(platform, account)
            except Exception:  # noqa: BLE001
                log.exception("channels: undoing the quick add of %s failed", _bot_label(bot))
            finally:
                self._quick_add_undos.pop(bot, None)
                self._quick_adding.discard(bot)

        self._quick_add_undos[bot] = asyncio.ensure_future(undo())

    async def _discard_bot(self, platform: str, account: str) -> None:
        """Undo a quick add: the connection, the stored credential and every row of the bot."""
        bot = (platform, account)
        async with self._lock:
            await self._stop_bot(platform, account)
            try:
                await self._seams.write_secret(_secret_name(platform, account), None)
            except Exception:  # noqa: BLE001 — the rows must go even when the vault fails
                log.exception("channels: deleting the credential of %s failed", _bot_label(bot))
            self._errors.pop(bot, None)
            self._secret_hints.pop(bot, None)
            self.store.remove_account(platform, account)
        await self._changed()
        await self.broadcast_status_changes()

    # --- Telegram Managed Bots ----------------------------------------------------------

    def managed_create(self, manager: str, username: str = "", name: str = "") -> dict[str, Any]:
        """A t.me/newbot link that creates a bot managed by Telegram bot ``manager``; once
        Telegram reports it (``_on_managed_bot``) it is quick added as a new Navide bot."""
        _check_account(manager)
        adapter = self._adapters.get(("telegram", manager))
        if adapter is None:
            return {"ok": False, "error": f"{_bot_label(('telegram', manager))} is not connected"}
        identity = adapter.status.identity
        if not identity.startswith("@"):
            return {"ok": False, "error": f"{_bot_label(('telegram', manager))} has not logged in yet"}
        if not getattr(adapter.status, "can_manage_bots", False):
            return {"ok": False, "error": f"Bot Management Mode is off for {identity}"}
        # Only a linked user's creation is ever added (_on_managed_bot), so without one the
        # link could only make a bot Navide then refuses.
        if not self.gate.has_linked("telegram", manager):
            return {"ok": False, "reason": "manager_not_linked",
                    "error": f"no user is linked to {identity} yet; link one before creating a bot through it"}
        manager_username = identity[1:]
        if username and not _TELEGRAM_USERNAME_RE.match(username):
            return {"ok": False, "error": f"invalid username {username!r}"}
        username = username or _default_managed_username(manager_username)
        name = name or MANAGED_DEFAULT_NAME
        request = _ManagedRequest(secrets.token_hex(8), manager, username)
        self._managed[request.request_id] = request
        request.timer = self._spawn(self._expire_managed(request))
        url = f"https://t.me/newbot/{manager_username}/{username}?name={quote(name, safe='')}"
        return {"ok": True, "request_id": request.request_id, "url": url}

    async def _expire_managed(self, request: _ManagedRequest) -> None:
        await asyncio.sleep(MANAGED_REQUEST_TTL_S)
        if self._managed.pop(request.request_id, None) is not None:
            await self._seams.broadcast("channels.managed_created", {
                "request_id": request.request_id, "ok": False, "reason": "timeout",
                "error": f"no bot was created within {MANAGED_REQUEST_TTL_S:g}s",
            })

    def _on_managed_bot(self, platform: str, manager: str, adapter: ChannelAdapter, update: dict[str, Any]) -> None:
        """A ManagedBotUpdated from ``manager``. It is taken only when ``manager`` has an open
        request and the creator is a user linked to ``manager``; a creator who is not linked
        ends the request at once (the bot exists in Telegram, so waiting it out would only
        prompt a retry and a second bot); anything else (a token or owner change of a bot
        already here, a bot with no request) is only logged."""
        creator = str((update.get("user") or {}).get("id") or "")
        bot = update.get("bot") or {}
        bot_id = str(bot.get("id") or "")
        label = _bot_label((platform, manager))
        if not bot_id:
            log.warning("channels: %s sent a managed_bot update without a bot", label)
            return
        if any(p == platform and str(getattr(ad, "bot_id", "")) == bot_id for (p, _a), ad in self._adapters.items()):
            log.info("channels: %s reported a token or owner change of bot %s, already added; ignored", label, bot_id)
            return
        open_requests = [r for r in self._managed.values() if r.manager == manager]
        if not open_requests:
            log.info("channels: %s reported bot %s with no open create request; ignored", label, bot_id)
            return
        username = str(bot.get("username") or "").lower()
        request = next((r for r in open_requests if r.username.lower() == username), open_requests[0])
        del self._managed[request.request_id]
        if request.timer is not None:
            request.timer.cancel()
        if not self.gate.is_allowed(platform, creator, manager):
            log.warning("channels: bot %s was created through %s by user %s, who is not linked to it; not added",
                        bot_id, label, creator)
            self._spawn(self._seams.broadcast("channels.managed_created", {
                "request_id": request.request_id, "ok": False, "created": True, "reason": "creator_not_linked",
                "error": f"bot {bot_id} was created by Telegram user {creator}, who is not linked to {label}",
            }))
            return
        self._spawn(self._managed_handoff(request, adapter, int(bot_id)))

    async def _managed_handoff(self, request: _ManagedRequest, adapter: Any, bot_id: int) -> None:
        # Past this point the bot exists in Telegram whatever happens here; Navide cannot delete it.
        event: dict[str, Any] = {"request_id": request.request_id, "created": True}
        try:
            token = await adapter.managed_bot_token(bot_id)
        except Exception as exc:  # noqa: BLE001 — reported to the window that asked
            log.warning("channels: reading the token of managed bot %s failed: %s", bot_id, exc)
            event.update(ok=False, reason="token_unavailable", error=redact.redact_text(str(exc)))
        else:
            account = self._new_account_id()
            try:
                result = await self.quick_add("telegram", {}, {"token": token}, account, "direct")
            except Exception as exc:  # noqa: BLE001 — the window waiting on this request must hear back
                log.exception("channels: adding managed bot %s failed", bot_id)
                result = {"ok": False, "reason": "invalid", "error": f"{type(exc).__name__}: {exc}"}
            if result.get("ok"):
                event.update(ok=True, account=account, name=result.get("name") or "", link=result.get("link"))
            else:
                event.update(ok=False, reason=result.get("reason") or "invalid", error=result.get("error") or "")
        await self._seams.broadcast("channels.managed_created", event)

    def _new_account_id(self) -> str:
        """A fresh bot id in the renderer's ``newAccountId`` shape."""
        taken = {a for (_p, a) in self.store.accounts()} | {a for (_p, a) in self._adapters}
        while True:
            account = f"bot-{secrets.token_hex(3)}"
            if account not in taken:
                return account

    async def rename_account(self, platform: str, account: str, name: str) -> dict[str, Any]:
        """A bot's display name only: its id, credential and connection stay as they are."""
        _check_platform(platform)
        _check_account(account)
        async with self._lock:
            acct = self.store.accounts().get((platform, account))
            if acct is None:
                return {"ok": False, "error": "not configured"}
            config = {**acct["config"], "name": name.strip()}
            if not config["name"]:
                del config["name"]
            self.store.upsert_account(platform, config, account=account)
        await self._changed()
        return {"ok": True}

    async def set_enabled(self, platform: str, enabled: bool, account: str = DEFAULT_ACCOUNT) -> dict[str, Any]:
        _check_platform(platform)
        _check_account(account)
        async with self._lock:
            if not self.store.set_account_enabled(platform, enabled, account):
                return {"ok": False, "error": "not configured"}
            err = None
            if not enabled:
                await self._stop_bot(platform, account)
                self._errors.pop((platform, account), None)
            elif self.store.global_enabled():
                err = await self._start_bot(platform, account)
        await self._changed()
        await self.broadcast_status_changes()
        return {"ok": err is None, **({"error": err} if err else {})}

    async def set_global_enabled(self, enabled: bool) -> dict[str, Any]:
        async with self._lock:
            self.store.set_global_enabled(enabled)
            if not enabled:
                self._cancel_workers()
                for platform, account in list(self._adapters):
                    await self._stop_bot(platform, account)
                for pending in self._pending.values():
                    if pending.task:
                        pending.task.cancel()
                self._pending.clear()
            else:
                for (platform, account), acct in self.store.accounts().items():
                    if acct["enabled"]:
                        await self._start_bot(platform, account)
        await self._changed()
        await self.broadcast_status_changes()
        return {"ok": True}

    async def remove(self, platform: str, account: str | None = None) -> dict[str, Any]:
        """Remove one bot (``account``), or with none the whole platform: every bot,
        its allowlist, pairing requests and seen chats."""
        _check_platform(platform)
        if account is not None:
            _check_account(account)
        async with self._lock:
            known = {a for (p, a) in self.store.accounts() if p == platform}
            known |= {a for (p, a) in self._adapters if p == platform}
            accounts = [account] if account is not None else sorted(known | {DEFAULT_ACCOUNT})
            for acc in accounts:
                await self._stop_bot(platform, acc)
                await self._seams.write_secret(_secret_name(platform, acc), None)
                if acc == DEFAULT_ACCOUNT:
                    await self._seams.write_secret(_legacy_secret_name(platform), None)
                self._errors.pop((platform, acc), None)
                self._secret_hints.pop((platform, acc), None)
            if account is None:
                self.store.remove_platform(platform)
            else:
                self.store.remove_account(platform, account)
            for pane_id, p in list(self._pending.items()):
                if p.loc.platform == platform and (account is None or p.loc.account == account):
                    self._drop_pending(pane_id)
        await self._changed()
        await self.broadcast_status_changes()
        return {"ok": True}

    def pairing_list(self, platform: str | None) -> dict[str, Any]:
        self.gate.prune()
        return {"ok": True, "requests": [r.public() for r in self.store.list_pairing(platform or None)]}

    async def pairing_approve(self, platform: str, code: str) -> dict[str, Any]:
        req = self.gate.approve(platform, code)
        if req is None:
            return {"ok": False, "error": "配對碼不存在或已過期 (unknown or expired code)"}
        # Only the bot the sender wrote to can DM them back (it is stored with the request).
        adapter = self._adapters.get((platform, req.account))
        # The approved sender's DM is a chat the pane picker can offer right away.
        # The approval above already stands, so a failed write must not undo it.
        if adapter is None:
            log.warning("channels: approval notice for %s not sent: %s is not connected",
                        req.sender_id, _bot_label((platform, req.account)))
        else:
            try:
                self.store.remember_chat(platform, _bot_key(adapter), req.chat_id, req.sender_name,
                                         "direct", False, int(time.time()))
            except Exception as exc:  # noqa: BLE001
                log.warning("channels: remembering approved DM on %s failed: %s", platform, exc)
        if adapter is not None:
            try:
                await adapter.send_text(Location(platform, req.account, req.chat_id), "✅ 已核准，可以開始對話")
            except Exception:  # noqa: BLE001
                log.warning("channels: approval notice to %s failed", platform)
        await self._changed()
        return {"ok": True, "sender_id": req.sender_id}

    async def pairing_reject(self, platform: str, code: str) -> dict[str, Any]:
        req = self.gate.reject(platform, code)
        await self._changed()
        return {"ok": req is not None, **({} if req else {"error": "unknown code"})}

    def link_create(self, platform: str, target: str, account: str = DEFAULT_ACCOUNT) -> dict[str, Any]:
        """A one-time code that links whoever sends it to the bot (see ``_link_chat``)."""
        _check_platform(platform)
        _check_account(account)
        target = target or "direct"
        if target not in LINK_TARGETS:
            return {"ok": False, "error": f"unknown target {target!r}"}
        adapter = self._adapters.get((platform, account))
        if adapter is None:
            return {"ok": False, "error": f"{_bot_label((platform, account))} is not connected"}
        invite = self.invites.create(platform, target, account)
        link_url = getattr(adapter, "link_url", None)
        url = link_url(invite.code, target) if callable(link_url) else ""
        return {"ok": True, "platform": platform, "code": invite.code, "target": target,
                "expires_at": invite.expires_at, "url": url or None}

    def allow_list(self, platform: str | None) -> dict[str, Any]:
        return {"ok": True, "entries": self.store.list_allow(platform or None)}

    async def allow_remove(self, platform: str, sender_id: str, account: str = DEFAULT_ACCOUNT) -> dict[str, Any]:
        _check_account(account)
        removed = self.store.remove_allow(platform, sender_id, account)
        await self._changed()
        return {"ok": removed, **({} if removed else {"error": "not found"})}

    def locations(self, platform: str, account: str = DEFAULT_ACCOUNT) -> dict[str, Any]:
        _check_account(account)
        adapter = self._adapters.get((platform, account))
        # Only the running bot's chats: another token's bot may not be in them.
        chats = self.store.chats(platform, _bot_key(adapter)) if adapter is not None else []
        merged: dict[str, dict[str, Any]] = {c["chat_id"]: c for c in chats}
        known = getattr(adapter, "known_locations", None)
        if callable(known):
            for loc in known():
                merged[str(loc.get("chat_id"))] = {**merged.get(str(loc.get("chat_id")), {}), **loc}
        return {"ok": True, "locations": list(merged.values())}

    async def bind(self, pane_id: str, pane_name: str, platform: str, mode: str,
                   chat_id: str, thread_id: str = "", title: str = "", *, verbosity: str = "",
                   account: str = DEFAULT_ACCOUNT) -> dict[str, Any]:
        """``verbosity`` is the level the user chose; without one a re-bind keeps the
        pane's level and a new binding gets DEFAULT_VERBOSITY (replies only).
        ``account`` is the bot the chat is reached through."""
        _check_platform(platform)
        _check_account(account)
        if not pane_id or not chat_id:
            return {"ok": False, "error": "pane_id and chat_id are required"}
        level = normalize_verbosity(verbosity) if verbosity else None
        if verbosity and level is None:
            return {"ok": False, "error": f"verbosity must be one of {', '.join(VERBOSITIES)} (got {verbosity!r})"}
        # Restore placeholders are registered too, so they still resolve and bind.
        current = self._seams.resolve_pane(pane_id)
        if not current:
            return {"ok": False, "error": "pane not found"}
        pane_id = current
        adapter = self._adapters.get((platform, account))
        if adapter is None:
            return {"ok": False, "error": f"{_bot_label((platform, account))} is not connected"}
        if mode == "new":
            if not adapter.capabilities.create_location:
                return {"ok": False, "error": f"{platform} cannot create topics"}
            try:
                loc = await adapter.create_location(chat_id, title or pane_name or "Navide")
            except Exception as exc:  # noqa: BLE001
                return {"ok": False, "error": str(exc)}
        elif mode == "existing":
            loc = Location(platform, account, str(chat_id), str(thread_id or ""), title or pane_name)
            # A chat belongs to one pane at a time: never silently take it from another.
            # A holder whose pane no longer resolves closed without its unbind
            # reaching us; it must not lock the chat away for good.
            holder = next((b for b in self.store.bindings()
                           if b.location().key() == loc.key()
                           and self._seams.resolve_pane(b.pane_id) not in ("", pane_id)), None)
            if holder is not None:
                return {"ok": False, "error": MSG_CHAT_TAKEN, "holder_pane_id": holder.pane_id}
        else:
            return {"ok": False, "error": f"unknown mode {mode!r}"}
        previous = next((b for b in self.store.bindings() if b.pane_id == pane_id), None)
        level = level or (previous.verbosity if previous else DEFAULT_VERBOSITY)
        binding = self.store.bind(pane_id, loc, verbosity=level)
        await self._remember_wake_target(binding, pane_id)
        if previous is not None and previous.location().key() != loc.key():
            # Moved to another chat: child topics left in the old one would keep
            # posting there and let its members drive the children.
            await self.mirror.release_children(pane_id)
        await self._changed()
        self.mirror.schedule_sync()  # children the pane already has get their topics now
        # Tell the chat which pane it now drives; off the request path like unbind,
        # on the chat's worker so a quick unbind's notice cannot overtake it.
        text = MSG_BOUND.format(name=pane_name or loc.title or pane_id)
        self._enqueue(loc.key(), lambda: self._notice(adapter, loc, text))
        return {"ok": True, "binding": binding.public()}

    async def unbind(self, pane_id: str, *, reason: str = "", pane_name: str = "") -> dict[str, Any]:
        removed = self.store.unbind(pane_id)
        self._drop_pending(pane_id)
        if removed:
            await self.mirror.release_children(pane_id)
            await self._changed()
            # Tell the chat it is no longer connected; off the request path so the
            # window's unbind returns without waiting on the platform.
            adapter = self._adapters.get((removed.platform, removed.account))
            if adapter is not None:
                name = pane_name or removed.title or pane_id
                text = (MSG_UNBOUND_CLOSED if reason == "closed" else MSG_UNBOUND).format(name=name)
                loc = removed.location()
                self._enqueue(loc.key(), lambda: self._notice(adapter, loc, text))
        return {"ok": True, "removed": removed is not None}

    async def rebind(self, from_pane_id: str, to_pane_id: str) -> dict[str, Any]:
        """Move a binding to the pane that replaced ``from_pane_id`` (rebuild)."""
        if not from_pane_id or not to_pane_id:
            return {"ok": False, "error": "from_pane_id and to_pane_id are required"}
        if from_pane_id == to_pane_id or not self.store.rename_pane(from_pane_id, to_pane_id):
            return {"ok": True}
        self.mirror.rename_pane(from_pane_id, to_pane_id)
        pending = self._pending.pop(from_pane_id, None)
        if pending is not None:
            if pending.task:
                pending.task.cancel()
                pending.task = None
            self._pending[to_pane_id] = pending
            if pending.armed_at is not None:
                pending.task = self._spawn(self._while_running(to_pane_id, pending))
        binding = next((b for b in self.store.bindings() if b.pane_id == to_pane_id), None)
        await self._changed()
        return {"ok": True, **({"binding": binding.public()} if binding else {})}

    async def set_binding_options(self, pane_id: str, verbosity: str) -> dict[str, Any]:
        """How much of the pane's activity its chat receives; auto child topics follow."""
        level = normalize_verbosity(verbosity)
        if level is None:
            return {"ok": False, "error": f"verbosity must be one of {', '.join(VERBOSITIES)} (got {verbosity!r})"}
        pane_id = self._seams.resolve_pane(pane_id) or pane_id
        binding = self.store.set_verbosity(pane_id, level)
        if binding is None:
            return {"ok": False, "error": "this pane is not connected to a chat"}
        stack = [pane_id]
        while stack:
            parent = stack.pop()
            for b in self.store.bindings():
                if b.auto and b.parent_pane_id == parent and b.verbosity != level:
                    self.store.set_verbosity(b.pane_id, level)
                    stack.append(b.pane_id)
        await self._changed()
        return {"ok": True, "binding": binding.public()}

    def bindings(self) -> dict[str, Any]:
        self._sync_bindings()
        return {"ok": True, "bindings": [b.public() for b in self.store.bindings()]}

    # --- pane activity (app.pane_activity_listeners) --------------------------------

    def on_pane_activity(self, pane_id: str, entry: dict[str, Any] | None) -> None:
        """Sync listener registered in app.pane_activity_listeners. Never raises."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is loop:
            self._handle_activity(pane_id, entry)
        else:
            loop.call_soon_threadsafe(self._handle_activity, pane_id, entry)

    def _handle_activity(self, pane_id: str, entry: dict[str, Any] | None) -> None:
        if entry is None:
            # Unregistered is not closed: a rebuild, detach or workspace switch
            # unregisters too. Only the running watch goes; the binding stays
            # until channels.unbind / channels.rebind.
            self._drop_pending(pane_id)
            self._retire_relay(pane_id, MSG_RELAY_PANE_GONE)
            self._known_panes.discard(pane_id)
            self._turn_source.pop(pane_id, None)
            return
        if pane_id not in self._known_panes:
            # First activity from this id (e.g. after a restart): rebind by alias.
            self._known_panes.add(pane_id)
            self._sync_bindings()
        pending = self._pending.get(pane_id)
        is_turn_end = entry.get("event_type") == "turn_complete"
        if is_turn_end:
            # A conversation started in the window, not from the chat, is what a later wake resumes.
            bound = next((b for b in self.store.bindings() if b.pane_id == pane_id), None)
            if bound is not None:
                self._spawn(self._remember_wake_target(bound, pane_id))
        text = str(entry.get("text") or "")
        if is_turn_end and text.strip() and pane_id in self._textless \
                and (pending is None or pending.armed_at is None):
            # The text half of a turn end that came in two lines: the reply after all.
            held, timer = self._textless.pop(pane_id)
            timer.cancel()
            self._spawn(self._send_reply(held, text))
            return
        if pending is None or pending.armed_at is None or not is_turn_end:
            if is_turn_end:
                self._mirror_unclaimed_turn(pane_id, str(entry.get("text") or ""))
            return
        if float(entry.get("ts_monotonic") or 0) <= pending.armed_at:
            # The turn that was running when the message went in: not this reply's,
            # but still something the chat should hear about.
            self._mirror_unclaimed_turn(pane_id, str(entry.get("text") or ""))
            return
        self._pending.pop(pane_id, None)
        if pending.task:
            pending.task.cancel()
        self._retire_relay(pane_id, MSG_RELAY_TURN_ENDED)
        self._awaiting_posted.discard(pane_id)
        self._awaiting_failures.pop(pane_id, None)
        self._awaiting_shown.pop(pane_id, None)
        if not text.strip():
            earlier = self._textless.pop(pane_id, None)
            if earlier is not None:
                earlier[1].cancel()
                self._spawn(self._send_reply(earlier[0], ""))
            self._textless[pane_id] = (pending, self._spawn(self._reply_textless(pane_id, pending)))
            return
        self._spawn(self._send_reply(pending, text))

    async def _reply_textless(self, pane_id: str, pending: _Pending) -> None:
        """No text came after a textless turn end within the grace: the turn said nothing."""
        await asyncio.sleep(EMPTY_TURN_GRACE_S)
        held = self._textless.get(pane_id)
        if held is not None and held[0] is pending:
            del self._textless[pane_id]
            await self._send_reply(pending, "")

    def _mirror_unclaimed_turn(self, pane_id: str, text: str) -> None:
        """A turn end no chat message asked for (typed at the keyboard, delegated by
        another pane, or run by a child): the bound chat still hears the result."""
        if not text.strip():
            return
        route = self.mirror.route(pane_id)
        if route is None:
            if _chat_msg_bodies(text):
                log.warning("channels: %s addressed a chat in an MSG block but is not connected to one", pane_id)
            return
        pending = self._pending_for(pane_id, route, self._turn_source.pop(pane_id, "") or "🖥 本機")
        if pending.silent and not _chat_msg_bodies(text):
            return  # an MSG block addressed to the chat is posted at any level
        self._spawn(self._send_reply(pending, text))

    def _pending_for(self, pane_id: str, route: Any, source: str) -> _Pending:
        """The run record for a turn the chat did not start; verbosity decides how loud it is."""
        level = route.binding.verbosity
        rides_parent = not route.own
        return _Pending(
            loc=route.binding.location(), source=source, child=route.child, owner=pane_id,
            quiet=level in ("replies", "minimal") or rides_parent,
            silent=level == "replies" or (rides_parent and level == "minimal"),
            summary=rides_parent and level != "full",
        )

    def _begin_run(self, pane_id: str, route: Any, source: str) -> None:
        """A local prompt or delegation started a turn: watch it like a chat message's."""
        self._turn_source[pane_id] = source
        if pane_id in self._pending:
            return
        pending = self._pending_for(pane_id, route, source)
        pending.armed_at = pending.started = self._clock()
        self._pending[pane_id] = pending
        pending.task = self._spawn(self._while_running(pane_id, pending))

    def _note_source(self, pane_id: str, source: str) -> None:
        self._turn_source[pane_id] = source

    async def _send_reply(self, pending: _Pending, text: str) -> None:
        """Post a finished turn to the chat. A pane answering a chat writes MSG blocks
        addressed to the sender ("telegram:alice"): only those bodies are posted, and
        if they cannot be, the whole turn text goes instead. Never anything back to the pane."""
        adapter = self._adapters.get((pending.loc.platform, pending.loc.account))
        if adapter is None:
            if _chat_msg_bodies(text):
                log.warning("channels: MSG reply for %s dropped: %s is not connected",
                            pending.loc.key(), pending.loc.platform)
            return
        if pending.status_id or pending.status_send is not None:
            elapsed = int(self._clock() - pending.started)
            await self._edit_status(adapter, pending, f"✅ 完成（{elapsed}s）", force=True)
        bodies = _chat_msg_bodies(text)
        if bodies:
            reply, paths = media.split_attachments("\n\n".join(bodies))
            # A reply that only sends files posts no "(no text output)" placeholder.
            if (paths and not reply.strip()) or await self._post_reply(pending, reply):
                if paths:
                    await self._send_attachments(pending, paths)
                return
            log.warning("channels: MSG reply to %s failed; posting the turn text instead", pending.loc.key())
        elif pending.silent:
            return
        # Only an MSG block to the chat sends files; elsewhere the lines are dropped, not posted.
        body = media.split_attachments(strip_msg_markers(text))[0]
        if pending.summary and not bodies:
            await self._post_reply(pending, summarize(body), full=body)
        else:
            await self._post_reply(pending, body)
        if bodies and paths:
            # The text went as the turn text instead; the files the reply named still go.
            await self._send_attachments(pending, paths)

    async def _post_reply(self, pending: _Pending, body: str, full: str = "") -> bool:
        """Chunk and send one reply; False when a chunk could not be sent. ``full`` is the
        whole text when ``body`` is its summary. A reply past ``LONG_REPLY_MAX_CHUNKS``
        chunks, or a summary that left text out, goes as a preview with the whole text
        attached as a file, where the platform takes files."""
        body, full = self._for_chat(pending.loc, body), self._for_chat(pending.loc, full)
        raw = body
        body = result_text(pending.source, body or MSG_EMPTY_REPLY, pending.child) if pending.source else body
        chunks = chunk_for(pending.loc.platform, redact.redact_text(body)) or [MSG_EMPTY_REPLY]
        whole = full.strip() if len(full.strip()) > CHILD_SUMMARY_CHARS else ""
        if not full and len(chunks) > LONG_REPLY_MAX_CHUNKS:
            whole = raw.strip()
        adapter = self._adapters.get((pending.loc.platform, pending.loc.account))
        rest: list[str] = []
        lang = ""
        if whole and callable(getattr(adapter, "send_file", None)):
            lang = prompt_skills.language(await self._ui_settings())
            notice = media.text(lang, "long.attached")
            if full:
                preview = body.removesuffix(MSG_SUMMARY_TAIL) + "\n" + notice
                chunks = chunk_for(pending.loc.platform, redact.redact_text(preview))
            else:
                # The first chunk, cut until it and the notice fit in one message.
                lines, cut = chunks[0].rstrip().split("\n"), []
                while len(lines) > 1 and len(chunk_for(pending.loc.platform, "\n".join(lines + ["…", notice]))) > 1:
                    cut.insert(0, lines.pop())
                rest = chunk_for(pending.loc.platform, "\n".join(cut)) + chunks[1:]
                chunks = chunk_for(pending.loc.platform, "\n".join(lines + ["…", notice]))
        for index, chunk in enumerate(chunks):
            try:
                ids = await self.mirror.send(pending.loc, chunk)
            except Exception as exc:  # noqa: BLE001
                why = share_cmds.mask_links(str(exc))
                log.warning("channels: reply to %s failed: %s", pending.loc.key(), why)
                # Neither the chat nor the app learns of this otherwise: keep it
                # where ui_diagnostics (and self-evolution) can read it back.
                error_ledger.record(
                    "backend", "error", "channels.reply_failed",
                    f"reply to {pending.loc.key()} failed at chunk {index + 1}/{len(chunks)}:"
                    f" {type(exc).__name__}: {why}",
                    pane_id=pending.owner,
                )
                return False
            if pending.owner:
                self.mirror.owners.remember(pending.loc.key(), ids, pending.owner)
        if lang and not await self._send_whole_text(adapter, pending, redact.redact_text(whole), lang):
            for chunk in rest:  # the file did not go: the chunks the preview stood for still do
                with contextlib.suppress(Exception):
                    ids = await self.mirror.send(pending.loc, chunk)
                    if pending.owner:
                        self.mirror.owners.remember(pending.loc.key(), ids, pending.owner)
        return True

    async def _send_whole_text(self, adapter: Any, pending: _Pending, text: str, lang: str) -> bool:
        """A long reply's whole text as a Markdown file with its card; False if it did not go."""
        data = text.encode("utf-8")
        first = next((line for line in text.splitlines() if line.strip()), "")
        card = report.Caption(media.text(lang, "long.title"), report.clean(first, report.SUMMARY_MAX),
                              f"MD · {media.human_size(len(data))}")
        try:
            with tempfile.TemporaryFile() as fh:
                fh.write(data)
                fh.seek(0)
                ids = await adapter.send_file(pending.loc, fh, f"reply-{time.strftime('%Y%m%d-%H%M%S')}.md",
                                              caption=card)
        except Exception as exc:  # noqa: BLE001
            log.warning("channels: the whole reply to %s did not go as a file: %s", pending.loc.key(), exc)
            return False
        if pending.owner:
            self.mirror.owners.remember(pending.loc.key(), ids, pending.owner)
        return True

    # --- inbound ------------------------------------------------------------------

    def _is_duplicate(self, msg: InboundMessage) -> bool:
        key = (f"{msg.platform}:{msg.account}", msg.message_id)  # two bots in one group see the same id
        if key in self._dedup:
            self._dedup.move_to_end(key)
            return True
        self._dedup[key] = None
        while len(self._dedup) > DEDUP_MAX:
            self._dedup.popitem(last=False)
        return False

    def _remember_chat(self, msg: InboundMessage) -> bool:
        # Persisted: the pane picker must still list the chat after a restart.
        # Only a picker convenience: a failed write must not drop the message.
        adapter = self._adapters.get((msg.platform, msg.account))
        if adapter is None:
            return False
        try:
            return self.store.remember_chat(
                msg.platform, _bot_key(adapter), msg.chat_id, msg.sender_name if msg.is_direct else msg.chat_id,
                "direct" if msg.is_direct else "group", bool(msg.thread_id), int(time.time()),
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("channels: remembering chat %s failed: %s", msg.chat_id, exc)
            return False

    def _binding_for(self, msg: InboundMessage) -> Binding | None:
        key = msg.location_key()
        for b in self.store.bindings():
            if b.location().key() == key:
                return b
        return None

    async def _reply(self, msg: InboundMessage, text: str,
                     buttons: list[tuple[str, str]] | None = None) -> str:
        adapter = self._adapters.get((msg.platform, msg.account))
        if adapter is None:
            return ""
        loc = Location(msg.platform, msg.account, msg.chat_id, msg.thread_id)
        if not adapter.capabilities.buttons:
            text += _typed_hint(buttons or [])
            buttons = None
        try:
            ids = await self.mirror.send(loc, text, buttons=buttons)
            return ids[0] if ids else ""
        except Exception as exc:  # noqa: BLE001
            log.warning("channels: reply on %s failed: %s", msg.platform, exc)
            return ""

    async def handle_inbound(self, msg: InboundMessage) -> None:
        """Called on the adapter's receive loop: only fast, synchronous checks here.

        Everything that awaits the network or a UI round trip (replies, delivery,
        interrupt, relay answers) runs on the location's worker, so one slow
        chat never stalls receiving for every platform.
        """
        if not self.store.global_enabled() or (msg.platform, msg.account) not in self._adapters:
            return
        if self._is_duplicate(msg):
            return
        # A live invite code links its sender before the gate: that is its whole point.
        code = parse_link_code(msg.text) if msg.text and not msg.callback_data else ""
        invite = self.invites.consume(msg.platform, code, msg.account) if code else None
        if invite is not None:
            self._enqueue(msg.location_key(), lambda: self._link_chat(msg, invite.code))
            return
        if not msg.is_direct and not self.gate.is_allowed(msg.platform, msg.sender_id, msg.account):
            return  # group strangers are dropped silently
        self._enqueue(msg.location_key(), lambda: self._process_inbound(msg))

    async def _process_inbound(self, msg: InboundMessage) -> None:
        if not self.store.global_enabled() or (msg.platform, msg.account) not in self._adapters:
            return
        if not self.gate.is_allowed(msg.platform, msg.sender_id, msg.account):
            await self._pairing_reply(msg)  # only DMs get this far
            return
        if self._remember_chat(msg):
            await self._changed()  # an open pane picker lists the new chat right away
        # Relay answers go before any queueing: the pane is blocked on exactly this.
        if self._relay_enabled(msg.platform, msg.account):
            answer = relay.parse_answer(msg.text, msg.callback_data)
            if answer is None and not msg.callback_data:
                answer = self._bare_answer(msg)
            if answer is not None:
                await self._handle_relay_answer(msg, answer)
                return
        if msg.callback_data.startswith(quick_menu.CALLBACK_PREFIX):
            await self._quick_press(msg)
            return
        if msg.callback_data.startswith(share_cmds.CALLBACK_PREFIX) and await self._share_press(msg):
            return
        wake_pressed = msg.callback_data == WAKE_CALLBACK
        if msg.callback_data in _CALLBACK_COMMANDS:
            # Then on through the binding checks below, as if the command had been typed.
            msg = dataclasses.replace(msg, text=_CALLBACK_COMMANDS[msg.callback_data], callback_data="")
        if msg.callback_data and not msg.text:
            return  # a button press with the relay off, or not ours
        pick = quick_menu.menu_pick(msg.text, self._identity(msg))
        if pick is not None:
            await self._quick_pick(msg, pick)
            return
        pick = quick_menu.mcp_pick(msg.text, self._identity(msg))
        if pick is not None:
            await self._quick_pick(msg, pick, mcp=True)
            return
        # Only where /prompts and /skills answer with numbered lines: elsewhere "/skills 2"
        # stays text for the pane, as before (the CLI may have a /skills of its own).
        scoped = quick_menu.scoped_pick(msg.text, self._identity(msg)) if not self._menu_buttons(msg) else None
        if scoped is not None:
            await self._quick_pick(msg, scoped[1], scope=scoped[0])
            return
        scope = quick_menu.menu_scope(msg.text, self._identity(msg))
        if scope is not None:
            await self._quick_menu(msg, scope)
            return
        if relay.is_pending_command(msg.text, self._identity(msg)):
            await self._list_pending(msg)
            return
        share_cmd = share_cmds.parse_command(msg.text, self._identity(msg))
        if share_cmd is not None and await self._share_command(msg, *share_cmd):
            return
        binding = self._binding_for(msg)
        if binding is None:
            # One bot answers for its unbound chats and topics, as it always has; with
            # several, a bot in a group the user drives through another stays quiet.
            if self._sole_bot(msg.platform):
                await self._reply(msg, MSG_NOT_BOUND)
            else:
                log.info("channels: %s is not bound through %s; staying silent",
                         msg.location_key(), _bot_label((msg.platform, msg.account)))
            return
        pane_id = await self._resolve_after_startup(binding.pane_id)
        if not pane_id:
            await self._offline(msg, binding)  # binding kept: it may come back
            return
        if pane_id != binding.pane_id:
            self.store.rename_pane(binding.pane_id, pane_id)
        self._spawn(self._remember_wake_target(binding, pane_id))
        key = binding.location().key()
        if wake_pressed or key in self._wake_kept:
            # The pane is back (on its own, or a wake button from before it came back): what
            # was kept for it goes in first, in order.
            lang = prompt_skills.language(await self._ui_settings())
            if wake_pressed:
                await self._reply(msg, wake.text(lang, "already_online"))
            # A new message follows unless this was the button: it keeps its place in the queue.
            await self._deliver_kept(msg, binding, pane_id, lang, reserve=0 if wake_pressed else 1)
            if wake_pressed:
                return
        # "<@bot> stop" or "@bot /cancel" is the command, addressed to the bot.
        command = quick_menu.strip_mention(msg.text, self._identity(msg))
        if _is_stop_word(command):
            await self._interrupt(msg, pane_id, buttons=RESUME_BUTTONS)
            return
        if _command_word(command) in CANCEL_WORDS:
            await self._cancel_queued(msg)
            return
        if _command_word(command) in RESUME_WORDS:
            await self._resume(msg, pane_id)
            return
        if await self.mirror.handle_inbound(msg, binding, pane_id):
            return
        await self._debounced_deliver(msg, binding, pane_id)

    async def _remember_wake_target(self, binding: Binding, pane_id: str) -> None:
        """Keep the online pane's workspace and conversation on its binding, for a later wake."""
        try:
            target = await asyncio.to_thread(self._seams.wake_target, pane_id)
        except Exception as exc:  # noqa: BLE001 — the message still goes in without it
            log.warning("channels: reading the wake target of %s failed: %s", pane_id, exc)
            return
        workspace_path = str(target.get("workspace_path") or "")
        session_id = str(target.get("session_id") or "")
        if not workspace_path or not session_id:
            return  # nothing known yet (a pane before its first turn): keep what is stored
        if (workspace_path, session_id) != (binding.workspace_path, binding.session_id):
            self.store.set_wake_target(pane_id, workspace_path, session_id)

    async def _offline(self, msg: InboundMessage, binding: Binding) -> None:
        """A message for a bound pane that is not online.

        A binding without a stored workspace and conversation (one made before waking
        existed, not seen online since) is only told, as before. Otherwise the chat can wake
        the pane onto its own conversation, and what it sent is kept for that wake."""
        lang = prompt_skills.language(await self._ui_settings())
        if not binding.workspace_path or not binding.session_id:
            await self._reply(msg, wake.text(lang, "offline"))
            return
        if not self._seams.windows_open():
            await self._reply(msg, wake.text(lang, "no_window"))
            return
        command = quick_menu.strip_mention(msg.text, self._identity(msg))
        if _command_word(command) in WAKE_WORDS:
            await self._wake(msg, binding, lang)
            return
        word = _command_word(command)
        if _is_stop_word(command) or word in CANCEL_WORDS or word in RESUME_WORDS:
            await self._reply(msg, wake.text(lang, "offline_wake_nothing_kept"), buttons=WAKE_BUTTONS)
            return
        key = binding.location().key()
        kept = await self._live_kept(msg, key, lang)
        kept.append((self._clock(), msg))
        if len(kept) > wake.STASH_MAX:
            dropped, kept = kept[:-wake.STASH_MAX], kept[-wake.STASH_MAX:]
            await self._reply(msg, wake.text(lang, "not_sent_overflow", max=wake.STASH_MAX, count=len(dropped),
                                             items=_previews(dropped)))
        self._set_kept(key, kept)
        await self._reply(msg, wake.text(lang, "offline_wake", max=wake.STASH_MAX,
                                         minutes=int(wake.STASH_TTL_S // 60)), buttons=WAKE_BUTTONS)

    async def _wake(self, msg: InboundMessage, binding: Binding, lang: str) -> None:
        key = binding.location().key()
        refusal = self._wake_limits.refusal(key, lang)
        if refusal:
            await self._reply(msg, refusal)
            return
        self._wake_limits.begin(key)
        result: dict[str, Any] = {}
        try:
            await self._reply(msg, wake.text(lang, "waking"))
            try:
                result = await self._seams.wake(binding.pane_id, binding.workspace_path, binding.session_id)
            except Exception as exc:  # noqa: BLE001 — answered as a failed wake
                log.warning("channels: waking %s failed: %s", binding.pane_id, exc)
                result = {"ok": False, "code": "error", "started": True}
        finally:
            self._wake_limits.end(key, counted=bool(result.get("ok") or result.get("started", True)))
        if not result.get("ok"):
            await self._reply(msg, wake.outcome_text(lang, result))
            return
        pane_id = str(result.get("pane_id") or binding.pane_id)
        if pane_id != binding.pane_id:
            self.store.rename_pane(binding.pane_id, pane_id)
            await self._changed()
        current = self._binding_for(msg) or binding
        kept = await self._live_kept(msg, key, lang)
        await self._reply(msg, wake.text(lang, "woke_sent", count=len(kept)) if kept else wake.text(lang, "woke"))
        await self._deliver_kept(msg, current, pane_id, lang, reserve=0)

    def _set_kept(self, key: str, kept: list[tuple[float, InboundMessage]]) -> None:
        """Keep ``kept`` for ``key`` (none: forget it), with previews saved so a restart can say
        which were lost."""
        if kept:
            self._wake_kept[key] = kept
        else:
            self._wake_kept.pop(key, None)
        try:
            saved = self.store.kept_previews()
            if kept:
                saved[key] = [_preview(m) for _, m in kept]
            else:
                saved.pop(key, None)
            self.store.set_kept_previews(saved)
        except Exception as exc:  # noqa: BLE001 — the messages are still kept in memory
            log.warning("channels: saving the kept messages of %s failed: %s", key, exc)

    async def _live_kept(self, msg: InboundMessage, key: str, lang: str) -> list[tuple[float, InboundMessage]]:
        """What is kept for ``key`` and still within its TTL; the chat is told which expired."""
        kept = list(self._wake_kept.get(key, []))
        expired = [k for k in kept if self._clock() - k[0] >= wake.STASH_TTL_S]
        if expired:
            kept = [k for k in kept if k not in expired]
            self._set_kept(key, kept)
            await self._reply(msg, wake.text(lang, "not_sent_expired", minutes=int(wake.STASH_TTL_S // 60),
                                             count=len(expired), items=_previews(expired)))
        return kept

    async def _deliver_kept(self, msg: InboundMessage, binding: Binding, pane_id: str, lang: str, *,
                            reserve: int) -> None:
        """Send in, in order, what was kept for the binding while its pane was not online, as
        far as the pane's queue takes (``reserve`` slots stay for what follows); the chat is
        told which did not fit."""
        key = binding.location().key()
        kept = await self._live_kept(msg, key, lang)
        self._set_kept(key, [])
        room = max(MAX_QUEUED_PER_PANE - len(self._queued.get(pane_id, ())) - reserve, 0)
        fits, over = kept[:room], kept[room:]
        for _kept_at, kept_msg in fits:
            await self._deliver(kept_msg, binding, pane_id)
        if over:
            await self._reply(msg, wake.text(lang, "not_sent_queue_full", count=len(over), items=_previews(over)))

    def _adopt_lost_kept(self) -> None:
        """At start: what was kept for a wake when the backend last stopped is gone. Hold its
        previews until each chat's bot is running to be told; chats no longer bound are dropped."""
        try:
            lost = self.store.lost_previews()
            for key, previews in self.store.kept_previews().items():
                lost[key] = lost.get(key, []) + previews
            bound = {b.location().key() for b in self.store.bindings()}
            self.store.set_lost_previews({k: v for k, v in lost.items() if k in bound})
            self.store.set_kept_previews({})
        except Exception as exc:  # noqa: BLE001
            log.warning("channels: reading the kept messages from before the restart failed: %s", exc)

    async def _report_lost_kept(self, bot: BotKey) -> None:
        """Tell ``bot``'s chats which kept messages a restart lost, then forget the previews."""
        try:
            lost = self.store.lost_previews()
        except Exception as exc:  # noqa: BLE001
            log.warning("channels: reading the lost kept messages failed: %s", exc)
            return
        adapter = self._adapters.get(bot)
        if not lost or adapter is None:
            return
        lang = prompt_skills.language(await self._ui_settings())
        for b in self.store.bindings():
            loc = b.location()
            previews = lost.get(loc.key())
            if not previews or (b.platform, b.account) != bot:
                continue
            text = wake.text(lang, "not_sent_restart", count=len(previews), items=wake.quoted(previews))

            async def tell(adapter: Any = adapter, loc: Location = loc, text: str = text) -> None:
                await self._notice(adapter, loc, text)
                self._forget_lost(loc.key())

            self._enqueue(loc.key(), tell)

    def _forget_lost(self, key: str) -> None:
        try:
            lost = self.store.lost_previews()
            if lost.pop(key, None) is not None:
                self.store.set_lost_previews(lost)
        except Exception as exc:  # noqa: BLE001
            log.warning("channels: forgetting the lost kept messages of %s failed: %s", key, exc)

    async def _resolve_after_startup(self, pane_id: str) -> str:
        """The pane's current id; during the startup grace an unknown pane is waited for."""
        current = self._seams.resolve_pane(pane_id)
        while not current and self._clock() - self._started_at < STARTUP_GRACE_S:
            await asyncio.sleep(STARTUP_POLL_S)
            current = self._seams.resolve_pane(pane_id)
        return current

    async def _debounced_deliver(self, msg: InboundMessage, binding: Binding, pane_id: str) -> None:
        if DEBOUNCE_S <= 0:
            await self._deliver(msg, binding, pane_id)
            return
        key = (msg.location_key(), msg.sender_id)
        now = self._clock()
        buf = self._debounce.get(key)
        if buf is None:
            buf = _Debounce(msg, binding, pane_id, [], now)
            self._debounce[key] = buf
        if buf.msg.reply_to_text and not msg.reply_to_text:
            # A follow-up line keeps the quote an earlier line in the same message replied to.
            msg = dataclasses.replace(msg, reply_to_text=buf.msg.reply_to_text,
                                      reply_to_sender=buf.msg.reply_to_sender,
                                      reply_to_sender_id=buf.msg.reply_to_sender_id,
                                      reply_to_self=buf.msg.reply_to_self)
        buf.msg, buf.binding, buf.pane_id = msg, binding, pane_id
        buf.texts.append(msg.text)
        buf.attachments.extend(msg.attachments)
        if buf.task is not None:
            buf.task.cancel()
        wait = max(0.0, min(DEBOUNCE_S, buf.first_at + DEBOUNCE_MAX_S - now))
        buf.task = self._spawn(self._flush_debounce(key, buf, wait))

    async def _flush_debounce(self, key: tuple[str, str], buf: _Debounce, wait: float) -> None:
        await asyncio.sleep(wait)
        if self._debounce.get(key) is not buf:
            return
        del self._debounce[key]
        # An attachment-only line has no text: it adds a file, not a blank line.
        joined = dataclasses.replace(buf.msg, text="\n".join(t for t in buf.texts if t),
                                     attachments=list(buf.attachments))
        # Back onto the location's worker so it stays ordered with that chat's other jobs.
        self._enqueue(joined.location_key(), lambda: self._deliver(joined, buf.binding, buf.pane_id))

    def _sole_bot(self, platform: str) -> bool:
        """At most one enabled bot on ``platform`` (the only case before several bots)."""
        return sum(1 for (p, _a), acct in self.store.accounts().items() if p == platform and acct["enabled"]) <= 1

    def _relay_enabled(self, platform: str, account: str) -> bool:
        acct = self.store.accounts().get((platform, account))
        # Always on: every chat approval is screened by Navide Guard (Phase C), so there
        # is no per-platform switch; a stale ``permission_relay: false`` is ignored.
        return bool(acct)

    def _bare_answer(self, msg: InboundMessage) -> relay.RelayAnswer | None:
        """``2`` / ``yes`` with no id answers the chat's prompt when exactly one is live."""
        choice = relay.parse_bare(msg.text)
        if not choice:
            return None
        live = self.relay.for_location(msg.location_key())
        return relay.RelayAnswer(live[0].id, choice) if len(live) == 1 else None

    async def _held_by_prompt(self, msg: InboundMessage, pane_id: str) -> bool:
        """A pane waiting on a permission-type prompt would queue the text until the
        prompt clears and then run it as a new prompt: say how to answer instead."""
        if self._seams.pane_state(pane_id).get("display_status") != "awaiting":
            return False
        live = self.relay.for_pane(pane_id)
        if live:
            await self._held_with_buttons(msg, live[0])
            return True
        try:
            info = await self._seams.awaiting_info(pane_id)
        except Exception:  # noqa: BLE001
            return False
        if info.get("kind") != "permission":
            return False  # a question is answered by typing
        await self._reply(msg, MSG_HELD_BY_PROMPT.format(how=MSG_AWAITING_LOCAL))
        return True

    async def _list_pending(self, msg: InboundMessage) -> None:
        """/pending: send this chat's waiting prompts again, each with its buttons. The new
        message becomes the prompt's own (settled when it is answered); the old one drops
        its buttons."""
        live = self.relay.for_location(msg.location_key())
        if not live:
            # A bot that does not drive this chat stays quiet when several share it.
            if self._binding_for(msg) is not None or self._sole_bot(msg.platform):
                await self._reply(msg, MSG_PENDING_NONE)
            return
        adapter = self._adapters.get((msg.platform, msg.account))
        if adapter is None:
            return
        names = {str(p.get("pane_id")): str(p.get("name") or "") for p in self._seams.pane_directory()}
        for request in sorted(live, key=lambda r: r.created):
            minutes = int(max(self._clock() - request.created, 0) // 60)
            head = f"📋 {names.get(request.pane_id) or request.pane_id}・{minutes} 分鐘前"
            text = f"{head}\n{relay.prompt_text(request, request.prompt)}"
            buttons = relay.buttons_for(request) if adapter.capabilities.buttons else None
            try:
                ids = await self.mirror.send(request.loc, text, owner=request.pane_id, buttons=buttons or None)
            except Exception as exc:  # noqa: BLE001
                log.warning("channels: /pending to %s failed: %s", request.loc.key(), exc)
                continue
            if not ids:
                continue
            old = dataclasses.replace(request)
            request.message_id = ids[-1]
            request.message_text = text if len(ids) == 1 else ""
            self._spawn(self._settle_prompt(old, MSG_PENDING_RELISTED))

    async def _held_with_buttons(self, msg: InboundMessage, request: relay.RelayRequest) -> None:
        """The warning carries the prompt's options and buttons, and quotes the prompt
        message, so a chat that scrolled past the prompt can answer from here."""
        adapter = self._adapters.get((msg.platform, msg.account))
        if adapter is None:
            return
        loc = Location(msg.platform, msg.account, msg.chat_id, msg.thread_id)
        if request.loc.key() != loc.key():
            # Prompted in another chat: an answer from here is refused, and its message is not here.
            await self._reply(msg, MSG_HELD_BY_PROMPT.format(how=relay.answer_hint(request)))
            return
        text = MSG_HELD_BY_PROMPT.format(how="\n" + relay.held_text(request))
        buttons = relay.buttons_for(request) if adapter.capabilities.buttons else None
        try:
            ids = await self.mirror.send(loc, text, buttons=buttons or None, reply_to=request.message_id)
        except Exception as exc:  # noqa: BLE001
            log.warning("channels: reply on %s failed: %s", msg.platform, exc)
            return
        if ids:
            # Settled with the prompt; a chunked warning keeps only its last chunk.
            request.held.append((ids[-1], text if len(ids) == 1 else ""))

    async def _handle_relay_answer(self, msg: InboundMessage, answer: relay.RelayAnswer) -> None:
        request = self.relay.get(answer.request_id)
        # The very chat (bot, chat and topic) the prompt went to: another bot in the
        # same group, or another topic, is not the one the pane asked.
        if request is None or request.loc.key() != msg.location_key():
            await self._reply(msg, MSG_RELAY_EXPIRED)
            return
        if relay.refuses_permanent(request, answer.choice):
            await self._reply(msg, MSG_RELAY_PERMANENT)
            return
        payload = relay.answer_payload(request, answer.choice)
        if payload is None:
            await self._reply(msg, f"⚠️ {relay.answer_hint(request)}" if request.kind == "permission"
                              else "⚠️ 請回覆有效的選項編號")
            return
        if not relay.is_deny(request, payload) and self._guard_vetoes(request):
            await self._reply(msg, MSG_RELAY_NEEDS_LOCAL)
            return
        # Bind the answer to the prompt it was requested for: the screen may
        # have moved on to a different prompt since the chat saw it.
        try:
            info = await self._seams.awaiting_info(request.pane_id)
        except Exception:  # noqa: BLE001
            info = {}
        if not (relay.same_prompt(str(info.get("prompt") or ""), request.prompt)
                and relay.same_options([str(o) for o in info.get("options") or []], request.options)):
            await self._relay_prompt_changed(msg, request)
            return
        expected = {"prompt": request.prompt, "options": list(request.options)}
        try:
            result = await self._seams.answer(request.pane_id, payload, expected)
        except Exception as exc:  # noqa: BLE001
            result = {"ok": False, "error": str(exc)}
        if result.get("error_code") == "prompt-changed":
            await self._relay_prompt_changed(msg, request)
            return
        if result.get("ok"):
            self.relay.take(request.id)  # used up only once the keys went in
            self._spawn(self._settle_prompt(request, MSG_RELAY_ANSWERED_IN_CHAT + relay.describe_answer(payload)))
            shown = self._awaiting_shown.get(request.pane_id)
            if shown is not None and shown.request_id == request.id:
                shown.request_id = ""  # answered: only a different prompt is relayed next
            route = self.mirror.route(request.pane_id)
            self._spawn(self._follow_up(request.pane_id, request.loc, route.child if route else ""))
            await self._reply(msg, f"✅ 已送出：{relay.describe_answer(payload)}")
        else:
            await self._reply(msg, f"⚠️ 送出失敗：{result.get('error') or 'not sent'}")

    async def _relay_prompt_changed(self, msg: InboundMessage, request: relay.RelayRequest) -> None:
        """The screen moved on: this id is stale, and the pane's prompt as it is now is
        relayed again for the chat to pick from."""
        self.relay.take(request.id)
        self._spawn(self._settle_prompt(request, MSG_RELAY_SUPERSEDED))
        self._awaiting_unmark(request.pane_id)
        route = self.mirror.route(request.pane_id)
        self._spawn(self._follow_up(request.pane_id, request.loc, route.child if route else ""))
        await self._reply(msg, MSG_RELAY_PROMPT_CHANGED)

    def _guard_vetoes(self, request: relay.RelayRequest) -> bool:
        """Navide Guard on a remote approval: high/critical (or unscreenable)
        prompts need someone at the computer. Deterministic, never an LLM."""
        if not request.prompt.strip():
            return True  # nothing to screen: a chat approval fails closed
        try:
            workspace = self._seams.pane_workspace(request.pane_id)
        except Exception:  # noqa: BLE001
            workspace = ""
        return relay.screen_approval(request.pane_id, request.prompt, workspace).action != "allow"

    async def _link_chat(self, msg: InboundMessage, code: str) -> None:
        # The invite is already spent, so every way out must reach the waiting UI.
        adapter = self._adapters.get((msg.platform, msg.account))
        if adapter is None:
            await self._link_failed(msg.platform, code, f"{msg.platform} is not connected")
            return
        try:
            if not self.gate.is_allowed(msg.platform, msg.sender_id, msg.account):
                self.store.add_allow(msg.platform, msg.sender_id, msg.sender_name, int(time.time()), msg.account)
        except Exception as exc:  # noqa: BLE001 — reported to the sender and the UI below
            log.warning("channels: allowlisting linked sender on %s failed: %s", msg.platform, exc)
            await self._reply(msg, MSG_LINK_FAILED)
            await self._link_failed(msg.platform, code, str(exc))
            return
        kind = "direct" if msg.is_direct else "group"
        title = msg.sender_name
        if not msg.is_direct:
            known = getattr(adapter, "known_locations", None)
            titles = {str(c.get("chat_id")): c.get("title") for c in known()} if callable(known) else {}
            title = str(titles.get(msg.chat_id) or msg.chat_id)
        try:
            self.store.remember_chat(msg.platform, _bot_key(adapter), msg.chat_id, title, kind,
                                     bool(msg.thread_id), int(time.time()))
        except Exception as exc:  # noqa: BLE001 — the sender is linked; only the picker list misses it
            log.warning("channels: remembering linked chat %s failed: %s", msg.chat_id, exc)
        # Not _reply: it cannot tell a failed send from one that returned no id.
        confirmed = True
        try:
            await adapter.send_text(Location(msg.platform, msg.account, msg.chat_id, msg.thread_id), MSG_LINKED)
        except Exception as exc:  # noqa: BLE001 — the link stands; the UI says the bot stayed silent
            log.warning("channels: link confirmation on %s failed: %s", msg.platform, exc)
            confirmed = False
        await self._changed()
        await self._seams.broadcast("channels.linked", {
            "platform": msg.platform, "code": code, "chat_id": msg.chat_id, "title": title, "kind": kind,
            "confirmed": confirmed,
        })

    async def _link_failed(self, platform: str, code: str, error: str) -> None:
        await self._seams.broadcast("channels.link_failed", {"platform": platform, "code": code, "error": error})

    async def _pairing_reply(self, msg: InboundMessage) -> None:
        outcome = self.gate.request_pairing(msg.platform, msg.sender_id, msg.sender_name, msg.chat_id, msg.account)
        if outcome.full or outcome.request is None:
            return
        code = outcome.request.code
        await self._reply(msg, f"這個 bot 需要配對。請在 Navide 的 Settings → Channels 核准配對碼：{code[:4]}-{code[4:]}")
        if outcome.created:
            await self._seams.broadcast("channels.pairing_request", {
                "platform": msg.platform, "account": msg.account, "code": code, "sender_name": msg.sender_name,
            })
            await self._changed()

    async def _interrupt(self, msg: InboundMessage, pane_id: str, ok_text: str = MSG_INTERRUPTED,
                         buttons: list[tuple[str, str]] | None = None) -> None:
        try:
            result = await self._seams.interrupt(pane_id)
        except Exception as exc:  # noqa: BLE001
            result = {"ok": False, "error": str(exc)}
        if result.get("ok") and result.get("sent", True):
            waiting = len(self._joining(msg)) + len(self._queued_from(msg))
            await self._reply(msg, ok_text + (MSG_INTERRUPTED_QUEUED.format(n=waiting) if waiting else ""),
                              buttons=buttons)
        else:
            await self._reply(msg, f"⚠️ 中斷失敗：{result.get('error') or 'not sent'}")

    def _joining(self, msg: InboundMessage) -> list[tuple[str, str]]:
        """Debounce buffers of this chat: lines not handed to any pane yet."""
        return [key for key in self._debounce if key[0] == msg.location_key()]

    def _queued_from(self, msg: InboundMessage) -> list[str]:
        """This chat's own messages still queued in a pane, whichever pane they went to."""
        loc = msg.location_key()
        return [key for keys in self._queued.values() for key in keys if self._queued_loc.get(key) == loc]

    async def _resume(self, msg: InboundMessage, pane_id: str) -> None:
        """``/resume`` or the stop reply's button: let a stopped pane take messages again."""
        if self._seams.pane_state(pane_id).get("display_status") != "stopped":
            await self._reply(msg, MSG_NOT_STOPPED)
            return
        result = await self._seams.resume(pane_id)
        await self._reply(msg, MSG_RESUMED if result.get("ok") else f"⚠️ 恢復失敗：{result.get('error') or 'unknown'}")

    async def _cancel_queued(self, msg: InboundMessage) -> None:
        """``/cancel``: withdraw what this chat sent that has not gone into a pane yet."""
        withdrawn = 0
        for key in self._joining(msg):
            buf = self._debounce.pop(key)
            if buf.task is not None:
                buf.task.cancel()
            withdrawn += len(buf.texts)
        late = unsure = 0
        for msg_key in self._queued_from(msg):
            try:
                status = await self._seams.cancel(msg_key)
            except Exception as exc:  # noqa: BLE001
                log.warning("channels: withdrawing %s failed: %s", msg_key, exc)
                status = "unknown"
            if status == "cancelled":
                withdrawn += 1
            elif status in ("delivered", "failed"):
                late += 1
            else:
                unsure += 1
        if not (withdrawn or late or unsure):
            await self._reply(msg, MSG_CANCEL_NONE)
            return
        text = MSG_CANCELLED.format(n=withdrawn)
        if late:
            text += MSG_CANCEL_LATE.format(n=late)
        if unsure:
            text += MSG_CANCEL_UNSURE.format(n=unsure)
        await self._reply(msg, text)

    async def _fetch_attachments(self, msg: InboundMessage, pane_id: str) -> list[str]:
        """Download ``msg``'s files into the media folder; one ``[附件]`` line each.

        Only an allowed sender's files are fetched (a stranger never reaches delivery, and
        this checks again). A refused or failed file is reported to the chat and skipped.
        """
        if not msg.attachments:
            return []
        adapter = self._adapters.get((msg.platform, msg.account))
        lang = prompt_skills.language(await self._ui_settings())
        if adapter is None or not callable(getattr(adapter, "download", None)):
            await self._reply(msg, media.text(lang, "unsupported"))
            return []
        if not self.gate.is_allowed(msg.platform, msg.sender_id, msg.account):
            return []
        root = self._seams.media_root()
        await self._prune_media(root)
        limit = media.human_size(media.INBOUND_MAX_BYTES)
        lines: list[str] = []
        for att in msg.attachments:
            name = media.safe_name(att.name, att.kind, att.mime)
            if att.size is not None and att.size > media.INBOUND_MAX_BYTES:
                await self._reply(msg, media.text(lang, "too_large", name=name, limit=limit))
                continue
            try:
                dest = await asyncio.to_thread(media.new_inbound_path, root, pane_id, name)
            except OSError as exc:  # the folder cannot be made: report it, the text still goes
                await self._reply(msg, media.text(lang, "download_failed", name=name,
                                                  error=_failure_text(exc)))
                continue
            try:
                size = await adapter.download(att, dest, media.INBOUND_MAX_BYTES)
            except MediaTooLarge:
                dest.unlink(missing_ok=True)
                await self._reply(msg, media.text(lang, "too_large", name=name, limit=limit))
                continue
            except Exception as exc:  # noqa: BLE001 — reported to the chat, the text still goes
                dest.unlink(missing_ok=True)
                await self._reply(msg, media.text(lang, "download_failed", name=name,
                                                  error=_failure_text(exc)))
                continue
            lines.append(media.attachment_line(att.kind, name, size, dest))
        return lines

    async def _prune_media(self, root: Path) -> None:
        now = time.monotonic()
        if self._media_pruned_at is not None and now - self._media_pruned_at < media.PRUNE_EVERY_S:
            return
        self._media_pruned_at = now
        try:
            await asyncio.to_thread(media.prune, root)
        except Exception as exc:  # noqa: BLE001 — a failed sweep must not drop the message
            log.warning("channels: pruning %s failed: %s", root, exc)

    async def _send_attachments(self, pending: _Pending, paths: list[str]) -> None:
        """Send the files a reply named on ``---ATTACH---`` lines, each checked by
        ``media.resolve_outbound``. Each goes with a report card; an HTML
        file goes as an A4 PDF, or as itself with the card saying why it is not one."""
        loc = pending.loc
        adapter = self._adapters.get((loc.platform, loc.account))
        lang = prompt_skills.language(await self._ui_settings())

        async def note(text: str) -> None:
            with contextlib.suppress(Exception):
                await self.mirror.send(loc, text)

        if adapter is None or not callable(getattr(adapter, "send_file", None)):
            await note(media.text(lang, "unsupported"))
            return
        # Where a pane's files usually come from; anything else is sent and logged.
        usual = [self._seams.pane_workspace(pending.owner), media.pane_dir(self._seams.media_root(), pending.owner)
                 ] if pending.owner else []
        limit = int(getattr(adapter, "upload_max_bytes", 0) or 0)
        budget_end = self._clock() + pdf.REPLY_BUDGET_S
        for raw in paths[: media.MAX_ATTACHMENTS_PER_REPLY]:
            spec = report.parse_attach(raw)
            # Only the file name ever goes back to the chat, never the folders above it.
            name = media.safe_name(Path(spec.path).name)
            try:
                opened, reason = await asyncio.to_thread(media.open_outbound, spec.path)
            except Exception as exc:  # noqa: BLE001 — refuse this one, keep sending the rest
                log.warning("channels: opening an attachment for %s failed: %s", loc.key(), exc)
                opened, reason = None, "changed"
            if opened is None:
                rule = await asyncio.to_thread(media.denied_rule, spec.path) if reason == "denied_name" else ""
                await note(media.text(lang, "refused", name=name, reason=media.text(lang, f"reason.{reason}", rule=rule)))
                continue
            unusual = [why for why, flag in (("a hidden path", opened.hidden), (
                "outside the pane's workspace", not media.is_inside(opened.path, usual))) if flag]
            if unusual:
                # Sent, not refused: the pane decides. The log keeps a record of it.
                log.info("channels: sending %s (%s) to %s", opened.path, ", ".join(unusual), loc.key())
            try:
                ids, title = await self._send_one(adapter, loc, opened, spec, lang, limit, budget_end, note)
            except Exception as exc:  # noqa: BLE001
                await note(media.text(lang, "send_failed", name=name, error=redact.redact_text(str(exc))))
                continue
            finally:
                opened.fh.close()
            if ids and pending.owner:
                self.mirror.owners.remember(loc.key(), ids, pending.owner)
            # A reply to the card tells the pane which report it is about.
            self.mirror.reports.remember(loc, ids, title, spec.path)
        if len(paths) > media.MAX_ATTACHMENTS_PER_REPLY:
            await note(media.text(lang, "too_many", max=media.MAX_ATTACHMENTS_PER_REPLY))

    async def _send_one(self, adapter: Any, loc: Location, opened: media.Outbound, spec: report.AttachSpec,
                        lang: str, limit: int, budget_end: float,
                        note: Callable[[str], Awaitable[None]]) -> tuple[list[str], str]:
        """Send one checked file with its card: (message ids, card title); no ids when it
        was refused (the chat was told)."""
        path = opened.path
        name = media.safe_name(path.name)
        kind = path.suffix.lstrip(".").lower()
        if kind in ("html", "htm"):
            data = await asyncio.to_thread(opened.fh.read)
            card = report.card_for(spec, path.name, data[: report.HEAD_BYTES].decode("utf-8", "replace"))
            remaining = budget_end - self._clock()
            if remaining <= 0:
                failure = "budget"
            else:
                async with pdf.converted(data, self._seams.pdf_root(), self._seams.render_pdf,
                                         min(pdf.TIMEOUT_S, remaining)) as result:
                    failure = result.failure
                    if result.path is not None and limit and result.size > limit:
                        failure = "too_large"
                    elif result.path is not None:
                        fd = os.open(result.path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
                        with os.fdopen(fd, "rb") as fh:
                            # The adapter reads the PDF before the context removes it.
                            return await adapter.send_file(loc, fh, f"{path.stem}.pdf", caption=self._caption_for(
                                loc, report.caption(card.sent_as("pdf", result.size, result.pages), lang))), card.title
            opened.fh.seek(0)
            card = card.sent_as(kind, opened.size, failure=failure)
        else:
            card = report.card_for(spec, path.name, "").sent_as(kind, opened.size)
        if limit and opened.size > limit:
            await note(media.text(lang, "too_large_out", name=name, size=media.human_size(opened.size),
                                  limit=media.human_size(limit)))
            return [], card.title
        # The adapter reads the file already open: a swap after the check cannot change it.
        return await adapter.send_file(loc, opened.fh, path.name,
                                       caption=self._caption_for(loc, report.caption(card, lang))), card.title

    def _quote_trusted(self, msg: InboundMessage) -> bool:
        """The replied-to message may be quoted into the pane (see ``_with_reply_quote``)."""
        author = msg.reply_to_sender_id
        return msg.reply_to_self or (bool(author) and (
            author == msg.sender_id or self.gate.is_allowed(msg.platform, author, msg.account)))

    async def _deliver(self, msg: InboundMessage, binding: Binding, pane_id: str) -> bool:
        """True when the text went to the pane; every refusal has already been replied to."""
        if await self._held_by_prompt(msg, pane_id):
            return False
        queued = self._queued.setdefault(pane_id, set())
        if len(queued) >= MAX_QUEUED_PER_PANE:
            await self._reply(msg, MSG_QUEUE_FULL)
            return False
        now = self._clock()
        sends = [t for t in self._chat_sends.get((pane_id, msg.sender_id), []) if now - t < CHAT_RATE_WINDOW_S]
        self._chat_sends[(pane_id, msg.sender_id)] = sends
        if len(sends) >= CHAT_RATE_MAX:
            wait = math.ceil(sends[0] + CHAT_RATE_WINDOW_S - now)
            await self._reply(msg, MSG_CHAT_RATE.format(max=CHAT_RATE_MAX, wait=wait))
            return False
        state = self._seams.pane_state(pane_id)
        if state.get("display_status") == "stopped":
            # The chat's own next message is the user carrying on, as typing in the pane is;
            # left stopped, the pane would hold it (and every later one) as not ready.
            resumed = await self._seams.resume(pane_id)
            if not resumed.get("ok"):
                log.info("channels: resuming stopped pane %s failed: %s", pane_id, resumed.get("error"))
        files = await self._fetch_attachments(msg, pane_id)
        text = "\n".join(part for part in (msg.text, *files) if part)
        if msg.attachments and not text:
            return False  # every file was refused, and the chat was told why
        body = _with_reply_quote(dataclasses.replace(msg, text=text), self._quote_trusted(msg),
                                 self.mirror.reports.get(msg))
        try:
            result = await self._seams.deliver(pane_id, body, f"{msg.platform}:{msg.sender_name}")
        except Exception as exc:  # noqa: BLE001
            result = {"ok": False, "error": str(exc)}
        if not result.get("ok"):
            await self._reply(msg, f"⚠️ 無法送達 pane：{result.get('error') or 'unknown'}")
            return False
        sends.append(now)
        msg_key = str(result.get("msg_key") or "")
        pane_id = str(result.get("pane_id") or pane_id)
        loc = binding.location()
        pending = self._pending.get(pane_id)
        if pending is None or pending.loc != loc:
            pending = _Pending(loc=loc)
            self._pending[pane_id] = pending
        # The chat's own message comes back as the pane's prompt and its result carries this source.
        self.mirror.echo.remember(pane_id, body)
        pending.source = pending.source or source_chat(msg.sender_name)
        pending.owner = pane_id
        if pane_id != binding.pane_id:
            route = self.mirror.route(pane_id)
            pending.child = route.child if route is not None else ""
        if state.get("busy") and not pending.status_id:
            pending.status_id = await self._reply(msg, MSG_RECEIVED_BUSY, buttons=BUSY_BUTTONS)
        queued.add(msg_key)
        self._queued_loc[msg_key] = msg.location_key()
        self._spawn(self._watch_delivery(pane_id, msg_key, pending))
        return True

    # --- quick menu ------------------------------------------------------------

    def _identity(self, msg: InboundMessage) -> str:
        adapter = self._adapters.get((msg.platform, msg.account))
        return adapter.status.identity if adapter is not None else ""

    async def _ui_settings(self) -> dict[str, Any]:
        try:
            return await asyncio.to_thread(self._seams.ui_settings)
        except Exception as exc:  # noqa: BLE001 — the builtin prompt still works without them
            log.warning("channels: reading ui settings failed: %s", exc)
            return {}

    async def _agent_skills(self, agent_key: str) -> list[str]:
        if agent_key not in quick_menu.SKILL_INVOCATION:
            return []
        try:
            return await asyncio.to_thread(self._seams.agent_skills, agent_key)
        except Exception as exc:  # noqa: BLE001 — a broken skills root leaves the prompts
            log.warning("channels: listing skills for %s failed: %s", agent_key, exc)
            return []

    async def _quick_menu(self, msg: InboundMessage, scope: str = "all") -> None:
        """``/prompts`` (``scope`` "p"): buttons for the bound pane's prompt skills;
        ``/skills`` ("s"): its skills; ``/mcp`` ("mcp"): MCP servers, read-only. ``/menu``
        and a bare ``/start`` ("all") answer with buttons pointing to those three."""
        settings = await self._ui_settings()
        lang = prompt_skills.language(settings)
        binding = self._binding_for(msg)
        if binding is None:
            # Like any unbound message, a bot sharing a group with others stays quiet.
            if msg.is_direct or self._sole_bot(msg.platform):
                await self._reply(msg, quick_menu.text(lang, "not_bound"))
            return
        if scope == "all":
            adapter = self._adapters.get((msg.platform, msg.account))
            buttons = MENU_MOVED_BUTTONS if adapter is not None and adapter.capabilities.buttons else None
            await self._reply(msg, quick_menu.text(lang, "menu_moved"), buttons=buttons)
            return
        pane_id = await self._resolve_after_startup(binding.pane_id)
        if not pane_id:
            await self._reply(msg, wake.text(lang, "offline"))
            return
        adapter = self._adapters.get((msg.platform, msg.account))
        if adapter is None:
            return
        agent_key = self._seams.pane_agent(pane_id)
        if scope == "s" and agent_key not in quick_menu.SKILL_INVOCATION:
            await self._reply(msg, quick_menu.text(lang, "no_skill_syntax"))
            return
        if scope == "mcp":
            menu = self.quick.create_mcp(
                platform=msg.platform, location_key=msg.location_key(), pane_id=pane_id,
                pane_title=binding.title or pane_id, agent_key=agent_key, lang=lang,
                native=await self._agent_mcp(agent_key), navide=await self._navide_mcp(),
            )
        else:
            menu = self.quick.create(
                platform=msg.platform, location_key=msg.location_key(), pane_id=pane_id,
                pane_title=binding.title or pane_id, agent_key=agent_key, lang=lang,
                prompts=prompt_skills.castable(prompt_skills.effective(settings)) if scope != "s" else [],
                skills=await self._agent_skills(agent_key) if scope != "p" else [],
                scope=scope,
            )
        if menu is None:
            empty = {"p": "empty_prompts", "s": "empty_skills", "mcp": "mcp_empty"}.get(scope, "empty")
            await self._reply(msg, quick_menu.text(lang, empty))
            return
        if not adapter.capabilities.buttons or not hasattr(adapter, "send_menu"):
            # No buttons: the same menu as numbered lines, picked with "/prompts <n>" or "/skills <n>".
            await self._reply(msg, redact.redact_text(self.quick.render_text(menu)))
            return
        body, rows = self.quick.render(menu, 0)
        try:
            menu.message_id = await adapter.send_menu(binding.location(), redact.redact_text(body), rows)
        except Exception as exc:  # noqa: BLE001
            log.warning("channels: sending the quick menu on %s failed: %s", msg.platform, exc)
            await self._reply(msg, quick_menu.text(lang, "send_failed", error=redact.redact_text(str(exc))))

    def _menu_buttons(self, msg: InboundMessage) -> bool:
        """Whether this chat's quick menus come as buttons rather than numbered lines."""
        adapter = self._adapters.get((msg.platform, msg.account))
        return adapter is not None and adapter.capabilities.buttons and hasattr(adapter, "send_menu")

    async def _quick_press(self, msg: InboundMessage) -> None:
        settings = await self._ui_settings()
        parsed = quick_menu.parse_callback(msg.callback_data)
        press = self.quick.press(*parsed, msg.location_key()) if parsed else None
        lang = press.menu.lang if press is not None else prompt_skills.language(settings)
        binding = self._binding_for(msg)
        pane_id = self._seams.resolve_pane(binding.pane_id) if binding is not None else ""
        # A menu made for a pane the chat no longer drives is as dead as an expired one.
        if press is None or not pane_id or pane_id != self._seams.resolve_pane(press.menu.pane_id):
            mcp = press is not None and press.menu.scope == "mcp"
            await self._reply(msg, quick_menu.text(lang, "mcp_expired" if mcp else "expired"))
            return
        if press.kind == "g":
            await self._quick_page(msg, press.menu, int(press.key))
            return
        if press.kind in ("n", "m"):
            await self._mcp_detail(msg, press, pane_id, lang)
            return
        await self._quick_cast(msg, press, binding, pane_id, settings, lang)

    async def _quick_pick(self, msg: InboundMessage, number: int, mcp: bool = False,
                          scope: str | None = None) -> None:
        """``/menu <n>``: item ``n`` of the text menu this chat was sent; ``/prompts <n>``
        and ``/skills <n>`` (``scope`` "p" / "s"): of that command's newest one; ``/mcp <n>``
        (``mcp``): server ``n`` of its /mcp list."""
        settings = await self._ui_settings()
        menu = self.quick.latest(msg.location_key(), mcp, scope)
        lang = menu.lang if menu is not None else prompt_skills.language(settings)
        binding = self._binding_for(msg)
        if binding is None:
            # As /menu: a bot sharing a group with others stays quiet.
            if msg.is_direct or self._sole_bot(msg.platform):
                await self._reply(msg, quick_menu.text(lang, "not_bound"))
            return
        pane_id = self._seams.resolve_pane(binding.pane_id)
        if menu is None or not pane_id or pane_id != self._seams.resolve_pane(menu.pane_id):
            await self._reply(msg, quick_menu.text(lang, "mcp_expired" if mcp else "expired"))
            return
        press = self.quick.pick(msg.location_key(), number, mcp, scope)
        if press is None:
            await self._reply(msg, quick_menu.text(lang, "bad_pick_mcp" if mcp else "bad_pick"))
            return
        if mcp:
            await self._mcp_detail(msg, press, pane_id, lang)
            return
        await self._quick_cast(msg, press, binding, pane_id, settings, lang)

    async def _agent_mcp(self, agent_key: str) -> list[dict[str, Any]]:
        try:
            return await asyncio.to_thread(self._seams.agent_mcp, agent_key)
        except Exception as exc:  # noqa: BLE001 — an unreadable config leaves Navide's group
            log.warning("channels: listing %s's MCP servers failed: %s", agent_key, exc)
            return []

    async def _navide_mcp(self) -> list[dict[str, Any]]:
        try:
            return await self._seams.navide_mcp()
        except Exception as exc:  # noqa: BLE001 — the CLI's group still lists
            log.warning("channels: listing Navide's MCP servers failed: %s", exc)
            return []

    async def _mcp_detail(self, msg: InboundMessage, press: quick_menu.Press, pane_id: str, lang: str) -> None:
        """One server of an /mcp list, read again now: allowlisted fields, never a change."""
        if press.kind == "n":
            agent_key = self._seams.pane_agent(pane_id)
            row = next((r for r in await self._agent_mcp(agent_key) if r["name"] == press.key), None)
            body = quick_menu.mcp_cli_detail(lang, row, agent_key) if row is not None else ""
        else:
            row = next((r for r in await self._navide_mcp() if r["name"] == press.key), None)
            body = ""
            if row is not None:
                try:
                    tools = await self._seams.navide_mcp_tools(press.key) if row["status"] == "connected" else []
                except Exception as exc:  # noqa: BLE001
                    log.warning("channels: listing %s's MCP tools failed: %s", press.key, exc)
                    tools = []
                body = quick_menu.mcp_navide_detail(lang, row, tools)
        if not body:
            await self._reply(msg, quick_menu.text(lang, "mcp_gone", name=press.label))
            return
        await self._reply(msg, redact.redact_text(body))

    async def _quick_cast(self, msg: InboundMessage, press: quick_menu.Press, binding: Binding,
                          pane_id: str, settings: dict[str, Any], lang: str) -> None:
        """Send the prompt or skill ``press`` stands for to ``pane_id``, once."""
        if press.kind == "p":
            prompt = next((p for p in prompt_skills.castable(prompt_skills.effective(settings))
                           if p["id"] == press.key), None)
            text = prompt["prompt"] if prompt is not None else ""
        else:
            agent_key = self._seams.pane_agent(pane_id)
            available = press.key in await self._agent_skills(agent_key)
            text = quick_menu.skill_command(agent_key, press.key) if available else ""
        if not text:
            await self._reply(msg, quick_menu.text(lang, "gone", name=press.label))
            return
        # Sent once, as if typed: the default prompt skill starts no loop from chat.
        if await self._deliver(dataclasses.replace(msg, text=text, callback_data=""), binding, pane_id):
            await self._reply(msg, quick_menu.text(lang, "sent", name=press.label))

    async def _quick_page(self, msg: InboundMessage, menu: quick_menu.Menu, page: int) -> None:
        adapter = self._adapters.get((msg.platform, msg.account))
        if adapter is None or not hasattr(adapter, "edit_menu"):
            return
        loc = Location(msg.platform, msg.account, msg.chat_id, msg.thread_id)
        body, rows = self.quick.render(menu, page)
        body = redact.redact_text(body)
        try:
            await adapter.edit_menu(loc, menu.message_id, body, rows)
        except Exception as exc:  # noqa: BLE001 — too old to edit, or deleted: post the page anew
            log.info("channels: editing the quick menu failed (%s); sending it again", exc)
            try:
                menu.message_id = await adapter.send_menu(loc, body, rows)
            except Exception as exc2:  # noqa: BLE001
                log.warning("channels: sending the quick menu on %s failed: %s", msg.platform, exc2)
                await self._reply(msg, quick_menu.text(menu.lang, "send_failed",
                                                       error=redact.redact_text(str(exc2))))

    # --- share links -------------------------------------------------------------

    def _shares_reachable(self, msg: InboundMessage) -> bool:
        """Only a bound chat on a machine linked to Navide Cloud handles /shares and
        /revoke; anywhere else they travel on exactly as they did before."""
        from .. import server_link

        return server_link.link_state() == server_link.STATE_CONNECTED and self._binding_for(msg) is not None

    async def _share_call(self, msg: InboundMessage, lang: str, call: Callable[[Any], Awaitable[Any]]) -> tuple[str, Any]:
        """``("ok", result)``; ``("unavailable", None)`` when the server does no share links;
        ``("failed", None)`` once the chat has been told why."""
        from .. import share_links, sync_keyring

        try:
            return "ok", await call(share_links.ServerLinksClient())
        except share_links.ShareRemoteError as exc:
            if exc.code in share_links.UNAVAILABLE_CODES:
                return "unavailable", None
            error: Exception = exc
        except (share_links.ShareError, sync_keyring.KeyringError) as exc:
            error = exc
        log.info("channels: a share link call from %s failed: %s", msg.platform, error)
        await self._reply(msg, quick_menu.text(lang, "shares_failed", error=redact.redact_text(str(error))))
        return "failed", None

    async def _share_command(self, msg: InboundMessage, command: str, arg: str) -> bool:
        """``/shares`` or ``/revoke``; False leaves the message to the usual pipeline."""
        from .. import share_links

        if not self._shares_reachable(msg):
            return False
        lang = prompt_skills.language(await self._ui_settings())
        outcome, links = await self._share_call(msg, lang, share_links.list_links)
        if outcome != "ok":
            return outcome == "failed"
        live = share_cmds.active(links)
        if command == "shares":
            await self._share_list(msg, lang, live[:share_cmds.MAX_LISTED])
            return True
        if not share_cmds.valid_prefix(arg):
            await self._reply(msg, quick_menu.text(lang, "revoke_usage"))
            return True
        matches = [link for link in live if str(link.get("linkId") or "").startswith(arg)]
        if len(matches) != 1:
            key = "revoke_none" if not matches else "revoke_ambiguous"
            # Echo no more of the id than a link is ever named by: the full id may be typed in a group.
            await self._reply(msg, quick_menu.text(lang, key, prefix=arg[:share_cmds.SHORT_LEN], count=len(matches)))
            return True
        return await self._share_revoke(msg, lang, matches[0])

    async def _share_list(self, msg: InboundMessage, lang: str, links: list[dict[str, Any]]) -> None:
        if not links:
            await self._reply(msg, quick_menu.text(lang, "shares_empty"))
            return
        body = redact.redact_text(share_cmds.render_list(lang, links))
        adapter = self._adapters.get((msg.platform, msg.account))
        if adapter is None or not adapter.capabilities.buttons or not hasattr(adapter, "send_menu"):
            await self._reply(msg, body)  # /revoke still works without buttons
            return
        loc = Location(msg.platform, msg.account, msg.chat_id, msg.thread_id)
        rows = self.share_buttons.rows(msg.platform, msg.location_key(), lang, links)
        try:
            await adapter.send_menu(loc, body, rows)
        except Exception as exc:  # noqa: BLE001
            log.warning("channels: sending the share list on %s failed: %s", msg.platform, exc)
            await self._reply(msg, body)

    async def _share_revoke(self, msg: InboundMessage, lang: str, link: dict[str, Any]) -> bool:
        from .. import share_links

        link_id = str(link["linkId"])
        outcome, _ = await self._share_call(msg, lang, lambda client: share_links.revoke(client, link_id))
        if outcome == "ok":
            await self._reply(msg, redact.redact_text(quick_menu.text(
                lang, "revoked", title=share_cmds.title(lang, link), short=share_cmds.short(link))))
        return outcome != "unavailable"

    async def _share_press(self, msg: InboundMessage) -> bool:
        """A revoke button; False leaves the press to be dropped as before."""
        from .. import share_links

        if not self._shares_reachable(msg):
            return False
        lang = prompt_skills.language(await self._ui_settings())
        token = share_cmds.parse_callback(msg.callback_data)
        link_id = self.share_buttons.press(token, msg.location_key()) if token else None
        if link_id is None:
            await self._reply(msg, quick_menu.text(lang, "shares_expired"))
            return True
        # Named from a fresh list: the title shown is the link's current one.
        outcome, links = await self._share_call(msg, lang, share_links.list_links)
        if outcome != "ok":
            return outcome == "failed"
        link = next((row for row in links if row.get("linkId") == link_id), {"linkId": link_id})
        return await self._share_revoke(msg, lang, link)

    def _chat_kind(self, b: Binding) -> str:
        return self._kind_at(b.location())

    def _kind_at(self, loc: Location) -> str:
        """"direct" or "group" as the chat was remembered; "" when never seen."""
        adapter = self._adapters.get((loc.platform, loc.account))
        if adapter is None:
            return ""
        return next((str(c["kind"]) for c in self.store.chats(loc.platform, _bot_key(adapter))
                     if c["chat_id"] == loc.chat_id), "")

    def _for_chat(self, loc: Location, text: str) -> str:
        """``text`` as ``loc`` may see it: a share link whole only in a known direct chat,
        cut to its first characters (key dropped) anywhere else, unknown chats included."""
        masked = share_cmds.mask_links(text)
        if masked == text or self._kind_at(loc) == "direct":
            return text
        return masked

    def _caption_for(self, loc: Location, card: report.Caption) -> report.Caption:
        return report.Caption(self._for_chat(loc, card.title), self._for_chat(loc, card.summary),
                              self._for_chat(loc, card.info))

    def _share_targets(self, pane_id: str, chat_id: str = "") -> list[Location]:
        """Where a share notice goes: only ever a bound direct chat. The one the creator
        picked (``chat_id``, a ``Location.key()``) when given, else the creating pane's;
        nothing when that chat is not a bound direct chat or there is no pane."""
        targets: dict[str, Location] = {}
        for b in self.store.bindings():
            key = b.location().key()
            if (key == chat_id if chat_id else bool(pane_id) and b.pane_id == pane_id) \
                    and self._chat_kind(b) == "direct":
                targets.setdefault(key, b.location())
        return list(targets.values())

    def share_targets(self) -> dict[str, Any]:
        """The chats a new link can be sent to (``channels.share_targets``): every bound
        direct chat once, ``chatId`` being what ``notify_link_created`` takes back. Empty
        without Navide Cloud, read from the link state alone."""
        from .. import server_link

        if server_link.link_state() != server_link.STATE_CONNECTED:
            return {"ok": True, "chats": []}
        chats: dict[str, dict[str, str]] = {}
        for b in self.store.bindings():
            if b.location().key() not in chats and self._chat_kind(b) == "direct":
                chats[b.location().key()] = {"chatId": b.location().key(), "platform": b.platform,
                                             "name": b.title or b.chat_id}
        return {"ok": True, "chats": list(chats.values())}

    async def _share_notice(self, loc: Location, text: str) -> None:
        try:
            await self.mirror.send(loc, text)
        except Exception as exc:  # noqa: BLE001 — one chat failing must not stop the others
            log.warning("channels: a share-link notice to %s failed: %s", loc.platform,
                        share_cmds.mask_links(str(exc)))

    async def notify_share_created(self, link: dict[str, Any]) -> None:
        chat_id = str(link.get("chatId") or "")
        targets = self._share_targets(str(link.get("paneId") or ""), chat_id)
        if chat_id and not targets:
            log.info("channels: the chat picked for share link %s is not a bound direct chat; not sent",
                     share_cmds.short(link))
        lang = prompt_skills.language(await self._ui_settings())
        for loc in targets:
            await self._share_notice(loc, share_cmds.created_text(lang, link))

    async def notify_share_opened(self, event: dict[str, Any]) -> None:
        """Only for a new viewer, only with the switch on, and only on the device that
        created the link, so an account with several machines hears it once."""
        from .. import server_link, share_links, sync_keyring

        if not event.get("newViewer") or not self.store.share_open_notify():
            return
        me = server_link.local_device_id()
        if not me:
            return
        try:
            links = await share_links.list_links(share_links.ServerLinksClient())
        except (share_links.ShareError, sync_keyring.KeyringError) as exc:
            log.info("channels: listing share links for an opened notice failed: %s", exc)
            return
        link = next((row for row in links if row.get("linkId") == event.get("linkId")), None)
        if link is None or link.get("deviceId") != me:
            return
        opens = event.get("openCount")
        opens = opens if isinstance(opens, int) else int(link.get("openCount") or 0)
        lang = prompt_skills.language(await self._ui_settings())
        for loc in self._share_targets(str(link.get("paneId") or "")):
            await self._share_notice(loc, share_cmds.opened_text(lang, link, opens))

    async def _watch_delivery(self, pane_id: str, msg_key: str, pending: _Pending) -> None:
        adapter = self._adapters.get((pending.loc.platform, pending.loc.account))
        started = self._clock()
        held_notice = False
        try:
            while True:
                verdict = await self._seams.await_verdict(msg_key, VERDICT_POLL_S)
                status = verdict.get("status")
                # "unconfirmed" was typed and submitted, only not seen taken:
                # the reply, if any, is the pane's next turn — same as delivered.
                if status in ("delivered", "unconfirmed"):
                    self._arm(pane_id, pending)
                    return
                if status in ("failed", "cancelled"):
                    if adapter is not None and status == "failed":
                        await self._notice(adapter, pending.loc, f"⚠️ 訊息沒有送進 pane（{verdict.get('reason') or 'failed'}）")
                    return
                age = self._clock() - started
                hold = (verdict.get("hold") or {}).get("key") or ""
                if adapter is not None and not held_notice:
                    if hold in HOLD_FAILURE_KEYS and age >= HOLD_FAILURE_AFTER_S:
                        held_notice = True
                        await self._notice(adapter, pending.loc, f"⚠️ pane 目前無法接收訊息（{hold}），訊息仍在排隊")
                    elif age >= HELD_NOTICE_AFTER_S:
                        held_notice = True
                        await self._notice(adapter, pending.loc, f"⚠️ 訊息已排隊超過 {int(age // 60)} 分鐘（{hold or 'queued'}）")
                if age >= VERDICT_WATCH_MAX_S or verdict.get("unknown"):
                    return
                # await_verdict only parks while the status is "queued"; any
                # other status comes straight back, and the loop must not spin.
                if status != "queued":
                    await asyncio.sleep(VERDICT_POLL_S)
        finally:
            q = self._queued.get(pane_id)
            if q is not None:
                q.discard(msg_key)
                if not q:
                    self._queued.pop(pane_id, None)
            self._queued_loc.pop(msg_key, None)

    def _arm(self, pane_id: str, pending: _Pending) -> None:
        """The message is in the pane: its next turn_complete is the reply.

        The pending this delivery started with may already be gone — an earlier
        message's turn ended (and was answered) while this one sat in the pane's
        queue. Re-create it for the same location, unless the pane was unbound
        or rebound meanwhile.
        """
        current = self._pending.get(pane_id)
        if current is None or current.loc != pending.loc:
            route = self.mirror.route(pane_id)
            if route is None or route.binding.location() != pending.loc:
                return
            current = _Pending(loc=pending.loc, source=pending.source, child=pending.child, owner=pending.owner)
            self._pending[pane_id] = current
        if current.armed_at is None:
            current.armed_at = self._clock()
            current.started = current.armed_at
        if current.task is None or current.task.done():
            current.task = self._spawn(self._while_running(pane_id, current))

    async def _notice(self, adapter: ChannelAdapter, loc: Location, text: str) -> None:
        try:
            await self.mirror.send(loc, text)
        except Exception as exc:  # noqa: BLE001
            log.warning("channels: notice to %s failed: %s", loc.key(), exc)

    async def _while_running(self, pane_id: str, pending: _Pending) -> None:
        """Typing every 4s, one status message edited in place, awaiting notices."""
        adapter = self._adapters.get((pending.loc.platform, pending.loc.account))
        if adapter is None:
            return
        caps = adapter.capabilities
        if caps.edit and not pending.quiet:
            if pending.status_id:
                await self._edit_status(adapter, pending, MSG_WORKING, force=True)
            else:
                async def send_status() -> str:
                    try:
                        ids = await self.mirror.send(pending.loc, MSG_WORKING)
                    except Exception:  # noqa: BLE001
                        return ""
                    return ids[0] if ids else ""

                # Its own task: a turn end cancels this run, not the send, and settles it.
                pending.status_send = self._spawn(send_status())
                pending.status_id = await asyncio.shield(pending.status_send)
                pending.status_send = None
        next_typing = next_edit = next_probe = self._clock()
        capped = False
        while self._pending.get(pane_id) is pending:
            now = self._clock()
            if not capped and now - pending.started >= RUN_WATCH_MAX_S:
                # No turn end in sight (crashed pane, missed event): stop the
                # indicators but keep the pending so a late turn_complete still replies.
                # The awaiting probe goes on: a prompt can outlive its relay id.
                capped = True
                await self._edit_status(adapter, pending, MSG_STILL_RUNNING, force=True)
            if not capped and caps.typing and not pending.quiet and now >= next_typing:
                next_typing = now + TYPING_EVERY_S
                try:
                    await adapter.send_typing(pending.loc)
                except Exception:  # noqa: BLE001
                    pass
            if not capped and caps.edit and not pending.quiet and pending.status_id and now >= next_edit:
                next_edit = now + STATUS_EDIT_EVERY_S
                await self._edit_status(adapter, pending, MSG_WORKING)
            if now >= next_probe:
                next_probe = now + AWAITING_PROBE_EVERY_S
                await self._check_awaiting(adapter, pane_id, pending)
            if not pending.limit_noticed and now >= pending.next_limit_probe:
                pending.next_limit_probe = now + LIMIT_PROBE_EVERY_S
                await self._check_usage_limit(adapter, pane_id, pending)
            await asyncio.sleep(RUN_TICK_S)

    async def _check_usage_limit(self, adapter: ChannelAdapter, pane_id: str, pending: _Pending) -> None:
        """Tell the chat, once per run, that its pane hit a usage limit. A limited turn writes
        no turn end, so the run stays open: the reply after the reset still lands under it."""
        if self._seams.pane_state(pane_id).get("display_status") == "awaiting":
            return  # the awaiting relay has the screen
        try:
            info = await self._seams.limit_info(pane_id)
        except Exception:  # noqa: BLE001
            return
        until = info.get("until")
        if isinstance(until, bool) or not isinstance(until, (int, float)) or until <= 0:
            until = None
        screen = " ".join(str(info.get("buffer") or "").split())
        menu = bool(_LIMIT_MENU_RE.search(screen))
        if until is None and not menu:
            return
        pending.limit_noticed = True
        if until is not None:
            t = time.localtime(until / 1000)
            reset = f"{t.tm_mon}/{t.tm_mday} {t.tm_hour:02d}:{t.tm_min:02d}"
        else:
            found = _LIMIT_RESETS_RE.search(screen)
            reset = found.group(1) if found else ""
        agent = self._seams.pane_agent(pane_id)
        agent = "Claude" if agent in ("", "claude") else agent
        lines = [MSG_USAGE_LIMIT.format(agent=agent, reset=reset) if reset
                 else MSG_USAGE_LIMIT_NO_RESET.format(agent=agent)]
        if menu:
            lines.append(MSG_USAGE_LIMIT_MENU)
        lines.append(MSG_USAGE_LIMIT_KEPT)
        await self._notice(adapter, pending.loc, "\n".join(lines))

    async def _edit_status(self, adapter: ChannelAdapter, pending: _Pending, text: str, *, force: bool = False) -> None:
        if not pending.status_id and pending.status_send is not None:
            # The turn ended before the status message's id came back: wait for it, bounded.
            # No id in time, and the text goes as a fresh message, ahead of the reply.
            send, pending.status_send = pending.status_send, None
            try:
                pending.status_id = await asyncio.wait_for(asyncio.shield(send), STATUS_SEND_WAIT_S)
            except asyncio.TimeoutError:
                pass
            if not pending.status_id:
                self.mirror.post(pending.loc, text)
                return
        if not pending.status_id or pending.status_failures >= STATUS_EDIT_MAX_FAILURES:
            return
        now = self._clock()
        if not force and now - pending.last_edit < STATUS_EDIT_MIN_INTERVAL_S:
            return
        pending.last_edit = now
        try:
            await adapter.edit_text(pending.loc, pending.status_id, text)
            pending.status_failures = 0
        except Exception:  # noqa: BLE001
            pending.status_failures += 1

    async def _check_awaiting(self, adapter: ChannelAdapter, pane_id: str, pending: _Pending) -> None:
        state = self._seams.pane_state(pane_id)
        if state.get("display_status") != "awaiting":
            if pending.awaiting_posted or pane_id in self._awaiting_posted:
                self._retire_relay(pane_id, MSG_RELAY_DONE_LOCALLY)  # answered at the keyboard
            pending.awaiting_posted = False
            self._awaiting_posted.discard(pane_id)
            self._awaiting_failures.pop(pane_id, None)
            self._awaiting_shown.pop(pane_id, None)
            return
        if pending.awaiting_posted or pane_id in self._awaiting_posted:
            # Still awaiting: a follow-up question or an expired id is relayed again.
            await self._post_awaiting(pane_id, pending.loc, pending.child, only_if_changed=True)
            return
        pending.awaiting_posted = True
        self._awaiting_posted.add(pane_id)
        await self._post_awaiting(pane_id, pending.loc, pending.child)

    async def _post_awaiting(self, pane_id: str, loc: Location, child: str = "", *,
                             only_if_changed: bool = False) -> None:
        """Relay a pane's permission/question to ``loc`` (always pushed, whoever started the turn).

        ``only_if_changed``: the pane's prompt was relayed already; post again only when
        the screen shows a different prompt or the posted id ran out unanswered."""
        if pane_id in self._awaiting_busy:
            return  # a probe and a status change raced: one relay is enough
        self._awaiting_busy.add(pane_id)
        try:
            await self._relay_awaiting(pane_id, loc, child, only_if_changed)
        finally:
            self._awaiting_busy.discard(pane_id)

    async def _follow_up(self, pane_id: str, loc: Location, child: str) -> None:
        """After an answer, relay the pane's next prompt even with no run probing it."""
        await asyncio.sleep(AWAITING_PROBE_EVERY_S)
        if self._seams.pane_state(pane_id).get("display_status") == "awaiting":
            await self._post_awaiting(pane_id, loc, child, only_if_changed=True)

    async def _relay_awaiting(self, pane_id: str, loc: Location, child: str, only_if_changed: bool) -> None:
        adapter = self._adapters.get((loc.platform, loc.account))
        if only_if_changed:
            shown = self._awaiting_shown.get(pane_id)
            if adapter is None or shown is None:
                return  # still being relayed, or given up on
            try:
                info = await self._seams.awaiting_info(pane_id)
            except Exception:  # noqa: BLE001
                return  # the next probe looks again
            expired = bool(shown.request_id) and self.relay.get(shown.request_id) is None
            if relay.same_prompt(str(info.get("prompt") or ""), shown.prompt) and not expired:
                return
        elif adapter is None:
            self._awaiting_failed(pane_id, "not connected")
            return
        else:
            try:
                info = await self._seams.awaiting_info(pane_id)
            except Exception as exc:  # noqa: BLE001
                if self._awaiting_failures.get(pane_id, 0) + 1 < AWAITING_RETRY_MAX:
                    self._awaiting_failed(pane_id, f"awaiting_info: {exc}")
                    return
                info = {}  # last attempt: a generic prompt beats none
        prompt = str(info.get("prompt") or "")
        kind = str(info.get("kind") or "") or "permission"
        options = [str(o) for o in (info.get("options") or [])]
        if kind == "question" and not options:
            # A plain-text question at turn end: the turn's text already reached the
            # chat, and a typed reply goes in like any message.
            self._awaiting_failures.pop(pane_id, None)
            self._awaiting_shown[pane_id] = _Shown(prompt)
            return
        # Claude's AskUserQuestion reports "permission"; the options tell them apart.
        if options:
            kind = "permission" if options[0].strip().lower().startswith("yes") else "question"
        who = f"↳ {child} " if child else ""
        if not info.get("answerable", True):
            # No keys Navide could press for this vendor: buttons would only fail.
            await self._send_awaiting(pane_id, loc, prompt, who + MSG_AWAITING_LOCAL)
            return
        if any(relay.is_multi_select(o) for o in options):
            # Toggling a box is one key, submitting is more: nothing to relay safely.
            lines = [f"{who}⏸ pane 需要確認（question）", *([prompt.strip()] if prompt.strip() else []),
                     relay.COMPUTER_ONLY]
            await self._send_awaiting(pane_id, loc, prompt, "\n".join(lines))
            return
        if not self._relay_enabled(loc.platform, loc.account):
            await self._notice(adapter, loc, f"{who}⏸ pane 等待確認（{kind}）")
            self._awaiting_shown[pane_id] = _Shown(prompt)
            return
        self._retire_relay(pane_id, MSG_RELAY_SUPERSEDED)  # one live request per pane
        request = self.relay.create(pane_id, kind, options, loc, prompt=prompt)
        text = who + relay.prompt_text(request, prompt)
        buttons = relay.buttons_for(request) if adapter.capabilities.buttons else None
        try:
            ids = await self.mirror.send(loc, text, owner=pane_id, buttons=buttons or None)
        except Exception as exc:  # noqa: BLE001
            log.warning("channels: relay prompt to %s failed: %s", loc.key(), exc)
            self.relay.expire_pane(pane_id)  # never delivered: nothing may answer it
            self._awaiting_failed(pane_id, str(exc))
            return
        if ids:
            request.message_id = ids[-1]
            # A chunked prompt keeps only its last chunk in the edited message.
            request.message_text = text if len(ids) == 1 else ""
        self._awaiting_failures.pop(pane_id, None)
        self._awaiting_shown[pane_id] = _Shown(prompt, request.id)
        # Relayed: a run's probe that has not seen it yet must not post it a second time.
        self._awaiting_posted.add(pane_id)

    def _retire_relay(self, pane_id: str, note: str) -> None:
        """Expire the pane's relay requests and mark their chat prompts settled, so a
        button nobody can use any more is not left to be pressed. An edit replaces
        the message, buttons included; a platform that cannot edit keeps it as is."""
        for request in self.relay.expire_pane(pane_id):
            if request.message_id:
                self._spawn(self._settle_prompt(request, note))

    def _relay_expired(self, request: relay.RelayRequest) -> None:
        """A request the TTL removed: its chat prompt says so and drops its buttons."""
        if request.message_id:
            self._spawn(self._settle_prompt(request, MSG_RELAY_EXPIRED))

    async def _settle_prompt(self, request: relay.RelayRequest, note: str) -> None:
        adapter = self._adapters.get((request.loc.platform, request.loc.account))
        if not request.message_id or adapter is None or not adapter.capabilities.edit:
            return
        for message_id, message_text in [(request.message_id, request.message_text), *request.held]:
            text = f"{message_text}\n\n{note}" if message_text else note
            try:
                await adapter.edit_text(request.loc, message_id, redact.redact_text(self._for_chat(request.loc, text)))
            except Exception as exc:  # noqa: BLE001
                log.warning("channels: settling relay prompt in %s failed: %s", request.loc.key(), exc)

    async def _send_awaiting(self, pane_id: str, loc: Location, prompt: str, text: str) -> None:
        """An awaiting notice with nothing to answer, retried like a relay prompt."""
        self._retire_relay(pane_id, MSG_RELAY_SUPERSEDED)  # an earlier prompt's id no longer applies
        try:
            await self.mirror.send(loc, text, owner=pane_id)
        except Exception as exc:  # noqa: BLE001
            log.warning("channels: awaiting notice to %s failed: %s", loc.key(), exc)
            self._awaiting_failed(pane_id, str(exc))
            return
        self._awaiting_failures.pop(pane_id, None)
        self._awaiting_shown[pane_id] = _Shown(prompt)

    def _awaiting_failed(self, pane_id: str, why: str) -> None:
        """An awaiting prompt did not reach the chat: unmark it so the next probe or
        status change retries, up to AWAITING_RETRY_MAX attempts per prompt."""
        failures = self._awaiting_failures.get(pane_id, 0) + 1
        self._awaiting_failures[pane_id] = failures
        if failures >= AWAITING_RETRY_MAX:
            log.warning("channels: giving up relaying %s's awaiting prompt: %s", pane_id, why)
            return
        self._awaiting_unmark(pane_id)

    def _awaiting_unmark(self, pane_id: str) -> None:
        """Let the next probe or status change relay the pane's prompt again."""
        self._awaiting_posted.discard(pane_id)
        pending = self._pending.get(pane_id)
        if pending is not None:
            pending.awaiting_posted = False

    def _drop_pending(self, pane_id: str) -> None:
        pending = self._pending.pop(pane_id, None)
        if pending and pending.task:
            pending.task.cancel()
        # A run held for the text half of its turn end goes too: what the pane says next is
        # no longer that chat's to read (unbound, or the pane went away).
        held = self._textless.pop(pane_id, None)
        if held is not None:
            held[1].cancel()
        self._awaiting_posted.discard(pane_id)
        self._awaiting_failures.pop(pane_id, None)
        self._awaiting_shown.pop(pane_id, None)


    # --- Settings overview (channels.overview / unbind_many / focus_pane) ------------

    def _pane_info(self, binding: Binding, directory: dict[str, dict[str, Any]]) -> dict[str, Any]:
        """Who a binding drives, from the messaging registry (no I/O). A pane that no
        longer resolves keeps the title it was bound under so the row still says who."""
        current = self._seams.resolve_pane(binding.pane_id)
        entry = directory.get(current) if current else None
        if not current:
            return {"exists": False, "name": binding.title.removeprefix("↳ "), "qualified_name": "",
                    "workspace_path": "", "display_status": "", "agent_key": ""}
        return {
            "exists": True,
            "name": str((entry or {}).get("name") or binding.title.removeprefix("↳ ")),
            "qualified_name": str((entry or {}).get("qualified_name") or ""),
            "workspace_path": self._seams.pane_workspace(current),
            "display_status": str((entry or {}).get("display_status") or ""),
            "agent_key": self._seams.pane_agent(current),
        }

    def overview(self) -> dict[str, Any]:
        """Every bot with the chats it knows and the panes bound to each, in one answer."""
        self._sync_bindings()
        directory = {str(p.get("pane_id")): p for p in self._seams.pane_directory()}
        bots: dict[BotKey, dict[str, Any]] = {}

        def bot(platform: str, account: str) -> dict[str, Any]:
            if (platform, account) not in bots:
                chats: dict[str, dict[str, Any]] = {}
                if (platform, account) in self._adapters:
                    for loc in self.locations(platform, account)["locations"]:
                        chat_id = str(loc.get("chat_id"))
                        chats[chat_id] = {"chat_id": chat_id, "title": str(loc.get("title") or ""),
                                          "kind": str(loc.get("kind") or ""),
                                          "supports_topics": bool(loc.get("supports_topics")),
                                          "bindings": []}
                bots[(platform, account)] = {"platform": platform, "account": account,
                                             "chats": chats, "orphans": []}
            return bots[(platform, account)]

        for platform, account in self.store.accounts():
            bot(platform, account)
        for b in self.store.bindings():
            entry = bot(b.platform, b.account)
            # A chat bound under another token (or never seen again) still shows up.
            chat = entry["chats"].setdefault(b.chat_id, {
                "chat_id": b.chat_id, "title": "" if b.thread_id else b.title, "kind": "",
                "supports_topics": bool(b.thread_id), "bindings": []})
            pane = self._pane_info(b, directory)
            chat["bindings"].append({**b.public(), "pane_id": self._seams.resolve_pane(b.pane_id) or b.pane_id,
                                     "created_at": b.created_at, "pane": pane})
            if not pane["exists"]:
                entry["orphans"].append(b.pane_id)
        return {"ok": True, "bots": [{**v, "chats": list(v["chats"].values())} for v in bots.values()]}

    async def unbind_many(self, pane_ids: list[str]) -> dict[str, Any]:
        """unbind() each pane (each chat is told, auto children are released) with one
        channels.changed at the end; a failure is reported per pane, not for the batch."""
        names = {str(p.get("pane_id")): str(p.get("name") or "") for p in self._seams.pane_directory()}
        results: list[dict[str, Any]] = []
        self._changed_hold += 1
        try:
            for pane_id in pane_ids:
                try:
                    res = await self.unbind(pane_id, pane_name=names.get(self._seams.resolve_pane(pane_id), ""))
                    results.append({"pane_id": pane_id, "ok": True, "removed": bool(res.get("removed"))})
                except Exception as exc:  # noqa: BLE001 — one bad row must not stop the rest
                    log.warning("channels: unbind of %s failed", pane_id, exc_info=True)
                    results.append({"pane_id": pane_id, "ok": False, "error": f"{type(exc).__name__}: {exc}"})
        finally:
            self._changed_hold -= 1
        if not self._changed_hold and self._changed_missed:
            self._changed_missed = False
            await self._changed()
        return {"ok": True, "results": results}

    def focus_pane(self, pane_id: str) -> dict[str, Any]:
        """The pane a binding row names, as it is now: the window raises it by this id."""
        current = self._seams.resolve_pane(pane_id) if pane_id else ""
        if not current:
            return {"ok": False, "error": "pane not found"}
        return {"ok": True, "pane_id": current, "workspace_path": self._seams.pane_workspace(current)}


def _default_managed_username(manager_username: str) -> str:
    """``{manager}_{4 random}_bot``, the manager part cut to keep it within the username limit."""
    suffix = f"_{secrets.token_hex(2)}_bot"
    return f"{manager_username[:TELEGRAM_USERNAME_MAX - len(suffix)]}{suffix}"


def _check_platform(platform: str) -> None:
    if platform not in PLATFORMS:
        raise ValueError(f"unknown platform {platform!r}")


def _check_account(account: str) -> None:
    if not _ACCOUNT_RE.match(account or ""):
        raise ValueError(f"invalid account id {account!r}")


def _bot_label(bot: BotKey) -> str:
    """How errors name a bot: the bare platform for "default", as they always have."""
    platform, account = bot
    return platform if account == DEFAULT_ACCOUNT else f"{platform}/{account}"


def _failure_text(exc: BaseException) -> str:
    """What the chat is told about a failed file: an OS error's reason only (its message
    names a folder on this computer), anything else redacted."""
    if isinstance(exc, OSError) and exc.strerror:
        return exc.strerror
    if isinstance(exc, OSError):
        return type(exc).__name__
    return redact.redact_text(str(exc))


def _default_media_root() -> Path:
    from ..applog import app_data_dir

    return media.media_root(app_data_dir())


def _default_pdf_root() -> Path:
    from ..applog import app_data_dir

    return pdf.pdf_root(app_data_dir())


def _chat_msg_bodies(text: str) -> list[str]:
    """Bodies of the MSG blocks in a turn that are addressed to a chat sender."""
    return [content for target, content in msg_blocks(text)
            if target.split(":", 1)[0] in PLATFORMS and ":" in target]


def _with_reply_quote(msg: InboundMessage, trusted: bool, report_ref: tuple[str, str] | None = None) -> str:
    """``msg.text`` under a quote of the message it natively replies to, when known.
    A reply to a report card (``report_ref``: title, path) names that report, quote or not.

    An untrusted author's text is left out: the allowlist screens who may reach a pane,
    and quoting would let anyone in the group speak through an allowed sender's reply.
    """
    report_header = ""
    if report_ref is not None:
        title, path = (" ".join(_strip_controls(part, keep="").split()) for part in report_ref)
        report_header = f'[Replying to report "{title}" — {path}]'
    quoted = msg.reply_to_text.strip()
    if not quoted:
        return f"{report_header}\n{msg.text}" if report_header else msg.text
    if not trusted:
        return f"{REPLY_QUOTE_OMITTED}\n{msg.text}"
    if len(quoted) > REPLY_QUOTE_MAX_CHARS:
        quoted = quoted[:REPLY_QUOTE_MAX_CHARS] + "…"
    # Every line (splitlines also breaks on \r, \u2028 ...) starts with "> ", so a quoted
    # MSG marker or "[Navide MSG]" prefix can never sit at the start of a line.
    lines = "\n".join(f"> {_strip_controls(line)}" for line in quoted.splitlines())
    name = " ".join(_strip_controls(msg.reply_to_sender, keep="").split())[:REPLY_QUOTE_NAME_MAX_CHARS]
    header = report_header or (f"[Replying to {name}]" if name else "[Replying to a message]")
    return f"{header}\n{lines}\n{msg.text}"


def _strip_controls(text: str, keep: str = "\t") -> str:
    """``text`` without C0/C1 control characters (ESC, ^C ...) other than ``keep``; a
    line break or tab in ``keep=""`` mode becomes a space."""
    return "".join(
        ch if ch in keep or unicodedata.category(ch) != "Cc" else (" " if ch in "\t\n\r" else "")
        for ch in text)


def _preview(msg: InboundMessage) -> str:
    return wake.preview(msg.text) or "📎"


def _previews(kept: list[tuple[float, InboundMessage]]) -> str:
    return wake.quoted([_preview(m) for _, m in kept])


def _typed_hint(buttons: list[tuple[str, str]]) -> str:
    """The commands ``buttons`` stand for, for a platform that cannot show them; "" when
    none of them has a typed form."""
    commands = [f"{_CALLBACK_COMMANDS[data]} {label.split(' ', 1)[-1]}"
                for label, data in buttons if data in _CALLBACK_COMMANDS]
    return "\n" + MSG_TYPED_HINT.format(commands=" · ".join(commands)) if commands else ""


def _command_word(text: str) -> str:
    word = (text or "").strip().lower()
    if word.startswith("/") and "@" in word:
        word = word.split("@", 1)[0]
    return word


def _is_stop_word(text: str) -> bool:
    word = (text or "").strip().lower()
    if word.startswith("/") and "@" in word:
        word = word.split("@", 1)[0]  # Telegram group command form: /stop@navide_bot
    return word in STOP_WORDS


def _mask_secret(secret: dict[str, Any]) -> str:
    for value in secret.values():
        if isinstance(value, str) and value:
            return f"{value[:4]}…{value[-4:]}" if len(value) > 12 else "••••"
    return ""
