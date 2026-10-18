import { describe, expect, it } from 'vitest'
import { joinedRealizeOutcome, paneOpenAnswer, sessionHeldElsewhere } from '../paneOpenAnswer'

describe('joinedRealizeOutcome', () => {
  it('turns a restore that opened fresh into a refusal for a caller that requires the saved conversation', () => {
    // ui.pane.open{requireResume} that lands on a realize already running (the window's own
    // cold restore under "never") gets that realize's answer, which did not require it.
    expect(joinedRealizeOutcome('fresh', true)).toBe('fresh-refused')
  })

  it('passes every other answer through, and every answer for other callers', () => {
    expect(joinedRealizeOutcome('opened', true)).toBe('opened')
    expect(joinedRealizeOutcome('session-unavailable', true)).toBe('session-unavailable')
    expect(joinedRealizeOutcome('fresh', false)).toBe('fresh')
  })
})

describe('paneOpenAnswer', () => {
  it('reports the session the pane was launched on', () => {
    expect(paneOpenAnswer({ paneId: 'p2', reason: 'opened', realized: true, requireResume: true,
      launchedSessionId: 'sess-1' })).toEqual({ realized: true, reason: 'opened', paneId: 'p2', launchedSessionId: 'sess-1' })
  })

  it('does not report a fresh pane as realized to a caller that requires the saved conversation', () => {
    expect(paneOpenAnswer({ paneId: 'p2', reason: 'fresh', realized: true, requireResume: true,
      launchedSessionId: '' })).toEqual({ realized: false, reason: 'fresh-refused', paneId: 'p2', launchedSessionId: '' })
    expect(paneOpenAnswer({ paneId: 'p2', reason: 'fresh-refused', realized: true, requireResume: true,
      launchedSessionId: '' }).realized).toBe(false)
  })

  it('answers an already open pane with the session it was launched on, or null when unknown', () => {
    expect(paneOpenAnswer({ paneId: 'p1', reason: 'already-open', realized: true, requireResume: true,
      launchedSessionId: undefined })).toEqual({ realized: true, reason: 'already-open', paneId: 'p1', launchedSessionId: null })
  })

  it('leaves other callers exactly as before, fresh included', () => {
    expect(paneOpenAnswer({ paneId: 'p2', reason: 'fresh', realized: true, requireResume: false,
      launchedSessionId: '' })).toEqual({ realized: true, reason: 'fresh', paneId: 'p2', launchedSessionId: '' })
  })
})

describe('sessionHeldElsewhere', () => {
  const placeholder = { id: 'bound', agentKey: 'claude', sessionId: 'sess-1', realized: false, restoring: false }
  const other = (over: Partial<typeof placeholder>) => ({ ...placeholder, id: 'other', ...over })

  it('finds another pane running the session', () => {
    expect(sessionHeldElsewhere([placeholder, other({ realized: true })], 'bound', 'claude', 'sess-1', new Set())).toBe(true)
  })

  it('finds another pane the window is restoring onto the session right now', () => {
    // A cold restore registers it as a placeholder and realizes it seconds later.
    expect(sessionHeldElsewhere([placeholder, other({ restoring: true })], 'bound', 'claude', 'sess-1', new Set())).toBe(true)
  })

  it('finds another pane queued in the cold restore that has not started yet', () => {
    expect(sessionHeldElsewhere([placeholder, other({})], 'bound', 'claude', 'sess-1', new Set(['other']))).toBe(true)
  })

  it('ignores the pane itself, an idle placeholder, another CLI and an empty session', () => {
    expect(sessionHeldElsewhere([{ ...placeholder, realized: true }], 'bound', 'claude', 'sess-1', new Set(['bound']))).toBe(false)
    expect(sessionHeldElsewhere([placeholder, other({})], 'bound', 'claude', 'sess-1', new Set())).toBe(false)
    expect(sessionHeldElsewhere([placeholder, other({ realized: true, agentKey: 'codex' })], 'bound', 'claude', 'sess-1', new Set())).toBe(false)
    expect(sessionHeldElsewhere([placeholder, other({ realized: true, sessionId: '' })], 'bound', 'claude', '', new Set())).toBe(false)
  })
})
