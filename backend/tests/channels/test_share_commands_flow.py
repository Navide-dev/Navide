"""/shares and /revoke end to end through the manager, and the Cloud-off pass-through."""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import server_link, share_links, sync_keyring
from agent_team_backend.channels import quick_menu as qm
from agent_team_backend.channels import share_cmds
from agent_team_backend.channels.base import Capabilities, Location
from agent_team_backend.channels.manager import MSG_NOT_BOUND

from .test_manager import Env, env, fast_timers  # noqa: F401 — pytest fixtures

SECRET_URL = "https://share.navide.dev/s/"


def _link(link_id: str, title: str, *, active: bool = True, created: str = "2026-10-01T00:00:00Z",
          opens: int = 0, kind: str = "plan") -> dict[str, Any]:
    return {"linkId": link_id, "kind": kind, "title": title, "createdBy": "user", "pane": "api",
            "active": active, "expiresAt": "2026-10-18T09:30:00Z", "revokedAt": "",
            "openCount": opens, "lastOpenedAt": "", "createdAt": created}


class FakeShares:
    def __init__(self) -> None:
        self.links: list[dict[str, Any]] = []
        self.revoked: list[str] = []
        self.list_error: Exception | None = None
        self.revoke_error: Exception | None = None
        self.copied: list[str] = []

    async def list_links(self, client: Any) -> list[dict[str, Any]]:
        if self.list_error is not None:
            raise self.list_error
        return [dict(link) for link in self.links]

    async def revoke(self, client: Any, link_id: str) -> dict[str, Any]:
        if self.revoke_error is not None:
            raise self.revoke_error
        self.revoked.append(link_id)
        return {"linkId": link_id}

    async def copy_link(self, client: Any, link_id: str) -> str:
        self.copied.append(link_id)
        return SECRET_URL + link_id + "#k=SECRET"


@pytest.fixture
def shares(monkeypatch) -> FakeShares:
    fake = FakeShares()
    monkeypatch.setattr(share_links, "list_links", fake.list_links)
    monkeypatch.setattr(share_links, "revoke", fake.revoke)
    monkeypatch.setattr(share_links, "copy_link", fake.copy_link)
    monkeypatch.setattr(server_link, "link_state", lambda: server_link.STATE_CONNECTED)
    return fake


def _all_text(env: Env) -> str:
    menus = [body + str(rows) for _, body, rows in env.tg.menus]
    return "\n".join(env.tg.texts() + menus)


def _buttons(env: Env) -> list[tuple[str, str]]:
    return [b for row in env.tg.menus[-1][2] for b in row]


# --- Cloud off: exactly what main does --------------------------------------------


@pytest.mark.parametrize("state", [server_link.STATE_UNCONFIGURED, server_link.STATE_UNREACHABLE,
                                   server_link.STATE_CONNECTING])
async def test_cloud_off_shares_goes_to_the_pane_as_on_main(env: Env, monkeypatch, state: str) -> None:
    fake = FakeShares()
    fake.links = [_link("abcdef0123456789abcdef", "Plan A")]
    monkeypatch.setattr(share_links, "list_links", fake.list_links)
    monkeypatch.setattr(share_links, "revoke", fake.revoke)
    monkeypatch.setattr(server_link, "link_state", lambda: state)
    await env.inbound("/shares")
    await env.inbound("/revoke abcdef")
    assert [d[:2] for d in env.fake.delivered] == [("pane-1", "/shares"), ("pane-1", "/revoke abcdef")]
    assert env.tg.menus == [] and fake.revoked == []
    assert not any("Plan A" in t for t in env.tg.texts())


async def test_cloud_off_by_default_in_tests(env: Env) -> None:
    # No account link at all (server_link._link is None): unconfigured, so a pass-through.
    assert server_link.link_state() != server_link.STATE_CONNECTED
    await env.inbound("/shares")
    assert env.fake.delivered[-1][:2] == ("pane-1", "/shares") and env.tg.menus == []


async def test_cloud_off_revoke_button_is_dropped_as_on_main(env: Env, monkeypatch) -> None:
    monkeypatch.setattr(server_link, "link_state", lambda: server_link.STATE_UNREACHABLE)
    await env.inbound("", callback=share_cmds.CALLBACK_PREFIX + "r:abcdefgh")
    assert env.tg.sent == [] and env.fake.delivered == []


@pytest.mark.parametrize("code", sorted(share_links.UNAVAILABLE_CODES))
async def test_a_server_without_share_links_passes_both_through(env: Env, shares: FakeShares, code: str) -> None:
    shares.list_error = share_links.ShareRemoteError(code, "no links here")
    await env.inbound("/shares")
    await env.inbound("/revoke abcdef")
    assert [d[1] for d in env.fake.delivered] == ["/shares", "/revoke abcdef"]
    assert env.tg.sent == [] and env.tg.menus == []


async def test_an_unbound_chat_keeps_the_current_rules(env: Env, shares: FakeShares) -> None:
    shares.links = [_link("abcdef0123456789abcdef", "Plan A")]
    await env.inbound("/shares", thread="99")
    assert env.tg.texts()[-1] == MSG_NOT_BOUND
    assert env.tg.menus == [] and env.fake.delivered == []


# --- /shares -------------------------------------------------------------------------


async def test_shares_lists_the_ten_newest_active_links_with_revoke_buttons(env: Env, shares: FakeShares) -> None:
    shares.links = [_link(f"id{i:02d}xxxxxxxxxxxxxxxxxxxx", f"Plan {i}", created=f"2026-10-{i + 1:02d}T00:00:00Z",
                          opens=i) for i in range(12)]
    shares.links.append(_link("deadbeefxxxxxxxxxxxxxxxx", "Revoked one", active=False,
                              created="2026-10-30T00:00:00Z"))
    await env.inbound("/shares")
    _loc, body, rows = env.tg.menus[-1]
    assert "Revoked one" not in body
    assert "Plan 11" in body and "Plan 2" in body and "Plan 1 " not in body and "Plan 0" not in body
    assert body.index("Plan 11") < body.index("Plan 2")
    assert "id11xx" in body and "plan" in body and "11" in body
    labels = [label for label, _ in _buttons(env)]
    assert len(labels) == 10 and all("id" in label for label in labels)
    assert all(data.startswith(share_cmds.CALLBACK_PREFIX) for _, data in _buttons(env))
    assert all(len(data.encode()) <= 64 for _, data in _buttons(env))
    assert env.fake.delivered == []


async def test_shares_never_carries_a_url_or_key(env: Env, shares: FakeShares) -> None:
    shares.links = [_link("abcdef0123456789abcdef", "Plan A")]
    await env.inbound("/shares")
    await env.inbound("", callback=_buttons(env)[0][1])
    await env.inbound("/revoke abcdef")
    assert shares.copied == []
    assert SECRET_URL not in _all_text(env) and "#k=" not in _all_text(env)
    assert "abcdef0123456789abcdef" not in _all_text(env)  # only the 6-char prefix is shown


async def test_shares_with_none_active_says_so(env: Env, shares: FakeShares) -> None:
    shares.links = [_link("abcdef0123456789abcdef", "Gone", active=False)]
    await env.inbound("/shares")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "shares_empty")
    assert env.tg.menus == [] and env.fake.delivered == []


async def test_shares_on_a_buttonless_platform_is_text_only(env: Env, shares: FakeShares) -> None:
    shares.links = [_link("abcdef0123456789abcdef", "Plan A")]
    env.tg.capabilities = Capabilities(threads=True, create_location=True, edit=True, typing=True,
                                       buttons=False, text_limit=4000)
    await env.inbound("/shares")
    assert env.tg.menus == [] and "Plan A" in env.tg.texts()[-1] and "abcdef" in env.tg.texts()[-1]


async def test_shares_failure_is_told_not_forwarded(env: Env, shares: FakeShares) -> None:
    shares.list_error = sync_keyring.KeyringError("ring locked")
    await env.inbound("/shares")
    assert "ring locked" in env.tg.texts()[-1] and env.fake.delivered == []


async def test_shares_addressed_to_another_bot_is_not_ours(env: Env, shares: FakeShares) -> None:
    env.tg.status.identity = "navide_bot"
    await env.inbound("/shares@other_bot")
    assert env.fake.delivered[-1][1] == "/shares@other_bot" and env.tg.menus == []
    await env.inbound("/shares@navide_bot")
    assert len(env.fake.delivered) == 1


async def test_the_users_language_is_used(env: Env, shares: FakeShares) -> None:
    env.fake.settings = {"agent-team:language": "en-US"}
    await env.inbound("/shares")
    assert env.tg.texts()[-1] == qm.text("en-US", "shares_empty")


# --- /revoke and the button ----------------------------------------------------------


async def test_revoke_a_unique_prefix(env: Env, shares: FakeShares) -> None:
    shares.links = [_link("abcdef0123456789abcdef", "Plan A"), _link("zzzzzz0123456789abcdef", "Plan Z")]
    await env.inbound("/revoke abcdef")
    assert shares.revoked == ["abcdef0123456789abcdef"]
    assert env.tg.texts()[-1] == qm.text("zh-TW", "revoked", title="Plan A", short="abcdef")
    assert env.fake.delivered == []


async def test_revoke_matching_none_or_several_revokes_nothing(env: Env, shares: FakeShares) -> None:
    shares.links = [_link("abcdef0123456789abcdef", "A1"), _link("abcdef9999999999999999", "A2"),
                    _link("qqqqqq0123456789abcdef", "Old", active=False)]
    await env.inbound("/revoke abcdef")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "revoke_ambiguous", prefix="abcdef", count=2)
    await env.inbound("/revoke qqqqqq")  # only an inactive link has it
    assert env.tg.texts()[-1] == qm.text("zh-TW", "revoke_none", prefix="qqqqqq")
    await env.inbound("/revoke nothin")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "revoke_none", prefix="nothin")
    assert shares.revoked == [] and env.fake.delivered == []


async def test_revoke_without_six_characters_shows_usage(env: Env, shares: FakeShares) -> None:
    shares.links = [_link("abcdef0123456789abcdef", "A1")]
    for text in ("/revoke", "/revoke abc", "/revoke abcdef extra"):
        await env.inbound(text)
        assert env.tg.texts()[-1] == qm.text("zh-TW", "revoke_usage")
    assert shares.revoked == [] and env.fake.delivered == []


async def test_revoke_failure_is_told(env: Env, shares: FakeShares) -> None:
    shares.links = [_link("abcdef0123456789abcdef", "A1")]
    shares.revoke_error = share_links.ShareRemoteError("LINK_INACTIVE", "already revoked")
    await env.inbound("/revoke abcdef")
    assert "already revoked" in env.tg.texts()[-1] and env.fake.delivered == []


async def test_the_revoke_button_revokes_that_link(env: Env, shares: FakeShares) -> None:
    shares.links = [_link("abcdef0123456789abcdef", "Plan A"), _link("zzzzzz0123456789abcdef", "Plan Z",
                                                                    created="2026-10-02T00:00:00Z")]
    await env.inbound("/shares")
    data = next(d for label, d in _buttons(env) if "abcdef" in label)
    await env.inbound("", callback=data)
    assert shares.revoked == ["abcdef0123456789abcdef"]
    assert env.tg.texts()[-1] == qm.text("zh-TW", "revoked", title="Plan A", short="abcdef")


async def test_an_unknown_or_foreign_revoke_button_is_expired(env: Env, shares: FakeShares) -> None:
    shares.links = [_link("abcdef0123456789abcdef", "Plan A")]
    await env.inbound("/shares")
    data = _buttons(env)[0][1]
    await env.inbound("", callback=share_cmds.CALLBACK_PREFIX + "r:zzzzzzzz")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "shares_expired")
    env.store.bind("pane-2", Location("telegram", "default", "-100", "60", "web"))
    await env.inbound("", callback=data, thread="60")  # another topic's chat
    assert env.tg.texts()[-1] == qm.text("zh-TW", "shares_expired")
    assert shares.revoked == []


def test_every_language_has_every_share_string() -> None:
    keys = set(qm.STRINGS["zh-TW"])
    assert all(set(table) == keys for table in qm.STRINGS.values())
    assert {"shares_title", "shares_empty", "shares_failed", "revoke_button", "revoked", "revoke_none",
            "revoke_ambiguous", "revoke_usage", "shares_expired"} <= keys


async def test_revoke_never_echoes_more_than_six_characters(env: Env, shares: FakeShares) -> None:
    full = "abcdef0123456789abcdef"
    shares.links = [_link("zzzzzz0123456789abcdef", "Other")]
    await env.inbound(f"/revoke {full}")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "revoke_none", prefix="abcdef")
    shares.links = [_link(full + "1", "A1"), _link(full + "2", "A2")]
    await env.inbound(f"/revoke {full}")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "revoke_ambiguous", prefix="abcdef", count=2)
    assert not any(full in t for t in env.tg.texts()) and shares.revoked == []
