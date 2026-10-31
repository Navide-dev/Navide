// Mouse reports. Spec: xterm ctlseqs, "Mouse Tracking": X10 (9), normal
// (1000), button-event (1002) and any-event (1003) tracking; button codes
// (0 left, 1 middle, 2 right, 3 release, +32 motion, 64/65 wheel) with
// modifier bits shift 4, meta 8, control 16; encodings default (CSI M with
// bytes value + 32), UTF-8 (1005), SGR (1006), urxvt (1015), SGR pixels (1016).
import type { Modes } from '../terminal'

export interface MouseReport {
  action: 'down' | 'up' | 'move' | 'wheel'
  /** 0 left, 1 middle, 2 right; -1 when no button is held during a move. */
  button: number
  wheel?: 'up' | 'down'
  /** 0-based cell. */
  col: number
  row: number
  /** Pixels from the top-left of the screen (SGR pixel mode). */
  x: number
  y: number
  shift: boolean
  alt: boolean
  ctrl: boolean
}

/** Bytes to send for this mouse event under the current modes, or undefined if it is not reported. */
export function encodeMouse(r: MouseReport, tracking: Modes['mouseTracking'], encoding: Modes['mouseEncoding']): string | undefined {
  if (tracking === 'none') return undefined
  if (tracking === 'x10' && r.action !== 'down') return undefined
  if (r.action === 'move') {
    if (tracking === 'vt200' || tracking === 'x10') return undefined
    if (tracking === 'drag' && r.button < 0) return undefined
  }

  const sgr = encoding === 'sgr' || encoding === 'sgr-pixels'
  let code: number
  if (r.action === 'wheel') code = r.wheel === 'up' ? 64 : 65
  else if (r.action === 'up' && !sgr) code = 3
  else if (r.action === 'move' && r.button < 0) code = 3 + 32
  else code = r.button + (r.action === 'move' ? 32 : 0)
  if (tracking !== 'x10') code |= (r.shift ? 4 : 0) | (r.alt ? 8 : 0) | (r.ctrl ? 16 : 0)

  const px = encoding === 'sgr-pixels'
  const cx = px ? r.x + 1 : r.col + 1
  const cy = px ? r.y + 1 : r.row + 1
  switch (encoding) {
    case 'sgr':
    case 'sgr-pixels':
      return `\x1b[<${code};${cx};${cy}${r.action === 'up' ? 'm' : 'M'}`
    case 'urxvt':
      return `\x1b[${code + 32};${cx};${cy}M`
    case 'utf8': {
      if (cx > 2015 || cy > 2015) return undefined
      return `\x1b[M${String.fromCharCode(code + 32, cx + 32, cy + 32)}`
    }
    default:
      if (cx > 223 || cy > 223) return undefined
      return `\x1b[M${String.fromCharCode(code + 32, cx + 32, cy + 32)}`
  }
}
