// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The App.vue half of quota-limit detection. The decision itself is covered in
// lib/__tests__/cliUsageLimit.test.ts; what cannot be asserted there is the
// WIRING — that the watch is armed for every pane rather than only the ones a
// loop is running, that the loop consumes the verdict instead of matching the
// text a second time, and that the two matchers sharing one interval do not
// share one baseline. Those are the joints a later edit breaks silently: every
// unit test still passes while the feature quietly reverts to loop-only.
//
// App.vue cannot be mounted by this suite, so the wiring is asserted against
// the source the way the other App.*.test.ts files do.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function paneHealthWatcherBody(): string {
  const start = appSource.indexOf('function startPaneHealthWatcher(')
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('}, PANE_HEALTH_POLL_MS)', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

function loopWatcherBody(): string {
  const start = appSource.indexOf('function startLoopLimitWatcher(')
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('}, LOOP_LIMIT_POLL_MS)', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}


/** The body of checkPaneUsageLimit ALONE. Slicing to end-of-file, as the older
 *  blocks here do, makes every ordering assertion depend on the first match
 *  happening to land inside the function — so a regression that moves a check
 *  out of it reads as a pass. */
function checkUsageLimitBody(): string {
  const start = appSource.indexOf('function checkPaneUsageLimit(')
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('\nfunction ', start + 1)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('quota-limit detection is not gated on the loop', () => {
  it('arms the health watcher for every spawned pane', () => {
    // The regression this exists to stop: re-gating the arming call, which is
    // how it used to be (`if (loginCommandFor(...) != null)`). That silently
    // returns the feature to "only claude panes", and before Phase B it was
    // worse than that — only claude panes with a loop running.
    expect(appSource).toContain('    startPaneHealthWatcher(id)')
    const armed = appSource.indexOf('startPaneHealthWatcher(id)')
    const line = appSource.slice(appSource.lastIndexOf('\n', armed) + 1, armed)
    expect(line.trim()).toBe('')
  })

  it('skips only the login half for a vendor with no login spec', () => {
    // The login command is per-vendor; the quota check is not. The early return
    // must therefore sit AFTER the quota call, or the quota half silently
    // becomes claude-only again.
    const body = paneHealthWatcherBody()
    const quota = body.indexOf('checkPaneUsageLimit(')
    const loginGate = body.indexOf('if (loginCommandFor(pane.agentKey) == null) return')
    expect(quota).toBeGreaterThan(-1)
    expect(loginGate).toBeGreaterThan(quota)
  })

  it('gives the two matchers separate consumed-position baselines', () => {
    // One baseline for both means whichever matcher consumes it first hides the
    // same text from the other — a login-expired message would swallow a limit
    // message printed in the same interval, and vice versa.
    const body = paneHealthWatcherBody()
    expect(body).toContain('limitBaseline: paneCleanBytes(paneId)')
    expect(body).toContain('unseenTail(buf, bytes, watcher.baseline, PANE_HEALTH_TAIL_CHARS)')
    const check = appSource.slice(appSource.indexOf('function checkPaneUsageLimit('))
    expect(check).toContain('unseenTail(buf, bytes, watcher.limitBaseline, PANE_HEALTH_TAIL_CHARS)')
  })
})

describe('the loop consumes the verdict rather than re-matching', () => {
  it('no longer matches the limit text itself', () => {
    // Two independent matchers would drift: the badge and the loop could
    // disagree about whether the pane is out of quota, and the loop would
    // schedule off a reset the badge never saw.
    expect(appSource).not.toContain('matchSessionLimit')
    expect(appSource).not.toContain('parseLimitReset')
  })

  it('reads the pane flag as an edge, not as a level', () => {
    // The health watcher keeps the flag lit for the WHOLE window. Reading it as
    // a level would re-schedule and re-notify on every 5-second poll for hours.
    const body = loopWatcherBody()
    expect(body).toContain('pane.usageLimitAt !== watcher.limitSeenAt')
    expect(body).toContain('watcher.limitSeenAt = pane.usageLimitAt')
  })

  it('waits until the health watcher\'s resume time, never its own estimate', () => {
    const body = loopWatcherBody()
    expect(body).toContain('pane.loopWaitUntil = pane.usageLimitUntil')
  })
})

describe('the refresh a limit hit triggers is addressed to a slot', () => {
  it('names the active profile instead of letting the default slot be assumed', () => {
    // refreshUsage(agentKey) substitutes '__default__' for an absent slot, so
    // on a named profile the cooldown cleared belongs to the wrong account and
    // the badge keeps its stale figure for another CLAUDE_CLI_READ_INTERVAL.
    const check = appSource.slice(appSource.indexOf('function checkPaneUsageLimit('))
    expect(check).toContain(
      'refreshUsage(pane.agentKey, cliProfilesApi.defaultProfileId(pane.agentKey))'
    )
  })
})

describe('the two watchers do not talk over each other', () => {
  it('leaves the announcement to the loop when one is running', () => {
    // notifyPaneState dedupes consecutive same-kind notifications per pane and
    // both of these are 'attention'. Notifying unconditionally here fires first
    // (the health watcher is what sets the flag the loop then reads), which
    // swallows the loop's own "paused, resuming at HH:MM" — strictly more
    // information than the plain "out of quota" that replaced it.
    const check = appSource.slice(appSource.indexOf('function checkPaneUsageLimit('))
    const guard = check.indexOf('if (pane.loopActive) return')
    const notify = check.indexOf('usage-limit-notify-title')
    expect(guard).toBeGreaterThan(-1)
    expect(notify).toBeGreaterThan(guard)
  })
})

describe('the flag-expiry rule lives where it can be tested', () => {
  it('delegates to usageLimitDue instead of re-deriving the deadline inline', () => {
    // App.vue cannot be mounted, so an inline `now >= (until ?? at + TTL)` here
    // is unreachable by any behaviour test — including the "measure the
    // fallback from when the hit was seen" case, which is how a temporary flag
    // silently becomes permanent.
    const check = appSource.slice(appSource.indexOf('function checkPaneUsageLimit('))
    expect(check).toContain(
      'usageLimitDue(pane.usageLimitAt, pane.usageLimitUntil ?? null, now)'
    )
    expect(appSource).not.toContain('USAGE_LIMIT_UNKNOWN_TTL_MS')
  })
})

describe('an account switch lets go of the quota flag', () => {
  // The flag belongs to the account that hit the limit, not to the pane.
  // claude is a hot-swap agent: its switches are never `forced`, so the
  // rebuild path never runs for it and the pane object survives the switch
  // with the flag — and the "back HH:MM" badge — intact until the window
  // expires. This is the only switch-time clear, so it is asserted directly.
  function switchHandlerBody(): string {
    const start = appSource.indexOf("backend.on('cli_profiles.changed'")
    expect(start).toBeGreaterThan(-1)
    const end = appSource.indexOf('\n})', start)
    expect(end).toBeGreaterThan(start)
    return appSource.slice(start, end)
  }

  it('clears every pane of the switched agent on set_default, quiet or forced', () => {
    const body = switchHandlerBody()
    const clear = body.indexOf('clearPaneUsageLimits(ev.agent_key, ev.defaults?.[ev.agent_key] ?? null, {')
    const forced = body.indexOf('forcedRestartAgentKey(ev)')
    expect(clear).toBeGreaterThan(-1)
    // Before the forced-restart early return, or a forced switch skips it.
    expect(forced).toBeGreaterThan(clear)
    // A switch the quota-failover transaction made clears the flag the same
    // way but must not resume a parked loop (no automatic continue); a manual
    // switch keeps the resume it always had.
    expect(body.slice(clear, forced)).toContain('resumeLoop: !quotaFailover.agentHasActiveTransaction(ev.agent_key)')
  })

  it('drops both halves of the flag and consumes the old limit text', () => {
    const start = appSource.indexOf('function clearPaneUsageLimits(')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n}\n', start))
    expect(body).toContain("clearPaneUsageLimit(pane, 'account-switch', true, opts)")
    // An unflagged pane drops an earlier suppression only on a switch back to
    // the exhausted account; on any other account the old banner is a repaint.
    expect(body).toContain('if (w && w.limitProfileId === newDefaultId) {')
    expect(body).toContain('w.dismissedLimitUntil = null')
    // The exhausted account is stamped when the flag lights.
    const check = appSource.slice(appSource.indexOf('function checkPaneUsageLimit('))
    expect(check).toContain('watcher.limitProfileId = cliProfilesApi.defaultProfileId(pane.agentKey)')
    const helperStart = appSource.indexOf('function clearPaneUsageLimit(')
    expect(helperStart).toBeGreaterThan(-1)
    const helper = appSource.slice(helperStart, appSource.indexOf('\n}\n', helperStart))
    expect(helper).toContain('pane.usageLimitAt = null')
    expect(helper).toContain('pane.usageLimitUntil = null')
    // Without this the limit banner still in the buffer re-matches on the
    // next poll and re-lights the flag one interval after the switch.
    expect(helper).toContain('w.limitBaseline = paneCleanBytes(pane.id)')
    // A TUI repaint lands the same banner in NEW bytes past the baseline; the
    // remembered reset is what keeps it from re-lighting the flag.
    expect(helper).toContain('w.dismissedLimitUntil = pane.usageLimitUntil ?? null')
    // A loop parked on this limit resumes the way the badge click does —
    // unless the clear came from a quota-failover switch, which offers the
    // continue button instead of sending anything.
    expect(helper).toContain('if (waitingOnThisLimit) void fireLoopResume(pane.id, logLabel)')
    expect(helper).toContain('if (pane.loopActive && !opts.resumeLoop) {')
    expect(helper).toContain('pane.resumeContinueAvailable = true')
  })

  it('lets the user dismiss the badge through the same per-pane clear', () => {
    expect(appSource).toContain('@usage-limit-dismiss="dismissPaneUsageLimit(p.id)"')
    const start = appSource.indexOf('function dismissPaneUsageLimit(')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n}\n', start))
    expect(body).toContain("clearPaneUsageLimit(pane, 'usage-limit-dismiss')")
  })

  it('ignores a repaint of the cleared limit after consuming it', () => {
    const check = appSource.slice(appSource.indexOf('function checkPaneUsageLimit('))
    const consume = check.indexOf('watcher.limitBaseline = bytes\n  if (isDismissedUsageLimit(')
    const flag = check.indexOf('pane.usageLimitAt = now')
    expect(consume).toBeGreaterThan(-1)
    expect(flag).toBeGreaterThan(consume)
  })

  it('keeps the pane badge wired to the flag', () => {
    // Removed once by a sweep commit (9285f925) with no mention of it; the
    // clear above is invisible without the badge that shows the flag.
    expect(appSource).toContain(':usage-limit-hit="p.usageLimitAt != null"')
    expect(appSource).toContain(':usage-limit-until="p.usageLimitUntil"')
    const pane = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/TerminalPane.vue'), 'utf8')
    expect(pane).toContain('v-if="usageLimitHit"')
    expect(pane).toContain("$t('pane.terminal.usage-limit-badge', { time: formatLoopTime(usageLimitUntil) })")
    for (const lang of ['en-US', 'zh-TW']) {
      const locale = JSON.parse(
        readFileSync(resolve(process.cwd(), `packages/plugin-ui/src/foundation/i18n/locales/${lang}.json`), 'utf8')
      )
      for (const key of ['usage-limit-badge', 'usage-limit-badge-unknown', 'usage-limit-tooltip', 'usage-limit-tooltip-unknown', 'usage-limit-dismiss-confirm']) {
        expect(locale.pane.terminal[key], `${lang} pane.terminal.${key}`).toBeTypeOf('string')
      }
    }
  })
})

describe('a limit hit is reported to the quota ledger once', () => {
  it('sends tokens.quota_exhausted on the first detection, after the early return for an already-flagged pane', () => {
    // CLI detection supplies evidence independently of provider readings.
    // It must sit below the `usageLimitAt != null` return so a repaint of the
    // same message never re-sends it, and above the refresh so it goes out
    // even when the refresh path bails.
    const check = checkUsageLimitBody()
    const flagged = check.indexOf('if (pane.usageLimitAt != null) {')
    const send = check.indexOf("sendQuiet('tokens.quota_exhausted'")
    // Searched from the send onward: the overruled-sentence branch has a
    // refreshUsage of its own, earlier in the function, and it is not the one
    // this ordering is about.
    const refresh = check.indexOf('refreshUsage(pane.agentKey', send)
    expect(flagged).toBeGreaterThan(-1)
    const flaggedEnd = check.indexOf('\n  }\n', flagged)
    expect(check.slice(flagged, flaggedEnd)).toMatch(/\n    return$/)
    expect(send).toBeGreaterThan(flagged)
    expect(send).toBeLessThan(refresh)
    expect(check.match(/sendQuiet\('tokens\.quota_exhausted'/g)).toHaveLength(1)
    expect(check.slice(send, check.indexOf('\n', send))).toBe("sendQuiet('tokens.quota_exhausted', quotaExhaustedPayload(hit, { agentKey: pane.agentKey, paneId: pane.id }, now))")
  })
})

// The account's reading is the primary source and the buffer is the auxiliary
// one. Both halves of that live inside checkPaneUsageLimit — the ONE writer —
// so the flag never grows a second clock the way an earlier attempt did (see
// the paneUsageLimited docblock, which records that withdrawal).
describe('the account reading can lower the flag before its stated reset', () => {
  it('lifts a standing flag when the reading says the quota is back', () => {
    const check = checkUsageLimitBody()
    const flagged = check.indexOf('if (pane.usageLimitAt != null) {')
    const due = check.indexOf('usageLimitDue(pane.usageLimitAt')
    const headroom = check.indexOf('judgeReading(snap, quotaSemanticsFor(pane.agentKey), now).positive')
    expect(flagged).toBeGreaterThan(-1)
    expect(headroom).toBeGreaterThan(due)
    expect(headroom).toBeLessThan(check.indexOf('const tail ='))
  })

  it('lifts it through the shared clear, so a parked loop resumes', () => {
    // Nulling the two fields inline would leave loopWaitUntil armed on the old
    // deadline (clearPaneUsageLimit is what compares them), leave the banner
    // still on screen able to re-light the flag on the next poll, and lose the
    // dismissed-reset record that stops exactly that.
    const check = checkUsageLimitBody()
    const headroom = check.indexOf('judgeReading(snap, quotaSemanticsFor(pane.agentKey), now).positive')
    expect(check.slice(headroom, headroom + 200)).toContain(
      "clearPaneUsageLimit(pane, 'quota-back', false)"
    )
  })

  it('does not record the reset as judged, the way a dismiss does', () => {
    // The record suppresses every later sighting of the same reset until it
    // passes. A dismiss earns that (the user said the badge is wrong); one
    // poll coming back under the line does not — it would leave the pane
    // unflaggable for the rest of the window however exhausted it then gets.
    const clear = appSource.slice(appSource.indexOf('function clearPaneUsageLimit('))
    expect(clear.slice(0, clear.indexOf('\n}'))).toContain(
      'if (remember) {'
    )
    expect(clear.slice(0, clear.indexOf('\n}'))).toContain(
      'w.dismissedLimitUntil = pane.usageLimitUntil ?? null'
    )
    // The two paths that ARE a judgement keep the default.
    expect(appSource).toContain("clearPaneUsageLimit(pane, 'account-switch', true, opts)")
    expect(appSource).toContain("clearPaneUsageLimit(pane, 'usage-limit-dismiss')")
  })
})

describe('the account reading can raise the flag with nothing in the buffer', () => {
  const raise = appSource.slice(
    appSource.indexOf('function raiseFromQuotaReading('),
    appSource.indexOf('/** Account switch:')
  )

  it('is reached only when the buffer matched nothing', () => {
    const check = checkUsageLimitBody()
    const hit = check.indexOf('const hit = detectUsageLimit(')
    const call = check.indexOf('raiseFromQuotaReading(pane, watcher, now)')
    expect(call).toBeGreaterThan(hit)
    expect(check.slice(hit, call)).toContain('if (hit === null) {')
  })

  it('lights the clockless badge when the spent window names no reset', () => {
    // Claude's panel prints a reset for a window only sometimes. A spent
    // weekly window without one, next to a session window with one, must NOT
    // borrow the session clock: that prints "back at 16:32" over a wall that
    // stands for days and wakes a parked loop into it. The spent window alone
    // supplies the clock; no reset passes through as unknown
    // instead of refusing to light.
    expect(raise).toContain('const resetAt = spent.resetsAt ? Date.parse(spent.resetsAt) : NaN')
    expect(raise).toContain('resetAt + LIMIT_RESET_BUFFER_MS : null')
    expect(raise).not.toContain('if (resumeAt == null) return')
    expect(raise).toContain('pane.usageLimitUntil = resumeAt')
  })

  it('still honours a badge the user dismissed, by reset clock when there is one', () => {
    expect(raise).toContain(
      'isDismissedUsageLimit(watcher.dismissedLimitUntil, resumeAt, now)'
    )
  })

  it('honours a dismissed unknown-reset badge by the reading that was judged', () => {
    // The reset suppression compares two clocks and has none here, so the
    // dismiss key is the reading itself: the same fetchedAt does not re-light
    // the flag, the next reading (new evidence) may. Recorded only where a
    // judgement was made — dismiss and account switch — never by the
    // reading-driven clear, for the same reason dismissedLimitUntil is not.
    expect(raise).toContain('if (sameAccount && snap!.fetchedAt === watcher.dismissedReadingAt) return')
    const clear = appSource.slice(appSource.indexOf('function clearPaneUsageLimit('))
    const clearBody = clear.slice(0, clear.indexOf('\n}'))
    const remember = clearBody.indexOf('if (remember) {')
    expect(remember).toBeGreaterThan(-1)
    expect(clearBody.slice(remember)).toContain(
      'w.dismissedReadingAt = paneQuotaReading(pane)?.fetchedAt ?? null'
    )
  })

  it('lifts the reading key with the reset key when switching back to the exhausted account', () => {
    const body = appSource.slice(
      appSource.indexOf('function clearPaneUsageLimits('),
      appSource.indexOf('function clearPaneUsageLimit(')
    )
    const lift = body.indexOf('if (w && w.limitProfileId === newDefaultId) {')
    expect(lift).toBeGreaterThan(-1)
    const block = body.slice(lift, body.indexOf('continue', lift))
    expect(block).toContain('w.dismissedLimitUntil = null')
    expect(block).toContain('w.dismissedReadingAt = null')
  })

  it('does not stamp the freshness anchor, send to the ledger, or re-refresh', () => {
    // The three things this path must NOT inherit from the buffer path.
    // usageLimitSeenAt is stamped on DETECTION (App.stageQuotaGate.test.ts
    // pins that); moving it onto a 15-minute poll walks the anchor forward
    // until quotaTurnIsFresh, which is built to fail OPEN, never opens.
    // tokens.quota_exhausted is worth sending only because the pane beats the
    // poll to the wall. And refreshing the reading it just read costs a whole
    // Claude Code start for nothing.
    expect(raise).not.toContain('usageLimitSeenAt')
    expect(raise).not.toContain('tokens.quota_exhausted')
    expect(raise).not.toContain('refreshUsage')
    expect(raise).not.toContain('notifyPaneState')
  })

  it('records which account the flag belongs to, as the buffer path does', () => {
    // clearPaneUsageLimits compares this against the incoming default to
    // decide whether switching BACK makes an old banner a genuine hit again.
    expect(raise).toContain(
      'watcher.limitProfileId = pane.profileId ?? null'
    )
  })
})

// A clocked sentence the reading overruled is a verdict on real text, not an
// absence of one. Treating it as "nothing here" leaves it unconsumed and leaves
// the reading that beat it unchecked.
describe('an overruled limit sentence is still dealt with', () => {
  it('consumes it, so it cannot be re-judged or promoted later', () => {
    // Unconsumed, it is re-matched every poll until it scrolls out of the
    // 2000-character tail; any later change of state then promotes prose that
    // is minutes old, and parseLimitReset re-resolves its bare 12-hour clock
    // against the current time — rolling a stale "resets 4:30pm" to tomorrow.
    const check = checkUsageLimitBody()
    const veto = check.indexOf('if (hit === QUOTA_READING_VETO) {')
    expect(veto).toBeGreaterThan(-1)
    const branch = check.slice(veto, check.indexOf('if (hit === null) {', veto))
    expect(branch).toContain('watcher.limitBaseline = bytes')
  })

  it('re-reads the account that overruled it', () => {
    // The sentence was printed seconds ago; the reading that beat it can be a
    // quarter of an hour old. Without this the veto suppresses the one refresh
    // that could lift it, and stands until the next natural poll with the loop
    // still feeding an exhausted CLI.
    const check = checkUsageLimitBody()
    const veto = check.indexOf('if (hit === QUOTA_READING_VETO) {')
    const branch = check.slice(veto, check.indexOf('if (hit === null) {', veto))
    expect(branch).toContain(
      'refreshUsage(pane.agentKey, cliProfilesApi.defaultProfileId(pane.agentKey))'
    )
  })
})

describe('both ends of the flag answer to the same freshness bar', () => {
  it('will not raise from a reading nobody has taken', () => {
    // The case: an account switch publishes the incoming account's CACHED
    // figures with refreshPending and status 'ok'. The lowering side rejects
    // that as "not known yet"; if the raising side accepted it, the badge would
    // come back one tick after the switch cleared it, from a reading that
    // measured nothing — and clearPaneUsageLimits' docblock would be a lie.
    const raise = appSource.slice(
      appSource.indexOf('function raiseFromQuotaReading('),
      appSource.indexOf('/** Account switch:')
    )
    expect(raise).toContain('if (!readingIsCurrent(snap)) return')
  })
})

describe('pane health watcher – a dead login on an account\'s own config dir', () => {
  function handlerBody(): string {
    const start = appSource.indexOf('function onAccountDirLoginExpired(')
    expect(start).toBeGreaterThan(-1)
    const end = appSource.indexOf('\n}\n', start)
    return appSource.slice(start, end)
  }

  it('hands the expiry to the account-dir handler right after lighting the badge', () => {
    const body = paneHealthWatcherBody()
    const lit = body.indexOf('pane.loginExpired = true')
    const handled = body.indexOf('onAccountDirLoginExpired(pane)')
    expect(lit).toBeGreaterThan(-1)
    expect(handled).toBeGreaterThan(lit)
  })

  it('reports only a claude pane whose account runs on its own signed-in dir', () => {
    const body = handlerBody()
    expect(body).toContain("pane.agentKey !== 'claude'")
    expect(body).toContain('accountDirFor')
    expect(body).toContain('signedIn')
    expect(body).toContain('reportAccountDirExpired(')
  })

  it('tells the user which account must sign in again', () => {
    expect(handlerBody()).toContain("'pane.terminal.login-expired-account-dir-notify-body'")
  })
})
