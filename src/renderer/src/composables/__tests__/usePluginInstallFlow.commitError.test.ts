// @vitest-environment happy-dom
// "重新安裝 replace 點擊安裝都沒有反應": a failed approval of a file install
// was written to the pane's error line, under the still-open dialog, and a
// second click failed the same way. The dialog now says why, and a file whose
// prepared copy was used up is not offered again.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'

vi.mock('../usePluginInventory', () => ({ usePluginInventory: () => ({ refresh: vi.fn(async () => undefined) }) }))
vi.mock('../usePluginUpdates', () => ({ usePluginUpdates: () => ({ refresh: vi.fn(async () => undefined) }) }))

import { installFailureMessage, usePluginInstallFlow } from '../usePluginInstallFlow'

const prepared = {
  id: 'acme.todo', version: '1.0.0', trustTier: 'unsigned', sensitive: [], containsBackendExecutable: false,
  requiresConfirmation: true, publisherId: 'acme', requiresPublisherTrust: false, requiresRiskConfirmation: true,
  disclosure: null, scan: null, registry: null, source: 'local-unsigned', digest: 'a'.repeat(64),
}

function setup(commit: () => Promise<unknown>) {
  ;(window as unknown as Record<string, unknown>).agentTeam = {
    plugins: { installFromFile: vi.fn(async () => prepared), commitLocalInstall: vi.fn(commit) },
  }
  let flow!: ReturnType<typeof usePluginInstallFlow>
  mount(defineComponent({ setup() { flow = usePluginInstallFlow(); return () => null } }), { global: { plugins: [i18n] } })
  return flow
}

const ipcError = (message: string) =>
  new Error(`Error invoking remote method 'plugins:commitLocalInstall': InstallError: ${message}`)

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).agentTeam
  vi.spyOn(console, 'error').mockRestore()
})

describe('a failed approval of a file install', () => {
  it('keeps the dialog open with the version reason, and asks for the file again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const flow = setup(async () => { throw ipcError('immutable candidate already exists for acme.todo@1.0.0') })
    await flow.installFromFile()
    await flow.confirmRisk()
    const pending = flow.pendingConfirm.value!
    expect(pending.prepared.id).toBe('acme.todo')
    expect(pending.commitError).toBe(i18n.global.t('settings.extensions.localInstall.versionExists'))
    expect(pending.needsFileAgain).toBe(true)
    expect(flow.error.value).toBe(i18n.global.t('settings.extensions.localInstall.versionExists'))
  })

  it('says only a generic reason for any other failure, never the main process text', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const flow = setup(async () => { throw ipcError('EACCES: permission denied, open ' + "'/Users/someone/plugins/x'") })
    await flow.installFromFile()
    await flow.confirmRisk()
    expect(flow.pendingConfirm.value!.commitError).toBe(i18n.global.t('settings.extensions.localInstall.installFailed'))
    expect(flow.pendingConfirm.value!.commitError).not.toContain('/Users/')
  })

  it('clears the reason with the dialog', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const flow = setup(async () => { throw ipcError('immutable candidate already exists for acme.todo@1.0.0') })
    await flow.installFromFile()
    await flow.confirmRisk()
    flow.cancel()
    expect(flow.pendingConfirm.value).toBeNull()
    await flow.installFromFile()
    expect(flow.pendingConfirm.value!.commitError).toBeUndefined()
    expect(flow.pendingConfirm.value!.needsFileAgain).toBeUndefined()
  })

  it('maps the reason the same way when the file is refused before the dialog', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const flow = setup(async () => ({}))
    ;(window as unknown as { agentTeam: { plugins: Record<string, unknown> } }).agentTeam.plugins.installFromFile = vi.fn(async () => {
      throw new Error("Error invoking remote method 'plugins:installFromFile': InstallError: immutable candidate already exists for acme.todo@1.0.0")
    })
    await flow.installFromFile()
    expect(flow.pendingConfirm.value).toBeNull()
    expect(flow.error.value).toBe(i18n.global.t('settings.extensions.localInstall.versionExists'))
  })

  it('names the two cases apart', () => {
    const t = (key: string) => key
    expect(installFailureMessage('immutable candidate already exists for a.b@1.0.0', t)).toBe('settings.extensions.localInstall.versionExists')
    expect(installFailureMessage('anything else', t)).toBe('settings.extensions.localInstall.installFailed')
  })
})
