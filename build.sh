#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

INSTALL=false
case "${1:-}" in
  "") ;;
  --install) INSTALL=true ;;
  *)
    echo "ERROR: usage: ./build.sh [--install]" >&2
    exit 1
    ;;
esac
[[ $# -le 1 ]] || {
  echo "ERROR: usage: ./build.sh [--install]" >&2
  exit 1
}

for command in node pnpm uv; do
  command -v "$command" >/dev/null || {
    echo "ERROR: required command not found: $command" >&2
    exit 1
  }
done

pnpm release:check
VERSION="$(node -p "require('./package.json').version")"
OUTPUT_DIR="$ROOT/dist-local"
APP_NAME="Navide.app"
APP_PATH="$OUTPUT_DIR/mac-arm64/$APP_NAME"

echo ""
echo "=== [1/3] Building Python backend for v$VERSION ==="
(
  cd backend
  uv run pyinstaller --noconfirm agent_team_backend.spec
)

echo ""
echo "=== [2/3] Building Electron application ==="
pnpm build

echo ""
echo "=== [3/3] Packaging local macOS arm64 app ==="
CSC_IDENTITY_AUTO_DISCOVERY=false \
  pnpm exec electron-builder --mac --arm64 --dir --publish never \
  -c.directories.output="$OUTPUT_DIR"

[[ -d "$APP_PATH" ]] || {
  echo "ERROR: packaged app not found: $APP_PATH" >&2
  exit 1
}
[[ -x "$APP_PATH/Contents/Resources/bin/agent_team_backend" ]] || {
  echo "ERROR: packaged backend executable not found" >&2
  exit 1
}

if [[ "$INSTALL" == true ]]; then
  command -v ditto >/dev/null || {
    echo "ERROR: required command not found: ditto" >&2
    exit 1
  }
  PROCESS_NAME="${APP_NAME%.app}"
  if pgrep -x "$PROCESS_NAME" >/dev/null 2>&1; then
    echo "ERROR: quit $PROCESS_NAME before installing" >&2
    exit 1
  fi
  INSTALL_PATH="/Applications/$APP_NAME"
  rm -rf "$INSTALL_PATH"
  ditto "$APP_PATH" "$INSTALL_PATH"
  echo "Installed: $INSTALL_PATH"
fi

echo ""
echo "Local build complete: $APP_PATH"
echo "Version and Git history were not changed."
