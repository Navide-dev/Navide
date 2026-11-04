# quitdlg.ps1 <pid>: wait up to 20 s for that process's "Quit Navide?" TaskDialog (#32770), bring it forward, press Enter
# (default button = Quit), then wait up to 30 s for the process to end. Writes uia.out.
param([int]$ProcId)
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class QD {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(P f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  public static IntPtr Find(uint pid) { IntPtr f = IntPtr.Zero;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p != pid || !IsWindowVisible(h)) return true;
      var c = new StringBuilder(64); GetClassName(h, c, 64); if (c.ToString() == "#32770") { f = h; return false; } return true; }, IntPtr.Zero);
    return f; } }
"@
$L = @(); function T { Get-Date -Format "HH:mm:ss.fff" }
$dlg = [IntPtr]::Zero
for ($i = 0; $i -lt 80 -and $dlg -eq [IntPtr]::Zero; $i++) { $dlg = [QD]::Find([uint32]$ProcId); if ($dlg -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 250 } }
if ($dlg -eq [IntPtr]::Zero) { $L += (T) + " no dialog" } else {
  $L += (T) + " dialog " + $dlg.ToString("X")
  [QD]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [QD]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [void][QD]::SetForegroundWindow($dlg); Start-Sleep -Milliseconds 500
  if ([QD]::GetForegroundWindow() -eq $dlg) { [System.Windows.Forms.SendKeys]::SendWait("{ENTER}"); $L += (T) + " Enter (Quit)" } else { $L += (T) + " dialog not foreground, nothing sent" }
}
for ($i = 0; $i -lt 60; $i++) { if (-not (Get-Process -Id $ProcId -EA 0)) { $L += (T) + " process $ProcId ended"; break }; Start-Sleep -Milliseconds 500 }
$L | Set-Content -Encoding utf8 "$env:USERPROFILE\wh\uia.out"
