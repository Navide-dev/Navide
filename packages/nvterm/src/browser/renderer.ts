// What every renderer shares: options, cell metrics, the frame it draws and
// colour resolution, so the Canvas2D and WebGL2 renderers paint the same thing.
import type { Buffer } from '../buffer'
import { CellFlag } from '../snapshot'
import type { Style } from '../style'
import { cellColor, ensureContrast, type ResolvedColors } from './theme'

export interface RendererOptions {
  fontFamily: string
  fontSize: number
  /** Multiplier on the font size for the row height. */
  lineHeight: number
  minimumContrastRatio: number
  colors: ResolvedColors
  devicePixelRatio: number
}

export interface CellMetrics {
  /** CSS pixels. */
  width: number
  height: number
  baseline: number
}

export type CursorShape = 'block' | 'underline' | 'bar'

export interface Frame {
  buffer: Buffer
  style: (id: number) => Readonly<Style>
  /** Absolute index of the first visible row. */
  viewportTop: number
  cursor: { x: number; row: number; shape: CursorShape; focused: boolean; visible: boolean } | null
  /** Selected cells: returns true for (x, stable line id). */
  isSelected: ((x: number, stableY: number) => boolean) | null
  /** Cell ranges to underline as links: stable line id -> [startX, endX) pairs. */
  linkUnderlines: Map<number, [number, number][]> | null
  reverseVideo: boolean
  /** IME composition text drawn at the cursor. */
  composition: string
}

export interface Renderer {
  readonly kind: 'canvas' | 'webgl'
  readonly canvas: HTMLCanvasElement
  metrics: CellMetrics
  setOptions(options: RendererOptions): void
  measure(): CellMetrics
  resize(cols: number, rows: number): void
  render(frame: Frame): void
  dispose(): void
}

/** Measures one cell of the configured monospace font, rounded to device pixels. */
export function measureCell(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, options: RendererOptions): CellMetrics {
  const { fontSize, fontFamily, lineHeight, devicePixelRatio: dpr } = options
  ctx.font = `${fontSize}px ${fontFamily}`
  const m = ctx.measureText('W')
  const ascent = m.actualBoundingBoxAscent || fontSize * 0.8
  const descent = m.actualBoundingBoxDescent || fontSize * 0.2
  const width = Math.max(1, Math.round(m.width * dpr)) / dpr
  const height = Math.max(1, Math.ceil(fontSize * lineHeight * dpr)) / dpr
  const baseline = Math.round(((height - (ascent + descent)) / 2 + ascent) * dpr) / dpr
  return { width, height, baseline }
}

/** Effective [fg, bg] after defaults, inverse and minimum contrast. */
export function cellColors(s: Readonly<Style>, defaultFg: number, defaultBg: number, options: RendererOptions): [number, number] {
  let fg = cellColor(s.fg, options.colors, defaultFg)
  let bg = cellColor(s.bg, options.colors, defaultBg)
  if (s.flags & CellFlag.Inverse) [fg, bg] = [bg, fg]
  return [ensureContrast(fg, bg, options.minimumContrastRatio), bg]
}

export function fontString(flags: number, options: RendererOptions): string {
  return `${flags & CellFlag.Italic ? 'italic ' : ''}${flags & CellFlag.Bold ? 'bold ' : ''}${options.fontSize}px ${options.fontFamily}`
}

/** Underline styles 1 single, 2 double, 3 curly, 4 dotted, 5 dashed, drawn with their top at `base`. */
export function strokeUnderline(ctx: CanvasRenderingContext2D, color: string, x: number, base: number, w: number, style: number): void {
  ctx.fillStyle = color
  ctx.strokeStyle = color
  switch (style) {
    case 2:
      ctx.fillRect(x, base - 2, w, 1)
      ctx.fillRect(x, base, w, 1)
      break
    case 3: {
      ctx.beginPath()
      ctx.lineWidth = 1
      for (let i = 0; i <= w; i += 2) {
        const yy = base - 1 + Math.sin((i / w) * Math.PI * 2) * 1.5
        if (i === 0) ctx.moveTo(x + i, yy)
        else ctx.lineTo(x + i, yy)
      }
      ctx.stroke()
      break
    }
    case 4:
      for (let i = 0; i < w; i += 2) ctx.fillRect(x + i, base, 1, 1)
      break
    case 5:
      for (let i = 0; i < w; i += 4) ctx.fillRect(x + i, base, Math.min(2, w - i), 1)
      break
    default:
      ctx.fillRect(x, base, w, 1)
  }
}
