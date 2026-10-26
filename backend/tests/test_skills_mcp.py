"""Skills MCP uses caller identity, safe library identities and atomic routing."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from mcp.server.fastmcp import FastMCP
from mcp.shared.memory import create_connected_server_and_client_session

from agent_team_backend import agent_messaging, native_skills, skills_approvals, skills_events
from agent_team_backend import app as backend_app
from agent_team_backend.mcp_server import auth, wiring
from agent_team_backend.plugins.builtin.navide_skills import skills_tools
from agent_team_backend.skills_store import SkillsStore


def _ctx(pane_id: str = "pa", *, token: str | None = None, client: str = "") -> Any:
    params = {"client": client, "t": token or ""} if client else {
        "pane": pane_id, "t": wiring.caller_token(pane_id) if token is None else token,
    }
    return SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))


async def _approve(requested: dict[str, Any]) -> dict[str, Any]:
    assert requested["status"] == "pending_approval", requested
    return await skills_approvals.decide(requested["approval_id"], True, skills_tools._installer())


@pytest.fixture
def library(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[SkillsStore, Path, list[tuple[str, str]]]:
    agent_messaging._reset_for_test()
    skills_approvals.registry._reset_for_test()
    agent_messaging.register("pa", "reviewer", str(tmp_path), agent_key="codex")
    agent_messaging.register("pb", "other", str(tmp_path), agent_key="claude")
    native_root = tmp_path / "native"
    native_root.mkdir()
    monkeypatch.setattr(native_skills, "native_roots", lambda home=None: [("claude", native_root)])
    store = SkillsStore(root=tmp_path / "shared", state_path=tmp_path / "state.json",
                        runtime_root=tmp_path / "runtime", native_roots=[native_root])
    store.create_skill("verify", "Useful checks", consent=True)
    native = native_root / "native-check"
    native.mkdir()
    (native / "SKILL.md").write_bytes(b"---\nname: native-check\ndescription: Native checks\n---\nReview first.\n")
    monkeypatch.setattr(backend_app, "skills_store", store)
    notifications: list[tuple[str, str]] = []

    async def notify(name: str, operation: str) -> None:
        notifications.append((name, operation))

    monkeypatch.setattr(skills_events, "notify_skills_changed", notify)
    yield store, native, notifications
    agent_messaging._reset_for_test()


async def test_tools_are_registered_with_effect_annotations() -> None:
    server = FastMCP("skills-test")
    skills_tools.install(server)
    tools = {tool.name: tool for tool in await server.list_tools()}
    assert set(tools) == {
        "skills_inspect", "skills_prepare_install", "skills_install", "skills_install_status",
        "skills_set_delivery",
    }
    assert tools["skills_inspect"].annotations.readOnlyHint is True
    assert tools["skills_prepare_install"].annotations.openWorldHint is True
    assert tools["skills_install"].annotations.readOnlyHint is False
    assert tools["skills_install"].annotations.destructiveHint is False
    assert tools["skills_install_status"].annotations.readOnlyHint is True
    assert "consent" not in tools["skills_install"].inputSchema["properties"]
    assert "ctx" not in tools["skills_inspect"].inputSchema["properties"]


async def test_registered_protocol_returns_structured_success_and_errors(library, monkeypatch) -> None:
    server = FastMCP("skills-protocol-test")
    skills_tools.install(server)
    monkeypatch.setattr(server, "get_context", lambda: _ctx())
    async with create_connected_server_and_client_session(server._mcp_server) as client:
        listing = await client.list_tools()
        assert any(tool.name == "skills_inspect" for tool in listing.tools)
        result = await client.call_tool("skills_inspect", {"skill_id": "shared:verify"})
        assert result.isError is False
        assert result.structuredContent["skill"]["id"] == "shared:verify"
        refused = await client.call_tool("skills_inspect", {"skill_id": "shared:missing"})
        assert refused.isError is True
        assert refused.structuredContent["error"]["code"] == "SKILL_NOT_FOUND"


@pytest.mark.parametrize("context", ["bad-token", "stale", "external-disabled"])
async def test_identity_is_validated_before_reading_or_writing(library, monkeypatch, context) -> None:
    store, _, _ = library
    before = store.state_path.read_bytes()
    if context == "bad-token":
        ctx = _ctx(token="wrong")
    elif context == "stale":
        ctx = _ctx("closed")
    else:
        ctx = _ctx(client="external", token=auth.external_token())
    result = await skills_tools.skills_set_delivery("shared:verify", [], "unused", ctx)
    assert result["error"]["code"] == "CALLER_UNKNOWN"
    assert store.state_path.read_bytes() == before


async def test_external_access_uses_existing_opt_in(library) -> None:
    ctx = _ctx(client="external", token=auth.external_token())
    assert (await skills_tools.skills_inspect("shared:verify", ctx))["ok"] is False
    auth.set_external_enabled(True)
    assert (await skills_tools.skills_inspect("shared:verify", ctx))["ok"] is True


async def test_inspect_returns_content_and_separate_delivery_revision(library) -> None:
    result = await skills_tools.skills_inspect("shared:verify", _ctx())
    assert result["ok"] is True
    assert result["skill"]["fields"]["name"] == "verify"
    assert result["skill"]["delivery_revision"] != result["skill"]["revision"]
    assert result["materialized_in_current_session"] is None
    assert result["loaded_in_current_session"] is None
    assert result["activation"] == "new_session"
    assert "codex" in result["automatic_agents"]
    json.dumps(result)


@pytest.mark.parametrize("kind", ["shared", "native"])
async def test_inspect_lists_nested_manifest_attachments(library, tmp_path, kind) -> None:
    store, native, _ = library
    if kind == "shared":
        source = tmp_path / "source"
        source.mkdir()
        (source / "SKILL.md").write_text("---\nname: nested-docs\ndescription: Nested docs\n---\nInstructions\n")
    else:
        source = native
    (source / "docs").mkdir()
    (source / "docs" / "SKILL.md").write_text("Nested skill documentation\n")
    if kind == "shared":
        preview = await skills_tools.skills_prepare_install(str(source), _ctx())
        assert "docs/SKILL.md" in {row["path"] for row in preview["files"]}
        requested = await skills_tools.skills_install(preview["preview_id"], preview["digest"], [], _ctx())
        assert (await _approve(requested))["status"] == "installed"
        identity = "shared:nested-docs"
        installed_root = store.root / "nested-docs"
    else:
        identity = skills_tools.skill_id({"real_path": str(native.resolve())}, native=True)
        installed_root = native
        (native / ".navide").write_text("private marker\n")
    result = await skills_tools.skills_inspect(identity, _ctx())
    assert result["ok"]
    assert {row["path"] for row in result["skill"]["files"]} == {"SKILL.md", "docs/SKILL.md"}
    assert result["skill"]["files_truncated"] is False
    assert (installed_root / "docs" / "SKILL.md").read_text() == "Nested skill documentation\n"


@pytest.mark.parametrize("identity", ["verify", "shared:missing", "native:/etc/passwd", "shared:../../elsewhere"])
async def test_inspect_only_accepts_current_library_identities(library, identity) -> None:
    result = await skills_tools.skills_inspect(identity, _ctx())
    assert result["error"]["code"] == "SKILL_NOT_FOUND"


async def test_invalid_skill_cannot_be_inspected_or_delivered(library) -> None:
    store, _, notifications = library
    (store.root / "verify" / "SKILL.md").write_text("not valid frontmatter")
    inspected = await skills_tools.skills_inspect("shared:verify", _ctx())
    changed = await skills_tools.skills_set_delivery("shared:verify", [], "old", _ctx())
    assert inspected["error"]["code"] == changed["error"]["code"] == "SKILL_VALIDATION_ERROR"
    assert notifications == []


async def test_delivery_revision_catches_ui_change_without_overwriting(library) -> None:
    store, _, notifications = library
    inspected = await skills_tools.skills_inspect("shared:verify", _ctx())
    store.set_targets("verify", ["claude"])
    result = await skills_tools.skills_set_delivery(
        "shared:verify", ["codex"], inspected["skill"]["delivery_revision"], _ctx(), enabled=False
    )
    assert result["error"]["code"] == "SKILL_CONFLICT"
    skill = store.get_skill("verify")["skill"]
    assert skill["targets"] == ["claude"] and skill["enabled"] is True
    assert notifications == []


async def test_combined_delivery_change_and_noop_have_one_notification(library) -> None:
    store, _, notifications = library
    revision = store.get_delivery_revision(name="verify")
    result = await skills_tools.skills_set_delivery("shared:verify", ["claude"], revision, _ctx(), enabled=False)
    assert result["ok"] is True and result["changed"] is True
    assert result["loaded_in_current_session"] is None
    saved = store.get_skill("verify")["skill"]
    assert saved["enabled"] is False and saved["targets"] == ["claude"]
    again = await skills_tools.skills_set_delivery("shared:verify", ["claude"], result["revision"], _ctx(), enabled=False)
    assert again["ok"] is True and again["changed"] is False
    assert notifications == [("verify", "delivery_changed")]


@pytest.mark.parametrize("targets", [["unknown-vendor"], ["../../codex"], [1], "codex"])
async def test_invalid_targets_do_not_partially_change_enabled(library, targets) -> None:
    store, _, _ = library
    revision = store.get_delivery_revision(name="verify")
    before = store.state_path.read_bytes()
    result = await skills_tools.skills_set_delivery("shared:verify", targets, revision, _ctx(), enabled=False)
    assert result["error"]["code"] == "SKILL_VALIDATION_ERROR"
    assert store.state_path.read_bytes() == before


async def test_native_delivery_never_modifies_native_files(library) -> None:
    store, native, notifications = library
    identity = skills_tools.skill_id({"real_path": str(native)}, native=True)
    before = (native / "SKILL.md").read_bytes()
    inspected = await skills_tools.skills_inspect(identity, _ctx())
    assert inspected["skill"]["body"] == "Review first.\n"
    assert inspected["automatic_agents"] == ["claude"]
    assert inspected["skills_sync_enabled"] is False
    revision = inspected["skill"]["delivery_revision"]
    refused = await skills_tools.skills_set_delivery(identity, ["codex"], revision, _ctx(), enabled=False)
    assert refused["error"]["code"] == "SKILL_VALIDATION_ERROR"
    result = await skills_tools.skills_set_delivery(identity, ["codex"], revision, _ctx())
    assert result["ok"] is True and result["status"] == "pending_approval"
    assert store.native_targets_for("codex") == []
    approval = await skills_approvals.decide(result["approval_id"], True, skills_tools._installer())
    assert approval["status"] == "installed"
    assert store.native_targets_for("codex") == [str(native)]
    assert (native / "SKILL.md").read_bytes() == before
    assert notifications == [("native-check", "delivery_changed")]


async def test_widening_delivery_waits_for_the_window_and_writes_nothing(library, monkeypatch) -> None:
    store, _, notifications = library
    events: list[tuple[str, dict]] = []

    async def broadcast(event: dict) -> None:
        events.append((event["type"], event["payload"]))

    monkeypatch.setattr(backend_app, "broadcast", broadcast)
    store.set_targets("verify", [])
    before = store.state_path.read_bytes()
    revision = store.get_delivery_revision(name="verify")
    result = await skills_tools.skills_set_delivery("shared:verify", ["claude"], revision, _ctx())
    assert result["ok"] is True and result["status"] == "pending_approval" and result["changed"] is False
    assert store.state_path.read_bytes() == before and notifications == []
    [(kind, card)] = events
    assert kind == "skills.install_approval_request"
    assert card["action"] == "delivery" and card["targets"] == ["claude"]
    assert card["current"] == {"targets": [], "enabled": True} and "expected_revision" not in card
    again = await skills_tools.skills_set_delivery("shared:verify", ["claude"], revision, _ctx())
    assert again["approval_id"] == result["approval_id"]
    status = await skills_tools.skills_install_status(result["approval_id"], _ctx())
    assert status["status"] == "pending"
    hidden = await skills_tools.skills_install_status(result["approval_id"], _ctx("pb"))
    assert hidden["error"]["code"] == "SKILL_APPROVAL_NOT_FOUND"
    approval = await skills_approvals.decide(result["approval_id"], True, skills_tools._installer())
    assert approval["status"] == "installed" and approval["result"]["targets"] == ["claude"]
    assert store.get_skill("verify")["skill"]["targets"] == ["claude"]
    assert notifications == [("verify", "delivery_changed")]


async def test_rejected_delivery_is_not_applied_or_refiled(library) -> None:
    store, _, notifications = library
    store.set_targets("verify", ["claude"])
    revision = store.get_delivery_revision(name="verify")
    result = await skills_tools.skills_set_delivery("shared:verify", None, revision, _ctx())
    assert result["status"] == "pending_approval"
    rejected = await skills_approvals.decide(result["approval_id"], False, skills_tools._installer())
    assert rejected["status"] == "rejected"
    assert store.get_skill("verify")["skill"]["targets"] == ["claude"]
    again = await skills_tools.skills_set_delivery("shared:verify", None, revision, _ctx())
    assert again["error"]["code"] == "SKILL_APPROVAL_REJECTED"
    assert notifications == []


async def test_turning_a_disabled_skill_on_waits_but_turning_it_off_does_not(library) -> None:
    store, _, _ = library
    revision = store.get_delivery_revision(name="verify")
    off = await skills_tools.skills_set_delivery("shared:verify", None, revision, _ctx(), enabled=False)
    assert off["status"] == "applied" and store.get_skill("verify")["skill"]["enabled"] is False
    on = await skills_tools.skills_set_delivery("shared:verify", None, off["revision"], _ctx(), enabled=True)
    assert on["status"] == "pending_approval"
    assert store.get_skill("verify")["skill"]["enabled"] is False


async def test_delivery_changed_after_the_request_fails_instead_of_overwriting(library) -> None:
    store, _, notifications = library
    store.set_targets("verify", [])
    revision = store.get_delivery_revision(name="verify")
    result = await skills_tools.skills_set_delivery("shared:verify", ["claude"], revision, _ctx())
    store.set_targets("verify", ["codex"])
    approval = await skills_approvals.decide(result["approval_id"], True, skills_tools._installer())
    assert approval["status"] == "failed" and approval["error"]
    assert store.get_skill("verify")["skill"]["targets"] == ["codex"]
    assert notifications == []


async def test_invalid_widening_fails_before_filing_a_request(library) -> None:
    store, _, _ = library
    store.set_targets("verify", [])
    revision = store.get_delivery_revision(name="verify")
    result = await skills_tools.skills_set_delivery("shared:verify", ["unknown-vendor"], revision, _ctx())
    assert result["error"]["code"] == "SKILL_VALIDATION_ERROR"
    stale = await skills_tools.skills_set_delivery("shared:verify", ["claude"], "old", _ctx())
    assert stale["error"]["code"] == "SKILL_CONFLICT"
    assert skills_approvals.registry.pending() == []


async def test_native_skill_removed_since_list_cannot_be_written(library) -> None:
    _, native, _ = library
    identity = skills_tools.skill_id({"real_path": str(native)}, native=True)
    (native / "SKILL.md").unlink()
    result = await skills_tools.skills_set_delivery(identity, ["codex"], "old", _ctx())
    assert result["error"]["code"] == "SKILL_VALIDATION_ERROR"


async def test_two_simultaneous_updates_cannot_both_accept_the_same_revision(library) -> None:
    store, _, notifications = library
    revision = store.get_delivery_revision(name="verify")
    results = await asyncio.gather(
        skills_tools.skills_set_delivery("shared:verify", ["claude"], revision, _ctx()),
        skills_tools.skills_set_delivery("shared:verify", ["codex"], revision, _ctx("pb")),
    )
    assert sum(row["ok"] for row in results) == 1
    assert len(notifications) == 1
    refused = next(row for row in results if not row["ok"])
    assert refused["error"]["code"] == "SKILL_CONFLICT"


async def test_notification_failure_does_not_turn_committed_write_into_failure(library, monkeypatch) -> None:
    store, _, _ = library

    async def fail(*args):
        raise OSError("disconnected")

    monkeypatch.setattr(skills_events, "notify_skills_changed", fail)
    result = await skills_tools.skills_set_delivery(
        "shared:verify", [], store.get_delivery_revision(name="verify"), _ctx()
    )
    assert result["ok"] is True and result["warnings"]
    assert store.get_skill("verify")["skill"]["targets"] == []


async def test_preview_install_retains_owner_and_same_installer(library, tmp_path) -> None:
    # Exercise the real service through both wrappers, using only temporary files.
    source = tmp_path / "source"
    source.mkdir()
    (source / "SKILL.md").write_text("---\nname: installed\ndescription: New skill\n---\nReview me.\n")
    preview = await skills_tools.skills_prepare_install(str(source), _ctx())
    assert preview["ok"] is True
    assert "codex" in preview["automatic_agents"]
    assert preview["skills_sync_enabled"] is False
    wrong_owner = await skills_tools.skills_install(
        preview["preview_id"], preview["digest"], ["codex"], _ctx("pb")
    )
    assert wrong_owner["ok"] is False
    requested = await skills_tools.skills_install(
        preview["preview_id"], preview["digest"], ["codex"], _ctx()
    )
    approval = await _approve(requested)
    assert approval["status"] == "installed" and approval["result"]["name"] == "installed"
    assert (library[0].root / "installed" / "SKILL.md").is_file()
    inspected = await skills_tools.skills_inspect("shared:installed", _ctx())
    provenance = inspected["skill"]["provenance"]
    assert provenance["source"] == preview["source"]
    assert provenance["digest"] == preview["digest"]
    assert provenance["installed_at"]
    again = await skills_tools.skills_install(
        preview["preview_id"], preview["digest"], ["codex"], _ctx()
    )
    assert again["ok"] is True and again["status"] == "installed" and again["changed"] is False
    assert again["materialized_in_current_session"] is None
    assert again["loaded_in_current_session"] is None
    assert library[2] == [("installed", "installed")]
