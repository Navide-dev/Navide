// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { judgeReading, quotaSemanticsFor } from '../../lib/quotaFailover'
import { readingIsCurrent, hasHeadlineHeadroom, exhaustedWindow, type UsageSnapshot } from '../../composables/useUsage'
import { LIMIT_RESET_BUFFER_MS } from '../../lib/loopPrompt'
import { detectUsageLimit, QUOTA_READING_VETO, usageLimitDue, usageResumeAt } from '../../lib/cliUsageLimit'
vi.mock('@navide/plugin-ui/shared', () => ({ settingsGet: (_: string, fallback: unknown) => fallback, settingsSet: vi.fn() }))
import { loopBackoffMs, loopContinueReady, loopInjectFailures, loopSettleMs, loopStallVerdict, loopWaitingOnSubagents, LOOP_INJECT_FAIL_LIMIT } from '../../lib/completion'
import {
  LOOP_FAILOVER_RESUME_SETTING_KEY,
  LOOP_FAILOVER_RESUME_TIMEOUT_MS,
  loopFailoverResumeStep,
  shouldResumeLoopAfterFailover,
} from '../../lib/loopFailoverResume'

// Execute the actual App functions, with IO replaced at their boundaries.
// Mounting App would start terminal/backend lifecycles; copying the functions
// would hide the timer/consumer regression these tests need to catch.
const source = parse(readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')).descriptor.scriptSetup!.content
const ast = ts.createSourceFile('App.ts', source, ts.ScriptTarget.Latest, true)
const names = [
  'fireLoopResume', 'fireLoopContinue', 'startLoopLimitWatcher',
  'clearPaneUsageLimit', 'clearPaneUsageLimits', 'dismissPaneUsageLimit',
  'resumeLoopNow', 'continueRestoredPane', 'paneUsageLimited',
  'resumeLoopAfterFailover', 'loopResumesAfterFailover', 'verifiedHotSwitchedPanes',
]
function appFunctions(names: string[], scope: Record<string, unknown>) {
  const selected = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''))
  const missing = names.filter((name) => !selected.some((node) => (node as ts.FunctionDeclaration).name?.text === name))
  if (missing.some((name) => !['paneQuotaReading', 'verifiedHotSwitchedPanes'].includes(name))) throw new Error('Missing App quota/loop declaration')
  const js = ts.transpileModule(selected.map((node) => node.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return new Function(...Object.keys(scope), `${js}\nreturn { ${names.filter((name) => !missing.includes(name)).join(',')} }`)(...Object.values(scope)) as Record<string, (...args: any[]) => any>
}

function backendHandler(event: string, scope: Record<string, unknown>) {
  const registration = ast.statements.find((node) => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
    node.expression.expression.getText(ast) === 'backend.on' && node.expression.arguments[0]?.getText(ast) === `'${event}'`) as ts.ExpressionStatement
  const callback = (registration.expression as ts.CallExpression).arguments[1]
  const js = ts.transpileModule(`const handler = ${callback.getText(ast)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(scope), `${js}\nreturn handler`)(...Object.values(scope)) as (payload: unknown) => void
}

function quotaCommitHandler(scope: Record<string, unknown>) {
  const registration = ast.statements.find((node) => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
    node.expression.expression.getText(ast) === 'quotaFailover.initQuotaFailover') as ts.ExpressionStatement
  const hooks = (registration.expression as ts.CallExpression).arguments[1] as ts.ObjectLiteralExpression
  const callback = (hooks.properties.find((node) => node.name?.getText(ast) === 'onSwitchCommitted') as ts.PropertyAssignment).initializer
  const js = ts.transpileModule(`const handler = ${callback.getText(ast)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(scope), `${js}\nreturn handler`)(...Object.values(scope)) as (payload: unknown) => void
}

/** Scope for loopResumesAfterFailover: the opt-in setting and the policy. */
function loopFailoverScope(enabled: boolean, mode = 'auto') {
  return {
    settingsGet: (key: string, fallback: unknown) => (key === LOOP_FAILOVER_RESUME_SETTING_KEY ? enabled : fallback),
    LOOP_FAILOVER_RESUME_SETTING_KEY, shouldResumeLoopAfterFailover, loopFailoverResumeStep,
    quotaFailover: { state: { value: { policy: { mode } } } },
  }
}

function harness(opts: { loopFailoverResume?: boolean } = {}) {
  const now = Date.now()
  const panes = ref([{
    id: 'p1', agentKey: 'claude', loopActive: true, loopWaitUntil: now + 5000 as number | null,
    usageLimitAt: now as number | null, usageLimitUntil: now + 5000 as number | null,
    quotaGateIncidentId: 'inc' as string | null, resumeContinueAvailable: false,
  }])
  const pane = panes.value[0]
  const watchers = new Map<string, Record<string, any>>()
  const acquire = vi.fn(async () => {})
  const inject = vi.fn(async (_id: string, _text: string, _label: string, _newlines: boolean, abort?: () => boolean) => {
    if (abort?.()) return false
    pane.resumeContinueAvailable = false
    return true
  })
  const scope = {
    panes, paneRefs: { p1: { displayStatus: 'idle', cleanBuffer: '' } },
    paneHealthWatchers: new Map(), paneCleanBytes: () => 0, usageFor: () => undefined,
    stopLoopLimitWatcher: vi.fn(), loopLimitWatchers: watchers, LOOP_LIMIT_POLL_MS: 5000,
    loopStallVerdict, loopContinueReady, loopSettleMs, loopWaitingOnSubagents, loopBackoffMs,
    loopInjectFailures, LOOP_INJECT_FAIL_LIMIT,
    stopLoopSpinning: vi.fn(), panePendingSubagents: new Map(),
    paneTurnCompleteAt: new Map([['p1', now - 10000]]), paneLastWorkingAt: new Map([['p1', now - 20000]]),
    VENDORS_WITHOUT_TURN_END: new Set(), TURN_COMPLETE_SETTLE_MS: 2000,
    loopGen: new Map([['p1', 1]]), acquireInjectionSlot: acquire, releaseInjectionSlot: vi.fn(),
    injectPane: inject, withLoopDoneInstruction: (s: string) => s, loopResumeTextFor: () => 'continue',
    LOOP_ESTIMATE_WINDOW_MS: 18000000, armLoopTurn: vi.fn(), stopLoopComplete: vi.fn(),
    continueInFlight: new Set(), messagingHoldKey: () => null,
    LOOP_RESUME_SETTING_KEY: 'loop-resume', DEFAULT_LOOP_RESUME: 'continue',
    loopFailoverResumeArmed: new Map<string, number>(),
    ...loopFailoverScope(!!opts.loopFailoverResume),
  }
  const fns = appFunctions(names, scope)
  fns.startLoopLimitWatcher('p1')
  watchers.get('p1')!.armedAt = now - 30000
  const commit = quotaCommitHandler({ ...scope, ...fns })
  return { pane, fns, watchers, acquire, inject, commit, armed: scope.loopFailoverResumeArmed }
}

const hotCommit = { agentKey: 'claude', incidentId: 'inc', switchMode: 'hot', restartStrategy: 'none', state: 'committed', toSlotId: 'b', panes: [{ paneId: 'p1' }] }

describe('loop resume after an automatic failover switch (opt-in)', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-21T10:01:00Z')) })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

  it('resumes the loop once the switch clears the flag, with no Continue button', async () => {
    const h = harness({ loopFailoverResume: true })
    h.commit(hotCommit)
    expect(h.pane.resumeContinueAvailable).toBe(false)
    h.fns.clearPaneUsageLimit(h.pane, 'account-switch', true, { resumeLoop: false })
    expect(h.pane.resumeContinueAvailable).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.inject).toHaveBeenCalledTimes(1)
    expect(h.inject.mock.calls[0][2]).toBe('loop-failover-resume')
    expect(h.pane.loopWaitUntil).toBeNull()
    expect(h.pane.resumeContinueAvailable).toBe(false)
    expect(h.armed.has('p1')).toBe(false)
  })

  it('does not resume while the exhausted flag is still lit', async () => {
    const h = harness({ loopFailoverResume: true })
    h.commit(hotCommit)
    await vi.advanceTimersByTimeAsync(10000)
    expect(h.inject).not.toHaveBeenCalled()
    expect(h.armed.has('p1')).toBe(true)
  })

  it('falls back to the Continue button when the switch never settles', async () => {
    const h = harness({ loopFailoverResume: true })
    h.commit(hotCommit)
    await vi.advanceTimersByTimeAsync(LOOP_FAILOVER_RESUME_TIMEOUT_MS + 5000)
    expect(h.inject).not.toHaveBeenCalled()
    expect(h.pane.resumeContinueAvailable).toBe(true)
    expect(h.armed.has('p1')).toBe(false)
  })

  it('restores the parked wait and offers Continue when the resume cannot be typed', async () => {
    const h = harness({ loopFailoverResume: true })
    const parked = h.pane.loopWaitUntil
    h.inject.mockResolvedValueOnce(false)
    h.commit(hotCommit)
    h.fns.clearPaneUsageLimit(h.pane, 'account-switch', true, { resumeLoop: false })
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.inject).toHaveBeenCalledTimes(1)
    expect(h.pane.loopWaitUntil).toBe(parked)
    expect(h.pane.resumeContinueAvailable).toBe(true)
  })

  it('keeps the existing Continue offer when the setting is off', async () => {
    const h = harness()
    h.commit(hotCommit)
    expect(h.pane.resumeContinueAvailable).toBe(true)
    h.fns.clearPaneUsageLimit(h.pane, 'account-switch', true, { resumeLoop: false })
    await vi.advanceTimersByTimeAsync(10000)
    expect(h.inject).not.toHaveBeenCalled()
    expect(h.armed.size).toBe(0)
  })
})

describe('App quota failover loop consumers', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-21T10:01:00Z')) })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

  it('keeps the old reset deadline parked after a failover clears the badge', async () => {
    const h = harness()
    h.fns.clearPaneUsageLimit(h.pane, 'account-switch', true, { resumeLoop: false })
    expect(h.pane.resumeContinueAvailable).toBe(true)
    await vi.advanceTimersByTimeAsync(10000)
    expect(h.inject).not.toHaveBeenCalled()
    expect(h.pane.loopWaitUntil).not.toBeNull()
  })

  it('keeps an unknown-reset loop parked after clearing its badge', async () => {
    const h = harness()
    h.pane.loopWaitUntil = null
    h.pane.usageLimitUntil = null
    h.fns.clearPaneUsageLimit(h.pane, 'account-switch', true, { resumeLoop: false })
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.inject).not.toHaveBeenCalled()
    expect(h.pane.resumeContinueAvailable).toBe(true)
  })

  it('verification alone does not accept the manual continue offer', async () => {
    const h = harness()
    h.fns.clearPaneUsageLimit(h.pane, 'account-switch', true, { resumeLoop: false })
    h.pane.quotaGateIncidentId = null
    await vi.advanceTimersByTimeAsync(10000)
    expect(h.inject).not.toHaveBeenCalled()
  })

  it.each(['fireLoopResume', 'fireLoopContinue'])('%s guards its own injection entrypoint', async (name) => {
    const h = harness()
    await h.fns[name]('p1', 'loop-resume')
    expect(h.acquire).not.toHaveBeenCalled()
    expect(h.inject).not.toHaveBeenCalled()
  })

  it.each(['fireLoopResume', 'fireLoopContinue'])('%s rechecks a commit received while awaiting the injection slot', async (name) => {
    const h = harness()
    h.pane.quotaGateIncidentId = null
    let release!: () => void
    h.acquire.mockImplementationOnce(() => new Promise<void>((r) => { release = r }))
    const pending = h.fns[name]('p1', 'loop-resume')
    h.pane.quotaGateIncidentId = 'new-incident'
    h.pane.resumeContinueAvailable = true
    release()
    await pending
    expect(h.inject).not.toHaveBeenCalled()
  })

  it.each(['fireLoopResume', 'fireLoopContinue'])('%s cancels a delayed submit when a commit arrives during injection', async (name) => {
    const h = harness()
    h.pane.quotaGateIncidentId = null
    h.inject.mockImplementationOnce(async (_id, _text, _label, _newlines, abort) => {
      expect(abort?.()).toBe(false)
      h.pane.quotaGateIncidentId = 'new-incident'
      expect(abort?.()).toBe(true)
      return false
    })
    await h.fns[name]('p1', 'loop-resume')
    expect(h.inject).toHaveBeenCalledTimes(1)
  })

  it.each(['fireLoopResume', 'fireLoopContinue'])('%s still continues a normal loop with no failover hold', async (name) => {
    const h = harness()
    h.pane.quotaGateIncidentId = null
    await h.fns[name]('p1', 'loop-resume')
    expect(h.inject).toHaveBeenCalledTimes(1)
  })

  it('a user resume-now action can retry while recovery is still unverified', async () => {
    const h = harness()
    h.pane.resumeContinueAvailable = true
    h.fns.resumeLoopNow('p1')
    await Promise.resolve()
    expect(h.inject).toHaveBeenCalledTimes(1)
    expect(h.pane.quotaGateIncidentId).toBe('inc')
  })

  it('the manual continue button can retry while keeping the pipeline gate until proof', async () => {
    const h = harness()
    h.pane.resumeContinueAvailable = true
    await h.fns.continueRestoredPane('p1')
    expect(h.inject).toHaveBeenCalledWith('p1', 'continue', 'continue-button', true)
    expect(h.pane.quotaGateIncidentId).toBe('inc')
  })

  it('a manual account switch preserves its immediate loop resume', async () => {
    const h = harness()
    h.pane.resumeContinueAvailable = true
    h.fns.clearPaneUsageLimits('claude', 'other', { resumeLoop: true })
    await Promise.resolve()
    expect(h.inject).toHaveBeenCalledTimes(1)
  })

  it('explicit badge dismissal preserves its immediate loop resume', async () => {
    const h = harness()
    h.pane.resumeContinueAvailable = true
    h.fns.dismissPaneUsageLimit('p1')
    await Promise.resolve()
    expect(h.inject).toHaveBeenCalledTimes(1)
  })
})


describe('App quota reading consumers and gate authority', () => {
  const now = Date.parse('2026-09-21T12:00:00Z')
  function reading(agentKey = 'claude', windows = [
    { kind: 'session', usedPercent: 10, label: '5h', resetsAt: null },
    { kind: 'weekly', usedPercent: 20, label: '7d', resetsAt: null },
  ]): UsageSnapshot {
    return { provider: agentKey, status: 'ok', planType: null, error: null, fetchedAt: new Date(now).toISOString(), windows }
  }
  function consumer(snapshot: UsageSnapshot | undefined, profileId: string | null | undefined = 'slot-a') {
    const pane = { id: 'p1', agentKey: snapshot?.provider ?? 'claude', profileId: profileId as string | null | undefined, workspacePath: '/ws', usageLimitAt: null as number | null, quotaGateIncidentId: 'inc' as string | null }
    const report = vi.fn()
    const clear = vi.fn()
    const account = vi.fn((_agent: string, slot: string | null) => slot === 'slot-a' || slot === null || slot === '__default__' ? snapshot : undefined)
    const fns = appFunctions(['paneQuotaReading', 'raiseFromQuotaReading', 'checkPaneUsageLimit', 'releaseQuotaGate'], {
      panes: ref([pane]), accountUsageFor: account, usageFor: () => reading(),
      readingIsCurrent, judgeReading, quotaSemanticsFor, LIMIT_RESET_BUFFER_MS,
      hasHeadlineHeadroom, exhaustedWindow, usageResumeAt, cliProfilesApi: { defaultProfileId: () => 'slot-a' },
      isDismissedUsageLimit: () => false, quotaFailover: { report },
      clearPaneUsageLimit: clear, usageLimitDue, unseenTail: (s: string) => s,
      detectUsageLimit, QUOTA_READING_VETO, PANE_HEALTH_TAIL_CHARS: 2000,
    })
    return { pane, report, clear, account, fns }
  }
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now) })
  afterEach(() => vi.useRealTimers())

  it.each([
    ['cursor', { kind: 'cycle', usedPercent: 100 }],
    ['kilo', { kind: 'credits', balance: 0 }],
    ['pi', { kind: 'credits', limit: 100, usage: 100 }],
  ])('reports %s exhaustion from its declared hard window with no text', (agentKey, window) => {
    const snap = reading(agentKey as string, [{ ...window, label: 'Quota', resetsAt: '2026-09-22T00:00:00Z' }] as never)
    const h = consumer(snap)
    h.fns.checkPaneUsageLimit(h.pane, '', 0, {})
    expect(h.report).toHaveBeenCalledWith(expect.objectContaining({ agentKey, source: 'usage-window', windowKind: window.kind }))
    expect(h.pane.usageLimitAt).toBe(now)
    expect(h.pane.quotaGateIncidentId).toBe('inc')
  })

  it.each([
    ['pi', { kind: 'credits', usage: 4, limit: 10 }],
    ['kilo', { kind: 'credits', balance: 3 }],
  ])('accepts current raw %s headroom only for a normal badge', (agentKey, window) => {
    const h = consumer(reading(agentKey as string, [{ ...window, label: 'Credits', resetsAt: null }] as never))
    h.pane.usageLimitAt = now
    h.fns.checkPaneUsageLimit(h.pane, '', 0, {})
    expect(h.clear).toHaveBeenCalledTimes(1)
    expect(h.pane.quotaGateIncidentId).toBe('inc')
  })

  it.each([
    { usage: Number.NaN, limit: 10 }, { usage: 10, limit: null }, { balance: Number.NaN },
    { usage: -1, limit: 10 }, { usedPercent: -1, limit: 10 },
  ])('unknown/nonfinite raw credits neither clear nor report: %s', (window) => {
    const h = consumer(reading('pi', [{ kind: 'credits', ...window, label: 'Credits', resetsAt: null }] as never))
    h.fns.checkPaneUsageLimit(h.pane, '', 0, {})
    expect(h.report).not.toHaveBeenCalled()
    h.pane.usageLimitAt = now
    h.fns.checkPaneUsageLimit(h.pane, '', 0, {})
    expect(h.clear).not.toHaveBeenCalled()
    expect(h.pane.quotaGateIncidentId).toBe('inc')
  })

  it.each(['missing-weekly', 'stale', 'refreshPending', 'expired-window', 'reset-passed', 'wrong-slot', 'unknown-slot', 'missing-slot'])('%s is not evidence to clear the badge or failover gate', (invalid) => {
    const snap = reading()
    if (invalid === 'missing-weekly') snap.windows.pop()
    if (invalid === 'stale') snap.stale = true
    if (invalid === 'refreshPending') snap.refreshPending = true
    if (invalid === 'expired-window') snap.windows[1].expired = true
    if (invalid === 'reset-passed') snap.windows[1].resetsAt = new Date(now - 1).toISOString()
    const h = consumer(invalid === 'missing-slot' ? undefined : snap, invalid === 'wrong-slot' ? 'old-slot' : 'slot-a')
    if (invalid === 'unknown-slot') h.pane.profileId = undefined
    h.pane.usageLimitAt = now
    h.fns.checkPaneUsageLimit(h.pane, '', 0, {})
    expect(h.clear).not.toHaveBeenCalled()
    expect(h.pane.quotaGateIncidentId).toBe('inc')
    expect(h.report).not.toHaveBeenCalled()
  })

  it.each([null, '__default__'])('addresses an explicit default slot %s without substituting the active account', (slot) => {
    const h = consumer(reading(), slot)
    h.pane.usageLimitAt = now
    h.fns.checkPaneUsageLimit(h.pane, '', 0, {})
    expect(h.account).toHaveBeenCalledWith('claude', slot)
    expect(h.clear).toHaveBeenCalledWith(h.pane, 'quota-back', false)
  })

  it('complete current headroom clears a normal badge, while only validated ready releases the failover gate', () => {
    const h = consumer(reading())
    h.pane.usageLimitAt = now
    h.fns.checkPaneUsageLimit(h.pane, '', 0, {})
    expect(h.clear).toHaveBeenCalledWith(h.pane, 'quota-back', false)
    expect(h.pane.quotaGateIncidentId).toBe('inc')
    h.fns.releaseQuotaGate('unrelated-incident')
    expect(h.pane.quotaGateIncidentId).toBe('inc')
    h.fns.releaseQuotaGate('inc')
    // release uses reactive pane references; the actual consumer shares them.
    expect(h.pane.quotaGateIncidentId).toBeNull()
    h.pane.usageLimitAt = null
    h.fns.checkPaneUsageLimit(h.pane, '', 0, {})
    expect(h.report).not.toHaveBeenCalled()
  })

  it.each(['network error ECONNRESET', 'context window exceeded', 'please run /login', 'payment required', 'rate limit exceeded'])('does not report non-quota failure: %s', (text) => {
    const h = consumer(undefined)
    h.pane.quotaGateIncidentId = null
    h.fns.checkPaneUsageLimit(h.pane, text, text.length, { limitBaseline: 0 })
    expect(h.report).not.toHaveBeenCalled()
    expect(h.pane.usageLimitAt).toBeNull()
  })

  it('a retained old pane cannot borrow the new conversation account reading', () => {
    const snap = reading('cursor', [{ kind: 'cycle', usedPercent: 100, label: 'Cycle', resetsAt: null }])
    const retained = consumer(snap, 'old-slot')
    retained.fns.checkPaneUsageLimit(retained.pane, '', 0, {})
    expect(retained.report).not.toHaveBeenCalled()
    const fresh = consumer(snap, 'slot-a')
    fresh.fns.checkPaneUsageLimit(fresh.pane, '', 0, {})
    expect(fresh.report).toHaveBeenCalledTimes(1)
  })
})


describe('App quota spawn hooks', () => {
  it('passes the committed transaction into native resume while preserving scrollback and conversation', async () => {
    const rebuild = vi.fn(async (_id: string, opts: any) => { opts.onReplaced('new-pane') })
    const fns = appFunctions(['quotaRestartPane'], {
      rebuildPaneViaResume: rebuild, panes: ref([{ id: 'new-pane' }]),
      paneRefs: { 'new-pane': { sessionId: 'new-term' } }, paneResumeSessionId: () => 'expected-session',
    })
    const ev = { transactionId: 'tx-1', toSlotId: 'slot-b' }
    expect(await fns.quotaRestartPane({ paneId: 'old-pane' }, ev)).toEqual({ outcome: 'resumed', paneId: 'new-pane', termId: 'new-term', sessionId: 'expected-session' })
    expect(rebuild).toHaveBeenCalledWith('old-pane', expect.objectContaining({ quotaCommit: ev, preserveScrollback: true, offerContinue: true }))
  })

  it.each([true, false])('carries an opted-in loop onto the restarted pane and arms it (enabled=%s)', async (enabled) => {
    const rebuild = vi.fn(async (_id: string, opts: any) => { opts.onReplaced('new-pane') })
    const panes = ref<Record<string, any>[]>([
      { id: 'old-pane', loopActive: true, loopSkillId: 'skill', loopTurnCount: 3, loopMaxTurns: 10 },
      { id: 'new-pane', resumeContinueAvailable: true },
    ])
    const armed = new Map<string, number>()
    const startLoopLimitWatcher = vi.fn()
    const fns = appFunctions(['quotaRestartPane', 'loopResumesAfterFailover'], {
      rebuildPaneViaResume: rebuild, panes, paneRefs: { 'new-pane': { sessionId: 'new-term' } },
      paneResumeSessionId: () => 's', bumpLoopGen: vi.fn(), startLoopLimitWatcher,
      loopFailoverResumeArmed: armed, ...loopFailoverScope(enabled),
    })
    const ev = { transactionId: 'tx-1', toSlotId: 'slot-b', state: 'committed', switchMode: 'restart', restartStrategy: 'resume' }
    await fns.quotaRestartPane({ paneId: 'old-pane' }, ev)
    const revived = panes.value[1]
    if (enabled) {
      expect(revived).toMatchObject({ loopActive: true, loopSkillId: 'skill', loopTurnCount: 3, loopMaxTurns: 10, resumeContinueAvailable: false })
      expect(startLoopLimitWatcher).toHaveBeenCalledWith('new-pane')
      expect(armed.has('new-pane')).toBe(true)
    } else {
      expect(revived.loopActive).toBeUndefined()
      expect(revived.resumeContinueAvailable).toBe(true)
      expect(armed.size).toBe(0)
    }
  })

  it('new conversation preserves the old pane and carries only model/effort plus transaction lineage', async () => {
    const old = { id: 'old-pane', model: 'model', effort: 'high', roleKey: 'worker', stageId: 'stage', kickoffPrompt: 'private task' }
    const panes = ref([old])
    const spawn = vi.fn(async () => 'new-pane')
    const fns = appFunctions(['quotaOpenNewConversation'], {
      onManualSpawn: spawn, panes, paneRefs: { 'new-pane': { sessionId: 'new-term' } }, currentWorkspace: ref('/ws'),
    })
    expect(await fns.quotaOpenNewConversation({ paneId: 'old-pane', agentKey: 'aider', workspacePath: '/ws' }, { transactionId: 'tx-1' })).toEqual({ outcome: 'new-conversation', paneId: 'new-pane', termId: 'new-term' })
    expect(spawn).toHaveBeenCalledWith({ agentKey: 'aider', roleKey: '', stageId: '', model: 'model', effort: 'high', workspacePath: '/ws' }, { transactionId: 'tx-1', originalPaneId: 'old-pane' })
    expect(panes.value).toEqual([old])
  })
})


describe('manual hot account change consumed by the next health tick', () => {
  const now = Date.parse('2026-09-21T12:00:00Z')
  function manualSwitch() {
    const panes = ref([
      { id: 'hot', agentKey: 'claude', profileId: 'a', usageLimitAt: now as number | null, usageLimitUntil: now + 100000, loopActive: false },
      { id: 'env', agentKey: 'claude', profileId: 'a', usageLimitAt: now as number | null, usageLimitUntil: now + 100000, loopActive: false },
      { id: 'retained', agentKey: 'codex', profileId: 'a', usageLimitAt: now as number | null, usageLimitUntil: now + 100000, loopActive: false },
    ])
    const paneRefs = { hot: { sessionId: 'hot-term' }, env: { sessionId: 'env-term' } }
    const snap = (usedPercent: number) => ({ provider: 'claude', status: 'ok', fetchedAt: new Date(now).toISOString(), windows: ['session', 'weekly'].map((kind) => ({ kind, label: kind, usedPercent, resetsAt: new Date(now + 100000).toISOString() })) })
    const readings: Record<string, ReturnType<typeof snap>> = { a: snap(100), b: snap(10), __default__: snap(10) }
    const watcher = { limitProfileId: 'a', limitBaseline: 0, dismissedLimitUntil: null, dismissedReadingAt: null }
    const report = vi.fn()
    const scope = {
      panes, paneRefs, paneHealthWatchers: new Map([['hot', watcher]]), paneCleanBytes: () => 0,
      accountUsageFor: (_agent: string, slot: string | null) => readings[slot ?? '__default__'],
      usageFor: () => readings.b, readingIsCurrent, judgeReading, quotaSemanticsFor, LIMIT_RESET_BUFFER_MS,
      usageLimitDue, isDismissedUsageLimit: (dismissed: number, resume: number) => dismissed === resume,
      unseenTail: () => '', detectUsageLimit, QUOTA_READING_VETO, PANE_HEALTH_TAIL_CHARS: 2000,
      quotaFailover: { agentHasActiveTransaction: () => false, report },
      forcedRestartAgentKey: () => null, fireLoopResume: vi.fn(),
      loopFailoverResumeArmed: new Map(), loopResumesAfterFailover: () => false,
    }
    const fns = appFunctions(['verifiedHotSwitchedPanes', 'paneQuotaReading', 'clearPaneUsageLimits', 'clearPaneUsageLimit', 'checkPaneUsageLimit', 'raiseFromQuotaReading'], scope)
    const changed = backendHandler('cli_profiles.changed', { ...scope, ...fns })
    const commit = quotaCommitHandler({ ...scope, ...fns })
    return { panes, readings, watcher, report, fns, changed, commit, snap }
  }
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now) })
  afterEach(() => vi.useRealTimers())

  it.each([10, 100])('manual A exhausted → B %s%% uses the new bound account on the next tick', (usedPercent) => {
    const h = manualSwitch()
    h.readings.b = h.snap(usedPercent)
    h.changed({ reason: 'set_default', agent_key: 'claude', defaults: { claude: 'b' }, hotSwitchedPanes: [{ paneId: 'hot', termId: 'hot-term', profileId: 'b' }] })
    const pane = h.panes.value[0]
    expect(pane.profileId).toBe('b')
    expect(pane.usageLimitAt).toBeNull()
    expect(h.panes.value[1].profileId).toBe('a')
    expect(h.panes.value[1].usageLimitAt).toBe(now)
    expect(h.panes.value[2].profileId).toBe('a')
    h.fns.checkPaneUsageLimit(pane, '', 0, h.watcher)
    expect(h.report).toHaveBeenCalledTimes(usedPercent === 100 ? 1 : 0)
    expect(pane.usageLimitAt).toBe(usedPercent === 100 ? now : null)
  })

  it.each(['missing-proof', 'wrong-term', 'wrong-agent', 'unknown-profile'])('%s never reattributes the pane', (invalid) => {
    const h = manualSwitch()
    const proof = { paneId: 'hot', termId: invalid === 'wrong-term' ? 'other-term' : 'hot-term', profileId: invalid === 'unknown-profile' ? undefined : 'b' }
    h.changed({ reason: 'set_default', agent_key: invalid === 'wrong-agent' ? 'codex' : 'claude', defaults: { claude: 'b' }, ...(invalid === 'missing-proof' ? {} : { hotSwitchedPanes: [proof] }) })
    expect(h.panes.value[0].profileId).toBe('a')
  })

  it.each([true, false])('automatic commit rebinds only explicit live-term proof (valid=%s)', (valid) => {
    const h = manualSwitch()
    h.commit({ agentKey: 'claude', incidentId: 'inc', switchMode: 'hot', toSlotId: 'b', panes: [{ paneId: 'hot' }, { paneId: 'env' }], hotSwitchedPanes: [{ paneId: 'hot', termId: valid ? 'hot-term' : 'wrong-term', profileId: 'b' }] })
    expect(h.panes.value[0].profileId).toBe(valid ? 'b' : 'a')
    expect(h.panes.value[1].profileId).toBe('a')
    expect(h.panes.value[2].profileId).toBe('a')
  })

  it.each([
    { defaults: { claude: 'c' }, profileId: 'b' },
    { defaults: {}, profileId: 'b' },
    { defaults: { claude: null }, profileId: 'b' },
    { defaults: { claude: 'b' }, profileId: null },
  ])('inconsistent manual hot rows do not rebind or clear the pane: %j', ({ defaults, profileId }) => {
    const h = manualSwitch()
    h.changed({ reason: 'set_default', agent_key: 'claude', defaults, hotSwitchedPanes: [{ paneId: 'hot', termId: 'hot-term', profileId }] })
    expect(h.panes.value[0].profileId).toBe('a')
    expect(h.panes.value[0].usageLimitAt).toBe(now)
  })

  it.each([
    { toSlotId: 'c', profileId: 'b', expected: 'a' },
    { toSlotId: '__default__', profileId: null, expected: '__default__' },
  ])('automatic hot proof must match its transaction target: %j', ({ toSlotId, profileId, expected }) => {
    const h = manualSwitch()
    h.commit({ agentKey: 'claude', incidentId: 'inc', switchMode: 'hot', toSlotId, panes: [{ paneId: 'hot' }], hotSwitchedPanes: [{ paneId: 'hot', termId: 'hot-term', profileId }] })
    expect(h.panes.value[0].profileId).toBe(expected)
  })

  it('explicit null switches to the real default slot, not an unknown launch', () => {
    const h = manualSwitch()
    h.changed({ reason: 'set_default', agent_key: 'claude', defaults: { claude: null }, hotSwitchedPanes: [{ paneId: 'hot', termId: 'hot-term', profileId: null }] })
    expect(h.panes.value[0].profileId).toBe('__default__')
    h.fns.checkPaneUsageLimit(h.panes.value[0], '', 0, h.watcher)
    expect(h.report).not.toHaveBeenCalled()
  })
})
