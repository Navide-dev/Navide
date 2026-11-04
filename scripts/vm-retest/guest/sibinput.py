# sibinput.py <recdir>: every keystroke the window sent to any pane after the run failed (from a rec.py recording).
#   failure time = the first log line "pipeline failed"/"no longer running"; prints the "⏹ interrupted" lines with their delay
import base64, datetime, json, os, sys
rec = sys.argv[1]; F = lambda t: datetime.datetime.fromtimestamp(t).strftime("%H:%M:%S.%f")[:-3]
s2p = {}; logs = []; ins = []
for l in open(os.path.join(rec, "cdp.jsonl"), encoding="utf-8"):
    o = json.loads(l); t = o["t"]; d = o["m"]
    if not d.get("method", "").startswith("Network.webSocketFrame"): continue
    r = d["params"]["response"]; sent = d["method"].endswith("Sent")
    if r.get("opcode") == 2:
        b = base64.b64decode(r["payloadData"]); i = 5
        a = b[i + 1:i + 1 + b[i]]; i += 1 + b[i]; pn = b[i + 1:i + 1 + b[i]]
        s2p[a.decode()[:8]] = pn.decode()[:8]; continue
    try: p = json.loads(r["payloadData"])
    except Exception: continue
    pl = p.get("payload") or {}
    if p.get("type") == "project.log_event" and sent: logs.append((t, (pl.get("details") or {}).get("line") or ""))
    if p.get("type") == "terminal.input" and sent: ins.append((t, str(pl.get("terminal_session_id"))[:8], pl.get("data", "")))
fail = next((t for t, x in logs if "pipeline failed" in x or "no longer running" in x or "run failed" in x), None)
print("failure logged at", fail and F(fail))
for t, x in logs:
    if "interrupted" in x and "⏹" in x: print(f"  {F(t)} (+{t - fail:.2f}s) {x[:150]}" if fail else f"  {F(t)} {x[:150]}")
print("keystrokes after the failure:")
for t, s, dd in ins:
    if fail and t >= fail: print(f"  {F(t)} (+{t - fail:.2f}s) pane={s2p.get(s, '?' + s)} {json.dumps(dd)[:60]}")
print("panes seen in this window:", sorted(set(s2p.values())))
