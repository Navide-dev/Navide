# Retest driver. usage: y.py <root> <cmd> <ws> [args]
#   setup <ws> | go <ws> <webhook|schedule|mcp> <done|hold> <label> | abort <ws> | panes <ws> | resume <ws> | launches
import sys
ROOTP, cmd, name = sys.argv[1:4]; ARGS = sys.argv[4:]; sys.argv = ["d", ROOTP, "x"]
exec(open(ROOTP + "/drv.py").read().split("PH = {")[0])
PHASE = "retest"
Y = ROOT / "y.json"; ys = json.loads(Y.read_text()) if Y.exists() else {}
ws = str(ROOT / name); NOTOOL = pathlib.Path(str(ROOT / "stub.log") + ".notool")
def run_dirs():
    d = pathlib.Path(ws, ".agent-team/runs")
    return sorted(d.iterdir(), key=lambda p: p.name) if d.exists() else []
def events(L):
    out = []
    for l in (L / "pipeline.log").read_text(errors="replace").splitlines():
        i = l.find("{")
        try: out.append(json.loads(l[i:]))
        except ValueError: pass
    return out
def lines(L): return [(e.get("details") or {}).get("line", "") for e in events(L)]
def outcome(L):
    ev = events(L); names = [e.get("event") for e in ev]; txt = "\n".join(lines(L))
    if "Pipeline completed all stages" in txt or "pipeline_complete" in names: return "completed"
    for e in ev:
        if e.get("event") == "pipeline_abort": return "aborted:" + str(e.get("reason"))
    return "running"
def panes_of(L): return sorted(set(re.findall(r"\[pane (\w{8})\]", "\n".join(lines(L)))) | {str(e.get("pane_id"))[:8] for e in events(L) if e.get("event") == "stage_spawn" and e.get("pane_id")})
def stub_rows(nonce):
    log = ROOT / "stub.log"; rows = []
    if not log.exists(): return rows
    for l in log.read_text(encoding="utf-8", errors="replace").splitlines():
        if nonce in l: rows.append(l)
    return rows
def others(nonce, seen):
    found = set()
    for r in stub_rows(nonce): found |= set(re.findall(r"Y[0-9a-f]{12}", r))
    return sorted((found - {nonce}) & set(seen))
def ui_abort(c):
    CLICK = "(()=>{const e=[...document.querySelectorAll('button.danger')].find(b=>/abort|中止/i.test(b.textContent)&&b.offsetParent);if(e){e.click();return 'clicked '+e.textContent}return ''})()"
    res = c.ev(CLICK)
    if not res:
        for i in range(1, 6):
            c.ev(f"[...document.querySelectorAll('.tab-btn')].filter(x=>!x.textContent.includes('/'))[{i}]?.click()"); time.sleep(0.8); res = c.ev(CLICK)
            if res: break
    time.sleep(1.5); ok = c.ev("(()=>{const e=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Abort Run'&&b.offsetParent);if(e){e.click();return 'yes'}return 'no'})()"); time.sleep(4)
    c.ev("[...document.querySelectorAll('.tab-btn')].filter(x=>!x.textContent.includes('/'))[0]?.click()"); return res, ok
def mcp_call(b, tool, args):
    a = b.call("external_access.set", enabled=True)["payload"]; url = f"http://127.0.0.1:{a['port']}/plan-mcp?client=external&t={a['token']}"
    sid = {}
    def rpc(method, params, notify=False):
        d = {"jsonrpc": "2.0", "method": method, "params": params}
        if not notify: d["id"] = 1 + secrets.randbelow(1 << 20)
        h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", **sid}
        rq = urllib.request.Request(url, json.dumps(d).encode(), h)
        with urllib.request.urlopen(rq, timeout=90) as r:
            if r.headers.get("mcp-session-id"): sid["mcp-session-id"] = r.headers["mcp-session-id"]
            t = r.read().decode("utf-8", "replace")
        for l in t.splitlines():
            if l.startswith("data:"): return json.loads(l[5:])
        return json.loads(t) if t.strip() else {}
    rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "retest", "version": "1"}})
    rpc("notifications/initialized", {}, notify=True)
    out = rpc("tools/call", {"name": tool, "arguments": args}); b.call("external_access.set", enabled=False); return out
def start(b, via, nonce):
    o = ys[name]
    if via == "webhook":
        st = b.call("webhook.status")["payload"]
        return http(st["port"], "POST", "/webhook/" + o["id"], {"Authorization": "Bearer " + o["token"], **J}, json.dumps({"note": nonce}).encode())["status"]
    if via == "schedule":
        j = b.call("scheduler.upsert", job={"name": "yy " + nonce, "enabled": False, "schedule": {"kind": "every", "every_ms": 43200000}, "action": {"kind": "pipeline_start", "workspace": ws, "pipeline_id": o["pid"], "task": "scheduled " + nonce}})
        if not j.get("ok"): return json.dumps(j)[:400]
        jid = j["payload"].get("job", j["payload"]).get("id"); r = b.call("scheduler.run_now", id=jid); return json.dumps(r.get("payload"))[:300]
    if via == "mcp":
        return json.dumps(mcp_call(b, "pipeline_start", {"task": "mcp " + nonce, "pipeline_id": o["pid"], "workspace_path": ws}))[:400]
if cmd == "setup":
    h = pathlib.Path.home() / ".claude.json"; d = json.loads(h.read_text()); d["projects"][ws.replace("\\", "/")] = {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True}; h.write_text(json.dumps(d))
    open_ws(ws); b = B(); wfj = json.loads((ROOT / "wf2.json").read_text()); wfj["name"] = "lin " + name
    r = b.call("pipelines.import_n8n", json=json.dumps(wfj), dry_run=False, default_agent="claude", workspace_path=ws); print("import", r.get("ok"), str(r.get("error"))[:200])
    pid = {p["name"]: p["id"] for p in b.call("pipelines.list")["payload"]["pipelines"]}["lin " + name]
    t = b.call("webhook.trigger.create", name=name, workspace_path=ws, pipeline_id=pid, no_gate_ack=True, per_minute=60, per_day=500)
    e = b.call("webhook.trigger.enable", id=t["payload"]["trigger"]["id"], enabled=True); print("enable", e.get("ok"), e.get("error"))
    ys[name] = {"id": t["payload"]["trigger"]["id"], "token": t["payload"]["token"], "pid": pid, "nonces": []}
elif cmd == "go":
    via, mode, label = ARGS; b = B(); before = {p.name for p in run_dirs()}; n = "Y" + secrets.token_hex(6); seen = list(ys[name]["nonces"]); ys[name]["nonces"].append(n)
    if mode == "done": NOTOOL.touch()
    else: NOTOOL.unlink(missing_ok=True)
    ans = start(b, via, n); reached = stub_has(n, 45)
    new = [p for p in run_dirs() if p.name not in before]; L = new[-1] if new else None
    state_ = "no-run"
    if L:
        end = time.time() + (45 if mode == "done" else 12)
        while time.time() < end:
            state_ = outcome(L)
            if state_ != "running": break
            time.sleep(2)
    old = others(n, seen); panes = panes_of(L) if L else []; prior = ys[name].get("panes", []); ys[name]["panes"] = sorted(set(prior) | set(panes))
    fresh = bool(panes) and not (set(panes) & set(prior)); expect = "completed" if mode == "done" else "running"
    rec(f"{name} {label}: {via} task reached", reached, {"answer": str(ans)[:200], "nonce": n})
    rec(f"{name} {label}: kickoff in a fresh conversation", reached and not old, {"prior_nonces_in_request": old})
    rec(f"{name} {label}: run on a new pane", fresh, {"panes": panes, "prior": prior})
    rec(f"{name} {label}: run ends {expect}", state_ == expect, {"state": state_, "tail": [x[11:90] for x in lines(L)[-3:]] if L else []})
    if L: print("   spawns", [(e.get("stage_id"), str(e.get("pane_id"))[:8]) for e in events(L) if e.get("event") == "stage_spawn"], [x[11:70] for x in lines(L) if "skipped —" in x])
    if not reached or state_ != expect:
        print("\n".join(x[11:110] for x in lines(L)) if L else "no run dir")
elif cmd == "abort":
    print(ui_abort(Cdp(main_page(ws))))
elif cmd == "panes":
    c = Cdp(main_page(ws)); print(c.ev("[...document.querySelectorAll('.tab-btn')].filter(x=>x.textContent.trim()).map(x=>(x.classList.contains('active')?'*':'')+x.textContent.trim().slice(0,22)).join(' | ')"))
    L = run_dirs(); print([ (p.name[:15], outcome(p)) for p in L])
elif cmd == "resume":
    b = B(); print(json.dumps(mcp_call(b, "pipeline_resume", {"workspace_path": ws}))[:600])
elif cmd == "type":
    c = Cdp(main_page(ws)); c.call("Page.enable"); c.call("Page.bringToFront"); time.sleep(.5); c.ev("document.querySelector('.xterm-helper-textarea')?.focus()"); c.call("Input.insertText", text=ARGS[0]); time.sleep(.5)
    for t in ("rawKeyDown", "keyUp"): c.call("Input.dispatchKeyEvent", type=t, key="Enter", code="Enter", windowsVirtualKeyCode=13, **({"text": "\r"} if t == "rawKeyDown" else {}))
elif cmd == "rebuild":
    c = Cdp(main_page(ws)); print(c.ev("(()=>{const e=[...document.querySelectorAll('.rebuild-btn,.agent-rebuild-btn')].filter(b=>b.offsetParent)[0];if(e){e.click();return 'clicked'}return 'none'})()")); time.sleep(2)
    print("dialog:", c.ev("[...document.querySelectorAll('[role=dialog] button,.modal button,.confirm-dialog button')].filter(b=>b.offsetParent).map(b=>b.textContent.trim()).join(' | ')"))
elif cmd == "adopt":
    s_ = state; ys["wa"] = {"id": s_["tid"], "token": s_["token"], "pid": s_["ids"]["real claude a"], "nonces": []}
elif cmd == "unattended":
    b = B(); r = b.call("webhook.trigger.set_unattended", id=ys[name]["id"], unattended=ARGS[0] == "on"); print(json.dumps(r)[:220])
elif cmd == "dismiss":
    c = Cdp(main_page(ws)); print(c.ev("(()=>{const e=[...document.querySelectorAll('button')].find(b=>/Awesome/.test(b.textContent)&&b.offsetParent);if(e){e.click();return 'yes'}return 'no'})()"))
elif cmd == "launches":
    L = pathlib.Path(state.get("data_dir") or B().dir) / "logs" / "backend.log"; rows = [l for l in L.read_text(encoding="utf-8", errors="replace").splitlines() if "terminal session created" in l and "claude" in l]
    for l in rows[-int(ARGS[0]):]:
        m = re.search(r"pane=(\w{8}).*cmd=(.*)", l); c = m.group(2); print(m.group(1), "BYPASS" if "dangerously" in c else "default" if "default" in c else "?", "resume" if "--resume" in c else "new", (re.search(r"[0-9a-f]{8}-[0-9a-f]{4}", c) or [""])[0])
elif cmd == "cards":
    c = Cdp(main_page(ws)); seen_ = {}; c.call("Page.enable"); c.call("Page.bringToFront"); c.ev("window.dispatchEvent(new Event('focus'))"); time.sleep(.6)
    n = c.ev("document.querySelectorAll('.expand-caret').length")
    for i in range(int(n or 0)):
        t = c.ev(f"(()=>{{const e=document.querySelectorAll('.expand-caret')[{i}];const x=e&&e.closest('.agent-cmd')?null:e&&e.parentElement;const o=document.querySelector('.agent-cmd code');if(x&&(!o||!x.closest('.agent-card,.agent-item,.agent-row')||true))x.click();return 1}})()"); time.sleep(.5)
        for v in json.loads(c.ev("JSON.stringify([...document.querySelectorAll('.agent-cmd code')].map(e=>e.textContent.trim()))")): seen_[v] = 1
    for v in seen_:
        sid = (re.search(r"[0-9a-f]{8}-[0-9a-f]{4}", v) or [""])[0]; print("CARD", sid, "BYPASS" if "dangerously" in v else "default" if "permission-mode default" in v else "?", "resume" if "--resume" in v else "new", "|", v[:90])
elif cmd == "reload":
    c = Cdp(main_page(ws)); c.call("Page.enable"); c.call("Page.reload"); time.sleep(int(ARGS[0]) if ARGS else 15); print("reloaded")
elif cmd == "click":
    c = Cdp(main_page(ws)); print(c.ev("(()=>{const e=[...document.querySelectorAll('button')].filter(b=>b.offsetParent&&b.textContent.trim()==="+json.dumps(ARGS[0])+")[0];if(e){e.click();return 'clicked'}return 'none'})()"))
elif cmd == "setup2":
    h = pathlib.Path.home() / ".claude.json"; d = json.loads(h.read_text()); d["projects"][ws.replace("\\", "/")] = {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True}; h.write_text(json.dumps(d))
    os.makedirs(ws, exist_ok=True); c = Cdp(next(p for p in pages() if "window=main" in p["url"])); print("open", c.ev(f"window.agentTeam.openMainWindow({{workspace_path:{json.dumps(ws)}}}).then(r=>JSON.stringify(r))")); time.sleep(10); open_ws(ws); b = B(); wfj = json.loads((ROOT / "wf2.json").read_text()); wfj["name"] = "plain " + name
    r = b.call("pipelines.import_n8n", json=json.dumps(wfj), dry_run=False, default_agent="claude", workspace_path=ws); print("import", r.get("ok"), str(r.get("error"))[:200])
    pid = {p["name"]: p["id"] for p in b.call("pipelines.list")["payload"]["pipelines"]}["plain " + name]; ys[name] = {"id": "", "token": "", "pid": pid, "nonces": []}
elif cmd == "setup3":  # two-stage webhook pipeline in a window opened by openMainWindow (duplicate=1)
    h = pathlib.Path.home() / ".claude.json"; d = json.loads(h.read_text()); d["projects"][ws.replace("\\", "/")] = {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True}; h.write_text(json.dumps(d))
    os.makedirs(ws, exist_ok=True)
    if main_page(ws) is None: print("open", Cdp(next(p for p in pages() if "window=main" in p["url"])).ev(f"window.agentTeam.openMainWindow({{workspace_path:{json.dumps(ws)}}}).then(r=>JSON.stringify(r))")); time.sleep(10)
    open_ws(ws); b = B(); wfj = json.loads((ROOT / "wf.json").read_text()); wfj["name"] = "two " + name
    r = b.call("pipelines.import_n8n", json=json.dumps(wfj), dry_run=False, default_agent="claude", workspace_path=ws); print("import", r.get("ok"), str(r.get("error"))[:200])
    pid = {p["name"]: p["id"] for p in b.call("pipelines.list")["payload"]["pipelines"]}["two " + name]
    t = b.call("webhook.trigger.create", name=name, workspace_path=ws, pipeline_id=pid, no_gate_ack=True, per_minute=60, per_day=500)
    e = b.call("webhook.trigger.enable", id=t["payload"]["trigger"]["id"], enabled=True); print("enable", e.get("ok"), e.get("error"))
    ys[name] = {"id": t["payload"]["trigger"]["id"], "token": t["payload"]["token"], "pid": pid, "nonces": []}
elif cmd == "setupm":  # one Manager stage (mgr commander + wk worker) behind a webhook, in a duplicate window
    h = pathlib.Path.home() / ".claude.json"; d = json.loads(h.read_text()); d["projects"][ws.replace("\\", "/")] = {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True}; h.write_text(json.dumps(d))
    os.makedirs(ws, exist_ok=True)
    if main_page(ws) is None: print("open", Cdp(next(p for p in pages() if "window=main" in p["url"])).ev(f"window.agentTeam.openMainWindow({{workspace_path:{json.dumps(ws)}}}).then(r=>JSON.stringify(r))")); time.sleep(10)
    open_ws(ws); b = B()
    def tx(r): return json.loads(r["result"]["content"][0]["text"])
    p = tx(mcp_call(b, "pipeline_define", {"op": "create", "name": "mgr " + name, "workspace_path": ws})); pid = p["pipeline"]["id"]; print("create", p.get("ok"), pid)
    role = ARGS[0] if ARGS else "developer"; role_wk = ARGS[1] if len(ARGS) > 1 else role
    st = {"id": "m1", "title": "Managed", "short_title": "M1", "slots": [
        {"agent_key": "claude", "role_key": role, "label": "mgr", "kickoff_body": "ROLEMGR coordinate the worker.", "is_commander": True},
        {"agent_key": os.environ.get("WK_AGENT", "claude"), "role_key": role_wk, "label": "wk", "kickoff_body": "ROLEWK do the work and report.", "is_commander": False}]}
    s = tx(mcp_call(b, "stage_define", {"op": "upsert", "pipeline_id": pid, "stage": st, "workspace_path": ws})); print("stage", s.get("ok"), s.get("error"), [(x.get("label"), x.get("is_commander")) for x in (s.get("stage") or {}).get("slots", [])])
    t = b.call("webhook.trigger.create", name=name, workspace_path=ws, pipeline_id=pid, no_gate_ack=True, per_minute=60, per_day=500)
    e = b.call("webhook.trigger.enable", id=t["payload"]["trigger"]["id"], enabled=True); print("enable", e.get("ok"), e.get("error"))
    ys[name] = {"id": t["payload"]["trigger"]["id"], "token": t["payload"]["token"], "pid": pid, "nonces": []}
elif cmd == "spawns":
    L = run_dirs()[-1]; print(L.name, outcome(L), [(e.get("stage_id"), e.get("slot") or e.get("label") or (e.get("details") or {}).get("label"), str(e.get("pane_id"))[:8]) for e in events(L) if e.get("event") == "stage_spawn"])
elif cmd == "key":  # key <ws> <pane8> <Enter|Escape|text:...>  — what a user does at the pane's keyboard
    c = Cdp(main_page(ws)); c.call("Page.enable"); c.call("Page.bringToFront"); c.ev("window.dispatchEvent(new Event('focus'))"); time.sleep(.5)
    print("focus", c.ev(f"(()=>{{const r=[...document.querySelectorAll('[data-pane-id^=\"{ARGS[0]}\"]')];const t=r.map(e=>e.querySelector('.xterm-helper-textarea')).find(Boolean);if(!t)return 'no-pane '+r.length;t.focus();return 'ok '+r.length}})()"))
    k = ARGS[1]
    if k.startswith("text:"): c.call("Input.insertText", text=k[5:])
    else:
        vk = {"Enter": 13, "Escape": 27}[k]
        for t in ("rawKeyDown", "keyUp"): c.call("Input.dispatchKeyEvent", type=t, key=k, code=k, windowsVirtualKeyCode=vk, **({"text": "\r"} if t == "rawKeyDown" and k == "Enter" else {}))
    print("sent", k, time.strftime("%H:%M:%S"))
elif cmd == "pstat":
    r = mcp_call(B(), "pipeline_status", {"workspace_path": ws}); t = r["result"]["content"][0]["text"]
    try: j = json.loads(t); print("STATUS", j.get("state"), j.get("active"), str(j.get("current_stage") or j.get("stage") or "")[:60], str(j.get("error") or j.get("message") or "")[:120])
    except ValueError: print("STATUS-TEXT", t[:200])
elif cmd == "ptext":  # what the pipeline panel says right now
    c = Cdp(main_page(ws)); txt = c.ev("document.body.innerText") or ""
    hits = [l.strip() for l in txt.splitlines() if re.search(r"RUNNING|INTERRUPTED|Interrupted|IDLE|Idle|PAUSED|Paused|waiting on a CLI prompt|Resume|Abort|Stage \d|awaiting", l)]
    print("PANEL", " || ".join(dict.fromkeys(h[:80] for h in hits))[:900])
elif cmd == "goinj":  # webhook whose body carries router markers: goinj <ws> <body text>
    b = B(); n = "Y" + secrets.token_hex(6); ys[name]["nonces"].append(n); NOTOOL.touch(); o = ys[name]
    st = b.call("webhook.status")["payload"]
    txt = ARGS[0]
    if txt.startswith("@"): txt = open(txt[1:], encoding="utf-8").read()  # body from a file keeps invisible characters intact
    r = http(st["port"], "POST", "/webhook/" + o["id"], {"Authorization": "Bearer " + o["token"], **J}, json.dumps({"note": n, "text": txt}, ensure_ascii=False).encode("utf-8"))["status"]
    print("nonce", n, "answer", r, "reached", stub_has(n, 45))
elif cmd == "screen":  # screen <ws> <pane8> [n]: the pane's last n visible rows (xterm DOM)
    c = Cdp(main_page(ws)); k = int(ARGS[1]) if len(ARGS) > 1 else 12
    t = c.ev(f"(()=>{{const r=document.querySelector('[data-pane-id^=\"{ARGS[0]}\"] .xterm-rows');return r?r.innerText:'no-rows'}})()") or ""
    rows = [l.rstrip() for l in t.split("\n")]
    while rows and not rows[-1]: rows.pop()
    print("\n".join("| " + l for l in rows[-k:]))
elif cmd == "ctrlu":  # ctrlu <ws> <pane8> <multi|long|paste>: fill the input box one of three ways, press Ctrl-U, show the box before and after
    c = Cdp(main_page(ws)); c.call("Page.enable"); c.call("Page.bringToFront"); c.ev("window.dispatchEvent(new Event('focus'))"); time.sleep(.5)
    c.ev(f"[...document.querySelectorAll('[data-pane-id^=\"{ARGS[0]}\"]')].map(e=>e.querySelector('.xterm-helper-textarea')).find(Boolean)?.focus()")
    kind = ARGS[1]
    if kind == "multi": text = "\n".join(f"line {i} of a multi-line draft" for i in range(1, 6))
    elif kind == "long": text = "long-line " + "x" * 900
    else: text = "\n".join(f"pasted row {i:03d} " + "y" * 60 for i in range(1, 121))
    c.call("Input.insertText", text=text); time.sleep(2.5)
    def box():
        t = c.ev(f"(()=>{{const r=document.querySelector('[data-pane-id^=\"{ARGS[0]}\"] .xterm-rows');return r?r.innerText:''}})()") or ""
        rows = [l.rstrip() for l in t.split("\n")]
        while rows and not rows[-1]: rows.pop()
        return rows[-10:]
    before = box()
    for t in ("rawKeyDown", "keyUp"): c.call("Input.dispatchKeyEvent", type=t, key="u", code="KeyU", modifiers=2, windowsVirtualKeyCode=85, **({"text": "\x15"} if t == "rawKeyDown" else {}))
    time.sleep(2)
    after = box()
    marks = ("line 1 of a multi", "line 5 of a multi", "long-line xxx", "Pasted text", "pasted row")
    print("BEFORE", kind, [l[:70] for l in before]); print("AFTER ", kind, [l[:70] for l in after])
    print("LEFT", kind, [m for m in marks if any(m in l for l in after)])
elif cmd == "cardabort":  # the Abort an interrupted run's resume card offers (0.2.37 3d238c498)
    c = Cdp(main_page(ws)); c.call("Page.enable"); c.call("Page.bringToFront"); time.sleep(.5)
    q = "(()=>{const card=document.querySelector('.resume-card');if(!card)return 'no-card';const b=[...card.querySelectorAll('button')].find(x=>x.textContent.trim()==='Abort'&&x.offsetParent);if(!b)return 'no-abort: '+[...card.querySelectorAll('button')].map(x=>x.textContent.trim()).join('|');b.click();return 'clicked'})()"
    r = c.ev(q)
    if r == "no-card":
        for i in range(0, 6):
            c.ev(f"[...document.querySelectorAll('.tab-btn,.sidebar-tab,[role=tab]')].filter(x=>/pipeline|流程/i.test(x.textContent+(x.title||'')))[{i}]?.click()"); time.sleep(.8); r = c.ev(q)
            if r != "no-card": break
    print("cardabort", r); time.sleep(1.5)
    print("confirm", c.ev("(()=>{const e=[...document.querySelectorAll('button')].find(b=>/^(Abort Run|Abort)$/.test(b.textContent.trim())&&b.offsetParent&&b.closest('[role=dialog],.modal,.confirm-dialog'));if(e){e.click();return 'yes'}return 'no'})()")); time.sleep(3)
elif cmd == "dupurl":
    print([p["url"][-90:] for p in pages()])
elif cmd == "wruns":
    import sqlite3; db = sqlite3.connect(f"file:{pathlib.Path(state.get('data_dir') or B().dir) / 'navide.db'}?mode=ro", uri=True)
    for r in db.execute("SELECT id, state, workspace, started_at FROM webhook_runs ORDER BY started_at"): print(r[0][:10], r[1], pathlib.Path(r[2]).name, time.strftime('%H:%M:%S', time.localtime(r[3])))
elif cmd == "hook":  # count done/attention sounds: same gate (turnCompleteDone) as the done notification
    c = Cdp(main_page(ws)); print(c.ev("(()=>{window.__snd=[];const o=AudioContext.prototype.createOscillator;AudioContext.prototype.createOscillator=function(){window.__snd.push(new Date().toISOString().slice(11,19));return o.call(this)};return 'hooked'})()"))
elif cmd == "hookread":
    c = Cdp(main_page(ws)); print("sounds", c.ev("JSON.stringify(window.__snd||null)"))
elif cmd == "toasts":
    c = Cdp(main_page(ws)); print(c.ev("[...document.querySelectorAll('.toast,.notification,[role=status],[role=alert]')].map(e=>e.textContent.trim().slice(0,120)).filter(Boolean).join(' || ')"))
elif cmd == "fire":
    b = B(); n = "Y" + secrets.token_hex(6); ys[name]["nonces"].append(n); print("nonce", n, str(start(b, ARGS[0], n))[:520]); print("reached", stub_has(n, 45))
elif cmd == "wins":
    print([(p.get("title"), p.get("url")[-60:]) for p in pages()])
elif cmd == "mcp":
    b = B(); print(json.dumps(mcp_call(b, ARGS[0], {"workspace_path": ws, **(json.loads(ARGS[1]) if len(ARGS) > 1 else {})}))[:500])
elif cmd == "pid":
    b = B(); ps = {p["name"]: p["id"] for p in b.call("pipelines.list")["payload"]["pipelines"]}; print(list(ps)); ys.setdefault(name, {"id": "", "token": "", "nonces": []})["pid"] = ps[ARGS[0]]
elif cmd == "btns":
    c = Cdp(main_page(ws)); print(c.ev("[...document.querySelectorAll('button')].filter(b=>b.offsetParent).map(b=>(b.className||'').slice(0,30)+'|'+(b.title||b.getAttribute('aria-label')||'')+'|'+b.textContent.trim().slice(0,14)).join(' ;; ')"))
elif cmd == "shot":
    c = Cdp(main_page(ws)); c.call("Page.enable"); c.call("Page.bringToFront"); c.ev("window.dispatchEvent(new Event('focus'))"); time.sleep(.8); r = c.call("Page.captureScreenshot", format="png"); (SHOTS / (ARGS[0] + ".png")).write_bytes(base64.b64decode(r["data"]))
Y.write_text(json.dumps(ys)); print("fails", fails)
