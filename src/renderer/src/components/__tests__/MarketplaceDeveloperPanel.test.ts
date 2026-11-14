// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n, useNotify } from '@navide/plugin-ui/foundation'
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

  it('signs in through the Navide Cloud account on opening, and says so (0.2.43 #2b)', async () => {
    const signedIn = { ...state, signedIn: { account: true, publisher: false }, cloudMemberId: 'm_1' }
    const syncCloudAccount = vi.fn(async () => signedIn)
    ;(window as unknown as { agentTeam: unknown }).agentTeam = {
      developer: {
        syncCloudAccount,
        state: vi.fn(async () => signedIn),
        application: vi.fn(async () => ({ ok: false, status: 404, code: null, message: '' })),
        versions: vi.fn(async () => ({ ok: true, status: 200, body: { items: [] } })),
      },
    }
    closeMarketplaceForm()
    wrapper = mount(MarketplaceDeveloperPanel, { props: { backend: createMockBackend('connected').backend }, global: { plugins: [i18n] } })
    await flushPromises()
    expect(syncCloudAccount).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="developer-via-cloud"]').text()).toBe(i18n.global.t('marketplace-developer.account.via-cloud'))
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

  describe('namespace members (0.2.40)', () => {
    const owner = { member_id: 'mem-owner', role: 'owner', added_at: null }
    const publisher = { member_id: 'mem-pub', role: 'publisher', added_at: '2026-11-10T05:00:00+00:00' }

    async function mountAs(role: 'owner' | 'publisher', api: Record<string, unknown> = {}): Promise<VueWrapper> {
      ;(window as unknown as { agentTeam: unknown }).agentTeam = {
        developer: {
          state: vi.fn(async () => ({
            ...state, namespace: 'acme', signedIn: { account: false, publisher: true },
            keyFingerprint: 'sha256:navide', keyConflictFingerprint: 'sha256:owner',
          })),
          application: vi.fn(async () => ({ ok: true, status: 200, body: { status: 'approved', reason: null, fields: {} } })),
          versions: vi.fn(async () => ({ ok: true, status: 200, body: { namespace: 'acme', items: [] } })),
          members: vi.fn(async () => ({ ok: true, status: 200, body: { your_role: role, items: [owner, publisher] } })),
          ...api,
        },
      }
      closeMarketplaceForm()
      const w = mount(MarketplaceDeveloperPanel, { props: { backend: createMockBackend('connected').backend }, global: { plugins: [i18n] } })
      await flushPromises()
      return w
    }

    it('lists the owner and publishers with their roles', async () => {
      wrapper = await mountAs('owner')
      const rows = wrapper.findAll('[data-testid="developer-member-row"]')
      expect(rows.map((row) => row.text())).toEqual([
        expect.stringContaining(i18n.global.t('marketplace-developer.members.roles.owner')),
        expect.stringContaining(i18n.global.t('marketplace-developer.members.roles.publisher')),
      ])
      expect(rows[0].find('[data-testid="developer-member-remove"]').exists()).toBe(false)
      expect(rows[1].find('[data-testid="developer-member-remove"]').exists()).toBe(true)
    })

    it('shows the added date localized, not the raw ISO string', async () => {
      wrapper = await mountAs('owner')
      const cells = wrapper.findAll('[data-testid="developer-member-row"]')[1].findAll('td')
      expect(cells[2].text()).toBe(new Date(publisher.added_at).toLocaleDateString())
      expect(cells[2].text()).not.toContain('T05:00')
    })

    it('formats the added date in the Navide language, not the system one', async () => {
      const previous = i18n.global.locale.value
      i18n.global.locale.value = 'zh-TW'
      try {
        wrapper = await mountAs('owner')
        const cells = wrapper.findAll('[data-testid="developer-member-row"]')[1].findAll('td')
        expect(cells[2].text()).toBe(new Date(publisher.added_at).toLocaleDateString('zh-TW'))
      } finally {
        i18n.global.locale.value = previous
      }
    })

    it('adds a publisher only after the user confirms', async () => {
      const addMember = vi.fn(async () => ({ ok: true, status: 201, body: { your_role: 'owner', items: [owner, publisher] } }))
      wrapper = await mountAs('owner', { addMember })
      await wrapper.get('[data-testid="developer-member-id"]').setValue(' mem-new ')
      await wrapper.get('[data-testid="developer-member-add"]').trigger('click')
      await flushPromises()
      expect(addMember).not.toHaveBeenCalled()
      useNotify().resolveDialog(true)
      await flushPromises()
      expect(addMember).toHaveBeenCalledWith({ memberId: 'mem-new' })
    })

    it('does nothing when the user cancels a removal', async () => {
      const removeMember = vi.fn()
      wrapper = await mountAs('owner', { removeMember })
      await wrapper.get('[data-testid="developer-member-remove"]').trigger('click')
      await flushPromises()
      useNotify().resolveDialog(false)
      await flushPromises()
      expect(removeMember).not.toHaveBeenCalled()
    })

    it("shows a publisher the list without the owner's controls or the key replacement", async () => {
      wrapper = await mountAs('publisher')
      expect(wrapper.findAll('[data-testid="developer-member-row"]')).toHaveLength(2)
      expect(wrapper.find('[data-testid="developer-member-remove"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="developer-member-add"]').exists()).toBe(false)
      expect(wrapper.text()).toContain(i18n.global.t('marketplace-developer.members.publisher-note'))
      expect(wrapper.text()).not.toContain(i18n.global.t('marketplace-developer.account.replace-key'))
    })
  })

  describe('Testplace section and documentation links (0.2.40 a4, c3)', () => {
    const owner = { member_id: 'mem-owner', role: 'owner', added_at: null }

    async function mountWith(role: 'owner' | 'publisher' | null, api: Record<string, unknown> = {}): Promise<VueWrapper> {
      const openExternal = vi.fn().mockResolvedValue({ ok: true })
      ;(window as unknown as { agentTeam: unknown }).agentTeam = {
        openExternal,
        developer: {
          state: vi.fn(async () => ({ ...state, namespace: 'acme', signedIn: { account: true, publisher: role !== null } })),
          application: vi.fn(async () => ({ ok: true, status: 200, body: { status: 'approved', reason: null, fields: {} } })),
          versions: vi.fn(async () => ({ ok: true, status: 200, body: { namespace: 'acme', items: [] } })),
          members: vi.fn(async () => ({ ok: true, status: 200, body: { your_role: role, items: [owner] } })),
          ...api,
        },
      }
      closeMarketplaceForm()
      const w = mount(MarketplaceDeveloperPanel, { props: { backend: createMockBackend('connected').backend }, global: { plugins: [i18n] } })
      await flushPromises()
      return w
    }

    function openExternalMock(): ReturnType<typeof vi.fn> {
      return (window as unknown as { agentTeam: { openExternal: ReturnType<typeof vi.fn> } }).agentTeam.openExternal
    }

    it('explains the channel, invites, codes and owner-only rule, and gathers the Testplace actions', async () => {
      wrapper = await mountWith('owner')
      const section = wrapper.get('[data-testid="developer-testplace"]')
      expect(section.text()).toContain('--channel testplace')
      expect(section.text()).toContain('?channel=testplace')
      expect(section.text()).toContain('testplace code create')
      expect(section.get('[data-testid="developer-testplace-owner"]').text()).toBe(i18n.global.t('marketplace-developer.testplace.owner-only'))
      await section.get('[data-testid="developer-testplace-invite"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-testid="developer-testplace"]').exists()).toBe(true)
      await section.get('[data-testid="developer-testplace-doc"]').trigger('click')
      expect(openExternalMock()).toHaveBeenCalledWith(
        'https://github.com/Navide-dev/Navide/blob/main/docs/en-US/marketplace-publishing.md#testplace')
    })

    it('tells a publisher member that Testplace is the owner\'s', async () => {
      wrapper = await mountWith('publisher')
      expect(wrapper.get('[data-testid="developer-testplace-owner"]').text())
        .toBe(i18n.global.t('marketplace-developer.testplace.owner-only-member'))
    })

    it('shows View Documentation for a Registry error that names its doc, and clears it with the error', async () => {
      const doc = 'https://github.com/Navide-dev/Navide/blob/main/docs/en-US/marketplace-publishing.md#4-publish-to-the-marketplace'
      const addMember = vi.fn(async () => ({ ok: false, status: 400, code: 'BAD_MEMBER', message: 'no such account', doc }))
      wrapper = await mountWith('owner', { addMember })
      await wrapper.get('[data-testid="developer-member-id"]').setValue('mem-x')
      await wrapper.get('[data-testid="developer-member-add"]').trigger('click')
      await flushPromises()
      useNotify().resolveDialog(true)
      await flushPromises()
      const link = wrapper.get('[data-testid="developer-error-doc"]')
      expect(link.text()).toBe(i18n.global.t('marketplace-developer.error.doc'))
      await link.trigger('click')
      expect(openExternalMock()).toHaveBeenCalledWith(doc)
      addMember.mockResolvedValueOnce({ ok: false, status: 400, code: 'BAD_MEMBER', message: 'again', doc: null } as never)
      await wrapper.get('[data-testid="developer-member-add"]').trigger('click')
      await flushPromises()
      useNotify().resolveDialog(true)
      await flushPromises()
      expect(wrapper.find('[data-testid="developer-error-doc"]').exists()).toBe(false)
    })
  })
})
