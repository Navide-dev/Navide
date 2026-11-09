#!/bin/bash
# vnc.sh <linux|windows> <vncdo actions...>: run vncdo against the VM's VNC server (the vmx RemoteDisplay.vnc.*:
# 127.0.0.1 on the VM host). With VM_HOST set, the call goes through an ssh tunnel opened for it and ended by its PID.
#   VNC_PASSWORD  the vmx RemoteDisplay.vnc.password (never written to a file by these scripts)
#   VNC_PORT_LINUX (5902) / VNC_PORT_WINDOWS (5903)   the vmx RemoteDisplay.vnc.port
set -u
. "$(dirname "$0")/env.sh"
p="${1:-}"; need_platform "$p"; shift
[ -n "${VNC_PASSWORD:-}" ] || die "vnc.sh: set VNC_PASSWORD (the vmx RemoteDisplay.vnc.password)"
case "$p" in linux) port="${VNC_PORT_LINUX:-5902}" ;; windows) port="${VNC_PORT_WINDOWS:-5903}" ;; esac
if [ -z "$VM_HOST" ]; then exec vncdo -s "127.0.0.1::$port" -p "$VNC_PASSWORD" "$@"; fi
lp=$(( 20000 + RANDOM % 20000 ))
ssh "${HOST_SSH_OPTS[@]}" -o ExitOnForwardFailure=yes -N -L "127.0.0.1:$lp:127.0.0.1:$port" "$VM_HOST" & tp=$!
for _ in $(seq 1 50); do nc -z 127.0.0.1 "$lp" 2>/dev/null && break; kill -0 "$tp" 2>/dev/null || break; sleep 0.2; done
vncdo -s "127.0.0.1::$lp" -p "$VNC_PASSWORD" "$@"; rc=$?
kill "$tp" 2>/dev/null; wait "$tp" 2>/dev/null
exit $rc
