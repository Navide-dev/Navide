# stubq.py <root> <text>: print every user text block in stub.log that contains <text>
import json, sys, pathlib
for l in open(pathlib.Path(sys.argv[1]) / "stub.log", encoding="utf-8", errors="replace"):
    try: d = json.loads(l)
    except Exception: continue
    u = [m for m in d["messages"] if m.get("role") == "user"]
    if not u: continue
    c = u[-1]["content"]; blocks = [b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text"] if isinstance(c, list) else [str(c)]
    for b in blocks:
        if sys.argv[2] in b: print(round(d["at"], 1), json.dumps(b, ensure_ascii=False)[:200])
