#!/usr/bin/env bash
# Backend release gate, run away from the release machine's real keychain.
#
# release.sh signs with the login keychain, so the gate cannot run inside a
# sandbox as a whole; this script isolates only the backend tests:
#   - env -i with a throwaway HOME and TMPDIR,
#   - a fake `security` first on PATH that only logs and fails,
#   - on macOS, sandbox-exec denying exec of /usr/bin/security.
# The few files that need setuid `ps` or the pane helper's own spawn (which the
# sandbox also blocks) run in a
# second pass with the same environment but without sandbox-exec; the
# conftest guard keeps /usr/bin/security out of reach there too. The earlier
# release gates have already synced backend/.venv, so these runs use --no-sync
# and never resolve packages under the throwaway HOME.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UV="$(command -v uv)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/navide-release-pytest.XXXXXX")"
mkdir -p "$SCRATCH/home" "$SCRATCH/tmp" "$SCRATCH/bin"
trap 'rm -rf "$SCRATCH"' EXIT
FAKE_LOG="$SCRATCH/fake-security.log"
cat > "$SCRATCH/bin/security" <<'EOF'
#!/bin/sh
echo "fake-security $*" >> "${SAFE_PYTEST_LOG:-/dev/null}"
exit 44
EOF
chmod +x "$SCRATCH/bin/security"
echo "release-backend-tests: HOME=$SCRATCH/home" >&2

NO_SANDBOX_FILES=(
  backend/tests/cli_regression/test_isolation.py
  backend/tests/test_osplat_darwin_pane_helper.py
  backend/tests/test_proc_rusage.py
  backend/tests/test_host_shell_tree_kill.py
  backend/tests/test_pty_registry.py
  backend/tests/test_terminals_breakaway_kill.py
  backend/tests/test_terminals_exit_orphan_reap.py
)

# The main pass runs on four pytest-xdist workers, one file at a time each,
# as CI does, then the tests marked `serial` (wall-clock timed) run alone.
# The small no-sandbox pass (PTY, setuid ps, process reaping) stays serial.
XDIST=(-n 4 --dist loadfile -m "not serial")

isolated() {
  env -i HOME="$SCRATCH/home" USER="$USER" LANG=en_US.UTF-8 TMPDIR="$SCRATCH/tmp" \
    SAFE_PYTEST_LOG="$FAKE_LOG" \
    PATH="$SCRATCH/bin:$ROOT/backend/.venv/bin:$(dirname "$UV"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    "$@"
}

cd "$ROOT"
if [[ "$(uname)" == "Darwin" ]]; then
  SB="$SCRATCH/deny-security.sb"
  printf '(version 1)\n(allow default)\n(deny process-exec (literal "/usr/bin/security"))\n' > "$SB"
  deselects=()
  # --deselect, not --ignore: the CLI regression inventory checks a full
  # collection, so these files must still be collected in this pass. Node ids
  # are relative to backend/, pytest's rootdir.
  for f in "${NO_SANDBOX_FILES[@]}"; do deselects+=("--deselect=${f#backend/}"); done
  isolated /usr/bin/sandbox-exec -f "$SB" "$UV" --project backend run --no-sync pytest backend/tests "${XDIST[@]}" "${deselects[@]}"
  isolated /usr/bin/sandbox-exec -f "$SB" "$UV" --project backend run --no-sync pytest backend/tests -m serial "${deselects[@]}"
  isolated "$UV" --project backend run --no-sync pytest "${NO_SANDBOX_FILES[@]}"
else
  isolated "$UV" --project backend run --no-sync pytest backend/tests "${XDIST[@]}"
  isolated "$UV" --project backend run --no-sync pytest backend/tests -m serial
fi

if [[ -s "$FAKE_LOG" ]]; then
  echo "release-backend-tests: tests called \`security\` $(wc -l < "$FAKE_LOG") time(s); the fake answered:" >&2
  cat "$FAKE_LOG" >&2
fi
