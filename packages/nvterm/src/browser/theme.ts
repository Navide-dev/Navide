// Colours: theme, the 256-colour palette and contrast adjustment.
// Spec: xterm ctlseqs "256-color" palette layout (16 system colours, a
// 6x6x6 cube with levels 0, 95, 135, 175, 215, 255, then 24 greys from 8 in
// steps of 10); WCAG 2.1 relative luminance and contrast ratio.
import { DEFAULT_COLOR, PALETTE, RGB } from '../style.ts'

export interface Theme {
  foreground?: string
  background?: string
  cursor?: string
  cursorAccent?: string
  selectionBackground?: string
  black?: string
  red?: string
  green?: string
  yellow?: string
  blue?: string
  magenta?: string
  cyan?: string
  white?: string
  brightBlack?: string
  brightRed?: string
  brightGreen?: string
  brightYellow?: string
  brightBlue?: string
  brightMagenta?: string
  brightCyan?: string
  brightWhite?: string
}

const SYSTEM_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const

/** nvterm's own default system colours. */
const DEFAULT_SYSTEM = [
  0x1e1e1e, 0xd0453f, 0x4fa64a, 0xc9a227, 0x3b78d8, 0xa55dc9, 0x2aa1b3, 0xcfcfcf,
  0x6b6b6b, 0xf0605a, 0x6ccc66, 0xe8c547, 0x6098f0, 0xc483e6, 0x4cc4d6, 0xffffff,
]

/** A theme resolved to 0xRRGGBB numbers. */
export interface ResolvedColors {
  foreground: number
  background: number
  /** -1 means transparent background. */
  backgroundAlpha: number
  cursor: number
  cursorAccent: number
  selection: number
  selectionAlpha: number
  palette: Uint32Array
}

/** Parses '#rgb', '#rrggbb', '#rrggbbaa' and 'rgb()/rgba()'. Returns [0xRRGGBB, alpha 0-1] or undefined. */
export function parseColor(text: string | undefined): [number, number] | undefined {
  if (!text) return undefined
  const t = text.trim()
  let m = /^#([0-9a-f]{3})$/i.exec(t)
  if (m) {
    const [r, g, b] = m[1]!.split('').map((h) => parseInt(h + h, 16))
    return [(r! << 16) | (g! << 8) | b!, 1]
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(t)
  if (m) return [parseInt(m[1]!, 16), m[2] ? parseInt(m[2], 16) / 255 : 1]
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(t)
  if (m) return [(Number(m[1]) << 16) | (Number(m[2]) << 8) | Number(m[3]), m[4] === undefined ? 1 : Number(m[4])]
  return undefined
}

export function buildPalette(theme: Theme): Uint32Array {
  const palette = new Uint32Array(256)
  SYSTEM_KEYS.forEach((key, i) => {
    palette[i] = parseColor(theme[key])?.[0] ?? DEFAULT_SYSTEM[i]!
  })
  const levels = [0, 95, 135, 175, 215, 255]
  for (let i = 0; i < 216; i++) {
    palette[16 + i] = (levels[Math.floor(i / 36)]! << 16) | (levels[Math.floor(i / 6) % 6]! << 8) | levels[i % 6]!
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10
    palette[232 + i] = (v << 16) | (v << 8) | v
  }
  return palette
}

export function resolveTheme(theme: Theme = {}): ResolvedColors {
  const fg = parseColor(theme.foreground)?.[0] ?? 0xd4d4d4
  const bg = parseColor(theme.background) ?? [0x1e1e1e, 1]
  const selection = parseColor(theme.selectionBackground) ?? [0x5a8bd6, 0.4]
  return {
    foreground: fg,
    background: bg[0],
    backgroundAlpha: bg[1],
    cursor: parseColor(theme.cursor)?.[0] ?? fg,
    cursorAccent: parseColor(theme.cursorAccent)?.[0] ?? bg[0],
    selection: selection[0],
    selectionAlpha: selection[1] === 1 ? 0.4 : selection[1],
    palette: buildPalette(theme),
  }
}

/** A cell colour (style encoding) to 0xRRGGBB; `fallback` for the default colour. */
export function cellColor(color: number, colors: ResolvedColors, fallback: number): number {
  if (color === DEFAULT_COLOR) return fallback
  if ((color & RGB) === RGB) return color & 0xffffff
  if ((color & PALETTE) === PALETTE) return colors.palette[color & 0xff]!
  return fallback
}

export function cssColor(rgb: number, alpha = 1): string {
  if (alpha >= 1) return `#${rgb.toString(16).padStart(6, '0')}`
  return `rgba(${rgb >> 16},${(rgb >> 8) & 0xff},${rgb & 0xff},${alpha})`
}

function channel(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/** WCAG 2.1 relative luminance. */
export function luminance(rgb: number): number {
  return 0.2126 * channel(rgb >> 16) + 0.7152 * channel((rgb >> 8) & 0xff) + 0.0722 * channel(rgb & 0xff)
}

export function contrastRatio(a: number, b: number): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * Moves `fg` towards white or black (whichever direction can reach the
 * ratio, preferring away from `bg`) until it contrasts with `bg` by at least
 * `ratio`. Ratio 1 disables the adjustment.
 */
export function ensureContrast(fg: number, bg: number, ratio: number): number {
  if (ratio <= 1 || contrastRatio(fg, bg) >= ratio) return fg
  const towardsWhite = luminance(bg) < 0.5
  const mix = (t: number, target: number): number => {
    const r = Math.round((fg >> 16) + ((target >> 16) - (fg >> 16)) * t)
    const g = Math.round(((fg >> 8) & 0xff) + (((target >> 8) & 0xff) - ((fg >> 8) & 0xff)) * t)
    const b = Math.round((fg & 0xff) + ((target & 0xff) - (fg & 0xff)) * t)
    return (r << 16) | (g << 8) | b
  }
  const target = towardsWhite ? 0xffffff : 0x000000
  let lo = 0
  let hi = 1
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2
    if (contrastRatio(mix(mid, target), bg) >= ratio) hi = mid
    else lo = mid
  }
  return mix(hi, target)
}
