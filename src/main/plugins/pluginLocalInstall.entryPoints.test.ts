// Card K3: installing from a file is the user's own action in a main window.
// These source checks pin the entry points that must never reach it: an
// agent (MCP plugin requests and the window code that carries them out), the
// plugin frame preload, and the environment.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { agentApprovalSourceNote } from './pluginLocalInstall'

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')
const LOCAL_INSTALL = /installFromFile|commitLocalInstall/

describe('install-from-file entry points', () => {
  it('is never reached by an agent request: not from MCP, nor from the window code applying one', () => {
    for (const path of [
      'backend/agent_team_backend/mcp_server/server.py',
      'src/renderer/src/lib/pluginAgentRequestApply.ts',
      'src/renderer/src/composables/usePluginAgentRequests.ts',
      'src/renderer/src/components/PluginAgentRequestDialog.vue',
    ]) {
      expect(read(path), path).not.toMatch(LOCAL_INSTALL)
    }
    // The request kinds an agent can file are Marketplace ids, never a file.
    expect(read('src/shared/pluginAgentTools.ts')).toMatch(
      /export type ApprovalKind = 'skill' \| 'plugin-install' \| 'plugin-update' \| 'plugin-rollback' \| 'plugin-remove' \| 'plugin-enable'\n/,
    )
  })

  it('is not exposed to plugin frames', () => {
    expect(read('src/preload/plugin-preload.ts')).not.toMatch(LOCAL_INSTALL)
  })

  it('takes no path from the renderer: the main window preload sends no arguments', () => {
    const preload = read('src/preload/index.ts')
    expect(preload).toContain("installFromFile: (): Promise<PreparedInstallSummary | null> => ipcRenderer.invoke('plugins:installFromFile'),")
  })

  it('reads no environment variable and no path other than the Host dialog result', () => {
    const ipc = read('src/main/plugins/pluginIpc.ts')
    const start = ipc.indexOf("ipcMain.handle('plugins:installFromFile'")
    const end = ipc.indexOf("ipcMain.handle(\n    'plugins:commitLocalInstall'")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const handler = ipc.slice(start, end)
    expect(handler).not.toContain('process.env')
    expect(handler).toContain('const path = await pickFile(event)')
    expect(handler.match(/readFileSync\(/g)).toHaveLength(1)
  })

  it('names an unreviewed local source on the agent tool approval', () => {
    expect(agentApprovalSourceNote('local-unsigned')).toBe('Source: a local file, not reviewed by Navide.')
    expect(agentApprovalSourceNote('marketplace')).toBe('')
    expect(agentApprovalSourceNote(undefined)).toBe('')
    const main = read('src/main/index.ts')
    const prompt = main.slice(main.indexOf('async function promptAgentToolWorkspaceWrite'))
    expect(prompt.slice(0, prompt.indexOf('\n}\n'))).toContain('agentApprovalSourceNote(')
  })

  it('puts the local source first in the native backend consent detail (MED-2)', () => {
    const main = read('src/main/index.ts')
    const prompt = main.slice(main.indexOf('async function promptNativeBackendConsent'))
    const body = prompt.slice(0, prompt.indexOf('\n}\n'))
    expect(body).toContain('localSourceConsentLine(')
    expect(body).toContain('detail: sourceLine ? `${sourceLine}\\n\\n${detail}` : detail,')
  })
})
