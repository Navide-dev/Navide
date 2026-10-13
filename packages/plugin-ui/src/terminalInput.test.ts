// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { createTerminalInputHandlers } from './terminalInput'

// Issue #190: on Windows, Ctrl+V reached xterm, which encoded it as ^V and
// cancelled the event, so the browser never fired the paste event that the
// terminal's paste handler (text and screenshots) listens for.

function fakeTerminal(): Terminal {
  return {
    buffer: { active: { type: 'normal', cursorX: 0, cursorY: 0, baseY: 0, getLine: () => undefined } },
    modes: { mouseTrackingMode: 'none' },
    cols: 80,
    rows: 24,
    select: vi.fn(),
    clearSelection: vi.fn(),
    getSelection: () => '',
    scrollLines: vi.fn(),
  } as unknown as Terminal
}

function handlers(send = vi.fn()) {
  return createTerminalInputHandlers({
    terminal: fakeTerminal(),
    isAgentPane: () => true,
    send,
    encodeNewline: () => '\n',
    finalizeStaleComposition: vi.fn(),
    reportEmptyCopy: vi.fn(),
    copy: vi.fn(),
  })
}

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { cancelable: true, ...init })
}

function onPlatform(platform: string): void {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('terminal key handler – paste chords (issue #190)', () => {
  it('hands Ctrl+V on Windows to the browser paste event instead of xterm', () => {
    onPlatform('Win32')
    const send = vi.fn()
    const e = keydown({ key: 'v', code: 'KeyV', ctrlKey: true })

    expect(handlers(send).keyHandler(e)).toBe(false)
    // The default must survive, or the browser never fires `paste`.
    expect(e.defaultPrevented).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('hands Ctrl+Shift+V to the browser paste event on Windows and Linux', () => {
    for (const platform of ['Win32', 'Linux x86_64']) {
      onPlatform(platform)
      const e = keydown({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true })
      expect(handlers().keyHandler(e)).toBe(false)
      expect(e.defaultPrevented).toBe(false)
    }
  })

  it('leaves plain Ctrl+V on Linux to xterm, which sends ^V', () => {
    onPlatform('Linux x86_64')
    const e = keydown({ key: 'v', code: 'KeyV', ctrlKey: true })

    expect(handlers().keyHandler(e)).toBe(true)
  })

  it('changes nothing on macOS: Cmd+V, Ctrl+V and Ctrl+Shift+V all go to xterm as before', () => {
    onPlatform('MacIntel')
    const cmdV = keydown({ key: 'v', code: 'KeyV', metaKey: true })
    const ctrlV = keydown({ key: 'v', code: 'KeyV', ctrlKey: true })
    const ctrlShiftV = keydown({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true })
    const h = handlers()

    expect(h.keyHandler(cmdV)).toBe(true)
    expect(cmdV.defaultPrevented).toBe(false)
    expect(h.keyHandler(ctrlV)).toBe(true)
    expect(h.keyHandler(ctrlShiftV)).toBe(true)
  })
})
