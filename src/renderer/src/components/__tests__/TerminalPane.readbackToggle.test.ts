// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { Ref } from 'vue'
import TerminalPane from '../TerminalPane.vue'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

// The per-pane 🔊 readback toggle: absent unless readback is switched on in
// Settings (default off), and clicking it emits 'toggle-readback' (App.vue owns
// the mark). Same harness as TerminalPane.muteBadge.test.ts.

const mockTerminal = vi.hoisted(() => ({ displayStatus: null as unknown as Ref<string> }))

vi.mock('@navide/terminal', async (importOriginal) => {
  const { ref } = await import('vue')
  const actual = await importOriginal<typeof import('@navide/terminal')>()
  mockTerminal.displayStatus = ref('idle')
  return {
    ...actual,
    useTerminal: () => ({
      mount: vi.fn(),
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

describe('TerminalPane – readback toggle', () => {
  let wrapper: VueWrapper

  afterEach(() => {
    wrapper.unmount()
  })

  it('readback off (the default): no toggle at all', () => {
    wrapper = mountPane({})
    expect(wrapper.find('.readback-toggle').exists()).toBe(false)
    wrapper.unmount()
    wrapper = mountPane({ readback: true })
    expect(wrapper.find('.readback-toggle').exists()).toBe(false)
  })

  it('readback on: an unmarked toggle, marked when the pane is marked', async () => {
    wrapper = mountPane({ readbackAvailable: true })
    const btn = wrapper.get('.readback-toggle')
    expect(btn.attributes('aria-pressed')).toBe('false')
    expect(btn.attributes('title')).toBe('pane.terminal.readback-off-tooltip')
    await wrapper.setProps({ readback: true })
    expect(wrapper.get('.readback-toggle').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('.readback-toggle').attributes('title')).toBe('pane.terminal.readback-on-tooltip')
  })

  it('says it is speaking while this pane is being read out', async () => {
    wrapper = mountPane({ readbackAvailable: true, readback: true })
    expect(wrapper.get('.readback-toggle').text()).not.toContain('pane.terminal.readback-speaking')
    await wrapper.setProps({ readbackSpeaking: true })
    expect(wrapper.get('.readback-toggle').text()).toContain('pane.terminal.readback-speaking')
  })

  it('clicking emits toggle-readback without focusing the pane', async () => {
    wrapper = mountPane({ readbackAvailable: true })
    await wrapper.get('.readback-toggle').trigger('click')
    expect(wrapper.emitted('toggle-readback')).toHaveLength(1)
    expect(wrapper.emitted('set-focus')).toBeUndefined()
  })
})
