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

  it('asks for the file again, and counts each failure (#643 L3)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const flow = setup(async () => { throw ipcError('anything') })
    await flow.installFromFile()
    await flow.confirmRisk()
    expect(flow.pendingConfirm.value!.commitNextStep).toBe(i18n.global.t('settings.extensions.localInstall.chooseAgain'))
    expect(flow.pendingConfirm.value!.commitFailures).toBe(1)
    await flow.confirmRisk()
    expect(flow.pendingConfirm.value!.commitFailures).toBe(2)
  })

  it("asks the agent, not the user, to send a request again (#643 L1)", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const flow = setup(async () => { throw ipcError('anything') })
    ;(window as unknown as { agentTeam: { plugins: Record<string, unknown> } }).agentTeam.plugins.prepareAgentFileInstall =
      vi.fn(async () => prepared)
    await flow.prepareAgentFile('staging-1', prepared.digest, 'pane-1')
    await flow.confirmRisk()
    const pending = flow.pendingConfirm.value!
    expect(pending.commitNextStep).toBe(i18n.global.t('settings.extensions.localInstall.askAgentAgain'))
    expect(pending.needsFileAgain).toBe(true)
  })

  it('tells a failed Marketplace install to start again, and keeps approving possible (#643 L2)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const marketplace = { ...prepared, source: 'marketplace', requiresPublisherTrust: false }
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      plugins: {
        prepareInstall: vi.fn(async () => marketplace),
        commitInstall: vi.fn(async () => { throw new Error("Error invoking remote method 'plugins:commitInstall': Error: x") }),
      },
    }
    let flow!: ReturnType<typeof usePluginInstallFlow>
    mount(defineComponent({ setup() { flow = usePluginInstallFlow(); return () => null } }), { global: { plugins: [i18n] } })
    await flow.install('acme', 'todo')
    await flow.confirmRisk()
    const pending = flow.pendingConfirm.value!
    expect(pending.commitError).toBe(i18n.global.t('settings.extensions.localInstall.installFailed'))
    expect(pending.commitNextStep).toBe(i18n.global.t('settings.extensions.localInstall.startAgain'))
    expect(pending.needsFileAgain).toBeUndefined()
  })

  it('says a failed rollback in the dialog, without asking for a file (#643 L4)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      plugins: {
        prepareLocalRollback: vi.fn(async () => ({ ...prepared, rollbackFrom: '1.0.1' })),
        rollback: vi.fn(async () => { throw new Error("Error invoking remote method 'plugins:rollback': Error: " + '/Users/someone/x') }),
      },
    }
    let flow!: ReturnType<typeof usePluginInstallFlow>
    mount(defineComponent({ setup() { flow = usePluginInstallFlow(); return () => null } }), { global: { plugins: [i18n] } })
    await flow.rollbackWithConsent('acme.todo')
    await flow.confirmRisk()
    const pending = flow.pendingConfirm.value!
    expect(pending.commitError).toBe(i18n.global.t('settings.extensions.localInstall.rollbackFailed'))
    expect(pending.commitNextStep).toBe(i18n.global.t('settings.extensions.localInstall.startAgain'))
    expect(pending.needsFileAgain).toBeUndefined()
    // The pane's error line is written as before.
    expect(flow.error.value).not.toBe('')
  })

  it.each([
    ['still holds the copy', async () => ({ present: true }), undefined, 'approveAgain'],
    ['no longer holds the copy', async () => ({ present: false }), true, 'chooseAgain'],
    ['cannot be asked', async () => { throw new Error('offline') }, true, 'chooseAgain'],
  ] as const)('keeps approving possible only when the main process %s (#643 L1)', async (_case, query, needsFileAgain, step) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const flow = setup(async () => { throw ipcError('plugin transaction already in progress for acme.todo') })
    const preparedLocalInstall = vi.fn(query)
    ;(window as unknown as { agentTeam: { plugins: Record<string, unknown> } }).agentTeam.plugins.preparedLocalInstall = preparedLocalInstall
    await flow.installFromFile()
    await flow.confirmRisk()
    expect(preparedLocalInstall).toHaveBeenCalledWith('acme.todo', prepared.digest)
    const pending = flow.pendingConfirm.value!
    expect(pending.needsFileAgain).toBe(needsFileAgain)
    expect(pending.commitNextStep).toBe(i18n.global.t(`settings.extensions.localInstall.${step}`))
  })

  it('names the two cases apart', () => {
    const t = (key: string) => key
    expect(installFailureMessage('immutable candidate already exists for a.b@1.0.0', t)).toBe('settings.extensions.localInstall.versionExists')
    expect(installFailureMessage('anything else', t)).toBe('settings.extensions.localInstall.installFailed')
  })
})
