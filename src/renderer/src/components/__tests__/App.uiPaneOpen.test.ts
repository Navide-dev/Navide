// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// ui.pane.open is the official form of what ui.pane.focus does as a side
// effect: it opens a cold-restore placeholder, waits for the restore to end,
// reports why it did or did not open, and never raises the workspace-wide
// "resume which?" modal under ask mode. The action bus and the restore path
// live in App.vue, which the suite cannot mount, so they are asserted against
// the source the way the other App.*.test.ts files do. The decision rule it
// leans on — explicitRestoreDecision — is unit-tested in
// lib/__tests__/resumeBehavior.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function command(name: string): string {
  const start = appSource.indexOf(`registerCommand('${name}'`)
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n})\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

function fn(name: string): string {
  const start = appSource.indexOf(`async function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('ui.pane.open', () => {
  it('is registered on the action bus', () => {
    expect(command('ui.pane.open')).toContain('ui.pane.open requires')
  })

  it('opens the placeholder through the explicit restore path', () => {
    // explicit is what keeps ask mode from raising the modal for a pane an
    // agent named by id.
    expect(command('ui.pane.open')).toContain('realizeRestoredPane(paneId, false, { explicit: true, requireResume')
  })

  it('passes requireResume through only when the caller asked for it', () => {
    // A chat's wake must come back on the pane's own conversation; every other
    // caller keeps the old behavior, a fresh session included. The answer rule
    // itself is unit-tested in lib/__tests__/paneOpenAnswer.test.ts.
    const body = command('ui.pane.open')
    expect(body).toContain('const required = requireResume === true')
    expect(body).toContain('{ explicit: true, requireResume: required }')
    expect(body).toContain('launchedSessionId: opened?.launchedSessionId')
  })

  it('answers an already-open pane without restarting it', () => {
    const body = command('ui.pane.open')
    const answer = body.indexOf("paneOpenAnswer({ paneId, reason: 'already-open', realized: true")
    expect(answer).toBeGreaterThan(-1)
    expect(answer).toBeLessThan(body.indexOf('realizeRestoredPane('))
  })

  it('reports the id the restored pane is known by now', () => {
    // A restore rebuilds the pane under a fresh runtime id; the old id is an
    // alias. Looking the pane up by the old id alone would answer realized
    // false for a pane that just opened.
    expect(command('ui.pane.open')).toContain('p.formerPaneIds?.includes(paneId)')
  })
})

describe('realizeRestoredPane', () => {
  it('applies requireResume to a realize that is already running', () => {
    expect(fn('realizeRestoredPane')).toContain(
      'if (pending) return pending.then((outcome) => joinedRealizeOutcome(outcome, opts?.requireResume === true))')
  })
})

describe('performRealizeRestoredPane', () => {
  it('records the session it launched the pane on', () => {
    expect(fn('performRealizeRestoredPane')).toContain("launched.launchedSessionId = isResume ? effectiveResumeId : ''")
  })

  it('refuses a second pane onto a session another pane runs, restores or is queued to restore', () => {
    // Checked before `restoring` is set, with no await in between: the renderer is single
    // threaded, so a cold restore cannot slip in between the check and the claim. The rule
    // itself is unit-tested in lib/__tests__/paneOpenAnswer.test.ts.
    const body = fn('performRealizeRestoredPane')
    const guard = body.indexOf("return 'session-open-elsewhere'")
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(body.indexOf('placeholder.restoring = true'))
    expect(body.slice(guard, body.indexOf('placeholder.restoring = true'))).not.toContain('await ')
  })

  it('marks the panes a cold restore has queued, until each one is done', () => {
    const body = fn('advanceRestoreSession')
    expect(body).toContain('for (const id of ids) scheduledRestoreIds.add(id)')
    expect(body).toContain('scheduledRestoreIds.delete(')
  })

  it('never repoints the saved conversation for a caller that requires it', () => {
    expect(fn('performRealizeRestoredPane')).toContain(
      'if (ghostConfirmed && supportsGhostReconnect(saved.agent) && !opts?.requireResume)')
  })

  it('takes the explicit decision instead of asking the workspace-wide question', () => {
    const body = fn('performRealizeRestoredPane')
    expect(body).toContain('opts?.explicit\n      ? explicitRestoreDecision(session)\n      : await restoreSessionDecision(session, batch, true)')
  })

  it('answers with an outcome on every exit', () => {
    const body = fn('performRealizeRestoredPane')
    expect(body).toContain('Promise<RealizeOutcome>')
    // A bare `return` would hand ui.pane.open undefined for a reason.
    expect(body).not.toMatch(/\breturn\n/)
    expect(body).toContain("return forceFresh ? 'fresh' : 'opened'")
  })

  it('with requireResume, leaves the pane closed rather than start a fresh session', () => {
    const body = fn('performRealizeRestoredPane')
    const refusal = body.indexOf("if (opts?.requireResume && !resumeCmd) return forceFresh ? 'fresh-refused' : 'resume-unavailable'")
    expect(refusal).toBeGreaterThan(-1)
    // Before the fresh-session toast and before anything is spawned.
    expect(refusal).toBeLessThan(body.indexOf("i18n.global.t('restore.session-not-found'"))
    expect(refusal).toBeLessThan(body.indexOf('await spawnRestoredPane('))
  })
})
