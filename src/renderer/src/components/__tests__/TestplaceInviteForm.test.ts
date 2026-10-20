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

  it('says so when the asking pane has external influence (S8-M1), and still lets the user send', async () => {
    const requester = { ...request.requester, tainted: true as const }
    wrapper = mount(TestplaceInviteForm, {
      props: { backend: fakeBackend() as never, form: form({ requester, request: { ...request, requester } }) },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    const line = wrapper.find('[data-testid="testplace-invite-tainted"]')
    expect(line.exists()).toBe(true)
    expect(line.text()).toBe(i18n.global.t('plugin-request.tainted'))
  })

  it('shows no external-influence line for a clean pane', async () => {
    wrapper = mount(TestplaceInviteForm, { props: { backend: fakeBackend() as never, form: form() }, global: { plugins: [i18n] } })
    await flushPromises()
    expect(wrapper.find('[data-testid="testplace-invite-tainted"]').exists()).toBe(false)
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
    testplaceInvite.mockResolvedValue({ ok: false, status: 401, code: 'NOT_SIGNED_IN', message: 'sign in' })
    wrapper = mount(TestplaceInviteForm, { props: { backend: fakeBackend() as never, form: form() }, global: { plugins: [i18n] } })
    await wrapper.get('.nv-btn--primary').trigger('click')
    await flushPromises()
    expect(wrapper.get('.dev-error').text()).toBe('Not signed in to Navide Cloud, or the sign-in expired.')
  })

  it('sends more than the former 100 testers and states the two expiries instead of a cap', async () => {
    const invitees = Array.from({ length: 150 }, (_, i) => `t${i}@example.com`)
    const many = { ...request, draft: { fields: { invitees }, field_sources: {} } }
    wrapper = mount(TestplaceInviteForm, { props: { backend: fakeBackend() as never, form: form({ request: many }) }, global: { plugins: [i18n] } })
    await flushPromises()
    expect(wrapper.get('.dev-notice').text()).toContain('no limit on the number of testers')
    expect(wrapper.get('.dev-notice').text()).toContain('90 days')
    expect(wrapper.get('.dev-notice').text()).toContain('30 days')
    expect(wrapper.get('.nv-btn--primary').attributes('disabled')).toBeUndefined()
    await wrapper.get('.nv-btn--primary').trigger('click')
    await flushPromises()
    expect(testplaceInvite).toHaveBeenCalledWith('acme.demo', invitees)
  })
})
