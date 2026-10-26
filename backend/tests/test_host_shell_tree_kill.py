"""A timed-out host_shell run ends its whole tree, not only its direct child.

Its own file because the descendant snapshot reads `ps`, which macOS's
sandbox-exec refuses to run: scripts/isolated-pytest.sh and the release gate
run this file in their unsandboxed pass. The slot-leak half, which needs no
real process, is in test_host_shell.py.
"""

import os
import sys
import time

import pytest

from agent_team_backend import host_shell, osplat

#: Run by the git alias through sh: writes its own OS pid (not the shell's,
#: which on Windows is an MSYS pid) and stays.
_STAY = (
    "import os, time; m = os.environ['NAVIDE_TEST_MARKER']; "
    "open(m + '.tmp', 'w').write(str(os.getpid())); os.replace(m + '.tmp', m); time.sleep(30)"
)


def _wait_for_pid(marker) -> int:
    deadline = time.monotonic() + 30
    while not marker.exists():
        assert time.monotonic() < deadline, "the grandchild never started"
        time.sleep(0.01)
    return int(marker.read_text())


@pytest.mark.asyncio
@pytest.mark.skipif(
    osplat.paths.resolve_program("git") is None,
    reason="git is not resolvable through osplat.paths on this host",
)
async def test_a_timed_out_run_ends_the_grandchild_holding_its_pipes(tmp_path) -> None:
    """git runs the alias through sh, and sleep inherits git's stdout. Killing
    git alone leaves sleep holding the pipe, and the wait for it to close
    then lasts as long as sleep does; killing the tree closes it at once."""
    start = time.monotonic()
    rc, _, stderr = await host_shell.run_allowlisted_text(
        ["git", "-c", "alias.hang=!sleep 30", "hang"], str(tmp_path), timeout=0.5
    )
    elapsed = time.monotonic() - start

    assert rc == 128 and "timed out" in stderr
    assert elapsed < 0.5 + host_shell._KILL_REAP_TIMEOUT_S


@pytest.mark.asyncio
@pytest.mark.skipif(
    osplat.paths.resolve_program("git") is None,
    reason="git is not resolvable through osplat.paths on this host",
)
async def test_a_grandchild_the_tree_read_missed_still_ends(tmp_path, monkeypatch, caplog) -> None:
    """A grandchild forked after the tree read (git still starting when the
    run timed out) is not in the snapshot, and once git dies it is init's
    child, out of any later read's reach. Its process group (POSIX) or its
    job (Windows) still ends it. The read here waits until the grandchild is
    running and then reports no descendants, so the miss happens every time,
    however fast the host is."""
    marker = tmp_path / "stay.pid"
    monkeypatch.setenv("NAVIDE_TEST_MARKER", str(marker))
    monkeypatch.setenv("NAVIDE_TEST_PY", sys.executable)
    monkeypatch.setenv("NAVIDE_TEST_CODE", _STAY)

    def missed_read(pid: int) -> list[tuple[int, str]]:
        _wait_for_pid(marker)
        return []

    monkeypatch.setattr(host_shell, "_descendants_with_identity", missed_read)
    # Long enough that a wait for the orphan's pipe would show as a give-up.
    monkeypatch.setattr(host_shell, "_KILL_REAP_TIMEOUT_S", 10.0)
    caplog.set_level("WARNING", logger="agent_team_backend.host_shell")

    rc, _, stderr = await host_shell.run_allowlisted_text(
        ["git", "-c", 'alias.hang=!"$NAVIDE_TEST_PY" -c "$NAVIDE_TEST_CODE"', "hang"],
        str(tmp_path),
        timeout=0.5,
    )

    assert rc == 128 and "timed out" in stderr
    assert not [r for r in caplog.records if "stopped waiting" in r.getMessage()]
    stay_pid = int(marker.read_text())
    deadline = time.monotonic() + 10
    while osplat.process_tree.is_alive(stay_pid) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not osplat.process_tree.is_alive(stay_pid)


@pytest.mark.asyncio
@pytest.mark.skipif(
    osplat.paths.resolve_program("git") is None,
    reason="git is not resolvable through osplat.paths on this host",
)
async def test_a_run_that_ends_normally_leaves_what_it_started_running(tmp_path, monkeypatch) -> None:
    """Only a timeout ends the tree. A run that finishes leaves a process it
    started in the background running, as it did before runs had a group or
    a job of their own (git starts its fsmonitor daemon this way)."""
    marker = tmp_path / "stay.pid"
    monkeypatch.setenv("NAVIDE_TEST_MARKER", str(marker))
    monkeypatch.setenv("NAVIDE_TEST_PY", sys.executable)
    monkeypatch.setenv("NAVIDE_TEST_CODE", _STAY)

    rc, _, stderr = await host_shell.run_allowlisted_text(
        [
            "git",
            "-c",
            'alias.spawn=!"$NAVIDE_TEST_PY" -c "$NAVIDE_TEST_CODE" </dev/null >/dev/null 2>&1 &',
            "spawn",
        ],
        str(tmp_path),
        timeout=30,
    )
    assert rc == 0, stderr
    stay_pid = _wait_for_pid(marker)
    try:
        # Past the release of the run's job: a kill on its close would be done.
        time.sleep(0.5)
        assert osplat.process_tree.is_alive(stay_pid)
    finally:
        try:
            osplat.process_tree.kill(stay_pid, force=True)
        except OSError:
            pass


#: Prints its cwd and one variable, writes stderr and exits 3.
_REPORT = (
    "import os, sys; print(os.getcwd()); print(os.environ.get('NAVIDE_TEST_VALUE')); "
    "sys.stderr.write('to stderr'); sys.exit(3)"
)


@pytest.mark.asyncio
@pytest.mark.skipif(
    osplat.paths.resolve_program("git") is None,
    reason="git is not resolvable through osplat.paths on this host",
)
async def test_a_run_that_ends_normally_reports_as_before(tmp_path, monkeypatch) -> None:
    """The group (POSIX) or job (Windows) a run starts in changes nothing it
    reports: cwd, environment, stdout, stderr and exit code are the run's."""
    monkeypatch.setenv("NAVIDE_TEST_PY", sys.executable)
    monkeypatch.setenv("NAVIDE_TEST_CODE", _REPORT)
    monkeypatch.setenv("NAVIDE_TEST_VALUE", "inherited")

    rc, stdout, stderr = await host_shell.run_allowlisted_text(
        ["git", "-c", 'alias.report=!"$NAVIDE_TEST_PY" -c "$NAVIDE_TEST_CODE"', "report"],
        str(tmp_path),
        timeout=30,
    )

    assert rc == 3
    cwd, value = stdout.splitlines()
    assert os.path.samefile(cwd, tmp_path)
    assert value == "inherited"
    assert stderr == "to stderr"


@pytest.mark.skipif(os.name == "nt", reason="the POSIX implementation")
def test_on_posix_a_run_gets_nothing_but_its_process_group() -> None:
    """POSIX keeps what #673 shipped: a process group, no job, nothing to release."""
    tree = osplat.process_tree
    assert tree.own_group_spawn_kwargs() == {"process_group": 0}
    assert tree.start_own_group(os.getpid()) is None
    assert tree.release_contained(os.getpid(), 1) is None
