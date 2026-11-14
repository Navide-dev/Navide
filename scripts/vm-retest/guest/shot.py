# shot.py <root> <ws> <out.png>: screenshot of the workspace's main window over CDP
import base64, sys
ROOTP, name, out = sys.argv[1:4]; sys.argv = ["d", ROOTP, "x"]
exec(open(ROOTP + "/drv.py").read().split("PH = {")[0])
c = Cdp(main_page(str(ROOT / name))); r = c.call("Page.captureScreenshot", format="png")
open(out, "wb").write(base64.b64decode((r.get("result") or r).get("data", ""))); print("saved", out)
