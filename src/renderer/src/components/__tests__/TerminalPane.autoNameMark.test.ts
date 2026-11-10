// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { Ref } from 'vue'
import TerminalPane from '../TerminalPane.vue'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

// Coverage for the auto-name marker: a pane whose title the app wrote for the
// user carries a ◦ next to it, so a name nobody chose is recognisable without
// hovering. useTerminal is mocked out — no xterm instance, no backend traffic
// (same setup as TerminalPane.loginBadge.test.ts).

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
      title: 'Fix login redirect',
      terminalPort: createTerminalDockStub(),
      cliProfiles: {},
      ...props,
    },
    global: { mocks: { $t: tMock } }
  })
}

describe('TerminalPane – auto-name marker', () => {
  let wrapper: VueWrapper

  afterEach(() => {
    wrapper.unmount()
  })

  it('stays hidden for a title the user owns', () => {
    wrapper = mountPane({})
    expect(wrapper.find('.auto-name-mark').exists()).toBe(false)
  })

  it('marks an auto-derived title without altering it', () => {
    wrapper = mountPane({ autoNamed: true })
    const mark = wrapper.get('.auto-name-mark')
    expect(mark.text()).toBe('◦')
    expect(mark.attributes('title')).toBe('pane.terminal.auto-named-tooltip')
    // Decoration only: the title text itself must stay exactly what App.vue
    // passed, since it doubles as the pane's inter-CLI messaging address.
    expect(wrapper.get('.title').text()).toBe('Fix login redirect')
  })

  it('clears the marker as soon as the pane is renamed', async () => {
    wrapper = mountPane({ autoNamed: true })
    await wrapper.setProps({ autoNamed: false })
    expect(wrapper.find('.auto-name-mark').exists()).toBe(false)
  })

  it('gets out of the way while the title is being edited', async () => {
    wrapper = mountPane({ autoNamed: true })
    await wrapper.get('.title').trigger('dblclick')
    // The rename input replaces the title; a marker beside it would sit next to
    // the text the user is typing and read as part of the new name.
    expect(wrapper.find('.title-edit').exists()).toBe(true)
    expect(wrapper.find('.auto-name-mark').exists()).toBe(false)
  })
})
