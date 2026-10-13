// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { Ref } from 'vue'
import TerminalPane from '../TerminalPane.vue'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

// The per-pane toggle beside the account badge (plan claude_f1bf4b, scheme A):
// a pane follows the live account by default (blue link) and can be fixed to
// its account's own config dir (grey pin). The button is the "fix" toggle, so
// it reads pressed when the pane is fixed. App.vue owns the flag; the pane
// only shows it and asks to flip it. useTerminal is mocked
// out as in TerminalPane.usageLimitBadge.test.ts.

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

describe('TerminalPane – account follow toggle', () => {
  let wrapper: VueWrapper
  afterEach(() => wrapper.unmount())

  it('is absent unless the window offers it (prop left undefined)', () => {
    wrapper = mountPane({})
    expect(wrapper.find('[data-testid="account-follow-toggle"]').exists()).toBe(false)
  })

  it('shows a fixed pane as pressed (grey pin), with the fixed tooltip', () => {
    wrapper = mountPane({ accountFollow: 'fixed' })
    const btn = wrapper.get('[data-testid="account-follow-toggle"]')
    expect(btn.attributes('aria-pressed')).toBe('true')
    expect(btn.attributes('title')).toBe('account-follow.toggle-fixed-tooltip')
    expect(btn.classes()).not.toContain('on')
  })

  it('shows a following pane as not pressed (blue link), with the follow tooltip', () => {
    wrapper = mountPane({ accountFollow: 'follow' })
    const btn = wrapper.get('[data-testid="account-follow-toggle"]')
    expect(btn.attributes('aria-pressed')).toBe('false')
    expect(btn.attributes('title')).toBe('account-follow.toggle-follow-tooltip')
    expect(btn.classes()).toContain('on')
  })

  it('asks the window to flip it on click, either way', async () => {
    wrapper = mountPane({ accountFollow: 'follow' })
    await wrapper.get('[data-testid="account-follow-toggle"]').trigger('click')
    await wrapper.setProps({ accountFollow: 'fixed' })
    await wrapper.get('[data-testid="account-follow-toggle"]').trigger('click')
    expect(wrapper.emitted('toggle-account-follow')).toHaveLength(2)
  })
})
