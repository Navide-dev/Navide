import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'
import { testWorkerCap } from './vitest.workerCap'

// Every source test has one owner. Artifact consumers build/pack once before
// their workers start; ordinary tests and CLI contracts need no plugin build.
const allTests = ['vitest.*.{test,spec}.ts', '{src,tests,packages,plugins}/**/*.{test,spec}.ts']
const cliTests = ['tests/cli/**/*.{test,spec}.ts']
const artifactTests = [
  'tests/integration/**/*.{test,spec}.ts',
  'plugins/*/tests/**/*.{test,spec}.ts',
  // CLI subprocesses use Node's package exports, outside Vitest's source aliases.
  'packages/plugin-sdk/bin/**/*.{test,spec}.ts',
  'src/main/plugins/pluginExternalWorkspace.test.ts',
  'src/main/plugins/pluginBackendHost.test.ts',
  'src/main/plugins/pluginBackendSupervisor.test.ts',
]
const excludedTests = ['**/node_modules/**', '**/dist/**', '**/out/**', '**/coverage/**', 'e2e/**']
export default defineConfig({
  // Mirrors electron.vite.config.ts: <webview> carries in-window plugin
  // contributions and is a built-in tag, not a Vue component.
  plugins: [vue({ template: { compilerOptions: { isCustomElement: (tag) => tag === 'webview' } } })],
  resolve: {
    alias: {
      '@navide/plugin-contracts': resolve(__dirname, 'packages/plugin-contracts/src/index.ts'),
      '@navide/plugin-sdk': resolve(__dirname, 'packages/plugin-sdk/src/index.ts'),
      '@navide/plugin-ui/styles.css': resolve(__dirname, 'packages/plugin-ui/src/foundation/styles.css'),
      '@navide/plugin-ui/file-picker': resolve(__dirname, 'packages/plugin-ui/src/terminalFilePicker.ts'),
      '@navide/plugin-ui/shared/testing': resolve(__dirname, 'packages/plugin-ui/src/shared/testing.ts'),
      '@navide/plugin-ui/shared': resolve(__dirname, 'packages/plugin-ui/src/shared/index.ts'),
      '@navide/plugin-ui/foundation': resolve(__dirname, 'packages/plugin-ui/src/foundation/index.ts'),
      '@navide/plugin-ui/editor': resolve(__dirname, 'packages/plugin-ui/src/editor/index.ts'),
      '@navide/plugin-ui': resolve(__dirname, 'packages/plugin-ui/src/index.ts'),
      '@navide/terminal/testing': resolve(__dirname, 'src/renderer/src/platform/terminal/testing.ts'),
      '@navide/terminal': resolve(__dirname, 'src/renderer/src/platform/terminal/index.ts'),
      '@navide/plugin-shell': resolve(__dirname, 'src/renderer/src/platform/plugin-shell/index.ts'),
    },
  },
  define: {
    __APP_BUILD__: JSON.stringify('test')
  },
  test: {
    environment: 'node',
    globals: false,
    // Empty unless a Navide pane carries a worker cap (Settings → Resource limits).
    ...testWorkerCap(process.env),
    projects: [
      { extends: true, test: { name: 'unit', include: allTests, exclude: [...excludedTests, ...cliTests, ...artifactTests] } },
      { extends: true, test: { name: 'cli', include: cliTests, exclude: excludedTests } },
      { extends: true, test: {
        name: 'artifacts', include: artifactTests, exclude: excludedTests,
        globalSetup: ['tests/support/publicPackagesSetup.ts'],
      } },
    ],
    server: {
      deps: {
        // pluginExternalWorkspace.test.ts imports the *built* plugin bundle out
        // of a mkdtemp directory to prove the packaged artifact loads as a real
        // ES module. Vite 6 pulls such a path through its transform pipeline and
        // rejects it for sitting outside the project root; externalizing hands
        // the file to Node's own loader, which is what the assertion is about.
        external: [/navide-plugin-external-/]
      }
    }
  }
})
