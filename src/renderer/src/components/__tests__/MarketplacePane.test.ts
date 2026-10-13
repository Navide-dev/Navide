// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { i18n, useNotify } from '@navide/plugin-ui/foundation'
import SettingsNavItem from '../settings/SettingsNavItem.vue'
import { usePluginUpdates } from '../../composables/usePluginUpdates'
import MarketplacePane from '../MarketplacePane.vue'
import MarketplaceIcon from '../MarketplaceIcon.vue'
import ExtensionsPane from '../ExtensionsPane.vue'

function mountMarketplace() {
  return mount(MarketplacePane, { global: { plugins: [i18n] } })
}

/** Both plugin pages at once, the way the settings modal keeps them mounted. */
const PluginPages = defineComponent({
  setup() {
    return () => h('div', [h(MarketplacePane), h(ExtensionsPane)])
  },
})

function demoDetail(overrides: Record<string, unknown> = {}) {
  return {
    namespace: 'acme',
    name: 'demo',
    identity: 'acme.demo',
    display_name: 'Demo',
    description: 'A demo extension',
    categories: ['tools'],
    latest_version: '1.1.0',
    updated_at: '2026-09-01T00:00:00Z',
    download_count: 42,
    rating_average: 4.5,
    rating_count: 2,
    featured: false,
    publisher: 'acme',
    host_target: 'darwin-arm64',
    latest_installable_version: '1.1.0',
    versions: [
      {
        version: '1.1.0',
        published_at: '2026-09-01T00:00:00Z',
        target: 'universal',
        yanked: false,
        trust_tier: 'signed-verified',
        capabilities: ['fs', 'ui'],
        sensitive_capabilities: ['fs'],
        download_count: 40,
        installable: true,
      },
      {
        version: '1.0.0',
        published_at: '2026-08-01T00:00:00Z',
        target: 'universal',
        yanked: true,
        trust_tier: 'signed-verified',
        capabilities: [],
        sensitive_capabilities: [],
        download_count: 2,
        installable: true,
      },
    ],
    readme: '# Demo\n\nHello **world**.\n\n<script>window.__pwned = 1</script>\n<img src=x onerror="window.__pwned = 2">',
    ...overrides,
  }
}

function mockPlugins(overrides: Record<string, unknown> = {}) {
  const api = {
    listInstalled: vi.fn().mockResolvedValue([]),
    listFactoryPackages: vi.fn().mockResolvedValue([]),
    restoreFactoryPackage: vi.fn().mockResolvedValue({ ok: true }),
    marketplaceSearch: vi.fn().mockResolvedValue({
      items: [
        {
          namespace: 'acme',
          name: 'demo',
          identity: 'acme.demo',
          display_name: 'Demo',
          description: null,
          categories: [],
          latest_version: '1.0.0',
          download_count: 0,
          rating_average: 0,
          featured: false,
        },
      ],
      total: 1,
      offset: 0,
      limit: 20,
    }),
    prepareInstall: vi
      .fn()
      .mockResolvedValue({
        id: 'acme.demo',
        version: '1.0.0',
        trustTier: 'unsigned',
        sensitive: [],
        containsBackendExecutable: false,
        requiresConfirmation: false,
      }),
    commitInstall: vi.fn().mockResolvedValue({ id: 'acme.demo', requires: [] }),
    remove: vi.fn().mockResolvedValue({ ok: true }),
    checkUpdates: vi.fn().mockResolvedValue([]),
    marketplaceDetail: vi.fn().mockResolvedValue(demoDetail()),
    marketplaceCategories: vi.fn().mockResolvedValue([]),
    marketplaceIcon: vi.fn().mockResolvedValue(null),
    marketplaceChangelog: vi.fn().mockResolvedValue(null),
    setPrerelease: vi.fn().mockResolvedValue({ id: '', enabled: false }),
    marketplacePackMembers: vi.fn().mockResolvedValue([]),
    preparePack: vi.fn(),
    finishPack: vi.fn().mockResolvedValue({ recorded: false }),
    ...overrides,
  }
  ;(window as unknown as Record<string, unknown>).agentTeam = { plugins: api }
  return api
}

describe('MarketplacePane', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  it('searches the marketplace and installs a non-sensitive plugin directly', async () => {
    const api = mockPlugins()
    wrapper = mountMarketplace()
    await flushPromises()

    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-id="acme.demo"]').text()).toContain('Demo')

    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()
    expect(api.prepareInstall).toHaveBeenCalledWith({ namespace: 'acme', name: 'demo' })
    // Non-sensitive → commit runs without a confirmation dialog.
    expect(api.commitInstall).toHaveBeenCalledWith('acme.demo', {})
    expect(wrapper.find('.ext-trust-dialog').exists()).toBe(false)
  })

  it('shows a committed install in the Extensions inventory without remounting it', async () => {
    // The two pages are separate components; the inventory they read is not.
    // Before the split this was free — one component held both lists — so this
    // is the case that would silently break: install succeeds, no error, and
    // the Extensions page still shows "No extensions installed".
    // Both pages refresh the inventory on mount, so model the install itself
    // rather than counting listInstalled calls.
    let committed = false
    const api = mockPlugins({
      listInstalled: vi.fn(async () =>
        committed ? [{ id: 'acme.demo', requires: [], sensitive: [] }] : []
      ),
      commitInstall: vi.fn(async () => {
        committed = true
        return { id: 'acme.demo', requires: [] }
      }),
    })
    wrapper = mount(PluginPages, { global: { plugins: [i18n] } })
    await flushPromises()
    // The Marketplace now lists on mount, so scope to the Extensions page.
    expect(wrapper.find('.extensions-pane [data-id="acme.demo"]').exists()).toBe(false)
    expect(wrapper.get('.ext-empty').text()).toContain('No Navide plugins installed')

    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()
    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()

    expect(api.commitInstall).toHaveBeenCalledWith('acme.demo', {})
    expect(wrapper.get('.extensions-pane [data-id="acme.demo"]').text()).toContain('acme.demo')
    expect(wrapper.find('.ext-empty').exists()).toBe(false)
  })

  it('gates a sensitive install behind a trust confirmation dialog', async () => {
    const api = mockPlugins({
      prepareInstall: vi.fn().mockResolvedValue({
        id: 'acme.demo',
        version: '1.0.0',
        trustTier: 'unsigned',
        sensitive: ['fs'],
        containsBackendExecutable: false,
        requiresConfirmation: true,
      }),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()

    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()
    // Dialog is shown and nothing is committed yet.
    expect(wrapper.find('.ext-trust-dialog').exists()).toBe(true)
    expect(api.commitInstall).not.toHaveBeenCalled()

    await wrapper.get('.ext-confirm-risk').trigger('click')
    await flushPromises()
    expect(api.commitInstall).toHaveBeenCalledWith('acme.demo', {
      publisherConfirmed: false,
      riskConfirmed: true,
    })
    expect(wrapper.find('.ext-trust-dialog').exists()).toBe(false)
  })

  it('keeps publisher consent separate from capability and backend risk approval', async () => {
    const api = mockPlugins({
      prepareInstall: vi.fn().mockResolvedValue({
        id: 'acme.demo',
        version: '1.0.0',
        publisherId: 'acme',
        trustTier: 'signed-verified',
        sensitive: ['fs'],
        containsBackendExecutable: false,
        requiresConfirmation: true,
        requiresPublisherTrust: true,
        requiresRiskConfirmation: true,
      }),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()
    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()

    expect(wrapper.get('.ext-publisher-risk').text()).toContain('acme')
    expect(api.commitInstall).not.toHaveBeenCalled()
    await wrapper.get('.ext-confirm-publisher').trigger('click')
    await flushPromises()
    expect(wrapper.find('.ext-backend-risk').exists()).toBe(false)
    // The risk step lists the sensitive capabilities under a heading.
    expect(wrapper.get('.ext-cap-heading').text()).toBe('Sensitive capabilities')
    expect(api.commitInstall).not.toHaveBeenCalled()

    await wrapper.get('.ext-confirm-risk').trigger('click')
    await flushPromises()
    expect(api.commitInstall).toHaveBeenCalledWith('acme.demo', {
      publisherConfirmed: true,
      riskConfirmed: true,
    })
  })

  it('shows an unsigned warning (never a verified badge) for an unsigned install', async () => {
    mockPlugins({
      prepareInstall: vi.fn().mockResolvedValue({
        id: 'acme.demo',
        version: '1.0.0',
        trustTier: 'unsigned',
        sensitive: ['fs'],
        containsBackendExecutable: false,
        requiresConfirmation: true,
      }),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()
    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()

    const dialog = wrapper.get('.ext-trust-dialog')
    // Unsigned must surface the unsigned/unverified badge and NEVER the verified one.
    expect(dialog.find('.ext-unsigned').exists()).toBe(true)
    expect(dialog.find('.ext-verified').exists()).toBe(false)
    expect(dialog.find('.ext-unsigned').text()).toContain('not cryptographically verified')
  })

  it('shows a verified badge only for a signed-verified install', async () => {
    mockPlugins({
      prepareInstall: vi.fn().mockResolvedValue({
        id: 'acme.demo',
        version: '1.0.0',
        trustTier: 'signed-verified',
        sensitive: ['fs'],
        containsBackendExecutable: false,
        requiresConfirmation: true,
      }),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()
    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()

    const dialog = wrapper.get('.ext-trust-dialog')
    expect(dialog.find('.ext-verified').exists()).toBe(true)
    expect(dialog.find('.ext-unsigned').exists()).toBe(false)
  })

  it('Escape cancels the trust dialog without closing Settings', async () => {
    const api = mockPlugins({
      prepareInstall: vi.fn().mockResolvedValue({
        id: 'acme.demo',
        version: '1.0.0',
        trustTier: 'signed-verified',
        sensitive: ['fs'],
        containsBackendExecutable: false,
        requiresConfirmation: true,
        requiresRiskConfirmation: true,
        publisherId: 'acme',
        requiresPublisherTrust: false,
      }),
    })
    const settingsClose = vi.fn()
    const settingsEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) settingsClose()
    }
    window.addEventListener('keydown', settingsEsc)
    try {
      wrapper = mountMarketplace()
      await flushPromises()
      await wrapper.get('.ext-install').trigger('click')
      await flushPromises()
      expect(wrapper.find('.ext-trust-dialog').exists()).toBe(true)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
      await flushPromises()
      expect(settingsClose).not.toHaveBeenCalled()
      expect(wrapper.find('.ext-trust-dialog').exists()).toBe(false)
      expect(api.commitInstall).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', settingsEsc)
    }
  })

  it('cancelling the trust dialog does not install', async () => {
    const api = mockPlugins({
      prepareInstall: vi.fn().mockResolvedValue({
        id: 'acme.demo',
        version: '1.0.0',
        trustTier: 'unsigned',
        sensitive: ['fs'],
        containsBackendExecutable: false,
        requiresConfirmation: true,
      }),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()
    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()

    await wrapper.get('.ext-cancel').trigger('click')
    await flushPromises()
    expect(api.commitInstall).not.toHaveBeenCalled()
    expect(wrapper.find('.ext-trust-dialog').exists()).toBe(false)
  })

  it('warns about a backend executable even when permissions are empty', async () => {
    const api = mockPlugins({
      prepareInstall: vi.fn().mockResolvedValue({
        id: 'acme.demo',
        version: '1.0.0',
        trustTier: 'signed-verified',
        sensitive: [],
        containsBackendExecutable: true,
        requiresConfirmation: true,
      }),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()
    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()

    const dialog = wrapper.get('.ext-trust-dialog')
    expect(dialog.get('.ext-backend-risk').text()).toContain('native backend executable')
    expect(dialog.text()).not.toContain('requests sensitive capabilities')
    expect(api.commitInstall).not.toHaveBeenCalled()

    await dialog.get('.ext-confirm-risk').trigger('click')
    await flushPromises()
    expect(api.commitInstall).toHaveBeenCalledWith('acme.demo', {
      publisherConfirmed: false,
      riskConfirmed: true,
    })
  })

  it('loads a default listing on mount, sorted by downloads, with a loading state first', async () => {
    let resolveSearch!: (value: unknown) => void
    const api = mockPlugins({
      marketplaceSearch: vi.fn().mockReturnValue(new Promise((resolve) => (resolveSearch = resolve))),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    expect(wrapper.find('.mkt-loading').exists()).toBe(true)
    expect(api.marketplaceSearch).toHaveBeenCalledWith(undefined, 'downloads', {
      offset: 0,
      limit: 20,
      hideIncompatible: false,
    })

    resolveSearch({ items: [], total: 0, offset: 0, limit: 20 })
    await flushPromises()
    expect(wrapper.find('.mkt-loading').exists()).toBe(false)
    expect(wrapper.get('.mkt-empty').text()).toContain('No Navide plugins are published yet')
  })

  it('shows the actual registry error when the listing fails', async () => {
    mockPlugins({
      marketplaceSearch: vi
        .fn()
        .mockRejectedValueOnce(
          new Error(
            "Error invoking remote method 'plugins:marketplaceSearch': Error: marketplace search failed: HTTP 502"
          )
        )
        .mockResolvedValue({ items: [], total: 0, offset: 0, limit: 20 }),
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    wrapper = mountMarketplace()
    await flushPromises()
    const error = wrapper.get('.mkt-list-error')
    expect(error.attributes('role')).toBe('alert')
    expect(error.text()).toContain('marketplace search failed: HTTP 502')
    // Electron's wrapper is logged, not shown.
    expect(error.text()).not.toContain('Error invoking remote method')
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Error invoking remote method'))

    await error.get('.mkt-retry').trigger('click')
    await flushPromises()
    expect(wrapper.find('.mkt-list-error').exists()).toBe(false)
    expect(wrapper.find('.mkt-empty').exists()).toBe(true)
    consoleError.mockRestore()
  })

  it('says nothing matched a query rather than showing a blank list', async () => {
    mockPlugins({
      marketplaceSearch: vi.fn().mockResolvedValue({ items: [], total: 0, offset: 0, limit: 20 }),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('.ext-search input').setValue('zzz')
    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()
    expect(wrapper.get('.mkt-empty').text()).toContain('zzz')
  })

  it('marks installed items and offers Update only when the main process reports one', async () => {
    const api = mockPlugins({
      marketplaceSearch: vi.fn().mockResolvedValue({
        items: [
          { ...demoDetail(), identity: 'acme.demo' },
          { ...demoDetail(), name: 'other', identity: 'acme.other', display_name: 'Other' },
          { ...demoDetail(), name: 'fresh', identity: 'acme.fresh', display_name: 'Fresh' },
        ],
        total: 3,
        offset: 0,
        limit: 20,
      }),
      listInstalled: vi.fn().mockResolvedValue([
        { id: 'acme.demo', requires: [], sensitive: [], packageVersion: '1.0.0', provenance: 'official-registry' },
        { id: 'acme.other', requires: [], sensitive: [], packageVersion: '1.1.0', provenance: 'official-registry' },
      ]),
      checkUpdates: vi.fn().mockResolvedValue([
        { id: 'acme.demo', namespace: 'acme', name: 'demo', installedVersion: '1.0.0', latestVersion: '1.1.0' },
      ]),
    })
    wrapper = mountMarketplace()
    await flushPromises()

    const demo = wrapper.get('[data-id="acme.demo"]')
    expect(demo.find('.ext-update-badge').exists()).toBe(true)
    expect(demo.find('.ext-install').exists()).toBe(false)
    const other = wrapper.get('[data-id="acme.other"]')
    expect(other.find('.ext-installed-badge').exists()).toBe(true)
    expect(other.find('.ext-update').exists()).toBe(false)
    expect(other.find('.ext-install').exists()).toBe(false)
    expect(wrapper.get('[data-id="acme.fresh"]').find('.ext-install').exists()).toBe(true)

    await demo.get('.ext-update').trigger('click')
    await flushPromises()
    // Update pins the newest version the main process found installable here.
    expect(api.prepareInstall).toHaveBeenCalledWith({ namespace: 'acme', name: 'demo', version: '1.1.0' })
    expect(api.commitInstall).toHaveBeenCalledWith('acme.demo', {})
    // The button does not also open the detail view.
    expect(api.marketplaceDetail).not.toHaveBeenCalled()
    // Committing re-checks updates so the badge can clear.
    expect(api.checkUpdates).toHaveBeenCalledTimes(2)
  })

  it('opens a detail view with README, permissions and versions, rendering README as text only', async () => {
    const api = mockPlugins()
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('[data-id="acme.demo"]').trigger('click')
    await flushPromises()

    expect(api.marketplaceDetail).toHaveBeenCalledWith({ namespace: 'acme', name: 'demo' })
    const view = wrapper.get('[data-detail-id="acme.demo"]')
    expect(view.text()).toContain('Publisher')
    expect(view.text()).toContain('42 downloads')
    expect(view.text()).toContain('Version 1.1.0')
    expect(view.text()).toContain('4.5')
    // A first heading that only repeats the extension name is left out.
    expect(view.find('.mkt-readme h3').exists()).toBe(false)
    expect(view.get('.mkt-readme strong').text()).toBe('world')
    // Raw HTML in a README stays inert text — no element is created from it.
    expect(view.find('.mkt-readme script').exists()).toBe(false)
    expect(view.find('.mkt-readme img').exists()).toBe(false)
    expect(view.get('.mkt-readme').text()).toContain('<script>')
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined()
    // Permissions of the latest version, sensitive ones flagged.
    expect(view.findAll('.mkt-cap').map((c) => c.text())).toEqual([
      expect.stringContaining('fs'),
      'ui',
    ])
    expect(view.get('.mkt-cap--sensitive').text()).toContain('fs')
    // The same chips as the pack detail: every permission, sensitive ones highlighted.
    expect(view.findAll('.mkt-caps .mkt-pack-cap').map((c) => c.text())).toEqual(['fs · sensitive', 'ui'])
    expect(view.findAll('.mkt-caps .mkt-pack-cap--sensitive')).toHaveLength(1)
    expect(view.findAll('.mkt-versions tbody tr')).toHaveLength(2)
    expect(view.get('.mkt-yanked').text()).toContain('1.0.0')

    await view.get('.ext-install').trigger('click')
    await flushPromises()
    expect(api.prepareInstall).toHaveBeenCalledWith({ namespace: 'acme', name: 'demo', version: '1.1.0' })
    expect(api.commitInstall).toHaveBeenCalledWith('acme.demo', {})

    await wrapper.get('.mkt-back').trigger('click')
    expect(wrapper.find('[data-detail-id]').exists()).toBe(false)
    expect(wrapper.find('[data-id="acme.demo"]').exists()).toBe(true)
  })

  it('offers update and uninstall in the detail view of an installed extension', async () => {
    const api = mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        { id: 'acme.demo', requires: [], sensitive: [], packageVersion: '1.0.0', provenance: 'official-registry' },
      ]),
      checkUpdates: vi.fn().mockResolvedValue([
        { id: 'acme.demo', namespace: 'acme', name: 'demo', installedVersion: '1.0.0', latestVersion: '1.1.0' },
      ]),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('[data-id="acme.demo"]').trigger('click')
    await flushPromises()

    const view = wrapper.get('[data-detail-id="acme.demo"]')
    expect(view.get('.mkt-installed').text()).toContain('1.0.0')
    expect(view.get('.ext-update').text()).toContain('1.1.0')
    expect(view.find('.ext-install').exists()).toBe(false)

    // Cancel keeps the plugin…
    await view.get('.ext-uninstall').trigger('click')
    await flushPromises()
    expect(useNotify().dialog.value?.kind).toBe('confirm')
    expect(useNotify().dialog.value?.danger).toBe(true)
    useNotify().resolveDialog(false)
    await flushPromises()
    expect(api.remove).not.toHaveBeenCalled()

    // …confirming removes it.
    await view.get('.ext-uninstall').trigger('click')
    await flushPromises()
    useNotify().resolveDialog(true)
    await flushPromises()
    expect(api.remove).toHaveBeenCalledWith('acme.demo')
  })

  it('shows the detail error and a README fallback', async () => {
    mockPlugins({
      marketplaceDetail: vi
        .fn()
        .mockRejectedValueOnce(new Error('marketplace detail failed: HTTP 404'))
        .mockResolvedValue(demoDetail({ readme: null })),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('[data-id="acme.demo"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('.mkt-detail-error').text()).toContain('HTTP 404')

    await wrapper.get('.mkt-back').trigger('click')
    await wrapper.get('[data-id="acme.demo"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('.mkt-no-readme').text()).toContain('no README')
  })

  it('offers Update on the Extensions page and routes it through the trust dialog', async () => {
    const api = mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        { id: 'acme.demo', requires: [], sensitive: [], packageVersion: '1.0.0', provenance: 'official-registry' },
      ]),
      checkUpdates: vi.fn().mockResolvedValue([
        { id: 'acme.demo', namespace: 'acme', name: 'demo', installedVersion: '1.0.0', latestVersion: '1.1.0' },
      ]),
      prepareInstall: vi.fn().mockResolvedValue({
        id: 'acme.demo',
        version: '1.1.0',
        trustTier: 'signed-verified',
        sensitive: ['fs'],
        containsBackendExecutable: false,
        requiresConfirmation: true,
      }),
    })
    wrapper = mount(ExtensionsPane, { global: { plugins: [i18n] } })
    await flushPromises()
    const row = wrapper.get('[data-id="acme.demo"]')
    expect(row.get('.ext-update-badge').text()).toContain('1.1.0')

    await row.get('.ext-update').trigger('click')
    await flushPromises()
    expect(api.prepareInstall).toHaveBeenCalledWith({ namespace: 'acme', name: 'demo', version: '1.1.0' })
    expect(api.commitInstall).not.toHaveBeenCalled()
    await wrapper.get('.ext-trust-dialog .ext-confirm-risk').trigger('click')
    await flushPromises()
    expect(api.commitInstall).toHaveBeenCalledWith('acme.demo', {
      publisherConfirmed: false,
      riskConfirmed: true,
    })
  })

  it('marks a listing the main process found not installable here and offers no Install', async () => {
    mockPlugins({
      marketplaceSearch: vi.fn().mockResolvedValue({
        items: [{ ...demoDetail(), latest_targets: ['win32-x64'], installable: false }],
        total: 1,
        offset: 0,
        limit: 20,
      }),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    const row = wrapper.get('[data-id="acme.demo"]')
    expect(row.get('.ext-unavailable-badge').text()).toContain('Not available for this platform')
    expect(row.find('.ext-install').exists()).toBe(false)
  })

  it('does not pick another platform\'s row as the install target in the detail view', async () => {
    const api = mockPlugins({
      marketplaceDetail: vi.fn().mockResolvedValue(
        demoDetail({
          latest_version: '2.0.0',
          latest_installable_version: '1.1.0',
          versions: [
            {
              version: '2.0.0',
              published_at: '2026-09-10T00:00:00Z',
              target: 'win32-x64',
              yanked: false,
              trust_tier: 'signed-verified',
              capabilities: ['shell'],
              sensitive_capabilities: ['shell'],
              download_count: 1,
              installable: false,
            },
            {
              version: '1.1.0',
              published_at: '2026-09-01T00:00:00Z',
              target: 'universal',
              yanked: false,
              trust_tier: 'signed-verified',
              capabilities: ['ui'],
              sensitive_capabilities: [],
              download_count: 3,
              installable: true,
            },
          ],
        })
      ),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('[data-id="acme.demo"]').trigger('click')
    await flushPromises()

    const view = wrapper.get('[data-detail-id="acme.demo"]')
    expect(view.get('.mkt-unavailable').text()).toContain('2.0.0')
    expect(view.get('.mkt-unavailable').text()).toContain('darwin-arm64')
    expect(view.get('.mkt-unavailable').text()).toContain('win32-x64')
    // Permissions describe what would actually be installed.
    expect(view.findAll('.mkt-cap').map((c) => c.text())).toEqual(['ui'])
    expect(view.get('.mkt-other-target').text()).toContain('Not for this platform (win32-x64)')
    // The button names the version it installs when it is not the header's.
    expect(view.get('.ext-install').text()).toBe('Install 1.1.0')
    await view.get('.ext-install').trigger('click')
    await flushPromises()
    expect(api.prepareInstall).toHaveBeenCalledWith({ namespace: 'acme', name: 'demo', version: '1.1.0' })
  })

  it('offers no Install in the detail view when no version targets this platform', async () => {
    mockPlugins({
      marketplaceDetail: vi.fn().mockResolvedValue(
        demoDetail({
          latest_installable_version: null,
          versions: [
            {
              version: '1.1.0',
              published_at: '2026-09-01T00:00:00Z',
              target: 'linux-x64',
              yanked: false,
              trust_tier: 'signed-verified',
              capabilities: [],
              sensitive_capabilities: [],
              download_count: 1,
              installable: false,
            },
          ],
        })
      ),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('[data-id="acme.demo"]').trigger('click')
    await flushPromises()
    const view = wrapper.get('[data-detail-id="acme.demo"]')
    expect(view.find('.ext-install').exists()).toBe(false)
    expect(view.get('.mkt-unavailable').text()).toContain('linux-x64')
  })

  it('propagates pushed update counts to the nav badge and the Extensions page', async () => {
    let push!: (updates: unknown[]) => void
    const update = { id: 'acme.demo', namespace: 'acme', name: 'demo', installedVersion: '1.0.0', latestVersion: '1.1.0' }
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        { id: 'acme.demo', requires: [], sensitive: [], packageVersion: '1.0.0', provenance: 'official-registry' },
      ]),
      // The page's own check fails; the pushed answer still shows.
      checkUpdates: vi.fn().mockRejectedValue(new Error('offline')),
      pendingUpdates: vi.fn().mockResolvedValue([]),
      onUpdatesChanged: vi.fn((handler: (updates: unknown[]) => void) => {
        push = handler
        return () => {}
      }),
    })
    const pluginUpdates = usePluginUpdates()
    const stop = pluginUpdates.subscribe()
    const Host = defineComponent({
      setup() {
        return () =>
          h('div', [
            h(SettingsNavItem, { label: 'Extensions', badge: pluginUpdates.count.value }),
            h(ExtensionsPane),
          ])
      },
    })
    wrapper = mount(Host, { global: { plugins: [i18n] } })
    await flushPromises()
    expect(wrapper.find('.settings-nav-item-badge').exists()).toBe(false)
    expect(wrapper.find('.ext-updates-summary').exists()).toBe(false)

    push([update])
    await flushPromises()
    expect(wrapper.get('.settings-nav-item-badge').text()).toBe('1')
    expect(wrapper.get('.ext-updates-summary').text()).toContain('1')
    expect(wrapper.find('[data-id="acme.demo"] .ext-update').exists()).toBe(true)

    push([])
    await flushPromises()
    expect(wrapper.find('.settings-nav-item-badge').exists()).toBe(false)
    stop()
  })

  it('seeds the count from the main process cache on subscribe', async () => {
    mockPlugins({
      pendingUpdates: vi.fn().mockResolvedValue([
        { id: 'acme.demo', namespace: 'acme', name: 'demo', installedVersion: '1.0.0', latestVersion: '1.1.0' },
        { id: 'acme.two', namespace: 'acme', name: 'two', installedVersion: '1.0.0', latestVersion: '2.0.0' },
      ]),
      onUpdatesChanged: vi.fn(() => () => {}),
    })
    const pluginUpdates = usePluginUpdates()
    const stop = pluginUpdates.subscribe()
    await flushPromises()
    expect(pluginUpdates.count.value).toBe(2)
    stop()
  })

  it('formats counts with the app locale and shows the rating on list cards', async () => {
    mockPlugins({
      marketplaceSearch: vi.fn().mockResolvedValue({
        items: [{ ...demoDetail(), download_count: 18234, rating_average: 4.66 }],
        total: 1,
        offset: 0,
        limit: 20,
      }),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    const row = wrapper.get('[data-id="acme.demo"]')
    expect(row.text()).toContain('18,234 downloads')
    expect(row.get('.mkt-card-rating').text()).toBe('★ 4.7')
  })

  function listing(identity: string, overrides: Record<string, unknown> = {}) {
    const [namespace, name] = identity.split('.')
    return {
      namespace,
      name,
      identity,
      display_name: name,
      description: null,
      categories: [],
      latest_version: '1.0.0',
      download_count: 0,
      rating_average: 0,
      featured: false,
      ...overrides,
    }
  }

  it('shows category chips and searches the chosen category', async () => {
    const api = mockPlugins({
      marketplaceCategories: vi.fn().mockResolvedValue([
        { slug: 'productivity', label: 'Productivity', count: 2 },
        { slug: 'future-slug', label: 'Future', count: 0 },
      ]),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    const chips = wrapper.findAll('.mkt-chip')
    expect(chips.map((c) => c.text())).toEqual(['All', 'Productivity', 'Future'])
    expect(chips[0].attributes('aria-pressed')).toBe('true')
    await wrapper.get('[data-category="productivity"]').trigger('click')
    await flushPromises()
    expect(api.marketplaceSearch).toHaveBeenLastCalledWith(undefined, 'downloads', {
      category: 'productivity',
      offset: 0,
      limit: 20,
      hideIncompatible: false,
    })
    expect(wrapper.get('[data-category="productivity"]').attributes('aria-pressed')).toBe('true')
  })

  it('shows no chips for a Registry without a category list', async () => {
    mockPlugins({ marketplaceCategories: vi.fn().mockRejectedValue(new Error('offline')) })
    wrapper = mountMarketplace()
    await flushPromises()
    expect(wrapper.find('.mkt-chips').exists()).toBe(false)
  })

  it('loads more results and reports how many are shown', async () => {
    const api = mockPlugins({
      marketplaceSearch: vi
        .fn()
        .mockResolvedValueOnce({ items: [listing('acme.a'), listing('acme.b')], total: 3, offset: 0, limit: 20 })
        .mockResolvedValueOnce({ items: [listing('acme.b'), listing('acme.c')], total: 3, offset: 2, limit: 20 }),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    expect(wrapper.get('.mkt-showing').text()).toBe('Showing 2 of 3')
    await wrapper.get('.mkt-load-more-btn').trigger('click')
    await flushPromises()
    expect(api.marketplaceSearch).toHaveBeenLastCalledWith(undefined, 'downloads', {
      offset: 2,
      limit: 20,
      hideIncompatible: false,
    })
    // A row already shown is not repeated when the ranking shifts.
    expect(wrapper.findAll('.ext-result').map((r) => r.attributes('data-id'))).toEqual([
      'acme.a',
      'acme.b',
      'acme.c',
    ])
    expect(wrapper.get('.mkt-showing').text()).toBe('Showing 3 of 3')
    expect(wrapper.find('.mkt-load-more-btn').exists()).toBe(false)
  })

  it('keeps the loaded rows and shows the error when loading more fails', async () => {
    mockPlugins({
      marketplaceSearch: vi
        .fn()
        .mockResolvedValueOnce({ items: [listing('acme.a')], total: 2, offset: 0, limit: 20 })
        .mockRejectedValueOnce(new Error('marketplace search failed: HTTP 502')),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('.mkt-load-more-btn').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.ext-result')).toHaveLength(1)
    expect(wrapper.get('.mkt-load-more-error').text()).toContain('HTTP 502')
  })

  it('shows an offline listing as an error, never the previous results', async () => {
    mockPlugins({
      marketplaceSearch: vi
        .fn()
        .mockResolvedValueOnce({ items: [listing('acme.a')], total: 1, offset: 0, limit: 20 })
        .mockRejectedValueOnce(new Error('fetch failed')),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    expect(wrapper.findAll('.ext-result')).toHaveLength(1)
    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()
    expect(wrapper.find('.ext-result').exists()).toBe(false)
    expect(wrapper.get('.mkt-list-error').text()).toContain('fetch failed')
  })

  it('shows compatible, incompatible and unknown listings (D1: shown but not installable)', async () => {
    const api = mockPlugins({
      marketplaceSearch: vi.fn().mockResolvedValue({
        items: [
          listing('acme.ok', { compatible: true, app_version: '0.2.13' }),
          listing('acme.new', { compatible: false, min_navide_version: '0.3.0', app_version: '0.2.13' }),
          listing('acme.unknown', { compatible: null }),
        ],
        total: 3,
        offset: 0,
        limit: 20,
      }),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    const ok = wrapper.get('[data-id="acme.ok"]')
    expect(ok.get('.ext-compatible-badge').text()).toBe('Works with Navide 0.2.13')
    expect(ok.get('.ext-install').attributes('disabled')).toBeUndefined()

    const incompatible = wrapper.get('[data-id="acme.new"]')
    expect(incompatible.classes()).toContain('ext-result--incompatible')
    expect(incompatible.get('.ext-incompatible-badge').text()).toBe('Requires Navide ≥ 0.3.0')
    expect(incompatible.get('.mkt-card-incompatible').text()).toContain('You have 0.2.13')
    expect(incompatible.get('.ext-install').attributes('disabled')).toBeDefined()

    const unknown = wrapper.get('[data-id="acme.unknown"]')
    expect(unknown.find('.ext-compatible-badge').exists()).toBe(false)
    expect(unknown.find('.ext-incompatible-badge').exists()).toBe(false)
    expect(unknown.get('.ext-install').attributes('disabled')).toBeUndefined()

    await wrapper.get('.mkt-hide-incompatible input').setValue(true)
    await flushPromises()
    expect(api.marketplaceSearch).toHaveBeenLastCalledWith(undefined, 'downloads', {
      offset: 0,
      limit: 20,
      hideIncompatible: true,
    })
  })

  it('draws the icon from the main process, else a letter tile', async () => {
    const api = mockPlugins({
      marketplaceIcon: vi.fn().mockResolvedValue('data:image/png;base64,AAAA'),
      marketplaceSearch: vi.fn().mockResolvedValue({
        items: [listing('acme.icon', { icon_path: 'assets/i.png' }), listing('acme.plain', { display_name: 'plain' })],
        total: 2,
        offset: 0,
        limit: 20,
      }),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    expect(api.marketplaceIcon).toHaveBeenCalledWith({
      namespace: 'acme',
      name: 'icon',
      version: '1.0.0',
      path: 'assets/i.png',
    })
    expect(wrapper.get('[data-id="acme.icon"] img.mkt-icon').attributes('src')).toBe('data:image/png;base64,AAAA')
    expect(wrapper.get('[data-id="acme.plain"] .mkt-icon--letter').text()).toBe('P')
    expect(api.marketplaceIcon).toHaveBeenCalledTimes(1)
  })

  it('ignores an icon answer that is not an image data URL', async () => {
    mockPlugins({
      marketplaceIcon: vi.fn().mockResolvedValue('https://evil.test/x.png'),
      marketplaceSearch: vi.fn().mockResolvedValue({
        items: [listing('acme.icon', { icon_path: 'i.png' })],
        total: 1,
        offset: 0,
        limit: 20,
      }),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    expect(wrapper.find('[data-id="acme.icon"] img').exists()).toBe(false)
    expect(wrapper.find('[data-id="acme.icon"] .mkt-icon--letter').exists()).toBe(true)
  })

  it('opens a repository link only after an in-app confirmation', async () => {
    mockPlugins({
      marketplaceSearch: vi.fn().mockResolvedValue({
        items: [listing('acme.demo', { repository: 'https://github.com/acme/demo', license: 'MIT' })],
        total: 1,
        offset: 0,
        limit: 20,
      }),
    })
    const openExternal = vi.fn().mockResolvedValue({ ok: true })
    ;(window as unknown as { agentTeam: Record<string, unknown> }).agentTeam.openExternal = openExternal
    wrapper = mountMarketplace()
    await flushPromises()
    const row = wrapper.get('[data-id="acme.demo"]')
    expect(row.get('.mkt-card-links').text()).toContain('MIT')
    await row.get('.mkt-link').trigger('click')
    await flushPromises()
    // The card did not open its detail page, and nothing opened yet.
    expect(wrapper.find('.mkt-detail').exists()).toBe(false)
    expect(openExternal).not.toHaveBeenCalled()
    // The prose explains; the URL itself is the monospace detail line.
    expect(useNotify().dialog.value?.detail).toBe('https://github.com/acme/demo')
    expect(useNotify().dialog.value?.message).not.toContain('https://')
    useNotify().resolveDialog(false)
    await flushPromises()
    expect(openExternal).not.toHaveBeenCalled()

    await row.get('.mkt-link').trigger('click')
    await flushPromises()
    useNotify().resolveDialog(true)
    await flushPromises()
    expect(openExternal).toHaveBeenCalledWith('https://github.com/acme/demo')
  })

  it('shows links, works-with and the changelog in the detail view', async () => {
    const api = mockPlugins({
      marketplaceDetail: vi.fn().mockResolvedValue(
        demoDetail({
          repository: 'https://github.com/acme/demo',
          homepage: 'https://acme.test',
          license: 'MIT',
          has_changelog: true,
          min_navide_version: '0.2.9',
          compatible: true,
          app_version: '0.2.13',
          versions: [{ ...demoDetail().versions[0], min_navide_version: '0.2.9' }, demoDetail().versions[1]],
        })
      ),
      marketplaceChangelog: vi.fn().mockResolvedValue('# 1.1.0\n\n- fixed things'),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('[data-id="acme.demo"]').trigger('click')
    await flushPromises()
    const links = wrapper.get('.mkt-links')
    expect(links.findAll('.mkt-link').map((l) => l.text())).toEqual(['Repository ↗', 'Homepage ↗'])
    // The changelog is a tab next to README and Versions, fetched on first open.
    expect(wrapper.findAll('[role="tab"]').map((tab) => tab.text())).toEqual(['Details', 'Changelog', 'Versions'])
    expect(api.marketplaceChangelog).not.toHaveBeenCalled()
    expect(links.get('.mkt-license').text()).toBe('License: MIT')
    const worksWith = wrapper.get('.mkt-works-with')
    expect(worksWith.get('.mkt-works-with-version').text()).toBe('Version 1.1.0')
    expect(worksWith.findAll('.mkt-platform').map((p) => p.text())).toEqual(['All platforms'])
    expect(worksWith.get('.mkt-min-navide').text()).toBe('Navide ≥ 0.2.9')
    await wrapper.get('.mkt-changelog-toggle').trigger('click')
    await flushPromises()
    expect(api.marketplaceChangelog).toHaveBeenCalledWith({ namespace: 'acme', name: 'demo' })
    expect(wrapper.get('.mkt-changelog').text()).toContain('fixed things')
  })

  it('disables Install for an incompatible latest version and offers the compatible ones', async () => {
    const api = mockPlugins({
      marketplaceDetail: vi.fn().mockResolvedValue(
        demoDetail({
          latest_version: '2.0.0',
          latest_installable_version: '2.0.0',
          latest_compatible_version: '1.1.0',
          app_version: '0.2.13',
          versions: [
            {
              version: '2.0.0',
              published_at: '2026-09-29T00:00:00Z',
              target: 'universal',
              yanked: false,
              trust_tier: 'signed-verified',
              capabilities: [],
              sensitive_capabilities: [],
              download_count: 0,
              installable: true,
              compatible: false,
              min_navide_version: '0.3.0',
            },
            {
              version: '1.1.0',
              published_at: '2026-09-01T00:00:00Z',
              target: 'universal',
              yanked: false,
              trust_tier: 'signed-verified',
              capabilities: [],
              sensitive_capabilities: [],
              download_count: 0,
              installable: true,
              compatible: true,
            },
          ],
        })
      ),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('[data-id="acme.demo"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('.mkt-actions .ext-install').attributes('disabled')).toBeDefined()
    const banner = wrapper.get('.mkt-incompatible-banner')
    expect(banner.text()).toContain('Version 2.0.0 requires Navide 0.3.0 or newer. You have 0.2.13')
    expect(banner.text()).toContain('1.1.0 (older) is compatible.')
    expect(wrapper.get('.mkt-row-incompatible').text()).toBe('Requires Navide ≥ 0.3.0')

    await banner.get('.mkt-show-compatible').trigger('click')
    await flushPromises()
    const rows = wrapper.findAll('.mkt-versions tbody tr')
    expect(rows).toHaveLength(1)
    await rows[0].get('.mkt-row-install').trigger('click')
    await flushPromises()
    expect(api.prepareInstall).toHaveBeenCalledWith({
      namespace: 'acme',
      name: 'demo',
      version: '1.1.0',
    })
  })

  it('shows each version channel and switches this extension to pre-releases', async () => {
    const rows = [
      { version: '2.5.0-beta.1', channel: 'pre-release' },
      { version: '2.4.0', channel: 'stable' },
    ].map((row) => ({
      published_at: '2026-09-29T00:00:00Z',
      target: 'universal',
      yanked: false,
      trust_tier: 'signed-verified',
      capabilities: [],
      sensitive_capabilities: [],
      download_count: 0,
      installable: true,
      ...row,
    }))
    const api = mockPlugins({
      marketplaceDetail: vi
        .fn()
        .mockResolvedValueOnce(
          demoDetail({ latest_version: '2.4.0', latest_installable_version: '2.4.0', gets_prereleases: false, versions: rows })
        )
        .mockResolvedValue(
          demoDetail({ latest_version: '2.4.0', latest_installable_version: '2.5.0-beta.1', gets_prereleases: true, versions: rows })
        ),
      setPrerelease: vi.fn().mockResolvedValue({ id: 'acme.demo', enabled: true }),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('[data-id="acme.demo"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('.mkt-channel-pre').text()).toBe('pre-release')
    expect(wrapper.get('.mkt-channel-stable').text()).toBe('stable')
    // Stable by default: Install names the stable latest, with no note.
    expect(wrapper.get('.mkt-actions .ext-install').text()).toBe('Install')
    expect(wrapper.find('.mkt-prerelease-note').exists()).toBe(false)
    const toggle = wrapper.get('.mkt-prerelease-toggle input')
    expect((toggle.element as HTMLInputElement).checked).toBe(false)
    await toggle.setValue(true)
    await flushPromises()
    expect(api.setPrerelease).toHaveBeenCalledWith('acme.demo', true)
    // The stable latest is still installable here: no platform warning, and
    // the button says the candidate is a pre-release (review #15).
    expect(wrapper.find('.mkt-unavailable').exists()).toBe(false)
    expect(wrapper.get('.mkt-actions .ext-install').text()).toBe('Install 2.5.0-beta.1 (pre-release)')
    // The header keeps the stable version and notes the pre-release beside it.
    expect(wrapper.get('.mkt-meta').text()).toContain('Version 2.4.0')
    expect(wrapper.get('.mkt-prerelease-note').text()).toBe('pre-release 2.5.0-beta.1 available')
    await wrapper.get('.mkt-actions .ext-install').trigger('click')
    await flushPromises()
    expect(api.prepareInstall).toHaveBeenCalledWith({ namespace: 'acme', name: 'demo', version: '2.5.0-beta.1' })
  })

  it('hides the pre-release switch when no pre-release exists', async () => {
    mockPlugins()
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('[data-id="acme.demo"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.mkt-prerelease-toggle').exists()).toBe(false)
  })

  describe('Extension Pack', () => {
    const member = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
      id,
      status,
      display_name: null,
      version: '1.0.0',
      capabilities: [],
      sensitive_capabilities: [],
      min_navide_version: null,
      ...extra,
    })
    const prepared = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      version: '1.0.0',
      trustTier: 'signed-verified',
      sensitive: [],
      containsBackendExecutable: false,
      requiresConfirmation: false,
      publisherId: 'acme',
      requiresPublisherTrust: false,
      requiresRiskConfirmation: false,
      ...extra,
    })

    function mockPack(overrides: Record<string, unknown> = {}) {
      return mockPlugins({
        marketplaceDetail: vi.fn().mockResolvedValue(
          demoDetail({
            extension_pack: ['acme.hello', 'acme.lint', 'acme.notes', 'acme.gone'],
            // A pack's own manifest carries no permissions.
            versions: [{ ...demoDetail().versions[0], capabilities: [], sensitive_capabilities: [] }],
          })
        ),
        marketplacePackMembers: vi.fn().mockResolvedValue([
          member('acme.hello', 'ready', { display_name: 'Hello', capabilities: ['ui'] }),
          member('acme.lint', 'ready', { capabilities: ['fs', 'shell', 'ui'], sensitive_capabilities: ['fs', 'shell'] }),
          member('acme.notes', 'installed'),
          member('acme.gone', 'missing', { version: null }),
        ]),
        preparePack: vi.fn().mockResolvedValue({
          id: 'acme.demo',
          version: '1.0.0',
          display_name: 'Demo Pack',
          trustTier: 'signed-verified',
          publisherId: 'acme',
          members: [
            member('acme.hello', 'ready'),
            member('acme.lint', 'ready', { capabilities: ['fs', 'shell', 'ui'], sensitive_capabilities: ['fs', 'shell'] }),
            member('acme.notes', 'ready'),
            member('acme.gone', 'missing', { version: null }),
          ],
        }),
        prepareInstall: vi.fn(async ({ namespace, name }: { namespace: string; name: string }) =>
          name === 'lint'
            ? prepared(`${namespace}.${name}`, { sensitive: ['fs', 'shell'], requiresConfirmation: true, requiresRiskConfirmation: true })
            : name === 'notes'
              ? prepared(`${namespace}.${name}`, { requiresPublisherTrust: true, publisherId: 'notes-co' })
              : prepared(`${namespace}.${name}`)
        ),
        finishPack: vi.fn().mockResolvedValue({ recorded: true }),
        ...overrides,
      })
    }

    async function openPackDetail() {
      wrapper = mountMarketplace()
      await flushPromises()
      await wrapper.get('[data-id="acme.demo"]').trigger('click')
      await flushPromises()
    }

    it('shows the members and their permissions on the pack detail page', async () => {
      const api = mockPack()
      await openPackDetail()
      expect(wrapper!.get('.mkt-pack-badge').text()).toBe('Navide Plugin Pack')
      expect(api.marketplacePackMembers).toHaveBeenCalledWith(['acme.hello', 'acme.lint', 'acme.notes', 'acme.gone'])
      const members = wrapper!.findAll('.mkt-pack-member')
      expect(members.map((m) => m.attributes('data-member'))).toEqual(['acme.hello', 'acme.lint', 'acme.notes', 'acme.gone'])
      // Each row keeps its fields apart: name, id · version, permissions, state.
      expect(members[0].get('.mkt-pack-member-name').text()).toBe('Hello')
      expect(members[0].get('.mkt-pack-member-id').text()).toBe('acme.hello · 1.0.0')
      // The full value is shown on hover by v-truncate when cut off, not by a title.
      expect(members[0].get('.mkt-pack-member-id').attributes('data-truncate')).toBe('')
      expect(members[0].get('.mkt-pack-member-name').attributes('data-truncate')).toBe('')
      expect(members[0].findAll('.mkt-pack-cap').map((c) => c.text())).toEqual(['ui'])
      expect(members[0].find('.mkt-pack-status').exists()).toBe(false)
      // The same "fs · sensitive" label as the install dialog, spaces included.
      expect(members[1].findAll('.mkt-pack-cap--sensitive').map((c) => c.text())).toEqual(['fs · sensitive', 'shell · sensitive'])
      expect(members[1].findAll('.mkt-pack-cap:not(.mkt-pack-cap--sensitive)').map((c) => c.text())).toEqual(['ui'])
      // Already installed is a neutral fact, here as in the install dialog.
      expect(members[2].get('.mkt-pack-status').classes()).toContain('mkt-badge--muted')
      // One count rule for the page, the button and the dialog.
      expect(wrapper!.get('.mkt-pack-counts').text()).toBe('4 Navide plugins · 2 to install · 1 already installed · 1 skipped')
      expect(members[3].get('.mkt-pack-status').text()).toContain('Not in the Navide Marketplace')
      // A skipped member gets the grey tile an incompatible card gets in the list.
      expect(members.map((m) => m.classes().includes('mkt-pack-member--skipped'))).toEqual([false, false, false, true])
      // The pack itself grants nothing; it does not say "declares no permissions".
      expect(wrapper!.get('.mkt-no-permissions').text()).toContain('This pack grants no permissions itself')
      expect(wrapper!.get('.mkt-actions .mkt-pack-install').text()).toBe('Install pack (4)')
      // A pack has no Install of its own.
      expect(wrapper!.find('.mkt-actions .ext-install').exists()).toBe(false)
    })

    it('summarises the pack first, then confirms every member on its own (D5)', async () => {
      const api = mockPack()
      await openPackDetail()
      await wrapper!.get('.mkt-pack-install').trigger('click')
      await flushPromises()
      expect(api.preparePack).toHaveBeenCalledWith({ namespace: 'acme', name: 'demo' })
      // The id and version stay one token; v-truncate shows the full value on hover when cut off.
      const lintId = wrapper!.get('.pack-member--summary[data-member="acme.lint"] .pack-member-id')
      expect(lintId.text()).toBe('acme.lint · 1.0.0')
      expect(lintId.attributes('data-truncate')).toBe('')
      // Every summary row has the same three cells, so states line up.
      for (const row of wrapper!.findAll('.pack-member--summary')) {
        expect(row.findAll(':scope > .pack-member-main, :scope > .pack-member-caps, :scope > .pack-status')).toHaveLength(3)
      }
      expect(wrapper!.get('.pack-member--summary[data-member="acme.lint"] .pack-member-caps').findAll('.pack-cap--sensitive').map((c) => c.text())).toEqual(['fs · sensitive', 'shell · sensitive'])
      // Summary: no member has been prepared or installed yet, and there is no accept-all.
      expect(wrapper!.find('.pack-review').text()).toBe('Review 3 Navide plugins')
      // The title counts every member and the ones to review, like the detail page.
      const total = wrapper!.findAll('.pack-member--summary').length
      expect(wrapper!.get('#pack-dialog-title').text()).toBe(`Install “Demo Pack”: ${total} Navide plugins, 3 to review`)
      expect(api.prepareInstall).not.toHaveBeenCalled()
      expect(wrapper!.text()).not.toMatch(/accept all/i)

      await wrapper!.get('.pack-review').trigger('click')
      await flushPromises()
      // Member 1 is non-sensitive, yet still waits for its own confirmation.
      expect(api.prepareInstall).toHaveBeenCalledWith({ namespace: 'acme', name: 'hello', version: '1.0.0' })
      expect(api.commitInstall).not.toHaveBeenCalled()
      expect(wrapper!.get('.pack-step--current').text()).toContain('acme.hello')
      await wrapper!.get('.pack-confirm').trigger('click')
      await flushPromises()
      expect(api.commitInstall).toHaveBeenCalledWith('acme.hello', { publisherConfirmed: false, riskConfirmed: true })

      // Member 2 shows its sensitive capabilities, highlighted; the user skips it.
      expect(wrapper!.get('.pack-sensitive').text()).toContain('fs, shell')
      expect(wrapper!.findAll('.pack-sensitive-caps .pack-cap--sensitive').map((c) => c.text())).toEqual([
        'fs · sensitive',
        'shell · sensitive',
      ])
      expect(wrapper!.get('.pack-step--done').text()).toContain('acme.hello')
      await wrapper!.get('.pack-skip').trigger('click')
      await flushPromises()
      expect(api.commitInstall).toHaveBeenCalledTimes(1)

      // Member 3 needs publisher trust first, then its own confirmation.
      expect(wrapper!.find('.pack-publisher-risk').exists()).toBe(true)
      await wrapper!.get('.pack-confirm-publisher').trigger('click')
      await flushPromises()
      expect(api.commitInstall).toHaveBeenCalledTimes(1)
      await wrapper!.get('.pack-confirm').trigger('click')
      await flushPromises()
      expect(api.commitInstall).toHaveBeenLastCalledWith('acme.notes', { publisherConfirmed: true, riskConfirmed: true })

      expect(api.finishPack).toHaveBeenCalledWith('acme.demo')
      const results = Object.fromEntries(
        wrapper!.findAll('.pack-dialog .pack-member').map((m) => [m.attributes('data-member'), m.get('.pack-result').text()])
      )
      expect(results).toEqual({
        'acme.hello': '✓ Installed',
        'acme.lint': '– Skipped',
        'acme.notes': '✓ Installed',
        'acme.gone': '– Not in the Navide Marketplace, skipped',
      })
      const tone = (id: string) => wrapper!.get(`.pack-dialog [data-member="${id}"] .pack-result`).classes()
      expect(tone('acme.hello')).toContain('pack-result--success')
      expect(tone('acme.lint')).toContain('pack-result--muted')
      await wrapper!.get('.pack-close').trigger('click')
      expect(wrapper!.find('.pack-dialog').exists()).toBe(false)
    })

    it('cancelling the pack keeps what was installed and installs nothing more', async () => {
      const api = mockPack()
      await openPackDetail()
      await wrapper!.get('.mkt-pack-install').trigger('click')
      await flushPromises()
      await wrapper!.get('.pack-review').trigger('click')
      await flushPromises()
      await wrapper!.get('.pack-confirm').trigger('click')
      await flushPromises()
      await wrapper!.get('.pack-dialog .pack-cancel').trigger('click')
      await flushPromises()
      expect(api.commitInstall).toHaveBeenCalledTimes(1)
      expect(api.prepareInstall).toHaveBeenCalledTimes(2)
      expect(api.finishPack).toHaveBeenCalledWith('acme.demo')
      const results = wrapper!.findAll('.pack-dialog .pack-member .pack-result').map((r) => r.text())
      expect(results.slice(0, 3)).toEqual([
        '✓ Installed',
        '– Not installed (pack cancelled)',
        '– Not installed (pack cancelled)',
      ])
    })

    it('cancelling at the summary records nothing', async () => {
      const api = mockPack()
      await openPackDetail()
      await wrapper!.get('.mkt-pack-install').trigger('click')
      await flushPromises()
      await wrapper!.get('.pack-dialog .pack-cancel').trigger('click')
      await flushPromises()
      expect(api.finishPack).not.toHaveBeenCalled()
      expect(wrapper!.find('.pack-dialog').exists()).toBe(false)
    })

    it('keeps Escape from closing Settings behind the pack flow', async () => {
      const api = mockPack()
      // The settings modal closes on any Escape nobody handled.
      const settingsClose = vi.fn()
      const settingsEsc = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && !e.defaultPrevented) settingsClose()
      }
      window.addEventListener('keydown', settingsEsc)
      try {
        await openPackDetail()
        await wrapper!.get('.mkt-pack-install').trigger('click')
        await flushPromises()
        await wrapper!.get('.pack-review').trigger('click')
        await flushPromises()
        // Mid-review, Escape does nothing: leaving is an explicit Skip or Cancel.
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
        await flushPromises()
        expect(settingsClose).not.toHaveBeenCalled()
        expect(wrapper!.find('.pack-confirm').exists()).toBe(true)
        expect(api.commitInstall).not.toHaveBeenCalled()
      } finally {
        window.removeEventListener('keydown', settingsEsc)
      }
    })

    it('cancels at the summary on Escape without closing Settings', async () => {
      const api = mockPack()
      const settingsClose = vi.fn()
      const settingsEsc = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && !e.defaultPrevented) settingsClose()
      }
      window.addEventListener('keydown', settingsEsc)
      try {
        await openPackDetail()
        await wrapper!.get('.mkt-pack-install').trigger('click')
        await flushPromises()
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
        await flushPromises()
        expect(settingsClose).not.toHaveBeenCalled()
        expect(wrapper!.find('.pack-dialog').exists()).toBe(false)
        expect(api.finishPack).not.toHaveBeenCalled()
        // Once the dialog is gone, Escape reaches Settings again.
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
        expect(settingsClose).toHaveBeenCalledTimes(1)
      } finally {
        window.removeEventListener('keydown', settingsEsc)
      }
    })

    it('stacks the pack dialogs above the settings close button', () => {
      // Same stacking context (.s-overlay): the dialog overlay must outrank
      // .s-close or the modal can be closed mid-flow.
      const read = (file: string) => readFileSync(join(process.cwd(), 'src/renderer/src/components', file), 'utf8')
      const zIndex = (css: string, selector: string) => {
        const block = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
        return Number(/z-index:\s*(\d+)/.exec(block)?.[1])
      }
      const close = zIndex(read('SettingsModal.vue'), '.s-close')
      expect(close).toBeGreaterThan(0)
      expect(zIndex(read('PackInstallDialog.vue'), '.pack-dialog')).toBeGreaterThan(close)
      expect(zIndex(read('PackUninstallDialog.vue'), '.pack-uninstall-dialog')).toBeGreaterThan(close)
      expect(zIndex(read('PluginTrustDialog.vue'), '.ext-trust-dialog')).toBeGreaterThan(close)
    })

    it('reports a member that fails verification and moves on', async () => {
      const api = mockPack({
        prepareInstall: vi
          .fn()
          .mockRejectedValueOnce(new Error('invalid Registry signature'))
          .mockResolvedValue(prepared('acme.lint')),
      })
      await openPackDetail()
      await wrapper!.get('.mkt-pack-install').trigger('click')
      await flushPromises()
      await wrapper!.get('.pack-review').trigger('click')
      await flushPromises()
      expect(wrapper!.get('.pack-step--failed').text()).toContain('acme.hello')
      expect(wrapper!.get('.pack-step--current').text()).toContain('acme.lint')
      expect(api.commitInstall).not.toHaveBeenCalled()
    })

    it('shows the pack failure when the pack cannot be verified', async () => {
      mockPack({ preparePack: vi.fn().mockRejectedValue(new Error('acme.demo is not an extension pack')) })
      await openPackDetail()
      await wrapper!.get('.mkt-pack-install').trigger('click')
      await flushPromises()
      expect(wrapper!.get('.mkt-pack-error').text()).toContain('is not an extension pack')
      expect(wrapper!.find('.pack-dialog').exists()).toBe(false)
    })
  })

  describe('screenshot review fixes', () => {
    it('still warns when the latest version has no artifact for this platform', async () => {
      mockPlugins({
        marketplaceDetail: vi.fn().mockResolvedValue(
          demoDetail({
            latest_version: '2.0.0',
            latest_installable_version: '1.1.0',
            host_target: 'darwin-arm64',
            versions: [
              { ...demoDetail().versions[0], version: '2.0.0', target: 'win32-x64', installable: false },
              { ...demoDetail().versions[0], version: '1.1.0' },
            ],
          })
        ),
      })
      wrapper = mountMarketplace()
      await flushPromises()
      await wrapper.get('[data-id="acme.demo"]').trigger('click')
      await flushPromises()
      expect(wrapper.get('.mkt-unavailable').text()).toContain('Version 2.0.0 is not published for this platform')
      expect(wrapper.get('.mkt-actions .ext-install').text()).toBe('Install 1.1.0')
    })

    it('describes one version under Works with: the one Install would install', async () => {
      mockPlugins({
        marketplaceDetail: vi.fn().mockResolvedValue(
          demoDetail({
            latest_version: '2.0.0',
            latest_installable_version: '2.0.0',
            versions: [
              { ...demoDetail().versions[0], version: '2.0.0', target: 'darwin-arm64', min_navide_version: '0.2.9' },
              { ...demoDetail().versions[0], version: '1.0.0', target: 'win32-x64', installable: false, min_navide_version: '0.1.0' },
            ],
          })
        ),
      })
      wrapper = mountMarketplace()
      await flushPromises()
      await wrapper.get('[data-id="acme.demo"]').trigger('click')
      await flushPromises()
      const worksWith = wrapper.get('.mkt-works-with')
      expect(worksWith.get('.mkt-works-with-version').text()).toBe('Version 2.0.0')
      // The older version's win32 build is not mixed in with 2.0.0's floor.
      expect(worksWith.findAll('.mkt-platform').map((p) => p.text())).toEqual(['darwin-arm64'])
      expect(worksWith.get('.mkt-min-navide').text()).toBe('Navide ≥ 0.2.9')
    })

    it('translates category chips and heads the versions table', async () => {
      mockPlugins({ marketplaceDetail: vi.fn().mockResolvedValue(demoDetail({ categories: ['productivity', 'tools'] })) })
      wrapper = mountMarketplace()
      await flushPromises()
      await wrapper.get('[data-id="acme.demo"]').trigger('click')
      await flushPromises()
      expect(wrapper.findAll('.mkt-categories .mkt-tag').map((t) => t.text())).toEqual(['Productivity', 'tools'])
      expect(wrapper.findAll('.mkt-versions th').map((th) => th.text())).toEqual([
        'Version',
        'Published',
        'Target',
        'Channel',
        'Downloads',
        'Status',
      ])
    })

    it('translates category chips in zh-TW', async () => {
      const previous = i18n.global.locale.value
      i18n.global.locale.value = 'zh-TW'
      try {
        mockPlugins({
          marketplaceCategories: vi.fn().mockResolvedValue([{ slug: 'version-control', label: 'Version control', count: 1 }]),
          marketplaceDetail: vi.fn().mockResolvedValue(demoDetail({ categories: ['extension-packs'] })),
        })
        wrapper = mountMarketplace()
        await flushPromises()
        expect(wrapper.get('[data-category="version-control"]').text()).toBe('版本控制')
        await wrapper.get('[data-id="acme.demo"]').trigger('click')
        await flushPromises()
        expect(wrapper.get('.mkt-categories .mkt-tag').text()).toBe('Navide 外掛組合')
      } finally {
        i18n.global.locale.value = previous
      }
    })

    it('goes back to all versions after showing only the compatible ones', async () => {
      mockPlugins({
        marketplaceDetail: vi.fn().mockResolvedValue(
          demoDetail({
            latest_version: '2.0.0',
            latest_installable_version: '2.0.0',
            latest_compatible_version: '1.1.0',
            versions: [
              { ...demoDetail().versions[0], version: '2.0.0', compatible: false, min_navide_version: '0.3.0' },
              { ...demoDetail().versions[0], version: '1.1.0', compatible: true },
            ],
          })
        ),
      })
      wrapper = mountMarketplace()
      await flushPromises()
      await wrapper.get('[data-id="acme.demo"]').trigger('click')
      await flushPromises()
      expect(wrapper.findAll('.mkt-versions tbody tr')).toHaveLength(2)
      expect(wrapper.find('.mkt-show-all').exists()).toBe(false)
      await wrapper.get('.mkt-show-compatible').trigger('click')
      await flushPromises()
      expect(wrapper.findAll('.mkt-versions tbody tr')).toHaveLength(1)
      await wrapper.get('.mkt-show-all').trigger('click')
      await flushPromises()
      expect(wrapper.findAll('.mkt-versions tbody tr')).toHaveLength(2)
      expect(wrapper.find('.mkt-show-all').exists()).toBe(false)
    })

    it('shows no compatibility check on a card not available for this platform, and a signed badge', async () => {
      mockPlugins({
        marketplaceSearch: vi.fn().mockResolvedValue({
          items: [
            { ...demoDetail(), identity: 'acme.win', name: 'win', installable: false, compatible: true, app_version: '0.2.12', trust_tier: 'signed-verified' },
            { ...demoDetail(), identity: 'acme.ok', name: 'ok', installable: true, compatible: true, app_version: '0.2.12', trust_tier: 'unsigned' },
          ],
          total: 2,
          offset: 0,
          limit: 20,
        }),
      })
      wrapper = mountMarketplace()
      await flushPromises()
      const win = wrapper.get('[data-id="acme.win"]')
      expect(win.find('.ext-unavailable-badge').exists()).toBe(true)
      expect(win.find('.ext-compatible-badge').exists()).toBe(false)
      expect(win.get('.ext-signed-badge').text()).toBe('✓ signed')
      const ok = wrapper.get('[data-id="acme.ok"]')
      expect(ok.find('.ext-compatible-badge').exists()).toBe(true)
      expect(ok.find('.ext-signed-badge').exists()).toBe(false)
    })
  })

  describe('browsing interactions', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('searches once after typing pauses, and Enter searches at once without a second call', async () => {
      const api = mockPlugins()
      wrapper = mountMarketplace()
      await flushPromises()
      expect(api.marketplaceSearch).toHaveBeenCalledTimes(1)
      vi.useFakeTimers()

      const input = wrapper.get('.ext-search input')
      for (const text of ['d', 'de', 'dem']) {
        await input.setValue(text)
        await vi.advanceTimersByTimeAsync(100)
      }
      // Still typing: nothing has been sent for the partial words.
      expect(api.marketplaceSearch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(250)
      expect(api.marketplaceSearch).toHaveBeenCalledTimes(2)
      expect(api.marketplaceSearch).toHaveBeenLastCalledWith('dem', 'downloads', expect.anything())

      await input.setValue('demo')
      await input.trigger('keyup', { key: 'Enter' })
      expect(api.marketplaceSearch).toHaveBeenCalledTimes(3)
      expect(api.marketplaceSearch).toHaveBeenLastCalledWith('demo', 'downloads', expect.anything())
      // The pending debounced search was dropped, so the query is not sent twice.
      await vi.advanceTimersByTimeAsync(1000)
      expect(api.marketplaceSearch).toHaveBeenCalledTimes(3)
    })

    it('shows skeleton cards and a status line while the listing loads', async () => {
      mockPlugins({ marketplaceSearch: vi.fn(() => new Promise(() => {})) })
      wrapper = mountMarketplace()
      await flushPromises()
      expect(wrapper.findAll('.mkt-skeleton-card')).toHaveLength(5)
      expect(wrapper.get('.mkt-loading').attributes('role')).toBe('status')
    })

    it('offers a way out of an empty search', async () => {
      const api = mockPlugins()
      wrapper = mountMarketplace()
      await flushPromises()
      api.marketplaceSearch.mockResolvedValue({ items: [], total: 0, offset: 0, limit: 20 })
      await wrapper.get('.ext-search input').setValue('zzz')
      await wrapper.get('.ext-search button').trigger('click')
      await flushPromises()
      await wrapper.get('.mkt-empty .mkt-state-actions .nv-btn').trigger('click')
      await flushPromises()
      expect((wrapper.get('.ext-search input').element as HTMLInputElement).value).toBe('')
      expect(api.marketplaceSearch).toHaveBeenLastCalledWith(undefined, 'downloads', expect.anything())
    })

    it('shelves the Registry featured extensions while browsing everything, not while searching', async () => {
      const item = (name: string, featured: boolean) => ({
        namespace: 'acme', name, identity: `acme.${name}`, display_name: name, description: `${name} description`,
        categories: [], latest_version: '1.0.0', download_count: 1200, rating_average: 4.5, featured,
      })
      const api = mockPlugins({
        marketplaceSearch: vi.fn().mockResolvedValue({ items: [item('star', true), item('plain', false)], total: 2, offset: 0, limit: 20 }),
      })
      wrapper = mountMarketplace()
      await flushPromises()
      const shelf = wrapper.findAll('.mkt-featured-card')
      expect(shelf.map((card) => card.attributes('data-featured-id'))).toEqual(['acme.star'])
      // The first featured extension leads the shelf; nothing rotates on its own.
      expect(shelf[0].classes()).toContain('mkt-featured-card--hero')
      await shelf[0].trigger('click')
      await flushPromises()
      expect(api.marketplaceDetail).toHaveBeenCalledWith({ namespace: 'acme', name: 'star' })

      await wrapper.get('.mkt-back').trigger('click')
      await wrapper.get('.ext-search input').setValue('star')
      await wrapper.get('.ext-search button').trigger('click')
      await flushPromises()
      expect(wrapper.find('.mkt-featured').exists()).toBe(false)
    })

    it('switches detail tabs with the arrow keys', async () => {
      mockPlugins()
      wrapper = mountMarketplace()
      await flushPromises()
      await wrapper.get('[data-id="acme.demo"]').trigger('click')
      await flushPromises()
      const tabs = () => wrapper!.findAll('[role="tab"]')
      expect(tabs().map((tab) => tab.attributes('aria-selected'))).toEqual(['true', 'false'])
      await tabs()[0].trigger('keydown', { key: 'ArrowRight' })
      expect(tabs().map((tab) => tab.attributes('aria-selected'))).toEqual(['false', 'true'])
      expect(tabs()[1].attributes('tabindex')).toBe('0')
      expect((wrapper.get('#mkt-panel-versions').element as HTMLElement).style.display).toBe('')
      expect((wrapper.get('#mkt-panel-readme').element as HTMLElement).style.display).toBe('none')
      await tabs()[1].trigger('keydown', { key: 'ArrowRight' })
      expect(tabs()[0].attributes('aria-selected')).toBe('true')
    })

    it('labels the trust dialog, starts on Cancel, keeps Tab inside and returns focus after', async () => {
      mockPlugins({
        prepareInstall: vi.fn().mockResolvedValue({
          id: 'acme.demo',
          version: '1.0.0',
          trustTier: 'signed-verified',
          sensitive: ['fs'],
          containsBackendExecutable: false,
          requiresConfirmation: true,
        }),
      })
      wrapper = mount(MarketplacePane, { global: { plugins: [i18n] }, attachTo: document.body })
      await flushPromises()
      const install = wrapper.get('.ext-install').element as HTMLElement
      install.focus()
      await wrapper.get('.ext-install').trigger('click')
      await flushPromises()

      const card = wrapper.get('.ext-trust-body')
      expect(card.attributes('role')).toBe('alertdialog')
      expect(document.getElementById(card.attributes('aria-labelledby')!)?.textContent).toContain('Confirm Navide plugin permissions')
      expect(card.text()).toContain('Read and write files in your workspace.')
      const cancel = wrapper.get('.ext-cancel').element
      const confirm = wrapper.get('.ext-confirm-risk').element
      expect(document.activeElement).toBe(cancel)

      const tab = (shiftKey: boolean) =>
        document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }))
      tab(true)
      expect(document.activeElement).toBe(confirm)
      tab(false)
      expect(document.activeElement).toBe(cancel)

      await wrapper.get('.ext-cancel').trigger('click')
      await flushPromises()
      expect(wrapper.find('.ext-trust-dialog').exists()).toBe(false)
      expect(document.activeElement).toBe(install)
    })

    it('says what an installed but incompatible version needs, never that Install is disabled (D9)', async () => {
      mockPlugins({
        listInstalled: vi.fn().mockResolvedValue([{ id: 'acme.demo', requires: [], sensitive: [], packageVersion: '1.1.0' }]),
        marketplaceDetail: vi.fn().mockResolvedValue(
          demoDetail({
            app_version: '0.2.13',
            latest_compatible_version: '1.0.0',
            versions: [
              { version: '1.1.0', published_at: '2026-09-01T00:00:00Z', target: 'universal', yanked: false, trust_tier: 'signed-verified', capabilities: [], sensitive_capabilities: [], download_count: 1, installable: true, compatible: false, min_navide_version: '0.3.0' },
              { version: '1.0.0', published_at: '2026-08-01T00:00:00Z', target: 'universal', yanked: false, trust_tier: 'signed-verified', capabilities: [], sensitive_capabilities: [], download_count: 1, installable: true, compatible: true },
            ],
          })
        ),
      })
      wrapper = mountMarketplace()
      await flushPromises()
      await wrapper.get('[data-id="acme.demo"]').trigger('click')
      await flushPromises()
      const banner = wrapper.get('.mkt-incompatible-banner')
      expect(banner.text()).toContain('The installed 1.1.0 needs Navide 0.3.0 or newer (you have 0.2.13)')
      expect(banner.text()).not.toContain('Install is disabled')
    })

    it('does not cite a Registry signature when the publisher step is for an unsigned package (D10)', async () => {
      const step = (trustTier: string) =>
        mockPlugins({
          prepareInstall: vi.fn().mockResolvedValue({
            id: 'acme.demo', version: '1.0.0', trustTier, sensitive: [], containsBackendExecutable: false,
            requiresConfirmation: false, publisherId: 'acme', requiresPublisherTrust: true, requiresRiskConfirmation: false,
          }),
        })
      step('unsigned')
      wrapper = mountMarketplace()
      await flushPromises()
      await wrapper.get('.ext-install').trigger('click')
      await flushPromises()
      expect(wrapper.get('.ext-publisher-risk').text()).toContain('is not signed by the Registry')
      expect(wrapper.get('.ext-publisher-risk').text()).not.toContain('valid Registry signature')
      wrapper.unmount()

      step('signed-verified')
      wrapper = mountMarketplace()
      await flushPromises()
      await wrapper.get('.ext-install').trigger('click')
      await flushPromises()
      expect(wrapper.get('.ext-publisher-risk').text()).toContain('valid Registry signature')
    })

    it('leaves the shelved featured extensions out of the list below', async () => {
      const item = (name: string, featured: boolean) => ({
        namespace: 'acme', name, identity: `acme.${name}`, display_name: name, description: null,
        categories: [], latest_version: '1.0.0', download_count: 0, rating_average: 0, featured,
      })
      mockPlugins({
        marketplaceSearch: vi.fn().mockResolvedValue({ items: [item('star', true), item('plain', false)], total: 2, offset: 0, limit: 20 }),
      })
      wrapper = mountMarketplace()
      await flushPromises()
      expect(wrapper.findAll('.ext-result').map((r) => r.attributes('data-id'))).toEqual(['acme.plain'])
      // Still counted as shown: the shelf shows it.
      expect(wrapper.get('.mkt-showing').text()).toBe('Showing 2 of 2')
    })

    it('shows which Install is working while it runs', async () => {
      let finish: (value: unknown) => void = () => {}
      mockPlugins({
        prepareInstall: vi.fn(() => new Promise((resolve) => { finish = resolve })),
      })
      wrapper = mountMarketplace()
      await flushPromises()
      await wrapper.get('.ext-install').trigger('click')
      const button = wrapper.get('.ext-install')
      expect(button.text()).toBe('Installing…')
      expect(button.attributes('aria-busy')).toBe('true')
      finish({ id: 'acme.demo', version: '1.0.0', trustTier: 'unsigned', sensitive: [], containsBackendExecutable: false, requiresConfirmation: false })
      await flushPromises()
      expect(wrapper.find('.ext-install').exists() ? wrapper.get('.ext-install').text() : 'Install').toBe('Install')
    })

    it('does not repeat the extension name as the first README heading', async () => {
      mockPlugins({ marketplaceDetail: vi.fn().mockResolvedValue(demoDetail({ readme: '# Demo\n\nIntro line.\n\n## Usage\n\nRun it.' })) })
      wrapper = mountMarketplace()
      await flushPromises()
      await wrapper.get('[data-id="acme.demo"]').trigger('click')
      await flushPromises()
      expect(wrapper.findAll('.mkt-readme .mkt-md-h').map((h) => h.text())).toEqual(['Usage'])
    })

    it('does not announce updates on an Extensions page with nothing installed (D7)', async () => {
      let push: (updates: unknown[]) => void = () => {}
      mockPlugins({
        listInstalled: vi.fn().mockResolvedValue([]),
        pendingUpdates: vi.fn().mockResolvedValue([]),
        onUpdatesChanged: vi.fn((handler: (updates: unknown[]) => void) => {
          push = handler
          return () => {}
        }),
      })
      const pluginUpdates = usePluginUpdates()
      const stop = pluginUpdates.subscribe()
      wrapper = mount(ExtensionsPane, { global: { plugins: [i18n] } })
      await flushPromises()
      push([{ id: 'acme.demo', namespace: 'acme', name: 'demo', installedVersion: '1.0.0', latestVersion: '1.1.0' }])
      await flushPromises()
      expect(wrapper.find('.ext-updates-summary').exists()).toBe(false)
      expect(wrapper.get('.ext-empty').text()).toContain('No Navide plugins installed')
      push([])
      stop()
    })

    it('colours a letter tile with the same hue bucket as the Marketplace website', () => {
      // Same ids and buckets as marketplace/registry/tests/test_web_identity.py.
      const fixtures: Array<[string, string, number]> = [
        ['navide', 'git-graph', 12],
        ['acme', 'hello', 14],
        ['labs', 'diagram-studio', 8],
        ['navide', 'essentials', 20],
      ]
      for (const [namespace, name, bucket] of fixtures) {
        const icon = mount(MarketplaceIcon, { props: { namespace, name, label: name } })
        expect(icon.get('.mkt-icon--letter').attributes('style')).toContain(`hsl(${bucket * 15} 44% 32%)`)
        icon.unmount()
      }
    })

    it('marks every state page with the signature diamond', async () => {
      mockPlugins({ marketplaceSearch: vi.fn().mockRejectedValue(new Error('offline')) })
      wrapper = mountMarketplace()
      await flushPromises()
      expect(wrapper.find('.mkt-list-error .mkt-sigil.mkt-sigil--danger').exists()).toBe(true)
      wrapper.unmount()

      mockPlugins({ marketplaceSearch: vi.fn().mockResolvedValue({ items: [], total: 0, offset: 0, limit: 20 }) })
      wrapper = mountMarketplace()
      await flushPromises()
      expect(wrapper.find('.mkt-empty .mkt-sigil').exists()).toBe(true)
    })
  })
})
