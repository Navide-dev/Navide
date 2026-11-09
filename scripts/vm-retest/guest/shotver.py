# shotver.py <root>: browser_screenshot on a Space that no Browser window shows (pane qa of "wn", local test page),
# then on the same Space once a Browser window shows it (browser_handoff brings it up for the user).
# Expected off-window: ok + image/jpeg in about 2.5 s, or ok:false VIEW_NOT_RENDERED reason=no-frame within 4-5 s,
# never the 30 s PLUGIN_TOOL_TIMEOUT. Prints main.log's PluginWebViewRegistry lines written meanwhile.
import json, os, pathlib, subprocess, sys, time
ROOTP = sys.argv[1]; sys.argv = [sys.argv[0], ROOTP, "browser"]
_src = open(ROOTP + "/n238.py", encoding="utf-8").read()
exec(_src.split('\nif phase == "stopagent":')[0])
qa = pane_url(st["qa"]); sp = "shot-" + _s.token_hex(3)
def body(r):
    try: t = r["result"]["content"][0]["text"]; return json.loads(t[t.index("{"):t.rindex("}") + 1])
    except Exception: return r
def kinds(r): return [(c.get("type"), c.get("mimeType"), len(c.get("data") or c.get("text") or "")) for c in ((r.get("result") or {}).get("content") or [])]
def timed(tool, args): t0 = time.time(); r = mcp(qa, tool, args); return r, round(time.time() - t0, 1)
MAIN = pathlib.Path.home() / ".config/agent-team/logs/main.log"; off = MAIN.stat().st_size if MAIN.exists() else 0
pd = ROOTP + "/browser-page"; os.makedirs(pd, exist_ok=True)
open(pd + "/t.html", "w").write("<h1>t</h1><p>static text</p><button id=b onclick=\"this.textContent='clicked'\">Press</button>")
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8952", "--bind", "127.0.0.1", "--directory", pd], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
page = "http://127.0.0.1:8952/t.html"
r, dt = timed("browser_open", {"space": sp, "url": page}); say("open", f"{dt}s", json.dumps(body(r))[:300])
s = body(mcp(qa, "browser_snapshot", {"space": sp})); say("RESULT shotver snapshot", f"len={len(str(s.get('snapshot') or ''))}", json.dumps(s)[:300])
for i in (1, 2):
    r, dt = timed("browser_screenshot", {"space": sp})
    say(f"RESULT shotver off-window screenshot #{i}", f"after={dt}s content={kinds(r)}", "" if kinds(r) and kinds(r)[0][0] == "image" else json.dumps(body(r))[:400])
lines = [l for l in (MAIN.read_text(errors="replace")[off:].splitlines() if MAIN.exists() else []) if "PluginWebViewRegistry" in l or "capturePage" in l or "no frame" in l.lower()]
say("main.log PluginWebViewRegistry lines:", json.dumps(lines[-15:], ensure_ascii=False))
h = body(mcp(qa, "browser_handoff", {"space": sp, "note": "shown for the screenshot check"})); say("handoff (shows the Space)", json.dumps(h)[:300])
time.sleep(5); say("windows", subprocess.run(["bash", "-c", "DISPLAY=:0 XAUTHORITY=$(ls /run/user/1000/.mutter-Xwaylandauth.*|head -1) xwininfo -root -tree | grep -iE 'browser|navide' | head -8"], capture_output=True, text=True).stdout)
r, dt = timed("browser_screenshot", {"space": sp})
say("RESULT shotver in-window screenshot", f"after={dt}s content={kinds(r)}", "" if kinds(r) and kinds(r)[0][0] == "image" else json.dumps(body(r))[:400])
lines = [l for l in (MAIN.read_text(errors="replace")[off:].splitlines() if MAIN.exists() else []) if "PluginWebViewRegistry" in l or "capturePage" in l or "no frame" in l.lower()]
say("main.log PluginWebViewRegistry lines (all):", json.dumps(lines[-25:], ensure_ascii=False))
srv.terminate(); srv.wait(10)
