import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPluginDir } from '../../src/main/plugins/installedPlugins'
import { OFFICIAL_PLUGIN_VERSIONS } from '../../src/main/plugins/officialPluginVersions'

// The navide.git copy the build staged from the official Registry
// (scripts/stage-official-plugin-artifacts.mjs) loads through the same
// Manifest v2 directory loader as any installed package. The artifacts
// project runs after the build, so the staged copy must be there.
const staged = join(
  'dist-plugins/official-artifacts/factory-resources/navide.git',
  OFFICIAL_PLUGIN_VERSIONS['navide.git'],
  'universal/package',
)

describe('staged navide.git', () => {
  it('loads the pinned Registry copy through the Manifest v2 loader', () => {
    expect(existsSync(staged), `${staged} is missing: run the build (or the stage script) first`).toBe(true)
    const scanned = loadPluginDir(staged)
    expect(scanned.error).toBeUndefined()
    expect(scanned.descriptor?.id).toBe('navide.git')
    expect(scanned.descriptor?.packageVersion).toBe(OFFICIAL_PLUGIN_VERSIONS['navide.git'])
    expect(scanned.descriptor?.views?.map((view) => view.contributionKey)).toEqual([
      'navide.git.left',
      'navide.git.branch-detail',
      'navide.git.window',
    ])
  })
})
