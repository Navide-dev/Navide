"""channels.model_menu on its own: tokens, ownership, expiry, steps and parsing."""

from __future__ import annotations

import re
from pathlib import Path

from agent_team_backend.channels import model_menu as mm

LOC = "telegram:default:-100:50"


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def _row(pane_id: str = "pane-1", agent: str = "claude", model: str = "opus",
         efforts: tuple[str, ...] = ("low", "high")) -> mm.PaneRow:
    return mm.PaneRow(pane_id=pane_id, name=pane_id, agent_key=agent, model=model, efforts=efforts,
                      models=mm.model_options(agent, model, []))


def _menu(menus: mm.ModelMenus, rows: list[mm.PaneRow] | None = None) -> mm.Menu:
    return menus.create(location_key=LOC, sender_id="7", lang="en-US", root_pane_id="pane-1",
                        panes=rows or [_row()])


def _tokens(rows: list[list[tuple[str, str]]]) -> dict[str, str]:
    return {label: mm.parse_callback(data) or "" for row in rows for label, data in row}


def test_a_button_carries_only_a_short_random_token() -> None:
    menus = mm.ModelMenus()
    _, rows = menus.render(_menu(menus))
    for row in rows:
        for _, data in row:
            assert re.fullmatch(r"nv5:[A-Za-z0-9]{10}", data)
            assert "pane-1" not in data and "opus" not in data
            assert len(data.encode()) <= 64  # Telegram's callback_data limit


def test_only_the_owner_in_the_same_chat_can_press() -> None:
    menus = mm.ModelMenus()
    _, rows = menus.render(_menu(menus))
    token = _tokens(rows)["Sonnet"]
    assert menus.press(token, LOC, "8") == (None, "not_owner")
    assert menus.press(token, "telegram:default:-100:99", "7") == (None, "expired")
    press, why = menus.press(token, LOC, "7")
    assert why == "" and press is not None and (press.action, press.value) == ("model", "sonnet")


def test_a_render_kills_the_last_buttons_and_close_kills_all() -> None:
    menus = mm.ModelMenus()
    menu = _menu(menus)
    _, first = menus.render(menu)
    _, second = menus.render(menu)
    assert menus.press(_tokens(first)["Sonnet"], LOC, "7") == (None, "expired")
    token = _tokens(second)["Sonnet"]
    assert menus.press(token, LOC, "7")[0] is not None
    menus.close(menu)
    assert menus.press(token, LOC, "7") == (None, "expired")


def test_a_menu_expires_after_thirty_minutes() -> None:
    clock = Clock()
    menus = mm.ModelMenus(clock=clock)
    _, rows = menus.render(_menu(menus))
    clock.t += mm.MENU_TTL_S + 1
    assert menus.press(_tokens(rows)["Sonnet"], LOC, "7") == (None, "expired")


def test_the_oldest_menu_goes_past_the_cap() -> None:
    menus = mm.ModelMenus()
    first = _menu(menus)
    _, rows = menus.render(first)
    for _ in range(mm.MAX_MENUS):
        _menu(menus)
    assert menus.press(_tokens(rows)["Sonnet"], LOC, "7") == (None, "expired")


def test_steps_pane_then_model_with_the_current_one_ticked() -> None:
    menus = mm.ModelMenus()
    menu = _menu(menus, [_row(), _row("pane-2", "codex", "gpt-5.5", ())])
    body, rows = menus.render(menu)
    assert body == mm.text("en-US", "pick_pane")
    assert [label for label in _tokens(rows)] == ["pane-1 · claude · opus", "pane-2 · codex · gpt-5.5", "✖ Cancel"]
    menu.step, menu.pane_id = "model", "pane-1"
    body, rows = menus.render(menu)
    assert "now on: opus" in body
    labels = list(_tokens(rows))
    assert labels[:4] == ["✓ Opus", "Sonnet", "Haiku", "Fable"]
    assert "⚙️ Also set effort (restarts)" in labels and "◀ Other pane" in labels


def test_one_pane_opens_on_the_model_step() -> None:
    menus = mm.ModelMenus()
    assert _menu(menus).step == "model"


def test_a_cli_with_no_known_models_says_how_to_type_one() -> None:
    menus = mm.ModelMenus()
    menu = _menu(menus, [_row("pane-1", "devin", "", ())])
    body, rows = menus.render(menu)
    assert "/model 1 <model id>" in body
    assert list(_tokens(rows)) == ["✖ Cancel"]


def test_model_options() -> None:
    assert mm.model_options("claude", "sonnet", ["x"]) == mm.CLAUDE_MODELS
    assert mm.model_options("codex", "b", ["a", "b", " ", "a"]) == (("b", "b"), ("a", "a"))
    assert mm.model_options("codex", "", []) == ()


def test_parse_command() -> None:
    assert mm.parse_command("/model") == (None, "", "")
    assert mm.parse_command("/model@navide_bot sonnet") == (None, "sonnet", "")
    assert mm.parse_command("/model 2 opus high") == (2, "opus", "high")
    assert mm.parse_command("/models") is None
    assert mm.parse_command("/model a b c") is None
    assert mm.parse_command("hello") is None


def test_open_callback_is_not_a_token() -> None:
    assert mm.parse_callback(mm.OPEN_CALLBACK) is None


def test_claude_families_match_the_renderers_picker_labels() -> None:
    # liveModelSwitch.ts names the families claude's picker matches an alias to; a family
    # offered here that the renderer does not know would always fall back to a restart.
    root = Path(__file__).resolve().parents[3]
    source = (root / "src/renderer/src/lib/liveModelSwitch.ts").read_text(encoding="utf-8")
    families = re.search(r"CLAUDE_FAMILIES = new Set\(\[([^\]]*)\]\)", source)
    assert families is not None
    assert sorted(re.findall(r"'([a-z]+)'", families.group(1))) == sorted(m for m, _ in mm.CLAUDE_MODELS)


def test_a_chat_switch_is_audited_as_from_the_chat(monkeypatch) -> None:
    from types import SimpleNamespace

    from agent_team_backend.guard import runtime as guard_runtime
    from agent_team_backend.mcp_server import pane_model_tool

    rows: list[dict] = []
    monkeypatch.setattr(guard_runtime, "store", lambda: SimpleNamespace(audit_add=rows.append))
    pane = SimpleNamespace(pane_id="p1", agent_key="claude")
    pane_model_tool._audit(pane, "telegram:alice", "sonnet", "", "picker", source="channel")
    pane_model_tool._audit(pane, "telegram:alice", "sonnet", "high", "", source="channel", refused="pane-busy")
    pane_model_tool._audit(pane, "commander", "opus", "", "slash")
    assert [r["source"] for r in rows] == ["channel", "channel", "agent"]
    assert rows[0]["excerpt"] == "model switched by telegram:alice via chat (picker): model=sonnet"
    assert rows[1]["excerpt"] == "model switch by telegram:alice via chat refused (pane-busy): model=sonnet effort=high"
    assert rows[2]["excerpt"] == "model switched by agent commander via MCP (slash): model=opus"


async def test_the_default_seam_switches_as_the_chat_and_audits_a_refusal(monkeypatch) -> None:
    from types import SimpleNamespace

    from agent_team_backend import agent_messaging
    from agent_team_backend.channels import default_seams
    from agent_team_backend.mcp_server import pane_model_tool

    pane = SimpleNamespace(pane_id="p1", agent_key="claude", workspace_path="/ws")
    monkeypatch.setattr(agent_messaging, "current", lambda pid: pane if pid == "p1" else None)
    asked: list[dict] = []
    answers = [{"ok": True, "pane_id": "p1", "method": "picker"},
               {"ok": False, "error": "busy", "error_code": "pane-busy"}]

    async def switch(p, model, effort, **kw):
        asked.append({"pane": p, "model": model, "effort": effort, **kw})
        return answers.pop(0)

    audited: list[tuple] = []
    monkeypatch.setattr(pane_model_tool, "switch_pane_model", switch)
    monkeypatch.setattr(pane_model_tool, "_audit", lambda *a, **k: audited.append((a, k)))
    seams = default_seams()
    assert (await seams.set_model("p1", "sonnet", "", "telegram:alice"))["ok"]
    assert asked[0]["caller"] is None and asked[0]["source"] == "channel" and asked[0]["who"] == "telegram:alice"
    assert audited == []  # a switch is audited by switch_pane_model itself
    assert (await seams.set_model("p1", "opus", "", "telegram:alice"))["error_code"] == "pane-busy"
    assert audited[0][1] == {"source": "channel", "refused": "pane-busy"}
    assert (await seams.set_model("gone", "opus", "", "x"))["error_code"] == "pane-gone"
