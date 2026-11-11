"""Model arena: worktrees per candidate, stats, merge and cleanup (arena.py)."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import arena


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout


@pytest.fixture()
def repo(tmp_path: Path) -> Path:
    ws = tmp_path / "proj"
    ws.mkdir()
    _git(ws, "init", "-q", "-b", "main")
    _git(ws, "config", "user.name", "Arena Test")
    _git(ws, "config", "user.email", "arena@example.invalid")
    _git(ws, "config", "commit.gpgsign", "false")
    (ws / ".gitignore").write_text(".agent-team/\n")
    (ws / "app.py").write_text("print('hi')\n")
    (ws / "package.json").write_text("{}\n")
    _git(ws, "add", "-A")
    _git(ws, "commit", "-q", "-m", "base")
    return ws


TWO = [{"agent": "claude", "model": "claude-opus-5-5"}, {"agent": "codex", "model": ""}]


async def _start(repo: Path, cands: list[dict[str, Any]] = TWO) -> dict[str, Any]:
    return await arena.start_run(str(repo), "Add a greeting", cands)


@pytest.mark.asyncio
async def test_start_creates_one_worktree_per_candidate_from_same_base(repo: Path) -> None:
    run = await _start(repo)
    base = _git(repo, "rev-parse", "HEAD").strip()
    assert run["base_sha"] == base and run["base_branch"] == "main"
    assert [c["id"] for c in run["candidates"]] == ["A", "B"]
    assert [c["slug"] for c in run["candidates"]] == ["claude-opus-5-5", "codex"]
    for cand in run["candidates"]:
        assert cand["branch"] == f"arena/{run['id']}/{cand['slug']}"
        assert Path(cand["worktree"]).is_dir()
        assert str(repo / ".agent-team" / "worktrees" / f"arena-{run['id']}") in cand["worktree"]
        assert _git(Path(cand["worktree"]), "rev-parse", "HEAD").strip() == base
    assert run["time_limit_min"] == 30 and run["budget_usd"] == 3.0
    assert arena.load_run(str(repo), run["id"])["task"] == "Add a greeting"
    assert _git(repo, "status", "--porcelain") == ""


@pytest.mark.asyncio
async def test_start_dedupes_slugs_and_bounds_candidate_count(repo: Path) -> None:
    run = await _start(repo, [{"agent": "claude", "model": "opus"}, {"agent": "claude", "model": "opus"}])
    assert run["candidates"][0]["slug"] != run["candidates"][1]["slug"]
    with pytest.raises(arena.ArenaError):
        await _start(repo, TWO[:1])
    with pytest.raises(arena.ArenaError):
        await _start(repo, TWO * 3)
    with pytest.raises(arena.ArenaError):
        await _start(repo, [{"agent": "terminal"}, {"agent": "claude"}])


@pytest.mark.asyncio
async def test_start_refuses_a_folder_that_is_not_a_repo(tmp_path: Path) -> None:
    with pytest.raises(arena.ArenaError, match="not a git repository"):
        await arena.start_run(str(tmp_path), "x", TWO)


@pytest.mark.asyncio
async def test_status_counts_committed_uncommitted_untracked_and_flags_protected(repo: Path) -> None:
    run = await _start(repo)
    a = Path(run["candidates"][0]["worktree"])
    (a / "app.py").write_text("print('hello')\nprint('again')\n")
    (a / "new.py").write_text("x = 1\ny = 2\n")
    (a / "package.json").write_text('{"name": "x"}\n')

    class Ledger:
        enabled = True

        def report(self, by: str, **filters: Any) -> dict[str, Any]:
            assert by == "cwd"
            if filters["cwd"] == str(a):
                return {"groups": [{"usd": 3.5, "input": 10, "output": 5, "unpriced_calls": 0}]}
            return {"groups": []}

    status = await arena.run_status(str(repo), run["id"], Ledger())
    rows = {r["id"]: r for r in status["candidates"]}
    assert rows["A"]["files"] == 3
    assert rows["A"]["added"] == 2 + 2 + 1
    assert rows["A"]["protected"] == ["package.json"]
    assert rows["A"]["spend"]["usd"] == 3.5 and rows["A"]["spend"]["tokens"] == 15
    assert rows["A"]["over_budget"] is True
    assert rows["B"]["files"] == 0 and rows["B"]["over_budget"] is False

    cmp = await arena.compare(str(repo), run["id"])
    paths = {f["path"]: f for f in cmp["files"]}
    assert set(paths) == {"app.py", "new.py", "package.json"}
    assert paths["package.json"]["protected"] is True
    assert set(paths["app.py"]["by"]) == {"A"}

    diff = await arena.file_diff(str(repo), run["id"], "A", "new.py")
    assert "+x = 1" in diff["diff"]
    with pytest.raises(arena.ArenaError):
        await arena.file_diff(str(repo), run["id"], "A", "../etc/passwd")


def test_project_can_add_protected_patterns(tmp_path: Path) -> None:
    folder = tmp_path / ".agent-team" / "arena"
    folder.mkdir(parents=True)
    (folder / "protected.txt").write_text("# comment\nmigrations/*\n")
    pats = arena.protected_patterns(str(tmp_path))
    assert arena.is_protected("migrations/001.sql", pats)
    assert arena.is_protected("web/.env.local", pats)
    assert not arena.is_protected("src/app.py", pats)


@pytest.mark.asyncio
async def test_squash_merge_lands_one_commit_and_cleanup_removes_everything(repo: Path) -> None:
    run = await _start(repo)
    a = Path(run["candidates"][0]["worktree"])
    (a / "app.py").write_text("print('hello')\n")
    result = await arena.merge(str(repo), run["id"], candidate="A", mode="squash")
    assert result["ok"], result
    assert (repo / "app.py").read_text() == "print('hello')\n"
    assert _git(repo, "rev-list", "--count", "HEAD").strip() == "2"
    assert "Model arena run" in _git(repo, "log", "-1", "--format=%B")
    assert arena.load_run(str(repo), run["id"])["state"] == "merged"

    done = await arena.cleanup(str(repo), run["id"])
    assert done["ok"], done
    assert not Path(run["candidates"][0]["worktree"]).exists()
    assert "arena/" not in _git(repo, "branch", "--list")


@pytest.mark.asyncio
async def test_merge_refuses_a_dirty_main_checkout_and_reports_conflicts(repo: Path) -> None:
    run = await _start(repo)
    a = Path(run["candidates"][0]["worktree"])
    (a / "app.py").write_text("print('from A')\n")
    (repo / "app.py").write_text("print('local edit')\n")
    with pytest.raises(arena.ArenaError, match="uncommitted"):
        await arena.merge(str(repo), run["id"], candidate="A", mode="squash")
    _git(repo, "commit", "-qam", "moved on")
    preview = await arena.merge_preview(str(repo), run["id"])
    assert len(preview["new_commits"]) == 1
    result = await arena.merge(str(repo), run["id"], candidate="A", mode="merge")
    assert result["ok"] is False
    assert result["conflict_files"] == ["app.py"]
    # Left for the user: nothing was resolved or aborted.
    assert "<<<<<<<" in (repo / "app.py").read_text()


@pytest.mark.asyncio
async def test_branch_only_keeps_the_branch_through_cleanup(repo: Path) -> None:
    run = await _start(repo)
    a = Path(run["candidates"][0]["worktree"])
    (a / "app.py").write_text("print('A')\n")
    result = await arena.merge(str(repo), run["id"], candidate="A", mode="branch")
    assert result["ok"] and "commit" not in result
    await arena.cleanup(str(repo), run["id"], keep_branch=result["branch"])
    branches = _git(repo, "branch", "--list")
    assert run["candidates"][0]["branch"] in branches
    assert run["candidates"][1]["branch"] not in branches
    assert (repo / "app.py").read_text() == "print('hi')\n"


@pytest.mark.asyncio
async def test_file_level_mix_takes_each_file_from_its_pick(repo: Path) -> None:
    run = await _start(repo)
    a = Path(run["candidates"][0]["worktree"])
    b = Path(run["candidates"][1]["worktree"])
    (a / "app.py").write_text("print('A')\n")
    (a / "a_only.py").write_text("a = 1\n")
    (b / "b_only.py").write_text("b = 1\n")
    result = await arena.merge(
        str(repo), run["id"], candidate="mix", mode="squash",
        picks={"app.py": "A", "b_only.py": "B", "a_only.py": ""},
    )
    assert result["ok"], result
    assert (repo / "app.py").read_text() == "print('A')\n"
    assert (repo / "b_only.py").exists()
    assert not (repo / "a_only.py").exists()


@pytest.mark.asyncio
async def test_update_candidate_keeps_one_adopted_and_clamps_rating(repo: Path) -> None:
    run = await _start(repo)
    arena.update_candidate(str(repo), run["id"], "B", {"adopted": True})
    after = arena.update_candidate(str(repo), run["id"], "A", {"adopted": True, "rating": 9})
    assert [c["adopted"] for c in after["candidates"]] == [True, False]
    assert after["candidates"][0]["rating"] == 5
    with pytest.raises(arena.ArenaError):
        arena.load_run(str(repo), "../x")


@pytest.mark.asyncio
async def test_a_rewritten_record_is_refused(repo: Path, tmp_path: Path) -> None:
    run = await _start(repo)
    path = repo / ".agent-team" / "arena" / f"{run['id']}.json"
    for field, value in (("worktree", str(tmp_path)), ("branch", "main"), ("slug", "../x")):
        tampered = json.loads(path.read_text())
        tampered["candidates"][0][field] = value
        path.write_text(json.dumps(tampered))
        with pytest.raises(arena.ArenaError, match="not valid"):
            arena.load_run(str(repo), run["id"])
    assert arena.list_runs(str(repo)) == []


@pytest.mark.asyncio
async def test_repo_hooks_never_run_and_a_fifo_does_not_block(repo: Path) -> None:
    run = await _start(repo)
    a = Path(run["candidates"][0]["worktree"])
    hook = repo / ".git" / "hooks" / "pre-commit"
    marker = repo.parent / "hook-ran"
    hook.write_text(f"#!/bin/sh\ntouch {marker}\n")
    hook.chmod(0o755)
    os.mkfifo(a / "pipe")
    (a / "app.py").write_text("print('A')\n")
    status = await asyncio.wait_for(arena.run_status(str(repo), run["id"], None), timeout=30)
    assert {r["id"]: r for r in status["candidates"]}["A"]["files"] >= 1
    (a / "pipe").unlink()
    result = await arena.merge(str(repo), run["id"], candidate="A", mode="squash")
    assert result["ok"], result
    assert not marker.exists()


@pytest.mark.asyncio
async def test_a_worktree_swapped_for_a_symlink_is_refused(repo: Path, tmp_path: Path) -> None:
    run = await _start(repo)
    a = Path(run["candidates"][0]["worktree"])
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    subprocess.run(["git", "worktree", "remove", "--force", str(a)], cwd=repo, check=True)
    a.symlink_to(elsewhere)
    with pytest.raises(arena.ArenaError, match="not where this run created it"):
        await arena.run_status(str(repo), run["id"], None)


@pytest.mark.asyncio
async def test_record_numbers_and_stop_reasons_are_checked(repo: Path) -> None:
    run = await _start(repo)
    path = repo / ".agent-team" / "arena" / f"{run['id']}.json"
    good = path.read_text()
    for mutate in (
        lambda r: r.update(budget_usd=float("nan")),
        lambda r: r.update(time_limit_min=-1),
        lambda r: r["candidates"][0].update(stopped="later"),
    ):
        tampered = json.loads(good)
        mutate(tampered)
        path.write_text(json.dumps(tampered))
        with pytest.raises(arena.ArenaError, match="not valid"):
            arena.load_run(str(repo), run["id"])
    path.write_text(good)
    with pytest.raises(arena.ArenaError):
        arena.update_candidate(str(repo), run["id"], "A", {"stopped": "later"})
