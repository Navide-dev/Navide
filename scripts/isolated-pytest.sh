#!/usr/bin/env bash
# Runs backend pytest away from the real keychain and the real HOME, with the
# isolation the release gate uses (scripts/release-backend-tests.sh):
#   - env -i with a throwaway HOME and TMPDIR,
#   - a fake `security` first on PATH that only logs and fails,
#   - on macOS, sandbox-exec denying exec of /usr/bin/security.
# Always `uv run --no-sync`: it never resolves packages or rewrites the venv
# (a sync from a worktree repoints the editable install's .pth).
#
#   scripts/isolated-pytest.sh <test paths...> [pytest args...]
#
# Paths are relative to the repository root (backend/tests, or files under
# it). The files in NO_SANDBOX_FILES need setuid `ps` or their own spawns,
# which the sandbox blocks: they run in a second pass without sandbox-exec,
# where the conftest guard still keeps /usr/bin/security out of reach.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UV="$(command -v uv)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/navide-isolated-pytest.XXXXXX")"
mkdir -p "$SCRATCH/home" "$SCRATCH/tmp" "$SCRATCH/bin"
trap 'rm -rf "$SCRATCH"' EXIT
FAKE_LOG="$SCRATCH/fake-security.log"
cat > "$SCRATCH/bin/security" <<'EOF'
#!/bin/sh
echo "fake-security $*" >> "${SAFE_PYTEST_LOG:-/dev/null}"
exit 44
EOF
chmod +x "$SCRATCH/bin/security"

# Kept equal to the list in scripts/release-backend-tests.sh
# (tests/infrastructure/changedBackendTests.test.ts checks it).
NO_SANDBOX_FILES=(
  backend/tests/cli_regression/test_isolation.py
  backend/tests/test_osplat_darwin_pane_helper.py
  backend/tests/test_proc_rusage.py
  backend/tests/test_host_shell_tree_kill.py
  backend/tests/test_pty_registry.py
  backend/tests/test_terminals_breakaway_kill.py
  backend/tests/test_terminals_exit_orphan_reap.py
)

isolated() {
  env -i HOME="$SCRATCH/home" USER="$USER" LANG=en_US.UTF-8 TMPDIR="$SCRATCH/tmp" \
    SAFE_PYTEST_LOG="$FAKE_LOG" \
    PATH="$SCRATCH/bin:$ROOT/backend/.venv/bin:$(dirname "$UV"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    "$@"
}

no_sandbox() {
  local f
  for f in "${NO_SANDBOX_FILES[@]}"; do [[ "$1" == "$f" ]] && return 0; done
  return 1
}

cd "$ROOT"
sandboxed=() unsandboxed=() options=()
for arg in "$@"; do
  if [[ "$arg" == backend/tests || "$arg" == backend/tests/ ]]; then
    sandboxed+=(backend/tests)
    unsandboxed+=("${NO_SANDBOX_FILES[@]}")
  elif [[ "$arg" == backend/* && -e "${arg%%::*}" ]]; then
    if no_sandbox "${arg%%::*}"; then unsandboxed+=("$arg"); else sandboxed+=("$arg"); fi
  else
    options+=("$arg")
  fi
done
if [[ ${#sandboxed[@]} -eq 0 && ${#unsandboxed[@]} -eq 0 ]]; then
  echo "usage: scripts/isolated-pytest.sh <backend test paths...> [pytest args...]" >&2
  exit 2
fi

status=0
if [[ "$(uname)" != "Darwin" ]]; then
  isolated "$UV" --project backend run --no-sync pytest "${sandboxed[@]}" "${unsandboxed[@]}" ${options[@]+"${options[@]}"} || status=$?
else
  SB="$SCRATCH/deny-security.sb"
  printf '(version 1)\n(allow default)\n(deny process-exec (literal "/usr/bin/security"))\n' > "$SB"
  if [[ ${#sandboxed[@]} -gt 0 ]]; then
    # --deselect, not --ignore: a full run must still collect these files (the
    # CLI regression inventory checks a full collection). Node ids are
    # relative to backend/, pytest's rootdir.
    deselects=()
    for f in ${unsandboxed[@]+"${unsandboxed[@]}"}; do deselects+=("--deselect=${f#backend/}"); done
    isolated /usr/bin/sandbox-exec -f "$SB" "$UV" --project backend run --no-sync pytest \
      "${sandboxed[@]}" ${deselects[@]+"${deselects[@]}"} ${options[@]+"${options[@]}"} || status=$?
  fi
  if [[ ${#unsandboxed[@]} -gt 0 ]]; then
    isolated "$UV" --project backend run --no-sync pytest "${unsandboxed[@]}" ${options[@]+"${options[@]}"} || status=$((status ? status : $?))
  fi
fi

if [[ -s "$FAKE_LOG" ]]; then
  echo "isolated-pytest: tests called \`security\` $(wc -l < "$FAKE_LOG") time(s); the fake answered:" >&2
  cat "$FAKE_LOG" >&2
fi
exit "$status"
