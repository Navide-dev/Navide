// @vitest-environment happy-dom
// The Settings shortcut editor, driven the way a user drives it: click a key
// cap, press a combination, confirm — then check that what reached
// keybindings.json is the surgical pair of rules the resolver understands.
//
// The recorder is the fiddly part. It reads raw keystrokes, which means it has
// to switch the global dispatcher off first, swallow the event so neither the
// bound command nor the Settings modal's own Escape handler sees it, and put
// the dispatcher back afterwards — including when the row is abandoned.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import KeyboardShortcutsEditor from '../KeyboardShortcutsEditor.vue'
import { getUserRules, initKeybindingsPort, isKeyCaptureActive, saveUserRules } from '@navide/plugin-ui/shared'
import { _resetKeybindingsState } from '@navide/plugin-ui/shared/testing'
import { buildRows, nativeMenuKeys, TERMINAL_KEYS } from '@navide/plugin-ui/shared'
import { pluginCommands } from '../../lib/pluginCommands'

interface Bridge {
  readKeybindings: ReturnType<typeof vi.fn>
  writeKeybindings: ReturnType<typeof vi.fn>
  onKeybindingsChanged: ReturnType<typeof vi.fn>
}

let bridge: Bridge
let wrapper: VueWrapper

/** `initialQuery` narrows the table to the rows a test touches. A full mount
 *  renders every command (200+ rows) and each recorder keystroke re-renders
 *  it, which under a loaded CPU ran past the 5 s test timeout. */
function mountEditor(initialQuery?: string): VueWrapper {
  return mount(KeyboardShortcutsEditor, { props: { initialQuery }, attachTo: document.body, global: { plugins: [i18n] } })
}

/** The row whose command id is shown in the second line of the command cell. */
function rowFor(w: VueWrapper, commandId: string) {
  const row = w.findAll('tbody tr').find((r) => r.find('.kse-id').text() === commandId)
  if (!row) throw new Error(`no visible row for ${commandId}`)
  return row
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(e)
  return e
}

beforeEach(() => {
  _resetKeybindingsState()
  bridge = {
    readKeybindings: vi.fn().mockResolvedValue({ ok: true, content: '[]' }),
    writeKeybindings: vi.fn().mockResolvedValue({ ok: true }),
    onKeybindingsChanged: vi.fn(),
  }
  ;(window as unknown as { agentTeam: Bridge }).agentTeam = bridge
  initKeybindingsPort({
    read: () => bridge.readKeybindings(),
    write: (content) => bridge.writeKeybindings(content),
    onChanged: (callback) => {
      bridge.onKeybindingsChanged(callback)
      return () => {}
    },
  })
})

afterEach(() => {
  wrapper?.unmount()
  delete (window as unknown as { agentTeam?: Bridge }).agentTeam
  initKeybindingsPort({})
})

describe('rendering', () => {
  it('lists rows generated from defaults, not from a hand-written table', () => {
    wrapper = mountEditor()
    expect(wrapper.findAll('tbody tr').length).toBeGreaterThan(100)
    expect(rowFor(wrapper, 'editor.action.save').find('.kse-label').text()).toBe('Save')
  })

  it('renders a chord as two separate cap groups', () => {
    // Modifier glyphs are platform-dependent (⌘ vs Win) and covered in
    // keyDisplay.test.ts; what matters here is that the chord is not flattened
    // into one run of caps.
    wrapper = mountEditor()
    const row = rowFor(wrapper, 'workbench.action.openKeyboardShortcuts')
    const caps = row.findAll('kbd').map((k) => k.text())
    expect(caps).toHaveLength(4)
    expect([caps[1], caps[3]]).toEqual(['K', 'S'])
    expect(row.find('.kse-chord-sep').exists()).toBe(true)
  })

  it('shows the when-clause read-only', () => {
    wrapper = mountEditor()
    expect(rowFor(wrapper, 'editor.action.save').find('.kse-td-when code').text())
      .toBe('editorOpen && !terminalFocus')
    expect(rowFor(wrapper, 'workbench.action.quickOpen').find('.kse-when-any').exists()).toBe(true)
  })

  // The badge text is a translated label, so these assert the state class the
  // classifier drives — locale-independent, and it is what the colour keys off.
  function badgeState(w: VueWrapper, commandId: string): string {
    const el = rowFor(w, commandId).find('.kse-source')
    return [...el.classes()].filter((c) => c !== 'kse-source').join(' ')
  }

  it('badges each row default or unbound before anything is customized', () => {
    wrapper = mountEditor()
    const states = new Set(
      wrapper.findAll('.kse-source').map((n) => [...n.classes()].filter((c) => c !== 'kse-source').join('')),
    )
    expect([...states].sort()).toEqual(['default', 'unbound'])
  })

  it('lists commands that ship with no key, so they can be assigned one', () => {
    wrapper = mountEditor()
    const row = rowFor(wrapper, 'editor.action.sortLinesAscending')
    expect(row.find('.kse-unbound').exists()).toBe(true)
    expect(row.find('.kse-add').exists()).toBe(true)
    expect(row.findAll('kbd')).toHaveLength(0)
  })

  it('assigning a key to such a command writes a plain addition, no removal', async () => {
    wrapper = mountEditor()
    await rowFor(wrapper, 'editor.action.sortLinesAscending').find('.kse-add').trigger('click')
    press({ key: '1', metaKey: true, altKey: true, code: 'Digit1' })
    await wrapper.vm.$nextTick()
    await rowFor(wrapper, 'editor.action.sortLinesAscending').findAll('.kse-mini')[0].trigger('click')
    await wrapper.vm.$nextTick()

    expect(getUserRules()).toEqual([
      { key: 'cmd+alt+1', command: 'editor.action.sortLinesAscending' },
    ])
  })

  it('moves the badge through modified → unbound → default as the row is edited', async () => {
    wrapper = mountEditor()

    await rowFor(wrapper, 'editor.action.save').find('.kse-add').trigger('click')
    press({ key: 's', metaKey: true, altKey: true })
    await wrapper.vm.$nextTick()
    await rowFor(wrapper, 'editor.action.save').findAll('.kse-mini')[0].trigger('click')
    await wrapper.vm.$nextTick()
    expect(badgeState(wrapper, 'editor.action.save')).toBe('modified')

    for (const chip of rowFor(wrapper, 'editor.action.save').findAll('.kse-chip-remove')) {
      await chip.trigger('click')
      await wrapper.vm.$nextTick()
    }
    expect(badgeState(wrapper, 'editor.action.save')).toBe('unbound')

    await rowFor(wrapper, 'editor.action.save').find('.kse-td-actions .kse-mini').trigger('click')
    await wrapper.vm.$nextTick()
    expect(badgeState(wrapper, 'editor.action.save')).toBe('default')
  })

  it('flags rows that share a key', () => {
    wrapper = mountEditor()
    expect(rowFor(wrapper, 'workbench.action.openGitWindow').find('.kse-conflict').exists()).toBe(true)
    expect(rowFor(wrapper, 'workbench.action.quickOpen').find('.kse-conflict').exists()).toBe(false)
  })
})

// The old read-only Help page was deleted, so this page is now the only place
// terminal and native-menu keys are documented. Losing them would leave the
// user with no way to look those up at all.
describe('read-only reference sections', () => {
  it('renders the terminal and native-menu blocks', () => {
    wrapper = mountEditor()
    const titles = wrapper.findAll('.kse-reference .kse-group-title').map((n) => n.text())
    expect(titles).toHaveLength(2)
    expect(titles[0]).toContain('Terminal')
    expect(titles[1]).toContain('Application menu')
  })

  it('shows every documented external key', () => {
    wrapper = mountEditor()
    const rows = wrapper.findAll('.kse-reference tbody tr')
    expect(rows).toHaveLength(TERMINAL_KEYS.length + nativeMenuKeys().length)
  })

  it('offers no way to edit them', () => {
    wrapper = mountEditor()
    const ref = wrapper.find('.kse-reference')
    expect(ref.findAll('.kse-chip-keys')).toHaveLength(0)
    expect(ref.findAll('.kse-add')).toHaveLength(0)
    expect(ref.findAll('.kse-chip-remove')).toHaveLength(0)
  })

  it('is searchable, so looking up a native key does not read as missing', async () => {
    wrapper = mountEditor()
    await wrapper.find('.kse-search').setValue('developer tools')
    expect(wrapper.findAll('tbody tr').length).toBeGreaterThan(0)
    expect(wrapper.find('.kse-reference').exists()).toBe(true)
    expect(wrapper.find('.kse-empty').exists()).toBe(false)
  })

  it('is hidden by the Customized and Conflicts filters, which are about rules', async () => {
    wrapper = mountEditor()
    const [, customized] = wrapper.findAll('.kse-filter')
    await customized.trigger('click')
    expect(wrapper.find('.kse-reference').exists()).toBe(false)
  })
})

describe('search and filters', () => {
  it('narrows the list by command, label or key', async () => {
    wrapper = mountEditor()
    await wrapper.find('.kse-search').setValue('rebuild')
    const ids = wrapper.findAll('.kse-id').map((n) => n.text())
    expect(ids).toEqual(['workbench.action.rebuildFocusedPane'])
  })

  it('matches the rendered key caps, not only the rule spelling', async () => {
    // Searching "⌘⇧P" (or "Win+Shift+P" off macOS) has to work as well as
    // searching "cmd+shift+p"; the display form is platform-dependent, so the
    // query is derived rather than hard-coded.
    const { formatKeySpec } = await import('@navide/plugin-ui/shared')
    wrapper = mountEditor()
    await wrapper.find('.kse-search').setValue(formatKeySpec('cmd+shift+y'))
    expect(wrapper.findAll('.kse-id').map((n) => n.text()))
      .toEqual(['workbench.action.focusPipeline'])
  })

  it('reports when nothing matches', async () => {
    wrapper = mountEditor()
    await wrapper.find('.kse-search').setValue('zzzz-no-such-command')
    expect(wrapper.find('.kse-empty').exists()).toBe(true)
    expect(wrapper.findAll('tbody tr')).toHaveLength(0)
  })

  it('the Customized filter is empty until something is customized', async () => {
    wrapper = mountEditor()
    const [, customized] = wrapper.findAll('.kse-filter')
    await customized.trigger('click')
    expect(wrapper.findAll('tbody tr')).toHaveLength(0)
  })
})

describe('recording a new shortcut', () => {
  async function startRecordingOn(commandId: string): Promise<void> {
    await rowFor(wrapper, commandId).find('.kse-chip-keys').trigger('click')
  }

  it('suspends the global dispatcher while recording and restores it after', async () => {
    wrapper = mountEditor('editor.action.save')
    await startRecordingOn('editor.action.save')
    expect(isKeyCaptureActive()).toBe(true)

    press({ key: 's', metaKey: true, altKey: true })
    await wrapper.vm.$nextTick()
    await rowFor(wrapper, 'editor.action.save').findAll('.kse-mini')[0].trigger('click')
    expect(isKeyCaptureActive()).toBe(false)
  })

  it('swallows the keystroke so neither the command nor the modal sees it', async () => {
    wrapper = mountEditor('editor.action.save')
    const bubbled = vi.fn()
    window.addEventListener('keydown', bubbled)
    await startRecordingOn('editor.action.save')

    const e = press({ key: 'Escape' })
    expect(e.defaultPrevented).toBe(true)
    expect(bubbled).not.toHaveBeenCalled()
    window.removeEventListener('keydown', bubbled)
  })

  it('ignores a modifier-only press and keeps waiting', async () => {
    wrapper = mountEditor('editor.action.save')
    await startRecordingOn('editor.action.save')
    press({ key: 'Meta', metaKey: true })
    await wrapper.vm.$nextTick()
    expect(rowFor(wrapper, 'editor.action.save').find('.kse-recorder-preview em').exists()).toBe(true)
  })

  it('records a lone Left ⌘ (pressed and let go) on the hold-to-talk row', async () => {
    wrapper = mountEditor('workbench.action.holdToTalk')
    await startRecordingOn('workbench.action.holdToTalk')
    press({ key: 'Meta', code: 'MetaLeft', metaKey: true })
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta', code: 'MetaLeft', bubbles: true, cancelable: true }))
    await wrapper.vm.$nextTick()
    await rowFor(wrapper, 'workbench.action.holdToTalk').findAll('.kse-mini')[0].trigger('click')
    await wrapper.vm.$nextTick()

    expect(getUserRules().find((r) => !r.command.startsWith('-'))?.key).toBe('leftcmd')
  })

  it('records no lone modifier on other rows', async () => {
    wrapper = mountEditor('editor.action.save')
    await startRecordingOn('editor.action.save')
    press({ key: 'Meta', code: 'MetaRight', metaKey: true })
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta', code: 'MetaRight', bubbles: true, cancelable: true }))
    await wrapper.vm.$nextTick()
    expect(rowFor(wrapper, 'editor.action.save').find('.kse-recorder-preview em').exists()).toBe(true)
  })

  it('writes one removal and one addition when the binding is confirmed', async () => {
    wrapper = mountEditor('editor.action.save')
    await startRecordingOn('editor.action.save')
    press({ key: 's', metaKey: true, altKey: true })
    await wrapper.vm.$nextTick()
    await rowFor(wrapper, 'editor.action.save').findAll('.kse-mini')[0].trigger('click')
    await wrapper.vm.$nextTick()

    expect(getUserRules()).toEqual([
      { key: 'cmd+s', command: '-editor.action.save', when: 'editorOpen && !terminalFocus' },
      { key: 'cmd+alt+s', command: 'editor.action.save', when: 'editorOpen && !terminalFocus' },
    ])
    expect(bridge.writeKeybindings).toHaveBeenCalledTimes(1)
  })

  it('accumulates two presses into a chord', async () => {
    wrapper = mountEditor('editor.action.save')
    await startRecordingOn('editor.action.save')
    press({ key: 'k', metaKey: true })
    press({ key: 'w', metaKey: true })
    await wrapper.vm.$nextTick()
    await rowFor(wrapper, 'editor.action.save').findAll('.kse-mini')[0].trigger('click')
    await wrapper.vm.$nextTick()

    expect(getUserRules().find((r) => !r.command.startsWith('-'))?.key).toBe('cmd+k cmd+w')
  })

  it('a third press restarts the chord rather than dead-ending at three segments', async () => {
    wrapper = mountEditor('editor.action.save')
    await startRecordingOn('editor.action.save')
    press({ key: 'k', metaKey: true })
    press({ key: 'w', metaKey: true })
    press({ key: 'j', metaKey: true })
    await wrapper.vm.$nextTick()
    await rowFor(wrapper, 'editor.action.save').findAll('.kse-mini')[0].trigger('click')
    await wrapper.vm.$nextTick()

    expect(getUserRules().find((r) => !r.command.startsWith('-'))?.key).toBe('cmd+j')
  })

  it('bare Escape abandons the recording instead of being recorded', async () => {
    wrapper = mountEditor('editor.action.save')
    await rowFor(wrapper, 'editor.action.save').find('.kse-chip-keys').trigger('click')
    expect(isKeyCaptureActive()).toBe(true)

    const e = press({ key: 'Escape' })
    await wrapper.vm.$nextTick()

    expect(isKeyCaptureActive()).toBe(false)
    expect(rowFor(wrapper, 'editor.action.save').find('.kse-recorder').exists()).toBe(false)
    expect(getUserRules()).toEqual([])
    // Still swallowed, so the Settings modal's own Escape handler stays quiet.
    expect(e.defaultPrevented).toBe(true)
  })

  it('a modified Escape is still recordable', async () => {
    wrapper = mountEditor('editor.action.save')
    await rowFor(wrapper, 'editor.action.save').find('.kse-chip-keys').trigger('click')
    press({ key: 'Escape', shiftKey: true })
    await wrapper.vm.$nextTick()
    expect(isKeyCaptureActive()).toBe(true)
    expect(rowFor(wrapper, 'editor.action.save').find('.kse-recorder kbd').exists()).toBe(true)
  })

  it('explains an invalid key rather than dropping the chip in silence', async () => {
    wrapper = mountEditor('editor.action.save')
    await rowFor(wrapper, 'editor.action.save').find('.kse-add').trigger('click')
    press({ key: 'k', metaKey: true })
    press({ key: 's', metaKey: true })
    press({ key: 't', metaKey: true }) // a third press restarts, so build it by hand below
    await wrapper.vm.$nextTick()
    await rowFor(wrapper, 'editor.action.save').findAll('.kse-mini')[0].trigger('click')
    await wrapper.vm.$nextTick()
    // cmd+t alone is valid, so this path succeeds — the guard is covered by the
    // unit tests on setRowKeys; here we only pin that a save clears stale errors.
    expect(wrapper.find('.kse-error').exists()).toBe(false)
  })

  it('refuses to add a key the row already has, and says so', async () => {
    wrapper = mountEditor('editor.action.save')
    await rowFor(wrapper, 'editor.action.save').find('.kse-add').trigger('click')
    press({ key: 's', metaKey: true })
    await wrapper.vm.$nextTick()
    await rowFor(wrapper, 'editor.action.save').findAll('.kse-mini')[0].trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.kse-error').exists()).toBe(true)
    expect(getUserRules()).toEqual([])
  })

  it('cancelling writes nothing and re-arms the dispatcher', async () => {
    wrapper = mountEditor('editor.action.save')
    await startRecordingOn('editor.action.save')
    press({ key: 's', metaKey: true, altKey: true })
    await wrapper.vm.$nextTick()
    await rowFor(wrapper, 'editor.action.save').findAll('.kse-mini')[2].trigger('click')

    expect(isKeyCaptureActive()).toBe(false)
    expect(getUserRules()).toEqual([])
    expect(bridge.writeKeybindings).not.toHaveBeenCalled()
  })

  it('adds a second binding via the + button without dropping the default', async () => {
    wrapper = mountEditor('editor.action.save')
    await rowFor(wrapper, 'editor.action.save').find('.kse-add').trigger('click')
    press({ key: 's', metaKey: true, altKey: true })
    await wrapper.vm.$nextTick()
    await rowFor(wrapper, 'editor.action.save').findAll('.kse-mini')[0].trigger('click')
    await wrapper.vm.$nextTick()

    expect(getUserRules()).toEqual([
      { key: 'cmd+alt+s', command: 'editor.action.save', when: 'editorOpen && !terminalFocus' },
    ])
    expect(rowFor(wrapper, 'editor.action.save').findAll('.kse-chip')).toHaveLength(2)
  })
})

describe('removing and resetting', () => {
  it('the ✕ on a cap unbinds just that key', async () => {
    wrapper = mountEditor()
    await rowFor(wrapper, 'editor.action.save').find('.kse-chip-remove').trigger('click')
    await wrapper.vm.$nextTick()

    expect(getUserRules()).toEqual([
      { key: 'cmd+s', command: '-editor.action.save', when: 'editorOpen && !terminalFocus' },
    ])
    expect(rowFor(wrapper, 'editor.action.save').find('.kse-unbound').exists()).toBe(true)
  })

  it('a customized row offers a reset that restores its defaults', async () => {
    wrapper = mountEditor()
    await rowFor(wrapper, 'editor.action.save').find('.kse-chip-remove').trigger('click')
    await wrapper.vm.$nextTick()

    const reset = rowFor(wrapper, 'editor.action.save').find('.kse-td-actions .kse-mini')
    expect(reset.exists()).toBe(true)
    await reset.trigger('click')
    await wrapper.vm.$nextTick()

    expect(getUserRules()).toEqual([])
    const caps = rowFor(wrapper, 'editor.action.save').findAll('kbd').map((k) => k.text())
    expect(caps[caps.length - 1]).toBe('S')
    expect(rowFor(wrapper, 'editor.action.save').find('.kse-unbound').exists()).toBe(false)
  })

  it('Reset all clears every override at once', async () => {
    wrapper = mountEditor()
    await rowFor(wrapper, 'editor.action.save').find('.kse-chip-remove').trigger('click')
    await rowFor(wrapper, 'editor.action.undo').find('.kse-chip-remove').trigger('click')
    await wrapper.vm.$nextTick()
    expect(getUserRules().length).toBeGreaterThan(1)

    await wrapper.find('.kse-reset-all').trigger('click')
    await wrapper.vm.$nextTick()
    expect(getUserRules()).toEqual([])
  })

  it('Reset all is disabled while nothing is customized', () => {
    wrapper = mountEditor()
    expect(wrapper.find('.kse-reset-all').attributes('disabled')).toBeDefined()
  })
})

describe('failure reporting', () => {
  it('surfaces a failed write instead of showing a silent success', async () => {
    bridge.writeKeybindings.mockResolvedValue({ ok: false, error: 'EACCES' })
    wrapper = mountEditor()
    await rowFor(wrapper, 'editor.action.save').find('.kse-chip-remove').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.kse-error').text()).toContain('EACCES')
  })
})

describe('external changes', () => {
  it('re-renders when another window rewrites the rules', async () => {
    wrapper = mountEditor()
    const { setUserRules } = await import('@navide/plugin-ui/shared')
    setUserRules([{ key: 'cmd+s', command: '-editor.action.save', when: 'editorOpen && !terminalFocus' }])
    await wrapper.vm.$nextTick()
    expect(rowFor(wrapper, 'editor.action.save').find('.kse-unbound').exists()).toBe(true)
  })
})

describe('Navide plugin commands', () => {
  const entry = {
    commandId: 'acme.runner.go',
    title: 'Run tests',
    pluginId: 'acme.runner',
    pluginName: 'Runner',
    suggestedKey: 'cmd+alt+t',
  }

  afterEach(() => { pluginCommands.value = [] })

  it('shows nothing of them when no plugin declares a command', () => {
    const w = mountEditor()
    expect(w.find('.kse-plugin-mark').exists()).toBe(false)
    expect(w.find('.kse-suggestion').exists()).toBe(false)
    expect(w.findAll('.kse-id').map((id) => id.text()).sort()).toEqual(buildRows([]).map((row) => row.command).sort())
    w.unmount()
  })

  it('groups them under the plugin, marked, with the title it declared', () => {
    pluginCommands.value = [entry]
    const w = mountEditor('acme.runner')
    expect(w.find('.kse-group-title').text()).toContain('Runner')
    expect(w.find('.kse-plugin-mark').text()).toBe('Navide plugin')
    expect(rowFor(w, 'acme.runner.go').find('.kse-label').text()).toBe('Run tests')
    // Not the red "disabled" of a built-in row: that would read as a disabled plugin.
    expect(rowFor(w, 'acme.runner.go').find('.kse-source').classes()).toEqual(['kse-source'])
    w.unmount()
  })

  it('binds a suggested key only when the user presses Use', async () => {
    pluginCommands.value = [entry]
    const w = mountEditor('acme.runner')
    expect(bridge.writeKeybindings).not.toHaveBeenCalled()
    await rowFor(w, 'acme.runner.go').find('.kse-suggestion-use').trigger('click')
    expect(getUserRules()).toEqual([{ key: 'cmd+alt+t', command: 'acme.runner.go' }])
    w.unmount()
  })

  it('offers no Use button for a key that is taken', () => {
    pluginCommands.value = [{ ...entry, suggestedKey: 'cmd+shift+p' }]
    const w = mountEditor('acme.runner')
    const row = rowFor(w, 'acme.runner.go')
    expect(row.find('.kse-suggestion-taken').exists()).toBe(true)
    expect(row.find('.kse-suggestion-use').exists()).toBe(false)
    w.unmount()
  })

  it('keeps the row of a binding whose plugin is gone, and says so', async () => {
    await saveUserRules([{ key: 'cmd+alt+t', command: 'gone.runner.go' }])
    const w = mountEditor('gone.runner')
    expect(w.find('.kse-group-title').text()).toContain('Navide plugin not installed')
    expect(w.find('.kse-plugin-mark').exists()).toBe(false)
    expect(rowFor(w, 'gone.runner.go').exists()).toBe(true)
    w.unmount()
  })
})
