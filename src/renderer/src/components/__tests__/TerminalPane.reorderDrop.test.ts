// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import TerminalPane from '../TerminalPane.vue'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

// Coverage for the pane-reorder drop target on `.pane-header`: dropping another
// pane's header (dataTransfer type 'application/x-pane-id') emits 'reorder-drop'
// with the dragged pane's id; drops of the pane onto itself, or without a pane
// id payload, are ignored. The real terminal is irrelevant here, so useTerminal
// is mocked out — no xterm instance, no backend traffic.

vi.mock('@navide/terminal', async (importOriginal) => {
  const { ref } = await import('vue')
  const actual = await importOriginal<typeof import('@navide/terminal')>()
  return {
    ...actual,
    useTerminal: () => ({
      mount: vi.fn(),
      stopIneffective: { value: false },
      pasteText: vi.fn(),
      updateXtermTheme: vi.fn(),
      setDisableStdin: vi.fn(),
      displayStatus: ref('idle'),
      sessionId: ref(''),
      isAltBuffer: ref(false)
    })
  }
})

const PANE_ID = 'pane-self'

/** DragEvent stand-in: happy-dom has no DataTransfer, so dispatch a plain
 *  cancelable Event with a stubbed dataTransfer attached. */
function dragEvent(type: string, paneId: string | null): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(ev, {
    dataTransfer: {
      types: paneId === null ? [] : ['application/x-pane-id'],
      getData: (t: string) => (t === 'application/x-pane-id' ? (paneId ?? '') : ''),
      setData: vi.fn(),
      effectAllowed: ''
    }
  })
  return ev
}

describe('TerminalPane – reorder-drop on pane header', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapper = mount(TerminalPane as any, {
      props: {
        paneId: PANE_ID,
        title: 'Claude',
        terminalPort: createTerminalDockStub(),
        cliProfiles: {},
      },
      global: { mocks: { $t: (key: string) => key } }
    })
  })

  afterEach(() => {
    wrapper.unmount()
  })

  function header(): HTMLElement {
    return wrapper.find('.pane-header').element as HTMLElement
  }

  it('emits reorder-drop with the dragged pane id on drop', async () => {
    header().dispatchEvent(dragEvent('drop', 'pane-other'))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('reorder-drop')).toEqual([['pane-other']])
  })

  it('ignores a drop of the pane onto itself', async () => {
    header().dispatchEvent(dragEvent('drop', PANE_ID))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('reorder-drop')).toBeUndefined()
  })

  it('ignores a drop without a pane-id payload (e.g. file drop)', async () => {
    header().dispatchEvent(dragEvent('drop', null))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('reorder-drop')).toBeUndefined()
  })

  it('shows drag-over feedback while a pane drag hovers, clears on dragleave', async () => {
    header().dispatchEvent(dragEvent('dragover', 'pane-other'))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.pane-header').classes()).toContain('drag-over')

    header().dispatchEvent(dragEvent('dragleave', 'pane-other'))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.pane-header').classes()).not.toContain('drag-over')
  })

  it('does not show drag-over feedback for a non-pane drag (no x-pane-id type)', async () => {
    header().dispatchEvent(dragEvent('dragover', null))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.pane-header').classes()).not.toContain('drag-over')
  })

  it('does not show drag-over feedback while this pane itself is the drag source', async () => {
    header().dispatchEvent(dragEvent('dragstart', PANE_ID))
    header().dispatchEvent(dragEvent('dragover', PANE_ID))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.pane-header').classes()).not.toContain('drag-over')

    // dragend resets the source flag, so a later foreign drag highlights again.
    header().dispatchEvent(dragEvent('dragend', PANE_ID))
    header().dispatchEvent(dragEvent('dragover', 'pane-other'))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.pane-header').classes()).toContain('drag-over')
  })
})
