"""Which panes' CLIs never reached the navide MCP server (/plan-mcp).

On 2026-11-12 a mass restore slowed /plan-mcp past Claude Code's connect
budget; thirteen panes gave up after three retries and sat without any Navide
tool until someone typed /mcp the next day. Nothing noticed: the backend kept
no record of whether a pane's CLI had ever connected.

Every accepted pane credential on /plan-mcp records the time here. A pane
whose CLI is up — realized, and reported idle/running/awaiting by its window —
for NEVER_CONNECTED_AFTER_S without one is "never-connected": cli_get_status
and cli_list_targets say so, and the sweep reports it once so the window and
the bound chats can tell the user. Only vendors that dial the server at
startup are judged; one that connects lazily would be flagged for no fault.

A pane can also lose a connection it had. On 2026-11-15 the backend's event
loop stalled for 360 s and then 188 s; Claude Code's long-lived GET stream to
/plan-mcp broke, its five reconnect attempts (about 15 s) all failed, and it
gave up for good: 65 of 66 panes sat without Navide tools while this module,
which only knew they had connected once, reported nothing. Each pane's open
GET streams are counted here too. One whose last stream closed and that has
neither reopened one nor sent any request for DROPPED_AFTER_S is
"disconnected" — reported, and cleared, like never-connected. After a loop
stall longer than the CLI's reconnect budget the grace is shorter
(DROPPED_AFTER_STALL_S) and the sweep runs as soon as the loop is back
(note_stall), since a stream that closed during it was almost certainly given
up on.

Neither state used to fix itself: the pane cannot type /mcp into its own CLI,
cli_send wraps text in a sender line so a commander cannot either, and on
2026-11-22 a pane sat without tools until the user pressed Reconnect. While a
flagged pane is idle and its window is connected, due_reconnects() offers it
for an in-place `/mcp reconnect navide` (the window types it, the same command
the Reconnect button tries first) at most AUTO_RECONNECT_MAX_TRIES times,
AUTO_RECONNECT_RETRY_S apart. Only a try the window actually typed counts, and
the budget starts over once the pane connects again.

A try is only made once the backend has recovered (backend_recovered): not
while the main process' probe says /plan-mcp is down, and not within
RECOVERY_SETTLE_S of a long loop stall — a reconnect into a server that is
still failing spends a try and fixes nothing (2026-11-26: 85 panes at load
88). Every judgement is logged as an ``event=`` line in backend.log (it used
to reach only the window and the chat), and a pane that comes back after an
automatic try is logged and announced as auto-reconnected.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable

from . import agent_messaging
from .mcp_server import wiring as mcp_wiring

log = logging.getLogger(__name__)

NEVER_CONNECTED_AFTER_S = 180.0
SWEEP_INTERVAL_S = 30.0
STATE_NEVER_CONNECTED = "never-connected"
STATE_DISCONNECTED = "disconnected"

#: A pane's last GET stream closed this long ago, with no stream or request
#: since: its CLI stopped trying. Claude Code retries for about 15 s.
DROPPED_AFTER_S = 90.0
#: The same, for a stream that closed during or right after a long loop stall.
DROPPED_AFTER_STALL_S = 30.0
#: A stall at least this long outlasts Claude Code's reconnect attempts
#: (1+2+4+8 s backoff plus connect time).
STALL_RECHECK_S = 15.0

#: Automatic in-place reconnects per flagged episode; past them the pane is
#: left to the user's Reconnect (which may rebuild) rather than typed into
#: forever.
AUTO_RECONNECT_MAX_TRIES = 3
#: Between two automatic reconnects of one pane.
AUTO_RECONNECT_RETRY_S = 120.0
#: How long after a long loop stall ends before an automatic reconnect is tried.
RECOVERY_SETTLE_S = 10.0

#: Vendors whose CLI connects to its MCP servers while it starts.
EAGER_AGENTS = frozenset({"claude"})
_UP_STATUSES = frozenset({"idle", "running", "awaiting"})

#: Presented pane id -> wall-clock time of its last accepted /plan-mcp request.
_last_seen: dict[str, float] = {}
#: Pane id -> monotonic time its CLI was first seen up without a connection.
_up_since: dict[str, float] = {}
#: Pane ids already reported by sweep(), so each is reported once.
_reported: set[str] = set()
#: Reported pane ids that have since connected, until take_cleared() reads them.
_cleared: list[str] = []
#: Presented pane id -> GET streams it holds open right now.
_open_streams: dict[str, int] = {}
#: Presented pane id -> monotonic time its last open stream closed, until it
#: opens another or sends any request.
_closed_at: dict[str, float] = {}
#: Pane ids already reported disconnected by sweep_dropped().
_reported_dropped: set[str] = set()
#: (start, end) monotonic times of the latest loop stall past STALL_RECHECK_S.
_last_long_stall: tuple[float, float] | None = None
#: Pane id -> (automatic reconnects typed in, monotonic time of the last one),
#: for the episode it is flagged in now.
_auto_tries: dict[str, tuple[int, float]] = {}
#: Set by note_stall() to wake run() before its regular interval.
_wake: asyncio.Event | None = None


def record_connect(pane_id: str) -> None:
    """A /plan-mcp request from ``pane_id`` passed its credential check."""
    _last_seen[pane_id] = time.time()
    # Any request is a CLI that is still talking to us.
    _closed_at.pop(pane_id, None)


def stream_opened(pane_id: str) -> None:
    """``pane_id``'s CLI opened its long-lived GET stream."""
    _open_streams[pane_id] = _open_streams.get(pane_id, 0) + 1
    _closed_at.pop(pane_id, None)


def stream_closed(pane_id: str, now: float | None = None) -> None:
    """One of ``pane_id``'s GET streams ended (either side closed it)."""
    left = _open_streams.get(pane_id, 0) - 1
    if left > 0:
        _open_streams[pane_id] = left
        return
    _open_streams.pop(pane_id, None)
    _closed_at[pane_id] = time.monotonic() if now is None else now


def note_stall(duration_s: float, now: float | None = None) -> None:
    """The event loop is turning again after ``duration_s`` stalled. Called
    on the loop. A stall past STALL_RECHECK_S shortens the grace for streams
    that closed in it and wakes the sweep."""
    global _last_long_stall
    if duration_s < STALL_RECHECK_S:
        return
    end = time.monotonic() if now is None else now
    _last_long_stall = (end - duration_s, end)
    if _wake is not None:
        _wake.set()


def _grace(closed: float) -> float:
    stall = _last_long_stall
    if stall is not None and stall[0] <= closed <= stall[1] + DROPPED_AFTER_STALL_S:
        return DROPPED_AFTER_STALL_S
    return DROPPED_AFTER_S


def _dropped(pane_id: str, now: float) -> bool:
    ids = [pane_id, *agent_messaging.former_ids(pane_id)]
    if any(_open_streams.get(i) for i in ids):
        return False
    closed = [t for t in (_closed_at.get(i) for i in ids) if t is not None]
    if not closed:
        return False
    last = max(closed)
    return now - last >= _grace(last)


def last_connect(pane_id: str) -> float | None:
    """Latest /plan-mcp time of this pane under its current or a former id."""
    ids = [pane_id, *agent_messaging.former_ids(pane_id)]
    times = [_last_seen[i] for i in ids if i in _last_seen]
    return max(times) if times else None


def _judged(entry: agent_messaging.RegisteredPane) -> bool:
    if entry.agent_key not in EAGER_AGENTS or not entry.realized or entry.is_dock:
        return False
    ids = [entry.pane_id, *agent_messaging.former_ids(entry.pane_id)]
    return any(mcp_wiring.bound_pane_token(i) for i in ids)


def state(pane_id: str, now: float | None = None) -> str:
    """STATE_NEVER_CONNECTED or STATE_DISCONNECTED, or "" when connected,
    not judged or not yet due."""
    entry = agent_messaging.current(pane_id)
    if entry is None or not _judged(entry):
        return ""
    now = time.monotonic() if now is None else now
    if last_connect(entry.pane_id) is not None:
        return STATE_DISCONNECTED if _dropped(entry.pane_id, now) else ""
    since = _up_since.get(entry.pane_id)
    if since is None or now - since < NEVER_CONNECTED_AFTER_S:
        return ""
    return STATE_NEVER_CONNECTED


def sweep(now: float | None = None) -> list[agent_messaging.RegisteredPane]:
    """Advance the clocks and return panes that just became never-connected."""
    now = time.monotonic() if now is None else now
    live: set[str] = set()
    newly: list[agent_messaging.RegisteredPane] = []
    for entry in agent_messaging.list_panes():
        if not _judged(entry) or last_connect(entry.pane_id) is not None:
            continue
        live.add(entry.pane_id)
        if entry.offline_since is not None or entry.display_status not in _UP_STATUSES:
            continue
        _up_since.setdefault(entry.pane_id, now)
        if state(entry.pane_id, now) and entry.pane_id not in _reported:
            _reported.add(entry.pane_id)
            newly.append(entry)
            log.warning("mcp connect watch: event=pane_never_connected pane=%s name=%r up_for_s=%.0f",
                        entry.pane_id, entry.name, now - _up_since[entry.pane_id])
    for pane_id in [p for p in _up_since if p not in live]:
        del _up_since[pane_id]
    _cleared.extend(
        p for p in _reported
        if p not in live and agent_messaging.current(p) is not None and last_connect(p) is not None
    )
    _reported.intersection_update(live)
    return newly


def sweep_dropped(now: float | None = None) -> list[agent_messaging.RegisteredPane]:
    """Return panes that just became disconnected; queue reported ones that
    reconnected for take_cleared()."""
    now = time.monotonic() if now is None else now
    dropped: set[str] = set()
    newly: list[agent_messaging.RegisteredPane] = []
    for entry in agent_messaging.list_panes():
        if not _judged(entry) or last_connect(entry.pane_id) is None:
            continue
        if not _dropped(entry.pane_id, now):
            continue
        dropped.add(entry.pane_id)
        if entry.offline_since is None and entry.pane_id not in _reported_dropped:
            _reported_dropped.add(entry.pane_id)
            newly.append(entry)
            closed = max(t for t in (_closed_at.get(i) for i in [entry.pane_id, *agent_messaging.former_ids(entry.pane_id)])
                         if t is not None)
            log.warning(
                "mcp connect watch: event=pane_disconnected pane=%s name=%r stream_closed_s_ago=%.0f grace_s=%.0f "
                "after_long_stall=%s",
                entry.pane_id, entry.name, now - closed, _grace(closed), _grace(closed) == DROPPED_AFTER_STALL_S,
            )
    _cleared.extend(
        p for p in _reported_dropped
        if p not in dropped and agent_messaging.current(p) is not None and state(p, now) == ""
    )
    _reported_dropped.intersection_update(dropped)
    known = {e.pane_id for e in agent_messaging.list_panes()}
    # The /plan-mcp listener may run on its own thread (own_loop): copy a
    # table before walking it, and drop with pop.
    for table in (_open_streams, _closed_at):
        for pane_id in [p for p in list(table) if p not in known and agent_messaging.current(p) is None]:
            table.pop(pane_id, None)
    return newly


def backend_recovered(now: float | None = None) -> bool:
    """Whether a reconnect now can work: the endpoint is not reported down and
    no long loop stall ended in the last RECOVERY_SETTLE_S."""
    from .mcp_server import health as mcp_health

    if mcp_health.snapshot()["probe_state"] == "down":
        return False
    now = time.monotonic() if now is None else now
    stall = _last_long_stall
    return stall is None or now - stall[1] >= RECOVERY_SETTLE_S


def due_reconnects(now: float | None = None) -> list[agent_messaging.RegisteredPane]:
    """Flagged panes to reconnect in place right now: idle, window connected,
    with tries left and the last one AUTO_RECONNECT_RETRY_S ago, and only once
    the backend has recovered (no try is spent before). Forgets the tries of a
    pane that is no longer flagged, so its next drop starts over."""
    now = time.monotonic() if now is None else now
    recovered = backend_recovered(now)
    flagged: set[str] = set()
    due: list[agent_messaging.RegisteredPane] = []
    for entry in agent_messaging.list_panes():
        if not state(entry.pane_id, now):
            continue
        flagged.add(entry.pane_id)
        if not recovered or entry.offline_since is not None or entry.display_status != "idle":
            continue
        tries, last = _auto_tries.get(entry.pane_id, (0, 0.0))
        if tries >= AUTO_RECONNECT_MAX_TRIES or (tries and now - last < AUTO_RECONNECT_RETRY_S):
            continue
        due.append(entry)
    for pane_id in [p for p in _auto_tries if p not in flagged]:
        del _auto_tries[pane_id]
    return due


def note_reconnect_sent(pane_id: str, now: float | None = None) -> None:
    """The window typed an automatic reconnect into ``pane_id``."""
    now = time.monotonic() if now is None else now
    tries, _ = _auto_tries.get(pane_id, (0, 0.0))
    _auto_tries[pane_id] = (tries + 1, now)


def auto_tries(pane_id: str) -> int:
    """Automatic reconnects typed into ``pane_id`` in its current episode."""
    return _auto_tries.get(pane_id, (0, 0.0))[0]


def take_cleared() -> list[str]:
    """Reported panes that connected after all (a manual /mcp, a rebuild)."""
    out = list(_cleared)
    _cleared.clear()
    return out


async def run(
    notify: Callable[[agent_messaging.RegisteredPane], Awaitable[None]],
    notify_cleared: Callable[[str], Awaitable[None]] | None = None,
    notify_dropped: Callable[[agent_messaging.RegisteredPane], Awaitable[None]] | None = None,
    reconnect: Callable[[agent_messaging.RegisteredPane], Awaitable[bool]] | None = None,
    notify_auto_reconnected: Callable[[str], Awaitable[None]] | None = None,
) -> None:
    """Sweep every SWEEP_INTERVAL_S: hand each newly flagged pane to
    ``notify`` (never connected) or ``notify_dropped`` (disconnected), each
    flagged pane that has since connected to ``notify_cleared``, and each one
    due_reconnects() offers to ``reconnect`` (True: it was typed in). A long
    loop stall (note_stall) brings the next sweep forward to just after the
    shortened grace."""
    global _wake
    _wake = asyncio.Event()
    while True:
        try:
            await asyncio.wait_for(_wake.wait(), SWEEP_INTERVAL_S)
            _wake.clear()
            await asyncio.sleep(DROPPED_AFTER_STALL_S + 1)
        except asyncio.TimeoutError:
            pass
        for entry in sweep():
            try:
                await notify(entry)
            except Exception as err:  # noqa: BLE001 — the loop must survive a failed notice
                log.warning("mcp connect watch: notice for %s failed: %s", entry.pane_id, err)
        for entry in sweep_dropped():
            if notify_dropped is None:
                continue
            try:
                await notify_dropped(entry)
            except Exception as err:  # noqa: BLE001
                log.warning("mcp connect watch: disconnect notice for %s failed: %s", entry.pane_id, err)
        for pane_id in take_cleared():
            # Read before due_reconnects() below forgets the episode's tries.
            tries = auto_tries(pane_id)
            if tries:
                log.info("mcp connect watch: event=pane_auto_reconnected pane=%s tries=%d", pane_id, tries)
            if notify_cleared is not None:
                try:
                    await notify_cleared(pane_id)
                except Exception as err:  # noqa: BLE001
                    log.warning("mcp connect watch: cleared notice for %s failed: %s", pane_id, err)
            if tries and notify_auto_reconnected is not None:
                try:
                    await notify_auto_reconnected(pane_id)
                except Exception as err:  # noqa: BLE001
                    log.warning("mcp connect watch: auto-reconnected notice for %s failed: %s", pane_id, err)
        if reconnect is not None:
            # Together, not one by one: a window that does not answer costs
            # each request its full timeout, and 65 panes dropped at once.
            await asyncio.gather(*(_reconnect_one(reconnect, e) for e in due_reconnects()))


async def _reconnect_one(
    reconnect: Callable[[agent_messaging.RegisteredPane], Awaitable[bool]],
    entry: agent_messaging.RegisteredPane,
) -> None:
    try:
        if await reconnect(entry):
            note_reconnect_sent(entry.pane_id)
            log.info("mcp connect watch: event=pane_auto_reconnect_sent pane=%s try=%d",
                     entry.pane_id, auto_tries(entry.pane_id))
    except Exception as err:  # noqa: BLE001 — the loop must survive a failed try
        log.warning("mcp connect watch: reconnect of %s failed: %s", entry.pane_id, err)


def _reset_for_test() -> None:
    global _last_long_stall
    _last_long_stall = None
    _auto_tries.clear()
    _open_streams.clear()
    _closed_at.clear()
    _reported_dropped.clear()
    _cleared.clear()
    _last_seen.clear()
    _up_since.clear()
    _reported.clear()
