// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n, useNotify } from '@navide/plugin-ui/foundation'
import ExtensionsPane from '../ExtensionsPane.vue'

function mountExtensions() {
  return mount(ExtensionsPane, { global: { plugins: [i18n] } })
}

function mockPlugins(overrides: Record<string, unknown> = {}) {
  const api = {
    listInstalled: vi.fn().mockResolvedValue([
      { id: 'navide.mini-ide', requires: ['fs', 'git', 'terminal'], sensitive: ['fs', 'terminal'] },
    ]),
    listFactoryPackages: vi.fn().mockResolvedValue([]),
    restoreFactoryPackage: vi.fn().mockResolvedValue({ ok: true }),
    restart: vi.fn().mockResolvedValue({ ok: true }),
    rollback: vi.fn().mockResolvedValue({ id: '', packageVersion: '', restoredInstances: 0, skippedDestroyedHostWindows: 0 }),
    checkUpdates: vi.fn().mockResolvedValue([]),
    remove: vi.fn().mockResolvedValue({ ok: true }),
    setPrerelease: vi.fn().mockResolvedValue({ id: '', enabled: false }),
    setDisabled: vi.fn().mockResolvedValue({ id: '', disabled: false }),
    listPacks: vi.fn().mockResolvedValue([]),
    removePack: vi.fn().mockResolvedValue({ removed: true }),
    disabledStoreStatus: vi.fn().mockResolvedValue({ status: 'ok' }),
    resetDisabledStore: vi.fn().mockResolvedValue({ status: 'ok' }),
    ...overrides,
  }
  ;(window as unknown as Record<string, unknown>).agentTeam = { plugins: api }
  return api
}

describe('ExtensionsPane', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  it('offers a per-extension pre-release switch for Registry installs, off by default', async () => {
    const listInstalled = vi
      .fn()
      .mockResolvedValueOnce([
        { id: 'acme.demo', requires: [], sensitive: [], packageVersion: '1.2.0', provenance: 'official-registry', getsPrereleases: false },
        { id: 'local.dev', requires: [], sensitive: [], provenance: 'developer-local-unpacked' },
      ])
      .mockResolvedValue([
        { id: 'acme.demo', requires: [], sensitive: [], packageVersion: '1.2.0', provenance: 'official-registry', getsPrereleases: true },
        { id: 'local.dev', requires: [], sensitive: [], provenance: 'developer-local-unpacked' },
      ])
    const checkUpdates = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { id: 'acme.demo', namespace: 'acme', name: 'demo', installedVersion: '1.2.0', latestVersion: '1.3.1-beta.2' },
      ])
    const api = mockPlugins({
      listInstalled,
      checkUpdates,
      setPrerelease: vi.fn().mockResolvedValue({ id: 'acme.demo', enabled: true }),
    })
    wrapper = mountExtensions()
    await flushPromises()
    const toggle = wrapper.get('[data-id="acme.demo"] .ext-prerelease-toggle input')
    expect((toggle.element as HTMLInputElement).checked).toBe(false)
    // Only Registry installs have a channel to choose.
    expect(wrapper.find('[data-id="local.dev"] .ext-prerelease-toggle').exists()).toBe(false)
    await toggle.setValue(true)
    await flushPromises()
    expect(api.setPrerelease).toHaveBeenCalledWith('acme.demo', true)
    const row = wrapper.get('[data-id="acme.demo"]')
    expect((row.get('.ext-prerelease-toggle input').element as HTMLInputElement).checked).toBe(true)
    // Opting in changes the offer; installing it is still the user's press.
    expect(row.get('.ext-update-badge').text()).toContain('1.3.1-beta.2')
  })

  it('G3: says who had a loaded developer folder loaded, the user or an agent the user approved', async () => {
    const folder = (pluginId: string, loadedBy: unknown) => ({ pluginId, path: `/dev/${pluginId}`, consentedAt: '2026-10-21T01:00:00.000Z', loaded: true, loadedBy })
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        { id: 'acme.mine', requires: [], sensitive: [], provenance: 'developer-local-unpacked', source: 'developer-unpacked' },
        { id: 'acme.asked', requires: [], sensitive: [], provenance: 'developer-local-unpacked', source: 'developer-unpacked' },
        { id: 'acme.older', requires: [], sensitive: [], provenance: 'developer-local-unpacked', source: 'developer-unpacked' },
      ]),
      developerMode: vi.fn().mockResolvedValue({
        enabled: true,
        folders: [
          folder('acme.mine', { kind: 'user' }),
          folder('acme.asked', { kind: 'agent', callerKind: 'pane', paneName: 'builder', approvedAt: '2026-10-21T01:00:00.000Z' }),
          folder('acme.older', { kind: 'unknown' }),
        ],
      }),
      selfHostedQuarantine: vi.fn().mockResolvedValue([]),
    })
    wrapper = mountExtensions()
    await flushPromises()
    expect(wrapper.get('[data-id="acme.mine"] .ext-devmode-loaded-by').text()).toBe(i18n.global.t('settings.extensions.developerMode.loadedByUser'))
    const asked = wrapper.get('[data-id="acme.asked"] .ext-devmode-loaded-by').text()
    expect(asked).toContain(i18n.global.t('plugin-agent.caller.pane', { pane: 'builder' }))
    expect(asked).toContain('builder')
    expect(wrapper.get('[data-id="acme.older"] .ext-devmode-loaded-by').text()).toBe(i18n.global.t('settings.extensions.developerMode.loadedByUnknown'))
  })

  it('labels an installed version this Navide release is too old for, without disabling it', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        {
          id: 'contoso.native',
          requires: [],
          sensitive: [],
          packageVersion: '0.9.0',
          provenance: 'official-registry',
          minNavideVersion: '0.3.0',
          engineCompatible: false,
        },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()
    const row = wrapper.get('[data-id="contoso.native"]')
    expect(row.get('.ext-incompatible').text()).toBe('Needs Navide ≥ 0.3.0')
    expect(row.get('.ext-incompatible-reason').text()).toContain('It stays enabled')
    expect(row.get('.ext-remove').attributes('disabled')).toBeUndefined()
  })

  it('lists an installed pack and by default uninstalls only the pack (D8)', async () => {
    let records = [
      { id: 'acme.web-dev-pack', displayName: 'Web Dev Pack', version: '1.0.0', members: ['acme.hello', 'acme.lint', 'acme.notes'], installedByPack: ['acme.lint', 'acme.notes'] },
    ]
    const api = mockPlugins({
      listPacks: vi.fn(async () => records),
      removePack: vi.fn(async () => {
        records = []
        return { removed: true }
      }),
    })
    wrapper = mountExtensions()
    await flushPromises()
    const row = wrapper.get('[data-pack-id="acme.web-dev-pack"]')
    expect(row.get('.ext-pack-badge').text()).toBe('Pack · 3 members')
    expect(row.get('.ext-pack-includes').text()).toBe('Includes: acme.hello · acme.lint · acme.notes')
    await row.get('.ext-pack-remove').trigger('click')
    await flushPromises()
    expect(row.get('.ext-id').text()).toBe('Web Dev Pack')
    expect(row.get('.ext-pack-id').text()).toBe('acme.web-dev-pack')
    const dialog = wrapper.get('.pack-uninstall-dialog')
    // The name leads; the id is secondary.
    expect(dialog.get('h4').text()).toBe('Uninstall “Web Dev Pack”?')
    expect(dialog.get('.pack-uninstall-id').text()).toBe('acme.web-dev-pack')
    // Only the members this pack installed are offered, and none is ticked.
    const boxes = dialog.findAll('.pack-uninstall-member input')
    expect(dialog.findAll('.pack-uninstall-member').map((m) => m.attributes('data-member'))).toEqual(['acme.lint', 'acme.notes'])
    expect(boxes.every((b) => !(b.element as HTMLInputElement).checked)).toBe(true)
    expect(dialog.get('.pack-uninstall-confirm').text()).toBe('Uninstall pack only')
    await dialog.get('.pack-uninstall-confirm').trigger('click')
    await flushPromises()
    expect(api.remove).not.toHaveBeenCalled()
    expect(api.removePack).toHaveBeenCalledWith('acme.web-dev-pack', [])
    expect(wrapper.find('.pack-uninstall-dialog').exists()).toBe(false)
    expect(wrapper.find('[data-pack-id]').exists()).toBe(false)
  })

  it('closes the uninstall-pack dialog on Escape without letting it reach Settings', async () => {
    const api = mockPlugins({
      listPacks: vi.fn().mockResolvedValue([
        { id: 'acme.web-dev-pack', version: '1.0.0', members: ['acme.lint'], installedByPack: ['acme.lint'] },
      ]),
    })
    const settingsClose = vi.fn()
    const settingsEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) settingsClose()
    }
    window.addEventListener('keydown', settingsEsc)
    try {
      wrapper = mountExtensions()
      await flushPromises()
      await wrapper.get('.ext-pack-remove').trigger('click')
      await flushPromises()
      // No display name: the title falls back to the id, with no duplicate line.
      expect(wrapper.get('.pack-uninstall-dialog h4').text()).toBe('Uninstall “acme.web-dev-pack”?')
      expect(wrapper.find('.pack-uninstall-id').exists()).toBe(false)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
      await flushPromises()
      expect(settingsClose).not.toHaveBeenCalled()
      expect(wrapper.find('.pack-uninstall-dialog').exists()).toBe(false)
      expect(api.removePack).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', settingsEsc)
    }
  })

  it('removes the members the user ticks together with the pack', async () => {
    const api = mockPlugins({
      listPacks: vi.fn().mockResolvedValue([
        { id: 'acme.web-dev-pack', version: '1.0.0', members: ['acme.hello', 'acme.lint'], installedByPack: ['acme.lint'] },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()
    await wrapper.get('.ext-pack-remove').trigger('click')
    await flushPromises()
    await wrapper.get('.pack-uninstall-member input').setValue(true)
    expect(wrapper.get('.pack-uninstall-confirm').text()).toBe('Uninstall pack and 1 Navide plugin')
    await wrapper.get('.pack-uninstall-confirm').trigger('click')
    await flushPromises()
    // The Host removes the chosen members itself, so it can refuse a member
    // another installed pack still uses.
    expect(api.removePack).toHaveBeenCalledWith('acme.web-dev-pack', ['acme.lint'])
    expect(api.remove).not.toHaveBeenCalled()
  })

  it('renders the installed list with sensitive-capability badges', async () => {
    mockPlugins()
    wrapper = mountExtensions()
    await flushPromises()
    const row = wrapper.get('[data-id="navide.mini-ide"]')
    expect(row.text()).toContain('navide.mini-ide')
    expect(row.find('.ext-sensitive').exists()).toBe(true)
    expect(row.find('.ext-sensitive').text()).toContain('fs, terminal')
  })

  it('disables and enables a bundled built-in instead of removing or restoring it', async () => {
    const enabled = { id: 'navide.git', version: '0.1.0', active: true, optedOut: false, disabled: false }
    const listFactoryPackages = vi
      .fn()
      .mockResolvedValueOnce([enabled])
      .mockResolvedValueOnce([{ ...enabled, disabled: true }])
      .mockResolvedValue([enabled])
    const api = mockPlugins({ listInstalled: vi.fn().mockResolvedValue([]), listFactoryPackages })
    wrapper = mountExtensions()
    await flushPromises()

    let row = wrapper.get('[data-factory-id="navide.git"]')
    expect(row.text()).toContain('Bundled Git')
    expect(row.text()).toContain('Active')
    expect(row.find('.ext-restore').exists()).toBe(false)
    expect(row.find('.ext-remove').exists()).toBe(false)
    await row.get('.ext-disable').trigger('click')
    await flushPromises()
    expect(api.setDisabled).toHaveBeenCalledWith('navide.git', true)

    row = wrapper.get('[data-factory-id="navide.git"]')
    expect(row.get('.ext-disabled-badge').text()).toBe('Disabled')
    expect(row.get('.ext-disabled-note').text()).toContain('permissions and stored data are kept')
    expect(row.find('.ext-disable').exists()).toBe(false)
    await row.get('.ext-enable').trigger('click')
    await flushPromises()
    expect(api.setDisabled).toHaveBeenLastCalledWith('navide.git', false)
    expect(api.restoreFactoryPackage).not.toHaveBeenCalled()
  })

  it('shows a built-in switch and the reset as busy until the Host finishes, however long that takes', async () => {
    const enabled = { id: 'navide.plans', version: '0.1.0', active: true, optedOut: false, disabled: false }
    let finishSwitch!: () => void
    let finishReset!: () => void
    const api = mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([]),
      listFactoryPackages: vi.fn().mockResolvedValue([enabled]),
      setDisabled: vi.fn(() => new Promise((resolve) => { finishSwitch = () => resolve({ id: 'navide.plans', disabled: true }) })),
      disabledStoreStatus: vi.fn().mockResolvedValue({ status: 'unreadable' }),
      resetDisabledStore: vi.fn(() => new Promise((resolve) => { finishReset = () => resolve({ status: 'ok' }) })),
    })
    wrapper = mountExtensions()
    await flushPromises()

    let row = wrapper.get('[data-factory-id="navide.plans"]')
    expect(row.find('.ext-switch-busy').exists()).toBe(false)
    await row.get('.ext-disable').trigger('click')
    await flushPromises()
    expect(api.setDisabled).toHaveBeenCalledWith('navide.plans', true)
    row = wrapper.get('[data-factory-id="navide.plans"]')
    const busy = row.get('.ext-switch-busy')
    expect(busy.attributes('role')).toBe('status')
    expect(busy.text()).toContain('Applying')
    expect(row.get('.ext-disable').attributes('disabled')).toBeDefined()
    finishSwitch()
    await flushPromises()
    expect(wrapper.find('[data-factory-id="navide.plans"] .ext-switch-busy').exists()).toBe(false)

    await wrapper.get('.ext-store-reset').trigger('click')
    await flushPromises()
    expect(wrapper.get('.ext-store-unreadable .ext-switch-busy').text()).toContain('Applying')
    expect(wrapper.get('.ext-store-reset').attributes('disabled')).toBeDefined()
    finishReset()
    await flushPromises()
    expect(wrapper.find('.ext-switch-busy').exists()).toBe(false)
  })

  it('says a built-in removed by an earlier version lost its data and only offers Enable', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([]),
      listFactoryPackages: vi.fn().mockResolvedValue([
        { id: 'navide.mini-ide', version: null, active: false, optedOut: false, disabled: true, dataDeletedByEarlierRemoval: true },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()

    const row = wrapper.get('[data-factory-id="navide.mini-ide"]')
    expect(row.get('.ext-data-deleted-note').text()).toContain('deleted its stored data')
    expect(row.find('.ext-enable').exists()).toBe(true)
    expect(row.find('.ext-restore').exists()).toBe(false)
    expect(row.text()).not.toContain('Removed')
  })

  it('says the Disabled switches were restored from their backup', async () => {
    mockPlugins({ disabledStoreStatus: vi.fn().mockResolvedValue({ status: 'restored' }) })
    wrapper = mountExtensions()
    await flushPromises()
    expect(wrapper.get('.ext-store-restored').text()).toContain('Restored from backup')
    expect(wrapper.find('.ext-store-unreadable').exists()).toBe(false)
  })

  it('explains an unreadable Disabled store and resets it in one click', async () => {
    const api = mockPlugins({
      disabledStoreStatus: vi.fn().mockResolvedValue({ status: 'unreadable' }),
      resetDisabledStore: vi.fn().mockResolvedValue({ status: 'ok' }),
    })
    wrapper = mountExtensions()
    await flushPromises()
    const banner = wrapper.get('.ext-store-unreadable')
    expect(banner.attributes('role')).toBe('alert')
    expect(banner.text()).toContain('treated as disabled')
    await banner.get('.ext-store-reset').trigger('click')
    await flushPromises()
    expect(api.resetDisabledStore).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.ext-store-unreadable').exists()).toBe(false)
  })

  // Decision d5: a local install whose file Navide blocked keeps a label naming the reason.
  it('labels a local install whose file Navide blocked, by reason', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        { id: 'acme.one', requires: [], sensitive: [], packageVersion: '1.0.0', source: 'local-unsigned', digestBlock: { reason: 'qualification-revoked' }, disabled: false },
        { id: 'acme.two', requires: [], sensitive: [], packageVersion: '1.0.0', source: 'local-unsigned', digestBlock: { reason: null }, disabled: true },
        { id: 'acme.three', requires: [], sensitive: [], packageVersion: '1.0.0', source: 'local-unsigned', digestBlock: { reason: 'developer-withdrawn' }, disabled: false },
        { id: 'acme.four', requires: [], sensitive: [], packageVersion: '1.0.0', source: 'local-unsigned' },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()
    const badge = (id: string) => wrapper!.find(`[data-id="${id}"] .ext-digest-blocked-badge`)
    expect(badge('acme.one').text()).toBe('Developer qualification revoked')
    expect(badge('acme.two').text()).toBe('Blocked by Navide')
    expect(badge('acme.two').attributes('data-reason')).toBe('none')
    expect(badge('acme.three').text()).toBe('Withdrawn by its developer')
    expect(badge('acme.four').exists()).toBe(false)
  })

  it('offers no Uninstall for a Marketplace copy of a built-in', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        { id: 'navide.git', requires: [], sensitive: [], packageVersion: '2.0.0', provenance: 'official-registry' },
        { id: 'acme.demo', requires: [], sensitive: [], packageVersion: '1.0.0', provenance: 'official-registry' },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()
    expect(wrapper.find('[data-id="navide.git"] .ext-remove').exists()).toBe(false)
    expect(wrapper.find('[data-id="acme.demo"] .ext-remove').exists()).toBe(true)
  })

  it('offers Uninstall for the Marketplace navide.browser and says removal deletes its sign-ins', async () => {
    const api = mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([{
        id: 'navide.browser', requires: [], sensitive: [], packageVersion: '1.0.0', provenance: 'official-registry',
        manifestPermissions: { system: ['ui', 'web'] }, disabled: false,
      }]),
    })
    wrapper = mountExtensions()
    await flushPromises()
    await wrapper.get('[data-id="navide.browser"] .ext-remove').trigger('click')
    await flushPromises()
    expect(useNotify().dialog.value?.message).toContain('also deletes its site sign-ins, cookies and cache')
    useNotify().resolveDialog(true)
    await flushPromises()
    expect(api.remove).toHaveBeenCalledWith('navide.browser')
  })

  it('shows an active factory Git package only in the Bundled section', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        {
          id: 'navide.git',
          requires: ['fs', 'ui', 'shell'],
          sensitive: ['fs', 'shell'],
          provenance: 'factory-bundled',
        },
      ]),
      listFactoryPackages: vi.fn().mockResolvedValue([
        { id: 'navide.git', version: '0.1.0', active: true, optedOut: false },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()

    expect(wrapper.get('[data-factory-id="navide.git"]').text()).toContain('Active')
    expect(wrapper.find('[data-id="navide.git"]').exists()).toBe(false)
  })

  it('shows Bundled Git Manifest Permissions and its exact package-version grant', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        {
          id: 'navide.git',
          requires: ['fs', 'shell'],
          sensitive: ['fs', 'shell'],
          packageVersion: '2.0.0',
          manifestPermissions: { system: ['fs'], shell: 'allowlist' },
          packageVersionGrant: {
            packageVersion: '2.0.0',
            system: ['fs'],
            shell: 'allowlist',
          },
          provenance: 'factory-bundled',
        },
      ]),
      listFactoryPackages: vi.fn().mockResolvedValue([
        { id: 'navide.git', version: '2.0.0', active: true, optedOut: false },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()

    const row = wrapper.get('[data-factory-id="navide.git"]')
    expect(row.find('.ext-manifest-permissions').text()).toContain('fs')
    expect(row.find('.ext-manifest-permissions').text()).toContain('allowlist')
    expect(row.find('.ext-package-grant').text()).toContain('2.0.0')
    expect(row.find('.ext-package-grant').text()).toContain('fs')
    expect(wrapper.find('[data-id="navide.git"]').exists()).toBe(false)
  })

  function mockBundledPlansAndGit() {
    return mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        {
          id: 'navide.plans',
          requires: ['fs', 'ui', 'aiCli'],
          sensitive: ['fs'],
          packageVersion: '0.1.0',
          manifestPermissions: {
            system: ['fs', 'ui', 'aiCli'],
            scopes: {
              fs: {
                root: 'repository',
                read: ['**/docs/plans/*', '**/docs/plans/.history/**', '.plans/*'],
                write: ['**/docs/plans/*', '.plans/*'],
              },
            },
          },
          provenance: 'factory-bundled',
        },
        {
          id: 'navide.git',
          requires: ['fs', 'shell'],
          sensitive: ['fs', 'shell'],
          packageVersion: '2.0.0',
          manifestPermissions: { system: ['fs'], shell: 'allowlist' },
          provenance: 'factory-bundled',
        },
      ]),
      listFactoryPackages: vi.fn().mockResolvedValue([
        { id: 'navide.git', version: '2.0.0', active: true, optedOut: false },
        { id: 'navide.plans', version: '0.1.0', active: true, optedOut: false },
      ]),
    })
  }

  it('discloses the bundled Plans file scope and that its backend runs unsandboxed', async () => {
    mockBundledPlansAndGit()
    wrapper = mountExtensions()
    await flushPromises()

    const row = wrapper.get('[data-factory-id="navide.plans"]')
    expect(row.get('.ext-manifest-scopes').text()).toBe(
      'File scope (from the Git repository root): read and write **/docs/plans/*, .plans/*; read only **/docs/plans/.history/**'
    )
    const risk = row.get('.ext-risk-note').text()
    expect(risk).toContain('own backend')
    expect(risk).toContain('user permissions')
    expect(risk).toContain('no sandbox')
    expect(risk).toContain('Git repository root')
    expect(risk).toContain('.history')
    // Since the backend writes plan files itself, only deletes and renames
    // still go through Navide.
    expect(risk).toContain('Its backend reads and writes them directly')
    expect(risk).toContain('deletes and renames still go through Navide')
    expect(risk).not.toContain('writes, renames and deletes')
    // The third-party sandbox wording never describes this package.
    expect(risk).not.toContain('sandboxed')
    expect(wrapper.find('[data-id="navide.plans"]').exists()).toBe(false)
  })

  it('keeps a bundled row without declared scopes as it was', async () => {
    mockBundledPlansAndGit()
    wrapper = mountExtensions()
    await flushPromises()

    const row = wrapper.get('[data-factory-id="navide.git"]')
    expect(row.find('.ext-manifest-scopes').exists()).toBe(false)
    expect(row.find('.ext-risk-note').exists()).toBe(false)
    expect(row.get('.ext-manifest-permissions').text()).toContain('allowlist')
  })

  it('discloses declared file scopes of an installed third-party package', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        {
          id: 'acme.notes',
          requires: ['fs'],
          sensitive: ['fs'],
          packageVersion: '1.0.0',
          manifestPermissions: { system: ['fs'], scopes: { fs: { read: ['docs'] } } },
          provenance: 'official-registry',
        },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()

    expect(wrapper.get('[data-id="acme.notes"] .ext-manifest-scopes').text()).toBe('File scope: read only docs')
  })

  it('shows no matching Grant for a Bundled package version without a grant', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        {
          id: 'navide.git',
          requires: [],
          sensitive: [],
          packageVersion: '2.0.0',
          manifestPermissions: { system: ['fs'] },
          packageVersionGrant: null,
          provenance: 'factory-bundled',
        },
      ]),
      listFactoryPackages: vi.fn().mockResolvedValue([
        { id: 'navide.git', version: '2.0.0', active: true, optedOut: false },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()

    expect(wrapper.get('[data-factory-id="navide.git"] .ext-package-grant').text()).toContain(
      'No matching grant'
    )
  })

  it('passes the native backend data choice from the remove dialog', async () => {
    const api = mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([{ id: 'acme.backend', requires: [], sensitive: [] }]),
      nativeBackendData: vi
        .fn()
        .mockResolvedValue({ exists: true, bytes: 5 * 1024 * 1024, path: '/userData/plugin-native-backends/data/acme.backend' }),
    })
    wrapper = mountExtensions()
    await flushPromises()
    await wrapper.get('[data-id="acme.backend"] .ext-remove').trigger('click')
    await flushPromises()
    expect(useNotify().dialog.value?.message).toContain('5.0 MB')
    expect(useNotify().dialog.value?.checkboxLabel).toBeTruthy()
    expect(useNotify().dialogCheckbox.value).toBe(false)
    useNotify().resolveDialog(true)
    await flushPromises()
    expect(api.remove).toHaveBeenCalledWith('acme.backend', 'delete')
  })

  it('shows and removes a backend-only package with no capabilities', async () => {
    const listInstalled = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'acme.backend', requires: [], sensitive: [] }])
      .mockResolvedValueOnce([])
    const api = mockPlugins({ listInstalled })
    wrapper = mountExtensions()
    await flushPromises()

    expect(wrapper.get('[data-id="acme.backend"]').text()).toContain('acme.backend')
    await wrapper.get('[data-id="acme.backend"] .ext-remove').trigger('click')
    await flushPromises()
    // Removal waits on the in-app confirmation; say yes for the user.
    expect(useNotify().dialog.value?.kind).toBe('confirm')
    useNotify().resolveDialog(true)
    await flushPromises()

    expect(api.remove).toHaveBeenCalledWith('acme.backend')
    expect(wrapper.find('[data-id="acme.backend"]').exists()).toBe(false)
    expect(wrapper.get('.ext-empty').text()).toContain('No Navide plugins installed')
  })




  it('offers a rollback only when the Host reports one, behind a danger confirm', async () => {
    const listInstalled = vi
      .fn()
      .mockResolvedValueOnce([
        { id: 'acme.demo', requires: [], sensitive: [], packageVersion: '1.0.1', rollbackKind: 'previous', rollbackToVersion: '1.0.0' },
        { id: 'acme.staged', requires: [], sensitive: [], packageVersion: '2.0.0', pendingCandidateVersion: '2.1.0' },
      ])
      .mockResolvedValue([
        { id: 'acme.demo', requires: [], sensitive: [], packageVersion: '1.0.0' },
        { id: 'acme.staged', requires: [], sensitive: [], packageVersion: '2.0.0', pendingCandidateVersion: '2.1.0' },
      ])
    const rollback = vi.fn().mockResolvedValue({
      id: 'acme.demo',
      packageVersion: '1.0.0',
      restoredInstances: 0,
      skippedDestroyedHostWindows: 0,
    })
    const api = mockPlugins({ listInstalled, rollback })
    wrapper = mountExtensions()
    await flushPromises()

    // A row the Host reports no rollback for never shows the button.
    expect(wrapper.find('[data-id="acme.staged"] .ext-rollback').exists()).toBe(false)
    const button = wrapper.get('[data-id="acme.demo"] .ext-rollback')
    expect(button.text()).toContain('1.0.0')

    await button.trigger('click')
    await flushPromises()
    expect(useNotify().dialog.value?.kind).toBe('confirm')
    expect(api.rollback).not.toHaveBeenCalled()
    useNotify().resolveDialog(true)
    await flushPromises()

    expect(api.rollback).toHaveBeenCalledWith('acme.demo')
    // The reloaded inventory no longer reports a rollback, so the button goes.
    expect(wrapper.find('[data-id="acme.demo"] .ext-rollback').exists()).toBe(false)
  })

  it('leaves the package alone when the rollback confirmation is declined', async () => {
    const api = mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        { id: 'acme.demo', requires: [], sensitive: [], packageVersion: '1.0.1', rollbackKind: 'factory' },
      ]),
      rollback: vi.fn().mockResolvedValue({}),
    })
    wrapper = mountExtensions()
    await flushPromises()

    const button = wrapper.get('[data-id="acme.demo"] .ext-rollback')
    expect(button.text()).toContain('bundled')
    await button.trigger('click')
    await flushPromises()
    useNotify().resolveDialog(false)
    await flushPromises()

    expect(api.rollback).not.toHaveBeenCalled()
  })

  it('offers the promote-back restart on the bundled row a rollback staged a candidate on', async () => {
    const api = mockPlugins({
      // After a rollback the id is factory-bundled again, so it is listed only
      // under Bundled while the package it displaced waits as the candidate.
      listInstalled: vi.fn().mockResolvedValue([
        {
          id: 'navide.mini-ide',
          requires: [],
          sensitive: [],
          packageVersion: '0.2.11',
          provenance: 'factory-bundled',
          pendingCandidateVersion: '0.3.0',
        },
      ]),
      listFactoryPackages: vi.fn().mockResolvedValue([
        { id: 'navide.mini-ide', version: '0.2.11', active: true, optedOut: false },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()

    const row = wrapper.get('[data-factory-id="navide.mini-ide"]')
    expect(row.text()).toContain('0.3.0')
    await row.get('.ext-restart').trigger('click')
    await flushPromises()

    expect(api.restart).toHaveBeenCalledWith('navide.mini-ide')
  })

  it('offers Enable, not the promote-back restart, on a disabled bundled row', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([]),
      listFactoryPackages: vi.fn().mockResolvedValue([
        { id: 'navide.mini-ide', version: '0.2.11', active: true, optedOut: false, disabled: true },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()

    const row = wrapper.get('[data-factory-id="navide.mini-ide"]')
    expect(row.find('.ext-restore').exists()).toBe(false)
    expect(row.find('.ext-enable').exists()).toBe(true)
    expect(row.find('.ext-restart').exists()).toBe(false)
  })

  it('shows the main process message for a failed rollback, not the IPC wrapper', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        { id: 'acme.demo', requires: [], sensitive: [], packageVersion: '1.0.1', rollbackKind: 'factory' },
      ]),
      rollback: vi.fn().mockRejectedValue(
        new Error(
          "Error invoking remote method 'plugins:rollback': Error: previous package is unavailable for rollback",
        ),
      ),
    })
    wrapper = mountExtensions()
    await flushPromises()

    await wrapper.get('[data-id="acme.demo"] .ext-rollback').trigger('click')
    await flushPromises()
    useNotify().resolveDialog(true)
    await flushPromises()

    const shown = wrapper.get('.ext-error').text()
    expect(shown).toBe('The previous version is no longer available to roll back to.')
    expect(shown).not.toContain('Error invoking remote method')
  })

  it('shows the main process message for a failed restart, not the IPC wrapper', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        { id: 'acme.demo', requires: [], sensitive: [], packageVersion: '1.0.0', pendingCandidateVersion: '1.0.1' },
      ]),
      restart: vi.fn().mockRejectedValue(
        new Error("Error invoking remote method 'plugins:restart': Error: candidate package failed verification"),
      ),
    })
    wrapper = mountExtensions()
    await flushPromises()

    await wrapper.get('[data-id="acme.demo"] .ext-restart').trigger('click')
    await flushPromises()

    expect(wrapper.get('.ext-error').text()).toBe('candidate package failed verification')
  })

  it('shows the main process message for a failed bundled enable, not the IPC wrapper', async () => {
    mockPlugins({
      listFactoryPackages: vi.fn().mockResolvedValue([
        { id: 'navide.mini-ide', version: '0.2.11', active: true, optedOut: false, disabled: true },
      ]),
      setDisabled: vi.fn().mockRejectedValue(
        new Error("Error invoking remote method 'plugins:setDisabled': Error: bundled package missing"),
      ),
    })
    wrapper = mountExtensions()
    await flushPromises()

    await wrapper.get('[data-factory-id="navide.mini-ide"] .ext-enable').trigger('click')
    await flushPromises()

    expect(wrapper.get('.ext-error').text()).toBe('bundled package missing')
  })

  describe('in zh-TW', () => {
    const original = i18n.global.locale.value
    beforeEach(() => {
      i18n.global.locale.value = 'zh-TW'
    })
    afterEach(() => {
      i18n.global.locale.value = original
    })

    it('labels the rollback, staged update and restart from the locale', async () => {
      mockPlugins({
        listInstalled: vi.fn().mockResolvedValue([
          { id: 'acme.prev', requires: [], sensitive: [], packageVersion: '1.0.1', rollbackKind: 'previous', rollbackToVersion: '1.0.0' },
          { id: 'acme.fact', requires: [], sensitive: [], packageVersion: '2.0.0', rollbackKind: 'factory' },
          { id: 'acme.staged', requires: [], sensitive: [], packageVersion: '3.0.0', pendingCandidateVersion: '3.1.0' },
        ]),
      })
      wrapper = mountExtensions()
      await flushPromises()

      expect(wrapper.get('[data-id="acme.prev"] .ext-rollback').text()).toBe('回復到 1.0.0')
      expect(wrapper.get('[data-id="acme.fact"] .ext-rollback').text()).toBe('回復為內建版本')
      expect(wrapper.get('[data-id="acme.staged"] .ext-candidate').text()).toBe('更新 3.1.0 已就緒')
      expect(wrapper.get('[data-id="acme.staged"] .ext-restart').text()).toBe('重新啟動 Navide 外掛')

      await wrapper.get('[data-id="acme.prev"] .ext-rollback').trigger('click')
      await flushPromises()
      const dialog = useNotify().dialog.value as { message?: string; title?: string; confirmText?: string }
      expect(dialog.title).toBe('回復 Navide 外掛')
      expect(dialog.confirmText).toBe('回復')
      expect(dialog.message).toContain('要將 acme.prev 回復到 1.0.0 嗎')
      useNotify().resolveDialog(false)
      await flushPromises()
    })

    it('discloses the bundled Plans scope and risk from the locale', async () => {
      mockBundledPlansAndGit()
      wrapper = mountExtensions()
      await flushPromises()

      const row = wrapper.get('[data-factory-id="navide.plans"]')
      expect(row.get('.ext-manifest-scopes').text()).toBe(
        '檔案範圍（從 Git 儲存庫根目錄起）：讀寫 **/docs/plans/*, .plans/*; 只讀 **/docs/plans/.history/**'
      )
      expect(row.get('.ext-risk-note').text()).toContain('沒有沙盒')
      expect(row.get('.ext-risk-note').text()).toContain('使用者權限')
      expect(row.get('.ext-risk-note').text()).toContain('讀取與寫入計畫文件都由此 Navide 外掛的後端直接進行')
      expect(row.get('.ext-risk-note').text()).toContain('刪除與改名仍經由 Navide 進行')
    })

    it('shows a known Host refusal translated and an unknown one as written', async () => {
      const rollback = vi.fn()
        .mockRejectedValueOnce(
          new Error("Error invoking remote method 'plugins:rollback': Error: plugin transaction already in progress for acme.demo"),
        )
        .mockRejectedValueOnce(
          new Error("Error invoking remote method 'plugins:rollback': Error: Factory package restoration failed: bundle unreadable"),
        )
        .mockRejectedValueOnce(new Error('something unforeseen'))
      mockPlugins({
        listInstalled: vi.fn().mockResolvedValue([
          { id: 'acme.demo', requires: [], sensitive: [], packageVersion: '1.0.1', rollbackKind: 'factory' },
        ]),
        rollback,
      })
      wrapper = mountExtensions()
      await flushPromises()

      const attempt = async (): Promise<string> => {
        await wrapper!.get('[data-id="acme.demo"] .ext-rollback').trigger('click')
        await flushPromises()
        useNotify().resolveDialog(true)
        await flushPromises()
        return wrapper!.get('.ext-error').text()
      }
      expect(await attempt()).toBe('acme.demo 正在安裝、更新或回復中，請等它完成後再試。')
      expect(await attempt()).toBe('無法載入內建版本。 (bundle unreadable)')
      expect(await attempt()).toBe('something unforeseen')
    })
  })

  describe('in ja-JP', () => {
    const original = i18n.global.locale.value
    beforeEach(() => {
      i18n.global.locale.value = 'ja-JP'
    })
    afterEach(() => {
      i18n.global.locale.value = original
    })

    it('discloses that the Plans backend reads and writes directly without a sandbox', async () => {
      mockBundledPlansAndGit()
      wrapper = mountExtensions()
      await flushPromises()

      const risk = wrapper.get('[data-factory-id="navide.plans"] .ext-risk-note').text()
      expect(risk).toContain('サンドボックスはありません')
      expect(risk).toContain('ユーザー権限')
      expect(risk).toContain('読み取りと書き込みはどちらもこの Navide プラグインのバックエンドが直接行い')
      expect(risk).toContain('削除と名前変更は引き続き Navide を経由します')
    })
  })

  it('redraws from the Host after a rollback that failed once the package was switched', async () => {
    // The factory package became active before view restoration threw, so the
    // Host no longer lists the installed row or its rollback.
    const listInstalled = vi
      .fn()
      .mockResolvedValueOnce([
        { id: 'acme.demo', requires: [], sensitive: [], packageVersion: '1.0.1', rollbackKind: 'factory' },
      ])
      .mockResolvedValue([])
    mockPlugins({
      listInstalled,
      rollback: vi.fn().mockRejectedValue(new Error('plugin views did not become ready')),
    })
    wrapper = mountExtensions()
    await flushPromises()

    await wrapper.get('[data-id="acme.demo"] .ext-rollback').trigger('click')
    await flushPromises()
    useNotify().resolveDialog(true)
    await flushPromises()

    expect(wrapper.get('.ext-error').text()).toBe('plugin views did not become ready')
    expect(wrapper.find('[data-id="acme.demo"]').exists()).toBe(false)
  })

  it('says why a removal failed and keeps the row', async () => {
    const api = mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([{ id: 'acme.backend', requires: [], sensitive: [] }]),
      remove: vi.fn().mockRejectedValue(new Error("Error invoking remote method 'plugins:remove': Error: package is in use")),
    })
    wrapper = mountExtensions()
    await flushPromises()

    await wrapper.get('[data-id="acme.backend"] .ext-remove').trigger('click')
    await flushPromises()
    useNotify().resolveDialog(true)
    await flushPromises()

    expect(api.remove).toHaveBeenCalledWith('acme.backend')
    expect(wrapper.get('.ext-error').text()).toBe('package is in use')
    expect(wrapper.find('[data-id="acme.backend"]').exists()).toBe(true)
  })

  it('shows an inventory that fails to load instead of leaving the rejection unhandled', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      mockPlugins({ listInstalled: vi.fn().mockRejectedValue(new Error('backend gone')) })
      wrapper = mountExtensions()
      await flushPromises()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(wrapper.get('.ext-error').text()).toBe('Could not reload the installed Navide plugins: backend gone')
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('shows both the rollback failure and a failed redraw after it', async () => {
    const listInstalled = vi
      .fn()
      .mockResolvedValueOnce([
        { id: 'acme.demo', requires: [], sensitive: [], packageVersion: '1.0.1', rollbackKind: 'factory' },
      ])
      .mockRejectedValue(new Error('backend gone'))
    mockPlugins({
      listInstalled,
      rollback: vi.fn().mockRejectedValue(new Error('plugin views did not become ready')),
    })
    wrapper = mountExtensions()
    await flushPromises()

    await wrapper.get('[data-id="acme.demo"] .ext-rollback').trigger('click')
    await flushPromises()
    useNotify().resolveDialog(true)
    await flushPromises()

    expect(wrapper.findAll('.ext-error').map((banner) => banner.text())).toEqual([
      'plugin views did not become ready',
      'Could not reload the installed Navide plugins: backend gone',
    ])
  })

  it('keeps the Developer Mode local-unpacked warning visible in inventory', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        {
          id: 'acme.local',
          requires: [],
          sensitive: [],
          provenance: 'developer-local-unpacked',
          warning: 'Unsigned local unpacked plugin — Developer Mode only',
        },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()
    expect(wrapper.get('[data-id="acme.local"] .ext-dev-warning').text()).toContain(
      'Developer Mode only'
    )
  })

  it('translates the Developer Mode warning (D1)', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        { id: 'acme.local', requires: [], sensitive: [], provenance: 'developer-local-unpacked', warning: 'Unsigned local unpacked plugin — Developer Mode only' },
      ]),
    })
    i18n.global.locale.value = 'zh-TW'
    try {
      wrapper = mountExtensions()
      await flushPromises()
      expect(wrapper.get('[data-id="acme.local"] .ext-dev-warning').text()).toBe('未簽章的本機資料夾，僅限開發者模式')
    } finally {
      i18n.global.locale.value = 'en-US'
    }
  })

  it('shows each plugin its own manifest permissions and package-version grant', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        {
          id: 'acme.v2',
          packageVersion: '2.4.0',
          requires: ['fs'],
          sensitive: ['fs'],
          manifestPermissions: { system: ['fs'], shell: 'allowlist' },
          packageVersionGrant: {
            packageVersion: '2.4.0',
            system: ['fs', 'ui'],
            shell: 'allowlist',
            highRiskShellConfirmed: true,
          },
        },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()

    const row = wrapper.get('[data-id="acme.v2"]')
    expect(row.find('.ext-manifest-permissions').text()).toContain('fs')
    expect(row.find('.ext-manifest-permissions').text()).toContain('allowlist')
    expect(row.find('.ext-package-grant').text()).toContain('2.4.0')
    expect(row.find('.ext-package-grant').text()).toContain('ui')
    expect(row.find('.ext-package-grant').classes()).not.toContain('ext-package-grant-none')
  })

  it('distinguishes an installed package with no matching grant', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        {
          id: 'acme.v2',
          packageVersion: '2.4.0',
          requires: [],
          sensitive: [],
          manifestPermissions: { system: ['fs'] },
          packageVersionGrant: null,
        },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()

    expect(wrapper.get('.ext-package-grant').text()).toContain('No matching grant')
    expect(wrapper.get('.ext-package-grant').classes()).toContain('ext-package-grant-none')
    expect(wrapper.get('[data-id="acme.v2"] .ext-requires').text()).toBe('Version 2.4.0')
  })



  it('offers an available Registry update before it is staged', async () => {
    mockPlugins({
      checkUpdates: vi.fn().mockResolvedValue([
        { id: 'navide.mini-ide', namespace: 'navide', name: 'mini-ide', latestVersion: '2.0.0' },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()

    const row = wrapper.get('[data-id="navide.mini-ide"]')
    expect(row.find('.ext-update-badge').text()).toContain('2.0.0')
    expect(row.find('.ext-update').exists()).toBe(true)
    expect(row.find('.ext-restart').exists()).toBe(false)
  })

  it('D2: badges whether an update adds permissions, labelled as unverified Registry data', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        { id: 'acme.more', requires: [], sensitive: [], packageVersion: '1.0.0', provenance: 'official-registry' },
        { id: 'acme.same', requires: [], sensitive: [], packageVersion: '1.0.0', provenance: 'official-registry' },
        { id: 'acme.unknown', requires: [], sensitive: [], packageVersion: '1.0.0', provenance: 'official-registry' },
      ]),
      checkUpdates: vi.fn().mockResolvedValue([
        { id: 'acme.more', namespace: 'acme', name: 'more', installedVersion: '1.0.0', latestVersion: '1.1.0', permissionChange: 'more' },
        { id: 'acme.same', namespace: 'acme', name: 'same', installedVersion: '1.0.0', latestVersion: '1.1.0', permissionChange: 'same' },
        { id: 'acme.unknown', namespace: 'acme', name: 'unknown', installedVersion: '1.0.0', latestVersion: '1.1.0' },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()

    const more = wrapper.get('[data-id="acme.more"] .ext-permission-change')
    expect(more.text()).toBe('More permissions')
    expect(more.attributes('title')).toContain('not yet verified')
    expect(wrapper.get('[data-id="acme.same"] .ext-permission-change').text()).toBe('Same permissions')
    expect(wrapper.find('[data-id="acme.unknown"] .ext-permission-change').exists()).toBe(false)
  })

  // User ruling 2026-10-17 (D-d option B): the update asks as on main; the
  // dialog shows the diff, here that nothing changed.
  it('D2: an update that adds no permissions still asks, and the dialog says nothing changed', async () => {
    const commitInstall = vi.fn().mockResolvedValue({ id: 'acme.same', requires: [], restartRequired: true })
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        { id: 'acme.same', requires: [], sensitive: [], packageVersion: '1.0.0', provenance: 'official-registry' },
      ]),
      checkUpdates: vi.fn().mockResolvedValue([
        { id: 'acme.same', namespace: 'acme', name: 'same', installedVersion: '1.0.0', latestVersion: '1.1.0', permissionChange: 'same' },
      ]),
      prepareInstall: vi.fn().mockResolvedValue({
        id: 'acme.same', version: '1.1.0', trustTier: 'signed-verified', sensitive: ['shell'],
        containsBackendExecutable: false, requiresConfirmation: true, publisherId: 'acme',
        requiresPublisherTrust: false, requiresRiskConfirmation: true,
        disclosureDiff: {
          schemaVersion: 1,
          from: { id: 'acme.same', version: '1.0.0', risk: 'high' },
          to: { id: 'acme.same', version: '1.1.0', risk: 'high' },
          added: [], removed: [], unchanged: [{ kind: 'shell', key: 'allowlist', detail: null }], widened: false,
        },
      }),
      commitInstall,
    })
    wrapper = mountExtensions()
    await flushPromises()

    await wrapper.get('[data-id="acme.same"] .ext-update').trigger('click')
    await flushPromises()
    expect(commitInstall).not.toHaveBeenCalled()
    expect(wrapper.get('.ext-trust-dialog .nv-diff').text()).toContain('No permission was added or removed.')
    await wrapper.get('.ext-confirm-risk').trigger('click')
    await flushPromises()
    expect(commitInstall).toHaveBeenCalledWith('acme.same', { publisherConfirmed: false, riskConfirmed: true })
  })

  // An update that needs no confirmation commits directly with no extra
  // notice, exactly as on main (D-d option B).
  it('D2: an update that needs no confirmation commits directly, as on main', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        { id: 'acme.wider', requires: [], sensitive: [], packageVersion: '1.0.0', provenance: 'official-registry' },
      ]),
      checkUpdates: vi.fn().mockResolvedValue([
        { id: 'acme.wider', namespace: 'acme', name: 'wider', installedVersion: '1.0.0', latestVersion: '1.1.0', permissionChange: 'more' },
      ]),
      prepareInstall: vi.fn().mockResolvedValue({
        id: 'acme.wider', version: '1.1.0', trustTier: 'signed-verified', sensitive: [],
        containsBackendExecutable: false, requiresConfirmation: false, publisherId: 'acme',
        requiresPublisherTrust: false, requiresRiskConfirmation: false,
        disclosureDiff: {
          schemaVersion: 1,
          from: { id: 'acme.wider', version: '1.0.0', risk: 'low' },
          to: { id: 'acme.wider', version: '1.1.0', risk: 'low' },
          added: [{ kind: 'system', key: 'ui', detail: null }], removed: [], unchanged: [], widened: true,
        },
      }),
      commitInstall: vi.fn().mockResolvedValue({ id: 'acme.wider', requires: ['ui'], restartRequired: true }),
    })
    wrapper = mountExtensions()
    await flushPromises()

    await wrapper.get('[data-id="acme.wider"] .ext-update').trigger('click')
    await flushPromises()
    expect(wrapper.find('.ext-trust-dialog').exists()).toBe(false)
    expect(useNotify().toasts.value.some((toast) => toast.message.startsWith('acme.wider'))).toBe(false)
  })

  // D-f / RULE ZERO: opening the page reads no activity; a row's activity is
  // read only when the user opens it.
  it('D-f: loads a plugin activity only when its permissions section is opened, adding no element', async () => {
    const activityReport = vi.fn().mockResolvedValue({ ok: false, error: 'Navide Host session is not ready' })
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        { id: 'acme.demo', requires: [], sensitive: [], packageVersion: '1.0.0', provenance: 'official-registry' },
        { id: 'local.dev', requires: [], sensitive: [], packageVersion: '0.1.0', provenance: 'developer-local-unpacked' },
      ]),
      activityReport,
      backendCallConcurrency: vi.fn().mockResolvedValue([]),
    })
    wrapper = mountExtensions()
    await flushPromises()

    expect(activityReport).not.toHaveBeenCalled()
    // RULE ZERO: no new element per row; the existing section only says activity is in it.
    expect(wrapper.findAll('[data-id="acme.demo"] details')).toHaveLength(1)
    expect(wrapper.find('.nv-activity').exists()).toBe(false)
    expect(wrapper.find('.ext-activity-overview-link').exists()).toBe(false)
    expect(wrapper.get('[data-id="acme.demo"] .ext-permission-details summary').text()).toBe('Permissions, grants and activity')
    expect(wrapper.get('[data-id="local.dev"] .ext-permission-details summary').text()).toBe('Permissions and grants')

    const details = wrapper.get('[data-id="acme.demo"] .ext-permission-details')
    ;(details.element as HTMLDetailsElement).open = true
    await details.trigger('toggle')
    await flushPromises()
    expect(activityReport).toHaveBeenCalledWith('acme.demo')
    expect(details.text()).toContain('Activity is not available right now: Navide Host session is not ready')
    await details.get('.ext-activity-overview-link').trigger('click')
    expect(wrapper.emitted('openDisclosureOverview')).toHaveLength(1)

    const local = wrapper.get('[data-id="local.dev"] .ext-permission-details')
    ;(local.element as HTMLDetailsElement).open = true
    await local.trigger('toggle')
    await flushPromises()
    expect(activityReport).toHaveBeenCalledTimes(1)
  })

  it('restarts a staged Registry update without offering a second install', async () => {
    const listInstalled = vi.fn()
      .mockResolvedValueOnce([{ id: 'navide.mini-ide', packageVersion: '1.0.0', pendingCandidateVersion: '2.0.0', requires: [], sensitive: [] }])
      .mockResolvedValueOnce([{ id: 'navide.mini-ide', packageVersion: '2.0.0', requires: [], sensitive: [] }])
    const api = mockPlugins({
      listInstalled,
      restart: vi.fn().mockResolvedValue({ ok: true }),
      checkUpdates: vi.fn().mockResolvedValue([
        { id: 'navide.mini-ide', namespace: 'navide', name: 'mini-ide', latestVersion: '2.0.0' },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()

    const row = wrapper.get('[data-id="navide.mini-ide"]')
    expect(row.find('.ext-candidate').text()).toContain('2.0.0')
    expect(row.find('.ext-update').exists()).toBe(false)
    await row.get('.ext-restart').trigger('click')
    await flushPromises()
    expect(api.restart).toHaveBeenCalledWith('navide.mini-ide')
    expect(row.find('.ext-candidate').exists()).toBe(false)
  })

  it('removes an installed plugin', async () => {
    const api = mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([{ id: 'acme.files', requires: ['fs'], sensitive: ['fs'] }]),
    })
    wrapper = mountExtensions()
    await flushPromises()
    await wrapper.get('[data-id="acme.files"] .ext-remove').trigger('click')
    await flushPromises()
    expect(useNotify().dialog.value?.message).toContain('acme.files')
    expect(useNotify().dialog.value?.danger).toBe(true)
    // One term on the page and in the dialog.
    expect(wrapper.get('[data-id="acme.files"] .ext-remove').text()).toBe('Uninstall')
    expect(useNotify().dialog.value?.confirmText).toBe('Uninstall')
    useNotify().resolveDialog(true)
    await flushPromises()
    expect(api.remove).toHaveBeenCalledWith('acme.files')
  })

  it('keeps the plugin when the removal confirmation is cancelled', async () => {
    const api = mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([{ id: 'acme.files', requires: ['fs'], sensitive: ['fs'] }]),
    })
    wrapper = mountExtensions()
    await flushPromises()
    await wrapper.get('[data-id="acme.files"] .ext-remove').trigger('click')
    await flushPromises()
    useNotify().resolveDialog(false)
    await flushPromises()
    expect(api.remove).not.toHaveBeenCalled()
    expect(wrapper.find('[data-id="acme.files"]').exists()).toBe(true)
  })

  it('disables an installed Navide plugin visibly and offers Enable while it is disabled', async () => {
    const enabledRow = { id: 'acme.demo', requires: [], sensitive: [], packageVersion: '1.2.0', provenance: 'official-registry', disabled: false }
    const disabledRow = { ...enabledRow, disabled: true }
    const listInstalled = vi
      .fn()
      .mockResolvedValueOnce([
        enabledRow,
        { id: 'local.dev', requires: [], sensitive: [], provenance: 'developer-local-unpacked' },
      ])
      .mockResolvedValueOnce([disabledRow])
      .mockResolvedValue([enabledRow])
    const api = mockPlugins({
      listInstalled,
      setDisabled: vi.fn().mockResolvedValue({ id: 'acme.demo', disabled: true }),
    })
    wrapper = mountExtensions()
    await flushPromises()
    let row = wrapper.get('[data-id="acme.demo"]')
    expect(row.find('.ext-disabled-badge').exists()).toBe(false)
    expect(row.find('.ext-enable').exists()).toBe(false)
    // Only rows the Host reports a disabled state for get the switch.
    expect(wrapper.find('[data-id="local.dev"] .ext-disable').exists()).toBe(false)

    await row.get('.ext-disable').trigger('click')
    await flushPromises()
    expect(api.setDisabled).toHaveBeenCalledWith('acme.demo', true)
    row = wrapper.get('[data-id="acme.demo"]')
    expect(row.get('.ext-disabled-badge').text()).toBe('Disabled')
    expect(row.find('.ext-disable').exists()).toBe(false)
    // Disabling keeps the package: removing it stays a separate action.
    expect(row.find('.ext-remove').exists()).toBe(true)

    await row.get('.ext-enable').trigger('click')
    await flushPromises()
    expect(api.setDisabled).toHaveBeenLastCalledWith('acme.demo', false)
    row = wrapper.get('[data-id="acme.demo"]')
    expect(row.find('.ext-disabled-badge').exists()).toBe(false)
    expect(row.find('.ext-disable').exists()).toBe(true)
  })
})

// Review MED-2 on #396: a plugin's own text cannot hide or reorder the listing.
describe('ExtensionsPane invisible characters', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  it('spells out invisible characters in installed ids, pack names, members and the uninstall dialog', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([{ id: 'acme.\u202edemo', requires: [], sensitive: [], provenance: 'official-registry' }]),
      listPacks: vi.fn().mockResolvedValue([
        { id: 'acme.pack', displayName: 'Web\u202e Pack', version: '1.0.0', members: ['acme.he\u200bllo'], installedByPack: ['acme.he\u200bllo'] },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()
    const row = wrapper.get('[data-pack-id="acme.pack"]')
    expect(row.get('.ext-id').text()).toBe('Web\\u{202e} Pack')
    expect(row.get('.ext-pack-includes').text()).toBe('Includes: acme.he\\u{200b}llo')
    expect(wrapper.text()).toContain('acme.\\u{202e}demo')
    // The letter tile shows the spelled-out form's first character, not the override.
    expect(wrapper.get('[data-id="acme.\u202edemo"] .mkt-icon').text()).toBe('\\')
    await row.get('.ext-pack-remove').trigger('click')
    await flushPromises()
    const dialog = wrapper.get('.pack-uninstall-dialog')
    expect(dialog.get('h4').text()).toBe('Uninstall “Web\\u{202e} Pack”?')
    expect(dialog.get('.pack-uninstall-member').text()).toContain('acme.he\\u{200b}llo')
    expect(wrapper.text()).not.toMatch(/[\u200b\u202e]/)
  })
})

describe('ExtensionsPane source badge (K2)', () => {
  let wrapper: VueWrapper | undefined
  afterEach(() => {
    wrapper?.unmount()
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  it('badges each installed row by the Host\'s source and never guesses one', async () => {
    // The Testplace row's expiry is read against the clock: pin it.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-20T00:00:00Z'))
    onTestFinished(() => {
      vi.useRealTimers()
    })
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        { id: 'acme.registry', requires: [], sensitive: [], provenance: 'official-registry' },
        { id: 'acme.folder', requires: [], sensitive: [], provenance: 'developer-local-unpacked' },
        { id: 'acme.file', requires: [], sensitive: [], source: 'local-unsigned' },
        { id: 'acme.test', requires: [], sensitive: [], provenance: 'official-registry', source: 'testplace', expiresAt: '2027-01-17T00:00:00Z' },
        { id: 'acme.unknown', requires: [], sensitive: [] },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()
    const source = (id: string) => wrapper!.find(`[data-id="${id}"] .nv-source-badge`)
    // No source means the Host could not name one (an unknown channel): no badge.
    expect(source('acme.registry').exists()).toBe(false)
    expect(source('acme.folder').exists()).toBe(false)
    expect(source('acme.file').attributes('data-source')).toBe('local-unsigned')
    expect(source('acme.test').attributes('data-source')).toBe('testplace')
    expect(source('acme.test').text()).toContain('2027-01-17')
    expect(source('acme.unknown').exists()).toBe(false)
  })
})

describe('ExtensionsPane expired Testplace builds (D3)', () => {
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

  it('lists an expired build with its three choices and never removes it unasked', async () => {
    const keepExpiredTestplace = vi.fn().mockResolvedValue({ ok: true })
    const adoptTestplaceRelease = vi.fn().mockResolvedValue({ adopted: false })
    const prepareInstall = vi.fn().mockRejectedValue(new Error('extension not found: HTTP 404'))
    const api = mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([]),
      expiredTestplace: vi.fn().mockResolvedValue([
        { id: 'acme.kept', version: '1.0.0', expiresAt: '2026-10-01T00:00:00Z', artifactDigest: 'a'.repeat(64), canKeep: true },
        { id: 'acme.down', version: '2.0.0', expiresAt: '2026-10-02T00:00:00Z', canKeep: false },
        { id: 'acme.pulled', version: '3.0.0', expiresAt: '2026-12-02T00:00:00Z', canKeep: false, withdrawn: true, keepRefusal: 'withdrawn' },
        { id: 'acme.unsure', version: '4.0.0', expiresAt: '2026-10-03T00:00:00Z', canKeep: false, keepRefusal: 'unreachable' },
        { id: 'acme.signedout', version: '5.0.0', expiresAt: '2026-10-03T00:00:00Z', canKeep: false, keepRefusal: 'signed-out' },
        { id: 'acme.gone', version: '6.0.0', expiresAt: '2026-10-03T00:00:00Z', canKeep: false, keepRefusal: 'not-a-tester' },
        { id: 'acme.old', version: '7.0.0', expiresAt: '2026-10-03T00:00:00Z', canKeep: false, keepRefusal: 'registry-outdated' },
      ]),
      keepExpiredTestplace,
      prepareInstall,
      adoptTestplaceRelease,
    })
    wrapper = mountExtensions()
    await flushPromises()
    const kept = wrapper.get('[data-expired-id="acme.kept"]')
    expect(kept.text()).toContain('The test build acme.kept 1.0.0 expired on 2026-10-01 and was stopped; its settings and data are kept.')
    expect(kept.find('.ext-testplace-marketplace').exists()).toBe(true)
    expect(kept.find('.ext-testplace-remove').exists()).toBe(true)
    // A takedown (or any failure besides the expiry) is never offered "keep using".
    const down = wrapper.get('[data-expired-id="acme.down"]')
    expect(down.find('.ext-testplace-keep').exists()).toBe(false)
    expect(down.text()).toContain('cannot be kept')
    // S8 T-MED-1: a withdrawn build says so; an unconfirmed one says why it cannot be kept now.
    const pulled = wrapper.get('[data-expired-id="acme.pulled"]')
    expect(pulled.text()).toContain('was withdrawn by its developer or by Navide')
    expect(pulled.find('.ext-testplace-keep').exists()).toBe(false)
    expect(pulled.find('.ext-testplace-remove').exists()).toBe(true)
    const unsure = wrapper.get('[data-expired-id="acme.unsure"]')
    expect(unsure.find('.ext-testplace-keep').exists()).toBe(false)
    expect(unsure.text()).toContain('cannot be reached right now')
    // S8 LOW-R3-2: the advice follows the reason.
    expect(wrapper.get('[data-expired-id="acme.signedout"]').text()).toContain('Sign in with your Navide Cloud account')
    expect(wrapper.get('[data-expired-id="acme.gone"]').text()).toContain('no longer a tester')
    expect(wrapper.get('[data-expired-id="acme.old"]').text()).toContain('too old')
    expect(api.remove).not.toHaveBeenCalled()

    await kept.get('.ext-testplace-keep').trigger('click')
    await flushPromises()
    expect(useNotify().dialog.value?.message).toContain('acme.kept')
    useNotify().resolveDialog(true)
    await flushPromises()
    expect(keepExpiredTestplace).toHaveBeenCalledWith('acme.kept')

    // "Install the Navide Marketplace version": a promoted build of the same
    // digest is adopted in place; otherwise the normal verified install runs.
    adoptTestplaceRelease.mockResolvedValueOnce({ adopted: true })
    await kept.get('.ext-testplace-marketplace').trigger('click')
    await flushPromises()
    expect(adoptTestplaceRelease).toHaveBeenCalledWith('acme.kept')
    expect(prepareInstall).not.toHaveBeenCalled()
    await kept.get('.ext-testplace-marketplace').trigger('click')
    await flushPromises()
    expect(prepareInstall).toHaveBeenCalledWith({ namespace: 'acme', name: 'kept' })
  })

  it('reminds from 7 days before expiry and marks a kept build as expired', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        { id: 'acme.soon', requires: [], sensitive: [], provenance: 'official-registry', source: 'testplace', expiresAt: '2026-10-25T00:00:00Z', testplaceVia: 'invite' },
        { id: 'acme.later', requires: [], sensitive: [], provenance: 'official-registry', source: 'testplace', expiresAt: '2026-12-25T00:00:00Z' },
        { id: 'acme.past', requires: [], sensitive: [], provenance: 'official-registry', source: 'testplace', expiresAt: '2026-10-01T00:00:00Z' },
      ]),
      expiredTestplace: vi.fn().mockResolvedValue([]),
    })
    wrapper = mountExtensions()
    await flushPromises()
    expect(wrapper.get('[data-id="acme.soon"] .ext-testplace-expiring').text()).toContain('expires in 5 days (2026-10-25)')
    expect(wrapper.get('[data-id="acme.soon"] .nv-source-badge').text()).toBe('Test build: automated scan only, expires 2026-10-25')
    expect(wrapper.find('[data-id="acme.later"] .ext-testplace-expiring').exists()).toBe(false)
    expect(wrapper.get('[data-id="acme.past"] .ext-testplace-kept').text()).toContain('kept in use')
    expect(wrapper.get('[data-id="acme.past"] .nv-source-badge').text()).toBe('Test build, expired 2026-10-01 (kept in use)')
  })
})

describe('ExtensionsPane: Developer Mode settings changed outside Navide (A2-5, G5)', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  it('shows the notice and marks the folder another program added, with Reload to consent again', async () => {
    const reloadDeveloperPlugin = vi.fn().mockResolvedValue({ reloaded: false, requiresConsent: false })
    mockPlugins({
      developerMode: vi.fn().mockResolvedValue({
        enabled: true,
        externalChange: { detectedAt: '2026-10-21T01:00:00.000Z', modifiedAt: null },
        folders: [{ pluginId: 'evil.two', path: '/tmp/other', consentedAt: '', loaded: false, externallyChanged: true }],
      }),
      reloadDeveloperPlugin,
    })
    const wrapper = mountExtensions()
    await flushPromises()
    const notice = wrapper.get('.ext-devmode-external')
    expect(notice.attributes('role')).toBe('alert')
    expect(notice.text().startsWith(i18n.global.t('settings.extensions.developerMode.externalChange', { time: 'T' }).split('T')[0]!)).toBe(true)
    expect(wrapper.get('.ext-devmode-external-folder').text()).toBe(i18n.global.t('settings.extensions.developerMode.externallyChanged'))
    await wrapper.get('.ext-devmode-folder .ext-devmode-reload').trigger('click')
    await flushPromises()
    expect(reloadDeveloperPlugin).toHaveBeenCalledWith('evil.two')
    wrapper.unmount()
  })

  it('says nothing more when nothing was changed outside Navide', async () => {
    mockPlugins({ developerMode: vi.fn().mockResolvedValue({ enabled: true, folders: [] }) })
    const wrapper = mountExtensions()
    await flushPromises()
    expect(wrapper.find('.ext-devmode-external').exists()).toBe(false)
    wrapper.unmount()
  })
})
