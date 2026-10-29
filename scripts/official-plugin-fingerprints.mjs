// Release baseline of the App-bundled first-party plugins:
// plugins/official-plugin-fingerprints.json records, per plugin, the version
// and a content fingerprint as of the last App release (`baseline`, its tag).
// A first-party plugin versions independently of the App, and a Marketplace
// copy of the same version wins a tie with the bundled one, so content that
// differs from the released content must ship under a newer version.
//
// Rule (tests/infrastructure/officialPluginFingerprints.test.ts):
//   - content differs from the baseline -> the manifest version must be
//     greater than the baseline version. One bump per release cycle is
//     enough: later changes in the same cycle need no further bump.
//   - a version lower than the baseline is always refused.
// release.sh rewrites the file for the tag it creates:
//   node scripts/official-plugin-fingerprints.mjs --write --baseline vX.Y.Z
// and nothing else should. The first baseline is v0.2.34, before the plugins
// had their own versions: they shipped stamped with the App version 0.2.34.
//
// The fingerprint hashes git blob ids (line-ending normalized, the same on
// every platform) of the tracked sources a plugin's package is built from:
// the plugin directory and the workspace packages it bundles, without tests,
// fixtures or Markdown. The check reads the git index, so stage edits first.
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

/** Tracked files with blob ids: the git index, or the tree of `ref`. */
function trackedBlobs(root, paths, ref) {
  const args = ref
    ? ['ls-tree', '-r', '-z', ref, '--', ...paths]
    : ['ls-files', '-s', '-z', '--', ...paths]
  const listing = execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  return listing.split('\0').filter(Boolean).map((line) => {
    const [meta, path] = line.split('\t')
    // ls-tree: "<mode> <type> <blob>"; ls-files -s: "<mode> <blob> <stage>".
    const fields = meta.split(' ')
    return { path, blob: ref ? fields[2] : fields[1] }
  })
}

/** sha256 over `path\0blob\n` of every included tracked file, sorted by path. */
export function fingerprint(root, pluginId, ref) {
  const source = OFFICIAL_PLUGIN_SOURCES[pluginId]
  if (!source) throw new Error(`'${pluginId}' is not an App-bundled plugin`)
  const entries = trackedBlobs(root, [source.directory, ...SHARED_SOURCES, ...source.extra], ref)
    .filter(({ path }) => !excluded(path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
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
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { baseline: null, plugins: {} }
}

function semverParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  return match ? match.slice(1).map(Number) : null
}

/** -1, 0 or 1; null when either is not plain MAJOR.MINOR.PATCH. */
function compareVersions(a, b) {
  const left = semverParts(a)
  const right = semverParts(b)
  if (!left || !right) return null
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  return 0
}

/** One problem string per plugin that breaks the rule against the baseline. */
export function checkRecord(root, record = readRecord(root)) {
  const problems = []
  const baseline = record.baseline ?? 'the recorded baseline'
  for (const pluginId of Object.keys(OFFICIAL_PLUGIN_SOURCES)) {
    const recorded = record.plugins?.[pluginId]
    const version = manifestVersion(root, pluginId)
    if (!recorded) {
      problems.push(`${pluginId}: no baseline in ${RECORD_PATH}; release.sh records one`)
      continue
    }
    const order = compareVersions(version, recorded.version)
    if (order === null) {
      problems.push(`${pluginId}: ${version} or the baseline ${recorded.version} is not MAJOR.MINOR.PATCH`)
    } else if (order < 0) {
      problems.push(`${pluginId}: ${version} is lower than ${recorded.version} released in ${baseline}`)
    } else if (order === 0 && fingerprint(root, pluginId) !== recorded.fingerprint) {
      problems.push(
        `${pluginId}: content changed since ${baseline} but the version is still ${version}; bump it in ` +
          `${OFFICIAL_PLUGIN_SOURCES[pluginId].directory}/manifest.json, its package.json and ` +
          'src/main/plugins/officialPluginVersions.ts (once per release cycle is enough)',
      )
    }
  }
  for (const pluginId of Object.keys(record.plugins ?? {})) {
    if (!OFFICIAL_PLUGIN_SOURCES[pluginId]) problems.push(`${pluginId}: recorded but not an App-bundled plugin`)
  }
  return problems
}

/** The new baseline for a release, or the problems that block it. */
export function nextRecord(root, baseline, record = readRecord(root)) {
  const problems = checkRecord(root, record)
  const plugins = {}
  for (const pluginId of Object.keys(OFFICIAL_PLUGIN_SOURCES)) {
    plugins[pluginId] = { version: manifestVersion(root, pluginId), fingerprint: fingerprint(root, pluginId) }
  }
  return { record: { baseline, plugins }, problems }
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const args = process.argv.slice(2)
  if (args.includes('--write')) {
    const baseline = args[args.indexOf('--baseline') + 1]
    if (!args.includes('--baseline') || !baseline) {
      console.error('--write needs --baseline <release tag>')
      process.exit(2)
    }
    const { record, problems } = nextRecord(root, baseline)
    if (problems.length) {
      for (const problem of problems) console.error(problem)
      process.exit(1)
    }
    writeFileSync(join(root, RECORD_PATH), `${JSON.stringify(record, null, 2)}\n`)
    console.log(`recorded ${baseline} in ${RECORD_PATH}`)
    return
  }
  const problems = checkRecord(root)
  for (const problem of problems) console.error(problem)
  process.exit(problems.length ? 1 : 0)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
