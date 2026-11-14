// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// App.vue mounts backend/terminal/onboarding lifecycles, so it isn't practical
// to mount it here (same reasoning as App.interruptCommand.test.ts). These
// parse the source instead, guarding the wiring of ui.pane.reclaim — the MCP
// entry point to the status bar's "reclaim now". The guard itself is unit
// tested in lib/__tests__/idleReclaim.test.ts and the argument and reason
// helpers in lib/__tests__/paneReclaimRequest.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

describe('reclaimPanesNow', () => {
  const fn = block(
    'async function reclaimPanesNow(',
    '\n/** The reclaimable count per workspace',
  )

  it('keeps its existing callers on the same signature and guards', () => {
    expect(fn).toContain('async function reclaimPanesNow(paneIds?: string[], named = false, outcome?: ReclaimOutcome, source?: ReclaimRetroSource): Promise<number> {')
    expect(fn).toContain('namedReclaimBlockedBy(reclaimCandidate(pane), Date.now())')
    expect(fn).toContain('reclaimBlockedBy(reclaimCandidate(pane), RECLAIM_NOW_THRESHOLD_MS, Date.now())')
  })

  it('reports each refusal and each reclaim to a caller that asks', () => {
    expect(fn).toContain("outcome?.refused.push({ paneId, reason: 'not-found' })")
    expect(fn).toContain('outcome?.refused.push({ paneId, reason: blocked })')
    expect(fn).toContain('outcome?.reclaimed.push(paneId)')
  })

  it('says a pane gone after its kill went, not that it was never there', () => {
    // reclaimIdlePane answers false once onKill has run and the pane left the
    // list: the CLI is dead, so 'not-found' would tell the caller nothing happened.
    expect(fn).toContain("outcome?.refused.push({ paneId, reason: 'gone-after-kill' })")
    expect(fn).not.toMatch(/reclaimIdlePane\(paneId\)[^]*?reason: 'not-found'/)
  })

  it('keeps earlier results when one pane throws, for a caller collecting them', () => {
    expect(fn).toContain("outcome.refused.push({ paneId, reason: 'error', message: err instanceof Error ? err.message : String(err) })")
    // Callers that pass no outcome still see the throw, as before.
    expect(fn).toMatch(/if \(!outcome\) throw err/)
  })

  it('asks for a retrospective only with a source, and judges the pane again after it', () => {
    expect(fn).toContain('retroBeforeReclaim(backend, pane.workspacePath, paneId, source)')
    expect(fn).toContain('outcome?.refused.push({ paneId, reason: again })')
  })
})

describe('ui.pane.reclaim wiring', () => {
  const cmd = block(
    "registerCommand('ui.pane.reclaim', async (args) => {",
    '\nregisterCommand(',
  )

  it('demands a pane id and says where one comes from', () => {
    expect(cmd).toContain('reclaimRequestPaneIds(args)')
    expect(cmd).toContain('throw new Error(`ui.pane.reclaim requires ${PANE_ID_HINT}')
  })

  it('goes through the status bar path with its guards, focus included', () => {
    // `named` stays false: the focused-pane guard is part of what the status
    // bar refuses, and an agent naming a pane is not the user picking it.
    expect(cmd).toContain("await reclaimPanesNow(ids, false, outcome, 'agent')")
    expect(cmd).not.toContain('reclaimIdlePane(')
  })

  it('answers which panes went and why the others stayed', () => {
    expect(cmd).toContain('reclaimed: outcome.reclaimed')
    expect(cmd).toContain('reclaimRefusalReason(r.reason)')
    expect(cmd).toContain('r.message')
  })
})

describe('the reclaim retrospective (S5b) stays out of the reclaim itself', () => {
  it('leaves reclaimIdlePane as it was: no retrospective inside the kill path', () => {
    const fn = block('async function reclaimIdlePane(paneId: string): Promise<boolean> {', '\n}\n')
    expect(fn).not.toContain('retroBeforeReclaim')
    expect(fn).toContain('await onKill(paneId, { markRemoved: false, keepInList: true, force: false })')
  })

  it('asks only from the agent, idle-sweep and pipeline paths; a click never waits', () => {
    expect(appSource.match(/retroBeforeReclaim\(/g)).toHaveLength(3)
    expect(appSource).toContain("retroBeforeReclaim(backend, pane.workspacePath, paneId, 'idle-sweep')")
    expect(appSource).toContain("retroBeforeReclaim(backend, pane.workspacePath, paneId, 'pipeline')")
    const withSource = appSource.match(/reclaimPanesNow\([^)]*'agent'\)/g) ?? []
    expect(withSource).toEqual(["reclaimPanesNow(ids, false, outcome, 'agent')"])
  })
})
