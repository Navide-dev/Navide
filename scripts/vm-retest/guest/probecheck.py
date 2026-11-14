# probecheck.py <root>: item (d) - with VS Code (its bin\copilot-shim\copilot.exe on PATH) and no Copilot CLI, Navide
# must not show "Startup probe failed": searches every window's text and the backend's agent/CLI status answers.
import json, sys
ROOTP = sys.argv[1]; sys.argv = [sys.argv[0], ROOTP, "status"]
exec(open(ROOTP + "/newtests.py", encoding="utf-8").read().split('\nif phase == "setup":')[0])
hits = []
for p in pages():
    try:
        t = Cdp(p).ev("document.body ? document.body.innerText : ''") or ""
        for l in t.splitlines():
            if "probe" in l.lower() or "copilot" in l.lower(): hits.append((p.get("title", "")[:30], l.strip()[:160]))
    except Exception as e: hits.append((p.get("title", "")[:30], f"err {e}"))
print("window text lines with probe/copilot:", json.dumps(hits[:20], ensure_ascii=False))
b = B()
for t in ("onboarding.status", "agents.list", "cli.health"):
    try: r = b.call(t); s = json.dumps(r.get("payload"), ensure_ascii=False); i = s.lower().find("copilot")
    except Exception as e: s, i = f"err {e}", -1
    print(t, "->", s[max(0, i - 200):i + 400] if i >= 0 else s[:200])
print("RESULT probecheck 'Startup probe failed' shown:", any("startup probe failed" in l.lower() for _, l in hits))
