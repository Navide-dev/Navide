# autologon.ps1 <user name in \uXXXX form or plain ASCII>: give that local account a new random password (made here,
# never printed), make it the auto-logon account (Winlogon DefaultUserName / DefaultPassword, as windows-up.sh does
# for the test account) and reboot into it.
param([string]$User)
$name = [regex]::Unescape($User)
$chars = (48..57) + (65..90) + (97..122); $pw = -join (1..24 | % { [char]($chars | Get-Random) })
Set-LocalUser -Name $name -Password (ConvertTo-SecureString $pw -AsPlainText -Force)
$r = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
Set-ItemProperty $r AutoAdminLogon '1'; Set-ItemProperty $r DefaultUserName $name; Set-ItemProperty $r DefaultPassword $pw
Set-ItemProperty $r DefaultDomainName $env:COMPUTERNAME
$pw = $null; "auto logon -> $name; rebooting"; shutdown /r /t 3
