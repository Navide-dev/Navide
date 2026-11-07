# wizard.py <root> open|cards|install <dep id>|trace start|trace stop: item (c) on Windows - the onboarding wizard
# re-detects before Install, so a Node installed outside Navide while the wizard is open is not installed again
# (no `winget install ... NodeJS`).
#   open        Settings -> "re-run the environment check" (opens the onboarding wizard in the wn window)
#   cards       the wizard's dependency cards and their buttons
#   install ID  clicks the Install button on the card whose text mentions ID
#   trace start|stop   Win32_ProcessStartTrace for winget / msiexec / npm / node in a background PowerShell (PID kept)
import json, os, subprocess, sys, time
ROOTP, STEP = sys.argv[1], sys.argv[2]; ARG2 = sys.argv[3] if len(sys.argv) > 3 else ""
sys.argv = [sys.argv[0], ROOTP, "status"]
exec(open(ROOTP + "/newtests.py", encoding="utf-8").read().split('\nif phase == "setup":')[0])
OUT = os.path.join(ROOTP, "wizard"); os.makedirs(OUT, exist_ok=True)
def page(): return Cdp(main_page(ws))
if STEP == "open":
    print("settings.open", json.dumps(ext("ui_invoke", {"workspace_path": ws, "action": "ui.settings.open"}))[:200]); time.sleep(3)
    print(page().ev("""(async()=>{let b=document.querySelector('[data-settings-section="general-environment"] .ap-reset');
      if(!b){const nav=[...document.querySelectorAll('button,a,li,div')].find(e=>e.children.length<=2&&/^(Appearance|外觀)$/i.test(e.textContent.trim()));
        if(nav){nav.click(); await new Promise(f=>setTimeout(f,1000));} b=document.querySelector('[data-settings-section="general-environment"] .ap-reset');}
      if(!b) return 'no .ap-reset'; const t=b.textContent.trim(); b.click(); await new Promise(f=>setTimeout(f,4000)); return 'clicked '+t;})()"""))
elif STEP == "cards":
    print(page().ev("""JSON.stringify([...document.querySelectorAll('.ob-btn')].map(b=>{let c=b; for(let i=0;i<6&&c;i++) c=c.parentElement;
      return [b.textContent.trim().slice(0,40), b.disabled, (c&&c.textContent||'').trim().replace(/\\s+/g,' ').slice(0,120)];}))"""))
elif STEP == "install":
    print(page().ev(f"""(()=>{{const bs=[...document.querySelectorAll('button.ob-btn.primary')];
      const b=bs.find(x=>{{let c=x; for(let i=0;i<6&&c;i++) c=c.parentElement; return c&&new RegExp({json.dumps(ARG2)},'i').test(c.textContent);}});
      if(!b) return 'no button'; const t=b.textContent.trim(); b.click(); return 'clicked '+t+' at '+new Date().toISOString();}})()"""))
elif STEP == "trace":
    log = os.path.join(OUT, "starts.txt"); ps = os.path.join(OUT, "trace.ps1"); pidf = os.path.join(OUT, "trace.pid")
    if ARG2 == "start":
        open(ps, "w", encoding="utf-8").write(f"""
Register-CimIndicationEvent -ClassName Win32_ProcessStartTrace -SourceIdentifier wz -Action {{
  $n = $Event.SourceEventArgs.NewEvent.ProcessName
  if ($n -match '^(winget|msiexec|npm|node|cmd|powershell|AppInstallerCLI|WindowsPackageManagerServer)') {{
    $p = $Event.SourceEventArgs.NewEvent.ProcessID; $c = (Get-CimInstance Win32_Process -Filter "ProcessId=$p" -EA 0).CommandLine
    Add-Content '{log}' ((Get-Date -Format 'HH:mm:ss.fff') + ' ' + $n + ' ' + $p + ' ' + $c) }} }} | Out-Null
while ($true) {{ Start-Sleep 1 }}
""")
        open(log, "w").close()
        p = subprocess.Popen(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps])
        open(pidf, "w").write(str(p.pid)); print("trace pid", p.pid)
    else:
        pid = open(pidf).read().strip(); subprocess.run(["taskkill", "/PID", pid, "/T", "/F"], capture_output=True)
        print(open(log, encoding="utf-8", errors="replace").read()[-6000:])
