import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'

const packageRoot = __dirname

export default defineConfig({
  base: './',
  plugins: [vue()],
  build: {
    outDir: resolve(packageRoot, 'dist'),
    emptyOutDir: true,
    lib: {
      entry: {
        index: resolve(packageRoot, 'src/index.ts'),
        'file-picker': resolve(packageRoot, 'src/terminalFilePicker.ts'),
        'shared/index': resolve(packageRoot, 'src/shared/index.ts'),
        // Test-only resets of the shared settings and keybinding state. A
        // separate entry shares its chunks with shared/index, so it resets the
        // very instances a plugin's code uses.
        'shared/testing': resolve(packageRoot, 'src/shared/testing.ts'),
        'foundation/index': resolve(packageRoot, 'src/foundation/index.ts'),
        'editor/index': resolve(packageRoot, 'src/editor/index.ts'),
        styles: resolve(packageRoot, 'src/styles.ts'),
      },
      formats: ['es'],
      cssFileName: 'styles',
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: ['@navide/plugin-sdk', 'vue', 'vue-i18n', 'monaco-editor'],
      output: {
        assetFileNames: (assetInfo) =>
          assetInfo.name === 'styles.css' ? 'styles.css' : 'assets/[name][extname]',
      },
    },
  },
})
