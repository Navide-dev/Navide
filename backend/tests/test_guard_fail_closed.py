"""An unattended pane: a Guard hook that cannot decide refuses the call, and
nothing changes for any other pane."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import stat
import subprocess
import sys
import tomllib
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import codex_session_hooks, guard_fail_closed as gfc
from agent_team_backend import guard_hooks

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="unattended panes are POSIX only for now")

#: guard_hook_command() on POSIX, as origin/main had it before this module.
CODEX_HOOK_SHA256 = "1b310a5a0f635724e6921dd867cea3320ed969a449a5304555711be2fa0e1b6c"


def write_exec(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


def run_hook(tmp_path: Path, curl: str, *, env_set: bool = True, port: str = "4242", vendor: str = "claude") -> str:
    """The real hook text under sh, with `curl` standing in for the backend."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    write_exec(bin_dir / "curl", "#!/bin/sh\ncat > /dev/null\n" + curl)
    port_file = tmp_path / "port"
    if port:
        port_file.write_text(port)
    command = gfc.hook_command(vendor=vendor, port_expr=f"$(cat {port_file} 2>/dev/null)", url_path="/hooks/x/pretooluse", headers=())
    env = {"PATH": f"{bin_dir}:/usr/bin:/bin"}
    if env_set:
        env[gfc.ENV] = "1"
    done = subprocess.run(["/bin/sh", "-c", command], input=b"{}", env=env, capture_output=True, timeout=10, check=False)
    assert done.returncode == 0
    return done.stdout.decode()


def denied(out: str) -> bool:
    return json.loads(out)["hookSpecificOutput"]["permissionDecision"] == "deny"


@pytest.mark.parametrize(
    "curl",
    ["exit 7\n", "exit 28\n", "exit 22\n", "printf ''\n", "kill -9 $$\n"],
    ids=["refused", "timed-out", "http-error", "empty-answer", "curl-killed"],
)
def test_every_failure_of_the_hook_is_a_denial(tmp_path, curl) -> None:
    assert denied(run_hook(tmp_path, curl))


def test_no_port_file_is_a_denial(tmp_path) -> None:
    assert denied(run_hook(tmp_path, "printf '{}'\n", port=""))


def test_no_decision_stays_no_decision(tmp_path) -> None:
    assert run_hook(tmp_path, "printf '{}'\n") == ""


def test_a_decision_is_printed_as_it_came(tmp_path) -> None:
    body = '{"hookSpecificOutput":{"permissionDecision":"ask"}}'
    assert run_hook(tmp_path, f"printf '%s' '{body}'\n") == body


def test_without_the_variable_it_steps_aside_and_calls_nothing(tmp_path) -> None:
    assert run_hook(tmp_path, f"touch {tmp_path}/called\n", env_set=False) == ""
    assert not (tmp_path / "called").exists()


def test_the_codex_denial_is_codex_shaped(tmp_path) -> None:
    assert denied(run_hook(tmp_path, "exit 7\n", vendor="codex"))


class TestRespond:
    @pytest.fixture(autouse=True)
    def guard_on(self, monkeypatch) -> None:
        from agent_team_backend.guard import engine

        monkeypatch.setattr(engine, "switched_off", lambda: False)

    def call(self, payload: Any = None, pane: str = "p") -> dict[str, Any]:
        body = {"tool_name": "Bash", "tool_input": {"command": "ls"}} if payload is None else payload
        return asyncio.run(gfc.respond("claude", body, pane_id=pane, cwd="/w", workspace="/w"))

    def decided(self, monkeypatch, decision: Any) -> None:
        monkeypatch.setattr(guard_hooks, "decide", lambda *a, **k: decision)

    def test_allow_is_an_empty_object(self, monkeypatch) -> None:
        self.decided(monkeypatch, SimpleNamespace(action="allow", rule_ids=(), reason=""))
        assert self.call() == {}

    def test_ask_and_deny_pass_through(self, monkeypatch) -> None:
        self.decided(monkeypatch, SimpleNamespace(action="ask", rule_ids=("r",), reason="why"))
        assert self.call()["hookSpecificOutput"]["permissionDecision"] == "ask"

    def test_a_crash_is_a_denial(self, monkeypatch) -> None:
        def boom(*_: Any, **__: Any) -> None:
            raise RuntimeError("rules unreadable")

        monkeypatch.setattr(guard_hooks, "decide", boom)
        assert denied(json.dumps(self.call()))

    def test_a_timeout_is_a_denial(self, monkeypatch) -> None:
        monkeypatch.setattr(guard_hooks, "EVALUATE_BUDGET_S", 0.01)
        monkeypatch.setattr(guard_hooks, "decide", lambda *a, **k: __import__("time").sleep(0.2))
        assert denied(json.dumps(self.call()))

    def test_a_broken_rule_file_is_a_denial(self, monkeypatch) -> None:
        # evaluate() turns a failure into an allow tagged guard-error.
        self.decided(monkeypatch, SimpleNamespace(action="allow", rule_ids=("guard-error",), reason="bad rules"))
        assert denied(json.dumps(self.call()))

    def test_an_unreadable_call_is_a_denial(self) -> None:
        assert denied(json.dumps(self.call(payload=["not", "an", "object"])))

    def test_an_unknown_pane_is_a_denial(self) -> None:
        assert denied(json.dumps(self.call(pane="")))

    def test_guard_switched_off_is_a_denial(self, monkeypatch) -> None:
        from agent_team_backend.guard import engine

        monkeypatch.setattr(engine, "switched_off", lambda: True)
        assert denied(json.dumps(self.call()))

    def test_a_real_evaluate_failure_arrives_as_guard_error(self, monkeypatch) -> None:
        from agent_team_backend.guard import engine

        def boom(**_: Any) -> None:
            raise ValueError("broken rules")

        monkeypatch.setattr(engine, "_evaluate", boom)
        monkeypatch.setattr(engine, "_emit_failure", lambda *a, **k: None)
        assert denied(json.dumps(self.call()))


class TestNothingElseChanges:
    """The regular hook's text is pinned here: a change to it shows up as this
    test failing, not as a silent difference for every pane."""

    def test_the_regular_codex_hook_text_is_the_one_it_was(self) -> None:
        text = codex_session_hooks.guard_hook_command()
        assert gfc.ENV not in text and gfc.HEADER not in text
        assert hashlib.sha256(text.encode()).hexdigest() == CODEX_HOOK_SHA256

    def test_the_regular_respond_answers_the_same(self, monkeypatch) -> None:
        from agent_team_backend.guard import engine

        monkeypatch.setattr(engine, "switched_off", lambda: False)
        monkeypatch.setattr(guard_hooks, "_announce_failure", lambda *a: None)
        monkeypatch.setattr(guard_hooks, "decide", lambda *a, **k: SimpleNamespace(action="allow", reason=""))
        call = {"tool_name": "Bash", "tool_input": {"command": "ls"}}
        assert asyncio.run(guard_hooks.respond("claude", call, pane_id="p", cwd="/w", workspace="/w")) is None

        def boom(*_: Any, **__: Any) -> None:
            raise RuntimeError("x")

        monkeypatch.setattr(guard_hooks, "decide", boom)
        assert asyncio.run(guard_hooks.respond("claude", call, pane_id="p", cwd="/w", workspace="/w")) is None

    def test_no_codex_launch_carries_the_unattended_hook(self, monkeypatch, tmp_path) -> None:
        # Its trust entry would replace the regular hook's, and ordinary panes
        # would ask again, so not even a stray variable may bring it in.
        monkeypatch.setattr(codex_session_hooks, "trust_gate_blocks_injection", lambda: False)
        wired = codex_session_hooks.wire("codex", {gfc.ENV: "1"}, {}, tmp_path, tmp_path / "port", tmp_path / "auth")
        assert "hooks.PreToolUse" in wired and gfc.ENV not in wired and gfc.HEADER not in wired


def test_the_codex_hook_survives_toml() -> None:
    literal = codex_session_hooks._toml_literal(gfc.codex_hook_command())
    assert tomllib.loads(f"x = {literal}")["x"] == gfc.codex_hook_command()


def test_claude_settings_add_to_the_pane_file(tmp_path, monkeypatch) -> None:
    from agent_team_backend import claude_hooks

    base = tmp_path / "settings.json"
    base.write_text(json.dumps({"hooks": {"PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "regular"}]}]}}))
    monkeypatch.setattr(claude_hooks, "pane_settings_path", lambda: base)
    target = gfc.claude_settings(str(tmp_path / "port"))
    entries = json.loads(target.read_text())["hooks"]["PreToolUse"]
    assert entries[0]["hooks"][0]["command"] == "regular"
    assert gfc.ENV in entries[1]["hooks"][0]["command"]
    assert stat.S_IMODE(os.stat(target).st_mode) == 0o600
