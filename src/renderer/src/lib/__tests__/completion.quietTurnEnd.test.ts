import { describe, expect, it } from 'vitest'
import {
  TURN_END_QUIET_FALLBACK_MS,
  quietTurnEndDone,
  recordTurnComplete,
  turnCompleteDone,
} from '../completion'

// The 0.2.39 Linux VM run: a stub CLI's turn ended in zero seconds, and the
// stage watcher armed with the run left `running` for good. Replayed here with
// the same maps App.vue keeps and the same order of events.
const TOLERANCE_MS = 60_000
const SETTLE_MS = 1500
const PANE = 'p1'

function zeroSecondTurn() {
  const completeAt = new Map<string, number>()
  const sourceAt = new Map<string, number>()
  const times = new Map<string, number[]>()
  const kickoffAt = 1_000_000
  // The Stop hook's turn end carries no timestamp, so it is always recorded.
  recordTurnComplete(completeAt, PANE, '', kickoffAt + 200, TOLERANCE_MS, sourceAt, times)
  // The conversation-log reader catches up 70 s later: the turn's user record
  // is an agent_active stamped with its receive time...
  const lastActiveAt = kickoffAt + 70_000
  // ...and its turn end, older than the replay tolerance, is dropped.
  const recorded = recordTurnComplete(
    completeAt, PANE, new Date(kickoffAt + 100).toISOString(), lastActiveAt + 5, TOLERANCE_MS, sourceAt, times,
  )
  expect(recorded).toBe(false)
  return { completeAt, times, kickoffAt, lastActiveAt }
}

describe('a zero-second stage turn whose turn end is overtaken', () => {
  it('leaves turnCompleteDone false however long the pane sits idle', () => {
    const { completeAt, kickoffAt, lastActiveAt } = zeroSecondTurn()
    for (const wait of [SETTLE_MS, 60_000, 30 * 60_000]) {
      expect(turnCompleteDone({
        turnCompleteAt: completeAt.get(PANE) ?? 0,
        lastActiveAt,
        armedAt: kickoffAt,
        now: lastActiveAt + wait,
        settleMs: SETTLE_MS,
      })).toBe(false)
    }
  })

  it('is finished by the fallback once the pane has been idle long enough', () => {
    const { times, kickoffAt, lastActiveAt } = zeroSecondTurn()
    const base = {
      turnEndTimes: times.get(PANE) ?? [],
      lastActiveAt,
      armedAt: kickoffAt,
      running: false,
      quietMs: TURN_END_QUIET_FALLBACK_MS,
    }
    expect(quietTurnEndDone({ ...base, now: lastActiveAt + TURN_END_QUIET_FALLBACK_MS - 1 })).toBe(false)
    expect(quietTurnEndDone({ ...base, now: lastActiveAt + TURN_END_QUIET_FALLBACK_MS })).toBe(true)
  })
})

describe('quietTurnEndDone', () => {
  const ok = {
    turnEndTimes: [2000],
    lastActiveAt: 3000,
    armedAt: 1000,
    now: 3000 + TURN_END_QUIET_FALLBACK_MS,
    running: false,
    quietMs: TURN_END_QUIET_FALLBACK_MS,
  }

  it('accepts a post-arm turn end on a quiet, idle pane', () => {
    expect(quietTurnEndDone(ok)).toBe(true)
  })

  it('never counts a turn end from before the watcher armed', () => {
    expect(quietTurnEndDone({ ...ok, turnEndTimes: [500, 1000] })).toBe(false)
    expect(quietTurnEndDone({ ...ok, turnEndTimes: [] })).toBe(false)
  })

  it('waits while the badge reads RUNNING', () => {
    expect(quietTurnEndDone({ ...ok, running: true })).toBe(false)
  })

  it('measures the quiet from the latest of activity and turn end', () => {
    expect(quietTurnEndDone({ ...ok, lastActiveAt: ok.now - 1 })).toBe(false)
    expect(quietTurnEndDone({ ...ok, turnEndTimes: [ok.now - 1], lastActiveAt: 0 })).toBe(false)
  })

  it('holds for quota, background work and a turn older than the quota notice', () => {
    expect(quietTurnEndDone({ ...ok, quotaBlocked: true })).toBe(false)
    expect(quietTurnEndDone({ ...ok, backgroundRunning: true })).toBe(false)
    expect(quietTurnEndDone({ ...ok, quotaSeenAt: 5000, turnSourceAt: 4000 })).toBe(false)
  })
})
