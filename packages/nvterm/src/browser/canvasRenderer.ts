// Canvas2D renderer: draws the visible rows of a buffer, the selection, link
// underlines and the cursor. It is the fallback renderer; the WebGL2
// renderer (M3) draws the same frame.
import { WIDTH_TRAILING, WIDTH_WIDE } from '../buffer'
import { CellFlag } from '../snapshot'
import type { Style } from '../style'
import { cellColors, fontString, measureCell, strokeUnderline, type CellMetrics, type Frame, type Renderer, type RendererOptions } from './renderer'
import { cellColor, cssColor } from './theme'

const CURSOR_THICKNESS = 2

export class CanvasRenderer implements Renderer {
  readonly kind = 'canvas'
  readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private options: RendererOptions
  metrics: CellMetrics = { width: 0, height: 0, baseline: 0 }
  private cols = 0
  private rows = 0
  private readonly fonts = new Map<number, string>()
  /** Measured advance of wide glyphs per font, for centring them in their two cells. */
  private readonly wideWidths = new Map<string, number>()

  constructor(canvas: HTMLCanvasElement, options: RendererOptions) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) throw new Error('nvterm: Canvas2D is not available')
    this.ctx = ctx
    this.options = options
    this.measure()
  }

  setOptions(options: RendererOptions): void {
    this.options = options
    this.fonts.clear()
    this.wideWidths.clear()
    this.measure()
    this.resize(this.cols, this.rows)
  }

  measure(): CellMetrics {
    this.metrics = measureCell(this.ctx, this.options)
    return this.metrics
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    const dpr = this.options.devicePixelRatio
    const w = cols * this.metrics.width
    const h = rows * this.metrics.height
    this.canvas.width = Math.round(w * dpr)
    this.canvas.height = Math.round(h * dpr)
    this.canvas.style.width = `${w}px`
    this.canvas.style.height = `${h}px`
  }

  dispose(): void {}

  render(frame: Frame): void {
    const { ctx } = this
    const { colors, devicePixelRatio: dpr } = this.options
    const { width: cw, height: ch } = this.metrics
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.textBaseline = 'alphabetic'
    const defaultFg = frame.reverseVideo ? colors.background : colors.foreground
    const defaultBg = frame.reverseVideo ? colors.foreground : colors.background
    const buf = frame.buffer

    ctx.clearRect(0, 0, this.cols * cw, this.rows * ch)
    if (colors.backgroundAlpha > 0) {
      ctx.fillStyle = cssColor(defaultBg, colors.backgroundAlpha)
      ctx.fillRect(0, 0, this.cols * cw, this.rows * ch)
    }

    for (let row = 0; row < this.rows; row++) {
      const abs = frame.viewportTop + row
      const line = buf.absoluteLine(abs)
      if (!line) continue
      const stableY = buf.dropped + abs
      const y = row * ch
      const cols = Math.min(this.cols, line.cols)

      // Backgrounds and selection.
      for (let x = 0; x < cols; x++) {
        const s = frame.style(line.styles[x]!)
        const [, bg] = this.cellColors(s, defaultFg, defaultBg)
        if (bg !== defaultBg || s.flags & CellFlag.Inverse) {
          ctx.fillStyle = cssColor(bg)
          ctx.fillRect(x * cw, y, cw, ch)
        }
        if (frame.isSelected?.(x, stableY)) {
          ctx.fillStyle = cssColor(colors.selection, colors.selectionAlpha)
          ctx.fillRect(x * cw, y, cw, ch)
        }
      }

      // Glyphs and decorations.
      const links = frame.linkUnderlines?.get(stableY)
      for (let x = 0; x < cols; x++) {
        if (line.widths[x] === WIDTH_TRAILING) continue
        const s = frame.style(line.styles[x]!)
        const span = line.widths[x] === WIDTH_WIDE ? 2 : 1
        const [fg] = this.cellColors(s, defaultFg, defaultBg)
        const text = line.chars(x)
        if (text && !(s.flags & CellFlag.Invisible)) {
          ctx.font = this.font(s.flags)
          ctx.fillStyle = cssColor(fg, s.flags & CellFlag.Dim ? 0.5 : 1)
          ctx.fillText(text, x * cw + (span === 2 ? this.wideOffset(text, ctx.font) : 0), y + this.metrics.baseline)
        }
        this.decorate(s, fg, x * cw, y, span * cw)
        if (links?.some(([a, b]) => x >= a && x < b)) this.underline(fg, x * cw, y, span * cw, 1)
      }
    }

    if (frame.composition && frame.cursor) this.drawComposition(frame, defaultFg, defaultBg)
    else if (frame.cursor?.visible) this.drawCursor(frame)
  }

  private cellColors(s: Readonly<Style>, defaultFg: number, defaultBg: number): [number, number] {
    return cellColors(s, defaultFg, defaultBg, this.options)
  }

  /** Left offset that centres a wide glyph narrower than two cells. */
  private wideOffset(text: string, font: string): number {
    const key = `${font}|${text}`
    let w = this.wideWidths.get(key)
    if (w === undefined) {
      w = this.ctx.measureText(text).width
      if (this.wideWidths.size > 4096) this.wideWidths.clear()
      this.wideWidths.set(key, w)
    }
    return Math.max(0, (2 * this.metrics.width - w) / 2)
  }

  private font(flags: number): string {
    const key = flags & (CellFlag.Bold | CellFlag.Italic)
    let font = this.fonts.get(key)
    if (!font) {
      font = fontString(flags, this.options)
      this.fonts.set(key, font)
    }
    return font
  }

  private decorate(s: Readonly<Style>, fg: number, x: number, y: number, w: number): void {
    const { ctx } = this
    const { height: ch } = this.metrics
    if (s.flags & CellFlag.Underline) {
      const color = s.underlineColor ? cellColor(s.underlineColor, this.options.colors, fg) : fg
      this.underline(color, x, y, w, s.underlineStyle || 1)
    }
    if (s.flags & CellFlag.Strikethrough) {
      ctx.fillStyle = cssColor(fg)
      ctx.fillRect(x, y + Math.round(ch / 2), w, 1)
    }
    if (s.flags & CellFlag.Overline) {
      ctx.fillStyle = cssColor(fg)
      ctx.fillRect(x, y, w, 1)
    }
  }

  private underline(color: number, x: number, y: number, w: number, style: number): void {
    strokeUnderline(this.ctx, cssColor(color), x, y + this.metrics.height - 2, w, style)
  }

  private drawCursor(frame: Frame): void {
    const cursor = frame.cursor!
    const { ctx } = this
    const { colors } = this.options
    const { width: cw, height: ch } = this.metrics
    const line = frame.buffer.absoluteLine(frame.viewportTop + cursor.row)
    const x = Math.min(cursor.x, this.cols - 1)
    const span = line?.widths[x] === WIDTH_WIDE ? 2 : 1
    const px = x * cw
    const py = cursor.row * ch
    ctx.fillStyle = cssColor(colors.cursor)
    ctx.strokeStyle = cssColor(colors.cursor)
    if (!cursor.focused) {
      ctx.lineWidth = 1
      ctx.strokeRect(px + 0.5, py + 0.5, span * cw - 1, ch - 1)
      return
    }
    if (cursor.shape === 'underline') {
      ctx.fillRect(px, py + ch - CURSOR_THICKNESS, span * cw, CURSOR_THICKNESS)
      return
    }
    if (cursor.shape === 'bar') {
      ctx.fillRect(px, py, CURSOR_THICKNESS, ch)
      return
    }
    ctx.fillRect(px, py, span * cw, ch)
    const text = line?.chars(x)
    if (text) {
      const s = frame.style(line!.styles[x]!)
      ctx.font = this.font(s.flags)
      ctx.fillStyle = cssColor(colors.cursorAccent)
      ctx.fillText(text, px, py + this.metrics.baseline)
    }
  }

  /** The uncommitted IME text, drawn over the cells at the cursor with an underline. */
  private drawComposition(frame: Frame, defaultFg: number, defaultBg: number): void {
    const cursor = frame.cursor!
    const { ctx } = this
    const { width: cw, height: ch, baseline } = this.metrics
    const px = Math.min(cursor.x, this.cols - 1) * cw
    const py = cursor.row * ch
    ctx.font = this.font(0)
    const w = Math.max(cw, ctx.measureText(frame.composition).width)
    ctx.fillStyle = cssColor(defaultBg)
    ctx.fillRect(px, py, w, ch)
    ctx.fillStyle = cssColor(defaultFg)
    ctx.fillText(frame.composition, px, py + baseline)
    ctx.fillRect(px, py + ch - 2, w, 1)
  }
}
