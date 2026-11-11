"""host_shell runs on every event loop the backend can be served on.

uvicorn picks uvloop whenever it is installed (``loop="auto"``), and the
packaged macOS/Linux backend ships it, while pytest-asyncio runs every other
test on the stdlib loop. From 0.2.32 a ``process_group`` spawn kwarg that only
asyncio accepts failed every host_shell run in production and no test saw it.
These run each check on both loops, driven through ``asyncio.Runner`` so the
loop is chosen here rather than by the pytest-asyncio plugin.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

import pytest

from agent_team_backend import git_service, host_shell, osplat

_HAS_GIT = osplat.paths.resolve_program("git") is not None


def _loop_factories() -> list:
    factories = [pytest.param(asyncio.new_event_loop, id="asyncio")]
    try:
        import uvloop
    except ImportError:  # Windows: uv.lock does not install it there.
        uvloop = None
    if uvloop is not None:
        factories.append(pytest.param(uvloop.new_event_loop, id="uvloop"))
    return factories


LOOPS = pytest.mark.parametrize("loop_factory", _loop_factories())


def _run_on(loop_factory: Callable[[], asyncio.AbstractEventLoop], coro):
    with asyncio.Runner(loop_factory=loop_factory) as runner:
        return runner.run(coro)


@LOOPS
def test_the_platform_spawn_kwargs_are_accepted_by_the_loop(loop_factory) -> None:
    """Guard: any kwarg osplat adds must be one this loop's subprocess
    transport accepts. uvloop raises ValueError("unexpected kwargs: ...")."""
    kwargs = osplat.process_tree.own_group_spawn_kwargs()

    async def spawn() -> int:
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-c", "pass",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            **kwargs,
        )
        return await process.wait()

    assert _run_on(loop_factory, spawn()) == 0


@pytest.mark.skipif(os.name == "nt", reason="the POSIX implementation")
@LOOPS
def test_a_posix_run_leads_a_process_group_of_its_own(loop_factory) -> None:
    """What end_own_group relies on: the child's group is its own pid and not
    the backend's group."""
    kwargs = osplat.process_tree.own_group_spawn_kwargs()

    async def spawn() -> tuple[int, int]:
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-c", "import os; print(os.getpgrp())",
            stdout=asyncio.subprocess.PIPE,
            **kwargs,
        )
        out, _ = await process.communicate()
        return process.pid, int(out)

    pid, group = _run_on(loop_factory, spawn())
    assert group == pid
    assert group != os.getpgrp()


@pytest.mark.skipif(not _HAS_GIT, reason="git is not resolvable through osplat.paths on this host")
@LOOPS
def test_run_allowlisted_runs_git(loop_factory, tmp_path) -> None:
    rc, stdout, stderr = _run_on(
        loop_factory, host_shell.run_allowlisted(["git", "--version"], str(tmp_path))
    )
    assert (rc, stderr) == (0, b"")
    assert stdout.startswith(b"git version")


@pytest.mark.skipif(not _HAS_GIT, reason="git is not resolvable through osplat.paths on this host")
@LOOPS
def test_run_allowlisted_capped_runs_git(loop_factory, tmp_path) -> None:
    rc, stdout, _, truncated = _run_on(
        loop_factory,
        host_shell.run_allowlisted_capped(
            ["git", "--version"], str(tmp_path), max_stdout_bytes=4096
        ),
    )
    assert (rc, truncated) == (0, False)
    assert stdout.startswith(b"git version")


def _init_repo(path: Path) -> None:
    for args in (
        ["git", "init"],
        ["git", "config", "user.email", "test@test.com"],
        ["git", "config", "user.name", "Test"],
        ["git", "config", "commit.gpgsign", "false"],
    ):
        subprocess.run(args, cwd=path, check=True, capture_output=True)
    (path / "README.md").write_text("# test")
    subprocess.run(["git", "add", "-A"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=path, check=True, capture_output=True)


@pytest.mark.skipif(not _HAS_GIT, reason="git is not resolvable through osplat.paths on this host")
@LOOPS
def test_git_status_sees_a_repository(loop_factory, tmp_path) -> None:
    """The Git window's own call: a real repository must not come back as an
    error envelope (D6, "Not a Git repository" on a macOS VM)."""
    _init_repo(tmp_path)
    result = _run_on(loop_factory, git_service.get_status(str(tmp_path)))
    assert result.get("is_git_repo") is True, result


@pytest.mark.skipif(not _HAS_GIT, reason="git is not resolvable through osplat.paths on this host")
@LOOPS
def test_a_failed_spawn_is_logged_without_its_arguments(
    loop_factory, tmp_path, monkeypatch, caplog
) -> None:
    """The caller still gets rc 128 and the message; the log names the
    executable and the exception type, never the argv, which may hold a
    token."""
    secret = "tok" + "en-" + "x" * 12

    async def refuse(*args, **kwargs):
        raise ValueError(f"unexpected kwargs: {secret}")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", refuse)
    caplog.set_level("WARNING", logger="agent_team_backend.host_shell")

    rc, _, stderr = _run_on(
        loop_factory,
        host_shell.run_allowlisted(["git", "log", f"--grep={secret}"], str(tmp_path)),
    )
    rc_capped, _, stderr_capped, _ = _run_on(
        loop_factory,
        host_shell.run_allowlisted_capped(
            ["git", "log", f"--grep={secret}"], str(tmp_path), max_stdout_bytes=10
        ),
    )

    assert (rc, rc_capped) == (128, 128)
    assert b"unexpected kwargs" in stderr and b"unexpected kwargs" in stderr_capped
    warnings = [r.getMessage() for r in caplog.records if r.name == "agent_team_backend.host_shell"]
    assert len(warnings) == 2
    for message in warnings:
        assert "git" in message and "ValueError" in message
        assert secret not in message
