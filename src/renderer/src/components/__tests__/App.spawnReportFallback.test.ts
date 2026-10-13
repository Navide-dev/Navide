// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// cli_open_agent tells its caller the new pane will report back when it is
// done. Nothing enforced that: the report is the child agent's own output, so a
// missed marker made it vanish and left the parent waiting on something that
// would never arrive — no queue row, no failure, no symptom. settleSpawnReport
// turns that silence into a labelled stand-in report.
//
// It lives in App.vue, which the suite cannot mount, so it is asserted against
// the source the way the other App.*.test.ts files do. The part that CAN be
// executed — renderFallbackReport — is unit-tested in
// lib/__tests__/agentMessaging.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function fn(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('arming the report debt', () => {
  it('is armed by a kickoff that actually landed', () => {
    // A kickoff that never went in leaves a pane with nothing to report on.
    const body = fn('kickoffRequestedPane')
    expect(body).toContain('spawnReportPending = true')
    expect(body).toContain('if (kicked &&')
  })

  it('is armed only when the parent is a real messaging handle', () => {
    // The MCP path falls back to a pane id and a standalone caller passes a
    // workspace path; neither can be delivered to.
    const body = fn('kickoffRequestedPane')
    expect(body).toContain('panes.value.some((p) => p.messagingName === parentName)')
  })

  it('records the parent by handle, not only by pane id', () => {
    // spawnedBy is a pane id; a message needs the handle.
    const body = fn('kickoffRequestedPane')
    expect(body).toContain('spawnedByName = parentName')
  })

  it('persists both fields, so a pane resumed after a relaunch still reports', () => {
    // Reversed 2026-10-07: the owed report used to be runtime-only, which left
    // a parent waiting forever on a child interrupted by a relaunch.
    const decl = appSource.slice(appSource.indexOf('  spawnedByName?: string') - 600)
    expect(decl.slice(0, 600)).toContain('PaneRecord.report_to / report_pending')
  })
})

describe('settleSpawnReport', () => {
  it('fires at most once per pane', () => {
    // A child that keeps working must not turn into a stream of reports.
    const body = fn('settleSpawnReport')
    const clear = body.indexOf('pane.spawnReportPending = false')
    expect(clear).toBeGreaterThan(-1)
    // Cleared before any early return that follows, so every outcome settles.
    expect(clear).toBeLessThan(body.indexOf('renderFallbackReport'))
  })

  it('stands down when the pane reported itself', () => {
    const body = fn('settleSpawnReport')
    expect(body).toContain('m.target === parentName')
  })

  it('counts a broadcast as a report, since it reaches the parent too', () => {
    const body = fn('settleSpawnReport')
    expect(body).toContain('isBroadcastTarget(m.target)')
  })

  it('sends nothing when the parent is gone', () => {
    const body = fn('settleSpawnReport')
    expect(body).toContain('!panes.value.some((p) => p.messagingName === parentName)')
  })

  it('sends nothing when the turn carried nothing to forward', () => {
    const body = fn('settleSpawnReport')
    expect(body).toContain('if (!report) return')
  })

  it('sends under the fallback kind, from the child, to the parent', () => {
    const body = fn('settleSpawnReport')
    expect(body).toContain("messaging.sendMessage(senderName, parentName, report, { kind: 'fallback' })")
  })

  it('runs after the pane\'s own messages have been dispatched', () => {
    // Otherwise a report written correctly in the same turn would not be seen.
    const turn = fn('onTurnCompleteForMessaging')
    expect(turn.indexOf('settleSpawnReport(paneId, senderName, text, parsed)')).toBeGreaterThan(
      turn.indexOf('messaging.sendMessage(senderName, msg.target'),
    )
  })
})

describe('the fallback kind is carried end to end', () => {
  it('is an accepted kind in the frontend message type', () => {
    const composable = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/composables/useAgentMessaging.ts'),
      'utf8',
    )
    expect(composable).toContain("kind?: 'notice' | 'fallback'")
  })

  it('survives a round trip through the persisted log', () => {
    // _coerce_kind stores anything unrecognized as NULL, and hydrateLog drops
    // it again — a kind missing from either list is silently downgraded to an
    // ordinary message rather than failing loudly.
    const composable = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/composables/useAgentMessaging.ts'),
      'utf8',
    )
    expect(composable).toContain("row.kind === 'notice' || row.kind === 'fallback'")
    const backend = readFileSync(
      resolve(process.cwd(), 'backend/agent_team_backend/agent_message_log.py'),
      'utf8',
    )
    expect(backend).toContain('_KINDS = ("notice", "fallback", "ack")')
  })

  it('is not treated as a Navide notice, because it has a real sender', () => {
    // Notices are injected verbatim and cannot be resent; a fallback report is
    // an ordinary message in every respect but its label. Every behavioural
    // notice branch must therefore still test for 'notice' alone — hydration,
    // which decides which stored labels survive at all, is the one place both
    // are named together.
    const composable = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/composables/useAgentMessaging.ts'),
      'utf8',
    )
    const branches = composable
      .split('\n')
      .filter((l) => l.includes("kind === 'fallback'"))
      .map((l) => l.trim())
    expect(branches).toEqual([
      "if (row.kind === 'notice' || row.kind === 'fallback' || row.kind === 'ack') m.kind = row.kind",
    ])
  })
})
