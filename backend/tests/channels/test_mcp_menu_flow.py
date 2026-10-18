"""/mcp end to end through the manager: two read-only groups, details, and the guards."""

from __future__ import annotations

from typing import Any

from agent_team_backend.channels import quick_menu as qm
from agent_team_backend.channels.base import Capabilities

from .test_manager import Env, env, fast_timers  # noqa: F401 — pytest fixtures

# Every value a server record may carry that must never reach a chat, masked or not.
SECRET = "sk-" + "live-" + "abcdef123456"
SECRET_VALUES = [
    "/opt/" + "secret-bin/mcp-server",
    "--api-key=" + SECRET,
    "https://user:" + SECRET + "@mcp.example.com/sse?token=" + SECRET,
    "ENV_" + SECRET,
    "Bearer " + SECRET,
    "/Users/someone/.claude.json",
]


def _raw(name: str, **extra: Any) -> dict[str, Any]:
    # A record shaped like native_mcp's as_dict(), secrets and all.
    return {"name": name, "agent": "claude", "transport": "stdio", "path": SECRET_VALUES[5],
            "command": SECRET_VALUES[0], "args": [SECRET_VALUES[1]], "url": SECRET_VALUES[2],
            "env": {"API_KEY": SECRET_VALUES[3]}, "headers": {"Authorization": SECRET_VALUES[4]},
            "enabled": True, "valid": True, "error": "", "source": "~/.claude.json", **extra}


def _buttons(env: Env, menu: int = -1) -> list[tuple[str, str]]:
    return [b for row in env.tg.menus[menu][2] for b in row]


def _press_data(env: Env, label_part: str, menu: int = -1) -> str:
    return next(data for label, data in _buttons(env, menu) if label_part in label)


def _everything_said(env: Env) -> str:
    parts = list(env.tg.texts())
    for _loc, body, rows in env.tg.menus:
        parts.append(body)
        parts += [label for row in rows for label, _ in row]
    return "\n".join(parts)


def _setup(env: Env) -> None:
    env.fake.agents["pane-1"] = "claude"
    env.fake.mcp_native["claude"] = [_raw("github"), _raw("files", enabled=False, transport="http")]
    env.fake.mcp_navide = [
        {**_raw("search"), "status": "connected", "tool_count": 2},
        {**_raw("slow"), "status": "timeout", "tool_count": None},
    ]
    env.fake.mcp_tools = {"search": ["web_search", "fetch_page"], "slow": None}


async def test_mcp_lists_the_cli_group_and_the_navide_group(env: Env) -> None:
    _setup(env)
    await env.inbound("/mcp")
    _loc, body, _rows = env.tg.menus[-1]
    assert [label for label, _ in _buttons(env)] == ["🔌 github", "🔌 files", "🧭 search", "🧭 slow"]
    assert qm.text("zh-TW", "mcp_cli_group", agent="claude", count=2) in body
    assert qm.text("zh-TW", "mcp_navide_group", count=2) in body
    assert qm.text("zh-TW", "mcp_timeout") in body  # "slow" could not be read in time
    assert env.fake.delivered == []  # read-only: nothing goes to the pane


async def test_pressing_a_cli_server_shows_its_safe_fields_only(env: Env) -> None:
    _setup(env)
    await env.inbound("/mcp")
    await env.inbound("", callback=_press_data(env, "files"))
    said = env.tg.texts()[-1]
    assert "files" in said and "http" in said and "~/.claude.json" in said
    assert qm.text("zh-TW", "mcp_off") in said
    # A CLI's own server is never asked for its tools: Navide does not start it.
    assert env.fake.mcp_tool_calls == []


async def test_pressing_a_navide_server_lists_its_tools(env: Env) -> None:
    _setup(env)
    await env.inbound("/mcp")
    await env.inbound("", callback=_press_data(env, "search"))
    said = env.tg.texts()[-1]
    assert "web_search" in said and "fetch_page" in said
    assert env.fake.mcp_tool_calls == ["search"]


async def test_a_tools_list_that_times_out_says_so(env: Env) -> None:
    _setup(env)
    await env.inbound("/mcp")
    await env.inbound("", callback=_press_data(env, "slow"))
    assert qm.text("zh-TW", "mcp_timeout") in env.tg.texts()[-1]


async def test_a_buttonless_platform_gets_numbered_servers_and_picks_with_mcp_n(env: Env) -> None:
    env.tg.capabilities = Capabilities(threads=True, create_location=True, edit=True, typing=True,
                                       buttons=False, text_limit=4000)
    _setup(env)
    await env.inbound("/mcp")
    body = env.tg.texts()[-1]
    assert "1. 🔌 github" in body and "3. 🧭 search" in body
    assert qm.text("zh-TW", "mcp_pick_hint") in body
    await env.inbound("/mcp 3")
    assert "web_search" in env.tg.texts()[-1]
    # /menu <n> never reaches into an /mcp list, and /mcp <n> never casts a prompt.
    await env.inbound("/menu 1")
    assert env.fake.delivered == []
    await env.inbound("/mcp 9")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "bad_pick_mcp")


async def test_mcp_with_no_servers_and_in_an_unbound_chat(env: Env) -> None:
    env.fake.agents["pane-1"] = "claude"
    await env.inbound("/mcp")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "mcp_empty") and env.tg.menus == []
    await env.inbound("/mcp", thread="99")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "not_bound")


async def test_a_server_removed_since_the_menu_is_gone(env: Env) -> None:
    _setup(env)
    await env.inbound("/mcp")
    data = _press_data(env, "github")
    env.fake.mcp_native["claude"] = []
    await env.inbound("", callback=data)
    assert env.tg.texts()[-1] == qm.text("zh-TW", "mcp_gone", name="🔌 github")


async def test_guard_no_command_args_url_env_or_headers_value_reaches_the_chat(env: Env) -> None:
    """Whatever a record holds, only name, transport, enabled, status, tool count and tool
    names may be said: not command, args, url, env, headers or the file path, masked or not."""
    _setup(env)
    await env.inbound("/mcp")
    for label in ("github", "files", "search", "slow"):
        await env.inbound("/mcp")
        await env.inbound("", callback=_press_data(env, label))
    env.tg.capabilities = Capabilities(threads=True, create_location=True, edit=True, typing=True,
                                       buttons=False, text_limit=4000)
    await env.inbound("/mcp")
    for n in range(1, 5):
        await env.inbound(f"/mcp {n}")
    said = _everything_said(env)
    assert "github" in said and "web_search" in said  # the test did reach every output
    for value in SECRET_VALUES:
        assert value not in said
    for fragment in (SECRET, "secret-bin", "mcp.example.com", "API_KEY", "Authorization", "Bearer", "someone"):
        assert fragment not in said
