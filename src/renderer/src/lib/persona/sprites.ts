/** Pixel sprites for persona mode: an original office drawn entirely in code.
 *
 *  Every shape is a filled rectangle in "units"; `S` is the screen pixels per
 *  unit, so one drawing serves the roomy single-room view and the dense crowd
 *  view alike. Nothing here knows about panes or Vue — callers pass a
 *  `PersonaLook` (what the person looks like), a `PersonaPose` (what they are
 *  doing) and a `PersonaPalette` (the app's own status colours, resolved from
 *  its CSS variables), which keeps this module pure and testable.
 */

/** What a person is doing at their desk. Derived from the pane status by
 *  `personaPose`; each pose is one glance-readable silhouette. */
export type PersonaPose =
  | 'type' // running / starting: hands on the keyboard, text scrolling
  | 'raise' // awaiting an answer: hand up, "!" above the head
  | 'coffee' // idle: holding a mug
  | 'sleep' // idle for a long time: head down on the desk
  | 'smoke' // error: monitor smoking
  | 'unplugged' // disconnected: plug pulled, red dot blinking on the monitor
  | 'quota' // quota exhausted: empty battery on the monitor, smoking
  | 'away' // exited / stopped / not started: empty chair, dark monitor
  | 'walk' // a short walk back to the desk after a state change

export interface PersonaLook {
  hair: string
  skin: string
  shirt: string
}

/** Colours the drawing takes from the app, all resolved from its own tokens
 *  (there is no vendor colour in the design, so none is drawn). `status` is
 *  the badge colour of the person's own status, user overrides included. */
export interface PersonaPalette {
  status: string
  awaiting: string
  attention: string
  error: string
  errorDeep: string
  focus: string
  focusSoft: string
}

/** `color` at opacity `a`. Accepts the `#rrggbb` and `rgb()/rgba()` forms a
 *  computed style or a palette constant produces. */
export function withAlpha(color: string, a: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(color)
  if (rgb) return `rgba(${rgb[1]},${rgb[2]},${rgb[3]},${a})`
  return color
}

/** Quota badge stage, the same three steps the pane badge shows. */
export type QuotaStage = 'low' | 'critical' | 'empty' | null

export type Plot = (x: number, y: number, w: number, h: number, c: string) => void

/** Rectangle plotter in units, snapped to whole screen pixels. */
export function plotter(ctx: CanvasRenderingContext2D, S: number): Plot {
  return (x, y, w, h, c) => {
    ctx.fillStyle = c
    ctx.fillRect(Math.round(x * S), Math.round(y * S), Math.round(w * S), Math.round(h * S))
  }
}

/** Width and height of one workstation in units. */
export const STATION_W = 40
export const STATION_H = 36

const INK = '#2b2233'

/** Head: hair cap, two eyes, blush. 10 x 9 units, (x, y) = top-left. */
export function drawHead(p: Plot, x: number, y: number, look: PersonaLook, opts: { closed?: boolean; worried?: boolean } = {}): void {
  const { hair, skin } = look
  p(x + 1, y - 1, 8, 1, hair)
  p(x, y, 10, 3, hair)
  p(x, y + 3, 10, 5, skin)
  p(x + 1, y + 8, 8, 1, skin)
  p(x, y + 3, 1, 2, hair); p(x + 9, y + 3, 1, 2, hair)
  p(x + 6, y - 2, 2, 1, hair)
  if (opts.closed) {
    p(x + 2, y + 5, 2, 1, INK); p(x + 6, y + 5, 2, 1, INK)
  } else {
    p(x + 2, y + 4, 2, 2, INK); p(x + 6, y + 4, 2, 2, INK)
    p(x + 2, y + 4, 1, 1, '#ffffff'); p(x + 6, y + 4, 1, 1, '#ffffff')
  }
  p(x + 1, y + 6, 1, 1, '#f3a0a0'); p(x + 8, y + 6, 1, 1, '#f3a0a0')
  if (opts.worried) p(x + 4, y + 7, 2, 1, '#7a3b3b')
}

/** The "!" bubble an awaiting person raises, top-left at (x, y). */
export function drawBang(p: Plot, x: number, y: number, color: string): void {
  p(x, y, 6, 8, color); p(x + 1, y - 1, 4, 1, color); p(x + 1, y + 8, 4, 1, color)
  p(x + 2, y + 1, 2, 4, INK); p(x + 2, y + 6, 2, 1, INK)
}

/** A standing person, used for the short walk. Feet at (x + 5, y + 22). */
function drawStanding(p: Plot, x: number, y: number, look: PersonaLook, f: number): void {
  drawHead(p, x, y, look)
  p(x + 1, y + 9, 8, 8, look.shirt)
  p(x + 3, y + 9, 4, 2, look.skin)
  const step = f % 2
  p(x + 2, y + 17, 2, 4 + step, '#3a3f58'); p(x + 6, y + 17, 2, 5 - step, '#3a3f58')
  p(x - 1, y + 10 + step, 2, 5, look.shirt); p(x + 9, y + 11 - step, 2, 5, look.shirt)
}

/** One workstation: chair, person, desk, monitor, status lamp. Footprint
 *  STATION_W x STATION_H units, (x, y) = top-left. `walk` (0..1, 1 = just
 *  started) slides the person in from the side instead of seating them. */
export function drawStation(
  ctx: CanvasRenderingContext2D,
  S: number,
  x: number,
  y: number,
  look: PersonaLook,
  pose: PersonaPose,
  pal: PersonaPalette,
  opts: { frame?: number; selected?: boolean; walk?: number; lamp?: number; quota?: QuotaStage } = {},
): void {
  const p = plotter(ctx, S)
  const f = opts.frame ?? 0
  const walking = (opts.walk ?? 0) > 0
  if (opts.selected) { p(x - 3, y + 32, 46, 4, pal.focus); p(x - 1, y + 33, 42, 2, pal.focusSoft) }
  else if (pose === 'raise') p(x - 3, y + 32, 46, 4, withAlpha(pal.awaiting, 0.55))
  p(x + 2, y + 34, 36, 2, 'rgba(0,0,0,.18)')
  // chair
  p(x + 4, y + 13, 14, 11, '#3a3f58'); p(x + 5, y + 14, 12, 9, '#4a5070')
  const seated = !walking && pose !== 'away'
  const hx = x + 6
  if (seated && pose !== 'sleep') {
    p(x + 6, y + 14, 10, 9, look.shirt)
    p(x + 9, y + 14, 4, 2, look.skin)
    p(x + 10, y + 16, 2, 6, 'rgba(255,255,255,.25)')
    drawHead(p, hx, y + 5, look, { worried: pose === 'smoke' || pose === 'quota' || pose === 'unplugged' })
  } else if (seated) {
    p(x + 6, y + 16, 10, 7, look.shirt)
  }
  // desk
  p(x, y + 23, 40, 3, '#c98b55'); p(x, y + 23, 40, 1, '#dda473')
  p(x + 1, y + 26, 38, 8, '#9a6538'); p(x + 3, y + 28, 15, 4, '#87562e'); p(x + 21, y + 28, 15, 4, '#87562e')
  p(x + 10, y + 29, 2, 1, '#e8c79a'); p(x + 28, y + 29, 2, 1, '#e8c79a')
  // monitor: text and lamp are the status colour
  const broken = pose === 'smoke' || pose === 'quota'
  const scr = broken ? pal.errorDeep : (pose === 'away' || pose === 'sleep' || pose === 'coffee') ? '#161b22' : '#0d1117'
  const ink = pal.status
  p(x + 27, y + 19, 3, 4, '#2a2a33'); p(x + 24, y + 22, 9, 1, '#2a2a33')
  p(x + 21, y + 7, 15, 12, '#23232c')
  p(x + 22, y + 8, 13, 10, scr)
  p(x + 22, y + 8, 13, 1, 'rgba(255,255,255,.25)')
  if (pose === 'type' && !walking) {
    for (let i = 0; i < 4; i++) {
      const w = [9, 6, 10, 4][(i + f) % 4]
      p(x + 23, y + 10 + i * 2, w, 1, i === 3 ? '#c9d1d9' : ink)
    }
  } else if (pose === 'raise') {
    p(x + 23, y + 10, 8, 1, '#c9d1d9'); p(x + 23, y + 12, 5, 1, '#c9d1d9')
    p(x + 23, y + 15, 2, 2, ink); p(x + 26, y + 15, 6, 2, ink)
  } else if (pose === 'smoke') {
    for (let i = 0; i < 5; i++) { p(x + 26 + i, y + 10 + i, 1, 1, pal.error); p(x + 30 - i, y + 10 + i, 1, 1, pal.error) }
  } else if (pose === 'quota') {
    p(x + 24, y + 11, 8, 5, pal.error); p(x + 25, y + 12, 6, 3, pal.errorDeep); p(x + 32, y + 12, 1, 3, pal.error); p(x + 25, y + 12, 1, 3, pal.error)
  } else if (pose === 'unplugged') {
    if (f % 2 === 0) p(x + 27, y + 12, 3, 3, pal.error)
    p(x + 33, y + 22, 4, 1, '#2a2a33'); p(x + 37, y + 21, 2, 3, '#7c8494') // pulled plug
  } else if (pose === 'coffee' || pose === 'sleep') {
    p(x + 23, y + 10, 2, 2, ink)
  }
  // quota battery: the badge's three steps (low = attention, critical / empty = error)
  if (opts.quota && pose !== 'quota') {
    const qc = opts.quota === 'low' ? pal.attention : pal.error
    const bars = opts.quota === 'low' ? 2 : opts.quota === 'critical' ? 1 : 0
    p(x + 30, y + 9, 4, 3, qc); p(x + 31, y + 10, 2, 1, '#0d1117'); p(x + 34, y + 10, 1, 1, qc)
    for (let i = 0; i < bars; i++) p(x + 31 + i, y + 10, 1, 1, qc)
  }
  // status lamp, breathing at the caller's rhythm (lamp = 0..1 opacity)
  const lampOn = opts.lamp ?? 1
  p(x + 36, y + 19, 3, 4, '#30363d'); p(x + 35, y + 15, 5, 4, withAlpha(ink, lampOn)); p(x + 34, y + 14, 7, 1, withAlpha(ink, 0.4 * lampOn))
  // keyboard
  p(x + 15, y + 22, 9, 1, '#d9dce6')
  if (walking) {
    const off = Math.round((opts.walk ?? 0) * 14)
    drawStanding(p, x - 2 - off, y + 9, look, f)
    return
  }
  if (pose === 'type') {
    p(x + 14, y + 18, 5, 3, look.shirt); p(x + 17, y + 20 + (f % 2), 2, 2, look.skin); p(x + 20, y + 21 - (f % 2), 2, 1, look.skin)
  } else if (pose === 'raise') {
    p(x + 15, y + 3, 3, 12, look.shirt); p(x + 15, y, 3, 3, look.skin)
    drawBang(p, x - 1, y - 6 + (f % 2), pal.awaiting)
  } else if (pose === 'coffee') {
    p(x + 14, y + 17, 3, 4, look.shirt)
    p(x + 15, y + 16, 4, 5, '#f4f1ea'); p(x + 19, y + 17, 1, 3, '#f4f1ea'); p(x + 15, y + 16, 4, 1, '#6b4127')
    const s = f % 2
    p(x + 16 + s, y + 13, 1, 2, 'rgba(255,255,255,.7)'); p(x + 17 - s, y + 10, 1, 2, 'rgba(255,255,255,.55)')
  } else if (pose === 'sleep') {
    p(x + 4, y + 20, 14, 3, look.shirt)
    drawHead(p, hx, y + 13, look, { closed: true })
    ctx.fillStyle = '#c7d2fe'
    ctx.font = `bold ${Math.round(5 * S)}px ui-monospace, monospace`
    ctx.fillText('z', (x + 17) * S, (y + 10 - (f % 2)) * S)
    ctx.font = `bold ${Math.round(7 * S)}px ui-monospace, monospace`
    ctx.fillText('Z', (x + 19) * S, (y + 5 - (f % 2)) * S)
  } else if (pose === 'unplugged') {
    p(x + 14, y + 18, 5, 3, look.shirt); p(x + 17, y + 20, 2, 2, look.skin)
  } else if (pose === 'smoke' || pose === 'quota') {
    p(x + 14, y + 18, 5, 3, look.shirt); p(x + 17, y + 20, 2, 2, look.skin)
    const g = ['rgba(90,90,100,.75)', 'rgba(120,120,130,.6)', 'rgba(150,150,160,.45)']
    p(x + 26, y + 3, 4, 3, g[0]); p(x + 29 - (f % 2), y - 1, 5, 4, g[1]); p(x + 26 + (f % 2), y - 6, 6, 4, g[2])
  }
}

/** Rounded-rectangle path in screen pixels. */
export function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** Name tag centred over a station, in screen pixels. `mark` is the pane's
 *  own marker colour (left stripe), drawn only when the pane has one. */
export function drawNameTag(
  ctx: CanvasRenderingContext2D,
  S: number,
  x: number,
  y: number,
  label: string,
  pal: PersonaPalette,
  opts: { size?: number; selected?: boolean; mark?: string | null } = {},
): void {
  const size = opts.size ?? 13
  ctx.font = `600 ${size}px -apple-system, "PingFang TC", "Noto Sans CJK TC", sans-serif`
  const tw = ctx.measureText(label).width
  const w = tw + 26, h = size + 10
  const cx = (x + 20) * S - w / 2 + 4 * S, cy = y * S - h - 4
  ctx.fillStyle = 'rgba(20,22,34,.88)'
  roundRectPath(ctx, cx, cy, w, h, 6); ctx.fill()
  if (opts.selected) { ctx.strokeStyle = pal.focus; ctx.lineWidth = 2; roundRectPath(ctx, cx, cy, w, h, 6); ctx.stroke() }
  if (opts.mark) { ctx.fillStyle = opts.mark; ctx.fillRect(cx, cy + 3, 4, h - 6) }
  ctx.fillStyle = pal.status
  ctx.beginPath(); ctx.arc(cx + 12, cy + h / 2, 4, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'
  ctx.fillText(label, cx + 20, cy + h / 2 + 1)
  ctx.textBaseline = 'alphabetic'
}

// ── Room furniture ──────────────────────────────────────────────────────────

/** Wall and checker floor. */
export function drawRoom(p: Plot, W: number, H: number, wallH: number, wall: string, floor: [string, string]): void {
  p(0, 0, W, wallH, wall)
  for (let i = 0; i < W; i += 8) p(i, 0, 1, wallH, 'rgba(0,0,0,.025)')
  p(0, wallH - 3, W, 3, '#b9a88a')
  for (let y = wallH; y < H; y += 10) for (let x = 0; x < W; x += 10) p(x, y, 10, 10, ((x + y) / 10) % 2 ? floor[0] : floor[1])
}

export function drawWindow(p: Plot, x: number, y: number, w: number, h: number): void {
  p(x, y, w, h, '#6c5a44'); p(x + 2, y + 2, w - 4, h - 4, '#9fd4f2')
  p(x + 2, y + h - 10, w - 4, 8, '#bfe6c4'); p(x + 6, y + 6, 10, 3, '#ffffff'); p(x + 12, y + 8, 8, 2, '#ffffff')
  p(x + w / 2 - 1, y, 2, h, '#6c5a44'); p(x, y + h / 2 - 1, w, 2, '#6c5a44')
}

export function drawPlant(p: Plot, x: number, y: number): void {
  p(x + 2, y + 10, 8, 8, '#b5643c'); p(x + 1, y + 10, 10, 2, '#c97a50')
  p(x + 5, y + 2, 2, 8, '#3f8a4a'); p(x + 1, y + 3, 4, 3, '#4fa85b'); p(x + 7, y, 4, 4, '#4fa85b'); p(x + 2, y - 2, 4, 3, '#5fbf6b'); p(x + 6, y + 5, 5, 3, '#3f8a4a')
}

export function drawClock(p: Plot, x: number, y: number): void {
  p(x, y, 10, 10, '#2f3445'); p(x + 1, y + 1, 8, 8, '#fdfbf4'); p(x + 5, y + 2, 1, 4, '#2f3445'); p(x + 5, y + 5, 3, 1, '#d23b3b')
}

export function drawBoard(p: Plot, x: number, y: number, w: number, h: number): void {
  p(x, y, w, h, '#8f8a80'); p(x + 1, y + 1, w - 2, h - 2, '#fbfbf7')
  const cols = ['#ffd34d', '#9be3b4', '#a9c8ff', '#ffb3a7']
  for (let i = 0; i < 9; i++) p(x + 4 + (i % 3) * 10, y + 4 + Math.floor(i / 3) * 7, 7, 5, cols[i % 4])
}

export function drawCoffeeMachine(p: Plot, x: number, y: number): void {
  p(x, y + 14, 16, 16, '#7a5a3c'); p(x + 2, y, 12, 15, '#3d3f4d'); p(x + 3, y + 2, 10, 4, '#9fb3c8'); p(x + 6, y + 9, 4, 4, '#1f2029'); p(x + 7, y + 11, 2, 2, '#f4f1ea')
}

/** A rug tinted with the room's group colour. */
export function drawRug(p: Plot, x: number, y: number, w: number, h: number, color: string): void {
  p(x, y, w, h, withAlpha(color, 0.25)); p(x + 2, y + 2, w - 4, 1, withAlpha(color, 0.5)); p(x + 2, y + h - 3, w - 4, 1, withAlpha(color, 0.5))
}

export function drawShelf(p: Plot, x: number, y: number): void {
  p(x, y, 30, 34, '#7a5232'); p(x + 2, y + 2, 26, 30, '#5e3d22')
  const c = ['#e0525f', '#4f8df5', '#ffd34d', '#2f9e44', '#ae3ec9', '#f08c00']
  for (let r = 0; r < 3; r++) { p(x + 2, y + 11 + r * 10, 26, 1, '#7a5232'); for (let i = 0; i < 6; i++) p(x + 3 + i * 4, y + 4 + r * 10, 3, 7 - (i % 3), c[(i + r) % 6]) }
}

export function drawRack(p: Plot, x: number, y: number): void {
  p(x, y, 18, 40, '#2a2d3a')
  for (let i = 0; i < 6; i++) { p(x + 2, y + 3 + i * 6, 14, 4, '#3b3f52'); p(x + 13, y + 4 + i * 6, 2, 2, i % 3 ? '#7ee2a8' : '#ffd34d') }
}

export function drawPoster(p: Plot, x: number, y: number, c: string): void {
  p(x, y, 22, 28, '#fff'); p(x + 2, y + 2, 18, 16, c); p(x + 4, y + 21, 14, 2, '#c9ccd6'); p(x + 4, y + 24, 9, 2, '#c9ccd6')
}

// ── Looks ───────────────────────────────────────────────────────────────────

const HAIR = ['#3b2a20', '#c2603a', '#1f1f2a', '#e2b13c', '#5b3a8a', '#7a4a2a', '#9aa4b2', '#2f5d8a']
const SKIN = ['#f6d2b8', '#eec1a0', '#d9a27e', '#c98e6a', '#a8714f']
const SHIRT = ['#4c6ef5', '#2f9e44', '#e8590c', '#ae3ec9', '#1098ad', '#868e96', '#f03e3e', '#f59f00', '#5c7cfa', '#20c997']

/** FNV-1a: a stable small hash so one pane always gets the same look. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/** The look for a pane: hair and skin from its id; the shirt is the agent
 *  identity colour (AGENT_COLOR_HEX) when the pane has one. */
export function lookFor(id: string, shirt?: string | null): PersonaLook {
  const h = hashString(id)
  return {
    hair: HAIR[h % HAIR.length],
    skin: SKIN[(h >>> 4) % SKIN.length],
    shirt: shirt || SHIRT[(h >>> 8) % SHIRT.length],
  }
}
