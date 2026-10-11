// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import SettingsModal from '../SettingsModal.vue'
import CloudSubtabs from '../cloud/CloudSubtabs.vue'

// SettingsModal's P2P_POLL_MS.
const POLL_MS = 3_000

function api(): never {
  // Every *Api prop is a composable result: refs and functions. Each member
  // here is both — callable, returning an empty list, with an empty .value,
  // and an empty string when bound as an attribute.
  const cache = new Map<PropertyKey, unknown>()
  return new Proxy({}, {
    get(target, key) {
      if (key === 'then') return undefined
      // Stubs print their props as attributes, which needs Object's own toString.
      if (typeof key === 'symbol' || key in Object.prototype) return Reflect.get(target, key)
      if (!cache.has(key)) cache.set(key, Object.assign(vi.fn(() => []), { value: [], [Symbol.toPrimitive]: () => '' }))
      return cache.get(key)
    },
  }) as never
}

function backend() {
  const send = vi.fn(async (type: string) => ({ ok: false, error: { code: 'UNKNOWN_TYPE', message: type } }))
  const on = vi.fn(() => () => {})
  return { send, on, state: ref('connected'), connected: ref(true) }
}

describe('SettingsModal Navide Cloud sub-tab', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    vi.useFakeTimers()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.useRealTimers()
  })

  async function mountModal(props: Record<string, unknown> = {}) {
    const b = backend()
    wrapper = shallowMount(SettingsModal, {
      props: {
        backend: b as never,
        rolesApi: api(),
        cliProfilesApi: api(),
        stagesApi: api(),
        analyzerApi: api(),
        initialTab: 'cross-device',
        ...props,
      },
      global: { plugins: [i18n], stubs: { teleport: false } },
    })
    await flushPromises()
    return b
  }

  const subtabs = () => wrapper!.findComponent(CloudSubtabs)
  async function chooseSubtab(tab: string) {
    subtabs().vm.$emit('update:modelValue', tab)
    await flushPromises()
  }
  const polls = (b: ReturnType<typeof backend>) => b.send.mock.calls.filter(([type]) => type === 'p2p.link.status').length

  it('polls the rules only while the Sync sub-tab shows', async () => {
    const b = await mountModal()
    expect(polls(b)).toBe(1)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(polls(b)).toBe(2)

    await chooseSubtab('share')
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(polls(b)).toBe(2)

    await chooseSubtab('sync')
    expect(polls(b)).toBe(3)
  })

  it('opens on Sync when the window is asked for the page again', async () => {
    await mountModal({ tabRequest: 1 })
    await chooseSubtab('devices')
    expect(subtabs().props('modelValue')).toBe('devices')

    await wrapper!.setProps({ tabRequest: 2 })
    expect(subtabs().props('modelValue')).toBe('sync')

    await chooseSubtab('share')
    await wrapper!.setProps({ initialTab: 'general' })
    await wrapper!.setProps({ initialTab: 'cross-device' })
    expect(subtabs().props('modelValue')).toBe('sync')
  })
})
