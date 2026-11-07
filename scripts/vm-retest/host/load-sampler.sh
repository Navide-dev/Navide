#!/bin/bash
# load-sampler.sh <out file>: every 5 s append "<epoch> <load1> <load5> <load15> vmx=<CPU% of the VMware VM processes>"
# for the VM host. Run it in the background and end it by the PID it prints when the round is over.
set -u
. "$(dirname "$0")/env.sh"
out="${1:-}"; [ -n "$out" ] || die "usage: load-sampler.sh <out file>"
sample='l=$(sysctl -n vm.loadavg | tr -d "{}"); c=$(ps -axo %cpu=,comm= | awk "/vmware-vmx/ {s+=\$1} END {printf \"%.1f\", s}"); echo "$(date +%s) $l vmx=$c"'
( while :; do
    if [ -z "$VM_HOST" ]; then bash -c "$sample"; else ssh -o BatchMode=yes "$VM_HOST" "$sample"; fi >> "$out"
    sleep 5
  done ) > /dev/null 2>&1 < /dev/null &  # detached from our stdout, so piping this script's output cannot hang
echo "sampler pid $!"
