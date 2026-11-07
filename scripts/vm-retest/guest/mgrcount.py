# mgrcount.py <markfile>: router messages the Manager received in its latest request, since the mark
import json, sys
m = int(open(sys.argv[1]).read()); last = None
for l in open("stub.log", errors="replace").readlines()[m:]:
    d = json.loads(l); t = json.dumps(d["messages"], ensure_ascii=False)
    if "ROLEMGR" in t and d["tools"]: last = d
if not last: print("no manager request"); sys.exit()
seen = []
for x in last["messages"]:
    if x.get("role") != "user": continue
    for c in (x["content"] if isinstance(x["content"], list) else [{"type": "text", "text": x["content"]}]):
        s = c.get("text") or json.dumps(c.get("content"), ensure_ascii=False) or ""
        for part in s.split("[→ ")[1:]:
            if " FROM wk" in part[:20]: seen.append(part[:90].replace("\n", " / "))
print("router msgs to mgr:", len(seen))
for v in seen: print("   [→ " + v)
