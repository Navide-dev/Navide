"""Two-way pane mirroring: what a bound chat sees of its pane and the pane's children.

A bound chat is a remote console for one pane. This module owns everything that
is specific to mirroring so ``manager.py`` only carries small hooks:

* pure helpers: verbosity levels, source labels, result/tree formatting, command
  and ``@child`` parsing, the echo guard that keeps a chat's own messages from
  coming back as "local prompts";
* ``Outbox``: one paced, merging sender per location (platform rate limits);
* ``Mirror``: routing (which chat, which prefix), lineage sync (child topics),
  local-prompt / delegation / awaiting mirroring, ``/status`` and ``/stop <name>``.

Lineage comes from the ``agent_messaging`` registry (``spawned_by`` is mirrored
there by every window), so it is event-driven: registry listeners schedule a
sync, nothing polls.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import time
from collections import OrderedDict, deque
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Awaitable, Callable

from . import redact
from .base import Location
from .registry import PLATFORMS
from .store import DEFAULT_VERBOSITY, VERBOSITIES, Binding
from .text import chunk_for

if TYPE_CHECKING:
    from .manager import ChannelManager

log = logging.getLogger(__name__)

SRC_LOCAL = "🖥 本機"
ENVELOPE_PREFIX = "[Navide MSG]"
LOCAL_PROMPT_MAX = 16000  # log_readers.base.FULL_PROMPT_MAX_CHARS: longer prompts arrive cut here
CHILD_SUMMARY_CHARS = 300
OWNER_MAP_MAX = 500
ECHO_TTL_S = 300.0
ECHO_MARKER_CHARS = 40
ROW_SEEN_MAX = 2000
DELEGATION_DEDUP_S = 60.0
TOPIC_GRACE_S = 5.0  # a re-keyed (rebuilt/detached) pane re-registers within this
NO_TOPIC_RETRY_S = 30 * 60.0  # a chat that is not a forum may turn topics on later
DEFAULT_RATE_PER_MIN = 60
DEFAULT_BURST = 5

MSG_CHILD_OPENED = "🤖 {parent} 開了子視窗「{child}」"
MSG_NO_TOPICS = ("💡 這個群組沒有開啟「主題」功能，子視窗的訊息會以「↳ 色塊 名稱」標在這裡。"
                 "到群組設定開啟「主題」（Topics）後，之後開的子視窗會各有一個話題。")
MSG_CHILD_TOPIC = "🔗 這個話題連接子視窗「{child}」（{parent} 開的），在這裡傳的訊息會送進該 pane；傳 stop 可以中斷。"
MSG_CHILD_CLOSED = "🔌 ↳ {child} 已關閉，話題已釋放"
MSG_CHILD_GONE = "🔌 子視窗「{child}」已關閉。"
MSG_ROUTED = "✔ 已轉給 {child}"
MSG_NO_CHILD = "⚠️ 找不到子視窗「{name}」"
MSG_STOPPED = "⏹ 已送出中斷（{name}）"
MSG_SUMMARY_TAIL = "\n完整內容請在 Navide 查看"
MSG_LOCAL_NOTICE = "🖥 本機下了新指令"
MSG_PROMPT_CUT = "…\n（完整內容請在 Navide 查看）"
MSG_IMAGES = "🖼 圖片 ×{n}"
# A pasted image's marker in the prompt text ("[Image #5]"), Claude Code's and Codex's alike.
_IMAGE_MARKER = re.compile(r"\[Image #\d+\][ \t]*")

_LEVEL = {"replies": 0, "minimal": 1, "standard": 2, "full": 3}
_STATUS_WORDS = {
    "running": "🔄 執行中", "starting": "🔄 執行中", "awaiting": "⚠️ 等確認",
    "idle": "💤 閒置", "exited": "⏹ 已結束", "stopped": "⏹ 已結束", "error": "❗ 錯誤",
}
_PLATFORM_PREFIXES = tuple(f"{p}:" for p in PLATFORMS)


# --- pure helpers --------------------------------------------------------------


def normalize_verbosity(value: Any) -> str | None:
    text = str(value or "").strip().lower()
    return text if text in VERBOSITIES else None


def shows(verbosity: str, needed: str) -> bool:
    """Whether a binding at ``verbosity`` receives content that needs ``needed``."""
    return _LEVEL.get(verbosity, _LEVEL[DEFAULT_VERBOSITY]) >= _LEVEL[needed]


def source_chat(sender: str) -> str:
    return f"💬 {sender or '聊天室'}"


def source_pane(name: str) -> str:
    return f"🤖 {name}"


# One colour a child keeps, so panes riding a chat without topics can be told apart.
CHILD_COLOURS = ("🟦", "🟩", "🟧", "🟪", "🟥", "🟨", "🟫", "⬛")


def _image_label(text: str) -> str:
    """Pasted-image markers folded into one label after the typed text."""
    n = len(_IMAGE_MARKER.findall(text))
    if not n:
        return text
    rest = _IMAGE_MARKER.sub("", text).strip()
    label = MSG_IMAGES.format(n=n)
    return f"{rest} {label}" if rest else label


def child_tag(name: str) -> str:
    """``↳ <colour> <name>``: the prefix of a child's message in its ancestor's chat."""
    colour = CHILD_COLOURS[hashlib.sha256(name.encode()).digest()[0] % len(CHILD_COLOURS)]
    return f"↳ {colour} {name}"


def result_text(source: str, text: str, child: str = "") -> str:
    head = f"{child_tag(child) + ' ' if child else ''}✅ 完成 · {source}"
    return f"{head}\n{text}" if text else head


def summarize(text: str) -> str:
    text = text.strip()
    if len(text) <= CHILD_SUMMARY_CHARS:
        return text + MSG_SUMMARY_TAIL if text else text
    return text[:CHILD_SUMMARY_CHARS].rstrip() + "…" + MSG_SUMMARY_TAIL


def status_word(display_status: str) -> str:
    return _STATUS_WORDS.get(display_status or "", "💤 閒置")


def format_tree(root: dict[str, Any], nested: list[tuple[int, dict[str, Any]]]) -> str:
    """``📋 root  status`` then one ├─/└─ line per descendant (depth-indented)."""
    lines = [f"📋 {root['name']}　{status_word(root.get('display_status', ''))}"]
    for i, (depth, pane) in enumerate(nested):
        last = i == len(nested) - 1
        indent = "　" * (depth - 1)
        lines.append(f"{indent}{'└─' if last else '├─'} ↳ {pane['name']}　{status_word(pane.get('display_status', ''))}")
    return "\n".join(lines)


def _command(text: str) -> tuple[str, str]:
    """``("/stop", "tester")`` for ``/stop@bot tester``; ("", text) for plain text."""
    body = (text or "").strip()
    if not body.startswith("/"):
        return "", body
    head, _, rest = body.partition(" ")
    if "@" in head:
        head = head.split("@", 1)[0]
    return head.lower(), rest.strip()


def parse_command(text: str) -> tuple[str, str]:
    """(command, argument) for the chat commands mirroring adds: /status and /stop <name>."""
    cmd, arg = _command(text)
    if cmd == "/status" and not arg:
        return "status", ""
    if cmd == "/stop" and arg:
        return "stop", arg
    return "", ""


def match_name(name: str, candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The one candidate called ``name`` (case-insensitive exact, else unique prefix)."""
    want = name.strip().lstrip("↳").strip().lower()
    if not want:
        return None
    exact = [c for c in candidates if str(c["name"]).lower() == want]
    if len(exact) == 1:
        return exact[0]
    if exact:
        return None
    prefix = [c for c in candidates if str(c["name"]).lower().startswith(want)]
    return prefix[0] if len(prefix) == 1 else None


def parse_at_target(text: str, candidates: list[dict[str, Any]]) -> tuple[dict[str, Any], str] | None:
    """``@tester run it`` -> (tester pane, "run it"); the longest matching name wins
    so a name with spaces works. None when the text does not start with a child's name."""
    body = (text or "").strip()
    if not body.startswith("@"):
        return None
    body = body[1:]
    best: tuple[dict[str, Any], str] | None = None
    for cand in candidates:
        name = str(cand["name"])
        if body.lower().startswith(name.lower()):
            rest = body[len(name):]
            if rest and not rest[0].isspace():
                continue
            if best is None or len(name) > len(str(best[0]["name"])):
                best = (cand, rest.strip())
    return best if best and best[1] else None


class EchoGuard:
    """Remembers what a chat (or another pane) injected so the prompt the CLI's log
    later reports for it is not mistaken for something typed at the keyboard."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._seen: dict[str, list[tuple[str, float]]] = {}

    @staticmethod
    def _marker(text: str) -> str:
        return " ".join((text or "").split())[:ECHO_MARKER_CHARS]

    def remember(self, pane_id: str, text: str) -> None:
        marker = self._marker(text)
        if marker:
            self._seen.setdefault(pane_id, []).append((marker, self._clock() + ECHO_TTL_S))

    def consume(self, pane_id: str, snippet: str) -> bool:
        now = self._clock()
        items = [(m, exp) for m, exp in self._seen.get(pane_id, []) if exp > now]
        flat = " ".join((snippet or "").split())
        for i, (marker, _) in enumerate(items):
            if marker in flat:
                del items[i]
                self._seen[pane_id] = items
                return True
        self._seen[pane_id] = items
        return False


class OwnerMap:
    """message id -> the pane that produced it, bounded, per location."""

    def __init__(self) -> None:
        self._by_loc: dict[str, OrderedDict[str, str]] = {}

    def remember(self, loc_key: str, message_ids: list[str], pane_id: str) -> None:
        table = self._by_loc.setdefault(loc_key, OrderedDict())
        for mid in message_ids:
            if mid:
                table[str(mid)] = pane_id
                table.move_to_end(str(mid))
        while len(table) > OWNER_MAP_MAX:
            table.popitem(last=False)

    def owner(self, loc_key: str, message_id: str) -> str:
        return self._by_loc.get(loc_key, {}).get(str(message_id), "")

    def rename(self, old: str, new: str) -> None:
        for table in self._by_loc.values():
            for mid, pane in table.items():
                if pane == old:
                    table[mid] = new


class ReportMap:
    """message id -> the report a card announced (its title, the path the pane named),
    bounded, per chat. Keyed by chat, not topic: a Slack reply in a card's thread
    arrives with that thread as its location."""

    def __init__(self) -> None:
        self._by_chat: dict[str, OrderedDict[str, tuple[str, str]]] = {}

    @staticmethod
    def _chat(platform: str, account: str, chat_id: str) -> str:
        return f"{platform}:{account}:{chat_id}"

    def remember(self, loc: Any, message_ids: list[str], title: str, path: str) -> None:
        table = self._by_chat.setdefault(self._chat(loc.platform, loc.account, loc.chat_id), OrderedDict())
        for mid in message_ids:
            if mid:
                table[str(mid)] = (title, path)
                table.move_to_end(str(mid))
        while len(table) > OWNER_MAP_MAX:
            table.popitem(last=False)

    def get(self, msg: Any) -> tuple[str, str] | None:
        """The report ``msg`` replies to, if it replies to a card."""
        if not msg.reply_to_id:
            return None
        return self._by_chat.get(self._chat(msg.platform, msg.account, msg.chat_id), {}).get(str(msg.reply_to_id))


# --- outbound pacing -----------------------------------------------------------


@dataclass
class _Item:
    text: str
    owner: str
    buttons: list[tuple[str, str]] | None = None
    # A message id this one replies to (quotes), on adapters that can.
    reply_to: str = ""
    # Set when a caller awaits the send (it needs the message ids, or the error):
    # such an item is sent on its own, never merged with its neighbours.
    future: "asyncio.Future[list[str]] | None" = None


class Outbox:
    """Paced sender for one location.

    A token bucket (``per_min`` refill, ``burst`` capacity) keeps a chat inside its
    platform's limit; when messages pile up behind it, consecutive ones of the same
    owner are merged into one message (up to ``limit`` characters) instead of being
    dropped. A 429 is the adapter's own business (it honours ``retry_after``).
    Every chat has its own outbox, so a slow one never blocks another.
    """

    def __init__(
        self,
        send: Callable[[str, list[tuple[str, str]] | None], Awaitable[list[str]]],
        *,
        per_min: float = DEFAULT_RATE_PER_MIN,
        burst: int = DEFAULT_BURST,
        limit: int = 4000,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        on_sent: Callable[[list[str], str], None] | None = None,
    ) -> None:
        self._send = send
        self._rate = max(per_min, 1.0) / 60.0
        self._burst = max(burst, 1)
        self._limit = limit
        self._clock = clock
        self._sleep = sleep
        self._on_sent = on_sent
        self._tokens = float(self._burst)
        self._stamp = clock()
        self._items: deque[_Item] = deque()
        self._task: asyncio.Task[None] | None = None
        self.merged = 0

    def post(self, text: str, owner: str = "", *, chunks: list[str] | None = None) -> None:
        for chunk in chunks if chunks is not None else [text]:
            self._items.append(_Item(chunk, owner))
        self._kick()

    async def submit(self, text: str, owner: str = "", buttons: list[tuple[str, str]] | None = None,
                     reply_to: str = "") -> list[str]:
        """Queue behind everything already waiting for this chat and wait for the send:
        the message ids on success, the adapter's exception on failure."""
        future: asyncio.Future[list[str]] = asyncio.get_running_loop().create_future()
        self._items.append(_Item(text, owner, buttons, reply_to, future))
        self._kick()
        return await future

    def _kick(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.ensure_future(self._drain())

    async def _acquire(self) -> None:
        while True:
            now = self._clock()
            self._tokens = min(self._burst, self._tokens + (now - self._stamp) * self._rate)
            self._stamp = now
            if self._tokens >= 1.0:
                self._tokens -= 1.0
                return
            await self._sleep((1.0 - self._tokens) / self._rate)

    async def _drain(self) -> None:
        while self._items:
            await self._acquire()
            if not self._items:
                return
            first = self._items.popleft()
            text = first.text
            while first.future is None and self._items and self._items[0].future is None \
                    and self._items[0].owner == first.owner \
                    and len(text) + 2 + len(self._items[0].text) <= self._limit:
                text += "\n\n" + self._items.popleft().text
                self.merged += 1
            try:
                if first.reply_to:
                    ids = await self._send(text, first.buttons, reply_to=first.reply_to)
                else:
                    ids = await self._send(text, first.buttons)
            except asyncio.CancelledError:
                if first.future is not None and not first.future.done():
                    first.future.cancel()
                raise
            except Exception as exc:  # noqa: BLE001 — one failed send must not wedge the chat
                if first.future is not None:
                    if not first.future.done():
                        first.future.set_exception(exc)
                else:
                    log.warning("channels: mirrored message not sent: %s", exc)
                continue
            if first.future is not None and not first.future.done():
                first.future.set_result(ids)
            if self._on_sent is not None:
                self._on_sent(ids, first.owner)

    def cancel(self) -> None:
        for item in self._items:
            if item.future is not None and not item.future.done():
                item.future.cancel()
        self._items.clear()
        if self._task is not None:
            self._task.cancel()


# --- the mirror ------------------------------------------------------------------


@dataclass(frozen=True)
class Route:
    """Where a pane's mirrored activity goes."""

    binding: Binding  # the binding whose chat receives it
    child: str  # name for the "↳" prefix when the pane rides its ancestor's chat, else ""
    own: bool  # the pane has a binding of its own


class Mirror:
    def __init__(self, manager: "ChannelManager") -> None:
        self.m = manager
        self.echo = EchoGuard(manager._clock)
        self.owners = OwnerMap()
        self.reports = ReportMap()
        self._outboxes: dict[str, Outbox] = {}
        self._seen_children: set[str] = set()
        self._topic_failed: set[str] = set()
        # Chats that said they cannot have topics (a Telegram group that is not a
        # forum), mapped to when they may be asked again.
        self._no_topic_chats: dict[str, float] = {}
        self._told_no_topics: set[str] = set()
        self._rows_seen: OrderedDict[str, None] = OrderedDict()
        self._delegations: OrderedDict[str, float] = OrderedDict()
        self._sync_task: asyncio.Task[None] | None = None
        self._sync_again = False
        self._release_timers: dict[str, asyncio.TimerHandle] = {}

    # --- directory / routing -----------------------------------------------------

    def _directory(self) -> dict[str, dict[str, Any]]:
        try:
            return {str(p["pane_id"]): p for p in self.m._seams.pane_directory()}
        except Exception:  # noqa: BLE001
            return {}

    def route(self, pane_id: str, directory: dict[str, dict[str, Any]] | None = None) -> Route | None:
        bindings = {b.pane_id: b for b in self.m.store.bindings()}
        own = bindings.get(pane_id)
        if own is not None:
            return Route(own, "", True)
        directory = directory if directory is not None else self._directory()
        me = directory.get(pane_id)
        cur, seen = pane_id, set()
        while cur and cur not in seen:
            seen.add(cur)
            parent = str((directory.get(cur) or {}).get("spawned_by") or "")
            if parent in bindings:
                return Route(bindings[parent], str(me["name"]) if me else pane_id, False)
            cur = parent
        return None

    def descendants(self, pane_id: str, directory: dict[str, dict[str, Any]] | None = None
                    ) -> list[tuple[int, dict[str, Any]]]:
        directory = directory if directory is not None else self._directory()
        kids: dict[str, list[dict[str, Any]]] = {}
        for p in directory.values():
            kids.setdefault(str(p.get("spawned_by") or ""), []).append(p)
        out: list[tuple[int, dict[str, Any]]] = []
        seen = {pane_id}

        def walk(parent: str, depth: int) -> None:
            for child in sorted(kids.get(parent, []), key=lambda p: str(p["name"])):
                cid = str(child["pane_id"])
                if cid in seen:
                    continue
                seen.add(cid)
                out.append((depth, child))
                walk(cid, depth + 1)

        walk(pane_id, 1)
        return out

    # --- outbound ----------------------------------------------------------------

    def _outbox(self, loc: Location) -> Outbox | None:
        adapter = self.m._adapters.get((loc.platform, loc.account))
        if adapter is None:
            return None
        box = self._outboxes.get(loc.key())
        if box is None:
            key = loc.key()

            async def send(text: str, buttons: list[tuple[str, str]] | None, reply_to: str = "") -> list[str]:
                live = self.m._adapters.get((loc.platform, loc.account))
                if live is None:
                    raise RuntimeError(f"{loc.platform} is not connected")
                if reply_to and getattr(live.capabilities, "reply_to", False):
                    return await live.send_text(loc, text, buttons=buttons or None, reply_to=reply_to)
                return await live.send_text(loc, text, buttons=buttons or None)

            # Real time, not the manager's (test-injectable) clock: pacing is about the wire.
            box = Outbox(
                send, per_min=float(getattr(adapter, "rate_per_min", DEFAULT_RATE_PER_MIN)),
                limit=adapter.capabilities.text_limit,
                on_sent=lambda ids, owner, key=key: self.owners.remember(key, ids, owner) if owner else None,
            )
            self._outboxes[key] = box
        return box

    def post(self, loc: Location, text: str, owner: str = "") -> None:
        """Queue ``text`` for ``loc`` (redacted, chunked, paced, merged under backlog)."""
        box = self._outbox(loc)
        if box is None or not text.strip():
            return
        text = self.m._for_chat(loc, text)
        box.post("", owner, chunks=chunk_for(loc.platform, redact.redact_text(text)))

    async def send(self, loc: Location, text: str, *, owner: str = "",
                   buttons: list[tuple[str, str]] | None = None, reply_to: str = "") -> list[str]:
        """Like ``post`` but awaited, for callers that need the message ids or the error.
        Goes through the same per-location queue, so it stays in order with mirrored messages.
        ``reply_to`` quotes that message where the platform can; elsewhere it is ignored."""
        box = self._outbox(loc)
        if box is None:
            raise RuntimeError(f"{loc.platform} is not connected")
        return await box.submit(redact.redact_text(self.m._for_chat(loc, text)), owner, buttons, reply_to)

    def label(self, route: Route, text: str) -> str:
        return f"{child_tag(route.child)} {text}" if route.child else text

    # --- prompts and delegation -----------------------------------------------------

    def on_local_prompt(self, pane_id: str, snippet: str) -> None:
        """A prompt the CLI's log reports for ``pane_id`` (sync, from the activity sink)."""
        if snippet.lstrip().startswith(ENVELOPE_PREFIX) or self.echo.consume(pane_id, snippet):
            return  # a message: chat and delegations are mirrored on their own path
        route = self.route(pane_id)
        if route is None or not shows(route.binding.verbosity, "minimal"):
            return
        verbosity = route.binding.verbosity
        self.m._begin_run(pane_id, route, SRC_LOCAL)
        if shows(verbosity, "full"):
            more = MSG_PROMPT_CUT if len(snippet) >= LOCAL_PROMPT_MAX else ""
            self.post(route.binding.location(), self.label(route, f"🖥 你：{_image_label(snippet)}{more}"), pane_id)
        elif shows(verbosity, "standard"):
            self.post(route.binding.location(), self.label(route, MSG_LOCAL_NOTICE), pane_id)

    def on_message_rows(self, rows: list[dict[str, Any]]) -> None:
        """Message-log rows a window appended: pane-to-pane messages (sync, cheap)."""
        directory: dict[str, dict[str, Any]] | None = None
        for row in rows:
            uid = str(row.get("uid") or "")
            sender, recipient = str(row.get("sender") or ""), str(row.get("recipient") or "")
            content = str(row.get("content") or "")
            if not uid or uid in self._rows_seen or not content or row.get("kind") \
                    or str(row.get("status") or "") in ("failed", "cancelled") \
                    or sender.startswith(_PLATFORM_PREFIXES):
                continue
            self._rows_seen[uid] = None
            while len(self._rows_seen) > ROW_SEEN_MAX:
                self._rows_seen.popitem(last=False)
            if directory is None:
                directory = self._directory()
            src, dst = self._pane_by_name(sender, directory), self._pane_by_name(recipient, directory)
            if dst is None:
                continue
            digest = hashlib.sha1(f"{sender}\0{recipient}\0{content}".encode()).hexdigest()
            now = self.m._clock()
            if now - self._delegations.get(digest, -1e9) < DELEGATION_DEDUP_S:
                continue
            self._delegations[digest] = now
            while len(self._delegations) > ROW_SEEN_MAX:
                self._delegations.popitem(last=False)
            self._mirror_delegation(sender, recipient, content, src, dst, directory)

    @staticmethod
    def _pane_by_name(name: str, directory: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
        hits = [p for p in directory.values()
                if name in (str(p["name"]), str(p.get("qualified_name") or ""))]
        return hits[0] if len(hits) == 1 else None

    def _mirror_delegation(self, sender: str, recipient: str, content: str, src: dict[str, Any] | None,
                           dst: dict[str, Any], directory: dict[str, dict[str, Any]]) -> None:
        dst_id = str(dst["pane_id"])
        self.m._note_source(dst_id, source_pane(sender))
        sent: set[str] = set()
        for pane in ([dst_id] + ([str(src["pane_id"])] if src else [])):
            route = self.route(pane, directory)
            if route is None or not shows(route.binding.verbosity, "minimal"):
                continue
            loc = route.binding.location()
            if loc.key() in sent:
                continue
            sent.add(loc.key())
            if pane == dst_id:
                self.m._begin_run(dst_id, route, source_pane(sender))
            if shows(route.binding.verbosity, "full"):
                self.post(loc, f"🤖 {sender} → {recipient}：{content}", pane)

    # --- awaiting -------------------------------------------------------------------

    def on_status(self, pane_id: str) -> None:
        """A pane's display status changed (sync): relay a new awaiting prompt, or drop a stale one."""
        state = self.m._seams.pane_state(pane_id)
        if state.get("display_status") == "awaiting":
            route = self.route(pane_id)
            if pane_id in self.m._awaiting_posted:
                if route is not None:  # relayed already: only a different prompt goes again
                    self.m._spawn(self.m._post_awaiting(pane_id, route.binding.location(), route.child,
                                                        only_if_changed=True))
                return
            # At "replies" only a turn the chat started relays its prompt (_check_awaiting).
            if route is not None and shows(route.binding.verbosity, "minimal"):
                self.m._awaiting_posted.add(pane_id)
                self.m._spawn(self.m._post_awaiting(pane_id, route.binding.location(), route.child))
        else:
            self.m._awaiting_failures.pop(pane_id, None)
            self.m._awaiting_shown.pop(pane_id, None)
            pending = self.m._pending.get(pane_id)
            if pending is not None:
                pending.awaiting_posted = False  # else the next prompt looks already relayed
            if pane_id in self.m._awaiting_posted:
                self.m._awaiting_posted.discard(pane_id)
                from .manager import MSG_RELAY_DONE_LOCALLY  # manager imports this module

                self.m._retire_relay(pane_id, MSG_RELAY_DONE_LOCALLY)

    # --- lineage --------------------------------------------------------------------

    def on_registry(self, event: str, pane_id: str) -> None:
        """Registry listener (sync, may run on any thread's caller): schedule work on the loop."""
        loop = self.m._loop
        if loop is None or loop.is_closed():
            return
        if event == "status":
            call = self.on_status
            args: tuple[Any, ...] = (pane_id,)
        else:
            call = self.schedule_sync
            args = ()
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is loop:
            call(*args)
        else:
            loop.call_soon_threadsafe(call, *args)

    def schedule_sync(self) -> None:
        loop = self.m._loop
        if loop is None or loop.is_closed():
            return
        if self._sync_task is not None and not self._sync_task.done():
            self._sync_again = True
            return
        self._sync_task = self.m._spawn(self._sync_loop())

    async def _sync_loop(self) -> None:
        while True:
            self._sync_again = False
            try:
                await self.sync_lineage()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.exception("channels: lineage sync failed")
            if not self._sync_again:
                return

    async def sync_lineage(self) -> None:
        """Open a topic per new child of a bound pane, taint what a tainted pane spawned,
        and release topics whose pane has closed."""
        self.m._sync_bindings()
        directory = self._directory()
        bindings = self.m.store.bindings()
        for b in list(bindings):
            if b.pane_id not in directory:
                continue
            for _, child in self.descendants(b.pane_id, directory):
                cid = str(child["pane_id"])
                if cid in self._seen_children:
                    continue
                parent_id = str(child.get("spawned_by") or b.pane_id)
                try:
                    self.m._seams.inherit_taint(cid, parent_id)
                except Exception:  # noqa: BLE001
                    log.warning("channels: could not inherit taint for %s", cid)
                if not shows(b.verbosity, "minimal"):
                    continue  # children are not announced at "replies"; adopted if the level rises
                self._seen_children.add(cid)
                parent = directory.get(parent_id) or directory.get(b.pane_id) or {"name": b.title or b.pane_id}
                await self._adopt_child(b, parent, child)
        for b in self.m.store.bindings():
            if b.auto:
                self._watch_release(b, directory)

    async def _adopt_child(self, root: Binding, parent: dict[str, Any], child: dict[str, Any]) -> None:
        cid, cname = str(child["pane_id"]), str(child["name"])
        # Binds without ChannelManager.bind, so it keeps that refusal itself.
        if self.m._seams.is_login_pane(cid):
            return
        adapter = self.m._adapters.get((root.platform, root.account))
        if adapter is None:
            return
        opened = MSG_CHILD_OPENED.format(parent=parent["name"], child=cname)
        chat = f"{root.platform}:{root.account}:{root.chat_id}"
        now = self.m._clock()
        if adapter.capabilities.threads and adapter.capabilities.create_location \
                and cid not in self._topic_failed and now >= self._no_topic_chats.get(chat, now) \
                and not any(b.pane_id == cid for b in self.m.store.bindings()):
            try:
                loc = await adapter.create_location(root.chat_id, f"↳ {cname}")
                self.m.store.bind(cid, loc, verbosity=root.verbosity,
                                  parent_pane_id=str(parent.get("pane_id") or root.pane_id), auto=True)
            except Exception as exc:  # noqa: BLE001 — falls back to prefixed messages in the parent chat
                self._topic_failed.add(cid)
                if "not a forum" in str(exc).lower() and chat in self._no_topic_chats:
                    # The retry after NO_TOPIC_RETRY_S: one quiet line per chat per window.
                    self._no_topic_chats[chat] = now + NO_TOPIC_RETRY_S
                    log.info("channels: child topic for %s failed again: %s", cname, exc)
                elif "not a forum" in str(exc).lower():
                    self._no_topic_chats[chat] = now + NO_TOPIC_RETRY_S
                    if chat not in self._told_no_topics:
                        # Once a backend run: the chat learns why its children share it.
                        self._told_no_topics.add(chat)
                        self.post(root.location(), MSG_NO_TOPICS, root.pane_id)
                    log.warning("channels: child topic for %s failed: %s; children of this chat use "
                                "prefixed messages; topics are tried again in %d minutes",
                                cname, exc, NO_TOPIC_RETRY_S // 60)
                else:
                    log.warning("channels: child topic for %s failed: %s", cname, exc)
            else:
                self._no_topic_chats.pop(chat, None)
                await self.m._changed()
                if shows(root.verbosity, "standard"):
                    self.post(root.location(), opened, root.pane_id)
                self.post(loc, MSG_CHILD_TOPIC.format(child=cname, parent=parent["name"]), cid)
                return
        if shows(root.verbosity, "standard"):
            self.post(root.location(), opened, root.pane_id)

    def _watch_release(self, b: Binding, directory: dict[str, dict[str, Any]]) -> None:
        if self.m._seams.resolve_pane(b.pane_id) or b.pane_id in directory:
            timer = self._release_timers.pop(b.pane_id, None)
            if timer is not None:
                timer.cancel()
            return
        loop = self.m._loop
        if loop is None or b.pane_id in self._release_timers:
            return
        self._release_timers[b.pane_id] = loop.call_later(
            TOPIC_GRACE_S, lambda pid=b.pane_id: self.m._spawn(self._release(pid)))

    async def _release(self, pane_id: str) -> None:
        self._release_timers.pop(pane_id, None)
        self.m._sync_bindings()
        binding = next((x for x in self.m.store.bindings() if x.pane_id == pane_id), None)
        if binding is None or not binding.auto or self.m._seams.resolve_pane(pane_id):
            return
        self._seen_children.discard(pane_id)
        await self.m.unbind(pane_id, reason="closed", pane_name=binding.title.removeprefix("↳ "))
        parent = next((x for x in self.m.store.bindings() if x.pane_id == binding.parent_pane_id), None)
        if parent is not None and shows(parent.verbosity, "standard"):
            self.post(parent.location(), MSG_CHILD_CLOSED.format(child=binding.title.removeprefix("↳ ")),
                      parent.pane_id)

    async def release_children(self, pane_id: str) -> None:
        """A parent binding went away or moved: its auto topics have no parent to follow
        any more, and its descendants are adopted afresh by the pane's next chat."""
        for _, child in self.descendants(pane_id):
            self._seen_children.discard(str(child["pane_id"]))
            self._topic_failed.discard(str(child["pane_id"]))
        for b in self.m.store.bindings():
            if b.auto and b.parent_pane_id == pane_id:
                self._seen_children.discard(b.pane_id)
                await self.m.unbind(b.pane_id, pane_name=b.title.removeprefix("↳ "))

    # --- inbound: commands and routing ----------------------------------------------

    async def handle_inbound(self, msg: Any, binding: Binding, pane_id: str) -> bool:
        """/status, /stop <name>, ``@child text`` and replies to a child's message.
        True when the message was consumed here."""
        cmd, arg = parse_command(msg.text)
        directory = self._directory()
        kids = [p for _, p in self.descendants(pane_id, directory)]
        if cmd == "status":
            root = directory.get(pane_id) or {"name": binding.title or pane_id, "display_status": ""}
            await self.m._reply(msg, format_tree(root, self.descendants(pane_id, directory)))
            return True
        if cmd == "stop":
            target = match_name(arg, kids + ([directory[pane_id]] if pane_id in directory else []))
            if target is None:
                await self.m._reply(msg, MSG_NO_CHILD.format(name=arg))
                return True
            await self.m._interrupt(msg, str(target["pane_id"]), MSG_STOPPED.format(name=target["name"]))
            return True
        if not kids or msg.callback_data:
            return False
        routed = parse_at_target(msg.text, kids)
        if routed is not None:
            child, text = routed
            await self._forward(msg, binding, child, text)
            return True
        owner = self.owners.owner(msg.location_key(), msg.reply_to_id) if msg.reply_to_id else ""
        child = next((p for p in kids if str(p["pane_id"]) == owner), None)
        if child is not None:
            await self._forward(msg, binding, child, msg.text)
            return True
        return False

    async def _forward(self, msg: Any, binding: Binding, child: dict[str, Any], text: str) -> None:
        import dataclasses

        forwarded = dataclasses.replace(msg, text=text)
        if await self.m._held_by_prompt(forwarded, str(child["pane_id"])):
            return  # not routed: the chat was told how to answer the child's prompt
        await self.m._deliver(forwarded, binding, str(child["pane_id"]))
        await self.m._reply(msg, MSG_ROUTED.format(child=child["name"]))

    def rename_pane(self, old: str, new: str) -> None:
        self.owners.rename(old, new)
        if old in self._seen_children:
            self._seen_children.discard(old)
            self._seen_children.add(new)

    def stop(self) -> None:
        for box in self._outboxes.values():
            box.cancel()
        self._outboxes.clear()
        for timer in self._release_timers.values():
            timer.cancel()
        self._release_timers.clear()
