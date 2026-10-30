// Keyboard event to bytes. Spec: xterm ctlseqs, "PC-Style Function Keys"
// (cursor keys CSI/SS3 by DECCKM, modifier parameter 1 + shift 1 + alt 2 +
// ctrl 4 + meta 8, function and editing keys as CSI n ~), ECMA-48 C0 codes
// for Ctrl combinations, DEC VT100 keypad application mode (DECKPAM).

export interface KeyInput {
  key: string
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

export interface KeyOptions {
  applicationCursorKeys: boolean
  applicationKeypad: boolean
  /** macOS: Option composes characters unless macOptionIsMeta. */
  isMac: boolean
  macOptionIsMeta: boolean
}

const ESC = '\x1b'
const CSI = `${ESC}[`
const SS3 = `${ESC}O`

const CURSOR: Record<string, string> = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' }
const TILDE: Record<string, number> = {
  Insert: 2, Delete: 3, PageUp: 5, PageDown: 6,
  F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24,
}
const SS3_FUNCTION: Record<string, string> = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' }
/** DECKPAM: keypad keys send SS3 + these finals. */
const KEYPAD: Record<string, string> = {
  Numpad0: 'p', Numpad1: 'q', Numpad2: 'r', Numpad3: 's', Numpad4: 't', Numpad5: 'u', Numpad6: 'v', Numpad7: 'w',
  Numpad8: 'x', Numpad9: 'y', NumpadDecimal: 'n', NumpadSubtract: 'm', NumpadAdd: 'k', NumpadMultiply: 'j',
  NumpadDivide: 'o', NumpadEnter: 'M',
}

function modifierParam(e: KeyInput, altAsMeta: boolean): number {
  return 1 + (e.shiftKey ? 1 : 0) + (e.altKey && altAsMeta ? 2 : 0) + (e.ctrlKey ? 4 : 0)
}

/** Ctrl + a printable key as a C0 control, or undefined. */
function ctrlCode(key: string): string | undefined {
  if (key.length !== 1) return undefined
  const c = key.toUpperCase().charCodeAt(0)
  if (c >= 0x40 && c <= 0x5f) return String.fromCharCode(c - 0x40) // @ A-Z [ \ ] ^ _
  switch (key) {
    case ' ': case '2': return '\x00'
    case '3': return '\x1b'
    case '4': return '\x1c'
    case '5': return '\x1d'
    case '6': return '\x1e'
    case '7': case '/': return '\x1f'
    case '8': return '\x7f'
  }
  return undefined
}

/**
 * Bytes for a key press, or undefined when the key should arrive as text
 * through the input element (plain characters, IME, dead keys) or belongs to
 * the host (Cmd shortcuts on macOS).
 */
export function encodeKey(e: KeyInput, opts: KeyOptions): string | undefined {
  if (e.metaKey) return undefined
  const altAsMeta = e.altKey && (!opts.isMac || opts.macOptionIsMeta)
  const mod = modifierParam(e, altAsMeta)
  const modified = mod > 1

  const cursor = CURSOR[e.key]
  if (cursor) {
    if (modified) return `${CSI}1;${mod}${cursor}`
    return (opts.applicationCursorKeys ? SS3 : CSI) + cursor
  }
  const tilde = TILDE[e.key]
  if (tilde !== undefined) return modified ? `${CSI}${tilde};${mod}~` : `${CSI}${tilde}~`
  const fn = SS3_FUNCTION[e.key]
  if (fn) return modified ? `${CSI}1;${mod}${fn}` : SS3 + fn

  if (opts.applicationKeypad && !modified) {
    const kp = KEYPAD[e.code]
    if (kp) return SS3 + kp
  }

  const prefix = altAsMeta ? ESC : ''
  switch (e.key) {
    case 'Enter': return `${prefix}\r`
    case 'Escape': return `${prefix}${ESC}`
    case 'Tab': return e.shiftKey ? `${CSI}Z` : `${prefix}\t`
    case 'Backspace': return prefix + (e.ctrlKey ? '\x08' : '\x7f')
  }

  if (e.ctrlKey && !e.altKey) return ctrlCode(e.key)
  if (e.ctrlKey && altAsMeta) {
    const c = ctrlCode(e.key)
    return c === undefined ? undefined : ESC + c
  }
  if (altAsMeta && e.key.length === 1) return ESC + e.key
  return undefined
}
