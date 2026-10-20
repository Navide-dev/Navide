import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'

const packageRoot = resolve(__dirname)
const repositoryRoot = resolve(packageRoot, '../..')
const frontendRoot = resolve(packageRoot, 'frontend')
const sourceManifest = JSON.parse(readFileSync(resolve(packageRoot, 'manifest.json'), 'utf8'))
const artifactVersion = process.env.NAVIDE_PLUGIN_ARTIFACT_VERSION
  ?? (existsSync(resolve(repositoryRoot, 'package.json'))
    // The repository build stamps the root app version; an external consumer
    // that copies this config has no root package.json and keeps its own.
    ? JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')).version
    : sourceManifest.version)
if (typeof artifactVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(artifactVersion)) {
  throw new Error('NAVIDE_PLUGIN_ARTIFACT_VERSION must be strict semver')
}
const pluginDistDir = process.env.NAVIDE_BROWSER_DIST_DIR
  ? (() => {
      if (!isAbsolute(process.env.NAVIDE_BROWSER_DIST_DIR)) throw new Error('NAVIDE_BROWSER_DIST_DIR must be absolute')
      return resolve(process.env.NAVIDE_BROWSER_DIST_DIR)
    })()
  : resolve(repositoryRoot, 'dist-plugins/navide-browser')
const frontendOutDir = resolve(pluginDistDir, 'frontend')
const legacyAssetsDir = resolve(pluginDistDir, 'assets')
function outputFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory()
      ? outputFiles(resolve(directory, entry.name)).map((file) => `${entry.name}/${file}`)
      : [entry.name]
  )).sort()
}
function sourceFiles(directory: string): string[] {
  return readdirSync(resolve(packageRoot, directory), { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory()
      ? (entry.name === '__pycache__' ? [] : sourceFiles(`${directory}/${entry.name}`))
      : [`${directory}/${entry.name}`])
    .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.pyc'))
    .sort()
}
function packageFiles(packageName: string): string[] {
  // `require.resolve` cannot resolve these packages: their exports maps expose
  // only ESM conditions. Mirror Node's node_modules walk instead.
  let directory = packageRoot
  for (;;) {
    const candidate = resolve(directory, 'node_modules', packageName)
    if (existsSync(resolve(candidate, 'package.json'))) {
      const files = (current: string): string[] => readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(current, entry.name)
        return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : []
      })
      return files(resolve(candidate, 'dist')).map((file) => relative(candidate, file)).sort()
        .map((file) => `${packageName}/${file}\0${readFileSync(resolve(candidate, file), 'utf8')}\0`)
    }
    const parent = resolve(directory, '..')
    if (parent === directory) throw new Error(`cannot resolve ${packageName} from ${packageRoot}`)
    directory = parent
  }
}
const provenanceInputs = [...sourceFiles('src'), ...sourceFiles('backend'), 'manifest.json', 'vite.config.ts']
const buildId = createHash('sha256')
  .update(provenanceInputs.map((file) => `${file}\0${readFileSync(resolve(packageRoot, file), 'utf8')}\0`).join(''))
  .update(`artifact-version\0${artifactVersion}\0`)
  .update(['@navide/plugin-contracts', '@navide/plugin-sdk', '@navide/plugin-ui'].flatMap(packageFiles).join(''))
  .digest('hex')
  .slice(0, 16)

const emitManifest: Plugin = {
  name: 'emit-navide-browser-manifest',
  buildStart() {
    rmSync(legacyAssetsDir, { recursive: true, force: true })
  },
  closeBundle(error) {
    // Rollup also calls closeBundle when the build fails, before anything was
    // written; scanning the missing outDir would replace the real build error
    // with an ENOENT.
    if (error) return
    const manifest = { ...sourceManifest, version: artifactVersion }
    mkdirSync(pluginDistDir, { recursive: true })
    writeFileSync(resolve(pluginDistDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    writeFileSync(
      resolve(pluginDistDir, 'artifact-files.json'),
      `${JSON.stringify({ files: ['manifest.json', ...outputFiles(frontendOutDir).map((file) => `frontend/${file}`)] }, null, 2)}\n`,
    )
  },
}

export default defineConfig({
  root: frontendRoot,
  base: './',
  define: {
    __NAVIDE_BROWSER_BUILD_ID__: JSON.stringify(buildId),
  },
  plugins: [vue(), emitManifest],
  build: {
    outDir: frontendOutDir,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        left: resolve(frontendRoot, 'left/index.html'),
        window: resolve(frontendRoot, 'window/index.html'),
      },
    },
  },
})
