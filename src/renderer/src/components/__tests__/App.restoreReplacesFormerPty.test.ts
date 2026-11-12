// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend/terminal lifecycles, so — like the other
// App.*.test.ts files — this asserts against the source text.
//
// Reload Window restores every pane under a NEW pane id. A codex pane that
// had no session yet (or a terminal pane) restores fresh with no resumeKey,
// so its PTY id was only findable under the former pane id. spawnPane has to
// hand that id to the terminal so terminal.create reaps the old CLI;
// useTerminal.replacesFormerPty.test.ts covers the terminal side.

const appSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/App.vue'),
  'utf8'
)

describe('a restored pane replaces the PTY of the pane id it replaces', () => {
  it('spawnRestoredPane passes the saved pane id as a former id', () => {
    const start = appSource.indexOf('async function spawnRestoredPane')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('formerPaneIds: [saved.pane_id]')
  })

  it('spawnPane hands the former pane id to the terminal as its replaces key', () => {
    const start = appSource.indexOf('async function spawnPane(')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('replacesKey: opts.formerPaneIds?.[0]')
  })
})
