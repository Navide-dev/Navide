"""Share-link notices in chat: who gets the created card and the opened notice, and when nobody does."""

from __future__ import annotations

import logging
import time
from typing import Any

import pytest

from agent_team_backend import channels as channels_pkg
from agent_team_backend import server_link, share_links
from agent_team_backend.channels import manager as mgr_mod
from agent_team_backend.channels import quick_menu as qm
from agent_team_backend.channels import share_cmds, ws_api
from agent_team_backend.channels.base import Location

from .test_manager import Env, env, fast_timers  # noqa: F401 — pytest fixtures

LINK_ID = "Ab3dEfGhIjKlMnOpQrStUv"
URL = f"https://share.navide.dev/s/{LINK_ID}#k=q8Zt0xYvW3rL9mN2pB5cD7eF1gH4jK6lS8uV0wX2yZ4"
ME = "dev-me"

DM = Location("telegram", "default", "555", "", "alice")
GROUP = Location("telegram", "default", "-100", "50", "api")  # the fixture's pane-1 binding


class FakeLinks:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []
        self.calls = 0
        self.error: Exception | None = None

    async def list_links(self, client: Any) -> list[dict[str, Any]]:
        self.calls += 1
        if self.error is not None:
            raise self.error
        return [dict(r) for r in self.rows]


def _row(pane_id: str = "pane-dm", device: str = ME, link_id: str = LINK_ID) -> dict[str, Any]:
    return {"linkId": link_id, "kind": "plan", "title": "Q4 plan", "paneId": pane_id, "deviceId": device,
            "active": True, "openCount": 3, "expiresAt": "2026-10-18T09:30:00Z"}


def _created(pane_id: str = "pane-dm") -> dict[str, Any]:
    return {"linkId": LINK_ID, "url": URL, "title": "Q4 plan", "kind": "plan",
            "expiresAt": "2026-10-18T09:30:00Z", "paneId": pane_id, "createdBy": "agent", "maskedTotal": 2}


def _opened(new_viewer: bool = True) -> dict[str, Any]:
    return {"linkId": LINK_ID, "openCount": 3, "openedAt": "2026-10-11T10:00:00Z", "newViewer": new_viewer}


@pytest.fixture
def links(env: Env, monkeypatch) -> FakeLinks:
    fake = FakeLinks()
    fake.rows = [_row()]
    monkeypatch.setattr(share_links, "list_links", fake.list_links)
    monkeypatch.setattr(server_link, "link_state", lambda: server_link.STATE_CONNECTED)
    monkeypatch.setattr(server_link, "local_device_id", lambda: ME)
    monkeypatch.setattr(channels_pkg, "get_manager", lambda: env.m)
    bot = mgr_mod._bot_key(env.tg)
    now = int(time.time())
    env.store.remember_chat("telegram", bot, "-100", "-100", "group", True, now)
    env.store.remember_chat("telegram", bot, "555", "alice", "direct", False, now)
    env.store.bind("pane-dm", DM)
    return fake


def _sent_to(env: Env, loc: Location) -> list[str]:
    return [t for where, t in env.tg.sent if (where.chat_id, where.thread_id) == (loc.chat_id, loc.thread_id)]


# --- created --------------------------------------------------------------------------


def _created_in(chat: Location | None, pane_id: str = "") -> dict[str, Any]:
    return {**_created(pane_id), "chatId": chat.key() if chat is not None else ""}


async def test_created_goes_to_the_chat_the_creator_picked(env: Env, links: FakeLinks) -> None:
    other = Location("telegram", "default", "556", "", "alice 2")
    env.store.remember_chat("telegram", mgr_mod._bot_key(env.tg), "556", "alice 2", "direct", False, 1)
    env.store.bind("pane-dm2", other)
    await share_cmds.notify_link_created(_created_in(other, pane_id="pane-dm"))
    assert len(_sent_to(env, other)) == 1 and URL in _sent_to(env, other)[0]
    assert _sent_to(env, DM) == []  # the picked chat wins over the pane's own
    assert links.calls == 0


@pytest.mark.parametrize("picked", [GROUP, Location("telegram", "default", "999", "", "nobody")])
async def test_a_picked_chat_that_is_not_a_bound_direct_chat_gets_nothing(
        env: Env, links: FakeLinks, caplog, picked: Location) -> None:
    caplog.set_level(logging.INFO)
    env.store.remember_chat("telegram", mgr_mod._bot_key(env.tg), "999", "nobody", "direct", False, 1)
    await share_cmds.notify_link_created(_created_in(picked, pane_id="pane-dm"))
    assert env.tg.sent == []
    logged = "\n".join(r.getMessage() for r in caplog.records)
    assert LINK_ID[:6] in logged and LINK_ID not in logged and "#k=" not in logged


async def test_without_a_pick_the_creating_panes_direct_chat_gets_the_link(env: Env, links: FakeLinks) -> None:
    await share_cmds.notify_link_created(_created("pane-dm"))
    sent = _sent_to(env, DM)
    assert len(sent) == 1 and URL in sent[0] and "Q4 plan" in sent[0]
    assert _sent_to(env, GROUP) == []
    assert links.calls == 0


@pytest.mark.parametrize("pane_id", ["pane-1", "pane-x", "", "pane-unbound"])
async def test_no_direct_chat_for_the_pane_means_no_notice(env: Env, links: FakeLinks, pane_id: str) -> None:
    env.store.bind("pane-x", Location("telegram", "default", "-777", "", "never seen"))  # kind unknown
    await share_cmds.notify_link_created(_created(pane_id))
    assert env.tg.sent == []


async def test_other_peoples_direct_chats_never_get_a_link(env: Env, links: FakeLinks) -> None:
    bot = mgr_mod._bot_key(env.tg)
    env.store.remember_chat("telegram", bot, "666", "bob", "direct", False, 1)
    env.store.bind("pane-b", Location("telegram", "default", "666", "", "bob"))
    await share_cmds.notify_link_created(_created(""))  # Plan view without a pick, or no pane
    assert env.tg.sent == []


# --- opened ---------------------------------------------------------------------------


async def test_opened_by_a_new_viewer_tells_the_panes_direct_chat_without_the_link(
        env: Env, links: FakeLinks) -> None:
    await share_cmds.notify_link_opened(_opened())
    sent = _sent_to(env, DM)
    assert len(sent) == 1
    assert "Q4 plan" in sent[0] and LINK_ID[:6] in sent[0] and "3" in sent[0]
    assert LINK_ID not in sent[0] and "#k=" not in sent[0] and "share.navide.dev" not in sent[0]


@pytest.mark.parametrize("pane_id", ["pane-1", "", "pane-unbound"])
async def test_opened_without_the_panes_direct_chat_tells_nobody(env: Env, links: FakeLinks, pane_id: str) -> None:
    links.rows = [_row(pane_id)]
    await share_cmds.notify_link_opened(_opened())
    assert env.tg.sent == []


async def test_opened_on_another_device_is_not_ours_to_tell(env: Env, links: FakeLinks) -> None:
    links.rows = [_row("pane-dm", device="dev-other")]
    await share_cmds.notify_link_opened(_opened())
    assert env.tg.sent == []


async def test_opened_before_this_machine_has_a_device_id_sends_nothing(env: Env, links: FakeLinks,
                                                                        monkeypatch) -> None:
    monkeypatch.setattr(server_link, "local_device_id", lambda: "")
    links.rows = [_row("pane-dm", device="")]
    await share_cmds.notify_link_opened(_opened())
    assert env.tg.sent == []


async def test_a_returning_viewer_is_not_announced(env: Env, links: FakeLinks) -> None:
    await share_cmds.notify_link_opened(_opened(new_viewer=False))
    assert env.tg.sent == [] and links.calls == 0


async def test_the_switch_turns_opened_notices_off(env: Env, links: FakeLinks) -> None:
    assert env.store.share_open_notify() is True  # on by default
    env.store.set_share_open_notify(False)
    await share_cmds.notify_link_opened(_opened())
    assert env.tg.sent == [] and links.calls == 0
    env.store.set_share_open_notify(True)
    await share_cmds.notify_link_opened(_opened())
    assert len(_sent_to(env, DM)) == 1


async def test_an_unknown_link_or_a_failing_list_sends_nothing(env: Env, links: FakeLinks) -> None:
    links.rows = [_row(link_id="Zz" * 11)]
    await share_cmds.notify_link_opened(_opened())
    links.error = share_links.ShareRemoteError("NOT_FOUND", "gone")
    await share_cmds.notify_link_opened(_opened())
    assert env.tg.sent == []


# --- nobody home ---------------------------------------------------------------------


@pytest.mark.parametrize("state", [server_link.STATE_UNCONFIGURED, server_link.STATE_UNREACHABLE,
                                   server_link.STATE_CONNECTING])
async def test_cloud_off_sends_nothing_and_lists_nothing(env: Env, links: FakeLinks, monkeypatch, state: str) -> None:
    monkeypatch.setattr(server_link, "link_state", lambda: state)
    await share_cmds.notify_link_created(_created("pane-dm"))
    await share_cmds.notify_link_opened(_opened())
    assert env.tg.sent == [] and links.calls == 0


async def test_channels_off_or_not_running_sends_nothing(env: Env, links: FakeLinks, monkeypatch) -> None:
    await env.m.set_global_enabled(False)
    await share_cmds.notify_link_created(_created("pane-dm"))
    await share_cmds.notify_link_opened(_opened())
    assert env.tg.sent == [] and links.calls == 0
    monkeypatch.setattr(channels_pkg, "get_manager", lambda: None)
    await share_cmds.notify_link_created(_created("pane-dm"))
    await share_cmds.notify_link_opened(_opened())
    assert links.calls == 0


async def test_the_users_language_is_used(env: Env, links: FakeLinks) -> None:
    env.fake.settings = {"agent-team:language": "en-US"}
    await share_cmds.notify_link_created(_created("pane-dm"))
    assert "Share link created" in _sent_to(env, DM)[0]


# --- the switch over ws ----------------------------------------------------------------


async def test_the_switch_over_ws(env: Env) -> None:
    assert "channels.get_share_open_notify" in ws_api.MESSAGE_TYPES
    assert "channels.set_share_open_notify" in ws_api.MESSAGE_TYPES
    assert await ws_api._dispatch(env.m, "channels.get_share_open_notify", {}) == {"ok": True, "enabled": True}
    assert await ws_api._dispatch(env.m, "channels.set_share_open_notify", {"enabled": False}) == {
        "ok": True, "enabled": False}
    assert env.store.share_open_notify() is False
    assert await ws_api._dispatch(env.m, "channels.get_share_open_notify", {}) == {"ok": True, "enabled": False}
