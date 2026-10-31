// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The App.vue half of the continue-after-restore affordance: who lights the
// flag, who puts it out, and what the button actually sends. A restored CLI has
// its transcript back but is parked at the prompt — the restore path injects
// nothing on purpose — so this is the one supported way to hand the work back
// to it. App.vue cannot be mounted by this suite, so the wiring is asserted
// against the source the way the other App.*.test.ts files do; the visibility
// rules that CAN be executed live in TerminalPane.continueButton.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function fn(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('continueRestoredPane — the manual nudge', () => {
  it('passes the same typing gate as every other unsolicited injection', () => {
    // Half a typed line is lost just as easily to this button as to a delivered
    // message, so it cannot bypass the hold.
    const body = fn('continueRestoredPane')
    expect(body).toContain('messagingHoldKey(paneId) !== null')
  })

  it('takes the global injection slot around the write', () => {
    const body = fn('continueRestoredPane')
    expect(body).toContain('await acquireInjectionSlot()')
    expect(body).toContain('releaseInjectionSlot()')
  })

  it('sends the resume text the user configured, not a hardcoded string', () => {
    const body = fn('continueRestoredPane')
    expect(body).toContain('settingsGet(LOOP_RESUME_SETTING_KEY, DEFAULT_LOOP_RESUME)')
  })

  it('does not attach the loop done-marker instruction', () => {
    // This is a one-shot nudge with no watcher behind it. Asking the CLI to
    // emit <<LOOP_DONE>> would promise a loop that nobody is running.
    const body = fn('continueRestoredPane')
    expect(body).not.toContain('withLoopDoneInstruction')
  })

  it('refuses to run twice for the same pane while a write is in flight', () => {
    const body = fn('continueRestoredPane')
    expect(body).toContain('continueInFlight.has(paneId)')
    expect(body).toContain('continueInFlight.add(paneId)')
    expect(body).toContain('continueInFlight.delete(paneId)')
  })

  it('does nothing when the pane is not in the parked-after-resume state', () => {
    const body = fn('continueRestoredPane')
    expect(body).toContain('if (!pane?.resumeContinueAvailable) return')
  })

  it('brings the button back when the injection fails', () => {
    // injectPane clears the flag up front, so a failure has to restore it or the
    // only affordance for a stuck pane disappears on a dropped write.
    const body = fn('continueRestoredPane')
    expect(body).toMatch(/if \(!ok\) \{[\s\S]*pane\.resumeContinueAvailable = true/)
  })
})

describe('the flag lifecycle', () => {
  it('is lit only for a pane that came back with --resume', () => {
    const body = fn('performRealizeRestoredPane')
    expect(body).toMatch(/if \(isResume\) \{[\s\S]*resumeContinueAvailable = true/)
  })

  it('is lit for a pane the backend outage rebuilt behind the user', () => {
    // Same interruption, different cause: the PTY died mid-work and the pane was
    // resumed without anyone asking, so it too comes back parked.
    const body = fn('flushPtyLostResumes')
    expect(body).toContain('offerContinue: true')
  })

  it('is not offered for a rebuild the user asked for', () => {
    // ⌘R, the rebuild button, the account-switch batch and the post-install
    // relaunch are all deliberate actions; none of them needs a second one.
    // The three that DO offer it are rebuilds nobody asked for: the backend
    // outage (flushPtyLostResumes), the quota-failover switch that stopped
    // the pane at a turn boundary (quotaRestartPane) — that switch sends no
    // prompt or continue of its own, so the button is its only continuation —
    // and the API key takeover (reopenOnKey), which stops panes the same way.
    const calls = (appSource.match(/rebuildPaneViaResume\([^)]*\{[^}]*\}/gs) ?? []).filter(
      (c) => !c.includes('paneId: string') // drop the declaration itself
    )
    expect(calls.length).toBeGreaterThan(2)
    expect(calls.filter((c) => c.includes('offerContinue'))).toHaveLength(3)
    expect(fn('flushPtyLostResumes')).toContain('offerContinue: true')
    expect(fn('quotaRestartPane')).toContain('offerContinue: true')
  })

  it('is put out by any injection reaching the prompt', () => {
    const body = fn('injectPane')
    expect(body).toContain('pane.resumeContinueAvailable = false')
  })

  it('is put out when the agent starts working on its own', () => {
    // A pane that woke up is no longer parked where the restore left it, even
    // if the button was never clicked.
    // The whole agent_active branch of the activity handler, not a fixed
    // prefix of it: the branch grew a turn-start stamp ahead of this line.
    const start = appSource.indexOf("ev.event_type === 'agent_active'")
    const activeBranch = appSource.slice(start, appSource.indexOf('\n  }\n', start))
    expect(activeBranch).toContain('resumeContinueAvailable = false')
  })

  it('is runtime-only — the backend pane record never learns about it', () => {
    // Persisting it would resurrect the button on every cold start, including
    // for panes the user had already answered.
    const record = readFileSync(
      resolve(process.cwd(), 'backend/agent_team_backend/projects.py'),
      'utf8'
    )
    expect(record).not.toContain('resume_continue')
    expect(record).not.toContain('resumeContinue')
  })

  it('is documented on ActivePane as not persisted', () => {
    const decl = appSource.indexOf('resumeContinueAvailable?: boolean')
    expect(decl).toBeGreaterThan(-1)
    const doc = appSource.slice(Math.max(0, decl - 500), decl)
    expect(doc).toContain('Not persisted')
  })
})

describe('the pane wiring', () => {
  it('passes the flag down and handles the click', () => {
    expect(appSource).toContain(':continue-available="p.resumeContinueAvailable"')
    expect(appSource).toContain('@continue-resume="continueRestoredPane(p.id)"')
  })

  it('has button text and a tooltip in both shipped locales', () => {
    for (const locale of ['en-US', 'zh-TW']) {
      const json = JSON.parse(
        readFileSync(resolve(process.cwd(), `packages/plugin-ui/src/foundation/i18n/locales/${locale}.json`), 'utf8')
      ) as { pane: { terminal: Record<string, string> } }
      expect(json.pane.terminal['continue']).toBeTruthy()
      expect(json.pane.terminal['continue-tooltip']).toBeTruthy()
    }
  })
})
