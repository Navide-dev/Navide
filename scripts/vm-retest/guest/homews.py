# homews.py <root> [minutes]: the home folder as a workspace, with 4 repositories under it, for <minutes> (default 10).
# Counts every git process the backend starts and what it was asked to do:
#   Linux:   strace -f -e trace=execve attached to the backend (sudo -n; the guest has ptrace_scope 1)
#   Windows: Win32_ProcessStartTrace events for git.exe (WMI, no audit policy change), plus Get-Process git sampled
#            every second and '\Memory\Pool Paged Bytes' at the start and the end
# workspace_close needs a pane caller, so the home workspace is left open: run this as the round's last item.
# Phases (minutes split 1 : 4.5 : 4.5): quiet baseline; noise (a file under ~/.cache and ~/.zsh_history on Linux,
# under AppData\Local and a dot-file in ~ on Windows, written every second); repo writes (one file in one repo every
# 15 s, rotating). Expected: no git during quiet and noise, at most 8 `git status` per repo write (4 repos x 2),
# no `rev-parse`;
# Windows paged pool grows < 20 MB.
import json, os, pathlib, re, shutil, subprocess, sys, time
ROOTP = sys.argv[1]; MIN = float(sys.argv[2]) if len(sys.argv) > 2 else 10.0
sys.argv = [sys.argv[0], ROOTP, "status"]
_src = open(ROOTP + "/newtests.py", encoding="utf-8").read().split('\nif phase == "setup":')[0]
exec(_src)
WIN = os.name == "nt"; HOME = pathlib.Path.home(); OUT = pathlib.Path(ROOTP) / "homews"; OUT.mkdir(exist_ok=True)
def now(): return time.strftime("%H:%M:%S")
def git(*a, cwd): subprocess.run(["git", *a], cwd=cwd, check=True, capture_output=True)
repos = [HOME / f"hwrepo{i}" for i in range(1, 5)]
for r in repos:
    if not (r / ".git").exists():
        r.mkdir(exist_ok=True); git("init", "-q", "-b", "main", cwd=r)
        (r / "README.md").write_text("homews\n"); git("add", ".", cwd=r)
        git("-c", "user.name=homews", "-c", "user.email=homews@example.invalid", "commit", "-qm", "init", cwd=r)
print(now(), "repos", [str(r) for r in repos])

# start counting
if WIN:
    ps = OUT / "trace.ps1"; log = OUT / "starts.txt"; samp = OUT / "samples.txt"
    ps.write_text(f"""
Register-CimIndicationEvent -ClassName Win32_ProcessStartTrace -SourceIdentifier hw -Action {{
  if ($Event.SourceEventArgs.NewEvent.ProcessName -ieq 'git.exe') {{
    $p = $Event.SourceEventArgs.NewEvent.ProcessID
    $c = (Get-CimInstance Win32_Process -Filter "ProcessId=$p" -EA 0).CommandLine
    Add-Content '{log}' ((Get-Date -Format 'HH:mm:ss.fff') + ' ' + $p + ' ' + $c) }} }} | Out-Null
while ($true) {{ Add-Content '{samp}' ((Get-Date -Format 'HH:mm:ss') + ' ' + @(Get-Process git -EA 0).Count); Start-Sleep 1 }}
""", encoding="utf-8")
    for f in (log, samp): f.write_text("")
    tracer = subprocess.Popen(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ps)])
    def pool(): return float(subprocess.run(["powershell", "-NoProfile", "-Command",
        "(Get-Counter '\\Memory\\Pool Paged Bytes').CounterSamples.CookedValue"], capture_output=True, text=True).stdout.strip() or 0)
    pool0 = pool(); print(now(), "paged pool start MB", round(pool0 / 1e6, 1))
else:
    def comm(p):
        try: return pathlib.Path(f"/proc/{p}/comm").read_text().strip()
        except OSError: return ""
    cands = subprocess.run(["pgrep", "-u", str(os.getuid()), "-f", "agent_team_backend"], capture_output=True, text=True).stdout.split()
    # the packaged backend is a launcher plus the real process: attach to every one of them (-f only follows children
    # forked after the attach)
    bpid = sorted((p for p in cands if comm(p) not in ("bash", "sh", "pgrep", "sudo", "strace") and int(p) != os.getpid()), key=int)
    print(now(), "backend candidates", [(p, comm(p)) for p in cands])
    log = OUT / "strace.txt"
    tracer = subprocess.Popen(["sudo", "-n", "strace", "-f", "-qq", "-tt", "-e", "trace=execve", "-e", "signal=none",
                               "-s", "200", "-o", str(log), *[a for p in bpid for a in ("-p", p)]])
    print(now(), "strace on backend pids", bpid, "strace pid", tracer.pid)
time.sleep(3)

r = ext("workspace_open", {"path": str(HOME)}); print(now(), "workspace_open", json.dumps(r, ensure_ascii=False)[:300])
# What fans git out in a home-folder workspace is the main window's own UI, not the Git window: the sidebar Git tab
# (discover + a status per repo), the Explorer tab with a repo expanded (git badges) and a pane's status-bar branch.
# Show all three before measuring.
time.sleep(8); page = main_page(str(HOME))
if page is None: print(now(), "no CDP page for", HOME)
else:
    c = Cdp(page)
    for tab in ("git", "explorer"):
        print(now(), "sidebar", tab, c.ev(f"""(async()=>{{const b=document.querySelector('.sidebar-tabs .tab-btn[data-tab="{tab}"]');
          if(!b) return 'no-tab'; b.click(); await new Promise(f=>setTimeout(f,3000)); return 'clicked';}})()"""))
    print(now(), "expand hwrepo1", c.ev("""(async()=>{const el=[...document.querySelectorAll('*')].find(e=>e.children.length<=3
      && e.textContent.trim()==='hwrepo1' && e.offsetParent); if(!el) return 'not-found'; el.click();
      await new Promise(f=>setTimeout(f,2000)); return 'clicked '+el.tagName+'.'+el.className;})()"""))
r = ext("cli_open_agent", {"agent": "terminal", "name": "hwterm", "task": "", "workspace_path": str(HOME)})
print(now(), "terminal pane", json.dumps(r, ensure_ascii=False)[:200]); time.sleep(5)
r = ext("cli_send", {"to": f"{HOME.name}/hwterm", "text": f"cd {repos[0]}"})  # status-bar branch for hwrepo1
print(now(), "terminal cd", json.dumps(r, ensure_ascii=False)[:200]); time.sleep(5)
marks = []
def phase(name, secs, step):
    t0 = time.time(); marks.append((name, now())); print(now(), "phase", name); n = 0
    while time.time() - t0 < secs: step(n); n += 1; time.sleep(1 if name != "repo" else 15)
noise_a = (HOME / "AppData" / "Local" / "hwnoise" / "n.txt") if WIN else (HOME / ".cache" / "hwnoise" / "n.txt")
noise_b = (HOME / ".hwnoise_history") if WIN else (HOME / ".zsh_history")
noise_a.parent.mkdir(parents=True, exist_ok=True)
def quiet(n): pass
def noise(n):
    noise_a.write_text(str(n))
    with open(noise_b, "a", encoding="utf-8") as f: f.write(f": {int(time.time())}:0;echo hw {n}\n")
repo_events = []
def repo(n):
    r = repos[n % len(repos)]; (r / "work.txt").write_text(f"{n} {time.time()}\n"); repo_events.append((now(), r.name))
phase("quiet", MIN * 60 * 0.1, quiet); phase("noise", MIN * 60 * 0.45, noise); phase("repo", MIN * 60 * 0.45, repo)
marks.append(("end", now())); time.sleep(5)
r = ext("workspace_close", {"path": str(HOME)}); print(now(), "workspace_close", json.dumps(r, ensure_ascii=False)[:200])

# stop counting
if WIN:
    pool1 = pool(); subprocess.run(["taskkill", "/PID", str(tracer.pid), "/T", "/F"], capture_output=True)
    lines = [l for l in log.read_text(encoding="utf-8", errors="replace").splitlines() if l.strip()]
    starts = [(l[:8], l) for l in lines]
    print(now(), "paged pool end MB", round(pool1 / 1e6, 1), "growth MB", round((pool1 - pool0) / 1e6, 1))
    print("max concurrent git (1 s samples)", max([int(x.split()[-1]) for x in samp.read_text().splitlines() if x.strip()] or [0]))
else:
    subprocess.run(["sudo", "-n", "kill", "-INT", str(tracer.pid)]); time.sleep(2)
    lines = [l for l in log.read_text(errors="replace").splitlines() if "execve(" in l and "/git\"" in l and l.rstrip().endswith("= 0")]  # PATH lookups fail first
    starts = []
    for l in lines:
        m = re.match(r"\d+\s+(\d\d:\d\d:\d\d)", l); starts.append((m.group(1) if m else "?", l))
def in_phase(t, a, b): return a <= t < b
bounds = {marks[i][0]: (marks[i][1], marks[i + 1][1]) for i in range(len(marks) - 1)}
for name, (a, b) in bounds.items():
    sel = [l for t, l in starts if in_phase(t, a, b)]
    st = sum(1 for l in sel if "status" in l); rp = sum(1 for l in sel if "rev-parse" in l)
    print(f"RESULT homews {name} {a}-{b}: git {len(sel)} (status {st}, rev-parse {rp})")
ra, rb = bounds["repo"]; sel = [(t, l) for t, l in starts if in_phase(t, ra, rb)]
per = []
for i, (t, nm) in enumerate(repo_events):
    t2 = repo_events[i + 1][0] if i + 1 < len(repo_events) else rb
    per.append(sum(1 for tt, l in sel if t <= tt < t2 and "status" in l))
print("RESULT homews per repo write: status counts", per, "max", max(per or [0]), "writes", len(per))
print("RESULT homews rev-parse total", sum(1 for t, l in starts if "rev-parse" in l))
for t, l in starts[:15]: print("  sample", l[:220])
nq = sum(1 for t, l in starts if in_phase(t, *bounds["quiet"])); nn = sum(1 for t, l in starts if in_phase(t, *bounds["noise"]))
rp_repo = sum(1 for t, l in sel if "rev-parse" in l)
print("RESULT homews verdict quiet git=0:", "PASS" if nq == 0 else f"FAIL ({nq})")
print("RESULT homews verdict noise git=0:", "PASS" if nn == 0 else f"FAIL ({nn})")
print("RESULT homews verdict repo status<=8 per write:", "PASS" if max(per or [0]) <= 8 else f"FAIL (max {max(per)})")
print("RESULT homews verdict repo rev-parse=0:", "PASS" if rp_repo == 0 else f"FAIL ({rp_repo})")
if WIN: print("RESULT homews verdict paged pool <20MB:", "PASS" if (pool1 - pool0) < 20e6 else f"FAIL ({round((pool1 - pool0) / 1e6, 1)} MB)")
