// @vitest-environment happy-dom
// The Layout tab. Mounts against the real store — the point of these is that
// the controls and the state agree, so stubbing the store would test nothing.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'

const store = new Map<string, unknown>()
vi.mock('../../lib/settings', () => ({
  settingsGet: <T,>(key: string, fallback: T): T => (store.has(key) ? (store.get(key) as T) : fallback),
  settingsSet: (key: string, value: unknown): void => { store.set(key, value) },
  onSettingsChanged: () => () => {},
}))

const LayoutSettingsPane = (await import('../LayoutSettingsPane.vue')).default
const { useLayoutStore, _resetLayoutStoreForTest } = await import('../useLayoutStore')

function mountPane(): VueWrapper {
  return mount(LayoutSettingsPane, { global: { mocks: { $t: (key: string) => key } } }) as VueWrapper
}

/** The card for one region, found by its heading. */
function card(w: VueWrapper, slotKey: string) {
  return w.findAll('.ls-slot').find((c) => c.find('.ls-slot-name').text() === slotKey)!
}

describe('LayoutSettingsPane', () => {
  beforeEach(() => {
    store.clear()
    _resetLayoutStoreForTest()
  })

  it('shows a card for every region, including the fixed one', () => {
    const w = mountPane()
    const names = w.findAll('.ls-slot-name').map((n) => n.text())
    expect(names).toContain('layout.slot.up')
    expect(names).toContain('layout.slot.left')
    expect(names).toContain('layout.slot.right')
    expect(names).toContain('layout.slot.down')
    expect(names).toContain('layout.slot.main')
    w.unmount()
  })

  it('lists the views each region holds', () => {
    const w = mountPane()
    const left = card(w, 'layout.slot.left')
    expect(left.findAll('.ls-view-name').map((n) => n.text())).toEqual([
      'label.agents', 'label.pipeline', 'label.explorer', 'label.git', 'label.plans',
    ])
    w.unmount()
  })

  it('says an empty region takes no space rather than showing a blank list', () => {
    const w = mountPane()
    expect(card(w, 'layout.slot.up').find('.ls-empty').exists()).toBe(true)
    w.unmount()
  })

  it('moves a view when a destination is picked', async () => {
    const w = mountPane()
    const right = card(w, 'layout.slot.right')
    // history is the first row on the right and can go up or down.
    await right.findAll('.ls-move')[0].setValue('down')
    expect(useLayoutStore().slotOf('history')).toBe('down')
    expect(card(mountPane(), 'layout.slot.down').findAll('.ls-view-name')).toHaveLength(1)
    w.unmount()
  })

  it('offers no destination for a view that is pinned to its host', () => {
    const w = mountPane()
    const agentsRow = card(w, 'layout.slot.left').findAll('.ls-view')[0]
    expect(agentsRow.find('.ls-move').attributes('disabled')).toBeDefined()
    expect(agentsRow.find('.ls-move option').text()).toBe('layout.pinned')
    w.unmount()
  })

  it('removes a view and offers it back under a hidden section', async () => {
    const w = mountPane()
    await card(w, 'layout.slot.left').findAll('.ls-hide')[4].trigger('click')
    expect(useLayoutStore().slotOf('plans')).toBeNull()

    const after = mountPane()
    const hidden = card(after, 'layout.hidden')
    expect(hidden.find('.ls-view-name').text()).toContain('label.plans')
    await hidden.find('.ls-restore').trigger('click')
    expect(useLayoutStore().slotOf('plans')).toBe('left')
    w.unmount()
    after.unmount()
  })

  it('drives the region size through the store, clamped to its range', async () => {
    const w = mountPane()
    const input = card(w, 'layout.slot.left').find('.ls-size-input')
    await input.setValue('9999')
    expect(useLayoutStore().layout.value.slots.left.size).toBe(560)
    w.unmount()
  })

  it('cannot collapse a region with nothing in it', () => {
    const w = mountPane()
    expect(card(w, 'layout.slot.up').find('.ls-toggle input').attributes('disabled')).toBeDefined()
    expect(card(w, 'layout.slot.left').find('.ls-toggle input').attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('toggles the status bar but leaves the title bar fixed', async () => {
    const w = mountPane()
    const chrome = card(w, 'layout.chrome')
    const [titlebar, statusbar] = chrome.findAll('.ls-toggle input')
    expect(titlebar.attributes('disabled')).toBeDefined()
    await statusbar.setValue(false)
    expect(useLayoutStore().layout.value.chrome.statusbar).toBe(false)
    w.unmount()
  })

  it('reset undoes every change at once', async () => {
    const s = useLayoutStore()
    s.moveView('history', 'down')
    s.hideView('tasker')
    s.setSlotSize('left', 500)
    const w = mountPane()
    await w.find('.ls-reset').trigger('click')
    expect(s.slotOf('history')).toBe('right')
    expect(s.slotOf('tasker')).toBe('right')
    expect(s.layout.value.slots.left.size).toBe(360)
    w.unmount()
  })
})
