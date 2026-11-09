# focusws.py <root> <workspace name> [close]: bring that workspace's window to the front (ui.window.focus), or close it
import json, os, sys
ROOTP, W = sys.argv[1], sys.argv[2]; ACT = sys.argv[3] if len(sys.argv) > 3 else "focus"; sys.argv = [sys.argv[0], ROOTP, "status"]
exec(open(ROOTP + "/newtests.py", encoding="utf-8").read().split('\nif phase == "setup":')[0])
p = os.path.join(ROOTP, W)
print(ACT, W, json.dumps(ext("ui_invoke", {"workspace_path": p, "action": "ui.window." + ACT}))[:200])
