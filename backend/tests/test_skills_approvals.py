"""skills_install only files a request; the user's decision in Navide writes."""

from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, native_skills, skills_approvals, skills_events
from agent_team_backend import app as backend_app
from agent_team_backend.mcp_server import wiring
from agent_team_backend.plugins.builtin.navide_skills import skills_tools
from agent_team_backend.skills_store import SkillsStore


def _ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": wiring.caller_token(pane_id)}
    return SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    agent_messaging._reset_for_test()
    skills_approvals.registry._reset_for_test()
    agent_messaging.register("pa", "requester", str(tmp_path), agent_key="codex")
    agent_messaging.register("pb", "other", str(tmp_path), agent_key="claude")
    monkeypatch.setattr(native_skills, "native_roots", lambda home=None: [])
    store = SkillsStore(root=tmp_path / "shared", state_path=tmp_path / "state.json",
                        runtime_root=tmp_path / "runtime", native_roots=[])
    monkeypatch.setattr(backend_app, "skills_store", store)
    events: list[dict[str, Any]] = []

    async def broadcast(event: dict[str, Any], **_: Any) -> None:
        events.append(event)

    monkeypatch.setattr(backend_app, "broadcast", broadcast)
    notifications: list[tuple[str, str]] = []

    async def notify(name: str, operation: str) -> None:
        notifications.append((name, operation))

    monkeypatch.setattr(skills_events, "notify_skills_changed", notify)
    source = tmp_path / "source"
    source.mkdir()
    (source / "SKILL.md").write_bytes(b"---\nname: gated\ndescription: Gated skill\n---\nBody.\n")
    yield SimpleNamespace(store=store, source=source, events=events, notifications=notifications)
    agent_messaging._reset_for_test()
    skills_approvals.registry._reset_for_test()


def _files(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("*")) if root.exists() else []


async def _request(env, targets=None, pane: str = "pa") -> tuple[dict, dict]:
    preview = await skills_tools.skills_prepare_install(str(env.source), _ctx(pane))
    assert preview["ok"], preview
    requested = await skills_tools.skills_install(preview["preview_id"], preview["digest"], targets, _ctx(pane))
    return preview, requested


async def test_install_only_files_a_pending_request_even_with_consent(env) -> None:
    preview = await skills_tools.skills_prepare_install(str(env.source), _ctx())
    before = _files(env.store.root)
    state_before = env.store.state_path.read_bytes() if env.store.state_path.exists() else None
    result = await skills_tools.skills_install(preview["preview_id"], preview["digest"], None, _ctx())
    assert result["ok"] is True and result["status"] == "pending_approval"
    assert result["approval_id"] and result["expires_at"] == preview["expires_at"]
    assert _files(env.store.root) == before
    assert (env.store.state_path.read_bytes() if env.store.state_path.exists() else None) == state_before
    assert not env.store.write_consented() and env.notifications == []
    [event] = env.events
    assert event["type"] == "skills.install_approval_request"
    payload = event["payload"]
    assert payload["approval_id"] == result["approval_id"] and payload["owner"] == "pane:pa"
    assert payload["name"] == "gated" and payload["skill_md"].endswith("Body.\n")
    assert "preview_id" not in payload and "expected_digest" not in payload


async def test_consent_argument_grants_nothing_over_the_protocol(env, monkeypatch) -> None:
    from mcp.server.fastmcp import FastMCP
    from mcp.shared.memory import create_connected_server_and_client_session

    preview = await skills_tools.skills_prepare_install(str(env.source), _ctx())
    server = FastMCP("skills-approval-test")
    skills_tools.install(server)
    monkeypatch.setattr(server, "get_context", lambda: _ctx())
    async with create_connected_server_and_client_session(server._mcp_server) as client:
        response = await client.call_tool("skills_install", {
            "preview_id": preview["preview_id"], "expected_digest": preview["digest"],
            "targets": None, "consent": True,
        })
    assert response.isError is False
    assert response.structuredContent["status"] == "pending_approval"
    assert not env.store.root.exists()


async def test_approve_installs_and_broadcasts_resolution(env) -> None:
    _, requested = await _request(env, targets=["codex"])
    approval = await skills_approvals.decide(requested["approval_id"], True, skills_tools._installer())
    assert approval["status"] == "installed" and approval["result"]["name"] == "gated"
    assert (env.store.root / "gated" / "SKILL.md").is_file()
    assert env.store.get_skill("gated")["skill"]["targets"] == ["codex"]
    assert env.notifications == [("gated", "installed")]
    assert env.events[-1]["type"] == "skills.install_approval_resolved"
    assert env.events[-1]["payload"]["status"] == "installed"
    status = await skills_tools.skills_install_status(requested["approval_id"], _ctx())
    assert status["status"] == "installed" and status["result"]["name"] == "gated"
    assert skills_approvals.registry.pending() == []


async def test_reject_writes_nothing(env) -> None:
    _, requested = await _request(env)
    approval = await skills_approvals.decide(requested["approval_id"], False, skills_tools._installer())
    assert approval["status"] == "rejected"
    assert not env.store.root.exists() and env.notifications == []
    assert env.events[-1]["payload"] == {
        "approval_id": requested["approval_id"], "status": "rejected", "error": None,
    }
    status = await skills_tools.skills_install_status(requested["approval_id"], _ctx())
    assert status["status"] == "rejected"


async def test_a_rejected_preview_cannot_be_filed_again(env) -> None:
    preview, requested = await _request(env)
    await skills_approvals.decide(requested["approval_id"], False, skills_tools._installer())
    events = len(env.events)
    again = await skills_tools.skills_install(preview["preview_id"], preview["digest"], None, _ctx())
    assert again["ok"] is False and again["error"]["code"] == "SKILL_APPROVAL_REJECTED"
    assert skills_approvals.registry.pending() == [] and len(env.events) == events


async def test_other_owner_cannot_see_the_request(env) -> None:
    _, requested = await _request(env)
    other = await skills_tools.skills_install_status(requested["approval_id"], _ctx("pb"))
    assert other["ok"] is False and other["error"]["code"] == "SKILL_APPROVAL_NOT_FOUND"
    missing = await skills_tools.skills_install_status("nope", _ctx())
    assert missing["error"]["code"] == "SKILL_APPROVAL_NOT_FOUND"


async def test_expired_request_cannot_be_approved(env, monkeypatch) -> None:
    preview, requested = await _request(env)
    real_time = time.time
    monkeypatch.setattr(skills_approvals.time, "time", lambda: real_time() + 16 * 60)
    status = await skills_tools.skills_install_status(requested["approval_id"], _ctx())
    assert status["status"] == "expired"
    assert skills_approvals.registry.pending() == []
    with pytest.raises(skills_approvals.SkillApprovalError) as refused:
        await skills_approvals.decide(requested["approval_id"], True, skills_tools._installer())
    assert refused.value.code == "SKILL_APPROVAL_NOT_PENDING"
    assert not env.store.root.exists()


async def test_repeat_decide_does_not_reinstall(env, monkeypatch) -> None:
    _, requested = await _request(env)
    installer = skills_tools._installer()
    calls: list[str] = []
    real_install = installer.install

    def counting(*args: Any, **kwargs: Any) -> dict:
        calls.append(args[0])
        return real_install(*args, **kwargs)

    monkeypatch.setattr(installer, "install", counting)
    await skills_approvals.decide(requested["approval_id"], True, installer)
    for approve in (True, False):
        with pytest.raises(skills_approvals.SkillApprovalError):
            await skills_approvals.decide(requested["approval_id"], approve, installer)
    assert len(calls) == 1
    assert skills_approvals.registry.get(requested["approval_id"])["status"] == "installed"


async def test_repeat_install_request_reuses_the_pending_approval(env) -> None:
    preview, first = await _request(env)
    second = await skills_tools.skills_install(preview["preview_id"], preview["digest"], None, _ctx())
    assert second["approval_id"] == first["approval_id"]
    assert len(skills_approvals.registry.pending()) == 1
    other_targets = await skills_tools.skills_install(preview["preview_id"], preview["digest"], [], _ctx())
    assert other_targets["ok"] is False


async def test_status_wait_returns_once_decided(env) -> None:
    import asyncio

    _, requested = await _request(env)

    async def approve_later() -> None:
        await asyncio.sleep(0.05)
        await skills_approvals.decide(requested["approval_id"], True, skills_tools._installer())

    task = asyncio.create_task(approve_later())
    status = await skills_tools.skills_install_status(requested["approval_id"], _ctx(), wait_s=5)
    await task
    assert status["status"] == "installed"


async def test_failed_install_reports_error(env) -> None:
    _, requested = await _request(env)
    env.store.create_skill("gated", "Conflicting skill", consent=True)
    approval = await skills_approvals.decide(requested["approval_id"], True, skills_tools._installer())
    assert approval["status"] == "failed" and approval["error"]
    assert env.events[-1]["payload"]["status"] == "failed"


def _confirm(approval_id: str, approve: bool) -> dict[str, str]:
    """What the main process mints for the window, as test_ws_handlers_trust does."""
    import hashlib
    import hmac
    import uuid

    nonce, expires = uuid.uuid4().hex, str(time.time() + 30)
    subject = f"{approval_id}:{'approve' if approve else 'reject'}"
    payload = "\x00".join(("navide/trust-confirm/v2", nonce, expires,
                           "skills.install_approval.decide", "", subject))
    mac = hmac.new(b"test-confirmation-key", payload.encode(), hashlib.sha256).hexdigest()
    return {"nonce": nonce, "expires": expires, "mac": mac}


@pytest.fixture
def confirmable():
    from agent_team_backend import confirm_token

    confirm_token._reset_for_test("test-confirmation-key")
    yield
    confirm_token._reset_for_test()


async def test_ws_decide_without_a_window_confirmation_is_refused(env, confirmable) -> None:
    from tests.test_settings_ws_integration import _request as ws_request, _session

    _, requested = await _request(env)
    session = _session()
    approval_id = requested["approval_id"]
    refused = await ws_request(session, "skills.install_approval.decide",
                               {"approval_id": approval_id, "approve": True})
    assert refused["error"]["code"] == "CONFIRMATION_REQUIRED"
    # A reject confirmation cannot be spent as an approval.
    swapped = await ws_request(session, "skills.install_approval.decide",
                               {"approval_id": approval_id, "approve": True,
                                "confirm": _confirm(approval_id, False)})
    assert swapped["error"]["code"] == "CONFIRMATION_REQUIRED"
    assert skills_approvals.registry.get(approval_id)["status"] == "pending"
    assert not (env.store.root / "gated").exists()


async def test_ws_handlers_list_and_decide(env, confirmable) -> None:
    from tests.test_settings_ws_integration import _request as ws_request, _session

    _, requested = await _request(env)
    session = _session()
    listed = await ws_request(session, "skills.install_approvals.list")
    [approval] = listed["payload"]["approvals"]
    assert approval["approval_id"] == requested["approval_id"] and approval["status"] == "pending"
    decided = await ws_request(session, "skills.install_approval.decide",
                               {"approval_id": requested["approval_id"], "approve": True,
                                "confirm": _confirm(requested["approval_id"], True)})
    assert decided["payload"]["approval"]["status"] == "installed"
    assert (env.store.root / "gated" / "SKILL.md").is_file()
    again = await ws_request(session, "skills.install_approval.decide",
                             {"approval_id": requested["approval_id"], "approve": True,
                              "confirm": _confirm(requested["approval_id"], True)})
    assert again["error"]["code"] == "SKILL_APPROVAL_NOT_PENDING"
    assert (await ws_request(session, "skills.install_approvals.list"))["payload"]["approvals"] == []
