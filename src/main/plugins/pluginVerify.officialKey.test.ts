// Card K4 (D6): a packaged build never takes the official publisher key from
// AGENT_TEAM_OFFICIAL_PLUGIN_KEY. Its own file: the gate is module state.
import { describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { disableOfficialKeyOverride, OFFICIAL_PUBLISHER_KEY_PEM, resolveOfficialPublisherKey } from './pluginVerify'

const overridePem = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()

describe('AGENT_TEAM_OFFICIAL_PLUGIN_KEY', () => {
  it('is honored until the Host turns the override off, then the pinned key is used', () => {
    expect(resolveOfficialPublisherKey({ AGENT_TEAM_OFFICIAL_PLUGIN_KEY: overridePem })).toBe(overridePem.trim())
    disableOfficialKeyOverride()
    expect(resolveOfficialPublisherKey({ AGENT_TEAM_OFFICIAL_PLUGIN_KEY: overridePem })).toBe(OFFICIAL_PUBLISHER_KEY_PEM)
  })

  it('is turned off by a packaged build before any installed plugin is loaded, Developer Mode or not', () => {
    const main = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')
    const gate = main.indexOf('if (app.isPackaged) disableOfficialKeyOverride()')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(main.indexOf('const installedPluginLoad = frontendPluginManager.loadInstalledPlugins('))
  })
})
