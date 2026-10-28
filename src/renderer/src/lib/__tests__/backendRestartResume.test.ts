import { describe, expect, it } from 'vitest'
import { isRepeatCrash, planBackendRestartResume, type LostPane } from '../backendRestartResume'

const pane = (id: string, over: Partial<LostPane> = {}): LostPane =>
  ({ id, onScreen: false, working: false, canResume: true, ...over })

describe('planBackendRestartResume (H3)', () => {
  it('resumes every on-screen pane, uncapped, exactly as before', () => {
    const lost = Array.from({ length: 9 }, (_, i) => pane(`v${i}`, { onScreen: true }))
    expect(planBackendRestartResume(lost, { crashLoop: false }).resume).toEqual(lost.map((p) => p.id))
  })

  it('adds off-screen panes only when they were working, at most six with parents counted', () => {
    const lost = [
      pane('visible', { onScreen: true }),
      pane('idle-off'),
      pane('parent'),
      pane('kid', { working: true, spawnedBy: 'parent' }),
      ...Array.from({ length: 6 }, (_, i) => pane(`w${i}`, { working: true })),
    ]
    const plan = planBackendRestartResume(lost, { crashLoop: false })
    expect(plan.resume).toEqual(['visible', 'kid', 'parent', 'w0', 'w1', 'w2', 'w3'])
    expect(plan.notResumed).toEqual([
      { id: 'idle-off', reason: 'idle-off-screen' },
      { id: 'w4', reason: 'over-limit' },
      { id: 'w5', reason: 'over-limit' },
    ])
  })

  it('never resumes an off-screen pane without a conversation to pick up', () => {
    const plan = planBackendRestartResume([pane('x', { working: true, canResume: false })], { crashLoop: false })
    expect(plan).toEqual({ resume: [], notResumed: [{ id: 'x', reason: 'no-session' }] })
  })

  it('resumes nothing in a crash loop and lists every pane', () => {
    const lost = [pane('v', { onScreen: true }), pane('w', { working: true })]
    expect(planBackendRestartResume(lost, { crashLoop: true })).toEqual({
      resume: [],
      notResumed: [{ id: 'v', reason: 'crash-loop' }, { id: 'w', reason: 'crash-loop' }],
    })
  })

  it('calls it a loop only when an earlier attempt of the same budget already reconnected', () => {
    // First crash, first respawn came back.
    expect(isRepeatCrash(1, null)).toBe(false)
    // First crash whose first respawn failed to start: still the first wave.
    expect(isRepeatCrash(2, null)).toBe(false)
    // Came back on attempt 1, crashed again inside the budget.
    expect(isRepeatCrash(2, 1)).toBe(true)
    // The budget reset after 60 s stable: numbering starts at 1 again.
    expect(isRepeatCrash(1, 2)).toBe(false)
    // A manual restart carries no attempt.
    expect(isRepeatCrash(null, 1)).toBe(false)
    expect(isRepeatCrash(undefined, undefined)).toBe(false)
  })
})
