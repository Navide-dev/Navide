import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

const packageRoot = resolve(__dirname)
const repositoryRoot = resolve(packageRoot, '../..')
const sourceManifest = JSON.parse(readFileSync(resolve(packageRoot, 'manifest.json'), 'utf8'))
// The plugin versions independently of the App: the build keeps the source
// manifest's version unless a one-off package build stamps another.
const artifactVersion = process.env.NAVIDE_PLUGIN_ARTIFACT_VERSION ?? sourceManifest.version
if (typeof artifactVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(artifactVersion)) {
  throw new Error('NAVIDE_PLUGIN_ARTIFACT_VERSION must be strict semver')
}
const outDir = process.env.NAVIDE_GIT_DIST_DIR
  ? (() => {
      if (!isAbsolute(process.env.NAVIDE_GIT_DIST_DIR)) throw new Error('NAVIDE_GIT_DIST_DIR must be absolute')
      return resolve(process.env.NAVIDE_GIT_DIST_DIR)
    })()
  : resolve(repositoryRoot, 'dist-plugins/navide-git')
function outputFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory()
      ? outputFiles(resolve(directory, entry.name)).map((file) => `${entry.name}/${file}`)
      : [entry.name]
  )).sort()
}

const emitManifest: Plugin = {
  name: 'emit-navide-git-manifest',
  closeBundle() {
    const manifest = { ...sourceManifest, version: artifactVersion }
    mkdirSync(outDir, { recursive: true })
    writeFileSync(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const assetsDir = resolve(outDir, 'assets')
    mkdirSync(assetsDir, { recursive: true })
    copyFileSync(resolve(packageRoot, 'assets/git.png'), resolve(assetsDir, 'git.png'))
    const schemasDir = resolve(outDir, 'schemas')
    mkdirSync(schemasDir, { recursive: true })
    copyFileSync(
      resolve(packageRoot, 'schemas/branch-comparison.json'),
      resolve(schemasDir, 'branch-comparison.json'),
    )
    writeFileSync(
      resolve(outDir, 'artifact-files.json'),
      `${JSON.stringify({ files: ['manifest.json', ...outputFiles(outDir).filter((file) => file !== 'manifest.json')] }, null, 2)}\n`,
    )
  },
}

export default defineConfig({
  root: packageRoot,
  base: './',
  plugins: [vue(), emitManifest],
  resolve: {
    alias: [
      { find: '#git-feature', replacement: resolve(packageRoot, 'src/git-feature/index.ts') },
    ],
  },
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        left: resolve(packageRoot, 'frontend/left/index.html'),
        detail: resolve(packageRoot, 'frontend/detail/index.html'),
        window: resolve(packageRoot, 'frontend/window/index.html'),
      },
    },
  },
})
