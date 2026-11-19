# Moving navide.git to its own repository

Status: preparation (0.2.45, plugin split P3). Nothing has moved yet. The new
repository is created by the user under `Navide-dev`; until then this page is
the inventory of what moves, what stays and what has to change on each side.
The overall plan is in `.agent-team/plans/plan_8508e9.html` (P3).

## What already works outside the monorepo

`plugins/navide-git` depends on the public packages through `^1.x` ranges
(`@navide/plugin-contracts`, `@navide/plugin-sdk`, `@navide/plugin-ui`) and
carries its own `build`, `typecheck`, `check` and `package` scripts. Its Vite
config builds into `dist-plugins/navide-git` inside the Navide repository and
into its own `dist/` anywhere else.

```text
scripts/publish-public-packages.sh               # dry run: packs dist/npm/*.tgz
node scripts/verify-git-plugin-standalone.mjs    # copy outside the repo, npm install, typecheck, build, validate, package
node scripts/verify-git-plugin-standalone.mjs --registry   # same, from npm once the packages are published
```

The check covers the build only. The plugin's tests still run in the monorepo
(`pnpm test:plugin:git`); the couplings below keep them there.

## What moves

| Path | Notes |
|---|---|
| `plugins/navide-git/**` | Manifest, `package.json`, `src/`, `frontend/`, `assets/`, `schemas/`, `tests/`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`. Move with history (`git filter-repo --path plugins/navide-git/ --path-rename plugins/navide-git/:`). |
| `plugins/navide-git/src/git-feature/gitBridgeContract.json` | The plugin's copy of the Git bridge contract. It keeps a copy; see "Contract" below. |
| `.github/workflows/plugin-git.yml` | Becomes the new repository's CI, rewritten to `npm ci` and the plugin's own scripts (it runs Bun and the monorepo's root scripts today). |
| `scripts/verify-git-plugin-standalone.mjs` | Its steps become that CI's build job; the script itself stays here until the move. |

## What stays in the Host

| Path | Why |
|---|---|
| `src/shared/gitBridgeContract.json`, `src/main/plugins/gitBridgeContract.test.ts`, `tests/infrastructure/gitBridgeContract.test.ts` | The Host side of the bridge contract. |
| `src/main/plugins/factoryGitStartup.ts`, `gitV2ActivationRecovery.ts`, `gitStorageMigration.ts`, `gitStorageLifecycle.ts`, `gitPublicCapability.ts`, `gitAccountCapability.ts` | Host loading, recovery, storage and capabilities. Account code is RULE ZERO scope: the move changes no behavior there. |
| `backend/agent_team_backend/git_service.py`, the `git.*` handlers in `ws_handlers.py` | The Git operations the bridge calls. |
| `src/main/plugins/officialPluginVersions.ts` (`navide.git` entry) | The bundled version, which becomes the version pinned for the installer. |
| `scripts/stage-official-plugin-artifacts.mjs`, `scripts/publish-first-party-plugins.sh` | Switch from building `dist-plugins/navide-git` to downloading the pinned, signed Marketplace package (P3, after the move). |
| `tests/infrastructure/hostHasNoGitUi.test.ts` | A Host rule: no Git UI in the Host. |

## Contract

The bridge stays first-party only. Both copies of `gitBridgeContract.json`
change together today; after the move the plugin repository pins the contract
version it was built against, the Host keeps its own copy and tests, and a
Host change to the contract bumps its version (a removal or rename is a
major). The plugin declares the lowest Host it needs in `engines.navide`.

## Couplings to resolve before the tests can move

| Test or file | Coupling | Change |
|---|---|---|
| `vitest.config.ts` | `pluginVitestConfig` from the root `vitest.plugin.ts`, and `tests/support/publicPackagesSetup.ts` as global setup | A self-contained Vitest config with happy-dom and `@vue/test-utils` as dev dependencies. |
| `tests/packageBoundary.test.ts` | Imports the Host loader `src/main/plugins/installedPlugins` | Use `navide-plugin validate` on the built package instead. |
| `tests/optionalPackageBoundary.test.ts` | Imports `src/shared/gitCompatibility`; checks `packages/features` is absent | Keep the compatibility check on the Host side; drop the monorepo layout checks. |
| `tests/sharedOwnershipBoundary.test.ts` | Reads `packages/plugin-ui/src` and `package.json` | Check against the installed `@navide/plugin-ui` exports instead. |
| `tests/compositionBoundary.test.ts` | Packs the plugin and the public packages from the repository; uses `scripts/bun/vue-tsc.cjs` | Install the public packages from npm. |
| `src/git-feature/__tests__/gitTransport.inventory.test.ts`, `gitTransport.boundary.test.ts`, `src/__tests__/themeCallSites.test.ts` | Read Host sources under `src/renderer` | Move the Host half to the Host repository; keep only the plugin half. |
| `src/components/__tests__/MultiRepoGit.test.ts`, `src/GitLeftApp.shortcuts.test.ts` | Import `@navide/plugin-ui/shared/testing`, which the published package does not export | Add a public testing export to `@navide/plugin-ui` (an addition, so allowed in 1.x) or keep local test helpers. |

## Host references that change when the directory leaves

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

## What the user does

1. Create the repository under `Navide-dev` (name and visibility are the
   user's call) and grant push access.
2. Publish `@navide/plugin-*` 1.0.0 to npm (see
   [Plugin development v2](plugin-development-v2.md#publishing-the-public-packages-to-npm)),
   so the moved plugin installs them from the registry.
3. Approve each Marketplace publication of navide.git, as today.
