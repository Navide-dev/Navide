// quotaFailover — the pure ranking / classification half of quota-exhaustion
// account switching. Every case here is one the plan (Phase A) names as an
// acceptance criterion: weekly-spent-vetoes-5h-reset, reset passed, unknown
// login, the built-in default slot, an old epoch, several panes reporting the
// same wall, a different provider scope, and 429 / auth / network / context /
// payment failures that must NOT read as quota exhaustion.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { UsageSnapshot } from '../../composables/useUsage'
import {
  DEFAULT_FRESH_WINDOW_MS,
  DEFAULT_SLOT_ID,
  canTriggerAutoSwitch,
  classifyFailure,
  evidenceIsAttributable,
  incidentKeyFor,
  judgeReading,
  noCandidateReasons,
  pickAutoCandidate,
  quotaExhaustedPatternFor,
  quotaSemanticsFor,
  rankCandidates,
  slotIdOf,
  windowRemaining,
  type CandidateAccount,
  type ExhaustionEvidence,
  type QuotaWindowReading,
  type RankingContext,
} from '../quotaFailover'

const NOW = Date.parse('2026-09-21T10:00:00.000Z')
const H = 60 * 60_000

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function win(kind: string, usedPercent: number, resetsAt: number | null = NOW + H, extra: Partial<QuotaWindowReading> = {}): QuotaWindowReading {
  return { kind, label: kind, usedPercent, resetsAt: resetsAt === null ? null : iso(resetsAt), ...extra }
}

function snap(windows: QuotaWindowReading[], extra: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    provider: 'claude',
    status: 'ok',
    planType: null,
    windows,
    fetchedAt: iso(NOW - 60_000),
    error: null,
    ...extra,
  }
}

function ctx(patch: Partial<RankingContext> = {}): RankingContext {
  return {
    agentKey: 'claude',
    authScope: 'anthropic',
    currentSlotId: 'slot-a',
    currentEpoch: 7,
    triedSlotIds: [],
    now: NOW,
    ...patch,
  }
}

function cand(slotId: string, patch: Partial<CandidateAccount> = {}): CandidateAccount {
  return { slotId, authScope: 'anthropic', login: 'signed-in', ...patch }
}

/** A current reading of this slot under the current epoch, taken a minute ago. */
function fresh(slotId: string, windows: QuotaWindowReading[], patch: Partial<CandidateAccount['reading'] & object> = {}) {
  return { slotId, epoch: 7, observedAt: NOW - 60_000, snapshot: snap(windows), ...patch }
}

describe('identity', () => {
  it('spells the built-in default slot the way the backend keys it', () => {
    expect(slotIdOf(null)).toBe(DEFAULT_SLOT_ID)
    expect(slotIdOf(undefined)).toBe('__default__')
    expect(slotIdOf('')).toBe('__default__')
    expect(slotIdOf('p1')).toBe('p1')
  })
})

describe('vendor quota semantics and judgeReading', () => {
  it('declares semantics only for vendors whose fetcher reports one account-level window set', () => {
    for (const key of ['claude', 'codex', 'kimi', 'grok', 'copilot', 'qwen', 'cursor', 'kilo', 'pi']) {
      expect(quotaSemanticsFor(key), key).toBeDefined()
    }
    // Per-model buckets (antigravity), per-provider windows (opencode) and
    // vendors with no usage fetcher stay undeclared: never positive.
    for (const key of ['antigravity', 'opencode', 'aider', 'droid', 'mcode', 'muse', 'terminal']) {
      expect(quotaSemanticsFor(key), key).toBeUndefined()
    }
  })

  it('takes an injected declaration over the vendor spec', () => {
    const r = rankCandidates(
      ctx({ agentKey: 'antigravity', semantics: { hard: ['session', 'weekly'], required: ['session'] } }),
      [cand('b', { reading: fresh('b', [win('session', 20)]) })],
    )
    expect(r.eligible[0].tier).toBe('fresh-headroom')
    expect(rankCandidates(ctx({ agentKey: 'antigravity' }), [cand('b', { reading: fresh('b', [win('session', 20)]) })]).eligible[0].tier).toBe('unknown')
  })

  it('non-finite figures are not evidence either way', () => {
    expect(windowRemaining(win('credits', 0, null, { balance: Number.NaN }))).toBeNull()
    expect(windowRemaining(win('credits', 0, null, { balance: Number.POSITIVE_INFINITY }))).toBeNull()
    expect(windowRemaining(win('credits', 0, null, { usage: 4, limit: Number.POSITIVE_INFINITY }))).toBeNull()
    expect(windowRemaining(win('credits', 0, null, { usage: 4, limit: Number.NaN }))).toBeNull()
    expect(windowRemaining(win('session', Number.NaN))).toBeNull()
    const kilo = quotaSemanticsFor('kilo')
    const v = judgeReading(snap([win('credits', 0, null, { balance: Number.NaN })]), kilo)
    expect(v.positive).toBe(false)
    expect(v.spent).toEqual([])
  })

  it('is positive only when every required window is present and under the line', () => {
    const claude = quotaSemanticsFor('claude')
    expect(judgeReading(snap([win('session', 40), win('weekly', 60)]), claude).positive).toBe(true)
    // Missing weekly: says nothing about the weekly limit, so not positive.
    const missing = judgeReading(snap([win('session', 40)]), claude)
    expect(missing.positive).toBe(false)
    expect(missing.missing).toEqual(['weekly'])
    // A spent hard window is a veto, whatever the other one says.
    const spent = judgeReading(snap([win('session', 10), win('weekly', 100)]), claude)
    expect(spent.positive).toBe(false)
    expect(spent.spent.map((w) => w.kind)).toEqual(['weekly'])
    expect(spent.weakestRemaining).toBe(0)
  })

  describe('a window the reading confirms is absent', () => {
    const claude = quotaSemanticsFor('claude')
    const absent = { absentWindows: ['session'] }

    it('no longer blocks a positive reading, for either vendor', () => {
      const v = judgeReading(snap([win('weekly', 30)], absent), claude)
      expect(v.positive).toBe(true)
      expect(v.missing).toEqual([])
      expect(judgeReading(snap([win('weekly', 41)], { ...absent, provider: 'codex' }), quotaSemanticsFor('codex')).positive).toBe(true)
    })

    it('stays unknown when nobody confirmed it', () => {
      const v = judgeReading(snap([win('weekly', 30)]), claude)
      expect(v.positive).toBe(false)
      expect(v.missing).toEqual(['session'])
    })

    it('does not lift a spent window', () => {
      expect(judgeReading(snap([win('weekly', 100)], absent), claude).spent.map((w) => w.kind)).toEqual(['weekly'])
      const session = judgeReading(snap([win('session', 100), win('weekly', 30)], absent), claude)
      expect(session.positive).toBe(false)
      expect(session.spent.map((w) => w.kind)).toEqual(['session'])
    })

    it('does not excuse a different required window', () => {
      expect(judgeReading(snap([win('session', 30)], absent), claude).missing).toEqual(['weekly'])
    })

    it('counts only on a successful read', () => {
      expect(judgeReading(snap([win('weekly', 30)], { ...absent, status: 'error' }), claude).positive).toBe(false)
    })

    it('ranks such an account above a stale one', () => {
      const r = rankCandidates(ctx(), [
        cand('stale', { reading: fresh('stale', [win('session', 10), win('weekly', 10)], { snapshot: snap([win('session', 10), win('weekly', 10)], { stale: true }) }) }),
        cand('ultra', { reading: fresh('ultra', [], { snapshot: snap([win('weekly', 30)], absent) }) }),
      ])
      expect(r.eligible.map((c) => [c.slotId, c.tier])).toEqual([['ultra', 'fresh-headroom'], ['stale', 'stale-headroom']])
    })
  })

  it('ignores per-model buckets both ways (a spent Fable-only bucket is not exhaustion)', () => {
    const claude = quotaSemanticsFor('claude')
    const v = judgeReading(snap([win('session', 40), win('weekly', 60), win('weekly-model', 100)]), claude)
    expect(v.positive).toBe(true)
    expect(v.spent).toEqual([])
    expect(v.weakestRemaining).toBe(40)
  })

  it('kimi: the 5h rate limit is enforced when reported but not required', () => {
    const kimi = quotaSemanticsFor('kimi')
    expect(judgeReading(snap([win('weekly', 30)]), kimi).positive).toBe(true)
    expect(judgeReading(snap([win('weekly', 30), win('session', 100)]), kimi).positive).toBe(false)
  })

  it('cursor: an open on-demand pool lifts a spent plan cycle', () => {
    const cursor = quotaSemanticsFor('cursor')
    expect(judgeReading(snap([win('cycle', 100)]), cursor).positive).toBe(false)
    const lifted = judgeReading(snap([win('cycle', 100), win('on-demand', 20)]), cursor)
    expect(lifted.positive).toBe(true)
    expect(lifted.spent).toEqual([])
    expect(judgeReading(snap([win('cycle', 100), win('on-demand', 100)]), cursor).positive).toBe(false)
  })

  it('judges raw credit usage/limit without requiring a derived percentage', () => {
    const raw = { kind: 'credits', label: 'Credits', resetsAt: null, usage: 4, limit: 10 } as QuotaWindowReading
    expect(windowRemaining(raw)).toBe(60)
    expect(judgeReading(snap([raw]), quotaSemanticsFor('pi')).positive).toBe(true)
    expect(windowRemaining({ ...raw, usage: 10 })).toBe(0)
    expect(windowRemaining({ ...raw, usage: Number.NaN, usedPercent: 0 })).toBeNull()
    expect(windowRemaining({ ...raw, usage: Number.POSITIVE_INFINITY })).toBeNull()
    expect(windowRemaining({ ...raw, limit: 0 })).toBeNull()
    expect(windowRemaining({ ...raw, limit: null })).toBeNull()
    const balance = { kind: 'credits', label: 'Credits', resetsAt: null, balance: 3 } as QuotaWindowReading
    expect(judgeReading(snap([balance]), quotaSemanticsFor('kilo')).positive).toBe(true)
    expect(windowRemaining({ ...balance, balance: 0 })).toBe(0)
  })

  it('credits: kilo balance sign decides, pi needs a limit, uncapped is unknown', () => {
    expect(windowRemaining(win('credits', 0, null, { balance: 12.5 }))).toBe(100)
    expect(windowRemaining(win('credits', 0, null, { balance: 0 }))).toBe(0)
    expect(windowRemaining(win('credits', 40, null, { usage: 4, limit: 10 }))).toBe(60)
    expect(windowRemaining(win('credits', 0, null, { usage: 4, limit: null }))).toBeNull()

    const kilo = quotaSemanticsFor('kilo')
    expect(judgeReading(snap([win('credits', 0, null, { balance: 3 })]), kilo).positive).toBe(true)
    const empty = judgeReading(snap([win('credits', 0, null, { balance: 0 })]), kilo)
    expect(empty.positive).toBe(false)
    expect(empty.spent.map((w) => w.kind)).toEqual(['credits'])

    const pi = quotaSemanticsFor('pi')
    expect(judgeReading(snap([win('credits', 0, null, { usage: 4, limit: null })]), pi).positive).toBe(false)
    expect(judgeReading(snap([win('credits', 40, null, { usage: 4, limit: 10 })]), pi).positive).toBe(true)
  })

  it('a vendor without semantics can be seen spent but never positive', () => {
    expect(judgeReading(snap([win('session', 10)]), undefined).positive).toBe(false)
    expect(judgeReading(snap([win('session', 100)]), undefined).spent).toHaveLength(1)
  })

  it('answers nothing for a reading that is not ok, and skips expired windows', () => {
    expect(judgeReading(snap([], { status: 'not-measured' }), quotaSemanticsFor('claude')).positive).toBe(false)
    const v = judgeReading(snap([win('session', 100, NOW - H, { expired: true }), win('weekly', 5)]), quotaSemanticsFor('claude'))
    expect(v.spent).toEqual([])
    expect(v.missing).toEqual(['session'])
  })
})

describe('classifyFailure', () => {
  const c = (text: string, extra: Partial<Parameters<typeof classifyFailure>[0]> = {}) =>
    classifyFailure({ agentKey: 'claude', text, ...extra }, NOW)

  it('names the window and reset from the clocked Claude sentence', () => {
    const v = c("You've hit your limit · resets 3pm (Asia/Taipei)")
    expect(v.cause).toBe('quota-exhausted')
    expect(v.confidence).toBe('explicit')
    expect(v.resetAt).not.toBeNull()
  })

  it('a bare "hit your limit" is prose unless the reading agrees', () => {
    expect(c('I hit your limit of patience').cause).toBe('unknown')
    const spent = c("You've hit your limit", { reading: snap([win('session', 100), win('weekly', 10)]) })
    expect(spent.cause).toBe('quota-exhausted')
    expect(spent.confidence).toBe('corroborated')
    // A stale reading corroborates nothing.
    expect(c("You've hit your limit", { reading: snap([win('session', 100), win('weekly', 10)], { stale: true }) }).cause).toBe('unknown')
  })

  it('routes a generic 429 to rate-limited, not quota', () => {
    expect(c('', { httpStatus: 429 }).cause).toBe('rate-limited')
    expect(c('429 Too Many Requests, retry after 20s', { httpStatus: 429 })).toMatchObject({ cause: 'rate-limited', confidence: 'explicit' })
    expect(c('', { errorCode: 'rate_limit_exceeded' }).cause).toBe('rate-limited')
    expect(c('API overloaded, try again later').cause).toBe('rate-limited')
  })

  it('separates auth, network, context and payment failures from exhaustion', () => {
    expect(c('Error during compaction: Login expired · Please run /login').cause).toBe('auth')
    expect(c('', { httpStatus: 401 }).cause).toBe('auth')
    expect(c('Invalid API key provided').cause).toBe('auth')
    expect(c('fetch failed: ECONNREFUSED 127.0.0.1:443').cause).toBe('network')
    expect(c('Prompt is too long: 210000 tokens > 200000 maximum').cause).toBe('context')
    expect(c('', { errorCode: 'context_length_exceeded' }).cause).toBe('context')
    expect(c('Your credit balance is too low to access the API').cause).toBe('payment')
    expect(c('', { errorCode: 'insufficient_quota' }).cause).toBe('payment')
    expect(c('', { httpStatus: 402 }).cause).toBe('payment')
  })

  it('a billing or login sentence beside the word "limit" still wins', () => {
    expect(c('Rate limit reached: insufficient_quota, please add credits').cause).toBe('payment')
    expect(c('Usage limit reached — please run /login to continue').cause).toBe('auth')
  })

  it('generic quota wording is weak (notify only); a code or the vendor pattern is explicit', () => {
    const generic = c('Weekly limit reached. Resets Wednesday.')
    expect(generic).toMatchObject({ cause: 'quota-exhausted', confidence: 'weak' })
    expect(canTriggerAutoSwitch(generic)).toBe(false)
    expect(c('', { errorCode: 'usage_limit_reached' })).toMatchObject({ cause: 'quota-exhausted', confidence: 'explicit' })
    const declared = c('Plan usage exhausted', { agentKey: 'cursor', vendorLimitPattern: /plan usage exhausted/i })
    expect(declared).toMatchObject({ cause: 'quota-exhausted', confidence: 'explicit' })
    expect(canTriggerAutoSwitch(declared)).toBe(true)
    // Generic wording with the reading agreeing is corroborated, not explicit.
    expect(c('Weekly limit reached.', { reading: snap([win('session', 10), win('weekly', 100)]) }).confidence).toBe('corroborated')
    expect(c('You have 5% of your usage left this week').cause).toBe('low-quota-warning')
    expect(c('all good').cause).toBe('unknown')
  })

  it('reads the vendor\'s declared notice from its spec when no pattern is passed', () => {
    expect(quotaExhaustedPatternFor('claude')).toBeInstanceOf(RegExp)
    expect(quotaExhaustedPatternFor('codex')).toBeUndefined()
    // Claude's declared banner reaches explicit through the spec alone.
    expect(c("You've hit your limit · resets 3pm (Asia/Taipei)").confidence).toBe('explicit')
  })

  it('the clocked sentence is explicit for Claude only; another vendor quoting it is weak', () => {
    const text = "You've hit your limit · resets 3pm (Asia/Taipei)"
    // For codex the words are a bare "hit your limit" with nothing to back
    // them: not a verdict, and certainly not a reset time.
    expect(c(text, { agentKey: 'codex' })).toMatchObject({ cause: 'unknown', confidence: 'weak', resetAt: null })
    expect(c(text, { agentKey: 'muse' }).confidence).toBe('weak')
    expect(canTriggerAutoSwitch(c(text, { agentKey: 'codex' }))).toBe(false)
  })

  it('a positive reading taken AFTER the text overrules any limit sentence', () => {
    const observedAt = NOW - 5 * 60_000
    const reading = snap([win('session', 10), win('weekly', 10)], { fetchedAt: iso(NOW - 60_000) })
    const clocked = c("You've hit your limit · resets 3pm (Asia/Taipei)", { reading, observedAt })
    expect(clocked).toMatchObject({ cause: 'unknown', confidence: 'weak', resetAt: null })
    expect(c('Usage limit reached', { reading, observedAt })).toMatchObject({ cause: 'unknown', confidence: 'weak' })
    const cursor = snap([win('cycle', 10)], { fetchedAt: iso(NOW - 60_000) })
    expect(c('Plan usage exhausted', { agentKey: 'cursor', vendorLimitPattern: /plan usage exhausted/i, reading: cursor, observedAt }).cause).toBe('unknown')
  })

  it('a positive reading taken BEFORE a declared banner does not veto it — the poll has not caught up', () => {
    // Read 15 minutes ago, status ok, not stale; the banner printed just now.
    const reading = snap([win('session', 10), win('weekly', 10)], { fetchedAt: iso(NOW - 15 * 60_000) })
    const clocked = c("You've hit your limit · resets 3pm (Asia/Taipei)", { reading, observedAt: NOW })
    expect(clocked).toMatchObject({ cause: 'quota-exhausted', confidence: 'explicit' })
    expect(clocked.resetAt).not.toBeNull()
    expect(canTriggerAutoSwitch(clocked)).toBe(true)
    const cursor = snap([win('cycle', 10)], { fetchedAt: iso(NOW - 15 * 60_000) })
    expect(c('Plan usage exhausted', { agentKey: 'cursor', vendorLimitPattern: /plan usage exhausted/i, reading: cursor, observedAt: NOW })).toMatchObject({
      cause: 'quota-exhausted',
      confidence: 'explicit',
    })
    // Generic wording with an older positive reading stays weak either way.
    expect(c('Usage limit reached', { reading, observedAt: NOW })).toMatchObject({ cause: 'unknown', confidence: 'weak' })
    // Without an observation time the order is unknown, and an explicit
    // banner is not overruled by guesswork.
    expect(c("You've hit your limit · resets 3pm (Asia/Taipei)", { reading }).confidence).toBe('explicit')
  })

  it('a transcript that merely talks about quota never triggers a switch', () => {
    // A CLI writing this very feature prints every one of these phrases.
    for (const prose of [
      'I added a test that the badge lights when the usage limit reached message appears.',
      'The regex matches "quota exhausted" and "out of quota"; see cliUsageLimit.ts.',
      "Repro: You've hit your limit · resets 3pm (Asia/Taipei) — then the loop parks.",
    ]) {
      expect(canTriggerAutoSwitch(c(prose, { agentKey: 'codex' })), prose).toBe(false)
    }
  })
})

describe('exhaustion evidence', () => {
  const ev = (patch: Partial<ExhaustionEvidence> = {}): ExhaustionEvidence => ({
    agentKey: 'claude',
    authScope: 'anthropic',
    slotId: 'slot-a',
    epoch: 7,
    paneId: 'p1',
    sessionId: 's1',
    source: 'pane-text',
    observedAt: NOW,
    cause: 'quota-exhausted',
    windowKind: 'session',
    resetAt: NOW + H,
    ...patch,
  })
  const current = { slotId: 'slot-a', epoch: 7, authScope: 'anthropic' }

  it('is attributable only to the account and epoch it was observed under', () => {
    expect(evidenceIsAttributable(ev(), current)).toBe(true)
    // A late signal from a pane still on the previous credentials.
    expect(evidenceIsAttributable(ev({ epoch: 6 }), current)).toBe(false)
    expect(evidenceIsAttributable(ev({ slotId: 'slot-b' }), current)).toBe(false)
    expect(evidenceIsAttributable(ev({ authScope: 'other-org' }), current)).toBe(false)
    expect(evidenceIsAttributable(ev({ epoch: null }), current)).toBe(false)
    expect(evidenceIsAttributable(ev({ cause: 'rate-limited' }), current)).toBe(false)
  })

  it('collapses several panes hitting the same wall into one incident key', () => {
    const a = incidentKeyFor(ev({ paneId: 'p1' }))
    const b = incidentKeyFor(ev({ paneId: 'p2', sessionId: 's2', resetAt: NOW + H + 20_000 }))
    expect(a).toBe(b)
    // A new hit after that reset, or under a new epoch, is a new incident.
    expect(incidentKeyFor(ev({ resetAt: NOW + 6 * H }))).not.toBe(a)
    expect(incidentKeyFor(ev({ epoch: 8 }))).not.toBe(a)
    expect(incidentKeyFor(ev({ windowKind: 'weekly', resetAt: NOW + 6 * H }))).not.toBe(a)
  })
})

describe('rankCandidates — exclusions', () => {
  it('excludes the current account, wrong scope, tried, and every login state that is not signed in', () => {
    const r = rankCandidates(ctx({ triedSlotIds: ['tried'] }), [
      cand('slot-a'),
      cand('other', { authScope: 'other-org' }),
      cand('out', { login: 'signed-out' }),
      cand('exp', { login: 'expired' }),
      cand('pend', { login: 'login-pending' }),
      cand('tried'),
      cand('ok'),
    ])
    expect(r.excluded.map((e) => [e.slotId, e.reason])).toEqual([
      ['slot-a', 'current'],
      ['other', 'wrong-scope'],
      ['out', 'signed-out'],
      ['exp', 'expired'],
      ['pend', 'login-pending'],
      ['tried', 'tried'],
    ])
    expect(r.eligible.map((e) => e.slotId)).toEqual(['ok'])
    expect(noCandidateReasons(r)).toEqual(['expired', 'login-pending', 'signed-out', 'tried', 'wrong-scope'])
  })

  it('treats the built-in default slot as an account, not as "no account"', () => {
    const r = rankCandidates(ctx({ currentSlotId: 'slot-b' }), [
      cand(DEFAULT_SLOT_ID, { reading: fresh(DEFAULT_SLOT_ID, [win('session', 20), win('weekly', 30)]) }),
      cand('slot-b'),
    ])
    expect(r.eligible).toHaveLength(1)
    expect(r.eligible[0]).toMatchObject({ slotId: '__default__', tier: 'fresh-headroom' })
  })

  it('the exhausted slot itself is excluded as current even when it is the default', () => {
    const r = rankCandidates(ctx({ currentSlotId: DEFAULT_SLOT_ID }), [cand(DEFAULT_SLOT_ID), cand('b')])
    expect(r.excluded).toEqual([{ slotId: '__default__', reason: 'current', spentWindows: [], resetExpectedAt: null }])
  })

  it('a reading that says no-credentials / expired excludes the slot', () => {
    const r = rankCandidates(ctx(), [
      cand('nc', { reading: { slotId: 'nc', epoch: 7, observedAt: NOW, snapshot: snap([], { status: 'no-credentials' }) } }),
      cand('ex', { reading: { slotId: 'ex', epoch: 7, observedAt: NOW, snapshot: snap([], { status: 'expired' }) } }),
    ])
    expect(r.excluded.map((e) => e.reason)).toEqual(['signed-out', 'expired'])
  })
})

describe('rankCandidates — hard limits', () => {
  it('a spent weekly window vetoes a 5h window that has already reset', () => {
    const r = rankCandidates(ctx(), [
      cand('b', {
        exhaustedWindows: [
          { kind: 'session', exhaustedAt: NOW - 6 * H, resetsAt: NOW - H },
          { kind: 'weekly', exhaustedAt: NOW - 6 * H, resetsAt: NOW + 48 * H },
        ],
      }),
    ])
    expect(r.eligible).toEqual([])
    expect(r.excluded[0]).toEqual({
      slotId: 'b',
      reason: 'limit-not-reset',
      spentWindows: ['session', 'weekly'],
      resetExpectedAt: NOW + 48 * H,
    })
  })

  it('a spent window with no known reset blocks until a reading says otherwise', () => {
    const r = rankCandidates(ctx(), [cand('b', { exhaustedWindows: [{ kind: 'session', exhaustedAt: NOW - H, resetsAt: null }] })])
    expect(r.excluded[0]).toMatchObject({ reason: 'limit-not-reset', resetExpectedAt: null })
  })

  it('a spent window in the slot\'s own current reading excludes it', () => {
    const r = rankCandidates(ctx(), [cand('b', { reading: fresh('b', [win('session', 100, NOW + 2 * H), win('weekly', 10)]) })])
    expect(r.excluded[0]).toMatchObject({ reason: 'limit-not-reset', spentWindows: ['session'], resetExpectedAt: NOW + 2 * H })
  })

  it('a later current reading that re-measured the window supersedes the ledger record', () => {
    const r = rankCandidates(ctx(), [
      cand('b', {
        exhaustedWindows: [{ kind: 'weekly', exhaustedAt: NOW - 3 * H, resetsAt: NOW + 48 * H }],
        reading: fresh('b', [win('session', 20), win('weekly', 35)]),
      }),
    ])
    expect(r.eligible[0]).toMatchObject({ slotId: 'b', tier: 'fresh-headroom' })
  })

  it('a reading that did not measure the window leaves the record standing', () => {
    const r = rankCandidates(ctx({ agentKey: 'kimi' }), [
      cand('b', {
        exhaustedWindows: [{ kind: 'session', exhaustedAt: NOW - H, resetsAt: NOW + H }],
        reading: fresh('b', [win('weekly', 35)]),
      }),
    ])
    expect(r.excluded[0]).toMatchObject({ reason: 'limit-not-reset', spentWindows: ['session'] })
  })

  it('an older snapshot whose reset passed does not lift a newer ledger veto', () => {
    // The ledger says weekly is out until +48h (or nobody knows); the slot's
    // own snapshot — possibly older — shows weekly spent with a reset that
    // has passed. The more conservative witness stands.
    const stale = (windows: QuotaWindowReading[]) => fresh('b', windows, { snapshot: snap(windows, { stale: true }) })
    const future = rankCandidates(ctx(), [
      cand('b', {
        exhaustedWindows: [{ kind: 'weekly', exhaustedAt: NOW - 2 * H, resetsAt: NOW + 48 * H }],
        reading: stale([win('session', 10), win('weekly', 100, NOW - H)]),
      }),
    ])
    expect(future.excluded[0]).toMatchObject({ reason: 'limit-not-reset', spentWindows: ['weekly'], resetExpectedAt: NOW + 48 * H })
    const unknown = rankCandidates(ctx(), [
      cand('b', {
        exhaustedWindows: [{ kind: 'weekly', exhaustedAt: NOW - 2 * H, resetsAt: null }],
        reading: stale([win('session', 10), win('weekly', 100, NOW - H)]),
      }),
    ])
    expect(unknown.excluded[0]).toMatchObject({ reason: 'limit-not-reset', resetExpectedAt: null })
  })

  it('limit-not-reset is reported ahead of tried', () => {
    const r = rankCandidates(ctx({ triedSlotIds: ['b'] }), [
      cand('b', { exhaustedWindows: [{ kind: 'weekly', exhaustedAt: NOW - H, resetsAt: NOW + H }] }),
    ])
    expect(r.excluded[0].reason).toBe('limit-not-reset')
  })
})

describe('rankCandidates — tiers', () => {
  it('orders fresh-headroom > reset-expected > stale-headroom > unknown', () => {
    const r = rankCandidates(ctx(), [
      cand('unknown'),
      cand('stale', { reading: fresh('stale', [win('session', 20), win('weekly', 20)], { observedAt: NOW - DEFAULT_FRESH_WINDOW_MS - 1 }) }),
      cand('reset', { exhaustedWindows: [{ kind: 'session', exhaustedAt: NOW - 6 * H, resetsAt: NOW - H }] }),
      cand('fresh', { reading: fresh('fresh', [win('session', 50), win('weekly', 50)]) }),
    ])
    expect(r.eligible.map((e) => [e.slotId, e.tier])).toEqual([
      ['fresh', 'fresh-headroom'],
      ['reset', 'reset-expected'],
      ['stale', 'stale-headroom'],
      ['unknown', 'unknown'],
    ])
    expect(r.eligible[1].resetPassedAt).toBe(NOW - H)
    expect(r.eligible[3]).toMatchObject({ weakestRemaining: null, observedAt: null })
  })

  it('a reset that has passed is "expected", never above a fresh positive reading', () => {
    // The slot with the reset passed has no reading at all; the fresh one
    // measured 5% headroom. Evidence beats a guess.
    const r = rankCandidates(ctx(), [
      cand('reset', { exhaustedWindows: [{ kind: 'weekly', exhaustedAt: NOW - 48 * H, resetsAt: NOW - H }] }),
      cand('fresh', { reading: fresh('fresh', [win('session', 95), win('weekly', 60)]) }),
    ])
    expect(r.eligible.map((e) => e.slotId)).toEqual(['fresh', 'reset'])
  })

  it('a reading from an earlier epoch is stale, however recent', () => {
    const r = rankCandidates(ctx({ currentEpoch: 8 }), [
      cand('b', { reading: fresh('b', [win('session', 20), win('weekly', 20)], { epoch: 7 }) }),
      cand('c', { reading: fresh('c', [win('session', 20), win('weekly', 20)], { epoch: null }) }),
    ])
    expect(r.eligible.map((e) => e.tier)).toEqual(['stale-headroom', 'stale-headroom'])
  })

  it('a reading stamped in the future or with a non-finite time is never fresh', () => {
    const r = rankCandidates(ctx(), [
      cand('future', { reading: fresh('future', [win('session', 20), win('weekly', 20)], { observedAt: NOW + 60_000 }) }),
      cand('nan', { reading: fresh('nan', [win('session', 20), win('weekly', 20)], { observedAt: Number.NaN }) }),
      cand('inf', { reading: fresh('inf', [win('session', 20), win('weekly', 20)], { observedAt: Number.NEGATIVE_INFINITY }) }),
      cand('edge', { reading: fresh('edge', [win('session', 20), win('weekly', 20)], { observedAt: NOW }) }),
    ])
    expect(r.eligible.map((e) => [e.slotId, e.tier])).toEqual([
      ['edge', 'fresh-headroom'],
      ['future', 'stale-headroom'],
      ['inf', 'stale-headroom'],
      ['nan', 'stale-headroom'],
    ])
  })

  it('a stale / refresh-pending snapshot is at best stale-headroom, and only when positive', () => {
    const r = rankCandidates(ctx(), [
      cand('s', { reading: fresh('s', [win('session', 20), win('weekly', 20)], { snapshot: snap([win('session', 20), win('weekly', 20)], { stale: true }) }) }),
      cand('p', { reading: fresh('p', [win('session', 20), win('weekly', 20)], { snapshot: snap([win('session', 20), win('weekly', 20)], { refreshPending: true }) }) }),
      cand('m', { reading: fresh('m', [win('session', 20)]) }),
    ])
    expect(r.eligible.map((e) => [e.slotId, e.tier])).toEqual([
      ['p', 'stale-headroom'],
      ['s', 'stale-headroom'],
      ['m', 'unknown'],
    ])
    expect(r.eligible[2].missingWindows).toEqual(['weekly'])
  })

  it('never lets the active provider snapshot speak for a parked slot', () => {
    // The caller mistakenly hands slot-b the reading of slot-a (the provider
    // snapshot). It names slot-a, so it is discarded: b stays unknown.
    const r = rankCandidates(ctx(), [cand('b', { reading: fresh('slot-a', [win('session', 5), win('weekly', 5)]) })])
    expect(r.eligible[0]).toMatchObject({ slotId: 'b', tier: 'unknown' })
  })

  it('parked Claude accounts (not-measured) are unknown, not healthy', () => {
    const r = rankCandidates(ctx(), [
      cand('b', { reading: { slotId: 'b', epoch: 7, observedAt: NOW, snapshot: snap([], { status: 'not-measured' }) } }),
    ])
    expect(r.eligible[0].tier).toBe('unknown')
  })

  it('a vendor with no declared semantics cannot rank above unknown on a reading', () => {
    const r = rankCandidates(ctx({ agentKey: 'muse' }), [cand('b', { reading: fresh('b', [win('session', 5)]) })])
    expect(r.eligible[0].tier).toBe('unknown')
  })
})

describe('rankCandidates — ties and determinism', () => {
  it('within a tier: weakest-window headroom, then newer reading, then slot id', () => {
    const r = rankCandidates(ctx(), [
      cand('c', { reading: fresh('c', [win('session', 10), win('weekly', 60)]) }),
      cand('b', { reading: fresh('b', [win('session', 50), win('weekly', 50)]) }),
      cand('a', { reading: fresh('a', [win('session', 10), win('weekly', 60)], { observedAt: NOW - 5 * 60_000 }) }),
      cand('d', { reading: fresh('d', [win('session', 60), win('weekly', 10)], { observedAt: NOW - 5 * 60_000 }) }),
    ])
    // b's weakest window keeps 50%; c, a and d all bottom out at 40%. c's
    // reading is the newest of those; a and d share figure and age, so the
    // slot id decides.
    expect(r.eligible.map((e) => e.slotId)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('is stable across input order and duplicate slots', () => {
    const input = [
      cand('b', { reading: fresh('b', [win('session', 50), win('weekly', 50)]) }),
      cand('a', { reading: fresh('a', [win('session', 50), win('weekly', 50)]) }),
      cand('b'),
    ]
    const forward = rankCandidates(ctx(), input)
    const reversed = rankCandidates(ctx(), [...input].reverse())
    expect(forward.eligible.map((e) => e.slotId)).toEqual(['a', 'b'])
    // Reversed input lists the reading-less 'b' first, so that one is kept;
    // ranking still never lists a slot twice.
    expect(reversed.eligible.map((e) => e.slotId).sort()).toEqual(['a', 'b'])
    expect(new Set(reversed.eligible.map((e) => e.slotId)).size).toBe(2)
  })

  it('does not compare percentages across vendors — the context is one vendor', () => {
    const claude = rankCandidates(ctx(), [cand('b', { reading: fresh('b', [win('session', 50), win('weekly', 50)]) })])
    const grok = rankCandidates(ctx({ agentKey: 'grok' }), [cand('b', { reading: fresh('b', [win('monthly', 50)]) })])
    expect(claude.eligible[0].tier).toBe('fresh-headroom')
    expect(grok.eligible[0].tier).toBe('fresh-headroom')
    // A grok reading judged under claude semantics is not positive: it lacks
    // claude's windows. Same numbers, different vendor, different answer.
    expect(rankCandidates(ctx(), [cand('b', { reading: fresh('b', [win('monthly', 50)]) })]).eligible[0].tier).toBe('unknown')
  })
})

describe('pickAutoCandidate', () => {
  it('lists an unknown login for the user but never proposes it automatically', () => {
    const r = rankCandidates(ctx(), [
      cand('mystery', { login: 'unknown', reading: fresh('mystery', [win('session', 5), win('weekly', 5)]) }),
      cand('known'),
    ])
    expect(r.eligible.map((e) => [e.slotId, e.login])).toEqual([
      ['mystery', 'unknown'],
      ['known', 'signed-in'],
    ])
    // The signed-in candidate is picked over the better-ranked unknown login.
    expect(pickAutoCandidate(r)?.slotId).toBe('known')
    expect(pickAutoCandidate(rankCandidates(ctx(), [cand('mystery', { login: 'unknown' })]))).toBeNull()
  })

  it('takes the first eligible, and an unknown one at most once per incident', () => {
    const known = rankCandidates(ctx(), [cand('b', { reading: fresh('b', [win('session', 50), win('weekly', 50)]) }), cand('c')])
    expect(pickAutoCandidate(known)?.slotId).toBe('b')
    const onlyUnknown = rankCandidates(ctx(), [cand('c')])
    expect(pickAutoCandidate(onlyUnknown)?.slotId).toBe('c')
    expect(pickAutoCandidate(onlyUnknown, { unknownAttempted: true })).toBeNull()
    expect(pickAutoCandidate(rankCandidates(ctx(), []))).toBeNull()
  })
})


// Shared with backend/tests/test_quota_failover.py: actual payload shapes and
// the same observation clock, not a second copy of the vendor declarations.
const readingContract = JSON.parse(readFileSync(resolve(process.cwd(), 'tests/fixtures/quota-reading-contract.json'), 'utf8')) as {
  now: string
  cases: { name: string; agentKey: string; windows: QuotaWindowReading[]; spent: boolean; positive: boolean }[]
}
describe('shared quota reading contract', () => {
  it.each(readingContract.cases)('$name', (row) => {
    const verdict = judgeReading(snap(row.windows, { provider: row.agentKey }), quotaSemanticsFor(row.agentKey), Date.parse(readingContract.now))
    expect(verdict.spent.length > 0).toBe(row.spent)
    expect(verdict.positive).toBe(row.positive)
  })
})
