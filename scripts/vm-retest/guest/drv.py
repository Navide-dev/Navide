# Guest-side acceptance driver, stdlib only. usage: drv.py <root> <phase> ; root holds wf.json, stub.log, state.json.
import base64, datetime, hashlib, hmac, json, os, pathlib, re, secrets, socket, struct, subprocess, sys, time, urllib.parse, urllib.request, uuid
ROOT = pathlib.Path(sys.argv[1]); PHASE = sys.argv[2]; WIN = os.name == "nt"
STATE = ROOT / "state.json"; RESULTS = ROOT / "results.jsonl"; SHOTS = ROOT / "shots"; SHOTS.mkdir(exist_ok=True)
state = json.loads(STATE.read_text()) if STATE.exists() else {}
fails = 0
def rec(item, ok, detail=""):
    global fails
    fails += 0 if ok else 1
    line = {"phase": PHASE, "item": item, "pass": bool(ok), "detail": str(detail)[:900], "at": time.strftime("%H:%M:%S")}
    with RESULTS.open("a", encoding="utf-8") as f: f.write(json.dumps(line, ensure_ascii=False) + "\n")
    print(("PASS " if ok else "FAIL ") + item + " :: " + str(detail)[:300], flush=True)
class WS:
    def __init__(self, host, port, path):
        self.s = socket.create_connection((host, port), 20); self.s.settimeout(60); self.buf = b""
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        self.s.sendall(f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode())
        while b"\r\n\r\n" not in self.buf: self.buf += self.s.recv(4096)
        head, self.buf = self.buf.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n")[0]: raise RuntimeError(head[:200])
    def _n(self, n):
        while len(self.buf) < n:
            c = self.s.recv(1 << 20)
            if not c: raise EOFError
            self.buf += c
        o, self.buf = self.buf[:n], self.buf[n:]; return o
    def send(self, text):
        d = text.encode(); h = b"\x81"; L = len(d)
        h += bytes([0x80 | L]) if L < 126 else (bytes([0xFE]) + struct.pack(">H", L) if L < 65536 else bytes([0xFF]) + struct.pack(">Q", L))
        m = secrets.token_bytes(4); self.s.sendall(h + m + bytes(b ^ m[i % 4] for i, b in enumerate(d)))
    def recv(self):
        out = b""
        while True:
            a, b = self._n(2); op = a & 15; L = b & 127
            if L == 126: L = struct.unpack(">H", self._n(2))[0]
            elif L == 127: L = struct.unpack(">Q", self._n(8))[0]
            p = self._n(L)
            if op == 8: raise EOFError
            if op in (9, 10): continue
            out += p
            if a & 0x80: return out.decode("utf-8", "replace")
def data_dir():
    bases = [pathlib.Path(os.environ["APPDATA"])] if WIN else [pathlib.Path.home() / ".config", pathlib.Path.home() / ".local/share"]
    hits = [p.parent for b in bases for p in b.glob("*/backend-ws-token") if "agent-team" in str(p).lower() or "navide" in str(p).lower()]
    return max(hits, key=lambda p: (p / "backend-ws-token").stat().st_mtime)
class B:
    def __init__(self):
        self.dir = data_dir(); tok = (self.dir / "backend-ws-token").read_text().strip(); port = int((self.dir / "backend-port").read_text().strip())
        self.ws = WS("127.0.0.1", port, f"/ws?t={tok}")
    def call(self, t, **p):
        i = str(uuid.uuid4()); self.ws.send(json.dumps({"id": i, "type": t, "payload": p, "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat()}))
        end = time.time() + 60
        while time.time() < end:
            m = json.loads(self.ws.recv())
            if m.get("id") == i: return m
        raise TimeoutError(t)
def pages():
    return [t for t in json.load(urllib.request.urlopen("http://127.0.0.1:9223/json", timeout=10)) if t.get("type") == "page"]
class Cdp:
    def __init__(self, target):
        u = urllib.parse.urlparse(target["webSocketDebuggerUrl"]); self.ws = WS(u.hostname, u.port, u.path); self.n = 0
    def call(self, method, **p):
        self.n += 1; self.ws.send(json.dumps({"id": self.n, "method": method, "params": p}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == self.n: return m.get("result", m)
    def ev(self, js):
        r = self.call("Runtime.evaluate", expression=js, returnByValue=True, awaitPromise=True)
        return r.get("result", {}).get("value")
def main_page(ws=""):
    all_ = pages(); key = urllib.parse.quote(ws, safe="") if ws else ""
    for t in all_:
        if ws and (ws in t["url"] or key in t["url"] or urllib.parse.quote(ws) in t["url"]): return t
    return all_[0] if not ws else None
def shot(name, ws=""):
    t = main_page(ws)
    if t is None: t = pages()[0]
    c = Cdp(t); c.call("Page.enable"); r = c.call("Page.captureScreenshot", format="png"); (SHOTS / f"{name}.png").write_bytes(base64.b64decode(r["data"]))
def open_ws(ws):
    os.makedirs(ws, exist_ok=True)
    if main_page(ws) is None:
        print("open", Cdp(pages()[0]).ev(f"window.agentTeam.openMainWindow({{workspace_path:{json.dumps(ws)}}}).then(r=>JSON.stringify(r))"), flush=True)
    end = time.time() + 40
    while time.time() < end and main_page(ws) is None: time.sleep(1)
    t = main_page(ws)
    if t is None: raise RuntimeError("workspace window did not open: " + json.dumps([p["url"][:120] for p in pages()]))
    c = Cdp(t)
    for _ in range(8):
        time.sleep(1.5); c.ev("[...document.querySelectorAll('button')].find(b=>/Skip for Now/.test(b.textContent))?.click()")
def http(port, method, path, headers=None, body=b"", host=None, send_body=True):
    """The client's own view: the status line if any, then how the connection ended."""
    h = {"Host": host or f"127.0.0.1:{port}", "Connection": "close", "Content-Length": str(len(body)), **(headers or {})}
    head = f"{method} {path} HTTP/1.1\r\n" + "".join(f"{k}: {v}\r\n" for k, v in h.items()) + "\r\n"
    s = socket.create_connection(("127.0.0.1", port), 15); s.settimeout(20); got = b""; end = "?"; sent_err = ""
    try:
        s.sendall(head.encode() + (body if send_body else b""))
    except OSError as e:
        sent_err = type(e).__name__
    try:
        while True:
            c = s.recv(65536)
            if not c: end = "fin"; break
            got += c
    except ConnectionResetError: end = "rst"
    except ConnectionAbortedError: end = "aborted"
    except socket.timeout: end = "timeout"
    s.close()
    m = re.match(rb"HTTP/1\.1 (\d+)", got)
    return {"status": int(m.group(1)) if m else None, "end": end, "bytes": len(got), "send_error": sent_err, "body": got.split(b"\r\n\r\n", 1)[-1].decode("utf-8", "replace")}
def stub_has(nonce, wait=70):
    end = time.time() + wait; log = ROOT / "stub.log"
    while time.time() < end:
        if log.exists() and nonce in log.read_text(encoding="utf-8", errors="replace"): return True
        time.sleep(2)
    return False
def stub_tool_ran(nonce):
    for l in (ROOT / "stub.log").read_text(encoding="utf-8", errors="replace").splitlines():
        if nonce in l and json.loads(l).get("done"): return True
    return False
def listeners():
    if WIN:
        return subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True).stdout
    return subprocess.run(["ss", "-ltnH"], capture_output=True, text=True).stdout
def bound(port):
    return sorted({l.split()[1 if WIN else 3] for l in listeners().splitlines() if len(l.split()) > 3 and l.split()[1 if WIN else 3].endswith(f":{port}") and ("LISTENING" in l or not WIN)})
def end_run(b, ws):
    a = b.call("pipeline.abort", workspace_path=ws); r = b.call("pipeline.reset", workspace_path=ws); print("abort", a.get("ok"), "reset", r.get("ok"), flush=True); time.sleep(6)
def post_until(port, path, mk, tries=8):
    r = None
    for _ in range(tries):
        nonce = "N" + secrets.token_hex(6); h, body = mk(nonce); r = http(port, "POST", path, h, body)
        if r["status"] != 409: return r, nonce
        time.sleep(5)
    return r, nonce
def sign(secret, raw): return "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
J = {"Content-Type": "application/json"}
def phase_defaults():
    b = B(); st = b.call("webhook.status")["payload"]
    rec("off-by-default", st["settings"]["enabled"] is False and st["listening"] is False and st["port"] == 0 and not st["triggers"], {k: st[k] for k in ("listening", "port", "guard_enabled", "key_protection", "unattended_supported")} | {"enabled": st["settings"]["enabled"]})
    rec("off: configured port not listening", not bound(st["settings"]["port"]), {"port": st["settings"]["port"], "bound": bound(st["settings"]["port"])})
    rec("guard on by default", st["guard_enabled"] is True, st["guard_enabled"])
    state.update(key_protection=st["key_protection"], unattended_supported=st["unattended_supported"], data_dir=str(b.dir))
def phase_setup():
    b = B(); wa, wg, wf = str(ROOT / "wa"), str(ROOT / "wg"), str(ROOT / "wf")
    for ws in (wa, wg, wf): open_ws(ws)
    wfj = json.loads((ROOT / "wf.json").read_text()); ids = {}
    for name, agent, ws in (("real claude a", "claude", wa), ("real claude g", "claude", wg), ("real claude f", "claude", wf), ("real codex", "codex", wa)):
        wfj["name"] = name; r = b.call("pipelines.import_n8n", json=json.dumps(wfj), dry_run=False, default_agent=agent, workspace_path=ws)
        rec("import " + name, r.get("ok"), str(r.get("error"))[:200])
    ps = b.call("pipelines.list")["payload"]["pipelines"]; ids = {p["name"]: p["id"] for p in ps}
    rec("imported pipelines listed", all(k in ids for k in ("real claude a", "real claude g", "real claude f", "real codex")), list(ids))
    lst = lambda: {l.split()[1 if WIN else 3] for l in listeners().splitlines() if len(l.split()) > 3 and ("LISTENING" in l or not WIN)}; before = lst(); on = b.call("webhook.settings.set", enabled=True); st = on["payload"]; time.sleep(3); new = sorted(lst() - before)
    rec("switch on alone opens nothing (no trigger)", st["listening"] is False and st["port"] == 0 and not new, {"listening": st["listening"], "port": st["port"], "new_listeners": new, "listeners_before": len(before), "error": st["error"]})
    mk = lambda **k: b.call("webhook.trigger.create", no_gate_ack=True, per_minute=60, per_day=500, **k)
    t = mk(name="bearer", workspace_path=wa, pipeline_id=ids["real claude a"]); tid = t["payload"]["trigger"]["id"]
    g = mk(name="gh", workspace_path=wg, pipeline_id=ids["real claude g"], kind="github", events=["push"]); gid = g["payload"]["trigger"]["id"]
    f = mk(name="form", workspace_path=wf, pipeline_id=ids["real claude f"], kind="form", fields=[{"label": "Message", "type": "text", "required": True}]); fid = f["payload"]["trigger"]["id"]
    for i in (tid, gid, fid):
        e = b.call("webhook.trigger.enable", id=i, enabled=True)
        if i == gid and state["key_protection"] == "file":
            rec("github on file key needs explicit ack", not e.get("ok") and "WEAK_KEY_ACK_REQUIRED" in json.dumps(e), json.dumps(e)[:160])
            e = b.call("webhook.trigger.enable", id=i, enabled=True, weak_key_acknowledged=True)
        rec("enable " + i[:8], e.get("ok"), e.get("error"))
    st = b.call("webhook.status")["payload"]; port = st["port"]
    state.update(wa=wa, wg=wg, wf=wf, tid=tid, gid=gid, fid=fid, token=t["payload"]["token"], secret=g["payload"]["token"], form=f["payload"]["token"], port=port, ids=ids)
    bs = bound(port); rec("listener loopback only", st["listening"] and bs and all(a.startswith("127.0.0.1:") for a in bs), {"port": port, "bound": bs})
def phase_bearer():
    b = B(); p, tid, ws = state["port"], state["tid"], state["wa"]; path = f"/webhook/{tid}"; good = {"Authorization": "Bearer " + state["token"], **J}
    r = http(p, "POST", path, {"Authorization": "Bearer wrong" + "key", **J}, b'{"a":1}'); rec("bearer wrong refused", r["status"] == 404, r)
    r = http(p, "POST", path, J, b'{"a":1}'); rec("bearer missing refused", r["status"] == 404, r)
    r = http(p, "POST", path, {**good, "Origin": "http://evil.example"}, b'{"a":1}'); rec("origin on webhook refused", r["status"] == 404, r)
    r = http(p, "POST", path, good, b'{"a":1}', host="evil.example"); rec("foreign Host refused", r["status"] == 404, r)
    nonce = "N" + secrets.token_hex(6); r = http(p, "POST", path, good, json.dumps({"a": 1, "note": nonce}).encode())
    rec("bearer right starts run", r["status"] == 202, r)
    rec("imported n8n pipeline: task reached the step (real Claude request)", stub_has(nonce), nonce)
    time.sleep(25); shot("bearer-run", ws)
    rec("default run: tool call not executed unattended", not stub_tool_ran(nonce) and not (pathlib.Path(ws) / "RAN.txt").exists(), {"marker": (pathlib.Path(ws) / "RAN.txt").exists()})
    ev = b.call("webhook.events", id=tid)["payload"]["events"]; rec("audit has accepted", any(e["outcome"] == "accepted" for e in ev), [e["outcome"] for e in ev][:8])
    end_run(b, ws)
def phase_github(tag):
    b = B(); p, gid, ws, sec = state["port"], state["gid"], state["wg"], state["secret"]; path = f"/webhook/{gid}"
    raw = b'{"ref":"refs/heads/x"}'
    h = {**J, "X-GitHub-Event": "push", "X-Hub-Signature-256": sign("wrong" + "secret", raw)}
    r = http(p, "POST", path, h, raw); rec(f"github wrong signature refused ({tag})", r["status"] == 404, r)
    h2 = dict(h); h2.pop("X-Hub-Signature-256"); r = http(p, "POST", path, h2, raw); rec(f"github no signature refused ({tag})", r["status"] == 404, r)
    def good(n):
        x = json.dumps({"ref": "refs/heads/" + n, "repository": {"full_name": "o/r"}}).encode(); return {**J, "X-GitHub-Event": "push", "X-Hub-Signature-256": sign(sec, x)}, x
    r, nonce = post_until(p, path, good); rec(f"github right signature starts run ({tag})", r["status"] == 202, r)
    rec(f"github task reached the step ({tag})", stub_has(nonce), nonce)
    x = b'{"zen":"z"}'; r = http(p, "POST", path, {**J, "X-GitHub-Event": "ping", "X-Hub-Signature-256": sign(sec, x)}, x); rec(f"github ping ({tag})", r["status"] == 200, r)
    shot(f"github-run-{tag}", ws); end_run(b, ws)
def phase_form():
    b = B(); p, ws, tok = state["port"], state["wf"], state["form"]; path = "/form/" + tok; me = f"http://127.0.0.1:{p}"
    r = http(p, "GET", path); m = re.search(r'name="_csrf" value="([^"]+)"', r["body"]); rec("form GET page", r["status"] == 200 and bool(m), {k: r[k] for k in ("status", "end", "bytes")})
    (ROOT / "form.html").write_text(r["body"], encoding="utf-8"); csrf = m.group(1).replace("&#x27;", "'"); F = {"Content-Type": "application/x-www-form-urlencoded"}
    enc = lambda c, n: urllib.parse.urlencode({"_csrf": c, "f0": n}).encode()
    r = http(p, "POST", path, {**F, "Origin": "http://evil.example"}, enc(csrf, "x")); rec("form wrong Origin refused", r["status"] == 403, r)
    r = http(p, "POST", path, F, enc(csrf, "x")); rec("form no Origin refused", r["status"] == 403, r)
    r = http(p, "POST", path, {**F, "Origin": me}, enc("0." + "bad", "x")); rec("form bad CSRF refused", r["status"] == 403, r)
    r = http(p, "GET", "/form/" + "0" * len(tok)); rec("form unknown token", r["status"] == 404, r)
    n = "N" + secrets.token_hex(6); r = http(p, "POST", path, {**F, "Origin": me}, enc(csrf, n)); rec("form submit starts run", r["status"] == 200 and "received" in r["body"], {k: r[k] for k in ("status", "end", "bytes")})
    rec("form text reached the step", stub_has(n), n); shot("form-run", ws); end_run(b, ws)
def phase_codex():
    b = B(); t = b.call("webhook.trigger.create", name="cx", workspace_path=state["wa"], pipeline_id=state["ids"]["real codex"], no_gate_ack=True, per_minute=60, per_day=500)
    prob = t["payload"]["problem"]; rec("codex binding: flagged at creation", prob == "vendor-refused", prob)
    e = b.call("webhook.trigger.enable", id=t["payload"]["trigger"]["id"], enabled=True); rec("codex binding: enable refused", not e.get("ok") and "BINDING_REFUSED" in json.dumps(e), json.dumps(e)[:220])
    u = b.call("webhook.trigger.set_unattended", id=state["tid"], unattended=True)
    rec("unattended matches platform", bool(u.get("ok")) == state["unattended_supported"], json.dumps(u)[:200] if not u.get("ok") else "ok")
    if u.get("ok"): b.call("webhook.trigger.set_unattended", id=state["tid"], unattended=False)
def phase_reset():
    """What a refused client sees, for small and large bodies, repeated to catch a race."""
    p, tid, sec = state["port"], state["tid"], state["secret"]; out = {}
    def tally(name, fn, n=20):
        c = {}
        for _ in range(n):
            r = fn(); k = f'{r["status"]}/{r["end"]}' + (f'/send:{r["send_error"]}' if r["send_error"] else ""); c[k] = c.get(k, 0) + 1; time.sleep(0.15)
        out[name] = c; print(name, c, flush=True)
    big = secrets.token_bytes(4 << 20); path = f"/webhook/{tid}"
    tally("wrong key, 7 bytes", lambda: http(p, "POST", path, {"Authorization": "Bearer no", **J}, b'{"a":1}'), 8)
    tally("wrong key, 4 MiB body sent", lambda: http(p, "POST", path, {"Authorization": "Bearer no", **J}, big), 8)
    tally("wrong key, 4 MiB declared, nothing sent", lambda: http(p, "POST", path, {"Authorization": "Bearer no", "Content-Length": str(len(big)), **J}, big, send_body=False), 4)
    tally("unknown path", lambda: http(p, "POST", "/webhook/none", J, b"{}"), 8)
    tally("right key, too large declared", lambda: http(p, "POST", path, {"Authorization": "Bearer " + state["token"], "Content-Length": str(1 << 27), **J}, big), 6)
    (ROOT / "reset.json").write_text(json.dumps(out, indent=1)); rec("refusal transport recorded", True, json.dumps(out))
def phase_keystore():
    d = pathlib.Path(state["data_dir"]); key = d / "webhook-key.bin"; ex = key.exists(); raw = key.read_bytes() if ex else b""
    plain = False
    try: plain = len(base64.b64decode(raw.strip(), validate=True)) == 32
    except Exception: pass
    mode = oct(key.stat().st_mode & 0o777) if ex else ""
    if WIN: rec("keystore file is DPAPI-wrapped, not the bare key", ex and not plain, {"size": len(raw), "dpapi_header": raw[:4].hex() if raw else ""})
    else: rec("keystore file 0600 (file protection, as disclosed)", ex and plain and mode == "0o600", {"size": len(raw), "mode": mode})
    def has(p):
        try: return p.is_file() and p.stat().st_size < 60_000_000 and state["secret"].encode() in p.read_bytes()
        except OSError: skipped.append(p.name); return False
    skipped = []; leak = [str(p) for p in d.rglob("*") if has(p)]
    rec("secret not in clear in data dir", not leak, {"leak": leak[:5], "unreadable_while_running": skipped[:8]})
def phase_cmdline():
    logs = sorted(pathlib.Path(state["data_dir"]).rglob("*.log"), key=lambda p: p.stat().st_mtime); hits = []
    for l in logs:
        for line in l.read_text(encoding="utf-8", errors="replace").splitlines():
            if "terminal session created" in line and "claude" in line.lower(): hits.append(line)
    rec("pane launches found in log", bool(hits), f"{len(hits)} lines")
    bad = [h for h in hits if "dangerously" in h or "bypassPermissions" in h]
    rec("no launch used bypass", hits and not bad, (bad or hits)[-1][-420:] if hits else "")
    dm = lambda h: "--permission-mode default" in h or "'--permission-mode', 'default'" in h  # Windows logs cmd as a list
    rec("default permission mode on run panes", any(dm(h) for h in hits), sum(dm(h) for h in hits))
    pay = [str(p) for p in pathlib.Path(state["wa"]).rglob("pipeline.log")]; print(pay)
def phase_restart():
    b = B(); st = b.call("webhook.status")["payload"]; old = state["port"]
    rec("listener back after restart, same port", st["listening"] and st["port"] == old and all(a.startswith("127.0.0.1:") for a in bound(old)), {"port": st["port"], "was": old, "bound": bound(st["port"]), "error": st["error"]})
    rec("triggers kept after restart", {t["id"] for t in st["triggers"]} >= {state["tid"], state["gid"], state["fid"]}, [t["name"] + ":" + str(t["enabled"]) for t in st["triggers"]])
    state["port"] = st["port"]
    for w in (state["wa"], state["wg"], state["wf"]): open_ws(w)
def phase_quit():
    v = json.load(urllib.request.urlopen("http://127.0.0.1:9223/json/version", timeout=10)); u = urllib.parse.urlparse(v["webSocketDebuggerUrl"]); w = WS(u.hostname, u.port, u.path)
    w.send(json.dumps({"id": 1, "method": "Browser.close"})); print("Browser.close sent", flush=True)
def phase_ghenable():
    b = B(); e = b.call("webhook.trigger.enable", id=state["gid"], enabled=True, weak_key_acknowledged=True); rec("github on file key: enable with ack", e.get("ok"), e.get("error"))
PH = {"quit": phase_quit, "restart": phase_restart, "ghenable": phase_ghenable, "defaults": phase_defaults, "setup": phase_setup, "bearer": phase_bearer, "github": lambda: phase_github("before-restart"), "github2": lambda: phase_github("after-restart"),
      "form": phase_form, "codex": phase_codex, "reset": phase_reset, "keystore": phase_keystore, "cmdline": phase_cmdline}
try:
    PH[PHASE]()
except Exception as e:
    import traceback; traceback.print_exc(); rec("driver error in " + PHASE, False, repr(e))
STATE.write_text(json.dumps(state)); print("phase", PHASE, "fails", fails, flush=True); sys.exit(1 if fails else 0)
