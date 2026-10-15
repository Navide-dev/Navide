import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// App.vue is not mounted in tests; like App.cliMissingFallback.test.ts this
// checks the terminal.exit handler's source for the exit-fault wiring.
const app = readFileSync(join(__dirname, '..', '..', 'App.vue'), 'utf8')

function block(start: string, end: string): string {
  const from = app.indexOf(start)
  const to = app.indexOf(end, from)
  expect(from).toBeGreaterThan(-1)
  expect(to).toBeGreaterThan(from)
  return app.slice(from, to)
}

describe('App.vue terminal.exit — non-zero exits are flagged and recorded', () => {
  const handler = block("backend.on('terminal.exit', (raw) => {", "backend.on('terminal.input_blocked'")

  it('keeps the exit fault on the pane and records it as an error diagnostic', () => {
    expect(handler).toContain('pane.exitFault = paneExitFault(ev.exit_code, pane.agentKey, ev.startup_probe?.reason)')
    expect(handler).toMatch(/recordDiagnostic\(\{\s*level: 'error',\s*code: 'pane\.exit'/)
  })

  it('passes the code to the pane title bar', () => {
    expect(app).toContain(':exit-code="p.exitFault?.code ?? null"')
  })
})
