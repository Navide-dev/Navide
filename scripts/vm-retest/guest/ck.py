# ck.py <root> <msg_key>: cli_check_message for one msg_key over the external MCP bus
import json, sys
ROOTP = sys.argv[1]; K = sys.argv[2]
sys.argv = [sys.argv[0], ROOTP, "wn", "state"]
exec(open(ROOTP + "/lineage.py", encoding="utf-8").read().split('if phase == "setup":')[0])
print(json.dumps(external(B(), "cli_check_message", {"msg_key": K}))[:400])
