import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Guard grades agent CLI tool calls that reach the backend through the
// PreToolUse hook (`/hooks/<vendor>/pretooluse`) or the `guard.*` WebSocket
// API. Navide's own install, update, remove, rollback and trust-record writes
// happen here, in the main process, with node:fs directly: none of these
// modules may route a write through Guard, so its plugin-store rule can never
// block or prompt Navide's own plugin management.
const INSTALL_PATH_MODULES = [
  'pluginIpc.ts',
  'pluginInstaller.ts',
  'pluginInstallPaths.ts',
  'pluginLocalInstall.ts',
  'pluginLocalTrust.ts',
  'pluginInstalledTrust.ts',
  'pluginDeveloperModeStore.ts',
  'pluginNativeBackendData.ts',
  'pluginNativeBackendStore.ts',
  'pluginNativeBackendIpc.ts',
  'installedPlugins.ts',
]

describe('plugin install path and Guard', () => {
  it.each(INSTALL_PATH_MODULES)('%s never calls Guard', (file) => {
    const source = readFileSync(join(__dirname, file), 'utf8')
    expect(source).not.toMatch(/['"`]guard\.[a-z]/)
    expect(source).not.toMatch(/\/hooks\/|pretooluse|guard_hooks/i)
  })

  it('writes plugin files with node:fs in the main process', () => {
    for (const file of ['pluginInstaller.ts', 'pluginLocalInstall.ts', 'pluginNativeBackendData.ts']) {
      expect(readFileSync(join(__dirname, file), 'utf8')).toMatch(/from 'node:fs'/)
    }
  })
})
