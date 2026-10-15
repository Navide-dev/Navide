#!/usr/bin/env bash
# Build, pack, sign and publish the first-party v2 plugins to a Registry.
#
#   NAVIDE_REGISTRY_URL=https://server.navide.dev/registry \
#   NAVIDE_PUBLISHER_KEY=~/navide-signing/plugin_publisher.key \
#   NAVIDE_PLUGIN_TOKEN=<navide publisher bearer token> \
#   scripts/publish-first-party-plugins.sh [--skip-build] [--only git|plans]
#   scripts/publish-first-party-plugins.sh --package <vsix> --target <target> \
#       --version <version> [--id <plugin id>]
#   scripts/publish-first-party-plugins.sh --from-run <run id> --version <version> \
#       [--target "<target> <target> ..."] [--yes]
#
# --package signs and publishes one already-packed vsix (no build), for
# example one produced by .github/workflows/plugin-packages.yml. It refuses a
# vsix whose manifest id/version differ from --id (default navide.plans) and
# --version, and a target outside KNOWN_TARGETS.
#
# --from-run downloads the navide.plans packages of a finished
# plugin-packages.yml run with `gh run download`, checks each one's sha256,
# prints what it would publish, and publishes each target in order only with
# --yes. --target narrows it to the listed targets (default: all KNOWN_TARGETS);
# a target already published for that version is a 409 and stops the run. CI never sees the publisher key: it only builds and packs.
#
# navide.git is frontend-only and is published once as `universal`.
# navide.plans ships a PyInstaller backend, so its package is built for, and
# published as, the current host target only (`<platform>-<arch>`, e.g.
# darwin-arm64). Other targets must be built and published from a machine of
# that platform/architecture with the same command; the Registry keeps one
# artifact per target of the same version and 409s a target published twice.
#
# Packing and signing reuse the Registry's own `navide-plugin` CLI
# (marketplace/registry/registry/cli.py). The publisher key path and the token
# are read from the environment and never printed; the token reaches the CLI
# through NAVIDE_PLUGIN_TOKEN rather than argv.
#
# The `navide` publisher must be registered on the Registry first (one-off
# admin step, see marketplace/registry/README.md "Publishing first-party
# plugins").
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SKIP_BUILD=0
ONLY=""
PACKAGE=""
TARGET=""
RUN_ID=""
EXPECT_ID="navide.plans"
EXPECT_VERSION=""
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1 ;;
    --only) ONLY="${2:?--only needs git or plans}"; shift ;;
    --package) PACKAGE="${2:?--package needs a vsix path}"; shift ;;
    --target) TARGET="${2:?--target needs a target}"; shift ;;
    --from-run) RUN_ID="${2:?--from-run needs a run id}"; shift ;;
    --id) EXPECT_ID="${2:?--id needs a plugin id}"; shift ;;
    --version) EXPECT_VERSION="${2:?--version needs a version}"; shift ;;
    --yes) YES=1 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$ONLY" in
  ""|git|plans) ;;
  *) echo "--only must be git or plans" >&2; exit 2 ;;
esac

# The targets the app ships a build for (release.yml); a plugin artifact for
# any other target could never be installed.
KNOWN_TARGETS="darwin-arm64 linux-x64 linux-arm64 win32-x64 win32-arm64"

require_publish_env() {
  : "${NAVIDE_REGISTRY_URL:?set NAVIDE_REGISTRY_URL (e.g. https://server.navide.dev/registry)}"
  : "${NAVIDE_PUBLISHER_KEY:?set NAVIDE_PUBLISHER_KEY to the navide publisher private key path}"
  : "${NAVIDE_PLUGIN_TOKEN:?set NAVIDE_PLUGIN_TOKEN to the navide publisher bearer token}"
  export NAVIDE_PLUGIN_TOKEN
  if [ ! -f "$NAVIDE_PUBLISHER_KEY" ]; then
    echo "NAVIDE_PUBLISHER_KEY does not point at a file" >&2
    exit 1
  fi
}

OUT_DIR="$ROOT/dist-plugins/publish"
mkdir -p "$OUT_DIR"
HOST_TARGET="$(node -p "process.platform + '-' + process.arch")"

navide_plugin() {
  uv --project "$ROOT/marketplace/registry" run --quiet navide-plugin "$@"
}

# publish_dir <built plugin dir> <registry target>
publish_dir() {
  local src="$1" target="$2"
  local id version vsix
  id="$(node -p "require('$src/manifest.json').id")"
  version="$(node -p "require('$src/manifest.json').version")"
  vsix="$OUT_DIR/$id-$version-$target.vsix"
  echo "==> Packing $id $version ($target)"
  navide_plugin pack "$src" --out "$vsix" --target "$target"
  publish_vsix "$vsix" "$target"
}

# publish_vsix <packed vsix> <registry target>
publish_vsix() {
  local vsix="$1" target="$2"
  local sig="$OUT_DIR/$(basename "$vsix").sig"
  echo "==> Signing $(basename "$vsix")"
  navide_plugin sign "$vsix" --key "$NAVIDE_PUBLISHER_KEY" --out "$sig"
  echo "==> Publishing $(basename "$vsix") ($target) to $NAVIDE_REGISTRY_URL"
  navide_plugin publish "$vsix" --registry "$NAVIDE_REGISTRY_URL" \
    --signature "$sig" --target "$target"
}

# check_vsix <vsix> <target>: refuse an unknown target, or a package whose
# manifest is not the expected id and version.
check_vsix() {
  local vsix="$1" target="$2" found
  case " $KNOWN_TARGETS " in
    *" $target "*) ;;
    *) echo "refusing: unknown target '$target' (known: $KNOWN_TARGETS)" >&2; exit 1 ;;
  esac
  [ -f "$vsix" ] || { echo "refusing: no such package: $vsix" >&2; exit 1; }
  found="$(python3 -c 'import json, sys, zipfile
m = json.loads(zipfile.ZipFile(sys.argv[1]).read("manifest.json"))
print(m["id"], m["version"])' "$vsix")"
  if [ "$found" != "$EXPECT_ID $EXPECT_VERSION" ]; then
    echo "refusing: $vsix is '$found', expected '$EXPECT_ID $EXPECT_VERSION'" >&2
    exit 1
  fi
}

if [ -n "$PACKAGE" ] || [ -n "$RUN_ID" ]; then
  [ -n "$EXPECT_VERSION" ] || { echo "--package/--from-run need --version" >&2; exit 2; }
fi

if [ -n "$PACKAGE" ]; then
  [ -n "$TARGET" ] || { echo "--package needs --target" >&2; exit 2; }
  check_vsix "$PACKAGE" "$TARGET"
  require_publish_env
  publish_vsix "$PACKAGE" "$TARGET"
  exit 0
fi

if [ -n "$RUN_ID" ]; then
  RUN_DIR="$OUT_DIR/run-$RUN_ID"
  if [ ! -d "$RUN_DIR" ]; then
    gh run download "$RUN_ID" --dir "$RUN_DIR" --pattern "$EXPECT_ID-*"
  fi
  RUN_TARGETS="${TARGET:-$KNOWN_TARGETS}"
  echo "==> Run $RUN_ID will publish to ${NAVIDE_REGISTRY_URL:-<NAVIDE_REGISTRY_URL unset>}:"
  for target in $RUN_TARGETS; do
    name="$EXPECT_ID-$EXPECT_VERSION-$target.vsix"
    check_vsix "$RUN_DIR/$name/$name" "$target"
    (cd "$RUN_DIR/$name" && shasum -a 256 -c "$name.sha256" >/dev/null) || {
      echo "refusing: sha256 mismatch for $name" >&2
      exit 1
    }
    echo "    $target  $name"
  done
  if [ "$YES" -ne 1 ]; then
    echo "Nothing published. Re-run with --yes to publish the targets above." >&2
    exit 1
  fi
  require_publish_env
  for target in $RUN_TARGETS; do
    name="$EXPECT_ID-$EXPECT_VERSION-$target.vsix"
    publish_vsix "$RUN_DIR/$name/$name" "$target"
  done
  exit 0
fi

require_publish_env

if [ "$SKIP_BUILD" -eq 0 ]; then
  pnpm run build:public-packages
fi

if [ "$ONLY" != "plans" ]; then
  if [ "$SKIP_BUILD" -eq 0 ]; then
    pnpm run build:git:v2
  fi
  publish_dir "$ROOT/dist-plugins/navide-git" universal
fi

if [ "$ONLY" != "git" ]; then
  if [ "$SKIP_BUILD" -eq 0 ]; then
    pnpm run build:plans:v2
    pnpm run build:plans:backend
  fi
  backend="$ROOT/dist-plugins/navide-plans/backend/navide-plans"
  case "$HOST_TARGET" in win32-*) backend="$backend.exe" ;; esac
  if [ ! -x "$backend" ]; then
    echo "missing Plans backend executable: $backend (run without --skip-build)" >&2
    exit 1
  fi
  echo "==> Plans backend: $(file -b "$backend" 2>/dev/null || echo unknown)"
  publish_dir "$ROOT/dist-plugins/navide-plans" "$HOST_TARGET"
fi
