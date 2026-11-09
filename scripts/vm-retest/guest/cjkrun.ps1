# cjkrun.ps1 <installer path>: with 測試員 logged on at the console, install Navide (/S, per-user) and start it in
# that desktop session through an Interactive scheduled task, then report what came up under C:\Users\測試員.
param([string]$Installer)
$name = [string]::new([char[]]@(0x6E2C, 0x8A66, 0x54E1))
$pub = 'C:\Users\Public\wh-a'; New-Item -ItemType Directory -Force $pub | Out-Null; Copy-Item $Installer "$pub\NavideSetup.exe" -Force
Set-Content -Encoding ASCII "$pub\run.cmd" "`"$pub\NavideSetup.exe`" /S`r`nstart `"`" `"%LOCALAPPDATA%\Programs\Navide\Navide.exe`""
$who = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$name" -LogonType Interactive
Register-ScheduledTask -Force -TaskName wh-a-run -Principal $who -Action (New-ScheduledTaskAction -Execute "$pub\run.cmd") -Settings (New-ScheduledTaskSettingsSet -Priority 4) | Out-Null
Start-ScheduledTask wh-a-run; "started " + (Get-Date -Format HH:mm:ss)
Start-Sleep 150
$prof = (Get-CimInstance Win32_UserProfile | ? { $_.LocalPath -like "*\$name" }).LocalPath
"installed: " + (Test-Path (Join-Path $prof 'AppData\Local\Programs\Navide\Navide.exe')) + "  task result " + (Get-ScheduledTaskInfo wh-a-run).LastTaskResult
$mine = Get-CimInstance Win32_Process | ? { $_.Name -in 'Navide.exe', 'agent_team_backend.exe' -and $_.CommandLine -notmatch '--type=' } | ? { (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User -eq $name }
"main processes as the user: " + (($mine | % { $_.Name + ':' + $_.ProcessId }) -join ', ')
$L = Join-Path $prof 'AppData\Roaming\agent-team'; "data dir: " + (Test-Path $L); Get-ChildItem $L -EA 0 | % Name
"backend.log:"; Get-Content (Join-Path $L 'logs\backend.log') -Encoding UTF8 -EA 0 | Select-String -Pattern 'ready|listening|port|started|ERROR|Traceback|Unicode' | select -First 8 | % Line
"main.log:"; Get-Content (Join-Path $L 'logs\main.log') -Encoding UTF8 -EA 0 | Select-String -Pattern 'backend|error|exit' | select -First 8 | % Line
