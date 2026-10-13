// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import TerminalPane from '../TerminalPane.vue'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

// Coverage for the terminal's right-click menu (issue #12: right-click was
// inert app-wide). Main cannot read an xterm selection from the context-menu
// params — `.xterm` is `user-select: none`, so there is no DOM selection — so
// the pane sends `term.getSelection()` along with the request.
// useTerminal is mocked out: no xterm instance, no transport traffic.

const mockTerminal = vi.hoisted(() => ({ selection: '', mouseTracking: false }))

vi.mock('@navide/terminal', async (importOriginal) => {
  const { ref } = await import('vue')
  const actual = await importOriginal<typeof import('@navide/terminal')>()
  return {
    ...actual,
    useTerminal: () => ({
      mount: vi.fn(),
      pasteText: vi.fn(),
      updateXtermTheme: vi.fn(),
      setDisableStdin: vi.fn(),
      getSelection: () => mockTerminal.selection,
      isMouseTracking: () => mockTerminal.mouseTracking,
      displayStatus: ref('idle'),
      sessionId: { value: '' },
      isAltBuffer: ref(false)
    })
  }
})

const showTerminalContextMenu = vi.fn()
const terminalPort = {
  ...createTerminalDockStub(),
  showContextMenu: showTerminalContextMenu,
}

function mountPane(): VueWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(TerminalPane as any, {
    props: { paneId: 'pane-1', title: 'Claude', terminalPort, cliProfiles: {} },
    global: { mocks: { $t: (key: string) => key } }
  })
}

/** Right-click natively so `defaultPrevented` is observable. */
function rightClick(el: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...init })
  el.dispatchEvent(event)
  return event
}

describe('TerminalPane – right-click context menu', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { showTerminalContextMenu }
  })

  afterEach(() => {
    wrapper.unmount()
    vi.clearAllMocks()
    vi.restoreAllMocks()
    mockTerminal.selection = ''
    mockTerminal.mouseTracking = false
  })

  it('asks main for a menu, passing the terminal selection', () => {
    mockTerminal.selection = 'npm run build'
    wrapper = mountPane()

    rightClick(wrapper.find('.xterm-host').element)

    expect(showTerminalContextMenu).toHaveBeenCalledWith('npm run build')
  })

  it('still opens a menu with no selection (Paste stays reachable)', () => {
    wrapper = mountPane()

    rightClick(wrapper.find('.xterm-host').element)

    expect(showTerminalContextMenu).toHaveBeenCalledWith('')
  })

  it('suppresses the default menu so main does not open a second one', () => {
    wrapper = mountPane()

    const event = rightClick(wrapper.find('.xterm-host').element)

    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves the header right-click on its own pane menu', () => {
    wrapper = mountPane()

    rightClick(wrapper.find('header').element)

    expect(wrapper.emitted('context-menu')).toHaveLength(1)
    expect(showTerminalContextMenu).not.toHaveBeenCalled()
  })

  // Issue #190: with mouse tracking on, xterm forwards the right click to the
  // CLI, and Claude Code on Windows/Linux pastes (or copies) on it by itself.
  // A Navide menu on top offered a second Paste.
  describe('while the CLI tracks the mouse', () => {
    function onPlatform(platform: string): void {
      vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
    }

    it('leaves the right click to the CLI on Windows and Linux', () => {
      for (const platform of ['Win32', 'Linux x86_64']) {
        onPlatform(platform)
        mockTerminal.mouseTracking = true
        wrapper = mountPane()

        const event = rightClick(wrapper.find('.xterm-host').element)

        expect(showTerminalContextMenu).not.toHaveBeenCalled()
        expect(event.defaultPrevented).toBe(true)
        wrapper.unmount()
      }
      wrapper = mountPane()
    })

    it('still opens the menu on Shift+right-click, which xterm keeps from the CLI', () => {
      onPlatform('Win32')
      mockTerminal.mouseTracking = true
      wrapper = mountPane()

      rightClick(wrapper.find('.xterm-host').element, { shiftKey: true })

      expect(showTerminalContextMenu).toHaveBeenCalledWith('')
    })

    it('still opens the menu in a plain shell (no mouse tracking) on Windows and Linux', () => {
      for (const platform of ['Win32', 'Linux x86_64']) {
        onPlatform(platform)
        wrapper = mountPane()

        rightClick(wrapper.find('.xterm-host').element)

        expect(showTerminalContextMenu).toHaveBeenCalledWith('')
        showTerminalContextMenu.mockClear()
        wrapper.unmount()
      }
      wrapper = mountPane()
    })

    it('changes nothing on macOS: the menu opens as before', () => {
      onPlatform('MacIntel')
      mockTerminal.mouseTracking = true
      wrapper = mountPane()

      rightClick(wrapper.find('.xterm-host').element)

      expect(showTerminalContextMenu).toHaveBeenCalledWith('')
    })
  })
})
