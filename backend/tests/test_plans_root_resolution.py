"""plans.* handlers resolve to the project root plans are actually written to.

Every writer (the MCP plan tools, plan_provisioning) resolves a workspace up to
its repository root before writing, so a workspace opened on a subdirectory must
look up too — otherwise a plan an agent just created is invisible in the very
window that asked for it ("Failed to load the plan document").
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app, ws_handlers


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


async def _call(msg_type: str, payload: dict[str, Any]) -> Any:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    fn = ws_handlers.lookup(msg_type)
    assert fn is not None
    await fn(session, "m1", msg_type, payload)
    return session.websocket.sent[0]["payload"]  # type: ignore[attr-defined]


@pytest.fixture
def repo_with_subdir(tmp_path: Path) -> tuple[Path, Path]:
    """A git repo whose plans live at its root, opened on a subdirectory."""
    (tmp_path / ".git").mkdir()
    plans = tmp_path / ".agent-team" / "plans"
    plans.mkdir(parents=True)
    (plans / "alpha.html").write_text("<h1>Alpha</h1>", encoding="utf-8")
    subdir = tmp_path / "packages" / "app"
    subdir.mkdir(parents=True)
    return tmp_path, subdir


async def test_list_docs_finds_the_repo_roots_plans_from_a_subdirectory(
    repo_with_subdir: tuple[Path, Path],
) -> None:
    root, subdir = repo_with_subdir

    payload = await _call("plans.list_docs", {"workspace_path": str(subdir)})

    assert payload["ok"] is True
    assert [d["rel_path"] for d in payload["docs"]] == [".agent-team/plans/alpha.html"]
    # The root goes back with the list: rel_path is relative to it, and
    # fs.read_file refuses to escape whatever workspace it is handed.
    assert payload["root"] == str(root)


async def test_list_docs_leaves_a_repo_root_workspace_alone(
    repo_with_subdir: tuple[Path, Path],
) -> None:
    """The normal case must be untouched by the resolution."""
    root, _ = repo_with_subdir

    payload = await _call("plans.list_docs", {"workspace_path": str(root)})

    assert payload["ok"] is True
    assert payload["root"] == str(root)
    assert [d["rel_path"] for d in payload["docs"]] == [".agent-team/plans/alpha.html"]


async def test_resolve_root_answers_for_a_window_opened_at_a_rel_path(
    repo_with_subdir: tuple[Path, Path],
) -> None:
    root, subdir = repo_with_subdir

    payload = await _call("plans.resolve_root", {"workspace_path": str(subdir)})

    assert payload == {"ok": True, "root": str(root)}


async def test_cache_put_and_list_share_one_root(
    repo_with_subdir: tuple[Path, Path],
) -> None:
    """Cache keys are stored per workspace, so a put from a subdirectory must
    land where the list looks it up or the cache never hits."""
    root, subdir = repo_with_subdir
    mtime = (root / ".agent-team" / "plans" / "alpha.html").stat().st_mtime

    put = await _call(
        "plans.cache_put",
        {
            "workspace_path": str(subdir),
            "entries": [
                {
                    "rel_path": ".agent-team/plans/alpha.html",
                    "mtime": mtime,
                    "meta": {"stage": "draft", "name": "Alpha"},
                }
            ],
        },
    )
    assert put["ok"] is True

    listed = await _call("plans.list_docs", {"workspace_path": str(root)})
    assert [d["cached"] for d in listed["docs"]] == [True]


async def test_an_agents_plan_is_visible_from_the_subdirectory_workspace(
    repo_with_subdir: tuple[Path, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End to end over the bug this exists for: an agent in a pane opened on a
    subdirectory creates a plan (which every writer puts in the repo root), and
    the plan surface — asking with that same subdirectory — has to list it and
    be able to read it back. Failing this is exactly what the user sees as
    "Failed to load the plan document"."""
    from types import SimpleNamespace

    from agent_team_backend import agent_messaging, fs_service
    from agent_team_backend.mcp_server import server as plan_mcp
    from agent_team_backend.mcp_server import wiring as plan_mcp_wiring
    from agent_team_backend.plugins.builtin.navide_plans import plan_tools

    root, subdir = repo_with_subdir
    async def route(*args: object, **kwargs: object) -> dict[str, object]:
        return {
            "ok": False,
            "error": {"code": "BACKEND_UNAVAILABLE", "message": "test pre-dispatch failure"},
            "recoveryDisposition": "legacy-safe-before-dispatch",
        }

    monkeypatch.setattr(plan_mcp, "request_host_agent_workspace_backend", route)
    agent_messaging._reset_for_test()
    try:
        agent_messaging.register("pa", "builder", str(subdir), agent_key="claude")
        params = {"pane": "pa", "t": plan_mcp_wiring.caller_token("pa")}
        ctx = SimpleNamespace(
            request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
        )
        created = await plan_tools.plan_create(
            name="Vendor Review", overview="", todos=["Task"], ctx=ctx
        )
    finally:
        agent_messaging._reset_for_test()

    listed = await _call("plans.list_docs", {"workspace_path": str(subdir)})

    assert created["rel_path"] in [d["rel_path"] for d in listed["docs"]]
    # And it is readable against the root that came back with the list — the
    # exact call the plan window's preview makes.
    read = fs_service.read_file(listed["root"], created["rel_path"])
    assert read["ok"] is True
    assert "Vendor Review" in read["content"]
    assert (root / created["rel_path"]).is_file()


async def test_a_workspace_outside_any_repo_is_its_own_root(tmp_path: Path) -> None:
    """No repository within reach means no walk — the workspace stands alone."""
    plans = tmp_path / ".agent-team" / "plans"
    plans.mkdir(parents=True)
    (plans / "solo.html").write_text("<h1>Solo</h1>", encoding="utf-8")

    payload = await _call("plans.list_docs", {"workspace_path": str(tmp_path)})

    assert payload["root"] == str(tmp_path)
    assert [d["rel_path"] for d in payload["docs"]] == [".agent-team/plans/solo.html"]
