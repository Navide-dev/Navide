// Text selection over the buffer. Positions use stable line ids
// (Buffer.dropped + absolute index) so a selection survives new output.
import { WIDTH_TRAILING, type Buffer, type Line } from '../buffer.ts'

export interface CellPos {
  /** Column, 0-based. */
  x: number
  /** Stable line id. */
  y: number
}

export type SelectionMode = 'char' | 'word' | 'line'

/** Characters that end a word for double-click selection. */
const WORD_SEPARATORS = new Set([...' \t()[]{}<>\'"`,;|│'])

const before = (a: CellPos, b: CellPos): boolean => a.y < b.y || (a.y === b.y && a.x < b.x)

export class Selection {
  private anchor: CellPos | null = null
  private head: CellPos | null = null
  private mode: SelectionMode = 'char'

  private readonly buffer: () => Buffer

  constructor(buffer: () => Buffer) {
    this.buffer = buffer
  }

  get active(): boolean {
    return this.anchor !== null && this.head !== null && !(this.mode === 'char' && this.anchor.x === this.head.x && this.anchor.y === this.head.y)
  }

  clear(): void {
    this.anchor = null
    this.head = null
  }

  start(pos: CellPos, mode: SelectionMode): void {
    this.anchor = pos
    this.head = pos
    this.mode = mode
  }

  extend(pos: CellPos): void {
    if (this.anchor) this.head = pos
  }

  /** Selects `length` cells from (x, absolute row). */
  select(x: number, absoluteRow: number, length: number): void {
    const buf = this.buffer()
    const start = { x, y: buf.dropped + absoluteRow }
    const endIndex = x + length
    const end = { x: endIndex % buf.cols, y: start.y + Math.floor(endIndex / buf.cols) }
    this.anchor = start
    this.head = end
    this.mode = 'char'
  }

  selectAll(): void {
    const buf = this.buffer()
    this.anchor = { x: 0, y: buf.dropped }
    this.head = { x: buf.cols, y: buf.dropped + buf.length - 1 }
    this.mode = 'char'
  }

  /** Normalized [start, end) in stable ids, expanded for word and line modes; null when empty. */
  range(): { start: CellPos; end: CellPos } | null {
    if (!this.active || !this.anchor || !this.head) return null
    let start = before(this.head, this.anchor) ? this.head : this.anchor
    let end = before(this.head, this.anchor) ? this.anchor : this.head
    if (this.mode === 'word') {
      start = this.wordStart(start)
      end = this.wordEnd(end)
    } else if (this.mode === 'line') {
      start = { x: 0, y: this.logicalLineStart(start.y) }
      end = { x: this.buffer().cols, y: this.logicalLineEnd(end.y) }
    }
    const buf = this.buffer()
    // Lines dropped from the front take the selection with them.
    if (end.y < buf.dropped) return null
    if (start.y < buf.dropped) start = { x: 0, y: buf.dropped }
    return { start, end }
  }

  /** Whether the cell at (x, stable y) is selected. */
  contains(x: number, y: number, range = this.range()): boolean {
    if (!range) return false
    const p = { x, y }
    return !before(p, range.start) && before(p, range.end)
  }

  text(): string {
    const range = this.range()
    if (!range) return ''
    const buf = this.buffer()
    let out = ''
    for (let y = range.start.y; y <= range.end.y; y++) {
      const line = this.line(y)
      if (!line) continue
      const from = y === range.start.y ? range.start.x : 0
      const to = y === range.end.y ? range.end.x : buf.cols
      let text = lineText(line, from, to)
      const next = this.line(y + 1)
      const continues = y < range.end.y && next?.wrapped
      if (!continues) text = text.replace(/\s+$/, '')
      out += text
      if (y < range.end.y && !continues) out += '\n'
    }
    // Empty rows at the end of the selection (below the output) add nothing.
    return out.replace(/\n+$/, '')
  }

  private line(stableY: number): Line | undefined {
    const buf = this.buffer()
    return buf.absoluteLine(stableY - buf.dropped)
  }

  private wordStart(pos: CellPos): CellPos {
    const line = this.line(pos.y)
    if (!line) return pos
    let x = Math.min(pos.x, line.cols - 1)
    if (isSeparator(line, x)) return { x, y: pos.y }
    while (x > 0 && !isSeparator(line, x - 1)) x--
    return { x, y: pos.y }
  }

  private wordEnd(pos: CellPos): CellPos {
    const line = this.line(pos.y)
    if (!line) return pos
    let x = Math.min(pos.x, line.cols - 1)
    if (isSeparator(line, x)) return { x: x + 1, y: pos.y }
    while (x < line.cols && !isSeparator(line, x)) x++
    return { x, y: pos.y }
  }

  private logicalLineStart(y: number): number {
    while (this.line(y)?.wrapped && this.line(y - 1)) y--
    return y
  }

  private logicalLineEnd(y: number): number {
    while (this.line(y + 1)?.wrapped) y++
    return y
  }
}

function isSeparator(line: Line, x: number): boolean {
  if (line.widths[x] === WIDTH_TRAILING) return false
  const chars = line.chars(x)
  return chars === '' || WORD_SEPARATORS.has(chars)
}

/** Text of cells [from, to); empty cells read as spaces, trailing halves are skipped. */
export function lineText(line: Line, from: number, to: number): string {
  let out = ''
  for (let x = Math.max(0, from); x < Math.min(to, line.cols); x++) {
    if (line.widths[x] === WIDTH_TRAILING) continue
    out += line.chars(x) || ' '
  }
  return out
}
