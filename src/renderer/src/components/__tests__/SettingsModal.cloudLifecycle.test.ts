// @vitest-environment happy-dom
// The Navide Cloud page across link transitions, unmounts and slow replies:
// what stays mounted, what is forgotten, and what is never asked for.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import SettingsModal from '../SettingsModal.vue'
import CloudSubtabs from '../cloud/CloudSubtabs.vue'
import { resetSyncInventoryForTest } from '../../composables/useSyncInventory'

// SettingsModal's P2P_POLL_MS.
const POLL_MS = 3_000

function api(): never {
  const cache = new Map<PropertyKey, unknown>()
  return new Proxy({}, {
    get(target, key) {
      if (key === 'then') return undefined
      if (typeof key === 'symbol' || key in Object.prototype) return Reflect.get(target, key)
      if (!cache.has(key)) cache.set(key, Object.assign(vi.fn(() => []), { value: [], [Symbol.toPrimitive]: () => '' }))
      return cache.get(key)
    },
  }) as never
}

interface Options {
  state?: string
  device?: string
  holdInventory?: boolean
  shareList?: unknown
}

function backend(options: Options = {}) {
  const link = { state: options.state ?? 'connected' }
  const held: Array<() => void> = []
  const hold = { inventory: options.holdInventory ?? false }
  let device = options.device ?? 'ACCOUNT-A'
  const send = vi.fn((type: string, _payload?: unknown, _timeout?: number) => {
    if (type === 'p2p.link.status') {
      return Promise.resolve({ ok: true, payload: { status: { state: link.state, serverUrl: '', hasToken: true, detail: '' } } })
    }
    if (type === 'sync.inventory') {
      const body = {
        ok: true,
        payload: {
          status: 'ok',
          scopes: {},
          devices: [{ deviceId: device, deviceName: device, lastSeenAt: '', lastWriteAt: '2026-10-01T00:00:00Z' }],
          scopeEnabled: {},
        },
      }
      if (hold.inventory) return new Promise((resolve) => held.push(() => resolve(body)))
      return Promise.resolve(body)
    }
    if (type === 'share.list' && options.shareList) return Promise.resolve(options.shareList)
    return Promise.resolve({ ok: false, error: { code: 'UNKNOWN_TYPE', message: type } })
  })
  const on = vi.fn(() => () => {})
  return {
    send,
    on,
    link,
    held,
    hold,
    setDevice: (name: string) => {
      device = name
    },
    state: ref('connected'),
    connected: ref(true),
  }
}
type FakeBackend = ReturnType<typeof backend>

// Real page pieces, real SyncSettings and the settings containers they render into.
const STUBS = {
  teleport: false,
  CloudSubtabs: false,
  CloudInventorySection: false,
  CloudDevicesSection: false,
  ShareLinksPane: false,
  SyncSettings: false,
  SettingsSection: false,
  SettingsCard: false,
  SettingRow: false,
}

describe('Navide Cloud page lifecycle', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    vi.useFakeTimers()
    resetSyncInventoryForTest()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.useRealTimers()
  })

  async function mountModal(b: FakeBackend, initialTab = 'cross-device') {
    wrapper = shallowMount(SettingsModal, {
      props: {
        backend: b as never,
        rolesApi: api(),
        cliProfilesApi: api(),
        stagesApi: api(),
        analyzerApi: api(),
        initialTab,
      },
      global: { plugins: [i18n], stubs: STUBS },
    })
    await flushPromises()
  }
  const count = (b: FakeBackend, type: string) => b.send.mock.calls.filter(([t]) => t === type).length
  const tick = async (times = 1) => {
    await vi.advanceTimersByTimeAsync(POLL_MS * times)
    await flushPromises()
  }
  const chooseSubtab = async (tab: string) => {
    wrapper!.findComponent(CloudSubtabs).vm.$emit('update:modelValue', tab)
    await flushPromises()
  }
  const devicesText = () => document.querySelector('[data-subtab-panel="devices"]')?.textContent ?? ''

  it('keeps SyncSettings mounted while the link comes and goes (UI-F1)', async () => {
    const b = backend({ state: 'connecting' })
    await mountModal(b)
    const status = count(b, 'sync.status')
    const listeners = b.on.mock.calls.length
    expect(status).toBeGreaterThan(0)

    for (const state of ['connected', 'unreachable', 'connected', 'connecting']) {
      b.link.state = state
      await tick()
    }
    expect(count(b, 'sync.status')).toBe(status)
    expect(b.on.mock.calls.length).toBe(listeners)
  })

  it('forgets the inventory when the link drops (UI-F5)', async () => {
    const b = backend()
    await mountModal(b)
    await chooseSubtab('devices')
    expect(devicesText()).toContain('ACCOUNT-A')

    b.link.state = 'unreachable'
    await tick()
    // The reconnect's own read is still on its way when Devices shows.
    b.hold.inventory = true
    b.link.state = 'connected'
    await tick()
    await chooseSubtab('devices')
    expect(devicesText()).not.toContain('ACCOUNT-A')
  })

  it('lets a read started before a disconnect land without ending the next one (UI-F2)', async () => {
    const b = backend({ holdInventory: true })
    await mountModal(b)
    const firstRound = b.held.length
    b.link.state = 'unreachable'
    await tick()
    b.link.state = 'connected'
    await tick()
    const asked = count(b, 'sync.inventory')

    b.held.slice(0, firstRound).forEach((resolve) => resolve())
    await flushPromises()
    await chooseSubtab('devices')
    // The second round is still in flight: Devices joins it instead of starting a third.
    expect(count(b, 'sync.inventory')).toBe(asked)
  })

  it('does not show the previous window\'s inventory after it closed (UI-F3)', async () => {
    const first = backend({ device: 'ACCOUNT-A' })
    await mountModal(first)
    wrapper!.unmount()
    wrapper = undefined

    const second = backend({ device: 'ACCOUNT-B', holdInventory: true })
    await mountModal(second)
    await tick()
    await chooseSubtab('devices')
    expect(devicesText()).not.toContain('ACCOUNT-A')
  })

  it('asks for the inventory only after a fresh status says the link is up (UI-F4)', async () => {
    const b = backend()
    await mountModal(b)
    await wrapper!.setProps({ initialTab: 'general' })
    await flushPromises()
    b.link.state = 'unreachable'
    const asked = count(b, 'sync.inventory')

    await wrapper!.setProps({ initialTab: 'cross-device' })
    await flushPromises()
    await tick()
    expect(count(b, 'sync.inventory')).toBe(asked)
  })

  it('hides Share on any share.list error (UI-F6)', async () => {
    const b = backend({ shareList: { ok: false, error: { code: 'SHARE_LIST_FAILED', message: 'server said no' } } })
    await mountModal(b)
    const tabs = Array.from(document.querySelectorAll('.nvc-subtabs [role="tab"]')).map((t) => t.textContent?.trim())
    expect(tabs).toEqual(['Sync', 'Devices'])
  })

  it('does not ask for share.list again when Share opens (UI-F6)', async () => {
    const b = backend({ shareList: { ok: true, payload: { links: [] } } })
    await mountModal(b)
    expect(count(b, 'share.list')).toBe(1)
    await chooseSubtab('share')
    expect(document.querySelector('[data-subtab-panel="share"]')).not.toBeNull()
    expect(count(b, 'share.list')).toBe(1)
  })
})
