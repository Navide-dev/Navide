from __future__ import annotations

import json
import os
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from mcp.shared.memory import create_connected_server_and_client_session

from agent_team_backend import agent_messaging
from agent_team_backend import app as backend_app
from agent_team_backend.app import app
from agent_team_backend.plan_index import resolve_plan_root
from agent_team_backend.plugins.builtin.navide_plans.plan_meta import parse_plan_meta
from agent_team_backend.plugins import wiring as plugin_wiring
from agent_team_backend.mcp_server import server as plan_mcp, auth as plan_mcp_auth, wiring as plan_mcp_wiring
from agent_team_backend.plugins.builtin.navide_plans import plan_tools
from agent_team_backend.plugins.host import PluginHost


def _plan_html(meta: dict) -> str:
    payload = json.dumps(meta, indent=2)
    stage = meta.get("stage", "draft")
    todo_lis = "\n".join(
        f'<li data-status="{t["status"]}" data-todo-id="{t["id"]}">'
        f'<span class="st">{t["status"]}</span><span>{t.get("content", "")}</span></li>'
        for t in meta.get("todos", [])
    )
    return (
        f'<h1>Plan<span class="pill {stage}">{stage}</span></h1>\n'
        f'<script type="application/json" id="plan-meta">\n{payload}\n</script>\n'
        f'<ul class="todos">\n{todo_lis}\n</ul>\n'
        "<section>body</section>\n"
    )


def _ctx() -> SimpleNamespace:
    """A Context carrying a valid host credential — plan_* tools only need *a*
    valid /plan-mcp credential, not a specific pane identity."""
    params = {"client": "host", "t": plan_mcp_auth.internal_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


class _ToolResult:
    """Mimics the bits of mcp.types.CallToolResult these tests read, for a
    direct call to the tool function. The in-memory transport used by
    create_connected_server_and_client_session carries no real HTTP request,
    so it cannot carry the credential every tool now requires — calling the
    (undecorated-return) tool function directly, the same way the cli_send
    tests already do, sidesteps that."""

    def __init__(self, value: Any = None, error: Exception | None = None) -> None:
        self.isError = error is not None
        self._value = value
        self._error = error

    @property
    def structuredContent(self) -> Any:
        return {"result": self._value} if isinstance(self._value, list) else self._value

    @property
    def content(self) -> list[Any]:
        return [SimpleNamespace(text=str(self._error))]


def _tool(name: str):
    """Resolve a tool by name across the core/plugin split.

    The plan tools live in the navide.plans plugin and are installed onto the
    core server at startup; everything else is core. Tests address them the
    same way an agent does — by name — so the lookup spans both.
    """
    return getattr(plan_tools, name, None) or getattr(plan_mcp, name)


async def _call(tool: str, args: dict) -> _ToolResult:
    try:
        value = await _tool(tool)(**args, ctx=_ctx())
    except Exception as err:  # noqa: BLE001 — mirrors the MCP session's isError wrapping
        return _ToolResult(error=err)
    return _ToolResult(value=value)


@pytest.fixture(autouse=True)
def _host_approves_legacy_test_recovery(monkeypatch: pytest.MonkeyPatch) -> None:
    """Legacy behavior tests must model the Host's explicit pre-dispatch verdict."""
    async def route(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {
            "ok": False,
            "error": {"code": "BACKEND_UNAVAILABLE", "message": "test pre-dispatch failure"},
            "recoveryDisposition": "legacy-safe-before-dispatch",
        }

    monkeypatch.setattr(plan_mcp, "request_host_agent_workspace_backend", route)


def _plans_dir(workspace: Path) -> Path:
    return workspace / ".agent-team" / "plans"


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    plans = tmp_path / ".agent-team" / "plans"
    plans.mkdir(parents=True)
    (plans / "alpha.html").write_text(
        _plan_html(
            {
                "name": "Alpha",
                "stage": "approved",
                "overview": "First plan",
                "todos": [
                    {"id": "t1", "status": "done"},
                    {"id": "t2", "status": "pending"},
                ],
            }
        ),
        encoding="utf-8",
    )
    (plans / "beta.html").write_text(
        _plan_html({"name": "Beta", "stage": "draft", "overview": "Second plan"}),
        encoding="utf-8",
    )
    # Provisioned assets are skipped by plan_list; a meta-less file is a
    # document the user owns and is listed with a reason, never hidden.
    (plans / "_template.html").write_text("<h1>template</h1>", encoding="utf-8")
    (plans / "no-meta.html").write_text("<h1>not a plan</h1>", encoding="utf-8")
    # Target for the traversal test: exists, but outside the plans subtree.
    (tmp_path / ".agent-team" / "secret.html").write_text("secret", encoding="utf-8")
    return tmp_path


# The in-memory client-server session is opened inside each test body (not an
# async fixture): pytest-asyncio finalizes async gen fixtures in a different
# task, which breaks the anyio cancel scopes inside the SDK helper.


async def test_plan_list_returns_plans_with_meta(workspace: Path) -> None:
    result = await _call("plan_list", {"workspace_path": str(workspace)})
    assert not result.isError
    plans = result.structuredContent["result"]
    # Workspace-relative paths: agents echo these into the terminal, where
    # cmd+click only recognizes the full .agent-team/plans/… form.
    assert [p["rel_path"] for p in plans] == [
        ".agent-team/plans/alpha.html",
        ".agent-team/plans/beta.html",
        ".agent-team/plans/no-meta.html",
    ]
    alpha, beta, no_meta = plans
    assert no_meta["kind"] == "document"
    assert no_meta["reason"] == "missing or invalid plan-meta"
    assert no_meta["size"] == len("<h1>not a plan</h1>")
    assert alpha["name"] == "Alpha"
    assert alpha["stage"] == "approved"
    assert alpha["overview"] == "First plan"
    assert alpha["todos"] == {
        "total": 2,
        "by_status": {"done": 1, "pending": 1},
        "awaiting_user": 0,
    }
    assert isinstance(alpha["mtime"], float)
    assert beta["name"] == "Beta"
    assert beta["stage"] == "draft"
    assert beta["todos"] == {"total": 0, "by_status": {}, "awaiting_user": 0}


async def test_plan_read_returns_meta_and_html(workspace: Path) -> None:
    result = await _call(
        "plan_read", {"workspace_path": str(workspace), "rel_path": "alpha.html"}
    )
    assert not result.isError
    data = result.structuredContent
    assert data["rel_path"] == ".agent-team/plans/alpha.html"
    assert data["meta"]["name"] == "Alpha"
    assert data["meta"]["stage"] == "approved"
    assert 'id="plan-meta"' in data["html"]
    assert data["html"] == (
        workspace / ".agent-team" / "plans" / "alpha.html"
    ).read_text(encoding="utf-8")


async def test_plan_read_accepts_the_full_workspace_relative_path(workspace: Path) -> None:
    """Both input forms resolve to the same plan (the other test passes a filename)."""
    result = await _call(
        "plan_read",
        {"workspace_path": str(workspace), "rel_path": ".agent-team/plans/alpha.html"},
    )
    assert not result.isError
    assert result.structuredContent["rel_path"] == ".agent-team/plans/alpha.html"
    assert result.structuredContent["meta"]["name"] == "Alpha"


async def test_plan_read_rejects_path_traversal(workspace: Path) -> None:
    result = await _call(
        "plan_read", {"workspace_path": str(workspace), "rel_path": "../secret.html"}
    )
    assert result.isError


async def test_plan_read_rejects_missing_file(workspace: Path) -> None:
    result = await _call(
        "plan_read", {"workspace_path": str(workspace), "rel_path": "nope.html"}
    )
    assert result.isError


async def test_plan_create_writes_plan_and_lists_it(workspace: Path) -> None:
    plans = _plans_dir(workspace)
    # The fixture's fake _template.html has no plan-meta island; remove it so
    # plan_create falls back to provisioning the real bundled template.
    (plans / "_template.html").unlink()
    result = await _call(
        "plan_create",
        {
            "workspace_path": str(workspace),
            "name": "My New Plan",
            "overview": "Test overview.",
            "todos": ["First task", {"id": "phase-b", "content": "Second task"}],
        },
    )
    assert not result.isError
    data = result.structuredContent
    assert re.fullmatch(r"\.agent-team/plans/my-new-plan_[0-9a-f]{6}\.html", data["rel_path"])
    assert data["name"] == "My New Plan"
    assert data["stage"] == "draft"
    # No pane workspaces are known in this test, so no advisory warning fires.
    assert "warning" not in data

    html = (workspace / data["rel_path"]).read_text(encoding="utf-8")
    meta = parse_plan_meta(html)
    assert meta["schemaVersion"] == 1
    assert meta["name"] == "My New Plan"
    assert meta["overview"] == "Test overview."
    assert meta["stage"] == "draft"
    assert meta["approvedAt"] is None
    assert meta["todos"] == [
        {"id": "t1", "content": "First task", "status": "pending"},
        {"id": "phase-b", "content": "Second task", "status": "pending"},
    ]
    assert meta["reviewNotes"] == []
    # Visible markup carries the same data and no leftover template scaffolding.
    assert "My New Plan" in html
    assert 'data-todo-id="t1"' in html and "First task" in html
    assert 'data-todo-id="phase-b"' in html and "Second task" in html
    assert "{{" not in html
    # The provisioned template itself stays a pristine template.
    assert "{{PLAN_NAME}}" in (plans / "_template.html").read_text(encoding="utf-8")

    listed = await _call("plan_list", {"workspace_path": str(workspace)})
    rels = [p["rel_path"] for p in listed.structuredContent["result"]]
    assert data["rel_path"] in rels
    assert ".agent-team/plans/_template.html" not in rels


async def test_plan_update_stage_updates_island_and_pill(workspace: Path) -> None:
    result = await _call(
        "plan_update_stage",
        {"workspace_path": str(workspace), "rel_path": "beta.html", "stage": "in-review"},
    )
    assert not result.isError
    assert result.structuredContent == {"stage": "in-review", "approvedAt": None}
    html = (_plans_dir(workspace) / "beta.html").read_text(encoding="utf-8")
    assert parse_plan_meta(html)["stage"] == "in-review"
    assert '<span class="pill in-review">in-review</span>' in html


async def test_plan_update_stage_approved_sets_approved_at(workspace: Path) -> None:
    result = await _call(
        "plan_update_stage",
        {"workspace_path": str(workspace), "rel_path": "beta.html", "stage": "approved"},
    )
    assert not result.isError
    data = result.structuredContent
    assert data["stage"] == "approved"
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", data["approvedAt"])
    meta = parse_plan_meta((_plans_dir(workspace) / "beta.html").read_text(encoding="utf-8"))
    assert meta["stage"] == "approved"
    assert meta["approvedAt"] == data["approvedAt"]


async def test_plan_update_stage_rejects_invalid_stage(workspace: Path) -> None:
    result = await _call(
        "plan_update_stage",
        {"workspace_path": str(workspace), "rel_path": "beta.html", "stage": "bogus"},
    )
    assert result.isError


async def test_plan_update_todo_updates_island_and_li(workspace: Path) -> None:
    result = await _call(
        "plan_update_todo",
        {
            "workspace_path": str(workspace),
            "rel_path": "alpha.html",
            "todo_id": "t2",
            "status": "in-progress",
        },
    )
    assert not result.isError
    assert result.structuredContent == {"id": "t2", "status": "in-progress"}
    html = (_plans_dir(workspace) / "alpha.html").read_text(encoding="utf-8")
    todos = {t["id"]: t["status"] for t in parse_plan_meta(html)["todos"]}
    assert todos == {"t1": "done", "t2": "in-progress"}
    assert (
        '<li data-status="in-progress" data-todo-id="t2">'
        '<span class="st">in-progress</span>' in html
    )


async def test_plan_update_todo_rejects_unknown_id(workspace: Path) -> None:
    result = await _call(
        "plan_update_todo",
        {
            "workspace_path": str(workspace),
            "rel_path": "alpha.html",
            "todo_id": "nope",
            "status": "done",
        },
    )
    assert result.isError
    # The error lists the plan's valid todo ids.
    assert "t1" in result.content[0].text and "t2" in result.content[0].text


async def test_plan_add_note_appends_sequential_notes(workspace: Path) -> None:
    first = await _call(
        "plan_add_note",
        {"workspace_path": str(workspace), "rel_path": "beta.html", "text": "Looks unclear"},
    )
    assert not first.isError
    assert first.structuredContent == {
        "id": "n1",
        "author": "ai",
        "text": "Looks unclear",
        "resolved": False,
        "reply": "",
    }
    second = await _call(
        "plan_add_note",
        {
            "workspace_path": str(workspace),
            "rel_path": "beta.html",
            "text": "Second note",
            "author": "user",
        },
    )
    assert not second.isError
    assert second.structuredContent["id"] == "n2"
    assert second.structuredContent["author"] == "user"
    meta = parse_plan_meta((_plans_dir(workspace) / "beta.html").read_text(encoding="utf-8"))
    assert [n["id"] for n in meta["reviewNotes"]] == ["n1", "n2"]
    assert all(n["resolved"] is False for n in meta["reviewNotes"])


async def test_plan_update_stage_rejects_path_traversal(workspace: Path) -> None:
    result = await _call(
        "plan_update_stage",
        {
            "workspace_path": str(workspace),
            "rel_path": "../secret.html",
            "stage": "draft",
        },
    )
    assert result.isError
    assert (workspace / ".agent-team" / "secret.html").read_text(encoding="utf-8") == "secret"


# ── workspace-mismatch warning ──────────────────────────────────────────────


class _FakeTerminalService:
    """Stand-in for TerminalService: just the `_sessions` dict the
    workspace-mismatch check snapshots."""

    def __init__(self, sessions: list[SimpleNamespace]) -> None:
        self._sessions = {s.id: s for s in sessions}


def _fake_session(
    session_id: str,
    agent_key: str | None = "claude",
    cwd: str = "/ws/a",
    metadata: dict | None = None,
    closed: bool = False,
) -> SimpleNamespace:
    return SimpleNamespace(
        id=session_id,
        pane_id=f"pane-{session_id}",
        agent_key=agent_key,
        cwd=cwd,
        metadata=metadata if metadata is not None else {},
        closed=closed,
    )


@pytest.fixture
def fake_terminals(monkeypatch: pytest.MonkeyPatch) -> _FakeTerminalService:
    fake = _FakeTerminalService(
        [
            _fake_session("s1", agent_key="claude", cwd="/ws/a"),
            _fake_session(
                "s2",
                agent_key="codex",
                cwd="/ws/b/sub",
                metadata={"workspace_path": "/ws/b"},
            ),
            _fake_session("s3", agent_key="claude", cwd="/ws/b", closed=True),
        ]
    )
    monkeypatch.setattr(backend_app, "get_terminals", lambda: fake)
    return fake


async def test_plan_create_at_done_records_finished_work(workspace: Path) -> None:
    """A report is not a plan waiting for approval. Creating it straight at
    "done" is what stops finished write-ups from piling up in "in-review",
    which is the stage that means "blocked until the user approves"."""
    (_plans_dir(workspace) / "_template.html").unlink()
    result = await _call(
        "plan_create",
        {
            "workspace_path": str(workspace),
            "name": "Delivery Report",
            "overview": "What shipped.",
            "todos": ["What changed", "How it was verified"],
            "stage": "done",
        },
    )
    assert not result.isError
    data = result.structuredContent
    assert data["stage"] == "done"

    html = (workspace / data["rel_path"]).read_text(encoding="utf-8")
    meta = parse_plan_meta(html)
    assert meta["stage"] == "done"
    # Its todos are its sections, not things anyone will tick off later —
    # leaving them pending would render a finished document as "0/2 done".
    assert [t["status"] for t in meta["todos"]] == ["done", "done"]
    assert meta["approvedAt"] is not None
    # The visible badge is what the user actually sees; meta alone is not enough.
    assert '<span class="pill done">done</span>' in html
    assert '<span class="pill draft">draft</span>' not in html
    assert 'data-status="done"' in html


async def test_plan_create_still_defaults_to_draft(workspace: Path) -> None:
    """The default must not move: every existing caller omits the argument."""
    (_plans_dir(workspace) / "_template.html").unlink()
    result = await _call(
        "plan_create",
        {
            "workspace_path": str(workspace),
            "name": "Ordinary Plan",
            "overview": "To be approved.",
            "todos": ["Do the thing"],
        },
    )
    data = result.structuredContent
    assert data["stage"] == "draft"
    meta = parse_plan_meta((workspace / data["rel_path"]).read_text(encoding="utf-8"))
    assert meta["approvedAt"] is None
    assert [t["status"] for t in meta["todos"]] == ["pending"]


async def test_plan_create_at_in_review_does_not_stamp_approval(workspace: Path) -> None:
    """in-review is before the gate: nothing has been approved yet."""
    (_plans_dir(workspace) / "_template.html").unlink()
    result = await _call(
        "plan_create",
        {
            "workspace_path": str(workspace),
            "name": "Proposal",
            "overview": "For review.",
            "todos": ["Phase one"],
            "stage": "in-review",
        },
    )
    meta = parse_plan_meta(
        (workspace / result.structuredContent["rel_path"]).read_text(encoding="utf-8")
    )
    assert meta["stage"] == "in-review"
    assert meta["approvedAt"] is None
    assert [t["status"] for t in meta["todos"]] == ["pending"]


async def test_plan_create_rejects_an_unknown_stage(workspace: Path) -> None:
    result = await _call(
        "plan_create",
        {
            "workspace_path": str(workspace),
            "name": "Bad",
            "overview": "x",
            "todos": ["y"],
            "stage": "finished",
        },
    )
    assert result.isError
    assert "invalid stage" in result.content[0].text


async def test_a_user_owned_todo_is_counted_as_awaiting_the_user(workspace: Path) -> None:
    """The whole point: a finished write-up whose only open item is a manual
    verification must be tellable apart from a plan nobody has started."""
    (_plans_dir(workspace) / "_template.html").unlink()
    created = await _call(
        "plan_create",
        {
            "workspace_path": str(workspace),
            "name": "Delivery With Verification",
            "overview": "Shipped, pending a real-machine check.",
            "todos": [
                {"id": "impl", "content": "Implement it"},
                {"id": "verify", "content": "Verify on a real machine", "owner": "user"},
            ],
        },
    )
    rel = created.structuredContent["rel_path"]
    meta = parse_plan_meta((workspace / rel).read_text(encoding="utf-8"))
    # The default owner is stored by being absent, so existing documents stay
    # byte-identical when rewritten.
    assert "owner" not in meta["todos"][0]
    assert meta["todos"][1]["owner"] == "user"

    listed = await _call("plan_list", {"workspace_path": str(workspace)})
    entry = next(p for p in listed.structuredContent["result"] if p["rel_path"] == rel)
    assert entry["todos"]["awaiting_user"] == 1

    # Once done it is no longer awaiting anyone.
    await _call(
        "plan_update_todo",
        {"workspace_path": str(workspace), "rel_path": rel, "todo_id": "verify", "status": "done"},
    )
    listed = await _call("plan_list", {"workspace_path": str(workspace)})
    entry = next(p for p in listed.structuredContent["result"] if p["rel_path"] == rel)
    assert entry["todos"]["awaiting_user"] == 0


async def test_an_existing_todo_can_be_handed_to_the_user(workspace: Path) -> None:
    """Backfilling matters more than new documents: the pile that prompted this
    is 59 existing files whose verification items were never marked."""
    (_plans_dir(workspace) / "_template.html").unlink()
    created = await _call(
        "plan_create",
        {
            "workspace_path": str(workspace),
            "name": "Older Report",
            "overview": "Written before owners existed.",
            "todos": [{"id": "check", "content": "Confirm in the real app"}],
        },
    )
    rel = created.structuredContent["rel_path"]
    updated = await _call(
        "plan_update_todo",
        {
            "workspace_path": str(workspace),
            "rel_path": rel,
            "todo_id": "check",
            "status": "pending",
            "owner": "user",
        },
    )
    assert updated.structuredContent["owner"] == "user"

    listed = await _call("plan_list", {"workspace_path": str(workspace)})
    entry = next(p for p in listed.structuredContent["result"] if p["rel_path"] == rel)
    assert entry["todos"]["awaiting_user"] == 1

    # And handed back again.
    await _call(
        "plan_update_todo",
        {
            "workspace_path": str(workspace),
            "rel_path": rel,
            "todo_id": "check",
            "status": "pending",
            "owner": "agent",
        },
    )
    meta = parse_plan_meta((workspace / rel).read_text(encoding="utf-8"))
    assert "owner" not in meta["todos"][0]


async def test_an_unknown_owner_is_refused(workspace: Path) -> None:
    result = await _call(
        "plan_create",
        {
            "workspace_path": str(workspace),
            "name": "Bad Owner",
            "overview": "x",
            "todos": [{"id": "t1", "content": "y", "owner": "somebody"}],
        },
    )
    assert result.isError
    assert "invalid todo owner" in result.content[0].text


async def test_plan_create_from_a_subdirectory_lands_in_the_repo_root(
    workspace: Path,
) -> None:
    """An agent reporting its own cwd must not start a second pile of plans."""
    (workspace / ".git").mkdir()
    subdir = workspace / "backend" / "src"
    subdir.mkdir(parents=True)

    result = await _call(
        "plan_create",
        {
            "workspace_path": str(subdir),
            "name": "Nested Plan",
            "overview": "From a subdirectory.",
            "todos": ["Only task"],
        },
    )

    assert not result.isError
    rel_path = result.structuredContent["rel_path"]
    assert (workspace / rel_path).is_file()
    assert not (subdir / ".agent-team").exists()


async def test_plan_read_from_a_subdirectory_finds_the_repo_root_plan(
    workspace: Path,
) -> None:
    """Reads resolve the same way writes do, or a created plan is unreachable."""
    (workspace / ".git").mkdir()
    subdir = workspace / "backend"
    subdir.mkdir()
    created = await _call(
        "plan_create",
        {
            "workspace_path": str(workspace),
            "name": "Root Plan",
            "overview": "",
            "todos": ["Task"],
        },
    )
    rel_path = created.structuredContent["rel_path"]

    result = await _call("plan_read", {"workspace_path": str(subdir), "rel_path": rel_path})

    assert not result.isError
    assert result.structuredContent["rel_path"] == rel_path
    assert result.structuredContent["html"]


async def test_plan_create_warns_when_no_pane_uses_the_workspace(
    workspace: Path, fake_terminals: _FakeTerminalService
) -> None:
    """The plan window resolves plans against a pane's workspace, so writing to
    a root no pane uses produces a file Navide can never open."""
    (_plans_dir(workspace) / "_template.html").unlink()
    result = await _call(
        "plan_create",
        {
            "workspace_path": str(workspace),
            "name": "Orphan Plan",
            "overview": "",
            "todos": ["Task"],
        },
    )
    assert not result.isError
    warning = result.structuredContent["warning"]
    assert str(workspace) in warning
    # Live pane workspaces are listed so the agent can retry against one; the
    # closed session's workspace (/ws/b via s3) is not a live pane on its own.
    assert "/ws/a" in warning and "/ws/b" in warning


async def test_plan_create_does_not_warn_when_a_pane_matches(
    workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = _FakeTerminalService([_fake_session("s1", cwd=str(workspace))])
    monkeypatch.setattr(backend_app, "get_terminals", lambda: fake)
    (_plans_dir(workspace) / "_template.html").unlink()
    result = await _call(
        "plan_create",
        {
            "workspace_path": str(workspace),
            "name": "Matched Plan",
            "overview": "",
            "todos": ["Task"],
        },
    )
    assert not result.isError
    assert "warning" not in result.structuredContent


async def test_plan_create_from_a_git_subfolder_pane_lands_in_the_view_root_without_warning(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A pane working in a subfolder of a repository: the plan lands in the git
    root, which is the root the Plan view resolves that same workspace to — so
    the pane's own workspace does use it and no "no pane uses" warning fires."""
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    subfolder = repo / "MVP"
    subfolder.mkdir()
    fake = _FakeTerminalService([_fake_session("s1", cwd=str(subfolder))])
    monkeypatch.setattr(backend_app, "get_terminals", lambda: fake)
    result = await _call(
        "plan_create",
        {
            "workspace_path": str(subfolder),
            "name": "Subfolder Plan",
            "overview": "",
            "todos": ["Task"],
        },
    )
    assert not result.isError
    assert resolve_plan_root(str(subfolder)) == str(repo.resolve())
    created = repo / result.structuredContent["rel_path"]
    assert created.is_file()
    assert created.parent == (repo / ".agent-team" / "plans")
    assert not (subfolder / ".agent-team").exists()
    assert "warning" not in result.structuredContent


# ── workspace defaults to the calling pane's own ────────────────────────────


@pytest.fixture
def clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


def _pane_ctx(pane_id: str = "pa") -> SimpleNamespace:
    """A Context carrying a live pane's credential, the way a wired CLI spawn
    does (plan_mcp_wiring.plan_mcp_url)."""
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


async def _pane_call(tool: str, args: dict, pane_id: str = "pa") -> _ToolResult:
    try:
        value = await _tool(tool)(**args, ctx=_pane_ctx(pane_id))
    except Exception as err:  # noqa: BLE001 — mirrors the MCP session's isError wrapping
        return _ToolResult(error=err)
    return _ToolResult(value=value)


async def test_plan_create_without_a_workspace_uses_the_callers_pane(
    workspace: Path, clean_registry: Any
) -> None:
    """The pane's workspace is what Navide's plan view resolves against, so a
    plan created without an argument is always one the user can open."""
    agent_messaging.register("pa", "builder", str(workspace), agent_key="claude")

    result = await _pane_call(
        "plan_create", {"name": "Pane Plan", "overview": "", "todos": ["Task"]}
    )

    assert not result.isError
    assert (workspace / result.structuredContent["rel_path"]).is_file()


async def test_plan_list_without_a_workspace_uses_the_callers_pane(
    workspace: Path, clean_registry: Any
) -> None:
    agent_messaging.register("pa", "builder", str(workspace), agent_key="claude")

    result = await _pane_call("plan_list", {})

    assert not result.isError
    assert {p["name"] for p in result.structuredContent["result"]} == {"Alpha", "Beta", "no-meta.html"}


async def test_an_explicit_workspace_still_wins_over_the_panes(
    workspace: Path, tmp_path: Path, clean_registry: Any
) -> None:
    """Naming another project stays possible — the default is a fallback, not
    a lock."""
    other = tmp_path / "other-project"
    (other / ".agent-team" / "plans").mkdir(parents=True)
    agent_messaging.register("pa", "builder", str(workspace), agent_key="claude")

    result = await _pane_call(
        "plan_create",
        {"name": "Elsewhere", "overview": "", "todos": ["Task"], "workspace_path": str(other)},
    )

    assert not result.isError
    assert (other / result.structuredContent["rel_path"]).is_file()
    assert not (workspace / result.structuredContent["rel_path"]).exists()


async def test_a_pane_workspace_inside_a_repo_resolves_to_the_repo_root(
    workspace: Path, clean_registry: Any
) -> None:
    """The fallback normalises like an explicit argument does, because
    plan_provisioning writes _template.html to the resolved root — a plan
    written anywhere else cannot be created at all.

    Note the pre-existing gap this pins down rather than fixes: the read side
    (plans.list_docs, fs.read_file) uses the workspace verbatim, so a pane
    opened on a repo *subdirectory* still lists plans from that subdirectory
    while every writer puts them in the repo root. Panes opened on a repo root
    — the normal case — are unaffected.
    """
    (workspace / ".git").mkdir()
    subdir = workspace / "packages" / "app"
    subdir.mkdir(parents=True)
    agent_messaging.register("pa", "builder", str(subdir), agent_key="claude")

    result = await _pane_call(
        "plan_create", {"name": "Sub Plan", "overview": "", "todos": ["Task"]}
    )

    assert not result.isError
    rel_path = result.structuredContent["rel_path"]
    assert (workspace / rel_path).is_file()
    assert not (subdir / ".agent-team").exists()


async def test_the_pane_default_never_warns_about_its_own_workspace(
    workspace: Path, monkeypatch: pytest.MonkeyPatch, clean_registry: Any
) -> None:
    """The warning tells an agent its workspace is one Navide cannot show. The
    pane's own workspace is by definition not that, so a default that trips it
    would be advising the agent to move a plan that is already in the right
    place."""
    fake = _FakeTerminalService([_fake_session("s1", cwd=str(workspace))])
    monkeypatch.setattr(backend_app, "get_terminals", lambda: fake)
    agent_messaging.register("pa", "builder", str(workspace), agent_key="claude")

    result = await _pane_call(
        "plan_create", {"name": "Own Workspace", "overview": "", "todos": ["Task"]}
    )

    assert not result.isError
    assert "warning" not in result.structuredContent


async def test_a_caller_with_no_pane_identity_must_pass_a_workspace(
    workspace: Path, clean_registry: Any
) -> None:
    """host/external callers are not panes and have no workspace to fall back
    to — erroring beats silently picking one."""
    result = await _call("plan_list", {})

    assert result.isError
    assert "workspace_path is required" in result.content[0].text


async def test_mounted_endpoint_serves_mcp(workspace: Path) -> None:
    # The real startup path: activate the plugin so it installs its tools onto
    # the core server, mount the core route on the real app router, start the
    # session manager, then speak MCP. The order matters — the manager
    # snapshots the tool registry, so installing after it starts would leave
    # the plan tools out of tools/list with no error anywhere.
    from starlette.routing import Route

    host = PluginHost()
    host.load(plugin_wiring.builtin_plugins_root() / "navide_plans")
    host.activate("navide.plans")
    assert plugin_wiring.apply_mcp_tools(host, plan_mcp.server) == ["navide.plans"]
    routes_before = list(app.router.routes)
    app.router.routes.append(
        Route(
            plan_mcp.ROUTE_PATH,
            endpoint=plan_mcp.asgi_app,
            methods=plan_mcp.ROUTE_METHODS,
        )
    )
    await plan_mcp.startup()
    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as client:
            # Every Navide CLI's URL carries a credential, checked before the
            # body is read (review M2); the host one is the fallback wiring's.
            resp = await client.post(
                f"/plan-mcp?client=host&t={plan_mcp_auth.internal_token()}",
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-06-18",
                        "capabilities": {},
                        "clientInfo": {"name": "test", "version": "0"},
                    },
                },
                headers={"accept": "application/json, text/event-stream"},
            )
            assert resp.status_code == 200
            body = resp.json()
            assert body["result"]["serverInfo"]["name"] == "navide"
    finally:
        await plan_mcp.shutdown()
        app.router.routes[:] = routes_before
        host.unload("navide.plans")


# Regression for the legacy local adapter (the route this file's autouse
# recovery fixture forces): the {{…}} sweep used to run *after* the caller's
# name/overview/todo text was inserted, so a caller's own "{{…}}" was silently
# rewritten to TBD in the visible markup while plan-meta kept the real string.
@pytest.mark.asyncio
@pytest.mark.parametrize("field,name,overview,todos", [
    ("name", r"Migrate {{legacy}} config", "Plain overview.", ["Plain todo"]),
    ("overview", "Plain name", r"Replace {{TOKEN}} in files.", ["Plain todo"]),
    ("todo", "Plain name", "Plain overview.", [r"Replace {{TOKEN}} in files"]),
    ("all-three", r"Fix {{a}}", r"Sweep {{b}}.", [r"Todo {{c}}"]),
])
async def test_plan_create_preserves_double_braces_in_caller_text(
    workspace: Path, field: str, name: str, overview: str, todos: list[str]
) -> None:
    plans = _plans_dir(workspace)
    # Use the real bundled template, not the fixture's stub.
    (plans / "_template.html").unlink()
    result = await _call(
        "plan_create",
        {
            "workspace_path": str(workspace),
            "name": name,
            "overview": overview,
            "todos": todos,
        },
    )
    assert not result.isError, result.content
    html = (workspace / result.structuredContent["rel_path"]).read_text(encoding="utf-8")

    # plan-meta keeps the caller's text (it always did) ...
    meta = parse_plan_meta(html)
    assert meta["name"] == name
    assert meta["overview"] == overview
    assert [todo["content"] for todo in meta["todos"]] == todos

    # ... and the visible markup must now agree with it instead of showing TBD.
    heading = re.search(r"<h1[^>]*>([\s\S]*?)<span", html)
    overview_text = re.search(r'\bclass="overview"[^>]*>([\s\S]*?)</', html)
    assert heading is not None and overview_text is not None
    assert heading.group(1).strip() == name
    assert overview_text.group(1).strip() == overview
    rows = [row.strip() for row in re.findall(r"<span>([^<]*)</span>\s*</li>", html)]
    assert rows == todos

    # The scaffolding the caller did not supply is still swept.
    assert "{{PLAN_NAME}}" not in html
    assert "{{PHASE_A_TITLE}}" not in html
    assert "TBD" in html


# ── large documents and the Host's paged plans.read ─────────────────────────


def _route_with(monkeypatch: pytest.MonkeyPatch, handler: Any) -> list[tuple[str, dict[str, Any]]]:
    """Answer the Host route with `handler(name, args)`; returns the call log."""
    calls: list[tuple[str, dict[str, Any]]] = []

    async def route(_target: str, _workspace: str, payload: dict[str, Any], **_kwargs: Any) -> dict[str, Any]:
        calls.append((payload["name"], dict(payload["args"])))
        return {"ok": True, "result": handler(payload["name"], payload["args"])}

    monkeypatch.setattr(plan_mcp, "request_host_agent_workspace_backend", route)
    return calls


async def test_plan_read_joins_the_hosts_pages_into_one_document(
    workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pieces = ["<html>" + "a" * 10, "b" * 10, "c" * 10 + "</html>"]
    meta = {"schemaVersion": 1, "name": "Big", "stage": "draft", "todos": [], "reviewNotes": []}

    def host(name: str, args: dict[str, Any]) -> dict[str, Any]:
        assert name == "plans.read"
        offset = args.get("offset", 0)
        index = 0 if offset == 0 else 1 if offset == 100 else 2
        page: dict[str, Any] = {"rel_path": args["rel_path"], "html": pieces[index], "mtime": 7.0}
        if offset == 0:
            page["meta"] = meta
        if index < 2:
            page.update({"size": 300, "offset": offset, "eof": False, "next_offset": offset + 100 if offset else 100})
            page["next_offset"] = 100 if index == 0 else 200
        else:
            page.update({"size": 300, "offset": offset, "eof": True})
        return page

    calls = _route_with(monkeypatch, host)
    result = await _call("plan_read", {"workspace_path": str(workspace), "rel_path": "big.html"})

    assert not result.isError
    value = result.structuredContent
    assert value["html"] == "".join(pieces)
    assert value["meta"] == meta and value["mtime"] == 7.0
    assert not {"eof", "next_offset", "offset", "size"} & set(value)
    assert [args.get("offset") for _name, args in calls] == [None, 100, 200]


async def test_plan_read_restarts_when_the_file_changes_between_pages(
    workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen = {"reads": 0}

    def host(_name: str, args: dict[str, Any]) -> dict[str, Any]:
        offset = args.get("offset", 0)
        if offset == 0:
            seen["reads"] += 1
            return {"rel_path": "x", "meta": None, "html": "v%d-a" % seen["reads"], "mtime": float(seen["reads"]),
                    "size": 10, "offset": 0, "eof": False, "next_offset": 5}
        # The file is rewritten during the first attempt only.
        return {"rel_path": "x", "html": "-b", "mtime": 99.0 if seen["reads"] == 1 else float(seen["reads"]),
                "size": 10, "offset": offset, "eof": True}

    _route_with(monkeypatch, host)
    result = await _call("plan_read", {"workspace_path": str(workspace), "rel_path": "x.html"})

    assert not result.isError
    assert result.structuredContent["html"] == "v2-a-b"
    assert seen["reads"] == 2


async def test_plan_read_falls_back_to_the_local_file_when_the_host_reports_storage_unavailable(
    workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def route(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {
            "ok": False,
            "error": {"code": "BACKEND_UNAVAILABLE", "message": "Plans storage is unavailable"},
            "recoveryDisposition": "legacy-safe-before-dispatch",
        }

    monkeypatch.setattr(plan_mcp, "request_host_agent_workspace_backend", route)
    listed = await _call("plan_list", {"workspace_path": str(workspace)})
    read = await _call("plan_read", {"workspace_path": str(workspace), "rel_path": "alpha.html"})

    assert not listed.isError and not read.isError
    assert ".agent-team/plans/alpha.html" in [p["rel_path"] for p in listed.structuredContent["result"]]
    assert read.structuredContent["meta"]["name"] == "Alpha"


async def test_plan_list_locally_lists_a_document_it_cannot_read(workspace: Path) -> None:
    plans = _plans_dir(workspace)
    (plans / "huge.html").write_bytes(b"<html>" + b"x" * (6 * 1024 * 1024) + b"</html>")
    (plans / "binary.html").write_bytes(b"\xff\xfe" * 10)

    result = await _call("plan_list", {"workspace_path": str(workspace)})

    by_path = {p["rel_path"]: p for p in result.structuredContent["result"]}
    assert by_path[".agent-team/plans/huge.html"]["kind"] == "document"
    assert by_path[".agent-team/plans/huge.html"]["size"] > 5 * 1024 * 1024
    assert ".agent-team/plans/binary.html" in by_path
    read = await _call("plan_read", {"workspace_path": str(workspace), "rel_path": "huge.html"})
    assert len(read.structuredContent["html"]) == 6 * 1024 * 1024 + len("<html></html>")


# ── plan_add_todo ───────────────────────────────────────────────────────────


def _row_ids(html: str) -> list[str]:
    return re.findall(r'<li\b[^>]*data-todo-id="([^"]+)"', html)


async def _add_todo(workspace: Path, **args: Any) -> _ToolResult:
    return await _call("plan_add_todo", {"workspace_path": str(workspace), "rel_path": "alpha.html", **args})


async def test_plan_add_todo_appends_to_the_island_and_the_visible_list(workspace: Path) -> None:
    result = await _add_todo(workspace, content="Third <step>")
    assert not result.isError, result.content[0].text
    assert result.structuredContent == {"id": "t3", "content": "Third <step>", "status": "pending"}
    html = (_plans_dir(workspace) / "alpha.html").read_text(encoding="utf-8")
    todos = parse_plan_meta(html)["todos"]
    assert [t["id"] for t in todos] == ["t1", "t2", "t3"]
    assert todos[2] == {"id": "t3", "content": "Third <step>", "status": "pending"}
    assert _row_ids(html) == ["t1", "t2", "t3"]
    row = re.search(r'<li data-status="pending" data-todo-id="t3">[\s\S]*?</li>', html).group(0)
    assert '<span class="st">pending</span>' in row
    assert "Third &lt;step&gt;" in row
    # Appended inside the same list, not after it.
    assert html.index('data-todo-id="t3"') < html.index("</ul>")


async def test_plan_add_todo_inserts_after_the_named_todo(workspace: Path) -> None:
    result = await _add_todo(workspace, content="In between", id="mid-step", after="t1")
    assert not result.isError, result.content[0].text
    html = (_plans_dir(workspace) / "alpha.html").read_text(encoding="utf-8")
    assert [t["id"] for t in parse_plan_meta(html)["todos"]] == ["t1", "mid-step", "t2"]
    assert _row_ids(html) == ["t1", "mid-step", "t2"]


async def test_plan_add_todo_auto_ids_never_reuse_or_renumber(workspace: Path) -> None:
    await _add_todo(workspace, content="Named", id="named")
    first = await _add_todo(workspace, content="Auto one")
    second = await _add_todo(workspace, content="Auto two", after="t1")
    assert first.structuredContent["id"] == "t3"
    assert second.structuredContent["id"] == "t4"
    html = (_plans_dir(workspace) / "alpha.html").read_text(encoding="utf-8")
    assert [t["id"] for t in parse_plan_meta(html)["todos"]] == ["t1", "t4", "t2", "named", "t3"]
    assert _row_ids(html) == ["t1", "t4", "t2", "named", "t3"]


@pytest.mark.parametrize(
    ("args", "needle"),
    [
        ({"id": "t1"}, "duplicate todo id"),
        ({"id": "Bad_Id"}, "invalid todo id"),
        ({"after": "nope"}, "unknown todo id"),
        ({"status": "blocked"}, "invalid status"),
        ({"owner": "robot"}, "invalid todo owner"),
        ({"content": "   "}, "empty"),
    ],
)
async def test_plan_add_todo_refusals_leave_the_file_untouched(
    workspace: Path, args: dict[str, str], needle: str
) -> None:
    target = _plans_dir(workspace) / "alpha.html"
    before = target.read_bytes()
    result = await _add_todo(workspace, **{"content": "New", **args})
    assert result.isError
    assert needle in result.content[0].text
    assert target.read_bytes() == before


async def test_plan_add_todo_unknown_after_lists_the_valid_ids(workspace: Path) -> None:
    result = await _add_todo(workspace, content="New", after="nope")
    assert result.isError
    assert "t1" in result.content[0].text and "t2" in result.content[0].text


async def test_plan_add_todo_owner_and_status_are_stored_like_plan_create(workspace: Path) -> None:
    user = await _add_todo(workspace, content="Verify on a real machine", owner="user", status="in-progress")
    agent = await _add_todo(workspace, content="Agent work", owner="agent")
    assert user.structuredContent == {
        "id": "t3", "content": "Verify on a real machine", "status": "in-progress", "owner": "user",
    }
    assert agent.structuredContent == {"id": "t4", "content": "Agent work", "status": "pending"}
    html = (_plans_dir(workspace) / "alpha.html").read_text(encoding="utf-8")
    todos = {t["id"]: t for t in parse_plan_meta(html)["todos"]}
    assert todos["t3"]["owner"] == "user"
    assert "owner" not in todos["t4"]
    assert '<li data-status="in-progress" data-todo-id="t3">' in html


async def test_plan_add_todo_refuses_a_write_that_raced_it(
    workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = _plans_dir(workspace) / "alpha.html"
    original = plan_tools._load_plan_for_write  # noqa: SLF001

    def load_then_race(*args: Any) -> Any:
        loaded = original(*args)
        target.write_text(target.read_text(encoding="utf-8") + "<!-- raced -->", encoding="utf-8")
        stat = target.stat()
        os.utime(target, (stat.st_atime, stat.st_mtime + 5))
        return loaded

    monkeypatch.setattr(plan_tools, "_load_plan_for_write", load_then_race)
    result = await _add_todo(workspace, content="Lost update")
    assert result.isError
    assert "conflict" in result.content[0].text
    html = target.read_text(encoding="utf-8")
    assert html.endswith("<!-- raced -->")
    assert [t["id"] for t in parse_plan_meta(html)["todos"]] == ["t1", "t2"]


async def test_plan_add_todo_fills_an_empty_todo_list(workspace: Path) -> None:
    result = await _call(
        "plan_add_todo", {"workspace_path": str(workspace), "rel_path": "beta.html", "content": "First"}
    )
    assert not result.isError, result.content[0].text
    assert "warning" not in result.structuredContent
    html = (_plans_dir(workspace) / "beta.html").read_text(encoding="utf-8")
    assert [t["id"] for t in parse_plan_meta(html)["todos"]] == ["t1"]
    assert _row_ids(html) == ["t1"]
    assert html.index('data-todo-id="t1"') < html.index("</ul>")


async def test_plan_add_todo_without_todo_markup_writes_the_island_and_warns(workspace: Path) -> None:
    meta = {"schemaVersion": 1, "name": "Bare", "stage": "draft", "overview": "", "todos": [], "reviewNotes": []}
    target = _plans_dir(workspace) / "bare.html"
    target.write_text(
        f'<script type="application/json" id="plan-meta">\n{json.dumps(meta)}\n</script>\n<p>prose</p>\n',
        encoding="utf-8",
    )
    result = await _call(
        "plan_add_todo", {"workspace_path": str(workspace), "rel_path": "bare.html", "content": "Only in meta"}
    )
    assert not result.isError, result.content[0].text
    assert result.structuredContent["id"] == "t1"
    assert "not inserted" in result.structuredContent["warning"]
    html = target.read_text(encoding="utf-8")
    assert [t["id"] for t in parse_plan_meta(html)["todos"]] == ["t1"]
    assert _row_ids(html) == []


async def test_plan_add_todo_warns_when_the_after_row_is_missing_from_the_markup(workspace: Path) -> None:
    target = _plans_dir(workspace) / "alpha.html"
    target.write_text(
        re.sub(r'<li data-status="done" data-todo-id="t1">[\s\S]*?</li>', "", target.read_text(encoding="utf-8")),
        encoding="utf-8",
    )
    result = await _add_todo(workspace, content="After a hidden row", after="t1")
    assert not result.isError, result.content[0].text
    assert "warning" in result.structuredContent
    html = target.read_text(encoding="utf-8")
    assert [t["id"] for t in parse_plan_meta(html)["todos"]] == ["t1", "t3", "t2"]
    assert _row_ids(html) == ["t2"]


async def test_plan_add_todo_routes_through_the_host(monkeypatch: pytest.MonkeyPatch, workspace: Path) -> None:
    calls: list[tuple[str, dict[str, Any]]] = []

    async def route(plugin_id: str, workspace_path: str, request: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
        calls.append((request["name"], request["args"]))
        return {"ok": True, "result": {"id": "t3", "content": "Hosted", "status": "pending"}}

    monkeypatch.setattr(plan_mcp, "request_host_agent_workspace_backend", route)
    target = _plans_dir(workspace) / "alpha.html"
    before = target.read_bytes()
    result = await _add_todo(workspace, content="Hosted", after="t1")
    assert result.structuredContent == {"id": "t3", "content": "Hosted", "status": "pending"}
    assert calls == [(
        "plans.add_todo",
        {"rel_path": "alpha.html", "content": "Hosted", "id": "", "owner": "", "status": "pending", "after": "t1"},
    )]
    assert target.read_bytes() == before


async def test_plan_add_todo_explains_a_host_refusal_with_the_valid_ids(
    monkeypatch: pytest.MonkeyPatch, workspace: Path
) -> None:
    html = (_plans_dir(workspace) / "alpha.html").read_text(encoding="utf-8")

    async def route(plugin_id: str, workspace_path: str, request: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
        if request["name"] == "plans.read":
            return {"ok": True, "result": {"rel_path": "alpha.html", "meta": parse_plan_meta(html), "html": html}}
        return {"ok": False, "error": {"code": "INVALID_ARGUMENT", "message": "Plugin request failed."}}

    monkeypatch.setattr(plan_mcp, "request_host_agent_workspace_backend", route)
    result = await _add_todo(workspace, content="New", after="nope")
    assert result.isError
    text = result.content[0].text
    assert "unknown todo id" in text and "t1" in text and "t2" in text


# ── no request body limit on /mcp (agent-tools contract 4.4, A1) ────────────


async def test_a_10_mib_plan_add_note_crosses_the_mcp_endpoint_while_other_calls_stay_fast(
    workspace: Path,
) -> None:
    import asyncio
    import time

    import httpx

    from agent_team_backend.mcp_server import auth as plan_mcp_auth

    # The plan tools are installed onto the core server by the Plans plugin at
    # App start; install the missing ones for this test and take them off after.
    tools = plan_mcp.server._tool_manager._tools  # noqa: SLF001
    added = [tool for tool in plan_tools.PLAN_TOOLS if tool.__name__ not in tools]
    for tool in added:
        plan_mcp.server.tool()(tool)
    await plan_mcp.startup()
    try:
        url = f"/?client=host&t={plan_mcp_auth.internal_token()}"
        headers = {"accept": "application/json, text/event-stream", "content-type": "application/json"}
        text = "note 中文 😀 " * (10 * 1_048_576 // 16)

        def call(request_id: int, name: str, arguments: dict) -> dict:
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            }

        transport = httpx.ASGITransport(app=plan_mcp.asgi_app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test", timeout=120) as client:
            big = asyncio.create_task(client.post(url, headers=headers, json=call(
                1, "plan_add_note", {"workspace_path": str(workspace), "rel_path": "beta.html", "text": text},
            )))
            latencies: list[float] = []
            while not big.done():
                started = time.perf_counter()
                small = await client.post(url, headers=headers, json=call(
                    2, "plan_list", {"workspace_path": str(workspace)},
                ))
                latencies.append(time.perf_counter() - started)
                assert small.status_code == 200
            response = await big
        # The SDK refused bodies over 4 MiB with 413 before.
        assert response.status_code == 200, response.text[:300]
        body = response.json()
        assert "error" not in body, str(body)[:300]
        assert body["result"]["isError"] is False, str(body)[:300]
        notes = parse_plan_meta((_plans_dir(workspace) / "beta.html").read_text(encoding="utf-8"))["reviewNotes"]
        assert notes[-1]["text"] == text.strip()  # the tool trims the note
        assert latencies, "no small call ran during the large one"
    finally:
        await plan_mcp.shutdown()
        for tool in added:
            tools.pop(tool.__name__, None)


def _mcp_scope(query: str, headers: list[tuple[bytes, bytes]] | None = None) -> dict[str, Any]:
    return {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST", "scheme": "http",
        "path": "/", "raw_path": b"/", "root_path": "", "query_string": query.encode(),
        "headers": [(b"content-type", b"application/json"), (b"content-length", str(6 * 1_048_576).encode())]
        + (headers or []),
        "client": ("127.0.0.1", 50000), "server": ("127.0.0.1", 8000),
    }


@pytest.mark.parametrize(
    ("query", "headers"),
    [
        ("", None),
        ("client=host", None),
        ("client=host&t=wrong", None),
        ("client=host", [(b"authorization", b"Bearer wrong")]),
        ("client=external&t=wrong", None),
        ("client=external&t={external}", None),
        ("pane=p-gate", None),
        ("pane=p-gate&t=wrong", None),
        ("pane=p-unwired&t={pane}", None),
    ],
    ids=["none", "host-no-token", "host-wrong", "host-wrong-bearer", "external-wrong",
         "external-disabled", "pane-no-token", "pane-wrong", "pane-other-token"],
)
async def test_a_request_without_a_valid_credential_is_refused_before_its_body_is_read(
    monkeypatch: pytest.MonkeyPatch, clean_registry: Any, query: str, headers: list[tuple[bytes, bytes]] | None,
) -> None:
    """Review M2 on main 8b477cbcd: bodies have no size limit (A1), so the
    credential is checked first and an unauthenticated body is never read."""
    monkeypatch.setattr(plan_mcp_auth, "external_enabled", lambda: False)
    monkeypatch.setattr(plan_mcp_wiring, "_PANE_TOKENS", {})
    agent_messaging.register("p-gate", "gate", "/ws/project")
    query = query.format(external=plan_mcp_auth.external_token(), pane=plan_mcp_wiring.caller_token("p-gate"))

    async def receive() -> dict[str, Any]:
        raise AssertionError("the body of an unauthenticated request was read")

    sent: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    await plan_mcp.startup()
    try:
        await plan_mcp.asgi_app(_mcp_scope(query, headers), receive, send)
    finally:
        await plan_mcp.shutdown()
    assert sent[0]["type"] == "http.response.start" and sent[0]["status"] == 401
    assert b"".join(message.get("body", b"") for message in sent[1:])


async def test_every_credential_a_navide_cli_carries_still_reaches_the_tools(
    monkeypatch: pytest.MonkeyPatch, clean_registry: Any,
) -> None:
    """Review M2: the check before the body accepts exactly what the tool
    calls accept: the pane token in the query (claude, gemini-style config
    documents) or as a bearer header (codex, NAVIDE_MCP_TOKEN), the host
    token either way, and the external token while external access is on."""
    monkeypatch.setattr(plan_mcp_auth, "external_enabled", lambda: True)
    monkeypatch.setattr(plan_mcp_wiring, "_PANE_TOKENS", {})
    agent_messaging.register("p-gate", "gate", "/ws/project")
    pane_token = plan_mcp_wiring.caller_token("p-gate")
    unregistered_token = plan_mcp_wiring.caller_token("p-not-registered")
    cases = {
        "pane-query": (plan_mcp_wiring.plan_mcp_url(1, "p-gate").split("?", 1)[1], {}),
        "pane-bearer": (plan_mcp_wiring.plan_mcp_url(1, "p-gate", with_token=False).split("?", 1)[1],
                        {"authorization": f"Bearer {pane_token}"}),
        "host-query": (plan_mcp_wiring.plan_mcp_url(1).split("?", 1)[1], {}),
        "host-bearer": (plan_mcp_wiring.plan_mcp_url(1, with_token=False).split("?", 1)[1],
                        {"authorization": f"Bearer {plan_mcp_auth.internal_token()}"}),
        "external-query": (f"client=external&t={plan_mcp_auth.external_token()}", {}),
        "external-bearer": ("client=external", {"authorization": f"Bearer {plan_mcp_auth.external_token()}"}),
        # A valid token for a pane the registry does not know yet keeps its
        # tool-level explanation rather than a 401.
        "pane-unregistered": (f"pane=p-not-registered&t={unregistered_token}", {}),
    }
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
    await plan_mcp.startup()
    try:
        transport = httpx.ASGITransport(app=plan_mcp.asgi_app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test", timeout=30) as client:
            for name, (query, extra) in cases.items():
                headers = {"accept": "application/json, text/event-stream", "content-type": "application/json"} | extra
                response = await client.post(f"/?{query}", headers=headers, json=body)
                assert response.status_code == 200, (name, response.status_code, response.text[:200])
                assert response.json()["result"]["tools"], name
    finally:
        await plan_mcp.shutdown()


async def test_a_tool_call_over_the_mcp_endpoint_sees_its_request_body_size(workspace: Path) -> None:
    """The agent tool proxy skips its size walk for a small request (contract
    4.4, A2): the body size must reach the tool call made by that request."""
    from agent_team_backend.mcp_server import auth as plan_mcp_auth

    async def zz_body_size() -> int:
        seen = plan_mcp._request_body_bytes.get()  # noqa: SLF001
        return -1 if seen is None else seen[0]

    plan_mcp.server.tool()(zz_body_size)
    await plan_mcp.startup()
    try:
        url = f"/?client=host&t={plan_mcp_auth.internal_token()}"
        headers = {"accept": "application/json, text/event-stream", "content-type": "application/json"}
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "zz_body_size", "arguments": {}}})
        transport = httpx.ASGITransport(app=plan_mcp.asgi_app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test", timeout=30) as client:
            response = await client.post(url, headers=headers, content=body)
        assert response.status_code == 200, response.text[:300]
        result = response.json()["result"]
        assert result["isError"] is False
        assert json.loads(result["content"][0]["text"]) == len(body.encode())
    finally:
        await plan_mcp.shutdown()
        plan_mcp.server._tool_manager._tools.pop("zz_body_size", None)  # noqa: SLF001
