// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { Ref } from 'vue'
import TerminalPane from '../TerminalPane.vue'
import UsageBadge from '../UsageBadge.vue'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

// The per-pane follow flag (plan claude_f1bf4b, scheme A): a pane follows the
// live account by default and can be fixed to its account's own config dir.
// The toggle itself lives in the account badge's popover; the header only
// shows a pin when the pane is fixed. App.vue owns the flag; the pane passes
// it to the badge and forwards the badge's request to flip it. useTerminal is
// mocked out as in TerminalPane.usageLimitBadge.test.ts.

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
    global: { mocks: { $t: (key: string) => key }, stubs: { UsageBadge: true } }
  })
}

describe('TerminalPane – account follow flag', () => {
  let wrapper: VueWrapper
  afterEach(() => wrapper.unmount())

  it('has no separate follow button in the header, whatever the flag', () => {
    for (const accountFollow of [undefined, 'follow', 'fixed']) {
      wrapper = mountPane({ agentKey: 'claude', accountFollow })
      expect(wrapper.find('[data-testid="account-follow-toggle"]').exists()).toBe(false)
      wrapper.unmount()
    }
    wrapper = mountPane({})
  })

  it('shows the pin only when the pane is fixed, with a tooltip and a label', () => {
    wrapper = mountPane({ agentKey: 'claude', accountFollow: 'fixed' })
    const pin = wrapper.get('[data-testid="account-pin-indicator"]')
    expect(pin.attributes('title')).toBe('account-follow.pinned-indicator-tooltip')
    expect(pin.attributes('aria-label')).toBe('account-follow.pinned-indicator-label')
  })

  it('shows no pin for a following pane, or when the window does not offer the flag', async () => {
    wrapper = mountPane({ agentKey: 'claude', accountFollow: 'follow' })
    expect(wrapper.find('[data-testid="account-pin-indicator"]').exists()).toBe(false)
    await wrapper.setProps({ accountFollow: undefined })
    expect(wrapper.find('[data-testid="account-pin-indicator"]').exists()).toBe(false)
  })

  it('hands the flag to the badge and forwards its request to flip it', async () => {
    wrapper = mountPane({ agentKey: 'claude', accountFollow: 'follow' })
    const badge = wrapper.findComponent(UsageBadge)
    expect(badge.props('paneFollow')).toBe('follow')
    badge.vm.$emit('toggle-pane-follow')
    await wrapper.setProps({ accountFollow: 'fixed' })
    expect(wrapper.findComponent(UsageBadge).props('paneFollow')).toBe('fixed')
    wrapper.findComponent(UsageBadge).vm.$emit('toggle-pane-follow')
    expect(wrapper.emitted('toggle-account-follow')).toHaveLength(2)
  })
})
