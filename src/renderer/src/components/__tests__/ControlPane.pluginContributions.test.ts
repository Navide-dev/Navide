// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import ControlPane from '../ControlPane.vue'

// These cases pin the macOS rule table and tooltips (⌘N, ⌘,); happy-dom's
// navigator.platform reads as non-mac, which would add the Ctrl+Alt+N / Ctrl+,
// rules. platformSidebarKeys.test.ts covers Windows and Linux.
vi.hoisted(() => {
  Object.defineProperty(globalThis.navigator, 'platform', { value: 'MacIntel', configurable: true })
})

const baseProps = {
  backendStatus: 'connected',
  backendUrl: '',
  agentSpecs: [],
  roles: [],
  stages: [],
  panes: [],
  pipeline: { state: 'idle' },
  yoloEnabled: false,
  analyzerModel: '',
  analyzerStatus: {},
  autoAnswerEnabled: false,
  existingProject: null,
}

const contribution = (overrides: Record<string, unknown> = {}) => ({
  pluginId: 'acme.files',
  packageVersion: '1.0.0',
  contributionKey: 'acme.files.left',
  title: 'Files',
  icon: null,
  kind: 'custom' as const,
  location: 'left' as const,
  manifestOrder: 0,
  ...overrides,
})

function mountPane(
  pluginContributions?: unknown[],
  overrides: Record<string, unknown> = {},
): VueWrapper {
  return shallowMount(ControlPane, {
    props: {
      ...baseProps,
      ...(pluginContributions === undefined ? {} : { pluginContributions }),
      ...overrides,
    } as never,
    // Params are echoed so a test can assert the value reached the template;
    // keys without params still render as the bare key.
    global: {
      mocks: {
        $t: (key: string, params?: Record<string, unknown>) =>
          params ? `${key} ${Object.values(params).join(' ')}` : key,
      },
    },
  })
}

describe('ControlPane manifest-driven plugin placement', () => {
  afterEach(() => sessionStorage.clear())

  it('renders no plugin tab when the Host catalog is empty', () => {
    const wrapper = mountPane([])
    expect(wrapper.findAll('.plugin-tab-btn')).toHaveLength(0)
    expect(wrapper.findComponent({ name: 'PluginRegionHost' }).exists()).toBe(false)
    wrapper.unmount()
  })

  it('renders only left contributions, keeps Host order, and toggles visibility without unmounting', async () => {
    const wrapper = mountPane([
      contribution({ contributionKey: 'zeta.left', pluginId: 'zeta.plugin', manifestOrder: 1 }),
      contribution({ contributionKey: 'acme.window', pluginId: 'acme.plugin', location: 'window' }),
      contribution({ contributionKey: 'acme.left', pluginId: 'acme.plugin' }),
    ])
    const tabs = wrapper.findAll('.plugin-tab-btn')
    expect(tabs).toHaveLength(2)
    expect(tabs.map((tab) => tab.attributes('data-plugin-contribution'))).toEqual([
      'zeta.left',
      'acme.left',
    ])
    const hosts = wrapper.findAllComponents({ name: 'PluginRegionHost' })
    expect(hosts).toHaveLength(2)
    expect(hosts.map((host) => host.props('contribution').contributionKey)).toEqual([
      'zeta.left',
      'acme.left',
    ])
    expect(hosts.every((host) => host.props('visible') === false)).toBe(true)

    await tabs[1].trigger('click')
    await wrapper.vm.$nextTick()
    const toggledHosts = wrapper.findAllComponents({ name: 'PluginRegionHost' })
    expect(toggledHosts).toHaveLength(2)
    expect(toggledHosts.map((host) => host.props('visible'))).toEqual([false, true])
    wrapper.unmount()
  })

  it('hides an active plugin view when the sidebar collapses without unmounting it', async () => {
    const wrapper = mountPane([contribution()])
    await wrapper.get('.plugin-tab-btn').trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.findAllComponents({ name: 'PluginRegionHost' })).toHaveLength(1)
    expect(wrapper.getComponent({ name: 'PluginRegionHost' }).props('visible')).toBe(true)

    await wrapper.setProps({ collapsed: true })
    await wrapper.vm.$nextTick()

    expect(wrapper.findAllComponents({ name: 'PluginRegionHost' })).toHaveLength(1)
    expect(wrapper.getComponent({ name: 'PluginRegionHost' }).props('visible')).toBe(false)
    wrapper.unmount()
  })

  it('renders a catalog icon at the fixed sidebar size', () => {
    const wrapper = mountPane([
      contribution({ icon: 'data:image/png;base64,icon-data' }),
    ])

    const icon = wrapper.get('.plugin-tab-icon')
    expect(icon.element.tagName).toBe('IMG')
    expect(icon.attributes('src')).toBe('data:image/png;base64,icon-data')
    // Deliberately under the 18px of the SVGs beside it: those carry padding
    // inside their viewBox, plugin artwork fills its bitmap, so equal boxes
    // make the plugin icon the largest thing in the rail.
    expect(icon.attributes('width')).toBe('15')
    expect(icon.attributes('height')).toBe('15')
    expect(icon.attributes('alt')).toBe('')
    wrapper.unmount()
  })

  it('paints single-colour artwork with the tab colour instead of showing it', () => {
    // The shipped navide.git icon is one flat shade drawn for a dark theme; as
    // an <img> it kept that shade and all but vanished on a light background.
    // Masking it over currentColor makes it track the theme like the SVGs.
    const wrapper = mountPane([
      contribution({ icon: 'data:image/png;base64,mono-data', iconMonochrome: true }),
    ])

    const icon = wrapper.get('.plugin-tab-icon')
    expect(icon.element.tagName).toBe('SPAN')
    expect(icon.classes()).toContain('plugin-tab-icon--mono')
    expect(icon.attributes('style')).toContain('data:image/png;base64,mono-data')
    expect(wrapper.find('img.plugin-tab-icon').exists()).toBe(false)
    expect(wrapper.find('.plugin-tab-fallback').exists()).toBe(false)
    wrapper.unmount()
  })

  it('still shows colour artwork as an image, which a mask would flatten', () => {
    const wrapper = mountPane([
      contribution({ icon: 'data:image/png;base64,colour-data', iconMonochrome: false }),
    ])

    const icon = wrapper.get('.plugin-tab-icon')
    expect(icon.element.tagName).toBe('IMG')
    expect(icon.classes()).not.toContain('plugin-tab-icon--mono')
    wrapper.unmount()
  })

  it('falls back to the title\'s first letter when a contribution is monochrome but iconless', () => {
    const wrapper = mountPane([contribution({ icon: null, iconMonochrome: true })])

    expect(wrapper.get('.plugin-tab-fallback').text()).toBe('F')
    expect(wrapper.find('.plugin-tab-icon').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows the title\'s first letter when a contribution has no icon', () => {
    const wrapper = mountPane([contribution()])

    expect(wrapper.get('.plugin-tab-fallback').text()).toBe('F')
    expect(wrapper.find('.plugin-tab-icon').exists()).toBe(false)
    wrapper.unmount()
  })

  it('tells two icon-less plugins apart by their titles, CJK included', async () => {
    const wrapper = mountPane([
      contribution({ contributionKey: 'a.left', title: 'Mini-IDE' }),
      contribution({ contributionKey: 'b.left', title: '開發地圖' }),
    ])
    const glyph = (key: string) =>
      wrapper.get(`.plugin-tab-btn[data-plugin-contribution="${key}"] .plugin-tab-fallback`).text()

    expect(glyph('a.left')).toBe('M')
    expect(glyph('b.left')).toBe('開')
    await wrapper.setProps({ collapsed: true })
    expect(wrapper.findAll('.rail-btn .plugin-tab-fallback').map((glyph) => glyph.text())).toEqual(['M', '開'])
    wrapper.unmount()
  })

  it('shows the Git plugin title\'s first letter in the Git slot when its icon is missing', () => {
    const wrapper = mountPane([contribution({ pluginId: 'navide.git', contributionKey: 'navide.git.left', title: 'Git' })])

    expect(wrapper.get('.tab-btn[data-tab="git"] .plugin-tab-fallback').text()).toBe('G')
    wrapper.unmount()
  })

  it('discloses the Git slot\'s plugin like any other plugin tab', () => {
    const saved = i18n.global.locale.value
    i18n.global.locale.value = 'en-US'
    const wrapper = mountPane([contribution({ pluginId: 'navide.git', contributionKey: 'navide.git.left', title: 'Git', source: 'factory-bundled' })])
    const tab = wrapper.get('.tab-btn[data-tab="git"]')
    const disclosure = 'Navide plugin: Git · navide.git · Publisher: navide · Built into Navide'
    expect(tab.attributes('aria-label')).toBe(disclosure)
    expect(tab.attributes('title')).toBe(`${disclosure} (⌘4)`)
    wrapper.unmount()
    i18n.global.locale.value = saved
  })

  it('clips the fallback glyph to a fixed box', () => {
    // The glyph is the plugin's own text (review M1 on #644).
    const source = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/ControlPane.vue'), 'utf8')
    const rule = source.match(/\n\.plugin-tab-fallback \{[^}]*\}/)?.[0] ?? ''
    expect(rule).toContain('overflow: hidden')
    expect(rule).toMatch(/width: 15px;[\s\S]*height: 15px;/)
  })

  it('uses the generic fallback when a catalog icon fails to load', async () => {
    const wrapper = mountPane([
      contribution({ icon: 'data:image/png;base64,broken-icon' }),
    ])

    await wrapper.get('.plugin-tab-icon').trigger('error')

    expect(wrapper.get('.plugin-tab-fallback').text()).toBe('F')
    expect(wrapper.find('.plugin-tab-icon').exists()).toBe(false)
    wrapper.unmount()
  })

  it('does not render the legacy Git tab in normal mode', () => {
    const wrapper = mountPane([])
    expect(wrapper.find('[data-legacy-git-tab]').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'GitPluginHostSlot' }).exists()).toBe(false)
    wrapper.unmount()
  })

  it('renders the legacy Git tab and host slot only in recovery mode', async () => {
    const wrapper = mountPane([], {
      backend: { status: { value: 'connected' } },
      workspace: '/workspace',
      legacyGitRecovery: true,
    })

    const tab = wrapper.find('[data-legacy-git-tab]')
    expect(tab.exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'GitPluginHostSlot' }).exists()).toBe(false)

    await tab.trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.findComponent({ name: 'GitPluginHostSlot' }).exists()).toBe(true)
    expect(wrapper.get('[data-legacy-recovery-label]').text()).toBe('label.legacy-recovery')
    wrapper.unmount()
  })

  it('asks the Host to retry v2 when Git is opened in recovery, then lands on the restored tab', async () => {
    const retryGitV2 = vi.fn().mockResolvedValue({ ok: true })
    Object.assign(window, { agentTeam: { retryGitV2 } })
    const wrapper = mountPane([], {
      backend: { status: { value: 'connected' } },
      workspace: '/workspace',
      legacyGitRecovery: true,
    })

    await wrapper.get('[data-legacy-git-tab]').trigger('click')
    expect(retryGitV2).toHaveBeenCalledTimes(1)

    // The Host answers in two steps: recovery clears first, the refreshed
    // contribution catalog arrives after. Bouncing to Agents in between would
    // drop the user somewhere they never asked for.
    await wrapper.setProps({ legacyGitRecovery: false } as never)
    expect(sessionStorage.getItem('agentTeam.sidebarTab')).toBe('git')

    await wrapper.setProps({
      pluginContributions: [contribution({
        pluginId: 'navide.git',
        contributionKey: 'navide.git.left',
        title: 'Git',
      })],
    } as never)
    expect(sessionStorage.getItem('agentTeam.sidebarTab')).toBe('plugin:navide.git.left')

    Reflect.deleteProperty(window, 'agentTeam')
    wrapper.unmount()
  })

  it('offers the Plans storage-record repair in recovery without running it', async () => {
    const repairPlansStorageRecord = vi.fn().mockResolvedValue({ ok: true, repaired: true })
    Object.assign(window, { agentTeam: { repairPlansStorageRecord } })
    sessionStorage.setItem('agentTeam.sidebarTab', 'plans')
    const wrapper = mountPane([], {
      backend: { status: { value: 'connected' } },
      workspace: '/workspace',
      legacyPlansRecovery: true,
      legacyPlansRecoveryReason: 'storage-migration-failure',
    })

    // Opening the panel must not repair anything: discarding the record gives
    // up the upgrade source, so only the user may ask for it.
    expect(repairPlansStorageRecord).not.toHaveBeenCalled()

    await wrapper.get('[data-plans-repair-record]').trigger('click')
    await flushPromises()
    expect(repairPlansStorageRecord).toHaveBeenCalledTimes(1)
    // The session stays in recovery, so the panel has to say what comes next.
    expect(wrapper.get('.plans-repair-message').text()).not.toBe('')

    Reflect.deleteProperty(window, 'agentTeam')
    wrapper.unmount()
  })

  it('hides the storage repair when the downgrade was not about storage', async () => {
    // The repair reads the lifecycle record, finds it healthy and answers
    // "nothing to repair" — a false all-clear for a failed backend child.
    const repairPlansStorageRecord = vi.fn().mockResolvedValue({ ok: true, repaired: false })
    Object.assign(window, { agentTeam: { repairPlansStorageRecord, retryPlansV2: vi.fn() } })
    sessionStorage.setItem('agentTeam.sidebarTab', 'plans')
    const wrapper = mountPane([], {
      backend: { status: { value: 'connected' } },
      workspace: '/workspace',
      legacyPlansRecovery: true,
      legacyPlansRecoveryReason: 'backend-unavailable',
    })

    expect(wrapper.find('[data-plans-repair-record]').exists()).toBe(false)
    // The reason takes its place, so the panel still says something true.
    expect(wrapper.get('[data-plans-recovery-reason]').text()).toContain('backend-unavailable')

    Reflect.deleteProperty(window, 'agentTeam')
    wrapper.unmount()
  })

  it('asks the Host to re-arm Plans v2 from the recovery panel', async () => {
    const retryPlansV2 = vi.fn().mockResolvedValue({ ok: true })
    Object.assign(window, { agentTeam: { retryPlansV2 } })
    sessionStorage.setItem('agentTeam.sidebarTab', 'plans')
    const wrapper = mountPane([], {
      backend: { status: { value: 'connected' } },
      workspace: '/workspace',
      legacyPlansRecovery: true,
      legacyPlansRecoveryReason: 'backend-unavailable',
    })

    // Mounting the panel is not a retry; only the press is.
    expect(retryPlansV2).not.toHaveBeenCalled()
    await wrapper.get('[data-plans-retry-v2]').trigger('click')
    await flushPromises()
    expect(retryPlansV2).toHaveBeenCalledTimes(1)

    Reflect.deleteProperty(window, 'agentTeam')
    wrapper.unmount()
  })

  it('swaps the legacy Plans pane for the v2 contribution when recovery ends', async () => {
    // Plans v2 and the legacy pane share the 'plans' tab, so leaving recovery
    // has to change the surface in place — there is no tab to move to. Before
    // plans:retryV2 existed nothing ever sent legacy:false, so this transition
    // could only happen by restarting the app.
    sessionStorage.setItem('agentTeam.sidebarTab', 'plans')
    const wrapper = mountPane(
      [
        contribution({
          pluginId: 'navide.plans',
          contributionKey: 'navide.plans.left',
          title: 'Plans',
        }),
      ],
      {
        backend: { status: { value: 'connected' } },
        workspace: '/workspace',
        legacyPlansRecovery: true,
        legacyPlansRecoveryReason: 'backend-unavailable',
      },
    )
    expect(wrapper.find('[data-plans-legacy-recovery-label]').exists()).toBe(true)

    await wrapper.setProps({ legacyPlansRecovery: false, legacyPlansRecoveryReason: '' } as never)

    expect(wrapper.find('[data-plans-legacy-recovery-label]').exists()).toBe(false)
    expect(wrapper.find('[data-plans-recovery-reason]').exists()).toBe(false)
    // Still the same tab: the swap must not bounce the user back to Agents.
    expect(sessionStorage.getItem('agentTeam.sidebarTab')).toBe('plans')
    wrapper.unmount()
  })

  it('leaves recovery for Agents when the exit was not a retry we asked for', async () => {
    const wrapper = mountPane([], {
      backend: { status: { value: 'connected' } },
      workspace: '/workspace',
      legacyGitRecovery: true,
    })
    await wrapper.get('[data-legacy-git-tab]').trigger('click')
    expect(sessionStorage.getItem('agentTeam.sidebarTab')).toBe('git')

    await wrapper.setProps({ legacyGitRecovery: false } as never)
    expect(sessionStorage.getItem('agentTeam.sidebarTab')).toBe('agents')
    wrapper.unmount()
  })

  it('renders navide.git in the fixed Git slot with its change badge', () => {
    const wrapper = mountPane([
      contribution({
        pluginId: 'navide.git',
        contributionKey: 'navide.git.left',
        title: 'Git',
        icon: 'data:image/png;base64,git-icon',
      }),
    ], { gitChangesCount: 7 })

    const tab = wrapper.get('[data-plugin-contribution="navide.git.left"]')
    expect(tab.attributes('title')).toContain('⌘4')
    expect(tab.get('.git-badge').text()).toBe('7')
    wrapper.unmount()
  })

  it('hosts navide.git in PluginRegionHost, keeps it mounted when off-tab, and shows change badge', async () => {
    const gitContrib = contribution({
      pluginId: 'navide.git',
      contributionKey: 'navide.git.left',
      title: 'Git',
      icon: 'data:image/png;base64,git-icon',
    })
    const wrapper = mountPane([gitContrib], { gitChangesCount: 7 })

    const tab = wrapper.get('[data-plugin-contribution="navide.git.left"]')
    expect(tab.attributes('title')).toContain('⌘4')
    expect(tab.get('.git-badge').text()).toBe('7')

    const findGitHost = () =>
      wrapper.findAllComponents({ name: 'PluginRegionHost' })
        .find((h) => h.props('contribution')?.contributionKey === 'navide.git.left')

    let host = findGitHost()
    expect(host).toBeDefined()
    expect(host!.props('visible')).toBe(false)

    await tab.trigger('click')
    await wrapper.vm.$nextTick()
    host = findGitHost()
    expect(host).toBeDefined()
    expect(host!.props('visible')).toBe(true)

    const agentsTab = wrapper.findAll('.sidebar-tabs .tab-btn')[0]
    await agentsTab.trigger('click')
    await wrapper.vm.$nextTick()
    host = findGitHost()
    expect(host).toBeDefined()
    expect(host!.props('visible')).toBe(false)

    wrapper.unmount()
  })
})

// Card K2: a local or test package keeps a mark on its sidebar tab, in Navide's
// own chrome. Every plugin tab also names its plugin id, publisher and source,
// since an icon-less tab now shows a letter of the plugin's own title.
describe('ControlPane plugin tab source mark (K2)', () => {
  it('marks only sources that are neither Marketplace stable nor built in', async () => {
    const saved = i18n.global.locale.value
    i18n.global.locale.value = 'en-US'
    const wrapper = mountPane([
      contribution({ contributionKey: 'a.left', source: 'local-unsigned' }),
      contribution({ contributionKey: 'b.left', source: 'marketplace' }),
      contribution({ contributionKey: 'c.left' }),
    ])
    const tab = (key: string) => wrapper.get(`.plugin-tab-btn[data-plugin-contribution="${key}"]`)
    expect(tab('a.left').find('.plugin-tab-source-mark').exists()).toBe(true)
    const unsigned = 'Navide plugin: Files · acme.files · Publisher: Self-declared: acme · Local file, not reviewed by Navide, unsigned'
    expect(tab('a.left').attributes('title')).toBe(unsigned)
    expect(tab('a.left').attributes('aria-label')).toBe(unsigned)
    for (const key of ['b.left', 'c.left']) {
      expect(tab(key).find('.plugin-tab-source-mark').exists()).toBe(false)
    }
    expect(tab('b.left').attributes('title')).toBe('Navide plugin: Files · acme.files · Publisher: acme · Reviewed')
    expect(tab('c.left').attributes('title')).toBe('Navide plugin: Files · acme.files · Publisher: Self-declared: acme')
    await wrapper.setProps({ collapsed: true })
    const rail = wrapper.findAll('.rail-btn').find((button) => button.find('.plugin-tab-source-mark').exists())
    expect(rail?.attributes('title')).toBe(unsigned)
    expect(rail?.attributes('aria-label')).toBe(unsigned)
    wrapper.unmount()
    i18n.global.locale.value = saved
  })
})
