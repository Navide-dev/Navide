"""Agent requests to install, update, roll back or remove a Navide plugin (contract section 6).

The skills ApprovalRegistry carries them as kinds next to `skill`; only the
main window can decide one, through a trust confirmation bound to its id.
"""

from __future__ import annotations

import hashlib
import hmac
import inspect
import time
import uuid
from typing import Any

import pytest

from agent_team_backend import app as backend_app
from agent_team_backend import skills_approvals
from agent_team_backend.plugins import agent_tools_contract as contract

REQUESTER = {"paneId": "p-41", "paneName": "dev", "workspace": "/Users/me/project", "callerKind": "pane"}


def _target(version: str | None = "0.2.1", from_version: str | None = "0.2.0") -> dict[str, Any]:
    return {"id": "nerdtechnic.devmap", "namespace": "nerdtechnic", "name": "devmap",
            "version": version, "fromVersion": from_version}


def _file(kind: str = "plugin-update", **overrides: Any) -> dict[str, Any]:
    args: dict[str, Any] = {
        "kind": kind, "requester": REQUESTER, "reason": "Needed for the blocked status.",
        "target": _target(None, None) if kind == "plugin-remove" else _target(),
        "card": {"summary": "card"}, "diff": {"added": []} if kind in {"plugin-update", "plugin-rollback"} else None,
    }
    args.update(overrides)
    return skills_approvals.registry.request_plugin(**args)


@pytest.fixture(autouse=True)
def clean(monkeypatch: pytest.MonkeyPatch):
    skills_approvals.registry._reset_for_test()
    events: list[dict[str, Any]] = []

    async def broadcast(event: dict[str, Any], **_: Any) -> None:
        events.append(event)

    monkeypatch.setattr(backend_app, "broadcast", broadcast)
    yield events
    skills_approvals.registry._reset_for_test()


def test_record_has_the_contract_shape() -> None:
    record = _file()
    assert set(record) == set(contract.PluginApprovalRequest.__annotations__)
    assert record["kind"] == "plugin-update"
    assert record["owner"] == "plugin-update:nerdtechnic.devmap@0.2.1"
    assert record["requester"] == REQUESTER
    assert record["reason"] == "Needed for the blocked status."
    assert record["target"] == _target()
    assert record["card"] == {"summary": "card"} and record["diff"] == {"added": []}
    assert record["status"] == "pending" and record["error"] is None
    assert record["expires_at"] == pytest.approx(record["created_at"] + contract.PLUGIN_APPROVAL_TTL_S)


@pytest.mark.parametrize("kind", ["plugin-install", "plugin-update", "plugin-rollback", "plugin-remove"])
def test_every_plugin_kind_is_accepted(kind: str) -> None:
    record = _file(kind)
    version = "" if kind == "plugin-remove" else "0.2.1"
    assert record["owner"] == f"{kind}:nerdtechnic.devmap@{version}"


def test_unknown_kind_or_bad_target_is_refused() -> None:
    for kind in ("skill", "plugin-disable", ""):
        with pytest.raises(skills_approvals.SkillApprovalError) as refused:
            _file(kind)
        assert refused.value.code == "BAD_REQUEST"
    with pytest.raises(skills_approvals.SkillApprovalError):
        _file(target={"id": "", "namespace": "n", "name": "m", "version": "1.0.0", "fromVersion": None})
    with pytest.raises(skills_approvals.SkillApprovalError):
        _file("plugin-install", target=_target(None, None))


def test_same_key_returns_the_pending_record_and_there_is_no_count_limit() -> None:
    first = _file()
    again = _file(reason="another reason", requester={**REQUESTER, "paneId": "p-42"})
    assert again["approval_id"] == first["approval_id"]
    for index in range(200):
        _file("plugin-install", target=_target(f"1.0.{index}", None))
    assert len(skills_approvals.registry.pending(plugin=True)) == 201


def test_finished_plugin_records_are_never_pruned_by_count() -> None:
    ids = [_file("plugin-install", target=_target(f"2.0.{index}", None))["approval_id"] for index in range(100)]
    for approval_id in ids:
        skills_approvals.registry.claim(approval_id, "rejected", plugin=True)
    _file("plugin-install", target=_target("3.0.0", None))
    assert all(skills_approvals.registry.get(approval_id) for approval_id in ids)


def test_a_pending_request_expires_after_15_minutes(monkeypatch: pytest.MonkeyPatch) -> None:
    record = _file()
    real_time = time.time
    monkeypatch.setattr(skills_approvals.time, "time", lambda: real_time() + 15 * 60 + 1)
    assert skills_approvals.registry.get(record["approval_id"])["status"] == "expired"
    with pytest.raises(skills_approvals.SkillApprovalError) as refused:
        skills_approvals.registry.claim(record["approval_id"], "applying", plugin=True)
    assert refused.value.code == "PLUGIN_APPROVAL_NOT_PENDING"
    assert _file()["approval_id"] != record["approval_id"]


async def test_decide_moves_to_applying_or_rejected_once(clean) -> None:
    approved = _file()
    result = await skills_approvals.decide_plugin(approved["approval_id"], True)
    assert result["status"] == "applying"
    with pytest.raises(skills_approvals.SkillApprovalError):
        await skills_approvals.decide_plugin(approved["approval_id"], False)
    skills_approvals.registry.finish(approved["approval_id"], "completed")
    assert skills_approvals.registry.get(approved["approval_id"])["status"] == "completed"
    rejected = _file("plugin-remove")
    assert (await skills_approvals.decide_plugin(rejected["approval_id"], False))["status"] == "rejected"
    assert [event["type"] for event in clean] == ["plugins.agent_request_resolved"] * 2
    assert clean[-1]["payload"] == {"approval_id": rejected["approval_id"], "status": "rejected", "error": None}


async def test_the_two_paths_never_decide_each_other(monkeypatch: pytest.MonkeyPatch) -> None:
    plugin = _file()
    with pytest.raises(skills_approvals.SkillApprovalError) as refused:
        await skills_approvals.decide(plugin["approval_id"], True, installer=None)
    assert refused.value.code == "SKILL_APPROVAL_NOT_FOUND"
    assert skills_approvals.registry.get(plugin["approval_id"])["status"] == "pending"
    assert skills_approvals.registry.pending() == []
    assert [r["approval_id"] for r in skills_approvals.registry.pending(plugin=True)] == [plugin["approval_id"]]


def test_request_and_decide_take_no_consent_argument() -> None:
    for function in (skills_approvals.registry.request_plugin, skills_approvals.decide_plugin):
        names = set(inspect.signature(function).parameters)
        assert not names & {"consent", "confirm", "confirmation", "approved", "trusted"}


# ── WebSocket decide: only a window's confirmation counts ───────────────────

def _confirm(subject: str, action: str = contract.PLUGIN_APPROVAL_DECIDE_ACTION) -> dict[str, str]:
    """What the main process mints for the window, as test_skills_approvals does."""
    nonce, expires = uuid.uuid4().hex, str(time.time() + 30)
    payload = "\x00".join(("navide/trust-confirm/v2", nonce, expires, action, "", subject))
    mac = hmac.new(b"test-confirmation-key", payload.encode(), hashlib.sha256).hexdigest()
    return {"nonce": nonce, "expires": expires, "mac": mac}


@pytest.fixture
def confirmable():
    from agent_team_backend import confirm_token

    confirm_token._reset_for_test("test-confirmation-key")
    yield
    confirm_token._reset_for_test()


async def test_ws_decide_needs_the_window_confirmation_for_this_request(confirmable) -> None:
    from tests.test_settings_ws_integration import _request as ws_request, _session

    record, other = _file(), _file("plugin-remove")
    approval_id = record["approval_id"]
    session = _session()
    attempts = [
        {"approval_id": approval_id, "approve": True},
        # Consent flags on the protocol mean nothing.
        {"approval_id": approval_id, "approve": True, "consent": True, "confirmed": True, "trusted": True},
        # The skills field name is not this message's.
        {"approval_id": approval_id, "approve": True, "confirm": _confirm(approval_id)},
        # Bound to another request.
        {"approval_id": approval_id, "approve": True, "confirmation": _confirm(other["approval_id"])},
        # Minted for another action.
        {"approval_id": approval_id, "approve": True,
         "confirmation": _confirm(approval_id, "skills.install_approval.decide")},
    ]
    for attempt in attempts:
        refused = await ws_request(session, contract.PLUGIN_APPROVAL_DECIDE_ACTION, attempt)
        assert refused["error"]["code"] == "CONFIRMATION_REQUIRED", attempt
    assert skills_approvals.registry.get(approval_id)["status"] == "pending"

    decided = await ws_request(session, contract.PLUGIN_APPROVAL_DECIDE_ACTION,
                               {"approval_id": approval_id, "approve": True, "confirmation": _confirm(approval_id)})
    assert decided["payload"]["approval"]["status"] == "applying"
    again = await ws_request(session, contract.PLUGIN_APPROVAL_DECIDE_ACTION,
                             {"approval_id": approval_id, "approve": False, "confirmation": _confirm(approval_id)})
    assert again["error"]["code"] == "PLUGIN_APPROVAL_NOT_PENDING"


async def test_skills_decide_cannot_reach_a_plugin_request(confirmable) -> None:
    from tests.test_settings_ws_integration import _request as ws_request, _session

    record = _file()
    approval_id = record["approval_id"]
    subject = f"{approval_id}:approve"
    refused = await ws_request(_session(), "skills.install_approval.decide", {
        "approval_id": approval_id, "approve": True,
        "confirm": _confirm(subject, "skills.install_approval.decide"),
    })
    assert refused["error"]["code"] == "SKILL_APPROVAL_NOT_FOUND"
    assert skills_approvals.registry.get(approval_id)["status"] == "pending"


def test_skill_records_keep_their_fields_with_kind_skill() -> None:
    preview = {"preview_id": "pv", "digest": "d", "name": "gated", "source": {"path": "/s"},
               "files": [], "skill_md": "x", "warnings": [], "expires_at": time.time() + 60}
    record = skills_approvals.registry.request(owner="pane:pa", targets=None, preview=preview)
    assert set(record) == {
        "approval_id", "kind", "owner", "preview_id", "expected_digest", "targets", "name", "source",
        "digest", "files", "skill_md", "warnings", "expires_at", "status", "result", "error", "created_at",
    }
    assert record["kind"] == "skill" and record["status"] == "pending"
    assert [r["approval_id"] for r in skills_approvals.registry.pending()] == [record["approval_id"]]
    assert skills_approvals.registry.pending(plugin=True) == []
