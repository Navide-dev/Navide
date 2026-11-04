# freeze.py <root> <ws> [external]: right after start, in workspace window <ws>: open Explorer, right-click folder "sub",
# hover "Open with" -> the editor submenu (main probes editors, reg query on Windows). A 50 ms renderer heartbeat records
# the largest gap; getBackendInfo times a main-process IPC round trip during it.
import json, sys, time
ROOTP, WSN = sys.argv[1:3]; sys.argv = ["d", ROOTP, "x"]
exec(open(ROOTP + "/drv.py").read().split("PH = {")[0])
T0 = time.time(); ws = str(ROOT / WSN); mp = None
while time.time() - T0 < 90:
    try: mp = main_page(ws)
    except Exception: mp = None
    if mp: break
    time.sleep(0.3)
c = Cdp(mp); print(time.strftime("%H:%M:%S"), f"window found +{time.time()-T0:.1f}s", flush=True)
c.ev("window.__hb={max:0,last:performance.now(),n:0};setInterval(()=>{const t=performance.now();window.__hb.max=Math.max(window.__hb.max,t-window.__hb.last);window.__hb.last=t;window.__hb.n++},50);1")
def ipc():
    t = time.time(); c.ev("(async()=>{await window.agentTeam.getBackendInfo();return 1})()"); return round((time.time() - t) * 1000)
def mouse(t, x, y, b="none", n=0): c.call("Input.dispatchMouseEvent", type=t, x=x, y=y, button=b, clickCount=n)
def pos(js):
    return json.loads(c.ev(f"(()=>{{const e={js};if(!e||!e.offsetParent)return 'null';const r=e.getBoundingClientRect();return JSON.stringify([r.x+Math.min(r.width/2,60),r.y+r.height/2])}})()") or "null")
for _ in range(120):
    b = pos("document.querySelector('[title^=\"Explorer (\"]')")
    if b: break
    time.sleep(0.25)
print("explorer tab", c.ev("(()=>{const e=document.querySelector('[title^=\"Explorer (\"]');e.click();return e.tagName+' '+e.className})()"), flush=True)
for _ in range(80):
    r = pos("document.querySelector('.exp-row[data-rel=\"sub\"]')")
    if r: break
    time.sleep(0.25)
print(time.strftime("%H:%M:%S"), f"explorer row +{time.time()-T0:.1f}s", r, "ipc", ipc(), "ms", flush=True)
t1 = time.time(); mouse("mouseMoved", *r); mouse("mousePressed", *r, "right", 1); mouse("mouseReleased", *r, "right", 1); time.sleep(0.3)
h = pos("document.querySelector('.exp-ctx-item.has-sub')"); print(f"context menu {time.time()-t1:.2f}s, Open with at", h, "ipc", ipc(), "ms", flush=True)
if h:
    mouse("mouseMoved", *h); time.sleep(1.5)
    print("submenu:", c.ev("JSON.stringify([...document.querySelectorAll('.exp-ctx-submenu button')].map(x=>x.innerText.trim()))"), "ipc", ipc(), "ms", flush=True)
for _ in range(6): time.sleep(0.5); ipc()
print("heartbeat", c.ev("JSON.stringify({maxGapMs:Math.round(window.__hb.max),ticks:window.__hb.n})"), f"check ended +{time.time()-T0:.1f}s", flush=True)
c.call("Input.dispatchKeyEvent", type="keyDown", key="Escape", code="Escape", windowsVirtualKeyCode=27)
mouse("mousePressed", 5, 700, "left", 1); mouse("mouseReleased", 5, 700, "left", 1)
