// @vitest-environment happy-dom
//
// An account a reading proved has no session window is judged on its weekly
// window: same triggers, weekly clocks, and never stuck on the missing window.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import {
  QUOTA_READING_VETO,
  detectUsageLimit,
  loopEstimate,
  usageLimitDue,
  usageResumeAt,
  type UsageLimitHit,
} from '../cliUsageLimit'
import { LIMIT_RESET_BUFFER_MS } from '../loopPrompt'
import { judgeReading, quotaSemanticsFor } from '../quotaFailover'
import {
  __resetUsageForTest,
  absentSessionNote,
  exhaustedWindow,
  hasHeadlineHeadroom,
  initUsage,
  remainingPercent,
  remainingTier,
  usageFor,
  type UsageSnapshot,
} from '../../composables/useUsage'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'

const NOW = Date.parse('2026-11-01T08:00:00Z')
const WEEKLY_RESET = '2026-11-05T09:00:00Z'
const WEEKLY_AT = Date.parse(WEEKLY_RESET)

function reading(used: number, over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    provider: 'claude',
    status: 'ok',
    planType: null,
    windows: [{ kind: 'weekly', label: 'Weekly (all models)', usedPercent: used, resetsAt: WEEKLY_RESET }],
    fetchedAt: '2026-11-01T07:59:00Z',
    error: null,
    absentWindows: ['session'],
    ...over,
  }
}

function seed(snapshot: UsageSnapshot): void {
  const handlers = new Map<string, (raw: unknown) => void>()
  initUsage({
    status: ref('connected'),
    send: vi.fn(async () => ({ ok: true, payload: {} })),
    on: vi.fn((type: string, cb: (raw: unknown) => void) => {
      handlers.set(type, cb)
      return () => handlers.delete(type)
    }),
  } as never)
  handlers.get('usage.changed')?.({ providers: { [snapshot.provider]: snapshot } })
}

function hit(verdict: ReturnType<typeof detectUsageLimit>): UsageLimitHit {
  expect(verdict).not.toBeNull()
  expect(verdict).not.toBe(QUOTA_READING_VETO)
  return verdict as UsageLimitHit
}

beforeEach(() => {
  __resetSettingsForTest()
  __resetUsageForTest()
})

describe('quota running out', () => {
  it('a spent weekly window is a hit, and the reset is the weekly one', () => {
    const spent = reading(100)
    seed(spent)
    expect(exhaustedWindow(spent)?.kind).toBe('weekly')
    const verdict = judgeReading(spent, quotaSemanticsFor('claude'), NOW)
    expect(verdict.spent.map((w) => w.kind)).toEqual(['weekly'])
    expect(verdict.positive).toBe(false)
    const bare = hit(detectUsageLimit('claude', "You've hit your usage limit", NOW))
    expect(bare.resumeAt).toBe(WEEKLY_AT + LIMIT_RESET_BUFFER_MS)
  })

  it('near the line, the headline and its tier are the weekly window', () => {
    const near = reading(95)
    expect(remainingPercent(near)).toBe(5)
    expect(remainingTier(remainingPercent(near) as number)).toBe('crit')
    expect(judgeReading(near, quotaSemanticsFor('claude'), NOW).positive).toBe(true)
  })

  it('a clock-only sentence waits for the weekly reset, not the next 5pm', () => {
    seed(reading(100))
    const verdict = hit(detectUsageLimit('claude', "You've hit your limit · resets 5pm (Asia/Taipei)", NOW))
    expect(verdict).toMatchObject({
      resumeAt: WEEKLY_AT + LIMIT_RESET_BUFFER_MS,
      resetAt: WEEKLY_AT,
      windowKind: 'weekly',
      modelScope: 'all',
      resetPrecision: 'minute',
    })
  })

  it('a dated sentence keeps its own date', () => {
    seed(reading(100))
    const verdict = hit(detectUsageLimit('claude', "You've hit your weekly limit · resets 2026-11-06 5pm (Asia/Taipei)", NOW))
    expect(verdict.resetAt).toBe(Date.parse('2026-11-06T09:00:00Z'))
  })

  it('a sentence about one model keeps its own scope', () => {
    seed(reading(100))
    const verdict = hit(detectUsageLimit('claude', "You've hit your weekly limit (Opus) · resets 5pm (Asia/Taipei)", NOW))
    expect(verdict.modelScope).toBe('Opus')
    expect(verdict.resetAt).toBeNull()
  })

  it('falls back to the weekly reset when no window is spent yet', () => {
    seed(reading(97, { stale: true }))
    expect(usageResumeAt('claude', NOW)).toBe(WEEKLY_AT + LIMIT_RESET_BUFFER_MS)
  })

  it('a Codex account takes the same path', () => {
    seed(reading(100, { provider: 'codex' }))
    expect(usageResumeAt('codex', NOW)).toBe(WEEKLY_AT + LIMIT_RESET_BUFFER_MS)
    expect(judgeReading(reading(100, { provider: 'codex' }), quotaSemanticsFor('codex'), NOW).spent).toHaveLength(1)
  })
})

describe('quota coming back', () => {
  it('a reading under the line after the weekly reset is positive', () => {
    const back = reading(3, {
      windows: [{ kind: 'weekly', label: 'Weekly (all models)', usedPercent: 3, resetsAt: '2026-11-12T09:00:00Z' }],
    })
    expect(judgeReading(back, quotaSemanticsFor('claude'), WEEKLY_AT + 60_000).positive).toBe(true)
    expect(hasHeadlineHeadroom(back)).toBe(true)
  })

  it('a reading that outlived its reset proves nothing, and the flag still lets go', () => {
    expect(judgeReading(reading(100), quotaSemanticsFor('claude'), WEEKLY_AT + 60_000).positive).toBe(false)
    expect(usageLimitDue(NOW, WEEKLY_AT + LIMIT_RESET_BUFFER_MS, WEEKLY_AT + LIMIT_RESET_BUFFER_MS)).toBe(true)
  })

  it('the missing session window never keeps an account from being positive', () => {
    const verdict = judgeReading(reading(40), quotaSemanticsFor('claude'), NOW)
    expect(verdict.positive).toBe(true)
    expect(verdict.missing).toEqual([])
  })
})

describe('loop estimate', () => {
  it('is the weekly reset when the reading has one', () => {
    expect(loopEstimate(reading(40), NOW)).toEqual({ at: WEEKLY_AT, weekly: true })
  })

  it('is left out when the reading has none, or it has passed', () => {
    const noClock = reading(40, { windows: [{ kind: 'weekly', label: 'W', usedPercent: 40, resetsAt: null }] })
    expect(loopEstimate(noClock, NOW)).toEqual({ at: null, weekly: true })
    expect(loopEstimate(reading(40), WEEKLY_AT + 1)).toEqual({ at: null, weekly: true })
  })
})

describe('a sentence that names the session window', () => {
  const SENTENCE = "You've hit your session limit · resets 4:30pm (Asia/Taipei)"

  it('loses to a current reading with weekly headroom, as in v0.2.36', () => {
    seed(reading(40))
    expect(detectUsageLimit('claude', SENTENCE, NOW)).toBe(QUOTA_READING_VETO)
    expect(absentSessionNote(usageFor('claude'))).toBe('unlimited')
  })

  it('wins over a stale reading: its own clock, and no "unlimited" beside it', () => {
    seed(reading(40, { stale: true }))
    expect(absentSessionNote(usageFor('claude'))).toBe('unlimited')
    vi.useFakeTimers({ now: NOW })
    try {
      const verdict = hit(detectUsageLimit('claude', SENTENCE, NOW))
      expect(verdict.windowKind).toBe('session')
      expect(verdict.resumeAt).toBe(Date.parse('2026-11-01T08:30:00Z') + LIMIT_RESET_BUFFER_MS)
      expect(verdict.resetAt).toBe(Date.parse('2026-11-01T08:30:00Z'))
      expect(absentSessionNote(usageFor('claude'))).toBeNull()
      vi.setSystemTime((verdict.resumeAt as number) + 1)
      expect(absentSessionNote(usageFor('claude'))).toBe('unlimited')
    } finally {
      vi.useRealTimers()
    }
  })

  it('wins over a spent weekly reading too, with no "unlimited" beside it', () => {
    seed(reading(100))
    vi.useFakeTimers({ now: NOW })
    try {
      expect(hit(detectUsageLimit('claude', SENTENCE, NOW)).windowKind).toBe('session')
      expect(absentSessionNote(usageFor('claude'))).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the session note', () => {
  it('says unlimited for Claude and only "not reported" for Codex', () => {
    expect(absentSessionNote(reading(40))).toBe('unlimited')
    expect(absentSessionNote(reading(40, { provider: 'codex' }))).toBe('not-reported')
  })

  it('says nothing when absence is not proved', () => {
    expect(absentSessionNote(undefined)).toBeNull()
    expect(absentSessionNote(reading(40, { absentWindows: undefined }))).toBeNull()
    expect(absentSessionNote(reading(40, { absentWindows: [] }))).toBeNull()
    expect(absentSessionNote(reading(40, { status: 'error' }))).toBeNull()
    expect(absentSessionNote(reading(40, { windows: [] , absentWindows: ['session'], status: 'unavailable' }))).toBeNull()
    expect(absentSessionNote(reading(40, {
      windows: [{ kind: 'session', label: 'S', usedPercent: 10, resetsAt: null }],
    }))).toBeNull()
  })

  it('invents no window: the snapshot and its figures stay as read', () => {
    const snap = reading(40)
    const before = JSON.stringify(snap)
    absentSessionNote(snap)
    expect(JSON.stringify(snap)).toBe(before)
    expect(snap.windows.map((w) => w.kind)).toEqual(['weekly'])
    expect(remainingPercent(snap)).toBe(60)
  })
})
