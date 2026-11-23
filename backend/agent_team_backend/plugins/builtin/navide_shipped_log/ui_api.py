"""The Shipped Log panel's requests (``ship_log.*`` over the Host WebSocket).

The panel is the user's own window, so these act as the user: they may add an
entry, confirm or dismiss a detected command, set an item's own line or
sensitive mark, register a production setting and change the digest. They
keep every rule the agent tools keep — an entry or setting that looks like it
carries a value is refused, not masked — and a sensitive item's ref is never
sent back to the window either.
"""

from __future__ import annotations

import asyncio
from typing import Any

from agent_team_backend.plugins.builtin.navide_shipped_log import digest
from agent_team_backend.plugins.builtin.navide_shipped_log import report as ship_report
from agent_team_backend.plugins.builtin.navide_shipped_log.ledger import LedgerError, ShipLogLedger, ledger as _default

TYPES = (
    "ship_log.report", "ship_log.record", "ship_log.detection", "ship_log.override",
    "ship_log.configs", "ship_log.config_set", "ship_log.digest_get", "ship_log.digest_set", "ship_log.digest_run",
)
#: The pane label of an entry the user adds from the panel.
USER_PANE = "Navide"


def _public(item: dict[str, Any]) -> dict[str, Any]:
    out = dict(item)
    if out.get("sensitive"):
        out.pop("ref", None)
    return out


def _bool_or_none(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


async def handle(msg_type: str, payload: dict[str, Any], *, book: ShipLogLedger | None = None) -> dict[str, Any]:
    """One request; always answers a dict with ``ok``."""
    book = book or _default
    workspace = payload.get("workspace")
    if not isinstance(workspace, str) or not workspace.strip():
        return {"ok": False, "error": f"{msg_type} needs a workspace"}
    try:
        return await _dispatch(msg_type, workspace, payload, book)
    except (LedgerError, ship_report.WindowError) as err:
        return {"ok": False, "error": str(err)}


async def _dispatch(msg_type: str, ws: str, p: dict[str, Any], book: ShipLogLedger) -> dict[str, Any]:
    if msg_type == "ship_log.report":
        start, end = ship_report.parse_window(str(p.get("since") or "今天"), str(p.get("until") or ""))
        built = await ship_report.build_report(ws, start, end, branch=str(p.get("branch") or ""), ledger=book)
        return {"ok": True, **{k: v for k, v in built.items() if k != "items"},
                "items": [_public(i) for i in built["items"]]}
    if msg_type == "ship_log.record":
        at = str(p.get("at") or "").strip()
        when = int(ship_report.parse_moment(at).timestamp()) if at else None
        result = await asyncio.to_thread(
            book.record, ws, summary=str(p.get("summary") or ""), source_kind=str(p.get("source_kind") or "other"),
            ref=str(p.get("ref") or ""), at=when, sensitive=_bool_or_none(p.get("sensitive")), pane=USER_PANE,
        )
        if result.get("disabled"):
            return {"ok": False, "error": f"the ship log ledger is disabled in this workspace: {result['disabled']}"}
        detection = p.get("detection_id")
        if isinstance(detection, int):
            await asyncio.to_thread(book.set_detection_status, ws, detection, "confirmed")
        return result
    if msg_type == "ship_log.detection":
        detection = p.get("id")
        if not isinstance(detection, int):
            return {"ok": False, "error": "ship_log.detection needs an id"}
        changed = await asyncio.to_thread(book.set_detection_status, ws, detection, str(p.get("status") or ""))
        return {"ok": changed, **({} if changed else {"error": "no such detected command"})}
    if msg_type == "ship_log.override":
        summary = p.get("summary")
        return await asyncio.to_thread(
            book.set_override, ws, str(p.get("item_key") or ""),
            summary=summary if isinstance(summary, str) else None, sensitive=_bool_or_none(p.get("sensitive")),
        )
    if msg_type == "ship_log.configs":
        return await asyncio.to_thread(book.configs, ws)
    if msg_type == "ship_log.config_set":
        return await asyncio.to_thread(
            book.register_config, ws, key=str(p.get("key") or ""), label=str(p.get("label") or ""),
            location=str(p.get("location") or ""), environment=str(p.get("environment") or ""),
            note=str(p.get("note") or ""), remove=p.get("remove") is True,
        )
    if msg_type == "ship_log.digest_get":
        return await digest.get(ws, book=book)
    if msg_type == "ship_log.digest_set":
        return await digest.set_settings(ws, p.get("settings"), book=book)
    if msg_type == "ship_log.digest_run":
        return await digest.run_now(ws, book=book)
    return {"ok": False, "error": f"unknown request {msg_type}"}
