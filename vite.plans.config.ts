import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { PLANS_PLUGIN_REQUIRES } from './src/shared/pluginCapabilities'

// ── Plans plugin bundle ──────────────────────────────────────────────────────
// A SEPARATE Vite build from the core renderer (electron.vite.config.ts),
// mirroring vite.mini-ide.config.ts. The separation is load-bearing: it lets
// this bundle alias `composables/useBackend` to the `capabilityBackend` shim
// WITHOUT touching the core renderer, which keeps its real WebSocket-backed
// `useBackend`. (A shared build can't diverge a module per entry —
// PlanWindowApp is one module in the graph.)
//
// Output: dist-plugins/plans/ — the frontend-only bundled builtin copy
// (electron-builder `extraResources` → resources/plugins/plans). The packaged
// backend fixture is built separately into dist-test-fixtures/ and is used
// only by the Issue 21 integration composition; it is never part of this
// application resource tree. In dev, AGENT_TEAM_PLUGIN_DEV=1 registers a
// descriptor pointing straight at this local build.

const APP_VERSION: string = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf-8')
).version

// Root at the plugin dir so its index.html emits directly at the outDir root
// rather than nested. Imports reach outside this root into src/ — fine for a
// build (no dev-server fs restriction).
const pluginRoot = resolve(__dirname, 'src/renderer/plugins/plans')
const capabilityBackend = resolve(pluginRoot, 'capabilityBackend')
const outDir = resolve(__dirname, 'dist-plugins/plans')

// Emit manifest.json into the bundle so the SAME output serves as the app's
// bundled builtin copy (validated by installedPlugins.loadPluginDir at
// startup). Registry-schema superset of the loader fields
// (id/version/entry/requires); kept in sync with
// src/renderer/plugins/plans/plugin.json.
function emitManifest(): Plugin {
  return {
    name: 'emit-plans-manifest',
    closeBundle() {
      const manifest = {
        id: 'navide.plans',
        name: 'Plans',
        displayName: 'Navide Plans',
        description: 'Plan review and execution surface for Navide workspaces.',
        version: APP_VERSION,
        publisher: 'navide',
        engines: { navide: '^0.1.0' },
        entry: 'index.html',
        requires: PLANS_PLUGIN_REQUIRES,
        // No activationEvents — see vite.git.config.ts.
      }
      writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    },
  }
}

export default defineConfig({
  root: pluginRoot,
  // Relative base so emitted asset URLs resolve under file:// in the packaged
  // WebContentsView (no dev server here — this entry is always loadFile'd).
  base: './',
  plugins: [vue(), emitManifest()],
  resolve: {
    // Redirect the Plans UI's `useBackend` to the capability shim — for THIS
    // bundle only. Covers every relative form the tree uses:
    //   ./composables/useBackend  ../composables/useBackend
    //   ../../composables/useBackend  ./useBackend  ../useBackend
    alias: [
      { find: /^(?:\.\.?\/)+(?:composables\/)?useBackend$/, replacement: capabilityBackend },
      { find: '@navide/plugin-sdk', replacement: resolve(__dirname, 'packages/plugin-sdk/src/index.ts') },
      { find: '@navide/plugin-contracts', replacement: resolve(__dirname, 'packages/plugin-contracts/src/index.ts') },
      { find: '@navide/plugin-ui/shared', replacement: resolve(__dirname, 'packages/plugin-ui/src/shared/index.ts') },
      { find: '@navide/plugin-ui/styles.css', replacement: resolve(__dirname, 'packages/plugin-ui/src/foundation/styles.css') },
      { find: '@navide/plugin-ui/foundation', replacement: resolve(__dirname, 'packages/plugin-ui/src/foundation/index.ts') },
      { find: '@navide/plugin-ui/file-picker', replacement: resolve(__dirname, 'packages/plugin-ui/src/terminalFilePicker.ts') },
      { find: '@navide/plugin-ui', replacement: resolve(__dirname, 'packages/plugin-ui/src/index.ts') },
      { find: '@navide/terminal', replacement: resolve(__dirname, 'src/renderer/src/platform/terminal/index.ts') },
      // The renderer terminal code imports @navide/nvterm (terminalKit); production builds drop it.
      { find: '@navide/nvterm', replacement: resolve(__dirname, 'packages/nvterm/src/index.ts') },
      { find: '@navide/plugin-shell', replacement: resolve(__dirname, 'src/renderer/src/platform/plugin-shell/index.ts') },
    ],
  },
  define: {
    __APP_BUILD__: JSON.stringify(`v${APP_VERSION} plugin`),
  },
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: { index: resolve(pluginRoot, 'index.html') },
    },
  },
})
