// The read-only "Application menu" reference in Settings → Keyboard Shortcuts.
//
// It used to be one table of macOS glyphs shown on every platform, so Windows
// users read ⌘C / V / X / Z / A for keys their menu binds to Ctrl (issue #190).
import { describe, it, expect } from 'vitest'
import { nativeMenuKeys, MENU_OMITTED_ROLES, MENU_ROLE_ACCELERATORS } from '../externalKeys'

describe('nativeMenuKeys', () => {
  it('keeps the macOS table exactly as it was', () => {
    expect(nativeMenuKeys(true)).toEqual([
      { keys: '⌘ ,', desc: 'menuSettings' },
      { keys: '⌘ N', desc: 'menuNewWindow' },
      { keys: '⌘ O', desc: 'menuOpenWorkspace' },
      { keys: '⌘ R', desc: 'reload' },
      { keys: '⌥ ⌘ I', desc: 'devTools' },
      { keys: '⌃ ⌘ F', desc: 'fullScreen' },
      { keys: '⌘ C / V / X / Z / A', desc: 'clipboard' },
      { keys: '⌘ Q / ⌘ M', desc: 'windowControls' },
      { keys: '⌘ H / ⌥ ⌘ H', desc: 'hide' },
    ])
  })

  it('shows the Ctrl accelerators the menu really carries on Windows and Linux', () => {
    expect(nativeMenuKeys(false)).toEqual([
      { keys: 'Ctrl ,', desc: 'menuSettings' },
      { keys: 'Ctrl N', desc: 'menuNewWindow' },
      { keys: 'Ctrl O', desc: 'menuOpenWorkspace' },
      { keys: 'Ctrl Shift I', desc: 'devTools' },
      { keys: 'F11', desc: 'fullScreen' },
      { keys: 'Ctrl C / Ctrl V / Ctrl X / Ctrl Z / Ctrl A', desc: 'clipboard' },
      { keys: 'Ctrl Q / Ctrl M', desc: 'windowControls' },
    ])
  })

  it('lists nothing off macOS that the menu does not have there', () => {
    const rows = nativeMenuKeys(false)
    expect(rows.some((row) => row.keys.includes('⌘'))).toBe(false)
    // Hide / Hide Others are macOS-only roles.
    expect(MENU_ROLE_ACCELERATORS.hide.other).toBeNull()
    expect(rows.some((row) => row.desc === 'hide')).toBe(false)
    // Reload is left out of the menu so the renderer keeps its key.
    expect(MENU_OMITTED_ROLES.reload).toBeDefined()
    expect(rows.some((row) => row.desc === 'reload')).toBe(false)
  })
})
