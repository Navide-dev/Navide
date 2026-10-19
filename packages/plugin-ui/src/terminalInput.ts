import type { Terminal } from '@xterm/xterm'
import { isMacPlatform } from './shared/keybindings/parseKey'

export interface TerminalAgentProfile {
  bracketedPaste?: boolean
  fullScreenTui?: boolean
  shiftEnterSequence?: string
}

export type TerminalAgentProfileResolver = (agentKey?: string) => TerminalAgentProfile | undefined

/** Encode modified Enter as the active CLI protocol permits. */
export function encodeShiftEnter(profile?: TerminalAgentProfile): string {
  if (profile?.shiftEnterSequence) return profile.shiftEnterSequence
  if (profile?.bracketedPaste) return '\x1b[200~\n\x1b[201~'
  return '\x16\x0a'
}

/**
 * Ctrl+V pastes on Windows, as it does in Windows Terminal; Ctrl+Shift+V
 * pastes on Windows and Linux. Plain Ctrl+V on Linux stays ^V — Claude Code
 * reads the clipboard on it there. macOS pastes with Cmd+V and is untouched.
 */
function isPasteChord(e: KeyboardEvent): boolean {
  if (!e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 'v') return false
  if (isMacPlatform()) return false
  return e.shiftKey || /^win/i.test(navigator.platform || '')
}

export interface TerminalInputHandlersOptions {
  terminal: Terminal
  /** Whether Ctrl+Enter belongs to an agent prompt rather than a plain shell. */
  isAgentPane: () => boolean
  /** Write a key-generated protocol frame to the Host-owned terminal transport. */
  send: (text: string) => void
  /** Encode Shift/Ctrl/Cmd+Enter for the active terminal protocol. */
  encodeNewline: () => string
  /** Release a stale xterm composition before its next key is handled. */
  finalizeStaleComposition: () => void
  /** Report Cmd+C when the terminal has no selectable text. */
  reportEmptyCopy: () => void
  /** Copy xterm's current selection; firstPress preserves held-key diagnostics. */
  copy: (text: string, firstPress?: boolean) => void
  /** Notify the Host that a wheel event was forwarded to a mouse-tracking TUI. */
  onScroll?: () => void
}

export interface TerminalInputHandlers {
  keyHandler: (event: KeyboardEvent) => boolean
  wheelHandler: (event: WheelEvent) => boolean
  resetSelection: () => void
}

/** Shared xterm key and wheel behavior for public terminal surfaces. */
export function createTerminalInputHandlers(
  options: TerminalInputHandlersOptions,
): TerminalInputHandlers {
  const term = options.terminal
  let selAnchorX = -1
  let selAnchorY = -1
  let scrollRemainder = 0

  function resetSelection(): void {
    selAnchorX = -1
    selAnchorY = -1
  }

  function wheelHandler(e: WheelEvent): boolean {
    // Alternate buffer = TUI app (Claude Code, Codex, etc.) is active.
    // Only forward wheel events to the PTY when the app actually enabled
    // mouse tracking (vim, htop, ...). Without mouse tracking, xterm's
    // alternateScroll fallback converts each wheel notch into an ↑/↓ arrow
    // escape sequence, which agent CLIs interpret as readline history
    // recall — scrolling up would pull the previous submitted prompt into
    // the input line. Swallow the event instead (scrollLines is a no-op in
    // alt buffer, so there is nothing else useful to do with it).
    if (term.buffer.active.type === 'alternate') {
      const forward = term.modes.mouseTrackingMode !== 'none'
      if (forward) options.onScroll?.()
      return forward
    }
    // Main buffer: accumulate pixel-delta for smooth trackpad scrollback.
    // deltaY units depend on deltaMode: LINE → lines, PAGE → pages, PIXEL →
    // pixels. PAGE mode (some mice / accessibility settings) reports ~1 per
    // notch; without this branch it fell through to the pixel /3 path and
    // scrolled ~0.3 line per notch (effectively stuck).
    let delta: number
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) delta = e.deltaY
    else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta = e.deltaY * term.rows
    else delta = e.deltaY / 3
    scrollRemainder += delta
    const lines = Math.trunc(scrollRemainder)
    scrollRemainder -= lines
    if (lines !== 0) term.scrollLines(lines)
    return false
  }

  function keyHandler(e: KeyboardEvent): boolean {
    if (e.type !== 'keydown') return true
    // A keyCode 229 that the browser does not consider part of a composition,
    // while xterm still believes one is running, is only reachable once the
    // helper has gone stale: a genuine first IME keystroke arrives before
    // compositionstart (xterm still false), and a genuine in-flight one
    // reports composing on both sides. Unlatch before xterm swallows this key.
    if (e.keyCode === 229 && !e.isComposing) options.finalizeStaleComposition()
    // A bare Cmd mid-composition is the start of Cmd+Space (input-source
    // switch). xterm's CompositionHelper only lets Shift/Ctrl/Alt pass while
    // composing, so Cmd made it send the pending reading at once — and the
    // compositionend macOS fires for the switch then sent it a second time.
    // Keep it from xterm; a lone Cmd produces no input of its own.
    if (e.isComposing && e.key === 'Meta') return false
    // IME guard: allow the browser to process composition (e.g. Zhuyin/Pinyin)
    if (e.isComposing) return true

    const buf = term.buffer.active
    const curX = buf.cursorX
    const curY = buf.baseY + buf.cursorY

    // ── Shift/Ctrl/Cmd+Enter: newline without submitting ──────────────────
    // Traditional PTYs do not preserve modifiers on Enter, so encode the
    // chord for the active agent's input protocol.
    const newlineChord =
      (e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey) ||
      (options.isAgentPane() && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) ||
      (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey)
    if (newlineChord && e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      options.send(options.encodeNewline())
      return false
    }

    // ── Paste chord: let the browser fire `paste` ─────────────────────────
    // xterm would encode the chord as ^V and cancel the event, so the
    // terminal's paste handler (text and screenshots) never ran. No
    // preventDefault here: the browser default is what produces the paste.
    if (isPasteChord(e)) return false

    // Every branch below that sends bytes itself and returns false MUST also
    // call e.preventDefault(): returning false only stops xterm's handling,
    // not the browser default. Without it the hidden helper-textarea caret
    // moves away from the end of its value, and xterm's CompositionHelper
    // (which anchors compositions at value.length) then commits stale text
    // on the next IME input.

    // ── Shift+←/→: extend selection character by character ────────────────
    if (e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey &&
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault()
      if (selAnchorX < 0) { selAnchorX = curX; selAnchorY = curY }
      const newX = e.key === 'ArrowLeft' ? Math.max(0, curX - 1) : Math.min(term.cols - 1, curX + 1)
      const len = Math.abs(selAnchorX - newX)
      if (len > 0) term.select(Math.min(selAnchorX, newX), selAnchorY, len)
      else term.clearSelection()
      options.send(e.key === 'ArrowLeft' ? '\x1b[D' : '\x1b[C')
      return false
    }

    // ── Cmd+Shift+←: select to beginning of line ──────────────────────────
    if (e.metaKey && e.shiftKey && e.key === 'ArrowLeft') {
      e.preventDefault()
      if (selAnchorX < 0) { selAnchorX = curX; selAnchorY = curY }
      if (curX > 0) term.select(0, curY, curX)
      else term.clearSelection()
      options.send('\x01')
      return false
    }

    // ── Cmd+Shift+→: select to end of line ────────────────────────────────
    if (e.metaKey && e.shiftKey && e.key === 'ArrowRight') {
      e.preventDefault()
      if (selAnchorX < 0) { selAnchorX = curX; selAnchorY = curY }
      const line = buf.getLine(curY)
      const lineEnd = line ? line.translateToString(true).length : term.cols
      const endX = Math.max(lineEnd, curX)
      if (endX > curX) term.select(curX, curY, endX - curX)
      else term.clearSelection()
      options.send('\x05')
      return false
    }

    // ── Delete/Backspace with active selection: delete the selected region ───
    if (selAnchorX >= 0 && (e.key === 'Backspace' || e.key === 'Delete') &&
        !e.metaKey && !e.altKey) {
      e.preventDefault()
      const count = Math.abs(curX - selAnchorX)
      if (count > 0) {
        // cursor right of anchor → backspace; cursor left → forward-delete
        options.send(curX > selAnchorX ? '\x7f'.repeat(count) : '\x1b[3~'.repeat(count))
      }
      resetSelection()
      term.clearSelection()
      return false
    }

    // ── Clear selection for all other keys (except copy/select-all/etc) ────
    const keepForCmd = e.metaKey && 'cavz'.includes(e.key.toLowerCase())
    const isModifierOnly = ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)
    if (!keepForCmd && !isModifierOnly) {
      resetSelection()
      term.clearSelection()
    }

    // ── Cmd+C: copy the terminal's selection ──────────────────────────────
    if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === 'c') {
      const selection = term.getSelection()
      if (selection) {
        e.preventDefault()
        options.copy(selection, !e.repeat)
        return false
      }
      options.reportEmptyCopy()
    }

    // ── macOS cursor shortcuts (no Shift) ──────────────────────────────────
    if (e.metaKey && !e.shiftKey && e.key === 'Backspace')  { e.preventDefault(); options.send('\x15'); return false }
    if (e.metaKey && !e.shiftKey && e.key === 'ArrowLeft')  { e.preventDefault(); options.send('\x01'); return false }
    if (e.metaKey && !e.shiftKey && e.key === 'ArrowRight') { e.preventDefault(); options.send('\x05'); return false }
    if (e.altKey  && !e.shiftKey && e.key === 'Backspace')  { e.preventDefault(); options.send('\x17'); return false }

    // App reserves Ctrl+1..9 for CLI quick-select (see keybindings/defaults).
    // The central dispatcher normally consumes them, but if it misses (e.g. an
    // IME reports a non-digit `e.key`) they must never leak into the PTY. Match
    // on the physical key so the guard holds regardless of layout/IME.
    if (e.ctrlKey && !e.metaKey && !e.altKey && /^(Digit|Numpad)[1-9]$/.test(e.code)) {
      e.preventDefault()
      return false
    }
    return true
  }

  return { keyHandler, wheelHandler, resetSelection }
}
