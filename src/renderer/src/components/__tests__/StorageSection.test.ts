// @vitest-environment happy-dom
// StorageSection + useStorageUsage together: the section draws what the
// composable holds, so the two are exercised through one host component the
// way the Resource Manager hosts them.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import StorageSection from '../StorageSection.vue'
import { useStorageUsage } from '../../composables/useStorageUsage'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'

function report() {
  return {
    generatedAt: '2026-07-29T00:00:00.000Z',
    staleDays: 30,
    totalBytes: 3_500_000_000,
    disk: { totalBytes: 500_000_000_000, freeBytes: 120_000_000_000 },
    groups: [
      {
        id: 'appData',
        rootPath: '/Users/test/Library/Application Support/Navide',
        totalBytes: 1_200_000_000,
        items: [
          {
            id: 'rotatedLogs',
            bytes: 900_000_000,
            fileCount: 4200,
            paths: ['/Users/test/Library/Application Support/Navide/Cache'],
            risk: 'safe',
            cleanable: true,
            handledBy: 'backend',
            note: null,
          },
          {
            id: 'storeBackups',
            bytes: 300_000_000,
            fileCount: 120,
            paths: ['/Users/test/Library/Application Support/Navide/logs'],
            risk: 'safe',
            cleanable: true,
            handledBy: 'backend',
            note: 'Rotated daily',
          },
          {
            id: 'appDataOther',
            bytes: 10_000_000,
            fileCount: 8,
            paths: ['/Users/test/Library/Application Support/Navide/sessions'],
            risk: 'danger',
            cleanable: false,
            handledBy: 'backend',
            note: null,
          },
        ],
      },
      {
        id: 'electron',
        rootPath: '/Users/test/Library/Application Support/Navide',
        totalBytes: 800_000_000,
        items: [
          {
            id: 'chromiumCache',
            bytes: 800_000_000,
            fileCount: 900,
            paths: ['/Users/test/Library/Application Support/Navide/Cache/Cache_Data'],
            risk: 'safe',
            cleanable: true,
            handledBy: 'electron',
            note: null,
          },
        ],
      },
      {
        id: 'workspaces',
        rootPath: '/Users/test/code',
        totalBytes: 1_500_000_000,
        items: [
          {
            id: 'pipelineLogs',
            bytes: 1_500_000_000,
            fileCount: 90_000,
            paths: ['/Users/test/code/demo/node_modules'],
            risk: 'caution',
            cleanable: true,
            handledBy: 'backend',
            note: null,
          },
        ],
      },
    ],
    errors: [{ path: '/Users/test/Library/Caches/locked', message: 'permission denied' }],
  }
}

/** Hosts the composable the way ResourceManagerModal does. */
const Host = defineComponent({
  props: { backend: { type: Object, required: true } },
  setup(props) {
    const storage = useStorageUsage({
      backend: props.backend as never,
      workspacePaths: () => ['/Users/test/code/demo'],
    })
    return () => h(StorageSection, { storage })
  },
})

async function mountSection(opts: { rejectCleanup?: Error; scan?: boolean } = {}) {
  const mock = createMockBackend('connected')
  mock.setResponse('storage.usage', report())
  mock.setResponse('storage.cleanup', { totalFreedBytes: 1_200_000_000, results: [] })
  if (opts.rejectCleanup) {
    // The real backend.send REJECTS on timeout — it does not resolve ok:false.
    const inner = mock.backend.send
    const failure = opts.rejectCleanup
    ;(mock.backend as { send: typeof inner }).send = ((
      type: string,
      payload: Record<string, unknown>,
      timeoutMs?: number
    ) =>
      type === 'storage.cleanup'
        ? Promise.reject(failure)
        : inner(type, payload, timeoutMs)) as typeof inner
  }
  const wrapper = mount(Host, {
    props: { backend: mock.backend },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  if (opts.scan !== false) {
    await wrapper.get('[data-act="rescan"]').trigger('click')
    await flushPromises()
  }
  return { wrapper, mock }
}

describe('StorageSection', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  // The scan walks several large trees, so nothing may ask for it on mount.
  it('stays collapsed and unscanned until asked', async () => {
    const mounted = await mountSection({ scan: false })
    wrapper = mounted.wrapper
    expect(mounted.mock.sent.filter((s) => s.type === 'storage.usage')).toHaveLength(0)
    expect(wrapper.get('[data-part="storage"]').attributes('data-open')).toBe('false')
    expect(wrapper.find('[data-part="storage-body"]').exists()).toBe(false)
    expect(wrapper.get('[data-part="storage-summary"]').text()).toBe(
      i18n.global.t('resource.storage.unscanned')
    )
    expect(wrapper.get('[data-act="rescan"]').text()).toBe(i18n.global.t('resource.storage.scan'))
  })

  it('scans on request, opens, and renders every group and item', async () => {
    const mounted = await mountSection()
    wrapper = mounted.wrapper

    const scans = mounted.mock.sent.filter((s) => s.type === 'storage.usage')
    expect(scans).toHaveLength(1)
    expect(scans[0].payload).toEqual({
      workspacePaths: ['/Users/test/code/demo'],
      staleDays: 30,
    })
    expect(wrapper.get('[data-part="storage"]').attributes('data-open')).toBe('true')
    expect(wrapper.get('[data-part="storage-summary"]').text()).toContain('3.3 GB')
    // Safe cleanable: rotatedLogs + storeBackups + chromiumCache = 2 GB.
    expect(wrapper.get('[data-part="storage-summary"]').text()).toContain('1.9 GB')

    expect(wrapper.findAll('.su-item')).toHaveLength(5)
    const cache = wrapper.get('[data-item-id="rotatedLogs"]')
    // Labels resolve through resource.storage.item.<id>.label.
    expect(cache.get('.su-item-label').text()).toBe('Rotated backend logs')
    expect(cache.get('.su-size').text()).toBe('858 MB')
    expect(cache.get('.su-count').text()).toContain('4200')
    expect(cache.get('.su-risk').text()).toBe('Safe')
    // The backend note renders as secondary text.
    expect(wrapper.get('[data-item-id="storeBackups"]').get('.su-item-note').text()).toBe(
      'Rotated daily'
    )
    // One bar segment per group, sized by share of the total.
    const segs = wrapper.findAll('[data-part="storage-bar"] .su-bar-seg')
    expect(segs.map((s) => s.attributes('data-group'))).toEqual(['appData', 'electron', 'workspaces'])
    expect(segs[2].attributes('style')).toContain('42.9%')
    // Permission problems are a warning, not a failed scan.
    expect(wrapper.get('.su-warnings').text()).toContain('permission denied')
    expect(wrapper.find('.su-error').exists()).toBe(false)
  })

  it('collapses and re-opens on the header toggle without rescanning', async () => {
    const mounted = await mountSection()
    wrapper = mounted.wrapper
    await wrapper.get('[data-act="toggle-storage"]').trigger('click')
    expect(wrapper.find('[data-part="storage-body"]').exists()).toBe(false)
    await wrapper.get('[data-act="toggle-storage"]').trigger('click')
    expect(wrapper.find('[data-part="storage-body"]').exists()).toBe(true)
    expect(mounted.mock.sent.filter((s) => s.type === 'storage.usage')).toHaveLength(1)
  })

  it('sorts items inside a group by size descending', async () => {
    const mounted = await mountSection()
    wrapper = mounted.wrapper
    // Groups render in backend order, so the first three rows are the appData group.
    const ids = wrapper
      .findAll('[data-item-id]')
      .map((el) => el.attributes('data-item-id'))
      .slice(0, 3)
    expect(ids).toEqual(['rotatedLogs', 'storeBackups', 'appDataOther'])
  })

  it('renders no checkbox for non-cleanable items', async () => {
    const mounted = await mountSection()
    wrapper = mounted.wrapper
    expect(wrapper.get('[data-item-id="appDataOther"]').find('.su-check').exists()).toBe(false)
    expect(wrapper.get('[data-item-id="appDataOther"]').classes()).toContain('su-item-locked')
    expect(wrapper.get('[data-item-id="rotatedLogs"]').find('.su-check').exists()).toBe(true)
  })

  it('cleans only safe cleanable items, and never sends electron-handled ids to the backend', async () => {
    const clearElectronCaches = vi
      .fn()
      .mockResolvedValue({ ok: true, freedBytes: 800_000_000, error: null })
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      storage: { clearElectronCaches },
    }
    const mounted = await mountSection()
    wrapper = mounted.wrapper

    await wrapper.get('[data-act="clean-safe"]').trigger('click')
    await flushPromises()
    // One summary confirm, listing exactly the safe cleanable items.
    const confirmIds = wrapper
      .findAll('[data-confirm-id]')
      .map((el) => el.attributes('data-confirm-id'))
    expect(confirmIds).toEqual(['rotatedLogs', 'storeBackups', 'chromiumCache'])

    await wrapper.get('.su-confirm-ok').trigger('click')
    await flushPromises()

    const cleanups = mounted.mock.sent.filter((s) => s.type === 'storage.cleanup')
    expect(cleanups).toHaveLength(1)
    // chromiumCache is handledBy: 'electron' → bridge only.
    expect(cleanups[0].payload.itemIds).toEqual(['rotatedLogs', 'storeBackups'])
    expect(clearElectronCaches).toHaveBeenCalledWith({ chromium: true, updater: false })

    // Freed bytes are summed across both paths, then the section rescans.
    expect(wrapper.get('.su-result').text()).toContain('1.9 GB')
    expect(mounted.mock.sent.filter((s) => s.type === 'storage.usage')).toHaveLength(2)
  })

  it('surfaces a clear message when the electron cache bridge is missing', async () => {
    const mounted = await mountSection()
    wrapper = mounted.wrapper

    await wrapper.get('[data-act="clean-safe"]').trigger('click')
    await flushPromises()
    await wrapper.get('.su-confirm-ok').trigger('click')
    await flushPromises()

    expect(wrapper.get('.su-cleanup-warning').text()).toContain('desktop bridge is unavailable')
  })

  it('still reports freed bytes when the electron pass only partially succeeds', async () => {
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      storage: {
        clearElectronCaches: vi.fn().mockResolvedValue({
          ok: false,
          freedBytes: 800_000_000,
          error: 'An update download is in progress — the updater cache was left untouched.',
        }),
      },
    }
    const mounted = await mountSection()
    wrapper = mounted.wrapper

    await wrapper.get('[data-act="clean-safe"]').trigger('click')
    await flushPromises()
    await wrapper.get('.su-confirm-ok').trigger('click')
    await flushPromises()

    expect(wrapper.get('.su-result').text()).toContain('1.9 GB')
    expect(wrapper.get('.su-cleanup-warning').text()).toContain('update download is in progress')
    expect(wrapper.find('.su-failures').exists()).toBe(false)
  })

  it('still clears the electron caches when the backend cleanup request rejects', async () => {
    const clearElectronCaches = vi
      .fn()
      .mockResolvedValue({ ok: true, freedBytes: 800_000_000, error: null })
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      storage: { clearElectronCaches },
    }
    const mounted = await mountSection({ rejectCleanup: new Error('request timed out') })
    wrapper = mounted.wrapper

    await wrapper.get('[data-act="clean-safe"]').trigger('click')
    await flushPromises()
    await wrapper.get('.su-confirm-ok').trigger('click')
    await flushPromises()

    // The two passes are independent: the electron pass still ran and its
    // bytes still counted…
    expect(clearElectronCaches).toHaveBeenCalledWith({ chromium: true, updater: false })
    expect(wrapper.get('.su-result').text()).toContain('763 MB')
    // …while the failing pass is named so the user knows which one it was.
    expect(wrapper.get('.su-error').text()).toContain('Backend cleanup failed')
    expect(wrapper.get('.su-error').text()).toContain('request timed out')
  })

  it('enables "Clean Selected" only once a non-safe item is checked', async () => {
    const mounted = await mountSection()
    wrapper = mounted.wrapper

    const cleanSelected = wrapper.get('[data-act="clean-selected"]')
    expect(cleanSelected.attributes('disabled')).toBeDefined()

    // A safe item alone is not enough — that is what "Clean Safe Items" is for.
    await wrapper.get('[data-item-id="rotatedLogs"] .su-check').setValue(true)
    expect(wrapper.get('[data-act="clean-selected"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-item-id="pipelineLogs"] .su-check').setValue(true)
    expect(wrapper.get('[data-act="clean-selected"]').attributes('disabled')).toBeUndefined()

    await wrapper.get('[data-act="clean-selected"]').trigger('click')
    await flushPromises()
    expect(
      wrapper.findAll('[data-confirm-id]').map((el) => el.attributes('data-confirm-id'))
    ).toEqual(['rotatedLogs', 'pipelineLogs'])
  })

  it('cancelling the confirm deletes nothing', async () => {
    const mounted = await mountSection()
    wrapper = mounted.wrapper
    await wrapper.get('[data-act="clean-safe"]').trigger('click')
    await wrapper.get('.su-confirm-cancel').trigger('click')
    await flushPromises()
    expect(wrapper.find('.su-confirm').exists()).toBe(false)
    expect(mounted.mock.sent.filter((s) => s.type === 'storage.cleanup')).toHaveLength(0)
  })

  it('opens for the first scan so the skeleton is visible, and requests the long timeout', async () => {
    const mock = createMockBackend('connected')
    let release: (() => void) | undefined
    mock.setResponse('storage.usage', report())
    const inner = mock.backend.send
    ;(mock.backend as { send: typeof inner }).send = ((type: string, payload: Record<string, unknown>, timeoutMs?: number) =>
      type === 'storage.usage'
        ? new Promise((resolve) => { release = () => resolve(inner(type, payload, timeoutMs)) })
        : inner(type, payload, timeoutMs)) as typeof inner
    wrapper = mount(Host, { props: { backend: mock.backend }, global: { plugins: [i18n] } })
    await wrapper.get('[data-act="rescan"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-part="storage"]').attributes('data-open')).toBe('true')
    expect(wrapper.find('.su-skeleton').exists()).toBe(true)
    release?.()
    await flushPromises()
    expect(wrapper.find('.su-skeleton').exists()).toBe(false)
    // A full disk walk is far slower than the default request timeout.
    expect(mock.sent.find((s) => s.type === 'storage.usage')?.timeoutMs).toBe(120_000)
  })

  it('reopens a collapsed section when a cleanup started from the header finishes', async () => {
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      storage: { clearElectronCaches: vi.fn().mockResolvedValue({ ok: true, freedBytes: 0, error: null }) },
    }
    const mounted = await mountSection()
    wrapper = mounted.wrapper
    await wrapper.get('[data-act="toggle-storage"]').trigger('click')
    expect(wrapper.get('[data-part="storage"]').attributes('data-open')).toBe('false')
    await wrapper.get('[data-act="clean-safe"]').trigger('click')
    await wrapper.get('.su-confirm-ok').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-part="storage"]').attributes('data-open')).toBe('true')
    expect(wrapper.get('.su-result').text()).toContain('1.1 GB')
    expect(mounted.mock.sent.find((s) => s.type === 'storage.cleanup')?.timeoutMs).toBe(120_000)
  })

  it('shows a failed rescan in the header even though the old report is kept', async () => {
    const mounted = await mountSection()
    wrapper = mounted.wrapper
    mounted.mock.setResponse('storage.usage', {})
    await wrapper.get('[data-act="rescan"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-part="storage-summary"]').text()).toContain('storage scan failed')
    expect(wrapper.get('[data-part="storage-summary"]').classes()).toContain('su-sub-error')
    expect(wrapper.findAll('.su-item')).toHaveLength(5)
  })

  it('refuses to scan while the backend is away', async () => {
    const mock = createMockBackend('starting')
    mock.setResponse('storage.usage', report())
    wrapper = mount(Host, { props: { backend: mock.backend }, global: { plugins: [i18n] } })
    await flushPromises()
    expect(wrapper.get('[data-act="rescan"]').attributes('disabled')).toBeDefined()
    // Even a programmatic scan is refused rather than queued for 120s.
    await wrapper.get('[data-act="rescan"]').trigger('click')
    await flushPromises()
    expect(mock.sent.filter((s) => s.type === 'storage.usage')).toHaveLength(0)
  })

  it('warns in the confirm when a danger item is included', async () => {
    const r = report()
    r.groups[2].items[0].risk = 'danger'
    const mounted = await mountSection()
    wrapper = mounted.wrapper
    mounted.mock.setResponse('storage.usage', r)
    await wrapper.get('[data-act="rescan"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-item-id="pipelineLogs"] .su-check').setValue(true)
    await wrapper.get('[data-act="clean-selected"]').trigger('click')
    expect(wrapper.find('.su-confirm-danger').exists()).toBe(true)
    await wrapper.get('.su-confirm-cancel').trigger('click')
    expect(wrapper.find('.su-confirm-danger').exists()).toBe(false)
  })

  it('drops the selection of an item a rescan no longer reports', async () => {
    const mounted = await mountSection()
    wrapper = mounted.wrapper
    await wrapper.get('[data-item-id="pipelineLogs"] .su-check').setValue(true)
    expect(wrapper.get('[data-act="clean-selected"]').attributes('disabled')).toBeUndefined()
    const r = report()
    r.groups = r.groups.slice(0, 2)
    mounted.mock.setResponse('storage.usage', r)
    await wrapper.get('[data-act="rescan"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-item-id="pipelineLogs"]').exists()).toBe(false)
    expect(wrapper.get('[data-act="clean-selected"]').attributes('disabled')).toBeDefined()
  })

  it('expands paths on request and collapses the home directory to ~', async () => {
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      getHomeDir: vi.fn().mockResolvedValue('/Users/test'),
    }
    const mounted = await mountSection()
    wrapper = mounted.wrapper
    const item = wrapper.get('[data-item-id="pipelineLogs"]')
    expect(item.find('.su-paths').exists()).toBe(false)
    await item.get('.su-paths-toggle').trigger('click')
    expect(wrapper.get('[data-item-id="pipelineLogs"] .su-paths').text()).toBe('~/code/demo/node_modules')
    expect(wrapper.get('.su-warn-path').text()).toBe('~/Library/Caches/locked')
  })

  it('rescans with the new threshold when staleDays changes', async () => {
    const mounted = await mountSection()
    wrapper = mounted.wrapper

    await wrapper.get('[data-act="stale-days"]').setValue('90')
    await flushPromises()

    const scans = mounted.mock.sent.filter((s) => s.type === 'storage.usage')
    expect(scans).toHaveLength(2)
    expect(scans[1].payload.staleDays).toBe(90)
  })

  it('treats a payload without groups as a failed scan, not a crash', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('storage.usage', {})
    wrapper = mount(Host, { props: { backend: mock.backend }, global: { plugins: [i18n] } })
    await wrapper.get('[data-act="rescan"]').trigger('click')
    await flushPromises()
    // The first scan opened the section; the error shows in both places.
    expect(wrapper.get('[data-part="storage"]').attributes('data-open')).toBe('true')
    expect(wrapper.get('[data-part="storage-summary"]').text()).toContain('storage scan failed')
    expect(wrapper.get('.su-error').text()).toContain('storage scan failed')
    expect(wrapper.find('.su-skeleton').exists()).toBe(false)
  })

  it('renders no untranslated i18n keys in either locale', async () => {
    for (const locale of ['zh-TW', 'en-US'] as const) {
      i18n.global.locale.value = locale
      const mounted = await mountSection()
      expect(mounted.wrapper.text()).not.toMatch(/resource\.storage\.[a-zA-Z.-]+/)
      mounted.wrapper.unmount()
    }
    i18n.global.locale.value = 'en-US'
  })
})
