// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import StageTabBar, { type TabItem } from '../StageTabBar.vue'

// Every tab — stage or the synthetic manual tab — hands its right-click to
// App.vue, which opens the one run-group menu shared with the sidebar. The bar
// exposes renameTab so that menu can start the tab's inline rename.

const tabs: TabItem[] = [
  { key: 'rg-1', label: 'Claude', count: 2, live: 2, type: 'stage', status: 'active' },
  { key: 'manual', label: 'manual', count: 1, live: 1, type: 'manual', status: 'idle' }
]

describe('StageTabBar – tab right-click', () => {
  let wrapper: VueWrapper

  afterEach(() => {
    wrapper.unmount()
  })

  function mountBar(): void {
    wrapper = mount(StageTabBar, { props: { tabs, modelValue: 'rg-1' }, global: { plugins: [i18n] }, attachTo: document.body })
  }

  function rightClick(idx: number): MouseEvent {
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
    wrapper.findAll('.tab-btn')[idx].element.dispatchEvent(ev)
    return ev
  }

  it('stage and manual tabs both emit context-menu and suppress the native menu', () => {
    mountBar()
    const a = rightClick(0)
    const b = rightClick(1)
    expect(a.defaultPrevented && b.defaultPrevented).toBe(true)
    const emitted = wrapper.emitted('context-menu') as unknown[][]
    expect(emitted.map((e) => e[0])).toEqual(['rg-1', 'manual'])
  })

  it('renameTab opens the inline rename for a stage tab', async () => {
    mountBar()
    ;(wrapper.vm as unknown as { renameTab: (k: string) => void }).renameTab('rg-1')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.tab-rename-input').exists()).toBe(true)
  })

  it('renameTab leaves the manual tab alone, like double-click does', async () => {
    mountBar()
    ;(wrapper.vm as unknown as { renameTab: (k: string) => void }).renameTab('manual')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.tab-rename-input').exists()).toBe(false)
  })

  it('keeps the native menu while the tab is being renamed, so Paste works', async () => {
    mountBar()
    ;(wrapper.vm as unknown as { renameTab: (k: string) => void }).renameTab('rg-1')
    await wrapper.vm.$nextTick()
    const ev = rightClick(0)
    expect(ev.defaultPrevented).toBe(false)
    expect(wrapper.emitted('context-menu')).toBeUndefined()
  })
})
