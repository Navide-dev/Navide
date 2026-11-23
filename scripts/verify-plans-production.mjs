import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// navide.plans is built in its own repository; the build stages the pinned
// version, as the official Registry signed it, for this host's target.
const pinned = /'navide\.plans': '([^']+)'/.exec(
  readFileSync(join(repositoryRoot, 'src/main/plugins/officialPluginVersions.ts'), 'utf8'),
)
if (!pinned) throw new Error('src/main/plugins/officialPluginVersions.ts pins no navide.plans version.')
const packageDirectory = join(
  repositoryRoot,
  'dist-plugins/official-artifacts/factory-resources/navide.plans',
  pinned[1],
  `${process.platform}-${process.arch}`,
  'package',
)
const backendDirectory = join(packageDirectory, 'backend')
const fixtureDirectory = join(repositoryRoot, 'dist-test-fixtures/plans/backend')
const suffix = process.platform === 'win32' ? '.exe' : ''
const executableName = `navide-plans${suffix}`

function regularFile(path) {
  const entry = lstatSync(path)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size === 0) {
    throw new Error(`Expected a nonempty regular build artifact: ${path}`)
  }
  return readFileSync(path)
}

regularFile(join(repositoryRoot, 'dist-plugins/plans/index.html'))
regularFile(join(packageDirectory, 'frontend/left/index.html'))
regularFile(join(packageDirectory, 'frontend/window/index.html'))
const manifest = JSON.parse(regularFile(join(packageDirectory, 'manifest.json')).toString('utf8'))
// The manifest entry is target-agnostic; on Windows the Host runs `<entry>.exe`
// (backendEntryOnDisk), which is the file the backend check below requires.
if (manifest.backend?.entry !== 'backend/navide-plans') {
  throw new Error('Production Plans manifest must select its packaged backend.')
}
const entries = readdirSync(backendDirectory)
if (entries.length !== 1 || entries[0] !== executableName) {
  throw new Error('Production Plans backend contains unexpected artifacts, including possible test fixtures.')
}
const executable = regularFile(join(backendDirectory, executableName))
if (executable[0] === 0x23 && executable[1] === 0x21) {
  throw new Error('Production Plans backend must be a packaged executable, not a script.')
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const productionDigest = digest(executable)
// The fixtures exist only in a job that built them. Their absence is not
// evidence of a swap — the single-entry assertion above already rejects any
// stray artifact in the backend directory — so a job that verifies a shipped
// build without building fixtures must not go red on a missing comparison.
const compared = []
for (const fixture of [`navide-plans${suffix}`, `navide-plans-go${suffix}`]) {
  const fixturePath = join(fixtureDirectory, fixture)
  if (!existsSync(fixturePath)) continue
  if (digest(regularFile(fixturePath)) === productionDigest) {
    throw new Error(`Production Plans backend was replaced by the test-only fixture: ${fixture}`)
  }
  compared.push(fixture)
}
console.log(
  compared.length > 0
    ? `Production Plans backend is present and excludes packaged test fixtures (${compared.join(', ')}).`
    : 'Production Plans backend is present; no test fixtures were built to compare against.',
)
