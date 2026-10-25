// @vitest-environment happy-dom
// A plugin's "main" view is a stage tab of its own. It sits after the run-group
// tabs, is active only when App says so, and a click asks App to show it rather
// than changing the run-group selection.
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import StageTabBar, { type TabItem } from '../StageTabBar.vue'

const tabs: TabItem[] = [
  { key: 'rg-1', label: 'Main', count: 2, live: 2, type: 'stage', status: 'active' },
]
const pluginTabs = [{ key: 'devmap.main', label: 'Devmap' }]

function mountBar(activePluginTab: string | null) {
  return mount(StageTabBar, {
    props: { tabs, pluginTabs, activePluginTab, modelValue: activePluginTab === null ? 'rg-1' : '' },
    global: { plugins: [i18n] },
  })
}

describe('StageTabBar – plugin main tabs', () => {
  it('renders plugin tabs after the run-group tabs', () => {
    const labels = mountBar(null).findAll('[role="tab"]').map((t) => t.text())
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
})
