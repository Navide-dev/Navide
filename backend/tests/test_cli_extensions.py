"""CLI extensions inventory (Phase 1): read-only reflection of what each AI CLI
installed for itself — plugins, mods, extensions, hooks — never Navide's own
plugins (docs/en-US/glossary.md).

What these pin is what the inventory must never become: a scan that writes, a
scan that runs anything but a declared read-only listing command, a scan that
takes the whole page down over one broken file, and an agent-facing answer
that carries hook command lines or paths.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, cli_extensions
from agent_team_backend.cli_vendors.base import ExtensionsSpec
from agent_team_backend.cli_vendors.registry import VENDORS
from agent_team_backend.mcp_server import server as plan_mcp
from agent_team_backend.mcp_server import wiring as plan_mcp_wiring

NAVIDE_HOOK = "# agent-team-hook kind=stop\nPORT=$(cat '/x/Agent-Team/backend-port'); curl ..."
USER_HOOK = "/bin/sh '/home/u/.orca/agent-hooks/claude-hook.sh'"


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _json(path: Path, value: Any) -> Path:
    return _write(path, json.dumps(value))


def _no_cli(argv: list[str], timeout: float) -> str | None:
    raise AssertionError(f"unexpected CLI call {argv}")


@pytest.fixture(autouse=True)
def _no_installed_clis(monkeypatch: pytest.MonkeyPatch) -> None:
    """Hermetic: whatever CLIs this machine has, a scan here finds none."""
    monkeypatch.setattr(cli_extensions, "_resolve_program", lambda name: "")


def _by(items: list[cli_extensions.CliExtension], cli: str) -> dict[str, cli_extensions.CliExtension]:
    return {item.id: item for item in items if item.cli == cli}


# ── declarations ─────────────────────────────────────────────────────────────


def test_every_vendor_but_aider_declares_where_its_extensions_live() -> None:
    for key, spec in VENDORS.items():
        if key == "aider":
            assert spec.extensions is None, "aider has no extension system to show"
        else:
            assert isinstance(spec.extensions, ExtensionsSpec), key


def test_the_vendor_list_hides_aider_and_marks_unread_clis_unsupported(tmp_path: Path) -> None:
    inventory = cli_extensions.scan(tmp_path, runner=lambda argv, timeout: None)
    keys = {vendor["cli"] for vendor in inventory.vendors}
    assert "aider" not in keys
    assert {"claude", "codex", "copilot", "droid", "muse", "opencode", "kilo", "pi"} <= keys
    antigravity = next(v for v in inventory.vendors if v["cli"] == "antigravity")
    assert antigravity["supported"] is False


# ── claude ───────────────────────────────────────────────────────────────────


@pytest.fixture
def claude_home(tmp_path: Path) -> Path:
    plugins = tmp_path / ".claude" / "plugins"
    plain = plugins / "cache" / "mkt" / "helper" / "1.0.0"
    _json(plain / ".claude-plugin" / "plugin.json", {"name": "helper", "version": "1.0.0"})
    _json(plain / "hooks" / "hooks.json", {"hooks": {"PreToolUse": [{"hooks": [{"type": "command", "command": "x"}]}]}})
    (plain / "skills" / "s1").mkdir(parents=True)
    mod = plugins / "cache" / "mkt" / "nextstep" / "0.2.0"
    _json(mod / ".claude-plugin" / "plugin.json", {"name": "nextstep", "version": "0.2.0"})
    _json(mod / "hooks" / "hooks.json", {"modules": ["./register.ts"]})
    _write(mod / "hooks" / "register.ts", "on('tool.call', ...); await $.process.spawn({argv}); $.http.fetch(u); $.ui.status('x')")
    _json(plugins / "installed_plugins.json", {
        "version": 2,
        "plugins": {
            "helper@mkt": [{"scope": "user", "installPath": str(plain), "version": "1.0.0"}],
            "nextstep@mkt": [{"scope": "user", "installPath": str(mod), "version": "0.2.0"}],
        },
    })
    _json(tmp_path / ".claude" / "settings.json", {
        "enabledPlugins": {"helper@mkt": True, "nextstep@mkt": False},
        "hooks": {
            "Stop": [{"hooks": [{"type": "command", "command": NAVIDE_HOOK}]}],
            "SessionStart": [{"hooks": [{"type": "command", "command": USER_HOOK}]}],
        },
    })
    return tmp_path


def test_claude_plugins_mods_and_hooks_are_told_apart(claude_home: Path) -> None:
    items = _by(cli_extensions.scan(claude_home, runner=_no_cli).items, "claude")

    helper = items["helper@mkt"]
    assert (helper.kind, helper.type_label, helper.exec_tier) == ("plugin", "Claude plugin", "L2")
    assert helper.enabled is True and helper.version == "1.0.0" and helper.scope == "user"
    assert {"hooks", "skills"} <= set(helper.components)
    assert {"exec", "intercept-tools"} <= set(helper.capabilities)

    mod = items["nextstep@mkt"]
    assert (mod.kind, mod.type_label, mod.exec_tier) == ("mod", "Claude mod", "L3")
    assert mod.enabled is False
    assert {"exec", "network", "intercept-tools", "ui"} <= set(mod.capabilities)
    assert mod.native_consent == "hot-reload"
    assert mod.evidence == "inferred", "capabilities read off source text are a guess"

    hooks = [item for item in items.values() if item.kind == "hook"]
    owners = {item.name: item.owner for item in hooks}
    assert owners == {"Stop": "navide", "SessionStart": "user"}
    assert all(item.exec_tier == "L2" and item.type_label == "Claude hook" for item in hooks)


# ── codex / copilot / droid / muse ───────────────────────────────────────────


def test_codex_plugins_come_from_config_and_hooks_need_trust(tmp_path: Path) -> None:
    _write(tmp_path / ".codex" / "config.toml", '[plugins."github@openai-curated"]\nenabled = true\n'
           '[plugins."off@openai-curated"]\nenabled = false\n')
    _json(tmp_path / ".codex" / "plugins" / "cache" / "openai-curated" / "github" / "abc" / ".codex-plugin" / "plugin.json",
          {"name": "github", "version": "abc"})
    _json(tmp_path / ".codex" / "hooks.json", {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": USER_HOOK}]}]}})

    items = _by(cli_extensions.scan(tmp_path, runner=_no_cli).items, "codex")

    assert items["github@openai-curated"].enabled is True
    assert items["github@openai-curated"].type_label == "Codex plugin"
    assert items["off@openai-curated"].enabled is False
    hook = next(item for item in items.values() if item.kind == "hook")
    assert hook.native_consent == "hook-trust" and hook.type_label == "Codex hook"


def test_copilot_hook_files_navide_wrote_are_owned_by_navide(tmp_path: Path) -> None:
    _json(tmp_path / ".copilot" / "hooks" / "agent-team.json",
          {"version": 1, "hooks": {"preToolUse": [{"command": "curl -H 'X-Agent-Team-Event: pre_tool_use' ..."}]}})
    _json(tmp_path / ".copilot" / "hooks" / "orca.json",
          {"version": 1, "hooks": {"sessionStart": [{"bash": USER_HOOK}]}})

    hooks = [i for i in cli_extensions.scan(tmp_path, runner=_no_cli).items if i.cli == "copilot"]

    assert {(h.name, h.owner) for h in hooks} == {("preToolUse", "navide"), ("sessionStart", "user")}
    assert "intercept-tools" in next(h for h in hooks if h.name == "preToolUse").capabilities


def test_droid_settings_hooks_are_listed(tmp_path: Path) -> None:
    _json(tmp_path / ".factory" / "settings.json",
          {"hooks": {"PreToolUse": [{"hooks": [{"type": "command", "command": USER_HOOK}]}]}})
    hooks = [i for i in cli_extensions.scan(tmp_path, runner=_no_cli).items if i.cli == "droid"]
    assert [(h.kind, h.type_label) for h in hooks] == [("hook", "Droid hook")]


def test_muse_is_asked_only_through_its_read_only_json_listing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[list[str], float]] = []

    def runner(argv: list[str], timeout: float) -> str | None:
        calls.append((argv, timeout))
        return json.dumps({"plugins": [{"id": "lint@local", "name": "lint", "version": "1.2", "enabled": True}]})

    monkeypatch.setattr(cli_extensions, "_resolve_program", lambda name: f"/bin/{name}")
    items = _by(cli_extensions.scan(tmp_path, runner=runner).items, "muse")

    assert calls and all(argv[1:] == ["plugins", "list", "--json"] for argv, _ in calls)
    assert all(0 < timeout <= 15 for _, timeout in calls)
    assert items["lint@local"].type_label == "Muse plugin"
    assert items["lint@local"].native_consent == "capability-approve"


def test_a_missing_cli_binary_is_not_called(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cli_extensions, "_resolve_program", lambda name: "")
    cli_extensions.scan(tmp_path, runner=_no_cli)


# ── in-process code: opencode / kilo / pi ────────────────────────────────────


def test_pi_and_opencode_extensions_are_in_process_code(tmp_path: Path) -> None:
    _write(tmp_path / ".pi" / "agent" / "extensions" / "orca-status.ts",
           "export default (pi) => { pi.on('tool_call', e => e); fetch('https://x') }")
    _write(tmp_path / ".config" / "opencode" / "plugins" / "guard.js",
           "export const G = async ({ $ }) => ({ 'tool.execute.before': async () => { await $`ls` } })")
    _write(tmp_path / ".config" / "opencode" / "opencode.jsonc",
           '{\n  // comment\n  "plugin": ["opencode-wakatime",],\n}\n')

    items = cli_extensions.scan(tmp_path, runner=_no_cli).items
    pi = _by(items, "pi")["orca-status.ts"]
    assert (pi.kind, pi.type_label, pi.exec_tier) == ("extension", "Pi extension", "L3")
    assert {"network", "intercept-tools"} <= set(pi.capabilities)

    opencode = _by(items, "opencode")
    assert opencode["guard.js"].exec_tier == "L3"
    assert {"exec", "intercept-tools"} <= set(opencode["guard.js"].capabilities)
    assert opencode["opencode-wakatime"].type_label == "opencode plugin"
    assert opencode["opencode-wakatime"].exec_tier == "L3"


# ── kimi / qwen ──────────────────────────────────────────────────────────────


def test_kimi_hooks_come_from_its_toml_list(tmp_path: Path) -> None:
    _write(tmp_path / ".kimi-code" / "config.toml",
           '[[hooks]]\nevent = "UserPromptSubmit"\ncommand = "/bin/true"\n')
    hooks = [i for i in cli_extensions.scan(tmp_path, runner=_no_cli).items if i.cli == "kimi"]
    assert [(h.name, h.type_label) for h in hooks] == [("UserPromptSubmit", "Kimi hook")]


def test_qwen_extensions_follow_the_enablement_file(tmp_path: Path) -> None:
    ext = tmp_path / ".qwen" / "extensions"
    _json(ext / "docs" / "qwen-extension.json", {"name": "docs", "version": "0.1.0", "mcpServers": {"d": {}}})
    _json(ext / "extension-enablement.json", {"docs": {"overrides": ["!/*"]}})
    items = _by(cli_extensions.scan(tmp_path, runner=_no_cli).items, "qwen")
    assert items["docs"].type_label == "Qwen extension"
    assert "mcp" in items["docs"].components


# ── failure and safety ───────────────────────────────────────────────────────


def test_a_broken_file_is_reported_not_raised(tmp_path: Path) -> None:
    _write(tmp_path / ".claude" / "plugins" / "installed_plugins.json", "{not json")
    items = [i for i in cli_extensions.scan(tmp_path, runner=_no_cli).items if i.cli == "claude"]
    assert any(not item.valid and item.error for item in items)


def test_unreadable_settings_leave_the_enabled_state_unknown_not_on(claude_home: Path) -> None:
    """C8: a settings file that will not parse must not turn every plugin
    "enabled" — the row says its state is unknown and why."""
    _write(claude_home / ".claude" / "settings.json", "{not json")
    items = _by(cli_extensions.scan(claude_home, runner=_no_cli).items, "claude")
    for plugin_id in ("helper@mkt", "nextstep@mkt"):
        assert items[plugin_id].enabled_error.startswith("cannot parse settings.json")
        assert str(claude_home) not in items[plugin_id].enabled_error


@pytest.mark.skipif(os.name == "nt", reason="POSIX file modes")
def test_settings_that_cannot_be_opened_leave_the_enabled_state_unknown(claude_home: Path) -> None:
    settings = claude_home / ".claude" / "settings.json"
    settings.chmod(0)
    try:
        items = _by(cli_extensions.scan(claude_home, runner=_no_cli).items, "claude")
    finally:
        settings.chmod(0o600)
    assert items["nextstep@mkt"].enabled_error == "cannot read settings.json: Permission denied"


def test_readable_settings_leave_no_enabled_error(claude_home: Path) -> None:
    items = _by(cli_extensions.scan(claude_home, runner=_no_cli).items, "claude")
    assert items["helper@mkt"].enabled_error == "" and items["nextstep@mkt"].enabled_error == ""


def test_a_broken_qwen_enablement_file_keeps_its_extensions_listed(tmp_path: Path) -> None:
    ext = tmp_path / ".qwen" / "extensions"
    _json(ext / "docs" / "qwen-extension.json", {"name": "docs", "version": "0.1.0"})
    _write(ext / "extension-enablement.json", "{not json")
    items = _by(cli_extensions.scan(tmp_path, runner=_no_cli).items, "qwen")
    assert items["docs"].valid
    assert items["docs"].enabled_error.startswith("cannot parse extension-enablement.json")


def test_agents_are_told_what_could_not_be_read(tmp_path: Path) -> None:
    """C8: an unreadable file is named with its reason, not dropped, so an
    agent cannot report "not installed" for "could not read"."""
    _write(tmp_path / ".claude" / "plugins" / "installed_plugins.json", "{not json")
    public = cli_extensions.scan(tmp_path, runner=_no_cli).public_dict()
    broken = [row for row in public["unreadable"] if row["cli"] == "claude"]
    assert broken and broken[0]["name"] == "installed_plugins.json" and broken[0]["error"]
    assert set(broken[0]) == {"cli", "id", "name", "kind", "type_label", "error"}
    assert str(tmp_path) not in json.dumps(public)
    claude = next(vendor for vendor in public["vendors"] if vendor["cli"] == "claude")
    assert (claude["count"], claude["unreadable"]) == (0, 1)


def _tree(root: Path) -> dict[str, tuple[int, int]]:
    out = {}
    for path in root.rglob("*"):
        stat = path.lstat()
        out[str(path)] = (stat.st_size, stat.st_mtime_ns)
    return out


def test_scanning_writes_nothing(claude_home: Path) -> None:
    _write(claude_home / ".pi" / "agent" / "extensions" / "a.ts", "fetch(x)")
    before = _tree(claude_home)
    cli_extensions.scan(claude_home, runner=_no_cli)
    assert _tree(claude_home) == before


def test_agents_get_names_and_metadata_only(claude_home: Path) -> None:
    public = cli_extensions.scan(claude_home, runner=_no_cli).public_dict()
    flat = json.dumps(public)
    assert "agent-team-hook" not in flat and ".orca" not in flat
    assert str(claude_home) not in flat
    row = next(item for item in public["items"] if item["id"] == "nextstep@mkt")
    assert set(row) == {
        "cli", "id", "name", "version", "kind", "type_label", "scope", "enabled",
        "exec_tier", "capabilities", "native_consent", "owner", "evidence", "enabled_error",
    }


def test_the_page_answer_carries_paths_and_a_masked_command_summary(claude_home: Path) -> None:
    full = cli_extensions.scan(claude_home, runner=_no_cli).as_dict()
    hook = next(item for item in full["items"] if item["kind"] == "hook" and item["owner"] == "user")
    assert hook["detail"].startswith("/bin/sh")
    assert len(hook["detail"]) <= 200


def test_default_runner_never_prompts_and_times_out(tmp_path: Path) -> None:
    script = _write(tmp_path / "slow.sh", "#!/bin/sh\nread x\nsleep 5\necho done\n")
    os.chmod(script, 0o755)
    assert cli_extensions._run_readonly([str(script)], timeout=0.5) is None


# ── MCP tool ─────────────────────────────────────────────────────────────────


def _ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))


@pytest.mark.asyncio
async def test_cli_extensions_list_tool_answers_with_metadata_only(
    claude_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent_messaging._reset_for_test()
    agent_messaging.register("pa", "caller", "/ws")
    real_scan = cli_extensions.scan
    monkeypatch.setattr(cli_extensions, "scan", lambda home=None, runner=None: real_scan(claude_home, runner=_no_cli))

    result = await plan_mcp.cli_extensions_list(_ctx())

    assert {item["id"] for item in result["items"]} >= {"helper@mkt", "nextstep@mkt"}
    assert "path" not in json.dumps(result["items"])
    assert all("cli" in vendor and "supported" in vendor for vendor in result["vendors"])
    agent_messaging._reset_for_test()


@pytest.mark.asyncio
async def test_cli_extensions_list_tool_also_names_what_navide_changed(
    _isolated_convenience_gate, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """C6: the agent reads the same inventory as Settings → CLI Extensions,
    so it must see Navide's own changes too, or it cannot tell the user."""
    from agent_team_backend import app

    gate = _isolated_convenience_gate
    monkeypatch.setattr(app, "convenience_gate", gate)
    agent_messaging._reset_for_test()
    agent_messaging.register("pa", "caller", "/ws")
    monkeypatch.setattr(cli_extensions, "scan", lambda home=None, runner=None: cli_extensions.Inventory(vendors=[], items=[]))
    gate.apply("cursor.project-mcp", tmp_path / "mcp.json", write=lambda: None, present=lambda: True)

    result = await plan_mcp.cli_extensions_list(_ctx())

    [row] = [item for item in result["items"] if item["kind"] == "navide-change"]
    assert (row["cli"], row["name"], row["owner"]) == ("cursor", "cursor.project-mcp", "navide")
    # OF-N2: every pane reads this; another workspace's path must not leak
    # through the id.
    assert str(tmp_path) not in json.dumps(result)
    agent_messaging._reset_for_test()


def test_a_nested_plugin_cache_is_walked_down_to_the_manifest(tmp_path: Path) -> None:
    """cursor keeps cache/<marketplace>/<name>/<commit>/; the walk names the
    plugin, not the commit, and the marketplace rides along in the id."""
    version = tmp_path / ".cursor" / "plugins" / "cache" / "cursor-public" / "context7-plugin" / "58a36cea87"
    _json(version / ".mcp.json", {"mcpServers": {}})
    (version / "skills").mkdir(parents=True)

    items = _by(cli_extensions.scan(tmp_path, runner=_no_cli).items, "cursor")

    plugin = items["context7-plugin@cursor-public"]
    assert plugin.type_label == "Cursor plugin" and plugin.exec_tier == "L2"
    assert {"mcp", "skills"} <= set(plugin.components)


def test_the_settings_page_message_is_registered() -> None:
    from agent_team_backend import ws_handlers

    assert ws_handlers._REGISTRY["cli_extensions.list"] is ws_handlers.cli_extensions_list


@pytest.mark.parametrize("command, secret", [
    ("curl -H 'Authorization: Bearer sk-live-abcdef123456' https://h", "sk-live-abcdef123456"),
    ('curl -H "X-Api-Key: k3y-v4lue-9999" https://h', "k3y-v4lue-9999"),
    ("GITHUB_TOKEN=ghp_abcdefghijklmnop1234 /bin/hook", "ghp_abcdefghijklmnop1234"),
    ("export API_SECRET='s3cr3t-v4lue' && run", "s3cr3t-v4lue"),
    ("notify --password hunter2hunter2", "hunter2hunter2"),
    ("post https://h/x?token=abcd1234efgh", "abcd1234efgh"),
    ("send xoxb-1234-5678-abcdefghijkl", "xoxb-1234-5678-abcdefghijkl"),
])
def test_a_hook_summary_never_carries_a_credential(command: str, secret: str) -> None:
    summary = cli_extensions._summary(command)
    assert secret not in summary
    assert "***" in summary


def test_the_windows_exec_form_guard_hook_is_owned_by_navide(tmp_path: Path) -> None:
    """On Windows the Guard hook is ``cmd.exe`` with the script in ``args``.

    Read off ``command`` alone it looked like the user's own hook.
    """
    script = r"C:\Users\me\AppData\Roaming\Navide\navide-guard.cmd"
    _json(tmp_path / ".claude" / "settings.json", {
        "hooks": {
            "PreToolUse": [{"hooks": [{"type": "command", "command": "cmd.exe", "args": ["/d", "/c", script]}]}],
            "SessionStart": [{"hooks": [{"type": "command", "command": "cmd.exe", "args": ["/c", "mine.cmd"]}]}],
        },
    })

    items = _by(cli_extensions.scan(tmp_path, runner=_no_cli).items, "claude")

    owners = {item.name: item.owner for item in items.values() if item.kind == "hook"}
    assert owners == {"PreToolUse": "navide", "SessionStart": "user"}
