// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend/terminal/settings lifecycles, so — like the other
// App.*.test.ts files — these assert against the source text. The behaviour
// they guard is App.vue's wiring of the quota-failover contract; the logic
// behind it is unit-tested in composables/__tests__/useQuotaFailover.test.ts
// and lib/__tests__/quotaFailover.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionBody(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  return appSource.slice(start, appSource.indexOf('\n}', start))
}

describe('quota failover wiring: reports', () => {
  it('reports a pane-text hit to the failover authority with the text as evidence', () => {
    const body = functionBody('checkPaneUsageLimit')
    const report = body.indexOf('quotaFailover.report({')
    expect(report).toBeGreaterThan(-1)
    const block = body.slice(report, body.indexOf('})', report))
    expect(block).toContain("source: 'cli-text'")
    expect(block).toContain('text: hit.message')
    expect(block).toContain('resetsAt: hit.resetAt')
    // Once per hit, never per poll: the report sits after the consume/flag
    // block, alongside the ledger stamp.
    expect(body.indexOf("sendQuiet('tokens.quota_exhausted'")).toBeLessThan(report)
  })

  it('reports a reading-driven flag as a usage-window signal naming the spent window', () => {
    const body = functionBody('raiseFromQuotaReading')
    expect(body).toContain("source: 'usage-window'")
    expect(body).toContain('windowKind: spent?.kind ?? null')
    expect(body).not.toContain('text:')
  })

  it("reports a vendor's structured turn outcome (droid) as the same cli-text signal", () => {
    const start = appSource.indexOf("backend.on('agent.activity'")
    const block = appSource.slice(start, appSource.indexOf("} else if (ev.event_type === 'agent_active')", start))
    expect(block).toContain('quotaExhausted?.turnDetail')
    expect(block).toContain('ev.detail === turnDetail')
    expect(block).toContain("source: 'cli-text'")
    expect(block).toContain('text: ev.detail')
  })
})

describe('quota failover wiring: prepare readiness', () => {
  const body = functionBody('quotaPaneReadiness')

  it('is a turn boundary judged by the messaging hold, never silence', () => {
    expect(body).toContain('messagingHoldKey(paneId)')
    expect(body).toContain("if (hold !== null) return { ready: false, reason: 'busy' }")
  })

  it('refuses a pane parked on a permission box or holding unsent input, and waits on a busy one', () => {
    expect(body).toContain("if (status === 'awaiting') return { ready: false, reason: 'permission-pending' }")
    expect(body).toContain("return { ready: false, reason: 'input-pending' }")
    expect(body).toContain("status === 'starting' ? { ready: false, reason: 'busy' }")
  })

  it('a restart switch runs the rebuild preflight: vendor resumes by id, rebuild gate, session on disk', () => {
    expect(body).toContain("if (!spec?.resumeArgs) return { ready: false, reason: 'not-resumable' }")
    expect(body).toContain("if (!sessionId) return { ready: false, reason: 'no-session' }")
    expect(body).toContain('sessionId = paneResumeSessionId(pane)')
    expect(body).toContain("if (!paneCanRebuild(pane)) return { ready: false, reason: 'not-resumable' }")
    expect(body).toContain('await canResumeSession(pane.agentKey, pane.workspacePath, sessionId)')
    expect(body).toContain("if (onDisk !== true) return { ready: false, reason: onDisk === false ? 'no-session' : 'not-resumable' }")
    // The probe is async; a pane that started working meanwhile is busy again.
    expect(body).toContain("if (messagingHoldKey(paneId) !== null) return { ready: false, reason: 'busy' }")
  })
})

describe('quota failover wiring: commit', () => {
  it('restarts through the resume rebuild with the continue button lit and no forced kill', () => {
    const body = functionBody('quotaRestartPane')
    expect(body).toContain('rebuildPaneViaResume(pane.paneId, {')
    expect(body).toContain('offerContinue: true')
    expect(body).not.toContain('forceWhenRunning')
    expect(body).toContain('onReplaced')
    // The settle names the new PTY and the session it came back on.
    expect(body).toContain("outcome: 'resumed'")
    expect(body).toContain('paneRefs[id]?.sessionId')
  })

  it('a new-conversation switch keeps the old pane and spawns beside it, with no role, stage or task', () => {
    const body = functionBody('quotaOpenNewConversation')
    expect(body).toContain('onManualSpawn({')
    expect(body).not.toContain('onKill(')
    expect(body).toContain("outcome: 'new-conversation'")
    // The user agreed to a new conversation, not to a replay of the old
    // pane's task: no role prompt, no stage affiliation, no kickoff.
    expect(body).toContain("roleKey: '',")
    expect(body).toContain("stageId: '',")
    expect(body).not.toContain('kickoffPrompt')
    expect(body).not.toContain('old?.roleKey')
    expect(body).not.toContain('old?.stageId')
  })

  it('sends no prompt, continue or loop resume after a switch — the continue button is the only continuation', () => {
    for (const name of ['quotaRestartPane', 'quotaOpenNewConversation']) {
      const body = functionBody(name)
      expect(body, name).not.toContain('fireLoopResume')
      expect(body, name).not.toContain('injectText')
      expect(body, name).not.toContain('pasteText')
      expect(body, name).not.toContain('kickoffPrompt')
    }
    const clear = functionBody('clearPaneUsageLimit')
    expect(clear).toContain('if (pane.loopActive && !opts.resumeLoop)')
    expect(clear).toContain('pane.resumeContinueAvailable = true')
  })

  it("the commit's cli_profiles.changed clears flags without resuming a loop; a manual switch keeps its behaviour", () => {
    const start = appSource.indexOf("backend.on('cli_profiles.changed'")
    const block = appSource.slice(start, appSource.indexOf('\n})', start))
    expect(block).toContain('resumeLoop: !quotaFailover.agentHasActiveTransaction(ev.agent_key)')
  })

  it('keeps the pane\'s scrollback through the restart: serialized before the kill, replayed into the replacement', () => {
    const restart = functionBody('quotaRestartPane')
    expect(restart).toContain('preserveScrollback: true')
    // Only the quota restart and the API key takeover (reopenOnKey) ask for it;
    // an ordinary rebuild still relies on the CLI's own resume reprint
    // (unchanged behaviour).
    expect(appSource.match(/preserveScrollback: true/g)).toHaveLength(2)
    const rebuild = functionBody('rebuildPaneViaResume')
    const serialized = rebuild.indexOf('serializeScrollback')
    const killed = rebuild.indexOf('await onKill(paneId, { markRemoved: false, force: true, keepInList: true })')
    const spawned = rebuild.indexOf('scrollbackHandoff: scrollbackHandoff || undefined')
    expect(serialized).toBeGreaterThan(-1)
    // Taken from the live xterm BEFORE the kill (the exit discards the stored
    // snapshot), handed to the spawn AFTER it.
    expect(serialized).toBeLessThan(killed)
    expect(killed).toBeLessThan(spawned)
    // The capture awaits xterm's parser; the pane is re-judged before the kill
    // so work or typing that started during the wait stops the restart.
    expect(rebuild).toContain('scrollbackHandoff = (await serialize?.()) ?? \'\'')
    const rejudged = rebuild.indexOf("if (messagingHoldKey(paneId) !== null) return 'busy'", serialized)
    expect(rejudged).toBeGreaterThan(serialized)
    expect(rejudged).toBeLessThan(killed)
    // No term.clear anywhere on this path, and the handoff is display only.
    expect(rebuild).not.toContain('term.clear')
    expect(appSource).toContain('replayScrollback: opts.scrollbackHandoff')
  })

  it('carries the quota-gate anchors across the pane id change of a rebuild', () => {
    const body = functionBody('rebuildPaneViaResume')
    expect(body).toContain('usageLimitSeenAt: pane.usageLimitSeenAt ?? null')
    expect(body).toContain('quotaGateIncidentId: pane.quotaGateIncidentId ?? null')
    expect(body).toContain('revived.usageLimitSeenAt = snap.usageLimitSeenAt')
    expect(body).toContain('revived.quotaGateIncidentId = snap.quotaGateIncidentId')
  })
})

describe('quota failover wiring: pipeline gate', () => {
  it('holds the stage quota gate on affected panes from commit until backend verified recovery or the user', () => {
    expect(functionBody('paneUsageLimited')).toContain('pane?.quotaGateIncidentId != null')
    const init = appSource.slice(appSource.indexOf('quotaFailover.initQuotaFailover(backend, {'))
    const commit = init.slice(init.indexOf('onSwitchCommitted:'), init.indexOf('onIncidentReady:'))
    expect(commit).toContain('pane.quotaGateIncidentId = ev.incidentId')
    expect(init).toContain('onIncidentReady: (incident: FailoverIncident) => releaseQuotaGate(incident.id)')
    const release = functionBody('releaseQuotaGate')
    expect(release).toContain('pane.quotaGateIncidentId = null')
    // A stopped incident (quota unconfirmed, new account exhausted too) is
    // not a recovery and never lifts the hold.
    expect(appSource).not.toContain("inc.state === 'notify-stopped') releaseQuotaGate")
    // Evidence that does: a current reading with headroom, or the user's dismiss.
    const check = functionBody('checkPaneUsageLimit')
    expect(check).not.toContain('pane.quotaGateIncidentId = null')
    expect(functionBody('dismissPaneUsageLimit')).toContain('pane.quotaGateIncidentId = null')
  })

  it('keeps the turn-freshness barrier: the gate reads usageLimitSeenAt, which a rebuild preserves', () => {
    expect(appSource).toContain('quotaSeenAt: p.usageLimitSeenAt ?? 0')
    expect(appSource).toContain('turnSourceAt: paneTurnCompleteSourceAt.get(p.id) ?? 0')
  })
})

describe('quota failover wiring: turn evidence and announcements', () => {
  it('stamps each turn start and hands turn ends to the settle path with the PTY id', () => {
    const start = appSource.indexOf("backend.on('agent.activity'")
    const block = appSource.slice(start, appSource.indexOf('\n})', start))
    expect(block).toContain('paneTurnStartedAt.set(ev.pane_id, Date.now())')
    expect(block).toContain('quotaFailover.noteTurnComplete(')
    expect(block).toContain('paneTurnStartedAt.get(ev.pane_id) ?? null')
    // A superseded turn (the Stop hook took a queued message) is not a turn end.
    const note = block.slice(block.indexOf('quotaFailover.noteTurnComplete(') - 200, block.indexOf('quotaFailover.noteTurnComplete('))
    expect(note).toContain('if (!ev.superseded)')
  })

  it('routes announcement buttons to the composable, which re-validates against the backend', () => {
    expect(appSource).toContain('@quota-action="(action) => void quotaFailover.actOn(action)"')
    // The existing update actions keep their handlers.
    expect(appSource).toContain('@download="startUpdateDownload()"')
    expect(appSource).toContain('@install="onUpdateBadgeClick()"')
  })

  it('labels accounts through the shared account label and asks before a lossy switch', () => {
    const init = appSource.slice(appSource.indexOf('quotaFailover.initQuotaFailover(backend, {'), appSource.indexOf('function releaseQuotaGate'))
    expect(init).toContain('accountLabel(cliProfilesApi, agentKey,')
    expect(init).toContain("i18n.global.t('announce.quota.confirm-new-conversation-body'")
    expect(init).toContain("i18n.global.t('announce.quota.switch-refused'")
  })
})
