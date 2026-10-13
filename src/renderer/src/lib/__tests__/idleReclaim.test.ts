import { describe, expect, it } from 'vitest'
import {
  IDLE_RECLAIM_DEFAULT_MINUTES,
  IDLE_RECLAIM_MIN_MINUTES,
  IDLE_RECLAIM_NEVER,
  focusedForReclaim,
  focusedReclaimBlockedBy,
  idleReclaimDisabled,
  idleReclaimThresholdMs,
  namedReclaimBlockedBy,
  reclaimBlockedBy,
  RECLAIM_NOW_THRESHOLD_MS,
  type ReclaimCandidate,
} from '../idleReclaim'

const NOW = 1_700_000_000_000
const THRESHOLD = 3 * 60 * 60_000

/** A pane that has done nothing for four hours and blocks on nothing. */
function idleForHours(over: Partial<ReclaimCandidate> = {}): ReclaimCandidate {
  return {
    realized: true,
    restoring: false,
    focused: false,
    resumeSessionId: 'sess-1',
    rebuilding: false,
    loopActive: false,
    preparationStatus: 'ready',
    injectionStatus: 'done',
    spawnReportPending: false,
    hasRef: true,
    displayStatus: 'idle',
    hasDraft: false,
    lastTouchedAt: NOW - 4 * 60 * 60_000,
    managerRouting: false,
    globalManagerRouting: false,
    stageWatched: false,
    hasQueuedMessages: false,
    ...over,
  }
}

describe('reclaimBlockedBy', () => {
  it('reclaims a pane nobody has touched for longer than the threshold', () => {
    expect(reclaimBlockedBy(idleForHours(), THRESHOLD, NOW)).toBeNull()
  })

  it('leaves a pane alone until the threshold is actually past', () => {
    const recent = idleForHours({ lastTouchedAt: NOW - 60_000 })
    expect(reclaimBlockedBy(recent, THRESHOLD, NOW)).toBe('too-recent')
  })

  // Reading a long answer is using the pane, and it produces neither output nor
  // keystrokes — exactly the profile the timing check calls idle.
  it('never reclaims the focused pane, however old its last signal', () => {
    const focused = idleForHours({ focused: true, lastTouchedAt: NOW - 99 * 60 * 60_000 })
    expect(reclaimBlockedBy(focused, THRESHOLD, NOW)).toBe('focused')
  })

  // A pane holding a question open is idle by every timing measure and is the
  // single worst one to take away: the user comes back to answer it.
  it('never reclaims a pane awaiting the user', () => {
    expect(reclaimBlockedBy(idleForHours({ displayStatus: 'awaiting' }), THRESHOLD, NOW))
      .toBe('not-idle')
  })

  it('never reclaims a pane whose CLI is still working', () => {
    expect(reclaimBlockedBy(idleForHours({ displayStatus: 'running' }), THRESHOLD, NOW))
      .toBe('not-idle')
  })

  // The draft lives only in the CLI's input line. Killing the process is the
  // one way to lose it for good.
  it('never reclaims a pane with unsent text in its input', () => {
    expect(reclaimBlockedBy(idleForHours({ hasDraft: true }), THRESHOLD, NOW)).toBe('has-draft')
  })

  // Without a resume id the conversation cannot be brought back, so reclaiming
  // would be a permanent close the user never asked for.
  it('never reclaims a pane that cannot be resumed', () => {
    expect(reclaimBlockedBy(idleForHours({ resumeSessionId: '' }), THRESHOLD, NOW))
      .toBe('no-resume-id')
  })

  it('never reclaims a pane with no signal to age', () => {
    expect(reclaimBlockedBy(idleForHours({ lastTouchedAt: 0 }), THRESHOLD, NOW))
      .toBe('never-touched')
  })

  it.each([
    ['not-realized', { realized: false }],
    ['restoring', { restoring: true }],
    ['rebuilding', { rebuilding: true }],
    ['loop-active', { loopActive: true }],
    ['preparing', { preparationStatus: 'starting' }],
    ['injecting', { injectionStatus: 'pending' }],
    ['spawn-report-pending', { spawnReportPending: true }],
    ['no-ref', { hasRef: false }],
  ] as const)('never reclaims a pane that is %s', (reason, over) => {
    expect(reclaimBlockedBy(idleForHours(over), THRESHOLD, NOW)).toBe(reason)
  })
})

// Every guard above these reads the pane's own state. These three read who else
// is holding it — the case a pane cannot know about itself, and the reason all
// three were missing: each of these panes is genuinely, measurably idle.
describe('reclaimBlockedBy — held by another subsystem', () => {
  it('never reclaims a pane a stage router is reading', () => {
    // A manager waiting on its workers is idle for exactly as long as they
    // take. Reclaiming it deletes the ref the router scrapes, and the router
    // reads '' from a stale cursor from then on, reporting nothing wrong.
    const manager = idleForHours({ managerRouting: true })
    expect(reclaimBlockedBy(manager, THRESHOLD, NOW)).toBe('manager-routing')
  })

  it('never reclaims the cross-stage global Manager pane', () => {
    // The global Manager sits in stage 01, so the stage router that held it is
    // disposed when that stage ends, and in manager mode it has no watcher —
    // both existing guards go false while every worker's ASK/REPORT is still
    // routed through it. A stage 02 that runs past the reclaim threshold turned
    // it into a placeholder, and globalManagerPaneId() (which requires
    // `realized`) then returned null, so the router bailed silently.
    const globalManager = idleForHours({
      managerRouting: false,
      stageWatched: false,
      globalManagerRouting: true,
    })
    expect(reclaimBlockedBy(globalManager, THRESHOLD, NOW)).toBe('global-manager-routing')
  })

  it('releases the global Manager once its router is no longer live', () => {
    // The flag tracks the RUNNING router, not "was ever a Manager", so a
    // completed or aborted run does not leave the pane unreclaimable forever
    // (the mistake resumeContinueAvailable made).
    expect(reclaimBlockedBy(idleForHours({ globalManagerRouting: false }), THRESHOLD, NOW)).toBeNull()
  })

  it('never reclaims a pane a stage watcher is polling', () => {
    // Nothing rebuilds the watcher: realize skips role injection, which is
    // where watchers are started. The stage would wait forever on a slot that
    // can no longer report its own completion.
    const watched = idleForHours({ stageWatched: true })
    expect(reclaimBlockedBy(watched, THRESHOLD, NOW)).toBe('stage-watched')
  })

  it('never reclaims a pane with messages still queued for it', () => {
    // The queue is failed as 'pane-closed' and every sender is told so. The
    // pane did not close, and nothing re-queues on the way back.
    const owed = idleForHours({ hasQueuedMessages: true })
    expect(reclaimBlockedBy(owed, THRESHOLD, NOW)).toBe('has-queued-messages')
  })

  it('reports the holder rather than the idleness, however long it has been', () => {
    // These are not "not idle yet" — they are "not yours to take". A caller
    // logging the reason should name who was holding it, not the clock.
    const ancient = idleForHours({
      stageWatched: true,
      lastTouchedAt: NOW - 99 * 60 * 60_000,
    })
    expect(reclaimBlockedBy(ancient, THRESHOLD, NOW)).toBe('stage-watched')
  })

  it('still refuses them when the user presses reclaim now', () => {
    // Pressing the button answers the waiting question, not the ownership one.
    for (const held of [
      { managerRouting: true },
      { stageWatched: true },
      { hasQueuedMessages: true },
    ]) {
      expect(
        reclaimBlockedBy(idleForHours(held), RECLAIM_NOW_THRESHOLD_MS, NOW)
      ).not.toBeNull()
    }
  })
})

// Which pane the `focused` guard is actually about. App.vue holds two ids for
// it and used to feed the guard only the first, which is how a pane on screen
// could be reclaimed while the user was reading it.
describe('focusedForReclaim', () => {
  it('is the pane the request names', () => {
    expect(focusedForReclaim('pane-a', 'pane-a', 'pane-a')).toBe(true)
  })

  it('is the pane on screen when nothing was requested', () => {
    // The case that made the sweep visible: focusPaneId is null on a fresh
    // window, and resolveFocusedPane puts the first visible pane on the stage.
    expect(focusedForReclaim(null, 'pane-a', 'pane-a')).toBe(true)
  })

  it('is the pane on screen when the request points somewhere else', () => {
    // A minimized or out-of-workspace request is replaced, and the substitute
    // is what the user is looking at.
    expect(focusedForReclaim('pane-minimized', 'pane-a', 'pane-a')).toBe(true)
  })

  it('still covers a request the resolver had to substitute for', () => {
    // The docked pane keeps its protection: the user put it there deliberately
    // and the reclaim would be just as much of a surprise on the way back.
    expect(focusedForReclaim('pane-minimized', 'pane-a', 'pane-minimized')).toBe(true)
  })

  it('is no other pane', () => {
    expect(focusedForReclaim('pane-a', 'pane-a', 'pane-b')).toBe(false)
    expect(focusedForReclaim(null, null, 'pane-b')).toBe(false)
  })

  it('blocks the reclaim it feeds', () => {
    // The two halves joined up: what this answers is the `focused` field, and
    // a true there is what refuses an otherwise perfectly reclaimable pane.
    const onScreen = idleForHours({
      focused: focusedForReclaim(null, 'pane-a', 'pane-a'),
    })
    expect(reclaimBlockedBy(onScreen, THRESHOLD, NOW)).toBe('focused')

    const offScreen = idleForHours({
      focused: focusedForReclaim(null, 'pane-a', 'pane-b'),
    })
    expect(reclaimBlockedBy(offScreen, THRESHOLD, NOW)).toBeNull()
  })
})

// Pressing "reclaim now" answers the question the timer exists to answer, so
// the age check is the only guard it skips. Everything else still refuses.
describe('manual reclaim (RECLAIM_NOW_THRESHOLD_MS)', () => {
  it('reclaims a pane that just went idle', () => {
    const justIdle = idleForHours({ lastTouchedAt: NOW - 1_000 })
    expect(reclaimBlockedBy(justIdle, RECLAIM_NOW_THRESHOLD_MS, NOW)).toBeNull()
  })

  it.each([
    ['focused', { focused: true }],
    ['not-idle', { displayStatus: 'awaiting' }],
    ['has-draft', { hasDraft: true }],
    ['no-resume-id', { resumeSessionId: '' }],
    ['never-touched', { lastTouchedAt: 0 }],
    ['loop-active', { loopActive: true }],
  ] as const)('still refuses a pane that is %s', (reason, over) => {
    const pane = idleForHours({ lastTouchedAt: NOW - 1_000, ...over })
    expect(reclaimBlockedBy(pane, RECLAIM_NOW_THRESHOLD_MS, NOW)).toBe(reason)
  })
})

// Reclaiming panes the user picked out one by one: focus no longer refuses,
// because picking the pane is the asking. Everything else still does.
describe('namedReclaimBlockedBy', () => {
  it('reclaims the focused pane', () => {
    const pane = idleForHours({ lastTouchedAt: NOW - 1_000, focused: true })
    expect(namedReclaimBlockedBy(pane, NOW)).toBeNull()
  })

  it.each([
    ['not-idle', { displayStatus: 'awaiting' }],
    ['has-draft', { hasDraft: true }],
    ['no-resume-id', { resumeSessionId: '' }],
    ['loop-active', { loopActive: true }],
    ['has-queued-messages', { hasQueuedMessages: true }],
  ] as const)('still refuses a focused pane that is %s', (reason, over) => {
    const pane = idleForHours({ lastTouchedAt: NOW - 1_000, focused: true, ...over })
    expect(namedReclaimBlockedBy(pane, NOW)).toBe(reason)
  })
})

describe('idleReclaimThresholdMs', () => {
  it('reads the stored minutes', () => {
    expect(idleReclaimThresholdMs('60')).toBe(60 * 60_000)
  })

  // A stored value below the floor would turn the sweep into "reclaim as soon
  // as the user stops typing", which is the failure this setting must not have.
  it('clamps an unreasonably small value up to the floor', () => {
    expect(idleReclaimThresholdMs('1')).toBe(IDLE_RECLAIM_MIN_MINUTES * 60_000)
    expect(idleReclaimThresholdMs('0')).toBe(IDLE_RECLAIM_MIN_MINUTES * 60_000)
  })

  it('falls back to the default when the stored value is not a number', () => {
    expect(idleReclaimThresholdMs('')).toBe(IDLE_RECLAIM_DEFAULT_MINUTES * 60_000)
    expect(idleReclaimThresholdMs('later')).toBe(IDLE_RECLAIM_DEFAULT_MINUTES * 60_000)
  })
})

// "Never" has to be a word rather than a number, because every number here is
// a duration the floor clamps — '0' means fifteen minutes, not off.
describe('never', () => {
  it('recognises the sentinel, and nothing else', () => {
    expect(idleReclaimDisabled(IDLE_RECLAIM_NEVER)).toBe(true)
    expect(idleReclaimDisabled('Never')).toBe(true)
    expect(idleReclaimDisabled(' never ')).toBe(true)
    for (const stored of ['15', '30', '60', '180', '480', '0', '', 'later']) {
      expect(idleReclaimDisabled(stored), stored).toBe(false)
    }
  })

  // The sweep checks idleReclaimDisabled and returns before it measures ages.
  // This is the backstop for a caller that does not: an unreachable threshold
  // reclaims nothing, where the old non-numeric fallback would have reclaimed
  // on the 30-minute default the user just switched off.
  it('answers with a threshold no pane can ever reach', () => {
    expect(idleReclaimThresholdMs(IDLE_RECLAIM_NEVER)).toBe(Number.POSITIVE_INFINITY)
  })

  it('refuses a pane idle for a century as too recent', () => {
    const ancient = idleForHours({ lastTouchedAt: NOW - 100 * 365 * 24 * 60 * 60_000 })
    expect(reclaimBlockedBy(ancient, idleReclaimThresholdMs(IDLE_RECLAIM_NEVER), NOW))
      .toBe('too-recent')
  })

  // The setting is about the timer. Pressing "reclaim now" is the user asking
  // by name, and never was never an answer to that question.
  it('leaves manual reclaim working', () => {
    const justIdle = idleForHours({ lastTouchedAt: NOW - 1_000 })
    expect(reclaimBlockedBy(justIdle, RECLAIM_NOW_THRESHOLD_MS, NOW)).toBeNull()
  })
})

// Settings → Resource limits: "also reclaim the focused pane after N hours".
// Each workspace window keeps one pane focused, so with the guard above that
// pane is never reclaimed however long it sits — commander panes stayed up for
// 12+ hours. The option is off by default (today's behavior), and when on it
// lifts only the focus guard: every other reason still holds.
describe('focusedReclaimBlockedBy', () => {
  const HOUR = 60 * 60_000

  it('keeps the focused pane when the option is off', () => {
    const pane = idleForHours({ focused: true, lastTouchedAt: NOW - 99 * HOUR })
    expect(focusedReclaimBlockedBy(pane, THRESHOLD, 0, NOW)).toBe('focused')
  })

  it('reclaims a focused pane untouched for longer than the option', () => {
    const pane = idleForHours({ focused: true, lastTouchedAt: NOW - 4 * HOUR })
    expect(focusedReclaimBlockedBy(pane, THRESHOLD, 2 * HOUR, NOW)).toBeNull()
  })

  it('keeps a focused pane touched more recently than the option', () => {
    const pane = idleForHours({ focused: true, lastTouchedAt: NOW - 1 * HOUR })
    expect(focusedReclaimBlockedBy(pane, THRESHOLD, 2 * HOUR, NOW)).toBe('focused')
  })

  it('still refuses for every other reason', () => {
    const awaiting = idleForHours({ focused: true, displayStatus: 'awaiting', lastTouchedAt: NOW - 9 * HOUR })
    expect(focusedReclaimBlockedBy(awaiting, THRESHOLD, 2 * HOUR, NOW)).toBe('not-idle')
    const draft = idleForHours({ focused: true, hasDraft: true, lastTouchedAt: NOW - 9 * HOUR })
    expect(focusedReclaimBlockedBy(draft, THRESHOLD, 2 * HOUR, NOW)).toBe('has-draft')
  })

  it('treats no signal at all as not old', () => {
    const pane = idleForHours({ focused: true, lastTouchedAt: 0 })
    expect(focusedReclaimBlockedBy(pane, THRESHOLD, 2 * HOUR, NOW)).toBe('focused')
  })

  it('leaves unfocused panes to the normal rule', () => {
    const pane = idleForHours({ lastTouchedAt: NOW - 3 * HOUR })
    expect(focusedReclaimBlockedBy(pane, THRESHOLD, 0, NOW)).toBe(reclaimBlockedBy(pane, THRESHOLD, NOW))
  })
})
