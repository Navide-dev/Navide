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


def test_turning_cursor_skills_off_takes_back_the_folder_and_exclude_navide_created(
    gate, homes, tmp_path, monkeypatch
) -> None:
    wiring = _cursor_skills(tmp_path, monkeypatch)
    repo = _cursor_repo(tmp_path)
    exclude = repo / ".git" / "info" / "exclude"
    exclude.write_text("# user\n", encoding="utf-8")
    convenience_wiring.sync_project_dir_gated("cursor", wiring, str(repo))
    assert "/.cursor/skills/" in exclude.read_text(encoding="utf-8")

    convenience_wiring.set_feature("cursor.project-skills", False, port_file=str(homes["port"]))

    assert exclude.read_text(encoding="utf-8") == "# user\n"
    assert not (repo / ".cursor" / "skills").exists()


def test_turning_cursor_skills_off_drops_only_its_own_exclude_lines_in_the_users_folder(
    gate, homes, tmp_path, monkeypatch
) -> None:
    wiring = _cursor_skills(tmp_path, monkeypatch)
    repo = _cursor_repo(tmp_path)
    (repo / ".cursor" / "skills" / "mine").mkdir(parents=True)
    exclude = repo / ".git" / "info" / "exclude"
    exclude.write_text("# user\n/.cursor/skills/mine-too\n", encoding="utf-8")
    convenience_wiring.sync_project_dir_gated("cursor", wiring, str(repo))
    assert "/.cursor/skills/alpha" in exclude.read_text(encoding="utf-8")

    convenience_wiring.set_feature("cursor.project-skills", False, port_file=str(homes["port"]))

    assert exclude.read_text(encoding="utf-8") == "# user\n/.cursor/skills/mine-too\n"
    assert sorted(p.name for p in (repo / ".cursor" / "skills").iterdir()) == ["mine"]


def _users_skills_behind_a_repo_link(tmp_path: Path, link_level: str) -> tuple[Path, Path, Path]:
    """A cloned repo whose .cursor or .cursor/skills is a link to the user's
    own skills folder, with a manifest naming one of the user's links."""
    from agent_team_backend.plugins.builtin.navide_skills import skills_wiring

    user_cursor = tmp_path / "home" / ".cursor"
    user_skills = user_cursor / "skills"
    user_skills.mkdir(parents=True)
    real_skill = tmp_path / "elsewhere" / "alpha"
    real_skill.mkdir(parents=True)
    (user_skills / "alpha").symlink_to(real_skill)
    (user_skills / skills_wiring.MANIFEST_FILE).write_text("alpha\n", encoding="utf-8")
    repo = _cursor_repo(tmp_path)
    if link_level == "skills":
        (repo / ".cursor").mkdir()
        (repo / ".cursor" / "skills").symlink_to(user_skills)
    else:
        (repo / ".cursor").symlink_to(user_cursor)
    return repo, user_skills, real_skill


@pytest.mark.parametrize("link_level", ["skills", "cursor"])
def test_a_skills_folder_linked_outside_the_repo_is_never_synced(gate, tmp_path, monkeypatch, link_level) -> None:
    from agent_team_backend.plugins.builtin.navide_skills import skills_wiring

    monkeypatch.setattr(skills_wiring, "_managed_sources", lambda *a, **k: [])
    repo, user_skills, real_skill = _users_skills_behind_a_repo_link(tmp_path, link_level)
    wiring = skills_wiring.SkillsWiring(project_rel=(".cursor", "skills"))

    assert convenience_wiring.sync_project_dir_gated("cursor", wiring, str(repo)) is False

    assert (user_skills / "alpha").is_symlink()
    assert gate.listing_feature("cursor.project-skills")["targets"] == []


@pytest.mark.parametrize("link_level", ["skills", "cursor"])
def test_a_skills_folder_linked_outside_the_repo_is_never_removed_from(tmp_path, link_level) -> None:
    from agent_team_backend.plugins.builtin.navide_skills import skills_wiring

    repo, user_skills, _ = _users_skills_behind_a_repo_link(tmp_path, link_level)

    assert skills_wiring.remove_project_dir(repo / ".cursor" / "skills", root=repo) == 0

    assert (user_skills / "alpha").is_symlink()
    assert (user_skills / skills_wiring.MANIFEST_FILE).is_file()


def _two_cursor_skills(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from agent_team_backend.cli_vendors.base import SkillsWiring
    from agent_team_backend.plugins.builtin.navide_skills import skills_wiring

    sources = [tmp_path / "managed" / name for name in ("alpha", "beta")]
    for source in sources:
        source.mkdir(parents=True)
    monkeypatch.setattr(skills_wiring, "_managed_sources", lambda *a, **k: list(sources))
    return SkillsWiring(project_rel=(".cursor", "skills"))


def test_a_planted_skill_link_the_user_deleted_is_refused_in_that_workspace_only(
    gate, tmp_path, monkeypatch
) -> None:
    wiring = _two_cursor_skills(tmp_path, monkeypatch)
    repo = _cursor_repo(tmp_path)
    convenience_wiring.sync_project_dir_gated("cursor", wiring, str(repo))
    skills = repo / ".cursor" / "skills"
    (skills / "alpha").unlink()  # the manifest still names it

    assert convenience_wiring.sync_project_dir_gated("cursor", wiring, str(repo)) is True
    convenience_wiring.sync_project_dir_gated("cursor", wiring, str(repo))

    assert not (skills / "alpha").is_symlink()
    assert (skills / "beta").is_symlink()
    assert gate.state("cursor.project-skills") == ("allowed", "default")
    removed = [(e["target"], e["notify"]) for e in gate.history() if e["action"] == "removed"]
    assert removed == [(str(skills / "alpha"), True)]
    assert not [e for e in gate.history() if e["action"] == "repair"]


def test_re_allowing_cursor_skills_clears_the_refused_names(gate, homes, tmp_path, monkeypatch) -> None:
    wiring = _two_cursor_skills(tmp_path, monkeypatch)
    repo = _cursor_repo(tmp_path)
    convenience_wiring.sync_project_dir_gated("cursor", wiring, str(repo))
    skills = repo / ".cursor" / "skills"
    (skills / "alpha").unlink()
    convenience_wiring.sync_project_dir_gated("cursor", wiring, str(repo))

    convenience_wiring.set_feature("cursor.project-skills", True, port_file=str(homes["port"]))
    convenience_wiring.sync_project_dir_gated("cursor", wiring, str(repo))

    assert (skills / "alpha").is_symlink()


def test_a_cleared_off_then_on_skills_feature_links_a_refused_name_again(
    gate, homes, tmp_path, monkeypatch
) -> None:
    wiring = _two_cursor_skills(tmp_path, monkeypatch)
    repo = _cursor_repo(tmp_path)
    convenience_wiring.sync_project_dir_gated("cursor", wiring, str(repo))
    skills = repo / ".cursor" / "skills"
    (skills / "alpha").unlink()
    convenience_wiring.sync_project_dir_gated("cursor", wiring, str(repo))

    convenience_wiring.set_feature("cursor.project-skills", False, port_file=str(homes["port"]))
    convenience_wiring.set_feature("cursor.project-skills", True, port_file=str(homes["port"]))
    convenience_wiring.sync_project_dir_gated("cursor", wiring, str(repo))

    assert (skills / "alpha").is_symlink() and (skills / "beta").is_symlink()


def test_an_unchanged_skills_directory_is_not_read_as_a_removal(gate, tmp_path, monkeypatch) -> None:
    wiring = _cursor_skills(tmp_path, monkeypatch)
    repo = _cursor_repo(tmp_path)
    convenience_wiring.sync_project_dir_gated("cursor", wiring, str(repo))

    assert convenience_wiring.sync_project_dir_gated("cursor", wiring, str(repo)) is True

    assert gate.state("cursor.project-skills") == ("allowed", "default")


# ── Codex: hook trust (S4) and login promotion (S5) ──────────────────────────

PANE_A = "0a1b2c3d-1111-4222-8333-444455556666"
PANE_B = "0a1b2c3d-7777-4888-8999-aaaabbbbcccc"


def _codex(tmp_path: Path):
    from agent_team_backend.cli_vendors.codex import _toml_escape
    from agent_team_backend.codex_home import CodexHomeManager

    real = tmp_path / "real-codex"
    real.mkdir()
    (real / "hooks.json").write_text('{"hooks": {}}', encoding="utf-8")
    key = _toml_escape(str(real / "hooks.json"))
    (real / "config.toml").write_text(
        f'model = "x"\n\n[hooks.state."{key}:stop:0:0"]\ntrusted_hash = "sha256:aaaa"\n', encoding="utf-8"
    )
    return CodexHomeManager(real_home=real, panes_root=tmp_path / "panes"), real


def test_codex_hook_trust_allowed_seeds_as_before_and_announces_once(gate, tmp_path) -> None:
    manager, real = _codex(tmp_path)

    assert convenience_wiring.seed_hook_trust_gated(manager, manager.prepare(PANE_A)) == 1
    assert convenience_wiring.seed_hook_trust_gated(manager, manager.prepare(PANE_B)) == 1

    text = (real / "config.toml").read_text(encoding="utf-8")
    assert text.count("trusted_hash") == 3
    assert [(e["action"], e["notify"]) for e in gate.history("codex.hook-trust")] == [
        ("repair", False), ("first", True),
    ]


def test_codex_hook_trust_rows_the_user_deleted_turn_the_feature_off(gate, tmp_path) -> None:
    manager, real = _codex(tmp_path)
    before = (real / "config.toml").read_text(encoding="utf-8")
    convenience_wiring.seed_hook_trust_gated(manager, manager.prepare(PANE_A))
    # The user deletes the rows Navide added and keeps their own.
    (real / "config.toml").write_text(before, encoding="utf-8")
    original = before

    assert convenience_wiring.seed_hook_trust_gated(manager, manager.prepare(PANE_B)) == 0

    assert (real / "config.toml").read_text(encoding="utf-8") == original
    assert gate.state("codex.hook-trust") == ("off", "removed")


def test_turning_codex_hook_trust_off_drops_every_seeded_row(gate, homes, tmp_path, monkeypatch) -> None:
    from agent_team_backend import app

    manager, real = _codex(tmp_path)
    monkeypatch.setattr(app, "codex_home_manager", manager)
    before = (real / "config.toml").read_text(encoding="utf-8")
    convenience_wiring.seed_hook_trust_gated(manager, manager.prepare(PANE_A))

    convenience_wiring.set_feature("codex.hook-trust", False, port_file=str(homes["port"]))

    assert (real / "config.toml").read_text(encoding="utf-8").rstrip("\n") == before.rstrip("\n")
    assert convenience_wiring.seed_hook_trust_gated(manager, manager.prepare(PANE_B)) == 0


def test_codex_login_promotion_is_announced_and_stops_when_off(gate, tmp_path) -> None:
    from agent_team_backend.codex_home import CodexHomeManager

    real = tmp_path / "real-codex"
    manager = CodexHomeManager(real_home=real, panes_root=tmp_path / "panes")
    home = manager.prepare(PANE_A)
    (home / "auth.json").write_text("{}", encoding="utf-8")

    assert manager.promote_stranded_auth() is True
    assert gate.history()[0]["feature"] == "codex.login-promote"
    assert gate.history()[0]["notify"] is True

    (real / "auth.json").unlink()
    (home / "auth.json").unlink()
    (home / "auth.json").write_text("{}", encoding="utf-8")
    gate.set_allowed("codex.login-promote", False)

    assert manager.promote_stranded_auth() is False
    assert not (real / "auth.json").exists()


# ── Account auto-repair (D7) ─────────────────────────────────────────────────


def test_an_allowed_repair_restores_and_is_announced(gate) -> None:
    restored: list[str] = []

    assert convenience_wiring.repair_live_login(
        "claude", "slot-a", lambda: restored.append("slot-a"), reason="live login was empty"
    ) is True

    assert restored == ["slot-a"]
    [entry] = gate.history()
    assert (entry["feature"], entry["action"], entry["notify"]) == ("credentials.auto-repair", "repair", True)


def test_a_repair_that_is_off_writes_nothing(gate) -> None:
    gate.set_allowed("credentials.auto-repair", False)
    restored: list[str] = []

    assert convenience_wiring.repair_live_login("claude", "slot-a", lambda: restored.append("x"), reason="r") is False

    assert restored == []


def test_an_account_changed_outside_navide_is_never_overridden(gate) -> None:
    """D7: a different signed-in account becomes a prompt, not a restore."""
    restored: list[str] = []

    assert convenience_wiring.repair_live_login(
        "claude", "slot-a", lambda: restored.append("x"), reason="r",
        live_email="Other@Example.com", slot_email="me@example.com", slot_label="Work",
    ) is False

    assert restored == []
    [entry] = gate.history()
    assert (entry["action"], entry["notify"]) == ("prompt", True)
    assert json.loads(entry["detail"]) == {
        "agentKey": "claude", "slotId": "slot-a", "slotLabel": "Work",
        "liveEmail": "Other@Example.com", "slotEmail": "me@example.com",
    }


def test_the_same_account_in_another_case_is_a_repair_not_a_prompt(gate) -> None:
    restored: list[str] = []

    assert convenience_wiring.repair_live_login(
        "claude", "slot-a", lambda: restored.append("x"), reason="r",
        live_email="ME@example.com", slot_email="me@example.com",
    ) is True
    assert restored == ["x"]


# ── Required features: disclosed, never switched ─────────────────────────────


def test_the_codex_pane_homes_root_is_disclosed_on_first_creation(gate, tmp_path) -> None:
    from agent_team_backend.codex_home import CodexHomeManager

    manager = CodexHomeManager(real_home=tmp_path / "real-codex", panes_root=tmp_path / ".codex-panes")
    manager.prepare(PANE_A)
    manager.prepare(PANE_B)

    entries = [e for e in gate.history() if e["feature"] == "codex.pane-homes"]
    assert [(e["action"], e["target"]) for e in entries] == [("first", str(tmp_path / ".codex-panes"))]


def test_a_file_moved_into_the_real_claude_home_is_announced(gate, tmp_path) -> None:
    from agent_team_backend.credential_vault import CredentialVault

    vault = CredentialVault(root=tmp_path / "profiles", real_home=tmp_path / "home", platform="darwin")
    src = tmp_path / "profiles" / "claude" / "a" / "config-dir" / "CLAUDE.md"
    src.parent.mkdir(parents=True)
    src.write_text("notes", encoding="utf-8")
    target = tmp_path / "home" / ".claude" / "CLAUDE.md"

    assert vault._migrate_file(src, target) is True

    [entry] = [e for e in gate.history() if e["feature"] == "claude.account-homes"]
    assert (entry["action"], entry["target"], entry["notify"]) == ("repair", str(target), True)


def _shim_changes(gate) -> list[tuple[str, str, bool]]:
    return [(e["action"], e["target"], e["notify"]) for e in reversed(gate.history()) if e["feature"] == "pane-shims"]


def test_an_entry_a_pane_shim_moves_into_the_vendors_folder_is_announced(gate, tmp_path) -> None:
    from agent_team_backend.mcp_server import pane_home

    entry = tmp_path / "shim" / "sessions"
    entry.mkdir(parents=True)
    target = tmp_path / "home" / ".kimi-code" / "sessions"

    assert pane_home._adopt(entry, target) is True

    assert _shim_changes(gate) == [("repair", str(target), True)]


def test_a_pane_shim_change_to_the_same_path_is_announced_only_the_first_time(gate, tmp_path) -> None:
    from agent_team_backend.mcp_server import pane_home
    from agent_team_backend.plugins.builtin.navide_skills import skills_wiring

    target = tmp_path / "home" / ".kimi-code" / "sessions"
    for adopt in (pane_home._adopt, skills_wiring._adopt):
        entry = tmp_path / "shim" / "sessions"
        entry.mkdir(parents=True)
        if target.exists():
            target.rmdir()
        adopt(entry, target)

    assert _shim_changes(gate) == [("repair", str(target), True), ("repair", str(target), False)]


def test_empty_entries_a_pane_shim_seeds_in_the_vendors_folder_are_announced(gate, tmp_path) -> None:
    from agent_team_backend.mcp_server import pane_home

    real = tmp_path / "home" / ".grok"
    real.mkdir(parents=True)
    spec = pane_home.SHIM_SPECS["grok"]

    pane_home._seed_link_targets(spec, real, tmp_path / "shim" / ".grok")
    pane_home._seed_link_targets(spec, real, tmp_path / "shim" / ".grok")

    seeded = [real / name for name in (*spec.seeded_dirs, *spec.seeded_files)]
    assert _shim_changes(gate) == [("repair", str(path), True) for path in seeded]


def test_an_entry_a_skills_shim_moves_into_the_vendors_folder_is_announced(gate, tmp_path) -> None:
    from agent_team_backend.plugins.builtin.navide_skills import skills_wiring

    entry = tmp_path / "shim" / "config.json"
    entry.parent.mkdir(parents=True)
    entry.write_text("{}", encoding="utf-8")
    target = tmp_path / "home" / ".copilot" / "config.json"

    skills_wiring._adopt(entry, target)

    assert target.is_file()
    assert _shim_changes(gate) == [("repair", str(target), True)]


def test_pane_shim_changes_are_listed_for_every_cli_that_uses_a_shim(gate, tmp_path) -> None:
    from agent_team_backend import cli_extensions

    gate.note("pane-shims", tmp_path / ".navide-panes")

    rows = cli_extensions.navide_changes(gate.listing()["features"])

    clis = sorted(row.cli for row in rows if row.name == "pane-shims")
    assert clis == ["antigravity", "copilot", "grok", "kimi", "muse", "qwen"]


@pytest.mark.asyncio
async def test_cli_extensions_also_lists_what_navide_changed(gate, tmp_path, monkeypatch) -> None:
    from types import SimpleNamespace

    from agent_team_backend import app, cli_extensions, ws_handlers

    monkeypatch.setattr(app, "convenience_gate", gate)
    monkeypatch.setattr(cli_extensions, "scan", lambda home=None, runner=None: cli_extensions.Inventory(vendors=[], items=[]))
    gate.note("codex.pane-homes", tmp_path / ".codex-panes")
    gate.note("pane-shims", tmp_path / ".navide-panes")
    gate.apply("cursor.project-mcp", tmp_path / "mcp.json", write=lambda: None, present=lambda: True)
    gate.apply("claude.hooks", tmp_path / "settings.json", write=lambda: None, present=lambda: True)
    sent: list[dict] = []

    async def send_json(msg: dict) -> None:
        sent.append(msg)

    await ws_handlers.cli_extensions_list(SimpleNamespace(send_json=send_json), "1", "cli_extensions.list", {})

    rows = [i for i in sent[-1]["payload"]["items"] if i["kind"] == "navide-change"]
    assert {(r["cli"], r["name"]) for r in rows} == {
        ("codex", "codex.pane-homes"), ("cursor", "cursor.project-mcp"),
        ("kimi", "pane-shims"), ("grok", "pane-shims"), ("antigravity", "pane-shims"), ("muse", "pane-shims"),
        ("copilot", "pane-shims"), ("qwen", "pane-shims"),
    }
    assert all(r["owner"] == "navide" and r["valid"] for r in rows)
    assert {r["path"] for r in rows if r["cli"] == "codex"} == {str(tmp_path / ".codex-panes")}
