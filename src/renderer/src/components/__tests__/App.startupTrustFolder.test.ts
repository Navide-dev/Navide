import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend/terminal lifecycles, so — like the other
// App.*.test.ts files — these assert against the source text. The decision
// itself is lib/startupPrompts.ts (startupPrompts.test.ts); this pins that
// every path that presses Enter on a trust dialog asks it first.
const appSource = readFileSync(resolve(__dirname, '../../App.vue'), 'utf8')
const body = (name: string): string => {
  const start = appSource.indexOf(name)
  expect(start, name).toBeGreaterThan(-1)
  return appSource.slice(start, appSource.indexOf('\n}', start))
}

describe('startup trust dialog: Enter only for the pane\'s own workspace', () => {
  it('dismissStartupDialog presses nothing itself: only the shared answerer does', () => {
    const fn = body('async function dismissStartupDialog')
    expect(fn).toContain('answerWorkspaceTrust(paneId)')
    // A dialog it could not read as a trust dialog got a bare Enter (UI zoom
    // 125%, a narrow pane): "No, exit", or trusting another folder.
    expect(fn).not.toContain("'\\r'")
    expect(fn).not.toContain("'terminal.input'")
  })

  it('role injection\'s late-dialog path presses nothing itself either', () => {
    const fn = body('function scheduleInjection')
    const late = fn.slice(fn.indexOf('late startup dialog detected'), fn.indexOf('const injectRole'))
    expect(late).toContain('answerWorkspaceTrust(pane.id)')
    expect(late).not.toContain("'\\r'")
    expect(late).not.toContain("'terminal.input'")
  })

  it('reads enough of the screen for a dialog a narrow pane wraps to forty-odd rows', () => {
    expect(body('function startupPromptDeps')).toContain('readScreenTail?.(STARTUP_PROMPT_SCREEN_LINES)')
    expect(Number(/const STARTUP_PROMPT_SCREEN_LINES = (\d+)/.exec(appSource)?.[1])).toBeGreaterThanOrEqual(80)
  })

  it('answers a trust dialog through the shared answerer, which moves the cursor and waits for it to leave', () => {
    const fn = body('async function answerWorkspaceTrust')
    expect(fn).toContain('workspace: pane.workspacePath')
    expect(fn).toContain('answerStartupPrompt(pane.agentKey, prompt, decision.choose, deps)')
    // The late-dialog path of role injection uses it too, not a bare Enter.
    const late = body('function scheduleInjection')
    expect(late.indexOf('answerWorkspaceTrust(pane.id)')).toBeGreaterThan(late.indexOf('late startup dialog detected'))
  })

  it('compares the dialog with the pane\'s workspace', () => {
    expect(body('function heldWorkspaceTrust')).toContain('workspace: pane.workspacePath')
    expect(body('function startupPromptDeps')).toContain('?.workspacePath')
  })

  it('role injection holds on a held dialog, on first sight and late', () => {
    const fn = body('function scheduleInjection')
    // First sight, late, and a late answer that did not take.
    expect(fn.match(/waitHeldWorkspaceTrust\(pane, /g)).toHaveLength(3)
    const late = fn.indexOf('late startup dialog detected')
    expect(fn.indexOf('const lateHeld')).toBeGreaterThan(-1)
    expect(fn.indexOf('const lateHeld')).toBeLessThan(late)
  })
})
