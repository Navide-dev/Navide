import { describe, expect, it } from 'vitest'
import {
  INTERRUPTED_RESUME_LIMIT,
  RESUME_INTERRUPTED_ON_LAUNCH_SETTING_KEY,
  interruptedRestoreTargetIds,
  normalizeResumeInterruptedOnLaunch,
  turnStateForStatus,
  wasInterruptedAtLaunch,
} from '../resumeBehavior'

describe('resume-interrupted-on-launch setting', () => {
  it('is its own key, separate from the reconnect one', () => {
    expect(RESUME_INTERRUPTED_ON_LAUNCH_SETTING_KEY).toBe('agentTeam.resumeInterruptedOnLaunch')
  })

  it('defaults on: only an explicit false turns it off', () => {
    expect(normalizeResumeInterruptedOnLaunch(undefined)).toBe(true)
    expect(normalizeResumeInterruptedOnLaunch(null)).toBe(true)
    expect(normalizeResumeInterruptedOnLaunch('false')).toBe(true)
    expect(normalizeResumeInterruptedOnLaunch(true)).toBe(true)
    expect(normalizeResumeInterruptedOnLaunch(false)).toBe(false)
  })

  it('caps the automatic resume at six panes', () => {
    expect(INTERRUPTED_RESUME_LIMIT).toBe(6)
  })
})

describe('turnStateForStatus', () => {
  it('counts a running turn and both kinds of prompt parked on the user as working', () => {
    // 'awaiting' is the one badge for a permission box and a question picker.
    expect(turnStateForStatus('running')).toBe('working')
    expect(turnStateForStatus('awaiting')).toBe('working')
  })

  it('records a finished turn as idle', () => {
    expect(turnStateForStatus('idle')).toBe('idle')
  })

  it('records nothing for states that say nothing about a turn', () => {
    // A placeholder reports '' and a booting CLI 'starting': writing idle there
    // would erase the 'working' a restart is about to read.
    for (const s of ['', 'starting', 'exited', 'error', 'stopped']) {
      expect(turnStateForStatus(s)).toBeNull()
    }
  })
})

describe('wasInterruptedAtLaunch', () => {
  it('is true for a pane that was working', () => {
    expect(wasInterruptedAtLaunch({ last_turn_state: 'working' })).toBe(true)
  })

  it('is true for a pane that still owed its parent a report', () => {
    // The owed report means its first turn never ended — even if it was quiet
    // long enough for the badge to read idle.
    expect(wasInterruptedAtLaunch({ last_turn_state: 'idle', report_pending: true })).toBe(true)
  })

  it('is false for an idle pane, and for a record written before the field existed', () => {
    expect(wasInterruptedAtLaunch({ last_turn_state: 'idle' })).toBe(false)
    expect(wasInterruptedAtLaunch({})).toBe(false)
  })
})

describe('interruptedRestoreTargetIds', () => {
  const pane = (id: string, interrupted: boolean, spawnedBy?: string) => ({ id, interrupted, spawnedBy })

  it('picks only interrupted panes, in their own order', () => {
    const ids = interruptedRestoreTargetIds({
      pending: [pane('a', false), pane('b', true), pane('c', true)],
      visibleIds: [],
      limit: 6,
    })
    expect(ids).toEqual(['b', 'c'])
  })

  it('puts the visible interrupted panes first', () => {
    const ids = interruptedRestoreTargetIds({
      pending: [pane('a', true), pane('b', true), pane('c', true)],
      visibleIds: ['c'],
      limit: 6,
    })
    expect(ids).toEqual(['c', 'a', 'b'])
  })

  it('brings a pending parent along right after its child, once', () => {
    const ids = interruptedRestoreTargetIds({
      pending: [pane('lead', false), pane('k1', true, 'lead'), pane('k2', true, 'lead')],
      visibleIds: [],
      limit: 6,
    })
    expect(ids).toEqual(['k1', 'lead', 'k2'])
  })

  it('does not add a parent that is not pending (already open, or gone)', () => {
    const ids = interruptedRestoreTargetIds({
      pending: [pane('k1', true, 'lead')],
      visibleIds: [],
      limit: 6,
    })
    expect(ids).toEqual(['k1'])
  })

  it('stops at the limit, parents included', () => {
    const pending = [
      pane('lead', false),
      ...Array.from({ length: 8 }, (_, i) => pane(`k${i}`, true, 'lead')),
    ]
    const ids = interruptedRestoreTargetIds({ pending, visibleIds: [], limit: 6 })
    expect(ids).toEqual(['k0', 'lead', 'k1', 'k2', 'k3', 'k4'])
  })

  it('returns nothing with a zero limit', () => {
    expect(interruptedRestoreTargetIds({ pending: [pane('a', true)], visibleIds: [], limit: 0 })).toEqual([])
  })
})
