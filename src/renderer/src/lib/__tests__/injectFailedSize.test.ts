// @vitest-environment happy-dom
// #448 diagnostics: an inject.failed entry records the pane's terminal size
// at that moment (cols x rows), so a report can be checked against the width
// fix that shipped beside it. Counts only — nothing about injecting changes.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { injectFailedMessage } from '../uiDiagnostics'

const root = process.cwd()
const appSource = readFileSync(resolve(root, 'src/renderer/src/App.vue'), 'utf8')
const paneSource = readFileSync(resolve(root, 'src/renderer/src/components/TerminalPane.vue'), 'utf8')
const terminalSource = readFileSync(resolve(root, 'src/renderer/src/platform/terminal/composables/useTerminal.ts'), 'utf8')

describe('inject.failed carries the terminal size', () => {
  it('words the size, or says it is unknown', () => {
    expect(injectFailedMessage({ cols: 120, rows: 40 })).toBe('content never appeared in the input box (terminal 120x40)')
    expect(injectFailedMessage(null)).toBe('content never appeared in the input box (terminal size unknown)')
  })

  it('injectText records the failing pane size through the pane it injected into', () => {
    const at = appSource.indexOf("code: 'inject.failed'")
    expect(at).toBeGreaterThan(-1)
    const entry = appSource.slice(at, appSource.indexOf('})', at))
    expect(entry).toContain('injectFailedMessage(')
    expect(entry).toContain('terminalSize?.()')
  })

  it('the pane publishes its xterm size', () => {
    expect(paneSource).toContain('terminalSize: terminal.terminalSize')
    expect(terminalSource).toMatch(/function terminalSize\(\): \{ cols: number; rows: number \}/)
  })
})
