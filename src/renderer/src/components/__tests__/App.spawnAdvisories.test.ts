// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// App.vue mounts backend/terminal/onboarding lifecycles (see
// App.paneCycle.test.ts / App.logPreview.test.ts), so it isn't practical to
// mount it here. These tests parse the source text instead, guarding the
// wiring for two spawn-gate gaps: ui.pane.create bypassing the gate entirely,
// and cli_open_agent's advisories never reaching the MCP caller. The gate's
// own logic (spawnAdvisoriesFor, evaluateTurnSpawns accumulation) is unit
// tested directly in lib/__tests__/agentSpawnGate.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string, fromIndex = 0): string {
  const start = appSource.indexOf(startMarker, fromIndex)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

describe('ui.pane.create spawn-gate wiring', () => {
  const cmd = block("registerCommand('ui.pane.create', async (args) => {", "\nregisterCommand('ui.pane.close'")

  it('checks the standalone gate context before spawning', () => {
    expect(cmd).toContain('const gateCtx = standaloneSpawnGateContext()')
  })

  it('rejects a taken name with the gate\'s own wording, before spawnPane runs', () => {
    const nameCheckIdx = cmd.indexOf('gateCtx.isNameTaken(name)')
    const spawnIdx = cmd.indexOf('await spawnPane({')
    expect(nameCheckIdx).toBeGreaterThan(-1)
    expect(spawnIdx).toBeGreaterThan(-1)
    expect(nameCheckIdx).toBeLessThan(spawnIdx)
    expect(cmd).toContain('已被其他 pane 使用，請換一個名稱')
  })

  it('does not require name — the collision check only runs when one was given', () => {
    expect(cmd).toContain('if (a.name) {\n    const name = normalizeMessagingName(a.name)')
  })

  it('records advisories via the shared pure function after a successful spawn', () => {
    expect(cmd).toContain('for (const advisory of spawnAdvisoriesFor(gateCtx)) {')
    expect(cmd).toContain(
      "recordDiagnostic({ level: 'warn', code: 'spawn.advisory', message: advisory, paneId })"
    )
    // Must run after the pane exists (paneId assigned) so the diagnostic can
    // reference it, and before the command returns so useUiActionBus's
    // takeDiagnosticsSince window (opened before invokeCommand) still covers it.
    const paneIdIdx = cmd.indexOf('if (!paneId) throw new Error(`ui.pane.create failed to spawn')
    const advisoryIdx = cmd.indexOf('for (const advisory of spawnAdvisoriesFor(gateCtx))')
    expect(paneIdIdx).toBeGreaterThan(-1)
    expect(advisoryIdx).toBeGreaterThan(paneIdIdx)
  })

  it('imports spawnAdvisoriesFor alongside the rest of the gate', () => {
    const importBlock = block("import {\n  evaluateTurnSpawns,", "} from './lib/agentSpawnGate'")
    expect(importBlock).toContain('spawnAdvisoriesFor')
  })
})

describe('workspace CLI pane advisory counts running panes only', () => {
  // The advisory says each pane costs 250–500MB of memory. A cold-restore
  // placeholder (realized: false) has no process behind it, so counting it
  // made every spawn warn about hundreds of panes that were not running.
  const contexts = [
    block('function standaloneSpawnGateContext() {', '\n}\n'),
    block('function spawnGateContextFor(parentPaneId: string) {', '\n}\n'),
  ]

  it('skips cold-restore placeholders in both gate contexts', () => {
    for (const ctx of contexts) {
      expect(ctx).toContain(
        "cliPaneCount: panes.value.filter((p) => p.realized && p.agentKey !== 'terminal').length,"
      )
    }
  })
})

describe('cli_open_agent advisories forwarding (agent_spawn.result)', () => {
  const handler = block(
    'async function handleMcpSpawnRequest(ev: {',
    '\nfunction describeSpawnRefusal('
  )

  it('report() carries an optional advisories list', () => {
    expect(handler).toContain('advisories?: string[]')
  })

  it('only attaches the advisories key to the outgoing payload when non-empty', () => {
    expect(handler).toContain(
      'if (verdict.advisories && verdict.advisories.length > 0) payload.advisories = verdict.advisories'
    )
  })

  it('passes gate.advisories through on both success paths (standalone and parented)', () => {
    const matches = [...handler.matchAll(/report\(\{ ok: true, paneId, name: childName(, advisories: gate\.advisories)?/g)]
    expect(matches.length).toBe(2)
    for (const m of matches) {
      expect(m[1]).toBe(', advisories: gate.advisories')
    }
  })
})

describe('spawn feedback is a system notice, not a message', () => {
  const fn = block('function sendSpawnFeedback(', '\nasync function handleSpawnRequestsForTurn(')

  it('sends under the reserved handle, as a notice, with no envelope', () => {
    expect(fn).toContain('messaging.sendMessage(NOTICE_SENDER, parentName, renderSpawnNotice(outcome, detail)')
    expect(fn).toContain("kind: 'notice'")
    // An envelope would announce `from: Navide` and ask for a reply to a handle
    // nothing can address; the notice text is injected verbatim instead.
    expect(fn).not.toContain('includeReplyHint')
    expect(fn).not.toContain('renderEnvelope')
  })

  it('every caller classifies the outcome, so the two prefixes stay accurate', () => {
    const calls = [...appSource.matchAll(/sendSpawnFeedback\(\s*parentName,\s*'(failed|partial)'/g)]
    expect(calls.length).toBe(6)
    // A pane that exists but never got its task must not be reported as a
    // failed spawn — retrying that one collides with the open pane.
    expect(calls.filter((c) => c[1] === 'partial').length).toBe(4)
  })

  it('tells the bare-line SPAWN path apart the same way the MCP path does', () => {
    // Both paths run the same two steps — create the pane, then inject its task
    // — so both have the same two ways to fail, and the requester acts on which
    // one it was: `failed` invites the same request again, `partial` says the
    // pane is already open and a retry would collide with it.
    const turn = block('async function handleSpawnRequestsForTurn(', '\n/** Create the pane')
    expect(turn).toContain("if (spawned.outcome === 'failed')")
    expect(turn).toContain("} else if (spawned.outcome === 'partial')")

    const spawn = block('async function spawnRequestedPane(', '\n/** The spawn-gate context')
    // Nothing was created → failed. Created but not kicked off → partial.
    expect(spawn).toContain("return { outcome: 'failed', name: req.name }")
    expect(spawn).toContain("return { outcome: kicked ? 'ok' : 'partial', name: childName }")
  })

  it('reports a kickoff that threw as partial too, not as silence', () => {
    // kickoffRequestedPane awaits a long chain (bootstrap, dialog dismissal,
    // quiet wait, injection) behind a `finally` with no catch of its own. A
    // rejection escaping is the one outcome that tells the requester nothing,
    // and the pane is open either way — the same verdict the MCP path reaches
    // through its own .catch.
    const spawn = block('async function spawnRequestedPane(', '\n/** The spawn-gate context')
    expect(spawn).toContain('} catch (err) {')
    expect(spawn).toContain("outcome: 'partial'")
    expect(spawn).toContain('error: err instanceof Error ? err.message : String(err)')

    const turn = block('async function handleSpawnRequestsForTurn(', '\n/** Create the pane')
    expect(turn).toContain("} else if (spawned.outcome === 'partial' && spawned.error) {")
    expect(turn).toContain('任務注入出錯：${spawned.error}')
  })

  it('never leaves a spawn turn rejecting into the window', () => {
    // Every outcome inside handleSpawnRequestsForTurn is reported as a notice,
    // so a bare `void` on the call would turn any throw into both silence and
    // an unhandled rejection.
    expect(appSource).toContain('void handleSpawnRequestsForTurn(paneId, senderName, text).catch(')
    expect(appSource).toContain("code: 'spawn.turn-failed'")
  })

  it('names the pane that actually exists, not the name that was asked for', () => {
    // A concurrent spawn may have taken the requested name and pushed this one
    // to a suffix; "check pane X" has to name the pane the requester can find.
    const spawn = block('async function spawnRequestedPane(', '\n/** The spawn-gate context')
    expect(spawn).toContain('const childName = pane?.messagingName ?? req.name')
    const turn = block('async function handleSpawnRequestsForTurn(', '\n/** Create the pane')
    expect(turn).toContain('pane「${spawned.name}」已開啟')
  })
})
