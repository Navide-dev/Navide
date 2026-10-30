// Character attributes (SGR state) and the shared style table. Cells store a
// style id; identical attribute sets share one id.
// Spec: ECMA-48 8.3.117 (SGR); ITU T.416 / xterm ctlseqs for 38/48/58 colour
// forms and the 4:n underline styles.
import { CellFlag } from './snapshot'
import type { Params } from './params'

/** Colour encoding: 0 = default, PALETTE | index (0-255), RGB | 0xrrggbb. */
export const DEFAULT_COLOR = 0
export const PALETTE = 1 << 24
export const RGB = 2 << 24

export const Underline = { None: 0, Single: 1, Double: 2, Curly: 3, Dotted: 4, Dashed: 5 } as const

export interface Style {
  fg: number
  bg: number
  /** CellFlag bits. */
  flags: number
  underlineStyle: number
  underlineColor: number
  /** Hyperlink id (OSC 8), 0 for none. */
  link: number
}

export const DEFAULT_STYLE: Readonly<Style> = Object.freeze({ fg: 0, bg: 0, flags: 0, underlineStyle: 0, underlineColor: 0, link: 0 })

export class StyleTable {
  private readonly styles: Style[] = [{ ...DEFAULT_STYLE }]
  /** Styles with only fg, bg and flags (the common case): (fg * 2^26 + bg) -> flags -> id, no string keys. */
  private readonly simple = new Map<number, Map<number, number>>([[0, new Map([[0, 0]])]])
  private readonly ids = new Map<string, number>()

  intern(style: Style): number {
    if (style.underlineStyle === 0 && style.underlineColor === 0 && style.link === 0) {
      // Colours are below 2^26, so fg * 2^26 + bg is exact in a double.
      const colors = style.fg * 0x4000000 + style.bg
      let byFlags = this.simple.get(colors)
      if (!byFlags) {
        byFlags = new Map()
        this.simple.set(colors, byFlags)
      }
      let id = byFlags.get(style.flags)
      if (id === undefined) {
        id = this.add(style)
        byFlags.set(style.flags, id)
      }
      return id
    }
    const k = key(style)
    let id = this.ids.get(k)
    if (id === undefined) {
      id = this.add(style)
      this.ids.set(k, id)
    }
    return id
  }

  private add(style: Style): number {
    this.styles.push({ ...style })
    return this.styles.length - 1
  }

  get(id: number): Readonly<Style> {
    return this.styles[id] ?? DEFAULT_STYLE
  }
}

/** One string from 16-bit halves: much cheaper than formatting six numbers. */
function key(s: Style): string {
  return String.fromCharCode(
    s.fg & 0xffff, s.fg >>> 16, s.bg & 0xffff, s.bg >>> 16, s.flags, s.underlineStyle,
    s.underlineColor & 0xffff, s.underlineColor >>> 16, s.link & 0xffff, s.link >>> 16,
  )
}

/** Reads a 38/48/58 extended colour starting at parameter `i`. Returns the colour and how many extra parameters it used. */
function extendedColor(params: Params, i: number): [color: number | undefined, consumed: number] {
  if (params.hasSub(i)) {
    const sub = params.sub(i)
    const v = (n: number): number => Math.max(0, sub[n] ?? 0)
    if (sub[0] === 5) return [PALETTE | (v(1) & 0xff), 0]
    if (sub[0] === 2) {
      // 38:2:<colourspace>:r:g:b (T.416) or the common 38:2:r:g:b.
      const [r, g, b] = sub.length >= 5 ? [v(2), v(3), v(4)] : [v(1), v(2), v(3)]
      return [RGB | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff), 0]
    }
    return [undefined, 0]
  }
  const mode = params.get(i + 1, -1)
  if (mode === 5) return [PALETTE | (params.get(i + 2, 0) & 0xff), 2]
  if (mode === 2) {
    const r = params.get(i + 2, 0) & 0xff
    const g = params.get(i + 3, 0) & 0xff
    const b = params.get(i + 4, 0) & 0xff
    return [RGB | (r << 16) | (g << 8) | b, 4]
  }
  return [undefined, 0]
}

/** Applies one SGR sequence to `s` in place. */
export function applySgr(s: Style, params: Params): void {
  if (params.length === 0) {
    resetSgr(s)
    return
  }
  for (let i = 0; i < params.length; i++) {
    const p = params.get(i, 0)
    if (p >= 30 && p <= 37) s.fg = PALETTE | (p - 30)
    else if (p >= 40 && p <= 47) s.bg = PALETTE | (p - 40)
    else if (p >= 90 && p <= 97) s.fg = PALETTE | (p - 90 + 8)
    else if (p >= 100 && p <= 107) s.bg = PALETTE | (p - 100 + 8)
    else switch (p) {
      case 0: resetSgr(s); break
      case 1: s.flags |= CellFlag.Bold; break
      case 2: s.flags |= CellFlag.Dim; break
      case 3: s.flags |= CellFlag.Italic; break
      case 4: {
        const style = params.hasSub(i) ? Math.max(0, params.sub(i)[0] ?? 1) : 1
        if (style === 0) {
          s.flags &= ~CellFlag.Underline
          s.underlineStyle = 0
        } else {
          s.flags |= CellFlag.Underline
          s.underlineStyle = Math.min(style, 5)
        }
        break
      }
      case 5: case 6: s.flags |= CellFlag.Blink; break
      case 7: s.flags |= CellFlag.Inverse; break
      case 8: s.flags |= CellFlag.Invisible; break
      case 9: s.flags |= CellFlag.Strikethrough; break
      case 21: s.flags |= CellFlag.Underline; s.underlineStyle = Underline.Double; break
      case 22: s.flags &= ~(CellFlag.Bold | CellFlag.Dim); break
      case 23: s.flags &= ~CellFlag.Italic; break
      case 24: s.flags &= ~CellFlag.Underline; s.underlineStyle = 0; break
      case 25: s.flags &= ~CellFlag.Blink; break
      case 27: s.flags &= ~CellFlag.Inverse; break
      case 28: s.flags &= ~CellFlag.Invisible; break
      case 29: s.flags &= ~CellFlag.Strikethrough; break
      case 39: s.fg = DEFAULT_COLOR; break
      case 49: s.bg = DEFAULT_COLOR; break
      case 53: s.flags |= CellFlag.Overline; break
      case 55: s.flags &= ~CellFlag.Overline; break
      case 59: s.underlineColor = DEFAULT_COLOR; break
      case 38: case 48: case 58: {
        const [color, consumed] = extendedColor(params, i)
        if (color !== undefined) {
          if (p === 38) s.fg = color
          else if (p === 48) s.bg = color
          else s.underlineColor = color
        }
        i += consumed
        break
      }
    }
  }
}

function resetSgr(s: Style): void {
  s.fg = DEFAULT_COLOR
  s.bg = DEFAULT_COLOR
  s.flags = 0
  s.underlineStyle = 0
  s.underlineColor = DEFAULT_COLOR
}

/** Snapshot notation: 'd', 'p:<n>' or 'r:<rrggbb>'. */
export function colorSpec(color: number): string {
  if (color === DEFAULT_COLOR) return 'd'
  if ((color & RGB) === RGB) return `r:${(color & 0xffffff).toString(16).padStart(6, '0')}`
  return `p:${color & 0xff}`
}
