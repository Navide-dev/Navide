"""Experiment only (exp/ci-hang-0243-*): loop the shard-3 window that stalled.

Runs pytest over scripts/exp-hang/nodes.txt with the Windows CI flags until
the time budget ends. A round whose log stops growing for STALL seconds gets
py-spy and cdb stacks of every python under it, is killed, and the loop goes
on, so one runner can count several stalls.

usage: python scripts/exp-hang/hangloop.py <minutes>
"""

import os
import subprocess
import sys
import time

import psutil

STALL = 120
OUT = os.path.join("test-results", "exp")
PY = os.path.join("backend", ".venv", "Scripts", "python.exe")


def say(text):
    line = time.strftime("%H:%M:%S ") + text
    print(line, flush=True)
    with open(os.path.join(OUT, "status.txt"), "a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def tree(pid):
    try:
        root = psutil.Process(pid)
        return [root] + root.children(recursive=True)
    except psutil.Error:
        return []


def dump(pid, tag):
    for p in tree(pid):
        try:
            if not p.name().lower().startswith("python"):
                continue
        except psutil.Error:
            continue
        tools = [("py-spy", [os.environ["NAVIDE_CI_PY_SPY"], "dump", "--pid", str(p.pid), "--native"], 120)]
        if os.environ.get("NAVIDE_CI_CDB"):
            tools.append(("cdb", [os.environ["NAVIDE_CI_CDB"], "-pv", "-p", str(p.pid), "-c",
                                  ".symfix+ C:\\cdb-symbols; .reload; ~*k 80; !locks; q"], 600))
        for name, argv, limit in tools:
            path = os.path.join(OUT, f"stall-{tag}-{name}-{p.pid}.txt")
            with open(path, "wb") as fh:
                try:
                    rc = subprocess.run(argv, stdout=fh, stderr=subprocess.STDOUT, timeout=limit).returncode
                except subprocess.TimeoutExpired:
                    rc = "timeout"
            say(f"{name} {p.pid} exit {rc} -> {path}")


def main():
    os.makedirs(OUT, exist_ok=True)
    deadline = time.monotonic() + float(sys.argv[1]) * 60
    stalls = rounds = 0
    while time.monotonic() < deadline:
        rounds += 1
        log_path = os.path.join(OUT, f"round-{rounds}.log")
        args = [PY, "-X", "faulthandler", "-m", "pytest", "@scripts/exp-hang/nodes.txt", "-v",
                "-p", "no:cacheprovider", "--timeout=90", "--timeout-method=thread",
                "-o", "faulthandler_timeout=120"]
        with open(log_path, "wb") as log:
            child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
        size, since = -1, time.monotonic()
        while child.poll() is None:
            time.sleep(5)
            now_size = os.path.getsize(log_path)
            if now_size != size:
                size, since = now_size, time.monotonic()
            elif size > 0 and time.monotonic() - since > STALL:
                stalls += 1
                with open(log_path, encoding="utf-8", errors="replace") as fh:
                    last = fh.read().strip().splitlines()[-1:]
                say(f"round {rounds} STALLED after {last}")
                dump(child.pid, rounds)
                for p in reversed(tree(child.pid)):
                    try:
                        p.kill()
                    except psutil.Error:
                        pass
                break
        else:
            with open(log_path, encoding="utf-8", errors="replace") as fh:
                tail = fh.read().strip().splitlines()[-1:]
            say(f"round {rounds} exit {child.returncode}: {tail}")
            os.remove(log_path)
    say(f"SUMMARY rounds={rounds} stalls={stalls}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
