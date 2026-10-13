// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import StageTabBar, { type TabItem } from '../StageTabBar.vue'

// Coverage for run-group tab drag-reorder on the StageTabBar. Tab drags carry
// dataTransfer type 'application/x-tab-key' (already distinct from the pane
// drag type 'application/x-pane-id'), and onTabDrop branches on it: a tab
// payload emits 'reorder-tab' (fromKey, toKey); a pane payload keeps the
// existing 'move-pane' behavior; self-drops are ignored.

const tabs: TabItem[] = [
  { key: 'rg-1', label: 'Claude', count: 2, live: 2, type: 'stage', status: 'active' },
  { key: 'rg-2', label: 'Codex', count: 1, live: 1, type: 'stage', status: 'idle' },
  { key: 'manual', label: '手動', count: 1, live: 1, type: 'manual', status: 'idle' }
]

/** DragEvent stand-in: happy-dom has no DataTransfer, so dispatch a plain
 *  cancelable Event with a stubbed dataTransfer attached. `data` maps
 *  dataTransfer type → payload (e.g. { 'application/x-tab-key': 'rg-1' }). */
function dragEvent(type: string, data: Record<string, string>): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(ev, {
    dataTransfer: {
      types: Object.keys(data),
      getData: (t: string) => data[t] ?? '',
      setData: vi.fn(),
      effectAllowed: ''
    }
  })
  return ev
}

describe('StageTabBar – tab drag-reorder', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    wrapper = mount(StageTabBar, { props: { tabs, modelValue: 'rg-1' }, global: { plugins: [i18n] } })
  })

  afterEach(() => {
    wrapper.unmount()
  })

  function tabBtn(idx: number): HTMLElement {
    return wrapper.findAll('.tab-btn')[idx].element as HTMLElement
  }

  it('dragstart on a stage tab sets the application/x-tab-key payload', () => {
    const ev = dragEvent('dragstart', {})
    tabBtn(0).dispatchEvent(ev)
    const dt = (ev as unknown as { dataTransfer: { setData: ReturnType<typeof vi.fn> } }).dataTransfer
    expect(dt.setData).toHaveBeenCalledWith('application/x-tab-key', 'rg-1')
  })

  it('emits reorder-tab with (fromKey, toKey) when a tab is dropped on another tab', async () => {
    tabBtn(1).dispatchEvent(dragEvent('drop', { 'application/x-tab-key': 'rg-1' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('reorder-tab')).toEqual([['rg-1', 'rg-2']])
    expect(wrapper.emitted('move-pane')).toBeUndefined()
  })

  it('ignores a tab dropped onto itself', async () => {
    tabBtn(0).dispatchEvent(dragEvent('drop', { 'application/x-tab-key': 'rg-1' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('reorder-tab')).toBeUndefined()
    expect(wrapper.emitted('move-pane')).toBeUndefined()
  })

  it('still emits move-pane for a pane payload (existing behavior preserved)', async () => {
    tabBtn(1).dispatchEvent(dragEvent('drop', { 'application/x-pane-id': 'pane-a' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('move-pane')).toEqual([['pane-a', 'rg-2']])
    expect(wrapper.emitted('reorder-tab')).toBeUndefined()
  })

  it('ignores a drop with neither payload (e.g. file drop)', async () => {
    tabBtn(1).dispatchEvent(dragEvent('drop', {}))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('reorder-tab')).toBeUndefined()
    expect(wrapper.emitted('move-pane')).toBeUndefined()
  })

  it('shows drag-over feedback on the hovered tab, clears on dragleave', async () => {
    tabBtn(1).dispatchEvent(dragEvent('dragenter', { 'application/x-tab-key': 'rg-1' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.tab-btn')[1].classes()).toContain('drag-over')

    tabBtn(1).dispatchEvent(dragEvent('dragleave', { 'application/x-tab-key': 'rg-1' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.tab-btn')[1].classes()).not.toContain('drag-over')
  })

  it('does not show drag-over feedback on the tab being dragged', async () => {
    tabBtn(0).dispatchEvent(dragEvent('dragstart', {}))
    tabBtn(0).dispatchEvent(dragEvent('dragenter', { 'application/x-tab-key': 'rg-1' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.tab-btn')[0].classes()).not.toContain('drag-over')

    // dragend resets the source flag, so a later foreign drag highlights again.
    tabBtn(0).dispatchEvent(dragEvent('dragend', {}))
    tabBtn(0).dispatchEvent(dragEvent('dragenter', { 'application/x-tab-key': 'rg-2' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.tab-btn')[0].classes()).toContain('drag-over')
  })
})

describe('StageTabBar – rebuild all', () => {
  it('emits rebuild-all from the refresh control', async () => {
    const wrapper = mount(StageTabBar, {
      props: { tabs, modelValue: 'rg-1', canRebuildAll: true },
      global: { plugins: [i18n] }
    })

    await wrapper.get('.tab-rebuild-all-btn').trigger('click')

    expect(wrapper.emitted('rebuild-all')).toEqual([[]])
    wrapper.unmount()
  })

  it('disables the refresh control when no pane can rebuild or a batch is running', async () => {
    const wrapper = mount(StageTabBar, {
      props: { tabs, modelValue: 'rg-1', canRebuildAll: false },
      global: { plugins: [i18n] }
    })
    const button = wrapper.get<HTMLButtonElement>('.tab-rebuild-all-btn')

    expect(button.element.disabled).toBe(true)
    await wrapper.setProps({ canRebuildAll: true, rebuildingAll: true })
    expect(button.element.disabled).toBe(true)
    expect(button.classes()).toContain('busy')

    wrapper.unmount()
  })
})
