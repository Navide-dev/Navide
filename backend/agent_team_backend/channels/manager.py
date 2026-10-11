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

from . import media, pdf, quick_menu, redact, relay, report, share_cmds
from .. import prompt_skills
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
DEDUP_MAX = 5000
MAX_QUEUED_PER_PANE = 20
STATUS_EDIT_MIN_INTERVAL_S = 1.0
STATUS_EDIT_MAX_FAILURES = 3
STATUS_EDIT_EVERY_S = 5.0
TYPING_EVERY_S = 4.0
AWAITING_PROBE_EVERY_S = 5.0
AWAITING_RETRY_MAX = 3  # relay attempts per awaiting prompt before giving up
RUN_TICK_S = 0.5
RUN_WATCH_MAX_S = 1800.0  # stop typing/editing after this; a late turn_complete still replies
VERDICT_POLL_S = 5.0
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
MSG_UNBOUND = "🔌 這個聊天室已和 pane「{name}」中斷連接，之後的訊息不會再送進 pane。"
MSG_BOUND = "🔗 已連接 pane「{name}」，在這裡傳的訊息會送進這個 pane；傳 stop 可以中斷。"
MSG_CHAT_TAKEN = "這個聊天室已連接到另一個 pane，請先在那個 pane 解除連接"
MSG_UNBOUND_CLOSED = "🔌 pane「{name}」已關閉，這個聊天室已中斷連接。"
MSG_QUEUE_FULL = "⚠️ 這個 pane 已有太多訊息在排隊，請稍後再傳"
MSG_EMPTY_REPLY = "（pane 回合結束，沒有文字輸出）"
MSG_STILL_RUNNING = "⏳ 仍在執行，完成時會再回覆"
MSG_OFFLINE = "⚠️ pane 目前不在線上（可能在其他 workspace 或已關閉）"
MSG_RELAY_EXPIRED = "⚠️ 這個確認已失效"
# Appended to a relay prompt whose request lapsed, when the platform can edit it.
MSG_RELAY_DONE_LOCALLY = "✔ 已在電腦上處理"
MSG_RELAY_SUPERSEDED = "↪ 已被新的確認取代"
MSG_RELAY_TURN_ENDED = "✔ 回合已結束，不需要再確認"
MSG_RELAY_PANE_GONE = "⚠️ pane 已離線，這個確認已失效"
MSG_RELAY_ANSWERED_IN_CHAT = "✅ 已在聊天室回答："  # + the answer
MSG_RELAY_PERMANENT = "⚠️ 這個選項會永久放行，請在電腦前操作"
MSG_RELAY_NEEDS_LOCAL = "⚠️ 這個動作需要在電腦前確認"
MSG_AWAITING_LOCAL = "pane 在等確認，請在電腦上回答"
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
    # (pane_id, answer) -> {ok, error?}; answer is the ui.pane.sendKeys payload
    answer: Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]
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
        self._adapters: dict[BotKey, ChannelAdapter] = {}
        self._lease: dict[str, BotKey] = {}  # token fingerprint -> bot
        self._errors: dict[BotKey, str] = {}  # bot -> config error shown in status
        self._secret_hints: dict[BotKey, str] = {}
        self._dedup: OrderedDict[tuple[str, str], None] = OrderedDict()
        self._pending: dict[str, _Pending] = {}
        self._queued: dict[str, set[str]] = {}  # pane_id -> msg_keys still queued
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
        self.mirror = Mirror(self)

    # --- lifecycle --------------------------------------------------------------

    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        # No conversion outlives a backend: whatever is there was left by a crash.
        await asyncio.to_thread(pdf.clear, self._seams.pdf_root())
        if self._status_task is None:
            self._status_task = asyncio.create_task(self._status_watch(), name="channels-status")
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
        await adapter.start(emit)
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
        self._spawn(self._send_reply(pending, str(entry.get("text") or "")))

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
        if pending.status_id:
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
        for chunk in chunks:
            try:
                ids = await self.mirror.send(pending.loc, chunk)
            except Exception as exc:  # noqa: BLE001
                log.warning("channels: reply to %s failed: %s", pending.loc.key(), share_cmds.mask_links(str(exc)))
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

    async def _reply(self, msg: InboundMessage, text: str) -> str:
        adapter = self._adapters.get((msg.platform, msg.account))
        if adapter is None:
            return ""
        loc = Location(msg.platform, msg.account, msg.chat_id, msg.thread_id)
        try:
            ids = await self.mirror.send(loc, text)
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
        if msg.callback_data and not msg.text:
            return  # a button press with the relay off, or not ours
        if quick_menu.is_menu_command(msg.text, self._identity(msg)):
            await self._quick_menu(msg)
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
        pane_id = self._seams.resolve_pane(binding.pane_id)
        if not pane_id:
            await self._reply(msg, MSG_OFFLINE)  # binding kept: it may come back
            return
        if pane_id != binding.pane_id:
            self.store.rename_pane(binding.pane_id, pane_id)
        if _is_stop_word(msg.text):
            await self._interrupt(msg, pane_id)
            return
        if await self.mirror.handle_inbound(msg, binding, pane_id):
            return
        await self._debounced_deliver(msg, binding, pane_id)

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
            how = relay.answer_hint(live[0])
        else:
            try:
                info = await self._seams.awaiting_info(pane_id)
            except Exception:  # noqa: BLE001
                return False
            if info.get("kind") != "permission":
                return False  # a question is answered by typing
            how = MSG_AWAITING_LOCAL
        await self._reply(msg, MSG_HELD_BY_PROMPT.format(how=how))
        return True

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
        if not relay.same_prompt(str(info.get("prompt") or ""), request.prompt):
            # The screen moved on: this id is stale, and the next probe relays what is there now.
            self.relay.take(request.id)
            self._spawn(self._settle_prompt(request, MSG_RELAY_SUPERSEDED))
            self._awaiting_unmark(request.pane_id)
            await self._reply(msg, MSG_RELAY_EXPIRED)
            return
        try:
            result = await self._seams.answer(request.pane_id, payload)
        except Exception as exc:  # noqa: BLE001
            result = {"ok": False, "error": str(exc)}
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

    async def _interrupt(self, msg: InboundMessage, pane_id: str, ok_text: str = MSG_INTERRUPTED) -> None:
        try:
            result = await self._seams.interrupt(pane_id)
        except Exception as exc:  # noqa: BLE001
            result = {"ok": False, "error": str(exc)}
        if result.get("ok") and result.get("sent", True):
            await self._reply(msg, ok_text)
        else:
            await self._reply(msg, f"⚠️ 中斷失敗：{result.get('error') or 'not sent'}")

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
                await note(media.text(lang, "refused", name=name, reason=media.text(lang, f"reason.{reason}")))
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
        state = self._seams.pane_state(pane_id)
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
            pending.status_id = await self._reply(msg, MSG_RECEIVED_BUSY)
        queued.add(msg_key)
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

    async def _quick_menu(self, msg: InboundMessage) -> None:
        """``/menu``: buttons for the bound pane's prompt skills and skills."""
        settings = await self._ui_settings()
        lang = prompt_skills.language(settings)
        binding = self._binding_for(msg)
        if binding is None:
            # Like any unbound message, a bot sharing a group with others stays quiet.
            if msg.is_direct or self._sole_bot(msg.platform):
                await self._reply(msg, quick_menu.text(lang, "not_bound"))
            return
        pane_id = self._seams.resolve_pane(binding.pane_id)
        if not pane_id:
            await self._reply(msg, MSG_OFFLINE)
            return
        adapter = self._adapters.get((msg.platform, msg.account))
        if adapter is None:
            return
        if not adapter.capabilities.buttons or not hasattr(adapter, "send_menu"):
            await self._reply(msg, quick_menu.text(lang, "no_buttons"))
            return
        agent_key = self._seams.pane_agent(pane_id)
        menu = self.quick.create(
            platform=msg.platform, location_key=msg.location_key(), pane_id=pane_id,
            pane_title=binding.title or pane_id, agent_key=agent_key, lang=lang,
            prompts=prompt_skills.castable(prompt_skills.effective(settings)),
            skills=await self._agent_skills(agent_key),
        )
        if menu is None:
            await self._reply(msg, quick_menu.text(lang, "empty"))
            return
        body, rows = self.quick.render(menu, 0)
        try:
            menu.message_id = await adapter.send_menu(binding.location(), redact.redact_text(body), rows)
        except Exception as exc:  # noqa: BLE001
            log.warning("channels: sending the quick menu on %s failed: %s", msg.platform, exc)
            await self._reply(msg, quick_menu.text(lang, "send_failed", error=redact.redact_text(str(exc))))

    async def _quick_press(self, msg: InboundMessage) -> None:
        settings = await self._ui_settings()
        parsed = quick_menu.parse_callback(msg.callback_data)
        press = self.quick.press(*parsed, msg.location_key()) if parsed else None
        lang = press.menu.lang if press is not None else prompt_skills.language(settings)
        binding = self._binding_for(msg)
        pane_id = self._seams.resolve_pane(binding.pane_id) if binding is not None else ""
        # A menu made for a pane the chat no longer drives is as dead as an expired one.
        if press is None or not pane_id or pane_id != self._seams.resolve_pane(press.menu.pane_id):
            await self._reply(msg, quick_menu.text(lang, "expired"))
            return
        if press.kind == "g":
            await self._quick_page(msg, press.menu, int(press.key))
            return
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
        if "/s/" not in text or self._kind_at(loc) == "direct":
            return text
        return share_cmds.mask_links(text)

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
                if status == "delivered":
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
        finally:
            q = self._queued.get(pane_id)
            if q is not None:
                q.discard(msg_key)
                if not q:
                    self._queued.pop(pane_id, None)

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
                try:
                    ids = await self.mirror.send(pending.loc, MSG_WORKING)
                    pending.status_id = ids[0] if ids else ""
                except Exception:  # noqa: BLE001
                    pending.status_id = ""
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
            await asyncio.sleep(RUN_TICK_S)

    async def _edit_status(self, adapter: ChannelAdapter, pending: _Pending, text: str, *, force: bool = False) -> None:
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
        text = f"{request.message_text}\n\n{note}" if request.message_text else note
        try:
            await adapter.edit_text(request.loc, request.message_id, redact.redact_text(self._for_chat(request.loc, text)))
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
