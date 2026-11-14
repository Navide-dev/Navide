"""Navide Browser 0.2.35 agent tools: tabs, close, evaluate, wait, dialog, upload, take over, raw CDP.

Every test runs against a fake bridge: no Host, no Electron, no real page.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend.plugins.agent_tools_contract import validate_agent_tools

ENTRY = Path(__file__).resolve().parents[2] / "plugins" / "navide-browser" / "backend" / "browser_backend.py"
_spec = importlib.util.spec_from_file_location("navide_browser_backend_tabs_tools", ENTRY)
assert _spec and _spec.loader
browser = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(browser)

PANE = "abcdef12-3456"
SPACE = browser.pane_space_name(PANE)


class Bridge:
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
            view_id = f"n{self.created}"
            self.views.append(_view(view_id, arguments["space"], url=arguments.get("url", "about:blank")))
            return {"viewId": view_id}
        if operation == "close":
            view = next(view for view in self.views if view["viewId"] == arguments["viewId"])
            if view["owner"] != "agent":
                raise browser.BridgeFailure("USER_IN_CONTROL", "user-owned")
            self.views.remove(view)
            return {"ok": True}
        if operation == "setState":
            for view in self.views:
                if view["viewId"] == arguments["viewId"]:
                    view["state"] = arguments["state"]
                    view["note"] = arguments.get("note")
            return {"ok": True}
        if operation == "cdp":
            answer = self.cdp.get(arguments["method"], {})
            if isinstance(answer, Exception):
                raise answer
            if callable(answer):
                answer = answer(arguments.get("params") or {})
            return {"result": answer}
        raise AssertionError(f"unexpected operation {operation}")

    def ops(self, name: str) -> list[dict[str, Any]]:
        return [arguments for operation, arguments in self.calls if operation == name]

    def cdp_calls(self, method: str) -> list[dict[str, Any]]:
        return [arguments for arguments in self.ops("cdp") if arguments["method"] == method]


def _view(view_id: str, space: str = SPACE, owner: str = "agent", **extra: Any) -> dict[str, Any]:
    view = {"viewId": view_id, "space": space, "owner": owner, "control": owner, "state": "running",
            "url": "https://example.com/", "title": "Example", "loading": False, "attached": False}
    view.update(extra)
    return view


def _loaded() -> dict[str, Any]:
    return {"result": {"type": "string", "value": "complete"}}


@pytest.fixture(autouse=True)
def _fresh(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(browser.time, "sleep", lambda _: None)
    browser._active_tabs.clear()


def test_tabs_list_shows_every_tab_with_its_opener_and_the_active_one() -> None:
    bridge = Bridge([_view("v1"), _view("v2", openerViewId="v1", url="https://example.com/popup"), _view("vX", "other")])
    result = browser.run_tool("browser.tabs", {"action": "list"}, bridge, PANE)
    assert result["ok"] is True and result["space"] == SPACE
    assert result["tabs"] == [
        {"viewId": "v1", "url": "https://example.com/", "title": "Example", "active": True},
        {"viewId": "v2", "url": "https://example.com/popup", "title": "Example", "active": False, "openerViewId": "v1"},
    ]


def test_a_new_tab_becomes_the_one_other_tools_act_on() -> None:
    bridge = Bridge([_view("v1")], cdp={"Runtime.evaluate": _loaded(), "Accessibility.getFullAXTree": {"nodes": []}})
    opened = browser.run_tool("browser.tabs", {"action": "new", "url": "https://example.org"}, bridge, PANE)
    assert opened["ok"] is True and opened["viewId"] == "n1" and opened["loaded"] is True
    assert bridge.ops("create") == [{"space": SPACE, "url": "https://example.org"}]
    assert [tab["viewId"] for tab in opened["tabs"] if tab["active"]] == ["n1"]
    snap = browser.run_tool("browser.snapshot", {"scope": "full"}, bridge, PANE)
    assert snap["viewId"] == "n1"


def test_select_and_close_a_tab() -> None:
    bridge = Bridge([_view("v1"), _view("v2")])
    selected = browser.run_tool("browser.tabs", {"action": "select", "tab": "v2"}, bridge, PANE)
    assert [tab["viewId"] for tab in selected["tabs"] if tab["active"]] == ["v2"]
    closed = browser.run_tool("browser.tabs", {"action": "close"}, bridge, PANE)
    assert closed["closed"] == ["v2"]
    assert [tab["viewId"] for tab in closed["tabs"] if tab["active"]] == ["v1"]


def test_a_tab_outside_the_space_is_refused() -> None:
    bridge = Bridge([_view("v1"), _view("vX", "Research")])
    result = browser.run_tool("browser.tabs", {"action": "select", "tab": "vX"}, bridge, PANE)
    assert result["ok"] is False and result["error"] == "NO_TAB"


def test_tabs_of_another_pane_space_stay_out_of_reach() -> None:
    other = browser.pane_space_name("99999999-0000")
    bridge = Bridge([_view("vO", other)])
    result = browser.run_tool("browser.tabs", {"action": "list", "space": other}, bridge, PANE)
    assert result["ok"] is False and result["error"] == "OTHER_PANE_SPACE"


def test_close_all_closes_only_the_agent_tabs() -> None:
    bridge = Bridge([_view("v1"), _view("v2"), _view("vU", owner="user")])
    result = browser.run_tool("browser.close", {"all": True}, bridge, PANE)
    assert result == {"ok": True, "closed": ["v1", "v2"], "skipped": ["vU"]}


def test_close_one_tab_and_a_user_tab_is_refused() -> None:
    bridge = Bridge([_view("v1"), _view("vU", "mine", owner="user")])
    assert browser.run_tool("browser.close", {"tab": "v1"}, bridge, PANE)["closed"] == ["v1"]
    refused = browser.run_tool("browser.close", {"viewId": "vU"}, bridge, PANE)
    assert refused["ok"] is False and refused["error"] == "USER_IN_CONTROL" and refused["reason"] == "user-owned"


def test_open_gives_the_agent_its_own_tab_when_the_user_restored_one_in_its_space() -> None:
    bridge = Bridge([_view("vU", owner="user")], cdp={"Runtime.evaluate": _loaded()})
    opened = browser.run_tool("browser.open", {}, bridge, PANE)
    assert opened["ok"] is True and opened["view"]["viewId"] == "n1"
    assert browser.run_tool("browser.list", {}, bridge, PANE)["yourSpace"] == "n1"


def test_evaluate_returns_the_value_and_cuts_a_long_result() -> None:
    bridge = Bridge([_view("v1")], cdp={"Runtime.evaluate": {"result": {"type": "object", "value": {"a": 1}}}})
    result = browser.run_tool("browser.evaluate", {"expression": "({a: 1})"}, bridge, PANE)
    assert result == {"ok": True, "viewId": "v1", "type": "object", "value": {"a": 1}, "truncated": False}
    params = bridge.cdp_calls("Runtime.evaluate")[0]["params"]
    assert params == {"expression": "({a: 1})", "returnByValue": True, "awaitPromise": True, "timeout": 10000}

    long_bridge = Bridge([_view("v1")], cdp={"Runtime.evaluate": {"result": {"type": "string", "value": "x" * 200_000}}})
    cut = browser.run_tool("browser.evaluate", {"expression": "s", "timeoutMs": 90_000}, long_bridge, PANE)
    assert cut["truncated"] is True and len(cut["valueJson"]) == browser.EVALUATE_MAX_CHARS
    assert long_bridge.cdp_calls("Runtime.evaluate")[0]["params"]["timeout"] == browser.EVALUATE_MAX_TIMEOUT_MS


def test_evaluate_reports_a_thrown_exception() -> None:
    thrown = {"result": {"type": "object"}, "exceptionDetails": {"text": "Uncaught", "exception": {"description": "ReferenceError: x"}}}
    bridge = Bridge([_view("v1")], cdp={"Runtime.evaluate": thrown})
    result = browser.run_tool("browser.evaluate", {"expression": "x"}, bridge, PANE)
    assert result["ok"] is False and result["error"] == "EVALUATE_FAILED" and "ReferenceError" in result["message"]


def test_wait_for_a_url_needs_no_script() -> None:
    bridge = Bridge([_view("v1", url="https://example.com/start")])
    clock = {"t": 0.0}

    def sleep(seconds: float) -> None:
        clock["t"] += seconds
        if clock["t"] >= 0.5:
            bridge.views[0]["url"] = "https://example.com/done?ok=1"

    result = browser.wait(bridge, "v1", {"url": "/done", "urlRegex": r"ok=\d"}, sleep=sleep, clock=lambda: clock["t"])
    assert result["matched"] is True and result["url"].endswith("ok=1")
    assert not bridge.ops("cdp")


def test_wait_for_a_selector_polls_until_it_appears_and_times_out_capped() -> None:
    answers = iter([False, True])
    bridge = Bridge([_view("v1")], cdp={"Runtime.evaluate": lambda _: {"result": {"value": next(answers)}}})
    result = browser.wait(bridge, "v1", {"selector": "#ok"}, sleep=lambda _: None)
    assert result["matched"] is True
    assert '"#ok"' in bridge.cdp_calls("Runtime.evaluate")[0]["params"]["expression"]

    never = Bridge([_view("v1")], cdp={"Runtime.evaluate": {"result": {"value": False}}})
    clock = {"t": 0.0}

    def sleep(seconds: float) -> None:
        clock["t"] += seconds

    timed = browser.wait(never, "v1", {"text": "Thanks", "timeoutMs": 999_999}, sleep=sleep, clock=lambda: clock["t"])
    assert timed["matched"] is False and timed["timedOut"] is True
    assert clock["t"] == pytest.approx(browser.WAIT_MAX_MS / 1000, abs=browser.WAIT_POLL_S)


def test_wait_needs_a_condition_and_a_valid_selector() -> None:
    bridge = Bridge([_view("v1")], cdp={"Runtime.evaluate": {"result": {"value": "invalid-selector"}}})
    assert browser.run_tool("browser.wait", {}, bridge, PANE)["error"] == "INVALID_ARGUMENT"
    assert browser.run_tool("browser.wait", {"urlRegex": "("}, bridge, PANE)["error"] == "INVALID_ARGUMENT"
    assert browser.run_tool("browser.wait", {"selector": "[["}, bridge, PANE)["error"] == "INVALID_ARGUMENT"


def test_dialog_answers_the_open_dialog_and_refuses_when_none_is_open() -> None:
    bridge = Bridge([_view("v1", dialog={"type": "prompt", "message": "Name?", "defaultPrompt": ""})])
    result = browser.run_tool("browser.dialog", {"action": "accept", "promptText": "Ada"}, bridge, PANE)
    assert result == {"ok": True, "viewId": "v1", "handled": "accept", "dialog": {"type": "prompt", "message": "Name?"}}
    assert bridge.cdp_calls("Page.handleJavaScriptDialog")[0]["params"] == {"accept": True, "promptText": "Ada"}

    none = Bridge([_view("v1")])
    refused = browser.run_tool("browser.dialog", {"action": "dismiss"}, none, PANE)
    assert refused["ok"] is False and refused["error"] == "NO_DIALOG"
    assert not none.ops("cdp")


def test_upload_resolves_workspace_paths_and_returns_the_host_disclosure_verbatim() -> None:
    disclosed = {
        "uploaded": [{"file": "secrets/.env", "origin": "https://example.com", "sensitive": True}],
        "warning": "Uploaded files whose names look like secrets: secrets/.env. The user sees this on the Space.",
    }
    bridge = Bridge([_view("v1")], cdp={"DOM.setFileInputFiles": disclosed})
    result = browser.run_tool("browser.upload", {"ref": "@42", "files": ["secrets/.env"]}, bridge, PANE, "/work/repo")
    assert result == {"ok": True, "viewId": "v1", **disclosed}
    params = bridge.cdp_calls("DOM.setFileInputFiles")[0]["params"]
    assert params == {"files": [str(Path("/work/repo") / "secrets/.env")], "backendNodeId": 42}


def test_upload_refusals_are_explained() -> None:
    denied = Bridge([_view("v1")], cdp={"DOM.setFileInputFiles": browser.BridgeFailure("CAPABILITY_DENIED")})
    result = browser.run_tool("browser.upload", {"ref": "@1", "files": ["/etc/passwd"]}, denied, PANE, "/work")
    assert result["ok"] is False and result["error"] == "UPLOAD_DENIED"
    relative = browser.run_tool("browser.upload", {"ref": "@1", "files": ["a.txt"], "space": "s"}, Bridge([_view("v1", "s")]), None)
    assert relative["ok"] is False and relative["error"] == "INVALID_ARGUMENT"
    too_many = browser.run_tool("browser.upload", {"ref": "@1", "files": ["a"] * 17}, Bridge([_view("v1")]), PANE, "/w")
    assert too_many["error"] == "INVALID_ARGUMENT"


def test_take_over_asks_then_waits_and_never_takes_control() -> None:
    bridge = Bridge([_view("v1", control="user", state="need-action")])
    polls = {"count": 0}

    def sleep(_: float) -> None:
        polls["count"] += 1
        if polls["count"] == 2:
            bridge.views[0]["control"] = "agent"

    result = browser.take_over(bridge, "v1", {"note": "Captcha solved?"}, sleep=sleep)
    assert result["asked"] is True and result["control"] == "agent" and result["timedOut"] is False
    assert bridge.ops("setState") == [{"viewId": "v1", "state": "running", "note": "Agent asks to continue: Captcha solved?"}]
    assert {operation for operation, _ in bridge.calls} == {"list", "setState"}


def test_take_over_returns_at_once_when_the_agent_already_has_control() -> None:
    bridge = Bridge([_view("v1")])
    result = browser.run_tool("browser.takeover", {}, bridge, PANE)
    assert result["ok"] is True and result["asked"] is False and result["control"] == "agent"
    assert not bridge.ops("setState")


def test_raw_cdp_forwards_and_explains_a_refused_method() -> None:
    bridge = Bridge([_view("v1")], cdp={"DOM.getBoxModel": {"model": {"width": 3}}})
    result = browser.run_tool("browser.cdp", {"method": "DOM.getBoxModel", "params": {"backendNodeId": 7}}, bridge, PANE)
    assert result == {"ok": True, "viewId": "v1", "method": "DOM.getBoxModel", "value": {"model": {"width": 3}}, "truncated": False}
    assert bridge.cdp_calls("DOM.getBoxModel")[0]["params"] == {"backendNodeId": 7}

    denied = Bridge([_view("v1")], cdp={"Network.getCookies": browser.BridgeFailure("CAPABILITY_DENIED")})
    refused = browser.run_tool("browser.cdp", {"method": "Network.getCookies"}, denied, PANE)
    assert refused["ok"] is False and refused["error"] == "METHOD_NOT_ALLOWED"
    assert "Runtime.evaluate" in refused["message"]


def test_the_manifest_lists_the_host_cdp_allowlist_and_passes_the_contract() -> None:
    manifest = json.loads((ENTRY.parents[1] / "manifest.json").read_text(encoding="utf-8"))
    assert validate_agent_tools(manifest) == []
    tools = {tool["name"]: tool for tool in manifest["backend"]["agentTools"]}
    assert {"browser_close", "browser_tabs", "browser_evaluate", "browser_wait", "browser_dialog", "browser_upload",
            "browser_take_over", "browser_cdp"} <= set(tools)
    assert all(method in tools["browser_cdp"]["description"] for method in browser.HOST_CDP_METHODS)
    assert tools["browser_wait"]["risk"] == "read"
    host = (ENTRY.parents[3] / "src" / "main" / "plugins" / "pluginWebViews.ts").read_text(encoding="utf-8")
    block = host.split("const CDP_ALLOWED_METHODS", 1)[1].split("])", 1)[0]
    assert sorted(browser.HOST_CDP_METHODS) == sorted(line.strip().strip("',") for line in block.splitlines()[1:] if line.strip())


def test_browser_list_shows_an_open_dialog_and_the_opener_of_an_agent_tab() -> None:
    bridge = Bridge([_view("v1"), _view("v2", openerViewId="v1", dialog={"type": "alert", "message": "Saved"})])
    listed = browser.run_tool("browser.list", {}, bridge, PANE)
    assert listed["views"][1]["openerViewId"] == "v1"
    assert listed["views"][1]["dialog"] == {"type": "alert", "message": "Saved"}
