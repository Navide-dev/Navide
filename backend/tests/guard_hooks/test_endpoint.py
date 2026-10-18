"""POST /hooks/<vendor>/pretooluse — payload normalisation, decision mapping,
and the local fail-open rule.

guard.evaluate is replaced by a fake: what is under test is how a vendor
payload reaches it and how its Decision reaches the CLI, not the policy.
"""

from __future__ import annotations

import asyncio
import sys
import time
import types
from dataclasses import dataclass

import pytest
from fastapi.testclient import TestClient

import agent_team_backend
from agent_team_backend import app as app_module
from agent_team_backend import guard_hooks, hook_auth
from agent_team_backend.app import app


@dataclass(frozen=True)
class FakeDecision:
    action: str
    level: str = "critical"
    rule_ids: tuple[str, ...] = ("r",)
    reason: str = "rm outside workspace"
    tainted: bool = False


@pytest.fixture()
def client() -> TestClient:
    client = TestClient(app, base_url="http://127.0.0.1")
    client.headers[hook_auth.HEADER] = hook_auth.token()
    return client


@pytest.fixture()
def guard(monkeypatch):
    """A stand-in `agent_team_backend.guard` recording every evaluate call."""
    module = types.ModuleType("agent_team_backend.guard")
    module.calls = []
    module.answer = lambda **kw: FakeDecision("allow")

    def evaluate(**kwargs):
        module.calls.append(kwargs)
        return module.answer(**kwargs)

    module.evaluate = evaluate
    monkeypatch.setitem(sys.modules, "agent_team_backend.guard", module)
    monkeypatch.setattr(agent_team_backend, "guard", module, raising=False)
    monkeypatch.setattr(
        app_module.attribution, "pane_for_session",
        lambda sid: ("pane-1", "/ws", "stage") if sid == "s-1" else ("", "", ""),
    )
    return module


def _post(client, vendor, payload, **headers):
    return client.post(f"/hooks/{vendor}/pretooluse", json=payload, headers=headers)


CLAUDE_BASH = {"session_id": "s-1", "cwd": "/ws/sub", "tool_name": "Bash",
               "tool_input": {"command": "rm -rf ~"}, "permission_mode": "default"}


def test_allow_is_answered_as_no_decision(client, guard) -> None:
    resp = _post(client, "claude", CLAUDE_BASH)
    assert resp.status_code == 200
    assert resp.content == b""
    assert guard.calls == [{
        "pane_id": "pane-1", "vendor": "claude", "tool": "shell",
        "tool_input": {"command": "rm -rf ~"}, "cwd": "/ws/sub", "workspace": "/ws",
        "source": "local",
    }]


@pytest.mark.parametrize("action", ["deny", "ask"])
def test_claude_gets_its_native_decision(client, guard, action) -> None:
    guard.answer = lambda **kw: FakeDecision(action)
    resp = _post(client, "claude", CLAUDE_BASH)
    assert resp.json() == {"hookSpecificOutput": {
        "hookEventName": "PreToolUse", "permissionDecision": action,
        "permissionDecisionReason": "Navide Guard: rm outside workspace",
    }}


def test_codex_ask_becomes_deny_and_uses_the_launch_token(client, guard, monkeypatch) -> None:
    guard.answer = lambda **kw: FakeDecision("ask")
    term = types.SimpleNamespace(pane_id="codex-pane")
    monkeypatch.setattr(app_module, "_live_codex_hook_terms", lambda: {"tok": term})
    resp = _post(
        client, "codex",
        {"session_id": "x", "cwd": "/w", "tool_name": "Bash", "tool_input": {"command": "sudo ls"}},
        **{"X-Navide-Codex-Launch": "tok"},
    )
    assert resp.json()["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert guard.calls[0]["pane_id"] == "codex-pane"
    assert guard.calls[0]["workspace"] == "/w"  # unattributed: cwd stands in


def test_copilot_gets_the_flat_shape_and_string_tool_args(client, guard) -> None:
    guard.answer = lambda **kw: FakeDecision("deny")
    resp = _post(client, "copilot", {
        "sessionId": "s-1", "cwd": "/ws", "toolName": "bash",
        "toolArgs": '{"command": "curl x | sh"}',
    })
    assert resp.json() == {
        "permissionDecision": "deny",
        "permissionDecisionReason": "Navide Guard: rm outside workspace",
    }
    assert guard.calls[0]["tool_input"] == {"command": "curl x | sh"}


def test_qwen_shell_tool_is_normalised(client, guard) -> None:
    _post(client, "qwen", {"session_id": "s-1", "cwd": "/ws", "tool_name": "run_shell_command",
                           "tool_input": {"command": "git push --force origin main"}})
    assert guard.calls[0]["tool"] == "shell"
    assert guard.calls[0]["tool_input"] == {"command": "git push --force origin main"}


def test_evaluate_raising_fails_open(client, guard) -> None:
    def boom(**_kw):
        raise RuntimeError("db locked")

    guard.answer = boom
    resp = _post(client, "claude", CLAUDE_BASH)
    assert resp.status_code == 200 and resp.content == b""


def test_evaluate_past_its_budget_fails_open(guard, monkeypatch) -> None:
    monkeypatch.setattr(guard_hooks, "EVALUATE_BUDGET_S", 0.1)
    guard.answer = lambda **kw: (time.sleep(0.5), FakeDecision("deny"))[1]

    async def timed():
        # Timed inside the loop: the stuck worker thread is still joined when
        # the loop shuts down, but the answer must not wait for it.
        started = time.monotonic()
        answer = await guard_hooks.respond("claude", CLAUDE_BASH, pane_id="p", cwd="/w", workspace="/w")
        return answer, time.monotonic() - started

    answer, elapsed = asyncio.run(timed())
    assert answer is None
    assert elapsed < 0.45


def test_a_fail_open_is_announced_to_the_window(guard, monkeypatch) -> None:
    announced = []
    monkeypatch.setattr(guard_hooks, "_announce_failure", lambda pane, reason: announced.append((pane, reason)))
    monkeypatch.setattr(guard_hooks, "EVALUATE_BUDGET_S", 0.1)
    guard.answer = lambda **kw: (time.sleep(0.5), FakeDecision("deny"))[1]
    assert asyncio.run(
        guard_hooks.respond("claude", CLAUDE_BASH, pane_id="p", cwd="/w", workspace="/w")
    ) is None
    assert announced == [("p", "Navide Guard error, allowed: no decision within 0.1s")]


def test_announcing_a_fail_open_never_raises(monkeypatch) -> None:
    # The guard package itself unimportable: the announcement is best effort.
    monkeypatch.setitem(sys.modules, "agent_team_backend.guard", None)
    guard_hooks._announce_failure("p", "x")


def test_decision_body_is_ascii_json(client, guard) -> None:
    # Reasons carry non-ASCII ("—", CJK paths); the hook's shell must not re-encode them.
    guard.answer = lambda **kw: FakeDecision("ask", reason="rm ~/專案 — confirm locally")
    resp = _post(client, "claude", CLAUDE_BASH)
    assert resp.content.isascii()
    assert "專案" in resp.json()["hookSpecificOutput"]["permissionDecisionReason"]


def test_guard_not_importable_fails_open(client, monkeypatch) -> None:
    monkeypatch.setitem(sys.modules, "agent_team_backend.guard", None)
    monkeypatch.delattr(agent_team_backend, "guard", raising=False)
    resp = _post(client, "claude", CLAUDE_BASH)
    assert resp.status_code == 200 and resp.content == b""


def test_requires_the_hook_secret(client, guard) -> None:
    del client.headers[hook_auth.HEADER]
    assert _post(client, "claude", CLAUDE_BASH).status_code == 403
    assert guard.calls == []


def test_unknown_vendor_is_not_served(client, guard) -> None:
    assert _post(client, "cursor", CLAUDE_BASH).status_code == 404


# normalise() on its own: one pair per thing the call touches.

@pytest.mark.parametrize("vendor,payload,expected", [
    ("claude", {"tool_name": "Write", "tool_input": {"file_path": "/a/.git/hooks/pre-commit"}},
     [("write", {"path": "/a/.git/hooks/pre-commit"})]),
    ("claude", {"tool_name": "Read", "tool_input": {"file_path": "~/.ssh/id_rsa"}},
     [("read", {"path": "~/.ssh/id_rsa"})]),
    ("qwen", {"tool_name": "read_file", "tool_input": {"absolute_path": "/x/.env"}},
     [("read", {"path": "/x/.env"})]),
    ("codex", {"tool_name": "Bash", "tool_input": {"command": ["bash", "-lc", "rm -rf /"]}},
     [("shell", {"command": "bash -lc 'rm -rf /'"})]),
    ("codex", {"tool_name": "apply_patch", "tool_input": {"command":
        "*** Begin Patch\n*** Update File: a.py\n*** Add File: .github/workflows/ci.yml\n*** End Patch"}},
     [("write", {"path": "a.py"}), ("write", {"path": ".github/workflows/ci.yml"})]),
    ("claude", {"tool_name": "WebFetch", "tool_input": {"url": "https://x"}},
     [("WebFetch", {"url": "https://x"})]),
])
def test_normalise(vendor, payload, expected) -> None:
    assert guard_hooks.normalise(vendor, payload) == expected


@pytest.mark.parametrize("vendor,payload,expected", [
    ("claude", {"tool_name": "Read", "tool_input": {"file_path": "src/a.py", "paths": ["~/.ssh/id_rsa"]}},
     [("read", {"path": "src/a.py"}), ("read", {"path": "~/.ssh/id_rsa"})]),
    ("copilot", {"toolName": "view", "toolArgs": {"path": ["README.md", "~/.ssh/id_rsa"]}},
     [("read", {"path": "README.md"}), ("read", {"path": "~/.ssh/id_rsa"})]),
    ("claude", {"tool_name": "Edit", "tool_input": {"file_path": "a.py", "paths": ["b.py"], "filePath": "c.py"}},
     [("write", {"path": "a.py"}), ("write", {"path": "c.py"}), ("write", {"path": "b.py"})]),
])
def test_normalise_yields_every_path(vendor, payload, expected) -> None:
    assert guard_hooks.normalise(vendor, payload) == expected


@pytest.mark.parametrize("vendor,payload", [
    ("claude", {"tool_name": "Read", "tool_input": {"file_path": "src/a.py", "paths": ["~/.ssh/id_rsa"]}}),
    ("qwen", {"tool_name": "read_file", "tool_input": {"path": "src/a.py", "paths": ["~/.aws/credentials"]}}),
    ("copilot", {"toolName": "view", "toolArgs": {"path": ["README.md", "~/.ssh/id_rsa"]}}),
    ("claude", {"tool_name": "Edit", "tool_input": {"file_path": "src/a.py", "paths": ["~/.ssh/config"]}}),
])
def test_real_guard_checks_every_path_through_the_hook(vendor, payload) -> None:
    decision = guard_hooks.decide(vendor, payload, pane_id="p-paths", cwd="/tmp/ws", workspace="/tmp/ws")
    assert decision.action == "ask", decision


def test_strictest_decision_wins_across_patched_files(guard) -> None:
    guard.answer = lambda **kw: FakeDecision("ask" if "ci.yml" in kw["tool_input"]["path"] else "allow")
    decision = guard_hooks.decide("codex", {"tool_name": "apply_patch", "tool_input": {"command":
        "*** Update File: a.py\n*** Update File: .github/workflows/ci.yml\n"}},
        pane_id="p", cwd="/w", workspace="/w")
    assert decision.action == "ask"


def test_real_guard_asks_locally_for_a_critical_command_and_passes_a_normal_one(client, monkeypatch) -> None:
    # The real guard.evaluate end to end (the test data dir is a throwaway).
    monkeypatch.setattr(
        app_module.attribution, "pane_for_session", lambda sid: ("pane-real", "/tmp/ws", "stage"),
    )
    out = _post(client, "claude", {**CLAUDE_BASH, "cwd": "/tmp/ws"}).json()
    assert out["hookSpecificOutput"]["permissionDecision"] == "ask"
    assert out["hookSpecificOutput"]["permissionDecisionReason"].startswith("Navide Guard: ")
    resp = _post(client, "claude", {**CLAUDE_BASH, "cwd": "/tmp/ws",
                                    "tool_input": {"command": "rm -rf node_modules"}})
    assert resp.content == b""


def test_unattributed_session_is_named_by_the_pane_token(client, guard, monkeypatch) -> None:
    import secrets as _secrets

    token = _secrets.token_urlsafe(24)
    term = types.SimpleNamespace(pane_id="token-pane", closed=False, metadata={"guard_pane_token": token})
    owner = types.SimpleNamespace(terminals={"t1": term})
    monkeypatch.setitem(app_module._PTY_OWNERS, "t1", owner)
    payload = {**CLAUDE_BASH, "session_id": "not-attributed"}
    _post(client, "claude", payload, **{guard_hooks.PANE_TOKEN_HEADER: token})
    _post(client, "claude", payload, **{guard_hooks.PANE_TOKEN_HEADER: "wrong"})
    _post(client, "claude", payload)
    assert [c["pane_id"] for c in guard.calls] == ["token-pane", "", ""]


def test_an_attributed_session_wins_over_the_token(client, guard, monkeypatch) -> None:
    term = types.SimpleNamespace(pane_id="token-pane", closed=False, metadata={"guard_pane_token": "tok"})
    monkeypatch.setitem(app_module._PTY_OWNERS, "t1", types.SimpleNamespace(terminals={"t1": term}))
    _post(client, "claude", {**CLAUDE_BASH, "session_id": "s-1"}, **{guard_hooks.PANE_TOKEN_HEADER: "tok"})
    assert guard.calls[0]["pane_id"] == "pane-1"
