"""Prepared Skills cross the MCP boundary without gaining write permission."""

from pathlib import Path
from types import SimpleNamespace

import pytest
from mcp.server.fastmcp import FastMCP
from mcp.shared.memory import create_connected_server_and_client_session

from agent_team_backend import agent_messaging, native_skills, skills_approvals, skills_events
from agent_team_backend import app as backend_app
from agent_team_backend.mcp_server import wiring
from agent_team_backend.plugins.builtin.navide_skills import skills_tools
from agent_team_backend.skills_store import SkillsStore


def _context(token: str | None = None):
    query = {"pane": "skill-contract", "t": wiring.caller_token("skill-contract") if token is None else token}
    return SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=query)))


@pytest.fixture
def service(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    agent_messaging._reset_for_test()
    skills_approvals.registry._reset_for_test()
    agent_messaging.register("skill-contract", "contract", str(tmp_path), agent_key="codex")
    monkeypatch.setattr(native_skills, "native_roots", lambda home=None: [])
    store = SkillsStore(root=tmp_path / "shared", state_path=tmp_path / "state.json",
                        runtime_root=tmp_path / "runtime", native_roots=[])
    monkeypatch.setattr(backend_app, "skills_store", store)
    notifications = []

    async def notify(name, operation):
        notifications.append((name, operation))

    monkeypatch.setattr(skills_events, "notify_skills_changed", notify)
    yield store, notifications
    agent_messaging._reset_for_test()


async def test_candidate_selection_is_structured_without_an_installable_token(service, monkeypatch):
    calls = []
    candidates = [{"path": "skills/one", "name": "one", "description": "First skill"},
                  {"path": "skills/two", "name": "two", "description": "Second skill"}]

    def preview(source, **kwargs):
        calls.append((source, kwargs))
        return {"selection_required": True, "candidates": candidates,
                "source": {"kind": "github", "repository": "example/skills", "commit": "a" * 40}}

    monkeypatch.setattr(skills_tools, "_installer", lambda: SimpleNamespace(preview=preview))
    server = FastMCP("skill-candidate-contract")
    skills_tools.install(server)
    monkeypatch.setattr(server, "get_context", _context)
    async with create_connected_server_and_client_session(server._mcp_server) as client:
        response = await client.call_tool("skills_prepare_install", {"source": "example/skills", "ref": "main"})
    assert response.isError is False
    result = response.structuredContent
    assert result["ok"] and result["selection_required"]
    assert result["candidates"] == candidates
    assert "preview_id" not in result and "digest" not in result
    assert result["materialized_in_current_session"] is None
    assert result["loaded_in_current_session"] is None
    assert calls == [("example/skills", {"owner_key": "pane:skill-contract", "ref": "main", "subdir": ""})]
    assert not service[0].root.exists()
    assert service[1] == []


async def test_unauthenticated_prepare_never_reads_the_source(service, monkeypatch):
    def unexpected():
        pytest.fail("untrusted caller reached the installer")

    monkeypatch.setattr(skills_tools, "_installer", unexpected)
    result = await skills_tools.skills_prepare_install("example/skills", _context("wrong"))
    assert result["error"]["code"] == "CALLER_UNKNOWN"
    assert not service[0].root.exists()
    assert service[1] == []


async def test_user_approval_installs_snapshot_and_provenance_survives_restart(service, tmp_path, monkeypatch):
    store, notifications = service
    source = tmp_path / "source"
    source.mkdir()
    content = "---\nname: contract-skill\ndescription: Contract check\n---\nReviewed instructions.\n"
    (source / "SKILL.md").write_text(content, encoding="utf-8")
    preview = await skills_tools.skills_prepare_install(str(source), _context())
    assert preview["ok"] and not store.root.exists()
    (source / "SKILL.md").write_text(content.replace("Reviewed", "Changed"), encoding="utf-8")
    requested = await skills_tools.skills_install(preview["preview_id"], preview["digest"], [], _context())
    assert requested["status"] == "pending_approval"
    assert not store.root.exists() and not store.write_consented() and notifications == []
    approval = await skills_approvals.decide(requested["approval_id"], True, skills_tools._installer())
    assert approval["status"] == "installed", approval
    assert (store.root / "contract-skill" / "SKILL.md").read_text(encoding="utf-8") == content
    inspected = await skills_tools.skills_inspect("shared:contract-skill", _context())
    provenance = inspected["skill"]["provenance"]
    assert provenance["digest"] == preview["digest"]
    assert provenance["source"]["path"] == str(source)
    assert inspected["skill"]["targets"] == []
    assert "codex" in inspected["automatic_agents"]
    assert inspected["materialized_in_current_session"] is None
    assert inspected["loaded_in_current_session"] is None
    restarted = SkillsStore(root=store.root, state_path=store.state_path,
                            runtime_root=store.runtime_root, native_roots=[])
    monkeypatch.setattr(backend_app, "skills_store", restarted)
    after_restart = await skills_tools.skills_inspect("shared:contract-skill", _context())
    assert after_restart["skill"]["provenance"] == provenance
    assert notifications == [("contract-skill", "installed")]
