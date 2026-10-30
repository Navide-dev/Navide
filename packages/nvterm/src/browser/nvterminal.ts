// NvTerminal: the browser-facing terminal. Wires the headless core to a
// renderer and to keyboard, IME, paste, mouse, selection, scrolling and links.
import { TerminalCore } from '../terminal'
import { CanvasRenderer } from './canvasRenderer'
import type { CursorShape, Frame, Renderer } from './renderer'
import { Emitter, type IDisposable, type Link, type LinkProvider } from './events'
import { encodeKey } from './keyboard'
import { encodeMouse, type MouseReport } from './mouse'
import { lineText, Selection } from './selection'
import { findFrom, type SearchMatch, type SearchOptions } from '../search'
import { resolveTheme, type Theme } from './theme'
import { WebglRenderer } from './webglRenderer'

export type RendererKind = 'auto' | 'webgl' | 'canvas'
export interface RendererChange {
  kind: 'webgl' | 'canvas'
  reason: 'open' | 'requested' | 'context-lost' | 'released' | 'restored' | 'unavailable'
}

export interface NvTerminalOptions {
  cols?: number
  rows?: number
  fontFamily?: string
  fontSize?: number
  lineHeight?: number
  cursorBlink?: boolean
  cursorStyle?: CursorShape
  scrollback?: number
  theme?: Theme
  minimumContrastRatio?: number
  macOptionIsMeta?: boolean
  macOptionClickForcesSelection?: boolean
  /** Translate LF to CR LF on output. */
  convertEol?: boolean
  /** Opens OSC 8 hyperlinks. Without it, OSC 8 links are not clickable. */
  linkHandler?: { activate(event: MouseEvent, uri: string): void }
  /** 'auto' (default) uses WebGL2 when available and Canvas2D otherwise. */
  renderer?: RendererKind
}

type ResolvedOptions = Required<Omit<NvTerminalOptions, 'linkHandler' | 'theme'>> & Pick<NvTerminalOptions, 'linkHandler' | 'theme'>

const DEFAULTS: ResolvedOptions = {
  cols: 80,
  rows: 24,
  fontFamily: 'Menlo, Consolas, monospace',
  fontSize: 13,
  lineHeight: 1.2,
  cursorBlink: false,
  cursorStyle: 'block',
  scrollback: 1000,
  theme: undefined,
  minimumContrastRatio: 1,
  macOptionIsMeta: false,
  macOptionClickForcesSelection: false,
  convertEol: false,
  linkHandler: undefined,
  renderer: 'auto',
}

const BLINK_MS = 600
/** Longest a synchronized-output frame may hold back painting (mode 2026). */
const SYNC_TIMEOUT_MS = 1000

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

export class NvTerminal implements IDisposable {
  readonly core: TerminalCore
  element: HTMLDivElement | undefined
  textarea: HTMLTextAreaElement | undefined

  private readonly opts: ResolvedOptions
  private renderer: Renderer | undefined
  /** releaseGpu() was called and restoreGpu() has not been yet. */
  private gpuReleased = false
  private readonly selection: Selection
  /** Stable id (dropped + absolute index) of the top visible row; null = follow the bottom. */
  private viewportAnchor: number | null = null
  private renderQueued = false
  private syncSince = 0
  private focused = false
  private blinkOn = true
  private blinkTimer: ReturnType<typeof setInterval> | undefined
  private composing = false
  private composition = ''
  private mouseDown: { button: number; selecting: boolean; moved: boolean } | null = null
  private wheelRemainder = 0
  private customKeyHandler: ((e: KeyboardEvent) => boolean) | undefined
  private customWheelHandler: ((e: WheelEvent) => boolean) | undefined
  private readonly linkProviders: LinkProvider[] = []
  private hover: { stableY: number; link: Link } | null = null
  private readonly listeners: [EventTarget, string, EventListener, AddEventListenerOptions?][] = []

  private readonly dataEmitter = new Emitter<string>()
  private readonly resizeEmitter = new Emitter<{ cols: number; rows: number }>()
  private readonly selectionEmitter = new Emitter<void>()
  private readonly titleEmitter = new Emitter<string>()
  private readonly bellEmitter = new Emitter<void>()
  private readonly renderEmitter = new Emitter<void>()
  private readonly rendererEmitter = new Emitter<RendererChange>()
  readonly onData = this.dataEmitter.event
  readonly onResize = this.resizeEmitter.event
  readonly onSelectionChange = this.selectionEmitter.event
  readonly onTitleChange = this.titleEmitter.event
  readonly onBell = this.bellEmitter.event
  /** Fires after each painted frame (tests and screenshot tools wait on it). */
  readonly onRender = this.renderEmitter.event
  /** The renderer changed: WebGL unavailable, context lost, released or restored. */
  readonly onRendererChange = this.rendererEmitter.event

  constructor(options: NvTerminalOptions = {}) {
    // Options given as undefined keep their defaults.
    const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined))
    this.opts = { ...DEFAULTS, ...given }
    this.core = new TerminalCore({
      cols: this.opts.cols,
      rows: this.opts.rows,
      scrollback: this.opts.scrollback,
      onResponse: (data) => this.dataEmitter.fire(data),
      onTitle: (title) => this.titleEmitter.fire(title),
      onBell: () => this.bellEmitter.fire(),
    })
    this.selection = new Selection(() => this.core.active)
    this.registerLinkProvider(this.osc8Links())
  }

  get cols(): number {
    return this.core.cols
  }

  get rows(): number {
    return this.core.rows
  }

  /** Absolute index of the top visible row (0 = oldest scrollback line). */
  get viewportY(): number {
    const buf = this.core.active
    if (this.viewportAnchor === null) return buf.scrollbackLength
    return Math.max(0, Math.min(buf.scrollbackLength, this.viewportAnchor - buf.dropped))
  }

  get cellDimensions(): { width: number; height: number; measured: boolean } {
    const m = this.renderer?.metrics
    return { width: m?.width ?? 0, height: m?.height ?? 0, measured: Boolean(m && m.width > 0) }
  }

  get rendererKind(): 'webgl' | 'canvas' | undefined {
    return this.renderer?.kind
  }

  /** An IME composition is open. */
  get isComposing(): boolean {
    return this.composing
  }

  /** Abandons an open IME composition (for a composition that never ended). */
  endComposition(): void {
    this.composing = false
    this.composition = ''
    if (this.textarea) this.textarea.value = ''
    this.queueRender()
  }

  /** Repaints on the next frame. */
  refresh(): void {
    this.queueRender()
  }

  /** Clears the scrollback and the screen except the cursor's line, which moves to the top. */
  clear(): void {
    this.core.clearToCursorLine()
    this.selection.clear()
    this.viewportAnchor = null
    this.queueRender()
  }

  get options(): Readonly<ResolvedOptions> {
    return this.opts
  }

  setOption<K extends keyof ResolvedOptions>(key: K, value: ResolvedOptions[K]): void {
    this.opts[key] = value
    if (key === 'cursorBlink') this.updateBlink()
    if (key === 'renderer' && this.renderer && !this.gpuReleased) this.installRenderer(value === 'canvas' ? 'canvas' : 'webgl', 'requested')
    if (this.renderer && (key === 'fontSize' || key === 'fontFamily' || key === 'lineHeight' || key === 'theme' || key === 'minimumContrastRatio')) {
      this.renderer.setOptions(this.rendererOptions())
    }
    this.queueRender()
  }

  open(parent: HTMLElement): void {
    const doc = parent.ownerDocument
    const element = doc.createElement('div')
    element.className = 'nvterm'
    element.style.position = 'relative'
    element.style.overflow = 'hidden'
    element.style.outline = 'none'
    const textarea = doc.createElement('textarea')
    textarea.className = 'nvterm-input'
    textarea.setAttribute('autocorrect', 'off')
    textarea.setAttribute('autocapitalize', 'off')
    textarea.setAttribute('spellcheck', 'false')
    textarea.setAttribute('aria-label', 'Terminal input')
    Object.assign(textarea.style, {
      position: 'absolute', left: '0', top: '0', width: '1px', height: '1px', opacity: '0',
      padding: '0', border: '0', resize: 'none', overflow: 'hidden', whiteSpace: 'nowrap', zIndex: '-1',
    })
    element.append(textarea)
    parent.append(element)
    this.element = element
    this.textarea = textarea
    this.installRenderer(this.opts.renderer === 'canvas' ? 'canvas' : 'webgl', 'open')
    this.bindInput(textarea)
    this.bindMouse(element)
    this.queueRender()
  }

  write(data: string | Uint8Array, callback?: () => void): void {
    this.core.write(this.opts.convertEol ? convertEol(data) : data)
    this.queueRender()
    if (callback) queueMicrotask(callback)
  }

  writeln(data: string, callback?: () => void): void {
    this.write(`${data}\r\n`, callback)
  }

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return
    this.core.resize(cols, rows)
    this.renderer?.resize(cols, rows)
    this.resizeEmitter.fire({ cols, rows })
    this.queueRender()
  }

  /** The size that fills the parent element, or undefined before open(). */
  proposeDimensions(): { cols: number; rows: number } | undefined {
    const parent = this.element?.parentElement
    const m = this.renderer?.metrics
    if (!parent || !m || !m.width || !m.height) return undefined
    return {
      cols: Math.max(2, Math.floor(parent.clientWidth / m.width)),
      rows: Math.max(1, Math.floor(parent.clientHeight / m.height)),
    }
  }

  fit(): void {
    const dims = this.proposeDimensions()
    if (dims) this.resize(dims.cols, dims.rows)
  }

  focus(): void {
    this.textarea?.focus()
  }

  blur(): void {
    this.textarea?.blur()
  }

  attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void {
    this.customKeyHandler = handler
  }

  attachCustomWheelEventHandler(handler: (e: WheelEvent) => boolean): void {
    this.customWheelHandler = handler
  }

  registerLinkProvider(provider: LinkProvider): IDisposable {
    this.linkProviders.push(provider)
    return { dispose: () => { this.linkProviders.splice(this.linkProviders.indexOf(provider), 1) } }
  }

  /** Sends text as if pasted: CR line endings, bracketed when the application asked for it. */
  paste(text: string): void {
    let data = text.replace(/\r?\n/g, '\r')
    if (this.core.modes.bracketedPaste) data = `\x1b[200~${data.replace(/\x1b\[201~/g, '')}\x1b[201~`
    this.scrollToBottom()
    this.dataEmitter.fire(data)
  }

  scrollLines(amount: number): void {
    const buf = this.core.active
    const top = Math.max(0, Math.min(buf.scrollbackLength, this.viewportY + amount))
    this.viewportAnchor = top >= buf.scrollbackLength ? null : buf.dropped + top
    this.queueRender()
  }

  scrollToBottom(): void {
    if (this.viewportAnchor === null) return
    this.viewportAnchor = null
    this.queueRender()
  }

  scrollToTop(): void {
    this.scrollLines(-this.viewportY)
  }

  select(column: number, row: number, length: number): void {
    this.selection.select(column, row, length)
    this.selectionChanged()
  }

  selectAll(): void {
    this.selection.selectAll()
    this.selectionChanged()
  }

  clearSelection(): void {
    if (!this.selection.active) return
    this.selection.clear()
    this.selectionChanged()
  }

  hasSelection(): boolean {
    return this.selection.active
  }

  getSelection(): string {
    return this.selection.text()
  }

  /**
   * Gives the GPU back while the terminal is off screen: the WebGL renderer
   * and its atlas are destroyed and its context released; Canvas2D draws
   * until restoreGpu(). Does nothing on the Canvas2D renderer.
   */
  releaseGpu(): void {
    if (this.gpuReleased) return
    this.gpuReleased = true
    if (this.renderer?.kind === 'webgl') this.installRenderer('canvas', 'released')
  }

  /** Undoes releaseGpu(): back to WebGL unless the renderer option says Canvas2D. */
  restoreGpu(): void {
    if (!this.gpuReleased) return
    this.gpuReleased = false
    if (this.opts.renderer !== 'canvas' && this.element) this.installRenderer('webgl', 'restored')
  }

  /** Selects the next match after the current selection (or the top of the screen) and scrolls to it. */
  findNext(query: string, options: SearchOptions = {}): boolean {
    return this.find(query, false, options)
  }

  /** Selects the previous match before the current selection and scrolls to it. */
  findPrevious(query: string, options: SearchOptions = {}): boolean {
    return this.find(query, true, options)
  }

  private find(query: string, backwards: boolean, options: SearchOptions): boolean {
    const buf = this.core.active
    const range = this.selection.range()
    const from = range ? { x: range.start.x, y: range.start.y - buf.dropped } : { x: -1, y: this.viewportY }
    const match = findFrom(buf, query, from, backwards, options)
    if (!match) return false
    this.selectMatch(match)
    return true
  }

  private selectMatch(match: SearchMatch): void {
    const buf = this.core.active
    this.selection.start({ x: match.x, y: buf.dropped + match.y }, 'char')
    this.selection.extend({ x: match.endX, y: buf.dropped + match.endY })
    // Bring the match into view, roughly centred, if it is off screen.
    const top = this.viewportY
    if (match.y < top || match.endY >= top + this.rows) this.scrollLines(match.y - Math.floor(this.rows / 2) - top)
    this.selectionChanged()
  }

  dispose(): void {
    for (const [target, type, listener, options] of this.listeners) target.removeEventListener(type, listener, options)
    this.listeners.length = 0
    if (this.blinkTimer) clearInterval(this.blinkTimer)
    this.blinkTimer = undefined
    this.retireRenderer()
    this.element?.remove()
    this.element = undefined
    this.textarea = undefined
    for (const e of [this.dataEmitter, this.resizeEmitter, this.selectionEmitter, this.titleEmitter, this.bellEmitter, this.renderEmitter, this.rendererEmitter]) e.clear()
  }

  // ---- Rendering ------------------------------------------------------------

  /** Replaces the renderer (and its canvas element). WebGL falls back to Canvas2D when it cannot start. */
  private installRenderer(want: 'webgl' | 'canvas', reason: RendererChange['reason']): void {
    const element = this.element
    if (!element) return
    const canvas = element.ownerDocument.createElement('canvas')
    canvas.className = 'nvterm-screen'
    canvas.style.display = 'block'
    let next: Renderer
    let why = reason
    if (want === 'webgl') {
      try {
        next = new WebglRenderer(canvas, this.rendererOptions())
        canvas.addEventListener('webglcontextlost', (e) => {
          e.preventDefault()
          if (this.renderer?.canvas === canvas) this.installRenderer('canvas', 'context-lost')
        })
      } catch {
        next = new CanvasRenderer(canvas, this.rendererOptions())
        why = 'unavailable'
      }
    } else {
      next = new CanvasRenderer(canvas, this.rendererOptions())
    }
    next.resize(this.cols, this.rows)
    const prev = this.renderer
    if (prev) prev.canvas.replaceWith(canvas)
    else element.prepend(canvas)
    this.renderer = next
    if (prev) this.retire(prev, reason === 'context-lost')
    this.rendererEmitter.fire({ kind: next.kind, reason: why })
    this.queueRender()
  }

  private retireRenderer(): void {
    if (this.renderer) this.retire(this.renderer, false)
    this.renderer = undefined
  }

  /** Disposes a renderer; a WebGL one also releases its context unless it is already lost. */
  private retire(renderer: Renderer, contextLost: boolean): void {
    renderer.dispose()
    if (renderer.kind === 'webgl' && !contextLost) {
      const gl = renderer.canvas.getContext('webgl2')
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
    }
    renderer.canvas.remove()
  }

  private rendererOptions() {
    return {
      fontFamily: this.opts.fontFamily,
      fontSize: this.opts.fontSize,
      lineHeight: this.opts.lineHeight,
      minimumContrastRatio: this.opts.minimumContrastRatio,
      colors: resolveTheme(this.opts.theme),
      devicePixelRatio: (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
    }
  }

  private queueRender(): void {
    if (this.renderQueued || !this.renderer) return
    this.renderQueued = true
    requestAnimationFrame(() => {
      this.renderQueued = false
      this.renderNow()
    })
  }

  private renderNow(): void {
    const renderer = this.renderer
    if (!renderer) return
    // Synchronized output: hold the frame until the application ends it (or a timeout).
    if (this.core.modes.synchronizedOutput) {
      const now = performance.now()
      if (!this.syncSince) this.syncSince = now
      if (now - this.syncSince < SYNC_TIMEOUT_MS) {
        this.queueRender()
        return
      }
    }
    this.syncSince = 0
    const buf = this.core.active
    const top = this.viewportY
    const cursorRow = buf.scrollbackLength + buf.y - top
    const range = this.selection.range()
    const frame: Frame = {
      buffer: buf,
      style: (id) => this.core.style(id),
      viewportTop: top,
      cursor: cursorRow >= 0 && cursorRow < this.rows
        ? {
          x: buf.x,
          row: cursorRow,
          shape: cursorShape(this.core.cursorStyle, this.opts.cursorStyle),
          focused: this.focused,
          visible: this.core.modes.cursorVisible && (!this.opts.cursorBlink || !this.focused || this.blinkOn),
        }
        : null,
      isSelected: range ? (x, y) => this.selection.contains(x, y, range) : null,
      linkUnderlines: this.hover ? linkUnderlines(this.hover.link, buf.dropped) : null,
      reverseVideo: this.core.modes.reverseVideo,
      composition: this.composition,
    }
    renderer.render(frame)
    this.placeTextarea(cursorRow, buf.x)
    this.renderEmitter.fire()
  }

  /** Keeps the hidden textarea at the cursor so IME candidate windows open there. */
  private placeTextarea(row: number, x: number): void {
    const m = this.renderer?.metrics
    if (!this.textarea || !m) return
    this.textarea.style.left = `${Math.min(x, this.cols - 1) * m.width}px`
    this.textarea.style.top = `${Math.max(0, Math.min(row, this.rows - 1)) * m.height}px`
    this.textarea.style.height = `${m.height}px`
    this.textarea.style.lineHeight = `${m.height}px`
    this.textarea.style.fontSize = `${this.opts.fontSize}px`
  }

  private updateBlink(): void {
    if (this.blinkTimer) clearInterval(this.blinkTimer)
    this.blinkTimer = undefined
    this.blinkOn = true
    if (this.opts.cursorBlink && this.focused) {
      this.blinkTimer = setInterval(() => {
        this.blinkOn = !this.blinkOn
        this.queueRender()
      }, BLINK_MS)
    }
    this.queueRender()
  }

  // ---- Keyboard, IME, paste, focus ----------------------------------------

  private on<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, listener: (e: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions): void {
    target.addEventListener(type, listener as EventListener, options)
    this.listeners.push([target, type, listener as EventListener, options])
  }

  private bindInput(textarea: HTMLTextAreaElement): void {
    this.on(textarea, 'keydown', (e) => {
      if (this.customKeyHandler && this.customKeyHandler(e) === false) return
      if (this.composing || e.isComposing || e.keyCode === 229) return
      const data = encodeKey(e, {
        applicationCursorKeys: this.core.modes.applicationCursorKeys,
        applicationKeypad: this.core.modes.applicationKeypad,
        isMac,
        macOptionIsMeta: this.opts.macOptionIsMeta,
      })
      if (data === undefined) return
      e.preventDefault()
      this.input(data)
    })
    this.on(textarea, 'input', (e) => {
      const ev = e as InputEvent
      if (this.composing || ev.isComposing) return
      if (ev.inputType === 'insertText' && ev.data) this.input(ev.data)
      textarea.value = ''
    })
    this.on(textarea, 'compositionstart', () => {
      this.composing = true
      this.composition = ''
    })
    this.on(textarea, 'compositionupdate', (e) => {
      this.composition = e.data
      this.queueRender()
    })
    this.on(textarea, 'compositionend', (e) => {
      this.composing = false
      this.composition = ''
      if (e.data) this.input(e.data)
      textarea.value = ''
      this.queueRender()
    })
    this.on(textarea, 'paste', (e) => {
      e.preventDefault()
      const text = e.clipboardData?.getData('text/plain')
      if (text) this.paste(text)
    })
    this.on(textarea, 'copy', (e) => {
      if (!this.selection.active) return
      e.preventDefault()
      e.clipboardData?.setData('text/plain', this.getSelection())
    })
    this.on(textarea, 'focus', () => {
      this.focused = true
      if (this.core.modes.sendFocus) this.dataEmitter.fire('\x1b[I')
      this.updateBlink()
    })
    this.on(textarea, 'blur', () => {
      this.focused = false
      if (this.core.modes.sendFocus) this.dataEmitter.fire('\x1b[O')
      this.updateBlink()
    })
  }

  /** Data typed by the user. */
  private input(data: string): void {
    this.scrollToBottom()
    this.dataEmitter.fire(data)
  }

  // ---- Mouse, selection, wheel, links ---------------------------------------

  private cellAt(e: MouseEvent): { col: number; row: number; x: number; y: number } {
    const rect = this.element!.getBoundingClientRect()
    const m = this.renderer!.metrics
    const x = Math.max(0, e.clientX - rect.left)
    const y = Math.max(0, e.clientY - rect.top)
    return {
      col: Math.max(0, Math.min(this.cols - 1, Math.floor(x / m.width))),
      row: Math.max(0, Math.min(this.rows - 1, Math.floor(y / m.height))),
      x: Math.floor(x),
      y: Math.floor(y),
    }
  }

  /** Whether this mouse event goes to the application rather than to selection. */
  private reportsMouse(e: MouseEvent): boolean {
    if (this.core.modes.mouseTracking === 'none' || e.shiftKey) return false
    if (isMac && e.altKey && this.opts.macOptionClickForcesSelection) return false
    return true
  }

  private report(e: MouseEvent, action: MouseReport['action'], button: number, wheel?: 'up' | 'down'): boolean {
    const cell = this.cellAt(e)
    const data = encodeMouse({ action, button, wheel, ...cell, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey }, this.core.modes.mouseTracking, this.core.modes.mouseEncoding)
    if (data) this.dataEmitter.fire(data)
    return data !== undefined
  }

  private stablePos(e: MouseEvent): { x: number; y: number } {
    const cell = this.cellAt(e)
    const m = this.renderer!.metrics
    // Clicking the right half of a cell selects up to the next boundary.
    const rect = this.element!.getBoundingClientRect()
    const fraction = (e.clientX - rect.left) / m.width - cell.col
    return { x: cell.col + (fraction > 0.5 ? 1 : 0), y: this.core.active.dropped + this.viewportY + cell.row }
  }

  private bindMouse(element: HTMLElement): void {
    const doc = element.ownerDocument
    this.on(element, 'mousedown', (e) => {
      if (e.button > 2) return
      e.preventDefault()
      this.focus()
      if (this.reportsMouse(e)) {
        this.report(e, 'down', e.button)
        this.mouseDown = { button: e.button, selecting: false, moved: false }
        return
      }
      if (e.button !== 0) return
      const pos = this.stablePos(e)
      if (e.shiftKey && this.selection.active) this.selection.extend(pos)
      else this.selection.start(pos, e.detail >= 3 ? 'line' : e.detail === 2 ? 'word' : 'char')
      this.mouseDown = { button: 0, selecting: true, moved: false }
      if (e.detail >= 2) this.selectionChanged()
      this.queueRender()
    })
    const onMove = (e: MouseEvent): void => {
      const down = this.mouseDown
      if (down && !down.selecting) {
        down.moved = true
        this.report(e, 'move', down.button)
        return
      }
      if (down?.selecting) {
        down.moved = true
        this.selection.extend(this.stablePos(e))
        this.queueRender()
        return
      }
      if (e.target === element || element.contains(e.target as Node)) {
        if (this.reportsMouse(e) && this.core.modes.mouseTracking === 'any') this.report(e, 'move', -1)
        this.updateHover(e)
      }
    }
    const onUp = (e: MouseEvent): void => {
      const down = this.mouseDown
      if (!down) return
      this.mouseDown = null
      if (!down.selecting) {
        this.report(e, 'up', down.button)
        return
      }
      if (down.moved) this.selectionChanged()
      else if (e.detail < 2) {
        const hadSelection = this.selection.active
        this.selection.clear()
        if (hadSelection) this.selectionChanged()
        if (this.hover) this.hover.link.activate(e, this.hover.link.text)
      }
      this.queueRender()
    }
    this.listeners.push([doc, 'mousemove', onMove as EventListener], [doc, 'mouseup', onUp as EventListener])
    doc.addEventListener('mousemove', onMove)
    doc.addEventListener('mouseup', onUp)
    this.on(element, 'wheel', (e) => {
      if (this.customWheelHandler && this.customWheelHandler(e) === false) return
      e.preventDefault()
      const m = this.renderer!.metrics
      const pixels = e.deltaMode === 1 ? e.deltaY * m.height : e.deltaMode === 2 ? e.deltaY * m.height * this.rows : e.deltaY
      this.wheelRemainder += pixels / m.height
      const lines = Math.trunc(this.wheelRemainder)
      if (!lines) return
      this.wheelRemainder -= lines
      if (this.reportsMouse(e)) {
        for (let i = 0; i < Math.abs(lines); i++) this.report(e, 'wheel', 0, lines < 0 ? 'up' : 'down')
        return
      }
      if (this.core.active === this.core.normal) this.scrollLines(lines)
    }, { passive: false })
    this.on(element, 'mouseleave', (e) => this.setHover(null, e))
  }

  private updateHover(e: MouseEvent): void {
    const cell = this.cellAt(e)
    const abs = this.viewportY + cell.row
    const stableY = this.core.active.dropped + abs
    let pending = this.linkProviders.length
    let found: Link | null = null
    const done = (): void => {
      if (--pending > 0) return
      this.setHover(found ? { stableY, link: found } : null, e)
    }
    if (!pending) return this.setHover(null, e)
    for (const provider of this.linkProviders) {
      provider.provideLinks(abs + 1, (links) => {
        if (!found && links) {
          found = links.find((l) => contains(l, cell.col + 1, abs + 1)) ?? null
        }
        done()
      })
    }
  }

  private setHover(next: { stableY: number; link: Link } | null, e: MouseEvent): void {
    const prev = this.hover
    if (prev?.link === next?.link || (prev && next && sameLink(prev.link, next.link))) return
    if (prev) prev.link.leave?.(e, prev.link.text)
    this.hover = next
    if (next) next.link.hover?.(e, next.link.text)
    if (this.element) this.element.style.cursor = next ? 'pointer' : ''
    this.queueRender()
  }

  /** Links from OSC 8 hyperlinks stored in the cells' styles. */
  private osc8Links(): LinkProvider {
    return {
      provideLinks: (bufferLineNumber, callback) => {
        const line = this.core.active.absoluteLine(bufferLineNumber - 1)
        const handler = this.opts.linkHandler
        if (!line || !handler) return callback(undefined)
        const links: Link[] = []
        let start = -1
        let id = 0
        for (let x = 0; x <= line.cols; x++) {
          const linkId = x < line.cols ? this.core.style(line.styles[x]!).link : 0
          if (linkId !== id) {
            if (id) {
              const uri = this.core.linkUri(id)
              links.push({
                range: { start: { x: start + 1, y: bufferLineNumber }, end: { x, y: bufferLineNumber } },
                text: lineText(line, start, x),
                activate: (event) => handler.activate(event, uri),
              })
            }
            id = linkId
            start = x
          }
        }
        callback(links.length ? links : undefined)
      },
    }
  }

  private selectionChanged(): void {
    this.selectionEmitter.fire()
    this.queueRender()
  }
}

function cursorShape(decscusr: number, fallback: CursorShape): CursorShape {
  // DECSCUSR: 1-2 block, 3-4 underline, 5-6 bar; 0 = the configured default.
  if (decscusr === 1 || decscusr === 2) return 'block'
  if (decscusr === 3 || decscusr === 4) return 'underline'
  if (decscusr === 5 || decscusr === 6) return 'bar'
  return fallback
}

function contains(link: Link, x: number, y: number): boolean {
  const { start, end } = link.range
  if (y < start.y || y > end.y) return false
  if (y === start.y && x < start.x) return false
  if (y === end.y && x > end.x) return false
  return true
}

function sameLink(a: Link, b: Link): boolean {
  return a.text === b.text && a.range.start.x === b.range.start.x && a.range.start.y === b.range.start.y && a.range.end.x === b.range.end.x
}

function linkUnderlines(link: Link, dropped: number): Map<number, [number, number][]> {
  const map = new Map<number, [number, number][]>()
  const { start, end } = link.range
  for (let y = start.y; y <= end.y; y++) {
    const from = y === start.y ? start.x - 1 : 0
    const to = y === end.y ? end.x : Number.MAX_SAFE_INTEGER
    map.set(dropped + y - 1, [[from, to]])
  }
  return map
}

function convertEol(data: string | Uint8Array): string | Uint8Array {
  if (typeof data === 'string') return data.replace(/\r?\n/g, '\r\n')
  let extra = 0
  for (let i = 0; i < data.length; i++) if (data[i] === 0x0a && data[i - 1] !== 0x0d) extra++
  if (!extra) return data
  const out = new Uint8Array(data.length + extra)
  let j = 0
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0a && data[i - 1] !== 0x0d) out[j++] = 0x0d
    out[j++] = data[i]!
  }
  return out
}
