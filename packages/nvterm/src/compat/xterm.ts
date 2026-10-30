// A compatibility layer with the shape of the parts of xterm.js that Navide
// calls (see the nvterm plan, section 1.1), so a host written against
// xterm.js can construct nvterm instead without changing call sites.
//
// The shape comes from Navide's own call sites and xterm.js's public API
// documentation; nothing here is derived from xterm.js source (CLEAN_ROOM.md).
// Two private shapes that Navide reaches for are mirrored on purpose so its
// code needs no change: `_core._renderService` (cell size, render cache
// clear) and `_core._compositionHelper` (stuck IME composition), plus
// `WebglAddon._renderer.handleBlur`. They map onto nvterm's public API.
import { NvTerminal, type NvTerminalOptions } from '../browser/nvterminal.ts'
import type { IDisposable, LinkProvider } from '../browser/events.ts'
import { lineText } from '../browser/selection.ts'
import type { Line } from '../buffer.ts'
import { serialize, type SerializeOptions } from '../serialize.ts'

export interface CompatAddon {
  activate(terminal: Terminal): void
  dispose(): void
}

/** The options Navide passes; unknown ones are kept and ignored. */
export interface CompatOptions {
  cols?: number
  rows?: number
  fontFamily?: string
  fontSize?: number
  lineHeight?: number
  cursorBlink?: boolean
  convertEol?: boolean
  scrollback?: number
  minimumContrastRatio?: number
  theme?: NvTerminalOptions['theme']
  macOptionIsMeta?: boolean
  macOptionClickForcesSelection?: boolean
  allowProposedApi?: boolean
  [key: string]: unknown
}

/** Options that change rendering when set at runtime. */
const LIVE_OPTIONS = new Set(['fontFamily', 'fontSize', 'lineHeight', 'cursorBlink', 'theme', 'minimumContrastRatio', 'macOptionIsMeta', 'macOptionClickForcesSelection', 'convertEol'])

class BufferCell {
  private readonly line: Line
  private readonly x: number
  constructor(line: Line, x: number) {
    this.line = line
    this.x = x
  }
  getWidth(): number {
    return this.line.widths[this.x] ?? 1
  }
  getChars(): string {
    return this.line.chars(this.x)
  }
  getCode(): number {
    return this.line.codes[this.x] ?? 0
  }
}

class BufferLine {
  private readonly line: Line
  constructor(line: Line) {
    this.line = line
  }
  get isWrapped(): boolean {
    return this.line.wrapped
  }
  get length(): number {
    return this.line.cols
  }
  getCell(x: number): BufferCell | undefined {
    return x >= 0 && x < this.line.cols ? new BufferCell(this.line, x) : undefined
  }
  /** Empty cells read as spaces, the trailing half of a wide character as nothing. */
  translateToString(trimRight = false, startColumn = 0, endColumn = this.line.cols): string {
    const text = lineText(this.line, startColumn, endColumn)
    return trimRight ? text.replace(/\s+$/, '') : text
  }
}

class ActiveBuffer {
  private readonly nv: NvTerminal
  constructor(nv: NvTerminal) {
    this.nv = nv
  }
  private get buf() {
    return this.nv.core.active
  }
  get type(): 'normal' | 'alternate' {
    return this.buf === this.nv.core.normal ? 'normal' : 'alternate'
  }
  get cursorX(): number {
    return this.buf.x
  }
  get cursorY(): number {
    return this.buf.y
  }
  /** Absolute index of the top row of the screen (the scrollback length). */
  get baseY(): number {
    return this.buf.scrollbackLength
  }
  get viewportY(): number {
    return this.nv.viewportY
  }
  get length(): number {
    return this.buf.length
  }
  /** Line `y` counting from the oldest scrollback line. */
  getLine(y: number): BufferLine | undefined {
    const line = this.buf.absoluteLine(y)
    return line ? new BufferLine(line) : undefined
  }
}

export class Terminal {
  readonly nv: NvTerminal
  readonly options: CompatOptions
  readonly unicode = { activeVersion: '11' }
  readonly buffer: { readonly active: ActiveBuffer }
  readonly _core: {
    _renderService: { readonly dimensions: { css: { cell: { width: number; height: number } } }; clear(): void }
    _compositionHelper: { readonly isComposing: boolean; compositionend(): void }
  }

  private readonly addons: CompatAddon[] = []

  constructor(options: CompatOptions = {}) {
    const nv = new NvTerminal({
      cols: options.cols,
      rows: options.rows,
      fontFamily: options.fontFamily,
      fontSize: options.fontSize,
      lineHeight: options.lineHeight,
      cursorBlink: options.cursorBlink,
      convertEol: options.convertEol,
      scrollback: options.scrollback,
      minimumContrastRatio: options.minimumContrastRatio,
      theme: options.theme,
      macOptionIsMeta: options.macOptionIsMeta,
      macOptionClickForcesSelection: options.macOptionClickForcesSelection,
      // WebGL is switched on by loading WebglAddon, as with xterm.js.
      renderer: 'canvas',
    })
    this.nv = nv
    const store: CompatOptions = { ...options }
    this.options = new Proxy(store, {
      set: (target, key, value) => {
        target[key as string] = value
        if (typeof key === 'string' && LIVE_OPTIONS.has(key)) nv.setOption(key as never, value as never)
        return true
      },
    })
    const active = new ActiveBuffer(nv)
    this.buffer = { active }
    this._core = {
      _renderService: {
        get dimensions() {
          const d = nv.cellDimensions
          return { css: { cell: { width: d.width, height: d.height } } }
        },
        // nvterm keeps no render cache that a resize must drop.
        clear() {},
      },
      _compositionHelper: {
        get isComposing() {
          return nv.isComposing
        },
        compositionend() {
          nv.endComposition()
        },
      },
    }
  }

  get cols(): number {
    return this.nv.cols
  }
  get rows(): number {
    return this.nv.rows
  }
  get element(): HTMLElement | undefined {
    return this.nv.element
  }
  get textarea(): HTMLTextAreaElement | undefined {
    return this.nv.textarea
  }
  get modes() {
    const m = this.nv.core.modes
    return {
      applicationCursorKeysMode: m.applicationCursorKeys,
      applicationKeypadMode: m.applicationKeypad,
      bracketedPasteMode: m.bracketedPaste,
      insertMode: m.insert,
      mouseTrackingMode: m.mouseTracking,
      originMode: m.origin,
      reverseWraparoundMode: m.reverseWraparound,
      sendFocusMode: m.sendFocus,
      wraparoundMode: m.autowrap,
    }
  }

  get onData() { return this.nv.onData }
  get onResize() { return this.nv.onResize }
  get onSelectionChange() { return this.nv.onSelectionChange }
  get onTitleChange() { return this.nv.onTitleChange }
  get onBell() { return this.nv.onBell }
  get onRender() {
    return (listener: (e: { start: number; end: number }) => void): IDisposable =>
      this.nv.onRender(() => listener({ start: 0, end: this.nv.rows - 1 }))
  }

  open(parent: HTMLElement): void {
    this.nv.open(parent)
    // Class names Navide queries for geometry and focus checks. Only these
    // two: the `.xterm` root class would pull in xterm.css rules.
    this.nv.element?.classList.add('xterm-screen')
    this.nv.textarea?.classList.add('xterm-helper-textarea')
  }

  loadAddon(addon: CompatAddon): void {
    addon.activate(this)
    this.addons.push(addon)
  }

  write(data: string | Uint8Array, callback?: () => void): void { this.nv.write(data, callback) }
  writeln(data: string, callback?: () => void): void { this.nv.writeln(data, callback) }
  resize(cols: number, rows: number): void { this.nv.resize(cols, rows) }
  focus(): void { this.nv.focus() }
  blur(): void { this.nv.blur() }
  refresh(): void { this.nv.refresh() }
  paste(text: string): void { this.nv.paste(text) }
  select(column: number, row: number, length: number): void { this.nv.select(column, row, length) }
  selectAll(): void { this.nv.selectAll() }
  clearSelection(): void { this.nv.clearSelection() }
  hasSelection(): boolean { return this.nv.hasSelection() }
  getSelection(): string { return this.nv.getSelection() }
  scrollLines(amount: number): void { this.nv.scrollLines(amount) }
  scrollToBottom(): void { this.nv.scrollToBottom() }
  scrollToTop(): void { this.nv.scrollToTop() }
  attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void { this.nv.attachCustomKeyEventHandler(handler) }
  attachCustomWheelEventHandler(handler: (e: WheelEvent) => boolean): void { this.nv.attachCustomWheelEventHandler(handler) }
  registerLinkProvider(provider: LinkProvider): IDisposable { return this.nv.registerLinkProvider(provider) }
  /** Full reset (RIS): screen, scrollback and modes. */
  reset(): void { this.nv.write('\x1bc') }
  /** Keeps only the cursor's line, at the top; drops the scrollback. */
  clear(): void { this.nv.clear() }

  dispose(): void {
    for (const addon of this.addons.splice(0)) {
      try { addon.dispose() } catch { /* already disposed */ }
    }
    this.nv.dispose()
  }
}

export class FitAddon implements CompatAddon {
  private terminal: Terminal | undefined
  activate(terminal: Terminal): void { this.terminal = terminal }
  dispose(): void { this.terminal = undefined }
  fit(): void { this.terminal?.nv.fit() }
  proposeDimensions(): { cols: number; rows: number } | undefined { return this.terminal?.nv.proposeDimensions() }
}

export class SerializeAddon implements CompatAddon {
  private terminal: Terminal | undefined
  activate(terminal: Terminal): void { this.terminal = terminal }
  dispose(): void { this.terminal = undefined }
  serialize(options: SerializeOptions = {}): string {
    return this.terminal ? serialize(this.terminal.nv.core, options) : ''
  }
}

/** nvterm always measures with Unicode 11 tables; loading this changes nothing. */
export class Unicode11Addon implements CompatAddon {
  activate(): void {}
  dispose(): void {}
}

/** Loading switches the terminal to the WebGL2 renderer; disposing switches back to Canvas2D. */
export class WebglAddon implements CompatAddon {
  private terminal: Terminal | undefined
  private subscription: IDisposable | undefined
  private readonly lossListeners: (() => void)[] = []
  /** Mirrors the private hook Navide uses to stop a cursor-blink timer; nvterm has none to stop. */
  readonly _renderer = { handleBlur(): void {} }

  activate(terminal: Terminal): void {
    this.terminal = terminal
    terminal.nv.setOption('renderer', 'webgl')
    // Like xterm.js, a renderer that cannot start makes loadAddon throw.
    if (terminal.nv.rendererKind !== 'webgl') {
      terminal.nv.setOption('renderer', 'canvas')
      throw new Error('nvterm: WebGL2 is not available')
    }
    this.subscription = terminal.nv.onRendererChange((change) => {
      if (change.reason === 'context-lost') for (const l of [...this.lossListeners]) l()
    })
  }

  onContextLoss(listener: () => void): IDisposable {
    this.lossListeners.push(listener)
    return { dispose: () => { this.lossListeners.splice(this.lossListeners.indexOf(listener), 1) } }
  }

  dispose(): void {
    this.subscription?.dispose()
    this.subscription = undefined
    const terminal = this.terminal
    this.terminal = undefined
    if (terminal?.nv.element && terminal.nv.rendererKind === 'webgl') terminal.nv.setOption('renderer', 'canvas')
  }
}
