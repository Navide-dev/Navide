// @vitest-environment happy-dom
// A plugin's "main" view is a stage tab of its own. It sits after the run-group
// tabs, is active only when App says so, and a click asks App to show it rather
// than changing the run-group selection.
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import StageTabBar, { type TabItem } from '../StageTabBar.vue'

const stageTabBarSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/StageTabBar.vue'), 'utf8')

const tabs: TabItem[] = [
  { key: 'rg-1', label: 'Main', count: 2, live: 2, type: 'stage', status: 'active' },
]
const pluginTabs = [{ key: 'devmap.main', label: 'Devmap', pluginId: 'nerdtechnic.devmap', source: 'marketplace' as const }]

function mountBar(activePluginTab: string | null) {
  return mount(StageTabBar, {
    props: { tabs, pluginTabs, activePluginTab, modelValue: activePluginTab === null ? 'rg-1' : '' },
    global: { plugins: [i18n] },
  })
}

describe('StageTabBar – plugin main tabs', () => {
  it('renders plugin tabs after the run-group tabs', () => {
    const labels = mountBar(null).findAll('[role="tab"]').map((t) => t.get('.tab-label, .tab-plugin-label').text())
    expect(labels[labels.length - 1]).toBe('Devmap')
    expect(labels).toHaveLength(2)
  })

  it('keeps the run-group tab active until the plugin tab is chosen', () => {
    const bar = mountBar(null)
    expect(bar.find('[data-plugin-tab="devmap.main"]').classes()).not.toContain('active')
    expect(bar.find('.tab-type-stage').classes()).toContain('active')
  })

  it('emits select-plugin-tab on click, not a run-group change', async () => {
    const bar = mountBar(null)
    await bar.find('[data-plugin-tab="devmap.main"]').trigger('click')
    expect(bar.emitted('select-plugin-tab')).toEqual([['devmap.main']])
    expect(bar.emitted('update:modelValue')).toBeUndefined()
  })

  it('shows the plugin tab as the only active one while it is selected', async () => {
    const bar = mountBar('devmap.main')
    expect(bar.find('[data-plugin-tab="devmap.main"]').attributes('aria-selected')).toBe('true')
    expect(bar.find('.tab-type-stage').classes()).not.toContain('active')
    // Back to the run group: App clears the plugin key on update:modelValue.
    await bar.find('.tab-type-stage').trigger('click')
    expect(bar.emitted('update:modelValue')).toEqual([['rg-1']])
  })

  it('marks a plugin tab as a Navide plugin and names its id, publisher and source', () => {
    const tab = mountBar(null).get('[data-plugin-tab="devmap.main"]')
    expect(tab.find('.tab-plugin-mark').exists()).toBe(true)
    const title = tab.attributes('title')!
    expect(title).toContain(i18n.global.t('stageTab.plugin-tab', { title: 'Devmap' }))
    expect(title).toContain('nerdtechnic.devmap')
    expect(title).toContain(i18n.global.t('pluginDisclosure.source.publisher', { publisher: 'nerdtechnic' }))
    expect(title).toContain(i18n.global.t('pluginDisclosure.source.marketplace'))
    expect(tab.attributes('aria-label')).toBe(title)
    // A reviewed Marketplace release carries no source mark, as in the title bar.
    expect(tab.find('.tab-plugin-source-mark').exists()).toBe(false)
  })

  it('tells two same-named plugins apart, and marks a local one', () => {
    const bar = mount(StageTabBar, {
      props: {
        tabs,
        modelValue: 'rg-1',
        pluginTabs: [
          { key: 'a.main', label: 'Run 1', pluginId: 'acme.runner' },
          { key: 'b.main', label: 'Run 1', pluginId: 'other.runner', source: 'local-unsigned' as const },
        ],
      },
      global: { plugins: [i18n] },
    })
    const a = bar.get('[data-plugin-tab="a.main"]')
    const b = bar.get('[data-plugin-tab="b.main"]')
    expect(a.attributes('title')).not.toBe(b.attributes('title'))
    expect(b.attributes('title')).toContain(i18n.global.t('pluginDisclosure.source.local-unsigned'))
    // Nothing vouches for the publisher of an unsigned or unknown package.
    const selfDeclared = (publisher: string) =>
      i18n.global.t('pluginDisclosure.source.publisher', {
        publisher: i18n.global.t('pluginDisclosure.source.selfDeclared', { publisher }),
      })
    expect(b.attributes('title')).toContain(selfDeclared('other'))
    expect(a.attributes('title')).toContain(selfDeclared('acme'))
    expect(b.attributes('title')).not.toContain(i18n.global.t('pluginDisclosure.source.publisher', { publisher: 'other' }))
    expect(a.find('.tab-plugin-source-mark').exists()).toBe(false)
    expect(b.find('.tab-plugin-source-mark').exists()).toBe(true)
  })

  it('calls the publisher of a developer folder self-declared', () => {
    const bar = mount(StageTabBar, {
      props: { tabs, modelValue: 'rg-1', pluginTabs: [{ key: 'd.main', label: 'Dev', pluginId: 'me.dev', source: 'developer-unpacked' as const }] },
      global: { plugins: [i18n] },
    })
    expect(bar.get('[data-plugin-tab="d.main"]').attributes('title')).toContain(
      i18n.global.t('pluginDisclosure.source.selfDeclared', { publisher: 'me' })
    )
  })

  it('spells out invisible characters in the visible name and the tooltip', () => {
    const bar = mount(StageTabBar, {
      props: { tabs, modelValue: 'rg-1', pluginTabs: [{ key: 'z.main', label: 'Run​ 1', pluginId: 'z.tool' }] },
      global: { plugins: [i18n] },
    })
    const tab = bar.get('[data-plugin-tab="z.main"]')
    expect(tab.get('.tab-plugin-label').text()).toBe('Run\\u{200b} 1')
    expect(tab.attributes('title')).toContain('Run\\u{200b} 1')
  })

  it('ends a long plugin name in an ellipsis, on the plugin label only', () => {
    const rule = stageTabBarSource.match(/\.tab-plugin-label \{[^}]*\}/)?.[0] ?? ''
    expect(rule).toContain('max-width: 160px;')
    expect(rule).toContain('text-overflow: ellipsis;')
    expect(rule).toContain('overflow: hidden;')
  })
})
