// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Same approach as App.spawnAdvisories.test.ts: App.vue cannot be mounted
// here, so these tests parse the source text. Source text cannot show that a
// branch behaves — and it breaks on a rename while staying green over dead
// code — so it guards ONE thing only: that a step is routed to the module
// that owns it rather than re-decided here. Everything the kickoff actually
// decides now runs under test somewhere it can be driven:
//   - lib/__tests__/spawnKickoff.test.ts — runKickoffAttempts drives the whole
//     attempt loop (per-attempt evidence, the counter, the one-shot gate, the
//     composer guard, an abandoned pane), the per-attempt decision, and
//     reporting the verdict exactly once.
//   - lib/__tests__/injectEcho.test.ts — composerHoldsPayload, kickoffVerified,
//     echoEvidence, submitEvidence.
//   - platform/terminal/.../useTerminal.composerWindow.test.ts — the narrow
//     composer read those verdicts are computed from.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string, fromIndex = 0): string {
  const start = appSource.indexOf(startMarker, fromIndex)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

const kickoff = () => block('async function kickoffRequestedPane(', '\n/** Spawn + kick off a pane requested by a SPAWN block.')

describe('kickoffRequestedPane waits for the prompt, not for one quiet second', () => {
  it('no longer gates on waitForQuiet(1s/8s) — that let a booting TUI eat the task', () => {
    expect(kickoff()).not.toContain('waitForQuiet(paneId, 1000, 8000)')
    // The deadline is chosen per spawn now (a resumed CLI reloads its transcript
    // first and needs longer), but a fresh spawn still gets the 30s constant.
    expect(kickoff()).toContain('await waitForPromptReady(paneId, promptReadyTimeoutMs)')
    expect(kickoff()).toContain('? KICKOFF_PROMPT_READY_TIMEOUT_RESUME_MS')
    expect(kickoff()).toContain(': KICKOFF_PROMPT_READY_TIMEOUT_MS')
  })

  it('caps the prompt wait at 30s', () => {
    expect(appSource).toContain('const KICKOFF_PROMPT_READY_TIMEOUT_MS = 30_000')
  })

  it('prompt-ready means the status machine reads idle AND the clean buffer has settled', () => {
    const fn = block('async function waitForPromptReady(', '\nasync function waitForStartupActivity(')
    expect(fn).toContain("displayStatus")
    expect(fn).toContain("=== 'idle'")
    expect(fn).toContain('PROMPT_READY_QUIET_MS')
    expect(fn).toContain('paneCleanBytes(paneId)')
  })

  it('falls back to typing anyway on timeout, and says so in a diagnostic', () => {
    expect(kickoff()).toContain("code: 'spawn.prompt-ready-timeout'")
  })
})

describe('kickoffRequestedPane owns no decision of its own', () => {
  // The loop, the per-attempt verdict and the retype guard all moved to
  // runKickoffAttempts, which spawnKickoff.test.ts drives for real. All that is
  // left to pin is that no second copy of any of it stayed behind: a component
  // that re-decides is how the tested module and the shipped behaviour drift.
  it('delegates the attempt loop instead of running one', () => {
    const body = kickoff()
    expect(body).toContain('await runKickoffAttempts({')
    expect(body).not.toContain('for (let attempt')
    expect(body).not.toContain('injectionVerified(')
    expect(body).not.toContain('kickoffVerified(')
    expect(body).not.toContain('kickoffAttemptOutcome(')
  })

  it('bounds the attempts at 2', () => {
    expect(appSource).toContain('const KICKOFF_MAX_ATTEMPTS = 2')
    expect(kickoff()).toContain('maxAttempts: KICKOFF_MAX_ATTEMPTS')
  })

  it('settles the pane and the diagnostics on the outcome it was handed', () => {
    expect(kickoff()).toContain('settled.kickoffStatus = outcome')
    expect(kickoff()).toContain("code: 'spawn.kickoff-failed'")
    expect(kickoff()).toContain("code: 'spawn.kickoff-retry'")
  })
})

describe('the kickoff verdict reaches the waiting cli_open_agent call', () => {
  it('reports through createKickoffReporter, which is what makes it once', () => {
    // "Exactly once" is asserted in lib/__tests__/spawnKickoff.test.ts; this
    // only holds the component to that reporter instead of an inline send.
    expect(kickoff()).toContain('createKickoffReporter({')
    expect(kickoff()).toContain("backend.send('agent_spawn.kickoff', payload)")
  })

  it('builds the reporter BEFORE the pane lookup, and reports the missing pane', () => {
    // The lookup has its own early return. Built after it, a caller blocked on
    // the verdict waited out the full 45s deadline for a pane already gone.
    const body = kickoff()
    const reporter = body.indexOf('createKickoffReporter({')
    const lookup = body.indexOf('const pane = panes.value.find((p) => p.id === paneId)')
    expect(reporter).toBeGreaterThan(-1)
    expect(lookup).toBeGreaterThan(reporter)
    expect(body.slice(lookup, lookup + 260)).toContain("emitKickoffVerdict('failed'")
  })

  it('the MCP spawn path hands its request_id to the kickoff', () => {
    const handler = block('async function handleMcpSpawnRequest(ev: {', '\nfunction describeSpawnRefusal(')
    expect(handler).toContain('void kickoffRequestedPane(paneId, parentName, gate.task, ev.request_id, {')
  })

  // 'unverified', not 'sent': the standalone path has only injectPane's
  // boolean, which says true on buffer growth alone — the evidence the pane
  // path refuses to call sent. One word meaning two strengths depending on the
  // path is how a caller stops looking at a pane that never got its task.
  it('the standalone path reports its kickoff too — judged on its evidence, so the call never waits 45s', () => {
    const handler = block('async function handleMcpSpawnRequest(ev: {', '\nfunction describeSpawnRefusal(')
    const standaloneReport = handler.indexOf('report({ ok: true, paneId, name: childName, advisories: gate.advisories })')
    expect(standaloneReport).toBeGreaterThan(-1)
    const emit = handler.indexOf("backend.send('agent_spawn.kickoff'", standaloneReport)
    expect(emit).toBeGreaterThan(standaloneReport)
    const payload = handler.slice(emit, emit + 400)
    // Neither word hard-coded: a fixed 'unverified' reported every external
    // spawn as failed with the task running; a fixed 'sent' would hide a real miss.
    expect(payload).toContain('kickoff: verdict.kickoff')
    expect(payload).not.toContain("kickoff: 'unverified'")
    expect(payload).not.toContain("kickoff: 'sent'")
    expect(handler.slice(standaloneReport, emit)).toContain('standaloneKickoffVerdict(standaloneEvidence')
    expect(payload).toContain('reason:')
  })

  it('a kickoff that never reached a verdict (early return / throw) is reported failed, not left pending', () => {
    // The `finally` is the only code that runs on every exit; the verdict must
    // go out from there when nothing settled it.
    const fin = kickoff().slice(kickoff().lastIndexOf('} finally {'))
    expect(fin).toContain("emitKickoffVerdict('failed'")
  })
})

describe('deliverAgentMessage marks delivered-pending before the Enter, not after', () => {
  // An idle CLI writes the user record the moment it submits, and that record
  // can reach the agent.activity handler inside injectPane's 200ms submit
  // poll. A consume that lands before its mark is dropped (count already 0),
  // and the mark that follows then holds RUNNING for the whole 120s fuse.
  it('marks first, injects second, and asks deliveryHold before unmarking', () => {
    const fn = block('async function deliverAgentMessage(', '\n/** How long after the last keystroke')
    const mark = fn.indexOf('markDeliveredPending?.()')
    const inject = fn.indexOf('await injectPane(')
    expect(mark).toBeGreaterThan(-1)
    expect(inject).toBeGreaterThan(mark)
    const failure = fn.indexOf('if (!ok) {', inject)
    expect(failure).toBeGreaterThan(-1)
    // Whether it unmarks is failedInjectReleasesHold's call, tested for real in
    // lib/__tests__/deliveryHold.test.ts. This only pins that it is asked.
    const branch = fn.slice(failure, failure + 500)
    expect(branch).toContain('failedInjectReleasesHold(')
    expect(branch).toContain('clearDeliveredPending?.()')
  })
})
