// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
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

type LinkState = 'unconfigured' | 'connecting' | 'connected' | 'unreachable'

/** shares: whether the server does share links (share.caps answers). */
function backend(initial: LinkState = 'unconfigured', shares = true) {
  const link = { state: initial }
  const send = vi.fn(async (type: string, _payload?: unknown) => {
    if (type === 'p2p.link.status') {
      return { ok: true, payload: { status: { state: link.state, serverUrl: '', hasToken: false, detail: '' } } }
    }
    if (type === 'sync.inventory') return { ok: true, payload: { status: 'ok', scopes: {}, devices: [], scopeEnabled: {} } }
    if (type === 'share.caps' && shares) return { ok: true, payload: { kinds: {} } }
    if (type === 'share.list' && shares) return { ok: true, payload: { links: [] } }
    return { ok: false, error: { code: 'UNKNOWN_TYPE', message: type } }
  })
  const on = vi.fn(() => () => {})
  return { send, on, link, state: ref('connected'), connected: ref(true) }
}

describe('SettingsModal Navide Cloud page', () => {
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

  async function mountModal(linkState: LinkState, props: Record<string, unknown> = {}, shares = true) {
    const b = backend(linkState, shares)
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
      global: {
        plugins: [i18n],
        // The page's own pieces render for real; everything inside them stays a stub.
        stubs: {
          teleport: false,
          CloudSubtabs: false,
          CloudInventorySection: false,
          CloudDevicesSection: false,
          ShareLinksPane: false,
        },
      },
    })
    await flushPromises()
    return b
  }

  // The modal teleports to <body>, outside the wrapper's own element.
  const body = () => new DOMWrapper(document.querySelector('.cross-device-body') as Element)
  /** The page's top-level elements, as main renders them: title, the sync
   *  intro (moved from under the sync card to the page's one intro spot under
   *  the title), sync settings, rules. */
  const MAIN_PAGE = ['H1', 'P', 'SYNC-SETTINGS-STUB', 'SETTINGS-SECTION-STUB']
  const topLevel = () => Array.from(body().element.children).map((el) => el.tagName)
  const subtabs = () => wrapper!.findComponent(CloudSubtabs)
  const count = (b: ReturnType<typeof backend>, type: string) => b.send.mock.calls.filter(([t]) => t === type).length
  async function chooseSubtab(tab: string) {
    subtabs().vm.$emit('update:modelValue', tab)
    await flushPromises()
  }
  async function tick(times = 1) {
    await vi.advanceTimersByTimeAsync(POLL_MS * times)
    await flushPromises()
  }

  it('renders exactly what main renders while Navide Cloud is not connected', async () => {
    const b = await mountModal('unconfigured')
    expect(topLevel()).toEqual(MAIN_PAGE)
    expect(body().find('[role="tablist"]').exists()).toBe(false)
    expect(count(b, 'sync.inventory')).toBe(0)
    expect(count(b, 'share.list')).toBe(0)
    // main polls the link and the rules every P2P_POLL_MS while the page is open.
    await tick(2)
    expect(count(b, 'p2p.link.status')).toBe(3)
    expect(count(b, 'p2p.policy.get')).toBe(3)
    expect(count(b, 'sync.inventory')).toBe(0)
    expect(count(b, 'share.list')).toBe(0)
  })

  it('renders exactly what main renders when connected to a server without share links (F7-2)', async () => {
    const b = await mountModal('connected', {}, false)
    await tick(2)
    expect(topLevel()).toEqual(MAIN_PAGE)
    expect(body().find('[role="tablist"]').exists()).toBe(false)
    expect(count(b, 'share.caps')).toBe(1)
    expect(count(b, 'share.list')).toBe(0)
    expect(count(b, 'sync.inventory')).toBe(0)
  })

  it('shows the sub-tabs once connected to a server that does share links', async () => {
    const b = await mountModal('connected')
    const tabs = body().find('[role="tablist"]')
    expect(tabs.exists()).toBe(true)
    expect(tabs.findAll('[role="tab"]').map((t) => t.text())).toEqual(['Sync', 'Share', 'Devices'])
    expect(b.send.mock.calls.filter(([t]) => t === 'sync.inventory').map(([, p]) => p)).toEqual([
      { scope: 'prompts' },
      { scope: 'mcp' },
      { scope: 'skills' },
    ])
    expect(count(b, 'share.list')).toBe(1)
  })

  it('goes back to main\'s page when the link drops, and starts on Sync after reconnecting', async () => {
    const b = await mountModal('connected')
    await chooseSubtab('devices')
    b.link.state = 'unreachable'
    await tick()
    expect(topLevel()).toEqual(MAIN_PAGE)
    expect(body().find('[role="tablist"]').exists()).toBe(false)

    const inventoryBefore = count(b, 'sync.inventory')
    b.link.state = 'connected'
    await tick()
    expect(subtabs().props('modelValue')).toBe('sync')
    expect(body().find('[data-subtab-panel="devices"]').exists()).toBe(false)
    expect(count(b, 'sync.inventory')).toBe(inventoryBefore + 3)
  })

  it('pauses the rules while another sub-tab shows, but keeps watching the link', async () => {
    const b = await mountModal('connected')
    await chooseSubtab('devices')
    const policy = count(b, 'p2p.policy.get')
    const status = count(b, 'p2p.link.status')
    await tick(3)
    expect(count(b, 'p2p.policy.get')).toBe(policy)
    expect(count(b, 'p2p.link.status')).toBe(status + 3)

    await chooseSubtab('sync')
    expect(count(b, 'p2p.policy.get')).toBe(policy + 1)
  })

  it('opens on Sync when the window is asked for the page again', async () => {
    await mountModal('connected', { tabRequest: 1 })
    await chooseSubtab('devices')
    expect(subtabs().props('modelValue')).toBe('devices')

    await wrapper!.setProps({ tabRequest: 2 })
    expect(subtabs().props('modelValue')).toBe('sync')

    await chooseSubtab('devices')
    await wrapper!.setProps({ initialTab: 'general' })
    await wrapper!.setProps({ initialTab: 'cross-device' })
    expect(subtabs().props('modelValue')).toBe('sync')
  })

  it('returns to Sync when another window points at a section of the page', async () => {
    await mountModal('connected')
    await chooseSubtab('devices')
    await (wrapper!.vm as unknown as { setSection(tab: string, section: string): Promise<void> }).setSection(
      'cross-device',
      'general-p2p-policy',
    )
    await flushPromises()
    expect(subtabs().props('modelValue')).toBe('sync')
  })

  it('returns to Sync when a search result points into the page', async () => {
    await mountModal('connected', { initialTab: 'general' })
    wrapper!.findComponent(CloudSubtabs).vm.$emit('update:modelValue', 'devices')
    await flushPromises()
    expect(subtabs().props('modelValue')).toBe('devices')

    const input = document.querySelector<HTMLInputElement>('.s-search-input')!
    input.value = i18n.global.t('settings.search.item.general-p2p-policy.title')
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    const results = Array.from(document.querySelectorAll<HTMLButtonElement>('.s-search-result'))
    const target = results.find((b) => b.textContent?.includes(i18n.global.t('settings.search.item.general-p2p-policy.title')))
    expect(target).toBeDefined()
    target!.click()
    await flushPromises()
    expect(subtabs().props('modelValue')).toBe('sync')
  })
})
