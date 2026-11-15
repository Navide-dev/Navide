"""Where a routed reader call's time goes: a micro-benchmark, not a test.

    uv --project backend run python backend/tests/bench_cli_runtime.py [rounds [earlier]]

It replays what one agent pane costs the backend: a Claude transcript that
grows by one record at a time (a user record, then an assistant record with
token usage, as the perf harness's fake agent writes them), read after every
append by ``parse_incremental`` and ``parse_activity``. ``earlier`` records
are written first (and read once), so the polls are timed on a transcript of
that length. It times that once
with main's Python reader and once through the Rust runtime, and then takes
the routed call apart:

* ``encode``: the request as a JSON line.
* ``pipe``: one request and its answer on a process of its own, written and
  read by the calling thread (no helper threads): the pipe round trip and the
  runtime's own request handling.
* ``threads``: the same request through the seam's client, minus ``pipe``:
  what the writer thread, the reader thread and the caller's queue add.
* ``rust``: a real read on the bare process, minus ``pipe`` for a ``ping``:
  the read itself and its larger answer.
* ``decode``: the answer line parsed back.
* ``objects``: the reader's result objects built from the parsed answer.

Needs the release build (``cargo build --release`` in
native/navide-cli-runtime). Every number is the median over the rounds, in
microseconds per call.
"""

from __future__ import annotations

import json
import statistics
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent_team_backend import cli_runtime  # noqa: E402
from agent_team_backend.cli_vendors.registry import vendor as cli_vendor  # noqa: E402

SESSION = "0198f6a2-71aa-4d02-9c11-2233445566aa"


def _record(turn: int, parent: str | None, cwd: str) -> dict[str, Any]:
    record_id = str(uuid.UUID(int=turn + 1))
    stamp = f"2026-11-14T00:{turn // 60 % 60:02d}:{turn % 60:02d}.000Z"
    base = {"parentUuid": parent, "isSidechain": False, "uuid": record_id, "sessionId": SESSION, "cwd": cwd,
            "version": "2.0.0", "timestamp": stamp}
    if turn % 2 == 0:
        return {**base, "type": "user",
                "message": {"role": "user", "content": f"scale turn {turn // 2}: continue the task"}}
    return {**base, "type": "assistant", "requestId": f"req_{record_id[:12]}", "message": {
        "id": f"msg_{record_id[:20]}", "type": "message", "role": "assistant", "model": "fixture-scale",
        "content": [{"type": "text", "text": f"Step {turn // 2} done; moving on to the next file."}],
        "stop_reason": "end_turn", "stop_sequence": None,
        "usage": {"input_tokens": 100, "cache_read_input_tokens": 50, "cache_creation_input_tokens": 10,
                  "output_tokens": 20}}}


def _timed(call: Callable[[], Any]) -> tuple[float, Any]:
    started = time.perf_counter()
    result = call()
    return (time.perf_counter() - started) * 1e6, result


def _median(samples: list[float]) -> float:
    return statistics.median(samples) if samples else 0.0


def _start(folder: Path, earlier: int) -> tuple[Path, str | None]:
    """A transcript that already holds `earlier` records."""
    path = folder / f"{SESSION}.jsonl"
    parent = None
    with path.open("w", encoding="utf-8") as stream:
        for turn in range(earlier):
            record = _record(turn, parent, "/tmp/bench")
            parent = record["uuid"]
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")
    return path, parent


def _replay(reader: Any, folder: Path, rounds: int, earlier: int) -> dict[str, float]:
    """Append a record, read usage and activity; per-call medians by method."""
    path, parent = _start(folder, earlier)
    checkpoint: dict = {}
    seen: set[str] = set()
    took: dict[str, list[float]] = {"parse_incremental": [], "parse_activity": []}
    if earlier:
        # The first read of a long transcript is its own cost, not a poll's.
        checkpoint = reader.parse_incremental(path, checkpoint).checkpoint
        reader.parse_activity(path, seen)
    for turn in range(earlier, earlier + rounds):
        record = _record(turn, parent, "/tmp/bench")
        parent = record["uuid"]
        with path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")
        micros, result = _timed(lambda: reader.parse_incremental(path, checkpoint))
        checkpoint = result.checkpoint
        took["parse_incremental"].append(micros)
        micros, _events = _timed(lambda: reader.parse_activity(path, seen))
        took["parse_activity"].append(micros)
    return {name: _median(samples) for name, samples in took.items()}


class _Bare:
    """The runtime on a process of its own, driven by the calling thread."""

    def __init__(self, exe: Path) -> None:
        self.proc = subprocess.Popen([str(exe), "serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    def ask(self, line: bytes) -> bytes:
        self.proc.stdin.write(line)
        self.proc.stdin.flush()
        return self.proc.stdout.readline()

    def close(self) -> None:
        self.proc.stdin.close()
        self.proc.wait(5)


def _breakdown(exe: Path, folder: Path, rounds: int, earlier: int) -> dict[str, float]:
    path, parent = _start(folder, earlier)
    bare = _Bare(exe)
    client = cli_runtime._Client(exe)
    ping = (json.dumps({"id": 0, "op": "ping"}) + "\n").encode()
    took: dict[str, list[float]] = {name: [] for name in ("encode", "pipe", "client", "read", "decode", "objects")}
    reader = cli_vendor("claude").make_log_reader()
    ask = cli_runtime._ask
    checkpoint: dict = {}
    if earlier:
        first = {"id": 0, "op": "usage", "vendor": "claude", "path": str(path), "checkpoint": {}}
        checkpoint = json.loads(bare.ask((json.dumps(first) + "\n").encode("utf-8")))["result"]["checkpoint"]
    for turn in range(earlier, earlier + rounds):
        record = _record(turn, parent, "/tmp/bench")
        parent = record["uuid"]
        with path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")
        request = {"id": turn + 1, "op": "usage", "vendor": "claude", "path": str(path), "checkpoint": checkpoint}
        micros, line = _timed(lambda: (json.dumps(request) + "\n").encode("utf-8"))
        took["encode"].append(micros)
        took["pipe"].append(_timed(lambda: bare.ask(ping))[0])
        took["client"].append(_timed(lambda: client.call("ping", 10.0))[0])
        micros, raw = _timed(lambda: bare.ask(line))
        took["read"].append(micros)
        micros, answer = _timed(lambda: json.loads(raw))
        took["decode"].append(micros)
        result = answer["result"]
        checkpoint = result["checkpoint"]
        # The seam's own conversion, with the asking replaced by this answer.
        cli_runtime._ask = lambda *_args, **_fields: (result, {"cwd": "nfc"})
        took["objects"].append(_timed(lambda: cli_runtime._usage(reader, None, path, {}))[0])
        cli_runtime._ask = ask
    bare.close()
    client.kill()
    client.close()
    medians = {name: _median(samples) for name, samples in took.items()}
    return {
        "encode": medians["encode"],
        "pipe": medians["pipe"],
        "threads": medians["client"] - medians["pipe"],
        "rust": medians["read"] - medians["pipe"],
        "decode": medians["decode"],
        "objects": medians["objects"],
    }


def main() -> int:
    rounds = int(sys.argv[1]) if len(sys.argv) > 1 else 2000
    earlier = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    exe = cli_runtime.binary()
    if exe is None:
        print("navide-cli-runtime is not built: cargo build --release in native/navide-cli-runtime", file=sys.stderr)
        return 2
    with tempfile.TemporaryDirectory(prefix="navide-bench-") as tmp:
        base = Path(tmp)
        python_dir, rust_dir, parts_dir = (base / name / "-tmp-bench" for name in ("python", "rust", "parts"))
        for folder in (python_dir, rust_dir, parts_dir):
            folder.mkdir(parents=True)
        python = _replay(cli_vendor("claude").make_log_reader(), python_dir, rounds, earlier)
        cli_runtime.apply(True)
        try:
            routed = _replay(cli_runtime.wrap(cli_vendor("claude").make_log_reader()), rust_dir, rounds, earlier)
            counts = cli_runtime.status()["calls"].get("claude", {})
        finally:
            cli_runtime.apply(False)
        parts = _breakdown(exe, parts_dir, rounds, earlier)
    print(f"rounds: {rounds} (one appended record, then one call of each method), after {earlier} earlier "
          "records; microseconds per call, median")
    print(f"{'call':20}{'python':>10}{'rust':>10}")
    for name in ("parse_incremental", "parse_activity"):
        print(f"{name:20}{python[name]:>10.1f}{routed[name]:>10.1f}")
    both = sum(python.values()) / 2, sum(routed.values()) / 2
    print(f"{'mean of the two':20}{both[0]:>10.1f}{both[1]:>10.1f}")
    print(f"answered by: {counts}")
    print("one routed usage call, taken apart:")
    for name, micros in parts.items():
        print(f"  {name:10}{micros:>8.1f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
