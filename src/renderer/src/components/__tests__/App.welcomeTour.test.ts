// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend/terminal/settings lifecycles, so — like the other
// App.*.test.ts files — these assert against the source text. The decisions
// behind the wiring are unit-tested in lib/__tests__/welcomeTour.test.ts,
// composables/__tests__/useWelcomeTour.test.ts and
// components/__tests__/CoachMark.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionBody(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  return appSource.slice(start, appSource.indexOf('\n}', start))
}

describe('first-run welcome tour', () => {
  it('is marked pending only when the wizard was shown for a first run, not a rerun from Settings', () => {
    expect(functionBody('reopenOnboarding')).toContain('onboardingRerun = true')
    const complete = functionBody('completeOnboarding')
    expect(complete).toMatch(/if \(!onboardingRerun\) welcomeTour\.markFirstRun\(\)/)
    expect(complete).toContain('onboardingRerun = false')
  })

  it('is never marked from the status check, so an upgraded install never sees it', () => {
    expect(functionBody('checkOnboarding')).not.toContain('markFirstRun')
    expect(functionBody('evaluateWhatsNew')).not.toContain('welcomeTour')
  })

  it('lets nextWelcomeTourMove decide, from onboarding, the screen and the first-install answer', () => {
    const poll = functionBody('pollWelcomeTour')
    expect(poll).toContain('nextWelcomeTourMove({')
    expect(poll).toContain('const settled = onboardingComplete.value === true && !onboardingCheckFailed.value')
    expect(poll).toContain('eligible: welcomeTour.eligible()')
    // M14: only the window that owns the tour runs it.
    // L3: a tour that is not pending claims nothing, so a launch after the
    // tour is over never writes the owner record.
    expect(poll).toContain('const pending = welcomeTour.pending()')
    expect(poll).toContain('pending,')
    expect(poll).toContain('owned: pending && settled && welcomeTour.claim()')
    expect(poll).toMatch(/case 'release':\s+welcomeTour\.release\(\)/)
    expect(poll).toMatch(/case 'stop':\s+welcomeTour\.release\(\)\s+stopWelcomeTourPoll\(\)/)
    expect(poll).toContain('decision: welcomeTourDecision')
    // M4: an overlay that popped up by itself (a CLI question, the job editor) holds it too.
    expect(poll).toContain('blocked: mainModalOpen() || !!cliHealthGuide.value || tourBlocked.value')
    expect(poll).toMatch(/case 'check':\s+void checkWelcomeTourRecords\(\)/)
    expect(poll).toMatch(/case 'cancel':\s+welcomeTour\.cancel\(\)/)
    expect(poll).toMatch(/case 'mark-eligible':\s+welcomeTour\.markEligible\(\)/)
    expect(poll).toMatch(/case 'start':\s+welcomeTour\.start\(\)/)
  })

  it('judges "first install" by the window as the check began, retrying a failed answer', () => {
    const check = functionBody('checkWelcomeTourRecords')
    // The snapshot is taken before the (slow at launch) request goes out.
    expect(check.indexOf('workspaceOpenAtStart: workspaceSelected.value')).toBeLessThan(check.indexOf('fetchRecents'))
    expect(check).toContain('decideFirstInstall({')
    expect(check).toContain("backend.send<{ recent?: { last_opened_at?: string }[] }>('workspace.list_recent', {})")
    expect(check).toContain('warn: (message) => console.warn(message)')
    // L2: a check that gave up is not asked again this session, and writes nothing.
    expect(check).toContain("welcomeTourDecision = decision === 'unchecked' ? 'gave-up' : decision")
  })

  it('routes Help → First-Run Tour… to the replay', () => {
    expect(functionBody('onMenuAction')).toMatch(/action === 'show-welcome-tour'\) \{\s+replayWelcomeTour\(\)/)
    expect(functionBody('replayWelcomeTour')).toContain('welcomeTour.replay()')
  })

  // The replay is asked for, so it always gets the screen: whatever would make
  // it step aside — Settings, a What's New note — closes first.
  it('clears Settings and a What\u2019s New note before a replay, so it can always start', () => {
    const replay = functionBody('replayWelcomeTour')
    expect(replay).toContain('showSettings.value = false')
    expect(replay).toMatch(/if \(whatsNewEntry\.value\) closeWhatsNew\(\)/)
    expect(replay.indexOf('closeWhatsNew()')).toBeLessThan(replay.indexOf('welcomeTour.replay()'))
  })

  // M14/M15: no saved step — every start begins at the first bubble and passes
  // over what is done, so two windows have no progress to overwrite.
  it('mounts the coach marks with the steps, the facts and when to step aside, always from the first bubble', () => {
    expect(appSource).not.toContain('savedStep')
    expect(appSource).toMatch(
      /<CoachMark\s+v-if="welcomeTourActive"\s+:key="welcomeTourActive"\s+:steps="WELCOME_STEPS"\s+:facts="welcomeFacts"\s+:replay="welcomeTourActive === 'replay'"\s+:suspended="welcomeTourSuspended"\s+@finish="onWelcomeTourFinish"/,
    )
    const start = appSource.indexOf('const welcomeTourSuspended = computed(')
    expect(start).toBeGreaterThan(-1)
    expect(appSource.slice(start, start + 200)).toMatch(/mainModalOpen\(\) \|\| !!cliHealthGuide\.value \|\| tourBlocked\.value/)
  })

  it('reads a finished turn, not a keystroke, as a first instruction already given', () => {
    // Answering a CLI's trust prompt is a keystroke too.
    expect(functionBody('welcomeFacts')).toContain('paneTurnCompleteAt.get(id)')
  })

  it('tells the tour about an @ pick and a pane drop where they already happen', () => {
    expect(functionBody('rememberMentionPick')).toContain("welcomeTour.notify('mention')")
    expect(functionBody('injectPaneContextSources')).toContain("welcomeTour.notify('drop')")
    const badge = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/UsageBadge.vue'), 'utf8')
    expect(badge).toContain("useWelcomeTour().notify('usage')")
  })

  it('says the tour is done, and where to see it again, only when it was walked to the end', () => {
    const finish = functionBody('onWelcomeTourFinish')
    expect(finish).toContain('welcomeTour.finish(completed)')
    expect(finish).toMatch(/if \(completed\) notifyRestore\.toast\(i18n\.global\.t\('tour\.welcome\.finished'\)/)
  })

  // The first-run tour no longer rides the card engine: GuidedTour is the
  // release tour's alone again.
  it('leaves GuidedTour mounted for release tours only', () => {
    expect(appSource).toMatch(
      /<GuidedTour\s+v-if="activeTourSteps"\s+:steps="activeTourSteps"\s+:run-prepare="runTourPrepare"\s+@close="endTour"\s*\/>/,
    )
  })
})
