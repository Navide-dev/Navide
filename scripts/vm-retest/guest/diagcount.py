# diagcount.py <root>: the 70e669130 diagnostic lines across every run log of the test workspaces
import glob, json, os, re, sys, collections
root = sys.argv[1]; C = collections.Counter(); ex = {}
for f in glob.glob(os.path.join(root, "*", ".agent-team", "runs", "*", "pipeline.log")):
    for l in open(f, encoding="utf-8", errors="replace"):
        t = (json.loads(l[l.find("{"):]).get("details") or {}).get("line", "") if "{" in l else ""
        for k, rx in (("inject-evidence", r"· (kickoff|role) attempt \d+: "), ("role-turn-wait", r"role turn wait: "),
                      ("queued-kickoff", r"queued kickoff: |kickoff was queued behind"), ("never-submitted", r"never submitted"),
                      ("turn-end-unconfirmed", r"no turn_complete within")):
            if re.search(rx, t):
                C[k] += 1; ex.setdefault(k, t[12:200])
        m = re.search(r"· (kickoff|role) attempt \d+: (\w[\w ]*) — echo (\S+), submit (\S+),", t)
        if m: C[f"{m.group(1)}:{m.group(2)}:echo={m.group(3)}:submit={m.group(4)}"] += 1
        m = re.search(r"role turn wait: (.+?) after \d+ ms", t)
        if m: C["role-turn-wait:" + m.group(1)[:50]] += 1
for k, v in sorted(C.items()): print(v, k)
for k, v in ex.items(): print("e.g.", k, "|", v)
