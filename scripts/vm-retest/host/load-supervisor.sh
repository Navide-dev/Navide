#!/bin/bash
# load-supervisor.sh <linux|windows> <load file> <log> [paused seconds so far] [paused]
#   Watches the load file written by load-sampler.sh while wfull.py runs in the guest (its PID in <root>/wfull.pid).
#   Host 1-min load >= HI (default 40) for 30 s -> pause the whole VM (vm.sh pause) and log the time, the load and the
#   section in progress (that item is re-run afterwards); < LO (default 20) for 2 minutes -> unpause and log it.
#   Exits when wfull.py ends. When the total pause passes 1 hour it logs that once (the run owner reports it) and goes
#   on supervising. Pass "paused" as the fifth argument to take over a VM that is paused right now.
set -u
. "$(dirname "$0")/env.sh"
p="${1:-}"; need_platform "$p"; f="${2:-}"; log="${3:-}"; tot="${4:-0}"; HI="${HI:-40}"; LO="${LO:-20}"
[ -f "$f" ] && [ -n "$log" ] || die "usage: load-supervisor.sh <linux|windows> <load file> <log> [paused s]"
st="${5:-running}"; hi=0; lo=0; since=$(date +%s); warned=0; [ "$tot" -gt 3600 ] && warned=1
if [ "$p" = linux ]; then
  probe() { "$HERE/gsh.sh" linux 'kill -0 $(cat wfull.pid) 2>/dev/null && echo y || echo n' 2>/dev/null; }
  section() { "$HERE/gsh.sh" linux 'grep -h "^===" fpre.out fmid.out fpost.out 2>/dev/null | tail -1' 2>/dev/null; }
else
  probe() { "$HERE/gsh.sh" windows "if (Get-Process -Id ([int](Get-Content \$env:USERPROFILE\\wh\\wfull.pid)) -EA 0) { 'y' } else { 'n' }" 2>/dev/null | tr -d '\r'; }
  section() { "$HERE/gsh.sh" windows "(Select-String -Path \$env:USERPROFILE\\wh\\fpre.out,\$env:USERPROFILE\\wh\\fmid.out,\$env:USERPROFILE\\wh\\fpost.out -Pattern '^===' -EA 0 | Select -Last 1).Line" 2>/dev/null | tr -d '\r'; }
fi
# alive: the guest answered and wfull.py runs. An unanswered probe is not an end: the VM must still be on (vm.sh state),
# otherwise stop with a VM-gone line instead of a normal "wfull ended".
alive() {
  local r; r="$(probe)"
  case "$r" in *y*) return 0 ;; *n*) return 1 ;; esac
  if [ "$("$HERE/vm.sh" "$p" state)" != running ]; then echo "VM NOT RUNNING $(date +%T) (guest gone; total pause ${tot}s)" >> "$log"; exit 1; fi
  return 0
}
while [ "$st" = paused ] || alive; do
  l="$(tail -1 "$f" | awk '{print $2}')"; i="${l%.*}"
  if [ "$i" -ge "$HI" ]; then hi=$((hi+1)); else hi=0; fi
  if [ "$i" -lt "$LO" ]; then lo=$((lo+1)); else lo=0; fi
  if [ "$st" = running ] && [ "$hi" -ge 6 ]; then
    s="$(section)"; "$HERE/vm.sh" "$p" pause; st=paused; since=$(date +%s)
    echo "pause $(date +%T) load(1m) $(tail -6 "$f" | awk '{print $2}' | tr '\n' ' ')| in progress: $s (re-run it)" >> "$log"
  elif [ "$st" = paused ] && [ "$lo" -ge 24 ]; then
    if ! "$HERE/vm.sh" "$p" unpause; then echo "UNPAUSE FAILED $(date +%T) (VM state: $("$HERE/vm.sh" "$p" state))" >> "$log"; exit 1; fi
    st=running; tot=$((tot + $(date +%s) - since))
    echo "resume $(date +%T) load(1m) $(tail -1 "$f" | awk '{print $2, $3, $4}') | paused total ${tot}s" >> "$log"
  fi
  if [ "$warned" = 0 ] && [ "$st" = paused ] && [ $((tot + $(date +%s) - since)) -gt 3600 ]; then
    warned=1; echo "PAUSED OVER 1 HOUR $(date +%T) (still supervising)" >> "$log"; echo "paused over 1 hour"; fi
  sleep 5
done
echo "wfull ended $(date +%T); total pause ${tot}s" >> "$log"
