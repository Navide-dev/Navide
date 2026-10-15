#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

# A version with no What's New entry ships without an in-app announcement or
# guided tour (docs/en-US/release-announcements.md). A warning, not a failure:
# a quiet patch may not need one, but skipping it should be a decision.
warn_missing_announcement() {
  local version="$1"
  local file="${2:-src/renderer/src/lib/whatsNew.ts}"
  # Checked first: grep on a missing file exits 2, which would read as "no
  # entry" and bury a moved or renamed file under a warning.
  [[ -f "$file" ]] || fail "What's New file not found: ${file}"
  if ! grep -Eq "^[[:space:]]*version: '${version//./\\.}',[[:space:]]*$" "$file"; then
    echo "WARNING: no What's New entry for ${version} in ${file}; users updating will see no announcement or tour."
    echo "         See docs/en-US/release-announcements.md."
  fi
}

# Runs the command before `--`, then the one after it. By default they run one
# after the other: measured on a loaded host, overlapping them saved no time
# and raised the 1-minute load by about 10 while both ran.
# NAVIDE_RELEASE_OVERLAP_GATES=1 runs the first in the background beside the
# second instead, waits for both, and fails naming each that failed, so
# neither exit code is lost. The background output is held and printed when
# both are done, so the two never interleave.
# The background command gets its own process group (set -m) and an INT or
# TERM stops that group by the recorded id: `pnpm typecheck` does not pass a
# signal on to the command chain it runs, so stopping its pid alone leaves
# the chain running. Ctrl-C reaches the foreground command directly; bash
# runs the trap once that command has ended, so a TERM sent to this script
# alone takes effect when the foreground command finishes.
run_gates() {
  local IFS=' ' background=() log pid background_status=0 foreground_status=0
  while [[ $# -gt 0 && "$1" != -- ]]; do background+=("$1"); shift; done
  shift
  if [[ "${NAVIDE_RELEASE_OVERLAP_GATES:-}" != 1 ]]; then
    "${background[@]}"
    "$@"
    return
  fi
  log="$(mktemp "${TMPDIR:-/tmp}/navide-release-gate.XXXXXX")"
  set -m
  "${background[@]}" > "$log" 2>&1 < /dev/null &
  pid=$!
  set +m
  trap "kill -TERM -- -${pid} 2>/dev/null || true; wait ${pid} 2>/dev/null || true; rm -f '${log}'; exit 130" INT
  trap "kill -TERM -- -${pid} 2>/dev/null || true; wait ${pid} 2>/dev/null || true; rm -f '${log}'; exit 143" TERM
  "$@" || foreground_status=$?
  wait "$pid" || background_status=$?
  trap - INT TERM
  echo "--- ${background[*]} (exit ${background_status}) ---"
  cat "$log"
  rm -f "$log"
  [[ $background_status -eq 0 ]] || echo "ERROR: ${background[*]} failed (exit ${background_status})" >&2
  [[ $foreground_status -eq 0 ]] || echo "ERROR: $* failed (exit ${foreground_status})" >&2
  [[ $background_status -eq 0 && $foreground_status -eq 0 ]] || exit 1
}

[[ $# -eq 1 ]] || fail "usage: ./release.sh <X.Y.Z | patch | minor | major>"

REQUEST="${1#v}"

# patch/minor/major compute the next version from the current package.json;
# an explicit X.Y.Z is used verbatim (existing behavior, unchanged).
if [[ "$REQUEST" == "patch" || "$REQUEST" == "minor" || "$REQUEST" == "major" ]]; then
  command -v node >/dev/null || fail "node is required to compute the next version"
  CURRENT="$(node -p "require('./package.json').version")"
  [[ "$CURRENT" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || \
    fail "current package.json version '$CURRENT' is not X.Y.Z"
  MAJOR="${BASH_REMATCH[1]}"; MINOR="${BASH_REMATCH[2]}"; PATCH="${BASH_REMATCH[3]}"
  case "$REQUEST" in
    patch) PATCH=$((PATCH + 1)) ;;
    minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
    major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  esac
  VERSION="${MAJOR}.${MINOR}.${PATCH}"
  echo "Bump '${REQUEST}': ${CURRENT} -> ${VERSION}"
else
  VERSION="$REQUEST"
fi

TAG="v${VERSION}"
VERSION_FILES=(
  package.json
  backend/agent_team_backend/__init__.py
  backend/pyproject.toml
  backend/uv.lock
  README.md
  README.zh-TW.md
  README.ja-JP.md
)

if [[ ! "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  fail "resolved version '$VERSION' is not a valid X.Y.Z"
fi

for command in git node pnpm uv; do
  command -v "$command" >/dev/null || fail "required command not found: $command"
done

[[ "$(git branch --show-current)" == "main" ]] || fail "releases must be prepared from main"
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || \
  fail "working tree is not clean; commit or stash all changes first"

echo "Fetching release refs..."
git fetch origin main --tags
git merge-base --is-ancestor origin/main HEAD || \
  fail "local main has diverged from origin/main; synchronize it before releasing"

git rev-parse "$TAG" >/dev/null 2>&1 && fail "local tag already exists: $TAG"
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  fail "remote tag already exists: $TAG"
fi

pnpm release:check
warn_missing_announcement "$VERSION"

CURRENT="$(node -p "require('./package.json').version")"
echo ""
echo "Release: $CURRENT -> $VERSION"
echo "Source:  $(git rev-parse --short HEAD)"
echo "Target:  Navide-dev/Navide"
printf "Prepare %s? [y/N]: " "$TAG"
read -r confirmed || confirmed=""
if [[ ! "$confirmed" =~ ^[Yy]$ ]]; then
  echo "Release cancelled."
  exit 0
fi

version_changed=false
rollback_version_files() {
  status=$?
  if [[ $status -ne 0 && "$version_changed" == true ]]; then
    echo "Release preparation failed; restoring version files." >&2
    git restore -- "${VERSION_FILES[@]}"
  fi
  exit "$status"
}
trap rollback_version_files EXIT

version_changed=true
node scripts/set-release-version.mjs "$VERSION"
# Point the README download links at this release too (every release, patch
# included), so the download point always reflects the latest version.
node scripts/update-readme-download-links.mjs "$VERSION"
uv --project backend lock
pnpm release:check "$TAG"

echo ""
echo "=== Release gates ==="
uv --project backend run --locked ruff check backend
# With NAVIDE_RELEASE_OVERLAP_GATES=1 the type check overlaps the backend
# tests only: it rebuilds packages/*/dist, which the artifacts project of
# `pnpm test:run` reads, and the backend tests touch neither. Backend tests
# run with a throwaway HOME and no reach to the real keychain.
run_gates pnpm typecheck -- scripts/release-backend-tests.sh
pnpm test:run

echo ""
echo "=== Building release artifacts ==="
(
  cd backend
  uv run --locked pyinstaller --noconfirm agent_team_backend.spec
)
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm dist
# The dev-only web mode (NAVIDE_DEV_WEB=1) must never reach a release build.
node scripts/check-no-dev-web.mjs out

unexpected_changes="$(
  git status --porcelain --untracked-files=all \
    | sed -E 's/^.. //' \
    | grep -Ev '^(package.json|backend/agent_team_backend/__init__\.py|backend/pyproject\.toml|backend/uv\.lock|README\.md|README\.zh-TW\.md|README\.ja-JP\.md)$' \
    || true
)"
[[ -z "$unexpected_changes" ]] || \
  fail "unexpected source changes appeared during release preparation:\n$unexpected_changes"

git add -- "${VERSION_FILES[@]}"
git diff --cached --check
git commit -m "chore: release $TAG" -- "${VERSION_FILES[@]}"
version_changed=false
git tag -a "$TAG" -m "Navide $TAG"
trap - EXIT

echo ""
echo "Prepared $TAG at $(git rev-parse --short HEAD)."
printf "Push main and %s to GitHub to publish it? [y/N]: " "$TAG"
read -r publish || publish=""
if [[ "$publish" =~ ^[Yy]$ ]]; then
  git push origin main
  git push origin "$TAG"
  echo "Pushed source and tag. GitHub Actions builds every platform into a draft"
  echo "release, mirrors it to dl.navide.dev, and only then publishes it:"
  echo "https://github.com/Navide-dev/Navide/actions"
  echo "If a job fails, $TAG stays a draft: fix the cause and use \"Re-run failed jobs\""
  echo "(RELEASING.md, \"After the tag push\")."
else
  echo "Release remains local. Publish later with:"
  echo "  git push origin main"
  echo "  git push origin $TAG"
fi
