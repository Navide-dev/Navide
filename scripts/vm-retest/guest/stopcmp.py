# stopcmp.py <root> <step> [arg]: pane qa (window "wn") stopped two ways in two CLI states, crossed over:
#   fresh      open pane $PANE (default qa) as a new Claude pane in "wn" and record its id (every step uses $PANE)
#   prep bg    the stopuser state: a background Bash (sleep 45) and the stub holding the tool-result request (tailsleep)
#   prep long  the stopagent state: a LONGTURN the stub answers after 300 s
#   coords header|item   screen coordinates of qa's header (to right-click) or of its open menu's "Interrupt" item, for a
#              real VNC click from the host (window.screenX/Y + the window frame + the element's rect)
#   cli_int    cli_interrupt on qa
#   observe <label>   15 s later and then every 5 s for 60 s: busy / ui.status; at 15 s the last 30 xterm lines (CDP),
#              "Interrupted" and "Press Ctrl-C again" in them, cli_read_log's tail, "[Request interrupted by user]" in qa's
#              newest transcript since prep, and backend.log lines with "interrupt" since prep
import glob, json, os, pathlib, sys, time
ROOTP, MYSTEP = sys.argv[1], sys.argv[2]; MYARG = sys.argv[3] if len(sys.argv) > 3 else ""
sys.argv = [sys.argv[0], ROOTP, "stopagent"]
exec(open(ROOTP + "/n238.py", encoding="utf-8").read().split('\nif phase == "stopagent":')[0])
STEP, ARG = MYSTEP, MYARG  # n238.py sets its own ARG
nm = os.environ.get("PANE", "qa"); MARK = ROOT / f"stopcmp.mark.{nm}.json"
if STEP == "fresh":  # a new Claude pane in "wn", so earlier long turns cannot leak into this run
    r = ext("cli_open_agent", {"agent": "claude", "name": nm, "task": "reply with the word ready.", "workspace_path": ws}); say("fresh", json.dumps(r)[:200])
    st[nm] = r["pane_id"]; NT.write_text(json.dumps(st)); time.sleep(20); say("fresh status", ui(nm)); sys.exit(0)
pid = st[nm]
def js(x): return Cdp(main_page(ws)).ev(x)
def transcripts(): return sorted(glob.glob(str(pathlib.Path.home() / ".claude/projects/*wn*/*.jsonl")), key=os.path.getmtime)
if STEP == "prep":
    if ARG == "bg":
        n = _s.token_hex(4); rules([{"match": f"BGTURN-{n}", "sleep": 0, "text": "", "bg": "sleep 45; echo bg-done"}])
        (ROOT / "stub.log.tailsleep").write_text("300"); text = f"BGTURN-{n} run it in the background"
    else:
        rules([{"match": "LONGTURN", "sleep": 300, "text": "long done"}]); text = "LONGTURN-x: start the long task"
    t = transcripts(); MARK.write_text(json.dumps({"blog": BLOG.stat().st_size, "tr": t[-1] if t else "",
        "trsize": os.path.getsize(t[-1]) if t else 0, "t": time.time()}))
    for _ in range(60):  # the kickoff turn (and its Stop hook) must be over before the test turn goes in
        if not ui(nm).get("busy"): break
        time.sleep(2)
    time.sleep(10); t1 = time.time(); word = "BGTURN" if ARG == "bg" else "LONGTURN"
    say("prep", ARG, json.dumps(ext("cli_send", {"to": f"wn/{nm}", "text": text}))[:160]); say("busy", wait_busy(nm))
    for _ in range(40):  # stop only once the stub has the test turn's request
        if stub_hits(word, t1)[0]: break
        time.sleep(1)
    say("stub has", word, stub_hits(word, t1)); time.sleep(5)
    say("before stop", ui(nm)); print("READY")
elif STEP == "coords":
    sel = ("(()=>{let el=document.querySelector('.xterm-host[data-pane-id=\"%s\"]'),hm=null;while(el&&!hm){el=el.parentElement;hm=el&&el.querySelector('.header-main');}"
           "const r=hm.parentElement.getBoundingClientRect();return [r.left+20,r.top+5];})()" % pid) if ARG == "header" else \
          ("(()=>{const it=[...document.querySelectorAll('.pane-ctx-item')].find(i=>/^Interrupt$/i.test(i.innerText.trim().split('\\n')[0]));"
           "if(!it) return null; const r=it.getBoundingClientRect(); return [r.left+r.width/2,r.top+r.height/2, it.disabled||it.classList.contains('disabled')];})()")
    p = js(sel); f = js("[window.screenX, window.screenY, window.outerWidth-window.innerWidth, window.outerHeight-window.innerHeight]")
    if p is None: print("COORDS none"); sys.exit(0)
    x = int(f[0] + f[2] / 2 + p[0]); y = int(f[1] + f[3] - f[2] / 2 + p[1])
    print("COORDS", x, y, "frame", f, "elem", p)
elif STEP == "cli_int":
    say("cli_interrupt", json.dumps(ext("cli_interrupt", {"target": f"wn/{nm}", "workspace_path": ws}), ensure_ascii=False)[:300])
elif STEP == "observe":
    m = json.loads(MARK.read_text()); t0 = time.time(); time.sleep(15)
    tail = js("(()=>{const h=document.querySelector('.xterm-host[data-pane-id=\"%s\"]');if(!h)return'';"
              "return [...h.querySelectorAll('.xterm-rows > div')].map(d=>d.textContent.replace(/\\s+$/,'')).filter(r=>r).slice(-30).join('\\n');})()" % pid) or ""
    say(f"[{ARG}] xterm last 30 lines:\n{tail}")
    say(f"[{ARG}] Interrupted shown:", "Interrupted" in tail, "| Press Ctrl-C again shown:", "Ctrl-C again" in tail or "Ctrl+C again" in tail)
    lg = json.dumps(ext("cli_read_log", {"target": f"wn/{nm}", "workspace_path": ws, "lines": 15}), ensure_ascii=False)
    say(f"[{ARG}] cli_read_log has Interrupted:", "Interrupted" in lg, "| tail:", lg[-600:])
    tr = m["tr"]; new = ""
    if tr and os.path.exists(tr): new = open(tr, encoding="utf-8", errors="replace").read()[m["trsize"]:]
    for t in transcripts():
        if os.path.getmtime(t) >= m["t"] and t != tr: new += open(t, encoding="utf-8", errors="replace").read()
    say(f"[{ARG}] transcript [Request interrupted by user]:", new.count("[Request interrupted by user"))
    bl = [l for l in BLOG.read_text(errors="replace")[m["blog"]:].splitlines() if "interrupt" in l.lower()]
    say(f"[{ARG}] backend.log interrupt lines:", bl[-6:] or "none")
    while time.time() - t0 < 75:
        say(f"[{ARG}] +{round(time.time() - t0)}s", ui(nm)); time.sleep(5)
    RULES.unlink(missing_ok=True); (ROOT / "stub.log.tailsleep").unlink(missing_ok=True)
