#!/bin/bash
# restart-app.sh <linux|windows> [quit]: quit the app as a person would, check nothing is left, start it again
# (with "quit", stop after quitting).
#   windows: CDP Browser.close raises the native "Quit Navide?" TaskDialog. Its buttons are not visible to UI
#            Automation, so guest/quitdlg.ps1 finds it with EnumWindows, brings it forward and presses Enter (the
#            default button is Quit). It has to run in the desktop session, hence a scheduled task.
#   linux:   linux-app.sh stop ends the recorded app PID (SIGTERM, the app's own quit path) and waits for it.
set -u
. "$(dirname "$0")/env.sh"
p="${1:-}"; mode="${2:-restart}"; need_platform "$p"
if [ "$p" = linux ]; then
  "$HERE/gsh.sh" linux "bash linux-app.sh stop; pgrep -u \$(id -u) -c -x navide || true"
  [ "$mode" = quit ] || "$HERE/gsh.sh" linux "bash linux-app.sh start"
  exit 0
fi
"$HERE/gsh.sh" windows "\$w=\"\$env:USERPROFILE\\wh\"
\$m=(Get-CimInstance Win32_Process | ? { \$_.Name -eq 'Navide.exe' -and \$_.CommandLine -notmatch '--type=' }).ProcessId
'main pid ' + \$m
\$who=New-ScheduledTaskPrincipal -UserId \$env:USERNAME -LogonType Interactive
Register-ScheduledTask -Force -TaskName wh-quitdlg -Principal \$who -Action (New-ScheduledTaskAction -Execute powershell.exe -Argument \"-NoProfile -ExecutionPolicy Bypass -File \`\"\$w\\quitdlg.ps1\`\" \$m\") | Out-Null
Start-ScheduledTask wh-quitdlg; Start-Sleep 2"
"$HERE/gsh.sh" windows 'py:python quitapp.py %USERPROFILE%\'"wh"
sleep 20
"$HERE/gsh.sh" windows "Get-Content \$env:USERPROFILE\\wh\\uia.out
'left: Navide ' + @(Get-Process Navide -EA 0).Count + ', backend ' + @(Get-Process agent_team_backend -EA 0).Count + ', claude ' + @(Get-Process claude -EA 0).Count"
[ "$mode" = quit ] || "$HERE/gsh.sh" windows "Start-ScheduledTask wh-app; 'app started ' + (Get-Date -Format HH:mm:ss.fff)"
