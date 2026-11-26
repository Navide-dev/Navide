// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import TerminalPane from '../TerminalPane.vue'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'
import { createRichTurns, richTurnsKey } from '../../composables/useRichTurns'
import { i18n } from '@navide/plugin-ui/foundation'

// The "Terminal | Formatted" toggle: the formatted view is laid over the
// terminal, which stays mounted and is never cleared. Same useTerminal mock
// as TerminalPane.bypassBadge.test.ts.

const terminalMocks = vi.hoisted(() => ({ clear: vi.fn(), fit: vi.fn() }))

vi.mock('@navide/terminal', async (importOriginal) => {
  const { ref } = await import('vue')
  const actual = await importOriginal<typeof import('@navide/terminal')>()
  return {
    ...actual,
    useTerminal: () => ({
      mount: vi.fn(),
      clear: terminalMocks.clear,
      fit: terminalMocks.fit,
      stopIneffective: { value: false },
      pasteText: vi.fn(),
      updateXtermTheme: vi.fn(),
      setDisableStdin: vi.fn(),
      displayStatus: ref('running'),
      sessionId: { value: '' },
      isAltBuffer: ref(false)
    })
  }
})

type Handler = (payload: unknown) => void

function mountPane(props: Record<string, unknown>): { wrapper: VueWrapper; emit: Handler } {
  const handlers: Handler[] = []
  const richTurns = createRichTurns({ on: ((event: string, h: Handler) => { if (event === 'agent.activity') handlers.push(h) }) as never })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapper = mount(TerminalPane as any, {
    props: { paneId: 'pane-1', title: 'Claude', terminalPort: createTerminalDockStub(), cliProfiles: {}, ...props },
    global: { plugins: [i18n], mocks: { $t: (key: string) => key }, provide: { [richTurnsKey as symbol]: richTurns } }
  })
  return { wrapper, emit: (p) => handlers.forEach((h) => h(p)) }
}

describe('TerminalPane – rich output toggle', () => {
  let wrapper: VueWrapper

  afterEach(() => wrapper.unmount())

  it('starts on the terminal and lays the formatted view over it', async () => {
    const pane = mountPane({ agentKey: 'claude' })
    wrapper = pane.wrapper
    expect(wrapper.find('[data-testid="rich-toggle-terminal"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-testid="rich-output"]').exists()).toBe(false)

    pane.emit({ pane_id: 'pane-1', event_type: 'turn_complete', text: 'All **done**' })
    await wrapper.find('[data-testid="rich-toggle-rich"]').trigger('click')
    expect(wrapper.find('[data-testid="rich-output"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="rich-reply"]').text()).toContain('done')
    // The terminal stays mounted underneath, untouched.
    expect(wrapper.find('.xterm-host').exists()).toBe(true)

    await wrapper.find('[data-testid="rich-toggle-terminal"]').trigger('click')
    expect(wrapper.find('[data-testid="rich-output"]').exists()).toBe(false)
    expect(terminalMocks.clear).not.toHaveBeenCalled()
    expect(terminalMocks.fit).not.toHaveBeenCalled()
  })

  it('ignores turns of other panes', async () => {
    const pane = mountPane({ agentKey: 'codex' })
    wrapper = pane.wrapper
    pane.emit({ pane_id: 'pane-2', event_type: 'turn_complete', text: 'elsewhere' })
    await wrapper.find('[data-testid="rich-toggle-rich"]').trigger('click')
    expect(wrapper.find('[data-testid="rich-empty"]').exists()).toBe(true)
  })

  it('disables the toggle, with the reason, where no conversation log is read', () => {
    for (const props of [{ agentKey: 'kiro' }, { agentKey: 'claude', sshRemote: { host: 'h', cli: 'claude' } }]) {
      const pane = mountPane(props)
      const group = pane.wrapper.find('[data-testid="rich-toggle"]')
      expect(group.attributes('title')).toBe('pane.rich.unsupported')
      expect(pane.wrapper.find('[data-testid="rich-toggle-rich"]').attributes('disabled')).toBeDefined()
      pane.wrapper.unmount()
    }
    wrapper = mountPane({ agentKey: 'terminal' }).wrapper
    expect(wrapper.find('[data-testid="rich-toggle"]').exists()).toBe(false)
  })
})
