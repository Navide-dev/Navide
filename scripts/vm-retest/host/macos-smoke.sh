#!/bin/bash
# macos-smoke.sh <artifact dir> <local out dir>: one macOS fresh-install smoke round, timed:
#   revert (fresh clone of MACOS_BASE) -> start -> macos-up.sh (install the dmg, start the app) -> guest/macsmoke.py
#   (first-launch wizard, first pane) -> collect.sh -> stop -> revert again, so the next round starts clean.
# Prints each step's start time and the round's total; exits non-zero if the smoke failed.
set -u
. "$(dirname "$0")/env.sh"
A="${1:-}"; out="${2:-}"; [ -d "$A" ] && [ -n "$out" ] || die "usage: macos-smoke.sh <artifact dir> <local out dir>"
mkdir -p "$out"; t0=$(date +%s); step() { echo "== $(date +%H:%M:%S) +$(( $(date +%s) - t0 ))s $*"; }
step revert; "$HERE/vm.sh" macos state | grep -qx off || die "the macos VM is running"; "$HERE/vm.sh" macos revert || die "revert failed"
step start;  "$HERE/vm.sh" macos start || die "start failed"
step install; "$HERE/macos-up.sh" "$A" || die "macos-up failed"
step smoke;  "$HERE/gsh.sh" macos 'export PATH=$HOME/.local/bin:/usr/local/bin:$PATH; python3 macsmoke.py ~/wh > macsmoke.out 2>&1; r=$?; cat macsmoke.out; exit $r'; rc=$?
step collect; "$HERE/collect.sh" macos "$out"
step stop;   "$HERE/vm.sh" macos stop
step revert; "$HERE/vm.sh" macos revert
step "done: smoke exit $rc, round $(( $(date +%s) - t0 )) s"
exit "$rc"
