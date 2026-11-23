// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { Ref } from 'vue'
import TerminalPane from '../TerminalPane.vue'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

// Coverage for the login-expired badge: hidden by default, rendered while the
// loginExpired prop is set, and clicking it emits 'fix-login' (App.vue owns
// the login-command injection and flag clearing). useTerminal is mocked out —
// no xterm instance, no backend traffic (same setup as
// TerminalPane.loopButton.test.ts).

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

function tMock(key: string): string {
  return key
}

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
    global: { mocks: { $t: tMock } }
  })
}

describe('TerminalPane – login-expired badge', () => {
  let wrapper: VueWrapper

  afterEach(() => {
    wrapper.unmount()
    mockTerminal.displayStatus.value = 'idle'
  })

  it('does not render the badge by default', () => {
    wrapper = mountPane({})
    expect(wrapper.find('.login-expired-inline').exists()).toBe(false)
  })

  it('renders the badge when loginExpired is set and hides it when cleared', async () => {
    wrapper = mountPane({ loginExpired: true })
    const badge = wrapper.find('.login-expired-inline')
    expect(badge.exists()).toBe(true)
    expect(badge.attributes('role')).toBe('button')

    await wrapper.setProps({ loginExpired: false })
    expect(wrapper.find('.login-expired-inline').exists()).toBe(false)
  })

  it('emits fix-login when the badge is clicked', async () => {
    wrapper = mountPane({ loginExpired: true })
    await wrapper.find('.login-expired-inline').trigger('click')
    expect(wrapper.emitted('fix-login')).toHaveLength(1)
  })

  it('renders the tools-not-connected badge only while mcpNeverConnected is set', async () => {
    wrapper = mountPane({})
    expect(wrapper.find('.mcp-never-connected-inline').exists()).toBe(false)
    await wrapper.setProps({ mcpNeverConnected: true })
    const badge = wrapper.find('.mcp-never-connected-inline')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('pane.terminal.mcp-never-connected-badge')
    await wrapper.setProps({ mcpNeverConnected: false })
    expect(wrapper.find('.mcp-never-connected-inline').exists()).toBe(false)
  })

  it('asks App.vue to reconnect when the tools-not-connected badge is clicked', async () => {
    const reconnectMcp = vi.fn()
    wrapper = mountPane({ mcpNeverConnected: true, reconnectMcp })
    const badge = wrapper.find('.mcp-never-connected-inline')
    expect(badge.attributes('role')).toBe('button')
    await badge.trigger('click')
    expect(reconnectMcp).toHaveBeenCalledTimes(1)
  })
})
