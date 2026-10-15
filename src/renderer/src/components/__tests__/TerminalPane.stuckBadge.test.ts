// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { Ref } from 'vue'
import TerminalPane from '../TerminalPane.vue'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

// The stuck badge: a turn in flight with no log activity and no output for a
// long time says so in the title bar. Same useTerminal mock as
// TerminalPane.loginBadge.test.ts.

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

function tMock(key: string, params?: Record<string, unknown>): string {
  return params ? `${key}:${JSON.stringify(params)}` : key
}

function mountPane(props: Record<string, unknown>): VueWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(TerminalPane as any, {
    props: { paneId: 'pane-1', title: 'Claude', terminalPort: createTerminalDockStub(), cliProfiles: {}, ...props },
    global: { mocks: { $t: tMock } }
  })
}

describe('TerminalPane – stuck badge', () => {
  let wrapper: VueWrapper

  afterEach(() => {
    wrapper.unmount()
    mockTerminal.displayStatus.value = 'idle'
  })

  it('is hidden by default', () => {
    wrapper = mountPane({})
    expect(wrapper.find('.stuck-inline').exists()).toBe(false)
  })

  it('shows while stuckSince is set on a live pane, with the threshold in minutes', async () => {
    mockTerminal.displayStatus.value = 'running'
    wrapper = mountPane({ stuckSince: 1 })
    const badge = wrapper.find('.stuck-inline')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('pane.terminal.stuck-badge:{"minutes":20}')
    expect(badge.attributes('title')).toBe('pane.terminal.stuck-tooltip:{"minutes":20}')
    await wrapper.setProps({ stuckSince: null })
    expect(wrapper.find('.stuck-inline').exists()).toBe(false)
  })

  it('gives way to the exit state', () => {
    mockTerminal.displayStatus.value = 'exited'
    wrapper = mountPane({ stuckSince: 1 })
    expect(wrapper.find('.stuck-inline').exists()).toBe(false)
  })
})
