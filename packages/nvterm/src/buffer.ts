// Screen storage: lines of cells, and a buffer (scrollback + viewport) with
// its cursor and margins. Compact encodings and scrollback compression come
// in M5; this layout keeps the cell fields in typed arrays from the start.

export const WIDTH_TRAILING = 0
export const WIDTH_NORMAL = 1
export const WIDTH_WIDE = 2

export class Line {
  /** Code point per cell; 0 = empty (never written or erased). */
  codes: Uint32Array
  /** WIDTH_NORMAL, WIDTH_WIDE (leading half) or WIDTH_TRAILING. */
  widths: Uint8Array
  styles: Uint32Array
  /** Combining characters appended to a cell, by column. */
  extra: Map<number, string> | null = null
  /** True when this line continues the previous one because of autowrap. */
  wrapped = false

  cols: number

  constructor(cols: number, style = 0) {
    this.cols = cols
    this.codes = new Uint32Array(cols)
    this.widths = new Uint8Array(cols).fill(WIDTH_NORMAL)
    this.styles = new Uint32Array(cols).fill(style)
  }

  /** Text of one cell, '' for an empty cell or a trailing half. */
  chars(col: number): string {
    const code = this.codes[col]!
    if (code === 0) return ''
    const extra = this.extra?.get(col)
    return extra ? String.fromCodePoint(code) + extra : String.fromCodePoint(code)
  }

  /** Resets cells [start, end) to empty cells with `style`. */
  erase(start: number, end: number, style: number): void {
    start = Math.max(0, start)
    end = Math.min(this.cols, end)
    if (start >= end) return
    this.splitWide(start)
    this.splitWide(end)
    this.codes.fill(0, start, end)
    this.widths.fill(WIDTH_NORMAL, start, end)
    this.styles.fill(style, start, end)
    if (this.extra) for (let c = start; c < end; c++) this.extra.delete(c)
  }

  /**
   * Makes `col` the start of a cell: if a wide character straddles the
   * boundary between col-1 and col, both halves become empty.
   */
  splitWide(col: number): void {
    if (col <= 0 || col >= this.cols) return
    if (this.widths[col] === WIDTH_TRAILING) {
      this.blank(col - 1)
      this.blank(col)
    }
  }

  setCell(col: number, code: number, width: number, style: number): void {
    // Overwriting either half of a wide character empties the other half.
    if (this.widths[col] === WIDTH_TRAILING && col > 0) this.blank(col - 1)
    const right = col + (width === WIDTH_WIDE ? 1 : 0)
    if (this.widths[right] === WIDTH_WIDE && right + 1 < this.cols) this.blank(right + 1)
    this.codes[col] = code
    this.widths[col] = width
    this.styles[col] = style
    this.extra?.delete(col)
    if (width === WIDTH_WIDE && col + 1 < this.cols) {
      this.codes[col + 1] = 0
      this.widths[col + 1] = WIDTH_TRAILING
      this.styles[col + 1] = style
      this.extra?.delete(col + 1)
    }
  }

  appendCombining(col: number, text: string): void {
    if (this.codes[col] === 0) return
    this.extra ??= new Map()
    this.extra.set(col, (this.extra.get(col) ?? '') + text)
  }

  /** Inserts `n` empty cells at `col`, pushing the rest right; cells past the end are lost. */
  insertCells(col: number, n: number, style: number): void {
    if (col >= this.cols) return
    n = Math.min(n, this.cols - col)
    this.splitWide(col)
    this.codes.copyWithin(col + n, col, this.cols - n)
    this.widths.copyWithin(col + n, col, this.cols - n)
    this.styles.copyWithin(col + n, col, this.cols - n)
    this.shiftExtra(col, n)
    this.codes.fill(0, col, col + n)
    this.widths.fill(WIDTH_NORMAL, col, col + n)
    this.styles.fill(style, col, col + n)
    // A wide character cut in half at the right edge disappears.
    if (this.widths[this.cols - 1] === WIDTH_WIDE) this.blank(this.cols - 1)
  }

  /** Deletes `n` cells at `col`, pulling the rest left and filling the end with empty cells. */
  deleteCells(col: number, n: number, style: number): void {
    if (col >= this.cols) return
    n = Math.min(n, this.cols - col)
    this.splitWide(col)
    this.splitWide(col + n)
    this.codes.copyWithin(col, col + n)
    this.widths.copyWithin(col, col + n)
    this.styles.copyWithin(col, col + n)
    this.shiftExtra(col, -n)
    this.codes.fill(0, this.cols - n)
    this.widths.fill(WIDTH_NORMAL, this.cols - n)
    this.styles.fill(style, this.cols - n)
  }

  resize(cols: number, style: number): void {
    if (cols === this.cols) return
    const codes = new Uint32Array(cols)
    const widths = new Uint8Array(cols).fill(WIDTH_NORMAL)
    const styles = new Uint32Array(cols).fill(style)
    const keep = Math.min(cols, this.cols)
    codes.set(this.codes.subarray(0, keep))
    widths.set(this.widths.subarray(0, keep))
    styles.set(this.styles.subarray(0, keep))
    this.codes = codes
    this.widths = widths
    this.styles = styles
    this.cols = cols
    if (this.extra) for (const c of [...this.extra.keys()]) if (c >= cols) this.extra.delete(c)
    if (this.widths[cols - 1] === WIDTH_WIDE) this.blank(cols - 1)
  }

  copyFrom(other: Line): void {
    this.codes.set(other.codes)
    this.widths.set(other.widths)
    this.styles.set(other.styles)
    this.extra = other.extra ? new Map(other.extra) : null
    this.wrapped = other.wrapped
  }

  private blank(col: number): void {
    this.codes[col] = 0
    this.widths[col] = WIDTH_NORMAL
    this.extra?.delete(col)
  }

  private shiftExtra(from: number, by: number): void {
    if (!this.extra?.size) return
    const next = new Map<number, string>()
    for (const [c, text] of this.extra) {
      if (c < from) next.set(c, text)
      else if (by < 0 && c < from - by) continue
      else if (c + by < this.cols) next.set(c + by, text)
    }
    this.extra = next
  }
}

export interface SavedCursor {
  x: number
  y: number
  style: number
  originMode: boolean
  charsets: [string, string]
  glevel: 0 | 1
}

export class Buffer {
  /** Scrollback followed by the viewport. */
  lines: Line[] = []
  /** Index in `lines` of the top viewport row. */
  base = 0
  /** Cursor column; equals cols while a wrap is pending after the last column. */
  x = 0
  y = 0
  scrollTop = 0
  scrollBottom: number
  saved: SavedCursor | null = null

  cols: number
  rows: number
  readonly scrollback: number

  constructor(cols: number, rows: number, scrollback: number) {
    this.cols = cols
    this.rows = rows
    this.scrollback = scrollback
    this.scrollBottom = rows - 1
    for (let i = 0; i < rows; i++) this.lines.push(new Line(cols))
  }

  line(row: number): Line {
    return this.lines[this.base + row]!
  }

  /**
   * Scrolls rows [top, bottom] up by n, filling with empty lines. With
   * `toScrollback`, a region starting at the top row keeps the lines that
   * leave it as scrollback (what a line feed at the bottom margin does; SU
   * does not).
   */
  scrollUp(n: number, top: number, bottom: number, style: number, toScrollback = false): void {
    n = Math.min(n, bottom - top + 1)
    if (toScrollback && top === 0 && this.scrollback > 0) {
      const fresh = Array.from({ length: n }, () => new Line(this.cols, style))
      this.lines.splice(this.base + bottom + 1, 0, ...fresh)
      this.base += n
      const excess = this.base - this.scrollback
      if (excess > 0) {
        this.lines.splice(0, excess)
        this.base -= excess
      }
      return
    }
    const removed = this.lines.splice(this.base + top, n)
    for (const line of removed) {
      line.erase(0, this.cols, style)
      line.wrapped = false
    }
    this.lines.splice(this.base + bottom - n + 1, 0, ...removed)
  }

  /** Scrolls rows [top, bottom] down by n, filling the top with empty lines. */
  scrollDown(n: number, top: number, bottom: number, style: number): void {
    n = Math.min(n, bottom - top + 1)
    const removed = this.lines.splice(this.base + bottom - n + 1, n)
    for (const line of removed) {
      line.erase(0, this.cols, style)
      line.wrapped = false
    }
    this.lines.splice(this.base + top, 0, ...removed)
  }

  clearScrollback(): void {
    this.lines.splice(0, this.base)
    this.base = 0
  }

  /** Resizes without reflow (reflow is M5). Rows shrink from the bottom first, then push lines into scrollback. */
  resize(cols: number, rows: number): void {
    for (const line of this.lines) line.resize(cols, 0)
    if (rows < this.rows) {
      const lastUsed = this.lastNonEmptyRow()
      const keepBelow = Math.max(this.y, lastUsed)
      const shift = Math.max(0, keepBelow - rows + 1)
      this.base += shift
      this.y -= shift
      this.lines.length = this.base + rows
    } else if (rows > this.rows) {
      const pull = Math.min(this.base, rows - this.rows)
      this.base -= pull
      this.y += pull
      while (this.lines.length < this.base + rows) this.lines.push(new Line(cols))
    }
    this.cols = cols
    this.rows = rows
    this.scrollTop = 0
    this.scrollBottom = rows - 1
    this.x = Math.min(this.x, cols)
    this.y = Math.min(this.y, rows - 1)
  }

  private lastNonEmptyRow(): number {
    for (let r = this.rows - 1; r >= 0; r--) {
      const line = this.line(r)
      if (line.codes.some((c) => c !== 0)) return r
    }
    return 0
  }
}
