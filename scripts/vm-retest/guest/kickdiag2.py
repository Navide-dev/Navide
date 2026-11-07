# kickdiag2.py <root>: one failing external cli_open_agent (task) into "wn" and, before Navide kills the pane:
# cli_read_log (tail 40) every 3 s, one ui_snapshot, and a byte-for-byte copy of the pane's PTY capture file.
import glob, json, os, shutil, sys, threading, time
ROOTP = sys.argv[1]; sys.argv = [sys.argv[0], ROOTP, "kick"]
exec(open(ROOTP + "/n238.py", encoding="utf-8").read().split('\nif phase == "stopagent":')[0])
OUT = os.path.join(ROOTP, "kickdiag"); os.makedirs(OUT, exist_ok=True)
pat = os.path.join(ws, ".agent-team", "manual", "*", "claude-*.log"); before = set(glob.glob(pat))
nm = "kd2-" + _s.token_hex(2); res = {}; t0 = time.time()
th = threading.Thread(target=lambda: res.update(ext("cli_open_agent", {"agent": "claude", "name": nm, "task": "KICKDIAG2 reply with the word ready.", "workspace_path": ws}))); th.start()
logs = []; cap = None; snap_done = False; n = 0
while th.is_alive() and time.time() - t0 < 40:
    new = [x for x in glob.glob(pat) if x not in before]
    if new: cap = new[0]; shutil.copyfile(cap, os.path.join(OUT, "raw-latest.log"))
    if time.time() - t0 >= 3 * (n + 1):
        n += 1
        try: r = ext("cli_read_log", {"target": f"wn/{nm}", "workspace_path": ws, "lines": 40})
        except Exception as e: r = {"err": str(e)}
        logs.append({"t": round(time.time() - t0, 1), "read_log": r})
        if not snap_done and time.time() - t0 >= 6:
            try: open(os.path.join(OUT, "ui_snapshot.json"), "w", encoding="utf-8").write(json.dumps(ext("ui_snapshot", {"workspace_path": ws}), ensure_ascii=False, indent=1))
            except Exception as e: open(os.path.join(OUT, "ui_snapshot.json"), "w").write(str(e))
            snap_done = True
    time.sleep(0.3)
th.join(60)
pid8 = os.path.basename(cap).split("-")[1].split(".")[0] if cap else "none"
if cap: os.replace(os.path.join(OUT, "raw-latest.log"), os.path.join(OUT, f"raw-{pid8}.log"))
open(os.path.join(OUT, "read_log.json"), "w", encoding="utf-8").write(json.dumps(logs, ensure_ascii=False, indent=1))
say(f"answer +{round(time.time()-t0,1)}s", json.dumps({k: res.get(k) for k in res if k != "instructions"}, ensure_ascii=False)[:200])
say("capture", cap, "pane8", pid8, "read_log samples", [(x["t"], len(json.dumps(x["read_log"], ensure_ascii=False))) for x in logs])
