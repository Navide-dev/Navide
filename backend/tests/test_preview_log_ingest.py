"""The two automatic writers of the preview record.

The store's merge rules are covered by ``test_preview_log``; what is proved
here is the wiring: the CLI hook feeds attributed rows and the git watcher
feeds the anonymous catch-all, each with the right change and path — and
neither can disturb what it rides along with (the hook receiver's busy-state
response, the `git.changed` payload the Git panel already reads).
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agent_team_backend import agent_messaging
from agent_team_backend import app as app_module
from agent_team_backend.app import app
from agent_team_backend import hook_auth
from agent_team_backend import preview_log as preview_log_module
from agent_team_backend.git_watcher import _RepoHandler
from agent_team_backend.mcp_server import server as plan_mcp, wiring as plan_mcp_wiring

WS_SESSION = "s-hook"


@pytest.fixture()
def client() -> TestClient:
    # No context manager: startup events (watchers/MCP) must not run in tests.
    # base_url pinned to loopback: the default "testserver" Host is exactly
    # what reject_foreign_host refuses.
    client = TestClient(app, base_url="http://127.0.0.1")
    # What an installed hook presents (read out of the 0600 header file at
    # fire time); without it the endpoint answers 403 to everyone.
    client.headers[hook_auth.HEADER] = hook_auth.token()
    return client


@pytest.fixture()
def events(monkeypatch) -> list[dict]:
    captured: list[dict] = []

    async def fake_broadcast(event, **_kwargs):
        captured.append(event)

    monkeypatch.setattr(app_module, "broadcast", fake_broadcast)
    return captured


@pytest.fixture()
def ws(tmp_path: Path, monkeypatch) -> Path:
    """A workspace every hook session resolves to."""
    root = tmp_path / "ws"
    root.mkdir()
    monkeypatch.setattr(
        app_module.attribution,
        "pane_for_session",
        lambda _sid: ("pane-1", str(root), "stage-1"),
    )
    return root


def _post_tool(client: TestClient, tool: str, file_path: str | None) -> None:
    tool_input = {} if file_path is None else {"file_path": file_path}
    client.post(
        "/hooks/claude",
        headers={"X-Agent-Team-Event": "pre_tool_use"},
        json={
            "session_id": WS_SESSION,
            "cwd": "/tmp/ws",
            "tool_name": tool,
            "tool_input": tool_input,
        },
    )


def _rows(ws: Path) -> list[dict]:
    return app_module.preview_log.tail(str(ws))


# ── hook receiver ────────────────────────────────────────────────────────


def test_write_to_a_missing_file_is_recorded_as_created(
    client: TestClient, events: list[dict], ws: Path
) -> None:
    _post_tool(client, "Write", str(ws / "src" / "new.ts"))
    rows = _rows(ws)
    assert len(rows) == 1
    assert rows[0]["change"] == "created"
    assert rows[0]["rel_path"] == "src/new.ts"
    assert rows[0]["title"] == "new.ts"
    assert rows[0]["source"] == "agent"
    assert rows[0]["pane_id"] == "pane-1"
    assert rows[0]["agent"] == "claude"
    assert rows[0]["tool"] == "Write"
    assert rows[0]["kind"] == "file"


def test_write_to_an_existing_file_is_recorded_as_modified(
    client: TestClient, events: list[dict], ws: Path
) -> None:
    target = ws / "a.ts"
    target.write_text("x", encoding="utf-8")
    _post_tool(client, "Edit", str(target))
    rows = _rows(ws)
    assert len(rows) == 1
    assert rows[0]["change"] == "modified"
    assert rows[0]["tool"] == "Edit"


def test_a_path_outside_the_workspace_is_dropped(
    client: TestClient, events: list[dict], ws: Path, tmp_path: Path
) -> None:
    outside = tmp_path / "elsewhere" / "secret.ts"
    outside.parent.mkdir()
    _post_tool(client, "Write", str(outside))
    assert _rows(ws) == []


def test_a_symlink_pointing_out_of_the_workspace_is_dropped(
    client: TestClient, events: list[dict], ws: Path, tmp_path: Path
) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (ws / "escape").symlink_to(outside, target_is_directory=True)
    _post_tool(client, "Write", str(ws / "escape" / "loot.ts"))
    assert _rows(ws) == []


@pytest.mark.parametrize("tool", ["Read", "Bash", "Grep", "Task"])
def test_a_non_write_tool_records_nothing(
    client: TestClient, events: list[dict], ws: Path, tool: str
) -> None:
    _post_tool(client, tool, str(ws / "a.ts"))
    assert _rows(ws) == []


def test_a_write_tool_without_a_file_path_records_nothing(
    client: TestClient, events: list[dict], ws: Path
) -> None:
    _post_tool(client, "Write", None)
    assert _rows(ws) == []


def test_the_receiver_still_answers_when_recording_blows_up(
    client: TestClient, events: list[dict], ws: Path, monkeypatch
) -> None:
    """The response this endpoint owes the busy-state path is not negotiable."""

    def boom(*_args, **_kwargs):
        raise RuntimeError("db on fire")

    monkeypatch.setattr(app_module.preview_log, "append", boom)
    resp = client.post(
        "/hooks/claude",
        headers={"X-Agent-Team-Event": "pre_tool_use"},
        json={
            "session_id": WS_SESSION,
            "cwd": "/tmp/ws",
            "tool_name": "Write",
            "tool_input": {"file_path": str(ws / "a.ts")},
        },
    )
    assert resp.status_code == 200
    assert resp.json()["ok"] is True
    activity = [e for e in events if e["type"] == "agent.activity"]
    assert len(activity) == 1
    assert activity[0]["payload"]["event_type"] == "agent_active"


# ── watcher handler: event type → change ─────────────────────────────────


class _FakeEvent:
    def __init__(
        self,
        src_path: str,
        event_type: str = "modified",
        dest_path: str = "",
        is_directory: bool = False,
    ) -> None:
        self.src_path = src_path
        self.event_type = event_type
        self.dest_path = dest_path
        self.is_directory = is_directory


def _handler(root: Path) -> tuple[_RepoHandler, list[list[tuple[str, str]]]]:
    seen: list[list[tuple[str, str]]] = []
    handler = _RepoHandler(
        root.resolve(), str(root), lambda _ws, paths: seen.append(paths)
    )
    return handler, seen


@pytest.mark.parametrize("event_type", ["created", "modified", "deleted"])
def test_each_event_type_maps_to_its_own_change(tmp_path: Path, event_type: str) -> None:
    handler, seen = _handler(tmp_path)
    handler.on_any_event(_FakeEvent(str(tmp_path / "src" / "a.ts"), event_type))
    assert seen == [[("src/a.ts", event_type)]]


def test_a_move_splits_into_a_deleted_and_a_created_entry(tmp_path: Path) -> None:
    handler, seen = _handler(tmp_path)
    handler.on_any_event(
        _FakeEvent(
            str(tmp_path / "old.ts"), "moved", dest_path=str(tmp_path / "new.ts")
        )
    )
    assert seen == [[("old.ts", "deleted"), ("new.ts", "created")]]


def test_a_directory_event_still_marks_dirty_but_carries_no_path(
    tmp_path: Path,
) -> None:
    handler, seen = _handler(tmp_path)
    handler.on_any_event(
        _FakeEvent(str(tmp_path / "src"), "modified", is_directory=True)
    )
    assert seen == [[]]  # the git refresh fires exactly as before


# ── app._broadcast_git_changed ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_git_changed_records_the_paths_and_stays_backward_compatible(
    events: list[dict], tmp_path: Path
) -> None:
    ws_path = tmp_path / "repo"
    ws_path.mkdir()
    await app_module._broadcast_git_changed(
        str(ws_path), [("src/a.ts", "modified"), ("src/b.ts", "created")]
    )
    # By type, not by index: the preview record now rides along on the same
    # call and puts its own event on the wire first.
    (payload,) = [e["payload"] for e in events if e["type"] == "git.changed"]
    assert payload["workspace_path"] == str(ws_path)  # unchanged for the 5 readers
    assert payload["paths"] == [
        {"rel_path": "src/a.ts", "change": "modified"},
        {"rel_path": "src/b.ts", "change": "created"},
    ]
    rows = {r["rel_path"]: r for r in _rows(ws_path)}
    assert set(rows) == {"src/a.ts", "src/b.ts"}
    assert rows["src/a.ts"]["source"] == "watcher"
    assert rows["src/a.ts"]["change"] == "modified"
    assert rows["src/b.ts"]["title"] == "b.ts"


@pytest.mark.asyncio
async def test_git_changed_with_no_paths_broadcasts_the_old_shape_plus_empty(
    events: list[dict], tmp_path: Path
) -> None:
    await app_module._broadcast_git_changed(str(tmp_path))
    assert events[0]["payload"] == {"workspace_path": str(tmp_path), "paths": []}


@pytest.mark.asyncio
async def test_git_changed_caps_the_paths_it_carries(
    events: list[dict], tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(app_module, "_GIT_CHANGED_MAX_PATHS", 3, raising=False)
    monkeypatch.setattr(app_module, "_record_watcher_changes", lambda ws, entries: (ws, []))
    await app_module._broadcast_git_changed(
        str(tmp_path), [(f"f{i}.ts", "created") for i in range(10)]
    )
    (payload,) = [e["payload"] for e in events if e["type"] == "git.changed"]
    assert payload["workspace_path"] == str(tmp_path)  # what every reader refreshes on
    assert [p["rel_path"] for p in payload["paths"]] == ["f0.ts", "f1.ts", "f2.ts"]
    assert payload["paths_truncated"] is True


@pytest.mark.asyncio
async def test_an_unknown_event_type_is_dropped_rather_than_guessed_at(
    events: list[dict], tmp_path: Path
) -> None:
    ws_path = tmp_path / "repo"
    ws_path.mkdir()
    await app_module._broadcast_git_changed(str(ws_path), [("a.ts", "opened")])
    assert events[0]["payload"]["paths"] == []
    assert _rows(ws_path) == []


# ── confluence: the two writers land on one row ──────────────────────────


@pytest.mark.asyncio
async def test_hook_first_then_watcher_stays_one_attributed_row(
    client: TestClient, events: list[dict], ws: Path
) -> None:
    target = ws / "a.ts"
    target.write_text("x", encoding="utf-8")
    _post_tool(client, "Edit", str(target))
    await app_module._broadcast_git_changed(str(ws), [("a.ts", "modified")])
    rows = _rows(ws)
    assert len(rows) == 1
    assert rows[0]["source"] == "agent"
    assert rows[0]["pane_id"] == "pane-1"
    assert rows[0]["tool"] == "Edit"


@pytest.mark.asyncio
async def test_watcher_first_then_hook_upgrades_the_same_row(
    client: TestClient, events: list[dict], ws: Path
) -> None:
    target = ws / "a.ts"
    target.write_text("x", encoding="utf-8")
    await app_module._broadcast_git_changed(str(ws), [("a.ts", "modified")])
    _post_tool(client, "Edit", str(target))
    rows = _rows(ws)
    assert len(rows) == 1
    assert rows[0]["source"] == "agent"
    assert rows[0]["agent"] == "claude"
    assert rows[0]["tool"] == "Edit"


# ── one project root per record track ────────────────────────────────────
# Four writers feed the same track and each is handed a different workspace
# string (a pane's, a watcher's, a window's, an MCP caller's). They only land
# on one feed if they all resolve it to the project root first.


class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


def _mcp_pane_ctx(pane_id: str) -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


@pytest.fixture()
def subdir_ws(tmp_path: Path) -> Path:
    """A workspace opened one level inside a git repository."""
    (tmp_path / "repo" / ".git").mkdir(parents=True)
    sub = tmp_path / "repo" / "pkg"
    sub.mkdir()
    return sub


def test_a_subdirectory_workspace_records_against_the_repository(subdir_ws: Path) -> None:
    assert app_module._preview_workspace(str(subdir_ws)) == str(subdir_ws.parent.resolve())


def test_resolving_a_repository_root_leaves_it_alone(subdir_ws: Path) -> None:
    root = app_module._preview_workspace(str(subdir_ws))
    assert app_module._preview_workspace(root) == root


def test_a_workspace_in_no_repository_records_where_it_is(tmp_path: Path) -> None:
    plain = tmp_path / "plain"
    plain.mkdir()
    assert app_module._preview_workspace(str(plain)) == str(plain)


def test_a_workspace_that_cannot_be_resolved_falls_back_instead_of_raising(
    monkeypatch,
) -> None:
    """The hook receiver calls this on its response path — it may not raise."""

    def boom(_path: str) -> str:
        raise OSError("filesystem gone")

    monkeypatch.setattr(app_module, "resolve_plan_root", boom)
    assert app_module._preview_workspace("/some/where") == "/some/where"


@pytest.mark.asyncio
async def test_all_four_writers_land_in_the_same_database(
    client: TestClient, events: list[dict], subdir_ws: Path, monkeypatch
) -> None:
    root = str(subdir_ws.parent.resolve())
    monkeypatch.setattr(
        app_module.attribution,
        "pane_for_session",
        lambda _sid: ("pane-1", str(subdir_ws), "stage-1"),
    )
    # The dev-time store writes to the pane's registered workspace as-is and is
    # not a preview writer; keep it out so the "second pile" check below stays
    # about the four writers under test.
    monkeypatch.setattr(app_module.dev_time_store, "agent_event", lambda *_a: False)

    _post_tool(client, "Write", str(subdir_ws / "hook.ts"))  # 1. the CLI hook
    await app_module._broadcast_git_changed(  # 2. the file watcher
        str(subdir_ws), [("watcher.ts", "created")]
    )
    await app_module.handle_message(  # 3. an action inside the app
        app_module.Session(_FakeWebSocket()),  # type: ignore[arg-type]
        {
            "id": "m1",
            "type": "preview.log_append",
            "payload": {
                "workspace_path": str(subdir_ws),
                "change": "created",
                "rel_path": "app.ts",
            },
        },
    )
    agent_messaging._reset_for_test()
    try:  # 4. the MCP tool
        agent_messaging.register("p1", "p1-pane", str(subdir_ws), agent_key="claude")
        await plan_mcp.preview_record(
            _mcp_pane_ctx("p1"), rel_path="mcp.ts", change="created"
        )
    finally:
        agent_messaging._reset_for_test()

    rows = {r["rel_path"] for r in app_module.preview_log.tail(root)}
    assert rows == {"hook.ts", "watcher.ts", "app.ts", "mcp.ts"}
    # And nobody started a second pile one level down.
    assert not (subdir_ws / ".agent-team").exists()


# ── announcing a recorded row ────────────────────────────────────────────


def test_the_hook_broadcasts_the_row_it_recorded(
    client: TestClient, events: list[dict], ws: Path
) -> None:
    _post_tool(client, "Write", str(ws / "a.ts"))
    (event,) = [e for e in events if e["type"] == "preview.recorded"]
    assert event["payload"]["workspace_path"] == str(ws)
    assert event["payload"]["entry"]["rel_path"] == "a.ts"
    assert event["payload"]["entry"]["source"] == "agent"
    # An event, not a response: the renderer routes on the absence of `ok`.
    assert "ok" not in event


def test_a_hook_write_that_merges_away_broadcasts_nothing(
    client: TestClient, events: list[dict], ws: Path, monkeypatch
) -> None:
    # Two hooks inside the merge window, however long a request takes on this
    # host: which side of the window they fall on is test_preview_log's job.
    monkeypatch.setattr(preview_log_module, "_now_ms", lambda: 1_000_000)
    _post_tool(client, "Write", str(ws / "a.ts"))
    events.clear()
    _post_tool(client, "Write", str(ws / "a.ts"))
    assert [e for e in events if e["type"] == "preview.recorded"] == []
    assert len(_rows(ws)) == 1


def test_the_receiver_still_answers_when_the_record_broadcast_blows_up(
    client: TestClient, ws: Path, monkeypatch
) -> None:
    """Same rule as the write itself: the busy-state response is not negotiable."""

    async def fake_broadcast(event, **_kwargs):
        if event["type"] == "preview.recorded":
            raise RuntimeError("socket on fire")

    monkeypatch.setattr(app_module, "broadcast", fake_broadcast)
    resp = client.post(
        "/hooks/claude",
        headers={"X-Agent-Team-Event": "pre_tool_use"},
        json={
            "session_id": WS_SESSION,
            "cwd": "/tmp/ws",
            "tool_name": "Write",
            "tool_input": {"file_path": str(ws / "a.ts")},
        },
    )
    assert resp.status_code == 200
    assert resp.json()["ok"] is True
    assert len(_rows(ws)) == 1  # the row itself still landed


@pytest.mark.asyncio
async def test_the_watcher_coalesces_a_burst_into_one_event(
    events: list[dict], tmp_path: Path
) -> None:
    ws_path = tmp_path / "repo"
    ws_path.mkdir()
    await app_module._broadcast_git_changed(
        str(ws_path), [("a.ts", "created"), ("b.ts", "created")]
    )
    (event,) = [e for e in events if e["type"] == "preview.recorded"]
    assert event["payload"]["workspace_path"] == str(ws_path)
    # Oldest first: the renderer unshifts each row, so this order puts the
    # newest at the front of its track.
    assert [e["rel_path"] for e in event["payload"]["entries"]] == ["a.ts", "b.ts"]
    assert "ok" not in event


@pytest.mark.asyncio
async def test_a_burst_past_the_store_ceiling_carries_only_what_survived_it(
    events: list[dict], tmp_path: Path
) -> None:
    """A `git checkout` can debounce thousands of paths into one call; rows the
    store has already pruned are not worth a window's time."""
    ws_path = tmp_path / "repo"
    ws_path.mkdir()
    total = app_module.PREVIEW_MAX_ROWS + 20
    await app_module._broadcast_git_changed(
        str(ws_path), [(f"f{i}.ts", "created") for i in range(total)]
    )
    (event,) = [e for e in events if e["type"] == "preview.recorded"]
    entries = event["payload"]["entries"]
    assert len(entries) == app_module.PREVIEW_MAX_ROWS
    kept = {
        r["rel_path"]
        for r in app_module.preview_log.tail(str(ws_path), app_module.PREVIEW_MAX_ROWS)
    }
    assert {e["rel_path"] for e in entries} == kept


def test_a_burst_is_recorded_in_one_commit(tmp_path: Path, monkeypatch) -> None:
    """A commit is a disk flush. One per path made the burst above take 90 s
    and more on a Windows runner — long enough to read as a hang — and a real
    checkout is thousands of paths, all of it under the log's lock."""
    from agent_team_backend import db as db_module

    commits: list[str] = []
    connect = db_module.Database._connect

    def traced(self):
        conn = connect(self)
        conn.set_trace_callback(
            lambda sql: commits.append(sql) if sql.strip().upper() == "COMMIT" else None
        )
        return conn

    monkeypatch.setattr(db_module.Database, "_connect", traced)
    ws_path = tmp_path / "repo"
    ws_path.mkdir()
    # Creating the database and its schema commits on its own; that is not the
    # burst, so it happens first.
    app_module._record_watcher_changes(str(ws_path), [{"rel_path": "a.ts", "change": "created"}])
    commits.clear()

    total = app_module.PREVIEW_MAX_ROWS + 20
    _, rows = app_module._record_watcher_changes(
        str(ws_path), [{"rel_path": f"f{i}.ts", "change": "created"} for i in range(total)]
    )

    assert len(rows) == app_module.PREVIEW_MAX_ROWS
    assert len(commits) == 1


@pytest.mark.asyncio
async def test_a_watcher_burst_that_merges_away_broadcasts_nothing(
    client: TestClient, events: list[dict], ws: Path
) -> None:
    target = ws / "a.ts"
    target.write_text("x", encoding="utf-8")
    _post_tool(client, "Edit", str(target))
    events.clear()
    await app_module._broadcast_git_changed(str(ws), [("a.ts", "modified")])
    assert [e for e in events if e["type"] == "preview.recorded"] == []
