# totals.py: whole-round totals in the guest (results.jsonl pass count, launches/bypass, watchdog stalls,
#   kickoff injected/never submitted, webhook_runs by state, not-passed list). Linux and Windows.
import glob, json, os, re, sqlite3, collections
H = os.path.expanduser("~"); B = (os.environ["APPDATA"] + "/Agent-Team/logs/backend.log") if os.name == "nt" else H + "/.local/share/Agent-Team/logs/backend.log"
r = [json.loads(l) for l in open(H + "/wh/results.jsonl", encoding="utf-8") if l.strip()]
print("results.jsonl", sum(1 for x in r if x.get("pass")), "/", len(r))
bl = open(B, encoding="utf-8", errors="replace").read()
st = re.findall(r"terminal session created .*?cmd=\[(.*?)\]$", bl, re.M)
print("launches", len(st), "bypass", sum("dangerously-skip-permissions" in s for s in st), "default", sum("permission-mode default" in s for s in st))
stalls = [float(x) for x in re.findall(r"event loop stalled for ([0-9.]+)s", bl)]
print("watchdog stalls", len(stalls), ">=10s", sum(s >= 10 for s in stalls), "max", max(stalls or [0]))
c = collections.Counter(); ns = 0; ks = 0
for f in glob.glob(H + "/wh/*/.agent-team/runs/*/pipeline.log"):
    t = open(f, encoding="utf-8", errors="replace").read(); ns += t.count("never submitted"); ks += len(re.findall(r"kickoff attempt \d+: injected", t))
print("kickoff injected", ks, "never submitted", ns)
db = sqlite3.connect(("file:" + os.environ["APPDATA"].replace(chr(92), "/") + "/Agent-Team/navide.db?mode=ro" if os.name == "nt" else f"file:{H}/.local/share/Agent-Team/navide.db?mode=ro"), uri=True)
tabs = [x[0] for x in db.execute("select name from sqlite_master where type='table'")]
wt = "webhook_runs"
if wt: print(wt, dict(db.execute(f"select state, count(*) from {wt} group by state").fetchall()))
else: print("tables", tabs)
bad = collections.Counter(x["phase"] + ":" + x["item"][:40] for x in r if not x.get("pass"))
print("not passed:", bad.most_common(30))
