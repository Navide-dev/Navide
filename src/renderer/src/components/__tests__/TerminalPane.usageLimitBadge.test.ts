// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { Ref } from 'vue'
import TerminalPane from '../TerminalPane.vue'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

// Coverage for dismissing the quota badge: a click asks for confirmation and
// emits 'usage-limit-dismiss' only when accepted (App.vue owns the flag
// clearing and the loop resume). useTerminal is mocked out —
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

describe('TerminalPane – usage-limit badge dismiss', () => {
  let wrapper: VueWrapper

  afterEach(() => {
    wrapper.unmount()
    vi.restoreAllMocks()
  })

  it('renders the badge as a button', () => {
    wrapper = mountPane({ usageLimitHit: true, usageLimitUntil: null })
    expect(wrapper.find('.usage-limit-inline').attributes('role')).toBe('button')
  })

  it('emits usage-limit-dismiss when the confirm is accepted', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    wrapper = mountPane({ usageLimitHit: true, usageLimitUntil: null })
    await wrapper.find('.usage-limit-inline').trigger('click')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('usage-limit-dismiss')).toHaveLength(1)
  })

  it('emits nothing when the confirm is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    wrapper = mountPane({ usageLimitHit: true, usageLimitUntil: null })
    await wrapper.find('.usage-limit-inline').trigger('click')
    expect(wrapper.emitted('usage-limit-dismiss')).toBeUndefined()
  })
})
