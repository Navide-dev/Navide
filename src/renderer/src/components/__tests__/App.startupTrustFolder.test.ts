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
  it('dismissStartupDialog asks before it presses Enter', () => {
    const fn = body('async function dismissStartupDialog')
    const asked = fn.indexOf('heldWorkspaceTrust(paneId)')
    expect(asked).toBeGreaterThan(-1)
    expect(asked).toBeLessThan(fn.indexOf("data: '\\r'"))
  })

  it('compares the dialog with the pane\'s workspace', () => {
    expect(body('function heldWorkspaceTrust')).toContain('workspace: pane.workspacePath')
    expect(body('function startupPromptDeps')).toContain('?.workspacePath')
  })

  it('role injection holds on a held dialog, on first sight and late', () => {
    const fn = body('function scheduleInjection')
    expect(fn.match(/waitHeldWorkspaceTrust\(pane, /g)).toHaveLength(2)
    const late = fn.indexOf('late startup dialog detected')
    expect(fn.indexOf('const lateHeld')).toBeGreaterThan(-1)
    expect(fn.indexOf('const lateHeld')).toBeLessThan(late)
  })
})
