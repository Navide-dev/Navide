// @vitest-environment happy-dom
// The keybindings.json round trip and the two things that make editing safe:
// a write has to reach every window, and the recorder has to be able to read a
// raw keystroke without the dispatcher firing the command it is bound to.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import {
  _resetKeybindingsState,
  getUserRules,
  initKeybindingsPort,
  isKeyCaptureActive,
  onUserRulesChanged,
  saveUserRules,
  setKeyCaptureActive,
  setUserRules,
  useKeybindings,
} from '../useKeybindings'
import { registerCommand, _resetRegistry } from '../commandRegistry'
import { setContext } from '../contextService'

// These cases pin the macOS rule table and tooltips (⌘N, ⌘,); happy-dom's
// navigator.platform reads as non-mac, which would add the Ctrl+Alt+N / Ctrl+,
// rules. platformSidebarKeys.test.ts covers Windows and Linux.
vi.hoisted(() => {
  Object.defineProperty(globalThis.navigator, 'platform', { value: 'MacIntel', configurable: true })
})

const Host = defineComponent({
  setup() {
    useKeybindings()
    return () => h('div')
  },
})

interface Bridge {
  readKeybindings: ReturnType<typeof vi.fn>
  writeKeybindings: ReturnType<typeof vi.fn>
  onKeybindingsChanged: ReturnType<typeof vi.fn>
}

let bridge: Bridge
let wrapper: VueWrapper | undefined

function installBridge(content = '[]'): void {
  bridge = {
    readKeybindings: vi.fn().mockResolvedValue({ ok: true, content }),
    writeKeybindings: vi.fn().mockResolvedValue({ ok: true }),
    onKeybindingsChanged: vi.fn(),
  }
  ;(window as unknown as { agentTeam: Bridge }).agentTeam = bridge
}

function dispatch(init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(e)
  return e
}

beforeEach(() => {
  _resetRegistry()
  _resetKeybindingsState()
  installBridge()
  initKeybindingsPort({
    read: () => bridge.readKeybindings(),
    write: (content) => bridge.writeKeybindings(content),
    onChanged: (callback) => {
      bridge.onKeybindingsChanged(callback)
      return () => {}
    },
  })
  setContext('editorOpen', false)
  setContext('terminalFocus', false)
  setContext('modalOpen', false)
  setContext('paneStage', false)
  setContext('gitWindow', false)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  delete (window as unknown as { agentTeam?: Bridge }).agentTeam
  initKeybindingsPort({})
})

describe('saveUserRules', () => {
  it('applies the rules locally and persists them as JSON', async () => {
    const result = await saveUserRules([{ key: 'cmd+alt+s', command: 'editor.action.save' }])
    expect(result.ok).toBe(true)
    expect(getUserRules()).toEqual([{ key: 'cmd+alt+s', command: 'editor.action.save' }])

    const written = bridge.writeKeybindings.mock.calls[0][0] as string
    expect(JSON.parse(written)).toEqual([{ key: 'cmd+alt+s', command: 'editor.action.save' }])
  })

  it('reports a write failure instead of pretending it saved', async () => {
    bridge.writeKeybindings.mockResolvedValue({ ok: false, error: 'EACCES' })
    expect(await saveUserRules([])).toEqual({ ok: false, error: 'EACCES' })
  })

  it('reports a rejected write', async () => {
    bridge.writeKeybindings.mockRejectedValue(new Error('boom'))
    const result = await saveUserRules([])
    expect(result.ok).toBe(false)
    expect(result.error).toContain('boom')
  })

  it('still applies locally when no bridge is available', async () => {
    delete (window as unknown as { agentTeam?: Bridge }).agentTeam
    initKeybindingsPort({})
    const result = await saveUserRules([{ key: 'cmd+alt+s', command: 'editor.action.save' }])
    expect(result.ok).toBe(false)
    expect(getUserRules()).toHaveLength(1)
  })

  it('persists what took effect, not what was handed in', async () => {
    // A rule set that would strand the way into Settings is sanitized before it
    // is applied; the file must match, or it would keep rules the app ignores.
    await saveUserRules([{ key: 'cmd+,', command: '-workbench.action.openSettings' }])
    const written = JSON.parse(bridge.writeKeybindings.mock.calls[0][0] as string)
    expect(written).toEqual([])
    expect(getUserRules()).toEqual([])
  })

  it('leaves a deliberate rebind of a protected command intact on disk', async () => {
    const rules = [
      { key: 'cmd+,', command: '-workbench.action.openSettings' },
      { key: 'cmd+alt+,', command: 'workbench.action.openSettings' },
    ]
    await saveUserRules(rules)
    expect(JSON.parse(bridge.writeKeybindings.mock.calls[0][0] as string)).toEqual(rules)
  })

  it('a saved rebind takes effect on the very next keystroke', async () => {
    wrapper = mount(Host)
    const fired = vi.fn()
    registerCommand('editor.action.save', fired)
    setContext('editorOpen', true)

    await saveUserRules([
      { key: 'cmd+s', command: '-editor.action.save', when: 'editorOpen && !terminalFocus' },
      { key: 'cmd+alt+s', command: 'editor.action.save', when: 'editorOpen && !terminalFocus' },
    ])

    dispatch({ key: 's', metaKey: true })
    expect(fired).not.toHaveBeenCalled()
    dispatch({ key: 's', metaKey: true, altKey: true })
    expect(fired).toHaveBeenCalledTimes(1)
  })
})

describe('cross-window propagation', () => {
  it('subscribes to the main-process broadcast on first mount', () => {
    wrapper = mount(Host)
    expect(bridge.onKeybindingsChanged).toHaveBeenCalledTimes(1)
  })

  it('applies rules pushed from another window', () => {
    wrapper = mount(Host)
    const push = bridge.onKeybindingsChanged.mock.calls[0][0] as (c: string) => void
    push('[{"key":"cmd+alt+s","command":"editor.action.save"}]')
    expect(getUserRules()).toEqual([{ key: 'cmd+alt+s', command: 'editor.action.save' }])
  })

  it('ignores a corrupt payload rather than throwing away the window', () => {
    wrapper = mount(Host)
    setUserRules([{ key: 'cmd+alt+s', command: 'editor.action.save' }])
    const push = bridge.onKeybindingsChanged.mock.calls[0][0] as (c: string) => void
    expect(() => push('}{ not json')).not.toThrow()
    expect(getUserRules()).toEqual([])
  })

  it('loads the persisted file on first mount', async () => {
    installBridge('[{"key":"cmd+alt+s","command":"editor.action.save"}]')
    wrapper = mount(Host)
    await Promise.resolve()
    await Promise.resolve()
    expect(getUserRules()).toHaveLength(1)
  })
})

describe('onUserRulesChanged', () => {
  it('notifies subscribers and stops after unsubscribe', () => {
    const seen = vi.fn()
    const off = onUserRulesChanged(seen)
    setUserRules([{ key: 'cmd+alt+s', command: 'a.b' }])
    expect(seen).toHaveBeenCalledTimes(1)
    off()
    setUserRules([])
    expect(seen).toHaveBeenCalledTimes(1)
  })
})

describe('setKeyCaptureActive', () => {
  it('suspends dispatch so the recorder can read the raw keystroke', () => {
    wrapper = mount(Host)
    const fired = vi.fn()
    registerCommand('workbench.action.showCommands', fired)

    setKeyCaptureActive(true)
    expect(isKeyCaptureActive()).toBe(true)
    const suppressed = dispatch({ key: 'P', metaKey: true, shiftKey: true })
    expect(fired).not.toHaveBeenCalled()
    expect(suppressed.defaultPrevented).toBe(false) // left for the recorder to consume

    setKeyCaptureActive(false)
    dispatch({ key: 'P', metaKey: true, shiftKey: true })
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it('does not leave a half-entered chord behind when capture ends', () => {
    wrapper = mount(Host)
    const fired = vi.fn()
    registerCommand('workbench.action.selectTheme', fired)

    dispatch({ key: 'k', metaKey: true }) // chord prefix armed
    setKeyCaptureActive(true)
    setKeyCaptureActive(false)

    // Without the reset the next key would be read as the chord's second half.
    dispatch({ key: 't', metaKey: true })
    expect(fired).not.toHaveBeenCalled()
  })
})
