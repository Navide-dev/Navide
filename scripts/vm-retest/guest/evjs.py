# evjs.py <root> <ws> <file.js>: evaluate that js in the workspace window (test VM only); prints the result as UTF-8
import json, sys
ROOTP, WSN, JF = sys.argv[1:4]; JS = open(JF, encoding="utf-8").read(); sys.argv = ["d", ROOTP, "x"]
exec(open(ROOTP + "/drv.py").read().split("PH = {")[0])
r = Cdp(main_page(str(ROOT / WSN))).ev(JS)
sys.stdout.buffer.write((str(r) + "\n").encode("utf-8"))
