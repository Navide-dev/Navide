// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// A manual relaunch used to bring back only the focused pane; everything that
// was mid-turn stayed a placeholder, and a spawned pane's owed report was
// dropped on purpose, so its parent never heard back. App.vue wires the pure
// helpers in lib/resumeBehavior.ts (unit-tested in resumeInterrupted.test.ts)
// into the restore path. It cannot be mounted, so the wiring is asserted
// against the source like the other App.*.test.ts files.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function fn(name: string): string {
  const start = appSource.search(new RegExp(`function ${name}\\(`))
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('recording what a pane was doing', () => {
  it('persists the turn state from the badge word reported to the registry', () => {
    // One expression for the badge word (see AccountModal.network.test.ts):
    // the recorder takes the status reportPaneBusy was handed, not a copy.
    expect(fn('reportPaneBusy')).toContain('persistPaneTurnState(paneId, status)')
  })

  it('writes only real turn states, deduped, and never for a pane still parked by a restore', () => {
    const body = fn('persistPaneTurnState')
    expect(body).toContain('turnStateForStatus(status)')
    // A resumed pane waiting on its continue button has unfinished work: writing
    // its idle prompt would make the next relaunch forget it.
    expect(body).toContain('pane.resumeContinueAvailable')
    expect(body).toContain('pane.restoring')
    expect(body).toContain("'project.set_pane_resume_state'")
    expect(body).toContain('last_turn_state: state')
  })
})

describe('writes that cannot land', () => {
  it('forgets a turn state whose write failed, so the next poll sends it again', () => {
    // Cached before the send; left cached after a failure, the dedupe would
    // swallow every retry and the relaunch would never resume this pane.
    const body = fn('persistPaneTurnState')
    expect(body).toMatch(/\.catch\(\(\) => \{[\s\S]*?if \(paneTurnStatePersisted\.get\(paneId\) === state\) paneTurnStatePersisted\.delete\(paneId\)/)
  })

  it('writes only for a workspace this window holds, which load_or_create would otherwise create', () => {
    expect(fn('persistPaneTurnState')).toContain('!isLocalWorkspace(pane.workspacePath)')
    expect(fn('persistPaneReportDebt')).toContain('!isLocalWorkspace(pane.workspacePath)')
  })
})

describe('the owed report survives a relaunch', () => {
  it('is persisted when the kickoff arms it', () => {
    const body = fn('kickoffRequestedPane')
    expect(body).toMatch(/live\.spawnReportPending = true[\s\S]*persistPaneReportDebt\(live\)/)
  })

  it('is persisted cleared when the first turn settles it, so it fires only once', () => {
    const body = fn('settleSpawnReport')
    expect(body).toMatch(/pane\.spawnReportPending = false\s*\n\s*persistPaneReportDebt\(pane\)/)
  })

  it('is re-armed on a pane resumed from its record', () => {
    const body = fn('performRealizeRestoredPane')
    expect(body).toMatch(/if \(isResume\) \{[\s\S]*saved\.report_pending[\s\S]*spawnedByName = saved\.report_to[\s\S]*spawnReportPending = true/)
  })

  it('is cleared for a pane restored into a fresh conversation, whose turn is gone', () => {
    const body = fn('performRealizeRestoredPane')
    expect(body).toMatch(/\} else \{[\s\S]*if \(saved\.report_pending && fresh\) persistPaneReportDebt\(fresh\)/)
  })
})

describe('resuming the interrupted panes on a relaunch', () => {
  it('marks a placeholder that was interrupted', () => {
    expect(appSource).toContain('interruptedAtLaunch: wasInterruptedAtLaunch(saved) || undefined')
  })

  it('adds the interrupted targets only to a cold restore that resumes', () => {
    const body = fn('advanceRestoreSession')
    expect(body).toContain("trigger === 'cold' && decision === 'resume'")
    expect(body).toContain('interruptedLaunchTargets(session.workspacePath)')
  })

  it('starts them two at a time with the existing concurrency helper', () => {
    const body = fn('advanceRestoreSession')
    expect(body).toMatch(/interrupted\.length > 0[\s\S]*runWithConcurrency\(ids, ALL_SCOPE_RESTORE_CONCURRENCY/)
  })

  it('is gated by its own setting and capped', () => {
    const body = fn('interruptedLaunchTargets')
    expect(body).toContain('normalizeResumeInterruptedOnLaunch(settingsGet(RESUME_INTERRUPTED_ON_LAUNCH_SETTING_KEY, true))')
    expect(body).toContain('limit: INTERRUPTED_RESUME_LIMIT')
  })

  it('reuses realizeRestoredPane, which already offers the continue button on a resume', () => {
    // No second resume mechanism: the cold path's isResume branch sets it.
    expect(fn('performRealizeRestoredPane')).toMatch(/if \(isResume\) \{[\s\S]*resumeContinueAvailable = true/)
  })

  it('shows the interrupted marker on a placeholder', () => {
    expect(appSource).toContain(':interrupted="p.interruptedAtLaunch"')
  })
})

describe('telling the parent', () => {
  it('notifies parents after the cold batch', () => {
    const body = fn('advanceRestoreSession')
    expect(body).toMatch(/notifyInterruptedParents\(interruptedKids\)/)
  })

  it('sends one notice per parent, as a notice, listing who came back', () => {
    const body = fn('notifyInterruptedParents')
    expect(body).toContain('renderInterruptedChildrenNotice(')
    expect(body).toContain("{ kind: 'notice' }")
    expect(body).toContain('NOTICE_SENDER')
  })
})
