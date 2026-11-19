# Moving the first-party plugins to their own repositories

Status: preparation (0.2.45, plugin split P3 and P4). Nothing has moved yet.
Each repository is created by the user under `Navide-dev`; until then this
page is the inventory, per plugin, of what moves, what stays and what has to
change on each side. The order is Git, then Mini-IDE, Browser and Plans. The
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
...). The check covers the build only. The plugins' tests still run in the
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
| `src/components/__tests__/MultiRepoGit.test.ts`, `src/GitLeftApp.shortcuts.test.ts` | Import `@navide/plugin-ui/shared/testing`, which the published package does not export | Add a public testing export to `@navide/plugin-ui` (an addition, so allowed in 1.x) or keep local test helpers. |

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

## What the user does

1. Create each repository under `Navide-dev` (names and visibility are the
   user's call) and grant push access.
2. Publish `@navide/plugin-*` 1.0.0 to npm (see
   [Plugin development v2](plugin-development-v2.md#publishing-the-public-packages-to-npm)),
   so the moved plugins install them from the registry.
3. Approve each plugin's Marketplace publications, as today.
