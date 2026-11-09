# kickcmp.py <root>: external cli_open_agent with a task into "wn", once with the window normal and once minimized
# (CDP Browser.setWindowBounds), no load: the answer, how long it took, and the window state Chromium reports.
import json, sys, time
ROOTP = sys.argv[1]; sys.argv = [sys.argv[0], ROOTP, "kick"]
exec(open(ROOTP + "/n238.py", encoding="utf-8").read().split('\nif phase == "stopagent":')[0])
c = Cdp(main_page(ws)); w = c.call("Browser.getWindowForTarget"); say("getWindowForTarget", json.dumps(w)[:200]); wid = w.get("windowId")
for state in ("normal", "minimized"):
    if wid is not None: c.call("Browser.setWindowBounds", windowId=wid, bounds={"windowState": state})
    time.sleep(2); say(state, "bounds", json.dumps(c.call("Browser.getWindowBounds", windowId=wid) if wid is not None else {})[:200],
                       "visibility", c.ev("document.visibilityState"))
    nm = f"kc-{state[:3]}-{_s.token_hex(2)}"; t0 = time.time()
    r = ext("cli_open_agent", {"agent": "claude", "name": nm, "task": f"KICKCMP {state} reply with the word ready.", "workspace_path": ws})
    say(f"RESULT kickcmp {state} +{round(time.time()-t0,1)}s", json.dumps({x: r.get(x) for x in r if x not in ("instructions",)}, ensure_ascii=False)[:300])
    if wid is not None: c.call("Browser.setWindowBounds", windowId=wid, bounds={"windowState": "normal"})
    time.sleep(20)
    try: say("close", json.dumps(ext("cli_close_agent", {"target": f"wn/{nm}", "workspace_path": ws}))[:150])
    except Exception as e: say("close err", e)
