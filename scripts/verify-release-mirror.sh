#!/usr/bin/env bash
# Confirm that dl.navide.dev serves exactly what the GitHub Release for a tag
# serves. Run after the Release workflow's mirror job has finished (or after a
# manual `gh workflow run mirror.yml`):
#
#   scripts/verify-release-mirror.sh v0.2.4            # also expects releases/latest/ to be this tag
#   scripts/verify-release-mirror.sh v0.2.2 --no-latest # a backfilled older release
#
# Three checks, all against public endpoints, nothing is downloaded in full:
#   1. every asset the GitHub API lists has the same sha256 in the mirror's
#      SHA256SUMS (the API's `digest` field is GitHub's own checksum, so this
#      is independent of the mirror job's self-check);
#   2. every asset answers HEAD 200 on the mirror with the size GitHub reports;
#   3. releases/latest/latest-mac.yml names this version (skipped by --no-latest).
# Exit code is non-zero on any mismatch; the website and updater then keep
# using GitHub on their own, but the mirror job should be re-run.
set -Eeuo pipefail

REPO=Navide-dev/Navide
MIRROR=https://dl.navide.dev/releases

tag="${1:-}"
check_latest=true
[[ "${2:-}" == "--no-latest" ]] && check_latest=false
if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 vX.Y.Z [--no-latest]" >&2
  exit 2
fi

fail=0
note() { printf '%s\n' "$*"; }
bad()  { printf 'FAIL  %s\n' "$*"; fail=1; }

# name<TAB>sha256<TAB>size, straight from the API
assets=$(gh api "repos/${REPO}/releases/tags/${tag}" \
  --jq '.assets[] | "\(.name)\t\(.digest // "" | ltrimstr("sha256:"))\t\(.size)"')
count=$(printf '%s\n' "$assets" | grep -c . || true)
[[ "$count" -gt 0 ]] || { echo "no assets on GitHub for ${tag}" >&2; exit 1; }

sums=$(curl -fsSL "${MIRROR}/${tag}/SHA256SUMS") || { bad "${MIRROR}/${tag}/SHA256SUMS not served"; sums=""; }

while IFS=$'\t' read -r name digest size; do
  [[ -n "$name" ]] || continue
  mirrored=$(printf '%s\n' "$sums" | awk -v n="$name" '$2 == n { print $1 }')
  if [[ -z "$mirrored" ]]; then
    bad "$name  missing from mirror SHA256SUMS"
  elif [[ -z "$digest" ]]; then
    note "skip  $name  (GitHub reports no digest for this asset)"
  elif [[ "$mirrored" != "$digest" ]]; then
    bad "$name  sha256 differs  github=$digest  mirror=$mirrored"
  fi
  # HEAD: reachable, and the same byte count GitHub reports.
  head=$(curl -sI "${MIRROR}/${tag}/${name}" | tr -d '\r')
  status=$(printf '%s\n' "$head" | awk 'NR==1 { print $2 }')
  length=$(printf '%s\n' "$head" | awk 'tolower($1) == "content-length:" { print $2 }')
  if [[ "$status" != "200" ]]; then
    bad "$name  HEAD ${status:-no response}"
  elif [[ "$length" != "$size" ]]; then
    bad "$name  content-length $length, GitHub says $size"
  else
    note "ok    $name  ($size bytes, sha256 matches)"
  fi
done <<< "$assets"

if $check_latest; then
  want="${tag#v}"
  have=$(curl -fsSL "${MIRROR}/latest/latest-mac.yml" | awk '$1 == "version:" { print $2 }') || have=""
  if [[ "$have" == "$want" ]]; then
    note "ok    releases/latest/ is ${want}"
  else
    bad "releases/latest/latest-mac.yml says '${have:-nothing}', expected ${want}"
  fi
fi

if [[ "$fail" -ne 0 ]]; then
  echo
  echo "Mirror does not match GitHub. Re-run the mirror job:"
  echo "  gh workflow run mirror.yml -R ${REPO} --ref main -f tag=${tag} -f refresh_latest=$($check_latest && echo true || echo false)"
  exit 1
fi
echo "mirror matches GitHub for ${tag} (${count} assets)"
