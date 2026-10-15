# Plans v2 recovery runbook

## Symptoms

Use this runbook when the Plans v2 window cannot bind its package backend, a
packaged Plans child exits, or the v2 package is being investigated as a
possible source of malformed plan documents.

When the Host detects an eligible pre-dispatch failure it marks the exact
descriptor and activation unavailable, closes the failed v2 view, opens the
legacy Plans adapter for the same workspace, and re-registers
`plans_backend_v2: false`. The MCP adapter retries legacy only when the Host
explicitly returns `recoveryDisposition: "legacy-safe-before-dispatch"`.

The Host may mint that disposition only before a call reaches the child, after
it has checked the exact descriptor and activation, package-version Grant,
Execution Policy, method allowlist, stopping state, and recovery eligibility.
Timeouts, response loss, protocol errors after dispatch, `PLUGIN_STOPPING`,
Grant revocation, and policy denial never retry legacy. Read operations require
the same disposition. Repeated requests after backend health becomes
unavailable still repeat the Host authorization checks before receiving a
disposition.

## Prove the worktree package before a manual parity check

A verified installed Plans package takes precedence over the factory bundle,
including in development. Rebuilding `dist-plugins/navide-plans` alone does not
prove that an existing app/profile loaded it. Do not remove or overwrite an
installed package to diagnose this.

Use a fresh named development profile and isolate backend and CLI hook state.
All environment changes below apply only to these commands. The explicit PATH
ordering prevents a machine-local mise path overlay from selecting Homebrew's
pnpm during nested package scripts.

```sh
cd /Users/slighter12/git/personal/Navide
plans_node_bin="$(mise where node@22)/bin"
plans_pnpm_bin="$(mise where pnpm@10.0.0)"
plans_probe_dir="$(mktemp -d /private/tmp/navide-plans-parity.XXXXXX)"
plans_probe_profile="parity-$(uuidgen)"

mise exec node@22 pnpm@10.0.0 -- \
  env PATH="$plans_pnpm_bin:$plans_node_bin:$PATH" pnpm run build:plans

AGENT_TEAM_PLUGIN_DEV=1 \
NAVIDE_PLANS_DEV_PROFILE="$plans_probe_profile" \
AGENT_TEAM_DATA_DIR="$plans_probe_dir/data" \
CLAUDE_CONFIG_DIR="$plans_probe_dir/claude" \
QWEN_HOME="$plans_probe_dir/qwen" \
COPILOT_HOME="$plans_probe_dir/copilot" \
mise exec node@22 pnpm@10.0.0 -- \
  env PATH="$plans_pnpm_bin:$plans_node_bin:$PATH" pnpm dev
```

Before testing controls, check the Host's `navide.plans dev provenance` record:

- `selectionOrigin` / `descriptorSource` must identify `factory-bundle` for
  this fresh profile. Acquisition provenance is recorded separately: an
  installed package originally acquired from a factory is still a catalog
  selection.
- `packageDirectory` must be this checkout's canonical
  `dist-plugins/navide-plans`; `packageVersion` must match its built manifest.
- `frontendEntries["navide.plans.window"]` must be the built window entry and
  `backendExecutable` must be the executable inside the same package directory.
- In the plugin view's developer console, inspect
  `window.__NAVIDE_PLANS_PROVENANCE__`. Its `packageSource` must be
  `factory-bundled` (the renderer label differs from the Host's
  `factory-bundle`), and its version must match the selected manifest. Compare
  its `buildId` exactly with the current source identity printed below.
  These diagnostics are opt-in; normal packaged
  launches do not publish the diagnostic query/global.

```sh
mise exec node@22 pnpm@10.0.0 -- \
  env PATH="$plans_pnpm_bin:$plans_node_bin:$PATH" \
  node --input-type=module -e 'import { loadConfigFromFile } from "vite"; const result = await loadConfigFromFile({ command: "build", mode: "production" }, "plugins/navide-plans/vite.config.ts"); console.log(JSON.parse(result.config.define.__NAVIDE_PLANS_BUILD_ID__))'
```

The automated artifact test compares the loaded build identity to current
source inputs and fails on a stale build. Run it after rebuilding:

```sh
NAVIDE_TEST_PRODUCTION_PLANS_BACKEND=1 \
mise exec node@22 pnpm@10.0.0 -- \
  env PATH="$plans_pnpm_bin:$plans_node_bin:$PATH" \
  pnpm test:run tests/integration/plansPackagedRoundtrip.test.ts \
  -t 'loads the Host-selected worktree frontend artifact'
```

Use a disposable fixture workspace for manual checks. Open a plan with both
unresolved user notes and resolved notes with replies and section anchors.
Compare the retained view and plugin view at wide and narrow window sizes:

1. Check stage/progress, toolbar ordering, overflow demotion, panel placement,
   preview spacing, clipping, and scrolling.
2. Open Notes from its promoted button, then exercise Edit, Save, Delete cancel,
   and Delete confirm. Verify the actual input focus and that controls become
   available again after each operation.
3. With zero unresolved notes, open Review Notes from overflow. Confirm it is
   never present in both toolbar and overflow.
4. Click a section's Comment action with the panel both closed and already
   open. Verify the anchor and focus, then submit and reopen the document.
5. Exercise IME Enter, ordinary Enter, and Escape through an edit, draft,
   overflow, and confirmation. Each Escape must peel one state only.
6. Switch plans with a draft/edit/confirmation in progress. No state or delayed
   operation may leak into the next plan. Toggle a todo and check for flashing
   or a scroll jump.

DOM/component and emitted-artifact tests do not implement Chromium hit-testing;
real pointer obstruction, native focus, IME integration, and visual spacing
remain manual checks. See the package's
[v1 test coverage matrix](../../plugins/navide-plans/tests/parity-coverage.md).

## Force the legacy adapter

Start Navide with the process environment below, then reproduce the issue:

```sh
NAVIDE_PLANS_RECOVERY=legacy open -a Navide
```

The override is Host-only. It does not change the selected package descriptor,
the capability Grant, or any Plugin Storage snapshot. Unset the variable and
restart Navide to retry v2.

## Preserve and inspect state

Plans storage is under the app user-data directory:

```text
plugin-storage-v2/
  plans-lifecycle.json
  navide.plans/<package-version>/active/
```

`plans-lifecycle.json` is the authoritative selector for the previous active
package identity. Do not edit snapshot directories or point a renderer at a
`previous` tier. Runtime v2 always binds to the current package's `active`
tier. The Host-only recovery seam `runPlansLegacyRecovery` selects the
lifecycle-recorded previous identity, constructs a read-only recovery context,
and binds the named production `retainedPlansLegacyAdapter` before starting the
retained `PlanWindowApp`/`PlansPane` route. The route receives only the fixed
preference projection through a Host IPC port; the renderer cannot provide a
snapshot, tier, package version, or workspace identity. Its preference and
operations are Host-selected; document operations continue through the
existing legacy backend route. The recovery preference port is read-only, and
the adapter cannot promote, convert, or overwrite the current active snapshot.
The lifecycle record retains the displaced active identity after promotion, so
the same recovery path works when a child fails after migration has already
completed. `readPreviousPlansWorkspacePreference` remains the narrow
single-preference helper for diagnostics.

For a first-install or migration report, capture:

1. the selected package version and package directory;
2. the lifecycle record before and after restart;
3. whether the legacy renderer projected the seven approved preference keys;
4. the Host availability transition and the MCP error code.

Do not copy credentials, bearer tokens, or arbitrary renderer storage into the
report.

The integration proof for the recovery seam is the focused Host test:

```sh
pnpm exec vitest run \
  src/main/plugins/plansStorageMigration.test.ts \
  src/renderer/src/editor/__tests__/PlansPane.test.ts
```

The Host test binds the production legacy adapter to the lifecycle-selected
previous snapshot, verifies the previous preference and unchanged current
storage, and asserts that recovery issued storage reads only. The retained-pane
component test then starts the actual `PlansPane` used by `PlanWindowApp`,
applies the Host projection, and verifies that current renderer storage is not
rewritten during recovery.

## Recovery acceptance check

After forcing legacy mode, verify that the existing legacy window opens the
same workspace and that `plan_list`/`plan_read` work. Then unset the override,
restart, and verify that a successful v2 bind re-advertises
`plans_backend_v2: true`. A missing `_template.html` must produce an explicit
backend-unavailable result until Host asset provisioning succeeds; it must not
produce a simplified alternate document format.
