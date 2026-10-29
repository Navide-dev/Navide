// Content fingerprints of the App-bundled first-party plugins, recorded with
// the version they were taken at in plugins/official-plugin-fingerprints.json.
// A first-party plugin versions independently of the App, and a Marketplace
// copy of the same version wins a tie with the bundled one, so content that
// changes without a version bump would leave those users on the old content.
// tests/infrastructure/officialPluginFingerprints.test.ts fails when a
// fingerprint changes while the version stays; after bumping the version run
//   node scripts/official-plugin-fingerprints.mjs --write
// to record the new pair. --write refuses changed content at the old version.
//
// The fingerprint hashes git index blob ids (line-ending normalized, the same
// on every platform) of the tracked sources a plugin's package is built from:
// the plugin directory and the workspace packages it bundles, without tests,
// fixtures or Markdown. Stage edits (git add) before checking them.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RECORD_PATH = 'plugins/official-plugin-fingerprints.json'

// The workspace packages every first-party plugin bundles or is packed with.
const SHARED_SOURCES = ['packages/plugin-contracts', 'packages/plugin-sdk', 'packages/plugin-ui']

export const OFFICIAL_PLUGIN_SOURCES = {
  'navide.git': { directory: 'plugins/navide-git', extra: [] },
  'navide.mini-ide': { directory: 'plugins/navide-mini-ide', extra: [] },
  // The core modules scripts/build-plans-v2-backend.mjs bundles into the
  // backend. agent_team_backend/__init__.py is left out: it holds only the App
  // version, which the Plans backend never reads.
  'navide.plans': {
    directory: 'plugins/navide-plans',
    extra: [
      'backend/agent_team_backend/fs_write.py',
      'backend/agent_team_backend/git_security.py',
      'backend/agent_team_backend/path_guard.py',
    ],
  },
}

function excluded(path) {
  return /(^|\/)(tests?|__tests__|test-fixtures)\//.test(path) ||
    /\.test\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)vitest\.config\.[cm]?[jt]s$/.test(path) ||
    path.endsWith('.md')
}

/** sha256 over `path\0blob\n` of every included tracked file, sorted by path. */
export function fingerprint(root, pluginId) {
  const source = OFFICIAL_PLUGIN_SOURCES[pluginId]
  if (!source) throw new Error(`'${pluginId}' is not an App-bundled plugin`)
  const listing = execFileSync(
    'git',
    ['ls-files', '-s', '-z', '--', source.directory, ...SHARED_SOURCES, ...source.extra],
    { cwd: root, encoding: 'utf8' },
  )
  const entries = listing.split('\0').filter(Boolean).map((line) => {
    const [meta, path] = line.split('\t')
    return { path, blob: meta.split(' ')[1] }
  }).filter(({ path }) => !excluded(path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const extra of source.extra) {
    if (!entries.some(({ path }) => path === extra)) throw new Error(`${pluginId} input is not tracked: ${extra}`)
  }
  const hash = createHash('sha256')
  for (const { path, blob } of entries) hash.update(`${path}\0${blob}\n`)
  return hash.digest('hex')
}

export function manifestVersion(root, pluginId) {
  const source = OFFICIAL_PLUGIN_SOURCES[pluginId]
  return JSON.parse(readFileSync(join(root, source.directory, 'manifest.json'), 'utf8')).version
}

export function readRecord(root) {
  const path = join(root, RECORD_PATH)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
}

function semverParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  return match ? match.slice(1).map(Number) : null
}

function isNewer(version, than) {
  const a = semverParts(version)
  const b = semverParts(than)
  if (!a || !b) return false
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

/** One problem string per plugin whose record no longer matches. */
export function checkRecord(root, record = readRecord(root)) {
  const problems = []
  for (const pluginId of Object.keys(OFFICIAL_PLUGIN_SOURCES)) {
    const recorded = record[pluginId]
    const version = manifestVersion(root, pluginId)
    const current = fingerprint(root, pluginId)
    if (!recorded) {
      problems.push(`${pluginId}: no recorded fingerprint; run node scripts/official-plugin-fingerprints.mjs --write`)
    } else if (recorded.version === version && recorded.fingerprint !== current) {
      problems.push(
        `${pluginId}: content changed but the version is still ${version}; bump the version in ` +
          `${OFFICIAL_PLUGIN_SOURCES[pluginId].directory}/manifest.json, its package.json and ` +
          'src/main/plugins/officialPluginVersions.ts, then run node scripts/official-plugin-fingerprints.mjs --write',
      )
    } else if (recorded.version !== version || recorded.fingerprint !== current) {
      problems.push(
        `${pluginId}: version ${version} is not recorded (recorded ${recorded.version}); ` +
          'run node scripts/official-plugin-fingerprints.mjs --write',
      )
    }
  }
  for (const pluginId of Object.keys(record)) {
    if (!OFFICIAL_PLUGIN_SOURCES[pluginId]) problems.push(`${pluginId}: recorded but not an App-bundled plugin`)
  }
  return problems
}

/** The record to write, or problems when a bump is missing or goes backwards. */
export function nextRecord(root, record = readRecord(root)) {
  const next = {}
  const problems = []
  for (const pluginId of Object.keys(OFFICIAL_PLUGIN_SOURCES)) {
    const recorded = record[pluginId]
    const version = manifestVersion(root, pluginId)
    const current = fingerprint(root, pluginId)
    if (recorded && recorded.fingerprint !== current && recorded.version === version) {
      problems.push(`${pluginId}: content changed but the version is still ${version}; bump it first`)
    } else if (recorded && recorded.version !== version && !isNewer(version, recorded.version)) {
      problems.push(`${pluginId}: ${version} is not newer than the recorded ${recorded.version}`)
    }
    next[pluginId] = { version, fingerprint: current }
  }
  return { record: next, problems }
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  if (process.argv.includes('--write')) {
    const { record, problems } = nextRecord(root)
    if (problems.length) {
      for (const problem of problems) console.error(problem)
      process.exit(1)
    }
    writeFileSync(join(root, RECORD_PATH), `${JSON.stringify(record, null, 2)}\n`)
    console.log(`wrote ${RECORD_PATH}`)
    return
  }
  const problems = checkRecord(root)
  for (const problem of problems) console.error(problem)
  process.exit(problems.length ? 1 : 0)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
