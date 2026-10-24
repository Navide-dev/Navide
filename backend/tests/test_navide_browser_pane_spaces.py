"""Navide Browser backend: a pane reaches only its own Spaces and the ones the user handed to agents."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

ENTRY = Path(__file__).resolve().parents[2] / "plugins" / "navide-browser" / "backend" / "browser_backend.py"
_spec = importlib.util.spec_from_file_location("navide_browser_backend_pane_spaces", ENTRY)
assert _spec and _spec.loader
browser = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(browser)

PANE_A = "aaaaaaaa-1111-4111-8111-111111111111"
PANE_B = "bbbbbbbb-2222-4222-8222-222222222222"


def _bridge(views: list[dict[str, Any]]):
    calls: list[tuple[str, dict[str, Any]]] = []

    def bridge(operation: str, arguments: dict[str, Any]) -> Any:
        calls.append((operation, arguments))
        if operation == "list":
            return {"views": [dict(view) for view in views]}
        if operation == "cdp":
            return {"result": {"nodes": []}}
        return {"ok": True}

    return bridge, calls


def _view(view_id: str, space: str, owner: str = "agent") -> dict[str, Any]:
    return {"viewId": view_id, "space": space, "owner": owner, "control": owner, "state": "running",
            "url": "https://example.com/private", "title": "Private", "loading": False, "attached": False}


def test_a_pane_cannot_drive_another_pane_space_by_view_id() -> None:
    bridge, calls = _bridge([_view("vA", browser.pane_space_name(PANE_A))])
    result = browser.run_tool("browser.snapshot", {"viewId": "vA"}, bridge, PANE_B)
    assert result["ok"] is False
    assert not [args for op, args in calls if op == "cdp"]


def test_a_pane_cannot_drive_another_pane_space_by_name() -> None:
    bridge, calls = _bridge([_view("vA", browser.pane_space_name(PANE_A))])
    result = browser.run_tool("browser.snapshot", {"space": browser.pane_space_name(PANE_A)}, bridge, PANE_B)
    assert result["ok"] is False
    assert not [args for op, args in calls if op == "cdp"]


def test_browser_list_does_not_show_other_panes_or_user_space_urls() -> None:
    bridge, _ = _bridge([_view("vA", browser.pane_space_name(PANE_A)), _view("vU", "mine", owner="user")])
    result = browser.run_tool("browser.list", {}, bridge, PANE_B)
    assert all(view.get("url") in (None, "") for view in result["views"])


def test_a_pane_cannot_open_a_space_under_another_pane_name() -> None:
    bridge, calls = _bridge([])
    result = browser.run_tool("browser.open", {"space": browser.pane_space_name(PANE_A)}, bridge, PANE_B)
    assert result["ok"] is False
    assert not [args for op, args in calls if op == "create"]


def test_a_pane_drives_its_own_space_and_one_the_user_handed_to_agents() -> None:
    bridge, calls = _bridge([_view("vB", browser.pane_space_name(PANE_B)), _view("vD", "shopping")])
    assert browser.run_tool("browser.snapshot", {}, bridge, PANE_B)["ok"] is True
    assert browser.run_tool("browser.snapshot", {"viewId": "vD"}, bridge, PANE_B)["ok"] is True
    assert [args["viewId"] for op, args in calls if op == "cdp"][:1] == ["vB"]
    listed = browser.run_tool("browser.list", {}, bridge, PANE_B)
    assert [view["viewId"] for view in listed["views"]] == ["vB", "vD"]
