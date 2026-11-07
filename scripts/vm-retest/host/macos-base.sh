#!/bin/bash
# macos-base.sh [image]: one-time, builds the clean base every macOS round is cloned from (MACOS_BASE). Rounds never boot
# the base itself: vm.sh macos revert clones it into MACOS_VM.
#   1. tart clone <image> (default ghcr.io/cirruslabs/macos-sequoia-vanilla:latest, a plain macOS with the test account
#      "admin", ssh on, auto logon; pulled once into the host's tart cache), 4 CPUs, 6 GB memory
#   2. boots it and installs SSH_KEY's public half for MACOS_USER. The image's documented default password is used
#      for that one login only, through SSH_ASKPASS (a 0700 temp helper, removed right after); it is never printed
#   3. installs Python from python.org (the guest scripts need python3; macOS has only a stub that asks for Xcode tools)
#      and Claude Code from its official installer, then shuts the guest down
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
tartr list --quiet | grep -qx "$MACOS_BASE" || tartr clone "$IMG" "$MACOS_BASE" || die "clone failed"
tartr set "$MACOS_BASE" --cpu 4 --memory 6144
export MACOS_VM="$MACOS_BASE"
"$HERE/vm.sh" macos start
ip="$(guest_of macos)"; echo "base guest $ip"
ap="$(mktemp -d)/ap"; printf '#!/bin/sh\necho admin\n' > "$ap"; chmod 700 "$ap"
pub="$(cat "$SSH_KEY.pub")"
for _ in $(seq 1 30); do
  SSH_ASKPASS="$ap" SSH_ASKPASS_REQUIRE=force DISPLAY=none ssh -o BatchMode=no -o PubkeyAuthentication=no \
    -o PreferredAuthentications=password,keyboard-interactive "${SSH_OPTS[@]}" "$MACOS_USER@$ip" \
    "mkdir -p ~/.ssh && chmod 700 ~/.ssh && grep -qxF '$pub' ~/.ssh/authorized_keys 2>/dev/null || echo '$pub' >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys; echo key-ok" < /dev/null && break
  sleep 5
done
/usr/bin/trash "$(dirname "$ap")"
"$HERE/gsh.sh" macos true || die "key login does not work"
"$HERE/gsh.sh" macos "set -e; sw_vers; mkdir -p ~/wh ~/dl; cd ~/dl
  [ -x /usr/local/bin/python3 ] || { curl -fsSLo py.pkg '$PY_PKG'; [ \"\$(shasum -a 256 py.pkg | cut -c1-64)\" = '$PY_SHA256' ] || { echo 'python pkg sha256 mismatch'; exit 1; }; sudo -n installer -pkg py.pkg -target /; /usr/bin/trash py.pkg; }
  /usr/local/bin/python3 --version
  [ -x ~/.local/bin/claude ] || { curl -fsSLo claude-install.sh https://claude.ai/install.sh; bash claude-install.sh; /usr/bin/trash claude-install.sh; }
  ~/.local/bin/claude --version" || die "base install failed"
"$HERE/vm.sh" macos stop
tartr list
