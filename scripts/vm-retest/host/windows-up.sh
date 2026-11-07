#!/bin/bash
# windows-up.sh <artifact dir>: the Windows guest must be booted from its snapshot (vm.sh windows start).
#   1. auto logon for the test account: a new random password every round, generated here, sent only inside the
#      encoded PowerShell command, never printed or written down; the guest reboots into the desktop session
#   2. copies the guest scripts and the installer in, installs it silently (/S), points Claude Code at the stub,
#      enables CDP on 9223
#   3. starts the stub and the app through scheduled tasks in the desktop session at Normal priority. A process started
#      over ssh dies with the ssh session, and a plain `schtasks /Create` task runs at BelowNormal (priority 7), which
#      lets any Normal-priority load starve the app. Output is not redirected to a file: a child the app starts (an
#      external terminal) would inherit that handle and keep the file locked after the app quits.
set -u
. "$(dirname "$0")/env.sh"
A="${1:-}"; [ -d "$A" ] || die "usage: windows-up.sh <artifact dir with one .exe installer>"
exe=("$A"/*.exe); [ -f "${exe[0]}" ] || die "need one .exe in $A"; b="$(basename "${exe[0]}")"
wait_ssh() { for _ in $(seq 1 60); do "$HERE/gsh.sh" windows '"up"' 2>/dev/null | grep -q up && return 0; sleep 5; done; die "guest ssh not up"; }
wait_ssh
pw="Vm$(openssl rand -hex 12)x"
"$HERE/gsh.sh" windows "net user $WINDOWS_USER '$pw' | Out-Null; \$r='HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'; Set-ItemProperty \$r DefaultPassword '$pw'; New-Item -ItemType Directory -Force \$env:USERPROFILE\\wh | Out-Null; 'auto logon set'; shutdown /r /t 2"
unset pw
sleep 30; wait_ssh; sleep 25
"$HERE/gsh.sh" windows 'query user' 2>&1 | head -3
"$HERE/gcp.sh" windows put "$GUEST_DIR"/*.* "${exe[0]}" || die "copy failed"
echo "host sha256: $(shasum -a 256 "${exe[0]}" | cut -c1-64)  $b"
"$HERE/gsh.sh" windows "\$w=\"\$env:USERPROFILE\\wh\"; cd \$w; (Get-FileHash \$w\\$b).Hash
\$p=Start-Process \$w\\$b -ArgumentList '/S' -PassThru -Wait; 'install exit=' + \$p.ExitCode
python guest-setup.py \$w
New-Item -ItemType Directory -Force \$env:APPDATA\\agent-team | Out-Null
[IO.File]::WriteAllText(\"\$env:APPDATA\\agent-team\\cdp-debug.json\", '{\"enabled\":true,\"port\":9223}')
\$py=(Get-Command python).Source
\$set=New-ScheduledTaskSettingsSet -Priority 4 -ExecutionTimeLimit (New-TimeSpan -Hours 12)
\$who=New-ScheduledTaskPrincipal -UserId \$env:USERNAME -LogonType Interactive
Register-ScheduledTask -Force -TaskName wh-stub -Settings \$set -Principal \$who -Action (New-ScheduledTaskAction -Execute \$py -WorkingDirectory \$w -Argument \"stub.py 8951 \`\"echo x > RAN.txt\`\" \`\"\$w\\stub.log\`\"\") | Out-Null
Register-ScheduledTask -Force -TaskName wh-app -Settings \$set -Principal \$who -Action (New-ScheduledTaskAction -Execute \"\$env:LOCALAPPDATA\\Programs\\Navide\\Navide.exe\") | Out-Null
Start-ScheduledTask wh-stub; Start-ScheduledTask wh-app; Start-Sleep 30
'Navide processes: ' + @(Get-Process Navide -ErrorAction SilentlyContinue).Count
'CDP: ' + (Invoke-WebRequest -UseBasicParsing -TimeoutSec 4 http://127.0.0.1:9223/json).StatusCode"
