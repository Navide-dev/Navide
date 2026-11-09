# shotin.py <root> <space>: screenshot a Space that a Browser window is showing (control handed back to the agent)
import json, sys, time
ROOTP, SP = sys.argv[1], sys.argv[2]; sys.argv = [sys.argv[0], ROOTP, "browser"]
exec(open(ROOTP + "/n238.py", encoding="utf-8").read().split('\nif phase == "stopagent":')[0])
qa = pane_url(st["qa"])
def body(r):
    try: t = r["result"]["content"][0]["text"]; return json.loads(t[t.index("{"):t.rindex("}") + 1])
    except Exception: return r
def kinds(r): return [(c.get("type"), c.get("mimeType"), len(c.get("data") or c.get("text") or "")) for c in ((r.get("result") or {}).get("content") or [])]
say("list", json.dumps(body(mcp(qa, "browser_list", {})))[:300])
for i in (1, 2):
    t0 = time.time(); r = mcp(qa, "browser_screenshot", {"space": SP}); dt = round(time.time() - t0, 1)
    say(f"RESULT in-window screenshot #{i}", f"after={dt}s content={kinds(r)}", "" if kinds(r) and kinds(r)[0][0] == "image" else json.dumps(body(r))[:300])
