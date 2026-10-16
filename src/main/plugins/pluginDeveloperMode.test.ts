import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pluginDeveloperModeEnabled } from './pluginDeveloperMode'

describe('pluginDeveloperModeEnabled', () => {
  it('is on in a development build when AGENT_TEAM_PLUGIN_DEV=1', () => {
    expect(pluginDeveloperModeEnabled({ AGENT_TEAM_PLUGIN_DEV: '1' }, false)).toBe(true)
  })

  it('is off in a packaged build even when AGENT_TEAM_PLUGIN_DEV=1', () => {
    expect(
      pluginDeveloperModeEnabled(
        { AGENT_TEAM_PLUGIN_DEV: '1', AGENT_TEAM_PLUGIN_DEV_PATH: '/tmp/unsigned-plugin' },
        true,
      ),
    ).toBe(false)
  })

  it('is off without the opt-in variable', () => {
    expect(pluginDeveloperModeEnabled({}, false)).toBe(false)
    expect(pluginDeveloperModeEnabled({ AGENT_TEAM_PLUGIN_DEV: 'true' }, false)).toBe(false)
  })
})

describe('main process Developer Mode gate', () => {
  const mainSource = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')

  it('derives the plugin dev entry from the packaged-aware gate', () => {
    expect(mainSource).toContain(
      'const pluginDevEnabled = pluginDeveloperModeEnabled(process.env, app.isPackaged)',
    )
  })

  it('reads AGENT_TEAM_PLUGIN_DEV_PATH only inside the gated block', () => {
    const gate = mainSource.indexOf('if (pluginDevEnabled) {')
    const explicitPath = mainSource.indexOf("process.env['AGENT_TEAM_PLUGIN_DEV_PATH']")
    expect(gate).toBeGreaterThan(-1)
    expect(explicitPath).toBeGreaterThan(gate)
    expect(mainSource.split("process.env['AGENT_TEAM_PLUGIN_DEV_PATH']")).toHaveLength(2)
  })
})
