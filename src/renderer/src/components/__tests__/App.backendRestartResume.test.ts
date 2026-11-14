// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// H3: what a backend restart does to the window's CLI panes. The planning is a
// pure helper (lib/backendRestartResume.ts); App.vue cannot be mounted by this
// suite, so its wiring is asserted against the source like the other
// App.*.test.ts files.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function fn(name: string): string {
  const start = appSource.search(new RegExp(`function ${name}\\(`))
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('the switch', () => {
  it('stays the only gate: off, a lost PTY is ignored exactly as before', () => {
    const body = fn('onPanePtyLost')
    const firstLine = body.split('\n')[1]
    expect(firstLine).toBe(
      '  if (!normalizeAutoResumeOnReconnect(settingsGet(AUTO_RESUME_ON_RECONNECT_SETTING_KEY, true))) return',
    )
  })

  it('collects off-screen panes only after the switch check', () => {
    const body = fn('onPanePtyLost')
    const gate = body.indexOf('AUTO_RESUME_ON_RECONNECT_SETTING_KEY')
    const offScreen = body.indexOf('pendingOffScreenPtyLostPanes.add(paneId)')
    expect(gate).toBeGreaterThan(-1)
    expect(offScreen).toBeGreaterThan(gate)
    expect(body).toMatch(/if \(!onScreenPaneIds\.value\.has\(paneId\)\) pendingOffScreenPtyLostPanes\.add\(paneId\)\s*\n\s*else pendingPtyLostPanes\.add\(paneId\)/)
  })

  it('fills the off-screen batch nowhere else, so with the switch off nothing new runs', () => {
    expect(appSource.match(/pendingOffScreenPtyLostPanes\.add\(/g)).toHaveLength(1)
    expect(appSource.match(/void flushPtyLostResumes\(\)/g)).toHaveLength(1)
  })
})

describe('the wave', () => {
  it('plans through planBackendRestartResume with the crash-loop signal', () => {
    const body = fn('flushPtyLostResumes')
    expect(body).toContain('isRepeatCrash(backendLossAutoRestartAttempt, lastReconnectedAutoRestartAttempt)')
    expect(body).toContain('planBackendRestartResume(lost, { crashLoop })')
    expect(body).toContain('runWithConcurrency(plan.resume, ALL_SCOPE_RESTORE_CONCURRENCY')
  })

  it('remembers the attempt this wave came back on, then resets the captured one', () => {
    const body = fn('flushPtyLostResumes')
    const check = body.indexOf('isRepeatCrash(')
    expect(body.indexOf('lastReconnectedAutoRestartAttempt = backendLossAutoRestartAttempt')).toBeGreaterThan(check)
    expect(body.indexOf('backendLossAutoRestartAttempt = null')).toBeGreaterThan(
      body.indexOf('lastReconnectedAutoRestartAttempt = backendLossAutoRestartAttempt'))
  })

  it('reads working from the snapshot taken when the backend went away', () => {
    expect(fn('flushPtyLostResumes')).toContain('working: interruptedAtBackendLoss.has(id)')
    expect(appSource).toMatch(/watch\(\(\) => backend\.status\.value, \(status, prev\) => \{\s*\n\s*if \(status === 'connected' \|\| prev !== 'connected'\) return[\s\S]*?shown === 'running' \|\| shown === 'awaiting'/)
  })

  it('captures the auto-restart attempt before the connect clears it', () => {
    expect(appSource).toMatch(/watch\(\(\) => backend\.autoRestart\.value, \(auto\) => \{\s*\n\s*if \(auto\) backendLossAutoRestartAttempt = auto\.attempt/)
  })

  it('keeps the two toasts and discloses the wave in the announcements centre', () => {
    const body = fn('flushPtyLostResumes')
    expect(body).toContain("'pane.terminal.session-resumed'")
    expect(body).toContain("'pane.terminal.session-resume-failed'")
    expect(body).toContain('announcements.noteBackendRestart({')
    expect(body).toContain("reason: 'failed' as const")
  })

  it('tells parents with the backend-restart wording', () => {
    const body = fn('flushPtyLostResumes')
    expect(body).toContain("notifyInterruptedParents(kids, 'backend-restart', resumedIds)")
    const notify = fn('notifyInterruptedParents')
    expect(notify).toContain("cause: 'relaunch' | 'backend-restart' = 'relaunch'")
    expect(notify).toContain('renderInterruptedChildrenNotice(children, cause)')
  })

  it('leaves the relaunch parent notice on its default wording', () => {
    expect(appSource).toContain('if (interruptedKids.length > 0) notifyInterruptedParents(interruptedKids)\n')
  })

  it('re-arms the owed report on the rebuilt pane, only on this path', () => {
    const body = fn('flushPtyLostResumes')
    expect(body).toMatch(/revived\.spawnedByName = debt\.parentName\s*\n\s*revived\.spawnReportPending = true[\s\S]*persistPaneReportDebt\(revived\)/)
    expect(fn('rebuildPaneViaResume')).not.toContain('spawnReportPending')
  })
})

describe('the Rebuild on an announcement row', () => {
  it('is wired from the panel', () => {
    expect(appSource).toContain('@pane-action="(action) => void onBackendRestartPaneAction(action)"')
  })

  it('is the plain user rebuild, without the continue offer', () => {
    const body = fn('onBackendRestartPaneAction')
    expect(body).toContain('await rebuildPaneViaResume(action.paneId)\n')
    expect(body).not.toContain('offerContinue')
    expect(body).toContain('announcements.dropBackendRestartPane(action.paneId)')
  })
})
