import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sdkCli = join(repositoryRoot, 'packages/plugin-sdk/bin/navide-plugin.mjs')
const outputRoot = join(repositoryRoot, 'dist-plugins/official-artifacts')
const factoryRoot = join(outputRoot, 'factory-resources')
const archivesRoot = join(outputRoot, 'archives')
const hostTarget = `${process.platform}-${process.arch}`

const sources = [
  { id: 'navide.mini-ide', directory: 'dist-plugins/navide-mini-ide', target: 'universal' },
  { id: 'navide.git', directory: 'dist-plugins/navide-git', target: 'universal' },
  { id: 'navide.plans', directory: 'dist-plugins/navide-plans', target: hostTarget },
]

function runCli(args) {
  execFileSync(process.execPath, [sdkCli, ...args], { cwd: repositoryRoot, stdio: 'inherit' })
}

rmSync(outputRoot, { recursive: true, force: true })
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
