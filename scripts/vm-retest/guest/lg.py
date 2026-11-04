# lg.py <workspace dir> [n]: lines of interest from the n-th latest run's pipeline.log (default the latest)
import glob,json,os,sys
f=sorted(glob.glob(os.path.join(sys.argv[1],".agent-team","runs","*","pipeline.log")))[-int(sys.argv[2]) if len(sys.argv)>2 else -1]
print(f)
for l in open(f,encoding="utf-8",errors="replace"):
    d=json.loads(l[l.find("{"):]); print(l[11:20], d.get("event"), d.get("reason",""), str(d.get("pane_id",""))[:8], (d.get("details") or {}).get("line","")[12:200])
