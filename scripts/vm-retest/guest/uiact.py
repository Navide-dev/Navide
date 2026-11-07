# uiact.py <root> <workspace name> <ui action>: ui_invoke one action in that workspace's window
import json, os, sys
ROOTP, W, A = sys.argv[1], sys.argv[2], sys.argv[3]; sys.argv = [sys.argv[0], ROOTP, "status"]
exec(open(ROOTP + "/newtests.py", encoding="utf-8").read().split('\nif phase == "setup":')[0])
print(A, W, json.dumps(ext("ui_invoke", {"workspace_path": os.path.join(ROOTP, W), "action": A}))[:200])
