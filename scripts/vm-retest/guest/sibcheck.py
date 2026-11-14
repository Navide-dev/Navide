# sibcheck.py <root> <ws> <from> <to>: wk's role turn parks on a permission box (stub.log.wkrole), so the run fails.
# Pass = after the failure mgr gets no role prompt or kickoff, no router starts, and the log says "the run is no longer running".
import glob, json, os, re, subprocess, sys, time
root, ws, a, b = sys.argv[1:5]; os.chdir(root)
def y(*args):
    r = subprocess.run([sys.executable, "y.py", root, *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.stdout + r.stderr
def touch(n): open(os.path.join(root, n), "w").close()
for i in range(int(a), int(b) + 1):
    y("cardabort", ws); y("abort", ws); y("mcp", ws, "pipeline_reset"); y("dismiss", ws)
    touch("stub.log.wkrole"); touch("stub.log.notool")
    o = y("go", ws, "webhook", "hold", f"sib{i}"); time.sleep(60)
    n = (re.findall(r"Y[0-9a-f]{12}", o) or ["?"])[0]
    f = sorted(glob.glob(os.path.join(root, ws, ".agent-team", "runs", "*", "pipeline.log")))[-1]
    ev = [json.loads(l[l.find("{"):]) for l in open(f, encoding="utf-8", errors="replace")]
    lines = [(e.get("ts") or e.get("timestamp") or "", e.get("event"), (e.get("details") or {}).get("line", "")) for e in ev]
    fail_i = next((k for k, x in enumerate(lines) if x[1] == "pipeline_abort"), None)
    after = lines[fail_i + 1:] if fail_i is not None else []
    bad = [x[2][12:120] for x in after if re.search(r"injecting (kickoff|role)|role injected|kickoff sent|router started", x[2])]
    no_longer = [x[2][12:140] for x in lines if "no longer running" in x[2]]
    # stub side: any mgr request that carries this run's kickoff (ROLEMGR + nonce)
    mgr_kick = 0
    for l in open("stub.log", encoding="utf-8", errors="replace"):
        d = json.loads(l); t = json.dumps(d["messages"], ensure_ascii=False)
        if n in t and "ROLEMGR" in t: mgr_kick += 1
    reason = next((x[2][12:150] for x in lines if "pipeline failed" in x[2]), "")
    not_sub = [x[2][12:140] for x in lines if "not submitted" in x[2]]
    mgr_lines = [x[2][12:120] for x in after if "[m1/mgr]" in x[2] or "mgr" in x[2][:40]]
    mp = next((re.search(r"\[pane (\w{8})\] ➜ injecting role 'Backend", x[2]).group(1) for x in lines if re.search(r"\[pane (\w{8})\] ➜ injecting role 'Backend", x[2])), "")
    if mp:
        scr = y("screen", ws, mp, "6"); left = any(k in scr for k in ("ROLEMGR", "Pasted text", "NAVIDE-WEBHOOK-DATA"))
        print(f"  mgr pane {mp} screen tail:\n" + "\n".join("   " + l for l in scr.splitlines()[-6:]) + f"\n  kickoff-left-in-box={left}", flush=True)
    print(f"sib{i} {n} failed={'yes' if fail_i is not None else 'no'} reason=[{reason[:70]}] after-failure-injections={bad} "
          f"no-longer-running={no_longer[:2]} kickoff-not-submitted={not_sub[:2]} mgr-lines-after={mgr_lines[:3]} mgr-kickoff-requests={mgr_kick}", flush=True)
for n in ("stub.log.wkrole",):
    p = os.path.join(root, n)
    if os.path.exists(p): os.remove(p)
