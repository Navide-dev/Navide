// 0.2.39 Windows VM, `load 12`: with twelve processes holding every core, all
// three webhook-started pipeline runs failed with "kickoff never reached the
// agent after 3 attempts" — each attempt "not injected — echo none, submit
// none, 0 Enter(s)", about 10 s apart — while cli_open_agent kickoffs under
// the same load went out in about 11 s. cli_open_agent waits for the pane to
// read ready before it types; the pipeline typed into a CLI that could not
// read yet, three times in some 25 s, and gave up.
//
// Modelled here with a clock the test owns: one injection watches its echo
// for 7 s (echoTimeoutFor's round) and a retry waits 3 s. Until the starved
// CLI is up it echoes a paste some 15 s after it was typed — past the round,
// so the attempt fails and its Ctrl-U clears the box — and it reads ready
// (the prompt-ready gate opens) once it is up.
import { describe, expect, it, vi } from 'vitest'
import {
  KICKOFF_READY_WAIT_MS,
  KICKOFF_RETRY_BUDGET_MS,
  MAX_KICKOFF_ATTEMPTS,
  runPipelineKickoff,
} from '../../src/renderer/src/lib/cliCoordination'

const ECHO_ROUND_MS = 7_000
const ECHO_LAG_MS = 15_000

function starvedPane(readyAtMs: number) {
  let t = 0
  const typedAt: number[] = []
  const inject = vi.fn(async () => {
    typedAt.push(t)
    t += ECHO_ROUND_MS
    // Typed before the CLI was up: the echo lags past the round.
    const lag = typedAt[typedAt.length - 1] >= readyAtMs ? 0 : ECHO_LAG_MS
    return lag <= ECHO_ROUND_MS
      ? { injected: true, echo: 'tail' as const, submit: 'tail-left' as const }
      : { injected: false, echo: null }
  })
  const sleep = vi.fn(async (ms: number) => { t += ms })
  // waitForPromptReady: returns as soon as the pane reads ready, or at timeout.
  const awaitReady = vi.fn(async (timeoutMs: number) => {
    const until = Math.min(readyAtMs, t + timeoutMs)
    if (until > t) t = until
    return t >= readyAtMs
  })
  return { inject, sleep, awaitReady, now: () => t, typedAt }
}

describe('runPipelineKickoff on a host whose CLI echoes 15 s late while starved', () => {
  it('without pacing, three attempts in about 25 s all miss — the VM failure', async () => {
    const pane = starvedPane(25_000)
    const result = await runPipelineKickoff({ inject: pane.inject, sleep: pane.sleep, paneAlive: () => true })
    expect(result).toEqual({ sent: false, cancelled: false })
    expect(pane.typedAt).toEqual([0, 10_000, 20_000])
  })

  it('with the prompt-ready gate, waits for the CLI and types once', async () => {
    const pane = starvedPane(25_000)
    const result = await runPipelineKickoff({
      inject: pane.inject, sleep: pane.sleep, paneAlive: () => true,
      awaitReady: pane.awaitReady, now: pane.now,
    })
    expect(result).toEqual({ sent: true, cancelled: false })
    expect(pane.typedAt).toEqual([25_000])
  })

  it('keeps retrying past three attempts while the budget lasts, when the gate opens early', async () => {
    // The pane reads idle, but its echo lags until 40 s in.
    const pane = starvedPane(40_000)
    const result = await runPipelineKickoff({
      inject: pane.inject, sleep: pane.sleep, paneAlive: () => true,
      awaitReady: async () => true, now: pane.now,
    })
    expect(result).toEqual({ sent: true, cancelled: false })
    expect(pane.typedAt).toEqual([0, 10_000, 20_000, 30_000, 40_000])
  })

  it('gives up once the budget is spent', async () => {
    const pane = starvedPane(Number.POSITIVE_INFINITY)
    const result = await runPipelineKickoff({
      inject: pane.inject, sleep: pane.sleep, paneAlive: () => true,
      awaitReady: pane.awaitReady, now: pane.now,
    })
    expect(result).toEqual({ sent: false, cancelled: false })
    // The gate waits its full deadline before every attempt, so it is the
    // budget, not the attempt count, that ends it; the last attempt starts
    // inside the budget.
    expect(pane.typedAt.length).toBeGreaterThanOrEqual(MAX_KICKOFF_ATTEMPTS)
    expect(pane.typedAt[pane.typedAt.length - 1]).toBeLessThan(KICKOFF_RETRY_BUDGET_MS + KICKOFF_READY_WAIT_MS)
    expect(pane.awaitReady.mock.calls.every(([ms]) => ms <= KICKOFF_READY_WAIT_MS)).toBe(true)
  })

  it('types a ready pane at once: the gate costs the normal case nothing', async () => {
    const pane = starvedPane(0)
    const result = await runPipelineKickoff({
      inject: pane.inject, sleep: pane.sleep, paneAlive: () => true,
      awaitReady: pane.awaitReady, now: pane.now,
    })
    expect(result).toEqual({ sent: true, cancelled: false })
    expect(pane.typedAt).toEqual([0])
    expect(pane.sleep).not.toHaveBeenCalled()
  })

  it('does not type into a pane that closed while the gate waited', async () => {
    const pane = starvedPane(15_000)
    let alive = true
    const result = await runPipelineKickoff({
      inject: pane.inject, sleep: pane.sleep, paneAlive: () => alive,
      awaitReady: async () => { alive = false }, now: pane.now,
    })
    expect(result).toEqual({ sent: false, cancelled: true })
    expect(pane.inject).not.toHaveBeenCalled()
  })

  it('stops for a prompt that came up while the gate waited', async () => {
    const pane = starvedPane(15_000)
    let parked = false
    const result = await runPipelineKickoff({
      inject: pane.inject, sleep: pane.sleep, paneAlive: () => true,
      parkedOnPrompt: () => parked,
      awaitReady: async () => { parked = true }, now: pane.now,
    })
    expect(result).toEqual({ sent: false, cancelled: false, parked: true })
    expect(pane.inject).not.toHaveBeenCalled()
  })
})
