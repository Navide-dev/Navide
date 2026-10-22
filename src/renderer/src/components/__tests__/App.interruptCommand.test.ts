// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// App.vue mounts backend/terminal/onboarding lifecycles, so it isn't practical
// to mount it here (same reasoning as App.spawnAdvisories.test.ts). These parse
// the source instead, guarding the wiring of ui.pane.interrupt — the MCP entry
// point for "stop what you are doing" that sits between cli_send and
// ui.pane.close. The advisory text itself is unit tested directly in
// lib/__tests__/paneInterruptAdvisories.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

describe('onInterrupt', () => {
  const fn = block(
    'async function onInterrupt(paneId: string, opts: { keepLoop?: boolean } = {}): Promise<boolean> {',
    '\nasync function onKillAll(',
  )

  it('still no-ops for a placeholder and for a pane with no live session', () => {
    // The two guards the UI button has always had. Removing either would make
    // ui.pane.interrupt write to something that is not there.
    expect(fn).toContain("if (!panes.value.find((p) => p.id === paneId)?.realized) return false")
    expect(fn).toContain('if (!ref?.sessionId) return false')
  })

  it('reports whether the interrupt was issued, taking the answer from the terminal', () => {
    // "nothing was sent" and "it was sent and the agent kept going" are
    // different answers, and an MCP caller cannot tell them apart otherwise.
    // The flag must come from useTerminal's own answer rather than being
    // assumed from "the promise resolved": interrupt() also drops the request
    // when the window's socket is down, which resolves exactly like a send.
    expect(fn).toContain('const issued = await ref.interrupt()')
    expect(fn).toContain('return issued !== false')
    expect(fn).not.toMatch(/await ref\.interrupt\(\)\s*\n\s*persistPaneStopped[^]*?return true/)
    // A refused or throwing request is not a send either — the old
    // `catch { /* ignore */ }` would have reported success for a PTY that threw.
    expect(fn).toMatch(/catch \{\s*return false\s*\}/)
  })

  it('still marks the pane stopped, exactly as the UI button did', () => {
    expect(fn).toContain('persistPaneStopped(paneId, true)')
  })
})

describe('ui.pane.interrupt wiring', () => {
  const cmd = block(
    "registerCommand('ui.pane.interrupt', async (args) => {",
    "\nregisterCommand('ui.messaging.readIncoming'",
  )

  it('demands a pane id and says where one comes from', () => {
    expect(cmd).toContain('if (!paneId) throw new Error(`ui.pane.interrupt requires ${PANE_ID_HINT}`)')
  })

  it('refuses a pane it cannot find rather than silently doing nothing', () => {
    expect(cmd).toContain('if (!pane) throw new Error(`ui.pane.interrupt: pane "${paneId}" not found`)')
  })

  it('reads the pane state BEFORE the interrupt, not after', () => {
    // The interrupt changes the very status being reported. Reading it
    // afterwards answers a different question than the caller asked, and the
    // answer would always look like "it was already idle".
    const statusIdx = cmd.indexOf('const status = paneDisplayStatus(pane)')
    const awaitingIdx = cmd.indexOf('const awaitingKind =')
    const interruptIdx = cmd.indexOf('const sent = await onInterrupt(paneId)')
    expect(statusIdx).toBeGreaterThan(-1)
    expect(awaitingIdx).toBeGreaterThan(-1)
    expect(interruptIdx).toBeGreaterThan(-1)
    expect(statusIdx).toBeLessThan(interruptIdx)
    expect(awaitingIdx).toBeLessThan(interruptIdx)
  })

  it('takes `sent` from onInterrupt itself rather than re-deriving its guards', () => {
    // A second copy of "is this pane realized and does it have a session"
    // would drift away from the one that decides whether to write.
    expect(cmd).toContain('const sent = await onInterrupt(paneId)')
    expect(cmd).not.toContain('realized')
    expect(cmd).not.toContain('sessionId')
  })

  it('does not gate — it interrupts and then reports what it landed on', () => {
    // Same stance as ui.pane.close: refusing would leave a caller no way to
    // clear a stuck input box, so the answer is a record, not a refusal.
    expect(cmd).not.toContain('throw new Error(`ui.pane.interrupt: pane "${paneId}" is idle')
    expect(cmd).toContain('const advisories = interruptAdvisoriesFor({')
  })

  it('always answers with sent and status, and adds advisories only when there are any', () => {
    // `sent`/`status` are the whole point of the reply; an always-present
    // empty advisories array would train the caller to stop reading the key.
    expect(cmd).toContain('return advisories.length ? { sent, status, advisories } : { sent, status }')
  })

  it('imports the advisory helper from the shared pure module', () => {
    expect(appSource).toContain(
      "import { interruptAdvisoriesFor } from './lib/paneInterruptAdvisories'",
    )
  })
})
