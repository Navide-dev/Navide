// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import SettingsModal from '../SettingsModal.vue'
import ExtensionsPane from '../ExtensionsPane.vue'
import PluginDisclosureOverview from '../PluginDisclosureOverview.vue'

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

function backend() {
  const send = vi.fn(async (type: string) => ({ ok: false, error: { code: 'UNKNOWN_TYPE', message: type } }))
  return { send, on: vi.fn(() => () => {}), state: ref('connected'), connected: ref(true) }
}

// The disclosure overview is a section of the Navide Plugins page, not a page
// of its own; the old tab id still opens it there.
describe('SettingsModal disclosure overview on the Navide Plugins page', () => {
  let wrapper: VueWrapper | undefined
  let scrolled: string[]

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    scrolled = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.getAttribute('data-settings-section') ?? '')
    }
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.unstubAllGlobals()
  })

  async function mountModal(initialTab?: string) {
    wrapper = shallowMount(SettingsModal, {
      props: {
        backend: backend() as never,
        rolesApi: api(),
        cliProfilesApi: api(),
        stagesApi: api(),
        analyzerApi: api(),
        ...(initialTab ? { initialTab } : {}),
      },
      global: { plugins: [i18n], stubs: { teleport: false } },
    })
    await flushPromises()
  }

  const page = (section: string) => new DOMWrapper(document.querySelector(`.s-body[data-settings-section="${section}"]`) as Element)
  const visible = (section: string) => (page(section).element as HTMLElement).style.display !== 'none'
  const overviewSection = () => page('extensions').find('[data-settings-section="disclosureOverview"]')

  it('shows the disclosure overview inside the Navide Plugins page', async () => {
    await mountModal('extensions')
    expect(visible('extensions')).toBe(true)
    expect(overviewSection().exists()).toBe(true)
    expect(overviewSection().find('h2').text()).toBe('Disclosure overview')
    expect(overviewSection().findComponent(PluginDisclosureOverview).exists()).toBe(true)
  })

  it('has no standalone disclosure overview page or nav entry', async () => {
    await mountModal('extensions')
    expect(document.querySelector('.s-body[data-settings-section="disclosureOverview"]')).toBeNull()
    expect(wrapper!.findAll('settings-nav-item-stub').map((n) => n.attributes('label'))).not.toContain('Disclosure overview')
  })

  it('reads no plugin activity until the Navide Plugins page is opened', async () => {
    await mountModal('general')
    expect(wrapper!.findComponent(PluginDisclosureOverview).exists()).toBe(false)
  })

  it('opens the old disclosureOverview tab id on the Navide Plugins page, scrolled to the section', async () => {
    await mountModal('disclosureOverview')
    expect(visible('extensions')).toBe(true)
    expect(overviewSection().findComponent(PluginDisclosureOverview).exists()).toBe(true)
    expect(scrolled).toContain('disclosureOverview')
  })

  it('redirects setTab and setSection callers that still name disclosureOverview', async () => {
    await mountModal('general')
    ;(wrapper!.vm as unknown as { setTab: (t: string) => void }).setTab('disclosureOverview')
    await flushPromises()
    expect(visible('extensions')).toBe(true)
    expect(scrolled).toContain('disclosureOverview')

    scrolled = []
    ;(wrapper!.vm as unknown as { setTab: (t: string) => void }).setTab('general')
    await flushPromises()
    await (wrapper!.vm as unknown as { setSection: (t: string, s: string) => Promise<void> }).setSection('disclosureOverview', 'disclosureOverview')
    await flushPromises()
    expect(visible('extensions')).toBe(true)
    expect(scrolled).toContain('disclosureOverview')
  })

  it("scrolls to the section when a plugin row's link asks for the overview", async () => {
    await mountModal('extensions')
    wrapper!.findComponent(ExtensionsPane).vm.$emit('openDisclosureOverview')
    await flushPromises()
    expect(visible('extensions')).toBe(true)
    expect(scrolled).toEqual(['disclosureOverview'])
  })
})
