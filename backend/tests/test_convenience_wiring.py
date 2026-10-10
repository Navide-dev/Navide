"""Write sites routed through the convenience gate.

With every feature allowed (the default) each writer must produce exactly
what it produced before the gate existed; these tests pin that, then cover
off, hand removal and re-allow.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend import claude_hooks, convenience, convenience_wiring, copilot_hooks, qwen_hooks
from agent_team_backend.db import Database


@pytest.fixture
def gate(tmp_path: Path):
    gate = convenience.ConvenienceGate(Database(tmp_path / "navide.db"), backup_root=tmp_path / "backups")
    convenience_wiring.install(gate)
    yield gate
    convenience_wiring.install(None)


@pytest.fixture
def homes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path]:
    claude = tmp_path / "claude"
    qwen = tmp_path / "qwen"
    copilot = tmp_path / "copilot"
    for directory in (claude, qwen, copilot):
        directory.mkdir()
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(claude))
    monkeypatch.setenv("QWEN_HOME", str(qwen))
    monkeypatch.setenv("COPILOT_HOME", str(copilot))
    port = tmp_path / "port"
    port.write_text("1234")
    return {"claude": claude, "qwen": qwen, "copilot": copilot, "port": port}


INSTALLERS = {
    "claude": claude_hooks.install_hooks,
    "qwen": qwen_hooks.install_hooks,
    "copilot": copilot_hooks.install_hooks,
}


def _target(agent: str) -> Path:
    return convenience_wiring._hook_target(agent)[0]


@pytest.mark.parametrize("agent", ["claude", "qwen", "copilot"])
def test_an_allowed_feature_writes_exactly_what_the_installer_wrote_before(gate, homes, tmp_path, agent) -> None:
    (_target(agent)).parent.mkdir(parents=True, exist_ok=True)
    if agent != "copilot":
        _target(agent).write_text(json.dumps({"theme": "dark"}), encoding="utf-8")
    convenience_wiring.install(None)
    INSTALLERS[agent](str(homes["port"]))
    ungated = _target(agent).read_text(encoding="utf-8")
    if agent != "copilot":
        _target(agent).write_text(json.dumps({"theme": "dark"}), encoding="utf-8")
    else:
        _target(agent).unlink()
    convenience_wiring.install(gate)

    result = convenience_wiring.install_hooks_gated(agent, INSTALLERS[agent], str(homes["port"]))

    assert result["convenience"] == "first"
    assert _target(agent).read_text(encoding="utf-8") == ungated


def test_hooks_the_user_deleted_are_not_re_added_at_the_next_start(gate, homes) -> None:
    convenience_wiring.install_hooks_gated("claude", claude_hooks.install_hooks, str(homes["port"]))
    claude_hooks.uninstall_hooks()
    assert not claude_hooks.hooks_present()

    result = convenience_wiring.install_hooks_gated("claude", claude_hooks.install_hooks, str(homes["port"]))

    assert result["convenience"] == "removed"
    assert not claude_hooks.hooks_present()
    assert gate.state("claude.hooks") == ("off", "removed")


def test_turning_hooks_off_removes_only_navides_entries(gate, homes) -> None:
    settings = _target("claude")
    settings.write_text(json.dumps({
        "theme": "dark",
        "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo mine"}]}]},
    }), encoding="utf-8")
    convenience_wiring.install_hooks_gated("claude", claude_hooks.install_hooks, str(homes["port"]))

    convenience_wiring.set_feature("claude.hooks", False, port_file=str(homes["port"]))

    data = json.loads(settings.read_text(encoding="utf-8"))
    assert data["theme"] == "dark"
    assert data["hooks"] == {"Stop": [{"hooks": [{"type": "command", "command": "echo mine"}]}]}
    assert convenience_wiring.install_hooks_gated(
        "claude", claude_hooks.install_hooks, str(homes["port"])
    )["convenience"] == "off"


@pytest.mark.parametrize("agent", ["claude", "qwen", "copilot"])
def test_re_allowing_installs_the_hooks_again_at_once(gate, homes, monkeypatch, agent) -> None:
    monkeypatch.setitem(
        convenience_wiring.__dict__, "_installer", lambda key: INSTALLERS[key]
    )
    convenience_wiring.install_hooks_gated(agent, INSTALLERS[agent], str(homes["port"]))
    convenience_wiring.set_feature(convenience_wiring.HOOK_FEATURES[agent], False, port_file=str(homes["port"]))
    assert not convenience_wiring._hook_target(agent)[1]()

    convenience_wiring.set_feature(convenience_wiring.HOOK_FEATURES[agent], True, port_file=str(homes["port"]))

    assert convenience_wiring._hook_target(agent)[1]()


def test_without_a_gate_the_installer_runs_unchanged(homes) -> None:
    convenience_wiring.install(None)

    result = convenience_wiring.install_hooks_gated("claude", claude_hooks.install_hooks, str(homes["port"]))

    assert result["installed"] is True and "convenience" not in result


def test_the_startup_pass_gates_every_vendor_and_publishes_the_upgrade_notice(gate, homes) -> None:
    """An upgraded install: hooks already there are adopted silently."""
    convenience_wiring.install(None)
    claude_hooks.install_hooks(str(homes["port"]))
    convenience_wiring.install(gate)
    gate.set_allowed("qwen.hooks", False)

    results = convenience_wiring.install_cli_hooks(str(homes["port"]))

    assert results["claude"]["convenience"] == "unchanged"
    assert results["qwen"]["convenience"] == "off"
    assert not (homes["qwen"] / "settings.json").exists()
    assert results["copilot"]["convenience"] == "first"
    assert gate.upgrade_notice() == {"features": ["claude.hooks"]}


@pytest.mark.asyncio
async def test_the_ws_api_lists_switches_and_refuses_a_required_feature(gate, homes, monkeypatch) -> None:
    from types import SimpleNamespace

    from agent_team_backend import app, ws_handlers

    monkeypatch.setattr(app, "convenience_gate", gate)
    sent: list[dict] = []
    events: list[dict] = []

    async def send_json(msg: dict) -> None:
        sent.append(msg)

    async def broadcast(event: dict, **_: object) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", broadcast)
    session = SimpleNamespace(send_json=send_json)
    convenience_wiring.install_hooks_gated("claude", claude_hooks.install_hooks, str(homes["port"]))

    await ws_handlers.convenience_list(session, "1", "convenience.list", {})
    listing = sent[-1]["payload"]
    assert {f["id"] for f in listing["features"]} >= {"claude.hooks", "codex.pane-homes"}
    assert listing["notices"][0]["action"] == "first"

    await ws_handlers.convenience_set(session, "2", "convenience.set", {"id": "claude.hooks", "allowed": False})
    assert sent[-1]["payload"]["feature"]["state"] == "off"
    assert not claude_hooks.hooks_present()
    assert events[-1]["type"] == "convenience.changed"

    await ws_handlers.convenience_set(session, "3", "convenience.set", {"id": "codex.pane-homes", "allowed": False})
    assert sent[-1]["error"]["code"] == "REQUIRED_FEATURE"

    await ws_handlers.convenience_history(session, "4", "convenience.history", {"feature": "claude.hooks"})
    assert [e["action"] for e in sent[-1]["payload"]["entries"]] == ["off", "first"]


# ── Cursor: project MCP config (H1) and project skills (H2) ─────────────────


def _cursor_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    (repo / ".git" / "info").mkdir(parents=True)
    return repo


def test_cursor_mcp_allowed_writes_what_it_wrote_before(gate, tmp_path) -> None:
    from agent_team_backend.mcp_server import wiring

    plain, gated = _cursor_repo(tmp_path / "a"), _cursor_repo(tmp_path / "b")
    assert wiring.ensure_project_config("cursor", plain) is True

    assert convenience_wiring.ensure_project_config_gated("cursor", gated) is True

    path = wiring.project_config_path("cursor", gated)
    assert path.read_text(encoding="utf-8") == wiring.project_config_path("cursor", plain).read_text(encoding="utf-8")
    assert gate.history()[0]["action"] == "first"
    assert gate.history()[0]["target"] == str(path)


def test_cursor_mcp_entry_the_user_deleted_is_not_written_back(gate, tmp_path) -> None:
    from agent_team_backend.mcp_server import wiring

    repo = _cursor_repo(tmp_path)
    convenience_wiring.ensure_project_config_gated("cursor", repo)
    path = wiring.project_config_path("cursor", repo)
    path.write_text('{"mcpServers": {"mine": {"url": "x"}}}\n', encoding="utf-8")

    assert convenience_wiring.ensure_project_config_gated("cursor", repo) is False

    assert path.read_text(encoding="utf-8") == '{"mcpServers": {"mine": {"url": "x"}}}\n'
    assert gate.state("cursor.project-mcp") == ("off", "removed")


def test_turning_cursor_mcp_off_takes_back_only_navides_entry(gate, homes, tmp_path) -> None:
    from agent_team_backend.mcp_server import wiring

    created = _cursor_repo(tmp_path / "created")
    theirs = _cursor_repo(tmp_path / "theirs")
    own = wiring.project_config_path("cursor", theirs)
    own.parent.mkdir(parents=True)
    own.write_text('{"mcpServers": {"mine": {"url": "x"}}}', encoding="utf-8")
    convenience_wiring.ensure_project_config_gated("cursor", created)
    convenience_wiring.ensure_project_config_gated("cursor", theirs)

    convenience_wiring.set_feature("cursor.project-mcp", False, port_file=str(homes["port"]))

    assert not wiring.project_config_path("cursor", created).exists()
    assert ".cursor/mcp.json" not in (created / ".git" / "info" / "exclude").read_text(encoding="utf-8")
    assert json.loads(own.read_text(encoding="utf-8")) == {"mcpServers": {"mine": {"url": "x"}}}


def _cursor_skills(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from agent_team_backend.cli_vendors.base import SkillsWiring
    from agent_team_backend.plugins.builtin.navide_skills import skills_wiring

    source = tmp_path / "managed" / "alpha"
    source.mkdir(parents=True)
    monkeypatch.setattr(skills_wiring, "_managed_sources", lambda *a, **k: [source])
    return SkillsWiring(project_rel=(".cursor", "skills"))


def test_cursor_skills_allowed_plants_links_as_before(gate, tmp_path, monkeypatch) -> None:
    wiring = _cursor_skills(tmp_path, monkeypatch)
    repo = _cursor_repo(tmp_path)

    assert convenience_wiring.sync_project_dir_gated("cursor", wiring, str(repo)) is True

    assert (repo / ".cursor" / "skills" / "alpha").is_symlink()
    assert gate.history()[0]["action"] == "first"


def test_turning_cursor_skills_off_removes_only_planted_links(gate, homes, tmp_path, monkeypatch) -> None:
    wiring = _cursor_skills(tmp_path, monkeypatch)
    repo = _cursor_repo(tmp_path)
    (repo / ".cursor" / "skills" / "mine").mkdir(parents=True)
    convenience_wiring.sync_project_dir_gated("cursor", wiring, str(repo))

    convenience_wiring.set_feature("cursor.project-skills", False, port_file=str(homes["port"]))

    assert sorted(p.name for p in (repo / ".cursor" / "skills").iterdir()) == ["mine"]
    assert convenience_wiring.sync_project_dir_gated("cursor", wiring, str(repo)) is False
    assert not (repo / ".cursor" / "skills" / "alpha").exists()
