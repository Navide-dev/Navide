// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    listPacks: vi.fn().mockResolvedValue([]),
    removePack: vi.fn().mockResolvedValue({ removed: true }),
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
    expect(wrapper.get('.pack-uninstall-confirm').text()).toBe('Uninstall pack and 1 Navide plugin(s)')
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

  it('shows an opted-out bundled Git package and restores it explicitly', async () => {
    const listFactoryPackages = vi
      .fn()
      .mockResolvedValueOnce([
        { id: 'navide.git', version: '0.1.0', active: false, optedOut: true },
      ])
      .mockResolvedValueOnce([
        { id: 'navide.git', version: '0.1.0', active: true, optedOut: false },
      ])
    const api = mockPlugins({ listFactoryPackages })
    wrapper = mountExtensions()
    await flushPromises()

    const row = wrapper.get('[data-factory-id="navide.git"]')
    expect(row.text()).toContain('Bundled Git')
    expect(row.text()).toContain('Removed')
    await row.get('.ext-restore').trigger('click')
    await flushPromises()

    expect(api.restoreFactoryPackage).toHaveBeenCalledWith('navide.git')
    expect(wrapper.get('[data-factory-id="navide.git"]').text()).toContain('Active')
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

  it('keeps Restore, not the promote-back restart, on an opted-out bundled row', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([]),
      listFactoryPackages: vi.fn().mockResolvedValue([
        { id: 'navide.mini-ide', version: '0.2.11', active: false, optedOut: true },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()

    const row = wrapper.get('[data-factory-id="navide.mini-ide"]')
    expect(row.find('.ext-restore').exists()).toBe(true)
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

  it('shows the main process message for a failed bundled restore, not the IPC wrapper', async () => {
    mockPlugins({
      listFactoryPackages: vi.fn().mockResolvedValue([
        { id: 'navide.mini-ide', version: '0.2.11', active: false, optedOut: true },
      ]),
      restoreFactoryPackage: vi.fn().mockRejectedValue(
        new Error("Error invoking remote method 'plugins:restoreFactoryPackage': Error: an installed package already owns this plugin id"),
      ),
    })
    wrapper = mountExtensions()
    await flushPromises()

    await wrapper.get('[data-factory-id="navide.mini-ide"] .ext-restore').trigger('click')
    await flushPromises()

    expect(wrapper.get('.ext-error').text()).toBe('an installed package already owns this plugin id')
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
    const api = mockPlugins()
    wrapper = mountExtensions()
    await flushPromises()
    await wrapper.get('[data-id="navide.mini-ide"] .ext-remove').trigger('click')
    await flushPromises()
    expect(useNotify().dialog.value?.message).toContain('navide.mini-ide')
    expect(useNotify().dialog.value?.danger).toBe(true)
    // One term on the page and in the dialog.
    expect(wrapper.get('[data-id="navide.mini-ide"] .ext-remove').text()).toBe('Uninstall')
    expect(useNotify().dialog.value?.confirmText).toBe('Uninstall')
    useNotify().resolveDialog(true)
    await flushPromises()
    expect(api.remove).toHaveBeenCalledWith('navide.mini-ide')
  })

  it('keeps the plugin when the removal confirmation is cancelled', async () => {
    const api = mockPlugins()
    wrapper = mountExtensions()
    await flushPromises()
    await wrapper.get('[data-id="navide.mini-ide"] .ext-remove').trigger('click')
    await flushPromises()
    useNotify().resolveDialog(false)
    await flushPromises()
    expect(api.remove).not.toHaveBeenCalled()
    expect(wrapper.find('[data-id="navide.mini-ide"]').exists()).toBe(true)
  })
})
