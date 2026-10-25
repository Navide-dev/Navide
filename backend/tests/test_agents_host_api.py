"""Plugin `agents.*` Host API: fixed projections, workspace scope, privacy.

What must hold: every answer carries exactly the pinned fields (no account,
profile, usage, log-file or message-text field leaks in through a dict copy);
only the caller's workspace on this machine is visible; sign-in panes never
appear; message text comes back only from read_message; and the module never
imports the account, quota or credential code paths.
"""

from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, agents_host_api, app, login_panes
from agent_team_backend.agent_message_log import AgentMessageLog
from agent_team_backend.db import Database

WS = "/work/alpha"
OTHER = "/work/beta"

FORBIDDEN_KEYS = {
    "profileId", "profile_id", "sessionHomeId", "session_home_id", "usage",
    "usageLimitUntil", "loginExpired", "email", "account", "deviceId",
    "content", "excerpt", "body", "outputLogFile", "output_log_file",
    "workspace_path", "workspacePath", "command", "model",
}


def _record(pane_id: str, **over: Any) -> SimpleNamespace:
    base = dict(
        pane_id=pane_id, spawned_by="", run_group_id="g1", origin="mcp",
        spawn_status="spawned", spawned_at="2026-10-25T01:00:00Z", removed_at="",
        report_to="", custom_name="", auto_name="", profile_id="secret-profile",
        session_home_id="secret-home", output_log_file="/tmp/log", session_id="s",
        agent="claude",
    )
    base.update(over)
    return SimpleNamespace(**base)


@pytest.fixture(autouse=True)
def world(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    agent_messaging._reset_for_test()
    agent_messaging.register("p-root", "lead", WS, agent_key="claude")
    agent_messaging.register("p-child", "worker", WS, agent_key="codex", spawned_by="p-root")
    agent_messaging.register("p-login", "sign-in", WS, agent_key="claude")
    agent_messaging.register("p-other", "lead", OTHER, agent_key="claude")
    records = [
        _record("p-root"),
        _record("p-child", spawned_by="p-root", report_to="lead"),
        _record("p-gone", spawned_by="p-child", spawn_status="removed",
                removed_at="2026-10-25T02:00:00Z", custom_name="old"),
        _record("p-login"),
    ]
    projects = {WS: SimpleNamespace(panes=records)}
    monkeypatch.setattr(app.project_store, "peek", lambda path: projects.get(path))
    monkeypatch.setattr(login_panes, "is_login_pane", lambda pane_id: pane_id == "p-login")
    log = AgentMessageLog(db=Database(tmp_path / "navide.db"))
    log.append([
        {"uid": "m1", "created_at": 100, "status": "delivered", "sender": "alpha/lead",
         "recipient": "alpha/worker", "content": "top secret plan"},
        {"uid": "m2", "created_at": 200, "status": "queued", "sender": "beta/lead",
         "recipient": "alpha/worker", "content": "cross"},
        {"uid": "m3", "created_at": 300, "status": "delivered", "sender": "stranger",
         "recipient": "nobody", "content": "not ours"},
        {"uid": "m4", "created_at": 400, "status": "delivered", "sender": "alpha/lead",
         "recipient": "far", "content": "relayed", "remote": "device-x"},
        # A bare name cannot say which workspace it was: "lead" exists in both.
        {"uid": "m5", "created_at": 500, "status": "delivered", "sender": "lead",
         "recipient": "worker", "content": "beta bare secret"},
        {"uid": "m6", "created_at": 600, "status": "delivered", "sender": "beta/lead",
         "recipient": "beta/worker", "content": "beta qualified secret"},
    ])
    monkeypatch.setattr(app, "agent_message_log", log)
    yield
    agent_messaging._reset_for_test()


def _no_forbidden(rows: list[dict[str, Any]]) -> None:
    for row in rows:
        assert not FORBIDDEN_KEYS & set(row), row


def test_list_panes_is_workspace_scoped_pinned_and_skips_sign_in_panes() -> None:
    panes = agents_host_api.run(WS, "list_panes", {})["panes"]
    assert [p["paneId"] for p in panes] == ["p-root", "p-child"]
    assert all(tuple(p) == agents_host_api.PANE_FIELDS for p in panes)
    _no_forbidden(panes)
    child = panes[1]
    assert child["spawnedBy"] == "p-root" and child["reportTo"] == "lead"


def test_lineage_keeps_closed_panes_only_when_asked() -> None:
    nodes = agents_host_api.run(WS, "lineage", {})["nodes"]
    assert {n["paneId"] for n in nodes} == {"p-root", "p-child"}
    nodes = agents_host_api.run(WS, "lineage", {"includeRemoved": True})["nodes"]
    gone = next(n for n in nodes if n["paneId"] == "p-gone")
    assert gone["parentId"] == "p-child" and gone["name"] == "old" and gone["live"] is False
    assert "p-login" not in {n["paneId"] for n in nodes}
    assert all(tuple(n) == agents_host_api.LINEAGE_FIELDS for n in nodes)
    _no_forbidden(nodes)


def test_list_messages_is_metadata_only_and_local_to_the_workspace() -> None:
    result = agents_host_api.run(WS, "list_messages", {})
    ids = [m["id"] for m in result["messages"]]
    # m3/m6 are another workspace's, m4 was relayed, m5 is bare-name only.
    assert ids == ["m1", "m2"]
    assert all(tuple(m) == agents_host_api.MESSAGE_FIELDS for m in result["messages"])
    _no_forbidden(result["messages"])
    assert result["messages"][0]["bodyLength"] == len("top secret plan")
    assert "top secret" not in repr(result)
    assert result["oldestCreatedAt"] == 100


def test_list_messages_since_and_pane_filter() -> None:
    assert [m["id"] for m in agents_host_api.run(WS, "list_messages", {"since": 100})["messages"]] == ["m2"]
    by_pane = agents_host_api.run(WS, "list_messages", {"paneId": "p-root"})["messages"]
    assert [m["id"] for m in by_pane] == ["m1"]
    with pytest.raises(agents_host_api.AgentsApiError) as err:
        agents_host_api.run(WS, "list_messages", {"paneId": "p-other"})
    assert err.value.code == "INVALID_ARGUMENT"


def test_read_message_returns_the_body_only_inside_the_workspace() -> None:
    message = agents_host_api.run(WS, "read_message", {"id": "m1"})["message"]
    assert message["body"] == "top secret plan"
    assert tuple(message) == (*agents_host_api.MESSAGE_FIELDS, "body")
    for foreign in ("m3", "m4", "m5", "m6"):
        with pytest.raises(agents_host_api.AgentsApiError) as err:
            agents_host_api.run(WS, "read_message", {"id": foreign})
        assert err.value.code == "INVALID_ARGUMENT"


def test_same_bare_name_in_two_workspaces_never_crosses() -> None:
    # Both workspaces have a pane named "lead"; neither sees the other's rows.
    assert agents_host_api.run(OTHER, "read_message", {"id": "m6"})["message"]["body"] == "beta qualified secret"
    for workspace, foreign in ((WS, ("m5", "m6")), (OTHER, ("m1", "m5"))):
        listed = agents_host_api.run(workspace, "list_messages", {})
        assert not set(foreign) & {m["id"] for m in listed["messages"]}
        for message_id in foreign:
            with pytest.raises(agents_host_api.AgentsApiError):
                agents_host_api.run(workspace, "read_message", {"id": message_id})
    assert "secret" not in repr(agents_host_api.run(WS, "list_messages", {}))


def test_a_shared_folder_label_hides_qualified_rows_too() -> None:
    # "/elsewhere/alpha" also addresses as "alpha/...", so "alpha/worker" is ambiguous.
    agent_messaging.register("p-twin", "worker", "/elsewhere/alpha", agent_key="claude")
    assert agents_host_api.run(WS, "list_messages", {})["messages"] == []
    with pytest.raises(agents_host_api.AgentsApiError):
        agents_host_api.run(WS, "read_message", {"id": "m1"})


def test_list_sessions_projects_the_session_rows(monkeypatch: pytest.MonkeyPatch) -> None:
    from agent_team_backend.mcp_server import server

    rows = [
        {"session_id": "s1", "agent_key": "claude", "pane_id": "p-root", "pane_name": "lead",
         "spawned_at": "a", "removed_at": "", "starred": False, "spawned_by": "", "run_group_id": "g1",
         "live": True, "resumable": True, "transcript": "should never leak"},
        {"session_id": "s2", "agent_key": "claude", "pane_id": "p-login", "pane_name": "",
         "spawned_at": "", "removed_at": "", "starred": False, "spawned_by": "", "run_group_id": "",
         "live": False, "resumable": False},
    ]
    seen: list[tuple[Any, ...]] = []

    def fake_rows(*args: Any) -> tuple[list[dict[str, Any]], int]:
        seen.append(args)
        return rows, 2

    monkeypatch.setattr(server, "_session_rows", fake_rows)
    sessions = agents_host_api.run(WS, "list_sessions", {"limit": 10})["sessions"]
    assert seen == [(WS, "", 10, True)]
    assert [s["sessionId"] for s in sessions] == ["s1"]
    assert tuple(sessions[0]) == agents_host_api.SESSION_FIELDS
    assert "transcript" not in repr(sessions)


@pytest.mark.parametrize(
    ("operation", "arguments"),
    [
        ("list_panes", {"workspace": OTHER}),
        ("lineage", {"includeRemoved": "yes"}),
        ("list_messages", {"limit": 0}),
        ("list_messages", {"limit": 201}),
        ("list_messages", {"since": -1}),
        ("read_message", {}),
        ("list_sessions", {"limit": True}),
    ],
)
def test_invalid_arguments_are_refused(operation: str, arguments: dict[str, Any]) -> None:
    with pytest.raises(agents_host_api.AgentsApiError) as err:
        agents_host_api.run(WS, operation, arguments)
    assert err.value.code == "INVALID_ARGUMENT"


async def test_handler_requires_a_host_session() -> None:
    class FakeWebSocket:
        def __init__(self) -> None:
            self.sent: list[dict[str, Any]] = []

        async def send_json(self, payload: dict[str, Any]) -> None:
            self.sent.append(payload)

    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    message = {"id": "q", "type": "agents.public",
               "payload": {"workspace_path": WS, "operation": "list_panes", "arguments": {}}}
    await app.handle_message(session, message)
    assert session.websocket.sent[-1]["error"]["code"] == "UNAUTHORIZED"  # type: ignore[attr-defined]

    session.host_authenticated = True
    await app.handle_message(session, message)
    panes = session.websocket.sent[-1]["payload"]["panes"]  # type: ignore[attr-defined]
    assert [p["paneId"] for p in panes] == ["p-root", "p-child"]

    await app.handle_message(session, {**message, "payload": {**message["payload"], "operation": "read_log"}})
    assert session.websocket.sent[-1]["error"]["code"] == "BAD_REQUEST"  # type: ignore[attr-defined]


def test_module_never_imports_account_quota_or_credential_code() -> None:
    """RULE ZERO: this API must stay off the CLI credential, account-switch and
    quota paths, so it cannot even import them."""
    source = Path(agents_host_api.__file__).read_text(encoding="utf-8")
    forbidden = ("usage_service", "quota", "credential", "profiles_store",
                 "pane_account_history", "server_link", "account")
    for node in ast.walk(ast.parse(source)):
        names: list[str] = []
        if isinstance(node, ast.Import):
            names = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            names = [node.module or "", *(alias.name for alias in node.names)]
        for name in names:
            assert not any(word in name for word in forbidden), name
