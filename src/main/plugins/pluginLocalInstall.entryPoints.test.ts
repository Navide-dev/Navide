// Card K3: installing from a file is the user's own action in a main window.
// These source checks pin the entry points that must never reach it: an
// agent (MCP plugin requests and the window code that carries them out), the
// plugin frame preload, and the environment.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  agentApprovalSourceNote,
  installedPackageSource,
  localSourceConsentLine,
  nativeBackendConsentDialog,
} from './pluginLocalInstall'

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

  it('names a developer folder as unreviewed too, on both dialogs (R2 MED-2 on 0.2.26)', () => {
    // A folder package (K4) carries only the legacy provenance, no `source`.
    const folder = installedPackageSource({ provenance: 'developer-local-unpacked' })
    expect(folder).toBe('developer-unpacked')
    expect(agentApprovalSourceNote(folder)).toBe(
      'Source: a developer folder, not reviewed by Navide; its contents can change at any time.',
    )
    const consent = nativeBackendConsentDialog(
      { pluginId: 'acme.folder', name: 'Folder', packageVersion: '0.1.0', system: [], methods: [], agentTools: [], update: false },
      'en-US',
      folder,
    )
    expect(consent.message.split('\n')[0]).toBe(
      'Source and review: Developer folder; its contents can change at any time, not reviewed by Navide',
    )
    expect(consent.detail.split('\n')[0]).toBe(consent.message.split('\n')[0])
    for (const locale of ['zh-TW', 'ja-JP']) expect(localSourceConsentLine(folder, locale)).not.toBe('')
    // A package's own source wins; Marketplace and local-file rows are unchanged.
    expect(installedPackageSource({ provenance: 'official-registry', source: 'local-unsigned' })).toBe('local-unsigned')
    expect(localSourceConsentLine('local-unsigned', 'en-US')).toBe('Source and review: Local file, not reviewed by Navide, unsigned')
    for (const source of ['marketplace', 'prerelease', 'factory-bundled', undefined] as const) {
      expect(agentApprovalSourceNote(source)).toBe('')
      expect(localSourceConsentLine(source, 'en-US')).toBe('')
    }
    expect(installedPackageSource(undefined)).toBeUndefined()
    // Both main-process dialogs read the source through it, not the bare `source` field.
    const main = read('src/main/index.ts')
    for (const name of ['async function promptNativeBackendConsent', 'async function promptAgentToolWorkspaceWrite']) {
      const body = main.slice(main.indexOf(name))
      const fn = body.slice(0, body.indexOf('\n}\n'))
      expect(fn, name).toContain('installedPackageSource(')
      expect(fn, name).not.toContain(')?.source')
    }
  })

  it('puts the local source first in the native backend consent detail (MED-2)', () => {
    const main = read('src/main/index.ts')
    const prompt = main.slice(main.indexOf('async function promptNativeBackendConsent'))
    const body = prompt.slice(0, prompt.indexOf('\n}\n'))
    expect(body).toContain('nativeBackendConsentDialog(')
    expect(body).not.toContain('nativeBackendConsentText(')
  })
})
