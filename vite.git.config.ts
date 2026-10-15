import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { GIT_PLUGIN_REQUIRES } from './src/shared/pluginCapabilities'

// ── Git plugin bundle ────────────────────────────────────────────────────────
// A SEPARATE Vite build from the core renderer (electron.vite.config.ts),
// mirroring vite.mini-ide.config.ts / vite.plans.config.ts. It emits the
// standalone navide.git plugin artifact consumed by the plugin loader; the
// composition root constructs the SDK adapter and injects named ports.
//
// Output: dist-plugins/git — shipped inside the app package as the bundled
// builtin copy (electron-builder `extraResources` → resources/plugins/git;
// `pnpm build` chains this build so packaging always has it). In dev,
// AGENT_TEAM_PLUGIN_DEV=1 registers a descriptor pointing straight at this
// local build.

const APP_VERSION: string = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf-8')
).version

// Root at the plugin dir so its index.html emits directly at the outDir root
// rather than nested. Imports reach outside this root into src/ — fine for a
// build (no dev-server fs restriction).
const pluginRoot = resolve(__dirname, 'src/renderer/plugins/git')
const outDir = resolve(__dirname, 'dist-plugins/git')

// Emit manifest.json into the bundle so the SAME output serves as the app's
// bundled builtin copy (validated by installedPlugins.loadPluginDir at
// startup). Registry-schema superset of the loader fields
// (id/version/entry/requires). `git`+`fs` gate the git.* calls and the
// git.changed working-tree event (gated on fs, see capabilityMap.ts); `ui`
// gates the theme settings sync in lib/settings.
function emitManifest(): Plugin {
  return {
    name: 'emit-git-manifest',
    closeBundle() {
      const manifest = {
        id: 'navide.git',
        name: 'Git',
        displayName: 'Navide Git',
        description: 'Standalone Git client surface for Navide workspaces.',
        version: APP_VERSION,
        publisher: 'navide',
        engines: { navide: '^0.1.0' },
        entry: 'index.html',
        requires: GIT_PLUGIN_REQUIRES,
        // No activationEvents: a frontend view starts when the host opens it.
        // The loader does not read the field, so declaring one would only
        // promise a lifecycle nothing implements (see plugin-development.md).
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
    alias: [
      { find: '@navide/plugin-ui/shared', replacement: resolve(__dirname, 'packages/plugin-ui/src/shared/index.ts') },
      { find: '@navide/plugin-ui/styles.css', replacement: resolve(__dirname, 'packages/plugin-ui/src/foundation/styles.css') },
      { find: '@navide/plugin-ui/foundation', replacement: resolve(__dirname, 'packages/plugin-ui/src/foundation/index.ts') },
      { find: '@navide/plugin-ui/file-picker', replacement: resolve(__dirname, 'packages/plugin-ui/src/terminalFilePicker.ts') },
      { find: '@navide/plugin-ui', replacement: resolve(__dirname, 'packages/plugin-ui/src/index.ts') },
      { find: '@navide/terminal', replacement: resolve(__dirname, 'src/renderer/src/platform/terminal/index.ts') },
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
