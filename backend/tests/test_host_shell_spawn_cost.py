"""Starting a host_shell child must not cost more as the backend grows (#622).

A plain fork() copies the parent's page tables, so its cost grows with the
backend's resident memory: a report from a 9.5 GB backend measured 139 ms per
spawn, all of it spent blocking the event loop. CPython takes its vfork()
path on Linux when nothing in the call rules it out (no preexec_fn, no uid or
gid change), and vfork copies nothing. This pins that host_shell's spawns stay
on that path, by timing the event-loop-blocking part of a spawn before and
after the process has touched a large heap. A forced fork on the same heap is
the positive control: if it is not clearly slower, this host cannot tell the
two paths apart and the test skips rather than passing on nothing.

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
# The forced fork must cost at least this on the heap, or the host (e.g. with
# transparent huge pages set to always) cannot show the difference.
_CONTROL_MIN_S = 0.010
_MAX_GROWTH_S = 0.005


async def _run_plain(cwd: str) -> int:
    rc, _, _ = await host_shell.run_allowlisted(["git", "--version"], cwd)
    return rc


async def _run_capped(cwd: str) -> int:
    rc, _, _, _ = await host_shell.run_allowlisted_capped(
        ["git", "--version"], cwd, max_stdout_bytes=4096
    )
    return rc


async def _run_text(cwd: str) -> int:
    rc, _, _ = await host_shell.run_allowlisted_text(["git", "--version"], cwd)
    return rc


_RUNNERS = {"run_allowlisted": _run_plain, "run_allowlisted_capped": _run_capped,
            "run_allowlisted_text": _run_text}


async def _median_spawn_s(monkeypatch: pytest.MonkeyPatch, cwd: str, run, **force) -> float:
    """Median time `create_subprocess_exec` holds the loop for one git run.

    `force` is merged into the spawn's keyword arguments: the control passes
    a preexec_fn, which rules vfork out and makes CPython fork."""
    orig = asyncio.create_subprocess_exec
    spent: list[float] = []

    async def timed(*args, **kwargs):
        start = time.perf_counter()
        try:
            return await orig(*args, **{**kwargs, **force})
        finally:
            spent.append(time.perf_counter() - start)

    monkeypatch.setattr(host_shell.asyncio, "create_subprocess_exec", timed)
    try:
        for _ in range(_SPAWNS):
            assert await run(cwd) == 0
    finally:
        monkeypatch.setattr(host_shell.asyncio, "create_subprocess_exec", orig)
    return statistics.median(spent)


@pytest.mark.serial
@pytest.mark.asyncio
@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="vfork path is Linux-only")
@pytest.mark.skipif(
    osplat.paths.resolve_program("git") is None,
    reason="git is not resolvable through osplat.paths on this host",
)
async def test_spawn_cost_does_not_grow_with_the_backend_heap(
    tmp_path, monkeypatch: pytest.MonkeyPatch, record_property
) -> None:
    cwd = str(tmp_path)
    before = {name: await _median_spawn_s(monkeypatch, cwd, run) for name, run in _RUNNERS.items()}
    heap = bytearray(_HEAP_BYTES)
    # Touch every page so it is really mapped, as a grown heap is.
    heap[::_PAGE] = b"\x01" * (_HEAP_BYTES // _PAGE)
    try:
        after = {name: await _median_spawn_s(monkeypatch, cwd, run) for name, run in _RUNNERS.items()}
        control = await _median_spawn_s(
            monkeypatch, cwd, _run_plain, preexec_fn=lambda: None
        )
    finally:
        del heap
    record_property("forced_fork_ms", round(control * 1000, 3))
    for name in _RUNNERS:
        record_property(f"{name}_before_ms", round(before[name] * 1000, 3))
        record_property(f"{name}_after_ms", round(after[name] * 1000, 3))
    print(f"before={before} after={after} forced_fork={control}")
    if control < _CONTROL_MIN_S:
        pytest.skip(
            f"a forced fork on the {_HEAP_BYTES >> 30} GiB heap took only {control * 1000:.1f} ms;"
            " this host cannot tell fork from vfork"
        )
    for name in _RUNNERS:
        assert after[name] - before[name] < _MAX_GROWTH_S, (name, before[name], after[name], control)
