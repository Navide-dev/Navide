"""Approvals and review notes sent from a share link's web page.

A browser signed in to this account (share.navide.dev) can approve a shared
plan or leave a note. The server cannot read it: the page seals
``{v, action, text, contentSha256, version, at}`` with the link's key K::

    cipher = base64url( nonce (12) ‖ AES-256-GCM(JSON) ‖ tag (16) )
    AAD    = "navide-feedback/v1:<linkId>:<version>"

and queues it for the device that created the link (``links.feedback``
push, or ``links.feedback.list`` after a reconnect). This module, on that
device, opens it with K (unwrapped from the account ring), and applies it
only when it is about exactly what was published and what the plan still
holds: the same content version, the same content hash as the published
copy, and a file on disk that still masks to that hash. Then it goes
through the plan's own writers — the stage change approval always makes
(``_update_stage_sync``) and a review note saying where it came from —
and is acked. Anything else is refused, announced as such, and acked too,
so the queue never replays it. Ids handled here are remembered, so a lost
ack cannot apply the same feedback twice.

Without Navide Cloud connected nothing here runs: the push never arrives,
and the reconnect drain checks the link before asking.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from . import share_links, sync_keyring

log = logging.getLogger("agent_team_backend.share_feedback")

#: How the plan records where an approval or a note came from.
PHONE_APPROVED = "從手機核准（share.navide.dev，帳號登入）"
PHONE_NOTE = "從手機留言（share.navide.dev，帳號登入）"

_PAGE = 50
_SEEN_FILE = "share-feedback-seen.json"
_SEEN_MAX = 2000
_APPROVABLE = ("draft", "in-review")
_MAX_TEXT = 4000


class _Refused(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _seen_path() -> Path:
    from .applog import app_data_dir

    return app_data_dir() / _SEEN_FILE


def _seen() -> list[str]:
    try:
        data = json.loads(_seen_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [x for x in data if isinstance(x, str)] if isinstance(data, list) else []


def _remember(feedback_id: str) -> None:
    ids = [x for x in _seen() if x != feedback_id] + [feedback_id]
    path = _seen_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(ids[-_SEEN_MAX:]), encoding="utf-8")
    tmp.replace(path)


def _open(cipher: str, key: bytes, link_id: str, version: int) -> dict[str, Any]:
    try:
        raw = base64.urlsafe_b64decode(cipher + "=" * (-len(cipher) % 4))
        body = AESGCM(key).decrypt(raw[:12], raw[12:], f"navide-feedback/v1:{link_id}:{version}".encode())
        data = json.loads(body)
    except Exception as err:  # noqa: BLE001 - any failure to open is the same refusal
        raise _Refused("unreadable") from err
    if not isinstance(data, dict) or data.get("v") != 1:
        raise _Refused("unreadable")
    return data


def _plan_location(path: str) -> tuple[str, str]:
    """(workspace, rel_path) of a plan under <workspace>/.agent-team/plans/."""
    p = Path(path)
    if p.parent.name != "plans" or p.parent.parent.name != ".agent-team" or p.suffix.lower() != ".html":
        raise _Refused("not-a-plan")
    return str(p.parent.parent.parent), f".agent-team/plans/{p.name}"


def _apply(path: str, action: str, text: str) -> str:
    from .plugins.builtin.navide_plans.plan_meta import parse_plan_meta
    from .plugins.builtin.navide_plans.plan_tools import _add_note_sync, _update_stage_sync

    workspace, rel = _plan_location(path)
    text = text.strip()[:_MAX_TEXT]
    if action == "note":
        if not text:
            raise _Refused("empty-note")
        _add_note_sync(workspace, rel, f"{text}\n— {PHONE_NOTE}", "user")
        return "noted"
    meta = parse_plan_meta(Path(path).read_text(encoding="utf-8")) or {}
    stage = str(meta.get("stage") or "")
    if stage not in _APPROVABLE:
        # Approving never moves a plan backwards; the note keeps the record.
        _add_note_sync(workspace, rel, f"{PHONE_APPROVED} — stage was already {stage}, left unchanged", "user")
        return "already"
    _update_stage_sync(workspace, rel, "approved")
    _add_note_sync(workspace, rel, f"{PHONE_APPROVED}" + (f"\n{text}" if text else ""), "user")
    return "approved"


async def _handle(client: share_links.LinksClient, item: dict[str, Any]) -> dict[str, Any]:
    """Apply or refuse one feedback item. Returns the announcement payload."""
    link_id = str(item.get("linkId") or "")
    result: dict[str, Any] = {"feedbackId": item.get("feedbackId"), "linkId": link_id}
    try:
        row = await client.request("unwrap", {"linkId": share_links._check_link_id(link_id)})
        current = int(row.get("version") or 1)
        key = sync_keyring.unwrap_aux(share_links.key_label(link_id, current), str(row.get("wrappedKey") or ""))
        meta = share_links._open_meta(link_id, current, row.get("metaEnc")) or {}
        result["title"] = meta.get("title") or ""
        version = int(item.get("version") or 0)
        body = _open(str(item.get("cipher") or ""), key, link_id, version)
        published = str(meta.get("sha256") or "")
        if version != current or body.get("version") != current:
            raise _Refused("content-changed")
        if not published or body.get("contentSha256") != published or item.get("contentHash") != published:
            raise _Refused("content-changed")
        path = str(meta.get("path") or "")
        try:
            prepared = share_links.prepare(path, str(row.get("kind") or "plan"))
        except share_links.ShareRefused as err:
            raise _Refused("content-changed" if err.code in ("missing", "changed") else err.code) from err
        if prepared.sha256 != published:
            raise _Refused("content-changed")
        action = body.get("action")
        if action not in ("approve", "note"):
            raise _Refused("unreadable")
        result["result"] = _apply(path, action, str(body.get("text") or ""))
    except _Refused as refused:
        result.update(result="rejected", reason=refused.reason)
    return result


async def _announce(payload: dict[str, Any]) -> None:
    from . import app
    from .ipc import make_event

    try:
        await app.broadcast(make_event("share.feedback", payload))
    except Exception as err:  # noqa: BLE001 - a notice must not undo the apply
        log.warning("announcing share-link feedback failed: %s", err)


async def handle_event(client: share_links.LinksClient, item: dict[str, Any]) -> None:
    """One feedback item: apply or refuse it (once), announce, ack.

    A transient failure (the link dropped, the ring is unreadable) leaves it
    unacked so the next drain retries it."""
    feedback_id = item.get("feedbackId")
    if not isinstance(feedback_id, str) or not feedback_id:
        return
    if feedback_id not in _seen():
        try:
            outcome = await _handle(client, item)
        except (share_links.ShareError, sync_keyring.KeyringError) as err:
            log.warning("share-link feedback %s left for a retry: %s", feedback_id[:8], err)
            return
        _remember(feedback_id)
        await _announce(outcome)
    try:
        await client.request("feedback.ack", {"feedbackIds": [feedback_id]})
    except share_links.ShareError as err:
        log.info("acking share-link feedback %s failed; it will be seen again: %s", feedback_id[:8], err)


async def drain(client: share_links.LinksClient) -> None:
    """Everything queued for this device, oldest first, until the queue is short."""
    for _ in range(20):
        try:
            page = await client.request("feedback.list", {})
        except share_links.ShareRemoteError as err:
            if err.code not in share_links.UNAVAILABLE_CODES:
                log.info("listing share-link feedback failed: %s", err)
            return
        items = [f for f in page.get("feedback") or [] if isinstance(f, dict)]
        for item in items:
            await handle_event(client, item)
        if len(items) < _PAGE:
            return


def _connected() -> bool:
    from . import server_link

    return server_link.link_state() == server_link.STATE_CONNECTED


async def drain_if_connected() -> None:
    """The reconnect hook: ask for queued feedback only on a live link."""
    if _connected():
        await drain(share_links.ServerLinksClient())


async def on_pushed(payload: Any) -> None:
    """The ``links.feedback`` push hook."""
    if not _connected() or not isinstance(payload, dict):
        return
    await handle_event(share_links.ServerLinksClient(), payload)
