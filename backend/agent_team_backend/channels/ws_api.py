"""WS request handlers for ``channels.*`` (registered at the end of ws_handlers.py).

Thin: validate the payload shape, call the manager, answer ``{ok, error?, ...}``.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from ..ipc import make_response
from . import get_manager
from .manager import ChannelManager
from .store import DEFAULT_ACCOUNT

if TYPE_CHECKING:
    from ..app import Session

log = logging.getLogger(__name__)


def _s(payload: dict, key: str) -> str:
    value = payload.get(key)
    return str(value).strip() if value is not None else ""


def _account(payload: dict) -> str:
    """The bot a request is about; older windows send none and mean "default"."""
    return _s(payload, "account") or DEFAULT_ACCOUNT


def _share_open_notify(m: ChannelManager) -> dict[str, Any]:
    """The switch, and whether Navide Cloud is connected (the window shows the switch only
    then); the link state is the cheap read, never the Keychain."""
    from .. import server_link

    return {"ok": True, "enabled": m.store.share_open_notify(),
            "cloudConnected": server_link.link_state() == server_link.STATE_CONNECTED}


async def _dispatch(m: ChannelManager, msg_type: str, p: dict) -> dict[str, Any]:
    if msg_type == "channels.list":
        return {"ok": True, **m.list()}
    if msg_type == "channels.configure":
        config = p.get("config") or {}
        secret = p.get("secret")
        if not isinstance(config, dict) or (secret is not None and not isinstance(secret, dict)):
            return {"ok": False, "error": "config and secret must be objects"}
        return await m.configure(_s(p, "platform"), config, secret or None, _account(p))
    if msg_type == "channels.quick_add":
        config = p.get("config") or {}
        secret = p.get("secret")
        if not isinstance(config, dict) or (secret is not None and not isinstance(secret, dict)):
            return {"ok": False, "error": "config and secret must be objects"}
        return await m.quick_add(_s(p, "platform"), config, secret or None, _account(p), _s(p, "link_target"))
    if msg_type == "channels.managed_create":
        return m.managed_create(_s(p, "manager_account") or DEFAULT_ACCOUNT, _s(p, "username"), _s(p, "name"))
    if msg_type == "channels.set_enabled":
        return await m.set_enabled(_s(p, "platform"), bool(p.get("enabled")), _account(p))
    if msg_type == "channels.rename_account":
        return await m.rename_account(_s(p, "platform"), _account(p), _s(p, "name"))
    if msg_type == "channels.set_global_enabled":
        return await m.set_global_enabled(bool(p.get("enabled")))
    if msg_type == "channels.remove":
        return await m.remove(_s(p, "platform"), _s(p, "account") or None)
    if msg_type == "channels.pairing.list":
        return m.pairing_list(_s(p, "platform") or None)
    if msg_type == "channels.pairing.approve":
        return await m.pairing_approve(_s(p, "platform"), _s(p, "code"))
    if msg_type == "channels.pairing.reject":
        return await m.pairing_reject(_s(p, "platform"), _s(p, "code"))
    if msg_type == "channels.link.create":
        return m.link_create(_s(p, "platform"), _s(p, "target"), _account(p))
    if msg_type == "channels.allow.list":
        return m.allow_list(_s(p, "platform") or None)
    if msg_type == "channels.allow.remove":
        return await m.allow_remove(_s(p, "platform"), _s(p, "sender_id"), _account(p))
    if msg_type == "channels.locations":
        return m.locations(_s(p, "platform"), _account(p))
    if msg_type == "channels.bind":
        return await m.bind(_s(p, "pane_id"), _s(p, "pane_name"), _s(p, "platform"), _s(p, "mode"),
                            _s(p, "chat_id"), _s(p, "thread_id"), _s(p, "title"), verbosity=_s(p, "verbosity"),
                            account=_account(p))
    if msg_type == "channels.unbind":
        return await m.unbind(_s(p, "pane_id"), reason=_s(p, "reason"), pane_name=_s(p, "pane_name"))
    if msg_type == "channels.rebind":
        return await m.rebind(_s(p, "from_pane_id"), _s(p, "to_pane_id"))
    if msg_type == "channels.set_binding_options":
        return await m.set_binding_options(_s(p, "pane_id"), _s(p, "verbosity"))
    if msg_type == "channels.bindings":
        return m.bindings()
    if msg_type == "channels.overview":
        return m.overview()
    if msg_type == "channels.unbind_many":
        pane_ids = p.get("pane_ids")
        if not isinstance(pane_ids, list) or not all(isinstance(x, str) and x for x in pane_ids):
            return {"ok": False, "error": "pane_ids must be a list of pane ids"}
        return await m.unbind_many(pane_ids)
    if msg_type == "channels.focus_pane":
        return m.focus_pane(_s(p, "pane_id"))
    if msg_type == "channels.get_share_open_notify":
        return _share_open_notify(m)
    if msg_type == "channels.share_targets":
        return m.share_targets()
    if msg_type == "channels.set_share_open_notify":
        m.store.set_share_open_notify(bool(p.get("enabled")))
        return _share_open_notify(m)
    return {"ok": False, "error": f"unknown request {msg_type}"}


MESSAGE_TYPES = (
    "channels.list", "channels.configure", "channels.quick_add", "channels.managed_create", "channels.set_enabled", "channels.rename_account",
    "channels.set_global_enabled",
    "channels.remove", "channels.pairing.list", "channels.pairing.approve", "channels.pairing.reject",
    "channels.link.create", "channels.allow.list", "channels.allow.remove", "channels.locations", "channels.bind",
    "channels.unbind", "channels.rebind", "channels.bindings", "channels.set_binding_options",
    "channels.overview", "channels.unbind_many", "channels.focus_pane",
    "channels.get_share_open_notify", "channels.set_share_open_notify", "channels.share_targets",
)


async def handle(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    manager = get_manager()
    if manager is None:
        result: dict[str, Any] = {"ok": False, "error": "chat channels are not running"}
    else:
        try:
            result = await _dispatch(manager, msg_type, payload or {})
        except ValueError as exc:
            result = {"ok": False, "error": str(exc)}
        except Exception as exc:  # noqa: BLE001 — answer instead of dropping the request
            log.exception("channels: %s failed", msg_type)
            result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    await session.send_json(make_response(msg_id, msg_type, result))
