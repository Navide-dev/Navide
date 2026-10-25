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
    "sessionId", "session_id", "sender_workspace", "recipient_workspace",
}
TWIN = "/elsewhere/alpha"  # addresses as "alpha/..." exactly like WS


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
         "recipient": "alpha/worker", "content": "top secret plan",
         "sender_workspace": WS, "recipient_workspace": WS},
        # Two workspaces in one window: an unrouted row, both sides stamped.
        {"uid": "m2", "created_at": 200, "status": "queued", "sender": "beta/lead",
         "recipient": "alpha/worker", "content": "cross",
         "sender_workspace": OTHER, "recipient_workspace": WS},
        {"uid": "m3", "created_at": 300, "status": "delivered", "sender": "stranger",
         "recipient": "nobody", "content": "not ours"},
        {"uid": "m4", "created_at": 400, "status": "delivered", "sender": "alpha/lead",
         "recipient": "far", "content": "relayed", "remote": "device-x", "sender_workspace": WS},
        # Bare names stamped by beta's window: "lead" exists in both workspaces.
        {"uid": "m5", "created_at": 500, "status": "delivered", "sender": "lead",
         "recipient": "worker", "content": "beta bare secret",
         "sender_workspace": OTHER, "recipient_workspace": OTHER},
        {"uid": "m6", "created_at": 600, "status": "delivered", "sender": "beta/lead",
         "recipient": "beta/worker", "content": "beta qualified secret",
         "sender_workspace": OTHER, "recipient_workspace": OTHER},
        # Routed in from another workspace's window: excluded even though
        # this workspace's own side is stamped.
        {"uid": "m8", "created_at": 650, "status": "delivered", "sender": "beta/lead",
         "recipient": "worker", "content": "routed secret", "remote": "inbound",
         "remote_workspace": "beta", "recipient_workspace": WS},
        # Written before rows were stamped (0.2.30 and earlier): nobody's.
        {"uid": "m7", "created_at": 700, "status": "delivered", "sender": "alpha/lead",
         "recipient": "alpha/worker", "content": "legacy secret"},
        # A same-label twin workspace's row: the names are WS's, the stamp is not.
        {"uid": "t1", "created_at": 800, "status": "delivered", "sender": "alpha/lead",
         "recipient": "alpha/worker", "content": "twin secret",
         "sender_workspace": TWIN, "recipient_workspace": TWIN},
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
    # m3 unstamped, m4/m8 routed, m5/m6 beta's, m7 legacy, t1 the twin's.
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
    for foreign in ("m3", "m4", "m5", "m6", "m7", "m8", "t1"):
        with pytest.raises(agents_host_api.AgentsApiError) as err:
            agents_host_api.run(WS, "read_message", {"id": foreign})
        assert err.value.code == "INVALID_ARGUMENT"


def test_same_bare_name_in_two_workspaces_never_crosses() -> None:
    # Both workspaces have a pane named "lead"; neither sees the other's rows.
    assert agents_host_api.run(OTHER, "read_message", {"id": "m6"})["message"]["body"] == "beta qualified secret"
    for workspace, foreign in ((WS, ("m5", "m6")), (OTHER, ("m1", "m7"))):
        listed = agents_host_api.run(workspace, "list_messages", {})
        assert not set(foreign) & {m["id"] for m in listed["messages"]}
        for message_id in foreign:
            with pytest.raises(agents_host_api.AgentsApiError):
                agents_host_api.run(workspace, "read_message", {"id": message_id})
    assert "secret" not in repr(agents_host_api.run(WS, "list_messages", {}))


def test_a_same_label_twin_never_leaks_while_open_or_after_it_closed() -> None:
    def visible() -> set[str]:
        return {m["id"] for m in agents_host_api.run(WS, "list_messages", {})["messages"]}

    agent_messaging.register("p-twin", "lead", TWIN, agent_key="claude")
    assert "t1" not in visible()
    agent_messaging.unregister("p-twin")
    assert agent_messaging.list_panes(TWIN) == []
    assert visible() == {"m1", "m2"}
    for message_id in ("t1", "m7"):
        with pytest.raises(agents_host_api.AgentsApiError):
            agents_host_api.run(WS, "read_message", {"id": message_id})


def test_rows_are_stamped_from_the_registry_not_from_names_alone() -> None:
    window_a, window_b = object(), object()
    agent_messaging._reset_for_test()
    agent_messaging.register("a1", "lead", WS, owner=window_a)
    agent_messaging.register("b1", "lead", OTHER, owner=window_b)
    stamp = agent_messaging.workspace_of_name
    # A bare name is looked up only among the writing window's own panes.
    assert stamp("lead", window_a) == WS and stamp("lead", window_b) == OTHER
    assert stamp("lead", None) == "" and stamp("lead", object()) == ""
    assert stamp("alpha/lead", window_a) == WS and stamp("ghost/lead", window_a) == ""
    # A window vouches only for its own panes, qualified names included: a
    # pane of another window (here a same-folder-name twin) is never stamped.
    assert stamp("alpha/lead", window_b) == ""
    agent_messaging.unregister("a1")
    agent_messaging.register("t1", "lead", TWIN, owner=window_b)
    assert stamp("alpha/lead", window_a) == ""
    assert stamp("alpha/lead", window_b) == TWIN
    # Two workspaces in one window: the one row gets both sides stamped.
    agent_messaging.register("b2", "worker", OTHER, owner=window_b)
    assert (stamp("alpha/lead", window_b), stamp("beta/worker", window_b)) == (TWIN, OTHER)
    # The same qualified name for two workspaces of one window stays unstamped.
    agent_messaging.register("a3", "lead", WS, owner=window_b)
    assert stamp("alpha/lead", window_b) == ""


def test_a_stamp_survives_a_later_unstamped_re_append(tmp_path: Path) -> None:
    log = AgentMessageLog(db=Database(tmp_path / "stamp.db"))
    row = {"uid": "u", "created_at": 1, "status": "queued", "sender": "alpha/lead",
           "recipient": "alpha/worker", "content": "x"}
    log.append([{**row, "sender_workspace": WS, "recipient_workspace": ""}])
    log.append([{**row, "status": "delivered", "sender_workspace": "", "recipient_workspace": OTHER}])
    stored = log.tail()[-1]
    assert stored["status"] == "delivered"
    assert (stored["sender_workspace"], stored["recipient_workspace"]) == (WS, OTHER)


async def test_log_append_stamps_rows_and_ignores_the_renderers_word(tmp_path: Path) -> None:
    class FakeWebSocket:
        async def send_json(self, payload: dict[str, Any]) -> None:
            pass

    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    agent_messaging.register("p-root", "lead", WS, agent_key="claude", owner=session)
    agent_messaging.register("p-child", "worker", WS, agent_key="codex", owner=session)
    await app.handle_message(session, {"id": "a", "type": "agent_msg.log_append", "payload": {"rows": [
        {"uid": "s1", "created_at": 900, "status": "delivered", "sender": "lead", "recipient": "worker",
         "content": "bare, this window", "sender_workspace": OTHER, "recipient_workspace": OTHER},
    ]}})
    stored = next(row for row in app.agent_message_log.tail() if row["uid"] == "s1")
    assert (stored["sender_workspace"], stored["recipient_workspace"]) == (WS, WS)
    assert "s1" in {m["id"] for m in agents_host_api.run(WS, "list_messages", {})["messages"]}
    assert "s1" not in {m["id"] for m in agents_host_api.run(OTHER, "list_messages", {})["messages"]}


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
    assert [s["paneId"] for s in sessions] == ["p-root"]  # sign-in pane left out
    _no_forbidden(sessions)
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
