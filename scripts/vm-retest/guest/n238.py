# n238.py <root> <phase> [arg]: the 0.2.38 additions, on top of newtests.py (run "newtests.py <root> setup" first:
# window "wn" with panes qa and qb).
#   stopagent : qa runs a long turn, cli_interrupt qa (agent STOP), then a cli_send starts a new 40 s turn: during it
#               ui.status must leave "stopped" and the pane menu's Interrupt must be enabled
#   stopuser  : qa launches a background Bash (sleep 45) and stays busy; a person's STOP (menu Interrupt); a PING is sent;
#               when the background job ends Claude starts its own turn -> the badge clears, the PING stays queued;
#               then a person types (space + Backspace) -> the PING goes in
#   kick <n>  : <n> busy processes (PIDs recorded, ended by PID), the window minimized; 3x external cli_open_agent with a
#               task -> the kickoff answer (sent / failed), attempts in the log, and what is left in each input box
#   reclaim   : qb opens a child (as qb, through qb's pane MCP URL); while the child's 40 s turn runs, the child
#               cli_sends its report to qb (through the child's pane MCP URL); once the child is idle qb reclaims it
#   browser   : Navide Browser: snapshot filter=interactive / root, act diff:true; a Space shared by qa and qb:
#               qa handoff -> qb take_over / finish -> the Space must still show qa's need-action and note
import json, os, re, signal, subprocess, sys, time
ROOTP, PH = sys.argv[1:3]; ARG = sys.argv[3] if len(sys.argv) > 3 else ""
sys.argv = [sys.argv[0], ROOTP, "status"]
_src = open(ROOTP + "/newtests.py", encoding="utf-8").read().split('\nif phase == "setup":')[0]
exec(_src)
phase = PH
def pid_of(nm): return st[nm]
def menu(nm, click=None):
    """Open the pane's context menu, list its items (text|disabled), click one by its text, or close the menu."""
    c = Cdp(main_page(ws)); pid = pid_of(nm)
    js = f"""(async()=>{{const host=document.querySelector('.xterm-host[data-pane-id="{pid}"]'); if(!host) return 'no-host';
      let el=host; let hm=null; while(el && !hm){{ el=el.parentElement; hm=el && el.querySelector('.header-main'); }}
      const hdr=hm.parentElement; const r=hdr.getBoundingClientRect();
      hdr.dispatchEvent(new MouseEvent('contextmenu',{{bubbles:true,cancelable:true,clientX:r.left+20,clientY:r.top+5}}));
      await new Promise(f=>setTimeout(f,400));
      const items=[...document.querySelectorAll('.pane-ctx-item')];
      const desc=items.map(i=>i.innerText.trim().split('\\n')[0]+((i.disabled||i.classList.contains('disabled')||i.getAttribute('aria-disabled')==='true')?' [disabled]':''));
      const want={json.dumps(click)};
      if(want){{ const it=items.find(i=>new RegExp(want,'i').test(i.innerText.trim())); if(!it) return 'no-item '+JSON.stringify(desc); it.click(); return 'clicked '+JSON.stringify(desc); }}
      document.dispatchEvent(new KeyboardEvent('keydown',{{key:'Escape',bubbles:true}})); document.body.click();
      return JSON.stringify(desc);}})()"""
    return c.ev(js)
def interrupt_item(desc): return [d for d in re.findall(r'"([^"]*)"', desc or "") if re.match(r"(Interrupt|中斷)", d)]
def ui(nm):
    r = ext("cli_get_status", {"target": f"wn/{nm}", "workspace_path": ws})
    u = r.get("ui") or {}
    return {"busy": r.get("busy"), "status": r.get("status"), "ui.status": u.get("status"), "stopped": u.get("stopped", r.get("stopped"))}
def wait_busy(nm, s=40):
    for _ in range(s):
        time.sleep(1)
        if status(f"wn/{nm}").get("busy"): return True
    return False
if phase == "stopagent":
    nm = "qa"; n = _s.token_hex(4)
    rules([{"match": "LONGTURN", "sleep": 300, "text": "long done"}, {"match": f"NEWTURN-{n}", "sleep": 40, "text": "new turn done"}])
    say("send LONGTURN", json.dumps(ext("cli_send", {"to": f"wn/{nm}", "text": "LONGTURN: start the long task"}))[:160])
    say("busy", wait_busy(nm)); time.sleep(3)
    say("cli_interrupt", json.dumps(ext("cli_interrupt", {"target": f"wn/{nm}", "workspace_path": ws}))[:200])
    time.sleep(5); say("after interrupt", ui(nm))
    r = ext("cli_send", {"to": f"wn/{nm}", "text": f"NEWTURN-{n} take 40 seconds"}); k = r.get("msg_key"); t0 = time.time()
    say("sent NEWTURN", json.dumps(r)[:160])
    for _ in range(40):
        time.sleep(3)
        if check(k).get("status") == "delivered": break
    say("delivery", check(k), f"+{round(time.time()-t0,1)}s")
    seen = []
    for i in range(6):
        time.sleep(4); u = ui(nm); d = menu(nm); seen.append((u, interrupt_item(d)))
        say(f"during new turn #{i}", u, "menu:", d)
    hits, _ = stub_hits(f"NEWTURN-{n}", t0)
    ok = any(u.get("ui.status") == "running" and it and "[disabled]" not in it[0] for u, it in seen)
    say("RESULT stopagent", f"delivered={check(k).get('status')} stub_hits={hits} running+interrupt-enabled-seen={ok}")
    RULES.unlink(); time.sleep(40); say("status end", ui(nm))
elif phase == "stopuser":
    nm = "qa"; n = _s.token_hex(4)
    rules([{"match": f"BGTURN-{n}", "sleep": 0, "text": "", "bg": "sleep 45; echo bg-done"}])
    (ROOT / "stub.log.tailsleep").write_text("300")
    say("send BGTURN", json.dumps(ext("cli_send", {"to": f"wn/{nm}", "text": f"BGTURN-{n} run it in the background"}))[:160])
    say("busy", wait_busy(nm)); time.sleep(8); t0 = time.time()
    say("person STOP via menu:", menu(nm, "^(Interrupt|中斷)"))
    time.sleep(4); say("after STOP", ui(nm))
    p = _s.token_hex(4); r = ext("cli_send", {"to": f"wn/{nm}", "text": f"PING-{p} reply with ok"}); k = r.get("msg_key")
    say("sent PING", json.dumps(r)[:160])
    own = None
    for _ in range(40):
        time.sleep(3); u = ui(nm)
        if u.get("busy") and own is None: own = time.time() - t0; say(f"agent's own turn at +{round(own,1)}s", u)
        if own and not u.get("busy"): break
    time.sleep(5); u_after = ui(nm); c_after = check(k)
    say("after the agent's own turn", u_after, "PING", c_after, "menu:", menu(nm))
    hits_before, _ = stub_hits(f"PING-{p}", t0)
    say("person types (space + Backspace)")
    c = Cdp(main_page(ws)); pid = pid_of(nm)
    c.ev(f"""(()=>{{const h=document.querySelector('.xterm-host[data-pane-id="{pid}"]'); const t=h&&h.querySelector('textarea'); if(t) t.focus(); return !!t;}})()""")
    for key, code, vk, txt in ((" ", "Space", 32, " "), ("Backspace", "Backspace", 8, "")):
        for typ in ("keyDown", "keyUp"):
            q = {"type": typ, "key": key, "code": code, "windowsVirtualKeyCode": vk}
            if typ == "keyDown" and txt: q["text"] = txt
            c.call("Input.dispatchKeyEvent", **q)
        time.sleep(0.5)
    t1 = time.time()
    for _ in range(24):
        time.sleep(5)
        if check(k).get("status") != "queued": break
    hits_after, _ = stub_hits(f"PING-{p}", t0)
    say("RESULT stopuser", f"own_turn_at={own and round(own,1)}s badge_after_own_turn={u_after} ping_while_held={c_after} "
        f"stub_ping_before_typing={hits_before} after_typing={check(k)} (+{round(time.time()-t1,1)}s) stub_ping={hits_after}")
    RULES.unlink(missing_ok=True); (ROOT / "stub.log.tailsleep").unlink(missing_ok=True)
elif phase == "kick":
    k = int(ARG or 12); pids = []
    for _ in range(k):
        q = subprocess.Popen([sys.executable, "-c", "while True: pass"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); pids.append(q.pid)
    (ROOT / "kick.pids").write_text(" ".join(map(str, pids))); say("busy pids", pids, "load", gload())
    c = Cdp(main_page(ws))
    try:
        time.sleep(60); say("warmed up, load", gload())
        for i in range(1, 4):
            w = c.call("Browser.getWindowForTarget"); wid = w.get("windowId")
            c.call("Browser.setWindowBounds", windowId=wid, bounds={"windowState": "minimized"})
            time.sleep(2); say(f"kick{i} window", c.call("Browser.getWindowBounds", windowId=wid).get("bounds"))
            off = blog_from(); t0 = time.time(); nm = f"kk{i}"
            r = ext("cli_open_agent", {"agent": "claude", "name": nm, "task": f"KICKTASK-{i} reply with the word ready.", "workspace_path": ws})
            say(f"kick{i} answer +{round(time.time()-t0,1)}s", json.dumps({x: r.get(x) for x in r if x not in ("instructions",)})[:500])
            time.sleep(30)
            c.call("Browser.setWindowBounds", windowId=wid, bounds={"windowState": "normal"})
            lg = ext("cli_read_log", {"target": f"wn/{nm}", "workspace_path": ws, "lines": 25})
            txt = json.dumps(lg, ensure_ascii=False)
            say(f"kick{i} KICKTASK copies on screen={txt.count(f'KICKTASK-{i}')} stub_requests={stub_hits(f'KICKTASK-{i}', t0)[0]} load={gload()}")
            tail = (lg.get("text") or lg.get("log") or txt)[-900:]
            say(f"kick{i} screen tail:", tail)
            ks = []
            with open(BLOG, encoding="utf-8", errors="replace") as f:
                f.seek(off); ks = [l.strip()[:220] for l in f if "kickoff" in l.lower() or "spawn." in l]
            for l in ks[-12:]: say(f"  kick{i} log:", l)
            say(f"kick{i} close", json.dumps(ext("cli_close_agent", {"target": f"wn/{nm}", "workspace_path": ws}))[:160]); time.sleep(5)
    finally:
        for q in pids: os.kill(q, signal.SIGTERM)
        say("busy pids ended", pids)
elif phase == "reclaim":
    n = _s.token_hex(4); purl = pane_url(st["qb"])
    rules([{"match": f"CHILDTASK-{n}", "sleep": 40, "text": "child work done"}])
    r = mcp(purl, "cli_open_agent", {"agent": "claude", "name": "kid", "task": f"CHILDTASK-{n} do the work, then report to your parent with cli_send."})
    say("open child as qb", json.dumps(r)[:300]); kid = r.get("pane_id")
    for _ in range(30):
        time.sleep(2)
        if pane_url(kid): break
    kurl = pane_url(kid); say("child MCP url found", bool(kurl), "busy", wait_busy("kid", 30))
    rr = mcp(kurl, "cli_send", {"to": "qb", "text": f"REPORT-{n}: child work done"}); say("child -> qb cli_send", json.dumps(rr)[:200])
    k = rr.get("msg_key")
    for _ in range(40):
        time.sleep(3)
        if check(k).get("status") != "queued": break
    say("report delivery", check(k))
    for _ in range(40):
        time.sleep(3)
        if not status("wn/kid").get("busy"): break
    time.sleep(3); say("child status", status("wn/kid"))
    rc = mcp(purl, "cli_reclaim_agent", {"target": "kid"}); say("RESULT reclaim", json.dumps(rc)[:300])
    RULES.unlink()
elif phase == "browser":
    qa, qb = pane_url(st["qa"]), pane_url(st["qb"]); sp = "shared-" + _s.token_hex(3)
    page = "data:text/html," + "<h1>t</h1><p>static text</p><button id=b onclick=\"this.textContent='clicked'\">Press</button><input aria-label=name><div id=r><a href=#x>link</a></div>"
    say("list (qa)", json.dumps(mcp(qa, "browser_list", {}))[:300])
    o = mcp(qa, "browser_open", {"space": sp, "url": "http://127.0.0.1:8951/"}); say("open qa", json.dumps(o)[:300])
    say("goto data page", json.dumps(mcp(qa, "browser_act", {"space": sp, "action": "goto", "url": page}))[:200])
    full = mcp(qa, "browser_snapshot", {"space": sp}); say("snapshot default", json.dumps(full)[:600])
    inter = mcp(qa, "browser_snapshot", {"space": sp, "filter": "interactive"}); say("snapshot interactive", json.dumps(inter)[:600])
    ref = (re.findall(r"@\d+", json.dumps(inter)) or ["@0"])[0]
    root = mcp(qa, "browser_snapshot", {"space": sp, "root": ref}); say("snapshot root", ref, json.dumps(root)[:400])
    btn = next((m for m in re.findall(r'[^\\n"]*Press[^\\n"]*', json.dumps(full))), ""); bref = (re.findall(r"@\d+", btn) or [ref])[0]
    act = mcp(qa, "browser_act", {"space": sp, "action": "click", "ref": bref, "diff": True}); say("act diff", bref, json.dumps(act)[:600])
    h = mcp(qa, "browser_handoff", {"space": sp, "note": "please sign in (qa)"}); say("qa handoff", json.dumps(h)[:300])
    def spc():
        L = mcp(qb, "browser_list", {}); s = json.dumps(L)
        return [x for x in (L.get("spaces") or L.get("tabs") or L.get("views") or []) if sp in json.dumps(x)] or s[:400]
    say("space after handoff", spc())
    say("qb take_over", json.dumps(mcp(qb, "browser_take_over", {"space": sp, "note": "qb wants to continue", "timeoutMs": 3000}))[:300])
    say("space after qb take_over", spc())
    say("qb finish", json.dumps(mcp(qb, "browser_finish", {"space": sp, "note": "qb done"}))[:300])
    say("RESULT browser space after qb finish", spc())
