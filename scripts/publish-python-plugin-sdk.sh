#!/usr/bin/env bash
# Build, check and (only with --publish) publish the public Python plugin SDK,
# navide-plugin-sdk, from backend/navide_plugin_sdk.
#
#   scripts/publish-python-plugin-sdk.sh [--publish]
#
# Without --publish the script is a dry run: it stages
# packages/plugin-sdk-python/{pyproject.toml,README.md}, the repository
# LICENSE and the SDK's git-tracked sources into a temporary directory outside
# the repository, builds the sdist and the wheel there with `uv build` into
# dist/pypi/, and inspects both, so the release
# report can show exactly what would go out. Each archive's file list is
# written next to it as <archive>.files.txt.
#
# Checks before anything is published:
#   - the project version equals navide_plugin_sdk.API_VERSION and is 1.x.y;
#   - the wheel holds only navide_plugin_sdk/*.py and its .dist-info, the
#     sdist only those sources, pyproject.toml, README.md, LICENSE and
#     PKG-INFO: no tests, fixtures, caches or private files;
#   - the wheel declares no dependency (the SDK is standard library only).
#
# With --publish it runs `uv publish` on the two archives, which needs the
# user's own PyPI credential (for example a trusted-publishing token in CI;
# locally `uv publish` asks). The script never reads, accepts or prints a
# token. The provenance-attested path is the GitHub Actions draft in
# .github/workflow-drafts/publish-python-plugin-sdk.yml (PyPI trusted
# publishing).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PUBLISH=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --publish) PUBLISH=1 ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

OUT="$ROOT/dist/pypi"
rm -rf "$OUT"
mkdir -p "$OUT"
# Outside the repository, so the build sees no VCS ignore file of ours.
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/navide-plugin-sdk-python.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/navide_plugin_sdk"

VERSION="$(sed -n 's/^version = "\(.*\)"$/\1/p' packages/plugin-sdk-python/pyproject.toml)"
API_VERSION="$(sed -n 's/^API_VERSION = "\(.*\)"$/\1/p' backend/navide_plugin_sdk/__init__.py)"
echo "=== Version ==="
echo "  navide-plugin-sdk $VERSION (API_VERSION $API_VERSION)"
if [[ ! "$VERSION" =~ ^1\.[0-9]+\.[0-9]+$ ]]; then
  echo "expected a 1.x.y version, got '$VERSION'" >&2
  exit 1
fi
if [[ "$VERSION" != "$API_VERSION" ]]; then
  echo "packages/plugin-sdk-python/pyproject.toml ($VERSION) must equal navide_plugin_sdk.API_VERSION ($API_VERSION)" >&2
  exit 1
fi

echo "=== Staging ==="
cp packages/plugin-sdk-python/pyproject.toml packages/plugin-sdk-python/README.md LICENSE "$STAGE/"
while IFS= read -r file; do
  cp "$file" "$STAGE/navide_plugin_sdk/"
done < <(git ls-files 'backend/navide_plugin_sdk/*.py')

echo "=== Building ==="
(cd "$STAGE" && uv build --out-dir "$OUT" --no-sources)

echo "=== Checking ==="
WHEEL="$OUT/navide_plugin_sdk-$VERSION-py3-none-any.whl"
SDIST="$OUT/navide_plugin_sdk-$VERSION.tar.gz"
[[ -f "$WHEEL" && -f "$SDIST" ]] || { echo "uv build did not produce $WHEEL and $SDIST" >&2; exit 1; }
python3 -I -c 'import sys, zipfile; print("\n".join(sorted(zipfile.ZipFile(sys.argv[1]).namelist())))' "$WHEEL" >"$WHEEL.files.txt"
tar tzf "$SDIST" | sed "s#^navide_plugin_sdk-$VERSION/##" | grep -v '/$' | grep . | sort >"$SDIST.files.txt"
unexpected="$(grep -Ev "^(navide_plugin_sdk/[a-z_]+\.py|navide_plugin_sdk-$VERSION\.dist-info/[A-Za-z_./-]+)$" "$WHEEL.files.txt" || true)"
if [[ -n "$unexpected" ]]; then
  echo "the wheel holds files other than the SDK sources and its metadata:" >&2
  echo "$unexpected" >&2
  exit 1
fi
unexpected="$(grep -Ev '^(navide_plugin_sdk/[a-z_]+\.py|pyproject\.toml|README\.md|LICENSE|PKG-INFO)$' "$SDIST.files.txt" || true)"
if [[ -n "$unexpected" ]]; then
  echo "the sdist holds files other than the SDK sources and its metadata:" >&2
  echo "$unexpected" >&2
  exit 1
fi
if python3 -I -c 'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); m = z.read(sys.argv[2]).decode(); sys.exit(0 if "Requires-Dist:" in m else 1)' "$WHEEL" "navide_plugin_sdk-$VERSION.dist-info/METADATA"; then
  echo "the wheel declares a dependency; the SDK must stay standard library only" >&2
  exit 1
fi
echo "  $(basename "$WHEEL") ($(wc -l <"$WHEEL.files.txt" | tr -d ' ') files)"
echo "  $(basename "$SDIST") ($(wc -l <"$SDIST.files.txt" | tr -d ' ') files)"

echo "=== Publish ==="
if [[ "$PUBLISH" -eq 1 ]]; then
  uv publish "$SDIST" "$WHEEL"
  echo "Published navide-plugin-sdk $VERSION."
else
  echo "Dry run only. Rerun with --publish to publish navide-plugin-sdk $VERSION."
fi
