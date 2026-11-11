// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { KeyResolver } from '../keyResolver'
import type { KeybindingRule } from '../types'
import { defaults } from '../defaults'

function mkEvent(
  key: string,
  opts: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; code: string }> = {},
): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, ...opts })
}

const rules: KeybindingRule[] = [
  { key: 'cmd+s',       command: 'editor.save' },
  { key: 'cmd+shift+f', command: 'workbench.findInFiles' },
  { key: 'escape',      command: 'workbench.closeModal', when: 'modalOpen' },
  { key: 'ctrl+k ctrl+s', command: 'workbench.keybindingPage' },
]

let resolver: KeyResolver

beforeEach(() => {
  resolver = new KeyResolver(rules)
})

describe('KeyResolver – single key', () => {
  it('matches cmd+s', () => {
    const rule = resolver.resolve(mkEvent('s', { metaKey: true }), {})
    expect(rule?.command).toBe('editor.save')
  })

  it('matches cmd+shift+f', () => {
    const rule = resolver.resolve(mkEvent('F', { metaKey: true, shiftKey: true }), {})
    expect(rule?.command).toBe('workbench.findInFiles')
  })

  it('returns null when no rule matches', () => {
    expect(resolver.resolve(mkEvent('x'), {})).toBeNull()
  })

  it('skips rule when when-clause is false', () => {
    const ctx = { modalOpen: false }
    expect(resolver.resolve(mkEvent('Escape'), ctx)).toBeNull()
  })

  it('matches rule when when-clause is true', () => {
    const ctx = { modalOpen: true }
    const rule = resolver.resolve(mkEvent('Escape'), ctx)
    expect(rule?.command).toBe('workbench.closeModal')
  })

  it('ignores bare modifier key presses', () => {
    expect(resolver.resolve(mkEvent('Meta'), {})).toBeNull()
    expect(resolver.resolve(mkEvent('Control'), {})).toBeNull()
    expect(resolver.resolve(mkEvent('Shift'), {})).toBeNull()
  })

  it('resolves default cmd+/ from the physical slash key under an IME', () => {
    const defaultResolver = new KeyResolver(defaults)
    const rule = defaultResolver.resolve(
      mkEvent('Process', { metaKey: true, code: 'Slash' }),
      { editorTextFocus: true },
    )
    expect(rule?.command).toBe('editor.action.toggleComment')
  })

  it('resolves default cmd+shift+d → workbench.action.openPlans', () => {
    const defaultResolver = new KeyResolver(defaults)
    const rule = defaultResolver.resolve(mkEvent('D', { metaKey: true, shiftKey: true }), {})
    expect(rule?.command).toBe('workbench.action.openPlans')
  })

  // cmd+shift+L is shared three ways. Debug only claims it where no editor is
  // open, so the Mini IDE keeps both of its editor commands on that chord.
  describe('default cmd+shift+l is shared with the editor', () => {
    const shiftL = (): KeyboardEvent => mkEvent('L', { metaKey: true, shiftKey: true })

    it('opens Debug when no editor is open', () => {
      const rule = new KeyResolver(defaults).resolve(shiftL(), {
        editorOpen: false,
        editorTextFocus: false,
      })
      expect(rule?.command).toBe('workbench.action.openDebug')
    })

    it('still adds the selection to chat when an editor is open but unfocused', () => {
      const rule = new KeyResolver(defaults).resolve(shiftL(), {
        editorOpen: true,
        editorTextFocus: false,
      })
      expect(rule?.command).toBe('workbench.action.addSelectionToChat')
    })

    it('still selects highlights when the editor text area has focus', () => {
      const rule = new KeyResolver(defaults).resolve(shiftL(), {
        editorOpen: true,
        editorTextFocus: true,
      })
      expect(rule?.command).toBe('editor.action.selectHighlights')
    })
  })
})

describe('KeyResolver – chord', () => {
  it('returns null on first chord key (waiting)', () => {
    const first = resolver.resolve(mkEvent('k', { ctrlKey: true }), {})
    expect(first).toBeNull()
  })

  it('resolves chord on second key', () => {
    resolver.resolve(mkEvent('k', { ctrlKey: true }), {})
    const rule = resolver.resolve(mkEvent('s', { ctrlKey: true }), {})
    expect(rule?.command).toBe('workbench.keybindingPage')
  })

  it('chord state clears after resolution', () => {
    resolver.resolve(mkEvent('k', { ctrlKey: true }), {})
    resolver.resolve(mkEvent('s', { ctrlKey: true }), {})
    // Next single key should resolve normally
    const rule = resolver.resolve(mkEvent('s', { metaKey: true }), {})
    expect(rule?.command).toBe('editor.save')
  })

  it('chord with wrong second key returns null and clears state', () => {
    resolver.resolve(mkEvent('k', { ctrlKey: true }), {})
    const rule = resolver.resolve(mkEvent('z', { ctrlKey: true }), {})
    expect(rule).toBeNull()
    // State cleared: next key should work as single
    const next = resolver.resolve(mkEvent('s', { metaKey: true }), {})
    expect(next?.command).toBe('editor.save')
  })

  it('does not enter chord mode when all chord when-clauses fail', () => {
    // Resolver with ONLY a when-gated chord — no unconditional chord.
    const gated = new KeyResolver([
      { key: 'ctrl+k ctrl+c', command: 'editor.comment', when: 'editorFocus' },
      { key: 'ctrl+s', command: 'editor.save' },
    ])
    // ctx has editorFocus=false — chord should NOT be entered
    const first = gated.resolve(mkEvent('k', { ctrlKey: true }), { editorFocus: false })
    // Returns null because neither chord nor single matches
    expect(first).toBeNull()
    // Next ctrl+s should resolve as a normal single key (chord state was not set)
    const second = gated.resolve(mkEvent('s', { ctrlKey: true }), { editorFocus: false })
    expect(second?.command).toBe('editor.save')
  })
})

describe('KeyResolver – priority (later rule wins)', () => {
  it('later rule overrides earlier for same key', () => {
    const r = new KeyResolver([
      { key: 'cmd+s', command: 'old.command' },
      { key: 'cmd+s', command: 'new.command' },
    ])
    const rule = r.resolve(mkEvent('s', { metaKey: true }), {})
    expect(rule?.command).toBe('new.command')
  })
})

describe('KeyResolver – defaults integration (new shortcuts)', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('shift+alt+down → duplicateLineDown (editorTextFocus)', () => {
    const rule = dr.resolve(mkEvent('ArrowDown', { shiftKey: true, altKey: true }), { editorTextFocus: true })
    expect(rule?.command).toBe('editor.action.duplicateLineDown')
  })

  it('shift+alt+up → duplicateLineUp (editorTextFocus)', () => {
    const rule = dr.resolve(mkEvent('ArrowUp', { shiftKey: true, altKey: true }), { editorTextFocus: true })
    expect(rule?.command).toBe('editor.action.duplicateLineUp')
  })

  it('alt+down → moveLineDown, shift+alt+down → duplicateLineDown (no confusion)', () => {
    const ctx = { editorTextFocus: true }
    expect(dr.resolve(mkEvent('ArrowDown', { altKey: true }), ctx)?.command).toBe('editor.action.moveLineDown')
    expect(dr.resolve(mkEvent('ArrowDown', { shiftKey: true, altKey: true }), ctx)?.command).toBe('editor.action.duplicateLineDown')
  })

  it('cmd+shift+| → jumpToBracket (editorTextFocus)', () => {
    const rule = dr.resolve(mkEvent('|', { metaKey: true, shiftKey: true }), { editorTextFocus: true })
    expect(rule?.command).toBe('editor.action.jumpToBracket')
  })

  it('jumpToBracket requires editorTextFocus', () => {
    expect(dr.resolve(mkEvent('|', { metaKey: true, shiftKey: true }), {})).toBeNull()
  })

  it('duplicateLineDown/Up require editorTextFocus', () => {
    expect(dr.resolve(mkEvent('ArrowDown', { shiftKey: true, altKey: true }), {})).toBeNull()
    expect(dr.resolve(mkEvent('ArrowUp', { shiftKey: true, altKey: true }), {})).toBeNull()
  })

  it('cmd+] → indentLines (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent(']', { metaKey: true }), { editorTextFocus: true })?.command).toBe('editor.action.indentLines')
  })

  it('cmd+[ → outdentLines (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('[', { metaKey: true }), { editorTextFocus: true })?.command).toBe('editor.action.outdentLines')
  })

  it('cmd+up → cursorTop (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('ArrowUp', { metaKey: true }), { editorTextFocus: true })?.command).toBe('editor.action.cursorTop')
  })

  it('cmd+down → cursorBottom (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('ArrowDown', { metaKey: true }), { editorTextFocus: true })?.command).toBe('editor.action.cursorBottom')
  })

  it('indent/dedent/cursorTop/cursorBottom require editorTextFocus', () => {
    expect(dr.resolve(mkEvent(']', { metaKey: true }), {})).toBeNull()
    expect(dr.resolve(mkEvent('[', { metaKey: true }), {})).toBeNull()
    expect(dr.resolve(mkEvent('ArrowUp', { metaKey: true }), {})).toBeNull()
    expect(dr.resolve(mkEvent('ArrowDown', { metaKey: true }), {})).toBeNull()
  })

  it('cmd+d → addSelectionToNextFindMatch (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('d', { metaKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.addSelectionToNextFindMatch')
  })

  it('mod+p → quickOpen on the platform modifier (no when clause)', () => {
    // The only 'mod' rule in defaults, because the Plan window matched this
    // chord itself before it joined the table and Ctrl+P off macOS came with
    // it. 'mod' resolves at PARSE time, so each platform needs its own
    // resolver — reusing `dr` would test whatever platform it was built on.
    const original = navigator.platform
    const on = (platform: string): KeyResolver => {
      Object.defineProperty(navigator, 'platform', { value: platform, configurable: true })
      return new KeyResolver(defaults)
    }
    try {
      expect(on('MacIntel').resolve(mkEvent('p', { metaKey: true }), {})?.command)
        .toBe('workbench.action.quickOpen')
      expect(on('Win32').resolve(mkEvent('p', { ctrlKey: true }), {})?.command)
        .toBe('workbench.action.quickOpen')
      // macOS keeps Ctrl+P for the terminal, which is why this is not two rules.
      expect(on('MacIntel').resolve(mkEvent('p', { ctrlKey: true }), {})).toBeNull()
    } finally {
      Object.defineProperty(navigator, 'platform', { value: original, configurable: true })
    }
  })

  it('cmd+shift+t → reopenClosedEditor (no when clause)', () => {
    expect(dr.resolve(mkEvent('T', { metaKey: true, shiftKey: true }), {})?.command)
      .toBe('workbench.action.reopenClosedEditor')
  })

  it('cmd+shift+t → reopenClosedWindow in the main window only (paneStage)', () => {
    expect(dr.resolve(mkEvent('T', { metaKey: true, shiftKey: true }), { paneStage: true })?.command)
      .toBe('workbench.action.reopenClosedWindow')
    // The Mini IDE and the editor window never set paneStage: their closed tabs keep the key.
    expect(dr.resolve(mkEvent('T', { metaKey: true, shiftKey: true }), { editorOpen: true })?.command)
      .toBe('workbench.action.reopenClosedEditor')
  })

  it('f1 → showCommands', () => {
    expect(dr.resolve(mkEvent('F1'), {})?.command).toBe('workbench.action.showCommands')
  })

  it('cmd+shift+o → gotoSymbol (editorOpen)', () => {
    expect(dr.resolve(mkEvent('O', { metaKey: true, shiftKey: true }), { editorOpen: true })?.command)
      .toBe('workbench.action.gotoSymbol')
  })

  it('gotoSymbol requires editorOpen', () => {
    expect(dr.resolve(mkEvent('O', { metaKey: true, shiftKey: true }), {})).toBeNull()
  })

  it('cmd+k cmd+c → addLineComment chord (editorTextFocus)', () => {
    dr.resolve(mkEvent('k', { metaKey: true }), { editorTextFocus: true })
    expect(dr.resolve(mkEvent('c', { metaKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.addLineComment')
  })

  it('cmd+k cmd+u → removeLineComment chord (editorTextFocus)', () => {
    dr.resolve(mkEvent('k', { metaKey: true }), { editorTextFocus: true })
    expect(dr.resolve(mkEvent('u', { metaKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.removeLineComment')
  })

  it('addLineComment chord null without editorTextFocus when clause', () => {
    // cmd+k enters chord mode because cmd+k cmd+w has no when-clause (always eligible).
    dr.resolve(mkEvent('k', { metaKey: true }), {})
    // cmd+k cmd+c resolves to null because editorTextFocus is false
    expect(dr.resolve(mkEvent('c', { metaKey: true }), {})).toBeNull()
  })

  it('f3 → nextMatch (findOpen)', () => {
    expect(dr.resolve(mkEvent('F3'), { findOpen: true })?.command)
      .toBe('editor.action.nextMatch')
  })

  it('shift+f3 → prevMatch (findOpen)', () => {
    expect(dr.resolve(mkEvent('F3', { shiftKey: true }), { findOpen: true })?.command)
      .toBe('editor.action.prevMatch')
  })

  it('f3/shift+f3 require findOpen', () => {
    expect(dr.resolve(mkEvent('F3'), {})).toBeNull()
    expect(dr.resolve(mkEvent('F3', { shiftKey: true }), {})).toBeNull()
  })

  it('cmd+n → newFile (no when clause)', () => {
    expect(dr.resolve(mkEvent('n', { metaKey: true }), {})?.command)
      .toBe('workbench.action.newFile')
  })

  it('escape → closeModal (modalOpen)', () => {
    expect(dr.resolve(mkEvent('Escape'), { modalOpen: true })?.command)
      .toBe('workbench.action.closeModal')
  })

  it('escape does nothing without modalOpen', () => {
    expect(dr.resolve(mkEvent('Escape'), {})).toBeNull()
  })

  it('escape → closeModal in the Plan window, which has no modalOpen', () => {
    // Its ESC walks an overlay ladder and ends at closing the window, so the
    // rule is scoped to the window rather than to a modal being open.
    expect(dr.resolve(mkEvent('Escape'), { planWindow: true })?.command)
      .toBe('workbench.action.closeModal')
  })

  it('escape stays with the CLI dock while the Plan window terminal has focus', () => {
    expect(dr.resolve(mkEvent('Escape'), { planWindow: true, terminalFocus: true })).toBeNull()
  })

  it('ctrl+up → scrollLineUp (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('ArrowUp', { ctrlKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.scrollLineUp')
  })

  it('ctrl+down → scrollLineDown (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('ArrowDown', { ctrlKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.scrollLineDown')
  })

  it('ctrl+up/down require editorTextFocus', () => {
    expect(dr.resolve(mkEvent('ArrowUp', { ctrlKey: true }), {})).toBeNull()
    expect(dr.resolve(mkEvent('ArrowDown', { ctrlKey: true }), {})).toBeNull()
  })

  it('cmd+k cmd+m → changeLanguageMode chord (editorOpen)', () => {
    dr.resolve(mkEvent('k', { metaKey: true }), { editorOpen: true })
    expect(dr.resolve(mkEvent('m', { metaKey: true }), { editorOpen: true })?.command)
      .toBe('workbench.action.changeLanguageMode')
  })

  it('changeLanguageMode chord null without editorOpen when-clause', () => {
    // cmd+k enters chord because cmd+k cmd+w (closeAllEditors) has no when-clause
    dr.resolve(mkEvent('k', { metaKey: true }), {})
    expect(dr.resolve(mkEvent('m', { metaKey: true }), {})).toBeNull()
  })

  it('cmd+= → fontZoomIn (editorOpen)', () => {
    expect(dr.resolve(mkEvent('=', { metaKey: true }), { editorOpen: true })?.command)
      .toBe('editor.action.fontZoomIn')
  })

  it('cmd+- → fontZoomOut (editorOpen)', () => {
    expect(dr.resolve(mkEvent('-', { metaKey: true }), { editorOpen: true })?.command)
      .toBe('editor.action.fontZoomOut')
  })

  it('cmd+0 → fontZoomReset (editorOpen)', () => {
    expect(dr.resolve(mkEvent('0', { metaKey: true }), { editorOpen: true })?.command)
      .toBe('editor.action.fontZoomReset')
  })

  it('zoom shortcuts require editorOpen', () => {
    expect(dr.resolve(mkEvent('=', { metaKey: true }), {})).toBeNull()
    expect(dr.resolve(mkEvent('-', { metaKey: true }), {})).toBeNull()
    expect(dr.resolve(mkEvent('0', { metaKey: true }), {})).toBeNull()
  })

  it('cmd+k cmd+s → openKeyboardShortcuts chord (no when)', () => {
    dr.resolve(mkEvent('k', { metaKey: true }), {})
    expect(dr.resolve(mkEvent('s', { metaKey: true }), {})?.command)
      .toBe('workbench.action.openKeyboardShortcuts')
  })

  it('cmd+k cmd+t → selectTheme chord (no when)', () => {
    dr.resolve(mkEvent('k', { metaKey: true }), {})
    expect(dr.resolve(mkEvent('t', { metaKey: true }), {})?.command)
      .toBe('workbench.action.selectTheme')
  })

  it('cmd+w → closeActiveEditor (editorOpen && !modalOpen)', () => {
    expect(dr.resolve(mkEvent('w', { metaKey: true }), { editorOpen: true, modalOpen: false })?.command)
      .toBe('workbench.action.closeActiveEditor')
  })

  it('cmd+w → closeModal when modalOpen (instead of closing a tab)', () => {
    expect(dr.resolve(mkEvent('w', { metaKey: true }), { editorOpen: true, modalOpen: true })?.command)
      .toBe('workbench.action.closeModal')
  })

  it('cmd+w → closeActivePane in the main window (paneStage && !modalOpen)', () => {
    // Same key, one unit of whatever the window holds: a tab above, the focused
    // CLI pane here. The two guards are window identities and never both hold.
    expect(dr.resolve(mkEvent('w', { metaKey: true }), { paneStage: true, modalOpen: false })?.command)
      .toBe('workbench.action.closeActivePane')
  })

  it('cmd+w → closeModal in the main window while a modal is open', () => {
    expect(dr.resolve(mkEvent('w', { metaKey: true }), { paneStage: true, modalOpen: true })?.command)
      .toBe('workbench.action.closeModal')
  })

  it('cmd+w does nothing in a window that is neither', () => {
    expect(dr.resolve(mkEvent('w', { metaKey: true }), { editorOpen: false })).toBeNull()
  })

  it('cmd+r rebuilds one pane, cmd+shift+r reloads the window', () => {
    // The same two tiers as ⌘W / ⇧⌘W, and the reverse of what the app menu had:
    // it put reloading the whole renderer on the shorter chord.
    expect(dr.resolve(mkEvent('r', { metaKey: true }), {})?.command)
      .toBe('workbench.action.rebuildFocusedPane')
    expect(dr.resolve(mkEvent('r', { metaKey: true, shiftKey: true }), {})?.command)
      .toBe('workbench.action.reloadWindow')
  })

  it('cmd+shift+r stays git.refresh in the Git window', () => {
    expect(dr.resolve(mkEvent('r', { metaKey: true, shiftKey: true }), { gitWindow: true })?.command)
      .toBe('git.refresh')
  })

  it('cmd+shift+r reaches the PTY in the Git window, reloading nothing', () => {
    // git.refresh yields on terminalFocus. Without the !gitWindow guard on the
    // reload rule, the chord would fall through and reload the window out from
    // under the AI dock instead of reaching the CLI.
    expect(dr.resolve(mkEvent('r', { metaKey: true, shiftKey: true }), { gitWindow: true, terminalFocus: true }))
      .toBeNull()
  })

  it('cmd+shift+s → saveAll (editorOpen)', () => {
    expect(dr.resolve(mkEvent('S', { metaKey: true, shiftKey: true }), { editorOpen: true })?.command)
      .toBe('workbench.action.saveAll')
  })

  it('cmd+shift+s requires editorOpen', () => {
    expect(dr.resolve(mkEvent('S', { metaKey: true, shiftKey: true }), {})).toBeNull()
  })

  it('cmd+alt+f → openReplace (editorOpen)', () => {
    expect(dr.resolve(mkEvent('f', { metaKey: true, altKey: true }), { editorOpen: true })?.command)
      .toBe('editor.action.openReplace')
  })

  it('cmd+alt+f requires editorOpen', () => {
    expect(dr.resolve(mkEvent('f', { metaKey: true, altKey: true }), {})).toBeNull()
  })

  it('cmd+h is unbound — left to the OS (Hide application)', () => {
    expect(dr.resolve(mkEvent('h', { metaKey: true }), { editorOpen: true })).toBeNull()
  })

  it('shift+alt+f → formatDocument (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('f', { shiftKey: true, altKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.formatDocument')
  })

  it('shift+alt+f requires editorTextFocus', () => {
    expect(dr.resolve(mkEvent('f', { shiftKey: true, altKey: true }), {})).toBeNull()
  })

  it('cmd+k cmd+f → formatSelection chord (editorTextFocus)', () => {
    dr.resolve(mkEvent('k', { metaKey: true }), { editorTextFocus: true })
    expect(dr.resolve(mkEvent('f', { metaKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.formatSelection')
  })

  it('formatSelection chord null without editorTextFocus', () => {
    // cmd+k enters chord (cmd+k cmd+w has no when)
    dr.resolve(mkEvent('k', { metaKey: true }), {})
    expect(dr.resolve(mkEvent('f', { metaKey: true }), {})).toBeNull()
  })

  it('shift+alt+right → smartSelect.expand (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('ArrowRight', { shiftKey: true, altKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.smartSelect.expand')
  })

  it('shift+alt+left → smartSelect.shrink (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('ArrowLeft', { shiftKey: true, altKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.smartSelect.shrink')
  })

  it('smartSelect.expand/shrink require editorTextFocus', () => {
    expect(dr.resolve(mkEvent('ArrowRight', { shiftKey: true, altKey: true }), {})).toBeNull()
    expect(dr.resolve(mkEvent('ArrowLeft', { shiftKey: true, altKey: true }), {})).toBeNull()
  })

  it('cmd+k cmd+p → copyFilePath chord (editorOpen)', () => {
    dr.resolve(mkEvent('k', { metaKey: true }), { editorOpen: true })
    expect(dr.resolve(mkEvent('p', { metaKey: true }), { editorOpen: true })?.command)
      .toBe('workbench.action.copyFilePath')
  })

  it('cmd+k cmd+r → revealInExplorer chord (editorOpen)', () => {
    dr.resolve(mkEvent('k', { metaKey: true }), { editorOpen: true })
    expect(dr.resolve(mkEvent('r', { metaKey: true }), { editorOpen: true })?.command)
      .toBe('workbench.action.revealInExplorer')
  })

  it('copyFilePath chord null without editorOpen', () => {
    dr.resolve(mkEvent('k', { metaKey: true }), {})
    expect(dr.resolve(mkEvent('p', { metaKey: true }), {})).toBeNull()
  })

  it('cmd+1 → openEditorAtIndex1 (editorOpen)', () => {
    expect(dr.resolve(mkEvent('1', { metaKey: true }), { editorOpen: true })?.command)
      .toBe('workbench.action.openEditorAtIndex1')
  })

  it('cmd+9 → openEditorAtIndex9 (editorOpen)', () => {
    expect(dr.resolve(mkEvent('9', { metaKey: true }), { editorOpen: true })?.command)
      .toBe('workbench.action.openEditorAtIndex9')
  })

  it('cmd+1 requires editorOpen', () => {
    expect(dr.resolve(mkEvent('1', { metaKey: true }), {})).toBeNull()
  })

  it('cmd+backspace → deleteAllLeft (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('Backspace', { metaKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.deleteAllLeft')
  })

  it('cmd+delete → deleteAllRight (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('Delete', { metaKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.deleteAllRight')
  })

  it('cmd+backspace/delete require editorTextFocus', () => {
    expect(dr.resolve(mkEvent('Backspace', { metaKey: true }), {})).toBeNull()
    expect(dr.resolve(mkEvent('Delete', { metaKey: true }), {})).toBeNull()
  })

  it('cmd+shift+] → moveEditorRightInGroup (editorOpen)', () => {
    expect(dr.resolve(mkEvent(']', { metaKey: true, shiftKey: true }), { editorOpen: true })?.command)
      .toBe('workbench.action.moveEditorRightInGroup')
  })

  it('cmd+shift+[ → moveEditorLeftInGroup (editorOpen)', () => {
    expect(dr.resolve(mkEvent('[', { metaKey: true, shiftKey: true }), { editorOpen: true })?.command)
      .toBe('workbench.action.moveEditorLeftInGroup')
  })

  it('moveEditor left/right require editorOpen', () => {
    expect(dr.resolve(mkEvent(']', { metaKey: true, shiftKey: true }), {})).toBeNull()
    expect(dr.resolve(mkEvent('[', { metaKey: true, shiftKey: true }), {})).toBeNull()
  })
})

describe('reveal file in OS shortcut', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('shift+alt+r → revealFileInOS (editorOpen)', () => {
    expect(dr.resolve(mkEvent('r', { shiftKey: true, altKey: true }), { editorOpen: true })?.command)
      .toBe('workbench.action.revealFileInOS')
  })

  it('revealFileInOS requires editorOpen', () => {
    expect(dr.resolve(mkEvent('r', { shiftKey: true, altKey: true }), {})).toBeNull()
  })
})

describe('new window shortcut', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('cmd+shift+n → newWindow', () => {
    expect(dr.resolve(mkEvent('n', { metaKey: true, shiftKey: true }), {})?.command)
      .toBe('workbench.action.newWindow')
  })

  it('cmd+k cmd+o → openFolder', () => {
    dr.resolve(mkEvent('k', { metaKey: true }), {})
    expect(dr.resolve(mkEvent('o', { metaKey: true }), {})?.command)
      .toBe('workbench.action.openFolder')
  })
})

describe('block comment shortcut', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('cmd+alt+/ → blockComment (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('/', { metaKey: true, altKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.blockComment')
  })

  it('blockComment requires editorTextFocus', () => {
    expect(dr.resolve(mkEvent('/', { metaKey: true, altKey: true }), {})).toBeNull()
  })
})

describe('select all occurrences aliases', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('cmd+f2 → selectHighlights (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('F2', { metaKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.selectHighlights')
  })

  it('ctrl+space → triggerGhost (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent(' ', { ctrlKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.triggerGhost')
  })
})

describe('zen mode shortcut', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('cmd+k cmd+z → toggleZenMode', () => {
    dr.resolve(mkEvent('k', { metaKey: true }), {})
    expect(dr.resolve(mkEvent('z', { metaKey: true }), {})?.command)
      .toBe('workbench.action.toggleZenMode')
  })
})

describe('navigation history shortcuts', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('ctrl+- → navigateBack (editorOpen)', () => {
    expect(dr.resolve(mkEvent('-', { ctrlKey: true }), { editorOpen: true })?.command)
      .toBe('workbench.action.navigateBack')
  })

  it('ctrl+shift+- → navigateForward (editorOpen)', () => {
    expect(dr.resolve(mkEvent('-', { ctrlKey: true, shiftKey: true }), { editorOpen: true })?.command)
      .toBe('workbench.action.navigateForward')
  })

  it('navigateBack/Forward require editorOpen', () => {
    expect(dr.resolve(mkEvent('-', { ctrlKey: true }), {})).toBeNull()
    expect(dr.resolve(mkEvent('-', { ctrlKey: true, shiftKey: true }), {})).toBeNull()
  })
})

describe('delete word shortcuts', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('alt+backspace → deleteWordLeft (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('Backspace', { altKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.deleteWordLeft')
  })

  it('alt+delete → deleteWordRight (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('Delete', { altKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.deleteWordRight')
  })

  it('deleteWord shortcuts require editorTextFocus', () => {
    expect(dr.resolve(mkEvent('Backspace', { altKey: true }), {})).toBeNull()
    expect(dr.resolve(mkEvent('Delete', { altKey: true }), {})).toBeNull()
  })
})

describe('find in files replace shortcut', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('cmd+shift+h → findInFilesReplace', () => {
    expect(dr.resolve(mkEvent('h', { metaKey: true, shiftKey: true }), {})?.command)
      .toBe('workbench.action.findInFilesReplace')
  })
})

describe('transpose shortcut', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('ctrl+t → transpose (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('t', { ctrlKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.transpose')
  })

  it('ctrl+t requires editorTextFocus', () => {
    expect(dr.resolve(mkEvent('t', { ctrlKey: true }), {})).toBeNull()
  })
})

describe('select line shortcut', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('ctrl+l → selectLine (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('l', { ctrlKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.selectLine')
  })

  it('ctrl+l requires editorTextFocus', () => {
    expect(dr.resolve(mkEvent('l', { ctrlKey: true }), {})).toBeNull()
  })
})

describe('open file shortcut', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('cmd+o → openFile', () => {
    expect(dr.resolve(mkEvent('o', { metaKey: true }), {})?.command)
      .toBe('workbench.action.openFile')
  })
})

describe('block comment alias shortcut', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('shift+alt+a → blockComment (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('a', { shiftKey: true, altKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.blockComment')
  })

  it('shift+alt+a requires editorTextFocus', () => {
    expect(dr.resolve(mkEvent('a', { shiftKey: true, altKey: true }), {})).toBeNull()
  })
})

describe('join lines shortcut', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('ctrl+j → joinLines (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('j', { ctrlKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.joinLines')
  })

  it('ctrl+j requires editorTextFocus', () => {
    expect(dr.resolve(mkEvent('j', { ctrlKey: true }), {})).toBeNull()
  })
})

describe('navigate to last edit and move selection shortcuts', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('cmd+k cmd+q → navigateToLastEditLocation (editorOpen)', () => {
    dr.resolve(mkEvent('k', { metaKey: true }), { editorOpen: true }) // enter chord
    expect(dr.resolve(mkEvent('q', { metaKey: true }), { editorOpen: true })?.command)
      .toBe('editor.action.navigateToLastEditLocation')
  })

  it('cmd+k cmd+d → moveSelectionToNextFindMatch (editorTextFocus)', () => {
    dr.resolve(mkEvent('k', { metaKey: true }), { editorTextFocus: true }) // enter chord
    expect(dr.resolve(mkEvent('d', { metaKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.moveSelectionToNextFindMatch')
  })
})

describe('copy relative path shortcut', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('cmd+shift+alt+c → copyRelativeFilePath (editorOpen)', () => {
    expect(dr.resolve(mkEvent('c', { metaKey: true, shiftKey: true, altKey: true }), { editorOpen: true })?.command)
      .toBe('workbench.action.copyRelativeFilePath')
  })

  it('cmd+shift+alt+c requires editorOpen', () => {
    expect(dr.resolve(mkEvent('c', { metaKey: true, shiftKey: true, altKey: true }), {})).toBeNull()
  })
})

describe('inlineRewrite shortcut (chord fix)', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('cmd+k cmd+k → inlineRewrite (editorTextFocus)', () => {
    dr.resolve(mkEvent('k', { metaKey: true }), { editorTextFocus: true }) // enter chord
    expect(dr.resolve(mkEvent('k', { metaKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.inlineRewrite')
  })

  it('ctrl+shift+i → inlineRewrite (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('i', { ctrlKey: true, shiftKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.inlineRewrite')
  })

  it('ctrl+shift+i requires editorTextFocus', () => {
    expect(dr.resolve(mkEvent('i', { ctrlKey: true, shiftKey: true }), {})).toBeNull()
  })
})

describe('focusActiveEditorGroup shortcut', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('cmd+k cmd+e → focusActiveEditorGroup (editorOpen)', () => {
    dr.resolve(mkEvent('k', { metaKey: true }), { editorOpen: true }) // enter chord
    expect(dr.resolve(mkEvent('e', { metaKey: true }), { editorOpen: true })?.command)
      .toBe('workbench.action.focusActiveEditorGroup')
  })

  it('cmd+k cmd+e requires editorOpen', () => {
    dr.resolve(mkEvent('k', { metaKey: true }), {}) // enter chord attempt
    expect(dr.resolve(mkEvent('e', { metaKey: true }), {})).toBeNull()
  })
})

describe('openFileAtCursor shortcut (F12)', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('F12 → openFileAtCursor (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('F12'), { editorTextFocus: true })?.command)
      .toBe('editor.action.openFileAtCursor')
  })

  it('F12 requires editorTextFocus', () => {
    expect(dr.resolve(mkEvent('F12'), {})).toBeNull()
  })
})

describe('toggleAIChat shortcut (Ctrl+`)', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('ctrl+` → toggleAIChat', () => {
    expect(dr.resolve(mkEvent('`', { ctrlKey: true }), {})?.command)
      .toBe('workbench.action.toggleAIChat')
  })

  it('backtick without ctrl does not trigger toggleAIChat', () => {
    expect(dr.resolve(mkEvent('`'), {})?.command).not.toBe('workbench.action.toggleAIChat')
  })
})

describe('toggleLineNumbers shortcut (cmd+k cmd+l)', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('cmd+k cmd+l → toggleLineNumbers (editorOpen)', () => {
    dr.resolve(mkEvent('k', { metaKey: true }), { editorOpen: true })
    expect(dr.resolve(mkEvent('l', { metaKey: true }), { editorOpen: true })?.command)
      .toBe('editor.action.toggleLineNumbers')
  })

  it('cmd+k cmd+l requires editorOpen', () => {
    dr.resolve(mkEvent('k', { metaKey: true }), {})
    expect(dr.resolve(mkEvent('l', { metaKey: true }), {})).toBeNull()
  })
})

describe('word cursor movement (alt+left/right)', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('alt+left → cursorWordLeft (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('ArrowLeft', { altKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.cursorWordLeft')
  })

  it('alt+right → cursorWordRight (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('ArrowRight', { altKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.cursorWordRight')
  })

  it('alt+left requires editorTextFocus', () => {
    expect(dr.resolve(mkEvent('ArrowLeft', { altKey: true }), {})).toBeNull()
  })

  it('alt+right requires editorTextFocus', () => {
    expect(dr.resolve(mkEvent('ArrowRight', { altKey: true }), {})).toBeNull()
  })
})

describe('select to file start/end (cmd+shift+up/down)', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('cmd+shift+up → cursorTopSelect (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('ArrowUp', { metaKey: true, shiftKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.cursorTopSelect')
  })

  it('cmd+shift+down → cursorBottomSelect (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('ArrowDown', { metaKey: true, shiftKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.cursorBottomSelect')
  })

  it('cmd+shift+up requires editorTextFocus', () => {
    expect(dr.resolve(mkEvent('ArrowUp', { metaKey: true, shiftKey: true }), {})).toBeNull()
  })
})

describe('find references (shift+f12)', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('shift+f12 → findReferences (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('F12', { shiftKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.findReferences')
  })

  it('shift+f12 requires editorTextFocus', () => {
    expect(dr.resolve(mkEvent('F12', { shiftKey: true }), {})).toBeNull()
  })
})

describe('rename symbol (F2)', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('f2 → renameSymbol (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('F2'), { editorTextFocus: true })?.command)
      .toBe('editor.action.renameSymbol')
  })

  it('f2 requires editorTextFocus', () => {
    expect(dr.resolve(mkEvent('F2'), {})).toBeNull()
  })
})

describe('word selection with ctrl+shift', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('ctrl+shift+left → cursorWordLeftSelect (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('ArrowLeft', { ctrlKey: true, shiftKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.cursorWordLeftSelect')
  })

  it('ctrl+shift+right → cursorWordRightSelect (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('ArrowRight', { ctrlKey: true, shiftKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.cursorWordRightSelect')
  })

  it('ctrl+shift+left/right require editorTextFocus', () => {
    expect(dr.resolve(mkEvent('ArrowLeft', { ctrlKey: true, shiftKey: true }), {})).toBeNull()
    expect(dr.resolve(mkEvent('ArrowRight', { ctrlKey: true, shiftKey: true }), {})).toBeNull()
  })
})

describe('open link at cursor (cmd+alt+enter)', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('cmd+alt+enter → openLink (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('Enter', { metaKey: true, altKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.openLink')
  })

  it('cmd+alt+enter requires editorTextFocus', () => {
    expect(dr.resolve(mkEvent('Enter', { metaKey: true, altKey: true }), {})).toBeNull()
  })
})

describe('cursor line navigation (Home/End/ctrl+Home/End)', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('shift+home → cursorLineStartSelect', () => {
    expect(dr.resolve(mkEvent('Home', { shiftKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.cursorLineStartSelect')
  })

  it('shift+end → cursorLineEndSelect', () => {
    expect(dr.resolve(mkEvent('End', { shiftKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.cursorLineEndSelect')
  })

  it('ctrl+home → cursorTop', () => {
    expect(dr.resolve(mkEvent('Home', { ctrlKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.cursorTop')
  })

  it('ctrl+end → cursorBottom', () => {
    expect(dr.resolve(mkEvent('End', { ctrlKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.cursorBottom')
  })

  it('ctrl+shift+home → cursorTopSelect', () => {
    expect(dr.resolve(mkEvent('Home', { ctrlKey: true, shiftKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.cursorTopSelect')
  })

  it('ctrl+shift+end → cursorBottomSelect', () => {
    expect(dr.resolve(mkEvent('End', { ctrlKey: true, shiftKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.cursorBottomSelect')
  })
})

describe('cmd+j toggles AI chat panel', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('cmd+j → toggleAIChat (no when)', () => {
    expect(dr.resolve(mkEvent('j', { metaKey: true }), {})?.command)
      .toBe('workbench.action.toggleAIChat')
  })
})
