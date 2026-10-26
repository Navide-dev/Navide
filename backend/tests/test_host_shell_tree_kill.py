"""A timed-out host_shell run ends its whole tree, not only its direct child.

Its own file because the descendant snapshot reads `ps`, which macOS's
sandbox-exec refuses to run: scripts/isolated-pytest.sh and the release gate
run this file in their unsandboxed pass. The slot-leak half, which needs no
real process, is in test_host_shell.py.
"""

import os
import time

import pytest

from agent_team_backend import host_shell, osplat


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
@pytest.mark.skipif(os.name == "nt", reason="POSIX process groups; Windows has none")
@pytest.mark.skipif(
    osplat.paths.resolve_program("git") is None,
    reason="git is not resolvable through osplat.paths on this host",
)
async def test_a_grandchild_the_tree_read_missed_still_ends(tmp_path, monkeypatch, caplog) -> None:
    """A grandchild forked after the tree read (git still starting when the
    run timed out) is not in the snapshot, and once git dies it is init's
    child, out of any later read's reach. Its process group still ends it.
    The read here waits until sleep is running and then reports no
    descendants, so the miss happens every time, however fast the host is."""
    marker = tmp_path / "sleep.pid"
    monkeypatch.setenv("NAVIDE_TEST_MARKER", str(marker))

    def missed_read(pid: int) -> list[tuple[int, str]]:
        deadline = time.monotonic() + 30
        while not marker.exists() or not marker.read_text().strip():
            assert time.monotonic() < deadline, "the grandchild never started"
            time.sleep(0.01)
        return []

    monkeypatch.setattr(host_shell, "_descendants_with_identity", missed_read)
    # Long enough that a wait for the orphan's pipe would show as a give-up.
    monkeypatch.setattr(host_shell, "_KILL_REAP_TIMEOUT_S", 10.0)
    caplog.set_level("WARNING", logger="agent_team_backend.host_shell")

    rc, _, stderr = await host_shell.run_allowlisted_text(
        ["git", "-c", 'alias.hang=!echo $$ > "$NAVIDE_TEST_MARKER"; exec sleep 30', "hang"],
        str(tmp_path),
        timeout=0.5,
    )

    assert rc == 128 and "timed out" in stderr
    assert not [r for r in caplog.records if "stopped waiting" in r.getMessage()]
    sleep_pid = int(marker.read_text())
    deadline = time.monotonic() + 10
    while osplat.process_tree.is_alive(sleep_pid) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not osplat.process_tree.is_alive(sleep_pid)
