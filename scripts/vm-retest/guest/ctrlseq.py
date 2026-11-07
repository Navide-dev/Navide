# ctrlseq.py <root> <ws>: a fresh pane (webhook run that completes), then three ConPTY Ctrl-U cases on it.
#   multi: 5 lines as a real paste event (bracketed paste keeps the newlines)
#   long : one 900-character line typed with Input.insertText
#   paste: 120 lines as a paste event (Claude Code collapses it to [Pasted text #n +N lines])
# Each case: fill the box, wait, press Ctrl-U, wait, then Ctrl-U again until the box is empty (max 3), Escape-free.
# Prints the timestamps of every step; the screens are read afterwards from the recorded WS output.
import json, re, sys, time
ROOTP, name = sys.argv[1:3]; sys.argv = ["d", ROOTP, "x"]
exec(open(ROOTP + "/drv.py").read().split("PH = {")[0])
import subprocess
def y(*a):
    r = subprocess.run([sys.executable, "y.py", ROOTP, *a], capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.stdout + r.stderr
def say(*a): print(f"{time.time():.3f}", *a, flush=True)
o = y("go", name, "webhook", "done", "ctrlseq")
pane = (re.findall(r"'panes': \['([0-9a-f]{8})'", o) or [""])[0]; say("run done, pane", pane)
c = Cdp(main_page(str(ROOT / name))); c.call("Page.enable"); c.call("Page.bringToFront")
y("dismiss", name); time.sleep(2)
ta = f"[...document.querySelectorAll('[data-pane-id^=\"{pane}\"]')].map(e=>e.querySelector('.xterm-helper-textarea')).find(Boolean)"
def focus(): c.ev("window.dispatchEvent(new Event('focus'))"); c.ev(f"{ta}?.focus()"); time.sleep(.5)
def paste(text):
    return c.ev(f"(()=>{{const t={ta};if(!t)return 'no-textarea';const d=new DataTransfer();d.setData('text/plain',{json.dumps(text)});"
                "t.dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}));return 'pasted'})()")
def ctrl_u():
    for t in ("rawKeyDown", "keyUp"):
        c.call("Input.dispatchKeyEvent", type=t, key="u", code="KeyU", modifiers=2, windowsVirtualKeyCode=85, **({"text": "\x15"} if t == "rawKeyDown" else {}))
cases = [("multi", "\n".join(f"line {i} of a multi-line draft" for i in range(1, 6)), "paste"),
         ("long", "long-line " + "x" * 890, "type"),
         ("paste", "\n".join(f"pasted row {i:03d} " + "y" * 60 for i in range(1, 121)), "paste")]
for label, text, how in cases:
    focus(); say("CASE", label, how, len(text))
    r = paste(text) if how == "paste" else (c.call("Input.insertText", text=text) and "typed")
    say("FILLED", label, r); time.sleep(4)
    for k in range(1, 4):
        say("CTRLU", label, k); ctrl_u(); time.sleep(3)
    say("END", label); time.sleep(2)
