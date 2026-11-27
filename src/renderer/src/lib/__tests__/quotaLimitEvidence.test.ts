import { describe, expect, it } from 'vitest'
import { LIMIT_RESET_BUFFER_MS, matchSessionLimit, parseLimitEvidence } from '../loopPrompt'
import { detectUsageLimit, quotaExhaustedPayload, QUOTA_READING_VETO } from '../cliUsageLimit'
import { AGENT_SPECS } from '@navide/plugin-shell'

const NOW = Date.parse('2026-09-21T03:00:00Z')
function payload(message: string) {
  const hit = detectUsageLimit(undefined, message, NOW)
  expect(hit).not.toBeNull()
  expect(hit).not.toBe(QUOTA_READING_VETO)
  if (!hit || hit === QUOTA_READING_VETO) throw new Error('Expected a real detector hit')
  return quotaExhaustedPayload(hit, { agentKey: 'claude', paneId: 'pane-a' }, NOW)
}

describe('quota limit attribution evidence', () => {
  it('propagates a weekly clock without inventing a dated reset', () => {
    expect(payload("You've hit your weekly limit · resets 3:30pm (Asia/Taipei)")).toMatchObject({
      agent_key: 'claude', pane_id: 'pane-a', at: '2026-09-21T03:00:00.000Z',
      resets_at: null, window_kind: 'weekly', model_scope: null, reset_precision: 'clock_only'
    })
  })
  it('keeps explicit session clock-only attribution and cross-midnight rollover', () => {
    expect(payload("You've hit your session limit · resets 3:30pm (Asia/Taipei)")).toMatchObject({ resets_at: '2026-09-21T07:30:00.000Z', window_kind: 'session', reset_precision: 'clock_only' })
    expect(parseLimitEvidence('hit your session limit resets 1:00am (Asia/Taipei)', NOW).resetAt).toBe(Date.parse('2026-09-21T17:00:00Z'))
  })
  it('propagates exact UTC dates and explicit all-model identity', () => {
    expect(payload("You've hit your weekly (all models) limit · resets 2026-09-24T07:30:00Z")).toMatchObject({ resets_at: '2026-09-24T07:30:00.000Z', window_kind: 'weekly', model_scope: 'all', reset_precision: 'exact' })
  })
  it('resolves dated IANA clocks and keeps their model scope and precision', () => {
    const text = "You've hit your weekly (Fable only) limit · resets 2026-09-24 3:30pm (Asia/Taipei)"
    expect(matchSessionLimit(text)).toContain('2026-09-24')
    expect(payload(text)).toMatchObject({ resets_at: '2026-09-24T07:30:00.000Z', model_scope: 'Fable only', reset_precision: 'minute' })
  })
  it('does not lend an ambiguous usage clock to a session', () => {
    expect(payload("You've hit your usage limit · resets 3:30pm (Asia/Taipei)")).toMatchObject({ window_kind: null, resets_at: null, reset_precision: 'clock_only' })
  })
  it.each(['2026-02-30 3:30pm (Asia/Taipei)', '2026-09-24 13:30pm (Asia/Taipei)', '2026-09-24 3:30pm (Middle/Earth)'])('rejects an invalid dated reset: %s', (clock) => {
    expect(parseLimitEvidence('hit your weekly limit resets ' + clock, NOW)).toMatchObject({ resetAt: null, resetPrecision: 'unknown' })
  })
})

// The weekly banner names the reset by month and day. Real screen, 2026-11-27:
// the pane sat on this menu reading "idle" while its queue filled to the cap.
const WEEKLY_BANNER = "You've hit your weekly limit · resets Nov 28 at 9pm (Asia/Taipei)"
describe('weekly banner with a month-name reset', () => {
  const now = Date.parse('2026-11-27T05:30:00Z')
  it('is recognised by the Claude spec and the matcher', () => {
    expect(AGENT_SPECS.find((s) => s.agentKey === 'claude')?.quotaExhausted?.pattern.test(WEEKLY_BANNER)).toBe(true)
    expect(detectUsageLimit('claude', WEEKLY_BANNER, now)).toMatchObject({ windowKind: 'weekly', resetAt: Date.parse('2026-11-28T13:00:00Z'), resumeAt: Date.parse('2026-11-28T13:00:00Z') + LIMIT_RESET_BUFFER_MS })
    expect(matchSessionLimit(`  ⎿  ${WEEKLY_BANNER}\n\n What do you want to do?`)).toContain('Nov 28')
  })
  it('resolves the reset in the banner timezone', () => {
    expect(parseLimitEvidence(WEEKLY_BANNER, now)).toEqual({
      windowKind: 'weekly', modelScope: null, resetPrecision: 'hour', resetAt: Date.parse('2026-11-28T13:00:00Z')
    })
    expect(parseLimitEvidence("hit your weekly limit · resets Nov 28 at 9:15pm (Asia/Taipei)", now))
      .toMatchObject({ resetPrecision: 'minute', resetAt: Date.parse('2026-11-28T13:15:00Z') })
  })
  it('rolls a January reset seen in December into the next year', () => {
    expect(parseLimitEvidence('hit your weekly limit · resets Jan 2 at 9am (UTC)', Date.parse('2026-12-30T10:00:00Z')).resetAt)
      .toBe(Date.parse('2027-01-02T09:00:00Z'))
  })
  it.each(['Foo 28 at 9pm (Asia/Taipei)', 'Feb 30 at 9pm (Asia/Taipei)', 'Nov 28 at 13pm (Asia/Taipei)'])('rejects an invalid month-name reset: %s', (clock) => {
    expect(parseLimitEvidence('hit your weekly limit resets ' + clock, now)).toMatchObject({ resetAt: null, resetPrecision: 'unknown' })
  })
})
