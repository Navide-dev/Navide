"""Keeps backend/scripts/bench_terminal.py runnable.

The benchmark is run by hand, so nothing else would notice it rotting when
TerminalService changes. These runs are tiny and assert only what must hold
on any machine: every byte arrives, and a startup sample is measured.
"""

import importlib.util
import sys
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "bench_terminal.py"


def _load():
    spec = importlib.util.spec_from_file_location("bench_terminal", _SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    # dataclasses resolves string annotations through sys.modules.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.mark.skipif(
    sys.platform == "win32",
    reason="ConPTY re-renders output; the 0.25 MiB run timed out on the Windows runner",
)
async def test_throughput_delivers_every_byte():
    bench = _load()
    for payload in ("ascii", "cjk"):
        result = await bench.measure_throughput(0.25, payload, timeout_s=60)
        if result.payload_expected is not None:
            assert result.payload_received == result.payload_expected, result
        assert result.frames >= 1


async def test_startup_measures_first_frame():
    bench = _load()
    result = await bench.measure_startup(runs=2, timeout_s=30)
    assert result.runs == 2
    assert 0 < result.p50_ms <= result.max_ms
