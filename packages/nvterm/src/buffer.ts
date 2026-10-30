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

  /** Empties the whole line for reuse. */
  clear(style: number): void {
    this.codes.fill(0)
    this.widths.fill(WIDTH_NORMAL)
    this.styles.fill(style)
    this.extra = null
    this.wrapped = false
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
  /** Scrollback followed by the viewport, from index `start`. Entries before `start` are dropped scrollback awaiting compaction. */
  lines: Line[] = []
  /** Index in `lines` of the oldest kept scrollback line. */
  private start = 0
  /** Index in `lines` of the top viewport row. */
  base = 0
  /**
   * Lines ever dropped from the front (scrollback overflow, ED 3, resets).
   * `dropped + absolute index` names a line stably while output keeps arriving.
   */
  dropped = 0
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

  get scrollbackLength(): number {
    return this.base - this.start
  }

  /** Scrollback plus viewport rows. */
  get length(): number {
    return this.scrollbackLength + this.rows
  }

  /** Line `i` counting from the oldest scrollback line (scrollback first, then the viewport). */
  absoluteLine(i: number): Line | undefined {
    return i >= 0 && i < this.length ? this.lines[this.start + i] : undefined
  }

  /** The i-th scrollback line, oldest first. */
  scrollbackLine(i: number): Line | undefined {
    return i < this.scrollbackLength ? this.lines[this.start + i] : undefined
  }

  /** Empties the buffer: one blank viewport, no scrollback, cursor home, full margins. */
  reset(): void {
    this.dropped += this.length
    this.lines = Array.from({ length: this.rows }, () => new Line(this.cols))
    this.start = 0
    this.base = 0
    this.x = 0
    this.y = 0
    this.scrollTop = 0
    this.scrollBottom = this.rows - 1
    this.saved = null
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
      for (let i = 0; i < n; i++) {
        let fresh: Line
        if (this.scrollbackLength >= this.scrollback) {
          // The scrollback is full: the oldest line is dropped and reused.
          // Dropping from the front of an array is O(length), so move the
          // start instead and compact once the dead prefix is large.
          fresh = this.lines[this.start]!
          fresh.clear(style)
          this.start++
          this.dropped++
        } else {
          fresh = new Line(this.cols, style)
        }
        if (bottom === this.rows - 1) this.lines.push(fresh)
        else this.lines.splice(this.base + bottom + 1, 0, fresh)
        this.base++
      }
      if (this.start >= 1024 && this.start * 2 >= this.lines.length) this.compact()
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
    this.dropped += this.scrollbackLength
    this.lines.splice(0, this.base)
    this.base = 0
    this.start = 0
  }

  private compact(): void {
    this.lines.splice(0, this.start)
    this.base -= this.start
    this.start = 0
  }

  /** Resizes without reflow (reflow is M5). Rows shrink from the bottom first, then push lines into scrollback. */
  resize(cols: number, rows: number): void {
    this.compact()
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

  /**
   * Resizes with reflow (normal screen): lines joined by autowrap are
   * re-wrapped at the new width, so narrowing and widening again gives the
   * original lines back. Nothing is cleared; scrollback only loses lines
   * beyond its cap. The cursor keeps its place in its logical line.
   */
  reflow(cols: number, rows: number): void {
    this.compact()
    const cursorAbs = this.base + this.y
    const cursorX = Math.min(this.x, this.cols)

    // 1. Logical lines: a line plus the lines that continue it. Positions are
    //    counted in columns (a wide character is two), like the cursor.
    type Cell = { code: number; width: number; style: number; extra: string | undefined }
    const logical: { cells: Cell[]; columns: number; cursorAt: number; fill: number }[] = []
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i]!
      if (!line.wrapped || logical.length === 0) logical.push({ cells: [], columns: 0, cursorAt: -1, fill: 0 })
      const current = logical[logical.length - 1]!
      const next = this.lines[i + 1]
      const continues = next?.wrapped ?? false
      // Trailing empty cells are not content, whatever their background; a
      // background they share is kept as the fill of the re-wrapped line.
      let end = line.cols
      if (!continues) {
        while (end > 0 && line.codes[end - 1] === 0 && line.widths[end - 1] !== WIDTH_TRAILING) end--
        current.fill = end < line.cols ? line.styles[line.cols - 1]! : 0
      } else if (next!.widths[0] === WIDTH_WIDE && line.codes[line.cols - 1] === 0) {
        end-- // the gap a wide character left when it wrapped
      }
      if (i === cursorAbs) current.cursorAt = current.columns + cursorX
      for (let x = 0; x < end; x++) {
        if (line.widths[x] === WIDTH_TRAILING) continue
        current.cells.push({ code: line.codes[x]!, width: line.widths[x]!, style: line.styles[x]!, extra: line.extra?.get(x) })
        current.columns += line.widths[x] === WIDTH_WIDE ? 2 : 1
      }
    }

    // 2. Re-wrap each logical line at the new width.
    const out: Line[] = []
    let newCursorAbs = 0
    let newCursorX = 0
    for (const { cells, columns, cursorAt, fill } of logical) {
      let line = new Line(cols)
      out.push(line)
      let x = 0
      let column = 0
      let cursorPlaced = cursorAt < 0
      for (const cell of cells) {
        const w = cell.width === WIDTH_WIDE ? 2 : 1
        if (x + w > cols) {
          line = new Line(cols)
          line.wrapped = true
          out.push(line)
          x = 0
        }
        if (!cursorPlaced && cursorAt <= column) {
          newCursorAbs = out.length - 1
          newCursorX = x
          cursorPlaced = true
        }
        line.setCell(x, cell.code, cell.width === WIDTH_WIDE ? WIDTH_WIDE : WIDTH_NORMAL, cell.style)
        if (cell.extra) line.appendCombining(x, cell.extra)
        x += w
        column += w
      }
      if (fill && x < cols) line.styles.fill(fill, x)
      if (!cursorPlaced) {
        // The cursor sits after the text (or further right, on blank cells).
        let target = x + (cursorAt - columns)
        let row = out.length - 1
        while (target > cols) {
          target -= cols
          row++
        }
        while (out.length - 1 < row) {
          const extra = new Line(cols, fill)
          extra.wrapped = true
          out.push(extra)
        }
        newCursorAbs = row
        newCursorX = target
      }
    }

    // 3. Viewport: drop blank lines below the cursor, keep the cursor on screen.
    let last = out.length - 1
    while (last > newCursorAbs && out[last]!.codes.every((c) => c === 0) && !out[last]!.wrapped) last--
    out.length = last + 1
    let base = Math.max(0, out.length - rows)
    if (newCursorAbs < base) base = newCursorAbs
    while (out.length < base + rows) out.push(new Line(cols))
    // Scrollback cap.
    const excess = base - this.scrollback
    if (excess > 0) {
      out.splice(0, excess)
      base -= excess
      newCursorAbs -= excess
      this.dropped += excess
    }
    this.lines = out
    this.start = 0
    this.base = base
    this.cols = cols
    this.rows = rows
    this.scrollTop = 0
    this.scrollBottom = rows - 1
    this.y = Math.max(0, Math.min(rows - 1, newCursorAbs - base))
    this.x = Math.min(newCursorX, cols)
    if (this.saved) {
      this.saved.x = Math.min(this.saved.x, cols - 1)
      this.saved.y = Math.min(this.saved.y, rows - 1)
    }
  }

  private lastNonEmptyRow(): number {
    for (let r = this.rows - 1; r >= 0; r--) {
      const line = this.line(r)
      if (line.codes.some((c) => c !== 0)) return r
    }
    return 0
  }
}
