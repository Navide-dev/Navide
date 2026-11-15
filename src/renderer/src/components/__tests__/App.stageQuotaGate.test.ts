// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The App.vue half of the pipeline quota gate. The decisions themselves are
// covered by real behaviour tests in lib/__tests__/completion.test.ts and
// lib/__tests__/managerStageWatchdog.test.ts; what cannot be asserted there is
// the WIRING — that every path which can advance a stage actually passes the
// quota answer in. Miss one and the pure functions stay green while the
// cascade comes back: a quota-exhausted turn read as the slot finishing its
// work, N/N, advance, and the limit message handed to the next stage as if it
// were output.
//
// App.vue cannot be mounted by this suite, so the wiring is asserted against
// the source the way the other App.*.test.ts files do.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

// The dialog's wording moved into the locale files, so the copy assertions read
// the zh-TW strings the template now points at.
const zhTW = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'src/renderer/src/i18n/locales/zh-TW.json'),
    'utf8',
  ),
) as { label: Record<string, string>; hint: Record<string, string> }

function body(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `missing: ${startMarker}`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start)
  expect(end, `missing: ${endMarker}`).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('the quota answer comes from one place', () => {
  it('pairs the flag with usageLimitDue instead of reading it bare', () => {
    // Only the pane health watcher's 5-second poll clears usageLimitAt, so a
    // bare `!= null` can be a poll stale — long enough to hold a stage on a
    // window that already reset.
    // Reads the flag alone. Asking usageLimitDue here as well made the deadline
    // a SECOND, earlier way for the block to end, which split one fact across
    // two clocks; being at most one poll (5s) late is the cheaper price.
    const helper = body('function paneUsageLimited(', '\n}')
    expect(helper).not.toContain('usageLimitDue')
    expect(helper).toContain('?.usageLimitAt != null')
  })
})

describe('every stage-advancing path passes the quota answer', () => {
  it('marks a quota-blocked slot in the signals the stage gate reads', () => {
    // computeStageSlotSignals is the ONLY SlotSignal builder, so this is the
    // single point where allSlotsFinished can learn about the quota.
    const fn = body('function computeStageSlotSignals(', '\n}')
    expect(fn).toContain('quotaBlocked: paneUsageLimited(p.id)')
  })

  it('raises a quota stall from the stage watcher rather than leaving it to the cap', () => {
    // The hour-long cap would eventually fire, but it says nothing about WHY
    // the stage went quiet — and it fires an hour late.
    const watcher = body('function startStageWatcher(', '\n      // 3. Analyzer')
    const quota = watcher.indexOf('const quotaBlocked = paneUsageLimited(paneId)')
    const done = watcher.indexOf('turnCompleteDone({')
    expect(quota).toBeGreaterThan(-1)
    expect(done).toBeGreaterThan(quota)
    // The guard itself, not just the call inside it. Asserting only the
    // promptStageStall line let `if (false)` through — the branch was dead and
    // every assertion here still passed (found by mutation testing).
    expect(watcher).toContain('if (quotaBlocked) {')
    expect(watcher).toContain("promptStageStall(stageIndex, paneId, 'quota', detail)")
  })

  it('also poisons the completion verdict, because the stall can be suppressed', () => {
    // promptStageStall returns early when another prompt is already showing.
    // Without this the same poll falls straight through to the false completion
    // it just declined to raise.
    const watcher = body('function startStageWatcher(', '\n      // 3. Analyzer')
    const call = watcher.slice(watcher.indexOf('turnCompleteDone({'))
    expect(call).toContain('quotaBlocked')
  })

  it('gives Full auto its own quota arm, because single-slot advances blind', () => {
    // fullAutoStallAction force-advances a single-slot stage without consulting
    // the slot gate at all, so the multi-slot SlotSignal route cannot cover it.
    const prompt = body('function promptStageStall(', '\n/** User clicked')
    const call = prompt.slice(prompt.indexOf('fullAutoStallAction({'))
    expect(call).toContain("quotaBlocked: p.reason === 'quota' || paneUsageLimited(p.paneId)")
  })

  it('tells the Manager watchdog about the Manager pane', () => {
    // Manager mode arms no per-pane watcher, so nothing else notices.
    const scan = body('const verdict = evaluateManagerStage({', '\n    })')
    expect(scan).toContain('managerQuotaBlocked: paneUsageLimited(router.managerPaneId)')
  })
})

describe('the stall says which kind of stall it is', () => {
  it('carries a quota reason through the prompt type and the signature', () => {
    // Two separate declarations — the interface field and the function
    // parameter. Updating only one is a type error, but only for the callers
    // that pass the new value.
    expect(appSource).toContain("reason: 'idle' | 'cap' | 'quota'")
    expect(appSource).toContain("reason: 'idle' | 'cap' | 'quota',")
  })

  it('maps the Manager quota verdict to the quota reason, not to idle', () => {
    // The old mapping was `verdict === 'timeout' ? 'cap' : 'idle'`, which would
    // label a quota stall "no output detected".
    const scan = body('const stallReason =', '\n      promptStageStall')
    expect(scan).toContain("verdict === 'quota' ? 'quota'")
  })

  it('renders a third reason label instead of falling into the timeout wording', () => {
    // The template ternary was binary: anything that was not 'idle' printed
    // "已達時間上限", so a quota stall would have claimed a timeout.
    // The wording itself now lives in the locale files, so the template is
    // asserted on the key and the copy on the zh-TW string behind it.
    expect(appSource).toContain("stageStallPrompt.reason === 'quota'")
    expect(appSource).toContain("label.stall-reason-quota")
    expect(zhTW.label['stall-reason-quota']).toBe('額度已用完')
  })

  it('explains that waiting does not auto-resume', () => {
    // The residual this change does not fix: the window resets on its own but
    // nothing re-drives the stage, so the hint must not imply it will.
    expect(appSource).toContain("hint.stall-quota")
    expect(zhTW.hint['stall-quota']).toContain('重置後不會自動接續')
  })
})

describe('the loop no longer resends into an exhausted CLI', () => {
  it('passes the quota flag to loopContinueReady', () => {
    // The loop's quota branch schedules a timed resume only when a reset time
    // was resolvable; when it was not it fails open and leaves loopWaitUntil
    // null, and the next poll used to fall through to auto-continue.
    const watcher = body('function startLoopLimitWatcher(', '}, LOOP_LIMIT_POLL_MS)')
    const call = watcher.slice(watcher.indexOf('loopContinueReady({'))
    expect(call).toContain('quotaBlocked: paneUsageLimited(paneId)')
  })
})

// Gap B. The first cut cancelled the pane's watcher when it raised the quota
// stall, copying the cap path. Independent review showed two ways that strands
// the slot, and the second holds even when the prompt DID go up: a transcript
// sentinel arriving after the cancel is discarded outright (judgeTurnText needs
// the watcher, and claude/codex have no buffer-sentinel fallback), so a slot
// that printed its done-marker is never heard.
//
// The fix is four things that only work together. Deleting the cancel alone
// leaves a stale prompt able to force-advance a finished slot, and leaves
// "continue waiting" rebuilding the watcher at the current buffer tail — right
// past the marker.
describe('gap B · a quota stall keeps the watcher that can hear the sentinel', () => {
  it('1 · never cancels the watcher on a quota block', () => {
    const watcher = body('function startStageWatcher(', '\n      // 3. Analyzer')
    const quota = watcher.indexOf('if (quotaBlocked) {')
    const end = watcher.indexOf('\n      }', quota)
    expect(quota).toBeGreaterThan(-1)
    expect(watcher.slice(quota, end)).not.toContain('cancelWatcher')
    // …and the cap path still cancels, deliberately unchanged.
    const capWatcher = body('function startStageWatcher(', '\nfunction handleAnalyzerResult(')
    const cap = capWatcher.indexOf("promptStageStall(stageIndex, paneId, 'cap', detail)")
    expect(cap).toBeGreaterThan(-1)
    expect(capWatcher.slice(cap - 220, cap)).toContain('cancelWatcher(paneId)')
  })

  it('2 · raises only while nothing else is on screen', () => {
    // With the watcher alive this branch runs every poll, so an unguarded call
    // would repeat promptStageStall's own "suppressed" log for as long as the
    // block lasts.
    const watcher = body('function startStageWatcher(', '\n      // 3. Analyzer')
    const guard = watcher.indexOf('if (stageStallPrompt.value == null) {')
    const raise = watcher.indexOf("promptStageStall(stageIndex, paneId, 'quota', detail)")
    expect(guard).toBeGreaterThan(-1)
    expect(raise).toBeGreaterThan(guard)
  })

  it('3 · drops a stale quota prompt when the slot really finishes', () => {
    // Otherwise the dialog stays up offering to force-advance a slot already
    // counted, and its Full auto timer fires into the same.
    const fn = body('function onStageSlotCompleted(', '\n  if (remaining > 0) {')
    // The whole condition, opening brace included. Asserting the three clauses
    // separately let `if (false && stallShowing?...)` through — every string was
    // still present and the branch was dead (the fourth time mutation testing
    // caught this exact shape in these tests).
    expect(fn).toContain(
      "  if (\n    stallShowing?.reason === 'quota' &&\n" +
      "    stallShowing.paneId === paneId &&\n" +
      "    stallShowing.stageIndex === stageIndex\n  ) {"
    )
    expect(fn).toContain('clearStageStallAutoTimer()')
    expect(fn).toContain('stageStallPrompt.value = null')
  })

  it('4 · continues a live watcher rather than rebuilding it', () => {
    // startStageWatcher anchors its scan at the CURRENT buffer tail, so
    // rebuilding steps over a done-marker already printed — the very sentinel
    // this stall exists to stop losing.
    const fn = body('function continueWaitingStall(', '\n/** User clicked "強制推進"')
    const keep = fn.indexOf('const live = watchers.get(p.paneId)')
    const rebuild = fn.indexOf('startStageWatcher(p.stageIndex, p.paneId)')
    expect(keep).toBeGreaterThan(-1)
    expect(rebuild).toBeGreaterThan(keep)
    expect(fn).toContain('live.armedAt = Date.now()')
    expect(fn).toContain('paneArmedAt.set(p.paneId, live.armedAt)')
    // The rebuild has to stay reachable for the case with no live watcher.
    expect(fn).toContain('} else {')
  })

  it('leaves promptStageStall a void call again', () => {
    // The boolean return existed only for the conditional cancel above. With
    // nothing cancelling, keeping it would be an orphan of this change.
    const prompt = body('function promptStageStall(', '\n/** User clicked "繼續等待"')
    expect(prompt).toContain('): void {')
    expect(prompt).not.toContain('return true')
  })
})

describe('the analyzer answer is re-checked on arrival', () => {
  it('gates analyzer completion on the quota, not only on the cancelled flag', () => {
    // classify() is awaited, so the quota can be hit while it is in flight —
    // after the poll that would have gated it already ran. And `cancelled` does
    // not cover it: nothing cancels the watcher for a quota block whose prompt
    // was suppressed.
    const fn = body('function handleAnalyzerResult(', '\n  // Question')
    const branch = fn.slice(fn.indexOf("if (result.intent === 'completion') {"))
    const check = branch.indexOf('if (paneUsageLimited(paneId)) {')
    const firstAdvance = branch.indexOf('onStageSlotCompleted(')
    expect(check).toBeGreaterThan(-1)
    expect(firstAdvance).toBeGreaterThan(check)
    // …and it must return, not fall through.
    expect(branch.slice(check, check + 260)).toContain('return')
  })
})

describe('the buffer-reading completion paths are gated too', () => {
  it('stops both of them on a quota block', () => {
    // The analyzer and the regex quick-classify judge from the buffer the limit
    // message is sitting on, so a block has to stop them as well.
    // Assert this gate's OWN log line, not just that paneUsageLimited appears
    // somewhere before the regex branch: the quota stall earlier in the same
    // function also calls it, so a lastIndexOf search found that one and passed
    // with the regex gate deleted (found by mutation testing).
    const watcher = body('function startStageWatcher(', '\nfunction handleAnalyzerResult(')
    const gate = watcher.indexOf('regex completion ignored — CLI is out of quota')
    const regex = watcher.indexOf('regex detected completion')
    expect(gate).toBeGreaterThan(-1)
    expect(regex).toBeGreaterThan(gate)
    expect(watcher.slice(gate - 120, gate)).toContain('if (paneUsageLimited(paneId)) {')
    const analyzer = body('function handleAnalyzerResult(', '\n  // Question')
    expect(analyzer).toContain('if (paneUsageLimited(paneId)) {')
  })
})

// Gap A, closed. The rule lives in lib/completion.ts and is behaviour-tested
// there against the event-interleaving cases; what has to be asserted here is
// that the two clocks actually reach it, and that the anchor is stamped at the
// right moment.
describe('gap A · the event clock reaches the gate', () => {
  it('writes the source clock from the same recordTurnComplete call', () => {
    // Two separate calls could disagree on whether a turn was recorded at all.
    const handler = appSource.slice(appSource.indexOf('if (!ev.superseded) {'))
    const call = handler.slice(0, handler.indexOf('\n    }'))
    expect(call).toContain('paneTurnCompleteAt, ev.pane_id')
    expect(call).toContain('paneTurnCompleteSourceAt')
    expect(appSource).not.toContain('paneTurnCompleteSourceAt.set(')
  })

  it('stamps the anchor on DETECTION, never on the lift', () => {
    // Anchoring on the lift is what made attempt #2 reject a retry that
    // finished before the 5s health poll cleared the flag.
    const check = appSource.slice(appSource.indexOf('function checkPaneUsageLimit('))
    const set = check.indexOf('pane.usageLimitAt = now')
    const stamp = check.indexOf('pane.usageLimitSeenAt = now')
    const clear = check.indexOf('pane.usageLimitAt = null')
    expect(stamp).toBeGreaterThan(set)
    expect(clear).toBeLessThan(set)          // the clearing branch is earlier
    // …and the anchor is never cleared: it is a high-water mark, not a state.
    expect(check).not.toContain('pane.usageLimitSeenAt = null')
  })

  it('hands both clocks to each pipeline consumer', () => {
    const fn = body('function computeStageSlotSignals(', '\n}')
    expect(fn).toContain('quotaSeenAt: p.usageLimitSeenAt ?? 0')
    expect(fn).toContain('turnSourceAt: paneTurnCompleteSourceAt.get(p.id) ?? 0')
    const watcher = body('function startStageWatcher(', '\n      // 3. Analyzer')
    const call = watcher.slice(watcher.indexOf('turnCompleteDone({'))
    expect(call).toContain('quotaSeenAt: panes.value.find((p) => p.id === paneId)?.usageLimitSeenAt ?? 0')
    expect(call).toContain('turnSourceAt: paneTurnCompleteSourceAt.get(paneId) ?? 0')
  })

  it('includes the new map in the pipeline-wide signal reset', () => {
    // Otherwise it keeps an entry per dead pipeline pane for the life of the
    // window — the hygiene the other four maps already get.
    const reset = appSource.slice(appSource.indexOf('const pipelinePaneIds = new Set('))
    expect(reset.slice(0, 700)).toContain('paneTurnCompleteSourceAt')
  })
})

describe('gap A · the buffer-reading paths keep the narrower gate, deliberately', () => {
  it('gates the analyzer and regex on "blocked now" only', () => {
    // A deliberate policy, not an omission. Gating these on turn freshness
    // would disable them in exactly the case they exist for: the agent finished
    // but no turn_complete landed (missing, or mis-attributed to a sibling).
    // The cost is that after the block lifts they can still read output the
    // pane never overwrote; the alternative silences the fallback itself.
    const analyzer = body('function handleAnalyzerResult(', '\n  // Question')
    expect(analyzer).toContain('if (paneUsageLimited(paneId)) {')
    expect(analyzer).not.toContain('quotaSeenAt')
    expect(analyzer).not.toContain('turnSourceAt')
    const watcher = body('function startStageWatcher(', '\nfunction handleAnalyzerResult(')
    const gate = watcher.indexOf('regex completion ignored — CLI is out of quota')
    expect(gate).toBeGreaterThan(-1)
    expect(watcher.slice(gate - 120, gate)).toContain('if (paneUsageLimited(paneId)) {')
  })
})
