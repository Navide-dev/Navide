"""cli_answer_prompt: an agent answering another pane's permission prompt or
option menu through MCP.

The keys themselves were already reachable (ui.pane.sendKeys, which the chat
relay uses); what these guard is the fence around that path for an agent
caller: the answer binds to the prompt the agent actually read, a permanent
allow, a free-text row, a multi-select menu, an unsupported CLI and a remote
pane are refused with a reason, Navide Guard vetoes approving a high/critical
prompt, and every answer is disclosed in the reply and written to the pane's
Guard audit trail. The raw key channel stays human-only.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend.db import Database
from agent_team_backend.guard import runtime
from agent_team_backend.guard.store import GuardStore
from agent_team_backend.mcp_server import server as plan_mcp
from agent_team_backend.mcp_server import wiring as plan_mcp_wiring

CRITICAL = "Bash command\n\n  rm -rf ~\n  Clean up\n\nDo you want to proceed?"
NORMAL = "Bash command\n\n  npm test\n\nDo you want to proceed?"
MENU = ["Yes", "No, and tell Claude what to do differently (esc)"]
_DEVICE_UUID = "3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071"


@pytest.fixture(autouse=True)
def _clean(tmp_path) -> Any:
    agent_messaging._reset_for_test()
    store = GuardStore(Database(tmp_path / "guard.db"))
    runtime.set_store_for_test(store)
    yield store
    runtime.set_store_for_test(None)
    agent_messaging._reset_for_test()


def _ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _seed(agent_key: str = "claude") -> None:
    agent_messaging.register("pa", "caller", "/ws/alpha")
    agent_messaging.register("pw", "worker", "/ws/alpha", agent_key=agent_key)


class _Window:
    """A fake owning window: answers getStatus with the screen it holds and
    records every sendKeys it is asked for."""

    def __init__(self, prompt: str = NORMAL, options: list[str] | None = None,
                 kind: str = "permission", status: str = "awaiting") -> None:
        self.status = {"status": status, "buffer": "", "awaitingKind": kind}
        if status == "awaiting":
            self.status["awaitingPrompt"] = prompt
            self.status["awaitingOptions"] = list(MENU if options is None else options)
        self.sent: list[dict[str, Any]] = []
        self.send_reply: dict[str, Any] = {"ok": True, "result": {"ok": True, "sent": True}}

    async def __call__(self, workspace_path: str, op: str, **kwargs: Any) -> dict[str, Any]:
        action = kwargs.get("action")
        if action == "ui.pane.getStatus":
            return {"ok": True, "result": dict(self.status)}
        if action == "ui.pane.sendKeys":
            self.sent.append(kwargs["args"])
            return self.send_reply
        raise AssertionError(f"unexpected ui action {action!r}")


def _window(monkeypatch: pytest.MonkeyPatch, **kw: Any) -> _Window:
    window = _Window(**kw)
    monkeypatch.setattr(plan_mcp, "_ui_request", window)

    async def no_git(*_a: Any) -> None:
        return None

    async def no_usage(*_a: Any) -> None:
        return None

    monkeypatch.setattr(plan_mcp, "pane_git", no_git)
    monkeypatch.setattr(plan_mcp, "_cached_usage_snapshot", no_usage)
    return window


async def _fingerprint() -> str:
    status = await plan_mcp.cli_get_status("worker", _ctx())
    return status["prompt_fingerprint"]


async def test_get_status_exposes_a_fingerprint_of_the_prompt_on_screen(monkeypatch) -> None:
    _seed()
    _window(monkeypatch)
    status = await plan_mcp.cli_get_status("worker", _ctx())
    assert status["ui"]["awaitingPrompt"] == NORMAL
    assert status["ui"]["awaitingOptions"] == MENU
    assert status["prompt_fingerprint"] == plan_mcp._prompt_fingerprint(NORMAL, MENU)


async def test_get_status_has_no_fingerprint_when_nothing_is_awaited(monkeypatch) -> None:
    _seed()
    _window(monkeypatch, status="running")
    status = await plan_mcp.cli_get_status("worker", _ctx())
    assert "prompt_fingerprint" not in status


async def test_allow_presses_the_menu_and_is_disclosed_and_audited(monkeypatch, _clean) -> None:
    _seed()
    window = _window(monkeypatch)
    result = await plan_mcp.cli_answer_prompt("worker", "allow", await _fingerprint(), _ctx())

    assert result["ok"] is True and result["sent"] is True
    assert result["answered_by_agent"] is True
    assert "caller" in result["disclosure"]
    assert window.sent == [{"paneId": "pw", "answer": {"kind": "permission", "choice": "allow"},
                            "expected": {"prompt": NORMAL, "options": MENU}}]
    (entry,) = _clean.audit_list(pane_id="pw")
    assert entry["source"] == "agent" and entry["tool"] == "answer_prompt"
    assert entry["action"] == "allow"
    assert "caller" in entry["excerpt"] and "allow" in entry["excerpt"]


async def test_an_option_number_presses_that_option(monkeypatch) -> None:
    _seed()
    options = ["Refactor first", "Ship as is", "Ask the reviewer"]
    window = _window(monkeypatch, prompt="Which way?", options=options, kind="question")
    result = await plan_mcp.cli_answer_prompt("worker", "2", await _fingerprint(), _ctx())
    assert result["ok"] is True
    assert [a["answer"] for a in window.sent] == [{"kind": "question", "option": 2}]
    assert window.sent[0]["expected"] == {"prompt": "Which way?", "options": options}
    assert result["chosen"] == "Ship as is"


async def test_a_changed_prompt_is_refused_with_the_current_one(monkeypatch) -> None:
    _seed()
    window = _window(monkeypatch)
    result = await plan_mcp.cli_answer_prompt("worker", "allow", "stale0000000000", _ctx())
    assert result["ok"] is False and result["error_code"] == "prompt-changed"
    assert result["prompt"] == NORMAL and result["options"] == MENU
    assert result["prompt_fingerprint"] == plan_mcp._prompt_fingerprint(NORMAL, MENU)
    assert window.sent == []


async def test_a_missing_fingerprint_is_refused_too(monkeypatch) -> None:
    _seed()
    window = _window(monkeypatch)
    result = await plan_mcp.cli_answer_prompt("worker", "allow", "", _ctx())
    assert result["error_code"] == "prompt-changed"
    assert window.sent == []


@pytest.mark.parametrize(("options", "answer"), [
    (["Yes", "Yes, and don't ask again for this command", "No"], "2"),
    (["Yes, allow all edits during this session", "No"], "allow"),
])
async def test_a_permanent_allow_is_refused(monkeypatch, options, answer) -> None:
    _seed()
    window = _window(monkeypatch, options=options)
    result = await plan_mcp.cli_answer_prompt("worker", answer, await _fingerprint(), _ctx())
    assert result["ok"] is False and result["error_code"] == "permanent-allow-refused"
    assert window.sent == []


async def test_guard_vetoes_approving_a_critical_prompt(monkeypatch, _clean) -> None:
    _seed()
    window = _window(monkeypatch, prompt=CRITICAL)
    result = await plan_mcp.cli_answer_prompt("worker", "allow", await _fingerprint(), _ctx())
    assert result["ok"] is False and result["error_code"] == "guard-veto"
    assert result["guard"]["level"] in ("high", "critical")
    assert window.sent == []
    rows = _clean.audit_list(pane_id="pw")
    assert any(r["source"] == "agent" and r["tool"] == "answer_prompt" and r["action"] == "deny" for r in rows)


async def test_guard_never_blocks_refusing_a_critical_prompt(monkeypatch) -> None:
    _seed()
    window = _window(monkeypatch, prompt=CRITICAL)
    result = await plan_mcp.cli_answer_prompt("worker", "deny", await _fingerprint(), _ctx())
    assert result["ok"] is True
    assert [a["answer"] for a in window.sent] == [{"kind": "permission", "choice": "deny"}]


async def test_a_free_text_row_is_refused(monkeypatch) -> None:
    _seed()
    window = _window(monkeypatch, prompt="Which?", options=["A", "B", "Type something."], kind="question")
    result = await plan_mcp.cli_answer_prompt("worker", "3", await _fingerprint(), _ctx())
    assert result["ok"] is False and result["error_code"] == "computer-only"
    assert window.sent == []


async def test_a_multi_select_menu_is_refused(monkeypatch) -> None:
    _seed()
    window = _window(monkeypatch, prompt="Which?", options=["[ ] Lint", "[ ] Tests"], kind="question")
    result = await plan_mcp.cli_answer_prompt("worker", "1", await _fingerprint(), _ctx())
    assert result["ok"] is False and result["error_code"] == "computer-only"
    assert window.sent == []


async def test_an_option_not_on_the_menu_is_refused(monkeypatch) -> None:
    _seed()
    window = _window(monkeypatch)
    result = await plan_mcp.cli_answer_prompt("worker", "7", await _fingerprint(), _ctx())
    assert result["ok"] is False and result["error_code"] == "invalid-answer"
    assert window.sent == []


async def test_an_unsupported_cli_is_refused(monkeypatch) -> None:
    _seed(agent_key="kimi")
    window = _window(monkeypatch)
    result = await plan_mcp.cli_answer_prompt("worker", "allow", "x", _ctx())
    assert result["ok"] is False and result["error_code"] == "unsupported-cli"
    assert window.sent == []


async def test_a_pane_that_is_not_waiting_is_refused(monkeypatch) -> None:
    _seed()
    window = _window(monkeypatch, status="running")
    result = await plan_mcp.cli_answer_prompt("worker", "allow", "x", _ctx())
    assert result["ok"] is False and result["error_code"] == "not-awaiting"
    assert window.sent == []


async def test_a_remote_pane_is_refused(monkeypatch) -> None:
    _seed()
    window = _window(monkeypatch)
    result = await plan_mcp.cli_answer_prompt(f"{_DEVICE_UUID}/alpha/worker", "allow", "x", _ctx())
    assert result["ok"] is False and result["error_code"] == "answer-local-only"
    assert window.sent == []


async def test_a_window_that_refuses_the_keys_is_reported_unsent(monkeypatch) -> None:
    _seed()
    window = _window(monkeypatch)
    window.send_reply = {"ok": True, "result": {"ok": False, "sent": False, "error": "no option menu on screen"}}
    result = await plan_mcp.cli_answer_prompt("worker", "allow", await _fingerprint(), _ctx())
    assert result["ok"] is False and result["sent"] is False
    assert "no option menu" in result["error"]


async def test_a_prompt_that_changes_before_the_keys_go_in_is_refused(monkeypatch, _clean) -> None:
    """Guard screened prompt A; by the time the keys reach the window a riskier
    prompt B is on screen. The window compares what it shows with the prompt
    sent along, and its refusal comes back as prompt-changed, not as sent."""
    _seed()
    window = _window(monkeypatch)
    window.send_reply = {"ok": True, "result": {
        "ok": False, "sent": False, "error": "the prompt on screen changed", "error_code": "prompt-changed"}}
    result = await plan_mcp.cli_answer_prompt("worker", "allow", await _fingerprint(), _ctx())
    assert result["ok"] is False and result["sent"] is False
    assert result["error_code"] == "prompt-changed"
    (entry,) = _clean.audit_list(pane_id="pw")
    assert entry["action"] == "error" and "not sent" in entry["excerpt"]


async def test_the_raw_key_channel_stays_human_only() -> None:
    _seed()
    result = await plan_mcp.ui_invoke(
        "/ws/alpha", "ui.pane.sendKeys", _ctx(), args={"paneId": "pw", "answer": {"kind": "permission", "choice": "allow"}},
    )
    assert result["error_code"] == "ui_human_only"
