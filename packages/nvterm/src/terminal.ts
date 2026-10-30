// Headless terminal core: applies parsed control functions to the screen.
// Spec references are per function below: ECMA-48 (5th ed.) section numbers,
// DEC STD 070 / VT510 manual names for DEC private functions, xterm ctlseqs
// for xterm extensions (alternate screen, mouse and paste modes, OSC).
import { Buffer, Line, WIDTH_NORMAL, WIDTH_TRAILING, WIDTH_WIDE } from './buffer'
import type { CellSnapshot, ScreenSnapshot } from './snapshot'
import { Parser, type ParserHandler } from './parser'
import type { Params } from './params'
import { applySgr, colorSpec, DEFAULT_STYLE, StyleTable, type Style } from './style'
import { charWidth } from './width'

export type MouseTrackingMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any'

export interface TerminalCoreOptions {
  cols: number
  rows: number
  /** Lines kept above the viewport (normal screen only). Default 1000. */
  scrollback?: number
  /** Bytes the terminal sends back to the application (DSR, DA replies). */
  onResponse?: (data: string) => void
  onTitle?: (title: string) => void
  onBell?: () => void
  /** OSC strings the core does not handle itself (everything but 0, 1, 2 and 8). */
  onOsc?: (code: number, data: string) => void
}

export interface Modes {
  applicationCursorKeys: boolean
  applicationKeypad: boolean
  autowrap: boolean
  bracketedPaste: boolean
  cursorVisible: boolean
  cursorBlink: boolean
  insert: boolean
  lineFeedNewLine: boolean
  origin: boolean
  reverseWraparound: boolean
  reverseVideo: boolean
  sendFocus: boolean
  synchronizedOutput: boolean
  mouseTracking: MouseTrackingMode
  mouseEncoding: 'default' | 'utf8' | 'sgr' | 'urxvt' | 'sgr-pixels'
}

const defaultModes = (): Modes => ({
  applicationCursorKeys: false,
  applicationKeypad: false,
  autowrap: true,
  bracketedPaste: false,
  cursorVisible: true,
  cursorBlink: false,
  insert: false,
  lineFeedNewLine: false,
  origin: false,
  reverseWraparound: false,
  reverseVideo: false,
  sendFocus: false,
  synchronizedOutput: false,
  mouseTracking: 'none',
  mouseEncoding: 'default',
})

/** DEC Special Graphics (VT100 User Guide, table 3-9): 0x60-0x7E as line drawing. */
const DEC_SPECIAL = '◆▒␉␌␍␊°±␤␋┘┐┌└┼⎺⎻─⎼⎽├┤┴┬│≤≥π≠£·'

export class TerminalCore implements ParserHandler {
  cols: number
  rows: number
  readonly normal: Buffer
  readonly alternate: Buffer
  active: Buffer
  modes: Modes = defaultModes()
  title = ''
  /** DECSCUSR value (0-6). */
  cursorStyle = 0

  private readonly parser: Parser
  private readonly styles = new StyleTable()
  private readonly links: string[] = ['']
  private readonly linkIds = new Map<string, number>()
  /** Current SGR state and its interned id. */
  private readonly attrs: Style = { ...DEFAULT_STYLE }
  private styleId = 0
  private tabs: Uint8Array
  private charsets: [string, string] = ['B', 'B']
  private glevel: 0 | 1 = 0
  private lastPrinted = 0

  private readonly options: TerminalCoreOptions

  constructor(options: TerminalCoreOptions) {
    this.options = options
    this.cols = options.cols
    this.rows = options.rows
    this.normal = new Buffer(this.cols, this.rows, options.scrollback ?? 1000)
    this.alternate = new Buffer(this.cols, this.rows, 0)
    this.active = this.normal
    this.tabs = defaultTabs(this.cols)
    this.parser = new Parser(this)
  }

  write(data: Uint8Array | string): void {
    if (typeof data === 'string') this.parser.parseString(data)
    else this.parser.parseBytes(data)
  }

  /** The URI of a hyperlink id stored in a cell's style. */
  linkUri(id: number): string {
    return this.links[id] ?? ''
  }

  style(id: number): Readonly<Style> {
    return this.styles.get(id)
  }

  // ---- ParserHandler ------------------------------------------------------

  print(data: Uint32Array, start: number, end: number): void {
    const buf = this.active
    const cols = this.cols
    const special = this.charsets[this.glevel] === '0'
    const insert = this.modes.insert
    const style = this.styleId
    let line = buf.line(buf.y)
    for (let i = start; i < end; i++) {
      let cp = data[i]!
      if (special && cp >= 0x60 && cp <= 0x7e) cp = DEC_SPECIAL.codePointAt(cp - 0x60)!
      // The parser only prints U+0020..U+007E and >= U+00A0.
      const width = cp < 0x7f ? 1 : charWidth(cp)

      if (width === 0) {
        // Combining character: joins the cell before the cursor. With no cell
        // before it, it is a defective combining sequence (Unicode 2.11) and
        // takes a cell of its own, as if applied to a space.
        let col = Math.min(buf.x, cols) - 1
        if (col >= 0) {
          if (line.widths[col] === WIDTH_TRAILING && col > 0) col--
          line.appendCombining(col, String.fromCodePoint(cp))
          continue
        }
      }

      if (buf.x >= cols) {
        if (this.modes.autowrap) {
          this.wrapToNextLine()
          line = buf.line(buf.y)
        } else {
          buf.x = cols - 1
        }
      }
      if (width === 2 && buf.x === cols - 1) {
        // A wide character does not fit in the last column.
        if (this.modes.autowrap) {
          this.wrapToNextLine()
          line = buf.line(buf.y)
        } else if (cols < 2) {
          continue
        } else {
          buf.x = cols - 2
        }
      }

      const x = buf.x
      if (insert) line.insertCells(x, width, this.eraseStyle())
      if (width !== 2 && line.widths[x] === WIDTH_NORMAL) {
        // Fast path: a narrow character over a narrow cell touches nothing else.
        line.codes[x] = cp
        line.styles[x] = style
        if (line.extra) line.extra.delete(x)
      } else if (width === 2 && line.widths[x] === WIDTH_NORMAL && line.widths[x + 1] === WIDTH_NORMAL && !line.extra) {
        // Fast path: a wide character over two narrow cells.
        line.codes[x] = cp
        line.widths[x] = WIDTH_WIDE
        line.styles[x] = style
        line.codes[x + 1] = 0
        line.widths[x + 1] = WIDTH_TRAILING
        line.styles[x + 1] = style
      } else {
        line.setCell(x, cp, width === 2 ? WIDTH_WIDE : WIDTH_NORMAL, style)
      }
      this.lastPrinted = cp
      // x may reach cols even with autowrap off (xterm.js reports it so); the next character overwrites the last column.
      buf.x += Math.max(width, 1)
    }
  }

  execute(code: number): void {
    const buf = this.active
    switch (code) {
      case 0x07: this.options.onBell?.(); break // BEL
      case 0x08: // BS (ECMA-48 8.3.5)
        buf.x = Math.max(0, this.col() - 1)
        break
      case 0x09: this.tabForward(1); break // HT
      case 0x0a: case 0x0b: case 0x0c: // LF, VT, FF (8.3.74, 8.3.161, 8.3.51)
        this.index()
        if (this.modes.lineFeedNewLine) buf.x = 0
        break
      case 0x0d: buf.x = 0; break // CR
      case 0x0e: this.glevel = 1; break // SO / LS1
      case 0x0f: this.glevel = 0; break // SI / LS0
      case 0x84: this.index(); break // IND
      case 0x85: buf.x = 0; this.index(); break // NEL
      case 0x88: this.tabs[this.col()] = 1; break // HTS
      case 0x8d: this.reverseIndex(); break // RI
    }
  }

  escDispatch(intermediates: string, final: number): void {
    const f = String.fromCharCode(final)
    if (intermediates === '') {
      switch (f) {
        case '7': this.saveCursor(); break // DECSC
        case '8': this.restoreCursor(); break // DECRC
        case 'D': this.index(); break // IND
        case 'E': this.active.x = 0; this.index(); break // NEL
        case 'H': this.tabs[this.col()] = 1; break // HTS
        case 'M': this.reverseIndex(); break // RI
        case 'c': this.fullReset(); break // RIS
        case '=': this.modes.applicationKeypad = true; break // DECKPAM
        case '>': this.modes.applicationKeypad = false; break // DECKPNM
      }
      return
    }
    if (intermediates === '(' || intermediates === ')') {
      // SCS: designate G0 / G1. Only '0' (DEC Special Graphics) differs from ASCII here.
      this.charsets[intermediates === '(' ? 0 : 1] = f === '0' ? '0' : 'B'
      return
    }
    if (intermediates === '#' && f === '8') this.screenAlignment() // DECALN
  }

  csiDispatch(prefix: string, params: Params, intermediates: string, final: number): void {
    const f = String.fromCharCode(final)
    const buf = this.active
    if (intermediates === '') {
      if (prefix === '') {
        switch (f) {
          case '@': this.line().insertCells(this.col(), params.count(0), this.eraseStyle()); this.clampAfterEdit(); return // ICH 8.3.64
          case 'A': this.cursorUp(params.count(0)); return // CUU 8.3.22
          case 'B': case 'e': this.cursorDown(params.count(0)); return // CUD 8.3.19, VPR 8.3.160
          case 'C': case 'a': buf.x = Math.min(this.cols - 1, this.col() + params.count(0)); return // CUF 8.3.20, HPR 8.3.59
          case 'D': buf.x = Math.max(0, this.col() - params.count(0)); return // CUB 8.3.18
          case 'E': this.cursorDown(params.count(0)); buf.x = 0; return // CNL 8.3.12
          case 'F': this.cursorUp(params.count(0)); buf.x = 0; return // CPL 8.3.13
          case 'G': case '`': buf.x = clamp(params.count(0) - 1, 0, this.cols - 1); return // CHA 8.3.9, HPA 8.3.57
          case 'H': case 'f': this.cursorPosition(params.count(0), params.count(1)); return // CUP 8.3.21, HVP 8.3.63
          case 'I': this.tabForward(params.count(0)); return // CHT 8.3.10
          case 'J': this.eraseInDisplay(params.get(0, 0)); return // ED 8.3.39
          case 'K': this.eraseInLine(params.get(0, 0)); return // EL 8.3.41
          case 'L': this.insertLines(params.count(0)); return // IL 8.3.67
          case 'M': this.deleteLines(params.count(0)); return // DL 8.3.32
          case 'P': this.line().deleteCells(this.col(), params.count(0), this.eraseStyle()); this.clampAfterEdit(); return // DCH 8.3.26
          case 'S': buf.scrollUp(params.count(0), buf.scrollTop, buf.scrollBottom, this.eraseStyle()); return // SU 8.3.147
          // SD 8.3.113. The five-parameter form (xterm highlight mouse tracking) is not supported and scrolls like SD, as in xterm.js.
          case 'T': buf.scrollDown(params.count(0), buf.scrollTop, buf.scrollBottom, this.eraseStyle()); return
          case 'X': { // ECH 8.3.38
            const x = this.col()
            this.line().erase(x, x + params.count(0), this.eraseStyle())
            return
          }
          case 'Z': this.tabBackward(params.count(0)); return // CBT 8.3.7
          case 'b': this.repeat(params.count(0)); return // REP 8.3.103
          case 'c': if (params.get(0, 0) === 0) this.respond('\x1b[?62;22c'); return // DA 8.3.24
          case 'd': this.cursorPosition(params.count(0), this.col() + 1, true); return // VPA 8.3.158
          case 'g': this.tabClear(params.get(0, 0)); return // TBC 8.3.154
          case 'h': this.setAnsiMode(params, true); return // SM 8.3.125
          case 'l': this.setAnsiMode(params, false); return // RM 8.3.106
          case 'm': applySgr(this.attrs, params); this.styleId = this.styles.intern(this.attrs); return // SGR 8.3.117
          case 'n': this.deviceStatus(params.get(0, 0), false); return // DSR 8.3.35
          case 'r': this.setMargins(params.count(0), params.count(1, this.rows)); return // DECSTBM
          // SCOSC / SCORC. Without left/right margin mode (DECLRMM, unsupported) CSI s saves even with parameters.
          case 's': this.saveCursor(); return
          case 'u': this.restoreCursor(); return
        }
        return
      }
      if (prefix === '?') {
        switch (f) {
          case 'h': this.setDecMode(params, true); return // DECSET
          case 'l': this.setDecMode(params, false); return // DECRST
          case 'J': this.eraseInDisplay(params.get(0, 0)); return // DECSED (no protected cells)
          case 'K': this.eraseInLine(params.get(0, 0)); return // DECSEL
          case 'n': this.deviceStatus(params.get(0, 0), true); return
        }
        return
      }
      if (prefix === '>' && f === 'c') this.respond('\x1b[>0;10;1c') // DA2
      return
    }
    if (intermediates === ' ' && f === 'q' && prefix === '') this.cursorStyle = params.get(0, 0) // DECSCUSR
    else if (intermediates === '!' && f === 'p' && prefix === '') this.softReset() // DECSTR
  }

  oscDispatch(data: string): void {
    const semi = data.indexOf(';')
    const code = Number(semi < 0 ? data : data.slice(0, semi))
    const rest = semi < 0 ? '' : data.slice(semi + 1)
    if (!Number.isInteger(code)) return
    switch (code) {
      case 0: case 2:
        this.title = rest
        this.options.onTitle?.(rest)
        return
      case 1: return
      case 8: { // OSC 8 ; params ; URI
        const uriStart = rest.indexOf(';')
        const uri = uriStart < 0 ? '' : rest.slice(uriStart + 1)
        this.attrs.link = uri ? this.linkId(uri) : 0
        this.styleId = this.styles.intern(this.attrs)
        return
      }
      default:
        this.options.onOsc?.(code, rest)
    }
  }

  dcsHook(): void {}
  dcsPut(): void {}
  dcsUnhook(): void {}

  // ---- Snapshot -----------------------------------------------------------

  snapshot(): ScreenSnapshot {
    const buf = this.active
    const lines = []
    for (let row = 0; row < this.rows; row++) {
      const line = buf.line(row)
      const cells: CellSnapshot[] = []
      for (let col = 0; col < this.cols; col++) {
        const s = this.styles.get(line.styles[col]!)
        cells.push({
          chars: line.chars(col),
          width: line.widths[col] as 0 | 1 | 2,
          fg: colorSpec(s.fg),
          bg: colorSpec(s.bg),
          flags: s.flags,
        })
      }
      lines.push({ wrapped: line.wrapped, cells })
    }
    return {
      cols: this.cols,
      rows: this.rows,
      buffer: buf === this.normal ? 'normal' : 'alternate',
      cursor: { x: buf.x, y: buf.y },
      modes: {
        applicationCursorKeysMode: this.modes.applicationCursorKeys,
        applicationKeypadMode: this.modes.applicationKeypad,
        bracketedPasteMode: this.modes.bracketedPaste,
        insertMode: this.modes.insert,
        mouseTrackingMode: this.modes.mouseTracking,
        originMode: this.modes.origin,
        reverseWraparoundMode: this.modes.reverseWraparound,
        sendFocusMode: this.modes.sendFocus,
        wraparoundMode: this.modes.autowrap,
      },
      scrollbackLength: buf === this.normal ? buf.scrollbackLength : 0,
      lines,
    }
  }

  /** Packs cold scrollback lines for up to `budgetMs`; true when nothing is left to pack. */
  packScrollback(budgetMs = Infinity): boolean {
    return this.normal.pack(budgetMs)
  }

  /**
   * Clears the scrollback and the screen except the cursor's line, which
   * becomes the first row (an explicit "clear" command, never part of resize
   * or redraw).
   */
  clearToCursorLine(): void {
    const buf = this.active
    const keep = new Line(this.cols)
    keep.copyFrom(buf.line(buf.y))
    keep.wrapped = false
    buf.clearScrollback()
    for (let r = 0; r < this.rows; r++) buf.line(r).clear(0)
    buf.line(0).copyFrom(keep)
    buf.y = 0
  }

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return
    // The normal screen reflows when the width changes; the alternate screen
    // (full-screen apps redraw themselves) is only cut or extended.
    if (cols !== this.cols) this.normal.reflow(cols, rows)
    else this.normal.resize(cols, rows)
    this.alternate.resize(cols, rows)
    const tabs = defaultTabs(cols)
    tabs.set(this.tabs.subarray(0, Math.min(cols, this.tabs.length)))
    this.tabs = tabs
    this.cols = cols
    this.rows = rows
  }

  // ---- Cursor and editing -------------------------------------------------

  /** Cursor column clamped to the screen (the pending-wrap position counts as the last column). */
  private col(): number {
    return Math.min(this.active.x, this.cols - 1)
  }

  private line(): Line {
    return this.active.line(this.active.y)
  }

  /** Style for erased cells: the current background only (ECMA-48 erase with BCE, as xterm does). */
  private eraseStyle(): number {
    if (this.attrs.bg === 0) return 0
    return this.styles.intern({ ...DEFAULT_STYLE, bg: this.attrs.bg })
  }

  private clampAfterEdit(): void {
    this.active.x = this.col()
  }

  private wrapToNextLine(): void {
    const buf = this.active
    buf.x = 0
    this.index()
    buf.line(buf.y).wrapped = true
  }

  /** IND: down one line, scrolling the region at its bottom margin. */
  private index(): void {
    const buf = this.active
    if (buf.y === buf.scrollBottom) buf.scrollUp(1, buf.scrollTop, buf.scrollBottom, this.eraseStyle(), true)
    else if (buf.y < this.rows - 1) buf.y++
    if (buf.x >= this.cols) buf.x = this.cols - 1
  }

  /** RI: up one line, scrolling the region down at its top margin. */
  private reverseIndex(): void {
    const buf = this.active
    if (buf.y === buf.scrollTop) buf.scrollDown(1, buf.scrollTop, buf.scrollBottom, this.eraseStyle())
    else if (buf.y > 0) buf.y--
    buf.x = this.col()
  }

  private cursorUp(n: number): void {
    const buf = this.active
    const top = buf.y >= buf.scrollTop ? buf.scrollTop : 0
    buf.y = Math.max(top, buf.y - n)
    buf.x = this.col()
  }

  private cursorDown(n: number): void {
    const buf = this.active
    const bottom = buf.y <= buf.scrollBottom ? buf.scrollBottom : this.rows - 1
    buf.y = Math.min(bottom, buf.y + n)
    buf.x = this.col()
  }

  /** CUP with 1-based row/column; relative to the scroll region in origin mode (DECOM). */
  private cursorPosition(row: number, col: number, keepCol = false): void {
    const buf = this.active
    if (this.modes.origin) buf.y = clamp(buf.scrollTop + row - 1, buf.scrollTop, buf.scrollBottom)
    else buf.y = clamp(row - 1, 0, this.rows - 1)
    buf.x = keepCol ? this.col() : clamp(col - 1, 0, this.cols - 1)
  }

  private tabForward(n: number): void {
    const buf = this.active
    // With a wrap pending the cursor stays put (as xterm.js does).
    if (buf.x >= this.cols) return
    let x = this.col()
    for (let i = 0; i < n && x < this.cols - 1; i++) {
      x++
      while (x < this.cols - 1 && !this.tabs[x]) x++
    }
    buf.x = x
  }

  private tabBackward(n: number): void {
    const buf = this.active
    let x = this.col()
    for (let i = 0; i < n && x > 0; i++) {
      x--
      while (x > 0 && !this.tabs[x]) x--
    }
    buf.x = x
  }

  private tabClear(mode: number): void {
    if (mode === 0) this.tabs[this.col()] = 0
    else if (mode === 3) this.tabs.fill(0)
  }

  private eraseInDisplay(mode: number): void {
    const buf = this.active
    const style = this.eraseStyle()
    const x = this.col()
    switch (mode) {
      case 0:
        // From the raw cursor: with a wrap pending (x === cols) the last cell survives, as in xterm.js.
        this.line().erase(buf.x, this.cols, style)
        for (let r = buf.y + 1; r < this.rows; r++) this.clearLine(r, style)
        break
      case 1:
        for (let r = 0; r < buf.y; r++) this.clearLine(r, style)
        this.line().erase(0, x + 1, style)
        break
      case 2:
        for (let r = 0; r < this.rows; r++) this.clearLine(r, style)
        break
      case 3:
        if (buf === this.normal) buf.clearScrollback()
        break
    }
  }

  private clearLine(row: number, style: number): void {
    const line = this.active.line(row)
    line.erase(0, this.cols, style)
    line.wrapped = false
  }

  private eraseInLine(mode: number): void {
    const x = this.col()
    const style = this.eraseStyle()
    if (mode === 0) this.line().erase(this.active.x, this.cols, style) // raw cursor, see eraseInDisplay
    else if (mode === 1) this.line().erase(0, x + 1, style)
    else if (mode === 2) this.line().erase(0, this.cols, style)
  }

  private insertLines(n: number): void {
    const buf = this.active
    if (buf.y < buf.scrollTop || buf.y > buf.scrollBottom) return
    buf.scrollDown(n, buf.y, buf.scrollBottom, this.eraseStyle())
    buf.x = 0
  }

  private deleteLines(n: number): void {
    const buf = this.active
    if (buf.y < buf.scrollTop || buf.y > buf.scrollBottom) return
    // Deleting lines never feeds the scrollback, even at the top of the screen.
    buf.deleteLines(buf.y, n, buf.scrollBottom, this.eraseStyle())
    buf.x = 0
  }

  private repeat(n: number): void {
    if (!this.lastPrinted) return
    const data = new Uint32Array(Math.min(n, 0xffff)).fill(this.lastPrinted)
    // REP repeats the graphic character as printed; undo the charset mapping by printing in ASCII mode.
    const saved = this.charsets[this.glevel]!
    this.charsets[this.glevel] = 'B'
    this.print(data, 0, data.length)
    this.charsets[this.glevel] = saved
  }

  private setMargins(top: number, bottom: number): void {
    const buf = this.active
    bottom = Math.min(bottom, this.rows)
    if (top >= bottom) return
    buf.scrollTop = top - 1
    buf.scrollBottom = bottom - 1
    this.cursorPosition(1, 1)
  }

  private saveCursor(): void {
    const buf = this.active
    buf.saved = { x: buf.x, y: buf.y, style: this.styleId, originMode: this.modes.origin, charsets: [...this.charsets], glevel: this.glevel }
  }

  private restoreCursor(): void {
    const buf = this.active
    const saved = buf.saved
    if (!saved) {
      buf.x = 0
      buf.y = 0
      this.modes.origin = false
      Object.assign(this.attrs, DEFAULT_STYLE)
      this.styleId = 0
      return
    }
    buf.x = Math.min(saved.x, this.cols)
    buf.y = Math.min(saved.y, this.rows - 1)
    this.modes.origin = saved.originMode
    this.charsets = [...saved.charsets]
    this.glevel = saved.glevel
    Object.assign(this.attrs, this.styles.get(saved.style))
    this.styleId = saved.style
  }

  private screenAlignment(): void {
    const buf = this.active
    buf.scrollTop = 0
    buf.scrollBottom = this.rows - 1
    for (let r = 0; r < this.rows; r++) {
      const line = buf.line(r)
      for (let c = 0; c < this.cols; c++) line.setCell(c, 0x45, WIDTH_NORMAL, 0)
      line.wrapped = false
    }
    buf.x = 0
    buf.y = 0
  }

  // ---- Modes ---------------------------------------------------------------

  private setAnsiMode(params: Params, on: boolean): void {
    for (let i = 0; i < params.length; i++) {
      const mode = params.get(i, 0)
      if (mode === 4) this.modes.insert = on // IRM
      else if (mode === 20) this.modes.lineFeedNewLine = on // LNM
    }
  }

  private setDecMode(params: Params, on: boolean): void {
    for (let i = 0; i < params.length; i++) {
      const mode = params.get(i, 0)
      switch (mode) {
        case 1: this.modes.applicationCursorKeys = on; break // DECCKM
        case 5: this.modes.reverseVideo = on; break // DECSCNM
        case 6: this.modes.origin = on; this.cursorPosition(1, 1); break // DECOM
        case 7: this.modes.autowrap = on; break // DECAWM
        case 9: this.setMouse('x10', on); break
        case 12: this.modes.cursorBlink = on; break
        case 25: this.modes.cursorVisible = on; break // DECTCEM
        case 45: this.modes.reverseWraparound = on; break
        case 66: this.modes.applicationKeypad = on; break // DECNKM
        case 1000: this.setMouse('vt200', on); break
        case 1002: this.setMouse('drag', on); break
        case 1003: this.setMouse('any', on); break
        case 1004: this.modes.sendFocus = on; break
        case 1005: this.setMouseEncoding('utf8', on); break
        case 1006: this.setMouseEncoding('sgr', on); break
        case 1015: this.setMouseEncoding('urxvt', on); break
        case 1016: this.setMouseEncoding('sgr-pixels', on); break
        case 2004: this.modes.bracketedPaste = on; break
        case 2026: this.modes.synchronizedOutput = on; break
        // The alternate screen starts empty every time it is entered, as in xterm.js.
        case 47: case 1047: this.switchScreen(on, mode === 1047 && !on, true); break
        case 1048: if (on) this.saveCursor(); else this.restoreCursor(); break
        case 1049:
          if (on) {
            this.saveCursor()
            this.switchScreen(true, false, true)
          } else {
            this.switchScreen(false, false, false)
            this.restoreCursor()
          }
          break
      }
    }
  }

  private setMouse(mode: MouseTrackingMode, on: boolean): void {
    if (on) this.modes.mouseTracking = mode
    else if (this.modes.mouseTracking === mode) this.modes.mouseTracking = 'none'
  }

  private setMouseEncoding(encoding: Modes['mouseEncoding'], on: boolean): void {
    if (on) this.modes.mouseEncoding = encoding
    else if (this.modes.mouseEncoding === encoding) this.modes.mouseEncoding = 'default'
  }

  /** Switches between the normal and the alternate screen (xterm modes 47 / 1047 / 1049). */
  private switchScreen(toAlternate: boolean, clearAltBeforeLeaving: boolean, clearAltOnEnter: boolean): void {
    if (toAlternate) {
      if (this.active === this.alternate) return
      this.alternate.x = this.normal.x
      this.alternate.y = this.normal.y
      this.active = this.alternate
      if (clearAltOnEnter) for (let r = 0; r < this.rows; r++) this.clearLine(r, this.eraseStyle())
      return
    }
    if (this.active === this.normal) return
    if (clearAltBeforeLeaving) for (let r = 0; r < this.rows; r++) this.clearLine(r, this.eraseStyle())
    this.normal.x = this.alternate.x
    this.normal.y = this.alternate.y
    this.active = this.normal
  }

  private deviceStatus(code: number, dec: boolean): void {
    const buf = this.active
    if (code === 5 && !dec) this.respond('\x1b[0n')
    else if (code === 6) {
      const row = this.modes.origin ? buf.y - buf.scrollTop + 1 : buf.y + 1
      this.respond(dec ? `\x1b[?${row};${this.col() + 1}R` : `\x1b[${row};${this.col() + 1}R`)
    }
  }

  private respond(data: string): void {
    this.options.onResponse?.(data)
  }

  private linkId(uri: string): number {
    let id = this.linkIds.get(uri)
    if (id === undefined) {
      id = this.links.length
      this.links.push(uri)
      this.linkIds.set(uri, id)
    }
    return id
  }

  // ---- Resets ----------------------------------------------------------------

  /** DECSTR (VT510 manual): soft terminal reset. */
  private softReset(): void {
    Object.assign(this.modes, {
      insert: false, origin: false, autowrap: true, cursorVisible: true, applicationKeypad: false, applicationCursorKeys: false,
    })
    for (const buf of [this.normal, this.alternate]) {
      buf.scrollTop = 0
      buf.scrollBottom = this.rows - 1
      buf.saved = null
    }
    Object.assign(this.attrs, DEFAULT_STYLE)
    this.styleId = 0
    this.charsets = ['B', 'B']
    this.glevel = 0
  }

  /** RIS (ECMA-48 8.3.105): back to the initial state, screen cleared, scrollback kept out. */
  private fullReset(): void {
    this.modes = defaultModes()
    this.active = this.normal
    this.normal.reset()
    this.alternate.reset()
    Object.assign(this.attrs, DEFAULT_STYLE)
    this.styleId = 0
    this.tabs = defaultTabs(this.cols)
    this.charsets = ['B', 'B']
    this.glevel = 0
    this.title = ''
    this.cursorStyle = 0
    this.parser.reset()
  }
}

function defaultTabs(cols: number): Uint8Array {
  const tabs = new Uint8Array(cols)
  for (let c = 8; c < cols; c += 8) tabs[c] = 1
  return tabs
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

