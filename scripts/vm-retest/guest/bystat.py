# bystat.py <root> [<ws>/<pane>]: cli_get_status of one pane, ui fields without the buffer
import json, sys
ROOTP = sys.argv[1]; T = sys.argv[2] if len(sys.argv) > 2 else "wx/by"
sys.argv = [sys.argv[0], ROOTP, T.split("/")[0], "state"]
exec(open(ROOTP + "/lineage.py", encoding="utf-8").read().split('if phase == "setup":')[0])
r = external(B(), "cli_get_status", {"target": T, "workspace_path": str(ROOT / T.split("/")[0])})
u = r.get("ui") or {}; print(T, {k: v for k, v in r.items() if k not in ("ui",)}, {k: v for k, v in u.items() if k != "buffer"})
