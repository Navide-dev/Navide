# Moving the first-party plugins to their own repositories

Status: navide.git moved in 0.2.46 to
[Navide-dev/navide-git](https://github.com/Navide-dev/navide-git) (history kept
from `plugins/navide-git`); the App installer takes its pinned version from
the official Registry (`scripts/stage-official-plugin-artifacts.mjs`) and the
Host keeps the Host half of its tests (`tests/infrastructure/gitPluginHostChecks.test.ts`).
navide.mini-ide followed in the same version to
[Navide-dev/navide-mini-ide](https://github.com/Navide-dev/navide-mini-ide).
Their sections below are the record of those moves. Browser and Plans have
not moved yet; for them this page is the inventory of what moves, what stays
and what has to change on each side. The order is Git, then Mini-IDE, Browser and Plans. The
overall plan is in `.agent-team/plans/plan_8508e9.html` (P3, P4).

## Building outside the monorepo

Each plugin depends on the public packages through `^1.x` ranges
(`@navide/plugin-contracts`, `@navide/plugin-sdk`, `@navide/plugin-ui`) and
carries its own `build`, `typecheck`, `check` and `package` scripts. Its Vite
config builds into `dist-plugins/<dir>` inside the Navide repository and into
its own `dist/` anywhere else.

```text
scripts/publish-public-packages.sh                          # dry run: packs dist/npm/*.tgz
node scripts/verify-plugin-standalone.mjs <dir>             # copy outside the repo, npm install, typecheck, build, validate, package
node scripts/verify-plugin-standalone.mjs <dir> --registry  # same, from npm once the packages are published
```

`<dir>` is the directory under `plugins/` (`navide-git`, `navide-mini-ide`,
...). A plugin with a native backend is built for this host's target: the
backend comes from the repository's `scripts/build-<name>-v2-backend.mjs`,
pointed at the copy through `NAVIDE_<NAME>_SOURCE_DIR` and
`NAVIDE_<NAME>_DIST_DIR`. Browser packages it with the repository's
`backend/` environment; Plans in an isolated environment (see below). Both use
the PyInstaller version `backend/uv.lock` pins. The check covers the build
only. The plugins' tests still run in the
monorepo (`pnpm test:plugins`); the couplings listed per plugin keep them
there.

## navide.git

### What moves

| Path | Notes |
|---|---|
| `plugins/navide-git/**` | Manifest, `package.json`, `src/`, `frontend/`, `assets/`, `schemas/`, `tests/`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`. Move with history (`git filter-repo --path plugins/navide-git/ --path-rename plugins/navide-git/:`). |
| `plugins/navide-git/src/git-feature/gitBridgeContract.json` | The plugin's copy of the Git bridge contract. It keeps a copy; see "Contract" below. |
| `.github/workflows/plugin-git.yml` | Becomes the new repository's CI, rewritten to `npm ci` and the plugin's own scripts (it runs Bun and the monorepo's root scripts today). |
| `scripts/verify-plugin-standalone.mjs navide-git` | Its steps become that CI's build job; the script itself stays here until the move. |

### What stays in the Host

| Path | Why |
|---|---|
| `src/shared/gitBridgeContract.json`, `src/main/plugins/gitBridgeContract.test.ts`, `tests/infrastructure/gitBridgeContract.test.ts` | The Host side of the bridge contract. |
| `src/main/plugins/factoryGitStartup.ts`, `gitV2ActivationRecovery.ts`, `gitStorageMigration.ts`, `gitStorageLifecycle.ts`, `gitPublicCapability.ts`, `gitAccountCapability.ts` | Host loading, recovery, storage and capabilities. Account code is RULE ZERO scope: the move changes no behavior there. |
| `backend/agent_team_backend/git_service.py`, the `git.*` handlers in `ws_handlers.py` | The Git operations the bridge calls. |
| `src/main/plugins/officialPluginVersions.ts` (`navide.git` entry) | The bundled version, which becomes the version pinned for the installer. |
| `scripts/stage-official-plugin-artifacts.mjs`, `scripts/publish-first-party-plugins.sh` | Switch from building `dist-plugins/navide-git` to downloading the pinned, signed Marketplace package (P3, after the move). |
| `tests/infrastructure/hostHasNoGitUi.test.ts` | A Host rule: no Git UI in the Host. |

### Contract

The bridge stays first-party only. Both copies of `gitBridgeContract.json`
change together today; after the move the plugin repository pins the contract
version it was built against, the Host keeps its own copy and tests, and a
Host change to the contract bumps its version (a removal or rename is a
major). The plugin declares the lowest Host it needs in `engines.navide`.

### Couplings to resolve before the tests can move

| Test or file | Coupling | Change |
|---|---|---|
| `vitest.config.ts` | `pluginVitestConfig` from the root `vitest.plugin.ts`, and `tests/support/publicPackagesSetup.ts` as global setup | A self-contained Vitest config with happy-dom and `@vue/test-utils` as dev dependencies. |
| `tests/packageBoundary.test.ts` | Imports the Host loader `src/main/plugins/installedPlugins` | Use `navide-plugin validate` on the built package instead. |
| `tests/optionalPackageBoundary.test.ts` | Imports `src/shared/gitCompatibility`; checks `packages/features` is absent | Keep the compatibility check on the Host side; drop the monorepo layout checks. |
| `tests/sharedOwnershipBoundary.test.ts` | Reads `packages/plugin-ui/src` and `package.json` | Check against the installed `@navide/plugin-ui` exports instead. |
| `tests/compositionBoundary.test.ts` | Packs the plugin and the public packages from the repository; uses `scripts/bun/vue-tsc.cjs` | Install the public packages from npm. |
| `src/git-feature/__tests__/gitTransport.inventory.test.ts`, `gitTransport.boundary.test.ts`, `src/__tests__/themeCallSites.test.ts` | Read Host sources under `src/renderer` | Move the Host half to the Host repository; keep only the plugin half. |
| `src/components/__tests__/MultiRepoGit.test.ts`, `src/GitLeftApp.shortcuts.test.ts` | Import `@navide/plugin-ui/shared/testing` | Resolved in 0.2.45: the published package exports it (Plans' tests use it too). |

### Host references that change when the directory leaves

These read `plugins/navide-git` today and need updating in the same change as
the move: `package.json` (`build:git:v2`, `typecheck:plugin-git`,
`test:plugin:git`), `scripts/official-plugin-fingerprints.mjs` (Git leaves the
fingerprint check; Marketplace's immutable versions take over),
`tests/infrastructure/{officialPluginFingerprints,testDiscovery,truncateCoverage,i18nOwnership,gitBridgeContract}.test.ts`,
`tests/support/publicPackagesSetup.ts` (packs the plugin),
`src/main/plugins/{frontendPluginManager,officialPluginVersions,pluginDetailTargetSchema,gitBridgeContract}.test.ts`,
`src/main/crossPlatformTestHygiene.test.ts`,
`src/main/noScatteredPlatformBranches.test.ts`, and
`backend/agent_team_backend/bundled_skills/plugin-authoring/SKILL.md`.

## navide.mini-ide

`node scripts/verify-plugin-standalone.mjs navide-mini-ide` passes (universal,
no backend). Building on its own surfaced one undeclared dependency,
`mermaid`, which the monorepo used to resolve from the root; it is declared
now. The tests' type imports (`vitest`, `@vue/test-utils`) are dev
dependencies because `tsconfig.json` includes the test files.

### What moves

| Path | Notes |
|---|---|
| `plugins/navide-mini-ide/**` | Manifest, `package.json`, `src/`, `frontend/`, `assets/`, `tests/`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, with history. |
| The Mini-IDE half of `tests/infrastructure/miniIdeMonacoWorkerFallbacks.test.ts` | It checks the build's Monaco worker fallback removal in `vite.config.ts`; that check moves with the config. |

### What stays in the Host

| Path | Why |
|---|---|
| `src/renderer/plugins/mini-ide/`, `vite.mini-ide.config.ts`, `dist-plugins/mini-ide` (`build:mini-ide`) | The legacy recovery bundle the Host keeps; not the Manifest v2 package. |
| `src/main/plugins/officialPluginVersions.ts` (`navide.mini-ide` entry) | Becomes the version pinned for the installer. |
| `scripts/stage-official-plugin-artifacts.mjs`, `scripts/publish-first-party-plugins.sh` | Switch to the pinned, signed Marketplace package after the move. |

The editor port and `system.aiCli` are public capabilities; Mini-IDE has no
private bridge to version.

### Couplings to resolve before the tests can move

| Test or file | Coupling | Change |
|---|---|---|
| `vitest.config.ts` | `pluginVitestConfig` from the root `vitest.plugin.ts`, and `tests/support/publicPackagesSetup.ts` | A self-contained Vitest config with happy-dom as a dev dependency. |
| `tests/manifest.test.ts` | Imports the Host loader (`src/main/plugins/installedPlugins`, `pluginManifestV2`) and reads `dist-plugins/navide-mini-ide` | Use `navide-plugin validate` on the built `dist/`. |
| `tests/packageBoundary.test.ts` | Packs the public packages from the repository, links third-party packages from its `node_modules`, uses `scripts/bun/vue-tsc.cjs` | Install the public packages from npm. |

### Host references that change when the directory leaves

`package.json` (`build:mini-ide:v2`, `typecheck:plugin-mini-ide`, the
`typecheck` chain), `scripts/official-plugin-fingerprints.mjs`,
`tests/infrastructure/{artifactInputs,ciTriage,i18nOwnership,mermaidClassicLook,miniIdeMonacoWorkerFallbacks,officialPluginFingerprints,testDiscovery,truncateCoverage}.test.ts`,
`tests/support/publicPackagesSetup.ts`,
`src/main/plugins/officialPluginVersions.test.ts`, and
`backend/agent_team_backend/bundled_skills/plugin-authoring/SKILL.md`.

## navide.browser

`node scripts/verify-plugin-standalone.mjs navide-browser` passes for the
build host's target (`darwin-arm64` here): the frontend builds from the copy
and the backend from the copy's `backend/browser_backend.py`. The backend is
standard-library Python, so the plugin needs no Python SDK; what it still
borrows is the toolchain that packages it.

### What moves

| Path | Notes |
|---|---|
| `plugins/navide-browser/**` | Manifest, `package.json`, `src/`, `frontend/`, `backend/`, `tests/`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, with history. |
| `scripts/build-browser-v2-backend.mjs` | Becomes the plugin's own backend build, with a `pyproject.toml` and `uv.lock` of its own that pin PyInstaller (today it runs from `backend/`). |
| `.github/workflows/browser-plugin-package.yml` | Becomes the new repository's packaging CI: one job per target (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`, `win32-arm64`), since PyInstaller builds only for the host it runs on. |

### What stays in the Host

| Path | Why |
|---|---|
| The `web.view` and `web.cdp` capabilities and the plugin web view host (`src/main/plugins/pluginWebViewHost.ts`) | Public capabilities the plugin declares (`web`); there is no private bridge. |
| First-party backend and agent-tool admission (`src/main/plugins/pluginThirdPartyBackends.ts`) | Host policy for `navide.*` packages from the Official Registry or the App bundle. |
| `src/main/plugins/officialPluginVersions.ts` (`navide.browser` entry), `scripts/stage-official-plugin-artifacts.mjs`, `scripts/publish-first-party-plugins.sh`, the `release.yml` installer checks | Pin, stage and check the installer's copy; they switch to the signed Marketplace package after the move. |

### Couplings to resolve before the tests can move

| Test or file | Coupling | Change |
|---|---|---|
| `vitest.config.ts` | `pluginVitestConfig` from the root `vitest.plugin.ts` | A self-contained Vitest config with happy-dom as a dev dependency. |
| `tests/manifest.test.ts` | Imports `packages/plugin-contracts/src` and the Host's `src/main/plugins/pluginManifestV2` | Parse with the installed `@navide/plugin-contracts`; leave the Host parser check in the Host. |
| `src/themeTokens.test.ts` | Reads `packages/plugin-ui/src` | Read the tokens from the installed `@navide/plugin-ui`. |
| `vite.config.ts` build id | Hashes the installed public packages' `dist/`, found by walking `node_modules` | Works as is outside the monorepo. |

### Host references that change when the directory leaves

`package.json` (`build:browser`, `build:browser:v2`, `build:browser:backend`,
the `typecheck` chain), `scripts/official-plugin-fingerprints.mjs`,
`tests/infrastructure/i18nOwnership.test.ts`,
`tests/integration/plansBuildScripts.test.ts` (the release-workflow checks
for the Browser backend), `src/main/index.ts` (the factory Browser load),
`src/main/plugins/officialPluginVersions.test.ts`,
`.github/workflows/release.yml`, and
`backend/agent_team_backend/bundled_skills/plugin-authoring/SKILL.md`.

## navide.plans

`node scripts/verify-plugin-standalone.mjs navide-plans` passes for the
build host's target after `scripts/publish-python-plugin-sdk.sh` has built the
Python SDK wheel: the frontend builds from the copy, and the backend from the
copy's `backend/plans_backend.py` in an isolated `uv run --no-project`
environment holding only PyInstaller (the `backend/uv.lock` pin), the copy's
`backend/requirements.txt` (`navide-plugin-sdk>=1.0.0,<2`, `pyyaml>=6.0`, the
ranges `backend/pyproject.toml` carries) and that wheel. Nothing of the
repository's `backend/` goes into the executable. Building on its own also
surfaced `mermaid`, imported by the retained Markdown body but never
declared; it is declared now.

### What moves

| Path | Notes |
|---|---|
| `plugins/navide-plans/**` | Manifest, `package.json`, `src/`, `frontend/`, `backend/` (with `requirements.txt`), `tests/`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, with history. |
| `scripts/build-plans-v2-backend.mjs` | Becomes the plugin's own backend build; its standalone path (isolated environment, SDK from PyPI) becomes the only one, with a lock file of its own for PyInstaller and PyYAML. |
| `.github/workflows/plugin-packages.yml` | Becomes the new repository's packaging CI, one job per target. |

### What stays in the Host

| Path | Why |
|---|---|
| `backend/navide_plugin_sdk` and `packages/plugin-sdk-python/` | The public Python SDK, published to PyPI from the Navide repository like the npm packages. |
| `src/renderer/plugins/plans/`, `vite.plans.config.ts`, `NAVIDE_PLANS_RECOVERY=legacy` | The legacy recovery view the Host keeps. |
| `registerBundledPlans` (`src/main/plugins/frontendPluginManager.ts`, called from `src/main/index.ts`), `src/main/plugins/plansBridge.ts`, `plansStorage*.ts`, `plansDirectories.ts` | Host loading of the bundled copy, the Plans bridge and plan storage. |
| `src/main/plugins/officialPluginVersions.ts` (`navide.plans` entry), `scripts/stage-official-plugin-artifacts.mjs`, `scripts/publish-first-party-plugins.sh`, the `release.yml` installer checks | Pin, stage and check the installer's copy. |

### Couplings to resolve before the tests can move

| Test or file | Coupling | Change |
|---|---|---|
| `vitest.config.ts` | `pluginVitestConfig` from the root `vitest.plugin.ts`, and `tests/support/publicPackagesSetup.ts` | A self-contained Vitest config with happy-dom and `@vue/test-utils` as dev dependencies. |
| `tests/packageBoundary.test.ts` | Reads the repository layout and builds against the packed public packages | Install the public packages from npm. |
| `tests/integration/plans*.test.ts`, `backend/tests/test_plans_review_parity.py` | Host-side tests that build or drive the plugin from `plugins/navide-plans` | Keep the Host half; run the plugin half in the plugin repository against the published SDK. |

### Host references that change when the directory leaves

`package.json` (`build:plans`, `build:plans:v2`, `build:plans:backend`,
`typecheck:plugin-plans`, the `typecheck` chain),
`scripts/official-plugin-fingerprints.mjs` (the Plans entry also counts the
Python SDK modules), `tests/integration/plansBuildScripts.test.ts`,
`src/main/plugins/{plansProvenance,officialPluginVersions}.test.ts`,
`.github/workflows/release.yml`, and
`backend/agent_team_backend/bundled_skills/plugin-authoring/SKILL.md`.

## What the user does

1. Create each repository under `Navide-dev` (names and visibility are the
   user's call) and grant push access.
2. Publish `@navide/plugin-*` 1.0.0 to npm (see
   [Plugin development v2](plugin-development-v2.md#publishing-the-public-packages-to-npm)),
   so the moved plugins install them from the registry.
3. Publish `navide-plugin-sdk` to PyPI (see
   [Plugin development v2](plugin-development-v2.md#publishing-the-python-plugin-sdk-to-pypi)),
   so the moved Plans backend installs it from PyPI.
4. Approve each plugin's Marketplace publications, as today.
