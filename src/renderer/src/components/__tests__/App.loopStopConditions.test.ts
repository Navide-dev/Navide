// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The App.vue half of the loop's stop conditions (F1, F5, F6). The pure parts
// are covered in lib/__tests__/loopStopConditions.test.ts; App.vue cannot be
// mounted by this suite, so the wiring is asserted against the source the way
// the other App.*.test.ts files do.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function fnBody(signature: string): string {
  const start = appSource.indexOf(signature)
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

const LOCALES = ['en-US', 'ja-JP', 'zh-TW'].map((name) =>
  JSON.parse(
    readFileSync(
      resolve(process.cwd(), `packages/plugin-ui/src/foundation/i18n/locales/${name}.json`),
      'utf8'
    )
  ) as { pane: { terminal: Record<string, string> } }
)

describe('F5: the continue arms at injection start', () => {
  it('stamps the arm time before injecting and arms with it once the inject lands', () => {
    const body = fnBody('async function fireLoopContinue(')
    const stamp = body.indexOf('const armAt = Date.now()')
    const inject = body.indexOf('injectPane(')
    const arm = body.indexOf('armLoopTurn(paneId, armAt)')
    expect(stamp).toBeGreaterThan(-1)
    expect(stamp).toBeLessThan(inject)
    expect(arm).toBeGreaterThan(inject)
  })

  it('leaves the failure path un-armed, so the next poll retries as on main', () => {
    const body = fnBody('async function fireLoopContinue(')
    const fail = body.slice(body.indexOf('if (!ok) {'), body.indexOf('pane.loopTurnCount = (pane.loopTurnCount ?? 0) + 1'))
    expect(fail).not.toContain('armLoopTurn(')
  })

  it('keeps loop-start, skill-cast and resume arming at their own return', () => {
    const bare = /^ {2}armLoopTurn\(paneId\)$/m
    expect(fnBody('async function togglePaneLoop(')).toMatch(/^ {4}if \(pane\.loopActive\) armLoopTurn\(paneId\)$/m)
    expect(fnBody('async function togglePaneLoop(')).toMatch(bare)
    expect(fnBody('async function fireLoopResume(')).toMatch(bare)
  })

  it('armLoopTurn defaults to now', () => {
    expect(fnBody('function armLoopTurn(')).toContain('watcher.armedAt = at')
    expect(appSource).toContain('function armLoopTurn(paneId: string, at: number = Date.now()): void {')
  })
})

describe('F6: three failed continues in a row stop the loop', () => {
  it('counts failures, stops at the limit, and resets on success', () => {
    const body = fnBody('async function fireLoopContinue(')
    const fail = body.slice(body.indexOf('if (!ok) {'), body.indexOf('pane.loopTurnCount = (pane.loopTurnCount ?? 0) + 1'))
    expect(fail).toContain('watcher.injectFailures = loopInjectFailures(watcher.injectFailures, false)')
    expect(fail).toContain('if (watcher.injectFailures >= LOOP_INJECT_FAIL_LIMIT)')
    expect(fail).toContain("stopLoopSpinning(paneId, 'inject-failed')")
    const success = body.slice(body.indexOf('will retry next turn'))
    expect(success).toContain('watcher.injectFailures = loopInjectFailures(watcher.injectFailures, true)')
  })

  it('starts each loop with a clean count', () => {
    expect(fnBody('function startLoopLimitWatcher(')).toContain('injectFailures: 0,')
  })

  it('has a notification in every locale', () => {
    for (const locale of LOCALES) {
      expect(locale.pane.terminal['loop-inject-failed-notify-title']).toBeTruthy()
      expect(locale.pane.terminal['loop-inject-failed-notify-body']).toBeTruthy()
    }
  })
})

describe('F1: interrupting a pane stops its loop', () => {
  it('stops an active loop through the existing stop path, before the interrupt', () => {
    const body = fnBody('async function onInterrupt(')
    const stop = body.indexOf("if (panes.value.find((p) => p.id === paneId)?.loopActive) stopLoopSpinning(paneId, 'interrupted')")
    expect(stop).toBeGreaterThan(-1)
    expect(stop).toBeLessThan(body.indexOf('await ref.interrupt()'))
  })

  it('leaves the interrupt itself as on main', () => {
    const body = fnBody('async function onInterrupt(')
    expect(body).toContain('const issued = await ref.interrupt()')
    expect(body).toContain('persistPaneStopped(paneId, true)')
    expect(body).toContain('return issued !== false')
  })

  it('stopping clears loopActive and the watcher, so no later turn_complete can continue', () => {
    const body = fnBody('function stopLoopSpinning(')
    expect(body).toContain('pane.loopActive = false')
    expect(body).toContain('bumpLoopGen(paneId)')
    expect(body).toContain('stopLoopLimitWatcher(paneId)')
    // fireLoopContinue refuses once loopActive is false or the watcher is gone.
    expect(fnBody('async function fireLoopContinue(')).toContain(
      'if (!pane || !pane.loopActive || !watcher || watcher.continuing) return'
    )
  })

  it('has a notification in every locale', () => {
    for (const locale of LOCALES) {
      expect(locale.pane.terminal['loop-interrupted-notify-title']).toBeTruthy()
      expect(locale.pane.terminal['loop-interrupted-notify-body']).toBeTruthy()
    }
  })
})
