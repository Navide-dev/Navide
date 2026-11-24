/** Persona mode's view model: pure functions from pane state to what the
 *  office shows. No DOM, no Vue — the component feeds these and draws. */
import type { PaneStatusValue } from '../paneStatusLabel'
import { STATION_H, STATION_W, type PersonaPose, type QuotaStage } from './sprites'

/** One pane as persona mode sees it. */
export interface PersonaPerson {
  id: string
  name: string
  status: PaneStatusValue
  /** Vendor label, shown only in the status card (the design has no vendor colour). */
  vendor: string
  /** Agent identity colour (AGENT_COLOR_HEX) — the shirt and the name-tag stripe. */
  agentColor?: string | null
  quota?: QuotaStage
  /** The pane's login expired (header badge "login expired"). */
  loginExpired?: boolean
  /** Guard marks the pane as influenced by external content (header shield badge). */
  guarded?: boolean
  /** Epoch ms the current status began, when known. */
  since?: number
}

export interface PersonaRoom {
  key: string
  label: string
  /** Group colour (RAIL_PALETTE slot). */
  color: string
  people: PersonaPerson[]
}

/** A pane idle this long dozes off at the desk instead of holding a mug. */
export const DOZE_AFTER_MS = 10 * 60 * 1000

export function personaPose(person: Pick<PersonaPerson, 'status' | 'quota' | 'since'>, now: number): PersonaPose {
  if (person.quota === 'empty') return 'quota'
  switch (person.status) {
    case 'running':
    case 'starting':
      return 'type'
    case 'awaiting':
      return 'raise'
    case 'error':
      return 'smoke'
    case 'disconnected':
      return 'unplugged'
    case 'idle':
      return person.since !== undefined && now - person.since >= DOZE_AFTER_MS ? 'sleep' : 'coffee'
    default:
      // exited, stopped, waiting (cold placeholder): nobody at the desk
      return 'away'
  }
}

/** Statuses that pin a person to the "needs attention" row. */
export function needsAttention(person: Pick<PersonaPerson, 'status' | 'quota'>): boolean {
  return person.status === 'awaiting' || person.status === 'error' || person.status === 'disconnected' || person.quota === 'empty'
}

/** Attention order: awaiting first (it stalls until someone answers), then the
 *  failures — the same order the tab rollup uses. Stable within a rank. */
export function attentionList<T extends Pick<PersonaPerson, 'status' | 'quota'>>(people: readonly T[]): T[] {
  return people
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => needsAttention(p))
    .sort((a, b) => (a.p.status === 'awaiting' ? 0 : 1) - (b.p.status === 'awaiting' ? 0 : 1) || a.i - b.i)
    .map(({ p }) => p)
}

/** Breathing rhythm of the status lamp, shared with the sidebar status dot:
 *  running 1.6 s, awaiting 1.2 s; everything else (error included) is steady. */
export function breathPeriodMs(status: PaneStatusValue): number | null {
  if (status === 'running') return 1600
  if (status === 'awaiting') return 1200
  return null
}

/** Lamp opacity at time `t`: a cosine between 0.35 and 1. Steady at 1 when the
 *  status does not breathe or motion is reduced. */
export function lampOpacity(status: PaneStatusValue, t: number, reducedMotion: boolean): number {
  const period = breathPeriodMs(status)
  if (period === null || reducedMotion) return 1
  const phase = (t % period) / period
  return 0.675 + 0.325 * Math.cos(phase * Math.PI * 2)
}

/** How long a state-change walk lasts. */
export const WALK_MS = 1200

/** Room counts per tab: people, running, awaiting, failing. */
export function roomCounts(people: readonly Pick<PersonaPerson, 'status' | 'quota'>[]): { total: number; running: number; awaiting: number; failing: number } {
  let running = 0, awaiting = 0, failing = 0
  for (const p of people) {
    if (p.status === 'running' || p.status === 'starting') running++
    if (p.status === 'awaiting') awaiting++
    else if (p.status === 'error' || p.status === 'disconnected' || p.quota === 'empty') failing++
  }
  return { total: people.length, running, awaiting, failing }
}

/** Desk layout for a room `widthPx` wide holding `n` people.
 *
 *  Up to 8 people the desks are drawn at full size (S = 5 units per pixel when
 *  the room is wide enough); past that the desks shrink, down to S = 2, so a
 *  crowd still fits several per row. Within that, the largest scale whose
 *  rows all fit `heightPx` wins; at S = 2 the room scrolls vertically for the
 *  rest rather than shrinking further. */
export interface DeskLayout {
  S: number
  cols: number
  rows: number
  /** Cell size in units (desk plus gutter and name-tag headroom). */
  cellW: number
  cellH: number
  /** Left margin in units, to centre the rows. */
  padX: number
  /** Wall height in units. */
  wallH: number
  /** Total height in units. */
  heightU: number
}

export function deskLayout(n: number, widthPx: number, heightPx = Infinity): DeskLayout {
  const cellW = STATION_W + 18
  const cellH = STATION_H + 22
  const wallH = 44
  const targetS = n <= 3 ? 5 : n <= 8 ? 4 : n <= 16 ? 3 : 2
  // Never larger than the width allows for at least min(n, 3) desks per row.
  const fitS = Math.max(2, Math.floor(widthPx / ((Math.min(Math.max(n, 1), 3)) * cellW + 12)))
  const at = (S: number): DeskLayout => {
    const widthU = Math.floor(widthPx / S)
    const cols = Math.max(1, Math.min(Math.max(n, 1), Math.floor((widthU - 12) / cellW)))
    const rows = Math.max(1, Math.ceil(n / cols))
    const padX = Math.max(6, Math.floor((widthU - cols * cellW) / 2) + 9)
    return { S, cols, rows, cellW, cellH, padX, wallH, heightU: wallH + 18 + rows * cellH }
  }
  let L = at(Math.max(2, Math.min(targetS, fitS)))
  while (L.S > 2 && L.heightU * L.S > heightPx) L = at(L.S - 1)
  return L
}

/** Top-left of desk `i` in units. */
export function deskPos(layout: DeskLayout, i: number): { x: number; y: number } {
  return {
    x: layout.padX + (i % layout.cols) * layout.cellW,
    y: layout.wallH + 18 + Math.floor(i / layout.cols) * layout.cellH,
  }
}

/** Index of the desk under a point (in units), or -1. The hit box is the
 *  station plus its name tag above. */
export function deskAt(layout: DeskLayout, n: number, ux: number, uy: number): number {
  for (let i = 0; i < n; i++) {
    const { x, y } = deskPos(layout, i)
    if (ux >= x - 3 && ux <= x + STATION_W + 3 && uy >= y - 14 && uy <= y + STATION_H) return i
  }
  return -1
}

/** Show the building overview toggle once the office is big enough that
 *  flipping through room tabs gets slow. */
export function buildingAvailable(rooms: readonly PersonaRoom[]): boolean {
  return rooms.length >= 2
}

/** Floor alarm for the building overview: awaiting (orange) or failing (red). */
export function floorAlarm(people: readonly Pick<PersonaPerson, 'status' | 'quota'>[]): 'failing' | 'awaiting' | null {
  const c = roomCounts(people)
  if (c.failing > 0) return 'failing'
  if (c.awaiting > 0) return 'awaiting'
  return null
}
