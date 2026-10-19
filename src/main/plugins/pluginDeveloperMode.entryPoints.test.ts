// Card K4: the Developer Mode switch is changed only by the user on the main
// window's settings page. These source checks pin the entry points that must
// never reach it, and the D6 wiring a packaged build depends on.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')
const SWITCH = /setDeveloperMode|plugins:setDeveloperMode|loadFromFolder|commitFolderLoad|developerMode\.on/

describe('Developer Mode entry points', () => {
  it('is not reachable by an agent, a chat channel or a plugin frame', () => {
    for (const path of [
      'backend/agent_team_backend/mcp_server/server.py',
      'src/renderer/src/lib/pluginAgentRequestApply.ts',
      'src/renderer/src/composables/usePluginAgentRequests.ts',
      'src/preload/plugin-preload.ts',
    ]) {
      expect(read(path), path).not.toMatch(SWITCH)
    }
  })

  it('writes the Host audit row only from the switch handler', () => {
    const ipc = read('src/main/plugins/pluginIpc.ts')
    expect(ipc.match(/recordDeveloperModeChange\(/g)).toHaveLength(1)
    const handler = ipc.slice(ipc.indexOf("ipcMain.handle('plugins:setDeveloperMode'"))
    expect(handler.slice(0, handler.indexOf('\n  })\n'))).toContain('manager.recordDeveloperModeChange(enabled, hostAppVersion())')
  })

  it('gates the self-hosted Registry overrides before any installed plugin is verified', () => {
    const main = read('src/main/index.ts')
    const gate = main.indexOf('setMarketplaceOverridesAllowed(() => !app.isPackaged || pluginDeveloperModeStore.isEnabled())')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(main.indexOf('const configuredMarketplace = resolveConfiguredMarketplace()'))
    const ipc = read('src/main/plugins/pluginIpc.ts')
    // Every read of the two overrides goes through the gate.
    expect(ipc.match(/process\.env\['AGENT_TEAM_MARKETPLACE_URL'\]/g)).toBeNull()
    expect(ipc.match(/process\.env\['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE'\]/g)).toBeNull()
  })

  it('keeps AGENT_TEAM_PLUGIN_DEV_PATH on the environment-only development gate', () => {
    const main = read('src/main/index.ts')
    expect(main).toContain('const pluginDevEnabled = pluginDeveloperModeEnabled(process.env, app.isPackaged)\n')
  })
})
