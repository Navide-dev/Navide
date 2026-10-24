"""A timed-out host_shell run ends its whole tree, not only its direct child.

Its own file because the descendant snapshot reads `ps`, which macOS's
sandbox-exec refuses to run: scripts/isolated-pytest.sh and the release gate
run this file in their unsandboxed pass. The slot-leak half, which needs no
real process, is in test_host_shell.py.
"""

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
