# shotwin.py <root> <space> <viewId>: open the Navide Browser window (title-bar plugin action), select the Space,
# take control back as qa, and screenshot it while a Browser window shows it.
import json, subprocess, sys, time
ROOTP, SP, VID = sys.argv[1], sys.argv[2], sys.argv[3]; sys.argv = [sys.argv[0], ROOTP, "browser"]
exec(open(ROOTP + "/n238.py", encoding="utf-8").read().split('\nif phase == "stopagent":')[0])
qa = pane_url(st["qa"])
def body(r):
    try: t = r["result"]["content"][0]["text"]; return json.loads(t[t.index("{"):t.rindex("}") + 1])
    except Exception: return r
def kinds(r): return [(c.get("type"), c.get("mimeType"), len(c.get("data") or c.get("text") or "")) for c in ((r.get("result") or {}).get("content") or [])]
c = Cdp(main_page(ws))
say("open Browser window:", c.ev("(()=>{const b=document.querySelector('.titlebar-plugin-action[title*=\"Navide Browser\"]'); if(!b) return 'none'; b.click(); return 'clicked';})()"))
time.sleep(6)
say("pages", [(p.get("title"), p.get("url", "")[:90]) for p in pages()])
bp = next((p for p in pages() if "browser" in (p.get("url", "") + p.get("title", "")).lower() and "x.html" not in p.get("url", "")), None)
if bp:
    b = Cdp(bp)
    say("select Space:", b.ev(f"""(async()=>{{const el=[...document.querySelectorAll('*')].find(e=>e.children.length<=2&&e.offsetParent&&/{SP}/.test(e.textContent)&&e.textContent.length<80);
      if(!el) return 'not-found'; el.click(); await new Promise(f=>setTimeout(f,1500)); return 'clicked '+el.tagName+'.'+el.className;}})()"""))
say("windows", subprocess.run(["bash", "-c", "DISPLAY=:0 XAUTHORITY=$(ls /run/user/1000/.mutter-Xwaylandauth.*|head -1) xwininfo -root -tree | grep -iE '\"[^\"]*(browser|navide)[^\"]*\"' | head -8"], capture_output=True, text=True).stdout)
say("take_over:", json.dumps(body(mcp(qa, "browser_take_over", {"space": SP, "note": "screenshot check", "timeoutMs": 5000})))[:300])
for i in (1, 2):
    t0 = time.time(); r = mcp(qa, "browser_screenshot", {"space": SP}); dt = round(time.time() - t0, 1)
    say(f"RESULT shotwin in-window screenshot #{i}", f"after={dt}s content={kinds(r)}", "" if kinds(r) and kinds(r)[0][0] == "image" else json.dumps(body(r))[:400])
say("list", json.dumps(body(mcp(qa, "browser_list", {})))[:500])
