"""workspace_open → cli_open_agent on a workspace with no window yet.

workspace_open used to answer as soon as the window it asked had called
openMainWindow, which only *starts* the new window. An immediate
cli_open_agent(workspace_path=...) then broadcast agent_spawn.request while the
new window was still loading: every live window saw a workspace it does not
hold and stayed silent, the event was never replayed, and the call waited out
the whole spawn deadline. workspace_list did not show the new workspace either,
because the window is opened with duplicate=1 and so never touches Recent.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.mcp_server import auth, server as plan_mcp
from agent_team_backend.recent_workspaces import RecentWorkspacesStore


def _ctx() -> Any:
    params = {"client": "host", "t": auth.internal_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


@pytest.fixture(autouse=True)
def _clean(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Any:
    agent_messaging._reset_for_test()
    plan_mcp._ui_invoke_pending.pending.clear()
    monkeypatch.setattr(app, "recent_workspaces_store", RecentWorkspacesStore(tmp_path / "recent.json"))
    monkeypatch.setattr(plan_mcp, "_WINDOW_PROBE_TIMEOUT_S", 0.02, raising=False)
    monkeypatch.setattr(plan_mcp, "_WINDOW_READY_TIMEOUT_S", 0.3, raising=False)
    monkeypatch.setattr(plan_mcp, "_mcp_opened_workspaces", {}, raising=False)
    yield
    agent_messaging._reset_for_test()
    plan_mcp._ui_invoke_pending.pending.clear()
    plan_mcp._pending_spawns.clear()
    plan_mcp._pending_kickoffs.clear()


class _Windows:
    """The live windows as the backend sees them.

    `owned` is the set of workspaces whose window is up and listening; a probe
    (or spawn request) for any other workspace is met with silence, which is
    what every non-owning window does.
    """

    def __init__(self) -> None:
        self.owned: set[str] = set()
        self.events: list[dict[str, Any]] = []
        self.open_after_probes: dict[str, int] = {}

    async def unicast_any(self, event: dict[str, Any]) -> bool:
        payload = event["payload"]
        self.events.append(event)
        plan_mcp.resolve_ui_invoke(payload["request_id"], {"ok": True, "result": None, "error": None})
        return True

    async def broadcast(self, event: dict[str, Any], **_kwargs: Any) -> None:
        self.events.append(event)
        payload = event["payload"]
        if event["type"] == "ui.invoke.request":
            path = payload["workspace_path"]
            left = self.open_after_probes.get(path)
            if left is not None:
                if left <= 1:
                    self.owned.add(path)
                    del self.open_after_probes[path]
                else:
                    self.open_after_probes[path] = left - 1
            if path in self.owned:
                plan_mcp.resolve_ui_invoke(
                    payload["request_id"], {"ok": True, "result": ["ui.workspace.open"], "error": None}
                )
        elif event["type"] == "agent_spawn.request":
            if payload.get("target_workspace") in self.owned:
                plan_mcp.resolve_spawn(payload["request_id"], {"ok": True, "pane_id": "p-new", "name": "worker"})
                plan_mcp.resolve_kickoff(payload["request_id"], {"kickoff": "sent"})

    def spawn_requests(self) -> list[dict[str, Any]]:
        return [e for e in self.events if e["type"] == "agent_spawn.request"]


@pytest.fixture
def windows(monkeypatch: pytest.MonkeyPatch) -> _Windows:
    w = _Windows()
    monkeypatch.setattr(app, "unicast_any", w.unicast_any)
    monkeypatch.setattr(app, "broadcast", w.broadcast)
    return w


# ── (a) workspace_open waits for the new window ─────────────────────────────


@pytest.mark.asyncio
async def test_workspace_open_waits_until_the_new_window_answers(windows: _Windows) -> None:
    windows.open_after_probes["/ws/fresh"] = 3

    result = await plan_mcp.workspace_open("/ws/fresh", _ctx())

    assert result["ok"] is True
    assert result["path"] == "/ws/fresh"
    assert result["ready"] is True
    assert "/ws/fresh" in windows.owned


@pytest.mark.asyncio
async def test_workspace_open_says_not_ready_when_the_window_never_comes_up(windows: _Windows) -> None:
    started = time.monotonic()
    result = await plan_mcp.workspace_open("/ws/never", _ctx())

    assert time.monotonic() - started < 2.0
    assert result["ok"] is True
    assert result["path"] == "/ws/never"
    assert result["ready"] is False
    assert "workspace_list" in result["hint"]


# ── (c) workspace_list lists it right away ──────────────────────────────────


@pytest.mark.asyncio
async def test_workspace_list_lists_the_workspace_right_after_workspace_open(
    windows: _Windows, tmp_path: Path
) -> None:
    project = tmp_path / "James-AI 工廠導入專案"
    project.mkdir()
    windows.owned.add(str(project))

    await plan_mcp.workspace_open(str(project), _ctx())
    listed = await plan_mcp.workspace_list(_ctx())

    rows = {row["path"]: row for row in listed["workspaces"]}
    assert str(project) in rows
    assert rows[str(project)]["window_ready"] is True
    assert rows[str(project)]["opened_by_mcp"] is True
    assert rows[str(project)]["exists"] is True


@pytest.mark.asyncio
async def test_workspace_open_leaves_the_users_recent_list_alone(windows: _Windows, tmp_path: Path) -> None:
    """The window opens with duplicate=1, which keeps it out of Recent on
    purpose; an MCP call must not reorder the user's list either."""
    older = tmp_path / "older"
    older.mkdir()
    app.recent_workspaces_store.touch(str(older))
    windows.owned.add("/ws/fresh")

    await plan_mcp.workspace_open("/ws/fresh", _ctx())

    assert [e["path"] for e in app.recent_workspaces_store.list()] == [str(older)]


@pytest.mark.asyncio
async def test_a_workspace_open_listed_even_before_its_window_is_ready(windows: _Windows) -> None:
    opened = await plan_mcp.workspace_open("/ws/slow", _ctx())
    listed = await plan_mcp.workspace_list(_ctx())

    assert opened["ready"] is False
    rows = {row["path"]: row for row in listed["workspaces"]}
    assert rows["/ws/slow"]["window_ready"] is False
    assert rows["/ws/slow"]["exists"] is False


@pytest.mark.asyncio
async def test_workspace_list_reports_a_workspace_without_a_window_as_not_ready(
    windows: _Windows, tmp_path: Path
) -> None:
    up, down = tmp_path / "up", tmp_path / "down"
    up.mkdir()
    down.mkdir()
    app.recent_workspaces_store.touch(str(down))
    app.recent_workspaces_store.touch(str(up))
    windows.owned.add(str(up))

    listed = await plan_mcp.workspace_list(_ctx())

    rows = {row["path"]: row for row in listed["workspaces"]}
    assert rows[str(up)]["window_ready"] is True
    assert rows[str(down)]["window_ready"] is False
    assert listed["window_ready_workspaces"] == [str(up)]


# ── (b) cli_open_agent never hangs on a window that is not there ───────────


async def _open(workspace: str) -> dict[str, Any]:
    return await plan_mcp.cli_open_agent(
        "claude", "worker", "do the thing", _ctx(), workspace_path=workspace
    )


@pytest.mark.asyncio
async def test_cli_open_agent_refuses_quickly_when_no_window_holds_the_workspace(
    windows: _Windows, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The old failure: a broadcast nobody answers, waited out for the full
    # spawn deadline. Keep that deadline long so a regression shows as a hang.
    monkeypatch.setattr(plan_mcp, "_SPAWN_VERDICT_TIMEOUT_S", 30.0)

    started = time.monotonic()
    result = await asyncio.wait_for(_open("/ws/nowhere"), timeout=5.0)

    assert time.monotonic() - started < 2.0
    assert result["ok"] is False
    assert result["error_code"] == "window_not_ready"
    assert "/ws/nowhere" in result["error"]
    assert windows.spawn_requests() == []
    assert plan_mcp._pending_spawns == {}
    assert plan_mcp._pending_kickoffs == {}


@pytest.mark.asyncio
async def test_cli_open_agent_waits_for_a_window_that_is_still_loading(windows: _Windows) -> None:
    windows.open_after_probes["/ws/loading"] = 4

    result = await asyncio.wait_for(_open("/ws/loading"), timeout=5.0)

    assert result["ok"] is True
    assert result["pane_id"] == "p-new"
    assert len(windows.spawn_requests()) == 1


@pytest.mark.asyncio
async def test_workspace_open_then_cli_open_agent_opens_the_pane(windows: _Windows) -> None:
    windows.open_after_probes["/ws/fresh"] = 2

    opened = await plan_mcp.workspace_open("/ws/fresh", _ctx())
    result = await asyncio.wait_for(_open("/ws/fresh"), timeout=5.0)

    assert opened["ready"] is True
    assert result["ok"] is True
    assert result["kickoff"] == "sent"


# ── a "~/..." path is expanded once, before anything sees it ────────────────


@pytest.mark.asyncio
async def test_workspace_open_expands_a_tilde_path_for_the_window_probe_and_list(
    windows: _Windows, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # expanduser reads HOME on POSIX and USERPROFILE on Windows.
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    project = tmp_path / "Desktop" / "James-AI 工廠導入專案"
    project.mkdir(parents=True)
    absolute = str(project)
    windows.owned.add(absolute)

    opened = await plan_mcp.workspace_open("~/Desktop/James-AI 工廠導入專案", _ctx())
    listed = await plan_mcp.workspace_list(_ctx())
    spawned = await asyncio.wait_for(_open(absolute), timeout=5.0)

    open_request = next(e for e in windows.events if e["payload"].get("action") == "ui.workspace.open")
    assert open_request["payload"]["args"] == {"path": absolute}
    probes = [e["payload"]["workspace_path"] for e in windows.events if e["payload"].get("op") == "list_actions"]
    assert probes and all(p == absolute for p in probes)
    assert opened["ready"] is True
    assert opened["path"] == absolute
    rows = {row["path"]: row for row in listed["workspaces"]}
    assert rows[absolute]["window_ready"] is True
    assert not any(p.startswith("~") for p in rows)
    assert spawned["ok"] is True


@pytest.mark.asyncio
async def test_a_tilde_path_is_normalised_to_the_platforms_separators(
    windows: _Windows, monkeypatch: pytest.MonkeyPatch
) -> None:
    """On Windows expanduser joins "C:\\Users\\me" with "/Desktop/..." and leaves
    the separators mixed, while Recent stores the abspath (all backslashes)
    form; the window compares paths as plain strings, so both must agree.
    Run here under ntpath's rules so the case is covered on every runner."""
    import ntpath

    monkeypatch.setattr(plan_mcp, "os", SimpleNamespace(path=ntpath))
    monkeypatch.setenv("USERPROFILE", "C:\\Users\\me")
    expected = "C:\\Users\\me\\Desktop\\proj"
    windows.owned.add(expected)

    opened = await plan_mcp.workspace_open("~/Desktop/proj", _ctx())

    open_request = next(e for e in windows.events if e["payload"].get("action") == "ui.workspace.open")
    assert open_request["payload"]["args"] == {"path": expected}
    assert opened["path"] == expected
    assert opened["ready"] is True
