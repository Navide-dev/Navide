"""Tests for issue_service.py — gh/glab subprocess calls are mocked.

Fixtures use the real JSON shapes captured from gh 2.87.3 and glab 1.89.0 so
the normalization is verified against actual CLI output, not a guess.
"""
from __future__ import annotations

import json
import os
import subprocess

import pytest

from agent_team_backend import host_shell, issue_service, osplat


# ── canned CLI output (trimmed real shapes) ────────────────────────────────────

GH_LIST = json.dumps([
    {
        "number": 13643,
        "title": "Support GHEC",
        "state": "OPEN",
        "author": {"login": "ganadist", "name": "Young Ho Cha"},
        "labels": [{"name": "enhancement"}, {"name": "gh-skill"}],
        "assignees": [],
        "updatedAt": "2026-06-13T03:52:02Z",
        "url": "https://github.com/cli/cli/issues/13643",
    }
])

GH_VIEW = json.dumps({
    "number": 13643,
    "title": "Support GHEC",
    "body": "### Describe the feature",
    "state": "CLOSED",
    "author": {"login": "ganadist"},
    "labels": [{"name": "enhancement"}],
    "assignees": [{"login": "alice"}],
    "createdAt": "2026-06-01T00:00:00Z",
    "url": "https://github.com/cli/cli/issues/13643",
    "comments": [
        {"author": {"login": "github-actions"}, "body": "Thanks!", "createdAt": "2026-06-02T00:00:00Z"},
    ],
})

GLAB_LIST = json.dumps([
    {
        "id": 192360163,
        "iid": 8361,
        "state": "opened",
        "title": "Add --mr-dependency",
        "description": "### Problem to solve",
        "author": {"username": "ashishbnv", "name": "Ashish Kurian"},
        "labels": ["feature::addition", "type::feature"],
        "assignees": [],
        "updated_at": "2026-06-13T00:18:59.949Z",
        "web_url": "https://gitlab.com/gitlab-org/cli/-/issues/8361",
    }
])

GLAB_VIEW = json.dumps({
    "iid": 8361,
    "state": "opened",
    "title": "Add --mr-dependency",
    "description": "### Problem to solve",
    "author": {"username": "ashishbnv"},
    "labels": ["feature::addition"],
    "assignees": [{"username": "bob"}],
    "created_at": "2026-06-01T00:00:00Z",
    "web_url": "https://gitlab.com/gitlab-org/cli/-/issues/8361",
    "Notes": [
        {"author": {"username": "ashishbnv"}, "body": "set status to New", "system": True, "created_at": "x"},
        {"author": {"username": "carol"}, "body": "Real comment", "system": False, "created_at": "2026-06-02T00:00:00Z"},
    ],
})


def fake_run(responder):
    """Build an async _run replacement driven by responder(args)->(rc,out,err)."""
    async def _fake(args, cwd):
        return responder(args)
    return _fake


# ── _detect_host ───────────────────────────────────────────────────────────────

class TestDetectHost:
    def test_github_https(self):
        assert issue_service._detect_host("https://github.com/owner/repo.git") == "github"

    def test_github_ssh(self):
        assert issue_service._detect_host("git@github.com:owner/repo.git") == "github"

    def test_gitlab_com(self):
        assert issue_service._detect_host("https://gitlab.com/owner/repo.git") == "gitlab"

    def test_gitlab_self_hosted(self):
        assert issue_service._detect_host("https://gitlab.example.com/owner/repo.git") == "gitlab"

    def test_gitlab_ssh(self):
        assert issue_service._detect_host("git@gitlab.com:owner/repo.git") == "gitlab"

    def test_unknown(self):
        assert issue_service._detect_host("https://bitbucket.org/owner/repo.git") == "unknown"

    def test_empty(self):
        assert issue_service._detect_host("") == "unknown"


@pytest.mark.asyncio
async def test_public_create_uses_one_deadline_before_launching_mutation(monkeypatch):
    clock = [0.0]
    calls = []

    async def fake_cli(args, cwd, *, timeout):
        calls.append((args[0], timeout))
        if args[0] == "git":
            clock[0] = 31.0
            return 0, "https://github.com/o/r.git\n", ""
        return 0, "https://github.com/o/r/issues/1", ""

    monkeypatch.setattr(issue_service, "monotonic", lambda: clock[0], raising=False)
    monkeypatch.setattr(issue_service, "run_allowlisted_text", fake_cli)
    policy = {"mode": "allowlist", "shell": ["git", "gh"]}
    result = await issue_service.public_request("create", "/ws", {"title": "test"}, policy)
    assert result["ok"] is False
    assert "timed out" in result["error"]
    assert calls == [("git", 30.0)]

    calls.clear()
    clock[0] = 0.0
    async def timely_cli(args, cwd, *, timeout):
        calls.append((args[0], timeout))
        if args[0] == "git":
            clock[0] = 12.0
            return 0, "https://github.com/o/r.git\n", ""
        return 0, "https://github.com/o/r/issues/1", ""

    monkeypatch.setattr(issue_service, "run_allowlisted_text", timely_cli)
    result = await issue_service.public_request("create", "/ws", {"title": "test"}, policy)
    assert result["ok"] is True
    assert calls == [("git", 30.0), ("gh", 18.0)]


# ── normalization ──────────────────────────────────────────────────────────────

class TestNormalization:
    def test_gh_list_shape(self):
        raw = json.loads(GH_LIST)[0]
        n = issue_service._norm_gh_issue(raw)
        assert n == {
            "number": 13643,
            "title": "Support GHEC",
            "state": "open",  # OPEN lowercased
            "author": "ganadist",  # login
            "labels": ["enhancement", "gh-skill"],  # [].name
            "assignees": [],
            "updated_at": "2026-06-13T03:52:02Z",
            "url": "https://github.com/cli/cli/issues/13643",
        }

    def test_gh_detail_comments(self):
        n = issue_service._norm_gh_issue(json.loads(GH_VIEW), detail=True)
        assert n["state"] == "closed"
        assert n["body"] == "### Describe the feature"
        assert n["assignees"] == ["alice"]
        assert n["comments"] == [
            {"author": "github-actions", "body": "Thanks!", "created_at": "2026-06-02T00:00:00Z"},
        ]

    def test_glab_list_shape(self):
        raw = json.loads(GLAB_LIST)[0]
        n = issue_service._norm_glab_issue(raw)
        assert n == {
            "number": 8361,  # iid, NOT id
            "title": "Add --mr-dependency",
            "state": "open",  # opened -> open
            "author": "ashishbnv",  # username
            "labels": ["feature::addition", "type::feature"],  # already strings
            "assignees": [],
            "updated_at": "2026-06-13T00:18:59.949Z",
            "url": "https://gitlab.com/gitlab-org/cli/-/issues/8361",
        }

    def test_glab_detail_filters_system_notes(self):
        n = issue_service._norm_glab_issue(json.loads(GLAB_VIEW), detail=True)
        assert n["body"] == "### Problem to solve"
        assert n["assignees"] == ["bob"]
        # system=true note dropped; only the real comment survives.
        assert n["comments"] == [
            {"author": "carol", "body": "Real comment", "created_at": "2026-06-02T00:00:00Z"},
        ]


# ── detect_provider ────────────────────────────────────────────────────────────

class TestDetectProvider:
    @pytest.mark.asyncio
    async def test_github_authenticated(self, monkeypatch):
        def responder(args):
            if args[:3] == ["git", "config", "--get"]:
                return (0, "https://github.com/owner/repo.git\n", "")
            if args[:2] == ["gh", "auth"]:
                return (0, "logged in", "")
            return (1, "", "unexpected")
        monkeypatch.setattr(issue_service, "_run", fake_run(responder))
        r = await issue_service.detect_provider("/ws")
        assert r["provider"] == "github"
        assert r["cli_available"] is True
        assert r["authenticated"] is True

    @pytest.mark.asyncio
    async def test_gitlab_cli_missing(self, monkeypatch):
        def responder(args):
            if args[:3] == ["git", "config", "--get"]:
                return (0, "https://gitlab.com/owner/repo.git\n", "")
            if args[:2] == ["glab", "auth"]:
                return (127, "", "glab not found")
            return (1, "", "unexpected")
        monkeypatch.setattr(issue_service, "_run", fake_run(responder))
        r = await issue_service.detect_provider("/ws")
        assert r["provider"] == "gitlab"
        assert r["cli_available"] is False
        assert r["authenticated"] is False

    @pytest.mark.asyncio
    async def test_unknown_host(self, monkeypatch):
        def responder(args):
            return (0, "https://bitbucket.org/o/r.git\n", "")
        monkeypatch.setattr(issue_service, "_run", fake_run(responder))
        r = await issue_service.detect_provider("/ws")
        assert r["provider"] == "unknown"
        assert r["cli_available"] is False

    @pytest.mark.asyncio
    async def test_no_workspace(self):
        r = await issue_service.detect_provider("")
        assert r["ok"] is False
        assert r["provider"] == "unknown"


# ── list_issues / get_issue ────────────────────────────────────────────────────

class TestListIssues:
    @pytest.mark.asyncio
    async def test_github_list(self, monkeypatch):
        def responder(args):
            if args[0] == "git":
                return (0, "https://github.com/o/r.git\n", "")
            if args[:3] == ["gh", "issue", "list"]:
                return (0, GH_LIST, "")
            return (1, "", "unexpected")
        monkeypatch.setattr(issue_service, "_run", fake_run(responder))
        r = await issue_service.list_issues("/ws")
        assert r["ok"] is True
        assert r["provider"] == "github"
        assert len(r["issues"]) == 1
        assert r["issues"][0]["number"] == 13643

    @pytest.mark.asyncio
    async def test_gitlab_list(self, monkeypatch):
        def responder(args):
            if args[0] == "git":
                return (0, "git@gitlab.com:o/r.git\n", "")
            if args[:3] == ["glab", "issue", "list"]:
                return (0, GLAB_LIST, "")
            return (1, "", "unexpected")
        monkeypatch.setattr(issue_service, "_run", fake_run(responder))
        r = await issue_service.list_issues("/ws")
        assert r["ok"] is True
        assert r["issues"][0]["number"] == 8361

    @pytest.mark.asyncio
    async def test_unknown_host_no_spawn(self, monkeypatch):
        def responder(args):
            if args[0] == "git":
                return (0, "https://bitbucket.org/o/r.git\n", "")
            raise AssertionError("must not spawn a CLI for unknown host")
        monkeypatch.setattr(issue_service, "_run", fake_run(responder))
        r = await issue_service.list_issues("/ws")
        assert r["ok"] is False
        assert "no supported issue host" in r["error"]

    @pytest.mark.asyncio
    async def test_cli_failure_surfaces_error(self, monkeypatch):
        def responder(args):
            if args[0] == "git":
                return (0, "https://github.com/o/r.git\n", "")
            return (127, "", "gh not found")
        monkeypatch.setattr(issue_service, "_run", fake_run(responder))
        r = await issue_service.list_issues("/ws")
        assert r["ok"] is False
        assert "gh not found" in r["error"]

    @pytest.mark.asyncio
    async def test_trusted_issue_route_inherits_existing_gh_auth_config(self, tmp_path, monkeypatch):
        if osplat.paths.executable_candidates("gh") != ["gh"]:
            # Same harness as test_host_shell: a `#!/bin/sh` fake exec'd by
            # bare name, which this platform's resolver would never pick up
            # (Windows resolves only `gh.exe`; see _BARE_NAME_IS_RUNNABLE there).
            pytest.skip("fake-CLI harness is a /bin/sh script exec'd by bare name")
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        source_config = tmp_path / "gh-config"
        source_config.mkdir()
        (source_config / "hosts.yml").write_text(
            "github.com:\n  user: trusted-fixture\n  oauth_token: trusted-secret-fixture\n",
            encoding="utf-8",
        )
        fake_gh = bin_dir / "gh"
        fake_gh.write_text(
            "#!/bin/sh\n"
            "if grep -Fq 'trusted-secret-fixture' \"$GH_CONFIG_DIR/hosts.yml\"; then printf '[]'; else exit 22; fi\n",
            encoding="utf-8",
        )
        fake_gh.chmod(0o755)
        repo = tmp_path / "repo"
        subprocess.run(["git", "init", str(repo)], check=True, capture_output=True, text=True)
        (repo / ".git" / "config").write_text(
            "[core]\nrepositoryformatversion = 0\nbare = false\n"
            '[remote "origin"]\nurl = https://github.com/acme/repo.git\n',
            encoding="utf-8",
        )
        monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}/opt/homebrew/bin:/usr/bin:/bin")
        monkeypatch.setenv("GH_CONFIG_DIR", str(source_config))

        git_result = await issue_service._run(["git", "config", "--get", "remote.origin.url"], str(repo))
        assert git_result == (0, "https://github.com/acme/repo.git\n", "")
        result = await issue_service.list_issues(str(repo))

        assert result == {"ok": True, "provider": "github", "issues": [], "error": ""}

    @pytest.mark.asyncio
    async def test_github_get_detail(self, monkeypatch):
        def responder(args):
            if args[0] == "git":
                return (0, "https://github.com/o/r.git\n", "")
            if args[:3] == ["gh", "issue", "view"]:
                return (0, GH_VIEW, "")
            return (1, "", "unexpected")
        monkeypatch.setattr(issue_service, "_run", fake_run(responder))
        r = await issue_service.get_issue("/ws", 13643)
        assert r["ok"] is True
        assert r["issue"]["body"] == "### Describe the feature"
        assert len(r["issue"]["comments"]) == 1


# ── write ops + validation ─────────────────────────────────────────────────────

class TestWriteOps:
    @pytest.mark.asyncio
    async def test_create_returns_url(self, monkeypatch):
        def responder(args):
            if args[0] == "git":
                return (0, "https://github.com/o/r.git\n", "")
            if args[:3] == ["gh", "issue", "create"]:
                return (0, "https://github.com/o/r/issues/42\n", "")
            return (1, "", "unexpected")
        monkeypatch.setattr(issue_service, "_run", fake_run(responder))
        r = await issue_service.create_issue("/ws", "New bug", "details")
        assert r["ok"] is True
        assert r["url"] == "https://github.com/o/r/issues/42"

    @pytest.mark.asyncio
    async def test_create_requires_title(self):
        r = await issue_service.create_issue("/ws", "   ")
        assert r["ok"] is False
        assert "title" in r["error"]

    @pytest.mark.asyncio
    async def test_comment_glab_uses_note(self, monkeypatch):
        seen = {}
        def responder(args):
            if args[0] == "git":
                return (0, "https://gitlab.com/o/r.git\n", "")
            seen["args"] = args
            return (0, "", "")
        monkeypatch.setattr(issue_service, "_run", fake_run(responder))
        r = await issue_service.comment_issue("/ws", 5, "hello")
        assert r["ok"] is True
        assert seen["args"][:3] == ["glab", "issue", "note"]

    @pytest.mark.asyncio
    async def test_set_state_close(self, monkeypatch):
        seen = {}
        def responder(args):
            if args[0] == "git":
                return (0, "https://github.com/o/r.git\n", "")
            seen["args"] = args
            return (0, "", "")
        monkeypatch.setattr(issue_service, "_run", fake_run(responder))
        r = await issue_service.set_issue_state("/ws", 7, "closed")
        assert r["ok"] is True
        assert seen["args"] == ["gh", "issue", "close", "7"]

    @pytest.mark.asyncio
    async def test_invalid_number_rejected(self):
        r = await issue_service.get_issue("/ws", "abc")
        assert r["ok"] is False
        assert "number" in r["error"]

    @pytest.mark.asyncio
    async def test_invalid_state_rejected(self):
        r = await issue_service.set_issue_state("/ws", 7, "frozen")
        assert r["ok"] is False
        assert "state" in r["error"]


@pytest.mark.asyncio
async def test_run_timeout_kills_and_reaps(monkeypatch):
    """On timeout, _run kills AND awaits the child so it doesn't linger as a zombie."""
    import asyncio

    holder = {}

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
        holder["proc"] = FakeProc()
        return holder["proc"]

    real_wait_for = asyncio.wait_for

    async def fast_wait_for(awaitable, timeout=None):
        return await real_wait_for(awaitable, timeout=0.01)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(asyncio, "wait_for", fast_wait_for)
    # The broker resolves `gh` through the seam before exec; without this a
    # host with no gh (or the seam swapped) reports 127 before the fake runs.
    monkeypatch.setattr(osplat.paths, "resolve_program", lambda name, *, path=None: name)
    # The tree kill reads the fake's pid: keep it off the real process table.
    tree_reads: list = []
    kills: list = []
    monkeypatch.setattr(host_shell.process_tree, "descendants", lambda pid: tree_reads.append(pid) or [])
    monkeypatch.setattr(host_shell.process_tree, "identity", lambda pid: "")
    monkeypatch.setattr(host_shell.process_tree, "kill", lambda pid, *, force: kills.append(pid))

    rc, _out, err = await issue_service._run(["gh", "issue", "list"], "/ws")
    assert rc == 128
    assert "timed out" in err
    assert holder["proc"].killed is True
    assert holder["proc"].waited is True
    assert (tree_reads, kills) == ([holder["proc"].pid], [])
