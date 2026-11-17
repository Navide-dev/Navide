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
// had their own versions: Git, Mini-IDE and Plans shipped stamped with the App
// version 0.2.34, and Browser, not yet bundled, is recorded at its 0.1.0
// manifest version from that tag.
//
// The fingerprint hashes git blob ids (line-ending normalized, the same on
// every platform) of the tracked sources a plugin's package is built from:
// the plugin directory and only the workspace packages its bundle really
// contains, without tests, fixtures or Markdown. The check reads the git
// index, so stage edits first. The Host's own UI strings live in
// src/renderer/src/i18n, outside every input, so changing one leaves every
// plugin's fingerprint as it was:
//   node scripts/official-plugin-fingerprints.mjs --probe <path>
// reports which fingerprints a change to <path> would move.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RECORD_PATH = 'plugins/official-plugin-fingerprints.json'

// The workspace packages a bundle can contain: their sources and build
// configuration, not the plugin-sdk command-line tools (bin/), which no
// plugin bundles.
export const WORKSPACE_PACKAGES = {
  '@navide/plugin-contracts': { directory: 'packages/plugin-contracts', omit: [] },
  '@navide/plugin-sdk': { directory: 'packages/plugin-sdk', omit: ['packages/plugin-sdk/bin/'] },
  '@navide/plugin-ui': { directory: 'packages/plugin-ui', omit: [] },
}

// `packages` is what each bundle really contains: the packages its sources
// import, and the packages those import in turn (plugin-ui imports
// plugin-sdk, plugin-sdk imports plugin-contracts at runtime).
// tests/infrastructure/officialPluginFingerprints.test.ts derives the same
// closure from the import statements and fails when this table falls behind.
export const OFFICIAL_PLUGIN_SOURCES = {
  'navide.browser': {
    directory: 'plugins/navide-browser',
    packages: ['@navide/plugin-contracts', '@navide/plugin-sdk', '@navide/plugin-ui'],
    extra: [],
  },
  'navide.git': {
    directory: 'plugins/navide-git',
    packages: ['@navide/plugin-contracts', '@navide/plugin-sdk', '@navide/plugin-ui'],
    extra: [],
  },
  'navide.mini-ide': {
    directory: 'plugins/navide-mini-ide',
    packages: ['@navide/plugin-contracts', '@navide/plugin-sdk', '@navide/plugin-ui'],
    extra: [],
  },
  // The Python plugin SDK scripts/build-plans-v2-backend.mjs bundles into the
  // backend; it imports nothing of agent_team_backend.
  'navide.plans': {
    directory: 'plugins/navide-plans',
    packages: ['@navide/plugin-contracts', '@navide/plugin-sdk', '@navide/plugin-ui'],
    extra: [
      'backend/navide_plugin_sdk/__init__.py',
      'backend/navide_plugin_sdk/fs_write.py',
      'backend/navide_plugin_sdk/git_security.py',
      'backend/navide_plugin_sdk/path_guard.py',
      'backend/navide_plugin_sdk/plan_versions.py',
    ],
  },
}

/** Every tracked path a plugin's fingerprint reads, before exclusions. */
function inputs(pluginId) {
  const source = OFFICIAL_PLUGIN_SOURCES[pluginId]
  if (!source) throw new Error(`'${pluginId}' is not an App-bundled plugin`)
  const packages = source.packages.map((name) => WORKSPACE_PACKAGES[name])
  return {
    paths: [source.directory, ...packages.map(({ directory }) => directory), ...source.extra],
    omit: packages.flatMap(({ omit }) => omit),
  }
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
  const { paths, omit } = inputs(pluginId)
  const entries = trackedBlobs(root, paths, ref)
    .filter(({ path }) => !excluded(path) && !omit.some((prefix) => path.startsWith(prefix)))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const extra of source.extra) {
    if (!entries.some(({ path }) => path === extra)) throw new Error(`${pluginId} input is not tracked: ${extra}`)
  }
  const hash = createHash('sha256')
  for (const { path, blob } of entries) hash.update(`${path}\0${blob}\n`)
  return hash.digest('hex')
}

/**
 * The plugins whose fingerprint a change to the tracked file `path` would
 * move. Works on a scratch copy of the git index, so neither the working tree
 * nor the real index changes.
 */
export function probe(root, path) {
  const before = Object.fromEntries(Object.keys(OFFICIAL_PLUGIN_SOURCES).map((id) => [id, fingerprint(root, id)]))
  const scratch = mkdtempSync(join(tmpdir(), 'navide-fingerprint-probe-'))
  const index = join(scratch, 'index')
  const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, encoding: 'utf8' }).trim()
  copyFileSync(isAbsolute(gitDir) ? join(gitDir, 'index') : join(root, gitDir, 'index'), index)
  const previous = process.env.GIT_INDEX_FILE
  try {
    const [entry] = trackedBlobs(root, [path]).filter((tracked) => tracked.path === path)
    if (!entry) throw new Error(`${path} is not tracked`)
    const mode = execFileSync('git', ['ls-files', '-s', '--', path], { cwd: root, encoding: 'utf8' }).split(' ')[0]
    // Any other blob id stands for "this file changed"; --info-only needs no object.
    const changed = createHash('sha1').update(`probe:${entry.blob}`).digest('hex')
    process.env.GIT_INDEX_FILE = index
    execFileSync('git', ['update-index', '--info-only', '--cacheinfo', `${mode},${changed},${path}`], { cwd: root })
    return Object.keys(before).filter((id) => fingerprint(root, id) !== before[id])
  } finally {
    if (previous === undefined) delete process.env.GIT_INDEX_FILE
    else process.env.GIT_INDEX_FILE = previous
    rmSync(scratch, { recursive: true, force: true })
  }
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
  if (args.includes('--probe')) {
    const path = args[args.indexOf('--probe') + 1]
    if (!path) {
      console.error('--probe needs <tracked path>')
      process.exit(2)
    }
    const moved = probe(root, path)
    console.log(moved.length ? `changing ${path} moves: ${moved.join(', ')}` : `changing ${path} moves no plugin fingerprint`)
    return
  }
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
