"""Terminal pipeline baseline: PTY output throughput and session startup.

Drives the real ``TerminalService`` against a real PTY child, the same path a
CLI pane uses, and measures the backend half of it: PTY read -> buffer ->
flush -> binary output frame handed to the WebSocket emitter. The renderer
half (xterm.js parse and paint) is not covered; it is outside the backend and
Navide does not change it.

Two measurements:

throughput  A child writes ``--mb`` MiB of text as fast as it can. Reports
            MiB/s from create() to the last output frame, how many frames
            carried it, and whether every payload byte arrived (the 5 MB drop
            policy would show up here as missing bytes). Carriage returns are
            not counted: the tty adds them (ONLCR), and macOS occasionally
            emits a doubled one where a "\n" lands on a 1 KiB boundary.
startup     ``--runs`` trivial children that print one marker and exit.
            Reports create() -> first output frame, p50 / p95 / max.

``--send-delay-ms`` makes each emitted frame cost that long, standing in for a
WebSocket send that cannot keep up; 0 only yields to the loop.

Usage (repository root)::

    uv --project backend run python backend/scripts/bench_terminal.py
    uv --project backend run python backend/scripts/bench_terminal.py \\
        --mb 64 --payload cjk --send-delay-ms 1 --json

Numbers depend on the machine and its load; compare runs taken back to back on
the same machine, not across machines.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
import tempfile
import time
from dataclasses import asdict, dataclass

from agent_team_backend.terminals import TerminalService

_LINES = {
    "ascii": "The quick brown fox jumps over the lazy dog 0123456789 abcdefghij\n",
    "cjk": "終端機輸出吞吐量量測用的中文字串，每一行長度相同，混合全形標點。\n",
}
_STARTUP_MARKER = "navide-bench-ready"


@dataclass
class ThroughputResult:
    payload: str
    mib: float
    send_delay_ms: float
    seconds: float
    mib_per_s: float
    frames: int
    bytes_received: int
    payload_expected: int | None
    payload_received: int


@dataclass
class StartupResult:
    runs: int
    p50_ms: float
    p95_ms: float
    max_ms: float


def _frame_data(frame: bytes) -> bytes:
    """Raw PTY bytes of a binary terminal-output frame (header skipped)."""
    off = 6 + frame[5]
    off += 1 + frame[off]
    return frame[off:]


class _Sink:
    """Stands in for the WebSocket emitter: counts frames and bytes."""

    def __init__(self, send_delay_ms: float) -> None:
        self.delay = send_delay_ms / 1000
        self.frames = 0
        self.nbytes = 0
        self.payload = 0
        self.first_frame_at: float | None = None
        self.last_frame_at: float | None = None
        self.first_text = b""
        self.exited = asyncio.Event()

    async def emit(self, event: object) -> None:
        if isinstance(event, (bytes, bytearray)):
            now = time.perf_counter()
            if self.first_frame_at is None:
                self.first_frame_at = now
            self.last_frame_at = now
            data = _frame_data(bytes(event))
            if len(self.first_text) < 256:
                self.first_text += data[: 256 - len(self.first_text)]
            self.frames += 1
            self.nbytes += len(data)
            self.payload += len(data) - data.count(b"\r")
            if self.delay:
                await asyncio.sleep(self.delay)
            else:
                await asyncio.sleep(0)
        elif isinstance(event, dict) and event.get("type") == "terminal.exit":
            self.exited.set()


def _writer_child(path: str) -> list[str]:
    # The payload is read from a file so the child's own startup is the only
    # Python work before the flood; writes go out in 64 KiB blocks.
    code = (
        "import sys\n"
        "data = open(sys.argv[1], 'rb').read()\n"
        "out = sys.stdout.buffer\n"
        "for i in range(0, len(data), 65536):\n"
        "    out.write(data[i:i + 65536])\n"
        "out.flush()\n"
    )
    return [sys.executable, "-c", code, path]


async def measure_throughput(
    mib: float, payload: str = "ascii", send_delay_ms: float = 0.0, timeout_s: float = 300.0
) -> ThroughputResult:
    line = _LINES[payload].encode("utf-8")
    count = max(1, int(mib * 1024 * 1024) // len(line))
    data = line * count
    # ConPTY re-renders the screen instead of passing bytes through, so on
    # Windows there is no byte count to check against.
    expected = None if sys.platform == "win32" else len(data)
    sink = _Sink(send_delay_ms)
    svc = TerminalService(sink.emit)
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "payload.bin")
        with open(path, "wb") as fp:
            fp.write(data)
        started = time.perf_counter()
        session = svc.create(
            pane_id="bench-throughput",
            agent_key=None,
            command=_writer_child(path),
            cwd=tmp,
            cols=200,
            rows=50,
        )
        try:
            await asyncio.wait_for(sink.exited.wait(), timeout_s)
        finally:
            if not sink.exited.is_set():
                await svc.kill(session.id, force=True)
    end = sink.last_frame_at or time.perf_counter()
    seconds = end - started
    received_mib = sink.nbytes / (1024 * 1024)
    return ThroughputResult(
        payload=payload,
        mib=round(len(data) / (1024 * 1024), 2),
        send_delay_ms=send_delay_ms,
        seconds=round(seconds, 3),
        mib_per_s=round(received_mib / seconds, 1) if seconds > 0 else 0.0,
        frames=sink.frames,
        bytes_received=sink.nbytes,
        payload_expected=expected,
        payload_received=sink.payload,
    )


async def measure_startup(runs: int = 20, timeout_s: float = 30.0) -> StartupResult:
    samples: list[float] = []
    cwd = tempfile.gettempdir()
    for i in range(runs):
        sink = _Sink(0.0)
        svc = TerminalService(sink.emit)
        started = time.perf_counter()
        session = svc.create(
            pane_id=f"bench-startup-{i}",
            agent_key=None,
            command=[sys.executable, "-c", f"print({_STARTUP_MARKER!r})"],
            cwd=cwd,
        )
        try:
            await asyncio.wait_for(sink.exited.wait(), timeout_s)
        finally:
            if not sink.exited.is_set():
                await svc.kill(session.id, force=True)
        if sink.first_frame_at is None or _STARTUP_MARKER.encode() not in sink.first_text:
            raise RuntimeError(f"startup run {i}: marker never arrived")
        samples.append((sink.first_frame_at - started) * 1000)
    samples.sort()
    p95_index = min(len(samples) - 1, max(0, round(0.95 * len(samples)) - 1))
    return StartupResult(
        runs=runs,
        p50_ms=round(statistics.median(samples), 1),
        p95_ms=round(samples[p95_index], 1),
        max_ms=round(samples[-1], 1),
    )


async def _main(args: argparse.Namespace) -> int:
    report: dict[str, object] = {"platform": sys.platform, "python": sys.version.split()[0]}
    if args.only in (None, "throughput"):
        report["throughput"] = asdict(
            await measure_throughput(args.mb, args.payload, args.send_delay_ms)
        )
    if args.only in (None, "startup"):
        report["startup"] = asdict(await measure_startup(args.runs))
    if args.json:
        print(json.dumps(report, ensure_ascii=False))
    else:
        for key, value in report.items():
            print(f"{key}: {value}")
    throughput = report.get("throughput")
    if (
        isinstance(throughput, dict)
        and throughput["payload_expected"] is not None
        and throughput["payload_received"] != throughput["payload_expected"]
    ):
        print("WARNING: output bytes were lost (drop policy engaged?)", file=sys.stderr)
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--mb", type=float, default=32.0, help="MiB the child writes")
    parser.add_argument("--payload", choices=sorted(_LINES), default="ascii")
    parser.add_argument("--send-delay-ms", type=float, default=0.0)
    parser.add_argument("--runs", type=int, default=20, help="startup samples")
    parser.add_argument("--only", choices=("throughput", "startup"))
    parser.add_argument("--json", action="store_true", help="one JSON line")
    return asyncio.run(_main(parser.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
