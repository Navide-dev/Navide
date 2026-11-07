"""Chat-channel requests an agent files and the user decides in the main window.

Plan mcp-bot_507912 P2. The channels_* MCP tools can ask for what is the
user's to grant — letting a person in, removing a bot, binding a pane of
another workspace or to a chat nobody was let in from, adding a bot whose
credential only the user types — but never grant it themselves. A request
is held here, every main window is shown it (``channels.agent_request.changed``),
and only a main window's own WS session can decide it
(``channels.agent_request.decide`` / ``.finish``, see ws_api.handle); an
agent reaches Navide through MCP alone and has no such session.

Two more kinds only follow something the user does elsewhere, so an agent can
wait on it with channels_request_status: ``managed-create`` (the user presses
Create in Telegram; manager.managed_create) and ``link`` (someone sends a link
code; manager.link_create). Both settle from the manager's own broadcasts
(:func:`on_event`).

Held in memory: a backend restart drops every open request, and a request
nobody decides expires after ``TTL_S``. Nothing here holds or returns a bot
credential.
"""

from __future__ import annotations

import asyncio
import copy
import threading
import time
import uuid
from typing import Any

from . import redact
from .store import DEFAULT_ACCOUNT

#: Kinds the main window decides, and kinds that only follow the user.
DECIDED_KINDS = ("bot-add", "pairing-approve", "bot-remove", "bind")
FOLLOWED_KINDS = ("managed-create", "link")
TTL_S = 15 * 60
CHANGED_EVENT = "channels.agent_request.changed"
#: Statuses past which a request does not move again.
FINAL = ("completed", "failed", "rejected", "expired")


class AgentRequestError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class AgentRequests:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._records: dict[str, dict[str, Any]] = {}

    def file(self, kind: str, requester: dict[str, Any], reason: str, target: dict[str, Any],
             *, draft: dict[str, Any] | None = None, ttl_s: float = TTL_S) -> dict[str, Any]:
        if kind not in DECIDED_KINDS + FOLLOWED_KINDS:
            raise AgentRequestError("bad-request", f"unknown request kind {kind!r}")
        now = time.time()
        record = {
            "id": uuid.uuid4().hex,
            "kind": kind,
            "requester": dict(requester),
            "reason": reason[:500],
            "target": copy.deepcopy(target),
            "draft": copy.deepcopy(draft or {}),
            "status": "pending",
            "result": None,
            "error": None,
            "created_at": now,
            "expires_at": now + ttl_s,
        }
        with self._lock:
            self._expire()
            self._records[record["id"]] = record
            return copy.deepcopy(record)

    def get(self, request_id: str) -> dict[str, Any] | None:
        with self._lock:
            self._expire()
            record = self._records.get(request_id)
            return copy.deepcopy(record) if record else None

    def pending(self) -> list[dict[str, Any]]:
        """The requests a main window shows: every decided kind still open."""
        with self._lock:
            self._expire()
            return [copy.deepcopy(r) for r in self._records.values()
                    if r["kind"] in DECIDED_KINDS and r["status"] in ("pending", "applying")]

    def settle(self, request_id: str, status: str, *, result: Any = None, error: str | None = None,
               only_from: tuple[str, ...] = ("pending", "applying")) -> dict[str, Any] | None:
        """Move one request on; None when it is unknown or not in ``only_from``."""
        with self._lock:
            self._expire()
            record = self._records.get(request_id)
            if record is None or record["status"] not in only_from:
                return None
            record["status"] = status
            if result is not None:
                record["result"] = copy.deepcopy(result)
            if error is not None:
                record["error"] = redact.redact_text(error)
            return copy.deepcopy(record)

    def find(self, kind: str, **target: str) -> dict[str, Any] | None:
        """The open request of ``kind`` whose target has these values."""
        with self._lock:
            self._expire()
            for record in self._records.values():
                if (record["kind"] == kind and record["status"] in ("pending", "applying")
                        and all(record["target"].get(k) == v for k, v in target.items())):
                    return copy.deepcopy(record)
        return None

    def _expire(self) -> None:
        now = time.time()
        for record in self._records.values():
            if record["status"] == "pending" and record["expires_at"] <= now:
                record["status"] = "expired"
        # Settled records stay readable for a while, then go.
        for request_id in [i for i, r in self._records.items()
                           if r["status"] in FINAL and r["expires_at"] + TTL_S <= now]:
            del self._records[request_id]

    def _reset_for_test(self) -> None:
        with self._lock:
            self._records.clear()


registry = AgentRequests()


def public(record: dict[str, Any]) -> dict[str, Any]:
    """What an agent or a window is shown of a request (everything; it holds no secret)."""
    return copy.deepcopy(record)


async def announce(record: dict[str, Any] | None) -> None:
    if record is None:
        return
    from .. import app
    from ..ipc import make_event

    await app.broadcast_main_windows(make_event(CHANGED_EVENT, public(record)))


async def decide(manager: Any, request_id: str, approve: bool) -> dict[str, Any]:
    """The main window's answer to a decided request; runs what was asked on approval."""
    record = registry.get(request_id)
    if record is None or record["kind"] not in DECIDED_KINDS:
        return {"ok": False, "error": "unknown request"}
    if record["status"] != "pending":
        return {"ok": False, "error": f"the request is {record['status']}"}
    if not approve:
        settled = registry.settle(request_id, "rejected", only_from=("pending",))
        await announce(settled)
        return {"ok": True, "request": settled}
    if record["kind"] == "bot-add":
        # The user adds the bot in the form, which reports with ``finish``.
        return {"ok": False, "error": "a bot is added from its form"}
    if registry.settle(request_id, "applying", only_from=("pending",)) is None:
        return {"ok": False, "error": "the request is no longer pending"}
    try:
        outcome = await _apply(manager, record)
    except ValueError as err:
        outcome = {"ok": False, "error": str(err)}
    if outcome.get("ok"):
        settled = registry.settle(request_id, "completed", result=_result_of(outcome))
    else:
        settled = registry.settle(request_id, "failed", error=str(outcome.get("error") or "refused"))
    await announce(settled)
    return {"ok": True, "request": settled}


async def finish(request_id: str, ok: bool, account: str = "", error: str = "") -> dict[str, Any]:
    """The bot-add form's report: the user added the bot (``account``) or gave up."""
    record = registry.get(request_id)
    if record is None or record["kind"] != "bot-add":
        return {"ok": False, "error": "unknown request"}
    if ok:
        settled = registry.settle(request_id, "completed",
                                  result={"platform": record["target"]["platform"], "account": account},
                                  only_from=("pending",))
    else:
        settled = registry.settle(request_id, "failed", error=error or "the bot was not added", only_from=("pending",))
    if settled is None:
        return {"ok": False, "error": f"the request is {record['status']}"}
    await announce(settled)
    return {"ok": True, "request": settled}


async def _apply(manager: Any, record: dict[str, Any]) -> dict[str, Any]:
    t = record["target"]
    kind = record["kind"]
    if kind == "bot-remove":
        return await manager.remove(t["platform"], t["account"])
    if kind == "bind":
        return await manager.bind(t["pane_id"], t["pane"], t["platform"], t["mode"], t["chat_id"],
                                  t["thread_id"], t["title"], verbosity=t["verbosity"],
                                  account=t["account"] or DEFAULT_ACCOUNT)
    # pairing-approve: approve, then bind the sender's chat when a pane was named.
    approved = await manager.pairing_approve(t["platform"], t["code"])
    if not approved.get("ok") or not t.get("bind_pane_id"):
        return approved
    bound = await manager.bind(t["bind_pane_id"], t["bind_pane"], t["platform"], "existing", t["chat_id"],
                               "", t.get("sender_name") or "", account=t["account"] or DEFAULT_ACCOUNT)
    if not bound.get("ok"):
        return {"ok": True, "sender_id": approved.get("sender_id"),
                "bind_error": str(bound.get("error") or "the chat could not be bound")}
    return {"ok": True, "sender_id": approved.get("sender_id"), "binding": bound.get("binding")}


def _result_of(outcome: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in outcome.items() if k != "ok"}


def link_stage(manager: Any, code: str) -> str | None:
    """The pairing code waiting on the user for a redeemed invite ``code``, if any."""
    pending = getattr(manager, "_pending_links", {}) or {}
    for (_platform, pairing_code), (invite_code, _msg) in list(pending.items()):
        if invite_code == code:
            return pairing_code
    return None


def on_event(event_type: str, payload: dict[str, Any]) -> None:
    """Settle the followed requests from the manager's broadcasts. Never raises."""
    try:
        if event_type == "channels.managed_created":
            record = registry.find("managed-create", request_id=str(payload.get("request_id") or ""))
            if record is not None:
                if payload.get("ok"):
                    registry.settle(record["id"], "completed", result={
                        "account": payload.get("account"), "name": payload.get("name"),
                        "link": payload.get("link"),
                    })
                else:
                    registry.settle(record["id"], "failed", result={
                        "reason": payload.get("reason"), "created": bool(payload.get("created")),
                    }, error=str(payload.get("error") or payload.get("reason") or "not created"))
        elif event_type in ("channels.linked", "channels.link_failed"):
            record = registry.find("link", platform=str(payload.get("platform") or ""),
                                   code=str(payload.get("code") or ""))
            if record is not None:
                if event_type == "channels.linked":
                    registry.settle(record["id"], "completed", result={
                        k: payload.get(k) for k in ("chat_id", "title", "kind", "confirmed")})
                else:
                    registry.settle(record["id"], "failed", error=str(payload.get("error") or ""))
    except Exception:  # noqa: BLE001 — a broadcast must never fail over this
        pass


async def wait(request_id: str, wait_s: float, poll_s: float = 0.25) -> dict[str, Any] | None:
    """The request once it settles or ``wait_s`` passes (capped at 60s)."""
    deadline = time.monotonic() + max(0.0, min(float(wait_s or 0), 60.0))
    while True:
        record = registry.get(request_id)
        if record is None or record["status"] in FINAL or time.monotonic() >= deadline:
            return record
        await asyncio.sleep(poll_s)
