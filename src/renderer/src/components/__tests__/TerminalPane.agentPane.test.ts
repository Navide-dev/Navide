// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { Ref } from 'vue'
import TerminalPane from '../TerminalPane.vue'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

// An agent pane (spec kind 'agent', plan agent-0-2-40_78e071) is a TerminalPane
// with the `agent` prop: identity in the header, control panel on the right,
// and none of the CLI-only chips. Without the prop nothing changes.

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
      stopIneffective: ref(false),
      awaitingKind: ref('permission'),
      sessionId: { value: '' },
      isAltBuffer: ref(false)
    })
  }
})

// Stubbed so this test does not need the channel and scheduler stores.
vi.mock('../agent/AgentControlPanel.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'AgentControlPanel',
      props: ['paneId', 'paneName', 'displayStatus', 'collapsed'],
      emits: ['toggle'],
      setup(props, { emit }) {
        return () => h('aside', {
          'data-testid': 'agent-control-panel',
          'data-collapsed': String(props.collapsed),
          onClick: () => emit('toggle')
        })
      }
    })
  }
})

const agent = { name: 'Secretary', color: '#0b8a9c', initial: 'S', vendor: 'Hermes Agent', createdAt: 0 }

function mountPane(props: Record<string, unknown>): VueWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(TerminalPane as any, {
    props: { paneId: 'pane-1', title: 'Secretary', agentKey: 'hermes', terminalPort: createTerminalDockStub(), cliProfiles: {}, ...props },
    global: { mocks: { $t: (key: string) => key } }
  })
}

describe('TerminalPane – agent pane', () => {
  let wrapper: VueWrapper

  afterEach(() => {
    wrapper.unmount()
    mockTerminal.displayStatus.value = 'idle'
  })

  it('draws the identity and the control panel', () => {
    wrapper = mountPane({ agent })
    expect(wrapper.find('.pane').classes()).toContain('pane-agent')
    expect(wrapper.find('[data-testid="agent-avatar"]').text()).toBe('S')
    expect(wrapper.find('[data-testid="agent-vendor"]').text()).toBe('Hermes Agent')
    expect(wrapper.find('[data-testid="agent-sub"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="agent-control-panel"]').exists()).toBe(true)
    expect(wrapper.find('.xterm-host').classes()).toContain('agent-with-panel')
  })

  it('leaves out the CLI-only chips', () => {
    wrapper = mountPane({ agent, loopActive: true, loginExpired: true, usageLimitHit: true, accountFollow: 'fixed', subtitle: 'cli sub' })
    expect(wrapper.find('.loop-inline').exists()).toBe(false)
    expect(wrapper.find('.loop-btn').exists()).toBe(false)
    expect(wrapper.find('.login-expired-inline').exists()).toBe(false)
    expect(wrapper.find('.usage-limit-inline').exists()).toBe(false)
    expect(wrapper.find('[data-testid="account-pin-indicator"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('cli sub')
  })

  it('keeps the shared status badge', () => {
    mockTerminal.displayStatus.value = 'awaiting'
    wrapper = mountPane({ agent })
    expect(wrapper.find('.status').attributes('data-status')).toBe('awaiting')
    expect(wrapper.find('.pane').classes()).toContain('pane-agent-awaiting')
  })

  it('folds the control panel on toggle', async () => {
    wrapper = mountPane({ agent })
    await wrapper.find('[data-testid="agent-control-panel"]').trigger('click')
    expect(wrapper.find('[data-testid="agent-control-panel"]').attributes('data-collapsed')).toBe('true')
    expect(wrapper.find('.xterm-host').classes()).toContain('agent-panel-folded')
  })

  it('renders a CLI pane exactly as before', () => {
    wrapper = mountPane({ agentKey: 'claude', loginExpired: true, subtitle: 'cli sub' })
    expect(wrapper.find('.pane').classes()).not.toContain('pane-agent')
    expect(wrapper.find('[data-testid="agent-control-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="agent-avatar"]').exists()).toBe(false)
    expect(wrapper.find('.login-expired-inline').exists()).toBe(true)
    expect(wrapper.text()).toContain('cli sub')
  })
})
