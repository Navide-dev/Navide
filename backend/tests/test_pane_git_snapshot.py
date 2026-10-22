"""pane_git_snapshot and its per-worktree cache, plus the `git` key it adds to
cli_list_targets / cli_get_status and the network snapshot.

The snapshot tests drive a real `git` in tmp_path repos; the cache tests use a
fake compute and clock so they can count exactly how often git would run.
"""
from __future__ import annotations

import asyncio
import ntpath
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, git_service, osplat
from agent_team_backend import app as app_module
from agent_team_backend import ws_handlers
from agent_team_backend.mcp_server import server as plan_mcp
from agent_team_backend.mcp_server import wiring as plan_mcp_wiring

needs_git = pytest.mark.skipif(
    osplat.paths.resolve_program("git") is None,
    reason="git is not resolvable through osplat.paths on this host",
)

SNAPSHOT_KEYS = {
    "branch", "worktreeRoot", "isLinkedWorktree", "dirty", "ahead", "behind", "fetchedAt",
}


# ── helpers ────────────────────────────────────────────────────────────────────

def _git(path: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=path, check=True, capture_output=True, text=True
    ).stdout.strip()


def _init_repo(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    _git(path, "init", "-b", "main")
    _git(path, "config", "user.email", "test@test.com")
    _git(path, "config", "user.name", "Test")
    (path / "README.md").write_text("# test")
    _git(path, "add", "-A")
    _git(path, "commit", "-m", "init")


def _commit(path: Path, name: str) -> None:
    (path / name).write_text(name)
    _git(path, "add", name)
    _git(path, "commit", "-m", name)


def _real(path: Path | str) -> str:
    return os.path.realpath(str(path))


# ── pane_git_snapshot ──────────────────────────────────────────────────────────

@needs_git
class TestPaneGitSnapshot:
    @pytest.mark.asyncio
    async def test_clean_repo(self, tmp_path: Path) -> None:
        _init_repo(tmp_path)
        snap = await git_service.pane_git_snapshot(str(tmp_path))

        assert set(snap) == SNAPSHOT_KEYS
        assert snap["branch"] == "main"
        assert _real(snap["worktreeRoot"]) == _real(tmp_path)
        assert snap["isLinkedWorktree"] is False
        assert snap["dirty"] == 0
        # No origin/main and never fetched: those stay unknown, not zero.
        assert snap["ahead"] is None and snap["behind"] is None
        assert snap["fetchedAt"] is None

    @pytest.mark.asyncio
    async def test_dirty_counts_porcelain_lines(self, tmp_path: Path) -> None:
        _init_repo(tmp_path)
        (tmp_path / "README.md").write_text("changed")
        (tmp_path / "new.txt").write_text("untracked")
        snap = await git_service.pane_git_snapshot(str(tmp_path))
        assert snap["dirty"] == 2

    @pytest.mark.asyncio
    async def test_dirty_saturates_on_a_huge_tree(self, tmp_path: Path, monkeypatch) -> None:
        # #144's shape: the whole porcelain output was read and split on the loop.
        monkeypatch.setattr(git_service, "_SNAPSHOT_DIRTY_LIMIT", 20, raising=False)
        _init_repo(tmp_path)
        for i in range(30):
            (tmp_path / f"f{i:02d}").write_text("")
        snap = await git_service.pane_git_snapshot(str(tmp_path))
        assert snap["dirty"] == 20

    @pytest.mark.asyncio
    async def test_dirty_byte_cap_stops_the_read(self, tmp_path: Path, monkeypatch) -> None:
        monkeypatch.setattr(git_service, "_SNAPSHOT_STATUS_MAX_BYTES", 100, raising=False)
        monkeypatch.setattr(git_service, "_SNAPSHOT_DIRTY_LIMIT", 10_000, raising=False)
        _init_repo(tmp_path)
        for i in range(100):
            (tmp_path / f"untracked_file_{i:03d}.txt").write_text("")
        snap = await git_service.pane_git_snapshot(str(tmp_path))
        assert snap["dirty"] == 10_000  # "at least this many", not a partial count

    @pytest.mark.asyncio
    async def test_subdirectory_reports_the_worktree_root(self, tmp_path: Path) -> None:
        _init_repo(tmp_path)
        sub = tmp_path / "pkg" / "deep"
        sub.mkdir(parents=True)
        snap = await git_service.pane_git_snapshot(str(sub))
        assert _real(snap["worktreeRoot"]) == _real(tmp_path)

    @pytest.mark.asyncio
    async def test_detached_head_reports_short_sha(self, tmp_path: Path) -> None:
        _init_repo(tmp_path)
        _commit(tmp_path, "second.txt")
        first = _git(tmp_path, "rev-parse", "HEAD~1")
        _git(tmp_path, "checkout", "--detach", first)
        snap = await git_service.pane_git_snapshot(str(tmp_path))
        assert snap["branch"] == _git(tmp_path, "rev-parse", "--short", "HEAD")

    @pytest.mark.asyncio
    async def test_linked_worktree(self, tmp_path: Path) -> None:
        main = tmp_path / "main"
        _init_repo(main)
        linked = tmp_path / "linked"
        _git(main, "worktree", "add", "-b", "feature", str(linked))

        main_snap = await git_service.pane_git_snapshot(str(main))
        linked_snap = await git_service.pane_git_snapshot(str(linked))

        assert main_snap["isLinkedWorktree"] is False
        assert linked_snap["isLinkedWorktree"] is True
        assert linked_snap["branch"] == "feature"
        assert _real(linked_snap["worktreeRoot"]) == _real(linked)

    @pytest.mark.asyncio
    async def test_ahead_behind_against_origin_main(self, tmp_path: Path) -> None:
        _init_repo(tmp_path)
        _commit(tmp_path, "base.txt")
        base = _git(tmp_path, "rev-parse", "HEAD")
        _commit(tmp_path, "upstream-only.txt")
        _git(tmp_path, "update-ref", "refs/remotes/origin/main", "HEAD")
        _git(tmp_path, "reset", "--hard", base)
        _commit(tmp_path, "local-1.txt")
        _commit(tmp_path, "local-2.txt")

        snap = await git_service.pane_git_snapshot(str(tmp_path))
        assert (snap["ahead"], snap["behind"]) == (2, 1)

    @pytest.mark.asyncio
    async def test_fetched_at_is_fetch_head_mtime(self, tmp_path: Path) -> None:
        _init_repo(tmp_path)
        fetch_head = tmp_path / ".git" / "FETCH_HEAD"
        fetch_head.write_text("")
        os.utime(fetch_head, (1_790_000_000, 1_790_000_000))
        snap = await git_service.pane_git_snapshot(str(tmp_path))
        assert snap["fetchedAt"] == "2026-09-21T14:13:20Z"

    @pytest.mark.asyncio
    async def test_linked_worktree_reads_the_shared_fetch_head(self, tmp_path: Path) -> None:
        main = tmp_path / "main"
        _init_repo(main)
        (main / ".git" / "FETCH_HEAD").write_text("")
        linked = tmp_path / "linked"
        _git(main, "worktree", "add", "-b", "feature", str(linked))
        snap = await git_service.pane_git_snapshot(str(linked))
        assert snap["fetchedAt"] is not None

    @pytest.mark.asyncio
    async def test_a_fetch_run_in_any_worktree_counts(self, tmp_path: Path) -> None:
        # FETCH_HEAD is a per-worktree pseudo-ref: a fetch run inside a linked
        # worktree writes .git/worktrees/<name>/FETCH_HEAD, never .git/FETCH_HEAD,
        # while the origin/main it refreshed is shared by every worktree.
        upstream = tmp_path / "upstream"
        _init_repo(upstream)
        main = tmp_path / "main"
        _git(tmp_path, "clone", "-q", str(upstream), str(main))
        linked = tmp_path / "linked"
        _git(main, "worktree", "add", "-b", "feature", str(linked))
        _git(linked, "fetch", "-q", "origin")
        assert not (main / ".git" / "FETCH_HEAD").exists()

        linked_head = Path(_git(linked, "rev-parse", "--absolute-git-dir")) / "FETCH_HEAD"
        os.utime(linked_head, (1_790_000_000, 1_790_000_000))
        for path in (linked, main):
            snap = await git_service.pane_git_snapshot(str(path))
            assert snap["fetchedAt"] == "2026-09-21T14:13:20Z"

        # The most recent fetch wins, wherever it ran.
        main_head = main / ".git" / "FETCH_HEAD"
        main_head.write_text("")
        os.utime(main_head, (1_790_003_600, 1_790_003_600))
        snap = await git_service.pane_git_snapshot(str(linked))
        assert snap["fetchedAt"] == "2026-09-21T15:13:20Z"

    @pytest.mark.asyncio
    async def test_panes_in_different_folders_of_one_checkout_share_the_work(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        # A cold cache cannot know two folders share a checkout until git says
        # so, but only that one rev-parse may be per pane — not the whole snapshot.
        _init_repo(tmp_path)
        folders = [tmp_path / f"dir{i}" for i in range(10)]
        for folder in folders:
            folder.mkdir()
        calls: list[list[str]] = []
        real = git_service.run_allowlisted_text

        async def counting(args, cwd, **kwargs):
            calls.append(list(args))
            return await real(args, cwd, **kwargs)

        monkeypatch.setattr(git_service, "run_allowlisted_text", counting)
        cache = git_service.PaneGitSnapshots()
        snaps = await asyncio.gather(*(cache.get(str(folder)) for folder in folders))

        assert {_real(snap["worktreeRoot"]) for snap in snaps} == {_real(tmp_path)}
        status_calls = [args for args in calls if "status" in args]
        assert len(status_calls) < len(folders)

    @pytest.mark.asyncio
    async def test_non_repository_is_all_none(self, tmp_path: Path) -> None:
        snap = await git_service.pane_git_snapshot(str(tmp_path))
        assert snap == {key: None for key in SNAPSHOT_KEYS}

    @pytest.mark.asyncio
    async def test_missing_path_and_empty_path_never_raise(self, tmp_path: Path) -> None:
        for path in ("", str(tmp_path / "does-not-exist")):
            assert (await git_service.pane_git_snapshot(path))["worktreeRoot"] is None

    @pytest.mark.asyncio
    async def test_cloud_synced_path_spawns_no_git(self, monkeypatch) -> None:
        calls: list[list[str]] = []

        async def spy(args, cwd):
            calls.append(args)
            return 0, ""

        monkeypatch.setattr(git_service, "_run_snapshot_git", spy)
        path = "/Users/x/Library/CloudStorage/GoogleDrive-x/My Drive/repo"
        snap = await git_service.pane_git_snapshot(path)
        assert snap["worktreeRoot"] is None
        assert calls == []


# ── PaneGitSnapshots cache ─────────────────────────────────────────────────────

class _FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def _fake_compute(roots: dict[str, str | None], calls: list[str], delay: float = 0.0):
    async def compute(path: str) -> dict[str, Any]:
        calls.append(path)
        if delay:
            await asyncio.sleep(delay)
        snap = git_service._empty_pane_git_snapshot()
        root = roots.get(path)
        if root:
            snap.update(worktreeRoot=root, branch=f"b{len(calls)}", dirty=0)
        return snap

    return compute


class TestPaneGitSnapshotsCache:
    @pytest.mark.asyncio
    async def test_panes_in_one_worktree_share_one_computation(self) -> None:
        calls: list[str] = []
        cache = git_service.PaneGitSnapshots(
            compute=_fake_compute({"/r": "/r", "/r/sub": "/r"}, calls, delay=0.01),
            clock=_FakeClock(),
        )
        # Many panes asking at once about the same folder: one git run.
        results = await asyncio.gather(*(cache.get("/r") for _ in range(20)))
        assert calls == ["/r"]
        assert {r["branch"] for r in results} == {"b1"}
        # A second path in the same root first resolves once, then shares.
        await cache.get("/r/sub")
        await cache.get("/r/sub")
        await cache.get("/r")
        assert calls == ["/r", "/r/sub"]

    @pytest.mark.asyncio
    async def test_recomputes_after_ttl(self) -> None:
        calls: list[str] = []
        clock = _FakeClock()
        cache = git_service.PaneGitSnapshots(
            ttl_s=30.0, compute=_fake_compute({"/r": "/r"}, calls), clock=clock
        )
        await cache.get("/r")
        clock.now += 29.0
        await cache.get("/r")
        assert len(calls) == 1
        clock.now += 1.0
        await cache.get("/r")
        assert len(calls) == 2

    @pytest.mark.asyncio
    async def test_invalidate_under_or_above_the_root(self) -> None:
        calls: list[str] = []
        cache = git_service.PaneGitSnapshots(
            compute=_fake_compute({"/w/repo": "/w/repo"}, calls), clock=_FakeClock()
        )
        await cache.get("/w/repo")
        cache.invalidate("/w/other")  # unrelated: kept
        await cache.get("/w/repo")
        assert len(calls) == 1
        cache.invalidate("/w")  # a folder holding the repo
        await cache.get("/w/repo")
        assert len(calls) == 2
        cache.invalidate("/w/repo/src")  # a folder inside it
        await cache.get("/w/repo")
        assert len(calls) == 3

    @pytest.mark.asyncio
    async def test_invalidate_matches_windows_spellings(self, monkeypatch) -> None:
        """Git for Windows reports ``C:/Work/repo``; the watcher reports the
        workspace as opened, e.g. ``c:\\work``. NTFS paths compare
        case-insensitively and either separator names the same folder."""
        monkeypatch.setattr(git_service, "os", SimpleNamespace(path=ntpath, sep="\\"))
        calls: list[str] = []
        cache = git_service.PaneGitSnapshots(
            compute=_fake_compute({"C:\\Work\\repo": "C:/Work/repo"}, calls),
            clock=_FakeClock(),
        )
        await cache.get("C:\\Work\\repo")
        cache.invalidate("C:\\Work\\other")  # unrelated: kept
        await cache.get("C:\\Work\\repo")
        assert len(calls) == 1
        cache.invalidate("c:\\work")  # a folder holding the repo
        await cache.get("C:\\Work\\repo")
        assert len(calls) == 2
        cache.invalidate("C:\\Work\\Repo\\src")  # a folder inside it
        await cache.get("C:\\Work\\repo")
        assert len(calls) == 3

    @pytest.mark.asyncio
    async def test_change_during_a_computation_leaves_the_result_stale(self) -> None:
        calls: list[str] = []
        cache = git_service.PaneGitSnapshots(
            compute=_fake_compute({"/r": "/r"}, calls, delay=0.02), clock=_FakeClock()
        )
        pending = asyncio.ensure_future(cache.get("/r"))
        await asyncio.sleep(0.005)
        cache.invalidate("/r")
        await pending
        await cache.get("/r")
        assert len(calls) == 2

    @pytest.mark.asyncio
    async def test_a_change_elsewhere_keeps_a_running_computation_fresh(self) -> None:
        """Agents editing one workspace kept invalidating; a global staleness
        flag then threw away every other repo's snapshot in flight, so each poll
        re-ran git for all of them. Only an overlapping change makes it stale."""
        calls: list[str] = []
        cache = git_service.PaneGitSnapshots(
            compute=_fake_compute({"/r": "/r", "/s": "/s"}, calls, delay=0.02), clock=_FakeClock()
        )
        pending = asyncio.gather(cache.get("/r"), cache.get("/s"))
        await asyncio.sleep(0.005)
        cache.invalidate("/other-workspace")
        cache.invalidate("/s/src")
        await pending
        await cache.get("/r")
        await cache.get("/s")
        assert calls == ["/r", "/s", "/s"]

    @pytest.mark.asyncio
    async def test_non_repository_is_cached_until_invalidated(self) -> None:
        calls: list[str] = []
        roots: dict[str, str | None] = {}
        cache = git_service.PaneGitSnapshots(
            compute=_fake_compute(roots, calls), clock=_FakeClock()
        )
        assert (await cache.get("/plain"))["worktreeRoot"] is None
        await cache.get("/plain")
        assert len(calls) == 1
        roots["/plain"] = "/plain"  # `git init` happened
        cache.invalidate("/plain")
        assert (await cache.get("/plain"))["worktreeRoot"] == "/plain"

    @pytest.mark.asyncio
    async def test_a_failing_computation_yields_empty_not_an_error(self) -> None:
        async def boom(path: str) -> dict[str, Any]:
            raise RuntimeError("git exploded")

        cache = git_service.PaneGitSnapshots(compute=boom, clock=_FakeClock())
        assert (await cache.get("/r"))["worktreeRoot"] is None

    @pytest.mark.asyncio
    async def test_callers_get_copies(self) -> None:
        cache = git_service.PaneGitSnapshots(
            compute=_fake_compute({"/r": "/r"}, []), clock=_FakeClock()
        )
        first = await cache.get("/r")
        first["branch"] = "mutated"
        assert (await cache.get("/r"))["branch"] == "b1"

    @pytest.mark.asyncio
    async def test_a_caller_timing_out_does_not_cancel_the_shared_computation(self) -> None:
        calls: list[str] = []
        cache = git_service.PaneGitSnapshots(
            compute=_fake_compute({"/r": "/r"}, calls, delay=0.05), clock=_FakeClock()
        )
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(cache.get("/r"), 0.01)
        assert (await cache.get("/r"))["worktreeRoot"] == "/r"
        assert calls == ["/r"]


@pytest.mark.asyncio
async def test_git_watcher_change_invalidates_the_cache(monkeypatch) -> None:
    seen: list[str] = []
    monkeypatch.setattr(git_service.pane_git_snapshots, "invalidate", seen.append)

    async def no_broadcast(event: Any) -> None:
        return None

    monkeypatch.setattr(app_module, "broadcast", no_broadcast)
    await app_module._broadcast_git_changed("/ws/repo", [])
    assert seen == ["/ws/repo"]


# ── MCP: cli_list_targets / cli_get_status ─────────────────────────────────────

@pytest.fixture
def fresh_cache(monkeypatch) -> git_service.PaneGitSnapshots:
    cache = git_service.PaneGitSnapshots()
    monkeypatch.setattr(git_service, "pane_git_snapshots", cache)
    return cache


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


def _ctx(pane_id: str = "me") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _fake_terminals(monkeypatch, cwd_by_pane: dict[str, str]) -> None:
    sessions = {
        f"t-{pane}": SimpleNamespace(pane_id=pane, cwd=cwd, closed=False)
        for pane, cwd in cwd_by_pane.items()
    }
    monkeypatch.setattr(app_module, "_TERMINALS", SimpleNamespace(_sessions=sessions))


@needs_git
@pytest.mark.asyncio
async def test_list_targets_reports_each_panes_own_worktree(
    tmp_path: Path, monkeypatch, fresh_cache
) -> None:
    main = tmp_path / "main"
    _init_repo(main)
    linked = tmp_path / "linked"
    _git(main, "worktree", "add", "-b", "feature", str(linked))
    plain = tmp_path / "plain"
    plain.mkdir()

    agent_messaging.register("me", "caller", str(main), agent_key="claude")
    agent_messaging.register("p-main", "on-main", str(main), agent_key="claude")
    # Same workspace, but its CLI runs in the linked worktree.
    agent_messaging.register("p-wt", "on-worktree", str(main), agent_key="claude")
    agent_messaging.register("p-plain", "no-repo", str(plain), agent_key="claude")
    _fake_terminals(monkeypatch, {"p-wt": str(linked)})

    result = await plan_mcp.cli_list_targets(_ctx())
    by_name = {t["name"]: t for t in result["targets"]}

    assert by_name["on-main"]["git"]["branch"] == "main"
    assert by_name["on-main"]["git"]["isLinkedWorktree"] is False
    assert by_name["on-worktree"]["git"]["branch"] == "feature"
    assert by_name["on-worktree"]["git"]["isLinkedWorktree"] is True
    assert _real(by_name["on-worktree"]["git"]["worktreeRoot"]) == _real(linked)
    # Outside a repository the key is absent, not null.
    assert "git" not in by_name["no-repo"]
    # Additive: every field the roster carried before is still there.
    for target in result["targets"]:
        assert {
            "name", "address", "pane_id", "workspace_path", "same_workspace",
            "busy", "offline", "realized",
        } <= set(target)


@needs_git
@pytest.mark.asyncio
async def test_dirty_edit_shows_up_after_invalidation(tmp_path: Path, fresh_cache) -> None:
    _init_repo(tmp_path)
    agent_messaging.register("me", "caller", str(tmp_path), agent_key="claude")
    agent_messaging.register("p", "worker", str(tmp_path), agent_key="claude")

    before = (await plan_mcp.cli_list_targets(_ctx()))["targets"][0]["git"]["dirty"]
    (tmp_path / "README.md").write_text("edited")
    fresh_cache.invalidate(str(tmp_path))  # what the git watcher does on the write
    after = (await plan_mcp.cli_list_targets(_ctx()))["targets"][0]["git"]["dirty"]
    assert (before, after) == (0, 1)


@needs_git
@pytest.mark.asyncio
async def test_invalidation_reaches_a_repo_opened_through_a_symlink(
    tmp_path: Path, fresh_cache
) -> None:
    """git reports the resolved root; the watcher reports the path as opened."""
    real = tmp_path / "real"
    _init_repo(real)
    link = tmp_path / "link"
    link.symlink_to(real)

    assert (await fresh_cache.get(str(link)))["dirty"] == 0
    (real / "README.md").write_text("edited")
    fresh_cache.invalidate(str(link))
    assert (await fresh_cache.get(str(link)))["dirty"] == 1


@pytest.mark.asyncio
async def test_list_targets_spawns_git_once_per_worktree(monkeypatch, fresh_cache) -> None:
    calls: list[str] = []
    monkeypatch.setattr(
        fresh_cache, "_compute", _fake_compute({"/ws/repo": "/ws/repo"}, calls, delay=0.01)
    )
    agent_messaging.register("me", "caller", "/ws/repo", agent_key="claude")
    for i in range(30):
        agent_messaging.register(f"p{i}", f"worker-{i}", "/ws/repo", agent_key="claude")

    result = await plan_mcp.cli_list_targets(_ctx())
    assert len(result["targets"]) == 30
    assert all("git" in t for t in result["targets"])
    assert calls == ["/ws/repo"]
    await plan_mcp.cli_list_targets(_ctx())
    assert calls == ["/ws/repo"]


@pytest.mark.asyncio
async def test_slow_git_leaves_the_key_off_instead_of_stalling(monkeypatch, fresh_cache) -> None:
    monkeypatch.setattr(plan_mcp, "_PANE_GIT_WAIT_S", 0.01)
    monkeypatch.setattr(
        fresh_cache, "_compute", _fake_compute({"/ws/repo": "/ws/repo"}, [], delay=0.2)
    )
    agent_messaging.register("me", "caller", "/ws/repo", agent_key="claude")
    agent_messaging.register("p", "worker", "/ws/repo", agent_key="claude")

    result = await plan_mcp.cli_list_targets(_ctx())
    assert "git" not in result["targets"][0]


@needs_git
@pytest.mark.asyncio
async def test_get_status_carries_git(tmp_path: Path, monkeypatch, fresh_cache) -> None:
    _init_repo(tmp_path)
    agent_messaging.register("me", "caller", str(tmp_path), agent_key="claude")
    agent_messaging.register("p", "worker", str(tmp_path), agent_key="claude")

    async def no_ui(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {"ok": False}

    async def no_usage(agent_key: str) -> None:
        return None

    monkeypatch.setattr(plan_mcp, "_ui_request", no_ui)
    monkeypatch.setattr(plan_mcp, "_cached_usage_snapshot", no_usage)
    status = await plan_mcp.cli_get_status("worker", _ctx())

    assert status["ok"] is True
    assert status["git"]["branch"] == "main"
    assert {"name", "agent_key", "busy"} <= set(status)


# ── network snapshot ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_network_snapshot_adds_git_to_local_panes_only(monkeypatch, fresh_cache) -> None:
    monkeypatch.setattr(
        fresh_cache, "_compute", _fake_compute({"/ws/repo": "/ws/repo"}, [])
    )
    agent_messaging.register("p-local", "worker", "/ws/repo", agent_key="claude")
    snapshot = {
        "devices": [
            {"isLocal": True, "panes": [{"paneId": "p-local"}, {"paneId": "p-unknown"}]},
            {"isLocal": False, "panes": [{"paneId": "p-remote"}]},
        ]
    }
    await ws_handlers._add_local_pane_git(snapshot)

    local, remote = snapshot["devices"]
    assert local["panes"][0]["git"]["worktreeRoot"] == "/ws/repo"
    assert "git" not in local["panes"][1]
    assert "git" not in remote["panes"][0]
