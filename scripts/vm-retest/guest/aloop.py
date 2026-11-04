# aloop.py <root> <ws> <from> <to> [prewait]: hold run -> Reload -> wait -> Resume (must not type);
# answer Yes in the pane -> Resume -> must complete. Same steps as aloop.sh, for the Windows guest.
import glob, json, os, re, subprocess, sys, time
root, ws, a, b = sys.argv[1:5]; pre = int(sys.argv[5]) if len(sys.argv) > 5 else 30
os.chdir(root)
def y(*args):
    r = subprocess.run([sys.executable, "y.py", root, *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.stdout + r.stderr
def show(out, pat):
    for l in out.splitlines():
        if re.search(pat, l): print("  " + l[:170], flush=True)
def log():
    f = sorted(glob.glob(os.path.join(root, ws, ".agent-team", "runs", "*", "pipeline.log")))[-1]; ev = []
    for l in open(f, encoding="utf-8", errors="replace"):
        try: ev.append(json.loads(l[l.find("{"):]))
        except ValueError: pass
    return ev
def lastpane():
    p = ""
    for e in log():
        if e.get("event") == "stage_spawn": p = str(e.get("pane_id"))[:8]
    return p
ran = os.path.join(root, ws, "RAN.txt"); notool = os.path.join(root, "stub.log.notool")
for i in range(int(a), int(b) + 1):
    print(f"=== {ws} try {i} {time.strftime('%H:%M:%S')}", flush=True)
    y("abort", ws); y("mcp", ws, "pipeline_reset")
    for f in (ran, notool):
        if os.path.exists(f): os.remove(f)
    show(y("go", ws, "webhook", "hold", f"t{i}"), r"ends")
    y("reload", ws, "25"); show(y("cards", ws), r"CARD"); show(y("launches", "x", "1"), r"default|BYPASS")
    time.sleep(pre); show(y("resume", ws), r"error|state")
    time.sleep(15); print("  RAN-after-resume:", "PRESENT " + time.strftime("%H:%M:%S", time.localtime(os.path.getmtime(ran))) if os.path.exists(ran) else "none", flush=True)
    show(y("pstat", ws), r"STATUS"); show(y("ptext", ws), r"PANEL")
    p = lastpane(); open(notool, "w").close(); show(y("key", ws, p, "Enter"), r"focus|sent"); time.sleep(12)
    print("  RAN-after-answer:", time.strftime("%H:%M:%S", time.localtime(os.path.getmtime(ran))) if os.path.exists(ran) else "none", flush=True)
    show(y("resume", ws), r"state"); time.sleep(40)
    show(y("pstat", ws), r"STATUS"); show(y("ptext", ws), r"PANEL")
    for e in log():
        t = (e.get("details") or {}).get("line", "")
        if any(k in t for k in ("CLI prompt", "turn_complete reported", "completed all", "pipeline failed", "Resuming")): print("    " + t[12:150], flush=True)
