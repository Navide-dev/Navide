# Releasing Navide

Navide ships as a signed + notarized macOS app, unsigned Windows x64 and
arm64 installers, and a Linux x64 AppImage and `.deb`. Users receive updates through
the in-app updater (electron-updater; the `.deb` updates through `apt`), which
downloads the full zip for every update — see "Updates are full downloads"
below for why.

We use a **two-tier** model.

| Tier | When | Command | Extra steps |
|------|------|---------|-------------|
| **Patch / hotfix** | small fixes, no new user-facing feature | `./release.sh patch` | none |
| **Minor / major** | new features, notable changes | `./release.sh minor` (or `major`) | announce (release notes, etc.) |

`release.sh` updates the README download links to the new version on **every**
release (patch included), so the download point always reflects the latest
version — no manual README edit is needed for any tier.

Every release — patch or major — is fully built, signed, notarized, and
published to GitHub Releases (with `latest-mac.yml`, `latest.yml` and
`latest-linux.yml`), then mirrored byte for byte to `dl.navide.dev` (see
"Download mirror" below). There is no "hot patch"
that skips the build; the difference between the tiers is only the **ceremony**
around it, not the build itself.

## Prerequisites

- Clean `main`, in sync with `origin/main` (`release.sh` enforces this).
- Signing assets present and GitHub secrets set. See `~/navide-signing/README.md`
  (5 secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`). The mirror job needs two more,
  `NAVIDE_MIRROR_AWS_ACCESS_KEY_ID` and `NAVIDE_MIRROR_AWS_SECRET_ACCESS_KEY`
  (IAM user `navide-release-upload`, AWS account NT-網域; it can only write
  `releases/*` in the mirror bucket and invalidate its distribution).
- `node`, `pnpm`, `uv`, `git` on PATH.

## Pre-release checklist

CI proves that every platform compiles, passes its unit tests and packages. It
does not prove the installed app works: v0.2.3's arm64 build passed every job
and still could not open a terminal pane until a VM run caught an event-loop
stall (#102). Walk this list before `./release.sh`; nothing here is automated.

1. **`main` is green on all three platforms** — the last CI run on `origin/main`
   passed Frontend and Backend checks for macOS, Linux and Windows. A PR whose
   Windows job was skipped or rerun-to-green does not count.
2. **Dry-run the release workflow** — trigger `Release` with
   `workflow_dispatch` on `main`. It builds every platform (macOS, Linux x64,
   Linux arm64, Windows x64, Windows arm64) without publishing. All jobs must
   pass, including the Windows `--self-check conpty` and `check-pe-machine`
   steps; download the Windows artifacts from the run for step 3.
3. **Smoke-test the installers on a real OS** — on a clean Windows and a clean
   Linux machine or VM (restore a snapshot; never test over an old install):
   install the dry-run artifact, launch, open one Terminal pane and type into
   it, open one CLI pane and reach its login prompt.
   Read `backend.log` for `loop_watchdog` stalls while doing so. Windows on Arm
   must run the arm64 build natively — verify with
   `GetProcessInformation(ProcessMachineTypeInfo)` and the absence of
   `xtajit64.dll`, not `IsWow64Process2`, which reports x64 emulation as native.
4. **Dependency audit warnings** — the Windows-on-Arm pass of the Dependency
   audit job only warns. Read its output; the `cryptography` pin for win_arm64
   is a known, accepted item until upstream ships newer wheels.
5. **What's New and CHANGELOG** — add the `whatsNew.ts` entry (below) and the
   `CHANGELOG.md` section for the new version. `release.sh` bumps versions and
   README download links but writes neither of these.
6. **Signing status** — macOS signs and notarizes in CI; Windows is unsigned
   and shows SmartScreen's "Unknown publisher" prompt. Do not describe a Windows
   build as signed anywhere until that changes.

### After the tag push

The GitHub Release is a **draft** until the very last job. The macOS job
creates it; the Linux x64, Windows x64 and Windows arm64 jobs upload into it;
`mirror-release` (shown as *Mirror vX.Y.Z to dl.navide.dev*) copies it to the
mirror once those four have passed; and `publish-release` (*Publish the GitHub
Release*) runs only when all five are green, turning the draft into the public,
Latest release. Until then neither the website nor the updater's GitHub
fallback can see it — though the mirror's `releases/latest/` already names the
new version in the seconds between the mirror and publish jobs. Confirm the
Release carries every asset listed under "Rollback" below plus a single
`latest.yml` whose `files` list names both `win-x64` and `win-arm64`; when the
publish job is green, run

```bash
scripts/verify-release-mirror.sh vX.Y.Z
```

which checks every asset's sha256 against GitHub's own `digest` and confirms
`releases/latest/` now names the new version (it reads the published
release, so run it after the publish job, not before).

**If a job fails**, nothing reaches users: a platform or mirror failure skips
`publish-release`, and the release stays a draft (visible only to maintainers
on the Releases page). Everyone stays on the previous version, the same as
before the tag push, except in the one case below.

- **Finish it**: fix the cause, then use **Re-run failed jobs** on the Release
  run. The failed job re-uploads with `--clobber` into the same draft, and the
  jobs it skipped — the mirror and publish jobs — run after it. A fix that
  needs new code needs a new patch version, not a moved tag.
- **Mirror fixed separately**: if you re-ran the mirror by hand
  (`gh workflow run mirror.yml -R Navide-dev/Navide --ref main -f
  tag=vX.Y.Z -f refresh_latest=true`, which can read the draft), publish with
  `gh release edit vX.Y.Z -R Navide-dev/Navide --draft=false --latest`.
- **Abandon it**: `gh release delete vX.Y.Z -R Navide-dev/Navide --yes`
  removes the draft and its assets and keeps the tag; add `--cleanup-tag` to
  delete the tag as well. If the mirror job had already passed, also re-point
  the mirror's `releases/latest/` at the previous release (see "Rollback").
- **Only the publish job failed** (the mirror already passed): the updater
  already offers the new version from the mirror while GitHub still shows the
  old one. Re-run that job, or run the `gh release edit` command above.
- **Re-running an older tag's run** after a newer version shipped publishes
  that tag but leaves both GitHub's Latest and the mirror's `releases/latest/`
  on the newer version (`scripts/release-latest-guard.sh`; the job logs a
  notice). An equal tag is a plain rerun and is marked Latest as before. Only
  a manual mirror run with `refresh_latest=true` moves `releases/latest/`
  back — that is the rollback path.

## Pre-release step: Update What's New announcement

Before running `./release.sh`, add a new entry to `src/renderer/src/lib/whatsNew.ts` for the target version (e.g. `0.1.70`). Include title and bullet points in both `'zh-TW'` and `'en-US'`. This ensures that when users launch the newly updated app, the in-app What's New modal (`WhatsNewModal`) automatically pops up with the new features and fixes.

## Patch / hotfix flow

```bash
./release.sh patch      # e.g. 0.1.50 -> 0.1.51
```

`release.sh` bumps the version across all version files, runs the gates
(typecheck + frontend + backend tests), builds locally, commits, tags, and
(after you confirm) pushes `main` + the tag. The tag push triggers the
**Release** CI workflow: its macOS job signs, notarizes, and creates the
GitHub Release as a draft, then the Linux x64 and Windows x64 jobs add their
installers, and the Windows arm64 job adds its installer and merges both
Windows entries into one `latest.yml`. The mirror job then copies the finished
draft to `dl.navide.dev`, and only after that does the last job publish the
release. A failure anywhere leaves it a draft (see "After the tag push").
Existing users' apps auto-check (startup + every 30 min), download the
update in the background, and prompt "Restart to update".

That's the whole hotfix flow. `release.sh` already repointed the README
download links (and the `latest-release` badge tracks the newest release), so
new users downloading an installer always get the latest version too.

## Minor / major flow

```bash
./release.sh minor      # e.g. 0.1.50 -> 0.2.0
# or
./release.sh major      # e.g. 0.1.50 -> 1.0.0
```

Same as above (the README download links are updated by `release.sh`
automatically), **plus** announce as appropriate (release notes, etc.) after
the GitHub Release is published.

## Explicit version

The classic form still works unchanged:

```bash
./release.sh 0.3.0
```

## Download mirror

GitHub serves release assets through `release-assets.githubusercontent.com`
with one-hour signed URLs. Some networks filter that host, and from Taiwan it
has measured under 60 KB/s — below what a 200 MB installer needs to finish
before its URL expires (2026-09-16, users could not download the DMG from
GitHub or navide.dev, which linked the same URL). Every release is therefore
also served from `https://dl.navide.dev`, a CloudFront distribution in front of
the private S3 bucket `navide-releases` (AWS account NT-網域, which also holds
the `navide.dev` zone).

- **Who writes it**: `.github/workflows/mirror.yml`, called by `release.yml`
  just before the job that publishes the release. It downloads the finished
  (still draft) GitHub Release on the runner, uploads
  it to `releases/<tag>/` (permanent) plus a `SHA256SUMS`, replaces
  `releases/latest/` wholesale, invalidates CloudFront, then downloads every
  file back from `dl.navide.dev` and fails on any sha256 mismatch. A release
  missing one platform's manifest is not mirrored at all — a partial mirror
  would send visitors to 404s.
- **Who reads it**: the website probes `releases/<tag>/<file>` with a HEAD and
  links there when it answers, GitHub otherwise (navide-web `src/release.ts`);
  the in-app updater reads `releases/latest/` as its feed and switches to the
  GitHub Release only after a network failure on the mirror
  (`src/main/updater-mirror-feed.ts`) — so a red `mirror-release` job leaves
  every client on the previous version until the mirror is re-run, which is why
  the verify step below is part of every release; the READMEs link the mirror
  first with a *GitHub* link beside each download, and `release.sh` repoints
  both.
- **Backfill or re-run by hand**: `gh workflow run mirror.yml --ref main -f
  tag=vX.Y.Z -f refresh_latest=<true|false>`. Pass `false` for an older
  release so `releases/latest/` keeps pointing at the newest one.
- **Verify**: `scripts/verify-release-mirror.sh vX.Y.Z` (add `--no-latest` for
  a backfilled older release).
- **Cost**: ~1.2 GB of S3 per release; CloudFront traffic has stayed inside the
  free tier. Nothing expires; old releases stay downloadable from the mirror
  as they do from GitHub.

## Git recovery switch

If a release needs the retained Git recovery bundle, launch the application
from its main-process environment with `NAVIDE_GIT_RECOVERY=legacy`. Normal
startup omits the variable: a verified Marketplace package is preferred, then
the removable factory `navide.git` package tries v2. A durable user opt-out
leaves Git absent until **Restore** is selected in Extensions. Load, mount, or
ready failure may select legacy for that process; trust and permission failures
must remain fail closed. Verify the Git left and window surfaces open against
an existing workspace, the Extensions entry reports the expected source and
version, and existing Git preferences and repository selection are still
present. To retry v2, quit the application, remove the variable, and relaunch.
Recovery does not edit Plugin Storage or legacy seed data.

## Notes

- **Bump keywords** (`patch`/`minor`/`major`) compute the next version from the
  current `package.json`. Never hand-edit version numbers — always go through
  `release.sh`, or the version files desync and the script refuses to run.
- **Updates are full downloads**, not deltas. `scripts/fix-mac-update-zip.mjs`
  re-zips the signed app with `ditto` and deliberately leaves the now-stale
  `.zip.blockmap` alone; since `latest-mac.yml` carries no `blockMapSize`,
  electron-updater never consults the blockmap and fetches the whole `.zip`.
- **Channels** (stable/beta) are an orthogonal, user-facing choice in
  Settings → Updates — unrelated to the patch/major tiers. A beta CI publishing
  feed is not wired yet; the App side is ready for it.
- **First run after upgrade**: the backend backs up its JSON stores
  (`<app-data>/store-backups/<version>/`, last 2 kept) and forward-migrates the
  schema, so an upgrade never corrupts saved settings.
- **Rollback**: users can download an older installer from the Releases page; to
  pull a bad auto-update, remove/replace its `latest-mac.yml` / `latest.yml` /
  `latest-linux.yml` on the release **and** re-point the mirror's
  `releases/latest/` at the previous release, since the updater falls back to
  that prefix: `gh workflow run mirror.yml --ref main -f tag=<previous tag> -f
  refresh_latest=true`. The bad version's own `releases/<tag>/` copy can stay —
  nothing links to it once the website's release list moves on — or be
  removed with `aws s3 rm --recursive`. A complete release carries
  `Navide-<v>-arm64.dmg` + `.zip` (+ `.blockmap`), `Navide-<v>-win-x64.exe`,
  `Navide-<v>-win-arm64.exe` (+ `.blockmap`), `Navide-<v>-x86_64.AppImage`,
  `Navide-<v>-amd64.deb`, and the three manifests.
