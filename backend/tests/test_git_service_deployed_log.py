"""git_service's deployed-history queries: a branch's first-parent commits and
the tags created in a time window (the Shipped Log's git source)."""
from __future__ import annotations

import os
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from agent_team_backend import git_service, osplat

pytestmark = pytest.mark.skipif(
    osplat.paths.resolve_program("git") is None,
    reason="git is not resolvable through osplat.paths on this host",
)

T0 = datetime(2026, 11, 10, 12, 0, tzinfo=timezone.utc)


def _git(repo: Path, *args: str, at: datetime | None = None) -> str:
    env = {**os.environ, "GIT_CONFIG_NOSYSTEM": "1"}
    if at is not None:
        stamp = f"{int(at.timestamp())} +0000"
        env["GIT_AUTHOR_DATE"] = stamp
        env["GIT_COMMITTER_DATE"] = stamp
    return subprocess.run(
        ["git", *args], cwd=repo, env=env, check=True, capture_output=True, text=True
    ).stdout.strip()


def _commit(repo: Path, name: str, message: str, at: datetime) -> str:
    (repo / name).write_text(name, encoding="utf-8")
    _git(repo, "add", name)
    _git(repo, "commit", "-q", "-m", message, at=at)
    return _git(repo, "rev-parse", "HEAD")


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    path = tmp_path / "repo"
    path.mkdir()
    _git(path, "init", "-q", "-b", "main")
    _git(path, "config", "user.email", "t@example.invalid")
    _git(path, "config", "user.name", "T")
    _git(path, "config", "commit.gpgsign", "false")
    _git(path, "config", "tag.gpgsign", "false")
    return path


async def test_first_parent_log_lists_only_the_branch_line_inside_the_window(repo: Path) -> None:
    old = _commit(repo, "a", "chore: before the window", T0 - timedelta(days=3))
    first = _commit(repo, "b", "feat: first", T0 + timedelta(hours=1))
    _git(repo, "checkout", "-q", "-b", "topic")
    side = _commit(repo, "c", "fix: on the topic branch", T0 + timedelta(hours=2))
    _git(repo, "checkout", "-q", "main")
    _git(repo, "merge", "-q", "--no-ff", "-m", "Merge branch 'topic'", "topic", at=T0 + timedelta(hours=3))
    merge = _git(repo, "rev-parse", "HEAD")

    log = await git_service.get_first_parent_log(str(repo), "main", T0)

    assert [c["hash"] for c in log] == [merge, first]
    assert side not in {c["hash"] for c in log} and old not in {c["hash"] for c in log}
    assert log[1]["subject"] == "feat: first"
    assert log[1]["committed_at"] == int((T0 + timedelta(hours=1)).timestamp())
    assert log[1]["short_hash"] == first[:7]


async def test_first_parent_log_honours_until_and_keeps_the_body(repo: Path) -> None:
    _commit(repo, "a", "feat: inside\n\nThe longer story.", T0 + timedelta(hours=1))
    _commit(repo, "b", "feat: after", T0 + timedelta(days=2))

    log = await git_service.get_first_parent_log(str(repo), "main", T0, T0 + timedelta(days=1))

    assert [c["subject"] for c in log] == ["feat: inside"]
    assert log[0]["body"] == "The longer story."


@pytest.mark.parametrize("branch", ["-p", "--all", "main..topic", "", "a b"])
async def test_first_parent_log_refuses_a_flag_or_range_for_the_branch(repo: Path, branch: str) -> None:
    _commit(repo, "a", "feat: x", T0 + timedelta(hours=1))
    assert await git_service.get_first_parent_log(str(repo), branch, T0) == []


async def test_first_parent_log_of_a_missing_branch_or_non_repo_is_empty(repo: Path, tmp_path: Path) -> None:
    _commit(repo, "a", "feat: x", T0 + timedelta(hours=1))
    assert await git_service.get_first_parent_log(str(repo), "production", T0) == []
    plain = tmp_path / "plain"
    plain.mkdir()
    assert await git_service.get_first_parent_log(str(plain), "main", T0) == []


async def test_deploy_branch_prefers_main_then_master(repo: Path, tmp_path: Path) -> None:
    _commit(repo, "a", "feat: x", T0)
    assert await git_service.default_deploy_branch(str(repo)) == "main"
    _git(repo, "branch", "-m", "main", "master")
    assert await git_service.default_deploy_branch(str(repo)) == "master"
    _git(repo, "branch", "-m", "master", "trunk")
    assert await git_service.default_deploy_branch(str(repo)) is None
    assert await git_service.default_deploy_branch(str(tmp_path)) is None


async def test_tags_created_in_the_window_name_the_commit_they_point_at(repo: Path) -> None:
    first = _commit(repo, "a", "feat: first", T0 - timedelta(days=2))
    _git(repo, "tag", "v0.1", at=T0 - timedelta(days=2))
    second = _commit(repo, "b", "fix: second", T0 + timedelta(hours=1))
    _git(repo, "tag", "-a", "v0.2", "-m", "release 0.2", at=T0 + timedelta(hours=2))
    # A lightweight tag has no date of its own: git dates it by its commit.
    _git(repo, "tag", "old-light", first)
    _git(repo, "tag", "deploy-1", second)

    tags = await git_service.list_tags_created_between(str(repo), T0)

    assert [(t["name"], t["commit_hash"]) for t in tags] == [("deploy-1", second), ("v0.2", second)]
    assert tags[1]["created_at"] == int((T0 + timedelta(hours=2)).timestamp())
    assert tags[1]["subject"] == "fix: second"
    assert [t["name"] for t in await git_service.list_tags_created_between(
        str(repo), T0 + timedelta(minutes=90))] == ["v0.2"]
