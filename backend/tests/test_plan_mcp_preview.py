"""preview_record / preview_list / preview_show: the MCP face of the
per-workspace preview record.

What these pin is the part a session cannot see for itself: attribution comes
from the credential (not from an argument), a caller with no pane identity is
refused rather than silently writing to some other workspace, and a preview
push is only recorded as shown once the renderer window confirms it took it.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend import app as backend_app
from agent_team_backend import preview_log as preview_log_module
from agent_team_backend.fs_service import FsError
from agent_team_backend.plan_index import resolve_plan_root
from agent_team_backend.mcp_server import server as plan_mcp, auth as plan_mcp_auth, wiring as plan_mcp_wiring
from agent_team_backend.preview_log import PreviewLog


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


@pytest.fixture
def store(monkeypatch: pytest.MonkeyPatch) -> PreviewLog:
    """A PreviewLog of this test's own — the app-level one would otherwise
    write into whatever workspace database the process last touched."""
    log = PreviewLog()
    monkeypatch.setattr(backend_app, "preview_log", log)
    return log


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Any:
    """A hand-cranked millisecond clock so merge windows are deterministic."""
    state = {"now": 1_000_000}
    monkeypatch.setattr(preview_log_module, "_now_ms", lambda: state["now"])

    class Clock:
        def advance(self, ms: int) -> None:
            state["now"] += ms

    return Clock()


@pytest.fixture
def workspace(tmp_path: Path) -> str:
    """The workspace as the tools resolve it (resolve_plan_root normalises the
    symlinked temp root, and rows land under the resolved path)."""
    return resolve_plan_root(str(tmp_path))


def _host_ctx() -> Any:
    params = {"client": "host", "t": plan_mcp_auth.internal_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _pane_ctx(pane_id: str) -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _pane(pane_id: str, workspace: str, agent_key: str = "claude") -> Any:
    return agent_messaging.register(pane_id, f"{pane_id}-pane", workspace, agent_key=agent_key)


class _FakeTerminalService:
    """Stand-in for TerminalService: just the `_sessions` dict the
    workspace-mismatch check snapshots."""

    def __init__(self, cwds: list[str]) -> None:
        self._sessions = {
            cwd: SimpleNamespace(id=cwd, cwd=cwd, metadata={}, closed=False) for cwd in cwds
        }


@pytest.fixture
def broadcasts(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(backend_app, "broadcast", fake_broadcast)
    return events


async def _answer(reply: dict[str, Any]) -> None:
    """Stand in for the renderer window replying with a ui.invoke.result."""
    for _ in range(200):
        keys = list(plan_mcp._ui_invoke_pending.pending)
        if keys:
            plan_mcp.resolve_ui_invoke(keys[0], reply)
            return
        await asyncio.sleep(0.005)
    raise AssertionError("no pending ui.invoke request appeared")


# ── preview_record ──────────────────────────────────────────────────────────


async def test_preview_record_lands_an_attributed_row(
    store: PreviewLog, workspace: str
) -> None:
    _pane("p1", workspace, agent_key="codex")

    result = await plan_mcp.preview_record(
        _pane_ctx("p1"), rel_path="src/a.ts", change="created", note="added the guard"
    )

    assert result["change"] == "created"
    assert result["rel_path"] == "src/a.ts"
    assert result["merged"] is False
    assert result["uid"]
    assert result["created_at"] > 0
    # No live pane workspaces are known here, so no advisory warning fires.
    assert "warning" not in result

    (row,) = store.tail(workspace)
    assert row["uid"] == result["uid"]
    assert row["source"] == "agent"
    assert row["pane_id"] == "p1"
    assert row["agent"] == "codex"
    assert row["note"] == "added the guard"


async def test_preview_record_defaults_to_the_callers_own_workspace(
    store: PreviewLog, workspace: str, tmp_path: Path
) -> None:
    """A pane never has to say where it is — and must not be able to get it
    wrong, since the panel reads the pane's own workspace."""
    other = tmp_path / "elsewhere"
    other.mkdir()
    _pane("p1", workspace)

    await plan_mcp.preview_record(_pane_ctx("p1"), rel_path="src/a.ts")

    assert [r["rel_path"] for r in store.tail(workspace)] == ["src/a.ts"]
    assert store.tail(str(other)) == []


async def test_preview_record_rejects_an_unknown_change(
    store: PreviewLog, workspace: str
) -> None:
    _pane("p1", workspace)

    with pytest.raises(FsError) as err:
        await plan_mcp.preview_record(_pane_ctx("p1"), rel_path="src/a.ts", change="renamed")

    assert "renamed" in str(err.value)
    assert store.tail(workspace) == []


async def test_preview_record_refuses_shown(store: PreviewLog, workspace: str) -> None:
    """"shown" is preview_show's to write, and only after a window took the
    push — a hand-written one would claim the user saw something."""
    _pane("p1", workspace)

    with pytest.raises(FsError):
        await plan_mcp.preview_record(_pane_ctx("p1"), rel_path="src/a.ts", change="shown")

    assert store.tail(workspace) == []


async def test_preview_record_needs_a_path_or_content(
    store: PreviewLog, workspace: str
) -> None:
    _pane("p1", workspace)

    with pytest.raises(FsError):
        await plan_mcp.preview_record(_pane_ctx("p1"), change="modified")
    with pytest.raises(FsError):
        await plan_mcp.preview_record(_pane_ctx("p1"), kind="snippet", change="created")

    assert store.tail(workspace) == []


async def test_preview_record_without_a_workspace_from_a_host_caller_errors(
    store: PreviewLog, workspace: str
) -> None:
    """A host/external caller has no pane workspace to fall back on, so it is
    told rather than left writing into the wrong project."""
    with pytest.raises(FsError) as err:
        await plan_mcp.preview_record(_host_ctx(), rel_path="src/a.ts")

    assert "workspace_path is required" in str(err.value)
    assert store.tail(workspace) == []


async def test_preview_record_folds_a_repeat_into_the_row_already_there(
    store: PreviewLog, workspace: str, clock: Any
) -> None:
    _pane("p1", workspace)

    first = await plan_mcp.preview_record(_pane_ctx("p1"), rel_path="src/a.ts")
    second = await plan_mcp.preview_record(_pane_ctx("p1"), rel_path="src/a.ts")

    assert first["merged"] is False
    assert second["merged"] is True
    assert second["uid"] == ""
    assert second["created_at"] == 0
    assert len(store.tail(workspace)) == 1


async def test_preview_record_tells_every_window_about_the_new_row(
    store: PreviewLog, workspace: str, broadcasts: list[dict[str, Any]]
) -> None:
    _pane("p1", workspace, agent_key="claude")

    result = await plan_mcp.preview_record(
        _pane_ctx("p1"), rel_path="src/a.ts", change="created"
    )

    (event,) = [e for e in broadcasts if e["type"] == "preview.recorded"]
    # The resolved workspace, which is what the panel's own track is keyed on.
    assert event["payload"]["workspace_path"] == workspace
    assert event["payload"]["entry"]["uid"] == result["uid"]
    assert event["payload"]["entry"]["source"] == "agent"
    # An event, not a response: the renderer routes on the absence of `ok`.
    assert "ok" not in event


async def test_a_record_that_merges_away_is_not_broadcast(
    store: PreviewLog, workspace: str, clock: Any, broadcasts: list[dict[str, Any]]
) -> None:
    _pane("p1", workspace)
    await plan_mcp.preview_record(_pane_ctx("p1"), rel_path="src/a.ts")
    broadcasts.clear()

    second = await plan_mcp.preview_record(_pane_ctx("p1"), rel_path="src/a.ts")

    assert second["merged"] is True
    assert [e for e in broadcasts if e["type"] == "preview.recorded"] == []


async def test_preview_record_warns_when_no_pane_uses_the_workspace(
    store: PreviewLog, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        backend_app, "get_terminals", lambda: _FakeTerminalService(["/ws/a", "/ws/b"])
    )

    result = await plan_mcp.preview_record(
        _host_ctx(), rel_path="src/a.ts", workspace_path=workspace
    )

    assert result["merged"] is False
    assert workspace in result["warning"]
    assert "/ws/a" in result["warning"]


# ── preview_list ────────────────────────────────────────────────────────────


async def test_preview_list_returns_newest_first(
    store: PreviewLog, workspace: str, clock: Any
) -> None:
    _pane("p1", workspace)
    await plan_mcp.preview_record(_pane_ctx("p1"), rel_path="src/a.ts")
    clock.advance(5_000)
    await plan_mcp.preview_record(_pane_ctx("p1"), rel_path="src/b.ts")

    result = await plan_mcp.preview_list(_pane_ctx("p1"))

    assert result["workspace_path"] == workspace
    assert [e["rel_path"] for e in result["entries"]] == ["src/b.ts", "src/a.ts"]
    assert result["truncated"] is False


async def test_preview_list_filters_and_pages(
    store: PreviewLog, workspace: str, clock: Any
) -> None:
    _pane("p1", workspace, agent_key="claude")
    _pane("p2", workspace, agent_key="codex")
    first = await plan_mcp.preview_record(
        _pane_ctx("p1"), rel_path="src/a.ts", change="created"
    )
    clock.advance(5_000)
    await plan_mcp.preview_record(_pane_ctx("p2"), rel_path="src/b.ts", change="deleted")

    since = await plan_mcp.preview_list(_pane_ctx("p1"), since=first["created_at"])
    assert [e["rel_path"] for e in since["entries"]] == ["src/b.ts"]

    by_change = await plan_mcp.preview_list(_pane_ctx("p1"), change="created")
    assert [e["rel_path"] for e in by_change["entries"]] == ["src/a.ts"]

    by_agent = await plan_mcp.preview_list(_pane_ctx("p1"), agent="codex")
    assert [e["rel_path"] for e in by_agent["entries"]] == ["src/b.ts"]

    # since=0 is "no filter", not "after epoch 0" — the default must not page.
    assert len((await plan_mcp.preview_list(_pane_ctx("p1"), since=0))["entries"]) == 2


async def test_preview_list_reports_a_cut_off_answer(
    store: PreviewLog, workspace: str, clock: Any
) -> None:
    _pane("p1", workspace)
    for name in ("a", "b", "c"):
        await plan_mcp.preview_record(_pane_ctx("p1"), rel_path=f"src/{name}.ts")
        clock.advance(5_000)

    result = await plan_mcp.preview_list(_pane_ctx("p1"), limit=2)

    assert [e["rel_path"] for e in result["entries"]] == ["src/c.ts", "src/b.ts"]
    assert result["truncated"] is True


async def test_preview_list_rejects_an_unknown_change(
    store: PreviewLog, workspace: str
) -> None:
    _pane("p1", workspace)

    with pytest.raises(FsError):
        await plan_mcp.preview_list(_pane_ctx("p1"), change="renamed")


async def test_preview_list_without_a_workspace_from_a_host_caller_errors(
    store: PreviewLog,
) -> None:
    with pytest.raises(FsError) as err:
        await plan_mcp.preview_list(_host_ctx())

    assert "workspace_path is required" in str(err.value)


# ── preview_show ────────────────────────────────────────────────────────────


async def test_preview_show_pushes_a_file_and_records_it(
    store: PreviewLog, workspace: str, broadcasts: list[dict[str, Any]]
) -> None:
    _pane("p1", workspace, agent_key="claude")
    task = asyncio.create_task(_answer({"ok": True, "result": {"shown": True}, "error": None}))

    result = await plan_mcp.preview_show(_pane_ctx("p1"), rel_path="src/a.ts")
    await task

    # The push, then the record that the push landed — pick the push by type.
    (payload,) = [e["payload"] for e in broadcasts if e["type"] == "ui.invoke.request"]
    assert payload["action"] == "ui.preview.show"
    assert payload["args"] == {
        "kind": "file",
        "source": "agent",
        "origin": "p1-pane",
        "workspacePath": workspace,
        "relPath": "src/a.ts",
    }

    assert result["ok"] is True
    assert result["recorded"] is True
    assert result["merged"] is False
    (row,) = store.tail(workspace)
    assert row["uid"] == result["uid"]
    assert row["change"] == "shown"
    assert row["source"] == "agent"
    assert row["pane_id"] == "p1"


async def test_preview_show_sends_inline_content_as_the_payload(
    store: PreviewLog, workspace: str, broadcasts: list[dict[str, Any]]
) -> None:
    _pane("p1", workspace)
    task = asyncio.create_task(_answer({"ok": True, "result": None, "error": None}))

    result = await plan_mcp.preview_show(
        _pane_ctx("p1"), kind="markdown", content="# Report", title="Run"
    )
    await task

    args = broadcasts[0]["payload"]["args"]
    assert args["kind"] == "markdown"
    assert args["content"] == "# Report"
    assert args["title"] == "Run"
    assert "relPath" not in args

    assert result["recorded"] is True
    (row,) = store.tail(workspace)
    assert row["kind"] == "markdown"
    assert row["rel_path"] is None
    assert row["payload"] == "# Report"
    assert row["title"] == "Run"


async def test_preview_show_records_nothing_when_the_window_refuses(
    store: PreviewLog, workspace: str, broadcasts: list[dict[str, Any]]
) -> None:
    """A push nobody took must not be logged as shown."""
    _pane("p1", workspace)
    task = asyncio.create_task(
        _answer({"ok": False, "result": None, "error": "invalid preview target"})
    )

    result = await plan_mcp.preview_show(_pane_ctx("p1"), rel_path="src/a.ts")
    await task

    assert result["ok"] is False
    assert result["recorded"] is False
    assert "uid" not in result
    assert store.tail(workspace) == []


async def test_preview_show_records_nothing_when_no_window_answers(
    store: PreviewLog, workspace: str, broadcasts: list[dict[str, Any]], monkeypatch
) -> None:
    monkeypatch.setattr(plan_mcp, "_UI_INVOKE_TIMEOUT_S", 0.05)
    _pane("p1", workspace)

    result = await plan_mcp.preview_show(_pane_ctx("p1"), rel_path="src/a.ts")

    assert result["ok"] is False
    assert result["recorded"] is False
    assert store.tail(workspace) == []


async def test_preview_show_rejects_a_bad_kind_before_broadcasting(
    store: PreviewLog, workspace: str, broadcasts: list[dict[str, Any]]
) -> None:
    _pane("p1", workspace)

    with pytest.raises(FsError):
        await plan_mcp.preview_show(_pane_ctx("p1"), kind="pdf", rel_path="src/a.ts")
    with pytest.raises(FsError):
        await plan_mcp.preview_show(_pane_ctx("p1"), kind="snippet")

    assert broadcasts == []
    assert store.tail(workspace) == []


async def test_preview_show_without_a_workspace_from_a_host_caller_errors(
    store: PreviewLog, broadcasts: list[dict[str, Any]]
) -> None:
    with pytest.raises(FsError) as err:
        await plan_mcp.preview_show(_host_ctx(), rel_path="src/a.ts")

    assert "workspace_path is required" in str(err.value)
    assert broadcasts == []


async def test_preview_show_tells_every_window_about_the_shown_row(
    store: PreviewLog, workspace: str, broadcasts: list[dict[str, Any]]
) -> None:
    _pane("p1", workspace)
    task = asyncio.create_task(_answer({"ok": True, "result": None, "error": None}))

    result = await plan_mcp.preview_show(_pane_ctx("p1"), rel_path="src/a.ts")
    await task

    (event,) = [e for e in broadcasts if e["type"] == "preview.recorded"]
    assert event["payload"]["workspace_path"] == workspace
    assert event["payload"]["entry"]["uid"] == result["uid"]
    assert event["payload"]["entry"]["change"] == "shown"
    assert "ok" not in event


async def test_a_push_no_window_took_is_not_broadcast(
    store: PreviewLog, workspace: str, broadcasts: list[dict[str, Any]]
) -> None:
    _pane("p1", workspace)
    task = asyncio.create_task(
        _answer({"ok": False, "result": None, "error": "no window"})
    )

    result = await plan_mcp.preview_show(_pane_ctx("p1"), rel_path="src/a.ts")
    await task

    assert result["recorded"] is False
    assert [e for e in broadcasts if e["type"] == "preview.recorded"] == []


async def test_preview_show_goes_straight_to_the_calling_panes_own_window(
    store: PreviewLog,
    workspace: str,
    broadcasts: list[dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Left on the broadcast path, a preview push from a pane whose window had
    switched project reached nobody: only a window with that project open
    answers a broadcast, so every call burned the full deadline."""
    sends: list[tuple[Any, dict[str, Any]]] = []

    async def fake_unicast_to(session: Any, event: dict[str, Any]) -> bool:
        sends.append((session, event))
        return True

    monkeypatch.setattr(backend_app, "unicast_to", fake_unicast_to)
    window = SimpleNamespace(dead=False)
    agent_messaging.register("p1", "p1-pane", workspace, agent_key="claude", owner=window)

    task = asyncio.create_task(_answer({"ok": True, "result": {"shown": True}, "error": None}))
    result = await plan_mcp.preview_show(_pane_ctx("p1"), rel_path="src/a.ts")
    await task

    assert result["ok"] is True
    assert [e for e in broadcasts if e["type"] == "ui.invoke.request"] == []
    assert len(sends) == 1
    session, event = sends[0]
    assert session is window
    assert event["payload"]["action"] == "ui.preview.show"
    assert event["payload"]["addressed"] is True
