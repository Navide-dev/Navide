# quitapp.py <root>: ask the running app to quit over CDP (Browser.close), report whether the main process ends
import json, sys, time, subprocess
sys.argv = ["d", sys.argv[1], "x"]
exec(open(sys.argv[1] + "/drv.py").read().split("PH = {")[0])
import urllib.request
v = json.loads(urllib.request.urlopen("http://127.0.0.1:9223/json/version").read())
w = WS("127.0.0.1", 9223, v["webSocketDebuggerUrl"].split("9223", 1)[1])
w.send(json.dumps({"id": 1, "method": "Browser.close"})); print(time.strftime("%H:%M:%S"), "Browser.close sent", flush=True)
try:
    w.s.settimeout(6); print("reply", w.recv()[:200])
except Exception as e: print("no reply", type(e).__name__)
time.sleep(3)
