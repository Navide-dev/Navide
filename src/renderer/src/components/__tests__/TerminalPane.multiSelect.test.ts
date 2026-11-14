// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { Ref } from 'vue'
import TerminalPane from '../TerminalPane.vue'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

// Coverage for the multi-select contract TerminalPane exposes to App.vue:
// the header click forwards the native MouseEvent (so App can read
// Cmd/Ctrl/Shift for the selection toggle), and the isSelected prop paints the
// batch-selection outline. useTerminal is mocked out (same setup as the loop
// button / cliContextDrag tests) so no xterm/backend is involved.

const mockTerminal = vi.hoisted(() => ({ displayStatus: null as unknown as Ref<string> }))

vi.mock('@navide/terminal', async (importOriginal) => {
  const { ref } = await import('vue')
  const actual = await importOriginal<typeof import('@navide/terminal')>()
  mockTerminal.displayStatus = ref('idle')
  return {
    ...actual,
    useTerminal: () => ({
      mount: vi.fn(),
      stopIneffective: { value: false },
      pasteText: vi.fn(),
      updateXtermTheme: vi.fn(),
      setDisableStdin: vi.fn(),
      displayStatus: mockTerminal.displayStatus,
      sessionId: { value: '' },
      isAltBuffer: ref(false)
    })
  }
})

function mountPane(props: Record<string, unknown>): VueWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(TerminalPane as any, {
    props: {
      paneId: 'pane-1',
      title: 'Claude',
      terminalPort: createTerminalDockStub(),
      cliProfiles: {},
      ...props,
    },
    global: { mocks: { $t: (key: string) => key } }
  })
}

describe('TerminalPane – multi-select contract', () => {
  let wrapper: VueWrapper

  afterEach(() => {
    wrapper.unmount()
  })

  it('adds the pane-selected class only when isSelected is true', async () => {
    wrapper = mountPane({ isSelected: false })
    expect(wrapper.find('.pane').classes()).not.toContain('pane-selected')

    await wrapper.setProps({ isSelected: true })
    expect(wrapper.find('.pane').classes()).toContain('pane-selected')
  })

  it('forwards the native event on header click so App can read modifier keys', async () => {
    wrapper = mountPane({})
    await wrapper.find('.pane-header').trigger('click', { metaKey: true })

    const events = wrapper.emitted('set-focus')
    expect(events).toBeTruthy()
    const payload = events![0][0] as MouseEvent
    expect(payload.metaKey).toBe(true)
  })

  it('emits set-focus without modifiers on a plain header click', async () => {
    wrapper = mountPane({})
    await wrapper.find('.pane-header').trigger('click')

    const payload = wrapper.emitted('set-focus')![0][0] as MouseEvent
    expect(payload.metaKey).toBe(false)
    expect(payload.ctrlKey).toBe(false)
    expect(payload.shiftKey).toBe(false)
  })
})
