#!/bin/bash
# collect.sh <linux|windows> <local out dir>: copy the round's evidence out of the guest before the VM is reverted:
#   fpre.out / fpost.out (the full list), results.jsonl, the totals (guest/totals.py), stub.log, the app's backend.log,
#   and every run log of the test workspaces (as one archive).
set -u
. "$(dirname "$0")/env.sh"
p="${1:-}"; need_platform "$p"; out="${2:-}"; [ -n "$out" ] || die "usage: collect.sh <linux|windows> <local out dir>"
mkdir -p "$out"
if [ "$p" = linux ]; then
  "$HERE/gsh.sh" linux 'python3 totals.py > totals.txt 2>&1; cp ~/.local/share/Agent-Team/logs/backend.log backend.log 2>/dev/null
    tar czf evidence.tgz fpre.out fpost.out results.jsonl totals.txt stub.log backend.log w*/.agent-team/runs sw/.agent-team/runs 2>/dev/null; ls -la evidence.tgz'
  "$HERE/gcp.sh" linux get evidence.tgz "$out"
else
  "$HERE/gsh.sh" windows 'py:python totals.py > totals.txt'
  "$HERE/gsh.sh" windows "\$w=\"\$env:USERPROFILE\\wh\"; \$t=\"\$w\\evcopy\"; New-Item -ItemType Directory -Force \$t | Out-Null
\$fs=[IO.File]::Open(\"\$env:APPDATA\\Agent-Team\\logs\\backend.log\",'Open','Read','ReadWrite'); \$o=[IO.File]::Create(\"\$t\\backend.log\"); \$fs.CopyTo(\$o); \$o.Close(); \$fs.Close()
\$runs=Get-ChildItem \$w -Directory | % { Join-Path \$_.FullName '.agent-team\\runs' } | ? { Test-Path \$_ }
\$items=@(\"\$w\\fpre.out\",\"\$w\\fpost.out\",\"\$w\\results.jsonl\",\"\$w\\totals.txt\",\"\$w\\stub.log\",\"\$t\\backend.log\") + \$runs | ? { Test-Path \$_ }
Compress-Archive -Force -Path \$items -DestinationPath \"\$w\\evidence.zip\"; (Get-Item \"\$w\\evidence.zip\").Length"
  "$HERE/gcp.sh" windows get evidence.zip "$out"
fi
ls -la "$out"
