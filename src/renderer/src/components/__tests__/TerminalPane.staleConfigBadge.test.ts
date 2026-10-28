// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { Ref } from 'vue'
import TerminalPane from '../TerminalPane.vue'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

// The stale-config badge: a pane whose CLI started before an MCP or skills
// change says so in the title bar, and clicking it asks for the usual rebuild.
// Same useTerminal mock as TerminalPane.stuckBadge.test.ts.

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

describe('TerminalPane – stale-config badge', () => {
  let wrapper: VueWrapper

  afterEach(() => {
    wrapper.unmount()
    mockTerminal.displayStatus.value = 'idle'
  })

  it('is hidden when nothing changed', () => {
    wrapper = mountPane({})
    expect(wrapper.find('.stale-config-inline').exists()).toBe(false)
    wrapper.unmount()
    wrapper = mountPane({ staleConfig: [] })
    expect(wrapper.find('.stale-config-inline').exists()).toBe(false)
  })

  it('names what changed and asks for a rebuild when clicked', async () => {
    wrapper = mountPane({ staleConfig: ['mcp'] })
    const badge = wrapper.find('.stale-config-inline')
    expect(badge.text()).toBe('pane.terminal.stale-config-badge')
    expect(badge.attributes('title')).toBe('pane.terminal.stale-config-tooltip-mcp')
    await wrapper.setProps({ staleConfig: ['skills'] })
    expect(wrapper.find('.stale-config-inline').attributes('title')).toBe('pane.terminal.stale-config-tooltip-skills')
    await wrapper.setProps({ staleConfig: ['mcp', 'skills'] })
    expect(wrapper.find('.stale-config-inline').attributes('title')).toBe('pane.terminal.stale-config-tooltip-both')
    await wrapper.find('.stale-config-inline').trigger('click')
    expect(wrapper.emitted('rebuild')).toHaveLength(1)
  })

  it('gives way to the exit state', () => {
    mockTerminal.displayStatus.value = 'exited'
    wrapper = mountPane({ staleConfig: ['mcp'] })
    expect(wrapper.find('.stale-config-inline').exists()).toBe(false)
  })
})
