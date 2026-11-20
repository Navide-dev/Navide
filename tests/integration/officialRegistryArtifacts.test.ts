import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPluginDir } from '../../src/main/plugins/installedPlugins'
import { OFFICIAL_PLUGIN_VERSIONS } from '../../src/main/plugins/officialPluginVersions'

// The first-party copies the build staged from the official Registry
// (scripts/stage-official-plugin-artifacts.mjs) load through the same
// Manifest v2 directory loader as any installed package. The artifacts
// project runs after the build, so the staged copies must be there.
const staged = (id: string): string => join(
  'dist-plugins/official-artifacts/factory-resources', id, OFFICIAL_PLUGIN_VERSIONS[id], 'universal/package',
)

describe.each([
  ['navide.git', ['navide.git.left', 'navide.git.branch-detail', 'navide.git.window']],
  ['navide.mini-ide', ['navide.mini-ide.window']],
])('staged %s', (id, contributionKeys) => {
  it('loads the pinned Registry copy through the Manifest v2 loader', () => {
    const dir = staged(id)
    expect(existsSync(dir), `${dir} is missing: run the build (or the stage script) first`).toBe(true)
    const scanned = loadPluginDir(dir)
    expect(scanned.error).toBeUndefined()
    expect(scanned.descriptor?.id).toBe(id)
    expect(scanned.descriptor?.packageVersion).toBe(OFFICIAL_PLUGIN_VERSIONS[id])
    expect(scanned.descriptor?.views?.map((view) => view.contributionKey)).toEqual(contributionKeys)
  })
})
