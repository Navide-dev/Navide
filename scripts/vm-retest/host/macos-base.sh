#!/bin/bash
# macos-base.sh [image]: one-time, builds the clean base every macOS round is cloned from (MACOS_BASE). Rounds never boot
# the base itself: vm.sh macos revert clones it into MACOS_VM.
#   1. tart clone <image> (default ghcr.io/cirruslabs/macos-sequoia-vanilla:latest, a plain macOS with the test account
#      "admin", ssh on, auto logon; pulled once into the host's tart cache), 4 CPUs, 6 GB memory; an existing base keeps
#      its own settings
#   2. writes SSH_KEY's public half into MACOS_USER's authorized_keys while the VM is off: the host attaches disk.img
#      without mounting it, mounts only the guest's unencrypted "Data" volume (no sudo), appends the key, syncs, unmounts
#      and detaches (macos-keyw.sh, run on the VM host). No password is ever sent to the guest; if the volume is missing,
#      encrypted or needs sudo to mount, the script stops
#   3. boots it and installs Python from python.org (the guest scripts need python3; macOS has only a stub that asks
#      for Xcode tools) and Claude Code from its official installer, then shuts the guest down from inside
# Downloads: the host pulls only the cirruslabs image (ghcr.io/cirruslabs). The guest downloads exactly two things, both
# from their official source, because the smoke cannot run without them (approved by the commander, 2026-11-07):
#   - python.org's Python 3.12 pkg: the guest scripts use 3.12 syntax, and the image has no Python. It is installed
#     only if its sha256 equals PY_SHA256, the digest in python.org's own .sigstore bundle for that file (it also
#     matches the MD5 on the release page, and the pkg is Developer ID signed and notarized).
#   - claude.ai/install.sh, Claude Code's official installer: the wizard's Agents step and the first pane need the CLI.
set -u
. "$(dirname "$0")/env.sh"
IMG="${1:-ghcr.io/cirruslabs/macos-sequoia-vanilla:latest}"
PY_PKG="${PY_PKG:-https://www.python.org/ftp/python/3.12.10/python-3.12.10-macos11.pkg}"
PY_SHA256="${PY_SHA256:-8373e58da4ea146b3eb1c1f9834f19a319440b6b679b06050b1f9ee3237aa8e4}"
# an existing MACOS_BASE is reused (for example, cloned by hand while the image downloaded); steps 2 and 3 are idempotent
if ! tartr list --quiet | grep -qx "$MACOS_BASE"; then
  tartr clone "$IMG" "$MACOS_BASE" && tartr set "$MACOS_BASE" --cpu 4 --memory 6144 || die "clone failed"
fi
export MACOS_VM="$MACOS_BASE"
[ "$("$HERE/vm.sh" macos state)" = off ] || die "$MACOS_BASE must be off to write the key"
img="${TART_HOME:-\$HOME/.tart}/vms/$MACOS_BASE/disk.img"
if [ -z "$VM_HOST" ]; then out="$(bash "$HERE/macos-keyw.sh" "$(eval echo "$img")" "$(cat "$SSH_KEY.pub")" "$MACOS_USER")"
else out="$(ssh "${HOST_SSH_OPTS[@]}" "$VM_HOST" "bash -s -- \"$img\" $(printf '%q %q' "$(cat "$SSH_KEY.pub")" "$MACOS_USER")" < "$HERE/macos-keyw.sh")"; fi
echo "$out"; [ "$(echo "$out" | tail -1)" = key-ok ] || die "offline key write failed"
"$HERE/vm.sh" macos start
ip="$(guest_of macos)"; echo "base guest $ip"
"$HERE/gsh.sh" macos true || die "key login does not work"
"$HERE/gsh.sh" macos "set -e; sw_vers; mkdir -p ~/wh ~/dl; cd ~/dl
  [ -x /usr/local/bin/python3 ] || { curl -fsSLo py.pkg '$PY_PKG'; [ \"\$(shasum -a 256 py.pkg | cut -c1-64)\" = '$PY_SHA256' ] || { echo 'python pkg sha256 mismatch'; exit 1; }; sudo -n installer -pkg py.pkg -target /; /usr/bin/trash py.pkg; }
  /usr/local/bin/python3 --version
  [ -x ~/.local/bin/claude ] || { curl -fsSLo claude-install.sh https://claude.ai/install.sh; bash claude-install.sh; /usr/bin/trash claude-install.sh; }
  ~/.local/bin/claude --version" || die "base install failed"
# the base is shut down from inside only (sync first): tart stop can drop writes the guest has not flushed yet
"$HERE/gsh.sh" macos 'sync; sudo -n shutdown -h now' >/dev/null 2>&1
for _ in $(seq 1 36); do [ "$("$HERE/vm.sh" macos state)" = off ] && break; sleep 5; done
[ "$("$HERE/vm.sh" macos state)" = off ] || die "$MACOS_BASE did not shut down from inside; it is left running (no tart stop)"
tartr list
