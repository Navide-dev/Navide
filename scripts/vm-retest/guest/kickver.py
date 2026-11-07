# kickver.py <root> [n]: external cli_open_agent with a task, n times into "wn" and n times into a fresh workspace "wv".
# Pass: kickoff=sent within 45 s and the pane still alive 20 s later. Prints new errors.jsonl inject lines.
import json, os, sys, time
ROOTP = sys.argv[1]; N = int(sys.argv[2]) if len(sys.argv) > 2 else 3; sys.argv = [sys.argv[0], ROOTP, "kick"]
exec(open(ROOTP + "/n238.py", encoding="utf-8").read().split('\nif phase == "stopagent":')[0])
EJ = os.path.join(os.environ["APPDATA"], "agent-team", "logs", "errors.jsonl"); eoff = os.path.getsize(EJ) if os.path.exists(EJ) else 0
wv = os.path.join(ROOTP, os.environ.get("NEWWS", "wv")); os.makedirs(wv, exist_ok=True)
say("workspace_open wv", json.dumps(ext("workspace_open", {"path": wv}))[:150]); time.sleep(8)
ok = 0
for target in (ws, wv):
    for i in range(1, N + 1):
        nm = f"kv{i}-" + _s.token_hex(2); t0 = time.time()
        r = ext("cli_open_agent", {"agent": "claude", "name": nm, "task": f"KICKVER {i} reply with the word ready.", "workspace_path": target})
        dt = round(time.time() - t0, 1); time.sleep(20)
        st_ = ext("cli_get_status", {"target": f"{os.path.basename(target)}/{nm}", "workspace_path": target})
        alive = bool(st_.get("ok")); good = r.get("kickoff") == "sent" and dt <= 45 and alive; ok += good
        say(f"RESULT kickver {os.path.basename(target)} #{i} +{dt}s kickoff={r.get('kickoff')} ok={r.get('ok')} alive20s={alive} {'PASS' if good else 'FAIL'}",
            "" if r.get("ok") else json.dumps(r, ensure_ascii=False)[:200])
say(f"RESULT kickver total {ok}/{2 * N}")
if os.path.exists(EJ):
    for l in open(EJ, "rb").read()[eoff:].decode("utf-8", "replace").splitlines():
        if "inject" in l: say("errors.jsonl", l[:400])
