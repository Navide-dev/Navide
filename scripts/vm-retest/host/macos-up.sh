#!/bin/bash
# macos-up.sh <artifact dir>: the macOS guest must be booted from a fresh clone (vm.sh macos revert, vm.sh macos start).
# Copies the guest scripts and the .dmg in and installs the app the way a person does: mount the dmg, copy Navide.app to
# /Applications, eject. Records Gatekeeper's verdict (spctl), points Claude Code at the local stub, starts the stub (PID in
# stub.pid) and the app with `open` in the auto-logged-in desktop session (CDP on 9223). Output also lands in macup.out.
# The cirruslabs image ships with Gatekeeper assessments disabled (spctl prints "override=security disabled"), which
# would make the spctl verdict prove only the signature and notarization. Gatekeeper is turned on first, and the round
# stops if that fails.
set -u
. "$(dirname "$0")/env.sh"
A="${1:-}"; [ -d "$A" ] || die "usage: macos-up.sh <artifact dir with one .dmg>"
dmg=("$A"/*.dmg); [ -f "${dmg[0]}" ] || die "need one .dmg in $A"; b="$(basename "${dmg[0]}")"
for _ in $(seq 1 60); do "$HERE/gsh.sh" macos true 2>/dev/null && break; sleep 5; done
"$HERE/gsh.sh" macos 'mkdir -p ~/wh' || die "guest ssh not up"
"$HERE/gcp.sh" macos put "$GUEST_DIR"/*.* "${dmg[0]}" || die "copy failed"
"$HERE/gsh.sh" macos 'sudo -n spctl --global-enable && spctl --status | grep -qx "assessments enabled"' \
  || die "could not enable Gatekeeper in the guest (sudo -n spctl --global-enable)"
echo "host sha256: $(shasum -a 256 "${dmg[0]}" | cut -c1-64)  $b"
"$HERE/gsh.sh" macos "export PATH=\$HOME/.local/bin:/usr/local/bin:\$PATH; {
  shasum -a 256 '$b' | cut -c1-64
  m=\$(hdiutil attach -nobrowse -noautoopen '$b' | awk -F'\t' '/\\/Volumes\\//{print \$NF}' | tail -1); echo \"mounted \$m\"
  ditto \"\$m/Navide.app\" /Applications/Navide.app && hdiutil detach -quiet \"\$m\" && echo 'installed /Applications/Navide.app'
  spctl -a -vv -t exec /Applications/Navide.app 2>&1
  claude --version; python3 guest-setup.py ~/wh
  d=~/Library/'Application Support'/agent-team; mkdir -p \"\$d\"; echo '{\"enabled\":true,\"port\":9223}' > \"\$d/cdp-debug.json\"
  (nohup python3 stub.py 8951 'touch RAN.txt' \$HOME/wh/stub.log > stub.out 2>&1 < /dev/null & echo \$! > stub.pid)
  t0=\$(date +%s); open -a /Applications/Navide.app
  for i in \$(seq 1 60); do curl -s -m2 http://127.0.0.1:9223/json | grep -q webSocketDebuggerUrl && break; sleep 1; done
  echo \"CDP up after \$(( \$(date +%s) - t0 )) s: \$(curl -s -m3 http://127.0.0.1:9223/json | grep -c webSocketDebuggerUrl) page(s)\"
} 2>&1 | tee macup.out"
