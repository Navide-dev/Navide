// Accounts that report their windows are judged exactly as v0.2.36 judged them.
// The baseline was recorded by running v0.2.36's own judgeReading on every
// reading built here; backend/tests/test_quota_verdict_unchanged.py is the
// same check for the backend.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { UsageSnapshot } from '../../composables/useUsage'
import { judgeReading, quotaSemanticsFor } from '../quotaFailover'

const BASELINE: Record<string, string> = JSON.parse(
  readFileSync(resolve(process.cwd(), 'tests/fixtures/quota-verdict-baseline-v0.2.36.json'), 'utf8'),
).rendererVerdicts
const KINDS = ['session', 'weekly', 'weekly-model', 'monthly']
const NOW = 1_800_000_000_000
const iso = (t: number) => new Date(t).toISOString()

function combos(size: number, from = 0): string[][] {
  if (size === 0) return [[]]
  const out: string[][] = []
  for (let i = from; i < KINDS.length; i++) for (const rest of combos(size - 1, i + 1)) out.push([KINDS[i], ...rest])
  return out
}

function useds(size: number): number[][] {
  if (size === 0) return [[]]
  return [30, 100].flatMap((u) => useds(size - 1).map((rest) => [u, ...rest]))
}

function readings(agent: string): UsageSnapshot[] {
  const out: UsageSnapshot[] = []
  for (let size = 0; size <= KINDS.length; size++) {
    for (const kinds of combos(size)) {
      for (const used of useds(size)) {
        for (const status of ['ok', 'error'] as const) {
          for (const stale of [false, true]) {
            out.push({
              provider: agent, status, stale, planType: null, error: null, fetchedAt: iso(NOW - 60_000),
              windows: kinds.map((k, i) => ({ kind: k, label: k, usedPercent: used[i], resetsAt: iso(NOW + 3_600_000) })),
            } as UsageSnapshot)
          }
        }
      }
    }
  }
  return out
}

function letter(reading: UsageSnapshot, agent: string): string {
  const v = judgeReading(reading, quotaSemanticsFor(agent))
  return v.positive ? 'P' : v.spent.length ? 'X' : v.missing.length ? 'M' : 'U'
}

describe.each(Object.keys(BASELINE))('quota verdict for %s, as in v0.2.36', (agent) => {
  it('is unchanged for a reading without the field', () => {
    expect(readings(agent).map((r) => letter(r, agent)).join('')).toBe(BASELINE[agent])
  })

  it('ignores the field on a reading with a session window', () => {
    readings(agent).forEach((reading, i) => {
      if (reading.windows.some((w) => w.kind === 'session')) {
        expect(letter({ ...reading, absentWindows: ['session'] }, agent)).toBe(BASELINE[agent][i])
      }
    })
  })

  it('treats an empty field as no field', () => {
    readings(agent).forEach((reading, i) => {
      expect(letter({ ...reading, absentWindows: [] }, agent)).toBe(BASELINE[agent][i])
    })
  })
})
