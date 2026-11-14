# rlog.py <root> <target> [lines]: external cli_read_log, print the screen tail
import json, sys
ROOTP, TG = sys.argv[1:3]; N = int(sys.argv[3]) if len(sys.argv) > 3 else 20
sys.argv = [sys.argv[0], ROOTP, "wl", "state"]
exec(open(ROOTP + "/lineage.py", encoding="utf-8").read().split('if phase == "setup":')[0])
r = external(B(), "cli_read_log", {"target": TG, "lines": N})
print(json.dumps(r, ensure_ascii=False)[:3000])
