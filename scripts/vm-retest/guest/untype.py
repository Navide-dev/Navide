# untype.py <root>: cancel <key>, then act as a person: focus wn/qa's terminal and type a space + Backspace (clears the STOP mark)
import json, sys, time
ROOTP = sys.argv[1]; K = sys.argv[2]
sys.argv = [sys.argv[0], ROOTP, "wn", "state"]
exec(open(ROOTP + "/lineage.py", encoding="utf-8").read().split('if phase == "setup":')[0])
print("cancel", json.dumps(external(B(), "cli_cancel_message", {"msg_key": K}))[:200])
pid = json.loads((ROOT / "newtests.json").read_text())["qa"]
c = Cdp(main_page(ws))
print("focus", c.ev(f"""(()=>{{const h=document.querySelector('.xterm-host[data-pane-id="{pid}"]'); const t=h&&h.querySelector('textarea'); if(!t) return 'no-ta'; t.focus(); return document.activeElement===t;}})()"""))
for key, code, vk, txt in ((" ", "Space", 32, " "), ("Backspace", "Backspace", 8, "")):
    for typ in ("keyDown", "keyUp"):
        p = {"type": typ, "key": key, "code": code, "windowsVirtualKeyCode": vk}
        if typ == "keyDown" and txt: p["text"] = txt
        c.call("Input.dispatchKeyEvent", **p)
    time.sleep(0.5)
time.sleep(2); r = external(B(), "cli_get_status", {"target": "wn/qa", "workspace_path": ws}); print("ui", {k: v for k, v in (r.get("ui") or {}).items() if k != "buffer"})
