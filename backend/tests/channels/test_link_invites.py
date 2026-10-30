"""One-click linking: invite codes whose sender is linked once the user approves them in Navide."""

from __future__ import annotations

import sqlite3

import pytest

from agent_team_backend.channels import pairing
from agent_team_backend.channels.base import Location
from agent_team_backend.channels.base import InboundMessage
from agent_team_backend.channels.manager import MSG_LINK_DM_ONLY, MSG_LINK_FAILED, MSG_LINK_PENDING, MSG_LINKED
from agent_team_backend.channels.pairing import CODE_ALPHABET, LinkInvites, parse_link_code
from agent_team_backend.channels.telegram import TelegramAdapter

from .test_manager import Env, env, fast_timers  # noqa: F401 — pytest fixtures


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


async def _redeem_and_approve(env: Env, text: str, **kw) -> str:
    """Send an invite code as a stranger, check it waits for approval, approve it; the pairing code."""
    await env.inbound(text, **kw)
    sender = kw["sender"]
    assert not env.store.is_allowed(kw.get("platform", "telegram"), sender)
    req = next(r for r in env.store.list_pairing(kw.get("platform", "telegram")) if r.sender_id == sender)
    assert not any(e == "channels.linked" for e, _ in env.fake.events)
    assert (await env.m.pairing_approve(kw.get("platform", "telegram"), req.code))["ok"]
    return req.code


def test_invite_code_format_expiry_and_single_use() -> None:
    clock = Clock()
    invites = LinkInvites(now=clock)
    inv = invites.create("telegram", "direct")
    assert len(inv.code) == 8 and set(inv.code) <= set(CODE_ALPHABET)
    assert inv.expires_at == 1000.0 + 600
    assert invites.consume("discord", inv.code) is None  # scoped to its platform
    assert invites.consume("telegram", inv.code.lower()) == inv  # case-insensitive
    assert invites.consume("telegram", inv.code) is None  # single use
    late = invites.create("telegram", "direct")
    clock.t += 601
    assert invites.consume("telegram", late.code) is None


def test_at_most_five_live_invites_per_platform_oldest_dropped() -> None:
    invites = LinkInvites()
    made = [invites.create("slack", "direct") for _ in range(6)]
    assert invites.consume("slack", made[0].code) is None
    assert all(invites.consume("slack", i.code) for i in made[1:])


@pytest.mark.parametrize("text,code", [
    ("/start ABCD2345", "ABCD2345"),
    ("/start@navide_bot abcd2345", "ABCD2345"),
    ("link ABCD-2345", "ABCD2345"),
    ("abcd2345", "ABCD2345"),
    ("<@U0123> link ABCD2345", "ABCD2345"),
    ("@navide link ABCD2345", "ABCD2345"),
    ("Navide Bot: link ABCD2345", "ABCD2345"),
    ("link ABCD2345 <@U0123>", "ABCD2345"),
    ("/start", ""),
    ("link to the docs", ""),
    ("please run ABCD2345 now", ""),
])
def test_parse_link_code(text: str, code: str) -> None:
    assert parse_link_code(text) == code


def test_telegram_link_url_uses_the_bot_username() -> None:
    ad = TelegramAdapter("123:secret")
    assert ad.link_url("ABCD2345", "direct") == ""  # identity unknown until getMe
    ad.status.identity = "@navide_bot"
    assert ad.link_url("ABCD2345", "direct") == "https://t.me/navide_bot?start=ABCD2345"
    assert ad.link_url("ABCD2345", "group") == "https://t.me/navide_bot?startgroup=ABCD2345"


async def test_link_create_answers_code_and_url(env: Env) -> None:
    env.tg.link_url = lambda code, target: f"https://t.me/bot?{target}={code}"
    res = env.m.link_create("telegram", "group")
    assert res["ok"] and res["url"] == f"https://t.me/bot?group={res['code']}"
    assert res["expires_at"] > 0
    assert "instructions" not in res  # the UI builds its own, localized
    assert env.m.link_create("telegram", "sideways")["ok"] is False
    assert env.m.link_create("discord", "direct") == {"ok": False, "error": "discord is not connected"}
    with pytest.raises(ValueError):
        env.m.link_create("myspace", "direct")


async def test_start_code_from_a_stranger_links_their_dm(env: Env) -> None:
    code = env.m.link_create("telegram", "direct")["code"]
    await env.inbound(f"/start {code}", sender="99", chat="99", thread="", direct=True)
    # The code alone admits no one: it asks for the same approval a pairing code does.
    assert not env.store.is_allowed("telegram", "99")
    [req] = env.store.list_pairing("telegram")
    assert (req.sender_id, req.chat_id) == ("99", "99")
    assert env.tg.texts()[-1] == MSG_LINK_PENDING.format(code=f"{req.code[:4]}-{req.code[4:]}")
    assert ("channels.pairing_request", {"platform": "telegram", "account": "default", "code": req.code,
                                         "sender_name": "alice"}) in env.fake.events
    assert not any(e == "channels.linked" for e, _ in env.fake.events)
    assert (await env.m.pairing_approve("telegram", req.code))["ok"]
    assert env.store.is_allowed("telegram", "99")
    assert env.store.list_pairing("telegram") == []
    assert env.tg.texts()[-1] == MSG_LINKED
    assert ("channels.linked", {"platform": "telegram", "code": code, "chat_id": "99", "title": "alice",
                                "kind": "direct", "confirmed": True}) in env.fake.events
    assert ("channels.changed", {}) in env.fake.events
    locs = env.m.locations("telegram")["locations"]
    assert {"chat_id": "99", "kind": "direct"}.items() <= next(c for c in locs if c["chat_id"] == "99").items()
    # Linking from the chat only admits the sender: no pane is bound, so nothing is
    # mirrored until someone binds a pane in Navide and chooses its level there.
    assert [b.pane_id for b in env.store.bindings()] == ["pane-1"]
    # Linked means allowed: the next message goes through the normal pipeline.
    env.store.bind("pane-dm", Location("telegram", "default", "99", ""))
    await env.inbound("hello", sender="99", chat="99", thread="", direct=True)
    assert env.fake.delivered[-1] == ("pane-dm", "hello", "telegram:alice")


async def test_startgroup_code_links_a_group_with_its_title(env: Env) -> None:
    env.tg.known_locations = lambda: [{"chat_id": "-500", "title": "Team room", "kind": "supergroup"}]
    code = env.m.link_create("telegram", "group")["code"]
    await _redeem_and_approve(env, f"/start@navide_bot {code}", sender="42", chat="-500", thread="")
    assert env.store.is_allowed("telegram", "42")
    assert ("channels.linked", {"platform": "telegram", "code": code, "chat_id": "-500",
                                "title": "Team room", "kind": "group", "confirmed": True}) in env.fake.events
    chats = {c["chat_id"]: c for c in env.store.chats("telegram", env.tg.token_fingerprint()[:16])}
    assert chats["-500"]["kind"] == "group"


async def test_a_code_links_only_once(env: Env) -> None:
    code = env.m.link_create("telegram", "direct")["code"]
    await env.inbound(f"/start {code}", sender="99", chat="99", thread="", direct=True)
    await env.inbound(f"/start {code}", sender="55", chat="55", thread="", direct=True)
    assert not env.store.is_allowed("telegram", "55")
    assert "配對" in env.tg.texts()[-1]  # the second sender falls back to pairing


async def test_expired_or_unknown_code_falls_back_to_pairing(env: Env, monkeypatch) -> None:
    await env.inbound("/start ZZZZ2222", sender="99", chat="99", thread="", direct=True)
    assert not env.store.is_allowed("telegram", "99")
    assert len(env.store.list_pairing("telegram")) == 1 and "配對" in env.tg.texts()[-1]
    monkeypatch.setattr(pairing, "INVITE_TTL_S", 0)
    code = env.m.link_create("telegram", "direct")["code"]
    await env.inbound(f"/start {code}", sender="98", chat="98", thread="", direct=True)
    assert not env.store.is_allowed("telegram", "98")
    # A stranger's group message with a dead code is still dropped silently.
    sent = len(env.tg.sent)
    await env.inbound(f"link {code}", sender="97", chat="-700", thread="")
    assert len(env.tg.sent) == sent and not env.store.is_allowed("telegram", "97")


async def test_other_platform_link_code_from_a_group_mention(env: Env) -> None:
    assert (await env.m.configure("slack", {}, {"token": "tok-S"}))["ok"]
    res = env.m.link_create("slack", "direct")
    assert res["url"] is None
    # Platforms with only a "direct" code may send it from a channel (the guide says so).
    await _redeem_and_approve(env, f"<@U0BOT> link {res['code'].lower()}", sender="U9", chat="C1",
                              thread="", platform="slack")
    assert env.store.is_allowed("slack", "U9")
    assert env.adapters["slack"].texts()[-1] == MSG_LINKED
    assert ("channels.linked", {"platform": "slack", "code": res["code"], "chat_id": "C1", "title": "C1",
                                "kind": "group", "confirmed": True}) in env.fake.events


async def test_an_allowed_senders_plain_start_keeps_todays_reply(env: Env) -> None:
    await env.inbound("/start", sender="7", chat="-900", thread="")
    assert not any(e == "channels.linked" for e, _ in env.fake.events)
    assert env.tg.texts()[-1] != MSG_LINKED


async def test_a_failed_allowlist_write_tells_the_sender_and_the_ui(env: Env, monkeypatch) -> None:
    def boom(*_a, **_k):
        raise sqlite3.OperationalError("database is locked")
    # The redemption writes a pairing request (the allowlist waits for the approval).
    monkeypatch.setattr(env.store, "add_pairing", boom)
    code = env.m.link_create("telegram", "direct")["code"]
    await env.inbound(f"/start {code}", sender="99", chat="99", thread="", direct=True)
    assert not env.store.is_allowed("telegram", "99")
    assert env.tg.texts()[-1] == MSG_LINK_FAILED
    assert ("channels.link_failed", {"platform": "telegram", "code": code,
                                     "error": "database is locked"}) in env.fake.events
    assert not any(e == "channels.linked" for e, _ in env.fake.events)


async def test_a_link_whose_platform_went_away_is_reported_failed(env: Env) -> None:
    code = env.m.link_create("telegram", "direct")["code"]
    env.m.invites.consume("telegram", code)
    del env.m._adapters[("telegram", "default")]
    msg = InboundMessage(platform="telegram", account="default", chat_id="99", thread_id="",
                         sender_id="99", sender_name="alice", text=f"/start {code}", message_id="x",
                         is_direct=True, ts=0.0)
    await env.m._link_chat(msg, code)
    assert ("channels.link_failed", {"platform": "telegram", "code": code,
                                     "error": "telegram is not connected"}) in env.fake.events


async def test_an_unsent_confirmation_still_links_and_says_so(env: Env) -> None:
    async def failing(loc, text, **kw):
        raise RuntimeError("429 Too Many Requests")
    code = env.m.link_create("telegram", "direct")["code"]
    env.tg.send_text = failing
    await _redeem_and_approve(env, f"/start {code}", sender="99", chat="99", thread="", direct=True)
    assert env.store.is_allowed("telegram", "99")
    assert ("channels.linked", {"platform": "telegram", "code": code, "chat_id": "99", "title": "alice",
                                "kind": "direct", "confirmed": False}) in env.fake.events


async def test_an_allowed_sender_redeeming_a_code_links_at_once(env: Env) -> None:
    """Someone already approved needs no second approval: linking another chat works as before."""
    env.tg.known_locations = lambda: [{"chat_id": "-500", "title": "Team room", "kind": "supergroup"}]
    code = env.m.link_create("telegram", "group")["code"]
    await env.inbound(f"/start@navide_bot {code}", sender="7", chat="-500", thread="")
    assert env.store.list_pairing("telegram") == []
    assert env.tg.texts()[-1] == MSG_LINKED
    assert ("channels.linked", {"platform": "telegram", "code": code, "chat_id": "-500",
                                "title": "Team room", "kind": "group", "confirmed": True}) in env.fake.events


async def test_a_direct_telegram_code_sent_in_a_group_is_refused(env: Env) -> None:
    """A DM deep link's code showing up in a group has leaked: it is spent and links nothing."""
    code = env.m.link_create("telegram", "direct")["code"]
    for sender in ("42", "7"):  # a stranger, and even an allowed sender
        await env.inbound(f"/start {code}", sender=sender, chat="-500", thread="")
        code_events = [p for e, p in env.fake.events if e == "channels.link_failed" and p["code"] == code]
        assert code_events and env.tg.texts()[-1] == MSG_LINK_DM_ONLY
        code = env.m.link_create("telegram", "direct")["code"]
    assert env.store.list_pairing("telegram") == []
    assert not env.store.is_allowed("telegram", "42")
    assert not any(e == "channels.linked" for e, _ in env.fake.events)


async def test_rejecting_a_redeemed_code_tells_the_waiting_ui(env: Env) -> None:
    code = env.m.link_create("telegram", "direct")["code"]
    await env.inbound(f"/start {code}", sender="99", chat="99", thread="", direct=True)
    [req] = env.store.list_pairing("telegram")
    assert (await env.m.pairing_reject("telegram", req.code))["ok"]
    assert not env.store.is_allowed("telegram", "99")
    assert any(e == "channels.link_failed" and p["code"] == code for e, p in env.fake.events)
    assert not any(e == "channels.linked" for e, _ in env.fake.events)


@pytest.mark.parametrize("sender", ["1087968824", "136817688", "777000", ""])
async def test_a_shared_or_unknown_telegram_sender_cannot_redeem_a_code(env: Env, sender: str) -> None:
    code = env.m.link_create("telegram", "group")["code"]
    await env.inbound(f"/start {code}", sender=sender, chat="-500", thread="")
    assert env.store.list_pairing("telegram") == []
    assert not env.store.is_allowed("telegram", sender)
    assert any(e == "channels.link_failed" and p["code"] == code for e, p in env.fake.events)
    assert env.tg.texts()[-1] == MSG_LINK_FAILED


async def test_pending_and_allowed_entries_say_whether_a_link_code_or_a_pairing_code_made_them(env: Env) -> None:
    code = env.m.link_create("telegram", "direct")["code"]
    await env.inbound(f"/start {code}", sender="99", chat="99", thread="", direct=True)
    await env.inbound("hi", sender="55", chat="55", thread="", direct=True)  # an ordinary pairing request
    pending = {r["sender_id"]: r for r in env.m.pairing_list("telegram")["requests"]}
    assert (pending["99"]["source"], pending["55"]["source"]) == ("invite", "pairing")
    for sender in ("99", "55"):
        assert (await env.m.pairing_approve("telegram", pending[sender]["code"]))["ok"]
    entries = {e["sender_id"]: e for e in env.m.allow_list("telegram")["entries"]}
    assert (entries["99"]["source"], entries["55"]["source"]) == ("invite", "pairing")
    assert entries["99"]["added_at"] > 0
    assert not any(e["shared"] for e in entries.values())


async def test_the_allow_list_flags_a_shared_telegram_id_without_removing_it(env: Env) -> None:
    env.store._exec("INSERT INTO channel_allow (platform, account, sender_id, sender_name, added_at)"
                    " VALUES ('telegram', 'default', '1087968824', 'GroupAnonymousBot', 1)")
    entries = {e["sender_id"]: e for e in env.m.allow_list(None)["entries"]}
    assert entries["1087968824"]["shared"] is True and entries["1087968824"]["source"] is None
    assert entries["7"]["shared"] is False
    assert env.store.remove_allow("telegram", "1087968824")
