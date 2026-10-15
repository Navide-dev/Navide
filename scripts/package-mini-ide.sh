#!/usr/bin/env bash
# Package the mini-IDE as a publishable marketplace extension.
#
#   scripts/package-mini-ide.sh
#
# Steps: build the plugin bundle (vite.mini-ide.config.ts → dist-plugins/
# mini-ide, manifest.json included), stage it, then `navide-plugin pack`
# it into dist-plugins/navide.mini-ide-<version>.vsix. Signing/publishing are
# operator steps (they need the OFFICIAL publisher private key) — the exact
# commands are printed at the end.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
BUNDLE_DIR="$ROOT/dist-plugins/mini-ide"
STAGE_DIR="$ROOT/dist-plugins/package/navide.mini-ide"
OUT_VSIX="$ROOT/dist-plugins/navide.mini-ide-$VERSION.vsix"

echo "==> Building mini-IDE bundle (v$VERSION)"
pnpm run build:mini-ide

echo "==> Staging package at $STAGE_DIR"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
cp -R "$BUNDLE_DIR/." "$STAGE_DIR/"

# Manifest: emitted by the vite build itself (vite.mini-ide.config.ts) into
# dist-plugins/mini-ide/manifest.json — the same manifest the app validates for
# the bundled builtin copy — so the staged package carries it as-is.
if [ ! -f "$STAGE_DIR/manifest.json" ]; then
  echo "ERROR: $STAGE_DIR/manifest.json missing — build:mini-ide should have emitted it" >&2
  exit 1
fi

echo "==> Packing $OUT_VSIX"
uv --project marketplace/registry run navide-plugin pack "$STAGE_DIR" --out "$OUT_VSIX"

cat <<EOF

Package ready: $OUT_VSIX

Next steps (operator — requires the OFFICIAL navide publisher private key;
the app only installs 'navide.*' packages signed by the pinned official key):

  # 1. Detached-sign the package:
  uv --project marketplace/registry run navide-plugin sign \\
      "$OUT_VSIX" --key /path/to/navide-official.key --out "$OUT_VSIX.sig"

  # 2. Publish to the registry (the publisher token in NAVIDE_PLUGIN_TOKEN):
  uv --project marketplace/registry run navide-plugin publish \\
      "$OUT_VSIX" --registry https://<registry-host> \\
      --signature "$OUT_VSIX.sig"
EOF
