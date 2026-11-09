# gitphase.py <root> <secs per phase>: with GIT_TRACE2_EVENT set for the app, the home workspace open (and the sidebar
# Git tab, Explorer + hwrepo1 shown): quiet, noise (AppData\Local + a dot-file in ~ every second), repo writes (one repo
# file every 15 s); prints the trace file's line count and time at each boundary.
import json, os, pathlib, sys, time
ROOTP = sys.argv[1]; S = int(sys.argv[2]) if len(sys.argv) > 2 else 120; sys.argv = [sys.argv[0], ROOTP, "status"]
exec(open(ROOTP + "/newtests.py", encoding="utf-8").read().split('\nif phase == "setup":')[0])
HOME = pathlib.Path.home(); TR = pathlib.Path(ROOTP) / "git-trace2.jsonl"
def mark(n): c = sum(1 for _ in open(TR, encoding="utf-8", errors="replace")); print(time.strftime("%H:%M:%S"), "MARK", n, "lines", c, "utc", time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()), flush=True)
print("workspace_open", json.dumps(ext("workspace_open", {"path": str(HOME)}))[:120]); time.sleep(6)
c = Cdp(main_page(str(HOME)))
for tab in ("git", "explorer"):
    print("sidebar", tab, c.ev(f"(()=>{{const b=document.querySelector('.sidebar-tabs .tab-btn[data-tab=\"{tab}\"]'); if(!b) return 'no-tab'; b.click(); return 'clicked';}})()")); time.sleep(3)
time.sleep(10)
na = HOME / "AppData" / "Local" / "hwnoise" / "n.txt"; na.parent.mkdir(parents=True, exist_ok=True); nb = HOME / ".hwnoise_history"
repos = [HOME / f"hwrepo{i}" for i in range(1, 5)]
mark("start-quiet"); time.sleep(S)
mark("start-noise"); t0 = time.time(); n = 0
while time.time() - t0 < S:
    na.write_text(str(n)); open(nb, "a").write(f"{n}\n"); n += 1; time.sleep(1)
mark("start-repo"); t0 = time.time(); n = 0
while time.time() - t0 < S:
    (repos[n % 4] / "work.txt").write_text(f"{n} {time.time()}\n"); n += 1; time.sleep(15)
mark("end")
