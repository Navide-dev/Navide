# newtests.py <root> <phase> [arg]: the 97d415189 additions, driven through the real window and MCP bus.
#   setup    : open window "wn", open panes qa and qb (external cli_open_agent)
#   intr     : qa runs a 300 s turn; a cli_send to qa queues; cli_interrupt qa (agent STOP) -> the queued message must go in (~120 s)
#   ustop    : same, but the STOP comes from the pane's own Interrupt menu item (a person's STOP) -> must stay queued 180 s, never typed
#   msgdelay : qa's transcript gets 100 MB+ of filler, then qa answers with an MSG block to qb -> qb must get it exactly once;
#              the hook/log gap is read from backend.log ("turn end for ...: hook first, log X s later")
#   late     : channels: the bound pane's transcript gets 100 MB+ of filler, the test sender asks; the reply must reach the room,
#              no "會補送" notice; gap from backend.log
#   load     : <n> busy processes (pids recorded, ended by pid) while 3 webhook runs go through sw: no false "never submitted"
import json, os, re, secrets as _s, signal, subprocess, sys, time, uuid
ROOTP, phase = sys.argv[1:3]; arg = sys.argv[3] if len(sys.argv) > 3 else ""
sys.argv = [sys.argv[0], ROOTP, "wn", "state"]
src = open(ROOTP + "/lineage.py", encoding="utf-8").read().split('if phase == "setup":')[0]
MYPHASE = phase
exec(src)
phase = MYPHASE
NT = ROOT / "newtests.json"; st = json.loads(NT.read_text()) if NT.exists() else {}
RULES = ROOT / "stub.log.rules.json"; STUB = ROOT / "stub.log"
BLOG = data_dir() / "logs" / "backend.log"
def ext(tool, args): return external(B(), tool, args)
def gload():
    if hasattr(os, "getloadavg"): return os.getloadavg()
    o = subprocess.run(["powershell", "-NoProfile", "-Command", "(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average"], capture_output=True, text=True).stdout.strip()
    return f"cpu {o}%"
def rules(lst): RULES.write_text(json.dumps(lst))
def stub_hits(word, since):
    n = 0; first = None
    for l in open(STUB, encoding="utf-8", errors="replace"):
        try: d = json.loads(l)
        except Exception: continue
        if d.get("at", 0) < since or not d.get("tools"): continue
        u = [m for m in d["messages"] if m.get("role") == "user"]
        if u and word in json.dumps(u[-1], ensure_ascii=False):
            n += 1; first = first or d["at"]
    return n, first
def status(t): r = ext("cli_get_status", {"target": t, "workspace_path": ws}); return {k: r.get(k) for k in ("status", "busy", "ui_status", "stopped", "live_status") if k in r} or r
def check(k): r = ext("cli_check_message", {"msg_key": k}); return {x: r.get(x) for x in ("status", "reason", "hold", "held_for_s", "settled_after_s", "age_seconds") if r.get(x) is not None}
def blog_from(): return BLOG.stat().st_size
def blog_gaps(off):
    with open(BLOG, encoding="utf-8", errors="replace") as f: f.seek(off); t = f.read()
    return [l[:200] for l in t.splitlines() if "turn end for" in l or "會補送" in l or "late" in l.lower() and "turn" in l.lower()]
def transcript(pane_id):
    rec = next(r for r in records() if r["pane_id"] == pane_id); sid = rec.get("session_id")
    slug = re.sub(r"[^A-Za-z0-9]", "-", rec.get("cwd") or ws)
    p = pathlib.Path.home() / ".claude" / "projects" / slug / f"{sid}.jsonl"
    return p
def inflate(p, mb):
    line = json.dumps({"type": "summary", "summary": "filler " + "x" * 300, "leafUuid": str(uuid.uuid4())}) + "\n"
    chunk = line * 3000; t0 = time.time(); size0 = p.stat().st_size
    with open(p, "a", encoding="utf-8") as f:
        while p.stat().st_size - size0 < mb * 1024 * 1024: f.write(chunk); f.flush()
    say("inflated", p.name, f"{size0/1e6:.1f} MB -> {p.stat().st_size/1e6:.1f} MB in {time.time()-t0:.1f}s")
def busy_turn(name):
    rules([{"match": "LONGTURN", "sleep": 300, "text": "long done"}])
    say("send LONGTURN", json.dumps(ext("cli_send", {"to": f"wn/{name}", "text": "LONGTURN: start the long task"}))[:200])
    for _ in range(40):
        time.sleep(1); s = status(f"wn/{name}")
        if s.get("busy") or s.get("status") in ("running", "busy"): break
    say("status before", s)
    n = _s.token_hex(4); r = ext("cli_send", {"to": f"wn/{name}", "text": f"PING-{n} reply with ok"}); k = r.get("msg_key")
    time.sleep(3); say("queued msg", k, check(k)); return n, k
if phase == "setup":
    h = pathlib.Path.home() / ".claude.json"; d = json.loads(h.read_text()); d["projects"].pop(ws, None); d["projects"][ws.replace("\\", "/")] = {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True}; h.write_text(json.dumps(d))
    os.makedirs(ws, exist_ok=True)
    if main_page(ws) is None:
        mp = next(p for p in pages() if 'window=main' in p['url'])
        print('open', Cdp(mp).ev(f"window.agentTeam.openMainWindow({{workspace_path:{json.dumps(ws)}}}).then(r=>JSON.stringify(r))"), flush=True)
    open_ws(ws); time.sleep(5)
    for nm in ("qa", "qb"):
        r = ext("cli_open_agent", {"agent": "claude", "name": nm, "task": "Reply with the word ready.", "workspace_path": ws}); st[nm] = r.get("pane_id"); say(nm, json.dumps(r)[:200])
        time.sleep(20)
    NT.write_text(json.dumps(st)); say("panes", st)
    for nm in ("qa", "qb"): say(nm, status(f"wn/{nm}"))
elif phase == "intr":
    n, k = busy_turn("qa"); t0 = time.time()
    r = ext("cli_interrupt", {"target": "wn/qa"}); say("cli_interrupt", json.dumps(r)[:300])
    got = None
    for _ in range(60):
        time.sleep(5); c = check(k)
        if c.get("status") != "queued": got = time.time() - t0; break
    hits, first = stub_hits(f"PING-{n}", t0)
    say("RESULT intr", f"status={c} delivered_after_interrupt={got and round(got,1)}s stub_requests_with_ping={hits} first_ping_at=+{first and round(first - t0, 1)}s")
    time.sleep(10); say("status after", status("wn/qa")); RULES.unlink()
elif phase in ("intr2", "ustop2"):
    # stop first, then send: an agent stop (cli_interrupt) must not hold the message (~120 s at most);
    # a person's stop (the pane's Interrupt menu item) must keep it queued for 180 s, never typed
    nm = "qa"; rules([{"match": "LONGTURN", "sleep": 300, "text": "long done"}])
    say("send LONGTURN", json.dumps(ext("cli_send", {"to": f"wn/{nm}", "text": "LONGTURN: start the long task"}))[:160])
    for _ in range(40):
        time.sleep(1); s_ = status(f"wn/{nm}")
        if s_.get("busy"): break
    time.sleep(3); say("status before stop", s_)
    if phase == "intr2":
        say("cli_interrupt", json.dumps(ext("cli_interrupt", {"target": f"wn/{nm}", "workspace_path": ws}))[:200])
    else:
        c = Cdp(main_page(ws)); pid = st[nm]
        js = f"""(async()=>{{const host=document.querySelector('.xterm-host[data-pane-id="{pid}"]'); if(!host) return 'no-host';
          let el=host; let hm=null; while(el && !hm){{ el=el.parentElement; hm=el && el.querySelector('.header-main'); }}
          const hdr=hm.parentElement; const r=hdr.getBoundingClientRect();
          hdr.dispatchEvent(new MouseEvent('contextmenu',{{bubbles:true,cancelable:true,clientX:r.left+20,clientY:r.top+5}}));
          await new Promise(f=>setTimeout(f,400));
          const items=[...document.querySelectorAll('.pane-ctx-item')]; const desc=items.map(i=>i.innerText.trim()+'|'+i.className+'|'+(i.disabled?'dis':''));
          const it=items.find(i=>/^(Interrupt|中斷)/i.test(i.innerText.trim()));
          if(!it) return 'no-item '+JSON.stringify(desc); it.click(); return 'clicked of '+JSON.stringify(desc);}})()"""
        say("stop via the pane's Interrupt menu item:", c.ev(js))
    time.sleep(4); say("status after stop", status(f"wn/{nm}"))
    n = _s.token_hex(4); r = ext("cli_send", {"to": f"wn/{nm}", "text": f"PING-{n} reply with ok"}); k = r.get("msg_key"); t0 = time.time()
    say("sent PING", n, json.dumps(r)[:160])
    limit = 150 if phase == "intr2" else 185
    while time.time() - t0 < limit:
        time.sleep(5); cc = check(k)
        if phase == "intr2" and cc.get("status") != "queued": break
        if round(time.time() - t0) % 30 < 5: say(f"+{round(time.time()-t0)}s", cc, status(f"wn/{nm}"))
    hits, first = stub_hits(f"PING-{n}", t0)
    say("RESULT", phase, f"after {round(time.time()-t0)}s status={cc} stub_requests_with_ping={hits} first={first}")
    if phase == "ustop2": say("cancel", json.dumps(ext("cli_cancel_message", {"msg_key": k}))[:200])
    RULES.unlink(); say("status end", status(f"wn/{nm}"))
elif phase == "gate":
    # a send to a busy pane must stay queued: busy_turn(arg), then watch the queued PING for 20 s, then cancel it
    nm = arg or "qb"; n, k = busy_turn(nm); t0 = time.time()
    for i in range(4):
        time.sleep(5); say(f"+{round(time.time()-t0)}s", check(k), status(f"wn/{nm}"))
    hits, first = stub_hits(f"PING-{n}", t0 - 5)
    say("RESULT gate", nm, check(k), f"stub_requests_with_ping={hits}")
    say("cancel", json.dumps(ext("cli_cancel_message", {"msg_key": k}))[:200]); RULES.unlink(); say("status end", status(f"wn/{nm}"))
elif phase == "ustop":
    n, k = busy_turn("qa"); t0 = time.time()
    c = Cdp(main_page(ws)); pid = st["qa"]
    js = f"""(async()=>{{const host=document.querySelector('.xterm-host[data-pane-id="{pid}"]'); if(!host) return 'no-host';
      let el=host; let hm=null; while(el && !hm){{ el=el.parentElement; hm=el && el.querySelector('.header-main'); }}
      const hdr=hm.parentElement; const r=hdr.getBoundingClientRect();
      hdr.dispatchEvent(new MouseEvent('contextmenu',{{bubbles:true,cancelable:true,clientX:r.left+20,clientY:r.top+5}}));
      await new Promise(f=>setTimeout(f,400));
      const items=[...document.querySelectorAll('.pane-ctx-item')]; const texts=items.map(i=>i.innerText.trim());
      const it=items.find(i=>/^(Interrupt|Stop|中斷|停止)/i.test(i.innerText.trim()) && !i.classList.contains('disabled'));
      if(!it) return 'no-item '+JSON.stringify(texts); it.click(); return 'clicked '+it.innerText.trim()+' of '+JSON.stringify(texts);}})()"""
    say("stop via the pane's Interrupt menu item:", c.ev(js))
    for i in range(36):
        time.sleep(5); cc = check(k)
        if cc.get("status") != "queued": break
        if i % 6 == 5: say(f"+{round(time.time()-t0)}s", cc, status("wn/qa"))
    hits, first = stub_hits(f"PING-{n}", t0)
    say("RESULT ustop", f"after {round(time.time()-t0)}s status={cc} stub_requests_with_ping={hits}")
    say("cancel", json.dumps(ext("cli_cancel_message", {"msg_key": k}))[:200]); RULES.unlink(); say("status end", status("wn/qa"))
elif phase == "msgdelay":
    mb = int(arg or 110); n = _s.token_hex(4)
    rules([{"match": f"SENDMSG-{n}", "sleep": 0, "text": f"sending now\n---MSG-START--- to: qb\nhello-{n} from qa\n---MSG-END---"}])
    inflate(transcript(st["qa"]), mb); off = blog_from(); t0 = time.time()
    say("ask qa", json.dumps(ext("cli_send", {"to": "wn/qa", "text": f"SENDMSG-{n}"}))[:160])
    for _ in range(48):
        time.sleep(5)
        if stub_hits(f"hello-{n}", t0)[0] and time.time() - t0 > 150: break
    time.sleep(30)
    hits, first = stub_hits(f"hello-{n}", t0)
    tot = 0
    for l in open(STUB, encoding="utf-8", errors="replace"):
        try: d = json.loads(l)
        except Exception: continue
        if d.get("at", 0) >= t0: tot = max(tot, sum(1 for m in d["messages"] if m.get("role") == "user" and f"hello-{n}" in json.dumps(m, ensure_ascii=False)))
    say("RESULT msgdelay", f"qb requests that END with the MSG={hits} (first at +{first and round(first - t0, 1)}s) copies in qb's history={tot}")
    for l in blog_gaps(off): say("  log:", l)
    RULES.unlink()
elif phase == "late":
    mb = int(arg or 110); n = _s.token_hex(4); lj = json.loads((ROOT / "lineage.json").read_text())
    bl = json.dumps(B().call("channels.bindings").get("payload") or {}); pid = (re.findall(r'"pane_id":\s*"([0-9a-f-]{36})"', bl) or [lj["cmdr"]])[0]
    say("bound pane", pid[:8]); ws = str(ROOT / "wl")  # the bound commander lives in the lineage workspace
    rules([{"match": f"late test {n}", "sleep": 0, "text": f"late reply {n}"}])
    inflate(transcript(pid), mb); off = blog_from(); t0 = time.time(); say("room says", say_room(f"late test {n}"))
    ok = None
    for _ in range(60):
        time.sleep(5)
        if any(m["at"] > t0 and f"late reply {n}" in (m["body"] or "") for m in bot_out()): ok = time.time() - t0; break
    time.sleep(20); outs = [m for m in bot_out() if m["at"] > t0]
    say("RESULT late", f"reply_in_room_after={ok and round(ok,1)}s bot_messages={[(round(m['at']-t0,1), (m['body'] or '')[:80]) for m in outs]} resend_notice={any('會補送' in (m['body'] or '') for m in outs)}")
    for l in blog_gaps(off): say("  log:", l)
    RULES.unlink()
elif phase == "load":
    k = int(arg or 8); pids = []
    for _ in range(k):
        p = subprocess.Popen([sys.executable, "-c", "while True: pass"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); pids.append(p.pid)
    (ROOT / "load.pids").write_text(" ".join(map(str, pids))); say("busy pids", pids, "load", gload())
    time.sleep(90); say("warmed up, load", gload())
    try:
        for i in range(1, 4):
            o = subprocess.run([sys.executable, "y.py", ROOTP, "go", "sw", "webhook", "done", f"load{i}"], capture_output=True, text=True).stdout
            say(f"load{i}", " | ".join(l for l in o.splitlines() if "ends" in l or "FAIL" in l or "PASS" in l)[:300], "load", gload())
    finally:
        for p in pids: os.kill(p, signal.SIGTERM)
        say("busy pids ended", pids)
    import glob
    for f in sorted(glob.glob(f"{ROOTP}/sw/.agent-team/runs/*/pipeline.log"))[-3:]:
        t = open(f, encoding="utf-8", errors="replace").read()
        say(f.split("/")[-2], "never-submitted=", t.count("never submitted"), "run/agent mismatch=", t.count("run/agent mismatch"), "completed=", "completed all stages" in t)
