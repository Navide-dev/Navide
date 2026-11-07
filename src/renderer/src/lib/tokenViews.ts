// Shared helpers for the Token panel's by-model and by-account-quota views:
// the day / week range they read, and the six-character token figure.

export type TokenRange = 'day' | 'week'

export const TOKEN_RANGE_KEY = 'agentTeam.tokenPanel.range'

// Every tier caps at six characters ("999.9M"), which is what the fixed-width
// cells fit. Stopping at M was the bug: a workspace past a billion tokens
// rendered "77059.4M" and the cell clipped it to "77059...." — the IN and
// TOTAL figures became unreadable exactly once they got interesting.
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k'
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n < 1_000_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B'
  return (n / 1_000_000_000_000).toFixed(1) + 'T'
}

/** Minutes east of UTC on this machine now (Asia/Taipei → 480). */
export function utcOffsetMin(now: Date = new Date()): number {
  return -now.getTimezoneOffset()
}

function isoDay(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The local days a range covers: today alone, or this week Monday to Sunday. */
export function rangeDays(range: TokenRange, now: Date = new Date()): string[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (range === 'day') return [isoDay(today)]
  const monday = new Date(today)
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7))
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    return isoDay(d)
  })
}

/** One cost_report group as the backend sends it. */
export interface CostGroup {
  key: string
  calls: number
  input: number
  cache_read: number
  cache_write_5m: number
  cache_write_1h: number
  output: number
  usd: number
  unpriced_calls: number
  day?: string
  model?: string
  account?: string
}

export interface CostReport {
  ok: boolean
  error?: string
  by: string
  groups: CostGroup[]
}

export function groupTokens(g: CostGroup): number {
  return g.input + g.cache_read + g.cache_write_5m + g.cache_write_1h + g.output
}

/** "$12.34", or "—" when none of the group's calls had a price. */
export function fmtUsd(g: Pick<CostGroup, 'usd' | 'calls' | 'unpriced_calls'>): string {
  if (g.calls > 0 && g.unpriced_calls >= g.calls) return '—'
  return '$' + (g.usd >= 100 ? Math.round(g.usd).toLocaleString('en-US') : g.usd.toFixed(2))
}
