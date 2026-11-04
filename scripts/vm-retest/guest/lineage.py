# lineage.py <root> <ws> <phase> [label]: a channel wake hands a commander's children to the pane it opens.
# Simulated: no real chat service. fakematrix.py (127.0.0.1 only, fake token) plays the Matrix homeserver;
# Navide's real Matrix channel adapter talks to it, so the wake goes through the production path.
#   setup : open the workspace window, start fakematrix (pid in fm.pid), configure the Matrix channel, open a
#           commander pane (cli_open_agent), open 2 children AS the commander (its own pane MCP URL), pair the
#           test sender, bind the commander to the room, send one message so the binding learns the wake target
#   state : backend records (spawn_status, spawned_by, session) + the window's pane tree text + bot replies
#   wake  : the test sender types /wake; wait for the bot's outcome; then state
#   stop  : end fakematrix by its recorded pid
import glob, json, os, re, signal, sqlite3, subprocess, sys, time, urllib.request
ROOTP, name, phase = sys.argv[1:4]; label = sys.argv[4] if len(sys.argv) > 4 else phase; sys.argv = ["d", ROOTP, "x"]
exec(open(ROOTP + "/drv.py").read().split("PH = {")[0])
ws = str(ROOT / name); PORT = 48771; FM = f"http://127.0.0.1:{PORT}"; SF = ROOT / "lineage.json"
st_ = json.loads(SF.read_text()) if SF.exists() else {}
def say(*a): print(time.strftime("%H:%M:%S"), *a, flush=True)
def http(method, url, body=None):
    rq = urllib.request.Request(url, json.dumps(body).encode() if body is not None else None, {"Content-Type": "application/json"}, method=method)
    with urllib.request.urlopen(rq, timeout=30) as r: return json.loads(r.read() or b"null")
def mcp(url, tool, args):
    sid = {}
    def rpc(method, params, notify=False):
        d = {"jsonrpc": "2.0", "method": method, "params": params}
        if not notify: d["id"] = 1 + secrets.randbelow(1 << 20)
        rq = urllib.request.Request(url, json.dumps(d).encode(), {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", **sid})
        with urllib.request.urlopen(rq, timeout=120) as r:
            if r.headers.get("mcp-session-id"): sid["mcp-session-id"] = r.headers["mcp-session-id"]
            t = r.read().decode("utf-8", "replace")
        for l in t.splitlines():
            if l.startswith("data:"): return json.loads(l[5:])
        return json.loads(t) if t.strip() else {}
    rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lineage", "version": "1"}})
    rpc("notifications/initialized", {}, notify=True)
    out = rpc("tools/call", {"name": tool, "arguments": args})
    try: return json.loads(out["result"]["content"][0]["text"])
    except Exception: return out
def external(b, tool, args):
    a = b.call("external_access.set", enabled=True)["payload"]
    try: return mcp(f"http://127.0.0.1:{a['port']}/plan-mcp?client=external&t={a['token']}", tool, args)
    finally: b.call("external_access.set", enabled=False)
def pane_url(pane_id):
    base = data_dir() / "plan-mcp-panes"
    for f in sorted(base.glob("*.json"), key=lambda p: -p.stat().st_mtime):
        u = json.loads(f.read_text())["mcpServers"]["navide"]["url"]
        if f"pane={pane_id}" in u: return u
    return None
def records():
    db = sqlite3.connect(f"file:{ws}/.agent-team/navide.db?mode=ro", uri=True)
    row = db.execute("select value from kv where key='project'").fetchone(); db.close()
    return json.loads(row[0]).get("panes", []) if row else []
def say_room(text): return http("POST", FM + "/_test/say", {"body": text})
def bot_out(): return http("GET", FM + "/_test/out")
def tree():
    mp = main_page(ws)
    if mp is None: return 'no window for this workspace'
    c = Cdp(mp)
    return c.ev("(()=>{const s=document.querySelector('.sidebar, aside, [class*=sidebar]');return s?s.innerText.slice(0,1500):'no-sidebar'})()")
def state():
    recs = records(); ids = {r["pane_id"]: r for r in recs}
    say("RECORDS")
    for r in recs:
        if r.get("agent") != "claude": continue
        nm = r.get("custom_name") or r.get("auto_name") or ""
        par = r.get("spawned_by") or ""
        say(f"  {r['pane_id'][:8]} name={nm!r} status={r.get('spawn_status')} session={(r.get('session_id') or '')[:8]} "
            f"spawned_by={par[:8] or '(root)'}{' [parent removed]' if par and ids.get(par, {}).get('spawn_status') == 'removed' else ''}")
    say("TREE", json.dumps(tree())[:900])
    say("BOT", json.dumps([(round(m["at"] % 1000, 1), (m["body"] or "")[:90]) for m in bot_out()][-6:], ensure_ascii=False))
    b = B(); bl = b.call("channels.bindings").get("payload") or {}
    say("BINDINGS", json.dumps(bl, ensure_ascii=False)[:500])
if phase == "setup":
    h = pathlib.Path.home() / ".claude.json"; d = json.loads(h.read_text()); d["projects"][ws.replace("\\", "/")] = {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True}; h.write_text(json.dumps(d))
    if main_page(ws) is None:
        mp = next(p for p in pages() if 'window=main' in p['url'])
        print('open', Cdp(mp).ev(f"window.agentTeam.openMainWindow({{workspace_path:{json.dumps(ws)}}}).then(r=>JSON.stringify(r))"), flush=True)
    open_ws(ws)
    kw = {"start_new_session": True} if os.name != "nt" else {"creationflags": 0x00000008 | 0x00000200}
    p = subprocess.Popen([sys.executable, str(ROOT / "fakematrix.py"), str(PORT)], stdin=subprocess.DEVNULL, stdout=open(ROOT / "fm.out", "w"), stderr=subprocess.STDOUT, **kw)
    (ROOT / "fm.pid").write_text(str(p.pid)); time.sleep(1.5); say("fakematrix pid", p.pid, "whoami", http("GET", FM + "/_matrix/client/v3/account/whoami"))
    b = B()
    say("global", b.call("channels.set_global_enabled", enabled=True).get("payload"))
    # fake token, built by concatenation; no real account exists anywhere
    say("configure", json.dumps(b.call("channels.configure", platform="matrix", config={"homeserver": FM}, secret={"access_token": "fake-" + "matrix-" + "test"}).get("payload"))[:300])
    for _ in range(30):
        lst = b.call("channels.list").get("payload") or {}; txt = json.dumps(lst)
        if '"connected"' in txt or '"ready"' in txt or "@navide-bot:local" in txt: break
        time.sleep(1)
    say("channels.list", txt[:400])
    r = external(b, "cli_open_agent", {"agent": "claude", "name": "cmdr", "task": "Reply with the word ready.", "workspace_path": ws})
    cmdr = r.get("pane_id"); say("cmdr", json.dumps(r)[:300]); time.sleep(25)
    url = pane_url(cmdr); say("cmdr pane mcp url found:", bool(url))
    kids = []
    for k in ("kid1", "kid2"):
        rr = mcp(url, "cli_open_agent", {"agent": "claude", "name": k, "task": "Reply with the word ok."}); kids.append(rr.get("pane_id")); say(k, json.dumps(rr)[:250])
    time.sleep(25)
    say_room("hi"); time.sleep(6); out = bot_out(); say("pairing reply", json.dumps(out[-2:], ensure_ascii=False)[:400])
    pl = b.call("channels.pairing.list", platform="matrix").get("payload") or {}; say("pairing.list", json.dumps(pl)[:300])
    code = (re.findall(r'"code":\s*"([^"]+)"', json.dumps(pl)) or [""])[0]
    if code: say("approve", json.dumps(b.call("channels.pairing.approve", platform="matrix", code=code).get("payload"))[:200])
    say("bind", json.dumps(b.call("channels.bind", pane_id=cmdr, pane_name="cmdr", platform="matrix", mode="existing", chat_id="!dm:local").get("payload"))[:300])
    time.sleep(2); say_room("hello from the test room"); time.sleep(20)
    SF.write_text(json.dumps({"cmdr": cmdr, "kids": kids})); state()
elif phase == "setup2":
    st = json.loads(SF.read_text()) if SF.exists() else {}
    cmdr = st["cmdr"]
    code = ""
    for m in reversed(bot_out()):
        f = re.findall(r"\b([A-Z0-9]{4}-[A-Z0-9]{4})\b", m["body"] or "")
        if f: code = f[0]; break
    say("pairing code from the bot reply:", code)
    say("approve", json.dumps(B().call("channels.pairing.approve", platform="matrix", code=code).get("payload"))[:200])
    say("bind", json.dumps(B().call("channels.bind", pane_id=cmdr, pane_name="cmdr", platform="matrix", mode="existing", chat_id="!dm:local").get("payload"))[:300])
    time.sleep(2); say_room("hello from the test room"); time.sleep(25); state()
elif phase == "wake":
    t0 = time.time(); say("WAKE", label, say_room("/wake"))
    for _ in range(60):
        time.sleep(2)
        if any(m["at"] > t0 and re.search(r"(?i)awake|woke|online|back|fail|could not|refus|喚醒|已|失敗", m["body"] or "") for m in bot_out()): break
    time.sleep(8); state()
elif phase == "reopen":
    # close every window of this workspace, then open it again through openMainWindow (a duplicate=1 window,
    # whose held list starts empty, so its first load restores none of the workspace's records)
    import urllib.parse
    enc = urllib.parse.quote(ws, safe="")
    for p in pages():
        if p.get("type") == "page" and ("workspace_path=" + enc) in p["url"]:
            say("closing", p["url"][-90:], Cdp(p).ev("window.close(),'closed'"))
    time.sleep(5)
    say("still open:", [p["url"][-60:] for p in pages() if ("workspace_path=" + enc) in p["url"]])
    mp = next(p for p in pages() if "window=main" in p["url"])
    say("open", Cdp(mp).ev(f"window.agentTeam.openMainWindow({{workspace_path:{json.dumps(ws)}}}).then(r=>JSON.stringify(r))"))
    time.sleep(20)
    say("now open:", [p["url"][-90:] for p in pages() if ("workspace_path=" + enc) in p["url"]])
    state()
elif phase == "heldkids":
    # Option A (manual precondition): the window holds the two children but not the commander
    kids = [r for r in records() if (r.get("custom_name") or "") in ("kid1", "kid2") and r.get("spawn_status") == "spawned"]
    keys = [k for r in kids for k in (r["pane_id"], (r.get("session_id") or "").strip()) if k]
    c = Cdp(main_page(ws))
    say("set held list (manual):", c.ev(f"sessionStorage.setItem('agentTeam.heldPanes', {json.dumps(json.dumps(keys))}), sessionStorage.getItem('agentTeam.heldPanes')"))
    c.call("Page.enable"); c.call("Page.reload"); time.sleep(30)
    say("held after reload:", Cdp(main_page(ws)).ev("sessionStorage.getItem('agentTeam.heldPanes')"))
    state()
elif phase == "targets":
    r = external(B(), "cli_list_targets", {"workspace_path": ws})
    for t in r.get("targets", []):
        if t.get("workspace_path") == ws: say(json.dumps({k: t.get(k) for k in ("name", "pane_id", "offline", "realized", "busy", "window_id")}))
elif phase == "resolve":
    for pid in sys.argv[5:] if len(sys.argv) > 5 else []:
        pass
    for pid in (label.split(",") if label != "resolve" else []):
        r = external(B(), "cli_get_status", {"target": "", "pane_id": pid, "workspace_path": ws})
        say(pid[:8], "->", json.dumps(r)[:300])
elif phase == "closewake":
    # Option B: close every window of the workspace, wait until the commander is no longer registered, then /wake
    import urllib.parse
    enc = urllib.parse.quote(ws, safe="")
    for p in pages():
        if p.get("type") == "page" and ("workspace_path=" + enc) in p["url"]:
            say("closing", p["url"][-70:], Cdp(p).ev("window.close(),'closed'"))
    for _ in range(30):
        time.sleep(2)
        r = external(B(), "cli_list_targets", {"workspace_path": ws})
        live = [t["name"] for t in r.get("targets", []) if t.get("workspace_path") == ws]
        if not live: break
    say("registered panes of the workspace after close:", live)
    t0 = time.time(); say("WAKE", label, say_room("/wake"))
    for _ in range(60):
        time.sleep(2)
        if any(m["at"] > t0 and re.search(r"已喚醒|失敗|無法|不需要|拒|refus|fail", m["body"] or "") for m in bot_out()): break
    time.sleep(10)
    say("windows now:", [p["url"][-80:] for p in pages() if ("workspace_path=" + enc) in p["url"]])
    state()
elif phase == "state": state()
elif phase == "stop":
    pid = int((ROOT / "fm.pid").read_text()); os.kill(pid, signal.SIGTERM); time.sleep(1)
    try: http("GET", FM + "/_matrix/client/v3/account/whoami"); say("fakematrix still answering!")
    except Exception: say("fakematrix stopped, pid", pid)
