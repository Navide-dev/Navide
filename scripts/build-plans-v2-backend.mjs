import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDirectory = resolve(repositoryRoot, 'plugins/navide-plans/backend')
// The backend imports the core path guard and write path (standard library
// only) from the core backend's source tree; these are every core module the
// bundle carries.
const sharedSourceRoot = resolve(repositoryRoot, 'backend')
const sharedSourceFiles = [
  resolve(sharedSourceRoot, 'agent_team_backend/__init__.py'),
  resolve(sharedSourceRoot, 'agent_team_backend/fs_write.py'),
  resolve(sharedSourceRoot, 'agent_team_backend/git_security.py'),
  resolve(sharedSourceRoot, 'agent_team_backend/path_guard.py'),
]
const source = join(sourceDirectory, 'plans_backend.py')
const backendDirectory = resolve(repositoryRoot, 'dist-plugins/navide-plans/backend')
const executableName = process.platform === 'win32' ? 'navide-plans.exe' : 'navide-plans'
const executable = join(backendDirectory, executableName)
const cacheFile = resolve(repositoryRoot, 'node_modules/.cache/navide/plans-v2-backend.json')
const artifactFileList = resolve(repositoryRoot, 'dist-plugins/navide-plans/artifact-files.json')

// `--if-needed` is how `pnpm dev` invokes this script, and only `pnpm dev`:
// every production path (build:plans:backend ← build:plans ←
// build:official-plugins ← build ← dist) and the CI gates invoke it bare. So
// the flag is the repository's existing signal for "this is a development
// start", and the opt-out below is honoured on that invocation alone.
const developmentInvocation = process.argv.includes('--if-needed')

// The escape hatch for a contributor without uv/PyInstaller who is working on
// something else entirely. Skipping leaves the packaged Plans backend absent,
// which the Host detects at startup and answers by running Plans through its
// legacy recovery view; every other surface starts normally.
if (process.env['NAVIDE_SKIP_PLANS_BACKEND_BUILD'] === '1') {
  if (!developmentInvocation) {
    // Honouring it here would ship a signed release whose
    // dist-plugins/navide-plans/backend is empty, putting every user into Plans
    // legacy recovery — a silent, undetectable-at-build-time failure. Refusing
    // loudly costs the maintainer one unset; the alternative costs a release.
    console.error(
      'NAVIDE_SKIP_PLANS_BACKEND_BUILD=1 is set, but this is a production or CI build ' +
        '(invoked without --if-needed). Refusing to skip: the release would ship no ' +
        'packaged Plans backend and every user would start Plans in legacy recovery. ' +
        'Unset the variable for this build; it applies to `pnpm dev` only.',
    )
    process.exit(1)
  }
  console.log(
    'Skipping the production Plans backend build (NAVIDE_SKIP_PLANS_BACKEND_BUILD=1); ' +
      'Plans will start in legacy recovery.',
  )
  process.exit(0)
}

/** Every Python module PyInstaller can pull into the bundle, not just the entry
 * point: a second module added beside it must invalidate the cached build. */
function backendSourceFiles() {
  return readdirSync(sourceDirectory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.py'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
}

/** An input that may legitimately be absent hashes as empty; creating it later
 * changes the digest, which is the outcome we want. */
function optionalFileBytes(path) {
  try {
    return readFileSync(path)
  } catch {
    return Buffer.alloc(0)
  }
}

const fingerprint = createHash('sha256')
  .update(`${process.platform}\0${process.arch}\0`)
for (const input of [
  ...backendSourceFiles(),
  ...sharedSourceFiles,
  fileURLToPath(import.meta.url),
  resolve(repositoryRoot, 'backend/pyproject.toml'),
  resolve(repositoryRoot, 'backend/uv.lock'),
]) {
  // The path is hashed alongside the bytes so a rename is a change too.
  fingerprint.update(relative(repositoryRoot, input)).update('\0')
  fingerprint.update(readFileSync(input)).update('\0')
}
// PyInstaller's own version is pinned by backend/uv.lock, but the interpreter
// uv resolves for the build is not, and a onefile bundle embeds it. The project
// venv marker records that interpreter (and the uv that created it).
fingerprint.update(optionalFileBytes(resolve(repositoryRoot, 'backend/.venv/pyvenv.cfg'))).update('\0')
const inputDigest = fingerprint.digest('hex')

function executableDigest() {
  const entry = lstatSync(executable)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size === 0 || (process.platform !== 'win32' && (entry.mode & 0o111) === 0)) {
    throw new Error(`Plans backend output is not a regular executable: ${executable}`)
  }
  const bytes = readFileSync(executable)
  if (bytes[0] === 0x23 && bytes[1] === 0x21) {
    throw new Error(`Plans backend output is a script, not a packaged executable: ${executable}`)
  }
  return createHash('sha256').update(bytes).digest('hex')
}

function recordBackendArtifactFile() {
  const listed = JSON.parse(readFileSync(artifactFileList, 'utf8'))
  if (!Array.isArray(listed.files) || listed.files.some((file) => typeof file !== 'string')) {
    throw new Error(`Plans artifact file list is invalid: ${artifactFileList}`)
  }
  const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, 'dist-plugins/navide-plans/manifest.json'), 'utf8'))
  const backendEntry = 'backend/navide-plans'
  if (manifest.backend?.entry !== backendEntry) {
    throw new Error(`Plans manifest must declare its backend entry: ${backendEntry}`)
  }
  const backendFile = `backend/${executableName}`
  const files = [...new Set([...listed.files, backendFile])].sort()
  writeFileSync(artifactFileList, `${JSON.stringify({ files }, null, 2)}\n`)
}

if (developmentInvocation) {
  try {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8'))
    if (cached.inputDigest === inputDigest && cached.outputDigest === executableDigest()) {
      recordBackendArtifactFile()
      console.log(`Reusing unchanged production Plans backend: ${executable}`)
      process.exit(0)
    }
  } catch {
    // Missing, invalid, or changed build output must be rebuilt before use.
  }
}
// A failed build must never leave a successful cache marker behind.
rmSync(cacheFile, { force: true })
const temporaryRoot = mkdtempSync(join(tmpdir(), 'navide-plans-v2-backend-'))

try {
  mkdirSync(backendDirectory, { recursive: true })
  try {
    execFileSync(
      'uv',
      [
        '--project',
        resolve(repositoryRoot, 'backend'),
        'run',
        'pyinstaller',
        '--noconfirm',
        '--clean',
        '--onefile',
        '--name',
        'navide-plans',
        '--paths',
        sharedSourceRoot,
        '--distpath',
        backendDirectory,
        '--workpath',
        join(temporaryRoot, 'work'),
        '--specpath',
        join(temporaryRoot, 'spec'),
        source,
      ],
      {
        cwd: repositoryRoot,
        stdio: 'inherit',
        env: {
          ...process.env,
          PYINSTALLER_CONFIG_DIR: join(temporaryRoot, 'config'),
        },
      },
    )
  } catch (error) {
    throw new Error(
      `Packaging the Plans backend failed: ${error instanceof Error ? error.message : String(error)}\n` +
        'Install uv (https://docs.astral.sh/uv/) and run `uv --project backend sync`, or set ' +
        'NAVIDE_SKIP_PLANS_BACKEND_BUILD=1 to start the app without the packaged Plans backend.',
    )
  }

  const entry = lstatSync(executable)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size === 0) {
    throw new Error(`PyInstaller did not produce a regular Plans backend executable: ${executable}`)
  }
  if (process.platform !== 'win32') chmodSync(executable, entry.mode | 0o111)
  const outputDigest = executableDigest()
  recordBackendArtifactFile()
  mkdirSync(dirname(cacheFile), { recursive: true })
  writeFileSync(cacheFile, `${JSON.stringify({ inputDigest, outputDigest })}\n`)
  console.log(`Built production Plans backend: ${executable}`)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
