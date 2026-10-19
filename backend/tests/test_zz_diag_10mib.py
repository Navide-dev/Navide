"""TEMPORARY CI diagnostic for the 10 MiB loop-slice flake; removed before review."""
import asyncio
import gc
import resource
import time
import warnings

import pytest

from tests.test_plugin_agent_tools_proxy import (  # noqa: F401
    _devmap_tool, _pieces_host, agent_tool_payload_text, host, proxy,
)

pytestmark = pytest.mark.asyncio


def _flt() -> int:
    return resource.getrusage(resource.RUSAGE_SELF).ru_minflt


def test_diag_fault_cost() -> None:
    for size in (8 << 20, 40 << 20):
        f0, c0 = _flt(), time.thread_time()
        block = bytearray(size)
        block[::4096] = b"\1" * len(range(0, size, 4096))
        cpu, faults = time.thread_time() - c0, _flt() - f0
        del block
        parts = ["abc中文😀" * 40_000 for _ in range(size // 1_000_000)]
        f0, c0 = _flt(), time.thread_time()
        joined = "".join(parts)
        jcpu, jfaults = time.thread_time() - c0, _flt() - f0
        del joined, parts
        warnings.warn(f"DIAG fault-cost size={size >> 20}MiB touch cpu={cpu * 1000:.2f}ms faults={faults} "
                      f"us/fault={cpu * 1e6 / max(faults, 1):.1f} | join cpu={jcpu * 1000:.2f}ms faults={jfaults}")


@pytest.mark.parametrize("which", ["str", "rows"])
async def test_diag_steps(monkeypatch, which) -> None:
    value = ({"data": "abc中文😀" * (10 * 1_048_576 // 16)} if which == "str"
             else {"rows": [{"k": i, "v": "abcdefgh中"} for i in range(345_000)]})
    _devmap_tool(monkeypatch)
    _pieces_host(monkeypatch, agent_tool_payload_text({"warm": "x" * 200_000}))
    assert (await proxy.call("devmap_read", {}, None)).isError is False
    _pieces_host(monkeypatch, agent_tool_payload_text(value))
    del value
    run = asyncio.events.Handle._run
    for attempt in range(3):
        gc.collect()
        steps: list[tuple[float, float, int, int]] = []

        def timed(handle, steps=steps) -> None:
            f0, c0, w0 = _flt(), time.thread_time(), time.perf_counter()
            try:
                run(handle)
            finally:
                steps.append((time.thread_time() - c0, time.perf_counter() - w0, _flt() - f0, len(steps)))

        monkeypatch.setattr(asyncio.events.Handle, "_run", timed)
        await asyncio.sleep(0)
        await proxy.call("devmap_read", {}, None)
        await asyncio.sleep(0)
        monkeypatch.setattr(asyncio.events.Handle, "_run", run)
        top = sorted(steps, reverse=True)[:3]
        warnings.warn(f"DIAG {which} attempt={attempt} steps={len(steps)} sum_cpu={sum(s[0] for s in steps) * 1000:.1f}ms "
                      f"sum_faults={sum(s[2] for s in steps)} top=" + " ".join(
                          f"[#{i}/{len(steps)} cpu={c * 1000:.2f} wall={w * 1000:.2f} flt={f}]" for c, w, f, i in top))
