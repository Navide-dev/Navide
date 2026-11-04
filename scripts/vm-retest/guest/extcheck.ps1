# extcheck.ps1 <tag>: run inside the external terminal Navide opened; records what that shell sees, then runs the codex install
param([string]$Tag = "x")
$o = "$env:USERPROFILE\wh\ext-$Tag.txt"
$tail = ($env:Path -split ';' | ? { $_ }) | Select-Object -Last 3
@("start " + (Get-Date -Format HH:mm:ss), "path tail: " + ($tail -join ' | '), "npm: " + ((Get-Command npm -EA 0).Source), "parent chain: " + ((Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId)) | Set-Content -Encoding utf8 $o
npm install -g @openai/codex 2>&1 | Select-Object -Last 3 | Add-Content -Encoding utf8 $o
("npm exit " + $LASTEXITCODE + " at " + (Get-Date -Format HH:mm:ss)) | Add-Content -Encoding utf8 $o
("codex: " + ((Get-Command codex -EA 0).Source)) | Add-Content -Encoding utf8 $o
