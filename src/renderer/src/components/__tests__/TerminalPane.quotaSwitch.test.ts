// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { Ref } from 'vue'
import TerminalPane from '../TerminalPane.vue'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

// The follow-switch flag's quota button (agentTeam.accounts.followSwitch):
// shown only when App.vue offers it, emitting quota-switch-account. With the
// flag off App.vue never offers it, and the header is exactly as before.
// useTerminal is mocked out — no xterm instance, no backend traffic (same setup as
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

describe('TerminalPane – quota switch-account button', () => {
  let wrapper: VueWrapper

  afterEach(() => {
    wrapper.unmount()
    vi.restoreAllMocks()
  })

  it('is absent when not offered (flag off): the header is unchanged', () => {
    wrapper = mountPane({ usageLimitHit: true, usageLimitUntil: null })
    expect(wrapper.find('[data-testid="usage-limit-switch"]').exists()).toBe(false)
    const plain = mountPane({ usageLimitHit: true, usageLimitUntil: null, quotaSwitchOffered: false })
    expect(plain.find('.header-main').html()).toBe(wrapper.find('.header-main').html())
    plain.unmount()
  })

  it('is absent while the pane is not out of quota, even when offered', () => {
    wrapper = mountPane({ usageLimitHit: false, quotaSwitchOffered: true })
    expect(wrapper.find('[data-testid="usage-limit-switch"]').exists()).toBe(false)
  })

  it('emits quota-switch-account without dismissing the badge', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    wrapper = mountPane({ usageLimitHit: true, usageLimitUntil: null, quotaSwitchOffered: true })
    await wrapper.find('[data-testid="usage-limit-switch"]').trigger('click')
    expect(wrapper.emitted('quota-switch-account')).toHaveLength(1)
    expect(wrapper.emitted('usage-limit-dismiss')).toBeUndefined()
    expect(confirm).not.toHaveBeenCalled()
  })
})
