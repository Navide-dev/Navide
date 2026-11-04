# wfull.py <root> pre|post: the full re-test (Linux and Windows guests), in two halves around a real restart.
#   pre : driver items, 0 s stub, Manager loops, marker variants, sibling failure x13, ConPTY Ctrl-U,
#         C (permission box), A/D in the duplicate window, restart-from echo; ends with a held run for the restart
#   post: Resume the held run, then A x6, E (card / MCP) and D in the normal window
import glob, json, os, subprocess, sys, time
root, half = sys.argv[1:3]; os.chdir(root)
PY = sys.executable
def run(*a):
    r = subprocess.run([PY, *a], capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.stdout + r.stderr
def y(*a): return run("y.py", root, *a)
def touch(n): open(os.path.join(root, n), "w").close()
def rm(n):
    p = os.path.join(root, n)
    if os.path.exists(p): os.remove(p)
def pick(out, *keys): return "\n".join(l for l in out.splitlines() if any(k in l for k in keys) and not l.startswith("fails"))
def say(*a): print(*a, flush=True)
def lastpane(ws):
    f = sorted(glob.glob(os.path.join(root, ws, ".agent-team", "runs", "*", "pipeline.log")))[-1]; p = ""
    for l in open(f, encoding="utf-8", errors="replace"):
        d = json.loads(l[l.find("{"):])
        if d.get("event") == "stage_spawn": p = str(d.get("pane_id"))[:8]
    return p
def reset(ws):
    y("cardabort", ws); y("abort", ws); y("mcp", ws, "pipeline_reset"); y("dismiss", ws)
def ran(ws): return os.path.exists(os.path.join(root, ws, "RAN.txt"))

if half == "pre":
    say("=== DRIVER")
    for p in ("defaults", "setup", "bearer", "github", "form", "codex", "reset", "keystore", "cmdline"): run("drv.py", root, p)
    r = [json.loads(l) for l in open("results.jsonl", encoding="utf-8-sig")]
    say(len(r), sum(x["pass"] for x in r)); [say(" FAIL", x["item"]) for x in r if not x["pass"]]
    say("=== 0s"); touch("stub.log.instant"); y("adopt", "sw"); y("setup", "sw")
    for n in ("run1-0s", "run2-0s"): say(pick(y("go", "sw", "webhook", "done", n), "FAIL", "ends"))
    y("abort", "wa"); y("mcp", "wa", "pipeline_reset")
    for n in ("l2-0s", "l2-0s-second"): say(pick(y("go", "wa", "webhook", "done", n), "FAIL", "ends"))
    rm("stub.log.instant")
    say("=== CTRLU (recorded; screens are replayed on the host)")
    say(run("rec.py", root, "sw", os.path.join(root, "final-ctrlu"), "150", "noreset", "ctrlseq.py", root, "sw")[-300:])
    say(open(os.path.join(root, "final-ctrlu", "go.out"), encoding="utf-8", errors="replace").read()[-1500:])
    say(y("setupm", "wm", "backend")[-200:])
    for mode, a, b in (("m", "1", "10"), ("ask", "1", "3"), ("inj", "1", "3"), ("dup", "1", "3"), ("rep", "1", "3")): say(f"=== {mode}"); say(pick(run("winloops.py", root, mode, a, b), "inject=", "ASK->", " end=", "fake-", "nonce", "resize", "restored", "Traceback"))
    say("=== E1 slow stop hook x3 (test-only user-level Stop hook, 20 s while stub.log.slowstop exists)")
    say(run("slowhook.py", root, "add")); touch("stub.log.slowstop")
    say(pick(run("winloops.py", root, "m", "11", "13"), "inject=", " end=", "fake-", "Traceback"))
    rm("stub.log.slowstop"); say(run("slowhook.py", root, "remove"))
    say("=== C prompt"); reset("wm"); rm("wm/RAN.txt"); rm("stub.log.notool")
    open("mc.txt", "w").write(str(sum(1 for _ in open("stub.log", encoding="utf-8", errors="replace"))))
    y("go", "wm", "webhook", "hold", "cp"); time.sleep(40); say("RAN-before-answer:", ran("wm"))
    lg = run("lg.py", "wm"); say(pick(lg, "READY", "held", "→ Manager"))
    import re
    mp = (re.findall(r"held for pane ([0-9a-f]{8})", lg) or [""])[0]; say("mgr pane", mp)
    if mp: y("key", "wm", mp, "Enter")
    time.sleep(50); say("RAN-after-answer:", ran("wm"))
    say(pick(run("lg.py", "wm"), "→ Manager", "STAGE-DONE", "completed")); say(run("mgrcount.py", "mc.txt")[-300:])
    say(y("wruns", "x").strip().splitlines()[-1]); y("dismiss", "wm")
    say("=== INJVAR"); say(run("injvar.py", root, "wm")); rm("stub.log.notool"); y("dismiss", "wm")
    say(y("setupm", "wx", "backend", "frontend")[-200:])
    say("=== SIB normal"); say(run("sibcheck.py", root, "wx", "1", "5"))
    say("=== SIB wkfast"); touch("stub.log.wkfast"); say(run("sibcheck.py", root, "wx", "6", "10"))
    say("=== SIB wkfast+instant (same second)"); touch("stub.log.instant"); say(run("sibcheck.py", root, "wx", "11", "15"))
    rm("stub.log.wkfast"); rm("stub.log.instant"); reset("wx")
    say("=== A dup"); rm("stub.log.notool"); say(y("setup3", "wd")[-200:])
    o = run("aloop.py", root, "wd", "1", "6"); open("aloopw-wd.out", "w", encoding="utf-8").write(o)
    say(pick(o, "=== ", "RAN-after", "STATUS", "CARD", "completed all", "BYPASS"))
    say("=== D dup")
    for i in (1, 2):
        reset("wd"); rm("stub.log.notool"); rm("wd/RAN.txt")
        say(pick(y("go", "wd", "webhook", "hold", f"d{i}"), "ends")); say(pick(y("mcp", "wd", "pipeline_abort"), "ok"))
        time.sleep(6); say(y("pstat", "wd").strip()); time.sleep(5); say(y("wruns", "x").strip().splitlines()[-1])
        say(pick(y("go", "wd", "webhook", "done", f"d{i}-next"), "PASS", "FAIL")); say("RAN:", ran("wd"))
    say("=== restart-from echo"); reset("wd"); rm("stub.log.notool"); rm("wd/RAN.txt")
    say(pick(y("go", "wd", "webhook", "hold", "rf"), "ends")); y("reload", "wd", "25")
    say(y("mcp", "wd", "pipeline_restart_from", '{"node_id":"n8n-check"}')[:300]); time.sleep(45)
    say(run("tl.py", "wd")[-600:]); say(y("launches", "x", "2")); say(y("cards", "wd")); say("RAN:", ran("wd")); say(y("pstat", "wd"))
    say("=== DIAG lines (all runs so far)"); say(run("diagcount.py", root))
    say("=== hold for restart")
    for w in ("wm", "wd", "wa", "wx"): y("abort", w); y("mcp", w, "pipeline_reset")
    rm("stub.log.notool"); rm("wa/RAN.txt"); say(pick(y("go", "wa", "webhook", "hold", "rs-hold"), "ends"))
else:
    say("=== restart"); say(y("pstat", "wa")); say(y("ptext", "wa")[:200]); say(y("launches", "x", "3")); say(y("cards", "wa"))
    say(pick(y("resume", "wa"), "state")); time.sleep(40); say("RAN:", ran("wa")); say(y("launches", "x", "2")); say(y("pstat", "wa"))
    say("=== A normal"); o = run("aloop.py", root, "wa", "1", "6"); open("aloopw-wa.out", "w", encoding="utf-8").write(o)
    say(pick(o, "=== ", "RAN-after", "STATUS", "CARD", "completed all", "BYPASS"))
    for how in ("card", "mcp"):
        say(f"=== E {how}"); y("abort", "wa"); y("mcp", "wa", "pipeline_reset"); rm("stub.log.notool"); rm("wa/RAN.txt")
        say(pick(y("go", "wa", "webhook", "hold", f"e-{how}"), "ends")); y("reload", "wa", "20"); say(y("pstat", "wa")); say(y("ptext", "wa")[:200])
        say(y("cardabort", "wa") if how == "card" else pick(y("mcp", "wa", "pipeline_abort"), "ok"))
        time.sleep(10); say(y("pstat", "wa")); say(y("ptext", "wa")[:200]); say("row:", y("wruns", "x").strip().splitlines()[-1])
        say(pick(y("go", "wa", "webhook", "done", f"e-{how}-next"), "FAIL", "ends")); time.sleep(8); say("rows:", " | ".join(y("wruns", "x").strip().splitlines()[-2:]))
    say("=== D normal"); rm("stub.log.notool"); say(pick(y("go", "wa", "webhook", "hold", "dn"), "ends")); say(pick(y("mcp", "wa", "pipeline_abort"), "ok"))
    time.sleep(8); say(y("pstat", "wa")); say(pick(y("go", "wa", "webhook", "done", "dn-next"), "FAIL", "ends")); time.sleep(8)
    say("\n".join(y("wruns", "x").strip().splitlines()[-2:]))
    say("=== DIAG lines (all runs)"); say(run("diagcount.py", root))
