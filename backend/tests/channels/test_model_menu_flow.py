"""/model end to end through the manager, on the fake adapter and fake seams (no real bot,
no real token): the menu, the switch through set_model, the busy wait, the /status button
and every refusal."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from agent_team_backend.channels import manager as mgr_mod
from agent_team_backend.channels import model_menu as mm
from agent_team_backend.channels.base import Capabilities

from .test_manager import Env, FakeClock, _make_env, _until, env, fast_timers  # noqa: F401 — fixtures


class Switches:
    """The set_model seam: records each ask and answers in turn (default: a picker switch)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str, str]] = []
        self.results: list[dict[str, Any]] = []

    async def __call__(self, pane_id: str, model: str, effort: str, who: str) -> dict[str, Any]:
        self.calls.append((pane_id, model, effort, who))
        if self.results:
            return self.results.pop(0)
        return {"ok": True, "pane_id": pane_id, "method": "picker"}


def _setup(env: Env, panes: dict[str, dict[str, Any]] | None = None,
           tree: list[dict[str, Any]] | None = None) -> Switches:
    infos = panes or {"pane-1": {"agent_key": "claude", "model": "opus", "supports_model": True,
                                 "efforts": ["low", "high"], "known": []}}
    switches = Switches()
    env.m._seams.pane_model = lambda p: dict(infos.get(p, {}))
    env.m._seams.set_model = switches
    if tree is not None:
        env.m._seams.pane_directory = lambda: [dict(p) for p in tree]
    return switches


def _buttons(env: Env, menu: int = -1) -> list[tuple[str, str]]:
    return [b for row in env.tg.menus[menu][2] for b in row]


def _edited_buttons(env: Env) -> list[tuple[str, str]]:
    return [b for row in env.tg.menu_edits[-1][2] for b in row]


def _data(buttons: list[tuple[str, str]], label_part: str) -> str:
    return next(data for label, data in buttons if label_part in label)


async def _press(env: Env, data: str, sender: str = "7") -> None:
    await env.inbound("", callback=data, sender=sender)


def _tree() -> list[dict[str, Any]]:
    return [{"pane_id": "pane-1", "name": "main", "spawned_by": "", "display_status": "idle"},
            {"pane_id": "pane-2", "name": "coder", "spawned_by": "pane-1", "display_status": "idle"}]


async def test_one_pane_switches_in_two_presses_and_says_how(env: Env) -> None:
    switches = _setup(env)
    await env.inbound("/model")
    assert env.fake.delivered == []  # never typed into the CLI
    labels = [label for label, _ in _buttons(env)]
    assert labels[:4] == ["✓ Opus", "Sonnet", "Haiku", "Fable"]
    await _press(env, _data(_buttons(env), "Sonnet"))
    assert switches.calls == [("pane-1", "sonnet", "", "telegram:alice")]
    # The menu's buttons are gone and the result is its own message.
    mid, body, rows = env.tg.menu_edits[-1]
    assert mid == "menu1" and rows == [] and "sonnet" in body
    assert any("✅" in t and "sonnet" in t and "picker" in t for t in env.tg.texts())
    event = next(p for kind, p in env.fake.events if kind == "channels.model_switched")
    assert event["model"] == "sonnet" and event["who"] == "telegram:alice" and event["new_pane_id"] == "pane-1"


async def test_a_spent_or_forged_button_does_nothing(env: Env) -> None:
    switches = _setup(env)
    await env.inbound("/model")
    sonnet = _data(_buttons(env), "Sonnet")
    await _press(env, sonnet)
    await _press(env, sonnet)
    await _press(env, "nv5:aaaaaaaaaa")  # well-formed, never minted
    assert len(switches.calls) == 1
    assert sum(mm.text("zh-TW", "expired") in t for t in env.tg.texts()) == 2


async def test_only_the_person_who_opened_it_can_press(env: Env) -> None:
    switches = _setup(env)
    env.store.add_allow("telegram", "8", "bob", 1)
    await env.inbound("/model")
    await _press(env, _data(_buttons(env), "Sonnet"), sender="8")
    assert switches.calls == []
    assert mm.text("zh-TW", "not_owner") in env.tg.texts()
    await _press(env, _data(_buttons(env), "Sonnet"))
    assert len(switches.calls) == 1


async def test_a_stranger_pressing_is_dropped(env: Env) -> None:
    switches = _setup(env)
    await env.inbound("/model")
    await _press(env, _data(_buttons(env), "Sonnet"), sender="99")
    assert switches.calls == []


async def test_the_menu_expires_after_thirty_minutes(tmp_path) -> None:
    clock = FakeClock()
    e = await _make_env(tmp_path, clock)
    try:
        switches = _setup(e)
        await e.inbound("/model")
        clock.t += mm.MENU_TTL_S + 1
        await _press(e, _data(_buttons(e), "Sonnet"))
        assert switches.calls == [] and mm.text("zh-TW", "expired") in e.tg.texts()
    finally:
        await e.m.stop()
        e.db.close()


async def test_the_pane_step_lists_the_status_tree_and_goes_back(env: Env) -> None:
    switches = _setup(env, {
        "pane-1": {"agent_key": "claude", "model": "", "supports_model": True, "efforts": [], "known": []},
        "pane-2": {"agent_key": "codex", "model": "gpt-5.5", "supports_model": True, "efforts": [],
                   "known": ["gpt-5.5", "gpt-5.3-codex"]},
    }, _tree())
    await env.inbound("/model")
    assert [label for label, _ in _buttons(env)] == ["main · claude · 預設", "coder · codex · gpt-5.5", "✖ 取消"]
    await _press(env, _data(_buttons(env), "coder"))
    labels = [label for label, _ in _edited_buttons(env)]
    assert labels[:2] == ["✓ gpt-5.5", "gpt-5.3-codex"] and "◀ 換分格" in labels
    await _press(env, _data(_edited_buttons(env), "◀"))
    await _press(env, _data(_edited_buttons(env), "main"))
    await _press(env, _data(_edited_buttons(env), "Haiku"))
    assert switches.calls == [("pane-1", "haiku", "", "telegram:alice")]


async def test_a_pane_that_left_the_tree_is_refused(env: Env) -> None:
    tree = _tree()
    switches = _setup(env, {
        "pane-1": {"agent_key": "claude", "supports_model": True},
        "pane-2": {"agent_key": "claude", "supports_model": True},
    }, tree)
    await env.inbound("/model")
    coder = _data(_buttons(env), "coder")
    tree.pop()  # the child closed
    await _press(env, coder)
    assert switches.calls == [] and env.tg.menu_edits[-1][1] == mm.text("zh-TW", "expired")


async def test_terminal_and_modelless_panes_are_left_out(env: Env) -> None:
    _setup(env, {"pane-1": {"agent_key": "terminal"}})
    await env.inbound("/model")
    assert mm.text("zh-TW", "no_panes") in env.tg.texts()


async def test_an_effort_restarts_and_the_new_id_is_reported(env: Env) -> None:
    switches = _setup(env)
    switches.results.append({"ok": True, "pane_id": "pane-9", "method": "restart"})
    await env.inbound("/model")
    await _press(env, _data(_buttons(env), "⚙️"))
    await _press(env, _data(_edited_buttons(env), "Opus"))
    assert [label for label, _ in _edited_buttons(env)][:2] == ["low", "high"]
    await _press(env, _data(_edited_buttons(env), "high"))
    assert switches.calls == [("pane-1", "opus", "high", "telegram:alice")]
    report = env.tg.texts()[-1]
    assert "opus · high" in report and "pane-1 → pane-9" in report and "restart" in report


async def test_a_busy_pane_is_switched_once_idle(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mgr_mod, "MODEL_WAIT_POLL_S", 0.01)
    switches = _setup(env)
    switches.results.append({"ok": False, "error_code": "pane-busy", "error": "busy", "hold": "mid-turn"})
    await env.inbound("/model")
    await _press(env, _data(_buttons(env), "Sonnet"))
    assert env.tg.menu_edits[-1][1].startswith("⏳")
    env.fake.states["pane-1"] = {"exists": True, "busy": True, "display_status": "running"}
    await _press(env, _data(_edited_buttons(env), "閒置後切換"))
    assert any("最多等 15 分鐘" in t for t in [b for _, b, _ in env.tg.menu_edits])
    await asyncio.sleep(0.05)
    assert len(switches.calls) == 1  # not asked while busy
    env.fake.states["pane-1"] = {"exists": True, "busy": False, "display_status": "idle"}
    await _until(lambda: len(switches.calls) == 2 and any("✅" in t for t in env.tg.texts()))
    assert switches.calls[-1] == ("pane-1", "sonnet", "", "telegram:alice")
    assert env.m._model_waits == {}


async def test_a_wait_times_out_and_says_so(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mgr_mod, "MODEL_WAIT_POLL_S", 0.01)
    monkeypatch.setattr(mgr_mod, "MODEL_WAIT_TIMEOUT_S", 0.1)
    switches = _setup(env)
    env.fake.states["pane-1"] = {"exists": True, "busy": True, "display_status": "running"}
    switches.results.append({"ok": False, "error_code": "pane-busy", "error": "busy"})
    await env.inbound("/model sonnet")
    await _until(lambda: any("⌛" in t for t in env.tg.texts()))
    assert len(switches.calls) == 1


async def test_a_newer_wait_replaces_the_older(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mgr_mod, "MODEL_WAIT_POLL_S", 0.01)
    switches = _setup(env)
    env.fake.states["pane-1"] = {"exists": True, "busy": True, "display_status": "running"}
    switches.results += [{"ok": False, "error_code": "pane-busy", "error": "busy"}] * 2
    await env.inbound("/model sonnet")
    await env.inbound("/model haiku")
    await _until(lambda: any("已由新的取代" in t and "sonnet" in t for t in env.tg.texts()))
    env.fake.states["pane-1"] = {"exists": True, "busy": False, "display_status": "idle"}
    await _until(lambda: len(switches.calls) == 3)
    assert switches.calls[-1][1] == "haiku"


async def test_typed_model_switches_the_numbered_pane(env: Env) -> None:
    switches = _setup(env, {
        "pane-1": {"agent_key": "claude", "supports_model": True},
        "pane-2": {"agent_key": "codex", "supports_model": True},
    }, _tree())
    await env.inbound("/model 2 gpt-5.5")
    assert switches.calls == [("pane-2", "gpt-5.5", "", "telegram:alice")]


async def test_a_failed_switch_says_why(env: Env) -> None:
    switches = _setup(env)
    switches.results.append({"ok": False, "error_code": "model-unsupported", "error": "nope"})
    await env.inbound("/model sonnet")
    assert any(t.startswith("❌") and "nope" in t for t in env.tg.texts())
    assert not any(kind == "channels.model_switched" for kind, _ in env.fake.events)


async def test_without_buttons_the_menu_is_numbered_lines(env: Env) -> None:
    _setup(env)
    env.tg.capabilities = Capabilities(threads=True, create_location=True, edit=True, typing=True,
                                       buttons=False, text_limit=4000)
    await env.inbound("/model")
    assert env.tg.menus == []
    text = env.tg.texts()[-1]
    assert "1. " in text and "opus, sonnet, haiku, fable" in text and "/model 1 sonnet" in text


async def test_status_offers_the_model_button_which_opens_the_menu(env: Env) -> None:
    switches = _setup(env)
    await env.inbound("/status")
    status = env.tg.texts()[-1]
    assert env.tg.buttons[status] == [("🧠 切換模型", mm.OPEN_CALLBACK)]
    await _press(env, mm.OPEN_CALLBACK)
    assert env.tg.menus and env.fake.delivered == []
    await _press(env, _data(_buttons(env), "Fable"))
    assert switches.calls[-1][1] == "fable"


async def test_cancel_closes_the_menu(env: Env) -> None:
    switches = _setup(env)
    await env.inbound("/model")
    sonnet = _data(_buttons(env), "Sonnet")
    await _press(env, _data(_buttons(env), "✖"))
    assert env.tg.menu_edits[-1][1:] == (mm.text("zh-TW", "cancelled"), [])
    await _press(env, sonnet)
    assert switches.calls == []


@pytest.mark.parametrize("revoke", ["allow", "binding"])
async def test_a_wait_rechecks_the_sender_and_the_binding_before_switching(
    env: Env, monkeypatch: pytest.MonkeyPatch, revoke: str,
) -> None:
    monkeypatch.setattr(mgr_mod, "MODEL_WAIT_POLL_S", 0.01)
    switches = _setup(env)
    env.fake.states["pane-1"] = {"exists": True, "busy": True, "display_status": "running"}
    switches.results.append({"ok": False, "error_code": "pane-busy", "error": "busy"})
    await env.inbound("/model sonnet")
    if revoke == "allow":
        env.store.remove_allow("telegram", "7")
    else:
        env.store.unbind("pane-1")
    env.fake.states["pane-1"] = {"exists": True, "busy": False, "display_status": "idle"}
    await _until(lambda: env.m._model_waits == {})
    assert len(switches.calls) == 1  # only the first, busy attempt
    assert not any("✅" in t for t in env.tg.texts())
