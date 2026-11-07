# resize.py <root> <ws> <times>: make the workspace window's panes repaint by changing its viewport width
# (CDP Emulation.setDeviceMetricsOverride, so xterm refits, the PTY gets a new size and the CLI redraws), then restore.
import json, sys, time
ROOTP, name, n = sys.argv[1:4]; sys.argv = ["d", ROOTP, "x"]
exec(open(ROOTP + "/drv.py").read().split("PH = {")[0])
c = Cdp(main_page(str(ROOT / name)))
w, h = c.ev("[innerWidth, innerHeight]")
for i in range(int(n)):
    c.call("Emulation.setDeviceMetricsOverride", width=int(w * (0.7 if i % 2 == 0 else 0.85)), height=h, deviceScaleFactor=0, mobile=False)
    print(time.strftime("%H:%M:%S"), "resize", i, flush=True); time.sleep(2)
c.call("Emulation.clearDeviceMetricsOverride"); print(time.strftime("%H:%M:%S"), "restored", w, h, flush=True)
