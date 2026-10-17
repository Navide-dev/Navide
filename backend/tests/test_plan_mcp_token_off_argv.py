"""The /plan-mcp credential never rides in a pane's command line.

`ps` shows every process's full argv to every account on the machine, so a
token in the command line is a token handed to any local user — with it they
can call /plan-mcp as the pane (cli_open_agent, cli_send, ...). CLIs whose
wiring is a spawn-time flag therefore get the credential through a 0600 file
or the spawn environment, never through argv.
"""

from __future__ import annotations

import json
import stat
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent_team_backend import agent_messaging, osplat
from agent_team_backend.mcp_server import auth as plan_mcp_auth, wiring as plan_mcp_wiring
from agent_team_backend.mcp_server.server import CallerUnknown, _resolve_caller

FLAG_VENDORS = ("claude", "codex", "copilot", "qwen")


def _secrets() -> tuple[str, str]:
    return plan_mcp_wiring.caller_token("pane-1"), plan_mcp_auth.internal_token()


def _argv(command: object) -> str:
    return " ".join(command) if isinstance(command, list) else str(command)


@pytest.mark.parametrize("agent_key", FLAG_VENDORS)
@pytest.mark.parametrize("pane_id", ["pane-1", ""])
def test_no_credential_in_the_command_line(agent_key: str, pane_id: str) -> None:
    plan_mcp_wiring.write_claude_config(4567)
    env: dict[str, str] = {}
    wired = plan_mcp_wiring.wire_command(
        agent_key, ["/bin/zsh", "-ilc", agent_key], 4567, pane_id, env
    )
    text = _argv(wired)
    assert text != _argv(["/bin/zsh", "-ilc", agent_key]), "pane left unwired"
    for secret in _secrets():
        assert secret not in text


@pytest.mark.parametrize("agent_key", ["claude", "copilot", "qwen"])
def test_pane_config_file_is_owner_only_and_names_the_pane(agent_key: str) -> None:
    wired = plan_mcp_wiring.wire_command(agent_key, agent_key, 4567, "pane-1", {})
    words = osplat.terminal_backend.parse_command(wired)
    value = words[-1]
    if agent_key == "copilot":
        assert value.startswith("@")
        value = value[1:]
    path = Path(value)
    assert path.is_file()
    if osplat.paths.enforces_posix_modes():
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    assert json.loads(path.read_text(encoding="utf-8")) == plan_mcp_wiring.config_document(
        agent_key, plan_mcp_wiring.plan_mcp_url(4567, "pane-1")
    )


@pytest.mark.parametrize("agent_key", ["claude", "copilot", "qwen"])
def test_a_pane_config_file_counts_as_wired(agent_key: str) -> None:
    once = plan_mcp_wiring.wire_command(agent_key, agent_key, 4567, "pane-1", {})
    assert plan_mcp_wiring.wire_command(agent_key, once, 4567, "pane-1", {}) == once


def test_codex_reads_the_credential_from_the_spawn_env() -> None:
    env: dict[str, str] = {}
    wired = plan_mcp_wiring.wire_command("codex", "codex", 4567, "pane-1", env)
    words = osplat.terminal_backend.parse_command(wired)
    assert words[1:] == [
        "-c",
        f'mcp_servers.navide.url="{plan_mcp_wiring.plan_mcp_url(4567, "pane-1", with_token=False)}"',
        "-c",
        f'mcp_servers.navide.bearer_token_env_var="{plan_mcp_wiring.TOKEN_ENV}"',
    ]
    assert env == {plan_mcp_wiring.TOKEN_ENV: plan_mcp_wiring.caller_token("pane-1")}


def test_stale_pane_config_files_are_cleared_at_startup() -> None:
    wired = plan_mcp_wiring.wire_command("qwen", "qwen", 4567, "pane-1", {})
    path = Path(osplat.terminal_backend.parse_command(wired)[-1])
    plan_mcp_wiring.clear_pane_configs()
    assert not path.exists()


def _ctx(query: dict[str, str], headers: dict[str, str]) -> SimpleNamespace:
    request = SimpleNamespace(query_params=query, headers=headers)
    return SimpleNamespace(request_context=SimpleNamespace(request=request))


def test_pane_bearer_header_is_accepted() -> None:
    agent_messaging._reset_for_test()
    try:
        agent_messaging.register("pa", "sender", "/ws/alpha")
        caller = _resolve_caller(
            _ctx({"pane": "pa"}, {"authorization": f"Bearer {plan_mcp_wiring.caller_token('pa')}"})
        )
    finally:
        agent_messaging._reset_for_test()
    assert (caller.kind, caller.pane_id) == ("pane", "pa")


def test_host_bearer_header_is_accepted() -> None:
    caller = _resolve_caller(
        _ctx({"client": "host"}, {"authorization": f"Bearer {plan_mcp_auth.internal_token()}"})
    )
    assert caller.kind == "host"


def test_a_wrong_bearer_header_is_refused() -> None:
    with pytest.raises(CallerUnknown):
        _resolve_caller(_ctx({"client": "host"}, {"authorization": "Bearer nope"}))
