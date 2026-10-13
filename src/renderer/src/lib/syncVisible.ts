/** Characters that do not read as what they are — control and format
 *  (bidi overrides, zero-width), every separator but the plain space,
 *  combining marks, and letters that render blank — are shown as \u{XXXX}:
 *  an approval (or an import preview) must read as what lands. */
const HIDDEN_CHARS = /[\p{C}\p{Z}\p{M}ᅟᅠㅤﾠ⠀]/gu

export function visible(value: unknown): string {
  return String(value ?? '').replace(HIDDEN_CHARS, (ch) =>
    ch === ' ' ? ch : '\\u{' + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0') + '}',
  )
}

/** A multi-line text escaped line by line: its line breaks stay line breaks
 *  (visible() alone would show them as \u{000A}). */
export function visibleText(value: unknown): string {
  return String(value ?? '').split('\n').map(visible).join('\n')
}
