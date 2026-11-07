# rec.py <root> <ws> <outdir> <secs> <flags,comma|-> <y.py args...>: run one y.py command (e.g. go/goinj) and record it.
#   flags: stub.log.<flag> files touched before and removed after (e.g. wkrole,notool)
#   cpu.tsv: guest total CPU % every 0.5 s (GetSystemTimes)
# Records, with host-side epoch timestamps:
#   cdp.jsonl  every CDP event of the window: WS frames to/from the backend (terminal.input incl. Enter, output, hook/turn events),
#              renderer console calls
#   shot-<t>.png  window screenshot about once a second
#   sizes.tsv  byte size of each new run file (pipeline.log, stage-*.log raw PTY capture) and of stub.log / backend.log as they grow
#   files/     the run dir, plus the new tails of stub.log and backend.log
import sys, threading, glob, base64, shutil
ROOTP, name, out, secs, flags = sys.argv[1:6]; secs = int(secs); CMD = sys.argv[6:]; flags = [] if flags == '-' else flags.split(','); noreset = 'noreset' in flags; flags = [f for f in flags if f != 'noreset']
sys.argv = ["d", ROOTP, "x"]
exec(open(ROOTP + "/drv.py").read().split("PH = {")[0])
os.makedirs(os.path.join(out, "files"), exist_ok=True)
wsp = str(ROOT / name)
def y(*a):
    r = subprocess.run([sys.executable, "y.py", ROOTP, *a], capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.stdout + r.stderr
for a in (() if noreset else (("cardabort", name), ("abort", name), ("mcp", name, "pipeline_reset"), ("dismiss", name))): y(*a)
for fl in flags: open(str(ROOT / ("stub.log." + fl)), "w").close()
import ctypes
class FT(ctypes.Structure): _fields_ = [("lo", ctypes.c_uint32), ("hi", ctypes.c_uint32)]
def st():  # (idle, kernel incl. idle, user) like GetSystemTimes
    if os.name != "nt":
        f = [int(x) for x in open("/proc/stat").readline().split()[1:]]; idle = f[3] + f[4]; tot = sum(f)
        return idle, tot, 0
    i, k, u = FT(), FT(), FT(); ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(i), ctypes.byref(k), ctypes.byref(u))
    v = lambda f: (f.hi << 32) | f.lo
    return v(i), v(k), v(u)
c = Cdp(main_page(wsp)); c.ws.s.settimeout(None)
ev = open(os.path.join(out, "cdp.jsonl"), "w", encoding="utf-8"); shots = {}
def rx():
    while True:
        try: m = c.ws.recv()
        except Exception: break
        t = time.time()
        try: d = json.loads(m)
        except Exception: continue
        tag = shots.pop(d.get("id"), None) if d.get("id") is not None else None
        if tag:
            open(os.path.join(out, f"shot-{tag}.png"), "wb").write(base64.b64decode(d.get("result", {}).get("data", "")))
            continue
        ev.write(json.dumps({"t": round(t, 3), "m": d}, ensure_ascii=False) + "\n")
threading.Thread(target=rx, daemon=True).start()
def send(method, tag=None, **p):
    c.n += 1
    if tag: shots[c.n] = tag
    c.ws.send(json.dumps({"id": c.n, "method": method, "params": p}))
send("Network.enable"); send("Runtime.enable")
stub = str(ROOT / "stub.log"); bl = os.path.join(os.environ["APPDATA"], "Agent-Team", "logs", "backend.log") if os.name == "nt" else os.path.expanduser("~/.local/share/Agent-Team/logs/backend.log")
s0, b0 = os.path.getsize(stub), os.path.getsize(bl)
runs0 = set(glob.glob(os.path.join(wsp, ".agent-team", "runs", "*")))
t0 = time.time(); print("start", round(t0, 3), flush=True)
subprocess.Popen([sys.executable, *CMD] if CMD[0].endswith(".py") else [sys.executable, "y.py", ROOTP, *CMD],
                 stdout=open(os.path.join(out, "go.out"), "w"), stderr=subprocess.STDOUT)
sizes = open(os.path.join(out, "sizes.tsv"), "w"); last = {}; lastshot = 0
cpu = open(os.path.join(out, "cpu.tsv"), "w"); prev = st(); lastcpu = time.time()
while time.time() - t0 < secs:
    now = time.time()
    files = [f for d in glob.glob(os.path.join(wsp, ".agent-team", "runs", "*")) if d not in runs0 for f in glob.glob(os.path.join(d, "*.log"))]
    for f in files + [stub, bl]:
        try: sz = os.path.getsize(f)
        except OSError: continue
        if last.get(f) != sz: last[f] = sz; sizes.write(f"{now:.3f}\t{os.path.basename(f)}\t{sz}\n")
    if now - lastshot >= 1.0: lastshot = now; send("Page.captureScreenshot", tag=f"{now:.3f}", format="png")
    if now - lastcpu >= 0.5:
        cur = st(); di, dk, du = (cur[j] - prev[j] for j in range(3)); prev = cur; lastcpu = now
        cpu.write(f"{now:.3f}\t{100 * (dk + du - di) / max(1, dk + du):.0f}\n"); cpu.flush()
    sizes.flush(); time.sleep(0.2)
time.sleep(2)
for d in glob.glob(os.path.join(wsp, ".agent-team", "runs", "*")):
    if d not in runs0: shutil.copytree(d, os.path.join(out, "files", os.path.basename(d)), dirs_exist_ok=True)
for src, off, dst in ((stub, s0, "stub-new.jsonl"), (bl, b0, "backend-new.log")):
    with open(src, "rb") as f: f.seek(off); open(os.path.join(out, "files", dst), "wb").write(f.read())
open(os.path.join(out, "files", "diagnostics.json"), "w", encoding="utf-8").write(y("mcp", name, "ui_diagnostics"))
for fl in flags:
    if fl != "notool" and os.path.exists(str(ROOT / ("stub.log." + fl))): os.remove(str(ROOT / ("stub.log." + fl)))
print("done", round(time.time(), 3), "shots", len(glob.glob(os.path.join(out, "shot-*.png"))), flush=True)
