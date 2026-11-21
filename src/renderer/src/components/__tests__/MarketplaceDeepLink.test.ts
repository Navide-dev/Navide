// @vitest-environment happy-dom
// navide://extension/<id> → Marketplace detail page. The link only opens the
// page: nothing is prepared, installed or pre-confirmed (plan decision D4).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import MarketplacePane from '../MarketplacePane.vue'
import {
  marketplaceDetailRequest,
  requestMarketplaceDetail,
} from '../../marketplaceDeepLink'

function detail(namespace: string, name: string) {
  return {
    namespace,
    name,
    identity: `${namespace}.${name}`,
    display_name: `${name} display`,
    description: 'x',
    categories: [],
    latest_version: '1.0.0',
    updated_at: '2026-09-01T00:00:00Z',
    download_count: 0,
    rating_average: 0,
    rating_count: 0,
    featured: false,
    publisher: namespace,
    host_target: 'darwin-arm64',
    latest_installable_version: '1.0.0',
    versions: [
      {
        version: '1.0.0',
        published_at: '2026-09-01T00:00:00Z',
        target: 'universal',
        yanked: false,
        trust_tier: 'unsigned',
        capabilities: ['fs'],
        sensitive_capabilities: ['fs'],
        download_count: 0,
        installable: true,
      },
    ],
    readme: '',
  }
}

function mockPlugins() {
  const api = {
    listInstalled: vi.fn().mockResolvedValue([]),
    listFactoryPackages: vi.fn().mockResolvedValue([]),
    marketplaceSearch: vi.fn().mockResolvedValue({ items: [], total: 0, offset: 0, limit: 20 }),
    marketplaceDetail: vi.fn((args: { namespace: string; name: string }) =>
      Promise.resolve(detail(args.namespace, args.name))
    ),
    prepareInstall: vi.fn(),
    commitInstall: vi.fn(),
    remove: vi.fn(),
    checkUpdates: vi.fn().mockResolvedValue([]),
  }
  ;(window as unknown as Record<string, unknown>).agentTeam = { plugins: api }
  return api
}

describe('Marketplace deep link', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    marketplaceDetailRequest.value = null
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  it('opens the detail page for a link that arrived before the pane mounted', async () => {
    const api = mockPlugins()
    requestMarketplaceDetail({ namespace: 'navide', name: 'git' })
    wrapper = mount(MarketplacePane, { global: { plugins: [i18n] } })
    await flushPromises()

    expect(api.marketplaceDetail).toHaveBeenCalledWith({ namespace: 'navide', name: 'git' })
    expect(wrapper.get('.mkt-detail').attributes('data-detail-id')).toBe('navide.git')
    expect(marketplaceDetailRequest.value).toBeNull()
    // Opening is all a link does.
    expect(api.prepareInstall).not.toHaveBeenCalled()
    expect(api.commitInstall).not.toHaveBeenCalled()
    expect(wrapper.find('.ext-trust-dialog').exists()).toBe(false)
  })

  it('applies the detail answer to a page a link opened, leaving the skeleton (VM 0.2.46 rc2)', async () => {
    // The link hands a plain object, which `selected` holds behind a reactive
    // proxy: the answer must still be taken as the one this page asked for.
    mockPlugins()
    wrapper = mount(MarketplacePane, { global: { plugins: [i18n] } })
    await flushPromises()

    requestMarketplaceDetail({ namespace: 'navide', name: 'git' })
    await flushPromises()
    expect(wrapper.find('.mkt-detail-skeleton').exists()).toBe(false)
    expect(wrapper.get('.mkt-detail-title').text()).toContain('git display')
  })

  it('switches an open pane to the newest link, and re-opens the same one on request', async () => {
    const api = mockPlugins()
    wrapper = mount(MarketplacePane, { global: { plugins: [i18n] } })
    await flushPromises()

    requestMarketplaceDetail({ namespace: 'acme', name: 'one' })
    await flushPromises()
    requestMarketplaceDetail({ namespace: 'acme', name: 'two' })
    await flushPromises()
    expect(wrapper.get('.mkt-detail').attributes('data-detail-id')).toBe('acme.two')

    requestMarketplaceDetail({ namespace: 'acme', name: 'two' })
    await flushPromises()
    expect(api.marketplaceDetail).toHaveBeenCalledTimes(3)
    expect(api.prepareInstall).not.toHaveBeenCalled()
    expect(api.commitInstall).not.toHaveBeenCalled()
  })
})
