// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import CloudSubtabs, { type CloudSubtab } from '../cloud/CloudSubtabs.vue'
import CloudInventorySection from '../cloud/CloudInventorySection.vue'
import CloudDevicesSection from '../cloud/CloudDevicesSection.vue'
import ShareLinksPane from '../cloud/ShareLinksPane.vue'
import SyncSettings from '../SyncSettings.vue'
import { resetSyncInventoryForTest } from '../../composables/useSyncInventory'

const row = (itemId: string, extra: Record<string, unknown>) => ({ itemId, state: 'in-sync', ...extra })

const inventory = {
  status: 'ok',
  scopes: {
    prompts: {
      scope: 'prompts',
      status: 'ok',
      items: [
        row('a', { local: { present: true }, remote: { present: true, readable: true, deviceId: 'dev-mac', updatedAt: '2026-10-11T05:00:00Z' } }),
        row('b', { local: { present: true }, remote: null, state: 'local-only' }),
      ],
    },
    mcp: { scope: 'mcp', status: 'ok', items: [] },
    skills: { scope: 'skills', status: 'ok', items: [] },
  },
  devices: [{ deviceId: 'dev-mac', deviceName: 'Studio Mac', lastSeenAt: '', lastWriteAt: '2026-10-11T05:00:00Z' }],
  scopeEnabled: { prompts: true, mcp: true, skills: false },
}

function mockBackend(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    'sync.status': {
      ok: true,
      payload: {
        available: ['prompts', 'mcp', 'skills'],
        scopes: { prompts: true, mcp: true, skills: false },
        hasKey: true,
        conflicts: 0,
        link: { state: 'connected' },
      },
    },
    'sync.conflicts': { ok: true, payload: { conflicts: [] } },
    'sync.inventory': { ok: true, payload: inventory },
    ...overrides,
  }
  const send = vi.fn(
    async (type: string, _payload?: unknown) =>
      responses[type] ?? { ok: false, error: { message: `Unsupported message type: '${type}'` } },
  )
  const on = vi.fn(() => () => {})
  return { backend: { send, on } as never, send }
}

/** The cross-device tab body as SettingsModal composes it. */
function page(backend: never) {
  return defineComponent({
    setup() {
      const tab = ref<CloudSubtab>('sync')
      return () =>
        h(
          CloudSubtabs,
          { modelValue: tab.value, 'onUpdate:modelValue': (v: CloudSubtab) => (tab.value = v) },
          {
            sync: () => [h(SyncSettings, { backend }), h(CloudInventorySection, { backend })],
            share: () => h(ShareLinksPane, { backend }),
            devices: () => h(CloudDevicesSection, { backend }),
          },
        )
    },
  })
}

describe('Navide Cloud sub-tabs', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    resetSyncInventoryForTest()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  async function mountPage(overrides: Record<string, unknown> = {}) {
    const mock = mockBackend(overrides)
    wrapper = mount(page(mock.backend), { global: { plugins: [i18n] } })
    await flushPromises()
    return mock
  }

  const panel = (name: string) => wrapper!.find(`[data-subtab-panel="${name}"]`)
  const tab = (name: string) => wrapper!.find(`[data-subtab="${name}"]`)
  // v-show's display:none; isVisible() needs the wrapper attached to a document.
  const shown = (name: string) => !(panel(name).attributes('style') ?? '').includes('display: none')

  it('opens on Sync with the existing sync settings rendered', async () => {
    const { send } = await mountPage()
    expect(tab('sync').attributes('aria-selected')).toBe('true')
    expect(wrapper!.findAll('[role="tab"]').map((t) => t.text())).toEqual(['Sync', 'Share', 'Devices'])
    expect(shown('sync')).toBe(true)
    expect(panel('sync').findComponent(SyncSettings).exists()).toBe(true)
    expect(panel('sync').text()).toContain(i18n.global.t('settings.sync.now'))
    // Share and Devices load nothing until visited.
    expect(panel('share').exists()).toBe(false)
    expect(panel('devices').exists()).toBe(false)
    expect(send).not.toHaveBeenCalledWith('share.list', expect.anything())
  })

  it('shows per-scope cloud counts on Sync, without Memory', async () => {
    await mountPage()
    const prompts = wrapper!.find('[data-inventory-scope="prompts"]')
    expect(prompts.text()).toContain('Here 2 · Cloud 1 · Matching 1 · Conflicts 0')
    expect(prompts.text()).toContain('Last written by Studio Mac')
    expect(wrapper!.find('[data-inventory-scope="skills"]').text()).toContain('Sync off')
    expect(wrapper!.find('[data-inventory-scope="memory"]').exists()).toBe(false)
  })

  it('says once that this device has no sync key instead of one notice per scope', async () => {
    await mountPage({
      'sync.inventory': {
        ok: true,
        payload: {
          ...inventory,
          scopes: Object.fromEntries(['prompts', 'mcp', 'skills'].map((s) => [s, { scope: s, status: 'no-key', items: [] }])),
        },
      },
    })
    expect(wrapper!.findAll('[data-notice="no-key"]')).toHaveLength(1)
    expect(wrapper!.find('[data-inventory-scope="prompts"]').exists()).toBe(false)
  })

  it('switches to Share and keeps Sync mounted', async () => {
    const { send } = await mountPage()
    await tab('share').trigger('click')
    await flushPromises()
    expect(tab('share').attributes('aria-selected')).toBe('true')
    expect(shown('share')).toBe(true)
    expect(shown('sync')).toBe(false)
    expect(panel('sync').findComponent(SyncSettings).exists()).toBe(true)
    expect(send).toHaveBeenCalledWith('share.list', {})
    // This build's backend has no share.list yet.
    expect(panel('share').find('[data-notice="unavailable"]').exists()).toBe(true)
  })

  it('lists share links, naming the pane an agent made one from', async () => {
    await mountPage({
      'share.list': {
        ok: true,
        payload: {
          links: [
            { linkId: 'ab'.repeat(16), kind: 'report', title: 'v0.2.19 report', createdBy: 'agent', pane: 'release', openCount: 2 },
          ],
        },
      },
    })
    await tab('share').trigger('click')
    await flushPromises()
    const linkRow = panel('share').find(`[data-link-id="${'ab'.repeat(16)}"]`)
    expect(linkRow.text()).toContain('v0.2.19 report')
    expect(linkRow.text()).toContain('Agent · release')
  })

  it('lists the devices that wrote to the cloud from the same inventory read', async () => {
    const { send } = await mountPage()
    await tab('devices').trigger('click')
    await flushPromises()
    expect(panel('devices').find('[data-device-id="dev-mac"]').text()).toContain('Studio Mac')
    expect(send.mock.calls.filter(([type]) => type === 'sync.inventory')).toHaveLength(1)
  })
})

describe('SettingsModal Navide Cloud page', () => {
  const src = readFileSync(resolve(__dirname, '../SettingsModal.vue'), 'utf8')
  const body = src.slice(
    src.indexOf('class="s-body cross-device-body"'),
    src.indexOf('<!-- ══ UPDATES TAB ══ -->'),
  )

  it('puts the existing sync and rules content under the Sync sub-tab', () => {
    const sync = body.slice(body.indexOf('<template #sync>'), body.indexOf('<template #share>'))
    expect(sync).toContain('<SyncSettings :backend="props.backend" />')
    expect(sync).toContain('data-settings-section="general-p2p-policy"')
    expect(sync).toContain('<CloudInventorySection')
  })

  it('puts share links under Share and the device list under Devices', () => {
    expect(body.slice(body.indexOf('<template #share>'), body.indexOf('<template #devices>'))).toContain('<ShareLinksPane')
    expect(body.slice(body.indexOf('<template #devices>'))).toContain('<CloudDevicesSection')
  })

  it('returns to the Sync sub-tab when a link points into the page', () => {
    expect(src).toMatch(/setSection: async[\s\S]{0,200}if \(tab === 'cross-device'\) cloudSubtab\.value = 'sync'/)
    expect(src).toMatch(/if \(item\.tab === 'cross-device'\) cloudSubtab\.value = 'sync'/)
  })
})
