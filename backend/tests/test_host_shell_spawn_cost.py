"""Starting a host_shell child must not cost more as the backend grows (#622).

A plain fork() copies the parent's page tables, so its cost grows with the
backend's resident memory: a report from a 9.5 GB backend measured 139 ms per
spawn, all of it spent blocking the event loop. CPython takes its vfork()
path on Linux when nothing in the call rules it out (no preexec_fn, no uid or
gid change), and vfork copies nothing. This pins that host_shell's spawns stay
on that path, by timing the event-loop-blocking part of a spawn before and
after the process has touched a large heap.

Linux only: macOS has no vfork path in `_posixsubprocess`, and Windows
starts processes with CreateProcess.
"""

import asyncio
import statistics
import sys
import time

import pytest

from agent_team_backend import host_shell, osplat

_HEAP_BYTES = 2 << 30  # 2 GiB: a plain fork pays ~25-30 ms for it (139 ms at 9.5 GB).
_PAGE = 4096
_SPAWNS = 15


async def _median_spawn_s(monkeypatch: pytest.MonkeyPatch, cwd: str) -> float:
    """Median time `create_subprocess_exec` holds the loop for one git run."""
    orig = asyncio.create_subprocess_exec
    spent: list[float] = []

    async def timed(*args, **kwargs):
        start = time.perf_counter()
        try:
            return await orig(*args, **kwargs)
        finally:
            spent.append(time.perf_counter() - start)

    monkeypatch.setattr(host_shell.asyncio, "create_subprocess_exec", timed)
    try:
        for _ in range(_SPAWNS):
            rc, _, _ = await host_shell.run_allowlisted(["git", "--version"], cwd)
            assert rc == 0
    finally:
        monkeypatch.setattr(host_shell.asyncio, "create_subprocess_exec", orig)
    return statistics.median(spent)


@pytest.mark.asyncio
@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="vfork path is Linux-only")
@pytest.mark.skipif(
    osplat.paths.resolve_program("git") is None,
    reason="git is not resolvable through osplat.paths on this host",
)
async def test_spawn_cost_does_not_grow_with_the_backend_heap(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = await _median_spawn_s(monkeypatch, str(tmp_path))
    heap = bytearray(_HEAP_BYTES)
    # Touch every page so it is really mapped, as a grown heap is.
    heap[::_PAGE] = b"\x01" * (_HEAP_BYTES // _PAGE)
    try:
        after = await _median_spawn_s(monkeypatch, str(tmp_path))
    finally:
        del heap
    print(f"spawn median before={before * 1000:.2f}ms after={after * 1000:.2f}ms")
    assert after - before < 0.005, (before, after)
