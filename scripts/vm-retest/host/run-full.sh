#!/bin/bash
# run-full.sh <linux|windows> pre|post: start one half of the full list (guest/wfull.py) detached in the guest, so it
# survives the ssh session. Output: <root>/fpre.out or fpost.out; the guest PID is printed and kept in wfull.pid.
#   linux:   setsid nohup (its own process group, so load-supervisor.sh can also tell it apart)
#   windows: a scheduled task in the desktop session at Normal priority (wh-wfull-<half>)
set -u
. "$(dirname "$0")/env.sh"
p="${1:-}"; half="${2:-}"; need_platform "$p"
case "$half" in pre|post) ;; *) die "usage: run-full.sh <linux|windows> pre|post" ;; esac
if [ "$p" = linux ]; then
  "$HERE/gsh.sh" linux "setsid nohup python3 wfull.py \$HOME/wh $half > f$half.out 2>&1 < /dev/null & echo \$! > wfull.pid; cat wfull.pid"
else
  "$HERE/gsh.sh" windows "\$w=\"\$env:USERPROFILE\\wh\"; \$py=(Get-Command python).Source
Set-Content -Encoding ASCII \"\$w\\wfull-$half.cmd\" \"set PYTHONUTF8=1\`r\`ncd /d \`\"\$w\`\"\`r\`n\`\"\$py\`\" \`\"\$w\\wfull.py\`\" \`\"\$w\`\" $half > \`\"\$w\\f$half.out\`\" 2>&1\"
\$set=New-ScheduledTaskSettingsSet -Priority 4 -ExecutionTimeLimit (New-TimeSpan -Hours 12)
\$who=New-ScheduledTaskPrincipal -UserId \$env:USERNAME -LogonType Interactive
Register-ScheduledTask -Force -TaskName wh-wfull-$half -Settings \$set -Principal \$who -Action (New-ScheduledTaskAction -Execute \"\$w\\wfull-$half.cmd\") | Out-Null
Start-ScheduledTask wh-wfull-$half; Start-Sleep 4
\$id=(Get-CimInstance Win32_Process | ? { \$_.Name -eq 'python.exe' -and \$_.CommandLine -match 'wfull.py' }).ProcessId | Select -First 1
Set-Content \"\$w\\wfull.pid\" \$id; \$id"
fi
