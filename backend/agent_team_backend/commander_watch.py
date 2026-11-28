"""Stall notices for commanders (0.2.51, spec E).

Every :data:`SCAN_INTERVAL_S` the watch reads each active commander's
dispatch tree (off the event loop: the tree reads the database and the pane
registry). A dispatched pane that is ``stalled``, or ``idle`` without a report
for longer than the commander's ``stall_minutes``, is noticed **once**:

- a cli_send message to the commander's live body (skipped when it has none);
- a line to every chat bound to the commander (skipped when none is bound);
- a ``commander.stall`` event to the main windows.

Once the pane is working, waiting, has reported or is gone, the notice is
cleared, so a later stall is noticed again. The watch only reads and tells:
it never wakes, interrupts or changes a pane (a commander manages, it does not
restrict).
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from . import commander_service
from .commander_service import IDLE, STALLED

log = logging.getLogger(__name__)

SCAN_INTERVAL_S = 60.0


@dataclass(frozen=True)
class Stall:
    commander_id: str
    commander_name: str
    #: The commander's live body pane id, or "" when it has none.
    body_pane_id: str
    pane_id: str
    pane_name: str
    task: str
    state: str
    minutes: int


def notice_text(stall: Stall) -> str:
    who = stall.pane_name or stall.pane_id
    if stall.state == STALLED:
        what = f"已超過 {stall.minutes} 分鐘沒有動靜（疑似停住）"
    else:
        what = f"回合已結束超過 {stall.minutes} 分鐘，還沒回報"
    task = f"\n任務：{stall.task}" if stall.task else ""
    return f"◎ {stall.commander_name}：子分格「{who}」{what}。{task}\n（只通知，不會自動叫醒或中斷它。）"


# ── production seams ────────────────────────────────────────────────────────


async def _send_to_body(pane_id: str, text: str) -> None:
    from .mcp_server import server as mcp

    answer = await mcp._send(mcp._Caller(kind="host"), "", text, pane_id=pane_id)
    if not answer.get("ok", True):
        log.info("commander watch: notice to %s not sent: %s", pane_id, answer.get("error") or answer)


async def _push_chats(commander_id: str, text: str) -> None:
    from . import channels

    manager = channels.get_manager()
    if manager is None:
        return
    for binding in manager.store.commander_bindings(commander_id):
        if binding.paused:
            continue
        try:
            await manager.mirror.send(binding.location(), text)
        except Exception as err:  # noqa: BLE001 - one chat must not stop the rest
            log.info("commander watch: chat notice for %s failed: %s", commander_id, err)


async def _broadcast(commander_id: str, pane_id: str, state: str) -> None:
    from . import commander_ws

    await commander_ws.broadcast_stall(commander_id, pane_id, state)


def _live_pane(pane_id: str) -> Any:
    from . import agent_messaging

    return agent_messaging.current(pane_id)


class CommanderWatch:
    def __init__(
        self,
        *,
        service: Callable[[], commander_service.CommanderService] = commander_service.current,
        send_to_body: Callable[[str, str], Awaitable[None]] = _send_to_body,
        push_chats: Callable[[str, str], Awaitable[None]] = _push_chats,
        broadcast: Callable[[str, str, str], Awaitable[None]] = _broadcast,
        live_pane: Callable[[str], Any] = _live_pane,
        monotonic: Callable[[], float] = time.monotonic,
        interval_s: float = SCAN_INTERVAL_S,
    ) -> None:
        self._service = service
        self._send_to_body = send_to_body
        self._push_chats = push_chats
        self._broadcast = broadcast
        self._live_pane = live_pane
        self._monotonic = monotonic
        self._interval_s = interval_s
        #: (commander_id, pane_id) -> state already noticed in this episode.
        self._noticed: dict[tuple[str, str], str] = {}
        #: (commander_id, pane_id) -> monotonic time it was first seen idle.
        self._idle_since: dict[tuple[str, str], float] = {}
        self._task: asyncio.Task[None] | None = None

    # ── scanning (worker thread) ──

    def scan(self) -> list[Stall]:
        """New stalls since the last scan; updates the once-per-episode state."""
        svc = self._service()
        now = self._monotonic()
        seen: set[tuple[str, str]] = set()
        out: list[Stall] = []
        for commander in svc.store.list():
            try:
                tree = svc.tree(commander.id)
                body = svc.body(commander.id)
            except Exception as err:  # noqa: BLE001 - one commander must not stop the scan
                log.warning("commander watch: %s unreadable: %s", commander.id, err)
                continue
            body_pane_id = body.pane_id if body is not None and self._live_pane(body.pane_id) is not None else ""
            for node in _descendants(tree["root"]):
                key = (commander.id, node["pane_id"])
                seen.add(key)
                state = node["state"]
                if state == IDLE:
                    since = self._idle_since.setdefault(key, now)
                    due = now - since >= commander.stall_minutes * 60
                else:
                    self._idle_since.pop(key, None)
                    due = state == STALLED
                if not due:
                    if state not in (IDLE, STALLED):
                        self._noticed.pop(key, None)
                    continue
                if key in self._noticed:
                    continue
                self._noticed[key] = state
                out.append(Stall(commander.id, commander.name, body_pane_id, node["pane_id"],
                                 node.get("name") or "", node.get("task") or "", state, commander.stall_minutes))
        for stale in set(self._noticed) - seen:
            self._noticed.pop(stale, None)
        for stale in set(self._idle_since) - seen:
            self._idle_since.pop(stale, None)
        return out

    # ── telling (event loop) ──

    async def tell(self, stall: Stall) -> None:
        text = notice_text(stall)
        steps: list[tuple[str, Awaitable[None]]] = []
        if stall.body_pane_id:
            steps.append(("body", self._send_to_body(stall.body_pane_id, text)))
        steps.append(("chat", self._push_chats(stall.commander_id, text)))
        steps.append(("broadcast", self._broadcast(stall.commander_id, stall.pane_id, stall.state)))
        for what, step in steps:
            try:
                await step
            except Exception as err:  # noqa: BLE001 - a failed notice must not stop the others
                log.warning("commander watch: %s notice failed: %s", what, err)

    async def run_once(self) -> None:
        for stall in await asyncio.to_thread(self.scan):
            await self.tell(stall)

    async def _run(self) -> None:
        while True:
            await asyncio.sleep(self._interval_s)
            try:
                await self.run_once()
            except Exception as err:  # noqa: BLE001 - keep watching
                log.warning("commander watch scan failed: %s", err)

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="commander-watch")

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is None:
            return
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


def _descendants(root: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    stack = list(root.get("children") or [])
    while stack:
        node = stack.pop()
        out.append(node)
        stack.extend(node.get("children") or [])
    return out


_WATCH: CommanderWatch | None = None


async def startup() -> None:
    global _WATCH
    if _WATCH is None:
        _WATCH = CommanderWatch()
    _WATCH.start()


async def shutdown() -> None:
    global _WATCH
    watch, _WATCH = _WATCH, None
    if watch is not None:
        await watch.stop()
