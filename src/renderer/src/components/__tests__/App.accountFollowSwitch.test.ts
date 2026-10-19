// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Like the other App.*.test.ts files these read the source: mounting App
// starts backend/terminal/settings lifecycles. They pin the follow-switch
// flag's wiring (agentTeam.accounts.followSwitch): with the flag off every
// entry point is inert, so the window behaves exactly as before. The logic
// itself is unit-tested in lib/__tests__/accountFollowSwitch.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionBody(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  return appSource.slice(start, appSource.indexOf('\n}', start))
}

const followBlock = appSource.slice(
  appSource.indexOf('// ── Follow switch (agentTeam.accounts.followSwitch'),
  appSource.indexOf('async function rebuildPanesViaResume('),
)

describe('follow switch wiring: off means unchanged', () => {
  it('wraps the account-switch handler, gated on the flag read at call time', () => {
    const start = appSource.indexOf('  cliAccountSwitchKey,\n  // withFollowSwitch')
    expect(start).toBeGreaterThan(-1)
    const block = appSource.slice(start, appSource.indexOf('\n)\n', start))
    // The handler is built once as cliAccountSwitch (the account prompt's
    // switch-back calls it unwrapped, below); what is provided wraps it.
    expect(appSource).toContain('const cliAccountSwitch = createCliAccountSwitchHandler(cliProfilesApi, {')
    expect(block).toContain('withFollowSwitch(cliAccountSwitch, {')
    expect(block).toContain('enabled: accountFollowSwitchEnabled,')
  })

  it("keeps the account prompt's switch-back on the unwrapped handler, with its restoreLive guard", () => {
    // withFollowSwitch passes (agentKey, profileId) only: through it the
    // switch-back would lose restoreLive and switch whatever login is live.
    const start = appSource.indexOf("case 'convenience-switch-back': {")
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('break', start))
    expect(body).toContain('await cliAccountSwitch(action.agentKey, action.slotId, {')
    expect(body).toContain('restoreLive: { liveFingerprint: action.liveFingerprint },')
  })

  it('offers the quota button only with the flag on, for a claude pane that can be rebuilt', () => {
    expect(appSource).toContain(
      ':quota-switch-offered="followSwitchFlag && p.agentKey === FOLLOW_SWITCH_AGENT && paneCanRebuild(p)"',
    )
    expect(functionBody('onQuotaSwitchAccount')).toContain('if (!followSwitchFlag.value) return')
  })

  it('renders the dialog only while one is asked for, and only the two flag paths ask', () => {
    expect(appSource).toContain('<AccountFollowSwitchDialog\n    v-if="followDialog"')
    const asks = appSource.split('askFollowDialog(').length - 1
    // definition + offerFollowSwitch + onQuotaSwitchAccount + planAccountFollow
    // (scheme B's running-pane confirm, asked only when the list is used)
    // + unpinAllAccountPanes (scheme A's "make all follow", asked only on click)
    expect(asks).toBe(5)
    expect(functionBody('offerFollowSwitch')).toContain('askFollowDialog(')
    expect(functionBody('onQuotaSwitchAccount')).toContain('askFollowDialog(')
    expect(functionBody('planAccountFollow')).toContain('askFollowDialog(')
  })

  it('sends nothing of its own to the backend: moves are ordinary resume rebuilds', () => {
    expect(followBlock).not.toContain('backend.send')
    expect(followBlock).not.toContain('sendQuiet')
    expect(followBlock).not.toContain('setDefault')
    expect(followBlock).not.toContain('quotaFailover')
  })
})

describe('follow switch wiring: flag on', () => {
  it('rebuilds on the chosen account and never forces a pane mid-turn', () => {
    const body = functionBody('moveFollowPanes')
    expect(body).toContain('rebuildPaneViaResume(id, { profileId, suppressBusyToast: true })')
    expect(body).not.toContain('forceWhenRunning')
    expect(body).toContain("i18n.global.t('account-follow.done-partial'")
  })

  it('waits on a pane parked on the user or holding typed input, not only a running one', () => {
    const body = functionBody('followPaneBusy')
    expect(body).toContain("if (status === 'awaiting') return true")
    expect(body).toContain('const hold = messagingHoldKey(paneId)')
    expect(body).toContain("if (hold === null || hold === 'gone') return false")
    expect(functionBody('moveFollowPanes')).toContain('isBusy: followPaneBusy,')
  })

  it('finds a chosen pane again by its session once another rebuild replaced its id', () => {
    expect(functionBody('followPaneNow')).toContain('paneResumeSessionId(p) === session')
    expect(functionBody('moveFollowPanes')).toContain('resolve: (id) => followPaneNow(id, sessions),')
  })

  it('remembers the conversations before asking: a pane rebuilt while the user decides still moves', () => {
    // Taken at move time, the old id would already be gone and the pane
    // reported as missing (review of #194, M4).
    for (const name of ['offerFollowSwitch', 'onQuotaSwitchAccount', 'unpinAllAccountPanes']) {
      const body = functionBody(name)
      const remember = body.indexOf('const sessions = followSessions(')
      expect(remember, name).toBeGreaterThan(-1)
      expect(remember, name).toBeLessThan(body.indexOf('askFollowDialog('))
    }
  })

  it('ends an open question unanswered before asking a new one', () => {
    expect(functionBody('askFollowDialog')).toContain('followDialog.value?.settle(null)')
  })

  it('moves to the account switched to, the Default as its reserved id', () => {
    const body = functionBody('offerFollowSwitch')
    expect(body).toContain('if (rows.length === 0) return')
    expect(body).toContain('const target = targetId ?? DEFAULT_SLOT_ID')
    expect(body).toContain('await moveFollowPanes(choice.paneIds, target, sessions)')
  })

  it('moves the out-of-quota pane first, then the peers ticked', () => {
    expect(functionBody('onQuotaSwitchAccount')).toContain(
      'await moveFollowPanes([paneId, ...choice.paneIds], choice.targetId, sessions)',
    )
  })
})

describe('follow the default account (plan_8debb8, scheme B) wiring', () => {
  it('moves following panes through the existing follow batch, not a new switch path', () => {
    const start = appSource.indexOf('provide(accountFollowKey, {')
    expect(start).toBeGreaterThan(-1)
    const block = appSource.slice(start, appSource.indexOf('\n})\n', start))
    expect(block).toContain('plan: planAccountFollow,')
    expect(block).toContain('move: moveFollowPanes,')
    const plan = functionBody('planAccountFollow')
    expect(plan).toContain('followingPaneRows(panes.value.map(followPaneInput), {')
    expect(plan).toContain('isFollowing: accountFollow.has,')
    // The menu path never swaps the live credential.
    expect(plan).not.toContain('cliAccountSwitch')
    expect(plan).not.toContain('setDefault(')
  })

  it('asks only about running panes, and a cancel moves nothing', () => {
    const plan = functionBody('planAccountFollow')
    expect(plan).toContain("if (running.length === 0) return idle")
    expect(plan).toContain("askFollowDialog({ mode: 'follow'")
    expect(plan).toContain('if (!choice) return null')
  })

  it('offers the toggle only on claude panes once an account runs on its own dir', () => {
    expect(appSource).toContain(':account-follow="paneAccountFollow(p)"')
    const fn = functionBody('paneAccountFollow')
    expect(fn).toContain('if (!accountFollowOffered.value || p.agentKey !== FOLLOW_SWITCH_AGENT) return undefined')
  })

  it('keeps the flag on a pane across rebuilds and restores', () => {
    expect(functionBody('rekeyLineage')).toContain('accountFollow.rekey(oldId, newId)')
  })
})

describe('scheme A (plan claude_f1bf4b): live switch, panes follow unless fixed', () => {
  it('marks every claude pane that will run on the live login as following, at spawn', () => {
    const body = functionBody('spawnPane')
    expect(body).toContain('accountFollow.add(id)')
    expect(body).toContain('!opts.isLogin')
    expect(body).toContain('!followDirSignedIn(opts.profileId)')
  })

  it("a rebuild decides the pin from the follow flag it read before the kill", () => {
    const body = functionBody('rebuildPaneViaResume')
    expect(body).toContain('following: accountFollow.has(paneId),')
    expect(body).toContain('accountSpawnPin(snap.profileId, snap.following, followDirSignedIn)')
    // An explicit account (quota move, fixing) makes the pane fixed.
    expect(body).toContain('if (explicitPin) accountFollow.remove(paneId)')
  })

  it('both restore paths send the pin through the same rule, once the account dirs are known', () => {
    const uses = appSource.split(
      'const restorePin = await restoreSpawnPin(saved.profile_id, accountFollow.has(saved.pane_id), followDirSignedIn, restorePinGate(saved.pane_id))'
    ).length - 1
    expect(uses).toBe(2)
    expect(appSource.split('profileId: restorePin,').length - 1).toBe(2)
    const gate = functionBody('restorePinGate')
    expect(gate).toContain('loaded: () => cliProfilesApi.loaded.value,')
    expect(gate).toContain('load: () => cliProfilesApi.ensureLoaded(),')
  })

  it('the account badge reads the account the pane really runs on', () => {
    expect(appSource).toContain(':profile-id="paneRunPin(p)"')
    expect(functionBody('followPaneInput')).toContain('profileId: paneRunPin(p),')
  })

  it('fixing and unfixing a pane reuse the ordinary rebuild', () => {
    expect(appSource).toContain('@toggle-account-follow="toggleAccountPin(p.id)"')
    const body = functionBody('toggleAccountPin')
    // A pane with no transcript yet reopens fresh rather than failing resume.
    expect(body).toContain('rebuildPaneViaResume(paneId, { freshWhenNoTranscript: true })')
    expect(body).toContain('rebuildPaneViaResume(paneId, { profileId: live, freshWhenNoTranscript: true })')
    // Fixing on an account without a dir login sends the user to sign in.
    expect(body).toContain('if (!followDirSignedIn(live))')
    expect(body).toContain('onCliLoginSpawn(FOLLOW_SWITCH_AGENT, undefined, { accountDirProfileId: live })')
    expect(body).not.toContain('continueWith')
  })

  it('"make all follow" runs only from the badge button, through the follow batch', () => {
    const refs = appSource.split('unpinAllAccountPanes').length - 1
    // the definition and the provide that hands it to the badge — nothing
    // calls it on a timer, a watcher or at start-up.
    expect(refs).toBe(2)
    const start = appSource.indexOf('provide(accountPinKey, {')
    expect(start).toBeGreaterThan(-1)
    expect(appSource.slice(start, appSource.indexOf('\n})\n', start))).toContain('unpinAll: unpinAllAccountPanes,')
    const body = functionBody('unpinAllAccountPanes')
    expect(body).toContain("askFollowDialog({ mode: 'unpin'")
    expect(body).toContain("await moveFollowPanes(ids, '', sessions)")
    // The flag goes on the pane as it is now, not on an id a rebuild retired.
    expect(body).toContain('const now = followPaneNow(id, sessions)')
    expect(body).toContain('if (now) accountFollow.add(now)')
  })

  it('reopens fresh only on the single-pane account moves, never in a batch', () => {
    // Fixing, unfixing and "continue on this account": the move is the point
    // and a pane with no transcript has nothing to lose. The follow batch and
    // every other rebuild keep the plain resume preflight.
    const optIns = appSource.split('freshWhenNoTranscript: true').length - 1
    expect(optIns).toBe(3)
    expect(functionBody('toggleAccountPin').split('freshWhenNoTranscript: true').length - 1).toBe(2)
    expect(appSource).toContain(
      'await rebuildPaneViaResume(paneId, { profileId, forceWhenRunning: true, freshWhenNoTranscript: true })'
    )
    expect(functionBody('moveFollowPanes')).not.toContain('freshWhenNoTranscript')
  })

  it("keeps #194's follow flow wired but no longer offered in this window", () => {
    expect(appSource).toContain('provide(accountFollowKey, {')
    expect(appSource).toContain('provide(accountPinKey, {')
  })
})
