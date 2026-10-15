import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { MINI_IDE_PLUGIN_REQUIRES } from './src/shared/pluginCapabilities'

// ── Mini-IDE plugin bundle (Phase 2 M4) ──────────────────────────────────────
// A SEPARATE Vite build from the core renderer (electron.vite.config.ts). The
// separation is load-bearing: it lets this bundle alias `composables/useBackend`
// to the `capabilityBackend` shim WITHOUT touching the core renderer, which
// keeps its real WebSocket-backed `useBackend`. (A shared build can't diverge a
// module per entry — EditorWindowApp is one module in the graph — so the design
// calls for core and plugin to "each build their own copy, not runtime-shared".)
//
// Output: dist-plugins/mini-ide/ — shipped inside the app package as the
// bundled builtin copy (electron-builder `extraResources` → resources/plugins/
// mini-ide; `pnpm build` chains this build so packaging always has it). The
// same bundle is also distributed as a marketplace extension
// (`scripts/package-mini-ide.sh` — the future update path); in dev the app
// resolves the builtin straight from this local build.

const APP_VERSION: string = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf-8')
).version

// Root at the plugin dir so its index.html emits directly at the outDir root
// (out/renderer/plugins/mini-ide/index.html) rather than nested. Imports reach
// outside this root into src/ — fine for a build (no dev-server fs restriction).
const pluginRoot = resolve(__dirname, 'src/renderer/plugins/mini-ide')
const capabilityBackend = resolve(pluginRoot, 'capabilityBackend')
const capabilityShell = resolve(pluginRoot, 'capabilityShell')
const outDir = resolve(__dirname, 'dist-plugins/mini-ide')

// Emit manifest.json into the bundle so the SAME output serves as the app's
// bundled builtin copy (validated by installedPlugins.loadPluginDir at
// startup) and as the marketplace package staged by package-mini-ide.sh.
// Registry-schema superset of the loader fields (id/version/entry/requires).
function emitManifest(): Plugin {
  return {
    name: 'emit-mini-ide-manifest',
    closeBundle() {
      const manifest = {
        id: 'navide.mini-ide',
        name: 'Mini-IDE',
        displayName: 'Navide Mini-IDE',
        description: 'Editor, diff, git and terminal surface for Navide workspaces.',
        version: APP_VERSION,
        publisher: 'navide',
        engines: { navide: '^0.1.0' },
        entry: 'index.html',
        requires: MINI_IDE_PLUGIN_REQUIRES,
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
    // Redirect the mini-IDE's `useBackend` to the capability shim — for THIS
    // bundle only. Covers every relative form the tree uses:
    //   ./composables/useBackend  ../composables/useBackend
    //   ../../composables/useBackend  ./useBackend  ../useBackend
    alias: [
      { find: /^(?:\.\.?\/)+(?:composables\/)?useBackend$/, replacement: capabilityBackend },
      // Same swap for the privileged shell actions: a plugin view has no
      // `window.agentTeam`, so hostShell's calls must go through the broker.
      { find: /^(?:\.\.?\/)+(?:composables\/)?hostShell$/, replacement: capabilityShell },
      { find: '@navide/plugin-ui/shared', replacement: resolve(__dirname, 'packages/plugin-ui/src/shared/index.ts') },
      { find: '@navide/plugin-ui/file-picker', replacement: resolve(__dirname, 'packages/plugin-ui/src/terminalFilePicker.ts') },
      { find: '@navide/plugin-ui/editor', replacement: resolve(__dirname, 'packages/plugin-ui/src/editor/index.ts') },
      { find: '@navide/plugin-ui/styles.css', replacement: resolve(__dirname, 'packages/plugin-ui/src/foundation/styles.css') },
      { find: '@navide/plugin-ui/foundation', replacement: resolve(__dirname, 'packages/plugin-ui/src/foundation/index.ts') },
      { find: '@navide/plugin-ui', replacement: resolve(__dirname, 'packages/plugin-ui/src/index.ts') },
      { find: '@navide/terminal', replacement: resolve(__dirname, 'src/renderer/src/platform/terminal/index.ts') },
      { find: '@navide/plugin-shell', replacement: resolve(__dirname, 'src/renderer/src/platform/plugin-shell/index.ts') },
    ],
  },
  define: {
    __APP_BUILD__: JSON.stringify(`v${APP_VERSION} plugin`),
  },
  optimizeDeps: {
    include: ['monaco-editor'],
  },
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: { index: resolve(pluginRoot, 'index.html') },
    },
  },
})
