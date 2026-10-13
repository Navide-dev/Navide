"""D2: prompts, memory and MCP arguments that look like they carry a secret
are named before they sync — a warning the user can dismiss, never a block,
never a strip. MCP env and header values are expected secrets and travel
sealed, so they are not warned about."""

from __future__ import annotations

import pytest

from agent_team_backend import app, native_memory, sync_scopes
from agent_team_backend.mcp_settings import MCPSettingsStore
from tests.test_sync_engine import FakeSettingsStore

TOKEN = "sk-" + "A1b2C3d4" * 6


@pytest.fixture
def setup(tmp_path, monkeypatch):
    settings = FakeSettingsStore({sync_scopes.SCOPES_SETTING: {"prompts": True, "memory": True, "mcp": True}})
    monkeypatch.setattr(app, "ui_settings_store", settings)
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    monkeypatch.setattr(native_memory, "_home", lambda: home)
    store = MCPSettingsStore(tmp_path / "mcp.json")
    store.replace_servers([])
    monkeypatch.setattr(app, "mcp_settings_store", store)
    return settings, home, store


def _ids(warnings):
    return {(w["scope"], w["itemId"]) for w in warnings}


def test_a_prompt_memory_file_or_mcp_argument_with_a_token_is_named(setup):
    settings, home, store = setup
    settings.doc[sync_scopes.PROMPT_SKILLS_KEY] = [
        {"id": "p1", "name": "deploy", "prompt": f"use api_key={TOKEN} please", "isDefault": True},
        {"id": "p2", "name": "plain", "prompt": "write tests first"},
    ]
    (home / ".claude" / "CLAUDE.md").write_text(f"# notes\nok\nbearer {TOKEN}\n")
    store.replace_servers([
        {"name": "gh", "transport": "stdio", "command": "npx", "args": ["--token", TOKEN], "env": {}, "enabled": True},
        {"name": "quiet", "transport": "stdio", "command": "npx", "args": [], "env": {"GITHUB_TOKEN": TOKEN}, "enabled": True},
    ])
    warnings = sync_scopes.secret_warnings()
    # Memory is no longer synced, so it is no longer warned about.
    assert _ids(warnings) == {("prompts", "p1"), ("mcp", "gh")}
    by = {(w["scope"], w["itemId"]): w for w in warnings}
    assert by[("prompts", "p1")]["label"] == "deploy" and by[("prompts", "p1")]["fields"] == ["prompt"]
    assert by[("mcp", "gh")]["fields"] == ["args"]
    assert TOKEN not in repr(warnings)  # a warning never repeats the secret


def test_a_dismissed_warning_stays_dismissed_until_the_item_changes(setup):
    settings, home, store = setup
    settings.doc[sync_scopes.PROMPT_SKILLS_KEY] = [{"id": "p1", "name": "x", "prompt": f"token: {TOKEN}"}]
    assert _ids(sync_scopes.secret_warnings()) == {("prompts", "p1")}
    sync_scopes.dismiss_secret_warning("prompts", "p1")
    assert sync_scopes.secret_warnings() == []
    settings.doc[sync_scopes.PROMPT_SKILLS_KEY] = [{"id": "p1", "name": "x", "prompt": f"token: {TOKEN} v2"}]
    assert _ids(sync_scopes.secret_warnings()) == {("prompts", "p1")}


def test_a_scope_that_is_off_is_not_scanned(setup):
    settings, home, store = setup
    settings.doc[sync_scopes.SCOPES_SETTING] = {"prompts": False}
    settings.doc[sync_scopes.PROMPT_SKILLS_KEY] = [{"id": "p1", "name": "x", "prompt": f"token: {TOKEN}"}]
    assert sync_scopes.secret_warnings() == []


def test_warning_never_changes_what_syncs(setup):
    settings, home, store = setup
    settings.doc[sync_scopes.PROMPT_SKILLS_KEY] = [{"id": "p1", "name": "x", "prompt": f"token: {TOKEN}"}]
    before = sync_scopes.PromptsScope().snapshot()
    sync_scopes.secret_warnings()
    assert sync_scopes.PromptsScope().snapshot() == before
