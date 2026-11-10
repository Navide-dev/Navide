// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { Ref } from 'vue'
import TerminalPane from '../TerminalPane.vue'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

// The per-pane mute badge: hidden by default, rendered while the `muted` prop
// is set, and clicking it emits 'toggle-mute' (App.vue owns the state and its
// persistence). Same harness as TerminalPane.loginBadge.test.ts.

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

describe('TerminalPane – mute badge', () => {
  let wrapper: VueWrapper

  afterEach(() => {
    wrapper.unmount()
  })

  it('does not render the badge by default', () => {
    wrapper = mountPane({})
    expect(wrapper.find('.muted-inline').exists()).toBe(false)
  })

  it('renders the badge while muted and hides it when unmuted', async () => {
    wrapper = mountPane({ muted: true })
    const badge = wrapper.find('.muted-inline')
    expect(badge.exists()).toBe(true)
    expect(badge.attributes('role')).toBe('button')
    expect(badge.attributes('title')).toBe('pane.terminal.muted-tooltip')

    await wrapper.setProps({ muted: false })
    expect(wrapper.find('.muted-inline').exists()).toBe(false)
  })

  it('clicking the badge emits toggle-mute without focusing the pane', async () => {
    wrapper = mountPane({ muted: true })
    await wrapper.find('.muted-inline').trigger('click')
    expect(wrapper.emitted('toggle-mute')).toHaveLength(1)
    expect(wrapper.emitted('set-focus')).toBeUndefined()
  })
})
