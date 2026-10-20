// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n, useNotify } from '@navide/plugin-ui/foundation'
import TestplacePane from '../TestplacePane.vue'

const signedIn = (account: boolean) => ({
  registry: 'http://127.0.0.1:8787',
  signedIn: { account, publisher: false },
  namespace: null,
  tokenExpiresAt: { account: null, publisher: null },
  keyFingerprint: null,
  keyRegistered: false,
})

const listing = {
  id: 'acme.demo',
  namespace: 'acme',
  name: 'demo',
  displayName: 'Demo',
  description: null,
  publisher: 'acme',
  via: 'code' as const,
  versions: [{ version: '1.1.0', target: 'universal', expiresAt: '2026-10-24T00:00:00Z', installable: true, compatible: true }],
}

function mockApi(overrides: Record<string, unknown> = {}) {
  const plugins = {
    listInstalled: vi.fn().mockResolvedValue([]),
    listFactoryPackages: vi.fn().mockResolvedValue([]),
    checkUpdates: vi.fn().mockResolvedValue([]),
    testplaceList: vi.fn().mockResolvedValue([listing]),
    testplaceJoin: vi.fn().mockResolvedValue({ id: 'acme.demo' }),
    testplaceLeave: vi.fn().mockResolvedValue({ ok: true }),
    prepareInstall: vi.fn().mockResolvedValue({
      id: 'acme.demo', version: '1.1.0', trustTier: 'signed-verified', sensitive: [], containsBackendExecutable: false,
      requiresConfirmation: false, requiresRiskConfirmation: false, requiresPublisherTrust: false, publisherId: 'acme',
      source: 'testplace', expiresAt: '2026-10-24T00:00:00Z', testplaceVia: 'code',
    }),
    commitInstall: vi.fn().mockResolvedValue({ id: 'acme.demo', requires: [], restartRequired: true }),
    ...overrides,
  }
  const developer = { state: vi.fn().mockResolvedValue(signedIn(true)), signIn: vi.fn().mockResolvedValue(signedIn(true)) }
  ;(window as unknown as Record<string, unknown>).agentTeam = { plugins, developer }
  return { plugins, developer }
}

describe('TestplacePane (W5b)', () => {
  let wrapper: VueWrapper | undefined
  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-20T00:00:00Z'))
  })
  afterEach(() => {
    wrapper?.unmount()
    vi.useRealTimers()
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  it('asks for a Navide Cloud sign-in before anything else', async () => {
    const { plugins, developer } = mockApi()
    developer.state.mockResolvedValue(signedIn(false))
    wrapper = mount(TestplacePane, { global: { plugins: [i18n] } })
    await flushPromises()
    expect(wrapper.text()).toContain('To join a test, sign in with your Navide Cloud account first.')
    expect(wrapper.find('#tp-join-code').exists()).toBe(false)
    expect(plugins.testplaceList).not.toHaveBeenCalled()
  })

  it('lists a joined test with how it was joined, its review, expiry and reminder', async () => {
    mockApi()
    wrapper = mount(TestplacePane, { global: { plugins: [i18n] } })
    await flushPromises()
    const card = wrapper.get('[data-testplace-id="acme.demo"]')
    expect(card.text()).toContain('Joined with a public test code')
    expect(card.get('.nv-source-badge').text()).toBe('Test build: the public test code had a light human review; this version had none. Expires 2026-10-24')
    expect(card.text()).toContain('expires in 4 days (2026-10-24)')
  })

  it('joins with what the user pasted and words a refusal', async () => {
    const { plugins } = mockApi({
      testplaceJoin: vi.fn().mockRejectedValue(new Error("Error invoking remote method 'plugins:testplaceJoin': Error: TESTPLACE_ERROR [CODE_FULL]: code is full")),
    })
    wrapper = mount(TestplacePane, { global: { plugins: [i18n] } })
    await flushPromises()
    await wrapper.get('#tp-join-code').setValue('Join my test: tpc_abc')
    await wrapper.get('form.tp-join').trigger('submit')
    await flushPromises()
    expect(plugins.testplaceJoin).toHaveBeenCalledWith('Join my test: tpc_abc')
    expect(wrapper.get('.tp-error').text()).toBe('This public test code is full.')
  })

  it('installs through the trust dialog even when nothing else asks for one, and leaves on confirm', async () => {
    const { plugins } = mockApi()
    wrapper = mount(TestplacePane, { global: { plugins: [i18n] } })
    await flushPromises()
    await wrapper.get('[data-testplace-id="acme.demo"] .nv-btn--primary').trigger('click')
    await flushPromises()
    expect(plugins.prepareInstall).toHaveBeenCalledWith({ namespace: 'acme', name: 'demo', version: '1.1.0', testplace: true })
    // A test build is never installed unseen.
    expect(plugins.commitInstall).not.toHaveBeenCalled()
    expect(wrapper.findComponent({ name: 'PluginTrustDialog' }).exists()).toBe(true)

    await wrapper.get('[data-testplace-id="acme.demo"] .nv-btn--ghost').trigger('click')
    await flushPromises()
    expect(useNotify().dialog.value?.message).toContain('acme.demo')
    useNotify().resolveDialog(true)
    await flushPromises()
    expect(plugins.testplaceLeave).toHaveBeenCalledWith('acme.demo')
  })
})
