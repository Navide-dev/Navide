# obwalk.py <root> <step> [arg]: onboarding walk in the window=main page over CDP (test VM only)
#   shot <name> | texts | scrollbottom | find <text> (scroll it into view) | click <button text> | settle
import base64, json, sys, time
ROOTP, step = sys.argv[1:3]; arg = sys.argv[3] if len(sys.argv) > 3 else ""; sys.argv = ["d", ROOTP, "x"]
exec(open(ROOTP + "/drv.py").read().split("PH = {")[0])
import os
W = os.environ.get("OBW", "")
ps = [p for p in pages() if p.get("type") == "page"]
p = next((p for p in ps if p["url"].endswith("index.html?window=main")), None) if not W else next(p for p in ps if ("wh%5C" + W + "&") in p["url"] or p["url"].endswith("wh%5C" + W))
p = p or next(p for p in ps if "window=main" in p["url"])
c = Cdp(p)
def shot(n):
    r = c.call("Page.captureScreenshot", format="png"); open(n + ".png", "wb").write(base64.b64decode((r.get("result") or r).get("data", ""))); print("saved", n)
if step == "shot": shot(arg)
elif step == "texts": print(c.ev("JSON.stringify([...document.querySelectorAll('button,h1,h2,h3,[role=alert]')].map(e=>e.innerText.trim()).filter(Boolean).slice(0,80))"))
elif step == "scrollbottom":
    print(c.ev("(()=>{const s=[...document.querySelectorAll('*')].filter(e=>e.scrollHeight>e.clientHeight+20&&getComputedStyle(e).overflowY!='visible'); s.forEach(e=>e.scrollTop=e.scrollHeight); return s.length})()")); time.sleep(1); shot("ob-bottom")
elif step == "find":
    print(c.ev(f"(()=>{{const t={json.dumps(arg)}; const el=[...document.querySelectorAll('*')].find(e=>e.children.length<6&&e.innerText&&e.innerText.trim().startsWith(t)); if(!el) return 'none'; el.scrollIntoView({{block:'center'}}); const k=el.closest('[class*=card],[class*=Card],[role=button],button')||el; k.click(); k.dispatchEvent(new MouseEvent('click',{{bubbles:true}})); return el.innerText.slice(0,300)}})()")); time.sleep(1.5); shot("ob-find-" + arg.split()[0])
elif step == "click":
    print(c.ev(f"(()=>{{const b=[...document.querySelectorAll('button,a,[role=button]')].find(e=>e.innerText.trim()==={json.dumps(arg)}); if(!b) return 'none'; b.click(); return 'clicked'}})()")); time.sleep(3)
elif step == "mclick":
    x, y = map(int, arg.split(","))
    c.call("Input.dispatchMouseEvent", type="mouseMoved", x=x, y=y)
    for t in ("mousePressed", "mouseReleased"): c.call("Input.dispatchMouseEvent", type=t, x=x, y=y, button="left", clickCount=1)
    time.sleep(1.5); shot(sys.argv[4] if len(sys.argv) > 4 else "ob-mclick")
elif step == "grep":
    r = c.ev(f"JSON.stringify([...document.querySelectorAll('button')].map(e=>e.innerText.trim()).filter(t=>new RegExp({json.dumps(arg)},'i').test(t)))")
    sys.stdout.buffer.write((r + "\n").encode("utf-8"))
