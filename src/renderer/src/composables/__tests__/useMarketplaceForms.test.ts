// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installMarketplaceFormListeners,
  marketplaceView,
  openMarketplaceForm,
  submitMarketplaceForm,
} from '../useMarketplaceForms'
import type { PluginApprovalRequest } from '../../../../shared/pluginAgentTools'

const request = (kind: string, extra: Partial<PluginApprovalRequest> = {}): PluginApprovalRequest => ({
  approval_id: 'f1',
  kind: kind as PluginApprovalRequest['kind'],
  owner: `${kind}:@`,
  requester: { paneId: 'p', paneName: 'helper', workspace: null, callerKind: 'pane' },
  reason: 'asked by the user',
  target: { id: '', namespace: '', name: '', version: null, fromVersion: null },
  card: null,
  diff: null,
  disabled: null,
  draft: { fields: { legal_name: 'Ada' }, field_sources: { legal_name: 'agent-draft' } },
  status: 'pending',
  error: null,
  created_at: 1,
  expires_at: 9_999_999_999,
  ...extra,
})

function fakeBackend() {
  const handlers = new Map<string, (payload: unknown) => void>()
  const send = vi.fn(async (_type: string, _payload?: unknown) => ({ ok: true, payload: {} }))
  return {
    send,
    on: (type: string, handler: (payload: unknown) => void) => {
      handlers.set(type, handler)
      return () => handlers.delete(type)
    },
    emit: (type: string, payload: unknown) => handlers.get(type)?.(payload),
  }
}

describe('useMarketplaceForms', () => {
  afterEach(() => {
    delete (window as unknown as { agentTeam?: unknown }).agentTeam
    openMarketplaceForm.value = null
    marketplaceView.value = 'browse'
  })

  it('a manual Submit just runs the call', async () => {
    const backend = fakeBackend()
    const run = vi.fn(async () => ({ ok: true as const, status: 201, body: {} }))
    await submitMarketplaceForm(backend as never, null, run)
    expect(run).toHaveBeenCalledOnce()
    expect(backend.send).not.toHaveBeenCalled()
  })

  it("an agent's draft is approved by this window, then run, then finished", async () => {
    const trustConfirm = vi.fn(async (_a: string, _b: string, subject: string) => ({ subject }))
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { trustConfirm }
    const backend = fakeBackend()
    const order: string[] = []
    backend.send.mockImplementation(async (type: string) => {
      order.push(type)
      return { ok: true, payload: {} }
    })
    await submitMarketplaceForm(backend as never, request('developer-application'), async () => {
      order.push('run')
      return { ok: false as const, status: 422, code: 'APPLICATION_INVALID', message: 'country' }
    })
    expect(order).toEqual(['plugins.agent_request.decide', 'run', 'plugins.agent_request.finish'])
    expect(trustConfirm.mock.calls.map(([, , subject]) => subject)).toEqual(['f1:approve', 'f1:failed'])
    expect(backend.send.mock.calls[1][1]).toMatchObject({ status: 'failed', error: 'APPLICATION_INVALID: country' })
  })

  it('nothing runs when the window could not approve the draft', async () => {
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { trustConfirm: vi.fn(async () => ({})) }
    const backend = fakeBackend()
    backend.send.mockResolvedValue({ ok: false, error: { message: 'not pending' } } as never)
    const run = vi.fn()
    await expect(submitMarketplaceForm(backend as never, request('plugin-publish'), run)).rejects.toThrow('not pending')
    expect(run).not.toHaveBeenCalled()
  })

  it("opens the agent's form, and only form requests", () => {
    const backend = fakeBackend()
    const reveal = vi.fn()
    const stop = installMarketplaceFormListeners(backend as never, reveal)
    backend.emit('plugins.agent_request', request('plugin-install', { approval_id: 'card' }))
    expect(openMarketplaceForm.value).toBeNull()
    backend.emit('plugins.agent_request', request('plugin-publish'))
    expect(openMarketplaceForm.value).toMatchObject({ form: 'publish', origin: 'agent-fill' })
    expect(marketplaceView.value).toBe('developer')
    backend.emit('marketplace.form_open', { form: 'developer-application', prefill: {}, requester: null })
    expect(openMarketplaceForm.value).toMatchObject({ form: 'developer-application', origin: 'agent-open', request: null })
    expect(reveal).toHaveBeenCalledTimes(2)
    stop()
  })

  it('closes a draft another window rejected', () => {
    const backend = fakeBackend()
    const stop = installMarketplaceFormListeners(backend as never, () => {})
    backend.emit('plugins.agent_request', request('plugin-yank'))
    backend.emit('plugins.agent_request_resolved', { approval_id: 'f1', status: 'rejected' })
    expect(openMarketplaceForm.value).toBeNull()
    stop()
  })
})
