// @vitest-environment happy-dom
// Left-slot collapse: the icon rail, and the one-way `update:collapsed`
// contract with App.vue.
//
// The contract mirrors TokenStatsPanel's `update:expanded`: ControlPane never
// owns the collapsed flag, it only asks the parent to change it. An earlier
// version of the right panel kept the flag locally and emitted one way, which
// looked like a v-model but meant the parent could never open or close it.
//
// The body-stays-mounted assertion is the load-bearing one: collapsing must not
// unmount ExplorerPane/GitPane, which hold scroll position, expanded folders and
// in-flight backend requests that a `v-if` would discard on every toggle.
import { describe, it, expect, vi } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'
import { i18n } from '@navide/plugin-ui/foundation'

// These cases pin the macOS rule table and tooltips (⌘N, ⌘,); happy-dom's
// navigator.platform reads as non-mac, which would add the Ctrl+Alt+N / Ctrl+,
// rules. platformSidebarKeys.test.ts covers Windows and Linux.
vi.hoisted(() => {
  Object.defineProperty(globalThis.navigator, 'platform', { value: 'MacIntel', configurable: true })
})

const gitContribution = {
  pluginId: 'navide.git',
  packageVersion: '0.1.0',
  contributionKey: 'navide.git:left',
  location: 'left',
  title: 'Git',
  icon: null,
  source: 'factory-bundled',
}

const minimalProps = {
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
  pluginContributions: [gitContribution],
} as unknown as Record<string, unknown>

/** The exposed tab switcher — what Cmd+1..5 and App's entry points both call. */
function selectTab(w: VueWrapper, tab: string): void {
  ;(w.vm as unknown as { selectSidebarTab: (t: string) => void }).selectSidebarTab(tab)
}

function mountPane(props: Record<string, unknown> = {}): VueWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return shallowMount(ControlPane as any, {
    props: { ...minimalProps, ...props },
    global: { mocks: { $t: (key: string) => key } }
  })
}

/** The stubbed $t echoes keys, so the shape check above cannot tell a live key
 *  from a deleted one. This reads the real message catalogues instead. */
function resolvesInBothLocales(...keys: string[]): void {
  for (const key of keys) {
    for (const locale of ['en-US', 'zh-TW'] as const) {
      expect(i18n.global.t(key, {}, { locale })).not.toBe(key)
    }
  }
}

describe('ControlPane – left slot collapse', () => {
  it('renders no rail while expanded', () => {
    const w = mountPane({ collapsed: false })
    expect(w.find('.rail').exists()).toBe(false)
    expect(w.find('.sidebar').classes()).not.toContain('is-collapsed')
    w.unmount()
  })

  it('renders one rail button per sidebar tab when collapsed', () => {
    const w = mountPane({ collapsed: true })
    expect(w.find('.sidebar').classes()).toContain('is-collapsed')
    const labels = w.findAll('.rail .rail-btn .rail-label').map((n) => n.text())
    expect(labels).toEqual(['label.agents', 'label.pipeline', 'label.explorer', 'label.git', 'label.plans'])
    w.unmount()
  })

  it('keeps the panel body mounted so pane state survives a collapse', () => {
    const w = mountPane({ collapsed: true })
    // Hidden by CSS, not removed: the tab strip is still in the tree.
    expect(w.find('.sidebar-tabs').exists()).toBe(true)
    w.unmount()
  })

  it('rail click asks the parent to expand and switches to that tab', async () => {
    const w = mountPane({ collapsed: true })
    await w.findAll('.rail .rail-btn')[3].trigger('click')  // git
    expect(w.emitted('update:collapsed')).toEqual([[false]])
    // Re-open the way the parent would, and the requested tab is the active one.
    await w.setProps({ collapsed: false })
    const active = w.findAll('.sidebar-tabs .tab-btn').findIndex((b) => b.classes().includes('active'))
    expect(active).toBe(3)
    w.unmount()
  })

  it('a shortcut-driven tab switch reopens a collapsed slot', async () => {
    // Otherwise Cmd+1..5 would only move a highlight on the rail.
    const w = mountPane({ collapsed: true })
    selectTab(w, 'plans')
    await w.vm.$nextTick()
    expect(w.emitted('update:collapsed')).toEqual([[false]])
    w.unmount()
  })

  it('a tab switch while expanded does not re-emit collapse state', async () => {
    const w = mountPane({ collapsed: false })
    selectTab(w, 'plans')
    await w.vm.$nextTick()
    expect(w.emitted('update:collapsed')).toBeUndefined()
    w.unmount()
  })

  it('the strip collapse button asks the parent to collapse', async () => {
    const w = mountPane({ collapsed: false })
    await w.find('.sidebar-tabs .tab-collapse').trigger('click')
    expect(w.emitted('update:collapsed')).toEqual([[true]])
    w.unmount()
  })

  it('never flips its own collapsed state — the parent prop is the only source', async () => {
    const w = mountPane({ collapsed: false })
    await w.find('.sidebar-tabs .tab-collapse').trigger('click')
    // Emitted, but the parent did not act: still expanded.
    expect(w.find('.rail').exists()).toBe(false)
    w.unmount()
  })

  it('renders only the tabs the layout assigns to this slot', async () => {
    // A view moved to another slot has to vanish from here, or it renders in
    // both places at once and stops being the singleton the model assumes.
    // Order comes from the slot too, so a reordered assignment reorders the
    // strip — while the ⌘n hints stay bound to the tab, not to the position.
    const w = mountPane({ collapsed: false, views: ['explorer', 'agents'] })
    const titles = w.findAll('.sidebar-tabs .tab-btn').map((b) => b.attributes('title'))
    // $t is stubbed to echo its key, so a localised title renders as
    // "<key> (⌘n)". resolvesInBothLocales() below is what stops a deleted
    // key from slipping through this shape check.
    expect(titles).toEqual(['label.explorer (⌘3)', 'label.agents (⌘1)'])
    resolvesInBothLocales('label.explorer', 'label.agents')
    w.unmount()
  })

  it('mirrors the assignment on the collapsed rail', async () => {
    const w = mountPane({ collapsed: true, views: ['git', 'plans'] })
    expect(w.findAll('.rail .rail-label').map((n) => n.text())).toEqual(['label.git', 'label.plans'])
    w.unmount()
  })

  it('falls back to the first remaining tab when the active one is moved away', async () => {
    const w = mountPane({ collapsed: false, views: ['agents', 'explorer'] })
    selectTab(w, 'explorer')
    await w.vm.$nextTick()
    await w.setProps({ views: ['agents', 'git'] })
    const active = w.findAll('.sidebar-tabs .tab-btn').findIndex((b) => b.classes().includes('active'))
    expect(w.findAll('.sidebar-tabs .tab-btn')[active].attributes('title')).toBe('label.agents (⌘1)')
    w.unmount()
  })

  it('repairs the active tab without prising a collapsed panel open', async () => {
    // The repair runs when Settings — or another window — moves the active view
    // elsewhere. That is not a request to see the panel, so a collapsed sidebar
    // must stay collapsed; only a real tab pick or ⌘1..5 expands it.
    const w = mountPane({ collapsed: true, views: ['agents', 'explorer'] })
    selectTab(w, 'explorer')
    await w.vm.$nextTick()
    // The tab pick itself asked to expand; the parent declined by not acting.
    expect(w.emitted('update:collapsed')).toEqual([[false]])

    await w.setProps({ views: ['agents', 'git'] })
    // Repair happened, but no second expand request was emitted.
    expect(w.emitted('update:collapsed')).toEqual([[false]])
    expect(w.findAll('.rail .rail-label').map((n) => n.text())).toEqual(['label.agents', 'label.git'])
    w.unmount()
  })

  it('leaves the active tab alone when it survives the reassignment', async () => {
    const w = mountPane({ collapsed: false, views: ['agents', 'explorer', 'git'] })
    selectTab(w, 'git')
    await w.vm.$nextTick()
    await w.setProps({ views: ['explorer', 'git'] })
    const btns = w.findAll('.sidebar-tabs .tab-btn')
    const active = btns.findIndex((b) => b.classes().includes('active'))
    // The Git slot names its plugin like any other plugin tab (#644).
    expect(btns[active].attributes('title')).toBe('Navide plugin: Git · navide.git · Publisher: navide · Built into Navide (⌘4)')
    w.unmount()
  })

  it('draws no panel body for a view this slot no longer holds', async () => {
    // Every body is gated on membership, not just on the active tab. The tab
    // repair happens to cover the common case, but it bails when the slot is
    // emptied outright — and a body left mounted in a 0px sidebar is a second
    // live copy of a view that is supposed to be a singleton.
    const w = mountPane({ collapsed: false, views: [] })
    expect(w.find('.agents-split').exists()).toBe(false)
    expect(w.find('.pipeline-split').exists()).toBe(false)
    expect(w.findAll('.sidebar-tabs .tab-btn')).toHaveLength(0)
    w.unmount()
  })

  it('carries the git change count onto the rail, capped at 99+', async () => {
    const w = mountPane({ collapsed: true, gitChangesCount: 0 })
    expect(w.find('.rail .rail-badge').exists()).toBe(false)
    await w.setProps({ gitChangesCount: 7 })
    expect(w.find('.rail .rail-badge').text()).toBe('7')
    await w.setProps({ gitChangesCount: 150 })
    expect(w.find('.rail .rail-badge').text()).toBe('99+')
    w.unmount()
  })
})
