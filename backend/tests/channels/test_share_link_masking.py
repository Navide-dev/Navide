"""A share link's key never reaches a chat that is not a known direct chat, whatever path the text takes."""

from __future__ import annotations

import logging
import time
import urllib.parse

import pytest

from agent_team_backend import channels as channels_pkg
from agent_team_backend import server_link, share_links
from agent_team_backend.channels import manager as mgr_mod
from agent_team_backend.channels import share_cmds
from agent_team_backend.channels.base import Location
from agent_team_backend.channels.manager import MSG_WORKING

from .test_manager import Env, _until, env, fast_timers  # noqa: F401 — pytest fixtures
from .test_share_notify import DM, LINK_ID, ME, URL, FakeLinks, _created, _opened, _row

GROUP = Location("telegram", "default", "-200", "", "grp")
MASKED = f"https://share.navide.dev/s/{LINK_ID[:6]}…"


def _texts_in(env: Env, chat_id: str) -> list[str]:
    return [t for where, t in env.tg.sent if where.chat_id == chat_id]


async def _reply_from(env: Env, pane_id: str, text: str, **inbound) -> None:
    await env.inbound("please share the Q4 plan", **inbound)
    env.fake.verdicts[f"k{env.fake._n}"] = {"status": "delivered"}
    await _until(lambda: MSG_WORKING in env.tg.texts())
    env.turn_complete(pane_id, text)
    await _until(lambda: any("Done" in t for t in _texts_in(env, inbound["chat"])))


def test_mask_links_keeps_only_six_characters_and_drops_the_key() -> None:
    assert share_cmds.mask_links(f"see {URL} now") == f"see {MASKED} now"
    bare = f"https://share.navide.dev/s/{LINK_ID}"
    assert share_cmds.mask_links(bare) == MASKED
    other = f"https://share.example.org/s/{LINK_ID}#k=abcDEF123_-"
    assert share_cmds.mask_links(other) == f"https://share.example.org/s/{LINK_ID[:6]}…"
    untouched = "https://example.com/s/abc and https://example.com/s/ABCDEFGHIJKLMNOPQRSTUVWX"
    assert share_cmds.mask_links(untouched) == untouched


async def test_an_agent_reply_with_a_link_reaches_a_group_masked(env: Env) -> None:
    env.store.add_allow("telegram", "8", "carol", 1)
    env.store.bind("pane-g", GROUP)
    await _reply_from(env, "pane-g", f"Done. Link: {URL}", chat="-200", thread="", sender="8")
    sent = "\n".join(_texts_in(env, "-200"))
    assert "#k=" not in sent and LINK_ID not in sent and MASKED in sent


async def test_an_agent_reply_with_a_link_reaches_a_direct_chat_whole(env: Env) -> None:
    env.store.bind("pane-dm", DM)
    await _reply_from(env, "pane-dm", f"Done. Link: {URL}", chat="555", thread="", direct=True)
    assert any(URL in t for t in _texts_in(env, "555"))


@pytest.mark.parametrize("remembered", ["group", None])
async def test_any_send_to_a_non_direct_chat_is_masked(env: Env, remembered: str | None) -> None:
    if remembered:
        env.store.remember_chat("telegram", mgr_mod._bot_key(env.tg), "-200", "grp", remembered, False,
                                int(time.time()))
    await env.m.mirror.send(GROUP, f"link {URL}")
    env.m.mirror.post(GROUP, f"again {URL}")
    await _until(lambda: len(_texts_in(env, "-200")) == 2)
    for text in _texts_in(env, "-200"):
        assert "#k=" not in text and LINK_ID not in text and MASKED in text


async def test_a_long_reply_split_into_chunks_still_masks_the_link(env: Env) -> None:
    env.store.add_allow("telegram", "8", "carol", 1)
    env.store.bind("pane-g", GROUP)
    # No whitespace near the link, so the 4000-character cut falls inside it.
    body = "Done\n" + "x" * 3980 + URL + "y" * 50
    await _reply_from(env, "pane-g", body, chat="-200", thread="", sender="8")
    sent = "".join(_texts_in(env, "-200"))
    assert "#k=" not in sent and LINK_ID not in sent


async def test_logs_never_carry_a_link(env: Env, monkeypatch, caplog) -> None:
    caplog.set_level(logging.DEBUG)
    fake = FakeLinks()
    fake.rows = [_row()]
    monkeypatch.setattr(share_links, "list_links", fake.list_links)
    monkeypatch.setattr(server_link, "link_state", lambda: server_link.STATE_CONNECTED)
    monkeypatch.setattr(server_link, "local_device_id", lambda: ME)
    monkeypatch.setattr(channels_pkg, "get_manager", lambda: env.m)
    env.store.remember_chat("telegram", mgr_mod._bot_key(env.tg), "555", "alice", "direct", False, int(time.time()))
    env.store.bind("pane-dm", DM)
    await share_cmds.notify_link_created(_created("pane-dm"))
    await share_cmds.notify_link_created(_created("pane-1"))
    await share_cmds.notify_link_opened(_opened())

    async def boom(*_a, **_k):
        raise RuntimeError(f"send failed for {URL}")

    monkeypatch.setattr(env.m.mirror, "send", boom)
    await share_cmds.notify_link_created(_created("pane-dm"))
    logged = "\n".join(r.getMessage() for r in caplog.records)
    assert "#k=" not in logged and LINK_ID not in logged


# --- R7: whatever shape the link takes ----------------------------------------------------

# A key this process built, assembled at run time (never a literal in the source).
R7_KEY = bytes(range(32))
R7_ID = "Ab3dEf" + "GhIjKlMnOpQrStUv"
R7_URL = share_links.link_url(R7_ID, R7_KEY)
R7_K = R7_URL.partition("#k=")[2]
R7_TAIL = R7_ID[6:]

R7_CHAT_VARIANTS = {
    "no-scheme": "Done: " + R7_URL.replace("https://", ""),
    "upper": "Done: " + R7_URL.replace("https://share.navide.dev", "HTTPS://SHARE.NAVIDE.DEV"),
    "wrapped-mid-id": "Done: " + R7_URL[:32] + "\n" + R7_URL[32:],
    "pct": "Done: " + R7_URL.replace("#k=", "%23k%3D"),
    "key-separately": "Done: " + R7_URL.split("#")[0] + " — key " + R7_K,
}

R7_UNIT_VARIANTS = {
    **R7_CHAT_VARIANTS,
    "upper-scheme": R7_URL.replace("https", "HTTPS"),
    "mixed-case-host": R7_URL.replace("share.navide.dev", "Share.Navide.dev"),
    "pct-all": urllib.parse.quote(R7_URL, safe=""),
    "newline-before-k": R7_URL.replace("#k=", "\n#k="),
    "newline-mid-key": R7_URL[:-20] + "\n" + R7_URL[-20:],
    "markdown": f"[link]({R7_URL})",
    "angle": f"<{R7_URL}>",
    "slack": f"<{R7_URL}|link>",
    "code": f"```\n{R7_URL}\n```",
    "two": f"{R7_URL} and {share_links.link_url('Q' * 22, R7_KEY)}",
    "http": R7_URL.replace("https", "http"),
    "custom-host": share_links.link_url(R7_ID, R7_KEY, base="https://share.example.com"),
    "custom-host-pct": share_links.link_url(R7_ID, R7_KEY, base="https://share.example.com").replace("#k=", "%23k%3D"),
    "key-other-param": R7_URL.replace("#k=", "#x=1&k="),
    "zero-width": R7_URL.replace("/s/", "/s/​"),
    "json-escaped": R7_URL.replace("/", "\\/"),
    "fullwidth-colon": R7_URL.replace("://", "：//"),
    "key-only": f"the key is {R7_K}",
}


def _leaks(text: str) -> bool:
    flat = "".join(text.split()).replace("​", "")
    return R7_K[:20] in flat or R7_K[-20:] in flat or R7_TAIL in flat


@pytest.mark.parametrize("name", list(R7_UNIT_VARIANTS))
def test_mask_links_whatever_the_shape(name: str) -> None:
    masked = share_cmds.mask_links(R7_UNIT_VARIANTS[name])
    assert not _leaks(masked), masked


def test_an_unknown_key_after_a_marker_is_masked_too() -> None:
    other = "".join(chr(ord("A") + i % 26) for i in range(43))
    assert other not in share_cmds.mask_links(f"open it with #k={other} please")
    assert other not in share_cmds.mask_links(f"open it with %23K%3D{other} please")


def test_ordinary_text_is_left_alone() -> None:
    for text in ("https://example.com/s/abc and https://example.com/s/ABCDEFGHIJKLMNOPQRSTUVWX",
                 "see /s/ in the docs", "a #k= marker with nothing after it", "plain words only"):
        assert share_cmds.mask_links(text) == text


@pytest.mark.parametrize("name", list(R7_CHAT_VARIANTS))
async def test_a_group_reply_never_carries_the_key_or_id_whatever_the_shape(env: Env, name: str) -> None:
    env.store.add_allow("telegram", "8", "carol", 1)
    env.store.bind("pane-g", GROUP)
    await _reply_from(env, "pane-g", R7_CHAT_VARIANTS[name], chat="-200", thread="", sender="8")
    sent = "\n".join(_texts_in(env, "-200"))
    assert not _leaks(sent), sent


@pytest.mark.parametrize("name", list(R7_CHAT_VARIANTS))
async def test_a_direct_chat_still_gets_every_shape_whole(env: Env, name: str) -> None:
    env.store.bind("pane-dm", DM)
    await _reply_from(env, "pane-dm", R7_CHAT_VARIANTS[name], chat="555", thread="", direct=True)
    sent = "\n".join(_texts_in(env, "555"))
    assert R7_CHAT_VARIANTS[name].split("\n")[-1] in sent


async def test_a_reply_that_cannot_be_sent_is_recorded_in_the_error_ledger(env: Env, monkeypatch, tmp_path) -> None:
    from agent_team_backend import error_ledger

    led = error_ledger.ErrorLedger(tmp_path / "errors.jsonl")
    monkeypatch.setattr(error_ledger, "_ledger", led)

    async def boom(*_a, **_k):
        raise RuntimeError(f"send failed for {URL}")

    monkeypatch.setattr(env.m.mirror, "send", boom)
    pending = mgr_mod._Pending(loc=GROUP)
    assert await env.m._post_reply(pending, "first line\n" + "x" * 50) is False
    entries = led.read()
    led.close()
    assert [e["code"] for e in entries] == ["channels.reply_failed"]
    assert "telegram" in entries[0]["message"] and "RuntimeError" in entries[0]["message"]
    assert "#k=" not in entries[0]["message"] and LINK_ID not in entries[0]["message"]
