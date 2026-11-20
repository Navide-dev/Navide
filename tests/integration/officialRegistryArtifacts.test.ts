import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPluginDir } from '../../src/main/plugins/installedPlugins'
import { OFFICIAL_PLUGIN_VERSIONS } from '../../src/main/plugins/officialPluginVersions'

// The first-party copies the build staged from the official Registry
// (scripts/stage-official-plugin-artifacts.mjs) load through the same
// Manifest v2 directory loader as any installed package.
//
// Only a build stages them. scripts/run-artifact-tests.mjs (CI's
// test:artifacts:ci after `bun run build`, and the release gate's
// test:packaged-plans, which stages first) sets NAVIDE_TEST_STAGED_PLUGINS=1,
// and then a missing copy fails. A plain `pnpm test:run` builds nothing, so
// without a staged tree these skip.
const hostTarget = `${process.platform}-${process.arch}`
const stagedRoot = 'dist-plugins/official-artifacts/factory-resources'
const staged = (id: string, target: string): string => join(
  stagedRoot, id, OFFICIAL_PLUGIN_VERSIONS[id], target, 'package',
)
const notStaged = process.env.NAVIDE_TEST_STAGED_PLUGINS !== '1' && !existsSync(stagedRoot)

describe.skipIf(notStaged)('official plugins staged by the build (skipped: nothing staged, run the build)', () => {
describe.each([
  ['navide.git', 'universal', ['navide.git.left', 'navide.git.branch-detail', 'navide.git.window']],
  ['navide.mini-ide', 'universal', ['navide.mini-ide.window']],
  ['navide.browser', hostTarget, ['navide.browser.left', 'navide.browser.window']],
  ['navide.plans', hostTarget, ['navide.plans.left', 'navide.plans.window']],
])('staged %s', (id, target, contributionKeys) => {
  it('loads the pinned Registry copy through the Manifest v2 loader', () => {
    const dir = staged(id, target)
    expect(existsSync(dir), `${dir} is missing: run the build (or the stage script) first`).toBe(true)
    const scanned = loadPluginDir(dir)
    expect(scanned.error).toBeUndefined()
    expect(scanned.descriptor?.id).toBe(id)
    expect(scanned.descriptor?.packageVersion).toBe(OFFICIAL_PLUGIN_VERSIONS[id])
    expect(scanned.descriptor?.views?.map((view) => view.contributionKey)).toEqual(contributionKeys)
  })
})

it.each([
  ['navide.browser', 'navide-browser'],
  ['navide.plans', 'navide-plans'],
])('stages %s with its packaged backend for this host', (id, executable) => {
  const backend = join(staged(id, hostTarget), 'backend', process.platform === 'win32' ? `${executable}.exe` : executable)
  expect(existsSync(backend), backend).toBe(true)
  expect(statSync(backend).size).toBeGreaterThan(0)
  if (process.platform !== 'win32') expect(statSync(backend).mode & 0o111).not.toBe(0)
})
})
