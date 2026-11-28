"""Commander logic over :mod:`commander_store`: detected states, the dispatch
tree, upgrade/downgrade and the hooks other modules plug into.

Contract for the other 0.2.51 commander branches (keep these names stable):

- ``current()`` -> the :class:`CommanderService` (built lazily over
  ``app.database``; tests call ``configure``).
- ``register_migrator(Migrator(...))`` (bindings branch): moves a pane's
  channel bindings / schedules onto the commander at upgrade, puts them back
  at downgrade, pauses / resumes them at archive. Each upgrade step returns
  ``[(ref_id, before_dict)]``; the service stores them in
  ``commander_migrations`` and hands the same dict back to ``restore``.
- ``register_binding_summary(fn)`` (bindings branch): ``fn(commander_id)``
  returns a list of :data:`BindingSummary` dicts shown by commander.get.
- ``CommanderService.role_of(pane_id)`` (mcp branch, cli_whoami):
  ``{"id", "name", "role": "commander"}`` or
  ``{"id", "name", "role": "worker", "dispatched_by"}`` or None.
- ``CommanderService.note_open(opener_pane_id, child_pane_id, task)`` (mcp
  branch, cli_open_agent): records a dispatch when the opener or one of its
  ``opened_by`` ancestors belongs to a commander.
- ``CommanderService.tree(commander_id)`` / ``detect(pane_id, ...)`` (watch
  branch): read-only; safe to call from a worker thread.

A commander manages only the relations it created. Nothing here changes a
pane's own settings (YOLO, tools, MCP, account).
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .commander_store import (
    Commander,
    CommanderBody,
    CommanderDispatch,
    CommanderInvalid,
    CommanderNotFound,
    CommanderStore,
)

log = logging.getLogger(__name__)

# ── detected states ─────────────────────────────────────────────────────────
WORKING = "working"
WAITING = "waiting"
REPORTED = "reported"
IDLE = "idle"
STALLED = "stalled"
GONE = "gone"
STATES = (WORKING, WAITING, REPORTED, IDLE, STALLED, GONE)

#: The renderer's DisplayStatus word for a pane parked on a question or a
#: permission prompt (agent_messaging.RegisteredPane.display_status).
_AWAITING = "awaiting"


def classify(
    *,
    registered: bool,
    busy: bool,
    display_status: str,
    activity_age_s: float | None,
    reported: bool,
    stall_minutes: int,
) -> str:
    """The detected state from facts already held elsewhere. Pure."""
    if not registered:
        return GONE
    if display_status == _AWAITING:
        return WAITING
    if busy:
        if activity_age_s is not None and activity_age_s > stall_minutes * 60:
            return STALLED
        return WORKING
    return REPORTED if reported else IDLE


# ── hooks for other modules ─────────────────────────────────────────────────

#: (ref_id, before) pairs a migrator moved.
Moved = list[tuple[str, dict[str, Any]]]


@dataclass(frozen=True)
class Migrator:
    #: Stored as commander_migrations.kind, e.g. "channel_binding".
    kind: str
    #: (commander_id, pane_id) -> what was retargeted, with original values.
    upgrade: Callable[[str, str], Moved]
    #: (commander_id, ref_id, before, pane_id) -> put it back onto pane_id.
    restore: Callable[[str, str, dict[str, Any], str], None]
    #: (commander_id, paused) -> pause or resume everything bound to it.
    set_paused: Callable[[str, bool], None] | None = None


#: {kind, ref_id, label, target, paused}
BindingSummary = dict[str, Any]

_MIGRATORS: dict[str, Migrator] = {}
_BINDING_SUMMARIES: list[Callable[[str], list[BindingSummary]]] = []


def register_migrator(migrator: Migrator) -> None:
    _MIGRATORS[migrator.kind] = migrator


def unregister_migrator(kind: str) -> None:
    _MIGRATORS.pop(kind, None)


def register_binding_summary(fn: Callable[[str], list[BindingSummary]]) -> None:
    if fn not in _BINDING_SUMMARIES:
        _BINDING_SUMMARIES.append(fn)


def unregister_binding_summary(fn: Callable[[str], list[BindingSummary]]) -> None:
    if fn in _BINDING_SUMMARIES:
        _BINDING_SUMMARIES.remove(fn)


# ── live facts (injectable for tests) ───────────────────────────────────────


def _live_pane(pane_id: str) -> Any:
    from . import agent_messaging

    return agent_messaging.current(pane_id)


def _live_ids(pane_id: str) -> list[str]:
    """Every id *pane_id* is known by: itself, the id that superseded it and
    the ids it superseded (agent_messaging's aliases)."""
    from . import agent_messaging

    out = [pane_id]
    newer = agent_messaging.resolve_alias(pane_id)
    if newer:
        out.append(newer)
    out += agent_messaging.former_ids(newer or pane_id)
    return list(dict.fromkeys(out))


def _live_activity(pane_id: str) -> dict[str, Any] | None:
    from . import app

    return app.pane_activity(pane_id)


def _live_reported(sender: str, recipient: str, since: int) -> bool:
    """Did *sender* send *recipient* a message at or after *since* (seconds)?
    agent_message_log keys both sides by pane name."""
    from . import app

    with app.database.transaction() as cur:
        row = cur.execute(
            "SELECT 1 FROM agent_message_log WHERE sender = ? AND recipient = ?"
            " AND (CASE WHEN created_at > 100000000000 THEN created_at / 1000 ELSE created_at END) >= ?"
            " LIMIT 1",
            (sender, recipient, since),
        ).fetchone()
    return row is not None


class CommanderService:
    def __init__(
        self,
        store: CommanderStore,
        *,
        pane: Callable[[str], Any] = _live_pane,
        activity: Callable[[str], dict[str, Any] | None] = _live_activity,
        reported: Callable[[str, str, int], bool] = _live_reported,
        monotonic: Callable[[], float] = time.monotonic,
        clock: Callable[[], float] = time.time,
        ids: Callable[[str], list[str]] = _live_ids,
    ) -> None:
        self.store = store
        self._pane = pane
        self._activity = activity
        self._reported = reported
        self._monotonic = monotonic
        self._clock = clock
        self._ids = ids

    def _now(self) -> int:
        return int(self._clock())

    # ── reading ──

    def body(self, commander_id: str) -> CommanderBody | None:
        """The current body, following a pane id that has since changed."""
        body = self.store.current_body(commander_id)
        if body is None:
            return None
        live = self._pane(body.pane_id)
        if live is not None and live.pane_id != body.pane_id:
            self.store.update_body_pane(body.pane_id, live.pane_id)
            body.pane_id = live.pane_id
        return body

    def detect(self, pane_id: str, *, dispatcher: str = "", since: int = 0, stall_minutes: int = 20,
               closed: bool = False) -> str:
        """Detected state of *pane_id*; *dispatcher* is the pane that opened
        it (its report recipient), *since* the dispatch time in seconds."""
        live = None if closed else self._pane(pane_id)
        if live is None:
            return classify(registered=False, busy=False, display_status="", activity_age_s=None,
                            reported=False, stall_minutes=stall_minutes)
        activity = self._activity(live.pane_id)
        age = None if activity is None else self._monotonic() - float(activity["ts_monotonic"])
        reported = False
        if not live.busy and dispatcher:
            boss = self._pane(dispatcher)
            if boss is not None:
                try:
                    reported = self._reported(live.name, boss.name, since)
                except Exception as err:  # noqa: BLE001 - a status read must not fail
                    log.debug("commander report check failed: %s", err)
        return classify(registered=True, busy=bool(live.busy), display_status=live.display_status or "",
                        activity_age_s=age, reported=reported, stall_minutes=stall_minutes)

    def tree(self, commander_id: str) -> dict[str, Any]:
        """The dispatch tree rooted at the commander's body; every node has a
        detected state. Closed dispatches stay, with state ``gone``."""
        commander = self.store.get(commander_id)
        body = self.body(commander_id)
        dispatches = self.store.dispatches(commander_id)
        nodes: dict[str, dict[str, Any]] = {}
        for d in dispatches:
            nodes[d.pane_id] = self._node(d, commander)
        root_id = body.pane_id if body is not None else ""
        root: dict[str, Any] = {
            "pane_id": root_id,
            "name": self._name(root_id) or commander.name,
            "opened_by": "",
            "task": "",
            "opened_at": body.attached_at if body is not None else 0,
            "closed_at": 0,
            "state": self.detect(root_id, stall_minutes=commander.stall_minutes) if root_id else GONE,
            "children": [],
        }
        orphans: list[dict[str, Any]] = []
        for d in dispatches:
            node = nodes[d.pane_id]
            parent = nodes.get(d.opened_by)
            if parent is not None and parent is not node:
                parent["children"].append(node)
            elif d.opened_by == root_id or not d.opened_by:
                root["children"].append(node)
            else:
                # Opened by a former body or a pane no longer known: still the
                # commander's work, shown under the root.
                orphans.append(node)
        root["children"].extend(orphans)
        return {"commander_id": commander_id, "root": root}

    def _node(self, d: CommanderDispatch, commander: Commander) -> dict[str, Any]:
        return {
            "pane_id": d.pane_id,
            "name": self._name(d.pane_id),
            "opened_by": d.opened_by,
            "task": d.task,
            "opened_at": d.opened_at,
            "closed_at": d.closed_at,
            "state": self.detect(d.pane_id, dispatcher=d.opened_by, since=d.opened_at,
                                 stall_minutes=commander.stall_minutes, closed=bool(d.closed_at)),
            "children": [],
        }

    def _name(self, pane_id: str) -> str:
        live = self._pane(pane_id) if pane_id else None
        return str(live.name) if live is not None else ""

    def bindings(self, commander_id: str) -> list[BindingSummary]:
        out: list[BindingSummary] = []
        for fn in list(_BINDING_SUMMARIES):
            try:
                out.extend(fn(commander_id))
            except Exception as err:  # noqa: BLE001 - one provider must not hide the rest
                log.warning("commander binding summary failed: %s", err)
        return out

    def summary(self, commander: Commander) -> dict[str, Any]:
        """What commander.list / commander.get / commander.changed carry."""
        body = self.body(commander.id) if not commander.archived_at else None
        counts = dict.fromkeys(STATES, 0)
        if body is not None:
            for d in self.store.dispatches(commander.id, open_only=True):
                counts[self.detect(d.pane_id, dispatcher=d.opened_by, since=d.opened_at,
                                   stall_minutes=commander.stall_minutes)] += 1
        return {
            **commander.to_dict(),
            "body": body.to_dict() if body is not None else None,
            "body_live": body is not None and self._pane(body.pane_id) is not None,
            "bindings": self.bindings(commander.id),
            "dispatch_counts": counts,
        }

    def _known_as(self, pane_id: str) -> list[str]:
        """*pane_id* and its alias ids, so a lookup still finds a body or a
        dispatch filed under the id a pane had before its window re-keyed it."""
        try:
            return [i for i in self._ids(pane_id) if i] or [pane_id]
        except Exception as err:  # noqa: BLE001 - a lookup falls back to the id itself
            log.debug("commander alias read failed: %s", err)
            return [pane_id]

    def _follow(self, stored_id: str, pane_id: str) -> None:
        """The store still names *stored_id*; the pane answers to *pane_id*."""
        if stored_id != pane_id:
            self.store.update_body_pane(stored_id, pane_id)

    def commander_of(self, pane_id: str) -> str:
        """The active commander *pane_id* is the body of, or dispatched work
        of, under any of its alias ids; "" when none."""
        for known in self._known_as(pane_id):
            commander_id = self.store.commander_of_body(known)
            if commander_id:
                self._follow(known, pane_id)
                return commander_id
        d = self._dispatch_of(pane_id)
        if d is None or self.store.get(d.commander_id).archived_at:
            return ""
        return d.commander_id

    def _dispatch_of(self, pane_id: str) -> CommanderDispatch | None:
        for known in self._known_as(pane_id):
            d = self.store.dispatch_of(known)
            if d is not None:
                self._follow(known, pane_id)
                d.pane_id = pane_id
                return d
        return None

    def role_of(self, pane_id: str) -> dict[str, Any] | None:
        """For cli_whoami: is *pane_id* a commander's body, or work it dispatched?"""
        for known in self._known_as(pane_id):
            commander_id = self.store.commander_of_body(known)
            if commander_id:
                self._follow(known, pane_id)
                c = self.store.get(commander_id)
                return {"id": c.id, "name": c.name, "role": "commander"}
        d = self._dispatch_of(pane_id)
        if d is None:
            return None
        c = self.store.get(d.commander_id)
        if c.archived_at:
            return None
        return {"id": c.id, "name": c.name, "role": "worker", "dispatched_by": d.opened_by}

    # ── writing ──

    def note_open(self, opener_pane_id: str, child_pane_id: str, task: str = "") -> CommanderDispatch | None:
        """Record a dispatch when *opener_pane_id* is a commander's body or
        work one dispatched (grandchildren count). Returns None otherwise."""
        if not opener_pane_id or not child_pane_id:
            return None
        commander_id = self.commander_of(opener_pane_id)
        if not commander_id:
            return None
        return self.store.record_dispatch(commander_id, pane_id=child_pane_id, opened_by=opener_pane_id,
                                          task=task, now=self._now())

    def create(self, fields: dict[str, Any], *, pane: Any = None, session_id: str = "") -> Commander:
        commander = self.store.create(**fields, now=self._now())
        if pane is not None:
            try:
                self.store.attach_body(commander.id, pane_id=pane.pane_id, workspace=pane.workspace_path,
                                       agent_key=pane.agent_key, session_id=session_id, now=self._now())
            except CommanderInvalid:
                self.store.archive(commander.id, now=self._now())
                raise
        return commander

    def upgrade_pane(self, pane: Any, fields: dict[str, Any], *, session_id: str = "") -> Commander:
        """Make an existing pane a commander, moving what targets that pane."""
        if self.store.commander_of_body(pane.pane_id):
            raise CommanderInvalid("that pane already is a commander")
        fields = {"name": pane.name, "workspaces": [pane.workspace_path], "agent_key": pane.agent_key} | fields
        commander = self.create(fields, pane=pane, session_id=session_id)
        for migrator in list(_MIGRATORS.values()):
            try:
                moved = migrator.upgrade(commander.id, pane.pane_id)
            except Exception:
                self._undo_upgrade(commander.id, pane.pane_id)
                raise
            for ref_id, before in moved:
                self.store.record_migration(commander.id, kind=migrator.kind, ref_id=ref_id, before=before,
                                            now=self._now())
        return commander

    def _undo_upgrade(self, commander_id: str, pane_id: str) -> None:
        self._restore_all(commander_id, pane_id)
        self.store.detach_body(commander_id, now=self._now())
        self.store.archive(commander_id, now=self._now())

    def downgrade(self, commander_id: str) -> Commander:
        """Back to an ordinary pane: every migrated binding and schedule is
        restored onto the current body's pane id; the commander is archived."""
        commander = self.store.get(commander_id)
        if commander.archived_at:
            raise CommanderInvalid("that commander is archived")
        body = self.body(commander_id)
        if body is None:
            raise CommanderInvalid("that commander has no pane to return to")
        self._restore_all(commander_id, body.pane_id)
        self.store.detach_body(commander_id, now=self._now())
        return self.store.archive(commander_id, now=self._now())

    def _restore_all(self, commander_id: str, pane_id: str) -> None:
        import json

        for m in reversed(self.store.pending_migrations(commander_id)):
            migrator = _MIGRATORS.get(m.kind)
            if migrator is None:
                log.warning("no migrator for %s; %s left as is", m.kind, m.ref_id)
                continue
            migrator.restore(commander_id, m.ref_id, json.loads(m.before_json), pane_id)
            self.store.mark_restored(commander_id, m.kind, m.ref_id, now=self._now())

    def update(self, commander_id: str, changes: dict[str, Any]) -> Commander:
        return self.store.update(commander_id, changes, now=self._now())

    def archive(self, commander_id: str) -> Commander:
        """Archive: bindings are paused, never deleted."""
        self.store.get(commander_id)
        for migrator in list(_MIGRATORS.values()):
            if migrator.set_paused is not None:
                migrator.set_paused(commander_id, True)
        return self.store.archive(commander_id, now=self._now())


_SERVICE: CommanderService | None = None


def configure(service: CommanderService | None) -> None:
    global _SERVICE
    _SERVICE = service


def current() -> CommanderService:
    """The service, built over the app's global database on first use."""
    global _SERVICE
    if _SERVICE is None:
        from . import app

        _SERVICE = CommanderService(CommanderStore(app.database))
    return _SERVICE


__all__ = [
    "GONE", "IDLE", "REPORTED", "STALLED", "STATES", "WAITING", "WORKING",
    "BindingSummary", "CommanderInvalid", "CommanderNotFound", "CommanderService", "Migrator",
    "classify", "configure", "current", "register_binding_summary", "register_migrator",
    "unregister_binding_summary", "unregister_migrator",
]
