// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import PluginAgentRequestDialog, { type PluginAgentRequest } from '../PluginAgentRequestDialog.vue'
import { i18n, useNotify } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { computeDisclosure } from '../../../../shared/pluginDisclosure'

const disclosure = (version: string, permissions: Record<string, unknown>) => computeDisclosure({
  schemaVersion: 2, id: 'acme.indexer', version, publisher: 'acme', permissions,
} as never)

function request(over: Partial<PluginAgentRequest> = {}): PluginAgentRequest {
  return {
    approval_id: 'r1',
    kind: 'plugin-install',
    owner: 'plugin-install:acme.indexer@1.2.0',
    requester: { paneId: 'p-41', paneName: 'dev', workspace: '/Users/me/project', callerKind: 'pane' },
    reason: 'It indexes the repo‮ for search.',
    target: { id: 'acme.indexer', namespace: 'acme', name: 'indexer', version: '1.2.0', fromVersion: null },
    card: { manifest: disclosure('1.2.0', { shell: 'allowlist' }), scan: null, registry: null },
    diff: null,
    status: 'pending',
    error: null,
    created_at: Date.now() / 1000,
    expires_at: Date.now() / 1000 + 600,
    ...over,
  } as PluginAgentRequest
}

describe('PluginAgentRequestDialog (B2)', () => {
  let wrapper: VueWrapper | undefined
  const trustConfirm = vi.fn(async (action: string, deviceId: string, subject: string) => ({
    nonce: 'n', expires: '0', mac: `${action}|${deviceId}|${subject}`,
  }))
  let plugins: Record<string, ReturnType<typeof vi.fn>>

  beforeEach(() => {
    plugins = {
      listInstalled: vi.fn(async () => []),
      installedDisclosure: vi.fn(async () => null),
      prepareInstall: vi.fn(async () => ({ id: 'acme.indexer', requiresPublisherTrust: false, requiresRiskConfirmation: false })),
      commitInstall: vi.fn(async () => ({})),
      rollback: vi.fn(async () => ({})),
      setDisabled: vi.fn(async () => ({})),
      remove: vi.fn(async () => ({ ok: true })),
      nativeBackendData: vi.fn(async () => ({ exists: false, bytes: 0, path: '' })),
      checkUpdates: vi.fn(async () => []),
      pendingUpdates: vi.fn(async () => []),
      listFactoryPackages: vi.fn(async () => []),
    }
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { trustConfirm, plugins }
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    delete (window as unknown as { agentTeam?: unknown }).agentTeam
    trustConfirm.mockClear()
  })

  async function open(mock: ReturnType<typeof createMockBackend>): Promise<VueWrapper> {
    const w = mount(PluginAgentRequestDialog, { props: { backend: mock.backend }, global: { plugins: [i18n] } })
    await flushPromises()
    return w
  }

  it('asks for open requests on mount and stays hidden without any', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('plugins.agent_requests.list', { requests: [] })
    wrapper = await open(mock)
    expect(mock.sent.map((s) => s.type)).toContain('plugins.agent_requests.list')
    expect(wrapper.find('[data-testid="plugin-request-dialog"]').exists()).toBe(false)
  })

  it('shows the request, the agent-written reason as plain text, and the unverified card', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('plugins.agent_requests.list', { requests: [request()] })
    wrapper = await open(mock)
    const text = wrapper.text()
    expect(text).toContain('acme.indexer')
    expect(text).toContain('1.2.0')
    expect(text).toContain('dev')
    expect(text).toContain('/Users/me/project')
    // An invisible bidi override is spelled out, never applied.
    expect(wrapper.find('[data-testid="plugin-request-reason"]').text()).not.toContain('‮')
    expect(wrapper.findComponent({ name: 'PluginDisclosureCard' }).props('verified')).toBe(false)
    expect(wrapper.find('[data-testid="plugin-request-diff"]').exists()).toBe(false)
  })

  it('shows what an update changes from the installed version', async () => {
    plugins.installedDisclosure.mockResolvedValue(disclosure('1.1.0', {}))
    const mock = createMockBackend('connected')
    mock.setResponse('plugins.agent_requests.list', {
      requests: [request({ kind: 'plugin-update', target: { id: 'acme.indexer', namespace: 'acme', name: 'indexer', version: '1.2.0', fromVersion: '1.1.0' } })],
    })
    wrapper = await open(mock)
    await flushPromises()
    expect(plugins.installedDisclosure).toHaveBeenCalledWith('acme.indexer')
    const diff = wrapper.findComponent({ name: 'PluginDisclosureDiff' })
    expect(diff.exists()).toBe(true)
    expect((diff.props('diff') as { widened: boolean }).widened).toBe(true)
  })

  it('W1: a file request shows the path, the digest and that Navide has not reviewed it; approving opens the same local consent', async () => {
    const digest = 'ab'.repeat(32)
    const file = request({
      kind: 'plugin-install-file' as PluginAgentRequest['kind'],
      target: {
        id: 'acme.indexer', namespace: 'acme', name: 'indexer', version: '1.2.0', fromVersion: null,
        path: '/Users/me/Downloads/indexer.vsix', digest, stagingId: 'cd'.repeat(16), packageKind: 'file',
      },
    })
    plugins.prepareAgentFileInstall = vi.fn(async () => ({
      id: 'acme.indexer', version: '1.2.0', source: 'local-unsigned', digest, sensitive: [], requiresRiskConfirmation: true,
    }))
    plugins.commitLocalInstall = vi.fn(async () => ({}))
    const mock = createMockBackend('connected')
    mock.setResponse('plugins.agent_requests.list', { requests: [file] })
    mock.setResponse('plugins.agent_request.decide', { approval: { ...file, status: 'applying' } })
    wrapper = await open(mock)
    expect(wrapper.find('[data-testid="plugin-request-file-path"]').text()).toBe('/Users/me/Downloads/indexer.vsix')
    expect(wrapper.find('[data-testid="plugin-request-file-digest"]').text()).toBe(digest)
    expect(wrapper.find('[data-testid="plugin-request-file-unreviewed"]').exists()).toBe(true)
    await wrapper.find('[data-testid="plugin-request-approve"]').trigger('click')
    await flushPromises()
    // The window names the staged copy, never the path; nothing is committed
    // until the user confirms the consent dialog, which names who asked.
    expect(plugins.prepareAgentFileInstall).toHaveBeenCalledWith('cd'.repeat(16), { callerKind: 'pane', paneName: 'dev' })
    expect(plugins.commitLocalInstall).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="ext-trust-agent-request"]').text()).toContain('dev')
  })

  it('W1: a file request discloses a local file as its source, never the Navide Marketplace', async () => {
    const file = (card: PluginAgentRequest['card']) => request({
      kind: 'plugin-install-file' as PluginAgentRequest['kind'],
      target: {
        id: 'acme.indexer', namespace: 'acme', name: 'indexer', version: '1.2.0', fromVersion: null,
        path: '/x.vsix', digest: 'ab'.repeat(32), stagingId: 'cd'.repeat(16), packageKind: 'file',
      },
      card,
    })
    const t = (key: string) => i18n.global.t(key)
    const mock = createMockBackend('connected')
    mock.setResponse('plugins.agent_requests.list', { requests: [file(request().card)] })
    wrapper = await open(mock)
    expect(wrapper.text()).toContain(t('plugin-request.file.card'))
    expect(wrapper.text()).toContain(t('pluginDisclosure.provenance.local'))
    expect(wrapper.text()).not.toContain(t('plugin-request.card'))
    expect(wrapper.text()).not.toContain(t('pluginDisclosure.provenance.unverified'))
    wrapper.unmount()
    const bare = createMockBackend('connected')
    bare.setResponse('plugins.agent_requests.list', { requests: [file(null)] })
    wrapper = await open(bare)
    expect(wrapper.find('[data-testid="plugin-request-no-card"]').text()).toBe(t('plugin-request.file.no-card'))
    // A Marketplace install keeps its wording.
    wrapper.unmount()
    const registry = createMockBackend('connected')
    registry.setResponse('plugins.agent_requests.list', { requests: [request()] })
    wrapper = await open(registry)
    expect(wrapper.text()).toContain(t('plugin-request.card'))
    expect(wrapper.text()).toContain(t('pluginDisclosure.provenance.unverified'))
  })

  it('MED-5: a file request whose time ran out reads as expired, never as failed', async () => {
    const file = (over: Partial<PluginAgentRequest> = {}) => request({
      kind: 'plugin-install-file' as PluginAgentRequest['kind'],
      target: {
        id: 'acme.indexer', namespace: 'acme', name: 'indexer', version: '1.2.0', fromVersion: null,
        path: '/Users/me/Downloads/indexer.vsix', digest: 'ab'.repeat(32), stagingId: 'cd'.repeat(16), packageKind: 'file',
      },
      ...over,
    })
    // The card's own time ran out: expired, nothing to approve.
    const late = createMockBackend('connected')
    late.setResponse('plugins.agent_requests.list', { requests: [file({ expires_at: Date.now() / 1000 - 1 })] })
    wrapper = await open(late)
    expect(wrapper.text()).toContain(i18n.global.t('plugin-request.expired'))
    expect(wrapper.find('[data-testid="plugin-request-approve"]').exists()).toBe(false)
    wrapper.unmount()
    // The Host's staged copy expired between the card and the approval.
    plugins.prepareAgentFileInstall = vi.fn(async () => {
      throw new Error("Error invoking remote method 'plugins:prepareAgentFileInstall': Error: AGENT_STAGING_EXPIRED: this request expired; ask the agent to send it again")
    })
    const mock = createMockBackend('connected')
    mock.setResponse('plugins.agent_requests.list', { requests: [file()] })
    mock.setResponse('plugins.agent_request.decide', { approval: { ...file(), status: 'applying' } })
    mock.setResponse('plugins.agent_request.finish', { approval: { ...file(), status: 'failed' } })
    wrapper = await open(mock)
    await wrapper.find('[data-testid="plugin-request-approve"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain(i18n.global.t('plugin-request.expired'))
    expect(wrapper.find('[data-testid="plugin-request-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="plugin-request-dismiss"]').exists()).toBe(true)
  })

  it('MED-5: rejecting a file request deletes its staged copy at once', async () => {
    plugins.discardAgentStaged = vi.fn(async () => undefined)
    const file = request({
      kind: 'plugin-install-file' as PluginAgentRequest['kind'],
      target: {
        id: 'acme.indexer', namespace: 'acme', name: 'indexer', version: '1.2.0', fromVersion: null,
        path: '/x.vsix', digest: 'ab'.repeat(32), stagingId: 'cd'.repeat(16), packageKind: 'file',
      },
    })
    const mock = createMockBackend('connected')
    mock.setResponse('plugins.agent_requests.list', { requests: [file] })
    mock.setResponse('plugins.agent_request.decide', { approval: { ...file, status: 'rejected' } })
    wrapper = await open(mock)
    await wrapper.find('[data-testid="plugin-request-reject"]').trigger('click')
    await flushPromises()
    expect(plugins.discardAgentStaged).toHaveBeenCalledWith('cd'.repeat(16))
  })

  it('LOW-3: a file request rejected in another window, or expired, drops its copy; one approved there does not', async () => {
    plugins.discardAgentStaged = vi.fn(async () => undefined)
    const file = (id: string, stagingId: string) => request({
      approval_id: id,
      kind: 'plugin-install-file' as PluginAgentRequest['kind'],
      target: {
        id: 'acme.indexer', namespace: 'acme', name: 'indexer', version: '1.2.0', fromVersion: null,
        path: '/x.vsix', digest: 'ab'.repeat(32), stagingId, packageKind: 'file',
      },
    })
    const mock = createMockBackend('connected')
    mock.setResponse('plugins.agent_requests.list', {
      requests: [file('r1', '11'.repeat(16)), file('r2', '22'.repeat(16)), file('r3', '33'.repeat(16))],
    })
    wrapper = await open(mock)
    mock.emit('plugins.agent_request_resolved', { approval_id: 'r1', status: 'rejected', error: null })
    mock.emit('plugins.agent_request_resolved', { approval_id: 'r2', status: 'applying', error: null })
    mock.emit('plugins.agent_request_resolved', { approval_id: 'r3', status: 'expired', error: null })
    await flushPromises()
    expect(plugins.discardAgentStaged.mock.calls).toEqual([['11'.repeat(16)], ['33'.repeat(16)]])
  })

  it('approves with a window confirmation, installs, reports completed and closes', async () => {
    plugins.listInstalled.mockResolvedValue([{ id: 'acme.indexer', packageVersion: '1.2.0' }])
    const mock = createMockBackend('connected')
    mock.setResponse('plugins.agent_requests.list', { requests: [request()] })
    mock.setResponse('plugins.agent_request.decide', { approval: { ...request(), status: 'applying' } })
    mock.setResponse('plugins.agent_request.finish', { approval: { ...request(), status: 'completed' } })
    wrapper = await open(mock)
    await wrapper.find('[data-testid="plugin-request-approve"]').trigger('click')
    await flushPromises()
    expect(trustConfirm).toHaveBeenCalledWith('plugins.agent_request.decide', '', 'r1:approve')
    const decide = mock.sent.find((s) => s.type === 'plugins.agent_request.decide')!
    expect(decide.payload).toMatchObject({ approval_id: 'r1', approve: true })
    expect(plugins.prepareInstall).toHaveBeenCalledWith({ namespace: 'acme', name: 'indexer', version: '1.2.0' })
    expect(plugins.commitInstall).toHaveBeenCalled()
    const finish = mock.sent.find((s) => s.type === 'plugins.agent_request.finish')!
    expect(finish.payload).toMatchObject({ approval_id: 'r1', status: 'completed' })
    expect(wrapper.find('[data-testid="plugin-request-dialog"]').exists()).toBe(false)
  })

  it('waits for the trust dialog, and reports not-applied when the user cancels it', async () => {
    plugins.prepareInstall.mockResolvedValue({ id: 'acme.indexer', requiresPublisherTrust: true, requiresRiskConfirmation: false })
    const mock = createMockBackend('connected')
    mock.setResponse('plugins.agent_requests.list', { requests: [request()] })
    mock.setResponse('plugins.agent_request.decide', { approval: { ...request(), status: 'applying' } })
    mock.setResponse('plugins.agent_request.finish', { approval: { ...request(), status: 'failed' } })
    wrapper = await open(mock)
    await wrapper.find('[data-testid="plugin-request-approve"]').trigger('click')
    await flushPromises()
    const trust = wrapper.findComponent({ name: 'PluginTrustDialog' })
    expect(trust.exists()).toBe(true)
    expect(mock.sent.some((s) => s.type === 'plugins.agent_request.finish')).toBe(false)  // still waiting
    trust.vm.$emit('cancel')
    await flushPromises()
    expect(plugins.commitInstall).not.toHaveBeenCalled()
    const finish = mock.sent.find((s) => s.type === 'plugins.agent_request.finish')!
    expect(finish.payload).toMatchObject({ approval_id: 'r1', status: 'failed', error: 'not-applied' })
    expect(wrapper.find('[data-testid="plugin-request-error"]').text()).toContain('not-applied')
  })

  const rollbackRequest = () => request({
    kind: 'plugin-rollback',
    target: { id: 'acme.indexer', namespace: 'acme', name: 'indexer', version: '1.1.0', fromVersion: '1.2.0' },
  })

  async function approveRollback(mock: ReturnType<typeof createMockBackend>): Promise<VueWrapper> {
    plugins.listInstalled.mockResolvedValue([
      { id: 'acme.indexer', packageVersion: '1.2.0', rollbackKind: 'previous', rollbackToVersion: '1.1.0' },
    ])
    mock.setResponse('plugins.agent_requests.list', { requests: [rollbackRequest()] })
    mock.setResponse('plugins.agent_request.decide', { approval: { ...rollbackRequest(), status: 'applying' } })
    mock.setResponse('plugins.agent_request.finish', { approval: { ...rollbackRequest(), status: 'failed' } })
    const w = await open(mock)
    await w.find('[data-testid="plugin-request-approve"]').trigger('click')
    await flushPromises()
    return w
  }

  it('asks the Extensions rollback confirmation, and reports not-applied when the user cancels it', async () => {
    const mock = createMockBackend('connected')
    wrapper = await approveRollback(mock)
    const dialog = useNotify().dialog.value!
    expect(dialog).toMatchObject({
      kind: 'confirm',
      danger: true,
      title: i18n.global.t('settings.extensions.rollback.title'),
      confirmText: i18n.global.t('settings.extensions.rollback.confirm'),
      message: i18n.global.t('settings.extensions.rollback.confirmPrevious', { id: 'acme.indexer', version: '1.1.0' }),
    })
    expect(mock.sent.some((s) => s.type === 'plugins.agent_request.finish')).toBe(false)  // still waiting
    useNotify().resolveDialog(false)
    await flushPromises()
    expect(plugins.rollback).not.toHaveBeenCalled()
    const finish = mock.sent.find((s) => s.type === 'plugins.agent_request.finish')!
    expect(finish.payload).toMatchObject({ approval_id: 'r1', status: 'failed', error: 'not-applied' })
  })

  it('rolls back only once the user confirms', async () => {
    const mock = createMockBackend('connected')
    wrapper = await approveRollback(mock)
    expect(plugins.rollback).not.toHaveBeenCalled()
    plugins.listInstalled.mockResolvedValue([{ id: 'acme.indexer', packageVersion: '1.1.0' }])
    mock.setResponse('plugins.agent_request.finish', { approval: { ...rollbackRequest(), status: 'completed' } })
    useNotify().resolveDialog(true)
    await flushPromises()
    expect(plugins.rollback).toHaveBeenCalledWith('acme.indexer')
    const finish = mock.sent.find((s) => s.type === 'plugins.agent_request.finish')!
    expect(finish.payload).toMatchObject({ approval_id: 'r1', status: 'completed' })
  })

  it('says so when its result came after another window had settled the request', async () => {
    plugins.listInstalled.mockResolvedValue([{ id: 'acme.indexer', packageVersion: '1.2.0' }])
    const notify = useNotify()
    const mock = createMockBackend('connected')
    mock.setResponse('plugins.agent_requests.list', { requests: [request()] })
    mock.setResponse('plugins.agent_request.decide', { approval: { ...request(), status: 'applying' } })
    mock.setResponse('plugins.agent_request.finish', {
      approval: { ...request(), status: 'completed', finished_late: true, settled: { status: 'failed', error: 'interrupted' } },
    })
    wrapper = await open(mock)
    await wrapper.find('[data-testid="plugin-request-approve"]').trigger('click')
    await flushPromises()
    expect(notify.toasts.value.map((toast) => toast.message)).toContain(
      i18n.global.t('plugin-request.completed-late', { plugin: 'acme.indexer' }),
    )
    expect(wrapper.find('[data-testid="plugin-request-dialog"]').exists()).toBe(false)
  })

  it('shows a late failed result with the note', async () => {
    plugins.prepareInstall.mockRejectedValue(new Error('download failed'))
    const mock = createMockBackend('connected')
    mock.setResponse('plugins.agent_requests.list', { requests: [request()] })
    mock.setResponse('plugins.agent_request.decide', { approval: { ...request(), status: 'applying' } })
    mock.setResponse('plugins.agent_request.finish', {
      approval: { ...request(), status: 'failed', error: 'download failed', finished_late: true,
        settled: { status: 'failed', error: 'interrupted' } },
    })
    wrapper = await open(mock)
    await wrapper.find('[data-testid="plugin-request-approve"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="plugin-request-error"]').text()).toContain('download failed')
    expect(wrapper.find('[data-testid="plugin-request-finished-late"]').text()).toBe(i18n.global.t('plugin-request.finished-late'))
  })

  it('rejects with a reject-bound confirmation and touches nothing', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('plugins.agent_requests.list', { requests: [request()] })
    mock.setResponse('plugins.agent_request.decide', { approval: { ...request(), status: 'rejected' } })
    wrapper = await open(mock)
    await wrapper.find('[data-testid="plugin-request-reject"]').trigger('click')
    await flushPromises()
    expect(trustConfirm).toHaveBeenCalledWith('plugins.agent_request.decide', '', 'r1:reject')
    expect(plugins.prepareInstall).not.toHaveBeenCalled()
    expect(mock.sent.some((s) => s.type === 'plugins.agent_request.finish')).toBe(false)
    expect(wrapper.find('[data-testid="plugin-request-dialog"]').exists()).toBe(false)
  })

  it("never shows an agent's form draft as an approval card (W3): its form opens in Settings", async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('plugins.agent_requests.list', {
      requests: [request({ approval_id: 'f1', kind: 'plugin-publish' as never }), request({ approval_id: 'f2', kind: 'developer-application' as never })],
    })
    wrapper = await open(mock)
    mock.emit('plugins.agent_request', request({ approval_id: 'f3', kind: 'plugin-yank' as never }))
    await flushPromises()
    expect(wrapper.find('[data-testid="plugin-request-dialog"]').exists()).toBe(false)
  })

  it('says so when the asking pane has external influence (S8-M1), and still lets the user decide', async () => {
    const mock = createMockBackend('connected')
    const tainted = request()
    tainted.requester = { ...tainted.requester, tainted: true } as never
    mock.setResponse('plugins.agent_requests.list', { requests: [tainted] })
    wrapper = await open(mock)
    const line = wrapper.find('[data-testid="plugin-request-tainted"]')
    expect(line.exists()).toBe(true)
    expect(line.text()).toBe(i18n.global.t('plugin-request.tainted'))
    expect(wrapper.find('[data-testid="plugin-request-approve"]').attributes('disabled')).toBeUndefined()
  })

  it('shows no external-influence line for a clean pane', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('plugins.agent_requests.list', { requests: [request()] })
    wrapper = await open(mock)
    expect(wrapper.find('[data-testid="plugin-request-tainted"]').exists()).toBe(false)
  })

  it('drops a request decided in another window', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('plugins.agent_requests.list', { requests: [request()] })
    wrapper = await open(mock)
    mock.emit('plugins.agent_request_resolved', { approval_id: 'r1', status: 'rejected' })
    await flushPromises()
    expect(wrapper.find('[data-testid="plugin-request-dialog"]').exists()).toBe(false)
  })

  it('drops another queued request resolved elsewhere while a failed result is still shown', async () => {
    plugins.prepareInstall.mockRejectedValue(new Error('download failed'))
    const mock = createMockBackend('connected')
    mock.setResponse('plugins.agent_requests.list', { requests: [request(), request({ approval_id: 'r2' })] })
    mock.setResponse('plugins.agent_request.decide', { approval: { ...request(), status: 'applying' } })
    mock.setResponse('plugins.agent_request.finish', { approval: { ...request(), status: 'failed' } })
    wrapper = await open(mock)
    await wrapper.find('[data-testid="plugin-request-approve"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="plugin-request-error"]').exists()).toBe(true)
    mock.emit('plugins.agent_request_resolved', { approval_id: 'r1', status: 'failed' })
    mock.emit('plugins.agent_request_resolved', { approval_id: 'r2', status: 'rejected' })
    await flushPromises()
    // The failed result stays until dismissed; r2 no longer waits behind it.
    expect(wrapper.find('[data-testid="plugin-request-error"]').exists()).toBe(true)
    await wrapper.find('[data-testid="plugin-request-dismiss"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="plugin-request-dialog"]').exists()).toBe(false)
  })

  it('shows who disabled the plugin for an enable request, and enables it when approved', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('plugins.agent_requests.list', {
      requests: [request({
        kind: 'plugin-enable',
        target: { id: 'acme.indexer', namespace: 'acme', name: 'indexer', version: '1.2.0', fromVersion: null },
        disabled: { by: 'agent', at: null, agent: { callerKind: 'pane', paneId: 'p-7', paneName: 'review' } },
      })],
    })
    wrapper = await open(mock)
    expect(wrapper.find('[data-testid="plugin-request-disabled-by"]').text()).toContain('review')
    expect(wrapper.find('[data-testid="plugin-request-disabled-at"]').text()).toBe(i18n.global.t('plugin-request.not-recorded'))
    // #385: an approved enable turns the user's own Enable switch on.
    plugins.listInstalled.mockResolvedValue([{ id: 'acme.indexer', packageVersion: '1.2.0', disabled: false }])
    const enableRequest = { ...request(), kind: 'plugin-enable' }
    mock.setResponse('plugins.agent_request.decide', { approval: { ...enableRequest, status: 'applying' } })
    mock.setResponse('plugins.agent_request.finish', { approval: { ...enableRequest, status: 'completed' } })
    const approve = wrapper.find('[data-testid="plugin-request-approve"]')
    expect(approve.attributes('disabled')).toBeUndefined()
    await approve.trigger('click')
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'plugins.agent_request.decide')!.payload).toMatchObject({ approve: true })
    expect(plugins.setDisabled).toHaveBeenCalledWith('acme.indexer', false)
    expect(plugins.prepareInstall).not.toHaveBeenCalled()
    expect(mock.sent.find((s) => s.type === 'plugins.agent_request.finish')!.payload).toMatchObject({ status: 'completed' })
  })
})
