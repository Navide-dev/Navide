"""Share-link notices in chat: who gets the created card and the opened notice, and when nobody does."""

from __future__ import annotations

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


async def test_created_goes_to_the_creating_panes_direct_chat_with_the_link(env: Env, links: FakeLinks) -> None:
    await share_cmds.notify_link_created(_created("pane-dm"))
    sent = _sent_to(env, DM)
    assert len(sent) == 1 and URL in sent[0] and "Q4 plan" in sent[0]
    assert _sent_to(env, GROUP) == []
    assert links.calls == 0  # the creator already said which pane: no list needed


async def test_a_group_never_gets_the_full_link(env: Env, links: FakeLinks) -> None:
    await share_cmds.notify_link_created(_created("pane-1"))
    sent = _sent_to(env, GROUP)
    assert len(sent) == 1
    assert "#k=" not in sent[0] and LINK_ID not in sent[0] and "share.navide.dev" not in sent[0]
    assert "Q4 plan" in sent[0] and LINK_ID[:6] in sent[0]
    assert qm.text("zh-TW", "share_group_no_link") in sent[0]
    assert _sent_to(env, DM) == []  # the pane's own chat was found: no fallback


async def test_a_chat_of_unknown_kind_is_treated_as_a_group(env: Env, links: FakeLinks) -> None:
    other = Location("telegram", "default", "-777", "", "never seen")
    env.store.bind("pane-x", other)
    await share_cmds.notify_link_created(_created("pane-x"))
    sent = _sent_to(env, other)
    assert len(sent) == 1 and "#k=" not in sent[0] and LINK_ID not in sent[0]


@pytest.mark.parametrize("pane_id", ["", "pane-unbound"])
async def test_without_the_panes_chat_only_direct_chats_get_it(env: Env, links: FakeLinks, pane_id: str) -> None:
    await share_cmds.notify_link_created(_created(pane_id))
    assert len(_sent_to(env, DM)) == 1 and URL in _sent_to(env, DM)[0]
    assert _sent_to(env, GROUP) == []


async def test_two_bindings_in_one_direct_chat_get_one_notice(env: Env, links: FakeLinks) -> None:
    env.store.bind("pane-dm2", DM)
    await share_cmds.notify_link_created(_created(""))
    assert len(_sent_to(env, DM)) == 1


# --- opened ---------------------------------------------------------------------------


async def test_opened_by_a_new_viewer_tells_the_panes_chat_without_the_link(env: Env, links: FakeLinks) -> None:
    links.rows = [_row("pane-1")]
    await share_cmds.notify_link_opened(_opened())
    sent = _sent_to(env, GROUP)
    assert len(sent) == 1
    assert "Q4 plan" in sent[0] and LINK_ID[:6] in sent[0] and "3" in sent[0]
    assert LINK_ID not in sent[0] and "#k=" not in sent[0] and "share.navide.dev" not in sent[0]
    assert _sent_to(env, DM) == []


async def test_opened_falls_back_to_direct_chats(env: Env, links: FakeLinks) -> None:
    links.rows = [_row("")]
    await share_cmds.notify_link_opened(_opened())
    assert len(_sent_to(env, DM)) == 1 and LINK_ID not in _sent_to(env, DM)[0]
    assert _sent_to(env, GROUP) == []


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
    await share_cmds.notify_link_created(_created("pane-1"))
    assert qm.text("en-US", "share_group_no_link") in _sent_to(env, GROUP)[0]


# --- the switch over ws ----------------------------------------------------------------


async def test_the_switch_over_ws(env: Env) -> None:
    assert "channels.get_share_open_notify" in ws_api.MESSAGE_TYPES
    assert "channels.set_share_open_notify" in ws_api.MESSAGE_TYPES
    assert await ws_api._dispatch(env.m, "channels.get_share_open_notify", {}) == {"ok": True, "enabled": True}
    assert await ws_api._dispatch(env.m, "channels.set_share_open_notify", {"enabled": False}) == {
        "ok": True, "enabled": False}
    assert env.store.share_open_notify() is False
    assert await ws_api._dispatch(env.m, "channels.get_share_open_notify", {}) == {"ok": True, "enabled": False}
