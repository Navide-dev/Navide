#!/usr/bin/env python3
# fakecodex.py: a test stand-in for the codex CLI (NOT the real codex). No network, no credentials, no model.
# Installed as `codex` on the app's PATH only for the "vendor with no turn text" item; the snapshot revert removes it.
#   codex --version         -> a version line
#   codex [anything]        -> a line editor in the terminal: echoes what is typed (bracketed paste too); on Enter, a
#                              line with ROLEWK or "manager dispatch" prints a fixed REPORT block for the run's nonce,
#                              anything else prints "ok". It writes no rollout, so Navide has no turn text for it.
import os, re, sys, time
if "--version" in sys.argv[1:] or "-V" in sys.argv[1:]:
    print("codex-cli 0.55.0"); sys.exit(0)
import termios, tty
LOG = os.path.join(os.path.expanduser("~"), "wh", "fakecodex.log")
def log(s):
    with open(LOG, "a", encoding="utf-8") as f: f.write(time.strftime("%H:%M:%S ") + s + "\n")
def out(s): os.write(1, s.encode())
fd = 0; old = termios.tcgetattr(fd); tty.setraw(fd)
try:
    out("\x1b[?2004h>_ OpenAI Codex (fake test stub, v0.55.0)\r\n\r\n› ")
    log("start " + " ".join(sys.argv[1:])[:200])
    buf = ""; history = ""
    while True:
        ch = os.read(fd, 4096).decode("utf-8", "replace")
        if not ch: break
        ch = re.sub(r"\x1b\[[0-9;?]*[A-Za-z~]", "", ch)  # bracketed-paste markers, arrows, focus reports
        for c in ch:
            if c in "\r":
                line = buf; buf = ""; history += line + "\n"; out("\r\n")
                log("input " + line[:200].replace("\n", " "))
                n = (re.findall(r"Y[0-9a-f]{12}", history) or ["?"])[-1]
                if "ROLEWK" in line or "manager dispatch" in line:
                    time.sleep(3)
                    out("• Working\r\n")
                    time.sleep(2)
                    out(f"---REPORT-START---\r\nworker report {n}\r\n---REPORT-END---\r\n")
                    log("printed REPORT " + n)
                else:
                    out("ok\r\n")
                out("\r\n› ")
            elif c in "\x7f\b":
                if buf: buf = buf[:-1]; out("\b \b")
            elif c == "\x03":
                log("ctrl-c"); buf = ""; out("^C\r\n› ")
            elif c == "\x15":
                out("\b \b" * len(buf)); buf = ""
            elif c == "\n":
                buf += "\n"; out("\r\n")
            elif c == "\x1b":
                pass
            else:
                buf += c; out(c)
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
