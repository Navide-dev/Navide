import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sdkCli = join(repositoryRoot, 'packages/plugin-sdk/bin/navide-plugin.mjs')
const outputRoot = join(repositoryRoot, 'dist-plugins/official-artifacts')
const factoryRoot = join(outputRoot, 'factory-resources')
const archivesRoot = join(outputRoot, 'archives')
const hostTarget = `${process.platform}-${process.arch}`

// First-party plugins that live in their own repositories (Navide-dev/navide-git,
// Navide-dev/navide-mini-ide): the installer carries the version
// officialPluginVersions.ts pins, as the official Registry signed it, never a
// local build.
const registrySources = [
  { id: 'navide.git', target: 'universal' },
  { id: 'navide.mini-ide', target: 'universal' },
]
const sources = [
  { id: 'navide.plans', directory: 'dist-plugins/navide-plans', source: 'plugins/navide-plans', target: hostTarget },
  { id: 'navide.browser', directory: 'dist-plugins/navide-browser', source: 'plugins/navide-browser', target: hostTarget },
]

function runCli(args) {
  execFileSync(process.execPath, [sdkCli, ...args], { cwd: repositoryRoot, stdio: 'inherit' })
}

const registryUrl = 'https://server.navide.dev/registry'
// Verified downloads are kept here. Only an explicitly offline build reuses
// them (NAVIDE_OFFICIAL_PLUGIN_OFFLINE=1, or --allow-missing-registry), and
// checks them again: the Registry's trust metadata must still be valid. A
// release always asks the Registry, so a version yanked since is never bundled.
const cacheRoot = process.env.NAVIDE_OFFICIAL_PLUGIN_CACHE || join(homedir(), '.cache', 'navide', 'official-plugins')
const allowMissingRegistry = process.argv.includes('--allow-missing-registry')
const allowOfflineCache = allowMissingRegistry || process.env.NAVIDE_OFFICIAL_PLUGIN_OFFLINE === '1'

// The App's own verification code is TypeScript: bundle the one module this
// needs. It never touches electron, which some of its imports name.
async function loadHostModules() {
  const { build } = await import('vite')
  const directory = mkdtempSync(join(tmpdir(), 'navide-official-registry-'))
  try {
    const entry = join(directory, 'entry.ts')
    writeFileSync(entry, [
      `export * from ${JSON.stringify(join(repositoryRoot, 'src/main/plugins/officialRegistryArtifact.ts'))}`,
      `export { OFFICIAL_PLUGIN_VERSIONS } from ${JSON.stringify(join(repositoryRoot, 'src/main/plugins/officialPluginVersions.ts'))}`,
      `export { currentPluginHostTarget } from ${JSON.stringify(join(repositoryRoot, 'src/main/plugins/pluginTarget.ts'))}`,
    ].join('\n'))
    const output = await build({
      configFile: false,
      logLevel: 'error',
      root: repositoryRoot,
      plugins: [{
        name: 'electron-unavailable',
        enforce: 'pre',
        resolveId: (id) => (id === 'electron' ? '\0electron-unavailable' : undefined),
        load: (id) => (id === '\0electron-unavailable' ? { code: 'export default {}', syntheticNamedExports: true } : undefined),
      }],
      build: { ssr: entry, write: false, rollupOptions: { external: [/^node:/] } },
    })
    const file = join(directory, 'host.mjs')
    writeFileSync(file, (Array.isArray(output) ? output[0] : output).output[0].code)
    return await import(pathToFileURL(file).href)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

async function fetchOk(url, what) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${what}: HTTP ${response.status} from ${url}`)
  return response
}

/** The pinned version of a Registry-sourced plugin, downloaded (or read from
 *  the cache) and verified; throws when the Registry does not have it. */
async function verifiedRegistryArtifact(host, { id, target }) {
  const version = host.OFFICIAL_PLUGIN_VERSIONS[id]
  if (!version) throw new Error(`${id} has no pinned version in src/main/plugins/officialPluginVersions.ts`)
  const [namespace, name] = id.split('.')
  const base = `${registryUrl}/api/extensions/${namespace}/${name}`
  const cacheDirectory = join(cacheRoot, id, version, target)
  let detail
  let bytes
  try {
    detail = await (await fetchOk(base, `${id} listing`)).json()
    // Fails with the versions the Registry does have before anything downloads.
    host.selectOfficialVersion(detail, id, version, target, registryUrl)
    bytes = new Uint8Array(await (await fetchOk(`${base}/${version}/download`, `${id} ${version} download`)).arrayBuffer())
  } catch (error) {
    if (error instanceof host.OfficialArtifactMissingError) throw error
    if (!allowOfflineCache) {
      throw new Error(`${id} ${version}: the Registry is unreachable (${error.message}); set NAVIDE_OFFICIAL_PLUGIN_OFFLINE=1 to build from the verified copy in ${cacheDirectory}`)
    }
    if (!existsSync(join(cacheDirectory, 'package.vsix'))) {
      throw new Error(`${id} ${version}: the Registry is unreachable and ${cacheDirectory} holds no verified copy (${error.message})`)
    }
    console.warn(`${id} ${version}: the Registry is unreachable (${error.message}); using the copy in ${cacheDirectory}`)
    detail = JSON.parse(readFileSync(join(cacheDirectory, 'detail.json'), 'utf8'))
    bytes = new Uint8Array(readFileSync(join(cacheDirectory, 'package.vsix')))
  }
  const verified = host.verifyOfficialArtifact({
    id, version, target, registryUrl, detail, bytes,
    rootKeyPem: readFileSync(join(repositoryRoot, 'resources/official-registry-root.pem'), 'utf8'),
    hostTarget: host.currentPluginHostTarget(),
  })
  mkdirSync(cacheDirectory, { recursive: true })
  writeFileSync(join(cacheDirectory, 'detail.json'), `${JSON.stringify(detail)}\n`)
  writeFileSync(join(cacheDirectory, 'package.vsix'), bytes)
  return { version, bytes, detail, ...verified }
}

// `pnpm dev` and the artifact tests pass --allow-missing-registry: a pinned
// version not yet on the Registry (or no network and no cached copy) leaves
// that plugin out with a warning. The App build and release.sh never pass it.
const host = await loadHostModules()
const registryArtifacts = []
for (const source of registrySources) {
  const artifact = await verifiedRegistryArtifact(host, source).catch((error) => {
    if (allowMissingRegistry) {
      console.warn(`stage-official-plugin-artifacts: ${error.message} — ${source.id} is left out of this build`)
      return null
    }
    console.error(`stage-official-plugin-artifacts: ${error.message}`)
    process.exit(1)
  })
  if (!artifact) continue
  console.log(`${source.id} ${artifact.version} (${source.target}): verified against the official Registry, sha256 ${artifact.digest}`)
  registryArtifacts.push({ ...source, ...artifact })
}
// release.sh runs this before it builds anything: the pinned Registry
// versions must exist and verify.
if (process.argv.includes('--check-registry')) process.exit(0)

rmSync(outputRoot, { recursive: true, force: true })
for (const artifact of registryArtifacts) {
  const packageDirectory = join(factoryRoot, artifact.id, artifact.version, artifact.target, 'package')
  for (const file of artifact.files) {
    const to = join(packageDirectory, file.path)
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, file.data)
  }
  // validate reads the file list the build writes; the package carries none.
  const fileList = join(packageDirectory, 'artifact-files.json')
  const paths = artifact.files.map((file) => file.path).sort()
  writeFileSync(fileList, `${JSON.stringify({ files: ['manifest.json', ...paths.filter((path) => path !== 'manifest.json')] }, null, 2)}\n`)
  runCli(['validate', packageDirectory, '--target', artifact.target])
  rmSync(fileList, { force: true })
  // The Registry's own package and the evidence it was verified with.
  const archiveDirectory = join(archivesRoot, artifact.id, artifact.version, artifact.target)
  mkdirSync(archiveDirectory, { recursive: true })
  const archive = join(archiveDirectory, `${artifact.id}-${artifact.version}-${artifact.target}.vsix`)
  writeFileSync(archive, artifact.bytes)
  writeFileSync(`${archive}.registry.json`, `${JSON.stringify(artifact.detail, null, 2)}\n`)
}
const signingDirectory = mkdtempSync(join(tmpdir(), 'navide-official-artifact-signing-'))
const privateKey = join(signingDirectory, 'private.pem')
const publicKey = join(signingDirectory, 'public.pem')
const keyPair = generateKeyPairSync('ed25519')
writeFileSync(privateKey, keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
writeFileSync(publicKey, keyPair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 })

try {
for (const source of sources) {
  const directory = join(repositoryRoot, source.directory)
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
  if (manifest.id !== source.id || typeof manifest.version !== 'string') {
    throw new Error(`artifact source identity is invalid: ${directory}`)
  }
  // The App looks a bundled plugin up by the plugin's own version
  // (src/main/plugins/officialPluginVersions.ts), so an App build must not
  // carry a package stamped with any other version.
  const sourceManifest = JSON.parse(readFileSync(join(repositoryRoot, source.source, 'manifest.json'), 'utf8'))
  if (manifest.version !== sourceManifest.version) {
    throw new Error(
      `${source.id} was built as ${manifest.version}, but its source manifest is ${sourceManifest.version}; ` +
        'unset NAVIDE_PLUGIN_ARTIFACT_VERSION for an App build',
    )
  }
  const files = JSON.parse(readFileSync(join(directory, 'artifact-files.json'), 'utf8'))
  if (!Array.isArray(files.files) || files.files.some((file) => typeof file !== 'string')) {
    throw new Error(`artifact file list is invalid: ${directory}`)
  }
  runCli(['validate', directory, '--target', source.target])
  const versionRoot = join(factoryRoot, source.id, manifest.version, source.target)
  const packageDirectory = join(versionRoot, 'package')
  mkdirSync(packageDirectory, { recursive: true })
  for (const file of files.files) {
    const from = join(directory, file)
    if (!lstatSync(from).isFile()) throw new Error(`artifact file is not a regular file: ${from}`)
    const to = join(packageDirectory, file)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to, { preserveTimestamps: true })
  }
  writeFileSync(join(packageDirectory, 'artifact-files.json'), `${JSON.stringify(files, null, 2)}\n`)
  runCli(['validate', packageDirectory, '--target', source.target])
  const archiveDirectory = join(archivesRoot, source.id, manifest.version, source.target)
  mkdirSync(archiveDirectory, { recursive: true })
  const archive = join(archiveDirectory, `${source.id}-${manifest.version}-${source.target}.vsix`)
  runCli(['package', packageDirectory, '--target', source.target, '--out', archive])
  const signature = `${archive}.sig`
  runCli(['sign', archive, '--key', privateKey, '--out', signature])
  runCli(['verify', archive, '--key', publicKey, '--signature', signature])
  rmSync(join(packageDirectory, 'artifact-files.json'), { force: true })
}
} finally {
  rmSync(signingDirectory, { recursive: true, force: true })
}
