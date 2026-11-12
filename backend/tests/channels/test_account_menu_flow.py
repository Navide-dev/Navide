"""/account end to end through the manager, on the fake adapter and fake seams (no real
bot, no real account switch): the menu, the switch through switch_account, the usage-limit
notice's button, and every refusal (group chat, other owner, stale, expired, other CLI)."""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend.channels import account_menu as am
from agent_team_backend.channels.manager import MSG_WORKING

from .test_manager import Env, FakeClock, _make_env, _said, _until, env, fast_timers  # noqa: F401 — fixtures


def _rows() -> list[dict[str, Any]]:
    return [
        {"id": "__default__", "label": "Default", "remaining": 0, "stale": False, "signedOut": False, "active": True},
        {"id": "p-work", "label": "Work", "remaining": 62.4, "stale": False, "signedOut": False, "active": False},
        {"id": "p-auto", "label": "someone" + "@example.test", "remaining": 30, "stale": True,
         "signedOut": False, "active": False},
    ]


class Accounts:
    """The account_menu / switch_account seams: the window's rows, and each switch asked."""

    def __init__(self) -> None:
        self.menu: dict[str, Any] = {"status": "ok", "agentKey": "claude", "activeId": "__default__",
                                     "fixedCount": 2, "rows": _rows()}
        self.calls: list[tuple[str, str, str, str]] = []
        self.results: list[dict[str, Any]] = []
        self.on_settled: Any = None

    async def read(self, pane_id: str) -> dict[str, Any]:
        return dict(self.menu)

    async def switch(self, pane_id: str, profile_id: str, from_id: str, who: str,
                     on_settled: Any = None) -> dict[str, Any]:
        self.calls.append((pane_id, profile_id, from_id, who))
        self.on_settled = on_settled
        if self.results:
            return self.results.pop(0)
        return {"status": "switched", "from": "Default", "to": "Work", "fixedCount": 2}


def _setup(env: Env) -> Accounts:
    acc = Accounts()
    env.m._seams.account_menu = acc.read
    env.m._seams.switch_account = acc.switch
    return acc


def _buttons(env: Env, menu: int = -1) -> list[tuple[str, str]]:
    return [b for row in env.tg.menus[menu][2] for b in row]


def _data(buttons: list[tuple[str, str]], label_part: str) -> str:
    return next(data for label, data in buttons if label_part in label)


async def _press(env: Env, data: str, sender: str = "7", direct: bool = True) -> None:
    await env.inbound("", callback=data, sender=sender, direct=direct)


async def test_direct_chat_switches_in_one_press_and_says_so(env: Env) -> None:
    acc = _setup(env)
    await env.inbound("/account", direct=True)
    assert env.fake.delivered == []  # never typed into the CLI
    _, body, _rows_ = env.tg.menus[-1]
    assert "Default" in body and "2 個分格固定" in body
    labels = [label for label, _ in _buttons(env)]
    # The active account is not a button; the email-named one is masked; a stale figure says so.
    assert labels[0] == "Work · 62%"
    assert labels[1] == "som…@example.test · ~30%"
    assert all("Default" not in label for label in labels)
    await _press(env, _data(_buttons(env), "Work"))
    assert acc.calls == [("pane-1", "p-work", "__default__", "telegram:alice")]
    mid, final, rows = env.tg.menu_edits[-1]
    assert mid == "menu1" and rows == [] and "✅" in final and "Work" in final and "稽核" in final
    # The same button again is dead: the menu closed before the switch ran.
    await _press(env, _data(_buttons(env), "Work"))
    assert len(acc.calls) == 1
    assert _said(env, "過期")


async def test_only_the_opener_can_press(env: Env) -> None:
    acc = _setup(env)
    env.store.add_allow("telegram", "8", "bob", 1)
    await env.inbound("/account", direct=True)
    await _press(env, _data(_buttons(env), "Work"), sender="8")
    assert acc.calls == []
    assert _said(env, "只有開這份選單的人能按")


async def test_a_group_chat_lists_without_buttons(env: Env) -> None:
    acc = _setup(env)
    await env.inbound("/account")
    assert env.tg.menus == []
    assert _said(env, "群組聊天室不能切換") and _said(env, "2. Work · 62%")
    await env.inbound("/account 2")
    assert acc.calls == []


async def test_a_typed_number_switches_in_a_direct_chat(env: Env) -> None:
    acc = _setup(env)
    await env.inbound("/account 2", direct=True)
    assert acc.calls == [("pane-1", "p-work", "__default__", "telegram:alice")]
    assert _said(env, "✅")
    await env.inbound("/account 9", direct=True)  # no such row: the list again
    assert len(acc.calls) == 1 and _said(env, "/account <編號>")


async def test_a_stale_menu_switches_nothing(env: Env) -> None:
    acc = _setup(env)
    acc.results = [{"status": "stale"}]
    await env.inbound("/account", direct=True)
    await _press(env, _data(_buttons(env), "Work"))
    assert env.tg.menu_edits[-1][1] == am.text("zh-TW", "expired")


async def test_a_question_for_the_window_is_not_answered_from_the_chat(env: Env) -> None:
    acc = _setup(env)
    acc.results = [{"status": "needs-user", "code": "needs-user"}]
    await env.inbound("/account", direct=True)
    await _press(env, _data(_buttons(env), "Work"))
    assert "needs-user" in env.tg.menu_edits[-1][1] and "視窗" in env.tg.menu_edits[-1][1]


async def test_a_queued_switch_says_how_many_panes_and_reports_when_done(env: Env) -> None:
    acc = _setup(env)
    acc.results = [{"status": "queued", "waiting": 3, "from": "Default", "to": "Work"}]
    await env.inbound("/account", direct=True)
    await _press(env, _data(_buttons(env), "Work"))
    queued = env.tg.menu_edits[-1][1]
    assert "已排入" in queued and "3 個分格" in queued and "Work" in queued
    assert acc.on_settled is not None
    await acc.on_settled({"status": "switched", "from": "Default", "to": "Work"})
    assert _said(env, "✅ Claude 已從 Default 切到 Work")
    await acc.on_settled({"status": "superseded", "to": "Work"})
    assert _said(env, "已被較新的切換取代")


async def test_before_the_shared_switch_is_wired_the_chat_is_told(env: Env) -> None:
    acc = _setup(env)
    acc.results = [{"status": "unavailable"}]
    await env.inbound("/account", direct=True)
    await _press(env, _data(_buttons(env), "Work"))
    assert env.tg.menu_edits[-1][1] == am.text("zh-TW", "unavailable")


async def test_the_two_menus_link_to_each_other(env: Env) -> None:
    from agent_team_backend.channels import model_menu as mm

    _setup(env)
    env.m._seams.pane_model = lambda p: {"agent_key": "claude", "model": "opus", "supports_model": True,
                                         "efforts": [], "known": []}
    await env.inbound("/account", direct=True)
    assert (am.text("zh-TW", "model_link"), mm.OPEN_CALLBACK) in _buttons(env)
    await env.inbound("/model", direct=True)
    assert (am.text("zh-TW", "open"), am.OPEN_CALLBACK) in _buttons(env)


async def test_another_cli_is_sent_to_the_window(env: Env) -> None:
    acc = _setup(env)
    acc.menu = {"status": "unsupported", "agentKey": "codex"}
    await env.inbound("/account", direct=True)
    assert env.tg.menus == [] and _said(env, "codex") and acc.calls == []


async def test_no_window_and_a_single_account(env: Env) -> None:
    acc = _setup(env)
    acc.menu = {"status": "no-window"}
    await env.inbound("/account", direct=True)
    assert _said(env, "沒有回應")
    acc.menu = {"status": "ok", "agentKey": "claude", "activeId": "__default__", "rows": _rows()[:1]}
    await env.inbound("/account", direct=True)
    assert _said(env, "只有一個帳號") and env.tg.menus == []


async def test_cancel_closes_the_menu(env: Env) -> None:
    acc = _setup(env)
    await env.inbound("/account", direct=True)
    await _press(env, _data(_buttons(env), "取消"))
    assert env.tg.menu_edits[-1][1] == am.text("zh-TW", "cancelled") and acc.calls == []


async def test_a_menu_dies_after_its_ttl(tmp_path) -> None:
    clock = FakeClock()
    e = await _make_env(tmp_path, clock)
    try:
        acc = _setup(e)
        await e.inbound("/account", direct=True)
        data = _data(_buttons(e), "Work")
        clock.t += am.MENU_TTL_S + 1
        await _press(e, data)
        assert acc.calls == [] and _said(e, "過期")
    finally:
        await e.m.stop()
        e.db.close()


async def test_the_usage_limit_notice_carries_the_switch_button(env: Env) -> None:
    acc = _setup(env)
    await env.inbound("long job", direct=True)
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await _until(lambda: MSG_WORKING in env.tg.texts())
    env.fake.limit = {"until": 1_800_000_000_000, "buffer": ""}
    await _until(lambda: _said(env, "額度已用完"))
    notice = next(t for t in env.tg.texts() if "額度已用完" in t)
    assert env.tg.buttons[notice] == [(am.text("zh-TW", "open"), am.OPEN_CALLBACK)]
    # The button opens a menu for whoever presses it.
    await _press(env, am.OPEN_CALLBACK)
    await _until(lambda: bool(env.tg.menus))
    assert any("Work" in label for label, _ in _buttons(env))
    assert acc.calls == []


async def test_the_usage_limit_notice_in_a_group_has_no_button(env: Env) -> None:
    _setup(env)
    await env.inbound("long job")
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await _until(lambda: MSG_WORKING in env.tg.texts())
    env.fake.limit = {"until": 1_800_000_000_000, "buffer": ""}
    await _until(lambda: _said(env, "額度已用完"))
    notice = next(t for t in env.tg.texts() if "額度已用完" in t)
    assert notice not in env.tg.buttons


def test_parse_command_and_callback() -> None:
    assert am.parse_command("/account") is None
    assert am.parse_command("/accounts@navide_bot") is None
    assert am.parse_command("/account 3") == 3
    assert am.parse_command("/account x") is False
    assert am.parse_command("/model") is False
    assert am.parse_callback(am.OPEN_CALLBACK) is None
    token = "".join(am.TOKEN_ALPHABET[0] for _ in range(am.TOKEN_LENGTH))
    assert am.parse_callback("nv6:" + token) == token
    assert am.parse_callback("nv5:" + token) is None


def test_mask_email_keeps_a_prefix_and_the_domain() -> None:
    assert am.mask_email("someone" + "@example.test") == "som…@example.test"
    assert am.mask_email("Work") == "Work"


def test_render_single_offers_one_target_once() -> None:
    menus = am.AccountMenus()
    menu = menus.create(location_key="k", sender_id="7", lang="en-US", agent_key="claude",
                        active_id="p-work", rows=[am.AccountRow("__default__", "Default"),
                                                  am.AccountRow("p-work", "Work", active=True)])
    rows = menus.render_single(menu, "__default__", "↩ Switch back to Default")
    data = rows[0][0][1]
    press, why = menus.press(am.parse_callback(data) or "", "k", "7")
    assert press is not None and press.action == "switch" and press.value == "__default__"
    menus.close(menu)
    assert menus.press(am.parse_callback(data) or "", "k", "7") == (None, "expired")


@pytest.mark.parametrize("lang", sorted(am.STRINGS))
def test_every_language_formats(lang: str) -> None:
    for key in am.STRINGS["zh-TW"]:
        am.text(lang, key, current="x", count=1, agent="a", to="t", code="c", error="e", **{"from": "f"})


def test_switch_answer_reads_the_shared_switch() -> None:
    from agent_team_backend.channels import _switch_answer

    assert _switch_answer({"ok": True, "status": "queued", "waiting": 2, "from": "A", "to": "B",
                           "request_id": 7}) == {"status": "queued", "from": "A", "to": "B", "waiting": 2}
    assert _switch_answer({"ok": False, "status": "refused", "code": "SWITCH_RATE_LIMITED"})["code"] == \
        "SWITCH_RATE_LIMITED"
    assert _switch_answer({})["status"] == "no-window"
