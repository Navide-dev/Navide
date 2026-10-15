import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// App.vue is not mounted in tests; this checks the source wiring of the
// stuck-pane poll (the verdict itself is unit-tested in lib/paneStuck).
const app = readFileSync(join(__dirname, '..', '..', 'App.vue'), 'utf8')

describe('App.vue — stuck panes are flagged and recorded', () => {
  const start = app.indexOf('function pollStuckPanes(): void {')
  const body = app.slice(start, app.indexOf('\n}\n', start))

  it('runs on the one-second pump, contained per pane', () => {
    expect(start).toBeGreaterThan(-1)
    expect(app).toMatch(/pollAwaitingPanes\(\)\n\s*pollStuckPanes\(\)\n\s*syncPaneBusy\(\)/)
    expect(body).toContain('try {')
  })

  it('records a warn diagnostic once per stuck episode and clears when it moves again', () => {
    expect(body).toMatch(/if \(since != null && pane\.stuckSince == null\)/)
    expect(body).toMatch(/recordDiagnostic\(\{\s*level: 'warn',\s*code: 'pane\.stuck'/)
    expect(body).toContain('pane.stuckSince = null')
  })

  it('passes the state to the pane title bar', () => {
    expect(app).toContain(':stuck-since="p.stuckSince ?? null"')
  })
})
