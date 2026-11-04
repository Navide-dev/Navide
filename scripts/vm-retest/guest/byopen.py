# byopen.py <root>: open an idle bystander pane "by" in window wx (external cli_open_agent), print its id
import json, sys
ROOTP = sys.argv[1]
sys.argv = [sys.argv[0], ROOTP, "wx", "state"]
exec(open(ROOTP + "/lineage.py", encoding="utf-8").read().split('if phase == "setup":')[0])
r = external(B(), "cli_open_agent", {"agent": "claude", "name": "by", "task": "Reply with the word ready.", "workspace_path": str(ROOT / "wx")})
print(json.dumps(r)[:400])
