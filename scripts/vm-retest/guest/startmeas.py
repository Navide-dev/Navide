# startmeas.py <root> [n]: how long a fresh Claude CLI pane on this machine takes from its start to its first output.
# External cli_open_agent (with a task) runs in a thread; the pane's PTY capture (<ws>/.agent-team/manual/<day>/
# claude-<pane>.log) is polled every 100 ms: when it appears, when it first has bytes, and when it first has visible text.
import glob, json, os, re, sys, threading, time
ROOTP = sys.argv[1]; N = int(sys.argv[2]) if len(sys.argv) > 2 else 3; sys.argv = [sys.argv[0], ROOTP, "kick"]
exec(open(ROOTP + "/n238.py", encoding="utf-8").read().split('\nif phase == "stopagent":')[0])
pat = os.path.join(ws, ".agent-team", "manual", "*", "claude-*.log")
for i in range(1, N + 1):
    before = set(glob.glob(pat)); res = {}; nm = f"sm{i}-" + _s.token_hex(2); t0 = time.time()
    th = threading.Thread(target=lambda: res.update(ext("cli_open_agent", {"agent": "claude", "name": nm, "task": "STARTMEAS reply with the word ready.", "workspace_path": ws}))); th.start()
    f = appear = first_byte = first_text = None; txt = ""
    while time.time() - t0 < 45:
        if f is None:
            new = [x for x in glob.glob(pat) if x not in before]
            if new: f = new[0]; appear = time.time() - t0
        if f:
            b = open(f, "rb").read()
            if b and first_byte is None: first_byte = time.time() - t0
            t = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b.", "", b.decode("utf-8", "replace"))
            if re.search(r"[A-Za-z]{3,}", t) and first_text is None: first_text = time.time() - t0; txt = " ".join(t.split())[:80]
        if first_text is not None or (not th.is_alive() and time.time() - t0 > 25): break
        time.sleep(0.1)
    th.join(60); r = lambda v: v if v is None else round(v, 1)
    say(f"RESULT startmeas #{i} capture_file=+{r(appear)}s first_byte=+{r(first_byte)}s first_text=+{r(first_text)}s text='{txt}' "
        f"answer={json.dumps({k: res.get(k) for k in ('ok', 'error', 'kickoff')}, ensure_ascii=False)}")
    time.sleep(10)
