// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// App.vue mounts backend/terminal/onboarding lifecycles, so it is not
// practical to mount here (see App.logPreview.test.ts). The reclaim DECISION
// lives in lib/idleReclaim.ts and is unit-tested there; what this file guards
// is the wiring, where the damaging mistakes are: reclaiming that closes the
// pane for real, or that leaves it unable to come back.
const appSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/App.vue'),
  'utf8'
)

function block(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

const reclaimFn = () =>
  block('async function reclaimIdlePane(', 'let _idleReclaimTimer')

describe('idle reclaim wiring', () => {
  it('shares the existing resource poller with risk UI and excludes reclaimed placeholders', () => {
    const wiring = block('const resourceUsage = useResourceUsage({', 'const resourceRows = computed')
    expect(wiring).toContain("requestCliRiskAction: (payload) => backend.send('terminal.cli_risk_action', { ...payload })")
    expect(wiring).toContain('paneCount: realizedPaneCount')
    expect(wiring).toContain('provide(cliRiskKey, resourceUsage)')
    expect(appSource).toMatch(/<TerminalPane\s+v-if="p.realized"/)
  })

  // markRemoved unspawns the backend record. A reclaim that did that would
  // survive as a real close on the next restart — the conversation would not
  // come back, which is the opposite of the deal this feature offers.
  it('keeps the backend pane record so the placeholder can resume from it', () => {
    expect(reclaimFn()).toContain('markRemoved: false')
  })

  // Without keepInList the pane is spliced out of the list and its seat, name
  // and group are gone.
  it('keeps the pane in the list, in its seat', () => {
    expect(reclaimFn()).toContain('keepInList: true')
  })

  // force kills with SIGKILL. The resume depends on the transcript the CLI is
  // still writing, so the reclaim asks it to stop rather than shooting it.
  it('ends the CLI gracefully rather than force-killing it', () => {
    expect(reclaimFn()).toContain('force: false')
  })

  // realized=false alone leaves a pane that renders as a placeholder but has no
  // metadata to realize — a dead seat the user cannot click back to life.
  it('turns the pane back into a placeholder WITH its restore metadata', () => {
    const fn = reclaimFn()
    expect(fn).toContain('realized = false')
    expect(fn).toContain('deferredRestore = {')
    expect(fn).toContain('saved,')
  })

  // Spawn history marks a removal unconditionally inside onKill, and a reclaim
  // is not a removal — the pane keeps its seat and its resume id.
  it('does not record the pane as removed in spawn history', () => {
    const fn = reclaimFn()
    expect(fn).toContain('const alreadyRemoved = !!histEntry?.removedAt')
    expect(fn).toContain('if (histEntry && !alreadyRemoved) histEntry.removedAt = undefined')
  })

  // What "focused" means is decided by focusedForReclaim, which idleReclaim's
  // own suite runs against both ids. All this file can add is that App.vue
  // hands it the two it holds — passing effectiveFocusPaneId twice, or the raw
  // ref twice, would pass that suite and still reclaim the pane on screen.
  it('hands the focus decision both ids it holds', () => {
    const fn = block('function reclaimCandidate(', 'function paneReclaimable(')
    expect(fn).toContain(
      'focused: focusedForReclaim(focusPaneId.value, effectiveFocusPaneId.value, pane.id)'
    )
  })

  // The three "someone else is holding this pane" guards are decided in
  // idleReclaim.ts and tested there. What only this file can show is that the
  // candidate asks the live subsystems at all — a guard wired to a constant
  // false passes that suite and protects nothing.
  it('asks each holding subsystem whether it still wants the pane', () => {
    const fn = block('function reclaimCandidate(', 'function paneHeldByStageRouter(')
    expect(fn).toContain('managerRouting: paneHeldByStageRouter(pane.id)')
    expect(fn).toContain('stageWatched: watchers.has(pane.id)')
    expect(fn).toContain('hasQueuedMessages: messaging.queuedCountFor(pane.id) > 0')
  })

  // Both roles, because the manager is not the only pane a router scrapes —
  // it is only the one that stays idle longest.
  it('counts a router-held pane in either role', () => {
    const fn = block('function paneHeldByStageRouter(', '/** The saved record')
    expect(fn).toContain('router.managerPaneId === paneId')
    expect(fn).toContain('workerPaneId === paneId')
  })

  // The realize path rebuilds launch flags from the saved record. Model and
  // effort missing there is silent: the pane comes back on the vendor default.
  it('carries the launch flags into the placeholder record', () => {
    const fn = block('function projectPaneFromActive(', '/** Kill one idle pane')
    expect(fn).toContain('model: pane.model')
    expect(fn).toContain('effort: pane.effort')
  })

  // onKill speaks for a pane that is leaving and says so to several subsystems.
  // A reclaim is not that, so each farewell is taken back — and every one of
  // these has to be read BEFORE the kill, which is what makes them easy to lose
  // in a later edit.
  it('takes back the farewells onKill sends on the pane behalf', () => {
    const fn = reclaimFn()
    // The handle: onKill drops the persisted name, so realize would re-derive a
    // different one and every sender that knew the old name would be writing
    // into nothing.
    // Live handle first: the persisted map is capped and evicts, so it can
    // have lost the name of a pane that is still here.
    expect(fn).toContain('pane.messagingName as string | undefined) || persistedMessagingName(paneId)')
    expect(fn).toContain('registerPaneMessaging(stillThere, messagingName)')
    // The handoffs: the destination is the pane, which is still there.
    expect(fn).toContain("issueHandoffs.value.set(key, { ...current, state })")
    // Loop state is deliberately NOT restored: the fields can be copied back
    // but the watcher that drives them cannot, and a LOOP badge with nothing
    // advancing it is worse than no badge.
    expect(fn).not.toContain('stillThere.loopActive =')
  })

  it('sweeps on a timer and clears it on unmount', () => {
    expect(appSource).toContain('window.setInterval(() => { void sweepIdlePanes() }, IDLE_RECLAIM_SWEEP_MS)')
    expect(appSource).toContain('if (_idleReclaimTimer !== null) clearInterval(_idleReclaimTimer)')
  })

  // The sweep awaits a kill between candidates, so the user can focus or type
  // into the next pane while it runs — its snapshot goes stale mid-loop.
  it('re-checks each pane immediately before reclaiming it', () => {
    const sweep = block('async function sweepIdlePanes(', 'onMounted(() => {')
    expect(sweep).toContain('if (!pane || !paneReclaimable(pane, Date.now())) continue')
  })

  it('does nothing at all while the setting is off', () => {
    const sweep = block('async function sweepIdlePanes(', 'onMounted(() => {')
    expect(sweep).toContain('if (!idleReclaimEnabled.value) return')
  })

  // "Never" is a threshold the timer can never reach. The sweep stops on it
  // outright rather than measuring ages it would refuse to act on.
  it('does nothing at all while the threshold is never', () => {
    const sweep = block('async function sweepIdlePanes(', 'onMounted(() => {')
    expect(sweep).toContain('if (idleReclaimDisabled(idleReclaimMinutes.value)) return')
  })

  // The setting governs the timer. A user who switched off the sweep did not
  // ask to lose the button, and the button's own guards are unchanged.
  it('leaves manual reclaim outside the never check', () => {
    const fn = block('async function reclaimPanesNow(', 'onMounted(() => {')
    expect(fn).not.toContain('idleReclaimDisabled')
    expect(fn).not.toContain('idleReclaimMinutes')
    const ids = block('const reclaimableNowIds = computed<string[]>', 'const RECLAIM_ESTIMATE_BYTES_PER_CLI')
    expect(ids).not.toContain('idleReclaimDisabled')
    expect(ids).not.toContain('idleReclaimMinutes')
  })

  // A manual reclaim must not become a way around the guards — the only thing
  // pressing the button skips is the waiting.
  it('runs manual reclaim through the same guards, minus the age check', () => {
    const fn = block('async function reclaimPanesNow(', 'onMounted(() => {')
    expect(fn).toContain(': reclaimBlockedBy(reclaimCandidate(pane), RECLAIM_NOW_THRESHOLD_MS, Date.now())')
    expect(fn).toContain('? namedReclaimBlockedBy(reclaimCandidate(pane), Date.now())')
    // A blocked pane is skipped (and, when a caller collects outcomes, recorded).
    expect(fn).toMatch(/if \(blocked !== null\) \{\n[^\n]*\n\s*continue\n/)
  })

  it('offers the same candidate list to every reclaim-now control', () => {
    expect(appSource).toContain('const reclaimableNowIds = computed<string[]>')
    expect(appSource).toContain(':reclaimable-now-count="reclaimableNowIds.length"')
  })

  // The measurement shells out to footprint, whose cost scales with the pane
  // count — on a timer it would be a tax paid forever for a panel nobody has
  // open.
  // The cadence itself is useResourceUsage's (and tested there); what has to be
  // true here is that App.vue hands it the two inputs that pick the cadence —
  // the realized pane count and whether the panel is open — rather than a
  // constant that would leave the loop running over an empty machine.
  it('drives the sampling loop from the pane count and the open panel', () => {
    const fn = block('const resourceUsage = useResourceUsage({', 'const resourceRows = computed<')
    expect(fn).toContain("sendQuiet<ResourceUsageWire>('terminal.resource_usage', {})")
    expect(fn).toContain('paneCount: realizedPaneCount')
    expect(fn).toContain('panelOpen: resourcePanelOpen')
  })

  // A pane rebuilt around a new PTY gets a new pane id, and the backend still
  // reports the session it created the PTY under. The session id is the key
  // this window holds itself, so it cannot drift the same way.
  it('keys measurements by terminal session id, with pane id as the fallback', () => {
    const fn = block('const resourceRows = computed<ResourceSummaryRow[]>', 'const resourcePillText = computed(')
    expect(fn).toContain('const sessionKey = (paneRefs[p.id]?.sessionId as unknown as string) ?? \'\'')
    // The session-keyed maps never hold a bare pane id, so the fallback has to
    // read the pane-id index the composable keeps for exactly this — looking a
    // pane id up in the session map would always miss and report zero.
    expect(fn).toContain('known ? bytesByKey.get(sessionKey) : bytesByPane.get(p.id)')
    expect(fn).toContain('known ? cpuByKey.get(sessionKey) : cpuByPane.get(p.id)')
  })

  // Reclaiming from the panel re-measures rather than closing it: the point is
  // to watch the machine get its resources back.
  it('re-measures after an explicit reclaim from the panel', () => {
    const fn = block('async function onResourceReclaim(', 'function openResourceManager(')
    expect(fn).toContain('await reclaimPanesNow()')
    expect(fn).toContain('void resourceUsage.refresh()')
  })

  // The timed sweep is housekeeping the user did not ask for, so it logs rather
  // than interrupting with a toast. A reclaim the user pressed for still says so.
  it('logs the timed sweep without a toast, and reports an explicit reclaim', () => {
    const sweep = block('async function sweepIdlePanes(', '/** Panes the user could reclaim')
    expect(sweep).toContain('pipelineLog(')
    expect(sweep).not.toContain('notifyRestore.toast(')
    const onRequest = block('async function reclaimPanesNow(', 'onMounted(() => {')
    expect(onRequest).toContain('pane.terminal.idle-reclaimed')
  })
})

// The pane right-click menu is the per-pane entry point, hand-written in the
// template next to Interrupt and Reapply role. The decision it defers to is
// already covered above; what rots here is the wiring between the two.
describe('reclaim in the pane context menu', () => {
  const menuItem = () => block("$t('action.reapply-role')", "$t('action.remove')")

  it('offers a reclaim on the right-clicked pane', () => {
    expect(menuItem()).toContain("$t('action.reclaim')")
  })

  // The greyed-out state must come from the same guard the click runs, or the
  // menu offers a reclaim it then refuses. The right-clicked pane is named by
  // the user, so it uses the named guard, which lets the focused pane through.
  it('takes the greyed-out state from the named reclaim guard', () => {
    expect(menuItem()).toContain('disabled: !ctxReclaimable')
    const menu = block('const ctxReclaimable = computed', '// "Send message"')
    expect(menu).toContain('return namedReclaimable(m.paneId, Date.now())')
    expect(menu).toContain('reclaimPanesNow([paneId], true)')
  })

  // Calling reclaimPanesNow straight from the template swallows the refusal:
  // queued messages and stage watchers live in plain Maps that never invalidate
  // the candidate list, so a clickable item can still be turned down, and the
  // count comes back 0 with nothing said.
  it('reports a refused reclaim instead of looking like a no-op', () => {
    expect(menuItem()).toContain('reclaimPaneFromMenu(')
    const handler = block('async function reclaimPaneFromMenu(', '// "Send message"')
    expect(handler).toContain('resource.reclaim-blocked')
  })
})

// The project-level entry point: one row on a workspace heading's menus that
// reclaims every reclaimable CLI in THAT project. It spans two files, so what
// rots is the wiring between them — the count App publishes, the prop the menu
// reads, and the event that comes back.
describe('reclaim a whole workspace from the sidebar', () => {
  const controlPane = readFileSync(
    resolve(__dirname, '../ControlPane.vue'),
    'utf8'
  )

  it('counts reclaimable panes per workspace, not window-wide', () => {
    const counts = block('const reclaimableByWorkspace = computed', '/** "Reclaim this project')
    expect(counts).toContain('reclaimableNowIds.value')
    expect(counts).toContain('normWs(p.workspacePath)')
    expect(appSource).toContain(':reclaimable-by-workspace="reclaimableByWorkspace"')
  })

  // Reclaiming another project's panes from this heading would be the bug the
  // per-workspace rebuild count was added to fix.
  it('reclaims only the panes of the workspace that was clicked', () => {
    const handler = block('async function onReclaimWorkspacePanes(', 'onMounted(() => {')
    expect(handler).toContain('reclaimableNowIds.value.filter(')
    expect(handler).toContain('normWs(panes.value.find')
    expect(handler).toContain('reclaimPanesNow(ids)')
    // Same refusal notice the per-pane item shows: the count can go stale.
    expect(handler).toContain('resource.reclaim-blocked')
    expect(appSource).toContain('@reclaim-workspace-panes="onReclaimWorkspacePanes"')
  })

  it('offers the row in both of a heading\'s menus, greyed out at zero', () => {
    expect(controlPane).toContain("reclaimableByWorkspace?: Record<string, number>")
    expect(controlPane).toContain("(e: 'reclaim-workspace-panes', workspacePath: string): void")
    expect(controlPane).toContain("wsMenuAction('reclaim')")
    expect(controlPane).toContain("wsMoreAction('reclaim')")
    expect(controlPane).toContain('wsReclaimableCount(wsMenu.path) === 0')
    expect(controlPane).toContain('wsReclaimableCount(wsMoreMenuPath) === 0')
  })
})

// Settings → Resource limits: the timed sweep honors "also reclaim the focused
// pane after N hours" (focusedReclaimBlockedBy), read from the shared limits
// composable so a change in Settings takes effect on the next sweep.
describe('the timed sweep and the focused-pane option', () => {
  it('judges panes with the focused-pane threshold from Settings', () => {
    const fn = block('function paneReclaimable(', '/** The saved record a placeholder needs')
    expect(fn).toContain('focusedReclaimBlockedBy(')
    expect(fn).toContain('focusedReclaimHours.value * 3_600_000')
  })
})
