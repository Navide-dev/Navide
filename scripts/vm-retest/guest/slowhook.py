# slowhook.py <root> add|remove|show: a test-only slow Stop hook in the test account's user-level Claude settings
# (~/.claude/settings.json). Navide's own hooks come in through --settings and are never touched.
#   The hook sleeps 20 s only while <root>/stub.log.slowstop exists; otherwise it exits at once.
#   add:    back up the file (or note it did not exist) to <root>/claude-settings.backup.json, then add one Stop group
#   remove: put the file back exactly as it was (or delete it if it did not exist)
import json, os, sys, time
root, mode = sys.argv[1:3]
path = os.path.expanduser(os.path.join("~", ".claude", "settings.json")); bak = os.path.join(root, "claude-settings.backup.json")
flag = os.path.join(root, "stub.log.slowstop"); MARK = "# vm-retest slow-stop"
if os.name == "nt":
    hook = {"type": "command", "shell": "powershell", "command": f"{MARK}\nif (Test-Path '{flag}') {{ Start-Sleep -Seconds 20 }}; exit 0"}
else:
    hook = {"type": "command", "command": f"{MARK}\n[ -f '{flag}' ] && sleep 20; exit 0"}
def now(): return time.strftime("%Y-%m-%d %H:%M:%S")
if mode == "add":
    existed = os.path.exists(path); raw = open(path, encoding="utf-8").read() if existed else None
    if os.path.exists(bak): sys.exit("backup already present: remove first")
    json.dump({"existed": existed, "raw": raw}, open(bak, "w", encoding="utf-8"))
    d = json.loads(raw) if raw else {}
    d.setdefault("hooks", {}).setdefault("Stop", []).append({"hooks": [hook]})
    os.makedirs(os.path.dirname(path), exist_ok=True); json.dump(d, open(path, "w", encoding="utf-8"), indent=2)
    print(now(), "added slow Stop hook to", path, "| existed before:", existed, "| hook:", json.dumps(hook))
elif mode == "remove":
    b = json.load(open(bak, encoding="utf-8"))
    if b["existed"]: open(path, "w", encoding="utf-8").write(b["raw"])
    elif os.path.exists(path): os.remove(path)
    os.remove(bak)
    if os.path.exists(flag): os.remove(flag)
    print(now(), "removed slow Stop hook; settings restored (existed before:", b["existed"], ")")
else:
    print(open(path, encoding="utf-8").read() if os.path.exists(path) else "(no user settings file)")
