// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { Ref } from 'vue'
import TerminalPane from '../TerminalPane.vue'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

// The update-available badge: a pane whose CLI has a newer release says so in
// the title bar, and clicking it asks App.vue to open that CLI's update.
// Same useTerminal mock as TerminalPane.staleConfigBadge.test.ts.

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

describe('TerminalPane – update-available badge', () => {
  let wrapper: VueWrapper

  afterEach(() => wrapper.unmount())

  it('is hidden without a newer release', () => {
    wrapper = mountPane({})
    expect(wrapper.find('[data-testid="update-available-badge"]').exists()).toBe(false)
    wrapper.unmount()
    wrapper = mountPane({ updateAvailable: null })
    expect(wrapper.find('[data-testid="update-available-badge"]').exists()).toBe(false)
  })

  it('names both versions and opens the update when clicked', async () => {
    const openCliUpdate = vi.fn()
    wrapper = mountPane({ agentKey: 'codex', updateAvailable: { version: '0.166.0', latest: '0.167.1' }, openCliUpdate })
    const badge = wrapper.find('[data-testid="update-available-badge"]')
    expect(badge.text()).toBe('pane.terminal.update-available-badge')
    expect(badge.attributes('title')).toBe('pane.terminal.update-available-tooltip:{"latest":"0.167.1","version":"0.166.0"}')
    await badge.trigger('click')
    expect(openCliUpdate).toHaveBeenCalledTimes(1)
    // The badge's click is its own: it does not also focus the pane.
    expect(wrapper.emitted('set-focus')).toBeUndefined()
  })
})
