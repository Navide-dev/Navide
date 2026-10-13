"""preview_clear / cli_token_stats / memory_list / cli_close_agent: the second
round of tools an agent had no way to reach.

The first round was read-only inventory. These four close the gaps left around
it: the preview feed had three verbs and no way to empty it, the token panel's
numbers were readable only by the user looking at the panel, the instruction
files every CLI loads were invisible to the agents loading them, and closing a
pane had no tool of its own.

What these pin is what each one must not become: a clear that empties a feed
without telling the windows drawing it, a token answer larger than the question
it was asked in aid of, an instruction-file reader that will read any path it is
handed, and a close that reports success when no window took it.

mcp_list and prompt_list came later and complete the Settings pages' MCP
counterparts (Memory / Skills / MCP / Prompts): what they pin is that a managed
server row never reaches an agent unmasked, and that a prompt listing carries
names and not the prompt text.
"""

from __future__ import annotations

import copy
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend import app as backend_app
from agent_team_backend import native_mcp
from agent_team_backend import native_memory
from agent_team_backend.fs_service import FsError
from agent_team_backend.mcp_settings import MCPSettingsError
from agent_team_backend.plan_index import resolve_plan_root
from agent_team_backend.mcp_server import (
    server as plan_mcp,
    auth as plan_mcp_auth,
    wiring as plan_mcp_wiring,
)


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


def _ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _external_ctx() -> Any:
    plan_mcp_auth.set_external_enabled(True)
    params = {"client": "external", "t": plan_mcp_auth.external_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


@pytest.fixture
def events(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Record what would have gone out to every window."""
    sent: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any]) -> None:
        sent.append(event)

    monkeypatch.setattr(backend_app, "broadcast", fake_broadcast)
    return sent


# ── A. preview_clear ────────────────────────────────────────────────────────


class _FakePreviewLog:
    """Stands in for app.preview_log, whose clear() deletes from a real
    per-workspace database."""

    def __init__(self, removed: int) -> None:
        self._removed = removed
        self.calls: list[dict[str, Any]] = []

    def clear(self, workspace_path: str, *, before: int | None = None) -> int:
        self.calls.append({"workspace_path": workspace_path, "before": before})
        return self._removed


@pytest.fixture
def workspace(tmp_path: Path) -> str:
    """The workspace as the tools resolve it (resolve_plan_root normalises the
    symlinked temp root)."""
    return resolve_plan_root(str(tmp_path))


@pytest.mark.asyncio
async def test_clearing_the_feed_tells_every_window_drawing_it(
    monkeypatch: pytest.MonkeyPatch, events: list[dict[str, Any]], tmp_path: Path, workspace: str
) -> None:
    """The rows that just went are on screen in every window showing this
    workspace, and nothing else tells those windows they are gone. Deleting
    without announcing leaves the panel drawing records that no longer exist."""
    agent_messaging.register("pa", "caller", str(tmp_path))
    log = _FakePreviewLog(removed=7)
    monkeypatch.setattr(backend_app, "preview_log", log)

    result = await plan_mcp.preview_clear(_ctx())

    assert result["removed"] == 7
    assert result["workspace_path"] == workspace
    assert result["before"] == 0
    # before 0 means the whole feed, which the store spells as None.
    assert log.calls == [{"workspace_path": workspace, "before": None}]
    assert len(events) == 1
    assert events[0]["type"] == "preview.log_cleared"
    assert events[0]["payload"] == {
        "workspace_path": workspace,
        "before": None,
        "removed": 7,
    }


@pytest.mark.asyncio
async def test_a_before_timestamp_is_passed_through_so_newer_rows_survive(
    monkeypatch: pytest.MonkeyPatch, events: list[dict[str, Any]], tmp_path: Path, workspace: str
) -> None:
    """The cutoff is what makes clearing safe while other sessions record: what
    the caller has already read goes, what landed since stays."""
    agent_messaging.register("pa", "caller", str(tmp_path))
    log = _FakePreviewLog(removed=2)
    monkeypatch.setattr(backend_app, "preview_log", log)

    result = await plan_mcp.preview_clear(_ctx(), before=1_700_000_000_000)

    assert log.calls == [{"workspace_path": workspace, "before": 1_700_000_000_000}]
    assert result["before"] == 1_700_000_000_000
    assert events[0]["payload"]["before"] == 1_700_000_000_000


@pytest.mark.asyncio
async def test_an_empty_feed_announces_nothing(
    monkeypatch: pytest.MonkeyPatch, events: list[dict[str, Any]], tmp_path: Path
) -> None:
    """Boundary: nothing was removed, so there is nothing for a window to
    redraw. A broadcast here would be a wake-up with no news in it."""
    agent_messaging.register("pa", "caller", str(tmp_path))
    log = _FakePreviewLog(removed=0)
    monkeypatch.setattr(backend_app, "preview_log", log)

    result = await plan_mcp.preview_clear(_ctx())

    assert result["removed"] == 0
    assert len(log.calls) == 1
    assert events == []


@pytest.mark.asyncio
async def test_a_negative_cutoff_is_refused_before_anything_is_deleted(
    monkeypatch: pytest.MonkeyPatch, events: list[dict[str, Any]], tmp_path: Path
) -> None:
    """A negative timestamp is a caller mistake, and the store would read it as
    "delete everything" — the one outcome the caller was trying to avoid."""
    agent_messaging.register("pa", "caller", str(tmp_path))
    log = _FakePreviewLog(removed=99)
    monkeypatch.setattr(backend_app, "preview_log", log)

    with pytest.raises(FsError):
        await plan_mcp.preview_clear(_ctx(), before=-1)

    assert log.calls == []
    assert events == []


@pytest.mark.asyncio
async def test_a_caller_with_no_workspace_clears_nothing(
    monkeypatch: pytest.MonkeyPatch, events: list[dict[str, Any]]
) -> None:
    """An external caller has no "own workspace" to default to, so an omitted
    argument must fail rather than pick a project to empty."""
    log = _FakePreviewLog(removed=5)
    monkeypatch.setattr(backend_app, "preview_log", log)

    with pytest.raises(FsError):
        await plan_mcp.preview_clear(_external_ctx())

    assert log.calls == []
    assert events == []


# ── B. cli_token_stats ──────────────────────────────────────────────────────


class _FakeTokensStore:
    """Stands in for app.tokens_store, whose snapshot() deep-copies live
    aggregation state."""

    def __init__(self, snapshot: dict[str, Any]) -> None:
        self._snapshot = snapshot
        self.asked: list[str | None] = []

    def snapshot(self, workspace_path: str | None) -> dict[str, Any]:
        self.asked.append(workspace_path)
        return {**self._snapshot, "workspace_path": workspace_path or ""}


def _bucket(value: int) -> dict[str, int]:
    return {"input": value, "output": value * 2, "calls": 1}


_SNAPSHOT: dict[str, Any] = {
    "workspace": {
        "current_run": {"run_id": "r9", "task": "ship it", "totals": _bucket(10)},
        "runs": [
            {
                "run_id": f"r{index}",
                "task": f"task {index}",
                "started_at": "2026-01-01T00:00:00Z",
                "ended_at": "2026-01-01T01:00:00Z",
                "totals": _bucket(index),
                "by_vendor": {"claude": _bucket(index)},
                "by_stage": {"plan": _bucket(index)},
                "by_pane": {"pane-a": _bucket(index)},
            }
            for index in range(8)
        ],
        "cumulative": {
            "totals": _bucket(100),
            "by_vendor": {"claude": _bucket(60), "codex": _bucket(40)},
            "by_stage": {"build": _bucket(100)},
        },
        "live_by_session": {
            f"session-{index}": {"input": index, "output": index, "calls": 1}
            for index in range(12)
        },
    },
    "global": {
        "all_time": _bucket(999),
        "by_vendor": {"claude": _bucket(500)},
        "by_day": {f"2026-01-{day:02d}": _bucket(day) for day in range(1, 12)},
    },
}


@pytest.fixture
def tokens(monkeypatch: pytest.MonkeyPatch) -> _FakeTokensStore:
    store = _FakeTokensStore(_SNAPSHOT)
    monkeypatch.setattr(backend_app, "tokens_store", store)
    return store


@pytest.mark.asyncio
async def test_token_stats_returns_the_aggregates_whole(
    tokens: _FakeTokensStore, tmp_path: Path, workspace: str
) -> None:
    """The aggregates ARE the answer — trimming one of them would leave the
    caller reconstructing a total from a truncated list."""
    agent_messaging.register("pa", "caller", str(tmp_path))

    result = await plan_mcp.cli_token_stats(_ctx())

    assert tokens.asked == [workspace]
    assert result["workspace_path"] == workspace
    assert result["current_run"] == _SNAPSHOT["workspace"]["current_run"]
    assert result["cumulative"] == _SNAPSHOT["workspace"]["cumulative"]
    assert result["all_time"] == _SNAPSHOT["global"]["all_time"]
    assert result["by_vendor"] == _SNAPSHOT["global"]["by_vendor"]


@pytest.mark.asyncio
async def test_token_stats_trims_every_list_that_grows_without_bound(
    tokens: _FakeTokensStore, tmp_path: Path
) -> None:
    """Boundary: runs, live sessions and by_day all grow on their own. Handed
    back whole they would bury the aggregates in per-pane breakdowns."""
    agent_messaging.register("pa", "caller", str(tmp_path))

    result = await plan_mcp.cli_token_stats(_ctx())

    assert len(result["runs"]) == plan_mcp._TOKEN_RUNS_LIMIT
    assert result["runs_truncated"] is True
    # Newest kept, and only the run's own aggregate with it.
    assert result["runs"][-1]["run_id"] == "r7"
    assert set(result["runs"][-1]) == set(plan_mcp._TOKEN_RUN_FIELDS)
    assert "by_pane" not in result["runs"][-1]

    assert len(result["live_sessions"]) == plan_mcp._TOKEN_SESSIONS_LIMIT
    assert result["live_session_count"] == 12
    # Busiest first, so a trim drops the sessions that matter least.
    assert "session-11" in result["live_sessions"]
    assert "session-0" not in result["live_sessions"]

    assert len(result["by_day"]) == plan_mcp._TOKEN_DAYS_LIMIT
    assert "2026-01-11" in result["by_day"]
    assert "2026-01-01" not in result["by_day"]


@pytest.mark.asyncio
async def test_token_stats_of_a_workspace_that_has_spent_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Boundary: the empty state is an answer, not an error — a project with no
    run open and nothing recorded still reports zero."""
    agent_messaging.register("pa", "caller", str(tmp_path))
    empty = {
        "workspace": {"current_run": None, "runs": [], "cumulative": {}, "live_by_session": {}},
        "global": {},
    }
    monkeypatch.setattr(backend_app, "tokens_store", _FakeTokensStore(empty))

    result = await plan_mcp.cli_token_stats(_ctx())

    assert result["current_run"] is None
    assert result["runs"] == []
    assert result["runs_truncated"] is False
    assert result["live_sessions"] == {}
    assert result["live_session_count"] == 0
    assert result["by_day"] == {}


# ── C. memory_list ──────────────────────────────────────────────────────────


def _memory_file(path: Path, scope: str = "project", agent: str = "claude") -> Any:
    return native_memory.MemoryFile(
        scope,
        str(path),
        path.name,
        (agent,),
        True,
        exists=True,
        size=42,
        modified=1.0,
    )


class _FakeMemory:
    """Stands in for native_memory, which stats the real home directory."""

    def __init__(self, files: list[Any]) -> None:
        self.files = files
        self.scans: list[Any] = []
        self.reads: list[str] = []

    def scan(self, home: Any = None, workspace: Any = None) -> list[Any]:
        self.scans.append(workspace)
        return self.files

    def read(self, path: str, home: Any = None, workspace: Any = None) -> dict[str, Any]:
        self.reads.append(path)
        return {"path": path, "text": "# instructions", "exists": True, "modified": 1.0}

    def agent_targets(self) -> list[dict[str, Any]]:
        return [{"agent": "claude", "support": "mapped"}]


@pytest.fixture
def memory(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> _FakeMemory:
    fake = _FakeMemory(
        [
            _memory_file(tmp_path / "CLAUDE.md"),
            _memory_file(tmp_path / "AGENTS.md", agent="codex"),
        ]
    )
    monkeypatch.setattr(native_memory, "scan", fake.scan)
    monkeypatch.setattr(native_memory, "read", fake.read)
    monkeypatch.setattr(native_memory, "agent_targets", fake.agent_targets)
    return fake


@pytest.mark.asyncio
async def test_memory_list_returns_metadata_and_no_file_contents(
    memory: _FakeMemory, tmp_path: Path
) -> None:
    """A listing is for choosing what to read. Inlining the text would put
    several thousand words of standing instructions into an answer the caller
    asked for one line of."""
    agent_messaging.register("pa", "caller", str(tmp_path))

    result = await plan_mcp.memory_list(_ctx())

    assert result["workspace_path"] == str(tmp_path)
    assert memory.scans == [tmp_path]
    assert [entry["relative"] for entry in result["files"]] == ["CLAUDE.md", "AGENTS.md"]
    assert result["files"][0]["readers"] == ["claude"]
    assert result["files"][0]["size"] == 42
    assert all("text" not in entry for entry in result["files"])
    assert result["agents"] == [{"agent": "claude", "support": "mapped"}]
    assert memory.reads == []


@pytest.mark.asyncio
async def test_memory_list_reads_one_file_the_scan_listed(
    memory: _FakeMemory, tmp_path: Path
) -> None:
    agent_messaging.register("pa", "caller", str(tmp_path))
    target = str(tmp_path / "AGENTS.md")

    result = await plan_mcp.memory_list(_ctx(), path=target)

    assert memory.reads == [target]
    assert result["text"] == "# instructions"
    assert result["exists"] is True
    assert result["file"]["relative"] == "AGENTS.md"
    assert result["file"]["readers"] == ["codex"]
    assert "files" not in result


@pytest.mark.asyncio
async def test_memory_list_refuses_a_path_the_scan_did_not_list(
    memory: _FakeMemory, tmp_path: Path
) -> None:
    """The security boundary. Without it a tool whose whole promise is "the
    instruction files" would read any absolute path it was handed, which is a
    file-read bypass wearing an inventory tool's name. The refusal must happen
    before native_memory.read is reached, so it holds even if that table and
    this listing ever disagree.
    """
    agent_messaging.register("pa", "caller", str(tmp_path))
    secret = tmp_path / "secrets.env"
    secret.write_text("TOKEN=hunter2\n")

    with pytest.raises(FsError) as failure:
        await plan_mcp.memory_list(_ctx(), path=str(secret))

    assert "not a known instruction file" in str(failure.value)
    assert memory.reads == []

    # Neither does an absolute path outside the workspace altogether.
    with pytest.raises(FsError):
        await plan_mcp.memory_list(_ctx(), path="/etc/passwd")
    assert memory.reads == []


@pytest.mark.asyncio
async def test_memory_list_without_a_workspace_still_lists_user_scope(
    memory: _FakeMemory,
) -> None:
    """Boundary: a caller with no project has a home, and the files a vendor
    reads from it are the ones a listing is most useful for."""
    result = await plan_mcp.memory_list(_external_ctx())

    assert memory.scans == [None]
    assert result["workspace_path"] == ""
    assert len(result["files"]) == 2


# ── D. cli_close_agent ──────────────────────────────────────────────────────


def _seed() -> None:
    agent_messaging.register("pa", "caller", "/ws/alpha")
    agent_messaging.register("pw", "worker", "/ws/alpha", agent_key="codex")


def _fake_ui(monkeypatch: pytest.MonkeyPatch, reply: dict[str, Any]) -> list[dict[str, Any]]:
    """Answer every _ui_request with `reply`, recording the calls."""
    calls: list[dict[str, Any]] = []

    async def fake(workspace_path: str, op: str, **kwargs: Any) -> dict[str, Any]:
        calls.append({"workspace_path": workspace_path, "op": op, **kwargs})
        return reply

    monkeypatch.setattr(plan_mcp, "_ui_request", fake)
    return calls


@pytest.mark.asyncio
async def test_close_asks_the_window_holding_the_target_pane_to_close_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The one action that ends another agent's work, so it must be the close
    action and it must go to the window that has that pane — not a broadcast,
    and not the caller's own window."""
    _seed()
    calls = _fake_ui(monkeypatch, {"ok": True, "result": {}})

    result = await plan_mcp.cli_close_agent("worker", _ctx())

    assert result["ok"] is True
    assert result["closed"] is True
    assert result["target"] == "alpha/worker"
    assert result["name"] == "worker"
    assert len(calls) == 1
    assert calls[0]["workspace_path"] == "/ws/alpha"
    assert calls[0]["action"] == "ui.pane.close"
    assert calls[0]["args"] == {"paneId": "pw"}
    # Addressed at the target, not at the caller: _pane_caller("pw"), not "pa".
    assert calls[0]["caller"].pane_id == "pw"
    assert "advisories" not in result


@pytest.mark.asyncio
async def test_close_reports_what_the_window_says_it_cost(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A mid-turn pane, queued mail and orphaned children are knowable only
    before the kill. Dropping them makes the consequences silent."""
    _seed()
    _fake_ui(
        monkeypatch,
        {"ok": True, "result": {"advisories": ["worker was working", "2 messages queued"]}},
    )

    result = await plan_mcp.cli_close_agent("worker", _ctx())

    assert result["advisories"] == ["worker was working", "2 messages queued"]


@pytest.mark.asyncio
async def test_a_window_that_does_not_answer_is_not_reported_as_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Only the window can close a pane, so an unanswered request means the
    pane is still there — an ok here would have the caller believe it cleaned
    up something that is still running."""
    _seed()
    _fake_ui(
        monkeypatch,
        {"ok": False, "result": None, "error": "timed out", "error_code": "ui_action_timeout"},
    )

    result = await plan_mcp.cli_close_agent("worker", _ctx())

    assert result["ok"] is False
    assert result["error_code"] == "ui_action_timeout"
    assert "timed out" in result["error"]
    assert "closed" not in result


@pytest.mark.asyncio
async def test_close_resolves_targets_exactly_as_cli_interrupt_does(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Addressing is shared, not reimplemented: an id beats a name, an
    ambiguous name is refused, and both tools answer the same way — otherwise
    an address that works for one silently means something else to the other.
    """
    agent_messaging.register("pa", "caller", "/ws/alpha")
    agent_messaging.register("pw1", "worker", "/ws/alpha")
    agent_messaging.register("pw2", "worker", "/ws/alpha")
    calls = _fake_ui(monkeypatch, {"ok": True, "result": {}})

    closed = await plan_mcp.cli_close_agent("worker", _ctx())
    interrupted = await plan_mcp.cli_interrupt("worker", _ctx())
    assert closed["ok"] is False
    assert closed["error_code"] == interrupted["error_code"] == "ambiguous-target"

    exact = await plan_mcp.cli_close_agent("", _ctx(), pane_id="pw2")
    assert exact["ok"] is True
    assert calls[-1]["args"] == {"paneId": "pw2"}


@pytest.mark.asyncio
async def test_an_unknown_pane_id_is_refused_before_any_window_is_asked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Boundary: a bad id must never reach a window, where it would be one
    typo away from closing the wrong pane."""
    _seed()
    calls = _fake_ui(monkeypatch, {"ok": True, "result": {}})

    result = await plan_mcp.cli_close_agent("", _ctx(), pane_id="nope")

    assert result["ok"] is False
    assert result["error_code"] == "unknown-pane-id"
    assert calls == []


@pytest.mark.asyncio
async def test_a_pane_cannot_close_itself(monkeypatch: pytest.MonkeyPatch) -> None:
    """Closing yourself takes away the turn making the call, so the caller
    could never read the answer — the same reason cli_interrupt refuses."""
    _seed()
    calls = _fake_ui(monkeypatch, {"ok": True, "result": {}})

    result = await plan_mcp.cli_close_agent("caller", _ctx())

    assert result["ok"] is False
    assert result["error_code"] == "self-close"
    assert "own pane" in result["error"]
    assert calls == []


_DEVICE_UUID = "3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071"


@pytest.mark.asyncio
async def test_a_pane_on_another_device_says_so_instead_of_blaming_the_address(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Closing is an action taken by the owning window and there is no relay
    for it, exactly as for an interrupt. The local resolver's error would send
    the caller to re-check an address that may be perfectly good."""
    _seed()
    calls = _fake_ui(monkeypatch, {"ok": True, "result": {}})

    result = await plan_mcp.cli_close_agent(f"{_DEVICE_UUID}/alpha/worker", _ctx())

    assert result["ok"] is False
    assert result["error_code"] == "close-local-only"
    assert "another device" in result["error"]
    assert "cli_send" in result["error"]
    assert calls == []


@pytest.mark.asyncio
async def test_a_mistyped_workspace_is_still_reported_as_a_mistyped_workspace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The remote re-read only ever ADDS an answer — calling a typo
    "close-local-only" would hide it, same as in cli_interrupt."""
    _seed()
    _fake_ui(monkeypatch, {"ok": True, "result": {}})

    result = await plan_mcp.cli_close_agent("typo/worker", _ctx())

    assert result["ok"] is False
    assert result["error_code"] == "unknown-workspace"


@pytest.mark.asyncio
async def test_the_close_description_warns_that_it_ends_the_other_agents_work() -> None:
    """The docstring IS the contract an agent reads before calling. A close
    that reads like a tidy-up invites an agent to end somebody's turn."""
    tools = {tool.name: tool for tool in await plan_mcp.server.list_tools()}
    text = (tools["cli_close_agent"].description or "").lower()
    assert "cli_get_status" in text
    assert "cannot be undone" in text
    assert "cli_interrupt" in text


# ── E. mcp_list ─────────────────────────────────────────────────────────────


_STDIO_ROW = {
    "name": "ctx",
    "enabled": True,
    "transport": "stdio",
    "command": "npx",
    "args": ["--api-key=abc", "https://h/?token=t"],
    "env": {"API_KEY": "sk-1", "MODE": "fast"},
}
_HTTP_ROW = {
    "name": "remote",
    "enabled": False,
    "transport": "http",
    "url": "https://u:p@host/?api_key=x",
    "headers": {"Authorization": "Bearer y", "Accept": "json"},
}


class _FakeMcpSettingsStore:
    """Stands in for app.mcp_settings_store, which reads the real settings
    file. Rows come back unmasked, exactly as the real store hands them out."""

    path = Path("/nonexistent/mcp.json")

    def __init__(self, rows: list[dict[str, Any]] | None = None, error: str = "") -> None:
        self._rows = rows or []
        self._error = error

    def list_servers(self) -> list[dict[str, Any]]:
        if self._error:
            raise MCPSettingsError(self._error)
        return copy.deepcopy(self._rows)


class _FakeMcpManager:
    def __init__(self, live: list[dict[str, Any]]) -> None:
        self._live = live

    async def list_status(self) -> list[dict[str, Any]]:
        return self._live


def _native_row() -> Any:
    return native_mcp.NativeMcpServer(
        name="own",
        agent="claude",
        transport="stdio",
        path="/home/u/.claude.json",
        command="uvx",
        args=("--token", native_mcp.REDACTED_SECRET),
    )


@pytest.fixture
def mcp_sources(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        backend_app, "mcp_settings_store", _FakeMcpSettingsStore([_STDIO_ROW, _HTTP_ROW])
    )
    monkeypatch.setattr(
        backend_app,
        "mcp_manager",
        _FakeMcpManager(
            [{"name": "ctx", "status": "connected", "tool_count": 3, "tools": ["a", "b", "c"]}]
        ),
    )
    monkeypatch.setattr(native_mcp, "scan", lambda home=None: [_native_row()])
    monkeypatch.setattr(
        native_mcp,
        "agent_targets",
        lambda: [{"key": "claude", "label": "Claude", "state": "wired", "reflects": True}],
    )


@pytest.mark.asyncio
async def test_mcp_list_masks_every_secret_the_settings_store_hands_out(
    mcp_sources: None,
) -> None:
    """The store's rows are unmasked because the Settings page round-trips
    them. An agent must never see the raw values — in env, in headers, inside
    an argument, or inside a URL."""
    agent_messaging.register("pa", "caller", "/ws")

    result = await plan_mcp.mcp_list(_ctx())

    by_name = {row["name"]: row for row in result["servers"]}
    stdio = by_name["ctx"]
    assert stdio["env"] == {"API_KEY": "***", "MODE": "fast"}
    assert stdio["args"] == ["--api-key=***", "https://h/?token=***"]
    assert stdio["command"] == "npx"
    http = by_name["remote"]
    assert http["url"] == "https://***@host/?api_key=***"
    assert http["headers"] == {"Authorization": "***", "Accept": "json"}
    flat = str(result)
    for secret in ("sk-1", "abc", "token=t", "u:p@", "api_key=x", "Bearer y"):
        assert secret not in flat


@pytest.mark.asyncio
async def test_mcp_list_merges_live_status_and_keeps_the_answer_a_summary(
    mcp_sources: None,
) -> None:
    agent_messaging.register("pa", "caller", "/ws")

    result = await plan_mcp.mcp_list(_ctx())

    by_name = {row["name"]: row for row in result["servers"]}
    assert by_name["ctx"]["status"] == "connected"
    assert by_name["ctx"]["tool_count"] == 3
    # A disabled server is "disabled" whatever the manager says about it.
    assert by_name["remote"]["status"] == "disabled"
    assert by_name["remote"]["tool_count"] == 0
    # The tool list is what makes the WS payload large; the summary leaves it out.
    assert all("tools" not in row for row in result["servers"])
    # The settings file's location is for the Settings page, not for an agent.
    assert "path" not in result
    assert set(result) == {"servers", "native", "agents"}
    assert result["native"][0]["name"] == "own"
    assert result["native"][0]["agent"] == "claude"
    assert result["agents"][0]["key"] == "claude"


@pytest.mark.asyncio
async def test_mcp_list_answers_an_unreadable_settings_file_with_ok_false(
    mcp_sources: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        backend_app, "mcp_settings_store", _FakeMcpSettingsStore(error="invalid JSON at line 3")
    )
    agent_messaging.register("pa", "caller", "/ws")

    result = await plan_mcp.mcp_list(_ctx())

    assert result == {"ok": False, "error": "invalid JSON at line 3"}


# ── F. prompt_list ──────────────────────────────────────────────────────────


_PROMPT_SKILLS = [
    {
        "id": "advance",
        "name": "Advance",
        "icon": "play",
        "description": "Keep going",
        "prompt": "Continue with the next step.",
        "resumePrompt": "Resume where you left off.",
        "maxTurns": 5,
        "category": "flow",
        "enabled": True,
        "isDefault": False,
    },
    {
        "id": "review",
        "name": "Review",
        "icon": "eye",
        "description": "Review the diff",
        "prompt": "Review the current diff for bugs.",
        "resumePrompt": "",
        "maxTurns": 1,
        "category": "quality",
        "enabled": True,
        "isDefault": True,
    },
]


class _FakeUiSettingsStore:
    def __init__(self, doc: dict[str, Any]) -> None:
        self._doc = doc

    def get(self) -> dict[str, Any]:
        return self._doc


@pytest.mark.asyncio
async def test_prompt_list_returns_metadata_and_no_prompt_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        backend_app, "ui_settings_store", _FakeUiSettingsStore({"prompt-skills": _PROMPT_SKILLS})
    )
    agent_messaging.register("pa", "caller", "/ws")

    result = await plan_mcp.prompt_list(_ctx())

    assert [row["id"] for row in result["skills"]] == ["advance", "review"]
    assert result["skills"][0] == {
        "id": "advance",
        "name": "Advance",
        "icon": "play",
        "description": "Keep going",
        "category": "flow",
        "enabled": True,
        "isDefault": False,
        "maxTurns": 5,
    }
    assert all("prompt" not in row and "resumePrompt" not in row for row in result["skills"])
    assert result["default_id"] == "review"
    assert "note" not in result


@pytest.mark.asyncio
async def test_prompt_list_reads_one_skill_in_full(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        backend_app, "ui_settings_store", _FakeUiSettingsStore({"prompt-skills": _PROMPT_SKILLS})
    )
    agent_messaging.register("pa", "caller", "/ws")

    result = await plan_mcp.prompt_list(_ctx(), id="advance")

    assert result == {"skill": _PROMPT_SKILLS[0]}
    assert result["skill"]["prompt"] == "Continue with the next step."
    assert result["skill"]["resumePrompt"] == "Resume where you left off."


@pytest.mark.asyncio
async def test_prompt_list_refuses_an_unknown_id(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        backend_app, "ui_settings_store", _FakeUiSettingsStore({"prompt-skills": _PROMPT_SKILLS})
    )
    agent_messaging.register("pa", "caller", "/ws")

    result = await plan_mcp.prompt_list(_ctx(), id="nope")

    assert result["ok"] is False
    assert "nope" in result["error"]


@pytest.mark.asyncio
async def test_prompt_list_when_nothing_was_ever_saved(monkeypatch: pytest.MonkeyPatch) -> None:
    """Boundary: the key is absent until the user first saves; the builtin
    skill the app starts with is read from the seed both halves share."""
    monkeypatch.setattr(backend_app, "ui_settings_store", _FakeUiSettingsStore({"other": 1}))
    agent_messaging.register("pa", "caller", "/ws")

    result = await plan_mcp.prompt_list(_ctx())

    assert [s["id"] for s in result["skills"]] == ["advance"]
    assert result["default_id"] == "advance"
    assert result["note"] == "no prompt skills saved yet; this is the builtin skill the app starts with"
    assert (await plan_mcp.prompt_list(_ctx(), id="advance"))["skill"]["prompt"]


@pytest.mark.asyncio
async def test_prompt_list_skips_rows_that_are_not_objects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        backend_app,
        "ui_settings_store",
        _FakeUiSettingsStore({"prompt-skills": ["junk", None, _PROMPT_SKILLS[1]]}),
    )
    agent_messaging.register("pa", "caller", "/ws")

    result = await plan_mcp.prompt_list(_ctx())

    assert [row["id"] for row in result["skills"]] == ["review"]
    assert "note" not in result


# ── G. registration ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_round_two_tools_are_registered_with_their_declared_arguments() -> None:
    tools = {tool.name: tool for tool in await plan_mcp.server.list_tools()}
    assert set(tools) >= {
        "preview_clear",
        "cli_token_stats",
        "memory_list",
        "cli_close_agent",
        "cli_reclaim_agent",
        "mcp_list",
        "prompt_list",
    }
    # The Context parameter is injected, never asked of the agent.
    assert set(tools["preview_clear"].inputSchema.get("properties") or {}) == {
        "workspace_path",
        "before",
    }
    assert set(tools["cli_token_stats"].inputSchema.get("properties") or {}) == {
        "workspace_path"
    }
    assert set(tools["memory_list"].inputSchema.get("properties") or {}) == {
        "workspace_path",
        "path",
    }
    assert set(tools["cli_close_agent"].inputSchema.get("properties") or {}) == {
        "target",
        "pane_id",
    }
    assert set(tools["cli_reclaim_agent"].inputSchema.get("properties") or {}) == {
        "target",
        "pane_id",
    }
    assert set(tools["mcp_list"].inputSchema.get("properties") or {}) == set()
    assert set(tools["prompt_list"].inputSchema.get("properties") or {}) == {"id"}
