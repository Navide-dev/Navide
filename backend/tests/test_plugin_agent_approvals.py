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
    skills_approvals.registry.finish_plugin(approved["approval_id"], "completed")
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


def test_finish_only_moves_applying_to_completed_or_failed() -> None:
    registry = skills_approvals.registry
    pending = _file("plugin-install", target=_target("4.0.0", None))
    rejected = _file("plugin-install", target=_target("4.0.1", None))
    registry.claim(rejected["approval_id"], "rejected", plugin=True)
    for approval_id, status in ((pending["approval_id"], "completed"), (rejected["approval_id"], "completed"),
                                (rejected["approval_id"], "failed")):
        with pytest.raises(skills_approvals.SkillApprovalError) as refused:
            registry.finish_plugin(approval_id, status)
        assert refused.value.code == "PLUGIN_APPROVAL_NOT_APPLYING"
    # The generic finish (the skill path) never touches a plugin record.
    registry.finish(pending["approval_id"], "completed")
    registry.finish(rejected["approval_id"], "completed")
    assert registry.get(pending["approval_id"])["status"] == "pending"
    assert registry.get(rejected["approval_id"])["status"] == "rejected"
    for status in ("completed", "failed"):
        record = _file("plugin-install", target=_target(f"5.0.{status}", None))
        registry.claim(record["approval_id"], "applying", plugin=True)
        with pytest.raises(skills_approvals.SkillApprovalError):
            registry.finish_plugin(record["approval_id"], "rejected")
        registry.finish_plugin(record["approval_id"], status, error="boom" if status == "failed" else None)
        assert registry.get(record["approval_id"])["status"] == status
        with pytest.raises(skills_approvals.SkillApprovalError):
            registry.finish_plugin(record["approval_id"], status)


def test_agent_text_must_be_strings_and_is_cleaned() -> None:
    record = _file(reason="ok\x07\x1b[31m \u202eevil\u200b\u2028next\r\n\tline",
                   requester={**REQUESTER, "paneName": "d\u200bev\x00", "workspace": "/w\u202e"})
    assert record["reason"] == "ok[31m evilnext\n\tline"
    assert record["requester"]["paneName"] == "dev"
    assert record["requester"]["workspace"] == "/w"
    long = "x" * 200_000
    assert _file("plugin-install", target=_target("6.0.0", None), reason=long)["reason"] == long
    for bad in (
        {"reason": None}, {"reason": 42}, {"reason": ["a"]},
        {"requester": "pane"}, {"requester": {**REQUESTER, "paneName": 3}},
        {"requester": {**REQUESTER, "callerKind": "user"}}, {"requester": {**REQUESTER, "extra": "x"}},
        {"requester": {k: v for k, v in REQUESTER.items() if k != "workspace"}},
    ):
        with pytest.raises(skills_approvals.SkillApprovalError) as refused:
            _file("plugin-install", target=_target("7.0.0", None), **bad)
        assert refused.value.code == "BAD_REQUEST", bad


def test_target_id_must_be_namespace_dot_name() -> None:
    for target in (
        {**_target(), "id": "other.devmap"},
        {**_target(), "name": "other"},
        {**_target(), "id": "nerdtechnicdevmap"},
    ):
        with pytest.raises(skills_approvals.SkillApprovalError) as refused:
            _file(target=target)
        assert refused.value.code == "BAD_REQUEST", target


def test_request_and_decide_take_no_consent_argument() -> None:
    for function in (skills_approvals.registry.request_plugin, skills_approvals.decide_plugin):
        names = set(inspect.signature(function).parameters)
        assert not names & {"consent", "confirm", "confirmation", "approved", "trusted"}


# ── WebSocket decide: only a window's confirmation counts ───────────────────

def _confirm(subject: str, action: str = contract.PLUGIN_APPROVAL_DECIDE_ACTION,
             expires: float | None = None) -> dict[str, str]:
    """What the main process mints for the window, as test_skills_approvals does."""
    nonce = uuid.uuid4().hex
    expiry = str(time.time() + 30 if expires is None else expires)
    payload = "\x00".join(("navide/trust-confirm/v2", nonce, expiry, action, "", subject))
    mac = hmac.new(b"test-confirmation-key", payload.encode(), hashlib.sha256).hexdigest()
    return {"nonce": nonce, "expires": expiry, "mac": mac}


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
        {"approval_id": approval_id, "approve": True, "confirm": _confirm(f"{approval_id}:approve")},
        # Bound to another request.
        {"approval_id": approval_id, "approve": True, "confirmation": _confirm(f"{other['approval_id']}:approve")},
        # Minted for another action.
        {"approval_id": approval_id, "approve": True,
         "confirmation": _confirm(f"{approval_id}:approve", "skills.install_approval.decide")},
        # A reject confirmation spent as an approval, and the other way round.
        {"approval_id": approval_id, "approve": True, "confirmation": _confirm(f"{approval_id}:reject")},
        {"approval_id": approval_id, "approve": False, "confirmation": _confirm(f"{approval_id}:approve")},
        # Bound to the bare approval_id, without the decision.
        {"approval_id": approval_id, "approve": True, "confirmation": _confirm(approval_id)},
        # Expired.
        {"approval_id": approval_id, "approve": True,
         "confirmation": _confirm(f"{approval_id}:approve", expires=time.time() - 1)},
    ]
    for attempt in attempts:
        refused = await ws_request(session, contract.PLUGIN_APPROVAL_DECIDE_ACTION, attempt)
        assert refused["error"]["code"] == "CONFIRMATION_REQUIRED", attempt
    assert skills_approvals.registry.get(approval_id)["status"] == "pending"

    token = _confirm(f"{approval_id}:approve")
    decided = await ws_request(session, contract.PLUGIN_APPROVAL_DECIDE_ACTION,
                               {"approval_id": approval_id, "approve": True, "confirmation": token})
    assert decided["payload"]["approval"]["status"] == "applying"
    # A used confirmation is refused before the registry is asked.
    replayed = await ws_request(session, contract.PLUGIN_APPROVAL_DECIDE_ACTION,
                                {"approval_id": approval_id, "approve": True, "confirmation": token})
    assert replayed["error"]["code"] == "CONFIRMATION_REQUIRED"
    again = await ws_request(session, contract.PLUGIN_APPROVAL_DECIDE_ACTION,
                             {"approval_id": approval_id, "approve": False,
                              "confirmation": _confirm(f"{approval_id}:reject")})
    assert again["error"]["code"] == "PLUGIN_APPROVAL_NOT_PENDING"
    rejected = await ws_request(session, contract.PLUGIN_APPROVAL_DECIDE_ACTION,
                                {"approval_id": other["approval_id"], "approve": False,
                                 "confirmation": _confirm(f"{other['approval_id']}:reject")})
    assert rejected["payload"]["approval"]["status"] == "rejected"


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
