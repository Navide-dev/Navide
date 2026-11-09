#!/bin/bash
# browser-allow.sh linux [seconds]: answer Navide's native "Agent wants to use web pages" dialog with Allow.
# The first write-type Navide Browser call (browser_open / act / handoff / take_over / finish) in a workspace raises
# that GTK dialog; Navide keeps the answer per workspace and app version, so it appears once per workspace each round.
# Until someone answers it the call ends in host_timeout. It is a native window, so CDP screenshots do not show it,
# and it sits over whichever Navide window is in front, not necessarily the calling workspace's.
# Start this in the background before the browser item; it polls the guest's X tree (xwininfo) and clicks Allow
# over VNC (vnc.sh; the right-hand button, 22 px above the dialog's bottom edge). Exits after the first click or the timeout.
set -u
. "$(dirname "$0")/env.sh"
p="${1:-}"; secs="${2:-120}"; need_platform "$p"
[ "$p" = linux ] || die "browser-allow.sh: linux only (Windows uses a different dialog path)"
[ -n "${VNC_PASSWORD:-}" ] || die "browser-allow.sh: set VNC_PASSWORD (the vmx remotedisplay.vnc.password)"
end=$(( $(date +%s) + secs ))
while [ "$(date +%s)" -lt "$end" ]; do
  g="$("$HERE/gsh.sh" linux 'DISPLAY=:0 XAUTHORITY=$(ls /run/user/1000/.mutter-Xwaylandauth.* | head -1) xwininfo -root -tree 2>/dev/null | grep "\"Agent wants to use web pages\"" | grep -oE "[0-9]+x[0-9]+\+[0-9]+\+[0-9]+" | head -1')"
  if [ -n "$g" ]; then
    IFS='x+' read -r w h x y <<< "$g"
    cx=$(( x + w * 3 / 4 )); cy=$(( y + h - 22 ))
    "$HERE/vnc.sh" linux move "$cx" "$cy" click 1
    echo "browser-allow: dialog $g, clicked Allow at $cx,$cy $(date +%T)"; exit 0
  fi
  sleep 1
done
echo "browser-allow: no dialog within ${secs}s"
