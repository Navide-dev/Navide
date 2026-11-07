#!/usr/bin/env bash
# Build, pack, check and (only with --publish) publish the three public npm
# packages — @navide/plugin-contracts, @navide/plugin-sdk, @navide/plugin-ui —
# in dependency order.
#
#   scripts/publish-public-packages.sh [--skip-build] [--tag <dist-tag>] [--publish]
#
# Without --publish the script is a dry run: it builds the packages, packs them
# into dist/npm/, inspects every tarball and runs `npm publish --dry-run`, so
# the release report can show exactly what would go out. With --publish it
# first requires `npm whoami` to succeed (log in with `npm login`, or let CI
# provide NODE_AUTH_TOKEN through its own .npmrc) and refuses a version that
# is already on the registry. The script never reads, accepts or prints an
# npm token.
#
# Checks before anything is published:
#   - the three packages carry the same 1.x version;
#   - plugin-sdk's peer range on plugin-contracts and plugin-ui's peer range
#     on plugin-sdk accept that version;
#   - each tarball holds dist/index.js, package.json, README.md and LICENSE
#     (the repository LICENSE is copied in for the pack and removed after),
#     and no src/ tree;
#   - no packed package.json carries a workspace: or link: specifier.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PACKAGES=(plugin-contracts plugin-sdk plugin-ui)
SKIP_BUILD=0
PUBLISH=0
TAG="latest"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1 ;;
    --publish) PUBLISH=1 ;;
    --tag) TAG="${2:?--tag needs a dist-tag}"; shift ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

OUT="$ROOT/dist/npm"
rm -rf "$OUT"
mkdir -p "$OUT"

version_of() { node -p "require('./packages/$1/package.json').version"; }
peer_of() { node -p "(require('./packages/$1/package.json').peerDependencies ?? {})['@navide/$2'] ?? ''"; }

echo "=== Versions ==="
VERSION="$(version_of plugin-contracts)"
for pkg in "${PACKAGES[@]}"; do
  v="$(version_of "$pkg")"
  echo "  @navide/$pkg $v"
  if [[ "$v" != "$VERSION" ]]; then
    echo "the public packages must share one version (plugin-contracts is $VERSION, $pkg is $v)" >&2
    exit 1
  fi
done
if [[ ! "$VERSION" =~ ^1\.[0-9]+\.[0-9]+$ ]]; then
  echo "expected a 1.x.y version, got $VERSION (pre-release and other majors are published by hand, on purpose)" >&2
  exit 1
fi
for pair in "plugin-sdk plugin-contracts" "plugin-ui plugin-sdk"; do
  set -- $pair
  range="$(peer_of "$1" "$2")"
  if [[ ! "$range" =~ ^\^1\. ]]; then
    echo "@navide/$1 must declare peerDependencies['@navide/$2'] as a ^1.x range (found '$range')" >&2
    exit 1
  fi
done

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "=== Building ==="
  pnpm run build:public-packages
fi

echo "=== Packing into dist/npm ==="
cleanup() { for pkg in "${PACKAGES[@]}"; do rm -f "packages/$pkg/LICENSE"; done; }
trap cleanup EXIT
TARBALLS=()
for pkg in "${PACKAGES[@]}"; do
  cp LICENSE "packages/$pkg/LICENSE"
  tarball="$(cd "packages/$pkg" && npm pack --pack-destination "$OUT" --silent 2>/dev/null | tail -n 1)"
  path="$OUT/$tarball"
  [[ -f "$path" ]] || { echo "npm pack produced no tarball for $pkg" >&2; exit 1; }
  TARBALLS+=("$path")
  listing="$(tar tzf "$path")"
  for required in package/package.json package/dist/index.js package/README.md package/LICENSE; do
    grep -qx "$required" <<<"$listing" || { echo "$tarball lacks $required" >&2; exit 1; }
  done
  if grep -q '^package/src/' <<<"$listing"; then
    echo "$tarball contains source files; check the package's \"files\" field" >&2
    exit 1
  fi
  if tar xOzf "$path" package/package.json | grep -Eq '"(workspace|link):'; then
    echo "$tarball's package.json carries a workspace: or link: specifier" >&2
    exit 1
  fi
  echo "  $tarball ($(wc -c <"$path" | tr -d ' ') bytes, $(grep -c . <<<"$listing") files)"
done

echo "=== Publish ==="
if [[ "$PUBLISH" -eq 1 ]]; then
  who="$(npm whoami 2>/dev/null || true)"
  if [[ -z "$who" ]]; then
    echo "npm is not logged in: run 'npm login' (or provide NODE_AUTH_TOKEN through .npmrc in CI) and rerun" >&2
    exit 1
  fi
  echo "  publishing as $who with dist-tag $TAG"
  for pkg in "${PACKAGES[@]}"; do
    if npm view "@navide/$pkg@$VERSION" version >/dev/null 2>&1; then
      echo "@navide/$pkg@$VERSION is already on the registry; bump the version instead of republishing" >&2
      exit 1
    fi
  done
  for path in "${TARBALLS[@]}"; do
    npm publish "$path" --access public --tag "$TAG"
  done
  echo "Published @navide/{plugin-contracts,plugin-sdk,plugin-ui}@$VERSION ($TAG)."
else
  for path in "${TARBALLS[@]}"; do
    npm publish "$path" --access public --tag "$TAG" --dry-run
  done
  echo "Dry run only. Rerun with --publish (after 'npm login') to publish $VERSION."
fi
