// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import TerminalPane from '../TerminalPane.vue'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

// The bypass badge: a pane whose CLI started without its permission-bypass
// flag says so in the title bar; one that started with it says so in the
// status badge's tooltip. Same useTerminal mock as TerminalPane.staleConfigBadge.test.ts.

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
      displayStatus: ref('running'),
      sessionId: { value: '' },
      isAltBuffer: ref(false)
    })
  }
})

function mountPane(props: Record<string, unknown>): VueWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(TerminalPane as any, {
    props: { paneId: 'pane-1', title: 'Codex', terminalPort: createTerminalDockStub(), cliProfiles: {}, ...props },
    global: { mocks: { $t: (key: string) => key } }
  })
}

describe('TerminalPane – bypass badge', () => {
  let wrapper: VueWrapper

  afterEach(() => wrapper.unmount())

  it('shows the badge only for a pane launched without the flag', async () => {
    wrapper = mountPane({ permissionBypass: 'off' })
    const badge = wrapper.find('[data-testid="bypass-off"]')
    expect(badge.text()).toBe('pane.terminal.bypass-off')
    expect(badge.attributes('title')).toBe('pane.terminal.bypass-off-tooltip')
    await wrapper.setProps({ permissionBypass: 'on' })
    expect(wrapper.find('[data-testid="bypass-off"]').exists()).toBe(false)
    await wrapper.setProps({ permissionBypass: null })
    expect(wrapper.find('[data-testid="bypass-off"]').exists()).toBe(false)
  })

  it('names a launched flag in the status tooltip and nothing otherwise', async () => {
    wrapper = mountPane({ permissionBypass: 'on' })
    expect(wrapper.find('.status').attributes('title')).toBe('pane.terminal.bypass-on-tooltip')
    await wrapper.setProps({ permissionBypass: 'off' })
    expect(wrapper.find('.status').attributes('title') ?? '').toBe('')
  })
})
