#!/bin/bash
# linux-app.sh start|stop: the packaged app (/opt/Navide/navide) in the guest's desktop session, CDP on 9223
case "$1" in
 start)
  export XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus WAYLAND_DISPLAY=wayland-0 DISPLAY=:0
  export XAUTHORITY=$(ls /run/user/1000/.mutter-Xwaylandauth.* | head -1) PATH=$HOME/.local/bin:$PATH
  mkdir -p ~/.config/agent-team; echo '{"enabled":true,"port":9223}' > ~/.config/agent-team/cdp-debug.json
  setsid nohup /opt/Navide/navide > ~/wh/app.out 2>&1 < /dev/null &
  echo $! > ~/wh/app.pid; cat ~/wh/app.pid ;;
 stop)
  pid=$(cat ~/wh/app.pid); kill "$pid"; for i in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done; kill -0 "$pid" 2>/dev/null && echo still-alive || echo stopped ;;
esac
