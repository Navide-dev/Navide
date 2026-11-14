# tokcheck.py <root> stats|oldcp: Codex token totals against fakecodex's rollouts (fakecodex.py with ~/wh/fakecodex-rollout).
#   stats : expected = each rollout's last token_count input_tokens / output_tokens (cached and reasoning are already
#           inside them), summed; actual = cli_token_stats by_vendor (all projects) and the workspace's cumulative
#   oldcp : with the app quit: rewrite navide.db's ingestion_checkpoints rows for the newest fakecodex rollout as an
#           older Navide left them (no "basis", totals in the input+cached / output+reasoning basis at the checkpoint's
#           offset), then append one more token_count to that rollout as a turn made while the app was down.
#           Start the app and run "stats": the totals must still match (nothing lost, nothing counted twice).
import json, os, pathlib, sqlite3, sys
ROOTP, PH = sys.argv[1:3]
TLOG = pathlib.Path.home() / "wh" / "fakecodex-tokens.log"
def last_totals():
    last = {}
    for line in TLOG.read_text(encoding="utf-8").splitlines():
        rec = json.loads(line); last[rec["rollout"]] = rec
    return last
def cwd_of(rollout):
    with open(rollout, encoding="utf-8") as f: return json.loads(f.readline())["payload"]["cwd"]

if PH == "oldcp":
    last = last_totals(); rollout = max(last, key=lambda p: os.path.getmtime(p))
    dbs = [p for b in (pathlib.Path.home() / ".config", pathlib.Path.home() / ".local/share") for p in b.glob("*/navide.db")
           if "agent-team" in str(p).lower() or "navide" in str(p).lower()]
    db = max(dbs, key=lambda p: p.stat().st_mtime); print("db", db, "rollout", rollout)
    con = sqlite3.connect(db)
    rows = con.execute("SELECT path, scope, data FROM ingestion_checkpoints WHERE path = ?", (rollout,)).fetchall()
    print("rows", len(rows))
    head = open(rollout, "rb").read()
    for path, scope, data in rows:
        cp = json.loads(data); off = int(cp.get("offset") or 0); old = (0, 0)
        for raw in head[:off].splitlines():
            r = json.loads(raw); t = ((r.get("payload") or {}).get("info") or {}).get("total_token_usage")
            if r.get("type") == "event_msg" and t:
                old = (t["input_tokens"] + t["cached_input_tokens"], t["output_tokens"] + t["reasoning_output_tokens"])
        print("before", scope, json.dumps({k: cp.get(k) for k in ("offset", "input_total", "output_total", "basis")}))
        cp.pop("basis", None); cp["input_total"], cp["output_total"] = old
        con.execute("UPDATE ingestion_checkpoints SET data = ? WHERE path = ? AND scope = ?", (json.dumps(cp), path, scope))
        print("after ", scope, json.dumps({k: cp.get(k) for k in ("offset", "input_total", "output_total", "basis")}))
    con.commit(); con.close()
    t = dict(last[rollout]); t.pop("rollout")
    for k, v in (("input_tokens", 1000), ("cached_input_tokens", 600), ("output_tokens", 50), ("reasoning_output_tokens", 20)):
        t[k] += v
    t["total_tokens"] = t["input_tokens"] + t["output_tokens"]
    with open(rollout, "a", encoding="utf-8") as f:
        f.write(json.dumps({"timestamp": "2026-11-05T00:00:00Z", "type": "event_msg",
                            "payload": {"type": "token_count", "info": {"total_token_usage": t}}}) + "\n")
    with open(TLOG, "a", encoding="utf-8") as f: f.write(json.dumps({"rollout": rollout, **t}) + "\n")
    print("RESULT oldcp rewrote", len(rows), "rows; appended", json.dumps(t))
    sys.exit(0)

sys.argv = [sys.argv[0], ROOTP, "status"]
_src = open(ROOTP + "/newtests.py", encoding="utf-8").read().split('\nif phase == "setup":')[0]
exec(_src)
last = last_totals()
exp_in = sum(r["input_tokens"] for r in last.values()); exp_out = sum(r["output_tokens"] for r in last.values())
old_in = exp_in + sum(r["cached_input_tokens"] for r in last.values())
old_out = exp_out + sum(r["reasoning_output_tokens"] for r in last.values())
print("rollouts", len(last), "expected", exp_in, exp_out, "(the double-counting basis would read", old_in, old_out, ")")
for ws_path in sorted({cwd_of(p) for p in last}):
    r = ext("cli_token_stats", {"workspace_path": ws_path})
    s = json.dumps(r, ensure_ascii=False); i = s.find("{"); d = json.loads(s[i:]) if i >= 0 else {}
    def codex(m):
        while isinstance(m, dict) and "structuredContent" in m: m = m["structuredContent"]
        return {k: v for k, v in (m or {}).items() if "codex" in k.lower()} if isinstance(m, dict) else m
    body = d.get("result", d)
    if isinstance(body, dict) and "content" in body:
        try: body = json.loads(body["content"][0]["text"])
        except Exception: pass
    print("ws", ws_path)
    print("  by_vendor codex", json.dumps(codex(body.get("by_vendor")), ensure_ascii=False))
    print("  cumulative codex", json.dumps(codex((body.get("cumulative") or {}).get("by_vendor")), ensure_ascii=False))
print("RESULT tokstats expected input", exp_in, "output", exp_out, "- compare with by_vendor codex above")
