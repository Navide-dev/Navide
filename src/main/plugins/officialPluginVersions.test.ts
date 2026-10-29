import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isEngineCompatible } from './pluginEngineCompat'
import { OFFICIAL_PLUGIN_VERSIONS, officialPluginVersion } from './officialPluginVersions'

const sourceDirs: Record<string, string> = {
  'navide.browser': 'plugins/navide-browser',
  'navide.git': 'plugins/navide-git',
  'navide.mini-ide': 'plugins/navide-mini-ide',
  'navide.plans': 'plugins/navide-plans',
}

const readJson = (path: string) => JSON.parse(readFileSync(join(process.cwd(), path), 'utf8'))
const appVersion = readJson('package.json').version as string

describe('OFFICIAL_PLUGIN_VERSIONS', () => {
  it('lists exactly the bundled first-party plugins', () => {
    expect(Object.keys(OFFICIAL_PLUGIN_VERSIONS).sort()).toEqual(Object.keys(sourceDirs).sort())
  })

  it.each(Object.entries(sourceDirs))('%s equals its source manifest and package.json', (id, dir) => {
    const manifest = readJson(`${dir}/manifest.json`)
    expect(manifest.id).toBe(id)
    expect(manifest.version).toBe(OFFICIAL_PLUGIN_VERSIONS[id])
    expect(readJson(`${dir}/package.json`).version).toBe(OFFICIAL_PLUGIN_VERSIONS[id])
  })

  it.each(Object.entries(sourceDirs))('%s is not stamped with the App version', (id) => {
    // Every Registry release so far was 0.2.x and stamped with the App
    // version; a decoupled version must sort above all of them, or the update
    // check and the bundled-vs-installed comparison would never pick it.
    expect(OFFICIAL_PLUGIN_VERSIONS[id]).toMatch(/^[1-9]\d*\.\d+\.\d+$/)
  })

  it.each(Object.entries(sourceDirs))('%s declares an engines floor this App satisfies', (_id, dir) => {
    const manifest = readJson(`${dir}/manifest.json`)
    expect(isEngineCompatible(manifest.engines?.navide, appVersion)).toBe(true)
  })

  it('refuses an id the App does not bundle', () => {
    expect(() => officialPluginVersion('navide.unknown')).toThrow(/not an App-bundled plugin/)
  })
})
