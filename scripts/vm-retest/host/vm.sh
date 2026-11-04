#!/bin/bash
# vm.sh <linux|windows> start|stop|revert|pause|unpause|ip|state
#   start    boot the VM headless (run it in the background and leave it: stopping a backgrounded `vmrun start`
#            takes the VM down with it)
#   stop     shut the guest down from inside (Linux: sudo poweroff, Windows: shutdown /s), then wait until vmrun
#            no longer lists it; falls back to `vmrun stop soft`
#   revert   revert to the platform's snapshot (VM must be off)
#   pause / unpause   freeze or resume the whole VM (used by load-supervisor.sh)
#   ip       the guest address; state: running or off
set -u
. "$(dirname "$0")/env.sh"
p="${1:-}"; cmd="${2:-}"; need_platform "$p"; vmx="$(vmx_of "$p")"
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
