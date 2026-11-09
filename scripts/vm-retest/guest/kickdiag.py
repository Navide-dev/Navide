# kickdiag.py <root>: one external cli_open_agent with a task into "wn" and what surrounds its failure: ui_diagnostics
# before/after, every backend.log line of the new terminal session, and the errors.jsonl lines written meanwhile.
import json, os, re, sys, time
ROOTP = sys.argv[1]; sys.argv = [sys.argv[0], ROOTP, "kick"]
exec(open(ROOTP + "/n238.py", encoding="utf-8").read().split('\nif phase == "stopagent":')[0])
OUT = os.path.join(ROOTP, "kickdiag"); os.makedirs(OUT, exist_ok=True)
L = os.path.join(os.environ["APPDATA"], "agent-team", "logs"); BL = os.path.join(L, "backend.log"); EJ = os.path.join(L, "errors.jsonl")
def save(n, o): open(os.path.join(OUT, n), "w", encoding="utf-8").write(o if isinstance(o, str) else json.dumps(o, ensure_ascii=False, indent=1))
save("diag-before.json", ext("ui_diagnostics", {"workspace_path": ws}))
boff = os.path.getsize(BL); eoff = os.path.getsize(EJ); nm = "kd-" + _s.token_hex(2); t0 = time.time()
say("open start", nm)
r = ext("cli_open_agent", {"agent": "claude", "name": nm, "task": "KICKDIAG reply with the word ready.", "workspace_path": ws})
say(f"answer +{round(time.time()-t0,1)}s", json.dumps({k: r.get(k) for k in r if k != "instructions"}, ensure_ascii=False)[:300])
time.sleep(3)
save("diag-after.json", ext("ui_diagnostics", {"workspace_path": ws}))
new = open(BL, "rb").read()[boff:].decode("utf-8", "replace")
m = re.search(r"terminal session created id=([0-9a-f-]+) pane=([0-9a-f-]+)", new)
sid, pid = (m.group(1), m.group(2)) if m else ("?", "?")
lines = [l for l in new.splitlines() if sid in l or pid in l or pid[:8] in l or re.search(r"reattach|claim|owner|ws client", l)]
save("backend-session.txt", f"session {sid} pane {pid}\n" + "\n".join(lines)); save("backend-all.txt", new)
save("errors.jsonl.txt", open(EJ, "rb").read()[eoff:].decode("utf-8", "replace"))
def ownerless(d):
    s = json.dumps(d); m = re.findall(r'"ownerless"\s*:\s*(\d+)', s); return m
say("session", sid, "pane", pid, "backend lines", len(lines))
say("ownerless before", ownerless(json.load(open(os.path.join(OUT, "diag-before.json"), encoding="utf-8"))), "after", ownerless(json.load(open(os.path.join(OUT, "diag-after.json"), encoding="utf-8"))))
