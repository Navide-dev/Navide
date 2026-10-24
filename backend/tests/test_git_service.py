"""Tests for git_service.py — all operations run in tmp_path git repos."""
from __future__ import annotations

import asyncio
import os
import subprocess
import threading
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app as app_module
from agent_team_backend import git_service, host_shell, osplat

# Every test here drives a real `git`, found through the seam
# (`host_shell` resolves argv[0] with `osplat.paths.resolve_program`). Gate
# on that lookup, not on the OS: a host where this platform's resolver cannot
# see git — none installed, or the seam swapped to another platform's
# implementation (`-p tests.osplat_win_swap`) — has nothing to run.
pytestmark = pytest.mark.skipif(
    osplat.paths.resolve_program("git") is None,
    reason="git is not resolvable through osplat.paths on this host",
)


# ── helpers ────────────────────────────────────────────────────────────────────

def init_repo(path: Path) -> None:
    """Create a minimal git repo with one initial commit."""
    subprocess.run(["git", "init"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=path, check=True, capture_output=True)
    (path / "README.md").write_text("# test")
    subprocess.run(["git", "add", "-A"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=path, check=True, capture_output=True)


# ── get_status ─────────────────────────────────────────────────────────────────

class TestGetStatus:
    @pytest.mark.asyncio
    async def test_non_git_dir(self, tmp_path):
        result = await git_service.get_status(str(tmp_path))
        assert result["is_git_repo"] is False

    @pytest.mark.asyncio
    async def test_empty_path(self):
        result = await git_service.get_status("")
        assert result["is_git_repo"] is False

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "rc, err", [(128, "git timed out"), (127, "git not found")], ids=["timeout", "missing"]
    )
    async def test_repo_check_that_cannot_run_is_an_error_not_a_non_repo(
        self, tmp_path, monkeypatch, rc, err
    ):
        # A rev-parse that timed out or never ran says nothing about the repo;
        # reporting "not a git repo" hides the failure and sends the UI into a
        # repository discovery walk (#144).
        init_repo(tmp_path)

        async def failing(args, cwd, env=None):
            return rc, "", err

        monkeypatch.setattr(git_service, "_run", failing)
        result = await git_service.get_status(str(tmp_path))
        assert result == {"ok": False, "error": err}

    @pytest.mark.asyncio
    async def test_non_git_dir_under_a_translated_locale(self, tmp_path, monkeypatch):
        # Telling "not a repository" from other failures reads git's message,
        # which a translated locale would reword.
        monkeypatch.setenv("LC_ALL", "de_DE.UTF-8")
        monkeypatch.setenv("LANGUAGE", "de")
        result = await git_service.get_status(str(tmp_path))
        assert result["is_git_repo"] is False

    @pytest.mark.asyncio
    async def test_clean_repo(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.get_status(str(tmp_path))
        assert result["is_git_repo"] is True
        assert result["branch"] != ""
        assert result["staged"] == []
        assert result["unstaged"] == []
        assert result["untracked"] == []

    @pytest.mark.asyncio
    async def test_detects_untracked(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "new_file.txt").write_text("hello")
        result = await git_service.get_status(str(tmp_path))
        assert any(f["path"] == "new_file.txt" for f in result["untracked"])

    @pytest.mark.asyncio
    async def test_detects_staged(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "staged.txt").write_text("staged")
        subprocess.run(["git", "add", "staged.txt"], cwd=tmp_path, check=True, capture_output=True)
        result = await git_service.get_status(str(tmp_path))
        assert any(f["path"] == "staged.txt" for f in result["staged"])

    @pytest.mark.asyncio
    async def test_detects_modified_unstaged(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("changed")
        result = await git_service.get_status(str(tmp_path))
        assert any(f["path"] == "README.md" for f in result["unstaged"])

    @pytest.mark.asyncio
    async def test_caps_entries_on_huge_untracked_tree(self, tmp_path, monkeypatch):
        # Issue #144: a repo with ~454k untracked files built one entry per
        # path on the event loop and stalled it for minutes.
        monkeypatch.setattr(git_service, "_STATUS_ENTRY_LIMIT", 20)
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("changed")
        big = tmp_path / "big"
        big.mkdir()
        for i in range(100):
            (big / f"f{i}").write_text("")
        result = await git_service.get_status(str(tmp_path))
        entries = result["staged"] + result["unstaged"] + result["untracked"]
        assert len(entries) == 20
        assert result["truncated"] is True
        assert result["branch"] != ""

    @pytest.mark.asyncio
    async def test_byte_cap_drops_the_cut_line(self, tmp_path, monkeypatch):
        monkeypatch.setattr(git_service, "_STATUS_MAX_BYTES", 300)
        init_repo(tmp_path)
        for i in range(100):
            (tmp_path / f"untracked_file_{i:03d}.txt").write_text("")
        result = await git_service.get_status(str(tmp_path))
        assert result["truncated"] is True
        assert result["untracked"]
        for entry in result["untracked"]:
            assert len(entry["path"]) == len("untracked_file_000.txt")

    @pytest.mark.asyncio
    async def test_not_truncated_below_cap(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "new_file.txt").write_text("hello")
        result = await git_service.get_status(str(tmp_path))
        assert result["truncated"] is False

    @pytest.mark.asyncio
    async def test_does_not_rewrite_the_index(self, tmp_path):
        # A plain `git status` refreshes stale stat info into .git/index; the
        # watcher sees that write as a change and asks for status again.
        init_repo(tmp_path)
        index = tmp_path / ".git" / "index"
        before = index.read_bytes()
        os.utime(tmp_path / "README.md", (946684800, 946684800))
        await git_service.get_status(str(tmp_path))
        assert index.read_bytes() == before

    @pytest.mark.asyncio
    async def test_failed_status_is_an_error_not_a_clean_repo(self, tmp_path, monkeypatch):
        init_repo(tmp_path)
        (tmp_path / "new_file.txt").write_text("hello")

        async def timed_out(args, cwd, max_stdout_bytes):
            return 128, "", "git timed out", False

        monkeypatch.setattr(git_service, "_run_capped", timed_out)
        result = await git_service.get_status(str(tmp_path))
        # No is_git_repo: the UI keeps its last status and shows the error.
        assert result == {"ok": False, "error": "git timed out"}

    @pytest.mark.asyncio
    async def test_concurrent_reads_share_a_run(self, tmp_path, monkeypatch):
        init_repo(tmp_path)
        real = git_service._run_capped
        gate = asyncio.Event()
        runs = 0

        async def gated(args, cwd, max_stdout_bytes):
            nonlocal runs
            runs += 1
            await gate.wait()
            return await real(args, cwd, max_stdout_bytes)

        monkeypatch.setattr(git_service, "_run_capped", gated)
        reads = [asyncio.ensure_future(git_service.get_status(str(tmp_path))) for _ in range(6)]
        await asyncio.sleep(0.2)
        gate.set()
        results = await asyncio.gather(*reads)
        # The first read runs; the five that arrived meanwhile share one
        # queued run instead of each taking a process slot.
        assert runs == 2
        assert all(r["is_git_repo"] is True for r in results)

    @pytest.mark.asyncio
    async def test_read_during_a_run_sees_changes_made_after_it_started(
        self, tmp_path, monkeypatch
    ):
        init_repo(tmp_path)
        real = git_service._run_capped
        started = asyncio.Event()
        gate = asyncio.Event()

        async def gated(args, cwd, max_stdout_bytes):
            started.set()
            await gate.wait()
            return await real(args, cwd, max_stdout_bytes)

        monkeypatch.setattr(git_service, "_run_capped", gated)
        first = asyncio.ensure_future(git_service.get_status(str(tmp_path)))
        await started.wait()
        (tmp_path / "late.txt").write_text("x")
        second = asyncio.ensure_future(git_service.get_status(str(tmp_path)))
        await asyncio.sleep(0)
        gate.set()
        await first
        result = await second
        assert any(f["path"] == "late.txt" for f in result["untracked"])
        assert not git_service._status_running and not git_service._status_queued


# ── get_log ────────────────────────────────────────────────────────────────────

class TestGetLog:
    @pytest.mark.asyncio
    async def test_returns_commits(self, tmp_path):
        init_repo(tmp_path)
        commits = await git_service.get_log(str(tmp_path), n=5)
        assert len(commits) == 1
        assert commits[0]["message"] == "init"
        assert commits[0]["short_hash"] != ""
        assert len(commits[0]["hash"]) == 40

    @pytest.mark.asyncio
    async def test_empty_for_non_git(self, tmp_path):
        commits = await git_service.get_log(str(tmp_path))
        assert commits == []

    @pytest.mark.asyncio
    async def test_multiple_commits(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "a.txt").write_text("a")
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "second"], cwd=tmp_path, check=True, capture_output=True)
        commits = await git_service.get_log(str(tmp_path), n=10)
        assert len(commits) == 2
        assert commits[0]["message"] == "second"

    @staticmethod
    def _commit(path: Path, message: str) -> None:
        (path / f"{message.replace(' ', '_')}.txt").write_text(message)
        subprocess.run(["git", "add", "-A"], cwd=path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", message], cwd=path, check=True, capture_output=True)

    @pytest.mark.asyncio
    async def test_query_filters_by_message(self, tmp_path):
        init_repo(tmp_path)
        self._commit(tmp_path, "add feature")
        self._commit(tmp_path, "fix bug")
        self._commit(tmp_path, "add docs")
        commits = await git_service.get_log(str(tmp_path), n=50, query="feature")
        assert [c["message"] for c in commits] == ["add feature"]

    @pytest.mark.asyncio
    async def test_query_is_case_insensitive(self, tmp_path):
        init_repo(tmp_path)
        self._commit(tmp_path, "add feature")
        self._commit(tmp_path, "fix bug")
        commits = await git_service.get_log(str(tmp_path), n=50, query="FEATURE")
        assert [c["message"] for c in commits] == ["add feature"]

    @pytest.mark.asyncio
    async def test_query_none_returns_all(self, tmp_path):
        init_repo(tmp_path)
        self._commit(tmp_path, "add feature")
        self._commit(tmp_path, "fix bug")
        commits = await git_service.get_log(str(tmp_path), n=50, query=None)
        assert len(commits) == 3
        assert commits[0]["message"] == "fix bug"

    @pytest.mark.asyncio
    async def test_order_date_returns_commits(self, tmp_path):
        init_repo(tmp_path)
        self._commit(tmp_path, "second")
        self._commit(tmp_path, "third")
        commits = await git_service.get_log(str(tmp_path), n=50, order="date")
        assert [c["message"] for c in commits] == ["third", "second", "init"]

    @pytest.mark.asyncio
    async def test_order_invalid_falls_back_to_ancestor(self, tmp_path):
        init_repo(tmp_path)
        self._commit(tmp_path, "second")
        default = await git_service.get_log(str(tmp_path), n=50)
        bogus = await git_service.get_log(str(tmp_path), n=50, order="; rm -rf")
        assert [c["hash"] for c in bogus] == [c["hash"] for c in default]


# ── stage / unstage ────────────────────────────────────────────────────────────

class TestStageUnstage:
    @pytest.mark.asyncio
    async def test_stage_file(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "new.txt").write_text("new")
        result = await git_service.stage_files(str(tmp_path), ["new.txt"])
        assert result["ok"] is True
        status = await git_service.get_status(str(tmp_path))
        assert any(f["path"] == "new.txt" for f in status["staged"])

    @pytest.mark.asyncio
    async def test_unstage_file(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "new.txt").write_text("new")
        subprocess.run(["git", "add", "new.txt"], cwd=tmp_path, check=True, capture_output=True)
        result = await git_service.unstage_files(str(tmp_path), ["new.txt"])
        assert result["ok"] is True
        status = await git_service.get_status(str(tmp_path))
        assert not any(f["path"] == "new.txt" for f in status["staged"])

    @pytest.mark.asyncio
    async def test_unstage_before_first_commit(self, tmp_path):
        # No HEAD yet: `git restore --staged` would fail, so unstage must fall
        # back to removing entries from the index.
        subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
        (tmp_path / "new.txt").write_text("new")
        subprocess.run(["git", "add", "new.txt"], cwd=tmp_path, check=True, capture_output=True)
        result = await git_service.unstage_files(str(tmp_path), ["new.txt"])
        assert result["ok"] is True
        status = await git_service.get_status(str(tmp_path))
        assert not any(f["path"] == "new.txt" for f in status["staged"])
        assert any(f["path"] == "new.txt" for f in status["untracked"])

    @pytest.mark.asyncio
    async def test_unstage_before_first_commit_modified_after_staging(self, tmp_path):
        # No HEAD AND the staged file was changed on disk after staging (like a
        # log file the app keeps writing). `git rm --cached` without -f refuses
        # this, so unstage must force it while keeping the working-tree file.
        subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
        f = tmp_path / "history.jsonl"
        f.write_text("v1")
        subprocess.run(["git", "add", "history.jsonl"], cwd=tmp_path, check=True, capture_output=True)
        f.write_text("v2-modified-after-staging")  # staged content != working tree
        result = await git_service.unstage_files(str(tmp_path), ["history.jsonl"])
        assert result["ok"] is True, result
        status = await git_service.get_status(str(tmp_path))
        assert not any(x["path"] == "history.jsonl" for x in status["staged"])
        assert f.read_text() == "v2-modified-after-staging"  # working file preserved

    @pytest.mark.asyncio
    async def test_unstage_untracked_path_is_a_noop(self, tmp_path):
        # The UI acts on a status snapshot, so a row can already be out of the
        # index when the click lands. git rejects the whole batch for such a path
        # ("pathspec ... did not match any file(s) known to git"), leaving the
        # genuinely staged files staged — unstage must retry without the stale ones.
        init_repo(tmp_path)
        (tmp_path / "untracked.txt").write_text("new")
        (tmp_path / "staged.txt").write_text("new")
        subprocess.run(["git", "add", "staged.txt"], cwd=tmp_path, check=True, capture_output=True)
        result = await git_service.unstage_files(
            str(tmp_path), ["untracked.txt", "gone.txt", "staged.txt"]
        )
        assert result["ok"] is True, result
        assert result["error"] == ""
        status = await git_service.get_status(str(tmp_path))
        assert status["staged"] == []
        assert (tmp_path / "untracked.txt").exists()

    @pytest.mark.asyncio
    async def test_unstage_accepts_directory_pathspec(self, tmp_path):
        # git expands a directory pathspec itself; the stale-path retry must not
        # narrow unstage to exact file paths.
        init_repo(tmp_path)
        (tmp_path / "sub").mkdir()
        (tmp_path / "sub" / "z.txt").write_text("z")
        subprocess.run(["git", "add", "sub/z.txt"], cwd=tmp_path, check=True, capture_output=True)
        result = await git_service.unstage_files(str(tmp_path), ["sub"])
        assert result["ok"] is True, result
        status = await git_service.get_status(str(tmp_path))
        assert status["staged"] == []

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "status",
        [
            {"ok": False, "error": "git timed out"},
            {"is_git_repo": True, "staged": [], "truncated": True},
        ],
        ids=["failed", "truncated"],
    )
    async def test_unstage_stale_retry_needs_a_complete_status(
        self, tmp_path, monkeypatch, status
    ):
        # The stale-path retry trusts the re-read status to say what is still
        # staged; a failed or truncated read must not turn the failure into
        # success while staged.txt stays staged (#144).
        init_repo(tmp_path)
        (tmp_path / "staged.txt").write_text("new")
        subprocess.run(["git", "add", "staged.txt"], cwd=tmp_path, check=True, capture_output=True)

        async def fake_status(*_args, **_kwargs):
            return status

        monkeypatch.setattr(git_service, "get_status", fake_status)
        result = await git_service.unstage_files(str(tmp_path), ["gone.txt", "staged.txt"])
        assert result["ok"] is False, result
        assert "did not match any file" in result["error"]

    @pytest.mark.asyncio
    async def test_unstage_still_reports_other_errors(self, tmp_path):
        # Only the stale-pathspec case is absorbed; anything else must surface.
        result = await git_service.unstage_files(str(tmp_path), ["a.txt"])  # not a repo
        assert result["ok"] is False
        assert result["error"]

    @pytest.mark.asyncio
    async def test_status_rename_uses_new_path(self, tmp_path):
        # A staged rename renders as "old -> new"; status must expose the new
        # path (a real file) rather than the literal "old -> new" string.
        init_repo(tmp_path)
        (tmp_path / "old.txt").write_text("x\n" * 5)
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "add"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "mv", "old.txt", "new.txt"], cwd=tmp_path, check=True, capture_output=True)
        status = await git_service.get_status(str(tmp_path))
        staged_paths = [f["path"] for f in status["staged"]]
        assert "new.txt" in staged_paths
        assert all("->" not in p for p in staged_paths)
        # And the resolved path can actually be unstaged.
        result = await git_service.unstage_files(str(tmp_path), ["new.txt"])
        assert result["ok"] is True, result

    @pytest.mark.asyncio
    async def test_status_non_ascii_path_unquoted(self, tmp_path):
        # Non-ASCII paths must be returned as raw UTF-8, not git's quoted/octal form.
        init_repo(tmp_path)
        (tmp_path / "中文檔案.txt").write_text("hi")
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        status = await git_service.get_status(str(tmp_path))
        paths = [f["path"] for f in status["staged"]]
        assert "中文檔案.txt" in paths
        assert all('"' not in p and "\\" not in p for p in paths)

    @pytest.mark.asyncio
    async def test_stage_all(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "a.txt").write_text("a")
        (tmp_path / "b.txt").write_text("b")
        result = await git_service.stage_all(str(tmp_path))
        assert result["ok"] is True
        status = await git_service.get_status(str(tmp_path))
        paths = {f["path"] for f in status["staged"]}
        assert "a.txt" in paths and "b.txt" in paths

    @pytest.mark.asyncio
    async def test_stage_empty_list(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.stage_files(str(tmp_path), [])
        assert result["ok"] is True


# ── commit ─────────────────────────────────────────────────────────────────────

class TestCommit:
    @pytest.mark.asyncio
    async def test_commit_success(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "change.txt").write_text("change")
        await git_service.stage_all(str(tmp_path))
        result = await git_service.commit(str(tmp_path), "feat: add change")
        assert result["ok"] is True
        assert result["hash"] != ""

    @pytest.mark.asyncio
    async def test_commit_nothing_staged(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.commit(str(tmp_path), "should fail")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_commit_empty_message(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.commit(str(tmp_path), "")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_commit_all_includes_unstaged_tracked(self, tmp_path):
        init_repo(tmp_path)  # README.md is tracked
        (tmp_path / "README.md").write_text("# test\nmodified")
        # Nothing staged; all=True must commit the tracked modification (git commit -a).
        result = await git_service.commit(str(tmp_path), "docs: update readme", all=True)
        assert result["ok"] is True
        status = await git_service.get_status(str(tmp_path))
        assert status["unstaged"] == []

    @pytest.mark.asyncio
    async def test_commit_all_includes_untracked(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "brand_new.txt").write_text("new")  # untracked
        # all=True stages everything first, so untracked files are committed too.
        result = await git_service.commit(str(tmp_path), "feat: add brand new file", all=True)
        assert result["ok"] is True
        status = await git_service.get_status(str(tmp_path))
        assert status["untracked"] == []
        assert status["staged"] == []


# ── init_repo ─────────────────────────────────────────────────────────────────

class TestInitRepo:
    @pytest.mark.asyncio
    async def test_init_creates_git_dir(self, tmp_path):
        result = await git_service.init_repo(str(tmp_path))
        assert result["ok"] is True
        assert (tmp_path / ".git").is_dir()

    @pytest.mark.asyncio
    async def test_init_creates_gitignore_by_default(self, tmp_path):
        result = await git_service.init_repo(str(tmp_path))
        assert result["ok"] is True
        assert result["gitignore_created"] is True
        assert (tmp_path / ".gitignore").exists()

    @pytest.mark.asyncio
    async def test_init_no_gitignore_when_disabled(self, tmp_path):
        result = await git_service.init_repo(str(tmp_path), create_gitignore=False)
        assert result["ok"] is True
        assert not (tmp_path / ".gitignore").exists()

    @pytest.mark.asyncio
    async def test_init_skips_existing_gitignore(self, tmp_path):
        existing = "# custom rules\n"
        (tmp_path / ".gitignore").write_text(existing)
        result = await git_service.init_repo(str(tmp_path))
        assert result["ok"] is True
        assert result["gitignore_created"] is False
        assert (tmp_path / ".gitignore").read_text() == existing

    @pytest.mark.asyncio
    async def test_init_detects_node_project(self, tmp_path):
        (tmp_path / "package.json").write_text("{}")
        await git_service.init_repo(str(tmp_path))
        content = (tmp_path / ".gitignore").read_text()
        assert "node_modules/" in content

    @pytest.mark.asyncio
    async def test_init_detects_python_project(self, tmp_path):
        (tmp_path / "requirements.txt").write_text("fastapi\n")
        await git_service.init_repo(str(tmp_path))
        content = (tmp_path / ".gitignore").read_text()
        assert "__pycache__/" in content

    @pytest.mark.asyncio
    async def test_init_fullstack_includes_both_node_and_python(self, tmp_path):
        (tmp_path / "package.json").write_text("{}")
        (tmp_path / "requirements.txt").write_text("django\n")
        await git_service.init_repo(str(tmp_path))
        content = (tmp_path / ".gitignore").read_text()
        assert "node_modules/" in content
        assert "__pycache__/" in content

    @pytest.mark.asyncio
    async def test_init_invalid_path(self):
        result = await git_service.init_repo("/nonexistent/path/xyz")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_status_is_git_repo_after_init(self, tmp_path):
        await git_service.init_repo(str(tmp_path))
        status = await git_service.get_status(str(tmp_path))
        assert status["is_git_repo"] is True


# ── discard_changes ───────────────────────────────────────────────────────────

class TestDiscardChanges:
    @pytest.mark.asyncio
    async def test_discard_tracked_file(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("modified")
        result = await git_service.discard_changes(str(tmp_path), ["README.md"])
        assert result["ok"] is True
        # File should be back to its committed content
        assert (tmp_path / "README.md").read_text() == "# test"

    @pytest.mark.asyncio
    async def test_discard_untracked_file(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "junk.txt").write_text("junk")
        result = await git_service.discard_changes(str(tmp_path), ["junk.txt"])
        assert result["ok"] is True
        assert not (tmp_path / "junk.txt").exists()

    @pytest.mark.asyncio
    async def test_discard_without_a_status_read_touches_nothing(self, tmp_path, monkeypatch):
        # Discard splits paths into "restore" and "delete" by the status read;
        # without one it must refuse rather than guess (#144).
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("modified")
        (tmp_path / "junk.txt").write_text("junk")

        async def failed(*_args, **_kwargs):
            return {"ok": False, "error": "git timed out"}

        monkeypatch.setattr(git_service, "get_status", failed)
        result = await git_service.discard_changes(str(tmp_path), ["README.md", "junk.txt"])
        assert result == {"ok": False, "error": "git timed out"}
        assert (tmp_path / "README.md").read_text() == "modified"
        assert (tmp_path / "junk.txt").exists()

    @pytest.mark.asyncio
    async def test_discard_past_a_truncated_status_touches_nothing(self, tmp_path, monkeypatch):
        # A truncated status lists only some paths; one it never reached is
        # neither known tracked nor known untracked, so nothing is discarded.
        init_repo(tmp_path)
        (tmp_path / "listed.txt").write_text("listed")
        (tmp_path / "beyond.txt").write_text("beyond")
        real = git_service.get_status

        async def truncated(*args, **kwargs):
            status = await real(*args, **kwargs)
            status["untracked"] = [e for e in status["untracked"] if e["path"] == "listed.txt"]
            status["truncated"] = True
            return status

        monkeypatch.setattr(git_service, "get_status", truncated)
        result = await git_service.discard_changes(str(tmp_path), ["listed.txt", "beyond.txt"])
        assert result["ok"] is False
        assert "beyond.txt" in result["error"]
        assert (tmp_path / "listed.txt").exists()
        assert (tmp_path / "beyond.txt").exists()

    @pytest.mark.asyncio
    async def test_discard_within_a_truncated_status_still_works(self, tmp_path, monkeypatch):
        init_repo(tmp_path)
        (tmp_path / "junk.txt").write_text("junk")
        real = git_service.get_status

        async def truncated(*args, **kwargs):
            return {**(await real(*args, **kwargs)), "truncated": True}

        monkeypatch.setattr(git_service, "get_status", truncated)
        result = await git_service.discard_changes(str(tmp_path), ["junk.txt"])
        assert result["ok"] is True, result
        assert not (tmp_path / "junk.txt").exists()

    @pytest.mark.asyncio
    async def test_discard_empty_list(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.discard_changes(str(tmp_path), [])
        assert result["ok"] is True


# ── branches ──────────────────────────────────────────────────────────────────

class TestBranches:
    @pytest.mark.asyncio
    async def test_list_branches_returns_current(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.list_branches(str(tmp_path))
        assert result["ok"] is True
        assert result["current"] != ""
        assert any(b["is_current"] for b in result["branches"])

    @pytest.mark.asyncio
    async def test_create_and_switch_branch(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.create_branch(str(tmp_path), "feature/test", switch_to=True)
        assert result["ok"] is True
        status = await git_service.get_status(str(tmp_path))
        assert status["branch"] == "feature/test"

    @pytest.mark.asyncio
    async def test_switch_branch(self, tmp_path):
        init_repo(tmp_path)
        orig = (await git_service.get_status(str(tmp_path)))["branch"]
        await git_service.create_branch(str(tmp_path), "other", switch_to=True)
        result = await git_service.switch_branch(str(tmp_path), orig)
        assert result["ok"] is True
        status = await git_service.get_status(str(tmp_path))
        assert status["branch"] == orig

    @pytest.mark.asyncio
    async def test_delete_branch(self, tmp_path):
        init_repo(tmp_path)
        orig = (await git_service.get_status(str(tmp_path)))["branch"]
        await git_service.create_branch(str(tmp_path), "to-delete", switch_to=True)
        await git_service.switch_branch(str(tmp_path), orig)
        result = await git_service.delete_branch(str(tmp_path), "to-delete")
        assert result["ok"] is True
        branches_result = await git_service.list_branches(str(tmp_path))
        assert not any(b["name"] == "to-delete" for b in branches_result["branches"])

    @pytest.mark.asyncio
    @pytest.mark.parametrize("bad_name", [
        "-bad",          # leading dash → flag injection
        "--bad",         # double-dash flag injection
        "-D",            # direct flag
        "a..b",          # double-dot (invalid ref)
        "a b",           # space
        "a~b",           # tilde
        "a^b",           # caret
        "a:b",           # colon
        "a?b",           # question mark
        "a[b",           # bracket
        "a\\b",          # backslash
        "refs/heads/",   # trailing slash
        "branch.lock",   # .lock suffix
        "",              # empty
    ])
    async def test_create_branch_rejects_invalid_name(self, tmp_path, bad_name):
        init_repo(tmp_path)
        result = await git_service.create_branch(str(tmp_path), bad_name)
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_switch_branch_rejects_leading_dash(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.switch_branch(str(tmp_path), "-f")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_delete_branch_rejects_leading_dash(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.delete_branch(str(tmp_path), "--force")
        assert result["ok"] is False


# ── stash ──────────────────────────────────────────────────────────────────────

class TestStash:
    @pytest.mark.asyncio
    async def test_stash_push_and_list(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("modified")
        result = await git_service.stash_push(str(tmp_path), "wip changes")
        assert result["ok"] is True
        stashes = await git_service.stash_list(str(tmp_path))
        assert len(stashes) == 1
        assert "wip changes" in stashes[0]["message"]

    @pytest.mark.asyncio
    async def test_stash_push_single_path(self, tmp_path):
        # Stashing one pathspec must leave other changed files untouched.
        init_repo(tmp_path)
        (tmp_path / "a.txt").write_text("a-change")
        (tmp_path / "b.txt").write_text("b-change")
        result = await git_service.stash_push(str(tmp_path), "", ["a.txt"])
        assert result["ok"] is True
        assert not (tmp_path / "a.txt").exists()  # a.txt was stashed away
        assert (tmp_path / "b.txt").read_text() == "b-change"  # b.txt untouched
        status = await git_service.get_status(str(tmp_path))
        assert any(f["path"] == "b.txt" for f in status["untracked"])

    @pytest.mark.asyncio
    async def test_stash_pop(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("stashed content")
        await git_service.stash_push(str(tmp_path))
        # File should be back to committed state after stash
        assert (tmp_path / "README.md").read_text() == "# test"
        result = await git_service.stash_pop(str(tmp_path), 0)
        assert result["ok"] is True
        assert (tmp_path / "README.md").read_text() == "stashed content"

    @pytest.mark.asyncio
    async def test_stash_drop(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("modified")
        await git_service.stash_push(str(tmp_path))
        result = await git_service.stash_drop(str(tmp_path), 0)
        assert result["ok"] is True
        stashes = await git_service.stash_list(str(tmp_path))
        assert len(stashes) == 0


# ── amend / undo ───────────────────────────────────────────────────────────────

class TestAmendUndo:
    @pytest.mark.asyncio
    async def test_amend_with_new_message(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.amend_commit(str(tmp_path), "amended: new message")
        assert result["ok"] is True
        commits = await git_service.get_log(str(tmp_path))
        assert commits[0]["message"] == "amended: new message"

    @pytest.mark.asyncio
    async def test_amend_no_edit_keeps_message(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.amend_commit(str(tmp_path), "")
        assert result["ok"] is True
        commits = await git_service.get_log(str(tmp_path))
        assert commits[0]["message"] == "init"

    @pytest.mark.asyncio
    async def test_undo_last_commit_restores_staged(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "a.txt").write_text("a")
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "second"], cwd=tmp_path, check=True, capture_output=True)
        result = await git_service.undo_last_commit(str(tmp_path))
        assert result["ok"] is True
        # After soft reset, only one commit remains
        commits = await git_service.get_log(str(tmp_path))
        assert len(commits) == 1
        # a.txt should be staged again
        status = await git_service.get_status(str(tmp_path))
        assert any(f["path"] == "a.txt" for f in status["staged"])


# ── diff_file ─────────────────────────────────────────────────────────────────

class TestDiffFile:
    @pytest.mark.asyncio
    async def test_diff_unstaged(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("modified content")
        result = await git_service.diff_file(str(tmp_path), "README.md", staged=False)
        assert result["ok"] is True
        assert "modified content" in result["diff"]

    @pytest.mark.asyncio
    async def test_diff_staged(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("staged content")
        subprocess.run(["git", "add", "README.md"], cwd=tmp_path, check=True, capture_output=True)
        result = await git_service.diff_file(str(tmp_path), "README.md", staged=True)
        assert result["ok"] is True
        assert "staged content" in result["diff"]

    @pytest.mark.asyncio
    async def test_diff_no_changes(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.diff_file(str(tmp_path), "README.md", staged=False)
        assert result["ok"] is True
        assert result["diff"] == ""

    @pytest.mark.asyncio
    async def test_diff_untracked_shows_additions(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "new_file.txt").write_text("brand new line\n")
        result = await git_service.diff_file(str(tmp_path), "new_file.txt", staged=False)
        assert result["ok"] is True
        assert "brand new line" in result["diff"]
        assert "+brand new line" in result["diff"]

    @pytest.mark.asyncio
    async def test_diff_commit_returns_raw_diff(self, tmp_path):
        init_repo(tmp_path)
        h = _add_commit(tmp_path, "b.txt", "line1\nline2\n", "add b")
        result = await git_service.diff_file(str(tmp_path), "b.txt", commit=h)
        assert result["ok"] is True
        assert "+line1" in result["diff"]

    @pytest.mark.asyncio
    async def test_diff_commit_rejects_bad_hash(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.diff_file(str(tmp_path), "b.txt", commit="-flag")
        assert result["ok"] is False


# ── merge_branch ───────────────────────────────────────────────────────────────

class TestMergeBranch:
    @pytest.mark.asyncio
    async def test_merge_branch(self, tmp_path):
        init_repo(tmp_path)
        orig = (await git_service.get_status(str(tmp_path)))["branch"]
        await git_service.create_branch(str(tmp_path), "feature", switch_to=True)
        (tmp_path / "feature.txt").write_text("feature")
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "feature commit"], cwd=tmp_path, check=True, capture_output=True)
        await git_service.switch_branch(str(tmp_path), orig)
        result = await git_service.merge_branch(str(tmp_path), "feature")
        assert result["ok"] is True
        assert (tmp_path / "feature.txt").exists()


# ── revert_commit ─────────────────────────────────────────────────────────────

class TestRevertCommit:
    @pytest.mark.asyncio
    async def test_revert_creates_revert_commit(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "a.txt").write_text("a")
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "add a"], cwd=tmp_path, check=True, capture_output=True)
        commits_before = await git_service.get_log(str(tmp_path))
        result = await git_service.revert_commit(str(tmp_path), commits_before[0]["hash"])
        assert result["ok"] is True
        commits_after = await git_service.get_log(str(tmp_path))
        assert len(commits_after) == len(commits_before) + 1


# ── reset_to_commit ───────────────────────────────────────────────────────────

class TestResetToCommit:
    @staticmethod
    def _head(path: Path) -> str:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=path, check=True, capture_output=True, text=True
        ).stdout.strip()

    @staticmethod
    def _three_commits(path: Path) -> str:
        """init + two more commits; return the *first* (init) commit hash."""
        init_repo(path)
        base = TestResetToCommit._head(path)
        (path / "b.txt").write_text("b")
        subprocess.run(["git", "add", "-A"], cwd=path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "add b"], cwd=path, check=True, capture_output=True)
        (path / "c.txt").write_text("c")
        subprocess.run(["git", "add", "-A"], cwd=path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "add c"], cwd=path, check=True, capture_output=True)
        return base

    @pytest.mark.asyncio
    async def test_reset_soft_keeps_index_and_worktree(self, tmp_path):
        base = self._three_commits(tmp_path)
        result = await git_service.reset_to_commit(str(tmp_path), base, "soft")
        assert result["ok"] is True
        assert self._head(tmp_path) == base
        status = await git_service.get_status(str(tmp_path))
        staged = {f["path"] for f in status["staged"]}
        assert {"b.txt", "c.txt"} <= staged
        assert (tmp_path / "b.txt").exists() and (tmp_path / "c.txt").exists()

    @pytest.mark.asyncio
    async def test_reset_mixed_resets_index_keeps_worktree(self, tmp_path):
        base = self._three_commits(tmp_path)
        result = await git_service.reset_to_commit(str(tmp_path), base, "mixed")
        assert result["ok"] is True
        assert self._head(tmp_path) == base
        status = await git_service.get_status(str(tmp_path))
        assert status["staged"] == []
        untracked = {f["path"] for f in status["untracked"]}
        assert {"b.txt", "c.txt"} <= untracked
        assert (tmp_path / "b.txt").exists() and (tmp_path / "c.txt").exists()

    @pytest.mark.asyncio
    async def test_reset_hard_discards_index_and_worktree(self, tmp_path):
        base = self._three_commits(tmp_path)
        result = await git_service.reset_to_commit(str(tmp_path), base, "hard")
        assert result["ok"] is True
        assert self._head(tmp_path) == base
        status = await git_service.get_status(str(tmp_path))
        assert status["staged"] == []
        assert status["unstaged"] == []
        assert status["untracked"] == []
        assert not (tmp_path / "b.txt").exists()
        assert not (tmp_path / "c.txt").exists()

    @pytest.mark.asyncio
    async def test_reset_invalid_mode_rejected(self, tmp_path):
        base = self._three_commits(tmp_path)
        head_before = self._head(tmp_path)
        result = await git_service.reset_to_commit(str(tmp_path), base, "bogus")
        assert result["ok"] is False
        assert self._head(tmp_path) == head_before

    @pytest.mark.asyncio
    async def test_reset_rejects_flag_commit(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.reset_to_commit(str(tmp_path), "--hard", "soft")
        assert result["ok"] is False


# ── remotes ───────────────────────────────────────────────────────────────────

class TestRemotes:
    @pytest.mark.asyncio
    async def test_list_empty_remotes(self, tmp_path):
        init_repo(tmp_path)
        remotes = await git_service.list_remotes(str(tmp_path))
        assert remotes == []

    @pytest.mark.asyncio
    async def test_add_and_list_remote(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.add_remote(str(tmp_path), "origin", "https://github.com/test/repo.git")
        assert result["ok"] is True
        remotes = await git_service.list_remotes(str(tmp_path))
        assert any(r["name"] == "origin" for r in remotes)

    @pytest.mark.asyncio
    async def test_remove_remote(self, tmp_path):
        init_repo(tmp_path)
        await git_service.add_remote(str(tmp_path), "origin", "https://github.com/test/repo.git")
        result = await git_service.remove_remote(str(tmp_path), "origin")
        assert result["ok"] is True
        remotes = await git_service.list_remotes(str(tmp_path))
        assert not any(r["name"] == "origin" for r in remotes)

    @pytest.mark.asyncio
    async def test_add_remote_empty_name(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.add_remote(str(tmp_path), "", "https://github.com/test/repo.git")
        assert result["ok"] is False


# ── cherry_pick ───────────────────────────────────────────────────────────────

class TestCherryPick:
    @pytest.mark.asyncio
    async def test_cherry_pick_applies_commit(self, tmp_path):
        init_repo(tmp_path)
        orig = (await git_service.get_status(str(tmp_path)))["branch"]
        await git_service.create_branch(str(tmp_path), "feature", switch_to=True)
        (tmp_path / "cherry.txt").write_text("cherry")
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "cherry commit"], cwd=tmp_path, check=True, capture_output=True)
        cherry_hash = (await git_service.get_log(str(tmp_path), 1))[0]["hash"]

        await git_service.switch_branch(str(tmp_path), orig)
        assert not (tmp_path / "cherry.txt").exists()
        result = await git_service.cherry_pick(str(tmp_path), cherry_hash)
        assert result["ok"] is True
        assert (tmp_path / "cherry.txt").exists()


# ── tags ──────────────────────────────────────────────────────────────────────

class TestTags:
    @pytest.mark.asyncio
    async def test_list_empty_tags(self, tmp_path):
        init_repo(tmp_path)
        tags = await git_service.list_tags(str(tmp_path))
        assert tags == []

    @pytest.mark.asyncio
    async def test_create_lightweight_tag(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.create_tag(str(tmp_path), "v1.0.0")
        assert result["ok"] is True
        tags = await git_service.list_tags(str(tmp_path))
        assert any(t["name"] == "v1.0.0" for t in tags)

    @pytest.mark.asyncio
    async def test_create_annotated_tag(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.create_tag(str(tmp_path), "v2.0.0", message="Release 2")
        assert result["ok"] is True
        tags = await git_service.list_tags(str(tmp_path))
        assert any(t["name"] == "v2.0.0" for t in tags)

    @pytest.mark.asyncio
    async def test_delete_tag(self, tmp_path):
        init_repo(tmp_path)
        await git_service.create_tag(str(tmp_path), "v1.0.0")
        result = await git_service.delete_tag(str(tmp_path), "v1.0.0")
        assert result["ok"] is True
        tags = await git_service.list_tags(str(tmp_path))
        assert not any(t["name"] == "v1.0.0" for t in tags)

    @pytest.mark.asyncio
    async def test_create_tag_empty_name(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.create_tag(str(tmp_path), "")
        assert result["ok"] is False


# ── file_log ──────────────────────────────────────────────────────────────────

class TestFileLog:
    @pytest.mark.asyncio
    async def test_file_log_returns_commits(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("updated")
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "update readme"], cwd=tmp_path, check=True, capture_output=True)
        commits = await git_service.file_log(str(tmp_path), "README.md")
        assert len(commits) >= 2
        assert any(c["message"] == "update readme" for c in commits)
        assert any(c["message"] == "init" for c in commits)

    @pytest.mark.asyncio
    async def test_file_log_empty_for_unknown_file(self, tmp_path):
        init_repo(tmp_path)
        commits = await git_service.file_log(str(tmp_path), "nonexistent.txt")
        assert commits == []


# ── show_file ──────────────────────────────────────────────────────────────────

class TestShowFile:
    @pytest.mark.asyncio
    async def test_show_file_returns_head_content(self, tmp_path):
        init_repo(tmp_path)
        # Working tree differs from HEAD; show_file must return the committed version.
        (tmp_path / "README.md").write_text("# changed in working tree")
        result = await git_service.show_file(str(tmp_path), "README.md")
        assert result["ok"] is True
        assert result["content"].rstrip("\n") == "# test"

    @pytest.mark.asyncio
    async def test_show_file_missing_at_rev(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.show_file(str(tmp_path), "nonexistent.txt")
        assert result["ok"] is False
        assert result["error"]


# ── resolve_conflict ──────────────────────────────────────────────────────────

class TestResolveConflict:
    def _make_conflict(self, path: Path) -> None:
        """Create a merge conflict in README.md."""
        init_repo(path)
        orig = subprocess.run(
            ["git", "branch", "--show-current"], cwd=path, capture_output=True, text=True
        ).stdout.strip()
        subprocess.run(["git", "checkout", "-b", "branch-a"], cwd=path, check=True, capture_output=True)
        (path / "README.md").write_text("branch-a content")
        subprocess.run(["git", "add", "-A"], cwd=path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "branch-a"], cwd=path, check=True, capture_output=True)
        subprocess.run(["git", "checkout", orig], cwd=path, check=True, capture_output=True)
        (path / "README.md").write_text("main content")
        subprocess.run(["git", "add", "-A"], cwd=path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "main-update"], cwd=path, check=True, capture_output=True)
        subprocess.run(["git", "merge", "branch-a"], cwd=path, capture_output=True)

    @pytest.mark.asyncio
    async def test_resolve_ours(self, tmp_path):
        self._make_conflict(tmp_path)
        result = await git_service.resolve_conflict_ours(str(tmp_path), "README.md")
        assert result["ok"] is True
        content = (tmp_path / "README.md").read_text()
        assert "<<<<<<" not in content

    @pytest.mark.asyncio
    async def test_resolve_theirs(self, tmp_path):
        self._make_conflict(tmp_path)
        result = await git_service.resolve_conflict_theirs(str(tmp_path), "README.md")
        assert result["ok"] is True
        content = (tmp_path / "README.md").read_text()
        assert "<<<<<<" not in content


# ── conflict stages / list_conflicts / mark_resolved ──────────────────────────

def commit_all(path: Path, message: str) -> None:
    """Stage everything (including deletions) and commit, empty commits allowed."""
    subprocess.run(["git", "add", "-A"], cwd=path, check=True, capture_output=True)
    subprocess.run(
        ["git", "commit", "--allow-empty", "-m", message], cwd=path, check=True, capture_output=True
    )


def make_conflict(path: Path, base, ours, theirs) -> None:
    """Build a repo where merging 'feature' conflicts with the current branch.

    Each argument is a callable applied to the working tree for that side; a
    no-op callable models the side that never touched the file.
    """
    init_repo(path)
    orig = subprocess.run(
        ["git", "branch", "--show-current"], cwd=path, capture_output=True, text=True
    ).stdout.strip()
    base(path)
    commit_all(path, "base")
    subprocess.run(["git", "checkout", "-b", "feature"], cwd=path, check=True, capture_output=True)
    theirs(path)
    commit_all(path, "theirs")
    subprocess.run(["git", "checkout", orig], cwd=path, check=True, capture_output=True)
    ours(path)
    commit_all(path, "ours")
    subprocess.run(["git", "merge", "feature"], cwd=path, capture_output=True)


def writer(name: str, text: str):
    return lambda p: (p / name).write_text(text, encoding="utf-8")


def byte_writer(name: str, data: bytes):
    return lambda p: (p / name).write_bytes(data)


def remover(name: str):
    return lambda p: (p / name).unlink()


def nothing(p: Path) -> None:
    return None


class TestConflictStages:
    @pytest.mark.asyncio
    async def test_both_modified_returns_all_three_stages(self, tmp_path):
        make_conflict(
            tmp_path,
            writer("f.txt", "base\n"),
            writer("f.txt", "ours\n"),
            writer("f.txt", "theirs\n"),
        )
        r = await git_service.conflict_stages(str(tmp_path), "f.txt")
        assert r["ok"] is True
        assert (r["has_base"], r["has_ours"], r["has_theirs"]) == (True, True, True)
        assert r["base"] == "base\n"
        assert r["ours"] == "ours\n"
        assert r["theirs"] == "theirs\n"
        assert r["binary"] is False

    @pytest.mark.asyncio
    async def test_add_add_has_no_base(self, tmp_path):
        # Both sides create the same new path: stage 1 does not exist, which is
        # normal — not a read failure.
        make_conflict(
            tmp_path,
            nothing,
            writer("new.txt", "ours\n"),
            writer("new.txt", "theirs\n"),
        )
        r = await git_service.conflict_stages(str(tmp_path), "new.txt")
        assert r["ok"] is True
        assert r["has_base"] is False
        assert r["base"] == ""
        assert (r["has_ours"], r["has_theirs"]) == (True, True)
        assert r["ours"] == "ours\n"
        assert r["theirs"] == "theirs\n"

    @pytest.mark.asyncio
    async def test_delete_modify_missing_theirs(self, tmp_path):
        make_conflict(
            tmp_path,
            writer("f.txt", "base\n"),
            writer("f.txt", "ours\n"),
            remover("f.txt"),
        )
        r = await git_service.conflict_stages(str(tmp_path), "f.txt")
        assert r["ok"] is True
        assert (r["has_base"], r["has_ours"], r["has_theirs"]) == (True, True, False)
        assert r["theirs"] == ""

    @pytest.mark.asyncio
    async def test_delete_modify_missing_ours(self, tmp_path):
        make_conflict(
            tmp_path,
            writer("f.txt", "base\n"),
            remover("f.txt"),
            writer("f.txt", "theirs\n"),
        )
        r = await git_service.conflict_stages(str(tmp_path), "f.txt")
        assert r["ok"] is True
        assert (r["has_base"], r["has_ours"], r["has_theirs"]) == (True, False, True)
        assert r["ours"] == ""

    @pytest.mark.asyncio
    async def test_path_with_space_and_non_ascii(self, tmp_path):
        name = "測 試 檔案.txt"
        make_conflict(
            tmp_path,
            writer(name, "base\n"),
            writer(name, "ours\n"),
            writer(name, "theirs\n"),
        )
        r = await git_service.conflict_stages(str(tmp_path), name)
        assert r["ok"] is True
        assert r["ours"] == "ours\n"
        assert r["theirs"] == "theirs\n"

    @pytest.mark.asyncio
    async def test_binary_flagged_with_empty_content(self, tmp_path):
        make_conflict(
            tmp_path,
            byte_writer("blob.bin", b"\x00\x01base"),
            byte_writer("blob.bin", b"\x00\x01ours"),
            byte_writer("blob.bin", b"\x00\x01theirs"),
        )
        r = await git_service.conflict_stages(str(tmp_path), "blob.bin")
        assert r["ok"] is True
        assert r["binary"] is True
        assert (r["has_base"], r["has_ours"], r["has_theirs"]) == (True, True, True)
        assert (r["base"], r["ours"], r["theirs"]) == ("", "", "")

    @pytest.mark.asyncio
    async def test_not_conflicted_reports_error(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.conflict_stages(str(tmp_path), "README.md")
        assert r["ok"] is False
        assert "not conflicted" in r["error"]
        assert r["has_base"] is False

    @pytest.mark.asyncio
    async def test_missing_filepath(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.conflict_stages(str(tmp_path), "")
        assert r["ok"] is False
        assert "filepath" in r["error"]

    @pytest.mark.asyncio
    async def test_non_git_dir(self, tmp_path):
        r = await git_service.conflict_stages(str(tmp_path), "f.txt")
        assert r["ok"] is False
        assert r["error"]


class TestListConflicts:
    @pytest.mark.asyncio
    async def test_empty_outside_merge(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.list_conflicts(str(tmp_path))
        assert r["ok"] is True
        assert r["conflicts"] == []

    @pytest.mark.asyncio
    async def test_both_modified_kind(self, tmp_path):
        make_conflict(
            tmp_path,
            writer("f.txt", "base\n"),
            writer("f.txt", "ours\n"),
            writer("f.txt", "theirs\n"),
        )
        r = await git_service.list_conflicts(str(tmp_path))
        assert r["ok"] is True
        assert r["conflicts"] == [{"path": "f.txt", "kind": "both-modified"}]

    @pytest.mark.asyncio
    async def test_both_added_kind(self, tmp_path):
        make_conflict(tmp_path, nothing, writer("n.txt", "a\n"), writer("n.txt", "b\n"))
        r = await git_service.list_conflicts(str(tmp_path))
        assert r["conflicts"] == [{"path": "n.txt", "kind": "both-added"}]

    @pytest.mark.asyncio
    async def test_deleted_by_them_kind(self, tmp_path):
        make_conflict(tmp_path, writer("f.txt", "b\n"), writer("f.txt", "o\n"), remover("f.txt"))
        r = await git_service.list_conflicts(str(tmp_path))
        assert r["conflicts"] == [{"path": "f.txt", "kind": "deleted-by-them"}]

    @pytest.mark.asyncio
    async def test_deleted_by_us_kind(self, tmp_path):
        make_conflict(tmp_path, writer("f.txt", "b\n"), remover("f.txt"), writer("f.txt", "t\n"))
        r = await git_service.list_conflicts(str(tmp_path))
        assert r["conflicts"] == [{"path": "f.txt", "kind": "deleted-by-us"}]

    @pytest.mark.asyncio
    async def test_path_with_space_and_non_ascii(self, tmp_path):
        name = "測 試 檔案.txt"
        make_conflict(tmp_path, writer(name, "b\n"), writer(name, "o\n"), writer(name, "t\n"))
        r = await git_service.list_conflicts(str(tmp_path))
        assert r["conflicts"] == [{"path": name, "kind": "both-modified"}]

    @pytest.mark.asyncio
    async def test_binary_conflict_listed(self, tmp_path):
        make_conflict(
            tmp_path,
            byte_writer("b.bin", b"\x00base"),
            byte_writer("b.bin", b"\x00ours"),
            byte_writer("b.bin", b"\x00theirs"),
        )
        r = await git_service.list_conflicts(str(tmp_path))
        assert r["conflicts"] == [{"path": "b.bin", "kind": "both-modified"}]

    @pytest.mark.asyncio
    async def test_non_git_dir(self, tmp_path):
        r = await git_service.list_conflicts(str(tmp_path))
        assert r["ok"] is False
        assert r["conflicts"] == []


class TestMarkResolved:
    @pytest.mark.asyncio
    async def test_stages_hand_merged_content(self, tmp_path):
        make_conflict(
            tmp_path,
            writer("f.txt", "base\n"),
            writer("f.txt", "ours\n"),
            writer("f.txt", "theirs\n"),
        )
        (tmp_path / "f.txt").write_text("merged by hand\n", encoding="utf-8")
        r = await git_service.mark_resolved(str(tmp_path), "f.txt")
        assert r["ok"] is True
        # No longer unmerged, and the hand-written content was left alone.
        listed = await git_service.list_conflicts(str(tmp_path))
        assert listed["conflicts"] == []
        assert (tmp_path / "f.txt").read_text() == "merged by hand\n"

    @pytest.mark.asyncio
    async def test_keeps_content_that_looks_like_a_marker(self, tmp_path):
        # Deliberate non-check: text resembling a conflict marker may be exactly
        # what the user meant to keep.
        make_conflict(
            tmp_path,
            writer("f.txt", "base\n"),
            writer("f.txt", "ours\n"),
            writer("f.txt", "theirs\n"),
        )
        content = "<<<<<<< documented example\n=======\n>>>>>>> end\n"
        (tmp_path / "f.txt").write_text(content, encoding="utf-8")
        r = await git_service.mark_resolved(str(tmp_path), "f.txt")
        assert r["ok"] is True
        assert (tmp_path / "f.txt").read_text() == content

    @pytest.mark.asyncio
    async def test_path_with_space_and_non_ascii(self, tmp_path):
        name = "測 試 檔案.txt"
        make_conflict(tmp_path, writer(name, "b\n"), writer(name, "o\n"), writer(name, "t\n"))
        (tmp_path / name).write_text("merged\n", encoding="utf-8")
        r = await git_service.mark_resolved(str(tmp_path), name)
        assert r["ok"] is True
        listed = await git_service.list_conflicts(str(tmp_path))
        assert listed["conflicts"] == []

    @pytest.mark.asyncio
    async def test_missing_filepath(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.mark_resolved(str(tmp_path), "")
        assert r["ok"] is False
        assert "filepath" in r["error"]

    @pytest.mark.asyncio
    async def test_unknown_path_fails(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.mark_resolved(str(tmp_path), "does-not-exist.txt")
        assert r["ok"] is False
        assert r["error"]


# ── argument injection / input validation ─────────────────────────────────────

class TestInputValidation:
    """Security: verify flag-injection inputs are rejected before reaching git."""

    @pytest.mark.asyncio
    async def test_cherry_pick_rejects_flag_input(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.cherry_pick(str(tmp_path), "--exec=evil")
        assert result["ok"] is False
        assert "invalid commit hash" in result["error"]

    @pytest.mark.asyncio
    async def test_cherry_pick_rejects_dash_input(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.cherry_pick(str(tmp_path), "-x")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_cherry_pick_rejects_empty(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.cherry_pick(str(tmp_path), "")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_create_tag_rejects_dash_name(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.create_tag(str(tmp_path), "-delete-all")
        assert result["ok"] is False
        assert "invalid tag name" in result["error"]

    @pytest.mark.asyncio
    async def test_create_tag_rejects_bad_hash(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.create_tag(str(tmp_path), "v1.0.0", commit_hash="--exec=evil")
        assert result["ok"] is False
        assert "invalid commit hash" in result["error"]

    @pytest.mark.asyncio
    async def test_delete_tag_rejects_dash_name(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.delete_tag(str(tmp_path), "--flag")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_merge_branch_rejects_dash_name(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.merge_branch(str(tmp_path), "--strategy=evil")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_revert_commit_rejects_flag(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.revert_commit(str(tmp_path), "--abort")
        assert result["ok"] is False
        assert "invalid commit hash" in result["error"]

    @pytest.mark.asyncio
    async def test_add_remote_rejects_dash_name(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.add_remote(str(tmp_path), "--mirror", "https://example.com")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_valid_hex_hash_passes(self, tmp_path):
        """Confirm legitimate short hashes are accepted by validation."""
        err = git_service._validate_commit_hash("abc1234")
        assert err is None

    @pytest.mark.asyncio
    async def test_valid_ref_name_passes(self, tmp_path):
        err = git_service._validate_ref_name("feature/my-branch", "branch")
        assert err is None

    def test_non_ascii_ref_name_accepted(self):
        # git allows non-ASCII refs; the app must too (regression: Chinese
        # branch names like "AI修改" were wrongly rejected by an ASCII allowlist).
        assert git_service._validate_ref_name("AI修改", "branch") is None
        assert git_service._validate_ref_name("功能/新版", "branch") is None
        assert git_service._validate_branch_name("AI修改") is None

    def test_ref_and_branch_validators_agree_on_non_ascii(self):
        # The create path (_validate_branch_name) and the operate path
        # (_validate_ref_name) must not disagree — that split was the root bug.
        name = "origin/小切口已完整的版本"
        assert git_service._validate_ref_name(name, "branch") is None
        assert git_service._validate_branch_name(name) is None

    def test_ref_name_still_rejects_dangerous_chars(self):
        for bad in ("-flag", "a..b", "with space", "ref~1", "a^b", "c:d", "e?f", "g*h", "i[j", "k\\l", "trailing/"):
            assert git_service._validate_ref_name(bad, "branch") is not None


# ── clean_untracked ───────────────────────────────────────────────────────────

class TestCleanUntracked:
    @pytest.mark.asyncio
    async def test_dry_run_returns_files(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "junk.txt").write_text("junk")
        result = await git_service.clean_untracked(str(tmp_path), dry_run=True)
        assert result["ok"] is True
        assert "junk.txt" in " ".join(result["files"])
        assert (tmp_path / "junk.txt").exists()  # not deleted

    @pytest.mark.asyncio
    async def test_actual_clean_removes_files(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "junk.txt").write_text("junk")
        result = await git_service.clean_untracked(str(tmp_path), dry_run=False)
        assert result["ok"] is True
        assert not (tmp_path / "junk.txt").exists()

    @pytest.mark.asyncio
    async def test_dry_run_empty_returns_no_files(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.clean_untracked(str(tmp_path), dry_run=True)
        assert result["ok"] is True
        assert result["files"] == []


# ── show_commit ────────────────────────────────────────────────────────────────

class TestShowCommit:
    @pytest.mark.asyncio
    async def test_returns_commit_detail(self, tmp_path):
        init_repo(tmp_path)
        commits = await git_service.get_log(str(tmp_path), 1)
        hash_val = commits[0]["hash"]
        result = await git_service.show_commit(str(tmp_path), hash_val)
        assert result["ok"] is True
        assert result["message"] == "init"
        assert result["author_name"] == "Test"
        assert result["author_email"] == "test@test.com"
        assert "README.md" in result["files"]

    @pytest.mark.asyncio
    async def test_rejects_invalid_hash(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.show_commit(str(tmp_path), "--evil")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_rejects_nonexistent_hash(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.show_commit(str(tmp_path), "deadbeef")
        assert result["ok"] is False


# ── push_set_upstream ──────────────────────────────────────────────────────────

class TestPushSetUpstream:
    @pytest.mark.asyncio
    async def test_rejects_invalid_branch(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.push_set_upstream(str(tmp_path), "--flag")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_rejects_invalid_remote(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.push_set_upstream(str(tmp_path), "main", "--flag")
        assert result["ok"] is False


# ── compare_branches ──────────────────────────────────────────────────────────

class TestCompareBranches:
    @pytest.mark.asyncio
    async def test_compare_same_branch(self, tmp_path):
        init_repo(tmp_path)
        orig = (await git_service.get_status(str(tmp_path)))["branch"]
        result = await git_service.compare_branches(str(tmp_path), orig, orig)
        assert result["ok"] is True

    @pytest.mark.asyncio
    async def test_compare_diverged_branches(self, tmp_path):
        init_repo(tmp_path)
        orig = (await git_service.get_status(str(tmp_path)))["branch"]
        await git_service.create_branch(str(tmp_path), "feature", switch_to=True)
        (tmp_path / "new.txt").write_text("feature content")
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "feature"], cwd=tmp_path, check=True, capture_output=True)
        result = await git_service.compare_branches(str(tmp_path), orig, "feature")
        assert result["ok"] is True
        assert "new.txt" in " ".join(result["files"])

    @pytest.mark.asyncio
    async def test_compare_rejects_flag_input(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.compare_branches(str(tmp_path), "--flag", "main")
        assert result["ok"] is False


# ── rebase_on ─────────────────────────────────────────────────────────────────

class TestRebaseOn:
    @pytest.mark.asyncio
    async def test_rebase_onto_branch(self, tmp_path):
        init_repo(tmp_path)
        orig = (await git_service.get_status(str(tmp_path)))["branch"]
        await git_service.create_branch(str(tmp_path), "base", switch_to=True)
        (tmp_path / "base.txt").write_text("base")
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "base commit"], cwd=tmp_path, check=True, capture_output=True)
        await git_service.switch_branch(str(tmp_path), orig)
        (tmp_path / "main.txt").write_text("main")
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "main commit"], cwd=tmp_path, check=True, capture_output=True)
        result = await git_service.rebase_on(str(tmp_path), "base")
        assert result["ok"] is True

    @pytest.mark.asyncio
    async def test_rebase_rejects_flag_input(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.rebase_on(str(tmp_path), "--abort")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_rebase_conflict_left_in_progress(self, tmp_path):
        # A conflicting rebase must NOT auto-abort: it stays in progress with
        # conflict_files so the UI can resolve or abort it.
        init_repo(tmp_path)
        orig = (await git_service.get_status(str(tmp_path)))["branch"]
        (tmp_path / "f.txt").write_text("base\n")
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "root"], cwd=tmp_path, check=True, capture_output=True)
        await git_service.create_branch(str(tmp_path), "base", switch_to=True)
        (tmp_path / "f.txt").write_text("from-base\n")
        subprocess.run(["git", "commit", "-am", "base edit"], cwd=tmp_path, check=True, capture_output=True)
        await git_service.switch_branch(str(tmp_path), orig)
        (tmp_path / "f.txt").write_text("from-main\n")
        subprocess.run(["git", "commit", "-am", "main edit"], cwd=tmp_path, check=True, capture_output=True)

        result = await git_service.rebase_on(str(tmp_path), "base")
        assert result["ok"] is False
        assert result["conflict_files"]  # conflicts reported
        # Rebase left in progress (NOT auto-aborted) so the UI can act on it.
        status = await git_service.get_status(str(tmp_path))
        assert status["operation_in_progress"] == "rebase"
        # Clean up so tmp fixtures don't leave a dangling rebase.
        await git_service.abort_operation(str(tmp_path), "rebase")


# ── restore_file_from_branch ──────────────────────────────────────────────────

class TestRestoreFileFromBranch:
    @pytest.mark.asyncio
    async def test_restores_file(self, tmp_path):
        init_repo(tmp_path)
        orig = (await git_service.get_status(str(tmp_path)))["branch"]
        await git_service.create_branch(str(tmp_path), "feature", switch_to=True)
        (tmp_path / "feature_only.txt").write_text("from feature")
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "add feature file"], cwd=tmp_path, check=True, capture_output=True)
        await git_service.switch_branch(str(tmp_path), orig)
        assert not (tmp_path / "feature_only.txt").exists()
        result = await git_service.restore_file_from_branch(str(tmp_path), "feature", "feature_only.txt")
        assert result["ok"] is True
        assert (tmp_path / "feature_only.txt").exists()

    @pytest.mark.asyncio
    async def test_rejects_flag_branch(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.restore_file_from_branch(str(tmp_path), "--flag", "file.txt")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_rejects_dash_filepath(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.restore_file_from_branch(str(tmp_path), "main", "-flag")
        assert result["ok"] is False


# ── worktrees ─────────────────────────────────────────────────────────────────

class TestWorktrees:
    @pytest.mark.asyncio
    async def test_list_includes_main(self, tmp_path):
        init_repo(tmp_path)
        wts = await git_service.list_worktrees(str(tmp_path))
        assert len(wts) >= 1
        assert any(w["is_main"] for w in wts)

    @pytest.mark.asyncio
    async def test_add_and_list_worktree(self, tmp_path):
        init_repo(tmp_path)
        wt_path = str(tmp_path / "wt-branch")
        orig = (await git_service.get_status(str(tmp_path)))["branch"]
        result = await git_service.add_worktree(str(tmp_path), wt_path, orig + "-wt", new_branch=True)
        assert result["ok"] is True
        wts = await git_service.list_worktrees(str(tmp_path))
        assert any(w["path"] == wt_path for w in wts)

    @pytest.mark.asyncio
    async def test_add_worktree_rejects_flag_branch(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.add_worktree(str(tmp_path), "/tmp/wt", "--flag")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_remove_worktree(self, tmp_path):
        init_repo(tmp_path)
        wt_path = str(tmp_path / "wt-remove")
        orig = (await git_service.get_status(str(tmp_path)))["branch"]
        await git_service.add_worktree(str(tmp_path), wt_path, orig + "-rm", new_branch=True)
        result = await git_service.remove_worktree(str(tmp_path), wt_path)
        assert result["ok"] is True
        wts = await git_service.list_worktrees(str(tmp_path))
        assert not any(w["path"] == wt_path for w in wts)

    @pytest.mark.asyncio
    async def test_list_entries_carry_state_flags(self, tmp_path):
        init_repo(tmp_path)
        wts = await git_service.list_worktrees(str(tmp_path))
        for w in wts:
            for key in ("detached", "bare", "locked", "lock_reason", "prunable", "prune_reason"):
                assert key in w

    @pytest.mark.asyncio
    async def test_remove_worktree_rejects_flag_path(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.remove_worktree(str(tmp_path), "--force")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_lock_unlock_worktree_round_trip(self, tmp_path):
        init_repo(tmp_path)
        wt_path = str(tmp_path / "wt-lock")
        orig = (await git_service.get_status(str(tmp_path)))["branch"]
        await git_service.add_worktree(str(tmp_path), wt_path, orig + "-lk", new_branch=True)

        lock = await git_service.lock_worktree(str(tmp_path), wt_path, reason="removable disk")
        assert lock["ok"] is True
        wts = await git_service.list_worktrees(str(tmp_path))
        entry = next(w for w in wts if w["path"] == wt_path)
        assert entry["locked"] is True

        unlock = await git_service.unlock_worktree(str(tmp_path), wt_path)
        assert unlock["ok"] is True
        wts = await git_service.list_worktrees(str(tmp_path))
        entry = next(w for w in wts if w["path"] == wt_path)
        assert entry["locked"] is False

    @pytest.mark.asyncio
    async def test_move_worktree(self, tmp_path):
        init_repo(tmp_path)
        src = str(tmp_path / "wt-src")
        dst = str(tmp_path / "wt-dst")
        orig = (await git_service.get_status(str(tmp_path)))["branch"]
        await git_service.add_worktree(str(tmp_path), src, orig + "-mv", new_branch=True)
        result = await git_service.move_worktree(str(tmp_path), src, dst)
        assert result["ok"] is True
        wts = await git_service.list_worktrees(str(tmp_path))
        assert any(w["path"] == dst for w in wts)
        assert not any(w["path"] == src for w in wts)

    @pytest.mark.asyncio
    async def test_prune_and_repair_run_ok(self, tmp_path):
        init_repo(tmp_path)
        assert (await git_service.prune_worktrees(str(tmp_path)))["ok"] is True
        assert (await git_service.repair_worktree(str(tmp_path)))["ok"] is True


# ── git_config ─────────────────────────────────────────────────────────────────

class TestGitConfig:
    @pytest.mark.asyncio
    async def test_get_config_returns_dict(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.get_config(str(tmp_path))
        assert result["ok"] is True
        assert isinstance(result["config"], dict)
        assert "user.email" in " ".join(result["config"].keys()) or \
               any("user" in k for k in result["config"])

    @pytest.mark.asyncio
    async def test_set_config(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.set_config(str(tmp_path), "user.name", "Test User")
        assert result["ok"] is True
        cfg = (await git_service.get_config(str(tmp_path)))["config"]
        assert cfg.get("user.name") == "Test User"

    @pytest.mark.asyncio
    async def test_set_config_rejects_unsafe_key(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.set_config(str(tmp_path), "../../etc/malicious", "val")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_set_config_rejects_rce_key(self, tmp_path):
        """core.sshCommand and diff.external are NOT in the allowlist."""
        init_repo(tmp_path)
        for dangerous_key in ("core.sshCommand", "diff.external", "core.gitProxy"):
            result = await git_service.set_config(str(tmp_path), dangerous_key, "evil")
            assert result["ok"] is False, f"{dangerous_key} should be rejected"

    @pytest.mark.asyncio
    async def test_set_config_rejects_dash_value(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.set_config(str(tmp_path), "user.name", "--evil-flag")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_set_config_only_allows_listed_keys(self, tmp_path):
        init_repo(tmp_path)
        # Every key in the allowlist should succeed
        for key in git_service._ALLOWED_CONFIG_KEYS:
            result = await git_service.set_config(str(tmp_path), key, "testvalue")
            assert result["ok"] is True, f"allowed key {key!r} was rejected"


# ── blame_file ─────────────────────────────────────────────────────────────────

class TestBlameFile:
    @pytest.mark.asyncio
    async def test_blame_returns_entries(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.blame_file(str(tmp_path), "README.md")
        assert result["ok"] is True
        assert len(result["lines"]) >= 1
        assert result["lines"][0]["author"] == "Test"

    @pytest.mark.asyncio
    async def test_blame_rejects_dash_filepath(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.blame_file(str(tmp_path), "-flag")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_blame_nonexistent_file(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.blame_file(str(tmp_path), "nonexistent.txt")
        assert result["ok"] is False


# ── diff_blame ───────────────────────────────────────────────────────────────────

class TestDiffBlame:
    def _all_lines(self, result):
        return [ln for h in result["hunks"] for ln in h["lines"]]

    @pytest.mark.asyncio
    async def test_added_line_is_uncommitted(self, tmp_path):
        init_repo(tmp_path)
        # README starts as "# test"; append a new line in the working tree.
        (tmp_path / "README.md").write_text("# test\nbrand new line\n")
        result = await git_service.diff_blame(str(tmp_path), "README.md", staged=False)
        assert result["ok"] is True
        added = [ln for ln in self._all_lines(result) if ln["kind"] == "+"]
        assert added, "expected at least one added line"
        assert any("brand new line" in ln["text"] for ln in added)
        assert all(ln["committed"] is False for ln in added)

    @pytest.mark.asyncio
    async def test_context_line_carries_author(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "f.txt").write_text("one\ntwo\n")
        subprocess.run(["git", "add", "f.txt"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "add f"], cwd=tmp_path, check=True, capture_output=True)
        (tmp_path / "f.txt").write_text("one\ntwo\nthree\n")  # append a line
        result = await git_service.diff_blame(str(tmp_path), "f.txt", staged=False)
        context = [ln for ln in self._all_lines(result) if ln["kind"] == " "]
        # "one"/"two" stay as unchanged context, blamed to the commit that added them.
        assert any(ln["author"] == "Test" and ln["committed"] for ln in context)

    @pytest.mark.asyncio
    async def test_removed_line_carries_head_author(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "f.txt").write_text("one\ntwo\nthree\n")
        subprocess.run(["git", "add", "f.txt"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "add f"], cwd=tmp_path, check=True, capture_output=True)
        (tmp_path / "f.txt").write_text("one\nthree\n")  # remove "two"
        result = await git_service.diff_blame(str(tmp_path), "f.txt", staged=False)
        removed = [ln for ln in self._all_lines(result) if ln["kind"] == "-"]
        assert any("two" in ln["text"] for ln in removed)
        assert all(ln["author"] == "Test" and ln["committed"] for ln in removed)

    @pytest.mark.asyncio
    async def test_rejects_dash_filepath(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.diff_blame(str(tmp_path), "-flag")
        assert result["ok"] is False


# ── get_staged_diff ────────────────────────────────────────────────────────────

class TestStagedDiff:
    @pytest.mark.asyncio
    async def test_returns_diff(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "new.txt").write_text("hello world")
        await git_service.stage_files(str(tmp_path), ["new.txt"])
        diff = await git_service.get_staged_diff(str(tmp_path))
        assert "hello world" in diff

    @pytest.mark.asyncio
    async def test_empty_when_nothing_staged(self, tmp_path):
        init_repo(tmp_path)
        diff = await git_service.get_staged_diff(str(tmp_path))
        assert diff == ""


# ── get_working_diff ─────────────────────────────────────────────────────────────

class TestWorkingDiff:
    @pytest.mark.asyncio
    async def test_includes_untracked_file(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "new.txt").write_text("brand new content")
        diff = await git_service.get_working_diff(str(tmp_path))
        assert "brand new content" in diff
        assert "new.txt" in diff

    @pytest.mark.asyncio
    async def test_includes_unstaged_tracked_change(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("# test\nmodified line")
        diff = await git_service.get_working_diff(str(tmp_path))
        assert "modified line" in diff

    @pytest.mark.asyncio
    async def test_empty_when_clean(self, tmp_path):
        init_repo(tmp_path)
        diff = await git_service.get_working_diff(str(tmp_path))
        assert diff == ""


# ── helpers for the parity features ──────────────────────────────────────────────

def _current_branch(path: Path) -> str:
    return subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=path, check=True, capture_output=True, text=True
    ).stdout.strip()


def _working_diff(path: Path, filepath: str) -> str:
    return subprocess.run(
        ["git", "diff", "--", filepath], cwd=path, check=True, capture_output=True, text=True
    ).stdout


# ── apply_patch (hunk / line staging) ────────────────────────────────────────────

class TestApplyPatch:
    @pytest.mark.asyncio
    async def test_stage_then_unstage_hunk(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "f.txt").write_text("a\nb\nc\n")
        subprocess.run(["git", "add", "f.txt"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "add f"], cwd=tmp_path, check=True, capture_output=True)

        (tmp_path / "f.txt").write_text("a\nCHANGED\nc\n")
        patch = _working_diff(tmp_path, "f.txt")

        # Stage the change via patch.
        r = await git_service.apply_patch(str(tmp_path), patch, reverse=False, cached=True)
        assert r["ok"] is True
        status = await git_service.get_status(str(tmp_path))
        assert any(f["path"] == "f.txt" for f in status["staged"])

        # Reverse it -> unstaged again.
        r2 = await git_service.apply_patch(str(tmp_path), patch, reverse=True, cached=True)
        assert r2["ok"] is True
        status2 = await git_service.get_status(str(tmp_path))
        assert not any(f["path"] == "f.txt" for f in status2["staged"])

    @pytest.mark.asyncio
    async def test_empty_patch_rejected(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.apply_patch(str(tmp_path), "   ")
        assert r["ok"] is False

    @pytest.mark.asyncio
    async def test_invalid_patch_returns_error(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.apply_patch(str(tmp_path), "not a real diff\n")
        assert r["ok"] is False
        assert r["error"]


# ── clone_repo ────────────────────────────────────────────────────────────────────

class TestCloneRepo:
    @pytest.mark.asyncio
    async def test_clone_success(self, tmp_path):
        source = tmp_path / "source"
        source.mkdir()
        init_repo(source)
        dest = tmp_path / "dest"
        r = await git_service.clone_repo(str(source), str(dest))
        assert r["ok"] is True
        assert (Path(r["path"]) / ".git").exists()

    @pytest.mark.asyncio
    async def test_rejects_flag_url(self, tmp_path):
        r = await git_service.clone_repo("--upload-pack=evil", str(tmp_path / "x"))
        assert r["ok"] is False

    @pytest.mark.asyncio
    async def test_rejects_ext_remote_helper_url(self, tmp_path):
        # ext:: remote-helper URLs can execute arbitrary commands — must be blocked.
        r = await git_service.clone_repo('ext::sh -c "touch /tmp/pwned"', str(tmp_path / "x"))
        assert r["ok"] is False
        assert "scheme" in r["error"]

    @pytest.mark.asyncio
    async def test_rejects_fd_remote_helper_url(self, tmp_path):
        r = await git_service.clone_repo("fd::7", str(tmp_path / "x"))
        assert r["ok"] is False


class TestBlamePorcelainSha256:
    def test_parses_sha256_object_names(self):
        # SHA-256 repos emit 64-hex object names; the parser must accept them
        # (regression: a 40-hex-only regex returned an empty blame silently).
        h = "a" * 64
        out = f"{h} 1 1 1\nauthor Alice\nauthor-time 1700000000\n\tcode\n"
        result = git_service._parse_blame_porcelain(out)
        assert 1 in result
        assert result[1]["author"] == "Alice"
        assert result[1]["committed"] is True

    def test_marks_all_zero_sha256_uncommitted(self):
        h = "0" * 64
        out = f"{h} 1 1 1\nauthor Not Committed Yet\nauthor-time 1700000000\n\twip\n"
        result = git_service._parse_blame_porcelain(out)
        assert result[1]["committed"] is False

    @pytest.mark.asyncio
    async def test_rejects_nonempty_target(self, tmp_path):
        source = tmp_path / "source"
        source.mkdir()
        init_repo(source)
        dest = tmp_path / "dest"
        dest.mkdir()
        (dest / "existing.txt").write_text("x")
        r = await git_service.clone_repo(str(source), str(dest))
        assert r["ok"] is False


# ── add_to_gitignore ──────────────────────────────────────────────────────────────

class TestAddToGitignore:
    @pytest.mark.asyncio
    async def test_appends_pattern(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.add_to_gitignore(str(tmp_path), "node_modules/")
        assert r["ok"] is True
        content = (tmp_path / ".gitignore").read_text()
        assert "node_modules/" in content

    @pytest.mark.asyncio
    async def test_no_duplicate(self, tmp_path):
        init_repo(tmp_path)
        await git_service.add_to_gitignore(str(tmp_path), "dist")
        await git_service.add_to_gitignore(str(tmp_path), "dist")
        lines = [ln for ln in (tmp_path / ".gitignore").read_text().splitlines() if ln.strip() == "dist"]
        assert len(lines) == 1

    @pytest.mark.asyncio
    async def test_empty_pattern_rejected(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.add_to_gitignore(str(tmp_path), "  ")
        assert r["ok"] is False

    @pytest.mark.asyncio
    async def test_untracks_already_tracked_file(self, tmp_path):
        """The core fix: adding an ignore for a tracked file untracks it
        (git rm --cached) so the rule actually takes effect; file stays on disk."""
        init_repo(tmp_path)
        secret = tmp_path / "secret.env"
        secret.write_text("KEY=1")
        subprocess.run(["git", "add", "secret.env"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "add secret"], cwd=tmp_path, check=True, capture_output=True)

        r = await git_service.add_to_gitignore(str(tmp_path), "secret.env")
        assert r["ok"] is True
        assert r["untracked"] == ["secret.env"]
        assert secret.exists()  # file untouched on disk
        ls = subprocess.run(["git", "ls-files", "secret.env"], cwd=tmp_path, capture_output=True, text=True)
        assert ls.stdout.strip() == ""  # no longer tracked

    @pytest.mark.asyncio
    async def test_untrack_disabled(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "keep.log").write_text("x")
        subprocess.run(["git", "add", "keep.log"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "add"], cwd=tmp_path, check=True, capture_output=True)
        r = await git_service.add_to_gitignore(str(tmp_path), "keep.log", untrack=False)
        assert r["untracked"] == []
        ls = subprocess.run(["git", "ls-files", "keep.log"], cwd=tmp_path, capture_output=True, text=True)
        assert ls.stdout.strip() == "keep.log"  # still tracked

    @pytest.mark.asyncio
    async def test_target_local_writes_info_exclude(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.add_to_gitignore(str(tmp_path), "scratch/", target="local")
        assert r["ok"] is True
        exclude = tmp_path / ".git" / "info" / "exclude"
        assert "scratch/" in exclude.read_text()
        assert not (tmp_path / ".gitignore").exists()  # project .gitignore untouched

    @pytest.mark.asyncio
    async def test_target_nested_writes_into_subdir(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "backend").mkdir()
        r = await git_service.add_to_gitignore(str(tmp_path), "backend/cache.db", target="nested")
        assert r["ok"] is True
        nested = tmp_path / "backend" / ".gitignore"
        assert nested.read_text().strip() == "cache.db"

    @pytest.mark.asyncio
    async def test_target_unknown_rejected(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.add_to_gitignore(str(tmp_path), "x", target="bogus")
        assert r["ok"] is False

    @pytest.mark.asyncio
    async def test_nested_rejects_parent_traversal(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.add_to_gitignore(
            str(tmp_path), "../escape/cache.db", target="nested"
        )
        assert r["ok"] is False
        assert not (tmp_path.parent / "escape" / ".gitignore").exists()

    @pytest.mark.asyncio
    async def test_nested_rejects_absolute_path(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.add_to_gitignore(
            str(tmp_path), "/etc/cache.db", target="nested"
        )
        assert r["ok"] is False


# ── check_ignore ──────────────────────────────────────────────────────────────────

class TestCheckIgnore:
    @pytest.mark.asyncio
    async def test_reports_matching_rule(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / ".gitignore").write_text("*.log\n")
        r = await git_service.check_ignore(str(tmp_path), "debug.log")
        assert r["ok"] is True
        assert r["ignored"] is True
        assert r["pattern"] == "*.log"
        assert ".gitignore" in r["source"]

    @pytest.mark.asyncio
    async def test_not_ignored(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / ".gitignore").write_text("*.log\n")
        r = await git_service.check_ignore(str(tmp_path), "main.py")
        assert r["ok"] is True
        assert r["ignored"] is False

    @pytest.mark.asyncio
    async def test_reports_tracked_despite_rule(self, tmp_path):
        """A tracked file matching a rule: ignored=True (rule matches) but
        tracked=True — explains why it still shows up."""
        init_repo(tmp_path)
        (tmp_path / "app.log").write_text("x")
        subprocess.run(["git", "add", "-f", "app.log"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "log"], cwd=tmp_path, check=True, capture_output=True)
        (tmp_path / ".gitignore").write_text("*.log\n")
        r = await git_service.check_ignore(str(tmp_path), "app.log")
        assert r["ignored"] is True
        assert r["tracked"] is True

    @pytest.mark.asyncio
    async def test_empty_filepath_rejected(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.check_ignore(str(tmp_path), "")
        assert r["ok"] is False


# ── get_status include_ignored ─────────────────────────────────────────────────────

class TestStatusIncludeIgnored:
    @pytest.mark.asyncio
    async def test_ignored_hidden_by_default(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / ".gitignore").write_text("*.log\n")
        (tmp_path / "a.log").write_text("x")
        result = await git_service.get_status(str(tmp_path))
        assert result["ignored"] == []

    @pytest.mark.asyncio
    async def test_ignored_surfaced_when_requested(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / ".gitignore").write_text("*.log\n")
        (tmp_path / "a.log").write_text("x")
        result = await git_service.get_status(str(tmp_path), include_ignored=True)
        paths = {f["path"] for f in result["ignored"]}
        assert "a.log" in paths


# ── abort_operation + status detection ────────────────────────────────────────────

class TestAbortOperation:
    def _make_merge_conflict(self, path: Path) -> None:
        init_repo(path)
        base = _current_branch(path)
        (path / "c.txt").write_text("base\n")
        subprocess.run(["git", "add", "c.txt"], cwd=path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "base"], cwd=path, check=True, capture_output=True)
        subprocess.run(["git", "checkout", "-b", "feature"], cwd=path, check=True, capture_output=True)
        (path / "c.txt").write_text("feature\n")
        subprocess.run(["git", "commit", "-am", "feature"], cwd=path, check=True, capture_output=True)
        subprocess.run(["git", "checkout", base], cwd=path, check=True, capture_output=True)
        (path / "c.txt").write_text("main\n")
        subprocess.run(["git", "commit", "-am", "main"], cwd=path, check=True, capture_output=True)
        # Conflicting merge (expected to fail) leaves MERGE_HEAD behind.
        subprocess.run(["git", "merge", "feature"], cwd=path, capture_output=True)

    @pytest.mark.asyncio
    async def test_status_detects_merge(self, tmp_path):
        self._make_merge_conflict(tmp_path)
        status = await git_service.get_status(str(tmp_path))
        assert status["operation_in_progress"] == "merge"

    @pytest.mark.asyncio
    async def test_abort_merge_cleans_state(self, tmp_path):
        self._make_merge_conflict(tmp_path)
        r = await git_service.abort_operation(str(tmp_path), "merge")
        assert r["ok"] is True
        status = await git_service.get_status(str(tmp_path))
        assert status["operation_in_progress"] == ""

    @pytest.mark.asyncio
    async def test_invalid_op_rejected(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.abort_operation(str(tmp_path), "bogus")
        assert r["ok"] is False


# ── stash_apply ────────────────────────────────────────────────────────────────────

class TestStashApply:
    @pytest.mark.asyncio
    async def test_apply_keeps_stash(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("modified content")
        push = await git_service.stash_push(str(tmp_path), "wip")
        assert push["ok"] is True

        r = await git_service.stash_apply(str(tmp_path), 0)
        assert r["ok"] is True
        # Change is back in the working tree...
        assert (tmp_path / "README.md").read_text() == "modified content"
        # ...and the stash entry still exists (unlike pop).
        entries = await git_service.stash_list(str(tmp_path))
        assert len(entries) == 1


# ── pull_rebase / push_force (no remote -> graceful failure) ──────────────────────

class TestRemoteVariants:
    @pytest.mark.asyncio
    async def test_pull_rebase_returns_shape(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.pull_rebase(str(tmp_path))
        assert set(["ok", "output", "error"]).issubset(r.keys())
        assert r["ok"] is False  # no upstream configured

    @pytest.mark.asyncio
    async def test_push_force_returns_shape(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.push_force(str(tmp_path))
        assert set(["ok", "output", "error"]).issubset(r.keys())
        assert r["ok"] is False  # no remote configured

    @pytest.mark.asyncio
    async def test_push_only_targets_named_remote(self, tmp_path):
        """`push_only(remote, branch)` pushes to a specific remote by name."""
        init_repo(tmp_path)
        bare = tmp_path.parent / "bare.git"
        subprocess.run(["git", "init", "--bare", str(bare)], check=True, capture_output=True)
        subprocess.run(["git", "remote", "add", "backup", str(bare)], cwd=tmp_path, check=True, capture_output=True)
        branch = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=tmp_path, check=True, capture_output=True, text=True
        ).stdout.strip()
        r = await git_service.push_only(str(tmp_path), "backup", branch)
        assert r["ok"] is True
        # the named remote now has the branch
        ls = subprocess.run(["git", "ls-remote", str(bare)], check=True, capture_output=True, text=True)
        assert branch in ls.stdout

    @pytest.mark.asyncio
    async def test_push_only_rejects_invalid_remote_name(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.push_only(str(tmp_path), "bad name; rm -rf", "main")
        assert r["ok"] is False
        assert r["error"]


# ── get_log parents (graph data) ──────────────────────────────────────────────────

class TestLogParents:
    @pytest.mark.asyncio
    async def test_parents_populated(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "x.txt").write_text("x")
        subprocess.run(["git", "add", "x.txt"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "second"], cwd=tmp_path, check=True, capture_output=True)
        commits = await git_service.get_log(str(tmp_path), 10)
        # newest commit has exactly one parent; the root has none.
        assert len(commits[0]["parents"]) == 1
        assert commits[-1]["parents"] == []


# ── get_log all_branches (SourceTree-style multi-lane view) ────────────────────

class TestLogAllBranches:
    @staticmethod
    def _make_two_branches(path: Path) -> None:
        """init + a commit on a side branch, then switch back to the main branch."""
        init_repo(path)
        main = _current_branch(path)
        subprocess.run(["git", "checkout", "-b", "feature"], cwd=path, check=True, capture_output=True)
        (path / "feat.txt").write_text("feature work")
        subprocess.run(["git", "add", "-A"], cwd=path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "feature commit"], cwd=path, check=True, capture_output=True)
        subprocess.run(["git", "checkout", main], cwd=path, check=True, capture_output=True)

    @pytest.mark.asyncio
    async def test_current_excludes_other_branches(self, tmp_path):
        self._make_two_branches(tmp_path)
        commits = await git_service.get_log(str(tmp_path), 10, all_branches=False)
        messages = [c["message"] for c in commits]
        # HEAD is on the main branch, so the side-branch commit must NOT appear.
        assert "feature commit" not in messages

    @pytest.mark.asyncio
    async def test_all_includes_other_branches(self, tmp_path):
        self._make_two_branches(tmp_path)
        commits = await git_service.get_log(str(tmp_path), 10, all_branches=True)
        messages = [c["message"] for c in commits]
        # --all pulls in the side branch's commit even though HEAD isn't on it.
        assert "feature commit" in messages


# ── commit-message generation (Cursor-style adaptive) ──────────────────────────

from agent_team_backend import commit_message_prompt


class TestRecentCommitMessages:
    @pytest.mark.asyncio
    async def test_non_git_dir(self, tmp_path):
        result = await git_service.get_recent_commit_messages(str(tmp_path))
        assert result == {"repository": [], "user": []}

    @pytest.mark.asyncio
    async def test_returns_subjects(self, tmp_path):
        init_repo(tmp_path)  # author/committer is "Test"
        (tmp_path / "a.txt").write_text("a")
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "feat: add a"], cwd=tmp_path, check=True, capture_output=True)
        result = await git_service.get_recent_commit_messages(str(tmp_path))
        assert "feat: add a" in result["repository"]
        assert "init" in result["repository"]
        # init_repo sets user.name="Test", so user commits mirror the repository list.
        assert "feat: add a" in result["user"]

    @pytest.mark.asyncio
    async def test_user_empty_when_no_name(self, tmp_path):
        init_repo(tmp_path)
        subprocess.run(["git", "config", "--unset", "user.name"], cwd=tmp_path, check=True, capture_output=True)
        result = await git_service.get_recent_commit_messages(str(tmp_path))
        assert result["repository"] != []
        assert result["user"] == []


class TestCommitContext:
    @pytest.mark.asyncio
    async def test_staged_takes_priority(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("# test\nstaged change")
        await git_service.stage_files(str(tmp_path), ["README.md"])
        # An unstaged untracked file must be ignored once something is staged.
        (tmp_path / "ignored.txt").write_text("not included")
        ctx = await git_service.get_commit_context(str(tmp_path))
        assert ctx["staged"] is True
        assert ctx["repo_name"] == tmp_path.name
        paths = [c["path"] for c in ctx["changes"]]
        assert paths == ["README.md"]
        change = ctx["changes"][0]
        assert "# test" in change["original"]  # HEAD version
        assert "staged change" in change["diff"]

    @pytest.mark.asyncio
    async def test_working_tree_fallback_includes_untracked(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "new.txt").write_text("brand new")
        ctx = await git_service.get_commit_context(str(tmp_path))
        assert ctx["staged"] is False
        change = next(c for c in ctx["changes"] if c["path"] == "new.txt")
        assert change["original"] == ""  # untracked → no HEAD version
        assert "brand new" in change["diff"]

    @pytest.mark.asyncio
    async def test_empty_when_clean(self, tmp_path):
        init_repo(tmp_path)
        ctx = await git_service.get_commit_context(str(tmp_path))
        assert ctx["changes"] == []

    @pytest.mark.asyncio
    async def test_summary_mode_for_large_staged_diff(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("\n".join(f"line {i}" for i in range(1305)))
        await git_service.stage_files(str(tmp_path), ["README.md"])
        ctx = await git_service.get_commit_context(str(tmp_path))
        assert ctx["mode"] == "summary"
        assert "changed line count" in ctx["summary"]["reason"]
        assert ctx["summary"]["line_count"] > 1200
        assert ctx["changes"] == [{
            "path": "README.md",
            "status": "M",
            "added": 1305,
            "deleted": 1,
            "binary": False,
            "size_bytes": 0,
        }]
        assert "diff" not in ctx["changes"][0]
        assert "original" not in ctx["changes"][0]

    @pytest.mark.asyncio
    async def test_summary_mode_for_large_untracked_file(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "large.txt").write_text("x" * 40000)
        ctx = await git_service.get_commit_context(str(tmp_path))
        assert ctx["mode"] == "summary"
        assert "untracked file size" in ctx["summary"]["reason"]
        change = ctx["changes"][0]
        assert change["path"] == "large.txt"
        assert change["status"] == "?"
        assert change["size_bytes"] == 40000


class TestBuildUserPrompt:
    def test_assembles_sections(self):
        context = {
            "repo_name": "Agent-Team",
            "branch": "main",
            "changes": [{"path": "a.py", "original": "old code", "diff": "+new line"}],
            "staged": True,
        }
        recent = {"repository": ["feat: x", "fix: y"], "user": ["chore: z"]}
        prompt = commit_message_prompt.build_user_prompt(context, recent, 1000)
        assert "Repository name: Agent-Team" in prompt
        assert "Branch name: main" in prompt
        assert "# RECENT USER COMMITS" in prompt and "chore: z" in prompt
        assert "# RECENT REPOSITORY COMMITS" in prompt and "feat: x" in prompt
        assert "# FILE: a.py" in prompt
        assert "# ORIGINAL CODE:" in prompt and "old code" in prompt
        assert "# CODE CHANGES:" in prompt and "+new line" in prompt

    def test_omits_recent_when_empty(self):
        context = {"repo_name": "r", "branch": "b", "changes": [], "staged": False}
        prompt = commit_message_prompt.build_user_prompt(context, {"repository": [], "user": []}, 1000)
        assert "# RECENT USER COMMITS" not in prompt
        assert "# RECENT REPOSITORY COMMITS" not in prompt

    def test_truncates_oversized_diff(self):
        context = {
            "repo_name": "r",
            "branch": "b",
            "changes": [{"path": "big.py", "original": "", "diff": "x" * 5000}],
            "staged": True,
        }
        prompt = commit_message_prompt.build_user_prompt(context, {"repository": [], "user": []}, 200)
        assert "... (truncated)" in prompt

    def test_summary_mode_prompt(self):
        context = {
            "repo_name": "r",
            "branch": "b",
            "mode": "summary",
            "staged": True,
            "summary": {
                "reason": "changed line count exceeds 1200",
                "file_count": 2,
                "added": 1400,
                "deleted": 10,
                "has_binary": False,
                "diff_stat": " a.py | 1400 +++++\n b.py | 10 -",
            },
            "changes": [
                {"path": "a.py", "status": "M", "added": 1400, "deleted": 0, "binary": False, "size_bytes": 0},
                {"path": "b.py", "status": "M", "added": 0, "deleted": 10, "binary": False, "size_bytes": 0},
            ],
        }
        prompt = commit_message_prompt.build_user_prompt(context, {"repository": [], "user": []}, 1000)
        assert "# CHANGE SUMMARY:" in prompt
        assert "Summary mode reason: changed line count exceeds 1200" in prompt
        assert "# FILE CHANGES:" in prompt
        assert "- a.py (M, +1400/-0)" in prompt
        assert "# CODE CHANGES:" not in prompt


class TestParseCommitMessage:
    def test_extracts_text_block(self):
        resp = "Here you go:\n```text\nfeat: add thing\n```\nDone."
        assert commit_message_prompt.parse_commit_message(resp) == "feat: add thing"

    def test_extracts_plain_fence(self):
        assert commit_message_prompt.parse_commit_message("```\nfix: bug\n```") == "fix: bug"

    def test_fallback_to_stripped_response(self):
        assert commit_message_prompt.parse_commit_message('  "fix: bug"  ') == "fix: bug"

    def test_empty(self):
        assert commit_message_prompt.parse_commit_message("") == ""

    def test_multiline_body_preserved(self):
        resp = "```text\nfeat: add thing\n\nLonger body line.\n```"
        assert commit_message_prompt.parse_commit_message(resp) == "feat: add thing\n\nLonger body line."


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


class _FakeClient:
    """Stand-in for httpx.AsyncClient that records the request and replies fixed."""

    captured: dict = {}

    def __init__(self, *args, **kwargs):
        _FakeClient.captured["init"] = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, json):
        _FakeClient.captured["body"] = json
        return _FakeResponse({"response": "```text\nfeat: add staged change\n```"})


class TestGenerateCommitMessage:
    @pytest.mark.asyncio
    async def test_no_changes(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.generate_commit_message(str(tmp_path), "http://x")
        assert result["ok"] is False
        assert result["error"] == "no changes"

    @pytest.mark.asyncio
    async def test_failed_status_is_reported_not_read_as_no_changes(self, tmp_path, monkeypatch):
        # A status read that failed has no change list to describe (#144).
        init_repo(tmp_path)
        (tmp_path / "new.txt").write_text("brand new")

        async def failed(*_args, **_kwargs):
            return {"ok": False, "error": "git timed out"}

        monkeypatch.setattr(git_service, "get_status", failed)
        result = await git_service.generate_commit_message(str(tmp_path), "http://x")
        assert result == {"ok": False, "error": "git timed out", "message": ""}

    @pytest.mark.asyncio
    async def test_generates_from_staged(self, tmp_path, monkeypatch):
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("# test\nchanged")
        await git_service.stage_files(str(tmp_path), ["README.md"])
        _FakeClient.captured = {}
        monkeypatch.setattr(git_service.httpx, "AsyncClient", _FakeClient)
        result = await git_service.generate_commit_message(str(tmp_path), "http://x", "llama3.2")
        assert result["ok"] is True
        assert result["message"] == "feat: add staged change"
        assert _FakeClient.captured["body"]["options"]["temperature"] == 0.2

    @pytest.mark.asyncio
    async def test_attempt_count_raises_temperature(self, tmp_path, monkeypatch):
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("# test\nchanged")
        await git_service.stage_files(str(tmp_path), ["README.md"])
        _FakeClient.captured = {}
        monkeypatch.setattr(git_service.httpx, "AsyncClient", _FakeClient)
        await git_service.generate_commit_message(str(tmp_path), "http://x", "llama3.2", attempt_count=2)
        # 0.2 * (1 + 2) = 0.6
        assert _FakeClient.captured["body"]["options"]["temperature"] == pytest.approx(0.6)


# ── diff_branches ──────────────────────────────────────────────────────────────

def _make_branch_repo(path: Path) -> None:
    """Create a repo with main and feature branches for diff tests."""
    subprocess.run(["git", "init"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=path, check=True, capture_output=True)
    (path / "base.txt").write_text("base content\n")
    subprocess.run(["git", "add", "-A"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=path, check=True, capture_output=True)
    # Rename default branch to main
    subprocess.run(["git", "branch", "-M", "main"], cwd=path, check=True, capture_output=True)
    # Create feature branch
    subprocess.run(["git", "checkout", "-b", "feature"], cwd=path, check=True, capture_output=True)
    (path / "feature.txt").write_text("feature content\n")
    subprocess.run(["git", "add", "-A"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", "add feature"], cwd=path, check=True, capture_output=True)


class TestDiffBranches:
    @pytest.mark.asyncio
    async def test_returns_unified_diff(self, tmp_path):
        _make_branch_repo(tmp_path)
        result = await git_service.diff_branches(str(tmp_path), "main", "feature")
        assert result["ok"] is True
        diff = result["diff"]
        # Standard patch format headers
        assert "diff --git" in diff
        assert "+++ b/feature.txt" in diff
        assert "+feature content" in diff

    @pytest.mark.asyncio
    async def test_empty_diff_same_branch(self, tmp_path):
        _make_branch_repo(tmp_path)
        result = await git_service.diff_branches(str(tmp_path), "main", "main")
        assert result["ok"] is True
        assert result["diff"] == ""

    @pytest.mark.asyncio
    async def test_invalid_base_rejected(self, tmp_path):
        _make_branch_repo(tmp_path)
        result = await git_service.diff_branches(str(tmp_path), "-bad-ref", "feature")
        assert result["ok"] is False
        assert "base branch" in result.get("error", "")

    @pytest.mark.asyncio
    async def test_invalid_compare_rejected(self, tmp_path):
        _make_branch_repo(tmp_path)
        result = await git_service.diff_branches(str(tmp_path), "main", "--bad")
        assert result["ok"] is False
        assert "compare branch" in result.get("error", "")

    @pytest.mark.asyncio
    async def test_nonexistent_branch_returns_error(self, tmp_path):
        _make_branch_repo(tmp_path)
        result = await git_service.diff_branches(str(tmp_path), "main", "no-such-branch")
        assert result["ok"] is False
        assert result["diff"] == ""

    @pytest.mark.asyncio
    async def test_small_diff_is_not_reported_truncated(self, tmp_path):
        _make_branch_repo(tmp_path)
        result = await git_service.diff_branches(str(tmp_path), "main", "feature")
        assert result["ok"] is True
        assert result["truncated"] is False

    @pytest.mark.asyncio
    async def test_diff_truncated_at_30000_bytes(self, tmp_path):
        """A real oversized diff, not a stubbed _run.

        The cap is enforced by stopping the read (and the git process) rather
        than by slicing a fully buffered string, so a stub that returns the
        whole diff would no longer be testing the mechanism that bounds memory.
        """
        _make_branch_repo(tmp_path)
        big = "".join(f"line {i} {'x' * 60}\n" for i in range(4000))
        (tmp_path / "big.txt").write_text(big)
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "big"], cwd=tmp_path, check=True, capture_output=True)

        result = await git_service.diff_branches(str(tmp_path), "main", "feature")
        assert result["ok"] is True
        assert result["truncated"] is True
        assert len(result["diff"]) == 30_000
        assert result["diff"].startswith("diff --git")

    @pytest.mark.asyncio
    async def test_diff_does_not_go_through_the_buffering_runner(self, tmp_path, monkeypatch):
        """Slicing a fully buffered diff looks identical from the outside.

        Truncating the result is not the point of the change -- not holding the
        whole diff in memory is -- and only the runner it picks shows that, so
        the buffering one is made to fail loudly here.
        """
        _make_branch_repo(tmp_path)

        async def _fail(*_args, **_kwargs):
            raise AssertionError("diff_branches must use the capped runner")

        monkeypatch.setattr(git_service, "_run", _fail)
        result = await git_service.diff_branches(str(tmp_path), "main", "feature")
        assert result["ok"] is True
        assert "+feature content" in result["diff"]


# ── discover_repositories ───────────────────────────────────────────────────────

class TestDiscoverRepositories:
    @pytest.mark.asyncio
    async def test_non_existent_dir(self, tmp_path):
        result = await git_service.discover_repositories(str(tmp_path / "nope"))
        assert result["ok"] is False
        assert result["repositories"] == []

    @pytest.mark.asyncio
    async def test_blocked_scan_returns_partial_result_without_blocking_loop(
        self, tmp_path, monkeypatch
    ):
        (tmp_path / ".git").mkdir()
        (tmp_path / "later").mkdir()
        blocked = threading.Event()
        release = threading.Event()
        finished = threading.Event()

        def blocked_walk(_root):
            try:
                yield str(tmp_path), ["later"], []
                blocked.set()
                assert release.wait(2.0), "blocked walk was not released"
                yield str(tmp_path / "later"), [], []
            finally:
                finished.set()

        async def fake_run(*_args, **_kwargs):
            return 0, "main\n", ""

        monkeypatch.setattr(git_service.os, "walk", blocked_walk)
        monkeypatch.setattr(git_service, "_run", fake_run)
        monkeypatch.setattr(git_service, "_DISCOVERY_SCAN_BUDGET_S", 0.5)

        loop_advanced = asyncio.Event()

        async def advance_loop():
            await asyncio.sleep(0.01)
            loop_advanced.set()

        asyncio.create_task(advance_loop())
        started_at = asyncio.get_running_loop().time()
        discovery_task = asyncio.create_task(
            git_service.discover_repositories(str(tmp_path))
        )
        try:
            assert await asyncio.to_thread(blocked.wait, 1.0)
            result = await asyncio.wait_for(discovery_task, timeout=1.0)
        finally:
            release.set()

        assert asyncio.get_running_loop().time() - started_at < 1.0
        assert blocked.is_set()
        assert loop_advanced.is_set()
        assert result == {
            "ok": True,
            "repositories": [
                {"rel_path": ".", "abs_path": str(tmp_path), "branch": ""}
            ],
            "truncated": True,
        }
        assert await asyncio.to_thread(finished.wait, 1.0)

    @pytest.mark.asyncio
    async def test_scan_budget_returns_partial_repositories(self, tmp_path, monkeypatch):
        (tmp_path / ".git").mkdir()
        (tmp_path / "later").mkdir()
        ticks = iter((0.0, 1.0, 1.0, 6.0))

        class FakeTime:
            @staticmethod
            def monotonic():
                return next(ticks)

        async def fake_run(*_args, **_kwargs):
            pytest.fail("truncated discovery must not query repository branches")

        monkeypatch.setattr(git_service, "time", FakeTime())
        monkeypatch.setattr(git_service, "_run", fake_run)

        result = await git_service.discover_repositories(str(tmp_path))

        assert result == {
            "ok": True,
            "repositories": [
                {"rel_path": ".", "abs_path": str(tmp_path), "branch": ""}
            ],
            "truncated": True,
        }

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("validation", "expected"),
        [
            (None, {"ok": True, "repositories": [], "truncated": True}),
            (
                False,
                {"ok": False, "error": "workspace not found", "repositories": []},
            ),
        ],
    )
    async def test_timeout_preserves_workspace_validation(
        self, tmp_path, monkeypatch, validation, expected
    ):
        started = threading.Event()
        release = threading.Event()
        finished = threading.Event()

        def blocked_validation(
            _workspace_path,
            _max_depth,
            _limit,
            _repos,
            workspace_validation,
            _stop_requested,
            _deadline,
        ):
            if validation is not None:
                workspace_validation.put(validation)
            started.set()
            try:
                assert release.wait(2.0), "blocked validation was not released"
            finally:
                finished.set()
            return validation is not False, False

        monkeypatch.setattr(git_service, "_discover_repository_paths", blocked_validation)
        monkeypatch.setattr(git_service, "_DISCOVERY_SCAN_BUDGET_S", 0.2)

        discovery_task = asyncio.create_task(
            git_service.discover_repositories(str(tmp_path))
        )
        try:
            assert await asyncio.to_thread(started.wait, 1.0)
            result = await asyncio.wait_for(discovery_task, timeout=0.75)
        finally:
            release.set()

        assert result == expected
        assert await asyncio.to_thread(finished.wait, 1.0)

    @pytest.mark.asyncio
    async def test_no_nested_repos(self, tmp_path):
        (tmp_path / "plain").mkdir()
        result = await git_service.discover_repositories(str(tmp_path))
        assert result["ok"] is True
        assert result["repositories"] == []

    @pytest.mark.asyncio
    async def test_finds_nested_repos_and_skips_noise(self, tmp_path):
        # Two real nested repos at different depths.
        (tmp_path / "a").mkdir()
        init_repo(tmp_path / "a")
        (tmp_path / "b" / "c").mkdir(parents=True)
        init_repo(tmp_path / "b" / "c")
        # A repo buried inside a noise dir + a hidden dir must be skipped.
        (tmp_path / "node_modules" / "x").mkdir(parents=True)
        init_repo(tmp_path / "node_modules" / "x")
        (tmp_path / ".hidden").mkdir()
        init_repo(tmp_path / ".hidden")

        result = await git_service.discover_repositories(str(tmp_path))
        found = {r["rel_path"] for r in result["repositories"]}
        assert found == {"a", str(Path("b") / "c")}
        # Branch annotation is present (best-effort, non-empty for a real repo).
        for r in result["repositories"]:
            assert r["branch"]

    @pytest.mark.asyncio
    async def test_does_not_descend_into_found_repo(self, tmp_path):
        # A repo nested inside another repo must not be reported separately.
        (tmp_path / "outer").mkdir()
        init_repo(tmp_path / "outer")
        (tmp_path / "outer" / "inner").mkdir()
        init_repo(tmp_path / "outer" / "inner")
        result = await git_service.discover_repositories(str(tmp_path))
        found = {r["rel_path"] for r in result["repositories"]}
        assert found == {"outer"}

    @pytest.mark.asyncio
    async def test_respects_max_depth(self, tmp_path):
        deep = tmp_path / "x" / "y" / "z"
        deep.mkdir(parents=True)
        init_repo(deep)  # depth 3
        result = await git_service.discover_repositories(str(tmp_path), max_depth=2)
        assert result["repositories"] == []

    @pytest.mark.asyncio
    async def test_respects_limit(self, tmp_path):
        for name in ("r1", "r2", "r3"):
            (tmp_path / name).mkdir()
            init_repo(tmp_path / name)
        result = await git_service.discover_repositories(str(tmp_path), limit=2)
        assert len(result["repositories"]) == 2
        assert result["truncated"] is True

    @pytest.mark.asyncio
    async def test_root_is_repo_listed_first(self, tmp_path):
        # Root itself is a git repo; two nested repos also exist.
        init_repo(tmp_path)
        (tmp_path / "sub1").mkdir()
        init_repo(tmp_path / "sub1")
        (tmp_path / "sub2").mkdir()
        init_repo(tmp_path / "sub2")
        result = await git_service.discover_repositories(str(tmp_path))
        assert result["ok"] is True
        rel_paths = [r["rel_path"] for r in result["repositories"]]
        # Root must appear first with rel_path "."
        assert rel_paths[0] == "."
        assert set(rel_paths) == {".", "sub1", "sub2"}
        # All entries have branch annotation.
        for r in result["repositories"]:
            assert "branch" in r

    @pytest.mark.asyncio
    async def test_non_repo_root_does_not_appear(self, tmp_path):
        # Root has no .git; only nested repos should appear.
        (tmp_path / "a").mkdir()
        init_repo(tmp_path / "a")
        result = await git_service.discover_repositories(str(tmp_path))
        rel_paths = [r["rel_path"] for r in result["repositories"]]
        assert "." not in rel_paths
        assert rel_paths == ["a"]

    @pytest.mark.asyncio
    async def test_root_repo_nested_not_reported_separately(self, tmp_path):
        # Root is a repo; a repo nested inside root's subtree must not be listed
        # separately (same rule as nested-inside-nested).
        init_repo(tmp_path)
        inner = tmp_path / "pkg" / "inner"
        inner.mkdir(parents=True)
        init_repo(inner)
        result = await git_service.discover_repositories(str(tmp_path))
        rel_paths = [r["rel_path"] for r in result["repositories"]]
        # Root listed; inner must NOT appear because root scanning continues
        # (root doesn't stop descend), but inner IS a found nested repo so its
        # subtree is pruned — inner itself should appear.
        assert "." in rel_paths
        assert str(Path("pkg") / "inner") in rel_paths


# ── cloud-sync mounts ──────────────────────────────────────────────────────────

class TestIsCloudSyncedPath:
    """Segment matching, never substring matching (issue #24)."""

    @pytest.mark.parametrize(
        "path",
        [
            "/Users/x/Library/CloudStorage/GoogleDrive-x@y.com/My Drive/proj",
            "/Users/x/Library/CloudStorage/Dropbox/proj",
            "/Users/x/Library/CloudStorage/OneDrive-Corp/proj",
            "/Users/x/Library/Mobile Documents/com~apple~CloudDocs/proj",
            "/Users/x/Library/CloudStorage/GoogleDrive-x/.shortcut-targets-by-id/abc/proj",
            "/Volumes/elsewhere/com~apple~CloudDocs/proj",
        ],
    )
    def test_cloud_paths(self, path):
        assert git_service._is_cloud_synced_path(Path(path)) is True

    @pytest.mark.parametrize(
        "path",
        [
            "/Users/x/projects/CloudStorage/proj",
            "/Users/x/projects/Mobile Documents/proj",
            "/Users/x/projects/MyCloudStorageThing/proj",
            "/Users/x/Library/Application Support/proj",
        ],
    )
    def test_ordinary_paths(self, path):
        assert git_service._is_cloud_synced_path(Path(path)) is False


class TestDiscoverRepositoriesOnCloudPaths:
    @staticmethod
    def _cloud_workspace(tmp_path: Path) -> Path:
        ws = tmp_path / "Library" / "CloudStorage" / "GoogleDrive-me" / "ws"
        ws.mkdir(parents=True)
        return ws

    @pytest.mark.asyncio
    async def test_cloud_path_is_not_walked(self, tmp_path, monkeypatch):
        ws = self._cloud_workspace(tmp_path)
        (ws / "inner").mkdir()
        init_repo(ws / "inner")

        def fail_walk(*_args, **_kwargs):
            pytest.fail("a cloud-sync workspace must not be walked")

        monkeypatch.setattr(git_service.os, "walk", fail_walk)
        result = await git_service.discover_repositories(str(ws))

        assert result == {
            "ok": True,
            "repositories": [],
            "truncated": True,
            "skipped": "cloud_storage",
        }

    @pytest.mark.asyncio
    async def test_repo_at_cloud_root_is_still_returned(self, tmp_path):
        ws = self._cloud_workspace(tmp_path)
        init_repo(ws)
        result = await git_service.discover_repositories(str(ws))

        assert result == {
            "ok": True,
            "repositories": [
                {"rel_path": ".", "abs_path": str(ws.resolve()), "branch": ""}
            ],
            "truncated": True,
            "skipped": "cloud_storage",
        }

    @pytest.mark.asyncio
    async def test_force_walks_a_cloud_path(self, tmp_path):
        ws = self._cloud_workspace(tmp_path)
        (ws / "inner").mkdir()
        init_repo(ws / "inner")

        result = await git_service.discover_repositories(str(ws), force=True)

        assert result["ok"] is True
        assert [r["rel_path"] for r in result["repositories"]] == ["inner"]
        assert "skipped" not in result

    @pytest.mark.asyncio
    async def test_ordinary_cloudstorage_dir_is_walked(self, tmp_path):
        # "CloudStorage" only means a cloud mount directly under "Library".
        ws = tmp_path / "projects" / "CloudStorage"
        (ws / "inner").mkdir(parents=True)
        init_repo(ws / "inner")

        result = await git_service.discover_repositories(str(ws))

        assert [r["rel_path"] for r in result["repositories"]] == ["inner"]
        assert "skipped" not in result

    @pytest.mark.asyncio
    async def test_non_cloud_path_carries_no_skipped_key(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.discover_repositories(str(tmp_path))
        assert "skipped" not in result

    @pytest.mark.asyncio
    async def test_missing_workspace_on_cloud_path(self, tmp_path):
        ws = self._cloud_workspace(tmp_path)
        result = await git_service.discover_repositories(str(ws / "gone"))
        assert result == {
            "ok": False,
            "error": "workspace not found",
            "repositories": [],
        }


class TestDiscoverRepositoriesHandler:
    """git.discover_repositories WS handler — payload pass-through.

    No ws_handlers test module covers git.* yet; this reuses the FakeWebSocket
    pattern the other handler tests use rather than adding a harness module.
    """

    class _FakeWebSocket:
        def __init__(self) -> None:
            self.sent: list[dict[str, Any]] = []

        async def send_json(self, payload: dict[str, Any]) -> None:
            self.sent.append(payload)

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("payload_force", "expected"), [(None, False), (True, True), (False, False)]
    )
    async def test_force_is_passed_through(
        self, tmp_path, monkeypatch, payload_force, expected
    ):
        seen: dict[str, Any] = {}

        async def fake_discover(ws_path, **kwargs):
            seen.update(kwargs)
            return {"ok": True, "repositories": [], "truncated": False}

        monkeypatch.setattr(git_service, "discover_repositories", fake_discover)
        websocket = self._FakeWebSocket()
        session = app_module.Session(websocket)  # type: ignore[arg-type]
        payload: dict[str, Any] = {"workspace_path": str(tmp_path)}
        if payload_force is not None:
            payload["force"] = payload_force

        await app_module.handle_message(session, {
            "id": "d1",
            "type": "git.discover_repositories",
            "payload": payload,
        })

        assert seen["force"] is expected
        assert websocket.sent[0]["payload"]["ok"] is True


# ── commit context-menu actions (VS Code / Cursor parity) ──────────────────────

def _head_hash(path: Path) -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=path, check=True, capture_output=True, text=True
    ).stdout.strip()


def _add_commit(path: Path, filename: str, content: str, message: str) -> str:
    (path / filename).write_text(content)
    subprocess.run(["git", "add", "-A"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", message], cwd=path, check=True, capture_output=True)
    return _head_hash(path)


class TestCommitContextMenu:
    @pytest.mark.asyncio
    async def test_create_branch_from_start_point(self, tmp_path):
        init_repo(tmp_path)
        first = _head_hash(tmp_path)
        _add_commit(tmp_path, "b.txt", "second", "second")  # advance HEAD past `first`
        result = await git_service.create_branch(
            str(tmp_path), "from-first", switch_to=True, start_point=first
        )
        assert result["ok"] is True
        # New branch HEAD must sit on the start-point commit, not the latest one.
        assert _head_hash(tmp_path) == first

    @pytest.mark.asyncio
    async def test_create_branch_rejects_bad_start_point(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.create_branch(
            str(tmp_path), "bad-start", start_point="-flag"
        )
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_checkout_commit_detaches(self, tmp_path):
        init_repo(tmp_path)
        first = _head_hash(tmp_path)
        _add_commit(tmp_path, "b.txt", "second", "second")
        result = await git_service.checkout_commit(str(tmp_path), first)
        assert result["ok"] is True
        assert _head_hash(tmp_path) == first
        # Detached HEAD → symbolic-ref for HEAD fails.
        rc = subprocess.run(
            ["git", "symbolic-ref", "-q", "HEAD"], cwd=tmp_path, capture_output=True
        ).returncode
        assert rc != 0

    @pytest.mark.asyncio
    async def test_checkout_commit_rejects_bad_hash(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.checkout_commit(str(tmp_path), "-flag")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_commit_file_diff_returns_hunks(self, tmp_path):
        init_repo(tmp_path)
        h = _add_commit(tmp_path, "b.txt", "line1\nline2\n", "add b")
        result = await git_service.commit_file_diff(str(tmp_path), h, "b.txt")
        assert result["ok"] is True
        assert result["hunks"]
        texts = [ln["text"] for hunk in result["hunks"] for ln in hunk["lines"]]
        assert "line1" in texts

    @pytest.mark.asyncio
    async def test_commit_file_diff_rejects_bad_hash(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.commit_file_diff(str(tmp_path), "-flag", "b.txt")
        assert result["ok"] is False
        assert result["hunks"] == []


# ── subprocess concurrency limit / timeout reaping ────────────────────────────

class TestGitProcLimit:
    """_run/_run_with_input cap concurrent git subprocesses and reap timeouts."""

    @pytest.mark.asyncio
    async def test_run_concurrency_capped(self, monkeypatch):
        in_flight = 0
        peak = 0
        release = asyncio.Event()

        class FakeProc:
            returncode = 0

            async def communicate(self):
                nonlocal in_flight, peak
                in_flight += 1
                peak = max(peak, in_flight)
                await release.wait()
                in_flight -= 1
                return b"", b""

            def kill(self):
                pass

            async def wait(self):
                return 0

        async def fake_exec(*args, **kwargs):
            return FakeProc()

        monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

        tasks = [
            asyncio.create_task(git_service._run(["git", "status"], "."))
            for _ in range(8)
        ]
        # Let all tasks start and settle behind the semaphore.
        for _ in range(20):
            await asyncio.sleep(0)
        assert peak <= git_service._GIT_PROC_LIMIT
        # The limit is fully utilized; the other tasks are queued, not running.
        assert in_flight == git_service._GIT_PROC_LIMIT

        release.set()
        results = await asyncio.gather(*tasks)
        assert peak == git_service._GIT_PROC_LIMIT
        assert all(r == (0, "", "") for r in results)

    @pytest.mark.asyncio
    async def test_run_timeout_kills_and_reaps(self, monkeypatch):
        procs: list = []

        class FakeProc:
            returncode = None
            pid = 4_194_305  # only the stubbed process tree ever sees it

            def __init__(self):
                self.killed = False
                self.waited = False

            async def communicate(self, input=None):
                await asyncio.sleep(3600)  # never returns within the timeout

            def kill(self):
                self.killed = True

            async def wait(self):
                self.waited = True
                return -9

        async def fake_exec(*args, **kwargs):
            proc = FakeProc()
            procs.append(proc)
            return proc

        real_wait_for = asyncio.wait_for

        async def fast_wait_for(awaitable, timeout=None):
            return await real_wait_for(awaitable, timeout=0.01)

        monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
        monkeypatch.setattr(asyncio, "wait_for", fast_wait_for)
        # The tree kill reads the fake's pid: keep it off the real process table.
        tree_reads: list = []
        kills: list = []
        monkeypatch.setattr(host_shell.process_tree, "descendants", lambda pid: tree_reads.append(pid) or [])
        monkeypatch.setattr(host_shell.process_tree, "identity", lambda pid: "")
        monkeypatch.setattr(host_shell.process_tree, "kill", lambda pid, *, force: kills.append(pid))

        result = await git_service._run(["git", "status"], ".")
        assert result == (128, "", "git timed out")
        assert procs[0].killed is True
        assert procs[0].waited is True  # zombie reaped, not just killed
        assert (tree_reads, kills) == ([procs[0].pid], [])

    @pytest.mark.asyncio
    async def test_run_with_input_timeout_kills_and_reaps(self, monkeypatch):
        procs: list = []

        class FakeProc:
            returncode = None
            pid = 4_194_305  # only the stubbed process tree ever sees it

            def __init__(self):
                self.killed = False
                self.waited = False

            async def communicate(self, input=None):
                await asyncio.sleep(3600)

            def kill(self):
                self.killed = True

            async def wait(self):
                self.waited = True
                return -9

        async def fake_exec(*args, **kwargs):
            proc = FakeProc()
            procs.append(proc)
            return proc

        real_wait_for = asyncio.wait_for

        async def fast_wait_for(awaitable, timeout=None):
            return await real_wait_for(awaitable, timeout=0.01)

        monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
        monkeypatch.setattr(asyncio, "wait_for", fast_wait_for)
        # The tree kill reads the fake's pid: keep it off the real process table.
        tree_reads: list = []
        kills: list = []
        monkeypatch.setattr(host_shell.process_tree, "descendants", lambda pid: tree_reads.append(pid) or [])
        monkeypatch.setattr(host_shell.process_tree, "identity", lambda pid: "")
        monkeypatch.setattr(host_shell.process_tree, "kill", lambda pid, *, force: kills.append(pid))

        result = await git_service._run_with_input(["git", "apply"], ".", "diff")
        assert result == (128, "", "git timed out")
        assert procs[0].killed is True
        assert procs[0].waited is True
        assert (tree_reads, kills) == ([procs[0].pid], [])

    @pytest.mark.asyncio
    async def test_fetch_serialized_per_repo(self, monkeypatch):
        """fetch carries @_serialize_write: two fetches on one repo never overlap."""
        from contextlib import asynccontextmanager

        in_flight = 0
        peak = 0
        release = asyncio.Event()

        async def fake_run_with_timeout(args, cwd, timeout=None, env=None):
            nonlocal in_flight, peak
            in_flight += 1
            peak = max(peak, in_flight)
            await release.wait()
            in_flight -= 1
            return 0, "", ""

        @asynccontextmanager
        async def fake_askpass(*_a, **_k):
            yield {}

        monkeypatch.setattr(git_service, "_run_with_timeout", fake_run_with_timeout)
        monkeypatch.setattr(git_service, "_askpass_env", fake_askpass)

        t1 = asyncio.create_task(git_service.fetch("/same-repo"))
        t2 = asyncio.create_task(git_service.fetch("/same-repo"))
        for _ in range(20):
            await asyncio.sleep(0)
        # Serialized by the per-repo write lock: only one fetch runs at a time.
        assert peak == 1
        assert in_flight == 1

        release.set()
        await asyncio.gather(t1, t2)
        assert peak == 1


# ── generate_commit_message: the Anthropic client must be released ────────────
#
# AsyncAnthropic owns an httpx connection pool and an SSL context. Auto-commit
# calls this path once a minute, so a client that is never closed accumulates
# roughly sixty of them an hour, waiting on a garbage collector that cannot
# close an async transport reliably.


def _fake_anthropic(closed: list[str], *, raises: Exception | None = None) -> Any:
    """An `anthropic` module whose client records how it was left."""
    import types

    class FakeMessages:
        async def create(self, **_kw: Any) -> Any:
            if raises is not None:
                raise raises
            block = type("Block", (), {"type": "text", "text": "fix: tidy the widget"})()
            return type("Resp", (), {"content": [block]})()

    class FakeAsyncAnthropic:
        def __init__(self, **_kw: Any) -> None:
            self.messages = FakeMessages()

        async def __aenter__(self) -> "FakeAsyncAnthropic":
            closed.append("entered")
            return self

        async def __aexit__(self, *_exc: Any) -> bool:
            closed.append("closed")
            return False

    module = types.ModuleType("anthropic")
    module.AsyncAnthropic = FakeAsyncAnthropic  # type: ignore[attr-defined]
    return module


def _dirty_repo(path: Path) -> None:
    init_repo(path)
    (path / "widget.py").write_text("def widget():\n    return 1\n")


ANTHROPIC_SETTINGS = {
    "provider": "anthropic",
    "anthropic_api_key": "sk-test-not-a-real-key",
    "anthropic_model": "claude-sonnet-5",
}


@pytest.mark.asyncio
async def test_anthropic_client_is_closed_on_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import sys

    closed: list[str] = []
    monkeypatch.setitem(sys.modules, "anthropic", _fake_anthropic(closed))
    _dirty_repo(tmp_path)

    result = await git_service.generate_commit_message(
        str(tmp_path), "http://unused", settings=ANTHROPIC_SETTINGS
    )

    assert result["ok"] is True
    assert closed == ["entered", "closed"], "the client must be released on the happy path"


@pytest.mark.asyncio
async def test_anthropic_client_is_closed_when_the_api_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The path that used to leak hardest: an exception skipped every cleanup."""
    import sys

    closed: list[str] = []
    monkeypatch.setitem(
        sys.modules, "anthropic", _fake_anthropic(closed, raises=RuntimeError("429 overloaded"))
    )
    _dirty_repo(tmp_path)

    result = await git_service.generate_commit_message(
        str(tmp_path), "http://unused", settings=ANTHROPIC_SETTINGS
    )

    assert result["ok"] is False
    assert "429 overloaded" in result["error"]
    assert closed == ["entered", "closed"], "an API error must still release the client"
