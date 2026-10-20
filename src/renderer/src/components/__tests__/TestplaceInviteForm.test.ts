// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import TestplaceInviteForm from '../TestplaceInviteForm.vue'
import { openMarketplaceForm, type OpenMarketplaceForm } from '../../composables/useMarketplaceForms'
import type { PluginApprovalRequest } from '../../../../shared/pluginAgentTools'

// A join code as the Registry returns it, built so no scanner reads it as a secret.
const JOIN = ['tpi', 'abcdefghijklmnop'].join('_')

const request: PluginApprovalRequest = {
  approval_id: 'tp1',
  kind: 'testplace-invite',
  owner: 'testplace-invite:acme.demo@',
  requester: { paneId: 'p', paneName: 'helper', workspace: null, callerKind: 'pane' },
  reason: 'the user asked for two testers',
  target: { id: 'acme.demo', namespace: 'acme', name: 'demo', version: null, fromVersion: null },
  card: null,
  diff: null,
  disabled: null,
  draft: { fields: { invitees: ['ada@example.com', 'bob from QA'] }, field_sources: {} },
  status: 'pending',
  error: null,
  created_at: 1,
  expires_at: 9_999_999_999,
}

function form(extra: Partial<OpenMarketplaceForm> = {}): OpenMarketplaceForm {
  return { form: 'testplace-invite', origin: 'agent-fill', prefill: {}, requester: request.requester, request, seq: 1, ...extra }
}

function fakeBackend() {
  return { send: vi.fn(async (_type: string, _payload?: unknown) => ({ ok: true, payload: {} })), on: vi.fn() }
}

describe('TestplaceInviteForm (W5b)', () => {
  let wrapper: VueWrapper | undefined
  let testplaceInvite: ReturnType<typeof vi.fn>

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    testplaceInvite = vi.fn(async () => ({
      ok: true as const,
      status: 201,
      body: { invites: [{ id: 1, label: 'ada@example.com', join_token: JOIN }, { id: 2, label: 'bob from QA', join_token: `${JOIN}2` }] },
    }))
    ;(window as unknown as { agentTeam: unknown }).agentTeam = {
      trustConfirm: vi.fn(async (_a: string, _b: string, subject: string) => ({ subject })),
      plugins: { testplaceInvite },
    }
  })
  afterEach(() => {
    wrapper?.unmount()
    openMarketplaceForm.value = null
    delete (window as unknown as { agentTeam?: unknown }).agentTeam
  })

  it("opens an agent's draft with each tester marked, and invites nobody before Send", async () => {
    const backend = fakeBackend()
    wrapper = mount(TestplaceInviteForm, { props: { backend: backend as never, form: form() }, global: { plugins: [i18n] } })
    await flushPromises()
    expect((wrapper.get('#tp-invite-id').element as HTMLInputElement).value).toBe('acme.demo')
    expect((wrapper.get('#tp-invite-list').element as HTMLTextAreaElement).value).toBe('ada@example.com\nbob from QA')
    expect(wrapper.findAll('.tp-invite-line .dev-chip--agent')).toHaveLength(2)
    expect(wrapper.text()).toContain('the user asked for two testers')
    expect(testplaceInvite).not.toHaveBeenCalled()
    expect(backend.send).not.toHaveBeenCalled()
    // A line the user rewrote is no longer the agent's.
    await wrapper.get('#tp-invite-list').setValue('ada@example.com\ncarol@example.com')
    expect(wrapper.findAll('.tp-invite-line .dev-chip--agent')).toHaveLength(1)
  })

  it("Send approves the draft, invites, shows the codes once and keeps them out of the request's result", async () => {
    const backend = fakeBackend()
    wrapper = mount(TestplaceInviteForm, { props: { backend: backend as never, form: form() }, global: { plugins: [i18n] } })
    await flushPromises()
    await wrapper.get('.nv-btn--primary').trigger('click')
    await flushPromises()
    expect(testplaceInvite).toHaveBeenCalledWith('acme.demo', ['ada@example.com', 'bob from QA'])
    expect(backend.send.mock.calls.map(([type]) => type)).toEqual(['plugins.agent_request.decide', 'plugins.agent_request.finish'])
    expect(backend.send.mock.calls[1][1]).toMatchObject({ approval_id: 'tp1', status: 'completed', error: null })
    expect(JSON.stringify(backend.send.mock.calls)).not.toContain(JOIN)
    expect(wrapper.findAll('.tp-invite-code').map((code) => code.text())).toEqual([JOIN, `${JOIN}2`])
  })

  it('a manual open just sends, and Cancel on an agent draft rejects it', async () => {
    const manual = fakeBackend()
    wrapper = mount(TestplaceInviteForm, {
      props: { backend: manual as never, form: form({ origin: 'user', request: null, requester: null, prefill: { id: 'acme.demo' } }) },
      global: { plugins: [i18n] },
    })
    await wrapper.get('#tp-invite-list').setValue('ada@example.com')
    await wrapper.get('.nv-btn--primary').trigger('click')
    await flushPromises()
    expect(testplaceInvite).toHaveBeenCalledWith('acme.demo', ['ada@example.com'])
    expect(manual.send).not.toHaveBeenCalled()
    wrapper.unmount()

    const backend = fakeBackend()
    wrapper = mount(TestplaceInviteForm, { props: { backend: backend as never, form: form() }, global: { plugins: [i18n] } })
    await wrapper.get('.nv-btn--ghost').trigger('click')
    await flushPromises()
    expect(backend.send).toHaveBeenCalledWith('plugins.agent_request.decide', expect.objectContaining({ approval_id: 'tp1', approve: false }), 30_000)
  })

  it('says why the Registry refused, without a raw code', async () => {
    testplaceInvite.mockResolvedValue({ ok: false, status: 409, code: 'INVITE_LIMIT', message: 'limit' })
    wrapper = mount(TestplaceInviteForm, { props: { backend: fakeBackend() as never, form: form() }, global: { plugins: [i18n] } })
    await wrapper.get('.nv-btn--primary').trigger('click')
    await flushPromises()
    expect(wrapper.get('.dev-error').text()).toBe('This would exceed the tester limit of this Navide plugin.')
  })
})
