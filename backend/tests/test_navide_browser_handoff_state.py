"""A Space an agent handed to the user keeps saying so (plan agent-desktop_f10dcb n3).

B1: after browser_handoff the reason an agent reads is the handoff, not "the
user took over". B2: on a Space the user handed to agents (any pane may use
it), another pane's browser_take_over or browser_finish must not wipe the
handoff's need-action state and note while the user still holds control.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

import pytest

ENTRY = Path(__file__).resolve().parents[2] / "plugins" / "navide-browser" / "backend" / "browser_backend.py"
_spec = importlib.util.spec_from_file_location("navide_browser_backend_handoff_state", ENTRY)
assert _spec and _spec.loader
browser = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(browser)


class HostBridge:
    """The Host's view bookkeeping as pluginWebViews keeps it, for one shared Space."""

    def __init__(self) -> None:
        self.view = {"viewId": "v1", "space": "shared", "owner": "agent", "control": "agent", "state": "running"}

    def __call__(self, operation: str, arguments: dict[str, Any]) -> Any:
        if operation == "list":
            return {"views": [dict(self.view)]}
        if operation == "setState":
            self.view["state"] = arguments["state"]
            if "note" in arguments:
                self.view["note"] = arguments["note"]
            else:
                self.view.pop("note", None)
            if arguments["state"] == "need-action" and self.view["control"] == "agent":
                self.view.update(control="user", reason="agent_handoff")
            return {"ok": True}
        if operation == "cdp":
            if self.view["control"] != "agent":
                raise browser.BridgeFailure("USER_IN_CONTROL", self.view.get("reason"))
            return {"result": {}}
        if operation == "close":
            return {"ok": True}
        raise AssertionError(operation)

    def user_returns_control(self) -> None:
        self.view.update(control="agent", state="running")
        self.view.pop("reason", None)


@pytest.fixture(autouse=True)
def _fast(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(browser.time, "sleep", lambda _: None)
    monkeypatch.setattr(browser, "WAIT_FOR_CONTROL_MAX_MS", 0)
    getattr(browser, "_handoffs", {}).clear()


def _handoff(bridge: HostBridge, pane: str, note: str = "Solve the captcha") -> None:
    assert browser.run_tool("browser.handoff", {"viewId": "v1", "note": note}, bridge, pane)["ok"] is True


# ── B1 ───────────────────────────────────────────────────────────────────────


def test_after_a_handoff_the_agent_is_told_it_was_a_handoff() -> None:
    bridge = HostBridge()
    _handoff(bridge, "pane-a")
    answer = browser.run_tool("browser.act", {"viewId": "v1", "action": "press", "key": "Enter"}, bridge, "pane-b")
    assert answer["ok"] is False and answer["error"] == "USER_IN_CONTROL"
    assert answer["reason"] == "agent_handoff"
    assert "took over" not in answer["message"]
    assert "browser_handoff" in answer["message"] and "browser_wait_for_control" in answer["message"]


def test_a_manual_takeover_still_says_the_user_took_over() -> None:
    error = browser._user_in_control("manual_takeover")  # noqa: SLF001
    assert error.reason == "manual_takeover" and "The user took over" in error.message


# ── B2 ───────────────────────────────────────────────────────────────────────


def test_another_panes_take_over_keeps_the_pending_handoff() -> None:
    bridge = HostBridge()
    _handoff(bridge, "pane-a")
    answer = browser.run_tool("browser.takeover", {"viewId": "v1", "note": "B wants the page", "timeoutMs": 0}, bridge, "pane-b")
    assert answer["ok"] is True and answer["control"] == "user"
    assert bridge.view["state"] == "need-action"
    assert bridge.view["note"] == "Solve the captcha"


def test_another_panes_finish_keeps_the_pending_handoff() -> None:
    bridge = HostBridge()
    _handoff(bridge, "pane-a")
    answer = browser.run_tool("browser.finish", {"viewId": "v1", "note": "B is done"}, bridge, "pane-b")
    assert answer["ok"] is True
    assert answer["state"] == "need-action"
    assert bridge.view["state"] == "need-action"
    assert bridge.view["note"] == "Solve the captcha"


def test_the_pane_that_handed_off_may_still_finish_or_ask_back() -> None:
    bridge = HostBridge()
    _handoff(bridge, "pane-a")
    assert browser.run_tool("browser.finish", {"viewId": "v1", "note": "gave up"}, bridge, "pane-a")["state"] == "done"
    assert bridge.view["state"] == "done"

    bridge = HostBridge()
    _handoff(bridge, "pane-a")
    browser.run_tool("browser.takeover", {"viewId": "v1", "timeoutMs": 0}, bridge, "pane-a")
    assert bridge.view["state"] == "running"


def test_once_the_user_returns_control_other_panes_finish_as_before() -> None:
    bridge = HostBridge()
    _handoff(bridge, "pane-a")
    bridge.user_returns_control()
    assert browser.run_tool("browser.finish", {"viewId": "v1"}, bridge, "pane-b")["state"] == "done"
    assert bridge.view["state"] == "done"


def test_a_manual_takeover_without_handoff_is_asked_back_as_before() -> None:
    bridge = HostBridge()
    bridge.view.update(control="user", reason="manual_takeover")
    browser.run_tool("browser.takeover", {"viewId": "v1", "note": "please", "timeoutMs": 0}, bridge, "pane-b")
    assert bridge.view["state"] == "running"
    assert bridge.view["note"].endswith(": please")


def test_a_need_action_of_unknown_origin_is_asked_back_as_before() -> None:
    # Set before a restart, or not through browser_handoff: nothing records
    # which pane it belongs to, so take_over writes its request as it always did.
    bridge = HostBridge()
    bridge.view.update(control="user", state="need-action", note="old request", reason="agent_handoff")
    browser.run_tool("browser.takeover", {"viewId": "v1", "note": "please", "timeoutMs": 0}, bridge, "pane-b")
    assert bridge.view["state"] == "running"
    assert bridge.view["note"].endswith(": please")
    assert browser.run_tool("browser.finish", {"viewId": "v1"}, bridge, "pane-b")["state"] == "done"
