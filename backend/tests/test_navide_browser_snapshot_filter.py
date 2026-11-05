"""browser_snapshot filter/root and browser_act diff (plan agent-desktop_f10dcb).

The golden file was written by the snapshot code as it was before these
options existed; without them the answer must stay identical to it.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import re
from pathlib import Path
from typing import Any

import pytest

ENTRY = Path(__file__).resolve().parents[2] / "plugins" / "navide-browser" / "backend" / "browser_backend.py"
_spec = importlib.util.spec_from_file_location("navide_browser_backend_snapshot_filter", ENTRY)
assert _spec and _spec.loader
browser = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(browser)

GOLDEN = json.loads((Path(__file__).parent / "data" / "navide_browser_snapshot_golden.json").read_text(encoding="utf-8"))
VIEW = {"viewId": "v1", "space": "shared", "owner": "agent", "control": "agent", "state": "running"}


class PageBridge:
    """A fake Host: one page whose AX tree, layout and URL a test can change."""

    def __init__(self, page: dict[str, Any] | None = None, url: str = "https://example.com/") -> None:
        self.page = copy.deepcopy(page or GOLDEN)
        self.url = url
        self.views = [dict(VIEW), {**VIEW, "viewId": "v2"}]
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def __call__(self, operation: str, arguments: dict[str, Any]) -> Any:
        self.calls.append((operation, arguments))
        if operation == "list":
            return {"views": [dict(view) for view in self.views]}
        if operation == "close":
            return {"ok": True}
        assert operation == "cdp", operation
        method = arguments["method"]
        if method == "Accessibility.getFullAXTree":
            return {"result": self.page["ax"]}
        if method == "DOMSnapshot.captureSnapshot":
            document = {**self.page["dom"]["documents"][0], "documentURL": 0}
            return {"result": {"documents": [document], "strings": [self.url]}}
        if method == "Runtime.evaluate":
            return {"result": {"result": {"type": "string", "value": self.page["metrics"]}}}
        return {"result": {}}


@pytest.fixture(autouse=True)
def _no_sleep_no_bases(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(browser.time, "sleep", lambda _: None)
    browser._snapshot_bases.clear()  # noqa: SLF001


def _golden_bridge() -> Any:
    def bridge(operation: str, arguments: dict[str, Any]) -> Any:
        method = arguments["method"]
        if method == "Accessibility.getFullAXTree":
            return {"result": GOLDEN["ax"]}
        if method == "DOMSnapshot.captureSnapshot":
            return {"result": GOLDEN["dom"]}
        return {"result": {"result": {"type": "string", "value": GOLDEN["metrics"]}}}

    return bridge


# ── defaults: word for word what the code answered before ───────────────────


@pytest.mark.parametrize("scope", ["viewport", "full"])
def test_without_the_new_options_the_snapshot_is_the_golden_one(scope: str) -> None:
    assert browser.snapshot(_golden_bridge(), "v1", scope) == GOLDEN["expected"][scope]


def test_browser_snapshot_tool_answer_has_no_new_keys_by_default() -> None:
    bridge = PageBridge()
    answer = browser.run_tool("browser.snapshot", {"viewId": "v1"}, bridge, "p1")
    assert answer == {"ok": True, "viewId": "v1", **GOLDEN["expected"]["viewport"]}


def test_act_snapshot_true_is_unchanged_by_default() -> None:
    bridge = PageBridge()
    answer = browser.run_tool("browser.act", {"viewId": "v1", "action": "scroll", "snapshot": True}, bridge, "p1")
    assert answer == {"ok": True, "viewId": "v1", "action": "scroll", **GOLDEN["expected"]["viewport"]}


# ── filter interactive and root ──────────────────────────────────────────────

LINE = re.compile(r"^(\s*)- (\S+)(?: (\"(?:[^\"\\]|\\.)*\"))?.*?(?: (@\d+))?(?: \(\+\d+ hidden\))?$")


def _by_ref(text: str) -> dict[str, tuple[str, str | None]]:
    rows = {}
    for line in text.splitlines():
        match = LINE.match(line)
        assert match, line
        if match.group(4):
            rows[match.group(4)] = (match.group(2), match.group(3))
    return rows


@pytest.mark.parametrize("scope", ["viewport", "full"])
def test_interactive_keeps_controls_headings_and_landmarks_with_the_same_refs(scope: str) -> None:
    full = _by_ref(GOLDEN["expected"][scope]["snapshot"])
    result = browser.snapshot(_golden_bridge(), "v1", scope, "interactive")
    kept = _by_ref(result["snapshot"])
    assert kept, result
    for ref, (role, name) in kept.items():
        assert full[ref] == (role, name), ref
        assert role in browser._INTERACTIVE_ROLES  # noqa: SLF001
    assert "StaticText" not in result["snapshot"]
    assert result["filter"] == "interactive"
    assert result["omitted"] > 0


def test_interactive_says_how_much_a_landmark_hides() -> None:
    lines = browser.snapshot(_golden_bridge(), "v1", "full", "interactive")["snapshot"].splitlines()
    assert "- complementary @40 (+1 hidden)" in lines
    assert '- contentinfo "Footer" @70 (+1 hidden)' in lines
    # A control never carries the marker.
    assert all("hidden" not in line for line in lines if "- button" in line or "- link" in line)


def test_root_lists_only_that_subtree_with_the_full_snapshots_refs() -> None:
    result = browser.snapshot(_golden_bridge(), "v1", "full", "all", "@20")
    assert result["root"] == "@20"
    full = GOLDEN["expected"]["full"]["snapshot"].splitlines()
    start = full.index('  - table "Scores" @20')
    subtree = [full[start]]
    for line in full[start + 1:]:
        if not line.startswith("    "):
            break
        subtree.append(line)
    assert result["snapshot"].splitlines() == [line[2:] for line in subtree]
    assert "filter" not in result


def test_root_and_interactive_combine() -> None:
    result = browser.snapshot(_golden_bridge(), "v1", "full", "interactive", "@30")
    assert result["snapshot"].splitlines() == [
        '- form "Sign up" @30',
        '  - textbox "Email" value="a@b.c" [focused] @31',
        '  - combobox "Plan" value="Pro" @32',
        '  - button "Submit" @33',
    ]


def test_root_that_is_not_on_the_page_is_a_stale_ref() -> None:
    with pytest.raises(browser.ToolError) as caught:
        browser.snapshot(_golden_bridge(), "v1", "full", "all", "@999")
    assert caught.value.code == "STALE_REF"


@pytest.mark.parametrize("arguments", [{"filter": "skeleton"}, {"root": "20"}, {"filter": True}])
def test_bad_filter_or_root_is_an_invalid_argument(arguments: dict[str, Any]) -> None:
    answer = browser.run_tool("browser.snapshot", {"viewId": "v1", **arguments}, PageBridge(), "p1")
    assert answer["ok"] is False and answer["error"] == "INVALID_ARGUMENT"


def test_snapshot_tool_passes_filter_and_root_through() -> None:
    answer = browser.run_tool(
        "browser.snapshot", {"viewId": "v1", "scope": "full", "filter": "interactive", "root": "@4"}, PageBridge(), "p1"
    )
    assert answer["ok"] is True
    assert answer["snapshot"].splitlines() == [
        '- navigation "Primary" @4',
        '  - link "Docs" @5',
        '  - link "Blog" @6',
        '  - button "Menu" @7',
    ]
    assert answer["root"] == "@4" and answer["filter"] == "interactive"


# ── browser_act diff ─────────────────────────────────────────────────────────


def _act(bridge: PageBridge, pane: str = "p1", view: str = "v1", **extra: Any) -> dict[str, Any]:
    answer = browser.run_tool("browser.act", {"viewId": view, "action": "scroll", "diff": True, **extra}, bridge, pane)
    assert answer["ok"] is True, answer
    return answer


def _rename(bridge: PageBridge, node_id: str, name: str) -> None:
    for node in bridge.page["ax"]["nodes"]:
        if node["nodeId"] == node_id:
            node["name"] = {"value": name}


def _snapshot(bridge: PageBridge, pane: str = "p1", view: str = "v1") -> None:
    assert browser.run_tool("browser.snapshot", {"viewId": view}, bridge, pane)["ok"] is True


def test_diff_without_an_earlier_snapshot_is_the_full_one() -> None:
    answer = _act(PageBridge())
    assert answer["mode"] == "full" and answer["fullReason"] == "no-base"
    assert answer["snapshot"] == GOLDEN["expected"]["viewport"]["snapshot"]


def test_diff_after_a_snapshot_returns_only_the_changed_lines() -> None:
    bridge = PageBridge()
    _snapshot(bridge)
    _rename(bridge, "7", "Close menu")
    answer = _act(bridge)
    assert answer["mode"] == "diff"
    assert answer["snapshot"].splitlines() == ['-     - button "Menu" @7', '+     - button "Close menu" @7']
    assert (answer["added"], answer["removed"]) == (1, 1)
    assert "fullReason" not in answer


def test_diff_with_nothing_changed_is_an_empty_diff() -> None:
    bridge = PageBridge()
    _snapshot(bridge)
    answer = _act(bridge)
    assert (answer["mode"], answer["snapshot"], answer["added"], answer["removed"]) == ("diff", "", 0, 0)


def test_diff_chains_from_the_previous_act() -> None:
    bridge = PageBridge()
    _act(bridge)
    _rename(bridge, "7", "Close menu")
    assert _act(bridge)["mode"] == "diff"
    _rename(bridge, "7", "Menu")
    second = _act(bridge)
    assert second["snapshot"].splitlines() == ['-     - button "Close menu" @7', '+     - button "Menu" @7']


def test_diff_after_navigation_is_the_full_snapshot() -> None:
    bridge = PageBridge()
    _snapshot(bridge)
    bridge.url = "https://example.com/next"
    answer = _act(bridge)
    assert answer["mode"] == "full" and answer["fullReason"] == "navigated"


def test_diff_when_every_earlier_ref_is_gone_is_the_full_snapshot() -> None:
    bridge = PageBridge()
    _snapshot(bridge)
    # Same URL, new document: every backend node id is new.
    for node in bridge.page["ax"]["nodes"]:
        node["backendDOMNodeId"] += 1000
    bridge.page["dom"]["documents"][0]["nodes"]["backendNodeId"] = [
        i + 1000 for i in bridge.page["dom"]["documents"][0]["nodes"]["backendNodeId"]
    ]
    answer = _act(bridge)
    assert answer["mode"] == "full" and answer["fullReason"] == "stale"


def test_diff_longer_than_the_snapshot_is_the_full_snapshot() -> None:
    bridge = PageBridge()
    _snapshot(bridge)
    for node in bridge.page["ax"]["nodes"]:
        if node["name"]["value"]:
            node["name"] = {"value": node["name"]["value"] + " (changed)"}
    answer = _act(bridge)
    assert answer["mode"] == "full" and answer["fullReason"] == "larger"


def test_a_filtered_or_rooted_snapshot_is_not_a_diff_base() -> None:
    bridge = PageBridge()
    assert browser.run_tool("browser.snapshot", {"viewId": "v1", "filter": "interactive"}, bridge, "p1")["ok"]
    assert browser.run_tool("browser.snapshot", {"viewId": "v1", "root": "@4"}, bridge, "p1")["ok"]
    assert browser.run_tool("browser.snapshot", {"viewId": "v1", "scope": "full"}, bridge, "p1")["ok"]
    assert _act(bridge)["fullReason"] == "no-base"


def test_diff_base_is_per_pane_and_per_view() -> None:
    bridge = PageBridge()
    _snapshot(bridge, pane="p1", view="v1")
    assert _act(bridge, pane="p2", view="v1")["fullReason"] == "no-base"
    assert _act(bridge, pane="p1", view="v2")["fullReason"] == "no-base"
    assert _act(bridge, pane="p1", view="v1")["mode"] == "diff"


def test_closing_a_tab_forgets_its_diff_base() -> None:
    bridge = PageBridge()
    _snapshot(bridge)
    assert browser.run_tool("browser.close", {"viewId": "v1"}, bridge, "p1")["ok"] is True
    assert _act(bridge)["fullReason"] == "no-base"


def test_diff_must_be_a_boolean() -> None:
    answer = browser.run_tool("browser.act", {"viewId": "v1", "action": "scroll", "diff": "yes"}, PageBridge(), "p1")
    assert answer["ok"] is False and answer["error"] == "INVALID_ARGUMENT"


def test_diff_refs_are_the_full_snapshots_refs() -> None:
    bridge = PageBridge()
    _snapshot(bridge)
    _rename(bridge, "33", "Send")
    bridge.page["metrics"] = "[0, 100, 1440, 900]"  # Submit scrolls into view
    answer = _act(bridge)
    assert answer["mode"] == "diff"
    added = [line[2:] for line in answer["snapshot"].splitlines() if line.startswith("+ ")]
    full = browser.snapshot(bridge, "v1", "viewport")["snapshot"].splitlines()
    assert added and all(line in full for line in added)


# ── a view with no viewport (0x0, never on a window) ─────────────────────────


def _zero_viewport_bridge() -> PageBridge:
    bridge = PageBridge()
    bridge.page["metrics"] = json.dumps([0, 0, 0, 0])
    return bridge


@pytest.mark.parametrize("filter_", ["all", "interactive"])
def test_a_zero_size_viewport_is_an_error_not_an_empty_snapshot(filter_: str) -> None:
    with pytest.raises(browser.ToolError) as raised:
        browser.snapshot(_zero_viewport_bridge(), "v1", "viewport", filter_)
    assert raised.value.code == "VIEW_NOT_RENDERED"


def test_a_zero_size_viewport_fails_the_screenshot_before_it_can_hang() -> None:
    bridge = _zero_viewport_bridge()
    with pytest.raises(browser.ToolError) as raised:
        browser.screenshot(bridge, "v1")
    assert raised.value.code == "VIEW_NOT_RENDERED"
    assert not [call for call in bridge.calls if call[1].get("method") == "Page.captureScreenshot"]


# ── a view that never paints a frame (Linux VM, software rendering) ──────────


class NoFrameBridge(PageBridge):
    def __init__(self, failure: Exception | None = None) -> None:
        super().__init__()
        self.failure = failure
        self.release = __import__("threading").Event()

    def __call__(self, operation: str, arguments: dict[str, Any]) -> Any:
        if arguments.get("method") == "Page.captureScreenshot":
            self.calls.append((operation, arguments))
            if self.failure is not None:
                raise self.failure
            self.release.wait(10)
            return {"result": {}}
        return super().__call__(operation, arguments)


def test_a_screenshot_that_never_answers_is_view_not_rendered_within_five_seconds(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(browser, "SCREENSHOT_WAIT_S", 0.2)
    bridge = NoFrameBridge()
    try:
        with pytest.raises(browser.ToolError) as raised:
            browser.screenshot(bridge, "v1")
    finally:
        bridge.release.set()
    assert raised.value.code == "VIEW_NOT_RENDERED"
    assert raised.value.reason == "no-frame"


def test_the_backstop_is_at_most_five_seconds() -> None:
    assert browser.SCREENSHOT_WAIT_S <= 5.0


def test_the_hosts_no_frame_answer_is_view_not_rendered() -> None:
    failure = browser.BridgeFailure("CDP_ERROR", None, "no-frame: the page produced no frame to capture")
    bridge = NoFrameBridge(failure)
    with pytest.raises(browser.ToolError) as raised:
        browser.screenshot(bridge, "v1")
    assert raised.value.code == "VIEW_NOT_RENDERED"
    assert raised.value.reason == "no-frame"
    assert len([call for call in bridge.calls if call[1].get("method") == "Page.captureScreenshot"]) == 1


def test_other_cdp_failures_still_surface_as_they_did() -> None:
    bridge = NoFrameBridge(browser.BridgeFailure("CDP_ERROR", None, "Target closed"))
    with pytest.raises(browser.BridgeFailure):
        browser.screenshot(bridge, "v1")


def test_a_screenshot_that_answers_returns_the_image() -> None:
    class ShotBridge(PageBridge):
        def __call__(self, operation: str, arguments: dict[str, Any]) -> Any:
            if arguments.get("method") == "Page.captureScreenshot":
                return {"result": {"data": "aGk="}}
            return super().__call__(operation, arguments)

    assert browser.screenshot(ShotBridge(), "v1") == {"mimeType": "image/jpeg", "data": "aGk=", "quality": 70}
