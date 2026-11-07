# tl.py <ws>: a time line of every run's pipeline.log in ~/wh/<ws>
import json,glob,re,sys
for f in sorted(glob.glob(__import__("os").path.expanduser("~/wh/")+sys.argv[1]+"/.agent-team/runs/*/pipeline.log")):
    print(f[-60:-13])
    for l in open(f,encoding="utf-8",errors="replace"):
        i=l.find("{")
        try:d=json.loads(l[i:])
        except: continue
        x=(d.get("details") or {}).get("line","")
        if re.search("injecting|kickoff sent|armed|turn_complete reported",x): print(" ",l[12:20],x[x.find("]")+2:x.find("]")+50])
