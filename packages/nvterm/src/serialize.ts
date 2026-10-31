// Serializes the screen back to a VT byte stream that rebuilds it: glyphs
// with their SGR attributes, wrapped lines left to re-wrap, the cursor, and
// the modes an application set. Replaying the output into an empty terminal
// (nvterm or another VT terminal) restores the picture; a different width
// only re-wraps.
//
// Layout: the normal buffer (scrollback then viewport); if the alternate
// screen is active and not excluded, `CSI ? 1049 h CSI H` and the alternate
// screen; then the mode section.
import { WIDTH_TRAILING, WIDTH_WIDE, type Buffer, type Line } from './buffer'
import { CellFlag } from './snapshot'
import { DEFAULT_COLOR, PALETTE, RGB, type Style } from './style'
import type { TerminalCore } from './terminal'

export interface SerializeOptions {
  /** Scrollback lines to include (most recent first); all when omitted. */
  scrollback?: number
  /** Leave the alternate screen out. */
  excludeAltBuffer?: boolean
}

const CSI = '\x1b['

function colorParams(color: number, base: number): string {
  if (color === DEFAULT_COLOR) return ''
  if ((color & RGB) === RGB) return `${base + 8};2;${(color >> 16) & 0xff};${(color >> 8) & 0xff};${color & 0xff}`
  const index = color & 0xff
  if ((color & PALETTE) === PALETTE) {
    if (index < 8) return String(base + index)
    if (index < 16) return String(base + 60 + index - 8)
    return `${base + 8};5;${index}`
  }
  return ''
}

/** A full SGR sequence (starting from reset) for a style. */
export function sgrFor(s: Readonly<Style>): string {
  const p: string[] = ['0']
  if (s.flags & CellFlag.Bold) p.push('1')
  if (s.flags & CellFlag.Dim) p.push('2')
  if (s.flags & CellFlag.Italic) p.push('3')
  if (s.flags & CellFlag.Underline) p.push(s.underlineStyle > 1 ? `4:${s.underlineStyle}` : '4')
  if (s.flags & CellFlag.Blink) p.push('5')
  if (s.flags & CellFlag.Inverse) p.push('7')
  if (s.flags & CellFlag.Invisible) p.push('8')
  if (s.flags & CellFlag.Strikethrough) p.push('9')
  if (s.flags & CellFlag.Overline) p.push('53')
  const fg = colorParams(s.fg, 30)
  const bg = colorParams(s.bg, 40)
  if (fg) p.push(fg)
  if (bg) p.push(bg)
  // Underline colour (58) has no 16-colour short form.
  const ul = s.underlineColor
  if ((ul & RGB) === RGB) p.push(`58;2;${(ul >> 16) & 0xff};${(ul >> 8) & 0xff};${ul & 0xff}`)
  else if ((ul & PALETTE) === PALETTE) p.push(`58;5;${ul & 0xff}`)
  return `${CSI}${p.join(';')}m`
}

function isBlank(line: Line, x: number, style: (id: number) => Readonly<Style>): boolean {
  if (line.codes[x] !== 0) return false
  const s = style(line.styles[x]!)
  return s.bg === DEFAULT_COLOR && !(s.flags & CellFlag.Inverse)
}

/** End (exclusive) of the run of empty cells with the same style starting at `x`. */
function runEnd(line: Line, x: number): number {
  const id = line.styles[x]
  let end = x
  while (end < line.cols && line.codes[end] === 0 && line.widths[end] !== WIDTH_TRAILING && line.styles[end] === id) end++
  return end
}

/** Cells of `line` worth emitting: up to the last non-blank cell, or the whole line when the next one continues it. */
function usedWidth(line: Line, continues: boolean, style: (id: number) => Readonly<Style>): number {
  if (continues) return line.cols
  let end = line.cols
  while (end > 0 && isBlank(line, end - 1, style)) end--
  return end
}

function serializeLines(lines: Line[], style: (id: number) => Readonly<Style>): { text: string; lastWidth: number } {
  let out = ''
  let current = 0
  let lastWidth = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const next = lines[i + 1]
    const continues = next?.wrapped ?? false
    let width = usedWidth(line, continues, style)
    // A wide character that did not fit in the last column wrapped and left
    // that cell empty; replaying the wide character leaves it empty again.
    if (continues && next!.widths[0] === WIDTH_WIDE && line.codes[line.cols - 1] === 0 && isBlank(line, line.cols - 1, style)) width--
    for (let x = 0; x < width; x++) {
      if (line.widths[x] === WIDTH_TRAILING) continue
      const id = line.styles[x]!
      if (line.codes[x] === 0 && !(continues && runEnd(line, x) >= line.cols)) {
        // A run of empty cells stays empty: erase it (keeping its background)
        // and step over it, instead of writing spaces into it.
        const end = Math.min(runEnd(line, x), width)
        const n = end - x
        if (!isBlank(line, x, style)) {
          if (id !== current) {
            out += sgrFor(style(id))
            current = id
          }
          out += `${CSI}${n}X`
        }
        out += `${CSI}${n}C`
        x = end - 1
        continue
      }
      if (id !== current) {
        out += sgrFor(style(id))
        current = id
      }
      out += line.chars(x) || ' '
    }
    lastWidth = width
    if (i < lines.length - 1 && !continues) {
      // Reset first so the line feed cannot paint a background colour.
      if (current !== 0) {
        out += `${CSI}0m`
        current = 0
      }
      out += '\r\n'
    }
  }
  if (current !== 0) out += `${CSI}0m`
  return { text: out, lastWidth }
}

function modeSection(core: TerminalCore): string {
  const m = core.modes
  let out = ''
  if (m.applicationCursorKeys) out += `${CSI}?1h`
  if (m.applicationKeypad) out += `${CSI}?66h`
  if (m.bracketedPaste) out += `${CSI}?2004h`
  if (m.insert) out += `${CSI}4h`
  if (m.origin) out += `${CSI}?6h`
  if (m.reverseWraparound) out += `${CSI}?45h`
  if (m.sendFocus) out += `${CSI}?1004h`
  if (!m.autowrap) out += `${CSI}?7l`
  const tracking = { none: 0, x10: 9, vt200: 1000, drag: 1002, any: 1003 }[m.mouseTracking]
  if (tracking) out += `${CSI}?${tracking}h`
  const encoding = { default: 0, utf8: 1005, sgr: 1006, urxvt: 1015, 'sgr-pixels': 1016 }[m.mouseEncoding]
  if (encoding) out += `${CSI}?${encoding}h`
  if (!m.cursorVisible) out += `${CSI}?25l`
  return out
}

function normalBufferText(core: TerminalCore, buf: Buffer, scrollback: number | undefined, withCursor: boolean): string {
  const style = (id: number) => core.style(id)
  const keep = Math.min(buf.scrollbackLength, scrollback ?? buf.scrollbackLength)
  const first = buf.scrollbackLength - keep
  const cursorAbs = buf.scrollbackLength + buf.y
  // Everything up to the last non-empty line, and at least up to the cursor.
  let last = buf.length - 1
  while (last > cursorAbs && usedWidth(buf.absoluteLine(last)!, false, style) === 0) last--
  const lines: Line[] = []
  for (let i = first; i <= last; i++) lines.push(buf.absoluteLine(i)!)
  const { text, lastWidth } = serializeLines(lines, style)
  if (!withCursor) return text
  // Put the cursor back, relative to where the text left it.
  let move = ''
  const up = last - cursorAbs
  if (up > 0) move += `${CSI}${up}A`
  const x = Math.min(buf.x, core.cols - 1)
  if (up > 0 || x !== lastWidth) move += `${CSI}${x + 1}G`
  return text + move
}

export function serialize(core: TerminalCore, options: SerializeOptions = {}): string {
  const inAlt = core.active === core.alternate
  let out = normalBufferText(core, core.normal, options.scrollback, !inAlt)
  if (inAlt && !options.excludeAltBuffer) {
    const style = (id: number) => core.style(id)
    const alt = core.alternate
    const lines: Line[] = []
    for (let r = 0; r < core.rows; r++) lines.push(alt.line(r))
    let lastRow = core.rows - 1
    while (lastRow > 0 && usedWidth(lines[lastRow]!, false, style) === 0) lastRow--
    out += `${CSI}?1049h${CSI}H${serializeLines(lines.slice(0, lastRow + 1), style).text}`
    out += `${CSI}${alt.y + 1};${Math.min(alt.x, core.cols - 1) + 1}H`
  }
  return out + modeSection(core)
}
