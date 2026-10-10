from __future__ import annotations

import json
import stat
import subprocess
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app, osplat
from agent_team_backend.cli_vendors.registry import vendor as cli_vendor
from agent_team_backend.plugins import wiring as plugin_wiring
from agent_team_backend.mcp_server import auth as plan_mcp_auth, pane_home, wiring as plan_mcp_wiring


# ---- write_claude_config ----


def test_write_claude_config_creates_file(tmp_path: Path) -> None:
    path = tmp_path / "plan-mcp.json"
    out = plan_mcp_wiring.write_claude_config(4567, path)
    assert out == path
    data = json.loads(path.read_text(encoding="utf-8"))
    # No pane id known for this fallback file, so the URL carries this
    # backend's own host credential instead of being bare.
    assert data == {
        "mcpServers": {
            "navide": {"type": "http", "url": plan_mcp_wiring.plan_mcp_url(4567)}
        }
    }
    assert f"client=host&t={plan_mcp_auth.internal_token()}" in data["mcpServers"]["navide"]["url"]


def test_write_claude_config_updates_stale_port(tmp_path: Path) -> None:
    path = tmp_path / "plan-mcp.json"
    plan_mcp_wiring.write_claude_config(1111, path)
    plan_mcp_wiring.write_claude_config(2222, path)
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["mcpServers"]["navide"]["url"] == plan_mcp_wiring.plan_mcp_url(2222)


def test_write_claude_config_idempotent(tmp_path: Path) -> None:
    path = tmp_path / "plan-mcp.json"
    plan_mcp_wiring.write_claude_config(4567, path)
    before = path.stat().st_mtime_ns
    plan_mcp_wiring.write_claude_config(4567, path)
    assert path.stat().st_mtime_ns == before  # unchanged content → no rewrite
    assert not path.with_suffix(".json.tmp").exists()


@pytest.mark.skipif(not osplat.paths.enforces_posix_modes(), reason="POSIX mode bits")
def test_write_claude_config_is_owner_only(tmp_path: Path) -> None:
    # The URL embeds the host internal token, so the file must never be
    # group/world readable.
    path = tmp_path / "plan-mcp.json"
    plan_mcp_wiring.write_claude_config(4567, path)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


@pytest.mark.skipif(not osplat.paths.enforces_posix_modes(), reason="POSIX mode bits")
def test_write_claude_config_hardens_existing_wide_file(tmp_path: Path) -> None:
    # Unchanged content returns before rewriting, so a file left 0644 by an
    # older version has to be tightened on that path too.
    path = tmp_path / "plan-mcp.json"
    plan_mcp_wiring.write_claude_config(4567, path)
    path.chmod(0o644)
    plan_mcp_wiring.write_claude_config(4567, path)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


# ---- backend_port ----


def test_backend_port_reads_discovery_file(tmp_path: Path) -> None:
    # conftest autouse fixture points AGENT_TEAM_DATA_DIR at tmp_path.
    (tmp_path / "backend-port").write_text("4567\n", encoding="utf-8")
    assert plan_mcp_wiring.backend_port() == 4567


def test_backend_port_absent_or_garbage(tmp_path: Path) -> None:
    assert plan_mcp_wiring.backend_port() is None
    (tmp_path / "backend-port").write_text("not-a-port", encoding="utf-8")
    assert plan_mcp_wiring.backend_port() is None


# ---- plan_mcp_url: pane vs. host credential ----


def test_plan_mcp_url_with_pane_id_carries_the_pane_credential() -> None:
    url = plan_mcp_wiring.plan_mcp_url(4567, "pane-1")
    assert url == (
        f"http://127.0.0.1:4567/plan-mcp?pane=pane-1&t={plan_mcp_wiring.caller_token()}"
    )


def test_plan_mcp_url_without_pane_id_carries_the_host_credential() -> None:
    url = plan_mcp_wiring.plan_mcp_url(4567)
    assert url == (
        f"http://127.0.0.1:4567/plan-mcp?client=host&t={plan_mcp_auth.internal_token()}"
    )


# ---- wire_command: claude ----


@pytest.fixture
def claude_config(tmp_path: Path) -> Path:
    # Deliberately a dir with a space (real path is "Application Support/…")
    # so quoting is exercised.
    config = tmp_path / "App Data" / "plan-mcp.json"
    config.parent.mkdir(parents=True)
    return plan_mcp_wiring.write_claude_config(4567, config)


def test_wire_claude_appends_quoted_flag_to_shell_wrapper(claude_config: Path) -> None:
    command = ["/bin/zsh", "-ilc", "claude --dangerously-skip-permissions"]
    wired = plan_mcp_wiring.wire_command("claude", command, 4567, claude_config=claude_config)
    assert wired[:2] == ["/bin/zsh", "-ilc"]
    assert wired[2] == (
        "claude --dangerously-skip-permissions "
        f"--mcp-config {osplat.paths.quote_arg(str(claude_config))}"
    )
    assert command[2] == "claude --dangerously-skip-permissions"  # input untouched


def test_wire_claude_plain_string_command(claude_config: Path) -> None:
    wired = plan_mcp_wiring.wire_command("claude", "claude", 4567, claude_config=claude_config)
    assert wired == f"claude --mcp-config {osplat.paths.quote_arg(str(claude_config))}"


def test_wire_claude_second_run_is_noop(claude_config: Path) -> None:
    once = plan_mcp_wiring.wire_command("claude", "claude", 4567, claude_config=claude_config)
    twice = plan_mcp_wiring.wire_command("claude", once, 4567, claude_config=claude_config)
    assert twice == once


def test_wire_claude_respects_user_mcp_config_flag(claude_config: Path) -> None:
    command = "claude --mcp-config /home/user/my-servers.json --strict-mcp-config"
    assert plan_mcp_wiring.wire_command("claude", command, 4567, claude_config=claude_config) == command


def test_wire_claude_missing_config_file_is_noop(tmp_path: Path) -> None:
    missing = tmp_path / "nope" / "plan-mcp.json"
    assert plan_mcp_wiring.wire_command("claude", "claude", 4567, claude_config=missing) == "claude"


# ---- wire_command: codex ----


def test_wire_codex_appends_config_override() -> None:
    wired = plan_mcp_wiring.wire_command("codex", "codex --yolo", 4567)
    # No pane id given, so the override URL carries the host credential.
    override = f'mcp_servers.navide.url="{plan_mcp_wiring.plan_mcp_url(4567)}"'
    assert wired == f"codex --yolo -c {osplat.paths.quote_arg(override)}"
    assert "client=host" in wired


def test_wire_codex_resume_command() -> None:
    command = ["/bin/zsh", "-lc", "codex resume abc123 --yolo"]
    wired = plan_mcp_wiring.wire_command("codex", command, 4567)
    assert wired[2].startswith("codex resume abc123 --yolo -c ")
    # Through the platform's own argv split, so the inner quotes are the
    # override's and not the quoting's.
    words = osplat.terminal_backend.parse_command(wired[2])
    assert words[-2:] == ["-c", f'mcp_servers.navide.url="{plan_mcp_wiring.plan_mcp_url(4567)}"']


def test_wire_codex_with_pane_id_uses_pane_credential() -> None:
    """With a pane id, the override URL still carries the pane credential
    (unaffected by the host-credential fallback added for the empty case)."""
    wired = plan_mcp_wiring.wire_command("codex", "codex", 4567, pane_id="p1")
    url = plan_mcp_wiring.plan_mcp_url(4567, "p1")
    assert "pane=p1" in url and "client=host" not in url
    assert url in wired


def test_wire_codex_second_run_is_noop() -> None:
    once = plan_mcp_wiring.wire_command("codex", "codex", 4567)
    assert plan_mcp_wiring.wire_command("codex", once, 4567) == once


# ---- wire_command: copilot ----


def test_wire_copilot_appends_inline_config() -> None:
    wired = plan_mcp_wiring.wire_command("copilot", "copilot --allow-all-tools", 4567)
    inline = plan_mcp_wiring.config_json("copilot", 4567)
    assert wired == f"copilot --allow-all-tools --additional-mcp-config {osplat.paths.quote_arg(inline)}"
    assert "client=host" in wired


def test_wire_copilot_shell_wrapper_and_pane_credential() -> None:
    command = ["/bin/zsh", "-ilc", "copilot"]
    wired = plan_mcp_wiring.wire_command("copilot", command, 4567, pane_id="p1")
    assert wired[:2] == ["/bin/zsh", "-ilc"]
    assert wired[2].startswith("copilot --additional-mcp-config ")
    assert "pane=p1" in wired[2] and "client=host" not in wired[2]
    assert command[2] == "copilot"  # input untouched


def test_wire_copilot_second_run_is_noop() -> None:
    once = plan_mcp_wiring.wire_command("copilot", "copilot", 4567)
    assert plan_mcp_wiring.wire_command("copilot", once, 4567) == once


def test_wire_copilot_detects_its_entry_under_escaped_quotes() -> None:
    """Already-wired detection reads the argv, not the quoting: the inline
    JSON escaped the MSVCRT way (``\\"navide\\"``) has no literal ``"navide"``
    in the command text, and must still count as wired."""
    inline = plan_mcp_wiring.config_json("copilot", 4567)
    command = f"copilot --additional-mcp-config {subprocess.list2cmdline([inline])}"
    assert f'"{plan_mcp_wiring.SERVER_NAME}"' not in command
    assert plan_mcp_wiring.wire_command("copilot", command, 4567) == command


def test_wire_copilot_keeps_user_additional_config() -> None:
    """copilot's flag is additive and repeatable, so a user's own
    --additional-mcp-config is augmented, not stepped aside for."""
    command = "copilot --additional-mcp-config @/home/user/servers.json"
    wired = plan_mcp_wiring.wire_command("copilot", command, 4567)
    assert wired.startswith(command + " --additional-mcp-config ")
    assert plan_mcp_wiring.SERVER_NAME in wired


# ---- wire_command: qwen ----


def test_wire_qwen_appends_inline_config_with_http_url() -> None:
    wired = plan_mcp_wiring.wire_command("qwen", "qwen --yolo", 4567, pane_id="p1")
    inline = plan_mcp_wiring.config_json("qwen", 4567, "p1")
    assert wired == f"qwen --yolo --mcp-config {osplat.paths.quote_arg(inline)}"
    entry = json.loads(inline)["mcpServers"][plan_mcp_wiring.SERVER_NAME]
    # qwen has no "type" discriminator: httpUrl is streamable HTTP, while a
    # plain "url" would be read as SSE.
    assert entry == {"httpUrl": plan_mcp_wiring.plan_mcp_url(4567, "p1")}
    assert "type" not in entry and "url" not in entry


def test_wire_qwen_shell_wrapper_and_host_credential() -> None:
    command = ["/bin/zsh", "-ilc", "qwen"]
    wired = plan_mcp_wiring.wire_command("qwen", command, 4567)
    assert wired[:2] == ["/bin/zsh", "-ilc"]
    assert wired[2].startswith("qwen --mcp-config ")
    assert "client=host" in wired[2]
    assert command[2] == "qwen"  # input untouched


def test_wire_qwen_second_run_is_noop() -> None:
    once = plan_mcp_wiring.wire_command("qwen", "qwen", 4567)
    assert plan_mcp_wiring.wire_command("qwen", once, 4567) == once


def test_wire_qwen_respects_user_mcp_config_flag() -> None:
    command = "qwen --mcp-config /home/user/my-servers.json"
    assert plan_mcp_wiring.wire_command("qwen", command, 4567) == command


def test_wire_qwen_noop_without_port() -> None:
    assert plan_mcp_wiring.wire_command("qwen", "qwen", None) == "qwen"


# ---- wire_command: opencode / kilo (config in an env var) ----


def test_wire_opencode_sets_the_config_content_var() -> None:
    env: dict[str, str] = {}
    assert plan_mcp_wiring.wire_command("opencode", "opencode", 4567, "p1", env) == "opencode"
    payload = json.loads(env["OPENCODE_CONFIG_CONTENT"])
    entry = payload["mcp"][plan_mcp_wiring.SERVER_NAME]
    # Verified against `opencode mcp list`: remote servers are type "remote",
    # and an "mcpServers" key is rejected as unrecognised.
    assert entry["type"] == "remote"
    assert entry["url"] == plan_mcp_wiring.plan_mcp_url(4567, "p1")
    assert entry["enabled"] is True


def test_wire_kilo_uses_its_own_var_with_the_same_document() -> None:
    kilo_env: dict[str, str] = {}
    opencode_env: dict[str, str] = {}
    plan_mcp_wiring.wire_command("kilo", "kilo", 4567, "p1", kilo_env)
    plan_mcp_wiring.wire_command("opencode", "opencode", 4567, "p1", opencode_env)
    assert kilo_env["KILO_CONFIG_CONTENT"] == opencode_env["OPENCODE_CONFIG_CONTENT"]
    assert "OPENCODE_CONFIG_CONTENT" not in kilo_env


def test_wire_env_cli_leaves_the_command_and_a_preset_var_alone() -> None:
    env = {"OPENCODE_CONFIG_CONTENT": "{}"}
    assert plan_mcp_wiring.wire_command("opencode", "opencode", 4567, "p1", env) == "opencode"
    assert env == {"OPENCODE_CONFIG_CONTENT": "{}"}


def test_wire_env_cli_without_an_env_dict_is_a_noop() -> None:
    """The transformer still runs for callers on the older contract."""
    assert plan_mcp_wiring.wire_command("opencode", "opencode", 4567, "p1") == "opencode"


def test_wire_env_cli_without_pane_id_uses_the_host_credential() -> None:
    env: dict[str, str] = {}
    plan_mcp_wiring.wire_command("opencode", "opencode", 4567, "", env)
    assert "client=host" in env["OPENCODE_CONFIG_CONTENT"]


# ---- wire_command: cursor (project config file) ----


def _cursor_servers(root: Path) -> dict[str, Any]:
    data = json.loads(plan_mcp_wiring.project_config_path("cursor", root).read_text(encoding="utf-8"))
    return data["mcpServers"]


def test_wire_cursor_writes_project_config_and_env_url(tmp_path: Path) -> None:
    env: dict[str, str] = {}
    wired = plan_mcp_wiring.wire_command("cursor", "cursor-agent", 4567, "p1", env, str(tmp_path))
    assert wired == "cursor-agent"  # cursor has no flag: the command is untouched
    # The file is shared by every pane in the workspace, so it holds a
    # variable reference and the per-pane credential rides in the env.
    assert _cursor_servers(tmp_path) == {
        "navide": {"url": "${env:NAVIDE_MCP_URL}"}
    }
    assert env["NAVIDE_MCP_URL"] == plan_mcp_wiring.plan_mcp_url(4567, "p1")


def test_wire_cursor_keeps_user_servers_and_other_keys(tmp_path: Path) -> None:
    path = plan_mcp_wiring.project_config_path("cursor", tmp_path)
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps({"mcpServers": {"mine": {"command": "my-server"}}, "other": 1}),
        encoding="utf-8",
    )
    plan_mcp_wiring.wire_command("cursor", "cursor-agent", 4567, "p1", {}, str(tmp_path))
    servers = _cursor_servers(tmp_path)
    assert servers["mine"] == {"command": "my-server"}
    assert servers["navide"]["url"] == "${env:NAVIDE_MCP_URL}"
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["other"] == 1  # unrelated top-level keys survive


def test_wire_cursor_drops_the_entry_left_by_a_former_server_name(tmp_path: Path) -> None:
    path = plan_mcp_wiring.project_config_path("cursor", tmp_path)
    path.parent.mkdir(parents=True)
    legacy = plan_mcp_wiring.LEGACY_SERVER_NAMES[0]
    path.write_text(
        json.dumps({"mcpServers": {legacy: {"url": "${env:NAVIDE_MCP_URL}"}}}),
        encoding="utf-8",
    )
    plan_mcp_wiring.wire_command("cursor", "cursor-agent", 4567, "p1", {}, str(tmp_path))
    # Both names resolve to the same live endpoint, so leaving the old one
    # would have cursor load the server twice.
    assert _cursor_servers(tmp_path) == {"navide": {"url": "${env:NAVIDE_MCP_URL}"}}


def test_wire_cursor_never_clobbers_unparseable_json(tmp_path: Path) -> None:
    path = plan_mcp_wiring.project_config_path("cursor", tmp_path)
    path.parent.mkdir(parents=True)
    path.write_text("{ not json at all", encoding="utf-8")
    env: dict[str, str] = {}
    plan_mcp_wiring.wire_command("cursor", "cursor-agent", 4567, "p1", env, str(tmp_path))
    assert path.read_text(encoding="utf-8") == "{ not json at all"
    assert env == {}  # unwired rather than wired against a file we could not merge


def test_wire_cursor_second_run_does_not_rewrite(tmp_path: Path) -> None:
    plan_mcp_wiring.wire_command("cursor", "cursor-agent", 4567, "p1", {}, str(tmp_path))
    path = plan_mcp_wiring.project_config_path("cursor", tmp_path)
    before = path.stat().st_mtime_ns
    plan_mcp_wiring.wire_command("cursor", "cursor-agent", 4567, "p2", {}, str(tmp_path))
    assert path.stat().st_mtime_ns == before
    assert not path.with_suffix(".json.tmp").exists()


def test_wire_cursor_excludes_a_file_it_created_from_git(tmp_path: Path) -> None:
    (tmp_path / ".git" / "info").mkdir(parents=True)
    plan_mcp_wiring.wire_command("cursor", "cursor-agent", 4567, "p1", {}, str(tmp_path))
    exclude = (tmp_path / ".git" / "info" / "exclude").read_text(encoding="utf-8")
    assert ".cursor/mcp.json" in exclude.split()


def test_wire_cursor_leaves_git_alone_for_a_preexisting_file(tmp_path: Path) -> None:
    """An existing config is the user's, and so is the choice to track it."""
    (tmp_path / ".git" / "info").mkdir(parents=True)
    path = plan_mcp_wiring.project_config_path("cursor", tmp_path)
    path.parent.mkdir(parents=True)
    path.write_text("{}", encoding="utf-8")
    plan_mcp_wiring.wire_command("cursor", "cursor-agent", 4567, "p1", {}, str(tmp_path))
    assert not (tmp_path / ".git" / "info" / "exclude").exists()


def test_wire_cursor_git_exclude_is_appended_once(tmp_path: Path) -> None:
    info = tmp_path / ".git" / "info"
    info.mkdir(parents=True)
    (info / "exclude").write_text("*.log", encoding="utf-8")  # no trailing newline
    plan_mcp_wiring.wire_command("cursor", "cursor-agent", 4567, "p1", {}, str(tmp_path))
    plan_mcp_wiring.project_config_path("cursor", tmp_path).unlink()
    plan_mcp_wiring.wire_command("cursor", "cursor-agent", 4567, "p1", {}, str(tmp_path))
    lines = (info / "exclude").read_text(encoding="utf-8").split()
    assert lines == ["*.log", ".cursor/mcp.json"]


def test_wire_cursor_refuses_to_write_the_global_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """~/.cursor/mcp.json is cursor's *global* config. Opening the home
    directory as a workspace must not put our server into every project the
    user has — outside Navide the variable is unset and it cannot connect.

    The home is the real one: a backend launched from a shimmed pane inherits
    that shim's HOME, which ``Path.home()`` would answer with."""
    monkeypatch.setattr(pane_home, "real_home", lambda: tmp_path)
    monkeypatch.setattr(Path, "home", classmethod(lambda _cls: tmp_path / "inherited-shim-home"))
    env: dict[str, str] = {}
    plan_mcp_wiring.wire_command("cursor", "cursor-agent", 4567, "p1", env, str(tmp_path))
    assert not plan_mcp_wiring.project_config_path("cursor", tmp_path).exists()
    assert env == {}


def test_wire_cursor_bails_on_a_non_object_mcp_servers(tmp_path: Path) -> None:
    """Same reasoning as unparseable JSON: the key is the user's, whatever it
    means, and replacing it would drop whatever it stood for."""
    path = plan_mcp_wiring.project_config_path("cursor", tmp_path)
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"mcpServers": ["not-a-map"]}), encoding="utf-8")
    env: dict[str, str] = {}
    plan_mcp_wiring.wire_command("cursor", "cursor-agent", 4567, "p1", env, str(tmp_path))
    assert json.loads(path.read_text(encoding="utf-8")) == {"mcpServers": ["not-a-map"]}
    assert env == {}


def test_wire_cursor_excludes_via_the_repo_root_from_a_subdirectory(tmp_path: Path) -> None:
    """A pane's cwd is often a subdirectory; only the root's exclude file
    governs it, and the entry has to be written relative to that root."""
    (tmp_path / ".git" / "info").mkdir(parents=True)
    sub = tmp_path / "packages" / "app"
    sub.mkdir(parents=True)
    plan_mcp_wiring.wire_command("cursor", "cursor-agent", 4567, "p1", {}, str(sub))
    exclude = (tmp_path / ".git" / "info" / "exclude").read_text(encoding="utf-8")
    assert "packages/app/.cursor/mcp.json" in exclude.splitlines()


def test_wire_cursor_git_exclude_ignores_a_commented_mention(tmp_path: Path) -> None:
    info = tmp_path / ".git" / "info"
    info.mkdir(parents=True)
    info.joinpath("exclude").write_text(
        "# .cursor/mcp.json is tracked on purpose\n", encoding="utf-8"
    )
    plan_mcp_wiring.wire_command("cursor", "cursor-agent", 4567, "p1", {}, str(tmp_path))
    lines = (info / "exclude").read_text(encoding="utf-8").splitlines()
    assert lines[-1] == ".cursor/mcp.json"


@pytest.mark.skipif(not osplat.paths.enforces_posix_modes(), reason="POSIX mode bits")
def test_wire_cursor_keeps_the_permissions_the_users_file_had(tmp_path: Path) -> None:
    """cursor's mcp.json is where people put API keys for their own servers.
    Rewriting it must not widen a mode the user tightened."""
    path = plan_mcp_wiring.project_config_path("cursor", tmp_path)
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"mcpServers": {}}), encoding="utf-8")
    path.chmod(0o600)
    plan_mcp_wiring.wire_command("cursor", "cursor-agent", 4567, "p1", {}, str(tmp_path))
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_wire_cursor_does_not_claim_a_repo_above_the_workspace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A home that is itself a dotfiles repo must not swallow every workspace
    under it that is not a repo of its own. The real home, not an inherited
    shim's HOME."""
    monkeypatch.setattr(pane_home, "real_home", lambda: tmp_path)
    monkeypatch.setattr(Path, "home", classmethod(lambda _cls: tmp_path / "inherited-shim-home"))
    (tmp_path / ".git" / "info").mkdir(parents=True)
    ws = tmp_path / "projects" / "not-a-repo"
    ws.mkdir(parents=True)
    plan_mcp_wiring.wire_command("cursor", "cursor-agent", 4567, "p1", {}, str(ws))
    assert plan_mcp_wiring.project_config_path("cursor", ws).is_file()  # still wired
    assert not (tmp_path / ".git" / "info" / "exclude").exists()


def test_wire_cursor_leaves_a_worktrees_exclude_file_alone(tmp_path: Path) -> None:
    """In a worktree or submodule .git is a file, and the exclude file that
    governs it belongs to the superproject."""
    (tmp_path / ".git").write_text("gitdir: /elsewhere/.git/worktrees/wt", encoding="utf-8")
    plan_mcp_wiring.wire_command("cursor", "cursor-agent", 4567, "p1", {}, str(tmp_path))
    assert plan_mcp_wiring.project_config_path("cursor", tmp_path).is_file()
    assert (tmp_path / ".git").is_file()  # untouched


def test_wire_cursor_leaves_no_temp_file_behind(tmp_path: Path) -> None:
    plan_mcp_wiring.wire_command("cursor", "cursor-agent", 4567, "p1", {}, str(tmp_path))
    entries = sorted(p.name for p in plan_mcp_wiring.project_config_path("cursor", tmp_path).parent.iterdir())
    assert entries == ["mcp.json"]


def test_wire_cursor_without_cwd_is_a_noop(tmp_path: Path) -> None:
    env: dict[str, str] = {}
    assert plan_mcp_wiring.wire_command("cursor", "cursor-agent", 4567, "p1", env) == "cursor-agent"
    assert env == {}


def test_wire_cursor_leaves_a_preset_url_var_alone(tmp_path: Path) -> None:
    env = {"NAVIDE_MCP_URL": "http://example/preset"}
    plan_mcp_wiring.wire_command("cursor", "cursor-agent", 4567, "p1", env, str(tmp_path))
    assert env == {"NAVIDE_MCP_URL": "http://example/preset"}


# ---- wire_command: gates ----


def test_wire_noop_without_port(claude_config: Path) -> None:
    assert plan_mcp_wiring.wire_command("claude", "claude", None, claude_config=claude_config) == "claude"
    assert plan_mcp_wiring.wire_command("codex", "codex", None) == "codex"


def test_wire_noop_for_other_agents_and_empty_command(claude_config: Path) -> None:
    for agent in ("terminal", "grok", "kimi", "antigravity", ""):
        assert plan_mcp_wiring.wire_command(agent, "grok", 4567) == "grok"
    assert plan_mcp_wiring.wire_command("claude", "", 4567, claude_config) == ""
    assert plan_mcp_wiring.wire_command("claude", [], 4567, claude_config) == []


# ---- integration: terminal.create wires a claude pane ----


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeTerminals:
    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> SimpleNamespace:
        self.created.append(kwargs)
        return SimpleNamespace(
            id="term-1",
            pane_id=kwargs["pane_id"],
            command=kwargs["command"],
            proc=SimpleNamespace(pid=1234),
        )

    def find_live_by_resume_id(self, *args: Any, **kwargs: Any) -> list[Any]:
        return []


class FakeAttribution:
    def register_pane(self, pane_id: str, **kwargs: Any) -> None:
        pass

    def scan_pane_baseline(self, pane_id: str) -> None:
        pass


@pytest.mark.asyncio
async def test_terminal_create_wires_claude_pane(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # conftest points AGENT_TEAM_DATA_DIR at tmp_path: stage the port
    # discovery file and the startup-written claude config there.
    (tmp_path / "backend-port").write_text("4567", encoding="utf-8")
    plan_mcp_wiring.write_claude_config(4567)
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)

    async def _no_path_refresh(_agent_key: str) -> None:
        pass

    monkeypatch.setattr(app, "_ensure_fresh_path_for_spawn", _no_path_refresh)
    monkeypatch.setattr(app, "_probe_agent_cli_for_spawn", lambda *_a, **_k: None)
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = FakeTerminals()  # type: ignore[assignment]

    # Spawn wiring now runs through the plugin host: boot the builtin
    # navide.plans plugin on the app-level host, then tear it down again.
    plugin_wiring.startup(app.plugin_host)
    try:
        await app.handle_message(session, {
            "id": "m1",
            "type": "terminal.create",
            "payload": {
                "pane_id": "pane-1",
                "agent_key": "claude",
                "command": ["/bin/zsh", "-ilc", "claude --dangerously-skip-permissions"],
                "cwd": "/ws",
                "metadata": {"workspace_path": "/ws"},
            },
        })
    finally:
        plugin_wiring.shutdown(app.plugin_host)

    # The endpoint is shared by every pane, so the URL carries the pane id (and
    # the caller token) — which means claude gets the config inline rather than
    # as a path, so no per-pane file is left behind.
    created = session.terminals.created[0]  # type: ignore[attr-defined]
    inline = plan_mcp_wiring.config_json("claude", 4567, "pane-1")
    assert created["command"][2] == (
        f"claude --dangerously-skip-permissions --mcp-config {osplat.paths.quote_arg(inline)}"
    )
    assert "pane=pane-1" in inline
    assert plan_mcp_wiring.caller_token() in inline


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("agent_key", "expected", "shim_env"),
    [
        ("claude", "claude auth login", None),
        ("codex", "codex login", None),
        # grok and kimi have no MCP flag: their wiring is a per-pane home shim
        # (mcp_server/pane_home.py), pointed at by the variable named here.
        # grok has no config-dir variable, so its shim moves HOME itself.
        ("grok", "grok login", "HOME"),
        ("kimi", "kimi login", "KIMI_CODE_HOME"),
        # kilo's push channel appends `--port N --hostname 127.0.0.1`; an
        # exact-match assertion pins that it stays off the auth subcommand too.
        ("kilo", "kilo auth login", None),
    ],
)
async def test_terminal_create_leaves_a_login_pane_unwired(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    agent_key: str,
    expected: str,
    shim_env: str | None,
) -> None:
    """A live login pane gets no MCP flags — its subcommand rejects them.

    `is_login` rewrites the command to the vendor's sign-in subcommand, and
    a subcommand takes none of the top-level flags this wiring appends:
    measured against claude 2.1.275, `claude auth login --mcp-config …`
    exits 1 with `error: unknown option '--mcp-config'`. The guard used to
    key on `login_profile_id`, which a live login (the active account) does
    not carry, so the pane died the moment it spawned.

    Both wired vendors are covered: claude takes the config as a flag, codex
    as `--config` overrides. codex tolerates the flag where claude does not,
    but a login pane has no business starting MCP servers either way.
    """
    (tmp_path / "backend-port").write_text("4567", encoding="utf-8")
    plan_mcp_wiring.write_claude_config(4567)
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)

    async def _no_path_refresh(_agent_key: str) -> None:
        pass

    monkeypatch.setattr(app, "_ensure_fresh_path_for_spawn", _no_path_refresh)
    monkeypatch.setattr(app, "_probe_agent_cli_for_spawn", lambda *_a, **_k: None)
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = FakeTerminals()  # type: ignore[assignment]

    plugin_wiring.startup(app.plugin_host)
    try:
        await app.handle_message(session, {
            "id": "m1",
            "type": "terminal.create",
            "payload": {
                "pane_id": "login-pane",
                "agent_key": agent_key,
                "command": ["/bin/zsh", "-ilc", f"{agent_key} --dangerously-skip-permissions"],
                "cwd": "/ws",
                "is_login": True,
                "metadata": {"workspace_path": "/ws"},
            },
        })
    finally:
        plugin_wiring.shutdown(app.plugin_host)

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["command"][2] == expected
    # A LIVE login must land in the vendor's real home: signing in under a
    # shimmed home would write the new credential into the shim instead of
    # ~/.grok or ~/.kimi-code, leaving the account signed out where it counts.
    if shim_env is not None:
        assert shim_env not in (created["env"] or {})


@pytest.mark.asyncio
async def test_terminal_create_still_wires_a_login_pane_that_keeps_its_repl(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """`is_login` for a vendor with no sign-in invocation leaves a REPL — wire it.

    Nine vendors declare no `login_command_args`, so `_login_spawn_command`
    hands their command back unchanged and the pane is an ordinary working
    pane. `is_login` reaches the backend straight from a request body
    (`pluginSurfacePorts.ts`), so a caller can set it for any agent; keying
    the wiring skip on `is_login` would silently strip such a pane's MCP,
    skills and push wiring. The skip is keyed on the subcommand instead.
    """
    (tmp_path / "backend-port").write_text("4567", encoding="utf-8")
    plan_mcp_wiring.write_claude_config(4567)
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)

    async def _no_path_refresh(_agent_key: str) -> None:
        pass

    monkeypatch.setattr(app, "_ensure_fresh_path_for_spawn", _no_path_refresh)
    monkeypatch.setattr(app, "_probe_agent_cli_for_spawn", lambda *_a, **_k: None)
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = FakeTerminals()  # type: ignore[assignment]

    # qwen: no login_command_args, and its MCP wiring is an appended flag, so
    # the wiring is observable in the command itself.
    assert cli_vendor("qwen").login_command_args is None

    plugin_wiring.startup(app.plugin_host)
    try:
        await app.handle_message(session, {
            "id": "m1",
            "type": "terminal.create",
            "payload": {
                "pane_id": "login-pane",
                "agent_key": "qwen",
                "command": ["/bin/zsh", "-ilc", "qwen --yolo"],
                "cwd": "/ws",
                "is_login": True,
                "metadata": {"workspace_path": "/ws"},
            },
        })
    finally:
        plugin_wiring.shutdown(app.plugin_host)

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["command"][2].startswith("qwen --yolo ")
    assert "--mcp-config " in created["command"][2]
