"""MCP recovery contract for the production Plans package adapter."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend.fs_service import FsError
from agent_team_backend.mcp_server import auth as plan_mcp_auth
from agent_team_backend.mcp_server import server as plan_mcp
from agent_team_backend.mcp_server.toolkit import Caller
from agent_team_backend.plugins.builtin.navide_plans import plan_tools


_SAFE_RECOVERY = "legacy-safe-before-dispatch"


def _host_context() -> Any:
    return SimpleNamespace(
        request_context=SimpleNamespace(
            request=SimpleNamespace(
                query_params={
                    "client": "host",
                    "t": plan_mcp_auth.internal_token(),
                }
            )
        )
    )


def _route_failure(monkeypatch: pytest.MonkeyPatch, response: Any) -> None:
    async def route(*args: Any, **kwargs: Any) -> Any:
        return response

    monkeypatch.setattr(plan_mcp, "request_host_agent_workspace_backend", route)


@pytest.mark.asyncio
@pytest.mark.parametrize("name,arguments", [
    ("plans.list", {}),
    ("plans.read", {"rel_path": ".agent-team/plans/example.html"}),
])
async def test_read_recovery_requires_the_exact_host_disposition(
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    arguments: dict[str, Any],
) -> None:
    _route_failure(monkeypatch, {
        "ok": False,
        "error": {"code": "BACKEND_UNAVAILABLE", "message": "child unavailable"},
        "recoveryDisposition": _SAFE_RECOVERY,
    })

    result = await plan_tools._host_agent_plan_call(
        Caller(kind="host"),
        "/workspace",
        name,
        arguments,
    )

    assert result is plan_tools._NO_HOST_ROUTE


@pytest.mark.asyncio
@pytest.mark.parametrize("error_code", [
    "BACKEND_UNAVAILABLE",
    "host_timeout",
    "host_unavailable",
    "PROTOCOL_ERROR",
    "PLUGIN_STOPPING",
    "CAPABILITY_DENIED",
])
async def test_mutation_does_not_fallback_without_the_host_disposition(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
    error_code: str,
) -> None:
    _route_failure(monkeypatch, {
        "ok": False,
        "error": {"code": error_code, "message": "Plans operation failed"},
    })
    legacy_calls: list[tuple[Any, ...]] = []

    def legacy_must_not_run(*args: Any) -> dict[str, Any]:
        legacy_calls.append(args)
        return {"stage": "done"}

    monkeypatch.setattr(plan_tools, "_update_stage_sync", legacy_must_not_run)

    with pytest.raises(FsError) as raised:
        await plan_tools.plan_update_stage(
            ".agent-team/plans/example.html",
            "done",
            _host_context(),
            workspace_path=str(tmp_path),
        )

    assert raised.value.code == error_code
    assert legacy_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("response", [
    {"ok": False, "error": {"code": "BACKEND_UNAVAILABLE"}, "recoveryDisposition": "unknown"},
    {"ok": False, "error": {"code": "BACKEND_UNAVAILABLE"}, "recoveryDisposition": None},
    {"ok": False, "recoveryDisposition": _SAFE_RECOVERY},
    None,
])
async def test_unknown_or_malformed_host_recovery_reply_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
    response: Any,
) -> None:
    _route_failure(monkeypatch, response)

    def legacy_must_not_run(*args: Any) -> dict[str, Any]:
        raise AssertionError("legacy Plans mutation must not run")

    monkeypatch.setattr(plan_tools, "_update_stage_sync", legacy_must_not_run)

    with pytest.raises(FsError):
        await plan_tools.plan_update_stage(
            ".agent-team/plans/example.html",
            "done",
            _host_context(),
            workspace_path=str(tmp_path),
        )


@pytest.mark.asyncio
async def test_caller_supplied_disposition_cannot_authorize_recovery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_payloads: list[dict[str, Any]] = []

    async def route(*args: Any, **kwargs: Any) -> dict[str, Any]:
        captured_payloads.append(args[2])
        return {
            "ok": False,
            "error": {"code": "BACKEND_UNAVAILABLE", "message": "child unavailable"},
        }

    monkeypatch.setattr(plan_mcp, "request_host_agent_workspace_backend", route)

    with pytest.raises(FsError) as raised:
        await plan_tools._host_agent_plan_call(
            Caller(kind="host"),
            "/workspace",
            "plans.update_stage",
            {"rel_path": ".agent-team/plans/example.html", "stage": "done", "recoveryDisposition": _SAFE_RECOVERY},
        )

    assert raised.value.code == "BACKEND_UNAVAILABLE"
    assert captured_payloads[0]["args"]["recoveryDisposition"] == _SAFE_RECOVERY


@pytest.mark.asyncio
async def test_host_approved_pre_dispatch_recovery_runs_one_legacy_mutation(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
) -> None:
    _route_failure(monkeypatch, {
        "ok": False,
        "error": {"code": "BACKEND_UNAVAILABLE", "message": "child failed before dispatch"},
        "recoveryDisposition": _SAFE_RECOVERY,
    })
    legacy_calls: list[tuple[str, str, str]] = []

    def legacy_update(workspace_path: str, rel_path: str, stage: str) -> dict[str, Any]:
        legacy_calls.append((workspace_path, rel_path, stage))
        return {"stage": stage, "approvedAt": None}

    monkeypatch.setattr(plan_tools, "_update_stage_sync", legacy_update)

    result = await plan_tools.plan_update_stage(
        ".agent-team/plans/example.html",
        "done",
        _host_context(),
        workspace_path=str(tmp_path),
    )

    assert result == {"stage": "done", "approvedAt": None}
    assert legacy_calls == [(str(tmp_path), ".agent-team/plans/example.html", "done")]


@pytest.mark.asyncio
@pytest.mark.parametrize("response,code", [
    # No Host session at all: request_host_agent_workspace_backend's own reply.
    ({"ok": False, "error": "Navide Host is not connected", "error_code": "host_unavailable"}, "host_unavailable"),
    # Host up but the Plans descriptor/package version is not registered.
    ({"ok": False, "error": {"code": "BACKEND_UNAVAILABLE", "message": "Plans agent backend is unavailable"}},
     "BACKEND_UNAVAILABLE"),
])
async def test_no_host_session_fails_with_an_actionable_message_and_stable_code(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
    response: dict[str, Any],
    code: str,
) -> None:
    _route_failure(monkeypatch, response)

    def legacy_must_not_run(*args: Any) -> Any:
        raise AssertionError("no local fallback without the Host disposition")

    monkeypatch.setattr(plan_tools, "_list_plans_sync", legacy_must_not_run)

    with pytest.raises(FsError) as raised:
        await plan_tools.plan_list(_host_context(), workspace_path=str(tmp_path))

    assert raised.value.code == code
    assert "open Navide" in str(raised.value) and "retry" in str(raised.value)



def _route_sequence(monkeypatch: pytest.MonkeyPatch, replies: list[Any]) -> list[str]:
    calls: list[str] = []

    async def route(_plugin: str, _workspace: str, payload: dict[str, Any], **_kwargs: Any) -> Any:
        calls.append(payload["name"])
        return replies[min(len(calls), len(replies)) - 1]

    monkeypatch.setattr(plan_mcp, "request_host_agent_workspace_backend", route)
    return calls


_HOST_TIMEOUT = {"ok": False, "error": "Navide Host did not answer the backend request", "error_code": "host_timeout"}


@pytest.mark.asyncio
async def test_a_read_is_retried_once_after_a_host_timeout(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    calls = _route_sequence(monkeypatch, [_HOST_TIMEOUT, {"ok": True, "result": []}])

    assert await plan_tools.plan_list(_host_context(), workspace_path=str(tmp_path)) == []
    assert calls == ["plans.list", "plans.list"]


@pytest.mark.asyncio
async def test_a_read_that_times_out_twice_still_fails(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    calls = _route_sequence(monkeypatch, [_HOST_TIMEOUT, _HOST_TIMEOUT, {"ok": True, "result": []}])

    with pytest.raises(FsError) as raised:
        await plan_tools.plan_list(_host_context(), workspace_path=str(tmp_path))

    assert raised.value.code == "host_timeout"
    assert calls == ["plans.list", "plans.list"]


@pytest.mark.asyncio
async def test_a_mutation_is_never_retried_after_a_host_timeout(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    calls = _route_sequence(monkeypatch, [_HOST_TIMEOUT, {"ok": True, "result": {"stage": "done"}}])

    with pytest.raises(FsError) as raised:
        await plan_tools.plan_update_stage(
            ".agent-team/plans/example.html", "done", _host_context(), workspace_path=str(tmp_path),
        )

    assert raised.value.code == "host_timeout"
    assert calls == ["plans.update_stage"]


@pytest.mark.parametrize("caller,registered,expected", [
    (Caller(kind="pane", pane_id="p-1"), SimpleNamespace(name="Reviewer"), "Reviewer"),
    (Caller(kind="pane", pane_id="p-1"), SimpleNamespace(name="  "), "p-1"),
    (Caller(kind="pane", pane_id="p-1"), None, "p-1"),
    (Caller(kind="pane", pane_id="p-1"), SimpleNamespace(name="x" * 201), "p-1"),
    # The Host counts UTF-16 code units: 150 emoji are 300 of them, 100 are 200.
    (Caller(kind="pane", pane_id="p-1"), SimpleNamespace(name="\U0001F600" * 150), "p-1"),
    (Caller(kind="pane", pane_id="p-1"), SimpleNamespace(name="\U0001F600" * 100), "\U0001F600" * 100),
    (Caller(kind="pane", pane_id="p-1"), SimpleNamespace(name="\U00020000" * 101), "p-1"),
    # Blank to JavaScript's trim (U+FEFF) or to Python's strip (U+001C).
    (Caller(kind="pane", pane_id="p-1"), SimpleNamespace(name="\ufeff"), "p-1"),
    (Caller(kind="pane", pane_id="p-1"), SimpleNamespace(name=" \u2028\u3000\ufeff "), "p-1"),
    (Caller(kind="pane", pane_id="p-1"), SimpleNamespace(name="\x1c"), "p-1"),
    # Sent trimmed the way the Host trims.
    (Caller(kind="pane", pane_id="p-1"), SimpleNamespace(name="\ufeffReviewer\u3000"), "Reviewer"),
    # Neither the name nor the id passes: no pane at all.
    (Caller(kind="pane", pane_id="p" * 201), SimpleNamespace(name="\ufeff"), None),
    (Caller(kind="external"), SimpleNamespace(name="Reviewer"), None),
    (Caller(kind="host"), None, None),
])
def test_the_pane_label_is_the_panes_name_or_id_and_nothing_else(
    monkeypatch: pytest.MonkeyPatch, caller: Caller, registered: Any, expected: str | None,
) -> None:
    from agent_team_backend import agent_messaging

    monkeypatch.setattr(agent_messaging, "get", lambda pane_id: registered)
    assert plan_tools._caller_pane(caller) == expected


@pytest.mark.asyncio
async def test_a_plan_call_from_a_pane_passes_its_name_to_the_host(monkeypatch: pytest.MonkeyPatch) -> None:
    from agent_team_backend import agent_messaging

    seen: list[Any] = []

    async def route(*args: Any, **kwargs: Any) -> Any:
        seen.append(kwargs.get("pane"))
        return {"ok": True, "result": {"ok": True}}

    monkeypatch.setattr(plan_mcp, "request_host_agent_workspace_backend", route)
    monkeypatch.setattr(agent_messaging, "get", lambda pane_id: SimpleNamespace(name="Reviewer"))
    await plan_tools._host_agent_plan_call(Caller(kind="pane", pane_id="p-1"), "/workspace", "plans.add_note", {})
    await plan_tools._host_agent_plan_call(Caller(kind="external"), "/workspace", "plans.add_note", {})
    assert seen == ["Reviewer", None]


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["\U0001F600" * 150, "\ufeff"])
async def test_a_name_the_host_would_refuse_falls_back_to_the_pane_id(
    monkeypatch: pytest.MonkeyPatch, name: str,
) -> None:
    from agent_team_backend import agent_messaging

    seen: list[Any] = []

    async def route(*args: Any, **kwargs: Any) -> Any:
        seen.append(kwargs.get("pane"))
        return {"ok": True, "result": {"ok": True}}

    monkeypatch.setattr(plan_mcp, "request_host_agent_workspace_backend", route)
    monkeypatch.setattr(agent_messaging, "get", lambda pane_id: SimpleNamespace(name=name))
    assert await plan_tools._host_agent_plan_call(
        Caller(kind="pane", pane_id="p-1"), "/workspace", "plans.list", {},
    ) == {"ok": True}
    assert seen == ["p-1"]
