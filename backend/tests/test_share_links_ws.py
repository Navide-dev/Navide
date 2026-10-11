"""share.* WebSocket handlers over a fake links.* server.

What the UI is promised: the creator gets the URL once, broadcasts carry no
URL, the list carries titles but no keys, and a server without share links
answers with its own code (UNKNOWN_TYPE / NOT_CONFIGURED) so the UI can hide
the feature.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app, share_links, sync_keyring, ws_handlers

from .test_share_links import FakeLinks, _plan

GHP = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"


class FakeSession:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)

    @property
    def reply(self) -> dict[str, Any]:
        assert len(self.sent) == 1, self.sent
        return self.sent[0]


@pytest.fixture
def ring():
    sync_keyring.ensure_account_key()
    yield
    sync_keyring.forget_account_key()


@pytest.fixture
def home(tmp_path: Path, set_home, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "data"))
    (tmp_path / "home").mkdir()
    return set_home(tmp_path / "home")


@pytest.fixture
def server(monkeypatch: pytest.MonkeyPatch) -> FakeLinks:
    fake = FakeLinks()

    async def links_request(verb: str, payload: dict) -> dict:
        try:
            return {"ok": True, "payload": await fake.request(verb, payload)}
        except share_links.ShareRemoteError as err:
            return {"ok": False, "error": {"code": err.code, "message": str(err)}}

    monkeypatch.setattr(ws_handlers.server_link, "links_request", links_request)
    monkeypatch.setattr(ws_handlers.server_link, "link_state", lambda: ws_handlers.server_link.STATE_CONNECTED)
    monkeypatch.setattr(share_links, "_http_put", fake.put)
    monkeypatch.setattr(share_links, "_http_get", fake.get)
    return fake


@pytest.fixture
def broadcasts(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    sent: list[dict[str, Any]] = []

    async def broadcast(event: dict[str, Any]) -> None:
        sent.append(event)

    monkeypatch.setattr(app, "broadcast", broadcast)
    return sent


async def test_create_returns_the_url_once_and_announces_without_it(ring, home, server, broadcasts) -> None:
    session = FakeSession()
    path = _plan(home, f"<p>{GHP}</p>")
    await ws_handlers.share_create(session, "1", "share.create", {"path": str(path)})

    reply = session.reply
    assert reply["ok"], reply
    body = reply["payload"]
    assert body["url"].startswith("https://share.navide.dev/s/" + body["linkId"] + "#k=")
    assert body["masked"] == [{"line": 2, "category": "github-token", "action": "masked"}]
    [event] = broadcasts
    assert event["type"] == "share.created"
    assert "#k=" not in json.dumps(event) and event["payload"]["linkId"] == body["linkId"]


async def test_list_has_titles_and_no_keys(ring, home, server, broadcasts) -> None:
    await ws_handlers.share_create(FakeSession(), "1", "share.create", {"path": str(_plan(home, "<p/>"))})
    session = FakeSession()
    await ws_handlers.share_list(session, "2", "share.list", {})
    [row] = session.reply["payload"]["links"]
    assert row["title"] == "Secret Roadmap"
    assert "#k=" not in json.dumps(session.reply)


async def test_copy_link_gives_back_the_creators_url(ring, home, server, broadcasts) -> None:
    created = FakeSession()
    await ws_handlers.share_create(created, "1", "share.create", {"path": str(_plan(home, "<p/>"))})
    session = FakeSession()
    link_id = created.reply["payload"]["linkId"]
    await ws_handlers.share_copy_link(session, "2", "share.copy_link", {"linkId": link_id})
    assert session.reply["payload"]["url"] == created.reply["payload"]["url"]


async def test_a_refused_path_says_why(ring, home, server, broadcasts) -> None:
    key_file = home / ".ssh" / "id_ed25519"
    key_file.parent.mkdir()
    key_file.write_text("x")
    session = FakeSession()
    await ws_handlers.share_create(session, "1", "share.create", {"path": str(key_file)})
    error = session.reply["error"]
    assert error["code"] == "SHARE_REFUSED" and error["details"]["reason"] == "denied_name"
    assert server.calls == [] and broadcasts == []


@pytest.mark.parametrize(
    ("reply", "code"),
    [(None, "NOT_CONFIGURED"), ({"ok": False, "error": {"code": "UNKNOWN_TYPE", "message": "x"}}, "UNKNOWN_TYPE")],
)
async def test_a_server_without_share_links_answers_with_its_code(monkeypatch, reply, code) -> None:
    async def links_request(verb: str, payload: dict) -> dict | None:
        return reply

    monkeypatch.setattr(ws_handlers.server_link, "links_request", links_request)
    monkeypatch.setattr(ws_handlers.server_link, "link_state", lambda: ws_handlers.server_link.STATE_CONNECTED)
    session = FakeSession()
    await ws_handlers.share_list(session, "1", "share.list", {})
    assert session.reply["error"]["code"] == code


async def test_extend_needs_seconds(server) -> None:
    session = FakeSession()
    await ws_handlers.share_extend(session, "1", "share.extend", {"linkId": "ab" * 16, "ttlSeconds": "7d"})
    assert session.reply["error"]["code"] == "BAD_REQUEST"


@pytest.fixture
def chat(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    from agent_team_backend.channels import share_cmds

    sent: list[dict[str, Any]] = []

    async def notify_link_created(link: dict[str, Any]) -> None:
        sent.append(link)

    monkeypatch.setattr(share_cmds, "notify_link_created", notify_link_created, raising=False)
    return sent


@pytest.mark.parametrize("send_to_chat", [True, False])
async def test_the_link_goes_to_chat_only_when_asked(ring, home, server, broadcasts, chat, send_to_chat) -> None:
    session = FakeSession()
    payload = {"path": str(_plan(home, "<p/>")), "sendToChat": send_to_chat}
    await ws_handlers.share_create(session, "1", "share.create", payload)
    assert session.reply["ok"]
    if send_to_chat:
        [link] = chat
        assert link["url"] == session.reply["payload"]["url"] and link["paneId"] == ""
        assert link["title"] == "Secret Roadmap"
    else:
        assert chat == []


async def test_an_open_notice_is_handed_to_channels(monkeypatch, broadcasts) -> None:
    from agent_team_backend import server_link
    from agent_team_backend.channels import share_cmds

    opened: list[dict[str, Any]] = []

    async def notify_link_opened(event: dict[str, Any]) -> None:
        opened.append(event)

    monkeypatch.setattr(share_cmds, "notify_link_opened", notify_link_opened, raising=False)
    event = {"linkId": "ab" * 16, "openCount": 2, "openedAt": "2026-10-11T10:00:00Z", "newViewer": True}
    await server_link.ServerLink._on_link_opened(None, event)  # type: ignore[arg-type]
    assert opened == [event]
    assert broadcasts[0]["type"] == "share.opened"



# ---- review round 5/6 ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("state", "code"),
    [("unconfigured", "NOT_CONFIGURED"), ("unreachable", "LINK_OFFLINE"), ("connecting", "LINK_OFFLINE")],
)
async def test_without_a_live_link_nothing_reaches_the_ring_or_the_server(monkeypatch, home, state, code) -> None:
    """W-F1: the link is checked before the account key is touched."""
    monkeypatch.setattr(ws_handlers.server_link, "link_state", lambda: state)

    def no_ring() -> Any:
        raise AssertionError("the account key was read without a live link")

    async def no_server(*_a: Any, **_k: Any) -> Any:
        raise AssertionError("the server was asked without a live link")

    monkeypatch.setattr(sync_keyring, "account_key", no_ring)
    monkeypatch.setattr(ws_handlers.server_link, "links_request", no_server)
    session = FakeSession()
    await ws_handlers.share_create(session, "1", "share.create", {"path": str(_plan(home, "<p/>"))})
    assert session.reply["error"]["code"] == code


async def test_a_failed_announcement_still_hands_back_the_url(ring, home, server, monkeypatch) -> None:
    """W-F3: the server has committed the link; the creator must get its URL."""

    async def broken(event: dict[str, Any]) -> None:
        raise RuntimeError("no window")

    monkeypatch.setattr(app, "broadcast", broken)
    session = FakeSession()
    await ws_handlers.share_create(session, "1", "share.create", {"path": str(_plan(home, "<p/>"))})
    assert session.reply["ok"] and session.reply["payload"]["url"].startswith("https://share.navide.dev/s/")


async def test_the_chosen_chat_goes_with_the_link(ring, home, server, broadcasts, chat) -> None:
    """R6-F2: the dialog names one bound private chat; that id travels to Channels."""
    session = FakeSession()
    payload = {"path": str(_plan(home, "<p/>")), "sendToChat": True, "chatId": "tg:42"}
    await ws_handlers.share_create(session, "1", "share.create", payload)
    [link] = chat
    assert link["chatId"] == "tg:42"


@pytest.mark.parametrize(
    "payload",
    [
        {"linkId": "x/../evil", "openCount": 1},
        {"linkId": "ab" * 16, "openCount": True, "openedAt": 5},
    ],
)
async def test_an_open_push_is_checked_before_anyone_hears_of_it(monkeypatch, broadcasts, payload) -> None:
    """W-F2."""
    from agent_team_backend import server_link
    from agent_team_backend.channels import share_cmds

    opened: list[dict[str, Any]] = []

    async def notify_link_opened(event: dict[str, Any]) -> None:
        opened.append(event)

    monkeypatch.setattr(share_cmds, "notify_link_opened", notify_link_opened, raising=False)
    await server_link.ServerLink._on_link_opened(None, payload)  # type: ignore[arg-type]
    if payload["linkId"] == "x/../evil":
        assert broadcasts == [] and opened == []
    else:
        [event] = opened
        assert event["openCount"] is None and event["openedAt"] is None
