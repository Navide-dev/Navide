#!/usr/bin/env bash
# Stage the files of a `plugin-packages-<version>` GitHub Release, the only
# channel the public plugin packages are distributed through (they are not
# published to npm or PyPI; docs/en-US/build-for-navide.md).
#
#   scripts/stage-plugin-packages-release.sh [--skip-build]
#
# It runs the dry runs of scripts/publish-public-packages.sh (the three npm
# tarballs, checked and packed into dist/npm/) and
# scripts/publish-python-plugin-sdk.sh (the Python SDK wheel and sdist, into
# dist/pypi/), copies the archives into dist/plugin-packages-<version>/ and
# writes SHA256SUMS and a notes.md listing each file and its SHA-256.
#
# It never uploads, tags or publishes anything and never reads a token. It
# ends by printing the `gh release create` command a maintainer runs after the
# release is approved; creating the release is a separate, deliberate step.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NPM_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) NPM_ARGS+=(--skip-build) ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

VERSION="$(node -p "require('./packages/plugin-sdk/package.json').version")"
PY_VERSION="$(sed -n 's/^API_VERSION = "\(.*\)"$/\1/p' backend/navide_plugin_sdk/__init__.py)"
TAG="plugin-packages-$VERSION"
OUT="$ROOT/dist/$TAG"

scripts/publish-public-packages.sh "${NPM_ARGS[@]+"${NPM_ARGS[@]}"}"
scripts/publish-python-plugin-sdk.sh

rm -rf "$OUT"
mkdir -p "$OUT"
FILES=(
  "dist/npm/navide-plugin-contracts-$VERSION.tgz"
  "dist/npm/navide-plugin-sdk-$VERSION.tgz"
  "dist/npm/navide-plugin-ui-$VERSION.tgz"
  "dist/pypi/navide_plugin_sdk-$PY_VERSION-py3-none-any.whl"
  "dist/pypi/navide_plugin_sdk-$PY_VERSION.tar.gz"
)
for file in "${FILES[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "missing $file after the dry runs" >&2
    exit 1
  fi
  cp "$file" "$OUT/"
done

(cd "$OUT" && shasum -a 256 -- *.tgz *.whl *.tar.gz > SHA256SUMS)

{
  echo "The public Navide plugin packages, $VERSION (Python SDK $PY_VERSION)."
  echo
  echo "They are distributed only through this release. Install them as"
  echo "docs/en-US/build-for-navide.md describes, and compare each download"
  echo "with \`shasum -a 256\`:"
  echo
  echo '```text'
  cat "$OUT/SHA256SUMS"
  echo '```'
} > "$OUT/notes.md"

echo
echo "=== Staged $TAG in dist/$TAG ==="
ls -l "$OUT"
echo
echo "Nothing was uploaded. After the release is approved:"
echo "  gh release create $TAG --title \"Plugin packages $VERSION\" --notes-file dist/$TAG/notes.md \\"
echo "    dist/$TAG/*.tgz dist/$TAG/*.whl dist/$TAG/*.tar.gz dist/$TAG/SHA256SUMS"
