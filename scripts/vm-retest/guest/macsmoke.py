# macsmoke.py <root> [wizard|pane]: the macOS fresh-install smoke, after host/macos-up.sh (no argument: both, in order).
#   wizard : the first-launch wizard in window=main, driven over CDP (9223): each step's headings and buttons are recorded
#            and screenshotted, then the step's forward button is pressed (Next, Finish, Get Started, Done, ...) until
#            the wizard is gone. Pass = it ends within 10 steps and its Agents step lists Claude Code as detected.
#   pane   : open the workspace "wm", open its first pane with an external cli_open_agent (Claude Code, pointed at the
#            local stub) and a task. Pass = kickoff sent within 45 s, the pane alive 20 s later, the stub got a request.
import json, os, re, sys, time
ROOTP = sys.argv[1]; WHICH = sys.argv[2] if len(sys.argv) > 2 else "all"; sys.argv = [sys.argv[0], ROOTP, "wm", "state"]
exec(open(ROOTP + "/lineage.py", encoding="utf-8").read().split('if phase == "setup":')[0])
PHASE = "macsmoke"
FORWARD = r"^(Next|Continue|Finish|Get Started|Done|Start|Start Using Navide|Open Navide|Let's Go|Go)$"
def main_wizard_page():
    ps = [p for p in pages() if "window=main" in p["url"]]
    return ps[0] if ps else pages()[0]
def view(c):
    return json.loads(c.ev("JSON.stringify({h:[...document.querySelectorAll('h1,h2,h3')].map(e=>e.innerText.trim()).filter(Boolean).slice(0,8),"
                           "b:[...document.querySelectorAll('button')].filter(e=>e.offsetParent).map(e=>e.innerText.trim()).filter(Boolean).slice(0,40),"
                           "t:document.body.innerText.slice(0,1500)})") or "{}")
def wizard():
    # The wizard renders only once the backend has answered onboarding.status (until then the shell shows the Welcome
    # screen), so wait for it to appear before judging anything.
    c = Cdp(main_wizard_page()); seen_claude = False; t0 = time.time()
    while time.time() - t0 < 90 and "Skip for Now" not in view(c).get("b", []): time.sleep(2)
    if "Skip for Now" not in view(c).get("b", []):
        shot("wiz-missing"); st = B().call("onboarding.status").get("payload")
        rec("wizard shown on first launch", False, f"no wizard after 90 s; onboarding.status={json.dumps(st)[:300]}"); return
    rec("wizard shown on first launch", True, f"after {round(time.time() - t0)} s")
    for i in range(1, 11):
        time.sleep(3); v = view(c); shot(f"wiz-{i}")
        say(f"step {i} headings={v.get('h')} buttons={v.get('b')}")
        if re.search(r"Claude Code", v.get("t", "")) and re.search(r"\d+\.\d+\.\d+", v.get("t", "")): seen_claude = True
        fw = [b for b in v.get("b", []) if re.match(FORWARD, b, re.I)]
        if not fw and "Skip for Now" not in v.get("b", []):
            rec("wizard finished", True, f"after {i - 1} forward clicks; claude detected on the Agents step: {seen_claude}")
            rec("wizard: Claude Code detected", seen_claude, "the stub-configured CLI showed a version on the Agents step")
            return
        js = f"(()=>{{const b=[...document.querySelectorAll('button')].filter(e=>e.offsetParent).find(e=>new RegExp({json.dumps(FORWARD)},'i').test(e.innerText.trim())); if(!b) return 'none'; b.click(); return b.innerText.trim()}})()"
        say("clicked", c.ev(js))
    rec("wizard finished", False, "still in the wizard after 10 steps")
def pane():
    open_ws(ws); n0 = os.path.getsize(ROOT / "stub.log") if (ROOT / "stub.log").exists() else 0
    t0 = time.time(); r = ext_("cli_open_agent", {"agent": "claude", "name": "m1", "task": "MACSMOKE reply with the word ready.", "workspace_path": ws})
    dt = round(time.time() - t0, 1); say("cli_open_agent", json.dumps(r, ensure_ascii=False)[:300]); time.sleep(20)
    st = ext_("cli_get_status", {"target": "wm/m1", "workspace_path": ws}); alive = bool(st.get("ok"))
    grew = (ROOT / "stub.log").exists() and os.path.getsize(ROOT / "stub.log") > n0
    shot("pane-first", ws)
    rec("first pane: kickoff sent", r.get("kickoff") == "sent" and dt <= 45, f"+{dt}s kickoff={r.get('kickoff')}")
    rec("first pane: alive after 20 s", alive, json.dumps(st, ensure_ascii=False)[:300])
    rec("first pane: stub got the request", grew, f"stub.log grew: {grew}")
def ext_(tool, args): return external(B(), tool, args)
if WHICH in ("all", "wizard"): wizard()
if WHICH in ("all", "pane"): pane()
print("macsmoke fails", fails, flush=True); sys.exit(1 if fails else 0)
