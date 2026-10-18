import { describe, expect, it } from 'vitest'
import { PANE_STUCK_AFTER_MS, paneStuckSince } from '../paneStuck'

const MIN = 60_000
const NOW = 100 * MIN

describe('paneStuckSince — a turn in flight with no sign of life', () => {
  it('flags a turn with no log activity and no output for the threshold', () => {
    expect(paneStuckSince({ turnInFlight: true, lastLogActivityAt: NOW - 25 * MIN, lastOutputAt: NOW - 21 * MIN, now: NOW }))
      .toBe(NOW - 21 * MIN)
  })

  it('is not stuck while the terminal still prints (a long command, a test run)', () => {
    expect(paneStuckSince({ turnInFlight: true, lastLogActivityAt: NOW - 60 * MIN, lastOutputAt: NOW - MIN, now: NOW })).toBeNull()
  })

  it('is not stuck while the log still moves', () => {
    expect(paneStuckSince({ turnInFlight: true, lastLogActivityAt: NOW - MIN, lastOutputAt: NOW - 60 * MIN, now: NOW })).toBeNull()
  })

  it('is not stuck between turns, or for a pane that never reported activity', () => {
    expect(paneStuckSince({ turnInFlight: false, lastLogActivityAt: NOW - 60 * MIN, lastOutputAt: 0, now: NOW })).toBeNull()
    expect(paneStuckSince({ turnInFlight: true, lastLogActivityAt: 0, lastOutputAt: 0, now: NOW })).toBeNull()
  })

  it('uses a 20-minute threshold by default', () => {
    expect(PANE_STUCK_AFTER_MS).toBe(20 * MIN)
    const at = NOW - PANE_STUCK_AFTER_MS
    expect(paneStuckSince({ turnInFlight: true, lastLogActivityAt: at, lastOutputAt: at, now: NOW })).toBe(at)
    expect(paneStuckSince({ turnInFlight: true, lastLogActivityAt: at + 1, lastOutputAt: at, now: NOW })).toBeNull()
  })
})
