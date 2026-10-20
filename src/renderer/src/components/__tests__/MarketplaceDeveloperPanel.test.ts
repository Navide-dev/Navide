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
  tokenExpiresAt: { account: null, publisher: null }, keyFingerprint: null, keyRegistered: false,
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

  it('shows no such line for a clean pane', async () => {
    wrapper = await open({ paneId: 'p', paneName: 'helper', workspace: null, callerKind: 'pane' })
    expect(wrapper.find('[data-testid="developer-form-tainted"]').exists()).toBe(false)
  })
})
