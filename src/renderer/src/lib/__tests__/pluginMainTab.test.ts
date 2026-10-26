import { nextTick, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { usePluginMainTab } from '../pluginMainTab'

function setup(keys = ['devmap.main']) {
  const activeTab = ref('rg-1')
  const tabKeys = ref<string[]>(keys)
  return { activeTab, tabKeys, ...usePluginMainTab(activeTab, tabKeys) }
}

describe('usePluginMainTab', () => {
  it('starts with no plugin tab active', () => {
    expect(setup().activeKey.value).toBeNull()
  })

  it('leaves the plugin tab when the active run-group tab changes', async () => {
    // How "+" (createRunGroup), a pane revealed on another tab and MCP
    // ui.tab.switch to another tab all arrive: activeTab moves.
    const s = setup()
    s.open('devmap.main')
    s.activeTab.value = 'rg-2'
    await nextTick()
    expect(s.activeKey.value).toBeNull()
  })

  it('leaves on request when the run-group tab asked for is already active', () => {
    const s = setup()
    s.open('devmap.main')
    s.leave()
    expect(s.activeKey.value).toBeNull()
  })

  it('leaves when the active view goes away, and only then', async () => {
    const s = setup(['devmap.main', 'other.main'])
    s.open('devmap.main')
    s.tabKeys.value = ['devmap.main']
    await nextTick()
    expect(s.activeKey.value).toBe('devmap.main')
    s.tabKeys.value = []
    await nextTick()
    expect(s.activeKey.value).toBeNull()
  })
})
