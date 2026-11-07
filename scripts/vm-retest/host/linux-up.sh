#!/bin/bash
# linux-up.sh <artifact dir>: the Linux guest must be booted from its snapshot (vm.sh linux start). Copies the guest
# scripts, the .deb and the .AppImage in, installs the .deb, points Claude Code at the local stub, starts the stub
# (PID in stub.pid) and the app (PID in app.pid, CDP on 9223).
set -u
. "$(dirname "$0")/env.sh"
A="${1:-}"; [ -d "$A" ] || die "usage: linux-up.sh <artifact dir with one .deb and one .AppImage>"
deb=("$A"/*.deb); img=("$A"/*.AppImage)
[ -f "${deb[0]}" ] && [ -f "${img[0]}" ] || die "need one .deb and one .AppImage in $A"
for _ in $(seq 1 40); do "$HERE/gsh.sh" linux true 2>/dev/null && break; sleep 3; done
"$HERE/gsh.sh" linux "sudo -n date -s '$(date -u '+%Y-%m-%d %H:%M:%S') UTC' >/dev/null; mkdir -p ~/wh"
"$HERE/gcp.sh" linux put "$GUEST_DIR"/*.* "${deb[0]}" "${img[0]}" || die "copy failed"
echo "host sha256: $(shasum -a 256 "${deb[0]}" | cut -c1-64)  $(basename "${deb[0]}")"
"$HERE/gsh.sh" linux "export PATH=\$HOME/.local/bin:\$PATH; sha256sum $(basename "${deb[0]}") | cut -c1-64; sudo -n apt-get -o DPkg::Lock::Timeout=900 -y install ./$(basename "${deb[0]}") 2>&1 | tail -1
  chmod +x $(basename "${img[0]}") linux-app.sh; claude --version; python3 guest-setup.py ~/wh
  (setsid nohup python3 stub.py 8951 'touch RAN.txt' \$HOME/wh/stub.log > stub.out 2>&1 < /dev/null & echo \$! > stub.pid)
  sleep 1; bash linux-app.sh start; sleep 20; curl -s -m3 http://127.0.0.1:9223/json | grep -c webSocketDebuggerUrl"
