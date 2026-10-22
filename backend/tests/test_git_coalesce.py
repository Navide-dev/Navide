"""Shared git reads: the Git pane's reload burst and get_status's rev-parse."""

from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import git_service, osplat, ws_handlers

needs_git = pytest.mark.skipif(
    osplat.paths.resolve_program("git") is None,
    reason="git is not resolvable through osplat.paths on this host",
)


def _git(path: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=path, check=True, capture_output=True, text=True).stdout


def _init_repo(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    _git(path, "init", "-b", "main")
    _git(path, "config", "user.email", "test@test.com")
    _git(path, "config", "user.name", "Test")
    (path / "README.md").write_text("# test")
    _git(path, "add", "-A")
    _git(path, "commit", "-m", "init")


# ── coalesced ──────────────────────────────────────────────────────────────────


def _counting_read(calls: list[int], delay: float = 0.02):
    async def read() -> list[dict[str, Any]]:
        calls.append(1)
        await asyncio.sleep(delay)
        return [{"run": len(calls)}]

    return read


@pytest.mark.asyncio
async def test_a_burst_costs_two_runs_however_many_callers() -> None:
    """As with get_status: the first caller starts a run, everyone after it
    shares one queued run that starts once that finishes."""
    for callers in (2, 7, 30):
        calls: list[int] = []
        read = _counting_read(calls)
        results = await asyncio.gather(
            *(git_service.coalesced(("branches", f"/w{callers}"), read) for _ in range(callers))
        )
        assert len(calls) == 2
        assert results == [[{"run": 1}]] + [[{"run": 2}]] * (callers - 1)
    results[1][0]["run"] = 99  # each caller owns its copy
    assert results[2] == [{"run": 2}]


@pytest.mark.asyncio
async def test_a_read_arriving_mid_run_waits_for_one_fresh_run() -> None:
    """Never a result from before the change that prompted the read: a burst
    during a run costs one more run, not one per caller."""
    calls: list[int] = []
    read = _counting_read(calls)
    first = asyncio.ensure_future(git_service.coalesced(("tags", "/w"), read))
    await asyncio.sleep(0.005)
    later = await asyncio.gather(*(git_service.coalesced(("tags", "/w"), read) for _ in range(5)))
    assert await first == [{"run": 1}]
    assert later == [[{"run": 2}]] * 5
    assert calls == [1, 1]


@pytest.mark.asyncio
async def test_different_keys_do_not_share() -> None:
    calls: list[int] = []
    read = _counting_read(calls)
    await asyncio.gather(
        git_service.coalesced(("log", "/w", 20), read),
        git_service.coalesced(("log", "/w", 50), read),
        git_service.coalesced(("log", "/other", 20), read),
    )
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_a_failing_read_reaches_every_caller_and_is_not_kept() -> None:
    async def boom() -> None:
        await asyncio.sleep(0.01)
        raise RuntimeError("git failed")

    results = await asyncio.gather(
        *(git_service.coalesced(("remotes", "/w"), boom) for _ in range(3)), return_exceptions=True
    )
    assert all(isinstance(r, RuntimeError) for r in results)
    calls: list[int] = []
    assert await git_service.coalesced(("remotes", "/w"), _counting_read(calls)) == [{"run": 1}]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("msg_type", "handler", "service_fn", "payload"),
    [
        ("git.branches", ws_handlers.git_branches, "list_branches", {}),
        ("git.stash_list", ws_handlers.git_stash_list, "stash_list", {}),
        ("git.remotes", ws_handlers.git_remotes, "list_remotes", {}),
        ("git.tags", ws_handlers.git_tags, "list_tags", {}),
        ("git.worktrees", ws_handlers.git_worktrees, "list_worktrees", {}),
        ("git.log", ws_handlers.git_log, "get_log", {"n": 20}),
    ],
)
async def test_a_reload_burst_runs_each_git_read_once(
    monkeypatch: pytest.MonkeyPatch, msg_type: str, handler: Any, service_fn: str, payload: dict
) -> None:
    """Several Git panes on one workspace reload together after one
    git.changed; each read now costs two git runs for all of them, not one each."""
    calls: list[tuple] = []

    async def fake(*args: Any) -> Any:
        calls.append(args)
        await asyncio.sleep(0.02)
        return {"same": True} if service_fn == "list_branches" else [{"same": True}]

    monkeypatch.setattr(git_service, service_fn, fake)
    sent: list[dict] = []

    async def send_json(message: dict) -> None:
        sent.append(message)

    session = SimpleNamespace(send_json=send_json)
    await asyncio.gather(
        *(handler(session, f"m{i}", msg_type, {"workspace_path": "/w", **payload}) for i in range(6))
    )
    assert len(calls) == 2  # was one per caller (6)
    assert len(sent) == 6
    assert len({repr(m["payload"]) for m in sent}) == 1


# ── get_status: one rev-parse instead of two ───────────────────────────────────


def _status_shape(status: dict[str, Any]) -> dict[str, Any]:
    return {k: status.get(k) for k in ("is_git_repo", "branch", "operation_in_progress", "ok")}


@needs_git
@pytest.mark.parametrize("where", ["top", "subdir", "linked-worktree", "inside-dot-git"])
def test_combined_rev_parse_prints_what_the_two_calls_printed(tmp_path: Path, where: str) -> None:
    repo = tmp_path / "repo"
    _init_repo(repo)
    (repo / "sub" / "deeper").mkdir(parents=True)
    _git(repo, "worktree", "add", str(tmp_path / "wt"), "-b", "side")
    cwd = {
        "top": repo,
        "subdir": repo / "sub" / "deeper",
        "linked-worktree": tmp_path / "wt",
        "inside-dot-git": repo / ".git",
    }[where]
    combined = _git(cwd, "rev-parse", "--is-inside-work-tree", "--git-dir").splitlines()
    assert combined == [
        _git(cwd, "rev-parse", "--is-inside-work-tree").strip(),
        _git(cwd, "rev-parse", "--git-dir").strip(),
    ]


@needs_git
def test_combined_rev_parse_fails_alike_outside_a_repository(tmp_path: Path) -> None:
    plain = tmp_path / "plain"
    plain.mkdir()
    env_c = {"LC_ALL": "C", "PATH": __import__("os").environ["PATH"], "GIT_CEILING_DIRECTORIES": str(tmp_path)}
    one = subprocess.run(["git", "rev-parse", "--is-inside-work-tree"], cwd=plain, capture_output=True, text=True, env=env_c)
    both = subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree", "--git-dir"], cwd=plain, capture_output=True, text=True, env=env_c
    )
    assert (one.returncode, one.stdout) == (both.returncode, both.stdout)
    assert one.returncode != 0
    assert "not a git repository" in one.stderr and "not a git repository" in both.stderr


@needs_git
@pytest.mark.asyncio
@pytest.mark.parametrize("marker", [None, "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "MERGE_HEAD"])
async def test_get_status_runs_two_git_commands_and_still_finds_operations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, marker: str | None
) -> None:
    repo = tmp_path / "repo"
    _init_repo(repo)
    (repo / "sub").mkdir()
    if marker in ("rebase-merge", "rebase-apply"):
        (repo / ".git" / marker).mkdir()
    elif marker:
        (repo / ".git" / marker).write_text(_git(repo, "rev-parse", "HEAD"))
    real_run, real_capped = git_service._run, git_service._run_capped
    runs: list[list[str]] = []

    async def counting_run(args: list[str], *rest: Any, **kw: Any) -> Any:
        runs.append(args)
        return await real_run(args, *rest, **kw)

    async def counting_capped(args: list[str], *rest: Any, **kw: Any) -> Any:
        runs.append(args)
        return await real_capped(args, *rest, **kw)

    monkeypatch.setattr(git_service, "_run", counting_run)
    monkeypatch.setattr(git_service, "_run_capped", counting_capped)
    expected = {None: "", "rebase-merge": "rebase", "rebase-apply": "rebase",
                "CHERRY_PICK_HEAD": "cherry-pick", "MERGE_HEAD": "merge"}[marker]
    for cwd in (repo, repo / "sub"):
        runs.clear()
        status = await git_service.get_status(str(cwd))
        assert _status_shape(status) == {
            "is_git_repo": True, "branch": "main", "operation_in_progress": expected, "ok": None,
        }
        assert len(runs) == 2


@needs_git
@pytest.mark.asyncio
async def test_get_status_still_says_not_a_repository(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    plain = tmp_path / "plain"
    plain.mkdir()
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path))
    status = await git_service.get_status(str(plain))
    assert status["is_git_repo"] is False


@pytest.mark.asyncio
async def test_a_list_or_dict_in_the_key_is_shared_not_a_type_error() -> None:
    """A ws payload can carry a list where git.log expects a string."""
    calls: list[int] = []
    read = _counting_read(calls)
    results = await asyncio.gather(
        git_service.coalesced(("log", "/w", ["a", "b"], {"x": 1}), read),
        git_service.coalesced(("log", "/w", ["a", "b"], {"x": 1}), read),
    )
    assert results == [[{"run": 1}], [{"run": 2}]]
    assert len(calls) == 2  # one run plus the queued one, as for any burst


@pytest.mark.asyncio
async def test_a_failure_nobody_awaits_is_not_logged_as_unretrieved() -> None:
    """Every caller gave up (cancelled through the shield) before the run
    failed: asyncio must not report "Task exception was never retrieved"."""
    import gc

    loop = asyncio.get_running_loop()
    reported: list[str] = []
    previous = loop.get_exception_handler()
    loop.set_exception_handler(lambda _loop, context: reported.append(str(context.get("message"))))
    try:
        started = asyncio.Event()

        async def boom() -> None:
            started.set()
            await asyncio.sleep(0.02)
            raise RuntimeError("git failed")

        caller = asyncio.ensure_future(git_service.coalesced(("tags", "/gone"), boom))
        await started.wait()
        caller.cancel()
        with pytest.raises(asyncio.CancelledError):
            await caller
        await asyncio.sleep(0.05)
        gc.collect()
        await asyncio.sleep(0)
    finally:
        loop.set_exception_handler(previous)
    assert not [m for m in reported if "never retrieved" in m]
