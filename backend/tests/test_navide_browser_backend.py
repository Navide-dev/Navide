"""The navide.browser child drives pages only through the Host ``web`` port.

Every test runs against a fake bridge: no Host, no Electron, no real page.
"""

from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
from typing import Any

import pytest

ENTRY = Path(__file__).resolve().parents[2] / "plugins" / "navide-browser" / "backend" / "browser_backend.py"
_spec = importlib.util.spec_from_file_location("navide_browser_backend", ENTRY)
assert _spec and _spec.loader
browser = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(browser)


class FakeBridge:
    """Records every operation; answers cdp methods from a table."""

    def __init__(self, views: list[dict[str, Any]] | None = None, cdp: dict[str, Any] | None = None):
        self.views = views if views is not None else []
        self.cdp = cdp or {}
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.created = 0

    def __call__(self, operation: str, arguments: dict[str, Any]) -> Any:
        self.calls.append((operation, arguments))
        if operation == "list":
            return {"views": [dict(view) for view in self.views]}
        if operation == "create":
            self.created += 1
            view_id = f"v{self.created}"
            self.views.append(
                {"viewId": view_id, "space": arguments["space"], "owner": "agent", "control": "agent",
                 "state": "running", "url": arguments.get("url", "about:blank"), "title": "", "loading": False,
                 "attached": False}
            )
            return {"viewId": view_id}
        if operation == "setState":
            for view in self.views:
                if view["viewId"] == arguments["viewId"]:
                    view["state"] = arguments["state"]
                    if arguments["state"] == "need-action":
                        view["control"] = "user"
            return {"ok": True}
        if operation == "cdp":
            answer = self.cdp.get(arguments["method"], {})
            if isinstance(answer, Exception):
                raise answer
            if callable(answer):
                answer = answer(arguments.get("params") or {})
            return {"result": answer}
        raise AssertionError(f"unexpected operation {operation}")

    def cdp_calls(self, method: str | None = None) -> list[dict[str, Any]]:
        return [
            arguments for operation, arguments in self.calls
            if operation == "cdp" and (method is None or arguments["method"] == method)
        ]


def _loaded() -> dict[str, Any]:
    return {"result": {"type": "string", "value": "complete"}}


def _no_sleep(_: float) -> None:
    pass


@pytest.fixture(autouse=True)
def _fresh_spaces(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(browser.time, "sleep", _no_sleep)


AX_TREE = {
    "nodes": [
        {"nodeId": "1", "role": {"value": "RootWebArea"}, "name": {"value": "Shop"}, "childIds": ["2", "5"],
         "backendDOMNodeId": 1},
        {"nodeId": "2", "role": {"value": "generic"}, "name": {"value": ""}, "childIds": ["3", "4"],
         "backendDOMNodeId": 2},
        {"nodeId": "3", "role": {"value": "button"}, "name": {"value": "Buy"}, "childIds": [],
         "backendDOMNodeId": 30},
        {"nodeId": "4", "role": {"value": "textbox"}, "name": {"value": "Search"}, "value": {"value": "shoes"},
         "childIds": [], "backendDOMNodeId": 40,
         "properties": [{"name": "focused", "value": {"value": True}}]},
        {"nodeId": "5", "role": {"value": "link"}, "name": {"value": "Footer"}, "childIds": [],
         "backendDOMNodeId": 50},
    ]
}


def test_full_snapshot_is_a_compact_role_name_tree_with_backend_refs() -> None:
    bridge = FakeBridge(cdp={"Accessibility.getFullAXTree": AX_TREE})
    result = browser.snapshot(bridge, "v1", "full")
    assert result["snapshot"].splitlines() == [
        '- button "Buy" @30',
        '- textbox "Search" value="shoes" [focused] @40',
        '- link "Footer" @50',
    ]
    assert result["truncated"] is False


def test_viewport_snapshot_keeps_only_nodes_on_screen() -> None:
    bridge = FakeBridge(cdp={
        "Accessibility.getFullAXTree": AX_TREE,
        "Runtime.evaluate": {"result": {"type": "string", "value": "[0, 0, 800, 600]"}},
        "DOMSnapshot.captureSnapshot": {"documents": [{
            "nodes": {"backendNodeId": [1, 2, 30, 40, 50]},
            "layout": {"nodeIndex": [2, 3, 4], "bounds": [[10, 10, 50, 20], [10, 40, 200, 20], [0, 2000, 80, 20]]},
        }]},
    })
    lines = browser.snapshot(bridge, "v1", "viewport")["snapshot"].splitlines()
    assert lines == ['- button "Buy" @30', '- textbox "Search" value="shoes" [focused] @40']


def test_snapshot_rejects_an_unknown_scope() -> None:
    with pytest.raises(browser.ToolError):
        browser.snapshot(FakeBridge(), "v1", "page")


def test_click_scrolls_then_presses_at_the_box_center() -> None:
    bridge = FakeBridge(cdp={
        "DOM.getBoxModel": {"model": {"content": [10, 20, 30, 20, 30, 40, 10, 40]}},
        "Runtime.evaluate": _loaded(),
    })
    result = browser.act(bridge, "v1", {"action": "click", "ref": "@30"}, sleep=_no_sleep)
    assert result["loaded"] is True
    methods = [call["method"] for call in bridge.cdp_calls()]
    assert methods[:5] == [
        "DOM.scrollIntoViewIfNeeded", "DOM.getBoxModel",
        "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent",
    ]
    assert bridge.cdp_calls("DOM.scrollIntoViewIfNeeded")[0]["params"] == {"backendNodeId": 30}
    press = bridge.cdp_calls("Input.dispatchMouseEvent")[1]["params"]
    assert press == {"type": "mousePressed", "x": 20.0, "y": 30.0, "button": "left", "clickCount": 1}


def test_fill_selects_the_field_then_inserts_text() -> None:
    bridge = FakeBridge(cdp={
        "DOM.resolveNode": {"object": {"objectId": "obj-1"}},
        "Runtime.callFunctionOn": {"result": {"type": "undefined"}},
    })
    browser.act(bridge, "v1", {"action": "fill", "ref": "@40", "value": "boots"}, sleep=_no_sleep)
    assert bridge.cdp_calls("Input.insertText")[0]["params"] == {"text": "boots"}
    assert len(bridge.cdp_calls("Runtime.callFunctionOn")) == 2


def test_press_sends_key_down_and_up_with_modifiers() -> None:
    bridge = FakeBridge()
    browser.act(bridge, "v1", {"action": "press", "key": "Control+a"}, sleep=_no_sleep)
    events = [call["params"] for call in bridge.cdp_calls("Input.dispatchKeyEvent")]
    assert events[0]["type"] == "rawKeyDown" and events[0]["key"] == "a" and events[0]["modifiers"] == 2
    assert "text" not in events[0]
    assert events[1]["type"] == "keyUp"


def test_select_reports_a_missing_option() -> None:
    bridge = FakeBridge(cdp={
        "DOM.resolveNode": {"object": {"objectId": "obj-1"}},
        "Runtime.callFunctionOn": {"result": {"type": "object", "value": {"ok": False, "error": "no-option"}}},
    })
    with pytest.raises(browser.ToolError) as raised:
        browser.act(bridge, "v1", {"action": "select", "ref": "@40", "value": "XL"}, sleep=_no_sleep)
    assert "no-option" in raised.value.message


def test_goto_refuses_a_non_http_url() -> None:
    with pytest.raises(browser.ToolError):
        browser.act(FakeBridge(), "v1", {"action": "goto", "url": "file:///etc/passwd"}, sleep=_no_sleep)


def test_back_navigates_to_the_previous_history_entry() -> None:
    bridge = FakeBridge(cdp={
        "Page.getNavigationHistory": {"currentIndex": 1, "entries": [{"id": 7}, {"id": 8}]},
        "Runtime.evaluate": _loaded(),
    })
    browser.act(bridge, "v1", {"action": "back"}, sleep=_no_sleep)
    assert bridge.cdp_calls("Page.navigateToHistoryEntry")[0]["params"] == {"entryId": 7}


def test_wait_for_load_polls_ready_state_until_complete() -> None:
    states = iter(["loading", "interactive", "complete"])
    bridge = FakeBridge(cdp={"Runtime.evaluate": lambda _: {"result": {"type": "string", "value": next(states)}}})
    assert browser.wait_for_load(bridge, "v1", sleep=_no_sleep) is True
    assert len(bridge.cdp_calls("Runtime.evaluate")) == 3


def test_screenshot_steps_quality_down_until_it_fits(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(browser, "SCREENSHOT_MAX_BASE64", 10)
    bridge = FakeBridge(cdp={
        "Page.captureScreenshot": lambda params: {"data": "A" * (40 if params["quality"] > 35 else 8)},
    })
    result = browser.screenshot(bridge, "v1")
    assert result["quality"] == 35 and result["mimeType"] == "image/jpeg"


def test_open_creates_one_space_per_pane_and_reuses_it() -> None:
    bridge = FakeBridge(cdp={"Runtime.evaluate": _loaded(), "Page.navigate": {"frameId": "f"}})
    first = browser.run_tool("browser.open", {"url": "https://example.com"}, bridge, "p1")
    second = browser.run_tool("browser.open", {"url": "https://example.org"}, bridge, "p1")
    other = browser.run_tool("browser.open", {}, bridge, "p2")
    assert first["ok"] and first["view"]["viewId"] == "v1" and first["view"]["space"] == "pane-p1"
    assert second["view"]["viewId"] == "v1"
    assert other["view"]["viewId"] == "v2"
    assert [arguments for operation, arguments in bridge.calls if operation == "create"] == [
        {"space": "pane-p1", "url": "https://example.com"},
        {"space": "pane-p2"},
    ]
    assert bridge.cdp_calls("Page.navigate")[0]["params"] == {"url": "https://example.org"}


def test_the_pane_space_is_found_again_by_name_after_a_restart() -> None:
    bridge = FakeBridge(views=[
        {"viewId": "v7", "space": "pane-12345678", "owner": "agent", "control": "agent", "state": "running"},
        {"viewId": "v8", "space": "pane-87654321", "owner": "agent", "control": "agent", "state": "running"},
    ], cdp={"Runtime.evaluate": _loaded(), "Page.navigate": {"frameId": "f"}})
    listed = browser.run_tool("browser.list", {}, bridge, "12345678-aaaa")
    opened = browser.run_tool("browser.open", {"url": "https://example.com"}, bridge, "12345678-aaaa")
    assert listed["yourSpace"] == "v7"
    assert opened["view"]["viewId"] == "v7"
    assert bridge.created == 0


def test_a_named_space_overrides_the_pane_default_and_is_found_again() -> None:
    bridge = FakeBridge(cdp={"Runtime.evaluate": _loaded()})
    opened = browser.run_tool("browser.open", {"space": "Research"}, bridge, "p1")
    snap = browser.run_tool("browser.snapshot", {"space": "Research", "scope": "full"}, bridge, "p1")
    assert opened["view"]["space"] == "Research"
    assert snap["viewId"] == opened["view"]["viewId"]


def test_a_call_from_outside_a_pane_must_name_its_space() -> None:
    bridge = FakeBridge(cdp={"Runtime.evaluate": _loaded()})
    refused = browser.run_tool("browser.open", {}, bridge, None)
    assert refused["ok"] is False and refused["error"] == "SPACE_REQUIRED"
    assert bridge.created == 0
    opened = browser.run_tool("browser.open", {"space": "Nightly check"}, bridge, None)
    assert opened["ok"] is True and opened["view"]["space"] == "Nightly check"


def test_a_tool_before_open_says_to_open_first() -> None:
    result = browser.run_tool("browser.snapshot", {}, FakeBridge(), "p1")
    assert result["ok"] is False and result["error"] == "NO_SPACE"


def test_user_in_control_comes_back_with_its_reason() -> None:
    refusal = browser.BridgeFailure("USER_IN_CONTROL", "manual_takeover")
    bridge = FakeBridge(cdp={"Accessibility.getFullAXTree": refusal})
    result = browser.run_tool("browser.snapshot", {"viewId": "v9", "scope": "full"}, bridge, "p1")
    assert result["ok"] is False
    assert result["error"] == "USER_IN_CONTROL"
    assert result["reason"] == "manual_takeover"
    assert "browser_wait_for_control" in result["message"]


def test_other_bridge_failures_stay_plugin_errors() -> None:
    bridge = FakeBridge(cdp={"Accessibility.getFullAXTree": browser.BridgeFailure("CAPABILITY_DENIED")})
    with pytest.raises(browser.BridgeFailure):
        browser.run_tool("browser.snapshot", {"viewId": "v9"}, bridge, "p1")


def test_handoff_then_wait_for_control_returns_when_the_user_hands_back() -> None:
    bridge = FakeBridge(cdp={"Runtime.evaluate": _loaded()})
    browser.run_tool("browser.open", {}, bridge, "p1")
    handoff = browser.run_tool("browser.handoff", {"note": "Solve the captcha"}, bridge, "p1")
    assert handoff["state"] == "need-action"
    assert ("setState", {"viewId": "v1", "state": "need-action", "note": "Solve the captcha"}) in bridge.calls

    polls = {"count": 0}

    def sleep(_: float) -> None:
        polls["count"] += 1
        if polls["count"] == 2:
            bridge.views[0]["control"] = "agent"

    result = browser.wait_for_control(bridge, "v1", 50_000, sleep=sleep)
    assert result["control"] == "agent" and result["timedOut"] is False
    assert not any(operation not in ("list",) for operation, _ in bridge.calls[-3:])


def test_wait_for_control_times_out_without_taking_control() -> None:
    bridge = FakeBridge(views=[{"viewId": "v1", "owner": "agent", "control": "user", "state": "need-action"}])
    now = {"t": 0.0}

    def sleep(seconds: float) -> None:
        now["t"] += seconds

    result = browser.wait_for_control(bridge, "v1", 3000, sleep=sleep, clock=lambda: now["t"])
    assert result["timedOut"] is True and result["control"] == "user"
    assert {operation for operation, _ in bridge.calls} == {"list"}


def test_wait_for_control_is_capped_at_fifty_seconds(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, int] = {}

    def fake_wait(bridge: Any, view_id: str, timeout_ms: int, **_: Any) -> dict[str, Any]:
        seen["timeout"] = timeout_ms
        return {"control": "agent", "timedOut": False}

    monkeypatch.setattr(browser, "wait_for_control", fake_wait)
    browser.run_tool("browser.control.wait", {"viewId": "v1", "timeoutMs": 120_000}, FakeBridge(), None)
    assert seen["timeout"] == 50_000


def test_finish_marks_the_space_done() -> None:
    bridge = FakeBridge(views=[{"viewId": "v1", "owner": "agent", "control": "agent", "state": "running"}])
    result = browser.run_tool("browser.finish", {"viewId": "v1"}, bridge, None)
    assert result == {"ok": True, "viewId": "v1", "state": "done"}


def _call_frame(request_id: int, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "navide/call",
        "params": {
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": browser.PROTOCOL_REVISION,
                "io.modelcontextprotocol/clientCapabilities": {},
            },
            "name": name,
            "arguments": arguments,
            "runtime": {
                "pluginId": "navide.browser", "packageVersion": "0.2.27", "workspaceId": None,
                "instanceId": None, "contributionKey": None, "hostWindowId": None,
                "initiator": {
                    "kind": "agent", "source": "mcp", "id": "call-uuid-" + str(request_id),
                    "caller": {"kind": "pane", "paneId": "abcdef1234567890", "workspace": "/w"},
                },
            },
        },
    }


def test_wire_call_routes_through_the_web_bridge_port(monkeypatch: pytest.MonkeyPatch) -> None:
    out = io.BytesIO()
    monkeypatch.setattr(browser.sys, "stdout", type("S", (), {"buffer": out})())
    seen: list[tuple[str, str, Any]] = []

    def fake_bridge_call(origin: dict[str, Any], port: str, operation: str, arguments: Any) -> Any:
        seen.append((port, operation, arguments))
        return {"views": [{"viewId": "v3", "space": "pane-abcdef12", "owner": "agent", "control": "agent", "state": "idle"}]}

    monkeypatch.setattr(browser, "_bridge_call", fake_bridge_call)
    browser._handle(_call_frame(1, "browser.list", {}))
    frame = json.loads(out.getvalue().decode().strip())
    assert seen == [("web", "list", {})]
    # The pane comes from caller.paneId, never from the per-call initiator id.
    assert frame["result"]["value"]["yourSpace"] == "v3"


def test_wire_unknown_method_is_method_not_found(monkeypatch: pytest.MonkeyPatch) -> None:
    out = io.BytesIO()
    monkeypatch.setattr(browser.sys, "stdout", type("S", (), {"buffer": out})())
    browser._handle(_call_frame(2, "browser.evaluate", {}))
    frame = json.loads(out.getvalue().decode().strip())
    assert frame["error"]["code"] == -32601


def test_bridge_error_keeps_the_reason() -> None:
    import queue

    response_queue: queue.Queue[Any] = queue.Queue(maxsize=1)
    browser._bridge_pending["bridge:abc"] = response_queue
    try:
        browser._bridge_result({
            "jsonrpc": "2.0", "id": "bridge:abc",
            "error": {"code": 1000, "message": "x", "data": {"code": "USER_IN_CONTROL", "reason": "user-owned"}},
        })
    finally:
        browser._bridge_pending.pop("bridge:abc", None)
    assert response_queue.get_nowait() == ("error", ("USER_IN_CONTROL", "user-owned", None))


def test_manifest_tools_match_the_backend_methods() -> None:
    manifest = json.loads((ENTRY.parents[1] / "manifest.json").read_text(encoding="utf-8"))
    backend = manifest["backend"]
    assert set(backend["methods"]) == browser.TOOL_METHODS
    assert {tool["method"] for tool in backend["agentTools"]} == browser.TOOL_METHODS
    assert all(tool["name"].startswith("browser_") for tool in backend["agentTools"])
    wait = next(tool for tool in backend["agentTools"] if tool["name"] == "browser_wait_for_control")
    assert wait["timeoutMs"] > browser.WAIT_FOR_CONTROL_MAX_MS
