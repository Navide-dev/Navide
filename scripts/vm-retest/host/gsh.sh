#!/bin/bash
# gsh.sh <linux|windows> [command]: run a command in the guest's test account (command text from the argument, or stdin).
#   linux:   a bash command line, run in the guest root (~/wh by default)
#   windows: PowerShell text, sent as -EncodedCommand (no quoting layer in between); $env:USERPROFILE\wh is the root.
#            Prefix the text with "py:" to run a cmd.exe line in the root with UTF-8 Python instead.
set -u
. "$(dirname "$0")/env.sh"
p="${1:-}"; need_platform "$p"; shift
s="${1:-$(cat)}"
dest="$(user_of "$p")@$(guest_of "$p")"
if [ "$p" = linux ]; then
  exec ssh "${SSH_OPTS[@]}" "$dest" "cd ~/wh 2>/dev/null; $s"
fi
case "$s" in
  py:*) s="\$env:PYTHONUTF8='1'; \$env:PYTHONIOENCODING='utf-8'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; cd \$env:USERPROFILE\\wh; cmd /c '${s#py:} 2>&1'" ;;
esac
b="$(python3 -c 'import sys,base64;print(base64.b64encode(("$ProgressPreference=\"SilentlyContinue\";"+sys.argv[1]).encode("utf-16-le")).decode())' "$s")"
exec ssh "${SSH_OPTS[@]}" "$dest" "powershell -NoProfile -EncodedCommand $b"
