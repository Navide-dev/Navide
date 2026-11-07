// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import MarketplaceDeveloperPanel from '../MarketplaceDeveloperPanel.vue'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { closeMarketplaceForm, showMarketplaceForm } from '../../composables/useMarketplaceForms'
import type { PluginApprovalRequest } from '../../../../shared/pluginAgentTools'

const state = {
  registry: 'http://127.0.0.1:8787', signedIn: { account: false, publisher: false }, namespace: null,
  tokenExpiresAt: { account: null, publisher: null }, keyFingerprint: null, keyRegistered: false, keyConflictFingerprint: null,
}

function draft(requester: PluginApprovalRequest['requester']): PluginApprovalRequest {
  return {
    approval_id: 'f1', kind: 'developer-application', owner: 'developer-application:@', requester,
    reason: 'asked by the user', target: { id: '', namespace: '', name: '', version: null, fromVersion: null },
    card: null, diff: null, disabled: null,
    draft: { fields: { legal_name: 'Ada' }, field_sources: { legal_name: 'agent-draft' } },
    status: 'pending', error: null, created_at: 1, expires_at: 9_999_999_999,
  }
}

describe('MarketplaceDeveloperPanel', () => {
  let wrapper: VueWrapper | null = null
  beforeEach(() => {
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { developer: { state: vi.fn(async () => state) } }
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    closeMarketplaceForm()
    delete (window as unknown as { agentTeam?: unknown }).agentTeam
  })

  async function open(requester: PluginApprovalRequest['requester']): Promise<VueWrapper> {
    const request = draft(requester)
    showMarketplaceForm({ form: 'developer-application', origin: 'agent-fill', prefill: {}, requester, request })
    const w = mount(MarketplaceDeveloperPanel, { props: { backend: createMockBackend('connected').backend }, global: { plugins: [i18n] } })
    await flushPromises()
    return w
  }

  it("says so on an agent's form when the pane has external influence (S8-M1)", async () => {
    wrapper = await open({ paneId: 'p', paneName: 'helper', workspace: null, callerKind: 'pane', tainted: true })
    const line = wrapper.find('[data-testid="developer-form-tainted"]')
    expect(line.exists()).toBe(true)
    expect(line.text()).toBe(i18n.global.t('plugin-request.tainted'))
  })

  it('lists the namespaces the Registry took back, with the reason (W2)', async () => {
    ;(window as unknown as { agentTeam: unknown }).agentTeam = {
      developer: {
        state: vi.fn(async () => ({ ...state, signedIn: { account: true, publisher: false } })),
        application: vi.fn(async () => ({
          ok: true, status: 200,
          body: { status: 'rejected', reason: null, fields: {}, namespaces: [
            { namespace: 'acme', frozen_at: '2026-10-20T01:00:00Z', frozen_reason: 'not claimed again within 30 days' },
            { namespace: 'old-tools', frozen_at: null, frozen_reason: null },
          ] },
        })),
        versions: vi.fn(async () => ({ ok: true, status: 200, body: { namespace: null, items: [] } })),
      },
    }
    closeMarketplaceForm()
    wrapper = mount(MarketplaceDeveloperPanel, { props: { backend: createMockBackend('connected').backend }, global: { plugins: [i18n] } })
    await flushPromises()
    const list = wrapper.find('[data-testid="developer-reclaimed-namespaces"]')
    expect(list.exists()).toBe(true)
    expect(list.text()).toContain('acme')
    expect(list.text()).toContain('not claimed again within 30 days')
    expect(list.text()).toContain(i18n.global.t('marketplace-developer.application.reclaimed.no-reason'))
  })

  describe('entry card (plan v2_8714c5 b1)', () => {
    async function mountWith(signedIn: boolean, status: string | null, keyRegistered = false): Promise<VueWrapper> {
      const openExternal = vi.fn().mockResolvedValue({ ok: true })
      ;(window as unknown as { agentTeam: unknown }).agentTeam = {
        openExternal,
        developer: {
          state: vi.fn(async () => ({ ...state, keyRegistered, signedIn: { account: signedIn, publisher: false } })),
          application: vi.fn(async () => ({ ok: true, status: 200, body: { status, reason: null, fields: {} } })),
          versions: vi.fn(async () => ({ ok: true, status: 200, body: { namespace: null, items: [] } })),
        },
      }
      closeMarketplaceForm()
      const w = mount(MarketplaceDeveloperPanel, { props: { backend: createMockBackend('connected').backend }, global: { plugins: [i18n] } })
      await flushPromises()
      return w
    }

    it('lists three steps and opens the guide and the console when signed out', async () => {
      wrapper = await mountWith(false, null)
      const card = wrapper.get('[data-testid="developer-entry"]')
      expect(card.findAll('.dev-entry-steps li')).toHaveLength(3)
      expect(card.text()).toContain('--template vue')
      expect(card.find('[data-testid="developer-entry-next"]').exists()).toBe(false)
      const openExternal = (window as unknown as { agentTeam: { openExternal: ReturnType<typeof vi.fn> } }).agentTeam.openExternal
      await card.get('[data-testid="developer-entry-guide"]').trigger('click')
      await card.get('[data-testid="developer-entry-console"]').trigger('click')
      expect(openExternal.mock.calls).toEqual([
        ['https://github.com/Navide-dev/Navide/blob/main/docs/en-US/build-for-navide.md'],
        ['https://developers.navide.dev/developer'],
      ])
    })

    it.each([
      ['none', false, 'apply'],
      ['rejected', false, 'apply'],
      ['pending', false, 'pending'],
      ['approved', false, 'key'],
      ['approved', true, 'publish'],
    ] as const)('says the next step for an application that is %s (key registered: %s)', async (status, key, step) => {
      wrapper = await mountWith(true, status, key)
      expect(wrapper.get('[data-testid="developer-entry-next"]').text()).toBe(i18n.global.t(`marketplace-developer.entry.next.${step}`))
      expect(wrapper.find('.dev-entry-steps').exists()).toBe(false)
    })

    it('says no next step for a revoked developer', async () => {
      wrapper = await mountWith(true, 'revoked')
      expect(wrapper.find('[data-testid="developer-entry-next"]').exists()).toBe(false)
    })
  })

  it('shows no such line for a clean pane', async () => {
    wrapper = await open({ paneId: 'p', paneName: 'helper', workspace: null, callerKind: 'pane' })
    expect(wrapper.find('[data-testid="developer-form-tainted"]').exists()).toBe(false)
  })
})
