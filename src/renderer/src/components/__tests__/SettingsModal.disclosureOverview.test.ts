// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import SettingsModal from '../SettingsModal.vue'
import ExtensionsPane from '../ExtensionsPane.vue'
import PluginDisclosureOverview from '../PluginDisclosureOverview.vue'
import SettingsNavSubItem from '../settings/SettingsNavSubItem.vue'
import SettingsNavItem from '../settings/SettingsNavItem.vue'
import ExecutionPolicyPane from '../ExecutionPolicyPane.vue'

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

function pluginsApi() {
  return {
    installedDisclosures: vi.fn(async () => [{ id: 'acme.one', version: '1.0.0', disclosure: null, scan: null }]),
    activityReport: vi.fn(async () => ({ ok: false, error: 'not ready' })),
    backendResourceUsage: vi.fn(async () => null),
  }
}

function backend() {
  const send = vi.fn(async (type: string) => ({ ok: false, error: { code: 'UNKNOWN_TYPE', message: type } }))
  return { send, on: vi.fn(() => () => {}), state: ref('connected'), connected: ref(true) }
}

// Navide Plugins is four pages under its sidebar entry; the disclosure overview
// is one of them, not a Settings tab of its own, and the old tab id opens it.
describe('SettingsModal Navide Plugins pages', () => {
  let wrapper: VueWrapper | undefined
  let scrolled: string[]
  let plugins: ReturnType<typeof pluginsApi>

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    scrolled = []
    plugins = pluginsApi()
    ;(window as unknown as Record<string, unknown>).agentTeam = { plugins }
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.getAttribute('data-settings-section') ?? '')
    }
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.unstubAllGlobals()
    vi.useRealTimers()
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  async function mountModal(initialTab?: string) {
    wrapper = shallowMount(SettingsModal, {
      props: {
        backend: backend() as never,
        rolesApi: api(),
        cliProfilesApi: api(),
        stagesApi: api(),
        analyzerApi: api(),
        ...(initialTab ? { initialTab: initialTab as never } : {}),
      },
      // The overview renders for real so its IPC is what gets counted.
      global: { plugins: [i18n], stubs: { teleport: false, PluginDisclosureOverview: false } },
    })
    await flushPromises()
  }

  const body = (section: string) => new DOMWrapper(document.querySelector(`.s-body[data-settings-section="${section}"]`) as Element)
  const shown = (el: Element | undefined) => !!el && (el as HTMLElement).style.display !== 'none'
  const visible = (section: string) => shown(body(section).element)
  const part = (section: string) => body('extensions').find(`[data-settings-section="${section}"]`)
  const partShown = (section: string) => shown(part(section).element)
  const calls = () => [plugins.installedDisclosures, plugins.activityReport, plugins.backendResourceUsage].map((f) => f.mock.calls.length)
  const vm = () => wrapper!.vm as unknown as { setTab: (t: string) => void; setSection: (t: string, s: string) => Promise<void> }
  async function openPage(label: string) {
    const item = wrapper!.findAllComponents(SettingsNavSubItem).find((n) => n.props('label') === label)!
    item.vm.$emit('select')
    await flushPromises()
  }

  it('lists the four pages under Navide Plugins and switches between them', async () => {
    await mountModal('extensions')
    expect(wrapper!.findAllComponents(SettingsNavSubItem).map((n) => n.props('label'))).toEqual([
      'Installed',
      'Execution Policy',
      'Developer and native code',
      'Disclosure overview',
    ])
    expect(body('extensions').get('h1').text()).toBe('Installed')
    expect(wrapper!.findComponent(ExtensionsPane).props('page')).toBe('plugins')
    expect(partShown('execution-policy')).toBe(false)

    await openPage('Execution Policy')
    expect(body('extensions').get('h1').text()).toBe('Execution Policy')
    expect(partShown('execution-policy')).toBe(true)
    expect(shown(wrapper!.findComponent(ExtensionsPane).element)).toBe(false)

    await openPage('Developer and native code')
    expect(wrapper!.findComponent(ExtensionsPane).props('page')).toBe('developer')
    expect(shown(wrapper!.findComponent(ExtensionsPane).element)).toBe(true)

    await openPage('Disclosure overview')
    expect(partShown('disclosureOverview')).toBe(true)
    expect(part('disclosureOverview').findComponent(PluginDisclosureOverview).exists()).toBe(true)
  })

  it('reads no plugin activity until the Disclosure page is shown', async () => {
    vi.useFakeTimers()
    await mountModal('extensions')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(calls()).toEqual([0, 0, 0])
    expect(wrapper!.findComponent(PluginDisclosureOverview).exists()).toBe(false)

    await openPage('Disclosure overview')
    expect(calls()).toEqual([1, 1, 1])
  })

  it('stops polling while another page is shown and when Settings closes', async () => {
    vi.useFakeTimers()
    await mountModal('extensions')
    await openPage('Disclosure overview')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(plugins.backendResourceUsage).toHaveBeenCalledTimes(2)

    await openPage('Installed')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(plugins.backendResourceUsage).toHaveBeenCalledTimes(2)

    await openPage('Disclosure overview')
    await vi.advanceTimersByTimeAsync(5_000)
    const seen = plugins.backendResourceUsage.mock.calls.length
    expect(seen).toBeGreaterThan(2)

    wrapper!.unmount()
    wrapper = undefined
    await vi.advanceTimersByTimeAsync(15_000)
    expect(plugins.backendResourceUsage).toHaveBeenCalledTimes(seen)
  })

  it('has no Settings tab of its own for the disclosure overview', async () => {
    await mountModal('extensions')
    expect(document.querySelector('.s-body[data-settings-section="disclosureOverview"]')).toBeNull()
    expect(wrapper!.findAll('settings-nav-item-stub').map((n) => n.attributes('label'))).not.toContain('Disclosure overview')
  })

  it('reads no plugin activity until the Navide Plugins page is opened', async () => {
    await mountModal('general')
    expect(wrapper!.findComponent(PluginDisclosureOverview).exists()).toBe(false)
    expect(calls()).toEqual([0, 0, 0])
  })

  it('opens the old disclosureOverview tab id on the Disclosure page', async () => {
    await mountModal('disclosureOverview')
    expect(visible('extensions')).toBe(true)
    expect(partShown('disclosureOverview')).toBe(true)
    expect(part('disclosureOverview').findComponent(PluginDisclosureOverview).exists()).toBe(true)
    expect(plugins.installedDisclosures).toHaveBeenCalledTimes(1)
  })

  it('redirects setTab and setSection callers that still name disclosureOverview', async () => {
    await mountModal('general')
    vm().setTab('disclosureOverview')
    await flushPromises()
    expect(visible('extensions')).toBe(true)
    expect(partShown('disclosureOverview')).toBe(true)

    vm().setTab('general')
    await flushPromises()
    await vm().setSection('disclosureOverview', 'disclosureOverview')
    await flushPromises()
    expect(visible('extensions')).toBe(true)
    expect(partShown('disclosureOverview')).toBe(true)
    expect(scrolled).toContain('disclosureOverview')
  })

  it('opens the page each section of the former single page lives on', async () => {
    await mountModal('general')
    await vm().setSection('extensions', 'execution-policy')
    await flushPromises()
    expect(partShown('execution-policy')).toBe(true)
    expect(scrolled).toContain('execution-policy')

    await vm().setSection('extensions', 'extensions-developer-mode')
    await flushPromises()
    expect(wrapper!.findComponent(ExtensionsPane).props('page')).toBe('developer')

    await vm().setSection('extensions', 'extensions-native-backends')
    await flushPromises()
    expect(wrapper!.findComponent(ExtensionsPane).props('page')).toBe('developer')

    await vm().setSection('extensions', 'extensions-install-from-file')
    await flushPromises()
    expect(wrapper!.findComponent(ExtensionsPane).props('page')).toBe('plugins')
    expect(partShown('execution-policy')).toBe(false)
  })

  it('starts on the plugins page when Navide Plugins is opened from another tab', async () => {
    await mountModal('extensions')
    await openPage('Execution Policy')
    vm().setTab('general')
    await flushPromises()
    vm().setTab('extensions')
    await flushPromises()
    expect(body('extensions').get('h1').text()).toBe('Installed')
    expect(wrapper!.findComponent(ExtensionsPane).props('page')).toBe('plugins')
  })

  it("opens the Disclosure page when a plugin row's link asks for the overview", async () => {
    await mountModal('extensions')
    wrapper!.findComponent(ExtensionsPane).vm.$emit('openDisclosureOverview')
    await flushPromises()
    expect(visible('extensions')).toBe(true)
    expect(partShown('disclosureOverview')).toBe(true)
    expect(part('disclosureOverview').findComponent(PluginDisclosureOverview).exists()).toBe(true)
  })

  // The pages split one scrolling page, so each page's state shows on its row and
  // in the narrow tab strip: ⚠ while Execution Policy warns, "On" for Developer.
  const marker = (label: string) => wrapper!.findAllComponents(SettingsNavSubItem).find((n) => n.props('label') === label)!.props('marker')
  const tabMarker = (label: string) => body('extensions').findAll('.ext-pages-tab').find((tab) => tab.text().startsWith(label))!.find('.ext-pages-marker')

  it('marks Execution Policy with ⚠ and the reasons while the page warns', async () => {
    await mountModal('extensions')
    expect(marker('Execution Policy')).toBeNull()
    expect(tabMarker('Execution Policy').exists()).toBe(false)

    wrapper!.findComponent(ExecutionPolicyPane).vm.$emit('attention', ['Repository recommendation: Untrusted', 'Effective policy: Stale'])
    await flushPromises()
    expect(marker('Execution Policy')).toEqual({ text: '⚠', tone: 'risk', label: 'Repository recommendation: Untrusted\nEffective policy: Stale' })
    const tab = tabMarker('Execution Policy')
    expect(tab.text()).toBe('⚠')
    expect(tab.attributes('role')).toBe('img')
    expect(tab.attributes('aria-label')).toBe('Repository recommendation: Untrusted\nEffective policy: Stale')
    // Only that page carries it.
    expect(marker('Installed')).toBeNull()
    expect(marker('Developer and native code')).toBeNull()

    wrapper!.findComponent(ExecutionPolicyPane).vm.$emit('attention', [])
    await flushPromises()
    expect(marker('Execution Policy')).toBeNull()
  })

  it('marks Developer and native code "On" with the switches that are on', async () => {
    await mountModal('extensions')
    expect(marker('Developer and native code')).toBeNull()

    wrapper!.findComponent(ExtensionsPane).vm.$emit('developerOn', ['Turn on Developer Mode', 'Allow native backends'])
    await flushPromises()
    expect(marker('Developer and native code')).toEqual({ text: 'On', tone: 'on', label: 'On: Turn on Developer Mode, Allow native backends' })
    expect(tabMarker('Developer and native code').attributes('aria-label')).toBe('On: Turn on Developer Mode, Allow native backends')
    expect(marker('Execution Policy')).toBeNull()

    wrapper!.findComponent(ExtensionsPane).vm.$emit('developerOn', [])
    await flushPromises()
    expect(marker('Developer and native code')).toBeNull()
  })
  // Only the open entry unfolds its pages: with another entry open, the Navide
  // Plugins pages fold away and the row itself carries their state.
  const subLabels = () => wrapper!.findAllComponents(SettingsNavSubItem).map((n) => n.props('label'))
  const pluginsRow = () => wrapper!.findAllComponents(SettingsNavItem).find((n) => n.props('label') === 'Navide Plugins')!

  it('unfolds the Navide Plugins pages only while that entry is open', async () => {
    await mountModal('marketplace')
    expect(subLabels()).toEqual([])

    vm().setTab('extensions')
    await flushPromises()
    expect(subLabels()).toHaveLength(4)

    await openPage('Disclosure overview')
    vm().setTab('marketplace')
    await flushPromises()
    expect(subLabels()).toEqual([])
  })

  it('unfolds onto the page a search hit or old link opens', async () => {
    await mountModal('general')
    await vm().setSection('extensions', 'execution-policy')
    await flushPromises()
    expect(wrapper!.findAllComponents(SettingsNavSubItem).filter((n) => n.props('active')).map((n) => n.props('label'))).toEqual(['Execution Policy'])

    await mountModal('disclosureOverview')
    expect(wrapper!.findAllComponents(SettingsNavSubItem).filter((n) => n.props('active')).map((n) => n.props('label'))).toEqual(['Disclosure overview'])
  })

  it('puts the folded pages\' marker on the Navide Plugins row, a warning before "Developer on"', async () => {
    await mountModal('general')
    expect(pluginsRow().props('marker')).toBeNull()

    wrapper!.findComponent(ExtensionsPane).vm.$emit('developerOn', ['Turn on Developer Mode'])
    await flushPromises()
    expect(pluginsRow().props('marker')).toEqual({ text: 'Developer on', tone: 'on', label: 'Developer and native code: Turn on Developer Mode' })

    wrapper!.findComponent(ExecutionPolicyPane).vm.$emit('attention', ['Effective policy: Stale'])
    await flushPromises()
    expect(pluginsRow().props('marker')).toEqual({ text: '⚠', tone: 'risk', label: 'Effective policy: Stale' })

    // Unfolded, the marker is back on its page's row, not on both.
    vm().setTab('extensions')
    await flushPromises()
    expect(pluginsRow().props('marker')).toBeNull()
    expect(marker('Execution Policy')).toMatchObject({ text: '⚠' })
  })
})
