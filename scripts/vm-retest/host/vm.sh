#!/bin/bash
# vm.sh <linux|windows|macos> start|stop|revert|pause|unpause|ip|state
#   start    boot the VM headless (run it in the background and leave it: stopping a backgrounded `vmrun start`
#            takes the VM down with it)
#   stop     shut the guest down from inside (Linux: sudo poweroff, Windows: shutdown /s), then wait until vmrun
#            no longer lists it; falls back to `vmrun stop soft`
#   revert   revert to the platform's snapshot (VM must be off)
#   pause / unpause   freeze or resume the whole VM (used by load-supervisor.sh)
#   ip       the guest address; state: running or off
#   macos (tart): start runs `tart run --no-graphics` detached on the VM host (PID in ~/vm-retest-tart/run.pid there);
#            stop shuts the guest down from inside, falls back to `tart stop`; revert deletes the round's clone and
#            clones MACOS_BASE again (an APFS copy-on-write clone: seconds, no extra disk); pause/unpause are not used
set -u
. "$(dirname "$0")/env.sh"
p="${1:-}"; cmd="${2:-}"; need_any_platform "$p"
if [ "$p" = macos ]; then
  onhost() { if [ -z "$VM_HOST" ]; then bash -c "$1"; else ssh "${HOST_SSH_OPTS[@]}" "$VM_HOST" "$1"; fi; }
  mstate() { tartr list --format json | python3 -c 'import json,sys; v=[x for x in json.load(sys.stdin) if x["Name"]==sys.argv[1]]; print(v[0]["State"] if v else "missing")' "$MACOS_VM"; }
  case "$cmd" in
    start)  [ "$(mstate)" = stopped ] || die "$MACOS_VM is $(mstate)"
            onhost "mkdir -p ~/vm-retest-tart; nohup $(printf '%q ' "$TART") run --no-graphics $(printf '%q' "$MACOS_VM") > ~/vm-retest-tart/run.log 2>&1 < /dev/null & echo \$! > ~/vm-retest-tart/run.pid; echo started \$(cat ~/vm-retest-tart/run.pid)" ;;
    stop)
      if [ "$(mstate)" = running ]; then
        "$HERE/gsh.sh" macos 'sudo -n shutdown -h now' >/dev/null 2>&1
        for _ in $(seq 1 36); do [ "$(mstate)" = running ] || break; sleep 5; done
        [ "$(mstate)" = running ] && tartr stop "$MACOS_VM"
      fi
      [ "$(mstate)" = running ] && die "macos VM is still running" || echo "macos VM is off" ;;
    revert) [ "$(mstate)" = running ] && die "stop the macos VM first"
            [ "$(mstate)" = missing ] || tartr delete "$MACOS_VM"
            tartr clone "$MACOS_BASE" "$MACOS_VM" && echo "macos reverted: $MACOS_VM cloned from $MACOS_BASE" ;;
    ip)     guest_of macos ;;
    state)  [ "$(mstate)" = running ] && echo running || echo off ;;
    *) die "usage: vm.sh macos start|stop|revert|ip|state" ;;
  esac
  exit 0
fi
need_platform "$p"; vmx="$(vmx_of "$p")"
running() { vmr list | grep -qF "$vmx"; }
case "$cmd" in
  start)   vmr start "$vmx" nogui ;;
  stop)
    if running; then
      if [ "$p" = linux ]; then "$HERE/gsh.sh" linux 'sudo -n poweroff' >/dev/null 2>&1
      else "$HERE/gsh.sh" windows 'shutdown /s /f /t 1' >/dev/null 2>&1; fi
      for _ in $(seq 1 36); do running || break; sleep 5; done
      running && vmr stop "$vmx" soft
      for _ in $(seq 1 24); do running || break; sleep 5; done
    fi
    running && die "$p VM is still running" || echo "$p VM is off" ;;
  revert)  running && die "stop the $p VM first"; vmr revertToSnapshot "$vmx" "$(snapshot_of "$p")" && echo "$p reverted to $(snapshot_of "$p")" ;;
  pause)   vmr pause "$vmx" ;;
  unpause) vmr unpause "$vmx" ;;
  ip)      guest_of "$p" ;;
  state)   running && echo running || echo off ;;
  *) die "usage: vm.sh <linux|windows> start|stop|revert|pause|unpause|ip|state" ;;
esac
